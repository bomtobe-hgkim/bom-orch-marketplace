/**
 * 실행의 **진행 채널** 하나와, 그 채널에 단계(step)를 싣는 유일한 자리인 **프로바이더 호출
 * 이음매** 하나. 사용자가 실행 중에 무언가를 보는 경로는 이 둘뿐이다.
 *
 * WS8 컷 2 가 `src/engine.mjs` 의 `prepareRunNamespace` 에서 뽑았다(로드맵 §3.11).
 *
 * ★★ **왜 이 둘이 한 파일인가.** `progress` 는 잎이지만 혼자 있는 잎이 아니다 — 단계 수준의
 *   이벤트를 내는 자리는 `callProvider` 하나뿐이고, 둘은 `runFacts`(runId·budget·candidates)
 *   라는 **같은 세 값**을 싣는다. 그 셋이 갈리면 같은 실행이 채널마다 다른 이름과 다른 진척을
 *   말한다. **새 진행 이벤트는 이 파일로 들어간다.**
 *
 * ★ `runOptions` 를 통째로 받는 이유: 콜백은 `runOptions.onProgress` 를 **부를 때마다** 읽는다.
 *   생성 시점에 함수를 붙잡아 두면 뒤에 바뀐 콜백을 못 본다 — 옮기기 전과 같은 읽기다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지).
 */

/**
 * 진행 보고자 하나. `runFacts` 는 실행 전체를 두고 안 변하는 셋이고, `progress` 는 그것을
 * 모든 이벤트에 싣는다. 콜백이 던져도 실행은 계속된다(진행 보고는 권고다).
 */
export function createProgressReporter({ runId, budget, candidateCount, runOptions }) {
  // ★★ 실행 전체를 두고 안 변하는 셋(`runId`·`budget`·`candidates`)이 **모든** 진행
  //   이벤트에 실린다(WS3 §0-P1). 알림을 만드는 자리(`src/tools.mjs`)는 요청 하나만 알고
  //   실행은 모른다 — 그래서 그 셋을 거기서 지어낼 수 없다. runId 가 첫 알림부터 필요한
  //   이유는 봉투를 잃은 사용자가 `run_id` 를 되찾는 경로가 이 채널이기 때문이고,
  //   budget·candidates 는 `attempt=<k>/<budget>` 과 `total` 추정기의 두 인자다.
  const runFacts = { runId, budget, candidates: candidateCount };
  const progress = (phase, step = 0, identity = {}) => {
    try {
      runOptions.onProgress?.(candidateCount === 1
        ? { phase, step, ...runFacts, event: { type: 'phase', phase } }
        : { phase, step, ...identity, ...runFacts, event: { type: 'phase', phase, ...identity } });
    } catch { /* advisory */ }
  };
  return { runFacts, progress };
}

/**
 * 프로바이더 호출 **한 자리**. 데드라인 선검사 · 사용량 티켓 · 진행 이벤트 · spawn 로그 ·
 * 워크트리 권위(`mayTouchWorktree`) · 결함 장부 기록이 전부 여기 한 함수에 있다 — 준비 단계의
 * 플래너 호출도, 레인의 워커·검증자·심판 호출도 같은 함수를 지난다.
 */
export function createProviderCall({
  runFacts, progress, runOptions, candidateCount, runId, deadline, deadlineAt, now,
  stage, logLine, onSpawn, usageAccumulator, recordProviderOutcome,
}) {
  return async ({ provider, binding, kind, laneId, attemptId, judgeIndex = null, instruction, workspace, tools, nonWorktree = false }) => {
    if (deadline?.aborted === true || now() >= deadlineAt) {
      const error = new Error('deadline_expired');
      error.preBoundary = true;
      throw error;
    }
    const ticket = usageAccumulator.start({ vendor: provider.id, kind, laneId, attemptId, judgeIndex });
    const phase = kind === 'verifier_format' ? 'verifier' : kind === 'judge_format' ? 'judge' : kind === 'writer' ? 'worker' : kind;
    const step = attemptId === null ? judgeIndex ?? 0 : Number(attemptId.slice(-3));
    progress(phase, step, {
      laneId,
      attemptId,
      role: binding.role,
      judgeIndex,
    });
    let result;
    // ★ 로그에 남는 것은 **무엇으로 띄웠는가** 뿐이다 — 모델·effort·도구 이름. 지시문(프롬프트)은
    //   모델 산문이므로 로그에도 들어가지 않는다(불변식 4는 봉투만이 아니라 이 채널에도 걸린다).
    logLine('info', null, 'provider spawn', {
      vendor: provider.id, kind, role: binding.role, model: binding.model ?? '', effort: binding.effort ?? '',
      laneId: laneId ?? '', attemptId: attemptId ?? '', tools: Array.isArray(tools) ? tools.join(',') : '',
    });
    // ★ settle 줄의 재료(2026-09-05 감사). 벤더 스트림 이벤트가 마지막으로 온 시각을 여기서 잰다 —
    //   이 이음매가 모든 벤더 호출의 onProgress 를 지나므로 프로바이더는 아무것도 더 낼 필요가 없다.
    const spawnedAt = now();
    let lastEventAt = spawnedAt;
    let events = 0;
    let spawnedChild = false;
    let threw = true;
    try {
      result = await stage(`${kind} provider`, () => provider.run({
        role: binding.role, model: binding.model, effort: binding.effort, instruction, workspace,
        tools, allowedTools: tools, signal: deadline,
        onSpawn: (child) => {
          spawnedChild = true;
          return onSpawn(child, {
            late: deadline?.aborted === true,
            planner: kind === 'planner' || nonWorktree,
            worktreePath: nonWorktree ? null : workspace,
            ownerWorktreePath: workspace,
            laneId,
            attemptId,
            role: binding.role,
            judgeIndex,
            reportIdentity: candidateCount === 2,
          });
        },
        // ★★ 접힌 `phase` 를 **양쪽 갈래에** 쓴다. 예전에는 후보가 하나일 때만 날 `kind` 가
        //   올라가서 같은 단계가 `writer`·`verifier_format`·`judge_format` 이라는 다른 이름으로
        //   보였다 — `candidates` 값이 사용자가 읽는 단어를 바꾸는 결함이다(WS0 §4).
        onProgress: (event) => {
          events += 1;
          lastEventAt = now();
          if (deadline?.aborted !== true) {
            try {
              runOptions.onProgress?.(candidateCount === 1
                ? { phase, step, ...runFacts, event }
                : { phase, step, laneId, attemptId, role: binding.role, judgeIndex, ...runFacts, event });
            } catch { /* advisory */ }
          }
        },
        runId,
      }), { mayTouchWorktree: !nonWorktree && kind !== 'planner', worktreePath: workspace });
      threw = false;
      recordProviderOutcome(provider.id, kind, laneId, result);
      if (result?.hardStopped === true) throw new Error('provider_effect_unknown');
      return result;
    } finally {
      usageAccumulator.settle(ticket, { promptTokens: result?.promptTokens ?? null, evalTokens: result?.evalTokens ?? null });
      // ★ spawn 마다 settle 한 줄. 실행이 마감으로 끝났을 때 벤더가 **침묵하다** 잘렸는지(quietMs ≈ elapsedMs)
      //   **출력하다** 잘렸는지를 가르는 유일한 기록이다 — 그 둘을 가를 데이터가 그전엔 아무 데도 없었다.
      //   `spawned` 는 events 0 이 「침묵」인지 「자식이 못 뜸」인지를, `hung` 은 끊은 뒤 파이프가 안 닫혔는지를
      //   가른다. `threw` 는 호출이 값을 못 돌려줬다는 관측이고, 하드스톱의 자체 throw 는 `hardStopped` 다.
      //   잘렸거나 던졌으면 warn — `orch_status` 의 기본 로그 꼬리는 warn+error 만 싣는다(src/run-read.mjs).
      //   평평한 값만: null 은 빈 문자열로, 시계가 뒤로 가도 음수는 안 나간다.
      const settledAt = now();
      const cut = threw || result?.hardStopped === true || result?.truncated === true;
      logLine(cut ? 'warn' : 'info', null, 'provider settle', {
        vendor: provider.id, kind, role: binding.role, laneId: laneId ?? '', attemptId: attemptId ?? '',
        elapsedMs: Math.max(0, settledAt - spawnedAt), quietMs: Math.max(0, settledAt - lastEventAt), events, spawned: spawnedChild,
        doneReason: typeof result?.doneReason === 'string' ? result.doneReason : '',
        truncated: result?.truncated === true, hardStopped: result?.hardStopped === true, hung: result?.hung === true, threw,
      });
    }
  };
}
