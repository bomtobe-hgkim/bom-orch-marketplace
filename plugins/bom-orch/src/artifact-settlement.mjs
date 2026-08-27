import { isAbsolute } from 'node:path';
import { isReasonCode } from './reason-codes.mjs';
import { exactObject, snapshotOwnDataObject } from './util/objects.mjs';

/**
 * 아티팩트 정산(settlement) 판정 — 엔진에서 떼어 낸 한 덩어리. **WS1 종료 시점부터 이 모듈의 소유자는 WS2 다**(`contract/module-budget.json` 의 `owners`): WS1 은 engine 을 3,700 줄 밑으로 내리려고 클러스터를 옮겼을 뿐 판정도 문자열도 건드리지 않았고, 실측을 목표 200 으로 줄이는 일과 문자열 번역은 WS2 의 몫이다.
 *
 * 엔진이 아티팩트 저장소·매니페스트 체크포인트에서 받는 결과는 **주입된 남의 객체**다. 이 모듈이
 * 하는 일은 하나다: 그 결과를 accessor 없는 스냅샷으로 굳히고, 정해진 네 모양(hard_stop·blocked·
 * success·unknown) 중 무엇인지 판정한다. 모양이 어긋나면 값을 고쳐 주지 않고 `unknown` 으로 닫는다 —
 * 정산은 추측할 수 있는 것이 아니기 때문이다.
 *
 * ★ `ARTIFACT_SETTLEMENT_SOURCE_KEYS` 가 이 모듈 안에 있어야 하는 이유: 검증기는 스냅샷이 아니라
 *   **원본이 실제로 갖고 있던 키 목록**을 봐야 한다. 스냅샷은 없는 키를 담지 않으므로 원본의 키를
 *   잃으면 `{blocked,error}` 와 `{blocked,error,recovery}` 를 구별할 수 없다. 그 목록은
 *   `snapshotArtifactSettlement` 만이 적어 넣고 이 파일 밖으로 나가지 않는다.
 */

function validArtifactWriterSuccess(result, { kind, candidateId, path, bytes, sha256: expectedSha256 }) {
  try {
    const allowedResultKeys = ['ok', 'ref', 'revision', 'manifestRef', 'duplicate'];
    const resultKeys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    if (resultKeys.length !== allowedResultKeys.length ||
        resultKeys.some((key) => typeof key !== 'string' || !allowedResultKeys.includes(key))) return false;
    const outer = snapshotOwnDataObject(result, resultKeys);
    const refKeys = ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt'];
    const ref = outer === null ? null : snapshotOwnDataObject(outer.ref, refKeys);
    const actualKeys = ref === null ? [] : Reflect.ownKeys(outer.ref);
    return outer?.ok === true && ref !== null &&
      Number.isSafeInteger(outer.revision) && outer.revision >= 0 &&
      typeof outer.duplicate === 'boolean' && outer.manifestRef !== null && typeof outer.manifestRef === 'object' &&
      actualKeys.length === refKeys.length && actualKeys.every((key) => typeof key === 'string' && refKeys.includes(key)) &&
      ref.kind === kind && ref.candidateId === candidateId && ref.path === path && isAbsolute(ref.path) &&
      ref.sha256 === expectedSha256 && ref.bytes === bytes && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 &&
      Number.isSafeInteger(ref.expiresAt) && ref.expiresAt > 0;
  } catch {
    return false;
  }
}

function validManifestRef(ref, { path, revision, expiresAt }) {
  try {
    const keys = Reflect.ownKeys(ref);
    const expectedKeys = ['kind', 'path', 'revision', 'expiresAt'];
    const outer = snapshotOwnDataObject(ref, keys);
    return outer !== null && keys.length === expectedKeys.length &&
      keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      outer.kind === 'manifest' && outer.path === path && isAbsolute(outer.path) &&
      outer.revision === revision && Number.isSafeInteger(outer.revision) && outer.revision >= 0 &&
      (expiresAt === null || outer.expiresAt === expiresAt) &&
      Number.isSafeInteger(outer.expiresAt) && outer.expiresAt > 0;
  } catch {
    return false;
  }
}

/**
 * 두 검증기가 받는 키 집합은 **세 세대**다(이력은 `contract/envelope.json` 의 `internalBlocked` 행):
 * 엔진 안에서 만드는 세 키 `{blocked, error, recovery}`, 공용 `blocked()`(`src/util/errors.mjs`)의
 * 네 키(`ok:false`), WS2 `fail()`(`src/reason-text.mjs`)의 다섯 키(`reasonCode`). 호출부가 태스크마다
 * `fail()` 로 옮겨 가므로 이행 기간 동안 셋이 동시에 들어온다.
 *
 * ★ 왜 넓히는 것이 안전한가 (실측된 회귀). 정확히 세 키만 받던 동안 진짜 저장소 거절 셋이 전부
 *   `unknown` 으로 떨어져 `artifact_store_authority_lost` 오염으로 승격됐고, 레인 하나에서 회복할 수
 *   있었던 실패가 실행 전체를 죽였다. 봉투가 한 키 자라면 여기가 조용히 닫힌다.
 * ★ 그래도 `ok !== true` 는 요구한다. 키를 넓히는 것과 **성공을 실패로 읽는 것**은 다른 문제다:
 *   `ok:true` 가 blocked 로 통과하면 그때부터 성공한 쓰기가 막힌 것으로 정산된다.
 * ★ `reasonCode` 는 **있으면 등재된 코드여야 한다.** 개수만 세면 `{reasonCode:'nope'}` 가 통과해
 *   닫힌 어휘가 새어 나가고, 소비자의 switch 는 아무 가지에도 안 걸린 채 "코드가 있다" 고 읽는다.
 */
const acceptableReasonCode = (result) => !Object.hasOwn(result, 'reasonCode') || isReasonCode(result.reasonCode);

function validArtifactBlocked(result) {
  try {
    const keys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    const expectedKeys = ['ok', 'blocked', 'reasonCode', 'error', 'recovery'];
    return keys.length >= 3 && keys.length <= expectedKeys.length &&
      keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      result.ok !== true && acceptableReasonCode(result) &&
      result.blocked === true && typeof result.error === 'string' && result.error !== '' &&
      typeof result.recovery === 'string' && result.recovery !== '';
  } catch {
    return false;
  }
}

/** 위와 같은 이유로 `'ok'`·`'reasonCode'` 를 받는다. `recovery` 는 여기서만 선택적이다(`recoveryStage`). */
function validArtifactHardStop(result) {
  try {
    const keys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    const expectedKeys = ['ok', 'blocked', 'hardStopped', 'reasonCode', 'error', 'recovery'];
    return keys.length >= 3 && keys.length <= expectedKeys.length &&
      keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      result.ok !== true && acceptableReasonCode(result) &&
      result.blocked === true && result.hardStopped === true && typeof result.error === 'string' && result.error !== '' &&
      (!Object.hasOwn(result, 'recovery') || typeof result.recovery === 'string' && result.recovery !== '');
  } catch {
    return false;
  }
}

function validArtifactCheckpointSuccess(result, authority) {
  try {
    const keys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    const expectedKeys = ['revision', 'manifestRef', 'duplicate'];
    return keys.length === expectedKeys.length && keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      Number.isSafeInteger(result.revision) && result.revision >= 0 && typeof result.duplicate === 'boolean' &&
      validManifestRef(result.manifestRef, { ...authority, revision: result.revision });
  } catch {
    return false;
  }
}

function validArtifactWriterSettlement(result, writerAuthority, manifestAuthority) {
  return validArtifactWriterSuccess(result, writerAuthority) &&
    manifestAuthority.expiresAt !== null && result.ref.expiresAt === manifestAuthority.expiresAt &&
    validManifestRef(result.manifestRef, { ...manifestAuthority, revision: result.revision });
}

const ARTIFACT_REF_KEYS = Object.freeze(['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']);
const MANIFEST_REF_KEYS = Object.freeze(['kind', 'path', 'revision', 'expiresAt']);
const ARTIFACT_SETTLEMENT_KEYS = Object.freeze([
  'ok', 'blocked', 'hardStopped', 'reasonCode', 'error', 'recovery', 'ref', 'manifestRef', 'revision', 'duplicate',
]);
const ARTIFACT_SETTLEMENT_SOURCE_KEYS = new WeakMap();

function blockedArtifactSettlement(error) {
  return Object.freeze({ blocked: true, error });
}

export function unknownArtifactSettlement() {
  return blockedArtifactSettlement('artifact_store_authority_lost');
}

function snapshotArtifactSettlement(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const sourceKeys = Reflect.ownKeys(value);
    if (sourceKeys.some((key) => typeof key !== 'string' || !ARTIFACT_SETTLEMENT_KEYS.includes(key))) return null;
    const raw = exactObject(value, sourceKeys).value ?? null;
    if (raw === null) return null;
    const snapshot = {};
    for (const key of sourceKeys) {
      if (Object.hasOwn(raw, key)) snapshot[key] = raw[key];
    }
    if (Object.hasOwn(snapshot, 'ref')) {
      const refKeys = Reflect.ownKeys(snapshot.ref);
      if (refKeys.some((key) => typeof key !== 'string' || !ARTIFACT_REF_KEYS.includes(key))) return null;
      const ref = exactObject(snapshot.ref, refKeys).value ?? null;
      if (ref === null) return null;
      snapshot.ref = Object.freeze(ref);
    }
    if (Object.hasOwn(snapshot, 'manifestRef')) {
      const manifestKeys = Reflect.ownKeys(snapshot.manifestRef);
      if (manifestKeys.some((key) => typeof key !== 'string' || !MANIFEST_REF_KEYS.includes(key))) return null;
      const manifestRef = exactObject(snapshot.manifestRef, manifestKeys).value ?? null;
      if (manifestRef === null) return null;
      snapshot.manifestRef = Object.freeze(manifestRef);
    }
    const normalized = Object.freeze(snapshot);
    ARTIFACT_SETTLEMENT_SOURCE_KEYS.set(normalized, Object.freeze([...sourceKeys]));
    return normalized;
  } catch {
    return null;
  }
}

export function snapshotStoreArtifactAuthority(value, expectedPath) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const outerKeys = Reflect.ownKeys(value);
    if (outerKeys.length !== 1 || outerKeys[0] !== 'manifestRef') return null;
    const outer = exactObject(value, outerKeys).value ?? null;
    if (outer === null || outer.manifestRef === null || typeof outer.manifestRef !== 'object' ||
        Array.isArray(outer.manifestRef)) return null;
    const refKeys = Reflect.ownKeys(outer.manifestRef);
    if (refKeys.length !== MANIFEST_REF_KEYS.length ||
        refKeys.some((key) => typeof key !== 'string' || !MANIFEST_REF_KEYS.includes(key))) return null;
    const ref = exactObject(outer.manifestRef, refKeys).value ?? null;
    if (ref === null || !validManifestRef(ref, {
      path: expectedPath,
      revision: 0,
      expiresAt: ref.expiresAt,
    })) return null;
    return Object.freeze({ path: ref.path, expiresAt: ref.expiresAt });
  } catch {
    return null;
  }
}

export function classifyArtifactSettlement(value, { kind, authority = null } = {}) {
  const result = snapshotArtifactSettlement(value);
  if (result === null) return { kind: 'unknown', result: unknownArtifactSettlement() };
  if (validArtifactHardStop(result)) return { kind: 'hard_stop', result };
  if (validArtifactBlocked(result)) return { kind: 'blocked', result };
  if (kind === 'checkpoint' && validArtifactCheckpointSuccess(result, authority)) {
    return { kind: 'success', result };
  }
  if (kind === 'writer' && validArtifactWriterSettlement(result, authority.writer, authority.manifest)) {
    return { kind: 'success', result };
  }
  return { kind: 'unknown', result: unknownArtifactSettlement() };
}

export function acceptArtifactRevision(result, revisionAuthority) {
  const revision = result?.revision;
  const duplicate = result?.duplicate;
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof duplicate !== 'boolean') return false;
  if (duplicate ? revision < revisionAuthority.latest : revision <= revisionAuthority.latest) return false;
  revisionAuthority.latest = Math.max(revisionAuthority.latest, revision);
  return true;
}

export const UNPROVEN_REMOVAL = Object.freeze({
  ok: false,
  removed: false,
  unregistered: false,
  proven: false,
});

export function snapshotRemovalResult(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return UNPROVEN_REMOVAL;
    const keys = Reflect.ownKeys(value);
    const expectedKeys = ['ok', 'removed', 'unregistered'];
    if (keys.length !== expectedKeys.length ||
        keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return UNPROVEN_REMOVAL;
    const raw = exactObject(value, keys).value ?? null;
    if (raw === null || !Object.hasOwn(raw, 'ok') || !Object.hasOwn(raw, 'removed') ||
        !Object.hasOwn(raw, 'unregistered') || typeof raw.ok !== 'boolean' ||
        typeof raw.removed !== 'boolean' ||
        !(typeof raw.unregistered === 'boolean' || raw.unregistered === null)) {
      return UNPROVEN_REMOVAL;
    }
    return Object.freeze({
      ok: raw.ok,
      removed: raw.removed,
      unregistered: raw.unregistered,
      proven: true,
    });
  } catch {
    return UNPROVEN_REMOVAL;
  }
}
