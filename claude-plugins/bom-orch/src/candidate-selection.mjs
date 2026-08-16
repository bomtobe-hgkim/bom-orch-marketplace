import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { unfenceProviderJson } from './verdict.mjs';

const LANES = new Set(['lane-a', 'lane-b']);
const TERMINAL_CLASSES = new Set(['verified', 'usable_unverified']);
const ROLES = new Set(['worker', 'verifier']);
const TIERS = new Set(['fast', 'strong']);
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[._-]|$)/i;
const INVALID_AUTHORITY = Symbol('invalid-authority');

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f\ufffd]/.test(value);
}

function exactObject(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== 'string') ||
        keys.some((key) => !own.includes(key))) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    }
    return value;
  } catch {
    return null;
  }
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
  const object = exactObject(value, ['providerId', 'model', 'effort', 'tier', 'role']);
  return object !== null && boundedString(object.providerId, 128) &&
    (object.model === null || boundedString(object.model, 128)) &&
    (object.effort === null || boundedString(object.effort, 64)) &&
    TIERS.has(object.tier) && ROLES.has(object.role) && object.role === role;
}

function validBinding(value) {
  const object = exactObject(value, ['writer', 'verifier']);
  return object !== null && deeplyFrozen(object) &&
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
  const exactAttempt = exactObject(attempt, ['schemaVersion', 'laneId', 'attemptId', 'ordinal', 'retryOf', 'binding', 'writerResult', 'sealed', 'verdictRef', 'usage', 'result', 'feedback']);
  const exactSeal = exactObject(sealed, ['commit', 'treeHash', 'patchSha256', 'testPlanFingerprint', 'evidenceIds']);
  const verdictRef = exactObject(attempt?.verdictRef, ['verdict', 'issueIds']);
  const usage = exactObject(attempt?.usage, ['writer', 'verifier']);
  const validUsage = (value) => exactObject(value, ['calls', 'promptTokensKnown', 'evalTokensKnown', 'incomplete']) !== null &&
    Number.isSafeInteger(value.calls) && value.calls >= 0 && Number.isSafeInteger(value.promptTokensKnown) &&
    value.promptTokensKnown >= 0 && Number.isSafeInteger(value.evalTokensKnown) && value.evalTokensKnown >= 0 &&
    typeof value.incomplete === 'boolean';
  const prior = attempt?.ordinal > 1 ? candidate.attempts.filter((entry) => entry?.attemptId === attempt.retryOf) : [];
  const denseHistory = Number.isSafeInteger(attempt?.ordinal) && candidate.attempts.length === attempt.ordinal &&
    candidate.attempts.every((entry, index) => {
      const ordinal = index + 1;
      return exactObject(entry, ['schemaVersion', 'laneId', 'attemptId', 'ordinal', 'retryOf', 'binding', 'writerResult', 'sealed', 'verdictRef', 'usage', 'result', 'feedback']) !== null &&
        entry.schemaVersion === 1 && entry.laneId === candidate.candidateId && entry.ordinal === ordinal &&
        entry.attemptId === `${runId}/${candidate.candidateId}/${String(ordinal).padStart(3, '0')}` &&
        entry.retryOf === (ordinal === 1 ? null : `${runId}/${candidate.candidateId}/${String(ordinal - 1).padStart(3, '0')}`) &&
        validBinding(entry.binding) && JSON.stringify(entry.binding) === JSON.stringify(candidate.binding);
    });
  const evidenceSorted = Array.isArray(sealed?.evidenceIds) && sealed.evidenceIds.every((id, index) => index === 0 ||
    Buffer.compare(Buffer.from(sealed.evidenceIds[index - 1], 'utf8'), Buffer.from(id, 'utf8')) < 0);
  return exactAttempt !== null && exactSeal !== null && attempt.schemaVersion === 1 &&
    RUN_ID.test(runId) && !WINDOWS_DEVICE.test(runId) && attempt.laneId === candidate.candidateId && Number.isSafeInteger(attempt.ordinal) && attempt.ordinal > 0 && attempt.ordinal <= 999 &&
    attempt.attemptId === attemptId && attempt.retryOf === (attempt.ordinal === 1 ? null : `${patch.sourceAttemptId.split('/')[0]}/${candidate.candidateId}/${String(attempt.ordinal - 1).padStart(3, '0')}`) &&
    denseHistory && (attempt.ordinal === 1 || prior.length === 1 && prior[0]?.ordinal === attempt.ordinal - 1) &&
    validBinding(attempt.binding) && JSON.stringify(attempt.binding) === JSON.stringify(candidate.binding) && attempt.writerResult === 'sealed' &&
    verdictRef !== null && verdictRef.verdict === 'PASS' && Array.isArray(verdictRef.issueIds) && verdictRef.issueIds.length === 0 &&
    usage !== null && validUsage(usage.writer) && validUsage(usage.verifier) &&
    exactObject(attempt.feedback, ['openIssueIds']) !== null && Array.isArray(attempt.feedback.openIssueIds) && attempt.feedback.openIssueIds.length === 0 &&
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
  const initial = exactObject(verdict, ['ok', 'phase', 'verdict', 'binding', 'issues', 'notes']) !== null &&
    verdict.phase === 'initial' && Array.isArray(verdict.issues) && verdict.issues.length === 0;
  const recheck = exactObject(verdict, ['ok', 'phase', 'verdict', 'binding', 'checks', 'newIssues', 'notes']) !== null &&
    verdict.phase === 'recheck' && Array.isArray(verdict.checks) && verdict.checks.every((check) => check?.status === 'resolved') &&
    Array.isArray(verdict.newIssues) && verdict.newIssues.length === 0;
  if (verdict?.ok !== true || verdict.verdict !== 'PASS' || !Array.isArray(verdict.notes) || !initial && !recheck) return false;
  const binding = exactObject(verdict.binding, ['candidateId', 'attemptId', 'candidatePatchSha256', 'evidenceIds']);
  return binding !== null && binding.candidateId === candidate.candidateId &&
    binding.attemptId === patch.sourceAttemptId && binding.candidatePatchSha256 === patch.ref.sha256 &&
    Array.isArray(binding.evidenceIds) && Array.isArray(attempt?.sealed?.evidenceIds) &&
    binding.evidenceIds.length === attempt.sealed.evidenceIds.length &&
    binding.evidenceIds.every((id, index) => id === attempt.sealed.evidenceIds[index]);
}

/** Return whether a sealed candidate is safe to enter selection. */
function candidateEligibilityUnsafe(candidate) {
  if (candidate === null || typeof candidate !== 'object' || !LANES.has(candidate.candidateId) ||
      !validBinding(candidate.binding) || !TERMINAL_CLASSES.has(candidate.terminalClass) ||
      candidate.recovery !== null || candidate.scope?.flagged !== false ||
      candidate.crossVerificationCompleted !== true ||
      !Array.isArray(candidate.issues?.openIds) || candidate.issues.openIds.length !== 0 ||
      candidate.issues?.count !== 0 || candidate.issues?.limitExceeded !== false) return false;
  if (candidate.terminalClass === 'verified' &&
      (candidate.tests?.execution !== 'completed' || candidate.tests?.outcome !== 'pass' || candidate.tests?.stability !== 'stable' || candidate.tests?.trusted !== true ||
       candidate.tests?.complete !== true || candidate.regressionProof?.required === true &&
       candidate.regressionProof.status !== 'proved')) return false;
  if (candidate.terminalClass === 'usable_unverified' && candidate.stopReason !== 'evidence_unavailable') return false;
  const patch = candidate.patch;
  const ref = patch?.ref;
  if (exactObject(patch, ['sourceAttemptId', 'ref', 'empty', 'files']) === null || patch.empty !== false ||
      typeof patch.sourceAttemptId !== 'string' || patch.sourceAttemptId === '' ||
      !Array.isArray(patch.files) || patch.files.some((file) => typeof file !== 'string' || file === '') ||
      exactObject(ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']) === null ||
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

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
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
const PROOF_RANK = Object.freeze({ proved: 4, not_applicable: 3, not_proven: 2, unavailable: 1, flaky: 0 });
const TEST_RANK = Object.freeze({ stable_repeated_full_pass: 3, stable_one_pass: 2, unknown_or_not_run: 1, flaky: 0 });
const JUDGE_CATEGORIES = new Set(['correctness', 'security', 'requirements', 'scope', 'tests']);
const MAX_JUDGE_DIFF_BYTES = 12000;
const MAX_JUDGE_FILES = 32;
const MAX_JUDGE_ISSUE_FACTS = 20;
const MAX_JUDGE_EVIDENCE_FACTS = 20;
const MAX_JUDGE_CLAIM_CHARS = 400;
const MAX_JUDGE_VIEW_UTF8_BYTES = 24000;
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
const CONTROL_TEXT = /[\u0000-\u001f\u007f\ufffd]/u;
const DIFF_CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u;
const DIFF_HEADER = /^(?:diff --git|index |--- |\+\+\+ |rename |copy |new file mode|deleted file mode|old mode|new mode|Binary files )/u;
const LEDGER_STATUSES = new Set(['open', 'resolved', 'superseded']);
const MACHINE_LEDGER_ID = /^[AB]-T\d{3}$/;
const VERIFIER_LEDGER_ID = /^[AB]-I\d{3}$/;

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasForbiddenText(value, { allowDiffWhitespace = false } = {}) {
  return typeof value !== 'string' || (allowDiffWhitespace ? DIFF_CONTROL_TEXT : CONTROL_TEXT).test(value) || PATH_TEXT.test(value) ||
    hasUnpairedSurrogate(value) || IDENTITY_TEXT.test(value) || CREDENTIAL_VALUE_TEXT.test(value) || SECRET_TEXT.test(value);
}

function boundedCleanText(value, max, { allowEmpty = false, allowDiffWhitespace = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max &&
    !hasForbiddenText(value, { allowDiffWhitespace }) ? value : null;
}

function exactDenseArray(value, max) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || own[own.length - 1] !== 'length') return null;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    }
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    return length?.enumerable === false && Object.hasOwn(length, 'value') ? value : null;
  } catch {
    return null;
  }
}

const MISSING = Symbol('missing');

function ownData(value, key) {
  try {
    if (value === null || typeof value !== 'object') return MISSING;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : MISSING;
  } catch {
    return MISSING;
  }
}

function isSafeCount(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
  return { excerpt, omitted, digest: digest(full) };
}

function readEntries(value) {
  const entries = ownData(value, 'entries');
  return entries === MISSING ? null : exactDenseArray(entries, 100);
}

function normalizeMachineLedgerEntry(entry) {
  const machine = exactObject(entry, ['id', 'namespace', 'status', 'fingerprint', 'observations']);
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
    : ['id', 'namespace', 'status', 'issue', 'observations']);
  const issue = exactObject(verifier?.issue, ['category', 'claim', 'evidence', 'requiredFix']);
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
  rows.sort((left, right) => byteCompare(left.id, right.id));
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
      evidenceDigest: digest(`${nonce}\0machine\0${fingerprint}`),
    };
  }
  const nested = ownData(entry, 'issue');
  const issue = nested === MISSING ? entry : nested;
  const category = ownData(issue, 'category');
  const claim = ownData(issue, 'claim');
  const evidence = ownData(issue, 'evidence');
  if (category === MISSING || claim === MISSING || evidence === MISSING || !JUDGE_CATEGORIES.has(category) ||
      boundedCleanText(claim, MAX_JUDGE_CLAIM_CHARS) === null || boundedCleanText(evidence, MAX_JUDGE_CLAIM_CHARS) === null) return null;
  return {
    anonymousId: `I${String(index + 1).padStart(2, '0')}`,
    category,
    claim,
    evidenceDigest: digest(`${nonce}\0verifier\0${evidence}`),
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

/** Build the only allowlisted, anonymous judge input from private lane facts. */
export function buildJudgeView(input) {
  try {
    if (input === null || typeof input !== 'object' || !/^[0-9a-f]{32}$/.test(input.blindNonce ?? '') || !LANES.has(input.candidate?.candidateId)) return null;
    const facts = input.privateFacts;
    if (facts === null || typeof facts !== 'object' || exactDenseArray(facts.deltaEntries, 10_000) === null || exactDenseArray(facts.persistedEvidence, 10_000) === null) return null;
    const diff = normalizedDiff(facts.patchBytes);
    const ledger = readEntries(facts.finalLedger);
    if (diff === null || ledger === null) return null;
    const files = facts.deltaEntries.slice().sort((a, b) => byteCompare(String(a?.path ?? ''), String(b?.path ?? ''))).slice(0, MAX_JUDGE_FILES).map((entry, index) => {
      if (!['added', 'modified', 'deleted', 'renamed'].includes(entry?.status) || typeof entry.path !== 'string' || hasForbiddenText(entry.path)) throw new Error('bad delta');
      return { anonymousIndex: index + 1, status: entry.status };
    });
    const issueRows = projectableLedgerRows(ledger);
    if (issueRows === null) return null;
    const issueFacts = issueRows.slice(0, MAX_JUDGE_ISSUE_FACTS).map(({ entry }, index) => normalizeIssueFact(entry, index, input.blindNonce));
    if (issueFacts.some((entry) => entry === null)) return null;
    const evidenceRows = facts.persistedEvidence.slice().sort((a, b) => byteCompare(String(a?.record?.evidenceId ?? ''), String(b?.record?.evidenceId ?? '')));
    const evidenceFacts = evidenceRows.slice(0, MAX_JUDGE_EVIDENCE_FACTS).map(normalizeEvidenceFact);
    if (evidenceFacts.some((entry) => entry === null)) return null;
    const proofStatus = input.candidate.regressionProof?.status;
    const scopeTuple = [input.candidate.scope?.flagged ? 1 : 0, input.candidate.scope?.reasonCount + input.candidate.scope?.omittedReasonCount];
    if (PROOF_RANK[proofStatus] === undefined || !Number.isSafeInteger(scopeTuple[1]) || scopeTuple[1] < 0) return null;
    const view = { normalizedDiffExcerpt: diff.excerpt, diffSha256: diff.digest, files, issueFacts, evidenceFacts, proofStatus, scopeTuple, omittedCounts: { diffChars: diff.omitted, files: Math.max(0, facts.deltaEntries.length - files.length), issues: Math.max(0, ledger.length - issueFacts.length), evidence: Math.max(0, evidenceRows.length - evidenceFacts.length) } };
    const frozen = deepFreeze(cloneJson(view));
    return validJudgeView(frozen) ? frozen : null;
  } catch {
    return null;
  }
}

function normalizeJudgeView(value, { frozen = false } = {}) {
  const view = exactObject(value, ['normalizedDiffExcerpt', 'diffSha256', 'files', 'issueFacts', 'evidenceFacts', 'proofStatus', 'scopeTuple', 'omittedCounts']);
  const files = exactDenseArray(view?.files, MAX_JUDGE_FILES);
  const issues = exactDenseArray(view?.issueFacts, MAX_JUDGE_ISSUE_FACTS);
  const evidence = exactDenseArray(view?.evidenceFacts, MAX_JUDGE_EVIDENCE_FACTS);
  const scope = exactDenseArray(view?.scopeTuple, 2);
  const omitted = exactObject(view?.omittedCounts, ['diffChars', 'files', 'issues', 'evidence']);
  if (view === null || boundedCleanText(view.normalizedDiffExcerpt, MAX_JUDGE_DIFF_BYTES, { allowEmpty: true, allowDiffWhitespace: true }) === null ||
      Buffer.byteLength(view.normalizedDiffExcerpt, 'utf8') > MAX_JUDGE_DIFF_BYTES || !SHA256.test(view.diffSha256 ?? '') ||
      files === null || issues === null || evidence === null || PROOF_RANK[view.proofStatus] === undefined ||
      scope === null || scope.length !== 2 || ![0, 1].includes(scope[0]) || !isSafeCount(scope[1]) || omitted === null ||
      !isSafeCount(omitted.diffChars) || !isSafeCount(omitted.files) || !isSafeCount(omitted.issues) || !isSafeCount(omitted.evidence)) return null;
  const normalizedFiles = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = exactObject(files[index], ['anonymousIndex', 'status']);
    if (file === null || file.anonymousIndex !== index + 1 || !['added', 'modified', 'deleted', 'renamed'].includes(file.status)) return null;
    normalizedFiles.push({ anonymousIndex: file.anonymousIndex, status: file.status });
  }
  const normalizedIssues = [];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = exactObject(issues[index], ['anonymousId', 'category', 'claim', 'evidenceDigest']);
    if (issue === null || issue.anonymousId !== `I${String(index + 1).padStart(2, '0')}` || !JUDGE_CATEGORIES.has(issue.category) ||
        boundedCleanText(issue.claim, MAX_JUDGE_CLAIM_CHARS) === null || !SHA256.test(issue.evidenceDigest ?? '')) return null;
    normalizedIssues.push({ anonymousId: issue.anonymousId, category: issue.category, claim: issue.claim, evidenceDigest: issue.evidenceDigest });
  }
  const normalizedEvidence = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const item = exactObject(evidence[index], ['anonymousId', 'kind', 'outcome', 'witnessCount']);
    if (item === null || item.anonymousId !== `E${String(index + 1).padStart(2, '0')}` || !['b0', 'br', 'c'].includes(item.kind) ||
        !['pass', 'fail', 'unknown'].includes(item.outcome) || !isSafeCount(item.witnessCount, 20_000)) return null;
    normalizedEvidence.push({ anonymousId: item.anonymousId, kind: item.kind, outcome: item.outcome, witnessCount: item.witnessCount });
  }
  const normalized = {
    normalizedDiffExcerpt: view.normalizedDiffExcerpt, diffSha256: view.diffSha256, files: normalizedFiles,
    issueFacts: normalizedIssues, evidenceFacts: normalizedEvidence, proofStatus: view.proofStatus,
    scopeTuple: [scope[0], scope[1]], omittedCounts: { diffChars: omitted.diffChars, files: omitted.files, issues: omitted.issues, evidence: omitted.evidence },
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_JUDGE_VIEW_UTF8_BYTES || (frozen && !isDeeplyFrozen(value))) return null;
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
    if (normalizedA === null || normalizedB === null || !LANES.has(idA) || !LANES.has(idB) || idA === idB) return null;
    const mapping = reverse ? { X: idB, Y: idA } : { X: idA, Y: idB };
    const promptInput = reverse
      ? { candidates: { X: promptLocalView(normalizedB, 'X'), Y: promptLocalView(normalizedA, 'Y') } }
      : { candidates: { X: promptLocalView(normalizedA, 'X'), Y: promptLocalView(normalizedB, 'Y') } };
    return deepFreeze(cloneJson({ promptInput, mapping }));
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
  const parsed = exactObject(value, ['ok', 'decision', 'rationale', 'majorDefects']);
  const defects = exactDenseArray(parsed?.majorDefects, MAX_JUDGE_MAJOR_DEFECTS);
  if (parsed === null || parsed.ok !== true || !['X', 'Y', 'TIE'].includes(parsed.decision) ||
      boundedCleanText(parsed.rationale, MAX_JUDGE_RATIONALE_CHARS, { allowEmpty: true }) === null || defects === null) return null;
  const normalizedDefects = [];
  for (const defect of defects) {
    const item = exactObject(defect, ['category', 'claim', 'evidence']);
    if (item === null || !JUDGE_CATEGORIES.has(item.category) || boundedCleanText(item.claim, MAX_JUDGE_DEFECT_TEXT_CHARS) === null ||
        boundedCleanText(item.evidence, MAX_JUDGE_DEFECT_TEXT_CHARS) === null) return null;
    normalizedDefects.push({ category: item.category, claim: item.claim, evidence: item.evidence });
  }
  return { decision: parsed.decision, rationale: parsed.rationale, majorDefects: normalizedDefects };
}

function normalizeInvalidParsedJudge(value) {
  const parsed = exactObject(value, ['ok', 'kind', 'code']);
  return parsed !== null && parsed.ok === false && parsed.kind === 'invalid' && /^[a-z0-9_]{1,64}$/.test(parsed.code)
    ? { code: parsed.code }
    : null;
}

/** Strictly parse one provider JSON object, never retaining raw provider text. */
export function parseJudgeDecision(raw) {
  try {
    if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_JUDGE_DECISION_UTF8_BYTES) return invalidJudge('invalid_format');
    // ★ verdict 와 같은 이유로 코드펜스 한 겹을 벗긴다 — 진짜 모델은 정확한 스키마를 ```json
    //   안에 넣어 보낸다(라이브 실측). 벗기기 전에 스캔하면 판정이 영영 `invalid_json` 이다.
    const text = unfenceProviderJson(raw);
    const scan = scanJsonDocument(text);
    if (!scan.ok) return invalidJudge('invalid_json');
    if (scan.duplicate) return invalidJudge('invalid_format');
    const value = JSON.parse(text);
    const object = exactObject(value, ['schemaVersion', 'decision', 'rationale', 'majorDefects']);
    if (object === null || object.schemaVersion !== 1) return invalidJudge('invalid_schema');
    const parsed = normalizeParsedJudge({ ok: true, decision: object.decision, rationale: object.rationale, majorDefects: object.majorDefects });
    return parsed === null ? invalidJudge('invalid_schema') : deepFreeze({ ok: true, ...parsed });
  } catch {
    return invalidJudge('invalid_json');
  }
}

function normalizeJudgeDecision(value) {
  let status;
  try { status = Object.getOwnPropertyDescriptor(value, 'status')?.value; } catch { return null; }
  if (status === 'invalid') {
    const object = exactObject(value, ['status', 'judgeIndex', 'corrected', 'code']);
    return object !== null && [1, 2].includes(object.judgeIndex) && typeof object.corrected === 'boolean' && /^[a-z0-9_]{1,64}$/.test(object.code)
      ? { status: 'invalid', judgeIndex: object.judgeIndex, corrected: object.corrected, code: object.code }
      : null;
  }
  if (status !== 'valid') return null;
  const object = exactObject(value, ['status', 'judgeIndex', 'realDecision', 'corrected', 'rationale', 'majorDefects']);
  const defects = exactDenseArray(object?.majorDefects, MAX_JUDGE_MAJOR_DEFECTS);
  if (object === null || ![1, 2].includes(object.judgeIndex) || typeof object.corrected !== 'boolean' ||
      !['lane-a', 'lane-b', 'TIE'].includes(object.realDecision) ||
      boundedCleanText(object.rationale, MAX_JUDGE_RATIONALE_CHARS, { allowEmpty: true }) === null || defects === null) return null;
  const normalizedDefects = [];
  for (const defect of defects) {
    const item = exactObject(defect, ['category', 'claim', 'evidence']);
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
    const map = exactObject(mapping, ['X', 'Y']);
    if (!Number.isSafeInteger(judgeIndex) || ![1, 2].includes(judgeIndex) || typeof corrected !== 'boolean' || map === null ||
        !Object.isFrozen(mapping) || !LANES.has(map.X) || !LANES.has(map.Y) || map.X === map.Y) return null;
    const invalid = normalizeInvalidParsedJudge(parsed);
    if (invalid !== null) return deepFreeze({ status: 'invalid', judgeIndex, corrected, code: invalid.code });
    const valid = normalizeParsedJudge(parsed);
    if (valid === null) return deepFreeze({ status: 'invalid', judgeIndex, corrected, code: 'invalid_format' });
    const realDecision = valid.decision === 'TIE' ? 'TIE' : map[valid.decision];
    if (realDecision !== 'TIE' && !LANES.has(realDecision)) return deepFreeze({ status: 'invalid', judgeIndex, corrected, code: 'invalid_decision' });
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
    }).sort((a, b) => byteCompare(a?.candidateId ?? '', b?.candidateId ?? ''));
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
