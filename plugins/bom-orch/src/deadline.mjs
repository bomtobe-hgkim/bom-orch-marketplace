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
 * ★ 이 상수는 `src/engine.mjs` 에서 여기로 왔다(WS9 태스크 4). `src/proof-stage.mjs` 가 같은
 *   상한을 쓰는데, 그것을 엔진에서 수입하면 증명 단계에 엔진 폐포가 통째로 붙는다 — 아래
 *   문단은 그 이사에서 한 글자도 안 바뀐 원문이다.
 */
/**
 * ★★ 엔진 자체의 절대 상한. **`waitMs` 와 무관하다.**
 *
 * 브리프는 "데드라인이 정지의 유일한 권위" 라고 요구하는데, `waitMs: 0`(기본값)은
 * `timeoutSignal` 이 `undefined` 를 돌려주므로 **권위가 아예 없는 상태**였다. 그 둘은
 * 양립하지 않는다. 그래서 `waitMs` 를 "호출자가 정한 상한", 이 값을 "그것과 무관한 상한"
 * 으로 나눈다 — 호출자가 0 을 주면 이 값이 데드라인이 되고, 더 큰 값을 주면 이 값으로 깎인다.
 *
 * 못이지 예산이 아닌 이유: 정상적인 오케스트레이션(최대 10스텝 × 플래너·워커·테스트·
 * 베리파이어)이 여기 닿는 것은 이상 상태이고, 그때는 부분 결과라도 내보내는 편이
 * MCP 요청이 영영 매달리는 것보다 낫다.
 *
 * ★★ 55분인 이유(WS3 §0-W1). 이 값은 **호스트의 도구 타임아웃보다 먼저** 만료해야 한다 —
 * 호스트가 먼저 끊으면 사용자에게 가는 것은 봉투가 아니라 전송 오류이고, 부분 결과도 사유
 * 코드도 아무 채널에 안 남는다. 호스트 값(Claude `.mcp.json` 의 `timeout`, Codex 의
 * `tool_timeout_sec` — 둘 다 3,600,000 ms)은 **올리지 않는다**: 우리가 못 고치는 남의 설정에
 * 기대게 되기 때문이다. 그래서 엔진을 내린다. 3,600,000 − 70,000 = 3,530,000 이 상한이고
 * 70초는 abort **뒤에** 우리가 아직 쓰는 시간이다(하드스톱 유예 10초 `HARD_STOP_GRACE_MS`
 * + 워크트리 정리 최대 60초). 부등식은 `test/guards/wait-budget-inequality.test.mjs` 가 두
 * 호스트 설정의 소스와 exporter 산출물 양쪽에서 지킨다. 기본 `wait_ms` 1,800,000 은 그대로다
 * — 같이 내리면 기본 실행이 데드라인에 더 자주 걸린다(로드맵 §3.5).
 */
export const MAX_WAIT_MS = 3_300_000;

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
