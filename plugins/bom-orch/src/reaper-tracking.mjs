import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { defaultGetStartTime } from './process-identity.mjs';
import {
  appendChildRecord,
  armEffectUnknownIntentRecords,
  disarmEffectUnknownIntentRecords,
  isWorktreeScopeClaimRecord,
  retainEffectUnknownRecords,
  updateRecords,
  upsertWorktreeRecord,
} from './reaper-ledger.mjs';
import { resolveSafeWorktree } from './worktree-paths.mjs';

const publicMutationResult = (updated) => updated?.ok === true
  ? true
  : updated?.stateSchema === undefined ? false : { ok: false, stateSchema: updated.stateSchema };

const publicDetailedMutationResult = (updated) => updated?.ok === true
  ? { ok: true }
  : {
      ok: false,
      status: typeof updated?.status === 'string' ? updated.status : 'write_failed',
      ...(updated?.reasonCode === undefined ? {} : { reasonCode: updated.reasonCode }),
      ...(updated?.stateSchema === undefined ? {} : { stateSchema: updated.stateSchema }),
    };

/**
 * 원장을 **쓰는** 쪽의 신원 주입 자리.
 *
 * `updateRecords` 는 lock 앞에서 현재 프로세스의 pid+시작 시각을 스스로 증명하고, 못 얻으면
 * `writer_identity_unavailable` 로 아무것도 쓰지 않는다(`src/reaper-ledger.mjs` `writerIdentityOf`).
 * 이 모듈의 `deps.getStartTime` 은 **행에 적히는 owner** 신원까지만 닿으므로, 그 자리를 따로
 * 넘겨주지 않으면 호출자가 무엇을 주입하든 writer 쪽은 실제 OS 프로브로만 답할 수 있다 —
 * 프로브를 못 쓰는 환경에서는 다섯 mutator 가 통째로 실패한다. 이웃 모듈들은 이미 같은 자리를
 * 갖고 있다(`src/worktree-authority.mjs` `durableOptions`, `src/reaper.mjs` `durableLedgerOptions`).
 *
 * ★ 여기서는 durability 플래그를 **더하지 않는다**. 이웃들이 fsync 를 켜는 이유는 그 행이 Git
 *   효과의 관문이기 때문이고, 이 다섯은 그 관문이 아니다. 아무도 주입하지 않으면 `undefined` 라
 *   오늘과 정확히 같은 기본값으로 쓴다.
 */
const ledgerOptionsOf = (deps) => (deps?.ledgerOptions !== null &&
  typeof deps?.ledgerOptions === 'object' ? deps.ledgerOptions : undefined);

/** 자식을 원장에 올리고, 끝나면 그 spawn 세대만 exact cleanup한다. */
export async function trackChild({ stateRoot, child, runId, worktree = null, deps = {} }) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  const pid = child?.pid;
  if (!Number.isInteger(pid)) return;

  const [startTime, ownerStartTime] = await Promise.all([
    getStartTime(pid).catch(() => null),
    getStartTime(selfPid).catch(() => null),
  ]);
  let tokenBytes;
  try {
    tokenBytes = randomBytes(32);
  } catch {
    return false;
  }
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) return false;

  const record = {
    childToken: tokenBytes.toString('hex'),
    pid,
    startTime: startTime ?? null,
    runId: typeof runId === 'string' ? runId : null,
    ownerPid: selfPid,
    ownerStartTime: ownerStartTime ?? null,
    spawnfile: typeof child.spawnfile === 'string' ? child.spawnfile : null,
    worktree: typeof worktree === 'string' ? worktree : null,
  };
  // intent의 mutable recovery 필드는 바뀔 수 있지만 token과 process/owner/scope 정체성은
  // 이 spawn generation에서 불변이다. typed row는 같은 pid/run이어도 절대 대상이 아니다.
  const sameChildGeneration = (candidate) => !isWorktreeScopeClaimRecord(candidate) &&
    candidate?.recordType === undefined && candidate.childToken === record.childToken &&
    candidate.pid === record.pid && candidate.startTime === record.startTime &&
    candidate.runId === record.runId && candidate.ownerPid === record.ownerPid &&
    candidate.ownerStartTime === record.ownerStartTime && candidate.spawnfile === record.spawnfile &&
    candidate.worktree === record.worktree;
  const remove = () => updateRecords(
    stateRoot,
    (records) => records.filter((candidate) => !sameChildGeneration(candidate)),
    ledgerOptionsOf(deps),
  );

  child.on('exit', () => remove());
  const registered = await appendChildRecord(stateRoot, record, ledgerOptionsOf(deps));
  // identity 조회 중 먼저 끝난 자식은 exit listener가 append 전에 헛돌았으므로 다시 정리한다.
  if (child.exitCode !== null || child.signalCode !== null) await remove();
  return publicMutationResult(registered);
}

/** effectful call 직전 30일 recovery intent를 durable ledger에 arm한다. */
export async function armEffectUnknownIntent({
  stateRoot, runId, worktree, projectPath, retainUntil, deps = {},
}) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : cryptoRandomBytes;
  const target = await resolveSafeWorktree(stateRoot, worktree);
  if (target === null || typeof runId !== 'string' || runId === '' ||
      typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath) ||
      !Number.isSafeInteger(retainUntil) || retainUntil < 0) return { ok: false, status: 'invalid' };
  let tokenBytes;
  try {
    tokenBytes = randomBytes(32);
  } catch {
    return { ok: false, status: 'write_failed' };
  }
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) return { ok: false, status: 'write_failed' };
  const token = tokenBytes.toString('hex');
  const ownerStartTime = await getStartTime(selfPid).catch(() => null);
  const updated = await armEffectUnknownIntentRecords(stateRoot, {
    recordType: 'effect_unknown_intent',
    intentToken: token,
    pid: selfPid,
    startTime: ownerStartTime ?? null,
    runId,
    ownerPid: selfPid,
    ownerStartTime: ownerStartTime ?? null,
    spawnfile: null,
    worktree: target,
    projectPath,
    purpose: 'effect_unknown',
    retainUntil,
  }, ledgerOptionsOf(deps));
  const result = publicDetailedMutationResult(updated);
  return result.ok ? { ...result, token } : result;
}

/** resolve/throw로 effect settlement가 확정된 stage만 자기 intent token을 내린다. */
export async function disarmEffectUnknownIntent({ stateRoot, runId, worktree, token, deps = {} }) {
  const target = await resolveSafeWorktree(stateRoot, worktree);
  if (target === null || typeof runId !== 'string' || runId === '' || !/^[0-9a-f]{64}$/.test(token ?? '')) {
    return { ok: false, status: 'invalid' };
  }
  return publicDetailedMutationResult(await disarmEffectUnknownIntentRecords(stateRoot, {
    runId, worktree: target, token,
  }, ledgerOptionsOf(deps)));
}

/** 회수되지 못한 worktree 자체를 durable recovery row로 upsert한다. */
export async function trackWorktree({
  stateRoot, runId, worktree, projectPath = null, purpose = null, retainUntil = null, deps = {},
}) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const target = await resolveSafeWorktree(stateRoot, worktree);
  if (target === null) return false;
  const ownerStartTime = await getStartTime(selfPid).catch(() => null);
  const updated = await upsertWorktreeRecord(stateRoot, {
    pid: selfPid,
    startTime: ownerStartTime ?? null,
    runId: typeof runId === 'string' ? runId : null,
    ownerPid: selfPid,
    ownerStartTime: ownerStartTime ?? null,
    spawnfile: null,
    worktree: target,
    projectPath: typeof projectPath === 'string' && projectPath !== '' && isAbsolute(projectPath)
      ? projectPath
      : null,
    purpose,
    retainUntil,
  }, ledgerOptionsOf(deps));
  return publicMutationResult(updated);
}

/** hard-stop effect-unknown 경계에서 child와 self recovery row를 한 RMW로 보존한다. */
export async function retainEffectUnknown({
  stateRoot, runId, worktree, projectPath, retainUntil, deps = {},
}) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const target = await resolveSafeWorktree(stateRoot, worktree);
  if (target === null || typeof runId !== 'string' || runId === '' ||
      typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath) ||
      !Number.isSafeInteger(retainUntil) || retainUntil < 0) return false;
  const ownerStartTime = await getStartTime(selfPid).catch(() => null);
  const updated = await retainEffectUnknownRecords(stateRoot, {
    runId,
    worktree: target,
    projectPath,
    retainUntil,
    recoveryRecord: {
      pid: selfPid,
      startTime: ownerStartTime ?? null,
      runId,
      ownerPid: selfPid,
      ownerStartTime: ownerStartTime ?? null,
      spawnfile: null,
      worktree: target,
      projectPath,
      purpose: 'effect_unknown',
      retainUntil,
    },
  }, ledgerOptionsOf(deps));
  return publicMutationResult(updated);
}
