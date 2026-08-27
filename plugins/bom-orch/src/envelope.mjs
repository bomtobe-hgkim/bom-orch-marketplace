/**
 * 모든 MCP 도구가 내는 결과 봉투와, 저수준 Server 가 안 해주는 손수 인자 검증.
 *
 * ★ 저수준 Server 는 `inputSchema` 를 참조하지 않는다 — 스키마를 선언해도 검증은
 *   안 해준다. 그래서 여기서 손수 검증하고, 모든 실패가 recovery 를 담은 구조화
 *   봉투로 나가게 한다. `validateArgs` 는 순수 함수라 서버 없이도 테스트할 수 있다.
 *
 * ★ `recovery` 는 실패 봉투에 반드시 있다 — 호출자가 모델이므로 다음 행동을
 *   알려줘야 한다. "잘못됐다"만 있는 봉투는 모델을 멈추게 한다.
 *
 * ★ `notice` 를 `content` 에 붙이지 않는다 — 결과에 25k 토큰 상한이 있어서 긴
 *   답변의 꼬리가 잘린다. 꼬리에 붙인 경고는 정확히 그것이 중요한 경우(큰 답변)에
 *   사라진다.
 *
 * ★ `structuredContent` 를 쓰지 않는다 — 하위 호환을 위해 텍스트도 같이 실으라는
 *   스펙 권고를 따르면 페이로드가 두 배가 되어 25k 상한과 충돌한다. 텍스트에 JSON 을
 *   담는다.
 */

import { REASON, isReasonCode } from './reason-codes.mjs';
import { fail, renderNotice, safeRender } from './reason-text.mjs';
import { GENERIC_RECOVERY, errorText } from './util/errors.mjs';
import { VERSION_IDENTITY_JSON, withVersionIdentity } from './version.mjs';

/**
 * 봉투가 낼 수 있는 status 전부.
 *
 * ★ `cancelled` 은 **생산자와 같은 커밋**에 들어왔다(WS3 §0-C3, 계약 `topLevel.status` 행의
 *   자기 약속). WS2 까지는 조악값 표(`STATUS_BY_STOP_REASON`)에만 있고 여기에는 없었다 —
 *   `run_cancelled` 에 생산자가 없었기 때문이다. 목록에 없는 status 는 `failure()` 가 조용히
 *   `failed` 로 접으므로, 그 하루가 더 갔다면 취소가 실패로 나갔을 것이다.
 * ★ 이 목록 = `distinct(STATUS_BY_STOP_REASON 값) + invalid` 이고, 그 등식을
 *   `test/run-faults.test.mjs` 가 잰다. `invalid` 만 파생 밖인 이유는 인자 검증이 실행에
 *   사유 코드가 생기기 **전**에 일어나기 때문이다.
 */
export const STATUSES = Object.freeze(['succeeded', 'failed', 'invalid', 'blocked', 'deadline_exceeded', 'cancelled']);

export const CONFIDENCE = Object.freeze(['verified', 'unverified', 'disputed']);

/**
 * 25,000 **토큰** 상한을 문자 수로 근사한다.
 *
 * 토큰/문자 비율은 언어마다 크게 다르다 — 영어는 흔히 토큰당 3~4 문자(BPE 어휘에
 * 흔한 단어·조각이 이미 들어 있다)지만, 한국어는 음절 하나가 다중 바이트 UTF-8
 * 시퀀스라 어휘에 없는 조합이면 바이트 단위로 쪼개져 음절당 토큰이 훨씬 많이 든다.
 * 실측 경험상 한국어 텍스트는 토큰당 1~2 문자, 드물게 그보다도 나쁜 경우가 있다.
 *
 * 이 상수는 "최악의 경우(문서 전체가 한국어)"를 가정해 보수적으로 잡는다: 문자당
 * 2.5 토큰을 쓴다고 가정하면 25,000 / 2.5 = 10,000 자. 영어 위주 답변은 이 상한보다
 * 훨씬 많은 문자를 담고도 25k 토큰 안에 들 것이므로, 잘라내는 쪽이 상한을 넘기는
 * 쪽보다 안전하다.
 */
export const MAX_CONTENT_CHARS = 10_000;

const TRUNCATED_REPORT = '{"truncatedReport":true}';

/**
 * notice 의 상한 — 개별과 합계 둘 다. `src/run-faults.mjs` 의 `joinNotices` 와 발췌·알림을 붙이는 자리가
 * 같은 두 수를 쓴다(계약: `contract/envelope.json` 의 `notice` 행).
 *
 * ★ 왜 필요한가(실측). `content` 는 이 파일이 10,000자로 깎는데 `notice` 를 깎는 코드는 저장소
 *   어디에도 없었다. 진짜 저장소로 재니 `content` 800자 : `notice` 51,133자 = 64배가 나왔고 봉투
 *   하나가 52KB 로 나갔다 — `.gitignore` 에 `*.log` 하나가 있고 워커가 로그 2,000개를 남기면 그
 *   목록이 그대로 문장에 박힌다. 길이를 정하는 쪽이 우리가 아니라 델리게이트다. 호스트가 결과를
 *   자르면 꼬리의 `patch` 경로·`recovery` 가 먼저 사라진다.
 */
export const NOTICE_CHARS = 400;
export const NOTICES_TOTAL_CHARS = 1_600;

/**
 * 벤더 stderr 발췌 하나의 모양(WS2 §3.4). `source` 는 `'stderr'` 하나뿐이다 — **모델 stdout 은
 * 발췌가 될 수 없다**(불변식 4). 붙는 조건은 카탈로그의 `excerpt:true` 뿐이고 그 집합은
 * `src/providers/error-catalog.mjs EXCERPT_ALLOWED` 가 정한다.
 *
 * ★ 왜 봉투 모듈이 스키마를 갖는가: 발췌를 **만드는** 쪽과 **싣는** 쪽이 서로 다른 모양을 믿으면
 *   어긋난 발췌가 조용히 실리거나 조용히 사라진다. 술어 하나를 양쪽이 부른다.
 */
export const EXCERPT_SCHEMA = Object.freeze({
  keys: Object.freeze(['source', 'vendor', 'bytes', 'truncated', 'text']),
  source: 'stderr',
  vendors: Object.freeze(['claude', 'codex', 'git']),
  maxTextChars: 600,
  // 봉투는 개수를 자르지 않는다(무엇이 잘렸는지 적을 자리가 최상위에 없다) — 붙이는 쪽이 센다.
  maxItems: 3,
});

/**
 * 스키마에 **정확히** 맞는가. 키가 하나 더 있거나 모자라도 거짓이다 — 발췌는 추측하지 않는다.
 *
 * ★ 던지는 getter 는 "맞지 않는다" 로 답한다. 술어가 던지면 부르는 쪽마다 try/catch 를 다시 써야
 *   하고, 한 곳이 빠뜨리면 발췌 하나 때문에 봉투 전체가 사라진다.
 * ★ 이 술어는 **읽기가 여러 번**이다(키 목록 + 다섯 값). 그래서 봉투는 호출자의 객체를 여기에
 *   직접 넘기지 않고, 한 번씩만 읽어 뜬 스냅샷을 넘긴다 — `snapshotExcerpt` 의 WHY 를 보라.
 */
export function isExcerpt(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === EXCERPT_SCHEMA.keys.length &&
      keys.every((key) => typeof key === 'string' && EXCERPT_SCHEMA.keys.includes(key)) &&
      value.source === EXCERPT_SCHEMA.source && EXCERPT_SCHEMA.vendors.includes(value.vendor) &&
      Number.isSafeInteger(value.bytes) && value.bytes >= 0 && typeof value.truncated === 'boolean' &&
      typeof value.text === 'string' && value.text.length <= EXCERPT_SCHEMA.maxTextChars;
  } catch {
    return false;
  }
}

/** 등재된 코드만 봉투에 실린다 — `reasonCode` 는 소비자가 분기하는 **닫힌 어휘**다(WS2 §2). */
function normalizeReasonCode(reasonCode) {
  return isReasonCode(reasonCode) ? reasonCode : undefined;
}

/**
 * 로그는 경로 하나다. 모양이 다르면 키 자체를 만들지 않는다 — 없는 로그를 있다고 말하지 않는다.
 *
 * ★ 경로도 **한 번만** 읽는다(`snapshotExcerpt` 와 같은 규칙): 검사한 경로와 실리는 경로가 다른
 *   값일 수 있으면 봉투의 `log.path` 는 아무것도 증명하지 못한다. 던지는 getter 는 키를 없앨 뿐
 *   봉투를 무너뜨리지 않는다.
 */
function normalizeLog(log) {
  if (log === null || typeof log !== 'object' || Array.isArray(log)) return undefined;
  try {
    const keys = Reflect.ownKeys(log);
    if (keys.length !== 1 || keys[0] !== 'path') return undefined;
    const { path } = log;
    return typeof path === 'string' && path !== '' ? { path } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 발췌 하나를 **다섯 값을 한 번씩만 읽어** 새 리터럴로 뜬다. 검증도 적재도 이 스냅샷으로 한다.
 *
 * ★ 실측된 결함. 예전에는 호출자의 객체를 참조로 검증하고 그 **참조를 그대로** 실었다. 검증하는
 *   두 번의 읽기에만 `'ok'` 를 주고 그 뒤로 다른 값을 주는 getter 를 만드니, 960자 모델 산문이
 *   `source:'stderr'` 라벨을 달고 봉투로 나갔다 — 불변식 4(모델 산문은 봉투에 들어가지 않는다)가
 *   getter 하나로 뚫렸다. 검증한 바이트와 실리는 바이트가 같으려면 읽기가 **한 번**이어야 한다.
 * ★ 키 순서도 여기서 정해진다(`EXCERPT_SCHEMA.keys` 순서). 입력의 키 순서가 봉투 바이트를 흔들지
 *   않는다 — 같은 발췌가 자리마다 다른 JSON 이 되면 골든과 해시가 이유 없이 갈린다.
 */
function snapshotExcerpt(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== EXCERPT_SCHEMA.keys.length ||
      !keys.every((key) => typeof key === 'string' && EXCERPT_SCHEMA.keys.includes(key))) return undefined;
    const { source, vendor, bytes, truncated, text } = value;
    return Object.freeze({ source, vendor, bytes, truncated, text });
  } catch {
    return undefined;
  }
}

/**
 * 스키마에 맞는 발췌만 남긴다. 어긋난 것은 버리고 **아무것도 더하지 않는다** — 버렸다는 알림을
 * 여기서 붙이면 모든 봉투가 생산자 버그를 사용자에게 설명하게 된다. 모양은 생산자 쪽 테스트가
 * 증명하고, 이 자리는 어긋난 것이 계약 밖으로 나가지 못하게만 한다.
 *
 * ★ 순서가 계약이다: **스냅샷 → 검증 → 적재**. 검증한 것과 실리는 것이 같은 객체여야 한다.
 *   배열 자체가 적대적이어도(프록시) 봉투는 만들어진다 — 지금까지 모은 것만 싣는다.
 */
function normalizeExcerpts(excerpts) {
  if (!Array.isArray(excerpts)) return undefined;
  const kept = [];
  try {
    for (const value of excerpts) {
      const snapshot = snapshotExcerpt(value);
      if (snapshot !== undefined && isExcerpt(snapshot)) kept.push(snapshot);
    }
  } catch {
    // 아래로 떨어진다 — 모은 것이 없으면 키 자체가 없다.
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * `error` 자리의 마지막 폴백 — `failure({})` 처럼 아무 사유도 오지 않은 봉투가 쓰는 문장이다.
 * 이름을 붙이는 이유는 `??` 사슬의 마지막 가지가 무엇을 뜻하는지 읽히게 하는 것 하나다: 거기
 * 닿는 값은 `undefined`·`null`·`''` 뿐이므로 `errorText(error)` 라고 쓰면 **인자를 쓰는 것처럼**
 * 보인다. 값은 `errorText` 의 미상 문구 하나다(WS2 Task 16 이 영어로 옮겼다).
 */
const UNKNOWN_ERROR_TEXT = errorText(undefined);

/**
 * 강등 사실을 알리는 문구. 렌더가 이미 한 번 실패한 자리라 이 렌더도 던질 수 있다고 보고 감싼다
 * (세척 훅은 밖에서 꽂힌다) — 봉투 생성자는 **어떤 경로로도** 던지지 않는다. 알림을 못 만들면
 * 알림만 없다.
 */
function degradedNotice(code) {
  try {
    return renderNotice('envelope_render_degraded', { reasonCode: code });
  } catch {
    return undefined;
  }
}

function normalizeConfidence(confidence) {
  return CONFIDENCE.includes(confidence) ? confidence : 'unverified';
}

function validWholeJson(value) {
  if (typeof value !== 'string' || value.length > MAX_CONTENT_CHARS) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeRunContent(content, contentFallback) {
  if (contentFallback === undefined) {
    return typeof content === 'string' && content.length <= MAX_CONTENT_CHARS
      ? { content, replaced: false }
      : { content: TRUNCATED_REPORT, replaced: true };
  }
  if (validWholeJson(content)) return { content, replaced: false };
  if (validWholeJson(contentFallback)) return { content: contentFallback, replaced: true };
  return { content: TRUNCATED_REPORT, replaced: true };
}

/**
 * 성공 봉투. `confidence:"disputed"` 는 `status:"succeeded"` 와 상호배타다(★) —
 * 검증이 두 번 실패한 결과가 succeeded 로 나가면, status 만 보는 흔한 통합 패턴이
 * 그것을 깨끗한 성공으로 읽는다. 계획 1 에는 아직 verifier 가 없어 disputed 를
 * 만드는 코드가 없지만, 봉투를 만드는 곳이 늘어난 뒤에 이 불변식을 넣으면 이미
 * 새고 있을 것이므로 지금 박아둔다.
 *
 * ## ★ 어느 결과가 어느 어휘로 나가는가 (계획 2 Task 5 에서 정한 규칙)
 *
 * 두 모듈의 어휘가 갈리면 같은 사건이 호출부마다 다르게 읽힌다. `src/engine.mjs` 가
 * 쓰는 규칙을 여기 함께 적어 둔다:
 *
 *   disputed(→ failed)  검사가 "사람이 봐야 한다"고 판정했다.
 *                       · 패치 스코프 플래그(`src/patch-scope.mjs`)
 *                       · 델리게이트가 테스트 정의를 바꿔 **검증이 거부된** 실행.
 *                         설계 §12.-1 아키텍처 전체가 잡으려고 만들어진 사건이라,
 *                         succeeded 로 내면 §7 보상이 "정의를 고치면 성공"을 배운다.
 *   unverified          결과는 냈지만 그 판정을 믿을 근거가 약하다.
 *                       · 테스트가 실패했다 · 못 돌렸다 · 베리파이어가 소스를 고쳤다
 *                       · 데드라인으로 잘렸다 · 워커가 아무것도 안 했다
 *   verified            테스트가 실제로 통과했고 그 판정을 흐리는 사실이 없다.
 *
 * status 만 보는 호출부를 위해 엔진은 `stopReason` 을 봉투 **최상위**에도 싣는다.
 *
 * ★ 성공 봉투에도 `reasonCode`·`log` 는 실린다(WS2). 성공에 코드가 붙는 자리는 `stopReason` 이
 *   `verified`/`unverified` 밖일 때다(`tie`·`dry_run` 등). 발췌는 실리지 않는다 — 발췌는 실패의
 *   증거이고, 성공 봉투에 벤더 stderr 를 얹으면 그 경로가 조용히 넓어진다.
 */
export function success({
  content, contentFallback, confidence, notice, recovery, runId, stopReason, reasonCode, log,
} = {}) {
  const finalConfidence = normalizeConfidence(confidence);
  const finalContent = normalizeRunContent(content, contentFallback).content;
  const finalNotice = typeof notice === 'string' && notice !== '' ? notice : undefined;

  const status = finalConfidence === 'disputed' ? 'failed' : 'succeeded';
  const env = withVersionIdentity({ status, content: finalContent, confidence: finalConfidence });
  if (typeof recovery === 'string' && recovery !== '') env.recovery = recovery;
  if (finalNotice !== undefined) env.notice = finalNotice;
  if (typeof runId === 'string') env.runId = runId;
  if (typeof stopReason === 'string') env.stopReason = stopReason;
  const successCode = normalizeReasonCode(reasonCode);
  if (successCode !== undefined) env.reasonCode = successCode;
  const successLog = normalizeLog(log);
  if (successLog !== undefined) env.log = successLog;

  // disputed 로 강등됐다면 이건 실패 봉투이기도 하다 — recovery 가 있어야 한다.
  if (status !== 'succeeded' && (typeof env.recovery !== 'string' || env.recovery === '')) {
    env.recovery = GENERIC_RECOVERY;
  }
  return env;
}

/**
 * 실패 봉투. recovery 는 절대 비어 있지 않다(★) — 없으면 일반 문구로 채운다.
 * status 는 고정 어휘([[STATUSES]])만 나간다 — 모르는 값은 조용히 흘려보내지 않고
 * `failed` 로 강등한다.
 *
 * ## ★ `reasonCode` 를 주면 문구가 레지스트리에서 온다 (WS2 §7.2)
 *
 * 우선순위는 셋이 서로 다르고, 다른 이유가 있다:
 *   - `error`·`recovery`: **명시한 인자가 이긴다.** 아직 `fail(REASON.x)` 로 옮기지 못한 호출부가
 *     자기 문장을 들고 오기 때문이다. 안 주면 `safeRender(code, params)` 가 채운다. `error:''` 는
 *     `recovery:''` 와 같게 **없는 것**이다 — 빈 문자열이 이기면 레지스트리 문장이 지워진다.
 *   - `stopReason`: **코드가 이긴다.** 한 코드가 자리마다 다른 조악값으로 나가는 것이 WS2 §2 가
 *     없애려는 결함 그 자체다 — 그래서 여기서는 인자를 받아 두고도 쓰지 않는다(코드가 있을 때만).
 *   - `reasonCode`: 등재된 코드만 실린다. 오타는 키 자체가 없다 — 닫힌 어휘에 실린 낯선 값은
 *     소비자의 어느 가지에도 안 걸리면서 "코드가 있다" 고 주장한다.
 *
 * ★ **이 함수는 던지지 않는다.** 인자가 모자란 렌더는 `safeRender` 가 문구만 강등하고
 *   (`RENDER_FALLBACK_MESSAGE` + 일반 회복), `reasonCode`·`stopReason` 은 정확한 값 그대로 나간다.
 *   강등했다는 사실은 `envelope_render_degraded` 알림으로 남긴다 — 조용히 일반 문장으로 바꾸면
 *   생산자 결함이 평범한 실패로 위장한다. 예전에는 여기서 그대로 던졌고, 그러면 봉투를 만들다 난
 *   오류가 원래 실패를 통째로 지운 채(코드도 회복도 없이) 다른 문장으로 밖에 나갔다.
 *   같은 이유로 적대적 getter(발췌·로그)도 항목만 버릴 뿐 봉투를 무너뜨리지 못한다.
 */
export function failure({
  status, reasonCode, params, error, recovery, excerpts, log,
  content, contentFallback, confidence, notice, runId, stopReason,
} = {}) {
  const code = normalizeReasonCode(reasonCode);
  const rendered = code === undefined ? null : safeRender(code, params ?? {});
  const finalStatus = STATUSES.includes(status) && status !== 'succeeded' ? status : 'failed';
  // ★ `''` 는 `recovery` 와 **같은 등급으로** 없는 것이다. 빈 문자열을 값으로 받아들이면 레지스트리가
  //   렌더한 문장을 지우고 그 자리에 미상 문구가 실린다 — 코드가 있는데도 "알 수 없는 오류" 인 봉투.
  const givenError = error === undefined || error === null || error === '' ? null : errorText(error);
  const givenRecovery = typeof recovery === 'string' && recovery !== '' ? recovery : null;
  const finalRecovery = givenRecovery ?? rendered?.recovery ?? GENERIC_RECOVERY;
  // ★ 강등 알림은 강등된 문구가 **실제로 실렸을 때만** 붙는다(WS2 Task 14 수정 I1). 호출부가
  //   두 문장을 다 들고 왔으면 폴백 문장도 일반 회복도 봉투에 없다 — 그때 "일반 설명을 썼다" 고
  //   알리면 알림이 거짓말을 하고, 사용자는 자기 봉투에 없는 결함을 읽는다. 한쪽만 들고 왔으면
  //   나머지 한쪽은 강등본이므로 알림은 그대로 붙는다.
  const degradedShipped = rendered?.degraded === true && (givenError === null || givenRecovery === null);
  const normalized = content !== undefined || contentFallback !== undefined
    ? { content: normalizeRunContent(content, contentFallback).content }
    : {};
  const envelope = withVersionIdentity({ status: finalStatus });
  if (CONFIDENCE.includes(confidence)) envelope.confidence = confidence;
  Object.assign(envelope, normalized);
  envelope.error = givenError ?? rendered?.error ?? UNKNOWN_ERROR_TEXT;
  envelope.recovery = finalRecovery;
  // 강등 알림은 이미 있던 notice **뒤에** 붙는다 — 호출부의 알림을 지우지 않는다.
  const notices = [
    typeof notice === 'string' && notice !== '' ? notice : undefined,
    degradedShipped ? degradedNotice(code) : undefined,
  ].filter((part) => part !== undefined);
  if (notices.length > 0) envelope.notice = notices.join(' ');
  if (typeof runId === 'string') envelope.runId = runId;
  const finalStopReason = rendered === null ? stopReason : rendered.stopReason;
  if (typeof finalStopReason === 'string') envelope.stopReason = finalStopReason;
  if (code !== undefined) envelope.reasonCode = code;
  const logRef = normalizeLog(log);
  if (logRef !== undefined) envelope.log = logRef;
  const keptExcerpts = normalizeExcerpts(excerpts);
  if (keptExcerpts !== undefined) envelope.excerpts = keptExcerpts;
  return envelope;
}

/** JSON.stringify 가 성공했을 때 결과가 실제 문자열인지 본다 (undefined 반환 등을 걸러낸다). */
function stringifyOrThrow(value) {
  const text = JSON.stringify(value);
  // 내부 불변식이다 — 이 문장은 봉투에도 stdout 에도 실리지 않고 바로 아래 catch 가 삼킨다.
  // 그래서 레지스트리 코드가 아니라 여기 영어 한 줄이다.
  if (typeof text !== 'string') throw new Error('serialization did not produce a string');
  return text;
}

/**
 * `serializeToolResult` 의 모든 단계가 실패했을 때 쓰는, `JSON.stringify` 를 아예 거치지 않는
 * 손으로 만든 고정 문자열. 이 마지막 단계가 던지면 더 이상 감쌀 곳이 없으므로 **절대 실패할 수
 * 없는 형태**여야 한다 — `REASON_TEXT` 를 부르지 않는 것도 그래서다(렌더는 던질 수 있다).
 * 문구 정본 밖의 리터럴이 남는 유일한 자리이고, 그 사실을 `contract/envelope.json` 이 적어 둔다.
 */
export const HARD_FALLBACK_TEXT =
  `{"status":"failed",${VERSION_IDENTITY_JSON},"error":"serialization failed","recovery":"Retry the call; if it recurs, report the reasonCode and the run log."}`;

/**
 * 봉투를 MCP 도구 결과 형태로 직렬화한다.
 *
 * ★ JSON.stringify 는 거대한 결과에 ERR_STRING_TOO_LONG 을 던질 수 있고, 순환
 *   참조에도 던진다. 그 지점은 도구 핸들러의 try/catch **밖**이다(직렬화는 반환
 *   후에 일어난다) — 그래서 우리가 직접 직렬화하고 실패하면 폴백 봉투를 낸다.
 *   폴백 직렬화도 실패할 수 있으므로 그때는 손으로 만든 고정 문자열을 쓴다.
 *
 * structuredContent 는 절대 싣지 않는다 — 하위 호환을 위해 텍스트도 같이 실으라는
 * 스펙 권고를 따르면 페이로드가 두 배가 되어 25k 상한과 충돌한다.
 */
export function serializeToolResult(envelope) {
  try {
    const finalEnvelope = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
      ? withVersionIdentity(envelope)
      : envelope;
    return { content: [{ type: 'text', text: stringifyOrThrow(finalEnvelope) }] };
  } catch {
    try {
      const fallback = failure({ status: 'failed', reasonCode: REASON.run_result_unserializable });
      return { content: [{ type: 'text', text: stringifyOrThrow(fallback) }] };
    } catch {
      return { content: [{ type: 'text', text: HARD_FALLBACK_TEXT }] };
    }
  }
}

// ── 손수 검증 ─────────────────────────────────────────────────────────────

/** 아주 단순한 편집 거리(Levenshtein) — 오타 제안에는 이 정도면 충분하다. */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) table[i][0] = i;
  for (let j = 0; j < cols; j += 1) table[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
    }
  }
  return table[rows - 1][cols - 1];
}

/** 모르는 키에 대해 스펙 중 가장 가까운 이름을 고른다. 후보가 없으면 null. */
function closestKey(key, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 손수 인자 검증. 순수 함수 — I/O 도 부작용도 없다.
 *
 * `Object.hasOwn` 으로만 읽어 프로토타입 체인의 값을 안 본다. `Object.keys` 로 뽑은
 * 키 목록도(JSON.parse 가 만드는 값은 `__proto__` 라는 이름도 평범한 own 프로퍼티다)
 * 안전하게 다룰 수 있다 — 우리가 직접 `target[key] = value` 형태로 스펙 밖의 키를
 * 아무 객체에나 대입하지 않기 때문이다.
 *
 * 모르는 키는 조용히 버리지 않고 거부한다 — 오타 난 인자를 무시하면 호출자는 자기
 * 요청이 반영된 줄 안다. 가장 가까운 스펙 키를 recovery 에 제안한다.
 */
export function validateArgs(args, spec) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return fail(REASON.config_arguments_invalid);
  }

  const specObj = spec && typeof spec === 'object' ? spec : {};
  const specKeys = Object.keys(specObj);
  const argKeys = Object.keys(args);

  const unknown = argKeys.filter((key) => !specKeys.includes(key));
  if (unknown.length > 0) {
    const bad = unknown[0];
    // ★ 세 갈래를 **코드로** 가른다. 예전에는 한 문장 안에서 "허용된 인자가 없습니다" 와
    //   "혹시 X 를 의도했나요?" 를 삼항으로 갈아 끼웠는데, 그러면 문구가 조건을 담고 조건은
    //   문구에만 산다. 이제 조건이 코드에 있고 문구는 정본이 정한다.
    if (specKeys.length === 0) return fail(REASON.config_arguments_not_accepted, { name: bad });
    const suggestion = closestKey(bad, specKeys);
    const allowed = specKeys.join(', ');
    return suggestion === null
      ? fail(REASON.config_argument_unknown, { name: bad, allowed })
      : fail(REASON.config_argument_misspelled, { name: bad, suggestion, allowed });
  }

  const value = {};
  for (const key of specKeys) {
    const fieldSpec = specObj[key] ?? {};
    const provided = Object.hasOwn(args, key);

    if (!provided) {
      if (fieldSpec.required) return fail(REASON.config_argument_required_missing, { name: key });
      if (Object.hasOwn(fieldSpec, 'default')) value[key] = fieldSpec.default;
      continue;
    }

    const raw = args[key];
    const expectedType = fieldSpec.type;

    // `array` 는 `typeof` 로 표현할 수 없다 — `typeof []` 는 'object' 라서 `{}` 도 통과한다.
    // 원소 타입까지 여기서 본다. 안 보면 핸들러마다 같은 검사를 다시 쓰게 되고, 그러면
    // 어느 핸들러가 빠뜨렸는지 알 수 없다.
    if (expectedType === 'array') {
      if (!Array.isArray(raw)) return fail(REASON.config_argument_type_invalid, { name: key, expected: 'array' });
      const itemType = fieldSpec.items;
      if (typeof itemType === 'string') {
        const badIndex = raw.findIndex((item) => typeof item !== itemType);
        if (badIndex !== -1) {
          return fail(REASON.config_argument_item_type_invalid, { name: key, index: badIndex, expected: itemType });
        }
      }
      value[key] = raw;
      continue;
    }

    if (typeof expectedType === 'string' && typeof raw !== expectedType) {
      return fail(REASON.config_argument_type_invalid, { name: key, expected: expectedType });
    }

    // ★ 수치 제약. `typeof raw === 'number'` 는 NaN·Infinity 도 통과시킨다 — 그 둘은 어떤
    //   범위 비교에서도 거짓이라 아래 검사가 함께 잡는다. 이 검사가 없으면 도구 스펙이
    //   선언한 `minimum`/`maximum`/정수 제약이 선언만 남고, 값은 한 층 아래에서 뒤늦게
    //   거부된다(왕복 한 번을 버린다) 또는 그냥 통과한다.
    // ★ 위반 하나에 코드 하나다. 예전에는 넷을 한 문장으로 접고 회복에 `정수 · 1 이상 · 10 이하`
    //   같은 **조각 목록**을 지어 붙였는데, 그러면 조각이 산문이라 정본을 우회하고 호출자는
    //   자기가 어느 규칙을 어겼는지 목록에서 찾아야 한다. 순서는 좁은 것부터다.
    // ★ 값은 호출자가 고른 것이라 `String(raw)` 로 문장에 넣지 않는다 — 규칙과 근거는
    //   `src/util/errors.mjs errorText` 머리말 하나에 적혀 있다.
    if (expectedType === 'number') {
      if (!Number.isFinite(raw)) return fail(REASON.config_argument_not_finite, { name: key, value: errorText(raw) });
      if (fieldSpec.integer === true && !Number.isInteger(raw)) {
        return fail(REASON.config_argument_not_integer, { name: key, value: raw });
      }
      if (typeof fieldSpec.min === 'number' && raw < fieldSpec.min) {
        return fail(REASON.config_argument_below_minimum, { name: key, value: raw, min: fieldSpec.min });
      }
      if (typeof fieldSpec.max === 'number' && raw > fieldSpec.max) {
        return fail(REASON.config_argument_above_maximum, { name: key, value: raw, max: fieldSpec.max });
      }
    }

    if (Array.isArray(fieldSpec.enum) && !fieldSpec.enum.includes(raw)) {
      return fail(REASON.config_argument_not_in_enum, {
        name: key,
        value: errorText(raw),
        allowed: fieldSpec.enum.join(', '),
      });
    }

    value[key] = raw;
  }

  return { ok: true, value };
}
