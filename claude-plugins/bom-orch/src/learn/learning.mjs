import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { withLock } from '../lockfile.mjs';

/**
 * Learning's shared persistence boundary.
 *
 * A posterior change and the journal row that explains it are one logical
 * operation.  The individual files remain independently readable for legacy
 * clients, but writers serialize here and leave a complete desired state in
 * `learning.pending.json` before changing either file.  Recovery is therefore
 * target replay, never "apply this delta again".  A corrupt posterior's
 * quarantine copy is also a target: preparation never moves the only original
 * bytes before its durable operation exists.
 *
 * This promises restart/process-crash recovery.  It deliberately does not
 * claim directory-fsync or power-loss guarantees that Windows does not offer.
 */
export const LEARNING_LOCK_FILE = 'learning.lock';
export const PENDING_FILE = 'learning.pending.json';
export const GENERATIONS_FILE = 'learning.generations.json';

const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 5;
const RECOVERY_FAILURE = Symbol('recovery-failure');

const pathsFor = (stateRoot) =>
  typeof stateRoot === 'string' && stateRoot !== '' && isAbsolute(stateRoot)
    ? {
        root: stateRoot,
        lock: join(stateRoot, LEARNING_LOCK_FILE),
        pending: join(stateRoot, PENDING_FILE),
        posteriors: join(stateRoot, 'posteriors.json'),
        generations: join(stateRoot, GENERATIONS_FILE),
        journal: join(stateRoot, 'journal.jsonl'),
      }
    : null;

export function generationOf(generations, cellKey) {
  const global = Number.isInteger(generations?.global) && generations.global >= 0 ? generations.global : 0;
  const local = Number.isInteger(generations?.cells?.[cellKey]) && generations.cells[cellKey] >= 0
    ? generations.cells[cellKey]
    : 0;
  return Math.max(global, local);
}

export function normalizeGenerations(raw) {
  const global = Number.isInteger(raw?.global) && raw.global >= 0 ? raw.global : 0;
  const cells = {};
  if (raw?.cells !== null && typeof raw?.cells === 'object' && !Array.isArray(raw.cells)) {
    for (const [key, value] of Object.entries(raw.cells)) {
      if (Number.isInteger(value) && value >= 0) cells[key] = value;
    }
  }
  return { global, cells };
}

export async function readGenerationsUnlocked(stateRoot) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  try {
    const raw = JSON.parse(await readFile(paths.generations, 'utf8'));
    return { ok: true, generations: normalizeGenerations(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, generations: { global: 0, cells: {} } };
    return { ok: false, reason: `학습 세대를 읽지 못했습니다: ${describe(error)}` };
  }
}

export async function readGenerations(stateRoot) {
  const locked = await withLearningLock(stateRoot, async () => readGenerationsUnlocked(stateRoot));
  return locked.ok ? locked.value : { ok: false, reason: locked.reason };
}

/** Execute a callback while holding the single learning coordinator. */
export async function withLearningLock(stateRoot, fn) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  const locked = await withLock(paths.lock, async () => {
    const recovered = await recoverPendingUnlocked(paths);
    if (!recovered.ok) return { [RECOVERY_FAILURE]: true, reason: recovered.reason };
    return fn(paths);
  });
  if (locked.ok && locked.value?.[RECOVERY_FAILURE] === true) {
    return { ok: false, reason: locked.value.reason };
  }
  return locked;
}

/** Recover pending work before a read that needs posterior/journal agreement. */
export async function recoverLearning(stateRoot) {
  const locked = await withLearningLock(stateRoot, async () => ({ ok: true }));
  if (!locked.ok) return { ok: false, reason: locked.reason };
  return locked.value;
}

/** A lock-free preflight for atomic-file readers; only a present WAL needs recovery. */
export async function hasPendingLearningOperation(stateRoot) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return false;
  try {
    return (await stat(paths.pending)).isFile();
  } catch {
    return false;
  }
}

/**
 * Persist and apply a complete target operation while `learning.lock` is held.
 * `onPhase` is an I/O-boundary seam for deterministic fault tests; production
 * callers do not supply it.  A thrown hook deliberately leaves the pending WAL
 * for the next reader or mutation to replay.
 */
export async function commitLearningOperationUnlocked(stateRoot, operation, { onPhase } = {}) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  const normalized = normalizeOperation(operation);
  if (!normalized.ok) return normalized;
  const written = await writeAtomicJson(paths, paths.pending, PENDING_FILE, normalized.operation);
  if (!written.ok) return written;
  const afterPending = await phase(onPhase, 'after-pending');
  if (!afterPending.ok) return afterPending;
  return applyPendingUnlocked(paths, normalized.operation, onPhase);
}

export async function commitLearningOperation(stateRoot, operation, options) {
  const locked = await withLearningLock(stateRoot, async () => commitLearningOperationUnlocked(stateRoot, operation, options));
  return settle(locked);
}

export const makeOperationId = () => randomUUID();

async function recoverPendingUnlocked(paths) {
  let raw;
  try {
    raw = JSON.parse(await readFile(paths.pending, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    return { ok: false, reason: `보류 중인 학습 작업을 읽지 못했습니다: ${describe(error)}` };
  }
  const normalized = normalizeOperation(raw);
  if (!normalized.ok) return { ok: false, reason: `보류 중인 학습 작업이 손상됐습니다: ${normalized.reason}` };
  return applyPendingUnlocked(paths, normalized.operation);
}

async function applyPendingUnlocked(paths, operation, onPhase) {
  const { targets } = operation;
  if (targets.quarantine !== null) {
    const quarantined = await writeAtomicBytes(
      paths,
      join(paths.root, targets.quarantine.file),
      targets.quarantine.file,
      Buffer.from(targets.quarantine.bytes, 'base64'),
    );
    if (!quarantined.ok) return quarantined;
  }
  const afterQuarantine = await phase(onPhase, 'after-quarantine');
  if (!afterQuarantine.ok) return afterQuarantine;

  if (targets.posteriors !== null) {
    const posteriors = await writeAtomicJson(paths, paths.posteriors, 'posteriors.json', targets.posteriors);
    if (!posteriors.ok) return posteriors;
  }
  const afterPosterior = await phase(onPhase, 'after-posterior');
  if (!afterPosterior.ok) return afterPosterior;

  if (targets.generations !== null) {
    const generations = await writeAtomicJson(paths, paths.generations, GENERATIONS_FILE, targets.generations);
    if (!generations.ok) return generations;
  }
  const afterGenerations = await phase(onPhase, 'after-generations');
  if (!afterGenerations.ok) return afterGenerations;

  if (targets.journal !== null) {
    const journal = await appendJournalOnce(paths.journal, targets.journal, operation.operationId);
    if (!journal.ok) return journal;
  }
  const afterJournal = await phase(onPhase, 'after-journal');
  if (!afterJournal.ok) return afterJournal;

  try {
    await rm(paths.pending, { force: true });
  } catch (error) {
    return { ok: false, reason: `보류 중인 학습 작업을 지우지 못했습니다: ${describe(error)}` };
  }
  return { ok: true };
}

async function phase(onPhase, name) {
  if (typeof onPhase !== 'function') return { ok: true };
  try {
    await onPhase(name);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `학습 저장 경계 ${name} 에서 실패했습니다: ${describe(error)}` };
  }
}

function normalizeOperation(value) {
  const op = value !== null && typeof value === 'object' ? value : null;
  const id = typeof op?.operationId === 'string' && op.operationId !== '' ? op.operationId : null;
  const targets = op?.targets !== null && typeof op?.targets === 'object' ? op.targets : null;
  const posteriors = targets?.posteriors;
  if (op?.version !== 1 || id === null || posteriors === undefined || (posteriors !== null && (typeof posteriors !== 'object' || Array.isArray(posteriors)))) {
    return { ok: false, reason: 'version, operationId, targets.posteriors 가 있는 작업이어야 합니다.' };
  }
  let generations = null;
  if (targets.generations !== null && targets.generations !== undefined) {
    generations = normalizeGenerations(targets.generations);
  }
  let journal = null;
  if (targets.journal !== null && targets.journal !== undefined) {
    if (targets.journal === null || typeof targets.journal !== 'object' || Array.isArray(targets.journal)) {
      return { ok: false, reason: 'targets.journal 은 객체 또는 null 이어야 합니다.' };
    }
    if (typeof targets.journal.runId !== 'string' || targets.journal.runId === '') {
      return { ok: false, reason: 'targets.journal 에 runId 가 없습니다.' };
    }
    journal = { ...targets.journal, operationId: id };
  }
  let quarantine = null;
  if (targets.quarantine !== null && targets.quarantine !== undefined) {
    const candidate = targets.quarantine;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      candidate.file !== 'posteriors.corrupt.json' ||
      typeof candidate.bytes !== 'string'
    ) {
      return { ok: false, reason: 'targets.quarantine 은 posteriors.corrupt.json 바이트여야 합니다.' };
    }
    quarantine = { file: candidate.file, bytes: candidate.bytes };
  }
  return {
    ok: true,
    operation: { version: 1, operationId: id, targets: { posteriors, generations, journal, quarantine } },
  };
}

async function appendJournalOnce(file, entry, operationId) {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, reason: `실행 저널을 읽지 못했습니다: ${describe(error)}` };
  }
  for (const line of text.split('\n')) {
    try {
      if (JSON.parse(line)?.operationId === operationId) return { ok: true };
    } catch {
      // A torn tail is already unrecoverable; leave it and begin our row on a new line.
    }
  }
  let line;
  try {
    line = JSON.stringify(entry);
  } catch (error) {
    return { ok: false, reason: `실행 저널 작업을 JSON 으로 만들지 못했습니다: ${describe(error)}` };
  }
  try {
    const handle = await open(file, 'a');
    try {
      await handle.writeFile(`${text !== '' && !text.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8');
      // The pending record is not removed until the semantic journal row has
      // reached the file handle.  This is process-crash/restart durability,
      // not a claim about directory fsync or sudden power loss.
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `실행 저널에 작업을 기록하지 못했습니다: ${describe(error)}` };
  }
}

async function writeAtomicJson(paths, target, name, value) {
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, reason: `${name} 을(를) JSON 으로 만들지 못했습니다: ${describe(error)}` };
  }
  return writeAtomicBytes(paths, target, name, bytes);
}

async function writeAtomicBytes(paths, target, name, bytes) {
  const tmp = join(paths.root, `${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    const moved = await renameWithRetry(tmp, target);
    return moved.ok ? { ok: true } : { ok: false, reason: `${name} 을(를) 제자리로 옮기지 못했습니다: ${moved.reason}` };
  } catch (error) {
    return { ok: false, reason: `${name} 을(를) 쓰지 못했습니다: ${describe(error)}` };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function renameWithRetry(from, to) {
  let last = null;
  for (let attempt = 1; attempt <= RENAME_TRIES; attempt += 1) {
    try {
      await rename(from, to);
      return { ok: true };
    } catch (error) {
      last = error;
      const retryable = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY';
      if (!retryable || attempt === RENAME_TRIES) break;
      await new Promise((resolve) => setTimeout(resolve, RENAME_WAIT_MS));
    }
  }
  return { ok: false, reason: describe(last) };
}

function settle(locked) {
  if (!locked.ok) return { ok: false, reason: locked.reason };
  const value = locked.value;
  if (!value?.ok) return { ok: false, reason: value?.reason ?? '학습 작업이 실패했습니다.' };
  return { ok: true };
}

function describe(error) {
  if (error === undefined) return '사유 없이 undefined 가 던져졌습니다.';
  if (error === null) return '사유 없이 null 이 던져졌습니다.';
  try {
    return typeof error?.message === 'string' && error.message !== '' ? error.message : String(error);
  } catch {
    return '사유를 읽지 못했습니다.';
  }
}
