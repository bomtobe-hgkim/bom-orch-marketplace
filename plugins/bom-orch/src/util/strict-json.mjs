import { TextDecoder } from 'node:util';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function skipJsonString(text, index) {
  let at = index + 1;
  while (at < text.length) {
    if (text[at] === '\\') {
      at += 2;
      continue;
    }
    if (text[at] === '"') return at + 1;
    at += 1;
  }
  return -1;
}

const MAX_JSON_DEPTH = 256;

/** JSON.parse의 last-key-wins 모호성까지 거부하는 단일 JSON document parser. */
export function parseStrictJson(input) {
  let text;
  if (typeof input === 'string') {
    text = input;
  } else if (ArrayBuffer.isView(input)) {
    try {
      text = UTF8_DECODER.decode(input);
    } catch {
      return { ok: false, kind: 'invalid_encoding' };
    }
  } else {
    return { ok: false, kind: 'invalid' };
  }
  let at = 0;
  let duplicate = false;
  let tooDeep = false;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? '')) at += 1;
  };
  const string = () => {
    if (text[at] !== '"') return null;
    const start = at;
    at = skipJsonString(text, at);
    return at < 0 ? null : text.slice(start, at);
  };
  const value = (depth = 0) => {
    if (depth > MAX_JSON_DEPTH) {
      tooDeep = true;
      return false;
    }
    whitespace();
    if (text[at] === '"') return string() !== null;
    if (text[at] === '{') {
      at += 1;
      const keys = new Set();
      whitespace();
      if (text[at] === '}') {
        at += 1;
        return true;
      }
      while (true) {
        whitespace();
        const encoded = string();
        if (encoded === null) return false;
        let key;
        try {
          key = JSON.parse(encoded);
        } catch {
          return false;
        }
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        if (text[at++] !== ':' || !value(depth + 1)) return false;
        whitespace();
        if (text[at] === '}') {
          at += 1;
          return true;
        }
        if (text[at++] !== ',') return false;
      }
    }
    if (text[at] === '[') {
      at += 1;
      whitespace();
      if (text[at] === ']') {
        at += 1;
        return true;
      }
      while (true) {
        if (!value(depth + 1)) return false;
        whitespace();
        if (text[at] === ']') {
          at += 1;
          return true;
        }
        if (text[at++] !== ',') return false;
      }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (primitive === null) return false;
    at += primitive[0].length;
    return true;
  };

  const validTokens = value();
  whitespace();
  if (validTokens !== true || at !== text.length || duplicate) {
    return { ok: false, kind: duplicate || tooDeep ? 'ambiguous' : 'invalid' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, kind: 'invalid' };
  }
}
