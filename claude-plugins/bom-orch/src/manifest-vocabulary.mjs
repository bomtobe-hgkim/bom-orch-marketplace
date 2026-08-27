/**
 * WHY: Import-free manifest vocabulary leaf. 실측 폐포: **1개 모듈 / 15줄**(자기 자신 15 포함).
 */

const LANES = Object.freeze(['lane-a', 'lane-b']);

function validLane(value) {
  return LANES.includes(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export { LANES, sameJson, validLane };
