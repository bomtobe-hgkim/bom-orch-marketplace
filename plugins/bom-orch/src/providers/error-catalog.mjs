/**
 * 벤더 오류 카탈로그 — **무엇이 실패했는지는 표가 정한다**(WS2 §3.2). 이전에는 두 프로바이더가
 * 각자 if-체인으로 분류했다(claude 4갈래·codex 3갈래) — 다섯 결함을 한 문장으로 뭉치고 스폰 실패·
 * 시그널 킬·읽지 못한 스트림·usage 한도는 아예 분류하지 않아 마지막 갈래로 떨어졌다. 여기서는
 * 항목마다 **하나의 reason code** 가 붙고, 표 밖은 `provider_error_unclassified` 다(EC2).
 *
 * ★ 항목 스키마는 `{reasonCode, excerpt, match, evidence?}` 뿐이다. **문구는 여기 없다** — `error`/
 *   `recovery` 의 정본은 `src/reason-text.mjs`, `stopReason` 은 레지스트리(`stopReasonOf`)다.
 * ★ 카탈로그 키(`spawn_enoent` 같은 것)는 **벤더 내부 이름**이다 — 바깥으로 나가는 건 reasonCode
 *   뿐이고 키는 진단(로그·`failure.catalogKey`)에만 쓴다.
 * ★ 조회는 **순서가 곧 우선순위**다(§3.2): 코드 → spawn → signal → auth → rate-limit → deadline →
 *   stream → 종료 기록 → exit, 첫 일치가 이긴다(JS 객체 키 순서). `signal_killed` 가 `timedOut:
 *   false`·`aborted:false` 를 함께 요구하는 이유: 우리가 끊은 실행도 POSIX 에서는 시그널로 죽는다
 *   (errors.json signal_killed.matchedBy) — 시그널이 이기면 데드라인 원인이 호스트 탓으로 나간다.
 * ★ `match` 의 값은 **정규화된 입력의 술어**다(아래 `MATCHERS`, 벤더 두 표만). 이름이 아니라 실제
 *   필드로 적는다 — 모르는 키는 **불일치**(오타 = 죽은 항목, 테스트가 잰다). git·notice 표는
 *   **키로만** 조회되어(`gitFault`, `NOTICE_CATALOG.<key>`) `matches()` 를 안 거친다 — 그래서 그
 *   표는 `match` 대신 실행되지 않는 **`when: '<문서 문자열>'`** 을 쓴다(M1).
 * ★ `evidence: 'unverified'` 는 **실측 없이 쓴 정규식**이라는 표시다(errors.json gap 3, 라이브
 *   금지). 일치해도 코드는 같게 나가되 발췌를 붙여 사람이 원문을 확인하게 한다.
 */
import { REASON } from '../reason-codes.mjs';
import { renderReason } from '../reason-text.mjs';
import { deepFreeze } from '../util/freeze.mjs';

/** 발췌 재료로 들고 가는 stderr 꼬리의 상한. 원문 바이트는 따로 실어 잘렸음을 알린다. */
export const STDERR_TAIL_BYTES = 4_096;

/** 값이 없을 때 문장에 들어가는 토큰. `renderReason` 은 빠진 인자에 **던지므로** 자리를 비울 수 없다. */
const UNKNOWN_VALUE = '<unknown>';

/**
 * 인증 실패로 읽는 문구.
 *
 * ★★ WS4b §0-AU 확대 — **뒤 넷은 실측이다**(리서치 메모 §E.2). 확대 전에 이 함수를 여덟
 *   문자열로 태운 결과, 앞 여섯 갈래(`not logged in` 계열)에 걸린 둘만 맞았고 나머지는 전부
 *   `provider_no_terminal_record` 로 나갔다 — 401 도, 게이트웨이 자격증명 실패도 사용자에게는
 *   "The claude event stream ended without a final record" 였다. 그 문장은 조치가 불가능하다:
 *   읽는 사람은 스트림을 의심하며 벤더 로그를 뒤지고, 정작 고칠 것(로그인·구성)은 어디에도 없다.
 *
 * ★ 맨 `401` 은 **여전히 일부러 뺐다** — 벤더가 stderr 에 찍는 숫자와 우연히 겹친다. 잡는 것은
 *   그 옆의 `authentication_error` 토큰이다(Anthropic API 오류 본문의 `error.type`). 확대가
 *   그 판단을 뒤집으면 `401 files changed` 같은 줄이 인증 실패가 된다(테스트가 그 대조군이다).
 *
 * ★ 뒤 셋은 게이트웨이(Bedrock/Vertex) 배포에서만 나오는 문장이다. WS4b 의 게이트웨이 탐지가
 *   그 구성을 크레딧 전에 거부하므로 이 셋은 **닿기 어려워지지만 0 이 되지는 않는다** — 탐지는
 *   부모 env 만 보고, 자식이 다른 경로(예: `~/.aws` 프로파일)로 같은 실패에 이르는 길은 남는다.
 *   그때도 「스트림이 안 끝났다」보다는 「자격이 거부됐다」가 참이다.
 */
const AUTH_TEXT = /not (?:logged in|authenticated)|please (?:run )?\/?login|login required|invalid api key|unauthorized|authentication (?:failed|required)|authentication_error|could not load credentials|unrecognizedclientexception|accessdeniedexception/i;

/**
 * usage 한도로 읽는 문구. **실측**(test/captures/codex-exec-error.jsonl 3-4줄,
 * test/live/_helpers.mjs:21 이 같은 정규식을 적어 두었다).
 *
 * ★★ `credit balance` 는 WS4b 가 더했다(메모 §E.2 의 넷째 행, claude 실측). **인증 가족에 넣지
 *   않는 것이 요점이다**: 잔액이 바닥난 계정은 멀쩡히 로그인돼 있고, 거기에 "installed but not
 *   logged in … Log in to the CLI" 를 내보내면 조치가 아무 일도 안 하는 틀린 문장이 된다. 한도
 *   가족의 회복("run with the other vendor")은 그 상황에서 실제로 쓸모가 있다. 기존 `credits`
 *   철자는 복수라 `Credit balance` 를 안 잡는다(실측) — 그래서 갈래를 더한다.
 */
const USAGE_LIMIT_TEXT = /usage limit|credit balance|credits/i;

/** rate_limit_info.status 중 "아직 허용" 으로 읽는 접두. 실측된 값은 `allowed_warning` 하나다. */
const RATE_LIMIT_ALLOWED = /^allowed/i;

// ── 공용 항목 ─────────────────────────────────────────────────────────────
// 두 벤더가 **똑같이** 쓰는 항목만 여기 둔다. 벤더마다 다른 것(호출부 버그 코드·rate-limit 신호)은
// 각 표에서 스프레드 사이에 끼운다 — 순서가 우선순위이므로 자리도 계약이다.

/** resolveBinary·spawn 이 낸 결함. `cli_*` 는 우리가 던진 코드, `spawn_*` 는 OS errno 다. */
const LAUNCH_ENTRIES = {
  cli_not_found: { reasonCode: REASON.provider_cli_not_found, excerpt: false, match: { code: 'cli_not_found' } },
  cli_shim_only: { reasonCode: REASON.provider_cli_shim_only, excerpt: false, match: { code: 'cli_shim_only' } },
};

const SPAWN_ENTRIES = {
  spawn_enoent: { reasonCode: REASON.provider_spawn_failed, excerpt: true, match: { errno: 'ENOENT' } },
  spawn_denied: { reasonCode: REASON.provider_spawn_denied, excerpt: true, match: { errno: ['EACCES', 'EISDIR', 'EPERM'] } },
  // Windows 에서 `.cmd` 를 shell:false 로 띄우면 동기 EINVAL(resolve-binary.mjs:13 실측) — 자식이
  // 아예 안 떴으므로 붙일 stderr 가 없다.
  spawn_shim_refused: { reasonCode: REASON.provider_spawn_denied, excerpt: false, match: { errno: 'EINVAL' } },
};

/** 프로세스가 끝난 사정. **우리가 끊은 둘**(신호·자체 상한)이 시그널보다 먼저다. */
const PROCESS_ENTRIES = {
  // ★★ WS3 §0-C1. 예전 이름은 `cancelled` 였고 코드는 `REASON.run_cancelled` 였다 — 그런데
  //   `aborted` 를 세우는 유일한 신호는 우리가 벤더에게 준 것이고, 그것은 이제 마감과 호스트
  //   취소가 **접힌 하나**다(`src/deadline.mjs haltSignal`). 즉 이 표는 「우리가 끊었다」까지만
  //   알고 「누가 껐는가」는 원리적으로 모른다. 그래서 카탈로그는 취소를 정하지 않는다: 중립
  //   이름 하나로 「우리가 이 호출을 끊었다」를 적고, 실행 수준의 사유는 신호 소스를 읽는
  //   엔진(`haltReasonCode`)이 정한다(WS2 §14 — 사유는 결함 분류가 아니라 신호 앞에 둔다).
  //   그 전에는 우리 마감이 벤더 장부와 실행 로그에 `run_cancelled` 로 적혔다(메모 §C.1 실측).
  // ★★ 최종 리뷰 I1: **이름이 실제로 중립이 됐다.** WS3 은 이 자리에 `provider_deadline_exceeded`
  //   를 두었는데 그것은 중립이 아니다 — 호스트가 끊은 실행의 블로커·벤더 장부·실행 로그가
  //   "The claude writer call ran out of time … Raise wait_ms and retry the run" 을 실었다(정지
  //   버튼을 누른 사용자에게 하는 말이다). `provider_call_halted` 는 「이 호출이 끊겼다」까지만
  //   말하고, 왜인지는 신호 소스를 읽는 엔진이 실행 수준에서 답한다.
  halted: { reasonCode: REASON.provider_call_halted, excerpt: false, match: { aborted: true } },
  deadline: { reasonCode: REASON.provider_deadline_exceeded, excerpt: false, match: { timedOut: true } },
  signal_killed: {
    reasonCode: REASON.provider_signal_killed,
    excerpt: false,
    match: { signal: true, timedOut: false, aborted: false },
  },
  // spec §3.2 은 `{stderr:/…/, exit:1}` 을 적지만 exit 접합은 뺐다(M4): errors.json 의 auth_required.
  // gap 대로 src/ 엔 인증 감지가 없어 exit 코드는 test:live 없이 실측 불가(evidence:'unverified'
  // 가 그 표시) — 실측 없는 exit 은 다른 코드로 인증 실패를 내는 벤더에서 조용히 안 걸리니 코멘트로만.
  auth_required: {
    reasonCode: REASON.auth_login_required,
    excerpt: true,
    match: { text: AUTH_TEXT },
    evidence: 'unverified',
  },
};

/** 스트림과 종료 기록. 마지막이 exit 코드다 — 더 구체적인 것이 하나도 안 맞았을 때만 온다. */
const STREAM_ENTRIES = {
  stream_malformed: {
    reasonCode: REASON.provider_stream_unparsable,
    excerpt: false,
    match: { unparsableLines: '>0', noTerminal: true },
  },
  no_terminal_record: { reasonCode: REASON.provider_no_terminal_record, excerpt: false, match: { noTerminal: true } },
  // 벤더 자신의 상한(claude stop_reason:max_tokens·subtype:error_max_turns; codex 스트림엔 아직
  // 같은 신호가 없어 오늘은 안 걸린다). 원인이 모델 산문이라 발췌를 안 붙인다(§5.4).
  model_truncated: { reasonCode: REASON.provider_output_truncated, excerpt: false, match: { modelLimit: true } },
  exit_nonzero: { reasonCode: REASON.provider_exit_nonzero, excerpt: false, match: { exitNonzero: true } },
};

export const CLAUDE_ERROR_CATALOG = deepFreeze({
  ...LAUNCH_ENTRIES,
  // 다섯 호출부 버그. 예전에는 다섯이 한 문장이었다 — 어느 필드가 잘못됐는지가 사라졌다.
  caller_role_unknown: { reasonCode: REASON.config_role_unknown, excerpt: false, match: { code: 'unknown_role' } },
  caller_allowed_tools_missing: { reasonCode: REASON.config_allowed_tools_missing, excerpt: false, match: { code: 'allowed_tools_required' } },
  caller_tool_set_missing: { reasonCode: REASON.config_tool_set_missing, excerpt: false, match: { code: 'tool_set_required' } },
  caller_tool_pattern_unsafe: { reasonCode: REASON.config_tool_pattern_unsafe, excerpt: false, match: { code: 'unsafe_tool_pattern' } },
  caller_permission_mode_invalid: { reasonCode: REASON.config_permission_mode_invalid, excerpt: false, match: { code: 'invalid_permission_mode' } },
  ...SPAWN_ENTRIES,
  ...PROCESS_ENTRIES,
  // ★ `rate_limit_info` 는 실측(캡처 5줄)이지만 막는 status 철자는 실측이 없다 — 캡처엔
  //   `allowed_warning` 하나뿐이라 "허용이 아니면 막힘" 으로 읽는다.
  rate_limited: {
    reasonCode: REASON.provider_rate_limited,
    excerpt: true,
    match: { rateLimitBlocked: true },
    evidence: 'unverified',
  },
  // ★★ WS4b §0-AU. codex 에만 있던 문구 매처가 claude 에도 생겼다 — `Credit balance is too low`
  //   는 claude 쪽 실측인데(메모 §E.2) 위 `rate_limited` 는 **구조 신호**(`rate_limit_info`)만
  //   보므로 그 문장은 어느 항목에도 안 걸리고 스트림 결함으로 떨어졌다. 자리는 구조 신호
  //   **뒤**다: 벤더가 구조로 말한 것이 문구 추측보다 낫다.
  usage_limit: { reasonCode: REASON.provider_rate_limited, excerpt: true, match: { text: USAGE_LIMIT_TEXT } },
  ...STREAM_ENTRIES,
});

export const CODEX_ERROR_CATALOG = deepFreeze({
  ...LAUNCH_ENTRIES,
  caller_role_unknown: { reasonCode: REASON.config_role_unknown, excerpt: false, match: { code: 'unknown_role' } },
  caller_argument_unsafe: { reasonCode: REASON.config_argument_unsafe, excerpt: false, match: { code: 'unsafe_argument' } },
  caller_flag_banned: { reasonCode: REASON.config_flag_banned, excerpt: false, match: { code: 'banned_flag' } },
  ...SPAWN_ENTRIES,
  ...PROCESS_ENTRIES,
  // ★ 문구 하나로 잡는다 — 실측 캡처는 같은 문장을 평평한 `error` 와 감싼 `turn.failed` 둘 다로
  //   내는데, `turn.failed` 를 함께 요구하면 평평한 오류만 온 실행이 한도 소진을 잃고 잘못 보고된다.
  usage_limit: { reasonCode: REASON.provider_rate_limited, excerpt: true, match: { text: USAGE_LIMIT_TEXT } },
  // codex 는 실패를 stderr 아닌 **스트림 이벤트**로 말한다(stderr 는 종종 비어 있다) — WS0 §2.5 의
  // `source:'stderr'` 가 이 채널을 못 서술해 발췌로는 안 붙는다.
  turn_failed: { reasonCode: REASON.provider_turn_failed, excerpt: false, match: { turnStatus: 'failed' } },
  ...STREAM_ENTRIES,
});

// M3: 오타가 조용히 죽은 항목으로 남지 않게 모듈 로드에서 던진다 — 데이터 오류는 import 에서 죽는다.
assertUnparsableLinesSpelling('claude', CLAUDE_ERROR_CATALOG);
assertUnparsableLinesSpelling('codex', CODEX_ERROR_CATALOG);

/**
 * git 결함 — `src/git.mjs` 가 **오늘 실제로 구분하는** 다섯 가지뿐이다.
 *
 * ★ stderr 정규식이 없다. git 은 어느 프로브가 실패했는지로 결함이 갈리고(`runGit` 의 봉투 +
 *   `inspectRepo` 의 순서), 그것은 사이트가 아는 사실이다 — 문구를 추측해 맞히는 것보다 정확하다.
 *   Task 14 가 그 사이트에서 `gitFault(<키>)` 를 **키로** 부른다 — `matches()` 는 이 표를 안
 *   본다. `when` 은 그래서 실행 안 되는 **문서 문자열**이다(M1: 옛 `match:{probe,ok,belowFloor}` 는
 *   MATCHERS 에 없는 키뿐이라 죽은 필드였다 — 실행되는 척하느니 이름을 갈라 죽었음을 드러낸다).
 */
export const GIT_ERROR_CATALOG = deepFreeze({
  // git 을 돌리지도 않은 결함 — 붙일 stderr 가 없다.
  project_path_unusable: { reasonCode: REASON.git_project_root_not_canonical, excerpt: false, when: 'stat probe on the project path failed (probe: stat, ok: false)' },
  cli_unavailable: { reasonCode: REASON.git_cli_unavailable, excerpt: true, when: 'version probe could not run git at all (probe: version, ok: false)' },
  version_below_floor: { reasonCode: REASON.git_version_below_floor, excerpt: true, when: 'version probe ran but the version is below the floor (probe: version, belowFloor: true)' },
  repository_missing: { reasonCode: REASON.git_repository_missing, excerpt: true, when: 'gitDir probe found no .git directory (probe: gitDir, ok: false)' },
  head_unborn: { reasonCode: REASON.git_head_unborn, excerpt: true, when: 'head probe found no commits yet (probe: head, ok: false)' },
});

/**
 * 실패가 아닌 두 행. **실패 표에 두지 않는다** — 두면 "모든 항목의 recovery 가 비어 있지 않다"
 * (EC1)를 예외로 뚫어야 한다. 문구는 `NOTICE_TEXT` 가 정본이고 여기는 그 키만 가리킨다 — 이름으로
 * (`.noticeKey`), `matches()` 없이. 그래서 `when` 은 git 표와 같은 이유로 실행 안 되는 문서
 * 문자열이다(M1). `native_windows_no_sandbox` 의 실제 조건은 `role:'write'` 가 아니라
 * `WRITE_ROLES.includes(role)`(worker·verifier, claude-args.mjs 정의) 다(M2).
 */
export const NOTICE_CATALOG = deepFreeze({
  native_windows_no_sandbox: { noticeKey: 'claude_windows_no_os_sandbox', when: 'write-role check WRITE_ROLES.includes(role) (worker or verifier) on platform win32' },
  tool_set_unsupported: { noticeKey: 'codex_tool_set_not_applied', when: 'tools were requested but codex has no flag that narrows its tool set' },
});

/** 벤더 이름 → 표. `Object.hasOwn` 으로만 읽는다(`__proto__` 로 표를 만들 수 없게). */
const CATALOGS = deepFreeze({ claude: CLAUDE_ERROR_CATALOG, codex: CODEX_ERROR_CATALOG });

/**
 * 라벨된 stderr 발췌를 **붙일 수 있는** reason code 의 닫힌 집합(spec §3.2 열거 = 로드맵의
 * spawn·auth·rate-limit·git 넷). 종료 코드·시그널·스트림·데드라인은 여기 없다(EC3).
 *
 * ★ 항목의 `excerpt` 가 실제 판정이고 이 배열은 **코드 층의 상한**이다 — 둘이 갈리면 붉어진다.
 *   이름은 `REASON.x` 로 부르고(오타는 `undefined`), 리터럴 **열거**는 테스트의 몫이다(EC3).
 */
export const EXCERPT_ALLOWED = Object.freeze([
  REASON.auth_login_required,
  REASON.git_cli_unavailable,
  REASON.git_head_unborn,
  REASON.git_repository_missing,
  REASON.git_version_below_floor,
  REASON.provider_rate_limited,
  REASON.provider_spawn_denied,
  REASON.provider_spawn_failed,
]);

/** 표 밖. `provider_outcome_unknown`(증명 불가)이 아니라 **분류 실패**다 — 그 둘은 다른 사실이다. */
const UNMATCHED = deepFreeze({ catalogKey: null, reasonCode: REASON.provider_error_unclassified, excerpt: false });

// ── 입력 정규화 ───────────────────────────────────────────────────────────

/** 속성 하나를 **던지지 않고** 읽는다 — 실패 객체의 getter 가 던지는 경우가 실제로 있다(util/errors.mjs 와 같은 이유). */
function read(value, key) {
  try {
    return value === null || value === undefined ? undefined : value[key];
  } catch {
    return undefined;
  }
}

const str = (value) => (typeof value === 'string' && value !== '' ? value : null);
const ERRNO = /^E[A-Z]+$/;

/**
 * 어떤 실패 입력이든 술어가 읽을 수 있는 평평한 모양으로. 입력은 두 종류다 — 우리가 던진/스폰이 낸
 * **오류 객체**(`code`·`path`·`role`)와 `runCli` 의 **실행 결과**(`spawnError`·`exitCode`·
 * `signalName`·`stderr`·스트림 필드) — 한 함수로 읽는다: 호출부가 고르게 하면 그 선택이 새 분기다.
 * ★ `streamed`: 오류 객체에도 `--version` 프로브 결과에도 `subtype`·`turnStatus` 가 없다 — 없다고
 *   "종료 기록이 안 왔다" 로 읽으면 호출부 버그·프로브 실패가 스트림 결함으로 오진된다. 두 스트림
 *   수집기는 `unknownTypes`·`unparsableLines` 를 **항상** 내므로 그 존재가 스트림 출처의 증거다.
 */
export function normalizeFailureInput(vendor, input) {
  const spawnError = read(input, 'spawnError');
  const source = spawnError !== null && typeof spawnError === 'object' ? spawnError : input;
  const code = str(read(source, 'code'));
  const errors = read(input, 'errors');
  const streamMessage = Array.isArray(errors) ? str(read(errors[0], 'message')) : null;
  const stderr = str(read(input, 'stderr')) ?? '';
  const message = streamMessage ?? str(read(source, 'message'));
  const exitCode = read(input, 'exitCode') ?? read(source, 'exitCode');
  const rateLimitStatus = str(read(read(input, 'rateLimit'), 'status'));
  const terminal = vendor === 'codex' ? read(input, 'turnStatus') : read(input, 'subtype');
  const unparsable = read(input, 'unparsableLines');
  const streamed = Array.isArray(unparsable) || Array.isArray(read(input, 'unknownTypes'));

  return {
    code: code !== null && ERRNO.test(code) ? null : code,
    errno: code !== null && ERRNO.test(code) ? code : null,
    signal: str(read(input, 'signalName') ?? read(input, 'signal')),
    timedOut: read(input, 'timedOut') === true,
    aborted: read(input, 'aborted') === true,
    // 두 채널을 함께 본다: claude 는 stderr 에, codex 는 스트림 이벤트에 사유를 남긴다.
    text: [message, stderr].filter((part) => str(part) !== null).join('\n'),
    turnStatus: str(read(input, 'turnStatus')),
    rateLimitBlocked: rateLimitStatus !== null && !RATE_LIMIT_ALLOWED.test(rateLimitStatus),
    unparsableLines: Array.isArray(unparsable) ? unparsable.length : 0,
    noTerminal: streamed && (terminal === null || terminal === undefined),
    modelLimit: streamed && (read(input, 'stopReason') === 'max_tokens' || terminal === 'error_max_turns'),
    exitNonzero: Number.isInteger(exitCode) && exitCode !== 0,
    exitCode: Number.isInteger(exitCode) ? exitCode : null, // M4: exit 매처(정확한 코드)의 재료.
    path: str(read(source, 'path')),
    role: str(read(source, 'role')),
  };
}

/** `match` 키 하나하나의 판정. 모르는 키는 **불일치**다(오타가 표를 조용히 넓히지 못한다); `text`
 * 아래 값이 RegExp 가 아니어도 던지지 않고 불일치로 접는다(M3 — describeFailure 는 절대 안 던진다). */
const MATCHERS = {
  code: (want, got) => got.code === want,
  errno: (want, got) => (Array.isArray(want) ? want.includes(got.errno) : got.errno === want),
  signal: (want, got) => want === (got.signal !== null),
  timedOut: (want, got) => want === got.timedOut,
  aborted: (want, got) => want === got.aborted,
  text: (want, got) => want instanceof RegExp && got.text !== '' && want.test(got.text),
  turnStatus: (want, got) => got.turnStatus === want,
  rateLimitBlocked: (want, got) => want === got.rateLimitBlocked,
  unparsableLines: (want, got) => want === '>0' && got.unparsableLines > 0, // 다른 철자는 assertUnparsableLinesSpelling 이 모듈 로드에서 던진다(M3).
  noTerminal: (want, got) => want === got.noTerminal,
  modelLimit: (want, got) => want === got.modelLimit,
  exitNonzero: (want, got) => want === got.exitNonzero,
  exit: (want, got) => got.exitCode === want, // M4: spec §3.2 의 `exit:1` 접합 — 정확한 종료 코드.
};

/** 표에 쓸 수 있는 `match` 키 전부. 테스트가 이것으로 죽은 키를 잡는다. */
export const MATCH_KEYS = Object.freeze(Object.keys(MATCHERS));

/** unparsableLines 철자는 '>0' 뿐(M3) — 다른 철자는 늘 불일치라 조용히 죽는다, 그래서 표 구성
 * 시점(모듈 로드)에 던진다. 벤더 표에만 해당 — git·notice 는 match 가 없다. */
export function assertUnparsableLinesSpelling(vendor, table) {
  for (const [key, entry] of Object.entries(table)) {
    const want = entry.match.unparsableLines;
    if (want !== undefined && want !== '>0') throw new Error(`error-catalog: ${vendor}.${key}.match.unparsableLines must be '>0', got ${JSON.stringify(want)}`);
  }
}

/** 카탈로그 항목의 match 판정 — 모르는/기형 match 는 불일치(테스트가 fail-closed 를 재려고 export, M3). */
export function matches(match, got) {
  if (match === null || typeof match !== 'object') return false;
  for (const [key, want] of Object.entries(match)) {
    if (!Object.hasOwn(MATCHERS, key)) return false;
    if (!MATCHERS[key](want, got)) return false;
  }
  return true;
}

// ── 조회 ──────────────────────────────────────────────────────────────────

/**
 * 벤더 표를 순서대로 조회한다. 첫 일치가 이기고, 없으면 `provider_error_unclassified`.
 * @returns {{catalogKey: string|null, reasonCode: string, excerpt: boolean}}
 */
export function classifyProviderFailure(vendor, input) {
  if (typeof vendor !== 'string' || !Object.hasOwn(CATALOGS, vendor)) return UNMATCHED;
  let got;
  try {
    got = normalizeFailureInput(vendor, input);
  } catch {
    // 정규화가 깨져도 분류는 답을 낸다 — "모른다" 도 답이다.
    return UNMATCHED;
  }
  for (const [catalogKey, entry] of Object.entries(CATALOGS[vendor])) {
    if (matches(entry.match, got)) {
      return deepFreeze({ catalogKey, reasonCode: entry.reasonCode, excerpt: entry.excerpt });
    }
  }
  return UNMATCHED;
}

/**
 * 카탈로그 항목 하나 → 프로바이더가 봉투에 실을 것. **절대 던지지 않는다.**
 *
 * @returns {{reasonCode, excerpt, catalogKey, vendor, exitCode, error, recovery}} — `vendor`·`exitCode` 는 로그·발췌 라벨용.
 */
export function describeFailure(vendor, input) {
  const name = str(vendor) ?? UNKNOWN_VALUE;
  try {
    // M3: classifyProviderFailure 도 try 안 — 표 조회가 깨져도 여기 catch 로 떨어진다.
    const hit = classifyProviderFailure(vendor, input);
    const got = normalizeFailureInput(vendor, input);
    // 문구가 요구할 수 있는 인자를 다 넘긴다 — `renderReason` 은 템플릿에 있는 이름만 읽고,
    // **빠진 이름에는 던진다**. 값이 없으면 그 사실을 토큰으로 말한다.
    const { error, recovery } = renderReason(hit.reasonCode, {
      vendor: name,
      path: got.path ?? UNKNOWN_VALUE,
      role: got.role ?? UNKNOWN_VALUE,
    });
    return { reasonCode: hit.reasonCode, excerpt: hit.excerpt, catalogKey: hit.catalogKey, vendor: name, exitCode: got.exitCode, error, recovery };
  } catch {
    // 렌더가 깨지면 호출부는 오류를 보고할 방법이 없어진다. 자리표시자가 `{vendor}` 하나뿐인
    // 코드로 한 번 더 내려간다 — 그 값은 우리 자신의 상수라 여기서 또 던질 수 없다.
    const { error, recovery } = renderReason(REASON.provider_error_unclassified, { vendor: name });
    return { reasonCode: REASON.provider_error_unclassified, excerpt: false, catalogKey: null, vendor: name, exitCode: null, error, recovery };
  }
}

/**
 * 실패한 실행의 결과에 실을 세 조각 — `failure`(코드·발췌 여부·표 키·벤더·종료 코드)와 문구 둘.
 * 프로바이더는 `Object.assign(envelope, failureFields(...))` 한 줄로 봉투를 채운다.
 */
export function failureFields(vendor, input) {
  const got = describeFailure(vendor, input);
  return {
    failure: { reasonCode: got.reasonCode, excerpt: got.excerpt, catalogKey: got.catalogKey, vendor: got.vendor, exitCode: got.exitCode },
    error: got.error,
    recovery: got.recovery,
  };
}

/** git 결함 하나를 키로 조회한다(Task 14 의 입구). 모르는 키는 분류 실패다. */
export function gitFault(catalogKey) {
  if (typeof catalogKey !== 'string' || !Object.hasOwn(GIT_ERROR_CATALOG, catalogKey)) return UNMATCHED;
  const entry = GIT_ERROR_CATALOG[catalogKey];
  return deepFreeze({ catalogKey, reasonCode: entry.reasonCode, excerpt: entry.excerpt });
}

// ── 실패 판정 · 발췌 재료 ────────────────────────────────────────────────

/**
 * 이 실행은 실패인가(§3.2): (1) 시그널을 맞았다, (2) 종료 코드를 모르는데 종료 기록도 없다, (3)
 * 종료 코드가 0 이 아니다. 인자가 없으면 (2)다. ★ 옛 판정 `exitCode!==0 && exitCode!==null` 은
 * **null 을 통과시켰다** — POSIX 시그널 킬은 exitCode 가 null 이라 `failed` 가 거짓이 되고 원인이
 * 사라졌다(errors.json signal_killed.criticalGap). ★ (2)가 `exitCode===null` 하나가 아닌 이유:
 * 하드 데드라인이 파이프를 안 기다리고 나오면 코드는 못 봐도 결과는 완전한 경우가 있다(run-cli.mjs
 * 의 `hung`) — 그걸 실패로 보고하면 run-cli 가 180 회 중 13 회 재현한 오탐을 되살린다.
 */
export function providerFailed({ exitCode = null, signal = null, terminalRecord = false } = {}) {
  if (signal !== null && signal !== undefined) return true;
  if (exitCode === null || exitCode === undefined) return terminalRecord !== true;
  return exitCode !== 0;
}

/**
 * stderr 의 꼬리 ≤4 KiB 와 **원문** 바이트 수 — 발췌의 재료다. ★ 스크럽 안 함 — 세척은 실행별
 * 루트를 아는 봉투 조립(Task 10)의 몫이고 미리 하면 두 번 세척된다(§3.4). 머리가 아니라 **꼬리**를
 * 남긴다(죽기 직전 줄이 사유) — 바이트 경계에 걸친 멀티바이트 글자는 반쪽을 버린다.
 */
export function stderrTail(text, limit = STDERR_TAIL_BYTES) {
  const source = typeof text === 'string' ? text : '';
  const buffer = Buffer.from(source, 'utf8');
  if (buffer.length <= limit) return { bytes: buffer.length, text: source };
  let start = buffer.length - limit;
  // 0b10xxxxxx 는 이어지는 바이트다. 글자 경계까지 앞으로 버린다.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return { bytes: buffer.length, text: buffer.subarray(start).toString('utf8') };
}

/** 스트림이 우리 어휘 밖에서 무엇을 봤는가(§3.4). 봉투엔 **수**와 **타입 이름**만 — 읽지 못한 줄의
 * 원문은 모델 산문일 수 있어(불변식 4) 로그에만 남는다. */
export function driftOf(collected) {
  const unknownTypes = read(collected, 'unknownTypes');
  const unparsable = read(collected, 'unparsableLines');
  return {
    unknownTypes: Array.isArray(unknownTypes) ? [...unknownTypes] : [],
    unparsableLines: Array.isArray(unparsable) ? unparsable.length : 0,
  };
}
