// src/tools/reward.mjs
/**
 * `orch_reward` — 사람 손 정정(설계 §7.4). `src/tools.mjs` 에서 WS2 Task 16 이 떼어냈다
 * (그 파일을 <=1,459 로 되돌리는 분리 — `contract/module-budget.json` othersRule 이 새
 * 핸들러의 자리로 `src/tools/*.mjs` 를 이미 지정해 두었다). 공유 배선(`toEngineDeps`·
 * `inspectJournalArtifacts`)은 `src/tools/context.mjs` 에서 온다 — `tools.mjs` 를 다시
 * 부르면 순환이 생긴다.
 */
import { REASON } from '../reason-codes.mjs';
import { renderNotice } from '../reason-text.mjs';
import { failure, success } from '../envelope.mjs';
import { errorText } from '../util/errors.mjs';
import { confidenceOfReward } from '../confidence.mjs';
import { resolveStateRoot } from '../state-root.mjs';
import { AXES, POLICY_V2_AXES, gradeToDeltas } from '../learn/bandit.mjs';
import { findRunUnlocked } from '../learn/journal.mjs';
import { cellKeyOf, commitLearningMutationUnlocked, readPosteriorsUnlocked } from '../learn/posteriors.mjs';
import { generationOf, readGenerationsUnlocked, withLearningLock } from '../learn/learning.mjs';
import { MAX_INSPECTED_ARTIFACT_REFS, inspectJournalArtifacts, toEngineDeps } from './context.mjs';
import { stateSchemaReason } from '../state-schema.mjs';

const ZERO_DELTA = Object.freeze({ alphaDelta: 0, betaDelta: 0 });

const sameAxes = (a, b) => Array.isArray(a) && a.length === b.length && a.every((axis, i) => axis === b[i]);

/** Two complete choice maps hold the same arms for the same axes. */
const sameChoices = (a, b) => {
  const left = Object.entries(a ?? {});
  const right = Object.entries(b ?? {});
  return left.length === right.length && left.every(([axis, arm]) => b[axis] === arm);
};

/**
 * `axis → arm` 을 읽는다. **하나라도 이상하면 `null`** — 부분 수용이 없다.
 *
 * ★ 왜 모르는 축·팔에서 실패하는가: v1 은 모르는 축을 notice 로 건너뛰지만, 그쪽은
 *   `decisions` 라는 넓은 기록에서 골라 쓰는 경로다. v2 의 map 은 엔진이 **이 Run 이
 *   실제로 돌린 것만** 적은 좁은 기록이라, 거기 낯선 이름이 있으면 그 줄 자체를 믿을 수
 *   없다. 절반만 정정하면 되돌릴 수 없는 반쪽 상태가 남는다.
 */
function normalizeChoiceMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const map = new Map();
  for (const [axis, arm] of Object.entries(value)) {
    if (!POLICY_V2_AXES.includes(axis)) return null;
    if (typeof arm !== 'string' || !AXES[axis].arms.includes(arm)) return null;
    map.set(axis, arm);
  }
  return map;
}

const sameAxisSet = (axes, map) => !Array.isArray(axes) ||
  axes.length === map.size && axes.every((axis) => map.has(axis));

/**
 * 정책 v2 줄을 정정 권위로 읽는다. 실패는 `null` 이고 호출자가 실패 봉투를 낸다.
 *
 * 검사하는 것: 두 map 이 모두 온전한가, `appliedChoices ⊆ rewardableChoices` 이고 팔이
 * 같은가, `appliedGrade` 와 `appliedChoices` 가 서로를 부정하지 않는가, 파생 배열
 * (`appliedAxes`/`rewardableAxes`)이 있다면 map 의 축과 같은가.
 */
function readPolicyV2Authority(run) {
  const applied = normalizeChoiceMap(run.appliedChoices);
  const rewardable = normalizeChoiceMap(run.rewardableChoices);
  if (applied === null || rewardable === null) return null;
  for (const [axis, arm] of applied) if (rewardable.get(axis) !== arm) return null;
  const appliedGrade = run.appliedGrade ?? null;
  if ((appliedGrade === null) !== (applied.size === 0)) return null;
  if (!sameAxisSet(run.appliedAxes, applied) || !sameAxisSet(run.rewardableAxes, rewardable)) return null;
  return { applied, rewardable };
}

async function runOrchRewardUnlocked(value, stateRoot, captured = { artifactRefs: null }, wired = {}) {
  const now = wired.now;
  const readPosteriorState = typeof wired.readPosteriorsUnlocked === 'function'
    ? wired.readPosteriorsUnlocked
    : readPosteriorsUnlocked;
  // ★ M2 테스트 이음매 — 재읽기 **불일치**는 디스크가 거짓말한 경우라 실물로 재현할 수 없다
  //   (이 콜백은 `learning.lock` 을 쥔 채 쓰고 바로 읽는다). `orch_config` 의 `deps.writeSettings`
  //   와 같은 논거다. 초기 조회에도 같은 함수를 쓴다 — 갈라 두면 스텁이 두 그림을 따로
  //   맞춰야 해서 실제로 못 재현하는 조합이 생긴다.
  const findRun = typeof wired.findRunUnlocked === 'function' ? wired.findRunUnlocked : findRunUnlocked;
  // `findRun` 은 같은 coordinator 를 다시 잡으므로 여기서는 unlocked helper 만 쓴다.
  const run = await findRun(stateRoot, value.run_id);

  if (run === null) {
    return failure({ status: 'invalid', reasonCode: REASON.learning_run_not_found, params: { runId: String(value.run_id) } });
  }
  if (typeof run.taskClass !== 'string' || run.taskClass === '') {
    return failure({
      status: 'failed',
      reasonCode: REASON.learning_run_task_class_missing,
      params: { runId: String(value.run_id) },
    });
  }

  // ★★ 정책 버전이 **정정 권위를 정한다.** v2 줄은 동결된 choice map 만 읽고 `decisions`
  //   는 절대 읽지 않는다 — 다중 후보에서 `decisions[axis]` 는 밴딧이 뽑았지만 아무 lane 도
  //   돌리지 않은 팔일 수 있고, 그것을 보상하면 실행하지 않은 선택을 배운다(설계 §14.3).
  //   그래서 map 이 망가지면 **v1 으로 내려가지 않고** 실패한다. 폴백은 조용한 오귀속이다.
  const policyVersion = run.policyVersion ?? 1;
  if (policyVersion !== 1 && policyVersion !== 2) {
    return failure({
      status: 'failed',
      reasonCode: REASON.learning_policy_version_unknown,
      params: { version: errorText(policyVersion) },
    });
  }
  if (Array.isArray(run.artifactRefs)) captured.artifactRefs = run.artifactRefs;
  const v2 = policyVersion === 2 ? readPolicyV2Authority(run) : null;
  if (policyVersion === 2 && v2 === null) {
    return failure({ status: 'failed', reasonCode: REASON.learning_choice_map_invalid });
  }

  // A reward is an explicit shared-state write.  Refuse it before computing a
  // replacement row when the whole posterior file belongs to a future schema.
  const posteriorState = await readPosteriorState(stateRoot);
  const schemaReason = stateSchemaReason(posteriorState?.stateSchema);
  if (schemaReason !== null) return failure({ status: 'blocked', ...schemaReason });

  const generations = await readGenerationsUnlocked(stateRoot);
  if (!generations.ok) {
    return failure({
      status: 'failed',
      reasonCode: REASON.learning_generations_read_failed,
      params: { detail: generations.error },
    });
  }
  const hasExpiredAxis = (axes, recordedGenerations) => axes.some((axis) => {
    if (typeof axis !== 'string' || axis === '') return false;
    const recorded = Number.isInteger(recordedGenerations?.[axis]) ? recordedGenerations[axis] : 0;
    return generationOf(generations.generations, cellKeyOf(run.taskClass, axis)) !== recorded;
  });
  // `appliedAxes` and `rewardableAxes` describe independent contracts.  A
  // null-applied run intentionally has no applied generation, but its current
  // rewardable generation still makes a later manual grade safe.  Missing maps
  // remain legacy generation 0 rather than borrowing the other contract's map.
  const isExpired =
    (run.appliedGrade !== null && run.appliedGrade !== undefined &&
      Array.isArray(run.appliedAxes) && hasExpiredAxis(run.appliedAxes, run.appliedGenerations)) ||
    (Array.isArray(run.rewardableAxes) && hasExpiredAxis(run.rewardableAxes, run.rewardableGenerations));
  if (isExpired) {
    return failure({ status: 'invalid', reasonCode: REASON.learning_generation_expired });
  }

  const nextGrade = value.good === true ? 'success' : 'failure';
  const redoDeltas = gradeToDeltas(nextGrade);
  const appliedGrade = run.appliedGrade ?? null;
  const undoDeltas = gradeToDeltas(appliedGrade);

  if (appliedGrade !== null && undoDeltas === null) {
    return failure({
      status: 'failed',
      reasonCode: REASON.learning_applied_grade_unknown,
      params: { grade: errorText(appliedGrade) },
    });
  }
  // ★ `?? []` 로 읽지 마라. 옛 줄은 `appliedGrade:'success'` 인데 `appliedAxes` 가 없다 —
  //   `[]` 로 읽으면 되돌릴 축이 0개가 되어 그 α 가 **영원히** 남고 새 등급이 그 위에 얹힌다.
  if (v2 === null && undoDeltas !== null && !Array.isArray(run.appliedAxes)) {
    return failure({ status: 'failed', reasonCode: REASON.learning_applied_axes_missing });
  }

  const notes = [];
  const holding = [];
  const updates = [];
  if (v2 !== null) {
    // 되돌릴 곳은 `appliedChoices`, 새로 적을 곳은 `rewardableChoices` — 둘 다 팔까지
    // 동결돼 있으므로 이 자리에서 팔을 추측할 일이 없다. 축 순서는 `POLICY_V2_AXES` 다.
    for (const axis of POLICY_V2_AXES) {
      const arm = v2.rewardable.get(axis) ?? v2.applied.get(axis);
      if (arm === undefined) continue;
      const back = undoDeltas !== null && v2.applied.has(axis) ? undoDeltas : ZERO_DELTA;
      const inRedo = v2.rewardable.has(axis);
      const forward = inRedo ? redoDeltas : ZERO_DELTA;
      const alphaDelta = forward.alphaDelta - back.alphaDelta;
      const betaDelta = forward.betaDelta - back.betaDelta;
      if (alphaDelta !== 0 || betaDelta !== 0) {
        updates.push({ cellKey: cellKeyOf(run.taskClass, axis), arm, alphaDelta, betaDelta });
      }
      if (inRedo) holding.push(axis);
    }
  } else {
    const undoAxes = undoDeltas === null ? [] : run.appliedAxes;
    let redoAxes;
    if (Array.isArray(run.rewardableAxes)) {
      redoAxes = run.rewardableAxes;
    } else if (undoDeltas !== null) {
      redoAxes = undoAxes;
      notes.push(renderNotice('reward_axes_missing_legacy_applied'));
    } else {
      redoAxes = [];
      notes.push(renderNotice('reward_axes_missing_no_cell'));
    }

    // ★ 모르는 축은 **조용히** 버리지 않는다. 형제 경로(팔이 없는 축)가 문장을 남기는데
    //   여기만 침묵하면 `rewardableAxes:['oldaxis']` 같은 줄이 `axes:[]` · notice 없음으로
    //   나가서, 사용자는 정정이 됐다고 믿는다 — 이 도구의 논거가 「조용한 무연산을 없앤다」다.
    const named = [...new Set([...undoAxes, ...redoAxes])];
    const axes = named.filter((axis) => Object.hasOwn(AXES, axis));
    const unknown = named.filter((axis) => !Object.hasOwn(AXES, axis));
    if (unknown.length > 0) {
      // ★ 축 이름은 저널 줄에서 온 값이라 `String()` 이 아니라 사다리를 지난다(`errorText` 머리말).
      notes.push(renderNotice('reward_unknown_axes_skipped', { detail: unknown.map((axis) => errorText(axis)).join(', ') }));
    }

    for (const axis of axes) {
      const decisions = run.decisions !== null && typeof run.decisions === 'object' ? run.decisions : {};
      const arm = Object.hasOwn(decisions, axis) ? decisions[axis] : null;
      if (typeof arm !== 'string' || arm === '') {
        notes.push(renderNotice('reward_axis_arm_missing', { axis }));
        continue;
      }
      const back = undoAxes.includes(axis) ? undoDeltas ?? ZERO_DELTA : ZERO_DELTA;
      const inRedo = redoAxes.includes(axis);
      const forward = inRedo ? redoDeltas : ZERO_DELTA;
      const alphaDelta = forward.alphaDelta - back.alphaDelta;
      const betaDelta = forward.betaDelta - back.betaDelta;

      if (alphaDelta !== 0 || betaDelta !== 0) {
        updates.push({ cellKey: cellKeyOf(run.taskClass, axis), arm, alphaDelta, betaDelta });
      }
      if (inRedo) holding.push(axis);
    }
  }

  // ★★ **한 번의 쓰기다.** 축마다 따로 쓰면 세 축을 고치고 네 번째에서 죽는 반쪽 상태가
  //    남는데, 저널의 스칼라 `appliedGrade` 로는 그것을 적을 수가 없어 다음 정정이 이중
  //    계산한다. 실패하면 **저널을 건드리지 않고** 실패 봉투로 나간다 — 아무것도 안 움직인
  //    상태라 같은 호출을 다시 하면 정확히 같은 결과가 난다(멱등 회복).
  const wrote = updates.length > 0;
  const nextApplied = holding.length > 0 ? nextGrade : null;
  const note = typeof value.note === 'string' ? value.note : null;
  // ★ `note` 를 안 주면 이전 note 가 **지워진다**(줄 전체를 새로 쓰기 때문이다). 그것이
  //   틀린 동작은 아니지만 — 안 준 것은 "비워라" 로 읽는 편이 예측 가능하다 — 조용하면 안 된다.
  if (note === null && typeof run.note === 'string' && run.note !== '') {
    notes.push(renderNotice('reward_note_cleared', { note: run.note }));
  }
  // v2 는 축 목록이 아니라 **완전한 choice map** 을 비교한다. 같은 축이라도 팔이 달라지면
  // 그것은 다른 정정이므로 무연산이 아니다.
  const nextAppliedChoices = v2 === null
    ? null
    : Object.fromEntries(holding.map((axis) => [axis, v2.rewardable.get(axis)]));
  // ★ 바뀔 것이 없으면 줄을 얹지 않는다 — 그것이 멱등이다. 사후분포도 저널도 그대로여야 한다.
  const unchanged =
    !wrote &&
    appliedGrade === nextApplied &&
    sameAxes(run.appliedAxes, holding) &&
    (v2 === null || sameChoices(run.appliedChoices, nextAppliedChoices)) &&
    (run.rewardApplied ?? null) === 'user' &&
    (run.note ?? null) === note;

  let readBack = true; // 바꿀 것이 없으면 방금 읽은 줄이 곧 목표다 — 그 비교가 §2.2 의 「재읽기 일치」다.
  if (!unchanged) {
    // The pending WAL holds this complete posterior target and this complete
    // replacement row before either is touched.  Never call a public storage
    // writer here: this callback already owns learning.lock.
    const committed = await commitLearningMutationUnlocked(stateRoot, {
      updates,
      journal: {
      ...run,
      appliedGrade: nextApplied,
      appliedAxes: holding,
      ...(v2 === null ? {} : { appliedChoices: nextAppliedChoices }),
      rewardApplied: 'user',
      note,
      },
    }, { now });
    if (committed.ok !== true) {
      const committedSchemaReason = stateSchemaReason(committed.stateSchema);
      if (committedSchemaReason !== null) return failure({ status: 'blocked', ...committedSchemaReason });
      return failure({
        status: 'failed',
        reasonCode: REASON.learning_mutation_failed,
        params: { detail: committed.error },
      });
    }
    if (Array.isArray(committed.notes) && committed.notes.length > 0) notes.push(committed.notes.join(' / '));
    // 커밋이 ok 라는 말은 WAL 이 끝났다는 뜻이지 저널 줄이 그 값으로 보인다는 뜻이 아니다.
    // 이 콜백은 learning.lock 을 쥐고 있으므로 지금 다시 읽은 것이 곧 그 확인이다.
    //
    // ★ M2 — 이 정정이 **쓴 다섯 필드**(위 `journal:` 객체) 전부를 본다. 예전에는 셋만
    //   봤다(appliedGrade·rewardApplied·note) — appliedAxes·appliedChoices 가 쓴 값과 갈려도
    //   "재읽기 일치" 로 나갔다. `sameAxes`·`sameChoices` 는 `unchanged` 가 이미 쓰는 같은
    //   깊은 비교다(배열·객체 리터럴 등호 비교를 여기서 새로 발명하지 않는다).
    const stored = await findRun(stateRoot, run.runId);
    const journalMatches =
      stored?.appliedGrade === nextApplied &&
      (stored?.rewardApplied ?? null) === 'user' &&
      (stored?.note ?? null) === note &&
      sameAxes(stored?.appliedAxes, holding) &&
      (v2 === null || sameChoices(stored?.appliedChoices, nextAppliedChoices));
    // ★ posterior 재읽기 — `readPosteriorsUnlocked` 는 `orch_stats` 가 쓰는 그 함수다(셀
    //   하나만 읽는 더 싼 함수는 이 모듈에 없다). 값이 델타(±diff)라 클램프(하한)가 걸리면
    //   "이전값+delta" 와 실제 값이 달라질 수 있어 정확한 수치 재현은 하지 않는다 — 대신
    //   방금 쓴 (cellKey, arm) 이 디스크에 유한수로 실제로 남아 있는지만 본다. 이것은
    //   posterior 의 **존재·판독 재확인**이지 산술 재검증이 아니다(JSDoc 그대로 — 여기서
    //   "posterior 재읽기" 라는 말은 이 범위로만 쓴다).
    const posteriorsMatch = updates.length === 0 || await (async () => {
      const reread = await readPosteriorState(stateRoot);
      if (!reread.ok) return false;
      return updates.every(({ cellKey, arm }) => {
        const cell = reread.cells[cellKey]?.[arm];
        return Number.isFinite(cell?.alpha) && Number.isFinite(cell?.beta);
      });
    })();
    readBack = journalMatches && posteriorsMatch;
  }

  return success({
    content: JSON.stringify({
      runId: run.runId,
      previousGrade: appliedGrade,
      grade: nextApplied,
      axes: holding,
      changed: !unchanged,
    }),
    confidence: confidenceOfReward({ readBackMatches: readBack }),
    notice: notes.length > 0 ? notes.join(' / ') : undefined,
  });
}

/**
 * `orch_reward` 핸들러. 멱등·교체(설계 §7.4).
 *
 * ★★ **되돌리기와 새로 적기는 서로 다른 질문에 답한다.**
 *   · 되돌릴 곳 = `appliedAxes` — 지금 사후분포에 **실제로 들어 있는** 기여.
 *   · 새로 적을 곳 = `rewardableAxes` — 이 실행에 등급을 준다면 갈 곳(엔진의 `axesFor`).
 *   둘을 하나로 뭉개면 두 방향으로 다 틀린다: `appliedAxes` 로만 적으면 **자동 채점이
 *   기권한 실행**(테스트 판정을 못 믿었다 · blocked · 빈 패치)은 정정할 곳이 0개가 되어
 *   사람 손 정정이 조용한 무연산이 되고, `Object.keys(AXES)` 로 적으면 이 실행에서
 *   **무연산이었던 축**(벤더 하나 · 역할 지정 · `test-definition-changed`)에까지 보상이
 *   얹혀 `learnable`·`axesFor` 가 막으려던 거짓 귀속이 사용자 정정 문으로 되돌아온다.
 *
 * ★★ 되돌리기와 적용을 축마다 **순 델타 하나**로 합치고, 그 델타들을 **한 번의
 *   완전 목표를 담은 **학습 WAL 작업 하나**(coordinator 하나 · posterior/journal 목표
 *   쓰기)로 낸다. 두 층 다 이유가 같다 — 중간에서 죽어도 다음 읽기/작업이 같은 목표를
 *   정확히 재생해야 저널의 스칼라 `appliedGrade` 와 사후분포가 어긋나지 않는다.
 *   `posteriors.json` 과 저널은 함께 의도된 목표로 수렴하며, operationId 가 저널 행의
 *   중복 추가를 막는다.
 *   성분별 하한은 순 델타든 두 번 호출이든 같은 값을 낸다(`bump` 이 성분마다 따로 막는다).
 *
 * ★ **쓰기 중 실패하면 pending WAL을 남긴다.** 이후 읽기/작업은 같은 목표를 재생해
 *   posterior와 저널을 정확히 한 번 수렴시킨다. 이번 호출은 `failed` 봉투이지만, 실행
 *   결과 자체를 막지는 않는다.
 *
 * ★ 던지지 않는다. 실패는 봉투다.
 */
export async function runOrchReward(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();

  // The corrected row's artifact refs travel out of the coordinator so the
  // filesystem probe below runs with the lock released.
  const captured = { artifactRefs: null };
  // `wired.now` 는 저널 정정 줄의 `updatedAt` 을 찍는 시계다 — 주지 않으면 진짜 시계다.
  // `wired.findRunUnlocked`·`wired.readPosteriorsUnlocked` 는 M2 재읽기 테스트 이음매다 —
  // 아래 함수 안 주석에 이유가 있다.
  const locked = await withLearningLock(stateRoot, async () => runOrchRewardUnlocked(value, stateRoot, captured, wired));
  if (!locked.ok) {
    const schemaReason = stateSchemaReason(locked.stateSchema);
    if (schemaReason !== null) return failure({ status: 'blocked', ...schemaReason });
    return failure({ status: 'failed', reasonCode: REASON.learning_lock_unavailable, params: { detail: locked.error } });
  }
  const envelope = locked.value;
  if (envelope.status !== 'succeeded' || captured.artifactRefs === null) return envelope;
  const inspected = await inspectJournalArtifacts(stateRoot, captured.artifactRefs, wired.artifactInspectionDeps);
  const notices = [];
  if (typeof envelope.notice === 'string' && envelope.notice !== '') notices.push(envelope.notice);
  if (inspected.failed) notices.push(renderNotice('reward_artifact_state_unchecked'));
  if (inspected.omitted > 0) {
    notices.push(renderNotice('reward_artifact_refs_omitted', {
      count: inspected.omitted,
      limit: MAX_INSPECTED_ARTIFACT_REFS,
    }));
  }
  let body;
  try {
    body = JSON.parse(envelope.content);
  } catch {
    return envelope;
  }
  body.artifacts = inspected.artifacts;
  // ★ confidence 를 다시 고르지 않는다 — 정정을 실제로 한 것은 안쪽이고, 여기는 artifact
  //   상태만 덧붙인다. 다시 고르면 안쪽이 강등한 값이 이 자리에서 조용히 올라간다.
  return success({ content: JSON.stringify(body), confidence: envelope.confidence, notice: notices.length > 0 ? notices.join(' / ') : undefined });
}
