// src/tools/context.mjs
/**
 * `orch_run`·`orch_prove`·`orch_models`·`orch_config`·`orch_stats`·`orch_reward` 여섯 핸들러가 공유하는
 * 배선 — `context` 를 엔진 의존성으로 옮기는 자리 하나(`toEngineDeps`/`toEngineOptions`)와,
 * 최근 실행·정정 대상 실행이 남긴 artifact ref 를 실측하는 자리 하나(`inspectJournalArtifacts`).
 *
 * ★ 이 모듈이 따로 있는 이유(WS2 Task 16, tools.mjs 를 <=1,459 로 되돌리는 분리): `orch_reward`
 *   가 `src/tools/reward.mjs` 로 나가면서도 이 둘을 여전히 필요로 한다. `tools.mjs` 가
 *   `reward.mjs` 를 부르고 `reward.mjs` 가 `tools.mjs` 를 다시 부르면 순환이 생기므로, 두
 *   핸들러가 공유하는 조각만 셋째 자리로 올려 `tools.mjs → context.mjs ← reward.mjs` 인
 *   비순환 모양으로 둔다(`src/run-artifacts.mjs` 가 `run-manifest.mjs` 를 안 무는 것과 같은 규율).
 */
import { inspectArtifactRefs } from '../run-inspect.mjs';

/**
 * `context` 의 어느 필드가 엔진의 어디로 가는가 — 여섯 핸들러가 같은 계약을 쓴다.
 *
 * ★ 왜 한자리에 모으는가(실측): 예전에는 `orch_run` 이 `stateRoot` 를 **최상위 옵션**으로
 *   넘겼는데 엔진은 `deps.stateRoot` 만 읽었다. 그래서 `callTool(name, args, { stateRoot })`
 *   로 부르면 워크트리·patches·plans 가 그 디렉터리가 아니라 개발자의 실제 상태 루트에
 *   생겼다(테스트가 실제로 홈을 오염시켰다). `providers` 는 중계 자체가 없어서, 가짜
 *   프로바이더를 주입해도 진짜 레지스트리의 claude 가 떴다. 같은 `context` 를 받는
 *   `orch_models` 는 두 필드를 정상 존중했다 — 두 핸들러가 같은 필드를 다르게 해석했다.
 *
 * 우선순위: 호출자가 `context.deps` 에 직접 적은 값이 이긴다. 그쪽이 더 구체적인 채널이다.
 */
export function toEngineDeps(context) {
  const deps = context?.deps && typeof context.deps === 'object' ? context.deps : {};
  const shorthand = {};
  if (typeof context?.stateRoot === 'string' && context.stateRoot !== '') shorthand.stateRoot = context.stateRoot;
  if (Array.isArray(context?.providers)) shorthand.providers = context.providers;
  return { ...shorthand, ...deps };
}

/**
 * 검증을 통과한 `orch_run` 인자를 엔진 옵션으로 옮긴다.
 *
 * ★ 이름이 다른 이유: MCP 인자는 설계 §8.2 의 snake_case(`wait_ms`·`allow_single`)이고
 *   엔진은 camelCase(`waitMs`·`allowSingle`)다. 옮기는 자리를 하나로 두어 어느 쪽을
 *   바꿔도 여기만 보면 된다.
 *
 * `onProgress` 는 호스트가 `context` 로 준다(`src/server.mjs` 가 진행 토큰이 있을 때만
 * 만든다) — 중계하지 않으면 조용한 긴 스텝에서 호스트의 유휴 타이머가 먼저 끊는다(§6).
 *
 * ★ **내보내는 이유**: `allow_single` 은 계획 3 태스크 6 시점에 엔진 안에 소비자가 없다
 *   (밴딧 배선은 태스크 8 이다). 그래서 완주 테스트로는 이 배선을 잴 수 없고 — 매핑을
 *   통째로 지워도 봉투가 똑같다 — 이 함수를 직접 부르는 것이 재는 유일한 길이다.
 *   `envelope.mjs` 가 `validateArgs` 를 순수 함수로 두는 것과 같은 이유다.
 */
export function toEngineOptions(value, context) {
  return {
    task: value.task,
    projectPath: value.project,
    isolation: value.isolation,
    budget: value.budget,
    waitMs: value.wait_ms,
    candidateCount: value.candidates,
    writer: value.writer,
    // ☞ 태스크 8 이 읽는다: `decide({ allowed: { single: options.allowSingle === true } })`.
    allowSingle: value.allow_single === true,
    // ★ 오너 결정 B(2026-08-31). `classifyProofRequirement` 가 보는 유일한 입력이라 그대로
    //   흘려보낸다 — 여기서 `=== true`/`=== false` 로 좁히면 그 좁힘 규칙이 분류기의 fail-closed
    //   규칙과 두 자리에서 따로 살게 된다. `validateArgs` 를 지난 값은 이미 boolean 이다.
    requireProof: value.require_proof,
    // 재개(WS3 §0-R1). 인자가 없으면 `undefined` 여야 한다 — 엔진의 화이트리스트에서 「재개하지
    // 않음」은 키의 부재이고, `null` 이나 `''` 을 흘려보내면 그것이 이름으로 취급된다.
    resumeRunId: value.resume_run_id,
    // 허용목록(WS5 T2). 엔진은 이것을 프로젝트 설정의 `scope.allow` 와 합집합으로 접는다 —
    // 접는 자리가 엔진인 이유는 설정을 읽는 자리가 거기 하나이기 때문이다(`frozenTestPlanConfig`).
    scopeAllow: value.scope_allow,
    onProgress: typeof context?.onProgress === 'function' ? context.onProgress : undefined,
    // ★ 호스트 취소 신호(WS3 §0-C1). `src/server.mjs` 가 세 경로(요청 취소·SIGTERM·전송 종료)를
    //   AbortController 하나로 접어 `context` 로 준다. 여기서 중계하지 않으면 엔진의 화이트리스트가
    //   볼 것이 아예 없다 — `onProgress` 가 없을 때 진행 알림이 사라지는 것과 같은 자리다.
    //   ★ 모양이 아닌 값은 여기서 떨어뜨린다: 엔진은 이 키를 **검증**하므로 흘려보내면 호스트
    //     배선의 결함이 호출자의 `invalid` 봉투로 나간다(고칠 수 없는 것을 시키는 문구가 된다).
    //   ★ `instanceof` 가 아니라 엔진과 **같은 오리 검사**다(리뷰 소견): cross-realm/vm 에서 온
    //     진짜 신호는 instanceof 에 떨어져 조용히 사라지는데, 엔진의 검증은 그 신호를 받는다 —
    //     두 검사가 갈리면 한쪽만 아는 값이 생긴다.
    hostSignal: context?.hostSignal !== null && typeof context?.hostSignal === 'object' &&
      typeof context.hostSignal.aborted === 'boolean' && typeof context.hostSignal.addEventListener === 'function'
      ? context.hostSignal : undefined,
    deps: toEngineDeps(context),
  };
}

/**
 * 검증을 통과한 `orch_prove` 인자를 증명 단계의 옵션으로 옮긴다.
 *
 * ★ 왜 `toEngineOptions` 옆에 있고 그것을 재사용하지 않는가: 두 도구가 공유하는 것은 **호스트
 *   배선 둘**(`onProgress`·`hostSignal`)과 `deps` 뿐이고, 나머지 열 개 키는 증명에 아무 뜻이
 *   없다. 재사용하면 `task: undefined`·`budget: undefined` 를 들고 증명 단계로 가고, 그러면
 *   화이트리스트를 가진 쪽이 「호출자가 준 적 없는 키」를 검증하게 된다.
 *
 * ★ `hostSignal` 의 오리 검사는 `toEngineOptions` 와 **글자까지 같다**(cross-realm/vm 에서 온
 *   진짜 신호는 `instanceof` 에 떨어져 조용히 사라진다). 두 검사가 갈리면 같은 호스트 취소가
 *   도구마다 다르게 도착한다.
 *
 * ★ 2026-08-28 실측: 실행 9 는 55분 상한에 잘렸다. 증명이 자기 호출을 갖게 된 지금 `wait_ms`
 *   는 **그 호출 하나의** 마감이고, 이 자리가 그것을 나르는 유일한 이음매다.
 */
export function toProveOptions(value, context) {
  return {
    runId: value.run_id,
    waitMs: value.wait_ms,
    onProgress: typeof context?.onProgress === 'function' ? context.onProgress : undefined,
    hostSignal: context?.hostSignal !== null && typeof context?.hostSignal === 'object' &&
      typeof context.hostSignal.aborted === 'boolean' && typeof context.hostSignal.addEventListener === 'function'
      ? context.hostSignal : undefined,
    deps: toEngineDeps(context),
  };
}

/**
 * 한 응답에서 실제로 열어 보는 artifact ref 수의 상한.
 *
 * ★ 상한이 필요한 이유: `inspectArtifactRefs` 는 파일을 열고 **해시까지** 다시 계산한다
 *   (`expired` 가 "바이트가 여전히 그 ref 다" 를 포함하기 때문이다). 최근 목록은 최대 50건
 *   이고 실행 하나가 최대 네 개(manifest·후보 둘·winner)를 남기므로, 상한이 없으면 통계
 *   한 번이 패치 200개를 해시한다. 40 은 최근 10건 남짓을 덮는 값이다.
 *
 * ★ 넘치면 **조용히 자르지 않는다** — 확인하지 않은 실행 수를 notice 로 말한다.
 */
export const MAX_INSPECTED_ARTIFACT_REFS = 40;

/**
 * 저장된 ref 는 그대로 두고 `exists`·`expired` 만 실측해 붙인다.
 *
 * ★ 학습 잠금 **밖**에서 부른다. 파일을 열고 해시하는 일을 coordinator 안에서 하면 그동안
 *   모든 학습 writer 가 막히고, 잠금 본문이 `staleMs`(60초) 쪽으로 자란다.
 *
 * ★ 실패는 **진단일 뿐**이다. artifact 가 사라졌거나 확인에 실패했다고 해서 정정이 막히지
 *   않는다 — 보상 권위는 동결된 choice map 이지 패치 내용이 아니다. reset 세대 만료와는
 *   다른 사건이고, 그쪽만 정정을 거절한다.
 */
export async function inspectJournalArtifacts(stateRoot, refs, dependencyInput) {
  if (!Array.isArray(refs)) return { artifacts: null, omitted: 0, failed: false };
  if (refs.length === 0) return { artifacts: [], omitted: 0, failed: false };
  const take = refs.slice(0, MAX_INSPECTED_ARTIFACT_REFS);
  let result = null;
  try {
    result = await inspectArtifactRefs(
      { stateRoot, refs: take, nowMs: Date.now() },
      dependencyInput !== null && typeof dependencyInput === 'object' ? dependencyInput : {},
    );
  } catch {
    result = null;
  }
  if (result?.ok !== true) return { artifacts: null, omitted: refs.length, failed: true };
  return {
    artifacts: result.refs.map(({ ref, exists, expired }) => ({ ...ref, exists, expired })),
    omitted: refs.length - take.length,
    failed: false,
  };
}
