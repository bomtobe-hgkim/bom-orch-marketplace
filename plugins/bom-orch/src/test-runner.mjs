import { lstat, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// ★ 「셸 없이 npm 을 띄우는 법」의 정본은 이제 `src/deps-provision.mjs` 다(WS4a 태스크 5).
//   러너의 npm 폴백과 의존성 제공기가 **같은 하나**를 알아야 한다 — 정본이 둘이면 한쪽만
//   배치(Windows/POSIX 두 갈래)를 배우는 날이 오고, 그 호스트에서 폴백이 통째로 죽는다.
//   재수출하는 이유는 이 이름의 기존 수입부(테스트 · 아래 한 호출부)를 한 자리로 유지하기
//   위해서다. 방향은 한쪽이다: test-runner → deps-provision, 반대는 없다.
import { findNpmCli } from './deps-provision.mjs';
import { buildChildEnv } from './providers/child-env.mjs';
import { canonical } from './real-path.mjs';
// ★ 테스트 명령의 유도와 고정 항목 읽기는 `src/test-discovery.mjs` 다(WS4a 태스크 6).
//   대조가 유도와 **같은 함수**를 써야 정상 워크트리가 위조로 잡히지 않으므로, 되읽는 넷도
//   저쪽에서 온다. 방향은 한쪽이다: test-runner → test-discovery.
import {
  PYTEST_BOOTSTRAP,
  PYTEST_ENV,
  contentDigest,
  defaultResolveTool,
  deriveTestCommand,
  extractIniSection,
  newDerivation,
  readDefinitionValue,
  readPinValue,
} from './test-discovery.mjs';
// ★ 증거 파서·어댑터·소유 이벤트 파일의 정본은 `src/test-evidence.mjs` 다(WS4a 태스크 6).
//   방향은 한쪽이다: test-runner → test-evidence. 그쪽은 이 파일을 수입하지 않는다 — 계획을
//   만들고 자식을 띄우는 것은 여기고, 그 자식이 남긴 바이트를 읽는 것은 저쪽이다.
import {
  ADAPTER_EVIDENCE_POLICY,
  DEFAULT_JUNIT_WITNESS_POLICY,
  DEFAULT_NODE_WITNESS_POLICY,
  DEFAULT_PYTEST_WITNESS_POLICY,
  MISSING_DEP_SIGNS,
  SHA256_PATTERN,
  UNOWNED_JUNIT_WITNESS_POLICY,
  cleanupOwnedEvidence,
  createOwnedEventFile,
  eventFileUnchanged,
  insertNodeReporter,
  pathUnderRoot,
  persistableRecord,
  prepareDeclaredResults,
  readDeclaredResults,
  readOwnedEvidence,
  resolveTestAssetUrl,
  safeRelativeSourcePath,
} from './test-evidence.mjs';
// ★ 자식을 띄우고 그 출력을 상한 안에서 모으는 기계는 `src/test-spawn.mjs` 다(WS4a 태스크 6).
//   방향은 한쪽이다: test-runner → test-spawn. 저쪽은 무엇을 돌릴지 모른다 — 이 파일이 고정값을
//   대조하고 환경을 짓고 나서야 검증된 넷을 넘긴다.
import { DEFAULT_TIMEOUT_MS, WINDOWS, spawnAndCollect } from './test-spawn.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { hashJson, sha256 } from './util/hash.mjs';
import { hasExactKeys } from './util/objects.mjs';
import { clipCounted, compareUtf8 } from './util/strings.mjs';
import { REASON } from './reason-codes.mjs';
import { fail, renderNotice } from './reason-text.mjs';
import { errorText } from './util/errors.mjs';

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
 *
 * ## 나간 것과 남은 것 (WS4a 태스크 6, 실측)
 *
 * 세 잎으로 나갔다: 명령 유도와 고정 항목 읽기는 `src/test-discovery.mjs`(944), 자식을 띄우고
 * 출력을 상한 안에서 모으는 기계는 `src/test-spawn.mjs`(352), 어댑터 증거의 파서·분류기는
 * `src/test-evidence.mjs`(1,068 — 그 아래 `src/xml-subset.mjs`(254)가 한 겹 더 있다)다. 여기 남은 것은 **계획**(policy v2 의 동결·지문·실행 파일과
 * 런처의 재검증)과 **거부**(스폰 직전의 고정값 대조)와 그 둘을 잇는 실행 하나다 — 2,698 → 1,274
 * (태스크 6 이 1,069 에 착지시킨 뒤 태스크 7·그 수정 라운드·최종 수정 파동이 설정 소비와 이음매 셋을 더했다).
 *
 * ## 프로젝트 설정 네 키의 소비 (WS4a 태스크 7)
 *
 * `.bom-orch.json` 의 `tests.reporter`·`resultsPath`·`timeoutMs`·`cwd` 를 **여기서** 소비한다.
 * 넷 중 `reporter` 하나만 계획 객체에 닿고(`adapterId` 는 `planFingerprint` 의 입력이다 — 다른
 * 어댑터는 다른 계획이다), 나머지 셋은 얼어붙은 계획의 **사설 런타임**(`baselineConfig`)을 타고
 * `runFrozenTests` 로 간다. 계획 객체에 실을 수 없는 이유는 알림과 같다: 키 집합이 정확히
 * `PLAN_KEYS` 여야 하고 그중 지문 말고는 전부 지문의 입력이라, 상한 한 줄이 지문을 바꾸면
 * 재개의 계획 관문이 같은 프로젝트를 다른 계획이라고 말한다.
 *
 * ★ 실측 폐포: **28개 모듈 / 12,062줄**(자기 자신 1,274 포함). 세 잎 중 어느 것도 이 파일을
 *   수입하지 않고, 저장소 모듈(`run-*`)도 `engine` 도 없다 — 방향은 한쪽이다(WS5 T3 이 정본 export 로 `test-discovery` 를 73줄, 그 수정 파도가 다시 66줄 늘렸고, 받는 쪽이 `patch-scope` 라 모듈 수는 그대로다). T3 재심 N1–N3 수정 파도: `test-discovery` 가 다시 25줄 늘어 9,979 -> 10,004(모듈 수는 그대로 — 늘어난 것은 주석뿐이다).
 */

/** 정본은 `src/deps-provision.mjs` 다(위 import 의 WHY). 이 이름의 수입부는 여기 그대로 둔다. */
export { findNpmCli };

// ── 워크트리 디렉터리 확인 ────────────────────────────────────────────────

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 워크트리 자신이거나 그 아래인가. `..` 한 조각이면 밖이다(`safeRelativeSourcePath` 와 같은 규율). */
function insideWorktree(worktree, path) {
  if (path === worktree) return true;
  const rel = relative(worktree, path);
  return rel !== '' && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

/**
 * 프로젝트가 선언한 실행 디렉터리(`tests.cwd`)를 워크트리 안의 절대 경로로 편다.
 *
 * 없거나 `.` 이면 워크트리 루트다. 밖을 가리키거나 **없는 디렉터리**면 null 이고, 그때 실행은
 * 스폰 전에 막힌다 — 사용자가 `packages/api` 라고 적었는데 루트에서 돌리면 그 실행의 증거는
 * 사용자가 물은 것과 다른 것에 대한 증거가 된다. 디렉터리를 만들어 주지도 않는다: 워크트리에
 * 우리가 쓰지 않은 자리를 짓는 것은 이 모듈의 일이 아니다.
 *
 * ★★ 글자만 보는 포함은 포함이 아니다. `insideWorktree` 는 `..` 조각을 잡지만 **중간 조각의
 *   심링크**는 못 본다 — `packages -> D:\elsewhere` 하나면 `packages/api` 는 글자로는 깨끗한
 *   상대 경로이고 `isDirectory` 는 심링크를 **따라가서** true 를 낸다. 그러면 자식이 워크트리
 *   밖에서 돌고, 그 실행의 증거는 우리가 격리했다고 말한 트리에 대한 증거가 아니다. 그래서
 *   양쪽을 `canonical` 로 편 뒤 같은 판정을 한 번 더 한다(`src/test-evidence.mjs` 의
 *   `insideCanonicalWorktree` 와 같은 규율이고, 이유도 같다).
 *
 * ★★ **루트를 가리키는 철자는 하나가 아니다.** 이른 반환이 `''`·`'.'` 만 알던 동안 `'./'` 는
 *   그 셋을 지나 `join(root, './')` 로 갔고, `join` 은 뒤 구분자를 남기므로 `insideWorktree` 의
 *   두 갈래가 **둘 다** 거짓이 됐다(경로 !== 워크트리, `relative()` === `''`) — 스키마가 받는
 *   값 하나가 그 프로젝트의 **모든** 테스트 실행을 죽였고, `'.'` 은 멀쩡히 도는 채였다. 그래서
 *   자리 정규화를 `resolve` 에 맡기고(`join` 과 달리 뒤 구분자를 걷는다) 「편 결과가 루트면
 *   루트다」를 한 줄로 말한다 — 철자를 열거하는 대신.
 */
async function resolveDeclaredCwd(worktreePath, declared, deps = {}) {
  if (declared === undefined || declared === null || declared === '' || declared === '.') return worktreePath;
  if (typeof declared !== 'string' || declared.includes('\\') || isAbsolute(declared)) return null;
  const path = resolve(worktreePath, declared);
  if (path === resolve(worktreePath)) return worktreePath;
  if (!insideWorktree(worktreePath, path) || !(await isDirectory(path))) return null;
  const canonicalize = deps.canonicalCwd ?? canonical;
  const root = await canonicalize(worktreePath);
  const real = await canonicalize(path);
  if (typeof root !== 'string' || typeof real !== 'string' || !insideWorktree(root, real) || root === real) return null;
  return path;
}

/**
 * 이 실행에 걸리는 상한. 프로젝트가 적은 값과 호출부가 넘긴 값 중 **작은 쪽**이 이긴다 —
 * 프로젝트의 선언이 실행의 남은 예산을 늘릴 수는 없고(그 예산은 마감이 정한다), 반대로 실행의
 * 여유가 프로젝트의 선언을 넘길 수도 없다(그러면 적어 둔 상한이 아무것도 아니게 된다).
 */
function boundedTestTimeout(...values) {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  return usable.length === 0 ? undefined : Math.min(...usable);
}

// ── 실행 ──────────────────────────────────────────────────────────────────

/**
 * 봉투에 실을 **명령 한 줄**의 상한. 자르는 것은 공용 `clipCounted` 다(사본이었던 `forMessage`
 * 는 WS2 가 걷었다 — 꼬리표가 영어로 바뀌고 비문자열은 `''` 이 된다. 여기 오는 값은
 * `scripts.test` 명령 문자열이라 두 갈래 모두 실제 입력에서는 같은 바이트를 낸다).
 * ★ 파일 본문에는 쓰지 마라. 아래 `textDigestSummary` 를 써라 — 왜인지는 그쪽 주석에 있다.
 */
const MESSAGE_COMMAND_CHARS = 400;

/**
 * 지문의 사람 읽을 요약. **내용은 절대 싣지 않는다** — 이 문자열은 봉투를 타고 MCP 결과로
 * 나가고, `.npmrc`·`nuget.config` 에는 인증 토큰이 들어간다(실측: 프로젝트의 토큰이 원문
 * 그대로 실렸다). 어느 항목이 어떻게 달라졌는지는 지문으로 충분히 말할 수 있다.
 */
function digestSummary(value) {
  if (!value || typeof value !== 'object') return 'absent';
  if (value.digest === 'symlink') return 'symlink';
  if (value.digest === 'directory') return 'directory';
  if (value.digest === 'unreadable') return 'unreadable';
  return `sha256:${value.digest.slice(0, 12)}… (${value.bytes} bytes, ${value.lines} lines)`;
}

/**
 * 문자열 하나의 지문 요약 (계획 2 이월 4).
 *
 * ★ 왜 필요한가 (실측, 커밋 c1f24cd 의 테스트가 재현한다): **주 정의**가 어긋났을 때
 *   봉투는 `clipCounted` 로 고정값과 현재값을 각각 앞 400자까지 원문으로 실었다. 그런데
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
 * 어긋남 하나의 **평평한** 기술. `project`·`worktree` 는 지문 요약이거나(파일 본문) 잘린 명령
 * 문자열이다(`npm-script` 한 갈래) — 어느 쪽도 파일 **내용**이 아니다: `.npmrc`·`nuget.config`
 * 에는 인증 토큰이 들어 있고, 그것이 봉투로 나간 실측이 이 규율의 출처다.
 */
function drifted(file, key, project, worktree) {
  return { reasonCode: REASON.test_pinned_definition_drift, drift: { file: file ?? '.', key, project, worktree } };
}

/**
 * 어긋남의 **문장 인자** — 이름 둘만 나간다.
 *
 * ★ `project`/`worktree` 는 값 쪽(지문 요약이거나 clip 된 명령)이라 문장에 넣지 않는다. 문장은
 *   사람이 고칠 자리를 가리키는 것이고, 그 자리는 「어느 파일의 어느 항목」이다.
 */
function driftParams({ drift }) {
  return { file: drift.file, key: drift.key };
}

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
 * ★ WS2 Task 15: 어긋남을 **문장**이 아니라 `{ reasonCode, drift }` 로 낸다. 문구는
 *   `src/reason-text.mjs` 가 정본이고, 여기서 나가는 것은 어느 파일이 어떻게 달라졌는지의
 *   **평평한 사실**뿐이다(불변식 4와 같은 규율 — 원문은 절대 싣지 않고 지문만 싣는다).
 *
 * @returns `{ reasonCode, drift }` 또는 `{ notes }`
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
        return drifted(entry.file ?? '.', name, digestSummary(pinned[name]), digestSummary(value));
      }
      continue;
    }

    if (entry.kind === 'file-digest') {
      const pinned = entry.value ?? null;
      if (current === null) {
        if (pinned === null) continue;
        if (entry.tracked === true) return drifted(entry.file, entry.key, digestSummary(pinned), 'absent');
        notes.push(renderNotice('test_file_absent_from_worktree', { path: entry.key }));
        continue;
      }
      if (sameDigest(pinned, current)) continue;
      return drifted(entry.file, entry.key, digestSummary(pinned), digestSummary(current));
    }

    // npm-script: scripts.test 명령의 실행 계약을 진단해야 하므로 이 좁은 예외만 원문을 싣는다.
    const pinned = entry.value ?? null;
    if (current === pinned) continue;
    const show = (value) => (value === null ? 'absent' : clipCounted(value, MESSAGE_COMMAND_CHARS));
    return drifted(entry.file, entry.key, show(pinned), show(current));
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
export const USER_PRIVILEGE_NOTE = renderNotice('test_ran_with_user_privileges', {});

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

  return renderNotice('test_command_bare_name_unresolved', { path: inRoot.join(' / '), token });
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
      return fail(REASON.evidence_worktree_invalid);
    }
    if (!(await isDirectory(worktree))) return fail(REASON.evidence_worktree_invalid);
    if (typeof command !== 'string' || command === '' || !isAbsolute(command)) {
      // ★ "도구를 못 찾았다"와 "경로가 상대다"는 원인도 사용자의 행동도 다르다.
      //   `deriveTestCommand` 는 전자를 이미 `unresolvedTool` 로 알려 준다 — 그것을 버리면
      //   봉투가 사용자가 이미 한 일을 시키는 막다른 길이 된다(make/python/dotnet 이 없는
      //   기계에서는 이것이 기본 경로다).
      const unresolvedTool = options.unresolvedTool;
      if (typeof unresolvedTool === 'string' && unresolvedTool !== '') {
        // ★ 어느 도구인지는 문장이 아니라 **평평한 필드**로 나른다.
        return fail(REASON.test_command_unavailable, {}, { unresolvedTool });
      }
      return fail(REASON.test_plan_invalid);
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return fail(REASON.test_plan_invalid);
    // ★ 다른 인자는 전부 검증하는데 signal 만 안 했다. `AbortController` 를 넘기는 흔한
    //   배선 실수에서 셋업이 던지고, 봉투가 나간 **뒤에** 자식의 'error' 가 uncaught 로
    //   프로세스를 죽였다(실측). 'error' 리스너를 먼저 붙여 그 죽음은 닫았지만, 잘못된
    //   인자를 스폰까지 끌고 갈 이유는 없다.
    if (signal !== undefined && signal !== null && typeof signal.addEventListener !== 'function') {
      return fail(REASON.test_abort_signal_invalid);
    }
    // ★★ 자식의 cwd 와 **고정값을 되읽는 자리**는 다른 값이다. `tests.cwd` 를 적은 프로젝트는
    //   하위 디렉터리에서 테스트를 돌리지만, 그 명령을 정의하는 파일(`package.json` ·
    //   `pytest.ini` · csproj)은 여전히 저장소 루트의 것이다 — 아래 대조는 그래서 `worktree` 를
    //   쓰고 스폰만 `spawnCwd` 를 쓴다. 둘을 하나로 뭉치면 하위 디렉터리 프로젝트의 고정 대조가
    //   통째로 「읽지 못했다」가 되어 정상 실행이 영구 거부된다.
    const spawnCwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : worktree;
    if (!isAbsolute(spawnCwd) || !insideWorktree(worktree, spawnCwd) || !(await isDirectory(spawnCwd))) {
      return fail(REASON.test_plan_invalid);
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
      return fail(REASON.test_plan_invalid, {}, { definitionCheck: 'missing' });
    }

    const current = await readDefinitionValue(worktree, definition);
    if (current === null) {
      const drift = drifted(definition.file, definition.key, textDigestSummary(definition.value), 'unreadable');
      return fail(drift.reasonCode, driftParams(drift), { definitionCheck: 'unreadable', drift: drift.drift });
    }
    if (current !== definition.value) {
      // ★ `npm-script` 만 원문을 싣는다 — scripts.test 실행 계약을 사람이 확인할 수 있게
      //   하는 좁은 예외다(`checkExtras` 의 같은 갈래와 같은 근거). 나머지 정의는 값이
      //   파일 본문 전체라 지문만 싣는다.
      const show = definition.kind === 'npm-script' ? (value) => clipCounted(value, MESSAGE_COMMAND_CHARS) : textDigestSummary;
      const drift = drifted(definition.file, definition.key, show(definition.value), show(current));
      return fail(drift.reasonCode, driftParams(drift), { definitionCheck: 'changed', drift: drift.drift });
    }

    // ── ★★ 같은 도구가 함께 읽는 입력들. 값이 null 인 항목은 "프로젝트에 없었다"가
    //    고정값이라, 워크트리에 새로 생기면 여기서 걸린다(위 §고정 대상 참조).
    const extras = await checkExtras(worktree, definition.extras);
    if (extras.reasonCode !== undefined) {
      return fail(extras.reasonCode, driftParams(extras), { definitionCheck: 'changed', drift: extras.drift });
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
      cwd: spawnCwd,
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
      notes.push(renderNotice('test_command_spawn_failed', { detail: errorText(run.spawnError) }));
    }
    if (run.timedOut || run.aborted || run.hung) confidence = 'unverified';

    // ★ 남은 프로세스는 사실로 알린다. 회수 경로가 없다(KILL_GRACE_MS 주석의 잔여 위험).
    if (run.lingering) notes.push(renderNotice('test_background_process_lingering', {}));
    if (run.hung) notes.push(renderNotice('test_output_pipe_unclosed', {}));

    // 우리가 cwd 를 탐색에서 뺐기 때문에 못 푼 명령은 "테스트 실패"가 아니다. 로케일
    // 문자열에 기대지 않는 결정적 판정이라 MISSING_DEP_SIGNS 와 달리 확실하다.
    if (passed === false && lookupWarning !== null) confidence = 'unverified';

    // 의존성 부재로 못 돌린 것을 "테스트 실패"로 보고하지 않는다. 이 프로젝트는 워크트리에
    // 의존성을 넣지 않는다(맨 위 주석) — 그 결정의 대가를 여기서 드러낸다.
    if (passed === false && MISSING_DEP_SIGNS.some((sign) => run.output.includes(sign))) {
      const hasNodeModules = source === 'package.json' ? await isDirectory(join(worktree, 'node_modules')) : true;
      if (source !== 'package.json' || !hasNodeModules) {
        confidence = 'unverified';
        notes.push(renderNotice(
          source === 'package.json' ? 'test_node_modules_absent' : 'test_dependencies_missing', {},
        ));
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
    // 던진 것을 버리지 않는다 — 이웃한 스폰 실패 알림과 같은 규율이다(평평한 `detail` 하나).
    return fail(REASON.test_frozen_execution_failed, { detail: errorText(error) });
  }
}

// ── Policy v2: immutable plans and trusted test evidence ──────────────────

const FROZEN_PLAN_RUNTIME = new WeakMap();
const TEST_MODES = new Set(['b0', 'br', 'c']);
const PLAN_KEYS = [
  'schemaVersion',
  'source',
  'adapterId',
  'executable',
  'argv',
  'cwdPolicy',
  'pinnedDefinitions',
  'planFingerprint',
  'environmentFingerprint',
  'regressionWitnessTrusted',
];

function currentNodeMajorMinor(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  return match ? `${match[1]}.${match[2]}` : 'unknown';
}

function environmentFacts(adapterId, executable, launchers = [], deps = {}) {
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    nodeMajorMinor: currentNodeMajorMinor(deps.nodeVersion ?? process.versions.node),
    adapterId,
    executable,
    launchers,
  };
}

function environmentFingerprint(adapterId, executable, launchers = [], deps = {}) {
  return hashJson(environmentFacts(adapterId, executable, launchers, deps));
}

function normalizedDefinitionPin(entry) {
  const value = entry?.value;
  return {
    kind: typeof entry?.kind === 'string' ? entry.kind : null,
    file: typeof entry?.file === 'string' ? entry.file : null,
    key: typeof entry?.key === 'string' ? entry.key : null,
    script: typeof entry?.script === 'string' ? entry.script : null,
    suffix: typeof entry?.suffix === 'string' ? entry.suffix : null,
    tracked: typeof entry?.tracked === 'boolean' ? entry.tracked : null,
    valueSha256: hashJson(value ?? null),
  };
}

function publicDefinitionPins(definition) {
  if (!definition || typeof definition !== 'object') return [];
  const entries = [definition, ...(Array.isArray(definition.extras) ? definition.extras : [])];
  const grouped = new Map();
  for (const entry of entries) {
    const path = typeof entry?.file === 'string' && entry.file !== '' && !isAbsolute(entry.file)
      ? entry.file.replaceAll('\\', '/')
      : null;
    if (path === null || path.includes('\0') || path.split('/').some((part) => part === '..')) continue;
    const current = grouped.get(path) ?? [];
    current.push(normalizedDefinitionPin(entry));
    grouped.set(path, current);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => compareUtf8(a, b))
    .map(([path, values]) => ({ path, sha256: hashJson(values) }));
}

function tokenizeLiteralNodeScript(script) {
  if (typeof script !== 'string' || script === '' || script.length > 8_192 ||
      /[\r\n\t'"\\$%!*?\[\]{}()~^;&|><`#]/.test(script)) return null;
  const trimmed = script.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.split(/ +/);
  if (tokens.some((token) => token === '' || !/^[A-Za-z0-9._/@+=,:-]+$/.test(token))) return null;
  if (tokens.length < 2 || !/^(?:node|node\.exe)$/i.test(tokens[0])) return null;
  const args = tokens.slice(1);
  if (args.filter((arg) => arg === '--test').length !== 1) return null;
  if (args.some((arg) =>
    arg.startsWith('--test-reporter') || arg.startsWith('--test-reporter-destination') ||
    isAbsolute(arg) || /^[A-Za-z]:/.test(arg)
  )) return null;
  return args;
}

function validWitnessRoot(value) {
  if (typeof value !== 'string' || value === '' || value.length > 512 || value.includes('\0') || value.includes('\\') ||
      isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[*?\[\]{}]/.test(value)) return null;
  const normalized = value.replace(/^\.\//, '').replace(/\/$/, '').normalize('NFC');
  const parts = normalized.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..') ? null : parts.join('/');
}

function pytestWitnessPolicy(source, definitionValue) {
  let text = String(definitionValue ?? '');
  if (source === 'pytest.ini') {
    const section = extractIniSection(text, '[pytest]');
    if (section === null || /^\s*\[pytest\]\s*$/gm.test(text) === false ||
        (text.match(/^\s*\[pytest\]\s*$/gm) ?? []).length !== 1) {
      return deepFreeze({ kind: 'pytest', trusted: false, roots: [] });
    }
    text = section;
  }
  const matches = [...text.matchAll(/^\s*testpaths\s*=\s*(.*?)\s*$/gm)];
  if (matches.length === 0) return DEFAULT_PYTEST_WITNESS_POLICY;
  if (matches.length !== 1 || matches[0][1] === '') return deepFreeze({ kind: 'pytest', trusted: false, roots: [] });
  let values;
  if (source === 'pytest.ini') {
    if (/['",#;]/.test(matches[0][1])) return deepFreeze({ kind: 'pytest', trusted: false, roots: [] });
    values = matches[0][1].split(/\s+/);
  } else {
    const input = matches[0][1];
    if (!/^\[(?:\s*"[^"\\\r\n]+"\s*(?:,\s*"[^"\\\r\n]+"\s*)*)?\]$/.test(input)) {
      return deepFreeze({ kind: 'pytest', trusted: false, roots: [] });
    }
    try {
      values = JSON.parse(input);
    } catch {
      return deepFreeze({ kind: 'pytest', trusted: false, roots: [] });
    }
  }
  const roots = values.map(validWitnessRoot);
  if (roots.length === 0 || roots.some((root) => root === null) || new Set(roots).size !== roots.length) {
    return deepFreeze({ kind: 'pytest', trusted: false, roots: [] });
  }
  return deepFreeze({ kind: 'pytest', trusted: true, roots: roots.sort() });
}

function launcherToken(identity) {
  return hashJson({ kind: 'controller-launcher-v1', executable: identity.public });
}

async function freezeControllerArgv(derived, deps = {}) {
  const argv = [];
  const launchers = [];
  for (let index = 0; index < derived.args.length; index += 1) {
    const arg = derived.args[index];
    if (!isAbsolute(arg)) {
      argv.push(arg);
      continue;
    }
    const kind = derived.source === 'package.json' && derived.launcher === 'npm-cli.js' && index === 0
      ? 'npm-cli.js'
      : null;
    const identity = kind === null ? null : await executableIdentity(arg, deps);
    if (identity === null) {
      argv.push(`<controller-launcher:${sha256(Buffer.from(`unavailable\0${basename(arg)}`, 'utf8'))}>`);
      continue;
    }
    const token = launcherToken(identity);
    const placeholder = `<controller-launcher:${token}>`;
    argv.push(placeholder);
    launchers.push({ index, kind, placeholder, token, path: identity.path, executable: identity.public });
  }
  return { argv, launchers };
}

/**
 * `tests.reporter` -> the adapter that run REQUIRES (WS4a 태스크 7, 결정 6). 스키마의 enum 이
 * 정본이고 이 표는 그것을 어댑터 이름으로 옮기는 자리다. `none` 이 `null` 로 가는 것은 값이
 * 없어서가 아니라 **자동 판정을 끄는 것이 사용자가 고른 것**이기 때문이다.
 */
const CONFIG_REPORTER_ADAPTERS = new Map([
  ['junit-xml', 'junit-xml-v1'],
  ['node-events', 'node-events-v1'],
  ['pytest-events', 'pytest-events-v1'],
  ['dotnet-trx', 'dotnet-trx-v1'],
  ['none', null],
]);

function declaredReporter(config) {
  const reporter = config?.tests?.reporter;
  return typeof reporter === 'string' && CONFIG_REPORTER_ADAPTERS.has(reporter) ? reporter : null;
}

/**
 * 리포터를 **주입하지 않는** argv. 컨트롤러가 인자를 더하지 않는 두 경우가 같은 모양을 쓴다:
 * 알아보지 못한 명령과, 프로젝트가 스스로 JUnit XML 을 내는 경우(`junit-xml` 은 우리가 인자를
 * 더할 수 없다 — nextest·Gradle 은 CLI 플래그가 아예 없고, 그래서 스키마가 `resultsPath` 를
 * 필수로 걸었다).
 */
async function uninstrumentedArgv(derived, deps) {
  return derived.source === 'package.json'
    ? freezeControllerArgv(derived, deps)
    : { argv: [...derived.args], launchers: [] };
}

const noAdapter = (frozen) => ({
  adapterId: null,
  argv: frozen.argv,
  regressionWitnessTrusted: false,
  launchers: frozen.launchers,
  witnessPolicy: null,
});

/**
 * 어느 어댑터로 이 명령을 돌릴 것인가. **선언이 자동 판정을 이긴다** — 사용자가 `reporter` 를
 * 적었다면 그것이 이 실행이 요구하는 증거다.
 *
 * ★ 셋(`node-events`·`pytest-events`·`dotnet-trx`)은 컨트롤러가 인자를 **주입해서** 만든다.
 *   유도된 명령이 그것을 낼 수 없으면(pytest 프로젝트에 `node-events` 를 적은 경우) 우리는
 *   그 요구를 들어줄 수 없다. 그때 다른 어댑터로 조용히 대체하면 사용자가 고르지 않은 증거가
 *   그 이름으로 나가므로, 어댑터를 **끄고** 알림 한 줄로 무엇이 왜 안 걸렸는지 말한다.
 */
async function adapterPlan(derived, deps = {}, derivation = null) {
  if (derived === null) return { adapterId: null, argv: [], regressionWitnessTrusted: false, launchers: [], witnessPolicy: null };
  const reporter = declaredReporter(derivation?.config ?? null);
  if (reporter === 'junit-xml') {
    const frozen = await uninstrumentedArgv(derived, deps);
    return {
      adapterId: 'junit-xml-v1',
      argv: frozen.argv,
      // ★★ 실측으로 거짓이 되지 않는 값을 고른다. 이 어댑터는 등급 A·B 에서 진짜 소스 결속
      //   증인을 내지만, `REGRESSION_WITNESS_ADAPTERS`(`src/regression-proof.mjs`)는
      //   `node-events-v1`·`pytest-events-v1` 둘뿐이라 그 증인이 회귀 증명에 **쓰이지 않는다**.
      //   ★ 태스크 11 이 이 값을 켜 보고 되돌렸다: 목록을 넓히고 여기를 true 로 해도 분리는
      //     여전히 멈춘다(`classifyFrozenTestPath` 에 junit 갈래가 없어 전부 helper — 그쪽 WHY).
      //     지킬 수 없는 약속을 계획이 공시하지 않는 것이 이 false 의 뜻이다.
      regressionWitnessTrusted: false,
      launchers: frozen.launchers,
      witnessPolicy: DEFAULT_JUNIT_WITNESS_POLICY,
    };
  }
  if (reporter === 'none') return noAdapter(await uninstrumentedArgv(derived, deps));
  const automatic = await automaticAdapterPlan(derived, deps);
  if (reporter === null || CONFIG_REPORTER_ADAPTERS.get(reporter) === automatic.adapterId) return automatic;
  derivation?.notices.push(renderNotice('project_config_reporter_unavailable', { reporter }));
  return noAdapter(await uninstrumentedArgv(derived, deps));
}

async function automaticAdapterPlan(derived, deps = {}) {
  if (derived.source === 'package.json') {
    const args = tokenizeLiteralNodeScript(derived.definition?.value);
    if (args !== null && derived.command === process.execPath) {
      return {
        adapterId: 'node-events-v1',
        argv: args,
        regressionWitnessTrusted: true,
        launchers: [],
        witnessPolicy: DEFAULT_NODE_WITNESS_POLICY,
      };
    }
    return noAdapter(await freezeControllerArgv(derived, deps));
  }
  if (derived.source === 'pytest.ini' || derived.source === 'pyproject.toml') {
    const witnessPolicy = pytestWitnessPolicy(derived.source, derived.definition?.value);
    return {
      adapterId: 'pytest-events-v1',
      argv: ['-c', PYTEST_BOOTSTRAP, '-p', 'pytest_events', '--bom-orch-events', '<controller-owned>'],
      regressionWitnessTrusted: witnessPolicy.trusted,
      launchers: [],
      witnessPolicy,
    };
  }
  if (derived.source === 'csproj') {
    return {
      adapterId: 'dotnet-trx-v1',
      argv: [...derived.args, '--logger', 'trx;LogFileName=<controller-owned>'],
      regressionWitnessTrusted: false,
      launchers: [],
      witnessPolicy: null,
    };
  }
  return noAdapter({ argv: [...derived.args], launchers: [] });
}

function resolveExecutableAgain(path, deps = {}) {
  const injected = deps.resolveExecutable;
  if (typeof injected === 'function') return injected(basename(path));
  if (path === process.execPath) return process.execPath;
  const name = basename(path).replace(/\.(?:exe|com)$/i, '');
  return defaultResolveTool(name);
}

async function executableIdentity(path, deps = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    const inspectLink = deps.lstatExecutable ?? lstat;
    const inspectFile = deps.statExecutable ?? stat;
    const link = await inspectLink(path);
    if (link.isSymbolicLink() || !link.isFile()) return null;
    const info = await inspectFile(path);
    if (!info.isFile()) return null;
    const real = await canonical(path);
    if (real === null) return null;
    return {
      path: real,
      public: { basename: basename(real), size: info.size, mtimeMs: info.mtimeMs },
    };
  } catch {
    return null;
  }
}

function exactPlanWithoutFingerprint(input) {
  return {
    schemaVersion: 1,
    source: input.source,
    adapterId: input.adapterId,
    executable: input.executable,
    argv: input.argv,
    cwdPolicy: 'evidence-worktree',
    pinnedDefinitions: input.pinnedDefinitions,
    environmentFingerprint: input.environmentFingerprint,
    regressionWitnessTrusted: input.regressionWitnessTrusted,
  };
}

/** Freeze the legacy-derived command as a whitelist-only, fingerprinted policy-v2 plan. */
export async function deriveFrozenTestPlan(projectPath, deps = {}) {
  const derivation = newDerivation();
  const derived = await deriveTestCommand(projectPath, deps, derivation);
  // 사용자가 쓴 설정을 읽지 못한 실행은 계획을 만들지 않는다 — 엔진의 `isBlocked` 가 이
  // 모양을 그대로 읽어 크레딧을 쓰기 전에 닫는다(`src/engine.mjs` 의 frozen test plan 단계).
  if (derived !== null && derived.blocked === true) return derived;
  const recognized = await adapterPlan(derived, deps, derivation);
  const identity = derived?.command ? await executableIdentity(derived.command, deps) : null;
  const executable = identity?.public ?? null;
  const launcherFacts = recognized.launchers.map(({ token, executable: launcher }) => ({ token, executable: launcher }));
  const envHash = environmentFingerprint(recognized.adapterId, executable, launcherFacts, deps);
  const core = exactPlanWithoutFingerprint({
    source: derived?.source ?? null,
    adapterId: recognized.adapterId,
    executable,
    argv: recognized.argv,
    pinnedDefinitions: publicDefinitionPins(derived?.definition),
    environmentFingerprint: envHash,
    regressionWitnessTrusted: recognized.regressionWitnessTrusted,
  });
  const plan = deepFreeze({
    schemaVersion: core.schemaVersion,
    source: core.source,
    adapterId: core.adapterId,
    executable: core.executable,
    argv: core.argv,
    cwdPolicy: core.cwdPolicy,
    pinnedDefinitions: core.pinnedDefinitions,
    planFingerprint: hashJson(core),
    environmentFingerprint: core.environmentFingerprint,
    regressionWitnessTrusted: core.regressionWitnessTrusted,
  });
  FROZEN_PLAN_RUNTIME.set(plan, deepFreeze({
    // ★ `deriveTestCommand` 는 자기 경계에서 알림을 한 번 얹었지만, `adapterPlan` 은 그 뒤에
    //   돈다 — 선언된 리포터를 못 들어주는 사실은 어댑터를 고르는 자리에서만 알 수 있다.
    //   그래서 같은 규칙을 여기서 한 번 더 적용한다(있을 때만, 항목 자체는 그대로).
    derived: derived === null || derivation.notices.length === 0 ? derived : { ...derived, notices: [...derivation.notices] },
    // ★ 파생 결과가 **null 이어도** 남는다(테스트 명령을 하나도 못 찾은 프로젝트). 설정은
    //   읽혔는데 명령만 없는 실행이 있고, 그때도 `provisionDeps` 는 사용자가 쓴 사실이다.
    baselineConfig: derivation.config,
    executablePath: identity?.path ?? null,
    executable: identity?.public ?? null,
    launchers: recognized.launchers,
    witnessPolicy: recognized.witnessPolicy,
  }));
  return plan;
}

function validFrozenPlan(plan) {
  if (!hasExactKeys(plan, PLAN_KEYS) || !Object.isFrozen(plan) || plan.schemaVersion !== 1 ||
      plan.cwdPolicy !== 'evidence-worktree' || !SHA256_PATTERN.test(plan.planFingerprint) ||
      !SHA256_PATTERN.test(plan.environmentFingerprint) || !Array.isArray(plan.argv) ||
      plan.argv.some((arg) => typeof arg !== 'string') || !Array.isArray(plan.pinnedDefinitions)) return false;
  const core = exactPlanWithoutFingerprint(plan);
  return hashJson(core) === plan.planFingerprint;
}

/**
 * 이 계획을 파생하며 쌓인 알림들. 계획 객체에는 실을 자리가 없다 — 키 집합이 정확히
 * `PLAN_KEYS` 여야 하고(`validFrozenPlan` 의 `hasExactKeys`) 그중 지문 말고는 전부
 * `planFingerprint` 의 입력이라, 알림 한 줄이 지문을 바꾸면 재개의 계획 관문이 같은
 * 프로젝트를 다른 계획이라고 말한다. 그래서 파생 결과와 함께
 * 사설 런타임에 두고, 엔진이 여기서 꺼내 종료 봉투의 알림 채널로 옮긴다
 * (`plannerNotices` → `baseNotices` → `joinNotices`).
 */
export function frozenTestPlanNotices(plan) {
  const notices = FROZEN_PLAN_RUNTIME.get(plan)?.derived?.notices;
  return Array.isArray(notices) ? [...notices] : [];
}

/**
 * 이 계획을 파생하며 **baseline 커밋에서 읽은** 프로젝트 설정. 없으면 null.
 *
 * 소비자는 `src/engine.mjs` 하나이고, 읽는 것은 `tests.provisionDeps` 뿐이다(WS4a 태스크 5).
 * 계획 객체에 실을 수 없는 이유는 알림과 같다 — 키 집합이 정확히 `PLAN_KEYS` 여야 하고 그중
 * 지문 말고는 전부 `planFingerprint` 의 입력이라, 설정 한 줄이 지문을 바꾸면 재개의 계획
 * 관문이 같은 프로젝트를 다른 계획이라고 말한다.
 *
 * ★★ **이 채널이 "워크트리 사본을 읽지 않는다" 를 지키는 방식이다.** 값은 `readProjectConfig`
 *   가 `deps.projectConfigCommit` 커밋 오브젝트에서 읽은 그 값이고, 워크트리 파일을 여는 경로는
 *   이 파일 어디에도 없다(`verifyDefinition` 의 대조 하나만 예외이고 그것은 **거부**에만 쓴다).
 *   주입된 계획에는 사설 런타임이 아예 없으므로 null 이 나온다 — 설정을 도입하기 전의 동작이다.
 */
export function frozenTestPlanConfig(plan) {
  return FROZEN_PLAN_RUNTIME.get(plan)?.baselineConfig ?? null;
}

/** Classify one normalized path using only the private witness policy frozen with the original plan. */
export function classifyFrozenTestPath(plan, path) {
  const runtime = FROZEN_PLAN_RUNTIME.get(plan);
  const normalized = safeRelativeSourcePath(path);
  if (!validFrozenPlan(plan) || runtime === undefined || runtime.witnessPolicy?.trusted !== true ||
      normalized === null || normalized !== path) return 'helper';
  const roots = runtime.witnessPolicy.roots;
  const underRoot = roots.some((root) => pathUnderRoot(normalized, root));
  const name = normalized.split('/').at(-1);
  if (plan.adapterId === 'node-events-v1') {
    const ordinary = /\.(?:test|spec)\.[^.]+$/i.test(name) ||
      underRoot && /\.(?:[cm]?js|jsx|ts|tsx)$/i.test(name);
    return ordinary ? 'test' : underRoot ? 'helper' : 'outside';
  }
  if (plan.adapterId === 'pytest-events-v1') {
    const ordinary = underRoot && (/^test_.+\.py$/i.test(name) || /^.+_test\.py$/i.test(name));
    return ordinary ? 'test' : underRoot ? 'helper' : 'outside';
  }
  return 'helper';
}

function noRun(plan, code, { aborted = false } = {}) {
  return persistableRecord(plan, noRunRaw({ aborted }), null, [code]);
}

function noRunRaw({ aborted = false } = {}) {
  return {
    ran: false,
    exitCode: null,
    aborted,
    timedOut: false,
    hung: false,
    lingering: false,
    spawnError: null,
    output: '',
    outputChars: 0,
    truncated: false,
    failureKind: aborted ? 'infrastructure' : 'infrastructure',
  };
}

function sameExecutable(a, b) {
  return a !== null && b !== null && a.basename === b.basename && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function reconstructFrozenArgv(runtime, plan, executablePath, deps = {}) {
  const argv = [...plan.argv];
  const facts = [];
  for (const launcher of runtime.launchers ?? []) {
    if (launcher.kind !== 'npm-cli.js' || argv[launcher.index] !== launcher.placeholder) return null;
    const resolved = await (deps.npmCliPath ?? findNpmCli)(executablePath);
    const identity = await executableIdentity(resolved, deps);
    if (identity === null || identity.path !== launcher.path || !sameExecutable(identity.public, launcher.executable) ||
        launcherToken(identity) !== launcher.token) return null;
    argv[launcher.index] = identity.path;
    facts.push({ token: launcher.token, executable: identity.public });
  }
  if (plan.adapterId === null && (argv.length !== runtime.derived.args.length ||
      argv.some((arg, index) => arg !== runtime.derived.args[index]))) return null;
  return { argv, facts };
}

async function inspectFrozenTestPlanEnvironment(plan, deps = {}) {
  const runtime = FROZEN_PLAN_RUNTIME.get(plan);
  if (!validFrozenPlan(plan) || runtime === undefined) return { ok: false, reasonCode: REASON.test_plan_invalid };
  if (runtime.derived === null || runtime.executablePath === null || runtime.executable === null) {
    return { ok: false, reasonCode: REASON.test_command_unavailable };
  }
  try {
    const resolved = await resolveExecutableAgain(runtime.executablePath, deps);
    const identity = await executableIdentity(resolved, deps);
    if (identity === null || identity.path !== runtime.executablePath ||
        !sameExecutable(identity.public, runtime.executable)) {
      return { ok: false, reasonCode: REASON.test_executable_drift };
    }
    const reconstructed = await reconstructFrozenArgv(runtime, plan, identity.path, deps);
    if (reconstructed === null) return { ok: false, reasonCode: REASON.test_launcher_drift };
    if (environmentFingerprint(plan.adapterId, identity.public, reconstructed.facts, deps) !== plan.environmentFingerprint) {
      return { ok: false, reasonCode: REASON.test_environment_drift };
    }
    return {
      ok: true,
      runtime,
      executablePath: identity.path,
      executable: identity.public,
      argv: reconstructed.argv,
    };
  } catch {
    return { ok: false, reasonCode: REASON.test_executable_drift };
  }
}

/** Recheck a frozen plan's private executable/launcher authority without exposing resolved paths. */
export async function checkFrozenTestPlanEnvironment(plan, deps = {}) {
  const checked = await inspectFrozenTestPlanEnvironment(plan, deps);
  if (checked.ok !== true) return { ok: false, reasonCode: checked.reasonCode };
  return {
    ok: true,
    executable: checked.executable,
    environmentFingerprint: plan.environmentFingerprint,
  };
}

async function verifyWorktreeHandle(worktree, runId, mode) {
  if (!worktree || worktree.ok !== true || typeof worktree.path !== 'string' || typeof worktree.stateRoot !== 'string' ||
      typeof worktree.worktreeId !== 'string' || worktree.runId !== runId || !TEST_MODES.has(mode) ||
      typeof worktree.purpose !== 'string' || !new RegExp(`-${mode}-[12]$`).test(worktree.purpose)) return null;
  const [realPath, realState] = await Promise.all([canonical(worktree.path), canonical(worktree.stateRoot)]);
  if (realPath === null || realState === null || basename(realPath) !== worktree.worktreeId) return null;
  const root = join(realState, 'worktrees');
  const rel = relative(root, realPath);
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  return { path: realPath, stateRoot: realState };
}

async function verifyDefinition(worktreePath, definition) {
  if (!definition || typeof definition !== 'object' || typeof definition.value !== 'string') return false;
  const current = await readDefinitionValue(worktreePath, definition);
  if (current === null || current !== definition.value) return false;
  // ★★ **`extras.error` 는 이 함수가 만들어진 뒤로 한 번도 존재하지 않은 키다.** `checkExtras`
  //   는 `{reasonCode, drift}`(WS2 Task 15 가 문장 대신 코드를 내도록 바꾼 모양) 아니면
  //   `{notes}` 를 내고, 둘 중 어느 것에도 `error` 가 없다 — 그래서 이 줄은 **언제나 참**이었고,
  //   얼어붙은 계획 경로에서는 extras 드리프트가 한 번도 실행을 막은 적이 없다. `runTests`
  //   쪽 같은 검사(:466)는 `reasonCode` 를 보고, 대조 테스트도 전부 그쪽에만 붙어 있어서
  //   이 죽은 가지는 붉어질 자리가 없었다. 두 자리가 **같은 키**를 본다.
  const extras = await checkExtras(worktreePath, definition.extras);
  return extras.reasonCode === undefined;
}

function executionSpec(runtime, plan, eventFile, runId, reconstructedArgv) {
  const derived = runtime.derived;
  if (plan.adapterId === 'node-events-v1') {
    const reporter = resolveTestAssetUrl({ asset: 'node' }).href;
    return {
      ...derived,
      command: runtime.executablePath,
      args: insertNodeReporter(plan.argv, reporter, eventFile.path),
      childEnvExtra: undefined,
      runId,
    };
  }
  if (plan.adapterId === 'pytest-events-v1') {
    const plugin = fileURLToPath(resolveTestAssetUrl({ asset: 'pytest' }));
    return {
      ...derived,
      command: runtime.executablePath,
      args: ['-c', PYTEST_BOOTSTRAP, '-p', 'pytest_events', '--bom-orch-events', eventFile.path],
      childEnvExtra: { ...PYTEST_ENV, PYTHONPATH: dirname(plugin) },
      runId,
    };
  }
  if (plan.adapterId === 'dotnet-trx-v1') {
    return {
      ...derived,
      command: runtime.executablePath,
      args: [...derived.args, '--logger', `trx;LogFileName=${eventFile.path}`],
      childEnvExtra: undefined,
      runId,
    };
  }
  return { ...derived, command: runtime.executablePath, args: reconstructedArgv, runId };
}

/** Run one frozen plan and return an exact persistable record with no raw output/environment. */
export async function runFrozenTests(input, deps = {}) {
  const spec = input && typeof input === 'object' ? input : {};
  const plan = spec.plan;
  const runtime = FROZEN_PLAN_RUNTIME.get(plan);
  if (!validFrozenPlan(plan) || runtime === undefined) return noRun(plan, REASON.test_plan_invalid);
  if (spec.signal?.aborted) return noRun(plan, REASON.test_aborted_before_start, { aborted: true });
  if (spec.signal !== undefined && spec.signal !== null && typeof spec.signal.addEventListener !== 'function') {
    return noRun(plan, REASON.test_abort_signal_invalid);
  }
  if (deps.testQueue?.isPoisoned?.()) return noRun(plan, REASON.test_queue_poisoned);
  const worktree = await verifyWorktreeHandle(spec.worktree, spec.runId, spec.mode);
  if (worktree === null) return noRun(plan, REASON.evidence_worktree_invalid);
  if (runtime.derived === null || runtime.executablePath === null || runtime.executable === null) return noRun(plan, REASON.test_command_unavailable);
  if (!(await verifyDefinition(worktree.path, runtime.derived.definition))) return noRun(plan, REASON.test_pinned_definition_drift);
  const initialEnvironment = await inspectFrozenTestPlanEnvironment(plan, deps);
  if (initialEnvironment.ok !== true) return noRun(plan, initialEnvironment.reasonCode);

  const declaredTests = runtime.baselineConfig?.tests ?? null;
  const executionCwd = await resolveDeclaredCwd(worktree.path, declaredTests?.cwd, deps);
  // ★ 거절된 것은 얼어붙은 계획이 아니라 **사용자가 쓴 설정 한 줄**이다 — 코드도 회복도 그
  //   가족이어야 한다(문구 쪽 WHY 는 `src/reason-text.mjs` 의 이 코드 옆에 있다).
  if (executionCwd === null) return noRun(plan, REASON.config_tests_cwd_unusable);

  let eventFile = null;
  let resultsTarget = null;
  let raw = null;
  let evidenceBytes = null;
  let evidenceDocuments = null;
  let evidenceOwned = false;
  let preSpawnFailure = null;
  let cleanupProven = true;
  const diagnostics = [];
  try {
    // ★★ 두 갈래로 갈리는 이유는 **경로를 누가 정하는가**다. 세 어댑터는 컨트롤러가 만든 파일의
    //   경로를 자식에게 인자로 넘긴다. junit-xml 은 그럴 수 없다 — nextest 와 Gradle 에는 출력
    //   경로를 정하는 CLI 플래그가 아예 없고, 그래서 프로젝트가 `resultsPath` 로 알려 주는 것에
    //   의존한다. 그 자리에 우리가 미리 파일을 만들 수 있으면 소유가 서고, 못 만들면 「선언은
    //   됐으나 소유하지 않음」으로 파싱만 한다(증인은 나가지 않는다).
    // ★★ **`resultsPath` 의 기준 디렉터리는 워크트리 루트다 — `tests.cwd` 가 아니다.** 자식은
    //   `executionCwd` 에서 도는데 우리가 파일을 만들고 되읽는 자리는 루트라, 두 키를 함께
    //   적은 프로젝트는 생산자가 `<worktree>/<cwd>/junit.xml` 에 쓰고 우리는 `<worktree>/
    //   junit.xml` 을 읽는다 — 그 실행은 `evidence_adapter_incomplete` 로 끝난다(fail-closed
    //   이지만 조용하다). 기준을 루트로 두는 이유는 고정 정의와 같다: 이 실행이 무엇을 읽고
    //   무엇과 대조하는지는 사용자가 선언한 디렉터리가 아니라 **우리가 격리한 트리**를 기준
    //   으로 서야 한다. 그 사실을 스키마의 `resultsPath` 설명이 이제 이름으로 말한다 —
    //   자리를 옮기는 것이 아니라, 어느 자리인지 적는 것이 이 수정 파동의 일이다.
    if (plan.adapterId === 'junit-xml-v1') {
      resultsTarget = await prepareDeclaredResults(worktree.path, declaredTests?.resultsPath, deps);
      eventFile = resultsTarget !== null && resultsTarget.identity !== null ? resultsTarget : null;
    } else if (plan.adapterId !== null) {
      const created = await createOwnedEventFile(worktree.path, deps);
      eventFile = created.file;
      preSpawnFailure = created.error;
    }
    // Final identity and definition checks sit immediately before the one process-boundary call.
    if (preSpawnFailure === null && !(await verifyDefinition(worktree.path, runtime.derived.definition))) {
      preSpawnFailure = REASON.test_pinned_definition_drift;
    }
    let finalEnvironment = null;
    if (preSpawnFailure === null) {
      finalEnvironment = await inspectFrozenTestPlanEnvironment(plan, deps);
      if (finalEnvironment.ok !== true) preSpawnFailure = finalEnvironment.reasonCode;
    }
    if (preSpawnFailure === null && eventFile !== null && !(await eventFileUnchanged(eventFile, deps))) {
      preSpawnFailure = REASON.test_event_file_identity_drift;
    }

    if (preSpawnFailure !== null) {
      raw = noRunRaw();
      diagnostics.push(preSpawnFailure);
    } else {
      const call = deps.runTests ?? runTests;
      raw = await call({
        worktree: worktree.path,
        ...executionSpec(runtime, plan, eventFile, spec.runId, finalEnvironment.argv),
        cwd: executionCwd,
        signal: spec.signal,
        onSpawn: spec.onSpawn,
        timeoutMs: boundedTestTimeout(spec.timeoutMs, declaredTests?.timeoutMs),
        env: deps.env ?? process.env,
      });
      if (typeof raw?.evidenceBytes === 'string') {
        evidenceBytes = raw.evidenceBytes;
        evidenceOwned = true;
      } else if (resultsTarget !== null) {
        const read = await readDeclaredResults(resultsTarget, deps);
        evidenceDocuments = read?.documents ?? null;
        evidenceOwned = read?.owned === true;
      } else if (eventFile !== null) {
        evidenceBytes = await readOwnedEvidence(eventFile, deps);
        evidenceOwned = evidenceBytes !== null;
      }
      if (plan.adapterId !== null && evidenceBytes === null && evidenceDocuments === null) {
        diagnostics.push(REASON.evidence_adapter_incomplete);
      }
      if (raw?.lingering === true || raw?.hung === true) deps.testQueue?.poison?.(REASON.test_process_cleanup_unproven);
    }
  } catch {
    raw = {
      ran: false,
      exitCode: null,
      spawnError: new Error('frozen test execution failed'),
      output: '',
      outputChars: 0,
      truncated: false,
    };
    diagnostics.push(REASON.test_frozen_execution_failed);
  } finally {
    if (eventFile !== null && !(await cleanupOwnedEvidence(eventFile, deps))) {
      // ★★ junit-xml 의 선언된 결과 파일만 여기서 갈린다. 생산자가 임시 파일을 rename 하면
      //   inode 가 바뀌고 `cleanupOwnedEvidence` 는 그것을 지우지 못한다 — 자기 것이 아니기
      //   때문이다. 그 사실로 증거를 버리면 temp+rename 을 쓰는 생산자 전부가 증거를 못 내게
      //   되는데, 결정 7 은 그 경우를 「거부하지 않고 증인 권위만 거둔다」로 못 박았다. 남는
      //   대가는 워크트리에 생산자의 파일이 하나 남는 것이고, 워크트리는 이 실행과 함께 회수된다.
      //   나머지 어댑터는 파일이 통째로 우리 것이라 예전 규율 그대로다.
      if (plan.adapterId === 'junit-xml-v1') evidenceOwned = false;
      else {
        cleanupProven = false;
        diagnostics.push(REASON.test_event_file_cleanup_unproven);
      }
    }
  }
  if (!cleanupProven) {
    evidenceBytes = null;
    evidenceDocuments = null;
    raw = { ...raw, failureKind: 'infrastructure' };
  }
  const evidence = (evidenceBytes === null && evidenceDocuments === null) || plan.adapterId === null
    ? null
    : {
      adapterId: plan.adapterId,
      ...(evidenceDocuments === null ? { bytes: evidenceBytes } : { documents: evidenceDocuments }),
      worktreePath: worktree.path,
    };
  if (evidence !== null && runtime.witnessPolicy !== null) {
    // ★★ 증인 정책은 여기서 **유도**하고 잎이 **적용**한다(태스크 6 리뷰가 못 박은 이음매).
    //   junit-xml 에서 그 유도에 하나가 더 붙는다: 결과 파일의 inode 를 우리가 못 지켰으면
    //   (생산자가 임시 파일을 rename 했거나, 애초에 우리가 만들지 못한 자리였으면) 정책을
    //   신뢰 없음으로 낮춘다. 파싱은 그대로 돌아 `observedOutcome` 과 지문은 살고, 증인만
    //   나가지 않는다 — 우리가 만들지 않은 파일은 워크트리의 무엇이든 쓸 수 있었던 파일이다.
    const policy = plan.adapterId === 'junit-xml-v1' && !evidenceOwned
      ? UNOWNED_JUNIT_WITNESS_POLICY
      : runtime.witnessPolicy;
    ADAPTER_EVIDENCE_POLICY.set(evidence, policy);
  }
  return persistableRecord(plan, raw, evidence, diagnostics);
}
