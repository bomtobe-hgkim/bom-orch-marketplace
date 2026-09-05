/**
 * 테스트 명령을 **사용자 프로젝트에서** 유도하고, 그 명령이 함께 읽는 입력들을 고정값으로
 * 뽑아낸다 — 정의 추출(Makefile 타깃 · ini 구획 · npm 스크립트), 고정 항목의 값·지문·git 추적
 * 여부, 도구 해석과 런처 선택(`node --run` 프로브와 npm-cli.js 폴백), 그리고 다섯 갈래의
 * 유도 순서(`.bom-orch.json` → package.json → csproj → Makefile → pytest)가 전부 여기 있다.
 * 여섯 생태계의 **발견**(`discoverTestEcosystems` — jest·vitest·go·gradle·maven·cargo-nextest)도
 * 여기다. 유도와 발견은 같은 트리를 같은 리더로 읽지만 하는 말이 다르다: 유도는 「무엇을 돌릴
 * 것인가」의 **결정**이고 발견은 「무엇을 돌릴 수 있나」의 **제안**이라, 유도는 발견을 부르지
 * 않는다 — 제안이 결정으로 조용히 승격되면 이 러너가 사용자가 적지도 않은 명령을 사용자
 * 권한으로 돌리게 된다.
 *
 * ★ 방향은 한쪽이다: `src/test-runner.mjs` → 여기. 이 파일은 러너를 수입하지 않고 계획도
 *   실행도 모른다. 러너가 되읽어 대조에 쓰는 넷(`readDefinitionValue`·`readPinValue`·
 *   `contentDigest`·`extractIniSection`)을 함께 내보내는 이유가 그것이다 — **유도할 때 쓴
 *   그 함수로** 워크트리를 다시 읽어야 정상 프로젝트가 위조로 잡히지 않는다.
 * ★ 실측 폐포: **22개 모듈 / 8,985줄**(자기 자신 1,147 포함) — `git`(1,128)과 그것이 끄는 `providers/error-catalog`·`providers/resolve-binary`·`state-root`, `deps-provision`(594)과 그것이 끄는 `deadline`·`providers/child-env`, `project-config`(489), `reason-codes`·`reason-text`, `util/{errors,freeze,strings}`. 저장소 모듈도 `engine` 도 `test-runner` 도 **0개**다. 태스크 7 이 `reason-text` 를 **직접** 수입하던 줄을 걷었지만(알림 생산자가 없어졌다) 모듈 수는 그대로다 — `project-config` 가 여전히 그것을 끈다. T3 재심 N1–N3 수정 파도(올림, 실측): 자기 자신 1,122 -> 1,147(+25 — `GRADLE_WRAPPERS` 에 `gradlew.bat` 한 항목·`detect` 술어 수정·N1(vite.config.* WHY)·N3(Cargo.toml 이유) 정정 주석), 모듈 수는 그대로다.
 * ★ 수입하는 쪽: 실측 **10**. 규칙은 「이 파일을 가리키는 정적 지정자가 있는 파일」이고 다시 재는
 *   명령은 `git grep -lE "from '[^']*test-discovery\.mjs'"` 다 — 이름을 나열하지 않는 이유는 그
 *   목록이 이 헤더에서 이미 두 번 낡았기 때문이다(「넷뿐」 → 「여섯뿐」, 둘 다 실측은 더 컸다).
 *   ⚠ 이 수는 **가드가 재지 않는 산문**이다: 기계가 재는 것은 위의 폐포 문장(`module-directions`
 *   규칙 (d))과 방향 표의 행뿐이므로, 고칠 때는 위 명령을 실제로 돌려라. 열 중 `src/` 는 셋이다 —
 *   `src/test-runner.mjs`(이름 9개) · `src/engine.mjs`(`discoverTestEcosystems`) ·
 *   `src/patch-scope.mjs`(WS5 T3 — `isTestCommandConfigPath` 와 `TEST_RUNNER_CONFIG_NAMES`).
 *   나머지 일곱은 테스트 여섯과 `scripts/ecosystem-matrix.mjs` 다. 수입은 **이쪽으로만** 온다 —
 *   이 파일은 그 셋 중 어느 것도 수입하지 않는다.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { findNpmCli } from './deps-provision.mjs';
import { runGit } from './git.mjs';
import { PROJECT_CONFIG_FILE, readProjectConfig } from './project-config.mjs';
import { resolveBinary } from './providers/resolve-binary.mjs';

/**
 * 러너가 부르는 이름들. `PYTEST_BOOTSTRAP` 과 `deriveTestCommand` 는 옮겨 온 선언에 이미
 * `export` 가 붙어 있으므로 여기 적지 않는다 — 나머지 선언은 한 글자도 건드리지 않았고,
 * 그것이 이 커밋이 순수 이동이라는 증거다.
 */
export {
  PYTEST_ENV,
  contentDigest,
  defaultResolveTool,
  extractIniSection,
  newDerivation,
  readDefinitionValue,
  readPinValue,
};

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
/**
 * ★ `PYTHONDONTWRITEBYTECODE` 가 필요한 이유(실측): 플러그인은 복사되지 않고
 *   `PYTHONPATH=<repo>/src/test-reporters` 로 **제자리에서** import 된다. 그러면 Python 이
 *   그 옆에 `__pycache__/pytest_events.cpython-*.pyc` 를 쓴다 — 소스 트리에 빌드 산출물이
 *   생기고, `src/**` 를 통째로 복사하는 마켓플레이스 exporter 가 **그 .pyc 를 두 호스트
 *   플러그인 루트에 그대로 배포한다**(실측: 내보낸 파일 목록에 두 건이 나왔다).
 *   테스트를 한 번 돌린 기계에서 릴리스를 만들면 특정 Python·pytest 버전에 묶인 바이트코드가
 *   패키지에 섞인다.
 */
const PYTEST_ENV = Object.freeze({ PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1' });

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

/** `--run` 프로브의 시간 상한. 실측으로 즉시 끝나지만 매달리게 둘 수는 없다. */
const PROBE_TIMEOUT_MS = 10_000;

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
//   .bom-orch.json : 그 파일의 커밋된 바이트(주) · **위 넷의 extras 전부**(합집합). 선언된
//                  argv 가 어느 생태계의 도구인지 이 판은 알 수 없고, 이름표는 뒤처진다 —
//                  이유는 `CONFIG_COMMAND_EXTRAS` 의 WHY 에 있다.
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
// ★★ 이 `key` 는 **해시 입력**이다(`publicDefinitionPins` → `hashJson` → `plan.pinnedDefinitions`).
//   영어로 옮기면 FrozenTestPlan 다이제스트가 바뀐다 — WS2 spec §0 의 계약 변경이고, 픽스처는
//   같은 커밋에서 다시 기록했다(불변식 14).
const suffixPin = (suffix) => ({ kind: 'dir-digests', file: '.', suffix, key: `root *${suffix}` });

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

/**
 * `.bom-orch.json` 의 `tests.command` 가 고정하는 것 — 위 넷의 **합집합**이다.
 *
 * ★★ 이 갈래만 `extras: []` 였고, 그것이 이 저장소에서 유일하게 **드리프트 관문이 꺼진** 실행
 *   경로였다(`checkExtras` 는 빈 배열을 조용한 통과로 읽는다). 설정 파일 자체의 바이트는
 *   `verifyDefinition` 이 주 정의로 대조하지만 그것은 **우리가 읽는 파일**이고, 스폰 때 실제로
 *   읽히는 것은 **델리게이트의 워크트리에 있는 레시피**다: `tests.command: ["make","test"]`
 *   한 줄이면 워크트리의 `Makefile` 이 그 실행을 정하고, `.bom-orch.json` 은 한 글자도 안
 *   바뀐 채 초록이 된다. `src/patch-scope.mjs` 도 `Makefile`·`conftest.py` 를 **안 잡는다고**
 *   명시하므로 뒤에 두 번째 관문이 없다.
 * ★★ 왜 도구 이름으로 고르지 않고 **합집합**인가. 여기서 아는 것은 argv 한 줄뿐이고 그
 *   `argv[0]` 은 PATH 의 아무 이름이나 될 수 있다(`npm`·`make`·`pytest`·`dotnet`·래퍼 스크립트·
 *   프로젝트 자체 실행 파일). 이름표를 세우면 그 표에 없는 이름 하나가 다시 「관문 꺼짐」이
 *   되고, 그 구멍은 이 파일의 §고정 대상이 이미 세 번 겪은 실패 방식이다(열거는 뒤처진다).
 *   합집합의 비용은 읽기뿐이고, 규칙은 **관계**라 비용 이상의 거짓 거부를 만들지 않는다:
 *   「워크트리의 항목은 프로젝트의 것과 같거나 아예 없어야 한다」는 갓 만든 워크트리의 추적
 *   파일이 언제나 만족한다.
 * ★ 알려진 상호작용 하나(새로 생기는 것이 아니라 npm 갈래가 이미 지고 있는 것): 프로젝트에
 *   `node_modules` 가 없고 `tests.provisionDeps` 로 워크트리에만 설치하면 `node_modules/.bin`
 *   의 항목들이 「프로젝트에 없던 것」이 되어 드리프트로 잡힌다. fail-closed 이고, 자동 유도된
 *   npm 갈래에서 이미 그렇게 동작한다 — 이 갈래만 다르게 두는 것이 오히려 설명할 수 없다.
 */
const CONFIG_COMMAND_EXTRAS = [...NPM_EXTRAS, ...CSPROJ_EXTRAS, ...MAKE_EXTRAS, ...PYTEST_EXTRAS];

// ★ 정본(`TEST_COMMAND_CONFIG_INPUTS`)은 이 표 **아래**에 있다 — 계산 원천이 둘이고 나머지 하나가
//   발견 쪽(`RUNNER_COMMAND_CONFIGS`)이라, 정본은 둘 다 선언된 뒤에야 태어날 수 있다.

// ── 생태계 발견 (WS4a 태스크 7, 결정 8) ───────────────────────────────────
//
// ★★ **발견은 실행하지 않는다.** 파일과 설정의 존재만 본다 — 도구를 띄워 확인하는 것은 로컬
//   매트릭스(`npm run test:ecosystem`)다. 여기서 "돌려 보고 판단"하면 그 판단은 이 기계에 그
//   툴체인이 깔려 있는지에 좌우되고, 없는 기계에서는 조용히 "그런 생태계 없음"이 된다.
//
// ★ 읽는 트리는 `deriveTestCommand` 가 읽는 그 트리다(**사용자 프로젝트**, 워크트리 사본이
//   아니다) — 같은 `readTextFile`/`readdir` 로 읽으므로 두 판정이 갈릴 자리가 없다.

/** Go 트리 훑기의 경계. 깊이와 방문 디렉터리 수 둘 다 막는다 — 하나만 막으면 넓고 얕은 트리가 샌다. */
const GO_WALK_MAX_DEPTH = 6;
const GO_WALK_MAX_DIRS = 512;

/** 남의 코드가 사는 자리. 여기서 찾은 `*_test.go` 는 이 프로젝트의 테스트가 아니다. */
const WALK_SKIP_DIRS = new Set(['.git', '.gradle', '.idea', 'build', 'dist', 'node_modules', 'target', 'vendor']);

async function hasGoTestFile(root) {
  let visited = 0;
  const queue = [['', 0]];
  while (queue.length > 0) {
    const [relativeDir, depth] = queue.shift();
    visited += 1;
    if (visited > GO_WALK_MAX_DIRS) return false;
    let entries;
    try {
      entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && /^.+_test\.go$/.test(entry.name)) return true;
      if (entry.isDirectory() && depth < GO_WALK_MAX_DEPTH && !WALK_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        queue.push([relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`, depth + 1]);
      }
    }
  }
  return false;
}

async function rootFileExists(root, name) {
  try {
    return (await readdir(join(root, dirname(name)), { withFileTypes: true }))
      .some((entry) => entry.name === basename(name) && (entry.isFile() || entry.isSymbolicLink()));
  } catch {
    return false;
  }
}

/** 존재하는 것만 골라 낸다. 반환 순서가 곧 `evidence` 순서다. */
async function presentFiles(root, names) {
  const found = [];
  for (const name of names) {
    if (await rootFileExists(root, name)) found.push(name);
  }
  return found;
}

async function packageJsonHasKey(root, key) {
  const text = await readTextFile(root, 'package.json');
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, key);
  } catch {
    return false;
  }
}

const JEST_CONFIGS = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.json'];
const VITEST_CONFIGS = ['vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs', 'vitest.config.ts',
  'vite.config.js', 'vite.config.cjs', 'vite.config.mjs', 'vite.config.ts'];
const NEXTEST_CONFIGS = ['.config/nextest.toml'];
const GRADLE_BUILDS = ['build.gradle', 'build.gradle.kts'];
const GRADLE_WRAPPERS = ['gradlew', 'gradlew.bat'];
const MAVEN_PROJECTS = ['pom.xml'];

/**
 * ★★ **정본의 둘째 계산 원천** — 발견이 읽는 것 중 「무엇이 도는가」를 정하는 이름들
 *   (아래 `TEST_COMMAND_CONFIG_INPUTS` 가 이것을 받는다, WS5 T3 리뷰 I2).
 *
 * 발견 자체는 제안이지 결정이 아니다. 그런데 여기 적힌 파일들은 **이미 유도된** 명령이 무엇을
 * 실행할지를 정한다: `jest.config.js` 의 `setupFiles`·`globalSetup`·`testMatch`·`reporters` 는
 * 스위트 자체를 갈아치울 수 있고, `pom.xml`·`build.gradle` 은 테스트 태스크의 정의이며
 * `gradlew`·`gradlew.bat` 는 설정이 아니라 **실행되는 스크립트 자신**이다(빌드 파일만 잠그고
 * 그것을 부르는 래퍼 둘 중 하나라도 열어 두면 관문이 자기를 우회한다 — Windows 는 `.bat` 을
 * 부르고 그 launcher 도 `gradlew` 와 똑같이 하드다, T3 재심 N2). 후보가 그것을 고친 실행은 자기
 * 증명을 자기가 정한 실행이고, 그것은 `package.json` 의 `scripts` 가 이미 닫은 구멍과 **같은
 * 부류**다.
 *
 * ⚠ 여기 **없는** 것 둘(`go.mod`·`Cargo.toml`): 각각 짝이 되는 lockfile(`go.sum`·`Cargo.lock`)이
 *   `src/patch-scope.mjs` 에서 `allowable` 등급이다. 매니페스트를 하드로 두면 의존성 bump 한 번이
 *   허용목록으로도 못 지우는 플래그가 되어 이 WS 의 종료 기준(「lockfile bump 는 succeeded +
 *   flagged」)이 깨진다 — 제외는 이 lockfile-짝 이유 **하나로** 선다.
 * ⚠ **정정(T3 재심 N3)**: 위 문단이 전에 「(둘 다) 명령을 정하지 않는 의존성 매니페스트」라고
 *   적었는데, 그것은 `go.mod` 에는 참이지만 `Cargo.toml` 에는 참이 **아니다** — `[[test]]` 타깃·
 *   `harness = false`·`[profile.test]` 가 그 파일 안에서 **무엇이 도는지를 실제로 정한다.** 그래도
 *   배분은 바뀌지 않는다: 제외가 서는 것은 「명령을 안 정해서」가 아니라 위 lockfile-짝 이유
 *   하나뿐이었고, 그 이유는 `Cargo.toml` 에도 그대로 선다.
 *   그 판단을 `test/test-discovery.test.mjs` 가 소스 스크레이프로 못 박는다 — 새 생태계가
 *   이름 하나를 더 읽으면 정본에 들거나 이유를 적거나 둘 중 하나를 하게 된다.
 */
const RUNNER_COMMAND_CONFIGS = [
  ...JEST_CONFIGS, ...VITEST_CONFIGS, ...NEXTEST_CONFIGS,
  ...GRADLE_BUILDS, ...GRADLE_WRAPPERS, ...MAVEN_PROJECTS,
];

/**
 * 생태계 여섯의 판정과, **결정적일 때만** 붙는 제안. 순서는 이 배열이 정본이다(정렬하지 않는다 —
 * 고정 리터럴 목록이라 두 호스트가 같은 답을 낸다).
 *
 * `suggestion` 이 null 인 둘의 이유는 서로 다르지만 결론은 같다 — **경로를 지어내지 않는다**:
 *   · Gradle: 기본 경로 `build/test-results/test` 는 규약일 뿐이고 실제 자리는 빌드 스크립트의
 *     `reports.junitXml.outputLocation` 이 정한다. Groovy·Kotlin 을 파싱해 그것을 알아낼 수는
 *     없고, 틀린 경로를 제안하면 사용자는 아무것도 읽지 않은 실행을 초록으로 받는다.
 *   · cargo-nextest: 출력 경로를 정하는 **CLI 플래그가 아예 없다**. 자리는 프로젝트가 소유한
 *     `.config/nextest.toml` 의 `[profile.*.junit]` 안이고, 그 파일의 존재가 이 생태계의 판정
 *     근거이기도 하다 — 그러니 프로젝트에게 되물을 것이 아니라 프로젝트가 이미 답을 갖고 있다.
 *
 * 나머지 넷은 **경로를 우리가 명령줄에서 정하거나**(vitest `--outputFile`, gotestsum
 * `--junitfile`) **생산자 자신의 기본값이 결정적이다**(jest-junit 은 CWD 의 `junit.xml`,
 * Surefire 는 `target/surefire-reports` 디렉터리).
 */
const TEST_ECOSYSTEMS = [
  {
    ecosystem: 'cargo-nextest',
    async detect(root) {
      const files = await presentFiles(root, ['Cargo.toml', ...NEXTEST_CONFIGS]);
      return files.length === 2 ? files : null;
    },
    suggestion: null,
  },
  {
    ecosystem: 'go',
    async detect(root) {
      const files = await presentFiles(root, ['go.mod']);
      return files.length === 1 && (await hasGoTestFile(root)) ? files : null;
    },
    suggestion: { command: ['gotestsum', '--junitfile', 'junit.xml', '--', './...'], reporter: 'junit-xml', resultsPath: 'junit.xml' },
  },
  {
    ecosystem: 'gradle',
    async detect(root) {
      const builds = await presentFiles(root, GRADLE_BUILDS);
      // ★ `> 0`, not `=== 1` (T3 re-review N2): `GRADLE_WRAPPERS` now names BOTH launchers of the
      //   one wrapper (`gradlew`, `gradlew.bat`), and a real Gradle project commits both. The
      //   intent was always "the wrapper is present" - `=== 1` only ever meant that because the
      //   list held a single name; naively adding a second name without widening this predicate
      //   would make every such project undetected (`test/test-discovery.test.mjs`'s "either wrapper
      //   file … BOTH does not break it" fixture proves it fails at `=== 1` and passes at `> 0`).
      const wrapper = await presentFiles(root, GRADLE_WRAPPERS);
      return builds.length > 0 && wrapper.length > 0 ? [...builds, ...wrapper] : null;
    },
    suggestion: null,
  },
  {
    ecosystem: 'jest',
    async detect(root) {
      const files = await presentFiles(root, JEST_CONFIGS);
      if (files.length > 0) return files;
      return (await packageJsonHasKey(root, 'jest')) ? ['package.json'] : null;
    },
    suggestion: { command: ['npx', 'jest', '--reporters=jest-junit'], reporter: 'junit-xml', resultsPath: 'junit.xml' },
  },
  {
    ecosystem: 'maven',
    async detect(root) {
      const files = await presentFiles(root, MAVEN_PROJECTS);
      return files.length === 1 ? files : null;
    },
    // ★ 디렉터리다. Surefire 는 테스트 클래스마다 `TEST-<FQCN>.xml` 을 하나씩 낸다.
    suggestion: { command: ['mvn', '-B', 'test'], reporter: 'junit-xml', resultsPath: 'target/surefire-reports' },
  },
  {
    ecosystem: 'vitest',
    async detect(root) {
      const files = await presentFiles(root, VITEST_CONFIGS);
      return files.length > 0 ? files : null;
    },
    suggestion: {
      command: ['npx', 'vitest', 'run', '--reporter=junit', '--outputFile=junit.xml'],
      reporter: 'junit-xml',
      resultsPath: 'junit.xml',
    },
  },
];

/**
 * 이 프로젝트가 담고 있는 테스트 생태계들. **실행하지 않는다** — 파일·설정의 존재만 본다.
 *
 * 소비자는 이 판이 아니라 로컬 매트릭스(`scripts/ecosystem-matrix.mjs`)와 태스크 10 의 생태계 표다. 유도
 * (`deriveTestCommand`)는 이 함수를 부르지 않는다: 발견은 「무엇을 돌릴 수 있나」에 대한 **제안**
 * 이고 유도는 「무엇을 돌릴 것인가」에 대한 **결정**이라, 제안이 결정으로 조용히 승격되면 이
 * 러너가 사용자가 적지도 않은 명령을 사용자 권한으로 돌리게 된다.
 *
 * @returns `[{ ecosystem, evidence, suggestion }]` — `evidence` 는 그 판정을 세운 상대 경로들,
 *   `suggestion` 은 `{command, reporter, resultsPath}` 이거나 **null**(출력 자리가 결정적이지
 *   않은 둘). 절대 throw 하지 않고, 프로젝트 경로가 이상하면 빈 배열이다.
 */
export async function discoverTestEcosystems(projectPath) {
  if (typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath)) return [];
  const found = [];
  for (const entry of TEST_ECOSYSTEMS) {
    let evidence = null;
    try {
      evidence = await entry.detect(projectPath);
    } catch {
      evidence = null;
    }
    if (evidence === null) continue;
    found.push({ ecosystem: entry.ecosystem, evidence, suggestion: entry.suggestion });
  }
  return found;
}

// ── 테스트 명령 설정 파일의 정본 (WS5 스펙 §0 D3 · 종료 기준 EC-5) ─────────
//
// ★ 자리의 이유: 정본은 **계산**되고 그 원천이 둘 다 위에 있다 — 유도의 고정 표
//   (`CONFIG_COMMAND_EXTRAS`)와 발견의 러너 설정 표(`RUNNER_COMMAND_CONFIGS`). 둘 다 이 파일이
//   짓는다. 처음 판은 앞의 표 하나만 보고 태어났고 그래서 뒤의 표를 통째로 빠뜨렸다(T3 리뷰 I2).

/** 사람·설정 경로 비교용 접기. 실제 Git 경로는 `patch-scope.mjs` 의 `segmentsOf` 가 `\\` 를 이름으로 보존한다. */
const foldPath = (value) => value.replace(/\\/g, '/').toLowerCase();

/** 접은 경로의 마지막 세그먼트. `.config/nextest.toml` 은 어느 깊이에 있어도 `nextest.toml` 이다. */
const foldedName = (value) => foldPath(value).split('/').filter((segment) => segment !== '').at(-1) ?? '';

/**
 * ★★ 정본이면서 **표지이기도** 한 부분집합 — 러너 설정 이름들. `src/patch-scope.mjs` 가 이것을
 *   하드 등급 표지로 받는다(D1/D1a: 테스트 명령 설정은 하드 코어이고 승격되지 않는다).
 *
 * 두 축은 원래 직교한다(정본 = 허용목록이 못 부르는 경로 / 표지 = 플래그되는 경로). 유도의 입력
 * 다수는 정본이되 표지가 아니다 — `Makefile`·`conftest.py` 를 표지로 두면 「빌드·테스트가 실행하는
 * 코드」 전부와 구분할 수 없어 거의 모든 작업이 disputed 가 된다(그 판단은 `patch-scope` 의
 * [[잔여 위험]]). 러너 설정 대부분은 그 부류가 아니다: `jest.config.ts`·`build.gradle`·`pom.xml`·
 * `gradlew`·`.config/nextest.toml` 은 소스가 아니라 **그 실행의 설정**이고, 후보가 그것을 고쳐야
 * 할 정당한 이유는 「무엇이 테스트로 도는지를 바꾼다」뿐이다. 그래서 이것만 두 축에 동시에 든다.
 *
 * ⚠ **`vite.config.*` 넷은 이 문장이 참이 아닌 채로 여기 든다(T3 재심 N1, 조정자 채택 — KEEP).**
 *   `vite.config.ts` 는 빌드 도구 설정이라 alias·plugin·build target·dev server 때문에 후보가
 *   **정당하게 계속 고치는 파일**이다. vitest 는 `vitest.config.*` 가 없을 때만 `vite.config.*` 를
 *   설정으로 fallback 하므로(발견이 vitest 증거로 그 이름을 읽는 것도 이 fallback 때문) — 그런데
 *   이 파일(발견)도 `patch-scope`(범위 판정)도 패치 한 장만 보고는 그 프로젝트가 vitest 를 쓰는지
 *   **알 방법이 없다**(context-free). vitest 를 쓰는 프로젝트에서 vite.config 를 열어 두면 이
 *   관문을 정확히 그 파일로 우회할 수 있으므로, 안전한 쪽(하드)을 택했다. **비용**: 순수 Vite
 *   프로젝트(vitest 미사용)에서는 평범한 프런트엔드 작업 하나가 지울 수 없는 disputed 가 된다 —
 *   `package.json` 이 이미 기록한 것과 같은 실패 모양이고(`inspectPackageScripts` 의 WHY에 적힌
 *   「거의 모든 JS 작업이 disputed」), 반경만 작다.
 *
 * ⚠ 글롭이 아니라 **열거**인 이유: 발견이 여는 이름이 그 열거다. 정본을 `jest.config.*` 로 넓히면
 *   정본이 발견보다 커져서 「발견이 읽는 것 전부」라는 위 문장이 다시 거짓이 된다. 발견이
 *   `jest.config.mts` 를 읽게 되는 날 그 이름은 위 표에 늘고 정본·표지는 같은 커밋에서 함께 자란다.
 */
export const TEST_RUNNER_CONFIG_NAMES = Object.freeze([...new Set(RUNNER_COMMAND_CONFIGS.map(foldedName))].sort());

/**
 * 두 표에서 **정본을 계산한다**. 손으로 적지 않는 것이 요점이다 — 유도나 발견이 파일 하나를 더
 * 읽게 되는 날 그 줄은 위 표에 늘고, 이 정본은 같은 커밋에서 함께 자란다.
 */
function testCommandConfigInputs(entries, runnerNames) {
  const names = new Set([foldPath(PROJECT_CONFIG_FILE), ...runnerNames]);
  const suffixes = new Set();
  const directories = new Set();
  for (const entry of entries) {
    if (entry.kind !== 'dir-digests') { names.add(foldPath(entry.file)); continue; }
    if (typeof entry.suffix === 'string') suffixes.add(foldPath(entry.suffix));
    else directories.add(foldPath(entry.file));
  }
  const sorted = (set) => Object.freeze([...set].sort());
  return Object.freeze({ names: sorted(names), suffixes: sorted(suffixes), directories: sorted(directories) });
}

/**
 * ★★ **테스트 명령 설정 파일 경로의 정본** (WS5 스펙 §0 D3, 종료 기준 EC-5).
 *   `src/patch-scope.mjs` 가 이것을 **수입한다**.
 *
 * 무엇이 드는가 — 이 파일이 「무엇이 테스트로 도는가」를 판정하려고 읽는 것 **전부**다. 원천은
 * 손 목록이 아니라 위의 표 둘이고, 그래서 이 문장은 계산으로 참이 된다:
 *
 *   (1) 유도가 고정하는 입력 — `CONFIG_COMMAND_EXTRAS` + 주 정의 `.bom-orch.json`.
 *       무엇을 돌릴지를 **정하는** 파일들이다(`tests.command`·`scripts.test`·`Makefile` 타깃 …).
 *   (2) 발견이 읽는 러너 설정 — `RUNNER_COMMAND_CONFIGS`(jest·vitest/vite·nextest·gradle·maven).
 *       발견 자체는 제안이지만 이 파일들은 **이미 유도된** 명령이 무엇을 실행할지를 정한다.
 *
 * ⚠ 정본 **밖**인 것도 계산의 결과다: 발견이 읽는 `go.mod`·`Cargo.toml` 은 짝이 되는 lockfile 이
 *   `allowable` 이라 여기 넣으면 이 WS 의 종료 기준이 깨진다 — 그 이유(와 `Cargo.toml` 에는 안
 *   서는 「둘 다 명령을 정하지 않는다」는 절의 정정, T3 재심 N3)는 `RUNNER_COMMAND_CONFIGS`
 *   머리말이고, 그 제외는 산문이 아니라 `test/test-discovery.test.mjs` 의 소스 스크레이프가
 *   지키는 표다.
 *
 * 왜 저쪽이 아니라 여기인가: 그 목록은 유도·발견의 입력이고, 그 입력을 정의하는 것은 이 파일이다.
 * 저쪽에 손으로 베껴 두면 표가 하나 늘어난 날 조용히 낡는다 — `SCOPE_RULES` ↔
 * `src/content-projection.mjs` 가 이미 그 형태이고 그 WHY 는 같다(`patch-scope.mjs` 의 `SCOPE_RULES`).
 * 방향(`patch-scope` → 여기)의 비순환은 `test/guards/module-directions.test.mjs` 가 잰다.
 *
 * ⚠ **이 목록 전부가 플래그 목록인 것은 아니다.** `patch-scope` 는 `Makefile`·`conftest.py`·
 *   `pyproject.toml` 을 오늘도 플래그하지 않는다(그 이유는 그 파일의 [[잔여 위험]]: 빌드·테스트가
 *   실행하는 코드는 소스와 구분할 방법이 없고, 넣으면 거의 모든 작업이 disputed 가 된다). 표지로도
 *   서는 부분집합은 위 `TEST_RUNNER_CONFIG_NAMES` 하나뿐이다. 이 목록이 정하는 주된 축은 다른
 *   것이다: **허용목록이 이름 부를 수 없는 경로**(D1a 의 하드 코어) — 종료 기준의 문장은
 *   「허용목록에 들 수 없다」이지 「플래그된다」가 아니고, 유도의 입력 중 다수는 오늘 플래그되지
 *   않은 채로 실행을 정한다(메모 §A.7(c)).
 *
 * 세 모양인 이유: 고정 표가 세 모양이다. 이름(`file-digest`·`npm-script`·러너 설정), 루트 확장자
 * (`dir-digests` + `suffix` — `dotnet test` 가 cwd 에서 프로젝트를 고른다), 디렉터리
 * (`node_modules/.bin` — 설정 **파일**은 아니지만 스크립트의 이름이 어느 실행 파일로 풀릴지를
 * 정하고, `node --run` 도 `npm run` 도 그것을 PATH 앞에 붙인다).
 */
export const TEST_COMMAND_CONFIG_INPUTS = testCommandConfigInputs(CONFIG_COMMAND_EXTRAS, TEST_RUNNER_CONFIG_NAMES);

/**
 * 이 경로가 테스트 명령 설정인가 — 위 정본에 대한 **순수 술어**. 던지지 않고, 문자열이 아니면 거짓.
 *
 * ★ 깊이를 접는다(마지막 세그먼트로 본다). 유도 자신은 루트만 읽지만, 이 술어를 쓰는 자리는
 *   「허용목록이 이 경로를 이름 부를 수 있나」이고 거기서는 `packages/ui/Makefile` 도 루트의 것과
 *   같은 힘이다 — `patch-scope` 의 파일명 규칙이 중첩을 보는 이유(`:137-138`)와 같다. 과잉 일치의
 *   비용은 「허용목록에 못 적는다」뿐이고, 미탐의 비용은 실행을 정하는 파일이 허용목록을 통과하는
 *   것이다. 러너 설정도 같다: `.config/nextest.toml` 은 이름 `nextest.toml` 로 접혀 어느 크레이트
 *   아래에서도 걸린다.
 * ★ 글롭도 그대로 태울 수 있다: `**​/Makefile` 의 마지막 세그먼트는 `Makefile` 이고 `*.csproj` 는
 *   접미사로 걸린다. 반대로 `docs/**` 는 걸리지 않는다 — 무엇을 덮는지는 글롭 매처(T2)가 안다.
 */
export function isTestCommandConfigPath(path) {
  if (typeof path !== 'string' || path === '') return false;
  const segments = foldPath(path).split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1];
  if (TEST_COMMAND_CONFIG_INPUTS.names.includes(last)) return true;
  if (TEST_COMMAND_CONFIG_INPUTS.suffixes.some((suffix) => last.endsWith(suffix))) return true;
  // 디렉터리는 **연속한 세그먼트**로 본다. 그 자리 자체(`node_modules/.bin`)도, 그 아래 항목도 같다.
  return TEST_COMMAND_CONFIG_INPUTS.directories.some((directory) => {
    const parts = directory.split('/');
    return segments.some((_, at) => parts.every((part, index) => segments[at + index] === part));
  });
}

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
    // 문장이 아니라 **어느 도구를 못 찾았나** 하나만 나른다(문구는 `src/reason-text.mjs` 정본).
    unresolvedTool: 'npm',
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
    unresolvedTool: command ? null : label,
    definition,
  };
}

/**
 * 프로젝트 설정(`.bom-orch.json`)이 명령을 직접 적었으면 그 항목. 설정이 없거나
 * `tests.command` 가 없으면 null, 설정을 못 읽었으면 **blocked 봉투**다.
 *
 * ★ 태스크 4 는 여기서 「아직 소비되지 않는 키」 알림 하나를 냈다. WS4a 태스크 7 이 그 넷을
 *   전부 소비하면서(`reporter` 는 어댑터를, `resultsPath`·`timeoutMs`·`cwd` 는 얼어붙은 계획의
 *   사설 런타임을 통해 실행을 정한다 — `resultsPath` 는 **`junit-xml` 갈래에서만** 읽히고,
 *   최종 수정 파동이 스키마의 `dotnet-trx` 요구를 걷어 그 갈래의 「적어야 하는데 아무도 안
 *   읽는」 키를 없앴다) 그 알림은 생산자를 잃었고, 문구도 함께 걷었다 —
 *   생산자 없는 문구는 다음 사람에게 「이 키는 안 걸린다」는 거짓을 말한다. 같은 이유로 수정
 *   라운드가 `readProjectConfig` 의 `declaredTestKeys` 도 걷었다 — 그 알림이 유일한 독자였고,
 *   읽는 사람 없는 값은 다음 사람에게 「누군가 이것을 본다」는 거짓을 말한다.
 *
 * ★ 읽어 낸 설정 자체도 `derivation.config` 로 올려 둔다. 명령을 정하는 것 말고도 이 설정을
 *   소비하는 곳이 생겼기 때문이다 — `tests.provisionDeps`(WS4a 태스크 5)는 **엔진**이 워크트리를
 *   만든 뒤에 읽는다. 그 소비자를 위해 설정을 한 번 더 읽게 하면 같은 커밋에 대한 git 왕복이
 *   두 벌이 되고, 무엇보다 「이 실행이 읽은 설정」이 두 개가 된다. 읽기는 여기 한 번뿐이고,
 *   그 값이 얼어붙은 계획의 사설 런타임을 타고 엔진으로 간다(`frozenTestPlanConfig`).
 *
 * ★ 읽는 곳은 `deps.projectConfigCommit` 이 가리키는 **커밋 오브젝트**뿐이다
 *   (`src/project-config.mjs`). 이 인자가 없으면 이 함수는 아무것도 하지 않는다 —
 *   설정을 도입하기 전의 동작이 그대로 유지되고, 그 사실이 테스트로 고정돼 있다.
 * ★ 고정값(`definition.value`)은 **커밋된 바이트**다. 러너는 스폰 직전에 워크트리의 같은
 *   파일을 읽어 이 값과 대조하므로(`verifyDefinition`), 델리게이트가 워크트리의 설정을
 *   고친 실행은 `scripts.test` 를 고친 실행과 **같은 자리에서 같은 코드로** 거부된다.
 *   워크트리 사본을 여는 것은 그 대조 하나뿐이고, 무엇을 돌릴지는 절대 그 사본이 정하지 않는다.
 */
async function projectConfigEntry(projectPath, deps, resolveTool, derivation) {
  const commit = deps.projectConfigCommit;
  if (typeof commit !== 'string' || commit === '') return null;
  const read = await (deps.readProjectConfig ?? readProjectConfig)({ commit, cwd: projectPath }, deps);
  if (read.ok !== true) return read;
  // baseline 설정 자체를 올린다. `tests.command` 를 안 적은 설정도 여기까지는 온전히 읽혔고,
  // `provisionDeps` 만 적은 설정이 바로 그 모양이다 — 명령 유무보다 앞이어야 하는 이유가 같다.
  derivation.config = read.config ?? null;
  const argv = read.config?.tests?.command;
  if (!Array.isArray(argv) || argv.length === 0) return null;
  return toolEntry({
    source: PROJECT_CONFIG_FILE,
    tool: argv[0],
    args: argv.slice(1),
    resolveTool,
    definition: {
      file: PROJECT_CONFIG_FILE,
      kind: 'file-text',
      key: PROJECT_CONFIG_FILE,
      value: normalizeEol(read.text),
      // ★ 주 정의(설정 파일의 커밋된 바이트)는 **우리가** 읽는 것이고, `extras` 는 선언된
      //   명령이 스폰 때 **워크트리에서** 읽는 것이다. 왜 넷의 합집합인지는 그 상수의 WHY 에.
      extras: await pinExtras(projectPath, CONFIG_COMMAND_EXTRAS),
    },
  });
}

/**
 * 테스트 명령을 유도한다. **사용자 프로젝트에서만** 유도한다 — 워크트리에서 다시 유도하면
 * 이 모듈의 존재 이유가 사라진다(맨 위 주석).
 *
 * 순서: `.bom-orch.json` 의 `tests.command`(baseline 커밋에서만 읽는다) -> `package.json` 의
 * `scripts.test` -> 루트의 `*.csproj` -> `Makefile` 의 `test` 타깃 -> `pytest.ini`/
 * `pyproject.toml`. 못 찾으면 **null** — 추측하지 않는다.
 *
 * ⚠ `*.csproj` 는 **루트만** 본다. 솔루션 파일이나 하위 디렉터리의 프로젝트는 다루지 않고,
 *   루트에 둘 이상 있으면 어느 것인지 모르므로 고르지 않는다. 추측해서 엉뚱한 프로젝트를
 *   돌리느니 다음 후보로 넘어가거나 null 을 내는 편이 낫다.
 *
 * @param derivation 파생 **부산물**을 받아 갈 상자(`{notices, config}`). 안 주면 이 함수가
 *   하나 만들어 쓰고 버린다 — 알림만 필요한 호출부는 반환값의 `notices` 로 충분하다.
 *   `deriveFrozenTestPlan` 만 자기 것을 넘겨 `config` 까지 받아 간다.
 * @returns `{ source, command, args, launcher, exitCodeExact, unresolvedTool, definition, notices }` ·
 *   null · 또는 **blocked 봉투**(사용자가 쓴 설정을 읽지 못한 경우 — 그것은 "설정이 없다"
 *   와 다른 사실이라 null 로 접지 않는다). 결과를 그대로 `runTests` 에 펼쳐 넘기면 된다.
 *   `command` 가 null 이면 정의는 찾았지만 띄울 방법이 없다는 뜻이고 `unresolvedTool` 에
 *   사유가 있다. `definition` 은 `runTests` 가 워크트리와 대조할 고정값이고, 그 안의
 *   `extras` 가 같은 도구가 함께 읽는 입력들이다(위 §고정 대상 참조).
 *   `exitCodeExact` 는 "종료 코드를 스위트의 값으로 읽어도 되나"다 — `node --run` 경로만
 *   false 다(그 경로는 비0 종료 코드를 전부 1 로 접는다).
 *   `notices` 는 파생이 쌓은 문장이 **하나라도 있을 때만** 실린다(WS4a 태스크 4).
 */
export async function deriveTestCommand(projectPath, deps = {}, derivation = newDerivation()) {
  // 알림은 **파생의 산물**이지 명령의 일부가 아니다 — 그래서 안쪽은 오늘 그대로 항목을 내고,
  // 이 자리에서 한 번만 얹는다. 아무것도 유도하지 못한 실행(null)에는 얹을 자리가 없다.
  const derived = await deriveCommandEntry(projectPath, deps, derivation);
  if (derived === null || derivation.notices.length === 0 || derived.ok === false) return derived;
  return { ...derived, notices: derivation.notices };
}

/**
 * 파생의 부산물 상자. 계획 객체에는 실을 자리가 없는 둘(알림·baseline 설정)이 여기 모인다.
 *
 * ★ 실측(WS4a 태스크 7): **이 파일에는 `notices` 를 채우는 자리가 더 이상 없다.** 태스크 4 의
 *   「아직 소비되지 않는 키」알림이 유일한 생산자였고 그 넷이 소비되면서 사라졌다. 상자를
 *   남기는 이유는 채널이 이 파일의 것이 아니기 때문이다 — 지금의 생산자는 `adapterPlan`
 *   (`src/test-runner.mjs`)이고, 소비자는 엔진이다. 상자를 걷으면 그 배선을 다시 지어야 한다.
 */
function newDerivation() {
  return { notices: [], config: null };
}

async function deriveCommandEntry(projectPath, deps, derivation) {
  try {
    if (typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath)) return null;
    const resolveTool = deps.resolveTool ?? defaultResolveTool;
    const execPath = deps.execPath ?? process.execPath;

    // 프로젝트가 명령을 직접 적었으면 자동 발견을 하지 않는다(WS0 §5 의 우선순위).
    const configured = await projectConfigEntry(projectPath, deps, resolveTool, derivation);
    if (configured !== null) return configured;

    const script = await readNpmTestScript(projectPath);
    if (script !== null) {
      const launch = await npmScriptLaunch(execPath, deps);
      return {
        source: 'package.json',
        command: launch.command,
        args: launch.args,
        launcher: launch.launcher,
        exitCodeExact: launch.exitCodeExact,
        unresolvedTool: launch.unresolvedTool ?? null,
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
          // ★★ 위 `suffixPin` 과 같은 해시 입력이다 — 이 철자가 다이제스트에 들어간다.
          key: 'test target',
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
