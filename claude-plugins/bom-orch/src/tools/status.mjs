// src/tools/status.mjs
/**
 * `orch_status` — 끝난 실행을 되읽는 **읽기 전용** 경로(WS3 스펙 §1). 새 핸들러는
 * `src/tools/<name>.mjs` 로 간다(WS0 §8: `src/tools.mjs` 증가 0) — 공유 배선은
 * `src/tools/context.mjs` 에서 오고, `tools.mjs` 를 되부르면 순환이 생긴다.
 *
 * ★ **디스크가 유일한 증인이다.** 봉투는 어디에도 저장되지 않으므로(`src/envelope.mjs` 는
 *   fs 를 수입조차 하지 않는다) 이 도구는 실행이 남긴 것 넷 — 실행 디렉터리·매니페스트·
 *   attempt 기록·로그 — 과 저널 행 하나를 합쳐 봉투를 **다시 짓는다**. 읽는 일은 전부
 *   `src/run-read.mjs`(태스크 3)가 하고 이 파일은 그 다섯 함수의 결과를 본문으로 옮긴다.
 *
 * ★ **문장은 저장돼 있지 않다**(§0-D1). 저널에는 코드만 있고, `error`·`recovery` 는 여기서
 *   `REASON_TEXT` 로 다시 렌더한다 — 그래서 문구를 고치면 옛 실행의 재구성도 함께 고쳐진다.
 *
 * ★★ **모델 산문 세 통제**(불변식 4, 스펙 §1). verifier 이슈의 `claim`, 심판의 `rationale`·
 *   `majorDefects[].claim`·`.evidence`, 그리고 플래너 정본의 `content`(WS4a §0-PL)는 **모델이 쓴
 *   문장**이다. 이 파일이 그것을 싣는 유일한 자리이고 조건 셋을 다 건다: (a) 상한을 **읽기에서
 *   다시** 건다(이슈 claim 500 · rationale 2,000 · 결함 claim·evidence 각 1,000 · 계획 1,200 —
 *   쓰기의 상한을 믿지 않는다: 디스크의 바이트는 옛 버전이 썼을 수 있다), (b) 산문을 나르는
 *   **행마다** `source:'model'`, (c) 그 문자열은 `error`·`recovery`·`notice` 어느 채널에도 절대
 *   못 간다. 셋째는 카나리(`test/tools-status.test.mjs`)가 **모든 축소 단**에서 잰다 — WS2 가
 *   `JUDGE_RAW_CANARY` 로 봉투 쪽에 세운 그물의 거울이다.
 * ★ 넷째 채널의 라벨은 **디스크에서 읽은 값**이다: `plan.json` 의 `source` 는
 *   `normalizePlanRecord` 가 `'model'` 하나만 통과시키므로, 이 파일은 라벨을 붙이는 것이 아니라
 *   나른다. 엔진이 계획을 못 내면 그 기록은 애초에 쓰이지 않는다(과제 원문은 모델 산문이 아니다).
 *
 * ★★ **카나리가 참을 재려면 바닥이 유계여야 한다.** 상한을 넘는 본문은 `success()` 가
 *   `{"truncatedReport":true}` 로 **조용히** 갈아치운다 — 그러면 카나리는 스텁을 훑고 언제나
 *   초록이다. 그래서 디스크에서 온 문자열(경로·삼중값·`taskPreview`·로그 줄)도 산문과 똑같이
 *   읽기에서 상한을 받는다(`PATH_CHARS` 위의 산술을 보라). 산문 상한만 있고 머리의 상한이
 *   없으면 통제 셋은 서 있는데 그것을 재는 그물이 비어 있다.
 */
import { join } from 'node:path';

import { MAX_CONTENT_CHARS, failure, success } from '../envelope.mjs';
import { REASON, STOP_REASONS, isReasonCode, normalizeLegacyReasonCode } from '../reason-codes.mjs';
import { fail, renderNotice, safeRender } from '../reason-text.mjs';
import { statusOfReasonCode } from '../run-faults.mjs';
import { confidenceOfStatus } from '../confidence.mjs';
import { resolveStateRoot } from '../state-root.mjs';
import { TASK_PREVIEW_CHARS, readRuns } from '../learn/journal.mjs';
import { readProofRecord } from '../proof-record.mjs';
import {
  LOG_TAIL_LEVELS,
  RECENT_RUNS_DEFAULT,
  listRunIds,
  readRunAttempts,
  readRunLogTail,
  readRunManifest,
  readRunPlan,
  readVerifierIssues,
  usableRunId,
} from '../run-read.mjs';
import { clipWhole } from '../util/strings.mjs';
import { toEngineDeps } from './context.mjs';

/**
 * 모델 산문의 상한 — **읽기에서 다시 건다.** 네 이름이 네 자리에 하나씩 붙고, 값은 쓰기 쪽
 * 정본과 같은 수다: 이슈 `claim` 500(`src/run-records.mjs MAX_ISSUE_CLAIM_CHARS`), 심판
 * `rationale` 2,000 · 결함 `claim`·`evidence` 각 1,000(`src/manifest-selection.mjs normalizeJudgeDecision`).
 * 여기서 다시 거는 이유: 이 바이트는 **옛 버전이 쓴 파일**일 수 있고, 상한을 쓰기에만 두면
 * 「그때는 통과했던 값」이 오늘의 봉투를 넘치게 한다.
 *
 * ★ `claim` 이 **두 자리에 다른 수**로 있다(이슈 500 · 결함 1,000). 예전에는 결함의 claim 을
 *   `EVIDENCE_CHARS` 라는 이름으로 잘랐다 — 수는 맞았고 이름만 틀렸는데, 그 이름을 읽는 다음
 *   사람은 「claim 은 500 아닌가」를 매번 다시 물어야 했다.
 */
const ISSUE_CLAIM_CHARS = 500;
const JUDGE_RATIONALE_CHARS = 2_000;
const DEFECT_CLAIM_CHARS = 1_000;
const DEFECT_EVIDENCE_CHARS = 1_000;
/**
 * 플래너 정본 `content` 의 상한 — 넷째 산문 채널이다(WS4a §0-PL, 태스크 9). 쓰기 쪽 정본은
 * `src/run-records.mjs MAX_PLAN_CONTENT_CHARS`(= 소스 클립 `EXCERPT_CHARS`) 와 같은 수이고,
 * 여기서 다시 거는 이유는 위 넷과 한 글자도 다르지 않다: 이 바이트는 **옛 버전이 쓴 파일**일 수 있다.
 */
const PLAN_CONTENT_CHARS = 1_200;

/**
 * **디스크에서 온 문자열**의 상한 — 산문 넷과 같은 이유로 읽기에서 건다(불신의 대상이 같다).
 *
 * ★★ **바닥의 산술**(수정 라운드 M1). 이 상한들이 없으면 사다리의 바닥이 유계가 아니다: 저널의
 *   `project` 는 **날것**이고(아래 `listingRow` 의 ★★), `taskPreview`·삼중값·매니페스트가 적어
 *   둔 경로(`normalizeArtifactRef` 는 32,768 까지 받는다)는 남의 파일이 쓴 바이트일 수 있다.
 *   다섯 단이 **모두** 넘치면 `success()` 가 본문을 `{"truncatedReport":true}` 로 **조용히**
 *   갈아치우고 그 사실을 봉투 어디에도 안 적는다 — 불변식 4 의 카나리가 그 스텁을 재게 되고,
 *   넘침이 붉은 테스트가 아니라 **속 빈 초록**이 된다.
 *
 *   바닥이 나르는 문자열: 경로 일곱(`project`·`artifacts` 다섯·`log.path`) · 삼중값 셋 ·
 *   `taskPreview` · `resumedFrom` · `runId` · `error`·`recovery` · 닫힌 어휘 몇. 나머지는 수와
 *   빈 배열이다.
 *     7×1,024 + 4×200(삼중값 셋 + `resumedFrom`) + 120 + 64(`runId` — 리더의 `RUN_ID_PATTERN` 이
 *     그 문턱이다) + 232(`error`+`recovery` 실측 최대: 레지스트리의 문장이고 이 자리는 파라미터를
 *     안 준다) + 골격 = **실측 8,477** < 10,000(`MAX_CONTENT_CHARS`). 전부 상한까지 채운 바닥을
 *     실제로 태워 잰 수이고, 그 측정은 테스트로 남아 있다(「바닥은 크기가 보장된다」).
 *     ★ 이 수는 두 번 다시 쟀다. 최종 리뷰: 적혀 있던 7,494 는 낡아 있었고(같은 픽스처의 실측이
 *       7,342) 거기에 `resumedFrom` 19자를 더해 7,361. WS4a 태스크 9 수정 라운드(m6): 그 태스크가
 *       적어 둔 8,726 은 아무도 안 잰 수였다 — 픽스처가 `artifacts.planPath` 를 **같이** 태우지
 *       않아 일곱째 경로가 32자로 남아 있었다(그때의 실제 실측은 7,485). 그 줄을 픽스처에 넣고
 *       다시 태워 **8,477** 이다(+992 = 1,024 − 32). 여유 1,523 자는 여덟 번째 경로 하나
 *       (1,024 + 키 이름 ≈ 1,045)를 아직 담지만 아홉째는 못 담는다 — 경로를 **둘** 더하는 커밋은
 *       이 산술을 먼저 다시 풀고, 하나를 더하는 커밋도 이 수를 다시 재서 여기에 적어야 한다.
 *   목록도 같은 상한 위에서 유계다: 한 행이 ≈1,900 자를 넘지 못하므로 `RECENT_RUNS_MAX`(50)
 *   행이 와도 사다리가 반씩 접어 첫 번째로 드는 단에서 멈춘다(0 행인 바닥은 ≈120 자다).
 * ★ 경로가 4,096(POSIX `PATH_MAX`)이 **아닌** 이유가 그 산술이다 — 여섯이면 24,576 이라 그것만으로
 *   봉투를 넘긴다. 1,024 는 실제 상태 루트·실행 이름의 여러 배이고, 자른 값은 말줄임표로
 *   「잘렸다」고 보인다(경로가 통째로 사라지지 않는다).
 * ★ `taskPreview` 의 수는 여기서 다시 적지 않고 **정본에서 받아온다**(`TASK_PREVIEW_CHARS`).
 *   쓰기가 이미 자르는데도 다시 거는 이유는 위와 같다 — 디스크의 바이트는 오늘의 작성기가 쓴
 *   것이 아닐 수 있다.
 */
const PATH_CHARS = 1_024;
const CODE_CHARS = 200;
const PREVIEW_CHARS = TASK_PREVIEW_CHARS;

/**
 * 로그 줄의 문자열 상한 — 작성기(`src/diag.mjs LOG_TEXT_MAX`)는 200 에서 자른다.
 *
 * ★ 두 배를 두는 이유: 작성기의 상한이 자라도 이 층은 계속 유계다. 상한을 정확히 같은 수로
 *   두면 작성기가 250 으로 자라는 날 **모든 줄**이 여기서 잘려 나가고, 그 사실은 어디에도
 *   안 적힌다.
 */
const LOG_TEXT_CHARS = 400;

/**
 * 단건 재구성의 축소 사다리. **순서가 규칙이다** — 첫 번째로 `MAX_CONTENT_CHARS` 안에 드는
 * 단이 나가고 그 이름이 본문의 `reduced` 로 실린다.
 *
 * ★ `src/content-projection.mjs` 의 사다리를 **재사용하지 않는다.** 저쪽은 실행 하나의 요약을
 *   받아 스물몇 필드를 정확히 검증하는 투영이고(어긋난 값 하나면 바닥으로 던진다), 이 본문은
 *   「디스크에서 읽힌 것」의 목록이라 그 검증을 통과할 수 없다 — 두 번째 사다리를 **분기**한
 *   것이 아니라 `orch_stats`(`renderStats`)와 같은 **크기 가드**를 쓴다. 어휘는 셋이 같다:
 *   `reduced` 는 단 이름, `omittedCounts` 는 그 단이 버린 것의 수.
 * ★ 버리는 순서는 「덜 아픈 것부터」다: 로그 꼬리 → 모델 산문 → 목록 상세 → 바닥.
 */
export const STATUS_LADDER = Object.freeze(['full', 'no_log', 'no_prose', 'limited', 'floor']);

/** 인자 없는 목록의 사다리 — 자를 것이 행 하나뿐이라 셋이다. */
export const STATUS_LISTING_LADDER = Object.freeze(['full', 'fewer_runs', 'floor']);

/**
 * 실패 봉투의 `status` 는 코드가 정한다(`statusOfReasonCode`) — **예외 하나**를 빼고.
 *
 * ★ `status_run_not_found` 의 조악값은 `blocked` 지만 봉투는 `invalid` 로 나간다. 레지스트리
 *   항목이 그렇게 적혀 있고(“It mirrors learning_run_not_found … the handler ships status
 *   invalid”), `orch_reward` 가 `learning_run_not_found` 에서 하는 것과 같다: 「그런 이름의
 *   실행이 없다」는 실행 전의 전제 조건 실패가 아니라 **호출자가 지목한 값**의 문제다.
 */
const envelopeStatusOf = (reasonCode) =>
  (reasonCode === REASON.status_run_not_found ? 'invalid' : statusOfReasonCode(reasonCode));

/**
 * 리더가 낸 실패를 그대로 봉투로. 문구는 이미 레지스트리가 렌더했으므로 다시 만들지 않는다.
 *
 * ★ 알림 채널을 함께 나른다(최종 리뷰 M2): 못 읽은 증인이 있었다는 사실은 코드만으로는 안
 *   보이고, `failure()` 의 `notice` 가 그것을 실을 자리다.
 */
const readerFailure = (blocked, notices = []) => failure({
  status: envelopeStatusOf(blocked.reasonCode),
  reasonCode: blocked.reasonCode,
  error: blocked.error,
  recovery: blocked.recovery,
  ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
});

/** 등재된 코드만 표시 이름으로 올려 읽는다. 모르는 값은 지우지 않고 읽은 그대로 나른다(§0-D4). */
const displayCode = (value) => (typeof value === 'string' ? normalizeLegacyReasonCode(value) ?? value : null);

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const stringOrNull = (value) => (typeof value === 'string' ? value : null);

/**
 * 실행 하나가 가진 **증명**의 세 값. 파일이 없으면 `null` 이다.
 *
 * ★★ 왜 실행 행에 붙나(실측): 실행 9(`run-mtcz280y-01xnz4`, 2026-08-28)는 55분 상한이 다섯 번째
 *   스위트 실행에서 끊어 증명 없이 끝났고, 그 뒤로 증명은 `orch_prove` 가 따로 돈다. 그래서
 *   「이 실행은 증명이 있나」는 매니페스트가 답할 수 없는 질문이 됐다 — 후보 행의 `proofStatus`
 *   는 실행이 끝난 시점의 값(`deferred`)이라 영원히 그대로다. 답이 사는 파일은 하나이고, 그것을
 *   읽는 자리가 여기다.
 * ★ 상한은 **읽기에서 다시** 건다(이 파일의 규율): 이 바이트는 우리가 이번에 쓴 것이 아닐 수
 *   있고, 바닥이 유계가 아니면 카나리가 스텁을 훑는다.
 */
const proofRow = (proof) => (proof === null || typeof proof !== 'object' ? null : {
  status: clipped(proof.status ?? null, CODE_CHARS),
  attemptId: clipped(proof.attemptId ?? null, CODE_CHARS),
  finishedAt: finiteOrNull(proof.finishedAt ?? null),
});

/**
 * 디스크에서 온 문자열 한 조각 — 상한을 다시 걸고, 글자를 쪼개지 않는다(반쪽 서로게이트는
 * UTF-8 왕복에서 깨진다). 모델 산문 넷과 디스크 문자열(경로·삼중값·preview·로그 줄)이 **같은**
 * 함수를 지난다: 규칙이 하나여야 「어디는 자르고 어디는 안 자른다」가 생기지 않는다.
 *
 * ★ 자르는 자리가 `limit - 1` 인 이유는 저장소의 다른 clip 자리와 같다: **말줄임표까지 합쳐**
 *   상한 안이라야 「claim ≤500」이 참이다. 501자를 내면 상한을 읽고 버퍼를 잡는 소비자가 한
 *   글자마다 틀린다(`src/content-projection.mjs PLAN_CONTENT_CLIP` 의 그 규칙).
 * ★ 문자열이 아니면 `null` 이다 — 「모른다」를 빈 문자열로 뭉개지 않는다.
 */
const clipped = (value, limit) => {
  if (typeof value !== 'string') return null;
  return value.length <= limit ? value : clipWhole(value, limit - 1);
};

/**
 * 저널 행 하나가 「이 실행은 끝났다」고 말하는가 — **파생은 이 한 자리다**(수정 라운드 L1).
 *
 * ★ 예전에는 목록이 넷(`finishedAt`·`status`·`stopReason`·`reasonCode`)을 보고 단건이 **둘만**
 *   (`status`·`stopReason`) 봤다. 그래서 종료 기록 여섯 키 중 일부만 실린 행 하나가 목록에서는
 *   `finished`, 단건에서는 `unknown` 으로 읽혔고 — 같은 도구의 두 답이 서로를 부정했다 — 그
 *   차이가 확신(`confidenceOfStatus` 의 `finished`)까지 갈랐다.
 * ★ 넷 중 **하나라도** 있으면 끝난 것이다. 여섯 키는 한 번에 쓰이지만(`runTerminalKeys`) 옛
 *   행·부분 기록·남의 파일은 그중 일부만 들고 있을 수 있고, 그 하나가 「끝났다」의 증거다.
 * ★ `finishedAt` 은 **유한한 수**일 때만 센다 — 본문에 실리는 값도 `finiteOrNull` 을 지나므로,
 *   그래야 「끝났다」와 본문의 수가 어긋나지 않는다.
 */
const runState = (row) => (row !== null && row !== undefined && (Number.isFinite(row.finishedAt) ||
  typeof row.status === 'string' || typeof row.stopReason === 'string' || typeof row.reasonCode === 'string')
  ? 'finished' : 'unknown');

// ── 인자 없는 최근 목록(§0-D5) ──────────────────────────────────────────────

/**
 * 목록 행 하나.
 *
 * ★★ **`project` 는 세척기를 지나지 않는다.** 저널이 그 값을 **날것**으로 저장하기 때문이다
 *   (태스크 2 의 결정: 세척하면 프로젝트 경로가 리터럴 `'<project>'` 로 접혀 실행 백 건이 모두
 *   같은 문자열이 되고, 이 키가 존재하는 이유가 그 자리에서 사라진다). `taskPreview` 는 반대로
 *   **세척된 뒤** 저장되므로 같은 행에서 `'<project>…'` 로 보일 수 있다 — 화면상의 불일치이고
 *   의도된 것이다. 이 자리에서 어느 쪽도 다시 세척하지 않는다.
 * ★ 세척하지 않는 것과 **자르지 않는 것**은 다르다(수정 라운드 M1): 날것으로 실린다는 말은
 *   상한 없이 실린다는 말이 아니다. 두 값 다 여기서 상한을 다시 받는다(`PATH_CHARS`·
 *   `PREVIEW_CHARS` 의 산술) — 그래야 목록의 한 행이 유계이고, 사다리의 반 접기가 끝난다.
 * ★ `state` 는 둘뿐이다. 오늘 이 서버에는 진행 중인 실행의 레지스트리가 없고(봉투는 디스크에
 *   안 남는다), 저널 행은 **끝날 때** 쓰인다 — 그래서 「끝났다」와 「모른다」만 참이다.
 *   `running` 을 지어내면 죽은 실행이 영원히 도는 것으로 보인다.
 */
function listingRow(run) {
  return {
    runId: run.runId,
    state: runState(run),
    status: clipped(run.status, CODE_CHARS),
    stopReason: clipped(run.stopReason, CODE_CHARS),
    reasonCode: clipped(displayCode(run.reasonCode), CODE_CHARS),
    startedAt: finiteOrNull(run.startedAt),
    finishedAt: finiteOrNull(run.finishedAt),
    project: clipped(run.project, PATH_CHARS),
    taskPreview: clipped(run.taskPreview, PREVIEW_CHARS),
    hasRunDir: run.hasRunDir === true,
    hasLog: run.hasLog === true,
  };
}

function listingBody(rows, journal, limit, kept) {
  const reduced = kept >= rows.length ? 'full' : kept === 0 ? 'floor' : 'fewer_runs';
  return {
    kind: 'recent',
    journal,
    limit,
    runs: rows.slice(0, kept),
    reduced,
    omittedCounts: reduced === 'full' ? {} : { runs: { asked: rows.length, kept } },
  };
}

/**
 * 목록 봉투. **순수 함수**다 — 리더의 결과를 받아 본문과 봉투만 만든다(골든 픽스처가 같은
 * 입구로 들어온다: `scripts/lib/golden-status-envelopes.mjs`).
 *
 * ★ 확신은 언제나 `unverified` 다. 계약(`contract/envelope.json confidenceByTool.orch_status`)이
 *   `verified` 를 「매니페스트를 읽었고 해시가 맞았다」로 정의하는데 목록은 매니페스트를 **한 장도
 *   열지 않는다**(N개를 여는 것은 이 경로가 피하려는 비용이다). 저널을 읽었는지는 본문의
 *   `journal` 이 말한다 — 확신 한 값에 두 사실을 접지 않는다.
 */
export function statusListingEnvelope({ listing, limit }, { notices = [] } = {}) {
  const rows = listing.runs.map(listingRow);
  let kept = rows.length;
  let shipped = listingBody(rows, listing.journal, limit, kept);
  let text = JSON.stringify(shipped);
  for (let step = 0; step < 64 && text.length > MAX_CONTENT_CHARS && kept > 0; step += 1) {
    kept = Math.floor(kept / 2);
    shipped = listingBody(rows, listing.journal, limit, kept);
    text = JSON.stringify(shipped);
  }
  return success({
    content: text,
    confidence: confidenceOfStatus({}),
    notice: notices.length > 0 ? notices.join(' ') : undefined,
  });
}

async function recentRuns(stateRoot, value) {
  const limit = Number.isSafeInteger(value.runs) && value.runs > 0 ? value.runs : RECENT_RUNS_DEFAULT;
  const listing = await listRunIds({ stateRoot, limit });
  if (listing.blocked) return readerFailure(listing);
  // ★ 저널이 상해도 목록은 나간다 — 실행 이름을 되찾는 것이 이 경로의 존재 이유다(§0-D5).
  //   `journalError` 는 리더가 이미 렌더한 **문장**이라 파싱하지 않는다: 알림의 `{reason}` 으로
  //   그대로 나르고(같은 자리에서 `orch_stats` 가 쓰는 그 알림이다), 코드로 분기할 일이 없다.
  const notices = listing.journal === 'unreadable'
    ? [renderNotice('run_journal_unreadable', { reason: listing.journalError })]
    : [];
  return statusListingEnvelope({ listing, limit }, { notices });
}

// ── 단건 재구성(§1) ─────────────────────────────────────────────────────────

/** 매니페스트가 아는 attempt 줄 하나. 기록 자체(`record`)는 안 싣는다 — 본문이 아니라 파일이다. */
const attemptRow = (attempt) => ({
  laneId: attempt.laneId,
  ordinal: attempt.ordinal,
  attemptId: attempt.attemptId,
  status: attempt.status,
  result: attempt.result,
  writerResult: attempt.writerResult,
  unreadable: attempt.unreadable === true,
});

const candidateRow = (candidate, detailed) => (detailed ? {
  candidateId: candidate.candidateId,
  terminalClass: candidate.terminalClass,
  proofStatus: candidate.proofStatus,
  sourceAttemptId: candidate.sourceAttemptId,
  treeHash: candidate.treeHash,
  tests: candidate.tests,
  scope: candidate.scope,
  patch: candidate.patchRef === null
    ? null
    : { path: candidate.patchRef.path, sha256: candidate.patchRef.sha256, bytes: candidate.patchRef.bytes },
} : {
  candidateId: candidate.candidateId,
  terminalClass: candidate.terminalClass,
  proofStatus: candidate.proofStatus,
});

/**
 * 심판 결정 한 줄. `withProse` 가 참인 단에서만 산문이 실리고, **그 행이 스스로**
 * `source:'model'` 이라고 말한다.
 *
 * ★ 산문을 버린 단에서도 **결정과 개수는 남는다** — 「이 단이 버렸다」와 「원래 없었다」가
 *   구별돼야 한다. 개수는 범주별로 묶는다(`src/content-projection.mjs projectJudge` 가 봉투
 *   쪽에서 이미 쓰는 그 모양이다: 「correctness 두 건」은 문장이 아니면서 읽힌다).
 * ★ `status:'invalid'` 인 심판은 산문을 아예 갖지 않는다 — 라벨도 붙이지 않는다. 라벨이 없는
 *   자리에 라벨을 붙이면 그 라벨이 무엇을 뜻하는지가 흐려진다.
 */
function judgeRow(judge, withProse) {
  if (judge.status !== 'valid') {
    return { judgeIndex: judge.judgeIndex, status: judge.status, corrected: judge.corrected, code: displayCode(judge.code) };
  }
  const defects = Array.isArray(judge.majorDefects) ? judge.majorDefects : [];
  if (!withProse) {
    const counted = new Map();
    for (const defect of defects) counted.set(defect.category, (counted.get(defect.category) ?? 0) + 1);
    return {
      judgeIndex: judge.judgeIndex,
      status: 'valid',
      realDecision: judge.realDecision,
      corrected: judge.corrected,
      majorDefects: [...counted].map(([category, count]) => ({ category, count })),
    };
  }
  return {
    judgeIndex: judge.judgeIndex,
    status: 'valid',
    realDecision: judge.realDecision,
    corrected: judge.corrected,
    source: 'model',
    rationale: clipped(judge.rationale, JUDGE_RATIONALE_CHARS),
    majorDefects: defects.map((defect) => ({
      category: defect.category,
      source: 'model',
      claim: clipped(defect.claim, DEFECT_CLAIM_CHARS),
      evidence: clipped(defect.evidence, DEFECT_EVIDENCE_CHARS),
    })),
  };
}

/** 매니페스트 요약. `detailed` 가 거짓인 단은 결속·시도·후보 상세를 버리고 개수만 남긴다. */
function manifestSummary(manifest, attempts, { detailed, withProse }) {
  const candidates = Array.isArray(manifest.candidateRefs) ? manifest.candidateRefs : [];
  const selection = manifest.selection ?? null;
  return {
    candidateCount: manifest.candidateCount,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    deadlineAt: manifest.deadlineAt,
    revision: manifest.revision,
    baseline: manifest.baseline,
    bindings: detailed
      ? (manifest.laneBindings ?? []).map((entry) => ({ laneId: entry.laneId, ...entry.binding }))
      : null,
    usage: manifest.usage,
    attempts: detailed ? attempts.map(attemptRow) : [],
    candidates: candidates.map((candidate) => candidateRow(candidate, detailed)),
    selection: selection === null ? null : {
      outcome: selection.outcome,
      selectedCandidateId: selection.selectedCandidateId,
      objectiveComparison: detailed ? selection.objectiveComparison : null,
      judges: (selection.judgeDecisions ?? []).map((judge) => judgeRow(judge, withProse)),
    },
  };
}

/**
 * 한 후보의 verifier 이슈 행. 본문(`claim`)은 **모델이 말한 것**이라 라벨과 상한을 함께 단다.
 *
 * ★ `count` 는 산문을 버린 단에서도 남는다 — 그 단의 본문만 읽고 「이슈가 없었다」로 읽히면
 *   안 된다. `read` 는 「못 읽었다」와 「없다」를 가르는 자리다(WS2 가 리더에서 세운 규칙).
 */
const issueRow = (entry, withProse) => ({
  candidateId: entry.candidateId,
  read: entry.read,
  reasonCode: entry.reasonCode ?? null,
  count: entry.issues.length,
  issues: entry.issues.map((issue) => (withProse ? {
    id: issue.id,
    severity: issue.severity,
    evidenceDigest: issue.evidenceDigest,
    source: 'model',
    claim: clipped(issue.claim, ISSUE_CLAIM_CHARS),
  } : {
    id: issue.id,
    severity: issue.severity,
    evidenceDigest: issue.evidenceDigest,
  })),
});

/**
 * 플래너 정본 한 줄 — **넷째 모델 산문 채널**이고, 그래서 앞의 셋과 같은 통제 셋을 받는다
 * (WS4a §0-PL). 라벨(`source`)은 리더가 붙이는 것이 아니라 **기록에서 읽은 값**이다:
 * `src/run-records.mjs normalizePlanRecord` 가 `'model'` 하나만 통과시키므로, 라벨이 붙은 행은
 * 정의상 모델이 쓴 문장이다.
 *
 * ★ `chars` 는 **디스크에 있던 길이**다(자른 뒤가 아니다). 산문을 버린 단에서도 그 수는 남는다 —
 *   「이 단이 버렸다」와 「원래 계획이 없었다」를 가르는 것이 그 수이고, `read` 가 「못 읽었다」를
 *   세 번째 답으로 갈라 놓는다(이슈 행의 `read`·`count` 와 같은 규율).
 * ★ 산문을 버린 단에서는 `content` 도 `source` 도 **키 자체가 없다**. 라벨만 남기면 그 라벨이
 *   무엇을 가리키는지 흐려진다(위 `judgeRow` 의 `status:'invalid'` 갈래와 같은 이유).
 */
const planRow = (entry, withProse) => {
  const plan = entry?.plan ?? null;
  return {
    read: entry?.read ?? 'absent',
    reasonCode: entry?.reasonCode ?? null,
    chars: plan === null ? 0 : plan.content.length,
    ...(plan !== null && withProse
      ? { source: plan.source, content: clipped(plan.content, PLAN_CONTENT_CHARS) }
      : {}),
  };
};

/** 산문 한 조각이 **실제로 있었나**. 장부는 있던 것만 센다. */
const present = (value) => typeof value === 'string' && value !== '';

/**
 * 그 단이 버린 산문 조각의 수. 「빠졌다」를 수로 말하지 않으면 본문만 읽는 소비자는 모른다.
 *
 * ★ 결함마다 **2 를 무조건** 세지 않는다(수정 라운드 L3). 정본 정규화기는 `claim`·`evidence` 를
 *   둘 다 요구하지만 이 함수가 받는 것은 「디스크에서 읽힌 것」이라 한쪽이 없는 결함이 올 수
 *   있고, 그때 2 를 세면 장부가 **없던 문장을 버렸다고** 말한다 — 이 수의 존재 이유(「이 단이
 *   버렸다」와 「원래 없었다」의 구별)가 그 자리에서 뒤집힌다.
 */
function proseCount(input) {
  const judges = input.manifest.manifest?.selection?.judgeDecisions ?? [];
  let count = 0;
  for (const judge of judges) {
    if (judge.status !== 'valid') continue;
    if (present(judge.rationale)) count += 1;
    for (const defect of judge.majorDefects ?? []) {
      if (present(defect.claim)) count += 1;
      if (present(defect.evidence)) count += 1;
    }
  }
  for (const entry of input.issues) count += entry.issues.length;
  // 플래너 정본도 산문 한 편이다 — 세지 않으면 그 단이 계획을 버린 사실이 어느 수에도 안 남는다.
  if (present(input.plan?.plan?.content)) count += 1;
  return count;
}

/**
 * 버려진 이슈의 수 — **이슈**를 센다(수정 라운드 L2). 예전에는 `input.issues.length`, 즉 후보
 * **묶음**의 수였다: 이슈 120 건이 두 후보에 실려 있으면 장부에 `2` 가 적혔고, 그 수는 소비자가
 * 잃은 것과 아무 관계가 없다(같은 본문의 `omittedCounts.prose` 는 120 을 센다 — 한 봉투 안에서
 * 두 수가 다른 단위로 같은 사건을 말했다).
 */
const issueCount = (entries) => entries.reduce((total, entry) => total + entry.issues.length, 0);

/**
 * 인라인되는 로그 줄 하나 — **라벨 없는 디스크 채널**이라 상한을 여기서 다시 건다(수정 라운드 M2).
 *
 * ★ **왜 리더가 아니라 이 층인가.** D2 는 `src/run-read.mjs` 를 「넓게 읽는」 층으로 정했다 —
 *   리더는 파일이 말한 것을 그대로 내고, **봉투의 출력 규율**은 도구가 건다(모델 산문 상한 넷이
 *   이미 이 파일에 사는 것과 같은 이유다). 리더에서 자르면 다음 소비자(§2 취소·§4 진행)가 자기
 *   상한을 고를 수 없고, 잘린 값이 「파일에 그렇게 적혀 있었다」로 읽힌다.
 * ★ 자르되 **지우지 않는다**: 문자열이 아닌 값(수·불리언 — 작성기의 `fields` 는 평면이다)은
 *   그대로 나른다. 남의 파일이 중첩 객체를 넣으면 그 줄은 커지지만 봉투는 안전하다 — 파일
 *   읽기가 `RUN_LOG_MAX_BYTES * 2` 로 묶여 있고, 꼬리가 커지면 사다리가 `no_log` 로 내려가
 *   **줄 전체**를 버린다(바닥의 산술이 로그 줄을 하나도 안 세는 이유다).
 * ★ 키도 자른다 — 작성기와 같은 규칙이다(`src/diag.mjs flatFields`: 상한 없는 키는 값의 약속을
 *   키 쪽으로 빠져나간다).
 */
const logRow = (line) => {
  const fields = line.fields !== null && typeof line.fields === 'object' && !Array.isArray(line.fields)
    ? line.fields
    : {};
  return {
    ts: finiteOrNull(line.ts),
    level: clipped(line.level, CODE_CHARS),
    reasonCode: clipped(displayCode(line.reasonCode ?? null), CODE_CHARS),
    message: clipped(line.message, LOG_TEXT_CHARS),
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [
      clipped(key, LOG_TEXT_CHARS),
      typeof value === 'string' ? clipped(value, LOG_TEXT_CHARS) : value,
    ])),
  };
};

/**
 * 단 하나의 본문. 이 함수 하나가 다섯 단을 다 만든다 — 단마다 다른 조립기를 두면 「이 단이
 * 무엇을 버리는가」가 다섯 자리로 흩어지고, 카나리가 그중 하나만 지나가는 날이 온다.
 */
function runBody(input, rung) {
  const withLog = rung === 'full';
  const withProse = rung === 'full' || rung === 'no_log';
  const detailed = rung !== 'limited' && rung !== 'floor';
  const floor = rung === 'floor';
  const row = input.journal.row;
  const reasonCode = clipped(displayCode(row?.reasonCode ?? null), CODE_CHARS);
  // ★ `renderReason` 이 아니라 `safeRender` 다(재리뷰 재정: 라이브 Medium). 등재 코드 377개 중
  //   154개가 인자를 요구하고, 저널 행은 코드만 저장한다(§0-D1) — `renderReason(code, {})` 는
  //   그 154개에서 던지며, 그 throw 는 도구 전체를 `run_tool_failed` 로 접어 **사용자가 이 도구를
  //   가장 필요로 하는 실행**(예: provider_spawn_failed)의 재구성을 통째로 지웠다. 강등 문장이
  //   빈 재구성보다 낫고, `degraded` 플래그가 강등을 침묵시키지 않는다.
  const rendered = isReasonCode(reasonCode) ? safeRender(reasonCode, {}) : null;
  const manifest = input.manifest.manifest;
  const attempts = input.attempts.attempts ?? [];
  const lines = input.log.lines ?? [];
  const logPath = clipped(input.log.path, PATH_CHARS);
  const omittedCounts = {
    logLines: (input.log.omitted ?? 0) + (withLog ? 0 : lines.length),
    logLinesUnparsable: input.log.unparsable ?? 0,
  };
  if (!withProse) omittedCounts.prose = proseCount(input);
  if (!detailed && attempts.length > 0) omittedCounts.attempts = attempts.length;
  const head = {
    kind: 'run',
    runId: input.runId,
    state: runState(row),
    status: clipped(row?.status ?? null, CODE_CHARS),
    stopReason: clipped(row?.stopReason ?? null, CODE_CHARS),
    reasonCode,
    // ★ 저장된 문장이 아니라 **코드에서 다시 렌더한** 두 문장이다(§0-D1). 등재되지 않은 코드
    //   (0.2.2 이전의 값이나 남의 파일)에서는 지어내지 않고 `null` 이다.
    error: rendered?.error ?? null,
    recovery: rendered?.recovery ?? null,
    journal: input.journal.state,
    project: clipped(row?.project ?? null, PATH_CHARS),
    taskPreview: clipped(row?.taskPreview ?? null, PREVIEW_CHARS),
    // ★★ 시작 시각의 정본은 `startedAt` 이고 `at` 은 옛 행의 폴백이다(최종 리뷰 I8): `at` 은
    //   그 줄이 **쓰인** 시각이라 종료 행에서는 언제나 `finishedAt` 이상이고, 그것을 시작으로
    //   읽으면 50분 돈 실행이 0 ms 또는 음수로 보인다(실측 -2 ms).
    startedAt: finiteOrNull(row?.startedAt ?? row?.at ?? null),
    finishedAt: finiteOrNull(row?.finishedAt ?? null),
    // ★ 재개의 출처. 이 값이 없으면 아래 attempt 서수가 3 부터 시작하는 이유를 어느 읽기 경로도
    //   말하지 못한다 — 그 사실이 남는 다른 채널은 로그의 `info` 줄뿐이고 꼬리가 그것을 거른다.
    resumedFrom: clipped(row?.resumedFrom ?? null, CODE_CHARS),
    manifest: input.manifest.read,
    // ★ 바닥까지 간다 — 「적용해도 되나」를 읽는 사람이 마지막까지 들고 가야 하는 사실이다.
    proof: proofRow(input.proof ?? null),
  };
  const artifacts = {
    runDir: clipped(input.paths.runDir, PATH_CHARS),
    manifestPath: clipped(input.paths.manifestPath, PATH_CHARS),
    candidatePaths: floor ? [] : (manifest?.candidateRefs ?? [])
      .filter((candidate) => candidate.patchRef !== null)
      .map((candidate) => clipped(candidate.patchRef.path, PATH_CHARS)),
    // ★ 매니페스트가 적어 둔 경로다 — 정본 정규화기는 32,768 까지 받으므로(`normalizeArtifactRef`)
    //   이 자리가 바닥에서 유계인 유일한 이유가 이 상한이다.
    winnerPath: clipped(manifest?.winnerAlias?.path ?? null, PATH_CHARS),
    // ★ 같은 이유로 유계다 — 이 경로도 매니페스트의 ref 가 적어 둔 값이다(32,768 까지 온다).
    planPath: clipped(input.plan?.plan?.path ?? null, PATH_CHARS),
    logPath,
  };
  if (floor) {
    const droppedIssues = issueCount(input.issues);
    return {
      ...head,
      run: null,
      issues: [],
      // ★ 바닥에서도 「읽었나·얼마였나」는 남는다(내용은 아니다) — 세 값 다 수이거나 닫힌 어휘다.
      plan: planRow(input.plan, false),
      log: { path: logPath, read: input.log.read, present: input.log.present, levels: [...LOG_TAIL_LEVELS], lines: [] },
      artifacts,
      reduced: 'floor',
      omittedCounts: {
        ...omittedCounts,
        ...(attempts.length > 0 ? { attempts: attempts.length } : {}),
        // ★ 이슈가 하나도 없던 후보 묶음은 「버린 것」이 아니다 — 수가 0 이면 키 자체가 없다.
        ...(droppedIssues > 0 ? { issues: droppedIssues } : {}),
      },
    };
  }
  return {
    ...head,
    run: manifest === null ? null : manifestSummary(manifest, attempts, { detailed, withProse }),
    issues: input.issues.map((entry) => issueRow(entry, withProse)),
    plan: planRow(input.plan, withProse),
    log: {
      path: logPath,
      read: input.log.read,
      present: input.log.present,
      // ★ 이 꼬리가 **어느 창**을 본 것인지 본문이 말한다(최종 리뷰 M17). `omittedCounts.logLines`
      //   는 그 창 **안에서** 잃은 줄만 세므로(§0-D3 의 필터는 세는 자리보다 앞이다), 창 이름이
      //   없으면 `logLines: 0` 이 "파일에 이것뿐이었다" 로 읽힌다 — info 만 있는 깨끗한 실행의
      //   로그가 정확히 그 모양이다(lines [], present true, logLines 0).
      levels: [...LOG_TAIL_LEVELS],
      lines: withLog ? lines.map(logRow) : [],
    },
    artifacts,
    reduced: rung,
    omittedCounts,
  };
}

/**
 * 재구성 봉투. **순수 함수**다 — 다섯 리더의 결과(`input`)만 받는다. 골든 픽스처
 * (`scripts/lib/golden-status-envelopes.mjs`)가 같은 입구로 들어오므로, 픽스처는 실물 생산자를
 * 그대로 태우면서도 디스크·시계 없이 결정적이다.
 *
 * @param {object} input `{runId, journal:{state,row}, manifest:{read,manifest}, attempts:{read,attempts},
 *   issues:[{candidateId,read,reasonCode,issues}], log:{read,path,present,lines,omitted,unparsable},
 *   paths:{runDir,manifestPath}, proof:{status,attemptId,finishedAt}|null}`
 * @param {{rung?: string, notices?: string[]}} [options] `rung` 을 주면 사다리를 타지 않고 그 단을
 *   그대로 만든다 — 카나리가 **모든 단**을 재려면 단을 고를 수 있어야 한다.
 */
export function statusRunEnvelope(input, { rung, notices = [] } = {}) {
  const rungs = typeof rung === 'string' ? [rung] : STATUS_LADDER;
  let text = null;
  let shipped = null;
  for (const name of rungs) {
    shipped = runBody(input, name);
    text = JSON.stringify(shipped);
    if (text.length <= MAX_CONTENT_CHARS) break;
  }
  const row = input.journal.row;
  const stopReason = stringOrNull(row?.stopReason ?? null);
  const reasonCode = displayCode(row?.reasonCode ?? null);
  const refsIntact = (input.attempts.attempts ?? []).every((attempt) => attempt.unreadable !== true);
  return success({
    content: text,
    confidence: confidenceOfStatus({
      manifestRead: input.manifest.read === 'ok',
      refsIntact: input.attempts.read === 'ok' && refsIntact,
      finished: shipped.state === 'finished',
    }),
    notice: notices.length > 0 ? notices.join(' ') : undefined,
    runId: input.runId,
    // ★ 봉투가 나르는 것은 **그 실행의** 종료 사유다(계약의 topLevel `stopReason` 행이 이 도구의
    //   성공 봉투를 명시한다). 닫힌 열세 값이 아니면 싣지 않는다 — 남의 파일이 적어 둔 값이
    //   계약의 어휘 자리에 들어가면 그 자리로 분기하는 소비자가 모르는 값을 본다.
    ...(STOP_REASONS.includes(stopReason) ? { stopReason } : {}),
    // 계약의 `reasonCode` 행 그대로: 성공 봉투에서는 `stopReason` 이 verified·unverified 밖일 때만.
    ...(isReasonCode(reasonCode) && !['verified', 'unverified'].includes(stopReason) ? { reasonCode } : {}),
    log: { path: input.log.path },
  });
}

/**
 * 그 실행의 저널 행 하나 — 없는 것과 못 읽은 것을 가른다.
 *
 * ★ `findRun` 을 안 쓰는 이유: 그 함수는 「행이 없다」와 「저널을 못 읽었다」를 **둘 다** `null`
 *   로 낸다. 이 도구는 그 둘을 다른 답으로 말해야 한다 — 못 읽은 저널을 「끝나지 않은 실행」으로
 *   보이게 하면 사용자는 자기 실행이 아직 도는 줄 안다.
 * ★ 저널 형식의 두 번째 독자를 만들지 않는다 — 줄을 읽는 것은 `src/learn/journal.mjs` 이고
 *   여기서는 그 리더가 낸 행에서 키를 고른다.
 */
async function journalRowOf(stateRoot, runId) {
  const read = await readRuns(stateRoot, { limit: Number.MAX_SAFE_INTEGER });
  if (!read.ok) return { state: 'unreadable', row: null, error: read.error };
  const row = read.runs.find((entry) => entry.runId === runId) ?? null;
  return { state: row === null ? 'absent' : 'ok', row, error: null };
}

async function oneRun(stateRoot, runId) {
  const manifest = await readRunManifest({ stateRoot, runId });
  if (manifest.blocked && manifest.reasonCode === REASON.state_root_not_absolute) return readerFailure(manifest);
  const tail = await readRunLogTail({ stateRoot, runId });
  const journal = await journalRowOf(stateRoot, runId);
  // ★ 매니페스트의 「그런 실행이 없다」는 **디렉터리**의 부재일 뿐이다. preflight 에서 막힌
  //   실행은 디렉터리를 만들 새 없이 끝나지만 로그 파일과 저널 행은 남긴다(Task 1·2) — 목록이
  //   보여 주는 그 실행을 단건 조회가 부정하면 Q1 과 같은 모순(로그-전용 변형)이다. 로그도
  //   저널도 침묵할 때만 「없다」가 참이고, 그때의 매니페스트는 「있는데 못 읽었다」가 아니라
  //   **애초에 없었다**(`absent`)로 말한다 — 못 읽은 것과 없는 것은 다른 답이다(§0-D4).
  if (manifest.blocked && manifest.reasonCode === REASON.status_run_not_found) {
    const logKnows = tail.ok === true && tail.present === true;
    // ★★ 저널 증인은 **쓸 수 있는 이름**일 때만 센다(최종 리뷰 M1). `runId` 는 바닥이 나르는
    //   문자열 중 읽기에서 상한을 안 받는 유일한 값이고, 그 자리를 정당화하는 산술은 리더의
    //   `RUN_ID_PATTERN`(64)을 문턱으로 삼는데 — 저널 행을 충분한 증거로 받아들이면 그 문턱이
    //   우회된다. 실측: 남의 저널이 심은 20만 자 이름 하나로 다섯 단이 모두 상한을 넘고, 봉투가
    //   본문을 `{"truncatedReport":true}` 로 조용히 갈아치운 채 ~400 KB 로 직렬화됐다.
    //   정당한 사례는 없다: 엔진은 `makeRunId` 의 이름만 쓰고, 재개는 `readRunManifest` 의 같은
    //   검사를 지나며, `orch_reward` 는 찾은 행만 다시 얹는다.
    const journalKnows = journal.state === 'ok' && usableRunId(runId);
    if (!logKnows && !journalKnows) {
      // ★★ **못 읽은** 증인을 **없는** 증인으로 접지 않는다(최종 리뷰 M2). "No run named X is on
      //   this state root" 는 확정적 부정이고, 증인이 그저 안 읽힌 것뿐이라면 거짓말이다 — 그리고
      //   그때의 다음 행동은 다르다(상태 루트를 고치는 것이지 다른 이름을 대는 것이 아니다).
      const logUnreadable = tail.ok !== true && tail.reasonCode === REASON.status_run_unreadable;
      if (journal.state === 'unreadable' || logUnreadable) {
        const unreadableNotices = journal.state === 'unreadable'
          ? [renderNotice('run_journal_unreadable', { reason: journal.error })]
          : [renderNotice('status_log_unreadable', { path: join(stateRoot, 'logs', `${runId}.jsonl`) })];
        return readerFailure(fail(REASON.status_run_unreadable), unreadableNotices);
      }
      return readerFailure(manifest);
    }
  }
  const readManifest = manifest.ok === true;
  const manifestRead = readManifest ? 'ok'
    : manifest.reasonCode === REASON.status_run_not_found ? 'absent' : 'unreadable';
  const attempts = readManifest ? await readRunAttempts({ stateRoot, runId }) : { blocked: true, attempts: [] };
  const lanes = readManifest ? manifest.manifest.laneBindings.map((entry) => entry.laneId) : [];
  const issues = [];
  for (const candidateId of lanes) {
    const got = await readVerifierIssues({ stateRoot, runId, candidateId });
    issues.push(got.ok === true
      ? { candidateId, read: 'ok', reasonCode: null, issues: got.issues.map((issue) => ({ ...issue })) }
      : { candidateId, read: 'unreadable', reasonCode: got.reasonCode, issues: [] });
  }
  // ★ 매니페스트를 못 읽었으면 정본도 못 찾는다 — 그 ref 가 사는 자리가 매니페스트다.
  //   「안 물어봤다」와 「없다」를 가르는 값이 `read` 이고, 그래서 세 값이다.
  const planRead = readManifest ? await readRunPlan({ stateRoot, runId }) : null;
  const plan = planRead === null
    ? { read: 'absent', reasonCode: null, plan: null }
    : planRead.ok === true
      ? { read: planRead.plan === null ? 'absent' : 'ok', reasonCode: null, plan: planRead.plan }
      : { read: 'unreadable', reasonCode: planRead.reasonCode, plan: null };
  const notices = [];
  if (journal.state === 'unreadable') notices.push(renderNotice('run_journal_unreadable', { reason: journal.error }));
  const log = tail.ok === true
    ? { read: 'ok', path: tail.path, present: tail.present, lines: tail.lines.map((line) => ({ ...line })), omitted: tail.omitted, unparsable: tail.unparsable }
    : { read: 'unreadable', path: join(stateRoot, 'logs', `${runId}.jsonl`), present: false, lines: [], omitted: 0, unparsable: 0 };
  if (log.read === 'unreadable') notices.push(renderNotice('status_log_unreadable', { path: log.path }));
  // ★ 매니페스트와 **독립**이다: 증명은 실행 기록 밖(`proofs/<runId>/`)에 살고, 매니페스트를
  //   못 읽는 실행도 증명은 읽힐 수 있다. 못 읽으면 `null` 이다 — 이 도구는 읽기만 하고,
  //   증명 기록의 판독 실패를 실행의 삼중값으로 번역하지 않는다.
  const proofRead = await readProofRecord({ stateRoot, runId });
  const proof = proofRead?.ok === true && proofRead.record !== null
    ? { status: proofRead.record.status, attemptId: proofRead.record.attemptId, finishedAt: proofRead.record.finishedAt }
    : null;
  return statusRunEnvelope({
    runId,
    journal,
    proof,
    manifest: { read: manifestRead, manifest: readManifest ? manifest.manifest : null },
    attempts: { read: attempts.ok === true ? 'ok' : 'unreadable', attempts: attempts.attempts ?? [] },
    issues,
    plan,
    log,
    paths: { runDir: join(stateRoot, 'runs', runId), manifestPath: join(stateRoot, 'runs', runId, 'manifest.json') },
  }, { notices });
}

/**
 * `orch_status` 핸들러. 인자가 없으면 최근 목록, `run_id` 가 있으면 그 실행 하나의 재구성이다.
 *
 * ★ 던지지 않는다 — 실패는 전부 봉투다(리더가 이미 그 규율을 지킨다).
 * ★ `runs` 는 `run_id` 와 함께 오면 **의미가 없다**(WS0 §1.3). 알림을 달지 않는 이유는
 *   `validateArgs` 가 기본값(10)을 언제나 채우기 때문이다 — 준 것과 기본값을 구별할 수 없으므로
 *   알림을 달면 **모든** 단건 조회에 거짓 알림이 붙는다. 스킬 문서가 그 사실을 적는다.
 */
export async function runOrchStatus(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();
  return value.run_id === undefined ? recentRuns(stateRoot, value) : oneRun(stateRoot, value.run_id);
}
