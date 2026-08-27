/**
 * timeoutSignal 이 안전하게 넘길 수 있는 최대 delay — Node 내부 타이머의 상한인
 * 2^31-1 ms(약 24.8일)다. 인자 검증의 wait_ms 상한이 이 상수를 그대로 재사용한다 —
 * 두 곳에 하드코딩하면 드리프트한다.
 *
 * ★ 2^32-1(unsigned long)이 아니다. 그 둘 사이에 함정이 있다(실측, Node 24):
 *     AbortSignal.timeout(2_147_483_647)  정상 — 요청한 시각에 발화
 *     AbortSignal.timeout(2_147_483_648)  TimeoutOverflowWarning + **1ms 만에 발화**
 *     AbortSignal.timeout(4_294_967_296)  동기 RangeError
 *   즉 2^31 ~ 2^32-1 구간(약 24.8~49.7일)은 throw 하지도 않으면서 delay 를 1ms 로
 *   깎아버린다. 이 구간을 상한으로 잡으면 "아주 긴 데드라인"을 요청한 호출자가
 *   **즉시 중단**을 받는다 — 아래 clamp 가 막으려는 것의 정반대다.
 *   (BomMcp 의 deadline.mjs 가 2^32-1 을 쓰는데, 같은 버그다.)
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 0 이하 또는 유한하지 않은 값은 "기한 없음"이므로 undefined 를 돌려준다.
 *
 * 상한 초과는 절대 throw 하지 않고 clamp 한다. "요청보다 훨씬 늦게 발화"가 "영원히
 * 발화하지 않음"보다 안전한 실패 모드다 — 후자는 호출자가 명시적으로 요청한
 * 데드라인을 조용히 무기한으로 바꿔버린다.
 *
 * ★ 정수가 아닌 값도 throw 하지 않는다. `AbortSignal.timeout` 은 정수가 아니면 동기
 *   ERR_OUT_OF_RANGE 를 던진다(실측: 0.5 / 1.5 / 100.7 전부). 예산을 나눠 쓰는 호출부에서
 *   `5000/3` 같은 값은 흔하고, 그 throw 가 스폰 이후에 터지면 자식이 고아로 남는다.
 *   내림하되 0 으로 깎지는 않는다 — 0 은 위에서 "기한 없음"인데 여기서는 호출자가 준
 *   데드라인이라, 뜻이 정반대로 뒤집힌다.
 */
export function timeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, MAX_TIMEOUT_MS))));
}

/**
 * 호스트가 실행을 끊을 때 abort 에 싣는 **이유**(WS3 §0-C1).
 *
 * ★ 왜 이유가 필요한가: 데드라인과 호스트 취소는 결국 벤더에게 같은 것 하나
 *   — `AbortSignal.any([deadline, hostSignal])` — 로 도착하고, 그 뒤에는 "누가 껐는가"가
 *   `signal.reason` 에만 남는다. 그 구분이 없으면 우리가 자른 실행이 전부
 *   `run_deadline_exceeded` 로 읽히고, `run_cancelled` 는 영영 생산자가 없다.
 *   (거꾸로도 같다 — WS2 §14: 우리 마감이 자른 실행은 POSIX 에서 signal kill 이라,
 *   이유를 signal **앞에** 두지 않으면 우리 마감이 벤더 결함으로 읽힌다.)
 *
 * ★ 왜 여기 사는가: 생산자는 `src/server.mjs`(호스트 경계)이고 소비자는 엔진(태스크 7)이다.
 *   둘 중 한쪽에 두면 다른 쪽이 문자열을 **베껴야** 하고, 베낀 목록은 갈린다. 두 쪽이 이미
 *   함께 무는 모듈은 abort 신호를 만드는 이 파일 하나다.
 */
/**
 * 마감과 호스트 취소를 **신호 하나**로 접는다(WS3 §0-C1). 벤더 계약의 입구는 `signal` 하나이고,
 * 둘을 주면 어느 이음매는 하나만 듣는다 — 그래서 접는 자리를 하나로 둔다.
 *
 * ★ **이유는 여기서 정하지 않는다.** 접힌 신호의 `reason` 은 먼저 발화한 쪽에서 복사돼 오지만,
 *   「누가 껐는가」의 권위는 소스 신호(`hostSignal.aborted`)이고 그것을 읽는 자리는 엔진의
 *   halt 자리다(`haltReasonCode`). 결함 문구를 보고 분류하는 자리는 어디에도 없다(WS2 §14).
 * ★ 폴백이 있는 이유: 엔진의 인자 검증은 `{aborted, addEventListener}` 오리 타입도 받는다
 *   (태스크 6). 네이티브 `AbortSignal.any` 는 진짜 `AbortSignal` 이 아니면 던지는데, 우리가
 *   받아들인 입력으로 터지는 것은 **우리 버그**다 — 그때는 손으로 접어 같은 것을 만든다.
 */
export function haltSignal(deadlineSignal, hostSignal) {
  if (hostSignal === undefined || hostSignal === null) return deadlineSignal;
  if (deadlineSignal === undefined) return hostSignal;
  try {
    return AbortSignal.any([deadlineSignal, hostSignal]);
  } catch {
    const merged = new AbortController();
    for (const source of [deadlineSignal, hostSignal]) {
      if (source.aborted === true) merged.abort(source.reason);
      else source.addEventListener?.('abort', () => merged.abort(source.reason), { once: true });
    }
    return merged.signal;
  }
}

export const HOST_ABORT_REASON = Object.freeze({
  /** 호스트가 이 요청 하나를 취소했다(MCP `notifications/cancelled` → SDK 의 `extra.signal`). */
  cancel: 'host_cancel',
  /** 호스트가 서버를 내린다 — SIGTERM 이거나 전송이 닫혔다. 실행 하나가 아니라 프로세스 사건이다. */
  shutdown: 'host_shutdown',
});
