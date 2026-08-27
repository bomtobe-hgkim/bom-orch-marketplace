import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { withLock } from './lockfile.mjs';
import { defaultGetStartTime } from './process-identity.mjs';
import { canonical } from './real-path.mjs';
import { syncDirectory, writeFileAtomic } from './util/fs-atomic.mjs';
import { contained, samePath } from './util/paths.mjs';
import { parseStrictJson } from './util/strict-json.mjs';

/** 중단된 일회용 scratch가 정상 실행과 겹치지 않는 기존 보존 경계. */
export const SCRATCH_ROOM_RETENTION_MS = 6 * 60 * 60 * 1000;
/** startup CallTool gate가 expired sidecar 수 × OS probe 상한으로 늘어나지 않게 하는 총 예산. */
export const SCRATCH_ROOM_SWEEP_BUDGET_MS = 60_000;
export const SCRATCH_ROOM_SCHEMA_VERSION = 1;

const REGISTRY = '.rooms';
const OWNER_FILE = 'owner.json';
const RECORD_PATTERN = /^([0-9a-f]{32})\.json$/;
const MAX_RECORD_BYTES = 16 * 1024;
const KINDS = Object.freeze({
  diff: 'diff',
  repository_apply: 'apply',
  worktree_apply: 'apply',
});
const DISPOSITIONS = new Set(['disposable', 'recovery_armed', 'retained_manual']);
const STATUSES = new Set(['reserved', 'active']);

let tempCounter = 0;

const emptySweep = () => ({ checked: 0, removed: 0, preserved: 0, newer: 0 });
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

function validNow(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - SCRATCH_ROOM_RETENTION_MS;
}

function validRecord(value, expectedId = null) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== SCRATCH_ROOM_SCHEMA_VERSION || !RECORD_PATTERN.test(`${value.roomId}.json`)) return false;
  if (expectedId !== null && value.roomId !== expectedId) return false;
  if (!Object.hasOwn(KINDS, value.kind) || value.name !== `${KINDS[value.kind]}-${value.roomId}`) return false;
  if (!DISPOSITIONS.has(value.disposition) || !STATUSES.has(value.status)) return false;
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return false;
  if (value.disposition === 'disposable') {
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt !== value.createdAt + SCRATCH_ROOM_RETENTION_MS) return false;
  } else if (value.expiresAt !== null) return false;
  if (!Number.isInteger(value.ownerPid) || value.ownerPid <= 0) return false;
  if (value.ownerStartTime !== null && (typeof value.ownerStartTime !== 'string' || value.ownerStartTime === '')) return false;
  if (typeof value.token !== 'string' || !/^[0-9a-f]{64}$/.test(value.token)) return false;
  if (value.status === 'reserved' && value.identity !== null) return false;
  if (value.status === 'active' && (
    value.identity === null || typeof value.identity !== 'object' ||
    !['dev', 'ino', 'birthtimeMs'].every((key) => typeof value.identity[key] === 'string' && value.identity[key] !== '')
  )) return false;
  return true;
}

async function callPhase(deps, name) {
  if (typeof deps?.onPhase === 'function') await deps.onPhase(name);
}

function randomHex(bytes, deps) {
  const source = typeof deps?.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  const value = source(bytes);
  if (!Buffer.isBuffer(value) || value.length !== bytes) throw new Error('scratch room randomness was unavailable');
  return value.toString('hex');
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
  await syncDirectory(dirname(path)).catch(() => {});
}

async function writeRecord(path, record) {
  const tempPath = `${path}.${process.pid}.${tempCounter++}.${cryptoRandomBytes(8).toString('hex')}.tmp`;
  return writeFileAtomic(path, jsonBytes(record), {
    tempPath,
    mode: 0o600,
    exclusive: true,
    syncDir: true,
  });
}

async function readBoundedJson(path) {
  let before;
  let handle;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_RECORD_BYTES)) {
      return { status: 'invalid' };
    }
    const flags = fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    handle = await open(path, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(identityOf(before), opened) || opened.size > BigInt(MAX_RECORD_BYTES)) {
      return { status: 'invalid' };
    }
    const buffer = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_RECORD_BYTES) return { status: 'invalid' };
    const bytes = Buffer.from(buffer.subarray(0, length));
    const document = parseStrictJson(bytes);
    return document.ok
      ? { status: 'parsed', value: document.value, bytes }
      : { status: 'invalid', bytes };
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readRecord(path, expectedId = null) {
  const loaded = await readBoundedJson(path);
  if (loaded.status !== 'parsed') return loaded;
  const { bytes, value } = loaded;
  if (Number.isInteger(value?.schemaVersion) && value.schemaVersion > SCRATCH_ROOM_SCHEMA_VERSION) {
    return { status: 'newer', bytes, found: value.schemaVersion };
  }
  return validRecord(value, expectedId)
    ? { status: 'current', record: value, bytes }
    : { status: 'invalid', bytes };
}

async function ensurePlainDirectory(path) {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

async function rootsFor(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot)) return null;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const realRoot = await canonical(stateRoot);
  if (realRoot === null) return null;
  // `recursive:true` 로 자식까지 한꺼번에 만들면 이미 있던 scratch junction을 따라가 그
  // 대상에 `.rooms`를 먼저 쓴 뒤에야 canonical 검사가 실패한다. 각 경계를 lstat하고 다음
  // 경계를 만들면, 아는 링크를 한 바이트도 따라가지 않은 채 닫힌다.
  const scratch = join(realRoot, 'scratch');
  let scratchEntry;
  try {
    scratchEntry = await lstat(scratch);
  } catch (error) {
    if (error?.code !== 'ENOENT' || !(await ensurePlainDirectory(scratch))) return null;
    scratchEntry = await lstat(scratch).catch(() => null);
  }
  if (scratchEntry === null || (!scratchEntry.isDirectory() && !scratchEntry.isSymbolicLink())) return null;
  const realScratch = await canonical(scratch);
  if (realScratch === null || !contained(realRoot, realScratch)) return null;
  const scratchTarget = await stat(realScratch).catch(() => null);
  if (scratchTarget === null || !scratchTarget.isDirectory() ||
      (!scratchEntry.isSymbolicLink() && !samePath(realScratch, scratch))) return null;
  const registry = join(realScratch, REGISTRY);
  if (!(await ensurePlainDirectory(registry))) return null;
  const realRegistry = await canonical(registry);
  if (realRoot === null || realScratch === null || realRegistry === null ||
      !contained(realScratch, realRegistry) || !samePath(realRegistry, registry)) return null;
  return { root: realRoot, scratch: realScratch, registry: realRegistry };
}

function publicHandle(roots, record) {
  return Object.freeze({
    roomId: record.roomId,
    token: record.token,
    kind: record.kind,
    name: record.name,
    path: join(roots.scratch, record.name),
    recordPath: join(roots.registry, `${record.roomId}.json`),
    lockPath: join(roots.registry, `${record.roomId}.lock`),
  });
}

/**
 * 삭제 권한 레코드를 먼저 fsync한 뒤 room을 만든다. 어느 phase에서 죽어도 표식 없는 이름을
 * 추측해서 지울 필요가 없다.
 */
export async function createScratchRoom(spec, deps = {}) {
  const stateRoot = spec?.stateRoot;
  const kind = spec?.kind;
  const nowMs = spec?.nowMs ?? Date.now();
  if (!Object.hasOwn(KINDS, kind) || !validNow(nowMs)) return { ok: false };
  let roots;
  let record;
  try {
    roots = await rootsFor(stateRoot);
    if (roots === null) return { ok: false };
    const roomId = randomHex(16, deps);
    const token = randomHex(32, deps);
    const ownerPid = Number.isInteger(spec?.ownerPid) && spec.ownerPid > 0 ? spec.ownerPid : process.pid;
    const getStartTime = typeof deps?.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime;
    const ownerStartTime = await getStartTime(ownerPid).catch(() => null);
    record = {
      schemaVersion: SCRATCH_ROOM_SCHEMA_VERSION,
      roomId,
      kind,
      name: `${KINDS[kind]}-${roomId}`,
      status: 'reserved',
      disposition: 'disposable',
      createdAt: nowMs,
      expiresAt: nowMs + SCRATCH_ROOM_RETENTION_MS,
      ownerPid,
      ownerStartTime: typeof ownerStartTime === 'string' && ownerStartTime !== '' ? ownerStartTime : null,
      runId: typeof spec?.runId === 'string' && spec.runId !== '' ? spec.runId : null,
      projectPath: typeof spec?.projectPath === 'string' && isAbsolute(spec.projectPath) ? spec.projectPath : null,
      token,
      identity: null,
    };
    const handle = publicHandle(roots, record);
    await writeExclusive(handle.recordPath, jsonBytes(record));
    await callPhase(deps, 'after-reservation');

    await mkdir(handle.path, { mode: 0o700 });
    await callPhase(deps, 'after-directory');
    await writeExclusive(join(handle.path, OWNER_FILE), jsonBytes({
      schemaVersion: SCRATCH_ROOM_SCHEMA_VERSION,
      roomId,
      token,
    }));
    await callPhase(deps, 'after-marker');

    const entry = await lstat(handle.path, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('scratch room is not an owned directory');
    const realRoom = await canonical(handle.path);
    if (realRoom === null || !contained(roots.scratch, realRoom) || !samePath(realRoom, handle.path)) {
      throw new Error('scratch room left its state root');
    }
    record = { ...record, status: 'active', identity: identityOf(entry) };
    const written = await writeRecord(handle.recordPath, record);
    if (!written.ok) throw new Error(written.reason);
    await callPhase(deps, 'after-active');
    return { ok: true, handle };
  } catch (error) {
    if (roots !== undefined && record !== undefined) {
      const handle = publicHandle(roots, record);
      return { ok: false, handle, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function transition(handle, disposition, nowMs) {
  if (!handle || typeof handle.recordPath !== 'string' || typeof handle.lockPath !== 'string' ||
      typeof handle.roomId !== 'string' || typeof handle.token !== 'string' || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return { ok: false };
  }
  const locked = await withLock(handle.lockPath, async () => {
    const loaded = await readRecord(handle.recordPath, handle.roomId);
    if (loaded.status !== 'current' || loaded.record.token !== handle.token) return { ok: false };
    const next = {
      ...loaded.record,
      disposition,
      expiresAt: null,
      ...(disposition === 'recovery_armed' ? { armedAt: nowMs } : { retainedAt: nowMs }),
    };
    const written = await writeRecord(handle.recordPath, next);
    return written.ok ? { ok: true } : { ok: false };
  });
  return locked.ok ? locked.value : { ok: false };
}

/** 사용자 저장소 write 직전의 내구성 경계. */
export function armScratchRoom(handle, { nowMs = Date.now() } = {}) {
  return transition(handle, 'recovery_armed', nowMs);
}

/** 자동 복구가 불완전한 방을 사용자 명시 정리 전까지 보존한다. */
export function retainScratchRoom(handle, { nowMs = Date.now() } = {}) {
  return transition(handle, 'retained_manual', nowMs);
}

async function ownerMarkerMatches(path, record, allowMissing) {
  const loaded = await readBoundedJson(join(path, OWNER_FILE));
  if (loaded.status !== 'parsed') return allowMissing && loaded.status === 'missing';
  const raw = loaded.value;
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
    raw.schemaVersion === SCRATCH_ROOM_SCHEMA_VERSION &&
    raw.roomId === record.roomId && raw.token === record.token;
}

const roomQuarantinePath = (scratch, record) =>
  join(scratch, `.reap-${record.roomId}-${record.token}`);

function authorityExpired(authority) {
  if (typeof authority?.expired !== 'function') return false;
  try {
    return authority.expired() !== false;
  } catch {
    return true;
  }
}

function authorityRemainingMs(authority) {
  if (typeof authority?.remainingMs !== 'function') return null;
  try {
    const value = authority.remainingMs();
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function inspectOwnedRoom(path, scratch, record, { allowMissing, expectedIdentity = null } = {}) {
  let entry;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? { ok: true, missing: true } : { ok: false };
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return { ok: false };
  const realRoom = await canonical(path);
  if (realRoom === null || !contained(scratch, realRoom) || !samePath(realRoom, path)) return { ok: false };
  if (record.status === 'active' && !sameIdentity(record.identity, entry)) return { ok: false };
  if (expectedIdentity !== null && !sameIdentity(expectedIdentity, entry)) return { ok: false };
  if (!(await ownerMarkerMatches(path, record, allowMissing))) return { ok: false };
  return { ok: true, missing: false, entry, identity: identityOf(entry) };
}

async function removeOwnedRoom(scratch, record, authority = {}) {
  const roomPath = join(scratch, record.name);
  const quarantinePath = roomQuarantinePath(scratch, record);
  const deps = authority?.deps ?? {};
  const move = typeof deps.rename === 'function' ? deps.rename : rename;
  const remove = typeof deps.rm === 'function' ? deps.rm : rm;
  let owned = await inspectOwnedRoom(roomPath, scratch, record, {
    allowMissing: record.status === 'reserved',
  });
  if (!owned.ok) return { ok: false };
  if (owned.missing) {
    owned = await inspectOwnedRoom(quarantinePath, scratch, record, {
      // active room만 이전 sweep의 quarantine을 identity로 다시 증명할 수 있다.
      allowMissing: false,
    });
    if (!owned.ok) return { ok: false };
    if (owned.missing) return { ok: true, removed: false };
  } else {
    const collision = await lstat(quarantinePath).then(() => true, (error) => error?.code !== 'ENOENT');
    if (collision || authorityExpired(authority)) return { ok: false };
    // marker 검사와 rename 사이에 원래 이름이 바뀌어도, 이동한 inode를 이 관측값으로 묶어
    // replacement는 quarantine에 보존하고 recursive rm 권위를 주지 않는다.
    const expectedIdentity = owned.identity;
    const confirmed = await inspectOwnedRoom(roomPath, scratch, record, {
      allowMissing: record.status === 'reserved', expectedIdentity,
    });
    if (!confirmed.ok || confirmed.missing || authorityExpired(authority)) return { ok: false };
    try {
      await move(roomPath, quarantinePath);
    } catch {
      const sourceMissing = await lstat(roomPath).then(() => false, (error) => error?.code === 'ENOENT');
      if (!sourceMissing) return { ok: false };
    }
    owned = await inspectOwnedRoom(quarantinePath, scratch, record, {
      allowMissing: record.status === 'reserved', expectedIdentity,
    });
    if (!owned.ok || owned.missing) return { ok: false };
  }
  if (authorityExpired(authority)) return { ok: false };
  await remove(quarantinePath, { recursive: true, force: true }).catch(() => {});
  const remains = await lstat(quarantinePath).then(() => true, (error) => error?.code !== 'ENOENT');
  return remains ? { ok: false } : { ok: true, removed: true };
}

async function closeRecord({ roots, recordPath, roomId, token, allowRetained, authority = {} }) {
  const lockPath = join(roots.registry, `${roomId}.lock`);
  if (authorityExpired(authority)) return { ok: false };
  const remainingMs = authorityRemainingMs(authority);
  if (remainingMs === 0) return { ok: false };
  const locked = await withLock(lockPath, async () => {
    if (authorityExpired(authority)) return { ok: false };
    const loaded = await readRecord(recordPath, roomId);
    if (loaded.status === 'missing') return { ok: true, removed: false };
    if (loaded.status !== 'current' || loaded.record.token !== token) return { ok: false };
    if (!allowRetained && loaded.record.disposition !== 'disposable') return { ok: false };
    const removed = await removeOwnedRoom(roots.scratch, loaded.record, authority);
    if (!removed.ok) return { ok: false };
    if (authorityExpired(authority)) return { ok: false };
    await rm(recordPath, { force: true }).catch(() => {});
    const recordRemains = await lstat(recordPath).then(() => true, (error) => error?.code !== 'ENOENT');
    return recordRemains ? { ok: false } : { ok: true, removed: removed.removed || true };
  }, {
    staleMs: 10 * 60 * 1000,
    ...(remainingMs === null ? {} : { timeoutMs: remainingMs }),
  });
  return locked.ok ? locked.value : { ok: false };
}

/** 정상 종료가 증명된 소유자만 retained/armed 방까지 명시적으로 닫을 수 있다. */
export async function closeScratchRoom(handle) {
  if (!handle || typeof handle.path !== 'string' || typeof handle.recordPath !== 'string' ||
      typeof handle.roomId !== 'string' || typeof handle.token !== 'string' || typeof handle.name !== 'string') {
    return { ok: false };
  }
  const scratch = dirname(handle.path);
  const registry = join(scratch, REGISTRY);
  if (handle.name !== basename(handle.path) ||
      !samePath(handle.recordPath, join(registry, `${handle.roomId}.json`)) ||
      !samePath(handle.lockPath, join(registry, `${handle.roomId}.lock`))) return { ok: false };
  return closeRecord({
    roots: { scratch, registry },
    recordPath: handle.recordPath,
    roomId: handle.roomId,
    token: handle.token,
    allowRetained: true,
  });
}

async function ownerIsDead(record, getStartTime, authority) {
  if (typeof getStartTime !== 'function') return false;
  let live;
  try {
    live = await getStartTime(record.ownerPid, authority);
  } catch {
    return false;
  }
  if (live === null) return true;
  if (typeof live !== 'string' || live === '') return false;
  return record.ownerStartTime !== null && live !== record.ownerStartTime;
}

/** sidecar가 삭제 권한을 증명한 expired disposable만 회수한다. */
export async function sweepScratchRooms(spec = {}, deps = {}) {
  const result = emptySweep();
  const stateRoot = spec?.stateRoot;
  const nowMs = spec?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return result;
  const hasDeadline = spec !== null && typeof spec === 'object' && Object.hasOwn(spec, 'deadlineAt');
  const deadlineAt = hasDeadline ? spec.deadlineAt : null;
  if (hasDeadline && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) return result;
  const hasClock = deps !== null && typeof deps === 'object' && Object.hasOwn(deps, 'nowMs');
  if (hasClock && typeof deps.nowMs !== 'function') return result;
  const getNowMs = hasClock ? deps.nowMs : Date.now;
  let sweepStartedAt;
  try {
    sweepStartedAt = getNowMs();
  } catch {
    return result;
  }
  if (!Number.isSafeInteger(sweepStartedAt) || sweepStartedAt < 0) return result;
  const localDeadline = sweepStartedAt <= Number.MAX_SAFE_INTEGER - SCRATCH_ROOM_SWEEP_BUDGET_MS
    ? sweepStartedAt + SCRATCH_ROOM_SWEEP_BUDGET_MS
    : Number.MAX_SAFE_INTEGER;
  const sweepDeadline = hasDeadline ? Math.min(localDeadline, deadlineAt) : localDeadline;
  const probeAuthority = { deadlineAt: sweepDeadline, clock: getNowMs };
  const remainingBudgetMs = () => {
    try {
      const observed = getNowMs();
      return !Number.isSafeInteger(observed) || observed < 0 || observed >= sweepDeadline
        ? 0
        : sweepDeadline - observed;
    } catch {
      return 0;
    }
  };
  const budgetExpired = () => remainingBudgetMs() === 0;
  if (budgetExpired()) return result;
  let roots;
  try {
    roots = await rootsFor(stateRoot);
  } catch {
    return result;
  }
  if (roots === null) return result;
  if (budgetExpired()) return result;
  let entries;
  try {
    entries = await readdir(roots.registry, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (budgetExpired()) break;
    const matched = entry.isFile() && !entry.isSymbolicLink() ? RECORD_PATTERN.exec(entry.name) : null;
    if (matched === null) continue;
    result.checked += 1;
    const roomId = matched[1];
    const recordPath = join(roots.registry, entry.name);
    if (budgetExpired()) {
      result.preserved += 1;
      break;
    }
    const loaded = await readRecord(recordPath, roomId);
    if (loaded.status === 'newer') {
      result.newer += 1;
      result.preserved += 1;
      continue;
    }
    if (loaded.status !== 'current' || loaded.record.disposition !== 'disposable' ||
        nowMs < loaded.record.expiresAt) {
      result.preserved += 1;
      continue;
    }
    if (budgetExpired()) {
      result.preserved += 1;
      break;
    }
    const dead = await ownerIsDead(loaded.record, deps?.getStartTime, probeAuthority);
    // probe 하나가 남은 예산을 다 썼다면 그 결과로 삭제를 시작하지 않는다. 현재 sidecar와
    // 뒤의 sidecar는 그대로 남아 다음 startup이 다시 판정한다.
    if (budgetExpired()) {
      result.preserved += 1;
      break;
    }
    if (!dead) {
      result.preserved += 1;
      continue;
    }
    const closed = await closeRecord({
      roots,
      recordPath,
      roomId,
      token: loaded.record.token,
      allowRetained: false,
      authority: { expired: budgetExpired, remainingMs: remainingBudgetMs, deps },
    });
    if (closed.ok) result.removed += 1;
    else result.preserved += 1;
  }
  return result;
}
