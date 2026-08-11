import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveBinary } from './providers/resolve-binary.mjs';
import { canonical } from './real-path.mjs';

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
const PATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `src/engine.mjs` 가 `patches/` 에 만드는 이름 모양. `<runId>.patch` 하나뿐이고 runId 는
 * `src/worktree.mjs` 의 `RUN_ID_PATTERN` 을 지난 값이다. scratch 와 같은 이유로 모양을
 * 요구한다 — 사용자가 그 디렉터리에 둔 파일에게 나이 문턱은 아무 의미가 없다.
 */
const PATCH_NAMES = Object.freeze([/^[a-z0-9][a-z0-9_-]{0,63}\.patch$/]);

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
      const next = mutate(await readRecords(stateRoot));
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
export async function sweepOrphans({ stateRoot, deps = {} } = {}) {
  const result = {
    killed: [],
    stale: [],
    skipped: [],
    scratch: { removed: 0, checked: 0 },
    patches: { removed: 0, checked: 0 },
  };
  try {
    const {
      selfPid = process.pid,
      getStartTime = defaultGetStartTime,
      treeKill: kill = treeKill,
    } = deps;

    // ★ 원장 조회 **앞**이다. 원장이 비어 있어도 scratch 와 patches 에는 평문 내용이
    //   남아 있을 수 있는데, 아래 early return 뒤에 두면 정확히 그 경우에 안 돈다.
    const nowMs = Date.now();
    result.scratch = await sweepScratch(stateRoot, nowMs);
    result.patches = await sweepPatches(stateRoot, nowMs);

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
      const target = await resolveSafeWorktree(stateRoot, record.worktree);
      if (target !== null) await rm(target, { recursive: true, force: true }).catch(() => {});
      done.add(`${record.pid}:${record.runId}`);
    }

    if (done.size > 0) {
      await updateRecords(stateRoot, (current) => current.filter((r) => !done.has(`${r.pid}:${r.runId}`)));
    }
  } catch {
    // 부팅을 막지 않는다.
  }
  return result;
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
async function sweepAged({ stateRoot, name, shapes, maxAgeMs, nowMs }) {
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
    // `withFileTypes` 의 판정은 lstat 계열이라 심링크는 여기서 이미 걸러진다. 아래
    // `canonical` 확인은 그 위의 두 번째 겹이다(디렉터리 정션·마운트 포인트).
    if (!entry.isFile() || !shapes.some((shape) => shape.test(entry.name))) continue;
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
export function sweepPatches(stateRoot, nowMs) {
  return sweepAged({ stateRoot, name: 'patches', shapes: PATCH_NAMES, maxAgeMs: PATCH_RETENTION_MS, nowMs });
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
