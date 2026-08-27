import { createHash } from 'node:crypto';

/**
 * SHA-256 — 저장소 전체에서 하나.
 *
 * 사본 여섯 벌(`reaper`·`regression-proof`·`run-artifacts`·`test-runner`·
 * `candidate-selection.digest`·`engine.qualityHash`)의 차이는 인코딩 인자뿐이었고,
 * Node 의 기본값이 utf8 이라 오늘의 다이제스트는 여섯 다 같다(실측). 그래서 이
 * 통합으로 움직이는 해시는 하나도 없다.
 *
 * ★ 문자열은 `Buffer.from(value, 'utf8')` 로 명시해 바꾼다. 기본값에 기대는 철자가
 *   다섯 벌이나 있었다는 사실이 위험이다 — 언젠가 한 줄이 latin1 로 바뀌면 저장된
 *   증거 해시와 계획 지문이 전부 조용히 어긋난다.
 */
export function sha256(bytes) {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

/**
 * `JSON.stringify` 한 값의 SHA-256. 키 순서를 정하는 책임은 호출부에 남는다 —
 * 여기서 몰래 정렬하면 이미 저장된 지문이 전부 어긋난다.
 *
 * ★ `undefined` 는 던진다(`JSON.stringify(undefined)` 가 문자열이 아니므로).
 *   사본도 그랬고, 그래서 엔진의 계획 지문은 `hashJson(testPlan ?? null)` 로 부른다.
 */
export function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}
