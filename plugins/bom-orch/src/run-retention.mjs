/**
 * 실행 디렉터리의 닫힌 집합 검증과 상태 루트의 나이 기반 보존을 한 잎에 둔다.
 *
 * ★ 방향은 reaper -> run-retention 이다. 이 파일은 부팅 조정, 프로세스 원장, 워크트리
 * 회수를 모르고 디스크에 이미 놓인 실행 단위와 보존 대상만 판정한다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateRunManifestTransitionV1 } from './manifest-transition.mjs';
import { normalizeProofRecord, proofLockLive } from './proof-record.mjs';
import { canonical } from './real-path.mjs';
import {
  MAX_JSON_ARTIFACT_BYTES,
  MAX_RUN_MANIFEST_BYTES,
  RUN_ARTIFACT_RETENTION_MS,
  normalizeRunManifestV1,
} from './run-manifest.mjs';
import { verifyArtifactOwnerOnly } from './run-store-fs.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { writeFileAtomic } from './util/fs-atomic.mjs';
import { sha256 } from './util/hash.mjs';
import { hasExactKeys } from './util/objects.mjs';
// ★ `contained` 에 넣는 두 경로는 이미 같은 좌표계로 편 값이어야 한다. 링크·8.3
//   표기를 섞으면 거짓을 내고, 이 잎에서 거짓은 "지우지 않는다" 로 읽힌다.
import { contained, samePath } from './util/paths.mjs';
import { compareUtf8 } from './util/strings.mjs';

/**
 * `<stateRoot>/scratch` 잔재를 "죽은 실행이 남긴 것" 으로 볼 나이.
 *
 * 그 디렉터리에는 사용자의 **미커밋 내용 전체가 평문으로** 잠시 놓인다(임시 인덱스와
 * state 패치 — `src/worktree.mjs` 의 같은 문단). 정상 경로에서는 `finally` 가 항상 지우고
 * 강제 종료된 경우에만 남는다.
 *
 * 6시간인 이유: 이 파일들의 정상 수명은 초 단위다(뜨자마자 지운다). 가장 긴 정상 경로도
 * `worktree add` + `add -A` 한 번이라 시간 단위가 아니다. 그래도 동시에 도는 다른 실행의
 * 파일을 지우지 않도록 넉넉히 잡는다.
 */
const SCRATCH_STALE_MS = 6 * 60 * 60 * 1000;
const AGED_SWEEP_ENTRY_CAP = 256;

function agedDeadline(deadlineAt, clock) {
  if (deadlineAt === undefined) return () => false;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || typeof clock !== 'function') return null;
  return () => {
    try {
      const observed = clock();
      return !Number.isSafeInteger(observed) || observed < 0 || observed >= deadlineAt;
    } catch {
      return true;
    }
  };
}

/**
 * `src/worktree.mjs` 가 scratch 에 만드는 이름 **전체 모양**. 그 밖의 파일은 우리 것이 아니다.
 *
 * ★ 접두사만 보면 안 된다. 실측 재현: 접두사 술어(`/^(?:index-|state-|step-|final-)/`)는
 *   `final-report.md` · `step-1.png` · `index-a1b2c3.js` 같은 **사용자 파일**을 우리 것으로
 *   보고 지웠다. 나이 문턱은 사용자 파일에게 아무 의미가 없다. 실제로 만들어지는 이름은
 *   넷뿐이므로(아래) 그 모양을 그대로 요구한다 — 이 모듈의 "우리 것임을 증명하지 못하면
 *   손대지 않는다" 와 같은 자세다.
 */
const SCRATCH_NAMES = Object.freeze([
  /^index-[a-z0-9_-]{1,64}-\d+$/, //          index-<runId>-<pid>
  /^state-[a-z0-9_-]{1,64}-\d+\.patch$/, //   state-<runId>-<pid>.patch
  /^step-[0-9a-f]{12}-\d+-\d+\.patch$/, //    step-<sha12>-<pid>-<seq>.patch
  /^final-[a-z0-9_-]{1,64}-\d+-\d+\.patch$/, // final-<runId>-<pid>-<seq>.patch
]);

/**
 * `<stateRoot>/patches/<runId>.patch` 를 남겨 둘 기간 (계획 2 이월 2).
 *
 * 그 파일에는 델리게이트가 만든 소스 전문이 평문으로 들어 있고, 실행마다 하나씩 쌓이는데
 * 아무도 지우지 않았다. 봉투는 그 경로를 사용자에게 알리므로 **바로 지울 수는 없다** —
 * 사용자가 나중에 열어 보는 것이 정상 사용법이다. 30일은 "그 실행을 다시 들여다볼 일이
 * 없다" 고 볼 수 있는 여유이자, 이 디렉터리가 무한히 자라지 않게 하는 상한이다.
 */
/**
 * `src/engine.mjs` 가 `patches/` 에 만드는 이름 모양. `<runId>.patch` 하나뿐이고 runId 는
 * `src/worktree.mjs` 의 `RUN_ID_PATTERN` 을 지난 값이다. scratch 와 같은 이유로 모양을
 * 요구한다 — 사용자가 그 디렉터리에 둔 파일에게 나이 문턱은 아무 의미가 없다.
 */
const PATCH_NAMES = Object.freeze([/^[a-z0-9][a-z0-9_-]{0,63}\.patch$/]);
/**
 * `src/engine.mjs` 가 `plans/` 에 만드는 이름 모양 — `mkdtemp(join(plansRoot, \`${runId}-planner-\`))`
 * 이므로 `<runId>-planner-<6자>` 하나뿐이다. scratch·patches 와 같은 이유로 **전체 모양**을
 * 요구한다: 사용자가 그 디렉터리에 둔 것에게 나이 문턱은 아무 의미가 없다.
 */
const PLAN_SCRATCH_NAMES = Object.freeze([/^[a-z0-9][a-z0-9_-]{0,63}-planner-[A-Za-z0-9]{6}$/]);
/** `src/diag.mjs` 가 `logs/` 에 만드는 이름 모양. patches 와 같은 이유로 모양을 요구한다. */
const LOG_NAMES = Object.freeze([/^[a-z0-9][a-z0-9_-]{0,63}\.jsonl$/]);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const INIT_LOCK_PATTERN = /^\.init-lock-([a-z0-9][a-z0-9_-]{0,63})\.json$/;
const GENERATION_PATTERN = /^[0-9a-f]{12}$/;
const CHECKPOINT_TEMP_PATTERN = /^\.tmp-manifest\.json-(0|[1-9]\d*)-([0-9a-f]{12})$/;

export function validRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value) && !WINDOWS_DEVICE_PATTERN.test(value);
}

const exactLstat = (path) => lstat(path, { bigint: true });

function frozenRunResult({ removed = [], checked = 0, skipped = [] } = {}) {
  const unique = new Map();
  for (const record of skipped) unique.set(JSON.stringify([record.runId, record.code]), record);
  const orderedSkipped = [...unique.values()].sort((left, right) => {
    if (left.runId === null && right.runId !== null) return -1;
    if (left.runId !== null && right.runId === null) return 1;
    return compareUtf8(left.runId ?? '', right.runId ?? '') || compareUtf8(left.code, right.code);
  });
  return deepFreeze({
    removed: [...new Set(removed)].sort(compareUtf8),
    checked,
    skipped: orderedSkipped.map((record) => ({ runId: record.runId, code: record.code })),
  });
}

function exactFunctionOptions(value, allowed) {
  if (value === undefined) return {};
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
      if (key === 'deadlineAt') {
        if (!Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
      } else if (key !== 'excludeRunId' && typeof descriptor.value !== 'function') return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

async function canonicalValue(canonicalPath, path) {
  try {
    const value = await canonicalPath(path);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function lstatStatus(path, operation) {
  try {
    return { exists: true, info: await operation(path, { bigint: true }) };
  } catch (error) {
    return error?.code === 'ENOENT' ? { exists: false, info: null } : { exists: null, info: null };
  }
}

function kindOf(info) {
  try {
    if (info.isSymbolicLink()) return 'link';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'other';
  }
}

function direntKind(entry) {
  try {
    if (entry.isSymbolicLink()) return 'link';
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'other';
  }
}

function exactStatInteger(value, family) {
  if (family === 'bigint') return typeof value === 'bigint' && value >= 0n ? value.toString() : null;
  if (family === 'synthetic') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return null;
}

function statFamily(info) {
  const values = [info?.dev, info?.ino, info?.size];
  if (values.every((value) => typeof value === 'bigint')) return 'bigint';
  if (values.every((value) => typeof value === 'number')) return 'synthetic';
  return null;
}

function safeSizeInteger(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function exactStatTime(info, name, family) {
  if (family === 'bigint') {
    const ns = info[`${name}Ns`];
    return typeof ns === 'bigint' && ns >= 0n ? ns.toString() : null;
  }
  const ms = info[`${name}Ms`];
  return family === 'synthetic' && Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER
    ? String(ms)
    : null;
}

function statAuthority(info, kind) {
  const family = statFamily(info);
  const dev = exactStatInteger(info?.dev, family);
  const ino = exactStatInteger(info?.ino, family);
  const size = exactStatInteger(info?.size, family);
  const birthtime = exactStatTime(info ?? {}, 'birthtime', family);
  const mtime = exactStatTime(info ?? {}, 'mtime', family);
  const ctime = exactStatTime(info ?? {}, 'ctime', family);
  if (dev === null || ino === null || size === null || birthtime === null || mtime === null || ctime === null) {
    return null;
  }
  return {
    physicalKey: JSON.stringify([family, kind, dev, ino]),
    observationKey: JSON.stringify([family, kind, dev, ino, size, birthtime, mtime, ctime]),
    stableKey: JSON.stringify([family, kind, dev, ino, size, birthtime, mtime]),
    anchorKey: JSON.stringify([family, kind, dev, ino, birthtime]),
    deviceKey: JSON.stringify([family, dev]),
    size,
    mtime,
  };
}

function statIdentity(info, kind) {
  return statAuthority(info, kind)?.observationKey ?? null;
}

function quarantineIdentity(info, kind) {
  return statAuthority(info, kind)?.stableKey ?? null;
}

function anchorIdentity(info, kind) {
  return statAuthority(info, kind)?.anchorKey ?? null;
}

function physicalIdentity(info, kind) {
  return statAuthority(info, kind)?.physicalKey ?? null;
}

function safeStatSize(info) {
  const value = safeSizeInteger(info?.size);
  if (value === null) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function expiredStatMtime(info, nowMs, maxAgeMs) {
  const family = statFamily(info);
  if (family === 'bigint') {
    const mtime = exactStatTime(info, 'mtime', family);
    return mtime !== null && BigInt(nowMs) * 1_000_000n - BigInt(mtime) >= BigInt(maxAgeMs) * 1_000_000n;
  }
  const mtime = exactStatTime(info ?? {}, 'mtime', family);
  return mtime !== null && nowMs - Number(mtime) >= maxAgeMs;
}

function samePhysicalFile(left, right) {
  const leftKey = physicalIdentity(left, 'file');
  return leftKey !== null && leftKey === physicalIdentity(right, 'file');
}

function newSnapshot(root) {
  return { root, paths: new Map(), absent: new Set(), listings: new Map() };
}

function recordPath(snapshot, path, kind, info) {
  const authority = statAuthority(info, kind);
  if (authority === null) return false;
  snapshot.paths.set(path, {
    kind,
    identity: authority.observationKey,
    quarantineIdentity: authority.stableKey,
    anchorIdentity: authority.anchorKey,
    deviceIdentity: authority.deviceKey,
    physicalIdentity: authority.physicalKey,
  });
  return true;
}

function recordListing(snapshot, path, entries) {
  const normalized = entries.map((entry) => [entry.name, direntKind(entry)]).sort((a, b) => compareUtf8(a[0], b[0]));
  snapshot.listings.set(path, JSON.stringify(normalized));
}

async function safeExisting(path, kind, context, codes = {}) {
  const status = await lstatStatus(path, context.deps.lstat);
  if (status.exists !== true || kindOf(status.info) !== kind) return { ok: false, code: codes.type ?? 'unsafe_type' };
  const real = await canonicalValue(context.deps.canonicalPath, path);
  if (real === null || !samePath(real, resolve(path)) ||
      !samePath(real, context.root) && !contained(context.root, real)) {
    return { ok: false, code: codes.alias ?? 'alias_mismatch' };
  }
  if (!await ownedPath(context.deps, path, kind)) return { ok: false, code: codes.permission ?? 'permission_unverified' };
  if (!recordPath(context.snapshot, path, kind, status.info)) return { ok: false, code: codes.type ?? 'unsafe_type' };
  return { ok: true, info: status.info };
}

async function ownedPath(deps, path, kind) {
  try {
    return await deps.verifyOwnerOnly({ path, kind }) === true;
  } catch {}
  return false;
}

async function safeReadFile(path, context, { min = 0, max = Number.MAX_SAFE_INTEGER, code = 'invalid_inventory' } = {}) {
  const checked = await safeExisting(path, 'file', context);
  if (!checked.ok) return checked;
  const size = safeStatSize(checked.info);
  if (size === null || size < min || size > max) return { ok: false, code };
  let handle;
  try {
    // 테스트 seam 이 반환하는 stat 표현(Number/BigInt)이 달라도, 실제 path 와 열린 handle 의
    // 결속은 항상 같은 exact(BigInt) 좌표계에서 검증한다.
    const beforeOpen = await lstat(path, { bigint: true });
    const beforeSize = safeStatSize(beforeOpen);
    if (kindOf(beforeOpen) !== 'file' || beforeSize !== size) {
      return { ok: false, code: 'validation_changed' };
    }
    const flags = fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    handle = await context.deps.open(path, flags);
    const opened = await handle.stat({ bigint: true });
    const openedSize = safeStatSize(opened);
    if (kindOf(opened) !== 'file' || openedSize === null || openedSize < min || openedSize > max) {
      return { ok: false, code };
    }
    if (openedSize !== size || statIdentity(opened, 'file') !== statIdentity(beforeOpen, 'file')) {
      return { ok: false, code: 'validation_changed' };
    }

    // 검증한 크기보다 딱 한 바이트만 더 읽어 growth를 감지한다. path 기반 readFile은
    // lstat 뒤 교체된 거대 inode를 통째로 읽은 다음에야 거부하므로 이 경계에 쓸 수 없다.
    const buffer = Buffer.allocUnsafe(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - length) {
        return { ok: false, code };
      }
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== size) return { ok: false, code };

    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (kindOf(afterHandle) !== 'file' || kindOf(afterPath) !== 'file' ||
        statIdentity(afterHandle, 'file') !== statIdentity(opened, 'file') ||
        statIdentity(afterPath, 'file') !== statIdentity(opened, 'file')) {
      return { ok: false, code: 'validation_changed' };
    }
    return { ok: true, info: checked.info, bytes: Buffer.from(buffer.subarray(0, length)) };
  } catch {
    return { ok: false, code };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function listDirectory(path, context) {
  try {
    const entries = await context.deps.readdir(path, { withFileTypes: true });
    if (!Array.isArray(entries)) return null;
    recordListing(context.snapshot, path, entries);
    return entries;
  } catch {
    return null;
  }
}

function canonicalJsonBytes(value) {
  try {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    return null;
  }
}

function decodeUtf8(bytes) {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

function validCanonicalPid(value) {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 0 && String(pid) === value;
}

function validArtifactTempSuffix(value) {
  const match = /^(\d+)-([0-9a-f]{12})$/.exec(value);
  return match !== null && validCanonicalPid(match[1]);
}

function validCheckpointTempName(name) {
  const match = CHECKPOINT_TEMP_PATTERN.exec(name);
  if (match === null) return false;
  return validCanonicalPid(match[1]);
}

async function readManifest(path, runId, context) {
  const file = await safeReadFile(path, context, { min: 1, max: MAX_RUN_MANIFEST_BYTES, code: 'invalid_manifest' });
  if (!file.ok) return file;
  const text = decodeUtf8(file.bytes);
  if (text === null) return { ok: false, code: 'invalid_manifest' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_manifest' };
  }
  // ★ 이 매니페스트는 **다른 플러그인 판**이 썼을 수 있다. 닫힌 reason 어휘가 개명되는 동안
  //   두 철자가 동시에 디스크에 있고(`stagnated` ↔ `lane_stagnated`), `normalizeRunManifestV1` 이
  //   그 별칭을 받아 준다 — 그리고 **값을 고쳐 쓰지 않는다.** 두 성질이 함께 필요하다: 정규화가
  //   철자를 올려 쓰면 바로 아래 정준 바이트 비교가 어긋나 `noncanonical_manifest` 가 되고,
  //   그 실행은 회수되지 않은 채 디렉터리와 워크트리를 영원히 남긴다(WS2 §2.4).
  const normalized = normalizeRunManifestV1(parsed);
  if (normalized === null || normalized.runId !== runId || !Number.isSafeInteger(normalized.expiresAt) || normalized.expiresAt < 0) {
    return { ok: false, code: 'invalid_manifest' };
  }
  const canonicalBytes = canonicalJsonBytes(normalized);
  if (canonicalBytes === null || !file.bytes.equals(canonicalBytes)) return { ok: false, code: 'noncanonical_manifest' };
  return { ok: true, manifest: normalized, bytes: canonicalBytes };
}

function exactInitLock(parsed, runId) {
  try {
    // 리서치가 놓친 12번째 `exact-object` 사본이었다(가족 목록에 이름이 없어서). 입력은
    // `JSON.parse` 결과뿐이라 공유 판정과 결과가 같다 — own `__proto__` 는 예전에도 키 개수로
    // 걸렸고, JSON 은 비열거·accessor·`undefined` 값을 만들지 못한다.
    const keys = ['schemaVersion', 'kind', 'runId', 'generation', 'pid', 'finalBasename', 'createdAt', 'expiresAt'];
    if (!hasExactKeys(parsed, keys)) return null;
    if (parsed.schemaVersion !== 1 || parsed.kind !== 'run-artifact-init-lock' || parsed.runId !== runId ||
        !GENERATION_PATTERN.test(parsed.generation) || !Number.isSafeInteger(parsed.pid) || parsed.pid < 0 ||
        parsed.finalBasename !== runId || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0 ||
        parsed.expiresAt !== parsed.createdAt + RUN_ARTIFACT_RETENTION_MS || !Number.isSafeInteger(parsed.expiresAt)) return null;
    return {
      schemaVersion: 1,
      kind: 'run-artifact-init-lock',
      runId,
      generation: parsed.generation,
      pid: parsed.pid,
      finalBasename: runId,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function readInitLock(path, runId, context) {
  const loaded = await safeReadFile(path, context, { max: MAX_RUN_MANIFEST_BYTES, code: 'invalid_lock' });
  if (!loaded.ok) return loaded;
  const { bytes } = loaded;
  if (bytes.length === 0) return { ok: true, zero: true, info: loaded.info, value: null };
  const text = decodeUtf8(bytes);
  let parsed;
  try {
    parsed = text === null ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const value = exactInitLock(parsed, runId);
  const canonicalBytes = value === null ? null : canonicalJsonBytes(value);
  if (canonicalBytes === null || !bytes.equals(canonicalBytes)) return { ok: false, code: 'invalid_lock' };
  return { ok: true, zero: false, info: loaded.info, value };
}

async function validatePartialFinal(runDir, lock, context) {
  const entries = await listDirectory(runDir, context);
  if (entries === null) return { ok: false, code: 'unexpected_entry' };
  const names = entries.map((entry) => entry.name);
  const tempNames = names.filter((name) => name.startsWith('.tmp-manifest.json-'));
  const expectedTemp = `.tmp-manifest.json-${lock.pid}-`;
  if (tempNames.length > 1 || tempNames.some((name) =>
    !name.startsWith(expectedTemp) || !GENERATION_PATTERN.test(name.slice(expectedTemp.length)))) {
    return { ok: false, code: 'unexpected_entry' };
  }
  const children = names.filter((name) => !tempNames.includes(name));
  const allowedPrefixes = [
    [],
    ['candidates'],
    ['candidates', 'attempts'],
    ['candidates', 'attempts', 'evidence'],
  ];
  const prefix = allowedPrefixes.find((candidate) =>
    candidate.length === children.length && candidate.every((name) => children.includes(name)));
  if (prefix === undefined || tempNames.length === 1 && prefix.length !== 3) return { ok: false, code: 'unexpected_entry' };
  for (const name of prefix) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (direntKind(entry) !== 'directory') return { ok: false, code: 'unsafe_type' };
    const path = join(runDir, name);
    const checked = await safeExisting(path, 'directory', context);
    if (!checked.ok) return checked;
    const nested = await listDirectory(path, context);
    if (nested === null || nested.length !== 0) return { ok: false, code: 'unexpected_entry' };
  }
  if (tempNames.length === 1) {
    const path = join(runDir, tempNames[0]);
    const temp = await safeReadFile(path, context, { max: MAX_RUN_MANIFEST_BYTES, code: 'invalid_manifest' });
    if (!temp.ok) return temp;
    if (temp.bytes.length > 0) {
      const text = decodeUtf8(temp.bytes);
      let parsed = null;
      let parseable = false;
      try {
        if (text !== null) {
          parsed = JSON.parse(text);
          parseable = true;
        }
      } catch {
        // An interrupted byte prefix is owned by the exact lock and prefix.
      }
      if (parseable) {
        const manifest = normalizeRunManifestV1(parsed);
        const bytes = manifest === null ? null : canonicalJsonBytes(manifest);
        if (manifest === null || manifest.revision !== 0 || manifest.runId !== lock.runId ||
            manifest.generation !== lock.generation || manifest.createdAt !== lock.createdAt ||
            manifest.expiresAt !== lock.expiresAt || bytes === null || !bytes.equals(temp.bytes)) {
          return { ok: false, code: 'invalid_manifest' };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * `MAX_JSON_ARTIFACT_BYTES` 로 묶인 JSON 기록 셋. 나머지 둘(candidate·winner)은 상한 없는
 * 패치 바이트열이라 스트리밍으로 잰다. `plan` 이 여기 드는 이유는 그것이 JSON 기록이기
 * 때문이다 — 저장소의 `applyReserved` 가 같은 상한을 같은 세 kind 에 건다.
 */
const BOUNDED_JSON_KINDS = new Set(['attempt', 'evidence', 'plan']);

function artifactIdentityPath(manifest, entry) {
  if (entry.artifactKind === 'attempt') {
    return `runs/${manifest.runId}/attempts/${entry.laneId}-${String(entry.attemptOrdinal).padStart(3, '0')}.json`;
  }
  if (entry.artifactKind === 'evidence') {
    return `runs/${manifest.runId}/evidence/${entry.laneId}-${String(entry.attemptOrdinal).padStart(3, '0')}-${String(entry.evidenceOrdinal).padStart(3, '0')}.json`;
  }
  if (entry.artifactKind === 'candidate') return `runs/${manifest.runId}/candidates/${entry.laneId}.patch`;
  if (entry.artifactKind === 'winner') return `patches/${manifest.runId}.patch`;
  // 다섯째 kind — 플래너 정본(WS4a §0-PL). 하위 디렉터리가 없는 유일한 실행 안 artifact 다.
  if (entry.artifactKind === 'plan') return `runs/${manifest.runId}/plan.json`;
  return null;
}

function absoluteRelativePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\\') ||
      relativePath.startsWith('/') || relativePath.includes(':')) return null;
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) return null;
  const path = resolve(root, ...parts);
  return contained(root, path) ? path : null;
}

async function streamInventoryFile(path, expected, expectedSize, openFile) {
  let handle;
  let result;
  try {
    handle = await openFile(path, 'r');
    const opened = await handle.stat({ bigint: true });
    if (kindOf(opened) !== 'file' || statIdentity(opened, 'file') !== statIdentity(expected, 'file')) {
      result = { ok: false, code: 'validation_changed' };
    } else {
      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      while (size < expectedSize) {
        const length = Math.min(chunk.length, expectedSize - size);
        const { bytesRead } = await handle.read(chunk, 0, length, size);
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
          throw new Error('artifact ended before its prevalidated size');
        }
        size += bytesRead;
        hash.update(chunk.subarray(0, bytesRead));
      }
      const afterRead = await handle.stat({ bigint: true });
      result = statIdentity(afterRead, 'file') === statIdentity(opened, 'file')
        ? { ok: true, size, hash: hash.digest('hex') }
        : { ok: false, code: 'validation_changed' };
    }
  } catch {
    result = { ok: false, code: 'invalid_inventory' };
  }
  try {
    await handle?.close();
  } catch {
    return { ok: false, code: 'invalid_inventory' };
  }
  return result;
}

async function inspectInventoryFile(path, context, {
  requiredHash = null, requiredBytes = null, maxBytes = null, stream = false,
} = {}) {
  const status = await lstatStatus(path, context.deps.lstat);
  if (status.exists === false) {
    context.snapshot.absent.add(path);
    return { ok: true, exists: false, info: null, bytes: null, size: 0, hash: null };
  }
  if (status.exists !== true || kindOf(status.info) !== 'file') return { ok: false, code: 'unsafe_type' };
  if (stream) {
    const checked = await safeExisting(path, 'file', context);
    if (!checked.ok) return checked;
    const size = safeStatSize(checked.info);
    if (size === null || maxBytes !== null && size > maxBytes ||
        requiredBytes !== null && size !== requiredBytes) {
      return { ok: false, code: 'invalid_inventory' };
    }
    const streamed = await streamInventoryFile(path, checked.info, size, context.deps.open);
    if (!streamed.ok) return streamed;
    const after = await lstatStatus(path, context.deps.lstat);
    if (after.exists !== true || kindOf(after.info) !== 'file' ||
        statIdentity(after.info, 'file') !== statIdentity(checked.info, 'file')) {
      return { ok: false, code: 'validation_changed' };
    }
    if (streamed.size !== size || requiredBytes !== null && streamed.size !== requiredBytes ||
        requiredHash !== null && streamed.hash !== requiredHash) return { ok: false, code: 'invalid_inventory' };
    return { ok: true, exists: true, info: after.info, bytes: null, size: streamed.size, hash: streamed.hash };
  }
  const checked = await safeReadFile(path, context, {
    max: maxBytes ?? Number.MAX_SAFE_INTEGER,
    code: 'invalid_inventory',
  });
  if (!checked.ok) return checked;
  if (requiredBytes !== null && checked.bytes.length !== requiredBytes ||
      requiredHash !== null && sha256(checked.bytes) !== requiredHash) return { ok: false, code: 'invalid_inventory' };
  return {
    ok: true,
    exists: true,
    info: checked.info,
    bytes: checked.bytes,
    size: checked.bytes.length,
    hash: sha256(checked.bytes),
  };
}

async function validatePendingArtifact(entry, finalPath, tempPath, context) {
  const boundedJson = BOUNDED_JSON_KINDS.has(entry.artifactKind);
  if (boundedJson && entry.expectedBytes > MAX_JSON_ARTIFACT_BYTES) return { ok: false, code: 'invalid_inventory' };
  const final = await inspectInventoryFile(finalPath, context, {
    requiredHash: entry.expectedSha256,
    requiredBytes: entry.expectedBytes,
    maxBytes: boundedJson ? MAX_JSON_ARTIFACT_BYTES : null,
    stream: !boundedJson,
  });
  if (!final.ok) return final;
  const temp = await inspectInventoryFile(tempPath, context, {
    maxBytes: entry.expectedBytes,
    stream: !boundedJson,
  });
  if (!temp.ok) return temp;
  if (temp.exists && temp.size === entry.expectedBytes && temp.hash !== entry.expectedSha256) {
    return { ok: false, code: 'invalid_inventory' };
  }
  if (final.exists && temp.exists &&
      (!samePhysicalFile(final.info, temp.info) || temp.size !== entry.expectedBytes ||
        final.hash !== temp.hash)) return { ok: false, code: 'invalid_inventory' };
  return { ok: true, final, temp };
}

async function validateCommittedArtifact(entry, finalPath, context, { allowAbsent = false } = {}) {
  if (!samePath(entry.ref.path, finalPath)) return { ok: false, code: 'invalid_inventory' };
  const boundedJson = BOUNDED_JSON_KINDS.has(entry.artifactKind);
  if (boundedJson && entry.ref.bytes > MAX_JSON_ARTIFACT_BYTES) return { ok: false, code: 'invalid_inventory' };
  const final = await inspectInventoryFile(finalPath, context, {
    requiredHash: entry.ref.sha256,
    requiredBytes: entry.ref.bytes,
    maxBytes: boundedJson ? MAX_JSON_ARTIFACT_BYTES : null,
    stream: !boundedJson,
  });
  if (!final.ok || !allowAbsent && !final.exists) return final.ok ? { ok: false, code: 'invalid_inventory' } : final;
  return { ok: true, final };
}

async function validateCheckpointTemp(path, current, currentBytes, context) {
  const temp = await safeReadFile(path, context, { max: MAX_RUN_MANIFEST_BYTES, code: 'checkpoint_temp_invalid' });
  if (!temp.ok) return temp;
  if (temp.bytes.length === 0 || temp.bytes.equals(currentBytes)) return { ok: true };
  const text = decodeUtf8(temp.bytes);
  let parsed;
  try {
    if (text === null) return { ok: true };
    parsed = JSON.parse(text);
  } catch {
    return { ok: true };
  }
  const next = normalizeRunManifestV1(parsed);
  const canonicalBytes = next === null ? null : canonicalJsonBytes(next);
  if (next === null || canonicalBytes === null || !canonicalBytes.equals(temp.bytes) || next.runId !== current.runId ||
      next.generation !== current.generation || next.createdAt !== current.createdAt || next.expiresAt !== current.expiresAt) {
    return { ok: false, code: 'checkpoint_temp_invalid' };
  }
  let validated;
  try {
    validated = context.deps.validateTransition(current, next);
  } catch {
    validated = null;
  }
  const validatedBytes = validated === null ? null : canonicalJsonBytes(validated);
  return validatedBytes !== null && validatedBytes.equals(temp.bytes)
    ? { ok: true }
    : { ok: false, code: 'checkpoint_temp_invalid' };
}

async function patchesView(manifest, context) {
  const patchesDir = join(context.root, 'patches');
  const status = await lstatStatus(patchesDir, context.deps.lstat);
  if (status.exists === false) {
    context.snapshot.absent.add(patchesDir);
    return { ok: true, path: patchesDir, entries: [], exists: false };
  }
  if (status.exists !== true || kindOf(status.info) !== 'directory') return { ok: false, code: 'alias_mismatch' };
  const checked = await safeExisting(patchesDir, 'directory', context, {
    type: 'alias_mismatch', alias: 'alias_mismatch', permission: 'permission_unverified',
  });
  if (!checked.ok) return checked;
  const entries = await listDirectory(patchesDir, context);
  return entries === null ? { ok: false, code: 'alias_mismatch' } : { ok: true, path: patchesDir, entries, exists: true };
}

async function validateWinnerInventory(manifest, winner, context, targets) {
  const view = await patchesView(manifest, context);
  if (!view.ok) return { ok: false, code: 'alias_mismatch' };
  const aliasName = `${manifest.runId}.patch`;
  const tempPrefix = `.tmp-${aliasName}-`;
  const relevant = view.entries.filter((entry) => entry.name === aliasName || entry.name.startsWith(tempPrefix));
  if (winner === null) return relevant.length === 0 ? { ok: true } : { ok: false, code: 'alias_mismatch' };
  const finalPath = join(view.path, aliasName);
  const expectedRelative = artifactIdentityPath(manifest, winner);
  if (winner.relativePath !== expectedRelative || absoluteRelativePath(context.root, winner.relativePath) !== finalPath) {
    return { ok: false, code: 'invalid_inventory' };
  }
  if (Object.hasOwn(winner, 'tempRelativePath')) {
    const tempPath = absoluteRelativePath(context.root, winner.tempRelativePath);
    const expectedPrefix = `patches/${tempPrefix}`;
    if (tempPath === null || !winner.tempRelativePath.startsWith(expectedPrefix)) return { ok: false, code: 'invalid_inventory' };
    const suffix = winner.tempRelativePath.slice(expectedPrefix.length);
    if (!validArtifactTempSuffix(suffix)) return { ok: false, code: 'invalid_inventory' };
    const state = await validatePendingArtifact(winner, finalPath, tempPath, context);
    if (!state.ok) return { ok: false, code: 'alias_mismatch' };
    const allowed = new Set([
      ...(state.final.exists ? [aliasName] : []),
      ...(state.temp.exists ? [basename(tempPath)] : []),
    ]);
    if (relevant.some((entry) => !allowed.has(entry.name)) || relevant.length !== allowed.size) {
      return { ok: false, code: 'alias_mismatch' };
    }
    if (state.final.exists) targets.push(finalPath);
    if (state.temp.exists) targets.push(tempPath);
    return { ok: true };
  }
  const state = await validateCommittedArtifact(winner, finalPath, context, { allowAbsent: true });
  if (!state.ok) return { ok: false, code: 'alias_mismatch' };
  if (relevant.some((entry) => entry.name !== aliasName) || relevant.length !== (state.final.exists ? 1 : 0)) {
    return { ok: false, code: 'alias_mismatch' };
  }
  const candidate = manifest.candidateRefs.find((entry) => entry.candidateId === winner.candidateId);
  if (candidate?.patchRef === null || candidate?.patchRef === undefined ||
      candidate.patchRef.sha256 !== winner.ref.sha256 || candidate.patchRef.bytes !== winner.ref.bytes) {
    return { ok: false, code: 'alias_mismatch' };
  }
  if (state.final.exists) targets.push(finalPath);
  return { ok: true };
}

async function validateCompleteFinal(runDir, manifestRecord, context) {
  const { manifest, bytes: manifestBytes } = manifestRecord;
  const rootEntries = await listDirectory(runDir, context);
  if (rootEntries === null) return { ok: false, code: 'unexpected_entry' };
  const checkpointLookalikes = rootEntries.filter((entry) => entry.name.startsWith('.tmp-manifest.json-'));
  const checkpointEntries = checkpointLookalikes.filter((entry) => validCheckpointTempName(entry.name));
  if (checkpointEntries.length !== checkpointLookalikes.length) return { ok: false, code: 'checkpoint_temp_invalid' };
  if (checkpointEntries.length > 1) return { ok: false, code: 'checkpoint_temp_invalid' };
  const allowedRoot = new Set(['manifest.json', 'candidates', 'attempts', 'evidence', ...checkpointEntries.map((entry) => entry.name)]);
  // ★★ 다섯째 kind `plan` 은 실행 **루트**에 착지하는 유일한 artifact 다(`runs/<id>/plan.json`).
  //   그 이름을 이 집합에 **디스크에 실제로 있을 때만** 넣는다: 보류 중인 plan 은 최종본이 아직
  //   없을 수 있고, 없는 이름을 넣으면 바로 아래 크기 대조가 어긋나 그 실행이 영구 미회수가 된다
  //   (하위 디렉터리 셋이 `state.final.exists` 를 보고 나서 허용 목록에 넣는 것과 같은 규율).
  //   매니페스트가 **모르는** plan.json 은 여전히 `unexpected_entry` 다 — 이름 하나를 연 것이
  //   아니라 등재된 항목 하나가 자기 자리를 얻은 것이다.
  for (const entry of [...manifest.pendingArtifacts, ...manifest.committedArtifacts]) {
    if (entry.artifactKind !== 'plan') continue;
    for (const relative of [entry.relativePath, entry.tempRelativePath]) {
      if (typeof relative !== 'string') continue;
      const name = relative.slice(relative.lastIndexOf('/') + 1);
      if (rootEntries.some((item) => item.name === name)) allowedRoot.add(name);
    }
  }
  if (rootEntries.some((entry) => !allowedRoot.has(entry.name)) || rootEntries.length !== allowedRoot.size) {
    return { ok: false, code: 'unexpected_entry' };
  }
  const directories = new Map();
  for (const name of ['candidates', 'attempts', 'evidence']) {
    const entry = rootEntries.find((candidate) => candidate.name === name);
    if (entry === undefined || direntKind(entry) !== 'directory') return { ok: false, code: 'unsafe_type' };
    const path = join(runDir, name);
    const checked = await safeExisting(path, 'directory', context);
    if (!checked.ok) return checked;
    const entries = await listDirectory(path, context);
    if (entries === null) return { ok: false, code: 'unexpected_entry' };
    directories.set(name, { path, entries, allowed: new Set() });
  }
  if (checkpointEntries.length === 1) {
    if (direntKind(checkpointEntries[0]) !== 'file') return { ok: false, code: 'unsafe_type' };
    const checkpoint = await validateCheckpointTemp(join(runDir, checkpointEntries[0].name), manifest, manifestBytes, context);
    if (!checkpoint.ok) return checkpoint;
  }

  const targets = [runDir];
  const inventories = [...manifest.pendingArtifacts, ...manifest.committedArtifacts];
  const winner = inventories.find((entry) => entry.artifactKind === 'winner') ?? null;
  for (const entry of inventories.filter((item) => item.artifactKind !== 'winner')) {
    const expectedRelative = artifactIdentityPath(manifest, entry);
    const finalPath = absoluteRelativePath(context.root, entry.relativePath);
    if (expectedRelative === null || entry.relativePath !== expectedRelative || finalPath === null) {
      return { ok: false, code: 'invalid_inventory' };
    }
    // ★ `plan` 의 소유 디렉터리는 실행 루트 자체다. 그 exactness 는 위 `allowedRoot` 가 이미
    //   쟀으므로 여기서 다시 세지 않는다(그래서 `allowed` 는 버려지는 집합이다).
    const directory = entry.artifactKind === 'plan'
      ? { path: runDir, allowed: new Set() }
      : directories.get(entry.artifactKind === 'candidate' ? 'candidates'
        : entry.artifactKind === 'attempt' ? 'attempts' : 'evidence');
    if (dirname(finalPath) !== directory.path) return { ok: false, code: 'invalid_inventory' };
    if (Object.hasOwn(entry, 'tempRelativePath')) {
      const tempPath = absoluteRelativePath(context.root, entry.tempRelativePath);
      if (tempPath === null || dirname(tempPath) !== directory.path) return { ok: false, code: 'invalid_inventory' };
      const expectedTempPrefix = `.tmp-${basename(finalPath)}-`;
      const suffix = basename(tempPath).startsWith(expectedTempPrefix)
        ? basename(tempPath).slice(expectedTempPrefix.length) : '';
      if (!validArtifactTempSuffix(suffix)) return { ok: false, code: 'invalid_inventory' };
      const state = await validatePendingArtifact(entry, finalPath, tempPath, context);
      if (!state.ok) return state;
      if (state.final.exists) directory.allowed.add(basename(finalPath));
      if (state.temp.exists) directory.allowed.add(basename(tempPath));
    } else {
      const state = await validateCommittedArtifact(entry, finalPath, context);
      if (!state.ok) return state;
      directory.allowed.add(basename(finalPath));
    }
  }
  for (const { entries, allowed } of directories.values()) {
    if (entries.some((entry) => !allowed.has(entry.name)) || entries.length !== allowed.size) {
      return { ok: false, code: 'unexpected_entry' };
    }
  }
  const alias = await validateWinnerInventory(manifest, winner, context, targets);
  if (!alias.ok) return alias;
  return { ok: true, targets };
}

async function validateRunUnit({ root, runsDir, runId, finalEntry, lockEntry, nowMs, deps }) {
  const context = { root, deps, snapshot: newSnapshot(root) };
  for (const [path, kind] of [[root, 'directory'], [runsDir, 'directory']]) {
    const checked = await safeExisting(path, kind, context);
    if (!checked.ok) return checked;
  }
  const currentRuns = await listDirectory(runsDir, context);
  if (currentRuns === null) return { ok: false, code: 'unsafe_type' };
  // Discovery establishes which logical IDs are counted. Ownership validation uses
  // a fresh directory view so a lock/final published in between cannot be mistaken
  // for the older half-unit that discovery observed.
  finalEntry = currentRuns.find((entry) => entry.name === runId) ?? null;
  lockEntry = currentRuns.find((entry) => entry.name === `.init-lock-${runId}.json`) ?? null;
  const finalPath = join(runsDir, runId);
  const lockPath = join(runsDir, `.init-lock-${runId}.json`);
  let lock = null;
  if (lockEntry !== null) {
    if (direntKind(lockEntry) !== 'file') return { ok: false, code: 'unsafe_type' };
    lock = await readInitLock(lockPath, runId, context);
    if (!lock.ok) return lock.code === 'unsafe_type' || lock.code === 'permission_unverified' || lock.code === 'alias_mismatch'
      ? lock : { ok: false, code: 'invalid_lock' };
  } else {
    context.snapshot.absent.add(lockPath);
  }

  if (lock?.zero) {
    if (finalEntry !== null) return { ok: false, code: 'invalid_lock' };
    const expired = expiredStatMtime(lock.info, nowMs, RUN_ARTIFACT_RETENTION_MS);
    return { ok: true, expired, targets: expired ? [lockPath] : [], snapshot: context.snapshot };
  }
  if (lock !== null && nowMs < lock.value.expiresAt) {
    return { ok: true, expired: false, targets: [], snapshot: context.snapshot };
  }
  if (finalEntry === null) {
    context.snapshot.absent.add(finalPath);
    return lock === null
      ? { ok: false, code: 'missing_manifest' }
      : { ok: true, expired: true, targets: [lockPath], snapshot: context.snapshot };
  }
  if (direntKind(finalEntry) !== 'directory') return { ok: false, code: 'unsafe_type' };
  const final = await safeExisting(finalPath, 'directory', context);
  if (!final.ok) return final;
  const finalEntries = await listDirectory(finalPath, context);
  if (finalEntries === null) return { ok: false, code: 'unexpected_entry' };
  const manifestEntry = finalEntries.find((entry) => entry.name === 'manifest.json') ?? null;
  if (manifestEntry === null) {
    if (lock === null) return { ok: false, code: 'missing_manifest' };
    const partial = await validatePartialFinal(finalPath, lock.value, context);
    if (!partial.ok) return partial;
    return {
      ok: true,
      expired: true,
      targets: [finalPath, lockPath],
      snapshot: context.snapshot,
    };
  }
  if (direntKind(manifestEntry) !== 'file') return { ok: false, code: 'unsafe_type' };
  const manifest = await readManifest(join(finalPath, 'manifest.json'), runId, context);
  if (!manifest.ok) return manifest;
  if (lock !== null && (manifest.manifest.generation !== lock.value.generation ||
      manifest.manifest.createdAt !== lock.value.createdAt || manifest.manifest.expiresAt !== lock.value.expiresAt)) {
    return { ok: false, code: 'generation_mismatch' };
  }
  if (nowMs < manifest.manifest.expiresAt) {
    return { ok: true, expired: false, targets: [], snapshot: context.snapshot };
  }
  const complete = await validateCompleteFinal(finalPath, manifest, context);
  if (!complete.ok) return complete;
  return {
    ok: true,
    expired: true,
    targets: [...complete.targets, ...(lock === null ? [] : [lockPath])],
    snapshot: context.snapshot,
  };
}

async function revalidateSnapshot(snapshot, deps) {
  for (const [path, expected] of snapshot.paths) {
    const status = await lstatStatus(path, deps.lstat);
    if (status.exists !== true || kindOf(status.info) !== expected.kind ||
        statIdentity(status.info, expected.kind) !== expected.identity) return false;
    const real = await canonicalValue(deps.canonicalPath, path);
    if (real === null || !samePath(real, resolve(path)) ||
        !samePath(real, snapshot.root) && !contained(snapshot.root, real)) return false;
  }
  for (const path of snapshot.absent) {
    if ((await lstatStatus(path, deps.lstat)).exists !== false) return false;
  }
  for (const [path, expected] of snapshot.listings) {
    try {
      const entries = await deps.readdir(path, { withFileTypes: true });
      const actual = JSON.stringify(entries.map((entry) => [entry.name, direntKind(entry)])
        .sort((a, b) => compareUtf8(a[0], b[0])));
      if (actual !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function createQuarantineParent(snapshot, deps, expired) {
  const runsDir = join(snapshot.root, 'runs');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (expired()) return null;
    let path;
    try {
      path = join(runsDir, `.reap-${randomBytes(16).toString('hex')}`);
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      return null;
    }
    const status = await lstatStatus(path, deps.lstat);
    if (status.exists !== true || kindOf(status.info) !== 'directory') return null;
    const real = await canonicalValue(deps.canonicalPath, path);
    if (real === null || !samePath(real, resolve(path)) || !contained(snapshot.root, real)) return null;
    if (!await ownedPath(deps, path, 'directory')) return null;
    let entries;
    try {
      entries = await deps.readdir(path, { withFileTypes: true });
    } catch {
      return null;
    }
    if (!Array.isArray(entries) || entries.length !== 0) return null;
    const authority = statAuthority(status.info, 'directory');
    if (authority === null) return null;
    return { path, anchorIdentity: authority.anchorKey };
  }
  return null;
}

function remapQuarantinedPath(path, movedTargets) {
  const target = movedTargets.find((candidate) =>
    samePath(path, candidate.path) || contained(candidate.path, path));
  if (target === undefined) return null;
  const suffix = relative(target.path, path);
  const mapped = suffix === '' ? target.movedPath : resolve(target.movedPath, suffix);
  return samePath(mapped, target.movedPath) || contained(target.movedPath, mapped)
    ? { path: mapped, target }
    : null;
}

function intentionallyChangedParent(path, movedTargets, quarantine) {
  return samePath(path, dirname(quarantine.path)) ||
    movedTargets.some((target) => samePath(path, dirname(target.path)));
}

function expectedQuarantinedListing(path, expected, movedTargets, quarantine, afterRemoval) {
  let entries;
  try {
    entries = JSON.parse(expected);
  } catch {
    return null;
  }
  let changed = false;
  for (const target of movedTargets) {
    if (!samePath(path, dirname(target.path))) continue;
    entries = entries.filter(([name]) => name !== basename(target.path));
    changed = true;
  }
  if (samePath(path, dirname(quarantine.path))) {
    if (!afterRemoval) entries.push([basename(quarantine.path), 'directory']);
    changed = true;
  }
  return changed
    ? JSON.stringify(entries.sort((a, b) => compareUtf8(a[0], b[0])))
    : expected;
}

async function validateQuarantinedSnapshot(snapshot, movedTargets, quarantine, deps, { afterRemoval = false } = {}) {
  for (const [path, expected] of snapshot.paths) {
    const mapped = remapQuarantinedPath(path, movedTargets);
    if (mapped !== null) {
      if (afterRemoval) continue;
      const status = await lstatStatus(mapped.path, deps.lstat);
      const topLevel = samePath(path, mapped.target.path);
      if (status.exists !== true || kindOf(status.info) !== expected.kind ||
          (topLevel
            ? quarantineIdentity(status.info, expected.kind) !== expected.quarantineIdentity
            : statIdentity(status.info, expected.kind) !== expected.identity)) return false;
      const real = await canonicalValue(deps.canonicalPath, mapped.path);
      if (real === null || !samePath(real, resolve(mapped.path)) ||
          !samePath(real, mapped.target.movedPath) && !contained(mapped.target.movedPath, real)) return false;
      continue;
    }
    const status = await lstatStatus(path, deps.lstat);
    const mutableParent = intentionallyChangedParent(path, movedTargets, quarantine);
    if (status.exists !== true || kindOf(status.info) !== expected.kind ||
        (mutableParent
          ? anchorIdentity(status.info, expected.kind) !== expected.anchorIdentity
          : statIdentity(status.info, expected.kind) !== expected.identity)) return false;
    const real = await canonicalValue(deps.canonicalPath, path);
    if (real === null || !samePath(real, resolve(path)) ||
        !samePath(real, snapshot.root) && !contained(snapshot.root, real)) return false;
  }
  for (const path of snapshot.absent) {
    const mapped = remapQuarantinedPath(path, movedTargets);
    if (mapped !== null && !afterRemoval) {
      if ((await lstatStatus(mapped.path, deps.lstat)).exists !== false) return false;
    } else if (mapped === null && (await lstatStatus(path, deps.lstat)).exists !== false) {
      return false;
    }
  }
  for (const [path, expected] of snapshot.listings) {
    const mapped = remapQuarantinedPath(path, movedTargets);
    if (mapped !== null && afterRemoval) continue;
    const listingPath = mapped?.path ?? path;
    try {
      const entries = await deps.readdir(listingPath, { withFileTypes: true });
      if (!Array.isArray(entries)) return false;
      const actual = JSON.stringify(entries.map((entry) => [entry.name, direntKind(entry)])
        .sort((a, b) => compareUtf8(a[0], b[0])));
      const expectedListing = mapped === null
        ? expectedQuarantinedListing(path, expected, movedTargets, quarantine, afterRemoval)
        : expected;
      if (expectedListing === null || actual !== expectedListing) return false;
    } catch {
      return false;
    }
  }
  for (const { path } of movedTargets) {
    if ((await lstatStatus(path, deps.lstat)).exists !== false) return false;
  }
  return true;
}

async function classifyRenameFailure(path, movedPath, expected, movedTargets, deps) {
  const source = await lstatStatus(path, deps.lstat);
  const destination = await lstatStatus(movedPath, deps.lstat);
  const sourceUnchanged = source.exists === true && kindOf(source.info) === expected.kind &&
    expectedSourceUnchanged(source.info, expected, movedTargets);
  const destinationExpected = destination.exists === true && kindOf(destination.info) === expected.kind &&
    quarantineIdentity(destination.info, expected.kind) === expected.quarantineIdentity;
  if (source.exists === false && destinationExpected) {
    return { completed: true, info: destination.info };
  }
  if (sourceUnchanged && destination.exists === false) return { completed: false, code: 'removal_failed' };
  return { completed: false, code: 'validation_changed' };
}

function patchRemovalTarget(path, root) {
  if (!samePath(dirname(path), join(root, 'patches'))) return false;
  const name = basename(path);
  if (name.endsWith('.patch') && !name.startsWith('.tmp-')) {
    return validRunId(name.slice(0, -'.patch'.length));
  }
  const match = /^\.tmp-([a-z0-9][a-z0-9_-]{0,63})\.patch-(\d+-[0-9a-f]{12})$/.exec(name);
  return match !== null && validRunId(match[1]) && validArtifactTempSuffix(match[2]);
}

function prepareRemovalTargets(targets, snapshot) {
  const runsDir = join(snapshot.root, 'runs');
  const quarantineDevice = snapshot.paths.get(runsDir)?.deviceIdentity ?? null;
  if (quarantineDevice === null) return null;
  const unique = [...new Set(targets)];
  const prepared = [];
  for (const path of unique) {
    if (typeof path !== 'string' || !isAbsolute(path) || !samePath(resolve(path), path) ||
        !contained(snapshot.root, path)) return null;
    const expected = snapshot.paths.get(path);
    if (expected === undefined || expected.deviceIdentity !== quarantineDevice) return null;
    const lockMatch = INIT_LOCK_PATTERN.exec(basename(path));
    let rank;
    if (expected.kind === 'file' && patchRemovalTarget(path, snapshot.root)) rank = 0;
    else if (expected.kind === 'file' && samePath(dirname(path), runsDir) &&
        lockMatch !== null && validRunId(lockMatch[1])) rank = 1;
    else if (expected.kind === 'directory' && samePath(dirname(path), runsDir) &&
        validRunId(basename(path))) rank = 2;
    else return null;
    prepared.push({ path, expected, rank });
  }
  for (let left = 0; left < prepared.length; left += 1) {
    for (let right = left + 1; right < prepared.length; right += 1) {
      if (samePath(prepared[left].path, prepared[right].path) ||
          contained(prepared[left].path, prepared[right].path) ||
          contained(prepared[right].path, prepared[left].path)) return null;
    }
  }
  return prepared.sort((left, right) => left.rank - right.rank || compareUtf8(left.path, right.path));
}

function movedHardlinkPeer(expected, movedTargets) {
  if (expected.kind !== 'file') return null;
  return movedTargets.find((target) => target.expected.physicalIdentity === expected.physicalIdentity) ?? null;
}

function expectedSourceUnchanged(info, expected, movedTargets) {
  const hardlinkPeer = movedHardlinkPeer(expected, movedTargets);
  if (hardlinkPeer === null) return statIdentity(info, expected.kind) === expected.identity;
  return quarantineIdentity(info, expected.kind) === expected.quarantineIdentity &&
    quarantineIdentity(info, expected.kind) === quarantineIdentity(hardlinkPeer.movedInfo, expected.kind);
}

async function removeOwnedTargets(targets, snapshot, deps, expired) {
  const prepared = prepareRemovalTargets(targets, snapshot);
  if (prepared === null || prepared.length === 0) return 'validation_changed';
  if (expired()) return 'removal_failed';
  const quarantine = await createQuarantineParent(snapshot, deps, expired);
  if (quarantine === null) return 'removal_failed';
  const movedTargets = [];
  for (const [index, { path, expected }] of prepared.entries()) {
    if (expired()) return 'removal_failed';
    const status = await lstatStatus(path, deps.lstat);
    if (status.exists !== true || kindOf(status.info) !== expected.kind ||
        !expectedSourceUnchanged(status.info, expected, movedTargets)) return 'validation_changed';
    const movedPath = join(quarantine.path, `unit-${String(index).padStart(3, '0')}`);
    if ((await lstatStatus(movedPath, deps.lstat)).exists !== false) return 'validation_changed';
    if (expired()) return 'removal_failed';
    let moved;
    try {
      await rename(path, movedPath);
    } catch {
      const classified = await classifyRenameFailure(path, movedPath, expected, movedTargets, deps);
      if (!classified.completed) return classified.code;
      moved = { exists: true, info: classified.info };
    }
    moved ??= await lstatStatus(movedPath, deps.lstat);
    if (moved.exists !== true || kindOf(moved.info) !== expected.kind ||
        quarantineIdentity(moved.info, expected.kind) !== expected.quarantineIdentity) {
      return 'validation_changed';
    }
    movedTargets.push({ path, movedPath, expected, movedInfo: moved.info });
  }
  const parent = await lstatStatus(quarantine.path, deps.lstat);
  if (parent.exists !== true || kindOf(parent.info) !== 'directory' ||
      anchorIdentity(parent.info, 'directory') !== quarantine.anchorIdentity) return 'validation_changed';
  const parentIdentity = statIdentity(parent.info, 'directory');
  let listing;
  try {
    listing = await deps.readdir(quarantine.path, { withFileTypes: true });
  } catch {
    return 'validation_changed';
  }
  if (!Array.isArray(listing)) return 'validation_changed';
  listing.sort((left, right) => compareUtf8(left.name, right.name));
  if (listing.length !== movedTargets.length || listing.some((entry, index) =>
    entry.name !== `unit-${String(index).padStart(3, '0')}` ||
    direntKind(entry) !== movedTargets[index].expected.kind)) return 'validation_changed';
  const parentBeforeRemoval = await lstatStatus(quarantine.path, deps.lstat);
  if (parentBeforeRemoval.exists !== true || kindOf(parentBeforeRemoval.info) !== 'directory' ||
      statIdentity(parentBeforeRemoval.info, 'directory') !== parentIdentity) return 'validation_changed';
  const parentReal = await canonicalValue(deps.canonicalPath, quarantine.path);
  if (parentReal === null || !samePath(parentReal, resolve(quarantine.path)) ||
      !contained(snapshot.root, parentReal)) return 'validation_changed';
  if (!await ownedPath(deps, quarantine.path, 'directory')) return 'validation_changed';
  for (const { movedPath, expected } of movedTargets) {
    const moved = await lstatStatus(movedPath, deps.lstat);
    if (moved.exists !== true || kindOf(moved.info) !== expected.kind ||
        quarantineIdentity(moved.info, expected.kind) !== expected.quarantineIdentity) return 'validation_changed';
    const real = await canonicalValue(deps.canonicalPath, movedPath);
    if (real === null || !samePath(real, resolve(movedPath)) || !contained(quarantine.path, real)) {
      return 'validation_changed';
    }
  }
  if (!await validateQuarantinedSnapshot(snapshot, movedTargets, quarantine, deps)) return 'validation_changed';
  if (expired()) return 'removal_failed';
  try {
    await deps.rm(quarantine.path, { recursive: true, force: true });
  } catch {
    return 'removal_failed';
  }
  if ((await lstatStatus(quarantine.path, deps.lstat)).exists !== false) return 'removal_failed';
  if (!await validateQuarantinedSnapshot(snapshot, movedTargets, quarantine, deps, { afterRemoval: true })) {
    return 'validation_changed';
  }
  return null;
}

/**
 * Fully validates and reaps expired run ownership units. This function never throws and
 * never exposes physical paths or filesystem errors in its bounded result.
 */
export async function sweepRuns(stateRoot, nowMs, options) {
  const emptyUnsafe = (code) => frozenRunResult({ skipped: [{ runId: null, code }] });
  const parsed = exactFunctionOptions(options, new Set([
    'excludeRunId', 'canonicalPath', 'lstat', 'open', 'readdir', 'readFile', 'rm',
    'verifyOwnerOnly', 'validateTransition', 'barrier', 'deadlineAt', 'nowMs',
  ]));
  if (parsed === null || typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot) ||
      !samePath(resolve(stateRoot), stateRoot) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return emptyUnsafe('unsafe_root');
  }
  if (Object.hasOwn(parsed, 'excludeRunId') && !validRunId(parsed.excludeRunId)) return emptyUnsafe('invalid_exclusion');
  const expired = agedDeadline(parsed.deadlineAt, parsed.nowMs);
  if (expired === null || expired()) return frozenRunResult();
  const deps = {
    canonicalPath: parsed.canonicalPath ?? canonical,
    lstat: parsed.lstat ?? exactLstat,
    open: parsed.open ?? open,
    readdir: parsed.readdir ?? readdir,
    rm: parsed.rm ?? rm,
    verifyOwnerOnly: parsed.verifyOwnerOnly ?? verifyArtifactOwnerOnly,
    validateTransition: parsed.validateTransition ?? validateRunManifestTransitionV1,
    barrier: parsed.barrier ?? (async () => {}),
  };
  try {
    const rootStatus = await lstatStatus(stateRoot, deps.lstat);
    if (rootStatus.exists !== true || kindOf(rootStatus.info) !== 'directory') return emptyUnsafe('unsafe_root');
    if (expired()) return frozenRunResult();
    const root = await canonicalValue(deps.canonicalPath, stateRoot);
    if (root === null || !samePath(root, resolve(stateRoot))) return emptyUnsafe('unsafe_root');
    const runsDir = join(root, 'runs');
    if (expired()) return frozenRunResult();
    const runsStatus = await lstatStatus(runsDir, deps.lstat);
    if (runsStatus.exists === false) return frozenRunResult();
    if (runsStatus.exists !== true || kindOf(runsStatus.info) !== 'directory') {
      return frozenRunResult({ skipped: [{ runId: null, code: 'unsafe_type' }] });
    }
    const preflight = { root, deps, snapshot: newSnapshot(root) };
    for (const [path, kind] of [[root, 'directory'], [runsDir, 'directory']]) {
      if (expired()) return frozenRunResult();
      const checked = await safeExisting(path, kind, preflight);
      if (!checked.ok) return frozenRunResult({ skipped: [{ runId: null, code: checked.code }] });
    }
    let entries;
    try {
      if (expired()) return frozenRunResult();
      entries = await deps.readdir(runsDir, { withFileTypes: true });
    } catch {
      return frozenRunResult({ skipped: [{ runId: null, code: 'unsafe_type' }] });
    }
    const groups = new Map();
    let foreign = false;
    const excluded = parsed.excludeRunId;
    for (const entry of entries) {
      const lockMatch = INIT_LOCK_PATTERN.exec(entry.name);
      const finalRunId = validRunId(entry.name) ? entry.name : null;
      const lockRunId = lockMatch !== null && validRunId(lockMatch[1]) ? lockMatch[1] : null;
      const runId = finalRunId ?? lockRunId;
      if (runId === null) {
        foreign = true;
        continue;
      }
      if (runId === excluded) continue;
      const group = groups.get(runId) ?? { finalEntry: null, lockEntry: null };
      if (finalRunId !== null) group.finalEntry = entry;
      else group.lockEntry = entry;
      groups.set(runId, group);
    }

    const removed = [];
    const skipped = foreign ? [{ runId: null, code: 'unrecognized_entry' }] : [];
    const ordered = [...groups.entries()].sort((left, right) => compareUtf8(left[0], right[0]));
    for (const [runId, group] of ordered) {
      if (expired()) break;
      const validation = await validateRunUnit({ root, runsDir, runId, ...group, nowMs, deps });
      if (expired()) break;
      if (!validation.ok) {
        skipped.push({ runId, code: validation.code });
        continue;
      }
      if (!validation.expired) continue;
      try {
        await deps.barrier('before-run-delete');
      } catch {
        skipped.push({ runId, code: 'validation_changed' });
        continue;
      }
      if (expired()) break;
      if (!await revalidateSnapshot(validation.snapshot, deps)) {
        skipped.push({ runId, code: 'validation_changed' });
        continue;
      }
      if (expired()) break;
      const removalCode = await removeOwnedTargets(validation.targets, validation.snapshot, deps, expired);
      if (removalCode !== null) {
        skipped.push({ runId, code: removalCode });
        continue;
      }
      removed.push(runId);
    }
    return frozenRunResult({ removed, checked: groups.size, skipped });
  } catch {
    return emptyUnsafe('unsafe_root');
  }
}

/**
 * 상태 루트 밑의 디렉터리 하나에서 **우리가 만든 이름 모양**의 낡은 파일만 지운다.
 * **절대 throw 하지 않는다.**
 *
 * ★ 판정 재료가 이 모듈의 나머지와 다르다: 이 파일들은 원장에 없어서 소유자를 확인할
 *   방법이 나이뿐이다. 그래서 이름 모양과 나이를 **둘 다** 요구하고, 그 위에 경로를
 *   `canonical` 로 편 뒤 그 디렉터리 밑인지 확인한다(`resolveSafeWorktree` 와 같은
 *   규율). 못 펴면 지우지 않는다.
 *
 * ★ 네 호출자(scratch · patches · logs · plans)가 **같은 함수**를 지난다. 각자 자기 규칙을 갖게
 *   되면 그 차이가 곧 다음 결함이다 — 이 저장소는 경로 비교에서 그 결함을 세 번 냈다.
 *
 * ★ `kind` 는 넷째 호출자가 더했다(WS4a 태스크 9). 플래너 스크래치만 **디렉터리**이고 나머지 셋은
 *   파일이다. 판정은 여전히 이름 모양 + 나이 + `canonical` 담김 셋이고, 바뀌는 것은 `withFileTypes`
 *   의 종류 검사와 `rm` 의 `recursive` 뿐이다 — 디렉터리에 `recursive` 없이 `rm` 을 부르면 비어
 *   있지 않은 스크래치는 조용히 안 지워지고 `removed` 만 0 으로 돌아온다.
 *
 * @returns `{ removed, checked }` — `checked` 는 이름 모양이 맞아 나이를 본 개수다.
 */
async function sweepAged({ stateRoot, name, shapes, maxAgeMs, nowMs, excludeName = null, acceptName = null,
  kind = 'file', deadlineAt, clock }) {
  const empty = { removed: 0, checked: 0 };
  const expired = agedDeadline(deadlineAt, clock);
  if (expired === null || expired()) return empty;
  const realRoot = await canonical(stateRoot);
  if (realRoot === null) return empty;

  // 그 자리가 정션이면 실체는 상태 루트 밖일 수 있다. 이름 모양과 나이만 보면 링크
  // 하나로 스윕의 사정거리가 사용자 디렉터리까지 늘어난다.
  if (expired()) return empty;
  const dir = await canonical(join(realRoot, name));
  if (dir === null || !contained(realRoot, dir)) return empty;

  let directory;
  try {
    if (expired()) return empty;
    directory = await opendir(dir);
  } catch {
    return empty;
  }

  let removed = 0;
  let checked = 0;
  let scanned = 0;
  try {
    for await (const entry of directory) {
      if (scanned >= AGED_SWEEP_ENTRY_CAP || expired()) break;
      scanned += 1;
      if (entry.name === excludeName) continue;
      // `withFileTypes` 의 판정은 lstat 계열이라 심링크는 여기서 이미 걸러진다. 아래
      // `canonical` 확인은 그 위의 두 번째 겹이다(디렉터리 정션·마운트 포인트).
      if (!(kind === 'directory' ? entry.isDirectory() : entry.isFile()) ||
          !shapes.some((shape) => shape.test(entry.name)) ||
          acceptName !== null && !acceptName(entry.name)) continue;
      checked += 1;
      if (expired()) break;
      const full = await canonical(join(dir, entry.name));
      if (full === null || !contained(dir, full)) continue;
      if (expired()) break;
      const info = await stat(full).catch(() => null);
      if (info === null || nowMs - info.mtimeMs < maxAgeMs) continue;
      if (expired()) break;
      if (await rm(full, { force: true, recursive: kind === 'directory' }).then(() => true, () => false)) removed += 1;
    }
  } catch {
    // 읽은 prefix까지만 처리하고 나머지는 다음 sweep에 보존한다.
  } finally {
    await directory.close().catch(() => {});
  }
  return { removed, checked };
}

/**
 * 강제 종료가 남긴 오래된 scratch 잔재를 치운다.
 *
 * ★ 왜 리퍼에 있나 (계획 2 이월 1): 원래는 `src/engine.mjs` 안에 있어서 **실행이 시작될
 *   때만** 돌았다. 그러면 부팅한 뒤 한 번도 실행하지 않은 세션에서 아무도 치우지 않는다.
 *   부팅 스윕(`sweepOrphans`)이 같은 일을 하고, 실행 시작 스윕도 **그대로 둔다** — 장수
 *   서버에서는 부팅이 며칠에 한 번이라 그 사이에 생긴 6시간 잔재를 부팅 스윕이 못 본다.
 *   두 자리가 같은 함수를 부른다.
 */
export function sweepScratch(stateRoot, nowMs, options = {}) {
  return sweepAged({ stateRoot, name: 'scratch', shapes: SCRATCH_NAMES, maxAgeMs: SCRATCH_STALE_MS, nowMs,
    deadlineAt: options?.deadlineAt, clock: options?.nowMs });
}

/**
 * `<stateRoot>/plans/<runId>-planner-<6자>` 를 scratch 와 **같은 6시간**으로 치운다
 * (WS4a 스펙 §0-PL, 리서치 메모 §E).
 *
 * ★★ **오늘까지 이 디렉터리를 쓰는 사람은 아무도 없었다.** 엔진은 플래너 호출이 끝나면 자기
 *   스크래치를 지우지만 그것이 실패하면 `planner_scratch_cleanup_pending` 알림 하나를 붙이고
 *   끝났고 — 그 알림 하나마다 디렉터리 하나가 **영구히** 남았다. 남은 것은 모델이 쓴 계획
 *   초안이라 평문이다. 정본이 매니페스트에 등재된 지금 그 스크래치에는 남은 값이 없다.
 * ★ 6시간의 근거는 scratch 와 같다: 「동시에 도는 실행의 자리를 지우지 않는다」. 플래너 호출은
 *   실행 마감(`MAX_WAIT_MS`, 55분)에 묶여 있으므로 6시간을 넘겨 살아 있는 스크래치는 없다.
 * ★ 넷 중 유일하게 **디렉터리**를 지운다 — `sweepAged` 의 `kind` 가 그 한 가지 차이다.
 */
export function sweepPlans(stateRoot, nowMs, options = {}) {
  return sweepAged({
    stateRoot,
    name: 'plans',
    shapes: PLAN_SCRATCH_NAMES,
    maxAgeMs: SCRATCH_STALE_MS,
    nowMs,
    kind: 'directory',
    deadlineAt: options?.deadlineAt,
    clock: options?.nowMs,
  });
}

/**
 * 보존 기간이 지난 최종 패치를 치운다 (계획 2 이월 2). scratch 와 같은 두 자리에서 돈다.
 */
export function sweepPatches(stateRoot, nowMs, options) {
  const parsed = exactFunctionOptions(options, new Set(['excludeRunId', 'deadlineAt', 'nowMs']));
  if (parsed === null || Object.hasOwn(parsed, 'excludeRunId') && !validRunId(parsed.excludeRunId)) {
    return Promise.resolve({ removed: 0, checked: 0 });
  }
  return sweepAged({
    stateRoot,
    name: 'patches',
    shapes: PATCH_NAMES,
    maxAgeMs: RUN_ARTIFACT_RETENTION_MS,
    nowMs,
    excludeName: Object.hasOwn(parsed, 'excludeRunId') ? `${parsed.excludeRunId}.patch` : null,
    acceptName: (name) => validRunId(name.slice(0, -'.patch'.length)),
    deadlineAt: parsed.deadlineAt,
    clock: parsed.nowMs,
  });
}

/**
 * 그 증명 디렉터리가 만료됐는가. 판정 셋이고, **순서가 뜻을 갖는다**.
 *
 * ★★ 살아 있는 `.lock` 이 가장 먼저, 그리고 무조건 이긴다. 오래된 실행 하나가 재증명
 *   (`orch_prove`) 을 도는 동안 다른 `orch_run` 이 자기 `excludeRunId` 로 이 스윕을 돌리면, 그
 *   실행의 옛 기록은 여전히 만료로 읽힌다 — 도는 재증명의 발밑(그 디렉터리)이 지워지는 사고다.
 *   `proofLockLive`(`src/proof-record.mjs`, `acquireProofLock` 이 잠그고 재는 것과 **같은 정본**)가
 *   살아 있다고 답하면 기록이 뭐라 하든 이 유닛은 만료가 아니다.
 * ★★ 잠금이 죽었거나 없으면, 기록이 읽히는 한 기록의 `expiresAt` 이 답이다. 증명은 실행이 끝난
 *   한참 뒤에 돌 수 있어서(실측: 실행 9 는 2026-08-28 에 55분 상한이 다섯 번째 스위트 실행에서
 *   끊어 증명 없이 끝났고, 증명은 그 뒤 별도 호출로 돈다) 디렉터리의 mtime 은 그 실행의 나이가
 *   아니다 — mtime 으로만 재면 어제 만든 증명이 「30일 지난 실행의 것」이라는 이유로 남고, 그
 *   반대도 생긴다.
 * ★ 기록을 못 읽을 때만 나이(30일)로 잰다. 그 자리에 있는 것이 우리 것이 아닐 수 있으므로
 *   `patches` 스윕과 같은 규율이다 — 이름 모양 + 나이 + `canonical` 담김 셋이 다 맞아야 지운다.
 * ★ 바이트 상한을 먼저 본다: `readFile` 에는 상한이 없고, 남이 심은 1GB 짜리 `proof.json` 을
 *   통째로 읽으면 스윕 하나가 서버를 멈춘다. 상한 밖은 「못 읽는다」로 접어 나이 판정으로 간다.
 */
async function expiredProofUnit(dir, nowMs, readOne, statOne) {
  if (await proofLockLive(join(dir, '.lock'), nowMs, { readFile: readOne, stat: statOne })) return false;
  const path = join(dir, 'proof.json');
  const info = await statOne(path).catch(() => null);
  if (info !== null && info.isFile() && info.size <= MAX_JSON_ARTIFACT_BYTES) {
    let parsed = null;
    try {
      parsed = normalizeProofRecord(JSON.parse(await readOne(path, 'utf8')));
    } catch {
      parsed = null;
    }
    if (parsed !== null) return Number.isSafeInteger(parsed.expiresAt) && parsed.expiresAt <= nowMs;
  }
  const own = await statOne(dir).catch(() => null);
  return own !== null && nowMs - Number(own.mtimeMs) >= RUN_ARTIFACT_RETENTION_MS;
}

/**
 * 보존 기간이 지난 **증명 디렉터리**(`<stateRoot>/proofs/<runId>/`)를 치운다. 실행과 같은 30일이다.
 *
 * ★★ 왜 여기 여섯 번째 스윕이 필요한가: 증명은 실행 기록 **밖**에 산다(끝난 실행의
 *   `runs/<runId>/` 에는 한 바이트도 안 쓴다는 불변식). 밖으로 내면서 아무도 안 치우는
 *   디렉터리를 하나 만들면 그것은 `logs` 가 이미 한 번 낸 결함의 다른 얼굴이다 — 전체 스위트
 *   여섯 번의 증거가 실행마다 영구히 쌓인다.
 * ★ 반환 모양은 `sweepPatches` 와 같은 `{removed, checked}` 다. `sweepAged` 를 못 쓰는 이유
 *   하나뿐이다: 그 함수는 나이만 보고 파일을 읽지 않는데, 이 판정의 정본은 **기록 안**에 있다.
 * ★ 던지지 않는다. 어떤 입력에도 `{removed:0, checked:0}` 이하로만 답한다.
 * ★★ 스캔 루프 자체도 안 던진다(리뷰 F3, 실측 재현: 고침 전에는 주입된 `readdir` 이
 *   `[{ name: 'run-x' }]` 하나만 내도 `entry.isDirectory is not a function` 으로 죽어 그때까지
 *   센 것까지 사라졌다 — 문서의 위 문장을 어겼다). `direntKind` 로 종류를 접고(가짜 dirent 는
 *   `other` 로 떨어진다), `sweepAged` 와 같은 try/catch 로 루프 본문을 감싼다 — 중간의 하나가
 *   (동기든 비동기든) 던지면 그때까지 센 `{removed, checked}` 는 보존하고 나머지는 다음 스윕에
 *   남긴다.
 * ★★ 부팅 예산(follow-up ③, 2026-09-01): `sweepOrphans` 의 다섯 형제(scratch·plans·logs·patches·
 *   runs)는 전부 `deadlineAt`/시계를 받아 부팅 총예산을 넘기면 스스로 멈춘다. 이 함수만 없으면
 *   그 형제 중 하나가 시간을 다 쓴 부팅에서 증명 스윕이 무한정 돈다 — 지난 실행의 만료된 증명이
 *   다음 부팅을 다시 기다리는 것으로 끝나면 그나마 다행이고, 최악은 부팅 자체가 이 스윕에
 *   묶인다. 옵션 이름이 `sweepPlans`/`sweepScratch` 와 같은 `{ deadlineAt, nowMs: <시계> }` 인
 *   이유도 같다 — 위치 인자 `nowMs`(현재 시각 값)와 이름이 겹치지만 `sweepOrphans` 의 호출부가
 *   형제들과 한 글자도 다르지 않아야 실수로 갈리지 않는다. 판정은 **기록의 `expiresAt`** 이지
 *   부팅 시계가 아니다(「자기 시계로 치우지 않는다」) — `deadlineAt` 은 언제 스캔을 멈출지만
 *   정하고, 무엇을 지울지는 여전히 `expiredProofUnit` 이 정한다. 자리는 `sweepAged` 와 같은
 *   자리: 항목 상한(`AGED_SWEEP_ENTRY_CAP`)을 보는 그 한 줄에 얹는다 — 마감을 지나면 그때까지
 *   센 것을 보존하고 멈춘다, 던지지 않는다.
 */
export async function sweepProofs(stateRoot, nowMs, options) {
  const empty = { removed: 0, checked: 0 };
  const parsed = exactFunctionOptions(
    options, new Set(['excludeRunId', 'readdir', 'readFile', 'rm', 'lstat', 'deadlineAt', 'nowMs']),
  );
  if (parsed === null || typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      Object.hasOwn(parsed, 'excludeRunId') && !validRunId(parsed.excludeRunId)) return empty;
  const expired = agedDeadline(parsed.deadlineAt, parsed.nowMs);
  if (expired === null) return empty;
  // ★ 형제(`sweepAged`)와 같은 선지급 확인 — 예산이 이미 끝났으면 readdir 한 번도 안 한다(리뷰 2026-09-01).
  if (expired()) return empty;
  const listEntries = parsed.readdir ?? readdir;
  const readOne = parsed.readFile ?? readFile;
  const statOne = parsed.lstat ?? exactLstat;
  const remove = parsed.rm ?? rm;
  const realRoot = await canonical(stateRoot);
  if (realRoot === null) return empty;
  // 그 자리가 정션이면 실체는 상태 루트 밖일 수 있다 — `sweepAged` 와 같은 두 겹이다.
  const dir = await canonical(join(realRoot, 'proofs'));
  if (dir === null || !contained(realRoot, dir)) return empty;
  let entries;
  try {
    entries = await listEntries(dir, { withFileTypes: true });
  } catch {
    return empty;
  }
  let removed = 0;
  let checked = 0;
  let scanned = 0;
  try {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (scanned >= AGED_SWEEP_ENTRY_CAP || expired()) break;
      scanned += 1;
      // `direntKind` 는 lstat 계열이고, `isDirectory` 가 없는 가짜 dirent 도 `other` 로 접는다
      // (`entry.isDirectory()` 를 직접 부르던 예전 판은 그런 항목 하나에 죽었다).
      if (direntKind(entry) !== 'directory' || !validRunId(entry.name) || entry.name === parsed.excludeRunId) continue;
      checked += 1;
      const full = await canonical(join(dir, entry.name));
      if (full === null || !contained(dir, full)) continue;
      if (!await expiredProofUnit(full, nowMs, readOne, statOne)) continue;
      if (await remove(full, { force: true, recursive: true }).then(() => true, () => false)) removed += 1;
    }
  } catch {
    // 읽은 prefix까지만 처리하고 나머지는 다음 sweep에 보존한다 (sweepAged 와 같은 규율).
  }
  return { removed, checked };
}

/**
 * `<stateRoot>/logs/<runId>.jsonl` 을 아티팩트와 **같은 30일**로 치운다 (WS2 §5). scratch·
 * patches 와 **같은 함수**를 지나므로 소유권 판정(이름 모양 + 나이 + `canonical` 담김)과
 * 반환 모양(`{removed, checked}`)이 그 둘과 한 글자도 다르지 않다.
 *
 * ★ 왜 실행별 로그가 실행 디렉터리 밖에 있고, 그래서 왜 여기 세 번째 호출자가 필요한가:
 *   그 안에 두면 `validateCompleteFinal` 의 닫힌 집합에 걸려 그 실행 **전체**가 영영 안
 *   지워진다(평문 패치까지 남고 매 실행이 retention notice 를 다시 공표한다). 밖으로
 *   옮기면서 아무도 안 치우는 디렉터리를 하나 만들면 그건 같은 결함의 다른 얼굴이라,
 *   옮기는 결정과 이 함수는 한 몸이다.
 */
export function sweepLogs({ stateRoot, now = Date.now(), retentionMs = RUN_ARTIFACT_RETENTION_MS,
  deadlineAt, clock } = {}) {
  if (typeof stateRoot !== 'string' || stateRoot === '' || !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(retentionMs) || retentionMs < 0) return Promise.resolve({ removed: 0, checked: 0 });
  return sweepAged({
    stateRoot,
    name: 'logs',
    shapes: LOG_NAMES,
    maxAgeMs: retentionMs,
    nowMs: now,
    acceptName: (name) => validRunId(name.slice(0, -'.jsonl'.length)),
    deadlineAt,
    clock,
  });
}
