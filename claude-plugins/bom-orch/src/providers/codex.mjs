/**
 * codex 프로바이더 — contract.mjs 의 네 함수(`CONTRACT_METHODS`) 뒤로 기존 조각을
 * 조립한다. 계획 3 태스크 9 가 `pickModel` 을 지운 뒤 quality-gate preflight 가 추가됐다.
 *
 * claude.mjs 와 같은 구조다. 다른 점만 codex 쪽 조각(resolveLaunch 의 execPathVar
 * 없음, buildCodexArgs, runCodex, turnStatus 어휘, 요청 도구 집합을 못 좁혔다는 notice)으로 바꿨다.
 */
import { resolveLaunch as defaultResolveLaunch } from './resolve-binary.mjs';
import { buildCodexArgs, READ_ONLY_ROLES } from './codex-args.mjs';
import { runCodex } from './codex-run.mjs';
import { AUTH_COMMAND_TEXT, findAuthQueryCommand, findHelpCommand, parseCodexModels } from './discover-parse.mjs';
import { CODEX_AUTH_NAMES } from './child-env.mjs';
import { oncePerSignal, PROBE_TIMEOUT_MS, runCli } from './run-cli.mjs';
import {
  CODEX_ERROR_CATALOG,
  NOTICE_CATALOG,
  classifyProviderFailure,
  describeFailure,
  driftOf,
  failureFields,
  providerFailed,
  stderrTail,
} from './error-catalog.mjs';
import { AUTH_NOT_LOGGED_IN, AUTH_UNKNOWN } from '../preflight.mjs';
import { REASON } from '../reason-codes.mjs';
import { renderNotice, renderReason } from '../reason-text.mjs';

/** 벤더 이름은 문구·분류·로그에서 같은 값이어야 한다 — 한 곳에 둔다. */
const VENDOR = 'codex';

/**
 * 스폰 전에 끝난 preflight 의 결과. 문구는 레지스트리가 정한다(WS2 Task 16).
 *
 * ★ `reasonCode` 를 함께 낸다 — 예전에는 한국어 문장 두 줄뿐이라 호출부가 "왜 못 쓰는가" 를
 *   문자열로만 알 수 있었다. 실행 경로는 절대 싣지 않는다(`test/providers-conformance` 가 잰다).
 */
function unavailable(code) {
  const rendered = renderReason(code, { vendor: VENDOR });
  return { available: false, reasonCode: rendered.reasonCode, error: rendered.error, recovery: rendered.recovery };
}

/**
 * 계약 메서드. **표 조회 하나**다(WS2 §3.2). 카탈로그가 codex 의 두 오류 채널을 함께 읽는다 —
 * 스트림 이벤트(`errors[0].message`)가 stderr 보다 구조화돼 있고, 실측상 stderr 는 종종 비어 있다.
 */
const describeError = (error) => describeFailure(VENDOR, error);

/**
 * 스폰 전에 끝난 실패의 결과. 벤더 CLI 는 한 번도 뜨지 않았다.
 *
 * ★ 키 집합이 정상 경로와 **같아야** 한다: 있다가 없다가 하면 호출부가 키 존재로 분기할 때
 *   어긋난다(`notice`·`doneReason` 이 이미 그렇게 하고 있고 `failure`·`drift`·`stderrTail` 도
 *   같은 규칙이다). 실행이 없었으므로 드리프트도 stderr 도 빈 값이다.
 */
function unstarted(model, error) {
  return {
    content: '',
    model: model ?? null,
    promptTokens: null,
    evalTokens: null,
    truncated: false,
    doneReason: null,
    notice: null,
    drift: driftOf(null),
    rateLimit: null,
    stderrTail: stderrTail(''),
    ...failureFields(VENDOR, error),
  };
}

async function preflight(signal, deps = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  try {
    const launch = await resolveLaunchFn({ basename: 'codex' });
    if (!launch || typeof launch.command !== 'string' || launch.command === '') {
      return unavailable(REASON.provider_cli_not_found);
    }
    return { available: true };
  } catch (error) {
    if (error?.code === 'cli_not_found') return { available: false, ...describeError(error) };
    if (error?.code === 'cli_shim_only') {
      return unavailable(REASON.provider_cli_shim_only);
    }
    return unavailable(REASON.provider_cli_not_found);
  }
}

/**
 * 호출부가 도구 집합 제한을 요청했는데 이 CLI 에 그 채널이 없다는 사실.
 *
 * `codex exec --help`(캡처 0.146.1)에는 도구 목록을 좁히는 플래그가 없다. 갈리는 것은
 * `--sandbox` 하나이고 그것은 파일시스템·네트워크 범위이지 도구 집합이 아니다. 그래서
 * "Bash 없는 워커" 를 codex 로는 만들 수 없다 — 이 실행에서 셸은 살아 있다.
 */
function toolSetNotice(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return renderNotice(NOTICE_CATALOG.tool_set_unsupported.noticeKey, { tools: tools.join(', ') });
}

async function discover(signal, deps = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));

  let launch;
  try {
    // await 한다. resolveLaunch 가 프라미스를 돌려주면 거부가 이 try 로 안 들어와
    // 처리되지 않은 거부가 되고, 현재 Node 는 그걸로 프로세스를 죽인다(리뷰어 실측).
    launch = await resolveLaunchFn({ basename: 'codex' });
  } catch (error) {
    return { reachable: false, ...describeError(error) };
  }

  const versionResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ['--version'],
    instruction: '',
    signal,
    authNames: CODEX_AUTH_NAMES,
  });
  if (versionResult.spawnError || (versionResult.exitCode !== 0 && versionResult.exitCode !== null)) {
    // 결과를 통째로 넘긴다 — 카탈로그가 spawnError·exitCode·stderr 를 스스로 읽는다.
    return { reachable: false, ...describeError(versionResult) };
  }
  const version = typeof versionResult.text === 'string' ? versionResult.text.trim() : undefined;

  const modelsResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ['debug', 'models'],
    instruction: '',
    signal,
    authNames: CODEX_AUTH_NAMES,
  });
  const parsed = parseCodexModels(modelsResult.text ?? '');

  return { reachable: true, version, models: parsed.ok ? parsed.models : [] };
}

async function run({
  role,
  model = null,
  effort = null,
  instruction = '',
  workspace,
  allowedTools: _allowedTools, // codex 는 --allowedTools 개념이 없다. --sandbox 로 갈린다(codex-args.mjs).
  // ★ contract.mjs 의 범용 이름. **codex exec 에는 도구 집합을 좁히는 플래그가 없다**
  //   (캡처된 --help, codex-cli 0.146.1). 갈리는 것은 `--sandbox` 뿐이라, 호출부가
  //   "Bash 없는 집합" 을 요청해도 codex 쪽에서는 그것을 argv 로 표현할 방법이 없다.
  //   조용히 무시하지 않고 아래에서 notice 로 알린다.
  tools,
  signal,
  onProgress,
  onSpawn,
  runId,
  deps = {},
} = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;

  // ★ 계약상 run 은 던지지 않는다. 스폰 방법조차 못 찾는 경우(CLI 미설치)까지 포함이다.
  let launch;
  try {
    // await 한다. resolveLaunch 가 프라미스를 돌려주면 거부가 이 try 로 안 들어와
    // 처리되지 않은 거부가 되고, 현재 Node 는 그걸로 프로세스를 죽인다(리뷰어 실측).
    launch = await resolveLaunchFn({ basename: 'codex' });
  } catch (error) {
    return unstarted(model, error);
  }

  let args;
  try {
    // planner/thinker 는 일회용 빈 디렉터리(저장소 아님)에서 돈다 — codex 는 그걸
    // 모르므로 skipGitRepoCheck 를 여기서 대신 결정한다. 호출부가 codex 의 이
    // 사정을 알 필요가 없다.
    args = deps.args ?? buildCodexArgs({ role, model, effort, cwd: workspace, skipGitRepoCheck: READ_ONLY_ROLES.includes(role) });

    // ★ 지시문을 **여기서** argv 끝에 붙인다.
    //
    //   codex exec 는 프롬프트를 위치 인자로 받고, 우리는 stdin 을 곧바로 닫는다
    //   (codex-run.mjs 의 sendStdin:false — 안 닫으면 stdin EOF 를 기다리며 멈춘다).
    //   그런데 buildCodexArgs 는 플래그만 만들고 지시문을 모른다. 둘 사이에 아무도
    //   프롬프트를 넣지 않아서, 실제 codex 호출이 지시문 없이 돌고 있었다 —
    //   리뷰어가 실제 CLI 로 확인했다: "No prompt provided via stdin."
    //
    //   deps.args 로 주입받은 경우(테스트)에는 붙이지 않는다. 그 경로는 스텁의
    //   모드 인자를 그대로 쓰기 때문이다.
    if (deps.args === undefined && typeof instruction === 'string' && instruction !== '') {
      args = [...args, instruction];
    }
  } catch (error) {
    return unstarted(model, error);
  }

  const runResult = await runCodex({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args,
    instruction,
    cwd: workspace,
    signal,
    onProgress,
    onSpawn,
    runId,
  });

  const truncated = runResult.turnStatus !== 'completed' || runResult.timedOut === true || runResult.aborted === true;
  const doneReason = runResult.turnStatus ?? (runResult.timedOut ? 'timeout' : runResult.aborted ? 'aborted' : null);

  const envelope = {
    content: typeof runResult.text === 'string' ? runResult.text : '',
    model: model ?? null,
    promptTokens: runResult.usage?.inputTokens ?? null,
    evalTokens: runResult.usage?.outputTokens ?? null,
    truncated,
    doneReason,
    hung: runResult.hung === true, // 끊은 뒤에도 파이프가 안 닫혔다(run-cli) — settle 로그 줄이 싣는 한 비트.
    // codex 는 OS 샌드박스가 있어 샌드박스 격차는 알릴 것이 없다. 다만 호출부가 도구
    // 집합 제한을 요청했는데 이 CLI 에는 그 채널이 없으면 그 사실은 알려야 한다 —
    // 조용히 무시하면 호출부는 워커에게 Bash 가 없다고 믿는다.
    notice: toolSetNotice(tools),
    // 실패가 아니면 null 이다. 키 자체는 항상 있다(위 unstarted 의 이유와 같다).
    failure: null,
    // ★ 읽지 못한 줄의 **수**만 나간다. 그 줄의 원문은 모델 산문일 수 있어 봉투에 못 싣는다.
    drift: driftOf(runResult),
    // ★ **언제나 null 이다.** 이 CLI 에는 claude 의 `rate_limit_event` 같은 구조 신호가 없고,
    //   한도 소진은 문구로만 온다(`USAGE_LIMIT_TEXT` → `provider_rate_limited`). 그래도 키는
    //   있다: 있다가 없다가 하면 호출부가 키 존재로 분기할 때 벤더별로 갈린다(위 unstarted 와
    //   같은 규칙). 벤더가 구조 신호를 보내기 시작하는 날 바뀌는 것은 이 한 줄뿐이다.
    rateLimit: null,
    // 원문 꼬리다 — 세척은 발췌를 붙이는 쪽(Task 10)이 실행별 루트를 알고 한다.
    stderrTail: stderrTail(runResult.stderr),
  };

  // ★ 판정을 카탈로그에 맡긴다. 옛 판정은 `exitCode === null` 을 통과시켜 **시그널로 죽은 CLI 를
  //   실패로 세지 않았다**(errors.json criticalGap): 원인이 사라지고 truncated 만 남았다.
  //   codex 의 종료 기록은 `turnStatus === 'completed'` 다 — 실패한 턴은 증거가 아니다.
  if (providerFailed({
    exitCode: runResult.exitCode,
    signal: runResult.signalName,
    terminalRecord: runResult.turnStatus === 'completed',
  })) {
    // content 는 그때까지 받은 것을 유지한다 — 부분 결과도 쓸모 있다.
    Object.assign(envelope, failureFields(VENDOR, runResult));
  }

  return envelope;
}

/**
 * WS4b §0-AU — 인증 프로브. `claude.mjs` 의 같은 함수와 **모양이 같다**(그쪽 머리말이 왜 이
 * 모양인지를 적는다: `preflight` 계약을 안 깨는 선택적 메서드 · `runCli` 위에 지어 자식 환경을
 * 자동으로 얻는다 · 하위 명령 이름은 설명문으로 발견한다 · 기본값은 막지 않는 `auth_unknown`).
 *
 * ★ codex 쪽 사정 하나가 다르다. 이 저장소의 캡처는 **`codex exec --help`** 뿐이고 거기에는
 *   인증 줄이 하나도 없다(`login`·`logout`·`auth`·`--api-key` 실측 0건, 메모 §E.4) — 그런데
 *   프로브가 묻는 것은 `codex --help`(최상위)이고 **그 캡처는 이 저장소에 없다**. 즉 codex 쪽
 *   답은 오늘 이 상자에서 예측할 수 없다. 그래서 픽스처가 아니라 컨트롤러의 라이브 세션이
 *   실제 이름과 종료 코드를 고정한다 — 여기서는 두 갈래(찾음·못 찾음)가 다 옳게 동작하는
 *   것까지만 증명하고, 어느 갈래가 실제인지는 주장하지 않는다.
 *
 * ★★ 그 캡처가 2026-08-25 에 왔다(`test/captures/vendor-auth-probe.json`). 실측 사슬은
 *   `codex --help` → `login  Manage login` → `codex login --help` → `status  Show login status`
 *   이고, **`login` 이 최상위 help 의 어떤 조회 낱말보다 먼저 온다** — 문서 순서 첫 일치로
 *   실행 대상을 고르면 곧바로 대화형 로그인을 누르는 배치다(리뷰 C1). 그래서 그룹 이름은 설명문
 *   첫 일치로 고르되(그 이름은 argv[0] = 네임스페이스이지 실행되는 동작이 아니다 — `login` 자신은
 *   `MUTATING_NAME` 이라 leaf 였다면 거부된다) 실행 대상 leaf 는 `findAuthQueryCommand` 가 고른다.
 */
async function probeAuth(signal, deps = {}) {
  const unknown = (reason, extra = {}) => ({ status: AUTH_UNKNOWN, reason, subcommand: null, exitCode: null, ...extra });
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: 'codex' });
  } catch { return unknown('launch_unresolved'); }

  const probe = async (args) => {
    try {
      const result = await runFn({
        binary: launch.command,
        prefixArgs: launch.prefixArgs,
        args,
        instruction: '',
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
        authNames: CODEX_AUTH_NAMES,
      });
      return result !== null && typeof result === 'object' ? result : null;
    } catch { return null; }
  };
  const helpOf = async (args) => {
    const result = await probe(args);
    if (result === null || result.spawnError || (result.exitCode !== 0 && result.exitCode !== null)) return null;
    return typeof result.text === 'string' ? result.text : '';
  };

  const rootHelp = await helpOf(['--help']);
  if (rootHelp === null) return unknown('help_unavailable');
  const command = findHelpCommand(rootHelp, AUTH_COMMAND_TEXT);
  if (command === null) return unknown('no_auth_command');
  const commandHelp = await helpOf([command, '--help']);
  if (commandHelp === null) return unknown('auth_help_unavailable', { subcommand: command });
  const query = findAuthQueryCommand(commandHelp);
  if (query === null) return unknown('no_read_only_query', { subcommand: command });

  const subcommand = `${command} ${query}`;
  const result = await probe([command, query]);
  if (result === null) return unknown('status_probe_failed', { subcommand });
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  // stdout 과 stderr 를 함께 태우는 이유는 claude 쪽과 같다 — 정규화기는 `stderr` 만 읽는다. ★ codex 는 실측상(2026-08-25 재측정, 스트림 분리) 로그인 산문("Logged in using …")을 stdout 이 아니라 stderr 로 낸다 — 합쳐 태우지 않으면 로그인된 사용자를 오분류할 자리는 없어도, 분류 근거 자체가 빈 문자열이 된다.
  const spoken = [result.text, result.stderr].filter((part) => typeof part === 'string' && part !== '').join('\n');
  const hit = classifyProviderFailure(VENDOR, { exitCode, stderr: spoken });
  if (hit.reasonCode === REASON.auth_login_required) {
    return { status: AUTH_NOT_LOGGED_IN, reason: 'status_reported_logged_out', subcommand, exitCode, reasonCode: hit.reasonCode };
  }
  return unknown('exit_unrecognized', { subcommand, exitCode });
}

/** 실행 하나에 프로브 하나(리뷰 I1) — claude 쪽과 같은 이유·같은 모양이다. */
const authProbe = oncePerSignal(probeAuth);

export const codexProvider = {
  id: VENDOR,
  preflight,
  discover,
  run,
  describeError,
  authProbe,
};

/** 로드맵 §3.4 "각 provider 모듈이 자기 표를 export" — 정본은 error-catalog.mjs 하나다. */
export { CODEX_ERROR_CATALOG as ERROR_CATALOG };
