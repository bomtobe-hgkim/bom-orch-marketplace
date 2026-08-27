import { fork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGit } from './git.mjs';
import { defaultGetStartTime } from './process-identity.mjs';
import { REASON } from './reason-codes.mjs';
import {
  attachWorktreeClaimHelper,
  clearWorktreeClaimHelper,
  clearWaitingWorktreeClaimHelper,
  markWorktreeClaimHelperSettled,
  markWorktreeClaimHelperStarted,
} from './worktree-scope-claim.mjs';

const HELPER_ARG = '--worktree-effect-helper';
const READY_TIMEOUT_MS = 10_000;
const DEFAULT_EFFECT_TIMEOUT_MS = 300_000;
const RESULT_RESERVE_MS = 2_000;
const MAX_RESULT_TEXT = 1024 * 1024;
const keepAlive = new Set();

const rejected = (status) => ({
  ok: false,
  stdout: '',
  stderr: status,
  exitCode: null,
  failed: true,
  timedOut: false,
  reasonCode: null,
  stderrTail: status,
});

function normalizeBudget(value) {
  if (value === undefined) {
    return { timeoutMs: DEFAULT_EFFECT_TIMEOUT_MS, deadlineAt: null, clock: null };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0 ||
      !Number.isSafeInteger(value.deadlineAt) || value.deadlineAt <= 0 ||
      typeof value.clock !== 'function') return null;
  return { timeoutMs: Math.min(value.timeoutMs, DEFAULT_EFFECT_TIMEOUT_MS),
    deadlineAt: value.deadlineAt, clock: value.clock };
}

function deadlineRemainingMs(budget) {
  if (budget.deadlineAt === null) return Number.POSITIVE_INFINITY;
  let now;
  try { now = budget.clock(); } catch { return 0; }
  if (!Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor(budget.deadlineAt - now));
}

function protocolWaitMs(budget, maximum = READY_TIMEOUT_MS) {
  return Math.min(maximum, deadlineRemainingMs(budget));
}

function effectTimeoutMs(budget) {
  const deadlineRemaining = deadlineRemainingMs(budget);
  const remaining = Math.min(budget.timeoutMs, deadlineRemaining);
  if (remaining <= 0) return 0;
  // When the absolute deadline, rather than the per-effect cap, is the limiting term, leave a
  // bounded tail for durable settled/result/close reconciliation. A separate cap already leaves
  // that headroom and is passed through unchanged.
  if (budget.deadlineAt !== null && deadlineRemaining <= budget.timeoutMs) {
    const reserve = Math.min(RESULT_RESERVE_MS, Math.max(1, Math.floor(remaining / 4)));
    return Math.max(1, remaining - reserve);
  }
  return remaining;
}

function optionsFor(claim, operation, timeoutMs = DEFAULT_EFFECT_TIMEOUT_MS) {
  if (claim === null || typeof claim !== 'object' || !isAbsolute(claim.worktree ?? '') ||
      !isAbsolute(claim.projectPath ?? '') || operation === null || typeof operation !== 'object' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_EFFECT_TIMEOUT_MS) return null;
  if (operation.kind === 'remove' && Object.keys(operation).length === 1) {
    return { args: ['worktree', 'remove', '--force', claim.worktree], cwd: claim.projectPath, timeoutMs };
  }
  if (operation.kind === 'add' && Object.keys(operation).every((key) => key === 'kind' || key === 'revision') &&
      typeof operation.revision === 'string' && operation.revision !== '') {
    return {
      args: ['worktree', 'add', '-q', '--detach', claim.worktree, operation.revision],
      cwd: claim.projectPath,
      timeoutMs,
    };
  }
  return null;
}

function validResult(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.ok === 'boolean' && typeof value.stdout === 'string' && typeof value.stderr === 'string' &&
    value.stdout.length <= MAX_RESULT_TEXT && value.stderr.length <= MAX_RESULT_TEXT;
}

const waitForMessage = (child, accept, timeoutMs = READY_TIMEOUT_MS) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.off('message', onMessage);
    child.off('error', onError);
    child.off('exit', onExit);
    resolve(value);
  };
  const onMessage = (message) => { if (accept(message)) finish(message); };
  const onError = () => finish(null);
  const onExit = () => finish(null);
  const timer = setTimeout(() => finish(null), timeoutMs);
  child.on('message', onMessage);
  child.once('error', onError);
  child.once('exit', onExit);
});

const observeClose = (child) => new Promise((resolve) => {
  child.once('close', (code, signal) => resolve({ closed: true, code, signal }));
});

const waitForObservedClose = ({ closePromise, timeoutMs = READY_TIMEOUT_MS }) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish({ closed: false }), timeoutMs);
  closePromise.then(finish, () => finish({ closed: false }));
});

const sendIpc = (child, message, timeoutMs = READY_TIMEOUT_MS) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  try {
    child.send(message, (error) => finish(error == null));
  } catch {
    finish(false);
  }
});

async function exactHelperAbsent(getStartTime, helper) {
  let observed;
  try {
    observed = await getStartTime(helper.pid);
  } catch {
    return false;
  }
  return observed === null || typeof observed === 'string' && observed !== helper.startTime;
}

/**
 * Production effects run in a gated process group. Tests may inject `run` to exercise Git result
 * branches without spawning; that seam is never selected by an un-injected production caller.
 */
export async function runClaimedGitEffect({ claim, operation, deps = {} } = {}) {
  const budget = normalizeBudget(deps.budget);
  if (budget === null) return rejected('invalid claimed Git effect budget');
  const initialTimeoutMs = effectTimeoutMs(budget);
  const options = optionsFor(claim, operation, initialTimeoutMs);
  if (options === null) return rejected('invalid claimed Git effect');
  if (typeof deps.fakeEffect === 'function') return deps.fakeEffect({ claim, operation, options });
  const spawnHelper = typeof deps.fork === 'function' ? deps.fork : fork;
  const getStartTime = typeof deps.getStartTime === 'function' ? deps.getStartTime : defaultGetStartTime;
  const attachClaimHelper = typeof deps.attachClaimHelper === 'function'
    ? deps.attachClaimHelper : attachWorktreeClaimHelper;
  const clearClaimHelper = typeof deps.clearClaimHelper === 'function'
    ? deps.clearClaimHelper : clearWorktreeClaimHelper;
  const clearWaitingClaimHelper = typeof deps.clearWaitingClaimHelper === 'function'
    ? deps.clearWaitingClaimHelper : clearWaitingWorktreeClaimHelper;
  const waitForHelperClose = typeof deps.waitForHelperClose === 'function'
    ? deps.waitForHelperClose : waitForObservedClose;
  const send = typeof deps.sendIpc === 'function' ? deps.sendIpc : sendIpc;
  const ipcTimeoutMs = Number.isSafeInteger(deps.ipcTimeoutMs) && deps.ipcTimeoutMs > 0
    ? deps.ipcTimeoutMs : READY_TIMEOUT_MS;
  const helperEntry = deps.helperEntry ?? fileURLToPath(new URL('./server.mjs', import.meta.url));
  let child;
  try {
    child = spawnHelper(helperEntry, [HELPER_ARG], {
      detached: process.platform !== 'win32',
      execArgv: [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  } catch {
    return rejected('worktree Git helper could not start');
  }
  const closePromise = observeClose(child);
  const stopBeforeGo = () => { try { child.kill('SIGKILL'); } catch { /* no effect was authorized */ } };
  const readyWaitMs = protocolWaitMs(budget);
  const ready = readyWaitMs > 0
    ? await waitForMessage(child, (message) => message?.type === 'ready', readyWaitMs) : null;
  if (ready === null || !Number.isInteger(child.pid) || child.pid <= 0) {
    stopBeforeGo();
    return rejected('worktree Git helper did not become ready');
  }
  let startTime;
  try {
    startTime = await getStartTime(child.pid);
  } catch {
    startTime = null;
  }
  if (typeof startTime !== 'string' || startTime === '') {
    stopBeforeGo();
    return rejected('worktree Git helper identity is unavailable');
  }
  const helper = { pid: child.pid, startTime };
  const stopAndReconcileWaiting = async () => {
    stopBeforeGo();
    try { child.disconnect(); } catch { /* helper may already be gone */ }
    const closeWaitMs = protocolWaitMs(budget);
    const closed = closeWaitMs > 0
      ? await waitForHelperClose({ child, closePromise, timeoutMs: closeWaitMs }) : { closed: false };
    if (closed?.closed === true && await exactHelperAbsent(getStartTime, helper)) {
      await clearWaitingClaimHelper(claim, helper, deps.claimDeps ?? {}).catch(() => null);
    }
  };
  const attached = await attachClaimHelper(claim, helper, deps.claimDeps ?? {});
  if (attached?.ok !== true) {
    await stopAndReconcileWaiting();
    return rejected('worktree Git helper identity could not be made durable');
  }
  const authorizedTimeoutMs = effectTimeoutMs(budget);
  if (authorizedTimeoutMs <= 0) {
    await stopAndReconcileWaiting();
    return rejected('worktree Git effect deadline expired before authorization');
  }
  const resultWaitMs = budget.deadlineAt === null
    ? authorizedTimeoutMs + READY_TIMEOUT_MS : deadlineRemainingMs(budget);
  if (resultWaitMs <= 0) {
    await stopAndReconcileWaiting();
    return rejected('worktree Git effect deadline expired before authorization');
  }
  const resultPromise = waitForMessage(child, (message) => message?.type === 'result' &&
    message.claimToken === claim.claimToken && message.helperPid === helper.pid &&
    message.helperStartTime === helper.startTime && typeof message.settled === 'boolean',
    resultWaitMs);
  const goWaitMs = protocolWaitMs(budget, ipcTimeoutMs);
  const sent = goWaitMs > 0 && await send(child,
    { type: 'go', claim, helper, operation, timeoutMs: authorizedTimeoutMs }, goWaitMs);
  if (!sent) {
    await stopAndReconcileWaiting();
    return rejected('worktree Git helper could not be authorized');
  }
  const message = await resultPromise;
  if (message === null) {
    // The helper writes waiting -> started before invoking Git. Once its exact process is proven
    // gone, a still-waiting row therefore proves that no external effect began. The atomic clear
    // itself rechecks that state; started/may_have_started refuses and remains manual/fail-closed.
    const closeWaitMs = protocolWaitMs(budget);
    const closed = closeWaitMs > 0
      ? await waitForHelperClose({ child, closePromise, timeoutMs: closeWaitMs }) : { closed: false };
    if (closed?.closed === true && await exactHelperAbsent(getStartTime, helper)) {
      await clearWaitingClaimHelper(claim, helper, deps.claimDeps ?? {}).catch(() => null);
    }
    return rejected('worktree Git helper result is unknown');
  }
  if (!validResult(message.result)) {
    return rejected('worktree Git helper result is unknown');
  }
  if (message.settled === false && message.result.ok === true) {
    return rejected('worktree Git helper reported success without durable settlement');
  }
  if (message.settled === true) {
    const ackWaitMs = protocolWaitMs(budget, ipcTimeoutMs);
    const acked = ackWaitMs > 0 && await send(child, { type: 'ack', claimToken: claim.claimToken,
      helperPid: helper.pid, helperStartTime: helper.startTime }, ackWaitMs);
    if (!acked) {
      try { child.disconnect(); } catch { /* durable settled state remains */ }
      try { child.kill('SIGKILL'); } catch { /* exact identity probe below is authoritative */ }
    }
    const closeWaitMs = protocolWaitMs(budget);
    const closed = closeWaitMs > 0
      ? await waitForHelperClose({ child, closePromise, timeoutMs: closeWaitMs }) : { closed: false };
    if (closed?.closed !== true || !await exactHelperAbsent(getStartTime, helper)) {
      return rejected('worktree Git helper termination could not be verified');
    }
    const cleared = await clearClaimHelper(claim, helper, deps.claimDeps ?? {});
    if (cleared?.ok !== true) return rejected('worktree Git helper settlement could not be reconciled');
  }
  return message.result;
}

/** Called only by server.mjs in helper mode. */
export async function runWorktreeGitEffectHelper() {
  let went = false;
  let settled = false;
  let active = false;
  let binding = null;
  const hold = () => {
    const timer = setInterval(() => {}, 60_000);
    keepAlive.add(timer);
  };
  process.on('disconnect', () => {
    if (!went || settled) process.exit(0);
    else if (!active) hold();
  });
  process.on('message', async (message) => {
    if (message?.type === 'ack' && settled && binding !== null &&
        message.claimToken === binding.claimToken && message.helperPid === binding.helperPid &&
        message.helperStartTime === binding.helperStartTime) process.exit(0);
    const options = optionsFor(message?.claim, message?.operation, message?.timeoutMs);
    if (went || message?.type !== 'go' || options === null) return;
    went = true;
    active = true;
    binding = {
      claimToken: message.claim.claimToken,
      helperPid: message.helper.pid,
      helperStartTime: message.helper.startTime,
    };
    const started = await markWorktreeClaimHelperStarted(message.claim, message.helper);
    if (started?.ok !== true) {
      active = false;
      settled = true;
      process.send?.({
        type: 'result',
        claimToken: message.claim.claimToken,
        helperPid: message.helper.pid,
        helperStartTime: message.helper.startTime,
        settled: true,
        result: rejected('claim changed before Git authorization'),
      });
      return;
    }
    const result = await runGit(options);
    active = false;
    if (result?.reasonCode === REASON.git_process_unkillable) {
      process.send?.({
        type: 'result',
        claimToken: message.claim.claimToken,
        helperPid: message.helper.pid,
        helperStartTime: message.helper.startTime,
        settled: false,
        result,
      });
      hold();
      return;
    }
    const marked = await markWorktreeClaimHelperSettled(message.claim, message.helper);
    settled = marked?.ok === true;
    process.send?.({
      type: 'result',
      claimToken: message.claim.claimToken,
      helperPid: message.helper.pid,
      helperStartTime: message.helper.startTime,
      settled,
      result: settled ? result : rejected('Git ended but its durable claim settlement failed'),
    });
    if (!settled) hold();
  });
  process.send?.({ type: 'ready' });
}

export const isWorktreeGitEffectHelper = () => process.argv[2] === HELPER_ARG;
