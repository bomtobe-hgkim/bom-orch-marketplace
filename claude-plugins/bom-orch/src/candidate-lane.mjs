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
import { REASON } from './reason-codes.mjs';
import { MAX_ISSUE_CLAIM_CHARS } from './run-records.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { cloneData, exactObject } from './util/objects.mjs';
import { clipWhole, compareUtf8, isSafeCount } from './util/strings.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * writer 가 attempt 를 끝낸 **비정상** 상태의 닫힌 어휘. 불변 attempt 기록의 `writerResult` 로
 * 남으므로 `src/run-records.mjs` 의 `WRITER_RESULTS` 와 **같은 값 집합**이어야 한다
 * (그쪽이 저장 단계의 검증기다).
 *
 * ★ WS2 Task 15 가 옛 철자(`provider_failed`·`timeout`·`effect_unknown`·`snapshot_failed`·
 *   `seal_failed`)를 레지스트리 이름으로 옮겼다. 디스크에 남은 옛 값은 읽기 별칭
 *   (`LEGACY_REASON_ALIASES`)이 계속 받는다 — 쓰기만 새 이름이다(불변식 9, WS2 §2.4).
 */
const OPERATIONAL_RESULTS = new Set([
  REASON.provider_reported_failure,
  REASON.provider_deadline_exceeded,
  REASON.provider_outcome_unknown,
  REASON.git_snapshot_failed,
  REASON.git_seal_failed,
]);

function emptyUsage() {
  return { calls: 0, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: false };
}

function startUsage(usage) {
  return { ...usage, calls: usage.calls + 1 };
}

function cancelUsage(usage) {
  return { ...usage, calls: Math.max(0, usage.calls - 1) };
}

function settleUsage(usage, settlement) {
  const next = { ...usage };
  if (isSafeCount(settlement?.promptTokens)) next.promptTokensKnown += settlement.promptTokens;
  else next.incomplete = true;
  if (isSafeCount(settlement?.evalTokens)) next.evalTokensKnown += settlement.evalTokens;
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

/**
 * 이 레인이 **정지 신호 때문에** 멈춘다면 그 사유. 레인은 신호를 직접 안 본다 — 보는 것은
 * 접힌 하나(`deps.isAborted`)뿐이라 「누가 껐는가」를 답할 수 없다(WS3 §0-C1).
 *
 * ★★ 실측 결함(태스크 7 리뷰 M1): 아래 일곱 자리가 `REASON.run_deadline_exceeded` 를 리터럴로
 *   적고 있었는데, 그 자리를 여는 검사는 접힌 신호를 읽는다. 그래서 호스트가 끊은 실행이
 *   최상위는 `cancelled` 인데 본문의 후보 줄은 `deadline_exceeded` 였고, 블로커는 "The 3300000
 *   millisecond deadline ... Raise wait_ms and retry" 라고 말했다 — 정지 버튼을 누른 사용자에게.
 * ★ 그래서 판정은 여기서 하지 않고 **엔진의 유일한 판정 자리**(`haltReasonCode`)를 그대로
 *   받아 쓴다. 안 넘겨준 호출자(레인 단위 테스트)에게는 마감이 오늘의 값이다.
 */
function haltCode(deps) {
  const code = deps.haltReasonCode?.();
  return typeof code === 'string' && code !== '' ? code : REASON.run_deadline_exceeded;
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
  ].map(cloneData);
  const openIds = entries.filter((entry) => entry.status === 'open').map((entry) => entry.id).sort();
  if (openIds.length > 100) return { ok: false, kind: 'issue_limit_exceeded', code: REASON.verifier_issue_limit_exceeded };
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
    return {
      action: 'reject',
      terminalClass: 'rejected',
      reason: input.policyFailure ? REASON.scope_policy_failure : REASON.scope_tamper_failure,
    };
  }
  if (input?.stagnated) return { action: 'stagnate', terminalClass: 'rejected', reason: REASON.lane_stagnated };
  if (input?.verifier?.verdict !== 'PASS') {
    if (input?.budgetRemaining) return { action: 'repair', reason: REASON.verifier_failed };
    return { action: 'reject', terminalClass: 'rejected', reason: REASON.verifier_failed };
  }
  if (input?.machine?.status === 'fail') {
    if (input?.budgetRemaining && input.machine.repairable === true) return { action: 'repair', reason: REASON.test_machine_failed };
    return { action: 'reject', terminalClass: 'rejected', reason: REASON.test_machine_failed };
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
    if (input?.budgetRemaining) return { action: 'repair', reason: REASON.verifier_issues_open };
    return { action: 'reject', terminalClass: 'rejected', reason: REASON.verifier_issues_open };
  }
  if (input?.proof?.required === true && input.proof.status !== 'proved') {
    if (input.proof.repairable === true && input.budgetRemaining) return { action: 'repair', reason: REASON.test_proof_not_proven };
    if (input.proof.repairable === true) return { action: 'reject', terminalClass: 'rejected', reason: REASON.test_proof_not_proven };
    return { action: 'accept', terminalClass: 'usable_unverified', reason: REASON.evidence_unavailable };
  }
  if (input?.machine?.status === 'unavailable' || input?.evidenceUnavailable) {
    return { action: 'accept', terminalClass: 'usable_unverified', reason: REASON.evidence_unavailable };
  }
  return { action: 'accept', terminalClass: 'verified', reason: REASON.lane_verified };
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

/**
 * 범위를 **못 읽었을 때**의 모양 — `normalizedScope` 의 기본값과 정확히 반대쪽이다(WS5 T1 m1).
 *
 * ★ 「모르는 것은 승인이 아니다」를 값으로 적는다: 걸렸고(`flagged`), 지울 수 없는 등급이고
 *   (`hardViolation`), 아무도 안 지웠다(`allowlisted: false`). 사유 목록은 **비어 있다** —
 *   못 읽은 목록을 지어내는 것보다 0건이 정직하고, 그 0 이 실제 하드 위반과 이것을 가른다.
 */
function unreadableScope() {
  return {
    flagged: true, hardViolation: true, allowlisted: false,
    reasons: [], reasonCount: 0, omittedReasonCount: 0, changedFileCount: 0,
  };
}

/**
 * **컷의 술어** — 「플래그가 섰고, 그중 미승인이 하나라도 남았나」(WS5 스펙 §0 D12).
 *
 * ★★ 두 항의 곱인 이유는 각 항이 서로 다른 실패를 막기 때문이다:
 *   - `flagged !== false` 는 **기본 모양 가드**다. 집계 `allowlisted` 는 플래그가 없으면
 *     거짓이므로(생산자의 ★★), `!allowlisted` 만 읽으면 아무것도 안 걸린 깨끗한 패치가
 *     컷에 걸린다. `=== true` 가 아니라 `!== false` 인 것은 **두 항이 다 없는 모양**을 닫기
 *     위해서다 — scope 를 아예 안 준 평가자는 여기서 통과하면 안 된다.
 *   - `allowlisted !== true` 는 승인의 **명시적 증거**만 받는다. `undefined`·문자열·누락은
 *     전부 미승인이다. 이 축의 실패는 언제나 닫는 쪽이다(생산자의 `allow` 규칙과 같다).
 *
 * ⚠ 「모양이 없으면 닫는다」는 **반만 참이다**(WS5 T4 리뷰 M2). 곱이라서 한 항만 없는 모양은
 *   열린다: `{ allowlisted: true }`(=`flagged` 키 자체가 없음)는 `undefined !== false`(참)
 *   `&& true !== true`(거짓) = **승인**이고, `normalizedScope` 는 nullish 가 아닌 객체를 받으면
 *   키를 안 채우고 그대로 통과시키므로 그 모양이 실제로 `finalScope` 가 될 수 있다. 그 모양이
 *   생산 경로에 없는 근거는 술어가 아니라 **생산자**다: 「승인됐다」는 명시적 주장은
 *   `src/engine.mjs` 의 `scopeSummary` 만 만들고, 그것은 세 불린을 언제나 함께 채운다.
 */
function unapprovedScope(scope) {
  return scope?.flagged !== false && scope?.allowlisted !== true;
}

function normalizedScope(scope) {
  // ★ `reasons` 는 WS2 Task 11 이 더했다. 이 레인은 그 목록을 **읽지 않고 그대로 나른다** —
  //   무엇이 걸렸는지는 봉투 조립이 읽는다(Task 15 가 이 파일의 어휘를 옮긴다). 기본값에 빈
  //   배열을 두는 이유는 셰이프 하나다: 평가자가 scope 를 통째로 생략해도 본문 조립이
  //   `scope.reasons` 를 배열로 볼 수 있어야 한다. 나머지 세 값의 근거는 `finalScope` 의 ★ 주석이다.
  // ★ `hardViolation`(WS5 T1)도 같은 이유로 기본값이 있다. `flagged: false` 와 짝이라 이 셰이프
  //   안에서 「하드 위반 없음」은 참이다 — 플래그가 없는데 하드 위반이 있다고 말하면 봉투가
  //   거짓을 싣는다.
  // ★★ 이 기본값은 이제 **「평가자가 scope 를 안 줬다」 하나만** 받는다(WS5 T4 가 T1 m1 을
  //   닫았다). 복사 실패는 여기 오지 않고 `unreadableScope` 로 간다 — 두 사실을 한 값으로
  //   접은 것이 원인이었고, 가른 자리는 호출부다(`finalScope` 를 짓는 ★★ 를 보라).
  //   그래서 이 모양은 **열리는 쪽이어도 맞다**: 아무것도 안 걸렸다고 말한 것과 같다.
  // ★ `allowlisted`(WS5 T2)도 같은 셰이프에 산다. 기본값이 `false` 인 것은 위 ⚠ 와 **반대로**
  //   닫는 쪽이다: 「허용목록이 지웠다」를 아무도 말하지 않은 scope 는 지워지지 않은 것이다.
  return scope ?? { flagged: false, hardViolation: false, allowlisted: false, reasons: [], reasonCount: 0, omittedReasonCount: 0, changedFileCount: 0 };
}

/**
 * 열린 이슈의 **본문** — attempt 기록에 실려 실행이 끝난 뒤에도 남는다(WS2 스펙 「verifier 이슈 본문」).
 * 지금까지 이 기록에는 식별자만 있었고, 그래서 "무엇이 왜 막았는가" 는 실행과 함께 사라졌다.
 *
 * ★ `openIssueIds` 와 **같은 순서의 같은 집합**을 낸다 — 검증기(`normalizeIssueBodies`)가 그것을
 *   조인다. 본문이 다른 결함에 붙는 사고는 조용하기 때문이다.
 * ★ `claim` 은 모델 산문이라 상한에서 자른다. 말줄임표까지 상한 안에 들어오도록 한 칸을 뺀다 —
 *   `MAX_ISSUE_CLAIM_CHARS` 를 넘긴 값은 저장 단계가 기록 전체를 거절한다.
 * ★ 자르는 함수가 `clipPlain` 이 아니라 `clipWhole` 인 이유: 상한이 서로게이트 쌍 한가운데
 *   떨어지면 맨 `slice` 는 반쪽을 남기고, 그 반쪽을 저장 단계의 `boundedText` 가 거절한다
 *   (짝 없는 서로게이트는 `Buffer` 에서 U+FFFD 로 조용히 바뀌어 해시를 무너뜨린다). 우리가 자른
 *   값을 우리 검증기가 못 받는 모양이었고, 그 대가는 이슈 본문이 아니라 레인 전체의 실패였다.
 * ★ machine 이슈에는 산문이 없다(지문뿐). 그때 `claim` 은 빈 문자열이고 근거는 지문이다 —
 *   없는 문장을 지어내면 그 문장을 사람이 읽고 원인이라고 믿는다.
 * ★ 근거는 **digest 로만** 나른다: 원문은 봉투에도 매니페스트에도 들어가지 않는다(불변식 4).
 */
function issueBodies(ledger) {
  const open = new Set(ledger?.openIds ?? []);
  return (ledger?.entries ?? [])
    .filter((entry) => open.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      claim: clipWhole(entry.issue?.claim ?? '', MAX_ISSUE_CLAIM_CHARS - 1),
      evidenceDigest: createHash('sha256').update(entry.issue?.evidence ?? entry.fingerprint ?? '', 'utf8').digest('hex'),
      severity: 'blocking',
    }))
    .sort((left, right) => compareUtf8(left.id, right.id));
}

function normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult, sealed = null, verdictRef = null, writerUsage, verifierUsage, result, feedback }) {
  return deepFreeze({
    schemaVersion: 1,
    laneId: spec.laneId,
    attemptId: attemptId(spec, ordinal),
    ordinal,
    retryOf,
    binding: cloneData(binding),
    writerResult,
    sealed: sealed ? cloneData(sealed) : null,
    verdictRef: verdictRef ? cloneData(verdictRef) : null,
    usage: { writer: writerUsage, verifier: verifierUsage },
    result,
    // 두 목록은 **같은 비교기**로 정렬한다. 기본 `.sort()` 는 UTF-16 코드유닛 순서라 ASCII 전용인
    // 이슈 id(`ISSUE_ID_PATTERN`)에서는 오늘 `compareUtf8` 과 답이 같지만, 그 일치는 패턴이 ASCII
    // 라는 우연이다 — 순서가 갈리면 본문이 다른 결함에 붙고 저장 단계가 기록을 통째로 거절한다.
    feedback: {
      openIssueIds: [...(feedback?.openIds ?? [])].sort(compareUtf8),
      issues: issueBodies(feedback),
    },
  });
}

async function writeTerminal(deps, attempts, attempt) {
  const immutable = deepFreeze(cloneData(attempt));
  let written;
  try {
    written = await deps.writeAttemptArtifact(immutable);
  } catch {
    written = null;
  }
  const ref = exactObject(written?.ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']).value ?? null;
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
  const sorted = [...strings].sort(compareUtf8);
  return strings.every((value, index) => value === sorted[index]);
}

function validClassified(value, record) {
  const exact = exactObject(value, [
    'execution', 'outcome', 'failureKind', 'stability', 'reproduction', 'witnessIds',
    'failureFingerprints', 'outputSha256', 'outputChars', 'planFingerprint',
    'environmentFingerprint', 'truncated', 'diagnostics',
  ]).value ?? null;
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
    const exact = exactObject(entry, ['kind', 'candidateId', 'attemptId', 'evidenceId', 'path', 'status', 'recoveryPath']).value ?? null;
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
    const exactRecord = exactObject(record, [
      'schemaVersion', 'evidenceId', 'attemptId', 'kind', 'repetition', 'baselineRevision', 'baselineTree',
      'candidateRevision', 'candidateTree', 'candidatePatchSha256', 'testPlanFingerprint', 'environmentFingerprint',
      'testDeltaSha256', 'classified',
    ]).value ?? null;
    const exactRef = exactObject(ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']).value ?? null;
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
  ids.sort(compareUtf8);
  const proofIds = evaluation?.regressionProof?.evidenceIds;
  if (!Array.isArray(proofIds) || new Set(proofIds).size !== proofIds.length ||
      proofIds.some((id) => !ids.includes(id)) ||
      evaluation.regressionProof?.status === 'proved' &&
        (proofIds.length !== ids.length || proofIds.some((id, index) => id !== ids[index]))) return null;
  return deepFreeze({ ...cloneData(sealed), evidenceIds: ids });
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
  const binding = deepFreeze(cloneData(spec.binding));
  const attempts = [];
  let ledger = emptyLedger(spec.laneId);
  let previousFingerprint = null;
  let finalTests = defaultTests();
  let finalProof = defaultProof(spec.proofRequirement);
  let finalScope = normalizedScope();
  let finalVerdict = null;
  let stopReason = REASON.lane_budget_exhausted;
  // 판정문을 읽지 못한 경우에만 채워진다 — `verifier_verdict_invalid` 의 `{detail}` 인자다.
  // 봉투 문구를 만드는 쪽(`src/engine.mjs` 의 terminalParams)이 이 값을 그대로 넘긴다.
  let stopDetail = null;
  let terminalClass = 'rejected';
  let laneRecovery = null;
  let lastSealedParent = spec.baseline?.commit ?? null;
  let latestTerminalSeal = null;
  let totalUsage = emptyUsage();

  // ★ 재개된 레인은 자기 서수 1 이 아니라 원본이 봉인한 마지막 서수의 **다음**부터 쓴다(WS3 §3).
  //   예산은 상한 그대로다: 재사용된 서수만큼 이 실행이 쓸 수 있는 시도가 줄어든다(WS0 §1.2).
  // ★★ `retryOf` 는 **서수 규칙 그대로**다 — 1 이면 `null`, 아니면 앞 서수의 이름(불변식 9:
  //   0.2.2 리더가 요구하는 값이 정확히 그것이다, `run-manifest.mjs expectedRetryOf`). 재개된
  //   레인의 첫 attempt 가 가리키는 앞 서수의 작업은 원본 실행에 있고 이 매니페스트에는 없다.
  const startOrdinal = Number.isInteger(spec.startOrdinal) && spec.startOrdinal >= 1 ? spec.startOrdinal : 1;
  let retryOf = startOrdinal > 1 ? attemptId(spec, startOrdinal - 1) : null;
  for (let ordinal = startOrdinal; ordinal <= spec.budget; ordinal += 1) {
    const id = attemptId(spec, ordinal);
    if (!beforeDeadline(spec, deps) || deps.isAborted?.() === true) {
      stopReason = haltCode(deps);
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
      stopReason = REASON.artifact_allocation_checkpoint_failed;
      terminalClass = 'blocked';
      break;
    }

    let writerUsage = emptyUsage();
    let verifierUsage = emptyUsage();
    if (!beforeDeadline(spec, deps)) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: REASON.provider_deadline_exceeded, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = haltCode(deps);
      terminalClass = 'blocked';
      if (!written) stopReason = REASON.artifact_attempt_write_failed;
      break;
    }
    writerUsage = startUsage(writerUsage);
    let writer;
    try {
      writer = await deps.callWriter({
        runId: spec.runId, laneId: spec.laneId, attemptId: id, ordinal, retryOf,
        binding: cloneData(binding), task: spec.task, plan: spec.plan, feedback: cloneData(ledger),
      });
      if (writer?.callStarted === false) writerUsage = cancelUsage(writerUsage);
      else writerUsage = settleUsage(writerUsage, writer?.usage);
    } catch {
      writerUsage.incomplete = true;
      writer = { status: REASON.provider_outcome_unknown };
    }
    totalUsage = addUsage(totalUsage, writerUsage);
    let writerResult = OPERATIONAL_RESULTS.has(writer?.status) ? writer.status : writer?.status === 'sealed' ? 'sealed' : REASON.provider_outcome_unknown;
    if (!beforeDeadline(spec, deps) && writerResult === 'sealed') writerResult = REASON.provider_outcome_unknown;
    if (writerResult !== 'sealed' || !beforeDeadline(spec, deps)) {
      const result = writerResult === REASON.provider_outcome_unknown ? REASON.provider_outcome_unknown
        : !beforeDeadline(spec, deps) ? REASON.provider_deadline_exceeded : writerResult;
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: result, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = written
        ? (result === REASON.provider_outcome_unknown ? result
          : !beforeDeadline(spec, deps) ? haltCode(deps) : result)
        : REASON.artifact_attempt_write_failed;
      terminalClass = 'blocked';
      if (result === REASON.provider_outcome_unknown) {
        try { await deps.quarantineWorktree({ path: spec.authoringWorktree.path, attemptId: id, lastSealedParent }); } catch { /* recovery remains exact */ }
        laneRecovery = recovery(REASON.provider_outcome_unknown, spec, id, lastSealedParent);
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
        const sealed = deepFreeze({ ...cloneData(seal.sealed), evidenceIds: [] });
        lastSealedParent = sealed.commit;
        const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
        const written = await writeTerminal(deps, attempts, attempt);
        if (written) latestTerminalSeal = { attemptId: id, sealed };
        stopReason = written ? haltCode(deps) : REASON.artifact_attempt_write_failed;
        terminalClass = 'blocked';
        break;
      }
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: REASON.provider_deadline_exceeded, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = written ? haltCode(deps) : REASON.artifact_attempt_write_failed;
      terminalClass = 'blocked';
      break;
    }
    if (!seal?.ok || !seal.sealed || Array.isArray(seal.sealed.evidenceIds)) {
      const writerFailure = seal?.writerResult === REASON.git_snapshot_failed ? REASON.git_snapshot_failed : REASON.git_seal_failed;
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: writerFailure, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      stopReason = written ? writerFailure : REASON.artifact_attempt_write_failed;
      terminalClass = 'blocked';
      break;
    }
    const sealedCore = deepFreeze(cloneData(seal.sealed));
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
      stopReason = written ? haltCode(deps) : REASON.artifact_attempt_write_failed;
      terminalClass = 'blocked';
      break;
    }
    if (sealed === null || evaluation?.operationalFailure !== null || cleanupHandoffFailed || cleanupPending) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed: sealed ?? { ...sealedCore, evidenceIds: [] }, writerUsage, verifierUsage, result: 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed: attempt.sealed };
      stopReason = written
        ? cleanupPending ? REASON.evidence_cleanup_unproven
          : evaluation?.operationalFailure?.code ?? REASON.evidence_authority_mismatch
        : REASON.artifact_attempt_write_failed;
      terminalClass = 'blocked';
      const leakingEvidence = cleanupPending ? evaluation.cleanup.find((entry) => entry.status === 'reaper_pending') : null;
      laneRecovery = leakingEvidence ? deepFreeze({ code: REASON.evidence_cleanup_unproven, path: leakingEvidence.path, lastSealedParent, attemptId: id }) : recovery(
        stopReason === REASON.artifact_attempt_write_failed ? REASON.artifact_attempt_write_failed : REASON.evidence_cleanup_unproven,
        spec, id, lastSealedParent,
      );
      break;
    }

    // ★ 복사에 실패하면 **기본값**으로 닫는다. `evaluateAttempt` 는 주입 가능한 이음매라
    //   `tests` 가 Date·getter·순환을 물고 올 수 있고, 그때 `cloneData` 는 `undefined` 를 낸다.
    //   그것을 그대로 흘리면 `summary.tests` 가 통째로 사라져 한참 뒤 엔진의 요약 복사에서
    //   터졌다(실측). 기본값은 "테스트를 못 돌렸다"(`execution: not_run`·`trusted: false`)와
    //   "증명 없음"이라 **닫는 쪽**이고, 새 reason code 없이 기존 판정이 그대로 처리한다.
    finalTests = cloneData(evaluation.tests ?? defaultTests()) ?? defaultTests();
    finalProof = cloneData(evaluation.regressionProof ?? defaultProof(spec.proofRequirement))
      ?? defaultProof(spec.proofRequirement);
    // ★★ `scope` 의 복사 실패는 **「생략했다」와 다른 사실이다**(WS5 T1 m1, 이 파일의 ⚠ 가
    //   가리키던 자리). 예전에는 둘이 한 값으로 접혀 있었다: `cloneData` 가 실패하면
    //   `undefined` 가 `normalizedScope` 의 `?? {flagged:false,…}` 로 떨어져 **허용**이 됐고,
    //   그 기본값은 `evaluation.scope` 를 아예 안 준 평가자가 받는 값과 **같은 한 줄**이었다.
    //   컷이 착지한 지금 그 통과는 허용목록도 승격도 없이 코어 하드가 승인된 것과 같은 결과다.
    //   고치는 것은 기본값이 아니라 **가르는 것**이다: 안 줬으면 오늘의 기본값(통과)이 맞고,
    //   줬는데 못 베꼈으면 우리는 그 실행의 범위에 대해 **아무것도 모른다** — 모르는 것은
    //   승인일 수 없으므로 닫는 쪽 모양(`unreadableScope`)으로 간다.
    //   ⚠ 그때 봉투는 「flagged · 하드 · 미승인 · 사유 0건」으로 나간다. 사유 0건이 실제 하드
    //   위반과 구별되는 유일한 표시이고, 전용 어휘를 여기서 만들지 않은 것은 **거부 경로의
    //   어휘를 T9 이 소유**하기 때문이다(그 태스크가 이 자리를 다시 본다 — 보고서에 적었다).
    const reportedScope = evaluation.scope;
    const scopeStated = reportedScope !== undefined && reportedScope !== null;
    const copiedScope = scopeStated ? cloneData(reportedScope) : undefined;
    finalScope = scopeStated && copiedScope === undefined ? unreadableScope() : normalizedScope(copiedScope);
    // ★★ **컷 (2)/셋** (WS5 T4, 스펙 §0 D12). 술어는 `unapprovedScope` 하나가 정하고 이 파일의
    //   두 자리(여기와 아래 `policyFailure`)가 **같은 것**을 읽는다 — 갈리면 한 자리는 거절하고
    //   다른 자리는 판정에 안 알리는 실행이 생긴다.
    if (unapprovedScope(finalScope)) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'rejected', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      stopReason = written ? REASON.scope_policy_failure : REASON.artifact_attempt_write_failed;
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
      stopReason = written ? REASON.verifier_issue_limit_exceeded : REASON.artifact_attempt_write_failed;
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
          expected: cloneData(expected), binding: cloneData(binding), feedback: cloneData(ledger),
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
      // ★★ 파서가 거절한 경우에만 `detail` 이 있다(`src/verdict.mjs invalid()` — 그 함수의 모든
      //   갈래가 문자열을 채운다). 없는 경우는 **판정문이 아예 오지 않은 것**이다:
      //   `callVerifier` 가 던지면 `parsed` 는 undefined 로 남는다.
      const parserDetail = typeof parsed?.detail === 'string' && parsed.detail !== '' ? parsed.detail : null;
      // ★★ 던진 호출은 「판정문을 못 읽었다」가 아니라 **검증자 호출의 운영 실패**다. 예전에는 이
      //   자리가 그것까지 `verifier_verdict_invalid` 로 적었고, 그 코드의 문구는 `{detail}` 을
      //   요구하는데 detail 이 없어 문구 정본이 던졌다 — 봉투는 사실이 하나도 없는 폴백 문장과
      //   `envelope_render_degraded` 알림으로 강등됐고, 그러고도 틀린 말을 했다. 엔진은 벤더 예외를
      //   이미 `verifier_operational_failure` 로 부른다(그 길은 `operationalFailure: true` 로 온다) —
      //   한 사건은 한 이름을 가져야 하므로 주입된 `callVerifier` 가 던지는 길도 같은 코드다.
      //   그 결과 `verifier_verdict_invalid` 는 **detail 이 있을 때만** 도달한다.
      // ★ `parsed?.ok !== true` 를 함께 요구한다: 이 분기는 판정이 **성립했는데** 데드라인이
      //   지난 경우로도 들어온다(위 조건의 왼쪽). 그때까지 운영 실패로 부르면 레인이 회복
      //   경로를 달고 워크트리가 리퍼에게 넘어간다 — 데드라인은 그런 사건이 아니다.
      const verifierOperational = parsed?.operational === true ||
        parsed?.ok !== true && !mutated && parserDetail === null;
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: mutated ? 'rejected' : 'blocked', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      // ★★ 판정문을 못 읽은 경우의 코드는 **하나**이고(`verifier_verdict_invalid`) 어느 검사가
      //   걸렀는지는 `parsed.detail` 이 나른다(WS2 §2.2-3). 예전에는 이 자리가 `parsed` 를 읽지
      //   않고 전부 `unverified` 한 토큰으로 접었다 — 두 번 물어보고도 실패한 이유를 사용자가
      //   읽을 수 있는 자리가 어디에도 없었다.
      stopReason = written
        ? (!beforeDeadline(spec, deps) ? haltCode(deps)
          : mutated ? REASON.verifier_mutation
            : verifierOperational ? REASON.verifier_operational_failure : REASON.verifier_verdict_invalid)
        : REASON.artifact_attempt_write_failed;
      if (stopReason === REASON.verifier_verdict_invalid) stopDetail = parserDetail;
      terminalClass = mutated ? 'rejected' : 'blocked';
      if (verifierOperational) laneRecovery = recovery(REASON.provider_outcome_unknown, spec, id, lastSealedParent);
      break;
    }

    const updatedLedger = parsed.phase === 'initial'
      ? mergeInitialLedger(ledger, parsed)
      : applyRecheckVerdict(ledger, parsed);
    if (updatedLedger?.ok === false) {
      const attempt = normalizedAttempt({ spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed, writerUsage, verifierUsage, result: 'rejected', feedback: ledger });
      const written = await writeTerminal(deps, attempts, attempt);
      if (written) latestTerminalSeal = { attemptId: id, sealed };
      stopReason = written ? REASON.verifier_issue_limit_exceeded : REASON.artifact_attempt_write_failed;
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
      // 위 컷과 **같은 술어**다(WS5 T4). 승인된 플래그는 판정에 정책 실패로 안 실린다.
      policyFailure: unapprovedScope(finalScope),
      budgetRemaining: ordinal < spec.budget,
      stagnated: previousFingerprint === fingerprint,
      openIssueCount: ledger.openIds.length,
    });
    previousFingerprint = fingerprint;
    const result = decision.action === 'accept' ? 'accepted'
      : decision.action === 'stagnate' ? REASON.lane_stagnated
        : decision.action === 'reject' ? 'rejected' : decision.action;
    const attempt = normalizedAttempt({
      spec, binding, ordinal, retryOf, writerResult: 'sealed', sealed,
      verdictRef: { verdict: parsed.verdict, issueIds: ledger.openIds },
      writerUsage, verifierUsage, result, feedback: ledger,
    });
    const written = await writeTerminal(deps, attempts, attempt);
    if (!written) {
      stopReason = REASON.artifact_attempt_write_failed;
      terminalClass = 'blocked';
      laneRecovery = recovery(REASON.artifact_attempt_write_failed, spec, id, lastSealedParent);
      break;
    }
    latestTerminalSeal = { attemptId: id, sealed };
    stopReason = decision.reason;
    stopDetail = null;
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
        sealed: cloneData(latestTerminalSeal.sealed),
      });
      const exactPersisted = exactObject(persisted, ['sourceAttemptId', 'ref', 'empty', 'files']).value ?? null;
      const ref = exactObject(persisted?.ref, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']).value ?? null;
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
      patch = cloneData(persisted);
    } catch {
      terminalClass = 'blocked';
      stopReason = REASON.artifact_candidate_write_failed;
      laneRecovery = recovery(REASON.artifact_candidate_write_failed, spec, latestTerminalSeal.attemptId, lastSealedParent);
    }
  }

  if (attempts.artifactFailure) {
    stopReason = REASON.artifact_attempt_write_failed;
    terminalClass = 'blocked';
    laneRecovery = recovery(REASON.artifact_attempt_write_failed, spec, attempts.artifactFailure.attemptId, lastSealedParent);
  }
  const sortedAttempts = [...attempts].sort((left, right) => left.ordinal - right.ordinal);
  const usage = totalUsage;
  const summary = {
    candidateId: spec.laneId,
    binding: cloneData(binding),
    terminalClass,
    patch,
    tests: finalTests,
    regressionProof: finalProof,
    verdict: finalVerdict,
    issues: { openIds: [...ledger.openIds].sort(), count: ledger.openIds.length, limitExceeded: false },
    scope: finalScope,
    attempts: sortedAttempts,
    stopReason,
    stopDetail,
    crossVerificationCompleted: finalVerdict !== null,
    usage,
    judgeView: null,
    recovery: laneRecovery,
  };
  if (typeof deps.buildJudgeView === 'function') {
    try {
      const judgeView = deps.buildJudgeView({
        candidate: deepFreeze(cloneData(summary)),
        candidateId: spec.laneId,
        sourceAttemptId: patch?.sourceAttemptId ?? null,
        finalLedger: deepFreeze(cloneData(ledger)),
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
