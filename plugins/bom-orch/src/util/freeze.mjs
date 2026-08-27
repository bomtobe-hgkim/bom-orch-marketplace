/**
 * 깊은 동결 — 저장소 전체에서 하나.
 *
 * 이전에는 같은 이름의 사본이 아홉 벌 있었고 세 등급으로 갈라져 있었다(리서치
 * `docs/superpowers/research/2026-08-16-ws1/helpers.json`, family `deep-freeze`).
 * 등급마다 **다른 입력에서 다르게 무너졌다**: 이미 동결된 루트를 만나면 살아 있는
 * 자식을 남겨 두거나(class A), `null` 에 TypeError 를 던지거나(class B), 자기 순환에서
 * 스택을 넘겼다(class C). 통합 규칙은 하나다 — **가장 많이 얼리고, 가장 적게 터진다.**
 *
 * ★ 부모를 먼저 얼린다. 그래야 순환 그래프에서 자식으로 내려가기 전에 이미 방문
 *   표시가 남아 재귀가 끝난다(class C 가 이 순서를 뒤집어서 RangeError 를 냈다).
 * ★ `seen` 을 따로 들고 다닌다. `Object.isFrozen` 을 방문 표시로 쓰면 호출부가
 *   직접 얼려 둔 루트 밑의 살아 있는 자식을 통째로 놓친다(class A 의 구멍).
 * ★ `Reflect.ownKeys` 로 걷는다 — symbol 키와 비열거 속성도 자식이다. `Object.keys`
 *   만 보던 사본들은 그 자식을 남겨 두었고, 겉만 얼어 있던 객체가 안쪽에서 변했다.
 * ★ 서술자를 읽고 **데이터 속성만** 내려간다. 접근자는 호출하지 않는다 — 던지는
 *   getter 하나가 동결 전체를 예외로 바꾸면 안 된다.
 *
 * ★ **함수도 얼고, 함수 안으로도 내려간다** — 아홉 사본 전부보다 넓어진 지점이라 이름을
 *   붙여 둔다. class A 사본들은 자식을 `typeof child === 'object'` 로 걸렀고(그래서 함수
 *   자식은 손대지 않았다), class B 는 루트만 무조건 얼리고 자식은 같은 필터를 썼다.
 *   여기서는 `function` 이 `object` 와 같은 규칙을 받는다: 함수 자체에 `Object.freeze` 가
 *   걸리고, 그 함수에 매달린 own 속성으로도 내려간다.
 *   실질적 결과 둘 — (1) 얼린 뒤 `fn.cache = …` 같은 사후 부착은 ESM strict mode 에서
 *   TypeError 다(예전에는 조용히 성공했다), (2) 함수를 담은 객체를 얼리면 그 함수의
 *   `prototype` 객체까지 얼어 `fn.prototype.x = …` 도 막힌다. `bind` 된 함수·화살표 함수는
 *   `prototype` 이 없어 해당 없음. `test/util-freeze.test.mjs` 가 이 넓힘을 고정한다.
 */
export function deepFreeze(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const seen = new Set();
  const visit = (node) => {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function') || seen.has(node)) return;
    seen.add(node);
    if (!Object.isFrozen(node)) Object.freeze(node);
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor && 'value' in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
  return value;
}
