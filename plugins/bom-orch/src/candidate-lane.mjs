import {
  applyMachineIssues,
  applyRecheckVerdict,
  createIssueLedger,
  makeStagnationFingerprint,
  parseVerifierVerdict,
} from './verdict.mjs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { validJudgeView } from './candidate-selection.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function exactDataObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string') ||
      keys.some((key) => !own.includes(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  return value;
}

const OPERATIONAL_RESULTS = new Set([
  'provider_failed',
  'timeout',
  'effect_unknown',
  'snapshot_failed',
  'seal_failed',
]);

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function emptyUsage() {
  return { calls: 0, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: false };
}

function startUsage(usage) {
  return { ...usage, calls: usage.calls + 1 };
}

function cancelUsage(usage) {
  return { ...usage, calls: Math.max(0, usage.calls - 1) };
}

function validToken(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function settleUsage(usage, settlement) {
  const next = { ...usage };
  if (validToken(settlement?.promptTokens)) next.promptTokensKnown += settlement.promptTokens;
  else next.incomplete = true;
  if (validToken(settlement?.evalTokens)) next.evalTokensKnown += settlement.evalTokens;
  else next.incomplete = true;
  return next;
}

function safeUsageAdd(left, right) {
  return Number.isSafeInteger(left + right) ? left + right : null;
}

function addUsage(left, right) {
  const calls = safeUsageAdd(left.calls, right.calls);
  const prompt = safeUsageAdd(left.promptTokensKnown, right.promptTokensKnown);
  const evaluation = safeUsageAdd(left.evalTokensKnown, right.evalTokensKnown);
  return {
    calls: calls ?? 0,
    promptTokensKnown: prompt ?? 0,
    evalTokensKnown: evaluation ?? 0,
    incomplete: left.incomplete || right.incomplete || calls === null || prompt === null || evaluation === null,
  };
}

function beforeDeadline(spec, deps) {
  return spec.deadlineAt === null || spec.deadlineAt === undefined || deps.now() < spec.deadlineAt;
}

function attemptId(spec, ordinal) {
  return `${spec.runId}/${spec.laneId}/${String(ordinal).padStart(3, '0')}`;
}

function emptyLedger(laneId) {
  return deepFreeze({ laneId, entries: [], openIds: [], nextVerifierOrdinal: 1, nextMachineOrdinal: 1 });
}

function verifierOpenIds(ledger) {
  return ledger.entries
    .filter((entry) => entry.namespace === 'verifier' && entry.status === 'open')
    .map((entry) => entry.id)
    .sort();
}

/**
 * Fold a fresh `initial` verdict into the lane ledger.
 *
 * ★★ 이 함수는 첫 attempt 에만 도는 것이 아니다. 판정 단계는 「지금 열린 verifier issue 가
 *   있는가」로 정해지므로, recheck 가 전부 해소한 뒤 machine 증거로 다시 repair 된 attempt 는
 *   **또 한 번 initial** 을 받는다. 그때 verifier 원장을 백지에서 만들면 은퇴한 `A-I001` 이
 *   무관한 새 결함에 다시 붙고 원래 항목의 append-only 관찰 이력이 사라진다 — 공개
 *   `issues[]` 와 불변 attempt 기록이 「같은 결함이 재발했다」고 거짓을 말하게 된다.
 *   그래서 해소된 verifier 이력을 그대로 들고, 서수를 이어서 센다.
 *
 * ★ 남아 있던 verifier 항목은 전부 해소 상태다 — 하나라도 열려 있었다면 이 자리에 오지 않고
 *   recheck 로 갔다. 그래서 이력을 합쳐도 열린 ID 수는 늘지 않는다.
 */
function mergeInitialLedger(machineLedger, verdict) {
  const verifierLedger = createIssueLedger({
    laneId: machineLedger.laneId,
    verdict,
    startOrdinal: machineLedger.nextVerifierOrdinal,
  });
  if (verifierLedger?.ok === false) return verifierLedger;
  const entries = [
    ...machineLedger.entries.filter((entry) => entry.namespace === 'verifier'),
    ...verifierLedger.entries,
    ...machineLedger.entries.filter((entry) => entry.namespace === 'machine'),
  ].map(deepClone);
  const openIds = entries.filter((entry) => entry.status === 'open').map((entry) => entry.id).sort();
  if (openIds.length > 100) return { ok: false, kind: 'issue_limit_exceeded', code: 'issue_limit_exceeded' };
  return deepFreeze({
    laneId: machineLedger.laneId,
    entries,
    openIds,
    nextVerifierOrdinal: verifierLedger.nextVerifierOrdinal,
    nextMachineOrdinal: machineLedger.nextMachineOrdinal,
  });
}

function machineState(evaluation) {
  const tests = evaluation?.tests ?? {};
  if (tests.trusted !== true || tests.complete !== true || tests.execution !== 'completed') {
    return { status: 'unavailable' };
  }
  if (tests.outcome === 'pass') {
    const cRecords = Array.isArray(evaluation?.evidence) ? evaluation.evidence.filter((entry) => entry?.record?.kind === 'c') : [];
    return tests.stability === 'stable' && cRecords.length === 2 &&
      cRecords.map((entry) => entry.record.repetition).sort().join(',') === '1,2' &&
      cRecords.every((entry) => entry.record.classified?.outcome === 'pass')
      ? { status: 'pass' } : { status: 'unavailable' };
  }
  return { status: 'fail', repairable: true };
}

function proofState(evaluation, requirement) {
  const proof = evaluation?.regressionProof ?? {};
  if (requirement?.required !== true && proof.required !== true) {
    return { required: false, status: 'not_applicable', repairable: false };
  }
  return { required: true, status: proof.status, repairable: proof.repairable === true };
}

export function decideAttempt(input) {
  if (input?.operational && OPERATIONAL_RESULTS.has(input.operational)) {
    return { action: 'block', terminalClass: 'blocked', reason: input.operational };
  }
  if (input?.policyFailure || input?.tamperFailure) {
    return { action: 'reject', terminalClass: 'rejected', reason: input.policyFailure ? 'policy_failure' : 'tamper_failure' };
  }
  if (input?.stagnated) return { action: 'stagnate', terminalClass: 'rejected', reason: 'stagnated' };
  if (input?.verifier?.verdict !== 'PASS') {
    if (input?.budgetRemaining) return { action: 'repair', reason: 'verifier_failed' };
    return { action: 'reject', terminalClass: 'rejected', reason: 'verifier_failed' };
  }
  if (input?.machine?.status === 'fail') {
    if (input?.budgetRemaining && input.machine.repairable === true) return { action: 'repair', reason: 'machine_failed' };
    return { action: 'reject', terminalClass: 'rejected', reason: 'machine_failed' };
  }
  // ★★ 설계 §10.1: 열린 blocking issue 는 **rejected** 다. verifier 가 PASS 해도 coordinator
  //   machine issue 는 열린 채로 남을 수 있다 — Closed Contract Detail 8 이 「신뢰 가능한
  //   completed 실행만 fingerprint 를 해소한다」로 못박았으므로, 다음 attempt 의 테스트가
  //   unavailable 이면 앞선 실패의 `A-T001` 이 그대로 남는다. 그 후보를 accept 하면
  //   `usable_unverified`(또는 `verified`) 인데 열린 issue 가 있는 lane 이 만들어지고, 선택기는
  //   그것을 자격 없음으로 빼는 반면 manifest 는 자격 있다고 세어 **정당한 `none`·
  //   `single_survivor` 선택이 저장 단계에서 거절된다**(실측: `invalid_manifest_transition`).
  //   여기서 막으면 두 판정이 갈릴 상태 자체가 생기지 않는다.
  if (Number.isInteger(input?.openIssueCount) && input.openIssueCount > 0) {
    if (input?.budgetRemaining) return { action: 'repair', reason: 'issues_open' };
    return { action: 'reject', terminalClass: 'rejected', reason: 'issues_open' };
  }
  if (input?.proof?.required === true && input.proof.status !== 'proved') {
    if (input.proof.repairable === true && input.budgetRemaining) return { action: 'repair', reason: 'proof_not_proven' };
    if (input.proof.repairable === true) return { action: 'reject', terminalClass: 'rejected', reason: 'proof_not_proven' };
    return { action: 'accept', terminalClass: 'usable_unverified', reason: 'evidence_unavailable' };
  }
  if (input?.machine?.status === 'unavailable' || input?.evidenceUnavailable) {
    return { action: 'accept', terminalClass: 'usable_unverified', reason: 'evidence_unavailable' };
  }
  return { action: 'accept', terminalClass: 'verified', reason: 'verified' };
}

function defaultTests() {
  return {
    execution: 'not_run', outcome: 'unknown', stability: 'unknown', complete: false,
    trusted: false, failureFingerprints: [],
  };
}

function defaultProof(requirement) {
  return {
    required: requirement?.required === true,
    status: requirement?.required === true ? 'unavailable' : 'not_applicable',
    repairable: false,
    evidenceIds: [],
    witnessIds: [],
    reasonCodes: [],
  };
}

function normalizedScope(scope) {
  return scope ?? { flagged: false, reasonCount: 0, omittedReasonCount: 0, changedFileCount: 0 };
}

function normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult, sealed = null, verdictRef = null, writerUsage, verifierUsage, result, feedback }) {
  return deepFreeze({
    schemaVersion: 1,
    laneId: spec.laneId,
    attemptId: attemptId(spec, ordinal),
    ordinal,
    retryOf,
    binding: deepClone(binding),
    writerResult,
    sealed: sealed ? deepClone(sealed) : null,
    verdictRef: verdictRef ? deepClone(verdictRef) : null,
    usage: { writer: writerUsage, verifier: verifierUsage },
    result,
    feedback: { openIssueIds: [...(feedback?.openIds ?? [])].sort() },
  });
}

async function writeTerminal(deps, attempts, attempt) {
  const immutable = deepFreeze(deepClone(attempt));
  let written;
  try {
    written = await deps.writeAttemptArtifact(immutable);
  } catch {
    written = null;
  }
  const ref = exactDataObject(written?.ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']);
  const bytes = Buffer.from(`${JSON.stringify(immutable, null, 2)}\n`, 'utf8');
  if (!written || written.blocked === true || written.ok !== true || ref === null ||
      ref.kind !== 'attempt' || ref.candidateId !== attempt.laneId || !isAbsolute(ref.path) ||
      ref.sha256 !== createHash('sha256').update(bytes).digest('hex') || ref.bytes !== bytes.length ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 ||
      !Number.isSafeInteger(ref.expiresAt) || ref.expiresAt <= 0) {
    attempts.artifactFailure = immutable;
    return false;
  }
  attempts.push(immutable);
  return true;
}

/**
 * The mutation check could not be taken at all.
 *
 * ★ Only an explicit `available: false` counts. Callers that never report availability keep the
 *   previous meaning of `clean: false` — a detected mutation — so this narrows nothing that was
 *   already proven.
 */
function mutationCheckUnavailable(result) {
  return result?.mutationCheck?.available === false;
}

function mutationDetected(result) {
  const check = result?.mutationCheck;
  return Array.isArray(result?.touchedSources) && result.touchedSources.length > 0 ||
    check?.clean === false ||
    ['tracked', 'untracked', 'ignored', 'newlyIgnored', 'touchedSources']
      .some((key) => Array.isArray(check?.[key]) && check[key].length > 0);
}

function canonicalStrings(value, { max, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length > max) return false;
  const strings = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' || pattern !== null && !pattern.test(descriptor.value)) return false;
    strings.push(descriptor.value);
  }
  if (Object.keys(value).length !== value.length || new Set(strings).size !== strings.length) return false;
  const sorted = [...strings].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  return strings.every((value, index) => value === sorted[index]);
}

function validClassified(value, record) {
  const exact = exactDataObject(value, [
    'execution', 'outcome', 'failureKind', 'stability', 'reproduction', 'witnessIds',
    'failureFingerprints', 'outputSha256', 'outputChars', 'planFingerprint',
    'environmentFingerprint', 'truncated', 'diagnostics',
  ]);
  return exact !== null &&
    ['completed', 'not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(value.execution) &&
    ['pass', 'fail', 'unknown'].includes(value.outcome) &&
    ['assertion', 'collection', 'compile', 'dependency', 'infrastructure', 'unknown'].includes(value.failureKind) &&
    ['stable', 'flaky', 'unknown'].includes(value.stability) && typeof value.reproduction === 'boolean' &&
    canonicalStrings(value.witnessIds, { max: 20_000, pattern: SHA256_PATTERN }) &&
    canonicalStrings(value.failureFingerprints, { max: 20_000, pattern: SHA256_PATTERN }) &&
    (value.outputSha256 === null || SHA256_PATTERN.test(value.outputSha256)) &&
    Number.isSafeInteger(value.outputChars) && value.outputChars >= 0 &&
    value.planFingerprint === record.testPlanFingerprint &&
    value.environmentFingerprint === record.environmentFingerprint && typeof value.truncated === 'boolean' &&
    canonicalStrings(value.diagnostics, { max: 8, pattern: /^[a-z0-9_]{1,64}$/ });
}

function persistedEvidenceMatches(spec, attempt, sealed, evaluation) {
  if (!Array.isArray(evaluation?.cleanup) || evaluation.cleanup.some((entry) => {
    const exact = exactDataObject(entry, ['kind', 'candidateId', 'attemptId', 'evidenceId', 'path', 'status', 'recoveryPath']);
    return exact === null || entry.kind !== 'evidence' || entry.candidateId !== spec.laneId ||
      entry.attemptId !== attempt || typeof entry.evidenceId !== 'string' || !isAbsolute(entry.path) ||
      entry.status !== 'removed' && entry.status !== 'reaper_pending' ||
      entry.status === 'removed' && entry.recoveryPath !== null ||
      entry.status === 'reaper_pending' && entry.recoveryPath !== entry.path;
  })) return null;
  if (!Array.isArray(evaluation?.evidence) || evaluation.evidence.length > 20) return null;
  const ordered = evaluation.evidence;
  if (ordered.some((entry, index) => entry?.evidenceOrdinal !== index + 1)) return null;
  const ids = [];
  const paths = new Set();
  let expiresAt = null;
  let testDeltaSha256;
  for (const entry of ordered) {
    const record = entry?.record;
    const ref = entry?.ref;
    const exactRecord = exactDataObject(record, [
      'schemaVersion', 'evidenceId', 'attemptId', 'kind', 'repetition', 'baselineRevision', 'baselineTree',
      'candidateRevision', 'candidateTree', 'candidatePatchSha256', 'testPlanFingerprint', 'environmentFingerprint',
      'testDeltaSha256', 'classified',
    ]);
    const exactRef = exactDataObject(ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']);
    const expectedId = exactRecord === null ? null : `${attempt}/${record.kind.toUpperCase()}/${record.repetition}`;
    const bytes = exactRecord === null ? null : Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const validDelta = record?.kind === 'b0' ? record.testDeltaSha256 === null
      : record?.kind === 'br' ? SHA256_PATTERN.test(record.testDeltaSha256 ?? '')
        : record?.testDeltaSha256 === null || SHA256_PATTERN.test(record?.testDeltaSha256 ?? '');
    if (record?.kind !== 'b0' && testDeltaSha256 === undefined) testDeltaSha256 = record.testDeltaSha256;
    if (exactRecord === null || !validClassified(record?.classified, record) || record.schemaVersion !== 1 ||
        !['b0', 'br', 'c'].includes(record.kind) || ![1, 2].includes(record.repetition) || record.evidenceId !== expectedId ||
        record.baselineRevision !== spec.baseline?.commit || record.baselineTree !== spec.baseline?.tree ||
        record?.attemptId !== attempt || record.candidateRevision !== sealed.commit ||
        record.candidateTree !== sealed.treeHash || record.candidatePatchSha256 !== sealed.patchSha256 ||
        record.testPlanFingerprint !== sealed.testPlanFingerprint ||
        record.environmentFingerprint !== spec.frozenTestPlan?.environmentFingerprint ||
        !validDelta || record.kind !== 'b0' && record.testDeltaSha256 !== testDeltaSha256 ||
        exactRef === null || ref.kind !== 'evidence' || ref.candidateId !== spec.laneId ||
        typeof ref.path !== 'string' || !isAbsolute(ref.path) || !SHA256_PATTERN.test(ref.sha256) ||
        ref.sha256 !== createHash('sha256').update(bytes).digest('hex') || ref.bytes !== bytes.length ||
        !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || !Number.isSafeInteger(ref.expiresAt) || ref.expiresAt <= 0 ||
        paths.has(ref.path) || expiresAt !== null && ref.expiresAt !== expiresAt ||
        typeof record.evidenceId !== 'string' || record.evidenceId.length === 0 || ids.includes(record.evidenceId)) return null;
    ids.push(record.evidenceId);
    paths.add(ref.path);
    expiresAt = ref.expiresAt;
  }
  ids.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  const proofIds = evaluation?.regressionProof?.evidenceIds;
  if (!Array.isArray(proofIds) || new Set(proofIds).size !== proofIds.length ||
      proofIds.some((id) => !ids.includes(id)) ||
      evaluation.regressionProof?.status === 'proved' &&
        (proofIds.length !== ids.length || proofIds.some((id, index) => id !== ids[index]))) return null;
  return deepFreeze({ ...deepClone(sealed), evidenceIds: ids });
}

function failureFingerprints(evaluation) {
  const tests = evaluation?.tests;
  return tests?.trusted === true && tests.complete === true && tests.execution === 'completed'
    ? tests.failureFingerprints ?? []
    : [];
}

function recovery(code, spec, attempt, parent) {
  return deepFreeze({ code, path: spec.authoringWorktree.path, lastSealedParent: parent ?? null, attemptId: attempt ?? null });
}

export async function runCandidateLane(spec, deps) {
  const binding = deepFreeze(deepClone(spec.binding));
  const attempts = [];
  let ledger = emptyLedger(spec.laneId);
  let previousFingerprint = null;
  let retryOf = null;
  let finalTests = defaultTests();
  let finalProof = defaultProof(spec.proofRequirement);
  let finalScope = normalizedScope();
  let finalVerdict = null;
  let stopReason = 'budget_exhausted';
  let terminalClass = 'rejected';
  let laneRecovery = null;
  let lastSealedParent = spec.baseline?.commit ?? null;
  let latestTerminalSeal = null;
  let totalUsage = emptyUsage();

  for (let ordinal = 1; ordinal <= spec.budget; ordinal += 1) {
    const id = attemptId(spec, ordinal);
    if (!beforeDeadline(spec, deps) || deps.isAborted?.() === true) {
      stopReason = 'deadline_exceeded';
      terminalClass = 'blocked';
      break;
    }
    let allocation;
    try {
      allocation = await deps.checkpointAttemptAllocation({
        runId: spec.runId, laneId: spec.laneId, attemptId: id, ordinal, retryOf,
      });
    } catch {
      allocation = null;
    }
    if (!allocation || allocation.blocked === true || allocation.ok === false) {
      stopReason = 'allocation_checkpoint_failed';
      terminalClass = 'blocked';
      break;
    }

    let writerUsage = emptyUsage();
    let verifierUsage = emptyUsage();
    if (!beforeDeadline(spec, deps)) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'timeout', writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = 'deadline_exceeded';
      terminalClass = 'blocked';
      if (!written) stopReason = 'attempt_artifact_failed';
      break;
    }
    writerUsage = startUsage(writerUsage);
    let writer;
    try {
      writer = await deps.callWriter({
        runId: spec.runId, laneId: spec.laneId, attemptId: id, ordinal, retryOf,
        binding: deepClone(binding), task: spec.task, plan: spec.plan, feedback: deepClone(ledger),
      });
      if (writer?.callStarted === false) writerUsage = cancelUsage(writerUsage);
      else writerUsage = settleUsage(writerUsage, writer?.usage);
    } catch {
      writerUsage.incomplete = true;
      writer = { status: 'effect_unknown' };
    }
    totalUsage = addUsage(totalUsage, writerUsage);
    let writerResult = OPERATIONAL_RESULTS.has(writer?.status) ? writer.status : writer?.status === 'sealed' ? 'sealed' : 'effect_unknown';
    if (!beforeDeadline(spec, deps) && writerResult === 'sealed') writerResult = 'effect_unknown';
    if (writerResult !== 'sealed' || !beforeDeadline(spec, deps)) {
      const result = writerResult === 'effect_unknown' ? 'effect_unknown'
        : !beforeDeadline(spec, deps) ? 'timeout' : writerResult;
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: result, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = written ? (result === 'effect_unknown' ? result : !beforeDeadline(spec, deps) ? 'deadline_exceeded' : result) : 'attempt_artifact_failed';
      terminalClass = 'blocked';
      if (result === 'effect_unknown') {
        try { await deps.quarantineWorktree({ path: spec.authoringWorktree.path, attemptId: id, lastSealedParent }); } catch { /* recovery remains exact */ }
        laneRecovery = recovery('effect_unknown', spec, id, lastSealedParent);
      }
      break;
    }

    let seal;
    try {
      seal = await deps.sealAttempt({
        runId: spec.runId, laneId: spec.laneId, attemptId: id, ordinal,
        baseline: spec.baseline, frozenTestPlan: spec.frozenTestPlan,
      });
    } catch {
      seal = null;
    }
    if (!beforeDeadline(spec, deps)) {
      if (seal?.ok === true && seal.sealed && !Array.isArray(seal.sealed.evidenceIds)) {
        const sealed = deepFreeze({ ...deepClone(seal.sealed), evidenceIds: [] });
        lastSealedParent = sealed.commit;
        const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
        const written = await writeTerminal(deps, attempts, attempt);
        if (written) latestTerminalSeal = { attemptId: id, sealed };
        stopReason = written ? 'deadline_exceeded' : 'attempt_artifact_failed';
        terminalClass = 'blocked';
        break;
      }
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'timeout', writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = written ? 'deadline_exceeded' : 'attempt_artifact_failed';
      terminalClass = 'blocked';
      break;
    }
    if (!seal?.ok || !seal.sealed || Array.isArray(seal.sealed.evidenceIds)) {
      const writerFailure = seal?.writerResult === 'snapshot_failed' ? 'snapshot_failed' : 'seal_failed';
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: writerFailure, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = written ? writerFailure : 'attempt_artifact_failed';
      terminalClass = 'blocked';
      break;
    }
    const sealedCore = deepFreeze(deepClone(seal.sealed));
    lastSealedParent = sealedCore.commit;

    let evaluation;
    try {
      evaluation = await deps.evaluateAttempt({
        runId: spec.runId, laneId: spec.laneId, attemptId: id,
        sealed: sealedCore, frozenTestPlan: spec.frozenTestPlan,
        proofRequirement: spec.proofRequirement,
      });
    } catch {
      evaluation = null;
    }
    const sealed = persistedEvidenceMatches(spec, id, sealedCore, evaluation);
    let cleanupHandoffFailed = false;
    let cleanupPending = false;
    if (sealed !== null) {
      for (const entry of evaluation.cleanup.filter((value) => value.status === 'reaper_pending')) {
        cleanupPending = true;
        let handedOff = false;
        try { handedOff = await deps.handoffEvidenceCleanup({ path: entry.path, evidenceId: entry.evidenceId, attemptId: id }); } catch { handedOff = false; }
        if (handedOff !== true) cleanupHandoffFailed = true;
      }
    }
    if (!beforeDeadline(spec, deps)) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed: sealed ?? { ...sealedCore, evidenceIds: [] }, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed: attempt.sealed };
      stopReason = written ? 'deadline_exceeded' : 'attempt_artifact_failed';
      terminalClass = 'blocked';
      break;
    }
    if (sealed === null || evaluation?.operationalFailure !== null || cleanupHandoffFailed || cleanupPending) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed: sealed ?? { ...sealedCore, evidenceIds: [] }, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed: attempt.sealed };
      stopReason = written ? cleanupPending ? 'evidence_cleanup_unproven' : evaluation?.operationalFailure?.code ?? 'evidence_authority_mismatch' : 'attempt_artifact_failed';
      terminalClass = 'blocked';
      const leakingEvidence = cleanupPending ? evaluation.cleanup.find((entry) => entry.status === 'reaper_pending') : null;
      laneRecovery = leakingEvidence ? deepFreeze({ code: 'evidence_cleanup_unproven', path: leakingEvidence.path, lastSealedParent, attemptId: id }) : recovery(
        stopReason === 'attempt_artifact_failed' ? 'attempt_artifact_failed' : 'evidence_cleanup_unproven',
        spec, id, lastSealedParent,
      );
      break;
    }

    finalTests = deepClone(evaluation.tests ?? defaultTests());
    finalProof = deepClone(evaluation.regressionProof ?? defaultProof(spec.proofRequirement));
    finalScope = normalizedScope(deepClone(evaluation.scope));
    if (finalScope.flagged === true) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'rejected', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      stopReason = written ? 'policy_failure' : 'attempt_artifact_failed';
      terminalClass = written ? 'rejected' : 'blocked';
      break;
    }
    const machineLedger = applyMachineIssues(ledger, {
      trusted: evaluation.tests?.trusted === true,
      completed: evaluation.tests?.complete === true && evaluation.tests?.execution === 'completed',
      failureFingerprints: evaluation.tests?.failureFingerprints ?? [],
    });
    if (machineLedger?.ok === false) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'rejected', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      stopReason = written ? 'issue_limit_exceeded' : 'attempt_artifact_failed';
      terminalClass = 'rejected';
      break;
    }
    ledger = machineLedger;
    const expected = {
      phase: verifierOpenIds(ledger).length > 0 ? 'recheck' : 'initial',
      candidateId: spec.laneId,
      attemptId: id,
      candidatePatchSha256: sealed.patchSha256,
      evidenceIds: [...sealed.evidenceIds],
      openIssueIds: verifierOpenIds(ledger),
    };

    let verifierResult;
    let parsed;
    for (let formatAttempt = 0; formatAttempt < 2; formatAttempt += 1) {
      if (!beforeDeadline(spec, deps)) break;
      verifierUsage = startUsage(verifierUsage);
      try {
        verifierResult = await deps.callVerifier({
          expected: deepClone(expected), binding: deepClone(binding), feedback: deepClone(ledger),
          // ★★ verifier 는 **우리가** 돌린 실행 결과를 알아야 한다(설계 §12.-1: 테스트 결과를
          //   델리게이트가 지어낼 수 없게 하려고 오케스트레이터가 돌린다). 판정 스키마가
          //   `evidenceIds` 를 되돌려 적으라고 요구하는데 그 증거가 무엇을 말했는지 안 보여주면
          //   앞뒤가 안 맞는다. 품질 게이트 리팩터가 이 자리를 빈 문자열로 흘렸었다.
          //
          // ★ 원문이 아니라 **분류된 사실**만 넘긴다 — 실행/판정/안정성/신뢰/완결과 증거 ID.
          //   원문·환경·프로바이더 산문은 프롬프트에도 싣지 않는다. 이 값이 판정을 대신하지도
          //   않는다: `decideAttempt` 는 machine 채널과 verifier 채널을 따로 요구하므로 둘 중
          //   하나가 다른 하나를 지우지 못한다.
          machineEvidence: {
            execution: evaluation.tests?.execution ?? 'not_run',
            outcome: evaluation.tests?.outcome ?? 'unknown',
            stability: evaluation.tests?.stability ?? 'unknown',
            trusted: evaluation.tests?.trusted === true,
            complete: evaluation.tests?.complete === true,
            evidenceIds: [...sealed.evidenceIds],
          },
          formatCorrection: formatAttempt === 1, formatOnly: formatAttempt === 1,
        });
        if (verifierResult?.callStarted === false) verifierUsage = cancelUsage(verifierUsage);
        else verifierUsage = settleUsage(verifierUsage, verifierResult?.usage);
      } catch {
        verifierUsage.incomplete = true;
        verifierResult = null;
        break;
      }
      if (verifierResult?.operationalFailure === true) {
        parsed = { operational: true };
        break;
      }
      // 못 찍은 스냅샷은 변조의 증거가 아니라 판정을 완성하지 못한 인프라 실패다.
      if (mutationCheckUnavailable(verifierResult)) {
        parsed = { operational: true };
        break;
      }
      if (mutationDetected(verifierResult)) {
        parsed = { mutation: true };
        break;
      }
      parsed = parseVerifierVerdict(verifierResult?.raw, expected);
      if (parsed.ok === true) break;
    }
    totalUsage = addUsage(totalUsage, verifierUsage);
    if (!beforeDeadline(spec, deps) || parsed?.ok !== true) {
      const mutated = parsed?.mutation === true;
      const verifierOperational = parsed?.operational === true;
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: mutated ? 'rejected' : 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      stopReason = written ? (!beforeDeadline(spec, deps) ? 'deadline_exceeded' : mutated ? 'verifier_mutation' : verifierOperational ? 'verifier_operational_failure' : 'unverified') : 'attempt_artifact_failed';
      terminalClass = mutated ? 'rejected' : 'blocked';
      if (verifierOperational) laneRecovery = recovery('effect_unknown', spec, id, lastSealedParent);
      break;
    }

    const updatedLedger = parsed.phase === 'initial'
      ? mergeInitialLedger(ledger, parsed)
      : applyRecheckVerdict(ledger, parsed);
    if (updatedLedger?.ok === false) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'rejected', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      stopReason = written ? 'issue_limit_exceeded' : 'attempt_artifact_failed';
      terminalClass = 'rejected';
      break;
    }
    ledger = updatedLedger;
    finalVerdict = parsed;
    const fingerprint = makeStagnationFingerprint({
      treeHash: sealed.treeHash,
      openIssueIds: ledger.openIds,
      trustedFailureFingerprints: failureFingerprints(evaluation),
    });
    const decision = decideAttempt({
      machine: machineState(evaluation),
      proof: proofState(evaluation, spec.proofRequirement),
      verifier: parsed,
      policyFailure: finalScope.flagged === true,
      budgetRemaining: ordinal < spec.budget,
      stagnated: previousFingerprint === fingerprint,
      openIssueCount: ledger.openIds.length,
    });
    previousFingerprint = fingerprint;
    const result = decision.action === 'accept' ? 'accepted'
      : decision.action === 'stagnate' ? 'stagnated'
        : decision.action === 'reject' ? 'rejected' : decision.action;
    const attempt = normalizedAttempt({
      spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed,
      verdictRef: { verdict: parsed.verdict, issueIds: ledger.openIds },
      writerUsage, verifierUsage, result, feedback: ledger,
    });
    const written = await writeTerminal(deps, attempts, attempt);
    if (!written) {
      stopReason = 'attempt_artifact_failed';
      terminalClass = 'blocked';
      laneRecovery = recovery('attempt_artifact_failed', spec, id, lastSealedParent);
      break;
    }
    latestTerminalSeal = { attemptId: id, sealed };
    stopReason = decision.reason;
    terminalClass = decision.terminalClass ?? 'rejected';
    if (decision.action !== 'repair') break;
    retryOf = id;
  }

  let patch = null;
  if (latestTerminalSeal !== null) {
    try {
      const persisted = await deps.persistCandidatePatch({
        laneId: spec.laneId,
        sourceAttemptId: latestTerminalSeal.attemptId,
        sealed: deepClone(latestTerminalSeal.sealed),
      });
      const exactPersisted = exactDataObject(persisted, ['sourceAttemptId', 'ref', 'empty', 'files']);
      const ref = exactDataObject(persisted?.ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']);
      const validFiles = canonicalStrings(persisted?.files, { max: 10_000 }) && persisted.files.every((path) =>
        path.length > 0 && path.length <= 1_024 && !isAbsolute(path) && !path.includes('\\') &&
        !path.split('/').some((part) => part === '' || part === '.' || part === '..'));
      if (exactPersisted === null || ref === null || persisted.ref.kind !== 'candidate' ||
          persisted.ref.candidateId !== spec.laneId || !isAbsolute(persisted.ref.path) ||
          persisted.sourceAttemptId !== latestTerminalSeal.attemptId ||
          persisted.ref.sha256 !== latestTerminalSeal.sealed.patchSha256 || !SHA256_PATTERN.test(persisted.ref.sha256) ||
          !Number.isSafeInteger(persisted.ref.bytes) || persisted.ref.bytes < 0 ||
          !Number.isSafeInteger(persisted.ref.expiresAt) || persisted.ref.expiresAt <= 0 ||
          typeof persisted.empty !== 'boolean' || persisted.empty !== (persisted.ref.bytes === 0) ||
          !validFiles || persisted.empty && persisted.files.length !== 0) {
        throw new Error('candidate artifact failed');
      }
      patch = deepClone(persisted);
    } catch {
      terminalClass = 'blocked';
      stopReason = 'candidate_artifact_failed';
      laneRecovery = recovery('candidate_artifact_failed', spec, latestTerminalSeal.attemptId, lastSealedParent);
    }
  }

  if (attempts.artifactFailure) {
    stopReason = 'attempt_artifact_failed';
    terminalClass = 'blocked';
    laneRecovery = recovery('attempt_artifact_failed', spec, attempts.artifactFailure.attemptId, lastSealedParent);
  }
  const sortedAttempts = [...attempts].sort((left, right) => left.ordinal - right.ordinal);
  const usage = totalUsage;
  const summary = {
    candidateId: spec.laneId,
    binding: deepClone(binding),
    terminalClass,
    patch,
    tests: finalTests,
    regressionProof: finalProof,
    verdict: finalVerdict,
    issues: { openIds: [...ledger.openIds].sort(), count: ledger.openIds.length, limitExceeded: false },
    scope: finalScope,
    attempts: sortedAttempts,
    stopReason,
    crossVerificationCompleted: finalVerdict !== null,
    usage,
    judgeView: null,
    recovery: laneRecovery,
  };
  if (typeof deps.buildJudgeView === 'function') {
    try {
      const judgeView = deps.buildJudgeView({
        candidate: deepFreeze(deepClone(summary)),
        candidateId: spec.laneId,
        sourceAttemptId: patch?.sourceAttemptId ?? null,
        finalLedger: deepFreeze(deepClone(ledger)),
      });
      if (judgeView !== null) {
        if (!validJudgeView(judgeView)) throw new Error('invalid judge view');
        summary.judgeView = judgeView;
      }
    } catch {
      summary.judgeView = null;
    }
  }
  return deepFreeze(summary);
}
