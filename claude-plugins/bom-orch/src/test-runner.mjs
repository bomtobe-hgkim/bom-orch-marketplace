import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { timeoutSignal } from './deadline.mjs';
import { runGit } from './git.mjs';
import { buildChildEnv } from './providers/child-env.mjs';
import { resolveBinary } from './providers/resolve-binary.mjs';

/**
 * 테스트를 **오케스트레이터가 직접 돌린다.**
 *
 * 라이브 실측으로 두 벤더 CLI 의 도구 권한 플래그로는 델리게이트의 셸을 제한할 수
 * 없다는 것이 확인됐다(설계 §12.-1). 그래서 워커에게 Bash 를 주지 않고 테스트는 우리가
 * 돌린다. 델리게이트의 자기 보고 대신 우리가 읽은 종료 코드가 학습 계층(§7)의 보상
 * 신호가 된다.
 *
 * ## ★★ 명령을 고정(pin)하고, 어긋나면 **실행하지 않는다**
 *
 * `deriveTestCommand` 는 **사용자 프로젝트**(델리게이트가 손대기 전)에서 명령을 유도해
 * 그 정의 문자열을 함께 낸다. `runTests` 는 스폰하기 **전에** 워크트리의 같은 정의를 다시
 * 읽어 고정값과 대조하고, 다르거나 읽지 못하면 **자식을 띄우지 않고** blocked 봉투를 낸다.
 *
 * 고정하는 것은 정의 파일 **하나가 아니다.** 그 도구가 워크트리에서 함께 읽는 입력들과,
 * 프로젝트에 그 파일이 **없었다는 사실**까지 고정한다 — 자세한 목록과 남는 틈은 아래
 * §고정 대상 문단에 있다. 하나만 고정했을 때 델리게이트가 `pretest` 한 줄, `.npmrc` 한 줄,
 * `Directory.Build.props` 하나, `pytest.py` 하나로 붉은 스위트를 초록으로 뒤집는 것을
 * 실측으로 재현했고, 그때 봉투는 전부 `match`/`verified` 였다.
 *
 * 왜 탐지가 아니라 거부인가: `node --run test` 는 실행 시점에 워크트리의 `package.json` 을
 * 다시 읽는다(`make test`·`dotnet test`·`pytest` 도 각자의 정의를 읽는다). 돌린 뒤에
 * 탐지해 봐야 델리게이트가 고른 명령이 **우리 프로세스의 권한과 환경으로 이미 돈** 뒤다 —
 * §12.-1 이 워커에게서 Bash 를 뺀 이유를 우리가 대신 되돌려주는 셈이 된다.
 *
 * 델리게이트가 테스트 스크립트를 고치는 것이 정당한 작업이었더라도 거부한다. 우리는
 * 델리게이트가 쓴 테스트 명령을 신뢰할 수 없고, 그 판단은 사용자·검증자의 몫이다.
 * 봉투가 무엇이 어떻게 달라졌는지(양쪽 값) 말해 준다.
 *
 * ⚠ 남는 틈: 검사와 스폰 사이, 그리고 스폰과 셸이 정의 파일을 읽는 시점 사이에 파일을
 *   바꾸면 우리는 못 본다. 설계상 델리게이트는 이 시점에 이미 끝나 있지만, 델리게이트가
 *   남긴 백그라운드 프로세스는 그 창에 쓸 수 있다. 닫으려면 워크트리를 잠가야 하고 그건
 *   이 모듈의 범위 밖이다 — 고치지 않고 사실만 적는다.
 *
 * ## ★ 의존성은 설치하지도 링크하지도 않는다
 *
 * 커밋된 무시 규칙에 걸린 것은 워크트리로 이식되지 않으므로(계획 2 Task 2), Node 프로젝트
 * 워크트리에는 `node_modules` 가 없다. 두 가지 해법을 다 버렸다:
 *
 *   - 사용자의 `node_modules` 를 링크하면 이 제품이 제공하는 유일한 격리(파일시스템 범위)를
 *     그 자리에서 뚫는다. 델리게이트는 링크를 타고 사용자의 진짜 트리를 수정할 수 있다.
 *   - `npm install` 을 우리가 돌리면 **워크트리의** `package.json` 이 지시하는
 *     `postinstall` 이 실행된다. 그 파일은 델리게이트가 쓴다.
 *
 * 그래서 의존성이 없어 명령이 실패하면 정직하게 그렇게 보고하고 `confidence` 를 내린다.
 * **그만큼 §7 의 보상 신호가 약해진다** — 의존성 없이 도는 스위트에서만 실행 기반 보상이
 * 온전하다. 의존성 제공 전략은 별도 결정 사항이고 여기서 몰래 정하지 않는다.
 *
 * ## 이 모듈이 격리를 늘리지는 않는다
 *
 * 테스트를 돌린다는 것은 델리게이트가 쓴 코드를 실행한다는 뜻이다. 실행되는 코드가 무엇을
 * 하는지는 이 모듈의 통제 밖이고, 성립하는 경계는 여전히 "워크트리 안에서 돈다" 하나뿐이다
 * (`src/worktree.mjs` 의 같은 문단). 이 모듈이 더하는 것은 **결과의 출처**뿐이다.
 */

/**
 * 자식 출력의 상한(문자). 상한이 걸리는 자리는 둘이다: 여기서 100,000자로 자르고, MCP
 * 결과로 나갈 때 봉투가 `src/envelope.mjs` 의 `MAX_CONTENT_CHARS`(10,000자)로 한 번 더
 * 자른다.
 *
 * 두 값을 다르게 두는 이유: 러너의 소비자는 MCP 클라이언트만이 아니다. 검증·학습 단계가
 * 실패 로그를 읽어야 하고, 그 용도에는 10,000자가 너무 짧다. 대신 **MCP 로 내보내는
 * 호출부는 이 값을 그대로 실으면 안 된다** — 봉투가 꼬리부터 잘라내므로, 필요한 구간을
 * 호출부가 직접 골라야 한다.
 */
export const MAX_OUTPUT_CHARS = 100_000;

/**
 * pytest 를 **cwd 를 임포트 경로 맨 뒤에 두고** 띄우는 부트스트랩.
 *
 * ## 왜 `-m pytest` 가 아닌가 (실측, 진짜 pytest 9.1.1 / CPython 3.14.6)
 *
 * `python -m pytest` 는 cwd 를 `sys.path[0]` 에 넣는다. 그러면 워크트리 루트의 임포트
 * 이름 공간 **전체**가 도구 해석 경로가 된다 — `pytest/` 디렉터리 · `_pytest/` ·
 * `pluggy.py` · `iniconfig.py` · `py.py` 중 아무거나 하나만 놓으면 실패하는 스위트가
 * `exit 0` 이 됐고, 스위트는 수집조차 되지 않았다. 이름을 열거해서 막는 길은 늘 뒤처진다.
 *
 * ## 왜 `PYTHONSAFEPATH=1` 단독이 아닌가 (실측)
 *
 * 그것만 쓰면 cwd 가 `sys.path` 에서 **빠져** 평범한 flat-layout 프로젝트가 깨진다:
 * 루트 `mypkg.py` + `tests/test_a.py` 의 `from mypkg import add` 가 `1 passed` 에서
 * `exit 2 / collection error` 가 된다(루트 `conftest.py` 가 있으면 pytest 가 그 basedir 를
 * 넣어 주어 우연히 살아난다 — 없는 배치가 깨진다).
 *
 * ## 이 처방
 *
 * `PYTHONSAFEPATH=1` 로 cwd 를 앞에서 빼고, 부트스트랩이 **맨 뒤에** 다시 붙인다.
 * site-packages 가 앞서므로 설치된 진짜 pytest/pluggy 가 이기고, cwd 는 여전히
 * `sys.path` 에 있어 flat-layout 의 `import mypkg` 가 산다. 실측:
 *
 *     하이재킹 6종(pytest/ · _pytest/ · pluggy.py · iniconfig.py · py.py · pytest.py)
 *       -> 전부 `1 failed` exit 1 — 진짜 스위트가 돈다
 *     정상 4종(flat 모듈 · flat 패키지 · src-layout · conftest 픽스처)
 *       -> 전부 `1 passed` exit 0
 *     종료 코드 보존: 0 / 1 / 4(잘못된 인자) / 5(테스트 0개) 그대로
 *
 * 한 줄이고 argv 원소 하나로 넘어간다 — `shell:false` 계약과 무관하다.
 *
 * ⚠ 남는 틈: cwd 가 뒤에라도 남으므로 site-packages 에 **없는** 이름은 여전히 워크트리에서
 *   임포트될 수 있다. pytest 자신은 그런 이름을 임포트하지 않지만 서드파티 플러그인이
 *   그럴 수 있다.
 */
export const PYTEST_BOOTSTRAP =
  'import sys,os; sys.path.append(os.getcwd()); import pytest; raise SystemExit(pytest.main(sys.argv[1:]))';

/** 위 부트스트랩의 나머지 절반. allowlist 밖의 계산값이라 `extra` 로 넘긴다. */
const PYTEST_ENV = Object.freeze({ PYTHONSAFEPATH: '1' });

/**
 * 이 csproj 이 **테스트 프로젝트**라는 양성 증거.
 *
 * 실측: 테스트 프로젝트가 아닌 루트 csproj 에 `dotnet test` 를 돌리면 컴파일이 깨져
 * 있어도 아무것도 하지 않고 `exit 0` 이다 — 적대자 없이 `passed:true / verified` 가
 * 나간다. 루트에 앱/라이브러리, 테스트는 `tests/*.Tests.csproj` 가 .NET 저장소의 표준
 * 배치라 드문 일이 아니고, 그 부류 전체에서 §7 의 실행 기반 보상이 상수 "통과"가 된다.
 *
 * 증거가 없으면 이 후보를 건너뛴다 — "추측해서 엉뚱한 프로젝트를 돌리느니 null 이 낫다"는
 * `deriveTestCommand` 의 기존 방침 그대로다.
 */
const CSPROJ_TEST_EVIDENCE =
  /<IsTestProject>\s*true|Microsoft\.NET\.Test\.Sdk|Microsoft\.Testing\.Platform|Include\s*=\s*"(?:xunit|nunit|mstest)/i;

/** 기본 시간 상한. 테스트 스위트는 길다 — `runGit` 의 30초 기준으로는 못 잰다. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * kill 뒤 `close` 를 기다리는 유예. 이 시간을 넘기면 자식의 생사와 무관하게 결과를 낸다.
 *
 * `kill()` 은 부탁이지 보장이 아니고, 특히 `node --run` 은 스크립트의 명령을 손자로
 * 띄운다 — 자식만 죽고 손자가 우리 파이프의 쓰기 끝을 쥐고 있으면 `close` 가 영영 오지
 * 않는다.
 *
 * ⚠ **남는 위험**: 직접 자식은 `onSpawn` 훅으로 배선 계층에 넘어가 리퍼 원장에 오르고
 *   (`src/engine.mjs`), 그쪽이 데드라인에 트리 킬을 건다. 그래도 **reparent 된 손자**는
 *   남는다 — `taskkill /T` 도 POSIX 그룹 신호도 살아 있는 트리만 훑기 때문이다
 *   (`src/reaper.mjs` 의 같은 문단). 즉 하드 데드라인이 발동하면 델리게이트가 쓴 코드를
 *   돌리던 손자가 우리 권한으로 워크트리 안에 남을 수 있고(실측: 봉투가 나간 뒤 +8초에도
 *   살아 있었다), 워크트리 제거도 그 프로세스가 파일을 쥐고 있으면 걸린다. 봉투는 최소한
 *   그 사실을 `notes` 로 알린다.
 */
const KILL_GRACE_MS = 3_000;

/**
 * `exit` 은 왔는데 `close` 가 안 올 때 파이프를 더 기다리는 유예.
 *
 * 자식이 스스로 끝났다면 종료 코드는 이미 우리 손에 있다. 그때까지 도착하지 않은 출력만
 * 기다리면 되고, 만료되면 **그 종료 코드로** 결과를 낸다. 이것이 없으면 배경 프로세스를
 * 남긴 스위트(watcher·dev 서버)에서 `close` 가 영영 오지 않아, 통과한 스위트가 기본
 * 설정으로 603초 뒤에 `passed:false / timedOut:true` 로 보고됐다(실측).
 *
 * 출력이 계속 도착하는 동안에는 다시 센다 — 큰 출력을 드레인하는 중에 끊으면 안 된다.
 */
const DRAIN_GRACE_MS = 3_000;

/**
 * `exit` 뒤 드레인에 쓸 수 있는 **절대 상한**. 갱신되지 않는다.
 *
 * 갱신만 있으면 계속 찍는 배경 프로세스에서 유예가 영영 늘어나 데드라인 전체를 쓴다
 * (실측: 200ms 마다 찍는 손자에서 timeoutMs 8000 + KILL_GRACE 3000 = 11,020ms, 기본
 * 설정이면 603초). 그리고 그 경로는 `hung` 으로 나가 **통과한 스위트가 unverified** 가
 * 된다. 종료 코드는 이미 확정이므로 여기서 끊어 잃는 것은 꼬리 출력뿐이다.
 */
const DRAIN_MAX_MS = 10_000;

/** `--run` 프로브의 시간 상한. 실측으로 즉시 끝나지만 매달리게 둘 수는 없다. */
const PROBE_TIMEOUT_MS = 10_000;

const WINDOWS = process.platform === 'win32';

const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';

/** `src/git.mjs`·`src/worktree.mjs` 의 내부 실패 봉투와 같은 모양. */
function blocked(error, recovery) {
  return { blocked: true, error, recovery: recovery && recovery !== '' ? recovery : GENERIC_RECOVERY };
}

// ── 정의 추출 (유도와 대조가 같은 함수를 쓴다) ────────────────────────────

/**
 * `Makefile` 에서 한 타깃의 블록(타깃 줄 + 레시피 줄)을 뽑는다. 없으면 null.
 *
 * 블록만 뽑는 이유: 파일 전체를 고정하면 무관한 타깃 편집이 위조로 잡힌다.
 */
function extractMakeTarget(text, target) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // `.PHONY: test` 는 선언이지 타깃이 아니다.
    if (line.startsWith('.')) continue;
    // `CFLAGS := -O2` 같은 대입은 타깃이 아니다 — `:=` 를 부정 전방탐색으로 뺀다.
    const match = /^([^\s:=][^:=]*)\s*:(?!=)/.exec(line);
    if (!match) continue;
    if (!match[1].trim().split(/\s+/).includes(target)) continue;

    const block = [line.trimEnd()];
    const pending = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.startsWith('\t')) {
        block.push(...pending, next.trimEnd());
        pending.length = 0;
        continue;
      }
      // 레시피 중간의 빈 줄은 타깃을 끝내지 않는다. 뒤에 레시피가 더 오면 살린다.
      if (next.trim() === '') {
        pending.push('');
        continue;
      }
      break;
    }
    return block.join('\n');
  }
  return null;
}

/** ini/toml 파일에서 한 구획을 뽑는다(머리글 줄 포함). 없으면 null. */
function extractIniSection(text, header) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;

  const out = [lines[start].trim()];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) break;
    out.push(lines[i].trimEnd());
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

const PYTEST_SECTION = '[tool.pytest.ini_options]';
const NPM_TEST_SCRIPT = 'test';

/**
 * 줄끝을 LF 로 맞춘다.
 *
 * 고정은 프로젝트의 **작업 사본**을 읽고 대조는 워크트리의 **새 체크아웃**을 읽는다.
 * `.editorconfig` 가 LF 인 저장소를 Git for Windows 기본(`core.autocrlf=true`)으로 쓰면
 * 두 쪽 바이트가 다르다 — 정규화하지 않으면 정상 프로젝트가 영구 거부되고 봉투가 눈으로
 * 똑같은 두 값을 놓고 "델리게이트가 바꿨습니다"라고 말한다(실측). `extractMakeTarget` ·
 * `extractIniSection` 은 이미 줄 단위로 잘라 붙이므로 같은 처리를 해 왔다.
 */
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

async function readTextFile(root, name) {
  try {
    return normalizeEol(await readFile(join(root, name), 'utf8'));
  } catch {
    return null;
  }
}

/** `package.json` 의 한 스크립트. 없거나 공백뿐이거나 JSON 이 깨졌으면 null. */
async function readNpmScript(root, name) {
  const text = await readTextFile(root, 'package.json');
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const script = parsed?.scripts?.[name];
  if (typeof script !== 'string' || script.trim() === '') return null;
  return script;
}

const readNpmTestScript = (root) => readNpmScript(root, NPM_TEST_SCRIPT);

/** 루트에서 이 확장자로 끝나는 파일 이름들(정렬). 디렉터리는 세지 않는다. */
async function rootFilesBySuffix(root, suffix) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix)).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * 고정해 둔 **주 정의**를 워크트리에서 다시 읽는다. 유도할 때와 같은 추출 함수를 쓴다 —
 * 두 곳이 갈리면 정상 워크트리가 위조로 잡히거나 그 반대가 된다.
 *
 * @returns 문자열(읽었다) 또는 null(읽지 못했다 — 파일이 없거나 정의가 사라졌다)
 */
async function readDefinitionValue(root, definition) {
  const { file, kind } = definition;
  if (kind === 'npm-script') return readNpmScript(root, definition.script ?? NPM_TEST_SCRIPT);

  const text = await readTextFile(root, file);
  if (text === null) return null;
  if (kind === 'file-text') return text;
  if (kind === 'make-target') return extractMakeTarget(text, NPM_TEST_SCRIPT);
  if (kind === 'ini-section') return extractIniSection(text, PYTEST_SECTION);
  return null;
}

// ── ★★ 고정 대상: 열거가 아니라 **관계**를 고정한다 ────────────────────────
//
// 규칙은 하나다: **워크트리의 고정 항목은 프로젝트의 것과 내용이 같거나 아예 없어야 한다.**
//
// 앞선 라운드는 "그 도구가 읽는 입력 전체"라는 축을 잡고 **이름 열거**로 좁혔고, 세 갈래
// 전부에서 열거가 뒤처졌다(전부 실측 재현, 전부 `match`/`verified`/`passed:true`):
//
//   · `node_modules/.bin` 은 **이름만** 봤다. 델리게이트는 추측할 필요가 없다 —
//     `scripts.test` 가 부를 이름을 그대로 알려 주고(`"test":"jest"` → `jest.cmd`),
//     그 이름은 의존성이 설치된 프로젝트라면 반드시 고정 집합 안에 있다.
//   · 파이썬은 `pytest.py` 하나만 막았다. cwd 가 `sys.path[0]` 이라는 사실이 여는 것은
//     이름 하나가 아니라 루트의 임포트 이름 공간 전체다(`pytest/` · `_pytest/` ·
//     `pluggy.py` · `iniconfig.py` · `py.py` 가 전부 뚫렸다). 그 축은 열거가 아니라
//     **임포트 순서**로 닫았다(PYTEST_BOOTSTRAP 주석 참조).
//   · MSBuild 는 `Directory.Build.rsp`(명령줄 자체를 바꾼다)와 `*.slnx`(dotnet 이 아예
//     다른 프로젝트를 돌린다)가 빠져 있었다. rsp 축은 `-noAutoResponse` 로 채널을 닫았다.
//
// **값이 `null` 일 수 있다는 것이 두 번째 요점이다** — "프로젝트에는 없었다"도 고정값이라
// 워크트리에 새로 생기면 거부된다.
//
// ## 무엇을 비교하는가
//
//   package.json : scripts.test(주) · scripts.pretest · scripts.posttest · .npmrc ·
//                  node_modules/.bin 의 **각 항목 내용**
//   csproj       : 그 csproj 전체 텍스트(주) · Directory.Build.props/.targets ·
//                  Directory.Packages.props · nuget.config · NuGet.config ·
//                  Directory.Build.rsp · MSBuild.rsp · dotnet.config · global.json ·
//                  루트의 *.sln / *.slnx / *.slnf / *.csproj **각각의 내용**
//   Makefile     : test 타깃 블록(주) · GNUmakefile/Makefile/makefile 전체 텍스트
//   pytest       : pytest.ini 또는 [tool.pytest.ini_options](주) · 나머지 설정 파일
//                  (pytest.ini · pyproject.toml · tox.ini · setup.cfg) · conftest.py
//
// ## 이 목록 밖에 남는 것 (닫지 않았다)
//
//   · **조상 디렉터리의 `node_modules/.bin`.** 실측 정정: `node --run` 은 cwd 것 하나가
//     아니라 조상들의 `.bin` 을 전부 순서대로 PATH 앞에 붙인다. 워크트리 밖이라 델리게이트가
//     쓸 수 없지만 우리 고정 대상도 아니다.
//   · 하위 디렉터리의 `conftest.py` · `Directory.Build.props` · csproj — 루트만 본다.
//     하위까지 훑으면 델리게이트가 쓰는 것이 정상인 파일들과 뒤섞인다. `*.slnx` 가 하위
//     프로젝트를 가리키면 그 조합이 실행 경로를 바꾸지만, slnx 자체는 고정된다.
//   · `include` 지시자가 끌어오는 파일, MSBuild 의 `<Import>` 대상, npm 의 사용자·전역
//     설정 — 이름을 미리 알 수 없다.
//   · **줄끝 차이는 무시한다**(아래 `contentDigest`). 그래서 줄끝만 바꾸는 변경은 못 잡는다.
//     설정 파일의 의미가 줄끝으로 바뀌지는 않는다.
//   · **추적되지 않는 파일의 삭제.** 아래 `tracked` 참조 — git 이 답을 주지 못하면
//     "이식되지 않았다"로 본다.
//   · 스위트 자신이 임포트하는 코드. 그건 델리게이트가 쓰는 것이 정상이고, 이 모듈이
//     맨 위에서 범위 밖이라고 적은 축이다.

/**
 * 내용 지문. 줄끝을 LF 로 맞춘 뒤 sha256 한다.
 *
 * 왜 줄끝을 맞추는가(실측): 고정은 프로젝트의 **작업 사본**을 읽고 대조는 워크트리의
 * **새 체크아웃**을 읽는다. `.editorconfig` 가 LF 인 저장소를 Git for Windows 기본
 * (`core.autocrlf=true`)으로 쓰면 두 쪽 바이트가 다르다. 그대로 비교했더니 지원 대상
 * 픽스처 다섯 중 넷이 막혔고, 봉투는 눈으로 완전히 같은 두 값을 나란히 놓고 "델리게이트가
 * 바꿨습니다"라고 말했다.
 *
 * 왜 내용 자체가 아니라 지문인가: 이 값은 봉투를 타고 MCP 결과로 나간다. `.npmrc` ·
 * `nuget.config` 에는 인증 토큰이 들어가고, 실제로 프로젝트의 토큰이 원문으로 실렸다.
 */
function contentDigest(buffer) {
  const normalized = Buffer.from(buffer.toString('binary').replace(/\r\n/g, '\n'), 'binary');
  return {
    digest: createHash('sha256').update(normalized).digest('hex'),
    bytes: buffer.length,
    lines: normalized.toString('binary').split('\n').length,
  };
}

/** 파일 하나의 지문. 없으면 null. 디렉터리·심링크는 읽지 않는다(아래 kindOf 참조). */
async function fileDigest(root, name) {
  try {
    return contentDigest(await readFile(join(root, name)));
  } catch {
    return null;
  }
}

/**
 * 한 디렉터리 안의 `{ 이름: 지문 }`. 디렉터리가 없으면 빈 객체.
 *
 * ★ 심링크·정션·디렉터리는 지문 대신 그 사실을 값으로 남긴다. `readFile` 은 링크를 따라
 *   가므로 내용만 비교하면 "같은 파일을 가리키는 링크"와 "그 내용을 가진 진짜 파일"을
 *   구분하지 못한다. 대상은 워크트리 밖일 수 있다.
 */
async function dirDigests(root, relative, suffix) {
  const out = {};
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // 확장자로 좁힌 고정은 그 확장자만 읽는다 — 루트 전체를 해시하면 델리게이트가 쓴
    // 큰 산출물까지 매 실행 두 번씩 읽게 된다.
    if (typeof suffix === 'string' && !entry.name.toLowerCase().endsWith(suffix)) continue;
    if (entry.isSymbolicLink()) out[entry.name] = { digest: 'symlink', bytes: 0, lines: 0 };
    else if (entry.isDirectory()) out[entry.name] = { digest: 'directory', bytes: 0, lines: 0 };
    else out[entry.name] = (await fileDigest(root, join(relative, entry.name))) ?? { digest: 'unreadable', bytes: 0, lines: 0 };
  }
  return out;
}

const npmScriptPin = (name) => ({ kind: 'npm-script', file: 'package.json', key: `scripts.${name}`, script: name });
const filePin = (name) => ({ kind: 'file-digest', file: name, key: name });
const suffixPin = (suffix) => ({ kind: 'dir-digests', file: '.', suffix, key: `루트의 *${suffix}` });

/** 고정 항목 하나를 한 트리에서 읽는다. `null` 은 "없다"이고, 그것도 고정값이다. */
async function readPinValue(root, entry) {
  if (entry.kind === 'npm-script') return readNpmScript(root, entry.script ?? NPM_TEST_SCRIPT);
  if (entry.kind === 'file-digest') return fileDigest(root, entry.file);
  if (entry.kind === 'dir-digests') return dirDigests(root, entry.file, entry.suffix);
  return null;
}

/**
 * 각 항목의 **프로젝트 쪽 값**을 읽어 `extras` 를 만든다.
 *
 * `tracked` 는 "이 파일이 워크트리에 반드시 이식되나"다. git 이 추적하는 파일은 워크트리에
 * 반드시 있으므로 없어졌다면 델리게이트가 지운 것이다. 추적되지 않는 파일(`.npmrc` 를
 * gitignore 하는 것은 npm 자신이 권하는 관행이다)은 **설계대로** 워크트리에 없다 —
 * 그것을 위조로 읽으면 그런 저장소는 델리게이트가 무엇을 하든 100% 거부된다.
 * git 이 답을 주지 못하면(저장소가 아니거나 git 이 없으면) `null` — 모르면 거부하지 않는다.
 */
async function pinExtras(projectPath, entries, deps = {}) {
  const pinned = await Promise.all(
    entries.map(async (entry) => ({ ...entry, value: await readPinValue(projectPath, entry) })),
  );
  const names = pinned.filter((e) => e.kind === 'file-digest' && e.value !== null).map((e) => e.file);
  const tracked = names.length === 0 ? new Set() : await (deps.trackedPaths ?? trackedPaths)(projectPath, names);
  return pinned.map((entry) =>
    entry.kind === 'file-digest' && entry.value !== null
      ? { ...entry, tracked: tracked === null ? null : tracked.has(entry.file) }
      : entry,
  );
}

/** 프로젝트에서 git 이 추적하는 경로들. 모르면 null. 절대 throw 하지 않는다. */
async function trackedPaths(projectPath, names) {
  const result = await runGit({ args: ['ls-files', '-z', '--', ...names], cwd: projectPath, timeoutMs: 15_000 });
  if (!result.ok) return null;
  return new Set(result.stdout.split('\0').filter((name) => name !== ''));
}

const NPM_EXTRAS = [
  npmScriptPin('pretest'),
  npmScriptPin('posttest'),
  filePin('.npmrc'),
  // ★ `node --run` 도 `npm run` 도 `node_modules/.bin` 을 PATH **앞**에 붙인다. 자식 env 의
  //   NoDefaultCurrentDirectoryInExePath 는 cwd 만 닫을 뿐 이쪽은 못 막는다(실측:
  //   `.bin\node.cmd` 를 심으니 그것이 이겼다). 이름이 아니라 **내용**을 본다 — 이름만 보면
  //   `scripts.test` 가 부르는 그 이름을 덮어쓰는 것이 구조적으로 통과한다.
  { kind: 'dir-digests', file: join('node_modules', '.bin'), key: 'node_modules/.bin' },
];

const CSPROJ_EXTRAS = [
  filePin('Directory.Build.props'),
  filePin('Directory.Build.targets'),
  filePin('Directory.Packages.props'),
  filePin('nuget.config'),
  filePin('NuGet.config'),
  filePin('global.json'),
  // MSBuild 는 작업 디렉터리의 자동 응답 파일을 **명령줄에 그대로 붙인다.** 실측: 한 줄
  // (`-p:IsTestProject=false`)이 실패하는 스위트를 exit 0 으로 뒤집었다. 아래 스폰 인자의
  // `-noAutoResponse` 가 이 채널을 닫지만, 워크트리에 새로 생긴 rsp 는 사용자에게 알린다.
  filePin('Directory.Build.rsp'),
  filePin('MSBuild.rsp'),
  // .NET 10 의 `dotnet test` 는 이 파일로 러너를 고른다.
  filePin('dotnet.config'),
  // `dotnet test` 는 cwd 에서 프로젝트/솔루션을 찾는다. 실측 우선순위는 slnx > sln > csproj —
  // 워크트리에 slnx 하나를 두면 고정한 csproj 은 복원조차 되지 않고 다른 프로젝트가 돈다.
  ...['.sln', '.slnx', '.slnf', '.csproj'].map(suffixPin),
];

// GNU make 는 GNUmakefile -> makefile -> Makefile 순으로 **먼저 찾은 것 하나**를 읽는다.
const MAKE_EXTRAS = ['GNUmakefile', 'makefile', 'Makefile'].map(filePin);

// pytest 는 이 넷 중 처음 발견한 것을 inifile 로 쓰고, conftest.py 를 **경로로 직접**
// 임포트한다(그래서 임포트 순서로는 못 막고 내용을 고정해야 한다).
const PYTEST_EXTRAS = ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'conftest.py'].map(filePin);

// ── 명령 유도 ─────────────────────────────────────────────────────────────

/** PATH 에서 실행 파일의 절대 경로를 찾는다. 못 찾으면 null(던지지 않는다). */
function defaultResolveTool(basename) {
  try {
    return resolveBinary({ basename });
  } catch {
    return null;
  }
}

/**
 * 이 노드가 `--run` 을 지원하는지 **실제로 띄워서** 본다.
 *
 * 실측: 지원하면 `--run requires an argument`(종료 9), 지원하지 않으면
 * `bad option: --run`(종료 9)이다. 버전 문자열 대신 이 동작을 본다.
 *
 * ⚠ `process.allowedNodeEnvironmentFlags.has('--run')` 은 지원하는 v24.18.0 에서도
 *   false 다(실측). 그 집합은 NODE_OPTIONS 에 쓸 수 있는 플래그만 담는다.
 *
 * @returns `{ supported, decisive }`. `decisive` 는 "자식이 끝까지 돌아 답을 봤나"다 —
 *   스폰 실패·타임아웃은 `supported:false` 지만 확정이 아니다. 둘을 뭉개면 한 번의
 *   프로브 사고가 이 프로세스 수명 내내 런처를 바꾼다(아래 캐시).
 */
function probeNodeRun(execPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(execPath, ['--run'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      resolve({ supported: false, decisive: false });
      return;
    }

    let stderr = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 이미 죽었으면 할 일이 없다.
      }
      settle({ supported: false, decisive: false });
    }, PROBE_TIMEOUT_MS);

    try {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', () => settle({ supported: false, decisive: false }));
      child.on('close', () => settle({ supported: !/bad option/i.test(stderr), decisive: true }));
    } catch {
      try {
        child.kill();
      } catch {
        // 이미 죽었으면 할 일이 없다.
      }
      settle({ supported: false, decisive: false });
    }
  });
}

/**
 * 프로브 결과는 실행 파일마다 한 번만 잰다. 서버가 도는 동안 execPath 는 바뀌지 않는다.
 *
 * ★ **확정 판정만 캐시한다.** 폴백 런처(`npm-cli.js`)는 npm 을 거치므로 `node --run` 이
 *   아예 읽지 않는 것들(`pretest`/`posttest`, `.npmrc`)을 읽는다 — 고정 대조가 그것들을
 *   함께 보긴 하지만, 프로브가 한 번 삐끗했다고 런처를 프로세스 수명 내내 바꾸는 것은
 *   조용하고 되돌릴 수 없는 기본값이다.
 */
const runSupportCache = new Map();

async function supportsNodeRun(execPath, deps = {}) {
  if (runSupportCache.has(execPath)) return runSupportCache.get(execPath);
  const { supported, decisive } = await (deps.probeNodeRun ?? probeNodeRun)(execPath);
  if (decisive) runSupportCache.set(execPath, supported);
  return supported;
}

/**
 * npm 셈이 감싸고 있는 `npm-cli.js`. 없으면 null.
 *
 * 실측: `spawn('npm', ['--version'], { shell:false })` 는 ENOENT 이고
 * `resolveLaunch({ basename: 'npm' })` 는 cli_shim_only 를 던진다 — npm 셈은 벤더 CLI 셈과
 * 형태가 달라 `resolveThroughShim` 도 풀지 못한다. 대신 노드 옆에 함께 깔리는 스크립트를
 * 직접 가리킨다: `<node 디렉터리>/node_modules/npm/bin/npm-cli.js`(실측으로 존재하고
 * `node <그 경로> --version` -> 11.16.0).
 */
async function findNpmCli(execPath) {
  const candidate = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    return (await stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * npm 스크립트를 **셸 없이** 띄우는 방법을 고른다.
 *
 * ① `node --run <script>` — npm 을 아예 거치지 않는다(Node 22+).
 * ② `node <npm-cli.js> run <script>` — ①을 못 쓸 때.
 *
 * 둘 다 `process.execPath` 를 스폰하므로 절대 경로다. 이름으로 스폰하면 Windows 의 libuv 가
 * 자식의 cwd(= 대상 저장소)를 PATH 보다 먼저 뒤진다(계획 2 Task 1).
 *
 * ⚠ ①은 종료 코드를 잃는다. 실측: 스크립트가 3 으로 끝나도 `node --run` 은 **1** 을 낸다
 *   (`node ran.mjs` 직접은 3, `npm run test` 도 3). 0 인지 아닌지는 그대로라 `passed` 는
 *   멀쩡하지만, `exitCode` 를 스위트의 정확한 종료 코드로 읽으면 안 된다.
 */
async function npmScriptLaunch(execPath, deps) {
  const supports = deps.supportsNodeRun ?? supportsNodeRun;
  if (await supports(execPath, deps)) {
    return { command: execPath, args: ['--run', NPM_TEST_SCRIPT], launcher: 'node --run', exitCodeExact: false };
  }

  const npmCli = await (deps.npmCliPath ?? findNpmCli)(execPath);
  if (npmCli !== null && npmCli !== undefined) {
    return { command: execPath, args: [npmCli, 'run', NPM_TEST_SCRIPT], launcher: 'npm-cli.js', exitCodeExact: true };
  }
  return {
    command: null,
    args: [],
    launcher: null,
    exitCodeExact: false,
    resolveError:
      '이 노드는 --run 을 지원하지 않고 npm-cli.js 도 찾지 못했습니다 — package.json 의 test 스크립트를 셸 없이 띄울 방법이 없습니다.',
  };
}

function toolEntry({ source, definition, tool, label = tool, args, resolveTool, childEnvExtra }) {
  const command = resolveTool(tool);
  return {
    source,
    command: command ?? null,
    args,
    // 이 도구에만 필요한 계산된 자식 환경 변수. allowlist 를 우회하므로 여기서만 정한다.
    ...(childEnvExtra ? { childEnvExtra } : {}),
    // 실행 파일을 우리가 직접 스폰하므로 종료 코드가 그대로 온다.
    launcher: command ? 'direct' : null,
    exitCodeExact: Boolean(command),
    resolveError: command ? null : `${label} 을(를) PATH 에서 찾지 못했습니다.`,
    definition,
  };
}

/**
 * 테스트 명령을 유도한다. **사용자 프로젝트에서만** 유도한다 — 워크트리에서 다시 유도하면
 * 이 모듈의 존재 이유가 사라진다(맨 위 주석).
 *
 * 순서: `package.json` 의 `scripts.test` -> 루트의 `*.csproj` -> `Makefile` 의 `test`
 * 타깃 -> `pytest.ini`/`pyproject.toml`. 못 찾으면 **null** — 추측하지 않는다.
 *
 * ⚠ `*.csproj` 는 **루트만** 본다. 솔루션 파일이나 하위 디렉터리의 프로젝트는 다루지 않고,
 *   루트에 둘 이상 있으면 어느 것인지 모르므로 고르지 않는다. 추측해서 엉뚱한 프로젝트를
 *   돌리느니 다음 후보로 넘어가거나 null 을 내는 편이 낫다.
 *
 * @returns `{ source, command, args, launcher, exitCodeExact, resolveError, definition }`
 *   또는 null. 결과를 그대로 `runTests` 에 펼쳐 넘기면 된다.
 *   `command` 가 null 이면 정의는 찾았지만 띄울 방법이 없다는 뜻이고 `resolveError` 에
 *   사유가 있다. `definition` 은 `runTests` 가 워크트리와 대조할 고정값이고, 그 안의
 *   `extras` 가 같은 도구가 함께 읽는 입력들이다(위 §고정 대상 참조).
 *   `exitCodeExact` 는 "종료 코드를 스위트의 값으로 읽어도 되나"다 — `node --run` 경로만
 *   false 다(그 경로는 비0 종료 코드를 전부 1 로 접는다).
 */
export async function deriveTestCommand(projectPath, deps = {}) {
  try {
    if (typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath)) return null;
    const resolveTool = deps.resolveTool ?? defaultResolveTool;
    const execPath = deps.execPath ?? process.execPath;

    const script = await readNpmTestScript(projectPath);
    if (script !== null) {
      const launch = await npmScriptLaunch(execPath, deps);
      return {
        source: 'package.json',
        command: launch.command,
        args: launch.args,
        launcher: launch.launcher,
        exitCodeExact: launch.exitCodeExact,
        resolveError: launch.resolveError ?? null,
        definition: {
          file: 'package.json',
          kind: 'npm-script',
          key: 'scripts.test',
          script: NPM_TEST_SCRIPT,
          value: script,
          extras: await pinExtras(projectPath, NPM_EXTRAS),
        },
      };
    }

    const csproj = await rootFilesBySuffix(projectPath, '.csproj');
    if (csproj.length === 1) {
      const text = await readTextFile(projectPath, csproj[0]);
      if (text !== null && CSPROJ_TEST_EVIDENCE.test(text)) {
        return toolEntry({
          source: 'csproj',
          tool: 'dotnet',
          // `-noAutoResponse` 는 MSBuild 가 작업 디렉터리의 응답 파일을 명령줄에 붙이는
          // 채널을 닫는다(실측: 공격 픽스처가 exit 0 -> exit 1 로 되돌아오고 깨끗한
          // 프로젝트는 그대로 돈다).
          args: ['test', '-noAutoResponse'],
          resolveTool,
          definition: {
            file: csproj[0],
            kind: 'file-text',
            key: csproj[0],
            value: text,
            extras: await pinExtras(projectPath, CSPROJ_EXTRAS),
          },
        });
      }
    }

    for (const name of ['Makefile', 'makefile']) {
      const text = await readTextFile(projectPath, name);
      if (text === null) continue;
      const target = extractMakeTarget(text, NPM_TEST_SCRIPT);
      if (target === null) break;
      return toolEntry({
        source: 'Makefile',
        tool: 'make',
        args: [NPM_TEST_SCRIPT],
        resolveTool,
        definition: {
          file: name,
          kind: 'make-target',
          key: 'test 타깃',
          value: target,
          extras: await pinExtras(projectPath, MAKE_EXTRAS),
        },
      });
    }

    const pytestIni = await readTextFile(projectPath, 'pytest.ini');
    if (pytestIni !== null) {
      return toolEntry({
        source: 'pytest.ini',
        tool: 'python',
        label: 'python/python3',
        args: ['-c', PYTEST_BOOTSTRAP],
        childEnvExtra: PYTEST_ENV,
        resolveTool: (name) => resolveTool(name) ?? resolveTool('python3'),
        definition: {
          file: 'pytest.ini',
          kind: 'file-text',
          key: 'pytest.ini',
          value: pytestIni,
          extras: await pinExtras(projectPath, PYTEST_EXTRAS),
        },
      });
    }

    const pyproject = await readTextFile(projectPath, 'pyproject.toml');
    if (pyproject !== null) {
      const section = extractIniSection(pyproject, PYTEST_SECTION);
      if (section !== null) {
        return toolEntry({
          source: 'pyproject.toml',
          tool: 'python',
          label: 'python/python3',
          args: ['-c', PYTEST_BOOTSTRAP],
          childEnvExtra: PYTEST_ENV,
          resolveTool: (name) => resolveTool(name) ?? resolveTool('python3'),
          definition: {
            file: 'pyproject.toml',
            kind: 'ini-section',
            key: PYTEST_SECTION,
            value: section,
            extras: await pinExtras(projectPath, PYTEST_EXTRAS),
          },
        });
      }
    }

    return null;
  } catch {
    // 유도는 부가 정보 수집이다. 여기서 던지면 호출부가 봉투 대신 거부된 프로미스를 받는다.
    return null;
  }
}

// ── 워크트리 디렉터리 확인 ────────────────────────────────────────────────

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// ── 출력 상한 ─────────────────────────────────────────────────────────────

/**
 * 앞뒤를 남기고 가운데를 버리는 수집기. **메모리도 상한 안에 머문다** — 다 모은 뒤
 * 자르는 구현은 폭주하는 스위트의 출력을 그대로 힙에 쌓는다.
 *
 * 꼬리를 버리지 않는 이유: 테스트 요약과 실패 목록은 끝에 나온다. 머리를 남기는 이유:
 * 무엇이 돌았는지와 첫 실패가 거기 있다.
 *
 * 자르는 자리는 **코드 유닛이 아니라 문자 경계**다. 서로게이트 쌍 한가운데를 자르면 짝
 * 없는 서로게이트가 남고, JSON 으로는 살아남지만 UTF-8 바이트로 쓰는 소비자(로그 파일,
 * 비 JS 소비자)에서 U+FFFD 로 뭉개지거나 인코딩 오류가 된다(실측: 이모지 출력에서
 * `isWellFormed()` 가 false). `outputChars` 는 원래 코드 유닛 수 그대로 둔다.
 */
function endsWithHighSurrogate(text) {
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsWithLowSurrogate(text) {
  const code = text.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

function createOutputCap(limit) {
  const headLimit = Math.max(1, Math.floor(limit * 0.3));
  const tailLimit = Math.max(1, limit - headLimit);
  let head = '';
  let tail = '';
  let total = 0;

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (text === '') return;
      total += text.length;
      if (head.length < headLimit) head += text.slice(0, headLimit - head.length);
      tail += text;
      if (tail.length > tailLimit) tail = tail.slice(tail.length - tailLimit);
    },
    result() {
      if (total <= headLimit + tailLimit) {
        // 상한 아래에서는 head 와 tail 이 겹친다. 겹친 만큼만 떼면 원문이 그대로 돌아온다.
        const overlap = head.length + tail.length - total;
        return { text: head + tail.slice(overlap), chars: total, truncated: false };
      }
      // 끝이 high surrogate 면 짝을 잃은 것이고, 시작이 low surrogate 면 짝이 앞에 남았다.
      const safeHead = endsWithHighSurrogate(head) ? head.slice(0, -1) : head;
      const safeTail = startsWithLowSurrogate(tail) ? tail.slice(1) : tail;
      const dropped = total - safeHead.length - safeTail.length;
      return {
        text: `${safeHead}\n… [출력 ${total}자 중 가운데 ${dropped}자가 잘렸습니다] …\n${safeTail}`,
        chars: total,
        truncated: true,
      };
    },
  };
}

// ── 실행 ──────────────────────────────────────────────────────────────────

/**
 * 의존성이 없어 못 돌린 흔적. 로케일에 의존하지 않는 런타임 메시지 위주다.
 *
 * ⚠ 휴리스틱이다. 이 목록은 `confidence` 를 **내리기만** 하고 절대 올리지 않으므로,
 *   못 잡으면 거짓 초록은 만들지 않는다. 반대로 셸이 내는 "명령을 찾을 수 없음" 은
 *   로케일마다 달라서(이 기계는 한국어) 영어 표현만으로는 못 잡는다 — 사실만 적는다.
 *
 * ⚠ 남는 틈: **"도구가 부팅에 실패했다"와 "스위트가 진짜 실패했다"를 봉투가 구분하지
 *   못한다.** 이 목록에 없는 부팅 실패는 `passed:false / confidence:'verified'` 로 나가고,
 *   §7 의 보상 계층에는 거짓 붉음도 거짓 초록과 똑같이 오염이다(델리게이트가 무엇을 하든
 *   벌점이 고정되면 보상 신호가 상수가 된다). 러너별로 "한 개라도 수집·실행됐다"는 증거를
 *   찾는 방법이 있지만, 그건 러너마다 다른 새 휴리스틱이고 위조된 자식이 그럴듯한 요약을
 *   찍으면 그만이라 여기서 몰래 정하지 않는다.
 */
const MISSING_DEP_SIGNS = [
  'ERR_MODULE_NOT_FOUND',
  'Cannot find module',
  'Cannot find package',
  'ModuleNotFoundError',
  'No module named',
  'not recognized as an internal or external command',
  'command not found',
];

function spawnFailure(extra) {
  return {
    ran: false,
    exitCode: null,
    signalName: null,
    timedOut: false,
    aborted: false,
    hung: false,
    lingering: false,
    spawnError: null,
    output: '',
    outputChars: 0,
    truncated: false,
    ...extra,
  };
}

/**
 * 자식을 띄우고 stdout·stderr 를 **도착 순서대로** 한 버퍼에 모은다. 절대 throw 하지 않는다.
 *
 * 두 스트림을 합치는 이유: 사람이 터미널에서 보는 것이 그 순서이고, 테스트 러너는 진행과
 * 실패를 두 스트림에 나눠 쓴다. 둘 다 반드시 드레인한다 — 읽지 않으면 파이프 버퍼가 차서
 * 자식이 멈춘다.
 */
async function spawnAndCollect({ command, args, cwd, env, signal, timeoutMs, onSpawn }) {
  const cap = createOutputCap(MAX_OUTPUT_CHARS);

  // 이미 끊긴 신호로 프로세스를 띄우면 곧바로 죽일 자식을 굳이 만드는 셈이다.
  if (signal?.aborted) return spawnFailure({ aborted: true });

  // ★ 스폰 **앞**에서 만든다. 스폰과 보호 try 사이에 한 줄도 두지 않는 것이 "스폰 이후의
  //   셋업이 던져 자식이 고아로 남는다"를 닫는 유일한 방법이다(계획 1 에서 두 번, 여기서
  //   세 번째로 낸 부류 — 실측으로 재현했다: timeoutMs 5000/3 -> 봉투는 blocked 인데
  //   테스트 자식은 살아서 워크트리에 계속 썼다).
  const deadline = timeoutSignal(timeoutMs);

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env, // ★ 교체다. buildChildEnv 가 만든 것이 자식 환경의 전부다.
      shell: false,
      windowsHide: true,
      // stdin 은 열지 않는다. 입력을 기다리는 스위트가 영영 멈추는 대신 즉시 EOF 를 본다.
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 에서만: 자식이 자기 프로세스 그룹을 이끌어야 리퍼가 손자까지 끊을 수 있다.
      ...(WINDOWS ? {} : { detached: true }),
    });
  } catch (error) {
    return spawnFailure({ spawnError: error });
  }

  // ★ 'error' 리스너를 **던질 수 있는 어떤 코드보다 먼저** 붙인다. 셋업이 던져 아래
  //   보호 catch 로 빠지면 그 뒤에 자식의 'error'(ENOENT 등)가 리스너 없이 터지고,
  //   봉투가 정상 반환된 **다음에** 프로세스가 uncaught 로 죽는다 — stdio 로 물린 MCP
  //   서버에서는 세션이 통째로 끊긴다(실측: 봉투는 blocked:false 로 나오고 shell exit=1).
  //   `settle` 은 아직 없으므로 사유를 담아 두었다가 준비되면 넘긴다.
  let earlyError = null;
  let settleOutcome = null;
  child.on('error', (error) => {
    if (settleOutcome !== null) settleOutcome({ spawnError: error });
    else earlyError = error;
  });

  let stopReason = null;
  let finished = false;
  let hardTimer = null;
  let hardSettle = null;
  let drainTimer = null;
  let drainSettle = null;
  let drainDeadline = null;

  const stop = (reason) => {
    if (finished) return;
    if (stopReason === null) stopReason = reason;
    try {
      child.kill();
    } catch {
      // 이미 죽었으면 할 일이 없다.
    }
    // ★ kill 뒤에도 `close` 가 안 오면 결과를 못 낸다. 반드시 나가게 못을 박는다.
    if (hardTimer === null) hardTimer = setTimeout(() => hardSettle?.(), KILL_GRACE_MS);
  };

  // 자식이 스스로 끝났는데 파이프가 안 닫혔다. 도착 중인 출력만 기다렸다가 나간다.
  //
  // ★ 유예에 **절대 상한**이 있다. 갱신만 하면 계속 찍는 배경 프로세스에서 유예가 영영
  //   갱신돼 데드라인 전체를 쓴다(실측: 조용한 손자는 3.1초, 200ms 마다 찍는 손자는
  //   timeoutMs 8000 + KILL_GRACE 3000 = 11,020ms, 기본 설정이면 603초 — 그리고 `hung`
  //   으로 나가 통과한 스위트가 unverified 가 된다). 종료 코드는 이미 확정이므로 상한을
  //   넘겨서 잃는 것은 꼬리 출력뿐이다.
  const bumpDrain = () => {
    if (finished || drainSettle === null) return;
    clearTimeout(drainTimer);
    const remaining = drainDeadline - Date.now();
    if (remaining <= 0) {
      drainSettle();
      return;
    }
    drainTimer = setTimeout(() => drainSettle?.(), Math.min(DRAIN_GRACE_MS, remaining));
  };

  const onData = (chunk) => {
    cap.push(chunk);
    if (drainTimer !== null) bumpDrain();
  };

  const onAbort = () => stop('aborted');
  const onDeadline = () => stop('timedOut');

  // ★ 스폰 **이후**의 셋업이 던지면 자식이 아무에게도 안 잡힌 채 남는다(계획 1 에서 두 번
  //   낸 버그). 여기부터 통째로 감싸고, 실패하면 자식을 먼저 끊는다.
  try {
    // ★ 자식을 배선 계층에 넘긴다(리퍼 원장 등록·트리 킬 대상 등록). 스폰 **이후**라
    //   여기서 던지면 자식이 아무에게도 안 잡힌 채 남는다 — 그래서 이 try 안이고,
    //   아래 catch 가 자식을 먼저 끊는다.
    //
    //   결과를 기다리지 않는다: 원장 쓰기는 프로세스 시작 시각 프로브(powershell/ps)를
    //   태우므로 수백 ms 가 걸리는데, 그동안 stdout 리스너를 안 붙이면 자식이 파이프
    //   버퍼에서 멈춘다. 거부는 삼킨다 — 원장은 최선의 노력이고, 실패했다고 이미 도는
    //   스위트를 죽이면 안 된다.
    if (typeof onSpawn === 'function') {
      const tracked = onSpawn(child);
      if (tracked && typeof tracked.catch === 'function') tracked.catch(() => {});
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    deadline?.addEventListener('abort', onDeadline, { once: true });
  } catch (error) {
    stop('setupFailed');
    try {
      signal?.removeEventListener?.('abort', onAbort);
      deadline?.removeEventListener?.('abort', onDeadline);
    } catch {
      // 뗄 수 없으면 그냥 둔다.
    }
    clearTimeout(hardTimer);
    return spawnFailure({ spawnError: error });
  }

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(drainTimer);
      resolve(value);
    };
    hardSettle = () => settle({ hung: true });
    drainSettle = () => settle({ lingering: true });
    settleOutcome = settle;
    if (earlyError !== null) settle({ spawnError: earlyError });
    // ★ 'exit' 과 'close' 를 **둘 다** 듣는다. 'close' 는 파이프가 다 비워진 뒤라 출력을
    //   잃지 않지만, 손자가 쓰기 끝을 쥐고 있으면 영영 오지 않는다. 그때 'exit' 이 이미
    //   준 종료 코드를 버리면 통과한 스위트가 실패로 나간다.
    child.on('exit', () => {
      drainDeadline = Date.now() + DRAIN_MAX_MS;
      drainTimer = setTimeout(() => drainSettle?.(), Math.min(DRAIN_GRACE_MS, DRAIN_MAX_MS));
    });
    child.on('close', () => settle({}));
  });

  try {
    signal?.removeEventListener?.('abort', onAbort);
    deadline?.removeEventListener?.('abort', onDeadline);
  } catch {
    // 뗄 수 없으면 그냥 둔다. 이 실행의 결과와는 무관하다.
  }
  // 손자가 파이프의 쓰기 끝을 쥔 채 남아 있으면 우리 쪽 읽기 끝이 이벤트 루프를 붙잡는다.
  child.stdout?.destroy();
  child.stderr?.destroy();

  const spawnError = outcome.spawnError ?? null;
  const hung = outcome.hung === true;
  // 'exit' 이 왔으면 child.exitCode 는 값이 있고, 신호로 죽었거나 아직 살아 있으면 null 이다.
  // 알고 있는 것을 버리지 않는다 — `lingering` 은 "결과를 모른다"가 아니다.
  const exitCode = spawnError !== null ? null : child.exitCode;

  // ★ stop() 을 불렀다는 것과 실제로 끊었다는 것은 다르다. 데드라인이 자식의 소요 시간에
  //   가까우면 kill 을 보낸 직후 자식이 스스로 exit 0 으로 나갈 수 있다. exit 0 은
  //   "스스로 정상 종료했다"는 뜻이므로 그때는 우리가 끊은 것이 아니다.
  const cutShort = spawnError === null && exitCode !== 0;
  const collected = cap.result();

  return {
    ran: spawnError === null,
    exitCode,
    signalName: child.signalCode ?? null,
    timedOut: stopReason === 'timedOut' && cutShort,
    aborted: stopReason === 'aborted' && cutShort,
    hung,
    // 자식은 끝났는데 파이프를 쥔 손자가 남았다. `hung`("결과를 못 받았다")과 다른 사실이다.
    lingering: outcome.lingering === true,
    spawnError,
    output: collected.text,
    outputChars: collected.chars,
    truncated: collected.truncated,
  };
}

/**
 * 봉투에 실을 **명령 한 줄**. 길면 자른다.
 *
 * ★ 파일 본문에는 쓰지 마라. 아래 `textDigestSummary` 를 써라 — 왜인지는 그쪽 주석에 있다.
 */
function forMessage(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > 400 ? `${text.slice(0, 400)} …(${text.length}자 중 앞 400자)` : text;
}

/**
 * 지문의 사람 읽을 요약. **내용은 절대 싣지 않는다** — 이 문자열은 봉투를 타고 MCP 결과로
 * 나가고, `.npmrc`·`nuget.config` 에는 인증 토큰이 들어간다(실측: 프로젝트의 토큰이 원문
 * 그대로 실렸다). 어느 항목이 어떻게 달라졌는지는 지문으로 충분히 말할 수 있다.
 */
function digestSummary(value) {
  if (!value || typeof value !== 'object') return '없음';
  if (value.digest === 'symlink') return '심볼릭 링크/정션 (내용을 대조할 수 없습니다)';
  if (value.digest === 'directory') return '디렉터리';
  if (value.digest === 'unreadable') return '읽을 수 없음';
  return `sha256:${value.digest.slice(0, 12)}… (${value.bytes}바이트, ${value.lines}줄)`;
}

/**
 * 문자열 하나의 지문 요약 (계획 2 이월 4).
 *
 * ★ 왜 필요한가 (실측, 커밋 c1f24cd 의 테스트가 재현한다): **주 정의**가 어긋났을 때
 *   봉투는 `forMessage` 로 고정값과 현재값을 각각 앞 400자까지 원문으로 실었다. 그런데
 *   `npm-script` 를 뺀 나머지 정의(`file-text` = csproj·pytest.ini, `make-target`,
 *   `ini-section`)는 값이 **파일 본문 전체**다 — csproj 의 `<NuGetPackageSourceApiKey>`
 *   처럼 인증 토큰이 앞쪽 400자 안에 그대로 들어간다. `checkExtras` 는 같은 이유로 이미
 *   지문만 싣는데(`digestSummary`), 주 정의만 그 규율 밖에 있었다.
 *
 * 지문 계산은 `contentDigest` 와 **같은 함수**를 쓴다. 두 자리가 각자 계산하면 같은
 * 파일에 서로 다른 지문이 나와 사람이 대조할 수 없게 된다.
 */
function textDigestSummary(value) {
  return digestSummary(contentDigest(Buffer.from(typeof value === 'string' ? value : String(value ?? ''), 'utf8')));
}

const sameDigest = (a, b) => (a?.digest ?? null) === (b?.digest ?? null);

/**
 * `extras` 를 워크트리에서 다시 읽어 고정값과 대조한다.
 *
 * 규칙은 하나다: **워크트리의 항목은 프로젝트의 것과 같거나 아예 없어야 한다.**
 * "없어도 된다"가 필요한 이유는 무시 규칙에 걸린 파일이 워크트리로 이식되지 않기
 * 때문이다. 다만 git 이 **추적하는** 파일은 반드시 이식되므로, 그것이 없으면 델리게이트가
 * 지운 것이라 거부한다(`pinExtras` 의 `tracked` 참조).
 *
 * `package.json` 의 스크립트 키는 이 완화를 받지 않는다 — 그 파일 자체는 언제나 이식된다.
 *
 * 배열이 아니면(고정값을 손으로 만든 호출부) 조용히 넘어간다 — 주 정의 대조는 이미 끝났고,
 * 여기서 던지면 그 호출부가 봉투 대신 예외를 받는다.
 *
 * @returns `{ error }` 또는 `{ notes }`
 */
async function checkExtras(worktree, extras) {
  const notes = [];
  if (!Array.isArray(extras)) return { notes };

  for (const entry of extras) {
    if (!entry || typeof entry !== 'object') continue;
    const current = await readPinValue(worktree, entry);

    if (entry.kind === 'dir-digests') {
      const pinned = entry.value && typeof entry.value === 'object' ? entry.value : {};
      for (const [name, value] of Object.entries(current ?? {})) {
        if (sameDigest(pinned[name], value)) continue;
        const where = typeof entry.suffix === 'string' ? '워크트리 루트의' : `워크트리의 ${entry.key} 에 있는`;
        return {
          error:
            `${where} ${name} 이(가) 프로젝트의 것과 다릅니다.\n` +
            `프로젝트: ${digestSummary(pinned[name])}\n워크트리: ${digestSummary(value)}\n` +
            '이 자리에 놓인 파일은 우리가 부르려던 명령을 대신하거나 그 도구가 읽는 입력을 바꿉니다.',
        };
      }
      continue;
    }

    if (entry.kind === 'file-digest') {
      const pinned = entry.value ?? null;
      if (current === null) {
        if (pinned === null) continue;
        if (entry.tracked === true) {
          return {
            error:
              `워크트리에서 ${entry.key} 가 사라졌습니다 — 프로젝트에서 git 이 추적하는 파일이라 ` +
              '워크트리에도 있어야 합니다.',
          };
        }
        notes.push(
          `${entry.key} 가 워크트리에 없습니다 — 프로젝트에는 있지만 git 이 추적하지 않아 ` +
            '워크트리로 이식되지 않은 것으로 봤습니다. 그 파일이 실행에 영향을 준다면 이 실행은 프로젝트와 다른 조건입니다.',
        );
        continue;
      }
      if (sameDigest(pinned, current)) continue;
      return {
        error:
          pinned === null
            ? `델리게이트가 ${entry.key} 를 새로 만들었습니다 — 프로젝트에는 없던 것입니다.\n워크트리: ${digestSummary(current)}`
            : `델리게이트가 ${entry.key} 를 바꿨습니다.\n프로젝트: ${digestSummary(pinned)}\n워크트리: ${digestSummary(current)}`,
      };
    }

    // npm-script: scripts.test 명령의 실행 계약을 진단해야 하므로 이 좁은 예외만 원문을 싣는다.
    const pinned = entry.value ?? null;
    if (current === pinned) continue;
    if (pinned === null) {
      return {
        error:
          `델리게이트가 ${entry.key} 를 새로 만들었습니다 — 프로젝트에는 없던 것입니다.\n` +
          `현재값: ${forMessage(current)}`,
      };
    }
    if (current === null) return { error: `워크트리에서 ${entry.key} 가 사라졌습니다 — 프로젝트에는 있었습니다.` };
    return {
      error: `델리게이트가 ${entry.key} 를 바꿨습니다.\n고정값: ${forMessage(pinned)}\n현재값: ${forMessage(current)}`,
    };
  }
  return { notes };
}

/**
 * 우리가 **사용자 권한으로** 저장소 코드를 실행한다는 사실 (설계 §5.8 S1).
 *
 * ★ 왜 상수인가: `src/engine.mjs` 가 이 문장을 실행 봉투의 notice 로 **한 번만** 올리려면
 *   두 모듈이 같은 글자를 봐야 한다. 문장을 양쪽에 따로 적으면 스텝 수만큼 중복된다.
 *
 * ★ 왜 좁히지 않고 신고하는가: 릴레이 프록시는 이 제품에 걸 데가 없다 — 구독 인증이라
 *   자식 env 에 막을 raw 키가 애초에 없고, 남는 잔여는 env 가 아니라 홈 아래 **파일**이라
 *   env 를 손대는 어떤 조치로도 안 닫힌다. 실측 표는 `src/providers/child-env.mjs` 헤더에
 *   있다(자격증명 파일에 절대 경로로 닿았고, `USERPROFILE` 을 돌려도 libuv 가 되돌려 놓는
 *   `HOMEDRIVE`+`HOMEPATH` 로 진짜 홈이 복원됐다).
 */
export const USER_PRIVILEGE_NOTE =
  '이 스위트는 사용자 권한으로 실행됐고 홈 디렉터리 전체를 읽을 수 있었습니다 — ' +
  '자격증명 파일을 포함합니다. 이 러너에는 그것을 막을 경로가 없습니다(설계 §5.8 S1).';

/**
 * 고정된 명령의 첫 토큰이 **자식 환경에서는 풀리지 않는** 형태인지 본다. 맞으면 사유 문장.
 *
 * 실측: 자식 env 의 `NoDefaultCurrentDirectoryInExePath` 는 cwd 탈취를 막는 대신,
 * 루트에 커밋해 둔 헬퍼를 맨이름으로 부르는 평범한 Windows 프로젝트를 깬다
 * (`"test":"runtests"` + 루트 `runtests.cmd` -> 가드 있음 exit 1 / 없음 exit 0 "HELPER RAN").
 * 가드는 유지한다 — 그 동작에 기대는 것이 곧 공격 표면이다. 조용히 깨지는 것만 막는다.
 * `MISSING_DEP_SIGNS` 는 영어 문구만 담아 한국어 로케일에서는 잡지 못했다(실측).
 */
async function cwdLookupWarning(worktree, definition) {
  if (!WINDOWS) return null;
  const source = definition?.kind === 'npm-script' || definition?.kind === 'make-target' ? definition.value : null;
  if (typeof source !== 'string') return null;

  const recipe = definition.kind === 'make-target' ? source.split(/\r?\n/).find((l) => l.startsWith('\t')) : source;
  const token = String(recipe ?? '').trim().replace(/^[@\-+]+/, '').split(/\s+/)[0]?.replace(/^["']|["']$/g, '');
  if (!token || token === '' || /[\\/:]/.test(token)) return null;

  const exts = ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')].map((e) => e.trim().toLowerCase());
  const inRoot = [];
  for (const ext of exts) {
    if (await isFile(join(worktree, token + ext))) inRoot.push(token + ext);
  }
  if (inRoot.length === 0) return null;
  // node_modules/.bin 이 PATH 앞에 붙으므로 거기 있으면 정상적으로 풀린다.
  for (const ext of exts) {
    if (await isFile(join(worktree, 'node_modules', '.bin', token + ext))) return null;
  }

  return (
    `테스트 명령이 워크트리 루트의 ${inRoot.join(' / ')} 을(를) 맨이름 "${token}" 으로 부릅니다. ` +
    '이 러너의 자식 환경은 실행 파일 탐색에서 cwd 를 빼므로(워크트리에 놓인 동명 실행 파일이 ' +
    `우리가 고른 명령을 대신하는 것을 막는다) 그 이름은 풀리지 않습니다 — ".\\${token}" 처럼 ` +
    '경로 구분자를 붙이면 그대로 돕니다.'
  );
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 워크트리에서 고정된 테스트 명령을 돌린다. **절대 throw 하지 않는다.**
 *
 * @param spec `{ worktree, command, args, source, definition, launcher, exitCodeExact,
 *   env, runId, signal, timeoutMs, onSpawn }` — `deriveTestCommand` 의 결과를 그대로 펼쳐
 *   넘기면 된다.
 *
 *   `onSpawn(child)` 는 스폰 직후 한 번 불린다. 배선 계층이 여기서 자식을 리퍼 원장에
 *   올린다(`src/reaper.mjs` 의 `trackChild`) — 이 러너는 `stateRoot` 를 모르고 리퍼를
 *   import 하지도 않는다. 돌려준 프로미스는 기다리지 않고 거부도 삼킨다.
 *
 *   **`definition` 은 필수다.** 없으면 워크트리의 명령이 그대로인지 확인할 방법이 없고,
 *   확인하지 못한 명령은 돌리지 않는다.
 *
 * @returns 인자가 잘못됐거나 워크트리의 정의가 고정값과 어긋나면
 *   `{ blocked: true, error, recovery, definitionCheck }`, 아니면 결과 객체.
 *   `passed` 는 "스위트가 통과했나"(못 띄웠으면 null), `confidence` 는 "그 판정을 믿어도
 *   되나"다. 둘은 서로 다른 축이다 — 실패한 스위트도 `verified` 일 수 있다.
 *   `exitCodeExact` 가 false 면 `exitCode` 를 스위트의 값으로 읽으면 안 된다.
 */
export async function runTests(spec) {
  try {
    const options = spec && typeof spec === 'object' ? spec : {};
    const { worktree, command, definition, source = null, runId, signal } = options;
    const args = options.args ?? [];

    if (typeof worktree !== 'string' || worktree === '' || !isAbsolute(worktree)) {
      return blocked(
        `워크트리 경로가 절대 경로가 아닙니다: ${JSON.stringify(worktree)}`,
        '워크트리의 절대 경로를 주세요. 상대 경로는 이 프로세스의 cwd 기준으로 풀려 엉뚱한 디렉터리에서 돕니다.',
      );
    }
    if (!(await isDirectory(worktree))) {
      return blocked(`워크트리 디렉터리가 없습니다: ${worktree}`, '워크트리를 먼저 만든 뒤 테스트를 돌리세요.');
    }
    if (typeof command !== 'string' || command === '' || !isAbsolute(command)) {
      // ★ "도구를 못 찾았다"와 "경로가 상대다"는 원인도 사용자의 행동도 다르다.
      //   `deriveTestCommand` 는 전자를 이미 `resolveError` 로 알려 준다 — 그것을 버리면
      //   봉투가 사용자가 이미 한 일을 시키는 막다른 길이 된다(make/python/dotnet 이 없는
      //   기계에서는 이것이 기본 경로다).
      const resolveError = options.resolveError;
      if (typeof resolveError === 'string' && resolveError !== '') {
        return blocked(
          resolveError,
          '그 도구를 설치하거나 PATH 에 넣은 뒤 deriveTestCommand 부터 다시 하세요. 이 러너는 도구를 대신 ' +
            '고르지 않습니다 — 추측한 도구로 낸 결과는 검증에 쓸 수 없습니다.',
        );
      }
      return blocked(
        `실행 파일이 절대 경로가 아닙니다: ${JSON.stringify(command)}`,
        'deriveTestCommand 가 낸 command 를 그대로 넘기세요. 이름으로 스폰하면 Windows 의 libuv 가 ' +
          '자식의 cwd(= 워크트리)를 PATH 보다 먼저 뒤져, 워크트리에 놓인 같은 이름의 실행 파일이 돕니다.',
      );
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      return blocked('args 는 문자열 배열이어야 합니다.', 'deriveTestCommand 가 낸 args 를 그대로 넘기세요.');
    }
    // ★ 다른 인자는 전부 검증하는데 signal 만 안 했다. `AbortController` 를 넘기는 흔한
    //   배선 실수에서 셋업이 던지고, 봉투가 나간 **뒤에** 자식의 'error' 가 uncaught 로
    //   프로세스를 죽였다(실측). 'error' 리스너를 먼저 붙여 그 죽음은 닫았지만, 잘못된
    //   인자를 스폰까지 끌고 갈 이유는 없다.
    if (signal !== undefined && signal !== null && typeof signal.addEventListener !== 'function') {
      return blocked(
        'signal 은 AbortSignal 이어야 합니다 — addEventListener 가 없습니다.',
        'AbortController 자체가 아니라 그 controller.signal 을 넘기세요.',
      );
    }

    // 정수가 아닌 값은 `src/deadline.mjs` 의 `timeoutSignal` 이 내림한다 — 그 한 곳이
    // 실제 방어다. 여기서 다시 깎아 두어도 봉투에는 `timeoutMs` 가 실리지 않으므로
    // 관측 가능한 차이가 없다.
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const notes = [];

    // ── ★★ 고정값 대조. 스폰 **앞**이고, 어긋나면 스폰하지 않는다.
    //
    //    돌린 뒤에 탐지하는 것은 늦다: 그때는 델리게이트가 고른 명령이 우리 프로세스의
    //    권한과 환경으로 이미 돈 뒤다. 이 검사가 실행 앞에 있다는 것 자체가 §12.-1 의
    //    보증이다.
    if (!definition || typeof definition !== 'object' || typeof definition.value !== 'string') {
      return {
        ...blocked(
          '고정된 테스트 명령 정의가 없어 워크트리의 명령이 그대로인지 확인할 수 없습니다.',
          'deriveTestCommand 의 결과를 definition 까지 포함해 그대로 넘기세요. 확인하지 못한 명령은 실행하지 않습니다.',
        ),
        definitionCheck: 'missing',
      };
    }

    const current = await readDefinitionValue(worktree, definition);
    if (current === null) {
      return {
        ...blocked(
          `워크트리에서 ${definition.file} 의 ${definition.key} 를 읽지 못해 고정값과 같은지 확인할 수 없습니다.`,
          '워크트리에 그 파일이 있는지 확인하세요. 확인하지 못한 명령은 실행하지 않습니다.',
        ),
        definitionCheck: 'unreadable',
      };
    }
    if (current !== definition.value) {
      // ★ `npm-script` 만 원문을 싣는다 — scripts.test 실행 계약을 사람이 확인할 수 있게
      //   하는 좁은 예외다(`checkExtras` 의 같은 갈래와 같은 근거). 나머지 정의는 값이
      //   파일 본문 전체라 지문만 싣는다.
      const show = definition.kind === 'npm-script' ? forMessage : textDigestSummary;
      return {
        ...blocked(
          `델리게이트가 테스트 명령을 바꿨습니다 — 워크트리의 ${definition.file} 에서 ${definition.key} 가 ` +
            `고정값과 다릅니다.\n고정값: ${show(definition.value)}\n현재값: ${show(current)}`,
          '실행하지 않고 멈췄습니다. 바뀐 명령으로 낸 결과는 델리게이트가 고른 명령의 결과라 검증에 쓸 수 없습니다. ' +
            '변경 내역을 확인하고, 그 변경이 정당하다면 사용자가 확인한 뒤 프로젝트 쪽 정의를 갱신하고 다시 유도하세요.',
        ),
        definitionCheck: 'changed',
      };
    }

    // ── ★★ 같은 도구가 함께 읽는 입력들. 값이 null 인 항목은 "프로젝트에 없었다"가
    //    고정값이라, 워크트리에 새로 생기면 여기서 걸린다(위 §고정 대상 참조).
    const extras = await checkExtras(worktree, definition.extras);
    if (extras.error !== undefined) {
      return {
        ...blocked(
          extras.error,
          '실행하지 않고 멈췄습니다. 고정한 테스트 명령은 그대로지만 같은 도구가 함께 읽는 입력이 달라졌고, ' +
            '그 입력은 우리가 돌리는 명령을 바꿉니다. 변경 내역을 확인하고, 그 변경이 정당하다면 사용자가 ' +
            '확인한 뒤 프로젝트 쪽에 반영하고 다시 유도하세요.',
        ),
        definitionCheck: 'changed',
      };
    }
    notes.push(...extras.notes);

    // 자식 환경이 cwd 를 실행 파일 탐색에서 빼는 대가. 조용히 깨지면 안 된다.
    const lookupWarning = await cwdLookupWarning(worktree, definition);
    if (lookupWarning !== null) notes.push(lookupWarning);

    // ── 자식 환경. authNames 가 빈 배열이라 벤더 인증은 하나도 넘어가지 않는다.
    //    테스트 스위트가 우리 구독 인증을 읽을 이유가 없다(S1 표면 축소).
    //
    //    pathPrepend: `node --run` 이 띄우는 셸이 스크립트의 `node` 를 풀 수 있어야 하고,
    //    그때 풀리는 것이 우리가 프로브한 그 노드여야 한다.
    //
    //    childEnvExtra: 도구별 계산값(pytest 의 PYTHONSAFEPATH). allowlist 를 우회한다.
    const childEnv = buildChildEnv(options.env ?? process.env, {
      authNames: [],
      runId,
      pathPrepend: [dirname(process.execPath)],
      extra: options.childEnvExtra,
      notes,
    });

    const started = Date.now();
    const run = await spawnAndCollect({
      command,
      args,
      cwd: worktree,
      env: childEnv,
      signal,
      timeoutMs,
      onSpawn: options.onSpawn,
    });
    const durationMs = Date.now() - started;

    const passed = run.ran ? run.exitCode === 0 : null;

    let confidence = 'verified';
    if (!run.ran) {
      confidence = 'unverified';
      // spawnError 는 Error 객체라 JSON 직렬화에서 `{}` 가 된다. 사유를 문자열로도 남긴다.
      notes.push(`테스트 명령을 띄우지 못했습니다: ${run.spawnError}`);
    }
    if (run.timedOut || run.aborted || run.hung) confidence = 'unverified';

    // ★ 남은 프로세스는 사실로 알린다. 회수 경로가 없다(KILL_GRACE_MS 주석의 잔여 위험).
    if (run.lingering) {
      notes.push(
        '스위트는 끝났는데 출력 파이프를 쥔 배경 프로세스가 남아 있습니다 — 종료 코드는 스위트의 것이 ' +
          '맞지만, 그 프로세스는 워크트리 안에서 계속 돌고 이 러너에는 그것을 회수할 경로가 없습니다.',
      );
    }
    if (run.hung) {
      notes.push(
        '끊은 뒤에도 출력 파이프가 닫히지 않아 결과를 기다리지 않고 나왔습니다 — 워크트리 안에 프로세스가 ' +
          '남아 있을 수 있고, 이 러너에는 그것을 회수할 경로가 없습니다.',
      );
    }

    // 우리가 cwd 를 탐색에서 뺐기 때문에 못 푼 명령은 "테스트 실패"가 아니다. 로케일
    // 문자열에 기대지 않는 결정적 판정이라 MISSING_DEP_SIGNS 와 달리 확실하다.
    if (passed === false && lookupWarning !== null) confidence = 'unverified';

    // 의존성 부재로 못 돌린 것을 "테스트 실패"로 보고하지 않는다. 이 프로젝트는 워크트리에
    // 의존성을 넣지 않는다(맨 위 주석) — 그 결정의 대가를 여기서 드러낸다.
    if (passed === false && MISSING_DEP_SIGNS.some((sign) => run.output.includes(sign))) {
      const hasNodeModules = source === 'package.json' ? await isDirectory(join(worktree, 'node_modules')) : true;
      if (source !== 'package.json' || !hasNodeModules) {
        confidence = 'unverified';
        notes.push(
          source === 'package.json'
            ? '워크트리에 node_modules 가 없어 의존성을 찾지 못했습니다 — 이 러너는 의존성을 설치하지도 링크하지도 않습니다.'
            : '의존성을 찾지 못해 실패했습니다 — 이 러너는 의존성을 설치하지도 링크하지도 않습니다.',
        );
      }
    }

    // ★ 우리가 사용자 권한으로 저장소 코드를 실행했다는 사실을 결과가 말한다(§5.8 S1).
    //   `run.ran` 일 때만이다 — 못 띄운 스위트를 "돌았다"고 말하면 그 자체가 거짓 보고다.
    //   한 번만 넣는다. 스텝마다 쌓이면 시끄러운 실행에서 다른 알림을 밀어낸다.
    if (run.ran) notes.push(USER_PRIVILEGE_NOTE);

    return {
      ran: run.ran,
      passed,
      exitCode: run.exitCode,
      // ★ `node --run` 은 비0 종료 코드를 전부 1 로 접는다(실측). 이 필드가 없으면
      //   소비자(엔진·보상 계층)가 exitCode 를 스위트의 값으로 읽는다.
      exitCodeExact: options.exitCodeExact === true,
      launcher: typeof options.launcher === 'string' ? options.launcher : null,
      signalName: run.signalName,
      timedOut: run.timedOut,
      aborted: run.aborted,
      hung: run.hung,
      lingering: run.lingering,
      spawnError: run.spawnError,
      output: run.output,
      outputChars: run.outputChars,
      truncated: run.truncated,
      command,
      args,
      source,
      definitionCheck: 'match',
      confidence,
      notes,
      durationMs,
    };
  } catch (error) {
    return blocked(
      `테스트 러너가 예상치 못한 오류로 멈췄습니다: ${error}`,
      '워크트리 경로와 deriveTestCommand 의 결과를 확인한 뒤 다시 시도하세요.',
    );
  }
}
