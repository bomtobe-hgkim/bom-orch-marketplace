import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { defaultGetStartTime } from './process-identity.mjs';
import {
  readLedger,
  isWorktreeCreationAuthorityRecord,
  isWorktreeScopeClaimRecord,
  updateRecords,
  WORKTREE_AUTHORITY_RECORD_TYPE,
  WORKTREE_AUTHORITY_VERSION,
} from './reaper-ledger.mjs';
import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { resolveSafeWorktree } from './worktree-paths.mjs';
import {
  acquireWorktreeScopeClaim,
  completeWorktreeScopeClaim,
  releaseWorktreeScopeClaim,
} from './worktree-scope-claim.mjs';
import { runClaimedGitEffect } from './worktree-git-effect.mjs';

const TOKEN = /^[0-9a-f]{64}$/;
const PENDING_PURPOSE = 'worktree_creation_pending';
const knownAuthorities = new Map();

const keyOf = ({ stateRoot, runId, worktree }) => `${stateRoot}\0${runId}\0${worktree}`;

function rememberAuthority(authority) {
  const key = keyOf(authority);
  const bucket = knownAuthorities.get(key) ?? new Map();
  bucket.set(authority.token, authority);
  knownAuthorities.set(key, bucket);
}

function forgetAuthority(authority) {
  const key = keyOf(authority);
  const bucket = knownAuthorities.get(key);
  if (bucket === undefined) return;
  bucket.delete(authority.token);
  if (bucket.size === 0) knownAuthorities.delete(key);
}

const mutationFailure = (updated) => ({
  ok: false,
  status: typeof updated?.status === 'string' ? updated.status : 'write_failed',
  ...(updated?.reasonCode === undefined ? {} : { reasonCode: updated.reasonCode }),
  ...(updated?.stateSchema === undefined ? {} : { stateSchema: updated.stateSchema }),
  ...(updated?.published === true ? { published: true } : {}),
  ...(updated?.commitUnknown === true ? { commitUnknown: true } : {}),
  ...(updated?.releaseReason === undefined ? {} : { releaseReason: updated.releaseReason }),
});

const durableOptions = (deps) => ({
  ...(deps?.ledgerOptions !== null && typeof deps?.ledgerOptions === 'object' ? deps.ledgerOptions : {}),
  fsync: true,
  syncDir: true,
  strictDurability: true,
});

export function worktreeAuthorityFailure(result) {
  const schema = result?.stateSchema;
  if (schema?.file === 'children.json' && schema.status === 'newer' &&
      Number.isInteger(schema.found) && Number.isInteger(schema.supported)) {
    return {
      ...fail(REASON.state_schema_newer, {
        file: schema.file,
        version: schema.found,
        supported: schema.supported,
      }),
      stateSchema: schema,
    };
  }
  return fail(REASON.state_recovery_intent_unavailable);
}

function validAuthority(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.stateRoot === 'string' && value.stateRoot !== '' && isAbsolute(value.stateRoot) &&
    typeof value.projectPath === 'string' && value.projectPath !== '' && isAbsolute(value.projectPath) &&
    typeof value.worktree === 'string' && value.worktree !== '' && isAbsolute(value.worktree) &&
    typeof value.runId === 'string' && value.runId !== '' &&
    (value.purpose === null || typeof value.purpose === 'string' && value.purpose !== '') &&
    Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.startTime === 'string' && value.startTime !== '' && TOKEN.test(value.token ?? '');
}

const exactAuthorityRecord = (record, authority) => isWorktreeCreationAuthorityRecord(record) &&
  record.worktreeAuthorityToken === authority.token && record.pid === authority.pid &&
  record.startTime === authority.startTime && record.ownerPid === authority.pid &&
  record.ownerStartTime === authority.startTime && record.runId === authority.runId &&
  record.worktree === authority.worktree && record.projectPath === authority.projectPath;

async function redurableAuthority(authority, deps) {
  let found = false;
  let authorityPurpose = null;
  const updated = await updateRecords(authority.stateRoot, (records) => {
    const record = records.find((candidate) => exactAuthorityRecord(candidate, authority));
    found = record !== undefined;
    authorityPurpose = record?.purpose ?? null;
    // 같은 generation의 같은 document bytes를 다시 file+directory fsync 한다. 새 token을
    // append하면 어느 세대가 durable한지 알 수 없으므로 visible exact row가 없으면 닫는다.
    return found ? records : { write: false };
  }, durableOptions(deps));
  if (updated?.ok !== true) return { ...mutationFailure(updated), authority, authorityPurpose };
  if (!found) return { ok: false, status: 'authority_missing', authority, authorityPurpose };
  rememberAuthority(authority);
  return { ok: true, status: 'redurable', authority, authorityPurpose };
}

/**
 * `git worktree add`보다 먼저 recovery 권위를 디스크에 고정한다.
 *
 * 이 행은 effect_unknown의 30일 격리가 아니다. 생성 호출의 결과를 모르는 프로세스 크래시만
 * 닫으므로 retention 없이 다음 부팅에서 바로 회수할 수 있는 worktree-only 행이다.
 */
export async function armWorktreeCreationAuthority({
  stateRoot, runId, worktree, projectPath, purpose = null, deps = {},
} = {}) {
  const target = await resolveSafeWorktree(stateRoot, worktree);
  if (target === null || typeof runId !== 'string' || runId === '' ||
      typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath) ||
      (purpose !== null && (typeof purpose !== 'string' || purpose === ''))) {
    return { ok: false, status: 'invalid' };
  }
  const selfPid = Number.isInteger(deps.selfPid) && deps.selfPid > 0 ? deps.selfPid : process.pid;
  const getStartTime = typeof deps.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime;
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  let tokenBytes;
  let ownerStartTime;
  try {
    ownerStartTime = await getStartTime(selfPid);
  } catch {
    return { ok: false, status: 'owner_identity_unavailable' };
  }
  if (typeof ownerStartTime !== 'string' || ownerStartTime === '') {
    return { ok: false, status: 'owner_identity_unavailable' };
  }
  const known = knownAuthorities.get(keyOf({ stateRoot, runId, worktree: target }));
  for (const existing of known?.values() ?? []) {
    if (existing.pid !== selfPid || existing.startTime !== ownerStartTime ||
        existing.projectPath !== projectPath || existing.purpose !== purpose) continue;
    const retried = await redurableAuthority(existing, deps);
    if (retried?.ok === true && retried.authorityPurpose !== PENDING_PURPOSE) continue;
    if (retried.status !== 'authority_missing') return retried?.ok === true ? retried : {
      ...retried,
      published: true,
      commitUnknown: true,
      authority: existing,
    };
    forgetAuthority(existing);
  }
  try {
    tokenBytes = randomBytes(32);
  } catch {
    return { ok: false, status: 'write_failed' };
  }
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) return { ok: false, status: 'write_failed' };
  const token = tokenBytes.toString('hex');
  const authority = Object.freeze({
    stateRoot,
    runId,
    worktree: target,
    projectPath,
    purpose,
    pid: selfPid,
    startTime: ownerStartTime,
    token,
  });
  const record = {
    recordType: WORKTREE_AUTHORITY_RECORD_TYPE,
    worktreeAuthorityVersion: WORKTREE_AUTHORITY_VERSION,
    pid: selfPid,
    startTime: ownerStartTime,
    runId,
    ownerPid: selfPid,
    ownerStartTime,
    spawnfile: null,
    worktree: target,
    projectPath,
    purpose: PENDING_PURPOSE,
    retainUntil: null,
    worktreeAuthorityToken: token,
  };
  let blockedByClaim = false;
  const updated = await updateRecords(stateRoot, (records) => {
    if (records.some((candidate) => isWorktreeScopeClaimRecord(candidate) && candidate.worktree === target)) {
      blockedByClaim = true;
      return { write: false };
    }
    return [...records, record];
  }, durableOptions(deps));
  if (updated?.ok !== true) {
    if (updated?.published !== true) return mutationFailure(updated);
    rememberAuthority(authority);
    const retried = await redurableAuthority(authority, deps);
    return retried?.ok === true ? retried : {
      ...retried,
      published: true,
      commitUnknown: true,
      authority,
    };
  }
  if (blockedByClaim) return { ok: false, status: 'claim_busy' };
  rememberAuthority(authority);
  return { ok: true, authority };
}

/** pending 행을 같은 lock/RMW 안에서 정상 추적 행으로 바꾼다. old 또는 new 중 하나는 항상 남는다. */
export async function promoteWorktreeCreationAuthority(authority, deps = {}) {
  if (!validAuthority(authority)) return { ok: false, status: 'invalid' };
  let matched = false;
  const updated = await updateRecords(authority.stateRoot, (records) => records.map((record) => {
    if (record.worktreeAuthorityToken !== authority.token || record.pid !== authority.pid ||
        record.runId !== authority.runId || record.worktree !== authority.worktree) return record;
    matched = true;
    return { ...record, purpose: authority.purpose };
  }), durableOptions(deps));
  if (updated?.ok !== true) return mutationFailure(updated);
  if (!matched) return { ok: false, status: 'authority_missing' };
  rememberAuthority(authority);
  return { ok: true };
}

/** 정확한 token의 행만 내린다. 틀린 token이나 쓰기 실패는 기존 recovery 권위를 보존한다. */
export async function settleWorktreeCreationAuthority(authority, deps = {}) {
  if (!validAuthority(authority)) return { ok: false, status: 'invalid' };
  const wasKnown = knownAuthorities.get(keyOf(authority))?.has(authority.token) === true;
  let matched = false;
  const updated = await updateRecords(authority.stateRoot, (records) => records.filter((record) => {
    const same = record.worktreeAuthorityToken === authority.token && record.pid === authority.pid &&
      record.runId === authority.runId && record.worktree === authority.worktree;
    if (same) matched = true;
    return !same;
  }), durableOptions(deps));
  if (updated?.ok !== true && updated?.published !== true) return mutationFailure(updated);
  if (!matched || updated?.ok !== true) {
    const visible = await readLedger(authority.stateRoot, deps?.ledgerOptions ?? {});
    const stillPresent = (visible.status === 'current' || visible.status === 'legacy') &&
      visible.records.some((record) => record.worktreeAuthorityToken === authority.token &&
        record.pid === authority.pid && record.runId === authority.runId && record.worktree === authority.worktree);
    if (stillPresent || visible.status === 'unreadable' || visible.status === 'version_skew' || !wasKnown) {
      return updated?.ok === true ? { ok: false, status: 'authority_missing' } : mutationFailure(updated);
    }
    forgetAuthority(authority);
    return { ok: true, status: 'already_absent' };
  }
  forgetAuthority(authority);
  return { ok: true };
}

/** 정상 remove가 받은 공개 핸들에는 token을 싣지 않는다. 같은 프로세스의 사설 권위를 찾아 내린다. */
export async function settleKnownWorktreeCreationAuthority({ stateRoot, runId, worktree, deps = {} } = {}) {
  const bucket = knownAuthorities.get(keyOf({ stateRoot, runId, worktree }));
  if (bucket === undefined) return { ok: true, status: 'not_tracked' };
  for (const authority of [...bucket.values()]) {
    const settled = await settleWorktreeCreationAuthority(authority, deps);
    if (settled.ok !== true) return settled;
  }
  return { ok: true };
}

export function knownWorktreeCreationAuthorities({ stateRoot, runId, worktree } = {}) {
  const bucket = knownAuthorities.get(keyOf({ stateRoot, runId, worktree }));
  return bucket === undefined ? [] : [...bucket.values()];
}

/** worktree 모듈이 생성 단계 전체에서 들고 다니는 사설 lifecycle state. */
export function createWorktreeAuthorityState(deps = {}) {
  const claimDeps = deps.worktreeClaimDeps ?? deps.worktreeAuthorityDeps ?? {};
  return {
    owned: false,
    effectStarted: false,
    durabilityUnknown: false,
    cleanup: null,
    authority: null,
    claim: null,
    authorityDeps: deps.worktreeAuthorityDeps ?? {},
    claimDeps,
    arm: deps.armWorktreeCreationAuthority ?? armWorktreeCreationAuthority,
    promote: deps.promoteWorktreeCreationAuthority ?? promoteWorktreeCreationAuthority,
    settle: deps.settleWorktreeCreationAuthority ?? settleWorktreeCreationAuthority,
    acquireClaim: deps.acquireWorktreeScopeClaim ?? acquireWorktreeScopeClaim,
    releaseClaim: deps.releaseWorktreeScopeClaim ?? releaseWorktreeScopeClaim,
    completeClaim: deps.completeWorktreeScopeClaim ?? completeWorktreeScopeClaim,
    runEffect: deps.runClaimedGitEffect ?? runClaimedGitEffect,
    effectDeps: {
      claimDeps,
      ...(deps.worktreeGitEffectDeps ?? {}),
    },
  };
}

export async function settleFailedWorktreeCreation(state) {
  if (state.authority === null) return;
  // rename 뒤 directory fsync가 실패한 generation은 visible 삭제를 다시 rename해도 그
  // 삭제 자체가 commit-unknown이다. 같은 bytes를 redurable하기 전에는 권위를 보존한다.
  if (state.durabilityUnknown) return;
  const cleanupVerified = state.cleanup?.removed === true && state.cleanup?.unregistered === true;
  // add 전 실패 또는 등록+경로 제거를 모두 관측한 실패만 내린다. 나머지는 다음 부팅 권위다.
  if (!state.effectStarted || cleanupVerified) {
    if (state.claim !== null) {
      const completed = await state.completeClaim(state.claim, state.claimDeps).catch(() => null);
      if (completed?.ok === true) {
        state.claim = null;
        await state.settle(state.authority, state.authorityDeps).catch(() => null);
      }
    } else {
      await state.settle(state.authority, state.authorityDeps).catch(() => null);
    }
  } else if (state.claim !== null) {
    // A known-ended helper leaves the claim idle; release that fence but retain the authority for
    // startup reconciliation. waiting/started/settled helper states atomically refuse this release.
    const released = await state.releaseClaim(state.claim, state.claimDeps).catch(() => null);
    if (released?.ok === true) state.claim = null;
  }
}
