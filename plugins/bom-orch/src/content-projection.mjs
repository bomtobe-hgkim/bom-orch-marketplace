import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { EXCERPT_SCHEMA, MAX_CONTENT_CHARS, isExcerpt } from './envelope.mjs';
import { SCOPE_RULES } from './patch-scope.mjs';
// ★ 크레딧 전 판정의 **어휘 넷**을 정본에서 받는다. `src/preflight.mjs` 는 상대 import 가 0 인
//   잎이라 이 파일의 폐포가 그 256줄만큼만 늘고(가드가 잰다), 어휘를 여기 베껴 적으면 벤더가
//   값을 하나 더 얻는 날 두 목록 중 한쪽만 고쳐진다.
import { AUTH_NOT_LOGGED_IN, AUTH_UNKNOWN, EVIDENCE_POSSIBLE, EVIDENCE_UNREACHABLE } from './preflight.mjs';
import { REASON, REASON_CODES, STOP_REASONS, isReasonCode, normalizeLegacyReasonCode } from './reason-codes.mjs';
import { NOTICE_TEXT, fail, renderNotice } from './reason-text.mjs';
import { LANES, PROOF_STATUSES as PROOF_STATUS_VALUES, validLane } from './manifest-vocabulary.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { exactDenseArray, exactObject, ownDataValue } from './util/objects.mjs';
import { boundedText as cleanText, clipPlain, clipWhole, compareUtf8, safeInteger } from './util/strings.mjs';
/** ★ 실측 폐포: **31개 모듈 / 13,323줄**(자기 자신 1,807 포함). */
/**
 * 바닥 한 장의 크기는 **두 반쪽**이고 이 상수가 그 둘을 가르는 선이다. 둘의 합이
 * `MAX_CONTENT_CHARS` 를 넘지 않아야 「관문을 지난 실행의 봉투는 본문을 싣는다」가 참이 된다.
 *
 *  (i) **경로 반쪽** — 아티팩트 경로가 바닥에 실리는 모든 자리. 길이를 정하는 것은 사용자가
 *      고르는 `BOM_ORCH_HOME` 이라 실행 시작의 `validateArtifactPathBudget` 이 이 예산에 대고
 *      재고, 넘으면 크레딧을 쓰기 전에 `artifact_path_budget_exceeded` 로 막는다.
 *  (ii) **경로 아닌 정적 reserve** — 이슈 ID 이외의 행(`baseline`·`cost`·`scope`·계수기…).
 *      길이는 각 투영의 상한이 정하고 **경로 길이에 안 딸린다**(실측: 루트 1자에서 관문
 *      최대치까지 두 정적 부분의 차가 글자 하나까지 같다).
 *
 * ★★ 그래서 정적 유계성은 `ARTIFACT_PATH_JSON_BUDGET + (ii) <= MAX_CONTENT_CHARS` 이고, 이슈 ID는 완성한 JSON을 재어 그 남은 자리를 쓴다.
 *   5,000 은 계획서(2026-08-12 §11)가 10,000 을 반씩 나눈 값이고 **바뀌지 않았다** — 이 수를
 *   내리는 것은 오늘 도는 실행을 막는 일이고(실측: 3,500 이면 관문이 허용하는 마지막 상태
 *   루트가 698자에서 448자로 준다), 넘친 쪽은 정적 (ii)이기 때문이다.
 * ⚠ 이 덧셈이 **깨져 있었다**(WS5 태스크 6 리뷰 I1). (ii)의 최악값은 태스크 6 전에 2,952 였는데
 *   `baseline` 행이 최악값 2,765자(10 × 256)를 얹어 5,717 로 만들었다 — 합 **10,717 > 10,000**.
 *   결과는 조용했다: 관문을 **지난** 실행 하나가 본문 대신 `{"truncatedReport":true}` 만 싣는다
 *   (리뷰 실측 창: 상태 루트 세그먼트 610–666자, runId 30자·레인 둘).
 * ★★ 고친 쪽은 (ii)다 — `BASELINE_DIRTY_FILE_TOTAL_CHARS` 가 그 행의 최악값을 **2,765 → 952** 로
 *   줄인다. 실사용에서 잃는 것이 없는 쪽이라서다: 평범한 더러운 저장소(경로 40자 안팎 열 건)는
 *   목록이 그대로 실리고, 줄어드는 것은 **256자짜리 경로 열 건**이라는 합성 최악뿐이다.
 * ★ 새 산술(실측, `test/content-projection.test.mjs` 의 「두 정적 부분을 함께 태운다」 시험 둘이
 *   기계로 잰다): 5,000 + 정적 이슈-제외 reserve 3,904 = **8,904 <= 10,000**, 이슈 ID의
 *   측정 가능한 나머지는 1,096이다. reserve는 최악의 `cost`(벤더 8 × id 128) · 최악의 `baseline`
 *   · 가장 긴 어휘 둘 · 안전정수 계수기 · 상한 길이의 `plan.provider` 를 동시에 태운 값이다.
 * ★ 이슈 id 는 `issues` 와 `candidates` 두 배열에 같은 모양으로 실린다. 바닥을 만들 때만
 *   완성된 JSON 길이를 재고 정렬된 id 꼬리부터 함께 버린다. `openIssueCount` 는 논리 총수를
 *   그대로 말하고 `omittedCounts.issues` 는 복제 수가 아니라 잃은 논리 id 수를 한 번만 센다.
 */
export const ARTIFACT_PATH_JSON_BUDGET = 5_000;

/** 예산을 재는 최악의 경우(`budgetProjection`). 목록에서 뽑으므로 이름이 늘어도 따라온다. */
const longest = (values) => [...values].reduce((widest, value) => value.length > widest.length ? value : widest, '');
const LONGEST_STOP_REASON = longest(STOP_REASONS);
const LONGEST_REASON_CODE = longest(REASON_CODES.map(({ code }) => code));

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const SELECTED_OUTCOMES = new Set(['winner', 'single_survivor', 'equivalent']);
const ALL_OUTCOMES = new Set([...SELECTED_OUTCOMES, 'tie', 'none']);
const PROOF_STATUSES = new Set(PROOF_STATUS_VALUES);
/**
 * 봉투가 싣는 스코프 사유의 상한(스펙 §4: ≤10). 생산자의 `MAX_REASONS`(100)와 **다른 수**이고
 * 그것이 맞다: 생산자는 장부를 쓰고, 봉투는 사람이 읽을 만큼만 나른다. 자를 때 개수를
 * 버리지 않기 위해 `scope.reasonCount` 가 항상 **받은 전체 개수**를 말한다.
 */
const SCOPE_REASON_LIMIT = 10;

/**
 * 사유 한 건의 `path`·`detail` 상한(스펙 §4 의 200).
 *
 * ★ `path` 를 32,768 로 둔 채 검증만 하던 예전 규칙을 **200 클립**으로 바꿨다. 저장소 경로가
 *   200자를 넘는 일은 정당하게 있지만(중첩 워크트리 + 긴 패키지명), 그때 선택지는 둘뿐이다:
 *   사유 한 건을 **통째로 버리는 것**과 **잘라서 싣는 것**. 잘라서 싣으면 어느 문제인지는 여전히
 *   읽힌다(앞 200자에 디렉터리와 규칙이 다 들어있다). 또 `detail` 과 같은 규칙을 쓰면 표시 폭이
 *   한 가지라 읽는 쪽이 행 하나의 최대 바이트를 안다 — 봉투 예산을 가늠할 수 있게 하는 것은 그쪽이다.
 */
const SCOPE_REASON_CHARS = 200;

/** 사유의 `rule` 은 생산자의 열거다 — 목록을 베끼지 않고 `src/patch-scope.mjs` 에서 받는다. */
const SCOPE_RULE_SET = new Set(SCOPE_RULES);

/**
 * `baseline.dirtyFiles` 의 상한 — **다섯 단에 똑같이** 걸리는 한 쌍이다(`projectBaseline` 머리말).
 *
 * ★★ 왜 `SCOPE_REASON_LIMIT` 과 같은 10 이고 `fileLimit`(단마다 다른 값)이 아닌가. 이 행은
 *   계약이 **바닥까지 `keep`** 이라고 적은 행이라, 상한이 단에 딸리면 마지막 단이 사용자
 *   저장소의 길이에 묶인다 — 그 순간 바닥은 유계가 아니고, 봉투는 본문 대신 잘린 상수를 싣는다.
 * ★ 자릿수가 `SCOPE_REASON_CHARS`(200)가 아니라 256 인 이유: 이 값은 **자르지 않고 버린다.**
 *   자른 경로는 경로가 아니라서(문서가 "어느 단도 절대경로를 자르지 않는다"고 약속한다) 버리는
 *   쪽이 맞고, 버리는 규칙에서 200 은 평범한 저장소의 정당한 경로를 지운다.
 *
 * ★★ **셋째 상한이 진짜 유계를 낸다**(WS5 태스크 6 리뷰 I1). 앞의 두 수는 곱이라 최악값이
 *   10 × 256 = 2,560자이고, 「실측 바닥에 그만큼을 더해도 상한 안」이라던 원래 산술은
 *   **경로 반쪽을 빠뜨린 것**이었다 — 관문이 허용하는 긴 상태 루트에서 바닥이 10,000 을 넘어
 *   봉투가 본문 대신 상수 하나를 실었다(`ARTIFACT_PATH_JSON_BUDGET` 머리말의 덧셈).
 *   총량 상한은 그 최악값을 **952자**(실측)로 못 박으면서 평범한 저장소에서는 아무것도 바꾸지
 *   않는다: 경로 40자 안팎 열 건은 400자라 열 건이 그대로 실린다. 곱을 줄이는 쪽(예: 열 건 →
 *   넷)은 **모든** 더러운 저장소에서 이름 여섯을 지우지만, 총량은 긴 경로가 실제로 올 때만
 *   줄인다 — 잃는 것이 있는 날에만 잃는다.
 * ★ 예산을 넘긴 항목에서 **멈추지 않고 건너뛴다**(`continue`). 긴 경로 하나가 뒤따르는 짧은
 *   경로 아홉의 자리를 통째로 먹지 않게 하는 것이고, 버린 수는 어느 쪽이든 `omittedCounts.files`
 *   가 센다 — 총량이 남았는데 목록이 비는 일이 없다.
 * ⚠ 세 상한을 올리려면 위 덧셈을 먼저 다시 푼다. `test/content-projection.test.mjs` 의
 *   「두 반쪽을 함께 태운다」 시험 둘이 그 덧셈을 기계로 잰다.
 */
const BASELINE_DIRTY_FILE_LIMIT = 10;
const BASELINE_DIRTY_FILE_CHARS = 256;
const BASELINE_DIRTY_FILE_TOTAL_CHARS = 1_000;

/**
 * git 객체 id — sha1 40자 또는 sha256 64자. `src/run-manifest.mjs` 의 같은 이름과 **같은 규칙**이고
 * (매니페스트가 이 실행의 baseline 을 그 정규식으로 검증한다), 여기서 다시 거는 이유는 이 파일이
 * 매니페스트를 import 하지 않기 때문이다(폐포 규칙) — 두 자리가 같은 두 값을 각자 잰다.
 */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** 공유 `boundedText`(= 이 파일의 `cleanText`) 의 boolean 어댑터. 정책은 한 곳에만 있다. */
function boundedString(value, max = 4_096, allowEmpty = false) {
  return cleanText(value, max, { allowEmpty }) !== null;
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
  const object = exactObject(value, ['runDir', 'manifestPath', 'candidatePaths', 'winnerAliasPath', 'initLockPath']).value ?? null;
  if (object === null) return null;
  const candidateKeys = candidateCount === 1 ? ['lane-a'] : ['lane-a', 'lane-b'];
  const candidates = exactObject(object.candidatePaths, candidateKeys).value ?? null;
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
  const object = exactObject(value, ['issues', 'attempts', 'evidence', 'files', 'artifacts']).value ?? null;
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
    const object = exactObject(value, ['candidateId', 'patchPresent', 'proofStatus']).value ?? null;
    if (object === null || !validLane(object.candidateId) || seen.has(object.candidateId) ||
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
    const object = exactObject(value, ['candidateId', 'openIssueIds', 'openIssueCount']).value ?? null;
    const ids = exactDenseArray(object?.openIssueIds);
    if (object === null || ids === null || !candidates.some((candidate) => candidate.candidateId === object.candidateId) ||
        out.has(object.candidateId) || ids.length > 100 || ids.some((id) => !boundedString(id, 128)) ||
        new Set(ids).size !== ids.length || safeInteger(object.openIssueCount, { minimum: ids.length, maximum: 100 }) === null) return null;
    out.set(object.candidateId, { ids: [...ids].sort(), count: object.openIssueCount });
  }
  return out;
}

/**
 * ★★ `stopReason` 은 **닫힌 열세 값**으로, `reasonCode` 는 **등재 여부**로 잰다. 예전 판정은
 *   「128자 안의 문자열」이라 `'x'` 도 `'OTHER_TERMINAL'` 도 통과했고, 그래서 본문이 계약
 *   (`contract/envelope.json` 의 runBody 두 행)을 어긴 채 바닥까지 그대로 내려갔다. 두 어휘를
 *   여기서 닫으면 어긴 값은 바닥에서 던지고, 사다리는 그 사실을 알림으로 말한다.
 */
function normalizedFixedFloorInput(value) {
  const object = exactObject(value, [
    'runId', 'stopReason', 'reasonCode', 'candidateCount', 'outcome', 'selectedCandidateId', 'paths',
    'candidates', 'issueSummary', 'omittedCounts',
  ]).value ?? null;
  if (object === null || !validRunId(object.runId) || !STOP_REASONS.includes(object.stopReason) ||
      !isReasonCode(object.reasonCode) ||
      ![1, 2].includes(object.candidateCount) || !ALL_OUTCOMES.has(object.outcome) ||
      object.candidateCount === 1 && !['winner', 'none'].includes(object.outcome)) return null;
  const needsSelection = SELECTED_OUTCOMES.has(object.outcome);
  if (needsSelection !== (object.selectedCandidateId !== null) ||
      object.selectedCandidateId !== null && !validLane(object.selectedCandidateId) ||
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
    reasonCode: object.reasonCode,
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
    reasonCode: normalized.reasonCode,
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

/**
 * 경로 예산을 재는 바닥 한 장. 경로가 아닌 두 값(`stopReason`·`reasonCode`)은 **가장 긴 것**을
 * 넣는다 — 예산은 최악의 경우를 재는 것이고, 짧은 표본을 넣으면 그 차이만큼 실제 봉투가
 * 예산을 넘긴다.
 *
 * ★★ **여기에 행을 더하지 마라.** 이 장이 재는 것은 바닥의 「경로 반쪽」하나이고, 바닥까지
 *   사는 다른 행들(`baseline`·`cost`·`scope`·`worktree`·`plan`)은 일부러 **없다**: 그 행들은
 *   경로 길이에 안 딸리고 각자 자기 상한을 지므로, 여기 넣으면 사용자가 고른 루트 길이를 재는
 *   관문이 상수 하나만큼 조용히 좁아진다. 두 반쪽을 잇는 산술은 `ARTIFACT_PATH_JSON_BUDGET`
 *   머리말에 있고, 그 덧셈이 깨지면 `test/content-projection.test.mjs` 의 「두 반쪽을 함께
 *   태운다」 시험 둘이 붉어진다 — 예산 상수를 고칠 자리는 이 함수가 아니라 그 덧셈이다.
 */
function budgetProjection(paths, runId, candidateCount, outcome, selectedCandidateId) {
  const lanes = LANES.slice(0, candidateCount);
  return buildFixedFloorProjection({
    runId,
    stopReason: LONGEST_STOP_REASON,
    reasonCode: LONGEST_REASON_CODE,
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
  const object = exactObject(input, ['stateRoot', 'runId', 'candidateCount']).value ?? null;
  if (object === null || !validAbsoluteRoot(object.stateRoot) || !validRunId(object.runId) || ![1, 2].includes(object.candidateCount)) {
    return fail(REASON.artifact_paths_invalid);
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
    return fail(REASON.artifact_path_budget_exceeded, { limit: ARTIFACT_PATH_JSON_BUDGET });
  }
  return deepFreeze({ ok: true, paths });
}

/**
 * 축소 사다리의 이름들(스펙 §4.1). **순서가 규칙이다** — 첫 번째로 `MAX_CONTENT_CHARS` 안에
 * 드는 단이 나가고, 그 단의 이름이 본문의 `reduced` 로 실린다.
 *
 * ★★ 이름이 없던 시절의 값은 「넉 장의 익명 클로저」였고, 그래서 봉투를 읽는 쪽은 **무엇이
 *   빠진 본문인지** 알 방법이 없었다(같은 키 집합에 값만 적었다). 이름과 `omittedCounts` 가
 *   함께 있어야 「이건 요약본이고, 시도 세 건과 사유 마흔 건이 빠졌다」가 읽힌다.
 * ★ `FLOOR` 는 사다리의 **밖**이다. 사다리는 「더 줄여 보는 단」의 목록이고 바닥은 줄이는
 *   단이 아니라 고정 상수라, 한 배열에 섞으면 「모든 단을 돌아 본다」는 순회가 바닥까지
 *   돌면서 실패를 성공처럼 삼킨다.
 */
export const LADDER = Object.freeze(['full', 'no_excerpts', 'summarized_attempts', 'limited']);
export const FLOOR = 'floor';

/**
 * 단마다 `buildContentProjection` 에 넘기는 값. 표를 코드 밖에 두는 이유는 하나다 — 사다리를
 * 읽는 사람이 「이 단이 무엇을 버리는가」를 함수 본문을 읽지 않고 한 화면에서 보게 하는 것.
 */
const RUNG_OPTIONS = Object.freeze({
  full: Object.freeze({}),
  no_excerpts: Object.freeze({ excerpts: false }),
  summarized_attempts: Object.freeze({ excerpts: false, summarizeOldAttempts: true }),
  limited: Object.freeze({
    excerpts: false, summarizeOldAttempts: true, fileLimit: 10, evidenceLimit: 4,
    planContent: false, scopeReasons: false, blockerLimit: 2, summarizeCandidates: true,
  }),
});

/**
 * 표에서 한 단의 값을 꺼낸다 — **모르는 이름은 던진다.**
 *
 * ★★ 예전에는 `RUNG_OPTIONS[rung] ?? {}` 였다. 그러면 오타 난 단 이름 하나가 **온전한 단의
 *   값**으로 돌면서 본문의 `reduced` 에는 그 오타를 적는다 — 아무것도 안 지운 본문이 "이 단이
 *   지웠다"고 말하는 거짓 이름표이고, 소비자는 정확히 그 닫힌 어휘로 분기한다. 사다리가
 *   던지는 것은 안전하다: 첫 실패가 곧 바닥이고 알림이 그 단의 이름을 말한다.
 * ★ `data()`(own 데이터 속성만)로 꺼내는 이유는 `'constructor'` 같은 이름이 프로토타입에서
 *   값을 얻어 오는 것을 막기 위해서다.
 */
function rungOptions(rung) {
  const options = data(RUNG_OPTIONS, rung);
  if (options === undefined) throw new TypeError(`Unknown ladder rung: ${String(rung)}`);
  return options;
}

/**
 * 봉투가 싣는 계획 본문의 상한(스펙 §4 의 500). 넘은 만큼은 `omittedCounts.planChars` 가 센다.
 *
 * ★★ 자르는 자리는 `500 − 1` 이다 — **말줄임표까지 합쳐** 상한 안이라야 계약의 `content <=500`
 *   이 참이다. 처음에는 500 을 남기고 그 뒤에 `…` 를 붙여 501 을 냈고, 그러면 상한을 읽고
 *   버퍼를 잡는 소비자가 한 글자마다 틀린다. 저장소의 다른 clip 자리와 같은 규칙이다.
 */
const PLAN_CONTENT_CHARS = 500;
const PLAN_CONTENT_CLIP = PLAN_CONTENT_CHARS - 1;

/**
 * 최후의 안전 상수. 이름이 `truncatedReport` 이지 **필드가 아니다**(스펙 §4.1) — 고정 바닥
 * 투영마저 만들 수 없거나 상한을 넘을 때만 나간다. `reduced` 는 여기에도 있다: 모든 본문이
 * 자기가 어느 단인지 말해야 「필드가 없다」와 「이 단이 지웠다」가 구별된다.
 */
const CONTENT_FALLBACK = `{"truncatedReport":true,"reduced":"${FLOOR}"}`;
const ROLE_KEYS = ['providerId', 'model', 'effort', 'tier', 'role'];
const USAGE_KEYS = ['calls', 'promptTokensKnown', 'evalTokensKnown', 'incomplete'];
const LEARNING_AXES = ['mix', 'placement', 'tier', 'rewrite'];
const TERMINAL_CLASSES = new Set(['verified', 'usable_unverified', 'rejected', 'blocked']);
const ATTEMPT_RESULTS = new Set(['accepted', 'repair', 'rejected', 'blocked', REASON.lane_stagnated]);
const EVIDENCE_KINDS = new Set(['b0', 'br', 'c']);
const EVIDENCE_OUTCOMES = new Set(['pass', 'fail', 'unknown']);
const JUDGE_CATEGORIES = new Set(['correctness', 'security', 'requirements', 'scope', 'tests']);
/** 심판 하나가 들 수 있는 major defect 수 — 생산자(`src/candidate-selection.mjs`)와 같은 값. */
const MAX_JUDGE_DEFECTS = 20;
// 정본은 **새 이름**이다(WS2 §2.4-a: 쓰기는 새 이름). 디스크에 남은 옛 철자
// (`invalid_format`·`invalid_json`·`invalid_schema`·`invalid_decision`·`deadline_exceeded`)는
// 아래 `closedReasonValue` 가 별칭으로 받아 **검사만** 통과시킨다 — 값은 고쳐 쓰지 않는다.
const JUDGE_CODES = new Set([
  REASON.judge_format_invalid, REASON.judge_json_invalid, REASON.judge_schema_invalid,
  REASON.judge_decision_invalid, REASON.judge_provider_failure, REASON.judge_view_unavailable,
  REASON.judge_scratch_failed, REASON.judge_deadline, REASON.judge_cancelled,
]);
const TUPLE_TERMINALS = new Set(['verified', 'usable_unverified']);
const TUPLE_TESTS = new Set(['stable_repeated_full_pass', 'stable_one_pass', 'unknown_or_not_run', 'flaky']);
const DECISIVE_FIELDS = new Set(['terminalClass', 'proof', 'tests', 'openIssues', 'scope']);
const TERMINAL_RANK = Object.freeze({ verified: 1, usable_unverified: 0 });
// ★ `src/candidate-selection.mjs:255` 의 사본이다 — 두 표가 갈리면 선택기가 낸 튜플을 본문
//   투영이 거절해 실행이 봉투를 못 낸다. `deferred` 는 `not_applicable` 과 같은 칸이다.
const PROOF_RANK = Object.freeze({ proved: 4, not_applicable: 3, deferred: 3, not_proven: 2, unavailable: 1, flaky: 0 });
const TEST_RANK = Object.freeze({ stable_repeated_full_pass: 3, stable_one_pass: 2, unknown_or_not_run: 1, flaky: 0 });
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 닫힌 어휘의 **읽기** 판정 — 디스크에 남은 옛 철자를 별칭으로 올려 **검사만** 하고 값은
 * 그대로 둔다(`src/run-manifest.mjs closedReasonValue` 와 같은 규칙, WS2 §2.4).
 *
 * ★★ 이 자리가 없던 동안 `attempts[].result` 의 `stagnated` 와 `judgeDecisions[].code` 의
 *   `deadline_exceeded` 는 **철자 하나에만** 맞았다. 생산자가 새 이름으로 옮겨가는 순간
 *   (Task 15) 그 행들이 통째로 떨어지고, 그 손실은 `omittedCounts.attempts` 한 수로만
 *   보인다 — 어제 만든 실행을 오늘 읽지 못하는 이유가 어디에도 안 적힌다.
 * ★ 값을 새 이름으로 **고쳐 쓰지 않는** 이유는 매니페스트 쪽과 같다: 봉투 바이트는 골든이고,
 *   읽기 관용이 조용한 재기록으로 번지면 두 채널이 다른 철자를 말하게 된다.
 */
function closedReasonValue(value, allowed) {
  if (allowed.has(value)) return true;
  const upgraded = normalizeLegacyReasonCode(value);
  return upgraded !== null && allowed.has(upgraded);
}

/**
 * 공유 `ownDataValue` 의 얇은 어댑터 — 이 파일의 투영 호출부 200여 곳은 "없으면 undefined"
 * 하나만 보면 되고, 있고 없고를 구별해야 하는 곳이 없다.
 */
function data(value, key) {
  return ownDataValue(value, key).value;
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
  return safeInteger(value) ?? fallback;
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
  return validLane(value) ? value : null;
}

function boundedStrings(value, { maximum = 10_000, chars = 32_768 } = {}) {
  const values = list(value);
  if (values.length > maximum || values.some((item) => cleanText(item, chars) === null) ||
      new Set(values).size !== values.length) return null;
  return values.sort(compareUtf8);
}

function boundedFileStrings(value, { maximum = 10_000, chars = 32_768 } = {}) {
  const values = list(value);
  if (values.length > maximum || values.some((item) => typeof item !== 'string' || item.length === 0 ||
      item.length > chars || item.includes('\0') || item.includes('\uFFFD')) || new Set(values).size !== values.length) return null;
  return values.sort(compareUtf8);
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

/**
 * **컷의 술어 — 투영 쪽 두 자리** (WS5 T4, 스펙 §0 D12): 「플래그가 섰고 그중 미승인이 남았나」.
 *
 * ★★ 투영에는 자기 정합성 검사가 둘 있고(고른 후보의 자격), 둘 다 `scope.flagged !== false` 를
 *   읽고 있었다 — `src/candidate-selection.mjs` 의 자격 술어와 **같은 정책의 사본**이다. 컷이
 *   옮겨갈 때 이 둘이 안 따라오면 증상이 최악이다: 실행은 성공하고, 봉투는 「본문을 만들지
 *   못했다」는 고정 요약 하나로 접힌다(`truncatedReport`). 실측이다 — EC-1 의 첫 초록에서
 *   `status: succeeded` 와 `{"truncatedReport":true}` 가 같은 봉투에 함께 나왔다.
 * ★ 날 값도 투영된 값도 같은 걸음으로 읽는다(`data`) — 한쪽만 안전 접근자를 쓰면 accessor 를
 *   심은 입력이 두 자리에서 다르게 읽힌다.
 */
function unapprovedScope(scope) {
  return data(scope, 'flagged') !== false && data(scope, 'allowlisted') !== true;
}

function projectScope(value, { fixed = false, keepReasons = true } = {}) {
  const flagged = data(value, 'flagged');
  if (typeof flagged !== 'boolean') throw new TypeError('Invalid scope projection.');
  // ★★ 등급은 **바닥까지 산다**(계약 `contract/envelope.json` 의 scope 행 floor 칸, WS5 T1).
  //   사유 목록은 `limited` 가 비우고 개수만 남기는데, 그 단에서 「지울 수 없는 것이 걸렸다」가
  //   함께 사라지면 남는 것은 「몇 건」뿐이고 그 수로는 패치를 적용할지 말지를 못 정한다.
  //   불린 하나는 어느 단에서도 압력이 아니다.
  const hardViolation = data(value, 'hardViolation') === true;
  // ★★ 허용목록 집계도 **바닥까지 산다**(WS5 T2, 계약의 scope 행 floor 칸). `hardViolation` 하나만
  //   남으면 바닥의 독자는 「지울 수 없는 것이 걸렸다」까지만 알고 「그런데 이 실행에서는 그것이
  //   기대된 변경이라고 프로젝트가 미리 적었다」를 못 읽는다 — 그 둘은 패치를 적용할지 말지를
  //   가르는 다른 사실이다. 불린 하나는 어느 단에서도 압력이 아니다.
  // ★ `=== true` 강제는 이 축에서 **닫는 쪽**이다(WS5 T4): 못 읽은 값은 미승인이 되고, 위
  //   `unapprovedScope` 가 그것을 자격 실패로 읽는다. 위 `hardViolation` 의 같은 강제는 컷의
  //   항이 아니라 **보고**라 방향이 반대이고(못 읽으면 "하드 아님"), 그 비대칭은 의도된 것이다.
  const allowlisted = data(value, 'allowlisted') === true;
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
      projection: { flagged, hardViolation, allowlisted, reasonCount, omittedReasonCount },
      omittedReasons: checkedAdd(reasonCount, omittedReasonCount),
    };
  }
  const { reasons, reasonCount: countedReasons } = projectScopeReasons(data(value, 'reasons'));
  // ★★ 생산자가 개수를 **직접** 말했으면 그것이 이긴다(fixed 갈래가 이미 그렇게 한다). 그러지
  //   않으면 목록을 만들 수 없는 생산자의 개수가 통째로 사라진다 — 실측: 테스트-델타 정책
  //   위반은 사유가 reason code 라서 `{path, rule, detail}` 객체가 없고, 엔진은 "개수는 세고
  //   목록은 비운다" 는 뜻으로 `reasons: []` + `reasonCount: n` 을 넘기는데 여기서 그 n 이
  //   버려져 봉투가 "걸린 것이 없다"(0)고 말했다. 선언값이 실제로 받은 행 수보다 **작으면**
  //   무시한다 — 그때는 선언이 아니라 손실이고, 센 값이 더 정확하다.
  const declaredCount = data(value, 'reasonCount') === undefined
    ? null
    : safeInteger(data(value, 'reasonCount'), { minimum: countedReasons });
  const reasonCount = declaredCount ?? countedReasons;
  const omitted = safeInteger(data(value, 'omitted'));
  if (omitted === null) throw new TypeError('Invalid scope projection.');
  // ★★ `limited` 단은 목록을 비우지만 **`reasonCount` 는 그대로 둔다**(스펙 §4.1). 개수까지
  //   지우면 "사유가 없었다" 와 "이 단이 목록을 버렸다" 가 같은 바이트가 되고, 그 둘은
  //   패치를 적용할지 말지를 가르는 다른 사실이다.
  const carried = keepReasons ? reasons : [];
  return {
    projection: {
      flagged,
      hardViolation,
      allowlisted,
      reasons: carried,
      // ★ 자른 것과 버린 것을 합친 **받은 전체 개수**다. 생산자가 이미 떨군 것은 `omitted` 가
      //   따로 말한다 — 둘은 다른 손실이라 한 수로 접지 않는다.
      reasonCount,
      omitted,
    },
    // 이 단이 나르지 못한 사유의 총수 = (받은 것 − 실은 것) + 생산자가 이미 떨군 것.
    omittedReasons: checkedAdd(reasonCount - carried.length, omitted),
  };
}

/**
 * 스코프 사유 `{path, rule, detail}` ≤ `SCOPE_REASON_LIMIT` 건과, 받은 전체 개수.
 *
 * ★★ **어긋난 행 하나는 그 행만 버린다.** 직전까지는 세 문자열 중 하나라도 경계 밖이면
 *   목록 전체를 `null` 로 내서 호출부가 던졌고, 그러면 사다리가 한 단씩 밀리다 결국 **고정 바닥**으로
 *   간다 — 사유 한 건이 이상하다는 이유로 후보·증거·판정이 전부 사라진다. 그 거래는 맞지 않다.
 *   버린 행도 `reasonCount` 에는 남으므로 「목록이 전부가 아니다」 는 사실은 잊히지 않는다.
 * ★ `rule` 은 생산자의 열거(`SCOPE_RULES`)에 있어야 한다. 자유 문자열을 받으면 그 자리가
 *   모델 산문의 입구가 된다(불변식 4).
 * ★ `path`·`detail` 은 200자에서 자르고 `…` 를 붙인다 — 이유는 `SCOPE_REASON_CHARS` 머리말에 있다.
 */
function projectScopeReasons(value) {
  const items = list(value);
  const reasons = [];
  for (const item of items) {
    if (reasons.length >= SCOPE_REASON_LIMIT) break;
    const rawPath = data(item, 'path');
    const rawDetail = data(item, 'detail');
    const rule = cleanText(data(item, 'rule'), 128);
    if (typeof rawPath !== 'string' || typeof rawDetail !== 'string' || rule === null || !SCOPE_RULE_SET.has(rule)) continue;
    const path = cleanText(clipPlain(rawPath, SCOPE_REASON_CHARS), SCOPE_REASON_CHARS + 1);
    const detail = cleanText(clipPlain(rawDetail, SCOPE_REASON_CHARS), SCOPE_REASON_CHARS + 1);
    if (path === null || detail === null) continue;
    reasons.push({ path, rule, detail });
  }
  return { reasons, reasonCount: items.length };
}

/**
 * 출발점 한 줄(계약의 `baseline` 행). 생산자는 `src/run-body.mjs` 의 `baselineRow` 하나다.
 *
 * ★★ 상한을 **다섯 단에 똑같이** 건다. 이 행은 바닥까지 사는데(계약의 floor 칸) `dirtyFiles`
 *   는 사용자 저장소가 정하는 길이라, 단마다 다른 상한을 두면 마지막 단이 유계가 아니게 되고
 *   그때 봉투는 본문 대신 잘린 상수 하나를 싣는다. 한 상한이면 잃는 것도 하나다.
 * ★★ 상한을 넘는 항목은 **자르지 않고 버린다.** 자른 경로는 경로가 아니고(문서가 "어느 단도
 *   절대경로를 자르지 않는다"고 약속한다), 그 절반짜리 문자열을 적용 판단에 쓰는 소비자는
 *   없는 파일을 찾는다. 버린 수는 `omittedCounts.files` 가 센다 — 그 키의 단위가 정확히
 *   「잃은 파일 경로」다.
 * ★ 세 값 중 하나라도 어긋나면 **던진다**(`projectCost` 와 같은 규율). 이 셋은 이 실행이 조립한
 *   값이라 어긋났다는 것은 조립기가 깨졌다는 뜻이고, 그때 지어낸 해시를 싣는 것보다 사다리가
 *   바닥으로 내려가며 알림 하나를 남기는 쪽이 정직하다. 바닥은 `try` 로 받아 유계 상수를 쓴다.
 */
function projectBaseline(value) {
  const commit = data(value, 'commit');
  const tree = data(value, 'tree');
  const dirty = data(value, 'dirty');
  if (typeof commit !== 'string' || !OBJECT_ID_PATTERN.test(commit) ||
      typeof tree !== 'string' || !OBJECT_ID_PATTERN.test(tree) ||
      typeof dirty !== 'boolean') throw new TypeError('Invalid baseline projection.');
  const received = list(data(value, 'dirtyFiles'));
  const kept = [];
  let spent = 0;
  for (const entry of received) {
    if (kept.length >= BASELINE_DIRTY_FILE_LIMIT) break;
    // 문자 정책은 형제 목록들과 **같은 하나**다(`boundedFileStrings`) — 여기 다시 적으면
    // 대체문자·NUL 규칙이 두 벌이 되고 한쪽만 고쳐진다. 다른 것은 둘뿐이다: 상한, 그리고
    // 어긋난 항목을 목록째가 아니라 **그 항목만** 버린다는 것(`projectScopeReasons` 의 규율).
    if (boundedFileStrings([entry], { maximum: 1, chars: BASELINE_DIRTY_FILE_CHARS }) === null ||
        kept.includes(entry) || spent + entry.length > BASELINE_DIRTY_FILE_TOTAL_CHARS) continue;
    spent += entry.length;
    kept.push(entry);
  }
  return {
    projection: { commit, tree, dirty, dirtyFiles: kept.sort(compareUtf8) },
    omittedFiles: received.length - kept.length,
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

/**
 * 막힌 후보 하나당 한 행. WS2 Task 11 이 모양을 바꿨다: `{where, error}` 는 **같은 값**을 두 번
 * 적은 것이었고, 그 값은 문장이 아니라 레인의 흐름 제어 토큰이었다. 이제 셋이다 — 등재된
 * `reasonCode`, 그 코드의 영어 한 문장(`message`), 다음에 할 한 문장(`recovery`, 있을 때만).
 * 정렬 키도 `where` 에서 `reasonCode` 로 옮겼다: 같은 입력은 같은 순서를 내야 한다.
 *
 * ★★ `reasonCode` 는 **등재 여부**로 잰다(`isReasonCode`). 예전 판정은 "128자 안의 문자열"
 *   이었고, 그러면 봉투의 닫힌 어휘 자리에 아무 낱말이나 실릴 수 있었다 — 소비자는 그 값으로
 *   분기하므로, 모르는 값 하나가 분기 전체를 무너뜨린다. 죽어 있던 `SAFE_CODE_PATTERN`
 *   (모양만 보던 정규식)이 하려던 일을 레지스트리가 한다.
 * ★ `limit` 은 `limited` 단의 ≤2 다(스펙 §4.1). 자른 개수는 호출부가 `omittedCounts.blockers`
 *   로 센다 — 자르는 자리와 세는 자리가 갈리면 둘 중 하나만 고쳐진다.
 */
function projectBlockers(value, { limit = null } = {}) {
  const items = list(value);
  const projected = items.flatMap((item) => {
    const candidateId = data(item, 'candidateId');
    const reasonCode = data(item, 'reasonCode');
    const message = cleanText(data(item, 'message'), 2_000);
    const recovery = cleanText(data(item, 'recovery'), 2_000);
    if (!(candidateId === undefined || laneId(candidateId) !== null) || !isReasonCode(reasonCode) || message === null) return [];
    return [{
      ...(candidateId === undefined ? {} : { candidateId }),
      reasonCode,
      message,
      ...(recovery === null ? {} : { recovery }),
    }];
  }).sort((left, right) => compareUtf8(
    `${left.candidateId ?? ''}\0${left.reasonCode}`,
    `${right.candidateId ?? ''}\0${right.reasonCode}`,
  ));
  const kept = limit === null ? projected : projected.slice(0, limit);
  return { entries: kept, omitted: items.length - kept.length };
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

/**
 * 봉투가 실을 계획. **없으면 `null`** 이다 — 플래너가 돌았는데 아무 말도 안 한 것과 플래너가
 * 실패해서 과제 원문을 쓴 것을 `content: ''` 로는 구별할 수 없다(WS2 §0 결정표 「plan.content」).
 *
 * ★★ `keepContent` 는 **단이 정한다**. 예전에는 `excerpts` 한 비트에 묶여 있어 `no_excerpts` 단부터
 *   `content` 가 `''` 가 됐는데, 결정표는 그 반대를 말한다: 계획은 `no_excerpts` 에서도 남고
 *   `limited` 에서만 지워진다(§4.1). 발췌와 계획은 다른 종류의 바이트라 한 비트로 묶으면
 *   한쪽을 지우려다 다른 한쪽이 조용히 사라진다.
 * ★★ 지울 때의 값은 `null` 이지 `''` 가 아니다. `''` 는 「계획이 비어 있다」 와 「계획을 이 단에서
 *   지웠다」 를 같은 바이트로 말해 읽는 쪽이 둘을 가를 수 없게 만든다.
 * ★★ 500자 상한(스펙 §4 「`content` ≤500자」)은 **여기 하나**다. 자르는 자리가 둘이면 두 상한이
 *   생기고, 잃은 글자 수를 세는 자리도 둘이 된다. 잘라 낸 만큼은 `omittedCounts.planChars` 가
 *   말한다 — 말줄임표만 붙이고 개수를 안 세면 「이게 전부인가」를 읽는 쪽이 알 수 없다.
 * ★ `clipWhole` 을 쓰는 이유: 계획은 모델 산문이라 이모지가 온다. `clipPlain` 은 상한이
 *   서로게이트 쌍 한가운데 떨어지면 반쪽을 남기고, 그 반쪽은 `cleanText` 가 통째로 거절해
 *   계획이 조용히 사라진다.
 */
function projectPlan(value, keepContent) {
  if (value === null || value === undefined) return { projection: null, omittedChars: 0 };
  const provider = cleanText(data(value, 'provider'), 128);
  const content = cleanText(data(value, 'content'), MAX_CONTENT_CHARS, { allowEmpty: true });
  const source = cleanText(data(value, 'source'), 32);
  if (provider === null) throw new TypeError('Invalid plan projection.');
  const full = content ?? '';
  const clipped = keepContent && full !== '' ? cleanText(clipWhole(full, PLAN_CONTENT_CLIP), PLAN_CONTENT_CHARS) : null;
  // 실은 글자 수는 **결과에서** 센다(말줄임표 한 글자를 뺀 값). 상한에서 계산하면 서로게이트
  // 쌍이 경계에 걸린 경우를 한 글자 놓친다 — `clipWhole` 은 그 쌍을 통째로 버린다.
  const carried = clipped === null ? 0 : clipped === full ? full.length : clipped.length - 1;
  return {
    projection: {
      provider,
      content: clipped,
      ...(source === null ? {} : { source }),
    },
    omittedChars: full.length - carried,
  };
}

/**
 * 스텝 한 줄 — `{step, laneId?, attemptId, retryOf}`.
 *
 * ★★ `providerExcerpt`·`testExcerpt` 를 읽던 두 줄은 **생산자가 없는 필드**였다(WS0 §3.2 가
 *   삭제 목록에 올렸고 Task 11 이 유일한 생산자를 지웠다). 읽기가 남아 있으면 계약에서 지운
 *   필드가 적대적 입력을 통해 다시 봉투로 들어온다 — 그 두 자리는 모델 산문이 들어오던
 *   자리였다(불변식 4). 발췌는 이제 `excerpts[]` 하나이고 `no_excerpts` 단이 그것을 지운다.
 */
function projectSteps(value) {
  return list(value).flatMap((step) => {
    const number = safeInteger(data(step, 'step'), { minimum: 1, maximum: 10 });
    const candidateId = data(step, 'laneId');
    const attemptId = cleanText(data(step, 'attemptId'), 160);
    const retry = data(step, 'retryOf');
    if (number === null || !(candidateId === undefined || laneId(candidateId) !== null) || attemptId === null ||
        !(retry === null || cleanText(retry, 160) !== null)) return [];
    return [{
      step: number,
      ...(candidateId === undefined ? {} : { laneId: candidateId }),
      attemptId,
      retryOf: retry,
    }];
  });
}

/**
 * 봉투가 싣는 발췌(스펙 §3.4) — `full` 단만 나른다. 스키마는 `src/envelope.mjs` 의 술어
 * 하나가 정한다: 만드는 쪽과 싣는 쪽이 서로 다른 모양을 믿으면 어긋난 발췌가 조용히 실린다.
 *
 * ★ 어긋난 행은 **던지지 않고** 버린다. 여기서 던지면 발췌 한 줄 때문에 사다리가 한 단씩
 *   밀리다 바닥까지 간다 — 후보·증거·판정이 전부 사라지는 값으로는 너무 비싸다. 버린 수는
 *   `omittedCounts.excerpts` 가 말한다.
 */
function projectExcerpts(value, keep) {
  const items = list(value);
  const valid = items.flatMap((item) => {
    const snapshot = {
      source: data(item, 'source'), vendor: data(item, 'vendor'), bytes: data(item, 'bytes'),
      truncated: data(item, 'truncated'), text: data(item, 'text'),
    };
    return isExcerpt(snapshot) ? [snapshot] : [];
  });
  const entries = keep ? valid.slice(0, EXCERPT_SCHEMA.maxItems) : [];
  return { entries, omitted: items.length - entries.length };
}

/**
 * 판정 한 줄. **`summary` 는 읽지 않는다** — 계약의 삭제 목록에 있는 필드이고(WS0 §3.2),
 * 그 자리는 검증자의 산문이 봉투로 들어오던 입구였다(불변식 4). 남아 있던 `summary: null` 은
 * 「언제나 비어 있는 키」라 읽는 쪽에 아무것도 말하지 않으면서 삭제만 미루고 있었다.
 */
function projectVerdict(value) {
  if (value === null || typeof value !== 'object') return null;
  const candidateId = laneId(data(value, 'candidateId'));
  const attemptId = cleanText(data(value, 'attemptId'), 160);
  const verdict = data(value, 'verdict');
  if (candidateId === null || attemptId === null || !['PASS', 'FAIL'].includes(verdict)) return null;
  return {
    candidateId,
    attemptId,
    verdict,
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

/**
 * 후보 한 줄. `summarize` 는 `limited` 단의 「`candidates` 요약」(스펙 §4.1)이다.
 *
 * ★★ **요약이지 삭제가 아니다.** 버리는 둘은 `binding`(작성자·검증자의 벤더·모델·effort)과
 *   `usage`(토큰 회계)다 — 이 단까지 내려온 봉투를 읽는 사람이 하는 결정은 "이 패치를
 *   적용할까" 하나이고, 그 결정은 `terminalClass`·`proofStatus`·`openIssues`·`scope`·`patch`
 *   가 가른다. 어느 모델이 썼는지와 몇 토큰을 썼는지는 실행 기록(artifact)이 그대로 갖고 있다.
 * ★★ 후보 **행 자체**는 어느 단도 버리지 않는다(하나나 둘이고 그 밖은 던진다). 그래서
 *   `omittedCounts` 에 `candidates` 키가 없다 — 자세한 이유는 `LADDER_OMITTED_KEYS` 머리말.
 */
function projectCandidates(value, { fileLimit = null, summarize = false } = {}) {
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
    // ★★ 후보 행도 본문과 같은 **두 층**이다(계약의 candidates 행): 조악 열세 값과 세부 코드.
    //   어긋난 값은 지어내지 않고 그 키만 빠진다 — 행 자체는 어느 단도 버리지 않는다.
    const stopReason = data(candidate, 'stopReason');
    const reasonCode = data(candidate, 'reasonCode');
    return {
      candidateId,
      ...(binding === null || summarize ? {} : { binding }),
      ...(TERMINAL_CLASSES.has(terminalClass) ? { terminalClass } : {}),
      patch,
      proofStatus,
      openIssueIds: ids,
      openIssueCount,
      ...(data(candidate, 'scope') && typeof data(candidate, 'scope') === 'object'
        ? { scope: projectScope(data(candidate, 'scope'), { fixed: true }).projection }
        : {}),
      ...(STOP_REASONS.includes(stopReason) ? { stopReason } : {}),
      ...(isReasonCode(reasonCode) ? { reasonCode } : {}),
      ...(usage === null || summarize ? {} : { usage }),
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
    // ★ `retryOf` 는 **서수 규칙**이다: 1 이면 `null`, 아니면 이 실행의 앞 서수를 가리키는 이름
    //   (불변식 9 — 0.2.2 리더가 요구하는 값과 같다, `src/run-manifest.mjs expectedRetryOf`).
    //   재개된 실행의 레인은 서수 3 에서 시작하고 그 앞 서수의 작업은 다른 실행에 있지만, 이름은
    //   그대로 이 실행의 앞 서수를 가리킨다 — 「이 목록에 있는가」를 여기서 물으면 재개된 줄이
    //   통째로 버려져 봉투가 "시도가 없었다" 고 말한다.
    const expectedRetry = candidateId === null || ordinal === null || ordinal === 1 ? null
      : attemptId?.slice(0, -expectedSuffix.length) + `/${candidateId}/${String(ordinal - 1).padStart(3, '0')}`;
    const attemptParts = attemptId?.split('/') ?? [];
    const identity = `${candidateId}:${ordinal}`;
    const authorityValid = authority === null || candidateId !== null && ordinal !== null &&
      authority.candidateIds.includes(candidateId) && attemptParts[0] === authority.runId &&
      (ref === null || ref === join(authority.runDir, 'attempts', `${candidateId}-${String(ordinal).padStart(3, '0')}.json`));
    if (candidateId === null || ordinal === null || attemptId === null ||
        attemptParts.length !== 3 || !validRunId(attemptParts[0]) || !attemptId.endsWith(expectedSuffix) ||
        retryOf !== expectedRetry || !closedReasonValue(result, ATTEMPT_RESULTS) ||
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
  if (!summarizeOld) return { entries: attempts, admitted: attempts, omitted };
  // ★★ 스펙 §4.1 은 이 단을 「`attempts[]` 를 **개수·최종 상태**만으로」라고 적는다: 레인마다
  //   **종단 시도 한 줄**만 온전히 남고 그 앞의 줄은 통째로 빠지며, 빠진 수는
  //   `omittedCounts.attempts` 가 말한다. 처음 판은 옛 줄의 `usage` 만 뗐는데(줄은 전부 남겼다)
  //   그 손실은 어느 수로도 안 남아서 「시도 열 건 중 아홉이 안 실렸다」와 「시도가 한 건이었다」가
  //   같은 바이트였다 — 그리고 아낀 바이트는 줄당 79자뿐이라 단 이름값도 못 했다.
  // ★ `admitted` 는 **줄이기 전** 집합이다. 판정(`verdict`)의 권위는 여기서 나온다: 이 단이
  //   자리를 아끼려고 버린 줄 때문에 판정까지 사라지면 「검증이 없었다」와 「이 단이 그 줄을
  //   버렸다」가 같은 바이트가 된다(고정 바닥이 이미 그 규칙으로 산다).
  const latest = new Map();
  for (const attempt of attempts) latest.set(attempt.candidateId, attempt.ordinal);
  const entries = attempts.filter((attempt) => attempt.ordinal === latest.get(attempt.candidateId));
  return { entries, admitted: attempts, omitted: checkedAdd(omitted, attempts.length - entries.length) };
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
  }).sort((left, right) => compareUtf8(left.evidenceId, right.evidenceId));
  const kept = limit === null ? entries : entries.slice(0, limit);
  return { entries: kept, omitted: malformed + entries.length - kept.length };
}

/** 유예된 증명이 가리키는 다음 도구 하나(계약 runBody 의 regressionProof 행). 나머지 다섯은 `null` 이다. */
const proofNext = (status) => status === 'deferred' ? 'orch_prove' : null;

function projectRegressionProof(value, evidenceLimit = null, authority = null) {
  const projected = projectEvidence(data(value, 'evidenceRefs'), evidenceLimit, authority);
  const status = data(value, 'status');
  const selectedCandidateId = data(value, 'selectedCandidateId');
  const priorOmitted = safeInteger(data(value, 'omittedEvidenceCount'));
  if (!PROOF_STATUSES.has(status) || !(selectedCandidateId === null || laneId(selectedCandidateId) !== null) ||
      priorOmitted === null) throw new TypeError('Invalid regression proof projection.');
  return {
    status,
    next: proofNext(status),
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

/**
 * 심판 결정 한 줄 → 봉투가 실을 **결정과 그 모양만**. 산문은 어느 단에서도 안 나간다(불변식 4).
 *
 * ★★ 예전에는 `rationale`(≤2,000자)과 `majorDefects[].claim`·`.evidence`(각 ≤1,000자)를 그대로
 *   다시 실었다. 그 셋은 **모델이 쓴 문장**이고, `selection` 은 `full`·`no_excerpts`·
 *   `summarized_attempts`·`limited` 네 단에서 통째로 남는다 — 실측으로 c2 동점 하나가 8,144자
 *   짜리 본문을 냈고, 최대 페이로드는 본문 **전체**를 바닥으로 무너뜨렸다. 상한이 있다는 것은
 *   산문이 아니라는 뜻이 아니다: 봉투가 받아들이는 유일한 모델 산문(`plan.content`)은 상한·
 *   `source:'model'`·카나리 셋을 다 갖췄고 이쪽은 셋 다 없었다.
 * ★ 그래서 남는 것은 **판정**이다: 어느 심판이, 무엇으로 결정했고, 형식 교정을 받았는지, 그리고
 *   어느 범주의 major defect 를 몇 건 들었는지(범주별로 묶어 개수만, 범주 이름 순). 개수는
 *   문장이 아니면서도 "correctness 두 건" 을 읽게 해 준다.
 * ★ 원문이 사라지는 것은 아니다 — 매니페스트(`src/run-manifest.mjs`)에 그대로 남고 WS3 의
 *   `orch_status` 가 「모델이 한 말」 라벨을 달아 낸다. 라벨이 있는 자리가 산문의 자리다.
 * ★ `rationale` 의 문자 검사도 함께 사라졌다. 안 싣는 값을 검증해서 **행 전체를 null 로** 만들면
 *   (그러면 `projectSelection` 이 던져 본문이 바닥으로 간다) 산문 하나가 봉투를 무너뜨리는 길이
 *   그대로 남는다. 범주는 닫힌 열거라 계속 검사한다 — 그것은 실리는 값이다.
 */
function projectJudge(value) {
  if (data(value, 'status') === 'invalid') {
    const judgeIndex = safeInteger(data(value, 'judgeIndex'), { minimum: 1, maximum: 2 });
    const code = data(value, 'code');
    if (judgeIndex === null || typeof data(value, 'corrected') !== 'boolean' || !closedReasonValue(code, JUDGE_CODES)) return null;
    return {
      status: 'invalid', judgeIndex,
      corrected: data(value, 'corrected'), code,
    };
  }
  const judgeIndex = safeInteger(data(value, 'judgeIndex'), { minimum: 1, maximum: 2 });
  const realDecision = data(value, 'realDecision');
  const rawDefects = list(data(value, 'majorDefects'));
  const categories = rawDefects.map((defect) => data(defect, 'category'));
  if (data(value, 'status') !== 'valid' || judgeIndex === null ||
      !['lane-a', 'lane-b', 'TIE'].includes(realDecision) || typeof data(value, 'corrected') !== 'boolean' ||
      rawDefects.length > MAX_JUDGE_DEFECTS ||
      !categories.every((category) => JUDGE_CATEGORIES.has(category))) return null;
  const counted = new Map();
  for (const category of categories) counted.set(category, (counted.get(category) ?? 0) + 1);
  const majorDefects = [...counted]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([category, count]) => ({ category, count }));
  return {
    status: 'valid', judgeIndex,
    realDecision, corrected: data(value, 'corrected'),
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

/**
 * 벤더로 키를 삼는 두 지도(`cost.providers`·`preflight.auth`)의 상한. 수를 여기서 새로 고르지
 * 않고 **원장의 상한을 그대로** 쓴다 — `src/run-manifest.mjs` 의 `MAX_USAGE_VENDORS`(8)와 벤더 id
 * 128자다.
 *
 * ★★ 상한을 두는 이유는 도달성이 아니라 **바닥의 유계성**이다. 벤더가 아홉인 실행은 이 자리에
 *   오기 전에 이미 `usage_recorded` 체크포인트에서 거절돼 봉투가 `failed` 로 끝난다(태스크 5 리뷰
 *   M1 — 그 상한을 생산자도 알게 하는 일은 아직 열려 있다). 그럼에도 여기 상한이 필요한 이유는
 *   `cost` 가 **바닥에서도 살아남는** 행이기 때문이다: 유계가 아닌 값 하나가 바닥에 실리면 마지막
 *   단이 상한을 넘고, 그때 봉투는 본문 대신 잘린 상수 하나를 싣는다. 최악값은 8 × (128 + 45) ≈
 *   1,400자다.
 * ★ 「실측 바닥에 더해도 상한 안」이라고 적혀 있던 뒷문장은 **경로 반쪽을 빠뜨린 산술**이었다
 *   (WS5 태스크 6 리뷰 I1). 이 행이 바닥에서 차지하는 자리의 정본은 `ARTIFACT_PATH_JSON_BUDGET`
 *   머리말의 덧셈이고, 이 수를 올리려면 거기부터 다시 푼다.
 */
const MAX_VENDOR_ROWS = 8;
const VENDOR_ID_CHARS = 128;

/**
 * `preflight.warnings` 의 상한. 최대는 **셋**이고(증거 판정 둘이 배타적) `test/golden-envelopes.test.mjs` 가 그것을
 * 기계로 못 박는다. 넷은 아무 입력도 안 밟는 죽은 `break` 였다(리뷰 T6-M3) — 상한은 실측이지 천장이 아니다.
 */
const MAX_PREFLIGHT_WARNINGS = 3;

/** 벤더로 키를 삼는 지도 하나를 정준 순서(`compareUtf8`)의 `[id, 값]` 목록으로. */
function vendorEntries(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort(compareUtf8).slice(0, MAX_VENDOR_ROWS)
    .map((name) => [cleanText(name, VENDOR_ID_CHARS), data(value, name)]);
}

/**
 * 비용 한 줄(계약의 `cost` 행). 생산자는 `src/run-body.mjs` 의 `costRow` 하나다.
 *
 * ★★ 두 종류의 어긋남을 **다르게** 다룬다. 실행 자신의 정수 셋(`elapsedMs`·`testRuns` 둘)이
 *   어긋나면 **던진다** — 그 셋은 이 실행이 조립한 값이라 어긋났다는 것은 조립기가 깨졌다는
 *   뜻이고, 그때 지어낸 0 을 싣는 것보다 사다리가 바닥으로 내려가며 알림 하나를 남기는 쪽이
 *   정직하다. 반면 어긋난 **벤더 행 하나는 그 행만** 버린다(`projectScopeReasons` 와 같은
 *   규율): 회계 한 줄 때문에 후보·증거·판정이 통째로 사라지는 거래는 맞지 않다.
 * ★ 토큰 두 키는 **함께 있거나 함께 없다**. 생산자가 그렇게 낸다(회계가 안 닫힌 벤더는 둘 다
 *   뺀다) — 한쪽만 실으면 읽는 쪽이 「반쯤 닫힌 회계」라는, 누산기에 없는 상태를 보게 된다.
 */
function projectCost(value) {
  const elapsedMs = safeInteger(data(value, 'elapsedMs'));
  const rawRuns = data(value, 'testRuns');
  const count = safeInteger(data(rawRuns, 'count'));
  const totalMs = safeInteger(data(rawRuns, 'totalMs'));
  if (elapsedMs === null || count === null || totalMs === null) throw new TypeError('Invalid cost projection.');
  const providers = {};
  for (const [vendor, row] of vendorEntries(data(value, 'providers'))) {
    const calls = safeInteger(data(row, 'calls'));
    if (vendor === null || calls === null) continue;
    const promptTokens = safeInteger(data(row, 'promptTokens'));
    const evalTokens = safeInteger(data(row, 'evalTokens'));
    providers[vendor] = promptTokens === null || evalTokens === null
      ? { calls }
      : { calls, promptTokens, evalTokens };
  }
  return { elapsedMs, providers, testRuns: { count, totalMs } };
}

/**
 * 크레딧 전 예측 한 줄(계약의 `preflight` 행). 입력은 엔진이 얼려 둔 `preflightReport` 산출 +
 * 인증 프로브 지도이고, 이 함수는 그중 **계약이 예약한 셋만** 남긴다.
 *
 * ★★ `warnings` 는 **알림 키**다. 입력은 `{key, params}` 행이지만 본문에 싣는 것은 그 key 하나다 —
 *   렌더된 영어 문장은 같은 실행의 실행 알림으로 이미 호출자에게 갔고(`src/engine.mjs` 의
 *   `addNotice`), 본문이 그것을 네 단에서 다시 실으면 같은 낱말에 예산을 두 번 낸다. 키는 닫힌
 *   어휘라 `NOTICE_TEXT` 에 **등재된 것만** 통과한다: 등재되지 않은 문자열을 실으면 이 자리가
 *   자유 문자열의 입구가 된다(불변식 4).
 * ★ `evidenceReachable` 은 닫힌 값 둘 중 하나여야 하고 아니면 **던진다**. 이 행의 뜻이 전부 그
 *   낱말에 있으므로, 모르는 값을 실은 행은 없느니만 못하다.
 */
function projectPreflight(value) {
  const verdict = data(value, 'evidenceReachable');
  if (![EVIDENCE_POSSIBLE, EVIDENCE_UNREACHABLE].includes(verdict)) {
    throw new TypeError('Invalid preflight projection.');
  }
  const auth = {};
  for (const [vendor, status] of vendorEntries(data(value, 'auth'))) {
    if (vendor === null || ![AUTH_UNKNOWN, AUTH_NOT_LOGGED_IN].includes(status)) continue;
    auth[vendor] = status;
  }
  const warnings = [];
  for (const entry of list(data(value, 'warnings'))) {
    if (warnings.length >= MAX_PREFLIGHT_WARNINGS) break;
    const key = typeof entry === 'string' ? entry : data(entry, 'key');
    if (typeof key === 'string' && Object.hasOwn(NOTICE_TEXT, key) && !warnings.includes(key)) warnings.push(key);
  }
  return { evidenceReachable: verdict, auth, warnings };
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

/**
 * 사다리가 지운 것의 수 — 스펙 §4.1 의 키 집합. **0 인 키는 싣지 않는다**: `0` 은 "이 단은
 * 아무것도 안 지웠다" 를 말하는 데 바이트를 쓰는 값이고, 사다리는 바이트가 모자라서 도는
 * 중이다. 위의 다섯(`issues`·`attempts`·`evidence`·`files`·`artifacts`)은 **단과 무관한**
 * 생산자 쪽 손실이라 언제나 실린다 — 그 다섯이 0 이라는 사실 자체가 "확인했다" 는 뜻이다.
 *
 * ★★ 스펙 §4.1 의 키 여섯 중 `candidates` 는 **없다.** 후보 행을 통째로 버리는 단이 없기
 *   때문이다: 후보는 하나나 둘이고(그 밖은 `projectCandidates` 가 던진다), `limited` 는 행을
 *   자리에서 요약하며(binding·usage 제거), 바닥도 행은 남긴다. 그래서 이 수는 **구조적으로**
 *   0 이고, 0 인 키는 안 싣는 규칙 때문에 영영 안 나간다. 이름만 잡아 둔 키는 소비자에게
 *   "언젠가 0 이 아닐 수 있다"고 거짓말한다 — 후보 행을 버리는 단이 생기는 날 그 커밋이
 *   이름을 도로 넣고, 계약의 `omittedCounts` 행이 그 사실을 적는다.
 */
const LADDER_OMITTED_KEYS = Object.freeze(['excerpts', 'scopeReasons', 'blockers', 'planChars']);

function withLadderCounts(base, counts) {
  const out = { ...base };
  for (const key of LADDER_OMITTED_KEYS) {
    const value = integer(counts[key]);
    if (value > 0) out[key] = value;
  }
  return out;
}

/**
 * 이름 있는 한 단의 본문. **생산 경로는 `renderContentParts` 하나**이고, 이 함수를 export 하는
 * 이유는 테스트가 「그 단이 무엇을 하는가」를 바이트 압력 없이 **이름으로** 재게 하는 것이다 —
 * 압력으로만 재면 단언 하나를 고칠 때마다 픽스처의 잔돈을 다시 고르게 되고, 재려던 성질이
 * 그 조정에 묻힌다(단 **경계**는 골든 픽스처가 따로 잰다).
 */
export function buildContentProjection(summary, rung = LADDER[0]) {
  const {
    excerpts = true,
    summarizeOldAttempts = false,
    fileLimit = null,
    evidenceLimit = null,
    planContent = true,
    scopeReasons = true,
    blockerLimit = null,
    summarizeCandidates = false,
  } = rungOptions(rung);
  const runId = data(summary, 'runId');
  // 두 어휘를 여기서 닫는다 — 이유는 `normalizedFixedFloorInput` 머리말.
  const rawStopReason = data(summary, 'stopReason');
  const stopReason = STOP_REASONS.includes(rawStopReason) ? rawStopReason : null;
  const rawReasonCode = data(summary, 'reasonCode');
  const reasonCode = isReasonCode(rawReasonCode) ? rawReasonCode : null;
  const stepCount = safeInteger(data(summary, 'stepCount'));
  const floor = buildFixedFloorProjection(data(summary, 'fixedFloorInput'));
  const candidates = projectCandidates(data(summary, 'candidates'), { fileLimit, summarize: summarizeCandidates });
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
  const verdict = projectedVerdict !== null && projectedVerdict.verdict === 'PASS' && attempts.admitted.some((attempt) =>
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
  const baseline = projectBaseline(data(summary, 'baseline'));
  const baseCounts = projectOmittedCounts(data(summary, 'omittedCounts'), {
    // ★ `baseline` 이 버린 경로도 같은 수에 든다 — 단위가 정확히 「잃은 파일 경로」다. 단마다
    //   다른 값이 아니라 상수인 이유는 그 행의 상한이 단에 안 딸리기 때문이다(그 머리말).
    files: fullFiles - keptFiles + baseline.omittedFiles,
    attempts: attempts.omitted,
    evidence: regressionProof.omittedEvidenceCount - integer(data(data(summary, 'regressionProof'), 'omittedEvidenceCount')),
  });
  const scope = projectScope(data(summary, 'scope'), { keepReasons: scopeReasons });
  const blockers = projectBlockers(data(summary, 'blockers'), { limit: blockerLimit });
  const plan = projectPlan(data(summary, 'plan'), planContent);
  const projectedExcerpts = projectExcerpts(data(summary, 'excerpts'), excerpts);
  const omittedCounts = withLadderCounts(baseCounts, {
    excerpts: projectedExcerpts.omitted,
    scopeReasons: scope.omittedReasons,
    blockers: blockers.omitted,
    planChars: plan.omittedChars,
  });
  const durablePaths = candidates.flatMap((candidate) => candidate.patch === null ? [] : [candidate.patch.path])
    .sort(compareUtf8);
  const projectedSteps = projectSteps(data(summary, 'steps'));
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
  if (!validRunId(runId) || runId !== floor.runId || stopReason === null || stopReason !== floor.stopReason ||
      reasonCode === null || reasonCode !== floor.reasonCode || stepCount === null ||
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
        selectedCandidate.terminalClass === 'usable_unverified' && selectedCandidate.reasonCode !== REASON.evidence_unavailable ||
        unapprovedScope(selectedCandidate.scope)) ||
      verdict !== null && verdict.candidateId !== selection.selectedCandidateId ||
      artifacts.omittedCount !== omittedCounts.artifacts ||
      regressionProof.omittedEvidenceCount !== omittedCounts.evidence ||
      resolvedIssueOmissions !== omittedCounts.issues) {
    throw new TypeError('Invalid mandatory summary projection.');
  }
  return {
    runId,
    stopReason,
    reasonCode,
    stepCount,
    // 계약의 행 순서 그대로다(`stepCount` → `baseline` → `patch`).
    baseline: baseline.projection,
    ...(legacyPatch === null ? {} : { patch: legacyPatch }),
    scope: scope.projection,
    worktree,
    blockers: blockers.entries,
    learning: projectLearning(data(summary, 'learning')),
    plan: plan.projection,
    steps,
    ...(projectedExcerpts.entries.length === 0 ? {} : { excerpts: projectedExcerpts.entries }),
    verdict,
    issues,
    candidates,
    attempts: attempts.entries,
    regressionProof,
    selection,
    artifacts,
    // 계약의 행 순서 그대로다(`cost` → `log`(topLevel) → `preflight`). 둘 다 **네 단 전부에서**
    // 살아남고, 갈리는 것은 바닥 하나다 — `cost` 는 남고 `preflight` 은 떨어진다.
    cost: projectCost(data(summary, 'cost')),
    preflight: projectPreflight(data(summary, 'preflight')),
    omittedCounts,
    // 마지막 자리다 — 「이 본문이 어느 단인가」는 본문을 다 읽은 뒤에 필요한 사실이고,
    // 계약의 필드 표도 같은 순서로 적혀 있다(`contract/envelope.json runBody.fields`).
    reduced: rung,
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
        rawTerminal === 'usable_unverified' && data(rawSelected, 'reasonCode') !== REASON.evidence_unavailable ||
        safeInteger(data(rawSelectedPatch, 'bytes'), { minimum: 1 }) === null || data(rawSelectedPatch, 'empty') !== false ||
        rawSelectedScope !== undefined && unapprovedScope(rawSelectedScope)) {
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
  // ★★ 바닥의 `baseline` 은 「못 읽었다」를 **모양을 지키며** 말한다: 해시 둘은 `null` 이고
  //   `dirty` 는 닫는 쪽(false)이다. 지어낸 해시를 싣는 것이 이 자리에서 가장 나쁜 손실이라 —
  //   적용 관문이 그 값을 자기 저장소와 대조한다 — 없는 것은 없다고 적는다.
  // ★ 형제 넷(`scope`·`worktree`·`plan`·`cost`)보다 **위**에서 읽는 이유는 하나다: 이 행이 버린
  //   경로가 바로 아래 `files` 에 들어가야 한다.
  let fixedBaseline = { projection: { commit: null, tree: null, dirty: false, dirtyFiles: [] }, omittedFiles: 0 };
  try { fixedBaseline = projectBaseline(data(summary, 'baseline')); } catch { /* bounded constant */ }
  const files = rawCandidates.reduce((sum, candidate) => checkedAdd(sum,
    arrayLength(data(data(candidate, 'patch'), 'files'))), 0) +
    arrayLength(data(rawPatch, 'files')) + arrayLength(data(rawPatch, 'ignoredPaths')) +
    arrayLength(data(rawPatch, 'gitlinks')) + arrayLength(data(rawWorktree, 'ignoredPaths')) +
    arrayLength(data(rawWorktree, 'sharedRules')) + fixedBaseline.omittedFiles;
  // ★★ 바닥은 차단자를 **하나도** 싣지 않는다 — 그 손실은 `omittedCounts.blockers` 가 센다.
  //   예전에는 그 수를 `issues` 에 접어 넣었고(계약의 `producedToday` 가 "defect" 라고 적어
  //   둔 자리다), 그러면 "해결된 이슈 세 건" 과 "막힌 후보 세 개" 가 같은 한 수로 나갔다.
  const blockers = projectBlockers(data(summary, 'blockers'), { limit: 0 });
  const omittedCounts = projectOmittedCounts(baseFloor.omittedCounts, {
    attempts: attemptProjection.entries.length + attemptProjection.omitted,
    evidence: evidenceProjection.entries.length + evidenceProjection.omitted,
    files,
  });
  const initialFloor = buildFixedFloorProjection({
    runId: data(floorInput, 'runId'),
    stopReason: data(floorInput, 'stopReason'),
    reasonCode: data(floorInput, 'reasonCode'),
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
  let rawProof;
  try { rawProof = projectRegressionProof(data(summary, 'regressionProof'), 0); } catch { rawProof = null; }
  const projectedVerdict = projectVerdict(data(summary, 'verdict'));
  let fixedScope = {
    projection: { flagged: false, hardViolation: false, allowlisted: false, reasonCount: 0, omittedReasonCount: 0 },
    omittedReasons: 0,
  };
  let fixedWorktree = {
    transplanted: false, ignoredPathCount: 0, sharedRuleCount: 0,
    cleanup: { removed: false, unregistered: null, tracked: false },
  };
  let fixedPlan = { projection: { provider: 'unknown', content: null }, omittedChars: 0 };
  // ★★ 바닥이 **`cost` 는 싣고 `preflight` 은 안 싣는** 자리다(계약이 그 순서를 예약했다). 실행
  //   전의 예측은 이미 끝난 실행에 대해서는 가장 먼저 버릴 수 있는 사실이고, **그 실행이 실제로
  //   무엇을 썼는가**는 마지막 단까지 남는다 — 마지막 한 장만 읽는 사람에게 그 둘의 값어치는
  //   같지 않다. 그래서 여기에는 `projectPreflight` 호출이 아예 없다.
  let fixedCost = { elapsedMs: 0, providers: {}, testRuns: { count: 0, totalMs: 0 } };
  try { fixedScope = projectScope(data(summary, 'scope'), { fixed: true }); } catch { /* bounded constant */ }
  try { fixedWorktree = projectWorktree(data(summary, 'worktree'), { fixed: true }); } catch { /* bounded constant */ }
  try { fixedPlan = projectPlan(data(summary, 'plan'), false); } catch { /* bounded constant */ }
  try { fixedCost = projectCost(data(summary, 'cost')); } catch { /* bounded constant */ }
  const buildFloorBody = (floor) => {
    const issues = floor.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      openIssueIds: [...candidate.openIssueIds],
      openIssueCount: candidate.openIssueCount,
      resolvedOmittedCount: resolvedOmissions?.get(candidate.candidateId) ?? 0,
    }));
    const legacyPatch = data(summary, 'aliasDurable') === true && Object.hasOwn(floor, 'patch') ? floor.patch : null;
    const selectedFloorCandidate = floor.selection.selectedCandidateId === null ? null
      : floor.candidates.find((candidate) => candidate.candidateId === floor.selection.selectedCandidateId);
    const floorProofStatus = selectedFloorCandidate?.proofStatus ??
      (rawProof?.selectedCandidateId === floor.selection.selectedCandidateId ? rawProof.status : 'unavailable');
    const proof = {
      status: floorProofStatus,
      next: proofNext(floorProofStatus),
      selectedCandidateId: floor.selection.selectedCandidateId,
      evidenceRefs: [],
      omittedEvidenceCount: floor.omittedCounts.evidence,
    };
    const verdict = projectedVerdict !== null && projectedVerdict.verdict === 'PASS' && floor.selection.selectedCandidateId !== null &&
      projectedVerdict.candidateId === floor.selection.selectedCandidateId &&
      attemptProjection.entries.some((attempt) => attempt.attemptId === projectedVerdict.attemptId &&
        attempt.candidateId === projectedVerdict.candidateId)
      ? projectedVerdict
      : null;
    return {
      runId: floor.runId,
      stopReason: floor.stopReason,
      reasonCode: floor.reasonCode,
      stepCount: integer(data(summary, 'stepCount')),
      // 계약의 행 순서 그대로다(`stepCount` → `baseline` → `patch`). 이 행은 바닥까지 산다.
      baseline: fixedBaseline.projection,
      ...(legacyPatch === null ? {} : { patch: legacyPatch }),
      scope: fixedScope.projection,
      worktree: fixedWorktree,
      blockers: [],
      learning: null,
      plan: fixedPlan.projection,
      steps: [],
      verdict,
      issues,
      candidates: floor.candidates,
      attempts: [],
      regressionProof: {
        status: proof.status,
        next: proof.next,
        selectedCandidateId: proof.selectedCandidateId,
        evidenceRefs: [],
        omittedEvidenceCount: proof.omittedEvidenceCount,
      },
      selection: floor.selection,
      artifacts: floor.artifacts,
      cost: fixedCost,
      omittedCounts: withLadderCounts(floor.omittedCounts, {
        excerpts: projectExcerpts(data(summary, 'excerpts'), false).omitted,
        scopeReasons: fixedScope.omittedReasons,
        blockers: blockers.omitted,
        planChars: fixedPlan.omittedChars,
      }),
      reduced: FLOOR,
    };
  };
  const issueCount = initialFloor.candidates.reduce((total, { openIssueIds }) =>
    checkedAdd(total, openIssueIds.length), 0);
  let omittedIssues = 0;
  let floor = initialFloor;
  let body = buildFloorBody(floor);
  while (JSON.stringify(body).length > MAX_CONTENT_CHARS && omittedIssues < issueCount) {
    omittedIssues += 1;
    let remaining = issueCount - omittedIssues;
    floor = buildFixedFloorProjection({
      runId: data(floorInput, 'runId'), stopReason: data(floorInput, 'stopReason'),
      reasonCode: data(floorInput, 'reasonCode'), candidateCount: data(floorInput, 'candidateCount'),
      outcome: data(floorInput, 'outcome'), selectedCandidateId: data(floorInput, 'selectedCandidateId'),
      paths: data(floorInput, 'paths'), candidates: data(floorInput, 'candidates'),
      issueSummary: initialFloor.candidates.map(({ candidateId, openIssueIds, openIssueCount }) => {
        const kept = openIssueIds.slice(0, remaining);
        remaining -= kept.length;
        return { candidateId, openIssueIds: kept, openIssueCount };
      }),
      omittedCounts: projectOmittedCounts(omittedCounts, { issues: omittedIssues }),
    });
    body = buildFloorBody(floor);
  }
  return body;
}

function stringifyProjection(projection) {
  const serialized = JSON.stringify(projection);
  return typeof serialized === 'string' ? serialized : null;
}

/**
 * 봉투가 실을 본문 한 장과 그 본문에 대한 사실 셋 — 어느 단이 나갔는지(`reduced`), 그 단이
 * 무엇을 얼마나 지웠는지(`omittedCounts`), 그리고 사다리 자체가 겪은 일(`notices`).
 *
 * 규칙(스펙 §4.1):
 *  - 첫 번째로 `MAX_CONTENT_CHARS` 안에 드는 단이 나간다.
 *  - **던지는 단은 건너뛰지 않는다** — 바로 바닥으로 가고 알림 하나(`ladder_rung_failed`)를 남긴다.
 *
 * ★★ 예전에는 던진 단을 조용히 건너뛰고 **다음 단**을 시도했다. 그 관용은 두 가지를 같은
 *   결과로 만든다: "이 단은 너무 크다"(정상)와 "이 본문에 어긋난 사실이 있다"(생산자 결함).
 *   후자는 더 작은 단에서도 같은 검증을 지나므로 결국 바닥까지 가는데, 그 여정은 어느
 *   채널에도 안 남아서 **봉투가 왜 요약본인지 아무도 모른다.** 이제는 첫 실패가 곧 바닥이고,
 *   알림이 어느 단에서 무엇이 깨졌는지 말한다.
 * ★ `contentFallback` 은 계속 낸다 — 봉투(`success`/`failure`)가 상한을 넘는 content 를 만나면
 *   꼬리부터 자르는 대신 이 값으로 바꿔 싣는다. 그 계약은 이 함수 밖에 있다.
 */
export function renderContentParts(summary) {
  let fixed;
  try {
    fixed = stringifyProjection(buildFixedContentProjection(summary));
  } catch {
    fixed = null;
  }
  const contentFallback = fixed !== null && fixed.length <= MAX_CONTENT_CHARS ? fixed : CONTENT_FALLBACK;
  const notices = [];
  for (const rung of LADDER) {
    let content;
    try {
      content = stringifyProjection(buildContentProjection(summary, rung));
    } catch {
      notices.push(renderNotice('ladder_rung_failed', { rung }));
      break;
    }
    if (content !== null && content.length <= MAX_CONTENT_CHARS) {
      return { content, contentFallback, reduced: rung, omittedCounts: omittedCountsOf(content), notices };
    }
  }
  return {
    content: contentFallback, contentFallback, reduced: FLOOR,
    omittedCounts: omittedCountsOf(contentFallback), notices,
  };
}

/**
 * 나간 본문이 **실제로 실은** `omittedCounts`. 다시 세지 않고 나간 바이트에서 읽는다 —
 * 두 번 세면 두 값이 갈리고, 그때 봉투와 반환값이 서로 다른 손실을 말한다.
 */
function omittedCountsOf(content) {
  try {
    return JSON.parse(content).omittedCounts ?? {};
  } catch {
    return {};
  }
}
