import { createHash } from 'node:crypto';
import { REASON } from './reason-codes.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { cloneData, hasExactKeys } from './util/objects.mjs';
import { boundedText } from './util/strings.mjs';

/**
 * 답 **전체**의 상한 — 필드 상한(`MAX_FIELD_LENGTH`)과 다른 수다. 이 검사의 몫은 폭주한 답을 `JSON.parse`
 * 전에 자르는 것 하나뿐이고, 저장되는 문자열은 전부 필드 상한이 따로 잰다. 테스트가 경계를 재도록 export 한다.
 *
 * ★★ 2026-08-28 라이브 실측(실행 8 lane-b): 이 값이 2,000 이었을 때 claude 의 6,682자 판정문(요약 793자·
 *   이슈 5개·비고 984자, 필드마다 상한 안)이 `content_oversize` 로 거절됐고, 형식 정정 재요청도 같은 답을
 *   받아 lane 이 `unverified` 로 닫혔다. 계획서(2026-08-12)의 2,000 은 「provider **문자열 하나**」의
 *   상한인데 답 전체에 옮겨 적혔던 것이다 — 이슈 하나의 세 필드만으로 넘길 수 있는 수라, 이슈를 둘 이상
 *   적는 판정문은 실제 모델 상대로 한 번도 읽힐 수 없었다.
 * ★ 왜 1,000,000 인가(리뷰 실측, 같은 날): 64,000 으로 올렸을 때도 스키마가 허용하는 판정문 — 재확인 100개 ×
 *   근거 2,000자 ≈ 205,000자, 이슈 100개 × 세 필드 + 비고 50개 ≈ 705,000자 — 이 파싱 전에 거절됐다. 같은 결함이
 *   한 자릿수 위에 남은 것이다. 스키마가 허용하는 가장 큰 평문 판정문 위에 두고, 이스케이프(`\uXXXX`)로
 *   부풀 여지까지는 쫓지 않는다 — 이 수는 폭주 방지이지 스키마 상한이 아니다. 1M 문자의 `JSON.parse` 는 수 ms 다.
 */
export const MAX_PROVIDER_CONTENT_LENGTH = 1_000_000;
/** 한 후보의 열린 차단 이슈 상한. `verifier_issue_limit_exceeded` 의 문구가 이 수를 말한다. */
export const MAX_BLOCKING_ISSUES = 100;
const MAX_NOTES = 50;
const MAX_FIELD_LENGTH = 2_000;
const BLOCKING_CATEGORIES = new Set([
  'correctness',
  'security',
  'requirements',
  'scope',
  'tests',
]);

/**
 * 판정문을 읽지 못한 모든 경우의 **코드는 하나**다 — `verifier_verdict_invalid`(WS2 §2.2-3).
 * 어느 검사에서 걸렸는지는 `detail` 로 나르고, 그 값은 문구 정본의 `{detail}` 자리에 그대로 들어간다.
 *
 * ★★ 왜 19개가 아니라 하나인가. 이 파서는 판정문을 거절하는 자리마다 서로 다른 이름을 지어
 *   냈고(`invalid_raw`·`initial_value`·`recheck_replacement_mismatch`…), **아무도 그 이름으로
 *   분기하지 않았다** — 호출부(`src/candidate-lane.mjs`)는 `parsed.ok` 만 보고 전부 한 결말로
 *   접었다. 읽는 쪽이 없는 열아홉 이름을 레지스트리에 등재하면 닫힌 어휘가 열아홉 만큼 커지고
 *   그만큼 아무 소비자도 없는 채로 계약이 된다. 그래서 어휘는 하나, 세부는 인자다.
 * ★ `detail` 은 **식별자**이지 문장이 아니다(문장은 `src/reason-text.mjs` 가 정본). 값이 밖으로
 *   나가는 길은 `verifier_verdict_invalid` 의 `{detail}` 하나뿐이고, 그 자리는 "어느 검사가
 *   걸렀나" 를 말한다.
 */
function invalid(detail) {
  return { ok: false, kind: 'invalid', code: REASON.verifier_verdict_invalid, detail };
}

function issueLimitExceeded() {
  return { ok: false, kind: 'issue_limit_exceeded', code: REASON.verifier_issue_limit_exceeded };
}

/**
 * 원장 문자열의 정책은 **둘**이다 — 식별자는 엄격, 모델이 쓴 산문은 TAB·LF·CR 까지 허용.
 *
 * ★★ 왜 산문만 여는가(WS1 Task 14 후속): 형식 정정 재요청 프롬프트
 *    (`src/prompts/instructions.mjs` `verifierInstruction({ formatOnly: true })`)는 스키마만 다시 보여줄 뿐
 *    **제어문자 얘기를 한마디도 하지 않는다.** 그래서 여러 줄 요약이 집 스타일인 verifier 는
 *    같은 답을 두 번 내고 두 번 다 거부당한 뒤 그 lane 이 `unverified` 로 끝난다 — 고칠 길이
 *    없는 판정 분실이다. TAB·LF·CR 은 JSON 이 그대로 실어 나르는 공백이고 해시도 안정적이라
 *    원장에 남아도 뒤따르는 비교를 흔들지 않는다. 나머지(NUL·다른 C0·DEL·C1·U+FFFD·
 *    짝 없는 서로게이트)는 산문에서도 계속 거부한다.
 * ★ 식별자는 열지 않는다: `check.id`·`evidenceIds`·`openIssueIds` 는 **정렬·비교·해시의
 *   키**다. 그 안의 줄바꿈은 사람 눈에 안 보이면서 두 ID 를 다르게 만든다.
 *   (`contract/envelope.json` 의 verdict 행이 이 두 정책을 적는다.)
 */
function boundedIdentifier(value) {
  return boundedText(value, MAX_FIELD_LENGTH) !== null;
}

function boundedProse(value) {
  return boundedText(value, MAX_FIELD_LENGTH, { allowDiffWhitespace: true }) !== null;
}

function stringArray(value, maxLength, entryValid = boundedIdentifier) {
  return Array.isArray(value)
    && value.length <= maxLength
    && value.every((entry) => entryValid(entry));
}

function uniqueStrings(value) {
  return new Set(value).size === value.length;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validIssue(issue) {
  return hasExactKeys(issue, ['category', 'claim', 'evidence', 'requiredFix'])
    && BLOCKING_CATEGORIES.has(issue.category)
    && boundedProse(issue.claim)
    && boundedProse(issue.evidence)
    && boundedProse(issue.requiredFix);
}

function validCheck(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return false;
  if (!boundedIdentifier(check.id) || !boundedIdentifier(check.status) || !boundedProse(check.evidence)) return false;
  if (check.status === 'superseded') {
    return hasExactKeys(check, ['id', 'status', 'evidence', 'replacementIndex'])
      && Number.isInteger(check.replacementIndex)
      && check.replacementIndex >= 0;
  }
  return (check.status === 'resolved' || check.status === 'persists')
    && hasExactKeys(check, ['id', 'status', 'evidence']);
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
    && boundedIdentifier(expected.candidateId)
    && boundedIdentifier(expected.attemptId)
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
 * ★ 관용은 **펜스 한 블록**이다. 2026-08-28 실행 8 lane-b 실측: 진짜 claude 는 그 펜스 **앞에** 「판정
 *   결과입니다. (파일은 읽기만 했고 …)」 한 줄을 붙였고, 형식 정정 재요청에도 같았다. 펜스가 정확히 하나이고
 *   그 밖의 텍스트에 중괄호·대괄호·백틱이 없으면 후보는 하나뿐이라 우리가 고르는 일이 없다 — 그 산문은
 *   버린다. 블록이 둘이거나 펜스 밖에 JSON 처럼 생긴 것이 있으면 그대로 거부한다: 텍스트에서 JSON 을
 *   긁어모으기 시작하면 어느 것이 판정인지 **우리가** 고르게 되고, 그것이 provider 자기보고를 신뢰하지
 *   않겠다는 이 설계의 전제를 무너뜨린다. 펜스 **줄** 위의 텍스트는 밖 검사가 못 보므로, 여는 줄의 태그
 *   규칙과 닫는 줄의 「백틱뿐」 규칙이 그 자리의 문이다. 펜스 밖 산문이 JSON 스칼라(`"FAIL"`·`true`)여도
 *   버린다 — 객체가 아닌 것은 애초에 판정 후보가 아니라서(`invalid_json_shape`) 전제가 지켜진다.
 * ★ 백틱 넷 이상의 펜스도 받는다(값 안에 ``` 가 있으면 모델이 바깥 펜스를 늘린다) — 닫는 줄은 여는 줄과
 *   같은 길이. 판사 답(`src/candidate-selection.mjs` `parseJudgeDecision`)도 이 함수로 벗긴다 — 같은 관용, 같은 거부.
 */
export function unfenceProviderJson(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const lines = trimmed.split('\n');
  const fences = lines.flatMap((line, index) => (/^```/.test(line.trim()) ? [index] : []));
  if (fences.length !== 2) return trimmed;
  const [open, close] = fences;
  // 여는 펜스의 언어 태그는 있어도 되고 없어도 되지만, 그 줄에 다른 것이 오면 손대지 않는다.
  const [, run, opener] = lines[open].trim().match(/^(`{3,})(.*)$/);
  if (opener.trim() !== '' && !/^[A-Za-z0-9+-]{1,20}$/.test(opener.trim())) return trimmed;
  if (lines[close].trim() !== run) return trimmed;
  const outside = [...lines.slice(0, open), ...lines.slice(close + 1)].join('\n');
  if (/[{}[\]`]/.test(outside)) return trimmed;
  return lines.slice(open + 1, close).join('\n').trim();
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
    if (!hasExactKeys(value, [
      'schemaVersion', 'candidateId', 'attemptId', 'candidatePatchSha256', 'evidenceIds',
      'verdict', 'summary', 'issues', 'notes',
    ])) return invalid('initial_schema');
    if (!stringArray(value.evidenceIds, MAX_BLOCKING_ISSUES) || !uniqueStrings(value.evidenceIds)
      || !boundedProse(value.summary) || !stringArray(value.notes, MAX_NOTES, boundedProse)
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
      issues: cloneData(value.issues),
      notes: [...value.notes],
    });
  }

  if (expected?.phase === 'recheck') {
    if (!validateExpected(expected, 'recheck')) return invalid('invalid_expected_binding');
    if (!hasExactKeys(value, [
      'schemaVersion', 'candidateId', 'attemptId', 'candidatePatchSha256', 'evidenceIds',
      'verdict', 'checks', 'newIssues', 'notes',
    ])) return invalid('recheck_schema');
    if (!stringArray(value.evidenceIds, MAX_BLOCKING_ISSUES) || !uniqueStrings(value.evidenceIds)
      || !stringArray(value.notes, MAX_NOTES, boundedProse) || !Array.isArray(value.checks)
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
      checks: cloneData(value.checks),
      newIssues: cloneData(value.newIssues),
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
    entries: cloneData(ledger.entries),
    openIds: [...ledger.openIds].sort(),
    nextVerifierOrdinal: ledger.nextVerifierOrdinal,
    nextMachineOrdinal: ledger.nextMachineOrdinal,
  });
}

function cloneLedger(ledger) {
  return {
    laneId: ledger.laneId,
    entries: cloneData(ledger.entries),
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
    issue: cloneData(issue),
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
    issue: cloneData(issue),
    observations: [],
  }));
  for (const check of verifierChecks) {
    const entry = entriesById.get(check.id);
    entry.observations.push(cloneData(check));
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
  // ★ 라벨은 지문 옆의 **읽을 수 있는 이름**(`경로 › 이름`, 어댑터가 파싱한 것)이다. 프롬프트 전용이라
  //   attempt 기록에는 안 실린다(`issueBodies` 가 claim 만 옮긴다). 문자열이 아니면 버리고, 라벨 없이
  //   온 실행은 있던 라벨을 지우지 않는다 — 이름을 잃는 쪽이 더 나쁘다.
  const labels = input.labels !== null && typeof input.labels === 'object' && !Array.isArray(input.labels) ? input.labels : {};
  const labelFor = (fingerprint) => (Object.hasOwn(labels, fingerprint) && typeof labels[fingerprint] === 'string' && labels[fingerprint] !== ''
    ? labels[fingerprint] : null);
  for (const entry of machineEntries) {
    if (entry.status === 'open' && !incoming.has(entry.fingerprint)) entry.status = 'resolved';
  }
  for (const fingerprint of fingerprints) {
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.status = 'open';
      if (labelFor(fingerprint) !== null) existing.label = labelFor(fingerprint);
      continue;
    }
    if (sortOpenIds(next.entries).length >= MAX_BLOCKING_ISSUES) return issueLimitExceeded();
    const entry = {
      id: machineId(prefix, next.nextMachineOrdinal),
      namespace: 'machine',
      status: 'open',
      fingerprint,
      label: labelFor(fingerprint),
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
