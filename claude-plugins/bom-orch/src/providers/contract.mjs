/**
 * 프로바이더 계약.
 *
 * 프로바이더는 서로 근본적으로 다를 수 있다 — 지금은 둘 다 서브프로세스지만, 범용
 * 코드(tools.mjs, orchestra/)는 프로바이더 이름을 절대 알면 안 되고 아래 **세 함수**와
 * `id` 로만 닿는다(계획 3 태스크 9 가 `pickModel` 을 지웠다 — 아래 ★ 참조).
 *
 *   id            문자열 식별자. 도구 스키마의 enum 이 여기서 만들어진다.
 *
 *   discover(signal)
 *       -> { reachable, version?, models?, error?, recovery?, discoveryTimeout? }
 *       models 는 optional 이다. 있으면 각 항목은
 *         { name, efforts?: string[], defaultEffort?: string|null, contextWindow?: number|null }
 *       효력 없는 값은 null 로 둔다 — "모른다"와 "0"은 다르다. 호출자는 null 을
 *       "최대치로 가정"으로 읽으면 안 된다.
 *       reachable:false 이고 실패 사유가 discovery 자체의 상한 소진일 때만
 *       discoveryTimeout: true 를 얹는다. error 문자열 값은 프로바이더마다 달라도
 *       되고, 호출자는 그 문자열을 보지 않고 이 불리언 하나만 본다.
 *
 *   run({ role, model, effort, instruction, workspace, tools, allowedTools, signal,
 *        onProgress, onSpawn, runId })
 *       -> { content, model, promptTokens, evalTokens, truncated, doneReason?, notice? }
 *       model/effort 는 null 일 수 있다(= CLI 자신의 기본값을 쓴다).
 *       tools 는 이 실행이 받을 **도구 집합**이다. 실측(설계 §12.0)으로 명령 패턴
 *       단위 허용 목록은 어느 벤더에서도 강제되지 않고, 강제되는 것은 집합뿐이다.
 *       그 채널이 없는 벤더는 목록을 조용히 버리지 말고 notice 로 알린다.
 *       onSpawn(child) 는 자식 프로세스를 스폰한 직후 한 번 불린다. 배선 계층이
 *       거기서 리퍼 원장에 올리고 트리 킬 대상으로 등록한다 — 프로바이더는
 *       stateRoot 를 모른다. 서브프로세스가 아닌 프로바이더는 부르지 않아도 된다.
 *       runId 는 자식 env 의 BOM_ORCH_RUN_ID 스탬프(중첩 실행 탐지)에 쓰인다.
 *       signal 은 무제한 예산(wait_ms: 0)일 때 undefined 로 들어올 수 있다 —
 *       서브프로세스 프로바이더는 undefined 를 받아도 죽지 않아야 한다.
 *       onProgress 는 optional 콜백이다. 스트림 이벤트마다 호출해 호스트의
 *       유휴 타임아웃을 리셋한다. 없으면 부르지 않는다.
 *       truncated 는 필수 boolean 이다 — "완결됐는지"의 어휘는 프로바이더마다
 *       다르므로(claude 는 subtype:"success", codex 는 다른 어휘) 프로바이더
 *       자신만 이 판정을 내릴 수 있다. 호출자는 doneReason 문자열을 추측하지 않는다.
 *       notice 는 **답변이 아니라 실행 자체**에 대한 진술이다. content 에
 *       이어붙이지 말 것 — 호스트의 결과 크기 예산이 큰 답변의 꼬리를 자르므로,
 *       꼬리에 붙인 경고는 정확히 그것이 중요한 경우에 사라진다.
 *
 *   describeError(error) -> { error, recovery? }
 *
 * ★ 모델을 고르는 메서드는 **여기 없다.** 계획 3 태스크 9 까지 `pickModel(discovered)`
 *   가 있었지만 `src/` 안의 호출부가 0곳이었고, 되살릴 자리도 없었다.
 *
 *   태스크 9 시점에 확인한 것: `src/engine.mjs` 에서 `run` 을 부르는 자리는 한 곳이고
 *   (`provider.run({` 1회), 거기 실리는 `model` 은 `resolveTier(...)` 의 결과뿐이다.
 *   설정이 비면 `null` 이 가고 그것은 **CLI 자신의 기본값을 쓰라**는 뜻이다. 발견 목록의
 *   첫 항목은 CLI 의 기본값이 아니라 프로브가 훑은 순서일 뿐이라 그것을 고르면 더
 *   나빠진다. 프로바이더가 모델을 따로 고르는 길을 다시 만들면 같은 결정을 두 곳이
 *   내리게 된다.
 *
 * 세 함수 전부 "throw 하지 않는다"가 문서화된 기대지만, 이 파일도 assertProviderShape
 * 도 그것을 강제하지 않는다 — 서브프로세스 spawn 이 동기로 던지는 경우가 실제로
 * 있다. 호출자가 매 호출 지점을 safe* 로 감싸 정상 봉투로 강등한다. describeError
 * 자신이 깨지는 경우까지 포함이다.
 */
export const CONTRACT_METHODS = Object.freeze(['discover', 'run', 'describeError']);

/** 등록 시점에 형태를 검증한다 — 잘못된 모듈은 첫 호출이 아니라 로드에서 죽어야 한다. */
export function assertProviderShape(provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.id !== 'string' || provider.id === '') {
    throw new Error('provider must expose a non-empty string id');
  }
  for (const method of CONTRACT_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`provider '${provider.id}' is missing ${method}()`);
    }
  }
  return provider;
}
