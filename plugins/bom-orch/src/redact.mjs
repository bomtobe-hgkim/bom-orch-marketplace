/**
 * 발췌·로그 줄이 밖으로 나가기 전에 지나는 **하나의** 세척기 — WS2 §3.4.
 *
 * 절대 경로가 상태 루트·프로젝트·홈 밑이면 자리표시자로 접고(`<stateRoot>`·`<project>`·
 * `<home>` — `projectRoot` 만 짧은 이름을 쓴다, 스펙 그대로), API 키·Bearer 토큰·이메일은
 * 통째로 `<redacted>` 로 지운다. `src/reason-text.mjs` 의 `setRedactor` 훅에
 * `makeRedactor(roots)` 를 실제 roots 로 꽂는 것은 Task 10(엔진 배선) 몫이다 — 이 모듈은
 * 그 훅이 부를 순수 함수만 낸다.
 *
 * ★ 비밀 먼저, 경로 나중(순서가 곧 정확성이다). `Bearer` 뒤 토큰이 경로처럼 생겼을 때
 *   경로 규칙이 먼저 돌면 접두사만 `<home>` 으로 접혀 "Bearer <home>/abc" 가 남는다 —
 *   토큰이 경로 모양이었다는 구조 자체를 흘린다. 비밀을 먼저 통째로 지우면 그 구조가
 *   사라진다. 반대 방향(`/home/x/sk-abcdefgh/file` 처럼 경로 조각이 비밀처럼 생긴 경우)도
 *   순서가 지킨다: 비밀 규칙이 그 조각만 지우고("/home/x/<redacted>/file") root 접두사는
 *   그대로 남아 경로 규칙이 이어서 찾는다 — 두 규칙은 같은 글자를 두고 다투지 않는다
 *   (비밀은 안쪽 토큰을, 경로는 바깥쪽 접두사를 본다).
 *
 * ★ root 는 **문자 그대로** 찾는다(일반적인 "절대 경로처럼 보이는 것" 탐지가 아니다) —
 *   호출자가 실제 상태 루트·프로젝트·홈 문자열을 주므로, 텍스트 안에서 그 문자열이
 *   슬래시 방향·(win32 한정) 대소문자만 다르게 나타나도 찾아 접두사를 자른다.
 *
 * ★ 경계는 뒤쪽 `(?!...)` 하나만 둔다(F2, controller 결정 Minor 2). root 의 형제
 *   디렉터리(`x-old`)나 확장자(`state.bak`)를 남 root 로 오판하지 않게 막는 것은 여전히
 *   필요하지만, root 문자열이 **더 깊은 남의 경로/텍스트 안에 끼어** 있는 경우
 *   (`/foo/home/x/file` 에서 root `/home/x`)를 막던 앞쪽 `(?<!...)` 는 뺐다 — 이건 보안
 *   스크럽이라 방향이 비대칭이다: 과잉 탐지의 대가(무해한 문자열 한 조각이 더 접힘)가
 *   과소 탐지의 대가(진짜 절대 경로가 새어 나감)보다 훨씬 작다. 그래서 root 문자열이
 *   어디서 시작하든(단어 뒤든 다른 경로 안이든) 뒤쪽 경계만 지키면 접는다.
 *
 * ★ 가장 긴 root 가 이긴다: 정규화한 길이 내림차순으로 **차례로** 치환한다. project 가
 *   home 안에 있으면 project 패턴이 먼저 그 접두사를 `<project>` 로 바꾸고, 그 순간
 *   원문에서 home 의 리터럴 접두사는 그 자리에서 사라지므로 뒤이은 home 패턴은 같은
 *   자리를 다시 건드리지 못한다 — 우선순위 표를 따로 둘 필요가 없다.
 *
 * ★ `node:path.resolve` 로 정규화하지 않는다. 이 리포는 Windows 호스트에서도 POSIX
 *   root(`/home/x`)를 테스트해야 하는데, win32 의 `resolve('/home/x')` 는 현재 드라이브를
 *   앞에 붙여 다른 문자열을 낸다 — 스타일을 섞어 쓰는 값을 조용히 망가뜨린다. 여기서는
 *   trim 과 trailing separator 제거만 한다(브리프의 "keep it simple").
 */

export const REDACTED = '<redacted>';

/** roots 키 → 자리표시자. */
const TOKEN = { stateRoot: '<stateRoot>', projectRoot: '<project>', home: '<home>' };

// `sk-` 뒤 8자 미만(`sk-1`)은 대조군 — 진짜 키 모양이 아니다. 앞쪽 lookbehind(F3,
// controller 결정 Minor 4)는 `task-abcdefgh12` 처럼 일반 단어 속에 `sk-`가 우연히 끼어
// 있는 경우를 막는다 — 앞에 영숫자·_·- 가 붙어 있으면 그건 키 접두사가 아니라 부분열일
// 뿐이다. `=`·공백·따옴표·텍스트 시작처럼 "값이 여기서 시작한다"는 신호 뒤에서는
// 그대로 지운다(경로 규칙 F2 와 반대 방향 — 여긴 오탐이 아니라 미탐을 더 걱정해야 한다:
// 일반 텍스트를 망가뜨리는 비용이 실제로 크다).
const SK_PATTERN = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g;
// "Bearer " 는 남기고 토큰만 지운다 — 문장 모양을 유지한다(브리프의 의문 해소).
const BEARER_PATTERN = /Bearer \S+/g;
// F1: 로컬파트·라벨 모두 상한을 둔다 — RFC 5321 §4.5.3.1 로컬파트 ≤64옥텟, 각 라벨
// ≤63옥텟. 예전 `[\w.+-]+@[\w-]+\.[\w.-]+` 는 로컬파트가 상한 없는 `+`로 끝나, `@` 가
// 없는 텍스트에서는 시작 위치마다 문자열 끝까지 훑고 한 글자씩 역추적했다(O(n) 위치 ×
// O(n) 역추적 = O(n²); 실측 40,000자 닷/워드 텍스트 → 2.1초). 상한을 두면 위치당
// 역추적 폭이 최대 64로 묶여 전체가 O(n) 이 된다. `redactSecrets` 의 `@` 짧은회로와
// 두 겹으로 막는다(하나가 아니라 둘 다 두는 이유: 상한만으로도 선형이지만, `@` 가
// 아예 없으면 스캔 자체를 생략하는 쪽이 상수 배로 더 싸다).
export const EMAIL_PATTERN = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;

function redactSecrets(text) {
  let out = text.replace(SK_PATTERN, REDACTED).replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  // F1: `@` 가 없으면 이메일 규칙은 절대 매치할 수 없다 — 정규식을 아예 안 돌린다.
  if (out.includes('@')) out = out.replace(EMAIL_PATTERN, REDACTED);
  return out;
}

/** root 문자열 → 슬래시 방향 무관 정규식 소스(구분자 자리만 `[\/]` 류 클래스로 바꾼다). */
function slashAgnostic(root) {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\\\\|\//g, '[\\\\/]');
}

/** trim + trailing separator 제거. 빈 값·문자열 아닌 값은 규칙을 끈다(`null`). */
function normalizeRoot(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * roots → 텍스트 세척 함수. root 는 **한 번만** 정규화해 닫힘 안에 담는다(엔진이 실행마다
 * 한 번 만들어 여러 줄에 재사용하는 모양을 전제한다 — Task 10).
 *
 * `platform` 은 테스트 전용 두 번째 인자다(house style: `util/paths.mjs` 의 `samePath`·
 * `contained` 와 같은 모양) — 기본값은 실제 플랫폼이고, win32 전용 대소문자 무시 분기를
 * 아무 호스트에서나 결정적으로 테스트하려는 목적 하나뿐이다.
 *
 * ★ (F4, controller 승인) 이 두 번째 인자는 브리프 원문 시그니처 `makeRedactor(roots)`
 *   보다 하나 많지만 sanctioned house pattern 이다 — 이유는 위와 같다(어느 호스트에서
 *   돌든 win32 분기를 결정적으로 검증하기 위함), 새 규칙을 발명한 게 아니라 이미 있는
 *   관례를 그대로 옮긴 것이다.
 */
export function makeRedactor(roots = {}, platform = process.platform) {
  const caseInsensitive = platform === 'win32';
  const patterns = Object.entries(TOKEN)
    .map(([key, token]) => [token, normalizeRoot(roots?.[key])])
    .filter(([, root]) => root !== null)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([token, root]) => [
      token,
      // F2: 앞쪽 lookbehind 없음 — 위 클래스 JSDoc 참고(과잉-redaction 이 안전한 방향).
      new RegExp(`${slashAgnostic(root)}(?![A-Za-z0-9_.-])`, caseInsensitive ? 'gi' : 'g'),
    ]);

  return function redact(text) {
    if (typeof text !== 'string') return text;
    let out = redactSecrets(text);
    for (const [token, pattern] of patterns) out = out.replace(pattern, token);
    return out;
  };
}

/** 한 번 쓰고 버릴 때 쓰는 축약형 — 내부는 `makeRedactor` 하나다(발췌·로그가 같은 함수를 쓴다). */
export function redactText(text, roots = {}) {
  return makeRedactor(roots)(text);
}
