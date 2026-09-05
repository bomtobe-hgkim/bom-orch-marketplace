/**
 * 증명 기록 잎 — `<stateRoot>/proofs/<runId>/` 의 경로·스키마·create-once 쓰기.
 *
 * 끝난 실행의 `runs/<runId>/` 에는 한 바이트도 쓰지 않는다(설계 §2). 증명은 그 실행이 끝난
 * **뒤에** 도는 일이라 같은 디렉터리에 쓰면 매니페스트·시도 기록의 불변식이 곧장 깨진다.
 *
 * ★ 왜 이 파일이 생겼나(실측): 실행 9(`run-mtcz280y-01xnz4`, 2026-08-28)는 증명 여섯 칸을
 *   실행 **안에서** 돌다가 다섯 번째 스위트 뒤 55분 상한에 잘렸다. 증명을 실행 밖으로 빼면
 *   그 결과는 실행이 끝난 뒤에도 읽히는 자기 자리를 가져야 하고, 이 파일이 그 자리다.
 *
 * ★ 왜 잎인가: 저장소(`src/run-artifacts.mjs`)도 엔진도 수입하지 않는다. `src/proof-stage.mjs`
 *   (쓰는 쪽)와 `src/tools/apply.mjs`(읽는 쪽)가 **둘 다** 이 파일을 읽으므로, 어느 한쪽을
 *   수입하는 순간 방향이 되돌아온다.
 *
 * ★ 사유 코드는 **읽기 실패 둘**만 낸다(`proof_record_unreadable`·`proof_in_progress`). 쓰기
 *   실패는 `{ok:false, stage, reason}` 으로 그대로 올린다 — 어느 사유 코드로 부를지는 봉투를
 *   짓는 쪽이 정하고, 잎이 그것을 정하면 어휘가 두 곳에서 자란다.
 *
 * ★ 실측 폐포: **10개 모듈 / 3,323줄**(자기 자신 410 포함) — `manifest-vocabulary`(20)·
 *   `reason-codes`(737)·`reason-text`(1,360)·`util/errors`(120)·`util/freeze`(43)·`util/fs-atomic`(206)·
 *   `util/hash`(30)·`util/objects`(216)·`util/strings`(181) — 항목의 합이 총합이다. 저장소도 엔진도 0개다.
 *   (앞의 아홉 값도 태스크 1·2 가 남긴 값이지 브리프가 예측한 HEAD 값이 아니다 —
 *    `manifest-vocabulary` 는 태스크 1 이 15 → 20 으로 올린 뒤의 값이다, 예측은 19 였다. 자기 자신은
 *    태스크 9 리뷰 고침이 385 → 410(+25)으로 올렸다 — `proofLockLive` 하나와 그 판정 셋의 WHY다,
 *    `staleProofLock` 은 그 반대를 부르는 두 줄로 줄었다.)
 */
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { PROOF_STATUSES, validLane } from './manifest-vocabulary.mjs';
import { REASON } from './reason-codes.mjs';
import { writeFileAtomic } from './util/fs-atomic.mjs';
import { sha256 } from './util/hash.mjs';
import { exactObject, hasExactKeys } from './util/objects.mjs';

/** `proof.json` 한 장의 정확한 키 집합. 순서가 곧 직렬화 순서다. */
export const PROOF_RECORD_KEYS = Object.freeze([
  'schemaVersion', 'runId', 'candidateId', 'attemptId', 'ordinal', 'treeHash', 'patchSha256',
  'planFingerprint', 'environmentFingerprint', 'testDeltaSha256', 'status', 'repairable', 'reasonCodes',
  'evidenceIds', 'witnessIds', 'startedAt', 'finishedAt', 'expiresAt', 'cost',
]);

const PROOF_SCHEMA_VERSION = 1;
const MAX_PROOF_ORDINAL = 999;
// ★ 2 MiB 다. 증인 목록이 이 파일에서 유일하게 큰 값이고(상한 20,000 × 최대 256자), 256 KiB 로는
//   실행 9 규모(3,240 증인)의 절반쯤에서 기록이 「너무 크다」로 거부된다 — 여섯 칸을 다 돈 증명이
//   바이트 상한 때문에 못 읽히는 것은 증명을 안 돌린 것과 구별되지 않는다.
const MAX_PROOF_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ID_CHARS = 256;
// ★ 증거 층(`validClassified`, src/regression-proof.mjs)이 같은 종류의 목록에 쓰는 값과 같다.
//   생산자와 소비자가 다른 상한을 쓰면 생산자가 만들 수 있는 기록을 소비자가 거부한다.
const MAX_WITNESS_IDS = 20_000;
// ★ 잠금 만료 = `MAX_WAIT_MS`(3,300,000) + 10분 여유. `src/deadline.mjs` 에서 수입하지 않는 이유는
//   순서다 — 태스크 4 가 그 상수를 deadline 으로 옮기고, 이 파일은 태스크 3 이 먼저 만든다. 값이
//   갈리지 않게 이 주석이 출처를 못박는다: 어떤 증명도 상한보다 오래 돌지 못하므로, 그보다 10분
//   더 지난 잠금은 쥔 프로세스가 죽은 것이다.
const PROOF_LOCK_STALE_MS = 3_300_000 + 600_000;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTEMPT_FILE_PATTERN = /^proof-(\d{3})\.json$/;
const EVIDENCE_KINDS = Object.freeze(['b0', 'br', 'c']);

// 던지는 문장 셋. 봉투로 나가지 않는 **개발자 오류**라 정본(`src/reason-text.mjs`)을 안 거친다 —
// `src/util/fs-atomic.mjs` 의 `tempPath` 필수 문장과 같은 등급이다.
const IDENTITY_REQUIRED = 'a proof path needs an absolute state root and a valid run id';
const ORDINAL_REQUIRED = 'a proof path needs an ordinal from 1 to 999';
const CELL_REQUIRED = 'a proof evidence path needs kind b0, br or c and repetition 1 or 2';

function requireIdentity(stateRoot, runId) {
  if (typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot) ||
      typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new TypeError(IDENTITY_REQUIRED);
}

/** 서수는 **언제나 세 자리**다 — `proof-9.json` 과 `proof-009.json` 이 섞이면 최대값이 갈린다. */
function ordinalText(ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_PROOF_ORDINAL) throw new TypeError(ORDINAL_REQUIRED);
  return String(ordinal).padStart(3, '0');
}

export function proofDir(stateRoot, runId) {
  requireIdentity(stateRoot, runId);
  return join(stateRoot, 'proofs', runId);
}

export function proofRecordPath(stateRoot, runId) {
  return join(proofDir(stateRoot, runId), 'proof.json');
}

export function proofAttemptPath(stateRoot, runId, ordinal) {
  return join(proofDir(stateRoot, runId), `proof-${ordinalText(ordinal)}.json`);
}

export function proofEvidencePath(stateRoot, runId, ordinal, kind, repetition) {
  if (!EVIDENCE_KINDS.includes(kind) || ![1, 2].includes(repetition)) throw new TypeError(CELL_REQUIRED);
  return join(proofDir(stateRoot, runId), 'evidence', `${ordinalText(ordinal)}-${kind}-${repetition}.json`);
}

export function proofLockPath(stateRoot, runId) {
  return join(proofDir(stateRoot, runId), '.lock');
}

/**
 * 증명 시도의 attemptId. 레인 시도(`<runId>/lane-a/001`)와 **같은 문법의 셋째 값**이라
 * `src/regression-proof.mjs` 의 서수 파서가 손대지 않고 읽고, 증거 id 도 그대로 파생된다.
 */
export function proofAttemptId(runId, ordinal) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new TypeError(IDENTITY_REQUIRED);
  return `${runId}/prove/${ordinalText(ordinal)}`;
}

/**
 * 문자열 id 목록. 상한이 둘인 이유: `reasonCodes`·`evidenceIds` 는 손으로 셀 수 있는 크기(≤6)
 * 지만 `witnessIds` 는 **생산자가 정한다** — `completeRegressionProof` 가 싣는 BR 증인 목록이고,
 * 증거 층은 같은 종류를 20,000 에서 자른다(`validClassified`). 실행 9 의 c-1 이 3,240 증인이었다:
 * 64 로 자르면 여섯 칸을 다 돈 증명이 `proof_record_unreadable` 로 나간다.
 */
function boundedIdList(value, max = 64) {
  return Array.isArray(value) && value.length <= max &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_ID_CHARS);
}

function normalizeCost(value) {
  const cost = exactObject(value, ['testRuns']).value ?? null;
  const runs = exactObject(cost?.testRuns, ['count', 'totalMs']).value ?? null;
  if (runs === null || !Number.isSafeInteger(runs.count) || runs.count < 0 ||
      !Number.isSafeInteger(runs.totalMs) || runs.totalMs < 0) return null;
  return { testRuns: { count: runs.count, totalMs: runs.totalMs } };
}

/**
 * 정확한 키 집합·값 검사 → 복제 | null. 던지지 않는다 — 디스크에서 온 JSON 도 이 문을 지난다.
 *
 * ★ `attemptId` 는 `runId`·`ordinal` 에서 **다시 계산해** 대조한다. 세 값이 따로 저장되면
 *   기록 하나가 자기 자신과 어긋난 채로 살 수 있고, 그 기록을 읽는 적용 게이트는 어느 쪽을
 *   믿을지 정할 수 없다.
 *
 * ★ `candidateId`·`treeHash`·`patchSha256`·`testDeltaSha256` **넷은 null 을 받는다**. 증명이
 *   필요 없던 실행의 `not_applicable` 기록은 후보를 하나도 재구성하기 전에 쓰이므로 그 넷이
 *   전부 없다(설계 §1.3 게이트 2). `attemptId` 는 null 이 아니다 — 서수와의 대조가 기록의
 *   자기 정합성이고, 그것까지 비면 이 문이 아무것도 안 재게 된다.
 */
export function normalizeProofRecord(value) {
  const object = exactObject(value, PROOF_RECORD_KEYS).value ?? null;
  if (object === null || object.schemaVersion !== PROOF_SCHEMA_VERSION ||
      typeof object.runId !== 'string' || !RUN_ID_PATTERN.test(object.runId) ||
      !(object.candidateId === null || validLane(object.candidateId)) ||
      !Number.isSafeInteger(object.ordinal) || object.ordinal < 1 || object.ordinal > MAX_PROOF_ORDINAL ||
      object.attemptId !== `${object.runId}/prove/${String(object.ordinal).padStart(3, '0')}` ||
      !(object.treeHash === null || OBJECT_ID_PATTERN.test(object.treeHash)) ||
      !(object.patchSha256 === null || SHA256_PATTERN.test(object.patchSha256)) ||
      !SHA256_PATTERN.test(object.planFingerprint ?? '') || !SHA256_PATTERN.test(object.environmentFingerprint ?? '') ||
      !(object.testDeltaSha256 === null || SHA256_PATTERN.test(object.testDeltaSha256)) ||
      !PROOF_STATUSES.includes(object.status) || typeof object.repairable !== 'boolean' ||
      !boundedIdList(object.reasonCodes) || !boundedIdList(object.evidenceIds) ||
      !boundedIdList(object.witnessIds, MAX_WITNESS_IDS) ||
      !Number.isSafeInteger(object.startedAt) || object.startedAt <= 0 ||
      !Number.isSafeInteger(object.finishedAt) || object.finishedAt < object.startedAt ||
      !Number.isSafeInteger(object.expiresAt) || object.expiresAt <= 0) return null;
  const cost = normalizeCost(object.cost);
  if (cost === null) return null;
  return {
    schemaVersion: PROOF_SCHEMA_VERSION,
    runId: object.runId,
    candidateId: object.candidateId,
    attemptId: object.attemptId,
    ordinal: object.ordinal,
    treeHash: object.treeHash,
    patchSha256: object.patchSha256,
    planFingerprint: object.planFingerprint,
    environmentFingerprint: object.environmentFingerprint,
    testDeltaSha256: object.testDeltaSha256,
    status: object.status,
    repairable: object.repairable,
    reasonCodes: [...object.reasonCodes],
    evidenceIds: [...object.evidenceIds],
    witnessIds: [...object.witnessIds],
    startedAt: object.startedAt,
    finishedAt: object.finishedAt,
    expiresAt: object.expiresAt,
    cost,
  };
}

/** 정확히 이 키들인가만 묻는 술어. 게이트가 정규화 전에 모양을 진단할 때 쓴다. */
export function hasProofRecordKeys(value) {
  return hasExactKeys(value, PROOF_RECORD_KEYS);
}

function jsonBytes(value, limit) {
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return bytes.length > limit ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * `proof.json` 을 읽는다. 파일이 없는 것은 **실패가 아니다** — 증명을 아직 안 돌린 실행이
 * 그 상태이고, 적용 게이트는 그 둘(없다 / 못 읽는다)을 갈라 다르게 답해야 한다.
 */
export async function readProofRecord({ stateRoot, runId } = {}) {
  let path;
  try {
    path = proofRecordPath(stateRoot, runId);
  } catch {
    return { ok: false, reasonCode: REASON.proof_record_unreadable };
  }
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, record: null };
    return { ok: false, reasonCode: REASON.proof_record_unreadable };
  }
  let parsed = null;
  try {
    if (bytes.length <= MAX_PROOF_JSON_BYTES) parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reasonCode: REASON.proof_record_unreadable };
  }
  const record = normalizeProofRecord(parsed);
  return record === null || record.runId !== runId
    ? { ok: false, reasonCode: REASON.proof_record_unreadable }
    : { ok: true, record };
}

/**
 * 다음 증명 서수. 디렉터리를 못 읽으면 **null** 이다 — 서수를 지어내면 create-once 쓰기가
 * 남의 기록 위에서 EEXIST 를 내거나(운이 좋으면) 그 기록을 못 남긴다(운이 나쁘면).
 */
export async function nextProofOrdinal({ stateRoot, runId } = {}) {
  let dir;
  try {
    dir = proofDir(stateRoot, runId);
  } catch {
    return null;
  }
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    return error?.code === 'ENOENT' ? 1 : null;
  }
  let highest = 0;
  for (const name of names) {
    const found = ATTEMPT_FILE_PATTERN.exec(name);
    if (found !== null) highest = Math.max(highest, Number.parseInt(found[1], 10));
  }
  return highest >= MAX_PROOF_ORDINAL ? null : highest + 1;
}

async function ensureProofDirectories(stateRoot, runId) {
  try {
    await mkdir(join(proofDir(stateRoot, runId), 'evidence'), { recursive: true, mode: 0o700 });
    return { ok: true };
  } catch (error) {
    return { ok: false, stage: 'directory', reason: `${error?.code ?? 'unknown'}` };
  }
}

async function createOnce(path, bytes, stage) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    return { ok: true };
  } catch (error) {
    return { ok: false, stage, reason: `${error?.code ?? 'unknown'}`, exists: error?.code === 'EEXIST' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * `proof-NNN.json` 은 **create-once**(`wx`), `proof.json` 은 원자 교체다.
 *
 * ★ 두 쓰기의 등급이 다른 이유: 시도 파일은 그 시도의 증언이라 두 번 쓰이면 안 되고(서수가
 *   그 자리를 산다), `proof.json` 은 「가장 최근 증명」을 가리키는 **사본**이라 재증명마다
 *   제자리에서 바뀌어야 한다. 사본을 create-once 로 두면 두 번째 증명이 영영 못 실린다.
 */
export async function writeProofRecord({ stateRoot, runId, record } = {}) {
  const normalized = normalizeProofRecord(record);
  if (normalized === null || normalized.runId !== runId) return { ok: false, stage: 'record', reason: 'invalid' };
  const bytes = jsonBytes(normalized, MAX_PROOF_JSON_BYTES);
  if (bytes === null) return { ok: false, stage: 'record', reason: 'unserializable' };
  const directories = await ensureProofDirectories(stateRoot, runId);
  if (!directories.ok) return directories;
  const attemptPath = proofAttemptPath(stateRoot, runId, normalized.ordinal);
  const written = await createOnce(attemptPath, bytes, 'attempt');
  if (!written.ok) return written;
  const digest = sha256(bytes);
  const recordPath = proofRecordPath(stateRoot, runId);
  const published = await writeFileAtomic(recordPath, bytes, {
    tempPath: `${recordPath}.tmp-${ordinalText(normalized.ordinal)}-${digest.slice(0, 12)}`,
    fsync: true,
    syncDir: true,
  });
  return published.ok
    ? { ok: true, path: recordPath, attemptPath, sha256: digest, bytes: bytes.length }
    : { ok: false, stage: 'publish', reason: published.reason ?? published.stage };
}

/**
 * 증거 한 칸을 `evidence/NNN-<kind>-<rep>.json` 에 create-once 로 쓰고 참조를 낸다.
 *
 * ★ 14 키 검사는 여기 없다 — 증거 스키마의 정본은 `src/regression-proof.mjs` 이고, 사본을
 *   여기 두면 그 스키마가 두 곳에서 자란다. 이 파일이 지키는 것은 「같은 칸은 한 번만」이다.
 * ★ `expiresAt` 은 실행 디렉터리의 것을 호출부가 읽어 넘긴다(스켈레톤의 인자에 이것 하나를
 *   더했다) — 참조가 그 값을 실어야 하는데 이 잎은 실행 기록을 못 읽는다.
 */
export async function writeProofEvidence({ stateRoot, runId, ordinal, kind, repetition, record, expiresAt } = {}) {
  if (record === null || typeof record !== 'object' || typeof record.evidenceId !== 'string' ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return { ok: false, stage: 'record', reason: 'invalid' };
  const bytes = jsonBytes(record, MAX_PROOF_JSON_BYTES);
  if (bytes === null) return { ok: false, stage: 'record', reason: 'unserializable' };
  const directories = await ensureProofDirectories(stateRoot, runId);
  if (!directories.ok) return directories;
  const path = proofEvidencePath(stateRoot, runId, ordinal, kind, repetition);
  const written = await createOnce(path, bytes, 'evidence');
  if (!written.ok) return written;
  return { ok: true, ref: { kind: 'evidence', path, sha256: sha256(bytes), bytes: bytes.length, expiresAt } };
}

/**
 * 같은 실행의 증명은 한 번에 하나다 — `.lock` 은 실행의 init-lock 과 같은 방식의 create-once
 * 파일이다(`src/run-artifacts.mjs` 의 `initLockPath`: `wx` 로 만들고 끝나면 지운다).
 *
 * ★ 만료 시각을 **적는다**, init-lock 과 같은 이유로. 실행의 init-lock 은 `expiresAt` 을 함께
 *   적어 `sweepRuns` 가 죽은 프로세스의 잠금을 회수하는데(`src/run-retention.mjs` 의
 *   `exactInitLock`·`expiredStatMtime`), 증명 잠금도 이제 같다: `sweepProofs` 는 `proofs/<runId>/`
 *   를 지우기 **전에** 그 안의 `.lock` 이 살아 있는지부터 본다(아래 `proofLockLive` 가 정본이고
 *   `staleProofLock` 도 그 위에 선다) — 살아 있으면 기록의 `expiresAt` 이 뭐라 하든 그 디렉터리를
 *   건너뛴다. 그래도 `.lock` 만 따로 지우지는 않는다: 살아 있지 않으면 `proofs/<runId>/` 통째가
 *   그 안의 `.lock` 까지 얹은 채 지워진다. 만료를 안 적으면 두 자리가 함께 막힌다 — 여기(재취득)
 *   뿐 아니라 거기(스윕)도 Ctrl-C 된 `orch_prove` 하나를 못 알아본다.
 * ★ 창은 30일이 아니라 `PROOF_LOCK_STALE_MS`(= `MAX_WAIT_MS` + 10분)다 — 어떤 증명도 상한보다
 *   오래 돌지 못하므로 그보다 지난 잠금은 쥔 쪽이 죽은 것이고, 그보다 짧으면 도는 증명을 뺏는다.
 * ★ 회수는 **한 번**이다. 만료됐거나 판독 불가한(그리고 mtime 이 창보다 오래된) 잠금을 지우고
 *   `wx` 를 딱 한 번 더 시도한다 — 반복하면 두 프로세스가 서로의 잠금을 번갈아 지운다.
 */
export async function acquireProofLock({ stateRoot, runId, pid, nowMs } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { ok: false, stage: 'lock', reason: 'invalid' };
  }
  const directories = await ensureProofDirectories(stateRoot, runId);
  if (!directories.ok) return directories;
  const path = proofLockPath(stateRoot, runId);
  const body = jsonBytes(
    { schemaVersion: PROOF_SCHEMA_VERSION, kind: 'proof-lock', runId, pid, nowMs, expiresAt: nowMs + PROOF_LOCK_STALE_MS },
    MAX_PROOF_JSON_BYTES,
  );
  if (body === null) return { ok: false, stage: 'lock', reason: 'unserializable' };
  const written = await createOnce(path, body, 'lock');
  if (written.ok) return { ok: true, release: async () => { await rm(path, { force: true }).catch(() => {}); } };
  if (written.exists !== true) return written;
  if (!(await staleProofLock(path, nowMs))) return { ok: false, reasonCode: REASON.proof_in_progress };
  try {
    await rm(path, { force: true });
  } catch {
    return { ok: false, reasonCode: REASON.proof_in_progress };
  }
  const retried = await createOnce(path, body, 'lock');
  if (!retried.ok) return retried.exists === true ? { ok: false, reasonCode: REASON.proof_in_progress } : retried;
  return { ok: true, release: async () => { await rm(path, { force: true }).catch(() => {}); } };
}

/**
 * 그 `.lock` 이 살아 있는가 — `acquireProofLock`(잠그는 쪽)과 `sweepProofs`(치우는 쪽,
 * `src/run-retention.mjs` 의 `expiredProofUnit`)가 **같은 정본**을 쓴다. 둘이 각자의 판정을
 * 가지면 하나가 산 잠금을 지우거나 죽은 잠금 앞에서 영영 멈추는 결함이 생긴다.
 *
 * 판정 셋, 순서가 뜻을 갖는다: ★ 읽히는 JSON 은 그 `expiresAt` 이 답이다. ★ 읽었는데 파싱이
 * 안 되거나(모양이 깨졌다) 다른 이유로 못 읽으면(권한 등) 파일의 mtime 이 답이다 — 창
 * (`PROOF_LOCK_STALE_MS`) 보다 새로우면 살아 있다. ★ 파일 자체가 없으면(`ENOENT`) 살아 있지
 * 않다 — 잠그는 쪽이 없으니 막을 것도 없다.
 *
 * ★ `readFile`·`stat` 을 주입받는다(기본값은 이 파일이 이미 수입한 것들이다). `sweepProofs` 는
 *   자기 `readFile`·`lstat` 옵션을 그대로 넘겨 진짜 디스크 없이도 이 판정을 재현한다.
 */
export async function proofLockLive(path, nowMs, { readFile: readOne = readFile, stat: statOne = stat } = {}) {
  let raw;
  try {
    raw = await readOne(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    raw = undefined;
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw);
      if (Number.isSafeInteger(parsed?.expiresAt)) return parsed.expiresAt > nowMs;
    } catch {
      // 아래 mtime 판정으로 떨어진다.
    }
  }
  try {
    const info = await statOne(path);
    return Number(info.mtimeMs) + PROOF_LOCK_STALE_MS > nowMs;
  } catch {
    return false;
  }
}

/** 남은 잠금이 죽은 것인가 — `proofLockLive` 의 반대. `acquireProofLock` 은 이것만 부른다. */
async function staleProofLock(path, nowMs) {
  return !(await proofLockLive(path, nowMs));
}
