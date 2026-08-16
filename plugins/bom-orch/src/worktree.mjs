import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runGit } from './git.mjs';
import { canonical } from './real-path.mjs';
import { isSafeWorktree } from './reaper.mjs';

/**
 * 일회용 git 워크트리의 수명주기: 생성 + 상태 이식 → 스텝별 스냅샷 → 최종 패치 → 제거.
 *
 * ## ★ 계약: 이 모듈이 내는 패치·diff 는 전부 **Buffer(원시 바이트)** 다
 *
 * `collectPatch().patch` 와 `snapshotStep().diff` 는 문자열이 아니라 Buffer 다. 이유는
 * 실측된 데이터 손상이다 — `runGit` 은 stdout 을 `setEncoding('utf8')` 로 받으므로
 * **문자열로 나온 패치는 이미 한 번 utf8 디코딩을 거친 값**이고, `--binary` 는 git 이
 * *바이너리로 판정한* 파일(선두 8000바이트에 NUL)만 base85 로 감싼다. NUL 이 없는
 * CP949·EUC-KR·Latin-1 파일은 git 이 "텍스트"로 보고 원시 바이트를 그대로 diff 에
 * 싣고, 그 왕복에서 U+FFFD 로 치환된다(실측, EUC-KR "한글\n" = c7d1b1db0a):
 *
 *     A) stdout 을 utf8 문자열로 받아 다시 utf8 로 쓰기 -> U+FFFD 삽입, 원본 바이트 소실
 *     B) diff … --output=<파일>                        -> 원본 바이트 그대로
 *
 * 그래서 이 모듈은 패치를 **파일로 직접 받는다**(`--output=`). 소비자에게 주는 규칙:
 *
 *   - 파일로 쓸 때는 `writeFile(path, patch)` — Buffer 를 그대로 넘긴다.
 *   - 사람에게 보여 줄 때만 utf8 로 푼다. 그 값을 다시 바이트로 되돌리지 마라.
 *   - 훑어봐야 할 때는 `patch.toString('latin1')` — latin1 은 바이트를 보존하므로
 *     되돌릴 수 있다. **`toString()`(= utf8)을 쓰면 그 자리에서 본문이 깨진다.**
 *
 *     ★ 예전에 여기 "헤더는 ASCII 이고" 라고 적혀 있었는데 **거짓이다**(실측):
 *
 *         core.quotePath=true  | diff --git "a/\355\225\234\352\270\200.txt" … | 비 ASCII 없음
 *         core.quotePath=false | diff --git a/한글.txt b/한글.txt (원시 바이트)  | 비 ASCII 있음
 *
 *       `core.quotePath` 는 저장소 config 로도 전역으로도 심긴다. 그 문장을 믿고 latin1
 *       문자열을 **그대로 경로로** 쓰면 존재하지 않는 이름을 얻는다. 되돌리려면
 *       `Buffer.from(s, 'latin1').toString('utf8')` 에 quote 해제까지 해야 한다.
 *
 * ## ★ 계약: **무엇이 바뀌었는지는 `files` 에서만 읽어라 — 패치를 파싱하지 마라**
 *
 * `collectPatch().files` 가 그 실행이 건드린 경로의 완전한 목록이다. 패치 본문에서
 * 경로를 긁어내지 마라. 두 가지 이유로 그 방법은 **원리적으로 틀린다**:
 *
 *   - **rename 은 `---`/`+++` 줄을 아예 만들지 않는다**(실측). rename 감지는
 *     `diff.renames` 기본값이라 항상 켜져 있다. "`+++ b/` 에서 경로를 모은다"는 흔한
 *     구현을 쓰면 `src/x.js` → `.github/workflows/x.yml` 이동이 **파일 0개**로 보여
 *     스코프 검사를 그냥 통과한다.
 *   - `diff --git` 줄은 공백이 든 경로에서 두 경로의 경계가 모호해 정규식 파싱이
 *     원리적으로 불안정하고, 위 `core.quotePath` 축까지 겹친다.
 *
 * `files` 는 `diff --cached --name-only -z --no-renames <baseline>` 로 뜬다.
 * `-z` 라 quote·escape 가 없는 원시 경로이고(`core.quotePath` 와 무관 — 실측),
 * `--no-renames` 라 이동이 삭제+추가로 풀려 **원본과 대상 경로가 둘 다** 들어간다
 * (`--no-renames` 없이는 대상 경로만 나온다 — 실측). 목록을 뜨지 못하면 이 함수는
 * 빈 배열이 아니라 **blocked** 를 낸다.
 *
 * ⚠ 무보증: POSIX 에서 파일 이름은 임의 바이트열일 수 있는데 `runGit` 의 stdout 은
 *   utf8 로 디코딩된다. UTF-8 이 아닌 이름은 이 목록에서 U+FFFD 를 얻는다. Windows
 *   에서는 파일 이름이 항상 UTF-16 이라 발생하지 않는다. 고치지 않고 사실만 적는다.
 *
 * Buffer 로 내는 이유는 실패가 **시끄럽기** 때문이다. latin1 문자열로 냈다면
 * `writeFile(p, s)`(기본 utf8)가 조용히 손상시키고 JSON 직렬화가 조용히 모지바케를
 * 만든다. Buffer 는 `.match()` 에서 TypeError 를 내고 JSON 에서 `{"type":"Buffer"}` 로
 * 드러난다 — 이 저장소가 되풀이해 온 "조용히 틀린 결과"보다 낫다.
 *
 * ★ **이 모듈이 격리의 전부다.** 라이브 실측이 설계 가정을 뒤집었다 — 두 벤더 CLI 의
 *   도구 권한 플래그로는 델리게이트의 셸을 제한할 수 없다. 그래서 실제로 성립하는
 *   격리는 "델리게이트는 사용자 저장소가 아니라 여기 만든 워크트리 안에서만 일한다"는
 *   파일시스템 범위 하나뿐이다. `src/git.mjs` 의 하드닝 플래그도 자기 주석에서
 *   "실제 격리는 이 플래그들이 아니라 일회용 워크트리에 의존한다"고 적고 있다.
 *
 * ★ git 은 `runGit` 을 통해서만 부른다. `test/guards/no-raw-git.test.mjs` 가 소스
 *   검사로 강제한다. 그래서 여기에는 두 가지 제약이 따라온다:
 *   - 작업 디렉터리는 argv 의 `-C` 가 아니라 **`cwd` 옵션**으로 준다. `runGit` 은 선행
 *     전역 옵션을 허용 목록 + fail-closed 로 막으므로 `-C` 는 애초에 거부된다.
 *   - 임시 인덱스와 커밋 저자도 `-c` 가 아니라 **`env` 옵션**으로 준다(같은 이유).
 */

/** 스텝 스냅샷·이식 커밋의 저자. 사용자 전역 설정을 건드리지 않으려고 env 로만 준다. */
const COMMIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'bom-orch',
  GIT_AUTHOR_EMAIL: 'bom-orch@localhost',
  GIT_COMMITTER_NAME: 'bom-orch',
  GIT_COMMITTER_EMAIL: 'bom-orch@localhost',
});

/**
 * 워크트리 명령의 시간 상한. `runGit` 의 기본값(30초)보다 넉넉하게 잡는다 — 큰 저장소의
 * `worktree add`(= 전체 체크아웃)와 `add -A`(= 전체 스테이징)는 30초를 넘길 수 있고,
 * 그때 타임아웃으로 끊기면 반쯤 만들어진 워크트리가 남는다.
 */
const WORKTREE_TIMEOUT_MS = 300_000;

/**
 * runId 의 허용 문자.
 *
 * 경로 조각으로 쓰이므로 구분자·`..`·드라이브 문자·제어문자가 들어오면 상태 루트
 * 바깥을 가리킬 수 있다. 허용 목록으로 잡는 것이 fail-closed 다. 길이 상한은 Windows
 * 의 경로 길이 제한에 워크트리 안의 깊은 파일 경로까지 얹힐 여유를 남기려는 것이다.
 *
 * ★ 기준은 문자열 동일성이 아니라 **경로 동일성**이다. 예전 패턴
 *   `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` 은 `Run1`/`run1` 과 `run2`/`run2.` 를 **서로
 *   다른 runId** 로 통과시켰는데 **Windows 는 둘을 같은 디렉터리로 접는다**(대소문자
 *   무시 + 후행 점 제거). 그러면 이 모듈이 서 있는 "runId 하나 = 디렉터리 하나" 전제가
 *   대상 플랫폼에서 성립하지 않고, 두 런이 같은 디렉터리를 두고 충돌한다. runId 가 MCP
 *   클라이언트에서 온다면 그것은 "남의 런을 의도적으로 파괴하는 원시 동작"이었다.
 *
 *   그래서 접히는 두 축을 문자 집합에서 아예 제거한다: **소문자만** 허용하고 **`.` 를
 *   금지**한다. 이제 서로 다른 runId 는 어떤 플랫폼에서도 서로 다른 디렉터리다.
 *
 *   ★ 이것과 `createBody` 의 "살아 있는 등록 확인"은 서로 다른 축을 좁힌다. 여기만
 *     으로는 같은 runId 를 두 번 쓰는 것을 못 막고, 저쪽만으로는 대소문자 변형을
 *     못 막는다.
 */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PURPOSE_PATTERN = /^(?:lane-[ab]|lane-[ab]-\d{3}-(?:b0|br|c)-[12])$/;
const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const UNSAFE_FILE_MODES = new Set(['120000', '160000']);
const WINDOWS_INVALID_COMPONENT_PATTERN = /[<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * A logical Run ID is durable authority; this value is only its bounded filesystem projection.
 * The digest binds bytes that may be truncated from the visible prefix as well as the purpose.
 */
export function makeWorktreeId({ runId, purpose } = {}) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError('실행 runId 는 소문자 안전 문자로 된 1~64자 값이어야 합니다.');
  }
  if (typeof purpose !== 'string' || !PURPOSE_PATTERN.test(purpose)) {
    throw new TypeError('워크트리 purpose 가 허용된 lane/evidence 용도가 아닙니다.');
  }
  const digest = createHash('sha256')
    .update(runId, 'utf8')
    .update(Buffer.from([0]))
    .update(purpose, 'utf8')
    .digest('hex')
    .slice(0, 12);
  const suffix = `-${purpose}-${digest}`;
  const prefix = runId.slice(0, 64 - suffix.length);
  const id = `${prefix}${suffix}`;
  if (!RUN_ID_PATTERN.test(id) || id.length > 64) {
    throw new RangeError('워크트리 filesystem ID 를 안전한 64자 안에 만들 수 없습니다.');
  }
  return id;
}

const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';

/**
 * 이 모듈의 **내부** 실패 봉투. `src/git.mjs` 의 `blocked()` 와 같은 모양이다.
 *
 * ★ M-6 (b). 예전 주석은 출처를 `src/envelope.mjs` 로 잘못 지목했다. 직접 확인:
 *
 *     envelope.mjs 의 failure({status:'blocked', …})
 *       -> {"status":"blocked","error":"e","recovery":"r"}   <- `blocked:true` 필드가 없다
 *     git.mjs 의 blocked()
 *       -> { blocked: true, error, recovery }                <- 이쪽과 같은 모양
 *
 *   `{blocked:true}` 자체는 올바른 선택이고 틀린 것은 출처 표기뿐이다. 다만 그 오기를
 *   믿고 "이미 MCP 봉투 모양"이라고 흘려보내면 `STATUSES` 어휘를 안 거친 결과가
 *   클라이언트에 간다. **MCP 결과로 내보낼 때는 `failure({status:'blocked', …})` 로
 *   번역해야 한다** — 다음 태스크가 `tools.mjs`/`server.mjs` 에 배선할 때의 전제다.
 */
function blocked(error, recovery) {
  return { blocked: true, error, recovery: recovery && recovery !== '' ? recovery : GENERIC_RECOVERY };
}

/**
 * git 봉투에서 사람이 읽을 실패 사유를 뽑는다.
 *
 * ★ stderr 가 비면 **stdout 도 본다.** git 의 실패 메시지가 전부 stderr 로 가지는
 *   않는다 — `commit` 의 "nothing to commit, working tree clean" 은 `-q` 와 **무관하게
 *   항상 stdout** 이다(실측: `-q` 유무와 상관없이 stdout 53바이트 / stderr 0바이트).
 *   stderr 만 보던 시절에는 그 실패가 "git 이 종료 코드 1 로 끝났습니다" 라는 아무 정보
 *   없는 문장이 됐다. 그러고도 사유가 없으면 종료 코드라도 남긴다.
 */
function gitReason(result) {
  const err = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
  if (err !== '') return err.slice(0, 500);
  const out = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (out !== '') return out.slice(0, 500);
  if (result?.failed) return 'git 을 실행하지 못했습니다.';
  return `git 이 종료 코드 ${result?.exitCode} 로 끝났습니다.`;
}

async function absenceProven(path) {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

const isFullObjectId = (value) => typeof value === 'string' && FULL_OBJECT_ID_PATTERN.test(value);

function validateEvidencePaths(paths, { enforceInputLimit = true } = {}) {
  if (paths === undefined) return { ok: true, paths: null };
  if (!Array.isArray(paths)) {
    return { ok: false, error: '경로 allowlist 는 문자열 배열이어야 합니다.' };
  }
  if (enforceInputLimit && paths.length > 4_000) {
    return { ok: false, error: '경로 allowlist 가 너무 큽니다(최대 4000개).' };
  }
  const seen = new Set();
  const safe = [];
  for (const path of paths) {
    if (typeof path !== 'string' || path === '') {
      return { ok: false, error: '경로 allowlist 의 모든 항목은 비어 있지 않은 문자열이어야 합니다.' };
    }
    if (path.includes('\0') || path.includes('\ufffd')) {
      return { ok: false, error: 'NUL 또는 잘못 디코딩된 문자가 든 경로는 사용할 수 없습니다.' };
    }
    // Git emits repository-relative paths with '/'. Reject '\\' too: on Windows it is a path
    // separator, while on POSIX accepting it would make the same persisted authority non-portable.
    if (isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
      return { ok: false, error: `절대 경로나 플랫폼 경계가 모호한 경로는 사용할 수 없습니다: ${JSON.stringify(path)}` };
    }
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return { ok: false, error: `저장소 밖으로 빠질 수 있는 경로는 사용할 수 없습니다: ${JSON.stringify(path)}` };
    }
    if (seen.has(path)) {
      return { ok: false, error: `중복 경로는 권위 목록으로 사용할 수 없습니다: ${JSON.stringify(path)}` };
    }
    seen.add(path);
    safe.push(path);
  }
  return { ok: true, paths: safe };
}

function validateMaterializationPaths(paths) {
  const evidence = validateEvidencePaths(paths, { enforceInputLimit: false });
  if (!evidence.ok) return evidence;
  const seenAliases = new Set();
  for (const path of evidence.paths) {
    for (const segment of path.split('/')) {
      if (
        WINDOWS_INVALID_COMPONENT_PATTERN.test(segment) ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_DEVICE_BASENAME_PATTERN.test(segment)
      ) {
        return {
          ok: false,
          error: `Windows 에서 다른 파일/ADS/device 로 해석될 수 있는 경로는 적용할 수 없습니다: ${JSON.stringify(path)}`,
        };
      }
    }
    const alias = path.normalize('NFC').toLowerCase();
    if (seenAliases.has(alias)) {
      return { ok: false, error: `대소문자/정규화 별칭 경로는 함께 적용할 수 없습니다: ${JSON.stringify(path)}` };
    }
    seenAliases.add(alias);
  }
  return evidence;
}

function validateRevisionPair(spec) {
  const options = spec ?? {};
  if (!isFullObjectId(options.from) || !isFullObjectId(options.to)) {
    return { ok: false, error: 'from/to revision 은 Git 에서 얻은 full lowercase object ID 여야 합니다.' };
  }
  const paths = validateEvidencePaths(options.paths);
  if (!paths.ok) return paths;
  return { ok: true, from: options.from, to: options.to, paths: paths.paths };
}

function parseRawRevisionDelta(stdout) {
  if (typeof stdout !== 'string') {
    return { ok: false, error: 'Git raw delta 출력이 문자열이 아닙니다.' };
  }
  if (stdout.includes('\ufffd')) {
    return { ok: false, error: 'Git 경로가 유효한 UTF-8 로 디코딩되지 않아 추측하지 않고 막았습니다.' };
  }
  if (stdout === '') return { ok: true, entries: [] };
  if (!stdout.endsWith('\0')) {
    return { ok: false, error: 'Git raw delta 의 NUL 종결자가 없습니다.' };
  }
  const records = stdout.split('\0');
  records.pop();
  if (records.length % 2 !== 0) {
    return { ok: false, error: 'Git raw delta 레코드가 중간에서 잘렸습니다.' };
  }

  const checkedPaths = validateEvidencePaths(
    records.filter((_, index) => index % 2 === 1),
    { enforceInputLimit: false },
  );
  if (!checkedPaths.ok) return checkedPaths;

  const entries = [];
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index];
    const path = records[index + 1];
    const match = /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([AMDT])$/.exec(header);
    if (!match) return { ok: false, error: 'Git raw delta 헤더가 허용된 형식이 아닙니다.' };
    const [, oldMode, newMode, oldOid, newOid, code] = match;
    if (oldOid.length !== newOid.length) {
      return { ok: false, error: 'Git raw delta object ID 길이가 서로 다릅니다.' };
    }
    if (UNSAFE_FILE_MODES.has(oldMode) || UNSAFE_FILE_MODES.has(newMode)) {
      return { ok: false, error: `symlink/gitlink mode 가 든 delta 는 적용 권위로 사용할 수 없습니다: ${path}` };
    }
    const oldRegular = REGULAR_FILE_MODES.has(oldMode);
    const newRegular = REGULAR_FILE_MODES.has(newMode);
    let status;
    if (code === 'A' && oldMode === '000000' && newRegular) status = 'added';
    else if (code === 'D' && oldRegular && newMode === '000000') status = 'deleted';
    else if (code === 'M' && oldRegular && newRegular) status = 'modified';
    else if (code === 'T') {
      return { ok: false, error: `파일 type change 는 안전한 path-only delta 로 다룰 수 없습니다: ${path}` };
    } else {
      return { ok: false, error: `mode/status 조합이 일관되지 않습니다: ${path}` };
    }
    entries.push({
      path,
      status,
      oldMode: oldMode === '000000' ? null : oldMode,
      newMode: newMode === '000000' ? null : newMode,
    });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return { ok: true, entries };
}

function revisionDiffArgs({ from, to, paths, raw }) {
  const args = [];
  if (paths !== null) args.push('--literal-pathspecs');
  args.push('diff');
  // runGit injects `-U3` after `diff` as a patch-output hardening. Reset that presentation mode
  // before re-enabling raw output so stdout remains NUL-only authority instead of raw+patch text.
  if (raw) args.push('--no-patch', '--raw', '-z', '--no-abbrev');
  else args.push('--binary');
  args.push('--no-renames', from, to);
  if (paths !== null) args.push('--', ...paths);
  return args;
}

async function resolveExactCommit({ run, cwd, revision, label }) {
  const result = await run({
    args: ['rev-parse', '--verify', `${revision}^{commit}`],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  const commit = result?.ok && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!isFullObjectId(commit) || commit !== revision) {
    return blocked(
      `${label} revision 이 정확한 commit object 가 아닙니다: ${gitReason(result)}`,
      'Git 이 반환한 full lowercase commit ID 를 사용하세요.',
    );
  }
  return { ok: true, commit };
}

async function authenticateRevisionPair({ run, cwd, revisions }) {
  const from = await resolveExactCommit({ run, cwd, revision: revisions.from, label: 'from' });
  if (from.blocked) return from;
  const to = await resolveExactCommit({ run, cwd, revision: revisions.to, label: 'to' });
  if (to.blocked) return to;
  return { ok: true, from: from.commit, to: to.commit, paths: revisions.paths };
}

async function resolveRevisionIdentity({ run, cwd, revision, requireExact = true }) {
  if (requireExact && !isFullObjectId(revision)) {
    return blocked('revision 은 full lowercase commit ID 여야 합니다.', 'Git 이 반환한 전체 commit ID 를 사용하세요.');
  }
  const commitResult = await run({
    args: ['rev-parse', '--verify', `${revision}^{commit}`],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  const commit = commitResult?.ok && typeof commitResult.stdout === 'string' ? commitResult.stdout.trim() : '';
  if (!isFullObjectId(commit) || (requireExact && commit !== revision)) {
    return blocked(
      `revision 을 정확한 commit 으로 확인하지 못했습니다: ${gitReason(commitResult)}`,
      '존재하는 full lowercase commit ID 를 사용하세요.',
    );
  }
  const treeResult = await run({
    args: ['rev-parse', '--verify', `${commit}^{tree}`],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  const tree = treeResult?.ok && typeof treeResult.stdout === 'string' ? treeResult.stdout.trim() : '';
  if (!isFullObjectId(tree)) {
    return blocked(
      `revision 의 tree 를 확인하지 못했습니다: ${gitReason(treeResult)}`,
      '저장소와 commit object 가 정상인지 확인하세요.',
    );
  }
  return { ok: true, commit, tree };
}

// ── 워크트리 등록 조회 ────────────────────────────────────────────────────

/**
 * 경로 비교용 표기 정규화. **표기만** 맞춘다 — 링크·8.3 은 `src/real-path.mjs` 의
 * `canonical` 이 편다.
 *
 * ★ Windows 에서 **대소문자를 접는다.** `git worktree list --porcelain` 은 슬래시
 *   경로를 내는데 `join()` 은 역슬래시를 내므로 구분자도 맞춰야 한다. POSIX 에서는
 *   대소문자가 유의미하므로 접지 않는다 — 접으면 서로 다른 두 워크트리를 같은 것으로
 *   보고 남의 것을 우리 것으로 오인한다.
 */
function normalizePath(value) {
  const slashed = String(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * ★ 이 함수의 두 인자는 **`canonical` 을 지난 값**이어야 한다.
 *
 *   표기만 맞춘 문자열 비교는 git 의 판정과 어긋난다(`src/real-path.mjs` 의 실측).
 *   그 어긋남이 나던 시절, 정션 경유 상태 루트에서 살아 있는 다른 런의 워크트리가
 *   `rm -rf` 로 통째로 사라졌다.
 */
const samePath = (a, b) => normalizePath(a) === normalizePath(b);

/**
 * `git worktree list --porcelain` 을 파싱한다. 절대 던지지 않는다.
 *
 * 형태(실측 git 2.55.0.windows.3):
 *
 *     worktree C:/repo
 *     HEAD <sha>
 *     branch refs/heads/master
 *
 *     worktree C:/wts/gone
 *     HEAD <sha>
 *     detached
 *     prunable gitdir file points to non-existent location
 *
 * @returns `{ ok: true, entries: [{ path, prunable }] }` 또는 `{ ok: false }`.
 *   **`ok:false` 를 "등록이 없다"로 읽으면 안 된다** — 모르는 것과 없는 것은 다르다.
 */
async function listRegisteredWorktrees({ run, projectPath }) {
  const got = await run({
    args: ['worktree', 'list', '--porcelain'],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  if (!got?.ok || typeof got.stdout !== 'string') return { ok: false };

  const entries = [];
  for (const raw of got.stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      entries.push({ path: line.slice('worktree '.length), prunable: false });
    } else if ((line === 'prunable' || line.startsWith('prunable ')) && entries.length > 0) {
      entries[entries.length - 1].prunable = true;
    }
  }
  return { ok: true, entries };
}

/**
 * 그 디렉터리가 **살아 있는 링크드 워크트리의 루트**인가. git 에게 그 안에서 직접
 * 묻는다 — 우리 쪽 경로 문자열이 판정에 개입하지 않는다.
 *
 * 판정 재료(실측 git 2.55.0.windows.3, 같은 경로를 정션으로 줘도 결과가 같다):
 *
 *     [살아 있는 링크드 워크트리]  rev-parse --absolute-git-dir -> …/.git/worktrees/<id>
 *     [저장소 밖의 순수 잔재]      exit 128 "not a git repository"
 *     [무관한 저장소 안의 잔재]    …/other/.git        <- 부모가 `worktrees` 가 아니다
 *
 * 그래서 "git dir 의 **부모 디렉터리 이름이 `worktrees`**" 하나로 세 경우가 갈린다.
 * 잔재의 자가 치유(의도된 동작)를 막지 않으면서 남의 살아 있는 워크트리만 걸러 낸다.
 */
async function looksLikeLinkedWorktree({ run, path }) {
  const got = await run({
    args: ['rev-parse', '--absolute-git-dir'],
    cwd: path,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  if (!got?.ok || typeof got.stdout !== 'string') return false;
  const gitDir = got.stdout.trim();
  if (gitDir === '') return false;
  return basename(dirname(gitDir.replaceAll('\\', '/'))) === 'worktrees';
}

// ── 패치를 바이트로 뜨기 ──────────────────────────────────────────────────

/**
 * `git diff` 의 출력을 **파일로 직접 받는다**(모듈 상단의 바이트 계약 참조).
 *
 * `--output=<파일>` 은 서브커맨드 **뒤**, path separator `--` **앞**에 둔다. 그래야
 * `runGit` 의 선행 전역 옵션 스크리닝에 걸리지 않고, literal allowlist가 있을 때도
 * 출력 옵션 자체를 경로로 오인하지 않는다.
 *
 * @returns `{ size }` (성공) 또는 `{ failure }` (git 봉투 그대로).
 */
async function diffToFile({ run, args, cwd, env, patchPath }) {
  const separator = args.indexOf('--');
  const outputArg = `--output=${patchPath}`;
  const finalArgs = separator === -1
    ? [...args, outputArg]
    : [...args.slice(0, separator), outputArg, ...args.slice(separator)];
  const got = await run({
    args: finalArgs,
    cwd,
    env,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });

  // ★ 순서가 중요하다. `ok` 를 **먼저** 본다. 크기를 먼저 "변경 없음"으로 해석하면
  //   diff 가 실패했을 때 조용히 옛 코드로 진행한다 — 이 모듈이 막으려는 바로 그
  //   실패다. 깨끗한 저장소(성공 + 0바이트)와 실패는 `ok` 말고는 구분할 수단이 없다.
  //   `--output` 으로 바뀌면서 판정 재료가 stdout 에서 파일 크기로 바뀌었을 뿐, 이
  //   순서는 그대로다.
  if (!got.ok) return { failure: got };

  // ★ 실측(git 2.55.0.windows.3): 변경이 없어도 `--output` 파일은 **0바이트로 만들어진다.**
  //   그래서 "파일 없음" 은 정상 상태가 아니다 — 여기서 0(= 변경 없음)으로 떨어뜨리면
  //   diff 가 아무것도 안 낸 것을 "이식할 게 없다"로 오판할 수 있다. fail-closed 로
  //   거부하고, 그 판단의 근거(이 실측)를 여기 남긴다. 다른 git 이 빈 diff 에서 파일을
  //   만들지 않는다면 이 자리가 시끄럽게 깨진다 — 조용히 틀리는 것보다 낫다.
  const size = await stat(patchPath).then((s) => s.size, () => null);
  if (size === null) {
    return {
      failure: {
        ok: false,
        stdout: '',
        stderr: `git diff 가 성공했다고 보고했는데 패치 파일이 없습니다: ${patchPath}`,
        exitCode: null,
        failed: true,
        timedOut: false,
      },
    };
  }
  return { size };
}

/**
 * `diffToFile` 로 뜬 패치를 **Buffer** 로 읽어 온다. 임시 파일은 반드시 치운다.
 *
 * 절대 던지지 않는다 — 파일 I/O(EPERM·ENOSPC·안티바이러스 잠금)가 던지면 `{ crashed }`
 * 로 돌려주고 호출자가 봉투로 강등한다. `snapshotStep`·`collectPatch` 는 생성 큐의
 * try/catch 밖에 있어서 여기서 던지면 거부된 프로미스가 호출자에게 그대로 나간다.
 *
 * @returns `{ bytes }` · `{ failure }` · `{ crashed }`
 */
async function diffToBytes({ run, args, cwd, env, stateRoot, tag }) {
  const requestedScratch = join(stateRoot, 'scratch');
  let operationPath = null;
  let operationIdentity = null;
  let operationOwned = false;
  let patchPath = null;
  let outcome;
  try {
    await mkdir(requestedScratch, { recursive: true });
    const [realStateRoot, scratch] = await Promise.all([canonical(stateRoot), canonical(requestedScratch)]);
    const scratchRel = realStateRoot === null || scratch === null ? null : relative(realStateRoot, scratch);
    if (scratchRel === null || scratchRel === '' || scratchRel.startsWith('..') || isAbsolute(scratchRel)) {
      throw new Error('scratch 경로의 실체가 상태 루트 밖을 가리킵니다.');
    }
    operationPath = await mkdtemp(join(scratch, 'diff-'));
    operationOwned = true;
    const [operationEntry, realOperation] = await Promise.all([
      lstat(operationPath, { bigint: true }),
      canonical(operationPath),
    ]);
    const operationRel = realOperation === null ? null : relative(scratch, realOperation);
    if (
      !operationEntry.isDirectory() ||
      operationEntry.isSymbolicLink() ||
      operationRel === null ||
      operationRel === '' ||
      operationRel.startsWith('..') ||
      isAbsolute(operationRel) ||
      !samePath(operationPath, realOperation)
    ) {
      throw new Error('diff 전용 scratch 디렉터리의 소유권/containment 를 증명하지 못했습니다.');
    }
    operationIdentity = { dev: operationEntry.dev, ino: operationEntry.ino };
    patchPath = join(operationPath, 'patch');
    const wrote = await diffToFile({ run, args, cwd, env, patchPath });
    if (wrote.failure) outcome = wrote;
    else if (wrote.size === 0) outcome = { bytes: Buffer.alloc(0) };
    else outcome = { bytes: await readFile(patchPath) };
  } catch (error) {
    outcome = { crashed: new Error(`${tag} patch scratch 처리 실패: ${String(error?.message ?? error)}`) };
  }
  if (operationOwned) {
    const entry = await lstat(operationPath, { bigint: true }).catch(() => null);
    const sameOwnedDirectory =
      entry?.isDirectory() &&
      !entry.isSymbolicLink() &&
      operationIdentity !== null &&
      entry.dev === operationIdentity.dev &&
      entry.ino === operationIdentity.ino;
    if (sameOwnedDirectory) {
      await rm(operationPath, { recursive: true, force: true }).catch(() => {});
    }
    const removed = await absenceProven(operationPath);
    if (!removed) return { crashed: new Error(`${tag} patch scratch 전용 디렉터리를 지우지 못했습니다.`) };
  }
  return outcome;
}

// ── 동시 생성 직렬화 ──────────────────────────────────────────────────────

/**
 * ★ `git worktree add` 는 `.git/worktrees/` 에 쓰므로 동시 실행이 경합한다(§5.7).
 *   `src/providers/catalog.mjs` 의 프로미스 체인 큐를 그대로 따라 프로세스 안에서
 *   생성을 한 줄로 세운다.
 *
 * ★ 계획 1 에서 이 패턴으로 Critical 을 하나 냈다: 체인에 거부된 프로미스가 하나
 *   실리면 이후 `.then` 콜백이 전부 건너뛰어져 큐가 프로세스 수명 내내 막힌다. 그래서
 *   **작업의 본문 전체**를 try/catch 로 감싼다. 실제로 던질 수 있는 것은
 *   runGit(never-throw)이 아니라 mkdir·rm·readFile 이다.
 *
 *   ★ 이 catch 는 **바깥의 마지막 그물**이다. 실제 실패 경로에서는 `createWorktree` 안의
 *     try/catch 가 먼저 잡으므로 여기까지 오지 않는다 — 그쪽은 `worktreePath` 를 알아서
 *     뒷정리까지 하고, 여기서는 경로를 몰라 아무것도 치울 수 없다. 그래도 남기는 이유는
 *     `createWorktree` **밖**(= 큐 안이지만 그 try 앞)에서 던지는 코드가 생기면 큐가
 *     통째로 막히기 때문이다.
 *
 *   `.then(job, job)` 의 두 번째 인자(거부 핸들러)도 같은 성격이다. 위 try/catch 가 있는
 *   한 `job` 은 거부된 프로미스를 내지 않으므로 관측되는 동작이 같다(되돌려도 같다 —
 *   실측). 미래의 편집 한 줄이 큐를 망가뜨리지 못하게 두는 자가 복구 장치다
 *   (catalog.mjs 가 같은 이유로 같은 형태를 쓴다).
 */
let createQueue = Promise.resolve();

/**
 * ★ 큐가 정말로 직렬화하는지 재기 위한 관측 창. **테스트 전용**이다.
 *
 *   왜 결과로는 못 재는가(실측 git 2.55.0.windows.3): 큐 없이 `git worktree add` 를
 *   5개는 물론 12개까지 동시에 걸어도 실패가 0이었다. 즉 "동시 5개가 다 성공한다" 같은
 *   결과는 큐가 있든 없든 같다. 겹침 자체를 세는 것 말고는 이 성질을 밖에서 볼 방법이
 *   없다.
 */
let inFlight = 0;
let peakInFlight = 0;
let completed = 0;

export function queueStats() {
  return { inFlight, peak: peakInFlight, completed };
}

export function resetQueueStats() {
  peakInFlight = 0;
  completed = 0;
}

/** 생성 작업 하나를 큐에 세운다. 절대 거부된 프로미스를 남기지 않는다. */
function enqueue(body) {
  const job = async () => {
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    try {
      return await body();
    } catch (error) {
      return blocked(
        `워크트리를 만드는 중에 예기치 못한 오류가 났습니다: ${String(error?.message ?? error)}`,
        '상태 루트 경로에 쓸 수 있는지, 디스크에 공간이 있는지 확인하세요.',
      );
    } finally {
      inFlight -= 1;
      completed += 1;
    }
  };
  createQueue = createQueue.then(job, job);
  return createQueue;
}

// ── 생성 + 상태 이식 ──────────────────────────────────────────────────────

/**
 * 일회용 워크트리를 만들고 사용자의 **미커밋 상태를 이식**한다.
 *
 * ★ 이식(§5.2 ②)이 이 모듈의 핵심이다. `git worktree add --detach` 만 하면 워크트리에는
 *   **커밋된 옛 코드**만 있다(실측). 그 상태로 델리게이트를 붙이면 사용자가 지금 보고
 *   있는 코드가 아니라 마지막 커밋을 고친다 — 위험이 아니라 **틀린 결과**다.
 *
 *   확정된 명령 시퀀스(직접 재현함):
 *     GIT_INDEX_FILE=<임시>  git read-tree HEAD
 *     GIT_INDEX_FILE=<임시>  git add -A
 *     GIT_INDEX_FILE=<임시>  git diff --cached --binary HEAD  > state.patch
 *     (워크트리에서)         git apply state.patch
 *
 *   임시 인덱스 덕분에 **사용자 인덱스는 전후 동일**하다. `--binary` 는 빼면 안 된다:
 *   바이너리 변경이 "Binary files a/x and b/x differ" 한 줄로 뭉개지고 `git apply` 가
 *   그것을 적용하지 못한다(실측 — 증상은 조용한 유실이 아니라 이식 실패다. 어느 쪽이든
 *   델리게이트가 사용자의 실제 파일을 못 본다는 결과는 같다).
 *
 * ★ 임시 인덱스와 패치 파일은 **대상 저장소 밖**(상태 루트 아래)에 만든다. 저장소 안에
 *   두었다가 `add -A` 가 그것들을 새 파일로 패치에 쓸어담는 것을 실측으로 확인했다.
 *   피해는 워크트리에 복제된 `index-…`·`index-….lock` 으로 관측된다(경로를
 *   `join(projectPath, …)` 로 바꿔 재현했다).
 *
 *   ★ 이제 그 전제를 **강제한다**(M-3): 상태 루트가 프로젝트 경로 안이면 `createWorktree`
 *     가 fail-closed 로 거부한다. 예전에는 `BOM_ORCH_HOME` 이 절대 경로이기만 하면
 *     프로젝트 안이어도 통과했고, 프로젝트가 `$HOME` 의 저장소(dotfiles)면 **기본값
 *     `~/.bom-orch` 가 그대로 저장소 안**이었다.
 *
 * ## 알려진 한계 (고치지 않고 사실만 적는다)
 *
 * ★ **스테이징된 모드(실행 비트) 변경은 이식되지 않는다.** `read-tree HEAD` + `add -A` 는
 *   워킹 트리만 본다 — 사용자가 `git update-index --chmod=+x` 로 인덱스에만 올려 둔 모드
 *   변경은 워킹 트리에 흔적이 없어 패치에 안 실린다. Windows 에서는 `core.filemode=false`
 *   라 실행 비트 자체가 항상 유실된다. 손상은 아니다: 최종 패치(`collectPatch`)도 같은
 *   기준으로 뜨므로 왕복이 일관되고, 사용자 저장소에 모드 변경을 되돌리는 패치가 가지
 *   않는다. 델리게이트가 "실행 비트가 안 붙어 있다"고 볼 뿐이다.
 *
 * ★ **무시 규칙에 걸린 파일은 양방향으로 이식되지 않는다.** 무시 규칙을 무력화하지
 *   않기 때문이다 — 커밋된 `.gitignore` 도, 사용자의 전역 무시 파일(`core.excludesFile`)
 *   도 정당한 설정이고, 후자를 껐더니 개인 파일(비밀 포함)이 워크트리로 새고 사용자
 *   오브젝트 DB 에 남았다(`src/git.mjs` 의 `HARDENING_ARGS` 주석의 실측). 그 결과:
 *
 *     이식 방향: 사용자의 무시된 워킹트리 파일(`.env`·`.idea/`·로컬 설정)이 워크트리에
 *               안 온다 -> 델리게이트가 사용자와 다른 환경을 본다.
 *               -> `createWorktree` 봉투의 `ignoredPaths` 가 그 사실을 싣는다(I-3).
 *     수집 방향: 델리게이트가 `build/`·`dist/` 에 만든 산출물이 최종 패치에 안 실린다
 *               -> `collectPatch` 의 `ignoredPaths` 가 그 사실을 봉투에 싣는다(C-2b).
 *
 *   같은 신호가 **적대적 저장소 config 로 숨긴 파일도 잡는다** — `--ignored=matching` 은
 *   `core.excludesFile` 이 만든 규칙도 같이 보기 때문이다(실측).
 *
 * ★ **`.git/info/exclude` 와 `.git/info/attributes` 는 플래그로 막을 수 없다** — 그
 *   파일들을 가리키는 config 키가 없다. 실측(둘 다 심고 이식):
 *
 *     .git/info/exclude = "*.js" , .git/info/attributes = "*.txt text eol=crlf"
 *       봉투 {ok:true, transplanted:true}
 *       워크트리 파일 ['mod.txt','seed.txt']            <- app.js 가 통째로 사라졌다
 *       워크트리 mod.txt 6c696e65310d0a…                <- LF -> CRLF 로 갈아치워짐
 *
 *   `.git/info/` 는 워크트리들이 **공유하는** 디렉터리라, 셸이 제한되지 않는 델리게이트가
 *   워크트리에서 직접 써 넣어 다음 런의 이식을 오염시킬 수도 있다. 거부하지는 않는다
 *   (정당한 사용이 있다) — `createWorktree` 봉투의 `sharedRules` 에 실어 조용하지 않게
 *   한다(I-2).
 *
 * ★ **gitlink(중첩 저장소·서브모듈) 경계에서 내용이 넘어가지 않는다.** `worktree add` 는
 *   서브모듈을 채우지 않으므로 델리게이트는 서브모듈 코드를 아예 못 보고, 사용자의
 *   서브모듈 내 미커밋 수정도 이식되지 않는다. 반대 방향은 `collectPatch` 의 `gitlinks`
 *   가 신고한다(I-1). **완전한 서브모듈 지원은 이번 범위 밖이다.**
 *
 * ★ **심볼릭 링크는 일반 파일로 굳는다.** 원인은 `src/git.mjs` 하드닝의
 *   `core.symlinks=false` 이고, 대조 실험으로 분리했다: control 은 `symlink -> target.txt`,
 *   `-c core.symlinks=false` 는 `file(10B)`. 미추적 심링크는 baseline 에 mode **100644**
 *   로 들어간다(`120000` → `100644`, 역시 이 플래그가 원인). 최종 패치와 사용자 저장소는
 *   무사했다. 이 플래그는 CVE-2024-32002 방어라 뺄 수 없으므로 고칠 것은 코드가 아니라
 *   **확언 범위**다. 실제 노출은 POSIX 호스트다 — Windows 의 `git init` 은 저장소 config 에
 *   이미 `core.symlinks=false` 를 써 넣어 실질 무연산이다(M-5a).
 *
 * ★ **개행 표현은 저장소 config 가 선언한 형태로 정규화된다(autocrlf).** 사용자의 LF
 *   파일이 워크트리에서 CRLF 가 되고(`780a790a` → `780d0a790d0a`), 최종 패치 적용 후
 *   사용자 파일도 그 형태로 재작성된다. **다만 귀속은 이 모듈이 아니다** — 이 모듈을
 *   전혀 거치지 않고 손으로 쓴 패치를 같은 저장소에 `git apply` 해도 결과가 글자 그대로
 *   같았다(clone·checkout·stash pop 도 마찬가지). 내용은 보존되고 표현만 바뀐다.
 *   `-c core.autocrlf=false` 로 고치지 **않는다**: 정상적으로 CRLF 를 쓰는 사용자에게
 *   반대 방향 불일치를 만든다. 여기 적는 이유는, 이보다 작은 문제(`apply.whitespace`)
 *   에는 플래그를 넣고 이유를 길게 적어 두었는데 개행 충실도만 기재가 없어서다(M-5b).
 *   "★ 개행 표현은 저장소 설정을 따른다" 가 LF/CRLF/혼합 픽스처로 실제 값을 잰다.
 *
 * ★ **`<stateRoot>/scratch` 에 사용자의 미커밋 내용 전체가 잠시 평문으로 놓인다.** 임시
 *   인덱스와 state 패치가 그것이고, 정상 경로에서는 `finally` 가 항상 지우지만 프로세스가
 *   강제 종료되면 남는다. 리퍼는 `worktrees/` 만 보므로 그 잔재를 치우지 않는다.
 *   미커밋 변경에는 비밀(토큰·키·`.env` 편집)이 섞일 수 있다 — 즉 이 디렉터리는 사용자
 *   저장소의 미커밋 비밀이 디스크에 평문으로 남을 수 있는 자리다.
 *
 *   계획 2 Task 5 에서 배선 계층(`src/engine.mjs`)이 실행을 시작할 때 그 잔재를 치운다.
 *   리퍼를 넓히지는 않았다 — 리퍼의 판정 재료는 원장(pid + 시작 시각)인데 이 파일들은
 *   원장에 없어서, 남는 판정 재료가 **이름 모양과 나이**뿐이기 때문이다. 그래서 잔재는
 *   생겨난 뒤 다음 실행까지, 그리고 그 나이 문턱을 넘을 때까지 디스크에 남는다.
 *
 * ★ **강제 종료 뒤에 남은 워크트리를 리퍼가 끝까지 치우지 못한다**(M-2). 두 단계로
 *   막힌다(실측):
 *
 *     (A) 이 모듈은 워크트리 원장 항목을 남기지 않는다. 원장은 `reaper.mjs` 의
 *         `trackChild` 가 **자식 프로세스별로** 쓰고 exit 시 지우므로, 워크트리만
 *         남은 상태는 `sweepOrphans` 가 `{killed:[],stale:[],skipped:[]}` 로 **보지도
 *         못한다.**
 *     (B) 기록이 있어도 리퍼는 디렉터리만 `rm` 하고 **등록 해제를 하지 않는다.** 그러면
 *         등록이 `prunable` 로 남아 같은 runId 의 재사용이 git 수준에서 막힌다.
 *
 *   ★ 계획 2 Task 5 의 배선(`src/engine.mjs`)이 두 단계를 각각 다룬다:
 *
 *     (A) 원장 항목 — 엔진이 스폰하는 자식(테스트·벤더 CLI)마다 `trackChild` 에
 *         `worktree` 를 실어 올린다. 그러면 `sweepOrphans` 가 그 워크트리까지 지운다.
 *         ⚠ 원장 항목은 **자식이 살아 있는 동안만** 있다(`trackChild` 가 exit 에서
 *           지운다). 델리게이트도 테스트도 안 도는 순간에 서버가 죽으면 그 워크트리는
 *           원장에 없고, 리퍼는 여전히 보지 못한다.
 *     (B) 등록 해제 — 엔진이 실행을 시작할 때, 대상 저장소의 등록 중 **git 자신이
 *         `prunable` 이라고 말하고** 경로가 `<stateRoot>/worktrees/` 아래인 항목만
 *         `worktree remove --force` 로 뺀다. 전역 `worktree prune` 은 여전히 쓰지
 *         않는다 — 그것이 I-6 에서 제거한 파괴 경로다.
 *
 *   ⚠ 예전에는 이 잔재가 **다음 런의 전역 `worktree prune` 에 휩쓸려** 우연히 사라졌다.
 *     그 prune 이 바로 I-6 에서 제거한 파괴 경로다 — 두 결함이 서로를 가려 주고 있었고,
 *     I-6 를 고친 지금은 등록 잔재가 실제로 남는다. 그 교환은 의도한 것이다:
 *     고아 등록 하나가 사용자 워크트리의 비가역 파괴보다 낫다. 리퍼는 확장하지 않는다.
 *
 * @param {{ projectPath: string, stateRoot: string, runId: string, worktreeId?: string,
 *   purpose?: string, deps?: { run?: Function } }} spec
 *   `deps.run` 은 주입 자리다(reaper.mjs 와 같은 형태). 기본값은 하드닝된 `runGit` 이고,
 *   테스트가 특정 git 호출의 결과를 흔들어 실패 경로를 재는 데 쓴다.
 * @returns {Promise<object>} 성공하면 이후 함수들에 그대로 넘기는 핸들
 *   `{ ok: true, path, projectPath, stateRoot, runId, baseline, lastSnapshot, transplanted,
 *      ignoredPaths, sharedRules }`, 실패하면 `{ blocked: true, error, recovery }`.
 *
 *   `path`·`projectPath`·`stateRoot` 는 전부 **실체 경로**다(`canonical`). 호출자가 준
 *   문자열이 아니라 그 값을 써야 등록 조회·리퍼 판정과 좌표계가 어긋나지 않는다.
 *
 *   `ignoredPaths` 는 **이식되지 않은** 경로(무시 규칙에 걸린 것), `sharedRules` 는
 *   이식 결과를 바꿀 수 있는 공유 규칙 파일(`info/exclude`·`info/attributes`) 목록이다.
 *   둘 다 `[]` 는 "없다", `null` 은 "확인하지 못했다" — 뭉개지 마라.
 */
export async function createWorktree(spec) {
  // ★ 매개변수를 **구조분해로 받지 않는다.** `= {}` 기본값은 `undefined` 에만 걸리므로
  //   `createWorktree(null)` 은 구조분해 자리에서 TypeError 를 던졌고 — 큐 **밖**이라 —
  //   봉투가 아니라 거부된 프로미스가 나갔다. 바로 아래 주석이 "검증도 큐 안에서 한다"
  //   고 적고 있어 자기 모순이었다. Task 1 의 `runGit` 이 같은 이유로 구조분해를 버렸다.
  //   (큐 자체가 막히지는 않았다 — enqueue 의 try/catch 밖이 아니라 앞이었기 때문이다.)
  return enqueue(async () => {
    // 검증도 큐 **안**에서 한다. 본문 전체가 try/catch 안에 있어야 한다는 규칙을 지키려면
    // 큐 밖에서 던질 수 있는 코드를 두면 안 된다.
    const options = spec ?? {};
    const projectPath = options.projectPath;
    const stateRoot = options.stateRoot;
    const runId = options.runId;
    const worktreeId = options.worktreeId ?? runId;
    const purpose = options.purpose ?? null;
    const deps = options.deps ?? {};
    const run = deps.run ?? runGit;

    if (typeof projectPath !== 'string' || projectPath === '') {
      return blocked('프로젝트 경로가 비어 있습니다.', '절대 경로를 지정하세요.');
    }
    if (typeof stateRoot !== 'string' || stateRoot === '') {
      return blocked('상태 루트 경로가 비어 있습니다.', '절대 경로를 지정하세요.');
    }
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      return blocked(
        `실행 ID 가 워크트리 디렉터리 이름으로 쓸 수 없는 값입니다: ${JSON.stringify(runId)}`,
        '소문자/숫자로 시작하고 소문자·숫자·`_`·`-` 만 쓰는 64자 이내의 이름을 주세요 ' +
          '(대문자와 `.` 는 Windows 가 같은 디렉터리로 접기 때문에 받지 않습니다).',
      );
    }
    if (typeof worktreeId !== 'string' || !RUN_ID_PATTERN.test(worktreeId)) {
      return blocked(
        `워크트리 ID 가 디렉터리 이름으로 쓸 수 없는 값입니다: ${JSON.stringify(worktreeId)}`,
        'makeWorktreeId 가 만든 64자 이내의 안전한 filesystem ID 를 사용하세요.',
      );
    }
    if (purpose !== null && (typeof purpose !== 'string' || !PURPOSE_PATTERN.test(purpose))) {
      return blocked('워크트리 purpose 가 허용된 lane/evidence 용도가 아닙니다.', '정해진 lane/evidence purpose 를 사용하세요.');
    }

    // ★★ C-1. 여기서 **한 번** 실체 경로로 편 값을 이후 모든 판정·핸들에 쓴다. 아래
    //    세 판정(상태 루트가 저장소 안인가 · isSafeWorktree · 등록 조회의 경로 동일성)
    //    이 서로 다른 좌표계에서 돌면 그 어긋남이 곧 되돌릴 수 없는 삭제가 된다
    //    (`src/real-path.mjs` 의 실측을 보라). 못 펴면 fail-closed 로 거부한다.
    const realProject = await canonical(projectPath);
    const realStateRoot = await canonical(stateRoot);
    if (realProject === null || realStateRoot === null) {
      return blocked(
        `경로를 실체 경로로 확인하지 못했습니다: ${realProject === null ? projectPath : stateRoot}`,
        '경로가 존재하고 읽을 수 있는지 확인하세요. 확인하지 못한 경로에는 손대지 않습니다.',
      );
    }

    // ★ M-3. "임시 파일·워크트리는 대상 저장소 **밖**" 은 이 모듈이 확언해 온 전제인데
    //   강제되지 않았다. `BOM_ORCH_HOME` 은 **절대 경로이기만 하면** 프로젝트 안이어도
    //   통과했다. 도달성은 설정 실수만이 아니다 — 프로젝트가 `$HOME` 의 git 저장소
    //   (dotfiles)면 **기본값 `~/.bom-orch` 가 그대로 저장소 안**이다. 그러면
    //   (리뷰어 재현) 워크트리들이 서로를 보고, 이식 패치가 `.bom-orch/worktrees/…` 를
    //   담고, 최종 패치가 사용자 저장소 안에 우리 상태 루트를 써 넣는다.
    //
    //   ★ 실체 경로로 비교한다. `relative(resolve(a), resolve(b))` 는 링크를 풀지 않아서
    //     저장소 **안**을 가리키는 정션 하나로 통째로 우회됐다(리뷰어 재현: `{ok:true}`
    //     + 저장소 안에 `scratch`·`worktrees` 생성 + 사용자 저장소 status 에
    //     `?? .bom-orch/`). 그 `scratch` 는 미커밋 비밀이 평문으로 놓이는 자리다.
    //
    //   판단이 안 서는 입력은 거부가 이 모듈의 기본값이다. 우리가 대신 다른 경로를
    //   고르지 않는다 — 상태 루트는 호출자(설정)의 결정이고, 여기서 추측하면 사용자가
    //   지정하지 않은 자리에 미커밋 비밀이 평문으로 쌓인다.
    const rel = relative(realProject, realStateRoot);
    // 드라이브가 다르면 `relative` 는 **절대 경로**를 낸다(Windows) — 그건 확실히 바깥이다.
    // `rel === ''` 는 상태 루트 == 프로젝트 경로.
    const firstSegment = rel.split(/[\\/]/)[0];
    const isOutside = rel !== '' && (isAbsolute(rel) || firstSegment === '..');
    if (!isOutside) {
      return blocked(
        `상태 루트가 대상 저장소 안에 있습니다: ${realStateRoot} (프로젝트: ${realProject})`,
        'BOM_ORCH_HOME 을 프로젝트 밖의 절대 경로로 지정하세요. ' +
          '저장소 안에 두면 워크트리끼리 서로를 보고 최종 패치가 사용자 저장소에 상태 루트를 써 넣습니다.',
      );
    }

    const worktreePath = join(realStateRoot, 'worktrees', worktreeId);
    // 위 RUN_ID_PATTERN 과 이 검사는 서로 다른 축을 좁힌다: 패턴은 **문자 집합**을,
    // 이쪽은 **결과 경로**를 본다.
    //
    // 이 줄을 두는 이유는 따로 있다: 리퍼가 **정확히 이 술어**로 지울지 말지를 정한다.
    // 두 곳의 판정이 갈리는 순간 고아 워크트리가 영원히 안 지워진다. 여기서 같은 함수를
    // 부르면 그 어긋남이 생길 수 없다.
    if (!isSafeWorktree(realStateRoot, worktreePath)) {
      return blocked(
        `워크트리 경로가 상태 루트 밖을 가리킵니다: ${worktreePath}`,
        '실행 ID 에 경로 구분자나 `..` 를 넣지 마세요.',
      );
    }

    // ★ 여기부터 **본문 전체**가 try/catch 안이다. 큐의 catch 로는 부족했다: 그 catch 는
    //   `worktreePath` 를 몰라 아무것도 치우지 못하기 때문이다. 본문이 던지면(rm·mkdir 의
    //   EISDIR·EBUSY·EPERM·ENOSPC — Windows 안티바이러스 잠금이 현실적이다) 워크트리가
    //   **등록된 채** 남았고, 그러면 같은 runId 는 프로세스가 아니라 사용자 저장소 수준
    //   에서 영구히 막혔다(리뷰어 재현: retry -> "already exists"). `worktree add` 실패와
    //   봉투 실패에만 뒷정리가 붙어 있던 것이 구멍이었다.
    //
    // ★ C-3: 뒷정리는 **이번 호출이 만든 것만** 지워야 한다. 예전에는 이 catch 가 무조건
    //   `discard` 를 태웠는데, `worktree add` 가 아직 돌지도 않은 채 던진 경우(mkdir 의
    //   ENOTDIR·EPERM)에도 그 경로를 `rm -rf` 했다. 그 자리에 살아 있는 다른 런의
    //   워크트리가 있으면 통째로 사라진다. `state.owned` 는 `worktree add` 가 **성공한
    //   뒤에만** 선다 — 그때만 그 경로가 우리 것이라고 말할 수 있다.
    const state = { owned: false };
    try {
      return await createBody({
        run,
        projectPath: realProject,
        stateRoot: realStateRoot,
        runId,
        worktreeId,
        purpose,
        worktreePath,
        state,
      });
    } catch (error) {
      if (state.owned) {
        await discard({
          run,
          projectPath: realProject,
          stateRoot: realStateRoot,
          worktreePath: state.path ?? worktreePath,
        });
      }
      return blocked(
        `워크트리를 만드는 중에 예기치 못한 오류가 났습니다: ${String(error?.message ?? error)}`,
        '상태 루트 경로에 쓸 수 있는지, 디스크에 공간이 있는지 확인하세요.',
      );
    }
  });
}

/** Create a detached worktree at one immutable full commit without inspecting the user checkout. */
export async function createRevisionWorktree(spec, deps = {}) {
  return enqueue(async () => {
    const options = spec ?? {};
    const sourceWorktree = options.sourceWorktree;
    const stateRoot = options.stateRoot;
    const runId = options.runId;
    const purpose = options.purpose;
    const revision = options.revision;
    const run = deps?.run ?? runGit;

    const sourceGuard = checkHandle(sourceWorktree);
    if (sourceGuard) return sourceGuard;
    if (typeof stateRoot !== 'string' || stateRoot === '') {
      return blocked('상태 루트 경로가 비어 있습니다.', '절대 경로를 지정하세요.');
    }
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      return blocked('논리 runId 가 허용된 형식이 아닙니다.', '소문자 안전 문자로 된 1~64자 runId 를 사용하세요.');
    }
    if (typeof purpose !== 'string' || !PURPOSE_PATTERN.test(purpose)) {
      return blocked('워크트리 purpose 가 허용된 lane/evidence 용도가 아닙니다.', '정해진 lane/evidence purpose 를 사용하세요.');
    }
    if (!isFullObjectId(revision)) {
      return blocked('revision 은 full lowercase commit ID 여야 합니다.', 'Git 이 반환한 전체 commit ID 를 사용하세요.');
    }

    // Derive once. The complete logical ID remains on the handle and this projection is used only
    // for directory/registration identity.
    let worktreeId;
    try {
      worktreeId = makeWorktreeId({ runId, purpose });
    } catch (error) {
      return blocked(String(error?.message ?? error), '안전한 runId 와 정해진 purpose 를 사용하세요.');
    }

    const [realProject, realStateRoot, realSourceRoot, realSourcePath] = await Promise.all([
      canonical(sourceWorktree.projectPath),
      canonical(stateRoot),
      canonical(sourceWorktree.stateRoot),
      canonical(sourceWorktree.path),
    ]);
    if ([realProject, realStateRoot, realSourceRoot, realSourcePath].some((value) => value === null)) {
      return blocked('revision worktree 경로를 실체 경로로 확인하지 못했습니다.', '경로가 존재하고 읽을 수 있는지 확인하세요.');
    }
    if (!isSafeWorktree(realSourceRoot, realSourcePath)) {
      return blocked('sourceWorktree 가 자신의 상태 루트 밖을 가리킵니다.', 'createWorktree 가 반환한 핸들을 그대로 사용하세요.');
    }
    const rel = relative(realProject, realStateRoot);
    const firstSegment = rel.split(/[\\/]/)[0];
    const isOutside = rel !== '' && (isAbsolute(rel) || firstSegment === '..');
    if (!isOutside) {
      return blocked(
        `상태 루트가 대상 저장소 안에 있습니다: ${realStateRoot}`,
        'BOM_ORCH_HOME 을 프로젝트 밖의 절대 경로로 지정하세요.',
      );
    }

    const identity = await resolveRevisionIdentity({ run, cwd: realProject, revision, requireExact: true });
    if (identity.blocked) return identity;

    const baselineCommit = typeof sourceWorktree.baseline === 'string'
      ? sourceWorktree.baseline
      : sourceWorktree.baseline?.commit;
    if (!isFullObjectId(baselineCommit)) {
      return blocked('sourceWorktree 에 shared baseline commit 이 없습니다.', 'createWorktree 가 반환한 핸들을 사용하세요.');
    }
    const resolvedBaseline = await resolveRevisionIdentity({
      run,
      cwd: realProject,
      revision: baselineCommit,
      requireExact: true,
    });
    if (resolvedBaseline.blocked) return resolvedBaseline;
    const declaredBaseline = sourceWorktree.baselineIdentity ??
      (sourceWorktree.baseline && typeof sourceWorktree.baseline === 'object' ? sourceWorktree.baseline : null);
    if (declaredBaseline !== null && (
      declaredBaseline.commit !== resolvedBaseline.commit || declaredBaseline.tree !== resolvedBaseline.tree
    )) {
      return blocked('sourceWorktree baseline identity 가 Git object 와 일치하지 않습니다.', '오염되지 않은 worktree 핸들을 사용하세요.');
    }

    const requested = join(realStateRoot, 'worktrees', worktreeId);
    if (!isSafeWorktree(realStateRoot, requested)) {
      return blocked('revision worktree 경로가 상태 루트 밖을 가리킵니다.', '안전한 runId/purpose 를 사용하세요.');
    }
    const state = { owned: false };
    try {
      return await createBody({
        run,
        projectPath: realProject,
        stateRoot: realStateRoot,
        runId,
        worktreeId,
        purpose,
        worktreePath: requested,
        state,
        revision: identity.commit,
        transplantState: false,
        carriedBaseline: resolvedBaseline.commit,
        carriedBaselineIdentity: { commit: resolvedBaseline.commit, tree: resolvedBaseline.tree },
      });
    } catch (error) {
      if (state.owned) {
        await discard({
          run,
          projectPath: realProject,
          stateRoot: realStateRoot,
          worktreePath: state.path ?? requested,
        });
      }
      return blocked(
        `revision worktree 를 만드는 중에 예기치 못한 오류가 났습니다: ${String(error?.message ?? error)}`,
        '상태 루트 권한과 디스크 공간을 확인하세요.',
      );
    }
  });
}

/**
 * `createWorktree` 의 본문. 위에서 try/catch 로 감싸므로 여기서는 던져도 된다 —
 * 던지면 호출부가 `discard()` 를 태운 뒤 봉투로 강등한다.
 */
async function createBody({
  run,
  projectPath,
  stateRoot,
  runId,
  worktreeId,
  purpose,
  worktreePath: requested,
  state,
  revision = 'HEAD',
  transplantState = true,
  carriedBaseline = null,
  carriedBaselineIdentity = null,
}) {
  const scratch = join(stateRoot, 'scratch');
  await mkdir(join(stateRoot, 'worktrees'), { recursive: true });
  await mkdir(scratch, { recursive: true });

  // ★ 상태 루트를 편 뒤에도 `worktrees/` 나 `worktrees/<runId>` 자체가 링크일 수 있다.
  //   그러면 우리가 다루는 문자열은 상태 루트 안인데 실체는 밖이다 — `rm -rf` 가 엉뚱한
  //   곳을 지우고 등록 조회는 다시 어긋난다. 디렉터리를 만든 **뒤에** 한 번 더 펴서
  //   같은 술어로 확인한다. 못 펴거나 밖을 가리키면 fail-closed.
  const worktreePath = await canonical(requested);
  if (worktreePath === null || !isSafeWorktree(stateRoot, worktreePath)) {
    return blocked(
      `워크트리 경로의 실체가 상태 루트 밖을 가리킵니다: ${requested}`,
      '상태 루트 아래 `worktrees/` 에 다른 곳을 가리키는 링크가 걸려 있지 않은지 확인하세요.',
    );
  }

  // ★★ C-3. 이 경로가 **살아 있는 등록**인지 먼저 본다.
  //
  //   예전에는 `worktree add` 가 실패하면 무조건 `discard` 를 탔다. 그런데 실패 사유의
  //   가장 흔한 것이 "그 경로에 이미 뭔가 있다" 이고, 그 "뭔가" 가 **아직 살아서 도는
  //   다른 런의 워크트리**일 수 있다. 그러면 델리게이트 산출물 전량과 사용자의 미커밋
  //   상태가 `rm -rf` 로 사라진다(리뷰어 재현: A 의 디렉터리·산출물·등록이 전부 소멸,
  //   `collectPatch(A)` 가 BLOCKED). 봉투에는 B 의 `already exists` 뿐이라 무엇이
  //   지워졌는지 어디에도 남지 않는다.
  //
  //   그렇다고 단순히 선점만 하면 안 된다: `test/worktree.test.mjs` 의 "★ 생성이
  //   실패하면 반쯤 만들어진 워크트리를 남기지 않는다" 가 **잔재 파괴를 적극적으로
  //   단언**한다 — 앞선 런이 강제 종료되며 남긴 디렉터리의 자가 치유는 **의도된 동작**
  //   이다. 결함은 `discard` 가 잔재와 살아 있는 워크트리를 구분하지 못한다는 점이므로,
  //   두 경우를 나눈다:
  //
  //     1. 등록돼 있다 -> 다른 런이 쓰고 있다. `discard` 를 **타지 않고** 그대로 막는다.
  //     2. 등록이 없다 -> 순수 잔재. 지금까지의 자가 치유를 그대로 유지한다.
  //
  //   ★ 조회가 실패하면(`ok:false`) **모르는 것이지 없는 것이 아니다.** 그때는 아래
  //     실패 분기에서 `discard` 를 태우지 않는다 — 되돌릴 수 없는 삭제 앞에서는
  //     "우리 것임을 증명하지 못하면 손대지 않는다" 가 fail-closed 다. 고아 등록 하나가
  //     남의 산출물 파괴보다 낫다.
  //
  //   ★★ I-1. **`prunable` 은 세 번째 경우다.** git 자신이 "이 등록은 죽었다"고 말하는
  //     상태(`prunable gitdir file points to non-existent location`)를 위 1번으로 묶었더니
  //     그 runId 가 **영구히** 죽었다. 신·구 대조(실측):
  //
  //       OLD  1차 ok / 2차 BLOCKED "missing but already registered" / 3차 ok  <- 자가 치유
  //       NEW  1차 ok / 2차 BLOCKED "다른 실행이 쓰고 있습니다" / 3차 BLOCKED   <- 영구
  //
  //     봉투도 거짓이었다 — 디렉터리가 없는데 "다른 실행의 작업 결과가 들어 있을 수
  //     있다"고 존재하지 않는 데이터를 지어내고, "그 실행이 끝난 뒤 다시 시도하세요"는
  //     끝날 실행이 없으므로 틀린 안내다. 도달성도 나쁘다: `reaper.mjs` 의 부팅 스윕이
  //     디렉터리만 지우고 등록 해제를 하지 않으므로 **리퍼가 도는 것 자체가 다음 런을
  //     브릭한다.**
  //
  //     그래서 `prunable` 히트는 "순수 잔재" 와 같은 취급이다. 회수는 전역
  //     `worktree prune` 이 아니라 `worktree remove --force <우리 경로>` 로 **그 항목만**
  //     한다 — 전역 prune 은 사용자 워크트리의 관리 상태를 파괴한다(I-6).
  const before = await listRegisteredWorktrees({ run, projectPath });
  const live = before.ok ? before.entries.find((entry) => samePath(entry.path, worktreePath)) : undefined;
  if (live !== undefined && !live.prunable) {
    return blocked(
      `이 경로는 다른 실행이 쓰고 있습니다(워크트리가 등록돼 있습니다): ${worktreePath}`,
      '다른 실행 ID 를 쓰거나, 그 실행이 끝난 뒤에 다시 시도하세요. ' +
        '이 워크트리에는 다른 실행의 작업 결과가 들어 있을 수 있어 지우지 않았습니다.',
    );
  }
  if (live !== undefined) {
    // 죽은 등록을 그 항목만 회수한다. 실패하면 사실대로 막는다 — 여기서 진행하면
    // `worktree add` 가 "already registered" 로 죽고 봉투의 사유가 원인을 가린다.
    const reclaimed = await run({
      args: ['worktree', 'remove', '--force', worktreePath],
      cwd: projectPath,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    const after = await listRegisteredWorktrees({ run, projectPath });
    if (!after.ok || after.entries.some((entry) => samePath(entry.path, worktreePath))) {
      return blocked(
        `앞선 실행이 남긴 죽은 워크트리 등록을 회수하지 못했습니다: ${worktreePath} (${gitReason(reclaimed)})`,
        `대상 저장소에서 \`git worktree prune\` 을 돌리거나 다른 실행 ID 를 쓰세요.`,
      );
    }
  }

  // ★ 무엇이 "브랜치를 점유하지 않는다"를 실제로 지탱하는가 (실측 git 2.55.0.windows.3):
  //
  //     worktree add <path>                    -> basename 이름의 **새 브랜치**를 만든다
  //     worktree add <path> HEAD               -> detached (--detach 없이도)
  //     worktree add <path> <브랜치>            -> 그 브랜치를 점유한다(다른 곳에서
  //                                                체크아웃 중이면 아예 실패한다)
  //     worktree add --detach <path> <브랜치>   -> detached
  //
  //   ★ 표의 둘째·넷째 줄이 말하듯 `HEAD` 하나로도 `--detach` 하나로도 detached 가
  //     된다 — 지금 상태에서는 어느 한쪽만 빼도 결과가 같다(실측).
  //
  //     그래도 둘 다 남기는 이유는 위 표의 **셋째 줄**이다: 커밋 지정이 언젠가 브랜치
  //     이름으로 바뀌면 그 순간 사용자 브랜치를 잠근다. 그때 막는 것은 `--detach` 뿐
  //     이고, 반대로 `--detach` 만 있고 커밋 지정이 없으면 첫째 줄(새 브랜치 생성)이
  //     되살아난다.
  const created = await run({
    args: ['worktree', 'add', '-q', '--detach', worktreePath, revision],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (!created.ok) {
    // 반쯤 만들어졌을 수 있다. 등록만 남는 것이 가장 나쁘다 — 사용자 저장소의
    // worktree 목록이 더러워지고 다음 같은 ID 의 생성이 막힌다.
    //
    // ★ 위에서 "살아 있는 등록이 아니다"를 **확인했을 때만** 지운다(C-3). 조회가
    //   실패했다면 이 경로가 우리 것인지 남의 것인지 모르므로 손대지 않는다.
    //
    // ★ 그 위에 경로 문자열을 전혀 거치지 않는 프로브를 하나 더 얹는다(C-1). 등록
    //   목록과 우리 경로를 맞춰 보는 판정은 표기·링크·8.3 축을 전부 편 뒤에야 옳은데,
    //   되돌릴 수 없는 삭제 앞에서는 그 전제가 틀렸을 때의 대가가 너무 크다. git 에게
    //   **그 디렉터리 안에서 직접** 물으면 우리 좌표계가 아예 개입하지 않는다.
    if (before.ok && !(await looksLikeLinkedWorktree({ run, path: worktreePath }))) {
      await discard({ run, projectPath, stateRoot, worktreePath });
    }
    // ★ M-5. recovery 는 **실제로 관측된 원인**을 적는다. 예전 문구는 세 가지만 들었는데,
    //   Windows 예약 장치명(`nul`/`con`/`aux`/`prn`/`com1`…)이 `RUN_ID_PATTERN` 을 통과해
    //   여기로 온다(실측: `fatal: could not create directory of '.git/worktrees/nul':
    //   Invalid argument`, 잔재 없음). 실패 자체는 fail-closed 이고 손상도 없으므로
    //   코드는 그대로 두고 안내만 원인에 맞춘다.
    return blocked(
      `워크트리를 만들지 못했습니다: ${gitReason(created)}`,
      'git 저장소가 맞는지, 커밋이 최소 1개 있는지, 같은 이름의 워크트리가 남아 있지 않은지 확인하세요. ' +
        '실행 ID 가 이 운영체제에서 디렉터리 이름으로 쓸 수 있는 값인지도 보세요 ' +
        '(Windows 는 `nul`·`con`·`aux`·`prn`·`com1`~`com9`·`lpt1`~`lpt9` 를 거부합니다).',
    );
  }
  // 여기서부터 이 경로는 **우리 것**이다. 예외 경로의 뒷정리가 이 플래그를 본다.
  state.owned = true;
  state.path = worktreePath;

  if (!transplantState) {
    const identity = await resolveRevisionIdentity({ run, cwd: worktreePath, revision, requireExact: true });
    if (identity.blocked) {
      await discard({ run, projectPath, stateRoot, worktreePath });
      return identity;
    }
    return {
      ok: true,
      path: worktreePath,
      projectPath,
      stateRoot,
      runId,
      worktreeId,
      purpose,
      baseline: carriedBaseline,
      baselineIdentity: carriedBaselineIdentity,
      lastSnapshot: identity.commit,
      transplanted: false,
      ignoredPaths: [],
      sharedRules: await collectSharedRules({ run, cwd: worktreePath }),
    };
  }

  // ★ I-3. **이식 방향에도** 무시 신호를 붙인다. 이식은 무시 규칙을 존중하므로(그것이
  //   옳다 — `HARDENING_ARGS` 주석의 `core.excludesFile` 항목을 보라) 사용자의 무시된
  //   워킹트리 파일은 워크트리에 오지 않는다. 지금까지 그 사실에 신호가 하나도 없어서,
  //   "델리게이트가 사용자와 다른 환경을 본다"와 "적대적 config 가 파일을 숨겼다"를
  //   구분할 방법이 없었다. 이식 **직전** 프로젝트에서 뜬다.
  //
  //   `--ignored=matching` 은 `core.excludesFile` 이 만든 규칙도 같이 본다(실측: 적대적
  //   excludesFile 로 숨긴 `secret1.txt` 가 `!! secret1.txt` 로 나온다). 통째로 무시된
  //   디렉터리는 항목 하나로 접힌다(실측: `node_modules/` 아래 파일 5개 -> `!! node_modules/`
  //   한 줄) — 큰 저장소에서도 목록이 폭발하지 않는다.
  const ignoredPaths = await collectIgnoredPaths({ run, cwd: projectPath });
  const sharedRules = await collectSharedRules({ run, cwd: worktreePath });

  const transplanted = await transplant({ run, projectPath, worktreePath, scratch, runId: worktreeId });
  if (transplanted.blocked) {
    await discard({ run, projectPath, stateRoot, worktreePath });
    return transplanted;
  }

  // baseline: 이식까지 끝난 직후의 커밋. 이후 모든 스냅샷과 최종 패치의 기준점이다.
  // 여기서 커밋해 두어야 최종 패치에 **사용자의 미커밋 작업이 섞이지 않는다** —
  // 섞이면 사용자 저장소에 같은 변경을 두 번 적용하려 든다.
  const baseline = await commitAll({ run, worktreePath, label: `bom-orch baseline ${runId}` });
  if (baseline.blocked) {
    await discard({ run, projectPath, stateRoot, worktreePath });
    return baseline;
  }
  const baselineIdentity = await resolveRevisionIdentity({
    run,
    cwd: worktreePath,
    revision: baseline.commit,
    requireExact: true,
  });
  if (baselineIdentity.blocked) {
    await discard({ run, projectPath, stateRoot, worktreePath });
    return baselineIdentity;
  }

  return {
    ok: true,
    path: worktreePath,
    projectPath,
    stateRoot,
    runId,
    worktreeId,
    purpose,
    baseline: baseline.commit,
    baselineIdentity: { commit: baselineIdentity.commit, tree: baselineIdentity.tree },
    lastSnapshot: baseline.commit,
    transplanted: transplanted.applied,
    ignoredPaths,
    sharedRules,
  };
}

/**
 * 공유 git 디렉터리의 규칙 파일 중 **내용이 있는** 것. 없으면 `[]`, 못 보면 `null`.
 *
 * ★ I-2. `.git/info/exclude` 와 `.git/info/attributes` 는 `core.excludesFile` /
 *   `core.attributesFile` 과 같은 일을 하는데 **그것들을 가리키는 config 키가 없어서
 *   `-c` 로 막을 수 없다.** 실측(둘 다 심고 이식):
 *
 *     워크트리 파일 ['mod.txt','seed.txt']            <- app.js 가 통째로 사라졌다
 *     워크트리 mod.txt 6c696e65310d0a…                <- LF -> CRLF 로 갈아치워짐
 *     봉투는 {ok:true, transplanted:true}
 *
 *   거부하지 않는 이유: 정당한 사용이 있다(개인 무시 규칙을 커밋하지 않고 두는 것은
 *   git 이 권장하는 용법이다). 이 모듈이 이미 `ignoredPaths`/`gitlinks` 로 쓰는
 *   "사라진 것을 신고한다" 패턴에 맞춘다.
 *
 * ★ 주석과 빈 줄만 있는 파일은 세지 않는다. `git init` 은 `info/exclude` 를 **항상**
 *   주석 6줄로 만들어 두므로(실측), 존재만 보면 모든 저장소가 신고 대상이 된다.
 *
 * 경로는 git 에게 묻는다 — 대상 저장소 자신이 링크드 워크트리일 수도 있어서
 * `<projectPath>/.git` 을 가정할 수 없다. `--path-format=absolute` 가 없으면 저장소
 * 루트에서 `.git` 같은 **상대 경로**가 나온다(실측).
 */
async function collectSharedRules({ run, cwd }) {
  const got = await run({
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (!got.ok || typeof got.stdout !== 'string') return null;
  const commonDir = got.stdout.trim();
  if (commonDir === '') return null;

  const found = [];
  for (const name of ['info/exclude', 'info/attributes']) {
    const text = await readFile(join(commonDir, ...name.split('/')), 'utf8').catch(() => null);
    if (text === null) continue;
    const meaningful = text.split('\n').some((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    });
    if (meaningful) found.push(name);
  }
  return found;
}

/**
 * 사용자의 미커밋 상태(수정·삭제·미추적 신규)를 워크트리로 옮긴다.
 *
 * @returns `{ applied: boolean }` 또는 blocked 봉투.
 */
async function transplant({ run, projectPath, worktreePath, scratch, runId }) {
  const indexPath = join(scratch, `index-${runId}-${process.pid}`);
  const patchPath = join(scratch, `state-${runId}-${process.pid}.patch`);
  // 잔재가 섞이면 안 된다 — `read-tree` 는 기존 인덱스 파일 위에 얹는다. 정상 경로에서는
  // 아래 finally 가 항상 지우므로 이 줄은 **비정상 종료(프로세스 강제 종료·전원 차단)
  // 뒤의 재시도**에만 걸린다. 정상 경로에서는 관측되지 않는 예방 조치다.
  await rm(indexPath, { force: true });

  try {
    const env = { GIT_INDEX_FILE: indexPath };
    const readTree = await run({
      args: ['read-tree', 'HEAD'],
      cwd: projectPath,
      env,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!readTree.ok) {
      return blocked(
        `상태 이식용 임시 인덱스를 만들지 못했습니다: ${gitReason(readTree)}`,
        '대상 저장소의 HEAD 가 정상인지 확인하세요.',
      );
    }

    const staged = await run({ args: ['add', '-A'], cwd: projectPath, env, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!staged.ok) {
      return blocked(
        `상태 이식을 위해 로컬 변경을 모으지 못했습니다: ${gitReason(staged)}`,
        '대상 저장소에 읽을 수 없는 파일이 있는지 확인하세요.',
      );
    }

    // `--binary` 는 필수다(바이너리 변경 유실 방지). `diff` 뒤에는 runGit 이
    // `--no-ext-diff --no-textconv` 를 자동으로 끼워 넣는다.
    //
    // ★ 패치를 **git 이 파일에 직접 쓰게** 한다(`--output=`, diffToFile). 예전에는
    //   stdout(utf8 문자열)을 받아 utf8 로 다시 썼는데, 그 왕복이 NUL 없는 비 UTF-8
    //   파일(CP949·EUC-KR·Latin-1)의 바이트를 U+FFFD 로 파괴했다 — 모듈 상단의 바이트
    //   계약을 보라. 미추적 파일에서는 `ok:true`·`transplanted:true` 로 나오는 **조용히
    //   틀린 결과**였고, 추적 파일에서는 이식이 통째로 실패했다.
    const patch = await diffToFile({
      run,
      args: ['diff', '--cached', '--binary', 'HEAD'],
      cwd: projectPath,
      env,
      patchPath,
    });

    // ★ 순서가 중요하다. `ok` 를 **먼저** 본다(diffToFile 이 그 순서를 지킨다). 빈 패치를
    //   먼저 "이식할 것 없음" 으로 해석하면 diff 가 실패했을 때 조용히 옛 코드로
    //   진행한다 — 이 모듈이 막으려는 바로 그 실패다. 깨끗한 저장소(성공 + 0바이트)와
    //   실패(실패 + 0바이트)는 `ok` 말고는 구분할 수단이 없다.
    if (patch.failure) {
      return blocked(
        `상태 이식용 패치를 뜨지 못했습니다: ${gitReason(patch.failure)}`,
        '대상 저장소가 정상 상태인지 확인한 뒤 다시 시도하세요.',
      );
    }

    // ★ 함정(실측): 변경이 없으면 패치가 0 바이트이고 `git apply` 는
    //   `error: No valid patches in input` 으로 exit 128 이다. "적용 실패는 반드시
    //   중단" 을 곧이곧대로 쓰면 가장 흔한 경우인 깨끗한 저장소가 매번 막힌다.
    //   여기까지 왔다는 것은 diff 가 성공했다는 뜻이므로, 0바이트는 정말로
    //   "이식할 로컬 변경이 없음" 이다.
    if (patch.size === 0) return { applied: false };

    // ★ `--whitespace=nowarn` 은 필수다. 기본값은 대상 저장소의 `apply.whitespace` 를
    //   따르는데, 그 값은 **대상 저장소의 `.git/config`** 로 심을 수 있고(= 이 프로젝트가
    //   선언한 위협 모델) 사용자 전역 설정에도 흔하다. 실측(`apply.whitespace=fix`):
    //
    //     사용자   = "trailing   \nspace\n"
    //     워크트리 = "trailing\nspace\n"      ← 후행 공백이 사라졌다. ok=true
    //
    //   델리게이트가 사용자와 다른 내용을 보고, 최종 패치에 사용자가 요청하지 않은
    //   공백 변경이 실려 돌아간다. 하드닝의 `-c` 세 키로는 안 막힌다.
    const applied = await run({
      args: ['apply', '--whitespace=nowarn', patchPath],
      cwd: worktreePath,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!applied.ok) {
      // 여기서 조용히 넘어가면 워크트리에 옛 코드만 남고 델리게이트가 그것을 고친다.
      // 그 결과 패치가 사용자 저장소에 적용되면 사용자의 미커밋 작업을 덮어쓴다.
      return blocked(
        `사용자의 미커밋 변경을 워크트리로 이식하지 못했습니다(패치 적용 실패): ${gitReason(applied)}`,
        '변경을 커밋하거나 스태시한 뒤 다시 시도하세요. 이식 없이 진행하면 델리게이트가 옛 코드를 고치게 됩니다.',
      );
    }
    return { applied: true };
  } finally {
    // 임시 인덱스와 패치는 상태 루트에 쌓이면 안 된다. 지우지 못해도 진행한다 —
    // 다음 실행은 같은 경로를 `rm(force)` 로 먼저 치운다.
    await rm(indexPath, { force: true }).catch(() => {});
    await rm(patchPath, { force: true }).catch(() => {});
  }
}

/**
 * 워크트리의 현재 상태를 detached HEAD 에 커밋한다. 변경이 없으면 커밋하지 않는다.
 *
 * ★ 판정에 `status --porcelain` 을 **쓰지 않는다.** `status` 는 `add -A` + `commit` 의
 *   결과와 동치가 아니고, 두 방향으로 어긋난다. 실측된 두 축:
 *
 *   (A) status 는 비지 않았는데 스테이징될 것이 없다 — 델리게이트가 중첩 저장소 **안**을
 *       수정한 경우.
 *         워크트리 status: " M sub\n?? top.txt"
 *         step1 -> ok (top.txt 만 커밋)
 *         step2 -> status 는 " M sub" 로 여전히 더러운데 `add -A` 가 스테이징하는 것이
 *                  없어 `commit` 이 exit 1 -> **영구 실패**. " M sub" 는 사라지지 않으므로
 *                  그 실행의 남은 스텝이 전부 막힌다.
 *
 *   (B) status 는 비었는데 스테이징될 것이 있다 — 저장소가 `status.showUntrackedFiles=no`
 *       를 쓰는 경우. 그러면 **델리게이트가 만든 신규 파일 전부**가 status 에서 사라진다.
 *         [showUntrackedFiles = no]                    [normal 대조군]
 *          step1   {ok:true, changed:false, diffLen:0}  {ok:true, changed:true, diffLen:144}
 *          collect files ["feature.txt","notes.txt"]    files ["feature.txt"]
 *          apply   exit 1 (notes.txt already exists)    ok
 *       `ok:true`·`changed:false`·빈 diff 라 호출자가 검출할 방법이 없는 **조용히 틀린
 *       결과**이고, baseline 이 안 찍히면 최종 패치에 사용자의 미커밋 작업이 섞여
 *       왕복 전량이 실패한다. `HARDENING_ARGS` 는 `core.*` 뿐이라 이 키에 닿지 않는다.
 *
 *   두 축 다 판정 재료를 바꿔서 닫는다: `add -A` **뒤에** `diff --cached --quiet HEAD` 로
 *   실제로 스테이징된 변경이 있는지 본다(실측: 변경 없음 -> exit 0, 있음 -> exit 1).
 *   없으면 커밋을 건너뛰고 현재 HEAD 를 돌려준다. 깨끗한 워크트리의 동작은 같고 추가
 *   비용은 `add -A` 한 번이다.
 *
 *   ★ exit 0 일 때만 건너뛴다. 0 도 1 도 아닌 종료 코드(128 등)는 "변경 없음"이 아니라
 *     **판정 실패**이므로 커밋을 시도한다 — 조용히 건너뛰면 델리게이트의 작업이 스냅샷
 *     에서 사라지고, 시도하면 최소한 시끄럽게 실패한다.
 *
 *   또 하나의 방향(status 도 비고 스테이징될 것도 없는데 HEAD 는 움직인 경우 =
 *   델리게이트 자신의 커밋)은 여기서 못 닫는다 — 그쪽은 `snapshotStep` 이 `changed` 가
 *   아니라 **커밋 해시**를 보고 판정한다. 이 함수는 그 경우 정확한 현재 HEAD 를
 *   돌려주는 것으로 충분하다.
 *
 * @returns `{ commit, changed }` 또는 blocked 봉투. **`changed` 는 "우리가 커밋을
 *   찍었다"이지 "워크트리가 baseline 과 다르다"가 아니다** — 호출자는 기준점 이동을
 *   `commit` 해시로 판단해야 한다.
 */
async function commitAll({ run, worktreePath, label }) {
  const head = async () => {
    const got = await run({ args: ['rev-parse', '--verify', 'HEAD'], cwd: worktreePath, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!got.ok) {
      return blocked(`워크트리의 HEAD 를 읽지 못했습니다: ${gitReason(got)}`, '워크트리가 아직 있는지 확인하세요.');
    }
    return got.stdout.trim();
  };

  const staged = await run({ args: ['add', '-A'], cwd: worktreePath, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!staged.ok) {
    return blocked(`워크트리의 변경을 모으지 못했습니다: ${gitReason(staged)}`, '워크트리 파일 권한을 확인하세요.');
  }

  // ★ 유일한 판정 게이트다(위 함수 주석의 (A)·(B)). status 가 아니라 **실제로
  //   스테이징된 것**을 본다. exit 0 = 스테이징된 변경 없음.
  const pending = await run({
    args: ['diff', '--cached', '--quiet', 'HEAD'],
    cwd: worktreePath,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (pending.ok) {
    const commit = await head();
    return typeof commit === 'string' ? { commit, changed: false } : commit;
  }

  // 저자는 env 로만 준다: 선행 `-c` 는 runGit 이 거부하고, 사용자 전역 설정을 우리가
  // 건드릴 수는 없다. 실측: user.name/user.email 이 없는 저장소에서는 이것이 없으면
  // `commit` 이 exit 128 "Author identity unknown" 으로 죽는다.
  //
  // `--no-verify` 는 runGit 의 `core.hooksPath=<빈 디렉터리>` 와 겹친다 — 그쪽이 이미
  // 저장소의 hook 을 무력화하므로 이 플래그만 빼도 관측되는 동작은 같다(실측).
  //
  // ★ `--no-gpg-sign` 은 겹치는 층이 없어 **단독으로 필요한 플래그다.** `commit.gpgsign`
  //   이 켜져 있으면(대상 저장소 `.git/config` 한 줄로도, 흔한 전역 설정으로도 성립한다)
  //   위 `COMMIT_IDENTITY` 가 신원을 `bom-orch@localhost` 로 고정하기 때문에 **서명 키를
  //   실제로 가진 사용자라도 그 신원의 키가 없어 항상 실패한다.** 실측:
  //
  //     commit --no-verify                 -> exit 128 "gpg failed to sign the data:
  //                                            gpg: skipped … No secret key"
  //     commit --no-verify --no-gpg-sign   -> exit 0
  //
  //   재시도로 안 풀리는 영구 하드 블록이고 봉투의 recovery("다시 시도하세요")가 틀린
  //   안내가 된다. 하드닝의 `-c` 키는 `core.*` 뿐이라 여기 닿지 않는다. 서브커맨드 뒤라
  //   스크리닝과 무관하고, 워크트리 내부 전용 커밋이라 사용자에게 보이는 회귀도 없다.
  const committed = await run({
    args: ['commit', '-qm', label, '--no-verify', '--no-gpg-sign'],
    cwd: worktreePath,
    env: COMMIT_IDENTITY,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (!committed.ok) {
    return blocked(
      `워크트리 스냅샷 커밋에 실패했습니다: ${gitReason(committed)}`,
      '워크트리가 정상 상태인지 확인한 뒤 다시 시도하세요.',
    );
  }

  const commit = await head();
  return typeof commit === 'string' ? { commit, changed: true } : commit;
}

/**
 * 실패 경로의 뒷정리. 등록·디렉터리·잔재를 순서대로 치운다. 절대 던지지 않는다.
 *
 * ★ `timeoutMs` 를 준다. `WORKTREE_TIMEOUT_MS` 를 도입한 근거("큰 저장소는 30초를
 *   넘긴다")는 `worktree remove --force`(= 전체 삭제)에도 그대로 적용되는데 여기만 기본
 *   30초였다. 뒷정리가 타임아웃으로 끊기면 정확히 이 함수가 막으려던 상태 — 등록만 남은
 *   워크트리 — 가 된다.
 *
 * @returns `{ removed, unregistered }` — 실제로 관측한 결과다(M-1). `unregistered` 는
 *   등록 조회 자체가 실패하면 `null`(= 모름)이다. 봉투가 사실과 달라서는 안 된다.
 */
async function discard({ run, projectPath, stateRoot, worktreePath }) {
  const removal = await run({
    args: ['worktree', 'remove', '--force', worktreePath],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  // ★ 경로 검사 없이 rm 을 걸면 안 된다 — 리퍼가 정확히 그 사고를 냈다(기록의 경로가
  //   상태 루트를 가리켜 상태 루트가 통째로 날아갔다).
  //
  //   ★ 이 검사는 **공개 API 로는 거짓이 되게 만들 수 없다.** `discard` 로 들어오는
  //     `worktreePath` 는 두 자리 모두 `join(<편 stateRoot>, 'worktrees',
  //     <RUN_ID_PATTERN 을 통과한 runId>)` 을 `canonical` 로 한 번 더 편 값이거나,
  //     `removeWorktree` 의 앞선 검사를 이미 지난 값이다.
  //
  //     그럼에도 남기는 이유는 하나뿐이다: `rm(recursive, force)` 는 되돌릴 수 없고,
  //     이 함수는 앞으로 다른 호출자가 생길 수 있는 내부 헬퍼다.
  if (isSafeWorktree(stateRoot, worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }

  // ★★ I-6. 여기 있던 **무조건 전역 `git worktree prune`** 은 사용자 저장소의 다른
  //    워크트리 관리 상태를 영구히 파괴했다 — 그것도 **정상 종료 경로**에서.
  //
  //    사용자 워크트리의 경로가 잠깐 안 보이면(네트워크 드라이브·언마운트·이름 변경)
  //    git 은 그 등록을 prunable 로 보고, 전역 prune 이 `.git/worktrees/<id>/` 를
  //    통째로 지운다. 그 안에는 그 워크트리의 index(스테이징해 둔 내용)·HEAD·ORIG_HEAD·
  //    reflog·`refs/bisect` 가 들어 있다. 직접 재확인한 격리 실험:
  //
  //      remove --force <우리 경로> 만  -> admin ["feature-x"]   (사용자 것 살아남음)
  //      그 뒤 worktree prune           -> admin <ENOENT>        (통째로 사라짐)
  //      경로 복귀 후 worktree repair   -> code 0 이지만 복구되지 않는다
  //      사용자 워크트리에서 status     -> 128 fatal: not a git repository
  //
  //    "git 이 gc 때 어차피 prune 한다"는 반박도 실측으로 기각됐다:
  //      git gc --prune=now -> admin ["feature-y"]  (사용자 워크트리 admin 을 남긴다)
  //    명시적 `worktree prune` 은 `--expire` 를 TIME_MAX 로 두는 반면 gc 는
  //    `gc.worktreePruneExpire`(기본 3개월)를 지키기 때문이다. 즉 **우리 코드가 git
  //    자신보다 엄격히 더 파괴적이었다.** 이 함수의 주석은 `rm` 경로 안전성만 길게
  //    논했는데, 정작 상태 루트 **밖**에 손을 대는 유일한 줄이 여기였다.
  //
  //    ① `worktree remove --force` 가 성공했으면 등록은 이미 정확히 빠졌다(위 실험의
  //       첫 줄) — prune 을 **건너뛴다**.
  //    ② 실패해서 등록만 남은 경우에만, prunable 항목이 **우리 것 하나뿐**임을 확인하고
  //       나서 돈다. 남의 prunable 이 하나라도 있으면 포기하고 우리 등록을 남긴다 —
  //       고아 등록 하나가 사용자 워크트리 파괴보다 낫다.
  let listed = null;
  if (removal?.ok !== true) {
    listed = await listRegisteredWorktrees({ run, projectPath });
    if (listed.ok) {
      const stillRegistered = listed.entries.some((entry) => samePath(entry.path, worktreePath));
      const prunables = listed.entries.filter((entry) => entry.prunable);
      const onlyOurs = prunables.length === 1 && samePath(prunables[0].path, worktreePath);
      if (stillRegistered && onlyOurs) {
        await run({ args: ['worktree', 'prune'], cwd: projectPath, timeoutMs: WORKTREE_TIMEOUT_MS }).catch(() => {});
        listed = null; // 상태가 바뀌었으므로 아래에서 다시 관측한다.
      }
    }
  }

  // ★ M-1. 결과를 **관측해서** 돌려준다. 예전에는 `discard` 안의 `run`·`rm` 이 전부
  //   `.catch(() => {})` 라 `removeWorktree` 가 무슨 일이 있어도 `{ok:true}` 를 냈다.
  //   실행 중인 exe 이미지가 워크트리에 남아 있으면(델리게이트가 테스트를 돌리다 남긴
  //   바이너리 — 억지 상황이 아니다) 디렉터리가 그대로인데도 봉투는 성공이었다.
  const removed = await stat(worktreePath).then(() => false, () => true);
  const after = listed ?? (await listRegisteredWorktrees({ run, projectPath }));
  const unregistered = after.ok ? !after.entries.some((entry) => samePath(entry.path, worktreePath)) : null;
  return { removed, unregistered };
}

// ── 스텝 스냅샷 ───────────────────────────────────────────────────────────

/**
 * 쓰기 스텝이 끝날 때마다 워크트리의 detached HEAD 에 커밋을 쌓고, **그 스텝만의**
 * diff 를 낸다.
 *
 * ★ baseline 하나로 매 스텝 diff 를 뜨면 스텝 1..N-1 의 변경이 스텝 N 에 오귀속된다
 *   (§5.7). 학습 신호가 통째로 망가지는 자리다. 그래서 스텝 N 의 diff 는
 *   `<스냅샷 N-1>..<스냅샷 N>` 이고, baseline 대비는 최종 aggregate 에서만 쓴다.
 *
 * 핸들의 `lastSnapshot` 을 갱신한다.
 *
 * @returns `{ ok: true, label, commit, previous, changed, diff, files }` 또는 blocked 봉투.
 *   `diff` 는 **Buffer** 다(모듈 상단의 바이트 계약). `files` 는 그 스텝이 건드린 경로
 *   목록이고, `collectPatch().files` 와 같은 규칙으로 뜬다 — 모듈 상단의 "무엇이
 *   바뀌었는지는 `files` 에서만 읽어라" 를 보라. 기준점이 안 움직였으면 `[]` 다.
 */
export async function snapshotStep(wt, label, deps = {}) {
  const run = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;

  const text = typeof label === 'string' && label !== '' ? label : '(이름 없는 스텝)';
  const previous = wt.lastSnapshot;

  const result = await commitAll({ run, worktreePath: wt.path, label: text });
  if (result.blocked) return result;

  // ★ I-4 (A). `result.changed`(= 우리가 커밋을 찍었는가)가 아니라 **커밋 해시가
  //   움직였는가**로 판정한다.
  //
  //   무엇이 열려 있었나: 델리게이트가 워크트리 안에서 스스로 `git commit` 을 하면
  //   (코딩 CLI 의 일상이다 — 이 모듈의 전제 자체가 "델리게이트의 셸은 제한되지
  //   않는다"이다) status 는 비고 HEAD 는 움직여 있다. 그러면 `commitAll` 이
  //   `changed:false` 로 조기 반환하고 `lastSnapshot` 이 낡은 값에 머문 채 스텝이
  //   "변경 없음"으로 기록됐다. **다음** 스텝이 그 낡은 기준으로 diff 를 떠서 앞 스텝의
  //   작업을 자기 것으로 보고했다 — `ok:true` 로 나오는 조용한 오귀속이다.
  //   망가지는 것은 §5.7 이 스냅샷을 두는 유일한 이유인 스텝별 학습 신호다.
  //
  //   `commitAll` 은 커밋을 안 찍었을 때도 **현재 HEAD** 를 돌려주므로 추가 git 호출이
  //   필요 없다. 이 판정은 `changed` 를 보는 것보다 넓다: 우리 커밋도, 델리게이트의
  //   커밋도, `reset`/`cherry-pick` 같은 다른 이동도 전부 기준점을 올린다.
  const moved = result.commit !== previous;
  if (!moved) {
    return { ok: true, label: text, commit: previous, previous, changed: false, diff: Buffer.alloc(0), files: [] };
  }

  // ★ 커밋이 찍혔으면 **그 즉시** 기준점을 올린다. diff 보다 뒤에 두었을 때 무슨 일이
  //   났는가: 커밋은 이미 됐는데 diff 가 실패하면 `lastSnapshot` 이 낡은 값에 머문 채
  //   blocked 가 나갔고, 다음 스텝이 그 낡은 기준으로 diff 를 떠서 **앞 스텝의 변경을
  //   자기 것으로 보고**했다 — 이 함수가 막으려는 오귀속 그 자체인데 이번엔 `ok:true` 로
  //   조용히 나온다(리뷰어 재현: step2 diff 가 s1.txt 를 포함). 커밋은 되돌릴 수 없으니
  //   기록도 되돌리지 않는 것이 맞다.
  wt.lastSnapshot = result.commit;

  const diff = await diffToBytes({
    run,
    args: ['diff', '--binary', previous, result.commit],
    cwd: wt.path,
    stateRoot: wt.stateRoot,
    tag: `step-${result.commit.slice(0, 12)}`,
  });
  if (diff.failure) {
    return blocked(
      `스텝 스냅샷의 diff 를 뜨지 못했습니다: ${gitReason(diff.failure)}`,
      '워크트리가 정상 상태인지 확인하세요.',
    );
  }
  if (diff.crashed) {
    return blocked(
      `스텝 스냅샷의 diff 를 읽지 못했습니다: ${String(diff.crashed?.message ?? diff.crashed)}`,
      '상태 루트 경로에 쓸 수 있는지, 디스크에 공간이 있는지 확인하세요.',
    );
  }

  // 이 스텝이 건드린 경로. `collectPatch` 와 같은 명령 계열·같은 플래그를 쓴다
  // (`-z` 라 인용이 없고, `--no-renames` 라 이동의 원본과 대상이 둘 다 들어온다).
  // 패치 본문에서 경로를 긁지 않는 이유는 모듈 상단의 계약에 있다.
  //
  // 실패하면 **blocked** 다. 빈 배열로 떨어뜨리면 "이 스텝은 아무것도 안 건드렸다" 가
  // 되어, 이 목록을 재료로 삼는 스텝별 스코프 검사와 베리파이어 몰래 고치기 탐지가
  // 조용히 통과한다 — `collectPatch` 의 같은 자리와 같은 근거다.
  const names = await run({
    args: ['diff', '--name-only', '-z', '--no-renames', previous, result.commit],
    cwd: wt.path,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (!names.ok) {
    return blocked(
      `스텝 스냅샷의 파일 목록을 뜨지 못했습니다: ${gitReason(names)}`,
      '워크트리가 정상 상태인지 확인하세요. 목록 없이는 이 스텝이 무엇을 건드렸는지 검증할 수 없습니다.',
    );
  }

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

async function canonicalHandle(wt) {
  const guard = checkHandle(wt);
  if (guard) return guard;
  const [stateRoot, path, projectPath] = await Promise.all([
    canonical(wt.stateRoot),
    canonical(wt.path),
    canonical(wt.projectPath),
  ]);
  if (stateRoot === null || path === null || projectPath === null || !isSafeWorktree(stateRoot, path)) {
    return blocked(
      '워크트리 핸들의 경로를 안전한 실체 경로로 확인하지 못했습니다.',
      'createWorktree/createRevisionWorktree 가 반환한 핸들을 그대로 사용하세요.',
    );
  }
  return { ok: true, stateRoot, path, projectPath };
}

/** Resolve one full commit ID and its tree through hardened Git. */
export async function revisionIdentity(wt, revision, deps = {}) {
  const paths = await canonicalHandle(wt);
  if (paths.blocked) return paths;
  return resolveRevisionIdentity({
    run: deps?.run ?? runGit,
    cwd: paths.path,
    revision,
    requireExact: true,
  });
}

/**
 * Return NUL-authoritative, no-renames delta entries. Exact entry shape:
 * `{ path, status, oldMode, newMode }` where status is added/modified/deleted.
 */
export async function listRevisionDelta(wt, spec, deps = {}) {
  const paths = await canonicalHandle(wt);
  if (paths.blocked) return paths;
  const revisions = validateRevisionPair(spec);
  if (!revisions.ok) return blocked(revisions.error, 'full revision 과 안전한 저장소 상대 경로를 사용하세요.');
  const run = deps?.run ?? runGit;
  const authenticated = await authenticateRevisionPair({ run, cwd: paths.path, revisions });
  if (authenticated.blocked) return authenticated;
  if (authenticated.paths !== null && authenticated.paths.length === 0) return { ok: true, entries: [] };
  const result = await run({
    args: revisionDiffArgs({ ...authenticated, raw: true }),
    cwd: paths.path,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  if (!result?.ok) {
    return blocked(
      `revision delta 목록을 뜨지 못했습니다: ${gitReason(result)}`,
      'revision object 와 워크트리가 정상인지 확인하세요.',
    );
  }
  const parsed = parseRawRevisionDelta(result.stdout);
  if (!parsed.ok) return blocked(parsed.error, '경로 또는 mode 를 추측하지 않고 안전하게 중단했습니다.');
  if (authenticated.paths !== null) {
    const literals = new Set(authenticated.paths);
    const unexpected = parsed.entries.find((entry) => !literals.has(entry.path));
    if (unexpected !== undefined) {
      return blocked(
        `Git 이 literal allowlist 와 정확히 다른 경로를 반환했습니다: ${JSON.stringify(unexpected.path)}`,
        '대소문자 별칭이 아닌 Git 이 반환한 정확한 저장소 경로를 사용하세요.',
      );
    }
  }
  return parsed;
}

/** Collect immutable binary patch bytes from a commit pair without touching the current index. */
export async function collectPatchAtRevision(wt, spec, deps = {}) {
  const paths = await canonicalHandle(wt);
  if (paths.blocked) return paths;
  const revisions = validateRevisionPair(spec);
  if (!revisions.ok) return blocked(revisions.error, 'full revision 과 안전한 저장소 상대 경로를 사용하세요.');
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
    tag: `revision-${revisions.to.slice(0, 12)}`,
  });
  if (patch.failure) {
    return blocked(
      `revision patch 를 뜨지 못했습니다: ${gitReason(patch.failure)}`,
      'revision object 와 워크트리가 정상인지 확인하세요.',
    );
  }
  if (patch.crashed) {
    return blocked(
      `revision patch bytes 를 읽지 못했습니다: ${String(patch.crashed?.message ?? patch.crashed)}`,
      '상태 루트 권한과 디스크 공간을 확인하세요.',
    );
  }
  const files = delta.entries.map((entry) => entry.path);
  return {
    ok: true,
    patch: patch.bytes,
    files,
    sha256: createHash('sha256').update(patch.bytes).digest('hex'),
    empty: patch.bytes.length === 0,
  };
}

async function locateIndex({ run, cwd }) {
  const [gitDirResult, indexResult] = await Promise.all([
    run({ args: ['rev-parse', '--absolute-git-dir'], cwd, timeoutMs: WORKTREE_TIMEOUT_MS }).catch(() => null),
    run({
      args: ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null),
  ]);
  if (!gitDirResult?.ok || !indexResult?.ok) return null;
  const [gitDir, indexPath] = await Promise.all([
    canonical(gitDirResult.stdout.trim()),
    canonical(indexResult.stdout.trim()),
  ]);
  if (gitDir === null || indexPath === null || !samePath(dirname(indexPath), gitDir)) return null;
  const bytes = await readFile(indexPath).catch(() => null);
  return bytes === null ? null : { gitDir, indexPath, bytes };
}

async function restoreAppliedWorktree({ run, cwd, original, savedIndex }) {
  const reset = await run({
    args: ['reset', '--hard', '-q', original.commit],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  const cleaned = await run({
    args: ['clean', '-fdx', '-q'],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  if (!reset?.ok || !cleaned?.ok) return false;

  // reset reconstructs a semantically equal index but can change stat-cache bytes. Restore the exact
  // pristine index only after proving Git put HEAD/worktree back, and revalidate its canonical owner.
  const currentIndex = await locateIndex({ run, cwd });
  if (currentIndex === null || !samePath(currentIndex.gitDir, savedIndex.gitDir) || !samePath(currentIndex.indexPath, savedIndex.indexPath)) {
    return false;
  }
  try {
    await writeFile(currentIndex.indexPath, savedIndex.bytes);
  } catch {
    return false;
  }
  const [identity, status] = await Promise.all([
    resolveRevisionIdentity({ run, cwd, revision: original.commit, requireExact: true }),
    run({
      args: ['status', '--porcelain', '-z', '--ignored=matching'],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null),
  ]);
  return identity.ok === true && identity.commit === original.commit && identity.tree === original.tree && status?.ok === true && status.stdout === '';
}

/** Verify and apply raw patch bytes only inside a pristine isolated revision worktree. */
export async function applyPatchBytes(wt, spec, deps = {}) {
  const options = spec ?? {};
  const patch = options.patch;
  const expectedSha = options.sha256;
  if (!Buffer.isBuffer(patch)) {
    return blocked('적용할 patch 는 raw Buffer 여야 합니다.', 'binary patch bytes 를 그대로 전달하세요.');
  }
  if (typeof expectedSha !== 'string' || !SHA256_PATTERN.test(expectedSha)) {
    return blocked('patch sha256 은 full lowercase 64-hex 여야 합니다.', '수집 시 반환된 sha256 을 사용하세요.');
  }
  const actualSha = createHash('sha256').update(patch).digest('hex');
  if (actualSha !== expectedSha) {
    return blocked('patch SHA-256 이 전달된 값과 일치하지 않습니다.', 'patch bytes 와 sha256 을 같은 수집 결과에서 사용하세요.');
  }

  const paths = await canonicalHandle(wt);
  if (paths.blocked) return paths;
  const run = deps?.run ?? runGit;
  const original = await resolveRevisionIdentity({ run, cwd: paths.path, revision: 'HEAD', requireExact: false });
  if (original.blocked) return original;
  const pristine = await run({
    args: ['status', '--porcelain', '-z', '--ignored=matching'],
    cwd: paths.path,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  if (!pristine?.ok || pristine.stdout !== '') {
    return blocked('patch 적용 대상 revision worktree 가 pristine 상태가 아닙니다.', '새 revision worktree 를 만들어 다시 시도하세요.');
  }
  const savedIndex = await locateIndex({ run, cwd: paths.path });
  if (savedIndex === null) {
    return blocked('워크트리 index 를 안전한 canonical 경로로 확인하지 못했습니다.', '워크트리를 새로 만든 뒤 다시 시도하세요.');
  }
  if (patch.length === 0) return original;

  const scratchRequested = join(paths.stateRoot, 'scratch');
  let scratch;
  let operationPath;
  let patchPath;
  let indexPath;
  let operationOwned = false;
  let actualStarted = false;
  let successfulIdentity = null;
  try {
    await mkdir(scratchRequested, { recursive: true });
    scratch = await canonical(scratchRequested);
    const scratchRel = scratch === null ? null : relative(paths.stateRoot, scratch);
    if (scratch === null || scratchRel === '' || scratchRel.startsWith('..') || isAbsolute(scratchRel)) {
      return blocked('scratch 경로의 실체가 상태 루트 밖을 가리킵니다.', '상태 루트의 scratch 링크를 제거하세요.');
    }
    // A private directory makes every child ours and makes the path unpredictable before mkdtemp
    // succeeds. Never derive a shared `<pid>-<seq>.lock` name that a foreign file can pre-occupy.
    operationPath = await mkdtemp(join(scratch, 'apply-'));
    operationOwned = true;
    const realOperation = await canonical(operationPath);
    const operationRel = realOperation === null ? null : relative(scratch, realOperation);
    if (realOperation === null || operationRel === '' || operationRel.startsWith('..') || isAbsolute(operationRel)) {
      return blocked('apply 전용 scratch 경로의 실체를 증명하지 못했습니다.', '상태 루트의 scratch 링크를 제거하세요.');
    }
    operationPath = realOperation;
    patchPath = join(operationPath, 'patch');
    indexPath = join(operationPath, 'index');
    await writeFile(patchPath, patch, { flag: 'wx' });
    const tempEnv = { GIT_INDEX_FILE: indexPath };
    const readTree = await run({
      args: ['read-tree', original.commit],
      cwd: paths.path,
      env: tempEnv,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!readTree.ok) {
      return blocked(`patch preflight index 를 만들지 못했습니다: ${gitReason(readTree)}`, '워크트리와 scratch 권한을 확인하세요.');
    }
    const preflightApply = await run({
      args: ['apply', '--cached', '--whitespace=nowarn', patchPath],
      cwd: paths.path,
      env: tempEnv,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!preflightApply.ok) {
      return blocked(`patch preflight 가 거부했습니다: ${gitReason(preflightApply)}`, 'revision 에 정확히 맞는 안전한 patch 를 사용하세요.');
    }
    const raw = await run({
      args: ['diff', '--cached', '--no-patch', '--raw', '-z', '--no-abbrev', '--no-renames', original.commit],
      cwd: paths.path,
      env: tempEnv,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!raw.ok) {
      return blocked(`patch 경로/mode preflight 를 읽지 못했습니다: ${gitReason(raw)}`, '워크트리가 정상인지 확인하세요.');
    }
    const delta = parseRawRevisionDelta(raw.stdout);
    if (!delta.ok || delta.entries.length === 0) {
      return blocked(delta.ok ? 'patch 가 파일 delta 를 만들지 않습니다.' : delta.error, '일반 파일만 든 non-empty patch 를 사용하세요.');
    }
    const materialization = validateMaterializationPaths(delta.entries.map((entry) => entry.path));
    if (!materialization.ok) {
      return blocked(materialization.error, '모든 플랫폼에서 한 파일로만 해석되는 일반 경로만 적용하세요.');
    }
    const expectedTreeResult = await run({
      args: ['write-tree'],
      cwd: paths.path,
      env: tempEnv,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    const expectedTree = expectedTreeResult?.ok && typeof expectedTreeResult.stdout === 'string'
      ? expectedTreeResult.stdout.trim()
      : '';
    if (!isFullObjectId(expectedTree)) {
      return blocked(`patch preflight tree 를 만들지 못했습니다: ${gitReason(expectedTreeResult)}`, '워크트리가 정상인지 확인하세요.');
    }

    actualStarted = true;
    const applied = await run({
      args: ['apply', '--index', '--whitespace=nowarn', patchPath],
      cwd: paths.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!applied.ok) {
      const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
      if (!restored) {
        return blocked('patch 적용 실패 뒤 워크트리 복구를 증명하지 못했습니다.', '이 worktree 를 격리하고 새 revision worktree 를 만드세요.');
      }
      return blocked(`patch 를 적용하지 못했습니다: ${gitReason(applied)}`, 'revision 과 patch 가 정확히 일치하는지 확인하세요.');
    }
    const committed = await commitAll({ run, worktreePath: paths.path, label: `bom-orch apply ${actualSha.slice(0, 12)}` });
    if (committed.blocked) {
      const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
      if (!restored) {
        return blocked('patch commit 실패 뒤 워크트리 복구를 증명하지 못했습니다.', '이 worktree 를 격리하고 새 revision worktree 를 만드세요.');
      }
      return committed;
    }
    const identity = await resolveRevisionIdentity({ run, cwd: paths.path, revision: committed.commit, requireExact: true });
    if (identity.blocked) {
      const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
      if (!restored) {
        return blocked('적용 결과 identity 실패 뒤 워크트리 복구를 증명하지 못했습니다.', '이 worktree 를 격리하고 새 revision worktree 를 만드세요.');
      }
      return identity;
    }
    const clean = await run({
      args: ['status', '--porcelain', '-z', '--ignored=matching'],
      cwd: paths.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    if (identity.tree !== expectedTree || !clean?.ok || clean.stdout !== '') {
      const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
      if (!restored) {
        return blocked('patch 결과 검증 실패 뒤 워크트리 복구를 증명하지 못했습니다.', '이 worktree 를 격리하고 새 revision worktree 를 만드세요.');
      }
      return blocked('patch commit 이 preflight tree 전체를 정확히 담지 못했습니다.', '저장소 filter/ignore 설정을 확인하세요.');
    }
    successfulIdentity = identity;
    return identity;
  } catch (error) {
    if (actualStarted) {
      const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex }).catch(() => false);
      if (!restored) {
        return blocked('patch 처리 예외 뒤 워크트리 복구를 증명하지 못했습니다.', '이 worktree 를 격리하고 새 revision worktree 를 만드세요.');
      }
    }
    return blocked(`patch bytes 를 처리하지 못했습니다: ${String(error?.message ?? error)}`, 'scratch 권한과 디스크 공간을 확인하세요.');
  } finally {
    if (operationOwned) await rm(operationPath, { recursive: true, force: true }).catch(() => {});
    const operationRemoved = !operationOwned || await absenceProven(operationPath);
    if (!operationRemoved) {
      const restored = !actualStarted || await restoreAppliedWorktree({
        run,
        cwd: paths.path,
        original,
        savedIndex,
      }).catch(() => false);
      return blocked(
        restored
          ? 'patch scratch 정리에 실패해 적용 결과를 되돌렸습니다.'
          : 'patch scratch 정리 실패 뒤 워크트리 복구를 증명하지 못했습니다.',
        restored
          ? '잠긴 scratch 파일을 정리한 뒤 새 revision worktree 에서 다시 시도하세요.'
          : '이 worktree 를 격리하고 새 revision worktree 를 만드세요.',
      );
    }
    if (successfulIdentity !== null) wt.lastSnapshot = successfulIdentity.commit;
  }
}

// ── 최종 패치 ─────────────────────────────────────────────────────────────

/**
 * baseline 대비 워크트리의 변경을 하나의 패치로 뽑는다.
 *
 * ★ **"전체" 가 아니다.** 예전 문장은 "baseline 대비 워크트리의 **전체** 변경"이라고
 *   확언했는데 거짓이다 — `add -A` 는 무시 규칙을 존중하고 gitlink 경계에서 멈춘다.
 *   실제로 빠지는 것과 그때 봉투에 실리는 신호는 이렇다:
 *
 *     저장소가 커밋한 `.gitignore` 에 걸린 파일  -> `ignoredPaths`
 *     gitlink(중첩 저장소·서브모듈) 안의 내용     -> `gitlinks`
 *     인덱스에만 있는 모드 변경                   -> 아래 '알려진 한계'
 *
 *   그래서 `empty: true` 를 "델리게이트가 아무것도 안 했다"로 읽으면 안 된다.
 *   `ignoredPaths`·`gitlinks` 가 비어 있을 때만 그렇게 읽을 수 있고, 둘 중 하나가
 *   `null` 이면 **모르는 것**이다.
 *
 * 마지막 스냅샷 뒤에 남은 미커밋 작업도 담아야 하므로, 커밋을 쌓는 대신 워크트리
 * 인덱스에 `add -A` 로 전부 올려 두고 baseline 과 비교한다(워크트리는 일회용이라
 * 인덱스를 건드려도 사용자에게 영향이 없다).
 *
 * `--binary` 는 필수다 — 없으면 바이너리 변경이 "Binary files differ" 한 줄로 뭉개져
 * 적용할 수 없는 패치가 된다.
 *
 * ★ 이 패치는 **사용자 저장소에 적용된다.** 그래서 바이트가 걸린 자리 중 가장 위험한
 *   곳이다: 델리게이트가 EUC-KR 파일을 쓰면 utf8 왕복이 모지바케 패치를 만들고, 그것이
 *   사용자 파일을 손상시킨다. 여기서만은 문자열을 거치지 않는다(모듈 상단의 바이트 계약).
 *
 * @returns `{ ok: true, patch, empty, files, ignoredPaths, gitlinks }` 또는 blocked 봉투.
 *   `patch` 는 **Buffer** 다 — 파일로 쓸 때는 그대로, 헤더를 볼 때는 `toString('latin1')`.
 *   나머지 셋은 모듈 상단의 "무엇이 바뀌었는지는 `files` 에서만 읽어라" 계약과
 *   아래 각 헬퍼의 주석을 보라.
 */
export async function collectPatch(wt, deps = {}) {
  const run = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;

  const staged = await run({ args: ['add', '-A'], cwd: wt.path, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!staged.ok) {
    return blocked(`최종 패치를 위해 변경을 모으지 못했습니다: ${gitReason(staged)}`, '워크트리 파일 권한을 확인하세요.');
  }

  const patch = await diffToBytes({
    run,
    args: ['diff', '--cached', '--binary', wt.baseline],
    cwd: wt.path,
    stateRoot: wt.stateRoot,
    tag: `final-${wt.runId ?? 'run'}`,
  });
  // 여기서도 `ok` 를 먼저 본다(diffToBytes 가 그 순서를 지킨다). 빈 패치를 "변경 없음"
  // 으로 먼저 읽으면 diff 실패가 "델리게이트가 아무것도 안 했다" 로 둔갑하고,
  // 오케스트레이터는 성과 0 으로 기록한 뒤 실제로 만들어진 코드를 통째로 버린다.
  if (patch.failure) {
    return blocked(
      `최종 패치를 뜨지 못했습니다: ${gitReason(patch.failure)}`,
      '워크트리가 정상 상태인지 확인한 뒤 다시 시도하세요.',
    );
  }
  if (patch.crashed) {
    return blocked(
      `최종 패치를 읽지 못했습니다: ${String(patch.crashed?.message ?? patch.crashed)}`,
      '상태 루트 경로에 쓸 수 있는지, 디스크에 공간이 있는지 확인하세요.',
    );
  }

  // ★ I-7. 패치 파싱에 의존하지 않는 **파일 목록**을 같은 리비전 쌍으로 한 번 더 뜬다.
  //   이유와 계약은 모듈 상단의 "무엇이 바뀌었는지는 `files` 에서만 읽어라" 를 보라.
  //   여기서 실패하면 **blocked** 다 — 빈 배열로 떨어뜨리면 "델리게이트가 아무것도
  //   안 건드렸다" 가 되어 스코프 검사가 무조건 통과한다. `patch.failure` 를 blocked
  //   로 다루는 것과 같은 근거이고, 같은 `diff` 명령 계열이라 대칭이기도 하다.
  const names = await run({
    args: ['diff', '--cached', '--name-only', '-z', '--no-renames', wt.baseline],
    cwd: wt.path,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (!names.ok) {
    return blocked(
      `최종 패치의 파일 목록을 뜨지 못했습니다: ${gitReason(names)}`,
      '워크트리가 정상 상태인지 확인한 뒤 다시 시도하세요. 목록 없이는 변경 범위를 검증할 수 없습니다.',
    );
  }
  const files = names.stdout.split('\0').filter((entry) => entry !== '');

  return {
    ok: true,
    patch: patch.bytes,
    empty: patch.bytes.length === 0,
    files,
    ignoredPaths: await collectIgnoredPaths({ run, cwd: wt.path }),
    gitlinks: await collectGitlinks({ run, cwd: wt.path }),
  };
}

/**
 * 무시 규칙에 걸려 **패치에 실리지 않은**(수집 방향) 또는 **워크트리에 오지 않은**
 * (이식 방향) 경로. 없으면 `[]`, 못 보면 `null`.
 *
 * ★ C-2b. 적대자가 없는 경로다. 평범한 저장소의 커밋된 `.gitignore` 가
 *   `build/`·`dist/` 를 무시하는데 델리게이트에게 "생성물을 거기 만들어라"라고 지시하는
 *   것은 극히 흔하다. 그러면 세 API 가 전부 "아무 일도 없었다"고 보고하는데 파일은
 *   디스크에 있다(리뷰어 재현: `clean:true` / `empty:true` / 파일 존재).
 *   `collectPatch` 자신의 주석이 그 결과를 금지한다.
 *
 *   무시 규칙 자체는 무력화하지 않는다 — 커밋된 `.gitignore` 도, 사용자의 전역 무시
 *   파일도 정당한 설정이다(`src/git.mjs` 의 `HARDENING_ARGS` 주석 참조). 대신 조용하지
 *   않게 한다. 특히 `empty:true` + 무시된 산출물 존재 조합은 "성과 0" 과 반드시
 *   구분해야 한다.
 *
 * ★ **`-z` 가 필수다.** `--porcelain` 의 기본 출력은 경로를 C-인용한다 — 이 축은
 *   `core.quotePath` 와 무관하게 **공백 하나로도** 발화한다(실측):
 *
 *     기본            !! plain.log / !! "sub dir/deep.log" / !! "with space.log"
 *                     !! "\355\225\234\352\270\200\353\241\234\352\267\270.log"
 *     quotePath=false !! "sub dir/deep.log" / !! "with space.log"   <- 공백은 그대로 인용
 *     -z              !! plain.log | !! sub dir/deep.log | !! with space.log | !! 한글로그.log
 *
 *   이 필드는 계약상 **경로 목록**이고 다운스트림이 `join()` 해서 연다. 인용된 문자열은
 *   존재하지 않는 경로가 되어 검사가 조용히 no-op 이 된다. 같은 이유로 `.trim()` 도
 *   쓰지 않는다 — POSIX 에서 이름 끝의 정당한 공백을 먹는다.
 *
 * ★ `null` 을 `[]` 로 뭉개지 마라. 빈 배열은 "무시된 변경이 없다", `null` 은 "확인하지
 *   못했다" 다. 조회 실패로 blocked 를 내지는 않는다 — 이것은 정보를 **더하는** 진단이라,
 *   실패했다고 델리게이트의 진짜 작업이 든 패치를 통째로 버리는 것이 더 나쁘다.
 */
async function collectIgnoredPaths({ run, cwd }) {
  const got = await run({
    args: ['status', '--porcelain', '-z', '--ignored=matching'],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  if (!got.ok || typeof got.stdout !== 'string') return null;
  return got.stdout
    .split('\0')
    .filter((record) => record.startsWith('!! '))
    .map((record) => record.slice(3))
    .filter((entry) => entry !== '');
}

/**
 * 워크트리 인덱스의 **gitlink**(mode `160000`) 목록. 없으면 `[]`, 못 보면 `null`.
 *
 * ★ I-1. 델리게이트가 `git init` 한 디렉터리(스캐폴더가 흔히 한다)나 사용자 저장소의
 *   서브모듈은 gitlink 로만 기록되고 **내용이 패치에 실리지 않는다.** 리뷰어 재현:
 *   최종 패치는 `new file mode 160000` + `+Subproject commit …` 뿐이고, 적용해도
 *   `vendor/lib.js` 는 생기지 않는다 — 산출물 전량 유실인데 봉투는 `ok:true` 다.
 *
 *   **완전한 서브모듈 지원은 이번 범위 밖이다.** 여기서 하는 것은 "내용이 사라졌다"를
 *   성공으로 조용히 보고하지 않는 것뿐이다.
 *
 * ★ 왜 하필 `ls-files -s` 인가 (다른 후보는 전부 무효임이 실측됐다):
 *   `status --porcelain --ignored=matching`·`-uall`·`ls-files -o`·`add -A --dry-run` 은
 *   서브모듈 경우에 **전부 빈 출력**이다. `add -A` 의 stderr 경고
 *   ("adding embedded git repository")는 새로 만든 gitlink 에만 나오고 exit 0 이라
 *   놓치기 쉽다. `160000` 항목은 새 gitlink 와 기존 gitlink 를 **둘 다** 잡는다.
 *
 * ★ **`-z` 가 필수다.** `ls-files -s` 의 기본 출력도 경로를 C-인용한다. 여기서는 공백이
 *   아니라 **비 ASCII** 가 축이다(실측):
 *
 *     기본  160000 … 0\tsub plain                      <- 공백은 그대로 나온다
 *           160000 … 0\t"\354\204\234\353\270\214…"    <- 비 ASCII 는 인용된다
 *     -z    160000 … 0\t서브모듈
 *
 *   한국어 경로가 일상인 이 프로젝트에서는 평범한 입력이다. `-z` 를 붙여도 레코드
 *   형식(`<mode> <sha> <stage>\t<path>`)은 그대로다.
 *
 * ★ `null` 과 `[]` 의 구분은 위 `collectIgnoredPaths` 와 같다.
 */
async function collectGitlinks({ run, cwd }) {
  const got = await run({ args: ['ls-files', '-s', '-z'], cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!got.ok || typeof got.stdout !== 'string') return null;
  const found = [];
  for (const record of got.stdout.split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    // "160000 <sha> <stage>\t<path>" — 경로는 탭 뒤다. `-z` 라 인용도 escape 도 없다.
    const tab = record.indexOf('\t');
    if (tab !== -1) found.push(record.slice(tab + 1));
  }
  return found;
}

// ── 상태 조회 ─────────────────────────────────────────────────────────────

/**
 * 이 워크트리에서 **무시 규칙에 걸린** 경로. 없으면 `[]`, 못 보면 `null`.
 *
 * `collectPatch` 가 봉투에 싣는 것과 같은 값이지만, 호출자가 **최종 패치를 뜨기 전에도**
 * 물을 수 있어야 한다. 스텝별 스코프 검사가 그렇다: `add -A` 기반 관측(스냅샷·`files`)은
 * 무시 규칙에 걸린 쓰기를 전부 놓치므로, 그 목록을 따로 얹지 않으면 예컨대 사용자 전역
 * 무시 규칙에 걸리는 `.claude/settings.local.json` 같은 쓰기가 검사에 아예 안 보인다.
 *
 * 갓 만든 워크트리에는 무시된 파일이 없다 — 이식이 무시 규칙을 존중하기 때문이다. 그래서
 * 여기 나오는 것은 그 워크트리 안에서 **새로 생긴** 것이다.
 */
export async function listIgnoredPaths(wt, deps = {}) {
  const run = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;
  return collectIgnoredPaths({ run, cwd: wt.path });
}

/**
 * 워크트리의 현재 더러운 상태. 델리게이트가 무엇을 건드렸는지 확인하는 용도다.
 *
 * ★ **대체됨.** 이 함수는 설계 §5.5("verifier 스텝 전/후 `git status --porcelain`
 *   스냅샷을 비교해 verifier 가 몰래 고친 것을 잡는다")의 산출물인데, 엔진이 그 방식을
 *   쓰지 않기로 했다 — 바로 아래 문단의 실측 때문이다. `status --porcelain` 은 무시
 *   규칙에 걸린 파일과 gitlink 안의 내용을 못 보므로 "안 건드렸다"를 증명하지 못한다.
 *   엔진은 대신 `snapshotStep().files`(스텝별 기준점 대비 `diff --name-only`)를 쓴다.
 *   그쪽은 같은 구멍이 없고, 스텝 귀속도 정확하다.
 *
 *   그래서 `src/` 안의 호출부는 0곳이다. 지우지 않고 남기는 이유는 판단이 옳았고
 *   산출물만 죽었기 때문이다 — 지우면 계획 2 가 실제로 잰 것이 사라진다.
 *
 * ★ **`clean: true` 는 "델리게이트가 아무것도 안 했다"가 아니다.** `status --porcelain`
 *   은 무시 규칙에 걸린 파일과 gitlink 안의 내용을 보지 않는다 — 저장소가 `build/` 를
 *   무시하는데 델리게이트가 거기에 진짜 작업을 남기면 여기서는 `clean:true, entries:[]`
 *   가 나오고 파일은 디스크에 있다(리뷰어 재현). 그 판단이 필요하면 `collectPatch` 의
 *   `ignoredPaths`·`gitlinks` 를 함께 보라.
 *
 * @returns `{ ok: true, clean, entries, porcelain }` 또는 blocked 봉투.
 */
export async function statusSnapshot(wt, deps = {}) {
  const run = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;

  const got = await run({ args: ['status', '--porcelain'], cwd: wt.path, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!got.ok) {
    return blocked(`워크트리 상태를 읽지 못했습니다: ${gitReason(got)}`, '워크트리가 아직 있는지 확인하세요.');
  }
  const entries = got.stdout.split('\n').filter((line) => line.trim() !== '');
  return { ok: true, clean: entries.length === 0, entries, porcelain: got.stdout };
}

// ── 제거 ──────────────────────────────────────────────────────────────────

/**
 * 워크트리를 등록에서 빼고 디렉터리를 지운다.
 *
 * 이미 사라진 워크트리에도 성공을 낸다 — 리퍼가 먼저 치웠거나 사용자가 지웠을 수 있고,
 * 그때 실패를 내면 정상 종료 경로가 매번 오류를 보고한다.
 *
 * ★ `rm` 전에 `isSafeWorktree` 로 경로를 확인한다. 리퍼가 이 검사 없이 `rm -rf` 를
 *   걸었다가 상태 루트를 통째로 날린 전례가 있다.
 *
 * @returns `{ ok: true, removed, unregistered }`. **`ok:true` 는 "우리가 할 수 있는
 *   뒷정리를 다 했다"이지 "아무것도 안 남았다"가 아니다** — 실제로 무엇이 남았는지는
 *   `removed`(디렉터리가 사라졌는가)와 `unregistered`(등록이 빠졌는가)에 있다.
 *   `unregistered: null` 은 등록 조회 자체가 실패해 **모른다**는 뜻이다.
 *   봉투가 사실과 달라서는 안 되므로 이 셋을 뭉개지 않는다(M-1).
 */
export async function removeWorktree(wt, deps = {}) {
  const run = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;

  // ★ 검사도 삭제도 **실체 경로**로 한다(C-1). 문자열만 보면 상태 루트 안을 가리키는
  //   링크 하나로 이 검사가 통째로 우회되고, 등록 조회의 경로 비교도 어긋난다.
  const stateRoot = await canonical(wt.stateRoot);
  const worktreePath = await canonical(wt.path);
  if (stateRoot === null || worktreePath === null || !isSafeWorktree(stateRoot, worktreePath)) {
    return blocked(
      `상태 루트 밖의 경로는 지우지 않습니다: ${wt.path}`,
      '워크트리는 <상태 루트>/worktrees/<실행 ID> 아래에만 만들어집니다.',
    );
  }

  const projectPath = (await canonical(wt.projectPath)) ?? wt.projectPath;
  const result = await discard({ run, projectPath, stateRoot, worktreePath });
  return { ok: true, removed: result.removed, unregistered: result.unregistered };
}

/** 핸들이 이 모듈이 만든 모양인지 본다. 아니면 blocked 봉투. */
function checkHandle(wt) {
  if (wt === null || typeof wt !== 'object') {
    return blocked('워크트리 핸들이 없습니다.', 'createWorktree 가 돌려준 값을 그대로 넘기세요.');
  }
  for (const key of ['path', 'projectPath', 'stateRoot']) {
    if (typeof wt[key] !== 'string' || wt[key] === '') {
      return blocked(`워크트리 핸들에 ${key} 가 없습니다.`, 'createWorktree 가 돌려준 값을 그대로 넘기세요.');
    }
  }
  return null;
}
