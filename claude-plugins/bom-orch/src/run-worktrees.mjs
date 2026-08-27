/**
 * 이 실행의 **레인 워크트리**를 만들고, 검증하고, 거부에 도로 치운다 — lane-a 하나(baseline 을
 * 낳는 자리)와 c2 의 lane-b(그 baseline 을 공유하는 자리), 그리고 준비 단계의 회수 규칙 하나.
 * 벤더가 만져도 되는 디스크는 여기서 나고, 여기서 사라진다.
 *
 * WS8 컷 2 가 `src/engine.mjs` 의 `prepareRunNamespace` 에서 뽑았다(로드맵 §3.11).
 *
 * ★★ **왜 별도 모듈인가.** 워크트리는 이 실행이 남기는 **유일한 바깥 부작용**이고, 그래서 만드는
 *   자리와 치우는 자리가 한 파일에 있어야 한다. 준비 단계의 거부는 전부 「방금 만든 것을 도로
 *   치우고 못 치웠으면 리퍼에게 넘긴다」는 같은 규율을 따르는데(`handoffNotice`), 그 규율이
 *   엔진 본문에 흩어져 있는 동안 세 갈래가 각자 조금씩 다른 사본을 들고 있었다. **새 워크트리
 *   준비 코드는 이 파일로 들어간다.**
 *
 * ★ 핸들 스냅샷 넷(`snapshotWorktreeHandle`·`provenOwnedWorktreeForCleanup` 과 그 재료 둘)이
 *   함께 온 이유: 부르는 자리가 이 파일뿐이다. `snapshotBlockedResult` 만 `export` 인데,
 *   산출물 저장소 초기화(엔진)가 같은 술어를 쓰기 때문이다 — 사본을 만들면 두 자리가 갈린다.
 *
 * ★ 회수는 `createWorktreeCleanup` 이 만드는 **함수 하나**다. 준비 단계의 열 몇 자리가 그
 *   함수를 부르는데, 갈래마다 새로 적으면 「지웠다/못 지웠다/넘겼다」의 세 문장이 갈린다.
 *
 * ★ `envelopeExtras` 는 함수로 받는다(`src/run-precredit-gates.mjs` 와 같은 규약) — 스윕 요약이
 *   앞에 붙는 것은 부르는 자리가 아는 사실이다. 알림이 하나도 없는 갈래는 **인자 없이** 부르므로
 *   그 함수는 빈 목록을 기본값으로 받아야 한다(실측: 그것을 빠뜨리면 회수된 프록시 핸들 하나가
 *   `invalid_worktree_handle` 대신 `failed` 봉투로 나갔다). 반환도 같다: `{ refusal, laneWorktree }`.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지).
 */
import { join } from 'node:path';
import { snapshotRemovalResult } from './artifact-settlement.mjs';
import { trackWorktree as defaultTrackWorktree } from './reaper.mjs';
import { REASON } from './reason-codes.mjs';
import { artifactBlocked, handoffNotice, reasonCodeOf } from './run-faults.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { exactDenseArray, ownDataValue, snapshotOwnDataObject } from './util/objects.mjs';
import { boundedText } from './util/strings.mjs';
import {
  createRevisionWorktree as defaultCreateRevisionWorktree,
  createWorktree as defaultCreateWorktree,
  makeWorktreeId,
  removeWorktree as defaultRemoveWorktree,
  worktreeSeamDeps,
} from './worktree.mjs';
import { transferWorktreeAuthority } from './worktree-handle-authority.mjs';

const WORKTREE_HANDLE_KEYS = Object.freeze([
  'ok', 'path', 'projectPath', 'stateRoot', 'runId', 'worktreeId', 'purpose', 'baseline',
  'baselineIdentity', 'lastSnapshot', 'transplanted', 'dirtyFiles', 'ignoredPaths', 'sharedRules',
]);

export function snapshotBlockedResult(value) {
  if (value === null || typeof value !== 'object') return null;
  const raw = snapshotOwnDataObject(value, ['blocked', 'hardStopped', 'error', 'recovery']);
  if (raw === null) return null;
  return {
    blocked: raw.blocked === true,
    hardStopped: raw.hardStopped === true,
    error: typeof raw.error === 'string' ? raw.error : null,
    recovery: typeof raw.recovery === 'string' ? raw.recovery : null,
  };
}

/**
 * 배열 래퍼는 이 파일 것이고 원소 검사는 공유 `boundedText` 다. 빈 문자열은 계속 통과한다
 * (`allowEmpty`) — 그 자리는 `ignoredPaths`/`sharedRules` 이고, 빈 원소를 새로 거부하면
 * 이 태스크가 겨냥하지 않은 `invalid_worktree_handle` 이 생긴다.
 */
function snapshotBoundedStrings(value) {
  if (value === null) return null;
  const values = exactDenseArray(value);
  if (values === null || values.length > 10_000 ||
      values.some((entry) => boundedText(entry, 32_768, { allowEmpty: true }) === null)) return undefined;
  return deepFreeze([...values]);
}

function snapshotWorktreeHandle(handle, expected) {
  try {
  const raw = handle !== null && typeof handle === 'object' && !Array.isArray(handle)
    ? snapshotOwnDataObject(handle, WORKTREE_HANDLE_KEYS)
    : null;
  if (raw === null || WORKTREE_HANDLE_KEYS.some((key) => !Object.hasOwn(raw, key))) return null;
  const baselineIdentity = raw.baselineIdentity !== null && typeof raw.baselineIdentity === 'object' &&
    !Array.isArray(raw.baselineIdentity)
    ? snapshotOwnDataObject(raw.baselineIdentity, ['commit', 'tree'])
    : null;
  const ignoredPaths = snapshotBoundedStrings(raw.ignoredPaths);
  const sharedRules = snapshotBoundedStrings(raw.sharedRules);
  // ★ 봉투의 `baseline.dirtyFiles` 가 여기서 난다(WS5 태스크 6). 형제 둘과 **같은** 유계를
  //   쓴다 — 봉투 쪽 상한(10건 × 256자)은 투영이 걸고, 이 자리는 핸들이 사방으로 커지는 것만
  //   막는다. `null`("확인하지 못했다")은 형제와 같은 이유로 계속 통과한다.
  const dirtyFiles = snapshotBoundedStrings(raw.dirtyFiles);
  const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (raw.ok !== true || raw.path !== expected.path || raw.projectPath !== expected.projectPath ||
      raw.stateRoot !== expected.stateRoot || raw.runId !== expected.runId ||
      raw.worktreeId !== expected.worktreeId || raw.purpose !== expected.purpose ||
      !objectId.test(raw.baseline) || raw.lastSnapshot !== raw.baseline ||
      baselineIdentity === null || !objectId.test(baselineIdentity.commit) || !objectId.test(baselineIdentity.tree) ||
      baselineIdentity.commit !== raw.baseline ||
      expected.baseline !== null && (raw.baseline !== expected.baseline.commit ||
        baselineIdentity.tree !== expected.baseline.tree) ||
      typeof raw.transplanted !== 'boolean' || expected.transplanted !== null && raw.transplanted !== expected.transplanted ||
      dirtyFiles === undefined || ignoredPaths === undefined || sharedRules === undefined ||
      // ★★ 「이식할 것이 있었다」와 「이식된 파일 목록」은 한 측정이다(`src/worktree.mjs`
      //   transplant 의 ★★). 이식하지 않은 핸들이 목록을 들고 오면 그 핸들은 손상된 것이고,
      //   그것을 통과시키면 봉투가 `dirty: false` 옆에 파일 이름을 싣는다.
      raw.transplanted === false && dirtyFiles !== null && dirtyFiles.length > 0) return null;
  const clone = {
    ok: true,
    path: raw.path,
    projectPath: raw.projectPath,
    stateRoot: raw.stateRoot,
    runId: raw.runId,
    worktreeId: raw.worktreeId,
    purpose: raw.purpose,
    baseline: raw.baseline,
    baselineIdentity: deepFreeze({ ...baselineIdentity }),
    lastSnapshot: raw.lastSnapshot,
    transplanted: raw.transplanted,
    dirtyFiles,
    ignoredPaths,
    sharedRules,
  };
  for (const key of Reflect.ownKeys(clone)) {
    const descriptor = Object.getOwnPropertyDescriptor(clone, key);
    Object.defineProperty(clone, key, {
      ...descriptor,
      writable: key === 'lastSnapshot',
      configurable: false,
    });
  }
  Object.preventExtensions(clone);
  transferWorktreeAuthority(handle, clone);
  return clone;
  } catch {
    return null;
  }
}

function provenOwnedWorktreeForCleanup(handle, expected) {
  let authority;
  try {
    authority = Object.fromEntries(
      ['ok', 'path', 'projectPath', 'stateRoot', 'runId', 'worktreeId', 'purpose']
        .map((key) => [key, ownDataValue(handle, key)]),
    );
  } catch {
    return null;
  }
  if (authority.ok.ok !== true || authority.ok.value !== true ||
      authority.path.ok !== true || authority.path.value !== expected.path ||
      authority.projectPath.ok !== true || authority.projectPath.value !== expected.projectPath ||
      authority.stateRoot.ok !== true || authority.stateRoot.value !== expected.stateRoot ||
      authority.runId.ok !== true || authority.runId.value !== expected.runId ||
      authority.worktreeId.ok !== true || authority.worktreeId.value !== expected.worktreeId ||
      authority.purpose.ok !== true || authority.purpose.value !== expected.purpose) return null;
  const clone = {
    ok: true,
    path: expected.path,
    projectPath: expected.projectPath,
    stateRoot: expected.stateRoot,
    runId: expected.runId,
    worktreeId: expected.worktreeId,
    purpose: expected.purpose,
    baseline: expected.baseline?.commit ?? null,
    baselineIdentity: expected.baseline,
    lastSnapshot: expected.baseline?.commit ?? null,
    transplanted: expected.transplanted === true,
    // 이 핸들은 **정리 전용**이라 목록을 낼 자리가 없다 — 형제 둘과 같은 이유로 빈 배열이다.
    dirtyFiles: [],
    ignoredPaths: [],
    sharedRules: [],
  };
  transferWorktreeAuthority(handle, clone);
  return clone;
}

/**
 * 준비 단계의 워크트리 회수 **한 자리**. 지운 것은 조용히 지나가고, 못 지운 것은 리퍼에게
 * 넘긴 뒤 그 사실을 알림으로 낸다 — 「어디에 남았는가」가 사라지는 갈래를 만들지 않는다.
 */
export function createWorktreeCleanup({ stateRoot, runId, deps, recoveryStage }) {
  return async (worktrees, label) => {
    const unique = [];
    const paths = new Set();
    for (const worktree of worktrees) {
      if (worktree?.ok !== true || typeof worktree.path !== 'string' || paths.has(worktree.path)) continue;
      paths.add(worktree.path);
      unique.push(worktree);
    }
    const notices = [];
    for (const worktree of unique) {
      const removal = snapshotRemovalResult(await recoveryStage(`${label} cleanup`, () =>
        (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null));
      const removed = removal.ok === true && removal.removed === true && removal.unregistered === true;
      if (removed) continue;
      const tracked = await recoveryStage(`${label} handoff`, () =>
        (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: worktree.path, projectPath: worktree.projectPath })).catch(() => false);
      notices.push(handoffNotice(tracked, worktree.path));
    }
    return { paths: unique.map((value) => value.path), notices };
  };
}

/**
 * lane-a 워크트리 하나 — 이 실행의 **baseline 이 태어나는 자리**다. 실패 셋(던짐·하드스톱·거부)과
 * 손상된 핸들 하나가 각자 자기 사유로 끝나고, 넷 다 만들다 만 워크트리를 도로 치운다.
 */
export async function createLaneAWorktree({
  projectPath, canonicalProject, stateRoot, runId, deps, stage, recoveryStage, runHalt, envelopeExtras,
}) {
  const createWorktree = deps.createWorktree ?? defaultCreateWorktree;
  const laneAExpected = {
    path: join(stateRoot, 'worktrees', makeWorktreeId({ runId, purpose: 'lane-a' })),
    projectPath: canonicalProject,
    stateRoot,
    runId,
    worktreeId: makeWorktreeId({ runId, purpose: 'lane-a' }),
    purpose: 'lane-a',
    baseline: null,
    transplanted: null,
  };
  let laneWorktree;
  try {
    laneWorktree = await stage('lane-a worktree creation', () => createWorktree({
      projectPath, stateRoot, runId, worktreeId: laneAExpected.worktreeId, purpose: 'lane-a',
      deps: worktreeSeamDeps(deps),
    }), {
      onHardStop: (pending) => pending.then((late) => {
        const latePath = ownDataValue(late, 'path');
        const lateOk = ownDataValue(late, 'ok');
        if (lateOk.ok === true && lateOk.value === true && latePath.ok === true && latePath.value === laneAExpected.path) {
          return recoveryStage('late worktree handoff', () =>
            (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: laneAExpected.path, projectPath: laneAExpected.projectPath }));
        }
        return null;
      }).catch(() => null),
    });
  } catch {
    return { refusal: artifactBlocked(runId, REASON.worktree_handle_invalid, {}, envelopeExtras()) };
  }
  const laneAFailure = snapshotBlockedResult(laneWorktree);
  if (laneAFailure?.hardStopped === true) {
    const owned = provenOwnedWorktreeForCleanup(laneWorktree, laneAExpected);
    let cleanupNotice;
    if (owned !== null) {
      const removal = snapshotRemovalResult(await recoveryStage('hard-stopped lane-a worktree cleanup', () =>
        (deps.removeWorktree ?? defaultRemoveWorktree)(owned)).catch(() => null));
      if (!(removal.ok === true && removal.removed === true && removal.unregistered === true)) {
        const tracked = await recoveryStage('hard-stopped lane-a worktree handoff', () =>
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: owned.path, projectPath: owned.projectPath })).catch(() => false);
        cleanupNotice = handoffNotice(tracked, owned.path);
      }
    }
    return { refusal: runHalt({
      runId, extras: envelopeExtras(cleanupNotice ? [cleanupNotice] : []),
    }) };
  }
  if (laneAFailure?.blocked === true) {
    const owned = provenOwnedWorktreeForCleanup(laneWorktree, laneAExpected);
    let cleanupNotice;
    if (owned !== null) {
      const removal = snapshotRemovalResult(await recoveryStage('blocked lane-a worktree cleanup', () =>
        (deps.removeWorktree ?? defaultRemoveWorktree)(owned)).catch(() => null));
      if (!(removal.ok === true && removal.removed === true && removal.unregistered === true)) {
        const tracked = await recoveryStage('blocked lane-a worktree handoff', () =>
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: owned.path, projectPath: owned.projectPath })).catch(() => false);
        cleanupNotice = handoffNotice(tracked, owned.path);
      }
    }
    return { refusal: artifactBlocked(
      runId, reasonCodeOf(laneWorktree, REASON.worktree_creation_failed), { path: laneAExpected.path },
      envelopeExtras(cleanupNotice ? [cleanupNotice] : []),
    ) };
  }
  const preparedLaneA = snapshotWorktreeHandle(laneWorktree, laneAExpected);
  if (preparedLaneA === null) {
    const owned = provenOwnedWorktreeForCleanup(laneWorktree, laneAExpected);
    const cleanup = owned === null
      ? { paths: [], notices: [] }
      : await (async () => {
          const removal = snapshotRemovalResult(await recoveryStage('invalid lane-a worktree cleanup', () =>
            (deps.removeWorktree ?? defaultRemoveWorktree)(owned)).catch(() => null));
          const removed = removal.ok === true && removal.removed === true && removal.unregistered === true;
          if (removed) return { paths: [owned.path], notices: [] };
          const tracked = await recoveryStage('invalid lane-a worktree handoff', () =>
            (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: owned.path, projectPath: owned.projectPath })).catch(() => false);
          return { paths: [owned.path], notices: [handoffNotice(tracked, owned.path)] };
        })();
    return { refusal: artifactBlocked(runId, REASON.worktree_handle_invalid, {}, envelopeExtras(cleanup.notices)) };
  }
  return { refusal: null, laneWorktree: preparedLaneA };
}

/**
 * lane-b 워크트리 하나(c2 전용) — lane-a 가 고정한 **같은 baseline 커밋**에서 난다. 어긋나면
 * 두 레인이 다른 트리를 두고 A/B 를 하는 것이므로 실행을 끝낸다.
 */
export async function createLaneBWorktree({
  preparedLaneA, baseline, canonicalProject, stateRoot, runId, deps, stage, recoveryStage,
  cleanupWorktrees, runHalt, envelopeExtras,
}) {
  const createRevisionWorktree = deps.createRevisionWorktree ?? defaultCreateRevisionWorktree;
  const laneBExpected = {
    path: join(stateRoot, 'worktrees', makeWorktreeId({ runId, purpose: 'lane-b' })),
    projectPath: canonicalProject,
    stateRoot,
    runId,
    worktreeId: makeWorktreeId({ runId, purpose: 'lane-b' }),
    purpose: 'lane-b',
    baseline,
    transplanted: false,
  };
  let laneB;
  try {
    laneB = await stage('lane-b shared-baseline worktree creation', () => createRevisionWorktree({
    sourceWorktree: preparedLaneA,
    stateRoot,
    runId,
    purpose: 'lane-b',
    revision: baseline.commit,
  }, worktreeSeamDeps(deps)), {
    onHardStop: (pending) => pending.then((late) => {
      const latePath = ownDataValue(late, 'path');
      const lateOk = ownDataValue(late, 'ok');
      if (lateOk.ok === true && lateOk.value === true && latePath.ok === true && latePath.value === laneBExpected.path) {
        return recoveryStage('late lane-b worktree handoff', () =>
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: laneBExpected.path, projectPath: laneBExpected.projectPath }));
      }
      return null;
    }).catch(() => null),
    });
  } catch {
    const cleanup = await cleanupWorktrees([preparedLaneA], 'shared baseline preparation failure');
    return { refusal: artifactBlocked(runId, REASON.worktree_shared_baseline_mismatch, {}, envelopeExtras(cleanup.notices)) };
  }
  const laneBFailure = snapshotBlockedResult(laneB);
  const preparedLaneB = snapshotWorktreeHandle(laneB, laneBExpected);
  if (laneBFailure?.hardStopped === true || laneBFailure?.blocked === true || preparedLaneB === null ||
      preparedLaneB.path === preparedLaneA.path) {
    const ownedLaneB = provenOwnedWorktreeForCleanup(laneB, laneBExpected);
    const cleanup = await cleanupWorktrees(
      [preparedLaneA, ...(ownedLaneB === null ? [] : [ownedLaneB])],
      'shared baseline preparation failure',
    );
    const extras = envelopeExtras(cleanup.notices);
    return { refusal: laneBFailure?.hardStopped === true
      ? runHalt({ runId, extras })
      : artifactBlocked(runId, reasonCodeOf(laneB, REASON.worktree_shared_baseline_mismatch), {}, extras) };
  }
  return { refusal: null, laneWorktree: preparedLaneB };
}
