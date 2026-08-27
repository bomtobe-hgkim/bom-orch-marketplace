// src/apply-patch.mjs
/**
 * 적용기 — 끝난 실행의 대표 패치를 **사용자 저장소**에 넣는 한 걸음(WS5 스펙 §0 AP·D4·D5).
 *
 * ★★ **로드맵의 축자 레시피(「`--check` → 안 되면 `--3way`」)는 지으면 안 된다.** 리서치 메모
 *   §C.4 의 실측이 그 이유다(git 2.55.0.windows.3, 이 태스크가 재측정해 같은 답):
 *
 *     `git apply --3way --check`   충돌이 나도 **exit 0**. 유일한 신호는 stderr 산문이다.
 *     `git apply --3way`           충돌 마커를 **써 놓고** exit 1. 종료 코드만 보면 "안 됐다".
 *
 *   즉 그 둘의 종료 코드는 각각 반대 방향으로 거짓말한다. 이 저장소는 벤더 산문에 분기하지
 *   않으므로(WS2 §7.2) 판정은 **인덱스**로 한다: 임시 `GIT_INDEX_FILE` 에 `--3way --cached` 한 뒤
 *   `git ls-files -u` 가 비었는가. 일회용 워크트리 적용기는 평범한 `apply --cached` 사전 검사를
 *   쓰고 pristine 강제·자동 복원·`commitAll` 을 수행하므로 본체를 공유하지 않는다. Task 11이
 *   추출한 `src/worktree-patch.mjs` 에서 값이 같은 git 타임아웃과 객체 id 판정만 함께 읽는다.
 *   사용자 저장소는 정의상 상태 루트 밖이고, 보통 깨끗하지 않고, 커밋을 찍어서는 안 된다.
 *
 * ★ **이 파일이 사용자 저장소를 쓰는 자리는 둘뿐이다**: `git apply`(직접 갈래)와
 *   `git apply --3way`(3-way 갈래). 둘은 모든 관문과 완성된 백업 manifest 뒤에 있고,
 *   `checkOnly` 면 둘 다 안 돈다. 쓰기 뒤 실패 처리는 저장소 경로를 읽어 비교할 뿐 쓰기·삭제·
 *   chmod·디렉터리 생성을 하지 않는다. 나머지는 상태 루트 안의 임시 인덱스·객체 저장소·백업이다.
 *   ★ 읽기가 정말 읽기인가도 실측해야 했다: `git status --porcelain` 은 stat 캐시가 낡으면
 *     `.git/index` 를 **다시 쓴다**(재리뷰 실측 — 내용이 한 바이트도 안 바뀐 파일의 mtime 만
 *     밀어도 인덱스 sha256 이 바뀌었다). 그래서 이 파일의 두 `status` 호출은
 *     `--no-optional-locks` 로 돈다 — 같은 픽스처에서 인덱스 바이트가 그대로다(실측).
 *   **관문이 거절하는** 경로가 저장소를 바이트 그대로 남긴다는 것은 `test/apply-patch.test.mjs`
 *   가 파일 바이트·`.git/index` 바이트·porcelain 한 장·**`.git/objects` 전수** 넷을 대조해
 *   증명한다.
 *   ★ 넷째 축의 경계 하나: 위 두 명령이 **이미 돈 뒤**의 거절은 인덱스 바이트나 객체 축을
 *     주장하지 않는다. 실패한 `git apply --3way` 도 빈 blob 하나를 사용자 객체 DB 에 남길 수
 *     있고, porcelain 동일성만으로 인덱스 바이트 동일성을 증명할 수 없기 때문이다.
 *
 * ★ 그 넷째 재료는 **리뷰가 반증한 뒤에 생겼다**(태스크 8 리뷰 I1). 예전 이 파일은 위 문장을
 *   적어 놓고도 `check_only` 하나로 사용자 객체 DB 를 13 → 17 로 늘렸다: `--3way --cached` 와
 *   `write-tree` 는 임시 **인덱스**에 쓰지만 그 인덱스가 가리키는 blob·tree 는 저장소가 공유하는
 *   객체 DB 로 들어가기 때문이다(워크트리가 객체 DB 를 공유하는 것과 같은 이유다). 지금은
 *   판정용 명령 전부가 `GIT_OBJECT_DIRECTORY` 로 **상태 루트 안의 임시 객체 저장소**에 쓰고
 *   `GIT_ALTERNATE_OBJECT_DIRECTORIES` 로 사용자 객체 DB 를 **읽기 전용으로** 끌어 쓴다 —
 *   git 은 진짜 객체를 다 읽고 새 객체는 임시 자리에만 쓰며, 그 자리는 `finally` 에서 지워진다.
 *   판정에 쓰는 것은 트리 **id 문자열**이라 어디에 쓰였든 값이 같다(실측: 임시 저장소에서 낸
 *   `write-tree` 와 적용 뒤 진짜 인덱스의 `write-tree` 가 같은 id 를 낸다).
 *   ★★ 그 배선이 **인덱스 축에서 한 번 되물었다**(재리뷰 C2). `GIT_OBJECT_DIRECTORY` 만 돌리고
 *     `GIT_INDEX_FILE` 을 안 주면 `write-tree` 는 **사용자의 진짜 `.git/index`** 를 읽고 그
 *     인덱스의 cache-tree 를 자기가 낸 트리 id 로 **도장 찍는다**. 그 트리는 스크래치에만
 *     있었으므로 `finally` 가 지우는 순간 사용자 인덱스에 매달린 포인터가 죽는다 — 실측:
 *     `git fsck` exit 8 ("invalid sha1 pointer in cache-tree of .git/index") · `git gc
 *     --prune=now` exit 128 ("fatal: bad tree object") · 임계를 넘긴 `git gc --auto` 도 같은
 *     자리에서 죽는다. 그래서 사후 확인은 진짜 인덱스의 **사본**(`<scratch>/index-copy`)에서
 *     돈다: 도장은 사본에 찍히고 사본은 `finally` 가 지운다.
 *
 * ★ 실패한 쓰기를 자동으로 되돌리지 않는다. 적용과 동시에 다른 프로세스가 같은 경로를 바꿀 수
 *   있고, portable Node.js 에는 그 변경을 원자적으로 구별해 복원할 path-scoped CAS/openat 가 없다.
 *   그래서 쓰기 전에 경로·바이트·모드와 디렉터리 정보를 manifest 로 남기고, 쓰기 뒤에는 읽어서
 *   비교만 한다. 차이가 하나라도 있으면 현재 트리와 매핑된 백업을 함께 남겨 사람이 복구한다.
 *
 * ★ 실측 폐포: **19개 모듈 / 7,111줄**(자기 자신 891 포함) — `git` 과 그것이 끄는
 *   `providers/error-catalog`·`providers/resolve-binary`·`reason-codes`·`reason-text`·
 *   `state-root`, 그리고 `util/*`. **`engine` 도 저장소(`run-artifacts`)도 0개다** — 이 파일은
 *   패치 바이트와 저장소 경로만 알고 실행이 무엇인지 모른다. 폐포의 대부분(2,000줄 남짓)이
 *   사유 레지스트리 둘인 것은 이 저장소의 모든 실패 경로가 치르는 값이다.
 */
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { runGit } from './git.mjs';
import { REASON } from './reason-codes.mjs';
import {
  armScratchRoom,
  closeScratchRoom,
  createScratchRoom,
  retainScratchRoom,
} from './scratch-rooms.mjs';
import { contained } from './util/paths.mjs';
import { isFullObjectId, WORKTREE_TIMEOUT_MS } from './worktree-patch.mjs';

/**
 * **보고할** 파일 수의 상한. 이 값이 봉투로 나가지는 않지만(자르는 자리는 `src/tools/apply.mjs`),
 * 여기서도 한 번 자른다 — 5만 파일짜리 패치의 `--numstat` 을 통째로 레코드 배열에 담을 이유가
 * 없다.
 *
 * ★ **이 상한은 관문의 경로 집합에는 안 걸린다**(태스크 8 리뷰 I2). 걸리면 사용자의 미커밋 변경이
 *   관문에 안 보여 「stash 하라」 대신 「새 실행을 시작하라」가 나가고, 그 회복은 원인을 못 고친다.
 * ★ **어디가 안 보이게 되는지는 다시 재야 했다**(재리뷰). 관문의 집합은 `--numstat` 과
 *   `-R --numstat` 의 **합집합**이고 `-R` 은 레코드를 **역순**으로 낸다(실측: 500 파일 패치에서
 *   정방향은 `f/000`…`f/499`, 역방향은 `f/499`…`f/000`). 그래서 둘 다 200 에서 자르면 보이는
 *   것은 앞 200 ∪ 뒤 200 이고, **400 파일까지는 구멍이 없다** — 260 파일 패치의 259번째 파일이
 *   안 보인다고 적었던 옛 문장은 `-R` 이 생기기 전의 실측이었다. 진짜 구멍은 **401 파일부터**의
 *   가운데다(500 파일 패치의 251번째 = 정방향 250 · 역방향 249, 양쪽 슬라이스 밖). 자르는
 *   구현으로 그 픽스처를 태우면 `apply_worktree_dirty` 대신 `apply_baseline_moved` 가 나온다.
 * ★ 왜 경로 집합은 안 잘라도 되는가: `--numstat` 의 stdout **문자열 전체**가 이미 메모리에 있고
 *   경로는 그 문자열의 슬라이스다. 관문의 `Set` 을 200 에서 자르는 것이 아끼는 메모리는
 *   그 문자열 앞에서 무의미하다 — 자르는 것으로 사는 것은 오진뿐이었다.
 *   `test/apply-patch.test.mjs` 가 `parseNumstat` 자신에게 **전수 260 · 배열 200** 을 직접 묻는다
 *   (관문 픽스처만으로는 위 합집합이 절단을 가려 준다 — 재리뷰가 그 변이의 생존을 실측했다).
 */
const MAX_FILES = 200;

/** 더러운 추적 파일 이름을 몇 개까지 들고 나가는가. 봉투가 다시 자르지만 여기가 첫 상한이다. */
const MAX_DIRTY_SAMPLE = 10;

const fail = (reasonCode, params = {}) => ({ blocked: true, reasonCode, params });

/**
 * git 이 낸 마지막 줄 하나. 우리 판정은 **절대** 이 문자열을 보지 않는다 — 오직 사람에게
 * 보여 줄 `{detail}` 자리로만 간다(그래서 `apply_git_failed` 에만 실린다).
 */
function gitDetail(result) {
  const raw = typeof result?.stderrTail === 'string' && result.stderrTail !== ''
    ? result.stderrTail
    : (typeof result?.stderr === 'string' ? result.stderr : '');
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.length === 0 ? 'git produced no output' : lines[lines.length - 1];
}

const gitFail = (result) => fail(REASON.apply_git_failed, { detail: gitDetail(result) });
const gitDidNotComplete = (result) => result?.failed === true || result?.timedOut === true;

/**
 * `git status --porcelain -z` 한 장을 추적 변경과 미추적으로 가른다.
 *
 * ★ 이름 바뀜(`R`)·복사(`C`)는 **레코드를 둘** 쓴다(새 이름 다음에 옛 이름). 둘째를 상태로
 *   읽으면 경로 하나가 상태 문자열로 둔갑한다 — 그래서 소비한다.
 * ★ 추적 변경과 미추적을 가르는 이유는 판정이 서로 다르기 때문이다: 3-way 는 인덱스와 다른
 *   **추적** 파일에서 막히고(실측 "does not match index"), 미추적 파일은 인덱스에 없으므로
 *   그 판정에 안 든다.
 */
export function parseStatusPorcelain(text) {
  const tracked = [];
  const untracked = [];
  if (typeof text !== 'string' || text === '') return { tracked, untracked };
  const records = text.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (state === '??') untracked.push(path);
    else {
      // 첫 글자는 **인덱스 대 HEAD**, 둘째는 **작업 파일 대 인덱스**다. 이 도구는 둘을 다르게
      // 쓴다(아래 3-way 관문) — 한 덩어리로 접으면 그 구별이 사라진다.
      // ★ **두 글자 원문(`state`)도 함께 나른다**(재리뷰2). 불리언 둘로 접으면 `" M"`(수정)과
      //   `" D"`(지워짐)이 같은 값이 되고, 쓰기 뒤의 대조가 그 둘의 차이를 못 본다 — 실측:
      //   패치가 이름 안 부르는 파일이 수정에서 삭제로 바뀌었는데 대조가 **빈 목록**을 냈다.
      tracked.push({ path, state, staged: state[0] !== ' ', unstaged: state[1] !== ' ' });
      if (state[0] === 'R' || state[0] === 'C') i += 1;
    }
  }
  return { tracked, untracked };
}

/**
 * `git apply --numstat -z` 한 장. 실측 형식: `<더한 줄>\t<지운 줄>\t<경로>\0` 이고, 바이너리는
 * 두 수가 `-` 다. `-z` 라 경로는 따옴표로 감싸이지 않는다 — 비 ASCII 경로도 그대로 나온다(실측:
 * 패치 헤더 쪽은 `"src/\303\251\303\240 uni.txt"` 로 인용되는데 `-z` 출력은 인용이 없다).
 *
 * 두 가지를 낸다: 봉투가 쓰는 **레코드 배열**(`MAX_FILES` 에서 자른다)과 관문·백업이 쓰는
 * **경로 전수**(`paths`, 안 자른다 — 위 `MAX_FILES` 의 ★ 를 보라).
 */
export function parseNumstat(text) {
  const files = [];
  const paths = [];
  let omitted = 0;
  if (typeof text !== 'string' || text === '') return { files, omitted, paths };
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    paths.push(record.slice(second + 1));
    if (files.length >= MAX_FILES) { omitted += 1; continue; }
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    files.push({
      path: record.slice(second + 1),
      added: added === '-' ? null : Number.parseInt(added, 10),
      deleted: deleted === '-' ? null : Number.parseInt(deleted, 10),
    });
  }
  return { files, omitted, paths };
}

/**
 * 봉투의 `baseline.available` 보고값 — manifest commit/tree 두 이름이 아직 풀리는지만 묻는다.
 * 3-way 가능 여부는 이 값으로 판정하지 않는다: 빈 합성 커밋만 gc 되고 patch preimage 는 현재
 * 이력에서 계속 닿을 수 있고, 반대로 commit/tree 이름은 풀려도 필요한 blob 하나가 없을 수 있다.
 */
async function baselineIsPresent(run, repoPath, baseline) {
  const commit = baseline?.commit;
  const tree = baseline?.tree;
  if (typeof commit !== 'string' || typeof tree !== 'string') return false;
  for (const revision of [`${commit}^{commit}`, `${tree}^{tree}`]) {
    const got = await run({ args: ['rev-parse', '--verify', '--quiet', revision], cwd: repoPath, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (got?.ok !== true) return false;
  }
  return true;
}

/**
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` 한 항목의 값.
 *
 * ★ 그 변수는 **목록**이고 구분자가 플랫폼마다 다르다(Windows `;` · POSIX `:`). 경로에 구분자가
 *   들어 있으면 한 항목이 둘로 쪼개져 둘 다 없는 디렉터리가 된다 — 그러면 3-way 가 baseline
 *   객체를 못 찾아 「안 붙는다」로 오진한다. git 의 리더는 값이 `"` 로 시작하면 구분자 검색
 *   대신 C 인용을 벗기므로(`parse_alt_odb_entry`), 항상 인용해서 주면 경로에 무엇이 들어 있든
 *   한 항목으로 읽힌다. 실측: Windows 절대 경로(`C:\…`)가 이 모양으로 그대로 읽힌다.
 *
 * ★ 정규식 리터럴 대신 `replaceAll` 인 것은 취향이 아니다. `test/guards/_scan.mjs` 의
 *   토크나이저는 템플릿의 `${…}` 안에서 **정규식 리터럴을 안 읽는다**(:72-88 의 안쪽 루프는
 *   중괄호와 따옴표만 센다). 그래서 `.replace(/"/g, …)` 로 쓰면 그 안의 `"` 를 문자열 시작으로
 *   읽고 템플릿의 끝을 놓쳐, 아래 한국어 주석이 「런타임 문자열 리터럴」로 잡혀 불변식 8
 *   가드가 붉어진다(실측). 문자열 인자로 쓰면 그 토크나이저가 제대로 읽는다.
 */
const quotedAlternate = (path) => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * 쓰기 전 snapshot 과 수동 복구 manifest 가 공유하는 경로 규율.
 *
 * ★ git 자신의 검사 단계는 만들 경로를 디렉터리가 차지한 모양을 못 본다(실측: `--check` 0,
 *   실제 apply 128). 그래서 patch path 자체뿐 아니라 `repoPath` 아래의 descendant ancestor 를
 *   `lstat` 로 하나씩 본다. symlink·junction·일반 파일인 ancestor 는 git 을 시작하기 전에 막는다.
 * ★ `repoPath` 자신은 보지 않는다. 호출자가 링크를 통해 연 저장소는 허용하되, 그 아래에서 새로
 *   경계를 넘는 모양만 거절한다는 것이 이 단위의 경계다.
 * ★ 미추적 일반 파일은 막지 않는다. 직접 갈래는 git 검사가 거절하고, 3-way 는 쓰기 없이 끝난다.
 * ★ 담김은 `contained` 로 재고, manifest 는 patch path 의 kind·backup 이름·mode·size·digest 와
 *   descendant directory 의 path·kind·mode 를 저장한다. 저장소 경로는 failure handler 가 안 쓴다.
 */
const modeOf = (stats) => stats.mode & 0o777;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestPathOf = (repoPath, path) => relative(repoPath, path).split(sep).join('/');

async function inspected(path) {
  try {
    return { kind: 'present', stats: await lstat(path) };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { kind: 'absent', stats: null }
      : { kind: 'error', stats: null };
  }
}

function ancestorPaths(repoPath, full) {
  const out = [];
  let current = dirname(full);
  while (contained(repoPath, current)) {
    out.push(current);
    current = dirname(current);
  }
  return out.reverse();
}

async function inspectAncestors(repoPath, full) {
  const entries = [];
  for (const path of ancestorPaths(repoPath, full)) {
    const got = await inspected(path);
    if (got.kind === 'error' || (got.kind === 'present' && !got.stats.isDirectory())) {
      return { safe: false, entries };
    }
    entries.push({
      path: manifestPathOf(repoPath, path),
      kind: got.kind === 'present' ? 'directory' : 'absent',
      mode: got.kind === 'present' ? modeOf(got.stats) : null,
      dev: got.kind === 'present' ? got.stats.dev : null,
      ino: got.kind === 'present' ? got.stats.ino : null,
      birthtimeMs: got.kind === 'present' ? got.stats.birthtimeMs : null,
    });
  }
  return { safe: true, entries };
}

export function sameAncestorChain(before, after) {
  return before.safe && after.safe && before.entries.length === after.entries.length &&
    before.entries.every((entry, index) => {
      const current = after.entries[index];
      return current.path === entry.path && current.kind === entry.kind &&
        (entry.kind === 'absent' || (current.dev === entry.dev && current.ino === entry.ino &&
          Object.is(current.birthtimeMs, entry.birthtimeMs)));
    });
}

export function sameFileIdentity(before, after) {
  return before.isFile() && after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    Object.is(before.birthtimeMs, after.birthtimeMs);
}

/** 패치 경로의 kind·bytes·mode 와 descendant directory 정보를 manifest 로 완성한다. */
async function backupWorkingTree(repoPath, scratch, patchPaths, writeBackupManifest) {
  const base = join(scratch, 'backup');
  if (!(await mkdir(base, { recursive: true }).then(() => true, () => false))) {
    return { ok: false, detail: 'the working-tree backup directory could not be created' };
  }

  const entries = [];
  const directories = new Map();
  for (const path of patchPaths) {
    const full = join(repoPath, path);
    if (!contained(repoPath, full)) return { ok: false, occupied: true };
    const ancestors = await inspectAncestors(repoPath, full);
    if (!ancestors.safe) return { ok: false, occupied: true };
    for (const entry of ancestors.entries) directories.set(entry.path, entry);

    const first = await inspected(full);
    if (first.kind === 'error') return { ok: false, detail: `the working-tree path ${path} could not be inspected` };
    if (first.kind === 'absent') {
      entries.push({ path, full, kind: 'absent', saved: null, backup: null, mode: null, size: null, sha256: null });
      continue;
    }
    if (!first.stats.isFile()) return { ok: false, occupied: true };
    const bytes = await readFile(full).catch(() => null);
    const second = await lstat(full).catch(() => null);
    const afterAncestors = await inspectAncestors(repoPath, full);
    if (bytes === null || second === null || !sameFileIdentity(first.stats, second) ||
        !sameAncestorChain(ancestors, afterAncestors) || modeOf(first.stats) !== modeOf(second)) {
      return { ok: false, detail: `the working-tree path ${path} changed while it was being backed up` };
    }
    const backup = String(entries.length);
    const saved = join(base, backup);
    if (!(await writeFile(saved, bytes, { flag: 'wx', mode: 0o600 }).then(() => true, () => false))) {
      return { ok: false, detail: `the working-tree path ${path} could not be copied into the backup` };
    }
    entries.push({
      path, full, kind: 'file', saved, backup,
      mode: modeOf(first.stats), size: bytes.length, sha256: digest(bytes),
    });
  }

  const manifest = {
    version: 1,
    paths: entries.map(({ path, kind, backup, mode, size, sha256 }) => ({
      path, kind, backup, mode, size, sha256,
    })),
    directories: [...directories.values()].map(({ path, kind, mode }) => ({ path, kind, mode })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = join(base, 'manifest.json');
  if (!(await writeBackupManifest(manifestPath, manifestBytes).then(() => true, () => false))) {
    return { ok: false, detail: 'the working-tree backup manifest could not be written' };
  }
  return { ok: true, entries, base };
}

/** 저장소 경로를 쓰지 않고 pre-write snapshot 과 kind·bytes·mode 를 비교한다. */
async function compareWorkingTree(repoPath, entries) {
  const changed = [];
  for (const entry of entries) {
    const ancestors = await inspectAncestors(repoPath, entry.full);
    if (!ancestors.safe) { changed.push(entry.path); continue; }
    const first = await inspected(entry.full);
    if (entry.kind === 'absent') {
      const afterAncestors = await inspectAncestors(repoPath, entry.full);
      if (first.kind !== 'absent' || !sameAncestorChain(ancestors, afterAncestors)) changed.push(entry.path);
      continue;
    }
    if (first.kind !== 'present' || !first.stats.isFile()) { changed.push(entry.path); continue; }
    const saved = await readFile(entry.saved).catch(() => null);
    const current = await readFile(entry.full).catch(() => null);
    const second = await lstat(entry.full).catch(() => null);
    const afterAncestors = await inspectAncestors(repoPath, entry.full);
    if (saved === null || current === null || second === null ||
        !sameFileIdentity(first.stats, second) || !sameAncestorChain(ancestors, afterAncestors) ||
        modeOf(second) !== entry.mode || !current.equals(saved)) changed.push(entry.path);
  }
  return [...new Set(changed)];
}

/**
 * 이름 목록 하나를 **정직하게** 자른다 — 버린 것이 있으면 그 수를 말한다.
 *
 * ★★ 옛 문장은 열 개에서 **조용히** 끊겼다(재리뷰2). 사용자가 잃은 파일 열여섯을 적어야 하는
 *   자리에서 열 개만 적고 여섯이 빠졌다는 말은 어디에도 없었고, 목록은 끝난 것처럼 보였다.
 *   이 저장소의 다른 상한은 전부 버린 수를 함께 낸다(`omittedCounts`) — 데이터 손실을 알리는
 *   문장만 그 규율 밖에 있었다.
 */
const namedList = (names) => (names.length <= MAX_DIRTY_SAMPLE
  ? names.join(', ')
  : `${names.slice(0, MAX_DIRTY_SAMPLE).join(', ')} and ${names.length - MAX_DIRTY_SAMPLE} more`);

/**
 * 쓰기 뒤 final porcelain 에 **다르게 남은 것**을 이름으로 적는다. 「무언가 달라졌다」만 말하는 문장은
 * 회복이 못 된다 — 사용자가 제일 먼저 볼 자리를 주는 것이 이 코드가 하는 유일한 일이다.
 *
 * ★★ 코드는 **git 자신의 두 글자**를 그대로 쓰고, 그것이 git 의 것임을 문장이 말한다(재리뷰2).
 *   예전에는 `staged`/`unstaged` 두 불리언에서 `SU`·`S-` 를 지어내 진짜 `??` 옆에 늘어놓았다.
 *   결함이 둘이었다: (1) 사용자는 회복 문구를 따라 `git status` 를 열고 `SU` 를 찾다 못 찾고,
 *   (2) 그 접힘이 **손실**이라 `" M"` 과 `" D"` 가 같은 값이 되어 — 실측 — 패치가 이름 안
 *   부르는 파일이 수정에서 삭제로 바뀐 자리에서 대조가 **아무 경로도 못 냈다**.
 */
function stillChanged(statusBefore, after) {
  if (after?.ok !== true) return 'git could not report what the repository looks like after the write';
  // 키는 **두 글자 + 경로**다. 두 글자는 길이가 고정이라 경로에 공백이 있어도 다시 가를 때
  // 애매해지지 않는다(`src/keep me.txt` 가 실제 픽스처다).
  const shape = (text) => {
    const state = parseStatusPorcelain(text);
    return new Set([
      ...state.tracked.map((one) => `${one.state}${one.path}`),
      ...state.untracked.map((path) => `??${path}`),
    ]);
  };
  const before = shape(statusBefore);
  const now = shape(after.stdout);
  const moved = [...now].filter((row) => !before.has(row)).concat([...before].filter((row) => !now.has(row)));
  if (moved.length === 0) return 'git status no longer matches what it was before the apply';
  const rows = moved.map((row) => `${row.slice(2)} (git status code "${row.slice(0, 2)}")`);
  return `${rows.length} paths differ from what git status reported before the apply: ${namedList(rows)}`;
}

/**
 * 실제 write 뒤의 세 답: patch path 가 다르거나 unsafe 면 backup 을 남기고 incomplete,
 * path 는 같지만 porcelain 이 다르거나 못 읽으면 verification_failed, 둘 다 같으면 갈래 코드다.
 * 이 함수는 저장소 경로를 쓰지 않는다. porcelain 은 인덱스 바이트나 객체 DB 를 증명하지 않는다.
 */
async function classifyFailedWrite(git, options) {
  const { repoPath, scratch, backup, statusBefore, unchangedCode } = options;
  const changed = await compareWorkingTree(repoPath, backup);
  const after = await git(['--no-optional-locks', 'status', '--porcelain', '-z']);
  if (changed.length > 0) {
    return {
      keepBackup: true,
      blocked: fail(REASON.apply_rollback_incomplete, {
        path: repoPath,
        count: changed.length,
        backup: join(scratch, 'backup'),
        // 수가 **맨 앞**이다: `{detail}` 은 200자에서 잘리므로, 뒤에 두면 잃은 개수가 먼저 사라진다.
        detail: `${changed.length} paths differ from or could not be safely compared with the pre-write snapshot: ${namedList(changed)}`,
      }),
    };
  }
  if (after?.ok === true && after.stdout === statusBefore) {
    return { keepBackup: false, blocked: fail(unchangedCode, { path: repoPath }) };
  }
  return {
    keepBackup: false,
    blocked: fail(REASON.apply_verification_failed, { path: repoPath, detail: stillChanged(statusBefore, after) }),
  };
}

/** 성공을 보고한 write 뒤의 확인 실패도 snapshot과 대조하고, 현재 적용 결과는 절대 되돌리지 않는다. */
async function classifyCompletedWrite(options) {
  const { repoPath, scratch, backup, unchangedFailure } = options;
  const changed = await compareWorkingTree(repoPath, backup);
  if (changed.length === 0) return { keepBackup: false, blocked: unchangedFailure };
  return {
    keepBackup: true,
    blocked: fail(REASON.apply_rollback_incomplete, {
      path: repoPath,
      count: changed.length,
      backup: join(scratch, 'backup'),
      detail: `${changed.length} paths differ from or could not be safely compared with the pre-write snapshot: ${namedList(changed)}`,
    }),
  };
}

/** path-safety 검사와 완성된 manifest 뒤에만 실제 git write 를 시작한다. */
async function writeWithSnapshot(git, options) {
  const {
    repoPath, scratch, scratchRoom, patchPaths, args, input, statusBefore, unchangedCode, writeBackupManifest, expectedHead,
  } = options;
  const snapshot = await backupWorkingTree(repoPath, scratch, patchPaths, writeBackupManifest);
  if (snapshot.occupied === true) return { blocked: fail(REASON.apply_write_blocked, { path: repoPath }) };
  if (snapshot.ok !== true) return { blocked: fail(REASON.apply_git_failed, { detail: snapshot.detail }) };
  // scope.allow는 inspectBeforeWrite가 본 HEAD의 권위다. 백업 동안 HEAD가 움직이면 그 정책과
  // 적용 가능성 판정이 모두 낡았으므로, 실제 write에 가장 가까운 Git 경계에서 다시 확인한다.
  // 이 subprocess와 다음 subprocess 사이의 외부 경쟁까지 잠그는 portable ref lock은 없다.
  const currentHead = await git(['rev-parse', '--verify', 'HEAD']);
  if (currentHead?.ok !== true) return { blocked: gitFail(currentHead) };
  if (currentHead.stdout.trim() !== expectedHead) {
    return { blocked: fail(REASON.apply_head_moved, { path: repoPath }) };
  }
  // ★★ 이 전환은 사용자 저장소를 쓰는 subprocess보다 앞에서 fsync된다. 여기서 프로세스가
  //   죽으면 disposable로 치워도 되지만, 다음 줄 뒤에는 backup이 유일한 복구본일 수 있다.
  const armed = await armScratchRoom(scratchRoom);
  if (!armed.ok) {
    return { blocked: fail(REASON.apply_git_failed, { detail: 'the recovery record could not be armed before the repository write' }) };
  }
  const applied = await git(args, undefined, input);
  if (applied?.ok === true) return { applied, backup: snapshot.entries };
  return await classifyFailedWrite(git, { repoPath, scratch, backup: snapshot.entries, statusBefore, unchangedCode });
}

/**
 * 사후 확인용 **인덱스 사본** 하나(재리뷰 C2).
 *
 * ★ 왜 사본인가: `write-tree` 는 자기가 읽은 인덱스의 cache-tree 를 결과 트리 id 로 도장 찍는다.
 *   객체는 임시 저장소로 보내면서 인덱스만 진짜를 읽으면, `finally` 가 임시 저장소를 지우는
 *   순간 사용자 인덱스에 **없는 트리를 가리키는 포인터**가 남는다(실측: `git fsck` exit 8 ·
 *   `git gc` exit 128). 사본에서 도장을 받으면 사용자 인덱스는 한 바이트도 안 바뀌고 확인은
 *   같은 답을 낸다(실측: 사본의 `write-tree` id == 진짜 인덱스의 `write-tree` id).
 * ★ `--git-path` 는 cwd 기준 **상대** 경로를 낼 수 있다(실측: `.git/index`) — 객체 디렉터리와
 *   같은 이유로 절대화한다.
 */
async function copyRealIndex(git, scratch, repoPath) {
  const named = await git(['rev-parse', '--git-path', 'index']);
  if (named?.ok !== true) return null;
  const real = named.stdout.trim();
  if (real === '') return null;
  const target = join(scratch, 'index-copy');
  return copyFile(isAbsolute(real) ? real : join(repoPath, real), target).then(() => target, () => null);
}

/**
 * 패치를 저장소에 넣는다 — 또는 무엇을 했을 것인지만 말한다.
 *
 * 관문 순서는 고정이고, 각 단이 **자기 코드**로 거절한다:
 *
 *   1. 빈 패치            → `apply_patch_empty`      (git 은 빈 입력을 exit 128 로 거부한다)
 *   2. HEAD·상태 읽기      → `apply_git_failed`
 *   3. `--numstat` 과 `-R --numstat` 로 **패치가 이름 부르는 경로 전수** 확정 → `apply_git_failed`
 *   4. 직접 `--check`     통과하면 **path-safety → manifest → 적용 → read-only 분류**,
 *                         그리고 **역방향 `--check`** 로 확인한다 — 그것이 아니라고 해도
 *                         같은 read-only 분류로 간다
 *   5. (직접이 안 될 때) patch preimage 로 fake ancestor 를 지을 수 있나 → `apply_baseline_pruned`
 *   6. 추적 파일이 더러운가                    → `apply_worktree_dirty`
 *   7. D4 임시 인덱스 판정: `ls-files -u` 가 비었나
 *        안 비었다 → `apply_three_way_conflicted`  ·  `--3way --cached` 가 실패 → `apply_baseline_moved`
 *   8. 실제 `--3way`(같은 snapshot 규율) 뒤 **예상 트리** 대조 → 어긋나면 `apply_verification_failed`
 *
 * ★ 쓰기를 시작한 뒤의 코드는 `classifyFailedWrite` 하나가 정한다. 저장소 경로는 쓰지 않고
 *   pre-write snapshot 과 final no-optional-locks porcelain 을 읽어서 다음 셋으로 끝낸다:
 *     · patch path kind·bytes·mode 와 porcelain 이 같다 → 갈래별 unchanged code
 *     · patch path 는 같은데 porcelain 이 다르거나 못 읽는다 → `apply_verification_failed`
 *     · patch path 하나라도 다르거나 안전하게 못 읽는다 → `apply_rollback_incomplete` + mapped backup
 *   pre-write path-safety 거절만은 갈래와 무관하게 `apply_write_blocked` 다.
 *
 * ★ 3 이 4 보다 앞으로 온 것은 재리뷰 C1 이 옮긴 자리다. `-R --numstat` 은 원래 3-way 갈래
 *   안에만 있었지만(흔한 직접 적용이 그 값을 안 치르게), 백업이 **이름 바뀜의 옛 경로**까지
 *   떠야 하므로 직접 갈래도 그 전수를 필요로 한다. git 호출 하나가 늘고, 그 값으로 사는 것은
 *   「옮겨진 파일의 미커밋 작업」이다.
 *
 * ★ 4 가 5·6 보다 **앞**인 것이 이 함수의 판단 하나다. 시작 때 미커밋 작업을 이식한 실행의
 *   baseline 은 그 작업을 담은 합성 커밋이고, 그래서 적용 시점의 사용자 저장소는 보통
 *   더럽다 — 그 상태에서 직접 `--check` 는 **작업 트리 파일**을 보고 정직하게 답한다(실측).
 *   더러움을 먼저 막으면 가장 흔한 정상 경로가 막히고, 그때 주는 회복("stash 하라")은 baseline 이
 *   담은 그 작업을 치워 버려 막다른 길이 된다. 더러움은 **3-way 를 못 하게** 할 뿐이다.
 *
 * ★★ 그 판단이 안전한 **진짜** 이유를 적는다 — 이 자리는 두 번 반증됐다(태스크 8 리뷰 I4 ·
 *   재리뷰 C1). 처음 적은 「`git apply` 는 all-or-nothing 이라 실패해도 트리를 안 건드린다」는
 *   거짓이었고, 그 다음 적은 「안전한 이유는 **둘**이다」도 거짓이었다. 실측 셋
 *   (git 2.55.0.windows.3, 셋 다 `test/apply-patch.test.mjs` 가 픽스처로 재현한다):
 *
 *     (i)  패치가 만들 경로를 **디렉터리**가 차지하면
 *            git apply --check → exit 0     (검사 단계는 lstat 로 파일 존재만 본다)
 *            git apply         → exit 128   ("unable to write file … Is a directory")
 *     (ii) git 의 `write_out_results` 는 **지우기 단계(phase 0)를 패치 전체에 대해 먼저** 돌고
 *          그 다음 **만들기 단계(phase 1)**를 돈다. 그래서 (i) 이 죽는 자리가 패치 앞쪽이면
 *          **수정만 하는 추적 파일이 전부 지워진 채** 남는다 — 실측: 만들 경로가 사전순 맨
 *          앞이면 수정 대상 4/4 가 사라졌고(그 파일들의 미커밋 작업은 어느 객체에도 없다),
 *          맨 뒤면 4/4 가 남았다. **순서 하나가 뒤집는다.**
 *     (iii) `git status` 는 **바이트를 안 본다**. (ii) 의 「맨 뒤」 순서에서 파일 넷은 남지만
 *          내용은 이미 패치가 적용된 것으로 바뀌어 있고 porcelain 은 앞뒤로 똑같이 " M" 이다 —
 *          「porcelain 이 같으니 아무 일도 없었다」는 그래서 거짓이다.
 *
 *   즉 **검사 단계**는 all-or-nothing 이지만 **쓰기 단계**는 아니고, porcelain 만으로는 사용자
 *   바이트를 지킬 수 없다. 더러운 트리에 직접 적용을 허용해도 되는 이유는 이제 셋이고 **셋 다
 *   코드**다(산문이 아니다):
 *
 *     (a) `--check` 는 작업 트리 파일을 읽고, `backupWorkingTree` 는 descendant path-safety 를
 *         검사한 뒤 patch path 전부를 mapped manifest 에 남기므로 (i) 을 쓰기 전에 막는다.
 *     (b) 그래도 쓰기가 죽으면 `classifyFailedWrite` 는 **저장소를 더 쓰지 않고** 현재 트리와
 *         snapshot 을 비교한다. 다르면 현재 바이트와 mapped backup 을 둘 다 보존한다.
 *     (c) 성공한 적용은 **역방향 `--check`** 가 다시 본다 — 실측에 `git apply` 가 **exit 0 으로
 *         성공을 말하면서** 파일을 안 만드는 모양이 있고(리뷰 I4 의 S9 픽스처: 일반 파일이
 *         만들 경로의 **부모 자리**를 차지, Windows), 앞의 두 관문은 그 모양을 못 잡는다.
 *
 *   셋 중 무엇도 방어적 사족이 아니다. **지우지 마라** — 셋 다 자기 픽스처를 갖고 있고, 하나씩
 *   무력화하는 변이가 정확히 자기 테스트만 붉게 한다.
 * ★ 5 가 6 보다 앞인 것도 판단이다: 사라진 patch preimage 는 아무도 되살릴 수 없고 더러운
 *   트리는 커밋 한 번이면 풀린다 — 더 근본적인 막힘을 먼저 말한다.
 *
 * @returns 성공이면 `{ok:true, applied, mode, …}`, 실패면 `{blocked:true, reasonCode, params}`.
 */
export async function applyPatchToRepository(spec, deps = {}) {
  const run = typeof deps?.run === 'function' ? deps.run : runGit;
  const inspectBeforeWrite = typeof deps?.inspectBeforeWrite === 'function' ? deps.inspectBeforeWrite : null;
  const writeBackupManifest = typeof deps?.writeBackupManifest === 'function'
    ? deps.writeBackupManifest
    : (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const options = spec ?? {};
  const repoPath = options.repoPath;
  const patchBytes = options.patchBytes;
  const baseline = options.baseline ?? null;
  const scratchRoot = options.scratchRoot;
  const checkOnly = options.checkOnly === true;
  // 매니페스트가 기록한 object id는 그 객체 자체를 뜻한다. 대상 저장소의 refs/replace를
  // 따르면 candidate tree·baseline·HEAD가 바뀐다. promisor의 lazy fetch는 쓰기 전 판정만으로
  // 사용자 object DB와 네트워크를 움직인다. 모든 Git 호출에 같은 두 강제값을 얹는다.
  const runWithObjectIsolation = (request) => run({
    ...request,
    env: {
      ...(request?.env ?? {}),
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
  });
  const git = (args, env, input) => runWithObjectIsolation({
    args, cwd: repoPath, ...(env === undefined ? {} : { env }), ...(input === undefined ? {} : { input }),
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });

  if (!Buffer.isBuffer(patchBytes)) return fail(REASON.apply_git_failed, { detail: 'the patch bytes were never read' });
  if (patchBytes.length === 0) return fail(REASON.apply_patch_empty, { path: repoPath });
  // 호출자가 가진 Buffer도 뒤에서 바꿀 수 있다. 첫 await 전에 사본을 하나 만들고 이 지역 참조를
  // 밖으로 내보내지 않아, 아래 모든 Git 파서·검사·쓰기·확인이 같은 인증 바이트만 읽게 한다.
  const authenticatedPatch = Buffer.from(patchBytes);
  const applyGit = (args, env) => git(args, env, authenticatedPatch);

  const head = await git(['rev-parse', '--verify', 'HEAD']);
  if (head?.ok !== true) return gitFail(head);
  const before = await git(['--no-optional-locks', 'status', '--porcelain', '-z']);
  if (before?.ok !== true) return gitFail(before);
  const state = parseStatusPorcelain(before.stdout);
  const baselineAvailable = await baselineIsPresent(runWithObjectIsolation, repoPath, baseline);

  const numstat = await applyGit(['apply', '--numstat', '-z', '--whitespace=nowarn']);
  if (numstat?.ok !== true) return gitFail(numstat);
  const listing = parseNumstat(numstat.stdout);
  // ★ 관문과 백업이 보는 경로 집합은 **완전해야** 한다 — 불완전하면 「막지 않는다」가 아니라
  //   **오진**(태스크 8 리뷰 I2)이고, snapshot 쪽에서는 **수동 복구 근거가 없는 파일**이 된다.
  //   새는 자리가 둘이었고 둘 다 여기서 막는다.
  //   (1) 이름 바뀜: `--numstat -z` 는 **목적지만** 낸다(실측: `rename from src/moved.txt` 인
  //       패치가 `0\t0\tsrc/arrived.txt` 한 줄만 낸다). 옛 경로를 얻는 값싼 리더는 **같은
  //       명령을 거꾸로** 태우는 것이다 — `-R` 은 git 자신의 패치 파서로 앞뒤를 맞바꾸므로
  //       인용 규칙도 `-z` 그대로이고 우리가 패치 산문을 파싱할 일이 없다(실측: 이름 바뀜·
  //       복사의 원본이 전부 나온다). 만들기·지우기는 양쪽이 같은 이름을 내므로 합집합이
  //       그대로 답이다.
  //   (2) 200 파일 절단: `paths` 는 안 자른 전수다(`MAX_FILES` 의 ★).
  const backwards = await applyGit(['apply', '-R', '--numstat', '-z', '--whitespace=nowarn']);
  if (backwards?.ok !== true) return gitFail(backwards);
  const patchPaths = new Set([...listing.paths, ...parseNumstat(backwards.stdout).paths]);

  const report = (extra) => ({
    ok: true,
    checkOnly,
    head: head.stdout.trim(),
    baselineAvailable,
    dirtyBefore: state.tracked.length > 0 || state.untracked.length > 0,
    dirtyTrackedBefore: state.tracked.slice(0, MAX_DIRTY_SAMPLE).map((one) => one.path),
    dirtyTrackedCount: state.tracked.length,
    untrackedCount: state.untracked.length,
    files: listing.files,
    filesOmitted: listing.omitted,
    expectedTree: null,
    ...extra,
  });

  let scratch = null;
  let scratchRoom = null;
  // ★★ patch path 하나라도 달라졌거나 안전하게 못 읽은 자리에서는 **mapped backup 을 남긴다**.
  //   `finally` 가 조건 없이 지우면 수동 복구에 필요한 pre-write 사본을 스스로 파괴한다.
  let keepBackup = false;
  // 상태 루트 안의 일회용 자리 하나 — 백업(직접·3-way)과 임시 인덱스·임시 객체 저장소(3-way)가
  // 같은 디렉터리를 쓰고 `finally` 가 통째로 지운다. `checkOnly` 면 아예 안 열린다.
  const openWorkspace = async () => {
    if (scratch !== null) return scratch;
    if (typeof scratchRoot !== 'string' || scratchRoot === '') return null;
    const opened = await createScratchRoom({
      stateRoot: scratchRoot,
      kind: 'repository_apply',
      projectPath: repoPath,
    }).catch(() => null);
    if (opened?.ok !== true) return null;
    scratchRoom = opened.handle;
    scratch = opened.handle.path;
    return scratch;
  };

  /**
   * 선택된 갈래가 실제로 붙는다는 판정 뒤, 사용자 저장소 write **직전**의 확장 관문.
   * `orch_apply` 의 scope 재검사는 후보 트리를 임시 index 로 읽어야 하므로 scratch 와 같은 Git
   * runner 를 받는다. 훅이 없으면 태스크 8의 순수 적용기 계약은 그대로다.
   */
  const inspectAtBoundary = async (mode, room = null) => {
    if (inspectBeforeWrite === null) return { ok: true, scope: null };
    const workspace = room ?? await openWorkspace();
    if (workspace === null) return fail(REASON.apply_git_failed, { detail: 'no state root was given for the pre-write inspection' });
    try {
      const inspected = await inspectBeforeWrite({
        repoPath,
        scratch: workspace,
        patchPaths: [...patchPaths].sort(),
        head: head.stdout.trim(),
        mode,
        git,
      });
      if (inspected?.blocked === true) return { ...inspected, mode, head: head.stdout.trim() };
      if (inspected?.ok !== true) return fail(REASON.scope_inspection_failed);
      return { ok: true, scope: inspected.scope ?? inspected };
    } catch {
      return fail(REASON.scope_inspection_failed);
    }
  };

  try {
    // ── 직접 갈래 ──────────────────────────────────────────────────────────────
    const directCheck = await applyGit(['apply', '--check', '--whitespace=nowarn']);
    if (gitDidNotComplete(directCheck)) return gitFail(directCheck);
    if (directCheck.ok === true) {
      const inspected = await inspectAtBoundary('direct');
      if (inspected.blocked === true) return inspected;
      if (checkOnly) {
        return report({ applied: false, mode: 'direct', staged: false, verifiedBy: null, scope: inspected.scope });
      }
      const room = await openWorkspace();
      if (room === null) return fail(REASON.apply_git_failed, { detail: 'no state root was given for the pre-write snapshot' });
      const wrote = await writeWithSnapshot(git, {
        repoPath, scratch: room, scratchRoom, patchPaths, statusBefore: before.stdout,
        args: ['apply', '--whitespace=nowarn'], input: authenticatedPatch,
        unchangedCode: REASON.apply_write_blocked,
        writeBackupManifest,
        expectedHead: head.stdout.trim(),
      });
      if (wrote.blocked !== undefined) { keepBackup = wrote.keepBackup === true; return wrote.blocked; }
      // 확인은 **역방향 `--check`** 다(WS0 §1.4 의 두 길 중 하나): 패치를 거꾸로 대 봐서 붙으면
      // 그 변경이 지금 파일 안에 있다는 뜻이다. `core.autocrlf=true` 로 CRLF 작업본에 LF 패치를
      // 넣은 뒤에도 통과한다(실측) — git 이 양쪽에서 같은 개행 정책을 쓰기 때문이다.
      const reverse = await applyGit(['apply', '--reverse', '--check', '--whitespace=nowarn']);
      if (reverse.ok !== true) {
        // ★★ 여기서도 저장소를 더 쓰지 않는다. 「git 이 0 을 냈는데 파일 안의 것이 패치가 말한
        //   것이 아니다」라는 현재 상태와 pre-write backup 을 함께 남겨야 수동 복구가 가능하다.
        //   patch path 와 porcelain 이 우연히 그대로일 때만 direct 갈래의 unchanged code 를 낸다.
        const classified = await classifyFailedWrite(git, {
          repoPath, scratch: room, backup: wrote.backup, statusBefore: before.stdout,
          unchangedCode: REASON.apply_write_blocked,
        });
        keepBackup = classified.keepBackup === true;
        return classified.blocked;
      }
      return report({ applied: true, mode: 'direct', staged: false, verifiedBy: 'reverse_check', scope: inspected.scope });
    }

    // ── 3-way 갈래 ────────────────────────────────────────────────────────────
    const room = await openWorkspace();
    if (room === null) return fail(REASON.apply_git_failed, { detail: 'no state root was given for the temporary index' });

    // 판정이 쓰는 객체는 **전부 여기로** 간다. 사용자 객체 DB 는 alternate 로 읽기만 한다.
    const objectDir = join(room, 'objects');
    const made = await mkdir(objectDir, { recursive: true }).then(() => true, () => false);
    if (!made) return fail(REASON.apply_git_failed, { detail: 'the temporary object store could not be created' });
    // `--git-path` 는 cwd 기준 **상대** 경로를 낼 수 있다(실측: `.git/objects`). 저장소가 별도
    // git 디렉터리를 쓰거나 워크트리여도 이 한 물음이 진짜 객체 DB 를 가리킨다.
    const named = await git(['rev-parse', '--git-path', 'objects']);
    if (named.ok !== true) return gitFail(named);
    const userObjects = named.stdout.trim();
    if (userObjects === '') return fail(REASON.apply_git_failed, { detail: 'git named no object directory for this repository' });
    // ★ 사용자 객체 DB 가 자기 `info/alternates` 를 갖고 있어도(`clone --shared`) git 이 그것을
    //   **재귀로** 따라가므로 읽을 수 있는 객체 집합은 줄지 않는다(실측).
    const scoped = {
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedAlternate(isAbsolute(userObjects) ? userObjects : join(repoPath, userObjects)),
    };

    // mode-only patch 는 `index <blob>` 을 싣지 않아 fake-ancestor 가 입력 index 를 읽는다. 현재
    // HEAD index 를 주면 baseline 에는 있던 경로가 지금 지워진 경우를 "pruned" 로 오진하므로,
    // manifest tree 가 아직 풀릴 때만 scratch index 를 그 tree 로 채운다. tree 자체가 사라졌다면
    // hashed preimage 로는 계속할 수 있어야 하므로 seed 실패를 곧바로 관문으로 쓰지는 않는다.
    let ancestorEnv = scoped;
    if (isFullObjectId(baseline?.tree)) {
      const baselineIndex = join(room, 'baseline-index');
      const seeded = await git(['read-tree', baseline.tree], { ...scoped, GIT_INDEX_FILE: baselineIndex });
      if (gitDidNotComplete(seeded)) return gitFail(seeded);
      if (seeded.ok === true) ancestorEnv = { ...scoped, GIT_INDEX_FILE: baselineIndex };
      else {
        const writable = await git(['read-tree', '--empty'], { ...scoped, GIT_INDEX_FILE: baselineIndex });
        if (writable?.ok !== true) return gitFail(writable);
      }
    }

    // manifest identity 존재 자체는 관문이 아니다. tree 는 mode-only 입력을 채울 때만 쓰고,
    // Git 자신의 fake-ancestor 빌더가 실제 preimage material 로 인덱스를 지어야 최종 통과다.
    const fakeAncestor = join(room, 'fake-ancestor');
    const ancestor = await applyGit([
      'apply', `--build-fake-ancestor=${fakeAncestor}`, '--whitespace=nowarn',
    ], ancestorEnv);
    if (gitDidNotComplete(ancestor)) return gitFail(ancestor);
    if (ancestor.ok !== true) {
      // exit code·stderr 는 preimage 부재와 index 쓰기 실패를 가르지 못한다(둘 다 128일 수 있다).
      // 같은 경로에 빈 index 를 쓰는 구조적 대조가 실패하면 patch 문제가 아니라 준비 실패다.
      const writable = await git(['read-tree', '--empty'], { ...scoped, GIT_INDEX_FILE: fakeAncestor });
      if (writable?.ok !== true) return gitFail(writable);
      return fail(REASON.apply_baseline_pruned, { path: repoPath });
    }

    // 어떤 더러움이 3-way 를 막는가 — 둘이고, 이유가 서로 다르다.
    //   (a) **패치가 이름 부르는 경로**가 인덱스와 다르다 → git 자신이 거절한다(실측
    //       "does not match index"). 우리 코드는 그 거절을 먼저, 고칠 수 있는 문장으로 말한다.
    //   (b) **무엇이든 스테이징돼 있다** → 아래 사후 확인의 근거가 무너진다. 예상 트리는
    //       `HEAD` 로 채운 임시 인덱스에서 나오는데, 진짜 인덱스가 `HEAD` 와 다르면 두 트리는
    //       적용이 완벽해도 어긋난다. raw git 은 성공할 수 있어도 이 도구는 검증할 수 없다.
    // 그 밖의 더러움(패치가 안 건드리는 파일의 미스테이징 수정·미추적 파일)은 막지 않는다.
    const blocking = state.tracked.filter((one) => one.staged || patchPaths.has(one.path));
    if (blocking.length > 0) return fail(REASON.apply_worktree_dirty, { count: blocking.length, path: repoPath });

    const env = { ...scoped, GIT_INDEX_FILE: join(room, 'index') };

    // 트리가 깨끗하다는 것은 위 관문이 이미 증명했다 — 그래서 `HEAD` 로 채운 임시 인덱스는
    // 진짜 인덱스와 **같은 것**이고, 여기서 나오는 판정이 실제 적용에 그대로 적용된다.
    const readTree = await git(['read-tree', 'HEAD'], env);
    if (readTree.ok !== true) return gitFail(readTree);

    const probe = await applyGit(['apply', '--3way', '--cached', '--whitespace=nowarn'], env);
    if (gitDidNotComplete(probe)) return gitFail(probe);
    const unmerged = await git(['ls-files', '-u'], env);
    if (unmerged.ok !== true) return gitFail(unmerged);
    // ★★ 판정은 여기 한 줄이다. `probe.stderr`(“…with conflicts.”)도 `probe.exitCode` 도 안 본다.
    if (unmerged.stdout !== '') return fail(REASON.apply_three_way_conflicted, { path: repoPath });
    if (probe.ok !== true) return fail(REASON.apply_baseline_moved, { path: repoPath });

    const written = await git(['write-tree'], env);
    const expectedTree = written.ok === true ? written.stdout.trim() : '';
    if (!isFullObjectId(expectedTree)) return gitFail(written);
    const inspected = await inspectAtBoundary('three_way', room);
    if (inspected.blocked === true) return inspected;
    if (checkOnly) {
      return report({
        applied: false, mode: 'three_way', staged: false, verifiedBy: null, expectedTree, scope: inspected.scope,
      });
    }

    // git 의 `--3way` 는 `--cached` 없이 쓰면 `--index` 를 함의한다 — 즉 이 갈래는 사용자
    // 인덱스에 **스테이징까지** 한다. 그것을 숨기지 않고 `staged` 로 보고한다.
    const wrote = await writeWithSnapshot(git, {
      repoPath, scratch: room, scratchRoom, patchPaths, statusBefore: before.stdout,
      args: ['apply', '--3way', '--whitespace=nowarn'], input: authenticatedPatch,
      unchangedCode: REASON.apply_baseline_moved,
      writeBackupManifest,
      expectedHead: head.stdout.trim(),
    });
    if (wrote.blocked !== undefined) { keepBackup = wrote.keepBackup === true; return wrote.blocked; }
    const postWriteFailure = async (unchangedFailure) => {
      const classified = await classifyCompletedWrite({
        repoPath, scratch: room, backup: wrote.backup, unchangedFailure,
      });
      keepBackup = classified.keepBackup === true;
      return classified.blocked;
    };

    // 확인은 예상 트리 대조다. 역방향 `--check` 는 3-way 결과에 대해 **거짓 실패**를 낸다
    // (실측: 합쳐진 파일은 패치의 전상(前像)이 아니므로 거꾸로 붙지 않는다).
    // ★ 그 대조는 진짜 인덱스의 **사본** 위에서 돈다(`copyRealIndex` 의 ★★, 재리뷰 C2) —
    //   객체만 임시로 돌리고 인덱스는 진짜를 읽으면 사용자 인덱스의 cache-tree 에 곧 지워질
    //   트리 id 가 도장 찍혀 `git fsck`·`git gc` 가 죽는다(실측 exit 8 · 128).
    const indexCopy = await copyRealIndex(git, room, repoPath);
    // ★★ 여기는 **적용이 이미 성공한 뒤**다(재리뷰2 C-c). 작업 트리가 바뀌었고 `--3way` 가
    //   함의하는 `--index` 때문에 스테이징까지 됐다 — 실측: 그 순간 `git status` 가
    //   `M  src/a.txt` · `A  src/added dir/new.txt` 를 낸다. 그래서 「저장소는 그대로다」를
    //   등재 문장으로 가진 `apply_git_failed` 를 여기서 내면 계약이 거짓말을 하고, 그 코드의
    //   회복("재시도하라")은 스테이징된 트리를 만나 `apply_worktree_dirty` 로 튕기며 그쪽
    //   회복은 「커밋하거나 stash 하라」다 — 확인 안 된 병합 결과를 사용자 것으로 알고
    //   커밋하게 만드는 길이다. 쓰기 뒤 failure handler 는 이 자리에서도 read-only 다. 작업
    //   트리만 복원하면 스테이징과 어긋나고, 인덱스를 복원하면 경쟁하는 `git add` 를 삼킨다.
    if (indexCopy === null) {
      return await postWriteFailure(fail(REASON.apply_applied_unverified, {
        path: repoPath, detail: 'the index could not be copied for the post-apply check',
      }));
    }
    const checking = { ...scoped, GIT_INDEX_FILE: indexCopy };
    const realUnmerged = await git(['ls-files', '-u'], checking);
    if (realUnmerged.ok !== true) {
      return await postWriteFailure(fail(REASON.apply_applied_unverified, {
        path: repoPath,
        detail: `git ls-files -u on the copied index could not complete: ${gitDetail(realUnmerged)}`,
      }));
    }
    if (realUnmerged.stdout !== '') {
      return await postWriteFailure(fail(REASON.apply_verification_failed, {
        path: repoPath,
        detail: 'the copied index reports unmerged entries after the completed three-way write',
      }));
    }
    const actual = await git(['write-tree'], checking);
    if (actual.ok !== true) {
      return await postWriteFailure(fail(REASON.apply_applied_unverified, {
        path: repoPath,
        detail: `git write-tree on the copied index could not complete: ${gitDetail(actual)}`,
      }));
    }
    if (actual.stdout.trim() !== expectedTree) {
      return await postWriteFailure(fail(REASON.apply_verification_failed, {
        path: repoPath,
        detail: 'the copied post-apply index tree differs from the temporary index prediction',
      }));
    }
    return report({
      applied: true, mode: 'three_way', staged: true, verifiedBy: 'expected_tree', expectedTree, scope: inspected.scope,
    });
  } finally {
    if (scratchRoom !== null) {
      if (keepBackup) await retainScratchRoom(scratchRoom).catch(() => {});
      else await closeScratchRoom(scratchRoom).catch(() => {});
    }
  }
}
