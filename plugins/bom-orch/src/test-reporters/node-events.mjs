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

/**
 * Controller-owned Node test reporter. It consumes only the event iterable Node gives it and emits
 * bounded JSONL. Target output, error bodies, project files, and process environment are never read.
 */
export default async function* nodeEvents(source) {
  let terminalCount = 0;
  let streamChars = 0;
  const pending = new Map();
  for await (const event of source) {
    if (!RELEVANT.has(event?.type)) continue;
    // Node emits a file-wrapper enqueue that has no matching pass on successful files. It is runner
    // structure, not a source test witness; keeping it would make every ordinary stream incomplete.
    if (isFileWrapper(event.data) && event.type !== 'test:fail') continue;
    const identity = eventIdentity(event.data);
    const key = identity === null ? null : JSON.stringify(identity);
    let kind;
    if (event.type === 'test:enqueue') {
      kind = KINDS.has(event.data?.type) ? event.data.type : undefined;
      if (key !== null && kind !== undefined && !pending.has(key) && pending.size < MAX_PENDING_EVENTS) {
        pending.set(key, kind);
      } else {
        yield `${JSON.stringify({ type: 'schema_error', code: 'invalid_event' })}\n`;
        return;
      }
    } else {
      kind = key === null ? undefined : pending.get(key);
      if (kind === undefined || (event.data?.type !== undefined && event.data.type !== kind)) {
        yield `${JSON.stringify({ type: 'schema_error', code: 'invalid_event' })}\n`;
        return;
      }
      pending.delete(key);
    }
    const projected = projectEvent(event, identity, kind);
    if (projected.type === 'pass' || projected.type === 'fail') terminalCount += 1;
    const line = `${JSON.stringify(projected)}\n`;
    streamChars += line.length;
    if (streamChars > MAX_STREAM_CHARS) {
      yield `${JSON.stringify({ type: 'schema_error', code: 'stream_too_large' })}\n`;
      return;
    }
    yield line;
  }
  if (pending.size !== 0) {
    yield `${JSON.stringify({ type: 'schema_error', code: 'incomplete_event' })}\n`;
    return;
  }
  yield `${JSON.stringify({ type: 'terminal', count: terminalCount })}\n`;
}
