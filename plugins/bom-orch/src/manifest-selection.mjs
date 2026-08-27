/**
 * 매니페스트 v1 의 **선택 행** — `selection` 의 스키마·정규화와, 그 행이 후보 참조·이슈 요약과 앞뒤가 맞는지(`selectionConsistent`).
 *
 * ★ 5필드 정렬을 **다시 유도하지 않는다.** 등급표 셋과 비교기의 정본은 `src/candidate-selection.mjs` 하나이고 여기서는
 *   `compareCandidateTuples`·`normalizeCandidateTestRank` 를 부른다. WS4a 이전에는 같은 규칙이 두 벌이었다(여기 있던
 *   `compareDurableTuples`+등급표 셋 28줄과 `durableTestRank` 7줄, 저쪽 `tupleCompare`+`TERMINAL_RANK`/`PROOF_RANK`/`TEST_RANK`).
 *   둘이 갈리면 매니페스트가 **자기 생산자가 고른 승자를 거부한다** — `selectionConsistent` 는 기록된 `objective.result` 를
 *   재유도한 결과와 대조하고, 어긋나면 `normalizeRunManifestV1` 전체가 null 로 접히므로 그 실행은 영구히 나아가지 못한다.
 *
 * ★ 어휘 셋(`LANES`·`validLane`·`sameJson`)은 import-free `src/manifest-vocabulary.mjs` 가 단독으로
 *   가진다. 이 선택 잎과 `src/run-manifest.mjs` 는 각각 그곳에서 직접 가져간다.
 *
 * ★ `boundedText` 를 직접 부른다. `src/run-manifest.mjs` 의 boolean 어댑터 `boundedString` 은 사본이 이미 셋이라
 *   (run-manifest:56 · candidate-selection:20 · content-projection:45) 넷째를 만들지 않는다 — 그 정리는 이 태스크 밖이다.
 *
 * ★ 실측 폐포: **10개 모듈 / 2,976줄**(자기 자신 190 포함) — `candidate-selection` 과 그것이 끄는 `verdict`·`reason-codes`·`preflight`(WS4b 가 판사 뷰 예산의 정본으로 붙였다), 그리고 `manifest-vocabulary`·`util/{freeze,hash,objects,strings}`.
 *   저장소 모듈(`run-artifacts`·`run-store-fs`·`run-records`·`run-inspect`)도 `run-manifest` 도 없다 — 이 파일은 잎이다.
 * ★ 수입하는 쪽은 둘이다: `src/run-manifest.mjs`(`normalizeSelection`·`selectionConsistent`)와 `src/run-artifacts.mjs`(`completeIssueSummary`·`normalizeSelection`).
 */

import { compareCandidateTuples, normalizeCandidateTestRank } from './candidate-selection.mjs';
import { sameJson, validLane } from './manifest-vocabulary.mjs';
import { exactDenseArray, exactObject } from './util/objects.mjs';
import { boundedText, isSafeCount } from './util/strings.mjs';

function normalizeComparisonTuple(value) {
  const array = exactDenseArray(value, 5);
  if (array === null || array.length !== 5 || !['verified', 'usable_unverified'].includes(array[0]) ||
      !['proved', 'not_applicable', 'not_proven', 'unavailable', 'flaky'].includes(array[1]) ||
      !['stable_repeated_full_pass', 'stable_one_pass', 'unknown_or_not_run', 'flaky'].includes(array[2]) ||
      !isSafeCount(array[3])) return null;
  const scope = exactDenseArray(array[4], 2);
  if (scope === null || scope.length !== 2 || ![0, 1].includes(scope[0]) || !isSafeCount(scope[1])) return null;
  return [array[0], array[1], array[2], array[3], [scope[0], scope[1]]];
}

function normalizeObjectiveComparison(value) {
  const object = exactObject(value, ['result', 'decisiveField', 'tupleA', 'tupleB']).value ?? null;
  const tupleA = normalizeComparisonTuple(object?.tupleA);
  const tupleB = normalizeComparisonTuple(object?.tupleB);
  return object !== null && ['a', 'b', 'tie', 'equivalent'].includes(object.result) &&
    [null, 'terminalClass', 'proof', 'tests', 'openIssues', 'scope'].includes(object.decisiveField) && tupleA !== null && tupleB !== null
    ? { result: object.result, decisiveField: object.decisiveField, tupleA, tupleB }
    : null;
}

/**
 * ★ `candidate-selection.mjs:712` 에 같은 스키마의 정규화기가 하나 더 있다 — 중복이 아니라 **정책 두 개다**(태스크 3
 *   실측; 스펙 §0-C 정정). 저쪽(생산자·쓰기 쪽)은 `boundedCleanText` 로 경로·신원·자격증명·비밀 표식까지 거부하고,
 *   여기(문서·읽기 쪽)는 공유 `boundedText`(제어문자·짝 잃은 서로게이트)만 잰다. 방향 규칙: 쓰기 쪽은 언제나 여기보다
 *   엄격하거나 같게, **여기를 저쪽만큼 조이지는 마라** — 스크럽 정규식은 휴리스틱이라 앞으로도 조여질 텐데, 읽기 쪽을
 *   조이면 그때마다 이미 디스크에 있던 매니페스트가 `normalizeRunManifestV1` 에서 null 로 접히고(0.2.2 리퍼는 그런
 *   실행을 invalid_manifest 로 영구 미회수로 남긴다), 골든의 심판 산문은 깨끗해서 그 회귀를 잡지 못한다.
 *   통일은 어느 방향이든 호환 아니면 스크럽을 잃는다.
 */
function normalizeJudgeDecision(value) {
  let status;
  try {
    status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
  } catch {
    return null;
  }
  if (status === 'invalid') {
    const object = exactObject(value, ['status', 'judgeIndex', 'corrected', 'code']).value ?? null;
    return object !== null && [1, 2].includes(object.judgeIndex) && typeof object.corrected === 'boolean' &&
      /^[a-z0-9_]{1,64}$/.test(object.code)
      ? { status: 'invalid', judgeIndex: object.judgeIndex, corrected: object.corrected, code: object.code }
      : null;
  }
  if (status !== 'valid') return null;
  const object = exactObject(value, ['status', 'judgeIndex', 'realDecision', 'corrected', 'rationale', 'majorDefects']).value ?? null;
  const defects = exactDenseArray(object?.majorDefects, 20);
  if (object === null || ![1, 2].includes(object.judgeIndex) || !['lane-a', 'lane-b', 'TIE'].includes(object.realDecision) ||
      typeof object.corrected !== 'boolean' || boundedText(object.rationale, 2_000, { allowEmpty: true }) === null || defects === null) return null;
  const normalized = [];
  for (const defect of defects) {
    const item = exactObject(defect, ['category', 'claim', 'evidence']).value ?? null;
    if (item === null || !['correctness', 'security', 'requirements', 'scope', 'tests'].includes(item.category) ||
        boundedText(item.claim, 1_000) === null || boundedText(item.evidence, 1_000) === null) return null;
    normalized.push({ category: item.category, claim: item.claim, evidence: item.evidence });
  }
  return {
    status: 'valid', judgeIndex: object.judgeIndex, realDecision: object.realDecision,
    corrected: object.corrected, rationale: object.rationale, majorDefects: normalized,
  };
}

function normalizeSelection(value) {
  const object = exactObject(value, ['outcome', 'selectedCandidateId', 'objectiveComparison', 'judgeDecisions']).value ?? null;
  const selectedOutcomes = ['winner', 'single_survivor', 'equivalent'];
  const objective = object?.objectiveComparison === null ? null : normalizeObjectiveComparison(object?.objectiveComparison);
  const judges = exactDenseArray(object?.judgeDecisions, 2);
  if (object === null || ![...selectedOutcomes, 'tie', 'none'].includes(object.outcome) ||
      selectedOutcomes.includes(object.outcome) !== (object.selectedCandidateId !== null) ||
      object.selectedCandidateId !== null && !validLane(object.selectedCandidateId) ||
      object.outcome === 'equivalent' && object.selectedCandidateId !== 'lane-a' ||
      objective === null && object.objectiveComparison !== null || judges === null) return null;
  const normalizedJudges = judges.map(normalizeJudgeDecision);
  if (normalizedJudges.some((entry) => entry === null) ||
      new Set(normalizedJudges.map((entry) => entry.judgeIndex)).size !== normalizedJudges.length) return null;
  return {
    outcome: object.outcome,
    selectedCandidateId: object.selectedCandidateId,
    objectiveComparison: objective,
    judgeDecisions: normalizedJudges.sort((a, b) => a.judgeIndex - b.judgeIndex),
  };
}

function eligibleCandidate(candidate) {
  return candidate !== undefined && ['verified', 'usable_unverified'].includes(candidate.terminalClass) &&
    candidate.patchRef !== null && candidate.patchRef.bytes > 0;
}

function sameCandidatePatch(a, b) {
  return eligibleCandidate(a) && eligibleCandidate(b) && a.patchRef.sha256 === b.patchRef.sha256 &&
    a.patchRef.bytes === b.patchRef.bytes;
}

function judgeOutcome(selection) {
  if (selection.judgeDecisions.length !== 2) return null;
  const decisions = selection.judgeDecisions;
  if (decisions.some((entry) => entry.status === 'invalid')) return { outcome: 'none', selectedCandidateId: null };
  if (decisions.some((entry) => entry.majorDefects.length > 0 || entry.realDecision === 'TIE') ||
      decisions[0].realDecision !== decisions[1].realDecision) return { outcome: 'tie', selectedCandidateId: null };
  if (validLane(decisions[0].realDecision)) {
    return { outcome: 'winner', selectedCandidateId: decisions[0].realDecision };
  }
  return null;
}

function durableComparisonTuple(candidate, issueSummary) {
  const scopeCount = candidate.scope.reasonCount + candidate.scope.omittedReasonCount;
  const issues = issueSummary.find((entry) => entry.candidateId === candidate.candidateId);
  if (!isSafeCount(scopeCount) || issues === undefined) return null;
  return [
    candidate.terminalClass,
    candidate.proofStatus,
    normalizeCandidateTestRank(candidate.tests),
    issues.openIssueCount,
    [candidate.scope.flagged ? 1 : 0, scopeCount],
  ];
}

function completeIssueSummary(candidateRefs, issueSummary, candidateCount) {
  return candidateRefs.length === candidateCount && issueSummary.length === candidateCount &&
    candidateRefs.every((candidate) => issueSummary.filter((entry) => entry.candidateId === candidate.candidateId).length === 1);
}

function selectionConsistent(selection, candidateRefs, issueSummary, candidateCount) {
  if (!completeIssueSummary(candidateRefs, issueSummary, candidateCount)) return false;
  const a = candidateRefs.find((entry) => entry.candidateId === 'lane-a');
  const b = candidateRefs.find((entry) => entry.candidateId === 'lane-b');
  const eligible = candidateRefs.filter(eligibleCandidate);
  const selected = selection.selectedCandidateId === null
    ? undefined
    : candidateRefs.find((entry) => entry.candidateId === selection.selectedCandidateId);
  if (selection.selectedCandidateId !== null && !eligibleCandidate(selected)) return false;
  const objective = selection.objectiveComparison;
  if (candidateCount === 1) {
    return objective === null && selection.judgeDecisions.length === 0 &&
      (selection.outcome === 'winner' && selection.selectedCandidateId === 'lane-a' && eligible.length === 1 ||
        selection.outcome === 'none' && selection.selectedCandidateId === null && eligible.length === 0);
  }
  if (objective === null) {
    return selection.judgeDecisions.length === 0 &&
      (selection.outcome === 'single_survivor' && eligible.length === 1 && selected === eligible[0] ||
        selection.outcome === 'none' && eligible.length === 0);
  }
  if (!eligibleCandidate(a) || !eligibleCandidate(b)) return false;
  const tupleA = durableComparisonTuple(a, issueSummary);
  const tupleB = durableComparisonTuple(b, issueSummary);
  if (tupleA === null || tupleB === null || !sameJson(objective.tupleA, tupleA) || !sameJson(objective.tupleB, tupleB)) return false;
  const patchesEqual = sameCandidatePatch(a, b);
  if (patchesEqual) {
    return objective.result === 'equivalent' && objective.decisiveField === null && selection.outcome === 'equivalent' &&
      selection.selectedCandidateId === 'lane-a' &&
      selection.judgeDecisions.length === 0;
  }
  const comparison = compareCandidateTuples(tupleA, tupleB);
  if (objective.result !== comparison.result || objective.decisiveField !== comparison.decisiveField) return false;
  if (comparison.result === 'a' || comparison.result === 'b') {
    const expected = comparison.result === 'a' ? 'lane-a' : 'lane-b';
    return selection.outcome === 'winner' && selection.selectedCandidateId === expected && selection.judgeDecisions.length === 0;
  }
  const judged = judgeOutcome(selection);
  return judged !== null && selection.outcome === judged.outcome &&
    selection.selectedCandidateId === judged.selectedCandidateId;
}

export { completeIssueSummary, normalizeSelection, selectionConsistent };
