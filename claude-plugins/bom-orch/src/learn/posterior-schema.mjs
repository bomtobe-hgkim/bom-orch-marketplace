export const POSTERIORS_SCHEMA_VERSION = 1;

const FILE = 'posteriors.json';
const VERSION_KEY = 'schemaVersion';

/** JSON.parse가 큰 양의 정수를 +Infinity로 반올림해도 JSON-safe 진단값을 남긴다. */
function jsonSafeSchemaVersion(value) {
  if (Number.isInteger(value)) return value;
  return value === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : null;
}

/** marker 부재만 v0다. 존재하는 marker는 유효한 음이 아닌 정수여야 쓰기 권위를 준다. */
export function classifyPosteriorsSchema(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, VERSION_KEY)) {
    return { status: 'legacy' };
  }
  const found = jsonSafeSchemaVersion(raw[VERSION_KEY]);
  if (!Number.isInteger(found) || found < 0) return { status: 'invalid' };
  if (found > POSTERIORS_SCHEMA_VERSION) {
    return {
      status: 'newer',
      stateSchema: { file: FILE, status: 'newer', found, supported: POSTERIORS_SCHEMA_VERSION },
    };
  }
  return { status: found === POSTERIORS_SCHEMA_VERSION ? 'current' : 'legacy' };
}

/** 메타 키를 셀 이름으로 노출하지 않는다. 나머지 날것은 reset의 선택 삭제를 위해 보존한다. */
export function posteriorCellsOf(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== VERSION_KEY));
}

/** v0 target도 쓰는 순간 v1이 된다. 입력의 예약 키는 현재 세대로 강제한다. */
export function versionedPosteriors(cells) {
  return Object.fromEntries([
    [VERSION_KEY, POSTERIORS_SCHEMA_VERSION],
    ...Object.entries(cells).filter(([key]) => key !== VERSION_KEY),
  ]);
}
