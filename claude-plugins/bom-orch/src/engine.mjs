import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readSettings as defaultReadSettings, resolveTier } from './config.mjs';
import { timeoutSignal } from './deadline.mjs';
import { runCandidateLane } from './candidate-lane.mjs';
import {
  buildJudgeView as createJudgeView,
  makeBlindPair,
  parseJudgeDecision,
  remapJudgeDecision,
  selectCandidates,
  selectSingleCandidate,
} from './candidate-selection.mjs';
import { renderContentParts, validateArtifactPathBudget } from './content-projection.mjs';
import { failure, MAX_CONTENT_CHARS, success } from './envelope.mjs';
import { inspectRepo as defaultInspectRepo } from './git.mjs';
import { AXES, decide, evidenceParagraph, gradeToDeltas } from './learn/bandit.mjs';
import { POLICY_V2_AXES } from './learn/policy-v2.mjs';
import { computeRunLearningOutcome } from './learn/policy-v2.mjs';
import { classifyTask } from './learn/classify.mjs';
import { appendRun as defaultAppendRun } from './learn/journal.mjs';
import {
  cellKeyOf,
  commitLearningMutation as defaultCommitLearningMutation,
  readPosteriors as defaultReadPosteriors,
  updatePosterior as defaultUpdatePosterior,
} from './learn/posteriors.mjs';
import { inspectPatch as defaultInspectPatch } from './patch-scope.mjs';
import { listProviders } from './providers/index.mjs';
import {
  sweepPatches as defaultSweepPatches,
  sweepRuns as defaultSweepRuns,
  sweepScratch as defaultSweepScratch,
  trackChild as defaultTrackChild,
  trackWorktree as defaultTrackWorktree,
  treeKill as defaultTreeKill,
} from './reaper.mjs';
import { resolveStateRoot } from './state-root.mjs';
import { canonical } from './real-path.mjs';
import {
  USER_PRIVILEGE_NOTE,
  deriveTestCommand as defaultDeriveTestCommand,
  deriveFrozenTestPlan as defaultDeriveFrozenTestPlan,
  runFrozenTests as defaultRunFrozenTests,
  runTests as defaultRunTests,
} from './test-runner.mjs';
import {
  collectPatchAtRevision as defaultCollectPatchAtRevision,
  collectPatch as defaultCollectPatch,
  createRevisionWorktree as defaultCreateRevisionWorktree,
  createWorktree as defaultCreateWorktree,
  listRevisionDelta as defaultListRevisionDelta,
  listIgnoredPaths as defaultListIgnoredPaths,
  makeWorktreeId,
  removeWorktree as defaultRemoveWorktree,
  revisionIdentity as defaultRevisionIdentity,
  snapshotStep as defaultSnapshotStep,
  statusSnapshot as defaultStatusSnapshot,
} from './worktree.mjs';
import {
  classifyProofRequirement,
  createSerialTestQueue,
  runCandidateEvidence,
  splitTestOnlyDelta,
} from './regression-proof.mjs';
import {
  checkpointManifest,
  createRunArtifacts,
  getRunArtifactStoreAuthority,
  inspectRunArtifactCollision,
  isRunArtifactStore,
  writeAttemptArtifact,
  writeCandidatePatch,
  writeEvidenceArtifact,
  writeWinnerAlias,
} from './run-artifacts.mjs';

function validateQualityRequest(options) {
  const candidateCount = options.candidateCount === undefined ? 1 : options.candidateCount;
  if (candidateCount !== 1 && candidateCount !== 2) {
    return failure({
      status: 'invalid',
      error: `candidateCount 는 1 또는 2여야 합니다: ${show(candidateCount)}`,
      recovery: 'candidateCount 를 1 또는 2로 지정하세요.',
    });
  }
  if (candidateCount === 2 && options.allowSingle === true) {
    return failure({
      status: 'invalid',
      error: 'candidates: 2 와 allow_single: true 는 함께 쓸 수 없습니다.',
      recovery: '독립 후보 둘을 쓰려면 allow_single 을 false 로 두세요.',
    });
  }
  if (candidateCount === 2 && (options.worker !== undefined || options.verifier !== undefined)) {
    return failure({
      status: 'invalid',
      error: 'candidates: 2 는 고정 mirrored worker/verifier 배치를 사용하므로 전역 역할 override를 받을 수 없습니다.',
      recovery: 'worker/verifier 지정을 제거하거나 candidates: 1을 사용하세요.',
    });
  }
  if (typeof options.task !== 'string' || options.task.trim() === '') {
    return failure({ status: 'invalid', error: 'task 가 비어 있습니다.', recovery: '무엇을 해야 하는지 한 문장 이상으로 적어 주세요.' });
  }
  if (typeof options.projectPath !== 'string' || options.projectPath === '' || !isAbsolute(options.projectPath)) {
    return failure({ status: 'invalid', error: `projectPath 가 절대 경로가 아닙니다: ${show(options.projectPath)}`, recovery: '대상 git 저장소의 절대 경로를 주세요.' });
  }
  const isolation = options.isolation ?? 'worktree';
  if (isolation !== 'worktree') {
    return failure({ status: 'invalid', error: `isolation 값을 지원하지 않습니다: ${show(isolation)}`, recovery: "isolation 은 'worktree' 뿐입니다." });
  }
  const budget = options.budget ?? 1;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) {
    return failure({ status: 'invalid', error: `budget 은 1 이상 ${MAX_BUDGET} 이하의 정수여야 합니다: ${show(budget)}`, recovery: `스텝 수를 1~${MAX_BUDGET} 사이의 정수로 주세요.` });
  }
  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    return failure({ status: 'invalid', error: `waitMs 는 0 이상의 유한한 수여야 합니다: ${show(waitMs)}`, recovery: '밀리초 단위 상한을 주세요.' });
  }
  return null;
}

/**
 * 기본 오케스트레이션 경로는 입력 검증과 전체 프로바이더 preflight 뒤 하나의 불변 역할
 * 바인딩을 만들고, `runCandidateLane` 에 시도·재시도·권위 판정을 맡긴다. 워커는 일회용
 * 워크트리에서만 수정하고 오케스트레이터가 테스트를 실행한다. 베리파이어 호출 전후에는
 * tracked 상태와 ignored 경로를 비교하며, 베리파이어용 스냅샷은 만들지 않는다.
 *
 * 이 함수 계층은 하위 `{ blocked: true }` 결과와 예외를 항상 MCP 봉투로 번역한다.
 */

/** 워커가 받을 도구 집합. Bash 가 없다 — 테스트는 우리가 돌린다(§12.-1). */
export const WORKER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);

/** 베리파이어가 받을 도구 집합. 읽기만 한다. */
export const VERIFIER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);

/** 플래너는 도구 없이 텍스트만 낸다 — 프로바이더의 읽기 전용 역할이 `--tools ''` 를 준다. */
const PLANNER_ROLE = 'planner';

/** 스텝 수 상한. 한 번의 도구 호출이 무한정 델리게이트를 부르지 않게 한다. */
export const MAX_BUDGET = 10;

/**
 * ★★ 엔진 자체의 절대 상한. **`waitMs` 와 무관하다.**
 *
 * 브리프는 "데드라인이 정지의 유일한 권위" 라고 요구하는데, `waitMs: 0`(기본값)은
 * `timeoutSignal` 이 `undefined` 를 돌려주므로 **권위가 아예 없는 상태**였다. 그 둘은
 * 양립하지 않는다. 그래서 `waitMs` 를 "호출자가 정한 상한", 이 값을 "그것과 무관한 상한"
 * 으로 나눈다 — 호출자가 0 을 주면 이 값이 데드라인이 되고, 더 큰 값을 주면 이 값으로 깎인다.
 *
 * 1시간인 이유: 예산이 아니라 못이다. 정상적인 오케스트레이션(최대 10스텝 × 플래너·워커·
 * 테스트·베리파이어)이 여기 닿는 것은 이상 상태이고, 그때는 부분 결과라도 내보내는 편이
 * MCP 요청이 영영 매달리는 것보다 낫다.
 */
export const MAX_WAIT_MS = 3_600_000;

/** 데드라인 뒤 주입 이음매가 signal 을 무시할 때 기다리는 단계별 유예. */
const HARD_STOP_GRACE_MS = 10_000;
const HARD_STOP = Symbol('bom-orch:hard-stop');

/** `src/worktree.mjs` 의 `RUN_ID_PATTERN` 과 같은 값. 갈리면 워크트리 생성이 거부된다. */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';

/** 봉투에 실을 각 텍스트의 상한(문자). 자세한 것은 `renderContent` 를 보라. */
const EXCERPT_CHARS = 1_200;
const TEST_OUTPUT_CHARS = 800;
/** 마지막 요약 단계에서 문자열 하나가 차지할 수 있는 상한. */
const SUMMARY_FIELD_CHARS = 400;
/** 학습 요약 한 단계에 싣는 축 수 상한. 더 큰/적대적 입력은 비상 요약으로 내려간다. */
const AXIS_SUMMARY_LIMIT = 8;

/**
 * notice 의 상한 — 개별과 합계 둘 다.
 *
 * ★ 왜 필요한가(실측): `content` 는 `envelope.mjs` 가 10,000자로 깎는데 `notice` 를 깎는
 *   코드는 저장소 어디에도 없었다. 진짜 저장소로 재니 `content` 800자 : `notice` 51,133자
 *   = 64배가 나왔고 봉투 하나가 52KB 로 나갔다 — `.gitignore` 에 `*.log` 하나가 있고 워커가
 *   로그 2,000개를 남기면 그 목록이 그대로 문장에 박힌다. 길이를 정하는 쪽이 우리가 아니라
 *   델리게이트다. 호스트가 결과를 자르면 꼬리의 `patch` 경로·`recovery` 가 먼저 사라진다.
 */
const NOTICE_CHARS = 400;
const NOTICES_TOTAL_CHARS = 1_600;

/** 어떤 값에서도(toString 이 던지는 값 포함) 사람이 읽을 문자열을 뽑는다. */
function safeText(value) {
  if (typeof value === 'string') return value !== '' ? value : '알 수 없는 오류';
  try {
    const text = String(value?.message ?? value);
    return text !== '' ? text : '알 수 없는 오류';
  } catch {
    return '알 수 없는 오류';
  }
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}…(${text.length}자 중 앞 ${limit}자)` : text;
}

/** 쌓인 notice 를 봉투에 실을 한 덩어리로 합친다. 합계 상한을 넘기면 뒤를 접는다. */
function joinNotices(list) {
  if (list.length === 0) return undefined;
  const kept = [];
  let used = 0;
  for (const text of list) {
    if (kept.length > 0 && used + text.length + 1 > NOTICES_TOTAL_CHARS) break;
    kept.push(text);
    used += text.length + 1;
  }
  const dropped = list.length - kept.length;
  return dropped > 0 ? `${kept.join(' ')} (그 밖에 알림 ${dropped}건이 더 있어 접었습니다.)` : kept.join(' ');
}

/**
 * 인자 검증의 오류 메시지에 값을 적는다. **절대 던지지 않는다.**
 *
 * ★ `JSON.stringify` 를 그대로 쓰면 BigInt 에서 던지고 `toJSON` 이 던지는 객체에서도
 *   던진다(실측: `waitMs=5n` 이 `invalid` 가 아니라 `failed` 로 나갔다). 두 status 는
 *   호출자의 다음 행동이 정반대다 — `invalid` 는 "네 인자를 고쳐라", `failed` 는
 *   "우리 버그다". 거부는 옳게 하면서 **거부 메시지를 만들다가** 뒤집히면 안 된다.
 *   `undefined` 를 넘겼을 때 `JSON.stringify` 가 `undefined` 를 돌려주는 것도 여기서 흡수한다.
 */
function show(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text === 'string') return text;
  } catch {
    // 아래로 떨어진다.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '(표현할 수 없는 값)';
  }
}

/** 하위 모듈의 `{blocked:true}` 인가. `ok:true` 결과와 겹치지 않는다. */
const isBlocked = (result) => ownDataValue(result, 'blocked').value === true;
const STORE_AUTHORITY_LOST_ERRORS = new Set([
  'artifact_store_poisoned',
  'manifest_authority_mismatch',
  'manifest_checkpoint_failed',
]);

function artifactAuthorityLost(result) {
  const hardStopped = ownDataValue(result, 'hardStopped');
  const rawError = ownDataValue(result, 'error');
  const error = rawError.ok === true && typeof rawError.value === 'string' ? rawError.value : '';
  return hardStopped.ok === true && hardStopped.value === true ||
    STORE_AUTHORITY_LOST_ERRORS.has(error) || error.endsWith('_authority_lost');
}

function validArtifactWriterSuccess(result, { kind, candidateId, path, bytes, sha256 }) {
  try {
    const allowedResultKeys = ['ok', 'ref', 'revision', 'manifestRef', 'duplicate'];
    const resultKeys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    if (resultKeys.length !== allowedResultKeys.length ||
        resultKeys.some((key) => typeof key !== 'string' || !allowedResultKeys.includes(key))) return false;
    const outer = snapshotOwnDataObject(result, resultKeys);
    const refKeys = ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt'];
    const ref = outer === null ? null : snapshotOwnDataObject(outer.ref, refKeys);
    const actualKeys = ref === null ? [] : Reflect.ownKeys(outer.ref);
    return outer?.ok === true && ref !== null &&
      Number.isSafeInteger(outer.revision) && outer.revision >= 0 &&
      typeof outer.duplicate === 'boolean' && outer.manifestRef !== null && typeof outer.manifestRef === 'object' &&
      actualKeys.length === refKeys.length && actualKeys.every((key) => typeof key === 'string' && refKeys.includes(key)) &&
      ref.kind === kind && ref.candidateId === candidateId && ref.path === path && isAbsolute(ref.path) &&
      ref.sha256 === sha256 && ref.bytes === bytes && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 &&
      Number.isSafeInteger(ref.expiresAt) && ref.expiresAt > 0;
  } catch {
    return false;
  }
}

function validManifestRef(ref, { path, revision, expiresAt }) {
  try {
    const keys = Reflect.ownKeys(ref);
    const expectedKeys = ['kind', 'path', 'revision', 'expiresAt'];
    const outer = snapshotOwnDataObject(ref, keys);
    return outer !== null && keys.length === expectedKeys.length &&
      keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      outer.kind === 'manifest' && outer.path === path && isAbsolute(outer.path) &&
      outer.revision === revision && Number.isSafeInteger(outer.revision) && outer.revision >= 0 &&
      (expiresAt === null || outer.expiresAt === expiresAt) &&
      Number.isSafeInteger(outer.expiresAt) && outer.expiresAt > 0;
  } catch {
    return false;
  }
}

function validArtifactBlocked(result) {
  try {
    const keys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    const expectedKeys = ['blocked', 'error', 'recovery'];
    return keys.length === expectedKeys.length &&
      keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      result.blocked === true && typeof result.error === 'string' && result.error !== '' &&
      typeof result.recovery === 'string' && result.recovery !== '';
  } catch {
    return false;
  }
}

function validArtifactHardStop(result) {
  try {
    const keys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    const expectedKeys = ['blocked', 'hardStopped', 'error', 'recovery'];
    return (keys.length === 3 || keys.length === expectedKeys.length) &&
      keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      result.blocked === true && result.hardStopped === true && typeof result.error === 'string' && result.error !== '' &&
      (!Object.hasOwn(result, 'recovery') || typeof result.recovery === 'string' && result.recovery !== '');
  } catch {
    return false;
  }
}

function validArtifactCheckpointSuccess(result, authority) {
  try {
    const keys = ARTIFACT_SETTLEMENT_SOURCE_KEYS.get(result) ?? Reflect.ownKeys(result);
    const expectedKeys = ['revision', 'manifestRef', 'duplicate'];
    return keys.length === expectedKeys.length && keys.every((key) => typeof key === 'string' && expectedKeys.includes(key)) &&
      Number.isSafeInteger(result.revision) && result.revision >= 0 && typeof result.duplicate === 'boolean' &&
      validManifestRef(result.manifestRef, { ...authority, revision: result.revision });
  } catch {
    return false;
  }
}

function validArtifactWriterSettlement(result, writerAuthority, manifestAuthority) {
  return validArtifactWriterSuccess(result, writerAuthority) &&
    manifestAuthority.expiresAt !== null && result.ref.expiresAt === manifestAuthority.expiresAt &&
    validManifestRef(result.manifestRef, {
      ...manifestAuthority,
      revision: result.revision,
    });
}

/**
 * 실행 ID 를 만든다 (배선 숙제 2).
 *
 * 세 가지 제약을 동시에 만족해야 한다:
 *
 *   · `src/worktree.mjs` 의 `RUN_ID_PATTERN` — 소문자·숫자로 시작하고 `.` 과 대문자를 쓰지
 *     않는다(Windows 가 그 둘을 같은 디렉터리로 접기 때문이다).
 *   · Windows 예약 장치명(`nul`/`con`/`aux`/`prn`/`com1..9`/`lpt1..9`)이 아니어야 한다.
 *     그 이름은 패턴을 통과하지만 `worktree add` 가 `Invalid argument` 로 죽는다(실측).
 *   · 같은 밀리초에 두 번 불려도 서로 달라야 한다 — 같으면 두 실행이 같은 디렉터리를 두고
 *     충돌한다.
 *
 * 셋 다 접두사 + 타임스탬프 + 카운터/난수로 자연히 해결된다. 접두사가 있으므로 결과가
 * 예약 장치명이 될 수 없고, 36진수 표기는 소문자만 낸다.
 */
let runIdSeq = 0;
export function makeRunId({ now = Date.now, random = Math.random } = {}) {
  runIdSeq = (runIdSeq + 1) % 1_296; // 36^2
  const stamp = Math.floor(now()).toString(36);
  const seq = runIdSeq.toString(36).padStart(2, '0');
  const salt = Math.floor(random() * 1_679_616).toString(36).padStart(4, '0');
  return `run-${stamp}-${seq}${salt}`;
}

/**
 * `placement` maps registry order to writer/verifier roles. A single-provider binding, or the
 * historical `mix=single` arm, intentionally assigns all roles to one provider; the coordinator
 * separately caps that result at unverified.
 */
/**
 * 이 분류값들은 자식이 **떴다는 것**을 모호함 없이 말한다(설계 §5.8 S1).
 *
 * ★ `aborted` 가 빠진 이유: 스폰 **전** 중단과 스폰 **후** 중단이 둘 다 `'aborted'` 다. 넣으면
 *   한 줄도 안 돌린 실행을 "사용자 권한으로 돌았다"고 신고하게 되고, 매번 뜨는 보안 경고는
 *   아무도 안 읽는다. 그 갈래는 `ranWithUserPrivilege` 가 정확히 가른다.
 */
const RAN_WITH_USER_PRIVILEGE_EXECUTIONS = new Set(['completed', 'timeout', 'hung', 'lingering']);

/**
 * 배치 팔의 정본은 `src/learn/bandit.mjs` 의 `AXES.placement` 하나다. 여기서 **파생**시킨다.
 *
 * ★ 왜 리터럴로 두면 안 되나: `assignRoles` 는 문자열 동등성으로 역전을 판단하므로 **모르는 값은
 *   전부 정방향으로 떨어진다**. 팔 이름을 바꾸면 밴딧은 새 이름을 뽑고, 엔진은 조용히 정방향으로
 *   돌고, 그 실행의 보상은 새 이름 셀로 들어간다 — 돌지도 않은 배치를 배웠다고 기록한다. 컴파일도
 *   테스트도 안 깨지므로 아무도 모른다. `tier` 축은 이미 `AXES.tier.arms` 를 읽는다.
 *
 * ★ `default` 가 정방향이라는 것은 우연이 아니다: `'claude>codex'` 는 등록 순서대로 첫째가
 *   쓰고 둘째가 검증한다는 뜻이고, 그것이 이 엔진의 정방향 정의다.
 */
export const FORWARD_PLACEMENT = AXES.placement.default;
export const REVERSED_PLACEMENT = AXES.placement.arms.find((arm) => arm !== FORWARD_PLACEMENT) ?? null;

export function assignRoles(providers, decisions) {
  const first = providers[0];
  const second = providers[1] ?? null;
  const reversed = decisions?.placement === REVERSED_PLACEMENT;

  if (second === null) return { planner: first, worker: first, verifier: first };

  // `single` 도 **어느 벤더로** 도는지는 placement 가 정한다. 첫째 벤더로 못 박으면 두 팔이
  // 같은 실행을 내므로 `single` 실행에서 placement 축이 무연산이 되고, 태스크 8 이 그 실행의
  // placement 셀에 보상을 준다 — 아무 일도 하지 않은 결정을 배웠다고 기록하는 것이다.
  if (decisions?.mix === 'single') {
    const only = reversed ? second : first;
    return { planner: only, worker: only, verifier: only };
  }

  const worker = reversed ? second : first;
  const verifier = reversed ? first : second;
  return { planner: worker, worker, verifier };
}

// ── 지시문 ────────────────────────────────────────────────────────────────

/**
 * @param evidence §7.5 의 근거 문단(`decide().evidence`). **지시문 앞에** 붙는다.
 *
 * ★ 앞에 두는 이유: 이 문단은 "이 저장소에서 실제로 관찰된 사실" 이고 계획을 세우기 전에
 *   읽혀야 한다. 뒤에 붙이면 긴 작업 설명 뒤로 밀린다.
 * ⚠ 문단은 **밴딧이 고른 축만** 말한다. 호출자가 축을 직접 지정하면(`options.decisions`)
 *   그 축은 문단에 안 나오거나, 밴딧이 골랐던 다른 팔이 적혀 있을 수 있다 — 문단은 결정의
 *   근거이지 이번 실행의 배치 기록이 아니다. 배치 기록은 `content.learning.decisions` 다.
 */
function plannerInstruction({ task, testPlan, evidence }) {
  const testLine =
    testPlan === null || testPlan?.source === null
      ? '이 프로젝트에서는 테스트 명령을 유도하지 못했습니다 — 검증은 사람이 합니다.'
      : `테스트는 오케스트레이터가 직접 돌립니다: ${testPlan.source}의 고정된 테스트 계획입니다.`;
  return [
    ...(typeof evidence === 'string' && evidence !== '' ? [clip(evidence, EXCERPT_CHARS), ''] : []),
    '다음 작업의 실행 계획을 세우세요. 당신은 파일을 읽거나 쓸 수 없습니다 — 텍스트 계획만 냅니다.',
    '',
    `작업: ${task}`,
    '',
    testLine,
    '계획을 실행할 워커는 셸을 쓸 수 없고 파일 읽기·쓰기·검색만 합니다. 테스트 명령을 바꾸라고',
    '지시하지 마세요 — 바뀌면 실행이 거부됩니다.',
    '',
    '무엇을 어떤 순서로 고칠지, 무엇을 근거로 다 됐다고 판단할지 짧게 적으세요.',
  ].join('\n');
}

function workerInstruction({ task, plan, step, budget, feedback }) {
  const lines = [
    `작업: ${task}`,
    '',
    '계획:',
    clip(plan, EXCERPT_CHARS),
    '',
    `이번은 ${step}/${budget} 번째 스텝입니다. 일회용 워크트리는 패치 격리 경계입니다.`,
    'OS 샌드박스가 아니므로 바깥 파일·네트워크 접근을 막는다고 가정하지 마세요. 셸은 없습니다.',
    '테스트는 이 실행이 끝난 뒤 오케스트레이터가 직접 돌립니다. 테스트 정의(package.json 의',
    'scripts.test, Makefile 의 test 타깃, pytest 설정 등)를 고치지 마세요 — 고치면 실행이 거부됩니다.',
  ];
  if (feedback !== null) {
    lines.push('', '앞 스텝의 결과:', clip(feedback, EXCERPT_CHARS));
  }
  return lines.join('\n');
}

/**
 * 이번 attempt 의 기계 실행 증거를 verifier 가 읽을 한 문단으로.
 *
 * ★★ 왜 verifier 에게 이것을 주는가(설계 §12.-1): 테스트는 델리게이트가 아니라 우리가 돌린다 —
 *   그래야 결과를 지어낼 수 없다. 그런데 판정 스키마는 verifier 에게 `evidenceIds` 를 되돌려
 *   적으라고 요구한다. 그 증거가 무엇을 말했는지 안 보여주면서 증명을 요구하는 셈이라
 *   앞뒤가 안 맞는다. 품질 게이트 리팩터가 이 자리를 빈 문자열로 흘려서, 프롬프트에
 *   "테스트 결과:" 라는 **빈 절**만 남아 있었다.
 *
 * ★ 원문은 넣지 않는다. 분류된 사실(실행·판정·안정성·신뢰·완결)과 증거 ID 뿐이다 — 전역
 *   제약이 금지하는 것은 저장·반환만이 아니라 원문을 다루는 습관 자체이고, verifier 는
 *   읽기 도구로 워크트리를 직접 볼 수 있으므로 원문이 없어도 판단할 수 있다.
 *
 * ★ 이 값은 판정을 **대신하지 않는다.** `decideAttempt` 가 machine 채널과 verifier 채널을
 *   따로 요구하므로, 여기서 "통과" 를 읽은 verifier 가 PASS 를 내도 기계 실패를 지우지 못하고
 *   그 반대도 마찬가지다(설계 §1 의 고정 기준).
 */
function describeMachineEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return '이 실행에 대한 기계 증거가 없습니다.';
  const ids = Array.isArray(evidence.evidenceIds) ? evidence.evidenceIds : [];
  if (evidence.execution === 'not_run') {
    return ['우리가 테스트를 실행하지 못했습니다.', `봉인된 증거: ${ids.join(', ') || '(없음)'}`].join('\n');
  }
  return [
    '아래는 델리게이트의 보고가 아니라 이 오케스트레이터가 직접 실행한 결과입니다.',
    `실행: ${evidence.execution}`,
    `판정: ${evidence.outcome}`,
    `안정성: ${evidence.stability}`,
    `신뢰 가능한 러너: ${evidence.trusted === true ? '예' : '아니오'}`,
    `완결: ${evidence.complete === true ? '예' : '아니오'}`,
    `봉인된 증거: ${ids.join(', ') || '(없음)'}`,
  ].join('\n');
}

function verifierInstruction({ task, plan, files, tests, expected, feedback, formatOnly = false }) {
  const binding = JSON.stringify(expected);
  const schema = expected.phase === 'recheck'
    ? '{"schemaVersion":1,"candidateId":"...","attemptId":"...","candidatePatchSha256":"64 lowercase hex","evidenceIds":["..."],"verdict":"PASS|FAIL","checks":[{"id":"...","status":"resolved|persists","evidence":"..."}],"newIssues":[],"notes":[]}'
    : '{"schemaVersion":1,"candidateId":"...","attemptId":"...","candidatePatchSha256":"64 lowercase hex","evidenceIds":["..."],"verdict":"PASS|FAIL","summary":"...","issues":[{"category":"correctness|security|requirements|scope|tests","claim":"...","evidence":"...","requiredFix":"..."}],"notes":[]}';
  return [
    formatOnly
      ? '앞선 답은 형식이 틀렸습니다. 내용을 재검토하지 말고 아래 JSON 형식으로만 결과를 다시 내세요.'
      : '아래 작업의 결과를 검토하세요. 당신은 읽기만 합니다 — 파일을 고치지 마세요.',
    '파일을 고치면 이 판정은 버려집니다.',
    `BINDING_JSON: ${binding}`,
    `정확히 이 JSON 스키마만 내세요: ${schema}`,
    '',
    `작업: ${task}`,
    '',
    '계획:',
    clip(plan, EXCERPT_CHARS),
    '',
    `이번 스텝이 건드린 파일: ${files.length === 0 ? '(없음)' : files.join(', ')}`,
    '',
    '테스트 결과:',
    clip(tests, EXCERPT_CHARS),
    ...(feedback?.openIds?.length > 0 ? ['', `다시 확인할 열린 이슈: ${feedback.openIds.join(', ')}`] : []),
    '',
    '작업이 실제로 끝났는지, 빠진 것이나 잘못된 것이 있는지 판정하세요.',
  ].join('\n');
}

function judgeInstruction(promptInput, { formatOnly = false } = {}) {
  return [
    formatOnly
      ? '앞선 답은 형식이 틀렸습니다. 후보를 다시 평가하지 말고 같은 판단을 정확한 JSON으로만 다시 내세요.'
      : '두 익명 후보를 읽기 전용으로 비교하세요. 익명 표식 밖의 신원이나 경로를 추측하지 마세요.',
    '정확히 이 JSON 스키마만 내세요:',
    '{"schemaVersion":1,"decision":"X|Y|TIE","rationale":"...","majorDefects":[{"category":"correctness|security|requirements|scope|tests","claim":"...","evidence":"..."}]}',
    `INPUT_JSON: ${JSON.stringify(promptInput)}`,
  ].join('\n');
}

// ── content 렌더링 ────────────────────────────────────────────────────────

/**
 * 봉투의 content 를 만든다.
 *
 * `envelope.mjs` 는 상한을 넘는 content 를 **꼬리부터** 자른다 — 잘린 JSON 은 파싱조차
 * 안 되므로 여기서 먼저 줄인다. 줄이는 순서는 "덜 중요한 것부터": 옛 스텝의 본문 →
 * 모든 본문 → 목록 → 스텝 목록 자체 → 크기가 고정된 요약.
 *
 * ★ **내보내는 이유는 테스트다.** 이 함수의 계약은 "**어떤** payload 에도 상한 안의 파싱
 *   가능한 JSON 을 낸다" 인데, 마지막 단계는 정의상 그 앞 단계들이 전부 실패했을 때만
 *   쓰인다. 엔진을 통째로 돌려서 그 상태를 만들려면 비현실적인 픽스처가 필요하고(실제로
 *   시도했다), 그러면 정작 그 단계를 재지 못한 채 초록이 된다 — 뮤테이션으로 확인했다.
 *   순수 함수이므로 적대적 payload 를 직접 먹여서 계약을 그대로 잰다.
 */
export function renderContent(payload) {
  return renderContentParts(payload).content;
}

const count = (value) => (Array.isArray(value) ? value.length : 0);

/** 문자열이면 자르고 아니면 `null`. 요약 단계가 `null` 과 `''` 를 섞지 않게 한다. */
const clipOrNull = (value) => (typeof value === 'string' ? clip(value, SUMMARY_FIELD_CHARS) : null);

/** 축별 팔 문자열 맵 하나를 자른다. 축 수는 `AXES` 가, 값 길이는 여기서 묶는다. */
function clipArms(map) {
  if (map === null || typeof map !== 'object') return {};
  return Object.fromEntries(
    Object.entries(map)
      .slice(0, AXIS_SUMMARY_LIMIT)
      .map(([axis, arm]) => [clip(axis, SUMMARY_FIELD_CHARS), clipOrNull(arm)]),
  );
}

/** `renderContent` 의 마지막(고정 크기) 단계가 쓰는 학습 요약. */
function summarizeLearning(learning) {
  const applied = learning.applied;
  return {
    taskClass: clipOrNull(learning.taskClass),
    decisions: clipArms(learning.decisions),
    sources: clipArms(learning.sources),
    applied:
      applied === null || typeof applied !== 'object'
        ? null
        : {
            grade: clipOrNull(applied.grade),
            axes: (Array.isArray(applied.axes) ? applied.axes : [])
              .slice(0, AXIS_SUMMARY_LIMIT)
              .map((axis) => clip(axis, SUMMARY_FIELD_CHARS)),
          },
  };
}

/** 배열 하나를 N개로 자르고 몇 개를 뺐는지 남긴다. 목록이 없으면 그대로 둔다. */
function cut(list, keep) {
  if (!Array.isArray(list) || list.length <= keep) return { list, omitted: 0 };
  return { list: list.slice(0, keep), omitted: list.length - keep };
}

/** payload 의 지배 항목(경로 목록·스코프 사유)을 줄인다. */
function trim(payload, keepFiles, keepReasons) {
  const files = cut(payload.patch.files, keepFiles);
  const ignored = cut(payload.patch.ignoredPaths, keepFiles);
  // gitlinks 와 워크트리 쪽 목록도 길이를 델리게이트가 정한다 — 안 줄이면 그 둘이 큰
  // 실행에서 어느 단계도 상한 안에 못 들어온다.
  const gitlinks = cut(payload.patch.gitlinks, keepReasons);
  const wtIgnored = cut(payload.worktree?.ignoredPaths, keepReasons);
  const reasons = cut(payload.scope.reasons, keepReasons);
  const blockers = cut(payload.blockers, keepReasons);
  return {
    ...payload,
    patch: {
      ...payload.patch,
      files: files.list,
      filesOmitted: files.omitted,
      ignoredPaths: ignored.list,
      ignoredPathsOmitted: ignored.omitted,
      gitlinks: gitlinks.list,
      gitlinksOmitted: gitlinks.omitted,
    },
    worktree: { ...payload.worktree, ignoredPaths: wtIgnored.list, ignoredPathsOmitted: wtIgnored.omitted },
    scope: { ...payload.scope, reasons: reasons.list, reasonsOmitted: reasons.omitted },
    blockers: blockers.list,
    steps: (payload.steps ?? []).map((step) => {
      const stepFiles = cut(step.worker?.files, keepFiles);
      const stepReasons = cut(step.scope?.reasons, keepReasons);
      return {
        ...step,
        ...(step.worker ? { worker: { ...step.worker, files: stepFiles.list, filesOmitted: stepFiles.omitted } } : {}),
        ...(step.scope ? { scope: { ...step.scope, reasons: stepReasons.list } } : {}),
      };
    }),
  };
}

function stripStepText(step) {
  const out = { ...step };
  if (out.worker) out.worker = { ...out.worker, content: '' };
  if (out.verifier) out.verifier = { ...out.verifier, content: '' };
  if (out.tests) out.tests = { ...out.tests, output: '' };
  return out;
}

// ── 본체 ──────────────────────────────────────────────────────────────────

/**
 * 오케스트레이션을 한 번 돈다. **절대 throw 하지 않는다.**
 *
 * ★ 티어의 입구는 `decisions.tier` 뿐이다. 계획 2 의 최상위 `options.tier` 는 계획 3 태스크 6
 *   이 지웠다 — 같은 어휘를 말하는 입구가 둘이면 태스크 8 이 저널에 적는 팔과 실제로 쓴
 *   티어가 조용히 갈린다. 이 줄에 `tier?: string` 을 남겨 두면 문서대로 부른 호출자가 아무
 *   말도 못 듣고 강한 티어로 돈다 — 실측이다. 최상위 입구를 되살리는 뮤턴트에서
 *   「티어의 입구는 decisions.tier 하나뿐이다」 하나가 붉어진다.
 *
 * @param {{ task: string, projectPath: string, isolation?: string, budget?: number, candidateCount?: 1|2,
 *           waitMs?: number, decisions?: { mix?: string, placement?: string, tier?: string },
 *           planner?: string, worker?: string, verifier?: string,
 *           onProgress?: Function, deps?: object }} spec
 * @returns MCP 봉투(`src/envelope.mjs`). content 는 JSON 문자열이다.
 */
export async function runOrchestration(spec) {
  // ★ 구조분해로 받지 않는다. `runOrchestration(null)` 이 구조분해 자리에서 TypeError 를
  //   던지면 봉투가 아니라 거부된 프로미스가 나간다(worktree.mjs 가 같은 이유로 버렸다).
  let options = null;
  let specKind = typeof spec;
  try {
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) options = spec;
    else if (Array.isArray(spec)) specKind = 'array';
  } catch {
    specKind = 'invalid object';
  }
  if (options === null) {
    return failure({
      status: 'invalid',
      error: `인자는 JSON 객체여야 합니다 — ${spec === null ? 'null' : specKind} 를 받았습니다.`,
      recovery: '{ task, projectPath } 를 담은 객체로 다시 부르세요.',
    });
  }

  try {
    const snapshot = snapshotOwnDataObject(options, [
      'task', 'projectPath', 'isolation', 'budget', 'candidateCount', 'allowSingle', 'waitMs',
      'decisions', 'planner', 'worker', 'verifier', 'onProgress', 'deps',
    ]);
    if (snapshot === null) {
      return failure({
        status: 'invalid',
        error: '입력 객체는 getter 없이 own data property만 사용해야 합니다.',
        recovery: 'JSON 객체로 다시 요청하세요.',
      });
    }
    const inputFailure = validateQualityRequest(snapshot);
    if (inputFailure !== null) return inputFailure;
    if (snapshot.decisions !== undefined) {
      const decisions = snapshot.decisions !== null && typeof snapshot.decisions === 'object' && !Array.isArray(snapshot.decisions)
        ? snapshotOwnDataObject(snapshot.decisions, ['mix', 'placement', 'tier'])
        : null;
      if (decisions === null) {
        return failure({ status: 'invalid', error: 'decisions는 getter 없이 own data property만 사용해야 합니다.', recovery: 'plain object decisions를 사용하세요.' });
      }
      snapshot.decisions = Object.freeze(decisions);
    }
    const deps = snapshot.deps !== null && typeof snapshot.deps === 'object' && !Array.isArray(snapshot.deps)
      ? snapshotOwnDataObject(snapshot.deps)
      : {};
    if (deps === null) {
      return failure({ status: 'invalid', error: 'deps는 getter 없이 own data property만 사용해야 합니다.', recovery: 'plain object deps를 사용하세요.' });
    }
    if (Array.isArray(deps.providers)) {
      const providers = snapshotOwnDataArray(deps.providers);
      if (providers === null) {
        return failure({ status: 'invalid', error: 'providers는 accessor 없는 dense array여야 합니다.', recovery: 'plain provider array를 사용하세요.' });
      }
      deps.providers = providers.map(snapshotProviderEntry);
    }
    snapshot.deps = Object.freeze(deps);
    return await orchestrateQuality(Object.freeze(snapshot));
  } catch (error) {
    return failure({
      status: 'failed',
      error: `오케스트레이션이 예기치 못한 오류로 멈췄습니다: ${safeText(error)}`,
      recovery: '서버 로그를 확인한 뒤 다시 시도하세요. 워크트리가 남아 있으면 상태 루트의 worktrees/ 를 확인하세요.',
    });
  }
}

function snapshotOwnDataObject(value, keys = null) {
  try {
    const names = keys ?? Reflect.ownKeys(value);
    const snapshot = {};
    for (const key of names) {
      if (typeof key !== 'string') continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotExactEnumerableDataObject(value, keys) {
  try {
    const snapshot = {};
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

const ARTIFACT_REF_KEYS = Object.freeze(['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']);
const MANIFEST_REF_KEYS = Object.freeze(['kind', 'path', 'revision', 'expiresAt']);
const ARTIFACT_SETTLEMENT_KEYS = Object.freeze([
  'ok', 'blocked', 'hardStopped', 'error', 'recovery', 'ref', 'manifestRef', 'revision', 'duplicate',
]);
const ARTIFACT_SETTLEMENT_SOURCE_KEYS = new WeakMap();

function blockedArtifactSettlement(error) {
  return Object.freeze({ blocked: true, error });
}

function unknownArtifactSettlement() {
  return blockedArtifactSettlement('artifact_store_authority_lost');
}

function snapshotArtifactSettlement(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const sourceKeys = Reflect.ownKeys(value);
    if (sourceKeys.some((key) => typeof key !== 'string' || !ARTIFACT_SETTLEMENT_KEYS.includes(key))) return null;
    const raw = snapshotExactEnumerableDataObject(value, sourceKeys);
    if (raw === null) return null;
    const snapshot = {};
    for (const key of sourceKeys) {
      if (Object.hasOwn(raw, key)) snapshot[key] = raw[key];
    }
    if (Object.hasOwn(snapshot, 'ref')) {
      const refKeys = Reflect.ownKeys(snapshot.ref);
      if (refKeys.some((key) => typeof key !== 'string' || !ARTIFACT_REF_KEYS.includes(key))) return null;
      const ref = snapshotExactEnumerableDataObject(snapshot.ref, refKeys);
      if (ref === null) return null;
      snapshot.ref = Object.freeze(ref);
    }
    if (Object.hasOwn(snapshot, 'manifestRef')) {
      const manifestKeys = Reflect.ownKeys(snapshot.manifestRef);
      if (manifestKeys.some((key) => typeof key !== 'string' || !MANIFEST_REF_KEYS.includes(key))) return null;
      const manifestRef = snapshotExactEnumerableDataObject(snapshot.manifestRef, manifestKeys);
      if (manifestRef === null) return null;
      snapshot.manifestRef = Object.freeze(manifestRef);
    }
    const normalized = Object.freeze(snapshot);
    ARTIFACT_SETTLEMENT_SOURCE_KEYS.set(normalized, Object.freeze([...sourceKeys]));
    return normalized;
  } catch {
    return null;
  }
}

function snapshotStoreArtifactAuthority(value, expectedPath) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const outerKeys = Reflect.ownKeys(value);
    if (outerKeys.length !== 1 || outerKeys[0] !== 'manifestRef') return null;
    const outer = snapshotExactEnumerableDataObject(value, outerKeys);
    if (outer === null || outer.manifestRef === null || typeof outer.manifestRef !== 'object' ||
        Array.isArray(outer.manifestRef)) return null;
    const refKeys = Reflect.ownKeys(outer.manifestRef);
    if (refKeys.length !== MANIFEST_REF_KEYS.length ||
        refKeys.some((key) => typeof key !== 'string' || !MANIFEST_REF_KEYS.includes(key))) return null;
    const ref = snapshotExactEnumerableDataObject(outer.manifestRef, refKeys);
    if (ref === null || !validManifestRef(ref, {
      path: expectedPath,
      revision: 0,
      expiresAt: ref.expiresAt,
    })) return null;
    return Object.freeze({ path: ref.path, expiresAt: ref.expiresAt });
  } catch {
    return null;
  }
}

function classifyArtifactSettlement(value, { kind, authority = null } = {}) {
  const result = snapshotArtifactSettlement(value);
  if (result === null) return { kind: 'unknown', result: unknownArtifactSettlement() };
  if (validArtifactHardStop(result)) return { kind: 'hard_stop', result };
  if (validArtifactBlocked(result)) return { kind: 'blocked', result };
  if (kind === 'checkpoint' && validArtifactCheckpointSuccess(result, authority)) {
    return { kind: 'success', result };
  }
  if (kind === 'writer' && validArtifactWriterSettlement(result, authority.writer, authority.manifest)) {
    return { kind: 'success', result };
  }
  return { kind: 'unknown', result: unknownArtifactSettlement() };
}

function acceptArtifactRevision(result, revisionAuthority) {
  const revision = result?.revision;
  const duplicate = result?.duplicate;
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof duplicate !== 'boolean') return false;
  if (duplicate ? revision < revisionAuthority.latest : revision <= revisionAuthority.latest) return false;
  revisionAuthority.latest = Math.max(revisionAuthority.latest, revision);
  return true;
}

const UNPROVEN_REMOVAL = Object.freeze({
  ok: false,
  removed: false,
  unregistered: false,
  proven: false,
});

function snapshotRemovalResult(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return UNPROVEN_REMOVAL;
    const keys = Reflect.ownKeys(value);
    const expectedKeys = ['ok', 'removed', 'unregistered'];
    if (keys.length !== expectedKeys.length ||
        keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return UNPROVEN_REMOVAL;
    const raw = snapshotExactEnumerableDataObject(value, keys);
    if (raw === null || !Object.hasOwn(raw, 'ok') || !Object.hasOwn(raw, 'removed') ||
        !Object.hasOwn(raw, 'unregistered') || typeof raw.ok !== 'boolean' ||
        typeof raw.removed !== 'boolean' ||
        !(typeof raw.unregistered === 'boolean' || raw.unregistered === null)) {
      return UNPROVEN_REMOVAL;
    }
    return Object.freeze({
      ok: raw.ok,
      removed: raw.removed,
      unregistered: raw.unregistered,
      proven: true,
    });
  } catch {
    return UNPROVEN_REMOVAL;
  }
}

function snapshotOwnDataArray(value) {
  try {
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
    if (!Object.hasOwn(lengthDescriptor ?? {}, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const snapshot = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotProviderEntry(provider) {
  const snapshot = provider !== null && typeof provider === 'object' && !Array.isArray(provider)
    ? snapshotOwnDataObject(provider, ['id', 'preflight', 'run', 'describeError', 'securityFloor'])
    : null;
  if (snapshot === null || typeof snapshot.id !== 'string' || snapshot.id === '') {
    return Object.freeze({
      id: '',
      preflight: async () => ({ available: false, error: 'invalid provider entry' }),
      run: async () => ({ error: 'invalid provider entry' }),
      describeError: (error) => ({ error: safeText(error), recovery: GENERIC_RECOVERY }),
    });
  }
  const bind = (name, fallback) => typeof snapshot[name] === 'function'
    ? snapshot[name].bind(provider)
    : fallback;
  return Object.freeze({
    id: snapshot.id,
    preflight: bind('preflight', async () => ({ available: false, error: 'invalid provider preflight' })),
    run: bind('run', async () => ({ error: 'invalid provider run' })),
    describeError: bind('describeError', (error) => ({ error: safeText(error), recovery: GENERIC_RECOVERY })),
    // ★ 선택적이다(설계 §5.8 S2(a)). 권고가 없는 프로바이더는 구현하지 않고, 없으면 엔진이
    //   그 축의 검사를 건너뛴다. 있지도 않은 권고를 흉내 내는 기본 구현을 넣으면 그 자체가
    //   거짓 신호다 — 여기서 대체값을 만들지 않는 이유다.
    ...(typeof snapshot.securityFloor === 'function' ? { securityFloor: bind('securityFloor', undefined) } : {}),
  });
}

function qualityTestPlanFingerprint(testPlan) {
  return createHash('sha256').update(JSON.stringify(testPlan ?? null), 'utf8').digest('hex');
}

function qualityHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function qualityClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function qualityFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) qualityFreeze(child);
  return value;
}

function qualitySame(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function qualityProviderFailure(result) {
  return result === null || typeof result !== 'object' || (typeof result.error === 'string' && result.error !== '');
}

function qualityWriterSettlement(result) {
  if (result?.hardStopped === true) return 'effect_unknown';
  if (result?.truncated === true || result?.doneReason === 'timeout' || result?.doneReason === 'aborted') return 'effect_unknown';
  if (qualityProviderFailure(result)) return 'effect_unknown';
  return 'sealed';
}

function combineContentUsage(...values) {
  const totals = { calls: 0, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: false };
  const exact = { calls: 0n, promptTokensKnown: 0n, evalTokensKnown: 0n };
  for (const value of values) {
    for (const key of ['calls', 'promptTokensKnown', 'evalTokensKnown']) {
      const amount = value?.[key];
      if (Number.isSafeInteger(amount) && amount >= 0) exact[key] += BigInt(amount);
      else totals.incomplete = true;
    }
    if (value?.incomplete === true) totals.incomplete = true;
  }
  for (const key of ['calls', 'promptTokensKnown', 'evalTokensKnown']) {
    if (exact[key] <= BigInt(Number.MAX_SAFE_INTEGER)) totals[key] = Number(exact[key]);
    else totals.incomplete = true;
  }
  return totals;
}

function createRunUsageAccumulator() {
  let nextId = 1;
  let finalized = null;
  const tickets = new Map();
  return Object.freeze({
    start(input) {
      if (finalized !== null) throw new Error('usage_finalized');
      const ticket = Object.freeze({ id: `call-${nextId++}`, ...input });
      tickets.set(ticket.id, { ticket, settled: false, value: null });
      return ticket;
    },
    settle(ticket, value) {
      const cell = tickets.get(ticket?.id);
      if (finalized !== null || cell === undefined || cell.ticket !== ticket || cell.settled) return;
      cell.settled = true;
      cell.value = value;
    },
    finalize() {
      if (finalized !== null) return finalized;
      const totals = {
        calls: tickets.size,
        promptTokensKnown: 0,
        evalTokensKnown: 0,
        incomplete: false,
      };
      const exact = { promptTokensKnown: 0n, evalTokensKnown: 0n };
      for (const cell of tickets.values()) {
        if (!cell.settled) {
          totals.incomplete = true;
          continue;
        }
        for (const [source, target] of [['promptTokens', 'promptTokensKnown'], ['evalTokens', 'evalTokensKnown']]) {
          const amount = cell.value?.[source];
          if (Number.isSafeInteger(amount) && amount >= 0) exact[target] += BigInt(amount);
          else totals.incomplete = true;
        }
      }
      for (const target of ['promptTokensKnown', 'evalTokensKnown']) {
        if (exact[target] <= BigInt(Number.MAX_SAFE_INTEGER)) totals[target] = Number(exact[target]);
        else totals.incomplete = true;
      }
      finalized = qualityFreeze({ ...totals });
      return finalized;
    },
  });
}

function exactRoleBinding(provider, settings, tier, role) {
  const selected = resolveTier(settings, provider.id, tier);
  return qualityFreeze({
    providerId: provider.id,
    model: selected.model ?? null,
    effort: selected.effort ?? null,
    tier,
    role,
  });
}

function candidateRefFromSummary(candidate) {
  const attempt = candidate.patch === null ? null : candidate.attempts.find((entry) => entry.attemptId === candidate.patch.sourceAttemptId);
  return {
    candidateId: candidate.candidateId,
    sourceAttemptId: candidate.patch?.sourceAttemptId ?? attempt?.attemptId ?? null,
    terminalClass: candidate.terminalClass,
    treeHash: attempt?.sealed?.treeHash ?? null,
    patchRef: candidate.patch?.ref ?? null,
    proofStatus: candidate.regressionProof.status,
    tests: {
      execution: candidate.tests.execution,
      outcome: candidate.tests.outcome,
      stability: candidate.tests.stability,
      complete: candidate.tests.complete,
    },
    scope: {
      flagged: candidate.scope.flagged === true,
      reasonCount: candidate.scope.reasonCount ?? 0,
      omittedReasonCount: candidate.scope.omittedReasonCount ?? 0,
    },
  };
}

function resolvedOmittedCount(candidate) {
  const seen = new Set();
  for (const attempt of candidate.attempts ?? []) {
    for (const issueId of attempt.verdictRef?.issueIds ?? []) {
      if (typeof issueId === 'string') seen.add(issueId);
    }
  }
  for (const issueId of candidate.issues?.openIds ?? []) seen.delete(issueId);
  return seen.size;
}

function contentIssue(candidate) {
  return {
    candidateId: candidate.candidateId,
    openIssueIds: [...candidate.issues.openIds],
    openIssueCount: candidate.issues.count,
    resolvedOmittedCount: resolvedOmittedCount(candidate),
  };
}

function contentCandidate(candidate) {
  return {
    candidateId: candidate.candidateId,
    binding: candidate.binding,
    terminalClass: candidate.terminalClass,
    patch: candidate.patch === null ? null : {
      path: candidate.patch.ref.path,
      sha256: candidate.patch.ref.sha256,
      bytes: candidate.patch.ref.bytes,
      empty: candidate.patch.empty,
      files: [...candidate.patch.files],
    },
    proofStatus: candidate.regressionProof.status,
    openIssueIds: [...candidate.issues.openIds],
    openIssueCount: candidate.issues.count,
    scope: {
      flagged: candidate.scope.flagged,
      reasonCount: candidate.scope.reasonCount,
      omittedReasonCount: candidate.scope.omittedReasonCount,
    },
    stopReason: candidate.stopReason,
    usage: candidate.usage,
  };
}

function contentVerdict(candidate) {
  if (candidate?.verdict === null || candidate?.verdict === undefined) return null;
  return {
    candidateId: candidate.candidateId,
    attemptId: candidate.patch?.sourceAttemptId ?? candidate.attempts.at(-1)?.attemptId ?? '',
    verdict: candidate.verdict.verdict,
    summary: null,
  };
}

function contentEvidenceRef(record, path, { attemptId, expectedPath }) {
  const evidenceId = ownDataValue(record, 'evidenceId');
  const recordAttemptId = ownDataValue(record, 'attemptId');
  const kind = ownDataValue(record, 'kind');
  const repetition = ownDataValue(record, 'repetition');
  const classified = ownDataValue(record, 'classified');
  const outcome = ownDataValue(classified.value, 'outcome');
  const witnesses = ownDataValue(classified.value, 'witnessIds');
  const witnessIds = witnesses.ok === true ? snapshotOwnDataArray(witnesses.value) : null;
  const suffix = kind.value === 'b0' ? 'B0' : kind.value === 'br' ? 'BR' : kind.value === 'c' ? 'C' : null;
  if (path !== expectedPath || !isAbsolute(path) || evidenceId.ok !== true || recordAttemptId.ok !== true ||
      kind.ok !== true || repetition.ok !== true || classified.ok !== true || outcome.ok !== true ||
      recordAttemptId.value !== attemptId || suffix === null || ![1, 2].includes(repetition.value) ||
      evidenceId.value !== `${attemptId}/${suffix}/${repetition.value}` ||
      !['pass', 'fail', 'unknown'].includes(outcome.value) || witnessIds === null ||
      witnessIds.some((witness) => !/^[0-9a-f]{64}$/.test(witness))) return null;
  return qualityFreeze({
    evidenceId: evidenceId.value,
    kind: kind.value,
    repetition: repetition.value,
    outcome: outcome.value,
    witnessCount: witnessIds.length,
    path,
  });
}

function fixedFloorInput({ runId, stopReason, candidateCount, selection, pathBudget, candidates, issues, omittedCounts }) {
  return {
    runId,
    stopReason,
    candidateCount,
    outcome: selection.outcome,
    selectedCandidateId: selection.selectedCandidateId,
    paths: pathBudget.paths,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      patchPresent: candidate.patch !== null,
      proofStatus: candidate.regressionProof.status,
    })),
    issueSummary: issues.map((issue) => ({
      candidateId: issue.candidateId,
      openIssueIds: issue.openIssueIds,
      openIssueCount: issue.openIssueCount,
    })),
    omittedCounts,
  };
}

function artifactBlocked(runId, error, recovery, notice = undefined) {
  return failure({
    status: 'blocked', confidence: 'unverified', runId, stopReason: error,
    error, recovery, ...(notice ? { notice } : {}),
  });
}

function pathContains(parent, child) {
  const value = relative(parent, child);
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

const PREPARATION_PRIVATE = new WeakMap();

const WORKTREE_HANDLE_KEYS = Object.freeze([
  'ok', 'path', 'projectPath', 'stateRoot', 'runId', 'worktreeId', 'purpose', 'baseline',
  'baselineIdentity', 'lastSnapshot', 'transplanted', 'ignoredPaths', 'sharedRules',
]);

function ownDataValue(value, key) {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? { ok: true, value: descriptor.value }
      : { ok: false, value: undefined };
  } catch {
    return { ok: false, value: undefined };
  }
}

function snapshotBlockedResult(value) {
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

function snapshotBoundedStrings(value) {
  if (value === null) return null;
  const values = snapshotOwnDataArray(value);
  if (values === null || values.length > 10_000 || values.some((entry) =>
    typeof entry !== 'string' || entry.length > 32_768 || /[\u0000\uFFFD]/.test(entry))) return undefined;
  return qualityFreeze([...values]);
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
      ignoredPaths === undefined || sharedRules === undefined) return null;
  const clone = {
    ok: true,
    path: raw.path,
    projectPath: raw.projectPath,
    stateRoot: raw.stateRoot,
    runId: raw.runId,
    worktreeId: raw.worktreeId,
    purpose: raw.purpose,
    baseline: raw.baseline,
    baselineIdentity: qualityFreeze({ ...baselineIdentity }),
    lastSnapshot: raw.lastSnapshot,
    transplanted: raw.transplanted,
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
  return {
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
    ignoredPaths: [],
    sharedRules: [],
  };
}

async function prepareRunNamespace(options, deps) {
  const context = options;
  const runOptions = context.options;
  const candidateCount = runOptions.candidateCount === undefined ? 1 : runOptions.candidateCount;
  const {
    task, projectPath, budget, deadlineAt, deadline, effectiveWaitMs,
    registered, now, stage, recoveryStage, onSpawn, killLiveChildren, isWorktreeEffectUnknown,
  } = context;
  const fail = (envelope) => qualityFreeze({ ok: false, envelope });
  if (![1, 2].includes(candidateCount) || candidateCount === 2 &&
      (runOptions.worker !== undefined || runOptions.verifier !== undefined) ||
      typeof task !== 'string' || task.trim() === '' || typeof projectPath !== 'string' ||
      projectPath === '' || !isAbsolute(projectPath) || (runOptions.isolation ?? 'worktree') !== 'worktree' ||
      !Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET ||
      !Number.isSafeInteger(deadlineAt)) {
    return fail(failure({ status: 'invalid', error: 'c1 preparation input is invalid', recovery: '입력값을 확인하세요.' }));
  }
  const preflightSettlements = await Promise.all(registered.map(async (provider, registryIndex) => {
    try {
      const result = await stage(`${provider.id} preflight`, () => provider.preflight(deadline));
      return [provider.id, result && typeof result === 'object' ? result : { available: false, error: 'preflight 응답이 잘못됐습니다.' }, provider, registryIndex];
    } catch (error) {
      let described;
      try { described = provider.describeError(error); } catch { described = { error: safeText(error), recovery: GENERIC_RECOVERY }; }
      return [provider.id, { available: false, ...described }, provider, registryIndex];
    }
  }));
  if (preflightSettlements.some(([, result]) => result?.hardStopped === true)) {
    return fail(failure({ status: 'deadline_exceeded', error: `프로바이더 사전 점검 중 데드라인(${effectiveWaitMs}ms)이 지났습니다.`, recovery: 'wait_ms 를 늘리거나 CLI 설치 상태를 확인하세요.', confidence: 'unverified', stopReason: 'deadline_exceeded' }));
  }
  const groupedSettlements = new Map();
  for (const [id, result, provider, registryIndex] of preflightSettlements) {
    if (!groupedSettlements.has(id)) groupedSettlements.set(id, []);
    groupedSettlements.get(id).push({ result, provider, registryIndex });
  }
  const availability = qualityFreeze(Object.fromEntries([...groupedSettlements].map(([id, entries]) => [
    id,
    entries.length === 1
      ? entries[0].result
      : { available: false, error: 'duplicate provider id', recovery: `중복 provider id를 제거하세요: ${id}` },
  ])));
  const providers = [...groupedSettlements.values()]
    .filter((entries) => entries.length === 1 && entries[0].result?.available === true)
    .sort((left, right) => left[0].registryIndex - right[0].registryIndex)
    .map((entries) => entries[0].provider);
  if (providers.length === 0) {
    return fail(failure({ status: 'blocked', error: '사용 가능한 프로바이더가 하나도 없습니다.', recovery: preflightSettlements.map(([id, value]) => `${id}: ${value.recovery ?? value.error ?? '설치 상태를 확인하세요.'}`).join(' / ') }));
  }
  for (const role of ['planner', 'worker', 'verifier']) {
    const wanted = runOptions[role];
    if (wanted !== undefined && wanted !== null && availability[wanted]?.available !== true) {
      return fail(failure({ status: 'blocked', error: `${role} 로 지정한 프로바이더(${wanted})를 사용할 수 없습니다.`, recovery: availability[wanted]?.recovery ?? '해당 CLI 설치와 PATH 설정을 확인하세요.' }));
    }
  }
  if (providers.length < 2 && (candidateCount === 2 || runOptions.allowSingle !== true)) {
    return fail(failure({ status: 'blocked', error: '교차 벤더 검증에 필요한 프로바이더 둘을 사용할 수 없습니다.', recovery: '두 벤더 CLI 를 설치하거나, 단일 벤더 결과를 수용하려면 allow_single: true 를 명시하세요.' }));
  }
  const progress = (phase, step = 0, identity = {}) => {
    try {
      runOptions.onProgress?.(candidateCount === 1
        ? { phase, step, event: { type: 'phase', phase } }
        : { phase, step, ...identity, event: { type: 'phase', phase, ...identity } });
    } catch { /* advisory */ }
  };
  const runId = typeof deps.runId === 'string' && RUN_ID_PATTERN.test(deps.runId)
    ? deps.runId
    : makeRunId({ now, random: typeof deps.random === 'function' ? deps.random : Math.random });
  context.setRunIdentity?.({ runId });
  const requestedRoot = typeof deps.stateRoot === 'string' && deps.stateRoot !== '' ? deps.stateRoot : resolveStateRoot();
  const canonicalStateRoot = deps.canonicalStateRoot ?? canonical;
  const canonicalProjectPath = deps.canonicalProjectPath ?? canonical;
  let stateRoot;
  let canonicalProject;
  try {
    stateRoot = await canonicalStateRoot(requestedRoot);
    if (typeof stateRoot !== 'string') throw new Error('canonicalization failed');
  } catch {
    return fail(artifactBlocked(runId, 'artifact_root_not_canonical', 'BOM_ORCH_HOME 경로를 먼저 만들고 더 짧은 절대 경로로 다시 시도하세요.'));
  }
  const pathBudget = validateArtifactPathBudget({ stateRoot, runId, candidateCount });
  if (isBlocked(pathBudget)) return fail(artifactBlocked(runId, pathBudget.error, pathBudget.recovery));
  const collisionCheck = deps.inspectRunArtifactCollision ?? inspectRunArtifactCollision;
  const readonlyDeps = deps.artifactReadonlyDeps ?? { canonicalPath: canonicalStateRoot };
  const collision = await collisionCheck({ stateRoot, runId }, readonlyDeps);
  if (isBlocked(collision)) return fail(artifactBlocked(runId, collision.error, collision.recovery));
  if (collision.collision === true) {
    return fail(artifactBlocked(runId, 'artifact_namespace_collision', '기존 bytes를 보존했습니다. 새 runId로 다시 시도하세요.'));
  }
  try {
    canonicalProject = await canonicalProjectPath(projectPath);
    if (typeof canonicalProject !== 'string') throw new Error('canonicalization failed');
  } catch {
    return fail(artifactBlocked(runId, 'project_root_not_canonical', 'project 경로를 확인하세요.'));
  }
  if (pathContains(stateRoot, canonicalProject) || pathContains(canonicalProject, stateRoot)) {
    return fail(artifactBlocked(runId, 'artifact_root_overlaps_project', 'BOM_ORCH_HOME을 대상 저장소와 겹치지 않는 별도 경로로 옮기세요.'));
  }

  const sweepScratch = deps.sweepScratch ?? defaultSweepScratch;
  const sweepPatches = deps.sweepPatches ?? defaultSweepPatches;
  const sweepRuns = deps.sweepRuns ?? defaultSweepRuns;
  const sweepNow = now();
  const sweepSummaries = [];
  for (const [name, sweep, args] of [
    ['scratch', sweepScratch, [stateRoot, sweepNow]],
    ['patches', sweepPatches, [stateRoot, sweepNow, { excludeRunId: runId }]],
    ['runs', sweepRuns, [stateRoot, sweepNow, { excludeRunId: runId }]],
  ]) {
    try {
      const summary = await sweep(...args);
      const removed = Array.isArray(summary?.removed) ? summary.removed.length : summary?.removed ?? 0;
      if (removed > 0 || (summary?.skipped?.length ?? 0) > 0) {
        sweepSummaries.push(`${name}:${removed}/${summary?.skipped?.length ?? 0}`);
      }
    } catch {
      sweepSummaries.push(`${name}:0/1`);
    }
  }

  if (deadline?.aborted === true || now() >= deadlineAt) {
    return fail(failure({ status: 'deadline_exceeded', confidence: 'unverified', runId, stopReason: 'deadline_exceeded', error: `데드라인(${effectiveWaitMs}ms)이 지났습니다.`, recovery: 'wait_ms를 늘려 다시 시도하세요.' }));
  }
  progress('inspect');
  const inspectRepo = deps.inspectRepo ?? defaultInspectRepo;
  const inspected = await stage('저장소 점검', () => inspectRepo(projectPath));
  if (inspected?.hardStopped === true) {
    return fail(failure({ status: 'deadline_exceeded', confidence: 'unverified', runId, stopReason: 'deadline_exceeded', error: inspected.error, recovery: inspected.recovery }));
  }
  if (isBlocked(inspected)) return fail(artifactBlocked(runId, inspected.error, inspected.recovery ?? GENERIC_RECOVERY));
  const usesDefaultTestPlanDeriver = deps.deriveFrozenTestPlan === undefined;
  const deriveFrozenTestPlan = deps.deriveFrozenTestPlan ?? defaultDeriveFrozenTestPlan;
  const derivedTestPlan = await stage('고정 테스트 계획 유도', () => deriveFrozenTestPlan(projectPath, deps.testRunnerDeps ?? {}));
  if (isBlocked(derivedTestPlan)) return fail(artifactBlocked(runId, derivedTestPlan.error, derivedTestPlan.recovery ?? GENERIC_RECOVERY));
  // The production test-plan builder attaches private frozen runtime authority to
  // the returned object. Preserve that identity; injected mutable fixtures still
  // receive the defensive clone used by the controller tests.
  const frozenTestPlan = usesDefaultTestPlanDeriver && Object.isFrozen(derivedTestPlan)
    ? derivedTestPlan
    : qualityFreeze(qualityClone(derivedTestPlan));

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
    laneWorktree = await stage('lane-a 워크트리 생성', () => createWorktree({
      projectPath, stateRoot, runId, worktreeId: laneAExpected.worktreeId, purpose: 'lane-a',
    }), {
      onHardStop: (pending) => pending.then((late) => {
        const latePath = ownDataValue(late, 'path');
        const lateOk = ownDataValue(late, 'ok');
        if (lateOk.ok === true && lateOk.value === true && latePath.ok === true && latePath.value === laneAExpected.path) {
          return recoveryStage('late worktree handoff', () =>
            (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: laneAExpected.path }));
        }
        return null;
      }).catch(() => null),
    });
  } catch {
    return fail(artifactBlocked(runId, 'invalid_worktree_handle', GENERIC_RECOVERY));
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
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: owned.path })).catch(() => false);
        cleanupNotice = tracked === true
          ? `워크트리 정리를 리퍼에 넘겼습니다: ${owned.path}`
          : `manual cleanup required: ${owned.path}`;
      }
    }
    return fail(failure({ status: 'deadline_exceeded', confidence: 'unverified', runId, stopReason: 'deadline_exceeded', error: laneAFailure.error ?? 'worktree_creation_failed', recovery: owned?.path ?? laneAFailure.recovery ?? GENERIC_RECOVERY, ...(cleanupNotice ? { notice: cleanupNotice } : {}) }));
  }
  if (laneAFailure?.blocked === true) {
    const owned = provenOwnedWorktreeForCleanup(laneWorktree, laneAExpected);
    let cleanupNotice;
    if (owned !== null) {
      const removal = snapshotRemovalResult(await recoveryStage('blocked lane-a worktree cleanup', () =>
        (deps.removeWorktree ?? defaultRemoveWorktree)(owned)).catch(() => null));
      if (!(removal.ok === true && removal.removed === true && removal.unregistered === true)) {
        const tracked = await recoveryStage('blocked lane-a worktree handoff', () =>
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: owned.path })).catch(() => false);
        cleanupNotice = tracked === true
          ? `워크트리 정리를 리퍼에 넘겼습니다: ${owned.path}`
          : `manual cleanup required: ${owned.path}`;
      }
    }
    return fail(artifactBlocked(runId, laneAFailure.error ?? 'worktree_creation_failed', owned?.path ?? laneAFailure.recovery ?? GENERIC_RECOVERY, cleanupNotice));
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
            (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: owned.path })).catch(() => false);
          return { paths: [owned.path], notices: [tracked === true
            ? `워크트리 정리를 리퍼에 넘겼습니다: ${owned.path}`
            : `manual cleanup required: ${owned.path}`] };
        })();
    return fail(artifactBlocked(runId, 'invalid_worktree_handle', cleanup.paths.join(', ') || GENERIC_RECOVERY, joinNotices(cleanup.notices)));
  }
  progress('worktree');
  const baseline = qualityFreeze({ ...preparedLaneA.baselineIdentity });
  const laneWorktrees = [preparedLaneA];
  const cleanupPreparationWorktrees = async (worktrees, label) => {
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
        (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: worktree.path })).catch(() => false);
      notices.push(tracked === true
        ? `워크트리 정리를 리퍼에 넘겼습니다: ${worktree.path}`
        : `manual cleanup required: ${worktree.path}`);
    }
    return { paths: unique.map((value) => value.path), notices };
  };
  if (candidateCount === 2) {
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
    }), {
      onHardStop: (pending) => pending.then((late) => {
        const latePath = ownDataValue(late, 'path');
        const lateOk = ownDataValue(late, 'ok');
        if (lateOk.ok === true && lateOk.value === true && latePath.ok === true && latePath.value === laneBExpected.path) {
          return recoveryStage('late lane-b worktree handoff', () =>
            (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: laneBExpected.path }));
        }
        return null;
      }).catch(() => null),
      });
    } catch {
      const cleanup = await cleanupPreparationWorktrees([preparedLaneA], 'shared baseline preparation failure');
      return fail(artifactBlocked(runId, 'shared_baseline_mismatch', cleanup.paths.join(', '), joinNotices(cleanup.notices)));
    }
    const laneBFailure = snapshotBlockedResult(laneB);
    const preparedLaneB = snapshotWorktreeHandle(laneB, laneBExpected);
    if (laneBFailure?.hardStopped === true || laneBFailure?.blocked === true || preparedLaneB === null ||
        preparedLaneB.path === preparedLaneA.path) {
      const ownedLaneB = provenOwnedWorktreeForCleanup(laneB, laneBExpected);
      const cleanup = await cleanupPreparationWorktrees(
        [preparedLaneA, ...(ownedLaneB === null ? [] : [ownedLaneB])],
        'shared baseline preparation failure',
      );
      return fail(laneBFailure?.hardStopped === true
        ? failure({ status: 'deadline_exceeded', confidence: 'unverified', runId, stopReason: 'deadline_exceeded', error: laneBFailure.error ?? 'shared_baseline_mismatch', recovery: cleanup.paths.join(', '), ...(cleanup.notices.length ? { notice: joinNotices(cleanup.notices) } : {}) })
        : artifactBlocked(runId, laneBFailure?.error ?? 'shared_baseline_mismatch', cleanup.paths.join(', '), joinNotices(cleanup.notices)));
    }
    laneWorktrees.push(preparedLaneB);
  }
  context.setRunIdentity?.({
    runId,
    stateRoot,
    worktreePath: preparedLaneA.path,
    worktreePaths: laneWorktrees.map((worktree) => worktree.path),
  });
  let taskClass;
  let proofRequirement;
  let decisions;
  let decisionSources;
  let bandit = null;
  let baseRoles;
  try {
    taskClass = classifyTask({ task, testSource: frozenTestPlan.source ?? null });
    proofRequirement = classifyProofRequirement({ task, taskClass });
    const rawPosteriors = await stage('학습 상태 읽기', () =>
      (deps.readPosteriors ?? defaultReadPosteriors)(stateRoot)).catch(() => ({ ok: false, cells: {} }));
    const posteriors = qualityClone(rawPosteriors);
    const advice = bandit = decide({
      cells: posteriors?.ok === true ? posteriors.cells : {}, taskClass,
      allowed: { single: runOptions.allowSingle === true },
      random: typeof deps.random === 'function' ? deps.random : Math.random,
    });
    const rawDecisions = runOptions.decisions && typeof runOptions.decisions === 'object' ? runOptions.decisions : {};
    decisions = {};
    decisionSources = {};
    for (const axis of ['mix', 'placement', 'tier']) {
      decisions[axis] = rawDecisions[axis] ?? advice.decisions[axis];
      decisionSources[axis] = rawDecisions[axis] === undefined ? advice.sources[axis] : 'caller';
    }
    baseRoles = assignRoles(providers, decisions);
  } catch {
    const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'binding preparation failure');
    return fail(artifactBlocked(runId, 'binding_preparation_failed', cleanup.paths.join(', '), joinNotices(cleanup.notices)));
  }
  const pick = (wanted, fallback) => wanted == null ? fallback : providers.find((provider) => provider.id === wanted);
  const plannerProvider = pick(runOptions.planner, candidateCount === 2 ? providers[0] : baseRoles.planner);
  const writerProvider = candidateCount === 2 ? providers[0] : pick(runOptions.worker, baseRoles.worker);
  const verifierProvider = candidateCount === 2 ? providers[1] : pick(runOptions.verifier, baseRoles.verifier);
  if (!plannerProvider || !writerProvider || !verifierProvider || writerProvider.id === verifierProvider.id && runOptions.allowSingle !== true) {
    const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'invalid binding worktree');
    return fail(artifactBlocked(runId, 'invalid_frozen_binding', cleanup.notices.length === 0
      ? '서로 다른 사용 가능한 writer/verifier를 지정하세요.' : cleanup.paths.join(', '),
    joinNotices(cleanup.notices)));
  }
  // ★★ 설계 §5.8 S2(a) — 쓰기 역할의 보안 하한. 여기가 자리인 이유가 둘이다: writer 가 방금
  //   확정됐고, 아직 어떤 CLI 도 안 띄웠다. 막을 거면 워크트리를 쥐여주기 **전**에 막아야 한다.
  //
  // ★ c2 는 두 레인이 서로 바꿔 쓰므로 두 프로바이더가 **모두** writer 후보다. c1 은 writer 만
  //   묻는다 — 읽기 전용 역할은 강등 대상이 아니므로 그것 때문에 프로브를 돌리지 않는다.
  //   (설계 문구 그대로 "read-only 로 강등" 이다. 실행 금지가 아니다.)
  const writerCandidates = candidateCount === 2
    ? [writerProvider, verifierProvider]
    : [writerProvider];
  for (const candidate of new Set(writerCandidates)) {
    const probe = deps.securityFloor ?? (typeof candidate.securityFloor === 'function'
      ? (() => candidate.securityFloor(deadline))
      : null);
    if (probe === null) continue;
    let floor;
    try {
      floor = await stage(`${candidate.id} 보안 하한 확인`, () => probe(candidate.id, candidate));
    } catch {
      floor = null;
    }
    // 모르면 막지 않는다. 읽지 못한 버전은 「취약하다」의 증거가 아니고, 추측하는 게이트는
    // 버전 문자열 형식이 바뀌는 날 멀쩡한 설치를 전부 벽돌로 만든다.
    if (floor?.writable !== false) continue;
    const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'security floor rejection');
    return fail(failure({
      status: 'blocked',
      confidence: 'unverified',
      runId,
      // 설치된 버전은 **엔진이** 싣는다. 조치하는 사람이 가장 먼저 알아야 하는 값이라
      // 프로바이더가 문구에 넣어줬기를 기대하지 않는다.
      error: `${candidate.id}${typeof floor.version === 'string' ? `(${floor.version})` : ''} 를 writer 로 쓸 수 없습니다: ${floor.error ?? '보안 하한 미만입니다.'}`,
      recovery: floor.recovery ?? '해당 CLI 를 올리거나 다른 벤더를 writer 로 지정하세요.',
      ...(cleanup.notices.length ? { notice: joinNotices(cleanup.notices) } : {}),
    }));
  }

  let settings;
  let tier;
  let plannerBinding;
  let laneBinding;
  try {
    const rawSettings = await stage('모델 설정 읽기', () => (deps.readSettings ?? defaultReadSettings)(stateRoot)).catch(() => ({}));
    settings = qualityFreeze(qualityClone(rawSettings ?? {}));
    tier = AXES.tier.arms.includes(decisions.tier) ? decisions.tier : AXES.tier.default;
    plannerBinding = exactRoleBinding(plannerProvider, settings, tier, 'planner');
    laneBinding = qualityFreeze({
      writer: exactRoleBinding(writerProvider, settings, tier, 'worker'),
      verifier: exactRoleBinding(verifierProvider, settings, tier, 'verifier'),
    });
  } catch {
    const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'settings preparation failure');
    return fail(artifactBlocked(runId, 'binding_preparation_failed', cleanup.paths.join(', '), joinNotices(cleanup.notices)));
  }
  const laneBindings = candidateCount === 1 ? [laneBinding] : [
    laneBinding,
    qualityFreeze({
      writer: exactRoleBinding(verifierProvider, settings, tier, 'worker'),
      verifier: exactRoleBinding(writerProvider, settings, tier, 'verifier'),
    }),
  ];
  const laneProviders = candidateCount === 1 ? [{ writer: writerProvider, verifier: verifierProvider }] : [
    { writer: writerProvider, verifier: verifierProvider },
    { writer: verifierProvider, verifier: writerProvider },
  ];
  const effectiveChoices = freezeEffectiveChoices({
    candidateCount, providers, decisions, tier, writerProvider, verifierProvider, runOptions, settings,
  });
  /**
   * 설계 §7.5 의 근거 문단 — 밴딧이 계획을 짜는 게 아니라 **증거를 공급한다**.
   *
   * ★★ 이 배선은 `4b53bfe` 가 조용히 끊었다(`evidence: {}`). 그대로 되살리면 안 된다: 문단은
   *   `AXES` 전체를 돌며 만들어지므로 `rewrite`(엔진이 결정에서 버리는 축)와 구분되지 않는
   *   `tier`(팔 뒤에 아무것도 없는 상태)에 대한 문장까지 살아 있는 모델에게 간다. 기본 설치에서는
   *   문단의 절반 이상이 사실상 거짓이 된다.
   *
   * ★ 그래서 **이 실행이 실제로 고를 수 있었던 축만** 싣는다. `identifiable` 이 정확히 그
   *   질문의 답이고, 이미 위에서 얼어붙었다. 학습이 보상하지 않는 축은 모델에게도 말하지 않는다 —
   *   한 실행에 대해 두 곳이 다른 말을 하면 어느 쪽도 못 믿는다.
   *
   * ★ c2 블라인딩이 공짜로 지켜진다: 벤더 이름을 담은 축은 `placement` 하나뿐이고, c2 는 그것을
   *   `mirrored_two_lane_placement` 로 이미 식별 불가로 표시한다. 두 레인이 공유하는 계획
   *   텍스트에 벤더 이름이 실릴 길이 없다.
   */
  const plannerEvidence = evidenceParagraph(
    bandit,
    POLICY_V2_AXES.filter((axis) => effectiveChoices[axis]?.identifiable === true),
  );
  const judgeBindings = candidateCount === 2
    ? laneProviders.map(({ writer }) => exactRoleBinding(writer, settings, tier, 'thinker'))
    : [];
  const usageAccumulator = createRunUsageAccumulator();
  const callProvider = async ({ provider, binding, kind, laneId, attemptId, judgeIndex = null, instruction, workspace, tools, nonWorktree = false }) => {
    if (deadline?.aborted === true || now() >= deadlineAt) {
      const error = new Error('deadline_expired');
      error.preBoundary = true;
      throw error;
    }
    const ticket = usageAccumulator.start({ kind, laneId, attemptId, judgeIndex });
    const phase = kind === 'verifier_format' ? 'verifier' : kind === 'judge_format' ? 'judge' : kind === 'writer' ? 'worker' : kind;
    progress(phase, attemptId === null ? judgeIndex ?? 0 : Number(attemptId.slice(-3)), {
      laneId,
      attemptId,
      role: binding.role,
      judgeIndex,
    });
    let result;
    try {
      result = await stage(`${kind} provider`, () => provider.run({
        role: binding.role, model: binding.model, effort: binding.effort, instruction, workspace,
        tools, allowedTools: tools, signal: deadline,
        onSpawn: (child) => onSpawn(child, {
          late: deadline?.aborted === true,
          planner: kind === 'planner' || nonWorktree,
          worktreePath: nonWorktree ? null : workspace,
          ownerWorktreePath: workspace,
          laneId,
          attemptId,
          role: binding.role,
          judgeIndex,
          reportIdentity: candidateCount === 2,
        }),
        onProgress: (event) => {
          if (deadline?.aborted !== true) {
            try {
              runOptions.onProgress?.(candidateCount === 1
                ? { phase: kind, event }
                : { phase, laneId, attemptId, role: binding.role, judgeIndex, event });
            } catch { /* advisory */ }
          }
        },
        runId,
      }), { mayTouchWorktree: !nonWorktree && kind !== 'planner', worktreePath: workspace });
      if (result?.hardStopped === true) throw new Error('provider_effect_unknown');
      return result;
    } finally {
      usageAccumulator.settle(ticket, { promptTokens: result?.promptTokens ?? null, evalTokens: result?.evalTokens ?? null });
    }
  };
  const plansRoot = join(stateRoot, 'plans');
  let planDir = null;
  let planDirIdentity = null;
  const plannerNotices = [];
  let plannerUsage = qualityFreeze({ calls: 0, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: false });
  let plannerProviderEntered = false;
  let plan = task;
  try {
    const plannedRoot = await canonical(plansRoot);
    const expectedPlansRoot = resolve(stateRoot, 'plans');
    if (plannedRoot === null || relative(plannedRoot, expectedPlansRoot) !== '' || relative(plannedRoot, stateRoot) === '' ||
        !pathContains(stateRoot, plannedRoot)) throw new Error('planner_scratch_root_untrusted');
    await mkdir(plansRoot, { recursive: true });
    planDir = await mkdtemp(join(plansRoot, `${runId}-planner-`));
    const returnedPlanDir = resolve(planDir);
    const [canonicalPlanDir, planStat] = await Promise.all([canonical(planDir), lstat(planDir, { bigint: true })]);
    const canonicalPlansRoot = await canonical(plansRoot);
    if (canonicalPlanDir === null || canonicalPlansRoot === null || relative(canonicalPlansRoot, expectedPlansRoot) !== '' || !pathContains(stateRoot, canonicalPlansRoot) ||
        !planStat.isDirectory() || planStat.isSymbolicLink() || relative(canonicalPlanDir, returnedPlanDir) !== '' ||
        relative(canonicalPlansRoot, canonicalPlanDir) === '' || !pathContains(canonicalPlansRoot, canonicalPlanDir)) {
      throw new Error('planner_scratch_identity_unavailable');
    }
    planDir = canonicalPlanDir;
    planDirIdentity = { path: canonicalPlanDir, dev: planStat.dev, ino: planStat.ino };
    plannerProviderEntered = true;
    const planner = await callProvider({
      provider: plannerProvider, binding: plannerBinding, kind: 'planner', laneId: null, attemptId: null,
      instruction: plannerInstruction({ task, testPlan: frozenTestPlan, evidence: plannerEvidence }),
      workspace: planDir, tools: undefined,
    });
    plannerUsage = qualityFreeze({
      calls: 1,
      promptTokensKnown: Number.isSafeInteger(planner?.promptTokens) && planner.promptTokens >= 0 ? planner.promptTokens : 0,
      evalTokensKnown: Number.isSafeInteger(planner?.evalTokens) && planner.evalTokens >= 0 ? planner.evalTokens : 0,
      incomplete: !Number.isSafeInteger(planner?.promptTokens) || planner.promptTokens < 0 || !Number.isSafeInteger(planner?.evalTokens) || planner.evalTokens < 0,
    });
    if (qualityProviderFailure(planner)) {
      plannerNotices.push('planner failed; original task text was used');
    } else if (typeof planner?.content === 'string' && planner.content !== '') {
      plan = clip(planner.content, EXCERPT_CHARS);
    }
  } catch (error) {
    if (plannerUsage.calls === 0 && plannerProviderEntered && error?.preBoundary !== true) {
      plannerUsage = qualityFreeze({ calls: 1, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: true });
    }
    plan = task;
    if (planDir !== null && planDirIdentity === null) plannerNotices.push('planner scratch identity could not be proven');
    plannerNotices.push('planner failed; original task text was used');
  } finally {
    if (planDir !== null && planDirIdentity !== null) {
      let removed = false;
      const childrenProven = await killLiveChildren(planDirIdentity.path);
      if (childrenProven) {
        try {
          const [actual, current] = await Promise.all([canonical(planDir), lstat(planDir, { bigint: true })]);
          if (actual !== null && relative(actual, planDirIdentity.path) === '' && current.dev === planDirIdentity.dev && current.ino === planDirIdentity.ino && current.isDirectory() && !current.isSymbolicLink()) {
            const removal = await recoveryStage('planner scratch cleanup', () =>
              (deps.removePlannerScratch ?? rm)(planDirIdentity.path, { recursive: true, force: false }));
            if (removal?.hardStopped !== true) {
              removed = await lstat(planDirIdentity.path).then(() => false, (error) => error?.code === 'ENOENT');
            }
          }
        } catch (error) {
          removed = error?.code === 'ENOENT';
        }
      }
      if (!removed) plannerNotices.push(`planner scratch cleanup pending: ${planDir}`);
    } else if (planDir !== null) {
      plannerNotices.push(`planner scratch cleanup pending: ${planDir}`);
    }
  }

  if (deadline?.aborted === true || now() >= deadlineAt) {
    const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'post-planner authoring');
    const authoringNotices = cleanup.notices;
    const pendingPlannerNotice = plannerNotices.filter((value) => value.startsWith('planner scratch cleanup pending:'));
    return fail(failure({
      status: 'deadline_exceeded', confidence: 'unverified', runId, stopReason: 'deadline_exceeded',
      error: 'planner 뒤 데드라인이 지났습니다.',
      recovery: pendingPlannerNotice.length > 0
        ? `${pendingPlannerNotice.join(' / ')}${authoringNotices.length === 0 ? '' : `; ${laneWorktrees.map((value) => value.path).join(', ')}`}`
        : authoringNotices.length === 0 ? 'wait_ms를 늘려 다시 시도하세요.' : cleanup.paths.join(', '),
      ...(authoringNotices.length > 0 || pendingPlannerNotice.length > 0 ? { notice: [
        ...pendingPlannerNotice,
        ...authoringNotices,
      ].join(' / ') } : {}),
    }));
  }
  const initialManifest = {
    schemaVersion: 1, runId, candidateCount, baseline,
    frozenTestPlan: {
      planFingerprint: frozenTestPlan.planFingerprint,
      environmentFingerprint: frozenTestPlan.environmentFingerprint,
    },
    proofRequirement, plannerBinding,
    laneBindings: laneBindings.map((binding, index) => ({ laneId: index === 0 ? 'lane-a' : 'lane-b', binding })),
    deadlineAt,
  };
  const artifactStore = await recoveryStage('artifact store initialization', () =>
    (deps.createRunArtifacts ?? createRunArtifacts)(
      { stateRoot, runId, initialManifest }, deps.artifactDeps ?? {},
    )).catch(() => ({ blocked: true, error: 'artifact_store_initialization_failed', recovery: preparedLaneA.path }));
  const artifactStoreFailure = snapshotBlockedResult(artifactStore);
  let artifactStoreValid = false;
  if (artifactStoreFailure?.blocked !== true) {
    try {
      artifactStoreValid = (deps.isRunArtifactStore ?? isRunArtifactStore)(artifactStore, {
        stateRoot,
        runId,
        candidateCount,
      }) === true;
    } catch {
      artifactStoreValid = false;
    }
  }
  if (artifactStoreFailure?.blocked === true || !artifactStoreValid) {
    let cleanup;
      if (candidateCount === 1) {
        const tracked = await recoveryStage('artifact initialization worktree handoff', () =>
        (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: preparedLaneA.path })).catch(() => false);
        cleanup = {
        paths: [preparedLaneA.path],
          notices: [tracked === true
          ? `워크트리 정리를 리퍼에 넘겼습니다: ${preparedLaneA.path}`
          : `manual cleanup required: ${preparedLaneA.path}`],
        };
    } else {
      cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'artifact initialization worktree');
    }
    const recoveryNotices = cleanup.notices;
    const error = artifactStoreFailure?.hardStopped === true
      ? 'artifact_store_authority_lost'
      : artifactStoreFailure?.blocked === true ? artifactStoreFailure.error ?? 'artifact_store_initialization_failed' : 'invalid_artifact_store';
    return fail(artifactBlocked(runId, error, cleanup.paths.join(', '), joinNotices([
      ...(sweepSummaries.length ? [`retention ${sweepSummaries.join(',')}`] : []),
      ...plannerNotices,
      ...recoveryNotices,
    ])));
  }

  let rawStoreAuthority;
  try {
    rawStoreAuthority = (deps.getRunArtifactStoreAuthority ?? getRunArtifactStoreAuthority)(artifactStore, {
      stateRoot,
      runId,
      candidateCount,
    });
  } catch {
    rawStoreAuthority = null;
  }
  const revisionZeroAuthority = snapshotStoreArtifactAuthority(rawStoreAuthority, pathBudget.paths.manifestPath);
  if (revisionZeroAuthority === null) {
    const cleanup = candidateCount === 1
      ? { paths: [preparedLaneA.path], notices: [await recoveryStage('artifact authority worktree handoff', () =>
        (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: preparedLaneA.path })).catch(() => false) === true
        ? `워크트리 정리를 리퍼에 넘겼습니다: ${preparedLaneA.path}`
        : `manual cleanup required: ${preparedLaneA.path}`] }
      : await cleanupPreparationWorktrees(laneWorktrees, 'artifact authority worktree');
    return fail(artifactBlocked(runId, 'invalid_artifact_store', cleanup.paths.join(', '), joinNotices([
      ...plannerNotices,
      ...cleanup.notices,
    ])));
  }

  const testQueue = createSerialTestQueue({ now });
  const evidenceCache = new Map();
  const prepared = {
    ok: true, runId, stateRoot, deadlineAt, candidateCount, frozenTestPlan, baseline,
    laneWorktrees: Object.freeze([...laneWorktrees]), laneBindings: Object.freeze([...laneBindings]),
    laneWorktree: preparedLaneA, proofRequirement, plannerBinding, laneBinding, plan, plannerUsage,
    artifactPaths: pathBudget.paths, artifactStore, manifestAuthority: revisionZeroAuthority, testQueue, evidenceCache,
    artifactRevisionAuthority: { latest: 0 },
    usageAccumulator, sweepNotice: sweepSummaries.length ? `retention ${sweepSummaries.join(',')}` : null,
  };
  PREPARATION_PRIVATE.set(prepared, {
    taskClass, decisions, decisionSources, plannerProvider, writerProvider, verifierProvider,
    laneProviders, judgeBindings: Object.freeze([...judgeBindings]), tier, plannerNotices, callProvider, pathBudget, progress,
    effectiveChoices,
  });
  return Object.freeze(prepared);
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
      deadlineAt: preparation.deadlineAt,
      baseline: preparation.baseline,
      proofRequirement: preparation.proofRequirement,
      frozenTestPlan: preparation.frozenTestPlan,
      authoringWorktree: laneWorktree,
    }, adapters);
    const contentFacts = qualityFreeze({
      attempts: candidate.attempts.map((attempt) => ({
        candidateId: candidate.candidateId,
        ordinal: attempt.ordinal,
        attemptId: attempt.attemptId,
        retryOf: attempt.retryOf,
        result: attempt.result,
        hash: attempt.sealed?.patchSha256 ?? null,
        ref: privateFacts.attemptArtifactRefs.get(attempt.attemptId) ?? null,
        usage: combineContentUsage(attempt.usage?.writer, attempt.usage?.verifier),
      })),
      evidenceRefs: [...privateFacts.contentEvidenceRefs.values()],
      evidenceOmittedCount: privateFacts.contentEvidenceOmissions.count,
    });
    return qualityFreeze({
      candidate,
      judgeViews: privateFacts.judgeViews,
      contentFacts,
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
    runId, stateRoot, deadlineAt, frozenTestPlan, baseline, proofRequirement,
    plan, artifactPaths, artifactStore, manifestAuthority, artifactRevisionAuthority, testQueue, evidenceCache,
  } = preparation;
  const { laneProviders, callProvider, progress } = PREPARATION_PRIVATE.get(preparation);
  const providers = laneProviders[laneIndex];
  const {
    deps, task, budget, deadline, now, stage, recoveryStage, onSpawn, killLiveChildren,
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
            feedback: value.feedback.openIds.length ? `열린 이슈: ${value.feedback.openIds.join(', ')}` : null,
          }),
          workspace: laneWorktree.path,
          tools: [...WORKER_TOOLS],
        });
      } catch (error) {
        return {
          status: error?.preBoundary === true ? 'timeout' : 'effect_unknown',
          callStarted: error?.preBoundary !== true,
          usage: { promptTokens: null, evalTokens: null },
        };
      }
      return {
        status: qualityWriterSettlement(result),
        usage: { promptTokens: result?.promptTokens, evalTokens: result?.evalTokens },
      };
    },
    sealAttempt: async ({ attemptId, ordinal }) => {
      const snapshot = await stage(label('writer snapshot'), () =>
        snapshotStep(laneWorktree, `bom-orch attempt ${ordinal} writer`), {
        mayTouchWorktree: true,
        worktreePath: laneWorktree.path,
      });
      if (isBlocked(snapshot) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot?.commit ?? '')) {
        return { ok: false, writerResult: 'snapshot_failed' };
      }
      const revision = await stage(label('revision identity'), () =>
        revisionIdentity(laneWorktree, snapshot.commit));
      if (revision?.ok !== true || revision.commit !== snapshot.commit ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision.tree ?? '')) {
        return { ok: false, writerResult: 'seal_failed' };
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
          delta.entries.some((entry, index) => index > 0 && Buffer.compare(
            Buffer.from(delta.entries[index - 1].path, 'utf8'),
            Buffer.from(entry.path, 'utf8'),
          ) >= 0)) return { ok: false, writerResult: 'seal_failed' };
      const patch = await stage(label('candidate patch collection'), () =>
        collectPatchAtRevision(laneWorktree, { from: baseline.commit, to: revision.commit }), {
        mayTouchWorktree: true,
        worktreePath: laneWorktree.path,
      });
      progress('patch', ordinal, identity('worker', attemptId));
      const deltaPaths = delta.entries.map((entry) => entry.path);
      if (isBlocked(patch) || patch?.ok !== true || !Buffer.isBuffer(patch.patch) ||
          patch.sha256 !== qualityHash(patch.patch) || patch.empty !== (patch.patch.length === 0) ||
          !Array.isArray(patch.files) || patch.files.length !== deltaPaths.length ||
          patch.files.some((path, index) => path !== deltaPaths[index])) {
        return { ok: false, writerResult: 'seal_failed' };
      }
      const patchSha256 = qualityHash(patch.patch);
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
      }));
      progress('scope', Number(attemptId.slice(-3)), identity('worker', attemptId));
      if (isBlocked(scope) || !Array.isArray(ignored)) {
        return { evidence: [], cleanup: [], operationalFailure: { code: 'evidence_authority_mismatch' } };
      }
      if (scope.flagged === true) {
        return {
          tests: { execution: 'not_run', outcome: 'unknown', stability: 'unknown', complete: false, trusted: false, failureFingerprints: [] },
          regressionProof: { required: proofRequirement.required, status: proofRequirement.required ? 'unavailable' : 'not_applicable', repairable: false, evidenceIds: [], witnessIds: [], reasonCodes: ['policy_failure'] },
          evidence: [], cleanup: [], operationalFailure: null,
          scope: { flagged: true, reasonCount: scope.reasons?.length ?? 0, omittedReasonCount: scope.omitted ?? 0, changedFileCount: stored.delta.entries.length },
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
        const policyReasons = new Set([
          'test_definition_tampering', 'unsafe_test_path', 'ignored_test_path',
          'invalid_delta_path', 'duplicate_delta_path', 'invalid_ignored_path', 'invalid_unsafe_path',
        ]);
        const candidatePolicyFailure = Array.isArray(testDelta.reasonCodes) &&
          testDelta.reasonCodes.some((reason) => policyReasons.has(reason));
        if (!candidatePolicyFailure) {
          return { evidence: [], cleanup: [], operationalFailure: { code: 'evidence_authority_mismatch' } };
        }
        return {
          tests: { execution: 'not_run', outcome: 'unknown', stability: 'unknown', complete: false, trusted: false, failureFingerprints: [] },
          regressionProof: { required: proofRequirement.required, status: proofRequirement.required ? 'unavailable' : 'not_applicable', repairable: false, evidenceIds: [], witnessIds: [], reasonCodes: ['policy_failure'] },
          evidence: [], cleanup: [], operationalFailure: null,
          scope: { flagged: true, reasonCount: testDelta.reasonCodes.length, omittedReasonCount: 0, changedFileCount: stored.delta.entries.length },
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
          const onAbort = () => poisonArtifactStore('evidence_store_authority_lost', { authorityLost: true, laneId });
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
              bytes: recordBytes.length, sha256: qualityHash(recordBytes),
            });
            const accepted = acceptWriterResult(settlement);
            const result = accepted ? settlement.result : settlement.kind === 'success'
              ? unknownArtifactSettlement() : settlement.result;
            if (settlement.kind === 'success' && !accepted) poisonArtifactStore('artifact_store_authority_lost', {
              laneId, authorityLost: true,
            });
            if (settlement.kind === 'unknown') poisonArtifactStore('artifact_store_authority_lost', {
              laneId, authorityLost: true,
            });
            const authorityLost = artifactAuthorityLost(result);
            if (authorityLost) poisonArtifactStore(
              preparation.candidateCount === 1 ? 'artifact_store_authority_lost' : result.error, {
                laneId, authorityLost: true, deadlineLost: result?.hardStopped === true,
              },
            );
            else if (preparation.candidateCount === 2 && isBlocked(result)) {
              poisonArtifactStore('evidence_persistence_failed', { laneId });
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
            poisonArtifactStore('artifact_store_authority_lost', { authorityLost: true, laneId });
            return { blocked: true, error: 'artifact_store_authority_lost' };
          }).finally(() => authority?.signal?.removeEventListener?.('abort', onAbort));
        },
        handoffEvidenceCleanup: async ({ path }) =>
          handoffWorktree(path, label('producer evidence worktree handoff')),
        runnerDeps: deps.testRunnerDeps,
      }), { mayTouchWorktree: true, worktreePath: laneWorktree.path });
      if (evidence?.hardStopped === true) poisonArtifactStore('evidence_controller_authority_lost', {
        authorityLost: true, deadlineLost: true, laneId,
      });
      // S1 신고의 두 번째 관측 지점. `runFrozenTests` 래퍼가 정확한 신호이지만 증거 러너를 통째로
      // 갈아끼우는 경로에서는 그 래퍼가 안 불린다. 분류값이 **모호하지 않게** 실행을 말할 때도
      // 신고한다 — `aborted` 는 스폰 전/후를 구분 못 하므로 여기 넣지 않는다.
      if (RAN_WITH_USER_PRIVILEGE_EXECUTIONS.has(evidence?.tests?.execution)) {
        privateFacts.userPrivilegeObserved = true;
      }
      evidenceByAttempt.set(attemptId, qualityClone(evidence?.evidence ?? []));
      return {
        ...evidence,
        scope: { flagged: false, reasonCount: 0, omittedReasonCount: 0, changedFileCount: stored.delta.entries.length },
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
        return { operationalFailure: true, callStarted: error?.preBoundary !== true, raw: null, usage: { promptTokens: null, evalTokens: null }, touchedSources: [], mutationCheck: { clean: false } };
      }
      if (qualityProviderFailure(result) || result?.hardStopped === true || result?.truncated === true ||
          result?.doneReason === 'timeout' || result?.doneReason === 'aborted') {
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
        poisonArtifactStore('artifact_store_authority_lost', { authorityLost: true, laneId });
        return { blocked: true, error: 'artifact_store_authority_lost' };
      });
      const settlement = classifyWriterResult(rawResult, {
        kind: 'attempt', candidateId: laneId,
        path: join(artifactPaths.runDir, 'attempts', `${laneId}-${String(record.ordinal).padStart(3, '0')}.json`),
        bytes: recordBytes.length, sha256: qualityHash(recordBytes),
      });
      const accepted = acceptWriterResult(settlement);
      const result = accepted ? settlement.result : settlement.kind === 'success'
        ? unknownArtifactSettlement() : settlement.result;
      if (settlement.kind === 'success' && !accepted) poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId,
      });
      if (settlement.kind === 'unknown') poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId,
      });
      if (artifactAuthorityLost(result)) poisonArtifactStore(
        preparation.candidateCount === 1 ? 'artifact_store_authority_lost' : result?.error ?? 'artifact_store_authority_lost', {
          authorityLost: true, deadlineLost: result?.hardStopped === true, laneId,
        },
      );
      else if (preparation.candidateCount === 2 && isBlocked(result)) poisonArtifactStore('attempt_artifact_failed', { laneId });
      setLatestManifestRef(result?.manifestRef);
      if (!isBlocked(result) && typeof result?.ref?.path === 'string') {
        attemptArtifactRefs.set(record.attemptId, result.ref.path);
      }
      return result;
    },
    persistCandidatePatch: async ({ sourceAttemptId, sealed }) => {
      const bytes = privatePatches.get(sourceAttemptId);
      if (!Buffer.isBuffer(bytes) || qualityHash(bytes) !== sealed.patchSha256) return { blocked: true };
      if (isStoreAuthorityLost()) return poisonedArtifactResult();
      const rawWritten = await recoveryStage(label('candidate artifact'), () =>
        writeCandidate(artifactStore, { laneId, sourceAttemptId, patch: bytes })).catch(() => {
        poisonArtifactStore('artifact_store_authority_lost', { authorityLost: true, laneId });
        return { blocked: true, error: 'artifact_store_authority_lost' };
      });
      const settlement = classifyWriterResult(rawWritten, {
        kind: 'candidate', candidateId: laneId, path: artifactPaths.candidatePaths[laneId],
        bytes: bytes.length, sha256: qualityHash(bytes),
      });
      const accepted = acceptWriterResult(settlement);
      const written = accepted ? settlement.result : settlement.kind === 'success'
        ? unknownArtifactSettlement() : settlement.result;
      if (settlement.kind === 'success' && !accepted) poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId,
      });
      if (settlement.kind === 'unknown') poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId,
      });
      if (artifactAuthorityLost(written)) poisonArtifactStore(
        preparation.candidateCount === 1 ? 'artifact_store_authority_lost' : written?.error ?? 'artifact_store_authority_lost', {
          authorityLost: true, deadlineLost: written?.hardStopped === true, laneId,
        },
      );
      else if (preparation.candidateCount === 2 && isBlocked(written)) poisonArtifactStore('candidate_artifact_failed', { laneId });
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
              deltaEntries: qualityClone(delta.entries),
              persistedEvidence: qualityClone(evidence),
              finalLedger,
            },
          });
          if (!Array.isArray(views) || views.length !== 2 || views.some((view) => view === null)) return null;
          privateFacts.judgeViews = qualityFreeze([...views]);
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

/**
 * Freeze what this Run actually chose, and whether that choice is attributable.
 *
 * ★ Only the coordinator can answer "was this a real choice?".  A terminal
 *   candidate summary shows the binding that ran but not why: it cannot tell a
 *   caller's role pin from a bandit draw, cannot see that `single` was never an
 *   offered arm, and cannot know the registry order the placement arm mapped
 *   onto.  `learn/policy-v2.mjs` therefore never reconstructs this — it only
 *   narrows what we assert here with facts it can check itself.
 *
 * ★ `arm` is the arm that **ran**, not the arm that was sampled.  c2 runs both
 *   placements mirrored and always cross-verifies, so its mix arm is `mix` even
 *   when the bandit had sampled `single` and the coordinator ignored it.
 *   Recording the sampled value would reward an arm no provider ever executed.
 */
/**
 * Did the tier arms actually name different runs?
 *
 * ★★ With no `settings.ini` — the out-of-box state — `resolveTier` returns the same
 *   `{ model: null, effort: null }` for **every** arm, so both arms spawn the identical CLI at
 *   identical effort.  The arm is then a label with nothing behind it, and rewarding it writes an
 *   observation about a distinction that never existed.  This file already refuses that three times
 *   over (`assignRoles` for `single` placement, §14.2 for c2 placement, `single_arm_not_offered`
 *   for mix); `learn/policy-v2.mjs` states the rule outright — what was never a choice stays out of
 *   both maps.  Tier was simply the axis nobody applied it to.
 *
 * ★ One configured tier is enough to make the axis real: `strong` resolves to that model while
 *   `fast` stays the CLI's own default.  So this asks whether the arms **differ**, not whether the
 *   user configured all of them.
 *
 * ★ Why it matters later rather than now: while the arms are identical every draw is free.  The
 *   counterfeit observations only bite once the owner runs `orch_config`, and design §7.6's decay
 *   was never built, so nothing washes them out.
 */
function tierArmsDistinguishable(settings, participants) {
  const vendors = [...new Set(participants.filter((provider) => provider != null).map((provider) => provider.id))];
  return vendors.some((vendorId) => {
    const resolved = AXES.tier.arms.map((arm) => {
      const value = resolveTier(settings, vendorId, arm);
      return JSON.stringify([value?.model ?? null, value?.effort ?? null]);
    });
    return resolved.some((value) => value !== resolved[0]);
  });
}

function freezeEffectiveChoices({ candidateCount, providers, decisions, tier, writerProvider, verifierProvider, runOptions, settings }) {
  // c2 refuses placement but still rewards tier, so the no-op guard belongs on both branches.
  const tierReal = tierArmsDistinguishable(settings, [writerProvider, verifierProvider]);
  if (candidateCount === 2) {
    return qualityFreeze({
      // Two mirrored lanes are exactly the cross-verified mix; §14.2 refuses
      // placement because both arms ran and neither produced the result alone.
      mix: { arm: 'mix', identifiable: true, reason: 'mirrored_cross_verification' },
      placement: { arm: null, identifiable: false, reason: 'mirrored_two_lane_placement' },
      tier: {
        arm: tier,
        identifiable: tierReal,
        reason: tierReal ? 'actual_run_tier' : 'tier_not_distinguishable',
      },
    });
  }
  const rolePinned = runOptions.worker != null || runOptions.verifier != null;
  const expected = assignRoles(providers, decisions);
  // "The actual binding equals the recorded arm" is checked against the same
  // mapping the Run used, not re-derived from provider ids by hand.
  const bindingMatchesArm = providers.length >= 2 &&
    writerProvider.id === expected.worker.id && verifierProvider.id === expected.verifier.id;
  const actualMixArm = writerProvider.id === verifierProvider.id ? 'single' : 'mix';
  const singleWasOffered = runOptions.allowSingle === true;
  return qualityFreeze({
    mix: {
      arm: actualMixArm,
      identifiable: !rolePinned && singleWasOffered && bindingMatchesArm && actualMixArm === decisions.mix,
      reason: rolePinned ? 'role_pin'
        : !singleWasOffered ? 'single_arm_not_offered'
        : !bindingMatchesArm ? 'provider_shortage'
        : actualMixArm !== decisions.mix ? 'arm_not_executed'
        : 'actual_single_lane_binding',
    },
    placement: {
      arm: decisions.placement,
      identifiable: !rolePinned && bindingMatchesArm,
      reason: rolePinned ? 'role_pin' : bindingMatchesArm ? 'actual_single_lane_binding' : 'provider_shortage',
    },
    tier: {
      arm: tier,
      identifiable: !rolePinned && tierReal,
      reason: rolePinned ? 'role_pin' : tierReal ? 'actual_run_tier' : 'tier_not_distinguishable',
    },
  });
}

/**
 * The single c1/c2 learning seam: exactly one WAL transaction per Run.
 *
 * ★ Called after selection and the winner alias attempt are durable, and
 *   **before cleanup**.  Cleanup can only remove a worktree the Run no longer
 *   needs; it cannot make a verified patch unverified, so it must never change
 *   the grade (plan Task 12: a later cleanup failure preserves the semantic
 *   status and adds only a notice).  Committing first also means a crash during
 *   cleanup keeps the learning we already earned.
 *
 * ★ Every path that reaches durable selection commits exactly once, including
 *   the alias failure — that Run is graded `null` by the neutralizing stop
 *   reason but still deserves a row, otherwise its `run_id` names nothing a
 *   person could correct later.  Paths that fail *before* durable selection
 *   journal nothing at all.
 *
 * Learning failure stays a notice; it never changes the Run's envelope.
 */
async function commitRunLearning(input) {
  const {
    deps, stage, stateRoot, runId, taskClass, decisions, candidateCount,
    stopReason, selection, candidates, effectiveChoices, attemptRefs, artifactRefs,
  } = input;
  // The reducer consumes the terminal summaries themselves — it reads only the
  // fields it whitelists — but the journal below stores a *bounded* selection.
  // A full `Selection` carries judge rationale, and provider prose must never
  // reach durable learning state.
  const learningInput = qualityFreeze({
    policyVersion: 2,
    candidateCount,
    selection,
    candidates,
    stopReason,
    effectiveChoices,
  });
  try { deps.onRunLearningInput?.(learningInput); } catch { /* observation only */ }
  const outcome = computeRunLearningOutcome(learningInput);
  const journalSelection = { outcome: selection.outcome, selectedCandidateId: selection.selectedCandidateId };
  const appliedAxes = Object.keys(outcome.appliedChoices);
  const rewardableAxes = Object.keys(outcome.rewardableChoices);
  const deltas = gradeToDeltas(outcome.grade);
  // One axis, one cell, one delta — the WAL refuses a repeated cellKey, so a
  // double-counted Run cannot reach the posterior even by accident.
  const updates = deltas === null ? [] : appliedAxes.map((axis) => ({
    cellKey: cellKeyOf(taskClass, axis), arm: outcome.appliedChoices[axis], ...deltas,
  }));
  const attempted = updates.length > 0;
  const stored = await stage('학습 트랜잭션 기록', () =>
    (deps.commitLearningMutation ?? defaultCommitLearningMutation)(stateRoot, {
      updates,
      journal: {
        runId,
        taskClass,
        decisions,
        outcome: { grade: outcome.grade, stopReason },
        appliedGrade: attempted ? outcome.grade : null,
        appliedAxes: attempted ? appliedAxes : [],
        rewardableAxes,
        policyVersion: 2,
        candidateCount,
        attemptRefs,
        artifactRefs,
        selection: journalSelection,
        effectiveChoices,
        appliedChoices: attempted ? outcome.appliedChoices : {},
        rewardableChoices: outcome.rewardableChoices,
      },
    }, deps.learningOperationOptions)).catch(() => null);
  // ★★ 무엇이 **실제로 반영됐는지**는 저장 결과가 정한다. `commitLearningMutation` 의 평범한
  //   실패는 던지는 것도 `blocked` 도 아닌 `{ ok: false, reason }` 이다(잠금 경합·못 읽는
  //   사후분포·WAL 실패). 그 모양을 성공으로 읽으면 사후분포에도 저널에도 한 글자가 안 들어간
  //   실행이 본문에 `applied.grade` 를 적어 내보내고, 사용자가 그 runId 로 정정하려 하면
  //   저널에서 찾지 못한다. `pending: true` 도 「아직 완료되지 않았다」이므로 같은 답이다.
  const durable = stored?.ok === true;
  return qualityFreeze({
    outcome,
    applied: attempted && durable,
    appliedAxes: attempted && durable ? appliedAxes : [],
    grade: attempted && durable ? outcome.grade : null,
    notices: durable ? [] : ['학습 기록을 완료하지 못했습니다.'],
  });
}

/**
 * Canonical artifact ref order: manifest, then each lane's candidate patch in
 * lane order, then the winner alias.  Fixing the order keeps two deterministic
 * Runs journalling byte-identical rows.
 */
function learningArtifactRefs({ manifestRef, candidates, winnerRef }) {
  const refs = [];
  if (manifestRef) refs.push(manifestRef);
  for (const candidate of candidates) {
    if (candidate.patch?.ref) refs.push(candidate.patch.ref);
  }
  if (winnerRef) refs.push(winnerRef);
  return refs;
}

/** Logical attempt IDs in lane order, then ordinal order. Never attempt bodies. */
const learningAttemptRefs = (candidates) =>
  candidates.flatMap((candidate) => candidate.attempts.map((attempt) => attempt.attemptId));

async function orchestrateFinalC1(context) {
  const preparation = await prepareRunNamespace(context, context.deps);
  if (preparation.ok !== true) return preparation.envelope;
  const {
    runId, stateRoot, deadlineAt, frozenTestPlan, baseline, laneWorktree, proofRequirement,
    plannerBinding, laneBinding, plan, artifactStore, testQueue, evidenceCache, usageAccumulator,
  } = preparation;
  const {
    taskClass, decisions, decisionSources, plannerProvider, writerProvider, verifierProvider,
    plannerNotices, callProvider, pathBudget, progress, effectiveChoices,
  } = PREPARATION_PRIVATE.get(preparation);
  const {
    options, deps, task, budget, deadline, effectiveWaitMs, now, stage, recoveryStage, onSpawn,
    killLiveChildren, isWorktreeEffectUnknown,
  } = context;
  const handoffWorktree = async (path, label = 'worktree handoff') => {
    const result = await recoveryStage(label, () =>
      (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: path })).catch(() => false);
    return result === true;
  };
  const sweepSummaries = preparation.sweepNotice === null ? [] : [preparation.sweepNotice.replace(/^retention /, '')];
  const writeAttempt = deps.writeAttemptArtifact ?? writeAttemptArtifact;
  const writeEvidence = deps.writeEvidenceArtifact ?? writeEvidenceArtifact;
  const writeCandidate = deps.writeCandidatePatch ?? writeCandidatePatch;
  const checkpointRaw = deps.checkpointManifest ?? checkpointManifest;
  let artifactStorePoison = null;
  let latestManifestRef = null;
  const poisonArtifactStore = (reason) => {
    if (artifactStorePoison === null) artifactStorePoison = reason;
  };
  const poisonedArtifactResult = () => ({ blocked: true, error: artifactStorePoison ?? 'artifact_store_authority_lost' });
  const checkpoint = async (store, event) => {
    if (artifactStorePoison !== null) return poisonedArtifactResult();
    const rawResult = await stage(`manifest ${event.type}`, () => checkpointRaw(store, event))
      .catch(() => ({ blocked: true, error: 'manifest_checkpoint_failed' }));
    const settlement = classifyArtifactSettlement(rawResult, {
      kind: 'checkpoint', authority: preparation.manifestAuthority,
    });
    const result = settlement.result;
    if (settlement.kind === 'success' && !acceptArtifactRevision(result, preparation.artifactRevisionAuthority)) {
      poisonArtifactStore('artifact_store_authority_lost');
      return unknownArtifactSettlement();
    }
    if (settlement.kind === 'unknown' || result?.hardStopped === true) poisonArtifactStore('artifact_store_authority_lost');
    else if (isBlocked(result)) poisonArtifactStore(result?.error ?? 'manifest_checkpoint_failed');
    if (result?.manifestRef) latestManifestRef = result.manifestRef;
    return result;
  };
  const artifactAuthority = {
    checkpoint,
    artifactStorePoison: () => artifactStorePoison,
    isStoreAuthorityLost: () => artifactStorePoison !== null,
    poisonedArtifactResult,
    poisonArtifactStore,
    handoffWorktree,
    setLatestManifestRef: (value) => { if (value) latestManifestRef = value; },
    writeAttempt,
    writeEvidence,
    writeCandidate,
  };
  const laneResult = await runPreparedLane({ preparation, laneIndex: 0, context, artifactAuthority });
  const candidate = laneResult.candidate;

  if (artifactStorePoison !== null) {
    await killLiveChildren();
    await handoffWorktree(laneWorktree.path, 'poisoned artifact worktree handoff');
    return artifactBlocked(runId, artifactStorePoison, laneWorktree.path);
  }

  if (deadline?.aborted !== true && (candidate.recovery !== null || ['allocation_checkpoint_failed', 'attempt_artifact_failed', 'candidate_artifact_failed', 'snapshot_failed', 'seal_failed'].includes(candidate.stopReason))) {
    await handoffWorktree(laneWorktree.path, 'candidate failure worktree handoff');
    return artifactBlocked(runId, candidate.stopReason, laneWorktree.path);
  }

  const candidateRef = candidateRefFromSummary(candidate);
  const expectedCandidatePath = pathBudget.paths?.candidatePaths?.['lane-a'];
  if (candidate.patch !== null && candidate.patch.ref?.path !== expectedCandidatePath) {
    await handoffWorktree(laneWorktree.path, 'candidate path worktree handoff');
    return artifactBlocked(runId, 'candidate_path_authority_mismatch', laneWorktree.path);
  }
  const candidateCheckpoint = await checkpoint(artifactStore, { eventId: 'candidate:lane-a:recorded', type: 'candidate_recorded', value: candidateRef });
  if (isBlocked(candidateCheckpoint)) {
    await handoffWorktree(laneWorktree.path, 'candidate checkpoint worktree handoff');
    if (deadline?.aborted === true || candidateCheckpoint?.hardStopped === true) {
      return failure({ status: 'deadline_exceeded', confidence: 'unverified', runId, stopReason: 'deadline_exceeded', error: `데드라인(${effectiveWaitMs}ms)이 지났습니다.`, recovery: laneWorktree.path });
    }
    return artifactBlocked(runId, 'candidate_manifest_failed', laneWorktree.path);
  }
  const issuesCheckpoint = await checkpoint(artifactStore, { eventId: 'issues:lane-a:recorded', type: 'issues_recorded', value: { candidateId: 'lane-a', openIssueIds: candidate.issues.openIds, openIssueCount: candidate.issues.count, limitExceeded: candidate.issues.limitExceeded } });
  if (isBlocked(issuesCheckpoint)) {
    await handoffWorktree(laneWorktree.path, 'issues checkpoint worktree handoff');
    return artifactBlocked(runId, 'candidate_manifest_failed', laneWorktree.path);
  }
  const selection = selectSingleCandidate(candidate);
  const usage = usageAccumulator.finalize();
  const usageCheckpoint = await checkpoint(artifactStore, { eventId: 'usage:run:final', type: 'usage_recorded', value: usage });
  if (isBlocked(usageCheckpoint)) {
    await handoffWorktree(laneWorktree.path, 'usage checkpoint worktree handoff');
    return artifactBlocked(runId, 'selection_manifest_failed', laneWorktree.path);
  }
  const selectionCheckpoint = await checkpoint(artifactStore, { eventId: 'selection:run:recorded', type: 'selection_recorded', value: selection });
  if (isBlocked(selectionCheckpoint)) {
    await handoffWorktree(laneWorktree.path, 'selection checkpoint worktree handoff');
    return artifactBlocked(runId, 'selection_manifest_failed', laneWorktree.path);
  }
  // Selection is durable from here on, so every remaining exit journals exactly
  // one row.  Nothing above this line may journal at all.
  const learn = (stopReason, winnerRef) => commitRunLearning({
    deps, stage, stateRoot, runId, taskClass, decisions, candidateCount: 1,
    stopReason, selection, candidates: [candidate], effectiveChoices,
    attemptRefs: learningAttemptRefs([candidate]),
    artifactRefs: learningArtifactRefs({ manifestRef: latestManifestRef, candidates: [candidate], winnerRef }),
  });
  let winner = null;
  if (selection.outcome === 'winner') {
    const rawWinner = await recoveryStage('winner alias', () =>
      (deps.writeWinnerAlias ?? writeWinnerAlias)(artifactStore, { candidateId: 'lane-a' }))
      .catch(() => ({ blocked: true }));
    const candidatePatchRef = candidate.patch?.ref;
    const settlement = classifyArtifactSettlement(rawWinner, {
      kind: 'writer',
      authority: {
        writer: {
          kind: 'winner', candidateId: 'lane-a', path: pathBudget.paths?.winnerAliasPath,
          bytes: candidatePatchRef?.bytes, sha256: candidatePatchRef?.sha256,
        },
        manifest: preparation.manifestAuthority,
      },
    });
    winner = settlement.kind === 'success' && !acceptArtifactRevision(settlement.result, preparation.artifactRevisionAuthority)
      ? unknownArtifactSettlement() : settlement.result;
    if (settlement.kind === 'success' && winner !== settlement.result) poisonArtifactStore('artifact_store_authority_lost');
    if (settlement.kind === 'unknown' || winner?.hardStopped === true) poisonArtifactStore('artifact_store_authority_lost');
    const winnerRef = winner?.ref;
    const expectedWinnerPath = pathBudget.paths?.winnerAliasPath;
    if (isBlocked(winner) || winner?.ok !== true || winnerRef?.kind !== 'winner' ||
        winnerRef?.candidateId !== 'lane-a' || winnerRef?.path !== expectedWinnerPath ||
        winnerRef.path === candidatePatchRef?.path || winnerRef?.sha256 !== candidatePatchRef?.sha256 ||
        winnerRef?.bytes !== candidatePatchRef?.bytes || !Number.isSafeInteger(winnerRef?.bytes) || winnerRef.bytes <= 0 ||
        !Number.isSafeInteger(winnerRef?.expiresAt) || winnerRef.expiresAt <= 0) {
      // Selection is already durable, so this Run owns a journal row even though
      // it returns blocked: `winner_alias_failed` grades it neutral, and the
      // refs we record are the last ones we actually proved.
      await learn('winner_alias_failed', null);
      await handoffWorktree(laneWorktree.path, 'winner failure worktree handoff');
      return artifactBlocked(runId, 'winner_alias_failed', laneWorktree.path);
    }
    if (winner?.manifestRef) latestManifestRef = winner.manifestRef;
  }

  const selected = selection.outcome === 'winner';
  // The learning row records the terminal stop as it stood when the grade was
  // decided.  The envelope re-reads the deadline after cleanup below, so a
  // deadline that fires during storage still surfaces to the caller without
  // retroactively rewriting what we learned.
  const learning = await learn(
    deadline?.aborted === true && !selected ? 'deadline_exceeded' : candidate.stopReason,
    winner?.ref ?? null,
  );
  let cleanup = { removed: false, unregistered: false, tracked: false };
  const cleanupNotices = [];
  const preserveAuthoring = candidate.terminalClass === 'blocked' || candidate.recovery !== null || isWorktreeEffectUnknown?.() === true;
  const childrenProven = await killLiveChildren();
  const removal = childrenProven === true && !preserveAuthoring
    ? snapshotRemovalResult(await stage('authoring cleanup', () =>
      (deps.removeWorktree ?? defaultRemoveWorktree)(laneWorktree)).catch(() => null))
    : UNPROVEN_REMOVAL;
  if (childrenProven === true && removal.ok === true && removal.removed === true && removal.unregistered === true) {
    cleanup = { removed: true, unregistered: true, tracked: false };
  } else {
    const physicalRemoved = removal.ok === true && removal.removed === true;
    const unregistered = removal.ok === true &&
      (removal.unregistered === true || removal.unregistered === false || removal.unregistered === null)
      ? removal.unregistered : false;
    const tracked = await recoveryStage('authoring cleanup handoff', () =>
      (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: laneWorktree.path })).catch(() => false);
    cleanup = { removed: physicalRemoved, unregistered, tracked: tracked === true };
    if (tracked !== true) cleanupNotices.push(`manual cleanup required: ${laneWorktree.path}`);
  }
  const cleanupValue = {
    kind: 'authoring', candidateId: 'lane-a', attemptId: null, path: laneWorktree.path,
    status: cleanup.removed === true && cleanup.unregistered === true ? 'removed' : 'reaper_pending',
    recoveryPath: cleanup.removed === true && cleanup.unregistered === true ? null : laneWorktree.path,
  };
  const logicalCleanupPath = `worktrees/${laneWorktree.worktreeId ?? runId}`;
  if (cleanup.removed === true && cleanup.unregistered === true || cleanup.tracked === true) {
    const cleanupEvent = await checkpoint(artifactStore, {
      eventId: `cleanup:authoring:lane-a:000:${qualityHash(Buffer.from(logicalCleanupPath, 'utf8')).slice(0, 12)}`,
      type: 'cleanup_recorded', value: cleanupValue,
    });
    if (isBlocked(cleanupEvent)) cleanupNotices.push('cleanup manifest pending');
  }
  const terminalDeadline = deadline?.aborted === true && !selected;
  const projectionStopReason = terminalDeadline ? 'deadline_exceeded' : candidate.stopReason;
  const issues = [contentIssue(candidate)];
  const omittedCounts = {
    issues: issues[0].resolvedOmittedCount,
    attempts: 0,
    evidence: laneResult.contentFacts.evidenceOmittedCount,
    files: 0,
    artifacts: 0,
  };
  const payload = {
    runId, stopReason: projectionStopReason,
    stepCount: candidate.attempts.length,
    ...(winner?.ref ? { patch: { path: winner.ref.path, bytes: winner.ref.bytes, empty: winner.ref.bytes === 0, files: candidate.patch?.files ?? [], ignoredPaths: [], gitlinks: [] } } : {}),
    scope: { flagged: candidate.scope.flagged, reasons: [], omitted: candidate.scope.omittedReasonCount ?? 0 },
    worktree: { transplanted: laneWorktree.transplanted, ignoredPaths: laneWorktree.ignoredPaths, sharedRules: laneWorktree.sharedRules, cleanup },
    blockers: candidate.terminalClass === 'blocked' ? [{ where: candidate.stopReason, error: candidate.stopReason }] : [],
    learning: { taskClass, decisions, sources: decisionSources, applied: { grade: learning.grade, axes: learning.appliedAxes } },
    plan: { provider: plannerProvider.id, content: '' },
    steps: selected ? candidate.attempts.map((attempt) => ({ step: attempt.ordinal, laneId: candidate.candidateId, attemptId: attempt.attemptId, retryOf: attempt.retryOf })) : [],
    verdict: selected ? contentVerdict(candidate) : null,
    issues,
    candidates: [contentCandidate(candidate)],
    attempts: laneResult.contentFacts.attempts,
    regressionProof: {
      status: candidate.regressionProof.status,
      selectedCandidateId: selected ? candidate.candidateId : null,
      evidenceRefs: laneResult.contentFacts.evidenceRefs,
      omittedEvidenceCount: laneResult.contentFacts.evidenceOmittedCount,
    },
    selection,
    artifacts: {
      manifestPath: latestManifestRef?.path ?? pathBudget.paths.manifestPath,
      expiresAt: latestManifestRef?.expiresAt ?? candidate.patch?.ref?.expiresAt ?? winner?.ref?.expiresAt ?? 0,
      candidatePaths: candidate.patch === null ? [] : [candidate.patch.ref.path],
      omittedCount: 0,
    },
    omittedCounts,
    aliasDurable: typeof winner?.ref?.path === 'string',
    fixedFloorInput: fixedFloorInput({
      runId, stopReason: projectionStopReason, candidateCount: 1, selection, pathBudget,
      candidates: [candidate], issues, omittedCounts,
    }),
  };
  const { content, contentFallback } = (deps.renderContentParts ?? renderContentParts)(qualityFreeze(payload));
  const notice = joinNotices([
    ...(sweepSummaries.length ? [`retention ${sweepSummaries.join(',')}`] : []),
    ...plannerNotices,
    ...(laneResult.userPrivilegeObserved === true ? [USER_PRIVILEGE_NOTE] : []),
    ...(cleanup.tracked ? [`워크트리 정리를 리퍼에 넘겼습니다: ${laneWorktree.path}`] : []),
    ...cleanupNotices,
    ...learning.notices,
  ]);
  if (terminalDeadline) {
    return failure({ status: 'deadline_exceeded', confidence: 'unverified', content, contentFallback, runId, stopReason: 'deadline_exceeded', error: `데드라인(${effectiveWaitMs}ms)이 지났습니다.`, recovery: candidate.recovery?.path ?? 'wait_ms를 늘려 다시 시도하세요.', ...(notice ? { notice } : {}) });
  }
  if (selected) {
    const independent = laneBinding.writer.providerId !== laneBinding.verifier.providerId;
    const cleanupRecovery = cleanup.removed === true && cleanup.unregistered === true
      ? null : laneWorktree.path;
    return success({ content, contentFallback, confidence: candidate.terminalClass === 'verified' && independent ? 'verified' : 'unverified', runId, stopReason: candidate.stopReason, ...(cleanupRecovery ? { recovery: cleanupRecovery } : {}), ...(notice ? { notice } : {}) });
  }
  return failure({ status: candidate.stopReason === 'deadline_exceeded' ? 'deadline_exceeded' : candidate.terminalClass === 'rejected' ? 'failed' : 'blocked', confidence: candidate.terminalClass === 'rejected' ? 'disputed' : 'unverified', content, contentFallback, runId, stopReason: candidate.stopReason, error: `품질 게이트를 완료하지 못했습니다: ${candidate.stopReason}`, recovery: candidate.recovery?.path ?? '새 runId로 다시 시도하세요.', ...(notice ? { notice } : {}) });
}

async function orchestrateFinalC2(context) {
  const preparation = await prepareRunNamespace(context, context.deps);
  if (preparation.ok !== true) return preparation.envelope;
  const {
    runId, stateRoot, deadlineAt, frozenTestPlan, baseline, laneWorktrees, proofRequirement,
    laneBindings, plan, artifactStore, testQueue, evidenceCache, usageAccumulator,
  } = preparation;
  const {
    taskClass, decisions, decisionSources, plannerProvider, laneProviders, judgeBindings, tier,
    plannerNotices, callProvider, pathBudget, progress, effectiveChoices,
  } = PREPARATION_PRIVATE.get(preparation);
  const {
    options, deps, task, budget, deadline, effectiveWaitMs, now, stage, recoveryStage,
    onSpawn, killLiveChildren, isWorktreeEffectUnknown,
  } = context;
  const laneIds = ['lane-a', 'lane-b'];
  const preparationNotices = [
    ...(preparation.sweepNotice === null ? [] : [preparation.sweepNotice]),
    ...plannerNotices,
  ];
  let judgePromptNonces;
  try {
    const nonceSource = typeof deps.judgeBlindNonce === 'function'
      ? deps.judgeBlindNonce
      : () => randomBytes(16).toString('hex');
    judgePromptNonces = [1, 2].map((judgeIndex) => {
      const value = nonceSource({ runId, judgeIndex });
      if (!/^[0-9a-f]{32}$/.test(value ?? '')) throw new Error('invalid_judge_blind_nonce');
      return value;
    });
    if (judgePromptNonces[0] === judgePromptNonces[1]) throw new Error('duplicate_judge_blind_nonce');
  } catch {
    const notices = [...preparationNotices];
    for (const worktree of laneWorktrees) {
      const childrenProven = await killLiveChildren(worktree.path);
      const removed = childrenProven
        ? snapshotRemovalResult(await recoveryStage('judge nonce preparation cleanup', () =>
          (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null))
        : UNPROVEN_REMOVAL;
      if (removed.ok !== true || removed.removed !== true || removed.unregistered !== true) {
        const tracked = await recoveryStage('judge nonce preparation handoff', () =>
          (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: worktree.path })).catch(() => false);
        notices.push(tracked === true
          ? `워크트리 정리를 리퍼에 넘겼습니다: ${worktree.path}`
          : `manual cleanup required: ${worktree.path}`);
      }
    }
    return artifactBlocked(runId, 'judge_nonce_preparation_failed', laneWorktrees.map((value) => value.path).join(', '), joinNotices(notices));
  }
  const checkpointRaw = deps.checkpointManifest ?? checkpointManifest;
  const writeAttempt = deps.writeAttemptArtifact ?? writeAttemptArtifact;
  const writeEvidence = deps.writeEvidenceArtifact ?? writeEvidenceArtifact;
  const writeCandidate = deps.writeCandidatePatch ?? writeCandidatePatch;
  let latestManifestRef = null;
  const runArtifactFailures = new Set();
  const storeAuthorityFailures = new Set();
  const affectedArtifactLanes = new Set();
  let storeAuthorityLost = false;
  let deadlineAuthorityLost = false;
  const poisonArtifactStore = (reason, { authorityLost = false, deadlineLost = false, laneId = null } = {}) => {
    const normalized = typeof reason === 'string' && reason !== '' ? reason : 'artifact_store_authority_lost';
    runArtifactFailures.add(normalized);
    if (laneId === 'lane-a' || laneId === 'lane-b') affectedArtifactLanes.add(laneId);
    if (authorityLost || normalized.includes('authority_lost')) {
      storeAuthorityLost = true;
      storeAuthorityFailures.add(normalized);
    }
    if (deadlineLost) deadlineAuthorityLost = true;
  };
  const artifactStorePoison = () => [...runArtifactFailures].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))[0] ?? null;
  const storeAuthorityPoison = () => [...storeAuthorityFailures].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))[0] ?? null;
  const terminalArtifactPoison = () => storeAuthorityLost
    ? storeAuthorityPoison() ?? 'artifact_store_authority_lost'
    : artifactStorePoison();
  const poisonedArtifactResult = () => ({ blocked: true, error: terminalArtifactPoison() ?? 'artifact_store_authority_lost' });
  const checkpoint = async (store, event) => {
    if (storeAuthorityLost) return poisonedArtifactResult();
    const rawResult = await stage(`manifest ${event.type}`, () => checkpointRaw(store, event))
      .catch(() => ({ blocked: true, error: 'manifest_checkpoint_failed' }));
    const settlement = classifyArtifactSettlement(rawResult, {
      kind: 'checkpoint', authority: preparation.manifestAuthority,
    });
    const result = settlement.result;
    if (settlement.kind === 'success' && !acceptArtifactRevision(result, preparation.artifactRevisionAuthority)) {
      poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId: event.laneId ?? event.value?.candidateId ?? null,
      });
      return unknownArtifactSettlement();
    }
    if (settlement.kind === 'unknown') poisonArtifactStore('artifact_store_authority_lost', {
      authorityLost: true, laneId: event.laneId ?? event.value?.candidateId ?? null,
    });
    if (artifactAuthorityLost(result)) poisonArtifactStore(
      result?.error ?? 'artifact_store_authority_lost', {
        authorityLost: true,
        deadlineLost: result?.hardStopped === true,
        laneId: event.laneId ?? event.value?.candidateId ?? null,
      },
    );
    else if (isBlocked(result) && event.type !== 'candidate_recorded' && event.type !== 'issues_recorded') {
      poisonArtifactStore(result?.error ?? 'manifest_checkpoint_failed', {
        laneId: event.laneId ?? event.value?.candidateId ?? null,
      });
    }
    if (result?.manifestRef) latestManifestRef = result.manifestRef;
    return result;
  };
  const handoffWorktree = async (path, label = 'worktree handoff') => {
    const result = await recoveryStage(label, () =>
      (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: path })).catch(() => false);
    return result === true;
  };

  const artifactAuthority = {
    checkpoint,
    artifactStorePoison,
    isStoreAuthorityLost: () => storeAuthorityLost,
    poisonedArtifactResult,
    poisonArtifactStore,
    handoffWorktree,
    getLatestManifestRef: () => latestManifestRef,
    setLatestManifestRef: (value) => { if (value) latestManifestRef = value; },
    writeAttempt,
    writeEvidence,
    writeCandidate,
  };

  const runLane = async (laneIndex) => {
    const laneId = laneIds[laneIndex];
    const laneResult = await runPreparedLane({
      preparation,
      laneIndex,
      context,
      artifactAuthority,
      judgeViewProjector: ({ candidate: provisional, privateFacts }) => judgePromptNonces.map((blindNonce) =>
        createJudgeView({ candidate: provisional, blindNonce, privateFacts })),
    });
    const candidate = laneResult.candidate;
    let finalFailure = null;
    if (!storeAuthorityLost && !affectedArtifactLanes.has(laneId)) {
      const expectedCandidatePath = pathBudget.paths?.candidatePaths?.[laneId];
      if (candidate.patch !== null && candidate.patch.ref?.path !== expectedCandidatePath) {
        finalFailure = qualityFreeze({
          laneId,
          phase: 'candidate_path',
          reason: 'candidate_path_authority_mismatch',
        });
      } else {
        const candidateCheckpoint = await checkpoint(artifactStore, {
          eventId: `candidate:${laneId}:recorded`,
          type: 'candidate_recorded',
          value: candidateRefFromSummary(candidate),
        });
        const issuesCheckpoint = isBlocked(candidateCheckpoint) ? candidateCheckpoint : await checkpoint(artifactStore, {
          eventId: `issues:${laneId}:recorded`,
          type: 'issues_recorded',
          value: {
            candidateId: laneId,
            openIssueIds: candidate.issues.openIds,
            openIssueCount: candidate.issues.count,
            limitExceeded: candidate.issues.limitExceeded,
          },
        });
        if (isBlocked(candidateCheckpoint) || isBlocked(issuesCheckpoint)) {
          finalFailure = qualityFreeze({
            laneId,
            phase: isBlocked(candidateCheckpoint) ? 'candidate' : 'issues',
            reason: 'candidate_manifest_failed',
          });
        }
      }
    }
    return qualityFreeze({
      candidate,
      judgeViews: laneResult.judgeViews,
      contentFacts: laneResult.contentFacts,
      userPrivilegeObserved: laneResult.userPrivilegeObserved === true,
      finalFailure,
    });
  };

  const laneResults = await Promise.all([0, 1].map((index) => runLane(index)));
  const candidates = laneResults.map(({ candidate }) => candidate);
  const candidateRefs = candidates.map(candidateRefFromSummary);
  const alternateCandidates = laneResults.map(({ candidate, judgeViews }) => qualityFreeze({
    ...qualityClone(candidate),
    judgeView: Array.isArray(judgeViews) ? judgeViews[1] : null,
  }));
  judgePromptNonces.fill(null);
  const cleanupArtifactFailure = async (error, priorNotices = []) => {
    const recoveryPaths = [];
    const cleanupNotices = [...preparationNotices, ...priorNotices];
    for (let index = 0; index < laneWorktrees.length; index += 1) {
      const laneId = laneIds[index];
      const worktree = laneWorktrees[index];
      const childrenProven = await killLiveChildren(worktree.path);
      const preserve = storeAuthorityLost || affectedArtifactLanes.has(laneId) ||
        candidates[index].recovery !== null || isWorktreeEffectUnknown?.(worktree.path) === true;
      let removed = null;
      if (childrenProven && !preserve) {
        removed = snapshotRemovalResult(await recoveryStage(`${laneId} artifact failure peer cleanup`, () =>
          (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null));
      }
      removed ??= UNPROVEN_REMOVAL;
      if (removed.ok !== true || removed.removed !== true || removed.unregistered !== true) {
        const tracked = await handoffWorktree(worktree.path, `${laneId} artifact failure worktree handoff`);
        recoveryPaths.push(worktree.path);
        cleanupNotices.push(tracked
          ? `워크트리 정리를 리퍼에 넘겼습니다: ${worktree.path}`
          : `manual cleanup required: ${worktree.path}`);
      }
    }
    const recovery = recoveryPaths.join(', ') || GENERIC_RECOVERY;
    const notice = joinNotices(cleanupNotices);
    return deadlineAuthorityLost
      ? failure({
          status: 'deadline_exceeded', confidence: 'unverified', runId,
          stopReason: 'deadline_exceeded', error: `데드라인(${effectiveWaitMs}ms)이 지났습니다.`,
          recovery, ...(notice ? { notice } : {}),
        })
      : artifactBlocked(runId, error, recovery, notice);
  };
  if (storeAuthorityLost) return cleanupArtifactFailure(terminalArtifactPoison() ?? 'artifact_store_authority_lost');
  const candidateFinalFailures = laneResults.flatMap(({ finalFailure }) => finalFailure === null ? [] : [finalFailure]);
  for (const failure of candidateFinalFailures) affectedArtifactLanes.add(failure.laneId);
  const preFinalArtifactPoison = artifactStorePoison();
  if (preFinalArtifactPoison !== null) return cleanupArtifactFailure(terminalArtifactPoison() ?? preFinalArtifactPoison);
  if (candidateFinalFailures.length > 0) {
    candidateFinalFailures.sort((left, right) => {
      const lane = Buffer.compare(Buffer.from(left.laneId, 'utf8'), Buffer.from(right.laneId, 'utf8'));
      return lane !== 0 ? lane : Buffer.compare(Buffer.from(left.phase, 'utf8'), Buffer.from(right.phase, 'utf8'));
    });
    return cleanupArtifactFailure(storeAuthorityLost ? terminalArtifactPoison() : candidateFinalFailures[0].reason);
  }

  let selection = selectCandidates({ candidates, judgeDecisions: [] });
  let judgeNotices = [];
  let judgeFailure = null;
  if (selection.objectiveComparison?.result === 'tie') {
    const pairs = [
      makeBlindPair(candidates[0], candidates[1], { reverse: false }),
      makeBlindPair(alternateCandidates[0], alternateCandidates[1], { reverse: true }),
    ];
    if (pairs.some((pair) => pair === null)) {
      judgeFailure = 'judge_view_unavailable';
      const judgeDecisions = [1, 2].map((judgeIndex) => qualityFreeze({
        status: 'invalid',
        judgeIndex,
        corrected: false,
        code: 'judge_view_unavailable',
      }));
      selection = selectCandidates({ candidates, judgeDecisions });
    } else {
      const judgesRoot = join(stateRoot, 'judges');
      const runJudge = async (judgeIndex) => {
        const pair = pairs[judgeIndex - 1];
        const provider = laneProviders[judgeIndex - 1].writer;
        const binding = judgeBindings[judgeIndex - 1];
        let scratch = null;
        let identity = null;
        let localFailure = null;
        const localNotices = [];
        let decision;
        try {
          await mkdir(judgesRoot, { recursive: true });
          const expectedJudgesRoot = resolve(stateRoot, 'judges');
          const canonicalJudgesRoot = await canonical(judgesRoot);
          if (canonicalJudgesRoot === null || relative(canonicalJudgesRoot, expectedJudgesRoot) !== '' ||
              relative(canonicalJudgesRoot, stateRoot) === '' || !pathContains(stateRoot, canonicalJudgesRoot)) {
            throw new Error('judge_scratch_root_untrusted');
          }
          scratch = await mkdtemp(join(judgesRoot, `${runId}-judge-${judgeIndex}-`));
          const returnedScratch = resolve(scratch);
          const [actual, stat, root] = await Promise.all([
            canonical(scratch), lstat(scratch, { bigint: true }), canonical(judgesRoot),
          ]);
          if (actual === null || root === null || relative(root, expectedJudgesRoot) !== '' ||
              relative(actual, returnedScratch) !== '' || !pathContains(root, actual) || actual === root ||
              stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('judge_scratch_identity_unavailable');
          scratch = actual;
          identity = { path: actual, dev: stat.dev, ino: stat.ino };
          let parsed;
          let corrected = false;
          try {
            const result = await callProvider({
              provider, binding, kind: 'judge', laneId: null, attemptId: null, judgeIndex,
              instruction: judgeInstruction(pair.promptInput), workspace: scratch, tools: undefined, nonWorktree: true,
            });
            if (deadline?.aborted === true || now() >= deadlineAt) {
              localFailure = 'deadline_exceeded';
              parsed = { ok: false, kind: 'invalid', code: localFailure };
            } else if (qualityProviderFailure(result) || result?.hardStopped === true || result?.truncated === true ||
                result?.doneReason === 'timeout' || result?.doneReason === 'aborted') {
              localFailure = result?.hardStopped === true || deadline?.aborted === true
                ? 'deadline_exceeded'
                : 'judge_provider_failure';
              parsed = { ok: false, kind: 'invalid', code: localFailure };
            } else {
              parsed = parseJudgeDecision(result?.content);
              if (parsed.ok !== true && deadline?.aborted !== true && now() < deadlineAt) {
                corrected = true;
                const correction = await callProvider({
                  provider, binding, kind: 'judge_format', laneId: null, attemptId: null, judgeIndex,
                  instruction: judgeInstruction(pair.promptInput, { formatOnly: true }), workspace: scratch,
                  tools: undefined, nonWorktree: true,
                });
                if (deadline?.aborted === true || now() >= deadlineAt) {
                  localFailure = 'deadline_exceeded';
                  parsed = { ok: false, kind: 'invalid', code: localFailure };
                } else if (qualityProviderFailure(correction) || correction?.hardStopped === true || correction?.truncated === true ||
                    correction?.doneReason === 'timeout' || correction?.doneReason === 'aborted') {
                  localFailure = correction?.hardStopped === true || deadline?.aborted === true
                    ? 'deadline_exceeded'
                    : 'judge_provider_failure';
                  parsed = { ok: false, kind: 'invalid', code: localFailure };
                } else {
                  parsed = parseJudgeDecision(correction?.content);
                }
              } else if (parsed.ok !== true && (deadline?.aborted === true || now() >= deadlineAt)) {
                localFailure = 'deadline_exceeded';
                parsed = { ok: false, kind: 'invalid', code: localFailure };
              }
            }
          } catch (error) {
            localFailure = deadline?.aborted === true || now() >= deadlineAt
              ? 'deadline_exceeded'
              : 'judge_provider_failure';
            parsed = { ok: false, kind: 'invalid', code: localFailure };
          }
          decision = remapJudgeDecision(parsed, pair.mapping, { judgeIndex, corrected }) ??
            qualityFreeze({ status: 'invalid', judgeIndex, corrected, code: 'invalid_format' });
        } catch {
          localFailure = deadline?.aborted === true || now() >= deadlineAt ? 'deadline_exceeded' : 'judge_scratch_failed';
          decision = qualityFreeze({ status: 'invalid', judgeIndex, corrected: false, code: localFailure });
        } finally {
          if (scratch !== null && identity !== null) {
            let removed = false;
            const childrenProven = await killLiveChildren(identity.path);
            if (childrenProven) {
              try {
                const [actual, stat] = await Promise.all([canonical(scratch), lstat(scratch, { bigint: true })]);
                if (actual === identity.path && stat.dev === identity.dev && stat.ino === identity.ino &&
                    stat.isDirectory() && !stat.isSymbolicLink()) {
                  const result = await recoveryStage(`judge ${judgeIndex} scratch cleanup`, () =>
                    (deps.removeJudgeScratch ?? rm)(identity.path, { recursive: true, force: false }));
                  if (result?.hardStopped !== true) {
                    removed = await lstat(identity.path).then(() => false, (error) => error?.code === 'ENOENT');
                  }
                }
              } catch (error) {
                removed = error?.code === 'ENOENT';
              }
            }
            if (!removed) localNotices.push(`manual cleanup required: ${identity.path}`);
          } else if (scratch !== null) {
            localNotices.push(`manual cleanup required: ${scratch}`);
          }
        }
        return qualityFreeze({ decision, failure: localFailure, notices: localNotices });
      };
      const judgeOutcomes = await Promise.all([runJudge(1), runJudge(2)]);
      judgeNotices = judgeOutcomes.flatMap((outcome) => outcome.notices);
      const judgeDecisions = judgeOutcomes.map((outcome) => outcome.decision);
      selection = selectCandidates({ candidates, judgeDecisions });
      judgeFailure = judgeOutcomes.some((outcome) => outcome.failure === 'deadline_exceeded')
        ? 'deadline_exceeded'
        : judgeOutcomes.find((outcome) => outcome.failure !== null)?.failure ?? null;
      if (selection.outcome === 'none' && judgeFailure === null) judgeFailure = 'judge_invalid';
    }
  }

  const usage = usageAccumulator.finalize();
  const usageCheckpoint = await checkpoint(artifactStore, {
    eventId: 'usage:run:final', type: 'usage_recorded', value: usage,
  });
  const selectionCheckpoint = isBlocked(usageCheckpoint) ? usageCheckpoint : await checkpoint(artifactStore, {
    eventId: 'selection:run:recorded', type: 'selection_recorded', value: selection,
  });
  if (isBlocked(usageCheckpoint) || isBlocked(selectionCheckpoint)) {
    for (const laneId of laneIds) affectedArtifactLanes.add(laneId);
    return cleanupArtifactFailure('selection_manifest_failed', judgeNotices);
  }

  const selectedIndex = selection.selectedCandidateId === null ? -1 : laneIds.indexOf(selection.selectedCandidateId);
  const selectedCandidate = selectedIndex < 0 ? null : candidates[selectedIndex];
  let terminalDeadline = judgeFailure === 'deadline_exceeded' ||
    selectedCandidate === null && (deadline?.aborted === true || candidates.some((candidate) => candidate.stopReason === 'deadline_exceeded'));
  let winner = null;
  let aliasFailure = false;
  if (selectedCandidate !== null && !terminalDeadline) {
    const rawWinner = await recoveryStage('winner alias', () =>
      (deps.writeWinnerAlias ?? writeWinnerAlias)(artifactStore, { candidateId: selectedCandidate.candidateId }))
      .catch(() => {
        poisonArtifactStore('artifact_store_authority_lost', { authorityLost: true, laneId: selectedCandidate.candidateId });
        return { blocked: true, error: 'artifact_store_authority_lost' };
      });
    const candidatePatchRef = selectedCandidate.patch?.ref;
    const settlement = classifyArtifactSettlement(rawWinner, {
      kind: 'writer',
      authority: {
        writer: {
          kind: 'winner', candidateId: selectedCandidate.candidateId,
          path: pathBudget.paths?.winnerAliasPath,
          bytes: candidatePatchRef?.bytes, sha256: candidatePatchRef?.sha256,
        },
        manifest: preparation.manifestAuthority,
      },
    });
    winner = settlement.kind === 'success' && !acceptArtifactRevision(settlement.result, preparation.artifactRevisionAuthority)
      ? unknownArtifactSettlement() : settlement.result;
    if (settlement.kind === 'success' && winner !== settlement.result) {
      poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId: selectedCandidate.candidateId,
      });
    }
    if (settlement.kind === 'unknown') {
      poisonArtifactStore('artifact_store_authority_lost', {
        authorityLost: true, laneId: selectedCandidate.candidateId,
      });
    }
    if (artifactAuthorityLost(winner)) {
      poisonArtifactStore(winner?.error ?? 'artifact_store_authority_lost', {
        authorityLost: true,
        laneId: selectedCandidate.candidateId,
      });
    }
    if (winner?.hardStopped === true) {
      terminalDeadline = true;
    }
    const winnerRef = winner?.ref;
    if (isBlocked(winner) || winner?.ok !== true || winnerRef?.kind !== 'winner' ||
        winnerRef?.candidateId !== selectedCandidate.candidateId ||
        winnerRef?.path !== pathBudget.paths?.winnerAliasPath || winnerRef.path === candidatePatchRef?.path ||
        winnerRef?.sha256 !== candidatePatchRef?.sha256 || winnerRef?.bytes !== candidatePatchRef?.bytes ||
        !Number.isSafeInteger(winnerRef?.bytes) || winnerRef.bytes <= 0 ||
        !Number.isSafeInteger(winnerRef?.expiresAt) || winnerRef.expiresAt <= 0) {
      winner = null;
      aliasFailure = !terminalDeadline;
    }
    if (winner?.manifestRef) latestManifestRef = winner.manifestRef;
  }

  const allRejected = candidates.every((candidate) => candidate.terminalClass === 'rejected');
  const allBlocked = candidates.every((candidate) => candidate.terminalClass === 'blocked');
  let stopReason = aliasFailure ? 'winner_alias_failed' : terminalDeadline ? 'deadline_exceeded' : selectedCandidate?.stopReason ??
    (selection.outcome === 'tie' ? 'judge_tie' : judgeFailure ?? (allRejected ? 'all_candidates_rejected' : allBlocked ? 'all_candidates_blocked' : 'selection_unavailable'));
  // Selection and the alias attempt are durable; commit the one learning
  // transaction before cleanup so a cleanup fault cannot change the grade.
  const learning = await commitRunLearning({
    deps, stage, stateRoot, runId, taskClass, decisions, candidateCount: 2,
    stopReason, selection, candidates, effectiveChoices,
    attemptRefs: learningAttemptRefs(candidates),
    artifactRefs: learningArtifactRefs({ manifestRef: latestManifestRef, candidates, winnerRef: winner?.ref ?? null }),
  });

  const cleanups = [];
  const cleanupNotices = [];
  for (let index = 0; index < laneWorktrees.length; index += 1) {
    const worktree = laneWorktrees[index];
    const candidate = candidates[index];
    const childrenProven = await killLiveChildren(worktree.path);
    const preserve = (aliasFailure || terminalDeadline && selectedCandidate !== null) && index === selectedIndex || candidate.recovery !== null ||
      isWorktreeEffectUnknown?.(worktree.path) === true;
    const removal = childrenProven === true && !preserve
      ? snapshotRemovalResult(await stage(`${laneIds[index]} authoring cleanup`, () =>
        (deps.removeWorktree ?? defaultRemoveWorktree)(worktree)).catch(() => null))
      : UNPROVEN_REMOVAL;
    const removed = removal.ok === true && removal.removed === true;
    const unregistered = removal.ok === true && removal.unregistered === true;
    let tracked = false;
    if (!removed || !unregistered) {
      tracked = await handoffWorktree(worktree.path, `${laneIds[index]} authoring cleanup handoff`);
      if (!tracked) cleanupNotices.push(`manual cleanup required: ${worktree.path}`);
    }
    const cleanup = { removed, unregistered, tracked };
    cleanups.push(cleanup);
    if ((removed && unregistered || tracked) && !storeAuthorityLost) {
      const logicalCleanupPath = `worktrees/${worktree.worktreeId ?? `${runId}-${laneIds[index]}`}`;
      let cleanupCheckpointThrew = false;
      const rawEvent = await stage(`cleanup manifest ${laneIds[index]}`, () => checkpointRaw(artifactStore, {
        eventId: `cleanup:authoring:${laneIds[index]}:000:${qualityHash(Buffer.from(logicalCleanupPath, 'utf8')).slice(0, 12)}`,
        type: 'cleanup_recorded',
        value: {
          kind: 'authoring',
          candidateId: laneIds[index],
          attemptId: null,
          path: worktree.path,
          status: removed && unregistered ? 'removed' : 'reaper_pending',
          recoveryPath: removed && unregistered ? null : worktree.path,
        },
      })).catch(() => {
        cleanupCheckpointThrew = true;
        return { blocked: true, error: 'manifest_checkpoint_failed' };
      });
      const settlement = classifyArtifactSettlement(rawEvent, {
        kind: 'checkpoint', authority: preparation.manifestAuthority,
      });
      const event = settlement.result;
      if (settlement.kind === 'success' && !acceptArtifactRevision(event, preparation.artifactRevisionAuthority)) {
        storeAuthorityLost = true;
        cleanupNotices.push(`cleanup manifest pending: ${worktree.path}`);
        continue;
      }
      if (event?.manifestRef) latestManifestRef = event.manifestRef;
      if (cleanupCheckpointThrew || settlement.kind === 'unknown' || artifactAuthorityLost(event)) {
        storeAuthorityLost = true;
      }
      if (isBlocked(event)) cleanupNotices.push(`cleanup manifest pending: ${worktree.path}`);
    }
  }

  const selectedRef = selectedIndex < 0 ? null : candidateRefs[selectedIndex];
  const attempts = laneResults.flatMap((result) => result.contentFacts.attempts);
  const recoveryPaths = laneWorktrees.filter((_, index) =>
    cleanups[index].removed !== true || cleanups[index].unregistered !== true).map((worktree) => worktree.path);
  const issues = candidates.map(contentIssue);
  const allEvidenceRefs = laneResults.flatMap((result) => result.contentFacts.evidenceRefs);
  const invalidEvidenceCount = laneResults.reduce((sum, result) =>
    sum + result.contentFacts.evidenceOmittedCount, 0);
  const evidenceRefs = selectedCandidate === null
    ? allEvidenceRefs
    : allEvidenceRefs.filter((entry) => entry.evidenceId.includes(`/${selectedCandidate.candidateId}/`));
  const omittedCounts = {
    issues: issues.reduce((sum, issue) => sum + issue.resolvedOmittedCount, 0),
    attempts: 0,
    evidence: allEvidenceRefs.length - evidenceRefs.length + invalidEvidenceCount,
    files: 0,
    artifacts: 0,
  };
  const payload = {
    runId,
    stopReason,
    stepCount: selectedCandidate?.attempts.length ?? attempts.length,
    ...(winner?.ref ? { patch: {
      path: winner.ref.path,
      bytes: winner.ref.bytes,
      empty: winner.ref.bytes === 0,
      files: selectedCandidate.patch?.files ?? [],
      ignoredPaths: [],
      gitlinks: [],
    } } : {}),
    scope: selectedCandidate === null
      ? { flagged: candidates.some((candidate) => candidate.scope.flagged), reasons: [], omitted: candidates.reduce((sum, candidate) => sum + (candidate.scope.omittedReasonCount ?? 0), 0) }
      : { flagged: selectedCandidate.scope.flagged, reasons: [], omitted: selectedCandidate.scope.omittedReasonCount ?? 0 },
    worktree: {
      transplanted: laneWorktrees.some((worktree) => worktree.transplanted === true),
      ignoredPaths: [...new Set(laneWorktrees.flatMap((worktree) => worktree.ignoredPaths ?? []))],
      sharedRules: [...new Set(laneWorktrees.flatMap((worktree) => worktree.sharedRules ?? []))],
      cleanup: { removed: cleanups.every((value) => value.removed), unregistered: cleanups.every((value) => value.unregistered), tracked: cleanups.some((value) => value.tracked) },
    },
    blockers: candidates.filter((candidate) => candidate.terminalClass === 'blocked').map((candidate) => ({ candidateId: candidate.candidateId, where: candidate.stopReason, error: candidate.stopReason })),
    learning: { taskClass, decisions, sources: decisionSources, applied: { grade: learning.grade, axes: learning.appliedAxes } },
    plan: { provider: plannerProvider.id, content: '' },
    steps: selectedCandidate?.attempts.map((attempt) => ({ step: attempt.ordinal, laneId: attempt.laneId, attemptId: attempt.attemptId, retryOf: attempt.retryOf })) ?? [],
    verdict: contentVerdict(selectedCandidate),
    issues,
    candidates: candidates.map(contentCandidate),
    attempts,
    regressionProof: {
      status: selectedCandidate?.regressionProof.status ?? 'unavailable',
      selectedCandidateId: selection.selectedCandidateId,
      evidenceRefs,
      omittedEvidenceCount: allEvidenceRefs.length - evidenceRefs.length + invalidEvidenceCount,
    },
    selection,
    artifacts: {
      manifestPath: latestManifestRef?.path ?? pathBudget.paths.manifestPath,
      expiresAt: latestManifestRef?.expiresAt ?? candidates.find((candidate) => candidate.patch !== null)?.patch.ref.expiresAt ?? winner?.ref?.expiresAt ?? 0,
      candidatePaths: candidates.flatMap((candidate) => candidate.patch === null ? [] : [candidate.patch.ref.path]),
      omittedCount: 0,
    },
    omittedCounts,
    aliasDurable: typeof winner?.ref?.path === 'string',
    fixedFloorInput: fixedFloorInput({
      runId, stopReason, candidateCount: 2, selection, pathBudget, candidates, issues, omittedCounts,
    }),
  };
  const { content, contentFallback } = (deps.renderContentParts ?? renderContentParts)(qualityFreeze(payload));
  const notice = joinNotices([
    ...(preparation.sweepNotice === null ? [] : [preparation.sweepNotice]),
    ...plannerNotices,
    // 두 레인 중 하나만 돌았어도 사용자 코드는 사용자 권한으로 돌았다. 신고는 런당 한 번이다.
    ...(laneResults.some((lane) => lane.userPrivilegeObserved === true) ? [USER_PRIVILEGE_NOTE] : []),
    ...judgeNotices,
    ...cleanupNotices,
    ...laneWorktrees.flatMap((worktree, index) => cleanups[index].tracked
      ? [`워크트리 정리를 리퍼에 넘겼습니다: ${worktree.path}`]
      : []),
    ...learning.notices,
  ]);
  if (terminalDeadline) {
    return failure({
      status: 'deadline_exceeded', confidence: 'unverified', content, contentFallback, runId,
      stopReason: 'deadline_exceeded', error: `데드라인(${effectiveWaitMs}ms)이 지났습니다.`,
      recovery: recoveryPaths.join(', ') || 'wait_ms를 늘려 다시 시도하세요.',
      ...(notice ? { notice } : {}),
    });
  }
  if (aliasFailure) {
    return failure({
      status: 'blocked', confidence: 'unverified', content, contentFallback, runId,
      stopReason: 'winner_alias_failed', error: 'winner_alias_failed',
      recovery: recoveryPaths.join(', ') || laneWorktrees[selectedIndex].path,
      ...(notice ? { notice } : {}),
    });
  }
  if (selectedCandidate !== null) {
    return success({
      content, contentFallback,
      confidence: selectedCandidate.terminalClass === 'verified' ? 'verified' : 'unverified',
      runId,
      stopReason,
      ...(recoveryPaths.length ? { recovery: recoveryPaths.join(', ') } : {}),
      ...(notice ? { notice } : {}),
    });
  }
  if (selection.outcome === 'tie' || allRejected) {
    return failure({
      status: 'failed', confidence: 'disputed', content, contentFallback, runId, stopReason,
      error: `후보 경쟁을 완료하지 못했습니다: ${stopReason}`,
      recovery: recoveryPaths.join(', ') || '두 후보 artifact를 검토한 뒤 새 runId로 다시 시도하세요.',
      ...(notice ? { notice } : {}),
    });
  }
  return failure({
    status: 'blocked', confidence: 'unverified', content, contentFallback, runId, stopReason,
    error: `후보 선택을 완료하지 못했습니다: ${stopReason}`,
    recovery: recoveryPaths.join(', ') || '새 runId로 다시 시도하세요.',
    ...(notice ? { notice } : {}),
  });
}

async function orchestrateQuality(options) {
  const inputFailure = validateQualityRequest(options);
  if (inputFailure !== null) return inputFailure;
  const candidateCount = options.candidateCount === undefined ? 1 : options.candidateCount;
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const task = options.task;
  const projectPath = options.projectPath;
  const isolation = options.isolation ?? 'worktree';
  const budget = options.budget ?? 1;
  const waitMs = options.waitMs ?? 0;
  const registered = (Array.isArray(deps.providers) ? deps.providers : listProviders()).map(snapshotProviderEntry);
  const ids = registered.map((provider) => provider?.id).filter((id) => typeof id === 'string' && id !== '');
  for (const role of ['planner', 'worker', 'verifier']) {
    const wanted = options[role];
    if (wanted !== undefined && wanted !== null && !ids.includes(wanted)) {
      return failure({ status: 'invalid', error: `모르는 프로바이더 id 입니다 (${role}): ${show(wanted)}`, recovery: `쓸 수 있는 프로바이더: ${ids.join(', ') || '(없음)'}` });
    }
  }

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const effectiveWaitMs = waitMs > 0 ? Math.ceil(Math.min(waitMs, MAX_WAIT_MS)) : MAX_WAIT_MS;
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(startedAt + effectiveWaitMs)) {
    return failure({ status: 'invalid', error: 'deadlineAt 을 안전한 정수로 표현할 수 없습니다.', recovery: '시계와 waitMs 값을 확인하세요.' });
  }
  const deadlineAt = startedAt + effectiveWaitMs;
  const deadline = timeoutSignal(effectiveWaitMs);
  const hardStopGraceMs = Number.isFinite(deps.hardStopGraceMs) && deps.hardStopGraceMs > 0
    ? deps.hardStopGraceMs
    : HARD_STOP_GRACE_MS;
  let addNotice = () => {};
  let runStateRoot = null;
  let worktreePath = null;
  const authoringWorktreePaths = new Set();
  let activeRunId = null;
  let worktreeEffectUnknown = false;
  const effectUnknownPaths = new Set();

  /** 한 이음매가 AbortSignal 을 무시해도 데드라인+유예 뒤에는 권위를 회수한다. */
  const raceHardStop = (work) => {
    if (deadline === undefined) return work;
    let timer = null;
    let arm = null;
    const guard = new Promise((resolve) => {
      arm = () => {
        if (timer === null) timer = (deps.hardStopSetTimer ?? setTimeout)(() => resolve(HARD_STOP), hardStopGraceMs);
        timer?.unref?.();
      };
      if (deadline.aborted) arm();
      else deadline.addEventListener('abort', arm, { once: true });
    });
    return Promise.race([work, guard]).finally(() => {
      (deps.hardStopClearTimer ?? clearTimeout)(timer);
      try {
        deadline.removeEventListener?.('abort', arm);
      } catch {
        // AbortSignal 구현이 listener 제거를 지원하지 않으면 일회성 listener 에 맡긴다.
      }
    });
  };
  const stage = async (label, call, { mayTouchWorktree = false, onHardStop = null, worktreePath: touchedPath = null } = {}) => {
    const pending = Promise.resolve().then(call);
    const settled = await raceHardStop(pending);
    if (settled !== HARD_STOP) return settled;
    try {
      onHardStop?.(pending);
    } catch {
      // 늦은 결과를 맡기는 부가 경로가 본 실행의 데드라인 봉투를 막아서는 안 된다.
    }
    if (mayTouchWorktree && (touchedPath ?? worktreePath) !== null) {
      worktreeEffectUnknown = true;
      effectUnknownPaths.add(touchedPath ?? worktreePath);
    }
    addNotice(`${label} 단계가 데드라인 뒤에도 끝나지 않아 결과 권위를 회수했습니다.`);
    return {
      blocked: true,
      hardStopped: true,
      error: `${label} 단계가 데드라인 뒤에도 끝나지 않았습니다.`,
      recovery: 'wait_ms 를 늘리거나 대상 저장소와 프로바이더 상태를 확인하세요.',
    };
  };
  const recoveryStage = async (label, call) => {
    const pending = Promise.resolve().then(call);
    let timer;
    const guard = new Promise((resolve) => {
      timer = (deps.recoverySetTimer ?? setTimeout)(() => resolve(HARD_STOP), hardStopGraceMs);
      timer?.unref?.();
    });
    const settled = await Promise.race([pending, guard]);
    (deps.recoveryClearTimer ?? clearTimeout)(timer);
    return settled === HARD_STOP
      ? { blocked: true, hardStopped: true, error: `${label} recovery authority lost` }
      : settled;
  };

  const treeKill = deps.treeKill ?? defaultTreeKill;
  const trackChild = deps.trackChild ?? defaultTrackChild;
  const usesDefaultTrackChild = deps.trackChild === undefined;
  const trackWorktree = deps.trackWorktree ?? defaultTrackWorktree;
  const liveChildren = new Map();
  const killPromises = new Map();
  const pendingChildTracks = new Map();
  const childMayBeLive = (child) => (child?.exitCode === null || child?.exitCode === undefined)
    && (child?.signalCode === null || child?.signalCode === undefined);
  const killTree = (pid, ownerPath = null) => {
    if (killPromises.has(pid)) return killPromises.get(pid).promise;
    let result;
    try {
      result = treeKill(pid);
    } catch {
      result = false;
    }
    const pending = Promise.resolve(result).then((value) => value === true, () => false);
    killPromises.set(pid, { promise: pending, ownerPath });
    return pending;
  };
  const onDeadlineAbort = () => {
    for (const [pid, entry] of liveChildren) {
      if (childMayBeLive(entry.child)) killTree(pid, entry.ownerPath);
      else liveChildren.delete(pid);
    }
  };
  const evidenceChildPath = async (handle, evidenceId) => {
    if (handle === null || typeof handle !== 'object' || handle.ok !== true ||
        handle.runId !== activeRunId || typeof handle.path !== 'string' ||
        typeof handle.stateRoot !== 'string' || typeof handle.worktreeId !== 'string' ||
        typeof handle.purpose !== 'string' || typeof evidenceId !== 'string') return null;
    const match = /^([^/]+)\/(lane-[ab])\/(\d{3})\/(B0|BR|C)\/(1|2)$/.exec(evidenceId);
    if (match === null || match[1] !== activeRunId ||
        handle.purpose !== `${match[2]}-${match[3]}-${match[4].toLowerCase()}-${match[5]}`) return null;
    const [root, declaredRoot, path] = await Promise.all([
      canonical(runStateRoot), canonical(handle.stateRoot), canonical(handle.path),
    ]);
    if (root === null || declaredRoot !== root || path === null ||
        !pathContains(join(root, 'worktrees'), path) || authoringWorktreePaths.has(path)) return null;
    let expectedId;
    try { expectedId = makeWorktreeId({ runId: activeRunId, purpose: handle.purpose }); } catch { return null; }
    return handle.worktreeId === expectedId && path === join(root, 'worktrees', expectedId) ? path : null;
  };
  const onSpawn = (child, {
    late = false,
    worktree: evidenceHandle = null,
    evidenceId = null,
    planner = false,
    worktreePath: explicitWorktreePath = null,
    laneId = null,
    attemptId = null,
    role = null,
    judgeIndex = null,
    reportIdentity = false,
    ownerWorktreePath = explicitWorktreePath,
  } = {}) => {
    try {
      const pid = child?.pid;
      if (Number.isInteger(pid) && pid > 0) {
        liveChildren.set(pid, { child, ownerPath: ownerWorktreePath ?? null, childWorktree: null });
        child.on?.('exit', () => liveChildren.delete(pid));
      }
      if (runStateRoot !== null) {
        const pending = raceHardStop(Promise.resolve().then(async () => {
          const requestedAuthoring = explicitWorktreePath ?? worktreePath;
          const childWorktree = planner ? null : evidenceHandle === null
            ? authoringWorktreePaths.has(requestedAuthoring) ? requestedAuthoring : null
            : await evidenceChildPath(evidenceHandle, evidenceId);
          const live = liveChildren.get(pid);
          if (live) live.childWorktree = childWorktree;
          if (!planner && childWorktree === null) return false;
          if (reportIdentity) {
            try {
              options.onProgress?.({
                phase: role ?? 'child',
                step: attemptId === null ? judgeIndex ?? 0 : Number(attemptId.slice(-3)),
                laneId,
                attemptId,
                role,
                judgeIndex,
                event: { type: 'spawn', laneId, attemptId, role, judgeIndex },
              });
            } catch {
              // Progress is advisory.
            }
          }
          return Promise.resolve(trackChild({ stateRoot: runStateRoot, child, runId: activeRunId, worktree: childWorktree }))
            .then((value) => usesDefaultTrackChild ? value === undefined || value === true : value === true, () => false);
        })).catch(() => HARD_STOP);
        pendingChildTracks.set(pending, ownerWorktreePath ?? null);
        pending.finally(() => pendingChildTracks.delete(pending));
        if (late && Number.isInteger(pid) && pid > 0) killTree(pid, ownerWorktreePath ?? null);
        return pending;
      }
      if (late && Number.isInteger(pid) && pid > 0) killTree(pid, ownerWorktreePath ?? null);
    } catch {
      // 추적 실패가 실행 자체를 대신하지 않는다. cleanup 이 liveChildren 을 직접 회수한다.
    }
  };
  const killLiveChildren = async (ownerPath = null) => {
    const pending = new Set();
    for (const [pid, entry] of liveChildren) {
      if (ownerPath !== null && entry.ownerPath !== ownerPath) continue;
      if (childMayBeLive(entry.child)) pending.add(killTree(pid, entry.ownerPath));
      else liveChildren.delete(pid);
    }
    // abort listener가 이미 시작한 트리 킬은 부모의 exit 이벤트가 liveChildren 에서 pid 를
    // 지웠더라도 끝까지 기다린다. 그렇지 않으면 손자 회수가 끝나기 전에 워크트리를 지운다.
    for (const killed of killPromises.values()) {
      if (ownerPath === null || killed.ownerPath === ownerPath) pending.add(killed.promise);
    }
    for (const [tracked, trackedOwner] of pendingChildTracks) {
      if (ownerPath === null || trackedOwner === ownerPath) pending.add(tracked);
    }
    if (pending.size === 0) return true;
    const settled = await raceHardStop(Promise.allSettled([...pending]));
    if (settled === HARD_STOP) return false;
    for (const killed of killPromises.values()) {
      if ((ownerPath === null || killed.ownerPath === ownerPath) && await killed.promise !== true) return false;
    }
    return true;
  };
  const setRunIdentity = ({ runId, stateRoot, worktreePath: path, worktreePaths = [] } = {}) => {
    if (typeof runId === 'string') activeRunId = runId;
    if (typeof stateRoot === 'string') runStateRoot = stateRoot;
    if (typeof path === 'string') {
      worktreePath = path;
      authoringWorktreePaths.add(path);
    }
    if (Array.isArray(worktreePaths)) {
      for (const value of worktreePaths) if (typeof value === 'string') authoringWorktreePaths.add(value);
    }
  };

  deadline?.addEventListener?.('abort', onDeadlineAbort, { once: true });
  if (deadline?.aborted === true) onDeadlineAbort();
  try {
    const sharedContext = {
      options,
      deps,
      task,
      projectPath,
      budget,
      deadlineAt,
      deadline,
      effectiveWaitMs,
      registered,
      now,
      stage,
      recoveryStage,
      onSpawn,
      killLiveChildren,
      setRunIdentity,
      isWorktreeEffectUnknown: (path = null) => path === null ? worktreeEffectUnknown : effectUnknownPaths.has(path),
    };
    return candidateCount === 1
      ? await orchestrateFinalC1(sharedContext)
      : await orchestrateFinalC2(sharedContext);
  } finally {
    await killLiveChildren();
    try {
      deadline?.removeEventListener?.('abort', onDeadlineAbort);
    } catch {
      // listener 제거를 지원하지 않는 AbortSignal 구현이면 once 동작에 맡긴다.
    }
  }

}
