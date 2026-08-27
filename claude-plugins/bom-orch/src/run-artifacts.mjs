import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';

import { validateArtifactPathBudget } from './content-projection.mjs';
import { LANES, sameJson, validLane } from './manifest-vocabulary.mjs';
import { completeIssueSummary, normalizeSelection } from './manifest-selection.mjs';
import { validateRunManifestTransitionV1 } from './manifest-transition.mjs';
import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import {
  artifactIdentity, artifactKindForIdentity, ATTEMPT_RESULTS, boundedString, candidateForIdentity, cleanupKey,
  closedReasonValue, compareAppliedEvents, compareAttempts, compareCandidateRefs, compareCleanup,
  compareEvidenceRefs, compareInventoryEntries, compareIssueSummaries, compareVerdictRefs,
  EVENT_ID_PATTERN, eventDigest, eventDigestMatches, expectedArtifactEventId, expectedRetryOf, GENERATION_PATTERN,
  identityFields, identityFromInventory, identityKey, inventoryIdentityKeys, logicalEventValue, MAX_JSON_ARTIFACT_BYTES,
  MAX_RUN_MANIFEST_BYTES, normalizeArtifactRef, normalizeCandidateRef, normalizeCleanup,
  normalizeInitialManifest, normalizeIssueSummary, normalizeRunManifestV1, normalizeRunUsage, ordinal,
  relativeJson, RUN_ARTIFACT_RETENTION_MS, SHA256_PATTERN, validOrdinal,
} from './run-manifest.mjs';
import {
  normalizeAttemptRecord, normalizeEvidenceRecord, normalizePlanRecord, normalizeVerdictValue,
  readJsonRecord, verifyImmutableRef, verifySealedEvidenceAuthority,
} from './run-records.mjs';
import {
  canonicalRoot, captureDeps, cloneExactData, collisionForPaths, jsonBytes, lstatAbsent, readonlyDeps,
  secureAndVerify, syncDirectory, verifyPhysicalPath, verifyStorePath,
} from './run-store-fs.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { samePath } from './util/paths.mjs';
import { cloneData, exactObject } from './util/objects.mjs';
import { isSafeCount } from './util/strings.mjs';

/** 매니페스트 문서의 공개 이름은 이 파일에서 계속 나간다 — 테스트가 여기서 가져간다(`src/reaper.mjs` 는 문서에서 직접 가져간다). */
export { RUN_ARTIFACT_RETENTION_MS, normalizeRunManifestV1, validateRunManifestTransitionV1 };

const STORE_STATES = new WeakMap();

/**
 * Proves that a public store handle is backed by this module's private revision authority.
 * The predicate is intentionally total: hostile handles/authority objects fail closed.
 */
export function isRunArtifactStore(store, authority = {}) {
  try {
    const expected = exactObject(authority, ['stateRoot', 'runId', 'candidateCount']).value ?? null;
    if (expected === null) return false;
    const state = STORE_STATES.get(store);
    return state !== undefined && state.store === store &&
      state.stateRoot === expected.stateRoot && state.runId === expected.runId &&
      state.candidateCount === expected.candidateCount;
  } catch {
    return false;
  }
}

export function getRunArtifactStoreAuthority(store, authority = {}) {
  try {
    const expected = exactObject(authority, ['stateRoot', 'runId', 'candidateCount']).value ?? null;
    if (expected === null) return null;
    const state = STORE_STATES.get(store);
    if (state === undefined || state.store !== store ||
        state.stateRoot !== expected.stateRoot || state.runId !== expected.runId ||
        state.candidateCount !== expected.candidateCount) return null;
    return deepFreeze({ manifestRef: manifestRef(state, 0) });
  } catch {
    return null;
  }
}

export async function inspectRunArtifactCollision(input, dependencyInput = {}) {
  const object = exactObject(input, ['stateRoot', 'runId']).value ?? null;
  const deps = readonlyDeps(dependencyInput);
  if (object === null || deps === null) return fail(REASON.artifact_collision_input_invalid);
  const budget = validateArtifactPathBudget({ stateRoot: object.stateRoot, runId: object.runId, candidateCount: 1 });
  if (budget.blocked) return budget;
  if (await canonicalRoot(object.stateRoot, deps) === null) return fail(REASON.artifact_root_not_canonical, { path: object.stateRoot });
  return collisionForPaths(budget.paths, deps);
}

function initialManifestValue(initial, generation, createdAt, expiresAt) {
  return {
    schemaVersion: 1,
    generation,
    runId: initial.runId,
    candidateCount: initial.candidateCount,
    baseline: cloneData(initial.baseline),
    frozenTestPlan: cloneData(initial.frozenTestPlan),
    proofRequirement: cloneData(initial.proofRequirement),
    plannerBinding: cloneData(initial.plannerBinding),
    laneBindings: cloneData(initial.laneBindings),
    deadlineAt: initial.deadlineAt,
    createdAt,
    expiresAt,
    revision: 0,
    appliedEvents: [],
    pendingArtifacts: [],
    committedArtifacts: [],
    attempts: [],
    evidenceRefs: [],
    candidateRefs: [],
    verdictRefs: [],
    usage: null,
    issueSummary: [],
    selection: null,
    winnerAlias: null,
    cleanup: [],
  };
}

async function ensureBaseDirectory(path, deps) {
  let created = false;
  try {
    await deps.mkdir(path, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }
  return secureAndVerify(path, 'directory', created ? 'created' : 'published', deps);
}

async function openOwnedEmptyFile(path, deps, onCreated = null) {
  let handle;
  try {
    handle = await deps.open(path, 'wx', 0o600);
    const identity = await handle.stat();
    onCreated?.(identity);
    if (!await secureAndVerify(path, 'file', 'created', deps)) {
      await handle.close().catch(() => {});
      return null;
    }
    return { handle, identity };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function writeSyncClose(owned, bytes) {
  try {
    await owned.handle.writeFile(bytes);
    await owned.handle.sync();
    await owned.handle.close();
    return true;
  } catch {
    await owned.handle.close().catch(() => {});
    return false;
  }
}

function sameIdentity(a, b) {
  if (a === null || b === null) return false;
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  return a.size === b.size && a.birthtimeMs === b.birthtimeMs;
}

async function verifyOwnedBytes(path, bytes, deps) {
  try {
    if (!await verifyPhysicalPath(path, 'file', deps)) return false;
    const info = await deps.lstat(path);
    if (info.size !== bytes.length) return false;
    const actual = await deps.readFile(path);
    return Buffer.isBuffer(actual) && actual.equals(bytes);
  } catch {
    return false;
  }
}

async function publishNewFile(tempPath, finalPath, bytes, deps) {
  let published;
  try {
    published = await deps.publishFileNoReplace(tempPath, finalPath);
  } catch {
    return false;
  }
  if (published?.ok !== true || !await secureAndVerify(finalPath, 'file', 'published', deps) ||
      !await verifyOwnedBytes(finalPath, bytes, deps)) return false;
  try {
    await deps.unlink(tempPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  return syncDirectory(dirname(finalPath), deps);
}

async function createSecureDirectory(path, deps) {
  let created = false;
  try {
    await deps.mkdir(path, { recursive: false, mode: 0o700 });
    created = true;
    const identity = await deps.lstat(path);
    if (identity.isSymbolicLink() || !identity.isDirectory() ||
        !await secureAndVerify(path, 'directory', 'created', deps)) return { created, identity, ok: false };
    const verifiedIdentity = await deps.lstat(path);
    return { created, identity, ok: sameIdentity(identity, verifiedIdentity) };
  } catch {
    return { created, identity: null, ok: false };
  }
}

async function runBarrier(context, point) {
  if (context.deps.crashBarrier === null) return;
  try {
    await context.deps.crashBarrier(point);
  } catch {
    context.crashed = true;
    throw new Error('simulated_artifact_crash');
  }
}

async function lockStillOwned(context) {
  try {
    const bytes = await context.deps.readFile(context.paths.initLockPath);
    const info = await context.deps.lstat(context.paths.initLockPath);
    return Buffer.isBuffer(bytes) && bytes.equals(context.lockBytes) && sameIdentity(info, context.lockIdentity) &&
      await verifyPhysicalPath(context.paths.initLockPath, 'file', context.deps);
  } catch {
    return false;
  }
}

async function validateCompleteInitialTree(context) {
  try {
    const runIdentity = await context.deps.lstat(context.paths.runDir);
    if (!sameIdentity(runIdentity, context.finalIdentity)) return false;
    const top = (await context.deps.readdir(context.paths.runDir)).sort();
    if (JSON.stringify(top) !== JSON.stringify(['attempts', 'candidates', 'evidence', 'manifest.json'])) return false;
    for (const name of ['attempts', 'candidates', 'evidence']) {
      const path = join(context.paths.runDir, name);
      const identity = await context.deps.lstat(path);
      if (!sameIdentity(identity, context.ownedDirectories.get(path)) ||
          !await verifyPhysicalPath(path, 'directory', context.deps) || (await context.deps.readdir(path)).length !== 0) return false;
    }
    return await verifyOwnedBytes(context.paths.manifestPath, context.manifestBytes, context.deps);
  } catch {
    return false;
  }
}

export async function createRunArtifacts(input, dependencyInput = {}) {
  const object = exactObject(input, ['stateRoot', 'runId', 'initialManifest']).value ?? null;
  const deps = captureDeps(dependencyInput);
  if (object === null || deps === null) return fail(REASON.artifact_store_input_invalid);
  const initial = normalizeInitialManifest(object.initialManifest, object.runId);
  if (initial === null) return fail(REASON.artifact_initial_manifest_invalid);
  const budget = validateArtifactPathBudget({ stateRoot: object.stateRoot, runId: object.runId, candidateCount: initial.candidateCount });
  if (budget.blocked) return budget;
  if (await canonicalRoot(object.stateRoot, deps) === null) return fail(REASON.artifact_root_not_canonical, { path: object.stateRoot });
  const collision = await collisionForPaths(budget.paths, deps);
  if (collision.blocked) return collision;
  if (collision.collision) return fail(REASON.artifact_namespace_collision, { runId: object.runId });

  let generation;
  let createdAt;
  try {
    generation = deps.randomHex12();
    createdAt = deps.nowMs();
  } catch {
    return fail(REASON.artifact_initialization_dependency_failed);
  }
  if (!GENERATION_PATTERN.test(generation) || !isSafeCount(createdAt) ||
      !isSafeCount(createdAt + RUN_ARTIFACT_RETENTION_MS) || !isSafeCount(deps.pid)) {
    return fail(REASON.artifact_initialization_dependency_failed);
  }
  const expiresAt = createdAt + RUN_ARTIFACT_RETENTION_MS;
  const lockValue = {
    schemaVersion: 1,
    kind: 'run-artifact-init-lock',
    runId: object.runId,
    generation,
    pid: deps.pid,
    finalBasename: object.runId,
    createdAt,
    expiresAt,
  };
  const lockBytes = jsonBytes(lockValue);
  const manifest = initialManifestValue(initial, generation, createdAt, expiresAt);
  const manifestBytes = jsonBytes(manifest);
  if (lockBytes === null || manifestBytes === null || manifestBytes.length > MAX_RUN_MANIFEST_BYTES) {
    return fail(REASON.artifact_initial_manifest_too_large, { limit: MAX_RUN_MANIFEST_BYTES });
  }
  const context = {
    deps,
    paths: budget.paths,
    lockBytes,
    lockIdentity: null,
    finalIdentity: null,
    ownedDirectories: new Map(),
    manifestBytes,
    crashed: false,
  };
  try {
    // 두 디렉터리를 한 조건으로 묶지 않는다 — 실패 문구가 **어느** 경로가 비공개가 아닌지 말해야 한다.
    for (const name of ['runs', 'patches']) {
      const base = join(object.stateRoot, name);
      if (!await ensureBaseDirectory(base, deps)) return fail(REASON.artifact_base_directory_not_private, { path: base });
    }
    const lock = await openOwnedEmptyFile(budget.paths.initLockPath, deps);
    if (lock === null) return fail(REASON.artifact_init_lock_collision, { runId: object.runId });
    context.lockIdentity = lock.identity;
    await runBarrier(context, 'after-zero-byte-lock');
    if (!await writeSyncClose(lock, lockBytes) || !await verifyOwnedBytes(budget.paths.initLockPath, lockBytes, deps) ||
        !await syncDirectory(dirname(budget.paths.initLockPath), deps)) throw new Error('lock publication failed');
    await runBarrier(context, 'after-init-lock');

    const finalDirectory = await createSecureDirectory(budget.paths.runDir, deps);
    if (finalDirectory.created) context.finalIdentity = finalDirectory.identity;
    if (!finalDirectory.ok) throw new Error('final reservation failed');
    await runBarrier(context, 'after-final-directory');
    for (const name of ['candidates', 'attempts', 'evidence']) {
      const path = join(budget.paths.runDir, name);
      const childDirectory = await createSecureDirectory(path, deps);
      if (childDirectory.created && childDirectory.identity !== null) {
        context.ownedDirectories.set(path, childDirectory.identity);
      }
      if (!childDirectory.ok) throw new Error('child directory failed');
      await runBarrier(context, `after-${name}-directory`);
    }
    for (const name of ['candidates', 'attempts', 'evidence']) {
      if (!await syncDirectory(join(budget.paths.runDir, name), deps)) throw new Error('child directory sync failed');
    }
    await runBarrier(context, 'after-final-directories-synced');

    const manifestTemp = join(budget.paths.runDir, `.tmp-manifest.json-${deps.pid}-${deps.randomHex12()}`);
    if (!GENERATION_PATTERN.test(manifestTemp.slice(-12))) throw new Error('invalid temp generation');
    const temp = await openOwnedEmptyFile(manifestTemp, deps);
    if (temp === null || !await writeSyncClose(temp, manifestBytes) || !await verifyOwnedBytes(manifestTemp, manifestBytes, deps)) {
      throw new Error('manifest temp failed');
    }
    await runBarrier(context, 'after-manifest-temp');
    if (!await publishNewFile(manifestTemp, budget.paths.manifestPath, manifestBytes, deps)) throw new Error('manifest publish failed');
    await runBarrier(context, 'after-manifest-published');
    if (!await validateCompleteInitialTree(context) || !await syncDirectory(budget.paths.runDir, deps) ||
        !await syncDirectory(dirname(budget.paths.runDir), deps)) throw new Error('final verification failed');
    await runBarrier(context, 'after-final-verified');
    if (!await lockStillOwned(context)) throw new Error('init lock changed');
    await deps.unlink(budget.paths.initLockPath);
    if (!await syncDirectory(dirname(budget.paths.initLockPath), deps)) throw new Error('lock removal sync failed');
    await runBarrier(context, 'after-init-lock-removed');

    const manifestIdentity = await deps.lstat(budget.paths.manifestPath);
    const store = deepFreeze({ kind: 'run-artifact-store', runId: object.runId, root: budget.paths.runDir });
    const privateState = {
      store,
      stateRoot: object.stateRoot,
      runId: object.runId,
      candidateCount: initial.candidateCount,
      initial,
      generation,
      createdAt,
      expiresAt,
      paths: budget.paths,
      deps,
      manifest,
      manifestBytes,
      manifestHash: sha256(manifestBytes),
      manifestIdentity,
      // ★★ 직렬화 지점은 **하나**다(WS4a P1). 예전에는 체크포인트와 공개 쓰기가 각자 체인을
      //   가졌고 서로를 재우지 않았다 — 그래서 쓰기 경로가 매니페스트를 읽는 창에 옆 레인의
      //   체크포인트가 새 리비전을 발행하면 정상적인 동시 발행이 권위 위반으로 신고됐다
      //   (`artifact_manifest_authority_mismatch`, 레인 둘·예산 2 대조군에서 실측). 큐 둘을
      //   가변 상태 하나 위에 놓으면 아무도 말할 수 있는 불변식이 없다.
      storeQueue: Promise.resolve(),
      publishedPending: new Set(),
      checkpointTemp: null,
      poisoned: false,
    };
    STORE_STATES.set(store, privateState);
    return store;
  } catch {
    return fail(context.crashed ? REASON.artifact_initialization_interrupted : REASON.artifact_initialization_failed);
  }
}

function manifestRef(state, revision = state.manifest.revision) {
  return deepFreeze({ kind: 'manifest', path: state.paths.manifestPath, revision, expiresAt: state.expiresAt });
}

function finalPathForIdentity(state, identity) {
  if (identity.artifactKind === 'attempt') {
    return join(state.paths.runDir, 'attempts', `${identity.laneId}-${ordinal(identity.attemptOrdinal)}.json`);
  }
  if (identity.artifactKind === 'evidence') {
    return join(
      state.paths.runDir,
      'evidence',
      `${identity.laneId}-${ordinal(identity.attemptOrdinal)}-${ordinal(identity.evidenceOrdinal)}.json`,
    );
  }
  if (identity.artifactKind === 'candidate') return state.paths.candidatePaths[identity.laneId] ?? null;
  // ★ 다섯째 kind 는 경로 예산(`artifactPaths`)에 자기 키를 얻지 않고 실행 디렉터리에서 유도된다 —
  //   `runs/<runId>/plan.json` 은 실행마다 정확히 하나이고, 그 배열의 셰이프를 넓히면 그것을
  //   `exactObject` 로 재는 자리들이 함께 움직인다.
  if (identity.artifactKind === 'plan') return join(state.paths.runDir, 'plan.json');
  return state.paths.winnerAliasPath;
}

function configuredLane(state, laneId) {
  return LANES.slice(0, state.candidateCount).includes(laneId);
}

function attemptEntry(manifest, laneId, ordinalValue) {
  return manifest.attempts.find((entry) => entry.laneId === laneId && entry.ordinal === ordinalValue) ?? null;
}

function committedEntry(manifest, identity) {
  const key = identityKey(identity);
  return manifest.committedArtifacts.find((entry) => identityKey(identityFromInventory(entry)) === key) ?? null;
}

function pendingEntry(manifest, identity) {
  const key = identityKey(identity);
  return manifest.pendingArtifacts.find((entry) => identityKey(identityFromInventory(entry)) === key) ?? null;
}

function normalizeArtifactEvent(value, type) {
  let kind;
  try {
    kind = Object.getOwnPropertyDescriptor(value, 'artifactKind')?.value;
  } catch {
    return null;
  }
  const identityKeys = inventoryIdentityKeys(kind);
  if (identityKeys === null) return null;
  const tail = type === 'artifact_reserved'
    ? ['relativePath', 'tempRelativePath', 'expectedSha256', 'expectedBytes']
    : ['relativePath', 'ref'];
  const object = exactObject(value, ['eventId', 'type', ...tail, ...identityKeys]).value ?? null;
  if (object === null || object.type !== type || !EVENT_ID_PATTERN.test(object.eventId)) return null;
  const identity = artifactIdentity(Object.fromEntries(identityKeys.map((key) => [key, object[key]])));
  if (identity === null || object.eventId !== expectedArtifactEventId(identity, type === 'artifact_reserved' ? 'reserved' : 'committed')) return null;
  if (type === 'artifact_reserved') {
    if (!boundedString(object.relativePath, 32_768) || !boundedString(object.tempRelativePath, 32_768) ||
        !SHA256_PATTERN.test(object.expectedSha256) || !isSafeCount(object.expectedBytes)) return null;
    return {
      eventId: object.eventId,
      type,
      ...identityFields(identity),
      relativePath: object.relativePath,
      tempRelativePath: object.tempRelativePath,
      expectedSha256: object.expectedSha256,
      expectedBytes: object.expectedBytes,
    };
  }
  const ref = normalizeArtifactRef(object.ref);
  if (ref === null) return null;
  return { eventId: object.eventId, type, ...identityFields(identity), relativePath: object.relativePath, ref };
}

function normalizeEvent(value, state) {
  let type;
  try {
    type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
  } catch {
    return null;
  }
  if (type === 'artifact_reserved' || type === 'artifact_committed') return normalizeArtifactEvent(value, type);
  if (type === 'attempt_allocated') {
    const object = exactObject(value, ['eventId', 'type', 'laneId', 'ordinal', 'attemptId', 'retryOf']).value ?? null;
    if (object === null || !EVENT_ID_PATTERN.test(object.eventId) || !configuredLane(state, object.laneId) ||
        !validOrdinal(object.ordinal) || object.attemptId !== `${state.runId}/${object.laneId}/${ordinal(object.ordinal)}` ||
        object.retryOf !== expectedRetryOf(state.runId, object.laneId, object.ordinal)) return null;
    return {
      eventId: object.eventId, type, laneId: object.laneId, ordinal: object.ordinal,
      attemptId: object.attemptId, retryOf: object.retryOf,
    };
  }
  if (type === 'attempt_terminal') {
    const object = exactObject(value, ['eventId', 'type', 'laneId', 'ordinal', 'attemptId', 'attemptRef', 'result', 'verdictRef']).value ?? null;
    const ref = normalizeArtifactRef(object?.attemptRef);
    const verdictRef = normalizeVerdictValue(object?.verdictRef);
    if (object === null || !EVENT_ID_PATTERN.test(object.eventId) || !configuredLane(state, object.laneId) ||
        !validOrdinal(object.ordinal) || object.attemptId !== `${state.runId}/${object.laneId}/${ordinal(object.ordinal)}` ||
        ref === null || ref.kind !== 'attempt' || ref.candidateId !== object.laneId ||
        !closedReasonValue(object.result, ATTEMPT_RESULTS) || verdictRef === undefined) return null;
    return {
      eventId: object.eventId, type, laneId: object.laneId, ordinal: object.ordinal,
      attemptId: object.attemptId, attemptRef: ref, result: object.result, verdictRef,
    };
  }
  if (type === 'candidate_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']).value ?? null;
    const candidate = normalizeCandidateRef(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && candidate !== null
      ? { eventId: object.eventId, type, value: candidate }
      : null;
  }
  if (type === 'issues_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']).value ?? null;
    const summary = normalizeIssueSummary(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && summary !== null
      ? { eventId: object.eventId, type, value: summary }
      : null;
  }
  if (type === 'usage_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']).value ?? null;
    const usage = normalizeRunUsage(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && usage !== null
      ? { eventId: object.eventId, type, value: usage }
      : null;
  }
  if (type === 'selection_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']).value ?? null;
    const selection = normalizeSelection(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && selection !== null
      ? { eventId: object.eventId, type, value: selection }
      : null;
  }
  if (type === 'winner_alias_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'candidateId', 'value']).value ?? null;
    const ref = normalizeArtifactRef(object?.value);
    return object !== null && object.eventId === `winner:${object.candidateId}:recorded` && validLane(object.candidateId) &&
      ref !== null && ref.kind === 'winner' && ref.candidateId === object.candidateId
      ? { eventId: object.eventId, type, candidateId: object.candidateId, value: ref }
      : null;
  }
  if (type === 'cleanup_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']).value ?? null;
    const cleanup = normalizeCleanup(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && cleanup !== null
      ? { eventId: object.eventId, type, value: cleanup }
      : null;
  }
  return null;
}

function exactCanonicalPath(value) {
  return typeof value === 'string' && isAbsolute(value) && value === resolve(value);
}

function validateCleanupPathAgainstState(cleanup, state) {
  const relativePath = relativeJson(state.stateRoot, cleanup.path);
  const expectedTop = cleanup.kind === 'planner' ? 'plans' : 'worktrees';
  const parts = relativePath?.split('/') ?? [];
  const expected = parts.length === 2 ? join(state.stateRoot, ...parts) : null;
  return exactCanonicalPath(cleanup.path) && expected !== null && cleanup.path === expected && parts[0] === expectedTop &&
    (cleanup.status === 'removed' ? cleanup.recoveryPath === null :
      exactCanonicalPath(cleanup.recoveryPath) && cleanup.recoveryPath === cleanup.path);
}

function validateEventPathsAgainstState(event, state) {
  if (event.type === 'artifact_committed') {
    const identity = artifactIdentity(identityFields(event));
    const expected = identity === null ? null : finalPathForIdentity(state, identity);
    return expected !== null && exactCanonicalPath(event.ref.path) && event.ref.path === expected &&
      event.relativePath === relativeJson(state.stateRoot, expected);
  }
  if (event.type === 'attempt_terminal') {
    const expected = finalPathForIdentity(state, {
      artifactKind: 'attempt', laneId: event.laneId, attemptOrdinal: event.ordinal,
    });
    return exactCanonicalPath(event.attemptRef.path) && event.attemptRef.path === expected;
  }
  if (event.type === 'candidate_recorded' && event.value.patchRef !== null) {
    const expected = state.paths.candidatePaths[event.value.candidateId] ?? null;
    return expected !== null && exactCanonicalPath(event.value.patchRef.path) && event.value.patchRef.path === expected;
  }
  if (event.type === 'winner_alias_recorded') {
    return exactCanonicalPath(event.value.path) && event.value.path === state.paths.winnerAliasPath;
  }
  if (event.type === 'cleanup_recorded') {
    return validateCleanupPathAgainstState(event.value, state);
  }
  return true;
}

function manifestPathsBoundToState(manifest, state) {
  if (manifest.committedArtifacts.some((entry) =>
    !samePath(resolve(entry.ref.path), resolve(join(state.stateRoot, ...entry.relativePath.split('/')))))) return false;
  return manifest.cleanup.every((entry) => validateCleanupPathAgainstState(entry, state));
}

async function loadCurrentManifest(state) {
  try {
    if (!await verifyStorePath(state.paths.manifestPath, 'file', state)) return null;
    const info = await state.deps.lstat(state.paths.manifestPath);
    if (!sameIdentity(info, state.manifestIdentity) || !isSafeCount(info.size) ||
        info.size <= 0 || info.size > MAX_RUN_MANIFEST_BYTES) return null;
    const bytes = await state.deps.readFile(state.paths.manifestPath);
    if (!Buffer.isBuffer(bytes) || bytes.length !== info.size || sha256(bytes) !== state.manifestHash) return null;
    const normalized = normalizeRunManifestV1(JSON.parse(bytes.toString('utf8')));
    if (normalized === null || normalized.runId !== state.runId || normalized.generation !== state.generation ||
        normalized.revision !== state.manifest.revision || normalized.createdAt !== state.createdAt ||
        normalized.expiresAt !== state.expiresAt || !manifestPathsBoundToState(normalized, state)) return null;
    return { manifest: normalized, bytes };
  } catch {
    return null;
  }
}

function identityFromEvent(event) {
  return artifactIdentity(identityFields(event));
}

function exactTempForEvent(state, identity, relativePathValue, tempRelativePath) {
  const finalPath = finalPathForIdentity(state, identity);
  if (finalPath === null || relativeJson(state.stateRoot, finalPath) !== relativePathValue) return false;
  const finalBase = basename(finalPath);
  const tempPath = join(dirname(finalPath), `.tmp-${finalBase}-${state.deps.pid}-${tempRelativePath.slice(-12)}`);
  return GENERATION_PATTERN.test(tempRelativePath.slice(-12)) &&
    relativeJson(state.stateRoot, tempPath) === tempRelativePath &&
    /^\d+$/.test(String(state.deps.pid));
}

async function requireAbsent(path, state) {
  const status = await lstatAbsent(path, state.deps);
  return status.exists === false;
}

async function applyReserved(manifest, event, state) {
  const identity = identityFromEvent(event);
  // ★ `plan` 만 레인 검사를 지나지 않는다 — 계획은 실행 하나 전체의 산출물이라 후보가 `null` 이다
  //   (`src/run-manifest.mjs` 의 `ARTIFACT_KINDS`). 나머지 넷은 여전히 설정된 레인의 것이어야 한다.
  if (identity === null || (identity.artifactKind !== 'plan' && !configuredLane(state, candidateForIdentity(identity))) ||
      !exactTempForEvent(state, identity, event.relativePath, event.tempRelativePath) ||
      pendingEntry(manifest, identity) !== null || committedEntry(manifest, identity) !== null ||
      manifest.pendingArtifacts.some((entry) => entry.relativePath === event.relativePath || entry.tempRelativePath === event.tempRelativePath) ||
      manifest.committedArtifacts.some((entry) => entry.relativePath === event.relativePath)) return false;
  if (identity.artifactKind === 'attempt' || identity.artifactKind === 'evidence') {
    if (attemptEntry(manifest, identity.laneId, identity.attemptOrdinal) === null) return false;
  }
  // ★ JSON 기록 셋은 같은 바이트 상한을 받는다(`plan` 은 attempt·evidence 와 같은 부류다) —
  //   패치 둘만 상한 없는 바이트열이다.
  if (identity.artifactKind === 'attempt' || identity.artifactKind === 'evidence' || identity.artifactKind === 'plan') {
    if (event.expectedBytes > MAX_JSON_ARTIFACT_BYTES) return false;
  }
  if (identity.artifactKind === 'candidate') {
    const attempt = manifest.attempts.find((entry) => entry.attemptId === identity.sourceAttemptId &&
      entry.laneId === identity.laneId && entry.status === 'terminal');
    if (!attempt) return false;
  }
  if (identity.artifactKind === 'winner' &&
      (manifest.selection === null || manifest.selection.selectedCandidateId !== identity.candidateId)) return false;
  const finalPath = finalPathForIdentity(state, identity);
  const tempPath = join(state.stateRoot, ...event.tempRelativePath.split('/'));
  if (!await requireAbsent(finalPath, state) || !await requireAbsent(tempPath, state)) return false;
  manifest.pendingArtifacts.push({
    ...identityFields(identity),
    relativePath: event.relativePath,
    tempRelativePath: event.tempRelativePath,
    expectedSha256: event.expectedSha256,
    expectedBytes: event.expectedBytes,
    reservedEventId: event.eventId,
  });
  return true;
}

async function applyCommitted(manifest, event, state) {
  const identity = identityFromEvent(event);
  const pending = identity === null ? null : pendingEntry(manifest, identity);
  if (identity === null || pending === null || event.relativePath !== pending.relativePath ||
      event.ref.kind !== artifactKindForIdentity(identity) || event.ref.candidateId !== candidateForIdentity(identity) ||
      event.ref.sha256 !== pending.expectedSha256 || event.ref.bytes !== pending.expectedBytes ||
      event.ref.expiresAt !== state.expiresAt) return false;
  const finalPath = finalPathForIdentity(state, identity);
  const tempPath = join(state.stateRoot, ...pending.tempRelativePath.split('/'));
  if (!await requireAbsent(tempPath, state) || !await verifyImmutableRef(event.ref, finalPath, state)) return false;
  if (identity.artifactKind === 'evidence') {
    const record = await readJsonRecord(finalPath, MAX_JSON_ARTIFACT_BYTES, state);
    const normalized = record === null ? null : normalizeEvidenceRecord(record.value, state, identity.laneId, identity.attemptOrdinal);
    if (normalized === null || sha256(record.bytes) !== event.ref.sha256 || record.bytes.length !== event.ref.bytes ||
        manifest.evidenceRefs.some((entry) => entry.evidenceId === normalized.evidenceId)) return false;
    manifest.evidenceRefs.push({
      laneId: identity.laneId,
      attemptId: normalized.attemptId,
      evidenceId: normalized.evidenceId,
      kind: normalized.kind,
      repetition: normalized.repetition,
      ref: event.ref,
    });
  }
  manifest.pendingArtifacts = manifest.pendingArtifacts.filter((entry) =>
    identityKey(identityFromInventory(entry)) !== identityKey(identity));
  manifest.committedArtifacts.push({
    ...identityFields(identity),
    relativePath: event.relativePath,
    ref: event.ref,
    committedEventId: event.eventId,
  });
  return true;
}

async function applyAttemptTerminal(manifest, event, state) {
  const attempt = attemptEntry(manifest, event.laneId, event.ordinal);
  const identity = { artifactKind: 'attempt', laneId: event.laneId, attemptOrdinal: event.ordinal };
  const committed = committedEntry(manifest, identity);
  if (attempt === null || attempt.status !== 'allocated' || committed === null || !sameJson(event.attemptRef, committed.ref) ||
      !await verifyImmutableRef(event.attemptRef, finalPathForIdentity(state, identity), state)) return false;
  const record = await readJsonRecord(event.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
  const normalized = record === null ? null : normalizeAttemptRecord(record.value, state, event.laneId, event.ordinal, { fromDisk: true });
  if (normalized === null || sha256(record.bytes) !== event.attemptRef.sha256 || record.bytes.length !== event.attemptRef.bytes ||
      normalized.result !== event.result || !sameJson(normalized.verdictRef, event.verdictRef) ||
      !await verifySealedEvidenceAuthority(normalized, state, event.laneId, event.ordinal, finalPathForIdentity)) return false;
  attempt.status = 'terminal';
  attempt.attemptRef = event.attemptRef;
  attempt.result = event.result;
  if (event.verdictRef !== null) {
    manifest.verdictRefs.push({
      laneId: event.laneId,
      attemptId: event.attemptId,
      verdict: event.verdictRef.verdict,
      issueIds: event.verdictRef.issueIds,
    });
  }
  return true;
}

async function applyCandidateRecorded(manifest, event, state) {
  const candidate = event.value;
  if (!configuredLane(state, candidate.candidateId) ||
      manifest.candidateRefs.some((entry) => entry.candidateId === candidate.candidateId)) return false;
  if (candidate.patchRef !== null) {
    const identity = { artifactKind: 'candidate', laneId: candidate.candidateId, sourceAttemptId: candidate.sourceAttemptId };
    const committed = committedEntry(manifest, identity);
    const attempt = manifest.attempts.find((entry) => entry.attemptId === candidate.sourceAttemptId && entry.status === 'terminal');
    if (committed === null || attempt === undefined || !sameJson(committed.ref, candidate.patchRef)) return false;
    const record = await readJsonRecord(attempt.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
    const normalized = record === null ? null : normalizeAttemptRecord(record.value, state, candidate.candidateId, attempt.ordinal, { fromDisk: true });
    if (normalized?.sealed === null || normalized.sealed.treeHash !== candidate.treeHash ||
        normalized.sealed.patchSha256 !== candidate.patchRef.sha256) return false;
  } else if (candidate.sourceAttemptId === null) {
    if (!(candidate.terminalClass === 'blocked' && candidate.treeHash === null)) return false;
  } else {
    const attempt = manifest.attempts.find((entry) => entry.laneId === candidate.candidateId &&
      entry.attemptId === candidate.sourceAttemptId && entry.status === 'terminal');
    if (!attempt?.attemptRef) return false;
    const record = await readJsonRecord(attempt.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
    const normalized = record === null ? null : normalizeAttemptRecord(record.value, state, candidate.candidateId, attempt.ordinal, { fromDisk: true });
    if (normalized?.sealed === null || normalized.sealed.treeHash !== candidate.treeHash) return false;
  }
  manifest.candidateRefs.push(candidate);
  return true;
}

async function applyEvent(manifest, event, state) {
  if (event.type === 'attempt_allocated') {
    // ★ 재개(WS3 §3)가 여는 자리 하나: 레인에 attempt 가 **아직 하나도 없으면** 어느 서수로도
    //   시작할 수 있다 — 재개된 레인은 원본이 남긴 마지막 서수의 다음부터 이어 쓴다. 그 뒤로는
    //   옛 규칙 그대로다: 서수 +1 이고 앞 attempt 가 terminal 이어야 한다(사슬 안의 구멍은 여전히
    //   거절된다). 이 자리가 「어느 실행에서 이어졌나」를 검사하지 못하는 것은 매니페스트가 그것을
    //   적을 자리를 갖지 않기 때문이고(`expectedRetryOf` 머리말), 시작 서수를 고르는 권위는
    //   엔진의 재개 관문(baseline + 환경 지문 일치)에 있다.
    const laneStarted = manifest.attempts.some((entry) => entry.laneId === event.laneId);
    if (attemptEntry(manifest, event.laneId, event.ordinal) !== null ||
        laneStarted && attemptEntry(manifest, event.laneId, event.ordinal - 1)?.status !== 'terminal') return false;
    manifest.attempts.push({
      laneId: event.laneId,
      ordinal: event.ordinal,
      attemptId: event.attemptId,
      retryOf: event.retryOf,
      status: 'allocated',
      attemptRef: null,
      result: null,
    });
    return true;
  }
  if (event.type === 'artifact_reserved') return applyReserved(manifest, event, state);
  if (event.type === 'artifact_committed') return applyCommitted(manifest, event, state);
  if (event.type === 'attempt_terminal') return applyAttemptTerminal(manifest, event, state);
  if (event.type === 'candidate_recorded') return applyCandidateRecorded(manifest, event, state);
  if (event.type === 'issues_recorded') {
    if (!configuredLane(state, event.value.candidateId) ||
        manifest.issueSummary.some((entry) => entry.candidateId === event.value.candidateId)) return false;
    manifest.issueSummary.push(event.value);
    return true;
  }
  if (event.type === 'usage_recorded') {
    if (manifest.usage !== null) return false;
    manifest.usage = event.value;
    return true;
  }
  if (event.type === 'selection_recorded') {
    if (manifest.selection !== null || manifest.candidateRefs.length !== state.candidateCount ||
        !completeIssueSummary(manifest.candidateRefs, manifest.issueSummary, state.candidateCount) ||
        event.value.selectedCandidateId !== null && !manifest.candidateRefs.some((entry) =>
          entry.candidateId === event.value.selectedCandidateId && entry.patchRef !== null)) return false;
    manifest.selection = event.value;
    return true;
  }
  if (event.type === 'winner_alias_recorded') {
    if (manifest.winnerAlias !== null || manifest.selection?.selectedCandidateId !== event.candidateId) return false;
    const candidate = manifest.candidateRefs.find((entry) => entry.candidateId === event.candidateId);
    const winner = committedEntry(manifest, { artifactKind: 'winner', candidateId: event.candidateId });
    if (candidate?.patchRef === null || winner === null || !sameJson(winner.ref, event.value) ||
        event.value.path === candidate.patchRef.path || event.value.sha256 !== candidate.patchRef.sha256 ||
        event.value.bytes !== candidate.patchRef.bytes) return false;
    manifest.winnerAlias = event.value;
    return true;
  }
  if (event.type === 'cleanup_recorded') {
    if (manifest.cleanup.some((entry) => cleanupKey(entry) === cleanupKey(event.value))) return false;
    manifest.cleanup.push(event.value);
    return true;
  }
  return false;
}

function sortManifest(manifest) {
  manifest.appliedEvents.sort(compareAppliedEvents);
  manifest.pendingArtifacts.sort(compareInventoryEntries);
  manifest.committedArtifacts.sort(compareInventoryEntries);
  manifest.attempts.sort(compareAttempts);
  manifest.evidenceRefs.sort(compareEvidenceRefs);
  manifest.candidateRefs.sort(compareCandidateRefs);
  manifest.verdictRefs.sort(compareVerdictRefs);
  manifest.issueSummary.sort(compareIssueSummaries);
  manifest.cleanup.sort(compareCleanup);
}

async function publishManifestRevision(state, next) {
  if (state.poisoned || state.checkpointTemp !== null) return null;
  const normalized = normalizeRunManifestV1(next);
  if (normalized === null) return null;
  const bytes = jsonBytes(normalized);
  if (bytes === null || bytes.length > MAX_RUN_MANIFEST_BYTES) return null;
  let tempGeneration;
  try {
    tempGeneration = state.deps.randomHex12();
  } catch {
    return null;
  }
  if (!GENERATION_PATTERN.test(tempGeneration)) return null;
  const tempPath = join(dirname(state.paths.manifestPath), `.tmp-manifest.json-${state.deps.pid}-${tempGeneration}`);
  state.checkpointTemp = { path: tempPath, identity: null, verified: false };
  const owned = await openOwnedEmptyFile(tempPath, state.deps, (identity) => {
    state.checkpointTemp.identity = identity;
  });
  if (owned === null) return poisonCheckpoint(state);
  state.checkpointTemp.verified = true;
  if (!await writeSyncClose(owned, bytes) || !await verifyOwnedBytes(tempPath, bytes, state.deps)) {
    return poisonCheckpoint(state);
  }
  try {
    await state.deps.crashBarrier?.('after-checkpoint-temp');
  } catch {
    return poisonCheckpoint(state);
  }
  let replaced;
  try {
    replaced = await state.deps.replaceFileAtomic(tempPath, state.paths.manifestPath);
  } catch {
    return poisonCheckpoint(state);
  }
  if (replaced?.ok !== true) return poisonCheckpoint(state);
  if (!await secureAndVerify(state.paths.manifestPath, 'file', 'published', state.deps) ||
      !await verifyOwnedBytes(state.paths.manifestPath, bytes, state.deps) ||
      !await syncDirectory(dirname(state.paths.manifestPath), state.deps)) return poisonCheckpoint(state);
  let manifestIdentity;
  try {
    manifestIdentity = await state.deps.lstat(state.paths.manifestPath);
  } catch {
    return poisonCheckpoint(state);
  }
  if (!sameIdentity(manifestIdentity, state.checkpointTemp.identity)) return poisonCheckpoint(state);
  state.manifest = normalized;
  state.manifestBytes = bytes;
  state.manifestHash = sha256(bytes);
  state.manifestIdentity = manifestIdentity;
  state.checkpointTemp = null;
  try {
    await state.deps.crashBarrier?.('after-checkpoint-published');
  } catch {
    return poisonCheckpoint(state);
  }
  return normalized;
}

function poisonCheckpoint(state) {
  state.poisoned = true;
  return null;
}

/**
 * 이벤트가 말한 컨트롤러 경로 — 실패 문구의 `{path}` 자리다. 이벤트 모양이 일곱이라 값이 아니라
 * **이름**(`path`·`recoveryPath`)으로 모은다. 하나도 없으면 이 저장소의 상태 루트를 쓴다 —
 * 문장이 자리표시자를 그대로 내보내는 것보다 덜 틀린 답이다.
 */
function eventPathClaim(event, stateRoot) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'path' || key === 'recoveryPath') && typeof item === 'string') found.push(item);
        else walk(item);
      }
    }
  };
  walk(event);
  return found[0] ?? stateRoot;
}

async function checkpointNow(state, rawEvent) {
  if (state.poisoned) return fail(REASON.artifact_store_poisoned);
  const current = await loadCurrentManifest(state);
  if (current === null) return fail(REASON.artifact_manifest_authority_mismatch);
  const event = normalizeEvent(rawEvent, state);
  if (event === null) return fail(REASON.artifact_manifest_event_invalid);
  if (!validateEventPathsAgainstState(event, state) || logicalEventValue(event, state.stateRoot) === undefined) {
    return fail(REASON.artifact_manifest_event_path_invalid, { path: eventPathClaim(event, state.stateRoot) });
  }
  const digest = eventDigest(event, state.stateRoot);
  if (digest === null) return fail(REASON.artifact_manifest_event_path_invalid, { path: eventPathClaim(event, state.stateRoot) });
  const applied = current.manifest.appliedEvents.find((entry) => entry.eventId === event.eventId);
  if (applied !== undefined) {
    if (!eventDigestMatches(applied.eventSha256, event, state.stateRoot)) return fail(REASON.artifact_manifest_event_payload_mismatch);
    return deepFreeze({
      revision: current.manifest.revision,
      manifestRef: manifestRef(state, current.manifest.revision),
      duplicate: true,
    });
  }
  // 복사에 실패한 매니페스트는 전이시킬 수 없다. `undefined` 를 넘기면 `applyEvent` 가 날
  // TypeError 를 던지고, 그 예외는 큐 바깥의 포괄 catch 까지 올라가 원인을 잃는다.
  const next = cloneData(current.manifest);
  if (next === undefined) return fail(REASON.artifact_manifest_transition_invalid);
  if (!await applyEvent(next, event, state)) return fail(REASON.artifact_manifest_transition_invalid);
  next.appliedEvents.push({ eventId: event.eventId, eventSha256: digest });
  next.revision = current.manifest.revision + 1;
  sortManifest(next);
  const validated = validateRunManifestTransitionV1(current.manifest, next);
  if (validated === null) return fail(REASON.artifact_manifest_transition_invalid);
  const published = await publishManifestRevision(state, validated);
  if (published === null) return fail(REASON.artifact_manifest_checkpoint_failed);
  return deepFreeze({ revision: published.revision, manifestRef: manifestRef(state, published.revision), duplicate: false });
}

/**
 * 이 저장소의 유일한 직렬화 지점. 앞 작업이 어떻게 끝났든 다음 작업을 태우고(거부된 프로미스를
 * 체인에 남기지 않는다), 큐 자신은 언제나 `undefined` 로 정착한다.
 */
function enqueueOnStore(state, operation) {
  const start = () => operation();
  const promise = state.storeQueue.then(start, start);
  state.storeQueue = promise.then(() => undefined, () => undefined);
  return promise;
}

/**
 * 쓰기 몸통 **안에서** 부르는 체크포인트 — 이미 큐 위에 있으므로 다시 줄을 서면 자기 자신을
 * 기다린다(자기 교착).
 *
 * ★★ 재진입이 안전한 근거는 **구조**다, 플래그가 아니다: 이 함수를 부르는 자리는
 *   `writePreparedArtifact` 안 다섯 곳뿐이고(예약·발행 후 커밋 둘·attempt terminal·winner),
 *   `writePreparedArtifact` 를 부르는 자리는 `enqueueWriter` 에 넘긴 쓰기 몸통 다섯뿐이다
 *   (attempt·evidence·candidate·winner, 그리고 태스크 9 의 `writePlanArtifact`). 그래서
 *   이 호출은 언제나 이미 이 저장소의 큐 슬롯을 쥔 사슬 안에서 일어난다 — 슬롯을 쥔 채
 *   `checkpointNow` 를 직접 부르는 것이 곧 배타적 실행이다. 전역 플래그(「지금 큐가 돌고 있다」)는
 *   이 판정을 못 한다: 큐 작업이 await 로 양보한 사이에 **바깥** 호출자가 그 플래그를 보면
 *   재진입이 아닌데 재진입이라고 답한다.
 *
 * ★ 방향을 반대로도 적어 둔다(WS4a P1 리뷰 F4): 이 몸통 **안에서** 다시 줄을 서는(QUEUED)
 *   진입점을 부르면 자기 교착이다 — `checkpointInWriter` 대신 내보낸 `checkpointManifest`
 *   (또는 `enqueueWriter`)를 여기서 부르면, 이미 쥔 슬롯 뒤에 자기 자신을 세우고 그 슬롯이
 *   끝나기를 기다리는 꼴이 되어 예외 하나 없이 영영 안 끝난다. 증상은 실패가 아니라 정지다 —
 *   테스트 타임아웃까지 그냥 "느린" 것처럼 보이지, 무엇이 잘못됐는지 말해 주지 않는다.
 *   실제로 닿을 수 있는 자리는 `state.deps.crashBarrier` 다: `writePreparedArtifact` 가 몸통
 *   안 여러 지점(예약·temp·published·committed 뒤)에서 그것을 부르는데, 운영 코드는 언제나
 *   `null` 을 넘겨 이 자리를 아무 일도 안 하게 둔다 — 위험은 이 자리에 `checkpointManifest` 를
 *   부르는 crashBarrier 를(예컨대 테스트가) 꽂을 때만 산다.
 */
async function checkpointInWriter(state, event) {
  try {
    return await checkpointNow(state, cloneExactData(event));
  } catch {
    return fail(REASON.artifact_manifest_checkpoint_failed);
  }
}

export async function checkpointManifest(store, event) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return fail(REASON.artifact_store_handle_invalid);
  const copied = cloneExactData(event);
  try {
    return await enqueueOnStore(state, () => checkpointNow(state, copied));
  } catch {
    return fail(REASON.artifact_manifest_checkpoint_failed);
  }
}

function writerResult(state, ref, revision, duplicate) {
  return deepFreeze({
    ok: true,
    ref,
    revision,
    manifestRef: manifestRef(state, revision),
    duplicate,
  });
}

function enqueueWriter(state, operation) {
  const guarded = () => state.poisoned ? fail(REASON.artifact_store_poisoned) : operation();
  return enqueueOnStore(state, guarded).catch(() => fail(REASON.artifact_write_failed));
}

function tempPathForFinal(state, finalPath) {
  let generation;
  try {
    generation = state.deps.randomHex12();
  } catch {
    return null;
  }
  return GENERATION_PATTERN.test(generation)
    ? join(dirname(finalPath), `.tmp-${basename(finalPath)}-${state.deps.pid}-${generation}`)
    : null;
}

async function currentCommittedForWrite(state, identity, expectedSha256, expectedBytes) {
  const loaded = await loadCurrentManifest(state);
  if (loaded === null) return { blocked: fail(REASON.artifact_manifest_authority_mismatch) };
  const committed = committedEntry(loaded.manifest, identity);
  if (committed === null) return { manifest: loaded.manifest, committed: null };
  if (committed.ref.sha256 !== expectedSha256 || committed.ref.bytes !== expectedBytes ||
      !await verifyImmutableRef(committed.ref, finalPathForIdentity(state, identity), state)) {
    return { blocked: fail(REASON.artifact_replay_mismatch) };
  }
  return { manifest: loaded.manifest, committed };
}

async function postAttemptTerminal(state, identity, record, ref) {
  const event = {
    eventId: `attempt:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:terminal`,
    type: 'attempt_terminal',
    laneId: identity.laneId,
    ordinal: identity.attemptOrdinal,
    attemptId: record.attemptId,
    attemptRef: ref,
    result: record.result,
    verdictRef: record.verdictRef,
  };
  return checkpointInWriter(state, event);
}

async function postWinnerRecorded(state, identity, ref) {
  return checkpointInWriter(state, {
    eventId: `winner:${identity.candidateId}:recorded`,
    type: 'winner_alias_recorded',
    candidateId: identity.candidateId,
    value: ref,
  });
}

async function finishPostArtifactEvent(state, identity, record, ref, duplicate) {
  let checkpoint = null;
  if (identity.artifactKind === 'attempt') checkpoint = await postAttemptTerminal(state, identity, record, ref);
  if (identity.artifactKind === 'winner') checkpoint = await postWinnerRecorded(state, identity, ref);
  if (checkpoint?.blocked) return checkpoint;
  const revision = checkpoint?.revision ?? state.manifest.revision;
  return writerResult(state, ref, revision, duplicate || checkpoint?.duplicate === true);
}

async function writePreparedArtifact(state, { identity, bytes, record = null }) {
  const expectedSha256 = sha256(bytes);
  const expectedBytes = bytes.length;
  const existing = await currentCommittedForWrite(state, identity, expectedSha256, expectedBytes);
  if (existing.blocked) return existing.blocked;
  if (existing.committed !== null) {
    return finishPostArtifactEvent(state, identity, record, existing.committed.ref, true);
  }
  const finalPath = finalPathForIdentity(state, identity);
  if (finalPath === null) return fail(REASON.artifact_identity_invalid);
  let pending = pendingEntry(existing.manifest, identity);
  let tempPath;
  if (pending !== null) {
    if (pending.expectedSha256 !== expectedSha256 || pending.expectedBytes !== expectedBytes ||
        pending.relativePath !== relativeJson(state.stateRoot, finalPath)) return fail(REASON.artifact_pending_replay_mismatch);
    tempPath = join(state.stateRoot, ...pending.tempRelativePath.split('/'));
  } else {
    tempPath = tempPathForFinal(state, finalPath);
    if (tempPath === null) return fail(REASON.artifact_temp_name_failed);
    const reservedEvent = {
      eventId: expectedArtifactEventId(identity, 'reserved'),
      type: 'artifact_reserved',
      relativePath: relativeJson(state.stateRoot, finalPath),
      tempRelativePath: relativeJson(state.stateRoot, tempPath),
      expectedSha256,
      expectedBytes,
      ...identityFields(identity),
    };
    const reserved = await checkpointInWriter(state, reservedEvent);
    if (reserved.blocked) return reserved;
    pending = pendingEntry(state.manifest, identity);
    if (pending === null) return fail(REASON.artifact_reservation_lost);
  }
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-reserved`);
  } catch {
    return fail(REASON.artifact_write_interrupted);
  }
  const publishedKey = identityKey(identity);
  const finalStatus = await lstatAbsent(finalPath, state.deps);
  if (finalStatus.blocked) return fail(REASON.artifact_final_inspection_failed);
  if (finalStatus.exists) {
    if (!state.publishedPending.has(publishedKey) || !await requireAbsent(tempPath, state)) {
      return fail(REASON.artifact_unowned_final_collision, { path: finalPath });
    }
    const ref = deepFreeze({
      kind: artifactKindForIdentity(identity),
      candidateId: candidateForIdentity(identity),
      path: finalPath,
      sha256: expectedSha256,
      bytes: expectedBytes,
      expiresAt: state.expiresAt,
    });
    if (!await verifyImmutableRef(ref, finalPath, state)) return fail(REASON.artifact_pending_final_mismatch);
    const committed = await checkpointInWriter(state, {
      eventId: expectedArtifactEventId(identity, 'committed'),
      type: 'artifact_committed',
      relativePath: relativeJson(state.stateRoot, finalPath),
      ref,
      ...identityFields(identity),
    });
    if (committed.blocked) return committed;
    state.publishedPending.delete(publishedKey);
    return finishPostArtifactEvent(state, identity, record, ref, false);
  }
  const tempStatus = await lstatAbsent(tempPath, state.deps);
  if (tempStatus.blocked) return fail(REASON.artifact_temp_inspection_failed);
  if (tempStatus.exists) {
    if (!await verifyPhysicalPath(tempPath, 'file', state.deps)) return fail(REASON.artifact_temp_mismatch);
    const info = await state.deps.lstat(tempPath).catch(() => null);
    if (info === null || info.size > expectedBytes || !await verifyOwnedBytes(tempPath, bytes, state.deps)) {
      return fail(REASON.artifact_partial_write_requires_recovery);
    }
  } else {
    const owned = await openOwnedEmptyFile(tempPath, state.deps);
    if (owned === null || !await writeSyncClose(owned, bytes) || !await verifyOwnedBytes(tempPath, bytes, state.deps)) {
      return fail(REASON.artifact_temp_write_failed);
    }
  }
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-temp`);
  } catch {
    return fail(REASON.artifact_write_interrupted);
  }
  if (!await publishNewFile(tempPath, finalPath, bytes, state.deps)) return fail(REASON.artifact_create_once_publish_failed);
  state.publishedPending.add(publishedKey);
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-published`);
  } catch {
    return fail(REASON.artifact_write_interrupted);
  }
  const ref = deepFreeze({
    kind: artifactKindForIdentity(identity),
    candidateId: candidateForIdentity(identity),
    path: finalPath,
    sha256: expectedSha256,
    bytes: expectedBytes,
    expiresAt: state.expiresAt,
  });
  const committed = await checkpointInWriter(state, {
    eventId: expectedArtifactEventId(identity, 'committed'),
    type: 'artifact_committed',
    relativePath: relativeJson(state.stateRoot, finalPath),
    ref,
    ...identityFields(identity),
  });
  if (committed.blocked) return committed;
  state.publishedPending.delete(publishedKey);
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-committed`);
  } catch {
    return fail(REASON.artifact_write_interrupted);
  }
  return finishPostArtifactEvent(state, identity, record, ref, false);
}

export async function writeEvidenceArtifact(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return fail(REASON.artifact_store_handle_invalid);
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['laneId', 'attemptOrdinal', 'evidenceOrdinal', 'record']).value ?? null;
    if (object === null || !configuredLane(state, object.laneId) || !validOrdinal(object.attemptOrdinal) ||
        !validOrdinal(object.evidenceOrdinal) || attemptEntry(state.manifest, object.laneId, object.attemptOrdinal) === null) {
      return fail(REASON.artifact_evidence_input_invalid);
    }
    const record = normalizeEvidenceRecord(object.record, state, object.laneId, object.attemptOrdinal);
    if (record === null) return fail(REASON.artifact_evidence_record_invalid);
    const bytes = jsonBytes(record);
    if (bytes === null || bytes.length > MAX_JSON_ARTIFACT_BYTES) return fail(REASON.evidence_artifact_too_large, { limit: MAX_JSON_ARTIFACT_BYTES });
    return writePreparedArtifact(state, {
      identity: {
        artifactKind: 'evidence', laneId: object.laneId,
        attemptOrdinal: object.attemptOrdinal, evidenceOrdinal: object.evidenceOrdinal,
      },
      bytes,
      record,
    });
  });
}

export async function writeAttemptArtifact(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return fail(REASON.artifact_store_handle_invalid);
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['laneId', 'ordinal', 'record']).value ?? null;
    if (object === null || !configuredLane(state, object.laneId) || !validOrdinal(object.ordinal) ||
        attemptEntry(state.manifest, object.laneId, object.ordinal) === null) return fail(REASON.artifact_attempt_input_invalid);
    const record = normalizeAttemptRecord(object.record, state, object.laneId, object.ordinal);
    if (record === null || !await verifySealedEvidenceAuthority(record, state, object.laneId, object.ordinal, finalPathForIdentity)) {
      return fail(REASON.artifact_attempt_record_invalid);
    }
    const bytes = jsonBytes(record);
    if (bytes === null || bytes.length > MAX_JSON_ARTIFACT_BYTES) return fail(REASON.artifact_attempt_too_large, { limit: MAX_JSON_ARTIFACT_BYTES });
    return writePreparedArtifact(state, {
      identity: { artifactKind: 'attempt', laneId: object.laneId, attemptOrdinal: object.ordinal },
      bytes,
      record,
    });
  });
}

async function sealedAttemptRecord(state, laneId, sourceAttemptId) {
  const attempt = state.manifest.attempts.find((entry) =>
    entry.laneId === laneId && entry.attemptId === sourceAttemptId && entry.status === 'terminal');
  if (!attempt?.attemptRef) return null;
  const record = await readJsonRecord(attempt.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
  if (record === null) return null;
  const normalized = normalizeAttemptRecord(record.value, state, laneId, attempt.ordinal, { fromDisk: true });
  return normalized?.sealed === null ? null : normalized;
}

export async function writeCandidatePatch(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return fail(REASON.artifact_store_handle_invalid);
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['laneId', 'sourceAttemptId', 'patch']).value ?? null;
    if (object === null || !configuredLane(state, object.laneId) || !boundedString(object.sourceAttemptId, 256) ||
        !Buffer.isBuffer(object.patch)) return fail(REASON.artifact_candidate_input_invalid);
    const attempt = await sealedAttemptRecord(state, object.laneId, object.sourceAttemptId);
    if (attempt === null || attempt.sealed.patchSha256 !== sha256(object.patch)) return fail(REASON.artifact_candidate_patch_mismatch);
    return writePreparedArtifact(state, {
      identity: { artifactKind: 'candidate', laneId: object.laneId, sourceAttemptId: object.sourceAttemptId },
      bytes: Buffer.from(object.patch),
    });
  });
}

/**
 * 플래너 정본 `runs/<runId>/plan.json` 을 쓴다 — 실행 하나에 **한 번**(스펙 §0-PL, 태스크 9).
 *
 * ★ 두 번째 호출은 실패가 아니라 **같은 답**이다. 신원이 하나뿐이라 두 번째 예약은 같은
 *   `artifact:plan:reserved` 를 요구하고, 바이트가 같으면 `writePrepared­Artifact` 의 committed
 *   경로가 그것을 `duplicate` 로 돌려준다(다른 넷과 같은 규율). 바이트가 다르면
 *   `artifact_replay_mismatch` 다 — 정본은 불변이다.
 * ★ 다른 넷과 달리 레인을 안 받는다. 계획은 실행 전체의 산출물이고 그 사실이 신원에 적혀 있다.
 */
export async function writePlanArtifact(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return fail(REASON.artifact_store_handle_invalid);
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['record']).value ?? null;
    const record = object === null ? null : normalizePlanRecord(object.record, state);
    // ★ 코드가 **하나**인 이유: 이 이음매에서 잘못될 수 있는 것은 「건네진 것이 이 실행의 계획
    //   기록이 아니다」 하나뿐이다. `content` 가 1,200 자에서 잘려 오므로 크기 갈래는 도달할 수
    //   없고(직렬화한 기록은 수 KB다), 도달 못 하는 분기가 자기 코드를 들면 그 코드를 읽는 다음
    //   사람은 그것이 언젠가 나온다고 믿는다. 상한 자체는 사라지지 않았다 — `applyReserved` 가
    //   attempt·evidence 와 같은 `MAX_JSON_ARTIFACT_BYTES` 를 이 kind 에도 건다.
    const bytes = record === null ? null : jsonBytes(record);
    if (bytes === null) return fail(REASON.artifact_plan_record_invalid);
    return writePreparedArtifact(state, { identity: { artifactKind: 'plan' }, bytes });
  });
}

export async function writeWinnerAlias(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return fail(REASON.artifact_store_handle_invalid);
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['candidateId']).value ?? null;
    if (object === null || !configuredLane(state, object.candidateId) ||
        state.manifest.selection?.selectedCandidateId !== object.candidateId) return fail(REASON.artifact_winner_alias_not_selected);
    const candidate = state.manifest.candidateRefs.find((entry) => entry.candidateId === object.candidateId);
    if (!candidate?.patchRef || candidate.patchRef.bytes <= 0 ||
        !await verifyImmutableRef(candidate.patchRef, state.paths.candidatePaths[object.candidateId], state)) {
      return fail(REASON.artifact_winner_candidate_unavailable);
    }
    let bytes;
    try {
      bytes = await state.deps.readFile(candidate.patchRef.path);
    } catch {
      return fail(REASON.artifact_winner_candidate_unavailable);
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== candidate.patchRef.bytes || sha256(bytes) !== candidate.patchRef.sha256) {
      return fail(REASON.artifact_winner_candidate_mismatch);
    }
    return writePreparedArtifact(state, {
      identity: { artifactKind: 'winner', candidateId: object.candidateId },
      bytes: Buffer.from(bytes),
    });
  });
}
