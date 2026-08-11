// 자식 프로세스 환경 조립. 두 프로바이더가 공유한다.
//
// ★ 이 파일의 가장 중요한 성질: 자식은 이 세션의 정체성을 물려받으면 안 된다.
//   호스트가 CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION=1,
//   CLAUDE_EFFORT, CLAUDE_CODE_EXECPATH 를 이 프로세스에 내보낸다. 그것을 물려받은
//   자식은 자기가 **이 세션이라고 믿는다**.
//
//   그래서 buildChildEnv 는 `{}` 에서 시작해 allowlist 만 복사한다.
//   `{...process.env, X: y}` 가 함정이다 — Node 의 spawn({env}) 는 환경을 이미
//   **교체**하므로 스프레드는 필요 없고 오직 새기만 한다.
//
//   denylist 가 아니라 allowlist 인 이유: denylist 는 호스트가 새 변수를 내보낼
//   때마다 갱신해야 하고, 빠뜨렸을 때의 실패 모드가 "부모를 사칭하는 자식"이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// ★★ 이 함수는 격리 장치가 **아니다** — S1 잔여 실측 표 (계획 3 태스크 12)
//
// 전부 이 기계에서 직접 쟀다: Windows 11 Pro 10.0.26200 · node v24.18.0 x64 ·
// python 3.14.6 · dotnet 10.0.302 · 커밋 49acbde · 2026-08-11. 다른 OS 에서는
// 다시 재야 한다 — 아래 절반은 Windows 고유 동작이다.
//
// ## 막는 것 (실측)
//
//   · **벤더 인증 변수.** 이 제품은 구독 인증만 쓴다. 원본 env 에 `ANTHROPIC_API_KEY`·
//     `OPENAI_API_KEY`·`CLAUDE_CODE_OAUTH_TOKEN` 등 아홉 이름을 **심어 놓고** 재도
//     `authNames: []` 로 지은 자식 env 에는 하나도 없고, 실제로 띄운 자식의
//     `process.env` 에서도 전부 `undefined` 였다. 테스트 러너가 그 형태로 부른다.
//     (덧붙여, 이 개발 기계에는 그 아홉 이름이 애초에 **하나도 설정돼 있지 않다** —
//     릴레이 프록시가 막을 raw 키가 존재하지 않는다. 설계 §5.8 S1 참조.)
//   · **호스트 세션 정체성** — `CLAUDECODE`·`CLAUDE_CODE_SESSION_ID` 등. 같은 실측에서
//     자식이 전부 `undefined` 를 받았다.
//
// ## 못 막는 것 (전부 실측)
//
//   · **libuv 가 부모 변수를 되돌려 놓는다.** `spawn(node, {env:{}})` 로 띄운 자식이
//     받은 키가 **11개**였다: HOMEDRIVE · HOMEPATH · LOGONSERVER · PATH · SYSTEMDRIVE ·
//     SYSTEMROOT · TEMP · USERDOMAIN · USERNAME · USERPROFILE · WINDIR. 우리 allowlist
//     로 지은 env(17키)로 띄우면 그중 **여섯**(HOMEDRIVE · HOMEPATH · LOGONSERVER ·
//     USERDOMAIN · USERNAME · WINDIR)이 우리가 안 넣었는데도 자식에 있었다.
//     → 그러므로 **`buildChildEnv` 의 출력이 곧 자식의 env 가 아니다.** 이 함수는 자기가
//       고른 것만 담아 돌려주고(위 8행의 진술은 그대로 참이다), 자식이 실제로 받는 것은
//       거기에 libuv 가 되돌려 놓은 위 이름들을 **더한** 집합이다. 이 파일을 읽고 자식의
//       환경을 추론하려는 사람은 그 차이를 알아야 한다. 벤더 인증 이름이 그 11개에 없으므로
//       S1 결론 자체는 안 흔들린다.
//     → `USERPROFILE` 은 **덮어쓸 수는 있어도 지울 수는 없다** — 빼고 스폰해도 부모 값이
//       되돌아온다(실측).
//   · **자격증명 파일.** `USERPROFILE` 을 `C:\FAKEPROF` 로 돌린 자식이
//     `~/.claude/.credentials.json`(509바이트)과 `~/.codex/auth.json`(4,506바이트)을
//     **절대 경로로 그대로 읽었다.** 같은 사용자 토큰이고 OS 샌드박스가 없다.
//   · **`USERPROFILE` 만 돌리면 순진한 경로도 안 빗나간다.** 그 자식에서
//     `HOMEDRIVE`+`HOMEPATH` 를 이으면 원래 `%USERPROFILE%` 이 나오고, 그 경로로 자격증명 파일이
//     **읽혔다**(509바이트).
//     ⚠ 이것은 회전을 포기할 근거가 **아니다** — 셋(`USERPROFILE`·`HOMEDRIVE`·`HOMEPATH`)을
//     함께 돌리면 이 우회로는 **막힌다**(실측, 수정 라운드 1: 이음이 `Z:\FAKEPROF` 가 되고
//     자격증명 읽기가 ENOENT). 그러니 이 줄이 말하는 것은 「어설픈 회전이 새는 자리」이지
//     「회전이 무의미하다」가 아니다. **좁히지 않는 진짜 근거는 바로 위의 절대 경로 접근**
//     이다 — 경로 변수를 몇 개 돌리든 원래 `%USERPROFILE%\...` 를 그대로 여는 자식을 막을 것이
//     이 프로세스에는 없다.
//   · **Windows 에서 `HOME` 은 무의미하다.** `HOME` 만 돌리면 node `os.homedir()` 도
//     python `expanduser('~')` 도 **안 움직인다**(둘 다 원래 `%USERPROFILE%`). `USERPROFILE` 을
//     돌리면 둘 다 따라 움직인다. `HOME` 을 아예 빼도 결과가 같다.
//
// ## `USERPROFILE` 회전의 대가 — 이제 "재지 않았다" 가 아니다
//
//   · **pip 캐시가 워크트리 안으로 들어온다.** `USERPROFILE` 을 돌린 자식에서
//     `pip cache dir` 이 `<cwd>\pip\cache` 를 냈다 — cwd 를 바꿔 가며 두 번 확인했다
//     (cwd=저장소 → `<repository>\pip\cache`, cwd=Temp → `<temp>\pip\cache`). 원본에서는 둘 다
//     `%LOCALAPPDATA%\pip\cache` 다. 내부적으로 `platformdirs.user_cache_dir`
//     이 `.\pip\pip\Cache` 라는 **상대 경로**를 돌려주고 있었다(`LOCALAPPDATA` 는 그때도
//     올바른 값이었다). 즉 회전은 지키는 것 없이 도구의 캐시를 델리게이트의 작업
//     디렉터리로 옮긴다.
//   · **NuGet 은 아예 안 흔들린다.** `dotnet nuget locals all --list` 가 회전 전후로
//     **똑같은 네 경로**를 냈다(`global-packages: %USERPROFILE%\.nuget\packages\` 포함).
//     막지도 못하고 깨뜨리지도 못한다.
//   · 얻는 것이 없고 잃는 것은 실측됐다. **그래서 좁히지 않는다.**
//
// ## 재지 않은 것 (적어 두지 않으면 다음 사람이 잰 줄 안다)
//
//   · `~/.dotnet`·`~/.cargo`·`~/.m2` 는 재지 않았다.
//   · `~/.gitconfig` 는 **재려다 못 쟀다** — 이 기계에는 전역 git 설정이 아예 없어
//     (`git config --global --list` 가 회전 전후 모두 exit 128 · 0항목) 회전이 그것을
//     깨뜨리는지 판정할 대조군이 없었다.
//   · npm 캐시는 못 쟀다 — `npm.cmd` 는 `shell:false` 로 스폰할 수 없다(EINVAL, node 24).
//     이 저장소가 `shell:false` 를 강제하므로 우리 자식은 어차피 그 형태로 못 부른다.
//   · POSIX 에서의 값은 하나도 재지 않았다.
//
// 그래서 좁히지 않고 **신고한다** — `src/test-runner.mjs` 가 테스트 실행 결과에
// `USER_PRIVILEGE_NOTE` 를 실어, 이 스위트가 사용자 권한으로 돌았다는 사실을 봉투가
// 한 번 말한다.
// ─────────────────────────────────────────────────────────────────────────────

import { statSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { normalizePathEntry } from './resolve-binary.mjs';

/**
 * `cmd.exe` 가 값을 볼 수 있는 환경 변수의 최대 길이(문자).
 *
 * 실측(Windows 11, Node v24.18.0). PATH 전용 제약이 **아니다** — 대조군 변수로 같은
 * 경계가 나온다:
 *
 *     PATH   8,191자 -> cmd 가 정상적으로 명령을 찾는다
 *     PATH   8,192자 -> cmd 에게는 빈 값. `'node' 을(를) 찾을 수 없습니다`
 *     BIGVAR 8,192자 -> cmd 의 `echo %BIGVAR%` 가 "ECHO 가 설정되어 있습니다"(= 빈 값)
 *     BIGVAR 20,000자 -> **자식 프로세스**는 20,000자를 온전히 받는다
 *
 * 즉 값 자체는 환경 블록으로 온전히 전달되고, **`cmd` 만 그 변수를 못 본다.**
 * 그래서 셸을 거치지 않는 자식은 멀쩡하고, 내부에서 셸을 띄우는 자식만 깨진다
 * (`node --run`, `npm run`, 그리고 벤더 CLI 가 셸을 쓰는 경우).
 *
 * ⚠ 8,189~8,191자 구간에서 `echo %PATH%` 가 "입력 줄이 너무 깁니다"를 내는 것은 다른
 *   한계다 — 값을 명령줄로 **전개**해서 cmd 의 명령줄 길이 상한을 넘긴 것이고, 변수
 *   자체는 멀쩡하다. 같은 크기에서 `node --version` 은 정상 동작한다(실측). 두 한계를
 *   뭉개면 경계를 잘못 잡는다.
 */
export const CMD_ENV_VALUE_LIMIT = 8_191;

/**
 * 자식에게 물려줄 PATH 를 정리한다. **상한을 넘을 때만** 손댄다.
 *
 * 왜 필요한가: 이 기계의 PATH 는 172항목 / 13,839자였고, 그대로 물려받은 자식이
 * 셸을 띄우면 그 셸에서 PATH 가 통째로 사라졌다(위 상수 주석).
 *
 * 무엇을 버리는가 — 버려도 명령 해석 결과가 달라지지 않는 것만이다:
 *   · 빈 항목 (Windows 에서 이것은 "자식의 cwd" 를 뜻한다)
 *   · 앞선 항목과 같은 디렉터리 (뒤쪽 중복은 어차피 도달하지 않는다)
 *   · 절대 경로가 아닌 항목 (존재 여부를 우리 cwd 기준으로밖에 못 재고, 그렇게 재는
 *     것 자체가 틀렸다). 판정 전에 `normalizePathEntry` 로 따옴표를 벗긴다 —
 *     `path.isAbsolute('"C:\\Program Files\\..."')` 는 false 라, 벗기지 않으면 살아 있는
 *     디렉터리를 "절대 경로가 아님"으로 버렸다(리뷰어 실측).
 *   · **존재하지 않는 디렉터리** — 실측으로 이 기계에서 172개 중 142개가 여기 해당했고,
 *     걷어내면 29항목 / 1,116자가 된다. 없는 디렉터리는 어떤 명령도 낼 수 없으므로
 *     빼도 깨지는 것이 없다. 이것이 이 전략이 안전한 근거다.
 *
 * 순서는 보존한다 — 어느 도구가 이기는지가 순서로 정해진다.
 *
 * 정리하고도 상한을 넘으면 **자르지 않는다.** 자르면 뒤쪽 디렉터리의 도구를 조용히
 * 잃고, 그 증상은 "왜인지 모르게 테스트만 실패"로 나타난다. `stillOverLimit` 으로
 * 알리고 값은 그대로 둔다.
 *
 * 항목이 **하나도 안 남으면**(`allDropped`) 축약이 통째로 무력한 것이다. 그때는 빈 PATH
 * 대신 원본을 그대로 내고 그 사실을 신고한다 — 빈 PATH 를 물려준 자식은 아무 명령도 못
 * 풀고, 그 증상의 원인이 우리라는 단서가 남지 않는다.
 *
 * @param prepend 맨 앞에 둘 절대 경로들. 뒤쪽의 같은 항목은 빠진다.
 */
export function compactPath(rawPath, options = {}) {
  const raw = typeof rawPath === 'string' ? rawPath : '';
  const windows = (options.platform ?? process.platform) === 'win32';
  const limit = options.limit ?? CMD_ENV_VALUE_LIMIT;
  const prepend = Array.isArray(options.prepend) ? options.prepend.filter((d) => typeof d === 'string' && d !== '') : [];

  const rawEntries = raw === '' ? [] : raw.split(delimiter);
  let entries = rawEntries;
  if (prepend.length > 0) {
    const front = new Set(prepend.map((d) => foldPathKey(d, windows)));
    entries = [...prepend, ...rawEntries.filter((d) => !front.has(foldPathKey(d, windows)))];
  }

  const base = {
    originalChars: raw.length,
    originalEntries: rawEntries.length,
    duplicatesDropped: 0,
    missingDropped: 0,
    stillOverLimit: false,
    allDropped: false,
  };

  const joined = entries.join(delimiter);
  // 상한 아래면 그대로 둔다. 멀쩡한 PATH 를 다시 쓰는 것 자체가 새 실패 모드다.
  if (!windows || joined.length <= limit) {
    return { ...base, value: joined, chars: joined.length, entries: entries.length, cleaned: false };
  }

  const seen = new Set();
  const kept = [];
  let duplicatesDropped = 0;
  let missingDropped = 0;
  for (const entry of entries) {
    const dir = normalizePathEntry(entry);
    if (dir === '' || !isAbsolute(dir)) {
      missingDropped += 1;
      continue;
    }
    const key = foldPathKey(dir, windows);
    if (seen.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(key);
    if (!isDirectorySync(dir)) {
      missingDropped += 1;
      continue;
    }
    kept.push(dir);
  }

  const allDropped = kept.length === 0 && entries.length > 0;
  const value = allDropped ? joined : kept.join(delimiter);
  return {
    ...base,
    value,
    chars: value.length,
    entries: allDropped ? entries.length : kept.length,
    duplicatesDropped,
    missingDropped,
    cleaned: !allDropped,
    allDropped,
    stillOverLimit: value.length > limit,
  };
}

/** 비교용 표기 정규화. Windows 만 대소문자를 접는다(POSIX 에서는 유의미하다). */
function foldPathKey(dir, windows) {
  const trimmed = String(dir).trim().replace(/[\\/]+$/, '');
  return windows ? trimmed.toLowerCase() : trimmed;
}

/**
 * 동기 `stat`. 이 함수 전체가 동기인 이유는 `buildChildEnv` 가 동기이고, 그것을 비동기로
 * 바꾸면 모든 스폰 경로가 따라 바뀌기 때문이다. 비용은 잤다: 이 기계의 172항목에
 * `statSync` 4.2ms 이고, 그나마 상한을 넘길 때만 돈다.
 */
function isDirectorySync(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 사람이 읽을 축약 사실. 봉투를 가진 호출부만 이 채널을 쓴다. */
function pathNotes(result, limit) {
  const notes = [];
  if (result.allDropped) {
    notes.push(
      `PATH 가 ${result.originalChars}자여서 줄이려 했지만 모든 항목(${result.originalEntries}개)이 ` +
        '걸러져 남는 것이 없었습니다 — 빈 PATH 를 물려주지 않으려고 원본을 그대로 넘겼습니다.',
    );
  }
  if (result.cleaned) {
    notes.push(
      `PATH 가 ${result.originalChars}자여서 ${result.chars}자로 줄였습니다 ` +
        `(중복 ${result.duplicatesDropped}개, 존재하지 않거나 절대 경로가 아닌 항목 ${result.missingDropped}개 제거) — ` +
        `cmd.exe 는 ${limit}자를 넘는 환경 변수를 빈 값으로 봅니다.`,
    );
  }
  if (result.stillOverLimit) {
    notes.push(
      `정리한 뒤에도 PATH 가 ${result.chars}자로 상한을 넘습니다 — 잘라내면 뒤쪽 디렉터리의 도구를 ` +
        '조용히 잃으므로 그대로 뒀습니다. 자식이 셸을 띄우면 그 셸에서 PATH 가 비어 보입니다.',
    );
  }
  return notes;
}

/**
 * OS 기본 + 네트워크 + 로케일. 벤더와 무관하게 항상 통과한다.
 *
 * allowlist 의 목적은 **벤더 인증과 호스트 세션 정체성**을 막는 것이지 플랫폼 기본
 * 변수를 막는 것이 아니다. "적을수록 좋다"로 읽으면 도구가 부팅조차 못 하고, 그 실패가
 * "스위트가 실패했다"로 보고된다.
 */
export const BASE_ALLOWLIST = Object.freeze([
  // 프로세스가 시작하려면 필요한 것
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT',
  // Windows 의 기본 설치 위치. MSBuild/NuGet 이 머신 와이드 설정 경로를 이것으로 만든다.
  // 실측: 이 중 ProgramFiles 하나만 빠져도 `dotnet restore` 가
  // `NuGet.targets(782,5): error : Value cannot be null. (Parameter 'path1')` 로 죽는다
  // (env 만 이분해 확인). 32/64비트 두 갈래와 SDK 가 읽는 머신 와이드 경로가 각각
  // 다른 변수를 쓰므로 같은 부류를 함께 넣는다. 인증 변수가 아니라 S1 표면과 무관하다.
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemDrive',
  // 네트워크에 닿을 수 있는지를 결정하는 것. 이게 빠지면 회사 프록시 뒤의 사용자는
  // 자기 CLI 는 잘 되는데 델리게이트만 설명 없이 연결 실패한다. 사내 TLS 가로채기
  // 인증서도 같은 증상·같은 원인이라 같이 통과시킨다.
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // 사용자가 고른 언어
  'LANG', 'LC_ALL',
]);

/**
 * 프록시 변수는 대문자·소문자 두 철자를 다 내보낸다.
 *
 * readEnvValue 가 대소문자 무시로 읽어 표준 철자 하나로만 넣으면, `https_proxy` 만
 * 설정해둔 POSIX 사용자의 자식은 `HTTPS_PROXY` 만 받는다. 그런데 소문자 철자만 읽는
 * 도구가 흔하다(curl 계열). 그러면 프록시가 설정돼 있는데도 델리게이트만 조용히
 * 직결을 시도하다 실패한다 — 위 주석이 말한 최악의 증상 그대로다. 둘 다 넣는 비용은
 * 없으니 이 부류를 통째로 없앤다.
 */
const DUAL_CASE = Object.freeze(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']);

/**
 * claude 인증·설정 이름. 구독 사용자는 이 중 아무것도 설정돼 있지 않고
 * CLAUDE_CONFIG_DIR/키체인에서 인증한다 — 통과시키는 것이 요점이다.
 */
export const CLAUDE_AUTH_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR',
]);

/**
 * codex 인증·설정 이름. ChatGPT 로그인 인증은 CODEX_HOME 아래 파일에 있어
 * 별도 env 이름이 없다 — CODEX_HOME 만 통과시키면 된다.
 */
export const CODEX_AUTH_NAMES = Object.freeze([
  'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
]);

/**
 * 하나의 변수를 대소문자 무시로 읽어 allowlist 의 표준 철자로 돌려준다.
 *
 * Windows 환경변수 이름은 대소문자를 안 가리고 process.env 자체도 그렇게 동작하지만
 * (process.env.PATH 는 실제 키가 Path 여도 된다) 평범한 객체는 아니다. 스냅샷이나
 * 테스트 픽스처를 넘기면 PATH 없는 자식이 만들어지고, spawn 이 오해를 부르는
 * ENOENT 로 죽는다. 한 번 훑는 비용으로 그 신고 부류가 통째로 사라진다.
 *
 * 빈 문자열은 "설정되지 않음"으로 본다. 껍데기만 있는 값을 넘기면 상황이 나빠지기만
 * 한다: 빈 프록시는 도구에 따라 "프록시 없음"이 아니라 "이 URL 로 프록시하라"로 읽히고
 * (이 파일이 프록시를 통과시키는 이유가 그 실패를 막으려는 것이다), 빈 API 키는 CLI 가
 * 구독 인증으로 넘어가는 대신 빈 키로 인증을 시도하다 실패하게 만든다. 셸에서 `VAR=`
 * 로 "지웠다"고 생각한 사용자의 의도와도 일치한다.
 */
function readEnvValue(env, name) {
  const direct = env[name];
  if (typeof direct === 'string' && direct !== '') return direct;

  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (key.toLowerCase() === wanted && typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * 자식 환경을 **빈 객체에서** 만든다.
 *
 * @param env         원본 환경 (보통 process.env). 인자로 받는 이유는 테스트 가능성 —
 *                    실제 프로세스에 CLAUDECODE=1 을 설정하지 않고도 그것이 안 새는
 *                    것을 증명할 수 있다.
 * @param authNames   이 벤더의 인증·설정 변수 이름
 * @param runId       있으면 BOM_ORCH_RUN_ID 로 스탬프. reaper 원장의 소유권 식별 근거
 *                    이자 중첩 실행 탐지용
 * @param extra       계산된 값(예: 릴레이 프록시의 BASE_URL). allowlist 를 우회한다
 * @param pathPrepend PATH 맨 앞에 둘 절대 경로들 (`compactPath` 의 prepend)
 * @param notes       주면 PATH 축약 사실을 사람이 읽을 문장으로 밀어 넣는다.
 *                    **자식 환경에는 아무것도 더하지 않는다** — 봉투를 가진 호출부만
 *                    쓰는 곁가지 채널이다. 이 모듈은 stdout 에 쓸 수 없고(MCP stdio)
 *                    봉투도 만들지 않으므로, 사실을 밖으로 낼 다른 자리가 없다.
 */
export function buildChildEnv(
  env = process.env,
  { authNames = [], runId, extra, pathPrepend, notes, platform } = {},
) {
  const childEnv = {}; // ★ 빈 객체에서 시작 — 절대 `{...env}` 가 아니다

  for (const name of [...BASE_ALLOWLIST, ...authNames]) {
    const value = readEnvValue(env, name);
    if (value !== undefined) childEnv[name] = value;
  }

  for (const name of DUAL_CASE) {
    if (childEnv[name] !== undefined) childEnv[name.toLowerCase()] = childEnv[name];
  }

  // PATH 가 없으면 만들어내지 않는다 — prepend 를 요구한 호출부에만 새로 세운다.
  if (childEnv.PATH !== undefined || (Array.isArray(pathPrepend) && pathPrepend.length > 0)) {
    const compacted = compactPath(childEnv.PATH ?? '', { platform, prepend: pathPrepend });
    // 빈 값만 거른다. `allDropped` 는 compactPath 가 이미 원본으로 되돌려 놓았고,
    // pathNotes 가 그 사실을 말한다 — 값과 보고가 어긋나지 않아야 한다.
    if (compacted.value !== '') childEnv.PATH = compacted.value;
    if (Array.isArray(notes)) notes.push(...pathNotes(compacted, CMD_ENV_VALUE_LIMIT));
  }

  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') childEnv[key] = value;
    }
  }

  // extra 다음에 찍는다. 이 값은 reaper 가 고아 프로세스의 소유권을 판정하는 근거라,
  // 호출부가 실수로 같은 이름을 extra 에 넣어도 덮이면 안 된다.
  if (typeof runId === 'string' && runId !== '') childEnv.BOM_ORCH_RUN_ID = runId;

  // ★ 자식의 cwd 를 실행 파일 탐색에서 뺀다.
  //
  //   실측: 워크트리 루트에 `node.cmd` 를 놓고 `node --run test` 를 띄우면 그 `.cmd` 가
  //   실행된다. PATH 첫 항목이 진짜 `C:\Program Files\nodejs` 여도 그렇다 — libuv 의
  //   Windows 탐색이 자식 cwd 를 PATH 보다 먼저 본다. 우리가 절대 경로로 스폰하는 것은
  //   우리 자신의 실행 파일만 고정할 뿐, 그 자식이 다시 푸는 이름에는 닿지 않는다.
  //   이 변수를 세우면 그 탐색에서 cwd 가 빠진다(같은 픽스처: 하이재킹 -> 진짜 스위트).
  //
  //   상속이 아니라 **명시**인 이유: 이 파일은 빈 객체 + allowlist 라 부모에 있어도
  //   자식에 닿지 않는다. 개발 머신에는 이 변수가 설정돼 있어서, 상속에 기대면 여기서만
  //   초록이고 사용자 기계에서는 뚫린다. extra 다음에 찍어 호출부가 덮지 못하게 한다.
  //
  //   POSIX 에는 이런 탐색이 없으므로 이 변수도 아무 뜻이 없다(무해). 플랫폼으로 가르면
  //   어느 기계에서 돌리든 두 갈래 중 하나는 영영 검증되지 않으므로 가르지 않는다.
  //
  //   ⚠ **대가가 있다**(실측). 루트에 헬퍼를 커밋해 두고 맨이름으로 부르는 평범한 Windows
  //     프로젝트가 깨진다 — `"test":"runtests"` + 루트 `runtests.cmd` 는 이 변수가 있으면
  //     exit 1 `'runtests'…내부 또는 외부 명령…`, 없으면 exit 0 `HELPER RAN` 이다.
  //     `".\runtests.cmd"` 처럼 경로 구분자를 붙인 형태만 산다. 그래도 세우는 이유는 그
  //     동작(자식 cwd 를 실행 파일 탐색에 넣는 것)에 기대는 것이 곧 공격 표면이기
  //     때문이다. 대신 조용히 깨지면 안 된다 — `src/test-runner.mjs` 의
  //     `cwdLookupWarning` 이 그 형태를 실행 전에 알아보고 봉투에 사유를 싣는다.
  childEnv.NoDefaultCurrentDirectoryInExePath = '1';

  return childEnv;
}
