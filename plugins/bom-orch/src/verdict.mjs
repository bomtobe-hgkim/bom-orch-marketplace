import { createHash } from 'node:crypto';

const MAX_PROVIDER_CONTENT_LENGTH = 2_000;
const MAX_BLOCKING_ISSUES = 100;
const MAX_NOTES = 50;
const MAX_FIELD_LENGTH = 2_000;
const BLOCKING_CATEGORIES = new Set([
  'correctness',
  'security',
  'requirements',
  'scope',
  'tests',
]);

function invalid(code) {
  return { ok: false, kind: 'invalid', code };
}

function issueLimitExceeded() {
  return { ok: false, kind: 'issue_limit_exceeded', code: 'issue_limit_exceeded' };
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepClone(entry)]));
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function stringArray(value, maxLength) {
  return Array.isArray(value)
    && value.length <= maxLength
    && value.every((entry) => boundedString(entry));
}

function uniqueStrings(value) {
  return new Set(value).size === value.length;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validIssue(issue) {
  return exactKeys(issue, ['category', 'claim', 'evidence', 'requiredFix'])
    && BLOCKING_CATEGORIES.has(issue.category)
    && boundedString(issue.claim)
    && boundedString(issue.evidence)
    && boundedString(issue.requiredFix);
}

function validCheck(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return false;
  if (!boundedString(check.id) || !boundedString(check.status) || !boundedString(check.evidence)) return false;
  if (check.status === 'superseded') {
    return exactKeys(check, ['id', 'status', 'evidence', 'replacementIndex'])
      && Number.isInteger(check.replacementIndex)
      && check.replacementIndex >= 0;
  }
  return (check.status === 'resolved' || check.status === 'persists')
    && exactKeys(check, ['id', 'status', 'evidence']);
}

function bindingMatches(value, expected) {
  return value.schemaVersion === 1
    && value.candidateId === expected.candidateId
    && value.attemptId === expected.attemptId
    && value.candidatePatchSha256 === expected.candidatePatchSha256
    && sameStrings(value.evidenceIds, expected.evidenceIds);
}

function normalizeBinding(value) {
  return {
    candidateId: value.candidateId,
    attemptId: value.attemptId,
    candidatePatchSha256: value.candidatePatchSha256,
    evidenceIds: [...value.evidenceIds],
  };
}

function validateExpected(expected, phase) {
  return expected
    && typeof expected === 'object'
    && expected.phase === phase
    && boundedString(expected.candidateId)
    && boundedString(expected.attemptId)
    && typeof expected.candidatePatchSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(expected.candidatePatchSha256)
    && stringArray(expected.evidenceIds, MAX_BLOCKING_ISSUES)
    && uniqueStrings(expected.evidenceIds)
    && stringArray(expected.openIssueIds, MAX_BLOCKING_ISSUES)
    && uniqueStrings(expected.openIssueIds);
}

/**
 * Strip exactly one markdown code fence from a provider's JSON answer.
 *
 * ★★ 왜 필요한가(라이브 실측): 진짜 claude 는 요청한 스키마를 **정확히** 지킨 JSON 을 내면서도
 *   그것을 ```json 펜스로 감싼다. 형식 정정 재요청에도 같은 모양이었다. 그 한 겹 때문에
 *   `JSON.parse` 가 `invalid_json` 으로 떨어졌고, verdict 를 두 번 못 읽은 lane 은
 *   `blocked/unverified` 로 끝났다 — 즉 **품질 게이트가 실제 모델 상대로는 한 번도 통과할 수
 *   없었다.** 단위 스텁은 전부 맨 JSON 을 돌려줘서 스위트 전체가 이 자리를 못 봤다.
 *
 * ★ 관용은 **여는 펜스 한 줄과 닫는 펜스 한 줄뿐**이다. 산문이 섞였거나 블록이 둘이면 그대로
 *   거부한다 — 판정문은 문서 하나여야 하고, 텍스트에서 JSON 을 긁어모으기 시작하면 어느 것이
 *   판정인지 **우리가** 고르게 된다. 그것이 provider 자기보고를 신뢰하지 않겠다는 이 설계의
 *   전제를 무너뜨린다.
 */
export function unfenceProviderJson(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```') || trimmed.length < 7) return trimmed;
  const newline = trimmed.indexOf('\n');
  if (newline === -1) return trimmed;
  // 여는 펜스의 언어 태그는 있어도 되고 없어도 되지만, 그 줄에 다른 것이 오면 손대지 않는다.
  const opener = trimmed.slice(3, newline).trim();
  if (opener !== '' && !/^[A-Za-z0-9+-]{1,20}$/.test(opener)) return trimmed;
  return trimmed.slice(newline + 1, -3).trim();
}

export function parseVerifierVerdict(raw, expected) {
  if (!raw || raw.truncated !== false || typeof raw.content !== 'string') return invalid('invalid_raw');
  if (raw.content.length > MAX_PROVIDER_CONTENT_LENGTH) return invalid('content_oversize');

  let value;
  try {
    value = JSON.parse(unfenceProviderJson(raw.content));
  } catch {
    return invalid('invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_json_shape');

  if (expected?.phase === 'initial') {
    if (!validateExpected(expected, 'initial')) return invalid('invalid_expected_binding');
    if (!exactKeys(value, [
      'schemaVersion', 'candidateId', 'attemptId', 'candidatePatchSha256', 'evidenceIds',
      'verdict', 'summary', 'issues', 'notes',
    ])) return invalid('initial_schema');
    if (!stringArray(value.evidenceIds, MAX_BLOCKING_ISSUES) || !uniqueStrings(value.evidenceIds)
      || !boundedString(value.summary) || !stringArray(value.notes, MAX_NOTES)
      || !Array.isArray(value.issues) || value.issues.length > MAX_BLOCKING_ISSUES
      || !value.issues.every(validIssue)) return invalid('initial_value');
    if (!bindingMatches(value, expected)) return invalid('binding_mismatch');
    if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') return invalid('invalid_verdict');
    if ((value.verdict === 'PASS' && value.issues.length !== 0)
      || (value.verdict === 'FAIL' && value.issues.length === 0)) return invalid('verdict_issue_mismatch');
    return deepFreeze({
      ok: true,
      phase: 'initial',
      verdict: value.verdict,
      binding: normalizeBinding(value),
      issues: deepClone(value.issues),
      notes: [...value.notes],
    });
  }

  if (expected?.phase === 'recheck') {
    if (!validateExpected(expected, 'recheck')) return invalid('invalid_expected_binding');
    if (!exactKeys(value, [
      'schemaVersion', 'candidateId', 'attemptId', 'candidatePatchSha256', 'evidenceIds',
      'verdict', 'checks', 'newIssues', 'notes',
    ])) return invalid('recheck_schema');
    if (!stringArray(value.evidenceIds, MAX_BLOCKING_ISSUES) || !uniqueStrings(value.evidenceIds)
      || !stringArray(value.notes, MAX_NOTES) || !Array.isArray(value.checks)
      || !Array.isArray(value.newIssues) || value.newIssues.length > MAX_BLOCKING_ISSUES
      || !value.newIssues.every(validIssue) || !value.checks.every(validCheck)) return invalid('recheck_value');
    if (!bindingMatches(value, expected)) return invalid('binding_mismatch');
    if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') return invalid('invalid_verdict');

    const expectedOpen = expected.openIssueIds;
    const checkedIds = value.checks.map((check) => check.id);
    if (!sameStrings([...checkedIds].sort(), [...expectedOpen].sort()) || !uniqueStrings(checkedIds)) {
      return invalid('recheck_checks_mismatch');
    }
    const replacementIndexes = value.checks
      .filter((check) => check.status === 'superseded')
      .map((check) => check.replacementIndex);
    if (replacementIndexes.some((index) => index >= value.newIssues.length)
      || !uniqueStrings(replacementIndexes.map(String))) return invalid('recheck_replacement_mismatch');

    const resultingOpen = value.checks.filter((check) => check.status !== 'resolved').length
      + value.newIssues.length;
    if ((value.verdict === 'PASS' && resultingOpen !== 0)
      || (value.verdict === 'FAIL' && resultingOpen === 0)) return invalid('verdict_issue_mismatch');
    return deepFreeze({
      ok: true,
      phase: 'recheck',
      verdict: value.verdict,
      binding: normalizeBinding(value),
      checks: deepClone(value.checks),
      newIssues: deepClone(value.newIssues),
      notes: [...value.notes],
    });
  }

  return invalid('invalid_phase');
}

function lanePrefix(laneId) {
  if (laneId === 'lane-a') return 'A';
  if (laneId === 'lane-b') return 'B';
  return null;
}

function sortOpenIds(entries) {
  return entries.filter((entry) => entry.status === 'open').map((entry) => entry.id).sort();
}

function freezeLedger(ledger) {
  return deepFreeze({
    laneId: ledger.laneId,
    entries: deepClone(ledger.entries),
    openIds: [...ledger.openIds].sort(),
    nextVerifierOrdinal: ledger.nextVerifierOrdinal,
    nextMachineOrdinal: ledger.nextMachineOrdinal,
  });
}

function cloneLedger(ledger) {
  return {
    laneId: ledger.laneId,
    entries: deepClone(ledger.entries),
    openIds: [...ledger.openIds],
    nextVerifierOrdinal: ledger.nextVerifierOrdinal,
    nextMachineOrdinal: ledger.nextMachineOrdinal,
  };
}

function verifierId(prefix, ordinal) {
  return `${prefix}-I${String(ordinal).padStart(3, '0')}`;
}

function machineId(prefix, ordinal) {
  return `${prefix}-T${String(ordinal).padStart(3, '0')}`;
}

/**
 * Build a verifier ledger from an `initial` verdict.
 *
 * ★ `startOrdinal` exists because a lane can receive more than one `initial` verdict: the phase is
 *   chosen by "is any verifier issue open right now", so an attempt whose recheck resolved
 *   everything and then failed on machine evidence asks for a fresh initial verdict. Numbering from
 *   1 again would stamp a **retired** ID onto an unrelated defect, and the coordinator's promise
 *   that it — not the provider — owns stable IDs would be false. Callers that start a lane pass
 *   nothing and get the ordinary 1-based numbering.
 */
export function createIssueLedger({ laneId, verdict, startOrdinal = 1 }) {
  const prefix = lanePrefix(laneId);
  if (!prefix || !verdict || verdict.ok !== true || verdict.phase !== 'initial') return invalid('invalid_initial_ledger');
  if (!Number.isInteger(startOrdinal) || startOrdinal < 1) return invalid('invalid_initial_ledger');
  const entries = verdict.issues.map((issue, index) => ({
    id: verifierId(prefix, startOrdinal + index),
    namespace: 'verifier',
    status: 'open',
    issue: deepClone(issue),
    observations: [],
  }));
  if (entries.length > MAX_BLOCKING_ISSUES) return issueLimitExceeded();
  return freezeLedger({
    laneId,
    entries,
    openIds: sortOpenIds(entries),
    nextVerifierOrdinal: startOrdinal + entries.length,
    nextMachineOrdinal: 1,
  });
}

export function applyRecheckVerdict(ledger, verdict) {
  if (!ledger || !verdict || verdict.ok !== true || verdict.phase !== 'recheck') return invalid('invalid_recheck_ledger');
  const next = cloneLedger(ledger);
  const prefix = lanePrefix(next.laneId);
  if (!prefix) return invalid('invalid_lane');
  const entriesById = new Map(next.entries.map((entry) => [entry.id, entry]));
  const verifierChecks = verdict.checks.filter((check) => entriesById.get(check.id)?.namespace === 'verifier');
  const anticipatedOpen = next.entries.filter((entry) => entry.status === 'open').length
    - verifierChecks.filter((check) => check.status !== 'persists').length
    + verdict.newIssues.length;
  if (anticipatedOpen > MAX_BLOCKING_ISSUES) return issueLimitExceeded();

  const newEntries = verdict.newIssues.map((issue, index) => ({
    id: verifierId(prefix, next.nextVerifierOrdinal + index),
    namespace: 'verifier',
    status: 'open',
    issue: deepClone(issue),
    observations: [],
  }));
  for (const check of verifierChecks) {
    const entry = entriesById.get(check.id);
    entry.observations.push(deepClone(check));
    if (check.status === 'resolved') entry.status = 'resolved';
    if (check.status === 'superseded') {
      entry.status = 'superseded';
      entry.replacedBy = newEntries[check.replacementIndex]?.id ?? null;
    }
  }
  next.entries.push(...newEntries);
  next.nextVerifierOrdinal += newEntries.length;
  next.openIds = sortOpenIds(next.entries);
  return freezeLedger(next);
}

export function applyMachineIssues(ledger, input) {
  if (!ledger || !input || !Array.isArray(input.failureFingerprints)) return invalid('invalid_machine_issues');
  const next = cloneLedger(ledger);
  const prefix = lanePrefix(next.laneId);
  if (!prefix) return invalid('invalid_lane');
  if (input.trusted !== true || input.completed !== true) return freezeLedger(next);
  if (!stringArray(input.failureFingerprints, MAX_BLOCKING_ISSUES)) return invalid('invalid_machine_issues');

  const fingerprints = [];
  for (const fingerprint of input.failureFingerprints) {
    if (!fingerprints.includes(fingerprint)) fingerprints.push(fingerprint);
  }
  const machineEntries = next.entries.filter((entry) => entry.namespace === 'machine');
  const byFingerprint = new Map(machineEntries.map((entry) => [entry.fingerprint, entry]));
  const incoming = new Set(fingerprints);
  for (const entry of machineEntries) {
    if (entry.status === 'open' && !incoming.has(entry.fingerprint)) entry.status = 'resolved';
  }
  for (const fingerprint of fingerprints) {
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.status = 'open';
      continue;
    }
    if (sortOpenIds(next.entries).length >= MAX_BLOCKING_ISSUES) return issueLimitExceeded();
    const entry = {
      id: machineId(prefix, next.nextMachineOrdinal),
      namespace: 'machine',
      status: 'open',
      fingerprint,
      observations: [],
    };
    next.entries.push(entry);
    byFingerprint.set(fingerprint, entry);
    next.nextMachineOrdinal += 1;
  }
  next.openIds = sortOpenIds(next.entries);
  return freezeLedger(next);
}

export function makeStagnationFingerprint({ treeHash, openIssueIds, trustedFailureFingerprints }) {
  const canonical = JSON.stringify({
    treeHash,
    openIssueIds: [...new Set(openIssueIds)].sort(),
    trustedFailureFingerprints: [...new Set(trustedFailureFingerprints)].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
