/**
 * **크레딧을 한 푼도 쓰기 전에** 답이 나는 관문 넷 — 게이트웨이 구성 거부 · 벤더별 사전 점검 ·
 * 크레딧 전 예측 · 인증 프로브. 넷 다 「이 실행을 시작해도 되는가」를 묻고, 넷 다 거부에
 * **치울 것이 하나도 없다**(워크트리 이전이고 벤더 프로세스도 아직 없거나 방금 끝났다).
 *
 * WS8 컷 2 가 `src/engine.mjs` 의 `prepareRunNamespace` 에서 뽑았다(로드맵 §3.11). 준비 단계의
 * 지역 변수를 닫지 않고 **필요한 것을 전부 인자로 받는다** — 그것이 이 넷을 한 함수 안에서
 * 꺼낼 수 있었던 이유이자, 다음 사람이 여기에 관문을 하나 더 붙일 때 지켜야 하는 규칙이다.
 *
 * ★★ **왜 별도 모듈인가.** 이 넷은 자리(순서)만 엔진의 것이고 판정은 전부 자기 것이다. 넷의
 *   ★★ 주석이 적는 「왜 여기인가」는 서로를 가리키는 한 덩어리의 논증이라 흩어 놓으면 다음
 *   사람이 관문 하나를 크레딧 뒤로 옮기고도 아무 문장도 붉히지 않는다. **새 크레딧 전 관문은
 *   이 파일로 들어간다** — 엔진으로 되돌려 놓으면 래칫(`contract/module-budget.json`)이 붉어진다.
 *
 * ★ 반환 규약 하나. 세 함수 다 `{ refusal, …산출 }` 을 낸다 — `refusal` 이 `null` 이면 통과이고,
 *   봉투면 그 자리에서 실행이 끝난다. 엔진은 그 봉투를 자기 `halt` 로 감싸기만 한다(그 함수의
 *   `deepFreeze` 가 준비 단계 이탈의 유일한 정의로 남는다).
 *
 * ★ `envelopeExtras` 는 **함수로** 받는다. 같은 halt 라도 스윕 요약이 이미 난 뒤인지 아닌지가
 *   봉투에 실릴 알림을 바꾸는데, 그 사실은 부르는 자리가 알고 이 파일은 모른다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지). 방향은 engine → run-precredit-gates
 *   하나뿐이다.
 */
import { failure } from './envelope.mjs';
// 크레딧 전 예측(WS4b §0-PF). 순수 판정은 전부 저쪽에 살고 이 파일은 부르기만 한다 —
// 그 모듈은 상대 import 가 0 이라 정본 셋(아래 셋)을 여기서 넘겨받는다.
import { AUTH_NOT_LOGGED_IN, AUTH_UNKNOWN, codexArgvChars, preflightReport } from './preflight.mjs';
import { detectGatewayEnv } from './providers/child-env.mjs';
import { REASON } from './reason-codes.mjs';
import { renderNotice } from './reason-text.mjs';
import { REGRESSION_WITNESS_ADAPTERS } from './regression-proof.mjs';
import { statusOfReasonCode } from './run-faults.mjs';
import { discoverTestEcosystems as defaultDiscoverTestEcosystems } from './test-discovery.mjs';
import { DEFAULT_TIMEOUT_MS } from './test-spawn.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { GENERIC_RECOVERY, errorText } from './util/errors.mjs';

/**
 * 관문 1 — 호스트가 게이트웨이 구성으로 서 있으면 **아무것도 시작하지 않고** 거부한다.
 * 던지지 않는다.
 */
export function refuseGatewayEnvironment({ deps, runId, logLine, envelopeExtras }) {
  // ★★ 게이트웨이 구성 거부(WS4b §0-D1-(b)). 이 자리인 이유가 셋이다. (a) **어떤 벤더 프로세스도
  //   뜨기 전**이다 — 아래 사전 점검이 CLI 를 깨우고, 그 뒤에 거부하면 봉투가 자기 구성이 아니라
  //   벤더 문제로 읽힌다("어느 CLI 를 못 찾았다"). (b) 워크트리 이전이라 치울 것이 없다.
  //   (c) 앞선 재개 관문 하나(사유가 둘로 갈릴 뿐이다)는 **요청 자체**에 대한 답이고, 이것은
  //   호스트 **환경**에 대한 답이라 그 뒤가 맞는 순서다.
  //
  // ★★ 왜 통과가 아니라 거부인가(스펙 §0-D1, 메모 §F.4). 실측: `buildChildEnv` 는 게이트웨이
  //   변수를 전부 버린다. 그래서 오늘 게이트웨이 사용자는 **틀린 문장 둘** 중 하나를 받는다 —
  //   「스트림이 최종 기록 없이 끝났다」(대부분) 또는 「로그인하세요」(운 나쁘면). 둘 다
  //   `provider_failed` 이므로 **크레딧과 시간을 쓴 뒤**다. 허용목록을 넓히는 (a) 안은 「이 변수를
  //   통과시키면 게이트웨이가 실제로 동작한다」는 주장을 문서에 싣는데 이 저장소에는 그것을 잴
  //   환경이 없다 — 검증 못 하는 확대는 이 저장소가 `securityFloor` 에서 이미 거부한 종류의
  //   게이트다. (a) 로 가는 문은 열려 있고 그것은 오너 결정이다(스펙 §8).
  //
  // ★ `env` 를 인자로 받는 이유는 `buildChildEnv` 와 같다 — 실제 프로세스에 그 변수를 세우지 않고도
  //   탐지가 도는 것을 증명할 수 있어야 한다. 실행 준비가 `process.env` 를 읽는 유일한 자리다.
  const gateway = (deps.detectGatewayEnv ?? detectGatewayEnv)(deps.env ?? process.env);
  if (gateway.gateway === true) {
    const names = gateway.names.join(', ');
    logLine('warn', REASON.preflight_gateway_env_unsupported, 'gateway env', { names });
    return { refusal: failure({
      status: statusOfReasonCode(REASON.preflight_gateway_env_unsupported), runId,
      reasonCode: REASON.preflight_gateway_env_unsupported, params: { names }, ...envelopeExtras(),
    }) };
  }
  return { refusal: null };
}

/**
 * 관문 2 — 등록된 벤더 전부에 사전 점검을 돌리고, 쓸 수 있는 프로바이더 목록을 낸다. 결과는
 * 벤더 하나에 한 줄씩 **로그로** 나가고(실행마다 항상), 셋 중 하나에 걸리면 거부한다.
 */
export async function settleVendorPreflight({
  registered, runOptions, candidateCount, runId, deadline, stage, logLine, runHalt, envelopeExtras,
}) {
  const preflightSettlements = await Promise.all(registered.map(async (provider, registryIndex) => {
    try {
      const result = await stage(`${provider.id} preflight`, () => provider.preflight(deadline));
      return [provider.id, result && typeof result === 'object' ? result : { available: false }, provider, registryIndex];
    } catch (error) {
      let described;
      try { described = provider.describeError(error); } catch { described = { error: errorText(error), recovery: GENERIC_RECOVERY }; }
      return [provider.id, { available: false, ...described }, provider, registryIndex];
    }
  }));
  if (preflightSettlements.some(([, result]) => result?.hardStopped === true)) {
    // ★ 로그가 아래에서 열리던 시절 이 halt 만 `envelopeExtras()` 를 못 불렀다(WS3 §0-E). 그리고
    //   status 를 손으로 고르던 자리도 여기 하나였다 — 이제 코드가 정한다(계약 topLevel.status).
    return { refusal: runHalt({ runId, extras: envelopeExtras() }) };
  }
  const groupedSettlements = new Map();
  for (const [id, result, provider, registryIndex] of preflightSettlements) {
    if (!groupedSettlements.has(id)) groupedSettlements.set(id, []);
    groupedSettlements.get(id).push({ result, provider, registryIndex });
  }
  const availability = deepFreeze(Object.fromEntries([...groupedSettlements].map(([id, entries]) => [
    id,
    entries.length === 1
      ? entries[0].result
      // 같은 id 가 둘이면 어느 쪽도 쓰지 않는다 — 문구는 이 자리를 지나지 않는다(코드가 정한다).
      : { available: false },
  ])));
  const providers = [...groupedSettlements.values()]
    .filter((entries) => entries.length === 1 && entries[0].result?.available === true)
    .sort((left, right) => left[0].registryIndex - right[0].registryIndex)
    .map((entries) => entries[0].provider);
  // ★★ 벤더별 사전 점검 결과는 **로그**로 간다 — 벤더 하나에 한 줄, 실행마다 항상. 예전에는 이
  //   줄들이 `providers.length === 0` 가지 **안에만** 있었고 sink 도 없어 전부 조용한 무연산이었다
  //   — 「로그인이 안 됐다」·「바이너리가 없다」가 어느 채널에도 안 남았다(봉투는 그 벤더 산문을
  //   못 싣는다, 불변식 4). 가지 안이 아닌 이유: 성공한 실행도 「왜 안 뽑혔나」를 답해야 한다.
  for (const [id, value] of preflightSettlements) {
    logLine(value?.available === true ? 'info' : 'warn', null, 'preflight', {
      vendor: id, available: value?.available === true, detail: value?.error ?? value?.recovery ?? '',
    });
  }
  // ★★ 사전 점검 halt 셋은 이제 `runId` 를 싣는다(WS3 태스크 2). Task 1 의 호이스트 뒤로 실행
  //   이름이 이 줄들 **앞에서** 이미 정해지는데도 봉투가 그것을 안 말하면, 방금 막힌 사용자에게는
  //   종료 저널 행과 로그 파일을 되찾을 이름이 없다 — 그 둘의 이름이 곧 runId 다.
  if (providers.length === 0) {
    return { refusal: failure({ status: 'blocked', runId, reasonCode: REASON.preflight_no_provider_available, ...envelopeExtras() }) };
  }
  for (const role of ['planner', 'writer', 'worker', 'verifier']) {
    const wanted = runOptions[role];
    if (wanted !== undefined && wanted !== null && availability[wanted]?.available !== true) {
      logLine('warn', REASON.preflight_provider_unavailable, 'preflight', { role, vendor: wanted, detail: availability[wanted]?.error ?? '' });
      return { refusal: failure({
        status: 'blocked', runId, reasonCode: REASON.preflight_provider_unavailable,
        params: { role, vendor: wanted }, ...envelopeExtras(),
      }) };
    }
  }
  if (providers.length < 2 && (candidateCount === 2 || runOptions.allowSingle !== true)) {
    return { refusal: failure({ status: 'blocked', runId, reasonCode: REASON.preflight_cross_vendor_unavailable, ...envelopeExtras() }) };
  }
  return { refusal: null, providers };
}

/**
 * 관문 3·4 — 크레딧 전 예측(막지 않는 경고 넷)과 인증 프로브(확인된 미로그인 하나만 막는다).
 * 둘이 한 함수인 이유는 산출이 하나이기 때문이다: 봉투가 싣는 얼어붙은 `preflight` 기록.
 */
export async function assessPreCreditRisk({
  task, canonicalProject, candidateCount, budget, effectiveWaitMs,
  frozenTestPlan, proofRequirement, baselineConfig, providers,
  runId, deadline, deps, stage, logLine, addNotice, runHalt, envelopeExtras,
}) {
  // ★★ 크레딧 전 예측(WS4b §0-PF). 판정 넷은 전부 `src/preflight.mjs` 의 순수 함수이고 이 자리는
  //   **부르기만** 한다. 여기인 이유는 관문 8 과 같다: 입력(얼어붙은 계획·분류 둘)이 방금 손에
  //   들어왔고, 워크트리 이전이라 어떤 결과에도 치울 것이 없다. 정본 셋을 넘기는 것이 이 줄들의
  //   절반인데, 그것이 저쪽이 순수한 잎으로 남는 값이다.
  // ★ 발견은 **진단**이다(메모 §B.1) — 「무엇을 돌릴 수 있나」가 「무엇을 돌릴 것인가」로 승격되면
  //   사용자가 적지도 않은 명령이 사용자 권한으로 돈다. 그래서 산출은 경고 문장에만 실리고
  //   계획에는 한 글자도 안 들어간다. 이 함수는 절대 던지지 않고 이상한 경로에는 `[]` 를 낸다.
  const report = preflightReport({
    plan: frozenTestPlan,
    proofRequirement,
    witnessAdapters: REGRESSION_WITNESS_ADAPTERS,
    ecosystems: await (deps.discoverTestEcosystems ?? defaultDiscoverTestEcosystems)(canonicalProject),
    taskChars: codexArgvChars(task), // 길이가 아니라 이스케이프된 명령줄 비용 — 예산의 단위가 그것이다
    declaredTimeoutMs: baselineConfig?.tests?.timeoutMs,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    // 증거 패스는 레인마다·시도마다 돈다 — 이 둘이 없으면 배수는 실행 하나의 상계가 아니다.
    candidateCount, budget, waitMs: effectiveWaitMs,
  });
  // 넷 다 **막지 않는다** — 예산도 대기 시간도 사용자의 것이다. 오늘 이 사실들이 닿는 채널은
  // 실행 알림이고, 봉투의 `preflight` 본문 행은 태스크 6 이 `prepared.preflight` 를 읽어 싣는다.
  for (const { key, params } of report.warnings) addNotice(renderNotice(key, params));
  // ★★ 인증 프로브(WS4b §0-AU). `securityFloor` 루프와 **같은 모양**이다: 선택적 메서드이고,
  //   없는 프로바이더는 건너뛰며, 그 축의 검사가 그냥 안 돈다. 이 자리인 이유는 위 판정 넷과
  //   같다 — 워크트리 이전이라 어떤 답에도 치울 것이 없고, 크레딧은 아직 한 푼도 안 썼다.
  // ★★ **`auth_unknown` 은 아무것도 막지 않는다**(§0-D2). 막는 것은 확인된 미로그인 하나뿐이고,
  //   그것은 새 어휘가 아니라 벤더 표가 이미 쓰던 `auth_login_required` 다 — status 는 그 코드의
  //   조악값이 정한다. 프로브가 던지거나 이상한 값을 내면 그것도 `auth_unknown` 이다.
  const authProbes = await Promise.all(providers.map(async (provider) => {
    const probe = deps.authProbe ?? (typeof provider.authProbe === 'function' ? (() => provider.authProbe(deadline)) : null);
    if (probe === null) return [provider.id, { status: AUTH_UNKNOWN, reason: 'not_implemented' }];
    try {
      const settled = await stage(`${provider.id} auth probe`, () => probe(provider.id, provider));
      return [provider.id, settled !== null && typeof settled === 'object' ? settled : { status: AUTH_UNKNOWN, reason: 'probe_shape_invalid' }];
    } catch {
      return [provider.id, { status: AUTH_UNKNOWN, reason: 'probe_failed' }];
    }
  }));
  // ★★ 하드스톱은 프로브의 답이 아니다 — 형제 관문 일곱과 **같은 검사**다(이 파일의 벤더 사전
  //   점검, 그리고 `src/engine.mjs` 의 저장소 점검·계획 동결·워크트리 준비 둘·설정 봉인·의존성
  //   제공). `stage()` 의 유예가 만료되면 `haltFail` 이 `status` 키가 없는 `hardStopped:true`
  //   중립 실패를 내는데, 그것을 프로브 결과로 삼으면 `auth_unknown` 으로 기록되고 실행이
  //   **계속 나아간다** — 권위가 회수된 뒤에 lane-A 워크트리(`git worktree add` + 합성 커밋)가
  //   생겼다. 위 배치 근거인 「어떤 답에도 치울 것이 없다」가 깨지던 유일한 갈래다.
  if (authProbes.some(([, result]) => result?.hardStopped === true)) {
    return { refusal: runHalt({ runId, extras: envelopeExtras() }) };
  }
  const auth = {};
  for (const [vendor, result] of authProbes) {
    const refused = result.status === AUTH_NOT_LOGGED_IN;
    auth[vendor] = refused ? AUTH_NOT_LOGGED_IN : AUTH_UNKNOWN;
    // 프로브가 실제로 부른 하위 명령 이름은 **로그의 라벨된 필드**로만 간다(불변식 4) — 봉투는
    // 벤더 산문을 못 싣고, 그 이름은 계약도 스냅샷도 아니어야 한다(§0-AU).
    logLine(refused ? 'warn' : 'info', refused ? REASON.auth_login_required : null, 'auth probe', {
      vendor, status: auth[vendor], reason: result.reason ?? '', subcommand: result.subcommand ?? '',
    });
  }
  const notLoggedIn = authProbes.find(([, result]) => result.status === AUTH_NOT_LOGGED_IN);
  if (notLoggedIn !== undefined) {
    return { refusal: failure({
      status: statusOfReasonCode(REASON.auth_login_required), runId, reasonCode: REASON.auth_login_required,
      params: { vendor: notLoggedIn[0] }, ...envelopeExtras(),
    }) };
  }
  const preflight = deepFreeze({ ...report, auth });
  return { refusal: null, preflight };
}
