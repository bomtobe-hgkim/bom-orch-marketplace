import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { RUN_LOG_MAX_BYTES, runLogPath } from './diag.mjs';
import { readRuns } from './learn/journal.mjs';
import { REASON, normalizeLegacyReasonCode } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { normalizeAttemptRecord, normalizePlanRecord } from './run-records.mjs';
import { validLane } from './manifest-vocabulary.mjs';
import { MAX_JSON_ARTIFACT_BYTES, MAX_RUN_MANIFEST_BYTES, normalizeRunManifestV1, ordinal } from './run-manifest.mjs';
import { errorText } from './util/errors.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { samePath } from './util/paths.mjs';

/**
 * 끝난 실행을 **저장소 핸들 없이** 읽는 층 — WS3 스펙 §0-D2. `{stateRoot, runId}` 만 받는다.
 *
 * ★ 왜 새 모듈인가. `createRunArtifacts` 가 낸 저장소 핸들은 모듈 지역 `WeakMap` 으로만 풀리고
 *   생성 전용이다(디렉터리가 이미 있으면 `artifact_namespace_collision`). 그래서 프로세스가 죽은
 *   뒤에는 그 핸들이 존재할 수 없고, `orch_status`(태스크 4)가 읽어야 하는 실행은 **전부** 그런
 *   실행이다. 반대로 `src/run-artifacts.mjs`(WS4a 목표 1,500)나 `src/run-manifest.mjs`(WS4a
 *   ≤900)를 키우면 두 목표와 정면으로 싸운다.
 *
 * ★ **정규화기는 새로 짓지 않는다.** 매니페스트는 `normalizeRunManifestV1`, attempt 기록은
 *   `normalizeAttemptRecord`(WS3 이 export 시켰다)를 **부른다**. 두 번째 정규화기는 첫날부터
 *   갈라지고, 갈라진 뒤에는 어느 쪽이 진짜인지 아무도 모른다.
 *
 * ★ **바이트는 절대 고쳐 쓰지 않는다**(§0-D4, 불변식 9). 0.2.2 가 남긴 옛 철자
 *   (매니페스트의 `stagnated`, attempt 의 `effect_unknown` 등)는 **표시할 때만**
 *   `normalizeLegacyReasonCode` 로 올려 읽는다. 값을 올려 **쓰면** `sameJson` 왕복과
 *   `appliedEvents[].eventSha256` 이 함께 무너지고, 리퍼는 그 실행을 `noncanonical_manifest` 로
 *   버려 영원히 회수하지 못한다. 이 모듈에는 쓰기 호출이 하나도 없다.
 *
 * ★ **절대 던지지 않는다.** 실패는 전부 `fail(REASON.x)` 봉투다. 셋뿐이다:
 *   `state_root_not_absolute`(물어본 자리가 상태 루트가 아니다) · `status_run_not_found`(그 이름의
 *   실행이 없다 — 이름 자체가 실행 이름이 아닌 경우 포함) · `status_run_unreadable`(있는데 그것이
 *   남긴 것을 못 읽었다). `readVerifierIssues` 는 여기에 WS2 계약의 두 코드를 더한다.
 *
 * ★ **읽기 하나가 저장소를 죽이지 못한다.** 이 모듈이 내는 코드 중 `poison: true` 는 없다 —
 *   못 읽은 사실은 그 실행을 끝낼 이유가 아니다(WS2 Task 12 의 I3 이 세운 규칙).
 */

/** `src/diag.mjs` 와 같은 문턱. 이 모듈은 경로를 **만들기 전에** 이름을 검사한다. */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** 로그 줄의 닫힌 level 어휘(`src/diag.mjs` 가 쓰는 것과 같은 셋). */
const LOG_LEVELS = Object.freeze(['info', 'warn', 'error']);

/**
 * 인라인되는 로그 줄의 기본 필터와 상한 — 스펙 §0-D3. 진단은 warn·error 에 있고, info 는 양이
 * 많아 축소 사다리를 곧바로 바닥까지 밀어낸다.
 */
export const LOG_TAIL_LEVELS = Object.freeze(['warn', 'error']);
export const LOG_TAIL_LIMIT = 20;

/** 인자 없는 최근 목록의 기본값과 상한 — WS0 §1.3 의 두 수(`orch_stats.runs` 와 같은 어휘). */
export const RECENT_RUNS_DEFAULT = 10;
export const RECENT_RUNS_MAX = 50;

const usableStateRoot = (stateRoot) => typeof stateRoot === 'string' && stateRoot !== '' && isAbsolute(stateRoot);
/**
 * 이 이름이 **이 서버가 지은 실행 이름의 모양**인가. 경로가 되기 전에 검사하고, 도구 층도
 * 같은 함수를 쓴다 — 두 번째 사본이 생기면 두 층의 문턱이 갈린다(최종 리뷰 M1).
 */
export const usableRunId = (runId) =>
  typeof runId === 'string' && RUN_ID_PATTERN.test(runId) && !WINDOWS_DEVICE_PATTERN.test(runId);

const runDir = (stateRoot, runId) => join(stateRoot, 'runs', runId);
const attemptPath = (stateRoot, runId, laneId, attemptOrdinal) =>
  join(runDir(stateRoot, runId), 'attempts', `${laneId}-${ordinal(attemptOrdinal)}.json`);

/** 문구의 `{runId}` 자리에 실을 값. 문자열이 아닌 것도 문장을 만들 수 있어야 한다. export: `src/tools/apply.mjs` 도 같은 표시 규칙을 써야 한다(최종 리뷰 M1). */
export const runIdText = (runId) => (typeof runId === 'string' && runId !== '' ? runId : errorText(runId));

/**
 * reasonCode 자리의 값 하나를 **표시용**으로 올려 읽는다.
 *
 * ★ 등재되지도 별칭도 아닌 값은 `null` 로 접지 않고 **읽은 그대로** 나른다. 지어내지 않는 것과
 *   지워 없애는 것은 다르다 — 모르는 코드를 `null` 로 만들면 "그 자리에 아무것도 없었다" 는
 *   거짓이 되고, 그 실행의 유일한 단서가 사라진다. 값이 문자열이 아니면 그때만 `null` 이다.
 */
const displayCode = (value) => (typeof value === 'string' ? normalizeLegacyReasonCode(value) ?? value : null);

/**
 * 파일 하나를 읽는다. 없으면 `'missing'`, 그 밖의 실패와 상한 초과는 `'unreadable'`.
 * ★ 셋을 한 값으로 뭉개지 않는 것이 이 모듈의 요점이다 — "없다" 와 "못 읽었다" 는 다른 답이다.
 */
async function readBytes(path, maxBytes) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  return bytes.length > maxBytes ? { status: 'unreadable' } : { status: 'ok', bytes };
}

/**
 * 실행 하나의 매니페스트를 디스크에서 읽어 정규화한다.
 *
 * @param {{stateRoot: string, runId: string}} target
 * @returns {Promise<{ok: true, manifest: object} | {ok: false, blocked: true, reasonCode: string,
 *   error: string, recovery: string}>} `manifest` 는 **디스크의 바이트 그대로**다(옛 철자 포함).
 *   지금 이름이 필요하면 `readRunAttempts` 가 그 자리마다 표시 값을 따로 낸다.
 */
export async function readRunManifest({ stateRoot, runId } = {}) {
  const loaded = await loadManifest(stateRoot, runId);
  return loaded.blocked ?? deepFreeze({ ok: true, manifest: loaded.manifest });
}

async function loadManifest(stateRoot, runId) {
  if (!usableStateRoot(stateRoot)) return { blocked: fail(REASON.state_root_not_absolute) };
  if (!usableRunId(runId)) return { blocked: fail(REASON.status_run_not_found, { runId: runIdText(runId) }) };
  const read = await readBytes(join(runDir(stateRoot, runId), 'manifest.json'), MAX_RUN_MANIFEST_BYTES);
  if (read.status === 'missing') {
    // ★ 매니페스트가 없어도 실행 디렉터리가 있으면 「그 이름의 실행이 없다」가 **아니다**(§0-D4:
    //   디렉터리가 「실행이 있었다」의 증거다). `createRunArtifacts` 는 디렉터리들을 먼저 만들고
    //   매니페스트를 **마지막에** 발행하므로, 그 사이에 죽은 실행은 맨 디렉터리를 남긴다 — 목록
    //   (`listRunIds`)에는 나오는데 단건 조회가 존재를 부정하면 태스크 4 의 소비자가 방금 받은
    //   목록과 모순되는 답을 본다(리뷰 Q1). 있는데 못 읽는 것이므로 `unreadable` 이 정답이다.
    const dir = await stat(runDir(stateRoot, runId)).catch(() => null);
    if (dir?.isDirectory()) return { blocked: fail(REASON.status_run_unreadable) };
    return { blocked: fail(REASON.status_run_not_found, { runId }) };
  }
  if (read.status === 'unreadable') return { blocked: fail(REASON.status_run_unreadable) };
  let parsed;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    return { blocked: fail(REASON.status_run_unreadable) };
  }
  const manifest = normalizeRunManifestV1(parsed);
  // ★ 정규화 실패는 「실행이 없다」가 **아니다**: 디렉터리가 「실행이 있었다」의 증거이고,
  //   로그 꼬리는 별도 함수라 이 실패와 무관하게 계속 읽힌다(§0-D4).
  // ★★ 그리고 그 매니페스트가 **자기 이름의 실행인지** 본다(최종 리뷰 M18). 이 검사가 없으면
  //   `runs/<A>/manifest.json` 이 `"runId": "B"` 라고 적었을 때 attempt 경로가 **매니페스트의**
  //   id 로 계산되므로(`loadAttemptRecord`) 경로 검사와 다이제스트 검사가 **틀린 실행과 자기
  //   일관되게** 통과한다 — 어긋남이 구조적으로 관측 불가능해지고, 남의 실행의 모델 산문이 이
  //   실행의 이름표를 달고 본문에 실린다(불변식 4의 교차). 같은 포맷의 다른 리더인 리퍼는 이
  //   비교를 이미 한다(`src/reaper.mjs`: `normalized.runId !== runId` → `invalid_manifest`) —
  //   두 리더가 「올바른 실행 디렉터리」를 다르게 정의하고 있던 것이다.
  if (manifest !== null && manifest.runId !== runId) return { blocked: fail(REASON.status_run_unreadable) };
  return manifest === null ? { blocked: fail(REASON.status_run_unreadable) } : { manifest };
}

/**
 * 정규화기가 요구하는 `state` 를 매니페스트 하나로 짓는다.
 *
 * `normalizeAttemptRecord` 가 읽는 것은 넷뿐이다(그 함수의 JSDoc): `runId`,
 * `initial.laneBindings`, `initial.frozenTestPlan.planFingerprint`, `manifest.evidenceRefs`.
 * `initial` 과 `manifest` 에 같은 값을 주는 것이 맞다 — 레인 바인딩도 동결 테스트 계획도 실행
 * 도중에 바뀌지 않고(매니페스트 전이 검증이 그것을 강제한다), 증거 목록은 지금 파일이 말하는
 * 것이어야 한다.
 */
const readerState = (manifest) => ({ runId: manifest.runId, initial: manifest, manifest });

/**
 * 매니페스트가 아는 attempt 마다 그 기록을 읽는다.
 *
 * 행 하나의 모양(태스크 4 가 읽는 계약):
 *   `laneId` · `ordinal` · `attemptId` · `status` — 매니페스트가 말하는 것.
 *   `result` · `writerResult` — **표시용**으로 지금 이름까지 올린 값(0.2.2 의 `stagnated` 는
 *     `lane_stagnated` 로 보인다). 기록이 없으면 `writerResult` 는 `null`.
 *   `record` — `normalizeAttemptRecord` 가 낸 기록 **그대로**. 여기 담긴 `result`·`writerResult`
 *     는 디스크가 말한 철자다. 두 자리를 함께 내는 것이 「읽기는 넓고 바이트는 불변」의 증거다.
 *   `unreadable` — 매니페스트가 기록을 가리키는데 이 층이 그것을 못 읽었다. ★ 그 한 건이 나머지
 *     목록을 지우지 않는다: 실패로 접으면 attempt 하나가 상한 것이 실행 전체를 안 보이게 만든다.
 *
 * @param {{stateRoot: string, runId: string}} target
 * @returns {Promise<{ok: true, attempts: ReadonlyArray<object>} | {ok: false, blocked: true,
 *   reasonCode: string, error: string, recovery: string}>}
 */
export async function readRunAttempts({ stateRoot, runId } = {}) {
  const loaded = await loadManifest(stateRoot, runId);
  if (loaded.blocked) return loaded.blocked;
  const { manifest } = loaded;
  const state = readerState(manifest);
  const attempts = [];
  for (const entry of manifest.attempts) {
    const record = entry.status === 'terminal'
      ? await loadAttemptRecord(stateRoot, manifest, state, entry)
      : { record: null, unreadable: false };
    attempts.push({
      laneId: entry.laneId,
      ordinal: entry.ordinal,
      attemptId: entry.attemptId,
      status: entry.status,
      result: displayCode(entry.result),
      writerResult: record.record === null ? null : displayCode(record.record.writerResult),
      record: record.record,
      unreadable: record.unreadable,
    });
  }
  return deepFreeze({ ok: true, attempts });
}

/**
 * terminal attempt 하나의 기록을 읽어 정규화한다. 실패는 이유별로 갈린다:
 *   `replay` — 파일의 바이트가 매니페스트의 ref(경로·sha256·길이)와 다르다.
 *   `record` — 바이트는 맞는데 기록이 이 실행의 매니페스트와 어긋난다.
 *
 * ★ 저장소의 `verifyImmutableRef` 대신 여기서 직접 대조하는 이유: 저쪽은 주입된 fs 의존성으로
 *   lstat identity 까지 보는 **쓰기 경로**의 검사이고, 이 층에는 그 의존성이 없다. 읽기가 확인할
 *   수 있는 것은 "매니페스트가 말한 경로의 바이트가 매니페스트가 말한 다이제스트인가" 다.
 */
async function loadAttemptRecord(stateRoot, manifest, state, entry) {
  const path = attemptPath(stateRoot, manifest.runId, entry.laneId, entry.ordinal);
  const read = await readBytes(path, MAX_JSON_ARTIFACT_BYTES);
  if (read.status !== 'ok' || entry.attemptRef === null || !samePath(entry.attemptRef.path, path) ||
      read.bytes.length !== entry.attemptRef.bytes || sha256(read.bytes) !== entry.attemptRef.sha256) {
    return { record: null, unreadable: true, why: 'replay' };
  }
  let parsed;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    return { record: null, unreadable: true, why: 'replay' };
  }
  const record = normalizeAttemptRecord(parsed, state, entry.laneId, entry.ordinal, { fromDisk: true });
  return record === null ? { record: null, unreadable: true, why: 'record' } : { record, unreadable: false };
}

/**
 * 한 후보의 **마지막** terminal attempt 가 남긴 verifier 이슈 본문.
 *
 * WS2 가 정한 두 셰이프를 그대로 지킨다 — 참인 답은 `{ok: true, issues}`(이슈가 없으면 빈 배열),
 * 못 읽었으면 `fail(REASON.x)`. 여섯 자리가 모두 `[]` 이던 옛 모양은 "이슈가 없다" 와 "읽지
 * 못했다" 를 **같은 값**으로 만들었고, 그 위에서는 되살릴 수 있는 후보와 못 읽은 후보를 구별할
 * 수 없다. 바뀐 것은 접근자뿐이다: 저장소 핸들 대신 `{stateRoot, runId, candidateId}`.
 *
 * 코드는 여섯이고 **하나도 poison 이 아니다**(읽기 한 번이 저장소의 남은 쓰기를 다 거절하게
 * 만들면 안 된다): `state_root_not_absolute` · `status_run_not_found` · `status_run_unreadable` ·
 * `artifact_attempt_input_invalid`(레인 이름이 아니거나 이 실행이 설정하지 않은 레인) ·
 * `artifact_replay_mismatch` · `artifact_attempt_record_invalid`.
 *
 * @param {{stateRoot: string, runId: string, candidateId: string}} target `candidateId` 는 `lane-a` | `lane-b`.
 * @returns {Promise<{ok: true, issues: ReadonlyArray<{id: string, claim: string, evidenceDigest: string,
 *   severity: string}>} | {ok: false, blocked: true, reasonCode: string, error: string, recovery: string}>}
 */
export async function readVerifierIssues({ stateRoot, runId, candidateId } = {}) {
  const loaded = await loadManifest(stateRoot, runId);
  if (loaded.blocked) return loaded.blocked;
  const { manifest } = loaded;
  const configured = manifest.laneBindings.some((entry) => entry.laneId === candidateId);
  if (!validLane(candidateId) || !configured) return fail(REASON.artifact_attempt_input_invalid);
  const terminal = manifest.attempts
    .filter((entry) => entry.laneId === candidateId && entry.status === 'terminal')
    .at(-1) ?? null;
  // 끝난 attempt 가 없다 = 남긴 이슈가 없다. 이것은 실패가 아니라 참인 빈 답이다.
  if (terminal === null) return deepFreeze({ ok: true, issues: [] });
  const got = await loadAttemptRecord(stateRoot, manifest, readerState(manifest), terminal);
  if (got.record === null) {
    return fail(got.why === 'replay' ? REASON.artifact_replay_mismatch : REASON.artifact_attempt_record_invalid);
  }
  return deepFreeze({ ok: true, issues: got.record.feedback.issues.map((issue) => ({ ...issue })) });
}

/**
 * 이 실행의 **플래너 정본** — `runs/<runId>/plan.json`(WS4a 스펙 §0-PL, 다섯째 artifactKind).
 *
 * 답은 셋이다. `{ok:true, plan}` = 읽었다 · `{ok:true, plan:null}` = **없다**(참인 빈 답: 계획을
 * 모델이 내지 못한 실행과 이 기능 이전의 실행 전부가 그 모양이다) · `fail(...)` = 있는데 못 읽었다.
 * 셋을 뭉개면 「이 실행에는 계획이 없었다」와 「계획을 잃었다」가 같은 화면이 된다.
 *
 * ★ **정규화기를 새로 짓지 않는다**(이 모듈의 머리말 규칙). 저장소가 쓸 때 지난 그
 *   `normalizePlanRecord` 를 여기서도 부른다 — 두 번째 정규화기는 첫날부터 갈라지고, 갈라진
 *   뒤에는 라벨(`source:'model'`)이 어느 쪽 규칙으로 붙었는지 아무도 모른다.
 * ★ 대조는 `loadAttemptRecord` 와 **같은 것**을 잰다: 매니페스트가 말한 경로의 바이트가
 *   매니페스트가 말한 길이·다이제스트인가. 이 층에는 쓰기 경로의 lstat identity 의존성이 없다.
 * ★ 코드는 새로 만들지 않았다 — 이 모듈이 이미 내는 셋과 `artifact_replay_mismatch` 뿐이고,
 *   그중 poison 은 하나도 없다(읽기 한 번이 저장소의 남은 쓰기를 다 거절하게 만들지 않는다).
 *
 * @param {{stateRoot: string, runId: string}} target
 * @returns {Promise<{ok: true, plan: {source: string, content: string, path: string, sha256: string,
 *   bytes: number}|null} | {ok: false, blocked: true, reasonCode: string, error: string, recovery: string}>}
 */
export async function readRunPlan({ stateRoot, runId } = {}) {
  const loaded = await loadManifest(stateRoot, runId);
  if (loaded.blocked) return loaded.blocked;
  const { manifest } = loaded;
  const entry = manifest.committedArtifacts.find((item) => item.artifactKind === 'plan') ?? null;
  if (entry === null) return deepFreeze({ ok: true, plan: null });
  const path = join(runDir(stateRoot, runId), 'plan.json');
  const read = await readBytes(path, MAX_JSON_ARTIFACT_BYTES);
  if (read.status !== 'ok' || !samePath(entry.ref.path, path) || read.bytes.length !== entry.ref.bytes ||
      sha256(read.bytes) !== entry.ref.sha256) return fail(REASON.artifact_replay_mismatch);
  let parsed;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    return fail(REASON.artifact_replay_mismatch);
  }
  const record = normalizePlanRecord(parsed, { runId: manifest.runId });
  if (record === null) return fail(REASON.status_run_unreadable);
  return deepFreeze({
    ok: true,
    plan: {
      source: record.source,
      content: record.content,
      path,
      sha256: entry.ref.sha256,
      bytes: entry.ref.bytes,
    },
  });
}

/** 요청된 level 목록을 닫힌 어휘로 좁힌다. 쓸 수 있는 값이 하나도 없으면 기본값(§0-D3)이다. */
function wantedLevels(levels) {
  if (!Array.isArray(levels)) return LOG_TAIL_LEVELS;
  const kept = levels.filter((level) => LOG_LEVELS.includes(level));
  return kept.length === 0 ? LOG_TAIL_LEVELS : kept;
}

/**
 * 로그 줄 하나. 다섯 키가 있어야 하고 각 자리의 타입이 맞아야 한다 — JSON 이기만 하면
 * 통과시키면 남의 파일 한 줄이 로그 줄로 둔갑한다. 모양이 아니면 `null` = 「못 읽은 줄」이다.
 * ★ **정확히** 다섯이 아니라 **적어도** 다섯이다(리뷰 Q2): `src/diag.mjs` 가 훗날 필드 하나를
 *   더하는 순간 모든 줄이 unparsable 로 접혀 꼬리가 조용히 비는 유지보수 함정을 없앤다. 남의
 *   파일 방어는 키 개수가 아니라 다섯 자리의 **타입 검사**가 한다.
 */
function logLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (!['ts', 'level', 'reasonCode', 'message', 'fields'].every((key) => keys.includes(key))) return null;
  const { ts, level, reasonCode, message, fields } = parsed;
  if (!Number.isFinite(ts) || !LOG_LEVELS.includes(level) || !(reasonCode === null || typeof reasonCode === 'string') ||
      typeof message !== 'string' || fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return { ts, level, reasonCode: displayCode(reasonCode), message, fields };
}

/**
 * 한 실행의 로그 꼬리 — 스펙 §0-D3.
 *
 * `<stateRoot>/logs/<runId>.jsonl` 을 줄 단위로 읽어 `levels` 에 드는 줄만 남기고, 그중 **마지막**
 * `limit` 줄을 파일에 있던 순서 그대로(오래된 것이 앞) 낸다.
 *
 * ★ **`omitted` 와 `unparsable` 은 서로 다른 사실이고 절대 한 수로 합치지 않는다.**
 *   `omitted` = 필터에 걸렸지만 상한을 넘어 안 실은 줄 수(0 도 정보다 — "봤는데 잃은 게 없다").
 *   `unparsable` = JSON 이 아니거나 로그 줄의 모양이 아니어서 **읽지 못한** 줄 수. `src/diag.mjs`
 *   는 append 가 반쪽만 들어가면(ENOSPC) 찢어진 꼬리를 남기고, 1 MiB 상한에 닿은 파일은 표지
 *   줄조차 없을 수 있다. 두 수를 더하면 읽는 사람은 자기가 무엇을 잃었는지 영영 모른다.
 * ★ `present` 는 로그 **파일이 있었나** 다. 로그가 없는 것은 실패가 아니다(열기 자체가
 *   best-effort 이고, 실패해도 실행은 산다 — `src/diag.mjs`). `path` 는 파일이 없어도 늘 있다:
 *   경로 계산은 순수 함수이고, 계약은 `log.path` 를 언제나 싣기로 했다.
 * ★ 이 함수는 매니페스트를 **읽지 않는다.** 정규화에 실패한 실행에서도 로그가 읽혀야 한다는 것이
 *   §0-D4 의 요구이고, 결합이 없다는 것이 그 요구를 지키는 방법이다.
 *
 * @param {{stateRoot: string, runId: string, levels?: string[], limit?: number}} target
 * @returns {Promise<{ok: true, path: string, present: boolean, lines: ReadonlyArray<{ts: number,
 *   level: string, reasonCode: string|null, message: string, fields: object}>, omitted: number,
 *   unparsable: number} | {ok: false, blocked: true, reasonCode: string, error: string, recovery: string}>}
 */
export async function readRunLogTail({ stateRoot, runId, levels, limit } = {}) {
  if (!usableStateRoot(stateRoot)) return fail(REASON.state_root_not_absolute);
  if (!usableRunId(runId)) return fail(REASON.status_run_not_found, { runId: runIdText(runId) });
  const path = runLogPath(stateRoot, runId);
  // ★ 상한 없는 읽기가 아니다(리뷰 Q3): 우리 작성기(`src/diag.mjs`)는 1 MiB 에서 멈추므로,
  //   그 두 배를 넘는 파일은 우리가 쓴 로그가 아니라 그 경로를 차지한 다른 무엇이다 — 통째로
  //   메모리에 올리지 않고 「있는데 못 읽었다」로 답한다.
  const read = await readBytes(path, RUN_LOG_MAX_BYTES * 2);
  if (read.status === 'unreadable') return fail(REASON.status_run_unreadable);
  if (read.status === 'missing') {
    return deepFreeze({ ok: true, path, present: false, lines: [], omitted: 0, unparsable: 0 });
  }
  const wanted = wantedLevels(levels);
  const take = Number.isSafeInteger(limit) && limit > 0 ? limit : LOG_TAIL_LIMIT;
  const matched = [];
  let unparsable = 0;
  for (const raw of read.bytes.toString('utf8').split('\n')) {
    if (raw.trim() === '') continue;
    const line = logLine(raw);
    if (line === null) unparsable += 1;
    else if (wanted.includes(line.level)) matched.push(line);
  }
  return deepFreeze({
    ok: true,
    path,
    present: true,
    lines: matched.slice(-take),
    omitted: Math.max(0, matched.length - take),
    unparsable,
  });
}

/** 디렉터리 이름 목록. 없으면 빈 목록, 열거 자체가 실패하면 `null`(「못 읽었다」). */
async function directoryNames(path, keep) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : null;
  }
  return entries.filter((entry) => keep(entry)).map((entry) => entry.name);
}

/** 디렉터리·파일의 mtime(ms). 못 재면 `null` — 「모른다」를 0 으로 뭉개지 않는다. */
async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 이 상태 루트가 아는 실행 목록 — 최신 우선. 스펙 §0-D5.
 *
 * ★ **디렉터리 ∪ 로그 ∪ 저널 행 이름의 합집합**이다. 실행 디렉터리 = 「실행이 있었다」,
 *   로그 = 「실행이 이름을 얻고 뭔가를 적었다」, 저널 = 「어떻게 채점·종료됐다」 — 셋은 다른
 *   질문이고 어느 하나가 다른 둘을 대신하지 못한다. 이 JSDoc 은 그 문장을 적어 놓고 정작
 *   **둘**만 썼고(최종 리뷰 I7), 그래서 저널만 아는 실행이 이 목록에서 사라졌다. 그 실행은 둘 다
 *   도달 가능하다: (a) `openLog` 가 실패한 preflight-차단 실행 — 로그 열기는 best-effort 라
 *   던지지 않고, 실행은 계속 돌아 저널 행을 남긴다; (b) 보존 스윕 뒤 — 저널 행에는 보존 정책이
 *   **없고**(`src/learn/journal.mjs`) `runs/`·`logs/` 는 둘 다 30일에 만료된다. 오래 쓴 설치에서는
 *   결국 **모든** 실행이 저널-전용이 된다. 그리고 `resume_run_not_found`·`status_run_not_found` 의
 *   공인 회복이 "인자 없이 이 목록을 부르라" 이므로, 못 보여 주면 회복이 닫힌 고리가 된다.
 * ★ 저널에서 온 이름도 `usableRunId` 를 지난다 — 그 이름은 경로가 되기도 하고 봉투의 바닥이
 *   나르는 문자열이기도 하다(`src/tools/status.mjs` 의 바닥 산술이 64를 예산한다). 남의 저널이
 *   심은 이름이 이 목록을 통해 발견 가능해지는 것이 M1 을 이 커밋과 묶은 이유다.
 * ★ 저널은 그 밖에는 **조인일 뿐**이다. 행 파싱은 `src/learn/journal.mjs` 의 일이고 이 모듈은 그
 *   리더를 부르기만 한다 — 저널 형식의 두 번째 독자가 생기면 그 둘은 갈라진다.
 * ★ 옛 행에 없는 키는 `''` 이 아니라 `null`(「모른다」)이고, 저널 행이 **아예 없는** 실행과는
 *   `journalled` 로 구별된다(불변식 9 — 0.2.2 실행이 프로젝트 없는 실행으로 보이면 안 된다).
 * ★ 저널을 **못 읽은 것**도 세 번째 값이다. 그때 모든 행이 `journalled: false` 로 나가는데, 그것만
 *   보면 "아무것도 채점되지 않았다" 는 거짓이 된다 — 그래서 결과가 `journal` 을 함께 낸다
 *   (`'ok' | 'unreadable'`, `orch_stats` 가 쓰는 어휘의 두 값). 목록 자체는 그래도 나간다: 저널이
 *   상해도 실행 이름을 되찾는 것이 이 경로의 존재 이유다. **`'skipped'` 는 더 이상 안 나온다** —
 *   저널이 이제 우주의 일부라 「참고하지 않았다」가 참인 경로가 없다(최종 리뷰 I7). 빈 상태
 *   루트도 `'ok'` 로 답한다: 읽었고 아무것도 없었다는 뜻이다.
 * ★ 순서는 `finishedAt` → 없으면 `startedAt`(저널의 `at`, 없으면 디렉터리·로그 mtime). 같으면
 *   이름 역순으로 끊는다 — 정렬이 결정적이어야 같은 상태 루트가 같은 목록을 낸다.
 *
 * @param {{stateRoot: string, limit?: number}} target `limit` 은 1..50, 기본 10(WS0 §1.3).
 * @returns {Promise<{ok: true, journal: 'ok'|'unreadable', journalError: string|null,
 *   runs: ReadonlyArray<{runId: string, hasRunDir: boolean, hasLog: boolean, journalled: boolean,
 *   startedAt: number|null, finishedAt: number|null, project: string|null, taskPreview: string|null,
 *   status: string|null, stopReason: string|null, reasonCode: string|null}>}
 *   | {ok: false, blocked: true, reasonCode: string, error: string, recovery: string}>}
 */
export async function listRunIds({ stateRoot, limit } = {}) {
  if (!usableStateRoot(stateRoot)) return fail(REASON.state_root_not_absolute);
  const dirs = await directoryNames(join(stateRoot, 'runs'), (entry) => entry.isDirectory());
  const logs = await directoryNames(join(stateRoot, 'logs'), (entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
  // 「없다」와 「못 읽었다」를 같은 빈 목록으로 내면 사용자는 자기 실행이 사라졌다고 읽는다.
  if (dirs === null || logs === null) return fail(REASON.status_run_unreadable);
  // 저널은 **우주의 일부**다 — 위 ★. 그래서 합집합을 짓기 전에 읽는다(예전에는 디렉터리·로그가
  // 둘 다 비었을 때 여기 닿기도 전에 빈 목록으로 단락됐다).
  const journal = await readRuns(stateRoot, { limit: Number.MAX_SAFE_INTEGER });
  const rows = new Map(journal.ok ? journal.runs.map((run) => [run.runId, run]) : []);
  const runIds = new Set();
  for (const name of dirs) if (usableRunId(name)) runIds.add(name);
  for (const name of logs) {
    const runId = name.slice(0, -'.jsonl'.length);
    if (usableRunId(runId)) runIds.add(runId);
  }
  for (const runId of rows.keys()) if (usableRunId(runId)) runIds.add(runId);
  const runs = [];
  for (const runId of runIds) {
    const hasRunDir = dirs.includes(runId);
    const row = rows.get(runId) ?? null;
    // ★★ 시작 시각의 정본은 종료 행의 `startedAt` 이다(최종 리뷰 I8). `at` 은 그 줄이 **쓰인**
    //   시각이고 종료 행은 `finishedAt` 을 찍은 직후에 쓰이므로, `at` 을 시작으로 읽으면 모든
    //   실행이 0 ms 또는 음수 동안 돈 것으로 보였다. 옛 행에는 `startedAt` 이 없으니 그때는
    //   `at` 이, 저널 행 자체가 없으면 디렉터리·로그의 mtime 이 답한다 — 셋 다 「아는 만큼」이다.
    const at = Number.isFinite(row?.at) ? row.at : null;
    const startedAt = (Number.isFinite(row?.startedAt) ? row.startedAt : null) ??
      at ?? await mtimeMs(hasRunDir ? runDir(stateRoot, runId) : runLogPath(stateRoot, runId));
    runs.push({
      runId,
      hasRunDir,
      hasLog: logs.includes(`${runId}.jsonl`),
      journalled: row !== null,
      startedAt,
      finishedAt: Number.isFinite(row?.finishedAt) ? row.finishedAt : null,
      project: typeof row?.project === 'string' ? row.project : null,
      taskPreview: typeof row?.taskPreview === 'string' ? row.taskPreview : null,
      status: typeof row?.status === 'string' ? row.status : null,
      stopReason: typeof row?.stopReason === 'string' ? row.stopReason : null,
      // ★ `status`·`stopReason` 은 별칭 표를 **안 태운다**: 그 두 어휘의 현행 값 여섯이 별칭 표의
      //   키와 철자가 같아서(`verified`·`unverified`·`provider_failed` …) 통과시키면 조악값이
      //   세부 코드로 조용히 바뀐다(`normalizeLegacyReasonCode` 의 JSDoc 규칙).
      reasonCode: displayCode(row?.reasonCode ?? null),
    });
  }
  const recency = (run) => run.finishedAt ?? run.startedAt ?? 0;
  runs.sort((left, right) => (recency(left) === recency(right)
    ? (left.runId < right.runId ? 1 : -1)
    : recency(right) - recency(left)));
  const take = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, RECENT_RUNS_MAX) : RECENT_RUNS_DEFAULT;
  return deepFreeze({
    ok: true,
    journal: journal.ok ? 'ok' : 'unreadable',
    journalError: journal.ok ? null : journal.error,
    runs: runs.slice(0, take),
  });
}
