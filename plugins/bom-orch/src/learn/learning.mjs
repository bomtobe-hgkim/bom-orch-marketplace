import { randomUUID } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { withLock } from '../lockfile.mjs';
import { REASON } from '../reason-codes.mjs';
import { fail } from '../reason-text.mjs';
import { errorText } from '../util/errors.mjs';
import { RENAME_ATTEMPTS, RENAME_DELAY_MS, writeFileAtomic } from '../util/fs-atomic.mjs';
import { parseStrictJson } from '../util/strict-json.mjs';
import { classifyPosteriorsSchema, versionedPosteriors } from './posterior-schema.mjs';

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
 * This promises restart/process-crash recovery.  Since WS1 the shared writer
 * (`src/util/fs-atomic.mjs`) also fsyncs the parent directory after the rename,
 * so on POSIX the rename itself is durable; Windows still refuses a directory
 * fsync (EPERM, measured), and there the guarantee stays process-crash-only.
 * A refused or failed directory fsync is never a write failure — the bytes are
 * already in place.
 */
export const LEARNING_LOCK_FILE = 'learning.lock';
export const PENDING_FILE = 'learning.pending.json';
export const GENERATIONS_FILE = 'learning.generations.json';

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
  if (paths === null) return fail(REASON.state_root_not_absolute);
  try {
    const raw = JSON.parse(await readFile(paths.generations, 'utf8'));
    return { ok: true, generations: normalizeGenerations(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, generations: { global: 0, cells: {} } };
    return fail(REASON.learning_generations_read_failed, { detail: errorText(error) });
  }
}

export async function readGenerations(stateRoot) {
  const locked = await withLearningLock(stateRoot, async () => readGenerationsUnlocked(stateRoot));
  return locked.ok ? locked.value : locked;
}

/** Execute a callback while holding the single learning coordinator. */
export async function withLearningLock(stateRoot, fn) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return fail(REASON.state_root_not_absolute);
  const locked = await withLock(paths.lock, async () => {
    const recovered = await recoverPendingUnlocked(paths);
    // 복구 실패는 **본문의 값**으로 나오므로 여기서 표시해 두고 아래에서 되꺼낸다 — 봉투를
    // 그대로 실어야 `reasonCode` 가 살아남는다(예전에는 `reason` 문장만 옮겨 실었다).
    if (!recovered.ok) return { [RECOVERY_FAILURE]: recovered };
    return fn(paths);
  });
  const recoveryFailure = locked.ok ? locked.value?.[RECOVERY_FAILURE] : undefined;
  if (recoveryFailure !== undefined) return recoveryFailure;
  return locked;
}

/** Recover pending work before a read that needs posterior/journal agreement. */
export async function recoverLearning(stateRoot) {
  const locked = await withLearningLock(stateRoot, async () => ({ ok: true }));
  if (!locked.ok) return locked;
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
  if (paths === null) return fail(REASON.state_root_not_absolute);
  const normalized = normalizeOperation(operation);
  if (!normalized.ok) return normalized;
  const schemaRead = await readNewerPosteriorsSchema(paths);
  if (!schemaRead.ok) return schemaRead;
  if (schemaRead.stateSchema !== null) return { ok: false, stateSchema: schemaRead.stateSchema };
  const targetSchema = normalized.operation.targets.posteriors === null
    ? null
    : classifyPosteriorsSchema(normalized.operation.targets.posteriors);
  if (targetSchema?.status === 'newer') return { ok: false, stateSchema: targetSchema.stateSchema };
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
    const document = parseStrictJson(await readFile(paths.pending));
    if (!document.ok) {
      return fail(REASON.learning_pending_work_read_failed, {
        detail: 'learning.pending.json is not an unambiguous UTF-8 JSON document',
      });
    }
    raw = document.value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    return fail(REASON.learning_pending_work_read_failed, { detail: errorText(error) });
  }
  const normalized = normalizeOperation(raw);
  if (!normalized.ok) return fail(REASON.learning_pending_work_invalid, { detail: normalized.error });
  const schemaRead = await readNewerPosteriorsSchema(paths);
  if (!schemaRead.ok) return schemaRead;
  if (schemaRead.stateSchema !== null) return { ok: false, stateSchema: schemaRead.stateSchema };
  const targetSchema = normalized.operation.targets.posteriors === null
    ? null
    : classifyPosteriorsSchema(normalized.operation.targets.posteriors);
  if (targetSchema?.status === 'newer') return { ok: false, stateSchema: targetSchema.stateSchema };
  return applyPendingUnlocked(paths, normalized.operation);
}

async function readNewerPosteriorsSchema(paths) {
  let bytes;
  try {
    bytes = await readFile(paths.posteriors);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, stateSchema: null };
    return fail(REASON.learning_posteriors_read_failed, { detail: errorText(error) });
  }
  const document = parseStrictJson(bytes);
  if (!document.ok) {
    if (document.kind === 'ambiguous') {
      return fail(REASON.learning_posteriors_read_failed, {
        detail: 'posteriors.json contains duplicate keys or excessive nesting',
      });
    }
    // A readable corrupt current file is replayable because the durable WAL is
    // the complete target.  Only an unreadable file is opaque and fail-closed.
    return { ok: true, stateSchema: null };
  }
  const raw = document.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: true, stateSchema: null };
  }
  const schema = classifyPosteriorsSchema(raw);
  if (schema.status === 'invalid') {
    return fail(REASON.learning_posteriors_read_failed, {
      detail: 'posteriors.json contains an invalid schemaVersion',
    });
  }
  return { ok: true, stateSchema: schema.status === 'newer' ? schema.stateSchema : null };
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
    const posteriors = await writeAtomicJson(
      paths,
      paths.posteriors,
      'posteriors.json',
      versionedPosteriors(targets.posteriors),
    );
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

  // ★★ WAL 치우기도 **재시도한다**(최종 리뷰 I6). 이 한 줄이 실패하면 트랜잭션 전체가
  //   `learning_pending_work_unclearable` 로 돌아가는데, 사후분포도 저널 행도 이미 디스크에
  //   있으므로 그 답은 「아무것도 안 됐다」가 아니라 「치울 것이 남았다」다. Windows 에서
  //   EPERM/EBUSY 는 흔한 일시 상태(안티바이러스·다른 리더의 열린 핸들)이고, 같은 모듈의
  //   `writeAtomicBytes` 는 그 셋을 이미 10회 × 5ms 로 다시 시도한다 — 여기만 한 번에 포기하던
  //   비대칭이 그 실패 등급을 이 경로의 유일한 상시 트리거로 만들고 있었다.
  const cleared = await removePendingWithRetry(paths.pending);
  if (!cleared.ok) return fail(REASON.learning_pending_work_unclearable, { detail: cleared.reason });
  return { ok: true };
}

/** `rm` 을 `renameWithRetry` 와 같은 예산(10회 × 5ms)으로 다시 시도한다. 같은 세 코드만. */
async function removePendingWithRetry(path) {
  let last = null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rm(path, { force: true });
      return { ok: true };
    } catch (error) {
      last = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === RENAME_ATTEMPTS) break;
      await new Promise((resolve) => { setTimeout(resolve, RENAME_DELAY_MS); });
    }
  }
  return { ok: false, reason: errorText(last) };
}

async function phase(onPhase, name) {
  if (typeof onPhase !== 'function') return { ok: true };
  try {
    await onPhase(name);
    return { ok: true };
  } catch (error) {
    return fail(REASON.learning_write_boundary_failed, { name, detail: errorText(error) });
  }
}

function normalizeOperation(value) {
  const op = value !== null && typeof value === 'object' ? value : null;
  const id = typeof op?.operationId === 'string' && op.operationId !== '' ? op.operationId : null;
  const targets = op?.targets !== null && typeof op?.targets === 'object' ? op.targets : null;
  const posteriors = targets?.posteriors;
  if (op?.version !== 1 || id === null || posteriors === undefined || (posteriors !== null && (typeof posteriors !== 'object' || Array.isArray(posteriors)))) {
    return fail(REASON.learning_work_invalid);
  }
  if (posteriors !== null && classifyPosteriorsSchema(posteriors).status === 'invalid') {
    return fail(REASON.learning_work_invalid);
  }
  let generations = null;
  if (targets.generations !== null && targets.generations !== undefined) {
    generations = normalizeGenerations(targets.generations);
  }
  let journal = null;
  if (targets.journal !== null && targets.journal !== undefined) {
    if (targets.journal === null || typeof targets.journal !== 'object' || Array.isArray(targets.journal)) {
      return fail(REASON.learning_work_journal_invalid);
    }
    if (typeof targets.journal.runId !== 'string' || targets.journal.runId === '') {
      return fail(REASON.learning_work_journal_run_id_missing);
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
      return fail(REASON.learning_work_quarantine_invalid);
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
    if (error?.code !== 'ENOENT') return fail(REASON.learning_journal_read_failed, { detail: errorText(error) });
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
    return fail(REASON.learning_journal_record_unserializable, { detail: errorText(error) });
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
    return fail(REASON.learning_journal_row_write_failed, { detail: errorText(error) });
  }
}

async function writeAtomicJson(paths, target, name, value) {
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (error) {
    return fail(REASON.learning_work_unserializable, { name, detail: errorText(error) });
  }
  return writeAtomicBytes(paths, target, name, bytes);
}

/**
 * 임시 파일 + fsync + rename 은 `src/util/fs-atomic.mjs` 하나로 모았다(`wx` 배타 생성,
 * 데이터 fsync, EPERM/EACCES/EBUSY 10회 × 5ms 재시도, **실패하면** 임시 파일 치우기 —
 * 성공 경로에는 rename 이 이미 가져가 치울 것이 없고, `wx` 가 EEXIST 로 튕겼으면 남의
 * 파일이라 손대지 않는다). 여기 남는 것은 **이 모듈의 것**뿐이다: 임시 이름과 실패 문장.
 *
 * ★ `syncDir:true` 는 여기서 새로 켠 것이다. rename 자체가 디스크에 닿는 창을 닫는다 —
 *   Windows 에서는 디렉터리 fsync 가 EPERM 이라(실측) 오늘과 같은 「프로세스 크래시까지」
 *   등급으로 강등되고, POSIX 에서는 진짜 보장이 된다. 어느 쪽이든 **쓰기 실패는 아니다.**
 * ★ `stage` 로 두 코드를 가른다. 「쓰지 못했다」와 「제자리로 옮기지 못했다」는 호출자에게
 *   다른 뜻이라 한 코드로 접으면 안 된다.
 */
async function writeAtomicBytes(paths, target, name, bytes) {
  const tmp = join(paths.root, `${name}.${process.pid}.${randomUUID()}.tmp`);
  const written = await writeFileAtomic(target, bytes, { tempPath: tmp, fsync: true, syncDir: true });
  if (written.ok) return { ok: true };
  return written.stage === 'rename'
    ? fail(REASON.learning_work_publish_failed, { name, detail: written.reason })
    : fail(REASON.learning_work_write_failed, { name, detail: written.reason });
}

function settle(locked) {
  if (!locked.ok) return locked;
  const value = locked.value;
  if (!value?.ok) return value?.ok === false ? value : fail(REASON.learning_work_failed);
  return { ok: true };
}
