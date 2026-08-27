/**
 * XML 의 **엄격한 부분집합** 하나를 한 번에 훑는 토크나이저 — DOM 없음, 던지기 없음, 부분집합을
 * 벗어나는 순간 `false`. 이 파일에는 JUnit 이라는 말이 규칙으로 들어오지 않는다: 루트 요소 이름도,
 * `<testcase>` 도, 카운트 속성도 여기서는 아무 뜻이 없다(그 판정은 `readJunitDocument` 의 몫이다).
 *
 * ★ 방향은 한쪽이다: `src/test-evidence.mjs` → 여기. **이 파일은 아무것도 수입하지 않는다**(실측:
 *   import 0줄). 그래서 어댑터 상수 하나도 들여오지 않고 옵션으로 받는다 — 아래 `tokenizeJunitXml`
 *   의 `maxAttributeChars` 가 그 이음매이고, 이 컷이 바꾼 유일한 바이트다.
 *
 * ★ 왜 나왔는가 (WS4a 태스크 7 수정 라운드, 커밋 2). 태스크 7 리뷰가 이 덩어리를 실측했다 —
 *   수입 0개, 분류 상태 0개, 이미 지역 `tokenize()` 헬퍼 하나만 쓰는 테스트 여섯. 어댑터가 스펙 §6
 *   의 700 천장을 넘긴 상태에서 **가장 자연스러운 첫 컷**이고, 이동은 바이트 보존이라
 *   `git diff --color-moved=zebra` 가 이 커밋을 순수 이동으로 읽는다. 두 번째 컷(디스크의 선언된
 *   결과 자리)은 이 커밋이 건드리지 않는다 — 그것은 나중의 컷이다.
 *
 * ★ 아래 첫 배너는 **옮겨 온 바이트 그대로**다. 그것이 이 부분집합이 무엇을 위해 잘렸는지를 적고
 *   있고(생산자 여섯의 방언), 그 두 문단이 이 파일이 존재하는 이유이기도 하다.
 *
 * ★ 실측 폐포: **1개 모듈 / 254줄**(자기 자신뿐). 이 저장소에서 가장 얕은 잎이다 — `test-spawn`
 *   조차 `deadline` 하나를 끈다.
 * ★ 수입하는 쪽(실측 grep): `src/test-evidence.mjs`(`tokenizeJunitXml` 하나)와
 *   `test/xml-subset.test.mjs`. 둘뿐이다.
 */

/**
 * 공개 표면은 이 블록 하나다. **선언 줄에 `export` 를 붙이지 않는** 이유는 태스크 6 의 세 잎과
 * 같다 — 선언을 한 글자도 건드리지 않아야 이 커밋이 순수 이동으로 읽힌다.
 */
export { tokenizeJunitXml };

/**
 * XML 이 갖는 모양의 상한 둘(JSONL 에는 없는 것들, 방언 메모 §9). 나머지 둘
 * (`MAX_JUNIT_DOCUMENTS`·`MAX_JUNIT_NAME_CHARS`)은 JUnit 계약이라 어댑터에 남았다.
 *
 * ★ Depth 32 against a normal maximum of 4 (`testsuites > testsuite > testcase > failure`;
 *   Surefire’s merge-rerun `<stackTrace>` reaches 5). 64 attributes against a Surefire root’s ~10.
 */
const MAX_XML_DEPTH = 32;
const MAX_XML_ATTRIBUTES = 64;

// ── strict subset XML tokenizer — knows no JUnit (WS4a Task 7, cut to this leaf) ──
//
// ★★ Why a hand-written tokenizer. Node ships no XML parser and this repository takes no new
//   dependency, and the regex scraping `parseTrxEvidence` gets away with does NOT survive here:
//   the dialect memo measured four constructs that break it - one value split across several
//   CDATA chunks (Gradle's `]]]]><![CDATA[>`, Surefire's `]]><![CDATA[>`), an XML comment INSIDE
//   a `<testcase>` (Surefire's re-run phase), a raw newline inside an attribute value (Surefire's
//   `line.separator` property) and the failure body nested one level deeper in `<stackTrace>`.
//
// ★★ Why the subset is this small. This is TRUSTED evidence, so permissiveness is the risk.
//   The five predefined entities plus numeric character references are the ONLY expansions, so
//   there is no DTD to read, no external or parameter entity to resolve (XXE surface zero) and
//   billion-laughs is structurally impossible rather than merely bounded.

const XML_ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);
const XML_NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const XML_SPACE = /[ \t\r\n]*/y;

/** One numeric character reference. Surrogate halves and out-of-range code points are refused. */
function xmlCharacterReference(name) {
  const decimal = /^#([0-9]{1,7})$/.exec(name);
  const hex = decimal === null ? /^#x([0-9A-Fa-f]{1,6})$/.exec(name) : null;
  if (decimal === null && hex === null) return null;
  const code = Number.parseInt(decimal === null ? hex[1] : decimal[1], decimal === null ? 16 : 10);
  if (!Number.isInteger(code) || code > 0x10_ff_ff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

/**
 * Literal text or one attribute value: XML 1.0 §2.11 line-end normalization, then the closed
 * entity vocabulary. Any other `&name;` is a refusal - that single rule is what keeps a DTD-less
 * parser from becoming an entity resolver.
 */
function decodeXmlText(raw) {
  const text = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;
  if (!text.includes('&')) return text;
  let out = '';
  let at = 0;
  while (at < text.length) {
    const amp = text.indexOf('&', at);
    if (amp < 0) return out + text.slice(at);
    out += text.slice(at, amp);
    const end = text.indexOf(';', amp + 1);
    if (end < 0 || end - amp > 12) return null;
    const name = text.slice(amp + 1, end);
    const one = XML_ENTITIES.get(name) ?? xmlCharacterReference(name);
    if (one === undefined || one === null) return null;
    out += one;
    at = end + 1;
  }
  return out;
}

/**
 * Single-pass strict-subset XML tokenizer. Emits `onOpen(name, attributes, depth)` /
 * `onText(text)` / `onClose(name)` and returns **false** the moment the document leaves the
 * subset - it never throws and never builds a DOM (an 8 MiB document would cost a multiple of
 * itself in nodes, and three element levels are all any consumer here needs).
 *
 * Accepts: an optional XML declaration (Vitest writes a space before `?>`; a leading BOM is
 * stripped), comments, CDATA merged with the adjacent text nodes into ONE `onText` call, both
 * quote styles with whitespace around `=` and raw newlines inside values, self-closing tags,
 * namespace-prefixed names verbatim (Surefire writes `xmlns:xsi`), and CRLF text.
 *
 * Refuses: `<!DOCTYPE` and every other markup declaration, any processing instruction other than
 * one leading declaration, an undefined entity name, a duplicate attribute, `<` inside an
 * attribute value, unbalanced or unclosed tags, more than one document element, non-whitespace
 * outside the root, and the depth/attribute-count caps. **The root element NAME is not checked
 * here** - the tokenizer is generic, and `readJunitDocument` refuses a root that is not
 * `testsuite`/`testsuites` from its own `onOpen`.
 *
 * ★★ Well-formedness is NOT the contract, and reading the two lists above as one would be a
 *   mistake: three constructs XML 1.0 forbids are accepted here - a comment or whitespace BEFORE
 *   the declaration, a raw `]]>` inside character data, and a numeric reference to a C0 control
 *   or a non-character. What this subset actually promises is the CLOSED VOCABULARY (five named
 *   entities, no DTD, no processing instruction) plus the gates downstream: element text is
 *   validated and then DISCARDED - the adapter reads none of it - and every string that does
 *   survive is a `name`/`classname`/`file` attribute that `normalizeFullTestName` or
 *   `safeRelativeSourcePath` refuses outright if it carries a control character. So the three
 *   are harmless by what happens AFTER them, not because anything here checked them.
 *
 * `maxAttributeChars` is the one thing this module takes from its caller. It is a REQUIRED option
 *   (no default — the number is spelled once, as the ADAPTER’s `MAX_ADAPTER_LINE_CHARS`) and not a
 *   constant here, because importing it would point this leaf back at the file that imports it.
 *
 * @returns `true` when the whole document parsed and its single root closed.
 */
function tokenizeJunitXml(text, { onOpen, onText, onClose, maxAttributeChars }) {
  if (!Number.isSafeInteger(maxAttributeChars) || maxAttributeChars < 1) throw new TypeError('maxAttributeChars must be a positive integer');
  if (typeof text !== 'string' || text === '') return false;
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack = [];
  let declared = false;
  let rootOpened = false;
  let rootClosed = false;
  let run = null;
  const flush = () => {
    if (run === null) return;
    const value = run;
    run = null;
    onText(value);
  };
  const literal = (raw) => {
    if (stack.length === 0) return /^[ \t\r\n]*$/.test(raw);
    const decoded = decodeXmlText(raw);
    if (decoded === null) return false;
    run = run === null ? decoded : run + decoded;
    return true;
  };

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0) return literal(text.slice(at)) && stack.length === 0 && rootClosed;
    if (lt > at && !literal(text.slice(at, lt))) return false;
    at = lt;

    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0 || text.slice(at + 4, end).includes('--')) return false;
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at + 9);
      if (end < 0 || stack.length === 0) return false;
      const chunk = text.slice(at + 9, end).replace(/\r\n?/g, '\n');
      run = run === null ? chunk : run + chunk;
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', at)) return false;
    if (text.startsWith('<?', at)) {
      if (declared || rootOpened || !/^<\?xml[ \t\r\n]/.test(text.slice(at, at + 6))) return false;
      const end = text.indexOf('?>', at + 2);
      if (end < 0) return false;
      declared = true;
      at = end + 2;
      continue;
    }

    if (text.startsWith('</', at)) {
      XML_NAME.lastIndex = at + 2;
      const closing = XML_NAME.exec(text);
      if (closing === null || closing.index !== at + 2) return false;
      XML_SPACE.lastIndex = XML_NAME.lastIndex;
      XML_SPACE.exec(text);
      const end = XML_SPACE.lastIndex;
      if (text[end] !== '>' || stack.pop() !== closing[0]) return false;
      flush();
      onClose(closing[0]);
      if (stack.length === 0) rootClosed = true;
      at = end + 1;
      continue;
    }

    XML_NAME.lastIndex = at + 1;
    const opened = XML_NAME.exec(text);
    if (opened === null || opened.index !== at + 1) return false;
    const depth = stack.length + 1;
    if (depth > MAX_XML_DEPTH || (depth === 1 && rootOpened)) return false;
    let cursor = XML_NAME.lastIndex;
    const attributes = new Map();
    let selfClosing = false;
    for (;;) {
      XML_SPACE.lastIndex = cursor;
      XML_SPACE.exec(text);
      const spaced = XML_SPACE.lastIndex > cursor;
      cursor = XML_SPACE.lastIndex;
      if (text[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (text[cursor] === '/' && text[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (!spaced || cursor >= text.length) return false;
      XML_NAME.lastIndex = cursor;
      const attribute = XML_NAME.exec(text);
      if (attribute === null || attribute.index !== cursor) return false;
      XML_SPACE.lastIndex = XML_NAME.lastIndex;
      XML_SPACE.exec(text);
      cursor = XML_SPACE.lastIndex;
      if (text[cursor] !== '=') return false;
      XML_SPACE.lastIndex = cursor + 1;
      XML_SPACE.exec(text);
      cursor = XML_SPACE.lastIndex;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") return false;
      const end = text.indexOf(quote, cursor + 1);
      if (end < 0) return false;
      const raw = text.slice(cursor + 1, end);
      const value = raw.includes('<') ? null : decodeXmlText(raw);
      if (value === null || attributes.has(attribute[0]) || attributes.size >= MAX_XML_ATTRIBUTES) return false;
      // ★ An over-long value is TRUNCATED, not refused: gotestsum puts the whole skip reason -
      //   kilobytes of `&#xA;`-joined output - inside `<skipped message>`, and refusing that
      //   would throw away a whole run's evidence over a field this adapter never reads.
      attributes.set(attribute[0], value.length > maxAttributeChars ? value.slice(0, maxAttributeChars) : value);
      cursor = end + 1;
    }
    flush();
    if (depth === 1) rootOpened = true;
    if (!onOpen(opened[0], attributes, depth)) return false;
    if (selfClosing) {
      onClose(opened[0]);
      if (depth === 1) rootClosed = true;
    } else {
      stack.push(opened[0]);
    }
    at = cursor;
  }
  return stack.length === 0 && rootClosed;
}
