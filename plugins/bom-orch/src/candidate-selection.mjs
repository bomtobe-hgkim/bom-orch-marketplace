import { isAbsolute } from 'node:path';
import { CODEX_PROMPT_BUDGET_CHARS, codexArgvChars } from './preflight.mjs';
import { REASON } from './reason-codes.mjs';
import { unfenceProviderJson } from './verdict.mjs';
import { validLane } from './manifest-vocabulary.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { cloneData, exactDenseArray, exactObject, hasExactKeys, ownDataValue } from './util/objects.mjs';
import { boundedText, clipWhole, compareUtf8, hasForbiddenText as hasForbiddenChars, isSafeCount } from './util/strings.mjs';

const TERMINAL_CLASSES = new Set(['verified', 'usable_unverified']);
const ROLES = new Set(['worker', 'verifier']);
const TIERS = new Set(['fast', 'strong']);
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[._-]|$)/i;
const INVALID_AUTHORITY = Symbol('invalid-authority');

/** 공유 `boundedText` 의 boolean 어댑터 — 이 파일의 호출부는 검사한 값을 조건으로만 쓴다. */
function boundedString(value, max) {
  return boundedText(value, max) !== null;
}

function cloneAuthorityData(value, state = { seen: new Map(), nodes: 0 }) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object' || ++state.nodes > 100_000) return INVALID_AUTHORITY;
  try {
    if (state.seen.has(value)) return state.seen.get(value);
    const array = Array.isArray(value);
    if (array) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID_AUTHORITY;
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      const keys = Reflect.ownKeys(value);
      if (!length || !Object.hasOwn(length, 'value') || length.enumerable || keys.length !== length.value + 1 ||
          keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)))) return INVALID_AUTHORITY;
      const clone = [];
      state.seen.set(value, clone);
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return INVALID_AUTHORITY;
        const child = cloneAuthorityData(descriptor.value, state);
        if (child === INVALID_AUTHORITY) return INVALID_AUTHORITY;
        clone.push(child);
      }
      if (Object.isFrozen(value)) Object.freeze(clone);
      return clone;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return INVALID_AUTHORITY;
    const clone = {};
    state.seen.set(value, clone);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return INVALID_AUTHORITY;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return INVALID_AUTHORITY;
      const child = cloneAuthorityData(descriptor.value, state);
      if (child === INVALID_AUTHORITY) return INVALID_AUTHORITY;
      clone[key] = child;
    }
    if (Object.isFrozen(value)) Object.freeze(clone);
    return clone;
  } catch {
    return INVALID_AUTHORITY;
  }
}

function deeplyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value) || !Object.isFrozen(value)) return false;
  seen.add(value);
  try {
    return Object.values(value).every((child) => deeplyFrozen(child, seen));
  } catch {
    return false;
  }
}

function validRoleBinding(value, role) {
  const object = exactObject(value, ['providerId', 'model', 'effort', 'tier', 'role']).value ?? null;
  return object !== null && boundedString(object.providerId, 128) &&
    (object.model === null || boundedString(object.model, 128)) &&
    (object.effort === null || boundedString(object.effort, 64)) &&
    TIERS.has(object.tier) && ROLES.has(object.role) && object.role === role;
}

function validBinding(value) {
  const object = exactObject(value, ['writer', 'verifier']).value ?? null;
  return object !== null && deeplyFrozen(value) &&
    validRoleBinding(object.writer, 'worker') && validRoleBinding(object.verifier, 'verifier');
}

function committedAttempt(candidate, patch) {
  if (!Array.isArray(candidate.attempts)) return null;
  const matches = candidate.attempts.filter((entry) => entry?.attemptId === patch.sourceAttemptId);
  if (matches.length !== 1) return null;
  const attempt = matches[0];
  const sealed = attempt?.sealed;
  const runId = patch.sourceAttemptId.split('/')[0];
  const attemptId = `${runId}/${candidate.candidateId}/${String(attempt?.ordinal).padStart(3, '0')}`;
  const exactAttempt = exactObject(attempt, ['schemaVersion', 'laneId', 'attemptId', 'ordinal', 'retryOf', 'binding', 'writerResult', 'sealed', 'verdictRef', 'usage', 'result', 'feedback']).value ?? null;
  const exactSeal = exactObject(sealed, ['commit', 'treeHash', 'patchSha256', 'testPlanFingerprint', 'evidenceIds']).value ?? null;
  const verdictRef = exactObject(attempt?.verdictRef, ['verdict', 'issueIds']).value ?? null;
  const usage = exactObject(attempt?.usage, ['writer', 'verifier']).value ?? null;
  const validUsage = (value) => hasExactKeys(value, ['calls', 'promptTokensKnown', 'evalTokensKnown', 'incomplete']) &&
    Number.isSafeInteger(value.calls) && value.calls >= 0 && Number.isSafeInteger(value.promptTokensKnown) &&
    value.promptTokensKnown >= 0 && Number.isSafeInteger(value.evalTokensKnown) && value.evalTokensKnown >= 0 &&
    typeof value.incomplete === 'boolean';
  // ★ 사슬은 **자기 첫 서수**에서 시작한다(WS3 §3, 태스크 11): 재개된 레인은 서수 3 부터 쓰고 그
  //   앞의 봉인 attempt 는 원본 실행에 있다. 촘촘함은 그대로 잰다 — 시작점만 옮겼을 뿐 목록 안의
  //   구멍은 여전히 자격 상실이고, 마지막 attempt 가 패치의 출처라는 규칙도 그대로다.
  // ★★ `retryOf` 는 시작점과 **무관하게** 서수 규칙을 따른다(불변식 9, 최종 리뷰 I3): 1 이면
  //   `null`, 아니면 앞 서수의 이름. 재개된 레인의 첫 attempt 는 그래서 이 목록에 없는 이름을
  //   가리키고, 그것이 0.2.2 리더가 요구하는 값이다. 「이 목록의 앞 항목」을 요구하는 것은 `prior`
  //   뿐이고 그쪽은 사슬의 시작을 예외로 둔다. 매니페스트 판과 근거는
  //   `src/run-manifest.mjs expectedRetryOf` 에 있다.
  const chainRetryOf = (value) => (value === 1
    ? null
    : `${runId}/${candidate.candidateId}/${String(value - 1).padStart(3, '0')}`);
  const firstOrdinal = candidate.attempts[0]?.ordinal;
  const chainStart = Number.isSafeInteger(firstOrdinal) && attempt?.ordinal === firstOrdinal;
  const prior = chainStart ? [] : candidate.attempts.filter((entry) => entry?.attemptId === attempt?.retryOf);
  const denseHistory = Number.isSafeInteger(attempt?.ordinal) && Number.isSafeInteger(firstOrdinal) &&
    firstOrdinal >= 1 && candidate.attempts.length === attempt.ordinal - firstOrdinal + 1 &&
    candidate.attempts.every((entry, index) => {
      const ordinal = firstOrdinal + index;
      return hasExactKeys(entry, ['schemaVersion', 'laneId', 'attemptId', 'ordinal', 'retryOf', 'binding', 'writerResult', 'sealed', 'verdictRef', 'usage', 'result', 'feedback']) &&
        entry.schemaVersion === 1 && entry.laneId === candidate.candidateId && entry.ordinal === ordinal &&
        entry.attemptId === `${runId}/${candidate.candidateId}/${String(ordinal).padStart(3, '0')}` &&
        entry.retryOf === chainRetryOf(ordinal) &&
        validBinding(entry.binding) && JSON.stringify(entry.binding) === JSON.stringify(candidate.binding);
    });
  const evidenceSorted = Array.isArray(sealed?.evidenceIds) && sealed.evidenceIds.every((id, index) => index === 0 ||
    compareUtf8(sealed.evidenceIds[index - 1], id) < 0);
  return exactAttempt !== null && exactSeal !== null && attempt.schemaVersion === 1 &&
    RUN_ID.test(runId) && !WINDOWS_DEVICE.test(runId) && attempt.laneId === candidate.candidateId && Number.isSafeInteger(attempt.ordinal) && attempt.ordinal > 0 && attempt.ordinal <= 999 &&
    attempt.attemptId === attemptId && attempt.retryOf === chainRetryOf(attempt.ordinal) &&
    denseHistory && (chainStart || prior.length === 1 && prior[0]?.ordinal === attempt.ordinal - 1) &&
    validBinding(attempt.binding) && JSON.stringify(attempt.binding) === JSON.stringify(candidate.binding) && attempt.writerResult === 'sealed' &&
    verdictRef !== null && verdictRef.verdict === 'PASS' && Array.isArray(verdictRef.issueIds) && verdictRef.issueIds.length === 0 &&
    usage !== null && validUsage(usage.writer) && validUsage(usage.verifier) &&
    hasExactKeys(attempt.feedback, ['openIssueIds', 'issues']) && Array.isArray(attempt.feedback.openIssueIds) &&
    attempt.feedback.openIssueIds.length === 0 && Array.isArray(attempt.feedback.issues) && attempt.feedback.issues.length === 0 &&
    attempt.result === 'accepted' && OBJECT_ID.test(sealed.commit ?? '') &&
    sealed.patchSha256 === patch.ref.sha256 && OBJECT_ID.test(sealed.treeHash ?? '') &&
    SHA256.test(sealed.testPlanFingerprint ?? '') && Array.isArray(sealed.evidenceIds) &&
    sealed.evidenceIds.length <= 20 && new Set(sealed.evidenceIds).size === sealed.evidenceIds.length && evidenceSorted &&
    sealed.evidenceIds.every((id) => new RegExp(`^${attemptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:B0|BR|C)/(?:1|2)$`).test(id)) &&
    Array.isArray(candidate.regressionProof?.evidenceIds) &&
    new Set(candidate.regressionProof.evidenceIds).size === candidate.regressionProof.evidenceIds.length &&
    candidate.regressionProof.evidenceIds.every((id) => sealed.evidenceIds.includes(id)) &&
    (candidate.regressionProof.status !== 'proved' ||
      sealed.evidenceIds.length === candidate.regressionProof.evidenceIds.length &&
      sealed.evidenceIds.every((id, index) => id === candidate.regressionProof.evidenceIds[index]))
    ? attempt
    : null;
}

function validVerdict(candidate, patch, attempt) {
  const verdict = candidate.verdict;
  const initial = hasExactKeys(verdict, ['ok', 'phase', 'verdict', 'binding', 'issues', 'notes']) &&
    verdict.phase === 'initial' && Array.isArray(verdict.issues) && verdict.issues.length === 0;
  const recheck = hasExactKeys(verdict, ['ok', 'phase', 'verdict', 'binding', 'checks', 'newIssues', 'notes']) &&
    verdict.phase === 'recheck' && Array.isArray(verdict.checks) && verdict.checks.every((check) => check?.status === 'resolved') &&
    Array.isArray(verdict.newIssues) && verdict.newIssues.length === 0;
  if (verdict?.ok !== true || verdict.verdict !== 'PASS' || !Array.isArray(verdict.notes) || !initial && !recheck) return false;
  const binding = exactObject(verdict.binding, ['candidateId', 'attemptId', 'candidatePatchSha256', 'evidenceIds']).value ?? null;
  return binding !== null && binding.candidateId === candidate.candidateId &&
    binding.attemptId === patch.sourceAttemptId && binding.candidatePatchSha256 === patch.ref.sha256 &&
    Array.isArray(binding.evidenceIds) && Array.isArray(attempt?.sealed?.evidenceIds) &&
    binding.evidenceIds.length === attempt.sealed.evidenceIds.length &&
    binding.evidenceIds.every((id, index) => id === attempt.sealed.evidenceIds[index]);
}

/**
 * **컷의 술어 — 네 번째 자리** (WS5 T4, spec §0 D12): was something flagged that nobody approved?
 *
 * ★★ The three upstream sites (patch-scope, candidate-lane, engine) decide whether a run STOPS.
 *   This one decides whether a candidate that got all the way through may WIN. Leaving it at the
 *   old `scope?.flagged !== false` while the other three moved is the silent half of the cut: the
 *   lane runs the suite, the verifier passes it, and then selection drops the only candidate and
 *   the run ends `no_candidate` - a run that spent the full cost and reported nothing about why.
 * ★ Both halves fail CLOSED when the shape states NEITHER fact. `flagged !== false` keeps a
 *   candidate whose scope was never stated out of selection, and `allowlisted !== true` takes
 *   explicit approval only.
 * ⚠ A shape that states only the approval - `{ allowlisted: true }`, with no `flagged` key - is
 *   ACCEPTED by this product (`undefined !== false` is true, `true !== true` is false). What keeps
 *   that shape out is not the predicate but the producer: only src/engine.mjs's scopeSummary makes
 *   an explicit approval claim, and it always fills all three booleans (WS5 T4 review M2).
 */
function unapprovedScope(scope) {
  return scope?.flagged !== false && scope?.allowlisted !== true;
}

/** Return whether a sealed candidate is safe to enter selection. */
function candidateEligibilityUnsafe(candidate) {
  if (candidate === null || typeof candidate !== 'object' || !validLane(candidate.candidateId) ||
      !validBinding(candidate.binding) || !TERMINAL_CLASSES.has(candidate.terminalClass) ||
      candidate.recovery !== null || unapprovedScope(candidate.scope) ||
      candidate.crossVerificationCompleted !== true ||
      !Array.isArray(candidate.issues?.openIds) || candidate.issues.openIds.length !== 0 ||
      candidate.issues?.count !== 0 || candidate.issues?.limitExceeded !== false) return false;
  // ★★ `deferred` 는 「증명이 실패했다」가 아니라 「아직 안 돌았다」다. 실행 9(2026-08-28)는
  //   여섯 칸 증명(이 저장소에서 42분)이 55분 상한에 **다섯 번째 스위트 실행에서** 잘려
  //   `unavailable` 로 접혔고, 이 줄이 그 초록 후보를 자격 없음으로 빼 버렸다. 증명은 이제
  //   `orch_prove` 것이므로 유예는 통과시키고, 시도했다가 실패한 셋은 그대로 뺀다.
  if (candidate.terminalClass === 'verified' &&
      (candidate.tests?.execution !== 'completed' || candidate.tests?.outcome !== 'pass' || candidate.tests?.stability !== 'stable' || candidate.tests?.trusted !== true ||
       candidate.tests?.complete !== true || candidate.regressionProof?.required === true &&
       !['proved', 'deferred'].includes(candidate.regressionProof.status))) return false;
  if (candidate.terminalClass === 'usable_unverified' && candidate.stopReason !== REASON.evidence_unavailable) return false;
  const patch = candidate.patch;
  const ref = patch?.ref;
  if (!hasExactKeys(patch, ['sourceAttemptId', 'ref', 'empty', 'files']) || patch.empty !== false ||
      typeof patch.sourceAttemptId !== 'string' || patch.sourceAttemptId === '' ||
      !Array.isArray(patch.files) || patch.files.some((file) => typeof file !== 'string' || file === '') ||
      !hasExactKeys(ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']) ||
      ref.kind !== 'candidate' || typeof ref.path !== 'string' || !isAbsolute(ref.path) ||
      ref.candidateId !== candidate.candidateId || !SHA256.test(ref.sha256 ?? '') ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 ||
      !Number.isSafeInteger(ref.expiresAt) || ref.expiresAt <= 0) return false;
  const attempt = committedAttempt(candidate, patch);
  return attempt !== null && validVerdict(candidate, patch, attempt);
}

function eligibleCandidateSnapshot(candidate) {
  const snapshot = cloneAuthorityData(candidate);
  if (snapshot === INVALID_AUTHORITY) return null;
  return candidateEligibilityUnsafe(snapshot) ? snapshot : null;
}

/** Return whether a sealed candidate is safe to enter selection. */
export function candidateEligibility(candidate) {
  try {
    return eligibleCandidateSnapshot(candidate) !== null;
  } catch {
    return false;
  }
}

/** Select the only c1 candidate without any judge call. */
export function selectSingleCandidate(candidate) {
  const eligible = eligibleCandidateSnapshot(candidate);
  return deepFreeze(eligible !== null
    ? {
        outcome: 'winner',
        selectedCandidateId: eligible.candidateId,
        objectiveComparison: null,
        judgeDecisions: [],
      }
    : {
        outcome: 'none',
        selectedCandidateId: null,
        objectiveComparison: null,
        judgeDecisions: [],
      });
}

const TERMINAL_RANK = Object.freeze({ verified: 1, usable_unverified: 0 });
// ★ `deferred` 와 `not_applicable` 이 **같은 3** 인 것은 의도다: 한 실행의 두 후보는 언제나 같은
//   증명 상태를 들므로 이 칸은 무승부가 되고, 선택은 안정성·열린 이슈·범위가 가른다.
const PROOF_RANK = Object.freeze({ proved: 4, not_applicable: 3, deferred: 3, not_proven: 2, unavailable: 1, flaky: 0 });
const TEST_RANK = Object.freeze({ stable_repeated_full_pass: 3, stable_one_pass: 2, unknown_or_not_run: 1, flaky: 0 });
const JUDGE_CATEGORIES = new Set(['correctness', 'security', 'requirements', 'scope', 'tests']);
const MAX_JUDGE_DIFF_BYTES = 12000;
const MAX_JUDGE_FILES = 32;
const MAX_JUDGE_ISSUE_FACTS = 20;
const MAX_JUDGE_EVIDENCE_FACTS = 20;
const MAX_JUDGE_CLAIM_CHARS = 400;
/** 원장이 받는 산문의 상한 — `src/verdict.mjs` 의 MAX_FIELD_LENGTH 와 같은 수. 사영기는 이 안의 값을 잘라 싣는다. */
const MAX_LEDGER_PROSE_CHARS = 2_000;
/**
 * 뷰 하나의 JSON 예산 — 이제 상수가 아니라 **codex 프롬프트 예산에서 거꾸로 나눈 몫**이다.
 *
 * 판사 프롬프트는 뷰를 **둘** 싣는다(`makeBlindPair` → `judgeInstruction`). 그래서 예전의
 * 24,000 은 상계 48,439자를 뜻했고, 그것은 명령줄 상한(실측 32,767, `CreateProcessW`)의 1.5배다.
 * 그리고 판사는 레인 writer 의 프로바이더로 돌므로(`src/run-finalization.mjs:814`)
 * `candidates: 2` 면 판사 하나는 **항상** codex 이고, codex 는 지시문을 argv 로 받는다
 * (`src/providers/codex-run.mjs:14`). 즉 이 초과는 사용자의 `task` 와 무관해서 크레딧 전
 * 예측으로는 막을 수 없었다 — 예측이 아니라 상한이 고쳐야 하는 결함이다(스펙 §0-D4-(γ)).
 *
 * ★★ **단위는 바이트도 길이도 아니라 `codexArgvChars` 다**(최종 리뷰 C2). 뷰는 JSON 이라
 *   따옴표가 5% 넘게 들어 있고, libuv 는 argv 원소의 `"` 마다 `\` 를 하나 더 붙인다 — 길이로
 *   재던 판에서는 예산에 딱 맞는(32,486자) 프롬프트가 명령줄에서 **34,162자**가 되어 상계
 *   픽스처도, 이 저장소가 지배적 입력이라 선언한 현실 프로필 셋도 전부 `ENAMETOOLONG` 이었다.
 *   이스케이프 비용을 **실제 내용에서** 재므로 따옴표 없는 diff 는 예산을 거의 그대로 쓴다.
 * ★ `CODEX_PROMPT_BUDGET_CHARS` 를 수입하는 이유: 예측(`preflight.argvBudget`)과 수리(여기)가
 *   **같은 수**를 나눠 써야 한다. 두 자리가 각자 수를 적으면 그중 하나는 반드시 낡는다. 그 수는
 *   이제 명령줄 상한에서 배포마다 다른 argv 앞부분의 예약분(1,024)을 뺀 잔액이다.
 * ★ 봉투 316 = `judgeInstruction`(정본 `src/prompts/instructions.mjs`)의 고정 문장과 `INPUT_JSON`
 *   래퍼를 같은 자로 잰 실측(형식 정정 판이 7자 더 길다 — 큰 쪽이다). 지역 id 는 **뷰 하나당**
 *   80자(`X-`/`Y-` 접두 2자 × 이슈 20 + 증거 20)라 아래 식의 바깥 `2 *` 는 뷰 둘이다 — 등식은
 *   상계 테스트가 조립 경로로 지키고, 스폰 테스트가 그 위에서 진짜 OS 상한을 잰다.
 */
const JUDGE_PROMPT_ENVELOPE_CHARS = 316;
const LOCAL_ID_CHARS_PER_VIEW = 2 * (MAX_JUDGE_ISSUE_FACTS + MAX_JUDGE_EVIDENCE_FACTS);
const MAX_JUDGE_VIEW_ARGV_CHARS = Math.floor(
  (CODEX_PROMPT_BUDGET_CHARS - JUDGE_PROMPT_ENVELOPE_CHARS - 2 * LOCAL_ID_CHARS_PER_VIEW) / 2,
);
const MAX_JUDGE_RATIONALE_CHARS = 2000;
const MAX_JUDGE_MAJOR_DEFECTS = 20;
const MAX_JUDGE_DEFECT_TEXT_CHARS = 1000;
// Leaves room for every Task8-bounded field even when its JSON spelling needs escaping.
const MAX_JUDGE_DECISION_UTF8_BYTES = 128 * 1024;
const PATH_TEXT = /(?:^|[\s'"`(=,:])(?:[A-Za-z]:[\\/][^\s'"`]*|\\\\[^\\/\s]+[\\/][^\s'"`]*|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@+=-]+)*)/u;
const IDENTITY_TEXT = /(?:\b(?:author|provider|model)\b\s*(?::|=)\s*[-A-Za-z0-9_.]+|\b(?:author|provider|model)\b\s+[A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*\b|\b(?:author|provider|model|lane|candidate|run|attempt|issue|evidence)(?:[_-]?id)\b|\blane[-_ ]?[ab]\b|\b[A-Z][A-Z0-9_]*-[IT]\d{1,}\b|\b[a-z0-9_-]+\/lane-[ab]\/\d{1,3}\/(?:B0|BR|C)\/\d+\b)/iu;
// Credential-value portion of the marketplace-export high-confidence leakage scan.
const CREDENTIAL_VALUE_TEXT = /(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pour]_[A-Za-z0-9]{16,}|ghs_[A-Za-z0-9_.-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const SECRET_TEXT = /(?:\b(?:api[_-]?key|token|secret|password|bearer)\s*[:=]|\b[A-Za-z0-9_]*(?:CANARY|RAW_OUTPUT|PROVIDER_(?:STDERR|STDOUT))[A-Za-z0-9_]*\b)/iu;
const DIFF_HEADER = /^(?:diff --git|index |--- |\+\+\+ |rename |copy |new file mode|deleted file mode|old mode|new mode|Binary files )/u;
const LEDGER_STATUSES = new Set(['open', 'resolved', 'superseded']);
const MACHINE_LEDGER_ID = /^[AB]-T\d{3}$/;
const VERIFIER_LEDGER_ID = /^[AB]-I\d{3}$/;

/**
 * 문자 정책(제어문자·U+FFFD·짝 없는 서로게이트)은 공유 모듈이 갖고, 이 파일이 **더** 얹는
 * 것은 누출 정책이다 — 경로·정체·자격증명·비밀 표지. 그것은 문자열의 모양이 아니라 내용에
 * 대한 규칙이라 공유 모듈로 올리지 않는다(올리면 `run-artifacts` 의 정당한 파일 경로가
 * 거부된다). `allowDiffWhitespace` 는 공유 모듈의 같은 이름(TAB·LF·CR)을 그대로 넘긴다.
 */
function hasForbiddenText(value, { allowDiffWhitespace = false } = {}) {
  return hasForbiddenChars(value, { allowDiffWhitespace }) || PATH_TEXT.test(value) ||
    IDENTITY_TEXT.test(value) || CREDENTIAL_VALUE_TEXT.test(value) || SECRET_TEXT.test(value);
}

function boundedCleanText(value, max, { allowEmpty = false, allowDiffWhitespace = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max &&
    !hasForbiddenText(value, { allowDiffWhitespace }) ? value : null;
}

const MISSING = Symbol('missing');

/**
 * 공유 `ownDataValue` 의 sentinel 어댑터 — 이 파일의 호출부는 "없다"를 `MISSING` 으로
 * 비교한다. sentinel 은 모듈 밖으로 나가지 않으므로 값처럼 비교될 위험이 없다.
 */
function ownData(value, key) {
  const found = ownDataValue(value, key);
  return found.ok ? found.value : MISSING;
}

function isDeeplyFrozen(value, seen = new Set()) {
  try {
    if (value === null || typeof value !== 'object') return true;
    if (seen.has(value) || !Object.isFrozen(value)) return false;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !isDeeplyFrozen(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function normalizeCandidateTestRank(tests) {
  try {
    if (tests?.stability === 'flaky') return 'flaky';
    if (tests.execution === 'completed' && tests.outcome === 'pass' && tests.complete === true) {
      if (tests.stability === 'stable') return 'stable_repeated_full_pass';
      if (tests.stability === 'unknown') return 'stable_one_pass';
    }
  } catch { /* fail closed below */ }
  return 'unknown_or_not_run';
}

function candidateTuple(candidate) {
  return [
    candidate.terminalClass,
    candidate.regressionProof?.status,
    normalizeCandidateTestRank(candidate.tests),
    candidate.issues?.count,
    [candidate.scope?.flagged ? 1 : 0, (candidate.scope?.reasonCount ?? NaN) + (candidate.scope?.omittedReasonCount ?? NaN)],
  ];
}

function normalizeTuple(value) {
  const tuple = exactDenseArray(value, 5);
  const scope = exactDenseArray(tuple?.[4], 2);
  if (tuple === null || tuple.length !== 5 || scope === null || scope.length !== 2 ||
      TERMINAL_RANK[tuple[0]] === undefined || PROOF_RANK[tuple[1]] === undefined ||
      TEST_RANK[tuple[2]] === undefined || !isSafeCount(tuple[3]) ||
      ![0, 1].includes(scope[0]) || !isSafeCount(scope[1])) return null;
  return [tuple[0], tuple[1], tuple[2], tuple[3], [scope[0], scope[1]]];
}

function tupleCompare(left, right) {
  const fields = ['terminalClass', 'proof', 'tests', 'openIssues', 'scope'];
  const values = [
    [TERMINAL_RANK[left[0]], TERMINAL_RANK[right[0]], 1],
    [PROOF_RANK[left[1]], PROOF_RANK[right[1]], 1],
    [TEST_RANK[left[2]], TEST_RANK[right[2]], 1],
    [left[3], right[3], -1],
  ];
  for (let index = 0; index < values.length; index += 1) {
    const [a, b, direction] = values[index];
    if (a !== b) return { result: (a > b) === (direction === 1) ? 'a' : 'b', decisiveField: fields[index] };
  }
  for (let index = 0; index < 2; index += 1) {
    if (left[4][index] !== right[4][index]) return { result: left[4][index] < right[4][index] ? 'a' : 'b', decisiveField: 'scope' };
  }
  return { result: 'tie', decisiveField: null };
}

/** Compare already-normalized objective tuples; this pure seam covers unreachable issue/scope branches. */
export function compareCandidateTuples(left, right) {
  const tupleA = normalizeTuple(left);
  const tupleB = normalizeTuple(right);
  if (tupleA === null || tupleB === null) throw new TypeError('valid comparison tuples required');
  return deepFreeze({ ...tupleCompare(tupleA, tupleB), tupleA, tupleB });
}

/** Compare two eligible sealed candidates using only the closed five-field tuple. */
export function compareCandidates(a, b) {
  const candidateA = eligibleCandidateSnapshot(a);
  const candidateB = eligibleCandidateSnapshot(b);
  if (candidateA === null || candidateB === null) throw new TypeError('eligible candidates required');
  try {
    const bytesA = candidateA.patch.ref.bytes;
    const bytesB = candidateB.patch.ref.bytes;
    const shaA = candidateA.patch.ref.sha256;
    const shaB = candidateB.patch.ref.sha256;
    if (shaA === shaB && bytesA !== bytesB) throw new TypeError('candidate patch identity mismatch');
    const compared = compareCandidateTuples(candidateTuple(candidateA), candidateTuple(candidateB));
    return shaA === shaB
      ? deepFreeze({ result: 'equivalent', decisiveField: null, tupleA: compared.tupleA, tupleB: compared.tupleB })
      : compared;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('invalid candidate comparison');
  }
}

function normalizedDiff(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  const text = bytes.toString('utf8');
  if (text.includes('\ufffd')) return null;
  const kept = [];
  let omitted = 0;
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (DIFF_HEADER.test(line) || hasForbiddenText(line, { allowDiffWhitespace: true })) {
      omitted += Array.from(line).length + (index + 1 < lines.length ? 1 : 0);
      continue;
    }
    kept.push(line);
  }
  const full = kept.join('\n');
  let excerpt = full;
  const encoded = Buffer.from(full, 'utf8');
  if (encoded.length > MAX_JUDGE_DIFF_BYTES) {
    let bytesUsed = 0;
    let length = 0;
    for (const char of full) {
      const next = bytesUsed + Buffer.byteLength(char, 'utf8');
      if (next > MAX_JUDGE_DIFF_BYTES) break;
      bytesUsed = next;
      length += char.length;
    }
    excerpt = full.slice(0, length);
    omitted += Array.from(full.slice(length)).length;
  }
  return { excerpt, omitted, digest: sha256(full) };
}

function readEntries(value) {
  const entries = ownData(value, 'entries');
  return entries === MISSING ? null : exactDenseArray(entries, 100);
}

function normalizeMachineLedgerEntry(entry) {
  // ★ `label`(2026-08-28): `applyMachineIssues` 가 machine 항목에 실패 테스트 이름을 얹는다 — 프롬프트 전용이라
  //   여기서는 **버린다**(심판은 눈을 가린 채 본다). 있으면 문자열이거나 null 이어야 하고, 그 밖의 키는 여전히
  //   거부다. 적대적 리뷰가 잡은 것: 이 관용이 없으면 여섯 번째 키 하나가 두 후보의 심판 뷰를 통째로 없앤다.
  const { label = null, ...rest } = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  if (label !== null && typeof label !== 'string') return null;
  const machine = exactObject(rest, ['id', 'namespace', 'status', 'fingerprint', 'observations']).value ?? null;
  const observations = exactDenseArray(machine?.observations, 100);
  return machine !== null && machine.namespace === 'machine' && MACHINE_LEDGER_ID.test(machine.id) &&
    LEDGER_STATUSES.has(machine.status) && SHA256.test(machine.fingerprint) && observations !== null
    ? machine
    : null;
}

function normalizeVerifierLedgerEntry(entry) {
  const status = ownData(entry, 'status');
  if (!LEDGER_STATUSES.has(status)) return null;
  const verifier = exactObject(entry, status === 'superseded'
    ? ['id', 'namespace', 'status', 'issue', 'observations', 'replacedBy']
    : ['id', 'namespace', 'status', 'issue', 'observations']).value ?? null;
  const issue = exactObject(verifier?.issue, ['category', 'claim', 'evidence', 'requiredFix']).value ?? null;
  const observations = exactDenseArray(verifier?.observations, 100);
  if (verifier === null || verifier.namespace !== 'verifier' || !VERIFIER_LEDGER_ID.test(verifier.id) || issue === null ||
      !JUDGE_CATEGORIES.has(issue.category) || typeof issue.claim !== 'string' || typeof issue.evidence !== 'string' ||
      typeof issue.requiredFix !== 'string' || observations === null) return null;
  return status !== 'superseded' || typeof verifier.replacedBy === 'string' && VERIFIER_LEDGER_ID.test(verifier.replacedBy)
    ? verifier
    : null;
}

function projectableLedgerRows(entries) {
  const rows = [];
  for (const entry of entries) {
    const namespace = ownData(entry, 'namespace');
    if (namespace === 'machine') {
      const machine = normalizeMachineLedgerEntry(entry);
      if (machine === null) return null;
      if (machine.status === 'open') rows.push({ id: machine.id, entry: machine });
      continue;
    }
    if (namespace === 'verifier') {
      const verifier = normalizeVerifierLedgerEntry(entry);
      if (verifier === null) return null;
      if (verifier.status === 'open') rows.push({ id: verifier.id, entry: verifier });
      continue;
    }
    if (namespace !== MISSING) return null;
    const id = ownData(entry, 'id');
    rows.push({ id: typeof id === 'string' ? id : '', entry });
  }
  rows.sort((left, right) => compareUtf8(left.id, right.id));
  return rows;
}

function normalizeIssueFact(entry, index, nonce) {
  const namespace = ownData(entry, 'namespace');
  if (namespace === 'machine') {
    const fingerprint = ownData(entry, 'fingerprint');
    if (ownData(entry, 'status') !== 'open' || fingerprint === MISSING || !SHA256.test(fingerprint)) return null;
    return {
      anonymousId: `I${String(index + 1).padStart(2, '0')}`,
      category: 'tests',
      claim: 'A trusted test failure remains unresolved.',
      evidenceDigest: sha256(`${nonce}\0machine\0${fingerprint}`),
    };
  }
  const nested = ownData(entry, 'issue');
  const issue = nested === MISSING ? entry : nested;
  const category = ownData(issue, 'category');
  const claim = ownData(issue, 'claim');
  const evidence = ownData(issue, 'evidence');
  // ★ 산문 필드는 원장과 **같은 정책**이어야 한다. `src/verdict.mjs` 는 issue.claim/
  //   evidence 를 `boundedProse({allowDiffWhitespace:true})` 로 받아들이므로 여러 줄 주장이
  //   원장에 정상적으로 실린다. 그런데 이 사영기가 TAB/LF/CR 을 거부하던 동안, 줄바꿈
  //   하나가 `normalizeIssueFact -> null -> buildJudgeView -> null` 로 번져 **두 레인의
  //   judge view 를 통째로** 없앴다(engine 이 `judge_view_unavailable` 로 c2 를 강등).
  //   집 스타일이 여러 줄 요약인 검증기는 그 자리에서 판정 자체를 잃는다.
  //   길이는 **자른다**, 없애지 않는다(2026-08-28 리뷰 실측): 파서는 claim 을 2,000자까지 받는데 여기서
  //   400자 초과를 null 로 접으면 같은 전파로 두 레인의 view 가 사라진다 — 실제 판정문(실행 8)은 이슈 다섯에
  //   보통 길이의 문장을 실었다. 주장은 400자에서 자르고(말줄임표), 근거는 보여주지 않고 해시만 싣기 때문에
  //   원장 상한까지 받는다. 나머지 거부(NUL·기타 제어문자·U+FFFD·짝 없는 서로게이트·경로/정체/자격증명
  //   누출)는 하나도 풀지 않는다. 이스케이프로 늘어나는 비용은 `normalizeJudgeView` 끝의
  //   MAX_JUDGE_VIEW_ARGV_CHARS 가 그대로 닫는다.
  if (category === MISSING || claim === MISSING || evidence === MISSING || !JUDGE_CATEGORIES.has(category) ||
      boundedCleanText(claim, MAX_LEDGER_PROSE_CHARS, { allowDiffWhitespace: true }) === null ||
      boundedCleanText(evidence, MAX_LEDGER_PROSE_CHARS, { allowDiffWhitespace: true }) === null) return null;
  return {
    anonymousId: `I${String(index + 1).padStart(2, '0')}`,
    category,
    claim: clipWhole(claim, MAX_JUDGE_CLAIM_CHARS - 1),
    evidenceDigest: sha256(`${nonce}\0verifier\0${evidence}`),
  };
}

function normalizeEvidenceFact(entry, index) {
  const record = ownData(entry, 'record');
  if (record === MISSING) return null;
  const kind = ownData(record, 'kind');
  const classified = ownData(record, 'classified');
  if (kind === MISSING || classified === MISSING) return null;
  const outcome = ownData(classified, 'outcome');
  const witnesses = ownData(classified, 'witnessIds');
  const denseWitnesses = witnesses === MISSING ? null : exactDenseArray(witnesses, 20_000);
  if (!['b0', 'br', 'c'].includes(kind) || !['pass', 'fail', 'unknown'].includes(outcome) || denseWitnesses === null ||
      denseWitnesses.some((id) => !SHA256.test(id))) return null;
  return { anonymousId: `E${String(index + 1).padStart(2, '0')}`, kind, outcome, witnessCount: denseWitnesses.length };
}

/**
 * 뷰가 예산을 넘으면 **거부하지 않고** diff 발췌를 한 번 더 자른다 — 축소 사다리와 같은 어휘다
 * (clip 하고 `omittedCounts` 로 라벨을 붙인다). 거부는 판사를 통째로 잃는 것이다(두 레인이 `judge_view_unavailable` 로 강등된다).
 * ★ `room` 은 **자른 뒤 라벨의 상계**(발췌를 다 지웠을 때의 값)로 잰다 — 라벨은 자르면 커지고, 십진 자릿수가 하나 늘면 직렬화도 그만큼 분다.
 * 자르기 전 라벨로 재고 더 큰 라벨을 써 넣으면 잘린 뷰가 예산을 넘어 clip 이 **다시 거부로** 뒤집힌다(실측 회귀: 포화 슬롯에서 diff 2,253~21,999자 전 구간이 null 이었다).
 * 자를 것이 다 떨어지면 — 사실 슬롯만으로 예산을 넘으면 — `normalizeJudgeView` 끝의 검사가 예전처럼 닫는다. 그쪽이 좁아진 것은 의도다:
 * 넘칠 프롬프트를 스폰하면 플래너 크레딧을 쓴 뒤 `ENAMETOOLONG` 이 나고, 카탈로그에 그 errno 가 없어 「분류하지 못한 실패」로 끝난다(메모 §D.4).
 */
function clipViewToBudget(view) {
  const cost = (value) => codexArgvChars(JSON.stringify(value));
  if (cost(view) <= MAX_JUDGE_VIEW_ARGV_CHARS) return view;
  const full = view.normalizedDiffExcerpt;
  const room = MAX_JUDGE_VIEW_ARGV_CHARS - cost({ ...view, normalizedDiffExcerpt: '', omittedCounts: { ...view.omittedCounts, diffChars: view.omittedCounts.diffChars + Array.from(full).length } });
  let used = 0;
  let length = 0;
  for (const char of full) {
    // JSON 안에서의 값이라 이스케이프된 크기로 센다(빈 문자열의 비용 4 = 따옴표 둘 + 그 이스케이프
    // 둘, 이미 위의 `room` 에 들었다). `"` 한 글자는 JSON 에서 `\"` 이고 명령줄에서 4를 먹는다.
    const next = used + cost(char) - 4;
    if (next > room) break;
    used = next;
    length += char.length;
  }
  return {
    ...view,
    normalizedDiffExcerpt: full.slice(0, length),
    omittedCounts: { ...view.omittedCounts, diffChars: view.omittedCounts.diffChars + Array.from(full.slice(length)).length },
  };
}

/** Build the only allowlisted, anonymous judge input from private lane facts. */
export function buildJudgeView(input) {
  try {
    if (input === null || typeof input !== 'object' || !/^[0-9a-f]{32}$/.test(input.blindNonce ?? '') || !validLane(input.candidate?.candidateId)) return null;
    const facts = input.privateFacts;
    if (facts === null || typeof facts !== 'object' || exactDenseArray(facts.deltaEntries, 10_000) === null || exactDenseArray(facts.persistedEvidence, 10_000) === null) return null;
    const diff = normalizedDiff(facts.patchBytes);
    const ledger = readEntries(facts.finalLedger);
    if (diff === null || ledger === null) return null;
    const files = facts.deltaEntries.slice().sort((a, b) => compareUtf8(String(a?.path ?? ''), String(b?.path ?? ''))).slice(0, MAX_JUDGE_FILES).map((entry, index) => {
      if (!['added', 'modified', 'deleted', 'renamed'].includes(entry?.status) || typeof entry.path !== 'string' || hasForbiddenText(entry.path)) throw new Error('bad delta');
      return { anonymousIndex: index + 1, status: entry.status };
    });
    const issueRows = projectableLedgerRows(ledger);
    if (issueRows === null) return null;
    const issueFacts = issueRows.slice(0, MAX_JUDGE_ISSUE_FACTS).map(({ entry }, index) => normalizeIssueFact(entry, index, input.blindNonce));
    if (issueFacts.some((entry) => entry === null)) return null;
    const evidenceRows = facts.persistedEvidence.slice().sort((a, b) => compareUtf8(String(a?.record?.evidenceId ?? ''), String(b?.record?.evidenceId ?? '')));
    const evidenceFacts = evidenceRows.slice(0, MAX_JUDGE_EVIDENCE_FACTS).map(normalizeEvidenceFact);
    if (evidenceFacts.some((entry) => entry === null)) return null;
    const proofStatus = input.candidate.regressionProof?.status;
    const scopeTuple = [input.candidate.scope?.flagged ? 1 : 0, input.candidate.scope?.reasonCount + input.candidate.scope?.omittedReasonCount];
    if (PROOF_RANK[proofStatus] === undefined || !Number.isSafeInteger(scopeTuple[1]) || scopeTuple[1] < 0) return null;
    const view = { normalizedDiffExcerpt: diff.excerpt, diffSha256: diff.digest, files, issueFacts, evidenceFacts, proofStatus, scopeTuple, omittedCounts: { diffChars: diff.omitted, files: Math.max(0, facts.deltaEntries.length - files.length), issues: Math.max(0, ledger.length - issueFacts.length), evidence: Math.max(0, evidenceRows.length - evidenceFacts.length) } };
    const frozen = deepFreeze(cloneData(clipViewToBudget(view)));
    return validJudgeView(frozen) ? frozen : null;
  } catch {
    return null;
  }
}

function normalizeJudgeView(value, { frozen = false } = {}) {
  const view = exactObject(value, ['normalizedDiffExcerpt', 'diffSha256', 'files', 'issueFacts', 'evidenceFacts', 'proofStatus', 'scopeTuple', 'omittedCounts']).value ?? null;
  const files = exactDenseArray(view?.files, MAX_JUDGE_FILES);
  const issues = exactDenseArray(view?.issueFacts, MAX_JUDGE_ISSUE_FACTS);
  const evidence = exactDenseArray(view?.evidenceFacts, MAX_JUDGE_EVIDENCE_FACTS);
  const scope = exactDenseArray(view?.scopeTuple, 2);
  const omitted = exactObject(view?.omittedCounts, ['diffChars', 'files', 'issues', 'evidence']).value ?? null;
  if (view === null || boundedCleanText(view.normalizedDiffExcerpt, MAX_JUDGE_DIFF_BYTES, { allowEmpty: true, allowDiffWhitespace: true }) === null ||
      Buffer.byteLength(view.normalizedDiffExcerpt, 'utf8') > MAX_JUDGE_DIFF_BYTES || !SHA256.test(view.diffSha256 ?? '') ||
      files === null || issues === null || evidence === null || PROOF_RANK[view.proofStatus] === undefined ||
      scope === null || scope.length !== 2 || ![0, 1].includes(scope[0]) || !isSafeCount(scope[1]) || omitted === null ||
      !isSafeCount(omitted.diffChars) || !isSafeCount(omitted.files) || !isSafeCount(omitted.issues) || !isSafeCount(omitted.evidence)) return null;
  const normalizedFiles = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = exactObject(files[index], ['anonymousIndex', 'status']).value ?? null;
    if (file === null || file.anonymousIndex !== index + 1 || !['added', 'modified', 'deleted', 'renamed'].includes(file.status)) return null;
    normalizedFiles.push({ anonymousIndex: file.anonymousIndex, status: file.status });
  }
  const normalizedIssues = [];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = exactObject(issues[index], ['anonymousId', 'category', 'claim', 'evidenceDigest']).value ?? null;
    // `normalizeIssueFact` 와 **같은 정책**이어야 한다 — 여기만 좁으면 사영기가 만든
    // view 를 자기 검증기가 거부해서 `buildJudgeView` 가 다시 null 을 낸다.
    if (issue === null || issue.anonymousId !== `I${String(index + 1).padStart(2, '0')}` || !JUDGE_CATEGORIES.has(issue.category) ||
        boundedCleanText(issue.claim, MAX_JUDGE_CLAIM_CHARS, { allowDiffWhitespace: true }) === null ||
        !SHA256.test(issue.evidenceDigest ?? '')) return null;
    normalizedIssues.push({ anonymousId: issue.anonymousId, category: issue.category, claim: issue.claim, evidenceDigest: issue.evidenceDigest });
  }
  const normalizedEvidence = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const item = exactObject(evidence[index], ['anonymousId', 'kind', 'outcome', 'witnessCount']).value ?? null;
    if (item === null || item.anonymousId !== `E${String(index + 1).padStart(2, '0')}` || !['b0', 'br', 'c'].includes(item.kind) ||
        !['pass', 'fail', 'unknown'].includes(item.outcome) || !isSafeCount(item.witnessCount, 20_000)) return null;
    normalizedEvidence.push({ anonymousId: item.anonymousId, kind: item.kind, outcome: item.outcome, witnessCount: item.witnessCount });
  }
  const normalized = {
    normalizedDiffExcerpt: view.normalizedDiffExcerpt, diffSha256: view.diffSha256, files: normalizedFiles,
    issueFacts: normalizedIssues, evidenceFacts: normalizedEvidence, proofStatus: view.proofStatus,
    scopeTuple: [scope[0], scope[1]], omittedCounts: { diffChars: omitted.diffChars, files: omitted.files, issues: omitted.issues, evidence: omitted.evidence },
  };
  if (codexArgvChars(JSON.stringify(normalized)) > MAX_JUDGE_VIEW_ARGV_CHARS || (frozen && !isDeeplyFrozen(value))) return null;
  return normalized;
}

export function validJudgeView(value) {
  try {
    return normalizeJudgeView(value, { frozen: true }) !== null;
  } catch {
    return false;
  }
}

function promptLocalView(view, side) {
  return {
    ...view,
    issueFacts: view.issueFacts.map((fact) => ({ ...fact, anonymousId: `${side}-${fact.anonymousId}` })),
    evidenceFacts: view.evidenceFacts.map((fact) => ({ ...fact, anonymousId: `${side}-${fact.anonymousId}` })),
  };
}

/** Pair frozen candidate summaries without exposing their stable identities in the prompt. */
export function makeBlindPair(a, b, { reverse = false } = {}) {
  try {
    const viewA = a?.judgeView;
    const viewB = b?.judgeView;
    const idA = a?.candidateId;
    const idB = b?.candidateId;
    const normalizedA = normalizeJudgeView(viewA, { frozen: true });
    const normalizedB = normalizeJudgeView(viewB, { frozen: true });
    if (normalizedA === null || normalizedB === null || !validLane(idA) || !validLane(idB) || idA === idB) return null;
    const mapping = reverse ? { X: idB, Y: idA } : { X: idA, Y: idB };
    const promptInput = reverse
      ? { candidates: { X: promptLocalView(normalizedB, 'X'), Y: promptLocalView(normalizedA, 'Y') } }
      : { candidates: { X: promptLocalView(normalizedA, 'X'), Y: promptLocalView(normalizedB, 'Y') } };
    return deepFreeze(cloneData({ promptInput, mapping }));
  } catch {
    return null;
  }
}

function skipJsonString(text, index) {
  let at = index + 1;
  while (at < text.length) {
    if (text[at] === '\\') { at += 2; continue; }
    if (text[at] === '"') return at + 1;
    at += 1;
  }
  return -1;
}

function scanJsonDocument(text) {
  let at = 0;
  let duplicate = false;
  const ws = () => { while (/\s/.test(text[at] ?? '')) at += 1; };
  const string = () => {
    if (text[at] !== '"') return null;
    const start = at;
    at = skipJsonString(text, at);
    return at < 0 ? null : text.slice(start, at);
  };
  const value = () => {
    ws();
    if (text[at] === '"') return string() !== null;
    if (text[at] === '{') {
      at += 1; const keys = new Set(); ws(); if (text[at] === '}') { at += 1; return true; }
      while (true) {
        ws(); const encoded = string(); if (encoded === null) return false;
        let key; try { key = JSON.parse(encoded); } catch { return false; }
        if (keys.has(key)) duplicate = true; keys.add(key);
        ws(); if (text[at++] !== ':') return false; if (!value()) return false; ws();
        if (text[at] === '}') { at += 1; return true; } if (text[at++] !== ',') return false;
      }
    }
    if (text[at] === '[') { at += 1; ws(); if (text[at] === ']') { at += 1; return true; } while (true) { if (!value()) return false; ws(); if (text[at] === ']') { at += 1; return true; } if (text[at++] !== ',') return false; } }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at)); if (!primitive) return false; at += primitive[0].length; return true;
  };
  const ok = value(); ws(); return { ok: ok === true && at === text.length, duplicate };
}

function invalidJudge(code) {
  return deepFreeze({ ok: false, kind: 'invalid', code });
}

function normalizeParsedJudge(value) {
  const parsed = exactObject(value, ['ok', 'decision', 'rationale', 'majorDefects']).value ?? null;
  const defects = exactDenseArray(parsed?.majorDefects, MAX_JUDGE_MAJOR_DEFECTS);
  if (parsed === null || parsed.ok !== true || !['X', 'Y', 'TIE'].includes(parsed.decision) ||
      boundedCleanText(parsed.rationale, MAX_JUDGE_RATIONALE_CHARS, { allowEmpty: true }) === null || defects === null) return null;
  const normalizedDefects = [];
  for (const defect of defects) {
    const item = exactObject(defect, ['category', 'claim', 'evidence']).value ?? null;
    if (item === null || !JUDGE_CATEGORIES.has(item.category) || boundedCleanText(item.claim, MAX_JUDGE_DEFECT_TEXT_CHARS) === null ||
        boundedCleanText(item.evidence, MAX_JUDGE_DEFECT_TEXT_CHARS) === null) return null;
    normalizedDefects.push({ category: item.category, claim: item.claim, evidence: item.evidence });
  }
  return { decision: parsed.decision, rationale: parsed.rationale, majorDefects: normalizedDefects };
}

function normalizeInvalidParsedJudge(value) {
  const parsed = exactObject(value, ['ok', 'kind', 'code']).value ?? null;
  return parsed !== null && parsed.ok === false && parsed.kind === 'invalid' && /^[a-z0-9_]{1,64}$/.test(parsed.code)
    ? { code: parsed.code }
    : null;
}

/** Strictly parse one provider JSON object, never retaining raw provider text. */
export function parseJudgeDecision(raw) {
  try {
    if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_JUDGE_DECISION_UTF8_BYTES) return invalidJudge(REASON.judge_format_invalid);
    // ★ verdict 와 같은 이유로 코드펜스 한 겹을 벗긴다 — 진짜 모델은 정확한 스키마를 ```json
    //   안에 넣어 보낸다(라이브 실측). 벗기기 전에 스캔하면 판정이 영영 `invalid_json` 이다.
    const text = unfenceProviderJson(raw);
    const scan = scanJsonDocument(text);
    if (!scan.ok) return invalidJudge(REASON.judge_json_invalid);
    if (scan.duplicate) return invalidJudge(REASON.judge_format_invalid);
    const value = JSON.parse(text);
    const object = exactObject(value, ['schemaVersion', 'decision', 'rationale', 'majorDefects']).value ?? null;
    if (object === null || object.schemaVersion !== 1) return invalidJudge(REASON.judge_schema_invalid);
    const parsed = normalizeParsedJudge({ ok: true, decision: object.decision, rationale: object.rationale, majorDefects: object.majorDefects });
    return parsed === null ? invalidJudge(REASON.judge_schema_invalid) : deepFreeze({ ok: true, ...parsed });
  } catch {
    return invalidJudge(REASON.judge_json_invalid);
  }
}

function normalizeJudgeDecision(value) {
  let status;
  try { status = Object.getOwnPropertyDescriptor(value, 'status')?.value; } catch { return null; }
  if (status === 'invalid') {
    const object = exactObject(value, ['status', 'judgeIndex', 'corrected', 'code']).value ?? null;
    return object !== null && [1, 2].includes(object.judgeIndex) && typeof object.corrected === 'boolean' && /^[a-z0-9_]{1,64}$/.test(object.code)
      ? { status: 'invalid', judgeIndex: object.judgeIndex, corrected: object.corrected, code: object.code }
      : null;
  }
  if (status !== 'valid') return null;
  const object = exactObject(value, ['status', 'judgeIndex', 'realDecision', 'corrected', 'rationale', 'majorDefects']).value ?? null;
  const defects = exactDenseArray(object?.majorDefects, MAX_JUDGE_MAJOR_DEFECTS);
  if (object === null || ![1, 2].includes(object.judgeIndex) || typeof object.corrected !== 'boolean' ||
      !['lane-a', 'lane-b', 'TIE'].includes(object.realDecision) ||
      boundedCleanText(object.rationale, MAX_JUDGE_RATIONALE_CHARS, { allowEmpty: true }) === null || defects === null) return null;
  const normalizedDefects = [];
  for (const defect of defects) {
    const item = exactObject(defect, ['category', 'claim', 'evidence']).value ?? null;
    if (item === null || !JUDGE_CATEGORIES.has(item.category) ||
        boundedCleanText(item.claim, MAX_JUDGE_DEFECT_TEXT_CHARS) === null ||
        boundedCleanText(item.evidence, MAX_JUDGE_DEFECT_TEXT_CHARS) === null) return null;
    normalizedDefects.push({ category: item.category, claim: item.claim, evidence: item.evidence });
  }
  return {
    status: 'valid', judgeIndex: object.judgeIndex, realDecision: object.realDecision,
    corrected: object.corrected, rationale: object.rationale, majorDefects: normalizedDefects,
  };
}

/** Remap only validated blind decisions to their frozen real-lane mapping. */
export function remapJudgeDecision(parsed, mapping, { judgeIndex, corrected } = {}) {
  try {
    const map = exactObject(mapping, ['X', 'Y']).value ?? null;
    if (!Number.isSafeInteger(judgeIndex) || ![1, 2].includes(judgeIndex) || typeof corrected !== 'boolean' || map === null ||
        !Object.isFrozen(mapping) || !validLane(map.X) || !validLane(map.Y) || map.X === map.Y) return null;
    const invalid = normalizeInvalidParsedJudge(parsed);
    if (invalid !== null) return deepFreeze({ status: 'invalid', judgeIndex, corrected, code: invalid.code });
    const valid = normalizeParsedJudge(parsed);
    if (valid === null) return deepFreeze({ status: 'invalid', judgeIndex, corrected, code: REASON.judge_format_invalid });
    const realDecision = valid.decision === 'TIE' ? 'TIE' : map[valid.decision];
    if (realDecision !== 'TIE' && !validLane(realDecision)) return deepFreeze({ status: 'invalid', judgeIndex, corrected, code: REASON.judge_decision_invalid });
    return deepFreeze({ status: 'valid', judgeIndex, realDecision, corrected, rationale: valid.rationale, majorDefects: valid.majorDefects });
  } catch {
    return null;
  }
}

function invalidSelection(comparison) {
  return deepFreeze({ outcome: 'none', selectedCandidateId: null, objectiveComparison: comparison, judgeDecisions: [] });
}

/** Resolve a deterministic candidate competition from final, already-accounted judge records. */
export function selectCandidates(input) {
  try {
    const rawCandidates = ownData(input, 'candidates');
    const rawJudges = ownData(input, 'judgeDecisions');
    if (rawCandidates === MISSING || rawJudges === MISSING || exactDenseArray(rawCandidates, 2) === null || exactDenseArray(rawJudges, 2) === null || rawCandidates.length < 1 || rawCandidates.length > 2) return invalidSelection(null);
    const candidates = rawCandidates.map((candidate) => {
      const snapshot = cloneAuthorityData(candidate);
      return snapshot === INVALID_AUTHORITY ? null : snapshot;
    }).sort((a, b) => compareUtf8(a?.candidateId ?? '', b?.candidateId ?? ''));
    if (new Set(candidates.map((candidate) => candidate?.candidateId)).size !== candidates.length) return invalidSelection(null);
    const eligible = candidates.filter((candidate) => candidate !== null && candidateEligibilityUnsafe(candidate));
    if (candidates.length === 1) return selectSingleCandidate(candidates[0]);
    if (eligible.length === 0) return invalidSelection(null);
    if (eligible.length === 1) return deepFreeze({ outcome: 'single_survivor', selectedCandidateId: eligible[0].candidateId, objectiveComparison: null, judgeDecisions: [] });
    if (eligible[0].patch.ref.sha256 === eligible[1].patch.ref.sha256 && eligible[0].patch.ref.bytes !== eligible[1].patch.ref.bytes) return invalidSelection(null);
    const objectiveComparison = compareCandidates(eligible[0], eligible[1]);
    if (objectiveComparison.result === 'equivalent') return deepFreeze({ outcome: 'equivalent', selectedCandidateId: 'lane-a', objectiveComparison, judgeDecisions: [] });
    if (objectiveComparison.result === 'a' || objectiveComparison.result === 'b') return deepFreeze({ outcome: 'winner', selectedCandidateId: objectiveComparison.result === 'a' ? eligible[0].candidateId : eligible[1].candidateId, objectiveComparison, judgeDecisions: [] });
    const decisions = rawJudges.map(normalizeJudgeDecision);
    if (decisions.some((entry) => entry === null) || decisions.length !== 2) return invalidSelection(objectiveComparison);
    decisions.sort((a, b) => a.judgeIndex - b.judgeIndex);
    if (decisions[0].judgeIndex !== 1 || decisions[1].judgeIndex !== 2) return invalidSelection(objectiveComparison);
    if (decisions.some((entry) => entry.status === 'invalid')) return deepFreeze({ outcome: 'none', selectedCandidateId: null, objectiveComparison, judgeDecisions: decisions });
    if (decisions.some((entry) => entry.realDecision === 'TIE' || entry.majorDefects.length > 0) || decisions[0].realDecision !== decisions[1].realDecision) return deepFreeze({ outcome: 'tie', selectedCandidateId: null, objectiveComparison, judgeDecisions: decisions });
    return deepFreeze({ outcome: 'winner', selectedCandidateId: decisions[0].realDecision, objectiveComparison, judgeDecisions: decisions });
  } catch {
    return invalidSelection(null);
  }
}
