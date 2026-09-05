/**
 * claude 프로바이더 — contract.mjs 의 네 함수(`CONTRACT_METHODS`) 뒤로 기존 조각을
 * 조립한다. 계획 3 태스크 9 가 `pickModel` 을 지운 뒤 quality-gate preflight 가 추가됐다.
 *
 * 범용 코드는 이 파일의 존재를 알 뿐, 안에서 resolveBinary/buildClaudeArgs/runClaude 를
 * 어떻게 엮었는지는 몰라야 한다. 새 로직은 여기 최소로 둔다 — 나머지는 이미 개별
 * 리뷰를 거친 조각들이다.
 */
import { resolveLaunch as defaultResolveLaunch } from './resolve-binary.mjs';
import { buildClaudeArgs, WRITE_ROLES } from './claude-args.mjs';
import { runClaude } from './claude-run.mjs';
import { isTruncated, rateLimitFacts } from './claude-stream.mjs';
import { AUTH_COMMAND_TEXT, findAuthQueryCommand, findHelpCommand, parseClaudeHelp } from './discover-parse.mjs';
import { CLAUDE_AUTH_NAMES } from './child-env.mjs';
import { oncePerSignal, PROBE_TIMEOUT_MS, runCli } from './run-cli.mjs';
import {
  CLAUDE_ERROR_CATALOG,
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
const VENDOR = 'claude';

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
 * 설계 §5.1: native Windows 에는 OS 샌드박스가 없다 — 네트워크는 커널이 아니라
 * --allowedTools 로만 막힌다. 쓰기 역할(worker/verifier)이 이 플랫폼에서 돌 때만
 * 알린다. 읽기 전용 역할은 도구를 아예 안 쓰므로 이 격차가 무의미하다.
 *
 * ★ 실측으로 정정(설계 §12.0): --allowedTools 는 실행을 **제한하지 못한다**.
 *   bypassPermissions·dontAsk·acceptEdits·기본 모드 어디서도 목록 밖 명령이 그대로
 *   실행됐고 permission_denials 도 비어 있었다. 그러니 "allowedTools 로 제한된다"고
 *   알리면 거짓말이다 — 문구가 그 사실을 그대로 말한다(`NOTICE_TEXT` 가 정본).
 */
function sandboxNotice(role, platform) {
  if (!WRITE_ROLES.includes(role) || platform !== 'win32') return null;
  return renderNotice(NOTICE_CATALOG.native_windows_no_sandbox.noticeKey);
}

/**
 * 계약 메서드. **표 조회 하나**다(WS2 §3.2) — 예전의 if-체인은 다섯 결함을 한 문장으로
 * 뭉치고 스폰·시그널·스트림 결함을 아예 분류하지 않았다. 문구는 `REASON_TEXT` 가 정본이다.
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
    const launch = await resolveLaunchFn({ basename: 'claude', execPathVar: 'CLAUDE_CODE_EXECPATH' });
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

async function discover(signal, deps = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));

  let launch;
  try {
    // await 한다. resolveLaunch 가 프라미스를 돌려주면 거부가 이 try 로 안 들어와
    // 처리되지 않은 거부가 되고, 현재 Node 는 그걸로 프로세스를 죽인다(리뷰어 실측).
    launch = await resolveLaunchFn({ basename: 'claude', execPathVar: 'CLAUDE_CODE_EXECPATH' });
  } catch (error) {
    return { reachable: false, ...describeError(error) };
  }

  const versionResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ['--version'],
    instruction: '',
    signal,
    authNames: CLAUDE_AUTH_NAMES,
  });
  if (versionResult.spawnError || (versionResult.exitCode !== 0 && versionResult.exitCode !== null)) {
    // 결과를 통째로 넘긴다 — 카탈로그가 spawnError·exitCode·stderr 를 스스로 읽는다.
    return { reachable: false, ...describeError(versionResult) };
  }
  const version = typeof versionResult.text === 'string' ? versionResult.text.trim() : undefined;

  const helpResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ['--help'],
    instruction: '',
    signal,
    authNames: CLAUDE_AUTH_NAMES,
  });
  const { aliases, efforts } = parseClaudeHelp(helpResult.text ?? '');
  const models = aliases.map((name) => ({
    name,
    efforts,
    defaultEffort: efforts[0] ?? null,
    contextWindow: null,
  }));

  return { reachable: true, version, models };
}

async function run({
  role,
  model = null,
  effort = null,
  instruction = '',
  workspace,
  allowedTools = [],
  // contract.mjs 의 범용 이름. claude 에서는 **강제되는 도구 집합**(`--tools`)이다 —
  // `--allowedTools` 는 실행을 제한하지 못한다(설계 §12.0 실측).
  tools,
  signal,
  onProgress,
  onSpawn,
  runId,
  platform = process.platform,
  deps = {},
} = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;

  // ★ 계약상 run 은 던지지 않는다. 스폰 방법조차 못 찾는 경우(CLI 미설치)까지 포함이다.
  let launch;
  try {
    // await 한다. resolveLaunch 가 프라미스를 돌려주면 거부가 이 try 로 안 들어와
    // 처리되지 않은 거부가 되고, 현재 Node 는 그걸로 프로세스를 죽인다(리뷰어 실측).
    launch = await resolveLaunchFn({ basename: 'claude', execPathVar: 'CLAUDE_CODE_EXECPATH' });
  } catch (error) {
    return unstarted(model, error);
  }

  let args;
  try {
    args = deps.args ?? buildClaudeArgs({ role, model, effort, allowedTools, toolSet: tools });
  } catch (error) {
    return unstarted(model, error);
  }

  const runResult = await runClaude({
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

  // ★ 종료 기록 자체가 없으면 그것도 잘린 것이다.
  //
  //   isTruncated 는 stop_reason:'max_tokens' 와 subtype:'error_max_turns' 만 본다.
  //   timedOut/aborted 는 **우리가** 끊었을 때만 선다. 그래서 CLI 가 스스로 비정상
  //   종료하면서 result 라인을 한 번도 안 내면 셋 다 거짓이 되고, 불완전한 답이
  //   truncated:false 로 나간다(리뷰어가 die-midstream 스텁으로 실증).
  //
  //   codex 쪽은 turnStatus !== 'completed' 로 이 경우를 이미 잡는다. 같은 자세를
  //   취한다 — 종료 기록(subtype)이 없는데 깨끗하게 끝나지도 않았으면 잘린 것이다.
  //   claude-stream.mjs 가 적어둔 대로, 잘린 답을 성공으로 보고하면 학습이 잘못된
  //   보상을 받는다.
  const noTerminalRecord = runResult.subtype === null || runResult.subtype === undefined;
  const cleanExit = runResult.spawnError === null && runResult.exitCode === 0;
  const truncated =
    isTruncated(runResult) ||
    runResult.timedOut === true ||
    runResult.aborted === true ||
    (noTerminalRecord && !cleanExit);
  const doneReason =
    runResult.stopReason ?? runResult.subtype ?? (runResult.timedOut ? 'timeout' : runResult.aborted ? 'aborted' : null);

  const envelope = {
    content: typeof runResult.text === 'string' ? runResult.text : '',
    model: model ?? null,
    promptTokens: runResult.usage?.inputTokens ?? null,
    evalTokens: runResult.usage?.outputTokens ?? null,
    truncated,
    doneReason,
    hung: runResult.hung === true, // 끊은 뒤에도 파이프가 안 닫혔다(run-cli) — settle 로그 줄이 싣는 한 비트.
    // notice 는 답변이 아니라 실행에 대한 진술이다 — content 에 이어붙이지 않는다.
    notice: sandboxNotice(role, platform),
    // 실패가 아니면 null 이다. 키 자체는 항상 있다(위 unstarted 의 이유와 같다).
    failure: null,
    // ★ 읽지 못한 줄의 **수**만 나간다. 그 줄의 원문은 모델 산문일 수 있어 봉투에 못 싣는다.
    drift: driftOf(runResult),
    // ★ 벤더가 보낸 한도 수치. 예전에는 이 경계에서 통째로 사라졌다 — 오류 카탈로그가 `.status`
    //   하나를 불리언으로 접어 읽을 뿐이라, 막히지 **않은** 실행의 여유는 아무 데도 안 남았다
    //   (WS4b 메모 §G.3). 판단은 여전히 안 한다: 수 둘을 접어 나르고 문장은 알림 정본이 짓는다.
    rateLimit: rateLimitFacts(runResult.rateLimit),
    // 원문 꼬리다 — 세척은 발췌를 붙이는 쪽(Task 10)이 실행별 루트를 알고 한다.
    stderrTail: stderrTail(runResult.stderr),
  };

  // ★ 판정을 카탈로그에 맡긴다. 옛 판정은 `exitCode === null` 을 통과시켜 **시그널로 죽은 CLI 를
  //   실패로 세지 않았다**(errors.json criticalGap): 원인이 사라지고 truncated 만 남았다.
  if (providerFailed({ exitCode: runResult.exitCode, signal: runResult.signalName, terminalRecord: !noTerminalRecord })) {
    // content 는 그때까지 받은 것을 유지한다 — 부분 결과도 쓸모 있다.
    Object.assign(envelope, failureFields(VENDOR, runResult));
  }

  return envelope;
}


/**
 * 설계 §5.8 S2(a) — 쓰기 역할의 보안 하한.
 *
 * ★★ CVE-2026-40068: 2.1.84 미만 Claude Code 가 worktree `commondir` 신뢰 검증을 우회해
 *   hook 을 실행한다. 완화책 (c)(우리 git 호출의 `core.hooksPath` 등 강제)로는 못 막는다 —
 *   취약한 쪽은 **델리게이트 자신의 프로세스**이고, 우리가 쓰기 가능한 워크트리를 건네준
 *   CLI 를 우리 플래그로 묶을 수는 없다. 그래서 읽기 전용 역할은 그대로 두고 `worker` 만
 *   막는다. 이것이 설계가 말한 "read-only 로 강등" 이다.
 *
 * ★★ **모르면 막지 않는다.** 이 저장소의 평소 본능은 fail-closed 지만 여기서만 반대다:
 *   읽지 못한 버전은 "취약하다" 의 증거가 아니고, 추측하는 게이트는 버전 문자열 형식이
 *   바뀌는 날 멀쩡한 설치를 전부 벽돌로 만든다. 막아야 할 것보다 게이트가 더 위험해진다.
 *   실제로 파싱해서 실제로 하한 미만인 경우에만 막는다.
 *
 * ★ `preflight` 에 넣지 않은 이유: 그쪽은 CLI 를 실행하지 않는다는 계약이다(닫힌 계약 #9).
 *   그래서 자기 이름을 가진 선택적 메서드로 둔다 — 권고가 없는 프로바이더는 구현하지 않는다.
 */
const CLAUDE_WRITER_FLOOR = [2, 1, 84];

/** 자유형 버전 문자열에서 major.minor.patch 를 뽑는다. `src/git.mjs` 와 같은 모양이다. */
function parseCliVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(typeof text === 'string' ? text : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function meetsFloor(version, floor) {
  for (let i = 0; i < floor.length; i += 1) {
    const value = version[i] ?? 0;
    if (value > floor[i]) return true;
    if (value < floor[i]) return false;
  }
  return true;
}

async function securityFloor(signal, deps = {}) {
  const unknown = (reason) => ({ writable: true, version: null, reason });
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: 'claude', execPathVar: 'CLAUDE_CODE_EXECPATH' });
  } catch { return unknown('launch_unresolved'); }
  let result;
  try {
    result = await runFn({
      binary: launch.command,
      prefixArgs: launch.prefixArgs,
      args: ['--version'],
      instruction: '',
      signal,
      authNames: CLAUDE_AUTH_NAMES,
    });
  } catch { return unknown('version_probe_failed'); }
  if (!result || result.spawnError || (result.exitCode !== 0 && result.exitCode !== null)) {
    return unknown('version_probe_failed');
  }
  const parsed = parseCliVersion(result.text);
  if (parsed === null) return unknown('version_unparsed');
  const version = parsed.join('.');
  if (meetsFloor(parsed, CLAUDE_WRITER_FLOOR)) {
    return { writable: true, version, reason: 'meets_floor' };
  }
  // ★ 하한 값은 **필드로** 낸다(`floor`). 예전에는 한국어 문장 안에만 있었고, 문장을 옮기면
  //   그 수가 사라진다 — 조치하는 사람이 가장 먼저 물을 값이다. 문구는 정본이 정하고
  //   (`provider_below_security_floor` 의 회복이 `{floor}` 를 받는다), 엔진은 그 필드를 봉투
  //   인자와 로그의 평면 필드 둘 다로 나른다(`src/engine.mjs` 의 보안 하한 분기). 이 봉투의
  //   `error` 는 로그의 `detail` 로만 간다 — 봉투 문구는 코드가 정한다.
  const floor = CLAUDE_WRITER_FLOOR.join('.');
  const rendered = renderReason(REASON.provider_below_security_floor, { vendor: VENDOR, version, floor });
  return {
    writable: false,
    version,
    floor,
    reason: 'below_floor',
    reasonCode: rendered.reasonCode,
    error: rendered.error,
    recovery: rendered.recovery,
  };
}

/**
 * WS4b §0-AU — 인증 프로브. `securityFloor` 와 **같은 등급의 선택적 메서드**다.
 *
 * ★★ `preflight` 가 아닌 이유: 그쪽은 **CLI 를 실행하지 않는다**는 닫힌 계약이다(닫힌 계약 #9,
 *   `test/providers-conformance` 가 잰다). 프로브는 실행하므로 계약 넷 밖에 자기 이름으로 산다.
 *
 * ★★ **자식 환경 요구는 이 모양이 자동으로 만족시킨다.** 로드맵이 요구한 "인증 프로브는 자식
 *   환경에서 돌아야 한다" 는 새로 지을 것이 아니다 — 벤더 CLI 로 가는 모든 경로가
 *   `run-cli.mjs` 의 `buildChildEnv(env, {authNames, runId})` 하나를 지나므로, `runCli` 위에
 *   지은 프로브는 정의상 그 env 로 돈다. 여기서 하는 일은 `authNames` 를 **틀리지 않게** 넘기는
 *   것뿐이고(`CLAUDE_AUTH_NAMES` — `discover`·`securityFloor` 와 같은 값), 테스트는 주입한 `run`
 *   이 받는 인자로 그 사실을 못 박는다. 부모 env 의 게이트웨이 변수는 그 자식에 **안 들어간다** —
 *   그래서 게이트웨이 사용자는 여기서 답을 얻는 것이 아니라 엔진의 탐지에서 먼저 거부된다.
 *
 * ★★ **하위 명령 이름을 계약에 박지 않는다.** `--help` 를 먼저 파싱해 「인증을 다루는 명령이
 *   있는가」를 설명문으로 묻고(`AUTH_COMMAND_TEXT`), 그 명령의 `--help` 를 다시 파싱해 **읽기
 *   전용 조회** 하위 명령을 찾는다(`AUTH_STATUS_TEXT`). 조회를 못 찾으면 아무것도 실행하지 않고
 *   물러난다 — 이름을 모르는 명령을 그냥 부르면 프로브가 `logout` 을 눌러 사용자의 세션을 끊는
 *   사고가 난다. 캡처가 오늘 보여 주는 것은 `auth  Manage authentication` 한 줄뿐이고 그 아래는
 *   **미지**다(`test/captures/claude-help.txt:217`, 메모 §E.4) — 그래서 이 저장소에서 오늘 나오는
 *   답은 대개 `auth_unknown` 이고, 그것이 옳다.
 *
 * ★ **막지 않는 것이 기본값이다.** 미지 종료 코드도, 못 읽은 help 도, 스폰 실패도 전부
 *   `auth_unknown` 이다. 거부는 **확인된 미로그인** 하나뿐이고 그 판정은 이 함수가 아니라 벤더
 *   표가 한다(`classifyProviderFailure` → `auth_login_required`) — 인증 문구의 정본이 둘로 갈리면
 *   실행 중 실패와 크레딧 전 거부가 서로 다른 문장을 말한다.
 *
 * ★ **실행 대상은 조회로 확인된 것 하나뿐이다**(`findAuthQueryCommand`). 「설명문이 조회처럼
 *   들린다」로는 부족하다는 것이 실측이고(리뷰 C1), 그 술어의 근거는 저쪽 머리말에 있다.
 * ★ 스폰 셋에는 각각 상한이 붙고(`PROBE_TIMEOUT_MS`), 답은 **그 실행의 신호**로 메모된다
 *   (`oncePerSignal`) — 실행 하나에 스폰 한 벌이고 실행 사이 캐시는 없다(리뷰 I1).
 */
async function probeAuth(signal, deps = {}) {
  const unknown = (reason, extra = {}) => ({ status: AUTH_UNKNOWN, reason, subcommand: null, exitCode: null, ...extra });
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: 'claude', execPathVar: 'CLAUDE_CODE_EXECPATH' });
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
        authNames: CLAUDE_AUTH_NAMES,
      });
      return result !== null && typeof result === 'object' ? result : null;
    } catch { return null; }
  };
  /** help 는 **성공해야** 읽는다 — 실패한 실행의 부분 출력에서 명령 이름을 뽑으면 그것이 추측이다. */
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
  // ★ 두 채널을 **함께** 태운다. 표의 정규화기는 `stderr` 만 읽는데(`normalizeFailureInput`),
  //   인증 조회는 답을 stdout 으로 내는 것이 보통이다 — 한쪽만 보면 「로그인하세요」가 눈앞에
  //   찍혀 있는데도 프로브가 모른다고 답한다.
  const spoken = [result.text, result.stderr].filter((part) => typeof part === 'string' && part !== '').join('\n');
  const hit = classifyProviderFailure(VENDOR, { exitCode, stderr: spoken });
  if (hit.reasonCode === REASON.auth_login_required) {
    return { status: AUTH_NOT_LOGGED_IN, reason: 'status_reported_logged_out', subcommand, exitCode, reasonCode: hit.reasonCode };
  }
  // 종료 코드의 뜻은 이 저장소가 아직 **안 쟀다**(라이브 캡처가 컨트롤러 몫, 메모 §E.5).
  // 안 잰 수를 사실처럼 읽지 않는다 — 「모른다」가 답이고, 그 답은 아무것도 막지 않는다.
  return unknown('exit_unrecognized', { subcommand, exitCode });
}

/** 실행 하나에 프로브 하나(리뷰 I1). 열쇠는 그 실행의 신호이고, 신호가 없으면 메모도 없다. */
const authProbe = oncePerSignal(probeAuth);

export const claudeProvider = {
  id: VENDOR,
  preflight,
  discover,
  run,
  describeError,
  securityFloor,
  authProbe,
};

/** 로드맵 §3.4 "각 provider 모듈이 자기 표를 export" — 정본은 error-catalog.mjs 하나다. */
export { CLAUDE_ERROR_CATALOG as ERROR_CATALOG };
