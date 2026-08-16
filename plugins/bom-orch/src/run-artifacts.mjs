import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod as fsChmod,
  link as fsLink,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  readdir as fsReaddir,
  realpath as fsRealpath,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32 as pathWin32,
} from 'node:path';

import { validateArtifactPathBudget } from './content-projection.mjs';

export const RUN_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_JSON_ARTIFACT_BYTES = 4_194_304;
export const MAX_RUN_MANIFEST_BYTES = 4_194_304;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GENERATION_PATTERN = /^[0-9a-f]{12}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ISSUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LANES = Object.freeze(['lane-a', 'lane-b']);
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'generation', 'runId', 'candidateCount', 'baseline', 'frozenTestPlan', 'proofRequirement',
  'plannerBinding', 'laneBindings', 'deadlineAt', 'createdAt', 'expiresAt', 'revision', 'appliedEvents',
  'pendingArtifacts', 'committedArtifacts', 'attempts', 'evidenceRefs', 'candidateRefs', 'verdictRefs',
  'usage', 'issueSummary', 'selection', 'winnerAlias', 'cleanup',
]);
const DEP_KEYS = new Set([
  'canonicalPath', 'lstat', 'readFile', 'nowMs', 'pid', 'randomHex12', 'securePath', 'mkdir', 'open', 'readdir',
  'unlink', 'syncDirectory', 'publishFileNoReplace', 'replaceFileAtomic', 'crashBarrier',
]);
const OWNER_VERIFY_DEP_KEYS = new Set([
  'canonicalPath', 'lstat', 'platform', 'resolveWindowsBinary', 'runCommand',
]);
const STORE_STATES = new WeakMap();

/**
 * Proves that a public store handle is backed by this module's private revision authority.
 * The predicate is intentionally total: hostile handles/authority objects fail closed.
 */
export function isRunArtifactStore(store, authority = {}) {
  try {
    const expected = exactObject(authority, ['stateRoot', 'runId', 'candidateCount']);
    if (expected === null) return false;
    const state = STORE_STATES.get(store);
    return state !== undefined && state.store === store &&
      state.stateRoot === expected.stateRoot && state.runId === expected.runId &&
      state.candidateCount === expected.candidateCount;
  } catch {
    return false;
  }
}

export function getRunArtifactStoreAuthority(store, authority = {}) {
  try {
    const expected = exactObject(authority, ['stateRoot', 'runId', 'candidateCount']);
    if (expected === null) return null;
    const state = STORE_STATES.get(store);
    if (state === undefined || state.store !== store ||
        state.stateRoot !== expected.stateRoot || state.runId !== expected.runId ||
        state.candidateCount !== expected.candidateCount) return null;
    return deepFreeze({ manifestRef: manifestRef(state, 0) });
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function blocked(error, recovery = 'Use a fresh runId after correcting the private artifact state.') {
  return deepFreeze({ blocked: true, error, recovery });
}

function exactObject(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== 'string') || keys.some((key) => !own.includes(key))) return null;
    const out = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

function exactDenseArray(value, max = Number.MAX_SAFE_INTEGER) {
  try {
    if (!Array.isArray(value) || value.length > max) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || own.at(-1) !== 'length' || own.some((key) => typeof key === 'symbol')) return null;
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
      out.push(descriptor.value);
    }
    return out;
  } catch {
    return null;
  }
}

function boundedString(value, max = 4_096, allowEmpty = false) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f\uFFFD]/.test(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validLane(value) {
  return LANES.includes(value);
}

function validOrdinal(value) {
  return Number.isInteger(value) && value >= 1 && value <= 999;
}

function ordinal(value) {
  return String(value).padStart(3, '0');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ownerPathIsAbsolute(path, platform) {
  return platform === 'win32' ? pathWin32.isAbsolute(path) : isAbsolute(path);
}

function ownerPathResolve(path, platform) {
  return platform === 'win32' ? pathWin32.resolve(path) : resolve(path);
}

function ownerSamePath(a, b, platform) {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function relativeJson(root, path) {
  if (!contained(root, path)) return null;
  return relative(root, path).split(sep).join('/');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonBytes(value) {
  try {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    return null;
  }
}

function normalizeUsage(value) {
  const object = exactObject(value, ['calls', 'promptTokensKnown', 'evalTokensKnown', 'incomplete']);
  if (object === null || !safeInteger(object.calls) || !safeInteger(object.promptTokensKnown) ||
      !safeInteger(object.evalTokensKnown) || typeof object.incomplete !== 'boolean') return null;
  return {
    calls: object.calls,
    promptTokensKnown: object.promptTokensKnown,
    evalTokensKnown: object.evalTokensKnown,
    incomplete: object.incomplete,
  };
}

function normalizeRoleBinding(value, requiredRole = null) {
  const object = exactObject(value, ['providerId', 'model', 'effort', 'tier', 'role']);
  if (object === null || !boundedString(object.providerId, 128) ||
      !(object.model === null || boundedString(object.model, 128)) ||
      !(object.effort === null || boundedString(object.effort, 64)) ||
      !['fast', 'strong'].includes(object.tier) ||
      !['planner', 'worker', 'verifier', 'thinker'].includes(object.role) ||
      requiredRole !== null && object.role !== requiredRole) return null;
  return {
    providerId: object.providerId,
    model: object.model,
    effort: object.effort,
    tier: object.tier,
    role: object.role,
  };
}

function normalizeLaneBinding(value) {
  const object = exactObject(value, ['writer', 'verifier']);
  const writer = normalizeRoleBinding(object?.writer, 'worker');
  const verifier = normalizeRoleBinding(object?.verifier, 'verifier');
  return object !== null && writer !== null && verifier !== null ? { writer, verifier } : null;
}

function normalizeInitialManifest(value, runId) {
  const object = exactObject(value, [
    'schemaVersion', 'runId', 'candidateCount', 'baseline', 'frozenTestPlan', 'proofRequirement',
    'plannerBinding', 'laneBindings', 'deadlineAt',
  ]);
  if (object === null || object.schemaVersion !== 1 || object.runId !== runId || ![1, 2].includes(object.candidateCount)) return null;
  const baseline = exactObject(object.baseline, ['commit', 'tree']);
  const plan = exactObject(object.frozenTestPlan, ['planFingerprint', 'environmentFingerprint']);
  const proof = exactObject(object.proofRequirement, ['required', 'reason']);
  const planner = normalizeRoleBinding(object.plannerBinding, 'planner');
  const laneEntries = exactDenseArray(object.laneBindings, 2);
  const reasons = ['explicit_bug_fix', 'explicit_non_bug', 'default_code_change', 'non_code_task'];
  if (baseline === null || !OBJECT_ID_PATTERN.test(baseline.commit) || !OBJECT_ID_PATTERN.test(baseline.tree) ||
      plan === null || !SHA256_PATTERN.test(plan.planFingerprint) || !SHA256_PATTERN.test(plan.environmentFingerprint) ||
      proof === null || typeof proof.required !== 'boolean' || !reasons.includes(proof.reason) || planner === null ||
      laneEntries === null || laneEntries.length !== object.candidateCount ||
      !(object.deadlineAt === null || safeInteger(object.deadlineAt))) return null;
  const lanes = [];
  for (let index = 0; index < laneEntries.length; index += 1) {
    const entry = exactObject(laneEntries[index], ['laneId', 'binding']);
    const binding = normalizeLaneBinding(entry?.binding);
    if (entry === null || entry.laneId !== LANES[index] || binding === null) return null;
    lanes.push({ laneId: entry.laneId, binding });
  }
  return {
    schemaVersion: 1,
    runId,
    candidateCount: object.candidateCount,
    baseline: { commit: baseline.commit, tree: baseline.tree },
    frozenTestPlan: { planFingerprint: plan.planFingerprint, environmentFingerprint: plan.environmentFingerprint },
    proofRequirement: { required: proof.required, reason: proof.reason },
    plannerBinding: planner,
    laneBindings: lanes,
    deadlineAt: object.deadlineAt,
  };
}

function randomHex12() {
  return randomBytes(6).toString('hex');
}

function execFileBounded(command, args) {
  return new Promise((resolveResult, reject) => {
    execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1_024,
      windowsVerbatimArguments: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolveResult({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseWhoamiIdentity(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) return null;
  const fields = [...lines[0].matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"'));
  return fields.length === 2 && boundedString(fields[0], 512) && /^S-1-(?:\d+-)+\d+$/.test(fields[1])
    ? { account: fields[0], sid: fields[1] }
    : null;
}

async function defaultWindowsBinary(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!boundedString(systemRoot, 4_096) || !isAbsolute(systemRoot)) throw new Error('missing system root');
  const path = join(systemRoot, 'System32', name);
  const info = await fsLstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid system binary');
  return path;
}

function ownerVerificationDeps(value = {}) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== 'string' || !OWNER_VERIFY_DEP_KEYS.has(key))) return null;
    const out = {};
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          (key === 'platform' ? typeof descriptor.value !== 'string' : typeof descriptor.value !== 'function')) return null;
      out[key] = descriptor.value;
    }
    const platform = out.platform ?? process.platform;
    if (!['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'posix', 'sunos', 'win32'].includes(platform)) return null;
    return {
      canonicalPath: out.canonicalPath ?? fsRealpath,
      lstat: out.lstat ?? fsLstat,
      platform,
      resolveWindowsBinary: out.resolveWindowsBinary ?? defaultWindowsBinary,
      runCommand: out.runCommand ?? execFileBounded,
      ownerIdentityPromise: null,
      binaryPromises: new Map(),
    };
  } catch {
    return null;
  }
}

/**
 * Read the principals `icacls <path>` granted, or `null` when the output cannot be trusted.
 *
 * ★★ icacls 의 마지막 요약 줄은 **호스트 UI 언어로 번역된다.** 예전 구현은 영어 문구
 *   (`Successfully processed 1 files; …`)로만 그 줄을 건너뛰었고, 한국어 Windows 에서는
 *   `1개의 파일을 처리했습니다. …` 가 ACE 줄로 읽혀 `:(` 가 없다는 이유로 파싱이 통째로
 *   실패했다. 그 결과 **모든 artifact 디렉터리가 "비공개 아님" 으로 판정돼 `orch_run` 이
 *   시작조차 못 했다** — 실측: 권한 부여는 성공해 `hgkim\hg:(OI)(CI)(F)` 하나만 남았는데도
 *   `verifyArtifactOwnerOnly` 가 false 를 냈고, 실행은 `artifact_base_directory_not_private`
 *   로 막혔다. 단위 테스트는 전부 영어 stdout 을 주입해서 이 자리를 못 봤다.
 *
 * ★ 그래서 언어가 아니라 **구조**로 거른다. ACE 줄은 어느 언어에서나 `<주체>:(<권한>)` 이고
 *   요약 줄은 그 모양이 아니며 항상 맨 끝에 온다. 그러므로 **마지막 한 줄에 한해서만**
 *   ACE 가 아닌 것을 허용한다. 중간에 낀 정체불명의 줄은 계속 거부한다 — 못 읽은 ACE 를
 *   조용히 무시하면 남의 권한이 열린 디렉터리를 비공개라고 말하게 된다.
 */
function windowsAclPrincipals(text, path) {
  if (typeof text !== 'string' || text.includes('(I)')) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return null;
  const body = lines.at(-1).includes(':(') ? lines : lines.slice(0, -1);
  const grants = [];
  for (let line of body) {
    if (line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length).trim();
    const match = /^(.+?):\(/.exec(line);
    if (match === null) return null;
    grants.push(match[1].replace(/^\*/, ''));
  }
  return grants.length > 0 ? grants : null;
}

async function verifyArtifactOwnerOnlyWithDeps(object, deps) {
  if (!boundedString(object.path, 32_768) || !ownerPathIsAbsolute(object.path, deps.platform) ||
      !['file', 'directory'].includes(object.kind)) return false;
  try {
    const info = await deps.lstat(object.path);
    if (info.isSymbolicLink() || object.kind === 'directory' !== info.isDirectory() || object.kind === 'file' !== info.isFile()) return false;
    const canonical = await deps.canonicalPath(object.path);
    if (typeof canonical !== 'string' || !ownerSamePath(canonical, ownerPathResolve(object.path, deps.platform), deps.platform)) return false;
    if (deps.platform !== 'win32') return (info.mode & 0o077) === 0;
    if (deps.ownerIdentityPromise === null) {
      deps.ownerIdentityPromise = (async () => {
        const whoami = await resolveOwnerBinary(deps, 'whoami.exe');
        return parseWhoamiIdentity((await deps.runCommand(whoami, ['/user', '/fo', 'csv', '/nh'])).stdout);
      })();
    }
    const identity = await deps.ownerIdentityPromise;
    if (identity === null) return false;
    const icacls = await resolveOwnerBinary(deps, 'icacls.exe');
    const principals = windowsAclPrincipals((await deps.runCommand(icacls, [object.path])).stdout, object.path);
    return principals !== null && principals.every((principal) =>
      principal.toLowerCase() === identity.account.toLowerCase() || principal === identity.sid);
  } catch {
    return false;
  }
}

async function resolveOwnerBinary(deps, name) {
  if (!deps.binaryPromises.has(name)) deps.binaryPromises.set(name, deps.resolveWindowsBinary(name));
  return deps.binaryPromises.get(name);
}

export async function verifyArtifactOwnerOnly(input, dependencyInput = {}) {
  const object = exactObject(input, ['path', 'kind']);
  const deps = ownerVerificationDeps(dependencyInput);
  return object !== null && deps !== null ? verifyArtifactOwnerOnlyWithDeps(object, deps) : false;
}

function defaultSecurePath() {
  let sidPromise = null;
  const ownerIdentity = async () => {
    if (sidPromise === null) {
      sidPromise = (async () => {
        const whoami = await defaultWindowsBinary('whoami.exe');
        const output = await execFileBounded(whoami, ['/user', '/fo', 'csv', '/nh']);
        const identity = parseWhoamiIdentity(output.stdout);
        if (identity === null) throw new Error('invalid whoami output');
        return identity;
      })();
    }
    return sidPromise;
  };
  return async ({ path, kind, phase }) => {
    try {
      if (process.platform !== 'win32') {
        if (phase === 'created') await fsChmod(path, kind === 'directory' ? 0o700 : 0o600);
        const info = await fsLstat(path);
        if (info.isSymbolicLink() || kind === 'directory' !== info.isDirectory() || kind === 'file' !== info.isFile() ||
            (info.mode & 0o077) !== 0) return blocked('artifact_permission_verification_failed');
        return { ok: true };
      }
      const owner = await ownerIdentity();
      const icacls = await defaultWindowsBinary('icacls.exe');
      if (phase === 'created') {
        const grant = kind === 'directory' ? `*${owner.sid}:(OI)(CI)F` : `*${owner.sid}:F`;
        await execFileBounded(icacls, [path, '/inheritance:r', '/grant:r', grant]);
      }
      const grants = windowsAclPrincipals((await execFileBounded(icacls, [path])).stdout, path);
      if (grants === null || grants.some((principal) =>
        principal.toLowerCase() !== owner.account.toLowerCase() && principal !== owner.sid)) {
        return blocked('artifact_permission_verification_failed');
      }
      return { ok: true };
    } catch {
      return blocked('artifact_permission_verification_failed');
    }
  };
}

async function defaultSyncDirectory(path) {
  let handle;
  try {
    handle = await fsOpen(path, 'r');
    await handle.sync();
    return { ok: true };
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) {
      return { ok: true, durability: 'process-crash-only' };
    }
    return blocked('artifact_directory_sync_failed');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function defaultPublishFileNoReplace(from, to) {
  try {
    await fsLink(from, to);
    return { ok: true };
  } catch {
    return blocked('artifact_destination_exists_or_publish_failed');
  }
}

async function defaultReplaceFileAtomic(from, to) {
  try {
    await fsRename(from, to);
    return { ok: true };
  } catch {
    return blocked('manifest_atomic_replace_failed');
  }
}

function captureDeps(value = {}) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== 'string' || !DEP_KEYS.has(key))) return null;
    const supplied = {};
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          (key === 'pid' ? !safeInteger(descriptor.value) : typeof descriptor.value !== 'function')) return null;
      supplied[key] = descriptor.value;
    }
    const securePath = supplied.securePath ?? defaultSecurePath();
    return Object.freeze({
      canonicalPath: supplied.canonicalPath ?? fsRealpath,
      lstat: supplied.lstat ?? fsLstat,
      readFile: supplied.readFile ?? fsReadFile,
      nowMs: supplied.nowMs ?? Date.now,
      pid: supplied.pid ?? process.pid,
      randomHex12: supplied.randomHex12 ?? randomHex12,
      securePath,
      mkdir: supplied.mkdir ?? fsMkdir,
      open: supplied.open ?? fsOpen,
      readdir: supplied.readdir ?? fsReaddir,
      unlink: supplied.unlink ?? fsUnlink,
      syncDirectory: supplied.syncDirectory ?? defaultSyncDirectory,
      publishFileNoReplace: supplied.publishFileNoReplace ?? defaultPublishFileNoReplace,
      replaceFileAtomic: supplied.replaceFileAtomic ?? defaultReplaceFileAtomic,
      crashBarrier: supplied.crashBarrier ?? null,
    });
  } catch {
    return null;
  }
}

async function canonicalRoot(path, deps) {
  try {
    const real = await deps.canonicalPath(path);
    return typeof real === 'string' && samePath(real, path) ? real : null;
  } catch {
    return null;
  }
}

async function lstatAbsent(path, deps) {
  try {
    return { exists: true, info: await deps.lstat(path) };
  } catch (error) {
    return error?.code === 'ENOENT' ? { exists: false } : { blocked: true };
  }
}

async function verifyPhysicalPath(path, kind, deps) {
  try {
    const info = await deps.lstat(path);
    if (info.isSymbolicLink() || kind === 'directory' !== info.isDirectory() || kind === 'file' !== info.isFile()) return false;
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) return false;
    const real = await deps.canonicalPath(path);
    return typeof real === 'string' && samePath(real, resolve(path));
  } catch {
    return false;
  }
}

async function secureAndVerify(path, kind, phase, deps) {
  try {
    const secured = await deps.securePath({ path, kind, phase });
    return secured?.ok === true && await verifyPhysicalPath(path, kind, deps);
  } catch {
    return false;
  }
}

async function verifyStorePath(path, kind, state) {
  return secureAndVerify(path, kind, 'published', state.deps);
}

async function syncDirectory(path, deps) {
  try {
    return (await deps.syncDirectory(path))?.ok === true;
  } catch {
    return false;
  }
}

async function collisionForPaths(paths, deps) {
  const found = [];
  for (const path of [paths.runDir, paths.winnerAliasPath, paths.initLockPath]) {
    const status = await lstatAbsent(path, deps);
    if (status.blocked) return blocked('artifact_collision_inspection_failed');
    if (status.exists) found.push(path);
  }
  return deepFreeze({ collision: found.length > 0, paths: found });
}

function readonlyDeps(value = {}) {
  const allowed = new Set(['canonicalPath', 'lstat', 'readFile', 'platform', 'resolveWindowsBinary', 'runCommand']);
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const out = {};
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          (key === 'platform' ? typeof descriptor.value !== 'string' : typeof descriptor.value !== 'function')) return null;
      out[key] = descriptor.value;
    }
    const owner = ownerVerificationDeps(Object.fromEntries(
      ['canonicalPath', 'lstat', 'platform', 'resolveWindowsBinary', 'runCommand']
        .filter((key) => Object.hasOwn(out, key)).map((key) => [key, out[key]]),
    ));
    if (owner === null) return null;
    return {
      ...owner,
      readFile: out.readFile ?? fsReadFile,
    };
  } catch {
    return null;
  }
}

export async function inspectRunArtifactCollision(input, dependencyInput = {}) {
  const object = exactObject(input, ['stateRoot', 'runId']);
  const deps = readonlyDeps(dependencyInput);
  if (object === null || deps === null) return blocked('invalid_artifact_collision_input');
  const budget = validateArtifactPathBudget({ stateRoot: object.stateRoot, runId: object.runId, candidateCount: 1 });
  if (budget.blocked) return budget;
  if (await canonicalRoot(object.stateRoot, deps) === null) return blocked('artifact_root_not_canonical');
  return collisionForPaths(budget.paths, deps);
}

function initialManifestValue(initial, generation, createdAt, expiresAt) {
  return {
    schemaVersion: 1,
    generation,
    runId: initial.runId,
    candidateCount: initial.candidateCount,
    baseline: cloneJson(initial.baseline),
    frozenTestPlan: cloneJson(initial.frozenTestPlan),
    proofRequirement: cloneJson(initial.proofRequirement),
    plannerBinding: cloneJson(initial.plannerBinding),
    laneBindings: cloneJson(initial.laneBindings),
    deadlineAt: initial.deadlineAt,
    createdAt,
    expiresAt,
    revision: 0,
    appliedEvents: [],
    pendingArtifacts: [],
    committedArtifacts: [],
    attempts: [],
    evidenceRefs: [],
    candidateRefs: [],
    verdictRefs: [],
    usage: null,
    issueSummary: [],
    selection: null,
    winnerAlias: null,
    cleanup: [],
  };
}

async function ensureBaseDirectory(path, deps) {
  let created = false;
  try {
    await deps.mkdir(path, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }
  return secureAndVerify(path, 'directory', created ? 'created' : 'published', deps);
}

async function openOwnedEmptyFile(path, deps, onCreated = null) {
  let handle;
  try {
    handle = await deps.open(path, 'wx', 0o600);
    const identity = await handle.stat();
    onCreated?.(identity);
    if (!await secureAndVerify(path, 'file', 'created', deps)) {
      await handle.close().catch(() => {});
      return null;
    }
    return { handle, identity };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function writeSyncClose(owned, bytes) {
  try {
    await owned.handle.writeFile(bytes);
    await owned.handle.sync();
    await owned.handle.close();
    return true;
  } catch {
    await owned.handle.close().catch(() => {});
    return false;
  }
}

function sameIdentity(a, b) {
  if (a === null || b === null) return false;
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  return a.size === b.size && a.birthtimeMs === b.birthtimeMs;
}

async function verifyOwnedBytes(path, bytes, deps) {
  try {
    if (!await verifyPhysicalPath(path, 'file', deps)) return false;
    const info = await deps.lstat(path);
    if (info.size !== bytes.length) return false;
    const actual = await deps.readFile(path);
    return Buffer.isBuffer(actual) && actual.equals(bytes);
  } catch {
    return false;
  }
}

async function publishNewFile(tempPath, finalPath, bytes, deps) {
  let published;
  try {
    published = await deps.publishFileNoReplace(tempPath, finalPath);
  } catch {
    return false;
  }
  if (published?.ok !== true || !await secureAndVerify(finalPath, 'file', 'published', deps) ||
      !await verifyOwnedBytes(finalPath, bytes, deps)) return false;
  try {
    await deps.unlink(tempPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  return syncDirectory(dirname(finalPath), deps);
}

async function createSecureDirectory(path, deps) {
  let created = false;
  try {
    await deps.mkdir(path, { recursive: false, mode: 0o700 });
    created = true;
    const identity = await deps.lstat(path);
    if (identity.isSymbolicLink() || !identity.isDirectory() ||
        !await secureAndVerify(path, 'directory', 'created', deps)) return { created, identity, ok: false };
    const verifiedIdentity = await deps.lstat(path);
    return { created, identity, ok: sameIdentity(identity, verifiedIdentity) };
  } catch {
    return { created, identity: null, ok: false };
  }
}

async function runBarrier(context, point) {
  if (context.deps.crashBarrier === null) return;
  try {
    await context.deps.crashBarrier(point);
  } catch {
    context.crashed = true;
    throw new Error('simulated_artifact_crash');
  }
}

async function lockStillOwned(context) {
  try {
    const bytes = await context.deps.readFile(context.paths.initLockPath);
    const info = await context.deps.lstat(context.paths.initLockPath);
    return Buffer.isBuffer(bytes) && bytes.equals(context.lockBytes) && sameIdentity(info, context.lockIdentity) &&
      await verifyPhysicalPath(context.paths.initLockPath, 'file', context.deps);
  } catch {
    return false;
  }
}

async function validateCompleteInitialTree(context) {
  try {
    const runIdentity = await context.deps.lstat(context.paths.runDir);
    if (!sameIdentity(runIdentity, context.finalIdentity)) return false;
    const top = (await context.deps.readdir(context.paths.runDir)).sort();
    if (JSON.stringify(top) !== JSON.stringify(['attempts', 'candidates', 'evidence', 'manifest.json'])) return false;
    for (const name of ['attempts', 'candidates', 'evidence']) {
      const path = join(context.paths.runDir, name);
      const identity = await context.deps.lstat(path);
      if (!sameIdentity(identity, context.ownedDirectories.get(path)) ||
          !await verifyPhysicalPath(path, 'directory', context.deps) || (await context.deps.readdir(path)).length !== 0) return false;
    }
    return await verifyOwnedBytes(context.paths.manifestPath, context.manifestBytes, context.deps);
  } catch {
    return false;
  }
}

export async function createRunArtifacts(input, dependencyInput = {}) {
  const object = exactObject(input, ['stateRoot', 'runId', 'initialManifest']);
  const deps = captureDeps(dependencyInput);
  if (object === null || deps === null) return blocked('invalid_artifact_store_input');
  const initial = normalizeInitialManifest(object.initialManifest, object.runId);
  if (initial === null) return blocked('invalid_initial_manifest');
  const budget = validateArtifactPathBudget({ stateRoot: object.stateRoot, runId: object.runId, candidateCount: initial.candidateCount });
  if (budget.blocked) return budget;
  if (await canonicalRoot(object.stateRoot, deps) === null) return blocked('artifact_root_not_canonical');
  const collision = await collisionForPaths(budget.paths, deps);
  if (collision.blocked) return collision;
  if (collision.collision) return blocked('artifact_namespace_collision', 'Use a fresh runId; existing artifact namespaces are never adopted.');

  let generation;
  let createdAt;
  try {
    generation = deps.randomHex12();
    createdAt = deps.nowMs();
  } catch {
    return blocked('artifact_initialization_dependency_failed');
  }
  if (!GENERATION_PATTERN.test(generation) || !safeInteger(createdAt) ||
      !safeInteger(createdAt + RUN_ARTIFACT_RETENTION_MS) || !safeInteger(deps.pid)) {
    return blocked('artifact_initialization_dependency_failed');
  }
  const expiresAt = createdAt + RUN_ARTIFACT_RETENTION_MS;
  const lockValue = {
    schemaVersion: 1,
    kind: 'run-artifact-init-lock',
    runId: object.runId,
    generation,
    pid: deps.pid,
    finalBasename: object.runId,
    createdAt,
    expiresAt,
  };
  const lockBytes = jsonBytes(lockValue);
  const manifest = initialManifestValue(initial, generation, createdAt, expiresAt);
  const manifestBytes = jsonBytes(manifest);
  if (lockBytes === null || manifestBytes === null || manifestBytes.length > MAX_RUN_MANIFEST_BYTES) {
    return blocked('artifact_initial_manifest_too_large');
  }
  const context = {
    deps,
    paths: budget.paths,
    lockBytes,
    lockIdentity: null,
    finalIdentity: null,
    ownedDirectories: new Map(),
    manifestBytes,
    crashed: false,
  };
  try {
    if (!await ensureBaseDirectory(join(object.stateRoot, 'runs'), deps) ||
        !await ensureBaseDirectory(join(object.stateRoot, 'patches'), deps)) {
      return blocked('artifact_base_directory_not_private');
    }
    const lock = await openOwnedEmptyFile(budget.paths.initLockPath, deps);
    if (lock === null) return blocked('artifact_init_lock_collision', 'Use a fresh runId; an initializer already owns this namespace.');
    context.lockIdentity = lock.identity;
    await runBarrier(context, 'after-zero-byte-lock');
    if (!await writeSyncClose(lock, lockBytes) || !await verifyOwnedBytes(budget.paths.initLockPath, lockBytes, deps) ||
        !await syncDirectory(dirname(budget.paths.initLockPath), deps)) throw new Error('lock publication failed');
    await runBarrier(context, 'after-init-lock');

    const finalDirectory = await createSecureDirectory(budget.paths.runDir, deps);
    if (finalDirectory.created) context.finalIdentity = finalDirectory.identity;
    if (!finalDirectory.ok) throw new Error('final reservation failed');
    await runBarrier(context, 'after-final-directory');
    for (const name of ['candidates', 'attempts', 'evidence']) {
      const path = join(budget.paths.runDir, name);
      const childDirectory = await createSecureDirectory(path, deps);
      if (childDirectory.created && childDirectory.identity !== null) {
        context.ownedDirectories.set(path, childDirectory.identity);
      }
      if (!childDirectory.ok) throw new Error('child directory failed');
      await runBarrier(context, `after-${name}-directory`);
    }
    for (const name of ['candidates', 'attempts', 'evidence']) {
      if (!await syncDirectory(join(budget.paths.runDir, name), deps)) throw new Error('child directory sync failed');
    }
    await runBarrier(context, 'after-final-directories-synced');

    const manifestTemp = join(budget.paths.runDir, `.tmp-manifest.json-${deps.pid}-${deps.randomHex12()}`);
    if (!GENERATION_PATTERN.test(manifestTemp.slice(-12))) throw new Error('invalid temp generation');
    const temp = await openOwnedEmptyFile(manifestTemp, deps);
    if (temp === null || !await writeSyncClose(temp, manifestBytes) || !await verifyOwnedBytes(manifestTemp, manifestBytes, deps)) {
      throw new Error('manifest temp failed');
    }
    await runBarrier(context, 'after-manifest-temp');
    if (!await publishNewFile(manifestTemp, budget.paths.manifestPath, manifestBytes, deps)) throw new Error('manifest publish failed');
    await runBarrier(context, 'after-manifest-published');
    if (!await validateCompleteInitialTree(context) || !await syncDirectory(budget.paths.runDir, deps) ||
        !await syncDirectory(dirname(budget.paths.runDir), deps)) throw new Error('final verification failed');
    await runBarrier(context, 'after-final-verified');
    if (!await lockStillOwned(context)) throw new Error('init lock changed');
    await deps.unlink(budget.paths.initLockPath);
    if (!await syncDirectory(dirname(budget.paths.initLockPath), deps)) throw new Error('lock removal sync failed');
    await runBarrier(context, 'after-init-lock-removed');

    const manifestIdentity = await deps.lstat(budget.paths.manifestPath);
    const store = deepFreeze({ kind: 'run-artifact-store', runId: object.runId, root: budget.paths.runDir });
    const privateState = {
      store,
      stateRoot: object.stateRoot,
      runId: object.runId,
      candidateCount: initial.candidateCount,
      initial,
      generation,
      createdAt,
      expiresAt,
      paths: budget.paths,
      deps,
      manifest,
      manifestBytes,
      manifestHash: sha256(manifestBytes),
      manifestIdentity,
      manifestQueue: Promise.resolve(),
      writerQueue: Promise.resolve(),
      publishedPending: new Set(),
      checkpointTemp: null,
      poisoned: false,
    };
    STORE_STATES.set(store, privateState);
    return store;
  } catch {
    return blocked(context.crashed ? 'artifact_initialization_interrupted' : 'artifact_initialization_failed');
  }
}

function normalizeArtifactRef(value) {
  const object = exactObject(value, ['kind', 'candidateId', 'path', 'sha256', 'bytes', 'expiresAt']);
  if (object === null || !['attempt', 'evidence', 'candidate', 'winner'].includes(object.kind) ||
      !validLane(object.candidateId) || !boundedString(object.path, 32_768) || !isAbsolute(object.path) ||
      !SHA256_PATTERN.test(object.sha256) || !safeInteger(object.bytes) || !safeInteger(object.expiresAt)) return null;
  return {
    kind: object.kind,
    candidateId: object.candidateId,
    path: object.path,
    sha256: object.sha256,
    bytes: object.bytes,
    expiresAt: object.expiresAt,
  };
}

function normalizeManifestRef(value) {
  const object = exactObject(value, ['kind', 'path', 'revision', 'expiresAt']);
  if (object === null || object.kind !== 'manifest' || !boundedString(object.path, 32_768) || !isAbsolute(object.path) ||
      !safeInteger(object.revision) || !safeInteger(object.expiresAt)) return null;
  return { kind: 'manifest', path: object.path, revision: object.revision, expiresAt: object.expiresAt };
}

function manifestRef(state, revision = state.manifest.revision) {
  return deepFreeze({ kind: 'manifest', path: state.paths.manifestPath, revision, expiresAt: state.expiresAt });
}

function artifactIdentity(value) {
  const kindDescriptor = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, 'artifactKind');
    } catch {
      return null;
    }
  })();
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) return null;
  const artifactKind = kindDescriptor.value;
  if (artifactKind === 'attempt') {
    const object = exactObject(value, ['artifactKind', 'laneId', 'attemptOrdinal']);
    return object !== null && validLane(object.laneId) && validOrdinal(object.attemptOrdinal)
      ? { artifactKind, laneId: object.laneId, attemptOrdinal: object.attemptOrdinal }
      : null;
  }
  if (artifactKind === 'evidence') {
    const object = exactObject(value, ['artifactKind', 'laneId', 'attemptOrdinal', 'evidenceOrdinal']);
    return object !== null && validLane(object.laneId) && validOrdinal(object.attemptOrdinal) && validOrdinal(object.evidenceOrdinal)
      ? { artifactKind, laneId: object.laneId, attemptOrdinal: object.attemptOrdinal, evidenceOrdinal: object.evidenceOrdinal }
      : null;
  }
  if (artifactKind === 'candidate') {
    const object = exactObject(value, ['artifactKind', 'laneId', 'sourceAttemptId']);
    return object !== null && validLane(object.laneId) && boundedString(object.sourceAttemptId, 256)
      ? { artifactKind, laneId: object.laneId, sourceAttemptId: object.sourceAttemptId }
      : null;
  }
  if (artifactKind === 'winner') {
    const object = exactObject(value, ['artifactKind', 'candidateId']);
    return object !== null && validLane(object.candidateId) ? { artifactKind, candidateId: object.candidateId } : null;
  }
  return null;
}

function identityFields(identity) {
  if (identity.artifactKind === 'attempt') {
    return { artifactKind: 'attempt', laneId: identity.laneId, attemptOrdinal: identity.attemptOrdinal };
  }
  if (identity.artifactKind === 'evidence') {
    return {
      artifactKind: 'evidence', laneId: identity.laneId,
      attemptOrdinal: identity.attemptOrdinal, evidenceOrdinal: identity.evidenceOrdinal,
    };
  }
  if (identity.artifactKind === 'candidate') {
    return { artifactKind: 'candidate', laneId: identity.laneId, sourceAttemptId: identity.sourceAttemptId };
  }
  return { artifactKind: 'winner', candidateId: identity.candidateId };
}

function identityKey(identity) {
  if (identity.artifactKind === 'attempt') return `attempt:${identity.laneId}:${ordinal(identity.attemptOrdinal)}`;
  if (identity.artifactKind === 'evidence') {
    return `evidence:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:${ordinal(identity.evidenceOrdinal)}`;
  }
  if (identity.artifactKind === 'candidate') return `candidate:${identity.laneId}`;
  return `winner:${identity.candidateId}`;
}

function artifactKindForIdentity(identity) {
  return identity.artifactKind;
}

function candidateForIdentity(identity) {
  return identity.artifactKind === 'winner' ? identity.candidateId : identity.laneId;
}

function finalPathForIdentity(state, identity) {
  if (identity.artifactKind === 'attempt') {
    return join(state.paths.runDir, 'attempts', `${identity.laneId}-${ordinal(identity.attemptOrdinal)}.json`);
  }
  if (identity.artifactKind === 'evidence') {
    return join(
      state.paths.runDir,
      'evidence',
      `${identity.laneId}-${ordinal(identity.attemptOrdinal)}-${ordinal(identity.evidenceOrdinal)}.json`,
    );
  }
  if (identity.artifactKind === 'candidate') return state.paths.candidatePaths[identity.laneId] ?? null;
  return state.paths.winnerAliasPath;
}

function normalizePending(value) {
  const kind = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, 'artifactKind')?.value;
    } catch {
      return null;
    }
  })();
  const identityKeys = kind === 'attempt' ? ['artifactKind', 'laneId', 'attemptOrdinal']
    : kind === 'evidence' ? ['artifactKind', 'laneId', 'attemptOrdinal', 'evidenceOrdinal']
      : kind === 'candidate' ? ['artifactKind', 'laneId', 'sourceAttemptId']
        : kind === 'winner' ? ['artifactKind', 'candidateId'] : null;
  if (identityKeys === null) return null;
  const keys = [...identityKeys, 'relativePath', 'tempRelativePath', 'expectedSha256', 'expectedBytes', 'reservedEventId'];
  const object = exactObject(value, keys);
  if (object === null) return null;
  const identity = artifactIdentity(Object.fromEntries(identityKeys.map((key) => [key, object[key]])));
  if (identity === null || !boundedString(object.relativePath, 32_768) || !boundedString(object.tempRelativePath, 32_768) ||
      !SHA256_PATTERN.test(object.expectedSha256) || !safeInteger(object.expectedBytes) ||
      !EVENT_ID_PATTERN.test(object.reservedEventId)) return null;
  return {
    ...identityFields(identity),
    relativePath: object.relativePath,
    tempRelativePath: object.tempRelativePath,
    expectedSha256: object.expectedSha256,
    expectedBytes: object.expectedBytes,
    reservedEventId: object.reservedEventId,
  };
}

function normalizeCommitted(value) {
  const kind = (() => {
    try {
      return Object.getOwnPropertyDescriptor(value, 'artifactKind')?.value;
    } catch {
      return null;
    }
  })();
  const identityKeys = kind === 'attempt' ? ['artifactKind', 'laneId', 'attemptOrdinal']
    : kind === 'evidence' ? ['artifactKind', 'laneId', 'attemptOrdinal', 'evidenceOrdinal']
      : kind === 'candidate' ? ['artifactKind', 'laneId', 'sourceAttemptId']
        : kind === 'winner' ? ['artifactKind', 'candidateId'] : null;
  if (identityKeys === null) return null;
  const object = exactObject(value, [...identityKeys, 'relativePath', 'ref', 'committedEventId']);
  if (object === null) return null;
  const identity = artifactIdentity(Object.fromEntries(identityKeys.map((key) => [key, object[key]])));
  const ref = normalizeArtifactRef(object.ref);
  if (identity === null || ref === null || !boundedString(object.relativePath, 32_768) || !EVENT_ID_PATTERN.test(object.committedEventId) ||
      ref.kind !== artifactKindForIdentity(identity) || ref.candidateId !== candidateForIdentity(identity)) return null;
  return {
    ...identityFields(identity),
    relativePath: object.relativePath,
    ref,
    committedEventId: object.committedEventId,
  };
}

function normalizeStringArray(value, { max = 100, pattern = null, sort = true } = {}) {
  const array = exactDenseArray(value, max);
  if (array === null || array.some((item) => !boundedString(item, 256) || pattern !== null && !pattern.test(item)) ||
      new Set(array).size !== array.length) return null;
  const out = [...array];
  if (sort) out.sort(compareUtf8);
  return out;
}

function normalizeManifestAttempt(value) {
  const object = exactObject(value, ['laneId', 'ordinal', 'attemptId', 'retryOf', 'status', 'attemptRef', 'result']);
  const ref = object?.attemptRef === null ? null : normalizeArtifactRef(object?.attemptRef);
  if (object === null || !validLane(object.laneId) || !validOrdinal(object.ordinal) || !boundedString(object.attemptId, 256) ||
      !(object.retryOf === null || boundedString(object.retryOf, 256)) || !['allocated', 'terminal'].includes(object.status) ||
      ref === null && object.attemptRef !== null || ref !== null && (ref.kind !== 'attempt' || ref.candidateId !== object.laneId) ||
      ![null, 'accepted', 'repair', 'rejected', 'blocked', 'stagnated'].includes(object.result) ||
      object.status === 'allocated' && (ref !== null || object.result !== null) || object.status === 'terminal' && (ref === null || object.result === null)) return null;
  return {
    laneId: object.laneId,
    ordinal: object.ordinal,
    attemptId: object.attemptId,
    retryOf: object.retryOf,
    status: object.status,
    attemptRef: ref,
    result: object.result,
  };
}

function normalizeManifestEvidenceRef(value) {
  const object = exactObject(value, ['laneId', 'attemptId', 'evidenceId', 'kind', 'repetition', 'ref']);
  const ref = normalizeArtifactRef(object?.ref);
  if (object === null || !validLane(object.laneId) || !boundedString(object.attemptId, 256) || !boundedString(object.evidenceId, 320) ||
      !['b0', 'br', 'c'].includes(object.kind) || ![1, 2].includes(object.repetition) || ref === null ||
      ref.kind !== 'evidence' || ref.candidateId !== object.laneId) return null;
  return {
    laneId: object.laneId,
    attemptId: object.attemptId,
    evidenceId: object.evidenceId,
    kind: object.kind,
    repetition: object.repetition,
    ref,
  };
}

function normalizeTests(value) {
  const object = exactObject(value, ['execution', 'outcome', 'stability', 'complete']);
  if (object === null || !['completed', 'not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(object.execution) ||
      !['pass', 'fail', 'unknown'].includes(object.outcome) || !['stable', 'flaky', 'unknown'].includes(object.stability) ||
      typeof object.complete !== 'boolean') return null;
  return {
    execution: object.execution,
    outcome: object.outcome,
    stability: object.stability,
    complete: object.complete,
  };
}

function normalizeScope(value) {
  const object = exactObject(value, ['flagged', 'reasonCount', 'omittedReasonCount']);
  return object !== null && typeof object.flagged === 'boolean' && safeInteger(object.reasonCount) && safeInteger(object.omittedReasonCount)
    ? { flagged: object.flagged, reasonCount: object.reasonCount, omittedReasonCount: object.omittedReasonCount }
    : null;
}

function normalizeCandidateRef(value) {
  const object = exactObject(value, [
    'candidateId', 'sourceAttemptId', 'terminalClass', 'treeHash', 'patchRef', 'proofStatus', 'tests', 'scope',
  ]);
  const patchRef = object?.patchRef === null ? null : normalizeArtifactRef(object?.patchRef);
  const tests = normalizeTests(object?.tests);
  const scope = normalizeScope(object?.scope);
  if (object === null || !validLane(object.candidateId) || !(object.sourceAttemptId === null || boundedString(object.sourceAttemptId, 256)) ||
      !['verified', 'usable_unverified', 'rejected', 'blocked'].includes(object.terminalClass) ||
      !(object.treeHash === null || OBJECT_ID_PATTERN.test(object.treeHash)) || patchRef === null && object.patchRef !== null ||
      patchRef !== null && (patchRef.kind !== 'candidate' || patchRef.candidateId !== object.candidateId) ||
      !['proved', 'not_applicable', 'not_proven', 'unavailable', 'flaky'].includes(object.proofStatus) || tests === null || scope === null) return null;
  if (object.terminalClass === 'blocked' && object.sourceAttemptId === null && (object.treeHash !== null || patchRef !== null)) return null;
  return {
    candidateId: object.candidateId,
    sourceAttemptId: object.sourceAttemptId,
    terminalClass: object.terminalClass,
    treeHash: object.treeHash,
    patchRef,
    proofStatus: object.proofStatus,
    tests,
    scope,
  };
}

function normalizeVerdictRef(value) {
  const object = exactObject(value, ['laneId', 'attemptId', 'verdict', 'issueIds']);
  const issueIds = normalizeStringArray(object?.issueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  return object !== null && validLane(object.laneId) && boundedString(object.attemptId, 256) &&
    ['PASS', 'FAIL'].includes(object.verdict) && issueIds !== null
    ? { laneId: object.laneId, attemptId: object.attemptId, verdict: object.verdict, issueIds }
    : null;
}

function normalizeIssueSummary(value) {
  const object = exactObject(value, ['candidateId', 'openIssueIds', 'openIssueCount', 'limitExceeded']);
  const ids = normalizeStringArray(object?.openIssueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  return object !== null && validLane(object.candidateId) && ids !== null && object.openIssueCount === ids.length &&
    typeof object.limitExceeded === 'boolean'
    ? { candidateId: object.candidateId, openIssueIds: ids, openIssueCount: ids.length, limitExceeded: object.limitExceeded }
    : null;
}

function normalizeComparisonTuple(value) {
  const array = exactDenseArray(value, 5);
  if (array === null || array.length !== 5 || !['verified', 'usable_unverified'].includes(array[0]) ||
      !['proved', 'not_applicable', 'not_proven', 'unavailable', 'flaky'].includes(array[1]) ||
      !['stable_repeated_full_pass', 'stable_one_pass', 'unknown_or_not_run', 'flaky'].includes(array[2]) ||
      !safeInteger(array[3])) return null;
  const scope = exactDenseArray(array[4], 2);
  if (scope === null || scope.length !== 2 || ![0, 1].includes(scope[0]) || !safeInteger(scope[1])) return null;
  return [array[0], array[1], array[2], array[3], [scope[0], scope[1]]];
}

function normalizeObjectiveComparison(value) {
  const object = exactObject(value, ['result', 'decisiveField', 'tupleA', 'tupleB']);
  const tupleA = normalizeComparisonTuple(object?.tupleA);
  const tupleB = normalizeComparisonTuple(object?.tupleB);
  return object !== null && ['a', 'b', 'tie', 'equivalent'].includes(object.result) &&
    [null, 'terminalClass', 'proof', 'tests', 'openIssues', 'scope'].includes(object.decisiveField) && tupleA !== null && tupleB !== null
    ? { result: object.result, decisiveField: object.decisiveField, tupleA, tupleB }
    : null;
}

function normalizeJudgeDecision(value) {
  let status;
  try {
    status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
  } catch {
    return null;
  }
  if (status === 'invalid') {
    const object = exactObject(value, ['status', 'judgeIndex', 'corrected', 'code']);
    return object !== null && [1, 2].includes(object.judgeIndex) && typeof object.corrected === 'boolean' &&
      /^[a-z0-9_]{1,64}$/.test(object.code)
      ? { status: 'invalid', judgeIndex: object.judgeIndex, corrected: object.corrected, code: object.code }
      : null;
  }
  if (status !== 'valid') return null;
  const object = exactObject(value, ['status', 'judgeIndex', 'realDecision', 'corrected', 'rationale', 'majorDefects']);
  const defects = exactDenseArray(object?.majorDefects, 20);
  if (object === null || ![1, 2].includes(object.judgeIndex) || !['lane-a', 'lane-b', 'TIE'].includes(object.realDecision) ||
      typeof object.corrected !== 'boolean' || !boundedString(object.rationale, 2_000, true) || defects === null) return null;
  const normalized = [];
  for (const defect of defects) {
    const item = exactObject(defect, ['category', 'claim', 'evidence']);
    if (item === null || !['correctness', 'security', 'requirements', 'scope', 'tests'].includes(item.category) ||
        !boundedString(item.claim, 1_000) || !boundedString(item.evidence, 1_000)) return null;
    normalized.push({ category: item.category, claim: item.claim, evidence: item.evidence });
  }
  return {
    status: 'valid', judgeIndex: object.judgeIndex, realDecision: object.realDecision,
    corrected: object.corrected, rationale: object.rationale, majorDefects: normalized,
  };
}

function normalizeSelection(value) {
  const object = exactObject(value, ['outcome', 'selectedCandidateId', 'objectiveComparison', 'judgeDecisions']);
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

const TERMINAL_CLASS_RANK = new Map([['usable_unverified', 0], ['verified', 1]]);
const PROOF_STATUS_RANK = new Map([
  ['flaky', 0], ['unavailable', 1], ['not_proven', 2], ['not_applicable', 3], ['proved', 4],
]);
const TEST_RANK = new Map([
  ['flaky', 0], ['unknown_or_not_run', 1], ['stable_one_pass', 2], ['stable_repeated_full_pass', 3],
]);

function durableTestRank(tests) {
  if (tests.execution === 'completed' && tests.outcome === 'pass' && tests.complete) {
    if (tests.stability === 'stable') return 'stable_repeated_full_pass';
    if (tests.stability === 'unknown') return 'stable_one_pass';
  }
  return tests.stability === 'flaky' ? 'flaky' : 'unknown_or_not_run';
}

function durableComparisonTuple(candidate, issueSummary) {
  const scopeCount = candidate.scope.reasonCount + candidate.scope.omittedReasonCount;
  const issues = issueSummary.find((entry) => entry.candidateId === candidate.candidateId);
  if (!safeInteger(scopeCount) || issues === undefined) return null;
  return [
    candidate.terminalClass,
    candidate.proofStatus,
    durableTestRank(candidate.tests),
    issues.openIssueCount,
    [candidate.scope.flagged ? 1 : 0, scopeCount],
  ];
}

function compareDurableTuples(tupleA, tupleB) {
  const ranked = [
    ['terminalClass', TERMINAL_CLASS_RANK, 0],
    ['proof', PROOF_STATUS_RANK, 1],
    ['tests', TEST_RANK, 2],
  ];
  for (const [decisiveField, ranks, index] of ranked) {
    const a = ranks.get(tupleA[index]);
    const b = ranks.get(tupleB[index]);
    if (a !== b) return { result: a > b ? 'a' : 'b', decisiveField };
  }
  if (tupleA[3] !== tupleB[3]) {
    return { result: tupleA[3] < tupleB[3] ? 'a' : 'b', decisiveField: 'openIssues' };
  }
  for (let index = 0; index < 2; index += 1) {
    if (tupleA[4][index] !== tupleB[4][index]) {
      return { result: tupleA[4][index] < tupleB[4][index] ? 'a' : 'b', decisiveField: 'scope' };
    }
  }
  return { result: 'tie', decisiveField: null };
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
  const comparison = compareDurableTuples(tupleA, tupleB);
  if (objective.result !== comparison.result || objective.decisiveField !== comparison.decisiveField) return false;
  if (comparison.result === 'a' || comparison.result === 'b') {
    const expected = comparison.result === 'a' ? 'lane-a' : 'lane-b';
    return selection.outcome === 'winner' && selection.selectedCandidateId === expected && selection.judgeDecisions.length === 0;
  }
  const judged = judgeOutcome(selection);
  return judged !== null && selection.outcome === judged.outcome &&
    selection.selectedCandidateId === judged.selectedCandidateId;
}

function normalizeCleanup(value) {
  const object = exactObject(value, ['kind', 'candidateId', 'attemptId', 'path', 'status', 'recoveryPath']);
  if (object === null || !['authoring', 'evidence', 'planner', 'judge'].includes(object.kind) ||
      !(object.candidateId === null || validLane(object.candidateId)) || !(object.attemptId === null || boundedString(object.attemptId, 256)) ||
      !boundedString(object.path, 32_768) || !isAbsolute(object.path) || !['removed', 'reaper_pending'].includes(object.status) ||
      !(object.recoveryPath === null || boundedString(object.recoveryPath, 32_768) && isAbsolute(object.recoveryPath))) return null;
  return {
    kind: object.kind,
    candidateId: object.candidateId,
    attemptId: object.attemptId,
    path: object.path,
    status: object.status,
    recoveryPath: object.recoveryPath,
  };
}

function normalizeArrayBy(values, normalizer, max = 10_000) {
  const array = exactDenseArray(values, max);
  if (array === null) return null;
  const out = array.map(normalizer);
  return out.some((value) => value === null) ? null : out;
}

function identityFromInventory(entry) {
  return artifactIdentity(identityFields(entry));
}

function compareAppliedEvents(a, b) {
  return compareUtf8(a.eventId, b.eventId);
}

const INVENTORY_KIND_RANK = new Map([
  ['attempt', 0], ['evidence', 1], ['candidate', 2], ['winner', 3],
]);

function inventoryOrderTuple(entry) {
  const identity = identityFromInventory(entry);
  if (identity.artifactKind === 'winner') {
    return [1, identity.candidateId, 0, 0, '', INVENTORY_KIND_RANK.get(identity.artifactKind)];
  }
  if (identity.artifactKind === 'attempt') {
    return [0, identity.laneId, identity.attemptOrdinal, 0, '', INVENTORY_KIND_RANK.get(identity.artifactKind)];
  }
  if (identity.artifactKind === 'evidence') {
    return [
      0, identity.laneId, identity.attemptOrdinal, identity.evidenceOrdinal, '',
      INVENTORY_KIND_RANK.get(identity.artifactKind),
    ];
  }
  const sourceOrdinal = Number(/\/([0-9]{3})$/.exec(identity.sourceAttemptId)?.[1] ?? 1_000);
  return [
    0, identity.laneId, sourceOrdinal, 1_000, identity.sourceAttemptId,
    INVENTORY_KIND_RANK.get(identity.artifactKind),
  ];
}

function compareInventoryEntries(a, b) {
  const left = inventoryOrderTuple(a);
  const right = inventoryOrderTuple(b);
  return left[0] - right[0] || compareUtf8(left[1], right[1]) || left[2] - right[2] ||
    left[3] - right[3] || compareUtf8(left[4], right[4]) || left[5] - right[5];
}

function compareAttempts(a, b) {
  return compareUtf8(a.laneId, b.laneId) || a.ordinal - b.ordinal;
}

function compareEvidenceRefs(a, b) {
  return compareUtf8(a.laneId, b.laneId) || compareUtf8(a.attemptId, b.attemptId) ||
    compareUtf8(a.evidenceId, b.evidenceId);
}

function compareCandidateRefs(a, b) {
  return compareUtf8(a.candidateId, b.candidateId);
}

function compareVerdictRefs(a, b) {
  return compareUtf8(a.laneId, b.laneId) || compareUtf8(a.attemptId, b.attemptId);
}

function compareIssueSummaries(a, b) {
  return compareUtf8(a.candidateId, b.candidateId);
}

function compareCleanup(a, b) {
  return compareUtf8(cleanupKey(a), cleanupKey(b));
}

function canonicallyOrdered(values, compare) {
  return values.every((entry, index) => index === 0 || compare(values[index - 1], entry) < 0);
}

function manifestArraysCanonicallyOrdered(manifest) {
  return canonicallyOrdered(manifest.appliedEvents, compareAppliedEvents) &&
    canonicallyOrdered(manifest.pendingArtifacts, compareInventoryEntries) &&
    canonicallyOrdered(manifest.committedArtifacts, compareInventoryEntries) &&
    canonicallyOrdered(manifest.attempts, compareAttempts) &&
    canonicallyOrdered(manifest.evidenceRefs, compareEvidenceRefs) &&
    canonicallyOrdered(manifest.candidateRefs, compareCandidateRefs) &&
    canonicallyOrdered(manifest.verdictRefs, compareVerdictRefs) &&
    canonicallyOrdered(manifest.issueSummary, compareIssueSummaries) &&
    canonicallyOrdered(manifest.cleanup, compareCleanup);
}

function relativeMatchesIdentity(manifest, entry) {
  const identity = identityFromInventory(entry);
  if (identity === null) return false;
  const final = identity.artifactKind === 'attempt'
    ? `runs/${manifest.runId}/attempts/${identity.laneId}-${ordinal(identity.attemptOrdinal)}.json`
    : identity.artifactKind === 'evidence'
      ? `runs/${manifest.runId}/evidence/${identity.laneId}-${ordinal(identity.attemptOrdinal)}-${ordinal(identity.evidenceOrdinal)}.json`
      : identity.artifactKind === 'candidate'
        ? `runs/${manifest.runId}/candidates/${identity.laneId}.patch`
        : `patches/${manifest.runId}.patch`;
  if (entry.relativePath !== final) return false;
  if (Object.hasOwn(entry, 'tempRelativePath')) {
    const prefix = `${final.slice(0, final.lastIndexOf('/') + 1)}.tmp-${final.slice(final.lastIndexOf('/') + 1)}-`;
    if (!entry.tempRelativePath.startsWith(prefix) || !/^\d+-[0-9a-f]{12}$/.test(entry.tempRelativePath.slice(prefix.length))) return false;
  }
  return true;
}

function refSuffixMatches(manifest, entry) {
  const suffix = entry.relativePath.split('/').join(sep);
  return entry.ref.path.endsWith(suffix) && entry.ref.expiresAt === manifest.expiresAt;
}

function commonLogicalStateRoot(current, candidate) {
  if (candidate === null) return null;
  return current === undefined || samePath(current, candidate) ? candidate : null;
}

function cleanupLogicalStateRoot(cleanup) {
  if (cleanup.path !== resolve(cleanup.path) ||
      (cleanup.status === 'removed' ? cleanup.recoveryPath !== null : cleanup.recoveryPath !== cleanup.path)) return null;
  const expectedSegment = cleanup.kind === 'planner' ? 'plans' : 'worktrees';
  const controllerDir = dirname(resolve(cleanup.path));
  return basename(controllerDir) === expectedSegment && basename(resolve(cleanup.path)) !== ''
    ? dirname(controllerDir)
    : null;
}

function logicalStateRootFromManifest(manifest) {
  let stateRoot = null;
  for (const entry of manifest.committedArtifacts) {
    const parts = entry.relativePath.split('/');
    if (entry.ref.path !== resolve(entry.ref.path)) return { ok: false, stateRoot: null };
    let candidate = resolve(entry.ref.path);
    for (let index = 0; index < parts.length; index += 1) candidate = dirname(candidate);
    if (join(candidate, ...parts) !== entry.ref.path ||
        relativeJson(candidate, resolve(entry.ref.path)) !== entry.relativePath) return { ok: false, stateRoot: null };
    const common = commonLogicalStateRoot(stateRoot ?? undefined, candidate);
    if (common === null) return { ok: false, stateRoot: null };
    stateRoot = common;
  }
  for (const cleanup of manifest.cleanup) {
    const candidate = cleanupLogicalStateRoot(cleanup);
    const common = commonLogicalStateRoot(stateRoot ?? undefined, candidate);
    if (common === null) return { ok: false, stateRoot: null };
    stateRoot = common;
  }
  return { ok: true, stateRoot };
}

function validateManifestEventRelationships(manifest) {
  const rootAuthority = logicalStateRootFromManifest(manifest);
  if (!rootAuthority.ok) return false;
  const stateRoot = rootAuthority.stateRoot;
  const events = new Map(manifest.appliedEvents.map((entry) => [entry.eventId, entry]));
  const used = new Set();
  const consumeId = (eventId, event = null) => {
    const applied = events.get(eventId);
    if (applied === undefined || used.has(eventId) || event !== null && !eventDigestMatches(applied.eventSha256, event, stateRoot)) return false;
    used.add(eventId);
    return true;
  };
  const consumeMatching = (build) => {
    const matches = manifest.appliedEvents.filter((entry) => !used.has(entry.eventId) &&
      eventDigestMatches(entry.eventSha256, build(entry.eventId), stateRoot));
    return matches.length === 1 && consumeId(matches[0].eventId);
  };
  for (const attempt of manifest.attempts) {
    if (!consumeMatching((eventId) => ({
      eventId,
      type: 'attempt_allocated',
      laneId: attempt.laneId,
      ordinal: attempt.ordinal,
      attemptId: attempt.attemptId,
      retryOf: attempt.retryOf,
    }))) return false;
    if (attempt.status === 'terminal') {
      const verdict = manifest.verdictRefs.find((entry) =>
        entry.laneId === attempt.laneId && entry.attemptId === attempt.attemptId);
      const eventId = `attempt:${attempt.laneId}:${ordinal(attempt.ordinal)}:terminal`;
      if (!consumeId(eventId, {
        eventId,
        type: 'attempt_terminal',
        laneId: attempt.laneId,
        ordinal: attempt.ordinal,
        attemptId: attempt.attemptId,
        attemptRef: attempt.attemptRef,
        result: attempt.result,
        verdictRef: verdict === undefined ? null : { verdict: verdict.verdict, issueIds: verdict.issueIds },
      })) return false;
    }
  }
  for (const pending of manifest.pendingArtifacts) {
    const identity = identityFromInventory(pending);
    if (!consumeId(pending.reservedEventId, {
      eventId: pending.reservedEventId,
      type: 'artifact_reserved',
      ...identityFields(identity),
      relativePath: pending.relativePath,
      tempRelativePath: pending.tempRelativePath,
      expectedSha256: pending.expectedSha256,
      expectedBytes: pending.expectedBytes,
    })) return false;
  }
  for (const committed of manifest.committedArtifacts) {
    const identity = identityFromInventory(committed);
    const reservedEventId = expectedArtifactEventId(identity, 'reserved');
    if (!consumeId(reservedEventId) || !consumeId(committed.committedEventId, {
      eventId: committed.committedEventId,
      type: 'artifact_committed',
      ...identityFields(identity),
      relativePath: committed.relativePath,
      ref: committed.ref,
    })) return false;
  }
  for (const candidate of manifest.candidateRefs) {
    if (!consumeMatching((eventId) => ({ eventId, type: 'candidate_recorded', value: candidate }))) return false;
  }
  for (const summary of manifest.issueSummary) {
    if (!consumeMatching((eventId) => ({ eventId, type: 'issues_recorded', value: summary }))) return false;
  }
  if (manifest.usage !== null && !consumeMatching((eventId) => ({
    eventId, type: 'usage_recorded', value: manifest.usage,
  }))) return false;
  if (manifest.selection !== null && !consumeMatching((eventId) => ({
    eventId, type: 'selection_recorded', value: manifest.selection,
  }))) return false;
  if (manifest.winnerAlias !== null) {
    const eventId = `winner:${manifest.winnerAlias.candidateId}:recorded`;
    if (!consumeId(eventId, {
      eventId, type: 'winner_alias_recorded', candidateId: manifest.winnerAlias.candidateId, value: manifest.winnerAlias,
    })) return false;
  }
  for (const cleanup of manifest.cleanup) {
    if (!consumeMatching((eventId) => ({ eventId, type: 'cleanup_recorded', value: cleanup }))) return false;
  }
  return used.size === manifest.appliedEvents.length;
}

export function normalizeRunManifestV1(value) {
  const object = exactObject(value, MANIFEST_KEYS);
  if (object === null || object.schemaVersion !== 1 || !GENERATION_PATTERN.test(object.generation) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(object.runId) || ![1, 2].includes(object.candidateCount) ||
      !safeInteger(object.createdAt) || object.expiresAt !== object.createdAt + RUN_ARTIFACT_RETENTION_MS ||
      !safeInteger(object.revision) || !(object.deadlineAt === null || safeInteger(object.deadlineAt))) return null;
  const initial = normalizeInitialManifest({
    schemaVersion: 1,
    runId: object.runId,
    candidateCount: object.candidateCount,
    baseline: object.baseline,
    frozenTestPlan: object.frozenTestPlan,
    proofRequirement: object.proofRequirement,
    plannerBinding: object.plannerBinding,
    laneBindings: object.laneBindings,
    deadlineAt: object.deadlineAt,
  }, object.runId);
  if (initial === null) return null;
  const appliedRaw = exactDenseArray(object.appliedEvents, 100_000);
  const appliedEvents = appliedRaw?.map((entry) => {
    const item = exactObject(entry, ['eventId', 'eventSha256']);
    return item !== null && EVENT_ID_PATTERN.test(item.eventId) && SHA256_PATTERN.test(item.eventSha256)
      ? { eventId: item.eventId, eventSha256: item.eventSha256 }
      : null;
  }) ?? null;
  const pendingArtifacts = normalizeArrayBy(object.pendingArtifacts, normalizePending);
  const committedArtifacts = normalizeArrayBy(object.committedArtifacts, normalizeCommitted);
  const attempts = normalizeArrayBy(object.attempts, normalizeManifestAttempt, 1_998);
  const evidenceRefs = normalizeArrayBy(object.evidenceRefs, normalizeManifestEvidenceRef, 11_988);
  const candidateRefs = normalizeArrayBy(object.candidateRefs, normalizeCandidateRef, 2);
  const verdictRefs = normalizeArrayBy(object.verdictRefs, normalizeVerdictRef, 1_998);
  const usage = object.usage === null ? null : normalizeUsage(object.usage);
  const issueSummary = normalizeArrayBy(object.issueSummary, normalizeIssueSummary, 2);
  const selection = object.selection === null ? null : normalizeSelection(object.selection);
  const winnerAlias = object.winnerAlias === null ? null : normalizeArtifactRef(object.winnerAlias);
  const cleanup = normalizeArrayBy(object.cleanup, normalizeCleanup, 10_000);
  if (appliedEvents === null || appliedEvents.some((entry) => entry === null) || pendingArtifacts === null ||
      committedArtifacts === null || attempts === null || evidenceRefs === null || candidateRefs === null ||
      verdictRefs === null || usage === null && object.usage !== null || issueSummary === null ||
      selection === null && object.selection !== null || winnerAlias === null && object.winnerAlias !== null || cleanup === null) return null;
  if (object.revision !== appliedEvents.length || new Set(appliedEvents.map((entry) => entry.eventId)).size !== appliedEvents.length ||
      !manifestArraysCanonicallyOrdered({
        appliedEvents, pendingArtifacts, committedArtifacts, attempts, evidenceRefs, candidateRefs, verdictRefs,
        issueSummary, cleanup,
      })) return null;
  const configured = new Set(LANES.slice(0, object.candidateCount));
  const inventories = [...pendingArtifacts, ...committedArtifacts];
  const identityKeys = inventories.map((entry) => identityKey(identityFromInventory(entry)));
  if (new Set(identityKeys).size !== identityKeys.length || new Set(inventories.map((entry) => entry.relativePath)).size !== inventories.length ||
      inventories.some((entry) => !relativeMatchesIdentity({ runId: object.runId }, entry) ||
        !configured.has(candidateForIdentity(identityFromInventory(entry)))) ||
      committedArtifacts.some((entry) => !refSuffixMatches({ runId: object.runId, expiresAt: object.expiresAt }, entry))) return null;
  const appliedIds = new Set(appliedEvents.map((entry) => entry.eventId));
  if (pendingArtifacts.some((entry) => {
    const identity = identityFromInventory(entry);
    return entry.reservedEventId !== expectedArtifactEventId(identity, 'reserved') || !appliedIds.has(entry.reservedEventId);
  }) || committedArtifacts.some((entry) => {
    const identity = identityFromInventory(entry);
    return entry.committedEventId !== expectedArtifactEventId(identity, 'committed') ||
      !appliedIds.has(entry.committedEventId) || !appliedIds.has(expectedArtifactEventId(identity, 'reserved'));
  })) return null;
  if (attempts.some((entry) => !configured.has(entry.laneId) || entry.attemptId !== `${object.runId}/${entry.laneId}/${ordinal(entry.ordinal)}` ||
      entry.retryOf !== (entry.ordinal === 1 ? null : `${object.runId}/${entry.laneId}/${ordinal(entry.ordinal - 1)}`)) ||
      new Set(attempts.map((entry) => `${entry.laneId}:${entry.ordinal}`)).size !== attempts.length) return null;
  if (evidenceRefs.some((entry) => !configured.has(entry.laneId) ||
      entry.evidenceId !== `${entry.attemptId}/${entry.kind.toUpperCase()}/${entry.repetition}`) ||
      new Set(evidenceRefs.map((entry) => entry.evidenceId)).size !== evidenceRefs.length) return null;
  if (candidateRefs.some((entry) => !configured.has(entry.candidateId)) ||
      new Set(candidateRefs.map((entry) => entry.candidateId)).size !== candidateRefs.length ||
      issueSummary.some((entry) => !configured.has(entry.candidateId)) ||
      new Set(issueSummary.map((entry) => entry.candidateId)).size !== issueSummary.length) return null;
  if (new Set(verdictRefs.map((entry) => `${entry.laneId}:${entry.attemptId}`)).size !== verdictRefs.length ||
      new Set(cleanup.map(cleanupKey)).size !== cleanup.length) return null;
  if (selection !== null && candidateRefs.length !== object.candidateCount ||
      winnerAlias !== null && (winnerAlias.kind !== 'winner' || selection === null ||
        selection.selectedCandidateId !== winnerAlias.candidateId)) return null;
  if (selection !== null && !selectionConsistent(selection, candidateRefs, issueSummary, object.candidateCount)) return null;
  const committedFor = (kind, predicate) => committedArtifacts.find((entry) => entry.artifactKind === kind && predicate(entry));
  if (attempts.some((entry) => entry.status === 'terminal' && (() => {
    const committed = committedFor('attempt', (item) => item.laneId === entry.laneId && item.attemptOrdinal === entry.ordinal);
    return committed === undefined || !sameJson(committed.ref, entry.attemptRef) ||
      !appliedIds.has(`attempt:${entry.laneId}:${ordinal(entry.ordinal)}:terminal`);
  })())) return null;
  if (evidenceRefs.some((entry) => !committedArtifacts.some((item) =>
    item.artifactKind === 'evidence' && sameJson(item.ref, entry.ref))) ||
      committedArtifacts.filter((entry) => entry.artifactKind === 'evidence').some((entry) =>
        !evidenceRefs.some((item) => sameJson(item.ref, entry.ref)))) return null;
  if (candidateRefs.some((entry) => entry.patchRef !== null && (() => {
    const committed = committedFor('candidate', (item) => item.laneId === entry.candidateId &&
      item.sourceAttemptId === entry.sourceAttemptId);
    return committed === undefined || !sameJson(committed.ref, entry.patchRef);
  })())) return null;
  if (candidateRefs.some((entry) => entry.sourceAttemptId === null
    ? entry.terminalClass !== 'blocked' || entry.treeHash !== null || entry.patchRef !== null
    : !attempts.some((attempt) => attempt.laneId === entry.candidateId &&
      attempt.attemptId === entry.sourceAttemptId && attempt.status === 'terminal'))) return null;
  if (selection !== null && selection.selectedCandidateId !== null && !candidateRefs.some((entry) =>
    entry.candidateId === selection.selectedCandidateId && entry.patchRef !== null)) return null;
  if (verdictRefs.some((entry) => !attempts.some((attempt) => attempt.laneId === entry.laneId &&
      attempt.attemptId === entry.attemptId && attempt.status === 'terminal')) ||
      winnerAlias !== null && (() => {
        const committed = committedFor('winner', (entry) => entry.candidateId === winnerAlias.candidateId);
        const candidate = candidateRefs.find((entry) => entry.candidateId === winnerAlias.candidateId);
        return committed === undefined || !sameJson(committed.ref, winnerAlias) || candidate === undefined || candidate.patchRef === null ||
          candidate.patchRef.sha256 !== winnerAlias.sha256 || candidate.patchRef.bytes !== winnerAlias.bytes ||
          !appliedIds.has(`winner:${winnerAlias.candidateId}:recorded`);
      })()) return null;
  const transitionUnits = attempts.length + attempts.filter((entry) => entry.status === 'terminal').length +
    pendingArtifacts.length + committedArtifacts.length * 2 + candidateRefs.length + issueSummary.length +
    (usage === null ? 0 : 1) + (selection === null ? 0 : 1) + (winnerAlias === null ? 0 : 1) + cleanup.length;
  if (transitionUnits !== object.revision || !validateManifestEventRelationships({
    appliedEvents, pendingArtifacts, committedArtifacts, attempts, candidateRefs, verdictRefs,
    usage, issueSummary, selection, winnerAlias, cleanup,
  })) return null;
  const normalized = {
    schemaVersion: 1,
    generation: object.generation,
    runId: object.runId,
    candidateCount: object.candidateCount,
    baseline: initial.baseline,
    frozenTestPlan: initial.frozenTestPlan,
    proofRequirement: initial.proofRequirement,
    plannerBinding: initial.plannerBinding,
    laneBindings: initial.laneBindings,
    deadlineAt: initial.deadlineAt,
    createdAt: object.createdAt,
    expiresAt: object.expiresAt,
    revision: object.revision,
    appliedEvents,
    pendingArtifacts,
    committedArtifacts,
    attempts,
    evidenceRefs,
    candidateRefs,
    verdictRefs,
    usage,
    issueSummary,
    selection,
    winnerAlias,
    cleanup,
  };
  if (!sameJson(value, normalized)) return null;
  return deepFreeze(normalized);
}

const TRANSITION_STATE_KEYS = Object.freeze([
  'pendingArtifacts', 'committedArtifacts', 'attempts', 'evidenceRefs', 'candidateRefs', 'verdictRefs',
  'usage', 'issueSummary', 'selection', 'winnerAlias', 'cleanup',
]);

function arrayDelta(before, after) {
  const remaining = [...after];
  for (const entry of before) {
    const index = remaining.findIndex((candidate) => sameJson(candidate, entry));
    if (index < 0) return null;
    remaining.splice(index, 1);
  }
  return remaining;
}

function oneArrayAddition(before, after) {
  if (after.length !== before.length + 1) return null;
  const added = arrayDelta(before, after);
  return added?.length === 1 ? added[0] : null;
}

function oneArrayRemoval(before, after) {
  if (before.length !== after.length + 1) return null;
  const removed = arrayDelta(after, before);
  return removed?.length === 1 ? removed[0] : null;
}

function exactChanges(current, next, expected) {
  const changed = TRANSITION_STATE_KEYS.filter((key) => !sameJson(current[key], next[key]));
  return sameJson([...changed].sort(), [...expected].sort());
}

function validAllocationTransition(current, next) {
  if (!exactChanges(current, next, ['attempts'])) return false;
  const added = oneArrayAddition(current.attempts, next.attempts);
  return added !== null && added.status === 'allocated';
}

function validReservationTransition(current, next, applied) {
  if (!exactChanges(current, next, ['pendingArtifacts'])) return false;
  const added = oneArrayAddition(current.pendingArtifacts, next.pendingArtifacts);
  return added !== null && added.reservedEventId === applied.eventId;
}

function validCommitTransition(current, next, applied) {
  const added = oneArrayAddition(current.committedArtifacts, next.committedArtifacts);
  const removed = oneArrayRemoval(current.pendingArtifacts, next.pendingArtifacts);
  if (added === null || removed === null || added.committedEventId !== applied.eventId ||
      identityKey(identityFromInventory(added)) !== identityKey(identityFromInventory(removed)) ||
      added.relativePath !== removed.relativePath || added.ref.sha256 !== removed.expectedSha256 ||
      added.ref.bytes !== removed.expectedBytes) return false;
  if (added.artifactKind === 'evidence') {
    if (!exactChanges(current, next, ['pendingArtifacts', 'committedArtifacts', 'evidenceRefs'])) return false;
    const evidence = oneArrayAddition(current.evidenceRefs, next.evidenceRefs);
    return evidence !== null && sameJson(evidence.ref, added.ref);
  }
  return exactChanges(current, next, ['pendingArtifacts', 'committedArtifacts']);
}

function validTerminalTransition(current, next, applied) {
  if (!exactChanges(current, next, ['attempts']) &&
      !exactChanges(current, next, ['attempts', 'verdictRefs'])) return false;
  if (current.attempts.length !== next.attempts.length) return false;
  const before = current.attempts.filter((entry, index) => !sameJson(entry, next.attempts[index]));
  const after = next.attempts.filter((entry, index) => !sameJson(entry, current.attempts[index]));
  if (before.length !== 1 || after.length !== 1 || before[0].status !== 'allocated' || after[0].status !== 'terminal' ||
      before[0].laneId !== after[0].laneId || before[0].ordinal !== after[0].ordinal ||
      before[0].attemptId !== after[0].attemptId || before[0].retryOf !== after[0].retryOf ||
      applied.eventId !== `attempt:${after[0].laneId}:${ordinal(after[0].ordinal)}:terminal`) return false;
  if (sameJson(current.verdictRefs, next.verdictRefs)) return true;
  const verdict = oneArrayAddition(current.verdictRefs, next.verdictRefs);
  return verdict !== null && verdict.laneId === after[0].laneId && verdict.attemptId === after[0].attemptId;
}

function validSingleRowTransition(current, next, key) {
  return exactChanges(current, next, [key]) && oneArrayAddition(current[key], next[key]) !== null;
}

function validManifestStateTransition(current, next, applied) {
  if (validAllocationTransition(current, next) || validReservationTransition(current, next, applied) ||
      validCommitTransition(current, next, applied) || validTerminalTransition(current, next, applied)) return true;
  if (validSingleRowTransition(current, next, 'candidateRefs') ||
      validSingleRowTransition(current, next, 'issueSummary') ||
      validSingleRowTransition(current, next, 'cleanup')) return true;
  if (exactChanges(current, next, ['usage'])) return current.usage === null && next.usage !== null;
  if (exactChanges(current, next, ['selection'])) return current.selection === null && next.selection !== null;
  if (exactChanges(current, next, ['winnerAlias'])) {
    return current.winnerAlias === null && next.winnerAlias !== null &&
      applied.eventId === `winner:${next.winnerAlias.candidateId}:recorded`;
  }
  return false;
}

export function validateRunManifestTransitionV1(currentValue, nextValue) {
  const current = normalizeRunManifestV1(currentValue);
  const next = normalizeRunManifestV1(nextValue);
  if (current === null || next === null || next.revision !== current.revision + 1) return null;
  const immutableKeys = MANIFEST_KEYS.slice(0, MANIFEST_KEYS.indexOf('revision'));
  if (immutableKeys.some((key) => !sameJson(current[key], next[key]))) return null;
  const currentEvents = new Map(current.appliedEvents.map((entry) => [entry.eventId, entry]));
  if (next.appliedEvents.length !== current.appliedEvents.length + 1 ||
      current.appliedEvents.some((entry) => !sameJson(entry, next.appliedEvents.find((item) => item.eventId === entry.eventId)))) return null;
  const addedEvents = next.appliedEvents.filter((entry) => !currentEvents.has(entry.eventId));
  if (addedEvents.length !== 1 || !validManifestStateTransition(current, next, addedEvents[0])) return null;
  return next;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeVerdictValue(value) {
  if (value === null) return null;
  const object = exactObject(value, ['verdict', 'issueIds']);
  const issueIds = normalizeStringArray(object?.issueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  return object !== null && ['PASS', 'FAIL'].includes(object.verdict) && issueIds !== null
    ? { verdict: object.verdict, issueIds }
    : undefined;
}

function normalizeAttemptRecord(value, state, laneId, attemptOrdinal) {
  const object = exactObject(value, [
    'schemaVersion', 'laneId', 'attemptId', 'ordinal', 'retryOf', 'binding', 'writerResult', 'sealed',
    'verdictRef', 'usage', 'result', 'feedback',
  ]);
  const expectedId = `${state.runId}/${laneId}/${ordinal(attemptOrdinal)}`;
  const binding = normalizeLaneBinding(object?.binding);
  const writerResults = ['sealed', 'provider_failed', 'timeout', 'effect_unknown', 'snapshot_failed', 'seal_failed'];
  const results = ['accepted', 'repair', 'rejected', 'blocked', 'stagnated'];
  const verdictRef = normalizeVerdictValue(object?.verdictRef);
  const usageObject = exactObject(object?.usage, ['writer', 'verifier']);
  const writerUsage = normalizeUsage(usageObject?.writer);
  const verifierUsage = normalizeUsage(usageObject?.verifier);
  const feedbackObject = exactObject(object?.feedback, ['openIssueIds']);
  const feedbackIds = normalizeStringArray(feedbackObject?.openIssueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  if (object === null || object.schemaVersion !== 1 || object.laneId !== laneId || object.attemptId !== expectedId ||
      object.ordinal !== attemptOrdinal || object.retryOf !== (attemptOrdinal === 1 ? null : `${state.runId}/${laneId}/${ordinal(attemptOrdinal - 1)}`) ||
      binding === null || !sameJson(binding, state.initial.laneBindings[LANES.indexOf(laneId)]?.binding) ||
      !writerResults.includes(object.writerResult) || verdictRef === undefined || usageObject === null ||
      writerUsage === null || verifierUsage === null || !results.includes(object.result) || feedbackObject === null || feedbackIds === null) return null;
  let sealed = null;
  if (object.sealed !== null) {
    const sealedObject = exactObject(object.sealed, [
      'commit', 'treeHash', 'patchSha256', 'testPlanFingerprint', 'evidenceIds',
    ]);
    const evidenceIds = normalizeStringArray(sealedObject?.evidenceIds, { max: 20, sort: false });
    if (sealedObject === null || !OBJECT_ID_PATTERN.test(sealedObject.commit) || !OBJECT_ID_PATTERN.test(sealedObject.treeHash) ||
        !SHA256_PATTERN.test(sealedObject.patchSha256) || sealedObject.testPlanFingerprint !== state.initial.frozenTestPlan.planFingerprint ||
        evidenceIds === null || evidenceIds.some((id) => !/^.+\/(?:B0|BR|C)\/[12]$/.test(id))) return null;
    const persistedIds = state.manifest.evidenceRefs
      .filter((entry) => entry.laneId === laneId && entry.attemptId === expectedId)
      .map((entry) => entry.evidenceId);
    if (!sameJson(evidenceIds, persistedIds)) return null;
    sealed = {
      commit: sealedObject.commit,
      treeHash: sealedObject.treeHash,
      patchSha256: sealedObject.patchSha256,
      testPlanFingerprint: sealedObject.testPlanFingerprint,
      evidenceIds,
    };
  }
  if (object.writerResult === 'sealed' !== (sealed !== null) || object.result === 'accepted' && verdictRef?.verdict !== 'PASS') return null;
  return {
    schemaVersion: 1,
    laneId,
    attemptId: expectedId,
    ordinal: attemptOrdinal,
    retryOf: object.retryOf,
    binding,
    writerResult: object.writerResult,
    sealed,
    verdictRef,
    usage: { writer: writerUsage, verifier: verifierUsage },
    result: object.result,
    feedback: { openIssueIds: feedbackIds },
  };
}

async function verifySealedEvidenceAuthority(record, state, laneId, attemptOrdinal) {
  if (record.sealed === null) return true;
  const attemptId = `${state.runId}/${laneId}/${ordinal(attemptOrdinal)}`;
  const evidenceRefs = state.manifest.evidenceRefs
    .filter((entry) => entry.laneId === laneId && entry.attemptId === attemptId);
  if (!sameJson(record.sealed.evidenceIds, evidenceRefs.map((entry) => entry.evidenceId))) return false;
  for (let index = 0; index < evidenceRefs.length; index += 1) {
    const entry = evidenceRefs[index];
    const committed = state.manifest.committedArtifacts.find((item) =>
      item.artifactKind === 'evidence' && item.laneId === laneId && item.attemptOrdinal === attemptOrdinal &&
      sameJson(item.ref, entry.ref)) ?? null;
    const identity = committed === null ? null : identityFromInventory(committed);
    const expectedPath = identity === null ? null : finalPathForIdentity(state, identity);
    if (committed === null || expectedPath === null || !sameJson(committed.ref, entry.ref) ||
        !await verifyImmutableRef(entry.ref, expectedPath, state)) return false;
    const persisted = await readJsonRecord(expectedPath, MAX_JSON_ARTIFACT_BYTES, state);
    if (persisted === null || persisted.bytes.length !== entry.ref.bytes || sha256(persisted.bytes) !== entry.ref.sha256) return false;
    const evidence = normalizeEvidenceRecord(persisted.value, state, laneId, attemptOrdinal);
    if (evidence === null || evidence.evidenceId !== record.sealed.evidenceIds[index] ||
        evidence.attemptId !== record.attemptId || evidence.candidateRevision !== record.sealed.commit ||
        evidence.candidateTree !== record.sealed.treeHash || evidence.candidatePatchSha256 !== record.sealed.patchSha256 ||
        evidence.testPlanFingerprint !== record.sealed.testPlanFingerprint ||
        evidence.environmentFingerprint !== state.initial.frozenTestPlan.environmentFingerprint) return false;
  }
  return true;
}

function normalizeClassified(value, record) {
  const object = exactObject(value, [
    'execution', 'outcome', 'failureKind', 'stability', 'reproduction', 'witnessIds', 'failureFingerprints',
    'outputSha256', 'outputChars', 'planFingerprint', 'environmentFingerprint', 'truncated', 'diagnostics',
  ]);
  const witnesses = normalizeStringArray(object?.witnessIds, { max: 20_000, pattern: SHA256_PATTERN });
  const failures = normalizeStringArray(object?.failureFingerprints, { max: 20_000, pattern: SHA256_PATTERN });
  const diagnostics = normalizeStringArray(object?.diagnostics, { max: 8, pattern: /^[a-z0-9_]{1,64}$/ });
  if (object === null || !['completed', 'not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(object.execution) ||
      !['pass', 'fail', 'unknown'].includes(object.outcome) ||
      !['assertion', 'collection', 'compile', 'dependency', 'infrastructure', 'unknown'].includes(object.failureKind) ||
      !['stable', 'flaky', 'unknown'].includes(object.stability) || typeof object.reproduction !== 'boolean' ||
      witnesses === null || failures === null || !(object.outputSha256 === null || SHA256_PATTERN.test(object.outputSha256)) ||
      !safeInteger(object.outputChars) || object.planFingerprint !== record.testPlanFingerprint ||
      object.environmentFingerprint !== record.environmentFingerprint || typeof object.truncated !== 'boolean' || diagnostics === null) return null;
  return {
    execution: object.execution,
    outcome: object.outcome,
    failureKind: object.failureKind,
    stability: object.stability,
    reproduction: object.reproduction,
    witnessIds: witnesses,
    failureFingerprints: failures,
    outputSha256: object.outputSha256,
    outputChars: object.outputChars,
    planFingerprint: object.planFingerprint,
    environmentFingerprint: object.environmentFingerprint,
    truncated: object.truncated,
    diagnostics,
  };
}

function normalizeEvidenceRecord(value, state, laneId, attemptOrdinal) {
  const object = exactObject(value, [
    'schemaVersion', 'evidenceId', 'attemptId', 'kind', 'repetition', 'baselineRevision', 'baselineTree',
    'candidateRevision', 'candidateTree', 'candidatePatchSha256', 'testPlanFingerprint', 'environmentFingerprint',
    'testDeltaSha256', 'classified',
  ]);
  const attemptId = `${state.runId}/${laneId}/${ordinal(attemptOrdinal)}`;
  if (object === null || object.schemaVersion !== 1 || object.attemptId !== attemptId || !['b0', 'br', 'c'].includes(object.kind) ||
      ![1, 2].includes(object.repetition) || object.evidenceId !== `${attemptId}/${object.kind.toUpperCase()}/${object.repetition}` ||
      object.baselineRevision !== state.initial.baseline.commit || object.baselineTree !== state.initial.baseline.tree ||
      !OBJECT_ID_PATTERN.test(object.candidateRevision) || !OBJECT_ID_PATTERN.test(object.candidateTree) ||
      !SHA256_PATTERN.test(object.candidatePatchSha256) || object.testPlanFingerprint !== state.initial.frozenTestPlan.planFingerprint ||
      object.environmentFingerprint !== state.initial.frozenTestPlan.environmentFingerprint ||
      !(object.testDeltaSha256 === null || SHA256_PATTERN.test(object.testDeltaSha256)) || object.kind === 'b0' && object.testDeltaSha256 !== null) return null;
  const classified = normalizeClassified(object.classified, object);
  if (classified === null) return null;
  return {
    schemaVersion: 1,
    evidenceId: object.evidenceId,
    attemptId,
    kind: object.kind,
    repetition: object.repetition,
    baselineRevision: object.baselineRevision,
    baselineTree: object.baselineTree,
    candidateRevision: object.candidateRevision,
    candidateTree: object.candidateTree,
    candidatePatchSha256: object.candidatePatchSha256,
    testPlanFingerprint: object.testPlanFingerprint,
    environmentFingerprint: object.environmentFingerprint,
    testDeltaSha256: object.testDeltaSha256,
    classified,
  };
}

async function readJsonRecord(path, maxBytes, state) {
  try {
    if (!await verifyStorePath(path, 'file', state)) return null;
    const info = await state.deps.lstat(path);
    if (!safeInteger(info.size) || info.size <= 0 || info.size > maxBytes) return null;
    const bytes = await state.deps.readFile(path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== info.size || !bytes.equals(Buffer.from(bytes.toString('utf8'), 'utf8'))) return null;
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return null;
  }
}

async function verifyImmutableRef(ref, expectedPath, state) {
  if (!samePath(ref.path, expectedPath) || ref.expiresAt !== state.expiresAt) return false;
  try {
    if (!await verifyStorePath(expectedPath, 'file', state)) return false;
    const info = await state.deps.lstat(expectedPath);
    if (info.size !== ref.bytes) return false;
    const bytes = await state.deps.readFile(expectedPath);
    return Buffer.isBuffer(bytes) && bytes.length === ref.bytes && sha256(bytes) === ref.sha256;
  } catch {
    return false;
  }
}

function expectedArtifactEventId(identity, phase) {
  if (identity.artifactKind === 'attempt') {
    return `artifact:attempt:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:${phase}`;
  }
  if (identity.artifactKind === 'evidence') {
    return `artifact:evidence:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:${ordinal(identity.evidenceOrdinal)}:${phase}`;
  }
  if (identity.artifactKind === 'candidate') return `artifact:candidate:${identity.laneId}:${phase}`;
  return `artifact:winner:${identity.candidateId}:${phase}`;
}

function configuredLane(state, laneId) {
  return LANES.slice(0, state.candidateCount).includes(laneId);
}

function attemptEntry(manifest, laneId, ordinalValue) {
  return manifest.attempts.find((entry) => entry.laneId === laneId && entry.ordinal === ordinalValue) ?? null;
}

function committedEntry(manifest, identity) {
  const key = identityKey(identity);
  return manifest.committedArtifacts.find((entry) => identityKey(identityFromInventory(entry)) === key) ?? null;
}

function pendingEntry(manifest, identity) {
  const key = identityKey(identity);
  return manifest.pendingArtifacts.find((entry) => identityKey(identityFromInventory(entry)) === key) ?? null;
}

function normalizeArtifactEvent(value, type) {
  let kind;
  try {
    kind = Object.getOwnPropertyDescriptor(value, 'artifactKind')?.value;
  } catch {
    return null;
  }
  const identityKeys = kind === 'attempt' ? ['artifactKind', 'laneId', 'attemptOrdinal']
    : kind === 'evidence' ? ['artifactKind', 'laneId', 'attemptOrdinal', 'evidenceOrdinal']
      : kind === 'candidate' ? ['artifactKind', 'laneId', 'sourceAttemptId']
        : kind === 'winner' ? ['artifactKind', 'candidateId'] : null;
  if (identityKeys === null) return null;
  const tail = type === 'artifact_reserved'
    ? ['relativePath', 'tempRelativePath', 'expectedSha256', 'expectedBytes']
    : ['relativePath', 'ref'];
  const object = exactObject(value, ['eventId', 'type', ...tail, ...identityKeys]);
  if (object === null || object.type !== type || !EVENT_ID_PATTERN.test(object.eventId)) return null;
  const identity = artifactIdentity(Object.fromEntries(identityKeys.map((key) => [key, object[key]])));
  if (identity === null || object.eventId !== expectedArtifactEventId(identity, type === 'artifact_reserved' ? 'reserved' : 'committed')) return null;
  if (type === 'artifact_reserved') {
    if (!boundedString(object.relativePath, 32_768) || !boundedString(object.tempRelativePath, 32_768) ||
        !SHA256_PATTERN.test(object.expectedSha256) || !safeInteger(object.expectedBytes)) return null;
    return {
      eventId: object.eventId,
      type,
      ...identityFields(identity),
      relativePath: object.relativePath,
      tempRelativePath: object.tempRelativePath,
      expectedSha256: object.expectedSha256,
      expectedBytes: object.expectedBytes,
    };
  }
  const ref = normalizeArtifactRef(object.ref);
  if (ref === null) return null;
  return { eventId: object.eventId, type, ...identityFields(identity), relativePath: object.relativePath, ref };
}

function normalizeEvent(value, state) {
  let type;
  try {
    type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
  } catch {
    return null;
  }
  if (type === 'artifact_reserved' || type === 'artifact_committed') return normalizeArtifactEvent(value, type);
  if (type === 'attempt_allocated') {
    const object = exactObject(value, ['eventId', 'type', 'laneId', 'ordinal', 'attemptId', 'retryOf']);
    if (object === null || !EVENT_ID_PATTERN.test(object.eventId) || !configuredLane(state, object.laneId) ||
        !validOrdinal(object.ordinal) || object.attemptId !== `${state.runId}/${object.laneId}/${ordinal(object.ordinal)}` ||
        object.retryOf !== (object.ordinal === 1 ? null : `${state.runId}/${object.laneId}/${ordinal(object.ordinal - 1)}`)) return null;
    return {
      eventId: object.eventId, type, laneId: object.laneId, ordinal: object.ordinal,
      attemptId: object.attemptId, retryOf: object.retryOf,
    };
  }
  if (type === 'attempt_terminal') {
    const object = exactObject(value, ['eventId', 'type', 'laneId', 'ordinal', 'attemptId', 'attemptRef', 'result', 'verdictRef']);
    const ref = normalizeArtifactRef(object?.attemptRef);
    const verdictRef = normalizeVerdictValue(object?.verdictRef);
    if (object === null || !EVENT_ID_PATTERN.test(object.eventId) || !configuredLane(state, object.laneId) ||
        !validOrdinal(object.ordinal) || object.attemptId !== `${state.runId}/${object.laneId}/${ordinal(object.ordinal)}` ||
        ref === null || ref.kind !== 'attempt' || ref.candidateId !== object.laneId ||
        !['accepted', 'repair', 'rejected', 'blocked', 'stagnated'].includes(object.result) || verdictRef === undefined) return null;
    return {
      eventId: object.eventId, type, laneId: object.laneId, ordinal: object.ordinal,
      attemptId: object.attemptId, attemptRef: ref, result: object.result, verdictRef,
    };
  }
  if (type === 'candidate_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']);
    const candidate = normalizeCandidateRef(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && candidate !== null
      ? { eventId: object.eventId, type, value: candidate }
      : null;
  }
  if (type === 'issues_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']);
    const summary = normalizeIssueSummary(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && summary !== null
      ? { eventId: object.eventId, type, value: summary }
      : null;
  }
  if (type === 'usage_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']);
    const usage = normalizeUsage(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && usage !== null
      ? { eventId: object.eventId, type, value: usage }
      : null;
  }
  if (type === 'selection_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']);
    const selection = normalizeSelection(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && selection !== null
      ? { eventId: object.eventId, type, value: selection }
      : null;
  }
  if (type === 'winner_alias_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'candidateId', 'value']);
    const ref = normalizeArtifactRef(object?.value);
    return object !== null && object.eventId === `winner:${object.candidateId}:recorded` && validLane(object.candidateId) &&
      ref !== null && ref.kind === 'winner' && ref.candidateId === object.candidateId
      ? { eventId: object.eventId, type, candidateId: object.candidateId, value: ref }
      : null;
  }
  if (type === 'cleanup_recorded') {
    const object = exactObject(value, ['eventId', 'type', 'value']);
    const cleanup = normalizeCleanup(object?.value);
    return object !== null && EVENT_ID_PATTERN.test(object.eventId) && cleanup !== null
      ? { eventId: object.eventId, type, value: cleanup }
      : null;
  }
  return null;
}

function logicalControllerPath(value, stateRoot) {
  if (typeof value !== 'string' || stateRoot === null || !isAbsolute(value)) return null;
  const relativePath = relativeJson(stateRoot, resolve(value));
  if (relativePath === null || !['runs', 'patches', 'worktrees', 'plans'].includes(relativePath.split('/')[0]) ||
      /[\u0000-\u001f\u007f\uFFFD]/.test(relativePath)) return null;
  return `<STATE_ROOT>/${relativePath}`;
}

function logicalEventValue(value, stateRoot, key = null) {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => logicalEventValue(entry, stateRoot));
    return entries.some((entry) => entry === undefined) ? undefined : entries;
  }
  if (value === null || typeof value !== 'object') {
    if ((key === 'path' || key === 'recoveryPath') && value !== null) {
      return logicalControllerPath(value, stateRoot) ?? undefined;
    }
    return value;
  }
  const entries = Object.entries(value).map(([name, entry]) => [name, logicalEventValue(entry, stateRoot, name)]);
  return entries.some(([, entry]) => entry === undefined) ? undefined : Object.fromEntries(entries);
}

function eventDigest(event, stateRoot = null) {
  const logical = logicalEventValue(event, stateRoot);
  return logical === undefined ? null : sha256(Buffer.from(JSON.stringify(logical), 'utf8'));
}

function eventDigestMatches(actual, event, stateRoot) {
  const logical = eventDigest(event, stateRoot);
  if (logical === actual) return true;
  return sha256(Buffer.from(JSON.stringify(event), 'utf8')) === actual;
}

function exactCanonicalPath(value) {
  return typeof value === 'string' && isAbsolute(value) && value === resolve(value);
}

function validateCleanupPathAgainstState(cleanup, state) {
  const relativePath = relativeJson(state.stateRoot, cleanup.path);
  const expectedTop = cleanup.kind === 'planner' ? 'plans' : 'worktrees';
  const parts = relativePath?.split('/') ?? [];
  const expected = parts.length === 2 ? join(state.stateRoot, ...parts) : null;
  return exactCanonicalPath(cleanup.path) && expected !== null && cleanup.path === expected && parts[0] === expectedTop &&
    (cleanup.status === 'removed' ? cleanup.recoveryPath === null :
      exactCanonicalPath(cleanup.recoveryPath) && cleanup.recoveryPath === cleanup.path);
}

function validateEventPathsAgainstState(event, state) {
  if (event.type === 'artifact_committed') {
    const identity = artifactIdentity(identityFields(event));
    const expected = identity === null ? null : finalPathForIdentity(state, identity);
    return expected !== null && exactCanonicalPath(event.ref.path) && event.ref.path === expected &&
      event.relativePath === relativeJson(state.stateRoot, expected);
  }
  if (event.type === 'attempt_terminal') {
    const expected = finalPathForIdentity(state, {
      artifactKind: 'attempt', laneId: event.laneId, attemptOrdinal: event.ordinal,
    });
    return exactCanonicalPath(event.attemptRef.path) && event.attemptRef.path === expected;
  }
  if (event.type === 'candidate_recorded' && event.value.patchRef !== null) {
    const expected = state.paths.candidatePaths[event.value.candidateId] ?? null;
    return expected !== null && exactCanonicalPath(event.value.patchRef.path) && event.value.patchRef.path === expected;
  }
  if (event.type === 'winner_alias_recorded') {
    return exactCanonicalPath(event.value.path) && event.value.path === state.paths.winnerAliasPath;
  }
  if (event.type === 'cleanup_recorded') {
    return validateCleanupPathAgainstState(event.value, state);
  }
  return true;
}

function manifestPathsBoundToState(manifest, state) {
  if (manifest.committedArtifacts.some((entry) =>
    !samePath(resolve(entry.ref.path), resolve(join(state.stateRoot, ...entry.relativePath.split('/')))))) return false;
  return manifest.cleanup.every((entry) => validateCleanupPathAgainstState(entry, state));
}

async function loadCurrentManifest(state) {
  try {
    if (!await verifyStorePath(state.paths.manifestPath, 'file', state)) return null;
    const info = await state.deps.lstat(state.paths.manifestPath);
    if (!sameIdentity(info, state.manifestIdentity) || !safeInteger(info.size) ||
        info.size <= 0 || info.size > MAX_RUN_MANIFEST_BYTES) return null;
    const bytes = await state.deps.readFile(state.paths.manifestPath);
    if (!Buffer.isBuffer(bytes) || bytes.length !== info.size || sha256(bytes) !== state.manifestHash) return null;
    const normalized = normalizeRunManifestV1(JSON.parse(bytes.toString('utf8')));
    if (normalized === null || normalized.runId !== state.runId || normalized.generation !== state.generation ||
        normalized.revision !== state.manifest.revision || normalized.createdAt !== state.createdAt ||
        normalized.expiresAt !== state.expiresAt || !manifestPathsBoundToState(normalized, state)) return null;
    return { manifest: normalized, bytes };
  } catch {
    return null;
  }
}

function identityFromEvent(event) {
  return artifactIdentity(identityFields(event));
}

function exactTempForEvent(state, identity, relativePathValue, tempRelativePath) {
  const finalPath = finalPathForIdentity(state, identity);
  if (finalPath === null || relativeJson(state.stateRoot, finalPath) !== relativePathValue) return false;
  const finalBase = basename(finalPath);
  const tempPath = join(dirname(finalPath), `.tmp-${finalBase}-${state.deps.pid}-${tempRelativePath.slice(-12)}`);
  return GENERATION_PATTERN.test(tempRelativePath.slice(-12)) &&
    relativeJson(state.stateRoot, tempPath) === tempRelativePath &&
    /^\d+$/.test(String(state.deps.pid));
}

async function requireAbsent(path, state) {
  const status = await lstatAbsent(path, state.deps);
  return status.exists === false;
}

async function applyReserved(manifest, event, state) {
  const identity = identityFromEvent(event);
  if (identity === null || !configuredLane(state, candidateForIdentity(identity)) ||
      !exactTempForEvent(state, identity, event.relativePath, event.tempRelativePath) ||
      pendingEntry(manifest, identity) !== null || committedEntry(manifest, identity) !== null ||
      manifest.pendingArtifacts.some((entry) => entry.relativePath === event.relativePath || entry.tempRelativePath === event.tempRelativePath) ||
      manifest.committedArtifacts.some((entry) => entry.relativePath === event.relativePath)) return false;
  if (identity.artifactKind === 'attempt' || identity.artifactKind === 'evidence') {
    if (attemptEntry(manifest, identity.laneId, identity.attemptOrdinal) === null) return false;
    if (event.expectedBytes > MAX_JSON_ARTIFACT_BYTES) return false;
  }
  if (identity.artifactKind === 'candidate') {
    const attempt = manifest.attempts.find((entry) => entry.attemptId === identity.sourceAttemptId &&
      entry.laneId === identity.laneId && entry.status === 'terminal');
    if (!attempt) return false;
  }
  if (identity.artifactKind === 'winner' &&
      (manifest.selection === null || manifest.selection.selectedCandidateId !== identity.candidateId)) return false;
  const finalPath = finalPathForIdentity(state, identity);
  const tempPath = join(state.stateRoot, ...event.tempRelativePath.split('/'));
  if (!await requireAbsent(finalPath, state) || !await requireAbsent(tempPath, state)) return false;
  manifest.pendingArtifacts.push({
    ...identityFields(identity),
    relativePath: event.relativePath,
    tempRelativePath: event.tempRelativePath,
    expectedSha256: event.expectedSha256,
    expectedBytes: event.expectedBytes,
    reservedEventId: event.eventId,
  });
  return true;
}

async function applyCommitted(manifest, event, state) {
  const identity = identityFromEvent(event);
  const pending = identity === null ? null : pendingEntry(manifest, identity);
  if (identity === null || pending === null || event.relativePath !== pending.relativePath ||
      event.ref.kind !== artifactKindForIdentity(identity) || event.ref.candidateId !== candidateForIdentity(identity) ||
      event.ref.sha256 !== pending.expectedSha256 || event.ref.bytes !== pending.expectedBytes ||
      event.ref.expiresAt !== state.expiresAt) return false;
  const finalPath = finalPathForIdentity(state, identity);
  const tempPath = join(state.stateRoot, ...pending.tempRelativePath.split('/'));
  if (!await requireAbsent(tempPath, state) || !await verifyImmutableRef(event.ref, finalPath, state)) return false;
  if (identity.artifactKind === 'evidence') {
    const record = await readJsonRecord(finalPath, MAX_JSON_ARTIFACT_BYTES, state);
    const normalized = record === null ? null : normalizeEvidenceRecord(record.value, state, identity.laneId, identity.attemptOrdinal);
    if (normalized === null || sha256(record.bytes) !== event.ref.sha256 || record.bytes.length !== event.ref.bytes ||
        manifest.evidenceRefs.some((entry) => entry.evidenceId === normalized.evidenceId)) return false;
    manifest.evidenceRefs.push({
      laneId: identity.laneId,
      attemptId: normalized.attemptId,
      evidenceId: normalized.evidenceId,
      kind: normalized.kind,
      repetition: normalized.repetition,
      ref: event.ref,
    });
  }
  manifest.pendingArtifacts = manifest.pendingArtifacts.filter((entry) =>
    identityKey(identityFromInventory(entry)) !== identityKey(identity));
  manifest.committedArtifacts.push({
    ...identityFields(identity),
    relativePath: event.relativePath,
    ref: event.ref,
    committedEventId: event.eventId,
  });
  return true;
}

async function applyAttemptTerminal(manifest, event, state) {
  const attempt = attemptEntry(manifest, event.laneId, event.ordinal);
  const identity = { artifactKind: 'attempt', laneId: event.laneId, attemptOrdinal: event.ordinal };
  const committed = committedEntry(manifest, identity);
  if (attempt === null || attempt.status !== 'allocated' || committed === null || !sameJson(event.attemptRef, committed.ref) ||
      !await verifyImmutableRef(event.attemptRef, finalPathForIdentity(state, identity), state)) return false;
  const record = await readJsonRecord(event.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
  const normalized = record === null ? null : normalizeAttemptRecord(record.value, state, event.laneId, event.ordinal);
  if (normalized === null || sha256(record.bytes) !== event.attemptRef.sha256 || record.bytes.length !== event.attemptRef.bytes ||
      normalized.result !== event.result || !sameJson(normalized.verdictRef, event.verdictRef) ||
      !await verifySealedEvidenceAuthority(normalized, state, event.laneId, event.ordinal)) return false;
  attempt.status = 'terminal';
  attempt.attemptRef = event.attemptRef;
  attempt.result = event.result;
  if (event.verdictRef !== null) {
    manifest.verdictRefs.push({
      laneId: event.laneId,
      attemptId: event.attemptId,
      verdict: event.verdictRef.verdict,
      issueIds: event.verdictRef.issueIds,
    });
  }
  return true;
}

async function applyCandidateRecorded(manifest, event, state) {
  const candidate = event.value;
  if (!configuredLane(state, candidate.candidateId) ||
      manifest.candidateRefs.some((entry) => entry.candidateId === candidate.candidateId)) return false;
  if (candidate.patchRef !== null) {
    const identity = { artifactKind: 'candidate', laneId: candidate.candidateId, sourceAttemptId: candidate.sourceAttemptId };
    const committed = committedEntry(manifest, identity);
    const attempt = manifest.attempts.find((entry) => entry.attemptId === candidate.sourceAttemptId && entry.status === 'terminal');
    if (committed === null || attempt === undefined || !sameJson(committed.ref, candidate.patchRef)) return false;
    const record = await readJsonRecord(attempt.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
    const normalized = record === null ? null : normalizeAttemptRecord(record.value, state, candidate.candidateId, attempt.ordinal);
    if (normalized?.sealed === null || normalized.sealed.treeHash !== candidate.treeHash ||
        normalized.sealed.patchSha256 !== candidate.patchRef.sha256) return false;
  } else if (candidate.sourceAttemptId === null) {
    if (!(candidate.terminalClass === 'blocked' && candidate.treeHash === null)) return false;
  } else {
    const attempt = manifest.attempts.find((entry) => entry.laneId === candidate.candidateId &&
      entry.attemptId === candidate.sourceAttemptId && entry.status === 'terminal');
    if (!attempt?.attemptRef) return false;
    const record = await readJsonRecord(attempt.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
    const normalized = record === null ? null : normalizeAttemptRecord(record.value, state, candidate.candidateId, attempt.ordinal);
    if (normalized?.sealed === null || normalized.sealed.treeHash !== candidate.treeHash) return false;
  }
  manifest.candidateRefs.push(candidate);
  return true;
}

function cleanupKey(value) {
  return `${value.kind}\0${value.candidateId ?? ''}\0${value.attemptId ?? ''}\0${value.path}`;
}

async function applyEvent(manifest, event, state) {
  if (event.type === 'attempt_allocated') {
    if (attemptEntry(manifest, event.laneId, event.ordinal) !== null ||
        event.ordinal > 1 && attemptEntry(manifest, event.laneId, event.ordinal - 1)?.status !== 'terminal') return false;
    manifest.attempts.push({
      laneId: event.laneId,
      ordinal: event.ordinal,
      attemptId: event.attemptId,
      retryOf: event.retryOf,
      status: 'allocated',
      attemptRef: null,
      result: null,
    });
    return true;
  }
  if (event.type === 'artifact_reserved') return applyReserved(manifest, event, state);
  if (event.type === 'artifact_committed') return applyCommitted(manifest, event, state);
  if (event.type === 'attempt_terminal') return applyAttemptTerminal(manifest, event, state);
  if (event.type === 'candidate_recorded') return applyCandidateRecorded(manifest, event, state);
  if (event.type === 'issues_recorded') {
    if (!configuredLane(state, event.value.candidateId) ||
        manifest.issueSummary.some((entry) => entry.candidateId === event.value.candidateId)) return false;
    manifest.issueSummary.push(event.value);
    return true;
  }
  if (event.type === 'usage_recorded') {
    if (manifest.usage !== null) return false;
    manifest.usage = event.value;
    return true;
  }
  if (event.type === 'selection_recorded') {
    if (manifest.selection !== null || manifest.candidateRefs.length !== state.candidateCount ||
        !completeIssueSummary(manifest.candidateRefs, manifest.issueSummary, state.candidateCount) ||
        event.value.selectedCandidateId !== null && !manifest.candidateRefs.some((entry) =>
          entry.candidateId === event.value.selectedCandidateId && entry.patchRef !== null)) return false;
    manifest.selection = event.value;
    return true;
  }
  if (event.type === 'winner_alias_recorded') {
    if (manifest.winnerAlias !== null || manifest.selection?.selectedCandidateId !== event.candidateId) return false;
    const candidate = manifest.candidateRefs.find((entry) => entry.candidateId === event.candidateId);
    const winner = committedEntry(manifest, { artifactKind: 'winner', candidateId: event.candidateId });
    if (candidate?.patchRef === null || winner === null || !sameJson(winner.ref, event.value) ||
        event.value.path === candidate.patchRef.path || event.value.sha256 !== candidate.patchRef.sha256 ||
        event.value.bytes !== candidate.patchRef.bytes) return false;
    manifest.winnerAlias = event.value;
    return true;
  }
  if (event.type === 'cleanup_recorded') {
    if (manifest.cleanup.some((entry) => cleanupKey(entry) === cleanupKey(event.value))) return false;
    manifest.cleanup.push(event.value);
    return true;
  }
  return false;
}

function sortManifest(manifest) {
  manifest.appliedEvents.sort(compareAppliedEvents);
  manifest.pendingArtifacts.sort(compareInventoryEntries);
  manifest.committedArtifacts.sort(compareInventoryEntries);
  manifest.attempts.sort(compareAttempts);
  manifest.evidenceRefs.sort(compareEvidenceRefs);
  manifest.candidateRefs.sort(compareCandidateRefs);
  manifest.verdictRefs.sort(compareVerdictRefs);
  manifest.issueSummary.sort(compareIssueSummaries);
  manifest.cleanup.sort(compareCleanup);
}

async function publishManifestRevision(state, next) {
  if (state.poisoned || state.checkpointTemp !== null) return null;
  const normalized = normalizeRunManifestV1(next);
  if (normalized === null) return null;
  const bytes = jsonBytes(normalized);
  if (bytes === null || bytes.length > MAX_RUN_MANIFEST_BYTES) return null;
  let tempGeneration;
  try {
    tempGeneration = state.deps.randomHex12();
  } catch {
    return null;
  }
  if (!GENERATION_PATTERN.test(tempGeneration)) return null;
  const tempPath = join(dirname(state.paths.manifestPath), `.tmp-manifest.json-${state.deps.pid}-${tempGeneration}`);
  state.checkpointTemp = { path: tempPath, identity: null, verified: false };
  const owned = await openOwnedEmptyFile(tempPath, state.deps, (identity) => {
    state.checkpointTemp.identity = identity;
  });
  if (owned === null) return poisonCheckpoint(state);
  state.checkpointTemp.verified = true;
  if (!await writeSyncClose(owned, bytes) || !await verifyOwnedBytes(tempPath, bytes, state.deps)) {
    return poisonCheckpoint(state);
  }
  try {
    await state.deps.crashBarrier?.('after-checkpoint-temp');
  } catch {
    return poisonCheckpoint(state);
  }
  let replaced;
  try {
    replaced = await state.deps.replaceFileAtomic(tempPath, state.paths.manifestPath);
  } catch {
    return poisonCheckpoint(state);
  }
  if (replaced?.ok !== true) return poisonCheckpoint(state);
  if (!await secureAndVerify(state.paths.manifestPath, 'file', 'published', state.deps) ||
      !await verifyOwnedBytes(state.paths.manifestPath, bytes, state.deps) ||
      !await syncDirectory(dirname(state.paths.manifestPath), state.deps)) return poisonCheckpoint(state);
  let manifestIdentity;
  try {
    manifestIdentity = await state.deps.lstat(state.paths.manifestPath);
  } catch {
    return poisonCheckpoint(state);
  }
  if (!sameIdentity(manifestIdentity, state.checkpointTemp.identity)) return poisonCheckpoint(state);
  state.manifest = normalized;
  state.manifestBytes = bytes;
  state.manifestHash = sha256(bytes);
  state.manifestIdentity = manifestIdentity;
  state.checkpointTemp = null;
  try {
    await state.deps.crashBarrier?.('after-checkpoint-published');
  } catch {
    return poisonCheckpoint(state);
  }
  return normalized;
}

function poisonCheckpoint(state) {
  state.poisoned = true;
  return null;
}

async function checkpointNow(state, rawEvent) {
  if (state.poisoned) return blocked('artifact_store_poisoned');
  const current = await loadCurrentManifest(state);
  if (current === null) return blocked('manifest_authority_mismatch');
  const event = normalizeEvent(rawEvent, state);
  if (event === null) return blocked('invalid_manifest_event');
  if (!validateEventPathsAgainstState(event, state) || logicalEventValue(event, state.stateRoot) === undefined) {
    return blocked('invalid_manifest_event_path');
  }
  const digest = eventDigest(event, state.stateRoot);
  if (digest === null) return blocked('invalid_manifest_event_path');
  const applied = current.manifest.appliedEvents.find((entry) => entry.eventId === event.eventId);
  if (applied !== undefined) {
    if (!eventDigestMatches(applied.eventSha256, event, state.stateRoot)) return blocked('manifest_event_id_payload_mismatch');
    return deepFreeze({
      revision: current.manifest.revision,
      manifestRef: manifestRef(state, current.manifest.revision),
      duplicate: true,
    });
  }
  const next = cloneJson(current.manifest);
  if (!await applyEvent(next, event, state)) return blocked('invalid_manifest_transition');
  next.appliedEvents.push({ eventId: event.eventId, eventSha256: digest });
  next.revision = current.manifest.revision + 1;
  sortManifest(next);
  const validated = validateRunManifestTransitionV1(current.manifest, next);
  if (validated === null) return blocked('invalid_manifest_transition');
  const published = await publishManifestRevision(state, validated);
  if (published === null) return blocked('manifest_checkpoint_failed');
  return deepFreeze({ revision: published.revision, manifestRef: manifestRef(state, published.revision), duplicate: false });
}

export async function checkpointManifest(store, event) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return blocked('invalid_run_artifact_store');
  const copied = cloneExactData(event);
  const operation = state.manifestQueue.then(() => checkpointNow(state, copied), () => checkpointNow(state, copied));
  state.manifestQueue = operation.then(() => undefined, () => undefined);
  try {
    return await operation;
  } catch {
    return blocked('manifest_checkpoint_failed');
  }
}

function cloneExactData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value === undefined || typeof value !== 'object' || seen.has(value)) return undefined;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const array = exactDenseArray(value);
      if (array === null) return undefined;
      const out = [];
      for (const child of array) {
        const cloned = cloneExactData(child, seen);
        if (cloned === undefined) return undefined;
        out.push(cloned);
      }
      return out;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return undefined;
    const out = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return undefined;
      const cloned = cloneExactData(descriptor.value, seen);
      if (cloned === undefined) return undefined;
      out[key] = cloned;
    }
    return out;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function writerResult(state, ref, revision, duplicate) {
  return deepFreeze({
    ok: true,
    ref,
    revision,
    manifestRef: manifestRef(state, revision),
    duplicate,
  });
}

function enqueueWriter(state, operation) {
  const guarded = () => state.poisoned ? blocked('artifact_store_poisoned') : operation();
  const promise = state.writerQueue.then(guarded, guarded);
  state.writerQueue = promise.then(() => undefined, () => undefined);
  return promise.catch(() => blocked('artifact_write_failed'));
}

function tempPathForFinal(state, finalPath) {
  let generation;
  try {
    generation = state.deps.randomHex12();
  } catch {
    return null;
  }
  return GENERATION_PATTERN.test(generation)
    ? join(dirname(finalPath), `.tmp-${basename(finalPath)}-${state.deps.pid}-${generation}`)
    : null;
}

async function currentCommittedForWrite(state, identity, expectedSha256, expectedBytes) {
  const loaded = await loadCurrentManifest(state);
  if (loaded === null) return { blocked: blocked('manifest_authority_mismatch') };
  const committed = committedEntry(loaded.manifest, identity);
  if (committed === null) return { manifest: loaded.manifest, committed: null };
  if (committed.ref.sha256 !== expectedSha256 || committed.ref.bytes !== expectedBytes ||
      !await verifyImmutableRef(committed.ref, finalPathForIdentity(state, identity), state)) {
    return { blocked: blocked('artifact_replay_mismatch') };
  }
  return { manifest: loaded.manifest, committed };
}

async function postAttemptTerminal(state, identity, record, ref) {
  const event = {
    eventId: `attempt:${identity.laneId}:${ordinal(identity.attemptOrdinal)}:terminal`,
    type: 'attempt_terminal',
    laneId: identity.laneId,
    ordinal: identity.attemptOrdinal,
    attemptId: record.attemptId,
    attemptRef: ref,
    result: record.result,
    verdictRef: record.verdictRef,
  };
  return checkpointManifest(state.store, event);
}

async function postWinnerRecorded(state, identity, ref) {
  return checkpointManifest(state.store, {
    eventId: `winner:${identity.candidateId}:recorded`,
    type: 'winner_alias_recorded',
    candidateId: identity.candidateId,
    value: ref,
  });
}

async function finishPostArtifactEvent(state, identity, record, ref, duplicate) {
  let checkpoint = null;
  if (identity.artifactKind === 'attempt') checkpoint = await postAttemptTerminal(state, identity, record, ref);
  if (identity.artifactKind === 'winner') checkpoint = await postWinnerRecorded(state, identity, ref);
  if (checkpoint?.blocked) return checkpoint;
  const revision = checkpoint?.revision ?? state.manifest.revision;
  return writerResult(state, ref, revision, duplicate || checkpoint?.duplicate === true);
}

async function writePreparedArtifact(state, { identity, bytes, record = null }) {
  const expectedSha256 = sha256(bytes);
  const expectedBytes = bytes.length;
  const existing = await currentCommittedForWrite(state, identity, expectedSha256, expectedBytes);
  if (existing.blocked) return existing.blocked;
  if (existing.committed !== null) {
    return finishPostArtifactEvent(state, identity, record, existing.committed.ref, true);
  }
  const finalPath = finalPathForIdentity(state, identity);
  if (finalPath === null) return blocked('invalid_artifact_identity');
  let pending = pendingEntry(existing.manifest, identity);
  let tempPath;
  if (pending !== null) {
    if (pending.expectedSha256 !== expectedSha256 || pending.expectedBytes !== expectedBytes ||
        pending.relativePath !== relativeJson(state.stateRoot, finalPath)) return blocked('artifact_pending_replay_mismatch');
    tempPath = join(state.stateRoot, ...pending.tempRelativePath.split('/'));
  } else {
    tempPath = tempPathForFinal(state, finalPath);
    if (tempPath === null) return blocked('artifact_temp_name_failed');
    const reservedEvent = {
      eventId: expectedArtifactEventId(identity, 'reserved'),
      type: 'artifact_reserved',
      relativePath: relativeJson(state.stateRoot, finalPath),
      tempRelativePath: relativeJson(state.stateRoot, tempPath),
      expectedSha256,
      expectedBytes,
      ...identityFields(identity),
    };
    const reserved = await checkpointManifest(state.store, reservedEvent);
    if (reserved.blocked) return reserved;
    pending = pendingEntry(state.manifest, identity);
    if (pending === null) return blocked('artifact_reservation_lost');
  }
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-reserved`);
  } catch {
    return blocked('artifact_write_interrupted');
  }
  const publishedKey = identityKey(identity);
  const finalStatus = await lstatAbsent(finalPath, state.deps);
  if (finalStatus.blocked) return blocked('artifact_final_inspection_failed');
  if (finalStatus.exists) {
    if (!state.publishedPending.has(publishedKey) || !await requireAbsent(tempPath, state)) {
      return blocked('artifact_unowned_final_collision');
    }
    const ref = deepFreeze({
      kind: artifactKindForIdentity(identity),
      candidateId: candidateForIdentity(identity),
      path: finalPath,
      sha256: expectedSha256,
      bytes: expectedBytes,
      expiresAt: state.expiresAt,
    });
    if (!await verifyImmutableRef(ref, finalPath, state)) return blocked('artifact_pending_final_mismatch');
    const committed = await checkpointManifest(state.store, {
      eventId: expectedArtifactEventId(identity, 'committed'),
      type: 'artifact_committed',
      relativePath: relativeJson(state.stateRoot, finalPath),
      ref,
      ...identityFields(identity),
    });
    if (committed.blocked) return committed;
    state.publishedPending.delete(publishedKey);
    return finishPostArtifactEvent(state, identity, record, ref, false);
  }
  const tempStatus = await lstatAbsent(tempPath, state.deps);
  if (tempStatus.blocked) return blocked('artifact_temp_inspection_failed');
  if (tempStatus.exists) {
    if (!await verifyPhysicalPath(tempPath, 'file', state.deps)) return blocked('artifact_temp_mismatch');
    const info = await state.deps.lstat(tempPath).catch(() => null);
    if (info === null || info.size > expectedBytes || !await verifyOwnedBytes(tempPath, bytes, state.deps)) {
      return blocked('artifact_partial_write_requires_recovery');
    }
  } else {
    const owned = await openOwnedEmptyFile(tempPath, state.deps);
    if (owned === null || !await writeSyncClose(owned, bytes) || !await verifyOwnedBytes(tempPath, bytes, state.deps)) {
      return blocked('artifact_temp_write_failed');
    }
  }
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-temp`);
  } catch {
    return blocked('artifact_write_interrupted');
  }
  if (!await publishNewFile(tempPath, finalPath, bytes, state.deps)) return blocked('artifact_create_once_publish_failed');
  state.publishedPending.add(publishedKey);
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-published`);
  } catch {
    return blocked('artifact_write_interrupted');
  }
  const ref = deepFreeze({
    kind: artifactKindForIdentity(identity),
    candidateId: candidateForIdentity(identity),
    path: finalPath,
    sha256: expectedSha256,
    bytes: expectedBytes,
    expiresAt: state.expiresAt,
  });
  const committed = await checkpointManifest(state.store, {
    eventId: expectedArtifactEventId(identity, 'committed'),
    type: 'artifact_committed',
    relativePath: relativeJson(state.stateRoot, finalPath),
    ref,
    ...identityFields(identity),
  });
  if (committed.blocked) return committed;
  state.publishedPending.delete(publishedKey);
  try {
    await state.deps.crashBarrier?.(`after-${identityKey(identity)}-committed`);
  } catch {
    return blocked('artifact_write_interrupted');
  }
  return finishPostArtifactEvent(state, identity, record, ref, false);
}

export async function writeEvidenceArtifact(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return blocked('invalid_run_artifact_store');
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['laneId', 'attemptOrdinal', 'evidenceOrdinal', 'record']);
    if (object === null || !configuredLane(state, object.laneId) || !validOrdinal(object.attemptOrdinal) ||
        !validOrdinal(object.evidenceOrdinal) || attemptEntry(state.manifest, object.laneId, object.attemptOrdinal) === null) {
      return blocked('invalid_evidence_artifact_input');
    }
    const record = normalizeEvidenceRecord(object.record, state, object.laneId, object.attemptOrdinal);
    if (record === null) return blocked('invalid_evidence_artifact_record');
    const bytes = jsonBytes(record);
    if (bytes === null || bytes.length > MAX_JSON_ARTIFACT_BYTES) return blocked('evidence_artifact_too_large');
    return writePreparedArtifact(state, {
      identity: {
        artifactKind: 'evidence', laneId: object.laneId,
        attemptOrdinal: object.attemptOrdinal, evidenceOrdinal: object.evidenceOrdinal,
      },
      bytes,
      record,
    });
  });
}

export async function writeAttemptArtifact(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return blocked('invalid_run_artifact_store');
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['laneId', 'ordinal', 'record']);
    if (object === null || !configuredLane(state, object.laneId) || !validOrdinal(object.ordinal) ||
        attemptEntry(state.manifest, object.laneId, object.ordinal) === null) return blocked('invalid_attempt_artifact_input');
    const record = normalizeAttemptRecord(object.record, state, object.laneId, object.ordinal);
    if (record === null || !await verifySealedEvidenceAuthority(record, state, object.laneId, object.ordinal)) {
      return blocked('invalid_attempt_artifact_record');
    }
    const bytes = jsonBytes(record);
    if (bytes === null || bytes.length > MAX_JSON_ARTIFACT_BYTES) return blocked('attempt_artifact_too_large');
    return writePreparedArtifact(state, {
      identity: { artifactKind: 'attempt', laneId: object.laneId, attemptOrdinal: object.ordinal },
      bytes,
      record,
    });
  });
}

async function sealedAttemptRecord(state, laneId, sourceAttemptId) {
  const attempt = state.manifest.attempts.find((entry) =>
    entry.laneId === laneId && entry.attemptId === sourceAttemptId && entry.status === 'terminal');
  if (!attempt?.attemptRef) return null;
  const record = await readJsonRecord(attempt.attemptRef.path, MAX_JSON_ARTIFACT_BYTES, state);
  if (record === null) return null;
  const normalized = normalizeAttemptRecord(record.value, state, laneId, attempt.ordinal);
  return normalized?.sealed === null ? null : normalized;
}

export async function writeCandidatePatch(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return blocked('invalid_run_artifact_store');
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['laneId', 'sourceAttemptId', 'patch']);
    if (object === null || !configuredLane(state, object.laneId) || !boundedString(object.sourceAttemptId, 256) ||
        !Buffer.isBuffer(object.patch)) return blocked('invalid_candidate_artifact_input');
    const attempt = await sealedAttemptRecord(state, object.laneId, object.sourceAttemptId);
    if (attempt === null || attempt.sealed.patchSha256 !== sha256(object.patch)) return blocked('candidate_patch_authority_mismatch');
    return writePreparedArtifact(state, {
      identity: { artifactKind: 'candidate', laneId: object.laneId, sourceAttemptId: object.sourceAttemptId },
      bytes: Buffer.from(object.patch),
    });
  });
}

export async function writeWinnerAlias(store, input) {
  const state = STORE_STATES.get(store);
  if (state === undefined) return blocked('invalid_run_artifact_store');
  const copied = cloneExactData(input);
  return enqueueWriter(state, async () => {
    const object = exactObject(copied, ['candidateId']);
    if (object === null || !configuredLane(state, object.candidateId) ||
        state.manifest.selection?.selectedCandidateId !== object.candidateId) return blocked('winner_alias_not_selected');
    const candidate = state.manifest.candidateRefs.find((entry) => entry.candidateId === object.candidateId);
    if (!candidate?.patchRef || candidate.patchRef.bytes <= 0 ||
        !await verifyImmutableRef(candidate.patchRef, state.paths.candidatePaths[object.candidateId], state)) {
      return blocked('winner_candidate_artifact_unavailable');
    }
    let bytes;
    try {
      bytes = await state.deps.readFile(candidate.patchRef.path);
    } catch {
      return blocked('winner_candidate_artifact_unavailable');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== candidate.patchRef.bytes || sha256(bytes) !== candidate.patchRef.sha256) {
      return blocked('winner_candidate_artifact_mismatch');
    }
    return writePreparedArtifact(state, {
      identity: { artifactKind: 'winner', candidateId: object.candidateId },
      bytes: Buffer.from(bytes),
    });
  });
}

function validRunIdForGrammar(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);
}

function refPathGrammar(stateRoot, ref) {
  if (!contained(stateRoot, ref.path) || !samePath(resolve(ref.path), ref.path)) return null;
  const parts = relative(stateRoot, ref.path).split(sep);
  if (ref.kind === 'manifest') {
    return parts.length === 3 && parts[0] === 'runs' && validRunIdForGrammar(parts[1]) && parts[2] === 'manifest.json'
      ? { runId: parts[1] }
      : null;
  }
  if (ref.kind === 'winner') {
    const match = parts.length === 2 && parts[0] === 'patches' ? /^([a-z0-9][a-z0-9_-]{0,63})\.patch$/.exec(parts[1]) : null;
    return match !== null && validRunIdForGrammar(match[1]) ? { runId: match[1] } : null;
  }
  if (parts.length !== 4 || parts[0] !== 'runs' || !validRunIdForGrammar(parts[1])) return null;
  if (ref.kind === 'candidate') {
    return parts[2] === 'candidates' && parts[3] === `${ref.candidateId}.patch` ? { runId: parts[1] } : null;
  }
  if (ref.kind === 'attempt') {
    return parts[2] === 'attempts' && new RegExp(`^${ref.candidateId}-(?:00[1-9]|0[1-9]\\d|[1-9]\\d{2})\\.json$`).test(parts[3])
      ? { runId: parts[1] }
      : null;
  }
  const ordinalPattern = '(?:00[1-9]|0[1-9]\\d|[1-9]\\d{2})';
  return parts[2] === 'evidence' && new RegExp(`^${ref.candidateId}-${ordinalPattern}-${ordinalPattern}\\.json$`).test(parts[3])
    ? { runId: parts[1] }
    : null;
}

function invalidInspectionRef(value) {
  const cloned = cloneExactData(value);
  const artifact = normalizeArtifactRef(cloned);
  if (artifact !== null) return deepFreeze(artifact);
  const manifest = normalizeManifestRef(cloned);
  if (manifest !== null) return deepFreeze(manifest);
  return deepFreeze({ kind: 'manifest', path: '', revision: 0, expiresAt: 0 });
}

function inspectedResult(ref, fields) {
  return deepFreeze({
    ref,
    valid: fields.valid,
    exists: fields.exists,
    expired: fields.expired,
    matches: fields.matches,
    superseded: fields.superseded,
    currentRevision: fields.currentRevision,
  });
}

async function inspectOneRef(stateRoot, rawRef, nowMs, deps) {
  const cloned = cloneExactData(rawRef);
  const artifact = normalizeArtifactRef(cloned);
  const manifest = normalizeManifestRef(cloned);
  const ref = artifact ?? manifest;
  if (ref === null) {
    return inspectedResult(invalidInspectionRef(rawRef), {
      valid: false, exists: false, expired: true, matches: false, superseded: false, currentRevision: null,
    });
  }
  const grammar = refPathGrammar(stateRoot, ref);
  if (grammar === null) {
    return inspectedResult(deepFreeze(ref), {
      valid: false, exists: false, expired: true, matches: false, superseded: false, currentRevision: null,
    });
  }
  const status = await lstatAbsent(ref.path, deps);
  if (status.blocked) {
    return inspectedResult(deepFreeze(ref), {
      valid: false, exists: false, expired: true, matches: false, superseded: false, currentRevision: null,
    });
  }
  if (!status.exists) {
    return inspectedResult(deepFreeze(ref), {
      valid: true, exists: false, expired: true, matches: false, superseded: false, currentRevision: null,
    });
  }
  if (!await verifyArtifactOwnerOnlyWithDeps({ path: ref.path, kind: 'file' }, deps)) {
    return inspectedResult(deepFreeze(ref), {
      valid: false, exists: true, expired: true, matches: false, superseded: false, currentRevision: null,
    });
  }
  if (artifact !== null) {
    let matches = false;
    try {
      const info = await deps.lstat(ref.path);
      if (info.size === ref.bytes) {
        const bytes = await deps.readFile(ref.path);
        matches = Buffer.isBuffer(bytes) && bytes.length === ref.bytes && sha256(bytes) === ref.sha256;
      }
    } catch {
      matches = false;
    }
    return inspectedResult(deepFreeze(ref), {
      valid: true,
      exists: true,
      expired: !matches || nowMs >= ref.expiresAt,
      matches,
      superseded: false,
      currentRevision: null,
    });
  }
  let current = null;
  try {
    const info = await deps.lstat(ref.path);
    if (info.size > 0 && info.size <= MAX_RUN_MANIFEST_BYTES) {
      const bytes = await deps.readFile(ref.path);
      const parsed = Buffer.isBuffer(bytes) ? normalizeRunManifestV1(JSON.parse(bytes.toString('utf8'))) : null;
      if (parsed !== null && parsed.runId === grammar.runId && parsed.revision >= ref.revision && parsed.expiresAt === ref.expiresAt) current = parsed;
    }
  } catch {
    current = null;
  }
  const matches = current !== null;
  return inspectedResult(deepFreeze(ref), {
    valid: true,
    exists: true,
    expired: !matches || nowMs >= ref.expiresAt,
    matches,
    superseded: matches && current.revision > ref.revision,
    currentRevision: matches ? current.revision : null,
  });
}

export async function inspectArtifactRefs(input, dependencyInput = {}) {
  const object = exactObject(input, ['stateRoot', 'refs', 'nowMs']);
  const deps = readonlyDeps(dependencyInput);
  const refs = exactDenseArray(object?.refs, 10_000);
  if (object === null || deps === null || refs === null || !safeInteger(object.nowMs) ||
      !boundedString(object.stateRoot, 32_768) || !isAbsolute(object.stateRoot) ||
      await canonicalRoot(object.stateRoot, deps) === null) return blocked('invalid_artifact_inspection_input');
  const inspected = [];
  for (const ref of refs) inspected.push(await inspectOneRef(object.stateRoot, ref, object.nowMs, deps));
  return deepFreeze({ ok: true, refs: inspected });
}
