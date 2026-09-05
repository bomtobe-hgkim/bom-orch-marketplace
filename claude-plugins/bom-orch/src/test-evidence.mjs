/**
 * 신뢰 증거의 **파서와 분류기** — 어댑터 네 종(node:test 이벤트 · pytest 이벤트 · dotnet TRX ·
 * 범용 JUnit-XML)의 스트림을 읽어 witness·failure fingerprint·관측 결과로 바꾸고, 러너가 남긴
 * 원시 결과와 합쳐 저장 가능한 테스트 레코드 하나를 만든다.
 *
 * ★ 방향은 한쪽이다: `src/test-runner.mjs` → 여기. 이 파일은 러너도, 저장소 모듈
 *   (`run-artifacts`·`run-store-fs`·`run-records`·`run-inspect`)도, `engine` 도 수입하지 않는다.
 *   계획(plan)을 만드는 쪽도 아니다 — `FROZEN_PLAN_RUNTIME` 과 `validFrozenPlan` 은 러너에 남았고,
 *   여기 있는 `persistableRecord` 는 계획에서 **읽기만** 한다(`adapterId`·두 지문).
 *
 * ## `junit-xml-v1` (WS4a 태스크 7) — 파싱은 여섯, 증인은 둘
 *
 * 한 어댑터가 여섯 생산자(Gradle · Maven Surefire/Failsafe · cargo-nextest · gotestsum ·
 * jest-junit · Vitest)를 덮지만, 그 말이 참인 것은 **파싱**에 대해서다. 증인(witness)은 소스
 * 경로를 계산만으로 복원할 수 있는 등급에서만 나온다 — Vitest(A: `testsuite name` 이 곧 root
 * 상대 슬래시 경로)와 `file` 속성을 켠 jest-junit(B). Gradle·Surefire(C: FQCN→파일은 워크트리
 * 탐색이라 「워크트리 사본을 읽지 않는다」와 정면 충돌), gotestsum(D: import path 는 파일이
 * 아니라 디렉터리), cargo-nextest(E: 유닛 테스트는 원리적으로 불가)는 `parseTrxEvidence` 의
 * 선례대로 **파싱은 하되 `witnessIds: []`** 로 `observedOutcome`·`failureFingerprints` 만 낸다.
 * 그 선을 긋는 것은 생산자 지문이 아니라 `pathAllowedByPolicy` 의 junit 갈래다(그쪽 WHY 참조).
 *
 * ⚠ 남는 틈, 실측(태스크 11 이 다시 쟀다): `REGRESSION_WITNESS_ADAPTERS`(`src/regression-proof.mjs`)
 *   는 `node-events-v1`·`pytest-events-v1` 만 둔다. 그 목록과 계획의 `regressionWitnessTrusted` 를
 *   **둘 다** 켜 봐도 회귀 증명은 여전히 서지 않는다 — `classifyFrozenTestPath` 에 junit 갈래가
 *   없어 모든 경로가 helper 로 떨어지기 때문이고, 넓히는 커밋은 junit 의 **델타 루트**를 증인
 *   루트(`src` 포함)와 **다르게** 정해야 한다. 그 결합은 `test/test-runner.test.mjs` 가 못 박는다.
 *
 * ★ XML 부분집합 토크나이저는 여기 없다 — `src/xml-subset.mjs`(수정 라운드 커밋 2, 바이트 보존 이동). 이 파일이 갖는 것은 그 위의 **JUnit 계약**이다: 어느 루트가 적법한지, 어느 자식이 실패를 뜻하는지, 어느 속성이 경로인지, 그리고 여섯 생산자의 문서가 어떻게 한 실행으로 합쳐지는지. 속성 값 상한만 옵션(`maxAttributeChars`)으로 넘긴다 — 그 수는 어댑터의 것이라 잎이 알 이유가 없다.
 * ★ 실측 폐포: **8개 모듈 / 2,637줄**(자기 자신 1,122 포함) — `real-path`(54)·`reason-codes`(737)·`util/{freeze,hash,objects,strings}`(470)·`xml-subset`(254). 태스크 7 은 모듈을 늘리지 않았고 수정 라운드가 하나 늘렸다(그 하나는 이 파일에서 잘라낸 잎이라 **폐포 줄 수는 +51**, 새 헤더·export 블록·상한 docblock 뿐이다). 태스크 10 은 모듈을 안 늘리고 이름 둘(`ADAPTER_IDS`·`JUNIT_WITNESS_PRODUCERS`)을 공개 표면에 얹었다(**+13**). `reason-text` 도 `git` 도 `providers/*` 도 저장소 모듈도 **0개**다 — 실패 어휘는 코드(`REASON`)로만 나가고 문장은 부르는 쪽이 만든다.
 * ★ 수입하는 쪽(실측 grep): `src/test-runner.mjs`(이름 14개)·`src/regression-proof.mjs`(`selectTestDeltaWitnesses` 하나)와 테스트 셋(`test/test-runner.test.mjs`·`test/junit-xml-adapter.test.mjs`·`test/distribution-bundle.test.mjs`). 다섯뿐이다.
 */

import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonical } from './real-path.mjs';
import { REASON } from './reason-codes.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { sha256 } from './util/hash.mjs';
import { hasExactKeys } from './util/objects.mjs';
import { boundedText, compareUtf8 } from './util/strings.mjs';
// ★ XML 부분집합 토크나이저의 정본은 `src/xml-subset.mjs` 다(태스크 7 수정 라운드 커밋 2).
//   방향은 한쪽이다: 여기 → 저기. 저 잎은 아무것도 수입하지 않고 JUnit 을 모른다 — 루트 이름과
//   요소의 뜻은 아래 `readJunitDocument` 가 정하고, 속성 값 상한만 옵션으로 넘긴다.
import { tokenizeJunitXml } from './xml-subset.mjs';

/**
 * 러너가 부르는 이름들. **선언 줄에 `export` 를 붙이지 않고** 한 자리에 모은 이유는 이 파일이
 * `src/test-runner.mjs` 에서 바이트 그대로 옮겨 온 것이기 때문이다 — 선언을 한 글자도 건드리지
 * 않아야 `git diff --color-moved` 가 이 커밋을 순수 이동으로 읽고, 다음 사람이 "옮기면서 뭘
 * 고쳤나" 를 되짚을 필요가 없다. 공개 표면은 이 블록 하나가 전부다.
 */
export {
  ADAPTER_EVIDENCE_POLICY,
  ADAPTER_IDS,
  DEFAULT_JUNIT_WITNESS_POLICY,
  DEFAULT_NODE_WITNESS_POLICY,
  DEFAULT_PYTEST_WITNESS_POLICY,
  JUNIT_WITNESS_PRODUCERS,
  MISSING_DEP_SIGNS,
  SHA256_PATTERN,
  UNOWNED_JUNIT_WITNESS_POLICY,
  cleanupOwnedEvidence,
  createOwnedEventFile,
  eventFileUnchanged,
  failingTestLabels,
  insertNodeReporter,
  pathUnderRoot,
  persistableRecord,
  prepareDeclaredResults,
  readDeclaredResults,
  readOwnedEvidence,
  safeRelativeSourcePath,
};

const ADAPTER_EVIDENCE_POLICY = new WeakMap();
const TEST_RECORD_WITNESS_AUTHORITY = new WeakMap();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ADAPTER_BYTES = 8 * 1024 * 1024;
const MAX_ADAPTER_EVENTS = 20_000;
const MAX_ADAPTER_LINE_CHARS = 16_384;
const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_CHARS = 240;
const ADAPTER_IDS = new Set(['node-events-v1', 'pytest-events-v1', 'dotnet-trx-v1', 'junit-xml-v1']);

/**
 * The two JUnit producers whose output can become a **witness**, and the grade the task-7 dialect
 * memo measured for each. The other four parse and issue none - the WHY is at
 * `DEFAULT_JUNIT_WITNESS_POLICY`, and the line is drawn by `pathAllowedByPolicy`, never here.
 *
 * ★ 런타임이 읽어서가 아니라 **문서가 이것을 베끼기 때문에** 이름이 있다: 두 배포 문서의 생태계
 *   표에서 witness-capable 로 적힌 `junit-xml-v1` 행은 정확히 이 두 키여야 하고, 그것을
 *   `test/packaging.test.mjs` 가 여기서 유도한다. 셋째 생산자가 등급을 얻는 날 그 표가 붉어진다.
 */
const JUNIT_WITNESS_PRODUCERS = deepFreeze({ Vitest: 'A', Jest: 'B' });

/**
 * JUnit-XML bounds (WS4a Task 7, dialect memo §9). The three caps above are reused where an
 * equivalent exists; these two are the shapes XML has and JSONL does not. The depth and
 * attribute caps left with the tokenizer they bound (`src/xml-subset.mjs`).
 *
 * ★ 2,048 documents covers a large Java repository’s test classes - Gradle and Surefire
 *   write ONE FILE PER TEST CLASS, which is why directory mode exists at all. A name or
 *   classname past 4,096 characters is a stream nobody wrote by hand.
 */
const MAX_JUNIT_DOCUMENTS = 2_048;
const MAX_JUNIT_NAME_CHARS = 4_096;

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

const TEST_ASSET_LAYOUT =
  typeof __BOM_ORCH_TEST_ASSET_LAYOUT__ === 'string' ? __BOM_ORCH_TEST_ASSET_LAYOUT__ : 'source';

export function resolveTestAssetUrl({ moduleUrl = import.meta.url, layout = TEST_ASSET_LAYOUT, asset } = {}) {
  const names = layout === 'source'
    ? { node: './test-reporters/node-events.mjs', pytest: './test-reporters/pytest_events.py' }
    : layout === 'dist'
      ? { node: './node-test-reporter.mjs', pytest: './pytest_events.py' }
      : null;
  if (names === null || !Object.hasOwn(names, asset)) {
    throw new TypeError('unknown test asset layout or asset');
  }
  return new URL(names[asset], moduleUrl);
}

const DEFAULT_NODE_WITNESS_POLICY = deepFreeze({ kind: 'node', trusted: true, roots: ['test', 'tests'] });
const DEFAULT_PYTEST_WITNESS_POLICY = deepFreeze({ kind: 'pytest', trusted: true, roots: ['test', 'tests'] });

/**
 * The JUnit-XML witness policy. Five roots, measured against the policy shape the other two
 * already use (`{ kind, trusted, roots }`) and against `pathAllowedByPolicy` below: the roots
 * are compared with `pathUnderRoot`, so each has to be a plain slash-separated relative prefix -
 * `__tests__` and `spec` qualify, and the list is sorted the way `pytestWitnessPolicy` sorts its
 * configured roots so two spellings of the same set cannot produce two policies.
 *
 * ★★ Roots alone would be far too wide here, because five of the six producers put something
 *   that is NOT a source path where a path would go (a JVM binary FQCN, a Go import path, a
 *   nextest binary ID). That is why the junit branch of `pathAllowedByPolicy` ALSO demands a
 *   JavaScript/TypeScript source extension: the only two producers whose output can be turned
 *   back into a source path by computation - Vitest (grade A) and jest-junit with a `file`
 *   attribute (grade B) - are both JS/TS, and `github.com/org/repo/pkg/sub` or
 *   `com.foo.FooTest$Nested` cannot end in `.ts`. Grades C/D/E therefore issue no witness by
 *   CONSTRUCTION rather than by a producer sniff we would have to keep up to date.
 */
const DEFAULT_JUNIT_WITNESS_POLICY = deepFreeze({
  kind: 'junit',
  trusted: true,
  roots: ['__tests__', 'spec', 'src', 'test', 'tests'],
});

/**
 * The policy the runner uses when the reporter output is the project's DECLARED path and this
 * controller could not prove it owns the inode (task-7 decision 7). The bytes are still parsed -
 * `observedOutcome` and `failureFingerprints` survive - but nothing in them may become a witness,
 * because a file we did not create is a file anything in the worktree could have written.
 */
const UNOWNED_JUNIT_WITNESS_POLICY = deepFreeze({ kind: 'junit', trusted: false, roots: [] });

function safeRelativeSourcePath(value, worktreePath = null) {
  if (boundedText(value, 4_096) === null) return null;
  let path = value;
  if (path.startsWith('file:')) {
    try { path = fileURLToPath(path); } catch { return null; }
  }
  if (isAbsolute(path)) {
    if (worktreePath === null) return null;
    const rel = relative(worktreePath, path);
    if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
    path = rel.replaceAll('\\', '/');
  }
  // ★★ 어댑터는 **상대** 경로를 OS 구분자로 낸다 — Windows 의 pytest 는
  //   `tests\test_math.py` 를 보고한다. 아래 검사는 역슬래시가 하나라도 있으면 거부하므로,
  //   그 플랫폼에서는 pytest 증거가 **통째로** 무효가 됐다(실측: 같은 스트림에서 구분자만
  //   바꾸면 witness 1개·digest 있음 → witness 0개·digest null). 그러면 Python 저장소는
  //   Windows 에서 영영 `verified` 에도 회귀 증명에도 닿지 못한다.
  //
  // ★ 정규화는 **win32 에서만** 한다. POSIX 에서 `\` 는 적법한 파일명 문자라, 거기서
  //   바꿔치면 없던 경로 구획을 만들어 내고 witness ID 가 다른 파일을 가리키게 된다.
  //   절대 경로 분기는 이미 같은 정규화를 하고 있었다 — 상대 경로만 빠져 있었다.
  if (process.platform === 'win32') path = path.replaceAll('\\', '/');
  if (/^[A-Za-z]:|^[/\\]|\\/.test(path)) return null;
  const parts = path.normalize('NFC').split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function parseJsonLines(bytes) {
  if (typeof bytes !== 'string' || bytes === '' || bytes.length > MAX_ADAPTER_BYTES || !bytes.endsWith('\n')) return null;
  const lines = bytes.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.length > MAX_ADAPTER_EVENTS || lines.some((line) => line === '' || line.length > MAX_ADAPTER_LINE_CHARS)) return null;
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function normalizeFullTestName(value) {
  if (boundedText(value, 4_096) === null) return null;
  return value.normalize('NFC');
}

function witnessId(adapterId, path, fullName) {
  return sha256(Buffer.from(`${adapterId}\0${path}\0${fullName}`, 'utf8'));
}

function invalidEvidence(kind = 'collection') {
  return {
    trusted: false,
    complete: false,
    witnessIds: [],
    failureFingerprints: [],
    failureKind: kind,
    observedOutcome: 'unknown',
    terminalExitCode: null,
    witnessAuthority: [],
  };
}

function pathUnderRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function pathAllowedByPolicy(adapterId, path, policy) {
  if (policy?.trusted === false) return false;
  const basenameValue = path.split('/').at(-1);
  if (adapterId === 'node-events-v1') {
    const roots = policy?.kind === 'node' ? policy.roots : DEFAULT_NODE_WITNESS_POLICY.roots;
    return roots.some((root) => pathUnderRoot(path, root)) || /\.(?:test|spec)\.[^.]+$/i.test(basenameValue);
  }
  if (adapterId === 'pytest-events-v1') {
    const roots = policy?.kind === 'pytest' ? policy.roots : DEFAULT_PYTEST_WITNESS_POLICY.roots;
    return roots.some((root) => pathUnderRoot(path, root)) &&
      (/^test_.+\.py$/i.test(basenameValue) || /^.+_test\.py$/i.test(basenameValue));
  }
  if (adapterId === 'junit-xml-v1') {
    const roots = policy?.kind === 'junit' ? policy.roots : DEFAULT_JUNIT_WITNESS_POLICY.roots;
    return /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i.test(basenameValue) &&
      (/\.(?:test|spec)\.[^.]+$/i.test(basenameValue) || roots.some((root) => pathUnderRoot(path, root)));
  }
  return false;
}

function sameNodeRecord(entry, event, path, name) {
  return entry.path === path && entry.name === name && entry.kind === event.kind && entry.line === event.line &&
    entry.column === event.column && entry.nesting === event.nesting;
}

function parseNodeEvidence(bytes, worktreePath = null, witnessPolicy = DEFAULT_NODE_WITNESS_POLICY) {
  const events = parseJsonLines(bytes);
  if (events === null) return invalidEvidence();
  // ★★ 스택이 아니라 **정체성**으로 짝짓는다(2026-08-28 라이브 실측). node 는 한 파일의 최상위 테스트를
  //   정의 시점에 전부 enqueue 한 뒤 차례로 완료한다(enqueue 14 → pass 14) — LIFO 스택은 두 번째 테스트
  //   에서 어긋나 스위트 전체가 `collection` 무효가 됐고, 커밋된 캡처가 테스트 하나짜리라 한 번도 안 보였다.
  //   `--test-concurrency` 는 파일 사이 이벤트도 섞는다. 부모는 「같은 파일에서 열려 있는, nesting 이 하나
  //   작은 가장 최근 노드」다: 자식의 enqueue 는 부모가 열려 있는 동안에만 온다. 자식을 가진 `test`(t.test)
  //   는 suite 처럼 컨테이너로 다루되 소스가 정의한 테스트이므로 증인은 된다 — 그 실패 지문은 자기
  //   본문 실패(`testCodeFailure`)에만 붙고, 자식 실패(`subtestsFailed`)는 자식이 든다.
  const open = new Map();
  const openByPath = new Map();
  const witnesses = new Set();
  // ★ 같은 파일·같은 fullName 은 node 가 허용한다(실측: 이 저장소에 열한 쌍). 둘째부터 완료 순서의 서수를
  //   붙여 가른다 — 첫 것의 정체성은 그대로라 커밋된 캡처·회귀 증명과 호환되고, 스위트 전체를 버리던
  //   중복 거절은 이제 진짜 충돌(`#n` 까지 같은 경우)에만 선다.
  const seenNames = new Map();
  const failureFingerprints = [];
  const witnessAuthority = [];
  let failureKind = 'unknown';
  let terminal = null;
  let completedCount = 0;
  let failedCount = 0;
  // ★ 이름에 ' > ' 가 있어도 받는다(실측: 이 저장소의 테스트 이름 「disputed > unverified > verified」). 구분자
  //   충돌로 두 노드가 같은 증인 id 를 내면 아래 중복 검사가 스트림을 **거절**하지 오귀속하지 않는다.
  const markDescendantFailed = (node) => { for (let parent = node.parent; parent !== null; parent = parent.parent) parent.descendantFailed = true; };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === 'terminal') {
      if (terminal !== null || index !== events.length - 1 || !hasExactKeys(event, ['type', 'count']) ||
          !Number.isInteger(event.count) || event.count < 0) return invalidEvidence();
      terminal = event;
      continue;
    }
    const keys = ['type', 'kind', 'name', 'file', 'line', 'column', 'nesting', 'failureType'];
    if (!hasExactKeys(event, keys) || !['enqueue', 'pass', 'fail'].includes(event.type) ||
        !['test', 'suite'].includes(event.kind) ||
        typeof event.name !== 'string' || event.name === '' || event.name.length > 1_024 ||
        !Number.isInteger(event.line) || event.line < 1 || !Number.isInteger(event.column) || event.column < 0 ||
        !Number.isInteger(event.nesting) || event.nesting < 0 || event.nesting > 64 ||
        (event.failureType !== null && typeof event.failureType !== 'string')) return invalidEvidence();
    const path = safeRelativeSourcePath(event.file, worktreePath);
    const name = normalizeFullTestName(event.name);
    if (path === null || name === null) return invalidEvidence();
    const key = JSON.stringify([path, event.kind, name, event.line, event.column, event.nesting]);
    if (event.type === 'enqueue') {
      if (event.failureType !== null || open.has(key)) return invalidEvidence();
      const byNesting = openByPath.get(path) ?? new Map();
      const parent = event.nesting === 0 ? null : byNesting.get(event.nesting - 1) ?? null;
      if (event.nesting > 0 && parent === null) return invalidEvidence();
      const fullName = parent === null ? name : `${parent.fullName} > ${name}`;
      if (normalizeFullTestName(fullName) === null) return invalidEvidence();
      const node = { path, kind: event.kind, fullName, parent, openChildren: 0, hasChild: false, descendantFailed: false };
      if (parent !== null) { parent.openChildren += 1; parent.hasChild = true; }
      open.set(key, node);
      byNesting.set(event.nesting, node);
      openByPath.set(path, byNesting);
      continue;
    }
    const current = open.get(key);
    if (!current || current.openChildren !== 0) return invalidEvidence();
    open.delete(key);
    const byNesting = openByPath.get(path);
    if (byNesting?.get(event.nesting) === current) byNesting.delete(event.nesting);
    if (current.parent !== null) current.parent.openChildren -= 1;
    completedCount += 1;
    const failed = event.type === 'fail';
    let ownFailure = false;
    if (current.kind === 'suite') {
      // suite 는 증인이 아니다. 자식이 실패했으면 subtestsFailed 로 실패해야 하고, 자식 없이(또는 자식이 다
      // 통과했는데) 실패했으면 describe 콜백이 던진 것 — 러너 인프라 실패이지 assertion 이 아니다.
      if (current.descendantFailed) {
        if (!failed || event.failureType !== 'subtestsFailed') return invalidEvidence('infrastructure');
        markDescendantFailed(current);
      } else if (failed) {
        return invalidEvidence('infrastructure');
      }
      continue;
    }
    if (current.hasChild) {
      if (current.descendantFailed) {
        if (!failed || event.failureType !== 'subtestsFailed') return invalidEvidence('infrastructure');
        markDescendantFailed(current);
      } else if (failed) {
        if (event.failureType !== 'testCodeFailure') return invalidEvidence('infrastructure');
        ownFailure = true;
      }
    } else {
      if (failed) {
        if (event.failureType !== 'testCodeFailure') return invalidEvidence('infrastructure');
        ownFailure = true;
      } else if (event.failureType !== null) {
        // ★★ `skip`/`todo` 는 **몸통이 안 돌았다**는 directive 이지 스트림이 깨졌다는 신호가 아니다. 그 항목만
        //   증인에서 빼면 충분하다 — 돌지 않은 테스트는 어떤 파일도 덮었다고 주장하지 않으므로 위조 위험이
        //   늘지 않고, 설계 §9.4 의 「C 에서 대상 test 가 skip 되어 green 이 됨」도 그 증인이 **없는** 것으로
        //   그대로 걸린다. 그 밖의 모르는 directive 는 여전히 치명적이다.
        if (event.failureType !== 'skip' && event.failureType !== 'todo') return invalidEvidence();
        continue;
      }
    }
    if (ownFailure) {
      failureKind = 'assertion';
      failedCount += 1;
      markDescendantFailed(current);
    }
    if (!pathAllowedByPolicy('node-events-v1', path, witnessPolicy)) continue;
    const nameKey = `${path}\0${current.fullName}`;
    const occurrence = (seenNames.get(nameKey) ?? 0) + 1;
    seenNames.set(nameKey, occurrence);
    const witnessName = occurrence === 1 ? current.fullName : `${current.fullName} #${occurrence}`;
    const id = witnessId('node-events-v1', path, witnessName);
    if (witnesses.has(id)) return invalidEvidence();
    witnesses.add(id);
    witnessAuthority.push({
      adapterId: 'node-events-v1',
      path,
      fullName: witnessName,
      outcome: ownFailure ? 'fail' : 'pass',
      witnessId: id,
    });
    if (ownFailure) failureFingerprints.push(sha256(Buffer.from(`assertion\0${id}`, 'utf8')));
  }
  if (terminal === null || open.size !== 0 || terminal.count !== completedCount) return invalidEvidence();
  return {
    trusted: true,
    complete: true,
    witnessIds: [...witnesses].sort(),
    failureFingerprints: failureFingerprints.sort(),
    failureKind,
    observedOutcome: failedCount > 0 ? 'fail' : 'pass',
    terminalExitCode: null,
    witnessAuthority,
  };
}

function parsePytestIdentity(event, worktreePath) {
  const path = safeRelativeSourcePath(event.path, worktreePath);
  if (path === null) return null;
  const nodeid = normalizeFullTestName(event.nodeid.replaceAll('\\', '/'));
  if (nodeid === null || !nodeid.startsWith(`${path}::`)) return null;
  const fullName = normalizeFullTestName(nodeid.slice(path.length + 2));
  return fullName === null ? null : { path, nodeid, fullName };
}

function parsePytestEvidence(bytes, worktreePath = null, witnessPolicy = DEFAULT_PYTEST_WITNESS_POLICY) {
  const events = parseJsonLines(bytes);
  if (events === null) return invalidEvidence();
  const collected = new Map();
  const phases = new Map();
  const witnesses = [];
  const failures = [];
  const witnessAuthority = [];
  let session = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const keys = ['type', 'nodeid', 'path', 'line', 'outcome', 'when', 'wasxfail'];
    if (!hasExactKeys(event, keys)) return invalidEvidence();
    if (event.type === 'session') {
      if (session !== null || index !== events.length - 1 || event.nodeid !== '' || event.path !== '' ||
          event.line !== null || event.when !== 'session' || event.wasxfail !== false || !/^[0-9]+$/.test(event.outcome)) return invalidEvidence();
      session = event;
      continue;
    }
    if (typeof event.nodeid !== 'string' || event.nodeid === '' || event.nodeid.length > 4_096 ||
        !Number.isInteger(event.line) || event.line < 1 || typeof event.outcome !== 'string' || typeof event.wasxfail !== 'boolean') return invalidEvidence();
    const identity = parsePytestIdentity(event, worktreePath);
    if (identity === null) return invalidEvidence();
    const key = identity.nodeid;
    if (event.type === 'collect') {
      if (event.outcome !== 'collected' || event.when !== 'collection' || event.wasxfail || collected.has(key)) return invalidEvidence();
      collected.set(key, { ...identity, line: event.line });
    } else if (event.type === 'test') {
      const source = collected.get(key);
      if (!source || source.path !== identity.path || source.line !== event.line || !['setup', 'call', 'teardown'].includes(event.when) ||
          !['passed', 'failed', 'skipped'].includes(event.outcome)) return invalidEvidence();
      const current = phases.get(key) ?? new Map();
      if (current.has(event.when)) return invalidEvidence();
      current.set(event.when, event);
      phases.set(key, current);
    } else return invalidEvidence();
  }
  if (session === null || collected.size === 0 || phases.size !== collected.size) return invalidEvidence();
  for (const [key, source] of collected) {
    const current = phases.get(key);
    if (!current || current.size !== 3 || !current.has('setup') || !current.has('call') || !current.has('teardown')) return invalidEvidence();
    const setup = current.get('setup');
    const call = current.get('call');
    const teardown = current.get('teardown');
    // ★★ Node 쪽과 같은 이유로, skip·xfail 은 그 항목만 증인에서 뺀다. 스트림 전체를
    //   무효로 만들면 `@pytest.mark.skip` 하나가 저장소의 회귀 증명을 통째로 없앤다.
    if ([setup, call, teardown].some((event) => event.wasxfail || event.outcome === 'skipped')) continue;
    if (setup.outcome !== 'passed' || teardown.outcome !== 'passed' || !['passed', 'failed'].includes(call.outcome)) return invalidEvidence();
    if (pathAllowedByPolicy('pytest-events-v1', source.path, witnessPolicy)) {
      const id = witnessId('pytest-events-v1', source.path, source.fullName);
      if (witnesses.includes(id)) return invalidEvidence();
      witnesses.push(id);
      witnessAuthority.push({
        adapterId: 'pytest-events-v1',
        path: source.path,
        fullName: source.fullName,
        outcome: call.outcome === 'failed' ? 'fail' : 'pass',
        witnessId: id,
      });
      if (call.outcome === 'failed') failures.push(sha256(Buffer.from(`assertion\0${id}`, 'utf8')));
    }
  }
  const exitCode = Number(session.outcome);
  const failedCalls = [...phases.values()].filter((current) => current.get('call')?.outcome === 'failed').length;
  if (![0, 1].includes(exitCode) || (exitCode === 0) !== (failedCalls === 0)) return invalidEvidence();
  return {
    trusted: true,
    complete: true,
    witnessIds: witnesses.sort(),
    failureFingerprints: failures.sort(),
    failureKind: failedCalls > 0 ? 'assertion' : 'unknown',
    observedOutcome: failedCalls > 0 ? 'fail' : 'pass',
    terminalExitCode: exitCode,
    witnessAuthority,
  };
}

function parseTrxEvidence(bytes) {
  if (typeof bytes !== 'string' || bytes === '' || bytes.length > MAX_ADAPTER_BYTES || !/<TestRun\b/.test(bytes) || !/<\/TestRun>\s*$/.test(bytes)) return invalidEvidence();
  const results = [...bytes.matchAll(/<UnitTestResult\b([^>]*)\/>/g)];
  const summary = /<ResultSummary\b[^>]*\boutcome="([^"]+)"/.exec(bytes);
  if (results.length === 0 || summary === null) return invalidEvidence();
  const failed = [];
  for (const match of results) {
    const name = /\btestName="([^"]+)"/.exec(match[1])?.[1];
    const outcome = /\boutcome="([^"]+)"/.exec(match[1])?.[1];
    if (!name || name.length > 4_096 || !['Passed', 'Failed'].includes(outcome)) return invalidEvidence();
    if (outcome === 'Failed') failed.push(sha256(Buffer.from(`dotnet-trx-v1\0${name}`, 'utf8')));
  }
  if ((summary[1] === 'Passed') !== (failed.length === 0) || !['Passed', 'Failed'].includes(summary[1])) return invalidEvidence();
  return {
    trusted: true,
    complete: true,
    witnessIds: [],
    failureFingerprints: failed.sort(),
    failureKind: failed.length > 0 ? 'assertion' : 'unknown',
    observedOutcome: failed.length > 0 ? 'fail' : 'pass',
    terminalExitCode: null,
    witnessAuthority: [],
  };
}

// ── junit-xml-v1: the adapter over that subset (WS4a Task 7) ──────────────
//
// The tokenizer this reads through is `src/xml-subset.mjs`; what lives here is the JUnit
// CONTRACT on top of it - which root elements are legal, which children mean failure, which
// attribute is a path, and how six producers’ documents merge into one run.

const JUNIT_FAILED_CHILDREN = new Set(['failure', 'error', 'rerunFailure', 'rerunError']);

/** A count attribute, or null when it is absent or not a plain non-negative integer. */
function junitCount(value) {
  return typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number.parseInt(value, 10) : null;
}

/**
 * One `<testcase>` merged into the run-wide state.
 *
 * `fullName` is `NFC(classname#name)` with the enclosing `<testsuite name>` standing in for a
 * missing `classname` (gotestsum's synthetic `TestMain` case reports `classname=""`). Verdicts
 * are recomputed from the CHILD ELEMENTS and never from the count attributes: of the six
 * producers only nextest keeps those consistent, and gotestsum's own golden file disagrees with
 * itself. `failure`/`error` beat `flakyFailure`/`flakyError` because nextest 0.6+ emits both on
 * one testcase, so "a flaky child means it passed" is false there.
 */
function recordJunitCase(state, suite, testcase) {
  const fullName = normalizeFullTestName(`${testcase.classname ?? ''}#${testcase.name}`);
  if (fullName === null) return false;
  if (testcase.failed) state.failed += 1;
  else if (testcase.skipped) return true;
  const declared = testcase.file ?? suite?.name ?? null;
  const path = declared === null ? null : safeRelativeSourcePath(declared, state.worktreePath);
  if (path !== null && pathAllowedByPolicy('junit-xml-v1', path, state.policy)) {
    const id = witnessId('junit-xml-v1', path, fullName);
    const seen = state.witnesses.get(id);
    // ★ The same name may legitimately appear twice - Surefire writes one file per FQCN and
    //   `reportNameSuffix` can put the same FQCN in several of them, gotestsum records a
    //   sub-test and its parent. Refusing the document (what the node/pytest adapters do) would
    //   punish normal repositories, so repetitions merge and any failing repetition wins.
    if (seen === undefined) state.witnesses.set(id, { adapterId: 'junit-xml-v1', path, fullName, outcome: testcase.failed ? 'fail' : 'pass', witnessId: id });
    else if (testcase.failed) seen.outcome = 'fail';
  } else if (testcase.failed) {
    state.unboundFailures.add(fullName);
  }
  return true;
}

/**
 * One document's thin state machine over the tokenizer:
 * `testsuites > testsuite > testcase > failure|error|skipped|flaky*|rerun*`.
 *
 * `<properties>`, `<system-out>` and `<system-err>` need no special case - this adapter reads no
 * element text at all, so their bytes are validated and dropped like every other text node.
 */
function readJunitDocument(text, state) {
  const path = [];
  let suite = null;
  let testcase = null;
  let refused = false;
  const refuse = () => {
    refused = true;
    return false;
  };
  const ok = tokenizeJunitXml(text, {
    maxAttributeChars: MAX_ADAPTER_LINE_CHARS,
    onText() {},
    onOpen(name, attributes, depth) {
      const parent = path.at(-1) ?? null;
      path.push(name);
      if (depth === 1 && name !== 'testsuite' && name !== 'testsuites') return refuse();
      if (name === 'testsuites') return depth === 1 || refuse();
      if (name === 'testsuite') {
        if (depth > 2 || suite !== null || (depth === 2 && parent !== 'testsuites')) return refuse();
        const suiteName = attributes.get('name') ?? null;
        if (suiteName !== null && suiteName.length > MAX_JUNIT_NAME_CHARS) return refuse();
        suite = { name: suiteName, declaredFailures: junitCount(attributes.get('failures')), failureElements: 0, root: depth === 1 };
        return true;
      }
      if (name === 'testcase') {
        if (suite === null || parent !== 'testsuite' || testcase !== null) return refuse();
        const caseName = attributes.get('name') ?? '';
        const classname = attributes.get('classname');
        if (caseName === '' || caseName.length > MAX_JUNIT_NAME_CHARS ||
            (classname !== undefined && classname.length > MAX_JUNIT_NAME_CHARS)) return refuse();
        if (state.cases >= MAX_ADAPTER_EVENTS) return refuse();
        state.cases += 1;
        testcase = {
          name: caseName,
          classname: classname === undefined || classname === '' ? suite.name : classname,
          file: attributes.get('file') ?? null,
          failed: false,
          skipped: false,
        };
        return true;
      }
      if (testcase !== null && parent === 'testcase') {
        if (JUNIT_FAILED_CHILDREN.has(name)) {
          testcase.failed = true;
          if (name === 'failure') suite.failureElements += 1;
        } else if (name === 'skipped') {
          testcase.skipped = true;
        }
      }
      return true;
    },
    onClose(name) {
      path.pop();
      if (name === 'testcase' && testcase !== null) {
        if (!recordJunitCase(state, suite, testcase)) refused = true;
        testcase = null;
        return;
      }
      // ★★ The Gradle exception (dialect memo §2.3): its writer returns an EMPTY failure list
      //   for a failing test whose engine died, so "no child means it passed" is a silent lie
      //   there. A suite claiming more failures than it shows is therefore information loss, and
      //   information loss is not trusted evidence. It is checked only for a document whose ROOT
      //   is `<testsuite>` - the one-file-per-class shape Gradle and Surefire write - because
      //   Vitest, whose root is always `<testsuites>`, is measured to double-count `failures`
      //   over nested suites, and applying the rule there would destroy the one grade (A) whose
      //   witnesses this adapter exists to issue.
      if (name === 'testsuite' && suite !== null) {
        if (suite.root && suite.declaredFailures !== null && suite.declaredFailures > suite.failureElements) refused = true;
        suite = null;
      }
    },
  });
  return ok && !refused && testcase === null;
}

/**
 * The generic JUnit-XML adapter. `documents` (directory mode) or `bytes` (one file); every
 * document is parsed independently and the results are SUMMED, because the same FQCN can appear
 * in more than one file and overwriting would drop half a class's results.
 *
 * ★ Any single refused document invalidates the whole evidence. Partial evidence cannot ground a
 *   regression claim - "the suite passed" read off the files that happened to parse is exactly
 *   the false green this layer exists to prevent.
 */
function parseJunitEvidence(evidence, witnessPolicy) {
  const documents = Array.isArray(evidence.documents)
    ? evidence.documents
    : typeof evidence.bytes === 'string' ? [evidence.bytes] : null;
  if (documents === null || documents.length === 0 || documents.length > MAX_JUNIT_DOCUMENTS) return invalidEvidence();
  let total = 0;
  for (const document of documents) {
    if (typeof document !== 'string' || document === '' || document.length > MAX_ADAPTER_BYTES) return invalidEvidence();
    total += document.length;
    if (total > MAX_ADAPTER_BYTES) return invalidEvidence();
  }
  const state = {
    cases: 0,
    failed: 0,
    witnesses: new Map(),
    unboundFailures: new Set(),
    worktreePath: evidence.worktreePath ?? null,
    policy: witnessPolicy,
  };
  for (const document of documents) {
    if (!readJunitDocument(document, state)) return invalidEvidence();
  }
  if (state.cases === 0) return invalidEvidence('collection');
  const witnessAuthority = [...state.witnesses.values()];
  // ★ Two fingerprint formulas, and which one applies is decided by whether ANY witness was
  //   issued. With witnesses the formula must be `assertion\0<witnessId>`, because that is what
  //   `selectTestDeltaWitnesses` recomputes from the private authority - a name-based digest
  //   there would make every delta selection refuse. With no witness at all (grades C/D/E) the
  //   TRX precedent applies: name-bound digests, which prove nothing about a source path but
  //   still tell two failures apart.
  const failureFingerprints = witnessAuthority.length > 0
    ? witnessAuthority.filter((entry) => entry.outcome === 'fail').map((entry) => sha256(Buffer.from(`assertion\0${entry.witnessId}`, 'utf8')))
    : [...state.unboundFailures].map((name) => sha256(Buffer.from(`junit-xml-v1\0${name}`, 'utf8')));
  return {
    trusted: true,
    complete: true,
    witnessIds: witnessAuthority.map((entry) => entry.witnessId).sort(),
    failureFingerprints: [...new Set(failureFingerprints)].sort(),
    failureKind: state.failed > 0 ? 'assertion' : 'unknown',
    observedOutcome: state.failed > 0 ? 'fail' : 'pass',
    terminalExitCode: null,
    witnessAuthority,
  };
}

function parseAdapterEvidence(adapterEvidence) {
  if (!adapterEvidence || typeof adapterEvidence !== 'object' || !ADAPTER_IDS.has(adapterEvidence.adapterId)) {
    return invalidEvidence('unknown');
  }
  if (adapterEvidence.adapterId === 'junit-xml-v1') {
    return parseJunitEvidence(adapterEvidence, ADAPTER_EVIDENCE_POLICY.get(adapterEvidence) ?? DEFAULT_JUNIT_WITNESS_POLICY);
  }
  if (typeof adapterEvidence.bytes !== 'string') return invalidEvidence('unknown');
  if (adapterEvidence.adapterId === 'node-events-v1') {
    return parseNodeEvidence(
      adapterEvidence.bytes,
      adapterEvidence.worktreePath ?? null,
      ADAPTER_EVIDENCE_POLICY.get(adapterEvidence) ?? DEFAULT_NODE_WITNESS_POLICY,
    );
  }
  if (adapterEvidence.adapterId === 'pytest-events-v1') {
    return parsePytestEvidence(
      adapterEvidence.bytes,
      adapterEvidence.worktreePath ?? null,
      ADAPTER_EVIDENCE_POLICY.get(adapterEvidence) ?? DEFAULT_PYTEST_WITNESS_POLICY,
    );
  }
  return parseTrxEvidence(adapterEvidence.bytes);
}

function observedOutputDigest(raw, execution, rawComplete, adapterAuthorityComplete) {
  if (execution !== 'completed' || !rawComplete || !adapterAuthorityComplete || raw?.truncated !== false ||
      typeof raw.output !== 'string' || raw.outputChars !== raw.output.length) return null;
  // Legacy capture is head/tail-capped. A digest of it must never masquerade as a full-stream digest.
  return sha256(Buffer.from(raw.output, 'utf8'));
}

function classifyWithRequiredAdapter(rawResult, adapterEvidence, requiredAdapterId) {
  const raw = rawResult && typeof rawResult === 'object' ? rawResult : {};
  const parsed = parseAdapterEvidence(adapterEvidence);
  let execution;
  if (raw.aborted === true) execution = 'aborted';
  else if (raw.timedOut === true) execution = 'timeout';
  else if (raw.hung === true) execution = 'hung';
  else if (raw.lingering === true) execution = 'lingering';
  else if (raw.spawnError) execution = 'spawn_error';
  else if (raw.ran === true || typeof raw.exitCode === 'number' || typeof raw.passed === 'boolean') execution = 'completed';
  else execution = 'not_run';

  const rawComplete = (execution === 'completed' || execution === 'lingering') && raw.ran === true &&
    typeof raw.passed === 'boolean' && Number.isInteger(raw.exitCode) && raw.exitCode >= 0 &&
    raw.passed === (raw.exitCode === 0);
  let outcome = rawComplete ? raw.passed ? 'pass' : 'fail' : 'unknown';
  const adapterMismatch = rawComplete && parsed.complete && parsed.observedOutcome !== outcome ||
    rawComplete && parsed.complete && parsed.terminalExitCode !== null && parsed.terminalExitCode !== raw.exitCode;
  const adapterAuthorityComplete = requiredAdapterId === null ||
    ADAPTER_IDS.has(requiredAdapterId) && adapterEvidence?.adapterId === requiredAdapterId &&
      parsed.trusted && parsed.complete && !adapterMismatch;
  if (adapterMismatch) outcome = 'unknown';
  let failureKind = 'unknown';
  if (['spawn_error', 'timeout', 'aborted', 'hung', 'lingering'].includes(execution)) failureKind = 'infrastructure';
  else if (execution === 'completed' && (!rawComplete || adapterMismatch)) failureKind = 'infrastructure';
  else if (execution === 'completed' && raw.failureKind === 'infrastructure') failureKind = 'infrastructure';
  else if (execution === 'completed' && adapterEvidence && !parsed.complete) failureKind = parsed.failureKind;
  else if (execution === 'completed' && outcome === 'fail') {
    const output = String(raw.output ?? '');
    if (adapterEvidence && parsed.failureKind === 'infrastructure') {
      failureKind = 'infrastructure';
    } else if (raw.failureKind === 'collection' || (adapterEvidence && parsed.failureKind === 'collection')) {
      failureKind = 'collection';
    } else if (raw.failureKind === 'compile' || /\b(?:SyntaxError|Compilation failed|Build FAILED)\b/i.test(output)) {
      failureKind = 'compile';
    } else if (raw.failureKind === 'dependency' || MISSING_DEP_SIGNS.some((sign) => output.includes(sign))) {
      failureKind = 'dependency';
    } else if (raw.failureKind === 'infrastructure') {
      failureKind = 'infrastructure';
    } else if (raw.failureKind === 'assertion' && parsed.trusted && parsed.complete && parsed.witnessIds.length > 0) {
      failureKind = 'assertion';
    } else if (parsed.failureKind === 'assertion' && parsed.trusted && parsed.complete) {
      failureKind = 'assertion';
    }
  } else if (execution === 'not_run' && raw.failureKind === 'infrastructure') {
    failureKind = 'infrastructure';
  }

  const acceptWitnesses = execution === 'completed' && rawComplete && !adapterMismatch && parsed.trusted && parsed.complete &&
    (outcome === 'pass' && failureKind === 'unknown' || outcome === 'fail' && failureKind === 'assertion');
  const witnessIds = acceptWitnesses ? parsed.witnessIds : [];
  const failureFingerprints = acceptWitnesses ? parsed.failureFingerprints : [];
  const reproduction = execution === 'completed' && outcome === 'fail' && failureKind === 'assertion' && witnessIds.length > 0;
  const stability = 'unknown';
  const classified = {
    execution,
    outcome,
    failureKind,
    stability,
    reproduction,
    witnessIds,
    failureFingerprints,
    outputSha256: observedOutputDigest(raw, execution, rawComplete, adapterAuthorityComplete),
    outputChars: Number.isInteger(raw.outputChars) && raw.outputChars >= 0
      ? raw.outputChars
      : typeof raw.output === 'string' ? raw.output.length : 0,
  };
  const authority = acceptWitnesses && Array.isArray(parsed.witnessAuthority)
    ? parsed.witnessAuthority.map((entry) => ({ ...entry }))
    : [];
  TEST_RECORD_WITNESS_AUTHORITY.set(classified, deepFreeze(authority));
  return classified;
}

/** Classify one raw runner result without retaining raw output or process objects. */
export function classifyTestExecution(rawResult, adapterEvidence = null) {
  const requiredAdapterId = adapterEvidence === null ? null : adapterEvidence?.adapterId ?? 'invalid';
  return classifyWithRequiredAdapter(rawResult, adapterEvidence, requiredAdapterId);
}

function sameStringList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((value, index) => value === b[index]);
}

function sortedShaList(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !SHA256_PATTERN.test(value))) {
    return null;
  }
  const sorted = [...new Set(values)].sort();
  return sorted.length === values.length ? sorted : null;
}

/** Select path-free witness authority for the exact regression-test delta from an original returned record. */
export function selectTestDeltaWitnesses(record, deltaPaths) {
  const authority = TEST_RECORD_WITNESS_AUTHORITY.get(record);
  if (authority === undefined || !Array.isArray(deltaPaths)) return null;
  const normalizedPaths = deltaPaths.map((path) => safeRelativeSourcePath(path));
  if (normalizedPaths.some((path, index) => path === null || path !== deltaPaths[index]) ||
      new Set(normalizedPaths).size !== normalizedPaths.length) return null;
  const publicWitnesses = sortedShaList(record?.witnessIds);
  const publicFailures = sortedShaList(record?.failureFingerprints);
  if (publicWitnesses === null || publicFailures === null) return null;
  const authorityWitnesses = authority.map((entry) => entry.witnessId).sort();
  const authorityFailures = authority
    .filter((entry) => entry.outcome === 'fail')
    .map((entry) => sha256(Buffer.from(`assertion\0${entry.witnessId}`, 'utf8')))
    .sort();
  if (!sameStringList(publicWitnesses, authorityWitnesses) || !sameStringList(publicFailures, authorityFailures)) {
    return null;
  }
  for (const entry of authority) {
    if (!hasExactKeys(entry, ['adapterId', 'path', 'fullName', 'outcome', 'witnessId']) ||
        !ADAPTER_IDS.has(entry.adapterId) || !['pass', 'fail'].includes(entry.outcome) ||
        safeRelativeSourcePath(entry.path) !== entry.path || normalizeFullTestName(entry.fullName) !== entry.fullName ||
        witnessId(entry.adapterId, entry.path, entry.fullName) !== entry.witnessId) return null;
  }
  const selected = authority.filter((entry) => normalizedPaths.includes(entry.path));
  return deepFreeze({
    witnessIds: selected.map((entry) => entry.witnessId).sort(),
    assertionWitnessIds: selected
      .filter((entry) => entry.outcome === 'fail')
      .map((entry) => entry.witnessId)
      .sort(),
  });
}

// ★ 일부러 `clipCounted` 가 **아니다** — 원소는 문장이 아니라 **코드**이고, 하류(`candidate-lane`·
//   `run-artifacts`)가 `/^[a-z0-9_]{1,64}$/` 로 다시 본다. 꼬리표는 코드 자리에 `…` 를 넣을 뿐이다.
function boundedDiagnostics(values) {
  return [...new Set(values)]
    .filter((value) => typeof value === 'string' && value !== '')
    .slice(0, MAX_DIAGNOSTICS)
    .map((value) => value.slice(0, MAX_DIAGNOSTIC_CHARS));
}

/** 라벨 하나의 상한. 이름은 프로그램 출력이라 길이가 무계다 — 프롬프트 슬롯은 유계여야 한다. */
const FAILING_LABEL_CHARS = 160;

/**
 * 실패한 테스트의 **이름** — `{fingerprint, label}` 로, 지문은 `failureFingerprints` 의 그 지문이고
 * 라벨은 어댑터가 파싱한 `경로 › 이름` 이다. 권위가 없는 기록(어댑터 미장착·신뢰 불가)은 빈 목록.
 *
 * ★★ 왜 생겼나(2026-08-28 라이브 실측, 진짜 저장소·두 벤더): 기계 채널은 pass/fail 과 해시뿐이라
 *   verifier 도 재시도 워커도 **어느 테스트가** 떨어졌는지 몰랐다. 가드가 「헤더를 실측으로 고쳐라」
 *   라고 숫자까지 찍어 주는 실패를 두고 두 실행이 55분씩 같은 자리에서 멈췄다.
 * ★ 원문이 아니다. stdout 한 글자도 안 나간다 — 이벤트 리포터가 구조화한 파일·이름뿐이고, 그것도
 *   프롬프트로만 간다. 봉인 기록·매니페스트·봉투에는 여전히 지문만 실린다(불변식 4 는 모델 산문을
 *   막는 규칙이고 이 값은 프로그램 출력의 구조화 필드다 — 그래도 같은 절제를 지킨다).
 */
function failingTestLabels(record) {
  const authority = TEST_RECORD_WITNESS_AUTHORITY.get(record);
  if (authority === undefined) return deepFreeze([]);
  return deepFreeze(authority
    .filter((entry) => entry.outcome === 'fail')
    .map((entry) => ({
      fingerprint: sha256(Buffer.from(`assertion\0${entry.witnessId}`, 'utf8')),
      label: `${entry.path} › ${entry.fullName}`.slice(0, FAILING_LABEL_CHARS),
    }))
    .sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0)));
}

function persistableRecord(plan, raw, evidence, diagnostics = []) {
  const classified = classifyWithRequiredAdapter(raw, evidence, plan?.adapterId ?? null);
  const record = {
    ...classified,
    // ★★ 설계 §5.8 S1. 이 레코드는 `runTests` 의 `notes` 를 **버린다** — 산문은 아티팩트에 못
    //   들어간다. 그런데 그 `notes` 안에 `USER_PRIVILEGE_NOTE` 하나가 섞여 있었고, 그것이 이
    //   제품이 S1(비밀 유출)에 대해 하는 **유일한** 대응이다. 그래서 산문 대신 그 신고가 딛고 선
    //   사실 하나만 남긴다: 우리가 사용자 권한으로 자식을 **실제로 돌렸는가**.
    //
    // ★ `execution` 으로는 이걸 못 잰다. 스폰 전 중단과 스폰 후 중단이 둘 다 `'aborted'` 라서,
    //   그 값으로 판단하면 한 줄도 안 돌린 실행을 "돌았다"고 신고하게 된다.
    ranWithUserPrivilege: raw?.ran === true,
    planFingerprint: plan?.planFingerprint && SHA256_PATTERN.test(plan.planFingerprint) ? plan.planFingerprint : sha256('invalid-plan'),
    environmentFingerprint:
      plan?.environmentFingerprint && SHA256_PATTERN.test(plan.environmentFingerprint)
        ? plan.environmentFingerprint
        : sha256('invalid-environment'),
    truncated: raw?.truncated === true,
    diagnostics: boundedDiagnostics(diagnostics),
  };
  TEST_RECORD_WITNESS_AUTHORITY.set(record, TEST_RECORD_WITNESS_AUTHORITY.get(classified) ?? deepFreeze([]));
  return record;
}

async function createOwnedEventFile(worktreePath, deps = {}) {
  const suffix = typeof deps.randomSuffix === 'function' ? deps.randomSuffix() : randomBytes(12).toString('hex');
  if (!/^[0-9a-f]{24}$/.test(suffix)) throw new Error('invalid event suffix');
  const path = join(worktreePath, `.bom-orch-test-${suffix}.jsonl`);
  const handle = await (deps.openEventFile ?? open)(path, 'wx', 0o600);
  try {
    await handle.close();
    const info = await (deps.lstatCreatedEventFile ?? lstat)(path);
    const real = await (deps.canonicalCreatedEventFile ?? canonical)(path);
    if (!info.isFile() || info.isSymbolicLink() || real !== path) {
      return { file: { path, identity: null }, error: REASON.test_event_file_creation_unproven };
    }
    return { file: { path, identity: { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs } }, error: null };
  } catch {
    return { file: { path, identity: null }, error: REASON.test_event_file_creation_unproven };
  }
}

async function eventFileUnchanged(file, deps = {}) {
  try {
    if (file.identity === null) return false;
    const info = await (deps.lstatEventFile ?? lstat)(file.path);
    const real = await (deps.canonicalEventFile ?? canonical)(file.path);
    // ★ dev/ino 만으로는 모자란다 — Linux ext4 는 방금 해제한 inode 번호를 다음 생성에 그대로 다시 쓰므로
    //   「지우고 다시 만든」 파일이 우리 것으로 읽힌다(CI 32689796341: 전 셀 붉음, Windows 는 파일 ID 의
    //   시퀀스 번호가 바뀌어 개발 박스에서는 안 보였다). 생성 시각(birthtime)은 제자리 쓰기에서는 그대로이고
    //   재생성에서는 바뀐다. `Object.is` 인 이유: birthtime 을 못 주는 파일시스템은 양쪽이 0 이나 NaN 이라
    //   오늘의 dev/ino 판정으로 퇴화할 뿐 더 나빠지지 않는다.
    return info.isFile() && !info.isSymbolicLink() && real === file.path && info.dev === file.identity.dev && info.ino === file.identity.ino &&
      Object.is(info.birthtimeMs, file.identity.birthtimeMs);
  } catch {
    return false;
  }
}

async function readOwnedEvidence(file, deps = {}) {
  if (!(await eventFileUnchanged(file, deps))) return null;
  const info = await (deps.statEventFile ?? stat)(file.path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ADAPTER_BYTES) return null;
  const bytes = await (deps.readEventFile ?? readFile)(file.path, 'utf8');
  return bytes.length <= MAX_ADAPTER_BYTES ? bytes : null;
}

/**
 * Is `path` still inside `worktreePath` once EVERY component has been followed?
 *
 * ★★ Lexical containment is not containment. `safeRelativeSourcePath` refuses `..` and an `lstat`
 *   refuses a final component that is a symlink, but neither of them sees an INTERMEDIATE one:
 *   with `out -> D:\elsewhere` committed in the repository (or planted by the delegate),
 *   `out/junit.xml` is a lexically clean relative path whose `open(…, 'wx')` creates a file
 *   OUTSIDE the worktree and whose bytes come back as this run's evidence. `canonical` folds
 *   junctions and 8.3 fragments alike (src/real-path.mjs) and resolves a path that does not exist
 *   yet by folding its deepest existing ancestor - which is exactly the moment this gate answers.
 *
 * Both sides are canonicalized: a worktree that is itself reached through a junction would else
 * make every path under it look like an escape.
 */
async function insideCanonicalWorktree(worktreePath, path, canonicalize) {
  const root = await canonicalize(worktreePath);
  const real = await canonicalize(path);
  if (typeof root !== 'string' || typeof real !== 'string') return false;
  const rel = relative(root, real);
  return rel !== '' && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

/**
 * Prepare the project-DECLARED reporter output location (`tests.resultsPath`) before the spawn.
 *
 * Three shapes, and which one applies is measured, never guessed:
 *   · it already exists as a directory -> directory mode, nothing is created (Gradle and Surefire
 *     write one `TEST-<FQCN>.xml` per test class, which is why this mode exists);
 *   · it already exists as a file -> read it afterwards, but this controller does not own it;
 *   · it does not exist and its name ends in `.xml` -> create it `wx` and remember dev/ino/birthtime, the
 *     same ownership proof `createOwnedEventFile` uses.
 *
 * ★★ Why the `.xml` condition rather than always creating: a declared path that is meant to
 *   BECOME a directory (`build/test-results/test`) would be blocked by a file we planted there,
 *   and the producer would fail for a reason we invented. A missing parent directory lands in the
 *   same place - we do not create directories in a worktree we did not write.
 *
 * @returns `{ path, identity, worktreePath }` (identity null = declared but unowned) or null when
 *   the declared path is not a safe relative path that CANONICALLY stays inside the worktree.
 */
async function prepareDeclaredResults(worktreePath, declared, deps = {}) {
  const relativePath = safeRelativeSourcePath(declared);
  if (relativePath === null || typeof worktreePath !== 'string' || !isAbsolute(worktreePath)) return null;
  const path = join(worktreePath, relativePath);
  // The containment gate comes BEFORE the create: a file we plant outside the worktree is already
  // the damage, and answering "unowned" about it afterwards does not take it back.
  if (!(await insideCanonicalWorktree(worktreePath, path, deps.canonicalResults ?? canonical))) return null;
  const target = { path, identity: null, worktreePath };
  try {
    const info = await (deps.lstatEventFile ?? lstat)(path);
    return info.isSymbolicLink() ? null : target;
  } catch {
    // Absent is the only branch that may create anything.
  }
  if (!/\.xml$/i.test(relativePath)) return target;
  try {
    const handle = await (deps.openEventFile ?? open)(path, 'wx', 0o600);
    await handle.close();
    const created = await (deps.lstatCreatedEventFile ?? lstat)(path);
    const real = await (deps.canonicalCreatedEventFile ?? canonical)(path);
    if (!created.isFile() || created.isSymbolicLink() || real !== path) return target;
    return { path, identity: { dev: created.dev, ino: created.ino, birthtimeMs: created.birthtimeMs }, worktreePath };
  } catch {
    return target;
  }
}

/**
 * Read what the producer left at the declared location. Ownership is reported, never enforced:
 * a producer that writes to a temporary file and renames it over ours replaces the inode, and
 * refusing THAT would refuse most producers - the evidence is still parsed, it just carries no
 * witness authority (the runner hands the leaf `UNOWNED_JUNIT_WITNESS_POLICY` for that case).
 *
 * ★ The containment gate is repeated here rather than trusted from before the spawn: what the
 *   child did to the worktree in between is precisely what this function is reading, and a
 *   `results` directory the child replaced with a link to somewhere else is the same escape the
 *   pre-spawn gate refused. A target that carries no `worktreePath` cannot be checked and is
 *   therefore refused - the answer to "I cannot tell" is never "read it anyway".
 *
 * @returns `{ documents, owned }` or null when there is nothing readable within the bounds.
 */
async function readDeclaredResults(target, deps = {}) {
  if (!target || typeof target.path !== 'string') return null;
  if (!(await insideCanonicalWorktree(target.worktreePath, target.path, deps.canonicalResults ?? canonical))) return null;
  let info;
  try {
    info = await (deps.lstatEventFile ?? lstat)(target.path);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) return null;
  if (info.isDirectory()) {
    const documents = await readResultsDirectory(target.path, deps);
    return documents === null ? null : { documents, owned: false };
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ADAPTER_BYTES) return null;
  const owned = target.identity !== null && await eventFileUnchanged(target, deps);
  const bytes = await (deps.readEventFile ?? readFile)(target.path, 'utf8');
  return bytes.length > MAX_ADAPTER_BYTES ? null : { documents: [bytes], owned };
}

/**
 * Directory mode: `TEST-*.xml` only, ordered by `compareUtf8` so two hosts enumerate the same
 * bytes in the same order. Failsafe's `failsafe-summary.xml` is a different schema entirely and
 * the name filter is what keeps it out; the root-element check in `readJunitDocument` is the
 * second line of defence. The whole directory shares the single-document byte budget.
 */
async function readResultsDirectory(path, deps = {}) {
  let entries;
  try {
    entries = await (deps.readdirResults ?? readdir)(path, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.filter((entry) => entry.isFile() && /^TEST-.+\.xml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareUtf8);
  if (names.length === 0 || names.length > MAX_JUNIT_DOCUMENTS) return null;
  const documents = [];
  let total = 0;
  for (const name of names) {
    const full = join(path, name);
    try {
      const info = await (deps.lstatEventFile ?? lstat)(full);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) return null;
      total += info.size;
      if (total > MAX_ADAPTER_BYTES) return null;
      documents.push(await (deps.readEventFile ?? readFile)(full, 'utf8'));
    } catch {
      return null;
    }
  }
  return documents;
}

async function cleanupOwnedEvidence(file, deps = {}) {
  if (!(await eventFileUnchanged(file, deps))) return false;
  try {
    await (deps.removeEventFile ?? rm)(file.path);
    try {
      await (deps.lstatEventFile ?? lstat)(file.path);
      return false;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  } catch {
    return false;
  }
}

function insertNodeReporter(args, reporterPath, eventPath) {
  const at = args.indexOf('--test');
  if (at < 0) return null;
  return [
    ...args.slice(0, at + 1),
    '--test-reporter',
    reporterPath,
    '--test-reporter-destination',
    eventPath,
    ...args.slice(at + 1),
  ];
}
