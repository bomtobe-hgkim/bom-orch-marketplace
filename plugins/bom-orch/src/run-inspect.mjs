/**
 * artifact·매니페스트 **참조를 읽기만 하는** 검사 — 경로 문법·존재·소유·바이트 일치·세대 추월을 재고 아무것도 쓰지 않는다.
 * ★ 저장소 핸들을 받지 않는다: 입력은 `{stateRoot, refs, nowMs}` 와 주입된 fs 의존성뿐이라 프로세스가 죽은 뒤의 실행도 잰다.
 *   방향은 하나뿐이다 — 여기서 `src/run-artifacts.mjs` 를 수입하지 않고, 저장소도 이 파일을 수입하지 않는다. 이쪽은 저장소의 **소비자**다.
 * ★ 실측 폐포: **17개 모듈 / 6,410줄**(자기 자신 171 포함) — `reason-codes`·`reason-text`·`run-manifest`(태스크 3 뒤 `manifest-selection`·`candidate-selection`·`verdict`, WS4b 뒤 `preflight`, WS5 T12 뒤 `manifest-vocabulary` 를 끈다)·`run-store-fs`
 *   (소유 검증·`lstatAbsent`·`canonicalRoot`·`cloneExactData`)·`util/{errors,freeze,fs-atomic,hash,objects,paths,strings}`. 저장소 본체도 `content-projection` 도 없다.
 * ★ 수입하는 쪽은 둘이다: `src/tools/context.mjs`(`inspectArtifactRefs` 하나 — 실측 폐포(src/tools/context.mjs): **18개 모듈 / 6,565줄**(자기 자신 155 포함); 그 수는 태스크 1 의 21개 / 10,618줄에서 컷 셋을 지나 내려온 것이다)와 `test/candidate-artifacts.test.mjs`.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { boundedString, MAX_RUN_MANIFEST_BYTES, normalizeArtifactRef, normalizeManifestRef, normalizeRunManifestV1 } from './run-manifest.mjs';
import { canonicalRoot, cloneExactData, lstatAbsent, readonlyDeps, verifyArtifactOwnerOnlyWithDeps } from './run-store-fs.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { contained, samePath } from './util/paths.mjs';
import { exactDenseArray, exactObject } from './util/objects.mjs';
import { isSafeCount } from './util/strings.mjs';

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
  // ★★ 다섯째 kind 는 매니페스트와 **같은 세 조각**이다(`runs/<runId>/plan.json`, 그래서 runId 문법도
  //   같은 자리에서 잰다). 이 분기가 없으면 아래 넷 갈래의 `parts.length !== 4` 가 곧장 null 을
  //   돌려주고, 멀쩡히 있고 바이트까지 맞는 정본이 `{valid:false, exists:false, expired:true,
  //   matches:false}` 로 답해진다 — 「없다」도 「깨졌다」도 아닌 거짓말이다(수정 라운드 I1).
  // ★ 이 모듈이 열거하는 것은 `ref.kind` 이지 `artifactKind` 가 **아니다**. 다섯째 kind 를 더한
  //   커밋이 `artifactKind` 로 훑은 감사에서 이 자리가 안 보인 이유가 그것이다 — kind 어휘를
  //   늘리는 다음 커밋은 이 파일을 **이름이 아니라 경로 문법이 사는 자리**로 찾아야 한다.
  if (ref.kind === 'plan') {
    return parts.length === 3 && parts[0] === 'runs' && validRunIdForGrammar(parts[1]) && parts[2] === 'plan.json'
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
  const object = exactObject(input, ['stateRoot', 'refs', 'nowMs']).value ?? null;
  const deps = readonlyDeps(dependencyInput);
  const refs = exactDenseArray(object?.refs, 10_000);
  if (object === null || deps === null || refs === null || !isSafeCount(object.nowMs) ||
      !boundedString(object.stateRoot, 32_768) || !isAbsolute(object.stateRoot) ||
      await canonicalRoot(object.stateRoot, deps) === null) return fail(REASON.artifact_inspection_input_invalid);
  const inspected = [];
  for (const ref of refs) inspected.push(await inspectOneRef(object.stateRoot, ref, object.nowMs, deps));
  return deepFreeze({ ok: true, refs: inspected });
}
