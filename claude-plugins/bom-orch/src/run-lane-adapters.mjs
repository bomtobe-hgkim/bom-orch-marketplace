/**
 * 실행 하나의 **레인 한 줄기**를 돌린다 — 준비(`prepareRunNamespace`)가 얼린 네임스페이스를 받아
 * 레인 하나를 끝까지 몰고(`runPreparedLane`), 그 레인이 남긴 사실을 얼려 돌려준다. 함께 사는
 * 것은 그 레인이 `src/candidate-lane.mjs` 에 건네는 어댑터 묶음 하나뿐이다
 * (`createPreparedLaneAdapters` — 프로바이더 호출·봉인·증거·산출물 쓰기의 이음매 전부).
 *
 * WS8 컷 1 이 `src/engine.mjs` 에서 **바이트 보존 이동**했다(로드맵 §3.11). 옮긴 것은 그 두 함수와
 * 그 둘만 쓰던 이름 셋(`WORKER_TOOLS`·`VERIFIER_TOOLS`·`RAN_WITH_USER_PRIVILEGE_EXECUTIONS`)이고,
 * 몸통은 한 줄도 고치지 않았다 — 옮긴 몸통을 원본과 대조하면 import 배선 말고는 아무것도 안
 * 보여야 한다는 것이 이 컷의 수용 조건이었다.
 *
 * ★★ **왜 별도 모듈인가.** `src/engine.mjs` 는 2026-08-13 에 1,477줄로 분해됐다가 2026-08-16 에
 *   3,841줄로 되돌아갔다 — 새 오케스트레이션이 여섯 목적 모듈 대신 엔진으로 들어갔기 때문이다.
 *   그래서 §3.11 은 태스크마다 「새 코드가 어느 파일로 들어가는가」를 적으라고 요구한다.
 *   **레인 단계의 새 코드는 이 파일로 들어간다**: 어댑터를 하나 더하는 일도, 레인이 보는 사실을
 *   늘리는 일도 여기서 한다. 엔진으로 되돌려 놓으면 래칫(`contract/module-budget.json`)이 붉어진다.
 *
 * ★ **왜 이 둘이 첫 컷이었나.** 준비 단계의 지역 변수를 닫지 않고 `input` 객체 하나만 받는 최상위
 *   함수 둘이라, 옮기는 데 필요한 것이 import 배선뿐이다. 종료 경로(`src/run-finalization.mjs`)도
 *   `runPreparedLane` 을 이름으로 수입하지 않고 `context.finalizationSeam` 으로 **받는다** — 그
 *   이음매를 엔진이 계속 채우므로 이 이동은 종료 경로에서 한 글자도 보이지 않는다.
 *
 * ★ **함께 온 이름 넷과 그 이유.**
 *   · `WORKER_TOOLS`·`VERIFIER_TOOLS` — 쓰는 자리가 이 파일뿐이다. 다만 둘은 엔진의 공개 이름이고
 *     `test/engine.test.mjs` 가 엔진에서 이름으로 수입하므로 엔진이 **호환 이음매**로 재수출한다
 *     (`FORWARD_PLACEMENT`·`REVERSED_PLACEMENT` 가 WS3 부터 쓰는 바로 그 형태다).
 *   · `PREPARATION_PRIVATE` — 값이 아니라 **동일성**이다. 준비가 채운 바로 그 WeakMap 이어야
 *     `.get(preparation)` 이 무언가를 돌려준다 — 같은 모양의 새 WeakMap 은 언제나 `undefined` 다.
 *     그래서 사본이 있을 수 없고, 엔진이 이쪽을 수입하는 방향으로만 하나를 유지할 수 있다.
 *   · `requiredClone` — 감싸는 다섯 자리 중 **셋**이 이 파일이다. 몸통은 네 줄이지만 계약은 그
 *     위의 docblock 이 들고 있어, 복사하면 그 스무 줄이 두 벌이 되고 갈린다.
 *   ★ 반대로 `isBlocked` 는 **복사**했다 — 한 줄짜리 순수 술어라 import 로 나르면 이 파일이
 *     엔진에게 조각 배달부가 된다. `src/run-finalization.mjs` 가 같은 이름에 대해 이미 같은
 *     판정을 내렸고(그 파일 머리말의 「반대로 …는 복사했다」), 이 파일은 그 판정을 따른다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지). 방향은 engine → run-lane-adapters
 *   하나뿐이고, 위의 이름들이 엔진이 아니라 이쪽에 사는 이유가 그것이다.
 */
import { join } from 'node:path';
import {
  acceptArtifactRevision,
  classifyArtifactSettlement,
  unknownArtifactSettlement,
} from './artifact-settlement.mjs';
import { runCandidateLane } from './candidate-lane.mjs';
import { inspectPatch as defaultInspectPatch } from './patch-scope.mjs';
// 벤더 지시문은 `src/prompts/**` 에 산다 — 저장소에서 한국어가 남는 유일한 src 경로(로드맵 §5.8).
import {
  describeMachineEvidence,
  verifierInstruction,
  workerFeedback,
  workerInstruction,
} from './prompts/instructions.mjs';
import { REASON, normalizeLegacyReasonCode } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { runCandidateEvidence, splitTestOnlyDelta } from './regression-proof.mjs';
import { writeAttemptArtifact } from './run-artifacts.mjs';
import { contentEvidenceRef, laneContentFacts } from './run-body.mjs';
import {
  artifactAuthorityLost,
  qualityWriterSettlement,
  reasonCodeOf,
  unclassifiedFault,
} from './run-faults.mjs';
import { runFrozenTests as defaultRunFrozenTests } from './test-runner.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { cloneData, ownDataValue } from './util/objects.mjs';
import { compareUtf8 } from './util/strings.mjs';
import {
  collectPatchAtRevision as defaultCollectPatchAtRevision,
  createRevisionWorktree as defaultCreateRevisionWorktree,
  listIgnoredPaths as defaultListIgnoredPaths,
  listRevisionDelta as defaultListRevisionDelta,
  removeWorktree as defaultRemoveWorktree,
  revisionIdentity as defaultRevisionIdentity,
  snapshotStep as defaultSnapshotStep,
  statusSnapshot as defaultStatusSnapshot,
} from './worktree.mjs';

/** 워커가 받을 도구 집합. Bash 가 없다 — 테스트는 우리가 돌린다(§12.-1). */
export const WORKER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);

/** 베리파이어가 받을 도구 집합. 읽기만 한다. */
export const VERIFIER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);

/**
 * 이 분류값들은 자식이 **떴다는 것**을 모호함 없이 말한다(설계 §5.8 S1).
 *
 * ★ `aborted` 가 빠진 이유: 스폰 **전** 중단과 스폰 **후** 중단이 둘 다 `'aborted'` 다. 넣으면
 *   한 줄도 안 돌린 실행을 "사용자 권한으로 돌았다"고 신고하게 되고, 매번 뜨는 보안 경고는
 *   아무도 안 읽는다. 그 갈래는 `ranWithUserPrivilege` 가 정확히 가른다.
 */
const RAN_WITH_USER_PRIVILEGE_EXECUTIONS = new Set(['completed', 'timeout', 'hung', 'lingering']);

const PREPARATION_PRIVATE = new WeakMap();

/** 하위 모듈의 `{blocked:true}` 인가. `ok:true` 결과와 겹치지 않는다. */
// ★ `src/engine.mjs`·`src/run-finalization.mjs` 에 같은 한 줄이 있다 — 복사인 근거는 머리말.
const isBlocked = (result) => ownDataValue(result, 'blocked').value === true;

/**
 * 공유 `cloneData` 의 **닫히는** 어댑터 — 복사할 수 없으면 던진다.
 *
 * ★ 공유 `cloneData` 는 절대 던지지 않는다. 그것이 옳다 — 검증기가 입력 때문에 터지면 안 된다.
 *   하지만 이 복사 자리들은 주입된 의존이 만든 **남의 객체**를 받는다. 조용히 `undefined` 를
 *   흘려보내면 `{ ...undefined }` 가 빈 객체로, `?? []` 가 빈 배열로 **살아서 지나간다** —
 *   적대적 입력이 통과했다는 뜻이다. 예전 `qualityClone`(JSON 왕복)이 순환 참조에서 TypeError
 *   를 내던 것이 이 자리의 실제 계약이었다(`c2 hostile posteriors and settings ...` 가 그
 *   예외에 서 있다).
 * ★ **던지는 것은 catch 가 그것을 고정된 reason code 로 닫아 주는 자리에서만 쓴다.** 지금 감싸는
 *   자리는 다섯이고 전부 그렇다(WS8 컷 1 뒤 둘은 `src/engine.mjs` 에, 셋은 이 파일에 있다):
 *     - `readPosteriors`·`readSettings` 복사 → 같은 try 의 catch 가 `binding_preparation_failed`;
 *     - `runCandidateEvidence` 의 증거 복사 → `candidate-lane` 이 `evaluateAttempt` 호출을
 *       try 로 감싸고 있어 예외가 그 레인의 blocked 판정이 된다;
 *     - `buildJudgeView` 의 delta/evidence 복사 → 여기 try 에는 `finally` 뿐이라 던진 것은
 *       그대로 **호출부로 나가고**, 그것을 잡는 것은 `src/candidate-lane.mjs` ~:740 의
 *       `catch { summary.judgeView = null }` 다 — 판정 뷰가 없어지고 레인은 계속 간다.
 *   catch 가 없는 자리(고정 테스트 계획 복사, 대체 후보 복사)는 이 어댑터를 **쓰지 않는다** —
 *   던진 토큰이 봉투의 error 로 새어 나가기 때문이다. 그 둘은 각자 자기 실패 경로로 닫는다.
 */
function requiredClone(value) {
  const cloned = cloneData(value);
  if (cloned === undefined && value !== undefined) throw new TypeError('clone_failed');
  return cloned;
}

async function runPreparedLane(input) {
  const { preparation, laneIndex, context, artifactAuthority, judgeViewProjector = null } = input;
  const laneId = laneIndex === 0 ? 'lane-a' : 'lane-b';
  const laneWorktree = preparation.laneWorktrees[laneIndex];
  const laneBinding = preparation.laneBindings[laneIndex];
  const privateFacts = {
    // 설계 §5.8 S1 — 이 런에서 저장소 테스트 스위트를 사용자 권한으로 실제로 돌렸는가.
    userPrivilegeObserved: false,
    privatePatches: new Map(),
    attemptDeltas: new Map(),
    evidenceByAttempt: new Map(),
    attemptArtifactRefs: new Map(),
    contentEvidenceRefs: new Map(),
    contentEvidenceOmissions: { count: 0 },
    judgeViews: null,
  };
  const boundary = {
    preparation,
    laneIndex,
    laneId,
    laneWorktree,
    laneBinding,
    context,
    artifactAuthority,
    privateFacts,
    judgeViewProjector,
  };
  const adapters = createPreparedLaneAdapters(boundary);
  try {
    const candidate = await runCandidateLane({
      runId: preparation.runId,
      laneId,
      task: context.task,
      plan: preparation.plan,
      binding: laneBinding,
      budget: context.budget,
      // 재개된 실행의 레인은 원본이 **봉인한** 마지막 서수의 다음부터 쓴다(WS3 §3). 그 서수는
      // 레인마다가 아니라 실행 전체에서 하나다 — 근거는 `resumeStarts`. 재개가 아니면 1 이다.
      startOrdinal: preparation.resume?.startOrdinal ?? 1,
      deadlineAt: preparation.deadlineAt,
      baseline: preparation.baseline,
      proofRequirement: preparation.proofRequirement,
      frozenTestPlan: preparation.frozenTestPlan,
      authoringWorktree: laneWorktree,
    }, adapters);
    return deepFreeze({
      candidate,
      judgeViews: privateFacts.judgeViews,
      contentFacts: laneContentFacts(candidate, privateFacts),
      userPrivilegeObserved: privateFacts.userPrivilegeObserved === true,
    });
  } finally {
    privateFacts.privatePatches.clear();
    privateFacts.attemptDeltas.clear();
    privateFacts.evidenceByAttempt.clear();
    privateFacts.attemptArtifactRefs.clear();
    privateFacts.contentEvidenceRefs.clear();
  }
}

function createPreparedLaneAdapters(input) {
  const {
    preparation, laneIndex, laneId, laneWorktree, laneBinding, context,
    artifactAuthority, privateFacts, judgeViewProjector,
  } = input;
  const {
    runId, stateRoot, deadlineAt, frozenTestPlan, baseline, proofRequirement, scopeAllow,
    plan, artifactPaths, artifactStore, manifestAuthority, artifactRevisionAuthority, testQueue, evidenceCache,
  } = preparation;
  const { laneProviders, callProvider, progress, faultRegistry } = PREPARATION_PRIVATE.get(preparation);
  const providers = laneProviders[laneIndex];
  const {
    deps, task, budget, deadline, now, stage, recoveryStage, onSpawn, killLiveChildren, haltReasonCode,
  } = context;
  const {
    checkpoint, artifactStorePoison, poisonedArtifactResult, poisonArtifactStore,
    handoffWorktree, writeAttempt, writeEvidence, writeCandidate, setLatestManifestRef,
    isStoreAuthorityLost = () => false,
  } = artifactAuthority;
  const {
    privatePatches, attemptDeltas, evidenceByAttempt, attemptArtifactRefs, contentEvidenceRefs,
    contentEvidenceOmissions,
  } = privateFacts;
  const classifyWriterResult = (rawResult, writer) => classifyArtifactSettlement(rawResult, {
    kind: 'writer',
    authority: { writer, manifest: manifestAuthority },
  });
  const acceptWriterResult = (settlement) => settlement.kind === 'success' &&
    acceptArtifactRevision(settlement.result, artifactRevisionAuthority);
  const snapshotStep = deps.snapshotStep ?? defaultSnapshotStep;
  const revisionIdentity = deps.revisionIdentity ?? defaultRevisionIdentity;
  const listRevisionDelta = deps.listRevisionDelta ?? defaultListRevisionDelta;
  const collectPatchAtRevision = deps.collectPatchAtRevision ?? defaultCollectPatchAtRevision;
  const inspectPatch = deps.inspectPatch ?? defaultInspectPatch;
  const listIgnoredPaths = deps.listIgnoredPaths ?? defaultListIgnoredPaths;
  const identity = (role, attemptId = null) => ({ laneId, attemptId, role, judgeIndex: null });
  const label = (value) => preparation.candidateCount === 1 ? value : `${laneId} ${value}`;

  return {
    now,
    isAborted: () => deadline?.aborted === true,
    // ★ 레인은 접힌 신호만 보므로(`isAborted`) 「누가 껐는가」를 답할 수 없다. 그 답은 이 한
    //   함수로만 내려간다 — 레인이 `hostSignal` 을 직접 받으면 판정 자리가 둘이 된다(§0-C1).
    haltReasonCode,
    checkpointAttemptAllocation: (value) => checkpoint(artifactStore, {
      eventId: `attempt:${value.laneId}:${String(value.ordinal).padStart(3, '0')}:allocated`,
      type: 'attempt_allocated',
      laneId: value.laneId,
      ordinal: value.ordinal,
      attemptId: value.attemptId,
      retryOf: value.retryOf,
    }),
    callWriter: async (value) => {
      let result;
      try {
        result = await callProvider({
          provider: providers.writer,
          binding: laneBinding.writer,
          kind: 'writer',
          laneId,
          attemptId: value.attemptId,
          instruction: workerInstruction({
            task,
            plan,
            step: value.ordinal,
            budget,
            feedback: workerFeedback(value.feedback.openIds),
          }),
          workspace: laneWorktree.path,
          tools: [...WORKER_TOOLS],
        });
      } catch (error) {
        // ★ 정지 **경계 앞**에서 끊긴 호출은 아예 시작되지 않았다(`timeout`). 그 뒤에 던진
        //   것은 자식이 이미 떠 있었을 수 있으므로 효과를 모른다.
        // ★★ 사유는 **소스**가 정한다: 이 자리가 마감 코드를 리터럴로 적던 동안, 호스트가 끊은
        //   실행의 결함 장부와 실행 로그가 "마감이 지났다" 고 적었다(태스크 7 리뷰 M1).
        const reasonCode = error?.preBoundary === true ? haltReasonCode() : REASON.provider_outcome_unknown;
        faultRegistry.recordFault(unclassifiedFault(reasonCode, providers.writer.id), { kind: 'writer', laneId });
        return {
          status: error?.preBoundary === true ? REASON.provider_deadline_exceeded : REASON.provider_outcome_unknown,
          callStarted: error?.preBoundary !== true,
          usage: { promptTokens: null, evalTokens: null },
        };
      }
      // 레인에게는 **토큰만** 준다. 왜 그렇게 됐는지(카탈로그 결함)는 `callProvider` 안의
      // `recordProviderOutcome` 이 이미 결함 장부에 넣었고 봉투는 거기서 읽는다 — 같은 사실을
      // 반환값에도 실으면 아무도 안 읽는 두 번째 사본이 생긴다(candidate-lane 은 손대지 않는다).
      const settlement = qualityWriterSettlement(result, providers.writer.id);
      return {
        status: settlement.status,
        usage: { promptTokens: result?.promptTokens, evalTokens: result?.evalTokens },
      };
    },
    sealAttempt: async ({ attemptId, ordinal }) => {
      const snapshot = await stage(label('writer snapshot'), () =>
        snapshotStep(laneWorktree, `bom-orch attempt ${ordinal} writer`), {
        mayTouchWorktree: true,
        worktreePath: laneWorktree.path,
      });
      // ★ 네 return 이 각자 코드를 갖는다(WS2 §3.3). 예전에는 넷이 두 토큰(`snapshot_failed`·
      //   `seal_failed`)으로 접혔고, 그중 셋이 같은 한 토큰이라 "무엇이 실패했는가" 가 사라졌다.
      //   `writerResult` 는 디스크에 남는 닫힌 어휘라 그대로 두고, 코드는 봉투로 따로 나간다.
      const sealFailed = (reasonCode, writerResult) => {
        faultRegistry.recordFault(unclassifiedFault(reasonCode), { kind: 'seal', laneId });
        return { ok: false, writerResult };
      };
      if (isBlocked(snapshot) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot?.commit ?? '')) {
        return sealFailed(REASON.evidence_snapshot_failed, REASON.git_snapshot_failed);
      }
      const revision = await stage(label('revision identity'), () =>
        revisionIdentity(laneWorktree, snapshot.commit));
      if (revision?.ok !== true || revision.commit !== snapshot.commit ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision.tree ?? '')) {
        return sealFailed(REASON.evidence_seal_failed, REASON.git_seal_failed);
      }
      const delta = await stage(label('revision delta'), () =>
        listRevisionDelta(laneWorktree, { from: baseline.commit, to: revision.commit }));
      const validDeltaEntry = (entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
            Reflect.ownKeys(entry).length !== 4 ||
            !['path', 'status', 'oldMode', 'newMode'].every((key) => Object.hasOwn(entry, key))) return false;
        const regular = (mode) => mode === '100644' || mode === '100755';
        return entry.status === 'added' ? entry.oldMode === null && regular(entry.newMode)
          : entry.status === 'deleted' ? regular(entry.oldMode) && entry.newMode === null
            : entry.status === 'modified' && regular(entry.oldMode) && regular(entry.newMode);
      };
      if (isBlocked(delta) || delta?.ok !== true || !Array.isArray(delta.entries) ||
          delta.entries.some((entry) => typeof entry?.path !== 'string' || entry.path === '' ||
            entry.path.includes('\\') || !validDeltaEntry(entry)) ||
          delta.entries.some((entry, index) => index > 0 &&
            compareUtf8(delta.entries[index - 1].path, entry.path) >= 0)) {
        return sealFailed(REASON.git_diff_failed, REASON.git_seal_failed);
      }
      const patch = await stage(label('candidate patch collection'), () =>
        collectPatchAtRevision(laneWorktree, { from: baseline.commit, to: revision.commit }), {
        mayTouchWorktree: true,
        worktreePath: laneWorktree.path,
      });
      progress('patch', ordinal, identity('worker', attemptId));
      const deltaPaths = delta.entries.map((entry) => entry.path);
      if (isBlocked(patch) || patch?.ok !== true || !Buffer.isBuffer(patch.patch) ||
          patch.sha256 !== sha256(patch.patch) || patch.empty !== (patch.patch.length === 0) ||
          !Array.isArray(patch.files) || patch.files.length !== deltaPaths.length ||
          patch.files.some((path, index) => path !== deltaPaths[index])) {
        return sealFailed(REASON.artifact_patch_write_failed, REASON.git_seal_failed);
      }
      const patchSha256 = sha256(patch.patch);
      privatePatches.set(attemptId, Buffer.from(patch.patch));
      attemptDeltas.set(attemptId, {
        delta,
        files: [...patch.files],
        empty: patch.empty,
        sha256: patchSha256,
        identity: revision,
      });
      return {
        ok: true,
        sealed: {
          commit: revision.commit,
          treeHash: revision.tree,
          patchSha256,
          testPlanFingerprint: frozenTestPlan.planFingerprint,
        },
      };
    },
    evaluateAttempt: async ({ attemptId, sealed }) => {
      const stored = attemptDeltas.get(attemptId);
      const ignored = await stage(label('ignored path listing'), () => listIgnoredPaths(laneWorktree));
      const scope = await stage(label('patch inspection'), () => inspectPatch({
        files: stored.delta.entries.map((entry) => entry.path),
        worktree: laneWorktree.path,
        baseline: baseline.commit,
        // 실행 하나의 허용목록(위 준비가 접은 합집합). 판정은 생산자가 하고 여기서는 나르기만 한다.
        allow: scopeAllow,
      }));
      progress('scope', Number(attemptId.slice(-3)), identity('worker', attemptId));
      if (isBlocked(scope) || !Array.isArray(ignored)) {
        // ★★ 봉투는 이 실패를 `evidence_authority_mismatch` 하나로 접는다 — 스코프를 못 재면 증거의
        //   권위가 없는 것이 맞다. 하지만 그 접기는 **왜** 를 통째로 버린다. 진단 채널은 조언만 하는
        //   채널이라 봉투를 바꾸지 않고, 그곳에만 생산자가 넘긴 평면 `detail`(git 의 stderr 앞 200자)을 적는다.
        //   `logLine` 이 세척기를 지나므로 경로·비밀은 여기서 접힌다(`src/diag.mjs`).
        if (isBlocked(scope)) {
          context.logLine('warn', reasonCodeOf(scope, REASON.scope_inspection_failed), label('patch inspection'), {
            detail: typeof scope.detail === 'string' ? scope.detail : scope.error ?? '',
          });
        }
        return { evidence: [], cleanup: [], operationalFailure: { code: 'evidence_authority_mismatch' } };
      }
      // 생산자가 낸 범위 사실 **한 벌**. 사유 객체({path, rule, tier, detail})를 그대로 나른다 —
      // 세는 것과 말하는 것은 다른 일이고, 예전에는 개수만 남아 봉투가 "몇 건 걸렸다" 까지만
      // 말했다(WS2 Task 11).
      // ★ `hardViolation`(WS5 T1)·`allowlisted`(WS5 T2)는 생산자가 이미 잰 값이다. 여기서 다시
      //   세지 않는다 — `reasons` 는 상한에 잘려 있고, 잘린 목록으로 다시 세면 등급이 사라진다.
      // ★★ 이 벌을 **컷의 양쪽이 함께** 쓴다(WS5 T4). 예전에는 통과 갈래가
      //   `{flagged: false, …}` 를 손으로 지었는데, 승인된 플래그가 아래로 흐르기 시작하면
      //   그 상수가 봉투에서 플래그를 **지운다** — 종료 기준 EC-1 이 요구하는 것이 정확히
      //   「succeeded 인데 `scope.flagged: true`」이므로 그 지움이 곧 이 태스크의 실패다.
      const scopeSummary = {
        flagged: scope.flagged === true,
        hardViolation: scope.hardViolation === true,
        allowlisted: scope.allowlisted === true,
        reasons: scope.reasons ?? [],
        reasonCount: scope.reasons?.length ?? 0,
        omittedReasonCount: scope.omitted ?? 0,
        changedFileCount: stored.delta.entries.length,
      };
      // ★★ **컷 (3)/셋** (WS5 T4, 스펙 §0 D12). 승인된 플래그는 여기서 멈추지 않고 아래로 흘러
      //   `splitTestOnlyDelta` → 증거 실행 → 정상 판정을 받는다. 미승인이 하나라도 남으면
      //   오늘 그대로다: 테스트를 **아예 안 돌리고**(`execution: 'not_run'`) 조기 반환한다.
      //   ★ 통과는 비용을 **늘리는** 방향이다 — 오늘 flagged 는 스위트를 0회 돌렸고, 이제
      //     승인된 실행은 c/1·c/2 를 실제로 돌린다(WS4b 의 `preflight.warnings` 배수).
      if (scopeSummary.flagged && !scopeSummary.allowlisted) {
        return {
          tests: { execution: 'not_run', outcome: 'unknown', stability: 'unknown', complete: false, trusted: false, failureFingerprints: [] },
          regressionProof: { required: proofRequirement.required, status: proofRequirement.required ? 'unavailable' : 'not_applicable', repairable: false, evidenceIds: [], witnessIds: [], reasonCodes: [REASON.scope_policy_failure] },
          evidence: [], cleanup: [], operationalFailure: null,
          scope: scopeSummary,
        };
      }
      const splitDelta = deps.splitTestOnlyDelta ?? splitTestOnlyDelta;
      const testDelta = await splitDelta({
        entries: stored.delta.entries,
        baselineRevision: baseline.commit,
        candidateRevision: sealed.commit,
        testPlan: frozenTestPlan,
        ignoredPaths: ignored,
        unsafePaths: stored.delta.unsafePaths ?? [],
        candidateWorktree: laneWorktree,
      }, { collectPatchAtRevision });
      if (testDelta?.status === 'unsafe') {
        // ★★ 정본은 **레지스트리 이름**이다. Task 15 가 `splitTestOnlyDelta`(src/regression-proof.mjs)
        //   의 어휘를 옮기면서 이 집합만 옛 철자로 남았고, 그 순간 일곱 중 여섯이 여기서 안
        //   걸렸다 — gitignore 아래 테스트 파일을 건드린 후보 같은 **정책 위반**이 아래
        //   `evidence_authority_mismatch`(증거 인프라 결함)로 나갔고, `scope.flagged`·
        //   `reasonCount` 와 stopReason `policy_failure` 가 봉투까지 오지 못했다. 실행이 통째로
        //   다른 등급으로 채점됐다. 초록이던 이유는 하나뿐이다: 엔진 테스트가 주입하던 사유가
        //   개명되지 않은 유일한 철자 `test_definition_tampering` 이었다. 이제
        //   `test/guards/reason-code-literals.test.mjs` 가 집합·배열 상수의 원소도 본다.
        const policyReasons = new Set([
          REASON.test_definition_tampering, REASON.test_delta_unsafe_path, REASON.test_delta_ignored_path,
          REASON.test_delta_path_invalid, REASON.test_delta_duplicate_path,
          REASON.test_delta_ignored_path_invalid, REASON.test_delta_unsafe_path_invalid,
        ]);
        // ★ 주입된 의존성과 디스크에 남은 값은 옛 철자를 낼 수 있다 — **읽기에서만** 올린다(§2.4).
        const candidatePolicyFailure = Array.isArray(testDelta.reasonCodes) &&
          testDelta.reasonCodes.some((reason) => policyReasons.has(normalizeLegacyReasonCode(reason) ?? reason));
        if (!candidatePolicyFailure) {
          return { evidence: [], cleanup: [], operationalFailure: { code: 'evidence_authority_mismatch' } };
        }
        return {
          tests: { execution: 'not_run', outcome: 'unknown', stability: 'unknown', complete: false, trusted: false, failureFingerprints: [] },
          regressionProof: { required: proofRequirement.required, status: proofRequirement.required ? 'unavailable' : 'not_applicable', repairable: false, evidenceIds: [], witnessIds: [], reasonCodes: [REASON.scope_policy_failure] },
          evidence: [], cleanup: [], operationalFailure: null,
          // ★ 이 가지가 **더하는** 사유는 `splitTestOnlyDelta` 의 **reason code** 라 {path, rule,
          //   detail} 목록에 못 실린다 — 그래서 **개수만** 합친다(아래 `reasonCount`). 생산자가 낸
          //   사유 **목록**은 `...scopeSummary` 가 그대로 살린다(아래 ★★). 어휘 이전은 Task 15 다.
          // ★★ 이 가지는 **하드**다(WS5 스펙 §0 D1 의 「테스트 명령 설정」). 걸린 사유는 위
          //   `policyReasons` 여섯 — 테스트 정의를 건드렸거나 gitignore 아래 테스트를 고친 것이고,
          //   그것은 `.bom-orch.json` 을 고친 것과 같은 힘이다. 여기를 `false` 로 두면 T4 의 컷이
          //   착지하는 날 이 가지가 조용히 실패를 면한다 — 등급을 안 말한 것이 면제가 된다.
          //   ★★ 같은 이유로 `allowlisted` 는 **명시적으로 거짓**이다. 이 가지의 사유는 목록이
          //   비어 있고(위 ★), 「전부 승인됐나」를 빈 목록 위에서 접으면 공허하게 참이
          //   된다 — 그 참이 곧 T4 의 컷이 이 가지를 면제하는 길이다. 허용목록으로 지울 수 있는
          //   것이 아니라는 사실을 여기서 값으로 말한다.
          // ★★ 그리고 **위 벌 위에 얹는다**(WS5 T4). 이 가지는 이제 승인된 플래그를 지나온
          //   실행에서도 설 수 있다(예: 적힌 lockfile + 테스트 정의 변조). 상수 객체를 그대로
          //   두면 그때 생산자가 낸 사유 목록이 통째로 사라진다 — 개수만 합치고 목록은 살린다.
          scope: {
            ...scopeSummary,
            flagged: true,
            hardViolation: true,
            allowlisted: false,
            reasonCount: scopeSummary.reasonCount + testDelta.reasonCodes.length,
          },
        };
      }
      const evidenceRunner = deps.runCandidateEvidence ?? runCandidateEvidence;
      progress('tests', Number(attemptId.slice(-3)), identity('worker', attemptId));
      const evidence = await stage(label('candidate evidence'), () => evidenceRunner({
        runId, laneId, attemptId, baseline,
        candidate: { ...sealed }, frozenTestPlan, proofRequirement, testDelta,
        deadlineAt, testQueue, cache: evidenceCache,
      }, {
        sourceWorktree: laneWorktree,
        stateRoot,
        createRevisionWorktree: deps.createRevisionWorktree ?? defaultCreateRevisionWorktree,
        revisionIdentity,
        // ★ S1 신고의 관측 지점. 자식이 실제로 떴는지를 아는 곳은 여기 하나뿐이다 — 레인 요약도
        //   attempt 기록도 이 사실을 안 들고 나온다. 어느 레인의 어느 시도였든 한 번이라도
        //   돌았으면 런 전체가 신고 대상이다.
        runFrozenTests: async (...args) => {
          const record = await (deps.runFrozenTests ?? defaultRunFrozenTests)(...args);
          if (record?.ranWithUserPrivilege === true) privateFacts.userPrivilegeObserved = true;
          return record;
        },
        removeWorktree: deps.removeWorktree ?? defaultRemoveWorktree,
        killTrackedChildren: deps.killTrackedChildren,
        checkFrozenEnvironment: deps.checkFrozenEnvironment,
        selectTestDeltaWitnesses: deps.selectTestDeltaWitnesses,
        onSpawn: (child, evidenceAuthority) => onSpawn(child, preparation.candidateCount === 1
          ? { ...evidenceAuthority }
          : {
              ...evidenceAuthority,
              laneId,
              attemptId,
              role: 'tests',
              reportIdentity: true,
              ownerWorktreePath: laneWorktree.path,
            }),
        now,
        persistEvidence: (value, authority) => {
          if (isStoreAuthorityLost()) return Promise.resolve(poisonedArtifactResult());
          const onAbort = () => poisonArtifactStore(REASON.evidence_store_authority_lost, { authorityLost: true, laneId });
          if (authority?.signal?.aborted === true) onAbort();
          else authority?.signal?.addEventListener?.('abort', onAbort, { once: true });
          let pending;
          try {
            pending = Promise.resolve(writeEvidence(artifactStore, value, authority));
          } catch (error) {
            authority?.signal?.removeEventListener?.('abort', onAbort);
            throw error;
          }
          return pending.then((rawResult) => {
            const recordBytes = Buffer.from(`${JSON.stringify(value.record, null, 2)}\n`, 'utf8');
            const expectedPath = join(
              artifactPaths.runDir,
              'evidence',
              `${laneId}-${String(value.attemptOrdinal).padStart(3, '0')}-${String(value.evidenceOrdinal).padStart(3, '0')}.json`,
            );
            const settlement = classifyWriterResult(rawResult, {
              kind: 'evidence', candidateId: laneId, path: expectedPath,
              bytes: recordBytes.length, sha256: sha256(recordBytes),
            });
            const accepted = acceptWriterResult(settlement);
            const result = accepted ? settlement.result : settlement.kind === 'success'
              ? unknownArtifactSettlement() : settlement.result;
            if (settlement.kind === 'success' && !accepted) poisonArtifactStore(REASON.artifact_store_authority_lost, {
              laneId, authorityLost: true,
            });
            if (settlement.kind === 'unknown') poisonArtifactStore(REASON.artifact_store_authority_lost, {
              laneId, authorityLost: true,
            });
            const authorityLost = artifactAuthorityLost(result);
            if (authorityLost) poisonArtifactStore(
              preparation.candidateCount === 1 ? REASON.artifact_store_authority_lost : reasonCodeOf(result, REASON.artifact_store_authority_lost), {
                laneId, authorityLost: true, deadlineLost: result?.hardStopped === true,
              },
            );
            else if (preparation.candidateCount === 2 && isBlocked(result)) {
              poisonArtifactStore(REASON.evidence_persistence_failed, { laneId });
            }
            else if (!isBlocked(result) && settlement.kind !== 'success') return unknownArtifactSettlement();
            setLatestManifestRef(result?.manifestRef);
            if (!isBlocked(result) && typeof result?.ref?.path === 'string') {
              const projection = contentEvidenceRef(value.record, result.ref.path, { attemptId, expectedPath });
              if (projection !== null) contentEvidenceRefs.set(projection.evidenceId, projection);
              else contentEvidenceOmissions.count += 1;
            }
            return result;
          }).catch(() => {
            poisonArtifactStore(REASON.artifact_store_authority_lost, { authorityLost: true, laneId });
            return fail(REASON.artifact_store_authority_lost);
          }).finally(() => authority?.signal?.removeEventListener?.('abort', onAbort));
        },
        handoffEvidenceCleanup: async ({ path }) =>
          handoffWorktree(path, label('producer evidence worktree handoff')),
        runnerDeps: deps.testRunnerDeps,
      }), { mayTouchWorktree: true, worktreePath: laneWorktree.path });
      if (evidence?.hardStopped === true) poisonArtifactStore(REASON.evidence_controller_authority_lost, {
        authorityLost: true, deadlineLost: true, laneId,
      });
      // S1 신고의 두 번째 관측 지점. `runFrozenTests` 래퍼가 정확한 신호이지만 증거 러너를 통째로
      // 갈아끼우는 경로에서는 그 래퍼가 안 불린다. 분류값이 **모호하지 않게** 실행을 말할 때도
      // 신고한다 — `aborted` 는 스폰 전/후를 구분 못 하므로 여기 넣지 않는다.
      if (RAN_WITH_USER_PRIVILEGE_EXECUTIONS.has(evidence?.tests?.execution)) {
        privateFacts.userPrivilegeObserved = true;
      }
      evidenceByAttempt.set(attemptId, requiredClone(evidence?.evidence ?? []));
      return {
        // ★★ 생산자가 낸 벌을 그대로 나른다(WS5 T4). 아무것도 안 걸린 실행에서 이 값은
        //   예전의 상수와 **같은 바이트**이고(전부 거짓·빈 목록·0), 승인된 플래그를 지나온
        //   실행에서만 달라진다 — 그 다름이 종료 기준 EC-1 의 「succeeded + flagged」다.
        ...evidence,
        scope: scopeSummary,
      };
    },
    callVerifier: async ({ expected, feedback, formatCorrection, machineEvidence }) => {
      let result;
      const beforeStatus = await stage(label('verifier status before'), () =>
        (deps.statusSnapshot ?? defaultStatusSnapshot)(laneWorktree)).catch(() => null);
      const beforeIgnored = await stage(label('verifier ignored before'), () =>
        listIgnoredPaths(laneWorktree)).catch(() => null);
      try {
        result = await callProvider({
          provider: providers.verifier,
          binding: laneBinding.verifier,
          kind: formatCorrection ? 'verifier_format' : 'verifier',
          laneId,
          attemptId: expected.attemptId,
          instruction: verifierInstruction({
            task,
            plan,
            files: attemptDeltas.get(expected.attemptId)?.files ?? [],
            tests: describeMachineEvidence(machineEvidence),
            expected,
            feedback,
            formatOnly: formatCorrection,
          }),
          workspace: laneWorktree.path,
          tools: [...VERIFIER_TOOLS],
        });
      } catch (error) {
        // writer 쪽과 **같은 규칙**이다(위 `callWriter` 의 WHY): 경계 앞의 절단은 정지이고,
        // 그 정지의 이름은 어느 신호가 발화했는가에서 온다.
        const reasonCode = error?.preBoundary === true ? haltReasonCode() : REASON.provider_outcome_unknown;
        faultRegistry.recordFault(unclassifiedFault(reasonCode, providers.verifier.id), { kind: 'verifier', laneId });
        return { operationalFailure: true, callStarted: error?.preBoundary !== true, raw: null, usage: { promptTokens: null, evalTokens: null }, touchedSources: [], mutationCheck: { clean: false } };
      }
      const verifierSettlement = qualityWriterSettlement(result, providers.verifier.id);
      if (verifierSettlement.status !== 'sealed') {
        return { operationalFailure: true, callStarted: true, raw: null, usage: { promptTokens: result?.promptTokens, evalTokens: result?.evalTokens }, touchedSources: [], mutationCheck: { clean: false } };
      }
      const afterStatus = await stage(label('verifier status after'), () =>
        (deps.statusSnapshot ?? defaultStatusSnapshot)(laneWorktree)).catch(() => null);
      const afterIgnored = await stage(label('verifier ignored after'), () =>
        listIgnoredPaths(laneWorktree)).catch(() => null);
      // ★★ 「스냅샷을 못 찍었다」와 「verifier 가 트리를 바꿨다」는 **다른 사실**이다. 하나의
      //   `clean:false` 로 뭉치면 일시적인 git 실패(잠긴 인덱스 등)가 변조 판정으로 나가고,
      //   그 lane 은 rejected/disputed 로 끝난다 — 설계 §4 불변식 7 이 금지한 「인프라 실패가
      //   semantic FAIL 로 위장」이다. 가용성을 따로 실어 lane 이 blocked 로 보내게 한다.
      const available = beforeStatus?.ok === true && afterStatus?.ok === true &&
        Array.isArray(beforeIgnored) && Array.isArray(afterIgnored);
      const clean = available &&
        JSON.stringify(beforeStatus) === JSON.stringify(afterStatus) &&
        JSON.stringify(beforeIgnored) === JSON.stringify(afterIgnored);
      return {
        raw: { content: result?.content ?? '', truncated: result?.truncated === true },
        usage: { promptTokens: result?.promptTokens, evalTokens: result?.evalTokens },
        touchedSources: [],
        mutationCheck: { clean, available },
      };
    },
    writeAttemptArtifact: async (record) => {
      if (isStoreAuthorityLost()) return poisonedArtifactResult();
      const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      const rawResult = await stage(label('attempt artifact'), () =>
        writeAttempt(artifactStore, { laneId, ordinal: record.ordinal, record })).catch(() => {
        poisonArtifactStore(REASON.artifact_store_authority_lost, { authorityLost: true, laneId });
        return fail(REASON.artifact_store_authority_lost);
      });
      const settlement = classifyWriterResult(rawResult, {
        kind: 'attempt', candidateId: laneId,
        path: join(artifactPaths.runDir, 'attempts', `${laneId}-${String(record.ordinal).padStart(3, '0')}.json`),
        bytes: recordBytes.length, sha256: sha256(recordBytes),
      });
      const accepted = acceptWriterResult(settlement);
      const result = accepted ? settlement.result : settlement.kind === 'success'
        ? unknownArtifactSettlement() : settlement.result;
      if (settlement.kind === 'success' && !accepted) poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId,
      });
      if (settlement.kind === 'unknown') poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId,
      });
      if (artifactAuthorityLost(result)) poisonArtifactStore(
        preparation.candidateCount === 1 ? REASON.artifact_store_authority_lost : reasonCodeOf(result, REASON.artifact_store_authority_lost), {
          authorityLost: true, deadlineLost: result?.hardStopped === true, laneId,
        },
      );
      else if (preparation.candidateCount === 2 && isBlocked(result)) poisonArtifactStore(REASON.artifact_attempt_write_failed, { laneId });
      setLatestManifestRef(result?.manifestRef);
      if (!isBlocked(result) && typeof result?.ref?.path === 'string') {
        attemptArtifactRefs.set(record.attemptId, result.ref.path);
      }
      return result;
    },
    persistCandidatePatch: async ({ sourceAttemptId, sealed }) => {
      const bytes = privatePatches.get(sourceAttemptId);
      if (!Buffer.isBuffer(bytes) || sha256(bytes) !== sealed.patchSha256) return { blocked: true };
      if (isStoreAuthorityLost()) return poisonedArtifactResult();
      const rawWritten = await recoveryStage(label('candidate artifact'), () =>
        writeCandidate(artifactStore, { laneId, sourceAttemptId, patch: bytes })).catch(() => {
        poisonArtifactStore(REASON.artifact_store_authority_lost, { authorityLost: true, laneId });
        return fail(REASON.artifact_store_authority_lost);
      });
      const settlement = classifyWriterResult(rawWritten, {
        kind: 'candidate', candidateId: laneId, path: artifactPaths.candidatePaths[laneId],
        bytes: bytes.length, sha256: sha256(bytes),
      });
      const accepted = acceptWriterResult(settlement);
      const written = accepted ? settlement.result : settlement.kind === 'success'
        ? unknownArtifactSettlement() : settlement.result;
      if (settlement.kind === 'success' && !accepted) poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId,
      });
      if (settlement.kind === 'unknown') poisonArtifactStore(REASON.artifact_store_authority_lost, {
        authorityLost: true, laneId,
      });
      if (artifactAuthorityLost(written)) poisonArtifactStore(
        preparation.candidateCount === 1 ? REASON.artifact_store_authority_lost : reasonCodeOf(written, REASON.artifact_store_authority_lost), {
          authorityLost: true, deadlineLost: written?.hardStopped === true, laneId,
        },
      );
      else if (preparation.candidateCount === 2 && isBlocked(written)) poisonArtifactStore(REASON.artifact_candidate_write_failed, { laneId });
      if (isBlocked(written)) return written;
      if (settlement.kind !== 'success') return unknownArtifactSettlement();
      setLatestManifestRef(written?.manifestRef);
      if (judgeViewProjector === null) privatePatches.clear();
      return {
        sourceAttemptId,
        ref: written.ref,
        empty: bytes.length === 0,
        files: attemptDeltas.get(sourceAttemptId)?.files ?? [],
      };
    },
    quarantineWorktree: async (value) => {
      let quarantineHardStopped = false;
      if (typeof deps.quarantineWorktree === 'function') {
        const quarantined = await recoveryStage(label('authoring worktree quarantine'), () =>
          deps.quarantineWorktree(value)).catch(() => false);
        const hardStopped = ownDataValue(quarantined, 'hardStopped');
        quarantineHardStopped = hardStopped.ok !== true || hardStopped.value !== false;
      }
      await killLiveChildren(laneWorktree.path);
      if (quarantineHardStopped) return false;
      return handoffWorktree(laneWorktree.path, label('quarantined worktree handoff'));
    },
    handoffEvidenceCleanup: async ({ path }) => handoffWorktree(path, label('evidence worktree handoff')),
    ...(judgeViewProjector === null ? {} : {
      buildJudgeView: ({ candidate, sourceAttemptId, finalLedger }) => {
        const bytes = privatePatches.get(sourceAttemptId);
        const delta = attemptDeltas.get(sourceAttemptId)?.delta;
        const evidence = evidenceByAttempt.get(sourceAttemptId);
        if (!Buffer.isBuffer(bytes) || !Array.isArray(delta?.entries) || !Array.isArray(evidence)) return null;
        try {
          const views = judgeViewProjector({
            candidate,
            privateFacts: {
              patchBytes: Buffer.from(bytes),
              deltaEntries: requiredClone(delta.entries),
              persistedEvidence: requiredClone(evidence),
              finalLedger,
            },
          });
          if (!Array.isArray(views) || views.length !== 2 || views.some((view) => view === null)) return null;
          privateFacts.judgeViews = deepFreeze([...views]);
          return views[0];
        } finally {
          privatePatches.delete(sourceAttemptId);
          attemptDeltas.delete(sourceAttemptId);
          evidenceByAttempt.delete(sourceAttemptId);
        }
      },
    }),
  };
}

export { PREPARATION_PRIVATE, requiredClone, runPreparedLane };
