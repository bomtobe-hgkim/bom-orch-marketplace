import { runProbeCommand } from './process-identity.mjs';

const WINDOWS = process.platform === 'win32';

/** pid와 시작 시각이 모두 같은 프로세스만 우리가 기록한 그 세대다. */
export function isOurProcess(record, live) {
  return record != null && live != null &&
    Number.isInteger(record.pid) && Number.isInteger(live.pid) && record.pid === live.pid &&
    typeof record.startTime === 'string' && record.startTime !== '' &&
    typeof live.startTime === 'string' && live.startTime !== '' && record.startTime === live.startTime;
}

/** 그룹 리더일 때만 음수 pid로 프로세스 그룹 전체를 가리킨다. */
export function resolvePosixKillTarget(pid, pgid) {
  return Number.isInteger(pgid) && pgid > 0 && pgid === pid ? -pid : pid;
}

/**
 * 원장 owner의 현재 상태. undefined는 조회 실패라서 unknown이고, null은 exact death다.
 * pid 재사용은 기록된 세대가 죽은 것이므로 dead다.
 */
export function classifyOwner(record, live) {
  if (!Number.isInteger(record?.ownerPid) || record.ownerPid <= 0 ||
      typeof record.ownerStartTime !== 'string' || record.ownerStartTime === '') return 'unknown';
  if (live === undefined) return 'unknown';
  if (live === null) return 'dead';
  if (typeof live.startTime !== 'string' || live.startTime === '') return 'unknown';
  return isOurProcess({ pid: record.ownerPid, startTime: record.ownerStartTime }, live) ? 'alive' : 'dead';
}

/**
 * 기록된 프로세스 트리를 강제 종료한다. OS 도구를 절대 경로로 해석하지 못하거나 공용
 * startup deadline을 넘기면 destructive signal을 시작하지 않는다.
 */
export async function treeKill(pid, deps = {}) {
  const windows = deps?.platform === undefined ? WINDOWS : deps.platform === 'win32';
  if (windows) {
    const { ok } = await runProbeCommand('taskkill', ['/PID', String(pid), '/T', '/F'], deps);
    return ok;
  }
  // POSIX ps는 그룹 리더 판정 보조일 뿐이고 실제 성공은 process.kill이 정한다.
  const { ok, stdout, timedOut } = await runProbeCommand('ps', ['-o', 'pgid=', '-p', String(pid)], deps);
  if (deps?.deadlineAt !== undefined) {
    try {
      const observed = deps.clock();
      if (timedOut || !Number.isSafeInteger(observed) || observed < 0 || observed >= deps.deadlineAt) return false;
    } catch {
      return false;
    }
  }
  const pgid = ok ? Number.parseInt(stdout.trim(), 10) : Number.NaN;
  try {
    const killProcess = typeof deps?.killProcess === 'function' ? deps.killProcess : process.kill;
    killProcess(resolvePosixKillTarget(pid, Number.isNaN(pgid) ? null : pgid), 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
