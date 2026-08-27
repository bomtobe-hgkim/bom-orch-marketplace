// src/lockfile.mjs
import { open, readFile, rm } from 'node:fs/promises';
import { REASON } from './reason-codes.mjs';
import { fail, renderNotice } from './reason-text.mjs';
import { errorText } from './util/errors.mjs';
import {
  acquireIdentityProtectedLock,
  mayTakeOver,
  takeOverStale,
} from './lockfile-acquire.mjs';

/** 기본 재시도 대기. `withLock` 의 `sleep` 옵션을 안 주면 이것이 쓰인다. */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `timeoutMs` 를 안 주거나 못 쓸 값을 준 호출의 잠금 대기 상한. export 하는 이유는 이
 * 값이 12-way 경합 테스트의 **유일한 상한**이라서다 — 테스트가 같은 수를 리터럴로 다시
 * 적으면 이 상수를 바꾼 순간 단언이 다른 것을 재게 된다.
 */
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * 크로스 프로세스 배타 잠금.
 *
 * 왜 프로세스 내 큐로 부족한가: 설계 §11.3 이 상태 루트를 호스트 공통으로 잡았고,
 * Claude Code 와 Codex 가 각자 서버 프로세스를 띄운다. `catalog.mjs`·`reaper.mjs`
 * 의 프라미스 체인 큐는 한 프로세스 안의 쓰기만 직렬화한다.
 *
 * 절대 throw 하지 않는다. 잠금을 못 잡거나 본문이 던지면 `fail(REASON.x, …)` 봉투다.
 * 호출자(학습 계층)는 그때 학습을 건너뛰고 실행을 계속해야 한다 — 학습은 부가
 * 기능이지 차단 사유가 아니다. 반환도 안 하는 것 역시 계약 위반이다: 어떤 실패 경로도
 * `timeoutMs` 를 넘겨 매달려서는 안 된다.
 *
 * 반환값
 * - `{ok:true, value}` — 본문이 값을 냈다.
 * - `{ok:false, blocked, reasonCode, error, recovery}` — 잠금을 못 잡았거나 본문이 죽었다.
 *   ★★ 이 둘은 호출자에게 다른 뜻이다: 전자는 본문이 아예 돌지 않았으니 건너뛰어도 안전하고,
 *   후자는 중간에 죽었으니 부분 쓰기가 남았을 수 있다. **그 구분은 이제 `reasonCode` 다**
 *   (`REASON.state_lock_work_failed`) — WS2 Task 16 이전에는 사유 문장의 한국어 앞머리
 *   (`본문이 …`)였고, `src/config.mjs` 가 `startsWith('본문이')` 로 그것을 읽었다. 문구가
 *   제어 흐름이면 문구를 번역하는 순간 제어 흐름이 조용히 죽는다.
 * - 잠금을 잡았던 호출에는 `released` 가 붙는다. `released:false` 는 잠금 경로에 뭔가
 *   남아 다음 호출을 막는다는 뜻이다 — 우리 잠금 파일이 그대로 남았거나 남의 것으로
 *   바뀌었다. 그때 `releaseReason` 에 사실이 담긴다. `ok:true` 인데 이 상태면 뒤이은
 *   쓰기가 `staleMs` 동안 조용히 실패하므로 호출자가 그것을 로그할 수 있어야 한다.
 *   해제 시점에 파일이 이미 없으면(다른 쪽이 지웠다) 남는 게 없으니 `released:true`
 *   다 — 우리가 지운 건 아니지만 다음 호출을 막지도 않는다.
 *
 * 잠금 파일 내용은 `{pid, at}` 이다. `at` 은 stale 판정에만 쓴다 — pid 로 살아 있는지
 * 보지 않는 이유는 pid 가 재사용되기 때문이다(리퍼가 `startTime` 까지 보는 것과 같은 축).
 * `at` 은 획득 시점에 한 번 찍고 갱신하지 않으므로, 본문이 `staleMs` 보다 오래 걸리면
 * 살아 있는 잠금도 남이 빼앗을 수 있다. 실측: `staleMs:50` 에 본문 300ms 로 셋을 돌리면
 * 셋 다 들어가고(peak=3) 셋 다 `ok:true` 를 받았다 — 첫 홀더의 해제가 남의 잠금 파일을
 * 지워 다음이 또 들어오는 연쇄였다. 그래서 해제는 파일을 다시 읽어 우리가 쓴 것과 같을
 * 때만 지운다. 연쇄는 그것으로 끊기지만, 본문이 `staleMs` 를 넘길 수 있는 호출자는
 * `staleMs` 를 본문 최대 시간보다 넉넉히 잡아야 한다.
 */
export async function withLock(lockPath, fn, options) {
  if (typeof lockPath !== 'string' || lockPath === '') {
    return fail(REASON.state_lock_path_invalid);
  }
  if (typeof fn !== 'function') return fail(REASON.state_lock_work_not_callable);
  // `= {}` 파라미터 기본값은 `undefined` 에만 걸린다 — `null` 을 넘기면 구조 분해가
  // 그 자리에서 던진다. lockPath·fn 과 같은 층위로 어떤 값이 와도 던지지 않게 여기서
  // 직접 정규화한다(배열은 구조 분해가 그대로 통하므로 손대지 않는다).
  const given = options && typeof options === 'object' ? options : {};
  const { timeoutMs = LOCK_TIMEOUT_MS, retryMs = 25, staleMs = 60_000 } = given;
  const ownerIdentity = Number.isInteger(given.ownerIdentity?.pid) && given.ownerIdentity.pid > 0 &&
    typeof given.ownerIdentity?.startTime === 'string' && given.ownerIdentity.startTime !== ''
    ? { pid: given.ownerIdentity.pid, startTime: given.ownerIdentity.startTime } : null;
  const getStartTime = typeof given.getStartTime === 'function' ? given.getStartTime : null;
  const identityProtected = given.identityProtected === true;
  // ★ `now`·`sleep` 은 **테스트가 시계를 쥐기 위한 이음새**다. 기본값이 진짜 시계·진짜
  //   타이머라 옵션을 안 주면 동작도 파일 바이트도 그대로다. 이것이 없으면 재시도·클램프
  //   같은 성질을 「몇 ms 걸렸다」로만 잴 수 있는데, 그 대리 지표는 부하가 걸린 기계에서
  //   재시도 없이도 참이 되고 한가한 기계에서도 거짓이 된다(실측: 이 파일의 탈취 테스트가
  //   7회 중 2회 붉었다). 함수가 아닌 값은 기본값으로 되돌린다 — 재시도 경로 한복판에서
  //   던지면 "절대 throw 하지 않는다" 는 이 모듈의 유일한 하드 계약이 깨진다.
  const now = typeof given.now === 'function' ? given.now : Date.now;
  const sleep = typeof given.sleep === 'function' ? given.sleep : realSleep;

  const deadline = now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LOCK_TIMEOUT_MS);
  const wait = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 25;
  const age = Number.isFinite(staleMs) && staleMs >= 0 ? staleMs : 60_000;

  let handle = null;
  // 아직 아무 오류도 못 봤다는 사실은 **값이 없다**는 뜻이라 문장이 아니라 `null` 이다 —
  // 문장으로 두면 그 문장이 문구 정본을 우회해 `{code}` 자리에 실려 나간다.
  let lastCode = null;
  if (identityProtected) {
    const protectedLock = await acquireIdentityProtectedLock(lockPath, {
      deadline, wait, now, sleep, getStartTime,
    });
    if (!protectedLock.ok) return fail(REASON.state_lock_timeout, { code: protectedLock.code });
    handle = protectedLock.handle;
  }
  for (; !identityProtected;) {
    try {
      // 'wx' 는 파일이 이미 있으면 실패한다 — 그것이 이 잠금의 원자성이다.
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      // 실측: Windows 에서 방금 rm() 한 파일을 다른 호출이 곧바로 'wx' 로 열면
      // EEXIST 가 아니라 EPERM(간혹 EBUSY) 이 뜬다 — 삭제가 커널 레벨에서 아직
      // 끝나지 않은 파일을 여는 시도로 보인다. 8-way 동시 진입 테스트를 반복 실행해
      // 확인했다(수백 회 중 다수가 이 경로를 탄다). 진짜 권한 오류와 이 상태를 이
      // 파일 하나만 보고는 구분할 수 없으니 같은 재시도 경로로 흘려보낸다 — 그 대신
      // 타임아웃 사유에 마지막 오류 코드를 실어 권한 문제를 경합으로 오진하지 않게 한다.
      const retryable = error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EBUSY';
      if (!retryable) return fail(REASON.state_lock_create_failed, { detail: errorText(error) });
      lastCode = error?.code ?? lastCode;

      if (error?.code === 'EEXIST' && (await mayTakeOver(lockPath, age, now, getStartTime, identityProtected))) {
        // 탈취를 시도한다. 실패해도(경로가 디렉터리, 다른 프로세스가 삭제 불허로 잡고
        // 있는 등) 아래 데드라인 검사와 sleep 을 건너뛰지 않는다. 실측: 여기서 곧장
        // `continue` 하면 rm 이 계속 실패하는 잠금 앞에서 timeoutMs=200 을 주고도 3초가
        // 지나도록 반환하지 않았다 — 데드라인을 한 번도 보지 않는 뜨거운 루프였다.
        await takeOverStale(lockPath).catch((error) => {
          lastCode = error?.code ?? lastCode;
        });
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        // `lastCode` 는 재시도 가능한 오류에서만 채워지고 그 갈래는 반드시 `.code` 를 갖는다 —
        // 그래도 `??` 를 남기는 이유는 미상 토큰을 **지어내지 않기** 위해서다(있는 사실만 싣는다).
        return fail(REASON.state_lock_timeout, { code: lastCode ?? errorText(error) });
      }
      // retryMs 그대로 재우면 timeoutMs 를 몇 배로 넘길 수 있다(실측: timeoutMs:50,
      // retryMs:1000 → 1006ms). 남은 시간으로 clamp 한다 — remaining 은 위에서 이미
      // 양수임을 확인했으니 음수가 될 일이 없다.
      await sleep(Math.min(wait, remaining));
    }
  }

  // 이 문자열이 우리 소유권 증표다. 해제할 때 파일을 다시 읽어 이것과 대조한다.
  const token = JSON.stringify(ownerIdentity === null
    ? { pid: process.pid, at: now() }
    : { pid: ownerIdentity.pid, startTime: ownerIdentity.startTime, mode: 'identity', at: now() });
  let wrote = false;
  let outcome;
  try {
    await handle.writeFile(token, 'utf8');
    wrote = true;
    const value = await fn();
    outcome = { ok: true, value };
  } catch (error) {
    outcome = wrote
      ? fail(REASON.state_lock_work_failed, { detail: errorText(error) })
      : fail(REASON.state_lock_token_write_failed, { detail: errorText(error) });
  }

  // 해제. 여기서 던지면 계약이 깨지므로 전부 값으로 받는다.
  const notes = [];
  const closeFailure = await handle.close().then(
    () => null,
    (error) => errorText(error),
  );
  if (closeFailure) notes.push(renderNotice('lock_handle_close_failed', { detail: closeFailure }));

  // 표식을 못 썼으면 우리가 만든 것은 0바이트 파일이다 — 그것과 대조한다.
  const release = await releaseOwnLock(lockPath, wrote ? token : '');
  if (release.reason) notes.push(release.reason);

  const result = { ...outcome, released: release.released };
  if (notes.length > 0) result.releaseReason = notes.join(' / ');
  return result;
}

/** 잠금 파일이 우리 것일 때만 지운다. 남의 것이면 건드리지 않는다. */
async function releaseOwnLock(lockPath, token) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 파일이 이미 없다 — 남의 것으로 바뀐 게 아니라 아무것도 안 남았으니, 다음
      // 호출을 막지 않는다. released:false 로 보고하면 새지도 않은 것을 새는 것으로
      // 과잉 신고하게 된다.
      return { released: true };
    }
    return { released: false, reason: renderNotice('lock_file_unverifiable', { detail: errorText(error) }) };
  }
  if (raw !== token) {
    return { released: false, reason: renderNotice('lock_file_taken_over') };
  }
  try {
    await rm(lockPath, { force: true });
    return { released: true };
  } catch (error) {
    return { released: false, reason: renderNotice('lock_file_unremovable', { detail: errorText(error) }) };
  }
}
