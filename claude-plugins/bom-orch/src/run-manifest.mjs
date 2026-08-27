/**
 * 실행 매니페스트 v1 의 **문서 자체** — 스키마·정규화·정준 순서와 행 사이 일관성.
 *
 * WS2 Task 12 가 `src/run-artifacts.mjs`(3,050줄)에서 **바이트 그대로** 옮겼다. 저 파일은 두 가지를
 * 한 데 담고 있었다: (a) 디스크 위의 저장소 — 권한·원자적 발행·잠금·쓰기 큐, (b) 매니페스트라는
 * **값** — 무엇이 적법한 매니페스트인가. 여기 있는 것은 (b) 뿐이고, 그중 「적법한 한 걸음」은 WS4a 태스크 3 이 `src/manifest-transition.mjs`(위쪽 잎)로, 선택 행은 `src/manifest-selection.mjs`(아래쪽 잎)로 냈다.
 *
 * ★ 이 파일은 `src/run-artifacts.mjs` 를 import 하지 않는다 — 방향은 저장소 → 문서 한쪽이다.
 *   순환이 생기는 순간 "이 모듈은 디스크를 모른다" 는 위 문장이 거짓이 되고, 여기 있는 함수들이
 *   순수하다는 것(같은 입력에 같은 답)도 더는 검사로 확인할 수 없다.
 *
 * ★ 그래서 저장소의 `state` 를 읽는 함수는 여기 없다. `manifestRef`·`finalPathForIdentity` 처럼
 *   경로 배치를 아는 것들은 저쪽에 남았다. 반대로 `boundedString`·`ordinal`·`relativeJson` 과
 *   `normalizeInitialManifest` 군은 여기로 왔다 — 그것들이 정의하는 것이 매니페스트의 어휘이고,
 *   저쪽은 이 모듈에서 **가져다** 쓴다.
 *
 * ★ 정규화는 **읽은 값을 고쳐 쓰지 않는다.** `normalizeRunManifestV1` 은 마지막에
 *   `sameJson(value, normalized)` 로 왕복을 확인하고 `appliedEvents[].eventSha256` 은 그 바이트
 *   위에서 뜬 digest 다. 한 필드라도 지금 어휘로 "올려" 쓰면 그 두 검사가 동시에 무너진다 —
 *   옛 철자를 받아들이는 자리(WS2 §2.4)가 검사만 별칭으로 하고 값은 그대로 두는 이유다.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LANES, sameJson, validLane } from './manifest-vocabulary.mjs';
import { normalizeSelection, selectionConsistent } from './manifest-selection.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { contained, samePath } from './util/paths.mjs';
import { exactDenseArray, exactObject } from './util/objects.mjs';
import { boundedText, compareUtf8, hasForbiddenText, isSafeCount } from './util/strings.mjs';
import { REASON, normalizeLegacyReasonCode } from './reason-codes.mjs';

export const RUN_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

// ★ 두 바이트 상한은 **문서 쪽 값**이라 여기 산다(WS4a 태스크 1 수리 라운드가 `src/run-artifacts.mjs` 에서
//   바이트 그대로 옮겼다). `MAX_JSON_ARTIFACT_BYTES` 는 매니페스트의 ref 가 약속하는 JSON 기록의 상한이고
//   (`pendingArtifacts[].expectedBytes`·`committedArtifacts[].ref.bytes` 를 이 수로 잰다),
//   `MAX_RUN_MANIFEST_BYTES` 는 이 파일이 스키마를 가진 매니페스트 문서 자체의 상한이다.
//   ★ 저장소를 거쳐 재수출하지 마라 — 상수 두 개 때문에 `src/reaper.mjs` 가 저장소 전체를 끌고 왔던 자리다.
export const MAX_JSON_ARTIFACT_BYTES = 4_194_304;
export const MAX_RUN_MANIFEST_BYTES = 4_194_304;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GENERATION_PATTERN = /^[0-9a-f]{12}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ISSUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// ★ 목록의 길이 상한. 벤더 id **자체**의 규칙은 여기서 새로 짓지 않는다 — 이 매니페스트는
//   이미 그것을 `normalizeRoleBinding` 의 `providerId`(유계 128자)로 정해 두었고, 같은 문자열이
//   한 파일 안에서 두 규칙을 만나면 결속에서 적법한 id 가 사용량에서 실행 끝에 거절된다.
const MAX_USAGE_VENDORS = 8;
const USAGE_KEYS = Object.freeze(['calls', 'promptTokensKnown', 'evalTokensKnown', 'incomplete']);
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'generation', 'runId', 'candidateCount', 'baseline', 'frozenTestPlan', 'proofRequirement',
  'plannerBinding', 'laneBindings', 'deadlineAt', 'createdAt', 'expiresAt', 'revision', 'appliedEvents',
  'pendingArtifacts', 'committedArtifacts', 'attempts', 'evidenceRefs', 'candidateRefs', 'verdictRefs',
  'usage', 'issueSummary', 'selection', 'winnerAlias', 'cleanup',
]);

/** 공유 `boundedText` 의 boolean 어댑터 — 이 파일의 호출부 스물몇은 조건으로만 쓴다. */
function boundedString(value, max = 4_096, allowEmpty = false) {
  return boundedText(value, max, { allowEmpty }) !== null;
}

function validOrdinal(value) {
  return Number.isInteger(value) && value >= 1 && value <= 999;
}

function ordinal(value) {
  return String(value).padStart(3, '0');
}

function relativeJson(root, path) {
  if (!contained(root, path)) return null;
  return relative(root, path).split(sep).join('/');
}

function normalizeUsage(value) {
  const object = exactObject(value, USAGE_KEYS).value ?? null;
  if (object === null || !isSafeCount(object.calls) || !isSafeCount(object.promptTokensKnown) ||
      !isSafeCount(object.evalTokensKnown) || typeof object.incomplete !== 'boolean') return null;
  return {
    calls: object.calls,
    promptTokensKnown: object.promptTokensKnown,
    evalTokensKnown: object.evalTokensKnown,
    incomplete: object.incomplete,
  };
}

/**
 * 실행 **하나**의 총계 — 시도 단위의 `usage` 와 달리 벤더별 행을 함께 나른다(WS4b 태스크 5).
 * 봉투의 `cost.providers` 가 읽을 자리가 이것이다: 비용은 봉투에서 태어나지 않고 이 원장이
 * 적어 둔 것을 인용한다.
 *
 * ★ 행은 **정준 순서로 정렬된 유일한 id 의 배열**이다 — 매니페스트의 다른 목록들과 같은 문법
 *   (`candidateRefs`·`issueSummary`·`laneBindings`)이고, 사전 모양이 아닌 이유는 둘이다:
 *   동적 키는 `__proto__` 를 값으로 받고, `normalizeRunManifestV1` 의 `sameJson` 왕복이 키
 *   **순서**에 걸려 있어 사전에는 정준 순서를 강제할 자리가 없다.
 *
 * ★★ `vendors` 가 아예 없는 매니페스트도 읽는다 — 태스크 5 **이전**의 실행이 디스크에 적어
 *   둔 모양이 그것이다. 여기서 빈 배열을 「올려」 쓰면 그 실행의 매니페스트는 자기 바이트와
 *   달라져 `sameJson` 왕복에서 통째로 버려진다(옛 철자를 값이 아니라 검사로만 받는 규칙).
 */
function normalizeRunUsage(value) {
  const object = exactObject(value, [...USAGE_KEYS, 'vendors']).value ?? null;
  if (object === null) return normalizeUsage(value);
  const { vendors: rows, ...counts } = object;
  const totals = normalizeUsage(counts);
  const listed = exactDenseArray(rows, MAX_USAGE_VENDORS);
  if (totals === null || listed === null) return null;
  const vendors = [];
  for (const row of listed) {
    const entry = exactObject(row, ['vendor', ...USAGE_KEYS]).value ?? null;
    if (entry === null || !boundedString(entry.vendor, 128)) return null;
    const { vendor, ...tokens } = entry;
    const usage = normalizeUsage(tokens);
    // 중복과 뒤집힌 순서를 한 비교가 함께 막는다 — 정준 순서는 「정렬됐다」가 아니라 「엄격히 증가한다」다.
    if (usage === null || vendors.length > 0 && compareUtf8(vendors.at(-1).vendor, vendor) >= 0) return null;
    vendors.push({ vendor, ...usage });
  }
  return { ...totals, vendors };
}

function normalizeRoleBinding(value, requiredRole = null) {
  const object = exactObject(value, ['providerId', 'model', 'effort', 'tier', 'role']).value ?? null;
  if (object === null || !boundedString(object.providerId, 128) ||
      !(object.model === null || boundedString(object.model, 128)) ||
      !(object.effort === null || boundedString(object.effort, 64)) ||
      !['fast', 'strong'].includes(object.tier) ||
      !['planner', 'worker', 'verifier', 'thinker'].includes(object.role) ||
      requiredRole !== null && object.role !== requiredRole) return null;
  return {
    providerId: object.providerId,
    model: object.model,
    effort: object.effort,
    tier: object.tier,
    role: object.role,
  };
}

function normalizeLaneBinding(value) {
  const object = exactObject(value, ['writer', 'verifier']).value ?? null;
  const writer = normalizeRoleBinding(object?.writer, 'worker');
  const verifier = normalizeRoleBinding(object?.verifier, 'verifier');
  return object !== null && writer !== null && verifier !== null ? { writer, verifier } : null;
}

function normalizeInitialManifest(value, runId) {
  const object = exactObject(value, [
    'schemaVersion', 'runId', 'candidateCount', 'baseline', 'frozenTestPlan', 'proofRequirement',
    'plannerBinding', 'laneBindings', 'deadlineAt',
  ]).value ?? null;
  if (object === null || object.schemaVersion !== 1 || object.runId !== runId || ![1, 2].includes(object.candidateCount)) return null;
  const baseline = exactObject(object.baseline, ['commit', 'tree']).value ?? null;
  const plan = exactObject(object.frozenTestPlan, ['planFingerprint', 'environmentFingerprint']).value ?? null;
  const proof = exactObject(object.proofRequirement, ['required', 'reason']).value ?? null;
  const planner = normalizeRoleBinding(object.plannerBinding, 'planner');
  const laneEntries = exactDenseArray(object.laneBindings, 2);
  const reasons = ['explicit_bug_fix', 'explicit_non_bug', 'default_code_change', 'non_code_task'];
  if (baseline === null || !OBJECT_ID_PATTERN.test(baseline.commit) || !OBJECT_ID_PATTERN.test(baseline.tree) ||
      plan === null || !SHA256_PATTERN.test(plan.planFingerprint) || !SHA256_PATTERN.test(plan.environmentFingerprint) ||
      proof === null || typeof proof.required !== 'boolean' || !reasons.includes(proof.reason) || planner === null ||
      laneEntries === null || laneEntries.length !== object.candidateCount ||
      !(object.deadlineAt === null || isSafeCount(object.deadlineAt))) return null;
  const lanes = [];
  for (let index = 0; index < laneEntries.length; index += 1) {
    const entry = exactObject(laneEntries[index], ['laneId', 'binding']).value ?? null;
    const binding = normalizeLaneBinding(entry?.binding);
    if (entry === null || entry.laneId !== LANES[index] || binding === null) return null;
    lanes.push({ laneId: entry.laneId, binding });
  }
  return {
    schemaVersion: 1,
    runId,
    candidateCount: object.candidateCount,
    baseline: { commit: baseline.commit, tree: baseline.tree },
    frozenTestPlan: { planFingerprint: plan.planFingerprint, environmentFingerprint: plan.environmentFingerprint },
    proofRequirement: { required: proof.required, reason: proof.reason },
    plannerBinding: planner,
    laneBindings: lanes,
    deadlineAt: object.deadlineAt,
  };
}

/**
 * attempt 한 번이 끝난 이유의 닫힌 어휘. 앞의 넷은 reason code 가 아니라 레인 판정이고
 * (`decideAttempt` 의 action), 마지막 하나만 레지스트리 코드다.
 */
const ATTEMPT_RESULTS = Object.freeze(['accepted', 'repair', 'rejected', 'blocked', REASON.lane_stagnated]);

/**
 * 닫힌 reason 어휘의 **읽기** 판정 — 디스크에 남은 옛 철자를 별칭으로 올려 **검사만** 하고
 * 값 자체는 건드리지 않는다(WS2 §2.4, 불변식 9).
 *
 * ★ 값을 새 이름으로 고쳐 쓰지 않는 이유 둘. (a) `normalizeRunManifestV1` 은 마지막에
 *   `sameJson(value, normalized)` 로 왕복을 확인한다 — 한 필드만 올려 써도 매니페스트 전체가
 *   무효가 된다. (b) `appliedEvents[].eventSha256` 은 이 바이트 위에서 뜬 digest 다 — 올려 쓰면
 *   digest 가 어긋나고 `src/reaper.mjs` 는 그 실행을 `noncanonical_manifest` 로 버려
 *   **영원히 회수하지 못한다**. 그래서 읽기는 넓고 쓰기는 새 이름 하나다.
 * ★ reasonCode 자리의 값에만 쓴다 — `normalizeLegacyReasonCode` 의 JSDoc 규칙 그대로
 *   (`stopReason`·`status`·`confidence` 는 별칭 표의 키와 철자가 겹친다).
 */
function closedReasonValue(value, allowed) {
  if (allowed.includes(value)) return true;
  const upgraded = normalizeLegacyReasonCode(value);
  return upgraded !== null && allowed.includes(upgraded);
}

/**
 * artifact 의 닫힌 kind 어휘. 다섯째 `plan` 은 WS4a 태스크 9 가 더했다(스펙 §0-PL) — 플래너
 * 정본 `runs/<runId>/plan.json` 이다.
 *
 * ★★ **`plan` 은 레인이 없는 유일한 kind다.** 나머지 넷은 하나의 후보 레인에 속하지만 계획은
 *   실행 하나 전체의 산출물이고, 그래서 `candidateId` 가 `null` 이다. 레인 하나를 지어내
 *   적으면(예: 언제나 `lane-a`) 아래 `normalizeRunManifestV1` 의 「설정된 레인인가」 검사가 그
 *   거짓말 위에서 통과하고, 후보 하나짜리 실행의 계획이 그 레인의 산출물로 읽힌다.
 * ★★ **다섯째 kind 는 0.2.2 리더에게 비호환이다** — 그 릴리스의 `normalizeCommitted` 는 넷만
 *   알아서 매니페스트 전체를 null 로 접고, 그 릴리스의 리퍼는 그 실행을 `invalid_manifest` 로
 *   건너뛰고 **지우지 않는다**. 새 호환 기계는 만들지 않는다: 0.3.0 CHANGELOG 가 이미 같은
 *   경로를 공시했고(0.2.2 호스트는 새 실행을 `skipped` 로 본다) 0.4.0 이 그 위에 편승한다.
 */
const ARTIFACT_KINDS = Object.freeze(['attempt', 'evidence', 'candidate', 'winner', 'plan']);

function normalizeArtifactRef(value) {
  const object = exactObject(value, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']).value ?? null;
  if (object === null || !ARTIFACT_KINDS.includes(object.kind) ||
      !(object.kind === 'plan' ? object.candidateId === null : validLane(object.candidateId)) ||
      !boundedString(object.path, 32_768) || !isAbsolute(object.path) ||
      !SHA256_PATTERN.test(object.sha256) || !isSafeCount(object.bytes) || !isSafeCount(object.expiresAt)) return null;
  return {
    kind: object.kind,
    candidateId: object.candidateId,
    path: object.path,
    sha256: object.sha256,
    bytes: object.bytes,
    expiresAt: object.expiresAt,
  };
}

function normalizeManifestRef(value) {
  const object = exactObject(value, ['kind', 'path', 'revision', 'expiresAt']).value ?? null;
  if (object === null || object.kind !== 'manifest' || !boundedString(object.path, 32_768) || !isAbsolute(object.path) ||
      !isSafeCount(object.revision) || !isSafeCount(object.expiresAt)) return null;
  return { kind: 'manifest', path: object.path, revision: object.revision, expiresAt: object.expiresAt };
}

function artifactIdentity(value) {
  const kindDescriptor = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, 'artifactKind');
    } catch {
      return null;
    }
  })();
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) return null;
  const artifactKind = kindDescriptor.value;
  if (artifactKind === 'attempt') {
    const object = exactObject(value, ['artifactKind', 'laneId', 'attemptOrdinal']).value ?? null;
    return object !== null && validLane(object.laneId) && validOrdinal(object.attemptOrdinal)
      ? { artifactKind, laneId: object.laneId, attemptOrdinal: object.attemptOrdinal }
      : null;
  }
  if (artifactKind === 'evidence') {
    const object = exactObject(value, ['artifactKind', 'laneId', 'attemptOrdinal', 'evidenceOrdinal']).value ?? null;
    return object !== null && validLane(object.laneId) && validOrdinal(object.attemptOrdinal) && validOrdinal(object.evidenceOrdinal)
      ? { artifactKind, laneId: object.laneId, attemptOrdinal: object.attemptOrdinal, evidenceOrdinal: object.evidenceOrdinal }
      : null;
  }
  if (artifactKind === 'candidate') {
    const object = exactObject(value, ['artifactKind', 'laneId', 'sourceAttemptId']).value ?? null;
    return object !== null && validLane(object.laneId) && boundedString(object.sourceAttemptId, 256)
      ? { artifactKind, laneId: object.laneId, sourceAttemptId: object.sourceAttemptId }
      : null;
  }
  if (artifactKind === 'winner') {
    const object = exactObject(value, ['artifactKind', 'candidateId']).value ?? null;
    return object !== null && validLane(object.candidateId) ? { artifactKind, candidateId: object.candidateId } : null;
  }
  // ★ 실행마다 하나뿐이라 구별할 것이 없다 — 키는 `artifactKind` 하나이고, 그것이 `identityKey`
  //   가 `'plan'` 한 값인 이유다(레인도 서수도 이 신원의 일부가 아니다).
  if (artifactKind === 'plan') {
    return exactObject(value, ['artifactKind']).ok ? { artifactKind } : null;
  }
  return null;
}

/** 신원 하나가 매니페스트의 inventory 항목에서 갖는 키들 — kind 마다 정확히 이 집합이다. */
function inventoryIdentityKeys(kind) {
  return kind === 'attempt' ? ['artifactKind', 'laneId', 'attemptOrdinal']
    : kind === 'evidence' ? ['artifactKind', 'laneId', 'attemptOrdinal', 'evidenceOrdinal']
      : kind === 'candidate' ? ['artifactKind', 'laneId', 'sourceAttemptId']
        : kind === 'winner' ? ['artifactKind', 'candidateId']
          : kind === 'plan' ? ['artifactKind'] : null;
}

function identityFields(identity) {
  if (identity.artifactKind === 'attempt') {
    return { artifactKind: 'attempt', laneId: identity.laneId, attemptOrdinal: identity.attemptOrdinal };
  }
  if (identity.artifactKind === 'evidence') {
    return {
      artifactKind: 'evidence', laneId: identity.laneId,
      attemptOrdinal: identity.attemptOrdinal, evidenceOrdinal: identity.evidenceOrdinal,
    };
  }
  if (identity.artifactKind === 'candidate') {
    return { artifactKind: 'candidate', laneId: identity.laneId, sourceAttemptId: identity.sourceAttemptId };
  }
  if (identity.artifactKind === 'plan') return { artifactKind: 'plan' };
  return { artifactKind: 'winner', candidateId: identity.candidateId };
}

function identityKey(identity) {
  if (identity.artifactKind === 'attempt') return `attempt:${identity.laneId}:${ordinal(identity.attemptOrdinal)}`;
  if (identity.artifactKind === 'evidence') {
    return `evidence:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:${ordinal(identity.evidenceOrdinal)}`;
  }
  if (identity.artifactKind === 'candidate') return `candidate:${identity.laneId}`;
  if (identity.artifactKind === 'plan') return 'plan';
  return `winner:${identity.candidateId}`;
}

function artifactKindForIdentity(identity) {
  return identity.artifactKind;
}

/** ★ `plan` 은 실행 전체의 것이라 후보가 **없다**(`null`) — 위 `ARTIFACT_KINDS` 의 ★★ 를 보라. */
function candidateForIdentity(identity) {
  if (identity.artifactKind === 'plan') return null;
  return identity.artifactKind === 'winner' ? identity.candidateId : identity.laneId;
}

function normalizePending(value) {
  const kind = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, 'artifactKind')?.value;
    } catch {
      return null;
    }
  })();
  const identityKeys = inventoryIdentityKeys(kind);
  if (identityKeys === null) return null;
  const keys = [...identityKeys, 'relativePath', 'tempRelativePath', 'expectedSha256', 'expectedBytes', 'reservedEventId'];
  const object = exactObject(value, keys).value ?? null;
  if (object === null) return null;
  const identity = artifactIdentity(Object.fromEntries(identityKeys.map((key) => [key, object[key]])));
  if (identity === null || !boundedString(object.relativePath, 32_768) || !boundedString(object.tempRelativePath, 32_768) ||
      !SHA256_PATTERN.test(object.expectedSha256) || !isSafeCount(object.expectedBytes) ||
      !EVENT_ID_PATTERN.test(object.reservedEventId)) return null;
  return {
    ...identityFields(identity),
    relativePath: object.relativePath,
    tempRelativePath: object.tempRelativePath,
    expectedSha256: object.expectedSha256,
    expectedBytes: object.expectedBytes,
    reservedEventId: object.reservedEventId,
  };
}

function normalizeCommitted(value) {
  const kind = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, 'artifactKind')?.value;
    } catch {
      return null;
    }
  })();
  const identityKeys = inventoryIdentityKeys(kind);
  if (identityKeys === null) return null;
  const object = exactObject(value, [...identityKeys, 'relativePath', 'ref', 'committedEventId']).value ?? null;
  if (object === null) return null;
  const identity = artifactIdentity(Object.fromEntries(identityKeys.map((key) => [key, object[key]])));
  const ref = normalizeArtifactRef(object.ref);
  if (identity === null || ref === null || !boundedString(object.relativePath, 32_768) || !EVENT_ID_PATTERN.test(object.committedEventId) ||
      ref.kind !== artifactKindForIdentity(identity) || ref.candidateId !== candidateForIdentity(identity)) return null;
  return {
    ...identityFields(identity),
    relativePath: object.relativePath,
    ref,
    committedEventId: object.committedEventId,
  };
}

function normalizeStringArray(value, { max = 100, pattern = null, sort = true } = {}) {
  const array = exactDenseArray(value, max);
  if (array === null || array.some((item) => !boundedString(item, 256) || pattern !== null && !pattern.test(item)) ||
      new Set(array).size !== array.length) return null;
  const out = [...array];
  if (sort) out.sort(compareUtf8);
  return out;
}

function normalizeManifestAttempt(value) {
  const object = exactObject(value, ['laneId', 'ordinal', 'attemptId', 'retryOf', 'status', 'attemptRef', 'result']).value ?? null;
  const ref = object?.attemptRef === null ? null : normalizeArtifactRef(object?.attemptRef);
  if (object === null || !validLane(object.laneId) || !validOrdinal(object.ordinal) || !boundedString(object.attemptId, 256) ||
      !(object.retryOf === null || boundedString(object.retryOf, 256)) || !['allocated', 'terminal'].includes(object.status) ||
      ref === null && object.attemptRef !== null || ref !== null && (ref.kind !== 'attempt' || ref.candidateId !== object.laneId) ||
      !(object.result === null || closedReasonValue(object.result, ATTEMPT_RESULTS)) ||
      object.status === 'allocated' && (ref !== null || object.result !== null) || object.status === 'terminal' && (ref === null || object.result === null)) return null;
  return {
    laneId: object.laneId,
    ordinal: object.ordinal,
    attemptId: object.attemptId,
    retryOf: object.retryOf,
    status: object.status,
    attemptRef: ref,
    result: object.result,
  };
}

/**
 * attempt 하나의 `retryOf` 가 가져야 하는 값 — 서수 1 이면 `null`, 아니면 **이 실행의 앞 서수**를
 * 가리키는 이름이다. 순수하게 구문적이다: 그 앞 attempt 가 이 목록에 실려 있는지는 묻지 않는다.
 *
 * ★★ 이 규칙은 0.2.2 가 쓴 것과 **글자 하나까지 같다**(불변식 9 · 로드맵 §5.9). 매니페스트는 공유
 *   디스크 포맷이고, 0.2.2 호스트와 상태 루트를 나눠 쓰거나 다운그레이드가 있으면 그쪽
 *   `normalizeRunManifestV1` 이 이 파일을 계속 읽어야 한다. WS3 태스크 11 은 재개를 위해 이 규칙을
 *   「앞 attempt 가 **이 목록에** 있으면」으로 완화했는데, 그러면 서수 3 에서 시작한 레인의 첫
 *   attempt 가 `retryOf: null` 로 적히고 0.2.2 리더는 그 매니페스트를 통째로 거절한다 — 그 릴리스의
 *   리퍼는 `{ok:false, code:'invalid_manifest'}` 로 그 실행을 **건너뛰고 지우지 않으므로**, 재개된
 *   실행의 디렉터리와 attempts·candidates·evidence 가 30일 보존을 지나 영원히 남는다.
 *   `test/engine.test.mjs` 의 「0.2.2 리더가 그대로 읽는다」가 그 방향을 픽스처로 핀한다.
 * ★★ 재개된 레인의 첫 attempt 가 가리키는 이름은 **이 실행에 없는 서수**다. 그것이 이 규칙이 실제로
 *   말하는 것이다 — 「앞 서수의 자리」이지 「이 목록의 앞 항목」이 아니다. 그 자리의 작업은 원본
 *   실행에 있고, 원본을 이름으로 가리킬 수는 없다: 매니페스트의 키 집합은 정확히 25 개라 「어느
 *   실행에서 이어졌나」를 적을 자리가 없고(§0-D1), 0.2.2 규칙 자체가 `${이 실행}/…` 를 요구하므로
 *   원본 이름을 적으면 그쪽에서 또 거절당한다. 재개했다는 사실은 봉투의 알림과 저널·로그가 나른다.
 * ★ 이 규칙이 **더 들여보내는 것은 없다**: `attemptId` 는 여전히 `<이 실행>/<레인>/<서수>` 라서 남의
 *   실행의 attempt 는 이 목록에 못 들어오고, 사슬을 **이어 갈** 때는 여전히 서수 +1 이며 앞
 *   attempt 가 terminal 이어야 한다 — 그 판정은 매니페스트 셰이프가 아니라 저장소의 할당 가드가
 *   한다(`src/run-artifacts.mjs` 의 `applyEvent`: 레인에 attempt 가 아직 하나도 없으면 어느 서수로도
 *   시작할 수 있고, 그 뒤로는 앞 서수가 terminal 이어야 한다). 재개를 여는 것은 그 가드이지 이 함수가
 *   아니다.
 */
function expectedRetryOf(runId, laneId, attemptOrdinal) {
  return attemptOrdinal > 1 ? `${runId}/${laneId}/${ordinal(attemptOrdinal - 1)}` : null;
}

function normalizeManifestEvidenceRef(value) {
  const object = exactObject(value, ['laneId', 'attemptId', 'evidenceId', 'kind', 'repetition', 'ref']).value ?? null;
  const ref = normalizeArtifactRef(object?.ref);
  if (object === null || !validLane(object.laneId) || !boundedString(object.attemptId, 256) || !boundedString(object.evidenceId, 320) ||
      !['b0', 'br', 'c'].includes(object.kind) || ![1, 2].includes(object.repetition) || ref === null ||
      ref.kind !== 'evidence' || ref.candidateId !== object.laneId) return null;
  return {
    laneId: object.laneId,
    attemptId: object.attemptId,
    evidenceId: object.evidenceId,
    kind: object.kind,
    repetition: object.repetition,
    ref,
  };
}

function normalizeTests(value) {
  const object = exactObject(value, ['execution', 'outcome', 'stability', 'complete']).value ?? null;
  if (object === null || !['completed', 'not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(object.execution) ||
      !['pass', 'fail', 'unknown'].includes(object.outcome) || !['stable', 'flaky', 'unknown'].includes(object.stability) ||
      typeof object.complete !== 'boolean') return null;
  return {
    execution: object.execution,
    outcome: object.outcome,
    stability: object.stability,
    complete: object.complete,
  };
}

function normalizeScope(value) {
  const object = exactObject(value, ['flagged', 'reasonCount', 'omittedReasonCount']).value ?? null;
  return object !== null && typeof object.flagged === 'boolean' && isSafeCount(object.reasonCount) && isSafeCount(object.omittedReasonCount)
    ? { flagged: object.flagged, reasonCount: object.reasonCount, omittedReasonCount: object.omittedReasonCount }
    : null;
}

function normalizeCandidateRef(value) {
  const object = exactObject(value, [
    'candidateId', 'sourceAttemptId', 'terminalClass', 'treeHash', 'patchRef', 'proofStatus', 'tests', 'scope',
  ]).value ?? null;
  const patchRef = object?.patchRef === null ? null : normalizeArtifactRef(object?.patchRef);
  const tests = normalizeTests(object?.tests);
  const scope = normalizeScope(object?.scope);
  if (object === null || !validLane(object.candidateId) || !(object.sourceAttemptId === null || boundedString(object.sourceAttemptId, 256)) ||
      !['verified', 'usable_unverified', 'rejected', 'blocked'].includes(object.terminalClass) ||
      !(object.treeHash === null || OBJECT_ID_PATTERN.test(object.treeHash)) || patchRef === null && object.patchRef !== null ||
      patchRef !== null && (patchRef.kind !== 'candidate' || patchRef.candidateId !== object.candidateId) ||
      !['proved', 'not_applicable', 'not_proven', 'unavailable', 'flaky'].includes(object.proofStatus) || tests === null || scope === null) return null;
  if (object.terminalClass === 'blocked' && object.sourceAttemptId === null && (object.treeHash !== null || patchRef !== null)) return null;
  return {
    candidateId: object.candidateId,
    sourceAttemptId: object.sourceAttemptId,
    terminalClass: object.terminalClass,
    treeHash: object.treeHash,
    patchRef,
    proofStatus: object.proofStatus,
    tests,
    scope,
  };
}

function normalizeVerdictRef(value) {
  const object = exactObject(value, ['laneId', 'attemptId', 'verdict', 'issueIds']).value ?? null;
  const issueIds = normalizeStringArray(object?.issueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  return object !== null && validLane(object.laneId) && boundedString(object.attemptId, 256) &&
    ['PASS', 'FAIL'].includes(object.verdict) && issueIds !== null
    ? { laneId: object.laneId, attemptId: object.attemptId, verdict: object.verdict, issueIds }
    : null;
}

function normalizeIssueSummary(value) {
  const object = exactObject(value, ['candidateId', 'openIssueIds', 'openIssueCount', 'limitExceeded']).value ?? null;
  const ids = normalizeStringArray(object?.openIssueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  return object !== null && validLane(object.candidateId) && ids !== null && object.openIssueCount === ids.length &&
    typeof object.limitExceeded === 'boolean'
    ? { candidateId: object.candidateId, openIssueIds: ids, openIssueCount: ids.length, limitExceeded: object.limitExceeded }
    : null;
}

function normalizeCleanup(value) {
  const object = exactObject(value, ['kind', 'candidateId', 'attemptId', 'path', 'status', 'recoveryPath']).value ?? null;
  if (object === null || !['authoring', 'evidence', 'planner', 'judge'].includes(object.kind) ||
      !(object.candidateId === null || validLane(object.candidateId)) || !(object.attemptId === null || boundedString(object.attemptId, 256)) ||
      !boundedString(object.path, 32_768) || !isAbsolute(object.path) || !['removed', 'reaper_pending'].includes(object.status) ||
      !(object.recoveryPath === null || boundedString(object.recoveryPath, 32_768) && isAbsolute(object.recoveryPath))) return null;
  return {
    kind: object.kind,
    candidateId: object.candidateId,
    attemptId: object.attemptId,
    path: object.path,
    status: object.status,
    recoveryPath: object.recoveryPath,
  };
}

function normalizeArrayBy(values, normalizer, max = 10_000) {
  const array = exactDenseArray(values, max);
  if (array === null) return null;
  const out = array.map(normalizer);
  return out.some((value) => value === null) ? null : out;
}

function identityFromInventory(entry) {
  return artifactIdentity(identityFields(entry));
}

function compareAppliedEvents(a, b) {
  return compareUtf8(a.eventId, b.eventId);
}

const INVENTORY_KIND_RANK = new Map([
  ['attempt', 0], ['evidence', 1], ['candidate', 2], ['winner', 3], ['plan', 4],
]);

function inventoryOrderTuple(entry) {
  const identity = identityFromInventory(entry);
  // ★ `plan` 은 레인이 없어 첫 자리에서 갈린다 — 실행 하나에 한 항목뿐이라 그 뒤의 다섯 자리는
  //   비교에 쓰이지 않고, 마지막 자리는 그래도 자기 등급을 적는다(정렬이 자기 규칙을 말한다).
  if (identity.artifactKind === 'plan') {
    return [2, '', 0, 0, '', INVENTORY_KIND_RANK.get(identity.artifactKind)];
  }
  if (identity.artifactKind === 'winner') {
    return [1, identity.candidateId, 0, 0, '', INVENTORY_KIND_RANK.get(identity.artifactKind)];
  }
  if (identity.artifactKind === 'attempt') {
    return [0, identity.laneId, identity.attemptOrdinal, 0, '', INVENTORY_KIND_RANK.get(identity.artifactKind)];
  }
  if (identity.artifactKind === 'evidence') {
    return [
      0, identity.laneId, identity.attemptOrdinal, identity.evidenceOrdinal, '',
      INVENTORY_KIND_RANK.get(identity.artifactKind),
    ];
  }
  const sourceOrdinal = Number(/\/([0-9]{3})$/.exec(identity.sourceAttemptId)?.[1] ?? 1_000);
  return [
    0, identity.laneId, sourceOrdinal, 1_000, identity.sourceAttemptId,
    INVENTORY_KIND_RANK.get(identity.artifactKind),
  ];
}

function compareInventoryEntries(a, b) {
  const left = inventoryOrderTuple(a);
  const right = inventoryOrderTuple(b);
  return left[0] - right[0] || compareUtf8(left[1], right[1]) || left[2] - right[2] ||
    left[3] - right[3] || compareUtf8(left[4], right[4]) || left[5] - right[5];
}

function compareAttempts(a, b) {
  return compareUtf8(a.laneId, b.laneId) || a.ordinal - b.ordinal;
}

function compareEvidenceRefs(a, b) {
  return compareUtf8(a.laneId, b.laneId) || compareUtf8(a.attemptId, b.attemptId) ||
    compareUtf8(a.evidenceId, b.evidenceId);
}

function compareCandidateRefs(a, b) {
  return compareUtf8(a.candidateId, b.candidateId);
}

function compareVerdictRefs(a, b) {
  return compareUtf8(a.laneId, b.laneId) || compareUtf8(a.attemptId, b.attemptId);
}

function compareIssueSummaries(a, b) {
  return compareUtf8(a.candidateId, b.candidateId);
}

function compareCleanup(a, b) {
  return compareUtf8(cleanupKey(a), cleanupKey(b));
}

function canonicallyOrdered(values, compare) {
  return values.every((entry, index) => index === 0 || compare(values[index - 1], entry) < 0);
}

function manifestArraysCanonicallyOrdered(manifest) {
  return canonicallyOrdered(manifest.appliedEvents, compareAppliedEvents) &&
    canonicallyOrdered(manifest.pendingArtifacts, compareInventoryEntries) &&
    canonicallyOrdered(manifest.committedArtifacts, compareInventoryEntries) &&
    canonicallyOrdered(manifest.attempts, compareAttempts) &&
    canonicallyOrdered(manifest.evidenceRefs, compareEvidenceRefs) &&
    canonicallyOrdered(manifest.candidateRefs, compareCandidateRefs) &&
    canonicallyOrdered(manifest.verdictRefs, compareVerdictRefs) &&
    canonicallyOrdered(manifest.issueSummary, compareIssueSummaries) &&
    canonicallyOrdered(manifest.cleanup, compareCleanup);
}

function relativeMatchesIdentity(manifest, entry) {
  const identity = identityFromInventory(entry);
  if (identity === null) return false;
  const final = identity.artifactKind === 'attempt'
    ? `runs/${manifest.runId}/attempts/${identity.laneId}-${ordinal(identity.attemptOrdinal)}.json`
    : identity.artifactKind === 'evidence'
      ? `runs/${manifest.runId}/evidence/${identity.laneId}-${ordinal(identity.attemptOrdinal)}-${ordinal(identity.evidenceOrdinal)}.json`
      : identity.artifactKind === 'candidate'
        ? `runs/${manifest.runId}/candidates/${identity.laneId}.patch`
        : identity.artifactKind === 'plan'
          ? `runs/${manifest.runId}/plan.json`
          : `patches/${manifest.runId}.patch`;
  if (entry.relativePath !== final) return false;
  if (Object.hasOwn(entry, 'tempRelativePath')) {
    const prefix = `${final.slice(0, final.lastIndexOf('/') + 1)}.tmp-${final.slice(final.lastIndexOf('/') + 1)}-`;
    if (!entry.tempRelativePath.startsWith(prefix) || !/^\d+-[0-9a-f]{12}$/.test(entry.tempRelativePath.slice(prefix.length))) return false;
  }
  return true;
}

function refSuffixMatches(manifest, entry) {
  const suffix = entry.relativePath.split('/').join(sep);
  return entry.ref.path.endsWith(suffix) && entry.ref.expiresAt === manifest.expiresAt;
}

function commonLogicalStateRoot(current, candidate) {
  if (candidate === null) return null;
  return current === undefined || samePath(current, candidate) ? candidate : null;
}

function cleanupLogicalStateRoot(cleanup) {
  if (cleanup.path !== resolve(cleanup.path) ||
      (cleanup.status === 'removed' ? cleanup.recoveryPath !== null : cleanup.recoveryPath !== cleanup.path)) return null;
  const expectedSegment = cleanup.kind === 'planner' ? 'plans' : 'worktrees';
  const controllerDir = dirname(resolve(cleanup.path));
  return basename(controllerDir) === expectedSegment && basename(resolve(cleanup.path)) !== ''
    ? dirname(controllerDir)
    : null;
}

function logicalStateRootFromManifest(manifest) {
  let stateRoot = null;
  for (const entry of manifest.committedArtifacts) {
    const parts = entry.relativePath.split('/');
    if (entry.ref.path !== resolve(entry.ref.path)) return { ok: false, stateRoot: null };
    let candidate = resolve(entry.ref.path);
    for (let index = 0; index < parts.length; index += 1) candidate = dirname(candidate);
    if (join(candidate, ...parts) !== entry.ref.path ||
        relativeJson(candidate, resolve(entry.ref.path)) !== entry.relativePath) return { ok: false, stateRoot: null };
    const common = commonLogicalStateRoot(stateRoot ?? undefined, candidate);
    if (common === null) return { ok: false, stateRoot: null };
    stateRoot = common;
  }
  for (const cleanup of manifest.cleanup) {
    const candidate = cleanupLogicalStateRoot(cleanup);
    const common = commonLogicalStateRoot(stateRoot ?? undefined, candidate);
    if (common === null) return { ok: false, stateRoot: null };
    stateRoot = common;
  }
  return { ok: true, stateRoot };
}

function validateManifestEventRelationships(manifest) {
  const rootAuthority = logicalStateRootFromManifest(manifest);
  if (!rootAuthority.ok) return false;
  const stateRoot = rootAuthority.stateRoot;
  const events = new Map(manifest.appliedEvents.map((entry) => [entry.eventId, entry]));
  const used = new Set();
  const consumeId = (eventId, event = null) => {
    const applied = events.get(eventId);
    if (applied === undefined || used.has(eventId) || event !== null && !eventDigestMatches(applied.eventSha256, event, stateRoot)) return false;
    used.add(eventId);
    return true;
  };
  const consumeMatching = (build) => {
    const matches = manifest.appliedEvents.filter((entry) => !used.has(entry.eventId) &&
      eventDigestMatches(entry.eventSha256, build(entry.eventId), stateRoot));
    return matches.length === 1 && consumeId(matches[0].eventId);
  };
  for (const attempt of manifest.attempts) {
    if (!consumeMatching((eventId) => ({
      eventId,
      type: 'attempt_allocated',
      laneId: attempt.laneId,
      ordinal: attempt.ordinal,
      attemptId: attempt.attemptId,
      retryOf: attempt.retryOf,
    }))) return false;
    if (attempt.status === 'terminal') {
      const verdict = manifest.verdictRefs.find((entry) =>
        entry.laneId === attempt.laneId && entry.attemptId === attempt.attemptId);
      const eventId = `attempt:${attempt.laneId}:${ordinal(attempt.ordinal)}:terminal`;
      if (!consumeId(eventId, {
        eventId,
        type: 'attempt_terminal',
        laneId: attempt.laneId,
        ordinal: attempt.ordinal,
        attemptId: attempt.attemptId,
        attemptRef: attempt.attemptRef,
        result: attempt.result,
        verdictRef: verdict === undefined ? null : { verdict: verdict.verdict, issueIds: verdict.issueIds },
      })) return false;
    }
  }
  for (const pending of manifest.pendingArtifacts) {
    const identity = identityFromInventory(pending);
    if (!consumeId(pending.reservedEventId, {
      eventId: pending.reservedEventId,
      type: 'artifact_reserved',
      ...identityFields(identity),
      relativePath: pending.relativePath,
      tempRelativePath: pending.tempRelativePath,
      expectedSha256: pending.expectedSha256,
      expectedBytes: pending.expectedBytes,
    })) return false;
  }
  for (const committed of manifest.committedArtifacts) {
    const identity = identityFromInventory(committed);
    const reservedEventId = expectedArtifactEventId(identity, 'reserved');
    if (!consumeId(reservedEventId) || !consumeId(committed.committedEventId, {
      eventId: committed.committedEventId,
      type: 'artifact_committed',
      ...identityFields(identity),
      relativePath: committed.relativePath,
      ref: committed.ref,
    })) return false;
  }
  for (const candidate of manifest.candidateRefs) {
    if (!consumeMatching((eventId) => ({ eventId, type: 'candidate_recorded', value: candidate }))) return false;
  }
  for (const summary of manifest.issueSummary) {
    if (!consumeMatching((eventId) => ({ eventId, type: 'issues_recorded', value: summary }))) return false;
  }
  if (manifest.usage !== null && !consumeMatching((eventId) => ({
    eventId, type: 'usage_recorded', value: manifest.usage,
  }))) return false;
  if (manifest.selection !== null && !consumeMatching((eventId) => ({
    eventId, type: 'selection_recorded', value: manifest.selection,
  }))) return false;
  if (manifest.winnerAlias !== null) {
    const eventId = `winner:${manifest.winnerAlias.candidateId}:recorded`;
    if (!consumeId(eventId, {
      eventId, type: 'winner_alias_recorded', candidateId: manifest.winnerAlias.candidateId, value: manifest.winnerAlias,
    })) return false;
  }
  for (const cleanup of manifest.cleanup) {
    if (!consumeMatching((eventId) => ({ eventId, type: 'cleanup_recorded', value: cleanup }))) return false;
  }
  return used.size === manifest.appliedEvents.length;
}

export function normalizeRunManifestV1(value) {
  const object = exactObject(value, MANIFEST_KEYS).value ?? null;
  if (object === null || object.schemaVersion !== 1 || !GENERATION_PATTERN.test(object.generation) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(object.runId) || ![1, 2].includes(object.candidateCount) ||
      !isSafeCount(object.createdAt) || object.expiresAt !== object.createdAt + RUN_ARTIFACT_RETENTION_MS ||
      !isSafeCount(object.revision) || !(object.deadlineAt === null || isSafeCount(object.deadlineAt))) return null;
  const initial = normalizeInitialManifest({
    schemaVersion: 1,
    runId: object.runId,
    candidateCount: object.candidateCount,
    baseline: object.baseline,
    frozenTestPlan: object.frozenTestPlan,
    proofRequirement: object.proofRequirement,
    plannerBinding: object.plannerBinding,
    laneBindings: object.laneBindings,
    deadlineAt: object.deadlineAt,
  }, object.runId);
  if (initial === null) return null;
  const appliedRaw = exactDenseArray(object.appliedEvents, 100_000);
  const appliedEvents = appliedRaw?.map((entry) => {
    const item = exactObject(entry, ['eventId', 'eventSha256']).value ?? null;
    return item !== null && EVENT_ID_PATTERN.test(item.eventId) && SHA256_PATTERN.test(item.eventSha256)
      ? { eventId: item.eventId, eventSha256: item.eventSha256 }
      : null;
  }) ?? null;
  const pendingArtifacts = normalizeArrayBy(object.pendingArtifacts, normalizePending);
  const committedArtifacts = normalizeArrayBy(object.committedArtifacts, normalizeCommitted);
  const attempts = normalizeArrayBy(object.attempts, normalizeManifestAttempt, 1_998);
  const evidenceRefs = normalizeArrayBy(object.evidenceRefs, normalizeManifestEvidenceRef, 11_988);
  const candidateRefs = normalizeArrayBy(object.candidateRefs, normalizeCandidateRef, 2);
  const verdictRefs = normalizeArrayBy(object.verdictRefs, normalizeVerdictRef, 1_998);
  const usage = object.usage === null ? null : normalizeRunUsage(object.usage);
  const issueSummary = normalizeArrayBy(object.issueSummary, normalizeIssueSummary, 2);
  const selection = object.selection === null ? null : normalizeSelection(object.selection);
  const winnerAlias = object.winnerAlias === null ? null : normalizeArtifactRef(object.winnerAlias);
  const cleanup = normalizeArrayBy(object.cleanup, normalizeCleanup, 10_000);
  if (appliedEvents === null || appliedEvents.some((entry) => entry === null) || pendingArtifacts === null ||
      committedArtifacts === null || attempts === null || evidenceRefs === null || candidateRefs === null ||
      verdictRefs === null || usage === null && object.usage !== null || issueSummary === null ||
      selection === null && object.selection !== null || winnerAlias === null && object.winnerAlias !== null || cleanup === null) return null;
  if (object.revision !== appliedEvents.length || new Set(appliedEvents.map((entry) => entry.eventId)).size !== appliedEvents.length ||
      !manifestArraysCanonicallyOrdered({
        appliedEvents, pendingArtifacts, committedArtifacts, attempts, evidenceRefs, candidateRefs, verdictRefs,
        issueSummary, cleanup,
      })) return null;
  const configured = new Set(LANES.slice(0, object.candidateCount));
  const inventories = [...pendingArtifacts, ...committedArtifacts];
  const identityKeys = inventories.map((entry) => identityKey(identityFromInventory(entry)));
  if (new Set(identityKeys).size !== identityKeys.length || new Set(inventories.map((entry) => entry.relativePath)).size !== inventories.length ||
      // ★ `plan` 만 이 검사를 지나지 않는다 — 후보가 `null` 이라 어느 레인 집합에도 들지 않는다.
      //   나머지 넷은 여전히 **이 실행이 설정한** 레인의 것이어야 한다.
      inventories.some((entry) => !relativeMatchesIdentity({ runId: object.runId }, entry) ||
        (entry.artifactKind !== 'plan' && !configured.has(candidateForIdentity(identityFromInventory(entry))))) ||
      committedArtifacts.some((entry) => !refSuffixMatches({ runId: object.runId, expiresAt: object.expiresAt }, entry))) return null;
  const appliedIds = new Set(appliedEvents.map((entry) => entry.eventId));
  if (pendingArtifacts.some((entry) => {
    const identity = identityFromInventory(entry);
    return entry.reservedEventId !== expectedArtifactEventId(identity, 'reserved') || !appliedIds.has(entry.reservedEventId);
  }) || committedArtifacts.some((entry) => {
    const identity = identityFromInventory(entry);
    return entry.committedEventId !== expectedArtifactEventId(identity, 'committed') ||
      !appliedIds.has(entry.committedEventId) || !appliedIds.has(expectedArtifactEventId(identity, 'reserved'));
  })) return null;
  if (attempts.some((entry) => !configured.has(entry.laneId) || entry.attemptId !== `${object.runId}/${entry.laneId}/${ordinal(entry.ordinal)}` ||
      entry.retryOf !== expectedRetryOf(object.runId, entry.laneId, entry.ordinal)) ||
      new Set(attempts.map((entry) => `${entry.laneId}:${entry.ordinal}`)).size !== attempts.length) return null;
  if (evidenceRefs.some((entry) => !configured.has(entry.laneId) ||
      entry.evidenceId !== `${entry.attemptId}/${entry.kind.toUpperCase()}/${entry.repetition}`) ||
      new Set(evidenceRefs.map((entry) => entry.evidenceId)).size !== evidenceRefs.length) return null;
  if (candidateRefs.some((entry) => !configured.has(entry.candidateId)) ||
      new Set(candidateRefs.map((entry) => entry.candidateId)).size !== candidateRefs.length ||
      issueSummary.some((entry) => !configured.has(entry.candidateId)) ||
      new Set(issueSummary.map((entry) => entry.candidateId)).size !== issueSummary.length) return null;
  if (new Set(verdictRefs.map((entry) => `${entry.laneId}:${entry.attemptId}`)).size !== verdictRefs.length ||
      new Set(cleanup.map(cleanupKey)).size !== cleanup.length) return null;
  if (selection !== null && candidateRefs.length !== object.candidateCount ||
      winnerAlias !== null && (winnerAlias.kind !== 'winner' || selection === null ||
        selection.selectedCandidateId !== winnerAlias.candidateId)) return null;
  if (selection !== null && !selectionConsistent(selection, candidateRefs, issueSummary, object.candidateCount)) return null;
  const committedFor = (kind, predicate) => committedArtifacts.find((entry) => entry.artifactKind === kind && predicate(entry));
  if (attempts.some((entry) => entry.status === 'terminal' && (() => {
    const committed = committedFor('attempt', (item) => item.laneId === entry.laneId && item.attemptOrdinal === entry.ordinal);
    return committed === undefined || !sameJson(committed.ref, entry.attemptRef) ||
      !appliedIds.has(`attempt:${entry.laneId}:${ordinal(entry.ordinal)}:terminal`);
  })())) return null;
  if (evidenceRefs.some((entry) => !committedArtifacts.some((item) =>
    item.artifactKind === 'evidence' && sameJson(item.ref, entry.ref))) ||
      committedArtifacts.filter((entry) => entry.artifactKind === 'evidence').some((entry) =>
        !evidenceRefs.some((item) => sameJson(item.ref, entry.ref)))) return null;
  if (candidateRefs.some((entry) => entry.patchRef !== null && (() => {
    const committed = committedFor('candidate', (item) => item.laneId === entry.candidateId &&
      item.sourceAttemptId === entry.sourceAttemptId);
    return committed === undefined || !sameJson(committed.ref, entry.patchRef);
  })())) return null;
  if (candidateRefs.some((entry) => entry.sourceAttemptId === null
    ? entry.terminalClass !== 'blocked' || entry.treeHash !== null || entry.patchRef !== null
    : !attempts.some((attempt) => attempt.laneId === entry.candidateId &&
      attempt.attemptId === entry.sourceAttemptId && attempt.status === 'terminal'))) return null;
  if (selection !== null && selection.selectedCandidateId !== null && !candidateRefs.some((entry) =>
    entry.candidateId === selection.selectedCandidateId && entry.patchRef !== null)) return null;
  if (verdictRefs.some((entry) => !attempts.some((attempt) => attempt.laneId === entry.laneId &&
      attempt.attemptId === entry.attemptId && attempt.status === 'terminal')) ||
      winnerAlias !== null && (() => {
        const committed = committedFor('winner', (entry) => entry.candidateId === winnerAlias.candidateId);
        const candidate = candidateRefs.find((entry) => entry.candidateId === winnerAlias.candidateId);
        return committed === undefined || !sameJson(committed.ref, winnerAlias) || candidate === undefined || candidate.patchRef === null ||
          candidate.patchRef.sha256 !== winnerAlias.sha256 || candidate.patchRef.bytes !== winnerAlias.bytes ||
          !appliedIds.has(`winner:${winnerAlias.candidateId}:recorded`);
      })()) return null;
  const transitionUnits = attempts.length + attempts.filter((entry) => entry.status === 'terminal').length +
    pendingArtifacts.length + committedArtifacts.length * 2 + candidateRefs.length + issueSummary.length +
    (usage === null ? 0 : 1) + (selection === null ? 0 : 1) + (winnerAlias === null ? 0 : 1) + cleanup.length;
  if (transitionUnits !== object.revision || !validateManifestEventRelationships({
    appliedEvents, pendingArtifacts, committedArtifacts, attempts, candidateRefs, verdictRefs,
    usage, issueSummary, selection, winnerAlias, cleanup,
  })) return null;
  const normalized = {
    schemaVersion: 1,
    generation: object.generation,
    runId: object.runId,
    candidateCount: object.candidateCount,
    baseline: initial.baseline,
    frozenTestPlan: initial.frozenTestPlan,
    proofRequirement: initial.proofRequirement,
    plannerBinding: initial.plannerBinding,
    laneBindings: initial.laneBindings,
    deadlineAt: initial.deadlineAt,
    createdAt: object.createdAt,
    expiresAt: object.expiresAt,
    revision: object.revision,
    appliedEvents,
    pendingArtifacts,
    committedArtifacts,
    attempts,
    evidenceRefs,
    candidateRefs,
    verdictRefs,
    usage,
    issueSummary,
    selection,
    winnerAlias,
    cleanup,
  };
  if (!sameJson(value, normalized)) return null;
  return deepFreeze(normalized);
}

function expectedArtifactEventId(identity, phase) {
  if (identity.artifactKind === 'attempt') {
    return `artifact:attempt:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:${phase}`;
  }
  if (identity.artifactKind === 'evidence') {
    return `artifact:evidence:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:${ordinal(identity.evidenceOrdinal)}:${phase}`;
  }
  if (identity.artifactKind === 'candidate') return `artifact:candidate:${identity.laneId}:${phase}`;
  // ★ 실행 하나에 한 쌍뿐이라 이름에 구별자가 없다 — 두 번째 plan 예약은 같은 eventId 를 요구하고
  //   `appliedEvents` 의 유일성 검사가 그것을 거절한다(같은 계획을 두 번 적을 자리가 없다).
  if (identity.artifactKind === 'plan') return `artifact:plan:${phase}`;
  return `artifact:winner:${identity.candidateId}:${phase}`;
}

function logicalControllerPath(value, stateRoot) {
  if (typeof value !== 'string' || stateRoot === null || !isAbsolute(value)) return null;
  const relativePath = relativeJson(stateRoot, resolve(value));
  if (relativePath === null || !['runs', 'patches', 'worktrees', 'plans'].includes(relativePath.split('/')[0]) ||
      hasForbiddenText(relativePath)) return null;
  return `<STATE_ROOT>/${relativePath}`;
}

function logicalEventValue(value, stateRoot, key = null) {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => logicalEventValue(entry, stateRoot));
    return entries.some((entry) => entry === undefined) ? undefined : entries;
  }
  if (value === null || typeof value !== 'object') {
    if ((key === 'path' || key === 'recoveryPath') && value !== null) {
      return logicalControllerPath(value, stateRoot) ?? undefined;
    }
    return value;
  }
  const entries = Object.entries(value).map(([name, entry]) => [name, logicalEventValue(entry, stateRoot, name)]);
  return entries.some(([, entry]) => entry === undefined) ? undefined : Object.fromEntries(entries);
}

function eventDigest(event, stateRoot = null) {
  const logical = logicalEventValue(event, stateRoot);
  return logical === undefined ? null : sha256(Buffer.from(JSON.stringify(logical), 'utf8'));
}

function eventDigestMatches(actual, event, stateRoot) {
  const logical = eventDigest(event, stateRoot);
  if (logical === actual) return true;
  return sha256(Buffer.from(JSON.stringify(event), 'utf8')) === actual;
}

function cleanupKey(value) {
  return `${value.kind}\0${value.candidateId ?? ''}\0${value.attemptId ?? ''}\0${value.path}`;
}

/** 저장소 쪽(`src/run-artifacts.mjs`)이 부르는 이름 — 옮긴 줄을 건드리지 않으려고 목록으로 낸다. */
export {
  artifactIdentity, artifactKindForIdentity, ATTEMPT_RESULTS, boundedString, candidateForIdentity, cleanupKey,
  closedReasonValue, compareAppliedEvents, compareAttempts, compareCandidateRefs, compareCleanup,
  compareEvidenceRefs, compareInventoryEntries, compareIssueSummaries, compareVerdictRefs,
  EVENT_ID_PATTERN, eventDigest, eventDigestMatches, expectedArtifactEventId, expectedRetryOf, GENERATION_PATTERN, identityFields,
  identityFromInventory, identityKey, inventoryIdentityKeys, ISSUE_ID_PATTERN, logicalEventValue, MANIFEST_KEYS, normalizeArtifactRef,
  normalizeCandidateRef, normalizeCleanup, normalizeInitialManifest, normalizeIssueSummary,
  normalizeLaneBinding, normalizeManifestRef,
  normalizeRunUsage, normalizeStringArray, normalizeUsage, OBJECT_ID_PATTERN, ordinal, relativeJson, SHA256_PATTERN,
  validOrdinal,
};
