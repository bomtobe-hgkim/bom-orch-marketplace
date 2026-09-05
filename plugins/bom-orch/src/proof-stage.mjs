// src/proof-stage.mjs
/**
 * `orch_prove` 의 **재현과 실행** — 끝난 실행이 디스크에 남긴 것만으로 선택된 후보 하나를 다시
 * 짓고 여섯 칸 회귀 증명을 돌린다(설계 §1.3). 실행 디렉터리(`runs/<runId>/`)에는 한 바이트도
 * 쓰지 않는다: 증명이 남기는 것은 전부 `<stateRoot>/proofs/<runId>/` 아래다.
 *
 * ★★ 이 모듈이 생긴 이유는 실측 하나다. 2026-08-28 실행 9 는 이 저장소에서 첫 수용 후보를
 *   냈는데 봉투가 `unverified` 였다 — 증명은 스위트 여섯 번이고 이 스위트는 한 번에 ~7분이라
 *   42분인데, 55분 상한이 **다섯 번째 실행 뒤에** 잘랐다. 증명을 실행 밖으로 떼면 실행은 두
 *   칸만 돌고 여섯 칸은 실제로 적용할 후보 하나에만 든다.
 *
 * ★★ **증명 규칙은 한 글자도 안 바꾼다.** 여섯 칸의 판정은 `completeRegressionProof` 가 그대로
 *   하고, 이 파일은 그 함수가 필요로 하는 것(워크트리·계획·델타·마감·큐)을 **끝난 실행의
 *   기록에서** 다시 만들어 줄 뿐이다. 재현이 기록과 어긋나면 돌리지 않고 거부한다 — 다른
 *   baseline 에서 돈 여섯 칸은 이 후보의 증명이 아니다.
 *
 * ★ 엔진도 저장소(`run-artifacts`)도 수입하지 않는다(`test/guards/module-directions.test.mjs`
 *   의 방향 표). 증명은 실행을 **만들지** 않고 끝난 실행을 읽어 재현할 뿐이라, 엔진을 수입하는
 *   순간 이 파일 하나를 재려면 오케스트레이션 전체가 따라온다. `MAX_WAIT_MS` 를 태스크 4 가
 *   `src/deadline.mjs` 로 옮긴 이유가 정확히 이것이다.
 *
 * ★ 실측 폐포: **58개 모듈 / 24,591줄**(자기 자신 570 포함) — 엔진 0개·저장소(`run-artifacts`) 0개다.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { MAX_WAIT_MS, haltSignal, timeoutSignal } from './deadline.mjs';
import { provisionDependencies as defaultProvisionDependencies } from './deps-provision.mjs';
import { inspectRepo as defaultInspectRepo, runGit as defaultRunGit } from './git.mjs';
import { readRuns as defaultReadRuns } from './learn/journal.mjs';
import {
  acquireProofLock as defaultAcquireProofLock,
  nextProofOrdinal as defaultNextProofOrdinal,
  proofAttemptId,
  proofDir,
  proofRecordPath,
  writeProofEvidence as defaultWriteProofEvidence,
  writeProofRecord as defaultWriteProofRecord,
} from './proof-record.mjs';
import { REASON } from './reason-codes.mjs';
import { treeKill as defaultTreeKill } from './reaper-process.mjs';
import {
  createSerialTestQueue,
  runCandidateEvidence as defaultRunCandidateEvidence,
  splitTestOnlyDelta as defaultSplitTestOnlyDelta,
} from './regression-proof.mjs';
import { readRunManifest as defaultReadRunManifest, runIdText, usableRunId } from './run-read.mjs';
import {
  deriveFrozenTestPlan as defaultDeriveFrozenTestPlan,
  frozenTestPlanConfig as defaultFrozenTestPlanConfig,
  runFrozenTests as defaultRunFrozenTests,
} from './test-runner.mjs';
import { sha256 } from './util/hash.mjs';
import { WORKTREE_TIMEOUT_MS } from './worktree-patch.mjs';
import {
  applyPatchBytes as defaultApplyPatchBytes,
  collectPatchAtRevision as defaultCollectPatchAtRevision,
  createRevisionWorktree as defaultCreateRevisionWorktree,
  createWorktree as defaultCreateWorktree,
  listRevisionDelta as defaultListRevisionDelta,
  makeWorktreeId,
  removeWorktree as defaultRemoveWorktree,
  revisionIdentity as defaultRevisionIdentity,
  snapshotStep as defaultSnapshotStep,
} from './worktree.mjs';

/** 증명 레인의 이름. 워크트리 purpose·attemptId·증거 id 가 전부 이 한 낱말에서 나온다. */
const PROOF_LANE = 'prove';

/** 봉투에 실리는 증거 행의 상한. 여섯 칸이 상계이고, 둘은 어긋난 러너에 대한 여유다. */
const MAX_EVIDENCE_ROWS = 8;

const ordinalText = (ordinal) => String(ordinal).padStart(3, '0');

/**
 * 실행의 c 증거가 적어 둔 테스트 델타 지문. 없으면 `null`(그 실행도 분리 불가였다), 읽지
 * 못하면 `undefined` — 둘은 다른 답이다. 「없었다」와 「모른다」를 뭉개면 재현 대조가 공허해진다.
 */
async function recordedTestDeltaSha(manifest, candidateRef, read) {
  const entry = (manifest.evidenceRefs ?? []).find((one) =>
    one.laneId === candidateRef.candidateId && one.attemptId === candidateRef.sourceAttemptId && one.kind === 'c');
  if (entry === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse((await read(entry.ref.path)).toString('utf8'));
  } catch {
    return undefined;
  }
  const value = parsed?.testDeltaSha256;
  if (value === null) return null;
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

/**
 * 끝난 실행 하나의 회귀 증명. 순서는 설계 §1.3 의 게이트 순서 그대로이고, 각 게이트는 자기
 * 코드로 거부한다 — 하나로 뭉개면 호출자가 할 일이 갈린다(다른 이름을 대기 / 실행을 다시 하기 /
 * 이 증명을 믿지 않기).
 *
 * @returns `{ ok: true, record, refused: false, evidence }` ·
 *   `{ ok: true, record, refused: false, notRequired: true, evidence: [] }` ·
 *   `{ ok: false, reasonCode, params?, disputed? }` ·
 *   `{ ok: false, blocked: true, reasonCode, error, recovery }`(앵커 프로비저닝 실패 — `createProofWorktree`
 *   가 셀 프로비저닝 실패에 쓰는 것과 같은 모양이다). **던지지 않는다.**
 */
export async function runProofStage({ stateRoot, runId, waitMs, onProgress, hostSignal } = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const readManifest = deps.readRunManifest ?? defaultReadRunManifest;
  const readJournal = deps.readRuns ?? defaultReadRuns;
  const inspect = deps.inspectRepo ?? defaultInspectRepo;
  const acquire = deps.acquireProofLock ?? defaultAcquireProofLock;
  const nextOrdinal = deps.nextProofOrdinal ?? defaultNextProofOrdinal;
  const openWorktree = deps.createWorktree ?? defaultCreateWorktree;
  const dropWorktree = deps.removeWorktree ?? defaultRemoveWorktree;
  const run = deps.runGit ?? defaultRunGit;
  const identify = deps.revisionIdentity ?? defaultRevisionIdentity;
  const derivePlan = deps.deriveFrozenTestPlan ?? defaultDeriveFrozenTestPlan;
  const planConfig = deps.frozenTestPlanConfig ?? defaultFrozenTestPlanConfig;
  const applyPatch = deps.applyPatchBytes ?? defaultApplyPatchBytes;
  const snapshot = deps.snapshotStep ?? defaultSnapshotStep;
  const listDelta = deps.listRevisionDelta ?? defaultListRevisionDelta;
  const collectPatch = deps.collectPatchAtRevision ?? defaultCollectPatchAtRevision;
  const splitDelta = deps.splitTestOnlyDelta ?? defaultSplitTestOnlyDelta;
  const makeCellWorktree = deps.createRevisionWorktree ?? defaultCreateRevisionWorktree;
  const provision = deps.provisionDependencies ?? defaultProvisionDependencies;
  const runTests = deps.runFrozenTests ?? defaultRunFrozenTests;
  const runEvidence = deps.runCandidateEvidence ?? defaultRunCandidateEvidence;
  const writeRecord = deps.writeProofRecord ?? defaultWriteProofRecord;
  const writeEvidence = deps.writeProofEvidence ?? defaultWriteProofEvidence;
  const kill = deps.treeKill ?? defaultTreeKill;
  const readBytes = deps.readFile ?? readFile;

  const refuse = (reasonCode, params, disputed = false) => ({
    ok: false,
    reasonCode,
    ...(params === undefined ? {} : { params }),
    ...(disputed ? { disputed: true } : {}),
  });
  // 호스트 배선의 결함이 증명을 멈추지 않는다 — 진행 알림은 부수적인 채널이다.
  //
  // ★★ **사건 객체**를 낸다, 문자열이 아니라. 호스트로 나가는 중계기(`makeProgressReporter`,
  //   src/tools.mjs)는 `event.phase`·`event.runId`·`event.step`·`event.budget` 을 읽고, 문자열을
  //   주면 `PROGRESS_PHASES.get(undefined)` 가 전부 폴백 `infra` 로 접힌다 — 그러면 5초 상한이
  //   첫 하나만 남기고 나머지를 다 버리고, `runId` 는 `-` 로 나간다. 42분짜리 호출에서 알림이
  //   0건이 되는 것이 이 채널이 막으려는 stdio 유휴 끊김(§6) 그 자체다.
  // ★ `phase` 는 반드시 `PROGRESS_PHASES` 의 **키**여야 한다(계약 `progress.vocabulary`): 이
  //   파일이 쓰는 것은 `preflight`·`worktree`·`tests`·`seal` 넷뿐이고, 증명 전용 단어를 새로
  //   만들지 않는다 — 어휘를 늘리면 호스트가 모르는 단어를 보게 된다.
  const progress = (phase, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, runId, laneId: PROOF_LANE, role: 'tests', step: 0, budget: 6, candidates: 1, ...extra });
    } catch { /* 알림은 결과를 바꾸지 않는다 */ }
  };

  // 1. 경로가 되기 전에 이름을 본다 — 리더와 **같은 술어**를 쓴다(사본이 생기면 문턱이 갈린다).
  if (!usableRunId(runId)) return refuse(REASON.proof_run_not_found, { runId: runIdText(runId) });
  const read = await readManifest({ stateRoot, runId });
  if (read.ok !== true) {
    // 상태 루트 자체가 못 쓰는 값이면 그것은 이 실행에 대한 답이 아니다 — 리더의 코드 그대로.
    if (read.reasonCode === REASON.state_root_not_absolute) return refuse(read.reasonCode);
    return read.reasonCode === REASON.status_run_not_found
      ? refuse(REASON.proof_run_not_found, { runId })
      : refuse(REASON.proof_run_unreadable, { runId });
  }
  const manifest = read.manifest;
  const startedAt = now();
  progress('preflight');

  // 2. 증명이 필요 없는 실행도 **기록을 남긴다.** `orch_apply` 의 게이트가 읽을 정본이 없으면
  //    「증명이 필요 없었다」와 「증명을 안 돌렸다」가 디스크에서 같은 모양이다.
  if (manifest.proofRequirement.required !== true) {
    const ordinal = await nextOrdinal({ stateRoot, runId });
    // ★ `nextProofOrdinal` 은 디렉터리를 못 읽거나 999 천장에서 `null` 이다. 안 막으면 바로 아래
    //   `proofAttemptId(runId, null)` 이 던지는데, 이 가지는 `try` **밖**이라 아무도 안 잡는다 —
    //   「던지지 않는다」고 적힌 함수가 `callTool` 의 바깥 catch 에서 `run_tool_failed` 로 접힌다.
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      return refuse(REASON.proof_record_unreadable, { path: proofDir(stateRoot, runId) });
    }
    const record = {
      schemaVersion: 1,
      runId,
      candidateId: manifest.selection?.selectedCandidateId ?? null,
      attemptId: proofAttemptId(runId, ordinal),
      ordinal,
      treeHash: null,
      patchSha256: null,
      planFingerprint: manifest.frozenTestPlan.planFingerprint,
      environmentFingerprint: manifest.frozenTestPlan.environmentFingerprint,
      testDeltaSha256: null,
      status: 'not_applicable',
      repairable: false,
      reasonCodes: [REASON.proof_not_required],
      evidenceIds: [],
      witnessIds: [],
      startedAt,
      finishedAt: now(),
      expiresAt: manifest.expiresAt,
      cost: { testRuns: { count: 0, totalMs: 0 } },
    };
    const written = await writeRecord({ stateRoot, runId, record });
    if (written?.ok !== true) return refuse(REASON.proof_record_unreadable, { path: proofRecordPath(stateRoot, runId) });
    progress('seal');
    return { ok: true, record: written.record ?? record, refused: false, notRequired: true, evidence: [] };
  }

  // 3. 적용할 후보가 있어야 증명할 것이 있다. `tie`·`none` 은 대표 패치가 없다.
  const selectedCandidateId = manifest.selection?.selectedCandidateId ?? null;
  if (selectedCandidateId === null || manifest.winnerAlias === null) {
    return refuse(REASON.proof_candidate_unavailable, { runId });
  }
  const candidateRef = (manifest.candidateRefs ?? []).find((one) => one.candidateId === selectedCandidateId) ?? null;
  if (candidateRef === null || candidateRef.patchRef === null || candidateRef.treeHash === null ||
      candidateRef.sourceAttemptId === null) {
    return refuse(REASON.proof_candidate_unavailable, { runId });
  }

  // 4. 어느 저장소인가 — `src/tools/apply.mjs projectOf` 와 **같은 경로**(저널 행)다.
  const journal = await readJournal(stateRoot, { limit: Number.MAX_SAFE_INTEGER });
  const row = journal?.ok === true ? (journal.runs.find((one) => one.runId === runId) ?? null) : null;
  const project = typeof row?.project === 'string' && row.project !== '' && isAbsolute(row.project) ? row.project : null;
  if (project === null) return refuse(REASON.proof_project_unknown, { runId });
  const inspected = await inspect(project);
  if (inspected?.ok !== true) return refuse(REASON.proof_project_unusable, { path: project });

  // 5. 같은 실행에 대한 증명은 한 번에 하나다. 둘이 겹치면 같은 서수를 두 번 쓰고, 그러면
  //    create-once 쓰기 하나가 조용히 지고 둘 중 어느 것이 정본인지 아무도 모른다.
  const lock = await acquire({ stateRoot, runId, pid: process.pid, nowMs: now() });
  if (lock?.ok !== true) {
    // ★ 세 실패를 하나로 뭉개지 않는다. 「다른 증명이 돌고 있다」는 기다리라는 말이고, mkdir 이
    //   EACCES·ENOSPC 로 진 것은 기다려도 안 낫는다 — 후자를 `proof_in_progress` 로 내보내면
    //   돌지도 않는 증명을 기다리라고 말하는 봉투가 된다.
    return lock?.reasonCode === REASON.proof_in_progress
      ? refuse(REASON.proof_in_progress, { runId })
      : refuse(REASON.proof_record_unreadable, { path: proofDir(stateRoot, runId) });
  }

  let anchor = null;
  let halt;
  const children = new Set();
  // ★ 마감이나 호스트 취소가 오면 자식 트리를 회수한다. 러너가 자기 워크트리를 지우기 전에
  //   자식이 살아 있으면 Windows 에서 삭제가 막히고, 남은 자식은 **다음 실행**의 벽시계를
  //   먹는다(2026-08-28 실측: 겹친 러너 때문에 같은 테스트가 242ms → 1,500ms).
  const onAbort = () => { for (const pid of children) void Promise.resolve(kill(pid)).catch(() => false); };

  try {
    const ordinal = await nextOrdinal({ stateRoot, runId });
    // ★ 같은 이유로 여기서도 막는다 — `ordinalText(null)` 은 `'null'` 이 되어 purpose 가
    //   `prove-null` 이 되고 `makeWorktreeId` 가 `worktree_purpose_invalid` 로 던진다.
    //   (이 자리는 `try` 안이므로 `finally` 가 앵커와 잠금을 그대로 회수한다.)
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      return refuse(REASON.proof_record_unreadable, { path: proofDir(stateRoot, runId) });
    }
    const purpose = `${PROOF_LANE}-${ordinalText(ordinal)}`;
    const effectiveWaitMs = Number.isFinite(waitMs) && waitMs > 0
      ? Math.ceil(Math.min(waitMs, MAX_WAIT_MS))
      : MAX_WAIT_MS;
    // 상한을 여기서 **다시 정하지 않는다** — 엔진과 같은 `MAX_WAIT_MS` 를 읽는다. 두 번째
    // 상한을 만들면 같은 호스트 호출이 도구마다 다른 시점에 끊긴다.
    if (!Number.isSafeInteger(startedAt + effectiveWaitMs)) {
      return refuse(REASON.run_deadline_unrepresentable);
    }
    const deadlineAt = startedAt + effectiveWaitMs;
    halt = haltSignal(timeoutSignal(Math.max(1, deadlineAt - now())), hostSignal);
    halt.addEventListener('abort', onAbort, { once: true });

    // 6. 앵커 워크트리. `createWorktree` 는 사용자의 미커밋 작업을 이식하고 자기 baseline 을
    //    커밋하므로, 그 자리에서 **매니페스트가 적은 baseline 으로 되감는다** — 증명이 서야 할
    //    바닥은 오늘의 작업 트리가 아니라 그 실행이 봉인한 커밋이다.
    progress('worktree');
    anchor = await openWorktree({
      projectPath: project,
      stateRoot,
      runId,
      worktreeId: makeWorktreeId({ runId, purpose }),
      purpose,
    });
    if (anchor?.ok !== true) return refuse(REASON.proof_project_unusable, { path: project });
    const reset = await run({
      args: ['reset', '--hard', manifest.baseline.commit],
      cwd: anchor.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (reset?.ok !== true) return refuse(REASON.proof_baseline_unavailable, { path: project });
    // ★ 앵커는 사용자의 **미커밋 작업을 이식받은** 트리다. `reset --hard` 는 추적되는 파일만
    //   되돌리고 untracked·ignored 잔여물은 그대로 남는데, `applyPatchBytes` 는 pristine 이
    //   아니면 `worktree_not_pristine` 으로 거부한다. 그 거부는 「기록과 재현이 다르다」가 아니라
    //   「바닥이 안 깨끗했다」다 — 그 둘을 같은 disputed 코드로 내보내면 안 된다.
    const cleaned = await run({ args: ['clean', '-xdf'], cwd: anchor.path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (cleaned?.ok !== true) return refuse(REASON.proof_baseline_unavailable, { path: project });
    const baselineIdentity = await identify(anchor, manifest.baseline.commit);
    if (baselineIdentity?.ok !== true || baselineIdentity.commit !== manifest.baseline.commit ||
        baselineIdentity.tree !== manifest.baseline.tree) {
      return refuse(REASON.proof_baseline_unavailable, { path: project });
    }
    // ★ 핸들을 **복사**해서 고친다. `snapshotStep` 이 `lastSnapshot` 을 직접 쓰므로 러너에게
    //   넘길 것은 우리가 소유하는 객체여야 하고, 회수는 원본 핸들로 한다.
    const source = {
      ...anchor,
      baseline: manifest.baseline.commit,
      baselineIdentity: { commit: manifest.baseline.commit, tree: manifest.baseline.tree },
      lastSnapshot: manifest.baseline.commit,
    };

    // 7. 계획을 **그 트리에서** 다시 도출한다. 지문 둘이 매니페스트와 같아야 한다 — 다르면
    //    이 기계는 그 실행이 잰 것과 다른 스위트를 재고 있다.
    //
    // ★★ 실측(실행 10, `run-mtgr82up-015bfh`, 2026-08-31): 그 실행은 계획을 **사용자 프로젝트**
    //   에서 도출했다 — 거기엔 `node_modules` 가 설치돼 있고, 계획 지문에는 `node_modules/.bin`
    //   디렉터리 다이제스트 핀이 들어간다(`src/test-discovery.mjs:401`, 이유는 :448 의 주석).
    //   그런데 여기 앵커는 `git clean -xdf` **직후**, 즉 프로비저닝 **전**에 계획을 도출했다 —
    //   그 핀이 「없는 디렉터리」를 가리켰고, environmentFingerprint 는 매니페스트와 일치했는데
    //   planFingerprint 만 어긋나 5초 만에 `proof_environment_drift` 로 거부됐다. 실험(같은
    //   워크트리, baseline 그대로, `npm ci --ignore-scripts` 전/후 재도출): 전에는 `d00fa906…`,
    //   후에는 `042e1398…` — 그 실행이 기록한 값과 **바이트까지** 같았고 `.bin` 목록도 같았다.
    //   그래서 앵커도 셀과 같은 프로비저닝을 **비교 전에** 한 번 받는다.
    // ★ 프로비저닝은 `config`(`.bom-orch.json` 의 `tests` 절)를 요구하는데 그 config 는 도출된
    //   계획에서만 나온다(`frozenTestPlanConfig`) — 그래서 여기서 **예비** 도출을 한 번 더 한다.
    //   예비 계획의 지문은 버린다(어차피 프로비저닝 전이라 매니페스트와 못 맞는 값이다), config 만
    //   쓴다. 예비 도출이 `blocked` 면(설정 자체를 못 읽으면) 오늘과 같은 코드로 거부한다 — 그
    //   판정은 프로비저닝의 유무와 무관하다.
    progress('preflight');
    const preliminary = await derivePlan(source.path, { projectConfigCommit: manifest.baseline.commit });
    if (preliminary?.blocked === true) {
      return refuse(REASON.proof_environment_drift, { runId }, true);
    }
    const provisionedAnchor = await provision({
      config: planConfig(preliminary),
      baselineCommit: manifest.baseline.commit,
      worktreePath: source.path,
      stateRoot,
      runId,
      signal: halt,
    });
    if (provisionedAnchor?.ok !== true) {
      // ★ 의존성 설치 실패는 재현 불일치가 아니다 — 「이 기계가 못 깔았다」이지 「기록과 재현이
      //   다르다」가 아니다. `disputed` 를 실으면 사용자가 자기 실행 기록을 의심하게 된다. 셀
      //   프로비저닝이 실패했을 때(`createProofWorktree`, 아래)와 **같은 모양**으로 낸다 — 아래
      //   셀 분기와 나란히 읽혀야 하는 코드라 사유 코드 기본값도 같다.
      return {
        ok: false,
        blocked: true,
        reasonCode: typeof provisionedAnchor?.reasonCode === 'string' ? provisionedAnchor.reasonCode : REASON.deps_unavailable,
        error: typeof provisionedAnchor?.error === 'string' ? provisionedAnchor.error : '',
        recovery: typeof provisionedAnchor?.recovery === 'string' ? provisionedAnchor.recovery : '',
      };
    }
    const plan = await derivePlan(source.path, { projectConfigCommit: manifest.baseline.commit });
    if (plan?.blocked === true || plan?.planFingerprint !== manifest.frozenTestPlan.planFingerprint ||
        plan?.environmentFingerprint !== manifest.frozenTestPlan.environmentFingerprint) {
      return refuse(REASON.proof_environment_drift, { runId }, true);
    }

    // 7.5. 프로비저닝된 앵커를 패치를 얹기 **전**에 다시 pristine 으로 되돌린다.
    //
    // ★★ 실측(실행 10 두 번째 시도, 2026-08-31): 환경 게이트(5)는 이제 통과하는데(위 고침이 낸
    //   결과다) 8초 뒤 `proof_candidate_mismatch` 로 거부됐다. 원인은 `applyPatchBytes`
    //   (`src/worktree-patch.mjs`:100·130·135)의 pristine 판정이 `git status --porcelain -z
    //   --ignored=matching` 로 **무시 파일까지** 센다는 것이다 — 방금 프로비저닝한 앵커는
    //   `node_modules/` 를 이제 지녔고(무시 대상이라도 `--ignored=matching` 은 그것을 보고한다),
    //   그래서 `pristine.stdout !== ''` 이 되어 `worktree_not_pristine` 으로 지고 8단계가 그
    //   실패를 `proof_candidate_mismatch` 로 옮긴다. 트리 자체는 멀쩡했다(실험: 같은 패치를 갓
    //   만든 워크트리에 얹으면 기록된 후보 트리 `a812f2e0…` 와 바이트까지 같다) — 어긋난 것은
    //   순서다.
    // ★ 그 무시 검사는 **의도적**이다(`worktree-patch.mjs` 의 설계: 실행은 한 번도 프로비저닝된
    //   적 없는 트리에만 패치를 얹는다 — 무시 파일이 하나라도 있으면 그 트리가 진짜 baseline
    //   그대로인지 더는 보증할 수 없다). 그래서 그 규칙을 완화하지 않는다 — 앵커를 6단계와 같은
    //   `clean -xdf` 로 한 번 더 되돌린다. 앵커의 `node_modules` 는 방금 끝난 계획 도출에만
    //   필요했다 — 셀은 각자 `createProofWorktree` 로 따로 프로비저닝되므로 이 clean 뒤로는
    //   아무것도 그것에 기대지 않는다.
    const postPlanCleaned = await run({ args: ['clean', '-xdf'], cwd: anchor.path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (postPlanCleaned?.ok !== true) return refuse(REASON.proof_baseline_unavailable, { path: project });

    // 8. 후보 재구성. 정체성은 **트리 해시**다(커밋 sha 는 다르다) — resume 게이트와 같은 원칙.
    progress('preflight');
    const patchPath = join(stateRoot, 'patches', `${runId}.patch`);
    let patch = null;
    try {
      patch = await readBytes(patchPath);
    } catch {
      return refuse(REASON.proof_candidate_unavailable, { runId });
    }
    if (patch.length !== manifest.winnerAlias.bytes || sha256(patch) !== manifest.winnerAlias.sha256) {
      return refuse(REASON.proof_candidate_mismatch, { runId }, true);
    }
    const applied = await applyPatch(source, { patch, sha256: manifest.winnerAlias.sha256 });
    if (applied?.ok !== true) return refuse(REASON.proof_candidate_mismatch, { runId }, true);
    source.lastSnapshot = applied.commit;
    // ★ `applyPatchBytes` 가 이미 커밋했으므로 이 스냅샷은 **아무것도 안 바꿔야** 한다. 바뀌면
    //   앵커에 패치 밖의 무엇이 남아 있었다는 뜻이고, 그 트리는 이 후보의 트리가 아니다.
    const sealed = await snapshot(source, `bom-orch proof ${runId} ${purpose}`);
    if (sealed?.ok !== true || sealed.changed !== false || sealed.commit !== applied.commit) {
      return refuse(REASON.proof_candidate_mismatch, { runId }, true);
    }
    const candidateIdentity = await identify(source, applied.commit);
    if (candidateIdentity?.ok !== true || candidateIdentity.tree !== candidateRef.treeHash) {
      return refuse(REASON.proof_candidate_mismatch, { runId }, true);
    }

    // 9. 테스트 델타를 다시 계산해 실행이 적어 둔 지문과 맞춘다. `separable` 이 아닌 것도
    //    **답이다**(그 실행도 그랬다) — 그때는 러너가 b0/br 을 건너뛰고 기존 규칙대로 판정한다.
    progress('preflight');
    const delta = await listDelta(source, { from: manifest.baseline.commit, to: applied.commit });
    if (delta?.ok !== true || !Array.isArray(delta.entries)) {
      return refuse(REASON.proof_delta_mismatch, { runId }, true);
    }
    const testDelta = await splitDelta({
      entries: delta.entries,
      baselineRevision: manifest.baseline.commit,
      candidateRevision: applied.commit,
      testPlan: plan,
      // 앵커는 baseline 바이트 그대로에서 패치만 얹은 트리라 무시 경로의 기준선이 비어 있다.
      ignoredPaths: [],
      unsafePaths: delta.unsafePaths ?? [],
      candidateWorktree: source,
    }, { collectPatchAtRevision: collectPatch });
    const recorded = await recordedTestDeltaSha(manifest, candidateRef, readBytes);
    const observed = testDelta?.status === 'separable' ? testDelta.sha256 : null;
    if (recorded === undefined || recorded !== observed) {
      return refuse(REASON.proof_delta_mismatch, { runId }, true);
    }

    // 10~12. 마감·큐·캐시는 **호출마다 새것**이다. 캐시를 나눠 쓰면 이 증명이 실행 중에 기록된
    //    칸을 입양하고, 그러면 여섯 기록이 한 권위 튜플을 공유한다는 전제가 깨진다.
    progress('tests');
    const testQueue = createSerialTestQueue({ now });
    const cache = new Map();
    const attemptId = proofAttemptId(runId, ordinal);
    let cell = 0;
    const onSpawn = (child) => {
      if (child !== null && typeof child === 'object' && Number.isInteger(child.pid)) children.add(child.pid);
      // ★★ 여섯 칸은 이 저장소에서 42분이고 그동안 게이트 알림은 하나도 안 난다 — 러너가 위로
      //   올리는 훅은 이 `onSpawn` 뿐이므로 칸이 뜰 때마다 여기서 한 번 친다. 안 치면 유휴
      //   타이머를 리셋하는 것이 아무것도 없고, 그것이 실행 9 를 끊은 것과 같은 종류의 실패다.
      cell += 1;
      progress('tests', { step: cell });
      // 러너는 **정확히 `true`** 만 「등록했다」로 센다. 다른 값은 회수 미증명이다.
      return true;
    };
    // 증거 워크트리는 레인과 **같은** 프로비저닝을 받는다(`src/run-lane-adapters.mjs` 의
    // `createEvidenceWorktree` 와 같은 모양). 빈 트리에서 돌린 테스트는 「후보가 틀렸다」가
    // 아니라 「의존성이 없었다」인데 봉투가 그 둘을 못 가른다.
    const createProofWorktree = async (spec, worktreeDeps) => {
      const created = await makeCellWorktree(spec, worktreeDeps);
      if (created?.ok !== true) return created;
      const provisioned = await provision({
        config: planConfig(plan),
        baselineCommit: manifest.baseline.commit,
        worktreePath: created.path,
        stateRoot,
        runId,
        signal: halt,
      });
      if (provisioned?.ok === true) return created;
      // ★ `removeWorktree` 의 둘째 인자는 `{ run, worktreeScopeClaim, worktreeAuthority }` 다 —
      //   마감·신호를 넘기면 무시되고, 읽는 사람은 회수가 유계라고 읽는다.
      await Promise.resolve(dropWorktree(created)).catch(() => null);
      return {
        ok: false,
        blocked: true,
        reasonCode: typeof provisioned?.reasonCode === 'string' ? provisioned.reasonCode : REASON.deps_unavailable,
        error: typeof provisioned?.error === 'string' ? provisioned.error : '',
        recovery: typeof provisioned?.recovery === 'string' ? provisioned.recovery : '',
      };
    };
    const outcome = await runEvidence({
      runId,
      laneId: PROOF_LANE,
      attemptId,
      stage: 'prove',
      baseline: manifest.baseline,
      candidate: {
        commit: applied.commit,
        treeHash: candidateIdentity.tree,
        patchSha256: manifest.winnerAlias.sha256,
        testPlanFingerprint: plan.planFingerprint,
      },
      frozenTestPlan: plan,
      proofRequirement: manifest.proofRequirement,
      testDelta,
      deadlineAt,
      testQueue,
      cache,
    }, {
      sourceWorktree: source,
      stateRoot,
      createRevisionWorktree: createProofWorktree,
      revisionIdentity: identify,
      runFrozenTests: runTests,
      removeWorktree: dropWorktree,
      // ★ 러너는 `ref.candidateId !== spec.laneId` 를 persistence 실패로 센다. 증명 기록의 ref 는
      //   레인을 모르므로(증명 디렉터리에는 레인이 없다) 여기서 붙인다 — 안 붙이면 여섯 칸이
      //   전부 버려지고 결과가 `evidence_persistence_failed` 로 접힌다.
      // ★ `expiresAt` 은 **필수 인자**다(`writeProofEvidence` 의 첫 줄이 그것 없이는 거부한다).
      //   빠뜨리면 칸마다 `{ok:false}` 가 되고, 러너는 그것을 `evidence_persistence_failed` 로
      //   세어 남은 칸을 끊는다 — 여섯 칸을 다 돌고도 결과가 언제나 `unavailable` 이 된다.
      persistEvidence: async ({ record }) => {
        const written = await writeEvidence({
          stateRoot, runId, ordinal, kind: record.kind, repetition: record.repetition, record,
          expiresAt: manifest.expiresAt,
        });
        return written?.ok === true
          ? { ok: true, ref: { ...written.ref, candidateId: PROOF_LANE } }
          : { ok: false };
      },
      onSpawn,
    });

    // 12.5. 마감이나 취소로 끊긴 것은 **증명 결과가 아니다.** 그때 `completeRegressionProof` 가
    //    내는 값을 기록으로 남기면 「돌려 봤더니 못 증명했다」와 「시간이 없어 못 돌렸다」가
    //    디스크에서 같은 모양이 되고, 적용 게이트는 앞의 것으로 읽는다. 실행 9 를 55분에서
    //    끊은 것이 정확히 이 경우다 — 그것이 `unavailable` 로 나가 초록 후보를 unverified 로 만들었다.
    const halted = outcome.operationalFailure?.code ?? null;
    if (halted === REASON.test_deadline_expired || halted === REASON.run_deadline_exceeded) {
      return refuse(REASON.run_deadline_exceeded, { runId });
    }
    if (halted === REASON.run_cancelled || hostSignal?.aborted === true) {
      return refuse(REASON.run_cancelled, { runId });
    }

    // 13. 기록 한 장. 이것이 `orch_apply` 가 읽을 정본이다.
    progress('seal');
    const proof = outcome.regressionProof;
    const record = {
      schemaVersion: 1,
      runId,
      candidateId: selectedCandidateId,
      attemptId,
      ordinal,
      treeHash: candidateIdentity.tree,
      patchSha256: manifest.winnerAlias.sha256,
      planFingerprint: plan.planFingerprint,
      environmentFingerprint: plan.environmentFingerprint,
      testDeltaSha256: observed,
      status: proof.status,
      repairable: proof.repairable === true,
      reasonCodes: [...proof.reasonCodes],
      evidenceIds: [...proof.evidenceIds],
      witnessIds: [...proof.witnessIds],
      startedAt,
      finishedAt: now(),
      // 증명은 그 실행과 **같은 날** 만료된다 — 실행이 사라진 뒤에 남은 증명은 가리킬 것이 없다.
      expiresAt: manifest.expiresAt,
      cost: { testRuns: testQueue.testRuns() },
    };
    const written = await writeRecord({ stateRoot, runId, record });
    if (written?.ok !== true) return refuse(REASON.proof_record_unreadable, { path: proofRecordPath(stateRoot, runId) });
    return {
      ok: true,
      record: written.record ?? record,
      refused: false,
      evidence: (outcome.evidence ?? []).slice(0, MAX_EVIDENCE_ROWS).map((entry) => ({
        evidenceId: entry.record.evidenceId,
        kind: entry.record.kind,
        repetition: entry.record.repetition,
        outcome: entry.record.classified?.outcome ?? 'unknown',
        witnessCount: Array.isArray(entry.record.classified?.witnessIds)
          ? entry.record.classified.witnessIds.length
          : 0,
      })),
    };
  } finally {
    // ★★ 어느 종료 경로에서도 앵커와 잠금은 남지 않는다. 남으면 다음 `orch_prove` 는 영영
    //   `proof_in_progress` 이고, 앵커 워크트리는 사용자 저장소의 등록에 남는다.
    if (halt !== undefined) halt.removeEventListener?.('abort', onAbort);
    if (anchor?.ok === true) {
      await Promise.resolve(dropWorktree(anchor)).catch(() => null);
    }
    await Promise.resolve(lock.release()).catch(() => null);
  }
}
