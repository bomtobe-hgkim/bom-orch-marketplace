/**
 * 저장소가 딛는 파일시스템 잎 — 소유(ACL·모드) 검증 · secure path · 원자 발행 · 정확 복제.
 *
 * ★ 방향은 하나뿐이다: 여기서 `src/run-artifacts.mjs` 를 수입하지 않는다.
 *
 * ★ 실측 폐포(WS5 T12 뒤): **16개 모듈 / 6,239줄**(자기 자신 450 포함) — `reason-codes`·`reason-text`(실패 어휘는 전역 제약 5 때문에
 *   같이 온다), `run-manifest`(`boundedString` 하나 — 태스크 3 뒤 `manifest-selection`·`candidate-selection`·`verdict`·`preflight`
 *   를 끈다), `util/{errors,freeze,fs-atomic,hash,objects,paths,strings}`. 저장소 모듈도 `content-projection` 도 없다.
 *   태스크 1 의 첫 판은 그보다 4,000줄 넘게 컸고 차이는 함수 하나였다: `inspectRunArtifactCollision` 이 부르는
 *   `validateArtifactPathBudget` 가 `content-projection` → `envelope`·`patch-scope` → `git` → `providers/*` 를 달고 왔다. 그래서 그것은 저장소로 돌아갔다 — 여기로 다시 옮기면 폐포는 그 시절로 되돌아간다.
 *
 * ★ 수입하는 쪽은 셋뿐이다: `src/run-artifacts.mjs`(원시 12개), `src/reaper.mjs`(`verifyArtifactOwnerOnly` 하나),
 *   `test/candidate-artifacts.test.mjs`. 실측 폐포(src/reaper.mjs): **45개 모듈 / 17,762줄**(자기 자신 707 포함)
 *   (태스크 3 — run-manifest 가 selection 잎들을 끌고, 리퍼 자신도 `manifest-transition` 을 수입한다; follow-up ③
 *   2026-09-01, +24 — `sweepOrphans` 가 `sweepProofs` 를 부팅 스윕에 마저 부른다)이다: 저장소가 달고 오던 `content-projection` 무리는 빠진 채고, 매니페스트 이름 다섯은 여전히 `src/run-manifest.mjs` 에서 직접 간다.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod as fsChmod, link as fsLink, lstat as fsLstat, mkdir as fsMkdir, open as fsOpen,
  readFile as fsReadFile, readdir as fsReaddir, realpath as fsRealpath, rename as fsRename, unlink as fsUnlink,
} from 'node:fs/promises';
import { isAbsolute, join, resolve, win32 as pathWin32 } from 'node:path';

import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { boundedString } from './run-manifest.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { renameWithRetry, syncDirectory as fsyncDirectory } from './util/fs-atomic.mjs';
import { exactDenseArray, exactObject } from './util/objects.mjs';
import { samePath } from './util/paths.mjs';
import { isSafeCount } from './util/strings.mjs';

const DEP_KEYS = new Set([
  'canonicalPath', 'lstat', 'readFile', 'nowMs', 'pid', 'randomHex12', 'securePath', 'mkdir', 'open', 'readdir',
  'rename', 'unlink', 'syncDirectory', 'publishFileNoReplace', 'replaceFileAtomic', 'crashBarrier',
]);
const OWNER_VERIFY_DEP_KEYS = new Set([
  'canonicalPath', 'lstat', 'platform', 'resolveWindowsBinary', 'runCommand',
]);

function ownerPathIsAbsolute(path, platform) {
  return platform === 'win32' ? pathWin32.isAbsolute(path) : isAbsolute(path);
}

function ownerPathResolve(path, platform) {
  return platform === 'win32' ? pathWin32.resolve(path) : resolve(path);
}

function jsonBytes(value) {
  try {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    return null;
  }
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
    if (typeof canonical !== 'string' || !samePath(canonical, ownerPathResolve(object.path, deps.platform), deps.platform)) return false;
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
  const object = exactObject(input, ['path', 'kind']).value ?? null;
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
            (info.mode & 0o077) !== 0) return fail(REASON.artifact_permission_verification_failed, { path });
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
        return fail(REASON.artifact_permission_verification_failed, { path });
      }
      return { ok: true };
    } catch {
      return fail(REASON.artifact_permission_verification_failed, { path });
    }
  };
}

/**
 * 공유 `syncDirectory` 가 이 함수의 몸통이었다 — 열기·`sync()`·닫기와, win32 의 EPERM/EINVAL/
 * ENOTSUP/EISDIR 을 「프로세스 크래시까지」 등급으로 강등하는 목록까지 그대로다. 여기 남는 것은
 * 이 모듈의 것뿐이다: 실패를 이유 코드로 번역하고 얼려서 낸다.
 */
async function defaultSyncDirectory(path) {
  const synced = await fsyncDirectory(path);
  return synced.ok ? synced : fail(REASON.artifact_directory_sync_failed);
}

async function defaultPublishFileNoReplace(from, to) {
  try {
    await fsLink(from, to);
    return { ok: true };
  } catch {
    return fail(REASON.artifact_destination_exists_or_publish_failed);
  }
}

/**
 * ★ WS1 부터 rename 을 재시도한다(EPERM/EACCES/EBUSY 10회 × 5ms,
 *   `src/util/fs-atomic.mjs`). Windows 에서는 manifest.json 을 열어둔 리더 하나만
 *   있어도 교체가 EPERM 으로 죽고(`src/learn/posteriors.mjs` 헤더의 실측표),
 *   그 실패는 체크포인트 경로에서 **저장소 전체를 독으로 물들인다**(poisonCheckpoint).
 *   몇 ms 기다려 해결되는 일시적 오류로 그 대가를 치를 이유가 없다.
 *
 * ★ 재시도가 phantom success 를 만들지 않는다: rename 은 원자적이라 1차 시도가 실제로
 *   성공해 놓고 오류를 낸 경우 2차 시도는 원본이 사라져 ENOENT 로 끝나고(재시도 대상이
 *   아니다) 그 실패는 poison 이 된다. 반대로 진짜로 옮겨졌다면 아래 `sameIdentity` 재검증이
 *   목적지가 우리 임시 파일과 같은 개체인지 다시 확인한다.
 *
 * ★ `rename` 은 **주입 가능한 deps 항목**이다. 이 함수가 사이트에서 정말로 재시도하는지
 *   재려면 실패하는 rename 이 필요한데, 진짜 파일시스템에서 EPERM/EACCES/EBUSY 를
 *   결정적으로 만드는 방법이 플랫폼마다 다르다(Windows 는 열린 목적지, POSIX 는 디렉터리
 *   권한). 다른 fs 원시연산은 이미 전부 deps 에 있었고 rename 만 빠져 있어서, 그 구멍이
 *   이 함수를 사이트에서 검증 불가능하게 만들고 있었다.
 */
async function defaultReplaceFileAtomic(from, to, rename = fsRename) {
  const moved = await renameWithRetry(from, to, { fs: { rename } });
  return moved.ok ? { ok: true } : fail(REASON.artifact_manifest_replace_failed);
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
          (key === 'pid' ? !isSafeCount(descriptor.value) : typeof descriptor.value !== 'function')) return null;
      supplied[key] = descriptor.value;
    }
    const securePath = supplied.securePath ?? defaultSecurePath();
    const rename = supplied.rename ?? fsRename;
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
      rename,
      unlink: supplied.unlink ?? fsUnlink,
      syncDirectory: supplied.syncDirectory ?? defaultSyncDirectory,
      // 기본 교체는 주입된 rename 위에서 돈다 — 그래야 재시도 정책 자체를 사이트에서 잰다.
      // 우선순위: replaceFileAtomic 이 주입되면 그게 이긴다 — 그 안에서 rename 을 쓰든 안 쓰든,
      // 위에서 계산한 supplied.rename ?? fsRename 은 이 경우 그냥 버려진다(무시된다).
      replaceFileAtomic: supplied.replaceFileAtomic ?? ((from, to) => defaultReplaceFileAtomic(from, to, rename)),
      publishFileNoReplace: supplied.publishFileNoReplace ?? defaultPublishFileNoReplace,
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
    if (status.blocked) return fail(REASON.artifact_collision_inspection_failed, { path });
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
    // ★ own `__proto__` 는 거부한다. 아래 `out[key] = cloned` 가 `Object.prototype` 의
    //   setter 를 때리기 때문에 원시값은 **조용히 사라지고**, 객체는 사본의 프로토타입이
    //   된다 — 검사한 것과 다른 값이 다음 검증기로 간다. `JSON.parse` 가 그 키를 own data
    //   property 로 만들므로 적대적 모델 출력에서 실제로 닿는 경로다.
    //
    //   ★ 이 사본이 `src/util/objects.mjs` 의 `cloneData` 와 별도로 남아 있는 이유는
    //     **`Buffer.isBuffer` 분기 하나뿐**이다(아티팩트 이벤트는 바이트를 그대로 실어
    //     나른다). 그 한 줄 때문에 남은 사본이 통합이 고쳤다고 적어 둔 결함을 그대로
    //     갖고 있어서는 안 된다 — 규칙은 두 곳에서 같다.
    if (keys.includes('__proto__') || keys.some((key) => typeof key !== 'string')) return undefined;
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

export { canonicalRoot, captureDeps, cloneExactData, collisionForPaths, jsonBytes, lstatAbsent, readonlyDeps };
export { secureAndVerify, syncDirectory, verifyArtifactOwnerOnlyWithDeps, verifyPhysicalPath, verifyStorePath };
