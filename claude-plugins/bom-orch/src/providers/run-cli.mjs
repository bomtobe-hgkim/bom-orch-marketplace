import { spawn } from 'node:child_process';
import { buildChildEnv } from './child-env.mjs';

const WINDOWS = process.platform === 'win32';

/**
 * `stop()` 뒤 `close` 를 기다리는 유예. 이 시간을 넘기면 자식의 생사와 무관하게 결과를 낸다.
 *
 * `src/test-spawn.mjs` 의 같은 이름 상수와 같은 이유·같은 값이다: `kill()` 은 부탁이지
 * 보장이 아니고, 자식이 손자에게 stdout 을 물려준 채 스스로 끝나면 손자가 우리 파이프의
 * 쓰기 끝을 쥐어 `close` 가 영영 오지 않는다(실측: raw spawn 에서 T+275ms 에 exit code 7 이
 * 왔는데 stdout END/CLOSE 는 T+8000ms 까지 0건). 그 상태에서 이 함수가 settle 되지 않으면
 * 데드라인이 지나도 봉투가 나가지 않는다.
 */
export const KILL_GRACE_MS = 3_000;

/**
 * 호출자가 상한을 주지 않았을 때의 자체 상한.
 *
 * ★ 왜 필요한가: 위 하드 못은 `stop()` 이 불린 **뒤**에만 무장한다. 그래서 호출자가
 *   `signal` 도 `timeoutMs` 도 안 주면 `stop()` 이 영영 안 불리고, 자식이 매달리면 이
 *   함수도 같이 매달린다. 그 경로는 가설이 아니다 — `src/tools.mjs` 의 `orch_models` 가
 *   `provider.discover()` 를 **인자 없이** 부르고, 그 안의 `--version`·`--help` 프로브가
 *   바로 이 형태다. 즉 벤더 CLI 가 한 번 매달리면 이미 배선된 MCP 도구 호출이 영영
 *   응답하지 않는다.
 *
 * 값은 `src/test-spawn.mjs` 의 같은 이름 상수와 맞춘다. 예산이 아니라 못이다.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * 읽기 전용 **프로브** 스폰 하나의 상한. 예산이 아니라 못이다.
 *
 * ★ 왜 위 기본값(10분)으로는 부족한가: 그 값은 모델 턴 하나를 견디라고 있는 수인데, 프로브가
 *   묻는 것은 `--help` 나 인증 조회처럼 **모델을 안 부르는** 답이다. 실측(2026-08-25 컨트롤러
 *   라이브 캡처, 로그인된 상자)은 그 답이 전부 1초 아래였다. 상한이 실행 데드라인 하나뿐이면
 *   붙잡힌 프로브 하나가 크레딧을 쓰기도 전에 실행의 남은 시간을 통째로 먹는다.
 *
 * 값은 이 저장소가 이미 쓰는 프로브 어휘와 맞춘다: `src/test-discovery.mjs` 의 `PROBE_TIMEOUT_MS`
 * (10 s)와 같고 `src/reaper.mjs` 의 8 s 와 같은 등급이다. 실측의 열 배 이상이라 느린 기계의
 * 콜드 스타트를 자르지 않는다.
 *
 * ⚠ 오늘 이 못을 쓰는 것은 **인증 프로브뿐**이다. `discover`·`securityFloor` 도 같은 모양이지만
 *   그 둘의 상한을 바꾸는 것은 이 태스크가 잰 것 밖이라 손대지 않았다(리뷰 I1 이 같은 사실을
 *   「새 규율 위반은 아니다」로 적었다).
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * 실행 하나에 스폰 한 벌 — `work` 를 **그 실행의 신호**로 메모한다(WS4b 리뷰 I1).
 *
 * ★★ 열쇠가 신호인 것이 이 함수의 전부다. 실행 하나 안에서 누가 몇 번 묻든 답은 하나이고,
 *   다음 실행은 신호가 새것이라 반드시 다시 묻는다 — 즉 **실행 사이 캐시가 아니다**. 인증은
 *   실행 사이에 바뀌는 사실이라(사용자가 로그아웃할 수 있다) 낡은 답을 재사용하면 프로브가
 *   조용히 거짓을 말한다. 스폰 하나가 그것보다 싸다.
 * ★ 결과가 아니라 **프로미스**를 담는다. 같은 틱에 둘이 물어도 스폰은 한 벌이다.
 * ★ 신호가 없으면 메모도 없다. 열쇠가 될 객체가 없는 호출은 「실행」이라는 경계가 없는 호출이고
 *   (테스트의 직접 호출이 그렇다), 그때 캐시를 프로세스 수명으로 넓히는 것이 위의 금지다.
 */
export function oncePerSignal(work) {
  const inFlight = new WeakMap();
  return (signal, ...rest) => {
    if (signal === null || typeof signal !== 'object') return work(signal, ...rest);
    const seen = inFlight.get(signal);
    if (seen !== undefined) return seen;
    const started = work(signal, ...rest);
    inFlight.set(signal, started);
    return started;
  };
}

/**
 * onProgress 에 넘기기 전에 한 줄을 JSON 으로 읽는다. 벤더 특정 스키마 검증은 각
 * collect 구현(collectStream/collectCodexStream)의 몫이다 — 여기서는 진행 알림을
 * 위해 "객체 모양의 JSON 인가"만 본다. claude-stream.mjs 의 parseStreamLine 과
 * codex-stream.mjs 의 parseCodexLine 이 이미 이 로직을 벤더 무관하게 구현하고
 * 있었다(둘 다 동일한 JSON.parse + 객체 형태 검사) — 벤더별 스트림 모듈을 여기서
 * import 하면 run-cli.mjs 가 다시 벤더를 알게 되므로, 같은 로직을 그대로 둔 채
 * 이 모듈 안에 따로 둔다.
 */
function parseProgressLine(line) {
  const raw = typeof line === 'string' ? line : String(line ?? '');
  try {
    const record = JSON.parse(raw);
    // "3", "null", "[]" 도 유효한 JSON 이다. 그대로 통과시키면 record.type 접근에서 터진다.
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return { ok: false };
    return { ok: true, record };
  } catch {
    // 벤더가 경고를 stdout 에 흘리거나 마지막 줄이 잘려서 도착할 수 있다. 여기서
    // 던지면 이미 받은 결과까지 통째로 잃는다.
    return { ok: false };
  }
}

/**
 * 청크를 줄로 자른다. 남는 조각을 들고 있다가 다음 청크에 이어붙인다.
 *
 * ★ stdout 은 줄 단위로 도착하지 않는다. JSON 객체 하나가 두 data 이벤트에 걸쳐
 *   쪼개져 온다. 청크마다 split('\n') 하는 구현은 그 객체를 조용히 버리고, 증상은
 *   "델리게이트가 답을 일부만 줬다"로만 나타난다.
 */
export function createLineSplitter() {
  let remainder = '';
  return {
    push(chunk) {
      const text = remainder + String(chunk);
      const parts = text.split(/\r?\n/);
      remainder = parts.pop() ?? ''; // 마지막 조각은 아직 완성되지 않았다
      return parts.filter((line) => line !== '');
    },
    flush() {
      const last = remainder;
      remainder = '';
      return last === '' ? [] : [last];
    },
  };
}

/**
 * 벤더 CLI 를 한 번 돌린다. **절대 throw 하지 않는다.**
 *
 * Task 13 의 runClaude 본문을 그대로 옮긴 것이다. 벤더별로 다른 것은 셋뿐이라
 * 인자로 뺀다 — 복제하면 그 함수가 리뷰 두 라운드에서 고친 다섯 가지(고아 프로세스,
 * 성공을 중단으로 오표시, 청크 경계, 정리 단계 예외, 개행 없는 마지막 줄)를 두 번째
 * 벤더에 다시 심는 셈이 된다.
 *
 * @param authNames  이 벤더의 인증 변수 이름 (child-env.mjs)
 * @param collect    수집기. 라인 텍스트를 받아 벤더별 결과 객체를 낸다
 * @param sendStdin  지시문을 stdin 으로 보낼지. codex 는 false — 프롬프트를 인자로
 *                   줘도 stdin EOF 를 기다리므로 곧바로 닫아야 한다(실측)
 * @param prefixArgs 실행 파일 뒤, 벤더 인자 앞에 붙는다. npm 셈을 통과해
 *                   `node <script>` 로 띄울 때 쓴다(Task 14 resolveLaunch)
 * @param onSpawn    스폰 직후 한 번 불린다. 배선 계층(src/engine.mjs)이 여기서 자식을
 *                   리퍼 원장에 올리고 트리 킬 대상으로 등록한다 — 이 모듈은 stateRoot 를
 *                   모르고 reaper 를 import 하지도 않는다. 돌려준 프로미스는 기다리지
 *                   않고 거부도 삼킨다.
 */
export async function runCli({
  binary,
  prefixArgs = [],
  args = [],
  instruction = '',
  cwd,
  env = process.env,
  signal,
  timeoutMs,
  onProgress,
  onSpawn,
  runId,
  authNames = [],
  collect,
  sendStdin = true,
  // 자체 못의 값 — 테스트가 줄이기 위해서만 받는다. 제품 호출자는 주지 않는다.
  hangGuardMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const fail = (extra) => ({
    ...collect(''),
    exitCode: null,
    signalName: null,
    stderr: '',
    timedOut: false,
    aborted: false,
    hung: false,
    spawnError: null,
    ...extra,
  });

  // 이미 끊긴 신호로 프로세스를 띄우면, 곧바로 죽일 자식을 굳이 만드는 셈이다.
  if (signal?.aborted) return fail({ aborted: true });

  const childEnv = buildChildEnv(env, { authNames, runId });

  let child;
  try {
    child = spawn(binary, [...prefixArgs, ...args], {
      env: childEnv, // ★ 교체다. buildChildEnv 가 만든 것이 자식 환경의 전부다.
      cwd,
      shell: false, // cmd.exe 를 안 지난다 — 인용 규칙 자체는 libuv 쪽에 그대로 남는다(아래 stdin 주석)
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX 에서만: 자식이 자기 프로세스 그룹을 이끌어야 나중에 손자까지 끊을 수 있다.
      // Windows 에서 detached 는 "콘솔 없음"일 뿐이고 트리 종료는 taskkill /T 가 한다.
      ...(WINDOWS ? {} : { detached: true }),
    });
  } catch (error) {
    // Windows 에서 .cmd 를 shell:false 로 띄우면 여기서 동기 EINVAL 이 난다.
    return fail({ spawnError: error });
  }

  const splitter = createLineSplitter();
  const lines = [];
  const stderrChunks = [];
  // 먼저 발생한 사유만 기록한다. 둘 다 세우면 호출부가 "어느 쪽이었나"에 임의의
  // 답을 받는다 — 전역 취소 토큰 위에 호출별 데드라인을 얹으면 실제로 겹친다.
  let stopReason = null;
  // settle 이 끝난 뒤 도착하는 stop() 을 무시하기 위한 표식.
  let finished = false;

  const handleLine = (line) => {
    lines.push(line);
    if (typeof onProgress !== 'function') return;
    const parsed = parseProgressLine(line);
    if (!parsed.ok) return;
    try {
      onProgress(parsed.record);
    } catch {
      // 진행 알림은 부가 기능이다. 호출부의 버그가 이미 돌고 있는 델리게이트를 죽이면 안 된다.
    }
  };

  let hardTimer = null;
  let hardSettle = null;

  const stop = (reason) => {
    // ★ 이미 끝난 뒤에 도착한 신호는 결과를 바꾸지 않는다.
    //
    //   자식이 제때 잘 끝났는데도 그 직후에 타이머가 한 번 튀면 timedOut 이 서게 되고,
    //   호출부는 성공한 실행을 실패로 보고 재시도하거나 경고를 띄운다. 리뷰어가
    //   timeoutMs 를 자식의 실제 소요 시간 근처로 맞춰 180회 중 13회 재현했다:
    //   { text: 'hello', exitCode: 0, spawnError: null, timedOut: true }.
    //   close 와 clearTimeout 사이에 await 경계가 있어 생기는 창이다.
    if (finished) return;
    // ★ 두 번째 stop 은 아무것도 안 한다 — 사유만이 아니라 **kill 자체를** 반복하지 않는다.
    //   두 시계(abort·timeout)가 같은 타이머 페이즈에 발화하면 kill 이 두 번 나가는데,
    //   engines 하한(node 22.11.0 = libuv 1.48.0)에서는 종료 중인 자식에 대한 두 번째
    //   TerminateProcess 의 ERROR_ACCESS_DENIED 가 ESRCH 가 아니라 **EPERM** 으로 올라와
    //   (uv_kill 경쟁, libuv 1.49.0 에서 수정) 'error' 이벤트가 나고, 그 settle 이
    //   exit/close 보다 먼저 이겨 aborted 도 timedOut 도 아닌 결과가 나갔다 — 실측
    //   22.11.0 에서 100/100, 24.x 에서 0/100.
    if (stopReason !== null) return;
    // 트리 종료는 Task 15(reaper)의 몫이다. 여기서는 직접 자식만 끊는다.
    stopReason = reason;
    try {
      child.kill();
    } catch {
      // 이미 죽었으면 할 일이 없다.
    }
    // ★★ 하드 데드라인. `kill()` 은 부탁이지 보장이 아니고, 자식이 손자에게 stdout 을
    //    물려준 채 스스로 끝나면 우리 파이프의 쓰기 끝을 손자가 쥐어 **`close` 가 영영
    //    오지 않는다**(실측: raw spawn 에서 T+275ms 에 exit code 7 이 왔는데 stdout
    //    END/CLOSE 는 T+8000ms 까지 0건). 그러면 이 함수가 settle 되지 않아 봉투가
    //    나가지 않는다 — 데드라인이 정지의 유일한 권위라는 요구가 그 자리에서 깨진다.
    //    `src/test-spawn.mjs` 가 같은 이유로 같은 못을 박고 있다.
    if (hardTimer === null) hardTimer = setTimeout(() => hardSettle?.(), KILL_GRACE_MS);
  };

  const onAbort = () => stop('aborted');
  let timer = null;

  // ★ 스폰과 이 준비 과정 사이에서 예외가 나면, 이미 뜬 자식이 아무에게도 안 잡힌 채
  //   남는다. 실측: signal 자리에 AbortSignal 대신 AbortController 를 넘기면
  //   addEventListener 가 없어 TypeError 가 나고, 그 시점에 자식은 이미 살아 있으며
  //   stdin 도 안 닫혀서 영영 고아로 남았다(PID 로 확인). 흔한 호출부 실수다.
  //
  //   그래서 여기부터는 통째로 감싸고, 실패하면 자식을 먼저 죽인 뒤 다른 실패와
  //   똑같은 모양으로 돌려준다. "절대 throw 하지 않는다"는 이 함수의 계약이다.
  try {
    // ★ 자식을 배선 계층에 넘긴다. 스폰 **이후**라 여기서 던지면 자식이 고아가 되는데,
    //   이 try 안이라 아래 catch 가 먼저 끊는다. 원장 쓰기는 프로세스 프로브를 태워
    //   수백 ms 가 걸리므로 기다리지 않는다.
    if (typeof onSpawn === 'function') {
      const tracked = onSpawn(child);
      if (tracked && typeof tracked.catch === 'function') tracked.catch(() => {});
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    signal?.addEventListener('abort', onAbort, { once: true });

    // 호출자가 상한을 안 주면 자체 상한이 선다 — 단, **신호도 안 줬을 때만**(위 docblock 의 WHY 그대로).
    // ★ 신호가 있으면 데드라인은 호출자의 것이다: 엔진은 모든 벤더 호출에 실행 마감을 준다
    //   (`src/run-progress.mjs`). 그 위에 10분을 덧씌우자 복합 과제의 모델 턴 하나가 스폰 정확히 10분
    //   뒤 잘렸다(2026-08-28 라이브 실측 셋 — 워커 한 번, 다음 실행에선 두 워커 다, 테스트 0회).
    //   상한이 아예 없으면 매달린 자식이 이 함수를, 그리고 그것을 기다리는 MCP 도구 호출을 통째로
    //   붙잡는다 — 그래서 신호 없는 호출(`orch_models` 의 프로브)에는 못이 그대로 선다.
    const hasSignal = typeof signal?.addEventListener === 'function';
    const guard = Number.isFinite(hangGuardMs) && hangGuardMs > 0 ? hangGuardMs : DEFAULT_TIMEOUT_MS;
    const cap = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : hasSignal ? null : guard;
    if (cap !== null) timer = setTimeout(() => stop('timedOut'), cap);

    // 지시문은 stdin 으로 보낸다. argv 로 보내면 Windows 명령줄 상한(CreateProcessW 의 32,767자, 명령줄 **전체**)에
    // 걸리고, `shell:false` 가 건너뛰는 것은 cmd.exe(8,191)뿐이라 libuv 의 인용은 그대로 만난다 — 단위는 `codexArgvChars` 다.
    child.stdin.on('error', () => {
      // 자식이 stdin 을 읽기 전에 죽으면 EPIPE 가 난다. 종료 코드로 이미 드러날 일이다.
    });
    if (sendStdin) {
      child.stdin.end(typeof instruction === 'string' ? instruction : String(instruction ?? ''));
    } else {
      child.stdin.end();
    }
  } catch (error) {
    if (timer) clearTimeout(timer);
    try {
      signal?.removeEventListener?.('abort', onAbort);
    } catch {
      // signal 이 EventTarget 이 아니어서 여기까지 온 경우다. 뗄 것도 없다.
    }
    stop('setupFailed');
    return fail({ spawnError: error });
  }

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(hardTimer);
      resolve(value);
    };
    hardSettle = () => settle({ spawnError: null, hung: true });
    child.on('error', (error) => {
      // ★ `kill` 시스콜의 실패는 스폰 실패가 아니다. 우리가 **이미 죽어 가는** 자식을 한 번 더
      //   끊을 때 engines 하한(libuv 1.48.0)이 EPERM 을 올리는데(위 `stop` 의 WHY), 그것으로
      //   settle 하면 정상 종료 중인 실행이 `provider_spawn_denied`("실행 권한을 고치세요")로
      //   **오분류**된다 — 엔진의 taskkill 과 이 층의 kill 이 겹치는 **단일 kill** 경로에서도
      //   실측 12/30. 무시해도 결과는 반드시 나온다: 자식은 실제로 죽는 중이라 close 가 오고,
      //   영영 안 오는 최악에도 KILL_GRACE 의 못(hardSettle)이 settle 을 보장한다.
      if (error?.syscall === 'kill') return;
      settle({ spawnError: error, hung: false }); // ENOENT 등 비동기 스폰 실패
    });
    // 'exit' 이 아니라 'close' 다. 'exit' 은 프로세스가 끝난 시점에 뜨고, 계약상
    // 그때 stdio 가 아직 안 닫혀 있을 수 있다. 'close' 는 파이프가 다 비워진 뒤다.
    // 정직하게 적자면: 800KB 출력으로도 둘의 차이를 드러내는 실패를 만들지 못했다
    // (뮤턴트 3회 확인). 그래서 이 선택의 근거는 테스트가 아니라 계약이다.
    child.on('close', () => settle({ spawnError: null, hung: false }));
  });
  const spawnError = outcome.spawnError;
  const hung = outcome.hung === true;

  if (timer) clearTimeout(timer);
  clearTimeout(hardTimer);
  // 손자가 파이프의 쓰기 끝을 쥔 채 남아 있으면 우리 쪽 읽기 끝이 이벤트 루프를 붙잡는다.
  // `hung` 으로 나가는 길에서는 아무도 이 파이프를 닫아 주지 않는다.
  if (hung) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  try {
    // 여기도 감싼다. signal 이 addEventListener 는 있고 removeEventListener 는 없는
    // 오리 타입이면(실측 가능) 완전히 성공한 실행의 결과까지 통째로 잃는다 —
    // 바로 위에서 막은 것과 같은 부류의 버그가 한 줄 뒤에 남아 있었다.
    signal?.removeEventListener('abort', onAbort);
  } catch {
    // 뗄 수 없으면 그냥 둔다. 이 실행의 결과와는 무관하다.
  }

  for (const line of splitter.flush()) handleLine(line);

  const collected = collect(lines.join('\n'));
  const exitCode = spawnError ? null : child.exitCode;

  // ★ stop() 을 불렀다는 것과 실제로 끊었다는 것은 다르다.
  //
  //   데드라인이 자식의 소요 시간에 가까우면, 타이머가 튀어 kill 을 보냈는데도 자식이
  //   그 직전에 스스로 다 끝내고 exit 0 으로 나가는 일이 생긴다. 결과는 완전한데
  //   timedOut 이 서고, 그걸 믿는 호출부는 멀쩡한 답을 버리고 재시도한다.
  //   (리뷰어가 180회 중 13회 재현: text 'hello', exitCode 0, timedOut true.)
  //
  //   exit 0 은 "스스로 정상 종료했다" 는 뜻이다 — 우리가 죽였으면 Windows 는 0 이
  //   아닌 코드를, POSIX 는 exitCode null + signalCode 를 남긴다. 그러니 exit 0 이면
  //   우리가 끊은 것이 아니다.
  const cutShort = spawnError === null && exitCode !== 0;

  return {
    ...collected,
    exitCode,
    signalName: child.signalCode ?? null,
    stderr: stderrChunks.join(''),
    // `hung` 을 여기 섞지 않는다. 자식이 스스로 exit 0 으로 끝났는데 손자가 파이프를 쥔
    // 경우가 실제로 있고(그때 결과는 완전하다), 섞으면 위 주석의 오탐이 되살아난다.
    timedOut: stopReason === 'timedOut' && cutShort,
    aborted: stopReason === 'aborted' && cutShort,
    // 끊은 뒤에도 파이프가 닫히지 않아 결과를 기다리지 않고 나왔다. 자식(또는 그 손자)이
    // 아직 살아 있을 수 있고, reparent 된 손자는 트리 킬로도 안 잡힌다(reaper.mjs).
    hung,
    spawnError,
  };
}
