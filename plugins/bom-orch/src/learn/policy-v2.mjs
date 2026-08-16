import { AXES, POLICY_V2_AXES } from './bandit.mjs';

/**
 * Learning policy v2 — one grade and at most one arm per axis for one Run.
 *
 * This module is pure.  It reads no file, clock, random source, posterior, or
 * provider prose; the engine hands it frozen terminal facts and it returns
 * frozen facts.  That is deliberate: the same reduction has to be replayable
 * from a journal row long after the worktrees are gone, so anything it cannot
 * see in its input must not influence a grade.
 *
 * ★ Why the engine, not this module, authors `effectiveChoices`.  Whether an
 *   axis was a *real* choice depends on facts that never reach a terminal
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
 * A deadline or a failed winner alias means the Run did not deliver what its
 * selection claims, so the sample is not honest evidence about the arms.  These
 * two strings are the engine's, and the engine is the only writer of
 * `stopReason`; the success rule below independently requires the stop reason
 * to be the selected candidate's own, so this set only has to catch the
 * all-rejected shape that no selected candidate would mask.
 */
const NEUTRALIZING_STOP_REASONS = new Set(['deadline_exceeded', 'winner_alias_failed']);

/** Read an own data property without letting a throwing getter escape. */
function own(value, key) {
  try {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    return value[key];
  } catch {
    return undefined;
  }
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
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
    const stopReason = own(raw, 'stopReason');
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
  if (candidate.stopReason === 'policy_failure') return candidate.flagged === true;
  if (candidate.stopReason !== 'machine_failed') return false;
  const tests = candidate.tests;
  return tests.execution === 'completed' && tests.outcome === 'fail' &&
    tests.stability === 'stable' && tests.trusted === true && tests.complete === true;
}

function deriveGrade({ stopReason, selected, candidates }) {
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
  const stopReason = own(input, 'stopReason');
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

  const grade = deriveGrade({ stopReason, selected, candidates });
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
 * @param input `{ policyVersion: 2, candidateCount, stopReason, selection,
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
