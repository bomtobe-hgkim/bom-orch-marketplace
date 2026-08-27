import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { runGit } from './git.mjs';
import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { errorText } from './util/errors.mjs';
import { compareUtf8 } from './util/strings.mjs';
import { isFullObjectId, WORKTREE_TIMEOUT_MS } from './worktree-patch.mjs';

const MAX_ALLOWLIST_PATHS = 4_000;
const UNNAMED_STEP = '(unnamed step)';
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const UNSAFE_FILE_MODES = new Set(['120000', '160000']);
const WINDOWS_INVALID_COMPONENT_PATTERN = /[<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function validateEvidencePaths(paths, { enforceInputLimit = true } = {}) {
  if (paths === undefined) return { ok: true, paths: null };
  const listInvalid = { ok: false, reasonCode: REASON.worktree_path_list_invalid, params: { limit: MAX_ALLOWLIST_PATHS } };
  if (!Array.isArray(paths)) return listInvalid;
  if (enforceInputLimit && paths.length > MAX_ALLOWLIST_PATHS) return listInvalid;
  const seen = new Set();
  const safe = [];
  for (const path of paths) {
    if (typeof path !== 'string' || path === '') return listInvalid;
    if (path.includes('\0') || path.includes('\ufffd')) {
      return { ok: false, reasonCode: REASON.worktree_path_undecodable, params: {} };
    }
    // Git 경로 권위는 '/'다. '\\'도 거부해야 같은 저장 권위가 Windows/POSIX에서 갈리지 않는다.
    const segments = path.split('/');
    if (isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return { ok: false, reasonCode: REASON.worktree_path_unsafe, params: { path: JSON.stringify(path) } };
    }
    if (seen.has(path)) {
      return { ok: false, reasonCode: REASON.worktree_path_duplicate, params: { path: JSON.stringify(path) } };
    }
    seen.add(path);
    safe.push(path);
  }
  return { ok: true, paths: safe };
}

export function validateMaterializationPaths(paths) {
  const evidence = validateEvidencePaths(paths, { enforceInputLimit: false });
  if (!evidence.ok) return evidence;
  const seenAliases = new Set();
  for (const path of evidence.paths) {
    for (const segment of path.split('/')) {
      if (WINDOWS_INVALID_COMPONENT_PATTERN.test(segment) || segment.endsWith('.') || segment.endsWith(' ') ||
          WINDOWS_DEVICE_BASENAME_PATTERN.test(segment)) {
        return { ok: false, reasonCode: REASON.worktree_path_windows_ambiguous, params: { path: JSON.stringify(path) } };
      }
    }
    const alias = path.normalize('NFC').toLowerCase();
    if (seenAliases.has(alias)) {
      return { ok: false, reasonCode: REASON.worktree_path_duplicate, params: { path: JSON.stringify(path) } };
    }
    seenAliases.add(alias);
  }
  return evidence;
}

function validateRevisionPair(spec) {
  const options = spec ?? {};
  if (!isFullObjectId(options.from) || !isFullObjectId(options.to)) {
    return { ok: false, reasonCode: REASON.worktree_revision_pair_invalid, params: {} };
  }
  const paths = validateEvidencePaths(options.paths);
  if (!paths.ok) return paths;
  return { ok: true, from: options.from, to: options.to, paths: paths.paths };
}

export function parseRawRevisionDelta(stdout) {
  const malformed = { ok: false, reasonCode: REASON.worktree_delta_output_invalid, params: {} };
  if (typeof stdout !== 'string') return malformed;
  if (stdout.includes('\ufffd')) return { ok: false, reasonCode: REASON.worktree_path_undecodable, params: {} };
  if (stdout === '') return { ok: true, entries: [] };
  if (!stdout.endsWith('\0')) return malformed;
  const records = stdout.split('\0');
  records.pop();
  if (records.length % 2 !== 0) return malformed;
  const checkedPaths = validateEvidencePaths(records.filter((_, index) => index % 2 === 1), { enforceInputLimit: false });
  if (!checkedPaths.ok) return checkedPaths;

  const entries = [];
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index];
    const path = records[index + 1];
    const match = /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([AMDT])$/.exec(header);
    if (!match) return malformed;
    const [, oldMode, newMode, oldOid, newOid, code] = match;
    if (oldOid.length !== newOid.length) return malformed;
    if (UNSAFE_FILE_MODES.has(oldMode) || UNSAFE_FILE_MODES.has(newMode)) {
      return { ok: false, reasonCode: REASON.worktree_delta_unsafe_mode, params: { path } };
    }
    const oldRegular = REGULAR_FILE_MODES.has(oldMode);
    const newRegular = REGULAR_FILE_MODES.has(newMode);
    let status;
    if (code === 'A' && oldMode === '000000' && newRegular) status = 'added';
    else if (code === 'D' && oldRegular && newMode === '000000') status = 'deleted';
    else if (code === 'M' && oldRegular && newRegular) status = 'modified';
    else if (code === 'T') return { ok: false, reasonCode: REASON.worktree_delta_type_change, params: { path } };
    else return { ok: false, reasonCode: REASON.worktree_delta_mode_inconsistent, params: { path } };
    entries.push({
      path,
      status,
      oldMode: oldMode === '000000' ? null : oldMode,
      newMode: newMode === '000000' ? null : newMode,
    });
  }
  entries.sort((a, b) => compareUtf8(a.path, b.path));
  return { ok: true, entries };
}

function revisionDiffArgs({ from, to, paths, raw }) {
  const args = [];
  if (paths !== null) args.push('--literal-pathspecs');
  args.push('diff');
  if (raw) args.push('--no-patch', '--raw', '-z', '--no-abbrev');
  else args.push('--binary');
  args.push('--no-renames', from, to);
  if (paths !== null) args.push('--', ...paths);
  return args;
}

/**
 * revision 증거는 worktree 생성 흐름과 독립된 목적 모듈이다. 파일 수명·핸들 권위·commit 생성은
 * 호출자가 주입하고, 이 모듈은 두 immutable revision 사이의 identity/delta/bytes만 결정한다.
 */
export function createWorktreeRevisionOperations({ canonicalHandle, checkHandle, commitAll, diffToBytes, failGit }) {
  async function resolveExactCommit({ run, cwd, revision }) {
    const result = await run({
      args: ['rev-parse', '--verify', `${revision}^{commit}`],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    const commit = result?.ok && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (!isFullObjectId(commit) || commit !== revision) {
      return failGit(REASON.worktree_revision_not_commit, result, { revision });
    }
    return { ok: true, commit };
  }

  async function authenticateRevisionPair({ run, cwd, revisions }) {
    const from = await resolveExactCommit({ run, cwd, revision: revisions.from });
    if (from.blocked) return from;
    const to = await resolveExactCommit({ run, cwd, revision: revisions.to });
    if (to.blocked) return to;
    return { ok: true, from: from.commit, to: to.commit, paths: revisions.paths };
  }

  async function resolveRevisionIdentity({ run, cwd, revision, requireExact = true }) {
    if (requireExact && !isFullObjectId(revision)) return fail(REASON.worktree_revision_invalid);
    const commitResult = await run({
      args: ['rev-parse', '--verify', `${revision}^{commit}`],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    const commit = commitResult?.ok && typeof commitResult.stdout === 'string' ? commitResult.stdout.trim() : '';
    if (!isFullObjectId(commit) || (requireExact && commit !== revision)) {
      return failGit(REASON.worktree_revision_not_commit, commitResult, { revision });
    }
    const treeResult = await run({
      args: ['rev-parse', '--verify', `${commit}^{tree}`],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    const tree = treeResult?.ok && typeof treeResult.stdout === 'string' ? treeResult.stdout.trim() : '';
    if (!isFullObjectId(tree)) return failGit(REASON.worktree_revision_tree_unresolved, treeResult);
    return { ok: true, commit, tree };
  }

  async function snapshotStep(wt, label, deps = {}) {
    const run = deps.run ?? runGit;
    const guard = checkHandle(wt);
    if (guard) return guard;
    const text = typeof label === 'string' && label !== '' ? label : UNNAMED_STEP;
    const previous = wt.lastSnapshot;
    const result = await commitAll({ run, worktreePath: wt.path, label: text });
    if (result.blocked) return result;
    const moved = result.commit !== previous;
    if (!moved) {
      return { ok: true, label: text, commit: previous, previous, changed: false, diff: Buffer.alloc(0), files: [] };
    }
    // 커밋은 되돌릴 수 없으므로 diff가 실패해도 다음 스텝의 기준은 즉시 올린다.
    wt.lastSnapshot = result.commit;
    const diff = await diffToBytes({
      run,
      args: ['diff', '--binary', previous, result.commit],
      cwd: wt.path,
      stateRoot: wt.stateRoot,
    });
    if (diff.failure) return failGit(REASON.worktree_step_diff_failed, diff.failure);
    if (diff.crashed) return fail(REASON.worktree_step_diff_unreadable, { detail: errorText(diff.crashed) });
    const names = await run({
      args: ['diff', '--name-only', '-z', '--no-renames', previous, result.commit],
      cwd: wt.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!names.ok) return failGit(REASON.worktree_step_files_failed, names);
    return {
      ok: true,
      label: text,
      commit: result.commit,
      previous,
      changed: true,
      diff: diff.bytes,
      files: names.stdout.split('\0').filter((entry) => entry !== ''),
    };
  }

  async function revisionIdentity(wt, revision, deps = {}) {
    const paths = await canonicalHandle(wt);
    if (paths.blocked) return paths;
    return resolveRevisionIdentity({ run: deps?.run ?? runGit, cwd: paths.path, revision, requireExact: true });
  }

  async function listRevisionDelta(wt, spec, deps = {}) {
    const paths = await canonicalHandle(wt);
    if (paths.blocked) return paths;
    const revisions = validateRevisionPair(spec);
    if (!revisions.ok) return fail(revisions.reasonCode, revisions.params);
    const run = deps?.run ?? runGit;
    const authenticated = await authenticateRevisionPair({ run, cwd: paths.path, revisions });
    if (authenticated.blocked) return authenticated;
    if (authenticated.paths !== null && authenticated.paths.length === 0) return { ok: true, entries: [] };
    const result = await run({
      args: revisionDiffArgs({ ...authenticated, raw: true }),
      cwd: paths.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    if (!result?.ok) return failGit(REASON.worktree_delta_listing_failed, result);
    const parsed = parseRawRevisionDelta(result.stdout);
    if (!parsed.ok) return fail(parsed.reasonCode, parsed.params);
    if (authenticated.paths !== null) {
      const literals = new Set(authenticated.paths);
      const unexpected = parsed.entries.find((entry) => !literals.has(entry.path));
      if (unexpected !== undefined) {
        return fail(REASON.worktree_delta_path_unexpected, { path: JSON.stringify(unexpected.path) });
      }
    }
    return parsed;
  }

  async function collectPatchAtRevision(wt, spec, deps = {}) {
    const paths = await canonicalHandle(wt);
    if (paths.blocked) return paths;
    const revisions = validateRevisionPair(spec);
    if (!revisions.ok) return fail(revisions.reasonCode, revisions.params);
    const run = deps?.run ?? runGit;
    const delta = await listRevisionDelta(wt, spec, { run });
    if (delta.blocked) return delta;
    if (revisions.paths !== null && revisions.paths.length === 0) {
      const patch = Buffer.alloc(0);
      return { ok: true, patch, files: [], sha256: createHash('sha256').update(patch).digest('hex'), empty: true };
    }
    const patch = await diffToBytes({
      run,
      args: revisionDiffArgs({ ...revisions, raw: false }),
      cwd: paths.path,
      stateRoot: paths.stateRoot,
    });
    if (patch.failure) return failGit(REASON.worktree_revision_patch_failed, patch.failure);
    if (patch.crashed) return fail(REASON.worktree_revision_patch_unreadable, { detail: errorText(patch.crashed) });
    const files = delta.entries.map((entry) => entry.path);
    return {
      ok: true,
      patch: patch.bytes,
      files,
      sha256: createHash('sha256').update(patch.bytes).digest('hex'),
      empty: patch.bytes.length === 0,
    };
  }

  return Object.freeze({
    collectPatchAtRevision,
    listRevisionDelta,
    resolveRevisionIdentity,
    revisionIdentity,
    snapshotStep,
  });
}
