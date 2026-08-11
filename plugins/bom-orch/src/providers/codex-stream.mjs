/**
 * codex 의 `exec --json` (JSONL) 출력을 읽는다.
 *
 * 성공 경로를 실행해서 캡처하지 못한 상태에서 썼다(사용량 한도). 그래서 정본 소스
 * `codex-rs/exec/src/exec_events.rs` (태그 rust-v0.146.1) 의 serde 정의에서 유도했고,
 * 유도 근거는 test/captures/codex-events-schema.md 에 적어 뒀다. 오류 경로는 실측이다.
 */

/** 정본 소스의 ThreadEvent 8종. */
const KNOWN_EVENTS = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

/** 정본 소스의 ThreadItemDetails 9종. */
const KNOWN_ITEMS = new Set([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'collab_tool_call',
  'web_search',
  'todo_list',
  'error',
]);

/** 한 줄을 읽는다. 절대 throw 하지 않는다. */
export function parseCodexLine(line) {
  // 문자열화 자체가 던질 수 있다(toString 이 던지는 객체). "절대 throw 하지 않는다"는
  // 조건 없는 약속이어야 하므로 강제 변환도 감싼다.
  let raw;
  try {
    raw = typeof line === 'string' ? line : String(line ?? '');
  } catch {
    return { ok: false, raw: '' };
  }
  try {
    const record = JSON.parse(raw);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return { ok: false, raw };
    return { ok: true, record };
  } catch {
    return { ok: false, raw };
  }
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

/**
 * turn.completed 의 usage 를 읽는다.
 *
 * codex 의 Usage 는 5개 필드가 전부 항상 직렬화되고 기본값이 0 이다. 그래서 여기서는
 * 0 과 "모름"이 구조적으로 구분되지 않는다 — claude 쪽과 다르다. 필드가 아예 없으면
 * 그건 형식이 바뀐 것이므로 null 로 남겨 드러나게 한다.
 */
function readUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: intOrNull(usage.input_tokens),
    cachedInputTokens: intOrNull(usage.cached_input_tokens),
    cacheWriteInputTokens: intOrNull(usage.cache_write_input_tokens),
    outputTokens: intOrNull(usage.output_tokens),
    reasoningOutputTokens: intOrNull(usage.reasoning_output_tokens),
  };
}

/**
 * ThreadItem 을 우리 모양으로. details 가 flatten 이라 type 과 필드가 같은 층에 있다.
 *
 * ★ 아래 고정 필드는 9종 중 4종(agent_message, reasoning, command_execution, error)만
 *   덮는다. 나머지 5종(file_change, mcp_tool_call, collab_tool_call, web_search,
 *   todo_list)의 도메인 페이로드는 여기에 담을 자리가 없다 — 그런데 그 타입들은
 *   "아는 타입"이라 unknownTypes 에도 안 잡힌다. 즉 조용한 데이터 손실이 된다.
 *
 *   타입마다 필드를 늘리는 대신 원본을 그대로 들고 간다. 파서가 벤더 스키마의
 *   모든 가지를 미리 알아야 할 이유가 없고, 나중에 이 값을 쓰는 쪽이 필요한 것을
 *   꺼내 쓰면 된다. 고정 필드는 자주 쓰는 것에 대한 편의일 뿐이다.
 */
function readItem(item) {
  return {
    raw: item,
    id: typeof item.id === 'string' ? item.id : null,
    type: item.type,
    text: typeof item.text === 'string' ? item.text : null,
    command: typeof item.command === 'string' ? item.command : null,
    output: typeof item.aggregated_output === 'string' ? item.aggregated_output : null,
    // ★ Option<i32> 인데 skip_serializing_if 가 없어 실행 중에는 실제로 null 이 온다.
    //   0 으로 뭉개면 "성공했다"가 된다.
    exitCode: intOrNull(item.exit_code),
    status: typeof item.status === 'string' ? item.status : null,
    message: typeof item.message === 'string' ? item.message : null,
  };
}

/**
 * 스트림 전체를 읽는다.
 *
 * @param text JSONL. 부분·비JSON·모르는 타입이 섞여 있어도 된다.
 */
export function collectCodexStream(text) {
  const order = [];
  const byId = new Map();
  const errors = [];
  const unknownTypes = new Set();
  const unparsableLines = [];
  let threadId = null;
  let usage = null;
  let turnStatus = null;
  let lastAnswer = null;

  let source;
  try {
    source = typeof text === 'string' ? text : String(text ?? '');
  } catch {
    // parseCodexLine 과 같은 이유. 강제 변환이 던지면 빈 스트림으로 본다.
    source = '';
  }

  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === '') continue;

    const parsed = parseCodexLine(line);
    if (!parsed.ok) {
      unparsableLines.push(parsed.raw);
      continue;
    }

    const record = parsed.record;
    if (!KNOWN_EVENTS.has(record.type)) {
      unknownTypes.add(String(record.type));
      continue;
    }

    if (record.type === 'thread.started') {
      threadId = typeof record.thread_id === 'string' ? record.thread_id : null;
      continue;
    }
    if (record.type === 'turn.completed') {
      turnStatus = 'completed';
      usage = readUsage(record.usage);
      continue;
    }
    if (record.type === 'turn.failed') {
      turnStatus = 'failed';
      // ★ 여기는 한 겹 감싸여 있다. 아래 최상위 error 는 평평하다.
      const message = record.error?.message;
      if (typeof message === 'string') errors.push({ source: 'turn.failed', message });
      continue;
    }
    if (record.type === 'error') {
      // ★ 여기는 message 가 루트에 있다. 같은 ThreadErrorEvent 인데 직렬화 위치가
      //   다르다 — 한 경로만 보는 구현은 나머지 오류를 조용히 놓친다.
      if (typeof record.message === 'string') errors.push({ source: 'error', message: record.message });
      continue;
    }

    // 남은 것은 item.started / item.updated / item.completed.
    const item = record.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      // item.* 인데 item 이 객체가 아니면 형식이 깨진 것이다. 조용히 넘기면 진단
      // 단서가 아무 데도 안 남는다 — 읽지 못한 줄로 기록한다.
      unparsableLines.push(line);
      continue;
    }

    if (!KNOWN_ITEMS.has(item.type)) {
      unknownTypes.add(`item:${item.type}`);
      continue;
    }

    const shaped = readItem(item);

    // ★ agent_message 와 reasoning 은 item.started 가 아예 안 온다. started 를
    //   기다렸다 짝을 맞추면 답변을 영영 못 본다. completed 만으로 성립해야 한다.
    if (record.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      // 중간 코멘터리와 최종 답변을 구분하는 필드가 없다. codex 자신도 final_message 를
      // 매번 덮어쓴다 — 마지막 것이 답이다.
      lastAnswer = item.text;
    }
    if (record.type === 'item.completed' && item.type === 'error' && typeof item.message === 'string') {
      // 치명적이지 않은 오류가 아이템으로 온다. 턴을 실패시키지는 않는다.
      errors.push({ source: 'item', message: item.message });
    }

    const key = shaped.id ?? `${item.type}:${order.length}`;
    if (byId.has(key)) {
      // 나중 상태가 이긴다. started 로 만든 항목을 completed 가 갱신한다.
      // null 로 기존 값을 덮지 않는다. 지금 벤더는 started/updated/completed 마다
      // 전체 필드를 다 보내지만(정본 소스 확인), 그 전제에 기대지 않는다 — 부분 갱신이
      // 한 번이라도 오면 알고 있던 값이 조용히 null 로 지워진다. 형제 파서
      // (claude-stream.mjs)도 받은 필드만 건드린다.
      const existing = byId.get(key);
      for (const [k, v] of Object.entries(shaped)) {
        if (v === null || v === undefined) continue;
        if (k === 'raw') {
          // ★ raw 는 통째로 갈아끼우면 안 된다. raw 는 절대 null 이 아니므로 위의
          //   null 보호가 통하지 않고, 매번 새 객체로 덮인다. 그런데 이름 붙은 필드에
          //   자리가 없는 5종(file_change, mcp_tool_call, collab_tool_call,
          //   web_search, todo_list)은 raw 가 **유일한** 보호막이다. 벤더가 완료
          //   이벤트를 더 가볍게 보내면 started 때 알던 changes·arguments 가 조용히
          //   사라진다(리뷰어 실측). 얕게 합친다.
          existing.raw = { ...existing.raw, ...v };
          continue;
        }
        existing[k] = v;
      }
    } else {
      byId.set(key, shaped);
      order.push(shaped);
    }
  }

  return {
    text: lastAnswer ?? '',
    items: order,
    usage,
    threadId,
    errors,
    turnStatus,
    unknownTypes: [...unknownTypes].sort(),
    unparsableLines,
  };
}
