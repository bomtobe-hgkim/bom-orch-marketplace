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
