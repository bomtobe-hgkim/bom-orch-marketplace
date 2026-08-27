import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { timeoutSignal } from './deadline.mjs';
import { runGit } from './git.mjs';
import {
  acquireNpmCacheLease as defaultAcquireNpmCacheLease,
  releaseNpmCacheLease as defaultReleaseNpmCacheLease,
} from './npm-cache-retention.mjs';
import { PROJECT_CONFIG_FILE } from './project-config.mjs';
import { buildChildEnv } from './providers/child-env.mjs';
import { REASON } from './reason-codes.mjs';
import { fail, renderNotice } from './reason-text.mjs';
import { errorText } from './util/errors.mjs';
import { clipPlain } from './util/strings.mjs';
import { samePath } from './util/paths.mjs';

/**
 * 의존성 제공 — **옵트인 (a) baseline 잠금 파일 설치** (로드맵 §3.6, WS4a 스펙 D행).
 *
 * `src/test-runner.mjs` 의 머리 주석이 명시적으로 **미룬** 결정이 이 파일이다. 그 주석은 버린
 * 두 길을 이름으로 적어 두었다:
 *
 *   - 사용자의 `node_modules` 를 **링크**하면 이 제품이 제공하는 유일한 격리(파일시스템 범위)를
 *     그 자리에서 뚫는다 — 델리게이트가 링크를 타고 사용자의 진짜 트리를 고칠 수 있다.
 *   - 우리가 `npm install` 을 돌리면 **워크트리의** `package.json` 이 지시하는 `postinstall` 이
 *     실행된다. 그 파일은 델리게이트가 쓴다.
 *
 * (a) 는 둘 다 닫는다: 링크하지 않고 **설치**하되, 라이프사이클 스크립트를 끄고, 델리게이트가
 * 한 글자도 쓰기 **전에**(워크트리 = baseline 인 시점) 돌린다.
 *
 * ## 이 파일이 세우는 다섯 가지
 *
 * 1. **옵트인 없이는 아무것도 스폰하지 않는다.** `provisionRequested` 가 거짓이면 이 모듈은
 *    git 에게 묻지도 않고 `{ok:true, ran:false}` 로 되돌아간다. 그것이 로드맵 §3.6 의 종료
 *    기준(「의존성 제공이 옵트인 없이는 절대 실행되지 않음」)이고, `test/deps-provision.test.mjs`
 *    가 **주입된 spawn 의 호출 횟수 0** 으로 그것을 잰다 — 다섯 가지 「옵트인 아님」 모양 전부에서.
 * 2. **명령은 `npm ci --ignore-scripts`** — `install` 이 아니라 `ci` 라서 잠금 파일이 권위이고,
 *    `package.json` 의 범위 표현이 아니다.
 * 3. **패키지 캐시는 `<stateRoot>/cache/npm`** — 사용자의 전역 npm 캐시가 아니다(§아래).
 * 4. **npm spawn 앞에서 durable lease를 세운다.** 소유권·물리 identity를 증명하지 못하면 쓰지 않는다.
 * 5. **실패는 언제나 `deps_unavailable` 거부**다. 던지지 않고, 「의존성 없이 계속」도 없다.
 *
 * ## ★★ 캐시를 stateRoot 안에 두는 이유 — §5.5 의 (c) 예외를 **쓰지 않기 위해서**다
 *
 * 불변식 §5.5 는 「`stateRoot` 밖에 쓰지 않는다」이고, 예외 (c) 로 「의존성 제공을 옵트인했을 때
 * 패키지 관리자의 전역 캐시」를 열어 두었다 — 다만 그 예외는 WS4a 가 **어느 경로에 쓰는지 OS 별로
 * 열거**하고 오너 승인을 받아야만 성립한다(스펙 §8-1).
 *
 * 그 예외를 쓰지 않는 편이 낫다. `npm` 은 캐시 위치를 명령줄 하나로 받는다. 캐시를
 * `<stateRoot>/cache/npm` 으로 고정하면:
 *
 *   · §5.5 가 **예외 없이** 성립한다. OS 별 전역 캐시 경로 표도, 오너 승인 관문도 필요 없다.
 *     종료 기준의 「전역 캐시 경로가 OS 별로 열거·문서화됨」은 **전역 캐시에 쓰지 않는다**는
 *     사실과 실제로 쓰는 한 경로를 문서가 적는 것으로 충족된다(배포 문서 둘의 privacy 절).
 *   · 사용자의 진짜 npm 캐시가 이 제품 때문에 자라거나 오염되지 않는다.
 *   · 실측: 캐시 디렉터리에는 패키지 tarball 만이 아니라 npm 자신의 디버그 로그(`_logs/`)도
 *     쌓인다. 전역 캐시를 썼다면 그 로그가 사용자 프로필에 남았을 것이다.
 *
 * 대가도 적는다. 첫 실행은 **네트워크에서 받아야 한다** — 사용자의 전역 캐시에 이미 있는
 * tarball 을 재사용하지 못한다. 두 번째 실행부터는 이 캐시가 채워져 `--prefer-offline` 이
 * 실제로 오프라인으로 끝난다(같은 stateRoot 를 쓰는 한, 레인 둘 사이에서도 그렇다).
 * 설치가 끝나면 lease를 내리고 그 시각부터 idle TTL 30일을 다시 센다. 크기 상한은 없다 —
 * `npm`의 내부 항목을 일부 지우면 캐시 자체의 일관성을 우리가 떠맡게 되므로, 스윕은 활성/조회
 * 불명 lease가 하나라도 있으면 보존하고 TTL에 닿은 **정확히 소유한 root 전체**만 지운다.
 * 표식 없는 0.2.2 캐시는 발견 시각으로 v1 claim해 30일 grace를 온전히 준다.
 *
 * ## ★★ 명령줄과 자식 환경 — 둘 다 세운다 (실측)
 *
 * npm 의 설정 우선순위는 **명령줄 > 환경 변수 > 프로젝트 `.npmrc` > 사용자 `.npmrc`** 다.
 * 우리가 막아야 하는 두 값(캐시 위치 · 스크립트 스위치)은 그 사슬의 어느 칸에서든 뒤집힐 수
 * 있으므로 **가장 센 칸(명령줄)과 그다음 칸(환경)에 같은 값을 둔다.**
 *
 * 실측(Windows 11 · node v24.18.0 · npm 11.16.0, 2026-08-24). 픽스처는 `file:` 의존성 하나를
 * 가진 프로젝트이고, 루트와 의존성 양쪽에 마커를 쓰는 라이프사이클 스크립트 여섯을 심었다.
 * 프로젝트에는 **적대적 `.npmrc`**(`ignore-scripts=false`, `cache=<EVIL>`)를 커밋해 두었다:
 *
 *     1 대조군: `npm ci` (스크립트 허용)         -> 마커 **여섯 개** 전부 생성, node_modules 생성
 *     2 우리 플래그만                             -> 마커 0, 설치 성공, 캐시는 우리 경로, EVIL 없음
 *     3 우리 플래그 + 적대적 주변 env             -> 마커 0, 캐시는 우리 경로, EVIL 없음
 *       (`npm_config_ignore_scripts=false` · `npm_config_cache=<EVIL>` · `npm_config_foreground_scripts=true`)
 *     4 환경만(플래그 없이)                       -> 마커 0, 캐시는 우리 경로, EVIL 없음
 *
 * 1 이 대조군이다 — 그것이 없으면 「마커 0」은 스크립트가 원래 안 도는 픽스처였다는 뜻일 수도
 * 있다. 2 는 명령줄이 프로젝트 `.npmrc` 를 이긴다는 것을, 3 은 명령줄이 환경까지 이긴다는 것을,
 * 4 는 환경만으로도 프로젝트 `.npmrc` 를 이긴다는 것을 각각 가른다.
 *
 * ★ 그런데 자식 환경은 애초에 `buildChildEnv` 가 **빈 객체 + allowlist** 로 짓는다
 *   (`src/providers/child-env.mjs`). `npm_config_*` 도 `NODE_OPTIONS` 도 allowlist 에 없으므로
 *   주변 환경의 그 이름들은 자식에 **도달조차 하지 않는다.** 위 3 번은 그래도 재 둔다: 이
 *   모듈이 언젠가 다른 방식으로 환경을 짓게 되는 날 무엇이 깨지는지가 그 줄에 적혀 있다.
 * ★ `--cache` 를 세워도 `npm config get cache` 로는 확인할 수 없다(실측: npm 11 은
 *   `The cache option is protected, and cannot be retrieved in this way` 로 거부한다). 그래서
 *   **어디에 실제로 썼는지**로 잰다 — npm 이 자기 디버그 로그를 `<cache>/_logs` 에 쓰므로,
 *   그 디렉터리가 어느 쪽에 생겼는지가 답이다.
 *
 * ## ★★ npm 이 절대 경로로 **쓸 수 있는** 설정 키 — 전수 조사 (실측)
 *
 * npm 11.16.0 의 설정 정의 180개 중 경로 타입은 **열**이고(`cache` · `cafile` · `globalconfig` ·
 * `init-module`(+폐기된 별칭 `init.module`) · `logs-dir` · `node-gyp` · `prefix` ·
 * `provenance-file` · `userconfig`), 그중 `npm ci` 가 **쓰는** 것은 `cache` 와 `logs-dir` 둘뿐이라
 * 둘 다 명령줄로 못박는다(`--cache` · `--logs-dir`) — 나머지 여덟은 읽기 전용이거나
 * (`cafile`·`globalconfig`·`userconfig`·`node-gyp`), 다른 명령 전용이거나(`init-module` 은
 * `npm init`, `provenance-file` 은 `npm publish`), `npm ci` 가 아예 거부하는 모드에서만 쓰기
 * 대상이 된다(`prefix` — `npm ci` 는 `global` 이면 「does not work for global packages」로 던진다,
 * 실측: `lib/commands/ci.js`). **이 문장이 배포 문서의 「nothing lands outside BOM_ORCH_HOME」을
 * 받치는 근거다.** 못박지 못하는 쓰기 키는 없다 — 있었다면 문서 문장을 내렸을 것이다.
 *
 * ★ `--logs-dir` 이 따로 필요한 이유(실측 2026-08-24, 위 픽스처의 `.npmrc` 에 `logs-dir=<EVIL>`
 *   과 `cache=<EVIL>` 를 커밋해 두고 잠금 파일만 있는 프로젝트에 `npm ci`):
 *
 *     `--cache <OURS>` 만                         -> 디버그 로그가 **`<EVIL>/logs`** 에 생겼다
 *     `--cache <OURS>` + `--logs-dir <OURS>/_logs` -> 로그가 우리 캐시 안, `<EVIL>` 은 생기지 않았다
 *     `npm_config_logs_dir` 만(플래그 없이)        -> 같은 결과. 그래서 여기서도 둘 다 세운다
 *
 *   즉 `--cache` 는 이 키를 덮지 **않는다** — `logs-dir` 의 기본값이 `${cache}/_logs` 일 뿐이고,
 *   `.npmrc` 한 줄(프로젝트의 baseline 커밋 사본 또는 사용자 홈의 것 — HOME/USERPROFILE 은
 *   레지스트리 인증 때문에 allowlist 에 있다)이면 절대 경로로 새어 나간다. 첫 줄이 그 구멍의
 *   실측이고, 그것이 상태 루트 밖으로 나가는 유일한 쓰기였다.
 * ★ `tmp` 는 npm 11 의 키 목록에 **없다**(실측: 180개 중 부재). 옛 npm 의 그 키를 못박으려는
 *   코드는 오늘 아무것도 하지 않으므로 두지 않는다.
 *
 * ## 왜 `node <npm-cli.js>` 인가
 *
 * 실측(`src/providers/child-env.mjs` 의 같은 측정): `spawn('npm', …, {shell:false})` 는 ENOENT 다 —
 * Windows 의 `npm` 은 `.cmd` 셈이고 이 저장소는 `shell:false` 를 강제한다. 그래서 노드 옆에 함께
 * 깔리는 스크립트를 **절대 경로로** 가리켜 `process.execPath` 로 띄운다(`findNpmCli`, 배치 둘).
 * 이 결정은 러너의 npm 폴백과 같은 하나이고, 그래서 그 함수의 정본이 이 파일로 왔다 —
 * `src/test-runner.mjs`·`src/test-discovery.mjs` 가 여기서 수입해 쓴다(방향은 한쪽이다).
 *
 * ## 무엇을 하지 않는가
 *
 *   · **네트워크를 직접 재지 않는다.** 「네트워크가 없으면 설치하지 않는다」는 npm 자신의 실패로
 *     도착한다(비0 종료 + stderr). 우리가 따로 프로브를 띄우면 프로브가 통과하고 설치가 실패하는
 *     창이 새로 생기고, 그 창은 봉투가 설명할 수 없는 결과를 만든다.
 *   · **yarn·pnpm 을 다루지 않는다.** 스키마의 값은 `lockfile-install` 하나이고 그 뜻은 npm 이다
 *     (`contract/project-config.schema.json`). 다른 관리자는 자기 이름의 값을 가질 때 온다.
 *   · **캐시 내부를 부분 회수하거나 크기로 자르지 않는다**(위 §캐시 문단).
 *   · **자식의 stdout 을 파이프로 열지도 않는다** — `stdio: ['ignore','ignore','pipe']`. 봉투에
 *     실릴 수 있는 것은 라벨된·길이 제한된 stderr 발췌 한 줄뿐이다(불변식 4).
 *
 * ## 실측 폐포 (2026-08-27, WS6 npm cache lease)
 *
 * **21개 모듈 / 7,721줄**(자기 자신 594 포함): `deadline`(80) · `git`(1,128)과 그것이 끄는
 * `providers/error-catalog`(437)·`providers/resolve-binary`(291)·`state-root`(34) ·
 * `project-config`(489) · `providers/child-env`(465) · `reason-codes`(716) · `reason-text`(1,294) ·
 * `npm-cache-retention`(896)와 그 잎 `lockfile`(193)·`lockfile-acquire`(122)·
 * `process-identity`(202)·`real-path`(54)·
 * `util/fs-atomic`(206)·`util/paths`(60)·`util/strict-json`(116) · `util/errors`(120) · `util/freeze`(43) ·
 * `util/strings`(181) — 항목의 합이 총합이다.
 * 저장소 모듈(`run-artifacts`·`run-store-fs`·`run-records`·`run-inspect`)은 **0개**이고
 * `content-projection` 도 `engine` 도 `test-runner` 도 없다 — 방향은 한쪽이다.
 */

/** 스키마 `tests.provisionDeps` 의 옵트인 값. 정본은 `contract/project-config.schema.json` 의 enum. */
export const PROVISION_LOCKFILE_INSTALL = 'lockfile-install';

/**
 * `npm ci` 가 권위로 받아들이는 잠금 파일 둘. 순서가 뜻이다 — npm 자신이 `npm-shrinkwrap.json`
 * 을 우선하지만, 우리는 **존재 여부만** 묻고 무엇을 쓸지는 npm 이 정하므로 흔한 쪽을 먼저 묻는다.
 */
export const NPM_LOCKFILES = Object.freeze(['package-lock.json', 'npm-shrinkwrap.json']);

/**
 * 설치 하나의 벽시계 상한.
 *
 * 왜 5분인가: 차가운 캐시에서 중간 크기 저장소의 `npm ci` 는 분 단위로 걸린다 — 넉넉해야 멀쩡한
 * 설치를 우리가 잘라 놓고 `deps_unavailable` 이라고 말하는 일이 없다. 동시에 상한이 **있어야**
 * 응답 없는 레지스트리 연결 하나가 실행의 데드라인 전체를 먹지 않는다. 실행 데드라인이 더 짧으면
 * 그쪽이 먼저 자른다(`signal`) — 둘 중 이른 쪽이 이긴다.
 */
export const PROVISION_TIMEOUT_MS = 300_000;

/**
 * `kill` 뒤에 `close` 를 기다리는 유예. `src/providers/run-cli.mjs`·`src/test-spawn.mjs` 와 같은
 * 값이고, 사본이 셋인 이유도 같다 — 자식을 띄우는 쪽이 자기 유예를 갖는다(import 방향을 뒤집지 않는다).
 */
export const KILL_GRACE_MS = 3_000;

/** stderr 발췌의 코드유닛 상한. `{detail}` 은 봉투의 평면 필드 한 칸이고 렌더가 200 에서 또 자른다. */
const DETAIL_CHARS = 120;

/** 자식 stderr 를 메모리에 쌓는 상한. 이 값을 넘으면 뒤는 버린다 — 우리가 읽는 것은 첫 줄뿐이다. */
const MAX_STDERR_CHARS = 8_192;

const WINDOWS = process.platform === 'win32';

const GIT_TIMEOUT_MS = 15_000;

/**
 * 이 실행의 패키지 캐시. **`stateRoot` 안**이다(위 §캐시 문단).
 *
 * `worktrees/`·`patches/`·`scratch/`·`logs/` 와 같은 층에 둔다 — 실행마다가 아니라 stateRoot
 * 마다 하나인 것이 요점이다: 레인 둘과 다음 실행이 같은 캐시를 재사용해야
 * `--prefer-offline` 이 실제로 오프라인이 된다.
 */
export function npmCacheDir(stateRoot) {
  return join(stateRoot, 'cache', 'npm');
}

/**
 * 이 설정이 의존성 제공을 **켰는가.** 단 하나의 값에만 참이다.
 *
 * ★ 관대하게 읽지 않는다. 대소문자 접기도, `true`/`1` 같은 「그런 뜻이었겠지」도 없다 — 스키마의
 *   enum 밖 값은 애초에 `config_invalid` 로 거부되므로 여기 오는 값은 이미 둘 중 하나이고,
 *   그럼에도 관대하게 읽으면 이 함수가 스키마보다 넓어져 「옵트인 없이는 실행되지 않는다」는
 *   증명이 이 함수의 관대함만큼 약해진다.
 */
export function provisionRequested(config) {
  return config !== null && typeof config === 'object' &&
    config.tests !== null && typeof config.tests === 'object' &&
    config.tests.provisionDeps === PROVISION_LOCKFILE_INSTALL;
}

/**
 * npm 셈이 감싸고 있는 `npm-cli.js`. 없으면 null.
 *
 * 실측: `spawn('npm', ['--version'], { shell:false })` 는 ENOENT 이고
 * `resolveLaunch({ basename: 'npm' })` 는 cli_shim_only 를 던진다 — npm 셈은 벤더 CLI 셈과
 * 형태가 달라 `resolveThroughShim` 도 풀지 못한다. 대신 노드 옆에 함께 깔리는 스크립트를
 * 직접 가리킨다.
 *
 * ★ **배치가 둘이다.** 하나만 알면 다른 쪽 호스트에서 이 폴백이 통째로 죽는다.
 *
 *     [Windows] …\node\x64\node.exe      옆에  …\node\x64\node_modules\npm\bin\npm-cli.js
 *     [POSIX  ] …/node/x64/bin/node      위에  …/node/x64/lib/node_modules/npm/bin/npm-cli.js
 *
 * 실측: Windows 는 실행 파일과 `node_modules` 가 **같은 디렉터리**에 있고
 * (`node <그 경로> --version` -> 11.16.0), POSIX 툴캐시는 실행 파일이 `bin/` 안이라
 * 한 칸 올라가 `lib/` 아래를 봐야 한다. 예전 구현은 앞쪽만 알았고, 그래서 CI 의 ubuntu·
 * macOS 러너에서는 `node --run` 을 못 쓰는 순간 `unresolvedTool:'npm'` 으로 접혔다 —
 * 델리게이트가 워크트리에 심은 `pretest`·`.npmrc` 를 스폰 전에 거부하는 하드닝이 그
 * 호스트들에서 **한 번도 무장되지 않았다**는 뜻이다.
 *
 * 못 찾으면 **던지지 않고 null** 이다. 두 호출부가 각자의 언어로 그 사실을 말한다 —
 * 러너는 `unresolvedTool:'npm'`, 이 모듈은 `deps_unavailable` 이다.
 *
 * ★ 이 함수는 `src/test-runner.mjs` 에서 왔다(WS4a 태스크 5). 「셸 없이 npm 을 띄우는 법」은
 *   러너와 제공기가 **같이** 아는 사실 하나이고, 정본이 둘이면 한쪽만 배치를 배우는 날이 온다.
 */
export async function findNpmCli(execPath) {
  const execDir = dirname(execPath);
  const candidates = [
    join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 이 배치가 아니다 — 다음 배치를 본다. 마지막까지 없으면 아래 null.
    }
  }
  return null;
}

/** 이 모듈이 내는 유일한 거부. 문구 정본은 `src/reason-text.mjs` 이고 여기서는 사실만 고른다. */
function refuse(detail) {
  return fail(REASON.deps_unavailable, { file: PROJECT_CONFIG_FILE, detail: clipPlain(detail, DETAIL_CHARS) });
}

/**
 * baseline 커밋에 이 경로의 blob 이 있는가. **워크트리 파일이 아니라 커밋 오브젝트**에 묻는다 —
 * 델리게이트가 워크트리에 잠금 파일을 심어 설치를 유도할 수 있으면 옵트인의 뜻이 뒤집힌다.
 *
 * ★ 「없다」의 정확한 모양은 셋을 **전부** 만족한다: 스폰됐고 · exit 1 이고 · stdout·stderr 가
 *   둘 다 비었다. 이 판정은 `src/project-config.mjs` 가 git 2.55.0 으로 실측해 적어 둔 것과 같은
 *   것이고, 그 파일의 §측정해서 얻은 git 사실 문단이 근거의 정본이다. 사본을 두는 이유는
 *   `UNKNOWN_VALUE`·`isBlocked`·`pathContains` 를 복사한 것과 같다(WS3 태스크 9·10): 순수한
 *   판정 한 줄이고, 그것 하나 때문에 설정 리더의 실패 렌더(`config_invalid` 고정)를 이 모듈의
 *   어휘로 일반화하면 리뷰가 끝난 코드가 흔들린다.
 * ★ 실패를 「없음」으로 접지 않는다. 접으면 사용자가 켠 옵트인이 **조용히 무시된 채** 실행이
 *   돌고, 그 결과가 곧 「의존성 없이 도는 스위트」다 — 이 모듈이 막으려는 바로 그것이다.
 *
 * @returns `{ ok: true, present: boolean }` 또는 `{ ok: false, detail }`.
 */
async function blobPresent({ commit, path, cwd }, run) {
  const found = await run({
    args: ['rev-parse', '--verify', '--quiet', `${commit}:${path}`],
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (found.ok === true) return { ok: true, present: true };
  const absent = found.failed !== true && found.exitCode === 1 && found.stdout === '' && found.stderr === '';
  if (absent) return { ok: true, present: false };
  const exit = Number.isInteger(found.exitCode) ? `exit ${found.exitCode}` : 'no exit status';
  const said = typeof found.stderr === 'string' && found.stderr.trim() !== '' ? found.stderr : '';
  return { ok: false, detail: `the repository could not say whether ${path} exists (${exit}${said === '' ? '' : `: ${firstLine(said)}`})` };
}

/** 발췌는 **첫 줄**뿐이다. npm 의 오류는 첫 줄에 코드(`npm error code EUSAGE`)를 싣는다. */
function firstLine(text) {
  return String(text).split('\n')[0].trim();
}

/**
 * 설치 자식 하나를 띄우고 **종료 코드와 stderr 첫 줄만** 들고 돌아온다. 절대 throw 하지 않는다.
 *
 * 구조는 `src/test-spawn.mjs` 의 `spawnAndCollect` 와 같은 규율을 따른다:
 *   · 데드라인 타이머는 스폰 **앞**에서 만든다(스폰과 보호 try 사이에 한 줄도 두지 않는다).
 *   · `'error'` 리스너를 던질 수 있는 어떤 코드보다 **먼저** 붙인다 — 안 그러면 봉투가 정상
 *     반환된 **뒤에** 자식의 ENOENT 가 리스너 없이 터져 stdio 로 물린 MCP 세션이 끊긴다.
 *   · `kill` 뒤에 `close` 가 안 와도 `KILL_GRACE_MS` 못이 결과를 내보낸다.
 * 러너 쪽 함수를 수입하지 않는 이유는 방향과 모양이다(test-runner → deps-provision). 이쪽은
 * stdout 파이프도 드레인 유예도 없어서 절반 크기다.
 */
async function runInstall({ command, args, cwd, env, signal, timeoutMs, onSpawn }, deps) {
  const spawnChild = deps.spawn ?? spawn;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  if (signal?.aborted === true) return { outcome: 'aborted' };

  // ★ 스폰 **앞**에서 만든다 — 아래 보호 try 안에서 만들면 그 사이에 던지는 줄이 생긴다.
  const deadline = timeoutSignal(timeoutMs);

  let child;
  try {
    child = spawnChild(command, args, {
      cwd,
      env, // ★ 교체다. buildChildEnv 가 만든 것이 자식 환경의 전부다.
      shell: false,
      windowsHide: true,
      // stdout 은 파이프조차 만들지 않는다: 우리가 읽을 것이 없고, 없는 파이프는 샐 수 없다.
      stdio: ['ignore', 'ignore', 'pipe'],
      // POSIX 에서만: 자식이 자기 프로세스 그룹을 이끌어야 리퍼가 손자까지 끊을 수 있다.
      ...(WINDOWS ? {} : { detached: true }),
    });
  } catch (error) {
    return { outcome: 'spawn_failed', detail: errorText(error) };
  }

  let settle = null;
  let early = null;
  child.on('error', (error) => {
    // `kill` 시스콜 실패는 스폰 실패가 아니다(engines 하한 libuv 는 종료 중인 자식의 재-kill 에
    // EPERM 을 올린다). 아래 못이 결과를 보장하므로 무시한다.
    if (error?.syscall === 'kill') return;
    if (settle !== null) settle({ outcome: 'spawn_failed', detail: errorText(error) });
    else early = error;
  });

  let stderrText = '';
  let stopReason = null;
  let finished = false;
  let hardTimer = null;
  const stop = (reason) => {
    if (finished || stopReason !== null) return;
    stopReason = reason;
    try {
      child.kill();
    } catch {
      // 이미 죽었으면 할 일이 없다.
    }
    if (hardTimer === null) hardTimer = setTimer(() => settle?.({ outcome: reason, detail: 'the child did not exit' }), KILL_GRACE_MS);
  };
  const onAbort = () => stop('aborted');
  const onDeadline = () => stop('timed_out');

  try {
    if (typeof onSpawn === 'function') {
      // 배선 계층(리퍼 원장 · 트리 킬 대상 등록)에 넘긴다. 기다리지 않고 거부는 삼킨다 —
      // 원장은 최선의 노력이고, 그것 때문에 이미 도는 설치를 죽이면 안 된다.
      const tracked = onSpawn(child);
      if (tracked && typeof tracked.catch === 'function') tracked.catch(() => {});
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderrText.length < MAX_STDERR_CHARS) stderrText += chunk;
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    deadline?.addEventListener('abort', onDeadline, { once: true });

    const settled = await new Promise((resolve) => {
      settle = (value) => {
        if (finished) return;
        finished = true;
        resolve(value);
      };
      if (early !== null) settle({ outcome: 'spawn_failed', detail: errorText(early) });
      // ★ 두 번째 인자를 버리지 않는다. 신호로 죽은 자식은 `code` 가 null 이고 이름만 남는다 —
      //   버리면 거부 문장이 「exit null」이 된다(리퍼의 트리 킬이 만드는 흔한 모양이다).
      child.on('close', (code, signalName) => settle({
        outcome: stopReason ?? (code === 0 ? 'installed' : 'exit_nonzero'),
        exitCode: code,
        signal: signalName,
      }));
      if (signal?.aborted === true) stop('aborted');
    });
    return { ...settled, stderr: stderrText };
  } catch (error) {
    stop('aborted');
    return { outcome: 'spawn_failed', detail: errorText(error), stderr: stderrText };
  } finally {
    finished = true;
    clearTimer(hardTimer);
    signal?.removeEventListener?.('abort', onAbort);
    deadline?.removeEventListener?.('abort', onDeadline);
  }
}

/**
 * 한 레인의 워크트리에 baseline 잠금 파일로 의존성을 깐다.
 *
 * 부르는 자리는 `src/engine.mjs` 하나이고, **워크트리가 생긴 뒤 · writer 가 시작되기 전**이다.
 * 그 자리가 유일한 정답인 이유: 이 시점의 워크트리는 baseline 과 바이트가 같아서 우리가 읽는
 * `package.json` 도 `.npmrc` 도 사용자가 커밋한 것이고, 델리게이트는 아직 아무것도 쓰지 않았다.
 *
 * @param config          **baseline 커밋에서 읽은** 설정(`src/project-config.mjs`). 워크트리
 *                        사본에서 온 값을 넘기면 이 모듈의 전제가 통째로 무너진다.
 * @param baselineCommit  이 실행이 봉인한 baseline 커밋. 잠금 파일을 여기서 찾는다.
 * @param worktreePath    설치가 돌 곳이자 산출물이 남는 유일한 곳.
 * @param stateRoot       패키지 캐시가 사는 곳(`npmCacheDir`).
 * @param signal          실행 데드라인. 상한보다 이르면 이쪽이 먼저 자른다.
 * @param onSpawn         자식을 엔진의 배선(리퍼 원장 · 트리 킬)에 등록하는 이음매.
 * @returns `{ ok:true, ran:false }`(옵트인 없음) · `{ ok:true, ran:true, lockfile, cacheDir, notices }`
 *   · `{ ok:false, hardStopped:true }`(실행이 멈추는 중 — **코드도 문구도 없다**, 아래 ★★) ·
 *   `fail(deps_unavailable)` 봉투. **던지지 않는다.**
 */
export async function provisionDependencies(
  { config, baselineCommit, worktreePath, stateRoot, runId, signal } = {},
  deps = {},
) {
  // ★★ 첫 줄이고 유일한 관문이다. 여기서 되돌아가는 실행은 git 도 자식도 건드리지 않는다 —
  //   로드맵 §3.6 의 종료 기준이 재는 것이 정확히 이 줄이다.
  if (!provisionRequested(config)) return { ok: true, ran: false };

  // ★★ 그 **바로 다음**이 실행 신호다(WS4a 태스크 11, 리뷰 m28). 예전에는 이 판정이
  //   `runInstall` 안과 그 결과를 읽는 아래 갈래에만 있었고, 그래서 이미 멈춘 실행이 잠금 파일을
  //   묻는 git 왕복 둘과 캐시 디렉터리 `mkdir` 하나를 **먼저** 하고 나서야 중립으로 돌아왔다.
  //   그 부수효과는 봉투에 흔적을 남기지 않아 아무도 못 보지만 상태 루트에는 남는다. 되돌아가는
  //   값은 아래 갈래와 글자까지 같다 — 코드도 문구도 없는 중립이고, 이름은 엔진이 붙인다.
  //   ★ 옵트인 관문 **뒤**인 것이 뜻이다: 옵트인하지 않은 실행에게 이 모듈의 답은 언제나
  //     `{ok:true, ran:false}` 여야 하고, 「끊겼다」는 그 실행에 대해 이 모듈이 할 말이 아니다.
  if (signal?.aborted === true) return { ok: false, hardStopped: true };

  // ★ 「던지지 않는다」를 **모든 입력에 대해** 참으로 만드는 세 줄. 이 셋은 아래에서 경로 조립과
  //   git 인자에 그대로 들어가고, 문자열이 아니면 `join` 이 TypeError 를 던진다 — 그러면 이
  //   함수의 계약이 호출부의 성실함에만 기대는 문장이 된다. 오늘의 유일한 호출부(엔진)는 셋 다
  //   검증된 값을 주지만, 그 사실은 이 파일에서 읽히지 않는다.
  if ([baselineCommit, worktreePath, stateRoot].some((value) => typeof value !== 'string' || value === '')) {
    return refuse('the run did not name a baseline commit, a worktree and a state root');
  }

  const run = deps.runGit ?? runGit;
  let lockfile = null;
  for (const name of NPM_LOCKFILES) {
    const found = await blobPresent({ commit: baselineCommit, path: name, cwd: worktreePath }, run);
    if (found.ok !== true) return refuse(found.detail);
    if (found.present) { lockfile = name; break; }
  }
  if (lockfile === null) {
    return refuse(`the baseline commit carries no ${NPM_LOCKFILES.join(' or ')}`);
  }

  const execPath = deps.execPath ?? process.execPath;
  const npmCli = await (deps.npmCliPath ?? findNpmCli)(execPath);
  if (npmCli === null || npmCli === undefined) {
    return refuse('the npm command line that ships with Node.js was not found next to this Node.js executable');
  }

  const cacheDir = npmCacheDir(stateRoot);
  // npm 자신의 기본 자리와 **같은 경로**다(`${cache}/_logs`). 값을 바꾸려는 게 아니라, 그 값이
  // `.npmrc` 에서 뒤집히지 않게 가장 센 칸에 같은 것을 두는 것이다. 0700 인 캐시 안이라
  // 디렉터리를 따로 만들지 않아도 다른 사용자는 통과하지 못한다.
  const logsDir = join(cacheDir, '_logs');
  // ★ `npm ci`보다 먼저 durable active lease를 잡는다. 캐시 디렉터리의 0700 생성, owner marker,
  //   물리 identity, 상위 schema/foreign/link 거부는 모두 그 원자 경계의 한 계약이다. 여기서 다시
  //   mkdir하면 표식을 못 세운 cache에 npm이 쓰는 두 번째 경로가 생긴다.
  const acquireCache = deps.acquireNpmCacheLease ?? defaultAcquireNpmCacheLease;
  const releaseCache = deps.releaseNpmCacheLease ?? defaultReleaseNpmCacheLease;
  let acquired;
  try {
    acquired = await acquireCache({
      stateRoot,
      nowMs: (typeof deps.nowMs === 'function' ? deps.nowMs : Date.now)(),
      pid: Number.isInteger(deps.selfPid) && deps.selfPid > 0 ? deps.selfPid : process.pid,
    }, deps.cacheLeaseDeps);
  } catch (error) {
    return refuse(`the package cache lease could not be acquired (${errorText(error)})`);
  }
  const hasHandle = acquired?.handle !== null && typeof acquired?.handle === 'object';
  if (acquired?.ok !== true || typeof acquired.cacheDir !== 'string' ||
      !samePath(acquired.cacheDir, cacheDir, deps.platform) || !hasHandle) {
    // 거부하더라도 획득이 성공해 handle이 생겼다면 소유권을 반환한다. 경로 검증 실패가
    // active lease 누수로 바뀌면 해당 캐시는 다음 부팅까지 활성으로 잘못 보존된다.
    if (acquired?.ok === true && hasHandle) {
      try {
        await releaseCache(
          acquired.handle,
          { nowMs: (typeof deps.nowMs === 'function' ? deps.nowMs : Date.now)() },
          deps.cacheLeaseDeps,
        );
      } catch {
        // 해제 실패는 원래의 소유권 거부 결과를 덮지 않는다.
      }
    }
    const status = typeof acquired?.status === 'string' && acquired.status !== '' ? acquired.status : 'unavailable';
    const refused = refuse(`the package cache lease could not be acquired (${status})`);
    // 상위 schema 좌표는 저수준 lease 리더의 정확한 판정이다. 중간 계층이
    // `newer_schema`라는 detail로 접으면 engine이 표준 state_schema_newer 회복을 만들 수 없다.
    return acquired?.stateSchema === undefined ? refused : { ...refused, stateSchema: acquired.stateSchema };
  }

  let result;
  let releaseFailure = null;
  try {
    const args = [
      npmCli, 'ci',
      // 제3자 `postinstall` 과 워크트리 `package.json` 의 스크립트를 통째로 끈다. 이 하나가
      // 러너의 머리 주석이 `npm install` 을 거부한 이유를 닫는다.
      '--ignore-scripts',
      // 캐시에 있는 것은 네트워크에 묻지 않는다. 두 번째 레인과 다음 실행이 이 값을 쓴다.
      '--prefer-offline',
      // audit·fund 는 네트워크 왕복과 사람용 배너다. 둘 다 설치 결과와 무관하다.
      '--no-audit', '--no-fund',
      // 진행 막대와 `npm notice` 배너를 끈다(실측: 대조군 실행의 stderr 첫 줄이 `npm notice` 였다).
      // 발췌가 한 줄뿐이므로 그 한 줄은 배너가 아니라 **오류**여야 한다.
      '--no-progress', '--loglevel=error',
      '--cache', cacheDir,
      // npm 은 호출마다 디버그 로그를 하나 쓰고, 그 자리를 정하는 것은 `--cache` 가 **아니다**
      // (위 §쓰기 대상 조사의 실측). 기본값과 같은 경로를 명시해 `.npmrc` 의 절대 경로가
      // 상태 루트 밖으로 나가는 유일한 길을 닫는다.
      '--logs-dir', logsDir,
    ];
    const env = buildChildEnv(deps.env ?? process.env, {
      authNames: [], // npm 은 벤더 인증을 쓰지 않는다. 레지스트리 인증은 사용자 `.npmrc` 에 있다.
      runId,
      // 명령줄과 **같은 값**을 환경에도 둔다(위 §명령줄과 자식 환경).
      extra: { npm_config_cache: cacheDir, npm_config_logs_dir: logsDir, npm_config_ignore_scripts: 'true' },
    });

    result = await runInstall({
      command: execPath,
      args,
      cwd: worktreePath,
      env,
      signal,
      timeoutMs: deps.timeoutMs ?? PROVISION_TIMEOUT_MS,
      onSpawn: deps.onSpawn,
    }, deps);
  } finally {
    try {
      const released = await releaseCache(
        acquired.handle,
        { nowMs: (typeof deps.nowMs === 'function' ? deps.nowMs : Date.now)() },
        deps.cacheLeaseDeps,
      );
      if (released?.ok === false) releaseFailure = released;
    } catch (error) {
      // 설치 효과는 이미 일어났다. 해제 실패를 설치 실패로 바꾸지는 않되, 호출자가
      // state schema notice나 내부 진단을 합칠 수 있도록 실패 원형을 버리지 않는다.
      releaseFailure = { ok: false, status: 'release_failed', detail: errorText(error) };
    }
  }

  const withReleaseFailure = (value) => releaseFailure === null ? value : {
    ...value,
    cacheLeaseRelease: releaseFailure,
    ...(releaseFailure.stateSchema === undefined ? {} : { stateSchema: releaseFailure.stateSchema }),
  };

  if (result.outcome === 'installed') {
    return withReleaseFailure({
      ok: true,
      ran: true,
      lockfile,
      cacheDir,
      notices: [renderNotice('deps_provisioned', { lockfile, cache: cacheDir })],
    });
  }
  // ★★ 실행 신호가 발화했으면 이 모듈은 **이유를 대지 않는다.** 여기서 아는 것은 「우리 자식이
  //   끝나기 전에 실행이 멈췄다」뿐이고, 「누가 껐는가」(취소인가 마감인가)의 권위는 저장소에
  //   `haltReasonCode()` 하나다(`src/engine.mjs`). 코드도 문구도 없이 중립으로 돌려보내면 엔진의
  //   halt 자리가 형제 단계들과 **같은 규율**로 그것을 이름 붙인다. 예전에는 이 갈래가
  //   `deps_unavailable` + 「잠금 파일을 커밋하라」였다 — 정지 버튼을 누른 사용자에게 거짓이다.
  // ★ 자기 상한(`timed_out`)보다 **먼저** 본다. 두 컷이 같은 틱에 도착할 수 있고, 그때 봉투가
  //   어느 리스너가 이겼는지에 따라 갈리면 안 된다 — 실행이 멈추는 중이면 그것이 답이다.
  if (result.outcome === 'aborted' || signal?.aborted === true) {
    return withReleaseFailure({ ok: false, hardStopped: true });
  }
  if (result.outcome === 'timed_out') {
    return withReleaseFailure(refuse(`the install timed out after ${deps.timeoutMs ?? PROVISION_TIMEOUT_MS}ms`));
  }
  if (result.outcome === 'spawn_failed') {
    return withReleaseFailure(refuse(`the install could not be started (${result.detail})`));
  }
  const said = firstLine(result.stderr ?? '');
  // 「exit null」이라고 적지 않는다. 신호로 죽은 자식에게는 종료 코드가 없고, 그 사실을 이름으로
  // 말해야 사용자가 무엇을 본 것인지 안다(`blobPresent` 의 'no exit status' 와 같은 규율).
  const ended = Number.isInteger(result.exitCode)
    ? `exit ${result.exitCode}`
    : typeof result.signal === 'string' && result.signal !== '' ? `signal ${result.signal}` : 'no exit status';
  return withReleaseFailure(refuse(`npm ci ended with ${ended}${said === '' ? '' : `: ${said}`}`));
}
