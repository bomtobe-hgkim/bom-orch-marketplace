/**
 * 객체 모양 검사 — 저장소 전체에서 하나.
 *
 * 이전에는 같은 일을 하는 사본이 24벌 있었다(리서치 `helpers.json`: `exact-object` 11,
 * `exact-dense-array` 4, `own-data-accessor` 4, `json-deep-clone` 5). `exact-object` 만 해도
 * **반환형이 네 등급**으로 갈라져 있었다 — 입력을 그대로 돌려주는 것, 스냅샷을 돌려주는 것,
 * 요청한 키만 훑는 부분 스냅샷, 그리고 boolean. 이름은 다 비슷했고(`exactObject`·`exactKeys`·
 * `exactDataObject`·`descriptorObject`) 계약만 달랐다.
 *
 * 통합 규칙은 **가장 엄격한 사본 + 실측된 결함 두 개를 고친 것**이다:
 *   ★ 결과는 입력 참조가 아니라 **스냅샷**이다. 검사와 사용 사이의 TOCTOU 창이 여기서 닫힌다 —
 *     Proxy 의 `getOwnPropertyDescriptor` 는 data descriptor 라고 답한 뒤 이어지는 읽기에서
 *     다른 값을 줄 수 있고, 설정 가능한 속성은 검사 직후에 바뀔 수 있다.
 *   ★ own `__proto__` 키는 **거부**한다. 스냅샷 사본 셋은 `out[key] = value` 가 Object.prototype
 *     의 setter 를 때려서 그 키를 조용히 **잃고** 있었다. `JSON.parse` 는 `__proto__` 를 own
 *     data property 로 만들기 때문에 이 경로는 적대적 모델 출력에서 실제로 닿는다.
 *   ★ 통째 try/catch. 취소된 Proxy 에 사본 다섯이 TypeError 를 던졌다 — 검증기는 입력 때문에
 *     터지면 안 된다.
 *
 * ★ **`cloneData` 에는 승인된 사본이 하나 있다**: `src/run-store-fs.mjs` 의
 *   `cloneExactData`. 남은 이유는 `Buffer.isBuffer` 분기 하나뿐이고(아티팩트 이벤트는
 *   바이트를 그대로 실어 나른다), 위 세 규칙 — own `__proto__` 거부 포함 — 은 그쪽에도
 *   같은 글자로 적혀 있다. "저장소 전체에서 하나" 는 **정의가 하나**라는 뜻이지 사본이
 *   0 이라는 뜻이 아니므로, 사본이 생기면 여기에 이름을 적는다.
 *
 * ★ **위 세 규칙은 `snapshotOwnDataObject` 를 뺀 나머지 export 의 것이다.** 그 부분 스냅샷만은 own
 *   `__proto__` 를 거부하지 않는다 — `snapshot[key] = …` 가 `Object.prototype` 의 setter 를 때려
 *   그 키가 조용히 사라지고(값이 객체면 스냅샷의 프로토타입이 그것이 된다), 낸 스냅샷도 `{}`
 *   리터럴이라 `Object.prototype` 을 상속한다. 엔진에서 **바이트 동일**하게 옮겨 온 것이라 좁히지 않았다(Task 17; keys 없이 부르는 호출부는 `src/engine.mjs` ~:613 하나다).
 */

// 없음을 뜻하는 한 벌짜리 답. 얼려 두는 이유는 호출부가 이걸 손대면 **다음 호출의 답까지**
// 바뀌기 때문이다 — 공유 상수의 유일한 위험이 그것이고, 얼려 두면 그 실수가 조용하지 않다.
const NOT_FOUND = Object.freeze({ ok: false, value: undefined });

function no(reason) {
  return { ok: false, reason };
}

/**
 * `value` 가 정확히 `keys` 만 가진 평범한 데이터 객체인지 보고, 맞으면 그 스냅샷을 낸다.
 *
 * 거부 이유는 `not_object`·`extra_key`·`missing_key`·`proto_key`·`accessor`·`undefined_value`·
 * `revoked_proxy` 일곱 가지다. 이유를 값으로 내는 이유는 호출부마다 **다른 reason code 로**
 * 나가야 하기 때문이 아니라(대부분은 그냥 거부한다), 어느 입력 등급에서 거부됐는지가
 * 테스트 이름과 진단에 남아야 하기 때문이다.
 *
 * ★ `accessor` 는 "own 열거 data property 가 아니다"를 뜻한다 — getter/setter 뿐 아니라
 *   비열거 own 데이터 속성도 여기로 들어온다. getter 는 **호출하지 않는다**(서술자만 읽는다).
 * ★ 프로토타입은 `Object.prototype` 만 받는다. null 프로토타입도 거부한다 — `JSON.parse` 는
 *   null 프로토타입 객체를 만들지 않으므로 벤더 JSON 경로에서는 이 거부가 닿지 않고,
 *   내부 생산자도 객체 리터럴만 쓴다.
 */
export function exactObject(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) return no('not_object');
    const own = Reflect.ownKeys(value);
    if (own.includes('__proto__')) return no('proto_key');
    if (own.some((key) => typeof key !== 'string' || !keys.includes(key))) return no('extra_key');
    if (keys.some((key) => !own.includes(key))) return no('missing_key');
    const snapshot = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return no('accessor');
      if (descriptor.value === undefined) return no('undefined_value');
      snapshot[key] = descriptor.value;
    }
    return { ok: true, value: snapshot };
  } catch {
    return no('revoked_proxy');
  }
}

/**
 * 같은 검사의 boolean 판.
 *
 * ★ 사본 넷(`test-runner` 둘·`regression-proof`·`verdict`)이 boolean 을 선언해 놓고 `value &&`
 *   단락 때문에 `undefined` 입력에 **입력을 그대로** 돌려주고 있었다. 여기서는 그럴 수 없다.
 */
export function hasExactKeys(value, keys) {
  return exactObject(value, keys).ok;
}

/**
 * 구멍도 undefined 원소도 없는 진짜 배열인지 보고, 맞으면 **복사본**을 낸다.
 *
 * 사본 넷에 흩어져 있던 가드의 합집합이다: `Array.isArray` **그리고** 프로토타입이
 * `Array.prototype`, 길이 ≤ `max`, own 키가 정확히 `[0..n-1, 'length']`, `length` 는 비열거
 * 데이터 속성, 원소는 전부 열거 가능한 데이터 속성이며 `undefined` 가 아니다.
 *
 * ★ `length` 서술자를 먼저 읽는 이유는 `value.length` 가 Proxy 에서 다른 값을 줄 수 있어서다 —
 *   길이는 검사에 쓰인 그 값이어야 한다.
 */
export function exactDenseArray(value, max = Number.MAX_SAFE_INTEGER) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || length.enumerable !== false || !Object.hasOwn(length, 'value') || length.value > max) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== length.value + 1 || own.at(-1) !== 'length') return null;
    const snapshot = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value') ||
          descriptor.value === undefined) return null;
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * 속성 하나를 안전하게 읽는다 — 모든 `exact*` 검사가 서 있는 바닥.
 *
 * ★ `{ ok, value }` 쌍인 이유는 **저장된 `undefined` 와 없는 키가 구별되어야** 하기 때문이다.
 *   sentinel 을 쓰던 사본은 그 sentinel 이 모듈 밖으로 새면 값처럼 비교됐다.
 * ★ accessor 는 호출하지 않는다. `learn/policy-v2` 사본은 `value[key]` 로 읽어서 getter 를
 *   **실행**했다 — 적대적 입력에 코드 실행을 내주는 읽기다.
 */
export function ownDataValue(value, key) {
  try {
    if (value === null || typeof value !== 'object') return NOT_FOUND;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
      ? { ok: true, value: descriptor.value }
      : NOT_FOUND;
  } catch {
    return NOT_FOUND;
  }
}

/**
 * **부분** 스냅샷 — 있는 키만 담고, 없는 키는 넘어가고, accessor 하나만 만나면 null 을 낸다.
 *
 * ★ 이름이 비슷해서 리서치는 이것을 `exact-object` 계열로 묶었지만 계약이 다르다. 호출부가
 *   요구하는 것은 "정확히 이 키들"이 아니라 "**getter 없이** 읽을 수 있는 것만 떼어 오기"다:
 *   `orch_run` 의 옵션 객체는 12개 키 중 둘만 오고(`task`·`projectPath`), `deps` 는 키 목록
 *   자체가 없으며(`keys = null`), `blocked()` 결과는 네 키 중 둘만 가진다. 공유
 *   `exactObject` 로 바꾸면 그 셋이 전부 즉시 거부된다(앞 둘은 missing_key, `blocked()` 는
 *   `ok`·`blocked`·`error`·`recovery` 네 키를 내므로 요청한 네 키와 어긋나 missing_key +
 *   extra_key) — 그래서 여기 남는다.
 * ★ 남는 대신 **역할이 좁아졌다**. 정확한 모양 검사는 전부 공유 `exactObject` 로 갔고
 *   (`snapshotExactEnumerableDataObject` 는 사라졌다), 이 함수는 "accessor 없는 own 데이터만
 *   떼어 온다"는 한 가지 일만 한다.
 */
export function snapshotOwnDataObject(value, keys = null) {
  try {
    const names = keys ?? Reflect.ownKeys(value);
    const snapshot = {};
    for (const key of names) {
      if (typeof key !== 'string') continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function cloneNode(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const array = exactDenseArray(value);
      if (array === null) return undefined;
      const out = [];
      for (const child of array) {
        const cloned = cloneNode(child, seen);
        if (cloned === undefined) return undefined;
        out.push(cloned);
      }
      return out;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.includes('__proto__') || keys.some((key) => typeof key !== 'string')) return undefined;
    const out = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return undefined;
      const cloned = cloneNode(descriptor.value, seen);
      if (cloned === undefined) return undefined;
      out[key] = cloned;
    }
    return out;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

/**
 * JSON 으로 표현되는 값의 깊은 복사 — 표현할 수 없으면 뭉개지 않고 `undefined` 를 낸다.
 *
 * 사본 다섯 중 셋은 `JSON.parse(JSON.stringify(v))` 였고 하나는 구조적 재귀였다. 그 왕복은
 * 실패를 **조용한 손실**로 바꾼다: `Date` 는 문자열이 되고, 함수와 `undefined` 값 키는 사라지고,
 * `NaN` 은 `null` 이 되고, 순환은 TypeError 로 터지고, `undefined` 입력은 SyntaxError 로 터졌다.
 * 검증된 데이터를 복사하는 자리에서 그런 손실은 다음 검증기가 거부할 값을 만들어 낸다.
 *
 * ★ `seen` 은 재귀 경로에서만 유효하다(빠져나오며 지운다) — 형제로 두 번 나오는 같은 객체는
 *   순환이 아니라 두 벌로 복사된다. JSON 왕복이 하던 것과 같다.
 * ★ 결과는 얼리지 않는다. 복사 직후 손을 대는 호출부(`verdict` 의 원장 갱신)가 있다.
 */
export function cloneData(value) {
  return cloneNode(value, new Set());
}
