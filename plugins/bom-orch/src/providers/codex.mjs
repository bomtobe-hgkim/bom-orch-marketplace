/**
 * codex 프로바이더 — contract.mjs 의 네 함수(`CONTRACT_METHODS`) 뒤로 기존 조각을
 * 조립한다. 계획 3 태스크 9 가 `pickModel` 을 지운 뒤 quality-gate preflight 가 추가됐다.
 *
 * claude.mjs 와 같은 구조다. 다른 점만 codex 쪽 조각(resolveLaunch 의 execPathVar
 * 없음, buildCodexArgs, runCodex, turnStatus 어휘, notice 없음)으로 바꿨다.
 */
import { resolveLaunch as defaultResolveLaunch } from './resolve-binary.mjs';
import { buildCodexArgs, READ_ONLY_ROLES } from './codex-args.mjs';
import { runCodex } from './codex-run.mjs';
import { parseCodexModels } from './discover-parse.mjs';
import { CODEX_AUTH_NAMES } from './child-env.mjs';
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
 * ★ codex 는 실패 사유가 두 경로로 흩어져 온다(codex-stream.mjs) — collect 결과의
 *   errors[0]?.message 를 stderr 보다 우선한다. 스트림 이벤트 쪽이 stderr 보다
 *   더 구조화된 사유를 담고 있다(실측: stderr 는 종종 비어 있고 오류는 JSON 이벤트로만 온다).
 */
function buildFailureError(runResult) {
  if (runResult.spawnError) return runResult.spawnError;
  const stderr = typeof runResult.stderr === 'string' ? runResult.stderr.trim() : '';
  const preferred = runResult.errors?.[0]?.message;
  const message = typeof preferred === 'string' && preferred !== '' ? preferred : stderr !== '' ? stderr : undefined;
  return {
    code: 'cli_exit_nonzero',
    exitCode: runResult.exitCode,
    stderr: runResult.stderr,
    message,
  };
}

function describeError(error) {
  try {
    const code = error && typeof error === 'object' ? error.code : undefined;

    if (code === 'cli_not_found') {
      const name = typeof error.binaryName === 'string' && error.binaryName !== '' ? error.binaryName : 'codex';
      return {
        error: `${name} CLI 를 PATH 에서 찾을 수 없습니다.`,
        recovery: 'codex CLI 를 설치하고 `codex --version` 이 동작하는지 확인하세요.',
      };
    }

    if (code === 'cli_shim_only') {
      const shimPath = typeof error.shimPath === 'string' ? error.shimPath : '경로 불명';
      return {
        error: `codex CLI 는 셸 셈만 발견됐습니다: ${shimPath}`,
        recovery: `네이티브 codex 실행 파일을 설치하세요(발견된 셈: ${shimPath}). 이 저장소는 shell:false 로만 스폰하므로 셈을 직접 실행할 수 없습니다.`,
      };
    }

    if (code === 'unknown_role' || code === 'unsafe_argument' || code === 'banned_flag') {
      return {
        error: `호출부 버그: ${extractMessage(error)}`,
        recovery: '델리게이트 호출 코드의 role/model/effort/cwd 값을 점검하세요.',
      };
    }

    return {
      error: extractMessage(error),
      recovery: 'codex 실행 로그(stderr)를 확인하거나 다시 시도하세요.',
    };
  } catch {
    // describeError 자신이 깨지면 호출부가 오류를 보고할 방법이 없어진다.
    return { error: '알 수 없는 오류', recovery: 'codex 실행 로그를 확인하세요.' };
  }
}

async function preflight(signal, deps = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? defaultResolveLaunch;
  try {
    const launch = await resolveLaunchFn({ basename: 'codex' });
    if (!launch || typeof launch.command !== 'string' || launch.command === '') {
      return {
        available: false,
        error: 'codex CLI 실행 경로를 확인하지 못했습니다.',
        recovery: 'codex CLI 설치와 PATH 설정을 확인하세요.',
      };
    }
    return { available: true };
  } catch (error) {
    if (error?.code === 'cli_not_found') return { available: false, ...describeError(error) };
    if (error?.code === 'cli_shim_only') {
      return {
        available: false,
        error: 'codex CLI 네이티브 실행 파일을 찾지 못했습니다.',
        recovery: '네이티브 codex 실행 파일을 설치하고 PATH 설정을 확인하세요.',
      };
    }
    return {
      available: false,
      error: 'codex CLI 실행 경로 확인에 실패했습니다.',
      recovery: 'codex CLI 설치와 PATH 설정을 확인하세요.',
    };
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
  return (
    'codex exec 에는 도구 집합을 좁히는 플래그가 없습니다 — 요청한 도구 목록' +
    `(${tools.join(', ')})은 이 실행에 적용되지 않았습니다. 셸은 살아 있고, 성립하는 경계는 ` +
    '--sandbox 의 파일시스템 범위(POSIX) 와 일회용 워크트리뿐입니다.'
  );
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
    return {
      reachable: false,
      ...describeError(versionResult.spawnError ?? { code: 'cli_exit_nonzero', stderr: versionResult.stderr }),
    };
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
    // codex 는 OS 샌드박스가 있어 샌드박스 격차는 알릴 것이 없다. 다만 호출부가 도구
    // 집합 제한을 요청했는데 이 CLI 에는 그 채널이 없으면 그 사실은 알려야 한다 —
    // 조용히 무시하면 호출부는 워커에게 Bash 가 없다고 믿는다.
    notice: toolSetNotice(tools),
  };

  const failed = runResult.spawnError || (runResult.exitCode !== 0 && runResult.exitCode !== null);
  if (failed) {
    // content 는 그때까지 받은 것을 유지한다 — 부분 결과도 쓸모 있다.
    Object.assign(envelope, describeError(buildFailureError(runResult)));
  }

  return envelope;
}

export const codexProvider = {
  id: 'codex',
  preflight,
  discover,
  run,
  describeError,
};
