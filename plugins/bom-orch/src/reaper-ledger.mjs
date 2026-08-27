import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { withLock } from './lockfile.mjs';
import { defaultGetStartTime } from './process-identity.mjs';
import { writeFileAtomic } from './util/fs-atomic.mjs';
import {
  CHILDREN_SCHEMA_VERSION,
  WORKTREE_AUTHORITY_RECORD_TYPE,
  isEffectUnknownIntentRecord,
  isWorktreeCreationAuthorityRecord,
  isWorktreeScopeClaimRecord,
  readLedger,
} from './reaper-ledger-schema.mjs';
export {
  CHILDREN_LEDGER_MAX_BYTES,
  CHILDREN_SCHEMA_VERSION,
  WORKTREE_AUTHORITY_RECORD_TYPE,
  WORKTREE_AUTHORITY_VERSION,
  WORKTREE_SCOPE_CLAIM_RECORD_TYPE,
  WORKTREE_SCOPE_CLAIM_VERSION,
  isEffectUnknownIntentRecord,
  isWorktreeCreationAuthorityRecord,
  isWorktreeScopeClaimRecord,
  readLedger,
  readRecords,
  recordIsRetained,
} from './reaper-ledger-schema.mjs';

const LEDGER = 'children.json';
const SCHEMA_RECORD = Object.freeze({ schemaVersion: CHILDREN_SCHEMA_VERSION });
const LOCK = 'children.lock';

const ledgerPath = (stateRoot) => join(stateRoot, LEDGER);

const purposeOf = (value) => typeof value === 'string' && value !== '' && value.length <= 128 ? value : null;
const retainUntilOf = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

const sameIntentScope = (record, runId, worktree) =>
  record?.runId === runId && record?.worktree === worktree;

/** 같은 lock/RMW 안에서 현재 intent 집합을 모든 실행 행에 투영한다. */
function inheritEffectIntents(records, runId, worktree) {
  if (typeof runId !== 'string' || runId === '' || typeof worktree !== 'string' || worktree === '') return records;
  const intents = records.filter((record) =>
    isEffectUnknownIntentRecord(record) && sameIntentScope(record, runId, worktree));
  const tokens = [...new Set(intents.map((record) => record.intentToken))].sort();
  const projectPaths = [...new Set(intents.map((record) => record.projectPath))];
  const projectPath = projectPaths.length === 1 ? projectPaths[0] : null;
  const intentRetainUntil = intents.reduce(
    (highest, record) => Math.max(highest, retainUntilOf(record.retainUntil) ?? -1),
    -1,
  );
  return records.map((record) => {
    if (!sameIntentScope(record, runId, worktree) || isEffectUnknownIntentRecord(record) ||
        isWorktreeScopeClaimRecord(record)) return record;
    if (tokens.length > 0 && intentRetainUntil >= 0) {
      return {
        ...record,
        ...(projectPath === null ? {} : { projectPath }),
        effectIntentTokens: tokens,
        intentRetainUntil,
      };
    }
    if (!Object.hasOwn(record, 'effectIntentTokens') && !Object.hasOwn(record, 'intentRetainUntil')) return record;
    const next = { ...record };
    delete next.effectIntentTokens;
    delete next.intentRetainUntil;
    return next;
  });
}

function versionSkew(schemaVersion) {
  return {
    status: 'version_skew',
    schemaVersion,
    stateSchema: {
      file: LEDGER,
      status: 'newer',
      found: schemaVersion,
      supported: CHILDREN_SCHEMA_VERSION,
    },
  };
}

let tempCounter = 0;
let currentWriterStartTimePromise = null;

async function writerIdentityOf(options) {
  const pid = Number.isInteger(options.writerPid) && options.writerPid > 0
    ? options.writerPid : process.pid;
  const probe = typeof options.getWriterStartTime === 'function'
    ? options.getWriterStartTime : defaultGetStartTime;
  let startTime;
  try {
    if (pid === process.pid && probe === defaultGetStartTime) {
      currentWriterStartTimePromise ??= defaultGetStartTime(pid);
      startTime = await currentWriterStartTimePromise;
      if (typeof startTime !== 'string' || startTime === '') currentWriterStartTimePromise = null;
    } else {
      startTime = await probe(pid);
    }
  } catch {
    if (pid === process.pid && probe === defaultGetStartTime) currentWriterStartTimePromise = null;
    return null;
  }
  return typeof startTime === 'string' && startTime !== '' ? { pid, startTime } : null;
}

export async function updateRecords(stateRoot, mutate, options) {
  const given = options !== null && typeof options === 'object' ? options : {};
  // children.lock의 소유자는 행이 데이터의 owner가 아니라 이 RMW를 실행하는
  // 현재 process다. helper/reaper가 죽은 parent의 identity를 게시하면 live writer를
  // dead로 오판해 stale snapshot으로 덮을 수 있으므로 lock 전에 자기 신원을 증명한다.
  const writerIdentity = await writerIdentityOf(given);
  if (writerIdentity === null) return { ok: false, status: 'writer_identity_unavailable' };
  try {
    await mkdir(stateRoot, { recursive: true });
  } catch {
    return { ok: false, status: 'write_failed' };
  }
  const locked = await withLock(join(stateRoot, LOCK), async () => {
    const ledger = await readLedger(stateRoot, given);
    if (ledger.status === 'version_skew') return { ok: false, ...versionSkew(ledger.schemaVersion) };
    if (ledger.status === 'unreadable') return { ok: false, status: 'unreadable' };
    const mutation = await mutate(ledger.records);
    if (mutation !== null && typeof mutation === 'object' && !Array.isArray(mutation) &&
        mutation.write === false) return { ok: true, status: 'unchanged', ...(mutation.result ?? {}) };
    const next = Array.isArray(mutation) ? mutation : mutation?.records;
    if (!Array.isArray(next)) return { ok: false, status: 'write_failed' };
    const target = ledgerPath(stateRoot);
    const temp = `${target}.${process.pid}.${tempCounter++}.tmp`;
    const written = await writeFileAtomic(
      target,
      Buffer.from(JSON.stringify([SCHEMA_RECORD, ...next], null, 2), 'utf8'),
      {
        tempPath: temp,
        fsync: given.fsync === true,
        syncDir: given.syncDir === true,
        strictDurability: given.strictDurability === true,
        exclusive: false,
        fs: given.fs,
      },
    );
    return written.ok
      ? { ok: true, status: 'written' }
      : {
        ok: false,
        status: 'write_failed',
        ...(written.published === true ? { published: true } : {}),
        ...(written.commitUnknown === true ? { commitUnknown: true } : {}),
      };
  }, {
    ...(given.lockOptions ?? {}),
    identityProtected: true,
    ownerIdentity: writerIdentity,
    getStartTime: typeof given.getLockOwnerStartTime === 'function'
      ? given.getLockOwnerStartTime : defaultGetStartTime,
  });
  if (!locked.ok) {
    return {
      ok: false,
      status: 'write_failed',
      ...(locked.reasonCode === undefined ? {} : { reasonCode: locked.reasonCode }),
    };
  }
  if (locked.released === false) {
    return {
      ok: false,
      status: 'lock_release_unknown',
      commitUnknown: true,
      ...(locked.value?.ok === true || locked.value?.published === true ? { published: true } : {}),
      ...(locked.releaseReason === undefined ? {} : { releaseReason: locked.releaseReason }),
    };
  }
  return locked.value;
}

/** 스윕이 읽었던 행과 바이트상 같은 행만 완료한다. 느린 cleanup 동안 바뀐 행은 남긴다. */
export async function completeRecords(stateRoot, completed, options) {
  const tokens = new Set(completed.map((record) => JSON.stringify(record)));
  return updateRecords(
    stateRoot,
    (records) => records.filter((record) => !tokens.has(JSON.stringify(record))),
    options,
  );
}

/**
 * A scope claim is the exclusive fence for side effects on one canonical worktree path. Producers
 * must make their "claim absent" decision inside the same ledger RMW as their append/upsert; a
 * pre-lock check would let a cleanup claim slip in between the check and the new executable row.
 */
function mutateUnclaimedScope(records, worktree, mutate) {
  if (typeof worktree === 'string' && records.some((record) =>
    isWorktreeScopeClaimRecord(record) && record.worktree === worktree)) {
    return { write: false, result: { ok: false, status: 'scope_claim_busy' } };
  }
  return mutate(records);
}

/** call 전에 고유 intent를 append하고 이미 등록된 child/worktree 행에도 같은 보존을 건다. */
export function armEffectUnknownIntentRecords(stateRoot, intentRecord, options) {
  return updateRecords(stateRoot, (records) => mutateUnclaimedScope(
    records,
    intentRecord.worktree,
    (current) => inheritEffectIntents(
      [...current.filter((record) => !(isEffectUnknownIntentRecord(record) &&
        record.intentToken === intentRecord.intentToken &&
        sameIntentScope(record, intentRecord.runId, intentRecord.worktree))), intentRecord],
      intentRecord.runId,
      intentRecord.worktree,
    ),
  ), options);
}

/** 정상 settlement만 자기 token 하나를 CAS 범위에서 내리고, 다른 intent는 그대로 둔다. */
export function disarmEffectUnknownIntentRecords(stateRoot, { runId, worktree, token }, options) {
  return updateRecords(stateRoot, (records) => inheritEffectIntents(
    records.filter((record) => !(isEffectUnknownIntentRecord(record) &&
      record.intentToken === token && sameIntentScope(record, runId, worktree))),
    runId,
    worktree,
  ), options);
}

/** child 등록과 active intent 상속을 한 RMW로 묶는다. */
export function appendChildRecord(stateRoot, record, options) {
  return updateRecords(
    stateRoot,
    (records) => mutateUnclaimedScope(
      records,
      record.worktree,
      (current) => inheritEffectIntents([...current, record], record.runId, record.worktree),
    ),
    options,
  );
}

/** effect_unknown 판정 경계의 child 승격과 self recovery upsert를 하나의 lock/RMW로 닫는다. */
export async function retainEffectUnknownRecords(stateRoot, {
  runId, worktree, projectPath, retainUntil, recoveryRecord,
}, options) {
  return updateRecords(stateRoot, (records) => mutateUnclaimedScope(records, worktree, (current) => {
    const promote = (record) => ({
      ...record,
      projectPath,
      purpose: 'effect_unknown',
      retainUntil: Math.max(retainUntilOf(record.retainUntil) ?? -1, retainUntil),
    });
    const promoted = current.map((record) =>
      record.runId === runId && record.worktree === worktree && !isWorktreeScopeClaimRecord(record)
        ? promote(record) : record);
    const recoveryIndex = promoted.findIndex((record) => !isEffectUnknownIntentRecord(record) &&
      !isWorktreeScopeClaimRecord(record) &&
      record.pid === recoveryRecord.pid && record.runId === runId && record.worktree === worktree &&
      record.spawnfile === null);
    if (recoveryIndex === -1) return [...promoted, recoveryRecord];
    const previous = promoted[recoveryIndex];
    promoted[recoveryIndex] = promote({
      ...previous,
      ...recoveryRecord,
      startTime: recoveryRecord.startTime ?? previous.startTime ?? null,
      ownerStartTime: recoveryRecord.ownerStartTime ?? previous.ownerStartTime ?? null,
      retainUntil: Math.max(
        retainUntilOf(previous.retainUntil) ?? -1,
        retainUntilOf(recoveryRecord.retainUntil) ?? -1,
        retainUntil,
      ),
    });
    return promoted;
  }), options);
}

/** 같은 worktree의 재등록은 더 긴 recovery 보존과 이미 아는 projectPath를 낮추지 않는다. */
export async function upsertWorktreeRecord(stateRoot, candidate, options) {
  return updateRecords(stateRoot, (records) => mutateUnclaimedScope(records, candidate.worktree, (current) => {
    const matches = current.filter((record) => !isEffectUnknownIntentRecord(record) &&
      !isWorktreeScopeClaimRecord(record) && record.pid === candidate.pid &&
      record.runId === candidate.runId && record.worktree === candidate.worktree);
    const mergeWith = (previous) => {
      const previousUntil = retainUntilOf(previous?.retainUntil);
      const candidateUntil = retainUntilOf(candidate.retainUntil);
      const keepPrevious = previousUntil !== null && (candidateUntil === null || previousUntil > candidateUntil);
      const candidateIdentity = typeof candidate.startTime === 'string' && candidate.startTime !== '';
      const candidateOwnerIdentity = typeof candidate.ownerStartTime === 'string' && candidate.ownerStartTime !== '';
      return {
        ...candidate,
        startTime: candidateIdentity ? candidate.startTime : previous?.startTime ?? null,
        ownerStartTime: candidateOwnerIdentity ? candidate.ownerStartTime : previous?.ownerStartTime ?? null,
        projectPath: typeof candidate.projectPath === 'string' && candidate.projectPath !== ''
          ? candidate.projectPath : previous?.projectPath ?? null,
        ...(typeof previous?.worktreeAuthorityToken === 'string'
          ? { worktreeAuthorityToken: previous.worktreeAuthorityToken } : {}),
        ...(previous?.recordType === WORKTREE_AUTHORITY_RECORD_TYPE
          ? {
            recordType: WORKTREE_AUTHORITY_RECORD_TYPE,
            worktreeAuthorityVersion: previous.worktreeAuthorityVersion,
          } : {}),
        purpose: keepPrevious
          ? purposeOf(previous?.purpose)
          : purposeOf(candidate.purpose) ?? purposeOf(previous?.purpose),
        retainUntil: keepPrevious ? previousUntil : candidateUntil ?? previousUntil,
      };
    };
    const authorityMatches = matches.filter((record) => typeof record.worktreeAuthorityToken === 'string');
    if (authorityMatches.length > 0) {
      return inheritEffectIntents([
        ...current.filter((record) => !matches.includes(record)),
        ...authorityMatches.map(mergeWith),
      ], candidate.runId, candidate.worktree);
    }
    const strongest = matches.reduce((best, record) => {
      if (best === null) return record;
      return (retainUntilOf(record.retainUntil) ?? -1) > (retainUntilOf(best.retainUntil) ?? -1) ? record : best;
    }, null);
    return inheritEffectIntents([
      ...current.filter((record) => !(!isEffectUnknownIntentRecord(record) &&
        !isWorktreeScopeClaimRecord(record) && record.pid === candidate.pid &&
        record.runId === candidate.runId && record.worktree === candidate.worktree)),
      mergeWith(strongest),
    ], candidate.runId, candidate.worktree);
  }), options);
}
