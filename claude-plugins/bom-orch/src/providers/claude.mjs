/**
 * claude 프로바이더 — contract.mjs 의 세 함수(`CONTRACT_METHODS`) 뒤로 기존 조각을
 * 조립한다. 「네 함수」였던 것은 계획 3 태스크 9 가 `pickModel` 을 지우기 전 수다.
 *
 * 범용 코드는 이 파일의 존재를 알 뿐, 안에서 resolveBinary/buildClaudeArgs/runClaude 를
 * 어떻게 엮었는지는 몰라야 한다. 새 로직은 여기 최소로 둔다 — 나머지는 이미 개별
 * 리뷰를 거친 조각들이다.
 */
import { resolveLaunch as defaultResolveLaunch } from './resolve-binary.mjs';
import { buildClaudeArgs, WRITE_ROLES } from './claude-args.mjs';
import { runClaude } from './claude-run.mjs';
import { isTruncated } from './claude-stream.mjs';
import { parseClaudeHelp } from './discover-parse.mjs';
import { CLAUDE_AUTH_NAMES } from './child-env.mjs';
import { runCli } from './run-cli.mjs';

/** 어떤 입력에서도 사람이 읽을 문자열 메시지를 뽑는다. 절대 throw 하지 않는다. */
function extractMessage(error) {
  if (typeof error === 'string') return error !== '' ? error : '알 수 없는 오류';
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }
  // 마지막 수단. 객체를 통째로 문자열화하면 "[object Object]" 가 나와 아무 도움이
  // 안 된다(리뷰어 실측). 가진 것 중 쓸모 있는 것을 골라 쓴다.
  if (error && typeof error === 'object') {
    if (Number.isInteger(error.exitCode)) return `델리게이트가 종료 코드 ${error.exitCode} 로 끝났다`;
    if (typeof error.code === 'string' && error.code !== '') return error.code;
  }
  return '알 수 없는 오류';
}

/**
 * 실패한 실행에서 describeError 로 넘길 오류 객체를 만든다.
 *
 * spawnError 가 있으면 그것이 가장 구체적이다. 없으면(즉, 프로세스는 떴지만 0 이
 * 아닌 코드로 죽었으면) stderr 를 메시지 후보로 얹는다 — stub 도 실제 CLI 도 실패
 * 사유를 stderr 에 남긴다.
 */
function buildFailureError(runResult) {
  if (runResult.spawnError) return runResult.spawnError;
  const stderr = typeof runResult.stderr === 'string' ? runResult.stderr.trim() : '';
  return {
    code: 'cli_exit_nonzero',
    exitCode: runResult.exitCode,
    stderr: runResult.stderr,
    message: stderr !== '' ? stderr : undefined,
  };
}

/**
 * 설계 §5.1: native Windows 에는 OS 샌드박스가 없다 — 네트워크는 커널이 아니라
 * --allowedTools 로만 막힌다. 쓰기 역할(worker/verifier)이 이 플랫폼에서 돌 때만
 * 알린다. 읽기 전용 역할은 도구를 아예 안 쓰므로 이 격차가 무의미하다.
 */
function sandboxNotice(role, platform) {
  if (!WRITE_ROLES.includes(role) || platform !== 'win32') return null;
  // ★ 실측으로 정정(설계 §12.0): --allowedTools 는 실행을 **제한하지 못한다**.
  //   bypassPermissions·dontAsk·acceptEdits·기본 모드 어디서도 목록 밖 명령이
  //   그대로 실행됐고 permission_denials 도 비어 있었다. 명령 패턴 단위 제한은
  //   어느 플래그로도 성립하지 않는다.
  //
  //   그러니 "allowedTools 로 제한된다"고 알리면 거짓말이다. 실제로 성립하는
  //   격리는 일회용 워크트리(파일시스템 범위)뿐이라는 것을 그대로 말한다.
  return (
    'claude 는 native Windows 에서 OS 샌드박스 없이 돕니다. 실측 결과 --allowedTools 는 ' +
    '명령 실행을 제한하지 못하므로(설계 §12.0), 이 실행의 셸·네트워크 접근은 사실상 ' +
    '무제한입니다 — 실제 격리는 일회용 워크트리의 파일시스템 범위뿐입니다. ' +
    'WSL2/Linux 에서는 OS 샌드박스가 동작합니다.'
  );
}

function describeError(error) {
  try {
    const code = error && typeof error === 'object' ? error.code : undefined;

    if (code === 'cli_not_found') {
      const name = typeof error.binaryName === 'string' && error.binaryName !== '' ? error.binaryName : 'claude';
      return {
        error: `${name} CLI 를 PATH 에서 찾을 수 없습니다.`,
        recovery: 'Claude Code 를 설치하고 `claude --version` 이 동작하는지 확인하세요.',
      };
    }

    if (code === 'cli_shim_only') {
      const shimPath = typeof error.shimPath === 'string' ? error.shimPath : '경로 불명';
      return {
        error: `claude CLI 는 셸 셈만 발견됐습니다: ${shimPath}`,
        recovery: `네이티브 claude 실행 파일을 설치하세요(발견된 셈: ${shimPath}). 이 저장소는 shell:false 로만 스폰하므로 셈을 직접 실행할 수 없습니다.`,
      };
    }

    if (
      code === 'unknown_role' ||
      code === 'allowed_tools_required' ||
      code === 'tool_set_required' ||
      code === 'unsafe_tool_pattern' ||
      code === 'invalid_permission_mode'
    ) {
      return {
        error: `호출부 버그: ${extractMessage(error)}`,
        recovery: '델리게이트 호출 코드의 role/allowedTools/permissionMode 설정을 점검하세요.',
      };
    }

    return {
      error: extractMessage(error),
      recovery: 'claude 실행 로그(stderr)를 확인하거나 다시 시도하세요.',
    };
  } catch {
    // describeError 자신이 깨지면 호출부가 오류를 보고할 방법이 없어진다.
    return { error: '알 수 없는 오류', recovery: 'claude 실행 로그를 확인하세요.' };
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
    return {
      reachable: false,
      ...describeError(versionResult.spawnError ?? { code: 'cli_exit_nonzero', stderr: versionResult.stderr }),
    };
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
    return {
      content: '',
      model: model ?? null,
      promptTokens: null,
      evalTokens: null,
      truncated: false,
      doneReason: null,
      // 해당 없을 때도 키는 둔다. 있다가 없다가 하면 호출부가 키 존재로 분기할 때
      // 어긋난다 — doneReason 이 이미 그렇게 하고 있다.
      notice: null,
      ...describeError(error),
    };
  }

  let args;
  try {
    args = deps.args ?? buildClaudeArgs({ role, model, effort, allowedTools, toolSet: tools });
  } catch (error) {
    return {
      content: '',
      model: model ?? null,
      promptTokens: null,
      evalTokens: null,
      truncated: false,
      doneReason: null,
      // 해당 없을 때도 키는 둔다. 있다가 없다가 하면 호출부가 키 존재로 분기할 때
      // 어긋난다 — doneReason 이 이미 그렇게 하고 있다.
      notice: null,
      ...describeError(error),
    };
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
    // notice 는 답변이 아니라 실행에 대한 진술이다 — content 에 이어붙이지 않는다.
    notice: sandboxNotice(role, platform),
  };

  const failed = runResult.spawnError || (runResult.exitCode !== 0 && runResult.exitCode !== null);
  if (failed) {
    // content 는 그때까지 받은 것을 유지한다 — 부분 결과도 쓸모 있다.
    Object.assign(envelope, describeError(buildFailureError(runResult)));
  }

  return envelope;
}

export const claudeProvider = {
  id: 'claude',
  discover,
  run,
  describeError,
};
