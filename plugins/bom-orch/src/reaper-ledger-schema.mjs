import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { parseStrictJson } from './util/strict-json.mjs';

const LEDGER = 'children.json';
export const CHILDREN_SCHEMA_VERSION = 2;
export const CHILDREN_LEDGER_MAX_BYTES = 1024 * 1024;
const EFFECT_INTENT_RECORD_TYPE = 'effect_unknown_intent';
export const WORKTREE_AUTHORITY_RECORD_TYPE = 'worktree_creation_authority';
export const WORKTREE_SCOPE_CLAIM_RECORD_TYPE = 'worktree_effect_claim';
export const WORKTREE_AUTHORITY_VERSION = 1;
export const WORKTREE_SCOPE_CLAIM_VERSION = 1;
const EFFECT_INTENT_TOKEN = /^[0-9a-f]{64}$/;
const WORKTREE_AUTHORITY_TOKEN = /^[0-9a-f]{64}$/;
const WORKTREE_CLAIM_TOKEN = /^[0-9a-f]{64}$/;
const WORKTREE_SCOPE_CLAIM_SCHEMA_VERSION = 2;

const ledgerPath = (stateRoot) => join(stateRoot, LEDGER);
const sameFileIdentity = (left, right) => ['dev', 'ino', 'birthtimeMs'].every((key) =>
  String(left?.[key]) === String(right?.[key]));

async function readLedgerBytes(stateRoot, deps) {
  const path = ledgerPath(stateRoot);
  if (typeof deps?.readFile === 'function') {
    try {
      const raw = await deps.readFile(path, 'utf8');
      const bytes = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'utf8');
      return bytes.length <= CHILDREN_LEDGER_MAX_BYTES
        ? { status: 'read', bytes }
        : { status: 'unreadable' };
    } catch (error) {
      return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
  }

  let before;
  let handle;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() ||
        before.size > BigInt(CHILDREN_LEDGER_MAX_BYTES)) return { status: 'unreadable' };
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    handle = await open(path, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened) ||
        opened.size > BigInt(CHILDREN_LEDGER_MAX_BYTES)) return { status: 'unreadable' };

    const buffer = Buffer.allocUnsafe(CHILDREN_LEDGER_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length <= CHILDREN_LEDGER_MAX_BYTES
      ? { status: 'read', bytes: Buffer.from(buffer.subarray(0, length)) }
      : { status: 'unreadable' };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

const hasSchemaVersion = (value) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.hasOwn(value, 'schemaVersion');

/** JSON.parse가 큰 양의 정수를 +Infinity로 반올림해도 JSON-safe 진단값을 남긴다. */
function schemaVersionOf(value) {
  if (!hasSchemaVersion(value)) return null;
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion >= 0) return value.schemaVersion;
  return value.schemaVersion === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : null;
}

const validRecord = (value) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Number.isInteger(value.pid) && value.pid > 0;
const purposeOf = (value) => typeof value === 'string' && value !== '' && value.length <= 128
  ? value : null;
const retainUntilOf = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** pre-call recovery intent는 process kill 권위가 아니라 worktree 보존 권위다. */
export function isEffectUnknownIntentRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    record.recordType === EFFECT_INTENT_RECORD_TYPE &&
    typeof record.intentToken === 'string' && EFFECT_INTENT_TOKEN.test(record.intentToken) &&
    Number.isInteger(record.pid) && record.pid > 0 &&
    typeof record.runId === 'string' && record.runId !== '' &&
    typeof record.worktree === 'string' && record.worktree !== '' && isAbsolute(record.worktree) &&
    typeof record.projectPath === 'string' && record.projectPath !== '' && isAbsolute(record.projectPath) &&
    retainUntilOf(record.retainUntil) !== null;
}

const declaresEffectUnknownIntent = (record) => record !== null && typeof record === 'object' &&
  !Array.isArray(record) && (record.recordType === EFFECT_INTENT_RECORD_TYPE ||
    Object.hasOwn(record, 'intentToken'));

/** 생성 전 durable authority와 그 promote/handoff 후속 행을 엄격히 식별한다. */
export function isWorktreeCreationAuthorityRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    (record.recordType === undefined || record.recordType === WORKTREE_AUTHORITY_RECORD_TYPE &&
      record.worktreeAuthorityVersion === WORKTREE_AUTHORITY_VERSION) &&
    typeof record.worktreeAuthorityToken === 'string' &&
    WORKTREE_AUTHORITY_TOKEN.test(record.worktreeAuthorityToken) &&
    Number.isInteger(record.pid) && record.pid > 0 &&
    typeof record.startTime === 'string' && record.startTime !== '' &&
    typeof record.runId === 'string' && record.runId !== '' &&
    record.ownerPid === record.pid && record.ownerStartTime === record.startTime &&
    record.spawnfile === null &&
    typeof record.worktree === 'string' && record.worktree !== '' && isAbsolute(record.worktree) &&
    typeof record.projectPath === 'string' && record.projectPath !== '' && isAbsolute(record.projectPath) &&
    (record.purpose === null || purposeOf(record.purpose) !== null) &&
    (record.retainUntil === null || retainUntilOf(record.retainUntil) !== null);
}

const declaresWorktreeCreationAuthority = (record) => record !== null && typeof record === 'object' &&
  !Array.isArray(record) && (record.recordType === WORKTREE_AUTHORITY_RECORD_TYPE ||
    Object.hasOwn(record, 'worktreeAuthorityVersion') ||
    Object.hasOwn(record, 'worktreeAuthorityToken') || record.purpose === 'worktree_creation_pending');

const declaresWorktreeScopeClaim = (record) => record !== null && typeof record === 'object' &&
  !Array.isArray(record) && (record.recordType === WORKTREE_SCOPE_CLAIM_RECORD_TYPE ||
    ['worktreeClaimVersion', 'claimToken', 'claimKind', 'authorityToken', 'helperPid',
      'helperStartTime', 'helperState', 'effectState'].some((key) => Object.hasOwn(record, key)));

export function isWorktreeScopeClaimRecord(record) {
  const noHelper = record?.helperPid === null && record?.helperStartTime === null &&
    record?.helperState === 'none' && record?.effectState === 'none';
  const exactHelper = Number.isInteger(record?.helperPid) && record.helperPid > 0 &&
    typeof record.helperStartTime === 'string' && record.helperStartTime !== '' && (
      record.helperState === 'waiting' && record.effectState === 'none' ||
      record.helperState === 'started' && record.effectState === 'may_have_started' ||
      record.helperState === 'settled' && record.effectState === 'settled'
    );
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    record.recordType === WORKTREE_SCOPE_CLAIM_RECORD_TYPE &&
    record.worktreeClaimVersion === WORKTREE_SCOPE_CLAIM_VERSION &&
    typeof record.claimToken === 'string' && WORKTREE_CLAIM_TOKEN.test(record.claimToken) &&
    (record.claimKind === 'create' || record.claimKind === 'cleanup') &&
    Number.isInteger(record.pid) && record.pid > 0 &&
    typeof record.startTime === 'string' && record.startTime !== '' &&
    record.ownerPid === record.pid && record.ownerStartTime === record.startTime &&
    typeof record.runId === 'string' && record.runId !== '' &&
    typeof record.worktree === 'string' && record.worktree !== '' && isAbsolute(record.worktree) &&
    typeof record.projectPath === 'string' && record.projectPath !== '' && isAbsolute(record.projectPath) &&
    (record.claimKind === 'cleanup' && record.authorityToken === null ||
      typeof record.authorityToken === 'string' && WORKTREE_AUTHORITY_TOKEN.test(record.authorityToken)) &&
    (noHelper || exactHelper);
}

/** 알 수 없는 시계는 보존을 낮출 근거가 아니므로 fail-closed로 retained다. */
export function recordIsRetained(record, nowMs) {
  const until = Math.max(
    retainUntilOf(record?.retainUntil) ?? -1,
    retainUntilOf(record?.intentRetainUntil) ?? -1,
  );
  return until >= 0 && (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs < until);
}

function versionSkew(schemaVersion) {
  return { status: 'version_skew', schemaVersion, stateSchema: {
    file: LEDGER, status: 'newer', found: schemaVersion, supported: CHILDREN_SCHEMA_VERSION,
  } };
}

/** ENOENT만 legacy 빈 목록이며, 그 밖의 오류는 mutation을 막는 unreadable이다. */
export async function readLedger(stateRoot, deps = {}) {
  const loaded = await readLedgerBytes(stateRoot, deps);
  if (loaded.status === 'missing') return { status: 'legacy', schemaVersion: 0, records: [] };
  if (loaded.status !== 'read') return { status: 'unreadable', schemaVersion: null, records: [] };
  const document = parseStrictJson(loaded.bytes);
  if (!document.ok || !Array.isArray(document.value)) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  const parsed = document.value;
  if (parsed.some((value) => hasSchemaVersion(value) && schemaVersionOf(value) === null)) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  const schema = parsed.reduce((highest, value) => {
    const version = schemaVersionOf(value);
    return version !== null && version > highest ? version : highest;
  }, 0);
  if (schema > CHILDREN_SCHEMA_VERSION) return { ...versionSkew(schema), records: [] };
  if (schema < WORKTREE_SCOPE_CLAIM_SCHEMA_VERSION && parsed.some((value) =>
    !hasSchemaVersion(value) && declaresWorktreeScopeClaim(value))) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  // 아는 버전의 header는 정확히 metadata 한 필드다. record형 필드를 붙인 header를
  // 실행 행으로도 해석하면 그 pid가 kill 권위가 되므로 문서 전체를 닫는다.
  if (parsed.some((value) => hasSchemaVersion(value) &&
      Object.keys(value).some((key) => key !== 'schemaVersion'))) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  // A row that declares a typed recovery record must validate as that exact type.
  // Otherwise a corrupt intent could fall through as a legacy child and acquire kill authority.
  if (parsed.some((value) => !hasSchemaVersion(value) && value !== null &&
      typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'recordType') &&
      !isEffectUnknownIntentRecord(value) && !isWorktreeCreationAuthorityRecord(value) &&
      !isWorktreeScopeClaimRecord(value))) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  if (parsed.some((value) => !hasSchemaVersion(value) && declaresEffectUnknownIntent(value) &&
      !isEffectUnknownIntentRecord(value))) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  // 생성 authority를 선언한 행도 exact type으로만 읽는다. 손상된 token/identity가 generic
  // pid 행으로 떨어지면 kill 또는 worktree reclaim 권위를 얻으므로 문서 전체를 닫는다.
  if (parsed.some((value) => !hasSchemaVersion(value) && declaresWorktreeCreationAuthority(value) &&
      !isWorktreeCreationAuthorityRecord(value))) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  if (parsed.some((value) => !hasSchemaVersion(value) && declaresWorktreeScopeClaim(value) &&
      !isWorktreeScopeClaimRecord(value))) {
    return { status: 'unreadable', schemaVersion: null, records: [] };
  }
  return {
    status: schema === CHILDREN_SCHEMA_VERSION ? 'current' : 'legacy',
    schemaVersion: schema,
    records: parsed.filter((value) => !hasSchemaVersion(value)).filter(validRecord),
  };
}

export async function readRecords(stateRoot) {
  return (await readLedger(stateRoot)).records;
}
