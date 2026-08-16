import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { MAX_CONTENT_CHARS } from './envelope.mjs';

export const ARTIFACT_PATH_JSON_BUDGET = 5_000;

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const LANES = Object.freeze(['lane-a', 'lane-b']);
const SELECTED_OUTCOMES = new Set(['winner', 'single_survivor', 'equivalent']);
const ALL_OUTCOMES = new Set([...SELECTED_OUTCOMES, 'tie', 'none']);
const PROOF_STATUSES = new Set(['proved', 'not_applicable', 'not_proven', 'unavailable', 'flaky']);

function blocked(error, recovery) {
  return deepFreeze({ blocked: true, error, recovery });
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function descriptorObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return null;
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string') || keys.some((key) => !own.includes(key))) {
    return null;
  }
  const out = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
    out[key] = descriptor.value;
  }
  return out;
}

function exactObject(value, keys) {
  try {
    return descriptorObject(value, keys);
  } catch {
    return null;
  }
}

function exactDenseArray(value) {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol') || keys.length !== value.length + 1 || keys.at(-1) !== 'length') return null;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
  }
  return value;
}

function boundedString(value, max = 4_096, allowEmpty = false) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f\uFFFD]/.test(value);
}

function validRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value) && !WINDOWS_DEVICE_PATTERN.test(value);
}

function validAbsoluteRoot(value) {
  if (!boundedString(value, 32_768) || !isAbsolute(value)) return false;
  try {
    return normalize(resolve(value)) === value;
  } catch {
    return false;
  }
}

function normalizedPaths(value, candidateCount) {
  const object = exactObject(value, ['runDir', 'manifestPath', 'candidatePaths', 'winnerAliasPath', 'initLockPath']);
  if (object === null) return null;
  const candidateKeys = candidateCount === 1 ? ['lane-a'] : ['lane-a', 'lane-b'];
  const candidates = exactObject(object.candidatePaths, candidateKeys);
  const strings = [object.runDir, object.manifestPath, object.winnerAliasPath, object.initLockPath, ...candidateKeys.map((key) => candidates?.[key])];
  if (candidates === null || strings.some((path) => !boundedString(path, 32_768) || !isAbsolute(path))) return null;
  return {
    runDir: object.runDir,
    manifestPath: object.manifestPath,
    candidatePaths: Object.fromEntries(candidateKeys.map((key) => [key, candidates[key]])),
    winnerAliasPath: object.winnerAliasPath,
    initLockPath: object.initLockPath,
  };
}

function normalizedOmittedCounts(value) {
  const object = exactObject(value, ['issues', 'attempts', 'evidence', 'files', 'artifacts']);
  if (object === null || Object.values(object).some((number) => !Number.isSafeInteger(number) || number < 0)) return null;
  return {
    issues: object.issues,
    attempts: object.attempts,
    evidence: object.evidence,
    files: object.files,
    artifacts: object.artifacts,
  };
}

function normalizedCandidates(values, candidateCount, paths) {
  const array = exactDenseArray(values);
  if (array === null || array.length !== candidateCount) return null;
  const out = [];
  const seen = new Set();
  for (const value of array) {
    const object = exactObject(value, ['candidateId', 'patchPresent', 'proofStatus']);
    if (object === null || !LANES.includes(object.candidateId) || seen.has(object.candidateId) ||
        typeof object.patchPresent !== 'boolean' || !PROOF_STATUSES.has(object.proofStatus)) return null;
    if (candidateCount === 1 && object.candidateId !== 'lane-a' || paths.candidatePaths[object.candidateId] === undefined) return null;
    seen.add(object.candidateId);
    out.push({ candidateId: object.candidateId, patchPresent: object.patchPresent, proofStatus: object.proofStatus });
  }
  return out.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

function normalizedIssues(values, candidates) {
  const array = exactDenseArray(values);
  if (array === null || array.length !== candidates.length) return null;
  const out = new Map();
  for (const value of array) {
    const object = exactObject(value, ['candidateId', 'openIssueIds', 'openIssueCount']);
    const ids = exactDenseArray(object?.openIssueIds);
    if (object === null || ids === null || !candidates.some((candidate) => candidate.candidateId === object.candidateId) ||
        out.has(object.candidateId) || ids.length > 100 || ids.some((id) => !boundedString(id, 128)) ||
        new Set(ids).size !== ids.length || object.openIssueCount !== ids.length) return null;
    out.set(object.candidateId, { ids: [...ids].sort(), count: object.openIssueCount });
  }
  return out;
}

function normalizedFixedFloorInput(value) {
  const object = exactObject(value, [
    'runId', 'stopReason', 'candidateCount', 'outcome', 'selectedCandidateId', 'paths',
    'candidates', 'issueSummary', 'omittedCounts',
  ]);
  if (object === null || !validRunId(object.runId) || !boundedString(object.stopReason, 128) ||
      ![1, 2].includes(object.candidateCount) || !ALL_OUTCOMES.has(object.outcome) ||
      object.candidateCount === 1 && !['winner', 'none'].includes(object.outcome)) return null;
  const needsSelection = SELECTED_OUTCOMES.has(object.outcome);
  if (needsSelection !== (object.selectedCandidateId !== null) ||
      object.selectedCandidateId !== null && !LANES.includes(object.selectedCandidateId) ||
      object.outcome === 'equivalent' && object.selectedCandidateId !== 'lane-a') return null;
  const paths = normalizedPaths(object.paths, object.candidateCount);
  if (paths === null) return null;
  const candidates = normalizedCandidates(object.candidates, object.candidateCount, paths);
  if (candidates === null || object.selectedCandidateId !== null &&
      !candidates.some((candidate) => candidate.candidateId === object.selectedCandidateId && candidate.patchPresent)) return null;
  const issues = normalizedIssues(object.issueSummary, candidates);
  const omittedCounts = normalizedOmittedCounts(object.omittedCounts);
  if (issues === null || omittedCounts === null || object.selectedCandidateId !== null &&
      (issues.get(object.selectedCandidateId)?.count !== 0 ||
        issues.get(object.selectedCandidateId)?.ids.length !== 0)) return null;
  return {
    runId: object.runId,
    stopReason: object.stopReason,
    candidateCount: object.candidateCount,
    outcome: object.outcome,
    selectedCandidateId: object.selectedCandidateId,
    paths,
    candidates,
    issues,
    omittedCounts,
  };
}

export function buildFixedFloorProjection(input) {
  const normalized = normalizedFixedFloorInput(input);
  if (normalized === null) throw new TypeError('Invalid fixed-floor projection input.');
  const candidatePaths = [];
  const candidates = normalized.candidates.map((candidate) => {
    const path = candidate.patchPresent ? normalized.paths.candidatePaths[candidate.candidateId] : null;
    if (path !== null) candidatePaths.push(path);
    const issues = normalized.issues.get(candidate.candidateId);
    return {
      candidateId: candidate.candidateId,
      patch: path === null ? null : { path },
      proofStatus: candidate.proofStatus,
      openIssueIds: [...issues.ids],
      openIssueCount: issues.count,
    };
  });
  const projection = {
    runId: normalized.runId,
    stopReason: normalized.stopReason,
    selection: { outcome: normalized.outcome, selectedCandidateId: normalized.selectedCandidateId },
    ...(SELECTED_OUTCOMES.has(normalized.outcome) ? { patch: { path: normalized.paths.winnerAliasPath } } : {}),
    candidates,
    artifacts: {
      manifestPath: normalized.paths.manifestPath,
      candidatePaths,
      omittedCount: normalized.omittedCounts.artifacts,
    },
    omittedCounts: { ...normalized.omittedCounts },
  };
  return deepFreeze(projection);
}

function artifactPaths(stateRoot, runId, candidateCount) {
  const runDir = join(stateRoot, 'runs', runId);
  return {
    runDir,
    manifestPath: join(runDir, 'manifest.json'),
    candidatePaths: {
      'lane-a': join(runDir, 'candidates', 'lane-a.patch'),
      ...(candidateCount === 2 ? { 'lane-b': join(runDir, 'candidates', 'lane-b.patch') } : {}),
    },
    winnerAliasPath: join(stateRoot, 'patches', `${runId}.patch`),
    initLockPath: join(stateRoot, 'runs', `.init-lock-${runId}.json`),
  };
}

function budgetProjection(paths, runId, candidateCount, outcome, selectedCandidateId) {
  const lanes = LANES.slice(0, candidateCount);
  return buildFixedFloorProjection({
    runId,
    stopReason: 'x',
    candidateCount,
    outcome,
    selectedCandidateId,
    paths,
    candidates: lanes.map((candidateId) => ({ candidateId, patchPresent: true, proofStatus: 'unavailable' })),
    issueSummary: lanes.map((candidateId) => ({ candidateId, openIssueIds: [], openIssueCount: 0 })),
    omittedCounts: { issues: 0, attempts: 0, evidence: 0, files: 0, artifacts: 0 },
  });
}

export function validateArtifactPathBudget(input) {
  const object = exactObject(input, ['stateRoot', 'runId', 'candidateCount']);
  if (object === null || !validAbsoluteRoot(object.stateRoot) || !validRunId(object.runId) || ![1, 2].includes(object.candidateCount)) {
    return blocked('invalid_artifact_paths', 'Use a canonical absolute BOM_ORCH_HOME and a fresh safe runId.');
  }
  const paths = artifactPaths(object.stateRoot, object.runId, object.candidateCount);
  const cases = object.candidateCount === 1
    ? [['winner', 'lane-a'], ['none', null]]
    : [
        ['winner', 'lane-a'], ['winner', 'lane-b'],
        ['single_survivor', 'lane-a'], ['single_survivor', 'lane-b'],
        ['equivalent', 'lane-a'], ['tie', null], ['none', null],
      ];
  let maximum = 0;
  for (const [outcome, selectedCandidateId] of cases) {
    maximum = Math.max(maximum, JSON.stringify(
      budgetProjection(paths, object.runId, object.candidateCount, outcome, selectedCandidateId),
    ).length);
  }
  if (maximum > ARTIFACT_PATH_JSON_BUDGET) {
    return blocked('artifact_path_budget_exceeded', 'Use a shorter BOM_ORCH_HOME and a fresh runId.');
  }
  return deepFreeze({ ok: true, paths });
}

const CONTENT_FALLBACK = '{"truncatedReport":true}';
const ROLE_KEYS = ['providerId', 'model', 'effort', 'tier', 'role'];
const USAGE_KEYS = ['calls', 'promptTokensKnown', 'evalTokensKnown', 'incomplete'];
const LEARNING_AXES = ['mix', 'placement', 'tier', 'rewrite'];
const TERMINAL_CLASSES = new Set(['verified', 'usable_unverified', 'rejected', 'blocked']);
const ATTEMPT_RESULTS = new Set(['accepted', 'repair', 'rejected', 'blocked', 'stagnated']);
const EVIDENCE_KINDS = new Set(['b0', 'br', 'c']);
const EVIDENCE_OUTCOMES = new Set(['pass', 'fail', 'unknown']);
const JUDGE_CATEGORIES = new Set(['correctness', 'security', 'requirements', 'scope', 'tests']);
const JUDGE_CODES = new Set([
  'invalid_format', 'invalid_json', 'invalid_schema', 'invalid_decision',
  'judge_provider_failure', 'judge_view_unavailable', 'judge_scratch_failed', 'deadline_exceeded',
]);
const TUPLE_TERMINALS = new Set(['verified', 'usable_unverified']);
const TUPLE_TESTS = new Set(['stable_repeated_full_pass', 'stable_one_pass', 'unknown_or_not_run', 'flaky']);
const DECISIVE_FIELDS = new Set(['terminalClass', 'proof', 'tests', 'openIssues', 'scope']);
const TERMINAL_RANK = Object.freeze({ verified: 1, usable_unverified: 0 });
const PROOF_RANK = Object.freeze({ proved: 4, not_applicable: 3, not_proven: 2, unavailable: 1, flaky: 0 });
const TEST_RANK = Object.freeze({ stable_repeated_full_pass: 3, stable_one_pass: 2, unknown_or_not_run: 1, flaky: 0 });
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function data(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function list(value) {
  try {
    return Array.isArray(value) ? [...value] : [];
  } catch {
    return [];
  }
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function integer(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function sortedStrings(value) {
  return list(value).filter((item) => typeof item === 'string').sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function cleanText(value, max, { allowEmpty = false } = {}) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f\uFFFD]/.test(value)
    ? value
    : null;
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function checkedAdd(...values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      throw new TypeError('Unsafe projection count.');
    }
    total += value;
  }
  return total;
}

function absolutePath(value) {
  return cleanText(value, 32_768) !== null && isAbsolute(value) ? value : null;
}

function laneId(value) {
  return LANES.includes(value) ? value : null;
}

function boundedStrings(value, { maximum = 10_000, chars = 32_768 } = {}) {
  const values = list(value);
  if (values.length > maximum || values.some((item) => cleanText(item, chars) === null) ||
      new Set(values).size !== values.length) return null;
  return values.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function boundedFileStrings(value, { maximum = 10_000, chars = 32_768 } = {}) {
  const values = list(value);
  if (values.length > maximum || values.some((item) => typeof item !== 'string' || item.length === 0 ||
      item.length > chars || item.includes('\0') || item.includes('\uFFFD')) || new Set(values).size !== values.length) return null;
  return values.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function projectUsage(value) {
  const projected = Object.fromEntries(USAGE_KEYS.map((key) => [key, data(value, key)]));
  return safeInteger(projected.calls) === null || safeInteger(projected.promptTokensKnown) === null ||
    safeInteger(projected.evalTokensKnown) === null || typeof projected.incomplete !== 'boolean'
    ? null
    : projected;
}

function projectRole(value, expectedRole) {
  const rawModel = data(value, 'model');
  const rawEffort = data(value, 'effort');
  if (!(rawModel === null || cleanText(rawModel, 128) !== null) ||
      !(rawEffort === null || cleanText(rawEffort, 64) !== null)) return null;
  const out = {
    providerId: cleanText(data(value, 'providerId'), 128),
    model: rawModel,
    effort: rawEffort,
    tier: ['fast', 'strong'].includes(data(value, 'tier')) ? data(value, 'tier') : null,
    role: data(value, 'role') === expectedRole ? expectedRole : null,
  };
  return Object.keys(out).length === ROLE_KEYS.length && Object.values(out).every((entry, index) =>
    index === 1 || index === 2 ? entry === null || typeof entry === 'string' : entry !== null) ? out : null;
}

function projectBinding(value) {
  const writer = projectRole(data(value, 'writer'), 'worker');
  const verifier = projectRole(data(value, 'verifier'), 'verifier');
  return writer === null || verifier === null ? null : { writer, verifier };
}

function projectLegacyPatch(value, { fileLimit = null } = {}) {
  const path = absolutePath(data(value, 'path'));
  const bytes = safeInteger(data(value, 'bytes'));
  const allFiles = boundedFileStrings(data(value, 'files'));
  const ignoredPaths = boundedFileStrings(data(value, 'ignoredPaths'));
  const gitlinks = boundedFileStrings(data(value, 'gitlinks'));
  if (path === null || bytes === null || typeof data(value, 'empty') !== 'boolean' ||
      allFiles === null || ignoredPaths === null || gitlinks === null) return null;
  return {
    path,
    bytes,
    empty: data(value, 'empty'),
    files: fileLimit === null ? allFiles : allFiles.slice(0, fileLimit),
    ignoredPaths: fileLimit === null ? ignoredPaths : ignoredPaths.slice(0, fileLimit),
    gitlinks: fileLimit === null ? gitlinks : gitlinks.slice(0, fileLimit),
  };
}

function projectScope(value, { fixed = false } = {}) {
  const flagged = data(value, 'flagged');
  if (typeof flagged !== 'boolean') throw new TypeError('Invalid scope projection.');
  if (fixed) {
    const reasons = list(data(value, 'reasons'));
    const reasonCount = data(value, 'reasonCount') === undefined
      ? reasons.length
      : safeInteger(data(value, 'reasonCount'));
    const omittedReasonCount = data(value, 'omittedReasonCount') === undefined
      ? safeInteger(data(value, 'omitted'))
      : safeInteger(data(value, 'omittedReasonCount'));
    if (reasonCount === null || omittedReasonCount === null) throw new TypeError('Invalid fixed scope projection.');
    return {
      flagged,
      reasonCount,
      omittedReasonCount,
    };
  }
  const reasons = boundedStrings(data(value, 'reasons'), { maximum: 100, chars: 2_000 });
  const omitted = safeInteger(data(value, 'omitted'));
  if (reasons === null || omitted === null) throw new TypeError('Invalid scope projection.');
  return {
    flagged,
    reasons: [],
    omitted,
  };
}

function projectCleanup(value) {
  const removed = data(value, 'removed');
  const unregistered = data(value, 'unregistered');
  const tracked = data(value, 'tracked');
  if (typeof removed !== 'boolean' || !(typeof unregistered === 'boolean' || unregistered === null) ||
      typeof tracked !== 'boolean') throw new TypeError('Invalid cleanup projection.');
  return {
    removed,
    unregistered,
    tracked,
  };
}

function projectWorktree(value, { fixed = false, listLimit = null } = {}) {
  const ignoredPaths = boundedFileStrings(data(value, 'ignoredPaths'));
  const sharedRules = boundedFileStrings(data(value, 'sharedRules'));
  const transplanted = data(value, 'transplanted');
  if (ignoredPaths === null || sharedRules === null || typeof transplanted !== 'boolean') {
    throw new TypeError('Invalid worktree projection.');
  }
  const cleanup = projectCleanup(data(value, 'cleanup'));
  return fixed
    ? {
        transplanted,
        ignoredPathCount: ignoredPaths.length,
        sharedRuleCount: sharedRules.length,
        cleanup,
      }
    : {
        transplanted,
        ignoredPaths: listLimit === null ? ignoredPaths : ignoredPaths.slice(0, listLimit),
        sharedRules: listLimit === null ? sharedRules : sharedRules.slice(0, listLimit),
        cleanup,
      };
}

function projectBlockers(value) {
  return list(value).flatMap((item) => {
    const candidateId = data(item, 'candidateId');
    const where = cleanText(data(item, 'where'), 128);
    const error = cleanText(data(item, 'error'), 2_000);
    if (!(candidateId === undefined || laneId(candidateId) !== null) || where === null || error === null) return [];
    return [{ ...(candidateId === undefined ? {} : { candidateId }), where, error }];
  }).sort((left, right) => Buffer.compare(
    Buffer.from(`${left.candidateId ?? ''}\0${left.where}`, 'utf8'),
    Buffer.from(`${right.candidateId ?? ''}\0${right.where}`, 'utf8'),
  ));
}

function projectLearningMap(value) {
  const out = {};
  for (const axis of LEARNING_AXES) {
    const arm = data(value, axis);
    const normalized = cleanText(arm, 128);
    if (normalized !== null) out[axis] = normalized;
  }
  return out;
}

function projectLearning(value) {
  if (value === null || typeof value !== 'object') return null;
  const applied = data(value, 'applied');
  const taskClass = data(value, 'taskClass') === null ? null : cleanText(data(value, 'taskClass'), 128);
  const grade = data(applied, 'grade') === null ? null : cleanText(data(applied, 'grade'), 64);
  const axes = boundedStrings(data(applied, 'axes'), { maximum: LEARNING_AXES.length, chars: 32 });
  return {
    taskClass,
    decisions: projectLearningMap(data(value, 'decisions')),
    sources: projectLearningMap(data(value, 'sources')),
    applied: {
      grade,
      axes: (axes ?? []).filter((axis) => LEARNING_AXES.includes(axis)),
    },
  };
}

function projectPlan(value, excerpts) {
  const provider = cleanText(data(value, 'provider'), 128);
  const content = cleanText(data(value, 'content'), MAX_CONTENT_CHARS, { allowEmpty: true });
  if (provider === null) throw new TypeError('Invalid plan projection.');
  return {
    provider,
    content: excerpts && content !== null ? content : '',
  };
}

function projectSteps(value, excerpts) {
  return list(value).flatMap((step) => {
    const number = safeInteger(data(step, 'step'), { minimum: 1, maximum: 10 });
    const candidateId = data(step, 'laneId');
    const attemptId = cleanText(data(step, 'attemptId'), 160);
    const retry = data(step, 'retryOf');
    if (number === null || !(candidateId === undefined || laneId(candidateId) !== null) || attemptId === null ||
        !(retry === null || cleanText(retry, 160) !== null)) return [];
    const providerExcerpt = cleanText(data(step, 'providerExcerpt'), 2_000, { allowEmpty: true });
    const testExcerpt = cleanText(data(step, 'testExcerpt'), 2_000, { allowEmpty: true });
    return [{
      step: number,
      ...(candidateId === undefined ? {} : { laneId: candidateId }),
      attemptId,
      retryOf: retry,
      ...(excerpts && providerExcerpt !== null
      ? { providerExcerpt }
      : {}),
      ...(excerpts && testExcerpt !== null
      ? { testExcerpt }
      : {}),
    }];
  });
}

function projectVerdict(value, fixed = false) {
  if (value === null || typeof value !== 'object') return null;
  const candidateId = laneId(data(value, 'candidateId'));
  const attemptId = cleanText(data(value, 'attemptId'), 160);
  const verdict = data(value, 'verdict');
  const rawSummary = data(value, 'summary');
  const summary = rawSummary === null ? null : cleanText(rawSummary, 2_000, { allowEmpty: true });
  if (candidateId === null || attemptId === null || !['PASS', 'FAIL'].includes(verdict)) return null;
  return {
    candidateId,
    attemptId,
    verdict,
    summary: fixed || summary === null ? null : summary,
  };
}

function projectIssues(value) {
  const projected = list(value).map((issue) => {
    const candidateId = laneId(data(issue, 'candidateId'));
    const ids = boundedStrings(data(issue, 'openIssueIds'), { maximum: 100, chars: 128 });
    const count = safeInteger(data(issue, 'openIssueCount'), { maximum: 100 });
    const resolvedOmittedCount = safeInteger(data(issue, 'resolvedOmittedCount'));
    if (candidateId === null || ids === null || count !== ids.length || resolvedOmittedCount === null) {
      throw new TypeError('Invalid issue projection.');
    }
    return {
      candidateId,
      openIssueIds: ids,
      openIssueCount: count,
      resolvedOmittedCount,
    };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  if (new Set(projected.map(({ candidateId }) => candidateId)).size !== projected.length) {
    throw new TypeError('Duplicate issue candidate.');
  }
  return projected;
}

function projectArtifactPatch(value, files = null) {
  if (value === null) return null;
  const path = absolutePath(data(value, 'path'));
  const sha256 = data(value, 'sha256');
  const bytes = safeInteger(data(value, 'bytes'));
  const empty = data(value, 'empty');
  const allFiles = boundedFileStrings(data(value, 'files'));
  if (path === null || !SHA256_PATTERN.test(sha256 ?? '') || bytes === null || typeof empty !== 'boolean' ||
      allFiles === null) throw new TypeError('Invalid artifact patch projection.');
  return {
    path,
    sha256,
    bytes,
    empty,
    files: files ?? allFiles,
  };
}

function projectCandidates(value, { fileLimit = null } = {}) {
  const candidates = list(value).map((candidate) => {
    const candidateId = laneId(data(candidate, 'candidateId'));
    const binding = projectBinding(data(candidate, 'binding'));
    const usage = projectUsage(data(candidate, 'usage'));
    const patchValue = data(candidate, 'patch');
    const allFiles = patchValue === null ? [] : boundedFileStrings(data(patchValue, 'files'));
    if (candidateId === null || allFiles === null) throw new TypeError('Invalid candidate projection.');
    const patch = projectArtifactPatch(data(candidate, 'patch'), fileLimit === null ? allFiles : allFiles.slice(0, fileLimit));
    const proofStatus = data(candidate, 'proofStatus');
    const ids = boundedStrings(data(candidate, 'openIssueIds'), { maximum: 100, chars: 128 });
    const openIssueCount = safeInteger(data(candidate, 'openIssueCount'), { maximum: 100 });
    if (!PROOF_STATUSES.has(proofStatus) || ids === null || openIssueCount !== ids.length) {
      throw new TypeError('Invalid candidate status projection.');
    }
    const terminalClass = data(candidate, 'terminalClass');
    const stopReason = data(candidate, 'stopReason');
    return {
      candidateId,
      ...(binding === null ? {} : { binding }),
      ...(TERMINAL_CLASSES.has(terminalClass) ? { terminalClass } : {}),
      patch,
      proofStatus,
      openIssueIds: ids,
      openIssueCount,
      ...(data(candidate, 'scope') && typeof data(candidate, 'scope') === 'object'
        ? { scope: projectScope(data(candidate, 'scope'), { fixed: true }) }
        : {}),
      ...(cleanText(stopReason, 128) !== null ? { stopReason } : {}),
      ...(usage === null ? {} : { usage }),
    };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  if (candidates.length < 1 || candidates.length > 2 ||
      new Set(candidates.map(({ candidateId }) => candidateId)).size !== candidates.length) {
    throw new TypeError('Invalid candidate set.');
  }
  return candidates;
}

function projectAttempts(value, { summarizeOld = false, authority = null } = {}) {
  let omitted = 0;
  const rawAttempts = list(value);
  const idCounts = new Map();
  const ordinalCounts = new Map();
  for (const attempt of rawAttempts) {
    const candidateId = data(attempt, 'candidateId') ?? data(attempt, 'laneId');
    const ordinal = data(attempt, 'ordinal');
    const attemptId = data(attempt, 'attemptId');
    if (typeof attemptId === 'string') idCounts.set(attemptId, (idCounts.get(attemptId) ?? 0) + 1);
    const identity = `${candidateId}:${ordinal}`;
    ordinalCounts.set(identity, (ordinalCounts.get(identity) ?? 0) + 1);
  }
  const attempts = rawAttempts.flatMap((attempt) => {
    const candidateId = laneId(data(attempt, 'candidateId') ?? data(attempt, 'laneId'));
    const ordinal = safeInteger(data(attempt, 'ordinal'), { minimum: 1, maximum: 10 });
    const attemptId = cleanText(data(attempt, 'attemptId'), 160);
    const retryOf = data(attempt, 'retryOf');
    const result = data(attempt, 'result');
    const hash = data(attempt, 'hash');
    const ref = data(attempt, 'ref');
    const usage = projectUsage(data(attempt, 'usage'));
    const expectedSuffix = candidateId === null || ordinal === null ? null
      : `/${candidateId}/${String(ordinal).padStart(3, '0')}`;
    const expectedRetry = candidateId === null || ordinal === null || ordinal === 1 ? null
      : attemptId?.slice(0, -expectedSuffix.length) + `/${candidateId}/${String(ordinal - 1).padStart(3, '0')}`;
    const attemptParts = attemptId?.split('/') ?? [];
    const identity = `${candidateId}:${ordinal}`;
    const authorityValid = authority === null || candidateId !== null && ordinal !== null &&
      authority.candidateIds.includes(candidateId) && attemptParts[0] === authority.runId &&
      (ref === null || ref === join(authority.runDir, 'attempts', `${candidateId}-${String(ordinal).padStart(3, '0')}.json`));
    if (candidateId === null || ordinal === null || attemptId === null ||
        attemptParts.length !== 3 || !validRunId(attemptParts[0]) || !attemptId.endsWith(expectedSuffix) ||
        retryOf !== expectedRetry || !ATTEMPT_RESULTS.has(result) ||
        !(hash === null || SHA256_PATTERN.test(hash)) || !(ref === null || absolutePath(ref) !== null) ||
        !authorityValid || idCounts.get(attemptId) !== 1 || ordinalCounts.get(identity) !== 1) {
      omitted += 1;
      return [];
    }
    return [{
      candidateId,
      ordinal,
      attemptId,
      retryOf,
      result,
      hash,
      ref,
      ...(usage === null ? {} : { usage }),
    }];
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId) || left.ordinal - right.ordinal);
  if (!summarizeOld) return { entries: attempts, omitted };
  const latest = new Map();
  for (const attempt of attempts) latest.set(attempt.candidateId, attempt.ordinal);
  return { omitted, entries: attempts.map((attempt) => attempt.ordinal === latest.get(attempt.candidateId)
    ? attempt
    : {
        candidateId: attempt.candidateId,
        ordinal: attempt.ordinal,
        attemptId: attempt.attemptId,
        retryOf: attempt.retryOf,
        result: attempt.result,
        hash: attempt.hash,
        ref: attempt.ref,
      }) };
}

function projectEvidence(value, limit = null, authority = null) {
  let malformed = 0;
  const rawEvidence = list(value);
  const idCounts = new Map();
  for (const entry of rawEvidence) {
    const evidenceId = data(entry, 'evidenceId');
    if (typeof evidenceId === 'string') idCounts.set(evidenceId, (idCounts.get(evidenceId) ?? 0) + 1);
  }
  const entries = rawEvidence.flatMap((entry) => {
    const evidenceId = cleanText(data(entry, 'evidenceId'), 192);
    const kind = data(entry, 'kind');
    const repetition = safeInteger(data(entry, 'repetition'), { minimum: 1, maximum: 2 });
    const outcome = data(entry, 'outcome');
    const witnessCount = safeInteger(data(entry, 'witnessCount'), { maximum: 20_000 });
    const path = absolutePath(data(entry, 'path'));
    const kindLabel = kind === 'b0' ? 'B0' : kind === 'br' ? 'BR' : kind === 'c' ? 'C' : null;
    const parts = evidenceId?.split('/') ?? [];
    const validId = parts.length === 5 && validRunId(parts[0]) && laneId(parts[1]) !== null &&
      /^\d{3}$/.test(parts[2]) && parts[3] === kindLabel && Number(parts[4]) === repetition;
    const authorityValid = authority === null || validId && parts[0] === authority.runId &&
      authority.candidateIds.includes(parts[1]) &&
      (authority.selectedCandidateId === null || parts[1] === authority.selectedCandidateId) &&
      dirname(path ?? '') === join(authority.runDir, 'evidence') &&
      new RegExp(`^${parts[1]}-${parts[2]}-\\d{3}\\.json$`).test(basename(path ?? ''));
    if (evidenceId === null || !EVIDENCE_KINDS.has(kind) || repetition === null ||
        !EVIDENCE_OUTCOMES.has(outcome) || witnessCount === null || path === null || !validId ||
        !authorityValid || idCounts.get(evidenceId) !== 1) {
      malformed += 1;
      return [];
    }
    return [{ evidenceId, kind, repetition, outcome, witnessCount, path }];
  }).sort((left, right) => Buffer.compare(Buffer.from(left.evidenceId, 'utf8'), Buffer.from(right.evidenceId, 'utf8')));
  const kept = limit === null ? entries : entries.slice(0, limit);
  return { entries: kept, omitted: malformed + entries.length - kept.length };
}

function projectRegressionProof(value, evidenceLimit = null, authority = null) {
  const projected = projectEvidence(data(value, 'evidenceRefs'), evidenceLimit, authority);
  const status = data(value, 'status');
  const selectedCandidateId = data(value, 'selectedCandidateId');
  const priorOmitted = safeInteger(data(value, 'omittedEvidenceCount'));
  if (!PROOF_STATUSES.has(status) || !(selectedCandidateId === null || laneId(selectedCandidateId) !== null) ||
      priorOmitted === null) throw new TypeError('Invalid regression proof projection.');
  return {
    status,
    selectedCandidateId,
    evidenceRefs: projected.entries,
    omittedEvidenceCount: checkedAdd(priorOmitted, projected.omitted),
  };
}

function projectObjective(value) {
  if (value === null || typeof value !== 'object') return null;
  const result = data(value, 'result');
  const decisiveField = data(value, 'decisiveField');
  const tupleA = list(data(value, 'tupleA'));
  const tupleB = list(data(value, 'tupleB'));
  const validTuple = (tuple) => tuple.length === 5 && TUPLE_TERMINALS.has(tuple[0]) &&
    PROOF_STATUSES.has(tuple[1]) && TUPLE_TESTS.has(tuple[2]) &&
    safeInteger(tuple[3]) !== null && Array.isArray(tuple[4]) && tuple[4].length === 2 &&
    [0, 1].includes(tuple[4][0]) && safeInteger(tuple[4][1]) !== null;
  if (!['a', 'b', 'tie', 'equivalent'].includes(result) ||
      !(decisiveField === null || DECISIVE_FIELDS.has(decisiveField)) ||
      !validTuple(tupleA) || !validTuple(tupleB)) return null;
  const compare = () => {
    const fields = ['terminalClass', 'proof', 'tests', 'openIssues'];
    const ranked = [TERMINAL_RANK, PROOF_RANK, TEST_RANK];
    for (let index = 0; index < 4; index += 1) {
      const left = index < 3 ? ranked[index][tupleA[index]] : tupleA[index];
      const right = index < 3 ? ranked[index][tupleB[index]] : tupleB[index];
      if (left !== right) return {
        result: index === 3 ? left < right ? 'a' : 'b' : left > right ? 'a' : 'b',
        decisiveField: fields[index],
      };
    }
    for (let index = 0; index < 2; index += 1) {
      if (tupleA[4][index] !== tupleB[4][index]) return {
        result: tupleA[4][index] < tupleB[4][index] ? 'a' : 'b', decisiveField: 'scope',
      };
    }
    return { result: 'tie', decisiveField: null };
  };
  const derived = compare();
  if (result === 'equivalent'
    ? decisiveField !== null
    : result !== derived.result || decisiveField !== derived.decisiveField) return null;
  return {
    result,
    decisiveField,
    tupleA,
    tupleB,
  };
}

function projectJudge(value) {
  if (data(value, 'status') === 'invalid') {
    const judgeIndex = safeInteger(data(value, 'judgeIndex'), { minimum: 1, maximum: 2 });
    const code = data(value, 'code');
    if (judgeIndex === null || typeof data(value, 'corrected') !== 'boolean' || !JUDGE_CODES.has(code)) return null;
    return {
      status: 'invalid', judgeIndex,
      corrected: data(value, 'corrected'), code,
    };
  }
  const judgeIndex = safeInteger(data(value, 'judgeIndex'), { minimum: 1, maximum: 2 });
  const realDecision = data(value, 'realDecision');
  const rationale = cleanText(data(value, 'rationale'), 2_000, { allowEmpty: true });
  const rawDefects = list(data(value, 'majorDefects'));
  if (data(value, 'status') !== 'valid' || judgeIndex === null ||
      !['lane-a', 'lane-b', 'TIE'].includes(realDecision) || typeof data(value, 'corrected') !== 'boolean' ||
      rationale === null || rawDefects.length > 20) return null;
  const majorDefects = rawDefects.flatMap((defect) => {
    const category = data(defect, 'category');
    const claim = cleanText(data(defect, 'claim'), 1_000);
    const evidence = cleanText(data(defect, 'evidence'), 1_000);
    return JUDGE_CATEGORIES.has(category) && claim !== null && evidence !== null
      ? [{ category, claim, evidence }]
      : [];
  });
  if (majorDefects.length !== rawDefects.length) return null;
  return {
    status: 'valid', judgeIndex,
    realDecision, corrected: data(value, 'corrected'),
    rationale,
    majorDefects,
  };
}

function projectSelection(value, candidateCount) {
  const outcome = data(value, 'outcome');
  const selectedCandidateId = data(value, 'selectedCandidateId');
  const needsSelection = SELECTED_OUTCOMES.has(outcome);
  const objectiveValue = data(value, 'objectiveComparison');
  const objectiveComparison = projectObjective(objectiveValue);
  const rawJudges = list(data(value, 'judgeDecisions'));
  const judgeDecisions = rawJudges.map(projectJudge);
  const sortedJudges = judgeDecisions.sort((a, b) => a?.judgeIndex - b?.judgeIndex);
  const exactJudgePair = sortedJudges.length === 2 && sortedJudges[0]?.judgeIndex === 1 && sortedJudges[1]?.judgeIndex === 2;
  let combinationValid = false;
  if (objectiveComparison === null) {
    combinationValid = sortedJudges.length === 0 && ['winner', 'single_survivor', 'none'].includes(outcome);
  } else if (objectiveComparison.result === 'equivalent') {
    combinationValid = outcome === 'equivalent' && selectedCandidateId === 'lane-a' && sortedJudges.length === 0;
  } else if (objectiveComparison.result === 'a' || objectiveComparison.result === 'b') {
    combinationValid = outcome === 'winner' && selectedCandidateId === (objectiveComparison.result === 'a' ? 'lane-a' : 'lane-b') &&
      sortedJudges.length === 0;
  } else if (objectiveComparison.result === 'tie' && exactJudgePair) {
    const invalid = sortedJudges.some((judge) => judge.status === 'invalid');
    const valid = invalid ? [] : sortedJudges;
    const veto = valid.some((judge) => judge.realDecision === 'TIE' || judge.majorDefects.length > 0);
    const agreed = valid.length === 2 && valid[0].realDecision === valid[1].realDecision;
    combinationValid = invalid ? outcome === 'none' && selectedCandidateId === null
      : veto || !agreed ? outcome === 'tie' && selectedCandidateId === null
        : outcome === 'winner' && selectedCandidateId === valid[0].realDecision;
  }
  if (!ALL_OUTCOMES.has(outcome) || needsSelection !== (selectedCandidateId !== null) ||
      selectedCandidateId !== null && laneId(selectedCandidateId) === null ||
      outcome === 'equivalent' && selectedCandidateId !== 'lane-a' ||
      objectiveValue !== null && objectiveComparison === null || judgeDecisions.some((entry) => entry === null) ||
      !combinationValid || objectiveComparison === null &&
        (candidateCount === 2 && outcome === 'winner' || candidateCount === 1 && outcome === 'single_survivor')) {
    throw new TypeError('Invalid selection projection.');
  }
  return {
    outcome,
    selectedCandidateId,
    objectiveComparison,
    judgeDecisions: sortedJudges,
  };
}

function projectArtifacts(value) {
  const manifestPath = absolutePath(data(value, 'manifestPath'));
  const expiresAt = safeInteger(data(value, 'expiresAt'), { minimum: 1 });
  const candidatePaths = boundedStrings(data(value, 'candidatePaths'), { maximum: 2 });
  const omittedCount = safeInteger(data(value, 'omittedCount'));
  if (manifestPath === null || expiresAt === null || candidatePaths === null ||
      candidatePaths.some((path) => absolutePath(path) === null) || omittedCount === null) {
    throw new TypeError('Invalid artifact projection.');
  }
  return {
    manifestPath,
    expiresAt,
    candidatePaths,
    omittedCount,
  };
}

function projectOmittedCounts(value, additions = {}) {
  const values = Object.fromEntries(['issues', 'attempts', 'evidence', 'files', 'artifacts'].map((key) => [
    key, safeInteger(data(value, key)),
  ]));
  if (Object.values(values).some((entry) => entry === null)) throw new TypeError('Invalid omitted counts.');
  return {
    issues: checkedAdd(values.issues, integer(additions.issues)),
    attempts: checkedAdd(values.attempts, integer(additions.attempts)),
    evidence: checkedAdd(values.evidence, integer(additions.evidence)),
    files: checkedAdd(values.files, integer(additions.files)),
    artifacts: checkedAdd(values.artifacts, integer(additions.artifacts)),
  };
}

function buildContentProjection(summary, {
  excerpts = true,
  summarizeOldAttempts = false,
  fileLimit = null,
  evidenceLimit = null,
} = {}) {
  const runId = data(summary, 'runId');
  const stopReason = cleanText(data(summary, 'stopReason'), 128);
  const stepCount = safeInteger(data(summary, 'stepCount'));
  const floor = buildFixedFloorProjection(data(summary, 'fixedFloorInput'));
  const candidates = projectCandidates(data(summary, 'candidates'), { fileLimit });
  const selection = projectSelection(data(summary, 'selection'), candidates.length);
  const candidateIds = candidates.map(({ candidateId }) => candidateId);
  const authority = {
    runId,
    runDir: data(data(data(summary, 'fixedFloorInput'), 'paths'), 'runDir'),
    candidateIds,
    selectedCandidateId: selection.selectedCandidateId,
  };
  const attempts = projectAttempts(data(summary, 'attempts'), {
    summarizeOld: summarizeOldAttempts,
    authority,
  });
  const regressionProof = projectRegressionProof(data(summary, 'regressionProof'), evidenceLimit, authority);
  const issues = projectIssues(data(summary, 'issues'));
  const projectedVerdict = projectVerdict(data(summary, 'verdict'));
  const verdict = projectedVerdict !== null && projectedVerdict.verdict === 'PASS' && attempts.entries.some((attempt) =>
    attempt.attemptId === projectedVerdict.attemptId && attempt.candidateId === projectedVerdict.candidateId)
    ? projectedVerdict
    : null;
  const artifacts = projectArtifacts(data(summary, 'artifacts'));
  const fullCandidateFiles = projectCandidates(data(summary, 'candidates')).reduce((sum, candidate) => sum + (candidate.patch?.files.length ?? 0), 0);
  const keptCandidateFiles = candidates.reduce((sum, candidate) => sum + (candidate.patch?.files.length ?? 0), 0);
  const rawLegacyPatch = data(summary, 'patch');
  const fullLegacyPatch = projectLegacyPatch(rawLegacyPatch);
  const reducedLegacyPatch = projectLegacyPatch(rawLegacyPatch, { fileLimit });
  const aliasDurable = data(summary, 'aliasDurable');
  const selected = selection.selectedCandidateId !== null;
  const legacyPatch = selected && aliasDurable === true ? reducedLegacyPatch : null;
  const fullWorktree = projectWorktree(data(summary, 'worktree'));
  const worktree = projectWorktree(data(summary, 'worktree'), { listLimit: fileLimit });
  const countLegacyPaths = (patch) => patch === null ? 0
    : patch.files.length + patch.ignoredPaths.length + patch.gitlinks.length;
  const fullFiles = fullCandidateFiles + countLegacyPaths(fullLegacyPatch) +
    fullWorktree.ignoredPaths.length + fullWorktree.sharedRules.length;
  const keptFiles = keptCandidateFiles + countLegacyPaths(legacyPatch) +
    worktree.ignoredPaths.length + worktree.sharedRules.length;
  const omittedCounts = projectOmittedCounts(data(summary, 'omittedCounts'), {
    files: fullFiles - keptFiles,
    attempts: attempts.omitted,
    evidence: regressionProof.omittedEvidenceCount - integer(data(data(summary, 'regressionProof'), 'omittedEvidenceCount')),
  });
  const durablePaths = candidates.flatMap((candidate) => candidate.patch === null ? [] : [candidate.patch.path])
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  const projectedSteps = projectSteps(data(summary, 'steps'), excerpts);
  const steps = selected
    ? projectedSteps.filter((step) => step.laneId === selection.selectedCandidateId)
    : [];
  const selectedCandidate = selected
    ? candidates.find((candidate) => candidate.candidateId === selection.selectedCandidateId)
    : null;
  const selectedTupleProof = selection.objectiveComparison === null || selection.selectedCandidateId === null
    ? null
    : selection.objectiveComparison[selection.selectedCandidateId === 'lane-a' ? 'tupleA' : 'tupleB'][1];
  const tupleMatchesCandidate = (tuple, candidate) => tuple[0] === candidate.terminalClass &&
    tuple[1] === candidate.proofStatus && tuple[3] === candidate.openIssueCount &&
    tuple[4][0] === (candidate.scope?.flagged === true ? 1 : 0) &&
    tuple[4][1] === checkedAdd(candidate.scope?.reasonCount ?? 0, candidate.scope?.omittedReasonCount ?? 0);
  const objectiveFactsMatch = selection.objectiveComparison === null || candidates.length === 2 &&
    tupleMatchesCandidate(selection.objectiveComparison.tupleA, candidates[0]) &&
    tupleMatchesCandidate(selection.objectiveComparison.tupleB, candidates[1]);
  const resolvedIssueOmissions = issues.reduce((sum, issue) => checkedAdd(sum, issue.resolvedOmittedCount), 0);
  if (!validRunId(runId) || runId !== floor.runId || stopReason === null || stopReason !== floor.stopReason || stepCount === null ||
      typeof aliasDurable !== 'boolean' || selection.outcome !== floor.selection.outcome ||
      selection.selectedCandidateId !== floor.selection.selectedCandidateId ||
      selection.outcome === 'equivalent' &&
        (candidates.length !== 2 || candidates[0].patch === null || candidates[1].patch === null ||
          candidates[0].patch.bytes <= 0 || candidates[0].patch.bytes !== candidates[1].patch.bytes ||
          candidates[0].patch.sha256 !== candidates[1].patch.sha256) ||
      aliasDurable === true && selected && (legacyPatch === null || legacyPatch.path !== floor.patch?.path) ||
      legacyPatch !== null && selectedCandidate !== null &&
        (legacyPatch.bytes !== selectedCandidate.patch?.bytes || legacyPatch.empty !== selectedCandidate.patch?.empty ||
          legacyPatch.files.length !== selectedCandidate.patch?.files.length ||
          legacyPatch.files.some((file, index) => file !== selectedCandidate.patch.files[index])) ||
      issues.length !== candidates.length || issues.some((issue, index) => issue.candidateId !== candidateIds[index]) ||
      candidates.length !== floor.candidates.length || candidates.some((candidate, index) =>
        candidate.candidateId !== floor.candidates[index].candidateId ||
        candidate.patch?.path !== floor.candidates[index].patch?.path ||
        candidate.proofStatus !== floor.candidates[index].proofStatus ||
        candidate.openIssueCount !== floor.candidates[index].openIssueCount ||
        candidate.openIssueIds.some((id, idIndex) => id !== floor.candidates[index].openIssueIds[idIndex])) ||
      artifacts.manifestPath !== floor.artifacts.manifestPath ||
      artifacts.candidatePaths.length !== durablePaths.length ||
      artifacts.candidatePaths.some((path, index) => path !== durablePaths[index]) ||
      artifacts.candidatePaths.some((path, index) => path !== floor.artifacts.candidatePaths[index]) ||
      selection.selectedCandidateId !== regressionProof.selectedCandidateId ||
      selection.selectedCandidateId !== null && selectedCandidate?.proofStatus !== regressionProof.status ||
      selectedTupleProof !== null && selectedTupleProof !== selectedCandidate?.proofStatus ||
      !objectiveFactsMatch ||
      selection.selectedCandidateId !== null && !candidateIds.includes(selection.selectedCandidateId) ||
      selected && (selectedCandidate?.openIssueCount !== 0 || selectedCandidate.openIssueIds.length !== 0 ||
        selectedCandidate.patch === null || selectedCandidate.patch.bytes <= 0 || selectedCandidate.patch.empty !== false ||
        !['verified', 'usable_unverified'].includes(selectedCandidate.terminalClass) ||
        selectedCandidate.terminalClass === 'usable_unverified' && selectedCandidate.stopReason !== 'evidence_unavailable' ||
        selectedCandidate.scope?.flagged === true) ||
      verdict !== null && verdict.candidateId !== selection.selectedCandidateId ||
      artifacts.omittedCount !== omittedCounts.artifacts ||
      regressionProof.omittedEvidenceCount !== omittedCounts.evidence ||
      resolvedIssueOmissions !== omittedCounts.issues) {
    throw new TypeError('Invalid mandatory summary projection.');
  }
  return {
    runId,
    stopReason,
    stepCount,
    ...(legacyPatch === null ? {} : { patch: legacyPatch }),
    scope: projectScope(data(summary, 'scope')),
    worktree,
    blockers: projectBlockers(data(summary, 'blockers')),
    learning: projectLearning(data(summary, 'learning')),
    plan: projectPlan(data(summary, 'plan'), excerpts),
    steps,
    verdict,
    issues,
    candidates,
    attempts: attempts.entries,
    regressionProof,
    selection,
    artifacts,
    omittedCounts,
  };
}

function buildFixedContentProjection(summary) {
  const floorInput = data(summary, 'fixedFloorInput');
  const baseFloor = buildFixedFloorProjection(floorInput);
  if (baseFloor.selection.selectedCandidateId !== null) {
    const rawSelected = list(data(summary, 'candidates')).find((candidate) =>
      data(candidate, 'candidateId') === baseFloor.selection.selectedCandidateId);
    const rawSelectedPatch = data(rawSelected, 'patch');
    const rawSelectedScope = data(rawSelected, 'scope');
    const rawTerminal = data(rawSelected, 'terminalClass');
    if (rawSelected === undefined || !['verified', 'usable_unverified'].includes(rawTerminal) ||
        rawTerminal === 'usable_unverified' && data(rawSelected, 'stopReason') !== 'evidence_unavailable' ||
        safeInteger(data(rawSelectedPatch, 'bytes'), { minimum: 1 }) === null || data(rawSelectedPatch, 'empty') !== false ||
        rawSelectedScope !== undefined && data(rawSelectedScope, 'flagged') !== false) {
      throw new TypeError('Invalid selected candidate eligibility.');
    }
  }
  const floorAuthority = {
    runId: baseFloor.runId,
    runDir: data(data(floorInput, 'paths'), 'runDir'),
    candidateIds: baseFloor.candidates.map(({ candidateId }) => candidateId),
    selectedCandidateId: baseFloor.selection.selectedCandidateId,
  };
  const attemptProjection = projectAttempts(data(summary, 'attempts'), { authority: floorAuthority });
  const evidenceProjection = projectEvidence(data(data(summary, 'regressionProof'), 'evidenceRefs'), null, floorAuthority);
  const arrayLength = (value) => Array.isArray(value) ? value.length : 0;
  const rawCandidates = list(data(summary, 'candidates'));
  const rawPatch = data(summary, 'patch');
  const rawWorktree = data(summary, 'worktree');
  const files = rawCandidates.reduce((sum, candidate) => checkedAdd(sum,
    arrayLength(data(data(candidate, 'patch'), 'files'))), 0) +
    arrayLength(data(rawPatch, 'files')) + arrayLength(data(rawPatch, 'ignoredPaths')) +
    arrayLength(data(rawPatch, 'gitlinks')) + arrayLength(data(rawWorktree, 'ignoredPaths')) +
    arrayLength(data(rawWorktree, 'sharedRules'));
  const blockers = projectBlockers(data(summary, 'blockers'));
  const omittedCounts = projectOmittedCounts(baseFloor.omittedCounts, {
    attempts: attemptProjection.entries.length + attemptProjection.omitted,
    evidence: evidenceProjection.entries.length + evidenceProjection.omitted,
    files,
    issues: blockers.length,
  });
  const floor = buildFixedFloorProjection({
    runId: data(floorInput, 'runId'),
    stopReason: data(floorInput, 'stopReason'),
    candidateCount: data(floorInput, 'candidateCount'),
    outcome: data(floorInput, 'outcome'),
    selectedCandidateId: data(floorInput, 'selectedCandidateId'),
    paths: data(floorInput, 'paths'),
    candidates: data(floorInput, 'candidates'),
    issueSummary: data(floorInput, 'issueSummary'),
    omittedCounts,
  });
  let resolvedOmissions = null;
  try {
    const projectedIssues = projectIssues(data(summary, 'issues'));
    const aligned = projectedIssues.length === baseFloor.candidates.length &&
      projectedIssues.every((issue, index) => {
        const candidate = baseFloor.candidates[index];
        return issue.candidateId === candidate.candidateId &&
          issue.openIssueCount === candidate.openIssueCount &&
          issue.openIssueIds.length === candidate.openIssueIds.length &&
          issue.openIssueIds.every((id, idIndex) => id === candidate.openIssueIds[idIndex]);
      });
    const resolvedTotal = projectedIssues.reduce((sum, issue) =>
      checkedAdd(sum, issue.resolvedOmittedCount), 0);
    if (aligned && resolvedTotal === baseFloor.omittedCounts.issues) {
      resolvedOmissions = new Map(projectedIssues.map((issue) => [
        issue.candidateId, issue.resolvedOmittedCount,
      ]));
    }
  } catch { /* Task8 floor remains the issue authority. */ }
  const issues = floor.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    openIssueIds: [...candidate.openIssueIds],
    openIssueCount: candidate.openIssueCount,
    resolvedOmittedCount: resolvedOmissions?.get(candidate.candidateId) ?? 0,
  }));
  const legacyPatch = data(summary, 'aliasDurable') === true && Object.hasOwn(floor, 'patch') ? floor.patch : null;
  let rawProof;
  try { rawProof = projectRegressionProof(data(summary, 'regressionProof'), 0); } catch { rawProof = null; }
  const selectedFloorCandidate = floor.selection.selectedCandidateId === null ? null
    : floor.candidates.find((candidate) => candidate.candidateId === floor.selection.selectedCandidateId);
  const proof = {
    status: selectedFloorCandidate?.proofStatus ??
      (rawProof?.selectedCandidateId === floor.selection.selectedCandidateId ? rawProof.status : 'unavailable'),
    selectedCandidateId: floor.selection.selectedCandidateId,
    evidenceRefs: [],
    omittedEvidenceCount: floor.omittedCounts.evidence,
  };
  const projectedVerdict = projectVerdict(data(summary, 'verdict'), true);
  const verdict = projectedVerdict !== null && projectedVerdict.verdict === 'PASS' && floor.selection.selectedCandidateId !== null &&
    projectedVerdict.candidateId === floor.selection.selectedCandidateId &&
    attemptProjection.entries.some((attempt) => attempt.attemptId === projectedVerdict.attemptId &&
      attempt.candidateId === projectedVerdict.candidateId)
    ? projectedVerdict
    : null;
  let fixedScope = { flagged: false, reasonCount: 0, omittedReasonCount: 0 };
  let fixedWorktree = {
    transplanted: false, ignoredPathCount: 0, sharedRuleCount: 0,
    cleanup: { removed: false, unregistered: null, tracked: false },
  };
  let fixedPlan = { provider: 'unknown', content: '' };
  try { fixedScope = projectScope(data(summary, 'scope'), { fixed: true }); } catch { /* bounded constant */ }
  try { fixedWorktree = projectWorktree(data(summary, 'worktree'), { fixed: true }); } catch { /* bounded constant */ }
  try { fixedPlan = projectPlan(data(summary, 'plan'), false); } catch { /* bounded constant */ }
  return {
    runId: floor.runId,
    stopReason: floor.stopReason,
    stepCount: integer(data(summary, 'stepCount')),
    ...(legacyPatch === null ? {} : { patch: legacyPatch }),
    scope: fixedScope,
    worktree: fixedWorktree,
    blockers: [],
    learning: null,
    plan: fixedPlan,
    steps: [],
    verdict,
    issues,
    candidates: floor.candidates,
    attempts: [],
    regressionProof: {
      status: proof.status,
      selectedCandidateId: proof.selectedCandidateId,
      evidenceRefs: [],
      omittedEvidenceCount: proof.omittedEvidenceCount,
    },
    selection: floor.selection,
    artifacts: floor.artifacts,
    omittedCounts: floor.omittedCounts,
  };
}

function stringifyProjection(projection) {
  const serialized = JSON.stringify(projection);
  return typeof serialized === 'string' ? serialized : null;
}

export function renderContentParts(summary) {
  let fixed;
  try {
    fixed = stringifyProjection(buildFixedContentProjection(summary));
  } catch {
    fixed = null;
  }
  const contentFallback = fixed !== null && fixed.length <= MAX_CONTENT_CHARS ? fixed : CONTENT_FALLBACK;
  const levels = [
    () => buildContentProjection(summary),
    () => buildContentProjection(summary, { excerpts: false }),
    () => buildContentProjection(summary, { excerpts: false, summarizeOldAttempts: true }),
    () => buildContentProjection(summary, { excerpts: false, summarizeOldAttempts: true, fileLimit: 10, evidenceLimit: 4 }),
  ];
  for (const build of levels) {
    try {
      const content = stringifyProjection(build());
      if (content !== null && content.length <= MAX_CONTENT_CHARS) return { content, contentFallback };
    } catch {
      // A smaller typed rung may avoid an invalid optional detail.
    }
  }
  return { content: contentFallback, contentFallback };
}
