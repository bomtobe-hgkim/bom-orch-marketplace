/**
 * 문자열 도우미 — 저장소 전체에서 하나.
 *
 * WS1 §7. `compareUtf8`·정수 검사(3단)와 `boundedText` 계열·말줄임 셋(4단)이 여기 산다.
 */

/**
 * `String(value)` 가 **아무것도 못 건졌다**는 뜻으로 내는 글자. 값이 아니라 값이 없다는 사실이다.
 *
 * ★ 이름이 필요한 이유는 두 자리가 이 글자를 두고 서로 반대 약속을 하기 때문이다:
 *   `src/reason-text.mjs paramText` 는 이 값을 받으면 **던지고**(문장 속 값 자리에 실려 나가면
 *   "값이 없다" 가 값처럼 보인다), `src/util/errors.mjs errorText` 는 이 값을 **절대 내지 않는다**.
 *   두 약속이 같은 리터럴의 두 사본 위에 서 있으면 한쪽만 고치는 날 never-throw 계약이 깨진다 —
 *   실제로 그랬다(WS2 Task 14 수정 M2: `errorText({code:'EBUSY'})` 가 이 글자를 냈고, 그것을
 *   `fail(..., {detail})` 에 실은 두 catch 가 던졌다).
 */
export const OPAQUE_OBJECT_TEXT = '[object Object]';

/**
 * UTF-8 **바이트** 순서 비교. 이름 붙은 사본 셋(`reaper.compareAscii`·
 * `run-artifacts.compareUtf8`·`candidate-selection.byteCompare`)과 같은 식이 인라인으로
 * 18곳에 더 있었다(리서치 family `utf8-byte-compare`).
 *
 * ★ 이건 단순한 정렬 도우미가 아니라 **해시되는 배열의 정렬 키**다 — `evidenceIds`,
 *   계획 지문, 리퍼 목록이 이 순서 위에 서 있다. 인라인 사본 중 둘은 인코딩 인자
 *   없이 `Buffer.from(a)` 를 부르고 있었고, 오늘 순서가 같은 것은 Node 기본값이
 *   utf8 이라는 우연 덕이었다. 한곳으로 모아 두면 인코딩 변경이 한 줄 변경이 된다.
 * ★ JS 의 `<` 는 UTF-16 코드유닛 순서라 여기서 쓸 수 없다 — 서로게이트 쌍(U+10000
 *   이상)이 BMP 문자보다 **앞**으로 정렬되어 바이트 순서와 어긋난다.
 */
export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * 안전 정수 검사 — 통과하면 **값**을, 아니면 `null` 을 낸다.
 *
 * ★ boolean 이 아니라 값을 내는 이유는 호출부가 검사한 값을 그대로 쓰기 때문이다
 *   (검사와 사용 사이에 다른 표현이 끼면 그 틈으로 회귀가 들어온다). 대신 `0` 이
 *   falsy 라는 함정이 생기므로 호출부는 반드시 `!== null` 로 검사해야 한다.
 */
export function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

/**
 * 같은 검사의 boolean 판. 사본 세 벌(`run-artifacts.safeInteger`(>=0),
 * `candidate-selection.isSafeCount`(>=0, 상한 인자), `candidate-lane.validToken`)이 이
 * 모양이었고, 그 호출부들은 값을 다시 쓰지 않고 조건으로만 쓴다 — 그 호출부까지 값
 * 반환으로 바꾸면 `0` 이 falsy 라서 조용히 뒤집힌다.
 *
 * ★ 이름이 `isSafeInteger` 가 **아닌** 이유: 그것은 `Number.isSafeInteger` 를 글자 그대로
 *   가리면서 의미가 다르다(이 함수는 **음수를 거부하고** 상한도 받는다). 한 파일 안에서
 *   `Number.isSafeInteger` 와 맨 `isSafeInteger` 가 섞이면 어느 쪽 규칙인지 읽어서는 알 수
 *   없다 — `run-artifacts.mjs` 한 파일에만 두 형태가 마흔 번 넘게 섞여 있었다. `count` 는
 *   "0 이상"을 이름에 넣은 원래 사본(`candidate-selection.isSafeCount`)의 이름이다.
 */
export function isSafeCount(value, max = Number.MAX_SAFE_INTEGER) {
  return safeInteger(value, { maximum: max }) !== null;
}

/**
 * 검증된 문자열이 담을 수 있는 문자 — 저장소 전체에서 하나의 정책.
 *
 * 거부하는 것: **C0 전부**(U+0000–U+001F, NUL·TAB·LF·CR 포함), **DEL**(U+007F),
 * **C1 전부**(U+0080–U+009F), **U+FFFD**(디코딩 실패의 흔적), **짝 없는 서로게이트**.
 * `allowDiffWhitespace` 는 텍스트 공백 **셋(TAB·LF·CR)**을 한꺼번에 연다 — 줄바꿈은 혼자 다니지
 * 않는다: CRLF 로 쓴 여러 줄 문자열에서 LF 만 허용하면 Windows 가 쓴 본문이 통째로 떨어지고,
 * diff 본문은 TAB 없이 존재하지 않는다.
 *
 * ★ 이름이 `allowNewline` 이 아닌 이유(WS1 spec §9 C6 의 이월, WS2 가 갚는다): 그 이름은 이
 *   스위치가 실제로 여는 것을 **거짓으로** 말했다 — LF 하나가 아니라 TAB·LF·CR 셋이고, TAB 이
 *   열린다는 사실이 이름 어디에도 없었다. `candidate-selection` 의 사본은 처음부터
 *   `allowDiffWhitespace` 였고, 그 이름이 옳았다.
 *
 * ★ 왜 C1 을 새로 막는가: 사본 여덟 벌 중 **아무도** C1 을 안 봤다(`src/git.mjs` 만 문질러
 *   지웠다). C1 은 터미널에서 C0 와 같은 escape 로 해석되는 자리가 있어서, 하나만 빠뜨리면
 *   "제어문자를 막았다"는 문장이 거짓이 된다.
 * ★ 왜 짝 없는 서로게이트를 막는가: `Buffer.from(x, 'utf8')` 이 그것을 U+FFFD 로 **조용히**
 *   바꾼다. 그 뒤에 해시를 뜨면 서로 다른 두 값이 같은 해시가 된다(`compareUtf8` 주석 참조).
 */
const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f\ufffd]/u;
const TEXT_CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/u;

/**
 * 짝 없는 서로게이트가 있는가. 문자열 아닌 값에는 쓰지 않는다(호출부가 먼저 거른다).
 *
 * 정규식 대신 훑는 이유는 `candidate-selection` 의 사본과 **판정이 한 글자도 다르지 않아야**
 * 하기 때문이다 — 이 함수는 그 사본을 그대로 옮긴 것이다.
 */
export function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 위 정책의 술어. **문자열이 아니면 true** — 호출부가 `||` 로 이어 붙일 수 있게. */
export function hasForbiddenText(value, { allowDiffWhitespace = false } = {}) {
  return typeof value !== 'string' || (allowDiffWhitespace ? TEXT_CONTROL_TEXT : CONTROL_TEXT).test(value) ||
    hasUnpairedSurrogate(value);
}

/**
 * 길이와 문자 정책을 함께 본다 — 통과하면 **값**을, 아니면 `null`.
 *
 * ★ boolean 이 아니라 값을 내는 이유는 `safeInteger` 와 같다: 검사한 표현과 쓰는 표현이
 *   갈라지는 자리로 회귀가 들어온다. 길이는 UTF-16 코드유닛으로 센다(이모지 하나 = 2).
 */
export function boundedText(value, max, { allowEmpty = false, allowDiffWhitespace = false } = {}) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) &&
    !hasForbiddenText(value, { allowDiffWhitespace }) ? value : null;
}

/**
 * 세는 말줄임 — 저장소 전체에서 **하나**. WS1 은 사본 셋(`src/engine.mjs` `clip` ·
 * `src/test-runner.mjs` `forMessage` · 여기)을 한 파일에 모아 고정만 했고, 하나로 고르는 것은
 * WS2 의 이 커밋이다(WS1 spec §9 C4 의 해제 조건이 "벤더 프롬프트 바이트를 다시 만드는 커밋").
 *
 * ★ 꼬리표가 영어인 이유: 이 바이트는 봉투(`test-runner` 의 정의 드리프트 메시지)를 타고
 *   사용자에게 나간다 — 런타임 표면은 영어다(로드맵 §5.8). 반대로 이 함수가 자르는 **프롬프트
 *   본문**은 한국어로 남는다(`src/prompts/instructions.mjs`, 같은 §5.8 의 예외).
 * ★ 세는 단위는 **UTF-16 코드유닛**이다(`.length`·`.slice` 그대로, 사본 셋이 그랬다) — 이모지 하나가
 *   2로 세지고 한도에서 쪼개진다. `N` 은 **잘려 나간** 코드유닛 수(`length - limit`)이지 남은 분량이
 *   아니다. 꼬리표에 단위를 안 적는 이유(Task 19 `chars`→`more`): "chars" 는 그 반쪽을 글자라고 부른다.
 * ★ 단수형 분기는 **일부러 없다**(`(+1 more)`). 갈래가 하나면 바이트 핀도 하나다.
 * ★ 비문자열 처리는 `clipPlain` 과 다르고 그것까지 그대로 둔다: `clipCounted(null)` 은 `''`,
 *   `clipPlain(null)` 은 리터럴 `'null'` 이다(`String(value)`).
 */
export function clipCounted(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} more)` : text;
}

export function clipPlain(text, limit) {
  const value = typeof text === 'string' ? text : String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * 꼬리가 짝 없는 서로게이트인가. 문자열 아닌 값에는 쓰지 않는다(호출부가 먼저 거른다).
 *
 * `src/reason-text.mjs` 의 코드 포인트 clip 이 쓰던 판정을 여기로 올렸다 — 자르는 함수가 둘이
 * 되면 이 판정도 둘이 되고, 한쪽만 고치는 날 반쪽 서로게이트가 그 경로로만 새어 나간다.
 */
export function endsWithLoneSurrogate(text) {
  const last = text.charCodeAt(text.length - 1);
  if (Number.isNaN(last) || last < 0xd800 || last > 0xdfff) return false;
  if (last <= 0xdbff) return true;
  const before = text.charCodeAt(text.length - 2);
  return !(before >= 0xd800 && before <= 0xdbff);
}

/**
 * 글자를 쪼개지 않는 말줄임. 꼬리표는 `clipPlain` 과 같은 말줄임표 하나이고 세는 단위도 같은
 * UTF-16 코드유닛이지만, 한도가 서로게이트 쌍 **한가운데** 떨어지면 그 쌍을 통째로 버린다.
 *
 * ★ 왜 `clipPlain` 을 고치지 않고 셋째 함수를 두는가: `clipPlain`·`clipCounted` 가 내는 바이트는
 *   `test/util-strings.test.mjs` 의 표에 못박혀 벤더 프롬프트와 `orch_stats` notice 로 그대로
 *   나간다 — 반쪽 서로게이트가 `Buffer` 에서 U+FFFD 로 바뀐 그 바이트까지 픽스처다. 그 둘을
 *   옮기는 것은 계약 변경이고 이 커밋의 일이 아니다.
 * ★ 이 함수를 쓰는 자리는 자른 값이 **다시 검증되는** 곳이다: verifier 이슈 본문의 claim 은
 *   attempt 기록에 실려 `hasForbiddenText`(짝 없는 서로게이트 거부)를 통과해야 한다 — 반쪽이
 *   남으면 claim 하나 때문에 기록 **전체**가 거절되고 그 레인은 attempt_artifact_failed 로 끝난다.
 * ★ 코드 **포인트**로 세지 않는 이유: 상한을 재는 쪽(`boundedText`)이 코드유닛으로 센다. 두 단위가
 *   갈리면 자른 값이 상한을 넘는 경우가 생긴다(이모지 하나 = 2).
 */
export function clipWhole(text, limit) {
  const value = typeof text === 'string' ? text : String(text);
  if (value.length <= limit) return value;
  let head = value.slice(0, limit);
  while (head.length > 0 && endsWithLoneSurrogate(head)) head = head.slice(0, -1);
  return `${head}…`;
}
