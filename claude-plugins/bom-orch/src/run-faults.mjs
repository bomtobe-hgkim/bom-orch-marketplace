/**
 * 실행 하나가 **실패를 말하는 방식** — 결함 판정 · 발췌 · 실패 봉투 · 알림 합류 · 실행 로그.
 *
 * WS2 Task 11 이 `src/engine.mjs` 에서 그대로 옮겼다(바이트 보존 이동). 옮긴 이유는 크기가
 * 아니라 **경계**다: 아래 여섯 덩어리는 오케스트레이션의 흐름을 하나도 모른다. 레인이 몇 개인지,
 * 어떤 단계가 남았는지, 워크트리가 어디 있는지와 무관하게 "이 결과가 무슨 실패인가" 하나만
 * 답한다. 엔진에 두면 그 답이 흐름 제어와 같은 파일에서 자라고, 실제로 그렇게 자랐다(Task 10 이
 * 엔진에 +370 줄을 넣은 자리의 대부분이 이 여섯이다).
 *
 *   1. `joinNotices` — 알림 여럿 → 봉투 한 줄(개별 400 · 합계 1,600 상한, dedupe).
 *   2. `resultReasonCode`/`artifactAuthorityLost` — 하위 모듈 결과의 **등재된** 코드를 읽는다.
 *   3. `providerFault` 군 — 벤더 결과에서 실패 사실 객체를 꺼내고 라벨된 stderr 발췌를 붙인다.
 *   4. `artifactBlocked`/`runDeadline`/`carriedFailure`/`handoffNotice` — 실패 봉투와 알림.
 *   5. `createFaultRegistry` — 실행 하나가 본 결함 장부(주입된 `logLine`·`redact` 를 닫는다).
 *   6. `createRunLog` — 실행별 로그 핸들과 세척기 설치·반납, 그리고 봉투 공통 extras.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다 — 그러면 순환이 생기고, 순환이 생기는
 *   순간 "엔진을 모른다" 는 위 논거가 거짓이 된다. 반대 방향(engine → run-faults)만 있다.
 */
import { homedir } from 'node:os';
import { confidenceOfRun } from './confidence.mjs';
import { RUN_LOG_MAX_BYTES, openRunLog } from './diag.mjs';
import { EXCERPT_SCHEMA, NOTICES_TOTAL_CHARS, NOTICE_CHARS, failure } from './envelope.mjs';
import { EXCERPT_ALLOWED } from './providers/error-catalog.mjs';
import { REASON, isPoisonCode, isReasonCode, normalizeLegacyReasonCode, stopReasonOf } from './reason-codes.mjs';
import { MAX_BLOCKING_ISSUES } from './verdict.mjs';
import { getRedactor, renderNotice, setRedactor } from './reason-text.mjs';
import { makeRedactor } from './redact.mjs';
import { GENERIC_RECOVERY, errorText } from './util/errors.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { ownDataValue } from './util/objects.mjs';
import { clipPlain, compareUtf8 } from './util/strings.mjs';

/**
 * `limit` 안에 **말줄임표까지** 넣어 자른다. `clipPlain` 의 `limit` 은 자르기 전 예산이라 결과가
 * `limit + 1` 자가 된다 — notice 한 줄에서는 그 한 글자가 상한을 넘긴 값이므로 여기서 한 칸을 뺀다.
 * 상한과 **정확히 같은** 길이는 자르지 않는다: 자를 이유가 없는 문자열을 자르면 정보를 공짜로 버린다.
 */
function clipNoticeLine(value, limit) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length <= limit ? text : clipPlain(text, limit - 1);
}

/**
 * 쌓인 notice 를 봉투에 실을 한 덩어리로 합친다. 세 규칙이 이 순서로 걸린다(계약:
 * `contract/envelope.json` 의 `notice` 행, 상한 두 개는 `src/envelope.mjs` 가 갖는다).
 *
 * 1. **개별 `NOTICE_CHARS`.** 예전에는 상수만 있고 아무도 적용하지 않았다 — 첫 notice 는 길이와
 *    무관하게 통과했고, 그래서 봉투 하나가 52KB 로 나간 실측이 있다.
 * 2. **동일 문구 dedupe.** 같은 사건이 일곱 번 나면 같은 문장이 일곱 벌 실렸다. 접고 ` (×N)` 을
 *    적으면 횟수라는 사실은 남고 길이는 남지 않는다. 자른 **뒤에** 세는 이유: 봉투에 나가는 것은
 *    잘린 문자열이고, 원문으로 세면 화면에 똑같은 두 줄이 나란히 남는다.
 * 3. **합계 `NOTICES_TOTAL_CHARS`.** 넘기면 뒤를 접고, 접은 **건수**(줄 수가 아니라 원래 notice 수)를
 *    정본 문구 `notices_folded` 로 알린다.
 *
 * ★ 두 상한은 **딱딱하다** — 결과의 한 줄은 400 자를, 전체는 1,600 자를 한 글자도 넘지 않는다.
 *   상한을 "대체로" 지키면 봉투를 자르는 쪽은 호스트가 되고, 잘리는 것은 꼬리(`patch` 경로·회복)다.
 *   그래서 두 자리를 이렇게 센다:
 *   · 말줄임표와 ` (×N)` 은 상한 **안**에 들어간다(접미사 길이만큼 본문을 덜 싣는다). 밖에 붙이면
 *     dedupe 가 길이를 줄이는 대신 늘리는 자리가 되고, 읽는 쪽은 401·405 를 세야 한다.
 *   · 접힘 문구가 붙을 자리를 합계 안에서 **미리 예약**한다. 예약이 없으면 줄들이 1,600 을 꽉
 *     채운 뒤 꼬리가 그 위에 붙었다(실측 1,631). 예약은 접을 일이 실제로 있을 때만 건다 —
 *     한 번 채워 보고 접힘이 없으면 그대로 낸다.
 *
 * ★ export 인 이유는 하나다 — 테스트 이음매. 이 세 규칙을 밖에서 재려면 실행을 통째로 돌리고
 *   그 실행이 400자짜리 알림 열두 개를 내게 만들어야 한다. 규칙이 함수 하나에 있으므로 그 함수를 잰다.
 */
export function joinNotices(list) {
  if (list.length === 0) return undefined;
  const counts = new Map();
  for (const text of list) {
    const clipped = clipNoticeLine(text, NOTICE_CHARS);
    counts.set(clipped, (counts.get(clipped) ?? 0) + 1);
  }
  const lines = [...counts].map(([text, count]) => {
    if (count <= 1) return text;
    const suffix = ` (×${count})`;
    return `${clipNoticeLine(text, NOTICE_CHARS - suffix.length)}${suffix}`;
  });
  // 접힘 문구는 접을 건수가 정해져야 길이를 알지만, 몇 줄을 넣을지는 그 길이가 정해져야 안다.
  // 순환을 끊는 값: 있을 수 있는 **가장 긴** 꼬리(모든 notice 를 접은 경우)를 예약분으로 쓴다.
  const tailRoom = renderNotice('notices_folded', { dropped: list.length }).length;
  const droppedAfter = (keptLines) => [...counts.values()].slice(keptLines).reduce((sum, count) => sum + count, 0);
  const fill = (budget) => {
    const kept = [];
    let used = 0;
    for (const line of lines) {
      if (kept.length > 0 && used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1; // 줄 하나 + 구분 공백 하나. 꼬리를 붙일 자리까지 이 수로 잰다.
    }
    return kept;
  };
  let kept = fill(NOTICES_TOTAL_CHARS);
  if (droppedAfter(kept.length) === 0) return kept.join(' ');
  kept = fill(NOTICES_TOTAL_CHARS - tailRoom);
  return `${kept.join(' ')} ${renderNotice('notices_folded', { dropped: droppedAfter(kept.length) })}`;
}

/**
 * 하위 모듈이 낸 결과의 **등재된** reason code. 두 모양을 같은 길로 읽는다:
 * `fail()` 이 만든 봉투는 `reasonCode` 를 들고 오고, 아직 옮기지 않은 `blocked('<코드>')` 는
 * 코드를 `error` 자리에 문자열로 들고 온다. 어느 쪽도 아니면 `null` — **지어내지 않는다.**
 *
 * ★ `deadline_exceeded` 만 별칭표를 태우지 않는다. 그 철자는 세부 코드가 아니라 조악
 *   `stopReason` 이고, 표에서는 `judge_deadline`(심판 전용)으로 올라간다 — 레인이 낸 실행
 *   수준의 데드라인이 심판 실패로 둔갑한다. 실행 수준의 이름은 `run_deadline_exceeded` 다.
 */
export function resultReasonCode(result) {
  const code = ownDataValue(result, 'reasonCode');
  if (code.ok === true && isReasonCode(code.value)) return code.value;
  const rawError = ownDataValue(result, 'error');
  const error = rawError.ok === true && typeof rawError.value === 'string' ? rawError.value : '';
  return error === 'deadline_exceeded' ? REASON.run_deadline_exceeded : normalizeLegacyReasonCode(error);
}

/**
 * 이 실패가 artifact 저장소의 권위를 앗아갔는가. 판정은 레지스트리의 `poison` 하나다
 * (WS2 §2.3) — 예전에는 `error.endsWith('_authority_lost')` 라는 **부분 문자열**과 손으로 적은
 * 세 이름이 그 일을 했고, 코드 하나를 개명하면 승격 규칙이 조용히 꺼졌다.
 */
export function artifactAuthorityLost(result) {
  const hardStopped = ownDataValue(result, 'hardStopped');
  return hardStopped.ok === true && hardStopped.value === true || isPoisonCode(resultReasonCode(result));
}

/**
 * 분류되지 않은(또는 프로바이더가 아무 말도 안 한) 결함 하나. `stderrTail` 이 없으므로 발췌가
 * 붙을 수 없다 — 그 사실이 셰이프에 적혀 있다.
 */
export function unclassifiedFault(reasonCode, vendor) {
  return deepFreeze({ reasonCode, vendor: vendor ?? null, excerpt: false, catalogKey: null, exitCode: null, stderrTail: null, drift: null });
}

/**
 * 프로바이더 결과에서 **실패 사실 자체**를 꺼낸다. 실패가 아니면 `null`.
 *
 * ★★ 예전에 이 자리는 불리언이었다(`error` 가 비어 있지 않은가). 그 한 비트가 카탈로그가
 *   붙인 reason code·영어 문장·회복 문장·발췌 재료(`stderrTail`)·스트림 드리프트를 **전부**
 *   삼켰고, 남은 것은 봉투의 `effect_unknown` 하나였다 — 스폰 실패도 인증 실패도 한도 소진도
 *   같은 한 글자로 나갔다(WS2 §3.3). 이제 객체가 그대로 지나간다.
 *
 * ★ 결과가 객체조차 아니면 프로바이더는 **아무 말도 안 한** 것이다 — 표 밖(`provider_error_
 *   unclassified`, 카탈로그가 보고도 못 알아본 경우)이 아니라 정말 모르는 경우이므로
 *   `provider_outcome_unknown` 이다. 그 둘은 다른 사실이고 회복도 다르다.
 */
export function providerFault(result, vendor) {
  if (result === null || typeof result !== 'object') return unclassifiedFault(REASON.provider_outcome_unknown, vendor);
  const reported = result.failure;
  const hasErrorText = typeof result.error === 'string' && result.error !== '';
  if (!hasErrorText && (reported === null || reported === undefined)) return null;
  const declared = isReasonCode(reported?.reasonCode) ? reported.reasonCode : null;
  return deepFreeze({
    reasonCode: declared ?? normalizeLegacyReasonCode(result.error) ?? REASON.provider_error_unclassified,
    vendor: typeof reported?.vendor === 'string' ? reported.vendor : vendor ?? null,
    excerpt: reported?.excerpt === true,
    catalogKey: typeof reported?.catalogKey === 'string' ? reported.catalogKey : null,
    exitCode: Number.isInteger(reported?.exitCode) ? reported.exitCode : null,
    stderrTail: result.stderrTail ?? null,
    drift: result.drift ?? null,
  });
}

/**
 * 프로바이더 호출 하나의 정산 — 레인이 아는 토큰(`writerResult`, 디스크에 남는 닫힌 어휘)과
 * **왜 그렇게 됐는지**(카탈로그 객체)를 함께 낸다. 워커·베리파이어·심판·플래너가 **모두** 이
 * 함수를 지난다: 같은 결과에 두 가지 판정이 있으면 봉투와 로그가 서로 다른 이름을 부른다.
 *
 * ★ `provider_outcome_unknown` 이 남는 자리는 실제로 "모르는" 경우 하나뿐이다: 우리 데드라인이 응답을
 *   회수했거나(hardStopped) 종료 기록 없이 잘린 경우. 분류된 결함은 토큰은 같아도 **코드가
 *   다르다** — 봉투로 나가는 것은 `failure.reasonCode` 이고, 그 값이 `provider_outcome_unknown`
 *   이 되는 길은 아래 두 줄뿐이다(WS2 §3.3 의 도달 불가 조건).
 */
export function qualityWriterSettlement(result, vendor) {
  const unknown = () => ({ status: REASON.provider_outcome_unknown, failure: unclassifiedFault(REASON.provider_outcome_unknown, vendor) });
  if (result?.hardStopped === true) return unknown();
  // 답이 **잘렸다**: 우리 데드라인이든 벤더의 상한이든, 그 실행이 워크트리에 무엇을 했는지 모른다.
  const cut = result?.truncated === true || result?.doneReason === 'timeout' || result?.doneReason === 'aborted';
  const fault = providerFault(result, vendor);
  if (fault === null) return cut ? unknown() : { status: 'sealed', failure: null };
  // ★ 잘린 답 + **표 밖의** 오류 문자열은 "무엇이 실패했는지 모른다"(분류 실패)가 아니라
  //   "무슨 일이 있었는지 모른다" 다. 뒤쪽이 더 정확하고 회복도 다르다(워크트리를 격리한다).
  //   카탈로그가 이름을 붙인 결함은 잘렸어도 그 이름이 이긴다 — 그것이 §3.3 의 도달 불가 조건이다.
  if (cut && fault.reasonCode === REASON.provider_error_unclassified) return unknown();
  return { status: REASON.provider_outcome_unknown, failure: fault };
}

/**
 * 라벨된 벤더 stderr 발췌 — 봉투에 실릴 수 있는 **유일한** 벤더 원문(WS2 §3.4).
 *
 * ★★ 모델 산문은 여기로 들어올 수 없다. 그 방벽은 논증이 아니라 **시그니처**다: `content`/`text`
 *   를 들고 `stderrTail` 이 없는 객체(= writer·verifier·judge 의 답)를 주면 던진다(불변식 4).
 *   프로바이더 결과는 실패든 아니든 `stderrTail` 키를 항상 들고 온다.
 * ★ 붙는 조건은 카탈로그의 `excerpt: true` 하나다(그 집합이 `EXCERPT_ALLOWED`). 종료 코드·시그널·
 *   스트림 결함·데드라인에는 안 붙는다 — 원인이 stderr 에 없기 때문이다.
 * ★ 세척이 자르기보다 **먼저**다: 600자는 세척을 지난 뒤의 길이이고, 반대로 하면 경계에서 갈린
 *   비밀 조각이 규칙에 안 걸린 채 남는다. `truncated` 는 "원문이 지금 보이는 것보다 길었다" 다 —
 *   4 KiB 꼬리로 이미 잘렸거나 세척 뒤 600자에서 또 잘렸거나, 둘 중 하나면 참이다.
 */
export function attachExcerpts(source, { vendor, redact = (text) => text } = {}) {
  if (source !== null && typeof source === 'object' && !('stderrTail' in source) &&
      ('content' in source || 'text' in source)) {
    throw new TypeError('attachExcerpts: model output is not an excerpt source');
  }
  // 프로바이더 결과를 그대로 줘도 된다 — 결함 기록은 그 결과에서 뜬 것이고, 둘의 `stderrTail` 은
  // 같은 객체다. 호출부가 어느 쪽을 들고 있느냐로 발췌가 붙고 안 붙고가 갈리면 안 된다.
  const fault = source !== null && typeof source === 'object' && source.failure !== undefined &&
    source.excerpt === undefined ? providerFault(source, vendor) : source;
  if (fault === null || typeof fault !== 'object' || fault.excerpt !== true) return [];
  const tail = fault.stderrTail;
  const label = typeof fault.vendor === 'string' ? fault.vendor : vendor;
  if (tail === null || typeof tail !== 'object' || typeof tail.text !== 'string' || tail.text === '' ||
      !Number.isSafeInteger(tail.bytes) || tail.bytes < 0 || !EXCERPT_SCHEMA.vendors.includes(label)) return [];
  const cleaned = redact(tail.text);
  const body = typeof cleaned === 'string' ? cleaned : tail.text;
  const text = body.slice(0, EXCERPT_SCHEMA.maxTextChars);
  return [Object.freeze({
    source: EXCERPT_SCHEMA.source,
    vendor: label,
    bytes: tail.bytes,
    truncated: tail.bytes > Buffer.byteLength(tail.text, 'utf8') || text.length < body.length,
    text,
  })];
}

/**
 * 실행 하나가 본 결함들 → 봉투가 실을 발췌 ≤`EXCERPT_SCHEMA.maxItems`.
 *
 * ★★ 순서가 계약의 일부다. 봉투의 `reasonCode` 는 **마지막** 결함에서 나오는데(`laneStopCode`
 *   ← `laneFault`), 발췌를 기록 순서대로 앞에서 셋만 자르면 바로 그 코드의 stderr 가 통째로
 *   빠질 수 있다 — 읽는 쪽은 라벨과 증거가 다른 봉투를 받는다. 그래서 종료 코드를 든 결함이
 *   먼저 오고, 나머지는 **최신 순**으로 채운다(오래된 결함은 이미 다른 코드로 설명됐다).
 * ★ 개수를 자르는 곳은 여기 하나다 — 봉투는 모양만 보고 세지 않는다(`contract/envelope.json`).
 */
export function orderedExcerpts(faults, { terminalCode = null, redact } = {}) {
  const recent = [...faults].reverse();
  const first = terminalCode === null ? -1 : recent.findIndex((fault) => fault?.reasonCode === terminalCode);
  const ordered = first < 0 ? recent : [recent[first], ...recent.filter((_, index) => index !== first)];
  return ordered.flatMap((fault) => attachExcerpts(fault, { redact })).slice(0, EXCERPT_SCHEMA.maxItems);
}

/**
 * 실행 이름공간 단계의 실패 봉투. **문구를 받지 않는다** — `reasonCode` 하나가 `error`·`recovery`·
 * `stopReason` 셋을 정한다(WS2 §7.2). 예전 머리는 `(runId, error, recovery, notice)` 였고 두 번째
 * 인자가 raw 코드, 세 번째가 대개 **워크트리 경로**였다: 다음에 무엇을 할지 말해야 하는 필드에
 * 파일 경로가 실려 나갔고, `stopReason` 에는 닫힌 조악 어휘가 아니라 그 코드가 그대로 실렸다.
 * 남은 경로는 이제 알림(`worktree_handed_to_reaper`·`worktree_manual_cleanup_required`)이 나른다.
 */
export function artifactBlocked(runId, reasonCode, params = {}, extra = {}) {
  return failure({
    status: statusOfReasonCode(reasonCode), confidence: confidenceOfRun({ unverified: true }),
    runId, reasonCode, params,
    ...excerptsFor(reasonCode, extra),
  });
}

/**
 * 조악 `stopReason` → 봉투 `status`. 계약(`contract/envelope.json` 의 `stopReasons` 표 status 열)을
 * 그대로 코드로 옮긴 것이고, 표와 이 표가 같은지는 `test/run-faults.test.mjs` 가 잰다.
 *
 * ★ `failed (disputed)` · `succeeded (unverified)` 처럼 괄호가 붙은 칸은 **status 와 confidence
 *   두 값**을 한 칸에 적은 것이다 — 여기서는 status 만 읽는다(confidence 는 `confidenceOfRun`).
 * ★ `cancelled` 은 WS3 태스크 7 이 `runCancelled` 를 실으면서 `src/envelope.mjs STATUSES` 에도
 *   들어왔다 — 그 전까지는 표에만 있었고 봉투는 `failed` 로 접혔다. 표를 미리 맞춰 둔 덕에
 *   생산자가 온 커밋에서 이 파일이 고칠 것은 이 주석 하나였다.
 */
export const STATUS_BY_STOP_REASON = Object.freeze({
  verified: 'succeeded',
  unverified: 'succeeded',
  rejected: 'failed',
  policy_failure: 'failed',
  budget_exhausted: 'failed',
  deadline_exceeded: 'deadline_exceeded',
  cancelled: 'cancelled',
  provider_failed: 'failed',
  infrastructure_failed: 'failed',
  blocked: 'blocked',
  tie: 'succeeded',
  no_candidate: 'failed',
  dry_run: 'succeeded',
});

/**
 * 실패 봉투의 `status` — **코드가 정한다.** 조악값과 짝이 맞지 않는 status 는 소비자에게 거짓말이다.
 *
 * ★★ 실측(WS2 최종 리뷰 E1): `artifactBlocked('run-x', REASON.provider_spawn_failed)` 가
 *   `{status:'blocked', stopReason:'provider_failed'}` 를 냈다. 계약은 `blocked` 를 **실행이
 *   시작되기 전의** 전제 조건 실패로 정의하므로, `status` 로 갈라 읽는 통합자는 실행 도중의
 *   벤더 크래시를 "아무것도 안 돌았다" 로 읽었다. 같은 자리에서 코드와 status 를 각각 고르는 한
 *   그 둘은 계속 갈린다 — 그래서 고르는 자리를 없앴다.
 */
export function statusOfReasonCode(reasonCode) {
  return STATUS_BY_STOP_REASON[stopReasonOf(reasonCode)] ?? 'failed';
}

/**
 * 발췌는 **그 코드의 증거**일 때만 실린다(계약 `contract/envelope.json` 의 `excerpt.attachedWhen
 * Codes`). 실행이 도중에 본 스폰 실패의 stderr 를, 결국 매니페스트 체크포인트로 끝난 봉투에
 * 얹으면 라벨이 거짓말을 한다 — 읽는 쪽은 그 stderr 가 이 실패의 원인이라고 읽는다.
 */
export function excerptsFor(reasonCode, extra) {
  if (!Array.isArray(extra.excerpts) || extra.excerpts.length === 0) return extra;
  return EXCERPT_ALLOWED.includes(reasonCode) ? extra : { ...extra, excerpts: [] };
}

/** 하위 모듈 결과의 코드, 못 알아보면 `fallback`. */
export function reasonCodeOf(result, fallback) {
  return resultReasonCode(result) ?? fallback;
}

/**
 * 아직 이전하지 않은 하위 모듈의 `blocked` 결과를 봉투 인자로 옮긴다. 세 갈래다.
 *
 *   1. 코드 + **이미 렌더된 문구** (`fail()` 산물) → 그 두 문장을 바이트 그대로 나른다.
 *   2. 코드만          → 레지스트리가 호출부의 인자로 렌더한다.
 *   3. 코드 없음       → 그 모듈이 들고 온 문구를 그대로(아직 이전하지 않은 test-runner).
 *
 * ★★ 1 이 없던 동안 무엇이 깨졌나(WS2 Task 14 수정 I1, 리뷰어 재현). 코드만 보고 **호출부의**
 *   인자로 다시 렌더했다: `{path, limit}` 는 이 단계가 아는 값이고, 하위 모듈의 코드가 요구하는
 *   자리표시자와는 아무 관계가 없다. `git_version_below_floor` 는 `{version}`·`{floor}` 를
 *   요구하므로 렌더가 깨졌고, 봉투에는 사실이 하나도 없는 폴백 문장(`RENDER_FALLBACK_MESSAGE`)과
 *   강등 알림이 나갔다 — 정작 생산자는 두 값을 넣어 **옳은 문장을 이미 만들어 둔** 채였다.
 *   어느 인자가 그 코드의 것인지 아는 쪽은 생산자뿐이므로, 생산자가 이미 렌더했으면 그것이 정답이다.
 *   문구가 **둘 다** 있을 때만 1 로 간다: 반쪽만 나르면 나머지 반쪽을 여기서 지어내게 된다.
 */
export function carriedFailure(result, params = {}) {
  const reasonCode = resultReasonCode(result);
  const error = ownDataValue(result, 'error').value;
  const recovery = ownDataValue(result, 'recovery').value;
  const hasError = typeof error === 'string' && error !== '';
  const hasRecovery = typeof recovery === 'string' && recovery !== '';
  if (reasonCode !== null) {
    // 코드별 인자는 호출부의 봉지보다 **뒤**다 — 그 코드의 수를 아는 쪽은 레지스트리다.
    return hasError && hasRecovery ? { reasonCode, error, recovery } : { reasonCode, params: { ...params, ...stopCodeParams(reasonCode) } };
  }
  return { error: errorText(error), recovery: hasRecovery ? recovery : GENERIC_RECOVERY };
}

/**
 * 실행 데드라인 봉투. 열세 자리가 각자 같은 문장을 짓던 것을 한 자리로 모은다 — `stopReason` 은
 * 코드가 정하고(`deadline_exceeded`), 남은 워크트리는 알림이 나른다.
 */
export function runDeadline({ runId, effectiveWaitMs, extras = {}, content, contentFallback }) {
  return failure({
    status: statusOfReasonCode(REASON.run_deadline_exceeded), confidence: confidenceOfRun({ unverified: true }), runId,
    reasonCode: REASON.run_deadline_exceeded, params: { waitMs: effectiveWaitMs },
    ...(content === undefined ? {} : { content, contentFallback }),
    ...excerptsFor(REASON.run_deadline_exceeded, extras),
  });
}

/**
 * 실행 취소 봉투 — 호스트가 끊은 실행의 종료(WS3 §0-C2). `runDeadline` 의 형제이고, 열 자리가
 * 둘 중 하나를 고른다. **고르는 근거는 어느 신호가 발화했는가**(`hostSignal.aborted`)이지
 * 결함 문구가 아니다(WS2 §14: cancel/deadline 을 signal 앞에) — 그 판정은 엔진의
 * `haltReasonCode` 한 자리에 있다.
 *
 * ★ `effectiveWaitMs` 를 **받지 않는다.** 취소에는 기한이 없다. 그 수를 문장에 실으면
 *   사용자가 자기가 끊은 실행을 "시간이 모자랐다" 로 읽는다 — 그게 `runDeadline` 의 문장이다.
 * ★ 남은 워크트리의 운명은 여기가 아니라 **알림**(`handoffNotice`)이 나른다. 코드 문장이
 *   "격리했다" 를 단정하면, 워크트리가 생기기도 전에 취소된 실행에서 그 문장이 거짓이 된다.
 */
export function runCancelled({ runId, extras = {}, content, contentFallback }) {
  return failure({
    status: statusOfReasonCode(REASON.run_cancelled), confidence: confidenceOfRun({ unverified: true }), runId,
    reasonCode: REASON.run_cancelled,
    ...(content === undefined ? {} : { content, contentFallback }),
    ...excerptsFor(REASON.run_cancelled, extras),
  });
}

/**
 * 워크트리 하나가 회수되지 못했을 때의 알림. 리퍼가 받았는지 아닌지가 **다른 문장**이다 —
 * 하나는 "곧 사라진다", 다른 하나는 "네가 지워야 한다" 이고, 사용자의 다음 행동이 정반대다.
 */
export function handoffNotice(tracked, path) {
  return renderNotice(tracked === true ? 'worktree_handed_to_reaper' : 'worktree_manual_cleanup_required', { path });
}

/**
 * 실행 하나의 **벤더 결함 장부**. 주입된 `logLine`(진단 로그)과 `redact`(발췌 세척기)를 닫는다 —
 * 그 둘이 실행마다 다르기 때문에 factory 다.
 *
 * ★ 장부는 순서를 기억한다. 봉투가 실을 코드는 **마지막** 결함에서 나오고(`laneFault`), 발췌는
 *   그 코드의 증거를 먼저 놓는다(`orderedExcerpts`). 순서를 잃으면 라벨과 증거가 어긋난다.
 */
export function createFaultRegistry({ logLine, redact }) {
  // ── 벤더 결함 장부 ────────────────────────────────────────────────────
  // 예전에는 프로바이더가 낸 코드·문장·stderr 가 호출부의 불리언 하나에서 사라졌다. 여기서는
  // 실행 하나가 본 결함을 순서대로 들고 있다가 봉투 조립에서 (a) 코드 하나를 고르고
  // (b) 발췌 ≤3 을 만들고 (c) 벤더별 스트림 드리프트를 **실행당 한 줄**로 접는다(SB6).
  const recordedFaults = [];
  // 프로바이더가 답변과 분리해 낸 실행 고지. 중복을 보존하고 redaction 뒤 UTF-8 정본 순서로
  // joinNotices 에 넘겨야 병렬 레인의 완료 레이스가 봉투 바이트를 바꾸지 않는다.
  const providerNotices = [];
  const driftTotals = new Map();
  // 벤더가 스스로 보낸 한도 수치(WS4b 태스크 7). 드리프트와 **같은 규율**로 벤더별 한 줄이지만
  // 합산이 아니라 **마지막이 이긴다** — 한도는 쌓이는 수가 아니라 지금 상태이고, 실행 하나가
  // 프로바이더를 여러 번 부르는 동안 그 상태는 움직인다.
  const rateLimits = new Map();
  const recordFault = (fault, where) => {
    if (fault === null) return;
    recordedFaults.push({ ...where, fault });
    logLine('error', fault.reasonCode, 'provider failure', {
      vendor: fault.vendor ?? '', kind: where.kind, laneId: where.laneId ?? '',
      catalogKey: fault.catalogKey ?? '', exitCode: fault.exitCode ?? '',
    });
  };
  const recordProviderOutcome = (vendor, kind, laneId, result) => {
    const notice = result?.notice;
    if (typeof notice === 'string' && notice !== '') providerNotices.push(redact(notice));
    const drift = result?.drift;
    if (drift !== null && typeof drift === 'object') {
      const unknown = Array.isArray(drift.unknownTypes) ? drift.unknownTypes.length : 0;
      const unparsable = Number.isSafeInteger(drift.unparsableLines) ? drift.unparsableLines : 0;
      if (unknown > 0 || unparsable > 0) {
        const seen = driftTotals.get(vendor) ?? { unknown: 0, unparsable: 0 };
        driftTotals.set(vendor, { unknown: seen.unknown + unknown, unparsable: seen.unparsable + unparsable });
        logLine('warn', null, 'provider stream drift', {
          vendor, kind, unknown, unparsable,
          unknownTypes: Array.isArray(drift.unknownTypes) ? drift.unknownTypes.join(',') : '',
        });
      }
    }
    // ★ 프로바이더가 이미 접어 온 모양(`{utilization, resetsAt}`)을 그대로 받는다 — 벤더의 원래
    //   필드를 여기서 읽으면 벤더가 늘 때마다 이 자리가 갈린다(`drift` 와 같은 규율).
    const rateLimit = result?.rateLimit;
    if (rateLimit !== null && typeof rateLimit === 'object' && !Array.isArray(rateLimit)) rateLimits.set(vendor, rateLimit);
    // ★ 장부에 남는 판정은 봉투가 쓰는 판정과 **같은 함수**에서 나온다. 여기서 raw 분류를 적으면
    //   로그와 봉투가 같은 결과를 두 이름으로 부른다(잘린 답이 하나는 `provider_error_unclassified`,
    //   다른 하나는 `provider_outcome_unknown` 이 되던 실측 결함).
    recordFault(qualityWriterSettlement(result, vendor).failure, { kind, laneId: laneId ?? null });
  };
  return {
    recordFault,
    recordProviderOutcome,
    /** 이 레인(없으면 실행 전체)이 마지막으로 본 결함. 레인은 결함 하나에서 빠져나온다. */
    laneFault: (laneId) => [...recordedFaults].reverse().find((entry) => laneId === undefined || entry.laneId === laneId)?.fault ?? null,
    /** 프로바이더가 낸 실행 고지 — 정본 순서로 내고 상한·중복 접기는 봉투 합류점에 맡긴다. */
    providerNotices: () => [...providerNotices].sort(compareUtf8),
    /** 벤더별 드리프트 한 줄씩 — 실행당 한 번(합산은 위에서 이미 끝났다). */
    driftNotices: () => [...driftTotals].map(([vendor, seen]) =>
      renderNotice('provider_stream_drift', { vendor, unknown: seen.unknown, unparsable: seen.unparsable })),
    /** 벤더별 한도 수치 한 줄씩 — 마지막으로 관측한 상태다(불변식 4: 라벨된 알림으로만). */
    rateLimitNotices: () => [...rateLimits].map(([vendor, seen]) =>
      renderNotice('provider_rate_limit_reported', { vendor, utilization: seen.utilization, resetsAt: seen.resetsAt })),
    /** 라벨된 stderr 발췌 ≤3, 봉투가 든 코드의 증거를 먼저. */
    excerpts: (terminalCode = null) => orderedExcerpts(
      recordedFaults.map((entry) => entry.fault), { terminalCode, redact },
    ),
  };
}

/**
 * 레인 토큰 중 **실행을 그 자리에서 막는** 것들. WS2 Task 15 가 레인 어휘를 레지스트리 이름으로
 * 옮긴 뒤로 이 목록도 그 이름이다 — 레인이 쓰는 철자와 여기서 읽는 철자가 갈리면 이 판정이
 * 조용히 아무것도 안 잡는다.
 */
export const LANE_ARTIFACT_STOPS = Object.freeze([
  REASON.artifact_allocation_checkpoint_failed, REASON.artifact_attempt_write_failed,
  REASON.artifact_candidate_write_failed, REASON.git_snapshot_failed, REASON.git_seal_failed,
]);

/** 벤더/봉인 결함이 실제 원인인 레인 토큰 — 이 자리에서는 카탈로그가 붙인 코드가 이긴다. */
const LANE_TOKENS_FROM_FAULT = Object.freeze([
  REASON.provider_outcome_unknown, REASON.provider_reported_failure, REASON.provider_deadline_exceeded,
  REASON.git_snapshot_failed, REASON.git_seal_failed,
]);

/**
 * 레인 토큰 → 봉투에 실릴 **등재된** 코드.
 *
 * ★ 카탈로그가 이름을 붙인 결함이 있으면 그 코드가 이긴다. 레인의 토큰은 흐름 제어 어휘이고
 *   사용자가 읽어야 하는 것은 "무엇이 실패했나" 다 — 그래서 `provider_outcome_unknown` 이
 *   봉투에 실리는 길은 카탈로그가 아무것도 못 붙인 경우 하나뿐이다(WS2 §3.3 의 도달 불가 조건).
 * ★ `deadline_exceeded` 만 별칭표를 안 태운다(`resultReasonCode` 와 같은 이유 — 그 철자는
 *   세부 코드가 아니라 조악 `stopReason` 이고 표에서는 심판 전용 코드로 올라간다).
 */
export function laneStopCode(stopReason, fault = null) {
  if (fault !== null && LANE_TOKENS_FROM_FAULT.includes(stopReason)) return fault.reasonCode;
  if (stopReason === 'deadline_exceeded') return REASON.run_deadline_exceeded;
  return normalizeLegacyReasonCode(stopReason) ?? REASON.run_orchestration_failed;
}

/**
 * 레인이 **아는 경우에만** 실리는 문구 인자. 오늘은 `verifier_verdict_invalid` 의 `{detail}`
 * 하나이고, 그 값은 판정문 파서가 어느 검사에서 걸렀는지다(`src/verdict.mjs` 의 `invalid()`).
 *
 * ★ 없으면 **키 자체를 안 만든다.** `detail: undefined` 를 넘기면 문구 정본(`renderTemplate`)이
 *   던지고 봉투는 사실이 하나도 없는 폴백 문장으로 강등된다 — 빈 문자열도 같은 등급이다.
 */
export function laneStopDetail(candidate) {
  const detail = ownDataValue(candidate, 'stopDetail').value;
  return typeof detail === 'string' && detail !== '' ? { detail } : {};
}

/**
 * 코드가 요구하는 `{limit}` 는 **그 코드의 상한**이다 — 봉투를 짓는 자리가 들고 있는 아무 수가 아니다.
 *
 * ★★ 실측(WS2 최종 리뷰 RC-2): 종료 봉투의 공유 인자 봉지가 `limit: effectiveWaitMs` 를 담고
 *   있었고, 그래서 `verifier_issue_limit_exceeded` 가 "The issue ledger would exceed the 3600000
 *   blocking-issue limit" 이라고 말했다. 진짜 상한은 100(`MAX_BLOCKING_ISSUES`)이고, 생산자
 *   (`src/candidate-lane.mjs` 의 두 자리)는 인자를 하나도 안 넘겼다. 골든이 이것을 못 잡은 이유는
 *   `SAMPLE_PARAMS` 가 그 코드에 `{limit: 100}` 을 따로 적어 두었기 때문이다 — 표본이 생산자와
 *   다른 값을 쓰면 계약 검사는 **표본만** 잰다.
 * ★ 그래서 두 가지를 함께 했다: 데드라인 문구의 자리는 `{waitMs}` 로 이름을 바꿔 `{limit}` 에
 *   섞일 수 없게 했고, `{limit}` 은 여기서 **코드별로** 채운다. 표가 한 줄인 것이 맞다 — 다른
 *   `{limit}` 코드(artifact/worktree/git 상한)는 전부 자기 생산자가 `fail()` 로 이미 렌더한
 *   문장을 들고 오므로(`carriedFailure` 의 1번 갈래) 이 표를 지나지 않는다.
 */
const CODE_LIMITS = Object.freeze({ [REASON.verifier_issue_limit_exceeded]: MAX_BLOCKING_ISSUES });

/** 그 코드가 요구하는 코드별 인자. 없으면 빈 객체 — 없는 키를 지어내지 않는다. */
export function stopCodeParams(reasonCode) {
  const limit = CODE_LIMITS[reasonCode];
  return limit === undefined ? {} : { limit };
}

/**
 * 성공 봉투의 `stopReason`·`reasonCode`. 조악 어휘인 둘(`verified`·`unverified`)은 그대로 나가고
 * 그 밖의 레인 토큰(`evidence_unavailable`)은 코드로 올라가 **자기** 조악값을 얻는다 — 봉투의
 * `stopReason` 은 닫힌 열세 값이지 레인의 토큰이 아니다(계약 `contract/envelope.json`).
 */
export function successCodeOf(stopReason) {
  const reasonCode = laneStopCode(stopReason);
  const coarse = stopReasonOf(reasonCode);
  // ★ 이 둘만 조악값을 **그대로** 내고 코드는 싣지 않는다: 계약(`contract/envelope.json` 의
  //   reasonCode 행)이 `stopReason` 이 `verified`·`unverified` 인 성공 봉투에는 `reasonCode` 가
  //   없다고 적는다. 판정을 **올린 코드**로 하는 이유는 옛 철자(`verified`)도 같은 답을 내야
  //   하기 때문이다 — 철자로 갈랐더니 옛 값 하나가 조악값과 코드를 함께 실었다(골든 드리프트).
  if (reasonCode === REASON.lane_verified || reasonCode === REASON.lane_unverified) return { stopReason: coarse };
  // ★★ 예전에는 여기서 조악값을 **덮어썼다**(성공과 양립하지 않으면 `unverified`). 그 한 줄이
  //   `evidence_unavailable` 을 두 얼굴로 만들었다: 레지스트리와 문서·골든은
  //   `infrastructure_failed` 라고 발표하는데 봉투는 언제나 `unverified` 를 실었다 — 코드 하나에
  //   조악값 하나라는 보장(`stopReasonOf` 가 존재하는 이유)이 바로 그 자리에서 깨졌다. 고칠 곳은
  //   여기가 아니라 **등재**였고(그 코드의 생산자는 둘 다 accept 가지다), 이제 그렇게 되어 있다.
  //   그래서 이 함수는 아무것도 덮지 않는다 — 봉투가 말하는 조악값은 언제나 `stopReasonOf(code)` 다.
  return { reasonCode, stopReason: coarse };
}

/**
 * 종료 삼중값 `{status, stopReason, reasonCode}` — 저널 행과 종료 로그 줄이 남기는 것(WS3 §0-D1).
 *
 * ★ 왜 봉투에서 **뽑아오지 않는** 갈래가 있는가: 학습 행은 정리(cleanup)보다 **먼저** 쓰인다
 *   (`commitRunLearning` 머리말 — 정리 결함이 등급을 바꾸면 안 된다). 그때는 봉투가 아직 없다.
 *   그래서 봉투를 짓는 자리와 **같은 순수 함수**(`statusOfReasonCode`·`stopReasonOf`·
 *   `successCodeOf`)로 여기서 한 번 짓고, 봉투와 저널이 서로 다른 규칙을 갖지 않게 한다.
 * ★ 등재되지 않은 코드는 `run_orchestration_failed` 로 접는다 — `stopReasonOf` 는 낯선 값에
 *   **던지므로**, 여기서 접지 않으면 기록 하나가 실행 전체를 죽인다.
 */
export function terminalOutcome({ reasonCode = null, successStopReason = null }) {
  if (successStopReason !== null) {
    const settled = successCodeOf(successStopReason);
    return { status: 'succeeded', stopReason: settled.stopReason, reasonCode: settled.reasonCode ?? null };
  }
  const code = isReasonCode(reasonCode) ? reasonCode : REASON.run_orchestration_failed;
  return { status: statusOfReasonCode(code), stopReason: stopReasonOf(code), reasonCode: code };
}

/** 이미 만들어진 봉투에서 같은 셋을 읽는다 — 엔진 종료 sink 의 갈래. */
export function terminalOutcomeOf(envelope) {
  const read = (key) => (typeof envelope?.[key] === 'string' ? envelope[key] : null);
  return { status: read('status') ?? 'failed', stopReason: read('stopReason'), reasonCode: read('reasonCode') };
}

/**
 * 실행별 로그 핸들 하나(WS2 §5)와 그 위에 얹힌 두 가지 — 문구 세척기의 설치·반납, 그리고 모든
 * 봉투가 나르는 공통 extras(`log` 참조 + 합쳐진 `notice`).
 *
 * ★ 세척 훅은 **모듈 전역**이라 실행 둘이 한 자리를 두고 다툰다. 그 규칙(나중에 꽂은 쪽이 이기고,
 *   반납은 지금 걸린 것이 아직 자기 것일 때만)이 `closeLog` 안에 있으므로, 핸들을 만드는 자리와
 *   반납하는 자리가 같은 클로저에 있어야 한다 — 그래서 함수 여섯이 아니라 factory 하나다.
 *
 * @param {{ onLogOpened?: ((ref: {path: string}) => void)|null }} [input]
 */
/**
 * sink 가 열리기 전에 버퍼가 들고 있는 줄의 최대 개수. 오늘 그 구간에서 나는 줄은 벤더 수만큼의
 * `preflight` 뿐이라 넉넉하다 — 상한은 크기가 아니라 **끝이 있다**는 사실을 위한 것이다.
 */
const PRE_SINK_LOG_LINES = 64;

export function createRunLog({ onLogOpened = null } = {}) {
  // ── 실행별 로그(WS2 §5) ─────────────────────────────────────────────
  // 핸들은 상태 루트가 정해진 뒤에 열린다. 열리기 전의 봉투는 `log` 를 안 달고 나가고, 그것이
  // "로그가 없다" 의 유일한 정당한 경우다. 열기 실패는 실행을 떨어뜨리지 않고 알림 하나가 된다.
  let runLog = null;
  let installedRedactor = null;
  const runLogNotices = [];
  // ★★ sink 가 열리기 **전에** 난 줄들. 예전에는 그냥 사라졌다: `logLine` 은 `runLog?.write(...)`
  //   이므로 핸들이 없으면 조용한 무연산이고, 사전 점검(preflight)의 벤더별 사유는 전부 그
  //   자리에서 났다 — 「로그인이 안 됐다」·「바이너리가 없다」·「보안 하한 아래다」가 어느
  //   채널에도 안 남았다. 이제는 여기 쌓았다가 `openLog` 가 그대로 흘려 넣는다(같은 write 경로라
  //   세척·클립 규칙도 같다). 상한을 두는 이유는 하나다 — 로그가 **끝내 안 열리는** 실행에서
  //   이 배열이 유일한 소비자 없는 성장 지점이 된다.
  const pending = [];
  const openLog = async ({ stateRoot, projectPath: project, runId }) => {
    if (runLog !== null) return;
    const redact = makeRedactor({ stateRoot, projectRoot: project, home: homedir() });
    // 문구 정본의 세척 훅은 **모듈 전역**이다. 나중에 꽂은 쪽이 이기고, 반납은 **지금 걸린 것이
    // 아직 자기 것일 때만** 성립한다(`closeLog`) — 같은 프로세스의 다른 실행이 아직 도는데 훅을
    // 항등으로 되돌리면 그 실행의 봉투가 그 순간부터 절대 경로를 그대로 내보낸다.
    installedRedactor = redact;
    setRedactor(redact);
    runLog = await openRunLog({ stateRoot, runId, redact });
    if (runLog.unavailable === true) runLogNotices.push(renderNotice('log_unavailable', { reason: runLog.reason }));
    // sink 가 생긴 첫 순간에 쌓인 줄을 순서대로 흘려 넣는다. 실패는 삼킨다 — 조언 채널이다.
    for (const line of pending.splice(0, pending.length)) {
      try {
        runLog.write(...line);
      } catch { /* advisory */ }
    }
    // 바깥(`runOrchestration`)의 최상위 catch 도 이 경로를 알아야 한다 — 조언 채널이 본 실행의
    // 봉투를 막지는 못하므로 sink 가 던져도 삼킨다.
    const ref = logRef();
    if (ref !== undefined) {
      try {
        onLogOpened?.(ref);
      } catch { /* advisory */ }
    }
  };
  const logLine = (level, reasonCode, message, fields) => {
    try {
      if (runLog === null) {
        if (pending.length < PRE_SINK_LOG_LINES) pending.push([level, reasonCode, message, fields]);
        return;
      }
      runLog.write(level, reasonCode, message, fields);
    } catch { /* advisory */ }
  };
  const logRef = () => (typeof runLog?.path === 'string' ? { path: runLog.path } : undefined);
  const closeLog = () => {
    try {
      runLog?.close();
    } catch { /* advisory */ }
    // 늦게 시작한 실행이 이미 자기 세척기를 꽂았으면 그것을 끄지 않는다 — 이 실행의 반납은
    // 무해한 no-op 이 되고, 마지막으로 끝나는 실행이 훅을 항등으로 되돌린다.
    if (installedRedactor !== null && getRedactor() === installedRedactor) setRedactor(null);
    installedRedactor = null;
  };
  /**
   * 알림 통의 **입구**. 통(`runLogNotices`)도 합류(아래 `envelopeExtras`)도 처음부터 있었고 없던
   * 것은 문 하나뿐이었다 — `src/engine.mjs` 는 `let addNotice = () => {}` 를 선언한 뒤 저장소
   * 어디에서도 대입하지 않아 `stage_authority_revoked` 가 어느 봉투에도 안 실렸다(WS4b 태스크 1).
   * 여기로 들어온 줄은 그 뒤의 **모든** 봉투를 타고 `joinNotices` 의 유계·중복 접힘을 그대로 받는다.
   */
  const addNotice = (text) => { if (typeof text === 'string' && text !== '') runLogNotices.push(text); };
  /**
   * 봉투 하나가 실어야 하는 공통 두 가지 — 로그 참조와 합쳐진 알림. `truncated` 는 실행 중에
   * 참이 될 수 있으므로 **봉투를 만드는 순간** 다시 읽는다.
   */
  const envelopeExtras = (notices = []) => {
    const merged = joinNotices([
      ...notices,
      ...runLogNotices,
      ...(runLog?.truncated === true ? [renderNotice('log_truncated', { limit: RUN_LOG_MAX_BYTES })] : []),
    ]);
    return { ...(logRef() === undefined ? {} : { log: logRef() }), ...(merged ? { notice: merged } : {}) };
  };
  // ★ 세척기는 로그 핸들과 **같은 수명**이다 — 봉투와 발췌가 부르는 세척은 이 실행이 꽂은 것이지
  //   모듈 전역의 현재 값이 아니다. 반납 뒤에는 항등이다.
  const redact = (text) => (installedRedactor === null ? text : installedRedactor(text));
  return { openLog, logLine, logRef, closeLog, addNotice, envelopeExtras, redact };
}
