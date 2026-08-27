/**
 * 오류 문장과 차단 봉투 — 저장소 전체에서 하나.
 *
 * 이전에는 "던져진 것에서 사람이 읽을 문장을 뽑는다" 는 같은 일을 하는 함수가 열 벌 있었고 **동작
 * 등급이 넷**이었다(리서치 `docs/superpowers/research/2026-08-16-ws1/helpers.json`, `safe-error-text`).
 * 같은 입력에 서로 다른 답을 냈다: `new Error('boom')` 하나에 `envelope.mjs` 는 `"Error: boom"`,
 * 나머지 아홉은 `"boom"`(WS2 Task 9 가 봉투도 아홉 쪽으로 옮겼다). `{ message: 'plain' }` 에는 셋이
 * `"[object Object]"`, 넷이 `"plain"`. 두 프로바이더 사본은 **"절대 throw 하지 않는다" 고 적어 둔
 * 그 자리에서** 던지는 `.message` getter 앞에 던졌다.
 *
 * 통합 규칙은 하나다 — **가장 많이 말하고, 가장 적게 터진다.**
 * ★ 절대 던지지 않는다. 속성 읽기도 `String()` 도 전부 try/catch 안이다 — 오류를 설명하다 나는
 *   오류는 원래 오류를 통째로 지운다.
 * ★ 절대 빈 문자열을 내지 않는다. `learn/*`·`lockfile` 의 `describe('')` 만이 빈 사유를 낼 수
 *   있었고, 빈 사유가 실린 봉투는 "실패했다" 만 있고 "왜" 가 없다.
 * ★ `undefined`/`null` 은 글자 `'undefined'`/`'null'` 이 되지 않는다. `failure({})` 가
 *   `error:"undefined"` 를 내던 결함이고, 그 규칙은 `contract/envelope.json` 의 `error` 행에 있다.
 * ★ `[object Object]` 도 내지 않는다(WS2 Task 14 수정 M2) — 그것은 사유가 아니라 사유가 없다는
 *   사실이고, 문구 정본(`paramText`)이 **던지는** 값이다. 이 함수의 결과는 `fail(..., {detail})`
 *   로 그대로 들어가므로, 그 글자를 내는 순간 "절대 던지지 않는다" 고 적힌 catch 가 던진다.
 */
import { RECOVERY_GENERIC, RECOVERY_INSTALL } from '../reason-text.mjs';
import { OPAQUE_OBJECT_TEXT } from './strings.mjs';

/**
 * 아무것도 건질 게 없을 때의 문장. 열 사본이 모두 같은 글자를 썼고 WS2 Task 16 이 영어로 옮겼다.
 *
 * ★ 이 값은 `fail(..., {detail})` 의 인자로 들어가 **레지스트리 문장 안**에 실린다. 그래서
 *   문장이 아니라 **조각**이다 — 마침표도 대문자 시작도 없다. 레지스트리 정본을 거치지 않는
 *   유일한 이유는 이것이 실패의 문구가 아니라 "설명할 것이 없다" 는 사실 그 자체이기 때문이다.
 */
const UNKNOWN = 'the cause is unknown';

/**
 * 회복 문구 둘은 `src/reason-text.mjs` 의 영어 정본을 **다시 내보내는 이름**이다(WS2 Task 9).
 * 값을 정본으로 모으는 것과 호출부 이름을 바꾸는 것은 다른 커밋이다 — 태스크마다
 * `fail(REASON.x)` 로 옮겨 가며 사라진다. 이름이 0 이 되는 날 이 두 줄도 지운다.
 *
 * ★ 셋째 이름 `ARTIFACT_RECOVERY` 는 WS2 Task 19 가 지웠다 — Task 12 뒤로 소비자가 0 이었고,
 *   부르는 자리가 없는 re-export 는 정본이 둘이라는 인상만 남긴다. 그 문구가 필요한 자리는
 *   `RECOVERY_ARTIFACT`(`src/reason-text.mjs`)를 직접 부른다.
 */
export const GENERIC_RECOVERY = RECOVERY_GENERIC;
export const INSTALL_RECOVERY = RECOVERY_INSTALL;

/**
 * 속성 하나를 **던지지 않고** 읽는다.
 *
 * ★ 서술자를 읽지 않고 그냥 읽는 이유: `message` 를 프로토타입의 접근자로 두는 오류 클래스가 실제로
 *   있다(Node 의 여러 시스템 오류). own 서술자만 보면 그런 메시지를 통째로 놓친다. 대신 getter 가
 *   던질 수 있으므로 try/catch 로 감싼다.
 */
function readProperty(value, key) {
  try {
    return value === null || value === undefined ? undefined : value[key];
  } catch {
    return undefined;
  }
}

/** 빈 문자열이 아닌 문자열만 통과시킨다. `null` 이면 "쓸 것이 없다" 는 뜻이다. */
function usableText(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 어떤 값에서도 사람이 읽을 문장을 뽑는다. 절대 던지지 않고, 절대 비어 있지 않다.
 *
 * @param {unknown} error 던져진 것. 오류일 필요도, 객체일 필요도 없다.
 *
 * ★ 옵션 `preferMessage:false` 는 `src/envelope.mjs` 전용 유예였고(WS1 spec §7.2-3), WS2 Task 9 가
 *   해제 조건("봉투 문구를 영어로 옮기는 커밋")을 만족시키며 은퇴시켰다. Task 19 가 **지웠다** —
 *   생산 호출부가 0 인 채로 남은 스위치는 다음 사람에게 "두 가지 답이 있다" 고 말하고, 그 둘 중
 *   어느 쪽이 봉투 바이트인지는 이 파일을 읽어서는 알 수 없다. 이제 답은 하나다.
 *
 * ★ **호출자·저널·설정에서 온 값은 저장소 어디서든 이 사다리를 지난다.** `String(v)` 는 객체에서
 *   `[object Object]` 를 내고 문구 렌더러(`src/reason-text.mjs paramText`)는 그 값에 **던진다** —
 *   그 throw 가 봉투 대신 잠금 실패로 나가거나 문장을 폴백으로 접는다(WS2 Task 16 리뷰 I1 실측:
 *   저널 한 줄의 `rewardableAxes:[{}]` 가 `learning_lock_unavailable` 로 보고됐다).
 *   `String()` 은 **이미 검증된 문자열**에만 쓴다(예: `run_id`).
 *
 * 사다리는 **가장 많이 말하는 것부터**다: `message` → `String(value)` → `code` → 미상.
 * ★ `code` 가 `message` 앞이 아니라 `String(value)` **뒤**인 이유: 그 자리에 두면 메시지가 빈
 *   시스템 오류의 봉투 바이트가 바뀐다(`new Error('')` + `code:'ENOENT'` 는 지금 `'Error'` 로
 *   나가고 그 값이 테스트에 못박혀 있다). `code` 는 `String(value)` 가 `[object Object]` 밖에
 *   못 낼 때 — 즉 건질 문장이 **정말로** 없을 때 — 마지막으로 건지는 사실이다.
 */
export function errorText(error) {
  if (typeof error === 'string') return usableText(error) ?? UNKNOWN;
  // 값이 없다는 사실 자체가 사유다 — 글자 'undefined' 는 모델에게 아무 말도 안 한다.
  if (error === null || error === undefined) return UNKNOWN;
  const message = usableText(readProperty(error, 'message'));
  if (message !== null) return message;
  let text = null;
  try {
    text = usableText(String(error));
  } catch {
    // toString 이 던지거나 프로토타입이 없는 객체(Object.create(null))가 여기로 온다.
    text = null;
  }
  if (text !== null && text !== OPAQUE_OBJECT_TEXT) return text;
  return usableText(readProperty(error, 'code')) ?? UNKNOWN;
}

/*
 * WS2 Task 19 가 이 파일에서 지운 둘 — 지웠다는 사실을 여기 적어 두는 이유는, 둘 다 "언젠가
 * 쓰일 것 같은" 모양이라 다음 사람이 같은 것을 다시 지어 넣기 쉽기 때문이다.
 *
 * ★ `errorTextFromChildProcess(error)` — message → exitCode → code 사다리. Task 6 이 프로바이더
 *   실패를 `classifyProviderFailure`/`providerFailed` 로 옮기면서 src 소비자가 0 이 됐다. 자식
 *   프로세스의 실패는 이제 사유 코드로 분류되고 문장은 `src/reason-text.mjs` 가 낸다 — 그 경로가
 *   있는데 두 번째 사다리를 남겨 두면 같은 실패가 두 문장으로 갈린다.
 *
 * ★ `blocked(error, recovery, extra)` — **코드 없는** 내부 실패 봉투. WS2 가 171 곳의 호출부를
 *   `fail(REASON.x, params, extra)`(코드 있는 판)로 옮겨 src 호출부가 0 이 됐다. 코드 없는 봉투는
 *   봉투 밖으로 나갈 때 사유가 문자열 하나로 남고, 그 문자열은 정본을 거치지 않는다.
 *   `test/guards/reason-code-literals.test.mjs` 의 `REASON_CALL_HEADS` 에는 `blocked` 가 남아
 *   있다 — 그 목록은 "이 이름의 호출에 리터럴이 오면 잡는다" 는 **모양**의 목록이고, 합성 트리로
 *   그 모양이 실제로 잡히는지를 매번 재므로 무덤이 아니다.
 */
