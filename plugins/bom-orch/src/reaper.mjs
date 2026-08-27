import { isAbsolute } from 'node:path';
import { runGit } from './git.mjs';
import { sweepNpmCache } from './npm-cache-retention.mjs';
import { defaultGetStartTime, lookupProcess } from './process-identity.mjs';
import {
  completeRecords,
  isEffectUnknownIntentRecord,
  isWorktreeCreationAuthorityRecord,
  isWorktreeScopeClaimRecord,
  readLedger,
  readRecords,
  recordIsRetained,
} from './reaper-ledger.mjs';
import { classifyOwner, isOurProcess, treeKill } from './reaper-process.mjs';
import {
  sweepLogs,
  sweepPatches,
  sweepPlans,
  sweepRuns,
  sweepScratch,
  validRunId,
} from './run-retention.mjs';
import { sweepScratchRooms } from './scratch-rooms.mjs';
import {
  acquireWorktreeScopeClaim,
  completeWorktreeScopeClaim,
  readWorktreeScope,
  takeoverWorktreeScopeClaim,
} from './worktree-scope-claim.mjs';
// ★ 두 경로 술어는 잎(`src/worktree-paths.mjs`)에 산다. 이 파일에 두면 `src/worktree.mjs`
//   가 여기서 수입하게 되고, 그 방향 때문에 이 파일은 그쪽의 `removeWorktree` 를 부를 수
//   없다 — 그 막힘이 곧 「등록은 안 빠지는 회수」였다. 되돌리지 마라.
import { resolveSafeWorktree } from './worktree-paths.mjs';
// ★ **등록까지 빼는 유일한 정본**이다. 이 파일에 두 번째 사본(= `discard` 를 흉내 낸 것)을
//   기르지 마라 — 그 둘이 갈리는 순간 한쪽만 고쳐지고, 갈린 자리는 되돌릴 수 없는 삭제다.
import { removeWorktree as defaultRemoveWorktree } from './worktree.mjs';

export { defaultGetStartTime } from './process-identity.mjs';
export { classifyOwner, isOurProcess, resolvePosixKillTarget, treeKill } from './reaper-process.mjs';
export {
  armEffectUnknownIntent,
  disarmEffectUnknownIntent,
  retainEffectUnknown,
  trackChild,
  trackWorktree,
} from './reaper-tracking.mjs';
export { sweepLogs, sweepPatches, sweepPlans, sweepRuns, sweepScratch };

/**
 * 고아 프로세스 reaper.
 *
 * ★ 왜 child.kill() 로 부족한가: Node 에는 Win32 Job Object 등가물이 없다. 그건 부모가
 *   죽어도 OS 가 자식을 확실히 회수한다. 우리에겐 그게 없으므로 서버가 죽으면 델리게이트
 *   CLI 와 그 손자들이 그대로 남는다. 그래서 디스크에 원장을 남기고 다음 부팅에 훑는다.
 *
 * ★ 물려받는 미해결 한계: `taskkill /T` 는 **살아 있는** 부모-자식 트리만 훑는다. 중간
 *   프로세스가 이미 죽어 reparent 된 손자는 그 순회에 나타나지 않아 놓친다. POSIX 의
 *   프로세스 그룹 신호도 같다. 이 환경에서 고칠 방법이 없어 문서화만 한다.
 *
 * ★ 가장 비싼 실수는 남의 프로세스를 죽이는 것이다. 두 겹으로 막는다 — pid 재사용
 *   방어(isOurProcess)와 동시 세션 방어(classifyOwner). 아래 각 함수 주석 참고.
 */

/**
 * startup sweep 전체가 공유하는 **부팅 예산**. 두 수가 서로 다른 것을 막는다.
 *
 * ★ 왜 이 파일이 자기 수를 갖는가: 회수는 이제 git 을 부른다(`worktree remove --force` →
 *   실패하면 목록 조회 → 우리 것 하나뿐이면 `prune` → 다시 목록). 그 경로가 쓰는
 *   `src/worktree-patch.mjs` 의 `WORKTREE_TIMEOUT_MS` 는 **300,000 ms** 이고, 그 수의 근거는 큰
 *   저장소의 `worktree add`(= 전체 체크아웃)다 — 부팅 스윕에는 맞지 않는 근거다. 원장에
 *   죽은 기록이 N 개면 N × 5분이 된다. `src/server.mjs` 는 핸드셰이크와 스윕을 병렬로
 *   시작하지만 모든 CallTool 본문 앞에서 스윕에 합류하므로, 총예산이 없으면 첫 도구 호출이
 *   그 N배 시간에 그대로 묶인다.
 *
 *   - `WORKTREE_RECLAIM_TIMEOUT_MS` — git 호출 **하나**의 상한. 회수 하나가 부르는 것은
 *     최대 넷이므로 기록 하나의 최악은 그 네 배다.
 *   - `WORKTREE_RECLAIM_BUDGET_MS` — npm cache부터 원장/워크트리까지 이번 부팅 스윕의 총 시간.
 *     각 단계와 owner/child 프로브 앞뒤에 재므로 넘긴 뒤에는 다음 효과를 시작하지 않는다.
 *
 * ★ 예산을 넘긴 기록은 **버리는 것이 아니라 미루는 것**이다. 원장에 그대로 남으므로 다음
 *   부팅이 같은 자리에서 이어 한다. 손실이 없다는 것이 이 설계의 전부다 — 여기서 "이번에
 *   다 끝내겠다"고 버티면 부팅 경로가 사용자 저장소의 상태에 인질로 잡힌다.
 */
export const WORKTREE_RECLAIM_TIMEOUT_MS = 15_000;
export const WORKTREE_RECLAIM_BUDGET_MS = 60_000;

export { readRecords } from './reaper-ledger.mjs';

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

const exactClaimRow = (record, claim) => isWorktreeScopeClaimRecord(record) &&
  record.claimToken === claim.claimToken && record.claimKind === claim.claimKind &&
  record.authorityToken === claim.authorityToken && record.runId === claim.runId &&
  record.worktree === claim.worktree && record.projectPath === claim.projectPath &&
  record.pid === claim.pid && record.startTime === claim.startTime &&
  record.ownerPid === claim.pid && record.ownerStartTime === claim.startTime;

const sameRows = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function exactClaimIsLatest({ stateRoot, claim, expectedScopeRecords, claimDeps }) {
  const latest = await readWorktreeScope(stateRoot, claim.worktree, claimDeps);
  if (latest.status !== 'current' && latest.status !== 'legacy') return false;
  const claims = latest.records.filter(isWorktreeScopeClaimRecord);
  if (claims.length !== 1 || !exactClaimRow(claims[0], claim)) return false;
  return sameRows(
    latest.records.filter((record) => !isWorktreeScopeClaimRecord(record)),
    expectedScopeRecords.filter((record) => !isWorktreeScopeClaimRecord(record)),
  );
}

const durableLedgerOptions = (claimDeps) => ({
  ...(claimDeps?.ledgerOptions !== null && typeof claimDeps?.ledgerOptions === 'object'
    ? claimDeps.ledgerOptions : {}),
  fsync: true,
  syncDir: true,
  strictDurability: true,
});

/**
 * 부팅 시 한 번 훑는다. **절대 throw 하지 않는다** — 부팅 경로에서 불리므로 여기서
 * 던지면 서버가 안 뜬다.
 */
export async function sweepOrphans({
  stateRoot,
  deps = {},
  sweepPatches: shouldSweepPatches = true,
  sweepRuns: shouldSweepRuns = true,
  excludeRunId,
} = {}) {
  const result = {
    killed: [],
    stale: [],
    skipped: [],
    scratch: { removed: 0, checked: 0 },
    scratchRooms: { checked: 0, removed: 0, preserved: 0, newer: 0 },
    npmCache: { status: 'not_run', checked: 0, removed: 0, preserved: 0, claimed: 0 },
    // ★ 플래너 스크래치(WS4a 태스크 9). scratch 와 **같은 함수**를 지나므로 소유권 판정과 반환
    //   모양이 한 글자도 다르지 않다 — 엔진의 실행별 스윕 표에도 같은 행이 있다.
    plans: { removed: 0, checked: 0 },
    patches: { removed: 0, checked: 0 },
    // ★ 로그도 여기서 치운다(WS2 §5). scratch·patches 와 **같은 함수**를 지나므로 소유권 판정과
    //   반환 모양이 한 글자도 다르지 않다 — 엔진의 실행별 스윕 표에도 같은 행이 있다.
    logs: { removed: 0, checked: 0 },
    runs: { removed: [], checked: 0, skipped: [] },
  };
  try {
    const {
      getStartTime = defaultGetStartTime,
      treeKill: kill = treeKill,
      nowMs: getNowMs = Date.now,
      scratchSweep = sweepScratch,
      scratchRoomSweep = sweepScratchRooms,
      patchSweep = sweepPatches,
      logSweep = sweepLogs,
      planSweep = sweepPlans,
      runSweep = sweepRuns,
      npmCacheSweep = sweepNpmCache,
      removeWorktree: reclaimWorktree = defaultRemoveWorktree,
      runGit: git = runGit,
    } = deps;
    const claimDeps = deps?.scopeClaimDeps !== null && typeof deps?.scopeClaimDeps === 'object'
      ? deps.scopeClaimDeps : {};

    // ★ 원장 조회 **앞**이다. 원장이 비어 있어도 scratch 와 artifact 에는 평문 내용이
    //   남아 있을 수 있는데, 아래 early return 뒤에 두면 정확히 그 경우에 안 돈다.
    const nowMs = getNowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
        nowMs > Number.MAX_SAFE_INTEGER - WORKTREE_RECLAIM_BUDGET_MS) return result;
    const deadlineAt = nowMs + WORKTREE_RECLAIM_BUDGET_MS;
    const deadlineAuthority = { deadlineAt, clock: getNowMs };
    const getBoundedStartTime = (pid) => getStartTime(pid, deadlineAuthority);
    const remainingBudgetMs = () => {
      try {
        const observed = getNowMs();
        return !Number.isSafeInteger(observed) || observed < 0 || observed >= deadlineAt
          ? 0 : deadlineAt - observed;
      } catch {
        return 0;
      }
    };
    const budgetExpired = () => remainingBudgetMs() === 0;
    if (budgetExpired()) return result;
    result.npmCache = await npmCacheSweep(
      { stateRoot, nowMs, deadlineAt },
      { getStartTime, nowMs: getNowMs, clock: getNowMs, deadlineAt },
    );
    if (budgetExpired()) return result;
    result.scratch = await scratchSweep(stateRoot, nowMs, { deadlineAt, nowMs: getNowMs });
    if (budgetExpired()) return result;
    result.scratchRooms = await scratchRoomSweep(
      { stateRoot, nowMs, deadlineAt },
      { getStartTime, nowMs: getNowMs },
    );
    if (budgetExpired()) return result;
    // ★ scratch 와 **같은 자리**다: 원장 조회 앞이고, 남은 것이 평문이라는 이유도 같다.
    result.plans = await planSweep(stateRoot, nowMs, { deadlineAt, nowMs: getNowMs });
    if (budgetExpired()) return result;
    result.logs = await logSweep({ stateRoot, now: nowMs, deadlineAt, clock: getNowMs });
    if (budgetExpired()) return result;
    const hasExclusion = excludeRunId !== undefined;
    const artifactFlagsValid = typeof shouldSweepPatches === 'boolean' && typeof shouldSweepRuns === 'boolean';
    const exclusionValid = !hasExclusion || validRunId(excludeRunId);
    const exclusionUsable = exclusionValid && (shouldSweepPatches || shouldSweepRuns || !hasExclusion);
    if (artifactFlagsValid && exclusionUsable) {
      const options = hasExclusion ? { excludeRunId } : undefined;
      if (shouldSweepPatches) {
        if (budgetExpired()) return result;
        result.patches = await patchSweep(stateRoot, nowMs, {
          ...(options ?? {}), deadlineAt, nowMs: getNowMs,
        });
      }
      if (shouldSweepRuns) {
        if (budgetExpired()) return result;
        result.runs = await runSweep(stateRoot, nowMs, {
          ...(options ?? {}), deadlineAt, nowMs: getNowMs,
        });
      }
    }

    if (budgetExpired()) return result;
    const ledger = await readLedger(stateRoot);
    if (ledger.status === 'version_skew') {
      result.stateSchema = ledger.stateSchema;
      return result;
    }
    // pre-call intent는 정상적으로 child보다 먼저 append된다. 만료 뒤에도 그 디스크 순서를
    // 실행 순서로 쓰면 살아 있는 child의 발밑(worktree)을 먼저 지운다. 실행 가능한 행을
    // 먼저 회수하고 intent는 마지막에 worktree-only fallback으로 처리한다.
    const recordPriority = (record) => isWorktreeScopeClaimRecord(record)
      ? -1
      : isEffectUnknownIntentRecord(record)
      ? 2
      : isWorktreeCreationAuthorityRecord(record) ? 1 : 0;
    const records = [...ledger.records].sort((left, right) => recordPriority(left) - recordPriority(right));
    if (records.length === 0) return result;

    // Ledger keys are persisted strings, but filesystem aliases (junctions, 8.3 names, case) can
    // name the same worktree. Group on the canonical safe target so one alias cannot escape a
    // live claim held under another spelling. Non-canonical stored rows remain fail-closed because
    // the scope-claim CAS below compares the exact persisted snapshot.
    const scopeTargetByRecord = new Map();
    const scopeGroups = new Map();
    for (const record of ledger.records) {
      if (typeof record?.worktree !== 'string' || record.worktree === '') continue;
      if (budgetExpired()) {
        for (const pending of records) result.skipped.push(pending.pid);
        return result;
      }
      const target = await resolveSafeWorktree(stateRoot, record.worktree);
      if (target === null) continue;
      scopeTargetByRecord.set(record, target);
      const group = scopeGroups.get(target) ?? [];
      group.push(record);
      scopeGroups.set(target, group);
    }

    const authorityScopeKey = (record) => `${record.runId}\0${record.worktree}`;
    const authorityGroups = new Map();
    for (const record of records) {
      if (!isWorktreeCreationAuthorityRecord(record)) continue;
      const key = authorityScopeKey(record);
      const group = authorityGroups.get(key) ?? { records: [], decision: null, attempted: false };
      group.records.push(record);
      authorityGroups.set(key, group);
    }
    const decideAuthorityGroup = async (group) => {
      if (group.decision !== null) return group.decision;
      if (new Set(group.records.map((record) => record.projectPath)).size !== 1 ||
          group.records.some((record) => recordIsRetained(record, nowMs))) {
        group.decision = 'defer';
        return group.decision;
      }
      for (const authority of group.records) {
        if (budgetExpired()) return 'budget';
        const live = await lookupProcess(getBoundedStartTime, authority.ownerPid);
        if (classifyOwner(authority, live) !== 'dead') {
          group.decision = 'defer';
          return group.decision;
        }
      }
      group.decision = 'stale';
      return group.decision;
    };

    const deferFrom = (index) => {
      for (let rest = index; rest < records.length; rest += 1) result.skipped.push(records[rest].pid);
    };
    if (budgetExpired()) {
      deferFrom(0);
      return result;
    }
    const completed = [];
    const durablyCompleted = new Set();
    const reclaimedWorktrees = new Set();
    const blockedWorktrees = new Set();
    const readyRecords = new Set();
    const takeoverProofs = new Map();

    const settleClaimedScope = async ({ record, target, expectedScopeRecords, claim }) => {
      if (!await exactClaimIsLatest({ stateRoot, claim, expectedScopeRecords, claimDeps })) return false;
      const reclaimed = await reclaimTrackedWorktree({
        target,
        stateRoot,
        record,
        reclaimWorktree,
        git,
        remainingBudgetMs,
        claim,
        expectedScopeRecords,
        effectBudget: { ...deadlineAuthority, timeoutMs: WORKTREE_RECLAIM_TIMEOUT_MS },
      });
      // Once a destructive effect was attempted, this boot must not try the same scope through a
      // second stale row even when durable settlement remains unknown.
      blockedWorktrees.add(target);
      if (!reclaimed) return false;
      // The pre-effect check closes stale boot snapshots; this second check closes writers that
      // raced the effect itself. Until every producer refuses a held claim, an unexpected row can
      // still appear here. Preserve both the old recovery rows and the claim instead of declaring
      // the deleted scope settled underneath that new row.
      if (!await exactClaimIsLatest({ stateRoot, claim, expectedScopeRecords, claimDeps })) return false;

      // Keep the claim present while exact stale rows are removed. A takeover of a create claim
      // remains bound to its authority token, so its exact authority is removed atomically with
      // the claim by completeWorktreeScopeClaim rather than in this first RMW.
      const rowsToComplete = expectedScopeRecords.filter((candidate) =>
        !isWorktreeScopeClaimRecord(candidate) && !(claim.authorityToken !== null &&
          isWorktreeCreationAuthorityRecord(candidate) &&
          candidate.worktreeAuthorityToken === claim.authorityToken));
      if (rowsToComplete.length > 0) {
        const cleared = await completeRecords(stateRoot, rowsToComplete, durableLedgerOptions(claimDeps));
        if (cleared?.ok !== true) return false;
      }
      const settled = await completeWorktreeScopeClaim(claim, claimDeps);
      if (settled?.ok !== true) return false;
      for (const candidate of expectedScopeRecords) {
        if (!completed.includes(candidate)) completed.push(candidate);
        durablyCompleted.add(candidate);
      }
      reclaimedWorktrees.add(target);
      return true;
    };

    const acquireClaimForScope = async ({ record, target, expectedScopeRecords }) => {
      const projectPaths = [...new Set(expectedScopeRecords
        .map((candidate) => candidate?.projectPath)
        .filter((value) => typeof value === 'string' && value !== ''))];
      if (projectPaths.length !== 1 || !isAbsolute(projectPaths[0])) {
        return { ok: false, status: 'scope_mismatch' };
      }
      const projectPath = projectPaths[0];
      const existing = expectedScopeRecords.filter(isWorktreeScopeClaimRecord);
      if (existing.length > 1) return { ok: false, status: 'claim_busy' };
      if (existing.length === 1) {
        const proof = takeoverProofs.get(target);
        if (proof === undefined || proof.record !== existing[0]) {
          return { ok: false, status: 'claim_liveness_unproven' };
        }
        const taken = await takeoverWorktreeScopeClaim({
          expectedClaim: claimFromRecord(stateRoot, existing[0]),
          expectedScopeRecords,
          deadOwner: proof.deadOwner,
          deadHelper: proof.deadHelper,
          deps: claimDeps,
        });
        return { ...taken, projectPath };
      }
      const acquired = await acquireWorktreeScopeClaim({
        stateRoot,
        runId: record.runId,
        worktree: target,
        projectPath,
        claimKind: 'cleanup',
        authorityToken: null,
        expectedScopeRecords,
        deps: claimDeps,
      });
      return { ...acquired, projectPath };
    };

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (completed.includes(record)) continue;
      const recoveryIntent = isEffectUnknownIntentRecord(record);
      const creationAuthority = isWorktreeCreationAuthorityRecord(record);
      const scopeClaim = isWorktreeScopeClaimRecord(record);
      const authorityGroup = creationAuthority ? authorityGroups.get(authorityScopeKey(record)) : null;
      if (budgetExpired()) {
        deferFrom(index);
        break;
      }
      if (recordIsRetained(record, nowMs)) {
        result.skipped.push(record.pid);
        continue;
      }
      // Scope claims are fencing records, never executable child rows. Their pid identifies the
      // claim owner and helperPid (when present) identifies the only process whose liveness can
      // permit or block a takeover. The takeover path below handles them after exact revalidation.
      if (scopeClaim) {
        const target = scopeTargetByRecord.get(record);
        if (target === undefined || blockedWorktrees.has(target)) {
          result.skipped.push(record.pid);
          continue;
        }
        if (budgetExpired()) {
          deferFrom(index);
          break;
        }
        const ownerLive = await lookupProcess(getBoundedStartTime, record.ownerPid);
        if (classifyOwner(record, ownerLive) !== 'dead') {
          blockedWorktrees.add(target);
          result.skipped.push(record.pid);
          continue;
        }
        let deadHelper = null;
        if (record.helperPid !== null) {
          if (budgetExpired()) {
            deferFrom(index);
            break;
          }
          const helperLive = await lookupProcess(getBoundedStartTime, record.helperPid);
          if (helperLive === undefined || (helperLive !== null && isOurProcess({
            pid: record.helperPid,
            startTime: record.helperStartTime,
          }, helperLive))) {
            blockedWorktrees.add(target);
            result.skipped.push(record.pid);
            continue;
          }
          deadHelper = { pid: record.helperPid, startTime: record.helperStartTime };
        }
        // A helper that crossed the go boundary may have left an untracked Git child. No timeout
        // proves that effect absent, so this generation remains manual/fail-closed even if the
        // exact helper itself is now dead.
        if (record.helperState === 'started' || record.effectState === 'may_have_started') {
          blockedWorktrees.add(target);
          result.skipped.push(record.pid);
          continue;
        }
        if (budgetExpired()) {
          blockedWorktrees.add(target);
          result.skipped.push(record.pid);
          continue;
        }
        readyRecords.add(record);
        takeoverProofs.set(target, {
          record,
          deadOwner: { pid: record.pid, startTime: record.startTime },
          deadHelper,
        });
        const expectedScopeRecords = scopeGroups.get(target) ?? [record];
        if (!expectedScopeRecords.every((candidate) => readyRecords.has(candidate))) {
          result.skipped.push(record.pid);
          continue;
        }
        const taken = await acquireClaimForScope({ record, target, expectedScopeRecords });
        if (taken?.ok !== true || taken.claim === undefined) {
          blockedWorktrees.add(target);
          result.skipped.push(record.pid);
          continue;
        }
        const settled = await settleClaimedScope({
          record: { ...record, projectPath: taken.claim.projectPath },
          target,
          expectedScopeRecords,
          claim: taken.claim,
        });
        if (!settled) result.skipped.push(record.pid);
        continue;
      }
      if (authorityGroup !== null) {
        const decision = await decideAuthorityGroup(authorityGroup);
        if (decision === 'budget') {
          deferFrom(index);
          break;
        }
        if (decision === 'defer' || authorityGroup.attempted || authorityGroup.records[0] !== record) {
          result.skipped.push(record.pid);
          continue;
        }
        authorityGroup.attempted = true;
        for (const authority of authorityGroup.records) readyRecords.add(authority);
      }
      // intent는 worktree-only fallback이다. 같은 scope의 실행 가능한 행이 남아 있으면
      // 그 행의 더 긴 retention·process identity·kill 결과가 먼저다.
      if (recoveryIntent && records.some((candidate) =>
        !isEffectUnknownIntentRecord(candidate) && candidate.runId === record.runId &&
        candidate.worktree === record.worktree && !readyRecords.has(candidate))) {
        result.skipped.push(record.pid);
        continue;
      }
      // A creation row is worktree-only authority. It must not reclaim beneath an executable
      // child whose kill/liveness outcome left that row incomplete, even when the authority
      // owner itself is stale. The child is the stronger proof for the same path.
      if (creationAuthority && records.some((candidate) =>
        !isEffectUnknownIntentRecord(candidate) && !isWorktreeCreationAuthorityRecord(candidate) &&
        !isWorktreeScopeClaimRecord(candidate) && candidate.worktree === record.worktree &&
        !readyRecords.has(candidate))) {
        result.skipped.push(record.pid);
        continue;
      }
      if (creationAuthority && reclaimedWorktrees.has(scopeTargetByRecord.get(record))) {
        for (const authority of authorityGroup.records) {
          if (!completed.includes(authority)) completed.push(authority);
        }
        continue;
      }
      // owner/child 프로브도 원장 순회의 일부다. worktree가 없는 기록이라고 이 검사를
      // 건너뛰면 N개의 8초 프로브가 startup CallTool gate를 N×8초 붙잡는다.
      if (budgetExpired()) {
        deferFrom(index);
        break;
      }
      const ownerLive = await lookupProcess(getBoundedStartTime, record.ownerPid);
      const owner = classifyOwner(record, ownerLive);
      // 다른 세션이 아직 살아 있거나(alive), 그 상태를 알 수 없으면(unknown) 손대지
      // 않는다. 둘을 합치지 않고 똑같이 skipped 로 보고하는 이유는, 호출부·로그에서
      // "왜 안 치웠나"를 알 수 있어야 하기 때문이다 — 조용한 continue 는 그 정보를
      // 버린다. 판정 자체는 classifyOwner 가 이미 세 갈래로 구분해 뒀다.
      if (owner === 'alive' || owner === 'unknown') {
        result.skipped.push(record.pid);
        continue;
      }

      if (budgetExpired()) {
        deferFrom(index);
        break;
      }
      // intent의 pid/startTime은 owner identity이지 process kill 권위가 아니다.
      const worktreeOnly = recoveryIntent || creationAuthority;
      const childLive = worktreeOnly ? null : await lookupProcess(getBoundedStartTime, record.pid);
      if (budgetExpired()) {
        deferFrom(index);
        break;
      }
      if (childLive === undefined) {
        // 모르는 것은 죽이지도 지우지도 않는다. 다음 부팅에 다시 본다.
        result.skipped.push(record.pid);
        continue;
      }

      if (childLive !== null && (
        typeof record.startTime !== 'string' || record.startTime === '' ||
        typeof childLive.startTime !== 'string' || childLive.startTime === ''
      )) {
        // 살아 있는 pid와 비교할 기록 identity가 없으면 stale라고 증명할 수 없다.
        result.skipped.push(record.pid);
        continue;
      }

      if (!worktreeOnly && childLive !== null && isOurProcess(record, childLive)) {
        // ★ kill 의 결과를 반드시 본다.
        //
        //   실패를 성공으로 보고하고 원장에서까지 지우면, 아직 살아 있는 자식이
        //   추적 대상에서 흔적도 없이 사라진다 — 다음 부팅에 다시 볼 기회도 없다.
        //   게다가 아래 워크트리 삭제까지 돌아, 아직 그 디렉터리를 쓰고 있는
        //   프로세스의 발밑을 빼버린다. 원본(BomPlugin)이 이 버그를 실제로 냈고
        //   "I4" 로 표시해 고쳤다. 실패하면 아무것도 건드리지 않고 다음 부팅에 맡긴다.
        const ok = await kill(record.pid, deadlineAuthority).catch(() => false);
        if (!ok) {
          result.skipped.push(record.pid);
          continue;
        }
        result.killed.push(record.pid);
      } else {
        // 이미 없거나 pid 가 재사용됐다. 무관한 프로세스를 죽이지 않는다.
        result.stale.push(record.pid);
      }
      readyRecords.add(record);

      // 프로세스만 치우고 워크트리를 남기면 디스크가 샌다.
      if (budgetExpired()) {
        deferFrom(index);
        break;
      }
      const hasWorktree = typeof record.worktree === 'string' && record.worktree !== '';
      const target = hasWorktree ? scopeTargetByRecord.get(record) ?? null : null;
      if (hasWorktree && target === null) continue;
      if (budgetExpired()) {
        deferFrom(index);
        break;
      }
      if (target !== null) {
        // 예산을 넘겼으면 **시작하지 않는다**. 현재와 남은 기록은 원장에 남아 다음 부팅이
        // 이어 한다 — 아래 break는 버리는 것이 아니다(위 상수 문단).
        if (budgetExpired()) {
          deferFrom(index);
          break;
        }
        if (blockedWorktrees.has(target)) {
          result.skipped.push(record.pid);
          continue;
        }
        const expectedScopeRecords = scopeGroups.get(target) ?? [record];
        if (!expectedScopeRecords.every((candidate) => readyRecords.has(candidate))) {
          result.skipped.push(record.pid);
          continue;
        }
        const acquired = await acquireClaimForScope({ record, target, expectedScopeRecords });
        if (acquired?.ok !== true || acquired.claim === undefined) {
          blockedWorktrees.add(target);
          result.skipped.push(record.pid);
          continue;
        }
        const settled = await settleClaimedScope({
          record: { ...record, projectPath: acquired.projectPath },
          target,
          expectedScopeRecords,
          claim: acquired.claim,
        });
        if (!settled) result.skipped.push(record.pid);
        continue;
      }
      if (!completed.includes(record)) completed.push(record);
    }

    // 시작된 회수의 CAS 정착은 deadline을 넘겼어도 끝낸다. 이 쓰기를 생략하면 이미 지운
    // worktree 행까지 다음 startup이 다시 시도하며, cooperative stop이 durable settlement를 잃는다.
    const pendingCompletion = completed.filter((record) => !durablyCompleted.has(record));
    // ★ 이 쓰기도 :340 의 형제처럼 **신원 seam 과 내구성**을 같이 받는다. 안 받으면
    //   `updateRecords` 가 lock 앞에서 writer 신원을 실제 OS 프로브로만 물을 수 있고, 그것을 못
    //   쓰는 호스트에서는 `writer_identity_unavailable` 로 **아무것도 안 쓴다** — 그런데 반환값을
    //   버리므로 스윗은 성공을 보고하고 행은 그대로 남는다. worktree 를 가진 행은 :340 을
    //   지나서 멀지만, `worktree: null` 인 순수 child 행은 이 자리가 유일한 완료 경로다.
    if (pendingCompletion.length > 0) {
      await completeRecords(stateRoot, pendingCompletion, durableLedgerOptions(claimDeps));
    }
  } catch {
    // 부팅을 막지 않는다.
  }
  return result;
}

/**
 * 넘겨받은 워크트리 하나를 회수한다 — **등록을 먼저 빼고 디렉터리는 그 다음**이다.
 *
 * ★ 여기가 P2 의 자리다. 예전에는 `rm(target, {recursive, force})` 한 줄이었고, 그러면
 *   디렉터리는 사라지지만 `git worktree list` 의 항목은 남는다. 그 등록을 회수하는 유일한
 *   다른 자리(`src/worktree.mjs` 의 「**같은** worktreePath 를 새 실행이 다시 쓸 때」)는
 *   runId 가 매번 달라 절대 불리지 않으므로, 핸드오프가 일어난 실행마다 죽은 항목이 하나씩
 *   사용자의 저장소에 **영구히** 쌓였다.
 *
 * ★ `projectPath` 가 없는 옛 기록 하나만으로는 삭제하지 않는다. 같은 canonical scope의
 *   다른 typed 행들이 **유일한** projectPath를 제공할 때만 그 값을 쓴다. 예전의 rm-only
 *   fallback은 등록을 남기는 문제보다 더 크다 — live claim/새 creator와 같은 경로를 쓰는
 *   legacy 행이 그 발밑을 claim 없이 지울 수 있었다. 권위를 못 찾으면 다음 부팅에 미룬다.
 *
 * @returns 이 기록을 원장에서 지워도 되는가.
 *   - 디렉터리가 남았으면(`removed !== true`) 거짓 — 오늘과 같다.
 *   - 등록이 **아직 있다고 관측되면**(`unregistered === false`) 거짓. 그 기록은 남고 다음
 *     부팅이 다시 본다 — `worktree remove --force` 가 실패한 채로 등록만 남았으면
 *     `discard` 가 **우리 admin 항목 하나만** 지운다(전역 prune 은 이 경로에서 금지다,
 *     `allowGlobalPrune:false` 아래 참조). 우리 것을 못 짚으면 또 미룬다 — 그것도 의도다.
 *   - `unregistered === null`(= 목록 조회 자체가 실패, 저장소를 못 읽는다)이면 모름이다.
 *     등록이 남았을 가능성이 있으므로 원장의 recovery 권위를 보존하고 다음 부팅에 다시 본다.
 */
async function reclaimTrackedWorktree({
  target, stateRoot, record, reclaimWorktree, git, remainingBudgetMs, claim, expectedScopeRecords, effectBudget,
}) {
  const projectPath = record?.projectPath;
  if (typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath)) {
    return false;
  }
  const result = await reclaimWorktree(
    { path: target, projectPath, stateRoot },
    // ★ git 호출마다 상한을 다시 씌운다. `src/worktree-patch.mjs` 는 `WORKTREE_TIMEOUT_MS`(5분)를
    //   자기 인자로 박아 넘기는데, 그 수의 근거(큰 저장소의 전체 체크아웃)는 부팅 스윕의
    //   근거가 아니다. 여기서 덮지 않으면 위 총 예산이 기록 하나에 통째로 먹힌다.
    // ★ 부팅 경로는 사용자 저장소에 **전역 `git worktree prune` 을 절대 걸지 않는다**(P2 리뷰
    //   I-3). 그 명령의 `--expire` 는 TIME_MAX 라 그 순간 prunable 인 남의 항목까지 admin
    //   디렉터리째 지운다. 부팅 스윕은 첫 도구 본문보다 앞서므로 사용자가 그 창에 개입할 수도
    //   없다. 등록을 빼야 할 때는 `worktree.mjs` 가 우리 항목 하나만 지운다.
    {
      run: (options) => {
        const timeoutMs = Math.min(WORKTREE_RECLAIM_TIMEOUT_MS, remainingBudgetMs());
        if (timeoutMs === 0) throw new Error('startup reclaim deadline expired');
        return git({ ...options, timeoutMs });
      },
      allowGlobalPrune: false,
      worktreeEffectBudget: effectBudget,
      ...(claim === null ? {} : {
        worktreeScopeClaim: claim,
        worktreeScopeRecords: expectedScopeRecords,
      }),
    },
  ).catch(() => null);
  return result?.ok === true && result.removed === true && result.unregistered === true;
}
