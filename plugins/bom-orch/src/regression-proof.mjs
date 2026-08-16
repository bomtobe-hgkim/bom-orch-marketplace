import { createHash } from 'node:crypto';
import {
  checkFrozenTestPlanEnvironment,
  classifyFrozenTestPath,
  runFrozenTests,
  selectTestDeltaWitnesses,
} from './test-runner.mjs';
import {
  applyPatchBytes,
  collectPatchAtRevision,
  createRevisionWorktree,
  removeWorktree,
  revisionIdentity,
} from './worktree.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_MODE = new Set(['100644', '100755']);
const BUG_FIX_PATTERN = /\b(?:bug|bugs|error|errors|failure|failures|regression|regressions|repair|repairs|fix|fixes|fixed|fixing)\b|버그|오류|실패|회귀|고쳐|(?:문제|결함|깨짐|고장)(?:을|를|이|가)?\s*(?:수정|고치|해결)/i;
const NON_BUG_PATTERN = /\b(?:feature|features|refactor|refactors|refactoring|docs?|documentation)\b|기능|리팩터|문서/i;
const CODE_CLASSES = new Set(['code:test-bearing', 'code:no-tests']);
const EVIDENCE_KEYS = [
  'schemaVersion',
  'evidenceId',
  'attemptId',
  'kind',
  'repetition',
  'baselineRevision',
  'baselineTree',
  'candidateRevision',
  'candidateTree',
  'candidatePatchSha256',
  'testPlanFingerprint',
  'environmentFingerprint',
  'testDeltaSha256',
  'classified',
];
const CLASSIFIED_KEYS = [
  'execution',
  'outcome',
  'failureKind',
  'stability',
  'reproduction',
  'witnessIds',
  'failureFingerprints',
  'outputSha256',
  'outputChars',
  'planFingerprint',
  'environmentFingerprint',
  'truncated',
  'diagnostics',
];
const COMPANION_KEYS = ['witnessIds', 'assertionWitnessIds'];
const CACHE_CELL_KEYS = ['classified', 'deltaWitnessIds', 'deltaAssertionWitnessIds'];
const INVALID_EVIDENCE_CACHES = new WeakMap();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sortedStrings(values) {
  return Array.isArray(values) && values.every((value) => typeof value === 'string')
    ? [...new Set(values)].sort()
    : null;
}

function result(required, status, repairable, evidenceIds = [], reasonCodes = [], witnessIds = []) {
  return {
    required,
    status,
    repairable,
    evidenceIds: [...new Set(evidenceIds)].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))),
    reasonCodes: [...new Set(reasonCodes)],
    witnessIds: [...new Set(witnessIds)].sort(),
  };
}

/** Freeze the proof policy before provider-controlled work begins. */
export function classifyProofRequirement(input = {}) {
  const task = typeof input?.task === 'string' ? input.task : '';
  const taskClass = typeof input?.taskClass === 'string' ? input.taskClass : '';
  if (BUG_FIX_PATTERN.test(task)) return Object.freeze({ required: true, reason: 'explicit_bug_fix' });
  if (NON_BUG_PATTERN.test(task)) return Object.freeze({ required: false, reason: 'explicit_non_bug' });
  if (CODE_CLASSES.has(taskClass)) return Object.freeze({ required: true, reason: 'default_code_change' });
  return Object.freeze({ required: false, reason: 'non_code_task' });
}

function invalidPath(path) {
  if (typeof path !== 'string' || path === '' || path.length > 4_096 || /[\u0000-\u001f\u007f\uFFFD]/.test(path) ||
      path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true;
  const parts = path.normalize('NFC').split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..');
}

function testDefinitionPath(path, definitions) {
  if (definitions.some((entry) => entry === path || entry !== '.' && path.startsWith(`${entry.replace(/\/$/, '')}/`))) {
    return true;
  }
  const name = path.split('/').at(-1);
  return path === 'package.json' || path === '.npmrc' ||
    ['GNUmakefile', 'makefile', 'Makefile', 'pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'conftest.py',
      'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'nuget.config', 'NuGet.config',
      'global.json', 'Directory.Build.rsp', 'MSBuild.rsp', 'dotnet.config'].includes(name) ||
    /\.(?:sln|slnx|slnf|csproj)$/i.test(name) || path.startsWith('node_modules/.bin/');
}

function noDelta(status, reasonCode) {
  return { status, patch: null, sha256: null, paths: [], reasonCodes: [reasonCode] };
}

/** Extract one path-filtered immutable binary patch containing only trusted ordinary test files. */
export async function splitTestOnlyDelta(input = {}, deps = {}) {
  const entries = Array.isArray(input?.entries) ? input.entries : null;
  const plan = input?.testPlan;
  if (entries === null || !OBJECT_ID_PATTERN.test(input?.baselineRevision ?? '') ||
      !OBJECT_ID_PATTERN.test(input?.candidateRevision ?? '')) return noDelta('unsafe', 'invalid_delta_input');
  if (plan?.regressionWitnessTrusted !== true || !['node-events-v1', 'pytest-events-v1'].includes(plan?.adapterId)) {
    return noDelta('ambiguous', 'untrusted_test_plan');
  }
  if (!Array.isArray(input.ignoredPaths) || !Array.isArray(input.unsafePaths)) {
    return noDelta('unsafe', 'path_policy_unavailable');
  }
  if (input.ignoredPaths.some(invalidPath)) return noDelta('unsafe', 'invalid_ignored_path');
  if (input.unsafePaths.some(invalidPath)) return noDelta('unsafe', 'invalid_unsafe_path');
  if (input.ignoredPaths.length > 0) return noDelta('unsafe', 'ignored_test_path');
  if (input.unsafePaths.length > 0) return noDelta('unsafe', 'unsafe_test_path');
  const definitions = (Array.isArray(plan.pinnedDefinitions) ? plan.pinnedDefinitions : [])
    .map((entry) => entry?.path)
    .filter((path) => typeof path === 'string');
  const testEntries = [];
  const seen = new Set();
  const classifyPath = deps.classifyTestPath ?? classifyFrozenTestPath;
  for (const entry of entries) {
    const path = entry?.path;
    if (invalidPath(path) || !['added', 'modified', 'deleted'].includes(entry?.status)) {
      return noDelta('unsafe', 'invalid_delta_path');
    }
    if (seen.has(path)) return noDelta('unsafe', 'duplicate_delta_path');
    seen.add(path);
    if (testDefinitionPath(path, definitions)) return noDelta('unsafe', 'test_definition_tampering');
    if (entry.oldMode !== null && !SAFE_MODE.has(entry.oldMode) ||
        entry.newMode !== null && !SAFE_MODE.has(entry.newMode)) return noDelta('unsafe', 'unsafe_test_path');
    let pathClass;
    try {
      pathClass = classifyPath(plan, path);
    } catch {
      pathClass = 'helper';
    }
    if (pathClass === 'test') {
      testEntries.push(entry);
    } else if (pathClass === 'helper') {
      return noDelta('ambiguous', 'untrusted_test_helper');
    } else if (pathClass !== 'outside') {
      return noDelta('ambiguous', 'untrusted_test_plan');
    }
  }
  if (testEntries.length === 0) return noDelta('empty', 'no_test_delta');
  if (testEntries.every((entry) => entry.status === 'deleted')) {
    return noDelta('deletion_only', 'test_delta_deletion_only');
  }
  const paths = testEntries.map((entry) => entry.path).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const collect = deps.collectPatchAtRevision ?? collectPatchAtRevision;
  let collected;
  try {
    collected = await collect(input.candidateWorktree, {
      from: input.baselineRevision,
      to: input.candidateRevision,
      paths,
    });
  } catch {
    return noDelta('ambiguous', 'test_delta_collection_failed');
  }
  if (collected?.blocked) return noDelta('ambiguous', 'test_delta_collection_failed');
  const patch = collected?.patch;
  const files = Array.isArray(collected?.files) ? collected.files : null;
  if (collected?.ok !== true || !Buffer.isBuffer(patch) || patch.length === 0 || files === null ||
      files.length !== paths.length || files.some((path, index) => path !== paths[index]) ||
      !SHA256_PATTERN.test(collected.sha256 ?? '') || collected.sha256 !== sha256(patch) || collected.empty === true) {
    return noDelta('ambiguous', 'test_delta_collection_mismatch');
  }
  return { status: 'separable', patch, sha256: collected.sha256, paths, reasonCodes: [] };
}

function validClassified(value, record) {
  const witnesses = sortedStrings(value?.witnessIds);
  const failures = sortedStrings(value?.failureFingerprints);
  if (!exactKeys(value, CLASSIFIED_KEYS) || value.planFingerprint !== record.testPlanFingerprint ||
      value.environmentFingerprint !== record.environmentFingerprint ||
      !['completed', 'not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(value.execution) ||
      !['pass', 'fail', 'unknown'].includes(value.outcome) ||
      !['assertion', 'collection', 'compile', 'dependency', 'infrastructure', 'unknown'].includes(value.failureKind) ||
      value.stability !== 'unknown' || typeof value.reproduction !== 'boolean' ||
      witnesses === null || failures === null || witnesses.length > 20_000 || failures.length > 20_000 ||
      witnesses.some((id) => !SHA256_PATTERN.test(id)) || failures.some((id) => !SHA256_PATTERN.test(id)) ||
      !(value.outputSha256 === null || SHA256_PATTERN.test(value.outputSha256)) ||
      !Number.isSafeInteger(value.outputChars) || value.outputChars < 0 || typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.diagnostics) || value.diagnostics.length > 8 ||
      value.diagnostics.some((item) => typeof item !== 'string' || !/^[a-z0-9_]{1,64}$/.test(item))) return false;
  return true;
}

function validateEvidenceGroups(input, deltaSha) {
  const groups = [
    ['b0', input.b0],
    ['br', input.br],
    ['c', input.candidate],
  ];
  const all = [];
  const ids = new Set();
  let authority = null;
  for (const [kind, records] of groups) {
    if (!Array.isArray(records) || records.length !== 2) return null;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!exactKeys(record, EVIDENCE_KEYS) || record.schemaVersion !== 1 || record.kind !== kind ||
          record.repetition !== index + 1 || typeof record.evidenceId !== 'string' || record.evidenceId === '' ||
          typeof record.attemptId !== 'string' || record.attemptId === '' ||
          !OBJECT_ID_PATTERN.test(record.baselineRevision) || !OBJECT_ID_PATTERN.test(record.baselineTree) ||
          !OBJECT_ID_PATTERN.test(record.candidateRevision) || !OBJECT_ID_PATTERN.test(record.candidateTree) ||
          !SHA256_PATTERN.test(record.candidatePatchSha256) || !SHA256_PATTERN.test(record.testPlanFingerprint) ||
          !SHA256_PATTERN.test(record.environmentFingerprint) ||
          record.testDeltaSha256 !== (kind === 'b0' ? null : deltaSha) || !validClassified(record.classified, record) ||
          ids.has(record.evidenceId)) return null;
      ids.add(record.evidenceId);
      const current = [
        record.attemptId,
        record.baselineRevision,
        record.baselineTree,
        record.candidateRevision,
        record.candidateTree,
        record.candidatePatchSha256,
        record.testPlanFingerprint,
        record.environmentFingerprint,
      ];
      if (authority === null) authority = current;
      else if (current.some((value, position) => value !== authority[position])) return null;
      all.push(record);
    }
  }
  return { all, groups: Object.fromEntries(groups) };
}

function stableSignature(record) {
  const fact = record.classified;
  return JSON.stringify({
    execution: fact.execution,
    outcome: fact.outcome,
    failureKind: fact.failureKind,
    reproduction: fact.reproduction,
    witnessIds: sortedStrings(fact.witnessIds),
    failureFingerprints: sortedStrings(fact.failureFingerprints),
    diagnostics: sortedStrings(fact.diagnostics),
  });
}

function sameStrings(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validatedCompanion(value, record) {
  const witnesses = sortedStrings(value?.witnessIds);
  const assertions = sortedStrings(value?.assertionWitnessIds);
  if (!exactKeys(value, COMPANION_KEYS) || witnesses === null || assertions === null ||
      witnesses.length !== value.witnessIds.length || assertions.length !== value.assertionWitnessIds.length ||
      !sameStrings(witnesses, value.witnessIds) || !sameStrings(assertions, value.assertionWitnessIds) ||
      witnesses.some((id) => !SHA256_PATTERN.test(id)) || assertions.some((id) => !SHA256_PATTERN.test(id))) return null;
  const publicWitnesses = new Set(record.classified.witnessIds);
  const publicFailures = new Set(record.classified.failureFingerprints);
  if (witnesses.some((id) => !publicWitnesses.has(id)) || assertions.some((id) =>
    !witnesses.includes(id) || !publicFailures.has(sha256(Buffer.from(`assertion\0${id}`, 'utf8')))) ||
    record.classified.outcome === 'pass' && assertions.length > 0) return null;
  return { witnessIds: witnesses, assertionWitnessIds: assertions };
}

function validatedCompanions(values, records) {
  if (!Array.isArray(values) || values.length !== records.length) return null;
  const validated = values.map((value, index) => validatedCompanion(value, records[index]));
  return validated.some((value) => value === null) ? null : validated;
}

function unavailableReason(records) {
  const diagnostics = records.flatMap((record) => record.classified.diagnostics);
  for (const code of [
    'environment_fingerprint_drift',
    'executable_identity_drift',
    'launcher_identity_drift',
    'test_command_unavailable',
    'test_delta_apply_failed',
    'test_queue_poisoned',
    'deadline_expired',
  ]) {
    if (diagnostics.includes(code)) return code;
  }
  if (records.some((record) => record.classified.failureKind === 'dependency')) return 'test_dependency_unavailable';
  if (records.some((record) => ['not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering']
    .includes(record.classified.execution))) return 'test_execution_unavailable';
  return null;
}

/** Validate authority and apply the pure two-repetition B0/BR/C decision matrix. */
export function completeRegressionProof(input = {}) {
  const required = input?.required === true;
  if (!required) return result(false, 'not_applicable', false);
  const delta = input?.testDelta;
  if (!delta || typeof delta !== 'object') return result(true, 'unavailable', false, [], ['test_delta_unavailable']);
  if (delta.status !== 'separable') {
    const reasons = Array.isArray(delta.reasonCodes) && delta.reasonCodes.length > 0
      ? delta.reasonCodes.filter((code) => typeof code === 'string')
      : ['test_delta_unavailable'];
    const repairable = delta.status === 'empty' || delta.status === 'deletion_only';
    return result(true, repairable ? 'not_proven' : 'unavailable', repairable, [], reasons);
  }
  if (!Buffer.isBuffer(delta.patch) || !SHA256_PATTERN.test(delta.sha256 ?? '') || sha256(delta.patch) !== delta.sha256 ||
      !Array.isArray(delta.paths) || delta.paths.length === 0 || !Array.isArray(delta.reasonCodes) || delta.reasonCodes.length !== 0) {
    return result(true, 'unavailable', false, [], ['test_delta_authority_mismatch']);
  }
  const validated = validateEvidenceGroups(input, delta.sha256);
  if (validated === null) return result(true, 'unavailable', false, [], ['evidence_authority_mismatch']);
  const evidenceIds = validated.all.map((record) => record.evidenceId);
  const { b0, br, c } = validated.groups;
  if ([b0, br, c].some((records) => stableSignature(records[0]) !== stableSignature(records[1]))) {
    return result(true, 'flaky', false, evidenceIds, ['unstable_test_evidence']);
  }

  const b0Unavailable = unavailableReason(b0);
  if (b0Unavailable !== null) return result(true, 'unavailable', false, evidenceIds, [b0Unavailable]);
  if (b0.some((record) => record.classified.execution !== 'completed' || record.classified.outcome !== 'pass')) {
    return result(true, 'not_proven', false, evidenceIds, ['baseline_not_green']);
  }

  const brUnavailable = unavailableReason(br);
  if (brUnavailable !== null) return result(true, 'unavailable', false, evidenceIds, [brUnavailable]);
  if (br.every((record) => record.classified.execution === 'completed' && record.classified.outcome === 'pass')) {
    return result(true, 'not_proven', true, evidenceIds, ['regression_test_did_not_fail']);
  }
  if (br.some((record) => record.classified.failureKind === 'collection')) {
    return result(true, 'not_proven', true, evidenceIds, ['regression_collection_failed']);
  }
  if (br.some((record) => record.classified.execution !== 'completed' || record.classified.outcome !== 'fail' ||
      record.classified.failureKind !== 'assertion' || record.classified.reproduction !== true)) {
    return result(true, 'not_proven', true, evidenceIds, ['regression_witness_missing']);
  }
  const brCompanions = validatedCompanions(input.brCompanions, br);
  if (brCompanions === null || brCompanions.some((value) => value.assertionWitnessIds.length === 0)) {
    return result(true, 'not_proven', true, evidenceIds, ['regression_witness_missing']);
  }
  const targetWitnesses = brCompanions[0].assertionWitnessIds;
  if (!sameStrings(targetWitnesses, brCompanions[1].assertionWitnessIds)) {
    return result(true, 'flaky', false, evidenceIds, ['unstable_test_evidence']);
  }

  const cUnavailable = unavailableReason(c);
  if (cUnavailable !== null) return result(true, 'unavailable', false, evidenceIds, [cUnavailable]);
  if (c.some((record) => record.classified.execution !== 'completed' || record.classified.outcome !== 'pass')) {
    return result(true, 'not_proven', true, evidenceIds, ['candidate_tests_failed']);
  }
  const candidateCompanions = validatedCompanions(input.candidateCompanions, c);
  if (candidateCompanions === null || candidateCompanions.some((value) =>
    targetWitnesses.some((id) => !value.witnessIds.includes(id)))) {
    return result(true, 'not_proven', true, evidenceIds, ['candidate_witness_missing']);
  }
  return result(true, 'proved', false, evidenceIds, [], targetWitnesses);
}

function queueError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** One process-wide FIFO boundary for resource-heavy test execution. */
export function createSerialTestQueue({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  let tail = Promise.resolve();
  let poisonReason = null;
  let active = 0;
  const queue = {
    enqueue(start, options = {}) {
      if (typeof start !== 'function') return Promise.reject(queueError('invalid_test_start'));
      const current = tail.then(async () => {
        if (poisonReason !== null) throw queueError('test_queue_poisoned');
        const deadlineAt = options?.deadlineAt;
        if (deadlineAt !== undefined && deadlineAt !== null &&
            (!Number.isFinite(deadlineAt) || now() >= deadlineAt)) {
          poisonReason = 'deadline_expired';
          throw queueError('deadline_expired');
        }
        active += 1;
        try {
          const value = await start();
          const execution = value?.execution ?? value?.classified?.execution;
          if (execution === 'hung' || execution === 'lingering') {
            poisonReason = 'test_process_cleanup_unproven';
          }
          if (value?.cleanupProven === false) poisonReason = 'test_process_cleanup_unproven';
          return value;
        } finally {
          active -= 1;
        }
      });
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
    poison(reason) {
      poisonReason = typeof reason === 'string' && reason !== '' ? reason : 'test_queue_poisoned';
    },
    markCleanupProven() {
      if (active === 0 && poisonReason === 'test_process_cleanup_unproven') poisonReason = null;
    },
    isPoisoned() {
      return poisonReason !== null;
    },
  };
  return Object.freeze(queue);
}

function sameExecutable(a, b) {
  return a !== null && b !== null && a.basename === b.basename && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function cloneClassified(value, plan) {
  // ★★ `ranWithUserPrivilege` 는 **후보에 대한 증거가 아니다** — 우리 실행에 대한 사실이다(설계
  //   §5.8 S1). 봉투 신고로만 나가야지 불변 증거 아티팩트에 들어가서는 안 된다. 여기서 벗겨야
  //   `validClassified` 의 정확일치 관문을 느슨하게 만들지 않고도 그 사실을 엔진까지 나를 수 있다.
  //   (그냥 통과시키면 실행이 `evidence_unavailable` 로 죽는다 — 실측으로 그렇게 붉어졌다.)
  const { ranWithUserPrivilege: _runLevelFact, ...classifiedOnly } = value ?? {};
  value = value === null || typeof value !== 'object' ? value : classifiedOnly;
  const record = {
    schemaVersion: 1,
    evidenceId: 'validation-only',
    attemptId: 'validation-only',
    kind: 'c',
    repetition: 1,
    baselineRevision: '0'.repeat(40),
    baselineTree: '0'.repeat(40),
    candidateRevision: '0'.repeat(40),
    candidateTree: '0'.repeat(40),
    candidatePatchSha256: '0'.repeat(64),
    testPlanFingerprint: plan?.planFingerprint,
    environmentFingerprint: plan?.environmentFingerprint,
    testDeltaSha256: null,
  };
  if (!validClassified(value, record)) return null;
  const clone = {
    execution: value.execution,
    outcome: value.outcome,
    failureKind: value.failureKind,
    stability: value.stability,
    reproduction: value.reproduction,
    witnessIds: Object.freeze(sortedStrings(value.witnessIds)),
    failureFingerprints: Object.freeze(sortedStrings(value.failureFingerprints)),
    outputSha256: value.outputSha256,
    outputChars: value.outputChars,
    planFingerprint: value.planFingerprint,
    environmentFingerprint: value.environmentFingerprint,
    truncated: value.truncated,
    diagnostics: Object.freeze(sortedStrings(value.diagnostics)),
  };
  return Object.freeze(clone);
}

function cloneCacheCell(value, plan) {
  if (!exactKeys(value, CACHE_CELL_KEYS) || !Object.isFrozen(value) ||
      !Object.isFrozen(value.classified) || !Object.isFrozen(value.deltaWitnessIds) ||
      !Object.isFrozen(value.deltaAssertionWitnessIds)) return null;
  const classified = cloneClassified(value.classified, plan);
  const deltaWitnessIds = sortedStrings(value.deltaWitnessIds);
  const deltaAssertionWitnessIds = sortedStrings(value.deltaAssertionWitnessIds);
  if (classified === null || deltaWitnessIds === null || deltaAssertionWitnessIds === null ||
      deltaWitnessIds.length !== value.deltaWitnessIds.length ||
      deltaAssertionWitnessIds.length !== value.deltaAssertionWitnessIds.length ||
      !sameStrings(deltaWitnessIds, value.deltaWitnessIds) ||
      !sameStrings(deltaAssertionWitnessIds, value.deltaAssertionWitnessIds) ||
      deltaWitnessIds.some((id) => !SHA256_PATTERN.test(id) || !classified.witnessIds.includes(id)) ||
      deltaAssertionWitnessIds.some((id) => !deltaWitnessIds.includes(id) ||
        !classified.failureFingerprints.includes(sha256(Buffer.from(`assertion\0${id}`, 'utf8')))) ||
      classified.outcome === 'pass' && deltaAssertionWitnessIds.length > 0) return null;
  return Object.freeze({
    classified,
    deltaWitnessIds: Object.freeze(deltaWitnessIds),
    deltaAssertionWitnessIds: Object.freeze(deltaAssertionWitnessIds),
  });
}

function createCacheCell(raw, plan, projection) {
  if (!projection || !exactKeys(projection, COMPANION_KEYS)) return null;
  const classified = cloneClassified(raw, plan);
  const deltaWitnessIds = sortedStrings(projection.witnessIds);
  const deltaAssertionWitnessIds = sortedStrings(projection.assertionWitnessIds);
  if (classified === null || deltaWitnessIds === null || deltaAssertionWitnessIds === null) return null;
  return cloneCacheCell(Object.freeze({
    classified,
    deltaWitnessIds: Object.freeze(deltaWitnessIds),
    deltaAssertionWitnessIds: Object.freeze(deltaAssertionWitnessIds),
  }), plan);
}

function companionFromCell(cell) {
  return Object.freeze({
    witnessIds: Object.freeze([...cell.deltaWitnessIds]),
    assertionWitnessIds: Object.freeze([...cell.deltaAssertionWitnessIds]),
  });
}

function attemptOrdinal(spec) {
  const prefix = `${spec.runId}/${spec.laneId}/`;
  if (typeof spec.attemptId !== 'string' || !spec.attemptId.startsWith(prefix)) return null;
  const ordinal = spec.attemptId.slice(prefix.length);
  return /^\d{3}$/.test(ordinal) ? ordinal : null;
}

function validEvidenceSpec(spec) {
  return spec && typeof spec === 'object' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(spec.runId ?? '') &&
    ['lane-a', 'lane-b'].includes(spec.laneId) && attemptOrdinal(spec) !== null &&
    OBJECT_ID_PATTERN.test(spec.baseline?.commit ?? '') && OBJECT_ID_PATTERN.test(spec.baseline?.tree ?? '') &&
    OBJECT_ID_PATTERN.test(spec.candidate?.commit ?? '') && OBJECT_ID_PATTERN.test(spec.candidate?.treeHash ?? '') &&
    SHA256_PATTERN.test(spec.candidate?.patchSha256 ?? '') && spec.candidate?.testPlanFingerprint === spec.frozenTestPlan?.planFingerprint &&
    SHA256_PATTERN.test(spec.frozenTestPlan?.planFingerprint ?? '') &&
    SHA256_PATTERN.test(spec.frozenTestPlan?.environmentFingerprint ?? '') &&
    spec.proofRequirement && typeof spec.proofRequirement.required === 'boolean' &&
    spec.testQueue && typeof spec.testQueue.enqueue === 'function' && typeof spec.testQueue.poison === 'function' &&
    typeof spec.testQueue.isPoisoned === 'function' && spec.cache instanceof Map &&
    (spec.deadlineAt === null || Number.isFinite(spec.deadlineAt));
}

function evidenceId(spec, kind, repetition) {
  return `${spec.attemptId}/${kind.toUpperCase()}/${repetition}`;
}

function evidenceRecord(spec, kind, repetition, fact) {
  const record = {
    schemaVersion: 1,
    evidenceId: evidenceId(spec, kind, repetition),
    attemptId: spec.attemptId,
    kind,
    repetition,
    baselineRevision: spec.baseline.commit,
    baselineTree: spec.baseline.tree,
    candidateRevision: spec.candidate.commit,
    candidateTree: spec.candidate.treeHash,
    candidatePatchSha256: spec.candidate.patchSha256,
    testPlanFingerprint: spec.frozenTestPlan.planFingerprint,
    environmentFingerprint: spec.frozenTestPlan.environmentFingerprint,
    testDeltaSha256: kind === 'b0' ? null : spec.testDelta?.status === 'separable' ? spec.testDelta.sha256 : null,
    classified: fact,
  };
  return Object.freeze(record);
}

function cacheKey(spec, kind) {
  const base = [kind, spec.baseline.tree, spec.frozenTestPlan.planFingerprint, spec.frozenTestPlan.environmentFingerprint];
  if (kind === 'br') base.push(spec.testDelta.sha256);
  return JSON.stringify(base);
}

function unavailableTests() {
  return {
    execution: 'not_run',
    outcome: 'unknown',
    stability: 'unknown',
    complete: false,
    failureFingerprints: [],
    trusted: false,
  };
}

function candidateTests(records) {
  if (records.length === 0) return unavailableTests();
  const facts = records.map((record) => record.classified);
  const stable = facts.length === 2 && stableSignature(records[0]) === stableSignature(records[1]);
  const outcomes = new Set(facts.map((fact) => fact.outcome));
  return {
    execution: facts.every((fact) => fact.execution === 'completed') ? 'completed' : facts.at(-1).execution,
    outcome: outcomes.size === 1 ? facts[0].outcome : 'unknown',
    stability: facts.length === 1 ? 'unknown' : stable ? 'stable' : 'flaky',
    complete: facts.every((fact) => fact.execution === 'completed' && fact.outputSha256 !== null && fact.truncated === false),
    failureFingerprints: [...new Set(facts.flatMap((fact) => fact.failureFingerprints))].sort(),
    trusted: facts.every((fact) => fact.planFingerprint === records[0].testPlanFingerprint &&
      fact.environmentFingerprint === records[0].environmentFingerprint && fact.outputSha256 !== null),
  };
}

async function awaitDeadlineSink(start, { deadlineAt, now, setTimer, clearTimer, transfer = false }) {
  const controller = new AbortController();
  const authority = Object.freeze({ deadlineAt, signal: controller.signal });
  if (deadlineAt !== null && now() >= deadlineAt) {
    controller.abort();
    return { status: 'deadline', authority, started: false };
  }
  let operation;
  try {
    operation = Promise.resolve(start(authority));
  } catch {
    return { status: 'failed', authority, started: true };
  }
  const settled = operation.then(
    (value) => ({ status: 'value', value }),
    () => ({ status: 'failed' }),
  );
  if (deadlineAt === null) return { ...(await settled), authority, started: true };
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    controller.abort();
    return { status: 'deadline', authority, started: true };
  }
  let timer = null;
  let deadline;
  try {
    deadline = new Promise((resolve) => {
      timer = setTimer(() => {
        controller.abort();
        resolve({ status: 'deadline' });
      }, remaining);
      timer?.unref?.();
    });
  } catch {
    controller.abort();
    return { status: 'failed', authority, started: true };
  }
  const outcome = await Promise.race([settled, deadline]);
  try { clearTimer(timer); } catch { /* a failed timer cleanup cannot restore sink authority */ }
  return { ...outcome, authority, started: true };
}

async function defaultKillTrackedChildren({ children }) {
  let proven = true;
  for (const child of children) {
    if (child?.exitCode !== null && child?.exitCode !== undefined || child?.signalCode !== null && child?.signalCode !== undefined) continue;
    try { child?.kill?.(); } catch { /* keep the conservative result below */ }
    if (child?.exitCode === null || child?.exitCode === undefined) proven = false;
  }
  return proven;
}

function cleanupOutcome(spec, record, worktree, status) {
  return Object.freeze({
    kind: 'evidence',
    candidateId: spec.laneId,
    attemptId: spec.attemptId,
    evidenceId: record.evidenceId,
    path: worktree.path,
    status,
    recoveryPath: status === 'reaper_pending' ? worktree.path : null,
  });
}

function operationalFailure(code) {
  const allowed = new Set([
    'evidence_persistence_failed',
    'evidence_authority_mismatch',
    'evidence_cleanup_unproven',
    'deadline_expired',
    'test_process_cleanup_unproven',
  ]);
  return allowed.has(code) ? Object.freeze({ code }) : null;
}

function candidateEvidenceResult(tests, regressionProof, evidence, cleanup, reason = null) {
  return Object.freeze({
    tests,
    regressionProof,
    evidence: Object.freeze([...evidence].sort((a, b) => a.evidenceOrdinal - b.evidenceOrdinal)),
    cleanup: Object.freeze([...cleanup]),
    operationalFailure: operationalFailure(reason),
  });
}

function proofUnavailable(required, records, reasonCode) {
  return result(required, required ? 'unavailable' : 'not_applicable', false,
    records.map((record) => record.evidenceId), required ? [reasonCode] : [], []);
}

function initialFailureProof(spec, candidateRecords, reasonCode) {
  const required = spec.proofRequirement.required === true;
  if (!required) return result(false, 'not_applicable', false, candidateRecords.map((record) => record.evidenceId));
  return result(true, 'not_proven', true, candidateRecords.map((record) => record.evidenceId), [reasonCode]);
}

/** Orchestrate bounded, revision-bound evidence without persisting raw output or binary patch bytes. */
export async function runCandidateEvidence(spec, deps = {}) {
  if (!validEvidenceSpec(spec)) {
    return candidateEvidenceResult(
      unavailableTests(),
      proofUnavailable(true, [], 'invalid_evidence_spec'),
      [],
      [],
      'evidence_authority_mismatch',
    );
  }
  const createWorktree = deps.createRevisionWorktree ?? createRevisionWorktree;
  const applyPatch = deps.applyPatchBytes ?? applyPatchBytes;
  const identifyRevision = deps.revisionIdentity ?? revisionIdentity;
  const runTests = deps.runFrozenTests ?? runFrozenTests;
  const remove = deps.removeWorktree ?? removeWorktree;
  const killChildren = deps.killTrackedChildren ?? defaultKillTrackedChildren;
  const inspectEnvironment = deps.checkFrozenEnvironment ?? ((input) =>
    checkFrozenTestPlanEnvironment(input.plan, deps.runnerDeps ?? {}));
  const selectWitnesses = deps.selectTestDeltaWitnesses ?? selectTestDeltaWitnesses;
  const persist = typeof deps.persistEvidence === 'function' ? deps.persistEvidence : async () => ({ blocked: true });
  const handoffCleanup = typeof deps.handoffEvidenceCleanup === 'function'
    ? deps.handoffEvidenceCleanup
    : async () => false;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout;
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout;
  const recoveryGraceMs = Number.isSafeInteger(deps.recoveryGraceMs) && deps.recoveryGraceMs > 0
    ? deps.recoveryGraceMs : 10_000;
  const recoveryDeadlineAt = () => {
    const value = now() + recoveryGraceMs;
    return Number.isSafeInteger(value) ? value : null;
  };
  const sourceWorktree = deps.sourceWorktree ?? spec.sourceWorktree;
  const stateRoot = deps.stateRoot ?? sourceWorktree?.stateRoot;
  const ordinal = attemptOrdinal(spec);
  const records = [];
  const evidence = [];
  const candidate = [];
  const b0 = [];
  const br = [];
  const candidateCompanions = [];
  const brCompanions = [];
  const cleanup = [];
  let operationalReason = INVALID_EVIDENCE_CACHES.get(spec.cache) ?? null;
  let persistenceFailed = false;
  const committedRecords = () => evidence.map((entry) => entry.record);

  const checkEnvironment = async (phase, kind, repetition) => {
    if (operationalReason !== null) return false;
    if (spec.deadlineAt !== null && now() >= spec.deadlineAt) {
      operationalReason = 'deadline_expired';
      spec.testQueue.poison('deadline_expired');
      return false;
    }
    let checked;
    try {
      checked = await inspectEnvironment({ plan: spec.frozenTestPlan, phase, kind, repetition });
    } catch {
      checked = { ok: false, reasonCode: 'environment_fingerprint_drift' };
    }
    if (checked?.ok !== true || !sameExecutable(checked.executable, spec.frozenTestPlan.executable) ||
        checked.environmentFingerprint !== spec.frozenTestPlan.environmentFingerprint) {
      operationalReason = typeof checked?.reasonCode === 'string' ? checked.reasonCode : 'environment_fingerprint_drift';
      INVALID_EVIDENCE_CACHES.set(spec.cache, operationalReason);
      return false;
    }
    return true;
  };

  const persistRecord = async (record, cell) => {
    records.push(record);
    if (record.kind === 'c') {
      candidate.push(record);
      candidateCompanions.push(companionFromCell(cell));
    }
    else if (record.kind === 'b0') b0.push(record);
    else {
      br.push(record);
      brCompanions.push(companionFromCell(cell));
    }
    const evidenceOrdinal = records.length;
    const persisted = await awaitDeadlineSink(
      (authority) => persist({
        laneId: spec.laneId,
        attemptOrdinal: Number(ordinal),
        evidenceOrdinal,
        record,
      }, authority),
      { deadlineAt: recoveryDeadlineAt(), now, setTimer, clearTimer },
    );
    if (persisted.status === 'deadline' || persisted.deadlineExpired === true) {
      persistenceFailed = true;
      operationalReason = 'deadline_expired';
      spec.testQueue.poison('deadline_expired');
    }
    if (persisted.status !== 'value' || persisted.value?.ok !== true ||
        persisted.value.ref?.kind !== 'evidence' || persisted.value.ref.candidateId !== spec.laneId) {
      persistenceFailed = true;
      if (operationalReason === null) operationalReason = 'evidence_persistence_failed';
    } else {
      evidence.push(Object.freeze({ evidenceOrdinal, record, ref: persisted.value.ref }));
    }
  };

  const runFresh = async (kind, repetition) => {
    const id = evidenceId(spec, kind, repetition);
    const purpose = `${spec.laneId}-${ordinal}-${kind}-${repetition}`;
    const revision = kind === 'c' ? spec.candidate.commit : spec.baseline.commit;
    let worktree = null;
    let record = null;
    const children = new Set();
    const childTracks = [];
    let cleanupProven = true;
    try {
      worktree = await createWorktree({
        sourceWorktree,
        stateRoot,
        runId: spec.runId,
        purpose,
        revision,
      });
      if (worktree?.ok !== true) throw queueError('evidence_worktree_unavailable');
      if (kind === 'c' && worktree.lastSnapshot !== spec.candidate.commit ||
          kind !== 'c' && worktree.lastSnapshot !== spec.baseline.commit) {
        throw queueError('evidence_revision_mismatch');
      }
      const identity = await identifyRevision(worktree, revision);
      const expectedTree = kind === 'c' ? spec.candidate.treeHash : spec.baseline.tree;
      if (identity?.ok !== true || identity.commit !== revision || identity.tree !== expectedTree) {
        throw queueError('evidence_revision_mismatch');
      }
      if (kind === 'br') {
        if (!Buffer.isBuffer(spec.testDelta.patch) || sha256(spec.testDelta.patch) !== spec.testDelta.sha256) {
          throw queueError('test_delta_authority_mismatch');
        }
        const applied = await applyPatch(worktree, { patch: spec.testDelta.patch, sha256: spec.testDelta.sha256 });
        if (applied?.ok !== true) throw queueError('test_delta_apply_failed');
      }
      if (!(await checkEnvironment('before_spawn', kind, repetition))) throw queueError(operationalReason);
      if (spec.deadlineAt !== null && now() >= spec.deadlineAt) {
        operationalReason = 'deadline_expired';
        spec.testQueue.poison('deadline_expired');
        throw queueError('deadline_expired');
      }
      const timeoutMs = spec.deadlineAt === null ? undefined : Math.max(1, spec.deadlineAt - now());
      const raw = await runTests({
        worktree,
        plan: spec.frozenTestPlan,
        mode: kind,
        runId: spec.runId,
        timeoutMs,
        onSpawn: (child) => {
          if (child && typeof child === 'object') {
            children.add(child);
            try { childTracks.push(Promise.resolve(deps.onSpawn?.(child, { evidenceId: id, worktree }))); } catch { childTracks.push(Promise.resolve(false)); }
          }
        },
      }, { ...(deps.runnerDeps ?? {}), testQueue: spec.testQueue });
      let projection;
      try {
        projection = selectWitnesses(raw, kind === 'b0' ? [] : spec.testDelta.paths);
      } catch {
        projection = null;
      }
      const cell = createCacheCell(raw, spec.frozenTestPlan, projection);
      if (cell === null) throw queueError('classified_test_record_invalid');
      record = evidenceRecord(spec, kind, repetition, cell.classified);
      await persistRecord(record, cell);
      if (cell.classified.execution === 'hung' || cell.classified.execution === 'lingering') {
        operationalReason = 'test_process_cleanup_unproven';
        spec.testQueue.poison('test_process_cleanup_unproven');
      }
      return cell;
    } finally {
      if (worktree?.ok === true) {
        const tracked = await Promise.allSettled(childTracks);
        if (tracked.some((entry) => entry.status !== 'fulfilled' || entry.value !== true)) {
          operationalReason = 'test_process_cleanup_unproven';
        }
        let childrenProven = false;
        let removed = null;
        const killed = await awaitDeadlineSink(
          (authority) => killChildren({
            children: [...children],
            evidenceId: id,
            worktreeId: worktree.worktreeId,
            deadlineAt: authority.deadlineAt,
            signal: authority.signal,
          }),
          { deadlineAt: recoveryDeadlineAt(), now, setTimer, clearTimer },
        );
        childrenProven = killed.status === 'value' && killed.value === true;
        let cleanupDeadlineExpired = killed.status === 'deadline' || killed.deadlineExpired === true;
        if (childrenProven) {
          const removedResult = await awaitDeadlineSink(
            (authority) => remove(worktree, authority),
            { deadlineAt: recoveryDeadlineAt(), now, setTimer, clearTimer },
          );
          removed = removedResult.status === 'value' ? removedResult.value : null;
          cleanupDeadlineExpired = cleanupDeadlineExpired || removedResult.status === 'deadline' ||
            removedResult.deadlineExpired === true;
        }
        cleanupProven = childrenProven === true && removed?.ok === true && removed.removed === true && removed.unregistered === true;
        if (!cleanupProven) {
          const noticeRecord = record ?? { evidenceId: id };
          let ownershipTransferred = false;
          if (!cleanupDeadlineExpired) {
            const handedOff = await awaitDeadlineSink(
              (authority) => handoffCleanup({
                kind: 'evidence',
                candidateId: spec.laneId,
                attemptId: spec.attemptId,
                evidenceId: noticeRecord.evidenceId,
                path: worktree.path,
              }, authority),
              { deadlineAt: recoveryDeadlineAt(), now, setTimer, clearTimer, transfer: true },
            );
            ownershipTransferred = handedOff.status === 'value' && handedOff.value === true;
          }
          if (ownershipTransferred) cleanup.push(cleanupOutcome(spec, noticeRecord, worktree, 'reaper_pending'));
          if (cleanupDeadlineExpired) operationalReason = 'deadline_expired';
          else if (!ownershipTransferred) operationalReason = 'evidence_cleanup_unproven';
          else if (operationalReason === null) operationalReason = 'test_process_cleanup_unproven';
          spec.testQueue.poison('test_process_cleanup_unproven');
        } else {
          cleanup.push(cleanupOutcome(spec, record ?? { evidenceId: id }, worktree, 'removed'));
        }
      }
    }
  };

  const runOne = async (kind, repetition, cacheable) => {
    if (operationalReason !== null || spec.testQueue.isPoisoned()) {
      if (operationalReason === null) operationalReason = 'test_queue_poisoned';
      return null;
    }
    let key = null;
    let promise = null;
    let producer = true;
    if (cacheable) {
      if (!(await checkEnvironment('before_cache_lookup', kind, repetition))) return null;
      key = cacheKey(spec, kind);
      let slots = spec.cache.get(key) ?? null;
      if (slots !== null && (!Array.isArray(slots) || slots.length > 2 ||
          slots.some((slot) => slot !== undefined && (slot === null || typeof slot.then !== 'function')))) {
        operationalReason = 'invalid_test_cache_entry';
        INVALID_EVIDENCE_CACHES.set(spec.cache, operationalReason);
        return null;
      }
      if (slots === null) {
        slots = [];
        spec.cache.set(key, slots);
      }
      promise = slots[repetition - 1] ?? null;
      producer = promise === null;
      if (producer) {
        promise = spec.testQueue.enqueue(() => runFresh(kind, repetition), { deadlineAt: spec.deadlineAt });
        slots[repetition - 1] = promise;
      }
    } else {
      promise = spec.testQueue.enqueue(() => runFresh(kind, repetition), { deadlineAt: spec.deadlineAt });
    }
    try {
      const cell = cloneCacheCell(await promise, spec.frozenTestPlan);
      if (cell === null) throw queueError('invalid_test_cache_entry');
      if (!producer) await persistRecord(evidenceRecord(spec, kind, repetition, cell.classified), cell);
      if (persistenceFailed) return null;
      return cell.classified;
    } catch (error) {
      if (cacheable && producer) {
        const slots = spec.cache.get(key);
        if (Array.isArray(slots) && slots[repetition - 1] === promise) {
          delete slots[repetition - 1];
          if (slots.every((slot) => slot === undefined)) spec.cache.delete(key);
        }
      }
      operationalReason = typeof error?.code === 'string' ? error.code : 'test_execution_unavailable';
      if (['environment_fingerprint_drift', 'executable_identity_drift', 'launcher_identity_drift'].includes(operationalReason)) {
        INVALID_EVIDENCE_CACHES.set(spec.cache, operationalReason);
      }
      return null;
    }
  };

  const c1 = await runOne('c', 1, false);
  if (c1 === null) {
    return candidateEvidenceResult(
      candidateTests(candidate),
      proofUnavailable(spec.proofRequirement.required, committedRecords(), operationalReason ?? 'test_execution_unavailable'),
      evidence,
      cleanup,
      operationalReason,
    );
  }
  if (operationalReason !== null) {
    return candidateEvidenceResult(
      candidateTests(candidate),
      proofUnavailable(spec.proofRequirement.required, committedRecords(), operationalReason),
      evidence,
      cleanup,
      operationalReason,
    );
  }
  if (c1.execution !== 'completed' || c1.outcome !== 'pass') {
    return candidateEvidenceResult(
      candidateTests(candidate),
      initialFailureProof(spec, candidate, 'candidate_tests_failed'),
      evidence,
      cleanup,
      operationalReason,
    );
  }

  const prove = spec.proofRequirement.required === true && spec.testDelta?.status === 'separable';
  if (prove) {
    for (const kind of ['b0', 'br']) {
      for (const repetition of [1, 2]) {
        if (await runOne(kind, repetition, true) === null) break;
      }
      if (operationalReason !== null) break;
    }
  }
  if (operationalReason === null) await runOne('c', 2, false);

  let regressionProof;
  if (operationalReason !== null || persistenceFailed) {
    regressionProof = proofUnavailable(
      spec.proofRequirement.required,
      committedRecords(),
      persistenceFailed && operationalReason !== 'deadline_expired'
        ? 'evidence_persistence_failed'
        : operationalReason,
    );
  } else {
    regressionProof = completeRegressionProof({
      required: spec.proofRequirement.required,
      testDelta: spec.testDelta,
      b0,
      br,
      candidate,
      brCompanions,
      candidateCompanions,
    });
  }
  return candidateEvidenceResult(
    candidateTests(candidate),
    regressionProof,
    evidence,
    cleanup,
    persistenceFailed ? 'evidence_persistence_failed' : operationalReason,
  );
}
