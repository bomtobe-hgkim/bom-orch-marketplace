import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runGit } from './git.mjs';

/**
 * 델리게이트가 돌려보내는 패치의 **범위**를 기계적으로 검사한다 (S3c · S4).
 *
 * 이 패치는 사용자 저장소에 `git apply` 된다. 델리게이트가 `.github/workflows/*` ·
 * `.npmrc` · 셸 rc 를 고쳐 놓으면 적용하는 순간이 아니라 **그 뒤의 실행**(다음 CI,
 * 다음 `npm install`, 다음 셸)에서 발화한다. 라이브 실측으로 두 벤더 CLI 의 도구 권한
 * 플래그로는 델리게이트의 셸을 제한할 수 없다는 것이 확인됐으므로, 무엇을 건드렸는지
 * 세는 일은 여기서 한다. **LLM 에게 묻지 않는다.**
 *
 * ## ★ 입력은 `collectPatch().files` 다 — 패치 본문을 파싱하지 않는다
 *
 * 계획서의 시그니처는 `inspectPatch({ patchText, changedPaths })` 였는데 그 문장은
 * 계획 2 Task 2 **이전**에 쓰였다. Task 2 가 패치 파싱이 원리적으로 틀린다는 것을
 * 실측하고 다른 계약을 세웠고(`src/worktree.mjs` 모듈 상단), 그 계약을 여기서 쓴다:
 *
 *   - **rename 은 `---`/`+++` 줄을 아예 만들지 않는다.** rename 감지는 `diff.renames`
 *     기본값이라 항상 켜져 있다. `+++ b/` 에서 경로를 모으면
 *     `src/x.js` → `.github/workflows/x.yml` 이동이 **파일 0개**로 보여 이 검사를
 *     그냥 통과한다 — 막으려는 바로 그 공격이 무증상으로 지나간다.
 *   - `diff --git` 줄은 공백이 든 경로에서 두 경로의 경계가 모호하고, `core.quotePath`
 *     기본값에서 헤더 경로가 C-인용된다.
 *
 * `files` 는 `diff --cached --name-only -z --no-renames <baseline>` 로 뜬 원시 경로다.
 * 구분자는 `/`, 인용도 escape 도 없고, `--no-renames` 라 이동의 원본과 대상이 둘 다
 * 들어 있다. 그래서 이 모듈은 `patchText` 를 아예 받지 않는다.
 *
 * ## 이 검사가 하는 일과 하지 않는 일
 *
 * 목적은 완전 차단이 아니라 **플래그를 세우는 것**이다. 플래그가 서면
 * `confidence: 'disputed'` 를 낸다 — `src/envelope.mjs` 의 `success()` 가 그 값을
 * `status: 'failed'` 로 강등하므로 상호배타는 거기서 이미 강제된다. 여기서 다시
 * 구현하지 않는다.
 *
 * **차단 목록은 열거이고 열거는 뒤처진다.** 못 막는 것을 아래 [[잔여 위험]] 에 적어 둔다.
 */

const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';

/** 이 모듈의 실패 봉투. `src/git.mjs`·`src/worktree.mjs` 의 `blocked()` 와 같은 모양이다. */
function blocked(error, recovery) {
  return { blocked: true, error, recovery: recovery && recovery !== '' ? recovery : GENERIC_RECOVERY };
}

/** 인덱스 조회의 시간 상한. 큰 저장소의 `ls-files` 를 감안해 runGit 기본값보다 넉넉하다. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * `reasons` 의 상한. `src/envelope.mjs` 는 content 를 **꼬리부터** 자르므로, 이유 목록이
 * 상한 없이 늘어나면 정확히 많이 걸린 경우에 뒷부분이 사라진다. 잘라낸 개수는
 * `omitted` 와 `recovery` 에 남긴다.
 */
const MAX_REASONS = 100;

/** recovery 에 이름을 그대로 적어 줄 경로의 개수. */
const RECOVERY_SAMPLE = 5;

/**
 * 경로 **세그먼트** 어디에 나타나도 걸리는 디렉터리 이름 (소문자 비교).
 *
 * 전부 "적용 뒤의 실행에서 명령이 도는" 자리다:
 *   `.github`      workflows·actions — 다음 CI 실행
 *   `.gitlab`      CI include 조각
 *   `.circleci`    config.yml
 *   `.husky`       git hook 관리자 — 다음 커밋
 *   `.devcontainer` postCreateCommand — 컨테이너를 다시 열 때
 *   `.vscode`      tasks.json 의 자동 실행, settings.json 의 도구 경로 지정
 *   `.git`         hooks/ · info/ · config
 *   `.claude`      settings.json 의 hooks — 이 서버의 결과를 받는 쪽이 Claude Code 다
 *   `.gitea`       `.gitea/workflows` — Actions 워크플로 형식이 `.github` 와 같다
 *   `.forgejo`     같음
 *
 * ★ `.claude` 의 노이즈 실측: 사용자의 실제 저장소 14개, 커밋 2,059개를 태운 결과 플래그
 *   56개 중 **37개가 `.claude` 만이 이유**였다(66%). 최다 항목은
 *   `.claude/settings.local.json`. 이 서버를 쓰는 사람의 프로젝트에는 그 디렉터리가
 *   일상적으로 들어 있으므로 플래그가 자주 뜬다. 그래도 목록에 남긴다 — `settings.json`
 *   의 hooks 와 `commands/`·`agents/` 의 본문은 모두 명령을 실행시킬 수 있고, 이 서버의
 *   결과를 받는 쪽이 바로 Claude Code 다. under-flag 는 구멍이고 over-flag 는 소음이라
 *   기본값은 안전한 쪽으로 둔다. 빈도를 줄이는 것은 배선 계층의 표시 방식이 정할 문제다.
 */
const SENSITIVE_DIR_SEGMENTS = new Set([
  '.github',
  '.gitlab',
  '.circleci',
  '.husky',
  '.devcontainer',
  '.vscode',
  '.git',
  '.claude',
  '.gitea',
  '.forgejo',
]);

/**
 * 마지막 세그먼트(= 파일 이름)가 이것이면 걸린다 (소문자 비교). 중첩 경로에서도 본다 —
 * `packages/ui/.npmrc` 는 npm 이 실제로 읽는 자리이고 루트의 것과 위험이 같다.
 */
const SENSITIVE_FILE_NAMES = new Set([
  // CI 정의
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  'jenkinsfile',
  '.travis.yml',
  'appveyor.yml',
  '.appveyor.yml',
  'bitbucket-pipelines.yml',
  // 패키지 매니저 — install 시점에 스크립트·레지스트리·자격증명이 걸린다
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  '.pypirc',
  'nuget.config',
  // lockfile — 설계 §5.8:387 이 차단 목록에 명시했는데 코드에서 빠져 있었다(실측:
  // `package-lock.json`·`yarn.lock`·`pnpm-lock.yaml`·`Cargo.lock` 넷 전부
  // flagged=false). 잠긴 URL·integrity 를 바꾸면 다음 install 이 공격자 tarball 을
  // 가져오고 그 postinstall 이 돈다.
  //
  // 오탐 비용이 낮은 근거(둘 다 실측 기반): 워커에게는 Bash 가 없고(§12.-1),
  // `src/test-runner.mjs` 는 **의존성을 설치하지도 링크하지도 않는다.** 즉 아래
  // 이름들을 다시 쓸 수 있는 프로세스가 이 파이프라인에 없다 — 바뀌었다면 델리게이트가
  // 손으로 고친 것이다.
  //
  // ⚠ `packages.lock.json`(NuGet)은 **일부러 뺐다.** 러너가 지원하는 `dotnet test` 가
  //   암묵적 restore 를 돌리고, `RestorePackagesWithLockFile` 을 켠 프로젝트에서는 그
  //   restore 가 그 파일을 다시 쓴다 — 우리가 한 일로 사용자의 실행을 disputed 로
  //   강등하게 된다. 대신 아래 [[잔여 위험]] 에 적는다.
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  // 셸 rc — 다음 대화형 셸에서 발화한다
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.kshrc',
  '.cshrc',
  '.envrc', // direnv — 디렉터리에 들어가는 것만으로 실행된다
  // 빌드 시스템이 자동으로 읽는 설정
  'directory.build.props',
  'directory.build.targets',
  'directory.build.rsp',
  'directory.packages.props',
  // 이 서버의 호출자
  '.mcp.json',
  // Dev Containers 의 공식 설정 위치는 셋이다:
  //   .devcontainer/devcontainer.json · .devcontainer/<folder>/devcontainer.json · 루트 .devcontainer.json
  // 앞의 둘은 위 SENSITIVE_DIR_SEGMENTS 의 `.devcontainer` 가 잡지만, 루트 형태는 세그먼트가
  // `.devcontainer.json` 하나뿐이라 안 걸렸다. 실측: 델리게이트의 Write 한 번으로
  // `{"initializeCommand": …}` 를 심었더니 flagged=false 로 통과하고 git apply 가 exit 0 으로
  // 사용자 저장소 루트에 떨어뜨렸다. `initializeCommand` 는 컨테이너가 아니라 호스트에서 돈다.
  '.devcontainer.json',
]);

/**
 * Windows 8.3 단축 이름 모양의 base. **이 축은 실측으로 재현된 공격이다.**
 *
 * 워크트리에 `.github` 가 없어도 델리게이트는 `GITHUB~1/workflows/evil.yml` 을 만들 수
 * 있고, 그 이름이 `files` 에 그대로 실린다(git 은 자기가 열거한 이름을 낸다). 그 패치를
 * `.github` 가 있는 저장소에 apply 하면 **exit 0 으로 `.github/workflows/evil.yml` 이
 * 생긴다**(실측, C: 볼륨의 8dot3name 생성이 켜져 있다). 세그먼트 정확 일치만으로는
 * 통째로 지나간다.
 *
 * git 은 `.git` 에만 특례를 둔다 — `GIT~1/hooks/pre-commit` 은 `git apply` 가 exit 128
 * `invalid path` 로 거부한다(실측). `.github` 에는 그 특례가 없다.
 *
 * 어떤 긴 이름으로 풀릴지는 대상 저장소를 봐야 알 수 있으므로 **모양만 보고 플래그**한다.
 * 실측으로 관찰한 모양: `GITHUB~1` `GITHUB~4` `GIBC34~1` `NPMRC~1` `AZURE-~1.YML`
 * `DIRECT~1.PRO` — base 는 8자 이하, 확장자는 3자 이하, `~` 뒤는 한두 자리다
 * (Windows 는 ~1..~4 를 쓰고 그 뒤로는 해시 base + `~1` 로 바꾼다).
 */
const SHORT_NAME_BASE = /^[^.]+~[0-9]{1,2}$/;

/**
 * git 이 낸 경로를 세그먼트로 쪼갠다.
 *
 * 구분자는 `/` 하나다. 역슬래시로도 쪼개지 않는 이유는 실측이다: Windows 에서는
 * 이름에 역슬래시가 든 파일을 만들 수 없고(ENOENT), 그런 경로가 든 패치는 `git apply`
 * 자신이 exit 128 `invalid path` 로 거부한다. 쪼개 봐야 막을 것이 없고 POSIX 의 정당한
 * 파일 이름(`a\b.txt`)만 잘게 나뉜다.
 */
function segmentsOf(path) {
  return path.split('/').filter((segment) => segment !== '');
}

/** 8.3 단축 이름 모양인가. */
function looksLikeShortName(segment) {
  const dot = segment.lastIndexOf('.');
  const base = dot > 0 ? segment.slice(0, dot) : segment;
  const extension = dot > 0 ? segment.slice(dot + 1) : '';
  if (base.length > 8 || extension.length > 3) return false;
  return SHORT_NAME_BASE.test(base);
}

/**
 * 한 경로에 대한 판정. 걸린 이유를 배열로 낸다(없으면 빈 배열).
 *
 * ★ 판정 단위는 **경로 세그먼트**다. 계획 1 에서 부분 문자열 금지가 실제 경로를
 *   오탐했다 — `C:\repos\network_access\worktree-1` 이 `network_access` 를 포함한다는
 *   이유로 통째로 거부됐다. `my.github.notes.md` 나 `docs/github-actions-guide.md` 가
 *   걸리면 이 검사는 곧 무시된다.
 *
 * ★ 대소문자는 접는다. 실측: 워크트리에 `.GITHUB/workflows/evil.yml` 을 만들면 그
 *   대소문자 그대로 `files` 에 실리고, `.github` 가 있는 저장소에 apply 하면 exit 0 으로
 *   **기존 `.github/workflows/` 안에** 들어간다. POSIX 에서는 `.GITHUB` 이 다른
 *   디렉터리라 이 접기가 과잉 일치이지만, 이 검사의 결과는 차단이 아니라 사람 확인
 *   요청이므로 그쪽으로 기운다.
 */
function inspectPath(path) {
  const found = [];
  const segments = segmentsOf(path);
  const last = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : '';

  for (const segment of segments) {
    const folded = segment.toLowerCase();
    if (SENSITIVE_DIR_SEGMENTS.has(folded)) {
      found.push({ path, rule: 'sensitive-path', detail: `경로 세그먼트 '${segment}' 는 적용 뒤에 명령이 도는 자리입니다.` });
    }
    if (looksLikeShortName(segment)) {
      found.push({
        path,
        rule: 'short-name',
        detail: `세그먼트 '${segment}' 가 Windows 8.3 단축 이름 모양입니다 — 적용하는 저장소에서 다른 긴 이름으로 풀릴 수 있습니다.`,
      });
    }
  }

  if (SENSITIVE_FILE_NAMES.has(last)) {
    found.push({ path, rule: 'sensitive-path', detail: `'${segments[segments.length - 1]}' 는 도구가 자동으로 읽는 설정 파일입니다.` });
  }
  return found;
}

/**
 * 워크트리 인덱스의 **mode 120000**(심볼릭 링크) 항목. `{ entries }` 또는 `{ failure }`.
 *
 * ★ 계획서는 `git diff --summary` 의 mode-120000 항목을 보라고 했는데 그 처방은
 *   델리게이트가 실제로 도달할 수 있는 경우를 놓친다(실측):
 *
 *     새 심링크 생성        diff --summary: `create mode 120000 x`   ls-files -s: 120000
 *     기존 심링크 재지정    diff --summary: **아무것도 없음**        ls-files -s: 120000
 *
 *   재지정 쪽이 델리게이트에게 열려 있는 경로다. 도구가 Read/Write/Edit 뿐이라 심링크를
 *   새로 만들 수는 없지만, 하드닝의 `core.symlinks=false` 때문에 사용자 저장소의 심링크는
 *   워크트리에서 **타깃 경로가 든 일반 파일**로 체크아웃된다. 그 파일을 Write 로 고치면
 *   인덱스의 mode 는 120000 인 채 blob 만 바뀌고, 패치가 사용자 저장소의 심링크를
 *   재지정한다. `--summary` 는 create/delete/mode 변경만 적으므로 그 변화가 보이지 않는다.
 *
 *   재지정 뒤 네 출처를 나란히 잰 결과(날것 git — `runGit` 은 diff 뒤에 `-U3` 를 끼워
 *   `--summary` 전용 출력을 못 낸다):
 *
 *     diff --cached --summary     ""
 *     diff --cached --raw         ":120000 120000 c9c61fe 84476a2 M\tlink"
 *     diff-index --cached --raw   같음
 *     ls-files -s                 "120000 84476a28… 0\tlink"
 *
 *   `--raw` 계열도 낸다. 여기서 `ls-files -s` 를 쓰는 것은 인덱스 전체를 한 번에 보기
 *   때문이지 그것만 낼 수 있어서가 아니다.
 *
 * ★ **`-z` 가 필수다.** `ls-files -s` 의 기본 출력은 비 ASCII 경로를 C-인용한다
 *   (`src/worktree.mjs` 의 `collectGitlinks` 가 같은 축을 기록해 뒀다). 인용된 문자열은
 *   `files` 의 원시 경로와 절대 일치하지 않아 대조가 통째로 no-op 이 된다.
 */
async function listIndexEntries({ run, worktree }) {
  const listed = await run({ args: ['ls-files', '-s', '-z'], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  if (!listed.ok || typeof listed.stdout !== 'string') return { failure: listed };

  const entries = [];
  for (const record of listed.stdout.split('\0')) {
    // "<mode> <sha> <stage>\t<path>" — `-z` 라 인용도 escape 도 없다. sha 길이를 고정해
    // 잘라내지 않는다: SHA-256 저장소는 64자다.
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, sha] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (typeof mode === 'string' && typeof sha === 'string' && sha !== '' && path !== '') {
      entries.push({ path, sha, mode });
    }
  }
  return { entries };
}

/** 인덱스 항목 하나의 blob 을 문자열로. 못 읽으면 null. */
async function readBlob({ run, worktree, sha }) {
  const blob = await run({ args: ['cat-file', 'blob', sha], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  return blob.ok && typeof blob.stdout === 'string' ? blob.stdout : null;
}

/**
 * `package.json` 의 `scripts` 블록. **읽지 못하면 `undefined`**("모른다"), 파일은 읽혔지만
 * 블록이 없으면 `{}`("없다"). 그 둘을 뭉개면 확인하지 못한 것을 "안 바뀌었다"로 기록한다.
 */
function readScripts(text) {
  if (typeof text !== 'string') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const scripts = parsed.scripts;
  return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
}

/**
 * 두 `scripts` 블록에서 **달라진 키 이름**. 같으면 빈 배열.
 *
 * 키 순서는 무시한다 — JSON 객체의 키 순서는 실행에 영향을 주지 않으므로 그것으로
 * 플래그하면 포매터 한 번에 사용자 작업이 막힌다.
 *
 * 값은 비교에만 쓰고 **밖으로 내지 않는다.** 이 모듈의 `reasons` 는 봉투를 타고 나가고,
 * 사람이 확인하는 데 필요한 것은 "어느 스크립트가 달라졌나" 다.
 */
function changedScriptKeys(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changed.push(key);
  }
  return changed.sort();
}

/**
 * `package.json` 의 `scripts` 블록만 베이스라인과 대조한다 (계획 2 이월 3).
 *
 * ## 왜 이름 목록이 아니라 대조인가
 *
 * `package.json` 은 이 모듈의 잔여 위험 1번이었다 — `scripts.postinstall`·`preinstall` 은
 * 적용 뒤 `npm install` 에서 돌지만, 델리게이트가 **정당하게 계속 고치는 파일**이라
 * `SENSITIVE_FILE_NAMES` 에 넣으면 거의 모든 JS 작업이 disputed 가 된다. 그래서 아무
 * 검사도 없었다(실측, 커밋 9bf38a6: 플래그 0건). 실행되는 자리는 `scripts` 하나뿐이므로
 * 그 블록만 보면 오탐 없이 그 구멍을 닫을 수 있다.
 *
 * ## `baseline` 은 커밋-ish **또는 경로 -> 원문 map** 이다
 *
 * 실제 워크트리 호출부는 이식 직후의 커밋-ish(`wt.baseline`)를 준다. 반면 순수 호출자는
 * 이미 가진 원문 map 을 준다. 둘을 한 계약으로 받으면 호출자가 원문을 다시 git 에서 읽을
 * 필요도 없고, 기존 호출도 깨지지 않는다.
 *
 * `baseline` 이 없으면 `package.json` 이 files 에 있다는 사실만으로 보수적으로 플래그한다.
 * 대조 기준이 없다고 자동 실행 설정 검사를 통째로 빼면, 인자를 빼는 호출 하나가 위험한
 * scripts 변경을 조용히 통과시킨다.
 */
async function inspectPackageScripts({ run, worktree, baseline, files, entries }) {
  const wanted = new Set(files.filter((path) => segmentsOf(path).at(-1)?.toLowerCase() === 'package.json'));
  if (wanted.size === 0) return [];

  const commitBaseline = typeof baseline === 'string' && baseline !== '';
  const sourceBaseline = baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline);
  if (!commitBaseline && !sourceBaseline) {
    return [...wanted].map((path) => ({
      path,
      rule: 'package-baseline-missing',
      detail: '베이스라인이 없어 package.json 의 scripts 변경 여부를 확인할 수 없습니다.',
    }));
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const reasons = [];
  for (const path of wanted) {
    // 삭제된 파일은 인덱스에 없지만, scripts 가 사라진 것도 실행 동작의 변화다.
    const entry = byPath.get(path);
    const current = entry ? readScripts(await readBlob({ run, worktree, sha: entry.sha })) : {};
    if (current === undefined) {
      reasons.push({
        path,
        rule: 'package-unreadable',
        detail: 'JSON 으로 읽지 못해 scripts 블록이 그대로인지 확인할 수 없습니다.',
      });
      continue;
    }

    let beforeText = null;
    if (commitBaseline) {
      // 베이스라인에 파일이 없으면 git 은 비0을 낸다. 그것은 새 파일이므로 {}와 대조한다.
      const before = await run({
        args: ['cat-file', 'blob', `${baseline}:${path}`],
        cwd: worktree,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      beforeText = before.ok && typeof before.stdout === 'string' ? before.stdout : null;
    } else if (Object.hasOwn(baseline, path)) {
      beforeText = baseline[path];
    }
    const baselineScripts = beforeText === null ? {} : readScripts(beforeText);
    if (baselineScripts === undefined) {
      reasons.push({
        path,
        rule: 'package-unreadable',
        detail: '베이스라인의 package.json 을 JSON 으로 읽지 못해 scripts 블록을 대조할 수 없습니다.',
      });
      continue;
    }

    const changed = changedScriptKeys(baselineScripts, current);
    if (changed.length > 0) {
      reasons.push({
        path,
        rule: 'package-scripts',
        detail:
          `scripts 블록이 달라졌습니다: ${changed.join(', ')}. ` +
          '이 자리의 명령은 적용하는 순간이 아니라 그 뒤의 install/실행에서 돕니다.',
      });
    }
  }
  return reasons;
}

/**
 * 심링크 타깃이 델리게이트의 작업 범위를 벗어나는가. 벗어나면 사유 문자열, 아니면 null.
 *
 * ★ 타깃은 `git apply` 가 **전혀 검사하지 않는다**(실측): 타깃이 `.git/hooks/pre-commit`
 *   이든 `../../../evil` 이든 exit 0 으로 깨끗이 적용된다. 경로 규칙(`inspectPath`)은
 *   링크가 **놓이는 자리**만 본다.
 *
 * ★ `.git` 판정은 `rel` 의 **모든** 세그먼트를 본다. 첫 세그먼트만 보면
 *   `../sub/.git/hooks/pre-commit` 처럼 중첩·벤더링된 저장소를 겨냥한 타깃이 빠져나간다
 *   (실측: 첫 세그먼트가 `sub` 라 걸리지 않았다). `inspectPath` 가 `SENSITIVE_DIR_SEGMENTS`
 *   를 모든 세그먼트에서 보는 것과 같은 규칙이다.
 *
 * ⚠ 타깃에는 이 모듈의 나머지 경로 규칙(8.3 단축 이름, `.git` 외의 차단 세그먼트)이
 *   적용되지 않는다. 고치지 않고 사실만 적는다.
 */
function describeTargetEscape(worktree, linkPath, target) {
  if (target === '') return '타깃이 비어 있습니다.';
  // 절대 경로는 워크트리 안을 가리켜도 걸린다 — 워크트리는 일회용이라 그 경로를 사용자
  // 저장소에 심으면 곧 존재하지 않는 곳을 가리키는 링크가 남는다. (`isAbsolute` 는
  // 플랫폼 것이라 Windows 에서는 `C:\…` 와 UNC 도 여기서 걸린다.)
  if (isAbsolute(target)) return `타깃이 절대 경로입니다: ${target}`;

  const resolved = resolve(dirname(join(worktree, linkPath)), target);
  const rel = relative(worktree, resolved);
  if (rel === '') return `타깃이 워크트리 루트 자신입니다: ${target}`;
  const segments = rel.split(/[\\/]/);
  if (isAbsolute(rel) || segments[0] === '..') return `타깃이 워크트리 밖을 가리킵니다: ${target}`;
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return `타깃이 저장소 내부(.git)를 가리킵니다: ${target}`;
  }
  return null;
}

/**
 * 패치 범위를 검사한다. **절대 throw 하지 않는다.**
 *
 * @param {{ files: string[], worktree: string, baseline?: string|Record<string,string> }} spec
 *   `files` 는 `collectPatch().files` 를 그대로, `worktree` 는 그 워크트리 경로
 *   (`wt.path`)를 준다. 구조분해로 받지 않는 것은 `spec` 이 객체가 아닐 때도 봉투를
 *   내야 하기 때문이다.
 *   `baseline` 은 선택이고 `wt.baseline`(이식 직후 커밋) 또는 경로 -> 원문 map 이다.
 *   주면 `package.json` 의 `scripts` 블록을 대조한다(`inspectPackageScripts`). 안 주면
 *   package.json 이 files 에 있다는 사실만으로 보수적으로 플래그한다.
 * @param {{ run?: Function }} [deps]
 * @returns `{ ok: true, flagged, reasons, omitted, confidence?, recovery? }` 또는 blocked 봉투.
 *   `confidence`/`recovery` 는 **플래그가 섰을 때만** 실린다 — 이 모듈은 신뢰도를
 *   낮추기만 하고 올리지 않는다. 호출자는 `success({ confidence, recovery })` 에 그대로
 *   넘기면 된다.
 */
export async function inspectPatch(spec, deps = {}) {
  try {
    const options = spec ?? {};
    const files = options.files;
    const worktree = options.worktree;
    const run = deps?.run ?? runGit;

    if (!Array.isArray(files)) {
      return blocked(
        `변경된 파일 목록이 배열이 아닙니다: ${files === null ? 'null' : typeof files}`,
        'collectPatch() 가 낸 `files` 를 그대로 넘기세요. 목록 없이는 변경 범위를 검증할 수 없습니다.',
      );
    }
    for (const entry of files) {
      if (typeof entry !== 'string') {
        return blocked(
          `변경된 파일 목록에 문자열이 아닌 항목이 있습니다: ${typeof entry}`,
          'collectPatch() 가 낸 `files` 를 가공하지 말고 그대로 넘기세요.',
        );
      }
    }
    // 워크트리를 모르면 심링크 축을 아예 잴 수 없다. 그 경우 경로 검사 결과만 내면
    // 호출자는 검사가 다 돌았다고 믿는다 — 조용히 절반만 도는 쪽보다 거부가 낫다.
    if (typeof worktree !== 'string' || worktree === '') {
      return blocked(
        '워크트리 경로가 비어 있습니다.',
        '`createWorktree()` 가 낸 핸들의 `path` 를 넘기세요. 그 경로 없이는 심링크 항목을 확인할 수 없습니다.',
      );
    }

    const reasons = [];
    for (const path of files) reasons.push(...inspectPath(path));

    const listed = await listIndexEntries({ run, worktree });
    if (listed.failure) {
      const stderr = typeof listed.failure?.stderr === 'string' ? listed.failure.stderr.trim() : '';
      return blocked(
        `워크트리 인덱스를 읽지 못해 심링크를 확인할 수 없습니다: ${stderr !== '' ? stderr : '알 수 없는 오류'}`,
        '워크트리가 정상 상태인지 확인한 뒤 다시 시도하세요. 확인하지 못한 것을 "심링크 없음" 으로 기록하지 않습니다.',
      );
    }

    const touched = new Set(files);
    for (const entry of listed.entries) {
      if (entry.mode !== '120000') continue;
      // 델리게이트가 건드리지 않은 심링크는 패치에 실리지 않는다. 사용자 저장소에 원래
      // 있던 심링크 때문에 모든 실행이 disputed 가 되면 이 검사는 곧 무시된다.
      if (!touched.has(entry.path)) continue;

      const target = await readBlob({ run, worktree, sha: entry.sha });
      if (target === null) {
        reasons.push({
          path: entry.path,
          rule: 'symlink-unreadable',
          detail: '심볼릭 링크인데 타깃을 읽지 못했습니다 — 어디를 가리키는지 확인할 수 없습니다.',
        });
        continue;
      }
      // 심링크 타깃 blob 에는 개행이 없다. 파이프라인이 붙인 꼬리 개행만 걷어낸다.
      const escape = describeTargetEscape(worktree, entry.path, target.replace(/[\r\n]+$/, ''));
      if (escape !== null) reasons.push({ path: entry.path, rule: 'symlink-escape', detail: escape });
    }

    reasons.push(
      ...(await inspectPackageScripts({ run, worktree, baseline: options.baseline, files, entries: listed.entries })),
    );

    const flagged = reasons.length > 0;
    const kept = reasons.slice(0, MAX_REASONS);
    const omitted = reasons.length - kept.length;
    const result = { ok: true, flagged, reasons: kept, omitted };
    if (flagged) {
      result.confidence = 'disputed';
      result.recovery = buildRecovery(kept, omitted);
    }
    return result;
  } catch (error) {
    return blocked(
      `패치 범위를 검사하는 중에 예기치 못한 오류가 났습니다: ${String(error?.message ?? error)}`,
      '워크트리 경로와 파일 목록을 확인한 뒤 다시 시도하세요.',
    );
  }
}

/**
 * 사람이 무엇을 확인해야 하는지. 플래그가 섰을 때 반드시 채운다.
 *
 * 경로 이름만 적지 않고 **그 경로가 걸린 사유(`reason.detail`)** 를 함께 적는다. 사유는
 * 이미 계산해 둔 값인데 버리면 "이 파일을 확인하세요" 가 왜 확인해야 하는지 모르는 안내가
 * 된다 — 경로마다 위험이 다르다(8.3 모양 · 자동 실행 설정 · 심링크 타깃 탈출).
 */
function buildRecovery(reasons, omitted) {
  const firstByPath = new Map();
  for (const reason of reasons) {
    if (!firstByPath.has(reason.path)) firstByPath.set(reason.path, reason.detail);
  }
  const paths = [...firstByPath.keys()];
  const sample = paths
    .slice(0, RECOVERY_SAMPLE)
    .map((path) => `${path} — ${firstByPath.get(path)}`)
    .join(' / ');
  const rest = paths.length > RECOVERY_SAMPLE ? ` 외 ${paths.length - RECOVERY_SAMPLE}개 경로` : '';
  const cut = omitted > 0 ? ` 지면 관계로 ${omitted}건의 사유를 생략했습니다.` : '';
  return (
    `패치를 적용하기 전에 사람이 다음을 직접 확인하세요: ${sample}${rest}.${cut} ` +
    '이런 파일은 적용하는 순간이 아니라 그 뒤의 실행에서 발화합니다.'
  );
}

/**
 * ## 잔여 위험 — 이 검사가 **못 막는** 것
 *
 * 열거는 뒤처진다(계획 2 Task 3 의 교훈). 지금 통과하는 것 중 알려진 것:
 *
 *   - `package.json` 의 `scripts` — `baseline` 이 있으면 scripts 블록만 대조하고, 없으면
 *     파일 존재만으로 보수적으로 플래그한다(계획 2 이월 3). `src/engine.mjs` 의 두
 *     호출부는 커밋-ish 를 준다. 그리고 대조하는 것은 `scripts` 블록뿐이라, `npm` 이 실행하는 다른 자리
 *     (`config`·`workspaces`·`packageManager`)는 여전히 안 본다.
 *   - `setup.py`·`conftest.py`·`Makefile`·`build.gradle` 등 빌드/테스트가 실행하는 코드.
 *     소스 코드와 구분할 방법이 없다.
 *   - `.gitattributes`(filter 드라이버)·`.gitmodules`(서브모듈 URL). 둘 다 별도 설정이
 *     있어야 발화해서 넣지 않았다.
 *   - `packages.lock.json`(NuGet). 다른 lockfile 은 위 목록에 있지만 이것만 뺐다 —
 *     러너의 `dotnet test` 가 도는 암묵적 restore 가 그 파일을 정당하게 다시 쓰므로,
 *     넣으면 **우리가 한 일**로 사용자의 실행이 disputed 로 강등된다.
 *   - `.idea/`·`.cursor/` 등 다른 편집기 설정.
 *   - 소스 파일 자체에 심은 백도어. 이 모듈은 **경로만** 본다.
 *   - `collectPatch().ignoredPaths`·`gitlinks` 가 가리키는, 패치에 실리지 않은 변경.
 *   - **자동 실행 설정이라는 부류 자체가 열거로 덮이지 않는다.** 목록에 넣은 것과 같은
 *     등급인데 빠진 것이 계속 나온다 — 편집기·컨테이너·태스크 러너·CI 벤더마다 자기
 *     위치가 있고 새 도구가 계속 생긴다. 이 목록은 "알려진 자리"를 덮을 뿐이다.
 *   - **심링크 타깃**에는 `.git` 세그먼트 검사만 걸린다. 8.3 단축 이름과 `.git` 외의
 *     차단 세그먼트는 타깃 쪽에 적용되지 않는다.
 *
 * ## 이 플랫폼에서 **재현되지 않은** 경로 동등성 축 (전부 실측)
 *
 *   - **후행 점·공백** (`.github./workflows`, `.github /workflows`): Node 로 그런
 *     디렉터리를 만들 수는 있지만 git 이 그 안을 열지 못한다. 어느 쪽으로 실패하는지는
 *     워크트리 상태에 따라 갈린다(실측):
 *       · 같은 이름의 정상 디렉터리가 이미 있으면 `git add -A` 가 exit 128
 *         `fatal: adding files failed` 로 죽는다 — `collectPatch` 가 blocked 를 낸다.
 *       · 없으면 `git add -A` 가 **exit 0 으로 조용히 건너뛴다** — 그 경로는 `files` 에
 *         아예 실리지 않으므로 패치에도 없다.
 *     어느 경우든 이 검사를 우회해 파일이 떨어지지는 않는다. 그런 경로가 든 패치를 손으로
 *     만들어도 `git apply` 가 exit 128 `invalid path` 로 거부한다.
 *   - **ADS** (`normal.txt:evil`): 스트림 생성은 성공하지만 git 은 스트림을 열거하지
 *     않는다. `files` 에 `경로:스트림` 이 나오지 않는다.
 *   - **`..` 세그먼트**: git 은 저장소 루트 기준으로 정규화한 경로만 낸다. 하위
 *     디렉터리에서 `git add ../deep/c.txt` 를 해도 `deep/c.txt` 로 나온다. `..` 라는
 *     이름의 파일은 만들 수 없다.
 *   - **유니코드 NFC/NFD**: git 은 이름 바이트를 그대로 낸다(NFC 와 NFD 가 서로 다른
 *     항목으로 보인다). 위 두 목록은 전부 ASCII 라 분해형이 존재하지 않는다.
 *   - **역슬래시**: 위 `segmentsOf` 주석 참조.
 *   - **디렉터리 정션**: git 이 따라 들어가 내용을 일반 파일로 스테이징한다(120000 이
 *     아니다). 링크 자체는 패치에 실리지 않는다.
 */
