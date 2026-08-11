import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * 진짜 실행 파일. 이 순서는 PATHEXT 의 순서가 아니라 여기서 고정한다 — PATHEXT 는
 * "이 확장자가 실행 가능하다" 는 목록이지 선호 순서가 아니고, 우리는 .EXE 를 원한다.
 */
export const WINDOWS_EXECUTABLE_EXTS = Object.freeze(['.EXE', '.COM']);

/**
 * 셸을 통해서만 스폰되는 것들. 이 저장소는 셸을 쓰지 않는다.
 *
 * 실측(Node v24.18.0): `spawn('x.cmd', [], { shell: false })` 는 동기 EINVAL(errno -4071)
 * 을 던진다. `shell: true` 는 대안이 아니다 — 우리가 쓰지 않은 프롬프트 문자열에 대해
 * 명령줄 인용 규칙을 주입면으로 되살린다. `shell: false` 는 선호가 아니라 구속 조건이라,
 * shim 만 찾은 상황은 우회할 것이 아니라 행동 가능한 오류다.
 */
export const WINDOWS_SHIM_EXTS = Object.freeze(['.CMD', '.BAT']);

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Task 9 와 같은 이유의 대소문자 무시 읽기. 빈 값은 설정되지 않은 것으로 본다. */
function readEnvValue(env, name) {
  const direct = env?.[name];
  if (typeof direct === 'string' && direct !== '') return direct;

  const wanted = name.toLowerCase();
  for (const key of Object.keys(env ?? {})) {
    const value = env[key];
    if (key.toLowerCase() === wanted && typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * 존재하고, 디렉터리가 아닌지 본다.
 *
 * 디렉터리를 걸러내는 이유: PATH 에 `claude` 라는 디렉터리가 있으면 존재 검사만으로는
 * 통과하고, 그대로 스폰하면 EACCES/EISDIR 로 죽는데 원인이 여기라는 단서가 남지 않는다.
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * PATH 를 훑을 디렉터리 목록. 정규화하고, **절대 경로만** 남긴다.
 *
 * ★ 비절대 항목을 남기면 안 되는 이유: `join('.', 'git.exe')` 는 `'git.exe'` 라서
 *   구분자가 없는 이름이 그대로 결과가 된다. 그걸 스폰하면 Windows 의 libuv 가 **자식의
 *   cwd** 를 PATH 보다 먼저 뒤진다 — 이 서버의 cwd 는 호스트에게서 물려받은 값이고
 *   델리게이트에게는 대상 저장소다. 즉 저장소에 `git.exe`(또는 `claude.exe`)를 커밋해
 *   두기만 하면 임의 코드 실행이었다. 구분자가 있어도 상대 경로면 CreateProcess 가
 *   자식의 cwd 기준으로 푸는 것은 같다.
 *
 * ★ 걸러내되 **스캔은 계속한다.** 예전에는 호출부(src/git.mjs)가 "승자가 절대 경로가
 *   아니면 거부" 로 처리했는데, 그러면 앞쪽에 상대 항목이 하나만 있어도 뒤에 있는
 *   진짜 실행 파일을 못 본 채 전체가 거부됐다(실측:
 *   `PATH="relbin;C:\Program Files\Git\mingw64\bin"` -> 거부). "git 이 멀쩡히 깔려
 *   있는데 서버가 git 을 못 쓴다" 는 안전한 실패가 아니라 그냥 고장이다.
 *
 * ★ 따옴표·앞뒤 공백은 정규화해서 **받아들인다.** 실제 Windows PATH 에 흔하고
 *   CreateProcess 는 둘 다 허용한다. 걸러내면 위와 같은 이유로 멀쩡한 설치를 못 쓴다
 *   (실측: `PATH='"C:\Program Files\Git\mingw64\bin"'` 도 `PATH=' C:\... ;'` 도 거부됐다).
 */
function pathDirs(value) {
  const out = [];
  for (const raw of (value ?? '').split(delimiter)) {
    const dir = normalizePathEntry(raw);
    if (dir !== '' && isAbsolute(dir)) out.push(dir);
  }
  return out;
}

/**
 * PATH 항목 하나의 표기 정규화. 앞뒤 공백을 떼고, 감싼 따옴표를 벗긴다. 빈 항목은 `''`.
 *
 * `src/providers/child-env.mjs` 의 `compactPath` 가 이 함수를 쓴다. 두 모듈이 각자
 * 정규화하면 "PATH 항목이란 무엇인가"에 서로 다른 답을 갖게 되고, 실제로 그랬다 —
 * 여기서는 `"C:\Program Files\Git\mingw64\bin"` 을 받아들이는데 축약 쪽은 통째로 버려서,
 * 상한을 넘는 기계의 자식이 멀쩡히 깔린 도구를 잃었다(리뷰어 실측).
 */
export function normalizePathEntry(raw) {
  let dir = String(raw ?? '').trim();
  if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim();
  return dir;
}

function notFoundError(basename) {
  const error = new Error(`the ${basename} CLI was not found on PATH`);
  error.code = 'cli_not_found';
  error.binaryName = basename;
  return error;
}

function shimOnlyError(basename, shimPath) {
  const error = new Error(`only a shell shim for the ${basename} CLI was found: ${shimPath}`);
  error.code = 'cli_shim_only';
  error.binaryName = basename;
  error.shimPath = shimPath;
  return error;
}

/**
 * 벤더 CLI 의 실행 파일 경로를 찾는다.
 *
 * 해석은 호출 시점마다 다시 한다. 캐시하지 않는 이유: 이 서버가 도는 동안 CLI 가
 * 설치될 수 있는데, import 시점에 "없음"을 캐시한 프로바이더는 호스트를 재시작할
 * 때까지 계속 고장 난 채로 남는다.
 *
 * @param basename     확장자 없는 실행 파일 이름 ('claude', 'codex')
 * @param execPathVar  경로를 직접 지정하는 환경변수 이름. 없으면 null — codex 에는
 *                     그런 관례가 없으므로 claude 의 변수를 잘못 쓰지 않게 한다.
 * @param env          환경 (기본 process.env). 인자로 받는 이유는 테스트 가능성.
 * @param platform     기본 process.platform. 주입받는 이유는, 모듈 최상단에서 한 번
 *                     계산하면 어느 기계에서 돌리든 두 분기 중 하나는 영영 검증되지
 *                     않기 때문이다.
 */
export function resolveBinary({
  basename,
  execPathVar = null,
  env = process.env,
  platform = process.platform,
} = {}) {
  const windows = platform === 'win32';

  if (typeof execPathVar === 'string' && execPathVar !== '') {
    const pinned = readEnvValue(env, execPathVar);
    // ★ `isAbsolute` 가 `isFile` 앞에 있어야 한다. `isFile('claude.exe')` 는 **우리
    //   프로세스의 cwd** 기준으로 풀리므로, 대상 저장소를 cwd 로 물려받은 상태에서는
    //   그 저장소에 커밋된 파일이 통과한다. 그리고 구분자 없는 이름을 그대로 스폰하면
    //   Windows 의 libuv 가 다시 자식의 cwd 를 PATH 보다 먼저 뒤진다 — pathDirs 가
    //   PATH 항목에서 막은 그 구멍이 이 분기로 되살아나 있었다(실측:
    //   CLAUDE_CODE_EXECPATH='claude.exe' -> resolveLaunch = { command: 'claude.exe' }).
    //
    //   거부하고 멈추지 않고 **PATH 로 넘어간다.** 낡은 값 처리와 같은 방침이다 —
    //   환경변수 하나가 이상하다고 멀쩡히 깔린 CLI 를 못 쓰게 만드는 것은 안전한
    //   실패가 아니라 그냥 고장이다(pathDirs 주석의 같은 판단).
    if (typeof pinned === 'string' && isAbsolute(pinned) && isFile(pinned)) {
      // 자기도 shim 으로 실행된 부모가 이 값을 물려준다. 스폰할 수 없는 것을 스폰하려
      // 들지 말고 PATH 워크와 같은 오류를 낸다.
      const upper = pinned.toUpperCase();
      if (windows && WINDOWS_SHIM_EXTS.some((ext) => upper.endsWith(ext))) throw shimOnlyError(basename, pinned);
      return pinned;
    }
    // 가리키는 파일이 없으면(업데이트 뒤 낡은 값) 실패하지 않고 PATH 로 넘어간다.
  }

  const dirs = pathDirs(readEnvValue(env, 'PATH'));

  if (!windows) {
    for (const dir of dirs) {
      const candidate = join(dir, basename);
      if (isFile(candidate)) return candidate;
    }
    throw notFoundError(basename);
  }

  // PATHEXT 가 선언한 것만 시도한다. 그 목록에 없는 확장자는 이 기계에서 실행 가능한
  // 것이 아니고, 목록에 있어도 실행 파일도 shim 도 아닌 것(.VBS, .JS …)은 우리 관심 밖이다.
  const declared = new Set(
    (readEnvValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').map((e) => e.trim().toUpperCase()).filter((e) => e !== ''),
  );
  const executableExts = WINDOWS_EXECUTABLE_EXTS.filter((e) => declared.has(e));
  const shimExts = WINDOWS_SHIM_EXTS.filter((e) => declared.has(e));

  // shim 은 기억만 하고 계속 훑는다. 디렉터리마다 "실행 파일 아니면 shim" 으로 판정하면
  // 앞쪽 디렉터리의 .cmd 때문에 뒤쪽의 진짜 .exe 를 못 찾는다.
  let firstShim = null;

  for (const dir of dirs) {
    for (const ext of executableExts) {
      const candidate = join(dir, basename + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
    if (firstShim === null) {
      for (const ext of shimExts) {
        const candidate = join(dir, basename + ext.toLowerCase());
        if (isFile(candidate)) {
          firstShim = candidate;
          break;
        }
      }
    }
  }

  if (firstShim !== null) throw shimOnlyError(basename, firstShim);
  throw notFoundError(basename);
}

/**
 * npm 셈이 감싸고 있는 node 스크립트를 꺼낸다. 못 꺼내면 null.
 *
 * ★ 왜 필요한가 (실측): Windows 에서 codex 를 npm 전역 설치하면 PATH 에는
 *   `codex.cmd`/`codex.ps1`/`codex`(sh) 만 놓이고, 진짜 `codex.exe` 는
 *   `node_modules/@openai/codex/node_modules/@openai/codex-<platform>/vendor/.../bin/`
 *   깊숙이 들어가 PATH 에 없다. 그래서 resolveBinary 는 cli_shim_only 를 던지고,
 *   `shell: false` 가 구속 조건인 이 저장소에서는 codex 를 아예 못 띄우게 된다.
 *
 *   그런데 셈 파일 자체가 대상 경로를 담고 있다:
 *     codex.cmd -> "%dp0%\node_modules\@openai\codex\bin\codex.js"
 *     codex(sh) -> "$basedir/node_modules/@openai/codex/bin/codex.js"
 *   그걸 읽어 `node <script>` 로 띄우면 셸을 거치지 않는다. 명령줄 인용이 주입면으로
 *   되살아나지 않으므로 shim 을 거부한 이유와도 충돌하지 않는다 — 우리가 거부한 것은
 *   "셸을 통해야만 실행되는 것"이지 "npm 이 감싼 node 스크립트"가 아니다.
 *
 * 스크립트가 실제로 존재하는지까지 확인한다. 셈이 가리키는 대상이 지워졌을 수 있다.
 */
export function resolveThroughShim(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  const dir = dirname(shimPath);
  // 셈이 쓰는 디렉터리 자리표들. 벗겨내고 셈이 있는 디렉터리 기준으로 되돌린다.
  const PLACEHOLDERS = /^(?:%~?dp0%|\$basedir|\$\{basedir\}|\.)[\\/]?/;

  for (const match of text.matchAll(/[^\s"'()]+\.(?:js|mjs|cjs)\b/g)) {
    const raw = match[0].replace(PLACEHOLDERS, '');
    if (raw === '') continue;
    const candidate = isAbsolute(raw) ? raw : resolve(dir, raw);
    if (isFile(candidate)) {
      // node 로 띄운다. 셸은 여전히 쓰지 않는다.
      return { command: process.execPath, prefixArgs: [candidate] };
    }
  }
  return null;
}

/**
 * 벤더 CLI 를 **어떻게 띄울지** 정한다. resolveBinary 보다 한 겹 위다.
 *
 * 보통은 `{ command: <실행 파일>, prefixArgs: [] }` 를 낸다. PATH 에 셈밖에 없으면
 * 그 셈이 감싼 node 스크립트를 꺼내 `{ command: node, prefixArgs: [script] }` 를 낸다.
 * 둘 다 안 되면 resolveBinary 가 던진 오류를 그대로 올린다 — 그때는 정말 행동 가능한
 * 오류가 맞다.
 */
export function resolveLaunch(options = {}) {
  try {
    return { command: resolveBinary(options), prefixArgs: [] };
  } catch (error) {
    if (error?.code !== 'cli_shim_only' || typeof error.shimPath !== 'string') throw error;

    const throughShim = resolveThroughShim(error.shimPath);
    if (throughShim) return throughShim;

    // 셈은 찾았는데 그 안에서 띄울 수 있는 것을 못 꺼냈다. 원래 오류가 여전히 맞다.
    throw error;
  }
}
