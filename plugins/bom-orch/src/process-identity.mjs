import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { resolveBinary } from './providers/resolve-binary.mjs';

const WINDOWS = process.platform === 'win32';
const LINUX = process.platform === 'linux';

/** 프로브가 걸려도 서버를 붙잡지 않게 한다. */
const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_STDOUT_BYTES = 64 * 1024;

function probeTimeoutMs(deps) {
  try {
    if (deps?.deadlineAt === undefined) return PROBE_TIMEOUT_MS;
    if (!Number.isSafeInteger(deps.deadlineAt) || deps.deadlineAt < 0 || typeof deps.clock !== 'function') return 0;
    const observed = deps.clock();
    if (!Number.isSafeInteger(observed) || observed < 0 || observed >= deps.deadlineAt) return 0;
    return Math.min(PROBE_TIMEOUT_MS, deps.deadlineAt - observed);
  } catch {
    return 0;
  }
}

/** undefined = 조회 실패, null = 없는 프로세스, 객체 = 살아 있음. */
export async function lookupProcess(getStartTime, pid) {
  // ★ 0 과 음수는 프로세스가 아니라 프로세스 **그룹**을 가리킨다. process.kill(0) 은
  //   자기 그룹 전체, kill(-1) 은 보낼 수 있는 모든 프로세스에 신호를 보낸다.
  //   원장이 손상돼 그런 값이 들어오면 잘못된 pid 하나보다 훨씬 나쁘다.
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let startTime;
  try {
    startTime = await getStartTime(pid);
  } catch {
    return undefined;
  }
  if (startTime === undefined) return undefined;
  if (startTime === null) return null;
  return { pid, startTime };
}

// ── 실제 OS 프로브 (테스트에서는 주입으로 대체한다) ──────────────────────

/**
 * 프로브 실행 파일의 **절대 경로**. 못 찾으면 null (호출부가 fail-closed 로 거부한다).
 *
 * ★ 왜 이름으로 스폰하면 안 되는가: 서버 cwd 는 호스트·대상 저장소에서 온다. Windows 의
 *   libuv 는 경로 구분자 없는 이름을 그 cwd 에서 PATH 보다 먼저 찾으므로, 저장소가 둔
 *   `taskkill.exe` 같은 파일을 실행할 수 있다. 모든 프로브는 resolveBinary가 낸 절대 경로만 쓴다.
 * ★ fail-closed. 해석에 실패해도 이름으로 되돌아가지 않는다.
 */
function resolveProbePath(basename) {
  let resolved;
  try {
    resolved = resolveBinary({ basename });
  } catch {
    return null;
  }
  return typeof resolved === 'string' && isAbsolute(resolved) ? resolved : null;
}

/** 프로세스 identity와 reaper tree-kill이 공유하는 절대경로 프로브 실행기. */
export function runProbeCommand(basename, args, deps = {}) {
  return new Promise((resolve) => {
    const timeoutMs = probeTimeoutMs(deps);
    if (timeoutMs === 0) {
      resolve({ ok: false, stdout: '', failed: true, timedOut: true, error: null });
      return;
    }
    const resolvePath = typeof deps?.resolveProbePath === 'function' ? deps.resolveProbePath : resolveProbePath;
    const spawnProcess = typeof deps?.spawn === 'function' ? deps.spawn : spawn;
    const setTimer = typeof deps?.setTimeout === 'function' ? deps.setTimeout : setTimeout;
    const clearTimer = typeof deps?.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
    const command = resolvePath(basename);
    if (command === null) {
      resolve({
        ok: false,
        stdout: '',
        failed: true,
        timedOut: false,
        error: new Error(`the probe executable was not found on PATH as an absolute path: ${basename}`),
      });
      return;
    }
    let child;
    try {
      // 읽지 않을 stderr 파이프를 열면 버퍼를 채운 자식이 상한까지 멈춘다.
      child = spawnProcess(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ ok: false, stdout: '', failed: true, timedOut: false, error });
      return;
    }
    let stdout = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const detach = () => {
      try { child.stdout.removeListener('data', onData); } catch { /* 이미 닫힌 pipe다. */ }
      try { child.stdout.destroy(); } catch { /* 이미 닫힌 pipe다. */ }
      try { child.unref(); } catch { /* 일부 테스트 대역에는 handle이 없다. */ }
    };
    const finish = (result, forceKill = false) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      detach();
      if (forceKill) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 이미 죽었거나 이 handle에 종료 권한이 없다.
        }
      }
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    const onData = (chunk) => {
      const text = String(chunk);
      const remaining = MAX_PROBE_STDOUT_BYTES - stdout.length;
      stdout += text.slice(0, Math.max(0, remaining));
      if (text.length > remaining) {
        finish({
          ok: false,
          stdout,
          failed: true,
          timedOut: false,
          error: new Error('probe stdout exceeded the byte limit'),
        }, true);
      }
    };
    child.stdout.on('data', onData);
    timer = setTimer(() => {
      timedOut = true;
      // settled를 먼저 잠근 뒤 pipe를 닫고 강제 종료를 시도한다. kill이 동기 close/error를
      // 내도 timeout 판정은 바뀌지 않으며, 종료를 거부한 child도 unref되어 서버를 붙잡지 않는다.
      finish({ ok: false, stdout, failed: true, timedOut: true, error: null }, true);
    }, timeoutMs);
    if (settled) clearTimer(timer);
    child.on('error', (error) => {
      finish({ ok: false, stdout, failed: true, timedOut, error });
    });
    child.on('close', (code) => {
      // 비정상 종료와 실행 자체의 실패를 갈라야 조회 실패를 프로세스 부재로 오인하지 않는다.
      finish({ ok: code === 0, stdout, failed: timedOut, timedOut, error: null });
    });
  });
}

/** Linux의 boot 세대와 커널 start ticks를 결합한 재부팅·PID 재사용 안전 identity. */
export async function linuxProcessStartIdentity(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const read = typeof deps?.readFile === 'function' ? deps.readFile : readFile;
  let statText;
  try {
    statText = String(await read(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ESRCH' ? null : undefined;
  }
  if (statText.length === 0 || statText.length > 4096 || !statText.startsWith(`${pid} (`)) return undefined;
  const commandEnd = statText.lastIndexOf(')');
  if (commandEnd < `${pid} (`.length) return undefined;
  const fields = statText.slice(commandEnd + 1).trim().split(/\s+/);
  // 닫는 괄호 뒤 첫 값은 field 3(state), starttime은 field 22라 index 19다.
  const startTicks = fields[19];
  if (!/^(?:0|[1-9]\d*)$/.test(startTicks ?? '')) return undefined;

  let bootId;
  try {
    bootId = String(await read('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
  } catch {
    return undefined;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) return undefined;
  return `linux:${bootId}:${startTicks}`;
}

/**
 * 프로세스의 시작 시각. undefined = 조회 실패, null = 그런 프로세스 없음.
 * 모름을 죽음으로 뭉개면 살아 있는 다른 서버의 자식과 캐시를 회수하므로 세 값을 유지한다.
 */
export async function defaultGetStartTime(pid, deps = {}) {
  if (WINDOWS) {
    const { ok, failed, stdout } = await runProbeCommand('powershell', [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.Ticks } else { 'ABSENT' }`,
    ], deps);
    if (failed || !ok) return undefined;
    const text = stdout.trim();
    if (text === 'ABSENT') return null;
    return text === '' ? undefined : text;
  }

  if (LINUX) return linuxProcessStartIdentity(pid, deps);

  const { ok, failed, stdout } = await runProbeCommand('ps', ['-o', 'lstart=', '-p', String(pid)], deps);
  if (failed) return undefined;
  const text = stdout.trim();
  if (!ok) return text === '' ? null : undefined;
  return text === '' ? null : text;
}
