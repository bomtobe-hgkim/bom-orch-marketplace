import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveBinary } from './providers/resolve-binary.mjs';
import { canonical } from './real-path.mjs';
import {
  MAX_JSON_ARTIFACT_BYTES,
  MAX_RUN_MANIFEST_BYTES,
  RUN_ARTIFACT_RETENTION_MS,
  normalizeRunManifestV1,
  validateRunManifestTransitionV1,
  verifyArtifactOwnerOnly,
} from './run-artifacts.mjs';

/**
 * 고아 프로세스 reaper.
 *
 * ★ 왜 child.kill() 로 부족한가: Node 에는 Win32 Job Object 등가물이 없다. 그건 부모가
 *   죽어도 OS 가 자식을 확실히 회수한다. 우리에겐 그게 없으므로 서버가 죽으면 델리게이트
 *   CLI 와 그 손자들이 그대로 남는다. 그래서 디스크에 원장을 남기고 다음 부팅에 훑는다.
 *
 * ★ 물려받는 미해결 한계: `taskkill /T` 는 **살아 있는** 부모-자식 트리만 훑는다. 중간
 *   프로세스가 이미 죽어 reparent 된 손자는 그 순회에 나타나지 않아 놓친다. POSIX 의
 *   프로세스 그룹 신호도 같다. 이 환경에서 고칠 방법이 없어 문서화만 한다.
 *
 * ★ 가장 비싼 실수는 남의 프로세스를 죽이는 것이다. 두 겹으로 막는다 — pid 재사용
 *   방어(isOurProcess)와 동시 세션 방어(classifyOwner). 아래 각 함수 주석 참고.
 */

const LEDGER = 'children.json';
const WINDOWS = process.platform === 'win32';

/** 프로브가 걸려도 서버를 붙잡지 않게 한다. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * 기록이 가리키는 그 프로세스가 지금도 살아 있는 그 프로세스인가.
 *
 * ★ pid 만으로는 안 된다 — OS 가 pid 를 재사용하면 무관한 프로세스를 죽인다. pid 와
 *   시작 시각이 **둘 다** 맞을 때만 참이다. 어느 한쪽이라도 모르면 거짓 — 고아를
 *   남기는 편이 남의 프로세스를 죽이는 것보다 낫다.
 */
export function isOurProcess(record, live) {
  if (!record || !live) return false;
  if (record.pid !== live.pid) return false;
  if (typeof record.startTime !== 'string' || record.startTime === '') return false;
  if (typeof live.startTime !== 'string' || live.startTime === '') return false;
  return record.startTime === live.startTime;
}

/**
 * POSIX 에서 무엇에 신호를 보낼지.
 *
 * 그룹 리더가 아닌데 -pid 로 보내면 ESRCH 가 나는데, 그걸 삼키면 "죽였다"고 잘못
 * 보고하게 된다. 리더일 때만 그룹 전체로 보낸다.
 */
export function resolvePosixKillTarget(pid, pgid) {
  return Number.isInteger(pgid) && pgid === pid ? -pid : pid;
}

/**
 * 이 기록을 쓴 서버가 지금 어떤 상태인가.
 *
 * ★ 원장은 상태 루트당 하나라 여러 세션이 공유한다. 원본(BomPlugin)은 이 지점에서
 *   실제로 다쳤다 — 한 세션의 부팅 훑기가 다른 **살아 있는** 세션의 자식을 죽였다.
 *   그 세션이 죽었거나 나 자신일 때만 그 기록을 건드린다.
 *
 * @param live undefined = 조회 실패(모름), null = 그런 프로세스 없음(죽음)
 */
export function classifyOwner(record, live, selfPid) {
  if (record?.ownerPid === selfPid) return 'us';
  if (live === undefined) return 'unknown';
  if (live === null) return 'dead';
  // pid 는 살아 있지만 시작 시각이 다르면 그건 재사용된 pid 다 — 원래 주인은 죽었다.
  return isOurProcess({ pid: record.ownerPid, startTime: record.ownerStartTime }, live) ? 'alive' : 'dead';
}

/**
 * `<stateRoot>/scratch` 잔재를 "죽은 실행이 남긴 것" 으로 볼 나이.
 *
 * 그 디렉터리에는 사용자의 **미커밋 내용 전체가 평문으로** 잠시 놓인다(임시 인덱스와
 * state 패치 — `src/worktree.mjs` 의 같은 문단). 정상 경로에서는 `finally` 가 항상 지우고
 * 강제 종료된 경우에만 남는다.
 *
 * 6시간인 이유: 이 파일들의 정상 수명은 초 단위다(뜨자마자 지운다). 가장 긴 정상 경로도
 * `worktree add` + `add -A` 한 번이라 시간 단위가 아니다. 그래도 동시에 도는 다른 실행의
 * 파일을 지우지 않도록 넉넉히 잡는다.
 */
const SCRATCH_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * `src/worktree.mjs` 가 scratch 에 만드는 이름 **전체 모양**. 그 밖의 파일은 우리 것이 아니다.
 *
 * ★ 접두사만 보면 안 된다. 실측 재현: 접두사 술어(`/^(?:index-|state-|step-|final-)/`)는
 *   `final-report.md` · `step-1.png` · `index-a1b2c3.js` 같은 **사용자 파일**을 우리 것으로
 *   보고 지웠다. 나이 문턱은 사용자 파일에게 아무 의미가 없다. 실제로 만들어지는 이름은
 *   넷뿐이므로(아래) 그 모양을 그대로 요구한다 — 이 모듈의 "우리 것임을 증명하지 못하면
 *   손대지 않는다" 와 같은 자세다.
 */
const SCRATCH_NAMES = Object.freeze([
  /^index-[a-z0-9_-]{1,64}-\d+$/, //          index-<runId>-<pid>
  /^state-[a-z0-9_-]{1,64}-\d+\.patch$/, //   state-<runId>-<pid>.patch
  /^step-[0-9a-f]{12}-\d+-\d+\.patch$/, //    step-<sha12>-<pid>-<seq>.patch
  /^final-[a-z0-9_-]{1,64}-\d+-\d+\.patch$/, // final-<runId>-<pid>-<seq>.patch
]);

/**
 * `<stateRoot>/patches/<runId>.patch` 를 남겨 둘 기간 (계획 2 이월 2).
 *
 * 그 파일에는 델리게이트가 만든 소스 전문이 평문으로 들어 있고, 실행마다 하나씩 쌓이는데
 * 아무도 지우지 않았다. 봉투는 그 경로를 사용자에게 알리므로 **바로 지울 수는 없다** —
 * 사용자가 나중에 열어 보는 것이 정상 사용법이다. 30일은 "그 실행을 다시 들여다볼 일이
 * 없다" 고 볼 수 있는 여유이자, 이 디렉터리가 무한히 자라지 않게 하는 상한이다.
 */
/**
 * `src/engine.mjs` 가 `patches/` 에 만드는 이름 모양. `<runId>.patch` 하나뿐이고 runId 는
 * `src/worktree.mjs` 의 `RUN_ID_PATTERN` 을 지난 값이다. scratch 와 같은 이유로 모양을
 * 요구한다 — 사용자가 그 디렉터리에 둔 파일에게 나이 문턱은 아무 의미가 없다.
 */
const PATCH_NAMES = Object.freeze([/^[a-z0-9][a-z0-9_-]{0,63}\.patch$/]);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const INIT_LOCK_PATTERN = /^\.init-lock-([a-z0-9][a-z0-9_-]{0,63})\.json$/;
const GENERATION_PATTERN = /^[0-9a-f]{12}$/;
const CHECKPOINT_TEMP_PATTERN = /^\.tmp-manifest\.json-(0|[1-9]\d*)-([0-9a-f]{12})$/;

const ledgerPath = (stateRoot) => join(stateRoot, LEDGER);

/** 원장을 읽는다. 없거나 깨졌으면 빈 목록 — 절대 throw 하지 않는다. */
export async function readRecords(stateRoot) {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(stateRoot), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    // pid 는 양수만. 0·음수는 프로세스 그룹을 가리켜 훨씬 위험하다.
    return parsed.filter((r) => r && typeof r === 'object' && Number.isInteger(r.pid) && r.pid > 0);
  } catch {
    // 깨진 원장은 그 안의 고아를 영영 못 보게 만들지만, 여기서 던지면 서버가 안 뜬다.
    return [];
  }
}

// 읽고-고쳐-쓰기라 병렬 호출이 서로를 덮는다. 프로세스 안에서 한 줄로 세운다(Task 7 과 같은 이유).
let writeQueue = Promise.resolve();
let tempCounter = 0;

async function updateRecords(stateRoot, mutate) {
  const run = async () => {
    try {
      const next = await mutate(await readRecords(stateRoot));
      await mkdir(stateRoot, { recursive: true });
      const target = ledgerPath(stateRoot);
      const temp = `${target}.${process.pid}.${tempCounter++}.tmp`;
      try {
        // rename 은 같은 볼륨 안에서 원자적이라, 읽는 쪽이 잘린 파일을 보는 일이 없다.
        await writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
        await rename(temp, target);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
    } catch {
      // 원장은 최선의 노력이다. 여기서 던지면 델리게이트 실행 자체가 실패한다.
    }
  };
  writeQueue = writeQueue.then(run, run);
  return writeQueue;
}

/**
 * 자식을 원장에 올리고, 끝나면 지운다.
 *
 * ★ 원장에 spawnargs 를 남기지 않는다. 거기엔 델리게이트에게 준 프롬프트가 들어 있고,
 *   원장은 디스크에 남아 사용자가 열어볼 수 있는 파일이다. 실행 파일 이름만 남긴다.
 */
export async function trackChild({ stateRoot, child, runId, worktree = null, deps = {} }) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const pid = child?.pid;
  if (!Number.isInteger(pid)) return;

  const [startTime, ownerStartTime] = await Promise.all([
    getStartTime(pid).catch(() => null),
    getStartTime(selfPid).catch(() => null),
  ]);

  const record = {
    pid,
    startTime: startTime ?? null,
    runId: typeof runId === 'string' ? runId : null,
    ownerPid: selfPid,
    ownerStartTime: ownerStartTime ?? null,
    spawnfile: typeof child.spawnfile === 'string' ? child.spawnfile : null,
    worktree: typeof worktree === 'string' ? worktree : null,
  };

  const remove = () =>
    updateRecords(stateRoot, (records) => records.filter((r) => !(r.pid === pid && r.runId === record.runId)));

  child.on('exit', () => remove());

  await updateRecords(stateRoot, (records) => [...records, record]);

  // 식별자를 조회하는 동안 자식이 이미 끝났을 수 있다. 그러면 위의 exit 리스너가
  // append 보다 먼저 돌아 아무것도 못 지운다 — 한 번 더 확인한다.
  if (child.exitCode !== null || child.signalCode !== null) await remove();
}

/**
 * **자식이 아니라 워크트리 자체**를 원장에 올린다. 절대 throw 하지 않는다.
 *
 * ★ 왜 필요한가: `trackChild` 기록은 자식이 exit 하는 순간 지워진다. 그런데 배선 계층이
 *   회수하지 **못한** 워크트리(`removed:false` — 남은 손자가 파일을 쥐고 있다)는 그 시점에
 *   자식이 이미 다 죽어 있어 원장에 아무 기록도 없다. 등록 회수 쪽도 못 본다(그 등록은
 *   `prunable` 이 아니라 살아 있다). 즉 리퍼의 **두 경로 모두**에 안 보이고, 남는 것은
 *   사용자 저장소의 완전한 사본(이식된 미커밋 내용 포함)이다.
 *
 * ★ 기록의 `pid` 는 **우리 자신**이다. 그래서 스윕이 이렇게 갈린다:
 *     우리가 살아 있는 동안  -> 다른 세션은 `classifyOwner` 가 'alive' 로 보고 건드리지 않는다.
 *     우리가 죽은 뒤        -> owner 는 'dead', 그 pid 는 없거나 재사용됐다. 어느 쪽이든
 *                              `isOurProcess` 가 거짓이라 **아무도 죽이지 않고** `stale` 로
 *                              분류된 뒤 워크트리만 지워진다.
 *   즉 이 기록은 "누굴 죽여라" 가 아니라 "이 디렉터리를 회수해라" 는 뜻이다.
 */
export async function trackWorktree({ stateRoot, runId, worktree, deps = {} }) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  // 스윕이 읽을 값이므로 **스윕과 같은 좌표계**로 눕혀서 적는다.
  const target = await resolveSafeWorktree(stateRoot, worktree);
  if (target === null) return false;

  const ownerStartTime = await getStartTime(selfPid).catch(() => null);
  await updateRecords(stateRoot, (records) => [
    ...records.filter((r) => !(r.pid === selfPid && r.runId === runId && r.worktree === target)),
    {
      pid: selfPid,
      startTime: ownerStartTime ?? null,
      runId: typeof runId === 'string' ? runId : null,
      ownerPid: selfPid,
      ownerStartTime: ownerStartTime ?? null,
      spawnfile: null,
      worktree: target,
    },
  ]);
  return true;
}

/**
 * 부팅 시 한 번 훑는다. **절대 throw 하지 않는다** — 부팅 경로에서 불리므로 여기서
 * 던지면 서버가 안 뜬다.
 */
export async function sweepOrphans({
  stateRoot,
  deps = {},
  sweepPatches: shouldSweepPatches = true,
  sweepRuns: shouldSweepRuns = true,
  excludeRunId,
} = {}) {
  const result = {
    killed: [],
    stale: [],
    skipped: [],
    scratch: { removed: 0, checked: 0 },
    patches: { removed: 0, checked: 0 },
    runs: { removed: [], checked: 0, skipped: [] },
  };
  try {
    const {
      selfPid = process.pid,
      getStartTime = defaultGetStartTime,
      treeKill: kill = treeKill,
      nowMs: getNowMs = Date.now,
      patchSweep = sweepPatches,
      runSweep = sweepRuns,
      rm: removeWorktree = rm,
    } = deps;

    // ★ 원장 조회 **앞**이다. 원장이 비어 있어도 scratch 와 artifact 에는 평문 내용이
    //   남아 있을 수 있는데, 아래 early return 뒤에 두면 정확히 그 경우에 안 돈다.
    const nowMs = getNowMs();
    result.scratch = await sweepScratch(stateRoot, nowMs);
    const hasExclusion = excludeRunId !== undefined;
    const artifactFlagsValid = typeof shouldSweepPatches === 'boolean' && typeof shouldSweepRuns === 'boolean';
    const exclusionValid = !hasExclusion || validRunId(excludeRunId);
    const exclusionUsable = exclusionValid && (shouldSweepPatches || shouldSweepRuns || !hasExclusion);
    if (artifactFlagsValid && exclusionUsable) {
      const options = hasExclusion ? { excludeRunId } : undefined;
      if (shouldSweepPatches) {
        result.patches = options === undefined
          ? await patchSweep(stateRoot, nowMs)
          : await patchSweep(stateRoot, nowMs, options);
      }
      if (shouldSweepRuns) {
        result.runs = options === undefined
          ? await runSweep(stateRoot, nowMs)
          : await runSweep(stateRoot, nowMs, options);
      }
    }

    const records = await readRecords(stateRoot);
    if (records.length === 0) return result;

    const done = new Set();

    for (const record of records) {
      const ownerLive = await lookup(getStartTime, record.ownerPid);
      const owner = classifyOwner(record, ownerLive, selfPid);
      // 다른 세션이 아직 살아 있거나(alive), 그 상태를 알 수 없으면(unknown) 손대지
      // 않는다. 둘을 합치지 않고 똑같이 skipped 로 보고하는 이유는, 호출부·로그에서
      // "왜 안 치웠나"를 알 수 있어야 하기 때문이다 — 조용한 continue 는 그 정보를
      // 버린다. 판정 자체는 classifyOwner 가 이미 세 갈래로 구분해 뒀다.
      if (owner === 'alive' || owner === 'unknown') {
        result.skipped.push(record.pid);
        continue;
      }

      const childLive = await lookup(getStartTime, record.pid);
      if (childLive === undefined) {
        // 모르는 것은 죽이지도 지우지도 않는다. 다음 부팅에 다시 본다.
        result.skipped.push(record.pid);
        continue;
      }

      if (childLive !== null && isOurProcess(record, childLive)) {
        // ★ kill 의 결과를 반드시 본다.
        //
        //   실패를 성공으로 보고하고 원장에서까지 지우면, 아직 살아 있는 자식이
        //   추적 대상에서 흔적도 없이 사라진다 — 다음 부팅에 다시 볼 기회도 없다.
        //   게다가 아래 워크트리 삭제까지 돌아, 아직 그 디렉터리를 쓰고 있는
        //   프로세스의 발밑을 빼버린다. 원본(BomPlugin)이 이 버그를 실제로 냈고
        //   "I4" 로 표시해 고쳤다. 실패하면 아무것도 건드리지 않고 다음 부팅에 맡긴다.
        const ok = await kill(record.pid).catch(() => false);
        if (!ok) {
          result.skipped.push(record.pid);
          continue;
        }
        result.killed.push(record.pid);
      } else {
        // 이미 없거나 pid 가 재사용됐다. 무관한 프로세스를 죽이지 않는다.
        result.stale.push(record.pid);
      }

      // 프로세스만 치우고 워크트리를 남기면 디스크가 샌다.
      const hasWorktree = typeof record.worktree === 'string' && record.worktree !== '';
      const target = hasWorktree ? await resolveSafeWorktree(stateRoot, record.worktree) : null;
      if (hasWorktree && target === null) continue;
      if (target !== null) {
        const removed = await removeWorktree(target, { recursive: true, force: true }).then(() => true, () => false);
        if (!removed) continue;
      }
      done.add(worktreeCompletionKey(record.pid, record.runId, target));
    }

    if (done.size > 0) {
      await updateRecords(stateRoot, async (current) => {
        const kept = [];
        for (const record of current) {
          const hasWorktree = typeof record.worktree === 'string' && record.worktree !== '';
          const target = hasWorktree ? await resolveSafeWorktree(stateRoot, record.worktree) : null;
          if (hasWorktree && target === null || !done.has(worktreeCompletionKey(record.pid, record.runId, target))) {
            kept.push(record);
          }
        }
        return kept;
      });
    }
  } catch {
    // 부팅을 막지 않는다.
  }
  return result;
}

function worktreeCompletionKey(pid, runId, canonicalWorktree) {
  const path = WINDOWS && typeof canonicalWorktree === 'string' ? canonicalWorktree.toLowerCase() : canonicalWorktree;
  return JSON.stringify([pid, runId, path]);
}

/**
 * 이 경로를 지워도 되는가. **표기만 비교하는 순수 함수다.**
 *
 * ★ 두 인자는 **이미 같은 좌표계로 편 값**이어야 한다. 링크·8.3 표기를 섞어서
 *   넣으면 거짓을 낸다. 편지 않은 값에서 출발한다면 아래 `resolveSafeWorktree` 를
 *   써라 — 그쪽이 두 인자를 먼저 눕힌다.
 *
 * ★ 문자열이 비었는지만 보던 시절에, 기록의 worktree 가 상태 루트를 가리키면
 *   `rm -rf` 가 상태 루트를 통째로 날렸다(리뷰어 실증: 다른 세션의 카탈로그와
 *   워크트리까지 전부 사라졌다). 이 모듈이 막으려는 "남의 프로세스를 죽인다"보다
 *   더 나쁜 결과다.
 *
 * 워크트리는 설계상 `<stateRoot>/worktrees/<runId>` 아래에만 만들어진다(§5.2).
 * 그 밖의 경로는 우리가 만든 것이 아니므로 지우지 않는다. 절대 경로여야 하고,
 * worktrees 디렉터리 자신이어서도 안 되며, `..` 로 빠져나가서도 안 된다.
 */
export function isSafeWorktree(stateRoot, worktree) {
  if (typeof stateRoot !== 'string' || stateRoot === '') return false;
  if (typeof worktree !== 'string' || worktree === '') return false;
  if (!isAbsolute(worktree)) return false;

  const base = resolve(stateRoot, 'worktrees');
  const target = resolve(worktree);
  const rel = relative(base, target);
  // 빈 문자열이면 base 자신이다. `..` 로 시작하면 바깥이다. 절대 경로면 다른 볼륨이다.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 두 경로를 같은 좌표계로 눕힌 뒤 `isSafeWorktree` 를 묻는다. 통과하면 **편 워크트리
 * 경로**, 아니면 `null`.
 *
 * ★ 왜 필요한가 (실측): 원장에 실리는 워크트리 경로는 `createWorktree` 가 실체 경로로
 *   편 값인데, 리퍼는 `src/state-root.mjs` 가 낸 값 — 사용자가 `BOM_ORCH_HOME` 에 적은
 *   문자열 그대로 — 으로 스윕한다. 상태 루트가 정션이나 8.3 단축 이름을 경유하면 두
 *   표기가 영영 같아지지 않아 `isSafeWorktree` 가 거짓을 냈고, 스윕이 프로세스만 죽이고
 *   `rm` 을 건너뛰었다. 남는 것은 사용자 저장소의 완전한 사본(이식된 미커밋 내용 포함)
 *   이다. 재현:
 *
 *     같은 표기      -> true
 *     정션 vs 실경로 -> false   ← rm 을 건너뛰었다
 *     8.3 vs 긴 이름 -> false   ← 같음
 *
 *   펴는 규칙은 `src/worktree.mjs` 와 **같은 함수**(`src/real-path.mjs` 의 `canonical`)
 *   를 쓴다. 두 곳이 다르면 그 차이가 다음 결함이 된다.
 *
 * 못 펴면(권한·I/O) `null` 이다 — 모르는 경로는 지우지 않는다.
 */
export async function resolveSafeWorktree(stateRoot, worktree) {
  if (typeof worktree !== 'string' || worktree === '' || !isAbsolute(worktree)) return null;
  const [realRoot, realWorktree] = await Promise.all([canonical(stateRoot), canonical(worktree)]);
  if (realRoot === null || realWorktree === null) return null;
  return isSafeWorktree(realRoot, realWorktree) ? realWorktree : null;
}

/**
 * `target` 이 `base` **밑**인가. 둘 다 이미 같은 좌표계로 편 값이어야 한다(`isSafeWorktree`
 * 와 같은 계약). `base` 자신은 거짓이다 — 담긴 것만 지운다.
 */
function isUnder(base, target) {
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function validRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value) && !WINDOWS_DEVICE_PATTERN.test(value);
}

function sameCanonicalPath(left, right) {
  return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function compareAscii(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const exactLstat = (path) => lstat(path, { bigint: true });

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function frozenRunResult({ removed = [], checked = 0, skipped = [] } = {}) {
  const unique = new Map();
  for (const record of skipped) unique.set(JSON.stringify([record.runId, record.code]), record);
  const orderedSkipped = [...unique.values()].sort((left, right) => {
    if (left.runId === null && right.runId !== null) return -1;
    if (left.runId !== null && right.runId === null) return 1;
    return compareAscii(left.runId ?? '', right.runId ?? '') || compareAscii(left.code, right.code);
  });
  return deepFreeze({
    removed: [...new Set(removed)].sort(compareAscii),
    checked,
    skipped: orderedSkipped.map((record) => ({ runId: record.runId, code: record.code })),
  });
}

function exactFunctionOptions(value, allowed) {
  if (value === undefined) return {};
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
      if (key !== 'excludeRunId' && typeof descriptor.value !== 'function') return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

async function canonicalValue(canonicalPath, path) {
  try {
    const value = await canonicalPath(path);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function lstatStatus(path, operation) {
  try {
    return { exists: true, info: await operation(path, { bigint: true }) };
  } catch (error) {
    return error?.code === 'ENOENT' ? { exists: false, info: null } : { exists: null, info: null };
  }
}

function kindOf(info) {
  try {
    if (info.isSymbolicLink()) return 'link';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'other';
  }
}

function direntKind(entry) {
  try {
    if (entry.isSymbolicLink()) return 'link';
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'other';
  }
}

function exactStatInteger(value, family) {
  if (family === 'bigint') return typeof value === 'bigint' && value >= 0n ? value.toString() : null;
  if (family === 'synthetic') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return null;
}

function statFamily(info) {
  const values = [info?.dev, info?.ino, info?.size];
  if (values.every((value) => typeof value === 'bigint')) return 'bigint';
  if (values.every((value) => typeof value === 'number')) return 'synthetic';
  return null;
}

function safeSizeInteger(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function exactStatTime(info, name, family) {
  if (family === 'bigint') {
    const ns = info[`${name}Ns`];
    return typeof ns === 'bigint' && ns >= 0n ? ns.toString() : null;
  }
  const ms = info[`${name}Ms`];
  return family === 'synthetic' && Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER
    ? String(ms)
    : null;
}

function statAuthority(info, kind) {
  const family = statFamily(info);
  const dev = exactStatInteger(info?.dev, family);
  const ino = exactStatInteger(info?.ino, family);
  const size = exactStatInteger(info?.size, family);
  const birthtime = exactStatTime(info ?? {}, 'birthtime', family);
  const mtime = exactStatTime(info ?? {}, 'mtime', family);
  const ctime = exactStatTime(info ?? {}, 'ctime', family);
  if (dev === null || ino === null || size === null || birthtime === null || mtime === null || ctime === null) {
    return null;
  }
  return {
    physicalKey: JSON.stringify([family, kind, dev, ino]),
    observationKey: JSON.stringify([family, kind, dev, ino, size, birthtime, mtime, ctime]),
    stableKey: JSON.stringify([family, kind, dev, ino, size, birthtime, mtime]),
    anchorKey: JSON.stringify([family, kind, dev, ino, birthtime]),
    deviceKey: JSON.stringify([family, dev]),
    size,
    mtime,
  };
}

function statIdentity(info, kind) {
  return statAuthority(info, kind)?.observationKey ?? null;
}

function quarantineIdentity(info, kind) {
  return statAuthority(info, kind)?.stableKey ?? null;
}

function anchorIdentity(info, kind) {
  return statAuthority(info, kind)?.anchorKey ?? null;
}

function physicalIdentity(info, kind) {
  return statAuthority(info, kind)?.physicalKey ?? null;
}

function safeStatSize(info) {
  const value = safeSizeInteger(info?.size);
  if (value === null) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function expiredStatMtime(info, nowMs, maxAgeMs) {
  const family = statFamily(info);
  if (family === 'bigint') {
    const mtime = exactStatTime(info, 'mtime', family);
    return mtime !== null && BigInt(nowMs) * 1_000_000n - BigInt(mtime) >= BigInt(maxAgeMs) * 1_000_000n;
  }
  const mtime = exactStatTime(info ?? {}, 'mtime', family);
  return mtime !== null && nowMs - Number(mtime) >= maxAgeMs;
}

function samePhysicalFile(left, right) {
  const leftKey = physicalIdentity(left, 'file');
  return leftKey !== null && leftKey === physicalIdentity(right, 'file');
}

function newSnapshot(root) {
  return { root, paths: new Map(), absent: new Set(), listings: new Map() };
}

function recordPath(snapshot, path, kind, info) {
  const authority = statAuthority(info, kind);
  if (authority === null) return false;
  snapshot.paths.set(path, {
    kind,
    identity: authority.observationKey,
    quarantineIdentity: authority.stableKey,
    anchorIdentity: authority.anchorKey,
    deviceIdentity: authority.deviceKey,
    physicalIdentity: authority.physicalKey,
  });
  return true;
}

function recordListing(snapshot, path, entries) {
  const normalized = entries.map((entry) => [entry.name, direntKind(entry)]).sort((a, b) => compareAscii(a[0], b[0]));
  snapshot.listings.set(path, JSON.stringify(normalized));
}

async function safeExisting(path, kind, context, codes = {}) {
  const status = await lstatStatus(path, context.deps.lstat);
  if (status.exists !== true || kindOf(status.info) !== kind) return { ok: false, code: codes.type ?? 'unsafe_type' };
  const real = await canonicalValue(context.deps.canonicalPath, path);
  if (real === null || !sameCanonicalPath(real, resolve(path)) ||
      !sameCanonicalPath(real, context.root) && !isUnder(context.root, real)) {
    return { ok: false, code: codes.alias ?? 'alias_mismatch' };
  }
  let privatePath = false;
  try {
    privatePath = await context.deps.verifyOwnerOnly({ path, kind }) === true;
  } catch {
    privatePath = false;
  }
  if (!privatePath) return { ok: false, code: codes.permission ?? 'permission_unverified' };
  if (!recordPath(context.snapshot, path, kind, status.info)) return { ok: false, code: codes.type ?? 'unsafe_type' };
  return { ok: true, info: status.info };
}

async function safeReadFile(path, context, { min = 0, max = Number.MAX_SAFE_INTEGER, code = 'invalid_inventory' } = {}) {
  const checked = await safeExisting(path, 'file', context);
  if (!checked.ok) return checked;
  const size = safeStatSize(checked.info);
  if (size === null || size < min || size > max) return { ok: false, code };
  try {
    const bytes = await context.deps.readFile(path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) return { ok: false, code };
    const after = await context.deps.lstat(path, { bigint: true });
    if (kindOf(after) !== 'file' || statIdentity(after, 'file') !== statIdentity(checked.info, 'file')) {
      return { ok: false, code: 'validation_changed' };
    }
    return { ok: true, info: after, bytes };
  } catch {
    return { ok: false, code };
  }
}

async function listDirectory(path, context) {
  try {
    const entries = await context.deps.readdir(path, { withFileTypes: true });
    if (!Array.isArray(entries)) return null;
    recordListing(context.snapshot, path, entries);
    return entries;
  } catch {
    return null;
  }
}

function canonicalJsonBytes(value) {
  try {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    return null;
  }
}

function decodeUtf8(bytes) {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validCanonicalPid(value) {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 0 && String(pid) === value;
}

function validArtifactTempSuffix(value) {
  const match = /^(\d+)-([0-9a-f]{12})$/.exec(value);
  return match !== null && validCanonicalPid(match[1]);
}

function validCheckpointTempName(name) {
  const match = CHECKPOINT_TEMP_PATTERN.exec(name);
  if (match === null) return false;
  return validCanonicalPid(match[1]);
}

async function readManifest(path, runId, context) {
  const file = await safeReadFile(path, context, { min: 1, max: MAX_RUN_MANIFEST_BYTES, code: 'invalid_manifest' });
  if (!file.ok) return file;
  const text = decodeUtf8(file.bytes);
  if (text === null) return { ok: false, code: 'invalid_manifest' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_manifest' };
  }
  const normalized = normalizeRunManifestV1(parsed);
  if (normalized === null || normalized.runId !== runId || !Number.isSafeInteger(normalized.expiresAt) || normalized.expiresAt < 0) {
    return { ok: false, code: 'invalid_manifest' };
  }
  const canonicalBytes = canonicalJsonBytes(normalized);
  if (canonicalBytes === null || !file.bytes.equals(canonicalBytes)) return { ok: false, code: 'noncanonical_manifest' };
  return { ok: true, manifest: normalized, bytes: canonicalBytes };
}

function exactInitLock(parsed, runId) {
  try {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
    const keys = ['schemaVersion', 'kind', 'runId', 'generation', 'pid', 'finalBasename', 'createdAt', 'expiresAt'];
    if (Reflect.ownKeys(parsed).length !== keys.length || keys.some((key) => !Object.hasOwn(parsed, key))) return null;
    if (parsed.schemaVersion !== 1 || parsed.kind !== 'run-artifact-init-lock' || parsed.runId !== runId ||
        !GENERATION_PATTERN.test(parsed.generation) || !Number.isSafeInteger(parsed.pid) || parsed.pid < 0 ||
        parsed.finalBasename !== runId || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0 ||
        parsed.expiresAt !== parsed.createdAt + RUN_ARTIFACT_RETENTION_MS || !Number.isSafeInteger(parsed.expiresAt)) return null;
    return {
      schemaVersion: 1,
      kind: 'run-artifact-init-lock',
      runId,
      generation: parsed.generation,
      pid: parsed.pid,
      finalBasename: runId,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function readInitLock(path, runId, context) {
  const checked = await safeExisting(path, 'file', context);
  if (!checked.ok) return checked;
  const size = safeStatSize(checked.info);
  if (size === 0) return { ok: true, zero: true, info: checked.info, value: null };
  if (size === null || size > MAX_RUN_MANIFEST_BYTES) {
    return { ok: false, code: 'invalid_lock' };
  }
  let bytes;
  try {
    bytes = await context.deps.readFile(path);
  } catch {
    return { ok: false, code: 'invalid_lock' };
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) return { ok: false, code: 'invalid_lock' };
  const text = decodeUtf8(bytes);
  let parsed;
  try {
    parsed = text === null ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const value = exactInitLock(parsed, runId);
  const canonicalBytes = value === null ? null : canonicalJsonBytes(value);
  if (canonicalBytes === null || !bytes.equals(canonicalBytes)) return { ok: false, code: 'invalid_lock' };
  return { ok: true, zero: false, info: checked.info, value };
}

async function validatePartialFinal(runDir, lock, context) {
  const entries = await listDirectory(runDir, context);
  if (entries === null) return { ok: false, code: 'unexpected_entry' };
  const names = entries.map((entry) => entry.name);
  const tempNames = names.filter((name) => name.startsWith('.tmp-manifest.json-'));
  const expectedTemp = `.tmp-manifest.json-${lock.pid}-`;
  if (tempNames.length > 1 || tempNames.some((name) =>
    !name.startsWith(expectedTemp) || !GENERATION_PATTERN.test(name.slice(expectedTemp.length)))) {
    return { ok: false, code: 'unexpected_entry' };
  }
  const children = names.filter((name) => !tempNames.includes(name));
  const allowedPrefixes = [
    [],
    ['candidates'],
    ['candidates', 'attempts'],
    ['candidates', 'attempts', 'evidence'],
  ];
  const prefix = allowedPrefixes.find((candidate) =>
    candidate.length === children.length && candidate.every((name) => children.includes(name)));
  if (prefix === undefined || tempNames.length === 1 && prefix.length !== 3) return { ok: false, code: 'unexpected_entry' };
  for (const name of prefix) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (direntKind(entry) !== 'directory') return { ok: false, code: 'unsafe_type' };
    const path = join(runDir, name);
    const checked = await safeExisting(path, 'directory', context);
    if (!checked.ok) return checked;
    const nested = await listDirectory(path, context);
    if (nested === null || nested.length !== 0) return { ok: false, code: 'unexpected_entry' };
  }
  if (tempNames.length === 1) {
    const path = join(runDir, tempNames[0]);
    const temp = await safeReadFile(path, context, { max: MAX_RUN_MANIFEST_BYTES, code: 'invalid_manifest' });
    if (!temp.ok) return temp;
    if (temp.bytes.length > 0) {
      const text = decodeUtf8(temp.bytes);
      let parsed = null;
      let parseable = false;
      try {
        if (text !== null) {
          parsed = JSON.parse(text);
          parseable = true;
        }
      } catch {
        // An interrupted byte prefix is owned by the exact lock and prefix.
      }
      if (parseable) {
        const manifest = normalizeRunManifestV1(parsed);
        const bytes = manifest === null ? null : canonicalJsonBytes(manifest);
        if (manifest === null || manifest.revision !== 0 || manifest.runId !== lock.runId ||
            manifest.generation !== lock.generation || manifest.createdAt !== lock.createdAt ||
            manifest.expiresAt !== lock.expiresAt || bytes === null || !bytes.equals(temp.bytes)) {
          return { ok: false, code: 'invalid_manifest' };
        }
      }
    }
  }
  return { ok: true };
}

function artifactIdentityPath(manifest, entry) {
  if (entry.artifactKind === 'attempt') {
    return `runs/${manifest.runId}/attempts/${entry.laneId}-${String(entry.attemptOrdinal).padStart(3, '0')}.json`;
  }
  if (entry.artifactKind === 'evidence') {
    return `runs/${manifest.runId}/evidence/${entry.laneId}-${String(entry.attemptOrdinal).padStart(3, '0')}-${String(entry.evidenceOrdinal).padStart(3, '0')}.json`;
  }
  if (entry.artifactKind === 'candidate') return `runs/${manifest.runId}/candidates/${entry.laneId}.patch`;
  if (entry.artifactKind === 'winner') return `patches/${manifest.runId}.patch`;
  return null;
}

function absoluteRelativePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\\') ||
      relativePath.startsWith('/') || relativePath.includes(':')) return null;
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) return null;
  const path = resolve(root, ...parts);
  return isUnder(root, path) ? path : null;
}

async function streamInventoryFile(path, expected, expectedSize) {
  let handle;
  let result;
  try {
    handle = await open(path, 'r');
    const opened = await handle.stat({ bigint: true });
    if (kindOf(opened) !== 'file' || statIdentity(opened, 'file') !== statIdentity(expected, 'file')) {
      result = { ok: false, code: 'validation_changed' };
    } else {
      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      while (size < expectedSize) {
        const length = Math.min(chunk.length, expectedSize - size);
        const { bytesRead } = await handle.read(chunk, 0, length, size);
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
          throw new Error('artifact ended before its prevalidated size');
        }
        size += bytesRead;
        hash.update(chunk.subarray(0, bytesRead));
      }
      const afterRead = await handle.stat({ bigint: true });
      result = statIdentity(afterRead, 'file') === statIdentity(opened, 'file')
        ? { ok: true, size, hash: hash.digest('hex') }
        : { ok: false, code: 'validation_changed' };
    }
  } catch {
    result = { ok: false, code: 'invalid_inventory' };
  }
  try {
    await handle?.close();
  } catch {
    return { ok: false, code: 'invalid_inventory' };
  }
  return result;
}

async function inspectInventoryFile(path, context, {
  requiredHash = null, requiredBytes = null, maxBytes = null, stream = false,
} = {}) {
  const status = await lstatStatus(path, context.deps.lstat);
  if (status.exists === false) {
    context.snapshot.absent.add(path);
    return { ok: true, exists: false, info: null, bytes: null, size: 0, hash: null };
  }
  if (status.exists !== true || kindOf(status.info) !== 'file') return { ok: false, code: 'unsafe_type' };
  if (stream) {
    const checked = await safeExisting(path, 'file', context);
    if (!checked.ok) return checked;
    const size = safeStatSize(checked.info);
    if (size === null || maxBytes !== null && size > maxBytes ||
        requiredBytes !== null && size !== requiredBytes) {
      return { ok: false, code: 'invalid_inventory' };
    }
    const streamed = await streamInventoryFile(path, checked.info, size);
    if (!streamed.ok) return streamed;
    const after = await lstatStatus(path, context.deps.lstat);
    if (after.exists !== true || kindOf(after.info) !== 'file' ||
        statIdentity(after.info, 'file') !== statIdentity(checked.info, 'file')) {
      return { ok: false, code: 'validation_changed' };
    }
    if (streamed.size !== size || requiredBytes !== null && streamed.size !== requiredBytes ||
        requiredHash !== null && streamed.hash !== requiredHash) return { ok: false, code: 'invalid_inventory' };
    return { ok: true, exists: true, info: after.info, bytes: null, size: streamed.size, hash: streamed.hash };
  }
  const checked = await safeReadFile(path, context, {
    max: maxBytes ?? Number.MAX_SAFE_INTEGER,
    code: 'invalid_inventory',
  });
  if (!checked.ok) return checked;
  if (requiredBytes !== null && checked.bytes.length !== requiredBytes ||
      requiredHash !== null && sha256(checked.bytes) !== requiredHash) return { ok: false, code: 'invalid_inventory' };
  return {
    ok: true,
    exists: true,
    info: checked.info,
    bytes: checked.bytes,
    size: checked.bytes.length,
    hash: sha256(checked.bytes),
  };
}

async function validatePendingArtifact(entry, finalPath, tempPath, context) {
  const boundedJson = entry.artifactKind === 'attempt' || entry.artifactKind === 'evidence';
  if (boundedJson && entry.expectedBytes > MAX_JSON_ARTIFACT_BYTES) return { ok: false, code: 'invalid_inventory' };
  const final = await inspectInventoryFile(finalPath, context, {
    requiredHash: entry.expectedSha256,
    requiredBytes: entry.expectedBytes,
    maxBytes: boundedJson ? MAX_JSON_ARTIFACT_BYTES : null,
    stream: !boundedJson,
  });
  if (!final.ok) return final;
  const temp = await inspectInventoryFile(tempPath, context, {
    maxBytes: entry.expectedBytes,
    stream: !boundedJson,
  });
  if (!temp.ok) return temp;
  if (temp.exists && temp.size === entry.expectedBytes && temp.hash !== entry.expectedSha256) {
    return { ok: false, code: 'invalid_inventory' };
  }
  if (final.exists && temp.exists &&
      (!samePhysicalFile(final.info, temp.info) || temp.size !== entry.expectedBytes ||
        final.hash !== temp.hash)) return { ok: false, code: 'invalid_inventory' };
  return { ok: true, final, temp };
}

async function validateCommittedArtifact(entry, finalPath, context, { allowAbsent = false } = {}) {
  if (!sameCanonicalPath(entry.ref.path, finalPath)) return { ok: false, code: 'invalid_inventory' };
  const boundedJson = entry.artifactKind === 'attempt' || entry.artifactKind === 'evidence';
  if (boundedJson && entry.ref.bytes > MAX_JSON_ARTIFACT_BYTES) return { ok: false, code: 'invalid_inventory' };
  const final = await inspectInventoryFile(finalPath, context, {
    requiredHash: entry.ref.sha256,
    requiredBytes: entry.ref.bytes,
    maxBytes: boundedJson ? MAX_JSON_ARTIFACT_BYTES : null,
    stream: !boundedJson,
  });
  if (!final.ok || !allowAbsent && !final.exists) return final.ok ? { ok: false, code: 'invalid_inventory' } : final;
  return { ok: true, final };
}

async function validateCheckpointTemp(path, current, currentBytes, context) {
  const temp = await safeReadFile(path, context, { max: MAX_RUN_MANIFEST_BYTES, code: 'checkpoint_temp_invalid' });
  if (!temp.ok) return temp;
  if (temp.bytes.length === 0 || temp.bytes.equals(currentBytes)) return { ok: true };
  const text = decodeUtf8(temp.bytes);
  let parsed;
  try {
    if (text === null) return { ok: true };
    parsed = JSON.parse(text);
  } catch {
    return { ok: true };
  }
  const next = normalizeRunManifestV1(parsed);
  const canonicalBytes = next === null ? null : canonicalJsonBytes(next);
  if (next === null || canonicalBytes === null || !canonicalBytes.equals(temp.bytes) || next.runId !== current.runId ||
      next.generation !== current.generation || next.createdAt !== current.createdAt || next.expiresAt !== current.expiresAt) {
    return { ok: false, code: 'checkpoint_temp_invalid' };
  }
  let validated;
  try {
    validated = context.deps.validateTransition(current, next);
  } catch {
    validated = null;
  }
  const validatedBytes = validated === null ? null : canonicalJsonBytes(validated);
  return validatedBytes !== null && validatedBytes.equals(temp.bytes)
    ? { ok: true }
    : { ok: false, code: 'checkpoint_temp_invalid' };
}

async function patchesView(manifest, context) {
  const patchesDir = join(context.root, 'patches');
  const status = await lstatStatus(patchesDir, context.deps.lstat);
  if (status.exists === false) {
    context.snapshot.absent.add(patchesDir);
    return { ok: true, path: patchesDir, entries: [], exists: false };
  }
  if (status.exists !== true || kindOf(status.info) !== 'directory') return { ok: false, code: 'alias_mismatch' };
  const checked = await safeExisting(patchesDir, 'directory', context, {
    type: 'alias_mismatch', alias: 'alias_mismatch', permission: 'permission_unverified',
  });
  if (!checked.ok) return checked;
  const entries = await listDirectory(patchesDir, context);
  return entries === null ? { ok: false, code: 'alias_mismatch' } : { ok: true, path: patchesDir, entries, exists: true };
}

async function validateWinnerInventory(manifest, winner, context, targets) {
  const view = await patchesView(manifest, context);
  if (!view.ok) return { ok: false, code: 'alias_mismatch' };
  const aliasName = `${manifest.runId}.patch`;
  const tempPrefix = `.tmp-${aliasName}-`;
  const relevant = view.entries.filter((entry) => entry.name === aliasName || entry.name.startsWith(tempPrefix));
  if (winner === null) return relevant.length === 0 ? { ok: true } : { ok: false, code: 'alias_mismatch' };
  const finalPath = join(view.path, aliasName);
  const expectedRelative = artifactIdentityPath(manifest, winner);
  if (winner.relativePath !== expectedRelative || absoluteRelativePath(context.root, winner.relativePath) !== finalPath) {
    return { ok: false, code: 'invalid_inventory' };
  }
  if (Object.hasOwn(winner, 'tempRelativePath')) {
    const tempPath = absoluteRelativePath(context.root, winner.tempRelativePath);
    const expectedPrefix = `patches/${tempPrefix}`;
    if (tempPath === null || !winner.tempRelativePath.startsWith(expectedPrefix)) return { ok: false, code: 'invalid_inventory' };
    const suffix = winner.tempRelativePath.slice(expectedPrefix.length);
    if (!validArtifactTempSuffix(suffix)) return { ok: false, code: 'invalid_inventory' };
    const state = await validatePendingArtifact(winner, finalPath, tempPath, context);
    if (!state.ok) return { ok: false, code: 'alias_mismatch' };
    const allowed = new Set([
      ...(state.final.exists ? [aliasName] : []),
      ...(state.temp.exists ? [basename(tempPath)] : []),
    ]);
    if (relevant.some((entry) => !allowed.has(entry.name)) || relevant.length !== allowed.size) {
      return { ok: false, code: 'alias_mismatch' };
    }
    if (state.final.exists) targets.push(finalPath);
    if (state.temp.exists) targets.push(tempPath);
    return { ok: true };
  }
  const state = await validateCommittedArtifact(winner, finalPath, context, { allowAbsent: true });
  if (!state.ok) return { ok: false, code: 'alias_mismatch' };
  if (relevant.some((entry) => entry.name !== aliasName) || relevant.length !== (state.final.exists ? 1 : 0)) {
    return { ok: false, code: 'alias_mismatch' };
  }
  const candidate = manifest.candidateRefs.find((entry) => entry.candidateId === winner.candidateId);
  if (candidate?.patchRef === null || candidate?.patchRef === undefined ||
      candidate.patchRef.sha256 !== winner.ref.sha256 || candidate.patchRef.bytes !== winner.ref.bytes) {
    return { ok: false, code: 'alias_mismatch' };
  }
  if (state.final.exists) targets.push(finalPath);
  return { ok: true };
}

async function validateCompleteFinal(runDir, manifestRecord, context) {
  const { manifest, bytes: manifestBytes } = manifestRecord;
  const rootEntries = await listDirectory(runDir, context);
  if (rootEntries === null) return { ok: false, code: 'unexpected_entry' };
  const checkpointLookalikes = rootEntries.filter((entry) => entry.name.startsWith('.tmp-manifest.json-'));
  const checkpointEntries = checkpointLookalikes.filter((entry) => validCheckpointTempName(entry.name));
  if (checkpointEntries.length !== checkpointLookalikes.length) return { ok: false, code: 'checkpoint_temp_invalid' };
  if (checkpointEntries.length > 1) return { ok: false, code: 'checkpoint_temp_invalid' };
  const allowedRoot = new Set(['manifest.json', 'candidates', 'attempts', 'evidence', ...checkpointEntries.map((entry) => entry.name)]);
  if (rootEntries.some((entry) => !allowedRoot.has(entry.name)) || rootEntries.length !== allowedRoot.size) {
    return { ok: false, code: 'unexpected_entry' };
  }
  const directories = new Map();
  for (const name of ['candidates', 'attempts', 'evidence']) {
    const entry = rootEntries.find((candidate) => candidate.name === name);
    if (entry === undefined || direntKind(entry) !== 'directory') return { ok: false, code: 'unsafe_type' };
    const path = join(runDir, name);
    const checked = await safeExisting(path, 'directory', context);
    if (!checked.ok) return checked;
    const entries = await listDirectory(path, context);
    if (entries === null) return { ok: false, code: 'unexpected_entry' };
    directories.set(name, { path, entries, allowed: new Set() });
  }
  if (checkpointEntries.length === 1) {
    if (direntKind(checkpointEntries[0]) !== 'file') return { ok: false, code: 'unsafe_type' };
    const checkpoint = await validateCheckpointTemp(join(runDir, checkpointEntries[0].name), manifest, manifestBytes, context);
    if (!checkpoint.ok) return checkpoint;
  }

  const targets = [runDir];
  const inventories = [...manifest.pendingArtifacts, ...manifest.committedArtifacts];
  const winner = inventories.find((entry) => entry.artifactKind === 'winner') ?? null;
  for (const entry of inventories.filter((item) => item.artifactKind !== 'winner')) {
    const expectedRelative = artifactIdentityPath(manifest, entry);
    const finalPath = absoluteRelativePath(context.root, entry.relativePath);
    if (expectedRelative === null || entry.relativePath !== expectedRelative || finalPath === null) {
      return { ok: false, code: 'invalid_inventory' };
    }
    const owner = entry.artifactKind === 'candidate' ? 'candidates'
      : entry.artifactKind === 'attempt' ? 'attempts' : 'evidence';
    const directory = directories.get(owner);
    if (dirname(finalPath) !== directory.path) return { ok: false, code: 'invalid_inventory' };
    if (Object.hasOwn(entry, 'tempRelativePath')) {
      const tempPath = absoluteRelativePath(context.root, entry.tempRelativePath);
      if (tempPath === null || dirname(tempPath) !== directory.path) return { ok: false, code: 'invalid_inventory' };
      const expectedTempPrefix = `.tmp-${basename(finalPath)}-`;
      const suffix = basename(tempPath).startsWith(expectedTempPrefix)
        ? basename(tempPath).slice(expectedTempPrefix.length) : '';
      if (!validArtifactTempSuffix(suffix)) return { ok: false, code: 'invalid_inventory' };
      const state = await validatePendingArtifact(entry, finalPath, tempPath, context);
      if (!state.ok) return state;
      if (state.final.exists) directory.allowed.add(basename(finalPath));
      if (state.temp.exists) directory.allowed.add(basename(tempPath));
    } else {
      const state = await validateCommittedArtifact(entry, finalPath, context);
      if (!state.ok) return state;
      directory.allowed.add(basename(finalPath));
    }
  }
  for (const { entries, allowed } of directories.values()) {
    if (entries.some((entry) => !allowed.has(entry.name)) || entries.length !== allowed.size) {
      return { ok: false, code: 'unexpected_entry' };
    }
  }
  const alias = await validateWinnerInventory(manifest, winner, context, targets);
  if (!alias.ok) return alias;
  return { ok: true, targets };
}

async function validateRunUnit({ root, runsDir, runId, finalEntry, lockEntry, nowMs, deps }) {
  const context = { root, deps, snapshot: newSnapshot(root) };
  for (const [path, kind] of [[root, 'directory'], [runsDir, 'directory']]) {
    const checked = await safeExisting(path, kind, context);
    if (!checked.ok) return checked;
  }
  const currentRuns = await listDirectory(runsDir, context);
  if (currentRuns === null) return { ok: false, code: 'unsafe_type' };
  // Discovery establishes which logical IDs are counted. Ownership validation uses
  // a fresh directory view so a lock/final published in between cannot be mistaken
  // for the older half-unit that discovery observed.
  finalEntry = currentRuns.find((entry) => entry.name === runId) ?? null;
  lockEntry = currentRuns.find((entry) => entry.name === `.init-lock-${runId}.json`) ?? null;
  const finalPath = join(runsDir, runId);
  const lockPath = join(runsDir, `.init-lock-${runId}.json`);
  let lock = null;
  if (lockEntry !== null) {
    if (direntKind(lockEntry) !== 'file') return { ok: false, code: 'unsafe_type' };
    lock = await readInitLock(lockPath, runId, context);
    if (!lock.ok) return lock.code === 'unsafe_type' || lock.code === 'permission_unverified' || lock.code === 'alias_mismatch'
      ? lock : { ok: false, code: 'invalid_lock' };
  } else {
    context.snapshot.absent.add(lockPath);
  }

  if (lock?.zero) {
    if (finalEntry !== null) return { ok: false, code: 'invalid_lock' };
    const expired = expiredStatMtime(lock.info, nowMs, RUN_ARTIFACT_RETENTION_MS);
    return { ok: true, expired, targets: expired ? [lockPath] : [], snapshot: context.snapshot };
  }
  if (lock !== null && nowMs < lock.value.expiresAt) {
    return { ok: true, expired: false, targets: [], snapshot: context.snapshot };
  }
  if (finalEntry === null) {
    context.snapshot.absent.add(finalPath);
    return lock === null
      ? { ok: false, code: 'missing_manifest' }
      : { ok: true, expired: true, targets: [lockPath], snapshot: context.snapshot };
  }
  if (direntKind(finalEntry) !== 'directory') return { ok: false, code: 'unsafe_type' };
  const final = await safeExisting(finalPath, 'directory', context);
  if (!final.ok) return final;
  const finalEntries = await listDirectory(finalPath, context);
  if (finalEntries === null) return { ok: false, code: 'unexpected_entry' };
  const manifestEntry = finalEntries.find((entry) => entry.name === 'manifest.json') ?? null;
  if (manifestEntry === null) {
    if (lock === null) return { ok: false, code: 'missing_manifest' };
    const partial = await validatePartialFinal(finalPath, lock.value, context);
    if (!partial.ok) return partial;
    return {
      ok: true,
      expired: true,
      targets: [finalPath, lockPath],
      snapshot: context.snapshot,
    };
  }
  if (direntKind(manifestEntry) !== 'file') return { ok: false, code: 'unsafe_type' };
  const manifest = await readManifest(join(finalPath, 'manifest.json'), runId, context);
  if (!manifest.ok) return manifest;
  if (lock !== null && (manifest.manifest.generation !== lock.value.generation ||
      manifest.manifest.createdAt !== lock.value.createdAt || manifest.manifest.expiresAt !== lock.value.expiresAt)) {
    return { ok: false, code: 'generation_mismatch' };
  }
  if (nowMs < manifest.manifest.expiresAt) {
    return { ok: true, expired: false, targets: [], snapshot: context.snapshot };
  }
  const complete = await validateCompleteFinal(finalPath, manifest, context);
  if (!complete.ok) return complete;
  return {
    ok: true,
    expired: true,
    targets: [...complete.targets, ...(lock === null ? [] : [lockPath])],
    snapshot: context.snapshot,
  };
}

async function revalidateSnapshot(snapshot, deps) {
  for (const [path, expected] of snapshot.paths) {
    const status = await lstatStatus(path, deps.lstat);
    if (status.exists !== true || kindOf(status.info) !== expected.kind ||
        statIdentity(status.info, expected.kind) !== expected.identity) return false;
    const real = await canonicalValue(deps.canonicalPath, path);
    if (real === null || !sameCanonicalPath(real, resolve(path)) ||
        !sameCanonicalPath(real, snapshot.root) && !isUnder(snapshot.root, real)) return false;
  }
  for (const path of snapshot.absent) {
    if ((await lstatStatus(path, deps.lstat)).exists !== false) return false;
  }
  for (const [path, expected] of snapshot.listings) {
    try {
      const entries = await deps.readdir(path, { withFileTypes: true });
      const actual = JSON.stringify(entries.map((entry) => [entry.name, direntKind(entry)])
        .sort((a, b) => compareAscii(a[0], b[0])));
      if (actual !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function createQuarantineParent(snapshot, deps) {
  const runsDir = join(snapshot.root, 'runs');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let path;
    try {
      path = join(runsDir, `.reap-${randomBytes(16).toString('hex')}`);
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      return null;
    }
    const status = await lstatStatus(path, deps.lstat);
    if (status.exists !== true || kindOf(status.info) !== 'directory') return null;
    const real = await canonicalValue(deps.canonicalPath, path);
    if (real === null || !sameCanonicalPath(real, resolve(path)) || !isUnder(snapshot.root, real)) return null;
    let privatePath = false;
    try {
      privatePath = await deps.verifyOwnerOnly({ path, kind: 'directory' }) === true;
    } catch {
      return null;
    }
    if (!privatePath) return null;
    let entries;
    try {
      entries = await deps.readdir(path, { withFileTypes: true });
    } catch {
      return null;
    }
    if (!Array.isArray(entries) || entries.length !== 0) return null;
    const authority = statAuthority(status.info, 'directory');
    if (authority === null) return null;
    return { path, anchorIdentity: authority.anchorKey };
  }
  return null;
}

function remapQuarantinedPath(path, movedTargets) {
  const target = movedTargets.find((candidate) =>
    sameCanonicalPath(path, candidate.path) || isUnder(candidate.path, path));
  if (target === undefined) return null;
  const suffix = relative(target.path, path);
  const mapped = suffix === '' ? target.movedPath : resolve(target.movedPath, suffix);
  return sameCanonicalPath(mapped, target.movedPath) || isUnder(target.movedPath, mapped)
    ? { path: mapped, target }
    : null;
}

function intentionallyChangedParent(path, movedTargets, quarantine) {
  return sameCanonicalPath(path, dirname(quarantine.path)) ||
    movedTargets.some((target) => sameCanonicalPath(path, dirname(target.path)));
}

function expectedQuarantinedListing(path, expected, movedTargets, quarantine, afterRemoval) {
  let entries;
  try {
    entries = JSON.parse(expected);
  } catch {
    return null;
  }
  let changed = false;
  for (const target of movedTargets) {
    if (!sameCanonicalPath(path, dirname(target.path))) continue;
    entries = entries.filter(([name]) => name !== basename(target.path));
    changed = true;
  }
  if (sameCanonicalPath(path, dirname(quarantine.path))) {
    if (!afterRemoval) entries.push([basename(quarantine.path), 'directory']);
    changed = true;
  }
  return changed
    ? JSON.stringify(entries.sort((a, b) => compareAscii(a[0], b[0])))
    : expected;
}

async function validateQuarantinedSnapshot(snapshot, movedTargets, quarantine, deps, { afterRemoval = false } = {}) {
  for (const [path, expected] of snapshot.paths) {
    const mapped = remapQuarantinedPath(path, movedTargets);
    if (mapped !== null) {
      if (afterRemoval) continue;
      const status = await lstatStatus(mapped.path, deps.lstat);
      const topLevel = sameCanonicalPath(path, mapped.target.path);
      if (status.exists !== true || kindOf(status.info) !== expected.kind ||
          (topLevel
            ? quarantineIdentity(status.info, expected.kind) !== expected.quarantineIdentity
            : statIdentity(status.info, expected.kind) !== expected.identity)) return false;
      const real = await canonicalValue(deps.canonicalPath, mapped.path);
      if (real === null || !sameCanonicalPath(real, resolve(mapped.path)) ||
          !sameCanonicalPath(real, mapped.target.movedPath) && !isUnder(mapped.target.movedPath, real)) return false;
      continue;
    }
    const status = await lstatStatus(path, deps.lstat);
    const mutableParent = intentionallyChangedParent(path, movedTargets, quarantine);
    if (status.exists !== true || kindOf(status.info) !== expected.kind ||
        (mutableParent
          ? anchorIdentity(status.info, expected.kind) !== expected.anchorIdentity
          : statIdentity(status.info, expected.kind) !== expected.identity)) return false;
    const real = await canonicalValue(deps.canonicalPath, path);
    if (real === null || !sameCanonicalPath(real, resolve(path)) ||
        !sameCanonicalPath(real, snapshot.root) && !isUnder(snapshot.root, real)) return false;
  }
  for (const path of snapshot.absent) {
    const mapped = remapQuarantinedPath(path, movedTargets);
    if (mapped !== null && !afterRemoval) {
      if ((await lstatStatus(mapped.path, deps.lstat)).exists !== false) return false;
    } else if (mapped === null && (await lstatStatus(path, deps.lstat)).exists !== false) {
      return false;
    }
  }
  for (const [path, expected] of snapshot.listings) {
    const mapped = remapQuarantinedPath(path, movedTargets);
    if (mapped !== null && afterRemoval) continue;
    const listingPath = mapped?.path ?? path;
    try {
      const entries = await deps.readdir(listingPath, { withFileTypes: true });
      if (!Array.isArray(entries)) return false;
      const actual = JSON.stringify(entries.map((entry) => [entry.name, direntKind(entry)])
        .sort((a, b) => compareAscii(a[0], b[0])));
      const expectedListing = mapped === null
        ? expectedQuarantinedListing(path, expected, movedTargets, quarantine, afterRemoval)
        : expected;
      if (expectedListing === null || actual !== expectedListing) return false;
    } catch {
      return false;
    }
  }
  for (const { path } of movedTargets) {
    if ((await lstatStatus(path, deps.lstat)).exists !== false) return false;
  }
  return true;
}

async function classifyRenameFailure(path, movedPath, expected, movedTargets, deps) {
  const source = await lstatStatus(path, deps.lstat);
  const destination = await lstatStatus(movedPath, deps.lstat);
  const sourceUnchanged = source.exists === true && kindOf(source.info) === expected.kind &&
    expectedSourceUnchanged(source.info, expected, movedTargets);
  const destinationExpected = destination.exists === true && kindOf(destination.info) === expected.kind &&
    quarantineIdentity(destination.info, expected.kind) === expected.quarantineIdentity;
  if (source.exists === false && destinationExpected) {
    return { completed: true, info: destination.info };
  }
  if (sourceUnchanged && destination.exists === false) return { completed: false, code: 'removal_failed' };
  return { completed: false, code: 'validation_changed' };
}

function patchRemovalTarget(path, root) {
  if (!sameCanonicalPath(dirname(path), join(root, 'patches'))) return false;
  const name = basename(path);
  if (name.endsWith('.patch') && !name.startsWith('.tmp-')) {
    return validRunId(name.slice(0, -'.patch'.length));
  }
  const match = /^\.tmp-([a-z0-9][a-z0-9_-]{0,63})\.patch-(\d+-[0-9a-f]{12})$/.exec(name);
  return match !== null && validRunId(match[1]) && validArtifactTempSuffix(match[2]);
}

function prepareRemovalTargets(targets, snapshot) {
  const runsDir = join(snapshot.root, 'runs');
  const quarantineDevice = snapshot.paths.get(runsDir)?.deviceIdentity ?? null;
  if (quarantineDevice === null) return null;
  const unique = [...new Set(targets)];
  const prepared = [];
  for (const path of unique) {
    if (typeof path !== 'string' || !isAbsolute(path) || !sameCanonicalPath(resolve(path), path) ||
        !isUnder(snapshot.root, path)) return null;
    const expected = snapshot.paths.get(path);
    if (expected === undefined || expected.deviceIdentity !== quarantineDevice) return null;
    const lockMatch = INIT_LOCK_PATTERN.exec(basename(path));
    let rank;
    if (expected.kind === 'file' && patchRemovalTarget(path, snapshot.root)) rank = 0;
    else if (expected.kind === 'file' && sameCanonicalPath(dirname(path), runsDir) &&
        lockMatch !== null && validRunId(lockMatch[1])) rank = 1;
    else if (expected.kind === 'directory' && sameCanonicalPath(dirname(path), runsDir) &&
        validRunId(basename(path))) rank = 2;
    else return null;
    prepared.push({ path, expected, rank });
  }
  for (let left = 0; left < prepared.length; left += 1) {
    for (let right = left + 1; right < prepared.length; right += 1) {
      if (sameCanonicalPath(prepared[left].path, prepared[right].path) ||
          isUnder(prepared[left].path, prepared[right].path) ||
          isUnder(prepared[right].path, prepared[left].path)) return null;
    }
  }
  return prepared.sort((left, right) => left.rank - right.rank || compareAscii(left.path, right.path));
}

function movedHardlinkPeer(expected, movedTargets) {
  if (expected.kind !== 'file') return null;
  return movedTargets.find((target) => target.expected.physicalIdentity === expected.physicalIdentity) ?? null;
}

function expectedSourceUnchanged(info, expected, movedTargets) {
  const hardlinkPeer = movedHardlinkPeer(expected, movedTargets);
  if (hardlinkPeer === null) return statIdentity(info, expected.kind) === expected.identity;
  return quarantineIdentity(info, expected.kind) === expected.quarantineIdentity &&
    quarantineIdentity(info, expected.kind) === quarantineIdentity(hardlinkPeer.movedInfo, expected.kind);
}

async function removeOwnedTargets(targets, snapshot, deps) {
  const prepared = prepareRemovalTargets(targets, snapshot);
  if (prepared === null || prepared.length === 0) return 'validation_changed';
  const quarantine = await createQuarantineParent(snapshot, deps);
  if (quarantine === null) return 'removal_failed';
  const movedTargets = [];
  for (const [index, { path, expected }] of prepared.entries()) {
    const status = await lstatStatus(path, deps.lstat);
    if (status.exists !== true || kindOf(status.info) !== expected.kind ||
        !expectedSourceUnchanged(status.info, expected, movedTargets)) return 'validation_changed';
    const movedPath = join(quarantine.path, `unit-${String(index).padStart(3, '0')}`);
    if ((await lstatStatus(movedPath, deps.lstat)).exists !== false) return 'validation_changed';
    let moved;
    try {
      await rename(path, movedPath);
    } catch {
      const classified = await classifyRenameFailure(path, movedPath, expected, movedTargets, deps);
      if (!classified.completed) return classified.code;
      moved = { exists: true, info: classified.info };
    }
    moved ??= await lstatStatus(movedPath, deps.lstat);
    if (moved.exists !== true || kindOf(moved.info) !== expected.kind ||
        quarantineIdentity(moved.info, expected.kind) !== expected.quarantineIdentity) {
      return 'validation_changed';
    }
    movedTargets.push({ path, movedPath, expected, movedInfo: moved.info });
  }
  const parent = await lstatStatus(quarantine.path, deps.lstat);
  if (parent.exists !== true || kindOf(parent.info) !== 'directory' ||
      anchorIdentity(parent.info, 'directory') !== quarantine.anchorIdentity) return 'validation_changed';
  const parentIdentity = statIdentity(parent.info, 'directory');
  let listing;
  try {
    listing = await deps.readdir(quarantine.path, { withFileTypes: true });
  } catch {
    return 'validation_changed';
  }
  if (!Array.isArray(listing)) return 'validation_changed';
  listing.sort((left, right) => compareAscii(left.name, right.name));
  if (listing.length !== movedTargets.length || listing.some((entry, index) =>
    entry.name !== `unit-${String(index).padStart(3, '0')}` ||
    direntKind(entry) !== movedTargets[index].expected.kind)) return 'validation_changed';
  const parentBeforeRemoval = await lstatStatus(quarantine.path, deps.lstat);
  if (parentBeforeRemoval.exists !== true || kindOf(parentBeforeRemoval.info) !== 'directory' ||
      statIdentity(parentBeforeRemoval.info, 'directory') !== parentIdentity) return 'validation_changed';
  const parentReal = await canonicalValue(deps.canonicalPath, quarantine.path);
  if (parentReal === null || !sameCanonicalPath(parentReal, resolve(quarantine.path)) ||
      !isUnder(snapshot.root, parentReal)) return 'validation_changed';
  let privateParent = false;
  try {
    privateParent = await deps.verifyOwnerOnly({ path: quarantine.path, kind: 'directory' }) === true;
  } catch {
    privateParent = false;
  }
  if (!privateParent) return 'validation_changed';
  for (const { movedPath, expected } of movedTargets) {
    const moved = await lstatStatus(movedPath, deps.lstat);
    if (moved.exists !== true || kindOf(moved.info) !== expected.kind ||
        quarantineIdentity(moved.info, expected.kind) !== expected.quarantineIdentity) return 'validation_changed';
    const real = await canonicalValue(deps.canonicalPath, movedPath);
    if (real === null || !sameCanonicalPath(real, resolve(movedPath)) || !isUnder(quarantine.path, real)) {
      return 'validation_changed';
    }
  }
  if (!await validateQuarantinedSnapshot(snapshot, movedTargets, quarantine, deps)) return 'validation_changed';
  try {
    await deps.rm(quarantine.path, { recursive: true, force: true });
  } catch {
    return 'removal_failed';
  }
  if ((await lstatStatus(quarantine.path, deps.lstat)).exists !== false) return 'removal_failed';
  if (!await validateQuarantinedSnapshot(snapshot, movedTargets, quarantine, deps, { afterRemoval: true })) {
    return 'validation_changed';
  }
  return null;
}

/**
 * Fully validates and reaps expired run ownership units. This function never throws and
 * never exposes physical paths or filesystem errors in its bounded result.
 */
export async function sweepRuns(stateRoot, nowMs, options) {
  const emptyUnsafe = (code) => frozenRunResult({ skipped: [{ runId: null, code }] });
  const parsed = exactFunctionOptions(options, new Set([
    'excludeRunId', 'canonicalPath', 'lstat', 'readdir', 'readFile', 'rm',
    'verifyOwnerOnly', 'validateTransition', 'barrier',
  ]));
  if (parsed === null || typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot) ||
      !sameCanonicalPath(resolve(stateRoot), stateRoot) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return emptyUnsafe('unsafe_root');
  }
  if (Object.hasOwn(parsed, 'excludeRunId') && !validRunId(parsed.excludeRunId)) return emptyUnsafe('invalid_exclusion');
  const deps = {
    canonicalPath: parsed.canonicalPath ?? canonical,
    lstat: parsed.lstat ?? exactLstat,
    readdir: parsed.readdir ?? readdir,
    readFile: parsed.readFile ?? readFile,
    rm: parsed.rm ?? rm,
    verifyOwnerOnly: parsed.verifyOwnerOnly ?? verifyArtifactOwnerOnly,
    validateTransition: parsed.validateTransition ?? validateRunManifestTransitionV1,
    barrier: parsed.barrier ?? (async () => {}),
  };
  try {
    const rootStatus = await lstatStatus(stateRoot, deps.lstat);
    if (rootStatus.exists !== true || kindOf(rootStatus.info) !== 'directory') return emptyUnsafe('unsafe_root');
    const root = await canonicalValue(deps.canonicalPath, stateRoot);
    if (root === null || !sameCanonicalPath(root, resolve(stateRoot))) return emptyUnsafe('unsafe_root');
    const runsDir = join(root, 'runs');
    const runsStatus = await lstatStatus(runsDir, deps.lstat);
    if (runsStatus.exists === false) return frozenRunResult();
    if (runsStatus.exists !== true || kindOf(runsStatus.info) !== 'directory') {
      return frozenRunResult({ skipped: [{ runId: null, code: 'unsafe_type' }] });
    }
    const preflight = { root, deps, snapshot: newSnapshot(root) };
    for (const [path, kind] of [[root, 'directory'], [runsDir, 'directory']]) {
      const checked = await safeExisting(path, kind, preflight);
      if (!checked.ok) return frozenRunResult({ skipped: [{ runId: null, code: checked.code }] });
    }
    let entries;
    try {
      entries = await deps.readdir(runsDir, { withFileTypes: true });
    } catch {
      return frozenRunResult({ skipped: [{ runId: null, code: 'unsafe_type' }] });
    }
    const groups = new Map();
    let foreign = false;
    const excluded = parsed.excludeRunId;
    for (const entry of entries) {
      const lockMatch = INIT_LOCK_PATTERN.exec(entry.name);
      const finalRunId = validRunId(entry.name) ? entry.name : null;
      const lockRunId = lockMatch !== null && validRunId(lockMatch[1]) ? lockMatch[1] : null;
      const runId = finalRunId ?? lockRunId;
      if (runId === null) {
        foreign = true;
        continue;
      }
      if (runId === excluded) continue;
      const group = groups.get(runId) ?? { finalEntry: null, lockEntry: null };
      if (finalRunId !== null) group.finalEntry = entry;
      else group.lockEntry = entry;
      groups.set(runId, group);
    }

    const removed = [];
    const skipped = foreign ? [{ runId: null, code: 'unrecognized_entry' }] : [];
    const ordered = [...groups.entries()].sort((left, right) => compareAscii(left[0], right[0]));
    for (const [runId, group] of ordered) {
      const validation = await validateRunUnit({ root, runsDir, runId, ...group, nowMs, deps });
      if (!validation.ok) {
        skipped.push({ runId, code: validation.code });
        continue;
      }
      if (!validation.expired) continue;
      try {
        await deps.barrier('before-run-delete');
      } catch {
        skipped.push({ runId, code: 'validation_changed' });
        continue;
      }
      if (!await revalidateSnapshot(validation.snapshot, deps)) {
        skipped.push({ runId, code: 'validation_changed' });
        continue;
      }
      const removalCode = await removeOwnedTargets(validation.targets, validation.snapshot, deps);
      if (removalCode !== null) {
        skipped.push({ runId, code: removalCode });
        continue;
      }
      removed.push(runId);
    }
    return frozenRunResult({ removed, checked: groups.size, skipped });
  } catch {
    return emptyUnsafe('unsafe_root');
  }
}

/**
 * 상태 루트 밑의 디렉터리 하나에서 **우리가 만든 이름 모양**의 낡은 파일만 지운다.
 * **절대 throw 하지 않는다.**
 *
 * ★ 판정 재료가 이 모듈의 나머지와 다르다: 이 파일들은 원장에 없어서 소유자를 확인할
 *   방법이 나이뿐이다. 그래서 이름 모양과 나이를 **둘 다** 요구하고, 그 위에 경로를
 *   `canonical` 로 편 뒤 그 디렉터리 밑인지 확인한다(`resolveSafeWorktree` 와 같은
 *   규율). 못 펴면 지우지 않는다.
 *
 * ★ 두 호출자(scratch · patches)가 **같은 함수**를 지난다. 각자 자기 규칙을 갖게 되면
 *   그 차이가 곧 다음 결함이다 — 이 저장소는 경로 비교에서 그 결함을 세 번 냈다.
 *
 * @returns `{ removed, checked }` — `checked` 는 이름 모양이 맞아 나이를 본 개수다.
 */
async function sweepAged({ stateRoot, name, shapes, maxAgeMs, nowMs, excludeName = null, acceptName = null }) {
  const empty = { removed: 0, checked: 0 };
  const realRoot = await canonical(stateRoot);
  if (realRoot === null) return empty;

  // 그 자리가 정션이면 실체는 상태 루트 밖일 수 있다. 이름 모양과 나이만 보면 링크
  // 하나로 스윕의 사정거리가 사용자 디렉터리까지 늘어난다.
  const dir = await canonical(join(realRoot, name));
  if (dir === null || !isUnder(realRoot, dir)) return empty;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return empty;
  }

  let removed = 0;
  let checked = 0;
  for (const entry of entries) {
    if (entry.name === excludeName) continue;
    // `withFileTypes` 의 판정은 lstat 계열이라 심링크는 여기서 이미 걸러진다. 아래
    // `canonical` 확인은 그 위의 두 번째 겹이다(디렉터리 정션·마운트 포인트).
    if (!entry.isFile() || !shapes.some((shape) => shape.test(entry.name)) ||
        acceptName !== null && !acceptName(entry.name)) continue;
    checked += 1;
    const full = await canonical(join(dir, entry.name));
    if (full === null || !isUnder(dir, full)) continue;
    const info = await stat(full).catch(() => null);
    if (info === null || nowMs - info.mtimeMs < maxAgeMs) continue;
    if (await rm(full, { force: true }).then(() => true, () => false)) removed += 1;
  }
  return { removed, checked };
}

/**
 * 강제 종료가 남긴 오래된 scratch 잔재를 치운다.
 *
 * ★ 왜 리퍼에 있나 (계획 2 이월 1): 원래는 `src/engine.mjs` 안에 있어서 **실행이 시작될
 *   때만** 돌았다. 그러면 부팅한 뒤 한 번도 실행하지 않은 세션에서 아무도 치우지 않는다.
 *   부팅 스윕(`sweepOrphans`)이 같은 일을 하고, 실행 시작 스윕도 **그대로 둔다** — 장수
 *   서버에서는 부팅이 며칠에 한 번이라 그 사이에 생긴 6시간 잔재를 부팅 스윕이 못 본다.
 *   두 자리가 같은 함수를 부른다.
 */
export function sweepScratch(stateRoot, nowMs) {
  return sweepAged({ stateRoot, name: 'scratch', shapes: SCRATCH_NAMES, maxAgeMs: SCRATCH_STALE_MS, nowMs });
}

/**
 * 보존 기간이 지난 최종 패치를 치운다 (계획 2 이월 2). scratch 와 같은 두 자리에서 돈다.
 */
export function sweepPatches(stateRoot, nowMs, options) {
  const parsed = exactFunctionOptions(options, new Set(['excludeRunId']));
  if (parsed === null || Object.hasOwn(parsed, 'excludeRunId') && !validRunId(parsed.excludeRunId)) {
    return Promise.resolve({ removed: 0, checked: 0 });
  }
  return sweepAged({
    stateRoot,
    name: 'patches',
    shapes: PATCH_NAMES,
    maxAgeMs: RUN_ARTIFACT_RETENTION_MS,
    nowMs,
    excludeName: Object.hasOwn(parsed, 'excludeRunId') ? `${parsed.excludeRunId}.patch` : null,
    acceptName: (name) => validRunId(name.slice(0, -'.patch'.length)),
  });
}

/** undefined = 조회 실패, null = 없는 프로세스, 객체 = 살아 있음. */
async function lookup(getStartTime, pid) {
  // ★ 0 과 음수는 프로세스가 아니라 프로세스 **그룹**을 가리킨다. process.kill(0) 은
  //   자기 그룹 전체, kill(-1) 은 보낼 수 있는 모든 프로세스에 신호를 보낸다.
  //   원장이 손상돼 그런 값이 들어오면 잘못된 pid 하나보다 훨씬 나쁘다.
  if (!Number.isInteger(pid) || pid <= 0) return null;
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
//
// 이 저장소의 no-live-spawn 가드가 node 외 스폰을 막으므로 단위 테스트는 이 경로를
// 타지 않는다. 진짜 프로브 검증은 Task 20 의 라이브 스위트가 한다.

/**
 * 프로브 실행 파일의 **절대 경로**. 못 찾으면 null (호출부가 fail-closed 로 거부한다).
 *
 * ★ 왜 이름으로 스폰하면 안 되는가 (Task 1 의 C-A 와 같은 부류): 아래 `spawn` 은 `cwd`
 *   를 주지 않으므로 자식이 **우리 프로세스의 cwd** 를 물려받는다. 그런데 이 서버의
 *   cwd 는 호스트에게서 물려받은 값이다 — `.codex-plugin/mcp.json` 은 `"cwd": "."` 이고
 *   Claude Code 도 워크스페이스 루트에서 서버를 띄운다. Windows 의 libuv 는 실행 파일
 *   이름에 경로 구분자가 없으면 그 cwd 를 PATH 보다 먼저 뒤진다. 즉 **대상 저장소
 *   루트에 `taskkill.exe` 를 커밋해 두면 리퍼가 스윕할 때 그것이 실행됐다.**
 *
 * ★ fail-closed. 해석에 실패해도 이름으로 되돌아가지 않는다 — 되돌아가면 위 취약점이
 *   그대로 돌아온다. 대신 "실행 자체가 안 됨"(failed)으로 보고해서, 위쪽이 그것을
 *   "모름"(getStartTime) 과 "죽이지 못함"(treeKill) 으로 정확히 전파하게 한다.
 *
 * `src/git.mjs` 의 `resolveGitPath()` 와 같은 방식으로 `resolveBinary` 를 재사용한다.
 * 다만 그쪽과 달리 **성공도 캐시하지 않는다**: 서버가 도는 중에 상황이 바뀔 수 있고,
 * 실패를 캐시하면 재시작할 때까지 고장 난 채로 남는다(resolve-binary 주석 참조).
 *
 * ★ "PATH 워크 한 번은 비용이 아니다"라고 적어 뒀던 것은 **히트 케이스에만 맞다**
 *   (사실만 적는다 — 캐시를 넣을지는 여기서 판단하지 않는다):
 *
 *     찾은 경우   — 앞쪽 디렉터리에서 멎는다. 이 기계에서 호출당 0.08ms.
 *     못 찾은 경우 — PATH 전체 × PATHEXT 를 끝까지 훑는다. 같은 기계에서 13.4ms
 *                    (PATH 항목 172개). 약 170배다.
 *
 *   그리고 `sweepOrphans` 는 원장 레코드당 이 함수를 2회 이상 부른다(ownerPid 조회 ·
 *   자식 pid 조회 · treeKill). 즉 **fail-closed 가 발동하는 상황이 정확히 느린 쪽**이고,
 *   그 비용은 레코드 수에 비례해 부팅 경로에 얹힌다. 반대로 정상 동작할 때는 캐시가
 *   없어도 눈에 띄지 않는다.
 */
function resolveProbePath(basename) {
  let resolved;
  try {
    resolved = resolveBinary({ basename });
  } catch {
    return null;
  }
  // resolveBinary 가 비절대 PATH 항목을 이미 걸러내므로(그쪽 pathDirs 참조) 이 줄만
  // 빼도 관측되는 동작은 바뀌지 않는다. fail-closed 가 원칙이고 비용이 한 줄이라 남긴다.
  return typeof resolved === 'string' && isAbsolute(resolved) ? resolved : null;
}

/**
 * 프로브를 한 번 돌린다. `basename` 은 확장자 없는 실행 파일 이름이다 — 절대 경로
 * 해석은 여기서 한다(위 resolveProbePath 참조).
 */
function runCommand(basename, args) {
  return new Promise((resolve) => {
    const command = resolveProbePath(basename);
    if (command === null) {
      // 이름으로 되돌아가지 않는다. "실행 자체가 안 됨" 으로 보고한다.
      resolve({
        ok: false,
        stdout: '',
        failed: true,
        timedOut: false,
        error: new Error(`프로브 실행 파일을 PATH 에서 절대 경로로 찾지 못했습니다: ${basename}`),
      });
      return;
    }
    let child;
    try {
      // ★ stderr 를 'pipe' 로 열어두고 아무도 안 읽으면, 자식이 파이프 버퍼(64KB)를
      //   채우는 순간 블록되고 우리는 상한까지 헛되이 기다린다. 안 읽을 거면 안 연다.
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ ok: false, stdout: '', failed: true, timedOut: false, error });
      return;
    }
    let stdout = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 이미 죽었다.
      }
    }, PROBE_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, failed: true, timedOut, error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // ★ "실행은 됐는데 종료 코드가 0 이 아니다" 와 "실행 자체가 안 됐다" 는 다르다.
      //   전자는 "그런 프로세스 없음" 일 수 있지만 후자는 "모름" 이다. 뭉개면
      //   살아 있는 남의 세션을 죽은 것으로 판정한다.
      resolve({ ok: code === 0, stdout, failed: timedOut, timedOut, error: null });
    });
  });
}

/**
 * 프로세스의 시작 시각. undefined = 조회 실패, null = 그런 프로세스 없음.
 *
 * 이 셋을 구분하는 것이 이 모듈의 안전성 전부다. "모름"을 "죽음"으로 뭉개면 살아 있는
 * 남의 프로세스를 정리 대상으로 본다.
 *
 * ★ 테스트 전용 export. 이 저장소의 가드가 taskkill/ps/powershell 스폰을 막아 단위
 *   테스트는 이 함수를 전부 주입으로 대체한다 — 진짜 프로브는 test/live/os-probe.test.mjs
 *   에서만 검증된다(Task 21).
 */
export async function defaultGetStartTime(pid) {
  if (WINDOWS) {
    // 'powershell' — 확장자는 resolveBinary 가 PATHEXT 를 보고 붙인다.
    const { ok, failed, stdout } = await runCommand('powershell', [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.Ticks } else { 'ABSENT' }`,
    ]);
    if (failed || !ok) return undefined;
    const text = stdout.trim();
    if (text === 'ABSENT') return null;
    return text === '' ? undefined : text;
  }

  const { ok, failed, stdout } = await runCommand('ps', ['-o', 'lstart=', '-p', String(pid)]);

  // ★ "실행 자체가 안 됐다/걸렸다"(failed)와 "실행은 됐는데 못 찾았다"를 구분한다.
  //
  //   전에는 `if (!ok) return stdout.trim() === '' ? null : undefined` 였다. 그런데
  //   타임아웃이나 스폰 실패는 ok=false 이면서 stdout 이 거의 항상 비어 있다 — 아무것도
  //   못 찍고 끝났으니까. 그래서 "모름"이 "없는 프로세스"로 뭉개졌다. 그 판정이 남의
  //   세션의 ownerPid 에 걸리면, 느리게 응답한 살아 있는 세션이 죽은 것으로 분류되고
  //   그 자식이 정리 대상이 된다 — 이 모듈이 막으려던 바로 그 사고다.
  if (failed) return undefined;

  // ps 는 못 찾으면 종료 코드가 0 이 아니고 stdout 이 빈다. 그건 진짜 "없음"이다.
  const text = stdout.trim();
  if (!ok) return text === '' ? null : undefined;
  return text === '' ? null : text;
}

/**
 * 프로세스와 그 자손을 끊는다.
 *
 * ★ 물려받는 한계: Windows 의 `/T` 는 살아 있는 트리만 훑으므로 reparent 된 손자는
 *   놓친다. POSIX 의 그룹 신호도 같다. 고칠 방법이 없어 문서화만 한다.
 *
 * ★ 불리언 결과를 절대 버리지 않는다. 계획 1 이 여기서 Critical 을 냈다 — 실패를
 *   성공으로 보고하면 sweepOrphans 가 살아 있는 자식을 원장에서 지우고 그 워크트리까지
 *   삭제한다. **실행 파일 해석 실패도 "죽이지 못함"으로 전파되어야 한다**: Windows 는
 *   kill 을 taskkill 이 통째로 대행하므로, 그걸 못 띄웠으면 아무것도 죽지 않은 것이다.
 *   (POSIX 는 다르다 — 아래 참조.)
 *
 * 유예 기간은 없다. 정중한 신호를 무시하는 CLI 는 데드라인만 늘린다.
 */
export async function treeKill(pid) {
  if (WINDOWS) {
    const { ok } = await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
    return ok;
  }
  // ★ POSIX 에서 `ps` 는 **보조**다: 그룹 리더인지 알아내는 데만 쓰고, 실제 신호는
  //   process.kill 이 보낸다. 그래서 `ps` 를 해석하지 못해도 "죽이지 못함"으로 단정하지
  //   않는다 — 그러면 정말 죽인 프로세스를 안 죽였다고 보고해 원장이 영영 안 비워진다.
  //   pgid 를 모르면 그룹이 아니라 그 pid 하나에만 보낸다(resolvePosixKillTarget 참조).
  //   결과는 process.kill 이 정한다.
  const { ok, stdout } = await runCommand('ps', ['-o', 'pgid=', '-p', String(pid)]);
  const pgid = ok ? Number.parseInt(stdout.trim(), 10) : Number.NaN;
  try {
    process.kill(resolvePosixKillTarget(pid, Number.isNaN(pgid) ? null : pgid), 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
