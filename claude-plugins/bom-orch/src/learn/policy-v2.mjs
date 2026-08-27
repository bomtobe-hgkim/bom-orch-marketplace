import { AXES, POLICY_V2_AXES } from './bandit.mjs';
import { REASON, normalizeLegacyReasonCode } from '../reason-codes.mjs';
import { ownDataValue } from '../util/objects.mjs';
import { deepFreeze } from '../util/freeze.mjs';

/**
 * Learning policy v2 — one grade and at most one arm per axis for one Run.
 *
 * This module is pure.  It reads no file, clock, random source, posterior, or
 * provider prose; the engine hands it frozen terminal facts and it returns
 * frozen facts.  That is deliberate: the same reduction has to be replayable
 * from a journal row long after the worktrees are gone, so anything it cannot
 * see in its input must not influence a grade.
 *
 * ★ Why `effective-choices.mjs`, not this module, authors `effectiveChoices`.
 *   Whether an axis was a *real* choice depends on facts that never reach a terminal
 *   candidate summary — a caller's role pin, the registry order the placement
 *   arm mapped onto, whether `allow_single` made `single` a candidate arm at
 *   all, and whether enough providers existed for the arm to mean anything.
 *   Reconstructing those from the summaries would be guessing.  So the engine
 *   states them (`identifiable`) and this module only ever *narrows* that claim
 *   with facts it can see for itself.  An engine `identifiable: true` that the
 *   run facts contradict is refused here, never trusted.
 *
 * ★ Why `appliedChoices` and `rewardableChoices` are two maps.  They answer
 *   different questions and the difference is exactly the abstaining Run:
 *     · applied    = what this Run's automatic grade actually put in the
 *                    posterior.  Empty when the grade is `null`.
 *     · rewardable = where a later `orch_reward` may put a human grade.
 *   Collapsing them loses the case the whole manual-correction path exists for
 *   — a Run the automatic table refused to grade (tie, unverified, deadline)
 *   still has identifiable arms a person can judge.  What stays out of *both*
 *   maps is what was never a choice: `rewrite`, c2 `placement`, an unexecuted
 *   arm, a pinned role.  Design §14.2 refuses to revive those with a boolean.
 *
 * ★ Never throws.  The engine calls this after the Run's real work is done and
 *   treats learning as an additive notice, never a blocker.  Any malformed,
 *   hostile, or non-v2 input therefore returns the neutral outcome — grade
 *   `null` and two empty maps — instead of an exception.  Failing closed here
 *   costs one learning sample; throwing would cost the caller their result.
 */

/**
 * The axes policy v2 may select, journal, or reward.
 *
 * Re-exported from `bandit.mjs`, which owns the axis vocabulary, so a consumer
 * of the policy can get the whole contract from one module without the list
 * existing in two places.  `rewrite` is absent on purpose (design §14.2): its
 * posterior stays readable for policy-v1 history and manual undo — `AXES`
 * itself is untouched — but no v2 Run creates, applies, or corrects a rewrite
 * choice.
 */
export { POLICY_V2_AXES };

const LANE_IDS = new Set(['lane-a', 'lane-b']);
const SELECTION_OUTCOMES = new Set(['winner', 'single_survivor', 'equivalent', 'tie', 'none']);
/** Outcomes that name a selected candidate; the rest must name none. */
const SELECTING_OUTCOMES = new Set(['winner', 'single_survivor', 'equivalent']);
const TERMINAL_CLASSES = new Set(['verified', 'usable_unverified', 'rejected', 'blocked']);

/**
 * Run-level stops that outrank a lane's own terminal reason.
 *
 * A deadline, a host cancellation or a failed winner alias means the Run did not
 * deliver what its selection claims, so the sample is not honest evidence about
 * the arms.  These three strings are the engine's, and the engine is the only
 * writer of `stopReason`; the success rule below independently requires the stop
 * reason to be the selected candidate's own, so this set only has to catch the
 * all-rejected shape that no selected candidate would mask.
 *
 * ★ `run_cancelled` joined in WS3 with its producer.  A cancelled Run says
 *   nothing about the arm that was running when the host pressed stop — grading
 *   it would punish whichever vendor happened to hold the writer call, which is
 *   an artefact of the user's timing and not of the vendor's work.
 */
const NEUTRALIZING_STOP_REASONS = new Set([
  REASON.run_deadline_exceeded, REASON.artifact_winner_alias_failed, REASON.run_cancelled,
]);

/**
 * Read an own data property without letting a throwing getter escape.
 *
 * ★ 공유 `ownDataValue` 로 옮기면서 **accessor 를 더는 호출하지 않는다**. 이전 사본은
 *   `value[key]` 로 읽어 getter 를 실행했다 — 학습은 조언만 하지만(invariant 6) 그 읽기
 *   하나가 적대적 객체에 코드 실행을 내주고 있었다. 비열거 own 속성도 이제 안 보인다.
 */
function own(value, key) {
  return ownDataValue(value, key).value;
}

/**
 * A `stopReason` read from a journal row, in this module's vocabulary.
 *
 * ★★ This reduction is replayed from rows written long before the codes were
 *   renamed (`orch_reward` re-grades them by hand).  Those rows still say
 *   `verified`, `machine_failed`, `policy_failure`.  Comparing them to
 *   `REASON.x` by spelling alone silently folds every one of them to
 *   `grade: null` — the sample is not refused, it is *lost*, and nothing says
 *   so.  So the alias table runs first; a spelling it does not know is kept as
 *   it is, because inventing a code here would grade a row we cannot read.
 *   This is a reasonCode-position value, which is the only position that table
 *   may be applied to (WS2 §2.4).
 */
function stopReasonCode(value) {
  if (typeof value !== 'string') return value;
  // ★ `deadline_exceeded` only is kept off the alias table: that spelling is a
  //   coarse `stopReason`, not a fine code, and the table lifts it to the
  //   judge-only `judge_deadline`.  Relabelling a run-level deadline as a judge
  //   failure would take it out of NEUTRALIZING_STOP_REASONS and grade a Run
  //   that never finished.  `src/run-faults.mjs laneStopCode` carries the same
  //   exception for the same reason; the two must agree or a replayed row and a
  //   live Run grade differently.
  if (value === 'deadline_exceeded') return REASON.run_deadline_exceeded;
  return normalizeLegacyReasonCode(value) ?? value;
}

const neutral = () => deepFreeze({ grade: null, appliedChoices: {}, rewardableChoices: {} });

function normalizeSelection(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = own(value, 'outcome');
  const selectedCandidateId = own(value, 'selectedCandidateId');
  if (typeof outcome !== 'string' || !SELECTION_OUTCOMES.has(outcome)) return null;
  if (selectedCandidateId !== null && !LANE_IDS.has(selectedCandidateId)) return null;
  // A selecting outcome must name a lane and a non-selecting one must not.
  if (SELECTING_OUTCOMES.has(outcome) === (selectedCandidateId === null)) return null;
  return { outcome, selectedCandidateId };
}

function normalizeTests(value) {
  return {
    execution: own(value, 'execution'),
    outcome: own(value, 'outcome'),
    stability: own(value, 'stability'),
    trusted: own(value, 'trusted') === true,
    complete: own(value, 'complete') === true,
  };
}

/**
 * The one abstract tier a lane actually ran on, or `null` when it did not run
 * on exactly one.  Both roles must agree: a lane whose writer and verifier used
 * different tiers is not evidence about "this tier".
 */
function laneTier(binding) {
  const writer = own(own(binding, 'writer'), 'tier');
  const verifier = own(own(binding, 'verifier'), 'tier');
  if (writer !== verifier) return null;
  return AXES.tier.arms.includes(writer) ? writer : null;
}

function normalizeCandidates(value, candidateCount) {
  if (!Array.isArray(value) || value.length !== candidateCount) return null;
  const seen = new Set();
  const normalized = [];
  for (const raw of value) {
    const candidateId = own(raw, 'candidateId');
    const terminalClass = own(raw, 'terminalClass');
    const stopReason = stopReasonCode(own(raw, 'stopReason'));
    if (!LANE_IDS.has(candidateId) || seen.has(candidateId)) return null;
    if (!TERMINAL_CLASSES.has(terminalClass)) return null;
    if (typeof stopReason !== 'string' || stopReason === '') return null;
    seen.add(candidateId);
    normalized.push({
      candidateId,
      terminalClass,
      stopReason,
      crossVerificationCompleted: own(raw, 'crossVerificationCompleted') === true,
      flagged: own(own(raw, 'scope'), 'flagged') === true,
      tests: normalizeTests(own(raw, 'tests')),
      tier: laneTier(own(raw, 'binding')),
    });
  }
  return normalized;
}

/**
 * Whether a rejection carries authority a machine can stand behind.
 *
 * Two shapes qualify and nothing else does (design §14.1):
 *   · a stable, trusted, completed test run that actually failed;
 *   · a coordinator policy rejection whose scope is flagged.
 * A verifier's prose FAIL, a stagnation, an issue-limit stop, a tamper stop, an
 * unproven proof, and every `blocked` lane stay neutral — we did not learn that
 * the arms were bad, only that we could not finish judging them.
 */
function trustedRejection(candidate) {
  if (candidate.terminalClass !== 'rejected') return false;
  if (candidate.stopReason === REASON.scope_policy_failure) return candidate.flagged === true;
  if (candidate.stopReason !== REASON.test_machine_failed) return false;
  const tests = candidate.tests;
  return tests.execution === 'completed' && tests.outcome === 'fail' &&
    tests.stability === 'stable' && tests.trusted === true && tests.complete === true;
}
function deriveGrade({ taskClass, stopReason, selected, candidates }) {
  // 기계 증거가 없는 클래스는 자동 성공으로 학습하지 않고, 식별된 팔만 사람 보상용으로 남긴다.
  if (taskClass === 'code:no-tests') return null;
  if (NEUTRALIZING_STOP_REASONS.has(stopReason)) return null;
  if (selected !== null) {
    // Success is the selected candidate's own terminal claim, not the Run's
    // hopes for it: the Run must have stopped for the same reason the candidate
    // did, so a later override cannot be read as an endorsement.
    return selected.terminalClass === 'verified' && stopReason === selected.stopReason ? 'success' : null;
  }
  return candidates.every(trustedRejection) ? 'failure' : null;
}

/**
 * Narrow the engine's `identifiable` claim with facts visible in the summaries.
 *
 * · placement — c1 only.  c2 mirrors both arms across two lanes, so neither arm
 *   is the one that produced the result (design §14.2).
 * · mix — c1 takes the engine's word (only it knows whether `allow_single`
 *   exposed a real choice).  c2 ran cross-verification by construction, so its
 *   actual arm is always `mix`; a sampled-but-ignored `single` is refused here
 *   rather than rewarded.  A lane that never completed cross-verification, and
 *   `single_survivor`, break the claim that the mix is what was measured.
 * · tier — every evaluated lane must have actually run on the same non-null
 *   abstract tier, and that tier must be the recorded arm.
 */
function axisIdentifiable(axis, arm, { candidateCount, selection, candidates }) {
  if (axis === 'placement') return candidateCount === 1;
  if (axis === 'mix') {
    if (candidateCount === 1) return true;
    return arm === 'mix' && selection.outcome !== 'single_survivor' &&
      candidates.every((candidate) => candidate.crossVerificationCompleted === true);
  }
  return candidates.every((candidate) => candidate.tier !== null && candidate.tier === arm);
}

function identifiableChoices(choices, facts) {
  // Iterating `POLICY_V2_AXES` rather than the input's own keys does two jobs:
  // it drops `rewrite` and any unknown axis, and it fixes the key order so two
  // deterministic Runs journal byte-identical maps.
  const result = {};
  for (const axis of POLICY_V2_AXES) {
    const choice = own(choices, axis);
    if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) continue;
    if (own(choice, 'identifiable') !== true) continue;
    const arm = own(choice, 'arm');
    if (typeof arm !== 'string' || !AXES[axis].arms.includes(arm)) continue;
    if (!axisIdentifiable(axis, arm, facts)) continue;
    result[axis] = arm;
  }
  return result;
}

function reduce(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return neutral();
  if (own(input, 'policyVersion') !== 2) return neutral();
  const candidateCount = own(input, 'candidateCount');
  if (candidateCount !== 1 && candidateCount !== 2) return neutral();
  const stopReason = stopReasonCode(own(input, 'stopReason'));
  if (typeof stopReason !== 'string' || stopReason === '') return neutral();
  const selection = normalizeSelection(own(input, 'selection'));
  if (selection === null) return neutral();
  const candidates = normalizeCandidates(own(input, 'candidates'), candidateCount);
  if (candidates === null) return neutral();
  const choices = own(input, 'effectiveChoices');
  if (choices === null || typeof choices !== 'object' || Array.isArray(choices)) return neutral();
  const selected = selection.selectedCandidateId === null
    ? null
    : candidates.find((candidate) => candidate.candidateId === selection.selectedCandidateId) ?? null;
  // A selection that names a lane this Run never produced is not a fact about
  // any arm; refuse the whole reduction rather than grade half of it.
  if (selection.selectedCandidateId !== null && selected === null) return neutral();

  const grade = deriveGrade({ taskClass: own(input, 'taskClass'), stopReason, selected, candidates });
  const rewardableChoices = identifiableChoices(choices, { candidateCount, selection, candidates });
  return deepFreeze({
    grade,
    appliedChoices: grade === null ? {} : { ...rewardableChoices },
    rewardableChoices,
  });
}

/**
 * Reduce one Run's frozen terminal facts to its learning outcome.
 *
 * @param input `{ policyVersion: 2, taskClass, candidateCount, stopReason, selection,
 *   candidates, effectiveChoices }` — `effectiveChoices` is
 *   `axis -> { arm, identifiable, reason }` authored by the engine.
 * @returns deep-frozen `{ grade, appliedChoices, rewardableChoices }` where the
 *   maps are `axis -> arm`.
 */
export function computeRunLearningOutcome(input) {
  try {
    return reduce(input);
  } catch {
    return neutral();
  }
}
