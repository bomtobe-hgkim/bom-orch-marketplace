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

export const STATUSES = Object.freeze(['succeeded', 'failed', 'invalid', 'blocked', 'deadline_exceeded']);

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

const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';
const TRUNCATED_REPORT = '{"truncatedReport":true}';

/** 어떤 값에서도(toString 이 던지는 값 포함) 사람이 읽을 문자열을 뽑는다. */
function safeErrorText(error) {
  if (typeof error === 'string') return error !== '' ? error : '알 수 없는 오류';
  try {
    const text = String(error);
    return text !== '' ? text : '알 수 없는 오류';
  } catch {
    return '알 수 없는 오류';
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
 */
export function success({
  content, contentFallback, confidence, notice, recovery, runId, stopReason,
} = {}) {
  const finalConfidence = normalizeConfidence(confidence);
  const finalContent = normalizeRunContent(content, contentFallback).content;
  const finalNotice = typeof notice === 'string' && notice !== '' ? notice : undefined;

  const status = finalConfidence === 'disputed' ? 'failed' : 'succeeded';
  const env = { status, content: finalContent, confidence: finalConfidence };
  if (typeof recovery === 'string' && recovery !== '') env.recovery = recovery;
  if (finalNotice !== undefined) env.notice = finalNotice;
  if (typeof runId === 'string') env.runId = runId;
  if (typeof stopReason === 'string') env.stopReason = stopReason;

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
 */
export function failure({
  status, error, recovery, content, contentFallback, confidence, notice, runId, stopReason,
} = {}) {
  const finalStatus = STATUSES.includes(status) && status !== 'succeeded' ? status : 'failed';
  const finalRecovery = typeof recovery === 'string' && recovery !== '' ? recovery : GENERIC_RECOVERY;
  const normalized = content !== undefined || contentFallback !== undefined
    ? { content: normalizeRunContent(content, contentFallback).content }
    : {};
  const envelope = { status: finalStatus };
  if (CONFIDENCE.includes(confidence)) envelope.confidence = confidence;
  Object.assign(envelope, normalized);
  envelope.error = safeErrorText(error);
  envelope.recovery = finalRecovery;
  if (typeof notice === 'string' && notice !== '') envelope.notice = notice;
  if (typeof runId === 'string') envelope.runId = runId;
  if (typeof stopReason === 'string') envelope.stopReason = stopReason;
  return envelope;
}

/** JSON.stringify 가 성공했을 때 결과가 실제 문자열인지 본다 (undefined 반환 등을 걸러낸다). */
function stringifyOrThrow(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw new Error('직렬화 결과가 문자열이 아닙니다.');
  return text;
}

// serializeToolResult 의 모든 단계가 실패했을 때 쓰는, JSON.stringify 를 아예
// 거치지 않는 손으로 만든 고정 문자열. 이 마지막 단계가 던지면 더 이상 감쌀 곳이
// 없으므로 절대 실패할 수 없는 형태여야 한다.
const HARD_FALLBACK_TEXT =
  '{"status":"failed","error":"serialization failed","recovery":"다시 시도하거나 관리자에게 알리세요."}';

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
    return { content: [{ type: 'text', text: stringifyOrThrow(envelope) }] };
  } catch {
    try {
      const fallback = failure({
        status: 'failed',
        error: '결과 직렬화에 실패했습니다.',
        recovery: '결과가 너무 크거나 순환 참조를 담고 있을 수 있습니다. 더 좁은 요청으로 다시 시도하세요.',
      });
      return { content: [{ type: 'text', text: stringifyOrThrow(fallback) }] };
    } catch {
      return { content: [{ type: 'text', text: HARD_FALLBACK_TEXT }] };
    }
  }
}

// ── 손수 검증 ─────────────────────────────────────────────────────────────

const TYPE_LABEL = {
  boolean: 'boolean(불리언)',
  string: 'string(문자열)',
  number: 'number(숫자)',
  array: 'array(배열)',
};

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
    return {
      ok: false,
      error: '인자는 JSON 객체여야 합니다.',
      recovery: '{ } 형태의 객체로 다시 호출하세요.',
    };
  }

  const specObj = spec && typeof spec === 'object' ? spec : {};
  const specKeys = Object.keys(specObj);
  const argKeys = Object.keys(args);

  const unknown = argKeys.filter((key) => !specKeys.includes(key));
  if (unknown.length > 0) {
    const bad = unknown[0];
    const suggestion = specKeys.length > 0 ? closestKey(bad, specKeys) : null;
    const allowed = specKeys.length > 0 ? `허용된 인자: ${specKeys.join(', ')}` : '허용된 인자가 없습니다.';
    return {
      ok: false,
      error: `알 수 없는 인자: ${bad}`,
      recovery: suggestion ? `혹시 '${suggestion}' 를 의도했나요? ${allowed}` : allowed,
    };
  }

  const value = {};
  for (const key of specKeys) {
    const fieldSpec = specObj[key] ?? {};
    const provided = Object.hasOwn(args, key);

    if (!provided) {
      if (fieldSpec.required) {
        return {
          ok: false,
          error: `필수 인자 누락: ${key}`,
          recovery: `'${key}' 인자를 지정하세요 (${fieldSpec.type ?? '값'}).`,
        };
      }
      if (Object.hasOwn(fieldSpec, 'default')) value[key] = fieldSpec.default;
      continue;
    }

    const raw = args[key];
    const expectedType = fieldSpec.type;

    // `array` 는 `typeof` 로 표현할 수 없다 — `typeof []` 는 'object' 라서 `{}` 도 통과한다.
    // 원소 타입까지 여기서 본다. 안 보면 핸들러마다 같은 검사를 다시 쓰게 되고, 그러면
    // 어느 핸들러가 빠뜨렸는지 알 수 없다.
    if (expectedType === 'array') {
      if (!Array.isArray(raw)) {
        return {
          ok: false,
          error: `'${key}' 는 array 타입이어야 합니다.`,
          recovery: `'${key}' 에 ${TYPE_LABEL.array} 값을 주세요.`,
        };
      }
      const itemType = fieldSpec.items;
      if (typeof itemType === 'string') {
        const badIndex = raw.findIndex((item) => typeof item !== itemType);
        if (badIndex !== -1) {
          return {
            ok: false,
            error: `'${key}' 의 ${badIndex}번째 원소가 ${itemType} 가 아닙니다.`,
            recovery: `'${key}' 의 모든 원소를 ${TYPE_LABEL[itemType] ?? itemType} 로 주세요.`,
          };
        }
      }
      value[key] = raw;
      continue;
    }

    if (typeof expectedType === 'string' && typeof raw !== expectedType) {
      return {
        ok: false,
        error: `'${key}' 는 ${expectedType} 타입이어야 합니다.`,
        recovery: `'${key}' 에 ${TYPE_LABEL[expectedType] ?? expectedType} 값을 주세요.`,
      };
    }

    // ★ 수치 제약. `typeof raw === 'number'` 는 NaN·Infinity 도 통과시킨다 — 그 둘은 어떤
    //   범위 비교에서도 거짓이라 아래 검사가 함께 잡는다. 이 검사가 없으면 도구 스펙이
    //   선언한 `minimum`/`maximum`/정수 제약이 선언만 남고, 값은 한 층 아래에서 뒤늦게
    //   거부된다(왕복 한 번을 버린다) 또는 그냥 통과한다.
    if (expectedType === 'number') {
      const bad =
        !Number.isFinite(raw) ||
        (fieldSpec.integer === true && !Number.isInteger(raw)) ||
        (typeof fieldSpec.min === 'number' && raw < fieldSpec.min) ||
        (typeof fieldSpec.max === 'number' && raw > fieldSpec.max);
      if (bad) {
        const shape = [
          fieldSpec.integer === true ? '정수' : '유한한 수',
          typeof fieldSpec.min === 'number' ? `${fieldSpec.min} 이상` : null,
          typeof fieldSpec.max === 'number' ? `${fieldSpec.max} 이하` : null,
        ]
          .filter((part) => part !== null)
          .join(' · ');
        return {
          ok: false,
          error: `'${key}' 값이 허용 범위를 벗어났습니다: ${safeErrorText(raw)}`,
          recovery: `'${key}' 에 ${shape} 인 값을 주세요.`,
        };
      }
    }

    if (Array.isArray(fieldSpec.enum) && !fieldSpec.enum.includes(raw)) {
      return {
        ok: false,
        error: `'${key}' 값이 허용 목록에 없습니다: ${safeErrorText(raw)}`,
        recovery: `'${key}' 에 다음 중 하나를 쓰세요: ${fieldSpec.enum.join(', ')}`,
      };
    }

    value[key] = raw;
  }

  return { ok: true, value };
}
