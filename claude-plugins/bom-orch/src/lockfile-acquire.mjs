import { open, readFile, rename, rm, stat } from 'node:fs/promises';

let takeoverSeq = 0;

/**
 * Identity-protected acquisition serializes ordinary acquisition and dead-owner takeover through
 * a non-stealable gate. A crashed gate is deliberately manual/fail-closed: moving a live
 * replacement is worse than leaving startup blocked with a diagnostic timeout.
 */
export async function acquireIdentityProtectedLock(
  lockPath,
  { deadline, wait, now, sleep, getStartTime },
) {
  const gatePath = `${lockPath}.takeover`;
  let lastCode = 'EEXIST';
  for (;;) {
    let gate = null;
    try {
      gate = await open(gatePath, 'wx');
    } catch (error) {
      lastCode = error?.code ?? lastCode;
    }
    if (gate !== null) {
      try {
        try {
          const handle = await open(lockPath, 'wx');
          return { ok: true, handle };
        } catch (error) {
          lastCode = error?.code ?? lastCode;
          if (error?.code === 'EEXIST' && await identityOwnerIsDead(lockPath, getStartTime)) {
            const away = `${lockPath}.dead-${process.pid}-${Date.now()}-${(takeoverSeq += 1)}`;
            await rename(lockPath, away);
            await rm(away, { force: true }).catch(() => {});
            const handle = await open(lockPath, 'wx');
            return { ok: true, handle };
          }
        }
      } catch (error) {
        lastCode = error?.code ?? lastCode;
      } finally {
        await gate.close().catch(() => {});
        await rm(gatePath, { force: true }).catch(() => {});
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, code: lastCode };
    await sleep(Math.min(wait, remaining));
  }
}

async function identityOwnerIsDead(lockPath, getStartTime) {
  if (getStartTime === null) return false;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return false;
  }
  if (parsed?.mode !== 'identity' || !Number.isInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.startTime !== 'string' || parsed.startTime === '') return false;
  let live;
  try {
    live = await getStartTime(parsed.pid);
  } catch {
    return false;
  }
  return live === null || typeof live === 'string' && live !== parsed.startTime;
}

/**
 * A stale lock's name is moved before removal. On the libuv version in Node 22.11, unlinking an
 * open file leaves the name delete-pending and a following `open(..., 'wx')` returns EPERM;
 * rename frees the acquisition name immediately on every supported Node version. Only regular
 * files use this path, because moving a directory would mutate something this lock did not create.
 */
export async function takeOverStale(lockPath) {
  const info = await stat(lockPath).catch(() => null);
  if (!info?.isFile()) return rm(lockPath, { force: true });
  const away = `${lockPath}.stale-${process.pid}-${Date.now()}-${(takeoverSeq += 1)}`;
  await rename(lockPath, away);
  await rm(away, { force: true }).catch(() => {});
  return undefined;
}

/** 잠금 파일이 너무 오래됐는가. */
async function isStale(lockPath, staleMs, now) {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const at = JSON.parse(raw)?.at;
    if (Number.isFinite(at)) return now() - at > staleMs;
  } catch {
    // 페이로드를 못 읽는다 — 아래 mtime 폴백으로 나이를 본다.
  }
  // `open(lockPath,'wx')` 와 `{pid,at}` 쓰기 사이에서 프로세스가 죽으면 0바이트 잠금 파일이
  // 남는다. 페이로드만 보면 빈 파일·잘린 JSON·at 없음이 영원히 stale 이 되지 않는다.
  try {
    const { mtimeMs } = await stat(lockPath);
    return Number.isFinite(mtimeMs) && now() - mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Identity locks are never age-stolen. Unknown owner state defers; exact death permits takeover. */
export async function mayTakeOver(lockPath, staleMs, now, getStartTime, identityProtected) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return identityProtected ? false : isStale(lockPath, staleMs, now);
  }
  if (parsed?.mode !== 'identity') return identityProtected ? false : isStale(lockPath, staleMs, now);
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.startTime !== 'string' || parsed.startTime === '' || getStartTime === null) return false;
  let live;
  try {
    live = await getStartTime(parsed.pid);
  } catch {
    return false;
  }
  return live === null || typeof live === 'string' && live !== parsed.startTime;
}
