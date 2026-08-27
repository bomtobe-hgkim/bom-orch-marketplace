import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { clipPlain } from './util/strings.mjs';

/**
 * 실행 하나당 JSONL 로그 파일 하나 — WS2 §5. 오늘 맨 `catch` 가 삼키는 사실들이 갈 자리다.
 *
 * ★ 왜 실행 디렉터리(`<stateRoot>/runs/<runId>/`) **밖**인가. 그 디렉터리의 파일 집합을 **닫힌
 *   집합**으로 검사하는 자리가 넷 있다(`src/reaper.mjs` 의 검증기 셋과 `src/run-artifacts.mjs` 의
 *   `validateCompleteInitialTree`). 집합 밖의 파일 하나면 판정은 `unexpected_entry` 이고 그 뜻은
 *   "지우지 않는다" 다 — 로그를 그 안에 두면 그 실행의 **평문 패치까지** 영영 안 지워지고 매
 *   실행이 retention notice 를 다시 공표한다. 그래서 로그는 `<stateRoot>/logs/` 에 살고
 *   `sweepLogs` 가 patches·scratch 와 **같은 함수**로 치운다.
 *
 * ★ 0700/0600 규율은 따르되 `run-artifacts` 의 `openOwnedEmptyFile`·`createSecureDirectory` 를
 *   옮겨 오지 않는다. 그쪽은 만든 뒤 lstat 으로 identity 를 대조하고 실패하면 **실행을 막는다**
 *   (아티팩트는 증거다). 로그는 반대 방향이라 최소만 한다: `mkdir({recursive: true, mode: 0o700})`
 *   + `openSync(path, 'ax', 0o600)` — (a) 바이트는 처음부터 소유자만 읽고, (b) `x` 라서 남이 미리
 *   만들어 둔 파일에 **이어 쓰지 않는다**(fail-closed 로 `unavailable`). 이미 있는 `logs/` 의 권한을
 *   고치지 않는 것도 같은 이유다 — 그 자리가 이상하면 열기가 막히고 로그만 조용히 없어진다.
 *
 * ★ 실패는 전부 삼킨다. 열기든 쓰기든 예외가 호출부로 나가지 않고 `unavailable`+`reason` 이 된다
 *   (엔진이 notice 로 옮긴다 — Task 10). 조언만 하는 채널은 실행을 떨어뜨릴 권한이 없다.
 *
 * ★ 모델 산문은 들어올 수 없다. `fields` 는 평면 `{string|number|boolean}` 만 받고(객체·배열·그
 *   밖은 `'[dropped]'`), 문자열은 `redact` 를 지난 뒤 200자로 자른다 — 키도 값과 **같은 길**을
 *   지난다(아래 `flatFields`). 호출부가 벤더 stdout 을 그대로 넘겨도 상한을 넘지 못한다.
 *
 * ★ Task 10(엔진 배선)이 할 일 셋. (a) `sweepLogs` 를 **두 자리** 모두에 꽂는다: 리퍼의 부팅 스윕
 *   (`sweepOrphans` 결과 객체의 `scratch`·`patches` 옆 `logs`)과 엔진의 실행별 스윕 표
 *   (`src/engine.mjs` 의 `scratch`·`patches`·`runs` 세 행 옆) — 장수 서버는 부팅이 며칠에 한 번이라
 *   한 자리만으로는 그 사이 잔재를 못 본다. (b) `src/run-artifacts.mjs` 의 `logicalControllerPath`
 *   는 `['runs','patches','worktrees','plans']` 만 허용한다: 로그 경로가 원장 이벤트에 실리게 되면
 *   `'logs'` 를 그 목록에 넣어야 다이제스트가 경로를 통째로 버리지 않는다. (c) 읽는 쪽은 **마지막
 *   줄을 try/catch** 로 판다 — ENOSPC 로 append 가 반쪽만 들어가면 꼬리가 찢어진 JSON 일 수 있다.
 */

/** 1 MiB. 이 상한을 넘으면 `log_truncated` 한 줄을 남기고 그 뒤 쓰기는 전부 버린다. */
export const RUN_LOG_MAX_BYTES = 1_048_576;

const LEVELS = new Set(['info', 'warn', 'error']);
const LOG_TEXT_MAX = 200;
const DROPPED = '[dropped]';
const TRUNCATED_MESSAGE = 'log_truncated';

/**
 * ★ `src/reaper.mjs`·`src/worktree.mjs` 의 것과 같은 값을 한 벌 더 두는 이유는 방향이 다르기
 *   때문이다: 저쪽은 **지울 수 있는 이름**을, 이쪽은 **만들 이름**을 고른다. 쓰는 쪽이 리퍼가
 *   모르는 이름을 만들면 그 파일은 영영 안 지워진다(위 ★ 의 결함이 디렉터리만 옮겨 되살아난다).
 *   그래서 만들기 문턱을 리퍼의 집합 안으로 좁힌다 — 경로 탈출(`../`)과 Windows 예약 장치 이름
 *   (`con.jsonl` 은 파일이 아니라 콘솔이다)도 같은 문턱이 막는다. import 로 묶지 않는 것은 이
 *   모듈이 엔진·리퍼 어느 쪽도 끌어오지 않아야 하기 때문이다.
 */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * 로그 파일의 경로. **순수**하다 — I/O 가 없다. 그래서 엔진은 파일이 생기기 전에도 봉투에
 * `log.path` 를 실을 수 있고, 나중에 runId 만 아는 도구도 같은 경로를 계산할 수 있다.
 *
 * ★ 전제조건: `runId` 는 이미 `RUN_ID_PATTERN` 을 만족해야 한다 — 문턱은 `openRunLog` 에만 있고
 *   이 함수는 `join` 뿐이다. 검사받지 않은 `'../x'` 는 상태 루트 밖 경로로 조용히 계산된다.
 */
export function runLogPath(stateRoot, runId) {
  return join(stateRoot, 'logs', `${runId}.jsonl`);
}

/**
 * 저장소의 말줄임 둘 중 notice 쪽(`clipPlain`)을 그대로 쓴다 — 세 번째 형식을 만들지 않는다.
 * ★ 인자가 `LOG_TEXT_MAX` 가 아니라 `-1` 인 이유: `clipPlain` 은 자를 때 말줄임 한 글자를
 *   **붙인다** — 200 을 그대로 주면 201자가 나가 "한 줄의 문자열은 200자를 넘지 않는다" 가 한
 *   글자 어긋난다. 정확히 200 인 값은 자르지 않고 그대로 둔다.
 */
function clipText(value) {
  return value.length <= LOG_TEXT_MAX ? value : clipPlain(value, LOG_TEXT_MAX - 1);
}

/**
 * 밖으로 나가는 문자열 하나가 지나는 길: **redact 먼저, clip 나중**. 순서가 곧 정확성이다 —
 * 먼저 자르면 비밀이 반으로 잘려 남고(`sk-` 규칙은 8자 이상을 요구해 `…sk-ab` 조각은 규칙에 안
 * 걸린 채 나간다), 먼저 지우면 그 조각이 애초에 생기지 않는다. 그리고 이 순서만이 "200자 상한은
 * **redact 를 지난 뒤**의 길이" 를 지킨다(`<stateRoot>` 같은 자리표시자는 원문보다 길다).
 */
function logText(value, redact) {
  return clipText(redact(typeof value === 'string' ? value : String(value)));
}

function flatField(value, redact) {
  if (typeof value === 'string') return logText(value, redact);
  // NaN·Infinity 는 JSON 에서 null 이 된다 — 숫자였다는 사실만 남고 값은 사라진다.
  if (typeof value === 'number') return Number.isFinite(value) ? value : DROPPED;
  if (typeof value === 'boolean') return value;
  return DROPPED;
}

/**
 * 평면 한 겹만 남긴다. 객체가 아닌 `fields`(문자열·배열·null)는 빈 객체로 본다.
 * ★ **키도 `logText` 를 지난다.** 키도 호출부의 텍스트다(경로·환경변수 이름·토큰이 키로 온다).
 *   값만 세척하면 비밀이 콜론 왼쪽으로 옮겨 앉을 뿐이고, 상한 없는 키는 200자 약속을 키 쪽으로
 *   빠져나간다. 두 키가 같은 문자열로 세척되면 뒤가 이긴다 — 비밀을 내보내는 것보다 낫다.
 */
function flatFields(fields, redact) {
  const out = {};
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return out;
  for (const [key, value] of Object.entries(fields)) out[logText(key, redact)] = flatField(value, redact);
  return out;
}

function validTarget(stateRoot, runId) {
  // 상대 경로 상태 루트는 서버가 물려받은 cwd 밑에 로그를 만든다 — 그건 상태 루트가 아니다.
  return typeof stateRoot === 'string' && stateRoot !== '' && isAbsolute(stateRoot) &&
    typeof runId === 'string' && RUN_ID_PATTERN.test(runId) && !WINDOWS_DEVICE_PATTERN.test(runId);
}

/**
 * 못 여는 경우의 반환. `write`·`close` 를 **무-작동으로 함께 낸다** — 호출부에 잊을 수 있는 실패
 * 분기를 남기지 않는 것이 이 모듈의 요점이다(`path` 는 계약대로 `null`).
 */
function unavailableSink(reason) {
  return { path: null, unavailable: true, reason, truncated: false, write() {}, close() {} };
}

/**
 * 로그를 열고 sink 를 낸다. **절대 throw 하지 않는다.**
 *
 * 핸들은 "없다" 뿐 아니라 **왜 없는지**를 낸다(notice 는 원인을 적어야 조치가 된다). `reason` 은
 * 닫힌 집합이다: `invalid_target`(만들 수 없는 이름 — 파일을 시도조차 안 했다) · `open_failed`
 * (`logs/` 만들기나 배타적 열기 실패 — 남이 그 이름을 쥐고 있다) · `write_failed`(열려 있던 로그의
 * append·fsync·close 실패 — 꽉 찬 디스크·뽑힌 볼륨). `truncated` 는 상한에 닿아 **뒷줄이 없다**는
 * 사실이고 실패가 아니다(`unavailable` 과 무관).
 *
 * `append` 는 테스트 전용 이음매다(`src/redact.mjs` 의 `platform`·`sweepRuns` 의 fs deps 와
 * 같은 관례). 기본값이 진짜 함수이므로 바이트는 그대로이고, 없으면 "쓰기가 실패해도 실행은
 * 산다" 는 이 모듈의 유일한 불변식을 **검사할 방법이 없다**.
 */
export async function openRunLog({
  stateRoot, runId, redact = (text) => text, now = () => Date.now(),
  maxBytes = RUN_LOG_MAX_BYTES, append = appendFileSync,
} = {}) {
  if (!validTarget(stateRoot, runId)) return unavailableSink('invalid_target');
  const path = runLogPath(stateRoot, runId);
  // 안전 정수가 아닌 상한은 상한이 없는 것과 같다 — 기본값으로 되돌린다(fail-safe).
  const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : RUN_LOG_MAX_BYTES;

  let handle;
  try {
    await mkdir(join(stateRoot, 'logs'), { recursive: true, mode: 0o700 });
    // ★ `ax` = O_APPEND|O_CREAT|O_EXCL|O_WRONLY — `wx` 와 똑같이 배타적(fail-closed)이면서,
    //   O_APPEND 라 매 쓰기가 OS 수준에서 끝에 원자적으로 붙고 fd 를 받는 `appendFileSync` 의
    //   문서화된 계약(추가 모드로 열린 fd)과도 어긋나지 않는다.
    handle = openSync(path, 'ax', 0o600);
  } catch {
    return unavailableSink('open_failed');
  }

  let written = 0;
  let closed = false;
  const sink = { path, unavailable: false, reason: null, truncated: false, write, close };

  // ★ 줄 하나를 만드는 자리는 하나다(키 순서도 여기 한 번만 적힌다 — 이 저장소는 키 순서를 계약으로
  //   본다). 상한은 **바이트**로 잰다: 상한의 이름이 BYTES 이므로 비-ASCII 가 섞이면 그게 맞는 판정이다.
  const render = (level, reasonCode, message, fields) => `${JSON.stringify({
    ts: now(), level: LEVELS.has(level) ? level : 'info',
    reasonCode: typeof reasonCode === 'string' ? reasonCode : null,
    message: logText(message, redact), fields: flatFields(fields, redact),
  })}\n`;

  /** 상한 안이면 쓰고 참을 낸다 — 판정과 기록이 한 자리라 둘이 어긋날 수 없다. */
  function emit(line) {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (written + bytes > cap) return false;
    append(handle, line, 'utf8');
    written += bytes;
    return true;
  }

  /** 쓰기 계열의 실패 — 삼키되 **왜**는 남긴다(첫 이유가 진단이므로 `??=` 로 덮지 않는다). */
  const degrade = () => { sink.unavailable = true; sink.reason ??= 'write_failed'; };

  /**
   * 동기 append 한 번. 실패는 삼키고 그 뒤로는 무-작동이 된다. ★ 줄마다 fsync 하지 않는다(실측
   * +1.3ms/줄) — `close()` 가 한 번 하고, 그래서 실행이 끝난 뒤 프로세스가 죽어도 꼬리는 남는다.
   * `JSON.stringify` 가 CR·LF·짝 없는 서로게이트를 escape 하므로 "한 번 쓰기 = 한 줄" 은 참이다.
   */
  function write(level, reasonCode, message, fields = {}) {
    if (closed || sink.truncated || sink.unavailable) return;
    try {
      if (emit(render(level, reasonCode, message, fields))) return;
      // ★ 표지 줄도 상한 안에서만 쓴다. 표지(약 92B)는 짧은 데이터 줄보다 길 수 있어 무조건 쓰면
      //   상한을 넘긴다 — 그러면 상한이 상한이 아니다. 못 들어가면 아무것도 더 쓰지 않고,
      //   `truncated` 는 그래도 참이다(파일에 표지가 없을 때가 notice 가 더 필요한 경우다).
      sink.truncated = true;
      emit(render('warn', null, TRUNCATED_MESSAGE, {}));
    } catch {
      degrade();
    }
  }

  /**
   * 마지막에 한 번 fsync 하고 닫는다. 둘 다 best effort — 실패는 `unavailable`+`reason` 으로만 남는다.
   * ★ fsync 와 close 가 **둘 다** 던지는 이중 실패에서는 fd 를 프로세스 종료에 맡긴다(설계다).
   *   실패한 `closeSync` 를 다시 부르면 이미 회수된 fd 를 두 번 닫아 무관한 파일을 닫을 수 있다.
   */
  function close() {
    if (closed) return;
    closed = true;
    for (const step of [fsyncSync, closeSync]) {
      try {
        step(handle);
      } catch {
        degrade();
      }
    }
  }

  return sink;
}
