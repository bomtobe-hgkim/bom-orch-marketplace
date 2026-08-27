/**
 * 플래너 단계 하나 — **스크래치 디렉터리의 신원 증명**, 플래너 호출, 그리고 저장소가 생긴 뒤의
 * **계획 정본 기록**. 셋이 한 파일인 이유는 회수(reclaim) 규칙이 하나이기 때문이다: 스크래치를
 * 지우는 판정은 `finally` 와 정본이 착지한 뒤의 두 번째 시도가 **같은 함수**를 부른다.
 *
 * WS8 컷 2 가 `src/engine.mjs` 의 `prepareRunNamespace` 에서 뽑았다(로드맵 §3.11).
 *
 * ★★ **왜 별도 모듈인가.** 이 단계는 실행이 **크레딧을 처음 쓰는 자리**이고, 동시에 상태 루트
 *   밑에 임시 디렉터리를 만드는 유일한 준비 단계다. 그 둘의 규율(신원 증명 없이는 아무것도
 *   지우지 않는다 · 못 지웠으면 그 사실을 알림으로 낸다 · 정본이 착지하면 그 알림을 거둔다)이
 *   한 파일에 있어야 다음 사람이 회수 자리를 하나 더 만들지 않는다. **새 플래너 코드는 이
 *   파일로 들어간다.**
 *
 * ★ `plannerNotices` 는 **배열 그대로** 오간다. 종료 봉투 전부가 나르는 채널은
 *   `src/run-finalization.mjs` 의 `baseNotices` 가 읽는 그 배열 하나이고, 여기서 새 채널을
 *   만들면 준비 단계가 말한 것과 종료가 말하는 것이 갈린다.
 *
 * ★ `pathContains` 는 **복사**다 — `src/run-finalization.mjs` 가 심판 스크래치 루트에 대해
 *   같은 판정을 같은 이유로 이미 복사해 두었고(그 파일 머리말의 「반대로 …는 복사했다」),
 *   이 파일이 그것을 쓰는 자리도 같은 종류의 검사(스크래치 루트가 상태 루트 밑인가)다.
 *   한 줄짜리 순수 술어를 import 로 나르면 이 파일이 엔진에게 조각 배달부가 된다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지).
 */
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
// 벤더 지시문은 `src/prompts/**` 에 산다 — 저장소에서 한국어가 남는 유일한 src 경로(로드맵 §5.8).
import { EXCERPT_CHARS, plannerInstruction } from './prompts/instructions.mjs';
import { canonical } from './real-path.mjs';
import { REASON } from './reason-codes.mjs';
import { renderNotice } from './reason-text.mjs';
import { writePlanArtifact } from './run-artifacts.mjs';
import { providerFault } from './run-faults.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { contained } from './util/paths.mjs';
import { clipCounted, clipWhole } from './util/strings.mjs';

/** 공유 `contained` 에 **같은 경로**를 더한 판. `src/engine.mjs`·`src/run-finalization.mjs` 와 같다. */
function pathContains(parent, child) {
  return relative(parent, child) === '' || contained(parent, child);
}

/**
 * 플래너를 한 번 부른다. **절대 throw 하지 않는다** — 플래너가 실패하면 계획은 과제 원문으로
 * 되돌아가고(`plannedByModel: false`) 실행은 계속된다.
 */
export async function runPlannerPhase({
  task, runId, stateRoot, frozenTestPlan, plannerProvider, plannerBinding, plannerEvidence,
  configNotices, provisionNotices, deps, recoveryStage, logLine, killLiveChildren, callProvider,
}) {
  const plansRoot = join(stateRoot, 'plans');
  let planDir = null;
  let planDirIdentity = null;
  // 계획 파생의 알림이 여기서 합류한다. 종료 봉투 **전부**가 나르는 채널은 이 배열 하나이고
  // (`run-finalization.mjs` 의 `baseNotices`), 이 아래의 이른 halt 들도 같은 배열을 편다.
  // 준비 단계가 쌓은 알림 둘이 여기서 합류한다 — 설정 파생(태스크 4)과 의존성 제공(태스크 5).
  // 새 채널을 만들지 않는다: 종료 봉투 전부가 나르는 배열은 `run-finalization.mjs` 의
  // `baseNotices` 가 읽는 이 하나뿐이다.
  const plannerNotices = [...configNotices, ...provisionNotices];
  let plannerUsage = deepFreeze({ calls: 0, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: false });
  let plannerProviderEntered = false;
  let plan = task;
  // ★ 본문의 `plan` 은 **모델이 실제로 낸 계획일 때만** 실린다. `plan` 변수는 플래너가
  //   실패하면 과제 원문으로 되돌아가므로, 그 한 비트를 안 들고 있으면 봉투가 과제 텍스트를
  //   "플래너가 낸 계획" 이라고 말하게 된다(WS2 §0 결정표 「plan.content」).
  let plannedByModel = false;
  // ★★ 스크래치 회수의 규칙은 **한 자리**다. 아래 `finally` 와, 정본이 착지한 뒤의 두 번째 시도가
  //   같은 함수를 부른다 — 두 벌이면 그 차이가 곧 다음 결함이고, 이 저장소는 경로·신원 비교에서
  //   이미 그 결함을 여러 번 냈다. 판정 재료는 옮기기 전과 한 글자도 다르지 않다: 살아 있는
  //   자식이 증명돼 죽었고, 그 디렉터리가 **우리가 만든 그것**(canonical 경로 + dev/ino)이며,
  //   회수가 하드스톱되지 않았고, 지운 뒤 실제로 없어야 참이다.
  const reclaimPlannerScratch = async () => {
    if (planDir === null || planDirIdentity === null) return false;
    if (!await killLiveChildren(planDirIdentity.path)) return false;
    try {
      const [actual, current] = await Promise.all([canonical(planDir), lstat(planDir, { bigint: true })]);
      if (actual === null || relative(actual, planDirIdentity.path) !== '' || current.dev !== planDirIdentity.dev ||
          current.ino !== planDirIdentity.ino || !current.isDirectory() || current.isSymbolicLink()) return false;
      const removal = await recoveryStage('planner scratch cleanup', () =>
        (deps.removePlannerScratch ?? rm)(planDirIdentity.path, { recursive: true, force: false }));
      if (removal?.hardStopped === true) return false;
      return await lstat(planDirIdentity.path).then(() => false, (error) => error?.code === 'ENOENT');
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  };
  // 회수가 실패했을 때 알림 배열에 실린 그 문장. 정본이 착지한 뒤 두 번째 시도가 성공하면 이
  // 문장을 **거둔다** — 남아 있지 않은 디렉터리를 「손으로 치우라」고 말하면 그것이 오보다.
  let scratchPendingNotice = null;
  try {
    const plannedRoot = await canonical(plansRoot);
    const expectedPlansRoot = resolve(stateRoot, 'plans');
    if (plannedRoot === null || relative(plannedRoot, expectedPlansRoot) !== '' || relative(plannedRoot, stateRoot) === '' ||
        !pathContains(stateRoot, plannedRoot)) throw new Error('planner_scratch_root_untrusted');
    await mkdir(plansRoot, { recursive: true });
    planDir = await mkdtemp(join(plansRoot, `${runId}-planner-`));
    const returnedPlanDir = resolve(planDir);
    const [canonicalPlanDir, planStat] = await Promise.all([canonical(planDir), lstat(planDir, { bigint: true })]);
    const canonicalPlansRoot = await canonical(plansRoot);
    if (canonicalPlanDir === null || canonicalPlansRoot === null || relative(canonicalPlansRoot, expectedPlansRoot) !== '' || !pathContains(stateRoot, canonicalPlansRoot) ||
        !planStat.isDirectory() || planStat.isSymbolicLink() || relative(canonicalPlanDir, returnedPlanDir) !== '' ||
        relative(canonicalPlansRoot, canonicalPlanDir) === '' || !pathContains(canonicalPlansRoot, canonicalPlanDir)) {
      throw new Error('planner_scratch_identity_unavailable');
    }
    planDir = canonicalPlanDir;
    planDirIdentity = { path: canonicalPlanDir, dev: planStat.dev, ino: planStat.ino };
    plannerProviderEntered = true;
    const planner = await callProvider({
      provider: plannerProvider, binding: plannerBinding, kind: 'planner', laneId: null, attemptId: null,
      instruction: plannerInstruction({ task, testPlan: frozenTestPlan, evidence: plannerEvidence }),
      workspace: planDir, tools: undefined,
    });
    plannerUsage = deepFreeze({
      calls: 1,
      promptTokensKnown: Number.isSafeInteger(planner?.promptTokens) && planner.promptTokens >= 0 ? planner.promptTokens : 0,
      evalTokensKnown: Number.isSafeInteger(planner?.evalTokens) && planner.evalTokens >= 0 ? planner.evalTokens : 0,
      incomplete: !Number.isSafeInteger(planner?.promptTokens) || planner.promptTokens < 0 || !Number.isSafeInteger(planner?.evalTokens) || planner.evalTokens < 0,
    });
    const plannerFault = providerFault(planner, plannerProvider.id);
    const partial = typeof planner?.content === 'string' && planner.content !== ''
      ? clipCounted(planner.content, EXCERPT_CHARS)
      : null;
    if (plannerFault === null) {
      if (partial !== null) {
        plan = partial;
        plannedByModel = true;
      }
    } else if (partial !== null && plannerFault.reasonCode === REASON.provider_deadline_exceeded) {
      // ★★ 우리 데드라인이 플래너를 끊었고 **부분 계획은 이미 손에 있다**. 그것을 버리고 원문
      //   과제 텍스트로 돌아가면 실행은 더 나빠진다: 반쯤 쓰인 계획도 계획이고, 원문은 계획이
      //   아니다. Task 6 이 우리 자신의 데드라인 킬을 `providerFailed` 로 세기 시작하면서
      //   이 자리가 조용히 부분 계획을 버리기 시작했다(그 전에는 실패가 아니어서 남았다).
      //   버리는 쪽을 고르려면 "부분 계획이 원문보다 나쁘다" 를 증명해야 하는데 그런 증거는 없다.
      // ★ 알림만 붙이고 이 대입을 빠뜨리면 봉투는 "부분 계획을 썼다" 고 말하면서 워커에게는 과제
      //   원문을 준다 — 알림이 아니라 오보가 된다. 둘은 반드시 같은 자리에서 정해진다.
      plan = partial;
      plannedByModel = true;
      plannerNotices.push(renderNotice('planner_partial_kept', {}));
    } else {
      plannerNotices.push(renderNotice('planner_failed_task_used', {}));
    }
    if (plannerFault !== null) {
      logLine('warn', plannerFault.reasonCode, 'planner', {
        vendor: plannerProvider.id, catalogKey: plannerFault.catalogKey ?? '',
        exitCode: plannerFault.exitCode ?? '', partialKept: partial !== null && plannerFault.reasonCode === REASON.provider_deadline_exceeded,
      });
    }
  } catch (error) {
    if (plannerUsage.calls === 0 && plannerProviderEntered && error?.preBoundary !== true) {
      plannerUsage = deepFreeze({ calls: 1, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: true });
    }
    plan = task;
    plannedByModel = false;
    if (planDir !== null && planDirIdentity === null) plannerNotices.push(renderNotice('planner_scratch_identity_unproven', {}));
    plannerNotices.push(renderNotice('planner_failed_task_used', {}));
  } finally {
    // ★ 회수는 **여기** 남는다(정본 착지 뒤가 아니라). 이 아래에는 저장소가 생기기 전에 끝나는
    //   halt 가 여럿이고, 회수를 그쪽으로 옮기면 그 경로들이 전부 스크래치를 흘린다.
    if (planDir !== null && !await reclaimPlannerScratch()) {
      scratchPendingNotice = renderNotice('planner_scratch_cleanup_pending', { path: planDir });
      plannerNotices.push(scratchPendingNotice);
    }
  }
  return { plan, plannedByModel, plannerUsage, plannerNotices, scratchPendingNotice, reclaimPlannerScratch };
}

/**
 * 계획 정본을 산출물 저장소에 적는다 — 저장소가 있는 **가장 이른 줄**이고, 레인이 하나라도
 * 돌기 전이다. 실패해도 실행은 계속된다(잃는 것은 되읽기뿐이고 그 사실은 알림으로 나간다).
 */
export async function recordPlannerCanon({
  plan, plannedByModel, plannerNotices, scratchPendingNotice, reclaimPlannerScratch,
  artifactStore, runId, deps, recoveryStage, logLine,
}) {
  // ★★ **플래너 정본은 저장소가 생긴 뒤에 기록한다**(스펙 §0-PL). 텍스트는 위에서 이미 메모리에
  //   있으므로 저장소 생성을 플래너 앞으로 당길 이유가 없고, 당기면 계획을 내기도 전에 끝나는
  //   실행까지 실행 디렉터리와 매니페스트를 남긴다. 그래서 이 자리가 「저장소가 있는 가장 이른
  //   줄」이다 — 권위 확인 바로 다음, 레인이 하나라도 돌기 전.
  // ★★ **모델이 낸 계획일 때만 쓴다.** `plan` 은 플래너가 실패하면 **과제 원문**으로 되돌아가고
  //   (`plannedByModel` 이 그 한 비트다) 사용자의 과제 텍스트는 모델 산문이 아니다. 그것을
  //   `source:'model'` 이 박힌 기록에 실으면 라벨이 거짓이 되고, `orch_status` 의 불변식 4 카나리는
  //   그 거짓 위에서 초록이 된다 — 라벨이 값의 성질이라는 규칙이 그 자리에서 무너진다.
  // ★ 실패해도 실행은 계속된다. 계획은 이미 워커·검증자의 프롬프트에 실려 있고, 잃는 것은
  //   **되읽기**뿐이다. 그 사실은 알림으로 나간다 — 조용히 잃지 않는다.
  // ★★ **정산 규율(`classifyArtifactSettlement` + `acceptArtifactRevision`)을 안 태우는 유일한
  //   저장소 쓰기다**, 그리고 그 면제의 근거는 셋이다(수정 라운드 m7):
  //   ① 이 자리는 결과를 **버린다** — `ref`·`revision`·`manifestRef` 중 어느 것도 아래로 흐르지
  //      않고, 답이 필요한 것은 「적혔나」 한 비트뿐이다. 정산기가 지키는 것은 흘러가는 값의
  //      신원(모르는 셰이프를 성공으로 읽지 않는 것)이라, 값이 안 흐르면 지킬 것도 없다.
  //   ② 권위(`revisionZeroAuthority`)는 이 쓰기 **전에** 이미 스냅샷돼 있다 — 엔진이 저장소
  //      권위를 `snapshotStoreArtifactAuthority` 로 얼린 그 한 줄이고, 사는 것은 거리가 아니라
  //      **순서**다: 낡음이 생기려면 스냅샷이 쓰기보다 늦어야 하는데 여기서는 그 반대다.
  //   ③ 개정 장부는 아직 열리지도 않았다: `artifactRevisionAuthority` 는 아래에서 `{latest:0}`
  //      으로 **새로** 만들어지고, 레인의 첫 쓰기는 그 0 위에서 판정된다. 이 쓰기가 남긴 개정을
  //      장부에 안 실어도 첫 레인 쓰기는 영향을 안 받는다(0 보다 큰 값이면 언제나 받아들여진다).
  //   → 그래서 손으로 적은 `recorded === null || recorded.blocked === true` 로 충분하다. 결과가
  //     아래로 흐르기 시작하는 날, 이 셋 중 ①이 먼저 무너진다 — 그때 이 자리는 정산기로 간다.
  if (plannedByModel) {
    // ★★ **놓이는 문자열이 기록의 상한 안이어야 한다** — 그것이 길이 계약의 유일한 철자다
    //   (`src/run-records.mjs MAX_PLAN_CONTENT_CHARS`). `plan` 은 프롬프트에 실린 발췌이고,
    //   `clipCounted` 는 예산 **뒤에** 꼬리표(`… (+N more)`)를 얹으므로 그 값은 예산보다 길다
    //   (실측: 4,000자 응답 → 1,214자). 그대로 넘기면 기록이 통째로 거절돼 이 실행은 정본을
    //   잃는다. 자르는 함수가 `clipWhole` 인 이유는 `src/candidate-lane.mjs` 의 issue claim 과
    //   같다: 계획은 모델 산문이라 이모지가 오고, 상한이 서로게이트 쌍 한가운데 떨어지면
    //   남은 반쪽을 기록 정규화기가 거절한다. `- 1` 은 그 함수가 붙이는 말줄임표 한 글자다.
    const canon = plan.length <= EXCERPT_CHARS ? plan : clipWhole(plan, EXCERPT_CHARS - 1);
    const recorded = await recoveryStage('planner canon artifact', () =>
      (deps.writePlanArtifact ?? writePlanArtifact)(artifactStore, {
        record: { schemaVersion: 1, runId, source: 'model', content: canon },
      })).catch(() => null);
    if (recorded === null || recorded.blocked === true) {
      plannerNotices.push(renderNotice('planner_canon_unrecorded', {}));
      logLine('warn', recorded?.reasonCode ?? REASON.artifact_plan_record_invalid, 'planner_canon', {
        runId, chars: canon.length,
      });
    } else if (scratchPendingNotice !== null && await reclaimPlannerScratch()) {
      // ★ 정본이 착지했으니 스크래치에는 남은 값이 없다 — 첫 회수가 실패했다면(예: 방금까지
      //   살아 있던 플래너 자식) 여기서 한 번 더 시도하고, 성공하면 「손으로 치우라」는 문장을
      //   거둔다. 그래도 남으면 그 문장은 그대로 나가고 리퍼의 `sweepPlans` 가 나이로 회수한다.
      // ★ 문장을 **배열에서** 빼는 것이 이 갈래의 유일한 효과다. `scratchPendingNotice` 는 이
      //   호출의 인자라 다시 대입해도 부르는 쪽에 닿지 않고, 그 값을 뒤에서 읽는 자리도 없다.
      plannerNotices.splice(plannerNotices.indexOf(scratchPendingNotice), 1);
    }
  }
}
