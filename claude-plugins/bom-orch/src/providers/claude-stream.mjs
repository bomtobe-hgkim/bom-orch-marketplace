/**
 * claude 의 `--output-format stream-json` (NDJSON) 출력을 읽는다.
 *
 * 커밋된 캡처(test/captures/claude-stream-*.jsonl, claude-code 2.1.223)에 대해 검증한다.
 * 이 모듈의 함정 세 개는 전부 실측으로 확인한 것이다 — 아래 주석 참고.
 */

/**
 * 우리가 의미를 아는 최상위 타입. 그 밖은 견디되 기록한다.
 *
 * ★ `rate_limit_event` 는 이 집합에 **있으면서 핸들러가 없었다** — 드리프트로도 안 잡히고 구조화된
 *   `rate_limit_info` 는 버려져, 막는 한도가 보이지 않았다(WS2 §3.1). 아는 타입인데 아무도 읽지
 *   않는 것은 모르는 것보다 나쁘다: 신호가 있다는 착각을 준다.
 */
const KNOWN_TYPES = new Set(['system', 'assistant', 'user', 'result', 'rate_limit_event']);

/**
 * 아는 system 서브타입.
 *
 * 드리프트 감지기를 최상위 type 에만 걸면 실제로 드리프트가 관측된 자리를 놓친다 —
 * `system/thinking_tokens` 는 설계 때 몰랐던 **서브타입**이었고, 최상위 type 은
 * 이미 알던 `system` 이라 아무 신호도 남지 않았을 것이다.
 */
const KNOWN_SYSTEM_SUBTYPES = new Set(['init', 'hook_started', 'hook_response', 'thinking_tokens']);

/**
 * 아는 content 블록 타입.
 *
 * `thinking` 은 일부러 본문에서 뺀다 — 델리게이트의 사고 과정이지 답이 아니다.
 * 그래도 여기 등재하는 이유는 "알고 있어서 뺀다"와 "몰라서 흘렸다"가 다르기 때문이다.
 * 등재되지 않은 블록 타입은 조용히 사라지지 않고 드리프트로 기록된다.
 */
const KNOWN_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'thinking']);

/** 한 줄을 읽는다. 절대 throw 하지 않는다. */
export function parseStreamLine(line) {
  const raw = typeof line === 'string' ? line : String(line ?? '');
  try {
    const record = JSON.parse(raw);
    // "3", "null", "[]" 도 유효한 JSON 이다. 그대로 통과시키면 record.type 접근에서 터진다.
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return { ok: false, raw };
    return { ok: true, record };
  } catch {
    // 벤더가 경고를 stdout 에 흘리거나 마지막 줄이 잘려서 도착할 수 있다. 여기서
    // 던지면 이미 받은 결과까지 통째로 잃는다.
    return { ok: false, raw };
  }
}

function positiveOrNull(value) {
  // 0 은 "안 썼다", null 은 "모른다". 비용 신호에서 다른 뜻이라 뭉개면 안 된다.
  return Number.isInteger(value) ? value : null;
}

/**
 * result 라인에서 usage 를 꺼낸다.
 *
 * ★ 라인별로 합산하지 않는다. 실측(캡처): assistant 라인의 output_tokens 를 더하면 5,
 *   result 의 값은 202 다. result 의 usage 는 이미 iterations 로 집계된 값이고
 *   assistant 라인의 값은 턴 하나의 부분값이라, 더하면 40배 과소집계가 된다.
 */
export function extractUsage(record) {
  const usage = record?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: positiveOrNull(usage.input_tokens),
    outputTokens: positiveOrNull(usage.output_tokens),
    cacheCreationInputTokens: positiveOrNull(usage.cache_creation_input_tokens),
    cacheReadInputTokens: positiveOrNull(usage.cache_read_input_tokens),
  };
}

/** `resetsAt` 를 벽시계 시각으로 옮길 수 있는 창 — epoch **초**로 읽히는 값만. 아래 WHY 참고. */
const RESET_EPOCH_SECONDS_MIN = 1e9;
const RESET_EPOCH_SECONDS_MAX = 1e11;
/** 옮길 수 없는 값의 닫힌 어휘. 벤더의 수를 그대로 내보내지 않는다 — 0 은 시각이 아니다. */
export const RATE_LIMIT_RESET_UNKNOWN = 'unknown';

/**
 * `rate_limit_event` 의 수 둘을 **알림 하나가 쓸 모양**으로 접는다(WS4b 태스크 7, 스펙 §0-RL).
 *
 * ★ 파서는 여전히 판단하지 않는다. 무엇이 "막힘" 인지는 오류 카탈로그가 정하고(위 `rateLimit` 은
 *   구조화된 그대로 나간다), 여기서 하는 것은 **모양 정규화**뿐이다.
 * ★★ (최종 폴리시, 라이브 캡처 2026-08-25) 태스크 7 은 캡처 하나(`0.25`)로는 25%·0.25% 를 못 갈라
 *   utilization 을 그대로 날랐다. 라이브 캡처가 `0.58`=58% 를 실측했으므로 0..1 분수 창 안의 값은
 *   `Math.round(x*100)+' percent'` 로 편다(로케일 없음). 창 밖(음수·1 초과)은 척도를 여전히 모르므로
 *   옛 문구를 원값에 그대로 붙여 정직하게 나른다 — fail-safe, 지우지 않는다.
 * ★ `resetsAt` 는 그대로다: epoch 초로 읽히는 창 안의 값만 UTC 순간으로, 그 밖은 `RATE_LIMIT_RESET_UNKNOWN`.
 *   `toISOString` 은 언제나 UTC 라 로케일을 안 탄다.
 */
export function rateLimitFacts(rateLimit) {
  const utilization = rateLimit?.utilization;
  // 수치가 없으면 접을 것이 없다 — `null` 은 "알림 없음" 이다(대부분의 실행이 여기다).
  if (!Number.isFinite(utilization)) return null;
  const resetsAt = rateLimit?.resetsAt;
  const movable = Number.isFinite(resetsAt) && resetsAt >= RESET_EPOCH_SECONDS_MIN && resetsAt < RESET_EPOCH_SECONDS_MAX;
  const isFraction = utilization >= 0 && utilization <= 1;
  const utilizationText = isFraction ? `${Math.round(utilization * 100)} percent` : `${utilization} on the scale that CLI uses`;
  return { utilization: utilizationText, resetsAt: movable ? new Date(resetsAt * 1000).toISOString() : RATE_LIMIT_RESET_UNKNOWN };
}

/** 출력이 상한에 잘렸는가. 잘린 답을 성공으로 보고하면 학습이 잘못된 보상을 받는다. */
export function isTruncated(collected) {
  return collected?.stopReason === 'max_tokens' || collected?.subtype === 'error_max_turns';
}

/**
 * 스트림 전체를 읽는다.
 *
 * @param text NDJSON 텍스트. 부분·비JSON·모르는 타입이 섞여 있어도 된다.
 */
export function collectStream(text) {
  const assistantText = [];
  const toolOrder = [];
  const toolById = new Map();
  const unknownTypes = new Set();
  const unparsableLines = [];
  let lastResult = null;
  let rateLimit = null;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;

    const parsed = parseStreamLine(line);
    if (!parsed.ok) {
      unparsableLines.push(parsed.raw);
      continue;
    }

    const record = parsed.record;
    if (!KNOWN_TYPES.has(record.type)) {
      // 벤더가 라인 하나 추가할 때마다 죽는 파서는 못 쓴다. 견디되 기록해서
      // 형식 변화가 조용히 지나가지 않게 한다(Task 20 이 실제 실행에 대해 확인).
      unknownTypes.add(String(record.type));
      continue;
    }

    if (record.type === 'result') {
      lastResult = record;
      continue;
    }

    if (record.type === 'rate_limit_event') {
      // 마지막 것이 지금 상태다 — 벤더는 실행 중에 여러 번 보낸다(캡처: allowed_warning).
      const info = record.rate_limit_info;
      if (info !== null && typeof info === 'object' && !Array.isArray(info)) rateLimit = info;
      continue;
    }

    if (record.type === 'system' && !KNOWN_SYSTEM_SUBTYPES.has(String(record.subtype))) {
      unknownTypes.add(`system/${record.subtype}`);
      continue;
    }

    // ★ tool_result 는 최상위가 아니라 type:"user" 의 message.content[] 안에 있다(실측).
    //   최상위에서 찾는 구현은 아무것도 못 찾는다.
    const content = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const block of content) {
      if (typeof block?.type === 'string' && !KNOWN_BLOCK_TYPES.has(block.type)) {
        // 블록 타입도 드리프트가 날 수 있는 자리다. 모르는 블록을 조용히 흘리면
        // 벤더가 새 블록에 본문을 담기 시작해도 "델리게이트가 빈손으로 돌아왔다"는
        // 증상만 남는다.
        unknownTypes.add(`content:${block.type}`);
        continue;
      }

      if (block?.type === 'text' && typeof block.text === 'string') {
        assistantText.push(block.text);
      } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
        if (!toolById.has(block.id)) {
          const entry = { id: block.id, name: block.name ?? null, input: block.input ?? null, result: null };
          toolById.set(block.id, entry);
          toolOrder.push(entry);
        }
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        // 도착 순서가 아니라 id 로 짝짓는다. 병렬 도구 호출은 순서가 뒤바뀌어 온다.
        const entry = toolById.get(block.tool_use_id);
        if (entry) entry.result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      }
    }
  }

  // 최종 텍스트는 result 가 권위다. 없으면(중간에 죽은 경우) 지금까지 받은 것이라도 건진다.
  const resultText = typeof lastResult?.result === 'string' ? lastResult.result : null;

  return {
    text: resultText ?? assistantText.join(''),
    toolUses: toolOrder,
    usage: lastResult ? extractUsage(lastResult) : null,
    // ★ 파싱만 하고 **아무도 안 읽는다.** 설계 §5.4 의 "비어 있지 않으면 그 스텝은 실패" 규칙은
    //   §12.0 이 뒤집었다 — 목록 밖 명령이 실행되는데도 `permission_denials: []` 인 경우가
    //   실측됐다. 그래서 이 값으로 스텝을 실패시키지 않고, 라이브 진단용으로만 남긴다.
    permissionDenials: Array.isArray(lastResult?.permission_denials) ? lastResult.permission_denials : [],
    // ★ 구조화된 그대로 들고 간다. 무엇이 "막힘" 인지는 오류 카탈로그가 정한다 — 파서가 그 판단을
    //   하면 같은 규칙이 두 곳에 살게 된다.
    rateLimit,
    stopReason: lastResult?.stop_reason ?? null,
    subtype: lastResult?.subtype ?? null,
    isError: lastResult?.is_error === true,
    numTurns: Number.isInteger(lastResult?.num_turns) ? lastResult.num_turns : null,
    unknownTypes: [...unknownTypes].sort(),
    unparsableLines,
  };
}
