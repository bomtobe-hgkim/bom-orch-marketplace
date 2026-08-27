/**
 * 실행 하나가 **어떻게 끝나는가** — 종료 경로. 레인 수와 무관하게 **하나**다.
 *
 * WS3 태스크 9·10(스펙 §0-M2)이 `src/engine.mjs` 의 `orchestrateFinalC1`(261줄)과
 * `orchestrateFinalC2`(592줄)를 이 파일로 옮겼고, 이 커밋이 그 둘을 접었다. 남은 것은 내보내는
 * 함수 **하나**(`finalizeRun`)이고 엔진의 호출부도 **하나**다 — 후보 1개/2개는 더 이상 두 함수가
 * 아니라 `preparation.candidateCount` 가 만드는 `laneIds` 배열의 길이다.
 *
 * ★ 접기의 규칙: 두 원본이 **같은 바이트**를 내던 자리는 한 벌만 남고, 갈리던 자리는 **데이터**가
 *   된다(레인 수 · 레인별 수집물 · 선택의 유무). 데이터로 갈리는 자리마다 WHY 가 두 원본 행동을
 *   이름으로 적는다 — 어느 쪽도 조용히 사라지지 않았다는 것이 이 파일에서 읽혀야 한다.
 *
 * ★ 접지 **않은** 것 셋과 그 이유. 봉투 바이트를 바꾸지 않고서는 접을 수 없다고 판정한 자리다:
 *   (1) **poison 원장과 `checkpoint` 래퍼** — C1 은 「아무 poison 이나」로 다음 체크포인트를
 *       막고 C2 는 「권위 상실만」으로 막는다. 레인 단계가 그 원장을 통째로 읽으므로
 *       (`artifactAuthority.isStoreAuthorityLost`) 접으면 레인 안의 결과가 바뀐다.
 *   (2) **레인 실행과 레인별 산출물 실패 처리** — C1 은 자기 레인이 막히면 실행을 끝내고,
 *       C2 는 다른 레인이 이길 수 있으므로 계속한다. 같은 사건에 다른 봉투를 내는 것이 맞다.
 *   (3) **정리(cleanup)** — 자식 프로세스를 죽이는 범위(전체 vs 워크트리별), 보존 조건,
 *       단계 라벨, `unregistered` 의 「모른다」(`null`) 통과, 정리 체크포인트가 poison 을
 *       거치는지가 전부 다르다. `buildRunBody` 가 그 `null` 을 지키라고 자기 자리에 적어 두었다.
 *   셋은 레인 수로 갈리는 **블록**으로 남았고, 그 뒤의 조립(학습 커밋 → 정리 → 본문 → 종료 봉투)은
 *   한 경로다. 조립이 한 번만 존재한다는 것은 `test/guards/finalization-single-path.test.mjs` 가 잰다.
 *
 * ★ 왜 준비·레인 단계는 같이 오지 않았나. `prepareRunNamespace`(770줄)와 `runPreparedLane`(598줄)
 *   은 어느 한쪽 전용이 아니라 두 레인 수가 모두 부르는 엔진의 단계다. 그래서 옮기지도 복제하지도
 *   않고 `context.finalizationSeam` 으로 **받는다** — 복제하면 두 벌이 갈리고, 여기서 수입하면
 *   순환이다. `PREPARATION_PRIVATE` 도 같은 자리로 받는데 이유가 하나 더 있다: 그것은 값이 아니라
 *   **동일성**이다. 준비 단계가 채운 바로 그 WeakMap 이어야 `.get(preparation)` 이 무언가를
 *   돌려준다 — 같은 모양의 새 WeakMap 은 언제나 `undefined` 를 낸다.
 *   ★ 그 뒤 문장을 최종 리뷰(M9)가 정정했다: 예전에는 「그러면 이 경로는 실패하는 대신 **조용히
 *   빈 결정으로** 끝난다」고 적었는데, 실측은 그 반대다 — 이 파일은 그 값을 폴백 없이 구조분해
 *   하므로(`const { taskClass, decisions, … } = PREPARATION_PRIVATE.get(preparation)`) `undefined`
 *   는 그 자리에서 `TypeError` 를 던지고, `orchestrateQuality` 의 최상위 catch 가 그것을 정착된
 *   `run_orchestration_failed` 봉투로 만든다. **시끄럽다.** 그리고 그 방향이 옳다: 조용한 것은
 *   `?? {}` 를 얹었을 때 생기는 결과이고, 이 문장이 있던 자리는 다음 사람에게 바로 그 `?? {}` 를
 *   권하고 있었다. 이음매는 구조로 안전하고, 틀린 WeakMap 은 봉투 하나로 끝난다.
 *
 * ★ 반대로 `UNKNOWN_VALUE`·`isBlocked`·`pathContains` 는 **복사**했다. 셋 다 순수하고 한두 줄이라
 *   이음매로 나르면 이음매가 상수·조각 배달부가 된다(같은 상수를 `src/providers/error-catalog.mjs:30`
 *   이 이미 자기 몫으로 들고 있다 — 이 저장소가 이 크기에 대해 이미 내린 판단이다).
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지). 방향은 engine → run-finalization
 *   하나뿐이고, 위의 세 이름이 인자로 오는 이유가 그것이다.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  UNPROVEN_REMOVAL,
  acceptArtifactRevision,
  classifyArtifactSettlement,
  snapshotRemovalResult,
  unknownArtifactSettlement,
} from './artifact-settlement.mjs';
import {
  buildJudgeView as createJudgeView,
  makeBlindPair,
  parseJudgeDecision,
  remapJudgeDecision,
  selectCandidates,
  selectSingleCandidate,
} from './candidate-selection.mjs';
import { confidenceOfRun } from './confidence.mjs';
import { renderContentParts } from './content-projection.mjs';
import { judgeInstruction } from './prompts/instructions.mjs';
import { trackWorktree as defaultTrackWorktree } from './reaper.mjs';
import { canonical } from './real-path.mjs';
import {
  RUN_ARTIFACT_RETENTION_MS,
  checkpointManifest,
  writeAttemptArtifact,
  writeCandidatePatch,
  writeEvidenceArtifact,
  writeWinnerAlias,
} from './run-artifacts.mjs';
import {
  baselineRow,
  buildRunBody,
  candidateRefFromSummary,
  commitRunLearning,
  learningArtifactRefs,
  learningAttemptRefs,
  runFailure,
  runSuccess,
  selectionReasonCode,
} from './run-body.mjs';
import {
  LANE_ARTIFACT_STOPS,
  artifactAuthorityLost,
  artifactBlocked,
  handoffNotice,
  laneStopCode,
  laneStopDetail,
  qualityWriterSettlement,
  reasonCodeOf,
  statusOfReasonCode,
  stopCodeParams,
  terminalOutcome,
} from './run-faults.mjs';
import { REASON, isPoisonCode, isReasonCode } from './reason-codes.mjs';
import { fail, renderNotice } from './reason-text.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { cloneData, ownDataValue } from './util/objects.mjs';
import { contained } from './util/paths.mjs';
import { compareUtf8 } from './util/strings.mjs';
import { removeWorktree as defaultRemoveWorktree } from './worktree.mjs';

/** 값이 없을 때 문장에 들어가는 토큰. `renderReason` 은 빠진 인자에 **던지므로** 자리를 비울 수 없다. */
const UNKNOWN_VALUE = '<unknown>';

/** 하위 모듈의 `{blocked:true}` 인가. `ok:true` 결과와 겹치지 않는다. */
const isBlocked = (result) => ownDataValue(result, 'blocked').value === true;

const LEARNING_DISABLED_RESULT = deepFreeze({
  outcome: { grade: null, appliedChoices: {}, rewardableChoices: {} },
  applied: false,
  appliedAxes: [],
  grade: null,
  notices: [],
});

/**
 * 공유 `contained` 에 **같은 경로**를 더한 판 — `src/engine.mjs:446` 의 동명 함수와 같은 세 줄이다.
 *
 * ★ 왜 복사인가. 공유본은 사본 넷 중 셋의 답을 따라 `parent === child` 를 거짓으로 보고, 엔진은
 *   자기 파일에서 같음만 더해 그 답을 뒤집는다(엔진 :438 의 WHY: 그러지 않으면
 *   `artifact_root_overlaps_project` 가 사라진다). 심판 스크래치 검사는 그 엔진판을 쓰던 코드라
 *   같은 판을 그대로 따라와야 한다. 공유 모듈로 올리면 「같음은 거짓」이라는 공유본의 결정을 이
 *   리팩터가 뒤집는 것이 되고, 이음매로 나르면 이음매가 세 줄짜리 순수 함수의 배달부가 된다.
 */
function pathContains(parent, child) {
  return relative(parent, child) === '' || contained(parent, child);
}

/**
 * 실행 하나의 종료 경로 — 레인 수와 무관하게 이 함수 **하나**다.
 *
 * 인자는 엔진이 조립한 `sharedContext` 하나이고, 반환은 이 실행이 낼 MCP 봉투 하나다(준비 단계가
 * 먼저 실패하면 그 단계가 이미 만든 봉투를 그대로 낸다). 엔진의 호출부도 하나다 — 후보 수로
 * 갈리는 삼항은 사라졌고, 그 수는 `preparation.candidateCount` 에서 **데이터로** 읽힌다.
 *
 * ★ 이 함수가 들고 있는 것은 **머리(공통 준비)와 조립(종료 봉투)** 이다. 그 사이의 수집 단계만
 *   레인 수로 갈리고(`collectSoloLane` / `collectPairedLanes`), 그 둘은 조립을 갖지 않는다 —
 *   `buildRunBody`·`commitRunLearning`·`renderContentParts` 는 이 파일에 각각 **한 번** 나온다.
 *
 * ★ `context.finalizationSeam` 한 줄만이 이 파일에서 엔진의 내부를 아는 자리다(모듈 머릿말).
 */
export async function finalizeRun(context) {
  const { prepareRunNamespace, runPreparedLane, PREPARATION_PRIVATE } = context.finalizationSeam;
  const preparation = await prepareRunNamespace(context, context.deps);
  if (preparation.ok !== true) return preparation.envelope;
  const {
    runId, stateRoot, deadlineAt, candidateCount, laneWorktrees, laneBindings,
    plan, plannedByModel, artifactStore, usageAccumulator, preflight, testQueue,
  } = preparation;
  // ★★ 출발점 한 줄을 **여기서 한 번** 만든다. 두 채널이 그것을 읽는다 — 아래 `baseNotices`
  //   의 미커밋 고지와 본문의 `baseline` 행 — 그리고 그 둘은 같은 실행에 대해 같은 말을 해야
  //   한다. 각자 접으면 알림은 "미커밋 있었음"인데 본문은 `dirty: false` 인 봉투가 나올 수 있고,
  //   그 모순은 어느 채널이 옳은지 읽는 쪽이 정할 방법이 없다.
  const baseline = baselineRow({ baseline: preparation.baseline, worktrees: laneWorktrees });
  const {
    taskClass, decisions, decisionSources, plannerProvider, laneProviders, judgeBindings,
    plannerNotices, callProvider, pathBudget, effectiveChoices, learningMutationEnabled, faultRegistry,
  } = PREPARATION_PRIVATE.get(preparation);
  const {
    deps, deadline, effectiveWaitMs, now, stage, recoveryStage, killLiveChildren,
    isWorktreeEffectUnknown, envelopeExtras, terminalRow, noteRunJournaled, haltReasonCode, runHalt,
    startedAt,
  } = context;
  // ★ 이 배열이 이 파일의 **데이터**다. 아래의 모든 갈림은 코드 사본이 아니라 이것의 길이를 읽는다.
  const laneIds = candidateCount === 1 ? ['lane-a'] : ['lane-a', 'lane-b'];
  const soloLane = laneIds.length === 1;
  // ★ 리퍼가 **등록까지** 빼려면 어느 저장소에서 뺄지를 알아야 한다(P2). 이 함수의 인자는
  //   경로 하나뿐이고(증거 워크트리 정리는 `{path}` 만 들고 온다) 이 파일에는 `projectPath`
  //   가 이름으로 들어오지 않는다. 값은 레인 핸들에서 한 번 읽는다 — **한 실행의 워크트리는
  //   전부 같은 저장소에서 났으므로** 그 값은 하나다(`createWorktree` 는 실행마다 같은
  //   `projectPath` 를 편 값으로 핸들에 싣고, 증거 워크트리도 그 핸들에서 파생된다).
  const handoffProjectPath = laneWorktrees
    .find((handle) => typeof handle?.projectPath === 'string' && handle.projectPath !== '')?.projectPath ?? null;
  // 두 원본에서 **바이트가 같던** 다섯 줄. 한 벌만 남는다.
  const effectUnknownRetention = (path, declared = false) => {
    if (!declared && isWorktreeEffectUnknown?.(path) !== true) return {};
    const observed = now();
    const retainUntil = Number.isSafeInteger(observed) && observed >= 0 &&
      observed <= Number.MAX_SAFE_INTEGER - RUN_ARTIFACT_RETENTION_MS
      ? observed + RUN_ARTIFACT_RETENTION_MS
      : Number.MAX_SAFE_INTEGER;
    return { purpose: 'effect_unknown', retainUntil };
  };
  const handoffWorktree = async (path, label = 'worktree handoff', declaredEffectUnknown = false) => {
    const result = await recoveryStage(label, () => (deps.trackWorktree ?? defaultTrackWorktree)({
      stateRoot, runId, worktree: path, projectPath: handoffProjectPath,
      ...effectUnknownRetention(path, declaredEffectUnknown),
    })).catch(() => false);
    return result === true;
  };
  const writeAttempt = deps.writeAttemptArtifact ?? writeAttemptArtifact;
  const writeEvidence = deps.writeEvidenceArtifact ?? writeEvidenceArtifact;
  const writeCandidate = deps.writeCandidatePatch ?? writeCandidatePatch;
  const checkpointRaw = deps.checkpointManifest ?? checkpointManifest;
  let latestManifestRef = null;
  // 두 원본이 `if (x?.manifestRef) latestManifestRef = x.manifestRef` 를 다섯 자리에서 적던 것을
  // 한 함수로 접었다 — 조건이 같은 진리값 검사라 값은 글자 하나까지 같다. 이 함수는 이미
  // `artifactAuthority.setLatestManifestRef` 라는 이름으로 레인에도 넘어가던 그 함수다.
  const setLatestManifestRef = (value) => { if (value) latestManifestRef = value; };
  const getLatestManifestRef = () => latestManifestRef;
  // 레인에 넘기는 권한 객체에서 두 경로가 **같은 다섯**. 나머지(poison 원장과 `checkpoint`)는
  // 원장 모양이 갈리므로 각 수집 단계가 자기 것을 얹는다.
  const authorityBase = { handoffWorktree, setLatestManifestRef, writeAttempt, writeEvidence, writeCandidate };
  // 준비 단계의 알림(retention·planner)과 벤더 실행 고지·스트림 드리프트는 **모든** 종료 봉투가 나른다.
  // C1 은 스윕 알림을 `sweepSummaries` 로 먼저 펴 두었고 C2 는 같은 삼항을 이 자리에서 폈다 —
  // 두 식이 같은 값을 내므로 한 벌만 남는다.
  const baseNotices = () => [
    ...(preparation.sweepNotice === null ? [] : [preparation.sweepNotice]),
    // ★★ 미커밋 고지(WS5 태스크 6, 메모 §D.2). 본문의 `baseline` 행이 네 키로 적는 것을 한
    //   문장으로 적는다 — 그 행은 사다리의 어느 단에서도 살아남지만 **읽히려면 본문을 파싱해야**
    //   하고, 이 사실은 패치를 적용하기 **전에** 알아야 하는 것이라 봉투의 문장 채널에도 선다.
    //   수는 잘리기 전의 진짜 개수다(투영의 10건 상한은 본문에만 걸린다) — 알림이 상한 안의
    //   수를 말하면 「열 개였다」가 「열 개까지만 실었다」와 구별되지 않는다.
    ...(baseline.dirty ? [renderNotice('baseline_included_uncommitted_changes', { count: baseline.dirtyFiles.length })] : []),
    // 재개는 봉투에 문장 하나를 남긴다(WS3 §3): 이 봉투의 `runId` 는 **새** 실행이므로, 재사용된
    // 실행의 이름은 여기 말고 어느 채널에도 없다. 종료 봉투 전부가 그것을 나른다.
    ...(preparation.resume === null ? [] : [renderNotice('resume_attempts_reused', preparation.resume.noticeParams)]),
    ...plannerNotices,
    ...faultRegistry.providerNotices(),
    ...faultRegistry.driftNotices(),
    // 벤더가 스스로 보낸 한도 수치도 같은 채널을 탄다(WS4b 태스크 7) — 벤더별 한 줄이고,
    // 실행이 막혔든 안 막혔든 그 수는 사용자가 다음 호출의 예산을 정할 때 필요한 사실이다.
    ...faultRegistry.rateLimitNotices(),
  ];
  // `terminalCode` 는 이 봉투가 실제로 실을 코드다 — 발췌 순서가 그것을 따라간다(WS2 §3.4).
  const extras = (notices = [], terminalCode = null) => ({
    ...envelopeExtras([...baseNotices(), ...notices]),
    excerpts: faultRegistry.excerpts(terminalCode),
  });
  // 선택 결과 → 레인 인덱스. 한 규칙을 두 자리가 읽는다: `selectSingleCandidate` 도 이긴 후보의
  // `candidateId` 를 그대로 실으므로 레인이 하나일 때도 같은 규칙이 그대로 맞는다.
  const selectedLaneIndex = (result) => result.selectedCandidateId === null
    ? -1
    : laneIds.indexOf(result.selectedCandidateId);
  /**
   * 학습 커밋 **한 자리**. C1 은 이것을 두 번(별칭 실패·최종 채점), C2 는 한 번 부른다 — 부르는
   * 횟수가 다를 뿐 커밋하는 트랜잭션의 모양은 같았다. 갈리던 값 셋(`candidateCount`·`candidates`
   * ·`selection`)은 전부 인자로 들어오고, `manifestRef` 는 부르는 **그 시점**의 값이다.
   */
  const learn = ({ candidates, selection, stopReason, winnerRef, terminal }) =>
    learningMutationEnabled === true ? commitRunLearning({
      deps, stage, stateRoot, runId, taskClass, decisions, candidateCount,
      stopReason, selection, candidates, effectiveChoices,
      attemptRefs: learningAttemptRefs(candidates),
      artifactRefs: learningArtifactRefs({ manifestRef: latestManifestRef, candidates, winnerRef }),
      terminal: terminalRow(terminal), onJournaled: noteRunJournaled,
    }) : LEARNING_DISABLED_RESULT;
  const runtime = {
    preparation, context, runPreparedLane, deps, runId, stateRoot, deadlineAt, laneIds, laneWorktrees,
    artifactStore, usageAccumulator, pathBudget, faultRegistry, laneProviders, judgeBindings, callProvider,
    deadline, effectiveWaitMs, now, stage, recoveryStage, killLiveChildren, isWorktreeEffectUnknown,
    // `haltReasonCode` 는 심판 경로도 읽는다(최종 리뷰 M7): 접힌 신호는 「잘렸다」까지만 알고
    // 「누가 껐는가」는 신호 소스만 안다.
    haltReasonCode, runHalt, extras, handoffWorktree, authorityBase, checkpointRaw, setLatestManifestRef,
    getLatestManifestRef, selectedLaneIndex, learn,
  };
  /**
   * 수집 단계가 채우는 자리. 기본값은 **레인이 하나인 실행의 답**이다 — 심판도, 별칭 실패로
   * 이어지는 갈래도, 미리 굳은 마감도 없다(C1 은 별칭이 깨지면 조립까지 오지 않는다).
   */
  const collected = { winner: null, aliasFailure: false, judgeNotices: [], judgeFailure: null, gradeDeadline: false };
  const early = soloLane ? await collectSoloLane(runtime, collected) : await collectPairedLanes(runtime, collected);
  if (early !== null) return early;
  const { laneResults, candidates, selection, winner, aliasFailure, judgeNotices, judgeFailure, cleanupLanes } = collected;

  // ── 조립: 여기부터 끝까지 **한 경로**다. 레인 수는 위에서 만든 데이터로만 남는다. ────────────
  const selectedIndex = selectedLaneIndex(selection);
  const selectedCandidate = selectedIndex < 0 ? null : candidates[selectedIndex];
  // 채점 시점의 마감. C2 는 심판 마감·후보 마감·`winner.hardStopped` 를 이미 접어 둔 값을 들고
  // 오므로 여기서 다시 읽으면 그 셋이 지워진다. C1 은 이 자리(별칭 단계 직후)가 첫 읽기다.
  const gradeDeadline = soloLane ? deadline?.aborted === true && selectedCandidate === null : collected.gradeDeadline;
  const allRejected = candidates.every((candidate) => candidate.terminalClass === 'rejected');
  const allBlocked = candidates.every((candidate) => candidate.terminalClass === 'blocked');
  // 실행 하나가 끝난 **세부 코드**. 레인이 하나면 그 레인의 정지 사유가 곧 실행의 것이고(중재할
  // 상대가 없다), 둘이면 `selectionReasonCode` 의 여섯 우선순위가 정한다.
  const laneReasonCode = soloLane
    ? candidates[0].stopReason
    : selectionReasonCode({
      aliasFailure, terminalDeadline: gradeDeadline, haltReasonCode: haltReasonCode(),
      selectedCandidate, selection, judgeFailure, allRejected, allBlocked,
    });
  // Hoisted above the learning commit so the journal row and the envelope below
  // read the SAME code: cleanup registers no fault, so the value cannot move.
  // ★ 결함을 **어느 레인에서** 찾는가만 갈린다: 레인이 하나면 언제나 그 레인, 둘이면 이긴 레인
  //   (아무도 못 이겼으면 레인에 매이지 않은 실행 전체의 결함).
  const terminalFault = faultRegistry.laneFault(soloLane ? 'lane-a' : selection.selectedCandidateId ?? undefined);
  const terminalCode = laneStopCode(laneReasonCode, terminalFault);
  // The learning row records the terminal stop as it stood when the grade was
  // decided.  The envelope re-reads the deadline after cleanup below, so a
  // deadline that fires during storage still surfaces to the caller without
  // retroactively rewriting what we learned.
  const learnedStopReason = gradeDeadline ? haltReasonCode() : laneReasonCode;
  // Selection and the alias attempt are durable; commit the one learning
  // transaction before cleanup so a cleanup fault cannot change the grade.
  // 이 넷이 아래 종료 갈래 넷과 같은 순서로 갈린다 — 봉투와 저널이 한 판정을 말한다.
  const learning = await learn({
    candidates, selection, stopReason: learnedStopReason, winnerRef: winner?.ref ?? null,
    terminal: gradeDeadline
      ? terminalOutcome({ reasonCode: haltReasonCode() })
      : aliasFailure
        ? terminalOutcome({ reasonCode: REASON.artifact_winner_alias_failed })
        : selectedCandidate !== null
          ? terminalOutcome({ successStopReason: learnedStopReason })
          : terminalOutcome({ reasonCode: terminalCode }),
  });
  const { cleanup, cleanupNotices, trackedPaths } = await cleanupLanes();
  // 봉투는 정리 뒤에 마감을 **다시 읽는다**(C1 의 규칙) — 저장 중에 발화한 마감도 호출자에게
  // 보인다. C2 의 값은 위에서 이미 굳었고 그 자리에 `winner.hardStopped` 가 접혀 있다.
  const terminalDeadline = soloLane ? deadline?.aborted === true && selectedCandidate === null : gradeDeadline;
  // ★ `path` 와 `detail` 은 **레인이 하나일 때만** 실린다. 레인이 둘이면 「그 워크트리」도
  //   「그 판정문」도 없다(`laneStopDetail` 은 `verifier_verdict_invalid` 의 자리표시자다) — 없는
  //   값을 지어내면 "판정문을 못 읽었다: undefined" 가 봉투로 나가고, 남의 레인 경로를 실으면
  //   봉투가 거짓말을 한다. 레인별 값은 아래 `blockers` 가 레인마다 따로 싣는다.
  const terminalParams = {
    runId,
    ...(soloLane ? { path: laneWorktrees[0].path } : {}),
    waitMs: effectiveWaitMs, vendor: terminalFault?.vendor ?? UNKNOWN_VALUE,
    ...(soloLane ? laneStopDetail(candidates[0]) : {}),
    ...stopCodeParams(terminalCode),
  };
  const body = buildRunBody({
    runId, reasonCode: terminalDeadline ? haltReasonCode() : laneReasonCode, candidateCount, pathBudget, selection,
    candidates, selectedCandidate,
    winnerRef: winner?.ref ?? null, manifestRef: latestManifestRef,
    worktrees: laneWorktrees, cleanup, laneFacts: laneResults.map((result) => result.contentFacts), baseline,
    taskClass, decisions, sources: decisionSources, learning,
    plan: { provider: plannerProvider.id, content: plannedByModel ? plan : '' },
    // 레인마다 막힌 이유가 다르다 — 코드도 벤더도 워크트리 경로도 그 레인의 것을 쓴다. 레인이
    // 하나면 이 목록의 유일한 항목이 위 `terminalParams` 와 글자 하나까지 같은 값이 된다(같은
    // 결함·같은 코드·같은 경로) — C1 이 그 봉지를 그대로 재사용하던 것과 같은 뜻이다.
    blockers: candidates.flatMap((candidate, index) => {
      if (candidate.terminalClass !== 'blocked') return [];
      const fault = faultRegistry.laneFault(candidate.candidateId);
      const blockerCode = laneStopCode(candidate.stopReason, fault);
      return [{
        candidateId: candidate.candidateId,
        reasonCode: blockerCode,
        params: {
          runId, path: laneWorktrees[index].path, waitMs: effectiveWaitMs,
          vendor: fault?.vendor ?? UNKNOWN_VALUE, ...laneStopDetail(candidate), ...stopCodeParams(blockerCode),
        },
      }];
    }),
    // ★ `buildRunBody` 머리말이 「C1 과 C2 가 다르다」고 적어 둔 셋. 둘은 데이터로 접혔다:
    //   `stepCount` 는 C2 의 식이 레인 하나에서도 같은 수를 낸다(`contentFacts.attempts` 는
    //   `candidate.attempts` 를 1:1 로 옮긴 것이다), `selectedCandidateId` 는 두 선택기가 같은
    //   값을 싣는다. `proofStatus` 만 진짜로 갈린다.
    stepCount: selectedCandidate?.attempts.length
      ?? laneResults.reduce((sum, result) => sum + result.contentFacts.attempts.length, 0),
    // 레인이 하나면 그 레인의 증명 상태가 곧 실행의 것이다 — 이기지 못했더라도 이 실행이 가진
    // 유일한 증명이고, 둘일 때의 규칙(「이긴 후보의 것만」)을 여기 적으면 그 값이 사라진다.
    proofStatus: (selectedCandidate ?? (soloLane ? candidates[0] : null))?.regressionProof.status ?? 'unavailable',
    selectedCandidateId: selection.selectedCandidateId,
    // ★★ 비용 행의 네 조각은 **전부 이미 있던 장부**다(WS4b 태스크 6, 계약의 `cost` 행). 새로
    //   재는 것은 하나도 없다: 누산기는 이 실행의 수집 단계가 이미 봉인했고(`finalize()` 는
    //   두 번째 호출부터 같은 얼어붙은 값을 낸다 — 그래서 체크포인트가 적은 수와 봉투가 말하는
    //   수가 **같은 객체**다), 큐의 집계는 스위트가 실제로 돈 횟수이며(캐시 적중은 큐를 안 지나므로
    //   세지 않는다 — 그것이 옳다), `startedAt` 은 엔진이 마감을 지으며 읽은 그 시각이다.
    // ★ `elapsedMs` 를 여기서 재는 이유: 저널의 `finishedAt` 은 이 봉투가 만들어진 **뒤에** 읽히고,
    //   두 수가 같은 실행에 대해 다르면 사용자는 어느 쪽이 「이 실행」인지 물을 자리가 없다.
    //   이 자리는 조립의 유일한 지점이라 봉투가 말하는 시간은 언제나 하나다.
    usage: usageAccumulator.finalize(),
    // 시계가 뒤로 가는 갈래는 0 으로 접는다 — 형제(`runTotalMs`, `src/regression-proof.mjs:418`)와
    // 같은 규칙이다. 접지 않으면 음수 하나가 `projectCost` 에서 던지고 사다리가 통째로 `break`
    // 해서, 성공한 실행이 후보·이슈·증거·선택을 잃고 지어낸 `elapsedMs: 0` 짜리 바닥을 싣는다.
    elapsedMs: Math.max(now() - startedAt, 0),
    testRuns: testQueue?.testRuns?.() ?? null,
    preflight,
  });
  const { content, contentFallback, notices: ladderNotices } = (deps.renderContentParts ?? renderContentParts)(deepFreeze(body));
  const trackedHandoffNotices = trackedPaths.map((path) => handoffNotice(true, path));
  // ★★ 알림의 **순서**가 레인 수로 갈린다 — `joinNotices` 는 넣은 순서 그대로 한 줄로 잇는다.
  //   C1 은 인계 알림을 정리 알림 **앞**에, C2 는 **뒤**에 실었다. 한 목록에 자리를 둘 두어 두
  //   순서를 그대로 지킨다; 하나로 합치면 한쪽 봉투의 바이트가 바뀐다(양쪽 다 테스트가 잰다).
  const terminalExtras = extras([...(ladderNotices ?? []), // 사다리가 던졌다는 사실은 알림뿐이다(WS2 §4.1)
    // 레인 중 하나만 돌았어도 사용자 코드는 사용자 권한으로 돌았다. 신고는 런당 한 번이다.
    ...(laneResults.some((lane) => lane.userPrivilegeObserved === true) ? [renderNotice('test_ran_with_user_privileges', {})] : []),
    ...judgeNotices,
    ...(soloLane ? trackedHandoffNotices : []),
    ...cleanupNotices,
    ...(soloLane ? [] : trackedHandoffNotices),
    ...learning.notices,
  ], terminalCode);
  if (terminalDeadline) {
    return runHalt({ runId, content, contentFallback, extras: terminalExtras });
  }
  if (aliasFailure) {
    return runFailure({
      status: statusOfReasonCode(REASON.artifact_winner_alias_failed),
      confidence: confidenceOfRun({ unverified: true }), content, contentFallback, runId,
      reasonCode: REASON.artifact_winner_alias_failed, extras: terminalExtras,
    });
  }
  if (selectedCandidate !== null) {
    // ★ 검증이 **독립**이었나 — 쓴 벤더와 검증한 벤더가 달랐나. C1 은 `allow_single` 로 한 벤더가
    //   양쪽을 맡을 수 있어 이 곱이 필요했고, C2 는 인자 검증이 `allow_single` 을 거부하고 서로
    //   다른 두 벤더를 요구하므로 언제나 참이다(두 레인이 서로의 벤더를 검증한다). 그래서 한 식이
    //   두 행동을 다 지킨다 — C2 의 값을 바꾸지 않으면서 C1 의 곱을 살린다.
    const laneBinding = laneBindings[selectedIndex];
    return runSuccess({
      content, contentFallback, runId, stopReason: laneReasonCode,
      verified: selectedCandidate.terminalClass === 'verified' &&
        laneBinding.writer.providerId !== laneBinding.verifier.providerId,
      extras: terminalExtras,
    });
  }
  return runFailure({
    // status 는 고르는 값이 아니라 **코드에서 나오는** 값이다(계약 topLevel.status 의 rule).
    status: statusOfReasonCode(terminalCode),
    // 레인이 하나면 `selection.outcome` 은 `tie` 가 될 수 없고 `allRejected` 는 「그 후보가
    // 거부됐다」와 같은 말이다 — C1 의 `confidenceOfRun({ disputed: rejected })` 와 값이 같다
    // (`disputed:false` 와 `unverified:true` 는 둘 다 `'unverified'` 로 접힌다).
    confidence: selection.outcome === 'tie' || allRejected
      ? confidenceOfRun({ disputed: true })
      : confidenceOfRun({ unverified: true }),
    content, contentFallback, runId, reasonCode: terminalCode, params: terminalParams, extras: terminalExtras,
  });
}

/**
 * 레인 **하나**짜리 실행의 수집 단계 — 레인을 돌리고, 산출물을 확정하고, 선택과 승자 별칭까지 간다.
 *
 * ★ 왜 조립과 갈라졌나(그리고 왜 C2 와 접히지 않았나). 이 단계의 세 가지가 레인 수에 따라 **다른
 *   봉투**를 낸다: (1) poison 원장이 「아무 poison 이나」로 다음 체크포인트를 막고(C2 는 권위
 *   상실만), (2) 자기 레인이 막히면 실행이 끝나며(C2 는 다른 레인이 이길 수 있어 계속한다),
 *   (3) 별칭이 깨지면 자기 학습 행을 쓰고 그 자리에서 막힌 봉투로 끝난다(C2 는 `aliasFailure` 를
 *   들고 조립까지 간다). 셋 다 접으면 봉투 바이트가 바뀌므로 접지 않았다.
 *
 * @param {object} runtime `finalizeRun` 의 머리가 만든 공통 이름들.
 * @param {object} collected 조립이 읽을 자리 — 이 함수가 채운다.
 * @returns {Promise<object|null>} 이 단계에서 실행이 끝나면 그 봉투, 아니면 `null`(조립으로 간다).
 */
async function collectSoloLane(runtime, collected) {
  const {
    preparation, context, runPreparedLane, deps, runId, stateRoot, laneWorktrees, artifactStore,
    usageAccumulator, pathBudget, deadline, effectiveWaitMs, stage, recoveryStage, killLiveChildren,
    isWorktreeEffectUnknown, faultRegistry, extras, handoffWorktree, authorityBase, checkpointRaw,
    setLatestManifestRef, learn, runHalt,
  } = runtime;
  // 「그 워크트리」 — 레인이 하나뿐일 때만 있는 이름이고, `preparation.laneWorktree` 와 같은 객체다.
  const laneWorktree = laneWorktrees[0];
  let artifactStorePoison = null;
  const poisonArtifactStore = (reason) => {
    if (artifactStorePoison === null) artifactStorePoison = reason;
  };
  const poisonedArtifactResult = () => fail(artifactStorePoison ?? REASON.artifact_store_authority_lost);
  const checkpoint = async (store, event) => {
    if (artifactStorePoison !== null) return poisonedArtifactResult();
    const rawResult = await stage(`manifest ${event.type}`, () => checkpointRaw(store, event))
      .catch(() => fail(REASON.artifact_manifest_checkpoint_failed));
    const settlement = classifyArtifactSettlement(rawResult, {
      kind: 'checkpoint', authority: preparation.manifestAuthority,
    });
    const result = settlement.result;
    if (settlement.kind === 'success' && !acceptArtifactRevision(result, preparation.artifactRevisionAuthority)) {
      poisonArtifactStore(REASON.artifact_store_authority_lost);
      return unknownArtifactSettlement();
    }
    if (settlement.kind === 'unknown' || result?.hardStopped === true) poisonArtifactStore(REASON.artifact_store_authority_lost);
    else if (isBlocked(result)) poisonArtifactStore(reasonCodeOf(result, REASON.artifact_manifest_checkpoint_failed));
    setLatestManifestRef(result?.manifestRef);
    return result;
  };
  const artifactAuthority = {
    ...authorityBase,
    checkpoint,
    artifactStorePoison: () => artifactStorePoison,
    isStoreAuthorityLost: () => artifactStorePoison !== null,
    poisonedArtifactResult,
    poisonArtifactStore,
  };
  // 여섯 자리가 같은 두 줄이었다: 워크트리를 리퍼에게 넘기고, 넘어갔는지 아닌지를 알림으로
  // 실어 막힌 봉투를 낸다. 두 벌이면 한쪽만 고쳐지고, 그때 사라지는 것은 "워크트리가 어디 남았나" 다.
  const blockedAfterHandoff = async (reasonCode, label) => {
    const tracked = await handoffWorktree(laneWorktree.path, label);
    return artifactBlocked(runId, reasonCode, {}, extras([handoffNotice(tracked, laneWorktree.path)]));
  };
  const laneResult = await runPreparedLane({ preparation, laneIndex: 0, context, artifactAuthority });
  const candidate = laneResult.candidate;

  if (artifactStorePoison !== null) {
    await killLiveChildren();
    const tracked = await handoffWorktree(laneWorktree.path, 'poisoned artifact worktree handoff');
    return artifactBlocked(runId, artifactStorePoison, { runId }, extras([handoffNotice(tracked, laneWorktree.path)]));
  }

  if (deadline?.aborted !== true && (candidate.recovery !== null || LANE_ARTIFACT_STOPS.includes(candidate.stopReason))) {
    const effectUnknown = candidate.stopReason === REASON.provider_outcome_unknown ||
      candidate.recovery?.code === REASON.provider_outcome_unknown;
    const tracked = await handoffWorktree(
      laneWorktree.path, 'candidate failure worktree handoff', effectUnknown,
    );
    const laneFault = faultRegistry.laneFault('lane-a');
    const laneCode = laneStopCode(candidate.stopReason, laneFault);
    return artifactBlocked(
      runId, laneCode,
      { runId, path: laneWorktree.path, vendor: laneFault?.vendor ?? UNKNOWN_VALUE, waitMs: effectiveWaitMs, ...stopCodeParams(laneCode) },
      extras([handoffNotice(tracked, laneWorktree.path)], laneCode),
    );
  }

  const candidateRef = candidateRefFromSummary(candidate);
  const expectedCandidatePath = pathBudget.paths?.candidatePaths?.['lane-a'];
  if (candidate.patch !== null && candidate.patch.ref?.path !== expectedCandidatePath) {
    return blockedAfterHandoff(REASON.artifact_candidate_path_mismatch, 'candidate path worktree handoff');
  }
  const candidateCheckpoint = await checkpoint(artifactStore, { eventId: 'candidate:lane-a:recorded', type: 'candidate_recorded', value: candidateRef });
  if (isBlocked(candidateCheckpoint)) {
    const tracked = await handoffWorktree(laneWorktree.path, 'candidate checkpoint worktree handoff');
    const carried = extras([handoffNotice(tracked, laneWorktree.path)]);
    if (deadline?.aborted === true || candidateCheckpoint?.hardStopped === true) {
      return runHalt({ runId, extras: carried });
    }
    return artifactBlocked(runId, REASON.artifact_candidate_checkpoint_failed, {}, carried);
  }
  const issuesCheckpoint = await checkpoint(artifactStore, { eventId: 'issues:lane-a:recorded', type: 'issues_recorded', value: { candidateId: 'lane-a', openIssueIds: candidate.issues.openIds, openIssueCount: candidate.issues.count, limitExceeded: candidate.issues.limitExceeded } });
  if (isBlocked(issuesCheckpoint)) return blockedAfterHandoff(REASON.artifact_candidate_checkpoint_failed, 'issues checkpoint handoff');
  const selection = selectSingleCandidate(candidate);
  const usage = usageAccumulator.finalize();
  const usageCheckpoint = await checkpoint(artifactStore, { eventId: 'usage:run:final', type: 'usage_recorded', value: usage });
  if (isBlocked(usageCheckpoint)) return blockedAfterHandoff(REASON.artifact_selection_checkpoint_failed, 'usage checkpoint handoff');
  const selectionCheckpoint = await checkpoint(artifactStore, { eventId: 'selection:run:recorded', type: 'selection_recorded', value: selection });
  if (isBlocked(selectionCheckpoint)) return blockedAfterHandoff(REASON.artifact_selection_checkpoint_failed, 'selection checkpoint handoff');
  // Selection is durable from here on, so every remaining exit journals exactly
  // one row.  Nothing above this line writes a *learning* row; the run's terminal
  // record is the engine sink's row instead (WS3 §0-D1).
  let winner = null;
  if (selection.outcome === 'winner') {
    const rawWinner = await recoveryStage('winner alias', () =>
      (deps.writeWinnerAlias ?? writeWinnerAlias)(artifactStore, { candidateId: 'lane-a' }))
      .catch(() => ({ blocked: true }));
    const candidatePatchRef = candidate.patch?.ref;
    const settlement = classifyArtifactSettlement(rawWinner, {
      kind: 'writer',
      authority: {
        writer: {
          kind: 'winner', candidateId: 'lane-a', path: pathBudget.paths?.winnerAliasPath,
          bytes: candidatePatchRef?.bytes, sha256: candidatePatchRef?.sha256,
        },
        manifest: preparation.manifestAuthority,
      },
    });
    winner = settlement.kind === 'success' && !acceptArtifactRevision(settlement.result, preparation.artifactRevisionAuthority)
      ? unknownArtifactSettlement() : settlement.result;
    if (settlement.kind === 'success' && winner !== settlement.result) poisonArtifactStore(REASON.artifact_store_authority_lost);
    if (settlement.kind === 'unknown' || winner?.hardStopped === true) poisonArtifactStore(REASON.artifact_store_authority_lost);
    const winnerRef = winner?.ref;
    const expectedWinnerPath = pathBudget.paths?.winnerAliasPath;
    if (isBlocked(winner) || winner?.ok !== true || winnerRef?.kind !== 'winner' ||
        winnerRef?.candidateId !== 'lane-a' || winnerRef?.path !== expectedWinnerPath ||
        winnerRef.path === candidatePatchRef?.path || winnerRef?.sha256 !== candidatePatchRef?.sha256 ||
        winnerRef?.bytes !== candidatePatchRef?.bytes || !Number.isSafeInteger(winnerRef?.bytes) || winnerRef.bytes <= 0 ||
        !Number.isSafeInteger(winnerRef?.expiresAt) || winnerRef.expiresAt <= 0) {
      // Selection is already durable, so this Run owns a journal row even though
      // it returns blocked: `artifact_winner_alias_failed` grades it neutral, and the
      // refs we record are the last ones we actually proved.
      await learn({
        candidates: [candidate], selection, stopReason: REASON.artifact_winner_alias_failed,
        winnerRef: null, terminal: terminalOutcome({ reasonCode: REASON.artifact_winner_alias_failed }),
      });
      return blockedAfterHandoff(REASON.artifact_winner_alias_failed, 'winner failure worktree handoff');
    }
    setLatestManifestRef(winner?.manifestRef);
  }
  collected.laneResults = [laneResult];
  collected.candidates = [candidate];
  collected.selection = selection;
  collected.winner = winner;
  collected.cleanupLanes = async () => {
    let cleanup = { removed: false, unregistered: false, tracked: false };
    const cleanupNotices = [];
    const preserveAuthoring = candidate.terminalClass === 'blocked' || candidate.recovery !== null || isWorktreeEffectUnknown?.() === true;
    const childrenProven = await killLiveChildren();
    const removal = childrenProven === true && !preserveAuthoring
      ? snapshotRemovalResult(await stage('authoring cleanup', () =>
        (deps.removeWorktree ?? defaultRemoveWorktree)(laneWorktree)).catch(() => null))
      : UNPROVEN_REMOVAL;
    if (childrenProven === true && removal.ok === true && removal.removed === true && removal.unregistered === true) {
      cleanup = { removed: true, unregistered: true, tracked: false };
    } else {
      const physicalRemoved = removal.ok === true && removal.removed === true;
      const unregistered = removal.ok === true &&
        (removal.unregistered === true || removal.unregistered === false || removal.unregistered === null)
        ? removal.unregistered : false;
      const effectUnknown = candidate.stopReason === REASON.provider_outcome_unknown ||
        candidate.recovery?.code === REASON.provider_outcome_unknown;
      const tracked = await handoffWorktree(
        laneWorktree.path, 'authoring cleanup handoff', effectUnknown,
      );
      cleanup = { removed: physicalRemoved, unregistered, tracked };
      if (!tracked) cleanupNotices.push(handoffNotice(false, laneWorktree.path));
    }
    const cleanupValue = {
      kind: 'authoring', candidateId: 'lane-a', attemptId: null, path: laneWorktree.path,
      status: cleanup.removed === true && cleanup.unregistered === true ? 'removed' : 'reaper_pending',
      recoveryPath: cleanup.removed === true && cleanup.unregistered === true ? null : laneWorktree.path,
    };
    const logicalCleanupPath = `worktrees/${laneWorktree.worktreeId ?? runId}`;
    if (cleanup.removed === true && cleanup.unregistered === true || cleanup.tracked === true) {
      const cleanupEvent = await checkpoint(artifactStore, {
        eventId: `cleanup:authoring:lane-a:000:${sha256(Buffer.from(logicalCleanupPath, 'utf8')).slice(0, 12)}`,
        type: 'cleanup_recorded', value: cleanupValue,
      });
      if (isBlocked(cleanupEvent)) cleanupNotices.push(renderNotice('cleanup_manifest_pending', {}));
    }
    return {
      cleanup,
      cleanupNotices,
      // 레인이 하나면 리퍼에게 넘어간 경로도 하나뿐이다.
      trackedPaths: cleanup.tracked ? [laneWorktree.path] : [],
    };
  };
  return null;
}

/**
 * 레인 **둘**짜리 실행의 수집 단계 — 블라인드 논스, 두 레인 병렬 실행, 레인별 산출물 실패 수집,
 * 목표 비교와(동점이면) 심판 둘, 선택, 승자 별칭.
 *
 * ★ 이 단계가 C1 과 접히지 않는 이유는 `collectSoloLane` 머리말의 셋과 같다(원장·레인 실패·별칭).
 *
 * @param {object} runtime `finalizeRun` 의 머리가 만든 공통 이름들.
 * @param {object} collected 조립이 읽을 자리 — 이 함수가 채운다.
 * @returns {Promise<object|null>} 이 단계에서 실행이 끝나면 그 봉투, 아니면 `null`(조립으로 간다).
 */
async function collectPairedLanes(runtime, collected) {
  const {
    preparation, context, runPreparedLane, deps, runId, stateRoot, deadlineAt, laneIds, laneWorktrees,
    artifactStore, usageAccumulator, pathBudget, laneProviders, judgeBindings, callProvider,
    deadline, now, stage, recoveryStage, killLiveChildren, isWorktreeEffectUnknown,
    haltReasonCode, runHalt, extras, handoffWorktree, authorityBase, checkpointRaw, setLatestManifestRef,
    getLatestManifestRef, selectedLaneIndex,
  } = runtime;
  let judgePromptNonces;
  try {
    const nonceSource = typeof deps.judgeBlindNonce === 'function'
      ? deps.judgeBlindNonce
      : () => randomBytes(16).toString('hex');
    judgePromptNonces = [1, 2].map((judgeIndex) => {
      const value = nonceSource({ runId, judgeIndex });
      if (!/^[0-9a-f]{32}$/.test(value ?? '')) throw new Error('invalid_judge_blind_nonce');
      return value;
    });
    if (judgePromptNonces[0] === judgePromptNonces[1]) throw new Error('duplicate_judge_blind_nonce');
  } catch {
    const notices = [];
    for (const worktree of laneWorktrees) {
      const childrenProven = await killLiveChildren(worktree.path);
      const removed = childrenProven
        ? snapshotRemovalResult(await recoveryStage('judge nonce preparation cleanup', () =>
          (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null))
        : UNPROVEN_REMOVAL;
      if (removed.ok !== true || removed.removed !== true || removed.unregistered !== true) {
        const tracked = await recoveryStage('judge nonce preparation handoff', () =>
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: worktree.path, projectPath: worktree.projectPath })).catch(() => false);
        notices.push(handoffNotice(tracked, worktree.path));
      }
    }
    return artifactBlocked(runId, REASON.judge_nonce_preparation_failed, {}, extras(notices));
  }
  const runArtifactFailures = new Set();
  const storeAuthorityFailures = new Set();
  const affectedArtifactLanes = new Set();
  let storeAuthorityLost = false;
  let deadlineAuthorityLost = false;
  const poisonArtifactStore = (reason, { authorityLost = false, deadlineLost = false, laneId = null } = {}) => {
    const normalized = isReasonCode(reason) ? reason : REASON.artifact_store_authority_lost;
    runArtifactFailures.add(normalized);
    if (laneId === 'lane-a' || laneId === 'lane-b') affectedArtifactLanes.add(laneId);
    // ★ 부분 문자열 판정(`includes('authority_lost')`)이 아니라 레지스트리의 `poison` 이 정한다
    //   (WS2 §2.3) — 코드를 개명해도 승격 규칙이 조용히 꺼지지 않는다.
    if (authorityLost || isPoisonCode(normalized)) {
      storeAuthorityLost = true;
      storeAuthorityFailures.add(normalized);
    }
    if (deadlineLost) deadlineAuthorityLost = true;
  };
  const artifactStorePoison = () => [...runArtifactFailures].sort(compareUtf8)[0] ?? null;
  const storeAuthorityPoison = () => [...storeAuthorityFailures].sort(compareUtf8)[0] ?? null;
  const terminalArtifactPoison = () => storeAuthorityLost
    ? storeAuthorityPoison() ?? REASON.artifact_store_authority_lost
    : artifactStorePoison();
  const poisonedArtifactResult = () => fail(terminalArtifactPoison() ?? REASON.artifact_store_authority_lost);
  const checkpoint = async (store, event) => {
    if (storeAuthorityLost) return poisonedArtifactResult();
    const rawResult = await stage(`manifest ${event.type}`, () => checkpointRaw(store, event))
      .catch(() => fail(REASON.artifact_manifest_checkpoint_failed));
    const settlement = classifyArtifactSettlement(rawResult, {
      kind: 'checkpoint', authority: preparation.manifestAuthority,
    });
    const result = settlement.result;
    if (settlement.kind === 'success' && !acceptArtifactRevision(result, preparation.artifactRevisionAuthority)) {
      poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId: event.laneId ?? event.value?.candidateId ?? null,
      });
      return unknownArtifactSettlement();
    }
    if (settlement.kind === 'unknown') poisonArtifactStore(REASON.artifact_store_authority_lost, {
      authorityLost: true, laneId: event.laneId ?? event.value?.candidateId ?? null,
    });
    if (artifactAuthorityLost(result)) poisonArtifactStore(
      reasonCodeOf(result, REASON.artifact_store_authority_lost), {
        authorityLost: true,
        deadlineLost: result?.hardStopped === true,
        laneId: event.laneId ?? event.value?.candidateId ?? null,
      },
    );
    else if (isBlocked(result) && event.type !== 'candidate_recorded' && event.type !== 'issues_recorded') {
      poisonArtifactStore(reasonCodeOf(result, REASON.artifact_manifest_checkpoint_failed), {
        laneId: event.laneId ?? event.value?.candidateId ?? null,
      });
    }
    setLatestManifestRef(result?.manifestRef);
    return result;
  };

  const artifactAuthority = {
    ...authorityBase,
    checkpoint,
    artifactStorePoison,
    isStoreAuthorityLost: () => storeAuthorityLost,
    poisonedArtifactResult,
    poisonArtifactStore,
    getLatestManifestRef,
  };

  const runLane = async (laneIndex) => {
    const laneId = laneIds[laneIndex];
    const laneResult = await runPreparedLane({
      preparation,
      laneIndex,
      context,
      artifactAuthority,
      judgeViewProjector: ({ candidate: provisional, privateFacts }) => judgePromptNonces.map((blindNonce) =>
        createJudgeView({ candidate: provisional, blindNonce, privateFacts })),
    });
    const candidate = laneResult.candidate;
    let finalFailure = null;
    if (!storeAuthorityLost && !affectedArtifactLanes.has(laneId)) {
      const expectedCandidatePath = pathBudget.paths?.candidatePaths?.[laneId];
      if (candidate.patch !== null && candidate.patch.ref?.path !== expectedCandidatePath) {
        finalFailure = deepFreeze({
          laneId,
          phase: 'candidate_path',
          reason: REASON.artifact_candidate_path_mismatch,
        });
      } else {
        const candidateCheckpoint = await checkpoint(artifactStore, {
          eventId: `candidate:${laneId}:recorded`,
          type: 'candidate_recorded',
          value: candidateRefFromSummary(candidate),
        });
        const issuesCheckpoint = isBlocked(candidateCheckpoint) ? candidateCheckpoint : await checkpoint(artifactStore, {
          eventId: `issues:${laneId}:recorded`,
          type: 'issues_recorded',
          value: {
            candidateId: laneId,
            openIssueIds: candidate.issues.openIds,
            openIssueCount: candidate.issues.count,
            limitExceeded: candidate.issues.limitExceeded,
          },
        });
        if (isBlocked(candidateCheckpoint) || isBlocked(issuesCheckpoint)) {
          finalFailure = deepFreeze({
            laneId,
            phase: isBlocked(candidateCheckpoint) ? 'candidate' : 'issues',
            reason: REASON.artifact_candidate_checkpoint_failed,
          });
        }
      }
    }
    return deepFreeze({
      candidate,
      judgeViews: laneResult.judgeViews,
      contentFacts: laneResult.contentFacts,
      userPrivilegeObserved: laneResult.userPrivilegeObserved === true,
      finalFailure,
    });
  };

  const laneResults = await Promise.all([0, 1].map((index) => runLane(index)));
  const candidates = laneResults.map(({ candidate }) => candidate);
  // ★ 여기도 try 밖이다. 복사 못 하는 요약으로는 블라인드 판정 뷰를 만들 수 없고, `{ ...undefined }`
  //   로 빈 객체를 만들면 그 쌍이 **살아서** 지나간다. `null` 을 내면 `makeBlindPair` 가 `null` 을
  //   내고, 바로 아래 이미 있는 `judge_view_unavailable` 경로가 그것을 받는다 — 새 코드가 없다.
  const alternateCandidates = laneResults.map(({ candidate, judgeViews }) => {
    const cloned = cloneData(candidate);
    return cloned === undefined ? null : deepFreeze({
      ...cloned,
      judgeView: Array.isArray(judgeViews) ? judgeViews[1] : null,
    });
  });
  judgePromptNonces.fill(null);
  const cleanupArtifactFailure = async (reasonCode, priorNotices = []) => {
    const recoveryPaths = [];
    const cleanupNotices = [...priorNotices];
    for (let index = 0; index < laneWorktrees.length; index += 1) {
      const laneId = laneIds[index];
      const worktree = laneWorktrees[index];
      const childrenProven = await killLiveChildren(worktree.path);
      const preserve = storeAuthorityLost || affectedArtifactLanes.has(laneId) ||
        candidates[index].recovery !== null || isWorktreeEffectUnknown?.(worktree.path) === true;
      let removed = null;
      if (childrenProven && !preserve) {
        removed = snapshotRemovalResult(await recoveryStage(`${laneId} artifact failure peer cleanup`, () =>
          (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null));
      }
      removed ??= UNPROVEN_REMOVAL;
      if (removed.ok !== true || removed.removed !== true || removed.unregistered !== true) {
        const tracked = await handoffWorktree(
          worktree.path,
          `${laneId} artifact failure worktree handoff`,
          candidates[index].stopReason === REASON.provider_outcome_unknown ||
            candidates[index].recovery?.code === REASON.provider_outcome_unknown,
        );
        recoveryPaths.push(worktree.path);
        cleanupNotices.push(handoffNotice(tracked, worktree.path));
      }
    }
    const carried = extras(cleanupNotices);
    return deadlineAuthorityLost
      ? runHalt({ runId, extras: carried })
      : artifactBlocked(runId, reasonCode, { runId }, carried);
  };
  if (storeAuthorityLost) return cleanupArtifactFailure(terminalArtifactPoison() ?? REASON.artifact_store_authority_lost);
  const candidateFinalFailures = laneResults.flatMap(({ finalFailure }) => finalFailure === null ? [] : [finalFailure]);
  for (const failure of candidateFinalFailures) affectedArtifactLanes.add(failure.laneId);
  const preFinalArtifactPoison = artifactStorePoison();
  if (preFinalArtifactPoison !== null) return cleanupArtifactFailure(terminalArtifactPoison() ?? preFinalArtifactPoison);
  if (candidateFinalFailures.length > 0) {
    candidateFinalFailures.sort((left, right) => {
      const lane = compareUtf8(left.laneId, right.laneId);
      return lane !== 0 ? lane : compareUtf8(left.phase, right.phase);
    });
    return cleanupArtifactFailure(storeAuthorityLost ? terminalArtifactPoison() : candidateFinalFailures[0].reason);
  }

  let selection = selectCandidates({ candidates, judgeDecisions: [] });
  let judgeNotices = [];
  let judgeFailure = null;
  if (selection.objectiveComparison?.result === 'tie') {
    const pairs = [
      makeBlindPair(candidates[0], candidates[1], { reverse: false }),
      makeBlindPair(alternateCandidates[0], alternateCandidates[1], { reverse: true }),
    ];
    if (pairs.some((pair) => pair === null)) {
      judgeFailure = REASON.judge_view_unavailable;
      const judgeDecisions = [1, 2].map((judgeIndex) => deepFreeze({
        status: 'invalid',
        judgeIndex,
        corrected: false,
        code: REASON.judge_view_unavailable,
      }));
      selection = selectCandidates({ candidates, judgeDecisions });
    } else {
      const judgesRoot = join(stateRoot, 'judges');
      /**
       * ★★ 판정이 잘렸을 때 **누가 껐는가**(최종 리뷰 M7). 아래 일곱 자리는 전부 접힌 신호
       *   (`deadline?.aborted`)로 「잘렸다」를 알아내는데, 그 신호는 마감과 호스트 취소가 하나로
       *   접힌 것이라(WS3 §0-C1) 스스로는 둘을 못 가른다. 사유의 유일한 권위는 신호 소스이고
       *   그것을 읽는 함수가 `haltReasonCode` 다 — 이 파일이 이미 `:236/:249/:256` 에서 쓰는 그것.
       * ★ `run_cancelled` 를 심판 슬롯에 그대로 실을 수는 없다: `JUDGE_CODES` 밖이라
       *   `projectJudge` 가 null 을 내고 `projectSelection` 이 던져 **본문이 모든 단에서 바닥으로
       *   무너진다**. 그래서 등재된 심판 전용 코드 하나를 쓴다.
       */
      const judgeHaltCode = () =>
        (haltReasonCode() === REASON.run_cancelled ? REASON.judge_cancelled : REASON.judge_deadline);
      const runJudge = async (judgeIndex) => {
        const pair = pairs[judgeIndex - 1];
        const provider = laneProviders[judgeIndex - 1].writer;
        const binding = judgeBindings[judgeIndex - 1];
        let scratch = null;
        let identity = null;
        let localFailure = null;
        const localNotices = [];
        let decision;
        try {
          await mkdir(judgesRoot, { recursive: true });
          const expectedJudgesRoot = resolve(stateRoot, 'judges');
          const canonicalJudgesRoot = await canonical(judgesRoot);
          if (canonicalJudgesRoot === null || relative(canonicalJudgesRoot, expectedJudgesRoot) !== '' ||
              relative(canonicalJudgesRoot, stateRoot) === '' || !pathContains(stateRoot, canonicalJudgesRoot)) {
            throw new Error('judge_scratch_root_untrusted');
          }
          scratch = await mkdtemp(join(judgesRoot, `${runId}-judge-${judgeIndex}-`));
          const returnedScratch = resolve(scratch);
          const [actual, stat, root] = await Promise.all([
            canonical(scratch), lstat(scratch, { bigint: true }), canonical(judgesRoot),
          ]);
          if (actual === null || root === null || relative(root, expectedJudgesRoot) !== '' ||
              relative(actual, returnedScratch) !== '' || !pathContains(root, actual) || actual === root ||
              stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('judge_scratch_identity_unavailable');
          scratch = actual;
          identity = { path: actual, dev: stat.dev, ino: stat.ino };
          let parsed;
          let corrected = false;
          try {
            const result = await callProvider({
              provider, binding, kind: 'judge', laneId: null, attemptId: null, judgeIndex,
              instruction: judgeInstruction(pair.promptInput), workspace: scratch, tools: undefined, nonWorktree: true,
            });
            if (deadline?.aborted === true || now() >= deadlineAt) {
              localFailure = judgeHaltCode();
              parsed = { ok: false, kind: 'invalid', code: localFailure };
            } else if (qualityWriterSettlement(result, provider.id).status !== 'sealed') {
              localFailure = result?.hardStopped === true || deadline?.aborted === true
                ? judgeHaltCode()
                : REASON.judge_provider_failure;
              parsed = { ok: false, kind: 'invalid', code: localFailure };
            } else {
              parsed = parseJudgeDecision(result?.content);
              if (parsed.ok !== true && deadline?.aborted !== true && now() < deadlineAt) {
                corrected = true;
                const correction = await callProvider({
                  provider, binding, kind: 'judge_format', laneId: null, attemptId: null, judgeIndex,
                  instruction: judgeInstruction(pair.promptInput, { formatOnly: true }), workspace: scratch,
                  tools: undefined, nonWorktree: true,
                });
                if (deadline?.aborted === true || now() >= deadlineAt) {
                  localFailure = judgeHaltCode();
                  parsed = { ok: false, kind: 'invalid', code: localFailure };
                } else if (qualityWriterSettlement(correction, provider.id).status !== 'sealed') {
                  localFailure = correction?.hardStopped === true || deadline?.aborted === true
                    ? judgeHaltCode()
                    : REASON.judge_provider_failure;
                  parsed = { ok: false, kind: 'invalid', code: localFailure };
                } else {
                  parsed = parseJudgeDecision(correction?.content);
                }
              } else if (parsed.ok !== true && (deadline?.aborted === true || now() >= deadlineAt)) {
                localFailure = judgeHaltCode();
                parsed = { ok: false, kind: 'invalid', code: localFailure };
              }
            }
          } catch (error) {
            localFailure = deadline?.aborted === true || now() >= deadlineAt
              ? judgeHaltCode()
              : REASON.judge_provider_failure;
            parsed = { ok: false, kind: 'invalid', code: localFailure };
          }
          decision = remapJudgeDecision(parsed, pair.mapping, { judgeIndex, corrected }) ??
            deepFreeze({ status: 'invalid', judgeIndex, corrected, code: REASON.judge_format_invalid });
        } catch {
          localFailure = deadline?.aborted === true || now() >= deadlineAt ? judgeHaltCode() : REASON.judge_scratch_failed;
          decision = deepFreeze({ status: 'invalid', judgeIndex, corrected: false, code: localFailure });
        } finally {
          if (scratch !== null && identity !== null) {
            let removed = false;
            const childrenProven = await killLiveChildren(identity.path);
            if (childrenProven) {
              try {
                const [actual, stat] = await Promise.all([canonical(scratch), lstat(scratch, { bigint: true })]);
                if (actual === identity.path && stat.dev === identity.dev && stat.ino === identity.ino &&
                    stat.isDirectory() && !stat.isSymbolicLink()) {
                  const result = await recoveryStage(`judge ${judgeIndex} scratch cleanup`, () =>
                    (deps.removeJudgeScratch ?? rm)(identity.path, { recursive: true, force: false }));
                  if (result?.hardStopped !== true) {
                    removed = await lstat(identity.path).then(() => false, (error) => error?.code === 'ENOENT');
                  }
                }
              } catch (error) {
                removed = error?.code === 'ENOENT';
              }
            }
            if (!removed) localNotices.push(renderNotice('scratch_manual_cleanup_required', { path: identity.path }));
          } else if (scratch !== null) {
            localNotices.push(renderNotice('scratch_manual_cleanup_required', { path: scratch }));
          }
        }
        return deepFreeze({ decision, failure: localFailure, notices: localNotices });
      };
      const judgeOutcomes = await Promise.all([runJudge(1), runJudge(2)]);
      judgeNotices = judgeOutcomes.flatMap((outcome) => outcome.notices);
      const judgeDecisions = judgeOutcomes.map((outcome) => outcome.decision);
      selection = selectCandidates({ candidates, judgeDecisions });
      // 잘린 판정은 어느 쪽이 하나라도 있으면 그 답이 이긴다 — 그리고 그 답은 이 실행의
      // 정지 사유와 같은 낱말이어야 한다(취소면 취소, 마감이면 마감).
      const halted = judgeOutcomes.find((outcome) =>
        outcome.failure === REASON.judge_deadline || outcome.failure === REASON.judge_cancelled);
      judgeFailure = halted !== undefined
        ? halted.failure
        : judgeOutcomes.find((outcome) => outcome.failure !== null)?.failure ?? null;
      if (selection.outcome === 'none' && judgeFailure === null) judgeFailure = REASON.judge_invalid;
    }
  }

  const usage = usageAccumulator.finalize();
  const usageCheckpoint = await checkpoint(artifactStore, {
    eventId: 'usage:run:final', type: 'usage_recorded', value: usage,
  });
  const selectionCheckpoint = isBlocked(usageCheckpoint) ? usageCheckpoint : await checkpoint(artifactStore, {
    eventId: 'selection:run:recorded', type: 'selection_recorded', value: selection,
  });
  if (isBlocked(usageCheckpoint) || isBlocked(selectionCheckpoint)) {
    for (const laneId of laneIds) affectedArtifactLanes.add(laneId);
    return cleanupArtifactFailure(REASON.artifact_selection_checkpoint_failed, judgeNotices);
  }

  const selectedIndex = selectedLaneIndex(selection);
  const selectedCandidate = selectedIndex < 0 ? null : candidates[selectedIndex];
  // ★ 잘린 판정은 마감이든 취소든 **실행이 멈춘 것**이다 — 그때의 봉투는 `runHalt` 가 짓고
  //   그 코드는 `haltReasonCode()` 가 정한다(여기서 이름을 다시 고르지 않는다).
  let terminalDeadline = judgeFailure === REASON.judge_deadline || judgeFailure === REASON.judge_cancelled ||
    selectedCandidate === null && (deadline?.aborted === true || candidates.some((candidate) => candidate.stopReason === REASON.run_deadline_exceeded));
  let winner = null;
  let aliasFailure = false;
  if (selectedCandidate !== null && !terminalDeadline) {
    const rawWinner = await recoveryStage('winner alias', () =>
      (deps.writeWinnerAlias ?? writeWinnerAlias)(artifactStore, { candidateId: selectedCandidate.candidateId }))
      .catch(() => {
        poisonArtifactStore(REASON.artifact_store_authority_lost, { authorityLost: true, laneId: selectedCandidate.candidateId });
        return fail(REASON.artifact_store_authority_lost);
      });
    const candidatePatchRef = selectedCandidate.patch?.ref;
    const settlement = classifyArtifactSettlement(rawWinner, {
      kind: 'writer',
      authority: {
        writer: {
          kind: 'winner', candidateId: selectedCandidate.candidateId,
          path: pathBudget.paths?.winnerAliasPath,
          bytes: candidatePatchRef?.bytes, sha256: candidatePatchRef?.sha256,
        },
        manifest: preparation.manifestAuthority,
      },
    });
    winner = settlement.kind === 'success' && !acceptArtifactRevision(settlement.result, preparation.artifactRevisionAuthority)
      ? unknownArtifactSettlement() : settlement.result;
    if (settlement.kind === 'success' && winner !== settlement.result) {
      poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId: selectedCandidate.candidateId,
      });
    }
    if (settlement.kind === 'unknown') {
      poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId: selectedCandidate.candidateId,
      });
    }
    if (artifactAuthorityLost(winner)) {
      poisonArtifactStore(reasonCodeOf(winner, REASON.artifact_store_authority_lost), {
        authorityLost: true,
        laneId: selectedCandidate.candidateId,
      });
    }
    if (winner?.hardStopped === true) {
      terminalDeadline = true;
    }
    const winnerRef = winner?.ref;
    if (isBlocked(winner) || winner?.ok !== true || winnerRef?.kind !== 'winner' ||
        winnerRef?.candidateId !== selectedCandidate.candidateId ||
        winnerRef?.path !== pathBudget.paths?.winnerAliasPath || winnerRef.path === candidatePatchRef?.path ||
        winnerRef?.sha256 !== candidatePatchRef?.sha256 || winnerRef?.bytes !== candidatePatchRef?.bytes ||
        !Number.isSafeInteger(winnerRef?.bytes) || winnerRef.bytes <= 0 ||
        !Number.isSafeInteger(winnerRef?.expiresAt) || winnerRef.expiresAt <= 0) {
      winner = null;
      aliasFailure = !terminalDeadline;
    }
    setLatestManifestRef(winner?.manifestRef);
  }
  collected.laneResults = laneResults;
  collected.candidates = candidates;
  collected.selection = selection;
  collected.winner = winner;
  collected.aliasFailure = aliasFailure;
  collected.judgeNotices = judgeNotices;
  collected.judgeFailure = judgeFailure;
  // 조립은 이 값을 **다시 읽지 않는다** — 심판 마감과 `winner.hardStopped` 가 여기에 접혀 있다.
  collected.gradeDeadline = terminalDeadline;
  collected.cleanupLanes = async () => {
    const cleanups = [];
    const cleanupNotices = [];
    for (let index = 0; index < laneWorktrees.length; index += 1) {
      const worktree = laneWorktrees[index];
      const candidate = candidates[index];
      const childrenProven = await killLiveChildren(worktree.path);
      const preserve = (aliasFailure || terminalDeadline && selectedCandidate !== null) && index === selectedIndex || candidate.recovery !== null ||
        isWorktreeEffectUnknown?.(worktree.path) === true;
      const removal = childrenProven === true && !preserve
        ? snapshotRemovalResult(await stage(`${laneIds[index]} authoring cleanup`, () =>
          (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null))
        : UNPROVEN_REMOVAL;
      const removed = removal.ok === true && removal.removed === true;
      const unregistered = removal.ok === true && removal.unregistered === true;
      let tracked = false;
      if (!removed || !unregistered) {
        tracked = await handoffWorktree(
          worktree.path,
          `${laneIds[index]} authoring cleanup handoff`,
          candidate.stopReason === REASON.provider_outcome_unknown ||
            candidate.recovery?.code === REASON.provider_outcome_unknown,
        );
        if (!tracked) cleanupNotices.push(handoffNotice(false, worktree.path));
      }
      const cleanup = { removed, unregistered, tracked };
      cleanups.push(cleanup);
      if ((removed && unregistered || tracked) && !storeAuthorityLost) {
        const logicalCleanupPath = `worktrees/${worktree.worktreeId ?? `${runId}-${laneIds[index]}`}`;
        let cleanupCheckpointThrew = false;
        const rawEvent = await stage(`cleanup manifest ${laneIds[index]}`, () => checkpointRaw(artifactStore, {
          eventId: `cleanup:authoring:${laneIds[index]}:000:${sha256(Buffer.from(logicalCleanupPath, 'utf8')).slice(0, 12)}`,
          type: 'cleanup_recorded',
          value: {
            kind: 'authoring',
            candidateId: laneIds[index],
            attemptId: null,
            path: worktree.path,
            status: removed && unregistered ? 'removed' : 'reaper_pending',
            recoveryPath: removed && unregistered ? null : worktree.path,
          },
        })).catch(() => {
          cleanupCheckpointThrew = true;
          return fail(REASON.artifact_manifest_checkpoint_failed);
        });
        const settlement = classifyArtifactSettlement(rawEvent, {
          kind: 'checkpoint', authority: preparation.manifestAuthority,
        });
        const event = settlement.result;
        if (settlement.kind === 'success' && !acceptArtifactRevision(event, preparation.artifactRevisionAuthority)) {
          storeAuthorityLost = true;
          cleanupNotices.push(renderNotice('cleanup_manifest_pending', {}));
          continue;
        }
        setLatestManifestRef(event?.manifestRef);
        if (cleanupCheckpointThrew || settlement.kind === 'unknown' || artifactAuthorityLost(event)) {
          storeAuthorityLost = true;
        }
        if (isBlocked(event)) cleanupNotices.push(renderNotice('cleanup_manifest_pending', {}));
      }
    }
    return {
      // 레인 여럿을 본문의 삼중값 하나로 접는 규칙은 호출부가 가진다(`buildRunBody` 의 WHY).
      cleanup: {
        removed: cleanups.every((value) => value.removed),
        unregistered: cleanups.every((value) => value.unregistered),
        tracked: cleanups.some((value) => value.tracked),
      },
      cleanupNotices,
      trackedPaths: laneWorktrees.flatMap((worktree, index) => cleanups[index].tracked ? [worktree.path] : []),
    };
  };
  return null;
}
