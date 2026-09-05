/**
 * 크레딧 전 예측 — 순수 판정 넷 (WS4b 스펙 §0-PF, 리서치 메모 §B·§C·§D).
 *
 * 이 모듈은 **아무것도 하지 않는다**: fs 도 spawn 도 env 도 시계도 없고, 상대 import 가 0 이다.
 * 입력은 얼어붙은 테스트 계획 · 발견 산출 · 상수뿐이고, 산출은 얼어붙은 값 하나다. 엔진은
 * **부르기만** 한다 — 판정은 전부 여기 있고, 그래서 전 주장을 `test/preflight.test.mjs` 가
 * 워크트리도 벤더도 시계도 없이 잰다.
 *
 * ★ 실측 폐포: **1개 모듈 / 328줄**(자기 자신 328 포함) — 상대 import 가 0 이라 폐포가 자기
 *   자신뿐이다. 저장소(`src/run-artifacts.mjs`)도 `src/engine.mjs` 도 당연히 0 개다.
 *
 * ## ★★ 왜 정본을 수입하지 않고 **인자로 받는가**
 *
 * 이 판정들이 쓰는 정본은 셋이고 전부 다른 파일에 산다: 증인 어댑터 목록
 * (`REGRESSION_WITNESS_ADAPTERS`, `src/regression-proof.mjs`) · 스위트 기본 타임아웃
 * (`DEFAULT_TIMEOUT_MS`, `src/test-spawn.mjs`) · 실행 대기 상한(`MAX_WAIT_MS`, `src/deadline.mjs`).
 * 수입하면 값은 정확해지지만 폐포가 무너진다 — `regression-proof` 하나만 수입해도 이 판정기가
 * **25개 모듈 / 13,583줄**(실측)을 끌고 오고 그중에는 git 을 스폰하는 모듈이 있다. 그리고
 * `engine` 은 애초에 수입할 수 없다(module-directions 의 잎 규칙, 그리고 순환).
 *
 * 그래서 값은 **합성 루트인 엔진이** 넘긴다. 「엔진이 진짜 정본을 넘기는가」는 산문이 아니라
 * 테스트가 지킨다: `test/preflight.test.mjs` 가 세 정본을 직접 수입해 이 함수들에 태우고,
 * `test/engine.test.mjs` 가 실제 실행의 봉투에서 그 결과를 읽는다.
 *
 * ## ★★ preflight 가 증명할 수 있는 것은 「닿을 수 없다」뿐이다 (메모 §B.3)
 *
 * `verified` 의 사슬은 증거 분류 → 후보 상태 기계 → 판정 → 선택 → 신뢰도까지 이어지고, 그 대부분은
 * 패치가 있어야 답이 나온다. 크레딧 전에 결판나는 것은 **부정 둘**뿐이다(증명이 필요한데 증인이
 * 신뢰 대상이 아니다 / 증인 어댑터가 아니다). 그래서 어휘는 `unreachable` 과 `possible` 둘이고
 * `reachable` 은 **없다** — 「닿는다」고 말하는 순간 그것은 지킬 수 없는 약속이 된다.
 *
 * ⚠ 그리고 「어댑터 없음」은 보통 일을 **막지 않는다**(`adapterAuthorityComplete` 가 null 을 참으로
 *   단락한다, `src/test-evidence.mjs:722-725`). 증명만 막는다. 이 구별을 흐리는 문구는
 *   `test/packaging.test.mjs:1721` 이 배포 문서에서 이미 금지한 종류의 거짓 문장이다.
 *
 * ## ★★ 발견은 진단이지 결정이 아니다 (메모 §B.1)
 *
 * `discoverTestEcosystems` 의 산출은 여기서 **경고 한 줄**로만 쓰인다. 「무엇을 돌릴 수 있나」가
 * 「무엇을 돌릴 것인가」로 조용히 승격되면 사용자가 적지도 않은 명령이 사용자 권한으로 돈다 —
 * 그 한 줄이 이 저장소의 가장 큰 안전 규칙을 되돌린다. 그래서 발견은 `verdict` 에도 `multiplier`
 * 에도 들어가지 않고, 오직 `adapterUnderived` 라는 진단 하나를 켠다.
 */

/** 크레딧 전에 낼 수 있는 답 둘. 「닿는다」는 여기 없다 — 위 머리말의 이유가 그것이다. */
export const EVIDENCE_POSSIBLE = 'possible';
export const EVIDENCE_UNREACHABLE = 'unreachable';

/**
 * 인증 프로브의 답 둘 — `preflight` 본문의 `auth{claude, codex}` 가 취하는 값이다(스펙 §0-D2,
 * 계약 `contract/envelope.json` 의 `preflight` 행이 그 모양을 이미 예약했다).
 *
 * ★★ **`auth_unknown` 은 사유 코드가 아니다.** 인증 미확인은 실행을 막지 않으므로 정지 사유
 *   어휘에 넣지 않는다 — 넣는 순간 「모르면 막는다」로 읽히는 자리가 생기고, 그것은 이 저장소가
 *   `securityFloor` 에서 이미 반대로 결정한 것이다. 막는 것은 **확인된 미로그인** 하나뿐이고
 *   그것은 새 코드가 아니라 기존 `auth_login_required` 다(메모 §E.6).
 *
 * ★ 「로그인돼 있다」에 해당하는 값이 **없는** 이유는 `EVIDENCE_POSSIBLE` 옆에 `reachable` 이
 *   없는 이유와 같다: 오늘 그것을 확인할 캡처가 이 저장소에 없다(메모 §E.5 — 라이브 테스트가
 *   하위 명령 이름도 종료 코드도 안 고정한다). 확인 못 한 긍정을 값으로 만들면 그 값은 약속이
 *   되고, 그 약속을 지키는 것은 코드가 아니라 운이 된다.
 *
 * ★ 두 값은 여기 산다 — 벤더 프로바이더가 프로브의 산출로, 엔진이 본문 값으로 읽는다. 벤더 표
 *   (`src/providers/error-catalog.mjs`)에 두면 「실패의 어휘」가 되는데 `auth_unknown` 은 실패가
 *   아니다. 이 모듈은 상대 import 가 0 인 잎이라 어느 쪽에서 읽어도 폐포가 안 늘어난다.
 */
export const AUTH_UNKNOWN = 'auth_unknown';
export const AUTH_NOT_LOGGED_IN = 'auth_not_logged_in';

/**
 * 증명 배수 둘. 6 은 `prove`(`src/regression-proof.mjs:1000`)가 참일 때의 칸 수이고, 2 는
 * `c/1`·`c/2` 만 도는 그 밖의 전부다. **추정이 아니라 산술이다**: 두 입력(어댑터·증인 신뢰)
 * 모두 얼어붙은 계획의 키라 크레딧 전에 정확히 안다(메모 §C.2).
 *
 * ⚠ **둘 다 증거 패스 하나의 칸 수다** — 실행 전체의 상계가 아니다. 그 곱셈은 아래
 *   `serialSuiteRuns` 가 한다(최종 리뷰 C1·I2).
 */
export const PROOF_MULTIPLIER_BASELINE = 2;
export const PROOF_MULTIPLIER_PROVEN = 6;

/**
 * 명령줄 전체의 OS 상한 — **실측 32,767**(Windows `CreateProcessW`, 끝의 NUL 포함), 8,191 이 아니다.
 * 8,191 은 `cmd.exe` 의 상한이고 이 저장소의 스폰은 `shell: false` 라 그것을 아예 안 지난다
 * (메모 §D.3, 이 상자에서 이진 탐색으로 두 번 독립 측정).
 *
 * ★★ **상한이 걸리는 것은 이스케이프된 명령줄이지 문자열 길이가 아니다**(최종 리뷰 C2 · C3).
 *   `shell: false` 는 `cmd.exe` 를 건너뛸 뿐이고, libuv 는 여전히 argv 원소마다 `"` 앞에 `\` 를
 *   넣고 그 앞의 백슬래시 런을 겹친 뒤 값을 따옴표로 감싼다. 이 상자에서 이진 탐색으로 실측:
 *   따옴표 없는 인자는 32,726자까지 스폰되고 따옴표를 10% 담은 인자는 29,749자에서 같은 벽에
 *   부딪힌다 — 둘 다 이스케이프 뒤 명령줄이 32,766자(= 상한 − NUL)다. 그래서 이 예산의 단위는
 *   길이가 아니라 아래 `codexArgvChars` 다.
 */
export const CODEX_COMMAND_LINE_MAX_CHARS = 32_767;

/**
 * 프롬프트가 **아닌** 명령줄 전부를 위한 예약분 — 실행 파일 경로 · `prefixArgs`(npm 설치본은
 * `node <codex.js>` 로 뜬다, `src/providers/resolve-binary.mjs`) · 플래그 · `-C` 작업 디렉터리 ·
 * 인자 사이 공백 · 프롬프트 인자를 감싸는 따옴표 둘 · 끝의 NUL.
 *
 * ★★ 왜 상수가 아니라 **예약분**인가: 이 값들은 배포마다 다르고, 예전 예산 32,486 은 그중 한
 *   상자의 한 모양(281자)을 뺀 잔액이었다. 실측 셋(이 상자, 진짜 `buildCodexArgs`):
 *   직접 실행 파일 + 모델/effort 없음 + 짧은 cwd = **139**, `node <codex.js>` + 11자 모델 이름 +
 *   6자 effort + 기본 state root = **306**, 긴 사용자 경로 + 19자 모델 이름 + 5자 effort + 깊은
 *   state root = **392**. 세 값의 축은 전부 경로라 산술 상계는 `MAX_PATH`(260) 셋 + 플래그
 *   ~120 = ~900 이고, 1,024 는 그 위다. 실측 최대와의 여유는 632자다.
 */
export const CODEX_ARGV_RESERVE_CHARS = 1_024;

/**
 * codex 프롬프트 하나가 명령줄에서 차지해도 되는 **이스케이프 뒤** 문자 수 — 상한에서 위
 * 예약분을 뺀 잔액이다. 상한이 codex 에만 걸리는 이유는 지시문이 argv 로 가기 때문이다
 * (`src/providers/codex-run.mjs:14` 의 `sendStdin: false`); claude 는 stdin 이라 이 예산을 안 쓴다.
 *
 * ★ 태스크 3(D4-γ)의 판사 뷰 상한이 **이 철자를 그대로 수입한다**(`src/candidate-selection.mjs`
 *   의 `MAX_JUDGE_VIEW_ARGV_CHARS`). 두 자리가 각자 수를 적으면 그중 하나는 반드시 낡는다.
 */
export const CODEX_PROMPT_BUDGET_CHARS = CODEX_COMMAND_LINE_MAX_CHARS - CODEX_ARGV_RESERVE_CHARS;

/**
 * argv 원소 하나의 명령줄 비용 — 길이 + 이스케이프로 느는 몫. `quote_cmd_arg` 는 `"` 마다 `\` 를
 * 하나 앞세우고 그 앞의 백슬래시 런을 겹치므로 `"` 와 `\` 의 개수 합이 증가분의 **상계**다
 * (백슬래시는 따옴표 앞에 있을 때만 실제로 는다). 감싸는 따옴표 둘은 위 예약분에 든다.
 */
export function codexArgvChars(text) {
  const value = typeof text === 'string' ? text : '';
  let escapes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) escapes += 1;
  }
  return value.length + escapes;
}

/**
 * 태스크 텍스트를 뺀 지시문 상계 둘 — 모든 발췌 슬롯을 포화시킨 실측이고 단위는 위 `codexArgvChars`
 * 다. 워커는 따옴표가 없어 길이와 같고(2,676 → **3,099**, WS5 Task 5 = scope 고지 네 줄 419자 +
 * 줄바꿈 4), verifier 는 `BINDING_JSON`·스키마 줄의 따옴표 68개가 더 붙는다(5,892 → **5,618**: 2026-08-28 에 재점검 슬롯이 무계 ID 나열에서 유계 본문 줄이 됐다 — `test/prompts-instructions.test.mjs`).
 *
 * ★★ **오프셋은 둘 중 큰 쪽이다**(최종 리뷰). 같은 raw `task` 가 워커와 verifier 지시문에 **둘 다**
 *   계수 1.0 으로 실리는데(어느 쪽도 `clip` 이 없다), 작은 쪽으로 재면 verifier 만 넘는 띠가
 *   `withinBudget: true` 를 받고 크레딧을 쓴 뒤 스폰에서 죽는다 — 실측 그 띠는 2,337자였다.
 * 정본은 지시문 함수들 자신이고, 등식은 `test/preflight.test.mjs` 와
 * `test/prompts-instructions.test.mjs` 가 그 함수를 직접 태워서 지킨다.
 */
export const CODEX_WORKER_PROMPT_OVERHEAD_CHARS = 3_099;
export const CODEX_VERIFIER_PROMPT_OVERHEAD_CHARS = 5_618;
export const CODEX_PROMPT_OVERHEAD_CHARS =
  Math.max(CODEX_WORKER_PROMPT_OVERHEAD_CHARS, CODEX_VERIFIER_PROMPT_OVERHEAD_CHARS);

const nonNegativeInt = (value, fallback = 0) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
const positiveInt = (value, fallback) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

/** 정본 산출 `{ecosystem, evidence, suggestion}`(`src/test-discovery.mjs:615`)에서 **이름만** 꺼낸다. */
function ecosystemNames(ecosystems) {
  return Array.isArray(ecosystems)
    ? ecosystems.map((one) => one?.ecosystem).filter((name) => typeof name === 'string' && name !== '')
    : [];
}

/** 증인 자격의 두 조건. `splitTestOnlyDelta`(`src/regression-proof.mjs:128`)와 **같은 술어**다. */
function witnessAccepted(plan, witnessAdapters) {
  return plan?.regressionWitnessTrusted === true &&
    (Array.isArray(witnessAdapters) ? witnessAdapters : []).includes(plan?.adapterId);
}

/**
 * 판정 1 — 이 저장소에서 `verified` 가 **닿을 수 없는가**.
 *
 * @param plan             얼어붙은 테스트 계획(`src/engine.mjs:902`)
 * @param proofRequirement `classifyProofRequirement` 의 산출(순수, 같은 자리에서 손에 있다)
 * @param witnessAdapters  증인 어댑터 정본(엔진이 `REGRESSION_WITNESS_ADAPTERS` 를 넘긴다)
 * @param ecosystems       발견 산출 — **진단 전용**
 */
export function evidenceReachable(input = {}) {
  const plan = input?.plan;
  const proofRequired = input?.proofRequirement?.required === true;
  const adapterId = typeof plan?.adapterId === 'string' ? plan.adapterId : null;
  const discoveredEcosystems = ecosystemNames(input?.ecosystems);
  const shape = {
    proofRequired,
    adapterId,
    witnessTrusted: plan?.regressionWitnessTrusted === true,
    discoveredEcosystems: Object.freeze(discoveredEcosystems),
    // 메모 §B.2 ★ 의 사례: 생태계는 보이는데 계획은 어댑터를 못 얻었다(이 저장소 자신의 발견은 실측 0 이다).
    adapterUnderived: adapterId === null && discoveredEcosystems.length > 0,
  };
  if (proofRequired && plan?.regressionWitnessTrusted !== true) {
    return Object.freeze({ verdict: EVIDENCE_UNREACHABLE, reason: 'proof_requires_trusted_witness', ...shape });
  }
  if (proofRequired && !witnessAccepted(plan, input?.witnessAdapters)) {
    return Object.freeze({ verdict: EVIDENCE_UNREACHABLE, reason: 'witness_adapter_not_accepted', ...shape });
  }
  return Object.freeze({
    verdict: EVIDENCE_POSSIBLE,
    reason: proofRequired ? 'witness_available' : 'proof_not_required',
    ...shape,
  });
}

/**
 * 판정 2 — 증거 패스 **하나**가 스위트를 몇 칸 돌리는가. 실행 안에서는 언제나 2 다.
 *
 * ★★ 실행 9(2026-08-28)까지 이 값은 증인 어댑터가 받아들여질 때 6 이었다. 그 여섯 칸은 이
 *   저장소에서 42분이고 `MAX_WAIT_MS`(3,300,000ms)가 **다섯 번째 스위트 실행에서** 실행을
 *   끊었다 — 6 × 600,000 > 3,300,000 은 설계 때부터 참이었다. 그래서 여섯 칸은 실행 밖으로
 *   나갔고(`orch_prove`), 실행이 도는 것은 `c/1`·`c/2` 둘뿐이다. 어댑터도 요건도 이 값을
 *   더는 안 움직인다 — 그 둘이 사는 자리는 판정 1(증거 도달 가능성)이다.
 * ★ `PROOF_MULTIPLIER_PROVEN` 은 지운 것이 아니라 **자리를 옮겼다**: `orch_prove` 봉투의
 *   `cost.testRuns` 행이 그 6 을 쓴다. 여기서 지우면 그 도구가 자기 수를 다시 짓게 된다.
 */
export function proofMultiplier() {
  return PROOF_MULTIPLIER_BASELINE;
}

/**
 * 판정 2b — 이 **실행 전체**가 스위트를 최대 몇 번 직렬로 돌리는가. 곱셈 하나다:
 * `2 × candidateCount × budget`. 기본값(레인 1 · 시도 5)에서 **10**, `candidates: 2` 면 **20**.
 *
 * ★★ 캐시로 나누던 항이 사라진 이유는 나눌 것이 없어서다 — 실행 전체가 공유하던 둘은 맨
 *   베이스라인 `b0` 였고 그 칸은 실행 9(2026-08-28) 뒤 `orch_prove` 로 나갔다. 남은 후보 둘
 *   (`c/1`·`c/2`)은 `cacheable: false` 라 레인마다·시도마다 정직하게 다시 돈다.
 * ⚠ 이 수는 증명 요건과 **무관하다**. 요건이 참이든 거짓이든 실행이 도는 칸 수가 같기 때문이고,
 *   그래서 경고 `preflight_proof_time_exceeds_wait` 는 이제 「스위트가 대기 예산에 안 들어간다」를
 *   말한다 — 증명이 비싸다가 아니라.
 */
export function serialSuiteRuns(input = {}) {
  return PROOF_MULTIPLIER_BASELINE *
    positiveInt(input?.candidateCount, 1) * positiveInt(input?.budget, 1);
}

/**
 * 판정 3 — 태스크 텍스트가 codex 의 명령줄 예산 안에 들어오는가.
 *
 * ⚠ 이것은 **측정 가능한 경로**(태스크 텍스트를 싣는 워커·verifier)만 잰다. 판사 경로의 상계는
 *   `task` 와 무관해 예측으로 막을 수 없었고, 그래서 태스크 3 이 상한 쪽을 고쳤다(스펙 §0-D4-γ).
 * ★ `taskChars` 는 길이가 아니라 `codexArgvChars(task)` 다 — 부르는 쪽이 그렇게 잰다. 예산이
 *   이스케이프된 명령줄의 단위이므로 태스크도 같은 자로 재야 한다.
 */
export function argvBudget(input = {}) {
  const budgetChars = positiveInt(input?.budgetChars, CODEX_PROMPT_BUDGET_CHARS);
  const projectedChars = nonNegativeInt(input?.taskChars) +
    nonNegativeInt(input?.overheadChars, CODEX_PROMPT_OVERHEAD_CHARS);
  return Object.freeze({
    withinBudget: projectedChars <= budgetChars,
    projectedChars,
    budgetChars,
    headroomChars: budgetChars - projectedChars,
  });
}

/**
 * 판정 4 — 최악의 스위트 시간이 이 호출의 대기 예산을 넘는가. **경고이지 관문이 아니다.**
 *
 * `wait_ms` 는 사용자의 것이다. 넘는다는 것이 「돌리면 안 된다」는 뜻이 아니라 「마감에 먼저
 * 걸릴 수 있다」는 뜻이고, 오늘 사용자는 그것을 `test_deadline_expired` 로 **뒤늦게** 안다.
 * 여기서 막으면 사용자가 고른 예산을 서버가 되돌리는 것이 된다.
 *
 * 실효 타임아웃은 선언이 이긴다(`boundedTestTimeout`, `src/test-runner.mjs:196-199`가 실행
 * 예산과 min 을 취하지만 크레딧 전 최악값은 선언 그대로다). 쓸모없는 선언이면 기본값이다.
 */
export function timeInequality(input = {}) {
  const timeoutMs = positiveInt(input?.declaredTimeoutMs, positiveInt(input?.defaultTimeoutMs, 0));
  const multiplier = positiveInt(input?.multiplier, PROOF_MULTIPLIER_BASELINE);
  const waitMs = nonNegativeInt(input?.waitMs);
  const worstCaseMs = multiplier * timeoutMs;
  return Object.freeze({
    exceedsWait: worstCaseMs > waitMs,
    multiplier,
    timeoutMs,
    waitMs,
    worstCaseMs,
    overageMs: Math.max(worstCaseMs - waitMs, 0),
  });
}

/**
 * 판정 넷을 한 번에 — 엔진이 부르는 유일한 자리다.
 *
 * 경고는 `{key, params}` 쌍으로 낸다. 문구 정본은 `src/reason-text.mjs` 의 `NOTICE_TEXT` 이고
 * 렌더는 부르는 쪽이 한다 — 그 모듈을 여기서 수입하면 이 파일의 폐포가 1,145줄짜리 레지스트리와
 * 그 이하를 통째로 끌고 온다. 키가 실제로 등재돼 있는지는 `test/preflight.test.mjs` 가 잰다.
 *
 * `estimatedSuiteMs` 는 **내지 않는다**(스펙 §0-D3): 스위트 한 번의 시간을 재는 자리는 있지만
 * 읽는 자리가 0개라 정직한 출처가 오늘 없다. 대신 내는 것은 배수와 상계 — 전부 알려진 수의 산술이다.
 */
export function preflightReport(input = {}) {
  const evidence = evidenceReachable(input);
  const multiplier = proofMultiplier(input);
  const suiteRuns = serialSuiteRuns(input);
  const argv = argvBudget(input);
  // 사용자가 읽는 수는 실행 전체의 것이다 — 패스 하나의 칸 수로 재면 경고가 안 나야 할 때 안 나는
  // 것이 아니라, **나야 할 때** 안 난다(최종 리뷰 C1).
  const time = timeInequality({ ...input, multiplier: suiteRuns });
  const warnings = [];
  if (evidence.verdict === EVIDENCE_UNREACHABLE) {
    warnings.push({ key: 'preflight_evidence_unreachable', params: { reason: evidence.reason } });
  } else if (evidence.adapterUnderived) {
    // 부정 판정이 이미 나갔으면 같은 사실을 두 문장으로 말하지 않는다 — 진단은 그때 잉여다.
    warnings.push({
      key: 'preflight_adapter_not_derived',
      params: { ecosystems: evidence.discoveredEcosystems.join(', ') },
    });
  }
  if (time.exceedsWait) {
    warnings.push({
      key: 'preflight_proof_time_exceeds_wait',
      params: { multiplier: time.multiplier, timeoutMs: time.timeoutMs, worstCaseMs: time.worstCaseMs, waitMs: time.waitMs },
    });
  }
  if (!argv.withinBudget) {
    warnings.push({
      key: 'preflight_codex_prompt_over_budget',
      params: { projectedChars: argv.projectedChars, budgetChars: argv.budgetChars },
    });
  }
  return Object.freeze({
    evidenceReachable: evidence.verdict,
    reason: evidence.reason,
    adapterId: evidence.adapterId,
    discoveredEcosystems: evidence.discoveredEcosystems,
    proofMultiplier: multiplier,
    serialSuiteRuns: suiteRuns,
    argv,
    time,
    warnings: Object.freeze(warnings.map((one) => Object.freeze({ ...one, params: Object.freeze(one.params) }))),
  });
}
