import { isAbsolute, join, relative, resolve } from 'node:path';
import { snapshotStoreArtifactAuthority } from './artifact-settlement.mjs';
import { confidenceOfRun } from './confidence.mjs';
import { haltSignal, timeoutSignal } from './deadline.mjs';
import { ARTIFACT_PATH_JSON_BUDGET, validateArtifactPathBudget } from './content-projection.mjs';
import { failure } from './envelope.mjs';
import { inspectRepo as defaultInspectRepo } from './git.mjs';
import { classifyTask } from './learn/classify.mjs';
import { appendRun, runTerminalKeys } from './learn/journal.mjs';
import { refusedScopeAllow } from './patch-scope.mjs';
import { MAX_ALLOW_ENTRIES, MAX_ALLOW_ENTRY_CHARS, unionScopeAllow } from './scope-allowlist.mjs';
import { verifyProjectConfigSealed } from './project-config.mjs';
import { listProviders } from './providers/index.mjs';
import {
  armEffectUnknownIntent as defaultArmEffectUnknownIntent,
  disarmEffectUnknownIntent as defaultDisarmEffectUnknownIntent,
  sweepLogs as defaultSweepLogs,
  sweepPatches as defaultSweepPatches,
  sweepPlans as defaultSweepPlans,
  sweepRuns as defaultSweepRuns,
  sweepScratch as defaultSweepScratch,
  trackChild as defaultTrackChild,
  trackWorktree as defaultTrackWorktree,
  treeKill as defaultTreeKill,
} from './reaper.mjs';
import { resolveStateRoot } from './state-root.mjs';
import { stateSchemaNotice, stateSchemaReason } from './state-schema.mjs';
import { canonical } from './real-path.mjs';
import { provisionDependencies as defaultProvisionDependencies } from './deps-provision.mjs';
import {
  deriveFrozenTestPlan as defaultDeriveFrozenTestPlan,
  frozenTestPlanConfig,
  frozenTestPlanNotices,
} from './test-runner.mjs';
import { makeWorktreeId } from './worktree.mjs';
import {
  classifyProofRequirement,
  createSerialTestQueue,
} from './regression-proof.mjs';
import {
  RUN_ARTIFACT_RETENTION_MS,
  createRunArtifacts,
  getRunArtifactStoreAuthority,
  inspectRunArtifactCollision,
  isRunArtifactStore,
} from './run-artifacts.mjs';
import {
  createRunUsageAccumulator,
} from './run-body.mjs';
import {
  artifactBlocked,
  attachExcerpts,
  carriedFailure,
  createFaultRegistry,
  createRunLog,
  handoffNotice,
  joinNotices,
  reasonCodeOf,
  resultReasonCode,
  runCancelled,
  runDeadline,
  statusOfReasonCode,
  terminalOutcome,
  terminalOutcomeOf,
} from './run-faults.mjs';
import { finalizeRun } from './run-finalization.mjs';
// 레인 한 줄기의 실행과 그 어댑터 묶음은 WS8 컷 1 이 저 모듈로 옮겼다(로드맵 §3.11) — 레인
// 단계의 새 코드는 엔진이 아니라 저쪽으로 들어간다. `PREPARATION_PRIVATE` 는 값이 아니라
// **동일성**이라 사본을 만들 수 없어, 준비가 채우고 어댑터가 읽는 그 하나를 여기서 수입한다.
import { PREPARATION_PRIVATE, runPreparedLane } from './run-lane-adapters.mjs';
// 크레딧 전 관문 넷(게이트웨이·벤더 사전 점검·예측·인증)은 WS8 컷 2 가 저 모듈로 옮겼다 —
// 자리의 근거를 적은 ★★ 주석도 함께 갔다. 새 크레딧 전 관문은 엔진이 아니라 저쪽으로 들어간다.
import {
  assessPreCreditRisk,
  refuseGatewayEnvironment,
  settleVendorPreflight,
} from './run-precredit-gates.mjs';
// 재개의 관문 셋과 그 산술 하나는 WS8 컷 2 가 저 모듈로 옮겼다 — 셋의 **자리**가 곧 계약이라
// (§0-R1) 그 논증이 한 파일에 모여 있어야 한다. 새 재개 판정은 엔진이 아니라 저쪽으로 들어간다.
import {
  openResumeSource,
  refuseEnvironmentDrift,
  refuseWhenNoResumeRoom,
  startResume,
} from './run-resume-gates.mjs';
// 레인 워크트리의 생성·검증·회수는 WS8 컷 2 가 저 모듈로 옮겼다 — 이 실행이 남기는 유일한
// 바깥 부작용이라 만드는 자리와 치우는 자리가 한 파일에 있다. 새 워크트리 준비 코드는 저쪽이다.
import {
  createLaneAWorktree,
  createLaneBWorktree,
  createWorktreeCleanup,
  snapshotBlockedResult,
} from './run-worktrees.mjs';
// 플래너 단계(스크래치 신원 증명 · 플래너 호출 · 계획 정본 기록)는 WS8 컷 2 가 저 모듈로
// 옮겼다 — 회수 규칙이 한 자리여야 하기 때문이다. 새 플래너 코드는 저쪽으로 들어간다.
import { recordPlannerCanon, runPlannerPhase } from './run-planner.mjs';
// 진행 채널과 프로바이더 호출 이음매도 WS8 컷 2 가 저 모듈로 옮겼다 — 둘은 `runFacts` 라는
// 같은 세 값을 싣는다. 새 진행 이벤트는 저쪽으로 들어간다.
import { createProgressReporter, createProviderCall } from './run-progress.mjs';
// 역할 바인딩 사슬(설정 · 밴딧 · 배정 · 보안 하한 · 티어)은 WS8 컷 2 가 저 모듈로 옮겼다 —
// 다섯이 한 사슬이라 한 칸만 떼면 나머지 넷의 전제가 깨진다. 새 바인딩 판정은 저쪽이다.
import { bindRunRoles } from './run-role-bindings.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { cloneData, exactDenseArray, ownDataValue, snapshotOwnDataObject } from './util/objects.mjs';
import { contained } from './util/paths.mjs';
import { REASON } from './reason-codes.mjs';
import { fail, renderNotice } from './reason-text.mjs';
import { GENERIC_RECOVERY, errorText } from './util/errors.mjs';

function validateQualityRequest(options) {
  // ★ 문구는 넘기지 않는다 — 코드가 문장을 정한다(WS2 §7.2). `status` 만 여기서 고른다:
  //   호출자 인자 결함은 도구 수준에서 `invalid` 이고, 그 코드들의 조악 `stopReason` 은
  //   `blocked`(실행 전 전제 조건)다 — 두 어휘는 층이 다르고 섞이지 않는다.
  const invalid = (reasonCode, params = {}) => failure({ status: 'invalid', reasonCode, params });
  const candidateCount = options.candidateCount === undefined ? 1 : options.candidateCount;
  if (candidateCount !== 1 && candidateCount !== 2) {
    return invalid(REASON.config_candidate_count_invalid, { count: show(candidateCount) });
  }
  if (candidateCount === 2 && options.allowSingle === true) return invalid(REASON.config_single_vendor_conflict);
  if (candidateCount === 2 && (options.writer !== undefined || options.worker !== undefined || options.verifier !== undefined)) {
    return invalid(REASON.config_role_override_conflict);
  }
  if (typeof options.task !== 'string' || options.task.trim() === '') return invalid(REASON.config_task_missing);
  if (typeof options.projectPath !== 'string' || options.projectPath === '' || !isAbsolute(options.projectPath)) {
    return invalid(REASON.config_project_path_invalid, { path: show(options.projectPath) });
  }
  const isolation = options.isolation ?? 'worktree';
  if (isolation !== 'worktree') return invalid(REASON.config_isolation_unsupported, { isolation: show(isolation) });
  const budget = options.budget ?? 1;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) {
    return invalid(REASON.config_budget_invalid, { budget: show(budget), limit: MAX_BUDGET });
  }
  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) return invalid(REASON.config_wait_ms_invalid, { waitMs: show(waitMs) });
  // ★ 호스트 취소 신호(WS3 §0-C1, 태스크 6). 여기서는 **모양만** 본다 — 읽는 것은 태스크 7 이다.
  //   `undefined` 는 "호스트 신호 없음"이고 그게 대부분의 호출자다(도구 밖에서 엔진을 직접
  //   부르는 자리에는 호스트가 없다). 모양이 아닌 값을 조용히 흘려보내면 태스크 7 이
  //   `AbortSignal.any([...])` 를 부르는 자리에서 터지는데, 그때는 이미 워크트리가 생긴 뒤다.
  const hostSignal = options.hostSignal;
  if (hostSignal !== undefined && !(hostSignal !== null && typeof hostSignal === 'object' &&
      typeof hostSignal.aborted === 'boolean' && typeof hostSignal.addEventListener === 'function')) {
    return invalid(REASON.config_arguments_invalid);
  }
  // ★ 재개(WS3 §0-R1). 여기서 보는 것은 **모양**뿐이다 — 그 이름의 실행이 있는지, 그것이 이 실행과
  //   같은 정체성인지는 상태 루트를 안 뒤에야 알 수 있고, 그 답은 `resume_*` 네 코드가 낸다.
  const resumeRunId = options.resumeRunId;
  if (resumeRunId !== undefined && (typeof resumeRunId !== 'string' || resumeRunId === '')) {
    return invalid(REASON.config_arguments_invalid);
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

/**
 * 두 도구 집합은 WS8 컷 1 이 `src/run-lane-adapters.mjs` 로 바이트 보존 이동했다 — 쓰는 자리가
 * 레인 어댑터뿐이기 때문이다(로드맵 §3.11).
 *
 * ★ 이 재수출은 **호환 이음매**다. 둘은 이 모듈의 공개 이름이었고 `test/engine.test.mjs` 가
 *   엔진에서 이름으로 수입해 워커·베리파이어에게 실제로 넘어간 집합과 대조한다. 정본은 새
 *   모듈 하나뿐이고 여기는 그 이름을 통과시키기만 한다 — 값을 다시 적으면 두 자리가 갈린다.
 */
export { VERIFIER_TOOLS, WORKER_TOOLS } from './run-lane-adapters.mjs';

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
 * 못이지 예산이 아닌 이유: 정상적인 오케스트레이션(최대 10스텝 × 플래너·워커·테스트·
 * 베리파이어)이 여기 닿는 것은 이상 상태이고, 그때는 부분 결과라도 내보내는 편이
 * MCP 요청이 영영 매달리는 것보다 낫다.
 *
 * ★★ 55분인 이유(WS3 §0-W1). 이 값은 **호스트의 도구 타임아웃보다 먼저** 만료해야 한다 —
 * 호스트가 먼저 끊으면 사용자에게 가는 것은 봉투가 아니라 전송 오류이고, 부분 결과도 사유
 * 코드도 아무 채널에 안 남는다. 호스트 값(Claude `.mcp.json` 의 `timeout`, Codex 의
 * `tool_timeout_sec` — 둘 다 3,600,000 ms)은 **올리지 않는다**: 우리가 못 고치는 남의 설정에
 * 기대게 되기 때문이다. 그래서 엔진을 내린다. 3,600,000 − 70,000 = 3,530,000 이 상한이고
 * 70초는 abort **뒤에** 우리가 아직 쓰는 시간이다(하드스톱 유예 10초 `HARD_STOP_GRACE_MS`
 * + 워크트리 정리 최대 60초). 부등식은 `test/guards/wait-budget-inequality.test.mjs` 가 두
 * 호스트 설정의 소스와 exporter 산출물 양쪽에서 지킨다. 기본 `wait_ms` 1,800,000 은 그대로다
 * — 같이 내리면 기본 실행이 데드라인에 더 자주 걸린다(로드맵 §3.5).
 */
export const MAX_WAIT_MS = 3_300_000;

/** 데드라인 뒤 주입 이음매가 signal 을 무시할 때 기다리는 단계별 유예. */
const HARD_STOP_GRACE_MS = 10_000;
const HARD_STOP = Symbol('bom-orch:hard-stop');

/** `src/worktree.mjs` 의 `RUN_ID_PATTERN` 과 같은 값. 갈리면 워크트리 생성이 거부된다. */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 값이 없을 때 문장에 들어가는 토큰. `renderReason` 은 빠진 인자에 **던지므로** 자리를 비울 수 없다. */
const UNKNOWN_VALUE = '<unknown>';
const NO_VENDORS = '(none)';

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
  // ★ `undefined` 는 `Object.prototype.toString` 으로 내려보내지 않는다. 그 답('[object Undefined]')은
  //   봉투 계약이 금지한 'undefined' 라는 글자를 문장에 넣는다 — 값이 없다는 사실이 값처럼 보인다.
  if (value === undefined) return '(missing)';
  try {
    const text = JSON.stringify(value);
    if (typeof text === 'string') return text;
  } catch {
    // 아래로 떨어진다.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '(unrepresentable value)';
  }
}

/** 하위 모듈의 `{blocked:true}` 인가. `ok:true` 결과와 겹치지 않는다. */
const isBlocked = (result) => ownDataValue(result, 'blocked').value === true;

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
 * 배치 상수 둘과 `assignRoles`·`freezeEffectiveChoices` 는 WS3 태스크 8(스펙 §0-M1)이
 * `src/learn/effective-choices.mjs` 로 바이트 보존 이동했다 — 학습 팔의 장부이지 조율이 아니다.
 *
 * ★ 이 재수출은 **호환 이음매**다. 두 상수는 이 모듈의 공개 이름이었고 `test/engine.test.mjs` 가
 *   엔진에서 이름으로 수입해 밴딧의 팔 이름과 대조한다. 정본은 새 모듈 하나뿐이고 여기는 그
 *   이름을 통과시키기만 한다 — 값을 다시 파생시키지 않는다(두 자리에서 파생하면 갈린다).
 */
export { FORWARD_PLACEMENT, REVERSED_PLACEMENT } from './learn/effective-choices.mjs';

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
 *           onProgress?: Function, hostSignal?: AbortSignal, deps?: object }} spec
 * @returns MCP 봉투(`src/envelope.mjs`). content 는 JSON 문자열이다.
 */
export async function runOrchestration(spec) {
  // ★ 구조분해로 받지 않는다. `runOrchestration(null)` 이 구조분해 자리에서 TypeError 를
  //   던지면 봉투가 아니라 거부된 프로미스가 나간다(worktree.mjs 가 같은 이유로 버렸다).
  let options = null;
  try {
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) options = spec;
  } catch {
    options = null;
  }
  if (options === null) return failure({ status: 'invalid', reasonCode: REASON.config_arguments_invalid });

  // ★ 로그 핸들은 `orchestrateQuality` 안에서 열린다. 그 함수가 던져 아래 catch 로 오면 봉투를
  //   만들 재료가 전부 사라지는데 — 바로 그때가 로그 파일이 가장 필요한 순간이다. 열린 경로만은
  //   여기까지 들고 나온다(열리기 전에 던졌으면 `undefined` 로 남고, 그 봉투는 `log` 없이 나간다).
  let openedLog;
  try {
    const snapshot = snapshotOwnDataObject(options, [
      'task', 'projectPath', 'isolation', 'budget', 'candidateCount', 'allowSingle', 'waitMs',
      'decisions', 'planner', 'writer', 'worker', 'verifier', 'onProgress', 'hostSignal', 'resumeRunId', 'scopeAllow', 'deps',
    ]);
    if (snapshot === null) {
      return failure({ status: 'invalid', reasonCode: REASON.config_arguments_invalid });
    }
    const inputFailure = validateQualityRequest(snapshot);
    if (inputFailure !== null) return inputFailure;
    if (snapshot.decisions !== undefined) {
      const decisions = snapshot.decisions !== null && typeof snapshot.decisions === 'object' && !Array.isArray(snapshot.decisions)
        ? snapshotOwnDataObject(snapshot.decisions, ['mix', 'placement', 'tier'])
        : null;
      if (decisions === null) {
        return failure({ status: 'invalid', reasonCode: REASON.config_arguments_invalid });
      }
      snapshot.decisions = Object.freeze(decisions);
    }
    const deps = snapshot.deps !== null && typeof snapshot.deps === 'object' && !Array.isArray(snapshot.deps)
      ? snapshotOwnDataObject(snapshot.deps)
      : {};
    if (deps === null) {
      return failure({ status: 'invalid', reasonCode: REASON.config_arguments_invalid });
    }
    if (Array.isArray(deps.providers)) {
      const providers = exactDenseArray(deps.providers);
      if (providers === null) {
        return failure({ status: 'invalid', reasonCode: REASON.config_arguments_invalid });
      }
      deps.providers = providers.map(snapshotProviderEntry);
    }
    snapshot.deps = Object.freeze(deps);
    return await orchestrateQuality(Object.freeze(snapshot), (ref) => { openedLog = ref; });
  } catch {
    return failure({ status: 'failed', reasonCode: REASON.run_orchestration_failed, log: openedLog });
  }
}

function snapshotProviderEntry(provider) {
  const snapshot = provider !== null && typeof provider === 'object' && !Array.isArray(provider)
    ? snapshotOwnDataObject(provider, ['id', 'preflight', 'run', 'describeError', 'securityFloor', 'authProbe'])
    : null;
  if (snapshot === null || typeof snapshot.id !== 'string' || snapshot.id === '') {
    return Object.freeze({
      id: '',
      preflight: async () => ({ available: false, error: 'invalid provider entry' }),
      run: async () => ({ error: 'invalid provider entry' }),
      describeError: (error) => ({ error: errorText(error), recovery: GENERIC_RECOVERY }),
    });
  }
  const bind = (name, fallback) => typeof snapshot[name] === 'function'
    ? snapshot[name].bind(provider)
    : fallback;
  return Object.freeze({
    id: snapshot.id,
    preflight: bind('preflight', async () => ({ available: false, error: 'invalid provider preflight' })),
    run: bind('run', async () => ({ error: 'invalid provider run' })),
    describeError: bind('describeError', (error) => ({ error: errorText(error), recovery: GENERIC_RECOVERY })),
    // ★ 선택적이다(설계 §5.8 S2(a)). 권고가 없는 프로바이더는 구현하지 않고, 없으면 엔진이
    //   그 축의 검사를 건너뛴다. 있지도 않은 권고를 흉내 내는 기본 구현을 넣으면 그 자체가
    //   거짓 신호다 — 여기서 대체값을 만들지 않는 이유다.
    ...(typeof snapshot.securityFloor === 'function' ? { securityFloor: bind('securityFloor', undefined) } : {}),
    // ★ 같은 규칙의 둘째(WS4b §0-AU). 이 화이트리스트에 이름을 안 넣으면 게이트가 **조용히**
    //   통째로 꺼지고, 그것은 보안 하한에서 이미 한 번 일어난 사고다 — 테스트가 그 경계를 잰다.
    ...(typeof snapshot.authProbe === 'function' ? { authProbe: bind('authProbe', undefined) } : {}),
  });
}

/**
 * 공유 `contained` 에 **같은 경로**를 더한 엔진판이다.
 *
 * ★ 공유본은 넷 중 셋의 답을 따라 `parent === child` 를 거짓으로 본다. 여기서 그 답을
 *   그대로 쓰면 `artifact_root_overlaps_project`(상태 루트와 대상 저장소가 같은 경로일
 *   때 내는 이유 코드)가 사라진다 — 바깥으로 나가는 문자열이 달라지는 동작 변경이라
 *   이 티어의 범위 밖이다. 같음만 이 파일에서 더하고 나머지 판정은 공유본에 맡긴다.
 */
function pathContains(parent, child) {
  return relative(parent, child) === '' || contained(parent, child);
}

async function prepareRunNamespace(options, deps) {
  const context = options;
  const runOptions = context.options;
  const candidateCount = runOptions.candidateCount === undefined ? 1 : runOptions.candidateCount;
  const {
    task, projectPath, budget, deadlineAt, deadline, effectiveWaitMs,
    registered, now, stage, recoveryStage, haltReasonCode, runHalt, onSpawn, killLiveChildren,
    isWorktreeEffectUnknown, openLog, logLine, addNotice, envelopeExtras, redact,
  } = context;
  // ★ 준비 단계의 이탈 하나. 이름을 `fail` 로 두면 문구 정본의 `fail(REASON.x)` 를 가린다.
  const halt = (envelope) => deepFreeze({ ok: false, envelope });
  if (![1, 2].includes(candidateCount) || candidateCount === 2 &&
      (runOptions.writer !== undefined || runOptions.worker !== undefined || runOptions.verifier !== undefined) ||
      typeof task !== 'string' || task.trim() === '' || typeof projectPath !== 'string' ||
      projectPath === '' || !isAbsolute(projectPath) || (runOptions.isolation ?? 'worktree') !== 'worktree' ||
      !Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET ||
      !Number.isSafeInteger(deadlineAt)) {
    return halt(failure({ status: 'invalid', reasonCode: REASON.run_preparation_input_invalid }));
  }
  // ★★ 실행 이름과 상태 루트를 **사전 점검보다 먼저** 정한다(WS3 §0-E). 이 블록이 아래 있던 동안
  //   사전 점검에서 멈춘 봉투는 `log` 를 못 달았고, 벤더별 사유는 봉투가 못 싣는 벤더 산문이라
  //   (불변식 4) 어느 채널에도 안 남았다. 상태 루트가 벤더보다 먼저 보이는 것도 맞는 순서다.
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
    return halt(artifactBlocked(runId, REASON.artifact_root_not_canonical, { path: requestedRoot }));
  }
  // ★ 여기서부터 모든 봉투가 로그 참조를 들고 나간다 — 로그 파일의 자리는 상태 루트가 정한다.
  //   위의 실패 **둘**(인자 검증·상태 루트 정준화)만 `log` 없이 나가고, 그것이 유일한 경우다(WS2 §5).
  await openLog({ stateRoot, projectPath, runId });
  // ★ 상태 루트가 정해진 순간 종료 기록의 자리도 정해진다(WS3 §0-D1) — 사전 점검에서 막힌
  //   실행의 행이 갈 곳이 여기다. 그런데 그 "정해짐" 을 `context` 에 알리는 시점은 `openLog`
  //   **뒤**로 둔다(리뷰 Q2, WS3 태스크 2 수정 라운드) — 앞이면 아래 창이 생긴다. `openLog`
  //   는 세척기(`makeRedactor`)를 설치하기 **전에** 던질 수 있다(`makeRedactor`·`homedir`
  //   자체가 던지는 경우). `setRunIdentity({stateRoot})` 가 그 앞에 있으면, 그 사이에 던진
  //   실행도 `runStateRoot` 는 이미 채워져 있어 최상위 catch 의 종료 sink(`settleRun`)가
  //   `runStateRoot !== null` 만 보고 저널 쓰기를 시도한다 — 그 행의 `taskPreview` 는 세척기
  //   없이(항등 `redact`) 만들어지고, 저널에는 보존 정책이 없으니 세척 안 지난 평문이 디스크에
  //   영구히 남는다. `openLog` 뒤로 늦추면 그 창에서 던진 실행은 `settleRun` 의 게이트
  //   (`runStateRoot === null`)에 걸려 저널 쓰기 자체를 시도하지 않는다 — 세척 안 지난 문자열이
  //   디스크에 닿을 길이 없다. 상태 루트 정준화 실패는 이 줄에 닿기 전에 빠지고, 사전 점검
  //   halt 넷은 옛 순서에서도 새 순서에서도 이 줄을 지난 **뒤에** 멈춘다(종료 행이 있어야 하는
  //   실행들이다) — 어느 쪽도 이 재배치로 달라지지 않고, 달라지는 것은 `openLog` 가 던진
  //   실행뿐이다.
  context.setRunIdentity?.({ stateRoot });
  // ★★ 호스트 취소는 사전 점검보다 **앞선다**(WS3 §0-C2). 사용자가 이미 그만두라고 했는데 벤더를
  //   전부 깨워 「어느 CLI 가 없다」를 보고하면, 그 봉투는 자기가 끊은 실행에 대한 벤더 문제로
  //   읽힌다 — 그리고 그 사이 벤더 프로세스가 뜬다(취소의 종료 기준은 자식 0 이다).
  // ★ **데드라인은 여기서 안 본다.** 그 순서를 바꾸면 오늘 사전 점검에서 막히는 사용자가 보는
  //   실패가 달라진다(WS3 §0-E 가 상태 루트에 대해 한 것과 같은 등급의 판정이고, 이 태스크의
  //   것이 아니다). 취소는 오늘 아무 봉투도 없던 자리라 새 행동이지 바뀐 행동이 아니다.
  if (haltReasonCode() === REASON.run_cancelled) return halt(runHalt({ runId, extras: envelopeExtras() }));
  // ★★ 여기부터 lane-a 워크트리까지는 **순서가 곧 계약**이다: 재개 관문 1(지목된 실행이 있고
  //   읽히는가) → 게이트웨이 구성 거부 → 벤더별 사전 점검. 셋 다 「어떤 벤더 프로세스도 뜨기
  //   전」이라는 같은 사실 위에 서 있고, 하나라도 뒤로 밀면 그 봉투는 자기 사유가 아니라 벤더
  //   문제로 읽힌다. 판정과 그 자리의 근거는 `src/run-resume-gates.mjs`·
  //   `src/run-precredit-gates.mjs` 의 ★★ 주석이 들고 있다 — 엔진에 남은 것은 이 순서뿐이다.
  const source = await openResumeSource({ runOptions, stateRoot, runId, envelopeExtras });
  if (source.refusal !== null) return halt(source.refusal);
  const { resumeRunId, resumeSource } = source;
  const gateway = refuseGatewayEnvironment({ deps, runId, logLine, envelopeExtras });
  if (gateway.refusal !== null) return halt(gateway.refusal);
  const vendors = await settleVendorPreflight({
    registered, runOptions, candidateCount, runId, deadline, stage, logLine, runHalt, envelopeExtras,
  });
  if (vendors.refusal !== null) return halt(vendors.refusal);
  const providers = vendors.providers;
  const { runFacts, progress } = createProgressReporter({ runId, budget, candidateCount, runOptions });
  logLine('info', null, 'run_started', { runId, candidateCount, budget, deadlineAt, projectPath });
  const pathBudget = validateArtifactPathBudget({ stateRoot, runId, candidateCount });
  if (isBlocked(pathBudget)) {
    return halt(artifactBlocked(runId, reasonCodeOf(pathBudget, REASON.artifact_paths_invalid), {
      limit: ARTIFACT_PATH_JSON_BUDGET, path: stateRoot, runId,
    }, envelopeExtras()));
  }
  const collisionCheck = deps.inspectRunArtifactCollision ?? inspectRunArtifactCollision;
  const readonlyDeps = deps.artifactReadonlyDeps ?? { canonicalPath: canonicalStateRoot };
  const collision = await collisionCheck({ stateRoot, runId }, readonlyDeps);
  if (isBlocked(collision)) {
    return halt(artifactBlocked(runId, reasonCodeOf(collision, REASON.artifact_collision_inspection_failed), {
      path: stateRoot, runId,
    }, envelopeExtras()));
  }
  if (collision.collision === true) {
    return halt(artifactBlocked(runId, REASON.artifact_namespace_collision, { runId }, envelopeExtras()));
  }
  try {
    canonicalProject = await canonicalProjectPath(projectPath);
    if (typeof canonicalProject !== 'string') throw new Error('canonicalization failed');
    context.setRunIdentity?.({ projectPath: canonicalProject });
  } catch {
    return halt(artifactBlocked(runId, REASON.git_project_root_not_canonical, { path: projectPath }, envelopeExtras()));
  }
  if (pathContains(stateRoot, canonicalProject) || pathContains(canonicalProject, stateRoot)) {
    return halt(artifactBlocked(runId, REASON.artifact_root_overlaps_project, {}, envelopeExtras()));
  }

  const sweepScratch = deps.sweepScratch ?? defaultSweepScratch;
  const sweepPatches = deps.sweepPatches ?? defaultSweepPatches;
  const sweepRuns = deps.sweepRuns ?? defaultSweepRuns;
  // ★ `logs` 가 네 번째 행이다. 장수 서버는 부팅이 며칠에 한 번이라 리퍼의 부팅 스윕만으로는
  //   그 사이에 쌓인 로그를 못 본다 — 실행 시작 스윕과 부팅 스윕이 **같은 함수**를 부른다.
  const sweepLogs = deps.sweepLogs ?? defaultSweepLogs;
  // ★ `plans` 가 다섯 번째 행이다(WS4a 태스크 9). 오늘까지 이 디렉터리를 쓰는 자리는 **하나도**
  //   없었고, 남는 것은 모델이 쓴 계획 초안이라 평문이다 — 부팅 스윕과 실행 시작 스윕이 같은
  //   함수를 부르는 이유는 나머지 넷과 같다(장수 서버는 부팅이 며칠에 한 번이다).
  const sweepPlans = deps.sweepPlans ?? defaultSweepPlans;
  const sweepNow = now();
  let sweptRemoved = 0;
  let sweptSkipped = 0;
  // ★ 던진 스윕은 `skipped` 가 아니다. `skipped` 는 "봤고 남겨 뒀다" 이고, 던진 쪽은 무엇을
  //   남겼는지조차 모른다 — 하나로 접으면 알림이 안 본 사실을 단정한다(WS2 Task 10 수정 패스).
  let sweptFailed = 0;
  for (const [name, sweep, args] of [
    ['scratch', sweepScratch, [stateRoot, sweepNow]],
    ['plans', sweepPlans, [stateRoot, sweepNow]],
    ['patches', sweepPatches, [stateRoot, sweepNow, { excludeRunId: runId }]],
    ['runs', sweepRuns, [stateRoot, sweepNow, { excludeRunId: runId }]],
    ['logs', sweepLogs, [{ stateRoot, now: sweepNow }]],
  ]) {
    try {
      const summary = await sweep(...args);
      const removed = Array.isArray(summary?.removed) ? summary.removed.length : summary?.removed ?? 0;
      const skipped = summary?.skipped?.length ?? 0;
      sweptRemoved += removed;
      sweptSkipped += skipped;
      logLine('info', null, 'retention_swept', { sweep: name, removed, skipped, failed: 0 });
    } catch {
      sweptFailed += 1;
      logLine('warn', null, 'retention_swept', { sweep: name, removed: 0, skipped: 0, failed: 1 });
    }
  }
  const sweepSummaries = sweptRemoved > 0 || sweptSkipped > 0 || sweptFailed > 0
    ? [renderNotice('retention_swept', { removed: sweptRemoved, skipped: sweptSkipped, failed: sweptFailed })]
    : [];

  if (deadline?.aborted === true || now() >= deadlineAt) {
    return halt(runHalt({ runId, extras: envelopeExtras(sweepSummaries) }));
  }
  progress('inspect');
  const inspectRepo = deps.inspectRepo ?? defaultInspectRepo;
  const inspected = await stage('repository inspection', () => inspectRepo(projectPath));
  if (inspected?.hardStopped === true) {
    return halt(runHalt({ runId, extras: envelopeExtras(sweepSummaries) }));
  }
  if (isBlocked(inspected)) {
    logLine('error', resultReasonCode(inspected), 'repository inspection', { detail: inspected.error ?? '' });
    // ★ WS2 Task 14. git 사전 점검의 결함도 카탈로그가 분류하고 `stderrTail` 을 함께 들고 온다 —
    //   그 둘이 있어야 라벨된 git stderr 발췌가 붙는다(§3.2 EC3). 벤더와 **같은 함수**를 쓴다:
    //   두 벌이면 한쪽만 세척되거나 한쪽만 상한을 지킨다. 허용 집합은 카탈로그가 이미 좁혔다.
    // ★ status 도 여기서 고르지 않는다(I1 과 같은 규칙): 실려 갈 코드의 조악값이 정하고, 코드
    //   없이 미분류로 나가는 결과만 「실행 전 전제 실패」라는 뜻의 'blocked' 로 남는다. 오늘 git
    //   점검이 내는 코드는 전부 조악 blocked 라 값이 같지만, 주입된 의존성이 다른 조악값의 코드를
    //   들고 오면 {status:'blocked', stopReason:'infrastructure_failed'} 짝이 나가던 자리다.
    const carried = carriedFailure(inspected, { path: projectPath, waitMs: effectiveWaitMs });
    return halt(failure({
      status: carried.reasonCode === undefined ? 'blocked' : statusOfReasonCode(carried.reasonCode),
      confidence: confidenceOfRun({ unverified: true }), runId, excerpts: attachExcerpts(inspected, { vendor: 'git', redact }),
      ...carried, ...envelopeExtras(sweepSummaries),
    }));
  }
  // ★★ 프로젝트 설정(`.bom-orch.json`)을 읽을 커밋. 방금 `inspectRepo` 가 검증한 HEAD 다 —
  //   계획을 동결하는 이 자리에서 알 수 있는 유일한 커밋이고, 실행의 봉인 baseline 은 lane-a
  //   워크트리가 생긴 **뒤에야** 존재한다(아래 `preparedLaneA.baselineIdentity`). 그 둘이 같은
  //   설정을 담고 있는지는 baseline 직후에 대조하고(`verifyProjectConfigSealed`), 갈리면 멈춘다.
  //   ★ 주입된 `inspectRepo` 스텁이 HEAD 를 안 주면 설정 기능 자체가 꺼진다 — 설정을 도입하기
  //     전의 동작 그대로다. 프로덕션 경로는 언제나 진짜 `inspectRepo` 라 그 자리가 아니다.
  const projectConfigCommit = typeof inspected?.head === 'string' && inspected.head !== '' ? inspected.head : null;
  const usesDefaultTestPlanDeriver = deps.deriveFrozenTestPlan === undefined;
  const deriveFrozenTestPlan = deps.deriveFrozenTestPlan ?? defaultDeriveFrozenTestPlan;
  const derivedTestPlan = await stage('frozen test plan', () => deriveFrozenTestPlan(projectPath, {
    ...(deps.testRunnerDeps ?? {}),
    ...(projectConfigCommit === null ? {} : { projectConfigCommit }),
  }));
  // ★★ carry 하기 **전에** 「누가 껐는가」를 먼저 가른다 — 바로 위 저장소 점검과 아래
  //   의존성 제공이 이미 쓰는 규율이고, 이 자리만 그 밖에 있었다(WS4a 태스크 11, m17).
  //   `stage()` 의 유예가 만료되면 `haltFail` 이 `hardStopped:true` 인 중립 실패를 내는데, 그것을
  //   `carriedFailure` 로 실으면 정지 버튼을 누른 사용자가 「계획을 못 얼렸다」는 코드와 그
  //   회복을 받는다. 이름은 `haltReasonCode()` 하나가 붙인다. 워크트리 전이라 치울 것은 없다.
  if (derivedTestPlan?.hardStopped === true) {
    return halt(runHalt({ runId, extras: envelopeExtras(sweepSummaries) }));
  }
  if (isBlocked(derivedTestPlan)) {
    logLine('error', resultReasonCode(derivedTestPlan), 'frozen test plan', { detail: derivedTestPlan.error ?? '' });
    // ★ status 는 위 점검 halt 와 같은 규칙이다 — 실려 갈 코드의 조악값이 정한다.
    const carried = carriedFailure(derivedTestPlan, { path: projectPath, waitMs: effectiveWaitMs });
    return halt(failure({
      status: carried.reasonCode === undefined ? 'blocked' : statusOfReasonCode(carried.reasonCode),
      confidence: confidenceOfRun({ unverified: true }), runId,
      ...carried, ...envelopeExtras(sweepSummaries),
    }));
  }
  // The production test-plan builder attaches private frozen runtime authority to
  // the returned object. Preserve that identity; injected mutable fixtures still
  // receive the defensive clone used by the controller tests.
  // ★ 여기는 try 밖이다. 복사가 실패했다고 던지면 그 토큰이 봉투의 `error` 로 그대로 새어
  //   나간다(runId 도 없는 "예기치 못한 오류" 문장). 대신 복사 못 하는 계획은 **못 쓰는**
  //   계획이므로, 계획이 아예 쓰레기일 때 이미 나던 코드로 같은 자리에서 닫는다 — 워크트리는
  //   아직 만들기 전이라 치울 것도 없다.
  const clonedTestPlan = usesDefaultTestPlanDeriver && Object.isFrozen(derivedTestPlan)
    ? derivedTestPlan
    : cloneData(derivedTestPlan);
  if (clonedTestPlan === undefined) {
    return halt(artifactBlocked(runId, REASON.run_binding_preparation_failed, {}, envelopeExtras(sweepSummaries)));
  }
  const frozenTestPlan = deepFreeze(clonedTestPlan);
  // ★★ 분류 둘은 순수 함수이고 입력이 `task` 와 방금 얼어붙은 계획뿐이라, 여기가 가장 이른 자리다
  //   — 워크트리보다도 크레딧보다도 앞이다. 태스크 2 의 preflight 가 크레딧 전에 이 둘을 읽는다.
  const taskClass = classifyTask({ task, testSource: frozenTestPlan.source ?? null });
  const proofRequirement = classifyProofRequirement({ task, taskClass });
  // ★ 계획 파생이 낸 알림(지금은 「검증만 되고 아직 소비되지 않는 설정 키」 하나). 계획 객체는
  //   지문에 들어가는 정확한 키 집합이라 실을 자리가 없어서 사설 런타임에서 꺼낸다. 원본 identity
  //   로 읽는다 — 주입된 계획은 복제를 거치므로 그쪽에는 애초에 런타임이 없다(빈 배열).
  const configNotices = frozenTestPlanNotices(derivedTestPlan);
  // ★ 같은 사설 런타임에서 **baseline 설정 자체**도 꺼낸다. 이 실행이 그것을 읽는 자리는
  //   위 파생 한 번뿐이고(커밋 오브젝트에서), 아래 의존성 제공이 유일한 소비자다 — 다시 읽으면
  //   같은 커밋에 대한 git 왕복이 두 벌이 되고 「이 실행이 읽은 설정」이 두 개가 된다.
  const baselineConfig = frozenTestPlanConfig(derivedTestPlan);
  // ★★ 허용목록의 합집합(WS5 스펙 §0 D1a). 자리가 여기인 이유는 **읽는 자리가 하나**이기
  //   때문이다: 프로젝트 설정은 바로 위 한 번만 읽히고(커밋 오브젝트에서), 호출 인자는
  //   `runOptions` 에 있다. 아래로 내려가서 접으면 레인마다 다른 합집합이 생길 수 있다.
  // ★ 검증하지 않고 **접기만** 한다. 모양이 이상한 값은 합집합이 그 항목만 버리고, 그 결과는
  //   「아무것도 안 지워진다」 — 즉 이 축의 실패는 언제나 닫는 쪽이다. 도구 층이 이미 배열·원소
  //   타입을 정확한 코드로 거부하므로(`validateArgs`), 여기서 다시 거부하면 라이브러리로 이 함수를
  //   부르는 쪽만 새 실패 모양을 얻는다.
  const scopeAllow = unionScopeAllow(runOptions.scopeAllow, baselineConfig?.scope?.allow);
  // 못 쓴 항목과 이름 부를 수 없는 항목은 **조용히 사라지지 않는다**. 둘 다 사용자가 쓴 것이고,
  // 말하지 않으면 「내가 적었는데 왜 안 듣지」의 답이 어느 채널에도 없다.
  if (scopeAllow.ignored > 0) {
    addNotice(renderNotice('scope_allow_entries_dropped', {
      kept: MAX_ALLOW_ENTRIES, chars: MAX_ALLOW_ENTRY_CHARS, dropped: scopeAllow.ignored,
    }));
  }
  const refusedAllow = refusedScopeAllow(scopeAllow.entries.map((one) => one.entry));
  if (refusedAllow.length > 0) {
    addNotice(renderNotice('scope_allow_hard_list_ignored', { entries: refusedAllow.map((one) => one.entry).join(', ') }));
  }
  const drift = refuseEnvironmentDrift({
    resumeSource, frozenTestPlan, runId, resumeRunId, envelopeExtras: () => envelopeExtras(sweepSummaries),
  });
  if (drift.refusal !== null) return halt(drift.refusal);
  const risk = await assessPreCreditRisk({
    task, canonicalProject, candidateCount, budget, effectiveWaitMs,
    frozenTestPlan, proofRequirement, baselineConfig, providers,
    runId, deadline, deps, stage, logLine, addNotice, runHalt,
    envelopeExtras: () => envelopeExtras(sweepSummaries),
  });
  if (risk.refusal !== null) return halt(risk.refusal);
  const preflight = risk.preflight;

  const laneA = await createLaneAWorktree({
    projectPath, canonicalProject, stateRoot, runId, deps, stage, recoveryStage, runHalt,
    envelopeExtras: (notices = []) => envelopeExtras([...sweepSummaries, ...notices]),
  });
  if (laneA.refusal !== null) return halt(laneA.refusal);
  const preparedLaneA = laneA.laneWorktree;
  progress('worktree');
  const baseline = deepFreeze({ ...preparedLaneA.baselineIdentity });
  const laneWorktrees = [preparedLaneA];
  const cleanupPreparationWorktrees = createWorktreeCleanup({ stateRoot, runId, deps, recoveryStage });
  const resumption = await startResume({
    resumeSource, resumeRunId, baseline, candidateCount, budget, runId,
    cleanupWorktrees: (label) => cleanupPreparationWorktrees(laneWorktrees, label),
    envelopeExtras: (notices = []) => envelopeExtras([...sweepSummaries, ...notices]),
  });
  if (resumption.refusal !== null) return halt(resumption.refusal);
  const resume = resumption.resume;
  // ★★ 설정 봉인 대조(WS4a 태스크 4). 계획이 읽은 커밋과 이 실행이 봉인한 baseline 이 같은
  //   `.bom-orch.json` 을 담고 있을 때만 잇는다. 다르다는 것은 사용자가 설정을 **미커밋으로**
  //   고쳤다는 뜻이고, 그러면 이 실행이 읽은 설정과 사용자가 보고 있는 설정이 다르다 —
  //   절반만 적용하지도 조용히 무시하지도 않고 `config_uncommitted` 로 멈춘다. 이 자리가 가장
  //   이르다: baseline 은 방금 생겼고 두 번째 레인도 벤더 호출도 아직 없어서, 거부는 방금 만든
  //   워크트리 하나만 치운다.
  // ★ **소스**의 미커밋 변경은 여기서 아무 말도 하지 않는다. 이식된 소스가 이 실행의 대상이고,
  //   설정 파일 하나만 커밋 오브젝트에서 읽히기 때문에 이 규칙이 그 파일에만 걸린다.
  // ★ 주입 이음매로 만들지 않았다. 이 함수는 git 오브젝트만 읽는 순수 함수라 진짜 저장소로
  //   재는 것이 가장 정직하고(`test/project-config.test.mjs`·`test/engine.test.mjs`), 부르지
  //   않는 실행이 있는 이음매를 「모든 이음매가 하드 스톱을 지킨다」 목록에 넣으면 그 목록이
  //   거짓이 된다. 하드 스톱은 `stage()` 가 그대로 건다.
  if (projectConfigCommit !== null) {
    const sealedConfig = await stage('project config seal', () => verifyProjectConfigSealed({
      cwd: preparedLaneA.path, derivedCommit: projectConfigCommit, sealedCommit: baseline.commit,
    }));
    // ★★ 여기도 carry 보다 하드 스톱이 먼저다(WS4a 태스크 11, m17). 이 자리는 워크트리를
    //   치우므로 어긋남이 **두 채널로** 나갔다: 봉투의 `config_uncommitted` 와, 회수 단계에 붙는
    //   'project config seal mismatch' 라는 라벨. 끊긴 실행에서는 둘 다 거짓이고, 라벨은 로그와
    //   `stage_authority_revoked` 알림에 그대로 실려 남는다 — 그래서 라벨도 함께 참이 돼야 한다.
    if (sealedConfig?.hardStopped === true) {
      const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'project config seal halt');
      return halt(runHalt({ runId, extras: envelopeExtras([...sweepSummaries, ...cleanup.notices]) }));
    }
    if (sealedConfig?.ok !== true) {
      const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'project config seal mismatch');
      const carried = carriedFailure(sealedConfig, { path: projectPath, waitMs: effectiveWaitMs });
      return halt(failure({
        status: carried.reasonCode === undefined ? 'blocked' : statusOfReasonCode(carried.reasonCode),
        confidence: confidenceOfRun({ unverified: true }), runId,
        ...carried, ...envelopeExtras([...sweepSummaries, ...cleanup.notices]),
      }));
    }
  }
  if (resume !== null) {
    logLine('info', null, 'resume', {
      source: resume.from, reusedAttempts: resume.reusedAttempts, startOrdinal: resume.startOrdinal,
    });
    // ★ 그리고 종료 행에도 남긴다 — 위 줄은 `info` 라 `orch_status` 의 로그 꼬리가 걸러 내므로,
    //   이 한 줄이 없으면 재구성 본문은 서수가 왜 그 수부터인지 말할 자리가 없다(최종 리뷰 M17).
    context.setRunIdentity?.({ resumedFrom: resume.from });
  }
  const room = await refuseWhenNoResumeRoom({
    resume, budget, runId,
    cleanupWorktrees: (label) => cleanupPreparationWorktrees(laneWorktrees, label),
    envelopeExtras: (notices = []) => envelopeExtras([...sweepSummaries, ...notices]),
  });
  if (room.refusal !== null) return halt(room.refusal);
  if (candidateCount === 2) {
    const laneB = await createLaneBWorktree({
      preparedLaneA, baseline, canonicalProject, stateRoot, runId, deps, stage, recoveryStage,
      cleanupWorktrees: cleanupPreparationWorktrees, runHalt,
      envelopeExtras: (notices = []) => envelopeExtras([...sweepSummaries, ...notices]),
    });
    if (laneB.refusal !== null) return halt(laneB.refusal);
    laneWorktrees.push(laneB.laneWorktree);
  }
  context.setRunIdentity?.({
    runId,
    stateRoot,
    worktreePath: preparedLaneA.path,
    worktreePaths: laneWorktrees.map((worktree) => worktree.path),
  });
  // ★★ 의존성 제공(WS4a 태스크 5 — 로드맵 §3.6 의 옵트인 (a)). 자리의 근거가 셋이고, 셋 다
  //   **바로 위 줄들이 방금 참으로 만든 것**이다:
  //   (1) 두 레인의 워크트리가 **둘 다** 있다 — 제공은 레인마다 한 번이고, 공유 캐시 덕에
  //       둘째 설치는 오프라인으로 끝난다.
  //   (2) `setRunIdentity` 가 방금 그 경로들을 이 실행의 authoring 워크트리로 등록했다. 그래야
  //       설치 자식이 리퍼 원장과 트리 킬 대상에 제대로 오른다(`onSpawn` 의 `childWorktree` 판정).
  //   (3) 아직 어떤 델리게이트도 안 떴다. 워크트리는 baseline 과 바이트가 같으므로 npm 이 읽는
  //       `package.json`·`.npmrc`·잠금 파일은 전부 **사용자가 커밋한 것**이다 — 러너의 머리
  //       주석이 `npm install` 을 거부한 이유(워크트리 `package.json` 은 델리게이트가 쓴다)가
  //       이 시점에는 성립하지 않는다.
  // ★ 옵트인 판정을 여기서 다시 하지 않는다. 관문은 `provisionRequested` **하나**이고 그것은
  //   제공기 안에 있다 — 여기에 사본을 두면 「옵트인 없이는 절대 실행되지 않음」의 증명이
  //   두 자리로 갈린다. 옵트인이 없는 실행에서 이 호출은 git 도 자식도 건드리지 않고 되돌아온다.
  // ★ 설정은 **워크트리에서 읽지 않는다.** 계획을 동결할 때 커밋 오브젝트에서 읽은 값이
  //   `baselineConfig` 로 와 있고, 이 자리에서 파일을 여는 코드는 한 줄도 없다.
  // ★ `mayTouchWorktree` 인 이유: 설치는 워크트리에 **쓴다**. 권위가 중간에 회수되면 무엇이
  //   남았는지 우리가 모르고, 그 사실은 봉투가 말해야 한다.
  const provisionNotices = [];
  /**
   * ★★ 준비 단계의 halt 가 싣는 봉투 부속 — **이 실행이 이미 한 일은 사라지지 않는다.**
   *
   * `provisionNotices` 와 `configNotices` 는 한참 아래(`src/run-planner.mjs` 가 짓는
 * `plannerNotices`)에서 처음 읽히는데,
   * 그 사이에는 halt 가 여럿이다. 그 자리들이 `[...sweepSummaries, ...cleanup.notices]` 만
   * 실으면 **의존성을 실제로 설치하고 `<stateRoot>/cache/npm` 을 만든 실행**이 그 사실을 한
   * 글자도 말하지 않는 봉투로 끝난다 — 그리고 `deps_provisioned` 는 「stateRoot 밖에 쓰지
   * 않는다」(전역 제약 §5.5)를 봉투가 말하는 **유일한** 자리다. 캐시는 halt 를 넘어 살아남고
   * (회수는 워크트리만 지운다, 보관 정책은 WS6), 그래서 이 문장은 halt 에서 더 필요하다.
   * `project_config_reporter_unavailable` 도 같은 경로에서 같은 이유로 잃고 있었다.
   */
  const preparationExtras = (cleanupNotices) =>
    envelopeExtras([...sweepSummaries, ...configNotices, ...provisionNotices, ...cleanupNotices]);
  const provisionDependencies = deps.provisionDependencies ?? defaultProvisionDependencies;
  for (const lane of laneWorktrees) {
    const provisioned = await stage('dependency provisioning', () => provisionDependencies({
      config: baselineConfig,
      baselineCommit: baseline.commit,
      worktreePath: lane.path,
      stateRoot,
      runId,
      signal: deadline,
      onSpawn: (child) => onSpawn(child, { worktreePath: lane.path, ownerWorktreePath: lane.path }),
    }), { mayTouchWorktree: true, worktreePath: lane.path });
    // release는 npm 효과가 난 **뒤**의 정리 경계다. 상위 schema 때문에 lease를 못 내렸어도
    // 성공한 설치를 실패로 뒤집지 않고, 정확한 좌표를 최종 봉투 notice에 합친다.
    const cacheLeaseRelease = provisioned?.cacheLeaseRelease;
    const releaseSchemaNotice = stateSchemaNotice(cacheLeaseRelease?.stateSchema);
    if (releaseSchemaNotice !== null) {
      provisionNotices.push(releaseSchemaNotice);
    } else if (cacheLeaseRelease?.ok === false) {
      // 일반 해제 실패도 상위 schema와 같이 성공한 설치를 뒤집지 않는다. 다만 두 문구를
      // 같이 싣지 않는다: schema 좌표가 있으면 표준 알림이 더 정확한 진단이다.
      provisionNotices.push(renderNotice('deps_cache_lease_release_failed', {}));
      logLine('warn', null, 'package cache lease release', {
        status: typeof cacheLeaseRelease.status === 'string' && cacheLeaseRelease.status !== ''
          ? cacheLeaseRelease.status
          : UNKNOWN_VALUE,
        detail: typeof cacheLeaseRelease.detail === 'string' ? cacheLeaseRelease.detail : '',
      });
    }
    // ★★ carry 하기 **전에** 「누가 껐는가」를 먼저 가른다 — 형제 단계들과 같은 규율이다
    //   (이 파일의 저장소 점검, `src/run-worktrees.mjs` 의 레인 준비 둘). 제공기는 실행이 멈췄다는
    //   사실만 알고 그 이유는 모르므로 코드 없이 중립으로 돌아온다(`{ok:false, hardStopped:true}`);
    //   이름은 `haltReasonCode()` 가 붙인다. 이 줄이 없으면 정지 버튼을 누른 사용자가
    //   `deps_unavailable` 과 「잠금 파일을 커밋하라」는 조언을 받는다(재리뷰 Important 1).
    if (provisioned?.hardStopped === true || deadline?.aborted === true) {
      const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'dependency provisioning halt');
      return halt(runHalt({ runId, extras: preparationExtras(cleanup.notices) }));
    }
    if (provisioned?.ok !== true) {
      const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'dependency provisioning refusal');
      // status 는 실려 갈 코드의 조악값이 정한다(설정 봉인 관문과 같은 규칙) — 손으로 고르지 않는다.
      // lease 획득은 공유 상태에 쓰는 경계다. 중간 제공기의 deps_unavailable fallback보다
      // 저수준 리더가 보존한 상위 schema 좌표가 우선해야 업데이트 회복이 최종 봉투에 남는다.
      const carried = stateSchemaReason(releaseSchemaNotice === null ? provisioned?.stateSchema : undefined) ??
        carriedFailure(provisioned, { path: projectPath, waitMs: effectiveWaitMs });
      return halt(failure({
        status: carried.reasonCode === undefined ? 'blocked' : statusOfReasonCode(carried.reasonCode),
        confidence: confidenceOfRun({ unverified: true }), runId,
        ...carried, ...preparationExtras(cleanup.notices),
      }));
    }
    if (releaseSchemaNotice === null) {
      const schemaNotice = stateSchemaNotice(provisioned?.stateSchema);
      if (schemaNotice !== null) provisionNotices.push(schemaNotice);
    }
    if (Array.isArray(provisioned.notices)) provisionNotices.push(...provisioned.notices);
  }
  const roles = await bindRunRoles({
    providers, runOptions, candidateCount, taskClass, baselineConfig, stateRoot, runId, deadline,
    deps, stage, logLine, configNotices, preparationExtras,
    cleanupWorktrees: (label) => cleanupPreparationWorktrees(laneWorktrees, label),
  });
  if (roles.refusal !== null) return halt(roles.refusal);
  const {
    controls, decisions, decisionSources, plannerProvider, writerProvider, verifierProvider, tier,
    plannerBinding, laneBindings, laneProviders, effectiveChoices, plannerEvidence, judgeBindings,
  } = roles;
  const usageAccumulator = createRunUsageAccumulator();
  // 벤더 결함 장부 — 실행 하나가 본 결함을 순서대로 들고 있다가 봉투 조립이 코드 하나와
  // 발췌 ≤3 과 벤더별 드리프트 한 줄을 꺼낸다(`src/run-faults.mjs`).
  const faultRegistry = createFaultRegistry({ logLine, redact: context.redact });
  const callProvider = createProviderCall({
    runFacts, progress, runOptions, candidateCount, runId, deadline, deadlineAt, now,
    stage, logLine, onSpawn, usageAccumulator, recordProviderOutcome: faultRegistry.recordProviderOutcome,
  });
  const planner = await runPlannerPhase({
    task, runId, stateRoot, frozenTestPlan, plannerProvider, plannerBinding, plannerEvidence,
    configNotices, provisionNotices, deps, recoveryStage, logLine, killLiveChildren, callProvider,
  });
  const { plan, plannedByModel, plannerUsage, plannerNotices } = planner;

  if (deadline?.aborted === true || now() >= deadlineAt) {
    const cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'post-planner authoring');
    return halt(runHalt({
      runId, extras: envelopeExtras([...sweepSummaries, ...plannerNotices, ...cleanup.notices]),
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
    )).catch(() => fail(REASON.artifact_store_initialization_failed));
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
        (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: preparedLaneA.path, projectPath: preparedLaneA.projectPath })).catch(() => false);
      cleanup = { paths: [preparedLaneA.path], notices: [handoffNotice(tracked, preparedLaneA.path)] };
    } else {
      cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'artifact initialization worktree');
    }
    const reasonCode = artifactStoreFailure?.hardStopped === true
      ? REASON.artifact_store_authority_lost
      : artifactStoreFailure?.blocked === true
        ? reasonCodeOf(artifactStore, REASON.artifact_store_initialization_failed)
        : REASON.artifact_store_invalid;
    return halt(artifactBlocked(runId, reasonCode, { runId }, envelopeExtras([
      ...sweepSummaries, ...plannerNotices, ...cleanup.notices,
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
    let cleanup;
    if (candidateCount === 1) {
      // ★ 리퍼가 받았는지 아닌지가 **다른 문장**이다(`handoffNotice`). 이 자리에 있던 삼항이
      //   `=== handoffNotice(true, …)` 로 뭉개져 알림 배열에 리터럴 `false` 가 실렸었다 —
      //   워크트리가 어디 남았는지가 통째로 사라진다.
      const tracked = await recoveryStage('artifact authority worktree handoff', () =>
        (deps.trackWorktree ?? defaultTrackWorktree)({ stateRoot, runId, worktree: preparedLaneA.path, projectPath: preparedLaneA.projectPath })).catch(() => false);
      cleanup = { paths: [preparedLaneA.path], notices: [handoffNotice(tracked, preparedLaneA.path)] };
    } else {
      cleanup = await cleanupPreparationWorktrees(laneWorktrees, 'artifact authority worktree');
    }
    return halt(artifactBlocked(runId, REASON.artifact_store_invalid, { runId }, envelopeExtras([
      ...sweepSummaries, ...plannerNotices, ...cleanup.notices,
    ])));
  }

  await recordPlannerCanon({ ...planner, artifactStore, runId, deps, recoveryStage, logLine });

  const testQueue = createSerialTestQueue({ now });
  const evidenceCache = new Map();
  const prepared = {
    ok: true, runId, stateRoot, deadlineAt, candidateCount, frozenTestPlan, baseline,
    laneWorktrees: Object.freeze([...laneWorktrees]), laneBindings: Object.freeze([...laneBindings]),
    proofRequirement, preflight, plannerBinding, plan, plannedByModel, plannerUsage,
    artifactPaths: pathBudget.paths, artifactStore, manifestAuthority: revisionZeroAuthority, testQueue, evidenceCache,
    artifactRevisionAuthority: { latest: 0 },
    usageAccumulator, sweepNotice: sweepSummaries[0] ?? null,
    // 허용목록은 실행 하나에 하나다(위 합집합). 레인이 아니라 준비가 들고 있는 이유는 `baseline`
    // 과 같다 — 레인마다 다시 접으면 두 레인이 다른 허용목록으로 같은 패치를 판정할 수 있다.
    scopeAllow: scopeAllow.entries,
    // 재개의 사실들(`from`·`reusedAttempts`·`startOrdinal`·`noticeParams`). 레인은 여기서 시작
    // 서수를 받고, 종료 경로는 여기서 알림을 짓는다 — 두 소비자가 같은 값을 읽는다.
    resume,
  };
  PREPARATION_PRIVATE.set(prepared, {
    taskClass, decisions, decisionSources, plannerProvider, writerProvider, verifierProvider,
    laneProviders, judgeBindings: Object.freeze([...judgeBindings]), tier, plannerNotices, callProvider, pathBudget, progress,
    effectiveChoices, learningMutationEnabled: controls.mutationEnabled, faultRegistry,
  });
  return Object.freeze(prepared);
}

async function orchestrateQuality(options, onLogOpened = null) {
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
      return failure({
        status: 'invalid', reasonCode: REASON.config_provider_unknown,
        params: { role, vendor: show(wanted), vendors: ids.join(', ') || NO_VENDORS },
      });
    }
  }

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const effectiveWaitMs = waitMs > 0 ? Math.ceil(Math.min(waitMs, MAX_WAIT_MS)) : MAX_WAIT_MS;
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(startedAt + effectiveWaitMs)) {
    return failure({ status: 'invalid', reasonCode: REASON.run_deadline_unrepresentable });
  }
  const deadlineAt = startedAt + effectiveWaitMs;
  // ★★ 정지 권위는 **접힌 신호 하나**다(WS3 §0-C1). 벤더도, 이음매의 하드스톱도, 자식 회수도
  //   전부 `deadline` 을 보므로 호스트 취소가 마감과 **정확히 같은 만큼** 잘 듣는다 — 취소용
  //   두 번째 경로를 만들면 그 경로가 안 닿는 이음매가 반드시 생긴다.
  // ★★ 그런데 「누가 껐는가」는 접힌 신호가 답하지 못한다. 그 답의 유일한 권위는 **소스**이고
  //   (`hostSignal.aborted`), 그것을 읽는 자리가 아래 `haltReasonCode` 하나다. 결함 문구를 보고
  //   가르는 자리는 어디에도 없다 — 우리가 자른 실행은 POSIX 에서 시그널 킬이라, 사유를 신호
  //   **앞에** 두지 않으면 우리 마감이 벤더 결함으로 읽힌다(WS2 §14).
  const hostSignal = options.hostSignal;
  const deadlineSignal = timeoutSignal(effectiveWaitMs);
  const deadline = haltSignal(deadlineSignal, hostSignal);
  const hardStopGraceMs = Number.isFinite(deps.hardStopGraceMs) && deps.hardStopGraceMs > 0
    ? deps.hardStopGraceMs
    : HARD_STOP_GRACE_MS;
  // ── 실행별 로그(WS2 §5) · 벤더 결함 장부와 같은 자리(`src/run-faults.mjs`)에 산다 ──────
  // 핸들은 상태 루트가 정해진 뒤에 열린다. 열리기 전의 봉투는 `log` 를 안 달고 나가고, 그것이
  // "로그가 없다" 의 유일한 정당한 경우다. 열기 실패는 실행을 떨어뜨리지 않고 알림 하나가 된다.
  const { openLog, logLine, closeLog, addNotice, envelopeExtras, redact: redactText } = createRunLog({ onLogOpened });
  let runStateRoot = null;
  let worktreePath = null;
  const authoringWorktreePaths = new Set();
  let activeRunId = null;
  let runProjectPath = projectPath;
  // ★ 재개의 출처. 저널 행에 실려야 하는 이유(최종 리뷰 I5·M17): 오늘 이 사실이 남는 유일한
  //   영구 채널은 로그의 `info` 한 줄인데, 그 레벨은 `orch_status` 의 꼬리 필터가 걸러 낸다 —
  //   그래서 재구성 본문은 서수가 3 부터 시작하는 이유를 어디에서도 말하지 못했다.
  let runResumedFrom = null;
  let runJournaled = false;
  let worktreeEffectUnknown = false;
  const effectUnknownPaths = new Set();
  let intentArmFailure = null;
  let intentArmNotice = null;

  /**
   * 이 실행이 멈춘다면 **누가 껐는가**(WS3 §0-C1/C2). 벤더에게 간 신호는 접힌 하나라 그 뒤에는
   * 소스만이 답을 안다 — 그래서 가르는 자리가 저장소 전체에 이 한 줄뿐이다.
   */
  const haltReasonCode = () => (hostSignal?.aborted === true ? REASON.run_cancelled : REASON.run_deadline_exceeded);
  /**
   * 종료 봉투 둘 중 하나. 열 자리(사전 점검 halt 넷 · 레인 halt 하나 · C1 둘 · C2 셋)가 이것을
   * 부르고, 그 열 자리 어디에도 코드를 고르는 삼항이 없다 — 있으면 한 자리만 고쳐지는 날이 온다.
   */
  const runHalt = ({ runId, extras = {}, content, contentFallback }) => {
    const reasonCode = haltReasonCode();
    // 「왜 멈췄나」의 진단 한 줄. 종료 sink 의 `run_finished` 는 판정을 적고, 이 줄은 **소스**를
    // 적는다 — 취소가 왔는데 마감으로 끝난(또는 그 반대의) 실행을 로그만 보고 가릴 수 있어야 한다.
    logLine('warn', reasonCode, 'run halted', {
      runId: runId ?? '', source: reasonCode === REASON.run_cancelled ? hostAbortReason() : 'deadline',
    });
    return reasonCode === REASON.run_cancelled
      ? runCancelled({ runId, extras, content, contentFallback })
      : runDeadline({ runId, effectiveWaitMs, extras, content, contentFallback });
  };
  /** 호스트가 abort 에 실은 이유(`host_cancel`/`host_shutdown`). 문자열이 아니면 로그에 안 적는다. */
  const hostAbortReason = () => (typeof hostSignal?.reason === 'string' ? hostSignal.reason : 'host');
  /**
   * 이음매가 신호를 무시해 유예까지 간 자리의 실패. 코드는 여기서도 **소스**가 정한다 —
   * 호스트가 끊었는데 로그와 장부가 "마감이 지났다" 고 적으면 두 채널이 다른 말을 한다.
   */
  const haltFail = (label, message) => {
    const reasonCode = haltReasonCode();
    logLine('warn', reasonCode, message, { stage: label });
    return fail(reasonCode, reasonCode === REASON.run_deadline_exceeded ? { waitMs: effectiveWaitMs } : {}, { hardStopped: true });
  };

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
    const affectedPath = touchedPath ?? worktreePath;
    let intentToken = null;
    if (mayTouchWorktree && affectedPath !== null) {
      const observed = now();
      const retainUntil = Number.isSafeInteger(observed) && observed >= 0 &&
        observed <= Number.MAX_SAFE_INTEGER - RUN_ARTIFACT_RETENTION_MS
        ? observed + RUN_ARTIFACT_RETENTION_MS
        : Number.MAX_SAFE_INTEGER;
      const armed = await raceHardStop(Promise.resolve().then(() =>
        (deps.armEffectUnknownIntent ?? defaultArmEffectUnknownIntent)({
          stateRoot: runStateRoot,
          runId: activeRunId,
          worktree: affectedPath,
          projectPath: runProjectPath,
          retainUntil,
        })).catch(() => ({ ok: false, status: 'write_failed' })));
      if (armed === HARD_STOP) {
        addNotice(renderNotice('stage_authority_revoked', { stage: label }));
        return haltFail(label, 'recovery intent arm authority lost');
      }
      // The arm can settle during the hard-stop grace after the run has already lost
      // authority. In that ordering the effect has not started, and must stay uncalled.
      if (deadline?.aborted === true) {
        addNotice(renderNotice('stage_authority_revoked', { stage: label }));
        return haltFail(label, 'recovery intent arm authority lost');
      }
      const schemaNotice = stateSchemaNotice(armed?.stateSchema);
      // Fatal arm failures are rebuilt into a blocked envelope after common finalization.
      // Keep this notice separate so it is not appended to an envelope that already contains it.
      if (schemaNotice !== null) intentArmNotice ??= schemaNotice;
      if (armed?.ok !== true || !/^[0-9a-f]{64}$/.test(armed?.token ?? '')) {
        intentArmFailure ??= stateSchemaReason(armed?.stateSchema) ?? {
          reasonCode: REASON.state_recovery_intent_unavailable,
          params: {},
        };
        logLine('warn', intentArmFailure.reasonCode, 'recovery intent arm failed', { stage: label });
        return fail(intentArmFailure.reasonCode, intentArmFailure.params, { hardStopped: true });
      }
      intentToken = armed.token;
    }

    const disarmIntent = async () => {
      if (intentToken === null) return true;
      const disarmed = await raceHardStop(Promise.resolve().then(() =>
        (deps.disarmEffectUnknownIntent ?? defaultDisarmEffectUnknownIntent)({
          stateRoot: runStateRoot,
          runId: activeRunId,
          worktree: affectedPath,
          token: intentToken,
        })).catch(() => ({ ok: false, status: 'write_failed' })));
      const notice = stateSchemaNotice(disarmed?.stateSchema);
      if (notice !== null) addNotice(notice);
      return disarmed !== HARD_STOP && disarmed?.ok === true;
    };

    const pending = Promise.resolve().then(call);
    let settled;
    try {
      settled = await raceHardStop(pending);
    } catch (error) {
      await disarmIntent();
      throw error;
    }
    if (settled !== HARD_STOP) {
      await disarmIntent();
      return settled;
    }
    try {
      onHardStop?.(pending);
    } catch {
      // 늦은 결과를 맡기는 부가 경로가 본 실행의 데드라인 봉투를 막아서는 안 된다.
    }
    if (mayTouchWorktree && affectedPath !== null) {
      worktreeEffectUnknown = true;
      effectUnknownPaths.add(affectedPath);
    }
    addNotice(renderNotice('stage_authority_revoked', { stage: label }));
    return haltFail(label, 'stage authority revoked');
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
    if (settled !== HARD_STOP) return settled;
    return haltFail(label, 'recovery authority lost');
  };

  const treeKill = deps.treeKill ?? defaultTreeKill;
  const rawTrackChild = deps.trackChild ?? defaultTrackChild;
  const usesDefaultTrackChild = deps.trackChild === undefined;
  const rawTrackWorktree = deps.trackWorktree ?? defaultTrackWorktree;
  const trackWorktree = async (input) => {
    const result = await rawTrackWorktree(input);
    const notice = stateSchemaNotice(result?.stateSchema);
    if (notice !== null) addNotice(notice);
    return result === true;
  };
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
                // ★ 폴백은 등재된 어휘여야 한다(리뷰 소견 1). 'child' 는 phase 표 밖이라 리포터의
                //   접힘에 기대어만 살았다 — 오늘 두 호출부 모두 role 을 채우므로 죽은 가지지만,
                //   죽은 가지가 표 밖 값을 들고 있으면 표를 넓힌 사람이 이 자리를 못 찾는다.
                phase: role ?? 'infra',
                step: attemptId === null ? judgeIndex ?? 0 : Number(attemptId.slice(-3)),
                laneId,
                attemptId,
                role,
                judgeIndex,
                // 자식 spawn 줄도 같은 실행 사실 셋을 싣는다 — 이 채널만 runId 없이 오면
                // 알림 한 줄이 어느 실행의 것인지 못 말한다(WS3 §0-P1).
                runId: activeRunId,
                budget,
                candidates: candidateCount,
                event: { type: 'spawn', laneId, attemptId, role, judgeIndex },
              });
            } catch {
              // Progress is advisory.
            }
          }
          return Promise.resolve(rawTrackChild({ stateRoot: runStateRoot, child, runId: activeRunId, worktree: childWorktree }))
            .then((value) => {
              const notice = stateSchemaNotice(value?.stateSchema);
              if (notice !== null) addNotice(notice);
              return usesDefaultTrackChild ? value === undefined || value === true : value === true;
            }, () => false);
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
  const setRunIdentity = ({ runId, stateRoot, projectPath: project, resumedFrom, worktreePath: path, worktreePaths = [] } = {}) => {
    if (typeof runId === 'string') activeRunId = runId;
    if (typeof stateRoot === 'string') runStateRoot = stateRoot;
    if (typeof resumedFrom === 'string') runResumedFrom = resumedFrom;
    // ★ 정준화된 프로젝트 경로는 사전 점검보다 **뒤**에 정해진다 — 거기까지 못 간 실행의 종료
    //   행에는 호출자가 준 경로가 실린다(둘 다 절대 경로이고, 갈리는 것은 심볼릭 링크뿐이다).
    if (typeof project === 'string') runProjectPath = project;
    if (typeof path === 'string') {
      worktreePath = path;
      authoringWorktreePaths.add(path);
    }
    if (Array.isArray(worktreePaths)) {
      for (const value of worktreePaths) if (typeof value === 'string') authoringWorktreePaths.add(value);
    }
  };

  /** 종료 기록 여덟 키. 학습 행과 종료 sink 가 같은 값을 내야 하므로 짓는 자리는 하나다. */
  const terminalRow = (outcome) => runTerminalKeys({
    projectPath: runProjectPath, task, startedAt, finishedAt: now(), resumedFrom: runResumedFrom,
    outcome, redact: redactText,
  });
  /**
   * ★★ 종료 sink — 실행마다 **정확히 한 번**(최상위 catch 경로 포함). 봉투는 디스크에 남지
   *   않으므로(WS3 §0-D1) 저널 행 하나와 이 로그 줄 하나가 실행의 유일한 영구 기록이고,
   *   `orch_status` 가 읽는 것이 그것이다.
   * ★ 저널 쓰기가 `closeLog()` **앞**인 이유 둘: 세척기는 로그 핸들과 같은 수명이라 닫은 뒤의
   *   `redact` 는 항등이다(세척한 적 없는 taskPreview 가 디스크에 남는다). 그리고 쓰기 실패를
   *   적을 채널이 그때는 없다.
   * ★ 학습이 이미 행을 썼으면 여기서는 **안 쓴다** — 저널은 runId 당 마지막 줄이 이기므로 한
   *   줄을 더 얹으면 그 행의 학습 키가 통째로 사라진다. 그 실행의 종료 키는 학습 행에 탄다.
   */
  const settleRun = async (envelope, thrownCode = null) => {
    const outcome = envelope === null
      ? terminalOutcome({ reasonCode: thrownCode })
      : terminalOutcomeOf(envelope);
    logLine(outcome.status === 'succeeded' ? 'info' : 'error', outcome.reasonCode, 'run_finished', {
      runId: activeRunId ?? '', status: outcome.status, stopReason: outcome.stopReason ?? '',
      reasonCode: outcome.reasonCode ?? '', confidence: envelope?.confidence ?? '',
    });
    if (runJournaled || activeRunId === null || runStateRoot === null) return;
    // 기록 실패는 봉투를 막지 않는다(학습과 같은 등급의 부가 채널). 밖에서 온 값이라 던지든
    // `{ok:false}` 를 내든 한 갈래로 접고, 사연은 `errorText` 를 지난다(bare `String()` 금지).
    const wrote = await Promise.resolve()
      .then(() => (deps.appendRun ?? appendRun)(runStateRoot, { runId: activeRunId, ...terminalRow(outcome) }))
      .catch((error) => ({ ok: false, error }));
    if (wrote?.ok !== true) {
      logLine('warn', reasonCodeOf(wrote, REASON.learning_journal_record_invalid), 'run_record_incomplete', { detail: errorText(wrote?.error) });
    }
  };

  deadline?.addEventListener?.('abort', onDeadlineAbort, { once: true });
  if (deadline?.aborted === true) onDeadlineAbort();
  try {
    const sharedContext = {
      options,
      deps: { ...deps, trackWorktree },
      task,
      projectPath,
      budget,
      deadlineAt,
      // ★ 이 실행이 시작한 시각. 마감을 짓느라 이미 읽어 둔 값이고(같은 함수가 그 위에서 `deadlineAt`
      //   을 세운다), 종료 조립이 봉투의 `cost.elapsedMs` 를 재는 유일한 기준점이다 — 저 아래
      //   저널 행이 쓰는 것과 **같은** 시작 시각이라 두 채널이 다른 실행 시간을 말하지 않는다.
      startedAt,
      deadline,
      effectiveWaitMs,
      registered,
      now,
      stage,
      recoveryStage,
      // 취소·마감의 갈림은 여기서 **닫힌 두 함수**로만 나간다 — 하위 자리가 `hostSignal` 자체를
      // 받으면 각자 다른 판정 규칙을 쓰게 된다.
      haltReasonCode,
      runHalt,
      onSpawn,
      killLiveChildren,
      setRunIdentity,
      isWorktreeEffectUnknown: (path = null) => path === null ? worktreeEffectUnknown : effectUnknownPaths.has(path),
      openLog,
      logLine,
      // 준비 단계도 알림 통에 직접 넣는다 — 크레딧 전 예측의 경고 넷이 그 첫 소비자다.
      addNotice,
      envelopeExtras,
      redact: redactText,
      terminalRow,
      noteRunJournaled: () => { runJournaled = true; },
      /**
       * ★ WS3 §0-M2 strangler 이음매. 종료 경로는 `src/run-finalization.mjs` 에 살고, 아직
       *   엔진이 소유한 준비·레인 두 단계와 그 비공개 상태를 여기서 **넘겨준다**. 셋 다
       *   복제할 수 없는 것들이다: 두 단계는 C2 도 부르는 700줄짜리 함수이고,
       *   `PREPARATION_PRIVATE` 는 준비 단계가 채운 바로 **그** WeakMap 이어야 한다.
       *   반대 방향(run-finalization → engine)의 수입은 순환이라 존재할 수 없으므로, 이 객체가
       *   그 방향의 유일한 통로다. 후보 1개·2개가 **같은** 셋을 쓰므로 접을 때도 안 자랐다.
       */
      finalizationSeam: { prepareRunNamespace, runPreparedLane, PREPARATION_PRIVATE },
    };
    // ★ 호출부는 하나다. 후보 수로 갈리던 삼항은 WS3 태스크 10 이 없앴다 — 종료 경로는 그 수를
    //   `preparation.candidateCount` 에서 데이터로 읽는다(`src/run-finalization.mjs` 머리말).
    let envelope = await finalizeRun(sharedContext);
    if (intentArmFailure !== null) {
      const notice = joinNotices([
        ...(typeof envelope?.notice === 'string' ? [envelope.notice] : []),
        ...(intentArmNotice === null ? [] : [intentArmNotice]),
      ]);
      envelope = failure({
        status: 'blocked',
        runId: activeRunId,
        ...intentArmFailure,
        ...(envelope?.log === undefined ? {} : { log: envelope.log }),
        ...(notice === null ? {} : { notice }),
      });
    }
    // ★ 실행이 **왜** 그렇게 끝났는지는 로그의 마지막 줄이다. 앞선 줄들은 단계별 사실이고, 이
    //   줄만이 봉투가 실제로 낸 판정을 적는다 — 둘이 갈리면 로그를 읽는 쪽이 먼저 안다.
    await settleRun(envelope);
    return envelope;
  } catch (error) {
    // 최상위 catch(`runOrchestration`)가 낼 봉투와 **같은 코드**로 기록하고 그대로 다시 던진다 —
    // 여기서 삼키면 그 봉투의 바이트가 이 자리로 옮겨 온다.
    await settleRun(null, REASON.run_orchestration_failed);
    throw error;
  } finally {
    closeLog();
    await killLiveChildren();
    try {
      deadline?.removeEventListener?.('abort', onDeadlineAbort);
    } catch {
      // listener 제거를 지원하지 않는 AbortSignal 구현이면 once 동작에 맡긴다.
    }
  }

}
