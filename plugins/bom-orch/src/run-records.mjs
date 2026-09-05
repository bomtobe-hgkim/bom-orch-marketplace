/**
 * attempt·evidence **기록의 정규화기** — 놓였거나 놓일 JSON 하나가 이 실행의 것인지 재는 자리. 매니페스트는 그 기록들의 **참조**만 든다(`src/run-manifest.mjs`).
 * ★ 방향은 하나뿐이다 — 여기서 `src/run-artifacts.mjs` 를 수입하지 않는다. 유일한 역참조였던 `finalPathForIdentity` 는 `verifySealedEvidenceAuthority` 의 **인자**로 들어온다(WS4a 메모 B.2):
 *   봉인된 evidence 는 커밋 목록에서 그때그때 찾은 identity 마다 경로가 필요하므로 경로 하나가 아니라 해석기를 받는다. 이 파일에서 바이트가 바뀐 줄은 그 둘뿐이다.
 * ★ 실측 폐포: **17개 모듈 / 6,594줄**(자기 자신 355 포함) — `reason-codes`·`reason-text`·`run-manifest`(태스크 3 뒤 `manifest-selection`·`candidate-selection`·`verdict`, WS4b 뒤 `preflight`, WS5 T12 뒤 `manifest-vocabulary` 를 끈다)·`run-store-fs`(`verifyStorePath` 하나)·`util/{errors,freeze,fs-atomic,hash,objects,paths,strings}`. 저장소 본체도 `content-projection` 도 없다.
 * ★ 수입하는 쪽은 셋이다: `src/run-artifacts.mjs`(일곱), `src/run-read.mjs`(`normalizeAttemptRecord`·`normalizePlanRecord`), `src/candidate-lane.mjs`(`MAX_ISSUE_CLAIM_CHARS`) — 앞의 둘은 태스크 9 의 다섯째 kind 로 각각 하나씩 늘었다.
 */

import { REASON } from './reason-codes.mjs';
import { LANES, sameJson } from './manifest-vocabulary.mjs';
import {
  ATTEMPT_RESULTS, closedReasonValue, expectedRetryOf, identityFromInventory, ISSUE_ID_PATTERN, MAX_JSON_ARTIFACT_BYTES,
  normalizeLaneBinding, normalizeStringArray, normalizeUsage, OBJECT_ID_PATTERN, ordinal, SHA256_PATTERN,
} from './run-manifest.mjs';
import { verifyStorePath } from './run-store-fs.mjs';
import { sha256 } from './util/hash.mjs';
import { exactDenseArray, exactObject } from './util/objects.mjs';
import { samePath } from './util/paths.mjs';
import { boundedText, isSafeCount } from './util/strings.mjs';

function normalizeVerdictValue(value) {
  if (value === null) return null;
  const object = exactObject(value, ['verdict', 'issueIds']).value ?? null;
  const issueIds = normalizeStringArray(object?.issueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  return object !== null && ['PASS', 'FAIL'].includes(object.verdict) && issueIds !== null
    ? { verdict: object.verdict, issueIds }
    : undefined;
}

/**
 * writer 가 attempt 를 어떻게 끝냈는가의 닫힌 어휘. `sealed` 만 판정이 아닌 상태이고 나머지 다섯은
 * 레지스트리 코드다. 디스크에 남은 옛 철자(`provider_failed`·`timeout`·`effect_unknown`·
 * `snapshot_failed`·`seal_failed`)는 `closedReasonValue` 가 별칭으로 받는다 — 오늘 생산자
 * (`src/candidate-lane.mjs`)가 아직 옛 이름으로 쓰고, WS2 Task 15 가 그 어휘를 옮긴다.
 */
const WRITER_RESULTS = Object.freeze([
  'sealed', REASON.provider_reported_failure, REASON.provider_deadline_exceeded, REASON.provider_outcome_unknown,
  REASON.git_snapshot_failed, REASON.git_seal_failed,
]);

/**
 * verifier 이슈 본문 `claim` 의 상한. 생산자(`src/candidate-lane.mjs`)가 이 수에서 자른다.
 *
 * 이 셋(상한·심각도 어휘·본문 정규화)은 **attempt 기록의 스키마**라 `normalizeAttemptRecord` 옆에
 * 산다. Task 12 의 첫 커밋이 `src/run-manifest.mjs` 로 보냈던 것을 되돌린 것이다 — 저 모듈은
 * "매니페스트라는 값" 이고, 매니페스트는 이슈의 **개수**(`issueSummary`)만 알지 본문을 모른다.
 */
export const MAX_ISSUE_CLAIM_CHARS = 500;

/**
 * 플래너 정본 `content` 의 상한 — **현행 소스 클립과 같은 수**다(스펙 §0-PL).
 *
 * ★★ 정본은 `src/prompts/instructions.mjs` 의 `EXCERPT_CHARS` 이고, `src/engine.mjs` 가 플래너
 *   응답을 그 수에서 자른 **뒤에야** 어떤 소비자도 그 텍스트를 본다. 그러니 이 artifact 가
 *   그보다 완전할 수 있는 길은 없고, 상한을 여기서 다시 적는 이유는 하나다: 저 모듈은 벤더
 *   프롬프트 문구(런타임 언어 게이트의 유일한 예외 경로)라 저장소 쪽 정규화기가 그것을 수입하면
 *   이 파일의 폐포가 프롬프트 트리를 통째로 끌고 온다. 두 수가 갈리지 않는 것은
 *   `test/candidate-artifacts.test.mjs` 의 대조가 잰다(그 파일이 두 상수를 함께 수입한다).
 * ★ 원문 무제한 정본은 이 워크스트림 **밖**이다(스펙 §8-3, 오너 항목) — 불변식 4 의 통제 셋을
 *   다시 설계해야 하고, 그 결정 전에 여기를 넓히면 상한 없는 모델 산문이 디스크에 남는다.
 *
 * ★★ **길이 계약의 철자는 하나다: 디스크에 놓이는 문자열이 이 수 안이다.** 생산자가 그 안에서
 *   자르고(`src/engine.mjs` 의 정본 쓰기 — 프롬프트에 실린 발췌는 `clipCounted` 의 꼬리표
 *   `… (+N more)` 까지 얹은 값이라 이 수보다 길 수 있다), 이 정규화기가 같은 수로 다시 잰다.
 *   두 철자를 두면(예: "상한은 클립 **예산**이다") 그 둘이 갈리는 자리가 생기고, 갈린 결과는
 *   조용하다 — 실측: 4,000자 응답 → 클립 1,214자 → 기록 거절 → 알림 하나만 남고 `plan.json`
 *   도 `readRunPlan` 도 `orch_status` 의 계획 채널도 **한 번도** 서지 못했다. 꼬리표를 이 수에
 *   포함시키는 반대 철자를 안 고른 이유: 그 최댓값은 `N` 의 자릿수에 딸려 있고 `N` 의 상한은
 *   벤더 응답의 상한이라, 이 파일이 프롬프트 트리와 벤더 어댑터의 수까지 알아야 한다.
 */
export const MAX_PLAN_CONTENT_CHARS = 1_200;

/**
 * 플래너 정본 `runs/<runId>/plan.json` 하나를 정규화한다 — 다섯째 artifactKind 의 **기록**이다.
 *
 * ★★ `source` 는 닫힌 한 값(`'model'`)이다. 그것이 이 파일의 존재 이유다: `src/engine.mjs` 의
 *   `plan` 변수는 플래너가 실패하면 **과제 원문**으로 되돌아가는데, 그 텍스트는 모델 산문이
 *   아니다. 라벨을 기록 자체에 박아 두면 읽는 쪽(`orch_status`)이 「이것이 모델의 말이다」를
 *   가정하지 않고 **읽어서** 안다 — 불변식 4 의 라벨은 리더의 습관이 아니라 값의 성질이어야 한다.
 * ★ 빈 계획은 계획이 아니다(`allowEmpty` 없음). 엔진은 빈 응답을 애초에 `plan` 에 싣지 않는다.
 * ★★ `content` 는 **여러 줄 산문**이다 — `src/prompts/instructions.mjs` 가 순서 있는 계획을
 *   요구하므로 줄바꿈은 예외가 아니라 정상이다. 그래서 `allowDiffWhitespace` 로 TAB·LF·CR 셋을
 *   여는데, 그것은 `src/verdict.mjs` 의 `boundedProse` 와 아래 `normalizeIssueBodies` 가 이미
 *   쓰는 **같은 정책**이다(정책을 새로 만들지 않는다). 기본 정책으로 재던 동안 이 정규화기는
 *   실제 플래너 응답을 **한 번도** 통과시키지 못했고, 다섯째 artifactKind 는 실행마다 조용히
 *   `planner_canon_unrecorded` 로 끝났다. NUL·다른 C0·DEL·C1·U+FFFD·짝 없는 서로게이트는
 *   산문에서도 계속 거절이다 — 열린 것은 텍스트 공백 셋뿐이다.
 */
function normalizePlanRecord(value, state) {
  const object = exactObject(value, ['schemaVersion', 'runId', 'source', 'content']).value ?? null;
  if (object === null || object.schemaVersion !== 1 || object.runId !== state.runId || object.source !== 'model' ||
      boundedText(object.content, MAX_PLAN_CONTENT_CHARS, { allowDiffWhitespace: true }) === null) return null;
  return { schemaVersion: 1, runId: object.runId, source: 'model', content: object.content };
}

/**
 * 이슈 본문의 심각도. 오늘 원장이 담는 것은 **전부 blocking** 이다 — 이름부터가
 * `MAX_BLOCKING_ISSUES` 이고, 열린 이슈가 하나라도 있으면 `decideAttempt` 가 후보를 거절한다.
 *
 * ★ 생산자가 없는 두 번째 값(`advisory`)을 미리 열어 두지 않는다. 어휘는 닫힌 목록이고, 닫힌
 *   목록의 값은 그것을 쓰는 기록이 실제로 통과하는지·읽는 쪽이 그것을 어떻게 다루는지 테스트가
 *   한 번은 재야 뜻이 있다. 아무도 쓰지 않는 값은 그 검사를 받은 적이 없으면서 스키마만 약속한다.
 *   막지 않는 관찰 채널이 생기는 날 이 배열에 한 줄을 더하면 되고, 그 커밋이 생산자와 테스트를
 *   함께 들고 온다 — 되열기는 한 줄이고, 검사받지 않은 약속을 거두는 일은 그렇지 않다.
 */
const ISSUE_SEVERITIES = Object.freeze(['blocking']);

/**
 * attempt 기록이 남기는 verifier 이슈의 **본문** 배열.
 *
 * 오늘까지 이 기록은 열린 이슈의 **식별자만** 남겼다(`feedback.openIssueIds`). 그래서 실행이
 * 끝나는 순간 "무엇이 왜 막았는가" 는 사라졌고 재개(WS3)도 `orch_status` 도 그것을 되살릴 수
 * 없었다(WS2 스펙 「verifier 이슈 본문」). 본문은 artifact 에만 남는다 — 봉투로는 나가지 않는다.
 *
 * ★ `openIssueIds` 와 **같은 순서의 같은 집합**이어야 한다. 갈리면 본문이 다른 결함에 붙고
 *   그 거짓말은 조용하다 — 그래서 개수와 자리를 여기서 잰다.
 * ★ `claim` 은 **여러 줄 산문**이다. `src/verdict.mjs` 의 `boundedProse` 가 TAB·LF·CR 을 명시적으로
 *   허용하므로(여러 줄 요약이 집 스타일인 verifier 의 판정을 잃지 않으려고 연 것이다) 여기서도
 *   같은 셋을 연다. 두 정책이 갈리면 줄바꿈 하나가 기록 **전체**를 떨어뜨리고, 그 레인은 이슈
 *   본문이 아니라 attempt_artifact_failed 로 끝난다 — 사용자가 고칠 길이 없는 실패다. NUL·다른
 *   C0·DEL·C1·U+FFFD·짝 없는 서로게이트는 산문에서도 계속 거절한다.
 * ★ 빈 문자열을 허용하는 이유는 machine 이슈다: 그쪽에는 산문이 없고 실패 지문뿐이다.
 * ★ `evidenceDigest` 는 근거 **원문의 sha256** 이다. 원문을 싣지 않는 이유는 불변식 4 —
 *   같은 결함이 재발했는지는 digest 비교로 충분하다.
 */
function normalizeIssueBodies(value, openIssueIds) {
  if (openIssueIds === null) return null;
  const array = exactDenseArray(value, 100);
  if (array === null || array.length !== openIssueIds.length) return null;
  const out = [];
  for (let index = 0; index < array.length; index += 1) {
    const item = exactObject(array[index], ['id', 'claim', 'evidenceDigest', 'severity']).value ?? null;
    if (item === null || item.id !== openIssueIds[index] ||
        boundedText(item.claim, MAX_ISSUE_CLAIM_CHARS, { allowEmpty: true, allowDiffWhitespace: true }) === null ||
        !SHA256_PATTERN.test(item.evidenceDigest) || !ISSUE_SEVERITIES.includes(item.severity)) return null;
    out.push({ id: item.id, claim: item.claim, evidenceDigest: item.evidenceDigest, severity: item.severity });
  }
  return out;
}

/**
 * attempt 기록 하나를 정규화한다. `fromDisk` 는 **이미 디스크에 놓인** 바이트를 읽을 때만 참이다.
 *
 * ★ 왜 관용에 스위치가 필요한가. 옛 플러그인이 남긴 기록의 feedback 은 `{openIssueIds}` 하나뿐이고
 *   (같은 `schemaVersion: 1`, 본문은 이 태스크가 더했다) 그것을 거절하면 그 실행은 이슈도, 봉인된
 *   후보도, 재개도 잃는다 — 이 함수 하나를 `applyAttemptTerminal`·`applyCandidateRecorded`·
 *   `sealedAttemptRecord` 와 `src/run-read.mjs` 의 세 읽기가 모두 지난다. 반대로 **부르는 쪽의
 *   입력**에까지 같은 관용을 주면 새 기록이 본문 없이 저장될 수 있고, 그러면 "무엇이 왜 막았는가"
 *   가 다시 조용히 사라진다 — 이 태스크가 고치려던 바로 그 결함이다. 읽기는 넓고 쓰기는 좁다.
 * ★ 관용이 여기 있어도 **왕복은 성립한다**: 쓰기가 좁으므로 디스크에 놓이는 새 기록은 언제나 두
 *   키를 갖고, `applyAttemptTerminal` 이 그 파일을 다시 읽어 같은 값을 얻는다.
 *
 * ★★ **왜 export 인가**(WS3 §0-D2). `orch_status` 는 프로세스가 죽은 뒤의 실행을 읽으므로 이
 *   모듈의 저장소 핸들(`createRunArtifacts` 가 낸 것, `WeakMap` 으로만 풀린다)을 가질 수 없다.
 *   그래도 검증은 **같은 함수**여야 한다 — 두 번째 정규화기는 첫날부터 갈라진다. 그래서
 *   `src/run-read.mjs` 가 이것을 부르고, `state` 는 그쪽이 디스크의 매니페스트에서 짓는다.
 * @param {object} state 이 함수가 읽는 것은 넷뿐이다: `runId`, `initial.laneBindings`,
 *   `initial.frozenTestPlan.planFingerprint`, `manifest.evidenceRefs`. 저장소 없는 호출자는
 *   정규화된 매니페스트 하나로 그 넷을 다 채울 수 있다(`initial` 과 `manifest` 에 같은 값을 준다 —
 *   레인 바인딩도 동결 계획도 실행 중에 바뀌지 않는다).
 */
export function normalizeAttemptRecord(value, state, laneId, attemptOrdinal, { fromDisk = false } = {}) {
  const object = exactObject(value, [
    'schemaVersion', 'laneId', 'attemptId', 'ordinal', 'retryOf', 'binding', 'writerResult', 'sealed',
    'verdictRef', 'usage', 'result', 'feedback',
  ]).value ?? null;
  const expectedId = `${state.runId}/${laneId}/${ordinal(attemptOrdinal)}`;
  const binding = normalizeLaneBinding(object?.binding);
  const verdictRef = normalizeVerdictValue(object?.verdictRef);
  const usageObject = exactObject(object?.usage, ['writer', 'verifier']).value ?? null;
  const writerUsage = normalizeUsage(usageObject?.writer);
  const verifierUsage = normalizeUsage(usageObject?.verifier);
  // 본문 없는 옛 셰이프는 **읽을 때만** 받는다(머리말의 `fromDisk`). 자리마다 같은 id 라는 상관
  // 검사는 본문이 **있을 때만** 잰다 — 옛 기록의 열린 이슈에는 애초에 본문이 없었고, 없는 것을
  // 어긋났다고 부르면 되살릴 수 있는 실행을 버리게 된다. 있는데 비었으면 그것은 여전히 어긋남이다.
  const feedbackObject = exactObject(object?.feedback, ['openIssueIds', 'issues']).value ??
    (fromDisk ? exactObject(object?.feedback, ['openIssueIds']).value ?? null : null);
  const feedbackIds = normalizeStringArray(feedbackObject?.openIssueIds, { max: 100, pattern: ISSUE_ID_PATTERN });
  const issues = feedbackObject !== null && !Object.hasOwn(feedbackObject, 'issues')
    ? [] : normalizeIssueBodies(feedbackObject?.issues, feedbackIds);
  if (object === null || object.schemaVersion !== 1 || object.laneId !== laneId || object.attemptId !== expectedId ||
      object.ordinal !== attemptOrdinal ||
      object.retryOf !== expectedRetryOf(state.runId, laneId, attemptOrdinal) ||
      binding === null || !sameJson(binding, state.initial.laneBindings[LANES.indexOf(laneId)]?.binding) ||
      !closedReasonValue(object.writerResult, WRITER_RESULTS) || verdictRef === undefined || usageObject === null ||
      writerUsage === null || verifierUsage === null || !closedReasonValue(object.result, ATTEMPT_RESULTS) ||
      feedbackObject === null || feedbackIds === null || issues === null) return null;
  let sealed = null;
  if (object.sealed !== null) {
    const sealedObject = exactObject(object.sealed, [
      'commit', 'treeHash', 'patchSha256', 'testPlanFingerprint', 'evidenceIds',
    ]).value ?? null;
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
    feedback: { openIssueIds: feedbackIds, issues },
  };
}

async function verifySealedEvidenceAuthority(record, state, laneId, attemptOrdinal, pathForIdentity) {
  // ★★ 해석기는 **인자**다(위 §방향) — 이 파일이 `src/run-artifacts.mjs` 를 수입하지 않으려고
  //   경로 계산을 호출부에서 받는다. 그러니 그것이 함수인지도 이 파일이 물어야 한다: 아니면
  //   아래 `pathForIdentity(state, identity)` 가 TypeError 를 던지고, 그 예외는 「거절은 false 로
  //   낸다」는 이 정규화기의 계약을 깨고 저장소의 이벤트 재생 위로 올라간다(호출부는 이 값을
  //   `!await verifySealedEvidenceAuthority(...)` 로만 읽는다). 거절이 던짐보다 언제나 낫다.
  if (typeof pathForIdentity !== 'function') return false;
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
    const expectedPath = identity === null ? null : pathForIdentity(state, identity);
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
  ]).value ?? null;
  const witnesses = normalizeStringArray(object?.witnessIds, { max: 20_000, pattern: SHA256_PATTERN });
  const failures = normalizeStringArray(object?.failureFingerprints, { max: 20_000, pattern: SHA256_PATTERN });
  const diagnostics = normalizeStringArray(object?.diagnostics, { max: 8, pattern: /^[a-z0-9_]{1,64}$/ });
  if (object === null || !['completed', 'not_run', 'spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(object.execution) ||
      !['pass', 'fail', 'unknown'].includes(object.outcome) ||
      !['assertion', 'collection', 'compile', 'dependency', 'infrastructure', 'unknown'].includes(object.failureKind) ||
      !['stable', 'flaky', 'unknown'].includes(object.stability) || typeof object.reproduction !== 'boolean' ||
      witnesses === null || failures === null || !(object.outputSha256 === null || SHA256_PATTERN.test(object.outputSha256)) ||
      !isSafeCount(object.outputChars) || object.planFingerprint !== record.testPlanFingerprint ||
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
  ]).value ?? null;
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
    if (!isSafeCount(info.size) || info.size <= 0 || info.size > maxBytes) return null;
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

/** 저장소 본체가 계속 부르는 여섯 중 `normalizeAttemptRecord` 를 뺀 다섯 — 그것과 `MAX_ISSUE_CLAIM_CHARS` 는 선언에 `export` 가 붙어 있다. */
export {
  normalizeEvidenceRecord, normalizePlanRecord, normalizeVerdictValue, readJsonRecord,
  verifyImmutableRef, verifySealedEvidenceAuthority,
};
