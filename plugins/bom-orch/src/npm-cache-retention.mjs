import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { withLock } from './lockfile.mjs';
import { defaultGetStartTime } from './process-identity.mjs';
import { canonical } from './real-path.mjs';
import { syncDirectory, writeFileAtomic } from './util/fs-atomic.mjs';
import { contained, samePath } from './util/paths.mjs';
import { parseStrictJson } from './util/strict-json.mjs';

export const NPM_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const NPM_CACHE_SCHEMA_VERSION = 1;
export const NPM_CACHE_PROBE_BUDGET_MS = 8_000;
export const NPM_CACHE_PROBE_CONCURRENCY = 4;

const CACHE_KIND = 'bom-orch-npm-cache';
const MARKER_FILE = '.bom-orch-owner.json';
const STATE_FILE = '.bom-orch-state.json';
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_QUARANTINE_SCAN_ENTRIES = 64;

let tempCounter = 0;
let quarantineCounter = 0;

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const identityOf = (entry) => ({
  dev: String(entry.dev),
  ino: String(entry.ino),
  birthtimeMs: String(entry.birthtimeMs),
});
const sameIdentity = (expected, actual) => expected !== null &&
  expected.dev === String(actual.dev) &&
  expected.ino === String(actual.ino) &&
  expected.birthtimeMs === String(actual.birthtimeMs);

function exactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

const hasIdentityCoordinates = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  ['dev', 'ino', 'birthtimeMs'].every((key) => typeof value[key] === 'string' && value[key] !== '');

function validIdentity(value) {
  return exactKeys(value, ['dev', 'ino', 'birthtimeMs']) && hasIdentityCoordinates(value);
}

function validLease(value) {
  return exactKeys(value, ['leaseId', 'pid', 'startTime', 'acquiredAt']) &&
    typeof value.leaseId === 'string' && /^[0-9a-f]{32}$/.test(value.leaseId) &&
    Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.startTime === 'string' && value.startTime !== '' &&
    Number.isSafeInteger(value.acquiredAt) && value.acquiredAt >= 0;
}

function validMarker(value) {
  return exactKeys(value, ['schemaVersion', 'kind', 'token']) &&
    value.schemaVersion === NPM_CACHE_SCHEMA_VERSION && value.kind === CACHE_KIND &&
    typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token);
}

function validState(value) {
  return exactKeys(value, [
    'schemaVersion', 'kind', 'token', 'identity', 'createdAt', 'lastUsedAt', 'expiresAt', 'leases',
  ]) && value.schemaVersion === NPM_CACHE_SCHEMA_VERSION && value.kind === CACHE_KIND &&
    typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token) && validIdentity(value.identity) &&
    Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 &&
    Number.isSafeInteger(value.lastUsedAt) && value.lastUsedAt >= value.createdAt &&
    Number.isSafeInteger(value.expiresAt) && value.expiresAt === value.lastUsedAt + NPM_CACHE_RETENTION_MS &&
    Array.isArray(value.leases) && value.leases.every(validLease) &&
    new Set(value.leases.map((lease) => lease.leaseId)).size === value.leases.length;
}

function validNow(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - NPM_CACHE_RETENTION_MS;
}

/** JSON.parse가 큰 양의 정수를 +Infinity로 반올림해도 JSON-safe 진단값을 남긴다. */
function jsonSafeSchemaVersion(value) {
  if (Number.isInteger(value)) return value;
  return value === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : null;
}

function randomHex(bytes, deps) {
  const source = typeof deps?.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  try {
    const value = source(bytes);
    return Buffer.isBuffer(value) && value.length === bytes ? value.toString('hex') : null;
  } catch {
    return null;
  }
}

async function rootsFor(stateRoot, deps) {
  if (typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot)) return null;
  const makeDirectory = typeof deps?.mkdir === 'function' ? deps.mkdir : mkdir;
  const canonicalPath = typeof deps?.canonicalPath === 'function' ? deps.canonicalPath : canonical;
  try {
    // 존재하는 최상위 조상부터 물리 경로를 먼저 편다. stateRoot가 정션이거나
    // 아직 없는 stateRoot의 조상이 정션이면, 그 대상에 cache/를 쓴 **뒤**에
    // 거부하는 기존 순서가 된다. 모든 mkdir 앞에 같은 좌표계 검증을 둔다.
    const requestedRoot = resolve(stateRoot);
    const beforeRoot = await canonicalPath(requestedRoot);
    if (typeof beforeRoot !== 'string' || !samePath(beforeRoot, requestedRoot)) return null;
    await makeDirectory(requestedRoot, { recursive: true, mode: 0o700 });
    const root = await canonicalPath(requestedRoot);
    if (typeof root !== 'string' || !samePath(root, requestedRoot)) return null;

    const cacheParent = join(root, 'cache');
    const beforeParent = await canonicalPath(cacheParent);
    if (typeof beforeParent !== 'string' || !samePath(beforeParent, resolve(cacheParent)) ||
        !contained(root, beforeParent)) return null;
    await makeDirectory(cacheParent, { recursive: true, mode: 0o700 });
    const parent = await canonicalPath(cacheParent);
    if (typeof parent !== 'string' || !samePath(parent, resolve(cacheParent)) || !contained(root, parent)) return null;
    return { root, parent, cacheDir: join(parent, 'npm'), lockPath: join(parent, 'npm.lock') };
  } catch {
    return null;
  }
}

async function writeExclusive(path, bytes, deps) {
  const openFile = typeof deps?.open === 'function' ? deps.open : open;
  const handle = await openFile(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
  await syncDirectory(dirname(path)).catch(() => {});
}

async function writeState(path, state, deps) {
  const bytes = jsonBytes(state);
  if (bytes.length > MAX_METADATA_BYTES) return { ok: false, status: 'state_too_large' };
  const tempPath = `${path}.${process.pid}.${tempCounter++}.${cryptoRandomBytes(6).toString('hex')}.tmp`;
  return writeFileAtomic(path, bytes, {
    tempPath,
    mode: 0o600,
    exclusive: true,
    syncDir: true,
    ...(deps?.atomicFs === undefined ? {} : { fs: deps.atomicFs }),
  });
}

async function currentProcessStartTime(pid, deps) {
  const getStartTime = typeof deps?.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime;
  try {
    const value = await getStartTime(pid);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

function publicHandle(roots, state, lease) {
  return Object.freeze({
    cacheDir: roots.cacheDir,
    lockPath: roots.lockPath,
    token: state.token,
    leaseId: lease.leaseId,
    pid: lease.pid,
    startTime: lease.startTime,
  });
}

const sameMetadataSnapshot = (left, right) => [
  'dev', 'ino', 'birthtimeMs', 'size', 'mtimeMs', 'ctimeMs',
].every((key) => String(left?.[key]) === String(right?.[key]));

async function readJsonFile(path, deps = {}) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'missing' } : { status: 'malformed_state' };
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_METADATA_BYTES)) {
    return { status: 'malformed_state' };
  }

  const openFile = typeof deps?.open === 'function' ? deps.open : open;
  let handle;
  let bytes;
  let readOk = false;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    handle = await openFile(path, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameMetadataSnapshot(before, opened) ||
        opened.size > BigInt(MAX_METADATA_BYTES)) throw new Error('metadata identity changed before read');

    const buffer = Buffer.allocUnsafe(MAX_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - length) {
        throw new Error('invalid metadata read length');
      }
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_METADATA_BYTES) throw new Error('metadata exceeded the byte limit');
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameMetadataSnapshot(opened, afterHandle) || !sameMetadataSnapshot(opened, afterPath) ||
        BigInt(length) !== opened.size) throw new Error('metadata identity changed during read');
    bytes = Buffer.from(buffer.subarray(0, length));
    readOk = true;
  } catch {
    readOk = false;
  }
  try {
    await handle?.close();
  } catch {
    readOk = false;
  }
  if (!readOk) return { status: 'malformed_state' };
  try {
    const parsed = parseStrictJson(bytes);
    if (!parsed.ok) return { status: 'malformed_state', bytes };
    return { status: 'parsed', value: parsed.value, bytes };
  } catch {
    return { status: 'malformed_state', bytes };
  }
}

async function inspectOwnedCache(cacheDir, deps = {}) {
  let entry;
  try {
    entry = await lstat(cacheDir, { bigint: true });
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unsafe_cache_path' };
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return { status: 'unsafe_cache_path' };
  const canonicalPath = typeof deps?.canonicalPath === 'function' ? deps.canonicalPath : canonical;
  const real = await canonicalPath(cacheDir);
  if (typeof real !== 'string' || !samePath(real, resolve(cacheDir))) return { status: 'unsafe_cache_path' };

  const [markerRead, stateRead] = await Promise.all([
    readJsonFile(join(cacheDir, MARKER_FILE), deps),
    readJsonFile(join(cacheDir, STATE_FILE), deps),
  ]);
  const ownershipProven = markerRead.status === 'parsed' && stateRead.status === 'parsed' &&
    markerRead.value?.kind === CACHE_KIND && stateRead.value?.kind === CACHE_KIND &&
    typeof markerRead.value?.token === 'string' && /^[0-9a-f]{64}$/.test(markerRead.value.token) &&
    markerRead.value.token === stateRead.value?.token && hasIdentityCoordinates(stateRead.value?.identity) &&
    sameIdentity(stateRead.value.identity, entry);
  for (const [file, loaded] of [[STATE_FILE, stateRead], [MARKER_FILE, markerRead]]) {
    const found = loaded.status === 'parsed' ? jsonSafeSchemaVersion(loaded.value?.schemaVersion) : null;
    if (Number.isInteger(found) && found > NPM_CACHE_SCHEMA_VERSION) {
      return {
        status: 'newer_schema',
        stateSchema: {
          file: `cache/npm/${file}`,
          status: 'newer',
          found,
          supported: NPM_CACHE_SCHEMA_VERSION,
        },
        entry,
        ownershipProven,
      };
    }
  }
  if ([markerRead, stateRead].some((loaded) =>
    loaded.status === 'parsed' && typeof loaded.value?.kind === 'string' && loaded.value.kind !== CACHE_KIND)) {
    return { status: 'foreign_cache' };
  }
  if (markerRead.status === 'missing' && stateRead.status === 'missing') {
    return { status: 'legacy', entry };
  }
  if (markerRead.status !== 'parsed' || stateRead.status !== 'parsed') return { status: 'malformed_state' };
  if (!validMarker(markerRead.value) || !validState(stateRead.value)) return { status: 'malformed_state' };
  if (markerRead.value.token !== stateRead.value.token) return { status: 'owner_mismatch' };
  if (!sameIdentity(stateRead.value.identity, entry)) return { status: 'identity_mismatch' };
  return { status: 'current', marker: markerRead.value, state: stateRead.value, entry };
}

const inspectionFailure = (inspected) => ({
  ok: false,
  status: inspected.status,
  ...(inspected.stateSchema === undefined ? {} : { stateSchema: inspected.stateSchema }),
});

const stateWriteStatus = (written) =>
  typeof written?.status === 'string' && written.status !== '' ? written.status : 'state_write_failed';

/** npm spawn 전에 캐시 소유권을 검증하고 활성 lease를 디스크에 기록한다. */
export async function acquireNpmCacheLease({ stateRoot, nowMs = Date.now(), pid = process.pid } = {}, deps = {}) {
  if (!validNow(nowMs) || !Number.isInteger(pid) || pid <= 0) return { ok: false, status: 'invalid_input' };
  const roots = await rootsFor(stateRoot, deps);
  if (roots === null) return { ok: false, status: 'unsafe_cache_path' };
  const startTime = await currentProcessStartTime(pid, deps);
  if (startTime === null) return { ok: false, status: 'process_identity_unknown' };
  const token = randomHex(32, deps);
  const leaseId = randomHex(16, deps);
  if (token === null || leaseId === null) return { ok: false, status: 'randomness_unavailable' };

  const locked = await withLock(roots.lockPath, async () => {
    let existing;
    try {
      existing = await lstat(roots.cacheDir, { bigint: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, status: 'unsafe_cache_path' };
    }
    if (existing !== undefined) {
      const inspected = await inspectOwnedCache(roots.cacheDir, deps);
      const lease = { leaseId, pid, startTime, acquiredAt: nowMs };
      if (inspected.status === 'legacy') {
        const marker = { schemaVersion: NPM_CACHE_SCHEMA_VERSION, kind: CACHE_KIND, token };
        await writeExclusive(join(roots.cacheDir, MARKER_FILE), jsonBytes(marker), deps);
        const state = {
          schemaVersion: NPM_CACHE_SCHEMA_VERSION,
          kind: CACHE_KIND,
          token,
          identity: identityOf(inspected.entry),
          createdAt: nowMs,
          lastUsedAt: nowMs,
          expiresAt: nowMs + NPM_CACHE_RETENTION_MS,
          leases: [lease],
        };
        const written = await writeState(join(roots.cacheDir, STATE_FILE), state, deps);
        if (!written.ok) return { ok: false, status: stateWriteStatus(written) };
        return {
          ok: true,
          status: 'leased',
          cacheDir: roots.cacheDir,
          claimedLegacy: true,
          handle: publicHandle(roots, state, lease),
        };
      }
      if (inspected.status !== 'current') return inspectionFailure(inspected);
      const next = { ...inspected.state, leases: [...inspected.state.leases, lease] };
      const written = await writeState(join(roots.cacheDir, STATE_FILE), next, deps);
      if (!written.ok) return { ok: false, status: stateWriteStatus(written) };
      return {
        ok: true,
        status: 'leased',
        cacheDir: roots.cacheDir,
        claimedLegacy: false,
        handle: publicHandle(roots, next, lease),
      };
    }

    const makeDirectory = typeof deps?.mkdir === 'function' ? deps.mkdir : mkdir;
    await makeDirectory(roots.cacheDir, { mode: 0o700 });
    const entry = await lstat(roots.cacheDir, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) return { ok: false, status: 'unsafe_cache_path' };
    const real = await (typeof deps?.canonicalPath === 'function' ? deps.canonicalPath : canonical)(roots.cacheDir);
    if (typeof real !== 'string' || !samePath(real, roots.cacheDir) || !contained(roots.parent, real)) {
      return { ok: false, status: 'unsafe_cache_path' };
    }

    const marker = { schemaVersion: NPM_CACHE_SCHEMA_VERSION, kind: CACHE_KIND, token };
    await writeExclusive(join(roots.cacheDir, MARKER_FILE), jsonBytes(marker), deps);
    const lease = { leaseId, pid, startTime, acquiredAt: nowMs };
    const state = {
      schemaVersion: NPM_CACHE_SCHEMA_VERSION,
      kind: CACHE_KIND,
      token,
      identity: identityOf(entry),
      createdAt: nowMs,
      lastUsedAt: nowMs,
      expiresAt: nowMs + NPM_CACHE_RETENTION_MS,
      leases: [lease],
    };
    const written = await writeState(join(roots.cacheDir, STATE_FILE), state, deps);
    if (!written.ok) return { ok: false, status: stateWriteStatus(written) };
    return {
      ok: true,
      status: 'leased',
      cacheDir: roots.cacheDir,
      claimedLegacy: false,
      handle: publicHandle(roots, state, lease),
    };
  });
  if (!locked.ok) return { ok: false, status: 'lock_failed', reasonCode: locked.reasonCode };
  return locked.value;
}

/** npm 종료 뒤 lease를 내리고 idle TTL을 그 시각부터 다시 센다. */
export async function releaseNpmCacheLease(handle, { nowMs = Date.now() } = {}, deps = {}) {
  if (!validNow(nowMs) || handle === null || typeof handle !== 'object' ||
      typeof handle.cacheDir !== 'string' || basename(handle.cacheDir) !== 'npm' ||
      typeof handle.lockPath !== 'string' || !samePath(handle.lockPath, join(dirname(handle.cacheDir), 'npm.lock')) ||
      typeof handle.token !== 'string' || !/^[0-9a-f]{64}$/.test(handle.token) ||
      typeof handle.leaseId !== 'string' || !/^[0-9a-f]{32}$/.test(handle.leaseId) ||
      !Number.isInteger(handle.pid) || handle.pid <= 0 ||
      typeof handle.startTime !== 'string' || handle.startTime === '') return { ok: false, status: 'invalid_input' };

  const locked = await withLock(handle.lockPath, async () => {
    const inspected = await inspectOwnedCache(handle.cacheDir, deps);
    if (inspected.status !== 'current') return inspectionFailure(inspected);
    if (inspected.state.token !== handle.token) return { ok: false, status: 'owner_mismatch' };
    const matches = inspected.state.leases.filter((lease) =>
      lease.leaseId === handle.leaseId && lease.pid === handle.pid && lease.startTime === handle.startTime);
    if (matches.length !== 1) return { ok: false, status: 'lease_missing' };
    const usedAt = Math.max(inspected.state.lastUsedAt, nowMs);
    const next = {
      ...inspected.state,
      lastUsedAt: usedAt,
      expiresAt: usedAt + NPM_CACHE_RETENTION_MS,
      leases: inspected.state.leases.filter((lease) => lease.leaseId !== handle.leaseId),
    };
    const written = await writeState(join(handle.cacheDir, STATE_FILE), next, deps);
    return written.ok ? { ok: true, status: 'released' } : { ok: false, status: stateWriteStatus(written) };
  });
  if (!locked.ok) return { ok: false, status: 'lock_failed', reasonCode: locked.reasonCode };
  return locked.value;
}

const sweepResult = (status, values = {}) => ({
  status,
  checked: values.checked ?? 0,
  removed: values.removed ?? 0,
  preserved: values.preserved ?? 0,
  claimed: values.claimed ?? 0,
  ...(values.stateSchema === undefined ? {} : { stateSchema: values.stateSchema }),
});

function remainingDeadlineMs(deadlineAt, clock) {
  if (deadlineAt === undefined) return null;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || typeof clock !== 'function') return 0;
  try {
    const observed = clock();
    if (!Number.isSafeInteger(observed) || observed < 0 || observed >= deadlineAt) return 0;
    return deadlineAt - observed;
  } catch {
    return 0;
  }
}

function probeBudgetMs(deadlineAt, clock) {
  const remaining = remainingDeadlineMs(deadlineAt, clock);
  return remaining === null ? NPM_CACHE_PROBE_BUDGET_MS : Math.min(NPM_CACHE_PROBE_BUDGET_MS, remaining);
}

const deadlineExpired = (deadlineAt, deps) =>
  remainingDeadlineMs(deadlineAt, deps?.clock) === 0;
const deadlinePreserved = () => sweepResult('owner_unknown', { checked: 1, preserved: 1 });
const SWEEP_LOCK_DEADLINE = Symbol('sweep-lock-deadline');

async function withSweepLock(lockPath, work, deps, deadlineAt) {
  const remaining = remainingDeadlineMs(deadlineAt, deps?.clock);
  if (remaining === 0) return null;
  const lock = typeof deps?.withLock === 'function' ? deps.withLock : withLock;
  try {
    const locked = await lock(
      lockPath,
      async () => deadlineExpired(deadlineAt, deps) ? SWEEP_LOCK_DEADLINE : work(),
      remaining === null ? undefined : { timeoutMs: remaining },
    );
    return locked?.ok && locked.value === SWEEP_LOCK_DEADLINE ? null : locked;
  } catch {
    return { ok: false };
  }
}

async function classifyLeases(leases, getStartTime, deps = {}, deadlineAt) {
  if (leases.length === 0) return { status: 'idle' };
  if (typeof getStartTime !== 'function') return { status: 'unknown' };
  const probeBudget = probeBudgetMs(deadlineAt, deps?.clock);
  if (probeBudget === 0) return { status: 'unknown' };
  const setTimer = typeof deps?.setTimeout === 'function' ? deps.setTimeout : setTimeout;
  const clearTimer = typeof deps?.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
  let next = 0;
  let liveCount = 0;
  let unknown = false;
  let expired = false;
  const probeAuthority = deadlineAt === undefined ? undefined : { deadlineAt, clock: deps?.clock };
  const worker = async () => {
    while (!expired && !unknown) {
      const index = next;
      next += 1;
      if (index >= leases.length) return;
      const lease = leases[index];
      let live;
      try {
        live = await getStartTime(lease.pid, probeAuthority);
      } catch {
        unknown = true;
        return;
      }
      if (live === undefined || (live !== null && (typeof live !== 'string' || live === ''))) {
        unknown = true;
        return;
      }
      if (live === lease.startTime) liveCount += 1;
      // null 또는 같은 pid의 다른 startTime만 crash 증명이다. 그 밖의 값을 죽음으로 접지 않는다.
    }
  };

  // metadata 크기 상한 안에도 lease는 수백 개가 들어간다. OS probe의 8초 상한을
  // 순차로 더하면 startup이 수십 분 막히므로, 공용 startup deadline의 남은 시간과
  // 제한 병렬성을 함께 묶는다. 예산 소진은 죽음의 증거가 아니므로 항상 unknown이다.
  const work = Promise.all(Array.from(
    { length: Math.min(NPM_CACHE_PROBE_CONCURRENCY, leases.length) },
    () => worker(),
  )).then(() => ({ source: 'work' }));
  let timer = null;
  const budget = new Promise((resolveBudget) => {
    try {
      timer = setTimer(() => {
        expired = true;
        resolveBudget({ source: 'budget' });
      }, probeBudget);
    } catch {
      expired = true;
      resolveBudget({ source: 'budget' });
    }
  });
  const settled = await Promise.race([work, budget]);
  if (settled.source === 'work' && timer !== null) {
    try { clearTimer(timer); } catch { /* 이미 끝난 타이머의 정리는 판정을 바꾸지 않는다. */ }
  }
  if (settled.source === 'budget' || unknown || probeBudgetMs(deadlineAt, deps?.clock) === 0) {
    return { status: 'unknown' };
  }
  return liveCount > 0 ? { status: 'active' } : { status: 'crashed' };
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nextQuarantinePath(parent) {
  try {
    return join(
      parent,
      `.npm-reap-${process.pid}-${Date.now()}-${quarantineCounter++}-${cryptoRandomBytes(8).toString('hex')}`,
    );
  } catch {
    return null;
  }
}

async function inspectQuarantineRoot(roots, quarantineRoot, deps = {}) {
  const expected = resolve(quarantineRoot);
  if (!samePath(dirname(expected), roots.parent) || !basename(expected).startsWith('.npm-reap-')) return null;

  let rootEntry;
  try {
    rootEntry = await lstat(expected, { bigint: true });
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return null;
    const canonicalPath = typeof deps?.canonicalPath === 'function' ? deps.canonicalPath : canonical;
    const real = await canonicalPath(expected);
    if (typeof real !== 'string' || !samePath(real, expected) || !contained(roots.parent, real)) return null;
  } catch {
    return null;
  }

  const openDirectory = typeof deps?.opendir === 'function' ? deps.opendir : opendir;
  let count = 0;
  let onlyName = null;
  try {
    const directory = await openDirectory(expected);
    for await (const entry of directory) {
      count += 1;
      if (count > 1) return null;
      onlyName = entry.name;
    }
  } catch {
    return null;
  }
  if (count !== 1 || onlyName !== 'npm') return null;

  const cache = await inspectOwnedCache(join(expected, 'npm'), deps);
  if (cache.status === 'newer_schema') {
    return cache.ownershipProven ? { status: 'newer_schema', stateSchema: cache.stateSchema } : null;
  }
  if (cache.status !== 'current') return null;
  return {
    status: 'current',
    path: expected,
    rootIdentity: identityOf(rootEntry),
    cacheIdentity: identityOf(cache.entry),
    state: cache.state,
  };
}

function sameQuarantine(expected, actual, comparePath = true) {
  return expected?.status === 'current' && actual?.status === 'current' &&
    (!comparePath || samePath(expected.path, actual.path)) &&
    sameIdentity(expected.rootIdentity, actual.rootIdentity) &&
    sameIdentity(expected.cacheIdentity, actual.cacheIdentity) &&
    expected.state.token === actual.state.token && sameState(expected.state, actual.state);
}

const quarantineSchemaResult = (inspected) => inspected?.status === 'newer_schema'
  ? sweepResult('newer_schema', { checked: 1, preserved: 1, stateSchema: inspected.stateSchema })
  : null;

async function findRecoverableQuarantine(roots, deps) {
  const openDirectory = typeof deps?.opendir === 'function' ? deps.opendir : opendir;
  try {
    const directory = await openDirectory(roots.parent);
    let scanned = 0;
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAX_QUARANTINE_SCAN_ENTRIES) return null;
      if (typeof entry.name !== 'string' || !entry.name.startsWith('.npm-reap-')) continue;
      const inspected = await inspectQuarantineRoot(roots, join(roots.parent, entry.name), deps);
      if (inspected !== null) return inspected;
    }
  } catch {
    return null;
  }
  return null;
}

async function clearCrashedLeases(cacheDir, inspected, deps) {
  if (inspected.state.leases.length === 0) return inspected;
  const nextState = { ...inspected.state, leases: [] };
  const written = await writeState(join(cacheDir, STATE_FILE), nextState, deps);
  if (!written.ok) return sweepResult(stateWriteStatus(written), { checked: 1, preserved: 1 });
  const confirmed = await inspectOwnedCache(cacheDir, deps);
  if (confirmed.status !== 'current' || confirmed.state.token !== inspected.state.token ||
      !sameIdentity(identityOf(inspected.entry), confirmed.entry) || !sameState(confirmed.state, nextState)) {
    return sweepResult(confirmed.status === 'current' ? 'changed' : confirmed.status, {
      checked: 1,
      preserved: 1,
      stateSchema: confirmed.stateSchema,
    });
  }
  return confirmed;
}

async function prepareCurrentSweep(roots, inspected, nowMs, deps, clearCrashed, deadlineAt) {
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  let current = inspected;
  if (clearCrashed) {
    const cleared = await clearCrashedLeases(roots.cacheDir, current, deps);
    if (cleared.status !== 'current') return cleared;
    current = cleared;
  }
  if (nowMs < current.state.expiresAt) {
    return sweepResult('retained', { checked: 1, preserved: 1 });
  }
  // 삭제 직전에 같은 lock 안에서 marker와 directory identity를 다시 읽는다. 내부 항목은
  // 전혀 열거하지 않는다 — 권한 단위는 오직 이 cache root 전체다.
  const confirmed = await inspectOwnedCache(roots.cacheDir, deps);
  if (confirmed.status !== 'current' || confirmed.state.token !== current.state.token ||
      !sameIdentity(identityOf(current.entry), confirmed.entry) || !sameState(confirmed.state, current.state)) {
    return sweepResult(confirmed.status === 'current' ? 'owner_mismatch' : confirmed.status, {
      checked: 1,
      preserved: 1,
      stateSchema: confirmed.stateSchema,
    });
  }
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();

  // 재귀 삭제는 시간 상한이 없다. cache 이름에서 곧바로 rm하면 이 lock의 60초
  // stale 경계를 넘긴 사이 다른 획득자가 lock을 탈취해 같은 경로에 새 cache를 쓰고,
  // 기존 rm이 그 새 바이트까지 훑을 수 있다. lock 안에서는 이름을 비우는 rename만 하고
  // 물리 identity와 owner state를 이동한 자리에서 다시 증명한 뒤, 실제 삭제는 lock 밖에서 한다.
  let quarantineRoot;
  let moved = false;
  try {
    quarantineRoot = nextQuarantinePath(roots.parent);
    if (quarantineRoot === null) throw new Error('quarantine path unavailable');
    const makeDirectory = typeof deps?.mkdir === 'function' ? deps.mkdir : mkdir;
    await makeDirectory(quarantineRoot, { mode: 0o700 });
    if (deadlineExpired(deadlineAt, deps)) {
      await rmdir(quarantineRoot).catch(() => {});
      return deadlinePreserved();
    }
    const move = typeof deps?.rename === 'function' ? deps.rename : rename;
    await move(roots.cacheDir, join(quarantineRoot, 'npm'));
    moved = true;
  } catch {
    // rename이 실패한 정상 경로의 방은 비어 있다. 빈 디렉터리 한 개만 지우는
    // rmdir은 recursive rm과 달리 시간·범위가 유한하며, 이동 효과가 불명하면 실패해 보존한다.
    if (!moved && typeof quarantineRoot === 'string') await rmdir(quarantineRoot).catch(() => {});
    return sweepResult('delete_failed', { checked: 1, preserved: 1 });
  }

  const quarantined = await inspectQuarantineRoot(roots, quarantineRoot, deps);
  const newerSchema = quarantineSchemaResult(quarantined);
  if (newerSchema !== null) return newerSchema;
  if (quarantined === null || !sameIdentity(confirmed.state.identity, quarantined.cacheIdentity) ||
      quarantined.state.token !== confirmed.state.token || !sameState(quarantined.state, confirmed.state)) {
    // 검증한 inode 대신 교체물이 rename됐다면 quarantine에 보존한다. 이 경로에서
    // recursive delete를 한 번이라도 호출하면 소유하지 않은 바이트를 지울 수 있다.
    return sweepResult('identity_mismatch', { checked: 1, preserved: 1 });
  }
  return { deleteQuarantine: quarantined };
}

async function deletePreparedQuarantine(roots, prepared, deps, deadlineAt) {
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  const confirmed = await inspectQuarantineRoot(roots, prepared.path, deps);
  const newerSchema = quarantineSchemaResult(confirmed);
  if (newerSchema !== null) return newerSchema;
  if (!sameQuarantine(prepared, confirmed)) {
    return sweepResult('identity_mismatch', { checked: 1, preserved: 1 });
  }
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  try {
    if (typeof deps?.beforeDelete === 'function') await deps.beforeDelete(prepared.path);
  } catch {
    return sweepResult('delete_failed', { checked: 1, preserved: 1 });
  }
  const final = await inspectQuarantineRoot(roots, prepared.path, deps);
  const finalSchema = quarantineSchemaResult(final);
  if (finalSchema !== null) return finalSchema;
  if (!sameQuarantine(prepared, final)) {
    return sweepResult('identity_mismatch', { checked: 1, preserved: 1 });
  }
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  const remove = typeof deps?.rm === 'function' ? deps.rm : rm;
  try {
    await remove(prepared.path, { recursive: true, force: false });
  } catch {
    return sweepResult('delete_failed', { checked: 1, preserved: 1 });
  }
  const remains = await lstat(prepared.path).then(() => true, (error) => error?.code !== 'ENOENT');
  return remains
    ? sweepResult('delete_failed', { checked: 1, preserved: 1 })
    : sweepResult('removed', { checked: 1, removed: 1 });
}

async function prepareRecoveredQuarantine(roots, snapshot, nowMs, deps, clearCrashed, deadlineAt) {
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  let confirmed = await inspectQuarantineRoot(roots, snapshot.path, deps);
  let newerSchema = quarantineSchemaResult(confirmed);
  if (newerSchema !== null) return newerSchema;
  if (!sameQuarantine(snapshot, confirmed)) {
    return sweepResult('changed', { checked: 1, preserved: 1 });
  }
  if (nowMs < confirmed.state.expiresAt) {
    return sweepResult('retained', { checked: 1, preserved: 1 });
  }

  if (clearCrashed && confirmed.state.leases.length > 0) {
    if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
    const nextState = { ...confirmed.state, leases: [] };
    const written = await writeState(join(confirmed.path, 'npm', STATE_FILE), nextState, deps);
    if (!written.ok) return sweepResult(stateWriteStatus(written), { checked: 1, preserved: 1 });
    const cleared = await inspectQuarantineRoot(roots, confirmed.path, deps);
    newerSchema = quarantineSchemaResult(cleared);
    if (newerSchema !== null) return newerSchema;
    if (!sameQuarantine({ ...confirmed, state: nextState }, cleared)) {
      return sweepResult('changed', { checked: 1, preserved: 1 });
    }
    confirmed = cleared;
  }

  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  const destination = nextQuarantinePath(roots.parent);
  if (destination === null) return sweepResult('delete_failed', { checked: 1, preserved: 1 });
  const move = typeof deps?.rename === 'function' ? deps.rename : rename;
  try {
    await move(confirmed.path, destination);
    await syncDirectory(roots.parent).catch(() => {});
  } catch {
    return sweepResult('delete_failed', { checked: 1, preserved: 1 });
  }
  const moved = await inspectQuarantineRoot(roots, destination, deps);
  newerSchema = quarantineSchemaResult(moved);
  if (newerSchema !== null) return newerSchema;
  if (!sameQuarantine(confirmed, moved, false)) {
    return sweepResult('identity_mismatch', { checked: 1, preserved: 1 });
  }
  return { deleteQuarantine: moved };
}

async function recoverOwnedQuarantine(roots, nowMs, deps, deadlineAt) {
  const snapshot = await findRecoverableQuarantine(roots, deps);
  if (snapshot === null) return null;
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  const newerSchema = quarantineSchemaResult(snapshot);
  if (newerSchema !== null) return newerSchema;
  if (nowMs < snapshot.state.expiresAt) {
    return sweepResult('retained', { checked: 1, preserved: 1 });
  }

  let clearCrashed = false;
  if (snapshot.state.leases.length > 0) {
    const leases = await classifyLeases(
      snapshot.state.leases,
      typeof deps?.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime,
      deps,
      deadlineAt,
    );
    if (leases.status === 'unknown') return sweepResult('owner_unknown', { checked: 1, preserved: 1 });
    if (leases.status === 'active') return sweepResult('active', { checked: 1, preserved: 1 });
    clearCrashed = true;
  }

  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  const committed = await withSweepLock(
    roots.lockPath,
    () => prepareRecoveredQuarantine(roots, snapshot, nowMs, deps, clearCrashed, deadlineAt),
    deps,
    deadlineAt,
  );
  if (committed === null) return deadlinePreserved();
  if (!committed?.ok) return sweepResult('lock_failed', { checked: 1, preserved: 1 });
  return committed.value?.deleteQuarantine === undefined
    ? committed.value
    : deletePreparedQuarantine(roots, committed.value.deleteQuarantine, deps, deadlineAt);
}

async function claimLegacyForSweep(roots, inspected, nowMs, deps, deadlineAt) {
  if (deadlineExpired(deadlineAt, deps)) return deadlinePreserved();
  const token = randomHex(32, deps);
  if (token === null) return sweepResult('randomness_unavailable', { checked: 1, preserved: 1 });
  const marker = { schemaVersion: NPM_CACHE_SCHEMA_VERSION, kind: CACHE_KIND, token };
  await writeExclusive(join(roots.cacheDir, MARKER_FILE), jsonBytes(marker), deps);
  const state = {
    schemaVersion: NPM_CACHE_SCHEMA_VERSION,
    kind: CACHE_KIND,
    token,
    identity: identityOf(inspected.entry),
    createdAt: nowMs,
    lastUsedAt: nowMs,
    expiresAt: nowMs + NPM_CACHE_RETENTION_MS,
    leases: [],
  };
  const written = await writeState(join(roots.cacheDir, STATE_FILE), state, deps);
  return written.ok
    ? sweepResult('claimed_legacy', { checked: 1, preserved: 1, claimed: 1 })
    : sweepResult(stateWriteStatus(written), { checked: 1, preserved: 1 });
}

/** 부팅·실행 시작에서 호출할 cache/npm 단위 스윕. 내부 항목을 부분 삭제하지 않는다. */
export async function sweepNpmCache({ stateRoot, nowMs = Date.now(), deadlineAt } = {}, deps = {}) {
  if (!validNow(nowMs) || (deadlineAt !== undefined &&
      (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || typeof deps?.clock !== 'function'))) {
    return sweepResult('invalid_input');
  }
  if (deadlineExpired(deadlineAt, deps)) return sweepResult('owner_unknown');
  const roots = await rootsFor(stateRoot, deps);
  if (roots === null) return sweepResult('unsafe_cache_path');
  if (deadlineExpired(deadlineAt, deps)) return sweepResult('owner_unknown');
  const recovered = await recoverOwnedQuarantine(roots, nowMs, deps, deadlineAt);
  if (recovered !== null) return recovered;
  if (deadlineExpired(deadlineAt, deps)) return sweepResult('owner_unknown');
  const snapshot = await withSweepLock(roots.lockPath, async () => {
    const inspected = await inspectOwnedCache(roots.cacheDir, deps);
    if (inspected.status === 'missing') return sweepResult('absent');
    if (inspected.status === 'current') {
      return inspected.state.leases.length === 0
        ? prepareCurrentSweep(roots, inspected, nowMs, deps, false, deadlineAt)
        : { deferredLeaseState: inspected.state };
    }
    if (inspected.status !== 'legacy') {
      return sweepResult(inspected.status, {
        checked: 1,
        preserved: 1,
        stateSchema: inspected.stateSchema,
      });
    }
    return claimLegacyForSweep(roots, inspected, nowMs, deps, deadlineAt);
  }, deps, deadlineAt);
  if (snapshot === null) return deadlinePreserved();
  if (!snapshot?.ok) return sweepResult('lock_failed', { preserved: 1 });
  if (snapshot.value?.deleteQuarantine !== undefined) {
    return deletePreparedQuarantine(roots, snapshot.value.deleteQuarantine, deps, deadlineAt);
  }
  if (snapshot.value?.deferredLeaseState === undefined) return snapshot.value;

  // OS 프로브는 느리거나 걸릴 수 있다. lock 안에서 실행하면 살아 있는 lock이 stale로 탈취된다.
  const leases = await classifyLeases(
    snapshot.value.deferredLeaseState.leases,
    typeof deps?.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime,
    deps,
    deadlineAt,
  );
  if (leases.status === 'unknown') return sweepResult('owner_unknown', { checked: 1, preserved: 1 });
  if (leases.status === 'active') return sweepResult('active', { checked: 1, preserved: 1 });

  const committed = await withSweepLock(roots.lockPath, async () => {
    const inspected = await inspectOwnedCache(roots.cacheDir, deps);
    if (inspected.status !== 'current') {
      return sweepResult(inspected.status, {
        checked: 1,
        preserved: 1,
        stateSchema: inspected.stateSchema,
      });
    }
    if (!sameState(inspected.state, snapshot.value.deferredLeaseState)) {
      return sweepResult('changed', { checked: 1, preserved: 1 });
    }
    return prepareCurrentSweep(roots, inspected, nowMs, deps, true, deadlineAt);
  }, deps, deadlineAt);
  if (committed === null) return deadlinePreserved();
  if (!committed?.ok) return sweepResult('lock_failed', { checked: 1, preserved: 1 });
  return committed.value?.deleteQuarantine !== undefined
    ? deletePreparedQuarantine(roots, committed.value.deleteQuarantine, deps, deadlineAt)
    : committed.value;
}
