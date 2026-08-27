/**
 * 파일 하나를 통째로 바꾸는 한 가지 방법 — 임시 파일에 쓰고 제자리로 옮긴다.
 *
 * 이전에는 같은 일을 하는 사본이 여섯 벌 있었고(리서치
 * `docs/superpowers/research/2026-08-16-ws1/helpers.json`, family
 * `atomic-write-via-rename`), 그 여섯은 **한 가족이 아니라 두 가족**이었다:
 *
 *  - **내구성 규약** — `learn/learning`·`learn/posteriors`·`run-artifacts`. 배타 생성
 *    (`wx`) + 데이터 fsync + rename 재시도. 여기서 잃는 것은 학습 전체 또는 실행
 *    아티팩트 저장소다.
 *  - **최선의 노력 캐시** — `config`·`providers/catalog`·`reaper` 원장. 셋 다 자기
 *    파일에 「캐시는 최적화이지 정확성 요건이 아니다」·「원장은 최선의 노력이다」라고
 *    적어 두었다. 여기에 fsync 를 얹으면 쓰기마다 **+1.3ms**(실측:
 *    `src/learn/posteriors.mjs` 헤더)를 내고 사는 사람이 아무도 없다.
 *
 * 그래서 이 모듈은 **기계 장치만** 통합하고 정책은 호출자가 고른다. `fsync`·`syncDir`
 * 는 옵트인/옵트아웃이지 기본값 하나로 접히는 축이 아니다.
 *
 * ★★ `tempPath` 는 **필수**다. 임시 파일 이름은 이 저장소에서 그냥 이름이 아니라
 *    **데이터**다: `src/reaper.mjs` 의 `CHECKPOINT_TEMP_PATTERN`·`.tmp-<별칭>-` 접두사
 *    검사와 `src/run-artifacts.mjs` 의 `tempPathForFinal`·인벤토리 검증이 그 모양으로
 *    고아를 분류한다. 도우미가 이름을 지어내면 살아 있는 임시 파일이 `invalid_inventory`
 *    로 잡힌다(리서치가 WS1 최고 위험으로 표시한 자리). 이름은 언제나 호출자의 것이다.
 *
 * 절대 throw 하지 않는다 — `{ok:true}` 또는 `{ok:false, stage, reason}` 이다. 여섯 사본의
 * 호출부는 캐시 갱신부터 잠금 본문까지 걸쳐 있고, 그중 셋은 던지면 서버가 죽거나 실행이
 * 통째로 실패한다.
 */
import { open as fsOpen, rename as fsRename, rm as fsRm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorText } from './errors.mjs';

/**
 * rename 재시도 정책. 두 수의 근거는 `src/learn/posteriors.mjs` 헤더의 실측표다 —
 * Windows 는 **목적지 파일이 열려 있으면 rename 이 EPERM** 이고, 드문드문 여는 리더는
 * 10회 × 5ms 로 전부 흡수된다(쉬지 않고 여는 리더는 흡수되지 않는다. 그 사실도 그 표에
 * 적혀 있다).
 */
export const RENAME_ATTEMPTS = 10;
export const RENAME_DELAY_MS = 5;

/** 재시도할 rename 오류. 셋 다 「지금은 안 되지만 곧 될 수 있다」는 뜻이다. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Windows 가 디렉터리 fsync 를 거절하는 방식들. 실측: 디렉터리 핸들은 열리지만 그
 * 핸들의 `sync()` 가 EPERM 이다. 이것은 실패가 아니라 **그 플랫폼이 주지 않는 보장**이라
 * 「프로세스 크래시까지만 보장」으로 강등한다(`src/run-artifacts.mjs` 가 쓰던 목록 그대로).
 */
const WIN32_DIRECTORY_SYNC_CODES = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR']);

/**
 * 호출자가 `tempPath` 를 안 준 것은 **개발자 오류**다 — 이 도우미는 이름을 지어내지 않는다
 * (모듈마다 임시 이름 규칙이 다르다). 사용자에게 나가는 문구가 아니므로 레지스트리 코드가
 * 아니라 여기 영어 한 줄로 둔다(WS2 Task 16 — 「밖으로 나가는 문구」만 정본을 거친다).
 */
const TEMP_PATH_REQUIRED = 'writeFileAtomic requires a tempPath: the caller names its own temporary file';

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fs 이음새. 기본값이 진짜 `node:fs/promises` 라 옵션을 안 주면 동작도 바이트도 그대로다.
 *
 * ★ 왜 필요한가: 성공한 fsync 는 파일시스템에 흔적을 안 남기고, Windows 의 rename EPERM 은
 *   목적지를 연 리더가 있어야 나므로 재현이 확률적이다. 그 둘은 주입으로만 잴 수 있다.
 */
function fsFrom(value) {
  const given = value !== null && typeof value === 'object' ? value : {};
  return {
    open: typeof given.open === 'function' ? given.open : fsOpen,
    rename: typeof given.rename === 'function' ? given.rename : fsRename,
    rm: typeof given.rm === 'function' ? given.rm : fsRm,
  };
}

/**
 * 이름을 바꾼다. Windows 의 EPERM/EACCES/EBUSY 만 다시 시도한다.
 *
 * `learn/learning.mjs`·`learn/posteriors.mjs` 가 각자 들고 있던 사본이며 숫자도 그대로다.
 * 재시도 대상이 아닌 코드(ENOSPC·EXDEV 등)는 즉시 끝난다 — 기다려도 달라지지 않는다.
 */
export async function renameWithRetry(from, to, options) {
  const given = options !== null && typeof options === 'object' ? options : {};
  const { attempts = RENAME_ATTEMPTS, delayMs = RENAME_DELAY_MS, sleep = realSleep } = given;
  const io = fsFrom(given.fs);
  const tries = Number.isInteger(attempts) && attempts > 0 ? attempts : RENAME_ATTEMPTS;
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      await io.rename(from, to);
      return { ok: true };
    } catch (error) {
      last = error;
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt === tries) break;
      await sleep(delayMs);
    }
  }
  return { ok: false, reason: errorText(last) };
}

/**
 * 디렉터리를 fsync 한다 — rename 자체가 디스크에 닿게 하는 유일한 방법이다.
 *
 * `{ok:true}` 는 진짜로 닿았다는 뜻이고, `{ok:true, durability:'process-crash-only'}` 는
 * 플랫폼이 그 보장을 주지 않는다는 뜻이다(위 목록). 둘을 가르는 이유는 호출자가
 * 「전원 손실까지 버틴다」고 적을 수 있는지 없는지가 달라서다.
 */
export async function syncDirectory(dirPath, options) {
  const io = fsFrom((options !== null && typeof options === 'object' ? options : {}).fs);
  let handle;
  try {
    handle = await io.open(dirPath, 'r');
    await handle.sync();
    return { ok: true };
  } catch (error) {
    if (process.platform === 'win32' && WIN32_DIRECTORY_SYNC_CODES.has(error?.code)) {
      return { ok: true, durability: 'process-crash-only' };
    }
    return { ok: false, reason: errorText(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * `finalPath` 를 `bytes` 로 통째로 바꾼다.
 *
 * @param {string} finalPath 목적지.
 * @param {Buffer|Uint8Array|string} bytes 쓸 내용.
 * @param {object} options
 * @param {string} options.tempPath **필수.** 위 ★★ 를 보라.
 * @param {boolean} [options.fsync=true] 데이터 fsync. `false` 는 best-effort 사이트의
 *   **명시 옵트아웃**이다 — 기본값으로 흘러 들어가지 않게 호출부마다 적는다.
 * @param {boolean} [options.syncDir=false] rename 뒤 부모 디렉터리 fsync.
 * @param {boolean} [options.strictDurability=false] fsync 실패를 성공 등급 강등 없이 전파한다.
 * @param {boolean} [options.exclusive=true] `wx` 로 만든다. `false` 는 고아 임시 파일
 *   위에 그냥 쓰던 캐시 사이트의 오늘 동작이다(리서치 MEDIUM: `<pid>.<카운터>` 이름은
 *   죽은 프로세스의 고아와 겹칠 수 있고, 거기서 `wx` 로 막으면 사람이 지울 때까지 캐시
 *   갱신이 영영 멈춘다).
 * @param {number} [options.mode] 임시 파일 권한.
 * @returns `{ok:true}` · `{ok:true, durability:'process-crash-only'}` ·
 *   `{ok:false, stage:'options'|'write'|'rename'|'sync-dir', reason}`.
 *
 * ★ fsync 실패는 **쓰기 실패가 아니다.** 네트워크 마운트에서 EINVAL 이 나고, 그때
 *   잃는 것은 내구성뿐이지 내용이 아니다(`learn/*` 두 사본이 같은 이유로 삼켰다).
 *   내용이 제자리에 있는데 `ok:false` 를 내면 호출자가 멀쩡한 상태를 되돌린다.
 * ★ 임시 파일은 **우리 `open` 이 성공했을 때만** 치운다 — 「우리가 만든 것만」이 아니다.
 *   그 둘은 `exclusive` 에 따라 갈린다.
 *   - `exclusive:true`: `wx` 가 EEXIST 로 튕기면 그 파일에 손대지 않는다. 같은 임시 이름을
 *     쥔 **살아 있는** 다른 쓰기의 파일을 치우면 그쪽의 rename 이 ENOENT 로 죽는다 —
 *     우리가 못 쓴 것을 남의 실패로 바꾸는 셈이다.
 *   - `exclusive:false`: `'w'` 는 고아 위에 열려 그것을 잘라낸다. 그 순간부터 그 경로는
 *     우리 쓰기이므로 실패하면 지운다 — **원래 거기 있던 고아 바이트까지 함께 사라진다.**
 *     캐시 사이트들의 오늘 동작이 그렇고, 그래서 그 옵트아웃은 호출부마다 명시한다.
 *   - 성공 경로에는 치울 것이 없다: rename 이 임시 경로를 이미 가져갔다.
 */
export async function writeFileAtomic(finalPath, bytes, options) {
  const given = options !== null && typeof options === 'object' ? options : {};
  const {
    tempPath,
    fsync = true,
    syncDir = false,
    strictDurability = false,
    exclusive = true,
    mode,
    sleep,
    attempts,
    delayMs,
  } = given;
  if (typeof tempPath !== 'string' || tempPath === '') {
    return { ok: false, stage: 'options', reason: TEMP_PATH_REQUIRED };
  }

  const io = fsFrom(given.fs);
  let created = false;
  try {
    const handle = await io.open(tempPath, exclusive ? 'wx' : 'w', mode);
    created = true;
    try {
      await handle.writeFile(bytes);
      if (fsync) {
        if (strictDurability) await handle.sync();
        else await handle.sync().catch(() => {});
      }
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    if (created) await io.rm(tempPath, { force: true }).catch(() => {});
    return { ok: false, stage: 'write', reason: errorText(error) };
  }

  const moved = await renameWithRetry(tempPath, finalPath, { attempts, delayMs, sleep, fs: given.fs });
  if (!moved.ok) {
    await io.rm(tempPath, { force: true }).catch(() => {});
    return { ok: false, stage: 'rename', reason: moved.reason };
  }
  if (!syncDir) return { ok: true };

  const synced = await syncDirectory(dirname(finalPath), { fs: given.fs });
  // 내용은 이미 제자리에 있다. 디렉터리 fsync 가 안 됐다는 사실만 등급으로 말한다.
  if (synced.ok) return synced;
  return strictDurability
    ? { ok: false, stage: 'sync-dir', reason: synced.reason, published: true, commitUnknown: true }
    : { ok: true, durability: 'process-crash-only', reason: synced.reason };
}
