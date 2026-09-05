/**
 * 실행 하나가 밖으로 내보내는 **본문**을 조립한다 — `src/content-projection.mjs` 가 받는 요약
 * 객체 하나(`buildRunBody`)와, 그 객체의 항목을 만드는 순수 함수들.
 *
 * WS2 Task 11 이 만들었다. 옮긴 것은 `src/engine.mjs` 의 `candidateRefFromSummary` ·
 * `resolvedOmittedCount` · `contentIssue` · `contentCandidate` · `contentVerdict` ·
 * `contentEvidenceRef` · `fixedFloorInput` · `renderContent` · 사용량 누산기 · 학습 행
 * (`commitRunLearning` 과 ref 둘)이고, 새로 만든 것은 C1/C2 가 **각자 적던 payload 리터럴
 * 하나**와 WS2 가 생산하기 시작한 셋(`projectBlockers` · `scope.reasons` · `plan`)이다.
 *
 * ★ 학습 행이 여기 산다는 것은 당연하지 않다 — 그것은 디스크에도 쓴다. 근거는 본문의
 *   `learning.applied` 가 **그 거래의 결과**라는 것이다: 저장이 실패하면 본문은 `grade: null` 을
 *   적어야 하고, 그 둘이 다른 파일에 있으면 한쪽만 고쳐져 봉투가 저널에 없는 등급을 말하게 된다.
 *
 * ★★ 왜 하나로 모으는가. 그 리터럴은 서른 남짓한 키를 두 번 적었고, 둘은 이미 갈리기 시작했다
 *   (한쪽만 `reasons: []`, 한쪽만 `blockers` 에 `candidateId`). 봉투 본문은 **계약**이라
 *   (`contract/envelope.json` 의 runBody 표) 키 하나가 한 곳에서만 태어나야 한다.
 *
 * ★ C1 과 C2 가 **정말로 다른** 값 셋은 인자로 받는다(`stepCount` · `proofStatus` ·
 *   `selectedCandidateId`). 이 태스크는 그 셋을 통일하지 않는다 — 통일은 봉투 바이트를 바꾸는
 *   판정이고, 여기서 조용히 하면 어느 쪽이 옳은지 아무도 묻지 않은 채 값이 달라진다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지). 방향은 engine → run-body 다.
 */
import { isAbsolute } from 'node:path';
import { confidenceOfRun } from './confidence.mjs';
import { renderContentParts } from './content-projection.mjs';
import { gradeToDeltas } from './learn/bandit.mjs';
import { cellKeyOf, commitLearningMutation as defaultCommitLearningMutation } from './learn/posteriors.mjs';
import { computeRunLearningOutcome } from './learn/policy-v2.mjs';
import { REASON, stopReasonOf } from './reason-codes.mjs';
import { renderNotice, safeRender } from './reason-text.mjs';
import { failure, success } from './envelope.mjs';
import { excerptsFor, laneStopCode, successCodeOf } from './run-faults.mjs';
import { stateSchemaNotice } from './state-schema.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { exactDenseArray, ownDataValue } from './util/objects.mjs';
// ★ 벤더 행의 정준 순서는 매니페스트의 정규화기와 **같은 비교기**로 정한다(`compareUtf8`) —
//   두 자리가 다른 순서를 쓰면 누산기가 낸 총계를 원장이 거절하고, 그 거절은 실행 끝에서 난다.
import { compareUtf8 } from './util/strings.mjs';

export function combineContentUsage(...values) {
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

export function createRunUsageAccumulator() {
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
      const bucket = () => ({ calls: 0, promptTokensKnown: 0n, evalTokensKnown: 0n, incomplete: false });
      const totals = bucket();
      const groups = new Map();
      for (const cell of tickets.values()) {
        const vendor = cell.ticket.vendor;
        if (!groups.has(vendor)) groups.set(vendor, bucket());
        // ★ 티켓 하나는 총계와 자기 벤더 **둘 다**에 든다. 두 통을 따로 걸으면 「합이 총계와
        //   같다」가 우연이 되고, 그것이 어긋나는 날 봉투는 자기 자신과 어긋난 비용을 낸다.
        for (const tally of [totals, groups.get(vendor)]) {
          tally.calls += 1;
          if (!cell.settled) tally.incomplete = true;
        }
        if (!cell.settled) continue;
        for (const [source, target] of [['promptTokens', 'promptTokensKnown'], ['evalTokens', 'evalTokensKnown']]) {
          const amount = cell.value?.[source];
          const known = Number.isSafeInteger(amount) && amount >= 0;
          for (const tally of [totals, groups.get(vendor)]) {
            if (known) tally[target] += BigInt(amount);
            else tally.incomplete = true;
          }
        }
      }
      const settled = (tally) => {
        const out = { calls: tally.calls, promptTokensKnown: 0, evalTokensKnown: 0, incomplete: tally.incomplete };
        for (const target of ['promptTokensKnown', 'evalTokensKnown']) {
          if (tally[target] <= BigInt(Number.MAX_SAFE_INTEGER)) out[target] = Number(tally[target]);
          else out.incomplete = true;
        }
        return out;
      };
      // 정준 순서로 낸다 — 매니페스트의 정규화기가 엄격히 증가하는 id 만 받는다(`normalizeRunUsage`).
      const vendors = [...groups.keys()].sort(compareUtf8).map((vendor) => ({ vendor, ...settled(groups.get(vendor)) }));
      finalized = deepFreeze({ ...settled(totals), vendors });
      return finalized;
    },
  });
}

/**
 * 비용 한 줄 — 계약이 `runBody` 에 예약해 둔 모양 그대로다(`contract/envelope.json` 의 `cost` 행,
 * WS4b 스펙 §0-D5·D6·D7). **여기서 새로 세는 것은 하나도 없다**: 세 조각이 전부 이 실행이 이미
 * 다른 이유로 들고 있던 장부다 — 벤더별 티켓(태스크 5 의 `finalize().vendors`), 실행의 시작
 * 시각(엔진이 마감을 짓느라 읽은 그 값), 직렬 테스트 큐의 집계.
 *
 * ★★ 토큰 수는 그 벤더의 회계가 **완전할 때만** 싣는다. `promptTokensKnown` 은 「아는 것의 합」
 *   이지 총계가 아니라서, 한 호출이라도 수를 못 낸 벤더의 그 합을 `promptTokens` 라고 부르면
 *   봉투가 **하계를 총계로** 말한다. 계약이 그 두 키에 `?` 를 붙여 둔 자리가 정확히 이것이다 —
 *   키가 없으면 「이 벤더의 토큰 회계는 이 실행에서 닫히지 않았다」가 읽힌다. `calls` 는 언제나
 *   싣는다: 호출 수는 티켓이 열린 순간 정해지므로 미정산 호출이 있어도 정확하다.
 * ★ 순서는 원장이 정한 정준 순서(`compareUtf8`)를 그대로 물려받는다 — `Object.fromEntries` 는
 *   입력 순서를 보존하므로 두 실행이 같은 벤더를 같은 순서로 낸다(골든 바이트가 그것을 잰다).
 */
function costRow({ usage, elapsedMs, testRuns }) {
  return {
    elapsedMs,
    providers: Object.fromEntries((usage?.vendors ?? []).map((row) => [row.vendor, {
      calls: row.calls,
      ...(row.incomplete === true ? {} : { promptTokens: row.promptTokensKnown, evalTokens: row.evalTokensKnown }),
    }])),
    testRuns: { count: testRuns?.count ?? 0, totalMs: testRuns?.totalMs ?? 0 },
  };
}

/**
 * 이 실행이 **어디서 출발했나** — 계약이 예약해 둔 모양 그대로다(`contract/envelope.json` 의
 * `baseline` 행, 스펙 §0-AP). 네 값 전부 이 실행이 이미 다른 이유로 들고 있던 사실이고,
 * **여기서 새로 재는 것은 하나도 없다.**
 *
 * ★★ `commit`·`tree` 는 실행이 봉인한 baseline 이며 적용 시점 HEAD 와 **별개**다. 깨끗한 시작이면
 *   `commitAll` 이 시작 HEAD 를 그대로 쓰고, 미커밋 작업을 이식했으면 그 뒤 일회용 워크트리에
 *   합성 커밋을 찍는다(그 자리의 주석이 정본이다). 후자의 트리에는 이식한 작업이 들어 있고
 *   사용자 저장소의 어떤 ref 도 그 합성 커밋을 가리키지 않는다. 두 경우를 한 문장으로 접으면
 *   깨끗한 실행에는 없는 도달 불가능 커밋을 있다고 말하게 된다.
 * ★★ `dirty` 는 `worktree.transplanted` 와 **같은 사실을 반대편에서** 본 것이다("이식할 것이
 *   있었다" = "실행이 시작될 때 더러웠다"). 그래서 접는 규칙도 그 행과 글자까지 같다 — 두 자리가
 *   다른 규칙을 쓰면 한 봉투가 `transplanted: true` 옆에 `dirty: false` 를 싣는다.
 * ★ `dirtyFiles` 는 **온 것**의 목록이지 안 온 것의 목록이 아니다(`worktree.ignoredPaths` 가
 *   저쪽이다). 상한은 여기가 아니라 투영이 건다 — 자르는 자리가 둘이면 두 상한이 생긴다.
 *
 * @param {{ baseline: {commit: string, tree: string}, worktrees: Array<object> }} input
 * @returns {{commit, tree, dirty, dirtyFiles}}
 */
export function baselineRow({ baseline, worktrees }) {
  return {
    commit: baseline?.commit ?? null,
    tree: baseline?.tree ?? null,
    dirty: worktrees.some((worktree) => worktree.transplanted === true),
    dirtyFiles: [...new Set(worktrees.flatMap((worktree) => worktree.dirtyFiles ?? []))],
  };
}

export function candidateRefFromSummary(candidate) {
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
    // ★★ 여기에는 `hardViolation`(WS5 T1)을 **싣지 않는다.** 이 함수가 내는 것은 봉투 본문이
    //   아니라 **매니페스트의 후보 체크포인트**이고(`src/run-finalization.mjs:473`·`:719`),
    //   `src/run-manifest.mjs:469-474` 의 `normalizeScope` 는 이 셋을 **정확 키 집합**으로 받는다 —
    //   넷째 키를 실으면 정규화가 `null` 을 내고 실행이 통째로 `A candidate checkpoint could not be
    //   recorded in the run manifest` 로 막힌다(실측: 그 한 줄이 스위트에서 30여 테스트를 붉혔다).
    //   매니페스트는 디스크에 남는 기록이고 0.2.2 리더가 읽는 값이라(불변식 9), 키를 더하는 것은
    //   이 태스크가 아니라 스키마 변경이 필요한 별도 결정이다. 그 결과 `orch_status` 의 재구성은
    //   등급을 **말하지 않는다** — 거짓을 말하는 것이 아니라 기록이 없다(보고서에 적었다).
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

/**
 * 본문의 **두 층** — 세부 코드 하나를 받아 `{stopReason, reasonCode}` 를 낸다.
 *
 * ★★ 이 둘은 서로 다른 어휘이고, 계약(`contract/envelope.json` 의 runBody 두 행)이 그렇게 적는다:
 *   `stopReason` 은 닫힌 열세 값(`STOP_REASONS`)이고 `reasonCode` 는 288 개의 세부 코드다.
 *   WS2 Task 15 가 레인 어휘를 레지스트리로 옮기면서 세부 코드를 조악값 **자리에** 적었고,
 *   그래서 `stopReason` 으로 분기하는 소비자는 열세 값 중 어느 것도 아닌 값을 받았다.
 *   생산자는 조악값을 **고르지 않는다** — `stopReasonOf` 가 레지스트리에서 얻는다(WS2 §2).
 *
 * ★ 먼저 `laneStopCode` 로 올리는 이유: 이 자리에는 디스크에서 읽힌 옛 철자(`verified` 등)도
 *   들어온다. 올리지 않으면 `stopReasonOf` 가 등재되지 않은 값에 **던지고**, 본문 조립이
 *   통째로 사라진다. 봉투 쪽 짝(`successCodeOf`)이 같은 이유로 같은 순서를 쓴다.
 */
function bodyReason(code) {
  const reasonCode = laneStopCode(code);
  return { stopReason: stopReasonOf(reasonCode), reasonCode };
}

function contentIssue(candidate) {
  return {
    candidateId: candidate.candidateId,
    openIssueIds: [...candidate.issues.openIds],
    openIssueCount: candidate.issues.count,
    resolvedOmittedCount: resolvedOmittedCount(candidate),
  };
}

/**
 * 후보 한 줄. `stopReason`·`reasonCode` 는 **두 층**이다 — 조악 열세 값과 세부 코드
 * (`bodyReason` 머리말이 그 규칙의 정본이다).
 */
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
      hardViolation: candidate.scope.hardViolation === true,
      allowlisted: candidate.scope.allowlisted === true,
      reasonCount: candidate.scope.reasonCount,
      omittedReasonCount: candidate.scope.omittedReasonCount,
    },
    // ★ 값이 없으면 **키도 없다** — 없는 종료 사유를 `run_orchestration_failed` 로 지어내면
    //   투영은 그것을 등재된 코드로 보고 그대로 싣는다(모르는 것을 아는 것처럼 말하는 손실이다).
    ...(candidate.stopReason === undefined || candidate.stopReason === null ? {} : bodyReason(candidate.stopReason)),
    usage: candidate.usage,
  };
}

/** 판정 한 줄. `summary` 는 계약의 삭제 목록이라 **적지 않는다**(WS0 §3.2) — 늘 `null` 인 키다. */
function contentVerdict(candidate) {
  if (candidate?.verdict === null || candidate?.verdict === undefined) return null;
  return {
    candidateId: candidate.candidateId,
    attemptId: candidate.patch?.sourceAttemptId ?? candidate.attempts.at(-1)?.attemptId ?? '',
    verdict: candidate.verdict.verdict,
  };
}

export function contentEvidenceRef(record, path, { attemptId, expectedPath }) {
  const evidenceId = ownDataValue(record, 'evidenceId');
  const recordAttemptId = ownDataValue(record, 'attemptId');
  const kind = ownDataValue(record, 'kind');
  const repetition = ownDataValue(record, 'repetition');
  const classified = ownDataValue(record, 'classified');
  const outcome = ownDataValue(classified.value, 'outcome');
  const witnesses = ownDataValue(classified.value, 'witnessIds');
  const witnessIds = witnesses.ok === true ? exactDenseArray(witnesses.value) : null;
  const suffix = kind.value === 'b0' ? 'B0' : kind.value === 'br' ? 'BR' : kind.value === 'c' ? 'C' : null;
  if (path !== expectedPath || !isAbsolute(path) || evidenceId.ok !== true || recordAttemptId.ok !== true ||
      kind.ok !== true || repetition.ok !== true || classified.ok !== true || outcome.ok !== true ||
      recordAttemptId.value !== attemptId || suffix === null || ![1, 2].includes(repetition.value) ||
      evidenceId.value !== `${attemptId}/${suffix}/${repetition.value}` ||
      !['pass', 'fail', 'unknown'].includes(outcome.value) || witnessIds === null ||
      witnessIds.some((witness) => !/^[0-9a-f]{64}$/.test(witness))) return null;
  return deepFreeze({
    evidenceId: evidenceId.value,
    kind: kind.value,
    repetition: repetition.value,
    outcome: outcome.value,
    witnessCount: witnessIds.length,
    path,
  });
}

function fixedFloorInput({ runId, reasonCode, candidateCount, selection, pathBudget, candidates, issues, omittedCounts }) {
  return {
    runId,
    ...bodyReason(reasonCode),
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

/**
 * Canonical artifact ref order: manifest, then each lane's candidate patch in
 * lane order, then the winner alias.  Fixing the order keeps two deterministic
 * Runs journalling byte-identical rows.
 */
export function learningArtifactRefs({ manifestRef, candidates, winnerRef }) {
  const refs = [];
  if (manifestRef) refs.push(manifestRef);
  for (const candidate of candidates) {
    if (candidate.patch?.ref) refs.push(candidate.patch.ref);
  }
  if (winnerRef) refs.push(winnerRef);
  return refs;
}

/** Logical attempt IDs in lane order, then ordinal order. Never attempt bodies. */
export const learningAttemptRefs = (candidates) =>
  candidates.flatMap((candidate) => candidate.attempts.map((attempt) => attempt.attemptId));

/**
 * 실행을 막은 후보들 → 봉투가 실을 `blockers`.
 *
 * ★★ 예전 모양은 `[{where: stopReason, error: stopReason}]` 이었다. 두 필드가 **같은 값**이고
 *   그 값은 레인의 흐름 제어 토큰이라, 읽는 쪽은 `error` 자리에서 문장을 기대하고 식별자를
 *   받았다(WS2 §0 결정표 「blockers 의 모양」). 이제 셋을 낸다: 등재된 `reasonCode`, 그 코드의
 *   영어 한 문장(`message`), 다음에 할 한 문장(`recovery`).
 *
 * ★ 문구는 `safeRender` 로 만든다 — **절대 던지지 않는다.** 인자가 빠져 문장을 못 만들어도
 *   `reasonCode` 는 정확하므로, 본문을 만들다 실패해서 실행 전체가 사라지는 일이 없다.
 *   등재되지 않은 코드는 실을 것이 없다는 뜻이라 **행 자체가 빠진다**(지어내지 않는다).
 *
 * @param {Array<{candidateId?: string|null, reasonCode: string, params?: object}>} list
 * @returns {Array<{candidateId?: string, reasonCode: string, message: string, recovery?: string}>}
 */
export function projectBlockers(list) {
  return (Array.isArray(list) ? list : []).flatMap((entry) => {
    const rendered = safeRender(entry?.reasonCode, entry?.params ?? {});
    if (rendered === null) return [];
    const candidateId = entry?.candidateId;
    return [{
      ...(typeof candidateId === 'string' && candidateId !== '' ? { candidateId } : {}),
      reasonCode: rendered.reasonCode,
      message: rendered.error,
      ...(typeof rendered.recovery === 'string' && rendered.recovery !== '' ? { recovery: rendered.recovery } : {}),
    }];
  });
}

/**
 * 후보의 스코프 사유 `{path, rule, detail}` 목록. 고른 후보가 있으면 그 후보의 것이고, 없으면
 * 모든 후보의 것을 레인 순서로 잇는다 — `flagged` 와 `omitted` 를 고르는 규칙과 같다.
 */
function scopeReasonsOf(candidates) {
  return candidates.flatMap((candidate) => {
    const reasons = candidate?.scope?.reasons;
    return Array.isArray(reasons) ? reasons : [];
  });
}

/**
 * 봉투가 실을 계획. 플래너가 실제로 낸 텍스트가 있을 때만 객체이고, 없으면 `null` 이다.
 *
 * ★★ `''` 는 내지 않는다. 예전에는 `{provider, content: ''}` 가 **항상** 실렸고, 그 모양은
 *   "플래너가 돌았는데 아무 말도 안 했다" 와 "플래너가 실패해서 과제 원문을 썼다" 를 구별하지
 *   못한다(WS2 §0 결정표 「plan.content」). 실패는 알림이 말하고, 본문은 `null` 로 없음을 말한다.
 * ★ 길이 상한(500)과 `omittedCounts.planChars` 는 여기가 아니라 content-projection 의
 *   `projectPlan` 이 건다(Task 13) — 자르는 자리가 둘이면 두 상한이 생긴다.
 */
function planOf({ provider, content }) {
  return typeof content === 'string' && content !== '' && typeof provider === 'string' && provider !== ''
    ? { provider, content, source: 'model' }
    : null;
}

/**
 * c2 실행 하나가 끝난 **세부 코드**(본문의 `reasonCode`, 봉투의 `reasonCode`). 조악
 * `stopReason` 은 여기서 고르지 않는다 — `bodyReason`/`successCodeOf` 가 레지스트리에서 얻는다.
 * 여기에 모은 이유는 하나다: 여섯 코드의 **우선순위**가 규칙이고, 그 규칙이 삼항 연쇄 한 줄로
 * 호출부에 흩어져 있으면 순서를 바꿔도 아무것도 붉어지지 않는다.
 *
 * ★ WS2 Task 15 가 여섯 리터럴을 `REASON.x` 로 옮겼다(레인 어휘의 이전과 **같은 커밋**이다 —
 *   따로 하면 attempt 기록과 봉투가 다른 철자를 말한다). 그 태스크의 수정 라운드가 이름을
 *   `selectionStopToken` 에서 고쳤다: 내는 값은 조악 토큰이 아니라 세부 코드다.
 */
export function selectionReasonCode({
  aliasFailure, terminalDeadline, haltReasonCode = REASON.run_deadline_exceeded,
  selectedCandidate, selection, judgeFailure, allRejected, allBlocked,
}) {
  if (aliasFailure) return REASON.artifact_winner_alias_failed;
  // ★ 멈춘 실행의 코드는 **어느 신호가 발화했는가**에서 온다(WS3 §0-C1) — 호스트가 끊었으면
  //   `run_cancelled`. 이 함수는 그 판정을 하지 않고 엔진이 이미 정한 값을 받는다: 여기서
  //   `hostSignal` 을 읽으면 순수 조립이던 이 모듈이 실행 상태를 보게 된다.
  if (terminalDeadline) return haltReasonCode;
  if (selectedCandidate?.stopReason !== undefined && selectedCandidate?.stopReason !== null) return selectedCandidate.stopReason;
  if (selection.outcome === 'tie') return REASON.judge_tie;
  if (judgeFailure !== null && judgeFailure !== undefined) return judgeFailure;
  if (allRejected) return REASON.run_all_candidates_rejected;
  return allBlocked ? REASON.run_all_candidates_blocked : REASON.run_selection_unavailable;
}

/**
 * 본문 하나. **순수한 조립**이다 — 상태를 읽지도 쓰지도 않는다.
 *
 * ★★ 머리말이 한때 「절대 던지지 않는다」고 적었는데 그것은 **거짓이었다**: 모양이 어긋난 후보
 *   하나(예: `candidate.scope` 가 없는 객체)를 넣으면 여기서 던진다. 참인 것은 더 좁다 — 이 함수는
 *   **엔진이 직접 조립한 입력만 받는다**고 가정한다(호출자는 `orchestrateFinalC1/C2` 둘뿐이고,
 *   그 둘은 후보를 `candidate-lane` 에서 받는다). 리턴을 약속으로 적어 두면 그 약속을 믿고
 *   `try` 를 빼는 사람이 생긴다 — 그래서 가정을 가정으로 적는다. 외부 입력을 직접 받는 자리는
 *   `projectBlockers` 뿐이고, 그것만이 진짜로 던지지 않는다(그 함수 머리말).
 *
 * ★ `reasonCode` 는 **세부 코드**를 받는다(레인/선택의 어휘). 본문의 조악 `stopReason` 은
 *   인자가 아니라 `bodyReason` 이 레지스트리에서 얻는다 — 생산자가 조악값을 고르는 자리를
 *   남겨 두면 한 코드가 두 조악값으로 나간다(WS2 전역 제약).
 *
 * @param {object} input C1/C2 가 이미 계산해 둔 값들. 다른 것은 여기서 파생한다.
 * @returns 봉투 본문(= `renderContentParts` 가 받는 요약 객체).
 */
export function buildRunBody(input) {
  const {
    runId, reasonCode, candidateCount, candidates, selectedCandidate, selection,
    winnerRef = null, manifestRef = null, pathBudget,
    worktrees, cleanup, laneFacts, baseline,
    taskClass, decisions, sources, learning, plan,
    blockers, stepCount, proofStatus, selectedCandidateId,
    usage, elapsedMs, testRuns, preflight,
  } = input;
  const scopeSource = selectedCandidate === null ? candidates : [selectedCandidate];
  // 허용목록 집계가 보는 후보들 — 플래그가 선 것만이다(아래 `allowlisted` 의 ★★).
  const flaggedScopes = scopeSource.filter((candidate) => candidate.scope.flagged === true);
  const issues = candidates.map(contentIssue);
  const attempts = laneFacts.flatMap((facts) => facts.attempts);
  const allEvidenceRefs = laneFacts.flatMap((facts) => facts.evidenceRefs);
  const invalidEvidenceCount = laneFacts.reduce((sum, facts) => sum + facts.evidenceOmittedCount, 0);
  // 고른 후보가 있으면 그 후보의 증거만 싣는다 — 진 후보의 증거는 이 실행의 결론을 설명하지 않는다.
  const evidenceRefs = selectedCandidate === null
    ? allEvidenceRefs
    : allEvidenceRefs.filter((entry) => entry.evidenceId.includes(`/${selectedCandidate.candidateId}/`));
  const omittedEvidenceCount = allEvidenceRefs.length - evidenceRefs.length + invalidEvidenceCount;
  const omittedCounts = {
    issues: issues.reduce((sum, issue) => sum + issue.resolvedOmittedCount, 0),
    attempts: 0,
    evidence: omittedEvidenceCount,
    files: 0,
    artifacts: 0,
  };
  return {
    runId,
    ...bodyReason(reasonCode),
    stepCount,
    // ★★ 계약이 이 행을 `stepCount` 와 `patch` **사이**에 예약했다(`contract/envelope.json` 의
    //   runBody 표 순서). 조립된 값을 그대로 싣고 여기서 다시 계산하지 않는다 — `preflight` 의
    //   ★★ 와 같은 이유다: 두 답이 생기면 그중 하나는 이 행의 질문("어디서 출발했나")에
    //   대답하지 못하는 시점의 답이다.
    baseline,
    ...(winnerRef ? { patch: {
      path: winnerRef.path,
      bytes: winnerRef.bytes,
      empty: winnerRef.bytes === 0,
      files: selectedCandidate?.patch?.files ?? [],
      ignoredPaths: [],
      gitlinks: [],
    } } : {}),
    scope: {
      flagged: scopeSource.some((candidate) => candidate.scope.flagged === true),
      // ★ 등급은 후보들을 **or 로** 접는다(WS5 T1). 하나라도 하드면 이 실행에는 사람이 허용목록
      //   으로 지울 수 없는 것이 들어 있다 — `flagged` 를 접는 규칙과 같다. 목록에서 다시 세지
      //   않는 이유는 `reasonCount` 의 ★★ 와 같다: 사유가 reason code 인 가지는 목록이 비어 있다.
      hardViolation: scopeSource.some((candidate) => candidate.scope.hardViolation === true),
      // ★★ 허용목록은 `hardViolation` 과 **다르게** 접는다(WS5 T2, T4 가 D12 로 축을 옮겼다).
      //   질문이 「하나라도 하드인가」가 아니라 「이 실행에서 플래그된 사유가 **전부** 승인됐나」라서
      //   and 이고, 플래그가 서지 **않은** 후보는 투표하지 않는다 — 깨끗한 레인 하나가 `false` 로
      //   투표하면 다른 레인의 승인이 그 레인의 무관함 때문에 사라지고, 컷이 레인 수에 따라 다르게 군다.
      //   플래그가 아무 데도 없으면 거짓이다: 「지울 것이 없다」와 「전부 지웠다」는 다른 사실이다.
      allowlisted: flaggedScopes.length > 0 && flaggedScopes.every((candidate) => candidate.scope.allowlisted === true),
      reasons: scopeReasonsOf(scopeSource),
      // ★★ 개수는 목록에서 다시 세지 않고 **레인이 말한 것**을 나른다. 사유가 reason code 인
      //   가지(테스트-델타 정책 위반)는 `{path, rule, detail}` 객체를 만들 수 없어 목록이 비고,
      //   목록에서 세면 그 실행은 "걸린 것이 없다"(0)고 말하게 된다 — 실제로 그랬다.
      reasonCount: scopeSource.reduce((sum, candidate) => sum + (candidate.scope.reasonCount ?? 0), 0),
      omitted: scopeSource.reduce((sum, candidate) => sum + (candidate.scope.omittedReasonCount ?? 0), 0),
    },
    worktree: {
      transplanted: worktrees.some((worktree) => worktree.transplanted === true),
      ignoredPaths: [...new Set(worktrees.flatMap((worktree) => worktree.ignoredPaths ?? []))],
      sharedRules: [...new Set(worktrees.flatMap((worktree) => worktree.sharedRules ?? []))],
      // ★ 레인 여러 개를 하나로 접는 규칙은 호출부가 가진다. C1 의 `unregistered` 는 `null`을
      // 낼 수 있고("모른다"), 여기서 `every` 로 접으면 그 삼항이 `false`("안 했다")로
      // 뭉개진다 — 모르는 것을 안다고 말하는 손실은 줄 수 줄이는 것과 바꿀 수 없다.
      cleanup,
    },
    blockers: projectBlockers(blockers),
    learning: { taskClass, decisions, sources, applied: { grade: learning.grade, axes: learning.appliedAxes } },
    plan: planOf(plan),
    steps: selectedCandidate?.attempts.map((attempt) => ({
      step: attempt.ordinal, laneId: attempt.laneId, attemptId: attempt.attemptId, retryOf: attempt.retryOf,
    })) ?? [],
    verdict: contentVerdict(selectedCandidate),
    issues,
    candidates: candidates.map(contentCandidate),
    attempts,
    // ★★ 유예된 증명은 **다음 걸음을 이름으로** 말한다. 실행 9(2026-08-28) 뒤 여섯 칸은
    //   `orch_prove` 가 지므로, 본문만 읽는 쪽이 「무엇이 남았는가」를 사유 코드 없이 알아야
    //   한다. 키는 언제나 있고 값만 갈린다 — 있다가 없으면 호출부가 키 존재로 분기한다.
    regressionProof: {
      status: proofStatus,
      next: proofStatus === 'deferred' ? 'orch_prove' : null,
      selectedCandidateId,
      evidenceRefs,
      omittedEvidenceCount,
    },
    selection,
    artifacts: {
      manifestPath: manifestRef?.path ?? pathBudget.paths.manifestPath,
      expiresAt: manifestRef?.expiresAt
        ?? candidates.find((candidate) => candidate.patch !== null)?.patch.ref.expiresAt ?? winnerRef?.expiresAt ?? 0,
      candidatePaths: candidates.flatMap((candidate) => candidate.patch === null ? [] : [candidate.patch.ref.path]),
      omittedCount: 0,
    },
    cost: costRow({ usage, elapsedMs, testRuns }),
    // ★★ 크레딧 **전에** 내려진 판정을 그대로 싣는다 — 여기서 다시 계산하지 않는다(스펙 §0-D7).
    //   다시 계산하면 두 답이 생기고, 그중 하나는 워크트리도 벤더도 지난 뒤의 답이라 「실행 전에
    //   무엇을 알았나」라는 이 행의 질문에 대답하지 못한다. 모양을 계약의 셋으로 줄이는 일은
    //   투영(`projectPreflight`)이 한다 — 자르는 자리가 둘이면 두 모양이 생긴다.
    preflight,
    omittedCounts,
    aliasDurable: typeof winnerRef?.path === 'string',
    fixedFloorInput: fixedFloorInput({
      runId, reasonCode, candidateCount, selection, pathBudget, candidates, issues, omittedCounts,
    }),
  };
}

/**
 * 성공 봉투. **발췌가 실리지 않는다** — 발췌는 실패의 증거다(`src/envelope.mjs` 의 규칙).
 * 그 규칙을 두 곳에 적으면 한 곳만 고쳐지고, 성공 봉투가 남의 stderr 를 나른다.
 */
export function runSuccess({ content, contentFallback, runId, stopReason, verified, extras }) {
  const { excerpts: _dropped, ...successExtras } = extras;
  return success({
    content, contentFallback, confidence: confidenceOfRun({ verified }), runId,
    ...successCodeOf(stopReason), ...successExtras,
  });
}

/** 실패 봉투. 발췌는 **그 코드의 증거일 때만** 실린다(`excerptsFor`). */
export function runFailure({ status, confidence, content, contentFallback, runId, reasonCode, params, extras }) {
  return failure({
    status, confidence, content, contentFallback, runId, reasonCode,
    ...(params === undefined ? {} : { params }),
    ...excerptsFor(reasonCode, extras),
  });
}

/**
 * 레인 하나가 본문에 남기는 사실 — 시도 목록·증거 ref·뻔 증거 개수. 레인의 비공개 장부
 * (`privateFacts`)를 읽는 자리는 여기 하나다 — 그 장부는 레인이 끝나면 비워진다.
 */
export function laneContentFacts(candidate, privateFacts) {
  return deepFreeze({
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
}

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
export async function commitRunLearning(input) {
  const {
    deps, stage, stateRoot, runId, taskClass, decisions, candidateCount,
    stopReason, selection, candidates, effectiveChoices, attemptRefs, artifactRefs,
    terminal, onJournaled,
  } = input;
  // The reducer consumes only whitelisted terminal-summary fields, while the journal stores a *bounded* selection.
  // A full `Selection` carries judge rationale, and provider prose must never
  // reach durable learning state.
  const learningInput = deepFreeze({
    policyVersion: 2,
    taskClass,
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
  const stored = await stage('learning transaction', () =>
    (deps.commitLearningMutation ?? defaultCommitLearningMutation)(stateRoot, {
      updates,
      journal: {
        runId,
        // ★ WS3 §0-D1 의 종료 기록 여섯이 **이 행에** 탄다. 실행마다 행은 하나여야 하고
        //   (`readRuns` 는 runId 당 마지막 줄만 남긴다), 이 실행은 이미 자기 행을 여기서 쓴다 —
        //   엔진의 종료 sink 가 뒤에 한 줄 더 얹으면 그 줄이 이 학습 키들을 덮어 버린다.
        ...terminal,
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
  // ★★ 「이 실행은 이미 저널 행을 가졌다」와 「등급이 반영됐다」는 **다른 사실**이고, 그 둘이
  //   갈리는 자리가 정확히 `pending: true` 다(최종 리뷰 I6). 예전 주석은 "실패한 트랜잭션은
  //   알리지 않는다 — 그 실행에는 행이 없고" 라고 적었는데 그 전제가 `pending` 에서 거짓이다:
  //   그 값은 **WAL 이 이미 디스크에 있다**는 뜻이고(`commitLearningMutationUnlocked` 가 그
  //   구별을 만들려고 붙인다), WAL 안에는 이 실행의 저널 행이 들어 있다. 다음 잠금 획득자가
  //   그것을 재생하므로 행은 반드시 생긴다 — `appendRun` 자신이 잠금 안에서 먼저 복구를 돌리니
  //   sink 가 얹으면 **자기가 방금 되살린 행 위에** 얹는 셈이다.
  // ★★ 저널은 runId 당 마지막 줄이 이기므로 그 한 줄이 학습 키 전부(taskClass·appliedGrade·
  //   appliedChoices·rewardableChoices·decisions·policyVersion)를 지운다. 사후분포에는 이 실행의
  //   관측이 이미 반영돼 있는데 그것을 되돌릴 권위 — 동결된 choice map — 만 사라지는 것이라,
  //   `orch_reward` 는 그 실행에 대해 영원히 `learning_run_task_class_missing` 을 낸다. 그래서
  //   sink 는 **덮지 않는다**: 행이 있거나 곧 생길 모든 경우에 알린다.
  // ★ 준비 단계 실패(`pending: false`)만 sink 가 받는다 — 그때는 WAL 도 행도 없다.
  const journaled = durable || stored?.pending === true;
  //   `applied` 로는 대신할 수 없다: 갱신할 축이 하나도 없는 실행(`attempted === false`)도 행은
  //   받는다.
  if (journaled) {
    try { onJournaled?.(); } catch { /* observation only */ }
  }
  // 실행 시작 뒤 다른 호스트가 공유 학습 파일을 더 새 스키마로 올릴 수 있다. 쓰기 계층은
  // 바이트를 보존하며 거절하지만 여기서 일반적인 "record incomplete"로 접으면 정상적인
  // 두 호스트 버전 스큐를 숨긴다. 시작 시 읽기와 같은 표준 notice를 우선한다.
  const schemaNotice = stateSchemaNotice(stored?.stateSchema);
  return deepFreeze({
    outcome,
    applied: attempted && durable,
    appliedAxes: attempted && durable ? appliedAxes : [],
    grade: attempted && durable ? outcome.grade : null,
    notices: durable ? [] : [schemaNotice ?? renderNotice('learning_record_incomplete', {})],
  });
}
