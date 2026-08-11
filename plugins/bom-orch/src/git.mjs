import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveBinary } from './providers/resolve-binary.mjs';
import { resolveStateRoot } from './state-root.mjs';

/**
 * 하드닝된 git 실행기 + 저장소 사전 점검.
 *
 * ★ 왜 실행기를 하나로 강제하는가 (설계 S2·S3): 워크트리 안의 git 호출 하나라도
 *   하드닝 플래그를 빼먹으면 저장소가 심어둔 hook 이나 core.fsmonitor 가 명령 실행
 *   싱크가 된다 — CVE-2026-40068 이 실증한 체인이다. "잊지 말자"로는 안 되고,
 *   `test/guards/no-raw-git.test.mjs` 가 이 파일 밖의 raw git 스폰을 소스에서 막는다.
 *   그래서 이 프로세스 안에서 git 을 스폰하는 코드는 이 파일이 유일해야 한다.
 *
 * ## ★ 이 하드닝이 막지 **못하는** 것 (잔여 위험 — **알려진 것**만 적는다)
 *
 * 이 목록은 완전하지 않다. "실측으로 전부 발화시켰다"고 적어 두었다가 `diff.<drv>.textconv`
 * 가 빠져 있었던 전례가 있다 — 그건 `--no-ext-diff` 를 그대로 통과하는 별개의 명령 실행
 * 싱크였고, 목록의 완전성을 확언한 문장이 그 사실을 덮었다. 그래서 완전성은 확언하지
 * 않는다. 아래는 전부 대상 저장소의 `.git/` 안(config · `.gitattributes` · `info/`)
 * 만으로 심을 수 있다. 여기 적는 이유는, 막았다고 착각하면 그 위에 올라가는 태스크가
 * 잘못된 전제를 갖기 때문이다. **실제 격리는 이 플래그들이 아니라 일회용 워크트리
 * (파일시스템 범위)에 의존한다.**
 *
 * - `filter.<x>.clean` — `git add -A` 가 발화시킨다. 실행됨.
 * - `filter.<x>.smudge` — 체크아웃(`worktree add --detach` 포함)이 발화시킨다. 실행됨.
 *   filter 계열에는 "전부 끄기" 스위치가 없다. 정상 저장소의 정당한 기능이라 통째로
 *   끌 수도 없다. 그래서 막으려 들지 않고 여기 잔여 위험으로 남긴다.
 * - `diff.external` — `git diff` 가 발화시킨다. `diff` 서브커맨드에서만 막는다
 *   (아래 SUBCOMMAND_HARDENING 참조). 다른 서브커맨드에서는 발화하지 않는다(실측).
 * - `diff.<drv>.textconv` — `.gitattributes` 의 `*.txt diff=<drv>` 와 짝지어 심는다.
 *   `diff` · `log` · `show` · `blame` 에서 막는다(SUBCOMMAND_HARDENING). 그 넷 밖의
 *   서브커맨드에서는 여전히 산다 — 아래 두 항목이 실제 사례다.
 * - `git difftool -y` — 저장소가 `diff.tool` + `difftool.<t>.cmd` 를 심어 두면 그 명령이
 *   실행된다(실측: 발화함). `--no-ext-diff --no-textconv` 를 함께 주면 발화하지 않았다.
 *   지금 부르는 서브커맨드에 없어 노출은 없다. 부르게 되면 그 자리에 넣어야 한다.
 * - `git range-diff` — textconv 가 발화한다. **`--no-textconv` 로 막히지 않았다**(실측:
 *   플래그를 앞에 놓든 뒤에 놓든 발화함; `-c diff.<drv>.textconv=` 로 값을 비워야 멎었다).
 *   지금 부르지 않으며, 부르게 된다면 플래그가 아니라 `-c` 쪽으로 막아야 한다.
 * - 대조군(위험 없음): `diff-index` · `diff-tree` · `diff-files` · `format-patch` 는
 *   플러밍이라 `.gitattributes` 의 diff 드라이버를 아예 보지 않는다 — 심어 두고 `-p` 로
 *   돌려도 textconv 발화 0회(실측).
 * - **주변 환경발 임의 config** — `GIT_CONFIG_*` 계열은 자식에서 지우지만
 *   `HOME`·`USERPROFILE`·`XDG_CONFIG_HOME`·`HOMEDRIVE`/`HOMEPATH` 는 **의도적으로
 *   상속시킨다**(git 이 자격 증명 헬퍼와 사용자 설정을 못 찾으면 사용자 환경에서 아예
 *   못 돈다). 그 중 하나를 돌려놓으면 `~/.gitconfig` 가 통째로 갈아끼워지고 임의 키가
 *   심긴다 — 실측으로 `filter.evil.clean` 임의 명령 실행과 `core.excludesFile` 조용한
 *   불완전 이식을 둘 다 발화시켰다. 우리를 띄운 부모가 신뢰 경계 안이라는 전제 위에
 *   서 있다. 아래 GIT_REDIRECT_VARS 주석에 자세히 적었다.
 * - **`.git/info/exclude` · `.git/info/attributes`** — `core.excludesFile` /
 *   `core.attributesFile` 과 같은 일을 하는데 **그것들을 가리키는 config 키가 없어서
 *   `-c` 로 막을 수 없다.** 실측(둘 다 심고 상태 이식):
 *
 *     .git/info/exclude = "*.js" , .git/info/attributes = "*.txt text eol=crlf"
 *       봉투 {ok:true, transplanted:true}
 *       워크트리 파일 ['mod.txt','seed.txt']   <- app.js 가 통째로 사라졌다
 *       워크트리 mod.txt 6c696e65310d0a…       <- LF -> CRLF 로 갈아치워짐
 *
 *   `.git/config` 와 같은 신뢰 등급이다(둘 다 clone 으로 오지 않는다). 게다가
 *   `.git/info/` 는 워크트리들이 **공유하는** 디렉터리라, 셸이 제한되지 않는 델리게이트가
 *   워크트리에서 직접 써 넣어 다음 런의 이식을 오염시킬 수 있다. 거부하지는 않고
 *   (정당한 용법이 있다) `src/worktree.mjs` 가 `create` 봉투의 `sharedRules` 로 신고한다.
 * - `alias.<이름>` — **빌트인 서브커맨드가 이긴다**(실측: 저장소가 `alias.status` 를
 *   심어도 빌트인 `status` 가 돈다). 그래서 우리가 **빌트인 서브커맨드만 부르는 한**
 *   도달 불가능하다. 이것이 불변식이다 — 빌트인이 아닌 이름을 서브커맨드로 부르는
 *   순간 저장소가 심은 alias 가 실행된다. (서브커맨드 허용 목록은 만들지 않는다:
 *   앞으로의 태스크가 서브커맨드를 늘릴 때마다 런타임에 늦게 발견되는 마찰이 된다.)
 */

const STATE_ROOT = resolveStateRoot();

// 모듈 로드 시점에 잡아 둔다. 호출자 args 의 getter 하나로 전역이 오염될 수 있는데,
// 그 오염은 이 모듈이 로드된 뒤에나 심을 수 있다.
const { defineProperty } = Object;

/**
 * ★ 위협 모델을 사실대로 적는다 (여기에 확언을 남기지 않기 위해).
 *
 * 리뷰가 찾은 매달림 벡터 둘 — `globalThis.Promise` 자체를 갈아끼우기,
 * `Promise.prototype.constructor` + `then` 조합 — 은 **이미 이 프로세스 안에서 임의 JS 를
 * 실행할 수 있는 공격자**에게만 열린다. 그 지점에 도달한 공격자는 `runGit` 을 매달리게
 * 하는 것보다 훨씬 나쁜 일을 이미 할 수 있다. 이 모듈의 위협 모델은 **대상 저장소**이고,
 * 저장소는 우리 argv 에 getter 달린 객체를 넣을 수단이 없다(호출자는 전부 우리 코드다).
 * 그래서 그 벡터를 막겠다고 `runGit` 을 콜백 스타일로 재작성하지 않는다 — 비용만 크고
 * 위협 모델에 안 맞는다.
 *
 * 이 한 줄만 취한다: 로드 시점의 `Promise` 를 잡아 두면 `globalThis.Promise` 교체는
 * 여기 닿지 않는다. 값싸고 부작용이 없어서다. **`Promise.prototype` 오염까지 막지는
 * 못한다** — 같은 객체의 프로토타입이니까. 우리가 보장하는 것은 그 확언이 아니라
 * "정상적인 사용에서 반드시 봉투를 낸다" 이고, 그것을 실제로 지탱하는 것은 아래의
 * 하드 데드라인이다.
 */
const NativePromise = Promise;

/**
 * 우리 **자신의** 프로세스 환경에 세우는 보조 방어.
 *
 * Windows 의 libuv 는 실행 파일 이름에 경로 구분자가 없으면 자식의 cwd 를 PATH 보다
 * 먼저 뒤진다. 그런데 우리 cwd 는 호출자가 준 대상 저장소 경로다 — 적대적 저장소가
 * `git.exe` 를 커밋해 두기만 하면 임의 코드 실행이었다.
 *
 * ★ 함정: libuv 는 이 변수를 **부모(우리) 프로세스 환경**에서 읽는다. spawn 의 `env`
 *   옵션에 넣어 봐야 그 스폰은 보호되지 않는다(실측으로 확인). 그래서 process.env 다.
 *
 * 이건 어디까지나 보조 방어다. 주된 수정은 아래 `resolveGitPath()` — 절대 경로로
 * 스폰하면 libuv 가 탐색 자체를 하지 않으므로 이 변수와 무관하게 안전하다.
 * 개발 머신에서는 Git Bash 가 이 변수를 심어 둬서 구멍이 우연히 가려져 있었다.
 */
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

/**
 * git 실행 파일의 **절대 경로**. 못 찾으면 null (호출부가 fail-closed 로 거부한다).
 *
 * `src/providers/resolve-binary.mjs` 를 그대로 재사용한다 — PATH 를 훑되 cwd 는 절대
 * 포함하지 않고, Windows 에서 PATHEXT 를 고려하며, 디렉터리를 걸러내는 일까지 이미
 * 같은 규칙으로 한다. 벤더 CLI 전용인 셈(shim) 우회(`resolveLaunch`)는 쓰지 않는다:
 * git 은 npm 셈으로 설치되는 물건이 아니고, 셈밖에 없는 상황이라면 그건 거부해야 할
 * 상태다.
 *
 * ★ 절대 경로여야 한다. PATH 항목이 상대 경로면(`.` 같은) 해석 결과가 `git.exe` 처럼
 *   구분자 없는 이름이 될 수 있고, 그러면 cwd 탐색 구멍이 그대로 되살아난다. 구분자가
 *   있어도 상대 경로면 CreateProcess 가 **자식의** cwd 기준으로 푼다 — 역시 대상
 *   저장소다.
 *
 *   그 판정은 이제 `resolveBinary` 안에서 한다: 비절대 PATH 항목은 **건너뛰고 계속
 *   훑는다**(거부하고 멈추지 않는다 — 그러면 PATH 에 상대 항목이 하나 섞였다는 이유로
 *   뒤에 있는 진짜 git 을 못 보고 모듈 전체가 죽는다).
 *
 *   아래 `isAbsolute(resolved)` 는 그 위에 얹는 한 줄이다. resolveBinary 가 이미
 *   걸러내므로 이 줄만 빼도 관측되는 동작은 바뀌지 않는다(실측). 남기는 이유는
 *   fail-closed 가 이 모듈의 원칙이고 비용이 한 줄이라서다.
 *
 * 성공만 캐시한다. 실패를 캐시하면, 서버가 도는 중에 git 이 설치돼도 호스트를
 * 재시작할 때까지 계속 고장 난 채로 남는다(resolve-binary 가 캐시하지 않는 이유와 같다).
 *
 * ★ 성공 캐시에도 대가가 있다(고치지 않고 적어만 둔다): 이 값은 프로세스 수명 내내
 *   남는다. 도중에 git 이 업그레이드되거나 옮겨지면, 서버를 재시작할 때까지 우리는 옛
 *   절대 경로를 계속 스폰한다. 그 경로가 사라졌으면 매 호출이 spawn error(failed)로
 *   끝나고, 남아 있으면 옛 바이너리가 계속 돈다. 실패를 캐시하는 것보다는 낫다고 보고
 *   이쪽을 골랐다 — MCP 서버는 오래 사는 프로세스이므로 "설치했는데 영영 못 쓴다"가
 *   더 흔한 사고다.
 */
let cachedGitPath = null;

function resolveGitPath() {
  if (cachedGitPath !== null) return cachedGitPath;
  let resolved;
  try {
    resolved = resolveBinary({ basename: 'git' });
  } catch {
    return null; // 못 찾음 / 셈만 있음 — 둘 다 거부다
  }
  if (typeof resolved !== 'string' || !isAbsolute(resolved)) return null;
  cachedGitPath = resolved;
  return cachedGitPath;
}

/**
 * 저장소가 심을 수 있는 hook 을 무력화하는 빈 디렉터리.
 *
 * ★ 여기 있던 근거("존재하지 않는 경로를 주면 git 이 무시하고 기본 `.git/hooks` 를
 *   쓴다")는 **이 git 에서 재현되지 않는다.** 재확인 실측(git 2.55.0.windows.3,
 *   `.git/hooks/pre-commit` 을 심어 두고 `commit`):
 *
 *     core.hooksPath=<존재하지 않는 경로>  -> exit 0, hook 실행 안 됨
 *     core.hooksPath=<디렉터리가 아닌 파일> -> exit 0, hook 실행 안 됨
 *     core.hooksPath=<빈 디렉터리>          -> exit 0, hook 실행 안 됨
 *     core.hooksPath 미설정 (대조군)        -> exit 0, hook **실행됨**
 *
 *   그래도 실제로 만들어 둔다. 이유는 폴백 방지가 아니라, 다른 git 버전·플랫폼의 폴백
 *   동작에 의존하지 않기 위해서다. 비용은 프로세스당 mkdir 한 번이다.
 *
 * 지연 생성을 유지하는 것은 이제 안전하다. `runGit` 이 **호출자 값을 한 번도 건드리기
 * 전에** 이것을 await 하므로(아래 I2 주석), 검사와 spawn 사이에 await 가 없다.
 */
const EMPTY_HOOKS_DIR = join(STATE_ROOT, 'git-empty-hooks');

let hooksDirReady = null;

/**
 * 빈 hooks 디렉터리를 지연 생성한다. 실패해도 절대 던지지 않는다 — runGit 의 계약.
 *
 * ★ `.then(...)` 도 `.catch(...)` 도 쓰지 않는다. 둘 다 `Promise.prototype` 을 거치는
 *   호출이라, 그 전역이 "영영 settle 되지 않는 promise 를 내는 함수" 로 갈아끼워지면
 *   여기서 만들어져 **모듈에 캐시되는** promise 가 영영 안 끝난다. 그러면 `runGit` 은
 *   던지지도 않고 봉투도 내지 않은 채 매달리고, 첫 호출 이후의 모든 정상 호출까지
 *   같이 매달린다(실측으로 재현했다).
 *
 *   `await`(와 async 함수의 정상 반환)는 `Promise.prototype.then` 을 조회하지 않는
 *   내부 경로를 쓴다. 그래서 async IIFE + await 로 바꿨다.
 *
 *   ★ 오염이 **첫 호출보다 먼저** 서 있는 경우와 **호출 도중에** 심기는 경우는 서로
 *     다른 창이다. 후자는 `args[0]` 의 getter 로 심으므로 `runGit` 첫 줄의
 *     `await ensureEmptyHooksDir()` 을 이미 지난 뒤라 여기에 닿지 않는다. 여기서 다루는
 *     것은 전자다.
 *
 *   같은 이유로 이 함수 자신은 **async 가 아니다**: async 함수가 promise 를 반환하면
 *   그 promise 를 thenable 로 보고 `then` 을 조회해 호출한다 — 오염이 그 자리에서 다시
 *   발화한다. 이미 만들어진 promise 를 그대로 돌려준다.
 */
function ensureEmptyHooksDir() {
  if (hooksDirReady === null) {
    hooksDirReady = (async () => {
      try {
        await mkdir(EMPTY_HOOKS_DIR, { recursive: true });
      } catch {
        // 못 만들어도 진행한다. 없는 경로를 주는 것이 저장소의 hook 을 쓰는 것보다 낫다.
      }
    })();
  }
  return hooksDirReady;
}

/**
 * 모든 git 호출에 강제로 붙는 하드닝 플래그.
 *
 * - `core.fsmonitor=` — 저장소가 심은 fsmonitor 훅(임의 명령)이 돌지 않게 비운다.
 * - `core.hooksPath=<빈 디렉터리>` — 저장소의 `.git/hooks/*` 가 아니라 우리가 만든
 *   빈 디렉터리를 보게 해서, 심어진 pre-commit 등이 절대 실행되지 않게 한다.
 * - `core.symlinks=false` — CVE-2024-32002 류의 out-of-tree symlink 심기를 무력화한다
 *   (git 버전 하한과 별개의 방어선 — 하나가 뚫려도 다른 하나가 남게).
 * - `core.attributesFile=` — **트리에 아무 흔적도 남기지 않는** 채널이다.
 *   `*.txt text eol=crlf` 한 줄로 이식 바이트가 갈아치워지고(실측: 사용자
 *   `6c696e65310a…` → 워크트리 `6c696e65310d0a…`, 봉투는 ok), 그 변경이 최종 패치를
 *   타고 사용자 저장소로 돌아가 델리게이트가 건드리지도 않은 줄을 재작성한다.
 *   `working-tree-encoding` 등 임의 속성도 같은 채널로 붙는다.
 *   `GIT_ATTR_SOURCE` 를 이미 같은 이유로 자식 환경에서 지우고 있으므로 대칭이다.
 *
 * ★★ **`core.excludesFile=` 은 여기 있었다가 되돌렸다.** 넣었던 이유는 대상 저장소의
 *   `.git/config` 한 줄로 `add -A` 와 `status` 가 파일을 조용히 건너뛰게 만들 수 있어서
 *   였다. 그런데 같은 키가 **사용자의 정당한 전역 무시 파일**도 함께 끈다. 실측:
 *
 *     `~/.gitignore_global` = node_modules/ · .idea/ · *.swp
 *       하드닝 없이 사용자 git 이 보는 것 : "?? a.txt"
 *       -c core.excludesFile= 로          : ?? .idea/ ?? a.txt ?? node_modules/ ?? notes.swp
 *       -> 워크트리 최상위에 .idea·notes.swp 가 그대로 이식됨
 *       -> 사용자 저장소 오브젝트 수 3 -> 511 (워크트리 제거 + prune 뒤에도 513)
 *       -> 델리게이트가 그중 하나를 건드리면 최종 패치가 사용자 실제 파일을 덮어쓴다
 *
 *   전역 무시에 두는 것은 정의상 커밋하지 않는 개인 파일(비밀 포함)이다. 그것을 셸이
 *   제한되지 않는 외부 CLI 에 넘기고 공유 오브젝트 DB 에 남기는 대가는, 막으려던
 *   적대적 채널보다 크다 — 그쪽은 **모든 정상 사용자**에게 발생한다.
 *
 *   원래 막으려던 것은 `src/worktree.mjs` 의 `ignoredPaths` 신호가 덮는다:
 *   `status --porcelain --ignored=matching` 은 `core.excludesFile` 이 만든 규칙도 같이
 *   보므로(실측: 적대적 excludesFile 로 숨긴 `secret1.txt` 가 `!! secret1.txt` 로 나온다)
 *   이식·수집 **양방향에서** 사라진 파일이 봉투에 실린다. 신호로 덮고 collateral 을
 *   없앤다.
 *
 *   `core.attributesFile=` 은 등급이 다르므로 **유지한다** — 그쪽은 파일을 숨기는 것이
 *   아니라 **내용 바이트를 갈아치우는** 것이고, 어떤 신호로도 사후 복구되지 않는다.
 *
 * ★ 이 키를 비워도 저장소가 **커밋한** `.gitattributes` 는 그대로 유효하다(= 사용자가
 *   볼 수 있는 정당한 설정). `-c diff.external=` 같은 exit 128 함정이 **아님을 직접
 *   실측했다**(정상 저장소에서 `status`/`diff`/`log`/`add -A`/`commit` 이 전부 code 0,
 *   패치 바이트 동일 142==142).
 *
 * ⚠ `core.attributesFile=` 의 부작용(고치지 않고 사실만 적는다): 전역 `~/.gitattributes`
 *   로 eol 을 **정당하게** 쓰는 사용자는 거울상 불일치를 얻는다 — 사용자 디스크는 CRLF,
 *   우리 워크트리는 LF. 적대적 채널(트리에 흔적을 남기지 않으면서 이식 바이트를 바꾸는
 *   경로)을 닫는 값어치가 더 크다고 판단해서 이쪽을 골랐다는 사실까지 남긴다.
 *
 * 얼려서 낸다: 호출부가 실수로라도 이 배열을 변형해 하드닝을 약화시킬 수 없게 한다.
 */
export const HARDENING_ARGS = Object.freeze([
  '-c',
  'core.fsmonitor=',
  '-c',
  `core.hooksPath=${EMPTY_HOOKS_DIR}`,
  '-c',
  'core.symlinks=false',
  '-c',
  'core.attributesFile=',
]);

/**
 * 서브커맨드 **직후**에 강제로 끼워 넣는 하드닝 플래그(아래 SUBCOMMAND_HARDENING).
 * 저장소가 심은 `diff.external` 과 `diff.<drv>.textconv` 는 **둘 다** `git diff` 하나로
 * 발화하는 명령 실행 싱크다.
 *
 * ★ `--no-ext-diff` 는 textconv 를 끄지 못한다 (실측 git 2.55.0.windows.3).
 *   `.gitattributes` 에 `*.txt diff=evil`, `git config diff.evil.textconv <스크립트>`
 *   를 심고 계획 2 의 이식 명령을 그대로 돌린 결과:
 *
 *     diff --no-ext-diff --cached --binary HEAD                 exit 0, 심은 명령 실행됨
 *     diff --no-ext-diff --no-textconv --cached --binary HEAD   exit 0, 실행 안 됨
 *
 *   피해가 둘이다. 하나는 `diff.external` 과 같은 등급의 **임의 명령 실행**. 다른
 *   하나가 더 고약하다 — 패치 내용이 저장소가 심은 스크립트의 출력으로 **조용히**
 *   바뀐다. 위 재현에서 관측된 것은 `exit 0` + **빈 패치**였다(양쪽이 같은 문자열로
 *   변환되니 차이가 없다). 그러면 상태 이식이 "변경 없음"으로 오판하고 델리게이트가
 *   옛 코드를 고친다 — 위험이 아니라 **틀린 결과**다.
 *
 *   정상 저장소 회귀는 없다: 같은 저장소에서 두 형태가 같은 패치를 exit 0 으로 냈다.
 *
 * ★ 호출자는 이 두 플래그를 무력화할 수 있다 (지금 고치지 않는, 알려진 한계).
 *   스크리닝은 서브커맨드에서 끝나므로 `['diff', '--ext-diff', 'HEAD']` 와
 *   `['diff', '--textconv', 'HEAD']` 는 통과하고, 실측상 **뒤에 온 쪽이 이긴다**:
 *
 *     diff --no-ext-diff --ext-diff HEAD                exit 0, 외부 diff 실행됨
 *     diff --no-ext-diff --no-textconv --textconv HEAD  exit 0, textconv 실행됨
 *
 *   즉 이 주입은 "호출자가 잊어버리는 것"을 막는 장치이지 적대적 호출자를 막는
 *   장치가 아니다. 이 모듈의 위협 모델은 **대상 저장소**이고 호출자는 우리 코드다.
 *
 * ★ 왜 `HARDENING_ARGS` 에 `-c diff.external=` 를 넣지 않았는가 (실측 결과가 예상과
 *   달랐다, git 2.55.0.windows.3):
 *
 *     git -c diff.external= diff HEAD
 *     -> error: cannot spawn : No such file or directory
 *        fatal: external diff died, stopping at a.txt        (exit 128)
 *
 *   빈 값은 외부 diff 를 **끄지 않는다.** git 은 빈 문자열도 명령으로 보고 그대로
 *   spawn 을 시도한다. 게다가 `diff.external` 을 설정한 적이 **없는 정상 저장소에서도**
 *   똑같이 깨진다 — 넣었다면 계획 2 의 패치 수집이 통째로 고장 났을 것이다.
 *
 *   `--no-ext-diff` 는 실측으로 정확히 동작한다(exit 0, 외부 diff 실행 안 됨). 다만
 *   최상위 전역 옵션이 아니라서(`git --no-ext-diff diff` 는 exit 129 unknown option)
 *   HARDENING_ARGS 에 못 넣는다. 그래서 서브커맨드가 `diff` 일 때 그 **직후**에 끼워
 *   넣는다. 호출자가 기억해야 하는 규칙으로 남기지 않는 것이 이 모듈의 요점이다.
 *
 *   `log -p` / `show` / `blame` 은 애초에 외부 diff 를 쓰지 않는다(실측: `diff.external`
 *   을 심어 두고 셋을 돌려도 0회 발화). **다만 textconv 는 그 셋에서도 돈다** — 그래서
 *   그 셋에는 `--no-textconv` 만 끼운다.
 *
 * ★ `log` · `show` · `blame` 을 넣은 것은 **선제 조치**다. 지금 이 모듈의 호출부가 부르는
 *   서브커맨드에 그 셋은 없어서 노출이 없다. 그런데 계획 2 의 엔진이 `show` 를 쓸
 *   가능성이 크고, 그때 이 자리를 기억해서 손으로 넣게 만들면 이 모듈의 요점이 사라진다.
 *
 *   실측(git 2.55.0.windows.3, `.gitattributes` 에 `*.txt diff=evil` +
 *   `diff.evil.textconv=<스크립트>`):
 *
 *     log -p          / show          / blame <파일>          -> 셋 다 스크립트 실행됨
 *     log --no-textconv -p / show --no-textconv / blame --no-textconv <파일>
 *                                                            -> 셋 다 실행 안 됨, exit 0
 *
 * ## ★ `diff` 에만 붙는 셋: `--no-color` · `--default-prefix` · `-U3`
 *
 * 위 둘이 "명령 실행"을 겨냥한다면 이 셋은 **출력의 형태**를 겨냥한다. 형태를 대상
 * 환경에 맡겨 두면 명령 실행 없이도 결과가 조용히 틀어진다.
 *
 * ★ `--default-prefix` (C-1). `diff --git a/x b/x` 의 접두사는 config 로 바뀐다
 *   (`diff.noprefix`, `diff.srcPrefix`/`dstPrefix`, `diff.mnemonicPrefix`). 그런데 이
 *   저장소의 `git apply` 는 기본 `-p1` 이라 **선두 한 조각을 무조건 벗긴다** — 접두사가
 *   없어지면 진짜 디렉터리 이름이 벗겨진다. 실측:
 *
 *     diff.noprefix=true  -> "diff --git src/mod.txt src/mod.txt"
 *                            워크트리 적용 후 mod.txt 가 고쳐진다(엉뚱한 파일)
 *     --default-prefix    -> "diff --git a/src/mod.txt b/src/mod.txt"  (올바름)
 *
 *   역방향도 같다 — 최종 패치가 사용자 저장소의 **무관한 파일을 exit 0 으로 덮어쓴다.**
 *   봉투는 `ok:true`·`transplanted:true`·`empty:false` 세 자리 모두 성공이라 호출부의
 *   "ok 를 먼저 본다" 방어가 전부 무력하다. 조각 수가 1이 아닌 경우(0 = `noprefix`,
 *   2 이상 = `srcPrefix=x/y/`)가 손상이고, 1조각은 적용은 되지만 헤더 파싱이 깨진다.
 *
 *   플래그 하나가 네 키를 전부 이긴다(실측). git 2.45 도입이고 이 파일의
 *   `MIN_GIT_VERSION = '2.45.1'` **하한 안**이라 쓸 수 있다 — 하한을 낮추면 이 자리를
 *   `--src-prefix=a/ --dst-prefix=b/` 로 바꿔야 한다.
 *
 * ★ `-U3` — `diff.context` 를 덮는다. `diff.context=0` 은 이식을
 *   `patch does not apply` 로 통째로 막는다(실측). 3은 git 의 기본값이라 정상 저장소의
 *   패치 바이트가 달라지지 않는다(실측: 접두사 설정이 없는 저장소에서 현재 인자와 수정
 *   인자의 패치가 바이트 동일, 142 == 142).
 *
 * ★ `--no-color` (I-2) — `color.diff=always` 는 `--output=<파일>` 로 받아도 색을 붙인다
 *   (tty 무관, 실측). 패치에 `0x1b` 가 들어가면 `git apply` 가
 *   `No valid patches in input` 으로 실패하고 소비자의 헤더 파싱이 그 자리에서 깨진다.
 *   (대조군 `color.ui=always` 는 최신 git 이 무시하므로 발화하지 않는다 — 실측.)
 *
 *   `log` 와 `show` 에도 선제적으로 넣는다(`--no-textconv` 를 넣은 것과 같은 근거).
 *   공허하지 않다 — 실측으로 둘 다 `color.diff=always` 아래에서 ANSI 를 낸다:
 *
 *     log -p / show  플래그 없이       -> ANSI 있음, exit 0
 *     log -p / show  --no-color        -> ANSI 없음, exit 0
 *
 * ★ **`blame` 에는 `--no-color` 를 넣지 않는다 — 넣으면 깨진다.** "`--no-color` 는
 *   `log`·`show`·`blame` 에 다 유효하다"는 말을 그대로 받아 넣었다가 기존 테스트가
 *   붉어져서 실측으로 판정했다(git 2.55.0.windows.3):
 *
 *     blame --no-color        -> exit 129
 *                                "error: ambiguous option: no-color
 *                                 (could be --no-color-lines or --no-color-by-age)"
 *     blame --no-color-lines  -> exit 0
 *     blame (플래그 없음)      -> exit 0, `color.ui=always` 여도 ANSI 없음
 *
 *   즉 blame 은 그 이름의 옵션이 없어서 접두사 매칭이 모호해지고, 애초에 막을 색도
 *   내지 않는다. `--no-color-lines` 로 대신 넣지 않는 이유는 위 `--no-ext-diff` 와
 *   같다: 막을 것이 없는 자리에 플래그를 늘리면 인자만 늘고 얻는 것이 없다.
 *
 * ★ **`--default-prefix` 와 `-U3` 는 `log`·`show`·`blame` 에 넣지 않는다.** 셋 다 그
 *   플래그를 exit 0 으로 받아들이기는 한다(실측 — "거부한다"는 말이 돌았지만 사실이
 *   아니다). 넣지 않는 이유는 따로다: 그 셋의 출력은 이 모듈의 `git apply` 로 들어가지
 *   않으므로 접두사·컨텍스트가 틀어져도 막을 피해가 없고, 오히려 `log --stat` 처럼
 *   diff 가 아닌 형태에 컨텍스트 개수를 강요하게 된다. 막을 것이 없는 자리에 플래그를
 *   늘리면 인자만 늘고 얻는 것이 없다.
 *
 * ★ 이 셋은 전부 서브커맨드 **뒤**라 선행 전역 옵션 스크리닝에 걸리지 않는다
 *   (`--output=` 과 같은 자리 — 실측 exit 0).
 *
 * ★ 이 셋에 `--no-ext-diff` 는 넣지 않는다. "그 셋은 `--no-ext-diff` 를 exit 129 로
 *   거부한다"는 말이 돌았는데 **실측은 그렇지 않았다** — 세 서브커맨드 모두 exit 0 으로
 *   받아들인다. 넣지 않는 진짜 이유는 따로다: 같은 실측에서 `diff.external` 을 심어 두고
 *   셋을 돌려도 외부 diff 는 한 번도 발화하지 않았다. 막을 것이 없는 자리에 플래그를
 *   늘리면 인자만 늘고 얻는 것이 없다.
 *
 * 얼려서 낸다: 호출부가 실수로라도 변형해 하드닝을 약화시킬 수 없게 한다.
 */
const SUBCOMMAND_HARDENING = new Map([
  ['diff', Object.freeze(['--no-ext-diff', '--no-textconv', '--no-color', '--default-prefix', '-U3'])],
  ['log', Object.freeze(['--no-textconv', '--no-color'])],
  ['show', Object.freeze(['--no-textconv', '--no-color'])],
  // ★ `blame` 에는 `--no-color` 를 넣지 않는다 — 아래 주석의 실측을 보라(exit 129).
  ['blame', Object.freeze(['--no-textconv'])],
]);

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 타임아웃으로 `kill()` 을 부른 뒤 `close` 를 기다려 주는 유예. 이 시간이 지나면 자식의
 * 생사와 무관하게 봉투를 낸다(아래 하드 데드라인 주석 참조).
 *
 * 2초인 이유: 정상적으로 죽는 프로세스는 밀리초 단위로 `close` 를 낸다 — 이 유예는
 * "느린 종료"를 위한 것이 아니라 "영영 안 오는 close"를 끊기 위한 것이다. 너무 짧게
 * 잡으면 정말 죽고 있던 자식의 종료 코드를 버리게 되고, 길게 잡으면 그만큼 MCP 요청이
 * 매달린다.
 */
const KILL_GRACE_MS = 2_000;

/**
 * 호출자 args 의 개수 상한.
 *
 * ★ 왜 필요한가 (실측): `length` 가 `Number.MAX_SAFE_INTEGER` 를 내는 Proxy 를 넘기면
 *   복사 루프가 힙을 다 먹고 `node --max-old-space-size=512` 에서 exit 134 (SIGABRT),
 *   "FATAL ERROR: JavaScript heap out of memory" 로 **프로세스가 죽는다**. never-throw
 *   계약은 지켜지지만 MCP 서버가 통째로 내려가므로 던지는 것보다 나쁘다. 그래서
 *   `length` 는 루프 밖에서 **한 번만** 읽고 여기서 자른다. 4096 은 실사용(파일 목록을
 *   pathspec 으로 늘어놓는 경우)보다 넉넉하면서 OOM 과는 한참 먼 값이다.
 */
const MAX_ARGS = 4096;

// `Object.freeze(HARDENING_ARGS)` 는 배열 변형만 막지, 호출자 args 에 담긴 값까지는
// 못 막는다. git 은 "뒤에 온 -c 가 이긴다" 규칙이라서, 호출자가 `-c core.hooksPath=…`
// 를 args 에 섞으면 우리 하드닝이 조용히 무력화된다.
//
// ★ 차단 목록은 실제로 뚫렸다. git 의 handle_options() 는 전역 옵션의 **값** 토큰을
//   만나도 전역 옵션 파싱을 계속한다. `--shallow-file <path>` 와 `--attr-source <tree>`
//   처럼 값을 별도 토큰으로 삼키는 전역 옵션 뒤에 `-c` 를 놓으면, "첫 비-플래그 토큰 =
//   서브커맨드"로 선행 구간의 끝을 잡던 스크리너는 값 토큰에서 멈추고 git 은 그 뒤의
//   `-c` 를 정상 전역 옵션으로 먹는다(실측 git 2.55: core.hooksPath 가 덮이고 저장소가
//   심은 pre-commit 이 실제로 실행됐다 — CVE-2026-40068 체인 그 자체다).
//
//   그래서 목록을 뒤집었다: **허용 목록 + fail-closed**. 모르는 선행 플래그는 값을
//   삼키는지 알 수 없으므로 거부가 유일하게 안전한 기본값이다.
//
// ★ 이 목록의 불변식: **여기 있는 어느 것도 값을 삼키지 않는다.** 값을 삼키는 플래그를
//   추가하는 순간 그 다음 토큰이 스크리너에게 플래그나 서브커맨드로 보여 판정이 통째로
//   무너진다 — 위 실패가 정확히 그것이었다. 무언가를 더할 때는 그 플래그가 값을
//   삼키는지부터 확인할 것.
//
//   `--help`/`-h` 는 넣지 않는다(페이저·브라우저를 띄운다 — MCP 서버에서 절대 안 된다).
//   `--` 도 없으므로 최상위 `git -- …` 는 거부된다. 의미 있는 호출이 아니다. 서브커맨드
//   **뒤의** `--` 는 스캔이 이미 끝난 뒤라 영향이 없다(`git log -- -c` 는 통과한다).
const SAFE_LEADING_OPTIONS = new Set([
  '--version',
  '-v',
  '--no-pager',
  '-P',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--no-advice',
]);

/**
 * ★ 자식에서 반드시 지우는 GIT_* **리다이렉션** 변수.
 *
 * 왜 필요한가 (실측 git 2.55.0.windows.3). 예전 `runGit` 은 spawn 에 `env` 를 주지
 * 않아 부모 환경을 통째로 상속시켰다. 그러면 우리를 띄운 쪽의 환경이 우리가 `cwd` 로
 * 지목한 저장소를 갈아치울 수 있다:
 *
 *   cwd=<real>, 주변 GIT_DIR=<decoy>/.git GIT_WORK_TREE=<decoy>
 *     -> `ls-files` 가 decoy 의 파일을 낸다 (우리가 지목한 저장소가 아니다)
 *
 *   cwd=<커밋과 완전히 일치하는 깨끗한 저장소>, 주변 GIT_INDEX_FILE=<존재하지 않는 경로>
 *     -> `diff --cached --binary HEAD` 가 **exit 0** 과 함께
 *        "deleted file mode … +++ /dev/null" 을 낸다 = **전부 삭제하는 패치**
 *
 * 두 번째가 특히 고약하다. 계획 2 의 상태 이식은 그 패치를 워크트리에 그대로
 * 적용하므로 델리게이트가 텅 빈 워크트리를 보게 된다 — 위험이 아니라 **틀린 결과**다.
 * 게다가 봉투는 성공이라 "`ok` 를 먼저 본다"는 호출부의 방어가 통하지 않는다.
 *
 * ★ 나머지 환경(PATH·HOME·USERPROFILE·SYSTEMROOT…)은 **그대로 상속시킨다.** 여기서
 *   빈-객체 allowlist 를 만들면 git 이 자격 증명 헬퍼와 사용자 설정을 못 찾아 사용자
 *   환경에서 아예 못 도는 위험이 실익보다 크다. (벤더 CLI 자식의 allowlist 규칙은
 *   `src/providers/child-env.mjs` 의 것이고, 그건 **비밀이 AI CLI 로 새는 것**을 막는
 *   다른 위협 모델이다. git 은 로컬 도구이고, 여기서 막을 것은 "주변 환경이 우리를
 *   다른 저장소로 돌려놓는 것" 하나다.)
 *
 * `GIT_CONFIG_*` 계열: 하드닝이 `-c` 로 덮는 키는 HARDENING_ARGS 의 것뿐이다. **그것들은
 * 안전하다** — 주변 환경이 `core.hooksPath` 를 심어도 `-c` 가 이겨서 저장소의 pre-commit
 * 이 발화하지 않는 것을 실측으로 확인했다(대조군은 발화). 뚫리는 것은 **하드닝이 덮지
 * 않는 임의 키 전부**이고, 여기서 지우는 것은 그중 `GIT_CONFIG_*` **두 경로**뿐이다:
 *
 *   - `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 *   - `GIT_CONFIG_PARAMETERS` (git 자신이 `-c` 를 자식에 전파할 때 쓰는 변수라 훅·alias·
 *     `git -c … <cmd>` 밑에서 우리 서버가 뜨면 **정상적으로도** 환경에 있다)
 *
 * ★ **"주변 환경발 임의 config 는 이것으로 닫히지 않는다."** 예전 주석은 위 둘을 두고
 *   "주변 환경이 임의 키를 심는 경로는 둘이다"라고 적었는데 **거짓이다**(실측). 우리는
 *   `HOME`·`USERPROFILE`·`XDG_CONFIG_HOME`·`HOMEDRIVE`/`HOMEPATH` 를 **의도적으로
 *   상속시키므로**(바로 위 문단의 이유), 주변 환경은 그중 하나를 자기가 만든 디렉터리로
 *   돌려 `~/.gitconfig` 를 통째로 갈아끼울 수 있다:
 *
 *     주변 HOME=<공격자 디렉터리, .gitconfig 에 filter.evil.clean> -> add -A 가 발화시킴
 *     같은 경로로 core.excludesFile   -> 조용한 불완전 이식
 *     (단독 `USERPROFILE` 은 이 머신에서 발화하지 않았다 — `HOMEDRIVE`/`HOMEPATH` 가
 *      먼저 이긴다. 플랫폼·git 빌드에 따라 다르므로 "안전하다"고 적지 않는다.)
 *
 *   즉 경로는 최소 넷이고 그 넷은 **닫혀 있지 않다.** 위 잔여 위험 목록(파일 상단)에
 *   같은 등급으로 올려 두었다. 실제 격리는 이 변수 목록이 아니라 일회용 워크트리다.
 *
 * 위 두 경로는 **서로를 덮지 않는다** — 서로 다른 변수를 읽는 별개의 경로다. 한동안
 * `GIT_CONFIG_PARAMETERS` 가 목록에 없어 `filter.<x>.clean` 임의 명령 실행이 그대로
 * 통과했다(실측: `add -A` 가 심은 명령을 발화시켰다).
 * (주석 안에서 `KEY_*` 와 `VALUE_*` 를 슬래시로 붙여 쓰지 말 것 — `*` 와 `/` 가 붙으면
 *  블록 주석이 그 자리에서 끝나 파일이 통째로 SyntaxError 가 된다.)
 *
 * `GIT_ATTR_SOURCE`: 같은 부류인지 **실측으로 판정해서** 넣었다. `.gitattributes` 를 담은
 * 트리를 가리키게 하면 워킹 트리에 그 파일이 없어도 속성이 적용된다(대조군은 평범한
 * 텍스트 diff, 변수를 심으면 `*.txt -diff` 가 걸려 "Binary files … differ"). 속성은
 * 패치에 실리는 **바이트**를 바꾸므로 상태 이식의 내용을 주변 환경이 갈아치울 수 있다.
 *
 * `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`: 엄밀히는 "리다이렉션" 이 아니라 커밋 메타
 * 변수지만 같은 목록에서 지운다. 쓰레기 값 하나로 워크트리 생성이 통째로 막히기
 * 때문이다(실측):
 *
 *   GIT_AUTHOR_DATE=not-a-date     -> commit 이 exit 128 "fatal: invalid date format"
 *   GIT_COMMITTER_DATE=not-a-date  -> `worktree add` 자체가 exit 128 (reflog 를 쓴다)
 *
 * `src/worktree.mjs` 의 `COMMIT_IDENTITY` 는 이름·메일 넷만 env 로 주므로 날짜는 주변
 * 환경에 열려 있었다 — 그 의도가 절반만 성립하던 자리다. 정상 사용에서 잃는 것은 없다
 * (지우면 커밋 날짜가 현재 시각이 될 뿐이고, 대조군 커밋도 이미 현재 시각이다).
 *
 * ★ `GIT_CONFIG_PAIR`(= `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`) 를 지우는 것은
 *   그 위에 얹는 한 줄이다. git 은 `GIT_CONFIG_COUNT` 가 없으면 그 짝을 아예 읽지
 *   않으므로 목록의 `GIT_CONFIG_COUNT` 하나만으로 이미 막힌다 — 이 정규식만 빼도
 *   관측되는 동작은 바뀌지 않는다(실측). 남기는 이유는 fail-closed 가 이 모듈의
 *   원칙이고, 남은 짝이 자식 환경에 실려 다닐 이유가 없어서다.
 *
 * 판정은 **대문자로 정규화**해서 한다. Windows 의 환경 변수 이름은 대소문자를
 * 구분하지 않으므로 `Git_Index_File` 도 같은 변수다(실측: Node 는 철자를 그대로
 * 보관하지만 읽기는 대소문자를 안 가리고, 자식의 getenv 도 그렇다). POSIX 에서는 그
 * 이름이 애초에 git 이 읽지 않는 별개 변수라 지워도 손해가 없다.
 */
const GIT_REDIRECT_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_ATTR_SOURCE',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_DATE',
]);

/** `GIT_CONFIG_COUNT` 와 짝을 이루는 번호 붙은 키/값. 개수가 정해져 있지 않아 패턴으로 본다. */
const GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

function isGitRedirectVar(name) {
  const upper = name.toUpperCase();
  return GIT_REDIRECT_VARS.has(upper) || GIT_CONFIG_PAIR.test(upper);
}

/** 거부 사유에 실을 토큰의 최대 길이. 사유 문자열은 로그·응답을 타고 흐른다. */
const MAX_REASON_TOKEN = 60;

/**
 * 진단용으로 토큰을 줄인다. 거부 사유는 그대로 로그·응답으로 흐르는 문자열이라,
 * 호출자가 넣은 것을 날것으로 되비추면 안 된다. 세 가지를 한다:
 *
 *  1. `--opt=<값>` 은 첫 `=` 까지만 — 주입된 **값**이 사유를 타고 다시 흐르지 않게.
 *  2. 제어문자(C0·DEL·C1)는 `\uXXXX` 로 이스케이프 — ANSI 이스케이프 시퀀스나 개행이
 *     로그 한 줄을 조작하거나 터미널을 흔들지 못하게.
 *  3. 길이 상한 — `=` 가 없는 토큰은 첫 단계에서 안 잘리므로 임의 길이가 실릴 수 있었다.
 *
 * 어떤 옵션이 왜 거부됐는지는 남는다(진단 가능성 유지).
 */
function summarizeToken(token) {
  const eq = token.indexOf('=');
  const head = eq === -1 ? token : `${token.slice(0, eq)}=…`;
  const escaped = head.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return escaped.length <= MAX_REASON_TOKEN ? escaped : `${escaped.slice(0, MAX_REASON_TOKEN)}…`;
}

/**
 * 호출자 args 를 스폰 전에 검사한다. 통과하면 null, 아니면 거부 사유 문자열.
 *
 * 판정 규칙(fail-closed):
 *  1. **모든** 원소가 문자열이어야 한다. 선행 구간만 보면 안 된다 — Node 는 args 원소를
 *     문자열로 강제하지 않고 C++ 층에서 ToString 하므로, `new String('-c')` 같은 객체는
 *     `typeof` 검사만 건너뛰고 git 에는 그대로 `-c` 로 도달한다(실측).
 *  2. 인덱스 0 부터 `-` 로 시작하는 동안, 허용 목록에 없으면 거부.
 *  3. `-` 로 시작하지 않는 첫 토큰 = 서브커맨드. 거기서 스캔 종료. 서브커맨드 뒤의 같은
 *     이름은 전혀 다른 뜻이다(`git commit -c <commit>` 은 메시지 재사용, `git branch -c`
 *     는 복사, `git log -- -c` 는 파일명).
 *
 * `startsWith` 대신 `token[0] === '-'` 를 쓴다: 인덱스 접근은 문자열 자신의 own property
 * 라서 `String.prototype` 오염과 무관하다(오염만으로 never-throw 계약이 깨진 적이 있다).
 */
function screenArgs(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (typeof tokens[i] !== 'string') {
      return `git 인자는 전부 문자열이어야 합니다 — ${i}번째 원소가 ${typeof tokens[i]} 라서 거부했습니다`;
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token[0] !== '-') break; // 서브커맨드 도달 — 선행 구간 끝
    if (!SAFE_LEADING_OPTIONS.has(token)) {
      return `허용 목록에 없는 선행 전역 옵션이라 거부했습니다: ${summarizeToken(token)}`;
    }
  }
  return null;
}

/**
 * 서브커맨드(= `-` 로 시작하지 않는 첫 토큰)의 인덱스. 없으면 -1.
 *
 * `screenArgs` 와 **같은 규칙**으로 선행 구간의 끝을 잡는다. 두 곳이 서로 다른 규칙을
 * 쓰면 "검사한 자리"와 "플래그를 끼워 넣는 자리"가 어긋난다.
 */
function findSubcommandIndex(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i][0] !== '-') return i;
  }
  return -1;
}

/**
 * 프로토타입 사슬을 타지 않고 배열의 index 자리에 값을 놓는다.
 *
 * ★ `push` 도 `arr[i] = v` 도 쓰지 않는 이유:
 *   - `arr.push(v)` 의 `this` 는 곧 이 배열의 참조다. 호출자가 `args[0]` 의 getter
 *     하나로 `Array.prototype.push` 를 갈아끼우면 그 참조를 훔쳐 간다(리뷰어가 실제로
 *     이 경로로 뚫었다).
 *   - `arr[i] = v` 는 [[Set]] 이라, `Array.prototype` 의 index 자리에 setter 가 심겨
 *     있으면 대입이 가로채인다.
 *   `defineProperty` 는 [[DefineOwnProperty]] 라 프로토타입을 보지 않고, 만들어진
 *   속성은 own data property 라서 이후 읽기도 프로토타입 오염과 무관하다.
 */
function put(target, index, value) {
  defineProperty(target, index, { value, writable: true, enumerable: true, configurable: true });
}

/** 스폰 전에 걸러낸 호출의 봉투. 형태는 실행 실패(failed:true)와 같다. */
function rejected(reason) {
  return { ok: false, stdout: '', stderr: reason, exitCode: null, failed: true, timedOut: false };
}

/**
 * git 을 한 번 돌린다. **절대 throw 하지 않는다.**
 *
 * reaper.mjs 의 runCommand·providers/run-cli.mjs 의 runCli 와 같은 모양이다: 스폰
 * 자체가 안 된 것(failed)과 스폰은 됐지만 종료 코드가 0 이 아닌 것(!ok && !failed)을
 * 구분한다. 뭉개면 상위(inspectRepo 등)가 "저장소가 없다"와 "git 을 찾을 수 없다"를
 * 구분하지 못하고 잘못된 판단을 내린다.
 *
 * stdio 는 `['ignore', 'pipe', 'pipe']` 다 — reaper 에서 배운 것: 읽지 않을 파이프는
 * 열지 않는다. 여기서는 stdout 뿐 아니라 stderr 도 **읽으므로**(사전 점검의 오류
 * 메시지가 거기 있다) 둘 다 pipe 로 연다. stdin 은 아무것도 보내지 않으므로 ignore.
 *
 * @param {{ args?: string[], cwd?: string, timeoutMs?: number, env?: Record<string,string> }} [options]
 *   구조분해로 받지 않는다 — 아래 첫 줄의 이유를 보라. `cwd` 는 생략하거나 undefined
 *   일 때만 "서버 자신의 cwd" 를 뜻하고, 그 밖의 비문자열·빈 문자열은 거부한다.
 *   `env` 는 **이 호출에만** 얹는 추가 환경 변수다(부모 프로세스는 건드리지 않는다).
 *   여기에 명시하지 않은 GIT_* 리다이렉션 변수는 자식에서 제거된다
 *   (GIT_REDIRECT_VARS 주석 참조).
 */
export async function runGit(options = {}) {
  // ★ I2: 호출자가 넘긴 값을 **한 번도 건드리기 전에** 이것을 만들고 기다린다.
  //
  //   무엇이 열려 있었나: 예전에는 args 를 복사·검사한 **뒤에** 여기를 await 했다.
  //   그 사이에 호출자 코드(`args[0]` 의 getter)가 이미 돈 상태라, 그 getter 하나로
  //   `Promise.prototype.then` 을 갈아끼우면 여기서 만들어져 모듈에 캐시되는 promise 가
  //   영영 settle 되지 않았다. `timeoutMs` 워치독은 spawn **이후**에 걸리므로 아무
  //   소용이 없었다. `runGit` 은 던지지도 않고 **봉투도 내지 않은 채** 매달렸고 —
  //   never-throw 계약이 지키려던 것("항상 봉투를 낸다")이 깨졌다 — 그 뒤의 모든 정상
  //   호출까지 같이 매달렸다(실측 재현: 첫 호출 settled=false, 두 번째 호출 PENDING).
  //
  //   무엇이 닫혔나: 이 await 가 함수의 첫 줄이라 promise 생성·await 시점에 호출자
  //   코드가 한 줄도 돈 적이 없다. 그래서 이 창이 사라졌고, **검사와 spawn 사이에
  //   await 가 하나도 남지 않았다**(그 사이에 마이크로태스크가 돌 틈 자체가 없다).
  //   매개변수를 구조분해로 받지 않는 것도 같은 이유다 — 구조분해는 함수 본문보다
  //   먼저 `options.args`/`options.cwd` 를 읽으므로 호출자 getter 가 여기보다 앞선다.
  await ensureEmptyHooksDir();

  // 이름이 아니라 절대 경로로 띄운다. 이름으로 띄우면 libuv 가 자식의 cwd(= 대상
  // 저장소)를 PATH 보다 먼저 뒤진다. 못 찾으면 fail-closed — 지금도 git 이 없으면
  // 실패하므로 동작 변화는 없고, 대신 "어디서 막혔는지"가 봉투에 남는다.
  const gitPath = resolveGitPath();
  if (gitPath === null) {
    return rejected('git 실행 파일을 PATH 에서 절대 경로로 찾지 못했습니다 — 안전하게 거부했습니다.');
  }

  let finalTimeout = DEFAULT_TIMEOUT_MS;

  // ★ 검증과 스폰이 **한 try 안**에 있어야 한다. args 원소를 읽는 행위 자체가 던질 수
  //   있기 때문이다(인덱스 getter·Symbol.iterator 교체·Proxy get 트랩·프로토타입 오염).
  //   스크리닝을 try 밖에 두었다가 그 읽기 예외가 runGit 밖으로 새어 never-throw 계약이
  //   깨진 적이 있다. 예외가 나면 **거부 봉투**를 낸다 — 삼키고 스폰을 진행하면 검증을
  //   통째로 건너뛴 채 git 을 띄우는 셈이라 아무것도 안 한 것보다 나쁘다.
  let child;
  let finalCwd;
  try {
    // 여기서 처음으로 호출자 값을 읽는다. 읽기 자체가 던질 수 있으므로 try 안이다.
    const opts = options ?? {};
    const args = opts.args;
    const cwd = opts.cwd;
    const timeoutMs = opts.timeoutMs;
    const env = opts.env;
    finalTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    // ★ env 도 args·cwd 와 같은 fail-closed 규칙이다. 배열·문자열·숫자를 조용히
    //   무시하면 호출자는 자기가 요청한 변수가 자식에 갔다고 믿는다 — 상태 이식은
    //   `GIT_INDEX_FILE` 이 실제로 도달했다는 전제 위에 서 있고, 그게 조용히 빠지면
    //   임시 인덱스 대신 **사용자 인덱스**에 `read-tree`/`add -A` 를 하게 된다.
    //   생략·undefined·null 만 "추가 변수 없음" 으로 허용한다.
    if (env !== undefined && env !== null && (typeof env !== 'object' || Array.isArray(env))) {
      return rejected(
        `git 환경 변수(env)는 평범한 객체여야 합니다 — ${Array.isArray(env) ? 'array' : typeof env} 를 받아 거부했습니다`,
      );
    }
    // 부모 환경을 복사하되 GIT_* 리다이렉션 변수는 뺀다. 이 사본은 이 호출 전용이라
    // process.env 는 그대로다.
    const childEnv = {};
    for (const key of Object.keys(process.env)) {
      if (isGitRedirectVar(key)) continue;
      const value = process.env[key];
      if (typeof value === 'string') childEnv[key] = value;
    }
    if (env !== undefined && env !== null) {
      for (const key of Object.keys(env)) {
        const value = env[key];
        // 비문자열은 Node 가 알아서 문자열로 강제한다 — `undefined` 가 문자열
        // "undefined" 로 자식에 도달하는 것이 가장 나쁘다(경로 자리에 들어가면 그
        // 이름의 파일을 실제로 만든다). 강제하지 말고 거부한다.
        if (typeof value !== 'string') {
          return rejected(
            `git 환경 변수(env)의 값은 문자열이어야 합니다 — ${summarizeToken(key)} 가 ${value === null ? 'null' : typeof value} 라서 거부했습니다`,
          );
        }
        childEnv[key] = value;
      }
    }

    // ★ `typeof cwd === 'string' && cwd !== '' ? cwd : undefined` 는 fail-open 이었다.
    //   `new String(p)`·숫자·`''` 가 전부 undefined 로 떨어져 git 이 **MCP 서버 프로세스
    //   자신의 cwd** 에서 돌았다(실측: 요청한 워크트리 대신
    //   `rev-parse --show-toplevel` 이 이 저장소 루트를 냈다). args 에서 고친 fail-open
    //   과 정확히 같은 부류다. 계획 2 는 이 인자로 `add -A`·`commit`·`clean -fdx` 를
    //   돌린다 — 잘못된 디렉터리에서 도는 `clean -fdx` 는 되돌릴 수 없다.
    //   생략·undefined 만 "서버 cwd 를 그대로 쓴다"로 허용하고 나머지는 거부한다.
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) {
      return rejected(
        `git 작업 디렉터리(cwd)는 비어 있지 않은 문자열이어야 합니다 — ${cwd === null ? 'null' : typeof cwd} 를 받아 거부했습니다`,
      );
    }
    // ★ 문자열이라고 끝이 아니다. **상대 경로**는 위 비문자열들과 똑같이 서버 자신의
    //   cwd 로 떨어진다(실측, 서버 cwd = 이 저장소):
    //
    //     cwd: '.'    -> rev-parse --show-toplevel = <서버 자신의 저장소 루트>
    //     cwd: 'src'  -> <같은 값>
    //
    //   호출자가 요청한 디렉터리와 실제로 도는 디렉터리가 다른데 봉투에는 성공이
    //   찍힌다. 상대 경로를 우리가 대신 풀어 주지 않는 이유: 무엇을 기준으로 풀지는
    //   호출자만 알고, 여기서 추측하면 틀렸을 때 되돌릴 수 없는 명령이 엉뚱한 곳에서
    //   돈다. 판단이 안 서는 입력은 거부가 이 모듈의 기본값이다.
    if (cwd !== undefined && !isAbsolute(cwd)) {
      return rejected('git 작업 디렉터리(cwd)는 절대 경로여야 합니다 — 상대 경로를 받아 거부했습니다');
    }
    finalCwd = cwd;

    // `Array.isArray(args) ? args : []` 는 fail-open 이었다: Set·유사배열·제너레이터를
    // 주면 인자가 조용히 사라지고 하드닝 플래그만 남은 git 이 떠서 usage 를 뱉는다 —
    // 호출자는 자기가 요청한 것과 전혀 다른 명령이 돈 줄 모른다. 생략·undefined 만
    // 빈 배열로 허용하고(`runGit({})` 를 쓰는 호출자가 있다) 나머지는 거부한다.
    if (args !== undefined && !Array.isArray(args)) {
      return rejected(`git 인자는 배열이어야 합니다 — ${args === null ? 'null' : typeof args} 를 받아 거부했습니다`);
    }
    const finalArgs = args === undefined ? [] : args;

    // ★ length 는 여기서 **한 번만** 읽는다. 루프 조건에 두면 Proxy 의 length 트랩이
    //   매번 불리고, MAX_SAFE_INTEGER 를 내면 프로세스가 OOM 으로 abort 한다(MAX_ARGS 주석).
    const length = finalArgs.length;
    if (!Number.isInteger(length) || length < 0) {
      return rejected(`git 인자 배열의 length 가 정수가 아니라서 거부했습니다 (${typeof length})`);
    }
    if (length > MAX_ARGS) {
      return rejected(`git 인자가 너무 많습니다 — 최대 ${MAX_ARGS}개인데 ${length}개를 받아 거부했습니다`);
    }

    // 평범한 배열로 한 번만 복사한다. 검사하는 값과 실제 argv 로 가는 값이 같은
    // 스냅샷이어야 하기 때문이다 — 원본을 두 번 읽으면 그 사이에 바뀔 수 있다.
    const tokens = [];
    for (let i = 0; i < length; i += 1) put(tokens, i, finalArgs[i]);

    // 스폰하기 전에 거부한다 — 하드닝이 이미 무력화된 채로 프로세스를 띄우는 것보다,
    // 아예 안 띄우는 편이 안전하다. stderr 에 무엇이 왜 거부됐는지 남겨 진단 가능하게 한다.
    const rejection = screenArgs(tokens);
    if (rejection) return rejected(rejection);

    // ★ 검사와 spawn 사이에 **await 가 없다.** 위에서 hooks 디렉터리를 함수 첫 줄에
    //   await 해 두었으므로, 여기서부터 spawn 까지는 통째로 동기 구간이다. 그래서
    //   그 사이에 호출자 코드(마이크로태스크)가 돌 틈이 존재하지 않는다.
    //
    //   무엇이 열려 있었나: 이전 코드는 검사한 `tokens` 를 `await` **뒤에** 폈다.
    //   `tokens` 는 지역 변수지만 복사에 `push` 를 썼고, `Array.prototype.push` 를
    //   갈아끼우면 `this` 로 그 참조가 새어 나간다. 그 오염은 호출자가 넘긴 `args`
    //   하나로 심을 수 있다(`args[0]` 의 getter 가 그 자리에서 push 를 교체). 그러면
    //   `await` 틈의 마이크로태스크에서 `tokens` 를 바꿔치기해 **검사를 통과한 것과
    //   다른 argv** 를 띄울 수 있었다 — 리뷰어가 이 경로로 core.hooksPath 를 덮고
    //   저장소가 심은 pre-commit 을 실제로 실행시켰다.
    //
    //   무엇이 닫혔나: `put()` 이 `push` 를 대신하므로 스냅샷 참조가 아예 새지 않는다.
    //   스프레드(`[...tokens]`)를 쓰지 않는 것도 같은 이유다 — `Symbol.iterator` 를
    //   갈아끼우면 검사한 것과 다른 값을 펼 수 있다.
    //
    //   ★ 주의: 되돌리기 쉬운 형태가 둘 있고 **둘 다 뚫린다.** JS 는
    //     `tokens.push(finalArgs[i])` 에서 MemberExpression `tokens.push` 를 인자보다
    //     먼저 평가하므로, `args[0]` 의 getter 가 오염을 심는 순간에는 `i=0` 의 push 가
    //     이미 잡혀 있고 `i=1` 부터 오염된 push 로 간다. `const v = finalArgs[i];`
    //     형태는 `i=0` 부터 간다. 어느 쪽이든 `this` 로 내부 배열 참조가 새어 나간다.
    //
    //   argv 를 검사 직후 **동기적으로** 확정하는 것도 같은 목적이다. 지금은 이 구간에
    //   await 가 없어 그 효과를 밖에서 관측할 수 없다(되돌려도 동작이 같다 — 실측).
    //   지켜야 할 불변식은 이것이다: **이 구간에 await 를 넣지 마라.**
    const subcommandIndex = findSubcommandIndex(tokens);
    const argv = [];
    let n = 0;
    for (let i = 0; i < HARDENING_ARGS.length; i += 1) put(argv, n++, HARDENING_ARGS[i]);
    for (let i = 0; i < length; i += 1) {
      put(argv, n++, tokens[i]);
      // 서브커맨드 직후에 그 서브커맨드용 하드닝을 끼운다(SUBCOMMAND_HARDENING 주석 참조).
      if (i === subcommandIndex) {
        const extra = SUBCOMMAND_HARDENING.get(tokens[i]);
        if (extra !== undefined) for (let k = 0; k < extra.length; k += 1) put(argv, n++, extra[k]);
      }
    }

    child = spawn(gitPath, argv, {
      cwd: finalCwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Windows 에서 잘못된 cwd 등은 동기 예외로 올 수 있다(실측: resolve-binary.mjs 의
    // .cmd EINVAL 과 같은 부류). 여기서 던지면 이 함수의 "절대 throw 안 함" 계약이 깨진다.
    return rejected('git 인자를 검사하거나 프로세스를 띄우는 중에 예외가 났습니다 — 안전하게 거부했습니다.');
  }

  // ★ `return await` 다. 그냥 `return <promise>` 로 두면 async 함수가 그 값을 thenable
  //   로 보고 `then` 을 **조회해서 호출**한다 — `Promise.prototype.then` 이 오염돼 있으면
  //   바로 거기서 매달려, 봉투를 다 만들어 놓고도 호출자에게 전달되지 않는다.
  //   `await` 는 그 조회를 하지 않는 내부 경로라, 여기서 봉투(평범한 객체)로 한 번 풀고
  //   나간다.
  //
  //   ★ 범위는 딱 이만큼이다: 이 자리에서 `then` 을 조회하지 않는다는 것뿐, 프로토타입
  //     오염 전반을 막는다는 뜻이 아니다(위 NativePromise 주석의 위협 모델을 보라).
  return await new NativePromise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let hardTimer = null;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      resolvePromise(value);
    };

    // 자식이 존재하지 않는 실행 파일(ENOENT)이거나 그 밖의 이유로 애초에 뜨지
    // 못했을 때 온다. 이건 "실행 자체가 안 됨" — exitCode 로는 절대 표현할 수 없다.
    child.on('error', () => {
      settle({ ok: false, stdout, stderr, exitCode: null, failed: true, timedOut });
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 이미 죽었으면 할 일이 없다.
      }

      // ★ 하드 데드라인. 여기까지가 4차 코드의 전부였는데, `kill()` 은 **부탁**이지
      //   보장이 아니다. kill 이 실패하거나(권한·경합) 자식이 죽지 않으면 `close` 가
      //   영영 오지 않고 — 봉투도 영영 안 나간다. 적대적 입력이 없어도 발생하는 실제
      //   경로다: 계획 1 의 리퍼가 "죽였다고 보고했지만 안 죽은" 사례를 냈고, Windows
      //   에서 kill 을 통째로 대행하는 taskkill 자체가 실패할 수 있다.
      //
      //   never-throw 계약이 지키려던 것은 "던지지 않는다"가 아니라 **"반드시 봉투를
      //   낸다"** 이므로, kill 뒤 유예 시간 안에 `close` 가 안 오면 무조건 봉투를 낸다.
      //   `timedOut: true` 와 `exitCode: null` 이 짝을 이뤄 "우리가 시간을 끊었고 종료
      //   코드를 모른다"를 말한다 — 즉 **자식이 아직 살아 있을 수 있다**. 그 사실을
      //   stderr 에도 남긴다(호출자가 봉투 모양만 보고 지나치지 않게).
      //
      //   `failed: true` 인 이유: 이 봉투에는 쓸 수 있는 종료 코드가 없다. `failed:false`
      //   는 "실행됐고 exitCode 가 결과다"를 뜻하므로 여기에 쓰면 거짓말이 된다.
      hardTimer = setTimeout(() => {
        settle({
          ok: false,
          stdout,
          stderr: `${stderr}\ngit 프로세스가 타임아웃 뒤 kill 에도 응답하지 않았습니다 — 자식이 아직 살아 있을 수 있습니다.`,
          exitCode: null,
          failed: true,
          timedOut: true,
        });
      }, KILL_GRACE_MS);
    }, finalTimeout);

    child.on('close', (code) => {
      // exitCode 0 은 "스스로 정상 종료했다"는 뜻이다 — 우리가 타임아웃으로 죽였다면
      // 0 이 될 수 없다(run-cli.mjs 의 cutShort 와 같은 근거). 그래서 timedOut 을
      // 세운 뒤 정말로 그것 때문에 짧게 끝났는지는 종료 코드로 다시 확인한다.
      const cutShort = code !== 0;
      settle({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        failed: false,
        timedOut: timedOut && cutShort,
      });
    });
  });
}

// ── 저장소 사전 점검 ─────────────────────────────────────────────────────

const MIN_GIT_VERSION = '2.45.1';
const MIN_GIT_VERSION_TUPLE = [2, 45, 1];
const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';

function blocked({ error, recovery, choices }) {
  const env = { blocked: true, error, recovery: recovery && recovery !== '' ? recovery : GENERIC_RECOVERY };
  if (Array.isArray(choices)) env.choices = choices;
  return env;
}

/** "git version 2.55.0.windows.3" 같은 자유형 문자열에서 major.minor.patch 를 뽑는다. */
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(typeof text === 'string' ? text : '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** version >= floor 인지, 자릿수별로 비교한다. */
function isVersionAtLeast(version, floor) {
  for (let i = 0; i < floor.length; i += 1) {
    const v = version[i] ?? 0;
    const f = floor[i];
    if (v > f) return true;
    if (v < f) return false;
  }
  return true;
}

/**
 * git 버전이 하한(2.45.1) 이상인지 본다. 통과하면 null, 아니면 blocked 봉투.
 *
 * ★ CVE-2024-32002 (git <=2.45.0): 대소문자를 구분하지 않는 파일시스템(Windows 가
 *   기본이 그렇다)에서, 저장소가 심은 out-of-tree symlink 를 검사 없이 따라간다.
 *   `core.symlinks=false` 하나로는 이 CVE 를 완전히 막지 못하므로(그 방어는 git
 *   자체의 clone/checkout 로직 안에 있다) 버전 하한을 별도로 강제한다.
 *
 * ★ 이 게이트는 **자기 신고**에 의존한다 — 물어본 상대가 진짜 git 일 때만 의미가 있다.
 *   이름으로 스폰하던 시절에는 대상 저장소에 심긴 가짜 `git.exe` 가 `git version
 *   99.99.99` 를 뱉는 것만으로 통과했다. `resolveGitPath()` 의 절대 경로 스폰이
 *   그 전제를 지탱한다.
 */
async function checkGitVersion(overrideVersion) {
  let versionText = typeof overrideVersion === 'string' && overrideVersion !== '' ? overrideVersion : null;

  if (versionText === null) {
    const got = await runGit({ args: ['--version'] });
    if (!got.ok) {
      return blocked({
        error: 'git 버전을 확인할 수 없습니다.',
        recovery: 'git 이 PATH 에 설치되어 있고 실행 가능한지 확인하세요.',
      });
    }
    versionText = got.stdout;
  }

  const parsed = parseVersion(versionText);
  if (!parsed || !isVersionAtLeast(parsed, MIN_GIT_VERSION_TUPLE)) {
    return blocked({
      error:
        `git 버전이 너무 낮습니다 (${versionText.trim() || '알 수 없음'}). ` +
        `최소 git ${MIN_GIT_VERSION} 이상이 필요합니다 ` +
        '(CVE-2024-32002: 대소문자를 구분하지 않는 파일시스템에서 심볼릭 링크 검사가 없습니다).',
      recovery: `git 을 ${MIN_GIT_VERSION} 이상으로 업그레이드하세요.`,
    });
  }
  return null;
}

/**
 * 워크트리를 만들기 전에 저장소가 안전하게 다룰 수 있는 상태인지 본다.
 *
 * 순서: 경로 존재 → git 버전 하한 → git 저장소인가 → 커밋이 1개 이상인가.
 *
 * ★ 사전 점검이 조용히 제자리로 떨어지면 안 된다(§5.3). 커밋 0개 저장소에
 *   `git worktree add` 를 걸면 `fatal: invalid reference: HEAD` 로 죽는다(실측).
 *   그때 in-place 로 몰래 강등하면 사용자 파일을 직접 고치게 된다 — 그래서 이
 *   경우만은 무엇을 할지 호출자(모델)가 고르게 3지선다를 낸다.
 *
 * @param {string} projectPath
 * @param {{ gitVersion?: string }} [opts] gitVersion 은 테스트 주입용 — 생략하면
 *   실제 `git --version` 을 묻는다.
 */
export async function inspectRepo(projectPath, opts = {}) {
  if (typeof projectPath !== 'string' || projectPath === '') {
    return blocked({
      error: '프로젝트 경로가 비어 있습니다.',
      recovery: '절대 경로를 지정하세요.',
    });
  }

  try {
    await stat(projectPath);
  } catch {
    return blocked({
      error: `경로를 찾을 수 없습니다: ${projectPath}`,
      recovery: '프로젝트 경로가 올바른 절대 경로인지 확인하세요.',
    });
  }

  const versionBlocked = await checkGitVersion(opts?.gitVersion);
  if (versionBlocked) return versionBlocked;

  const gitDir = await runGit({ args: ['rev-parse', '--git-dir'], cwd: projectPath });
  if (!gitDir.ok) {
    return blocked({
      error: `git 저장소가 아닙니다: ${projectPath}`,
      recovery: '`git init` 으로 저장소를 만들거나 올바른 프로젝트 경로를 지정하세요.',
    });
  }

  // `--verify` 가 필수다: 빈 bare 저장소에서는 `rev-parse HEAD` 가 종료 코드 0 과
  // 함께 문자열 "HEAD" 를 그대로 출력한다(SHA 가 아니다 — 실측, git 2.55.0). `--verify`
  // 는 같은 상황에서 정직하게 exit 128 로 실패한다. detached HEAD 등 정상 케이스는
  // `--verify` 로도 그대로 SHA 를 반환하므로 회귀가 없다(실측으로 확인).
  const head = await runGit({ args: ['rev-parse', '--verify', 'HEAD'], cwd: projectPath });
  if (!head.ok) {
    // 여기서 in-place 로 조용히 강등하면 사용자 프로젝트 파일을 델리게이트가 직접
    // 고치게 된다 — 그래서 무엇을 할지 호출자가 고르게 한다.
    // 문구는 사실이어야 한다: `git checkout --orphan <new>` 상태의 저장소는 커밋이
    // 존재하는데도 여기로 온다 — "0 commits" 는 그 경우 거짓말이었다. 막는 판단 자체는
    // 옳다(`worktree add … HEAD` 가 실제로 실패한다). 사실에 맞게 HEAD 기준으로 적는다.
    // ★ 선택지는 **제품이 실제로 받는 것만** 적는다. 예전에는 `in-place` 와 `read-only` 를
    //   함께 권했는데 그 둘은 엔진과 도구 층이 모두 `invalid` 로 거부한다 — 설계 §12.0 의
    //   라이브 실측으로 벤더 CLI 의 도구 권한 플래그가 델리게이트의 셸을 제한하지 못한다는
    //   것이 확인돼, 실제로 성립하는 격리가 일회용 워크트리뿐이 됐기 때문이다. 못 받는 것을
    //   권하면 호출자(모델)는 그것을 골라 한 번 더 거부당하는 막다른 길로 간다.
    return blocked({
      error:
        'HEAD 가 가리키는 커밋이 없습니다 (빈 저장소이거나 unborn 브랜치입니다). 워크트리를 만들 수 없습니다.',
      recovery: '아래 선택지 중 하나를 고르세요.',
      choices: [
        '커밋을 최소 1개 만든 뒤 다시 시도한다 (`git commit --allow-empty -m "init"` 도 된다)',
        '이 저장소에서는 실행하지 않는다 — 커밋이 있는 다른 경로를 project 로 준다',
      ],
    });
  }

  return { ok: true };
}
