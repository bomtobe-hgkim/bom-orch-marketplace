import { lstat, rm } from 'node:fs/promises';

import {
  isEffectUnknownIntentRecord,
  isWorktreeCreationAuthorityRecord,
  isWorktreeScopeClaimRecord,
  recordIsRetained,
} from './reaper-ledger.mjs';
import { defaultGetStartTime } from './process-identity.mjs';
import {
  acquireWorktreeScopeClaim,
  completeWorktreeScopeClaim,
  readWorktreeScope,
} from './worktree-scope-claim.mjs';
import { runClaimedGitEffect } from './worktree-git-effect.mjs';
import { isSafeWorktree } from './worktree-paths.mjs';

const sameRows = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const exactClaimRow = (record, claim) => isWorktreeScopeClaimRecord(record) &&
  record.claimToken === claim.claimToken && record.claimKind === claim.claimKind &&
  record.authorityToken === claim.authorityToken && record.runId === claim.runId &&
  record.worktree === claim.worktree && record.projectPath === claim.projectPath &&
  record.pid === claim.pid && record.startTime === claim.startTime &&
  record.ownerPid === claim.pid && record.ownerStartTime === claim.startTime;

const nonClaimRows = (records) => records.filter((record) => !isWorktreeScopeClaimRecord(record));

async function latestIdleClaim({ claim, expectedScopeRecords, deps }) {
  const readScope = deps.readWorktreeScope ?? readWorktreeScope;
  const latest = await readScope(claim.stateRoot, claim.worktree, deps.claimDeps ?? {});
  if (latest.status !== 'current' && latest.status !== 'legacy') return null;
  const claims = latest.records.filter(isWorktreeScopeClaimRecord);
  if (claims.length !== 1 || !exactClaimRow(claims[0], claim) ||
      claims[0].helperPid !== null || claims[0].helperStartTime !== null ||
      claims[0].helperState !== 'none' || claims[0].effectState !== 'none') return null;
  return sameRows(nonClaimRows(latest.records), nonClaimRows(expectedScopeRecords)) ? latest : null;
}

/**
 * Acquire the normal-removal fence from one latest canonical scope snapshot. Executable, retained,
 * ambiguous-authority, or cross-project scopes require startup reconciliation instead of guessing.
 */
export async function acquireCleanupWorktreeClaim({
  stateRoot, projectPath, worktree, runId, authority = null, deps = {},
}) {
  const readScope = deps.readWorktreeScope ?? readWorktreeScope;
  const acquireClaim = deps.acquireWorktreeScopeClaim ?? acquireWorktreeScopeClaim;
  const scope = await readScope(stateRoot, worktree, deps.claimDeps ?? {});
  if (scope.status !== 'current' && scope.status !== 'legacy') {
    return { ok: false, status: scope.status, stateSchema: scope.stateSchema };
  }
  const rows = nonClaimRows(scope.records);
  const claims = scope.records.filter(isWorktreeScopeClaimRecord);
  if (claims.length > 1) return { ok: false, status: 'claim_busy' };
  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
  if (rows.some((record) => isEffectUnknownIntentRecord(record) || recordIsRetained(record, nowMs) ||
      !isWorktreeCreationAuthorityRecord(record) && record.spawnfile !== null)) {
    return { ok: false, status: 'scope_busy' };
  }
  if (rows.some((record) => typeof record.projectPath === 'string' && record.projectPath !== projectPath)) {
    return { ok: false, status: 'scope_mismatch' };
  }
  const authorities = rows.filter(isWorktreeCreationAuthorityRecord);
  // Public/normal cleanup never manufactures authority from an empty ledger or from the current
  // tuple. It must carry the exact generation bound to the returned handle. Startup recovery is
  // the only path allowed to supply/take over a claim without this live-owner proof.
  if (authorities.length !== 1 || authority === null || typeof authority !== 'object') {
    return { ok: false, status: 'scope_busy' };
  }
  const selfPid = Number.isInteger(deps.claimDeps?.selfPid) && deps.claimDeps.selfPid > 0
    ? deps.claimDeps.selfPid : process.pid;
  const getStartTime = typeof deps.claimDeps?.getStartTime === 'function'
    ? deps.claimDeps.getStartTime : defaultGetStartTime;
  let selfStartTime;
  try {
    selfStartTime = await getStartTime(selfPid);
  } catch {
    selfStartTime = null;
  }
  if (authority.token !== authorities[0].worktreeAuthorityToken || authority.pid !== selfPid ||
      authority.startTime !== selfStartTime || authority.runId !== runId ||
      authority.worktree !== worktree || authority.projectPath !== projectPath ||
      authorities[0].pid !== selfPid || authorities[0].startTime !== selfStartTime ||
      authorities[0].projectPath !== projectPath || authorities[0].runId !== runId ||
      rows.some((record) => !isWorktreeCreationAuthorityRecord(record))) {
    return { ok: false, status: 'scope_busy' };
  }
  const existing = claims[0];
  const authorityToken = existing?.authorityToken ?? authorities[0]?.worktreeAuthorityToken ?? null;
  const claimed = await acquireClaim({
    stateRoot,
    projectPath,
    worktree,
    runId,
    claimKind: 'cleanup',
    authorityToken,
    expectedScopeRecords: scope.records,
    deps: deps.claimDeps ?? {},
  });
  return claimed?.ok === true
    ? { ok: true, claim: claimed.claim, expectedScopeRecords: rows }
    : claimed;
}

/**
 * Run and verify one exact worktree cleanup while an idle scope claim remains durable. The caller
 * owns settlement: creation/public cleanup can atomically complete below; startup keeps the claim
 * for its own post-effect latest-snapshot check.
 */
export async function cleanupClaimedWorktree({
  claim,
  expectedScopeRecords,
  listRegistered,
  unregister,
  sameWorktree = (left, right) => left === right,
  deps = {},
}) {
  if (claim === null || typeof claim !== 'object' || !Array.isArray(expectedScopeRecords) ||
      typeof listRegistered !== 'function' || typeof unregister !== 'function' ||
      !isSafeWorktree(claim.stateRoot, claim.worktree)) {
    return { removed: null, unregistered: null, status: 'invalid' };
  }
  if (await latestIdleClaim({ claim, expectedScopeRecords, deps }) === null) {
    return { removed: null, unregistered: null, status: 'claim_changed' };
  }
  const runEffect = deps.runClaimedGitEffect ?? runClaimedGitEffect;
  const effect = await runEffect({
    claim,
    operation: { kind: 'remove' },
    deps: deps.effectDeps ?? {},
  }).catch(() => null);
  // A missing/non-idle exact row means a helper or unknown writer can still mutate the target.
  // No parent-side filesystem or admin-directory mutation may begin in that state.
  if (await latestIdleClaim({ claim, expectedScopeRecords, deps }) === null) {
    return { removed: null, unregistered: null, status: 'effect_unknown', effect };
  }

  const removePath = deps.removePath ?? rm;
  await removePath(claim.worktree, { recursive: true, force: true }).catch(() => {});

  let listed = await listRegistered();
  if (listed?.ok === true && listed.entries.some((entry) => sameWorktree(entry.path, claim.worktree))) {
    await unregister();
    listed = await listRegistered();
  }
  const statPath = deps.statPath ?? lstat;
  const removed = await statPath(claim.worktree).then(
    () => false,
    (error) => error?.code === 'ENOENT' ? true : null,
  );
  const unregistered = listed?.ok === true
    ? !listed.entries.some((entry) => sameWorktree(entry.path, claim.worktree)) : null;
  return { removed, unregistered, status: 'verified', effect };
}

export function completeCleanupWorktreeClaim({ claim, expectedScopeRecords, completedRecords, deps = {} }) {
  const completeClaim = deps.completeWorktreeScopeClaim ?? completeWorktreeScopeClaim;
  return completeClaim(claim, {
    ...(deps.claimDeps ?? {}),
    expectedScopeRecords,
    completedRecords,
  });
}

/** End-to-end coordinator used by create failures, normal removal, and a reaper-held claim. */
export async function coordinateWorktreeCleanup({
  stateRoot,
  projectPath,
  worktree,
  runId,
  claim = null,
  expectedScopeRecords = null,
  settle = true,
  listRegistered,
  unregister,
  sameWorktree,
  deps = {},
}) {
  let activeClaim = claim;
  let expected = expectedScopeRecords;
  let acquiredHere = false;
  if (activeClaim === null) {
    const acquired = await acquireCleanupWorktreeClaim({
      stateRoot, projectPath, worktree, runId, authority: deps.authority ?? null, deps,
    });
    if (acquired?.ok !== true) {
      return { removed: null, unregistered: null, status: acquired?.status ?? 'claim_unavailable' };
    }
    activeClaim = acquired.claim;
    expected = acquired.expectedScopeRecords;
    acquiredHere = true;
  } else if (!Array.isArray(expected)) {
    const readScope = deps.readWorktreeScope ?? readWorktreeScope;
    const scope = await readScope(stateRoot, worktree, deps.claimDeps ?? {});
    if (scope.status !== 'current' && scope.status !== 'legacy') {
      return { removed: null, unregistered: null, status: scope.status };
    }
    expected = nonClaimRows(scope.records);
  }

  const cleaned = await cleanupClaimedWorktree({
    claim: activeClaim,
    expectedScopeRecords: expected,
    listRegistered,
    unregister,
    sameWorktree,
    deps,
  });
  if (settle !== true) {
    return { ...cleaned, claim: activeClaim, settled: false };
  }
  if (cleaned.removed !== true || cleaned.unregistered !== true) {
    // A known-ended helper is not a completed cleanup. Keep the exact fence durable while either
    // path or registration is present/unknown; releasing it would let a new producer race the
    // recovery observation and publish into the partially-cleaned scope.
    return { ...cleaned, claim: activeClaim, settled: false };
  }
  const completedRecords = activeClaim.claimKind === 'create'
    ? nonClaimRows(expected).filter((record) => isWorktreeCreationAuthorityRecord(record) &&
      record.worktreeAuthorityToken === activeClaim.authorityToken)
    : nonClaimRows(expected);
  const completed = await completeCleanupWorktreeClaim({
    claim: activeClaim,
    expectedScopeRecords: expected,
    completedRecords,
    deps,
  });
  return completed?.ok === true
    ? { ...cleaned, claim: activeClaim, settled: true }
    : { ...cleaned, claim: activeClaim, settled: false, status: completed?.status ?? 'settlement_unknown' };
}
