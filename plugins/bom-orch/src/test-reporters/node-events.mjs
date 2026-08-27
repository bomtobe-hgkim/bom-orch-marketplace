const MAX_NAME_CHARS = 1_024;
const MAX_FILE_CHARS = 4_096;
const MAX_FAILURE_TYPE_CHARS = 128;
const MAX_STREAM_CHARS = 8 * 1024 * 1024;
const MAX_PENDING_EVENTS = 20_000;
const RELEVANT = new Set(['test:enqueue', 'test:pass', 'test:fail']);
const KINDS = new Set(['test', 'suite']);

function boundedString(value, limit, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value === '' || value.length > limit || value.includes('\0')) return undefined;
  return value;
}

function boundedInteger(value, { min, max }) {
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function isFileWrapper(data) {
  if (data?.nesting !== 0 || data?.line !== 1 || data?.column !== 1 ||
      typeof data?.name !== 'string' || typeof data?.file !== 'string') return false;
  const name = data.name.replaceAll('\\', '/');
  const file = data.file.replaceAll('\\', '/');
  return file === name || file.endsWith(`/${name}`);
}

function eventIdentity(data) {
  const identity = {
    name: boundedString(data?.name, MAX_NAME_CHARS),
    file: boundedString(data?.file, MAX_FILE_CHARS),
    line: boundedInteger(data?.line, { min: 1, max: 10_000_000 }),
    column: boundedInteger(data?.column, { min: 0, max: 10_000_000 }),
    nesting: boundedInteger(data?.nesting, { min: 0, max: 64 }),
  };
  return Object.values(identity).some((value) => value === undefined) ? null : identity;
}

function projectEvent(event, identity, kind) {
  const type = event?.type?.slice?.('test:'.length);
  const data = event?.data;
  const failureType = type === 'fail'
    ? boundedString(data?.details?.error?.failureType ?? 'unknown', MAX_FAILURE_TYPE_CHARS)
    : type === 'pass' && (data?.skip !== undefined || data?.todo !== undefined)
      ? boundedString(data.skip !== undefined ? 'skip' : 'todo', MAX_FAILURE_TYPE_CHARS)
      : null;
  const projected = {
    type,
    kind,
    ...identity,
    failureType,
  };
  if (Object.values(projected).some((value) => value === undefined)) {
    return { type: 'schema_error', code: 'invalid_event' };
  }
  return projected;
}

const schemaError = (code) => `${JSON.stringify({ type: 'schema_error', code })}\n`;

/**
 * A node's kind, taken from whichever field this Node version supplies it in.
 *
 * Node 24 states it twice: `data.type` on the enqueue and `data.details.type` on the terminal
 * event. Node 22 states it ONCE and only for suites — its enqueue carries no `type` at all, and
 * `details.type` appears only when the node is a suite. Measured on 22.11.0 and 24.18.0 across
 * pass, fail, skip, todo and subtestsFailed:
 *
 *     node 24   enqueue.type 'test' | 'suite'      details.type 'test' | 'suite'
 *     node 22   enqueue.type absent               details.type 'suite', else absent
 *
 * So on node 22 "no details.type on the terminal event" means 'test' exactly. It is a reliable
 * signal, not a guess — which matters, because calling a suite a test would let a childless
 * describe become a source witness.
 */
const enqueueKind = (data) => (KINDS.has(data?.type) ? data.type : null);
const terminalKind = (data) => (KINDS.has(data?.details?.type) ? data.details.type : null);

/**
 * Controller-owned Node test reporter. It consumes only the event iterable Node gives it and emits
 * bounded JSONL. Target output, error bodies, project files, and process environment are never read.
 *
 * Events are buffered and written once the source is exhausted, for two reasons.
 *
 * (1) On node 22 a node's kind is only known at its terminal event, and a suite's terminal event
 *     arrives after all of its children — so the kind cannot be written onto the enqueue line as it
 *     streams. The consumer requires the enqueue and the terminal line to agree on kind, so both
 *     have to be written from the same resolved value.
 * (2) Returning from this generator mid-stream makes node 22 destroy the reporter-destination
 *     duplex, and the test harness rethrows `AbortError: The operation was aborted` and exits 7.
 *     Measured against a real node 22.11 child: the child's whole output was that stack trace.
 *     The CI AbortError was therefore not a separate upstream bug — it was the consequence of
 *     bailing out early. The source is now always drained to completion.
 *
 * Buffering costs nothing downstream: the destination is a file, read only after the child exits.
 * The memory bound is 2 x MAX_PENDING_EVENTS raw event records, not MAX_PENDING_EVENTS: only the
 * enqueue path refuses past the cap, and each tracked node then appends exactly one terminal record
 * (an unmatched terminal sets `failure` instead of pushing). Each record can carry stacks and error
 * objects. MAX_STREAM_CHARS is applied at emission time, after buffering — it bounds what the
 * consumer reads, not this generator's peak memory.
 */
export default async function* nodeEvents(source) {
  const records = [];
  const pending = new Map();
  let terminalCount = 0;
  let streamChars = 0;
  let failure = null;

  for await (const event of source) {
    if (failure !== null) continue;
    if (!RELEVANT.has(event?.type)) continue;
    // Node emits a file-wrapper enqueue that has no matching pass on successful files. It is runner
    // structure, not a source test witness; keeping it would make every ordinary stream incomplete.
    if (isFileWrapper(event.data) && event.type !== 'test:fail') continue;
    const identity = eventIdentity(event.data);
    const key = identity === null ? null : JSON.stringify(identity);

    if (event.type === 'test:enqueue') {
      if (key === null || pending.has(key) || pending.size >= MAX_PENDING_EVENTS ||
          records.length >= MAX_PENDING_EVENTS) {
        failure = 'invalid_event';
        continue;
      }
      pending.set(key, records.length);
      records.push({ event, identity, kind: enqueueKind(event.data) });
      continue;
    }

    const opened = key === null ? undefined : records[pending.get(key)];
    const stated = terminalKind(event.data);
    // Where this Node version states the kind twice, the two must agree; a stream that describes
    // one node as both a test and a suite is not describable, and picking one silently would be
    // the moment a container could become a witness.
    if (opened === undefined || (opened.kind !== null && stated !== null && opened.kind !== stated)) {
      failure = 'invalid_event';
      continue;
    }
    opened.kind = opened.kind ?? stated ?? 'test';
    pending.delete(key);
    records.push({ event, identity, kind: opened.kind });
    terminalCount += 1;
  }

  const lines = [];
  if (failure === null) {
    for (const record of records) {
      const projected = projectEvent(record.event, record.identity, record.kind);
      if (projected.type === 'schema_error') {
        failure = projected.code;
        break;
      }
      const line = `${JSON.stringify(projected)}\n`;
      streamChars += line.length;
      if (streamChars > MAX_STREAM_CHARS) {
        failure = 'stream_too_large';
        break;
      }
      lines.push(line);
    }
  }
  if (failure === null && pending.size !== 0) failure = 'incomplete_event';
  if (failure !== null) {
    yield schemaError(failure);
    return;
  }
  for (const line of lines) yield line;
  yield `${JSON.stringify({ type: 'terminal', count: terminalCount })}\n`;
}
