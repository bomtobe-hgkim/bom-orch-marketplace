import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { defaultGetStartTime } from './process-identity.mjs';
import { canonical } from './real-path.mjs';
import {
  isWorktreeCreationAuthorityRecord,
  isWorktreeScopeClaimRecord,
  readLedger,
  updateRecords,
  WORKTREE_SCOPE_CLAIM_RECORD_TYPE,
  WORKTREE_SCOPE_CLAIM_VERSION,
} from './reaper-ledger.mjs';
import { resolveSafeWorktree } from './worktree-paths.mjs';

const TOKEN = /^[0-9a-f]{64}$/;
const sameScope = (record, worktree) => record?.worktree === worktree;
const snapshotBytes = (records) => JSON.stringify(records);

const durableOptions = (deps) => ({
  ...(deps?.ledgerOptions !== null && typeof deps?.ledgerOptions === 'object' ? deps.ledgerOptions : {}),
  fsync: true,
  syncDir: true,
  strictDurability: true,
});

const mutationFailure = (updated) => ({
  ok: false,
  status: typeof updated?.status === 'string' ? updated.status : 'write_failed',
  ...(updated?.published === true ? { published: true } : {}),
  ...(updated?.commitUnknown === true ? { commitUnknown: true } : {}),
  ...(updated?.reasonCode === undefined ? {} : { reasonCode: updated.reasonCode }),
  ...(updated?.stateSchema === undefined ? {} : { stateSchema: updated.stateSchema }),
  ...(updated?.releaseReason === undefined ? {} : { releaseReason: updated.releaseReason }),
});

function validClaim(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.stateRoot === 'string' && value.stateRoot !== '' && isAbsolute(value.stateRoot) &&
    typeof value.worktree === 'string' && value.worktree !== '' && isAbsolute(value.worktree) &&
    typeof value.projectPath === 'string' && value.projectPath !== '' && isAbsolute(value.projectPath) &&
    typeof value.runId === 'string' && value.runId !== '' && TOKEN.test(value.claimToken ?? '') &&
    (value.claimKind === 'create' || value.claimKind === 'cleanup');
}

const exactClaim = (record, claim) => isWorktreeScopeClaimRecord(record) &&
  record.claimToken === claim.claimToken && record.claimKind === claim.claimKind &&
  record.authorityToken === claim.authorityToken && record.runId === claim.runId &&
  record.worktree === claim.worktree && record.projectPath === claim.projectPath &&
  record.pid === claim.pid && record.startTime === claim.startTime &&
  record.ownerPid === claim.pid && record.ownerStartTime === claim.startTime;

const claimFromRecord = (stateRoot, record) => Object.freeze({
  stateRoot,
  runId: record.runId,
  worktree: record.worktree,
  projectPath: record.projectPath,
  claimKind: record.claimKind,
  authorityToken: record.authorityToken,
  claimToken: record.claimToken,
  pid: record.pid,
  startTime: record.startTime,
});

async function redurableClaim(claim, deps) {
  let found = false;
  const updated = await updateRecords(claim.stateRoot, (records) => {
    found = records.some((record) => exactClaim(record, claim));
    return found ? records : { write: false };
  }, durableOptions(deps));
  if (updated?.ok !== true) return { ...mutationFailure(updated), claim };
  return found
    ? { ok: true, status: 'redurable', claim }
    : { ok: false, status: 'claim_missing', claim };
}

export async function readWorktreeScope(stateRoot, worktree, deps = {}) {
  const [root, target] = await Promise.all([canonical(stateRoot), resolveSafeWorktree(stateRoot, worktree)]);
  if (root === null || target === null) return { status: 'unreadable', schemaVersion: null, records: [] };
  const ledger = await readLedger(root, deps?.ledgerOptions ?? {});
  return {
    ...ledger,
    records: ledger.status === 'current' || ledger.status === 'legacy'
      ? ledger.records.filter((record) => sameScope(record, target)) : [],
  };
}

/** Short ledger CAS only: no process probe or external effect occurs under children.lock. */
export async function acquireWorktreeScopeClaim({
  stateRoot, runId, worktree, projectPath, claimKind, authorityToken = null,
  expectedScopeRecords = null, deps = {},
} = {}) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || typeof runId !== 'string' || runId === '' ||
      typeof worktree !== 'string' || !isAbsolute(worktree) ||
      typeof projectPath !== 'string' || !isAbsolute(projectPath) ||
      !['create', 'cleanup'].includes(claimKind) ||
      (authorityToken !== null && !TOKEN.test(authorityToken)) ||
      claimKind === 'create' && authorityToken === null ||
      claimKind === 'cleanup' && !Array.isArray(expectedScopeRecords)) return { ok: false, status: 'invalid' };
  const [canonicalStateRoot, canonicalWorktree, canonicalProjectPath] = await Promise.all([
    canonical(stateRoot),
    resolveSafeWorktree(stateRoot, worktree),
    canonical(projectPath),
  ]);
  if (canonicalStateRoot === null || canonicalWorktree === null || canonicalProjectPath === null) {
    return { ok: false, status: 'invalid' };
  }
  stateRoot = canonicalStateRoot;
  worktree = canonicalWorktree;
  projectPath = canonicalProjectPath;
  const selfPid = Number.isInteger(deps.selfPid) && deps.selfPid > 0 ? deps.selfPid : process.pid;
  const getStartTime = typeof deps.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime;
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  let startTime;
  try {
    startTime = await getStartTime(selfPid);
  } catch {
    return { ok: false, status: 'owner_identity_unavailable' };
  }
  if (typeof startTime !== 'string' || startTime === '') return { ok: false, status: 'owner_identity_unavailable' };
  const visible = await readLedger(stateRoot, deps?.ledgerOptions ?? {});
  if (visible.status === 'current' || visible.status === 'legacy') {
    const existing = visible.records.find((record) => isWorktreeScopeClaimRecord(record) &&
      record.claimKind === claimKind && record.authorityToken === authorityToken &&
      record.runId === runId && record.worktree === worktree && record.projectPath === projectPath &&
      record.pid === selfPid && record.startTime === startTime &&
      record.helperState === 'none' && record.effectState === 'none');
    if (existing !== undefined) {
      const claim = claimFromRecord(stateRoot, existing);
      const retried = await redurableClaim(claim, deps);
      return retried?.ok === true ? retried : {
        ...retried,
        published: true,
        commitUnknown: true,
        claim,
      };
    }
  }
  let tokenBytes;
  try {
    tokenBytes = randomBytes(32);
  } catch {
    return { ok: false, status: 'write_failed' };
  }
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) return { ok: false, status: 'write_failed' };
  const claimToken = tokenBytes.toString('hex');
  const claim = Object.freeze({
    stateRoot, runId, worktree, projectPath, claimKind, authorityToken, claimToken, pid: selfPid, startTime,
  });
  const row = {
    recordType: WORKTREE_SCOPE_CLAIM_RECORD_TYPE,
    worktreeClaimVersion: WORKTREE_SCOPE_CLAIM_VERSION,
    claimToken,
    claimKind,
    authorityToken,
    pid: selfPid,
    startTime,
    runId,
    ownerPid: selfPid,
    ownerStartTime: startTime,
    worktree,
    projectPath,
    helperPid: null,
    helperStartTime: null,
    helperState: 'none',
    effectState: 'none',
  };
  const expected = Array.isArray(expectedScopeRecords) ? snapshotBytes(expectedScopeRecords) : null;
  let acquired = false;
  let refusal = 'claim_busy';
  const updated = await updateRecords(stateRoot, (records) => {
    const scoped = records.filter((record) => sameScope(record, worktree));
    if (expected !== null && snapshotBytes(scoped) !== expected) {
      refusal = 'scope_changed';
      return { write: false };
    }
    if (scoped.some(isWorktreeScopeClaimRecord)) return { write: false };
    if (scoped.some((record) => typeof record.projectPath === 'string' && record.projectPath !== projectPath)) {
      refusal = 'scope_mismatch';
      return { write: false };
    }
    if (claimKind === 'create' && !scoped.some((record) => isWorktreeCreationAuthorityRecord(record) &&
        record.worktreeAuthorityToken === authorityToken && record.runId === runId &&
        record.projectPath === projectPath)) {
      refusal = 'authority_missing';
      return { write: false };
    }
    acquired = true;
    return [...records, row];
  }, durableOptions(deps));
  if (updated?.ok !== true) {
    if (updated?.published !== true) return mutationFailure(updated);
    const retried = await redurableClaim(claim, deps);
    return retried?.ok === true ? retried : {
      ...retried,
      published: true,
      commitUnknown: true,
      claim,
    };
  }
  return acquired ? { ok: true, claim } : { ok: false, status: refusal };
}

/**
 * Reaper-only generation takeover. Process liveness is proved outside the short ledger RMW, then
 * exact identities and the whole canonical-path scope snapshot are bound again here before a new
 * generation is published. A post-go/may-have-started claim is deliberately not recoverable.
 */
export async function takeoverWorktreeScopeClaim({
  expectedClaim,
  expectedScopeRecords,
  deadOwner,
  deadHelper = null,
  deps = {},
} = {}) {
  if (!validClaim(expectedClaim) || !Array.isArray(expectedScopeRecords) ||
      deadOwner?.pid !== expectedClaim.pid || deadOwner?.startTime !== expectedClaim.startTime) {
    return { ok: false, status: validClaim(expectedClaim) && Array.isArray(expectedScopeRecords)
      ? 'owner_liveness_unproven' : 'invalid' };
  }
  const [stateRoot, worktree, projectPath] = await Promise.all([
    canonical(expectedClaim.stateRoot),
    resolveSafeWorktree(expectedClaim.stateRoot, expectedClaim.worktree),
    canonical(expectedClaim.projectPath),
  ]);
  if (stateRoot === null || worktree === null || projectPath === null ||
      stateRoot !== expectedClaim.stateRoot || worktree !== expectedClaim.worktree ||
      projectPath !== expectedClaim.projectPath) return { ok: false, status: 'invalid' };

  const selfPid = Number.isInteger(deps.selfPid) && deps.selfPid > 0 ? deps.selfPid : process.pid;
  const getStartTime = typeof deps.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime;
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  let startTime;
  let tokenBytes;
  try {
    startTime = await getStartTime(selfPid);
    tokenBytes = randomBytes(32);
  } catch {
    return { ok: false, status: 'owner_identity_unavailable' };
  }
  if (typeof startTime !== 'string' || startTime === '' || !Buffer.isBuffer(tokenBytes) ||
      tokenBytes.length !== 32) return { ok: false, status: 'owner_identity_unavailable' };

  const expected = snapshotBytes(expectedScopeRecords);
  let nextClaim = null;
  let refusal = 'claim_missing';
  const updated = await updateRecords(stateRoot, (records) => {
    const scoped = records.filter((record) => sameScope(record, worktree));
    if (snapshotBytes(scoped) !== expected) {
      refusal = 'scope_changed';
      return { write: false };
    }
    if (scoped.some((record) => typeof record.projectPath === 'string' &&
        record.projectPath !== projectPath)) {
      refusal = 'scope_mismatch';
      return { write: false };
    }
    const current = scoped.find((record) => exactClaim(record, expectedClaim));
    if (current === undefined) return { write: false };
    if (current.helperState === 'started' || current.effectState === 'may_have_started') {
      refusal = 'effect_may_have_started';
      return { write: false };
    }
    if (current.helperPid !== null && (deadHelper?.pid !== current.helperPid ||
        deadHelper?.startTime !== current.helperStartTime)) {
      refusal = 'helper_liveness_unproven';
      return { write: false };
    }
    const claimToken = tokenBytes.toString('hex');
    nextClaim = Object.freeze({
      stateRoot,
      runId: current.runId,
      worktree,
      projectPath,
      claimKind: 'cleanup',
      authorityToken: current.authorityToken,
      claimToken,
      pid: selfPid,
      startTime,
    });
    const replacement = {
      ...current,
      claimToken,
      claimKind: 'cleanup',
      pid: selfPid,
      startTime,
      ownerPid: selfPid,
      ownerStartTime: startTime,
      helperPid: null,
      helperStartTime: null,
      helperState: 'none',
      effectState: 'none',
    };
    return records.map((record) => exactClaim(record, expectedClaim) ? replacement : record);
  }, durableOptions(deps));
  if (updated?.ok !== true) {
    if (updated?.published === true && nextClaim !== null) {
      const retried = await redurableClaim(nextClaim, deps);
      return retried?.ok === true ? retried : {
        ...retried,
        published: true,
        commitUnknown: true,
        claim: nextClaim,
      };
    }
    return mutationFailure(updated);
  }
  return nextClaim === null ? { ok: false, status: refusal } : { ok: true, claim: nextClaim };
}

async function mutateClaim(claim, transition, deps = {}, idempotentAbsent = false) {
  if (!validClaim(claim)) return { ok: false, status: 'invalid' };
  let found = false;
  let changed = false;
  let refused = 'claim_state_mismatch';
  const updated = await updateRecords(claim.stateRoot, (records) => {
    const next = records.flatMap((record) => {
      if (!exactClaim(record, claim)) return [record];
      found = true;
      const outcome = transition(record);
      if (outcome === undefined) return [record];
      changed = true;
      return outcome === null ? [] : [outcome];
    });
    return changed ? next : { write: false };
  }, durableOptions(deps));
  if (updated?.ok !== true) return mutationFailure(updated);
  if (changed) return { ok: true };
  if (found) return { ok: false, status: refused };
  const ledger = await readLedger(claim.stateRoot, deps?.ledgerOptions ?? {});
  if (idempotentAbsent && (ledger.status === 'current' || ledger.status === 'legacy') &&
      !ledger.records.some((record) => exactClaim(record, claim)) &&
      !ledger.records.some((record) => isWorktreeScopeClaimRecord(record) &&
        record.worktree === claim.worktree)) return { ok: true, status: 'already_absent' };
  return { ok: false, status: 'claim_missing' };
}

export function attachWorktreeClaimHelper(claim, helper, deps = {}) {
  if (!Number.isInteger(helper?.pid) || helper.pid <= 0 ||
      typeof helper?.startTime !== 'string' || helper.startTime === '') {
    return Promise.resolve({ ok: false, status: 'helper_identity_unavailable' });
  }
  return mutateClaim(claim, (row) => row.helperState === 'none'
    ? { ...row, helperPid: helper.pid, helperStartTime: helper.startTime, helperState: 'waiting' }
    : undefined, deps);
}

export function markWorktreeClaimHelperStarted(claim, helper, deps = {}) {
  return mutateClaim(claim, (row) => row.helperState === 'waiting' && row.helperPid === helper.pid &&
    row.helperStartTime === helper.startTime
    ? { ...row, helperState: 'started', effectState: 'may_have_started' } : undefined, deps);
}

export function markWorktreeClaimHelperSettled(claim, helper, deps = {}) {
  return mutateClaim(claim, (row) => ['waiting', 'started'].includes(row.helperState) &&
    row.helperPid === helper.pid && row.helperStartTime === helper.startTime
    ? { ...row, helperState: 'settled', effectState: 'settled' } : undefined, deps);
}

export function clearWorktreeClaimHelper(claim, helper, deps = {}) {
  return mutateClaim(claim, (row) => row.helperState === 'settled' && row.helperPid === helper.pid &&
    row.helperStartTime === helper.startTime
    ? { ...row, helperPid: null, helperStartTime: null, helperState: 'none', effectState: 'none' } : undefined, deps);
}

/** Pre-go authorization failure: caller may use this only after exact helper death is proved. */
export function clearWaitingWorktreeClaimHelper(claim, helper, deps = {}) {
  return mutateClaim(claim, (row) => row.helperState === 'waiting' && row.effectState === 'none' &&
    row.helperPid === helper.pid && row.helperStartTime === helper.startTime
    ? { ...row, helperPid: null, helperStartTime: null, helperState: 'none', effectState: 'none' } : undefined, deps);
}

/** Exact generation only; a late finisher cannot remove its successor. */
export function releaseWorktreeScopeClaim(claim, deps = {}) {
  return mutateClaim(claim, (row) => row.helperState === 'none' && row.effectState === 'none' &&
    row.helperPid === null && row.helperStartTime === null ? null : undefined, deps, true);
}

/** Cleanup success removes its exact claim and at most the exact bound authority token. */
export async function completeWorktreeScopeClaim(claim, deps = {}) {
  if (!validClaim(claim)) return { ok: false, status: 'invalid' };
  const completedRecords = Array.isArray(deps.completedRecords) ? deps.completedRecords : null;
  const expectedScopeRecords = Array.isArray(deps.expectedScopeRecords) ? deps.expectedScopeRecords : null;
  const completedTokens = completedRecords === null
    ? null : completedRecords.map((record) => JSON.stringify(record));
  const expectedScope = expectedScopeRecords === null
    ? null : snapshotBytes(expectedScopeRecords.filter((record) => !isWorktreeScopeClaimRecord(record)));
  let claimFound = false;
  let authorityFound = claim.authorityToken === null;
  let allowed = false;
  let refusal = 'claim_state_mismatch';
  const updated = await updateRecords(claim.stateRoot, (records) => {
    const claimRow = records.find((record) => exactClaim(record, claim));
    if (claimRow === undefined) return { write: false };
    claimFound = true;
    if (claimRow.helperState !== 'none' || claimRow.effectState !== 'none' ||
        claimRow.helperPid !== null || claimRow.helperStartTime !== null) return { write: false };
    const scopedWithoutClaim = records.filter((record) => sameScope(record, claim.worktree) &&
      !isWorktreeScopeClaimRecord(record));
    if (expectedScope !== null && snapshotBytes(scopedWithoutClaim) !== expectedScope) {
      refusal = 'scope_changed';
      return { write: false };
    }
    if (completedTokens !== null) {
      const visible = new Map();
      for (const record of scopedWithoutClaim) {
        const token = JSON.stringify(record);
        visible.set(token, (visible.get(token) ?? 0) + 1);
      }
      for (const token of completedTokens) {
        const count = visible.get(token) ?? 0;
        if (count === 0) {
          refusal = 'scope_changed';
          return { write: false };
        }
        visible.set(token, count - 1);
      }
    }
    if (claim.authorityToken !== null && !records.some((record) =>
      isWorktreeCreationAuthorityRecord(record) && record.worktree === claim.worktree &&
      record.worktreeAuthorityToken === claim.authorityToken)) return { write: false };
    allowed = true;
    const removals = completedTokens === null ? null : new Map();
    for (const token of completedTokens ?? []) removals.set(token, (removals.get(token) ?? 0) + 1);
    return records.filter((record) => {
      if (exactClaim(record, claim)) return false;
      const authority = claim.authorityToken !== null && isWorktreeCreationAuthorityRecord(record) &&
        record.worktree === claim.worktree && record.worktreeAuthorityToken === claim.authorityToken;
      if (authority) authorityFound = true;
      if (authority) return false;
      if (removals !== null) {
        const token = JSON.stringify(record);
        const count = removals.get(token) ?? 0;
        if (count > 0) {
          removals.set(token, count - 1);
          return false;
        }
      }
      return true;
    });
  }, durableOptions(deps));
  if (updated?.ok !== true) return mutationFailure(updated);
  if (allowed && authorityFound) return { ok: true };
  if (claimFound) return { ok: false, status: allowed ? 'authority_missing' : refusal };
  const ledger = await readLedger(claim.stateRoot, deps?.ledgerOptions ?? {});
  if ((ledger.status === 'current' || ledger.status === 'legacy') &&
      !ledger.records.some((record) => exactClaim(record, claim)) &&
      !ledger.records.some((record) => isWorktreeScopeClaimRecord(record) &&
        record.worktree === claim.worktree) &&
      (claim.authorityToken === null || !ledger.records.some((record) =>
        isWorktreeCreationAuthorityRecord(record) && record.worktree === claim.worktree &&
        record.worktreeAuthorityToken === claim.authorityToken))) return { ok: true, status: 'already_absent' };
  return { ok: false, status: 'claim_missing' };
}
