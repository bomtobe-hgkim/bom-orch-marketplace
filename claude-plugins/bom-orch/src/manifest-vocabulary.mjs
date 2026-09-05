/**
 * WHY: Import-free manifest vocabulary leaf. 실측 폐포: **1개 모듈 / 20줄**(자기 자신 20 포함).
 */

const LANES = Object.freeze(['lane-a', 'lane-b']);

/** 후보 하나가 들 수 있는 회귀 증명 상태의 닫힌 어휘. `deferred` 는 실행 9(2026-08-28)가 낳았다 —
 *  여섯 칸 증명은 이 저장소에서 42분이라 55분 상한이 **다섯 번째 스위트 실행에서** 실행을 끊었고,
 *  그때 봉투는 「아직 안 돌았다」를 `unavailable`(인프라가 못 냈다)로 말해 초록 후보를 떨어뜨렸다. */
const PROOF_STATUSES = Object.freeze(['proved', 'deferred', 'not_applicable', 'not_proven', 'unavailable', 'flaky']);

function validLane(value) {
  return LANES.includes(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export { LANES, PROOF_STATUSES, sameJson, validLane };
