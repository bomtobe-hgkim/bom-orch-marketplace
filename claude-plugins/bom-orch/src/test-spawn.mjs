/**
 * 자식 하나를 띄우고 **결과를 반드시 낸다** — 출력 상한·kill 유예·드레인 유예의 못이 사는 자리.
 * `spawnAndCollect` 는 절대 throw 하지 않고, `close` 가 영영 오지 않는 경우까지 포함해 모든
 * 경로에서 `{ran, exitCode, timedOut, aborted, hung, lingering, spawnError, output…}` 하나를 낸다.
 *
 * ★ 방향은 한쪽이다: `src/test-runner.mjs` → 여기. 이 파일은 무엇을 돌릴지도, 돌려도 되는지도
 *   모른다 — 고정값 대조·자식 환경 조립·confidence 판정은 전부 러너에 남아 있고, 여기 오는 것은
 *   이미 검증된 `{command, args, cwd, env}` 넷뿐이다. 그래서 이 파일에는 `git` 도
 *   `project-config` 도 `reason-*` 도 없다.
 * ★ 실측 폐포: **2개 모듈 / 461줄**(자기 자신 352 포함) — `deadline`(109) 하나뿐이다. 이 저장소에서 가장 얕은 잎이고, 그것이 이 파일이 하는 일의 크기다.
 * ★ 수입하는 쪽(실측 grep): `src/test-runner.mjs`(`DEFAULT_TIMEOUT_MS`·`WINDOWS`·`spawnAndCollect`)와 `test/test-runner.test.mjs`(상한 상수 넷). 둘뿐이다.
 */

import { spawn } from 'node:child_process';

import { timeoutSignal } from './deadline.mjs';

/**
 * 러너가 부르는 이름 셋. 나머지 넷(`createOutputCap`·`spawnFailure`와 서로게이트 술어 둘)은
 * 이 파일 안에서만 쓴다. `MAX_OUTPUT_CHARS`·`KILL_GRACE_MS`·`DRAIN_GRACE_MS`·`DRAIN_MAX_MS` 는
 * 옮겨 온 선언에 이미 `export` 가 붙어 있으므로 여기 적지 않는다 — 그 줄들은 한 글자도 바뀌지
 * 않았고, 그것이 이 커밋이 순수 이동이라는 증거의 절반이다.
 */
export { DEFAULT_TIMEOUT_MS, WINDOWS, spawnAndCollect };

/**
 * 자식 출력의 상한(문자). 상한이 걸리는 자리는 둘이다: 여기서 100,000자로 자르고, MCP
 * 결과로 나갈 때 봉투가 `src/envelope.mjs` 의 `MAX_CONTENT_CHARS`(10,000자)로 한 번 더
 * 자른다.
 *
 * 두 값을 다르게 두는 이유: 러너의 소비자는 MCP 클라이언트만이 아니다. 검증·학습 단계가
 * 실패 로그를 읽어야 하고, 그 용도에는 10,000자가 너무 짧다. 대신 **MCP 로 내보내는
 * 호출부는 이 값을 그대로 실으면 안 된다** — 봉투가 꼬리부터 잘라내므로, 필요한 구간을
 * 호출부가 직접 골라야 한다.
 */
export const MAX_OUTPUT_CHARS = 100_000;

/** 기본 시간 상한. 테스트 스위트는 길다 — `runGit` 의 30초 기준으로는 못 잰다. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * kill 뒤 `close` 를 기다리는 유예. 이 시간을 넘기면 자식의 생사와 무관하게 결과를 낸다.
 *
 * `kill()` 은 부탁이지 보장이 아니고, 특히 `node --run` 은 스크립트의 명령을 손자로
 * 띄운다 — 자식만 죽고 손자가 우리 파이프의 쓰기 끝을 쥐고 있으면 `close` 가 영영 오지
 * 않는다.
 *
 * ⚠ **남는 위험**: 직접 자식은 `onSpawn` 훅으로 배선 계층에 넘어가 리퍼 원장에 오르고
 *   (`src/engine.mjs`), 그쪽이 데드라인에 트리 킬을 건다. 그래도 **reparent 된 손자**는
 *   남는다 — `taskkill /T` 도 POSIX 그룹 신호도 살아 있는 트리만 훑기 때문이다
 *   (`src/reaper.mjs` 의 같은 문단). 즉 하드 데드라인이 발동하면 델리게이트가 쓴 코드를
 *   돌리던 손자가 우리 권한으로 워크트리 안에 남을 수 있고(실측: 봉투가 나간 뒤 +8초에도
 *   살아 있었다), 워크트리 제거도 그 프로세스가 파일을 쥐고 있으면 걸린다. 봉투는 최소한
 *   그 사실을 `notes` 로 알린다.
 */
export const KILL_GRACE_MS = 3_000;

/**
 * `exit` 은 왔는데 `close` 가 안 올 때 파이프를 더 기다리는 유예.
 *
 * 자식이 스스로 끝났다면 종료 코드는 이미 우리 손에 있다. 그때까지 도착하지 않은 출력만
 * 기다리면 되고, 만료되면 **그 종료 코드로** 결과를 낸다. 이것이 없으면 배경 프로세스를
 * 남긴 스위트(watcher·dev 서버)에서 `close` 가 영영 오지 않아, 통과한 스위트가 기본
 * 설정으로 603초 뒤에 `passed:false / timedOut:true` 로 보고됐다(실측).
 *
 * 출력이 계속 도착하는 동안에는 다시 센다 — 큰 출력을 드레인하는 중에 끊으면 안 된다.
 */
export const DRAIN_GRACE_MS = 3_000;

/**
 * `exit` 뒤 드레인에 쓸 수 있는 **절대 상한**. 갱신되지 않는다.
 *
 * 갱신만 있으면 계속 찍는 배경 프로세스에서 유예가 영영 늘어나 데드라인 전체를 쓴다
 * (실측: 200ms 마다 찍는 손자에서 timeoutMs 8000 + KILL_GRACE 3000 = 11,020ms, 기본
 * 설정이면 603초). 그리고 그 경로는 `hung` 으로 나가 **통과한 스위트가 unverified** 가
 * 된다. 종료 코드는 이미 확정이므로 여기서 끊어 잃는 것은 꼬리 출력뿐이다.
 */
export const DRAIN_MAX_MS = 10_000;

const WINDOWS = process.platform === 'win32';

// ── 출력 상한 ─────────────────────────────────────────────────────────────

/**
 * 앞뒤를 남기고 가운데를 버리는 수집기. **메모리도 상한 안에 머문다** — 다 모은 뒤
 * 자르는 구현은 폭주하는 스위트의 출력을 그대로 힙에 쌓는다.
 *
 * 꼬리를 버리지 않는 이유: 테스트 요약과 실패 목록은 끝에 나온다. 머리를 남기는 이유:
 * 무엇이 돌았는지와 첫 실패가 거기 있다.
 *
 * 자르는 자리는 **코드 유닛이 아니라 문자 경계**다. 서로게이트 쌍 한가운데를 자르면 짝
 * 없는 서로게이트가 남고, JSON 으로는 살아남지만 UTF-8 바이트로 쓰는 소비자(로그 파일,
 * 비 JS 소비자)에서 U+FFFD 로 뭉개지거나 인코딩 오류가 된다(실측: 이모지 출력에서
 * `isWellFormed()` 가 false). `outputChars` 는 원래 코드 유닛 수 그대로 둔다.
 */
function endsWithHighSurrogate(text) {
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsWithLowSurrogate(text) {
  const code = text.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

function createOutputCap(limit) {
  const headLimit = Math.max(1, Math.floor(limit * 0.3));
  const tailLimit = Math.max(1, limit - headLimit);
  let head = '';
  let tail = '';
  let total = 0;

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (text === '') return;
      total += text.length;
      if (head.length < headLimit) head += text.slice(0, headLimit - head.length);
      tail += text;
      if (tail.length > tailLimit) tail = tail.slice(tail.length - tailLimit);
    },
    result() {
      if (total <= headLimit + tailLimit) {
        // 상한 아래에서는 head 와 tail 이 겹친다. 겹친 만큼만 떼면 원문이 그대로 돌아온다.
        const overlap = head.length + tail.length - total;
        return { text: head + tail.slice(overlap), chars: total, truncated: false };
      }
      // 끝이 high surrogate 면 짝을 잃은 것이고, 시작이 low surrogate 면 짝이 앞에 남았다.
      const safeHead = endsWithHighSurrogate(head) ? head.slice(0, -1) : head;
      const safeTail = startsWithLowSurrogate(tail) ? tail.slice(1) : tail;
      const dropped = total - safeHead.length - safeTail.length;
      return {
        text: `${safeHead}\n… [${dropped} of ${total} characters dropped from the middle] …\n${safeTail}`,
        chars: total,
        truncated: true,
      };
    },
  };
}

function spawnFailure(extra) {
  return {
    ran: false,
    exitCode: null,
    signalName: null,
    timedOut: false,
    aborted: false,
    hung: false,
    lingering: false,
    spawnError: null,
    output: '',
    outputChars: 0,
    truncated: false,
    ...extra,
  };
}

/**
 * 자식을 띄우고 stdout·stderr 를 **도착 순서대로** 한 버퍼에 모은다. 절대 throw 하지 않는다.
 *
 * 두 스트림을 합치는 이유: 사람이 터미널에서 보는 것이 그 순서이고, 테스트 러너는 진행과
 * 실패를 두 스트림에 나눠 쓴다. 둘 다 반드시 드레인한다 — 읽지 않으면 파이프 버퍼가 차서
 * 자식이 멈춘다.
 */
async function spawnAndCollect({ command, args, cwd, env, signal, timeoutMs, onSpawn }) {
  const cap = createOutputCap(MAX_OUTPUT_CHARS);

  // 이미 끊긴 신호로 프로세스를 띄우면 곧바로 죽일 자식을 굳이 만드는 셈이다.
  if (signal?.aborted) return spawnFailure({ aborted: true });

  // ★ 스폰 **앞**에서 만든다. 스폰과 보호 try 사이에 한 줄도 두지 않는 것이 "스폰 이후의
  //   셋업이 던져 자식이 고아로 남는다"를 닫는 유일한 방법이다(계획 1 에서 두 번, 여기서
  //   세 번째로 낸 부류 — 실측으로 재현했다: timeoutMs 5000/3 -> 봉투는 blocked 인데
  //   테스트 자식은 살아서 워크트리에 계속 썼다).
  const deadline = timeoutSignal(timeoutMs);

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env, // ★ 교체다. buildChildEnv 가 만든 것이 자식 환경의 전부다.
      shell: false,
      windowsHide: true,
      // stdin 은 열지 않는다. 입력을 기다리는 스위트가 영영 멈추는 대신 즉시 EOF 를 본다.
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 에서만: 자식이 자기 프로세스 그룹을 이끌어야 리퍼가 손자까지 끊을 수 있다.
      ...(WINDOWS ? {} : { detached: true }),
    });
  } catch (error) {
    return spawnFailure({ spawnError: error });
  }

  // ★ 'error' 리스너를 **던질 수 있는 어떤 코드보다 먼저** 붙인다. 셋업이 던져 아래
  //   보호 catch 로 빠지면 그 뒤에 자식의 'error'(ENOENT 등)가 리스너 없이 터지고,
  //   봉투가 정상 반환된 **다음에** 프로세스가 uncaught 로 죽는다 — stdio 로 물린 MCP
  //   서버에서는 세션이 통째로 끊긴다(실측: 봉투는 blocked:false 로 나오고 shell exit=1).
  //   `settle` 은 아직 없으므로 사유를 담아 두었다가 준비되면 넘긴다.
  let earlyError = null;
  let settleOutcome = null;
  child.on('error', (error) => {
    // ★ `kill` 시스콜의 실패는 스폰 실패가 아니다 — engines 하한(libuv 1.48.0)은 종료 중인
    //   자식의 재-kill 에 EPERM 을 올리고(`src/providers/run-cli.mjs` 의 같은 WHY), 그것으로
    //   settle 하면 데드라인에 잘린 실행이 스폰 거부로 오분류된다. close 나 KILL_GRACE 의
    //   못이 결과를 보장하므로 무시한다.
    if (error?.syscall === 'kill') return;
    if (settleOutcome !== null) settleOutcome({ spawnError: error });
    else earlyError = error;
  });

  let stopReason = null;
  let finished = false;
  let hardTimer = null;
  let hardSettle = null;
  let drainTimer = null;
  let drainSettle = null;
  let drainDeadline = null;

  const stop = (reason) => {
    if (finished) return;
    // ★ 두 번째 stop 은 kill 을 반복하지 않는다 — 종료 중인 자식의 재-kill 이 engines
    //   하한에서 EPERM 'error' 를 만든다(`src/providers/run-cli.mjs` 의 stop 과 같은 WHY).
    if (stopReason !== null) return;
    stopReason = reason;
    try {
      child.kill();
    } catch {
      // 이미 죽었으면 할 일이 없다.
    }
    // ★ kill 뒤에도 `close` 가 안 오면 결과를 못 낸다. 반드시 나가게 못을 박는다.
    if (hardTimer === null) hardTimer = setTimeout(() => hardSettle?.(), KILL_GRACE_MS);
  };

  // 자식이 스스로 끝났는데 파이프가 안 닫혔다. 도착 중인 출력만 기다렸다가 나간다.
  //
  // ★ 유예에 **절대 상한**이 있다. 갱신만 하면 계속 찍는 배경 프로세스에서 유예가 영영
  //   갱신돼 데드라인 전체를 쓴다(실측: 조용한 손자는 3.1초, 200ms 마다 찍는 손자는
  //   timeoutMs 8000 + KILL_GRACE 3000 = 11,020ms, 기본 설정이면 603초 — 그리고 `hung`
  //   으로 나가 통과한 스위트가 unverified 가 된다). 종료 코드는 이미 확정이므로 상한을
  //   넘겨서 잃는 것은 꼬리 출력뿐이다.
  const bumpDrain = () => {
    if (finished || drainSettle === null) return;
    clearTimeout(drainTimer);
    const remaining = drainDeadline - Date.now();
    if (remaining <= 0) {
      drainSettle();
      return;
    }
    drainTimer = setTimeout(() => drainSettle?.(), Math.min(DRAIN_GRACE_MS, remaining));
  };

  const onData = (chunk) => {
    cap.push(chunk);
    if (drainTimer !== null) bumpDrain();
  };

  const onAbort = () => stop('aborted');
  const onDeadline = () => stop('timedOut');

  // ★ 스폰 **이후**의 셋업이 던지면 자식이 아무에게도 안 잡힌 채 남는다(계획 1 에서 두 번
  //   낸 버그). 여기부터 통째로 감싸고, 실패하면 자식을 먼저 끊는다.
  try {
    // ★ 자식을 배선 계층에 넘긴다(리퍼 원장 등록·트리 킬 대상 등록). 스폰 **이후**라
    //   여기서 던지면 자식이 아무에게도 안 잡힌 채 남는다 — 그래서 이 try 안이고,
    //   아래 catch 가 자식을 먼저 끊는다.
    //
    //   결과를 기다리지 않는다: 원장 쓰기는 프로세스 시작 시각 프로브(powershell/ps)를
    //   태우므로 수백 ms 가 걸리는데, 그동안 stdout 리스너를 안 붙이면 자식이 파이프
    //   버퍼에서 멈춘다. 거부는 삼킨다 — 원장은 최선의 노력이고, 실패했다고 이미 도는
    //   스위트를 죽이면 안 된다.
    if (typeof onSpawn === 'function') {
      const tracked = onSpawn(child);
      if (tracked && typeof tracked.catch === 'function') tracked.catch(() => {});
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    deadline?.addEventListener('abort', onDeadline, { once: true });
  } catch (error) {
    stop('setupFailed');
    try {
      signal?.removeEventListener?.('abort', onAbort);
      deadline?.removeEventListener?.('abort', onDeadline);
    } catch {
      // 뗄 수 없으면 그냥 둔다.
    }
    clearTimeout(hardTimer);
    return spawnFailure({ spawnError: error });
  }

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(drainTimer);
      resolve(value);
    };
    hardSettle = () => settle({ hung: true });
    drainSettle = () => settle({ lingering: true });
    settleOutcome = settle;
    if (earlyError !== null) settle({ spawnError: earlyError });
    // ★ 'exit' 과 'close' 를 **둘 다** 듣는다. 'close' 는 파이프가 다 비워진 뒤라 출력을
    //   잃지 않지만, 손자가 쓰기 끝을 쥐고 있으면 영영 오지 않는다. 그때 'exit' 이 이미
    //   준 종료 코드를 버리면 통과한 스위트가 실패로 나간다.
    child.on('exit', () => {
      drainDeadline = Date.now() + DRAIN_MAX_MS;
      drainTimer = setTimeout(() => drainSettle?.(), Math.min(DRAIN_GRACE_MS, DRAIN_MAX_MS));
    });
    child.on('close', () => settle({}));
  });

  try {
    signal?.removeEventListener?.('abort', onAbort);
    deadline?.removeEventListener?.('abort', onDeadline);
  } catch {
    // 뗄 수 없으면 그냥 둔다. 이 실행의 결과와는 무관하다.
  }
  // 손자가 파이프의 쓰기 끝을 쥔 채 남아 있으면 우리 쪽 읽기 끝이 이벤트 루프를 붙잡는다.
  child.stdout?.destroy();
  child.stderr?.destroy();

  const spawnError = outcome.spawnError ?? null;
  const hung = outcome.hung === true;
  // 'exit' 이 왔으면 child.exitCode 는 값이 있고, 신호로 죽었거나 아직 살아 있으면 null 이다.
  // 알고 있는 것을 버리지 않는다 — `lingering` 은 "결과를 모른다"가 아니다.
  const exitCode = spawnError !== null ? null : child.exitCode;

  // ★ stop() 을 불렀다는 것과 실제로 끊었다는 것은 다르다. 데드라인이 자식의 소요 시간에
  //   가까우면 kill 을 보낸 직후 자식이 스스로 exit 0 으로 나갈 수 있다. exit 0 은
  //   "스스로 정상 종료했다"는 뜻이므로 그때는 우리가 끊은 것이 아니다.
  const cutShort = spawnError === null && exitCode !== 0;
  const collected = cap.result();

  return {
    ran: spawnError === null,
    exitCode,
    signalName: child.signalCode ?? null,
    timedOut: stopReason === 'timedOut' && cutShort,
    aborted: stopReason === 'aborted' && cutShort,
    hung,
    // 자식은 끝났는데 파이프를 쥔 손자가 남았다. `hung`("결과를 못 받았다")과 다른 사실이다.
    lingering: outcome.lingering === true,
    spawnError,
    output: collected.text,
    outputChars: collected.chars,
    truncated: collected.truncated,
  };
}
