import { readFile } from 'node:fs/promises';
import { runGit } from './git.mjs';
import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { deepFreeze } from './util/freeze.mjs';

/**
 * 프로젝트 설정 파일 `.bom-orch.json` 의 **런타임 리더** — 로드맵 §3.6 / WS0 §5.
 *
 * ## 읽는 곳: git 오브젝트뿐. 파일시스템으로는 이 파일을 절대 열지 않는다
 *
 * 이 모듈이 하는 모든 읽기는 `git rev-parse <commit>:<path>` + `git cat-file blob <sha>` 다.
 * `readFile` 로 여는 것은 **스키마 파일 하나뿐**이고 설정 파일은 아니다. 그래서 워크트리
 * 사본도 작업 트리 사본도 명령을 정하는 데 쓰이지 않는다 — 정할 수 있는 것은 커밋된
 * 바이트뿐이고, 워커는 자기 워크트리 밖의 커밋을 만들 수 없다.
 *
 * 두 커밋이 이 파이프라인에 있고, 둘이 갈리는 경우를 **거부로** 닫는다:
 *
 *   · 파생 시점(`src/engine.mjs` 의 사전 점검 직후) 사용자 저장소의 **HEAD**. 계획을
 *     동결하는 자리에서 알 수 있는 유일한 커밋이다 — 실행의 봉인 baseline 은 lane-a
 *     워크트리가 HEAD 를 고정한 **뒤에야** 생긴다(`src/engine.mjs:962`).
 *   · lane-a 가 봉인한 **baseline**. `createWorktree` 가 사용자의 미커밋 작업을 이식한 뒤
 *     찍는 커밋이라(`src/worktree.mjs:1203-1212`) 작업 트리 내용을 포함한다.
 *
 * 두 커밋의 `.bom-orch.json` blob 이 다르면 = 사용자가 설정을 **미커밋으로 고쳤다**는
 * 뜻이고, 그때는 `config_uncommitted` 로 거부한다(`verifyProjectConfigSealed`). 절반만
 * 적용하지도, 조용히 무시하지도 않는다 — 사용자가 쓴 설정이 그 실행에 반영되는지 아닌지가
 * 애매한 상태로 크레딧을 쓰는 것이 이 규칙이 막는 것이다. 소스 코드의 미커밋 변경은 지금과
 * 똑같이 그대로 실행된다(그것이 실행의 대상이다). 이 규칙은 **설정 파일 하나**에만 건다.
 *
 * ## 스키마가 유일 정본 — 여기서 모양을 다시 적지 않는다
 *
 * `contract/project-config.schema.json` 을 런타임에 읽어 그것을 해석해 검증한다. 새 npm
 * 의존성이 없으므로 draft-07 의 **부분집합 해석기**를 직접 든다(`SUPPORTED_KEYWORDS`).
 * 스키마가 해석기에 없는 구문을 쓰기 시작하면 검증이 조용히 그 구문을 건너뛰게 되므로,
 * `unsupportedSchemaConstructs()` 가 그 구문 목록을 내고 `test/project-config.test.mjs` 의
 * 대조 테스트가 그 목록이 비어 있을 때만 초록이다. 타입 **값**(`type: 'boolean'` 같은)도
 * 같은 방식으로 잰다 — 키워드는 아는데 값이 낯설면 그것도 조용한 통과다.
 *
 * ## 방향 규칙
 *
 * 이 파일은 artifact 저장소 쪽 모듈(`run-artifacts`·`run-store-fs`·`run-records`·
 * `run-inspect`)을 **하나도 수입하지 않는다.** 설정은 저장소보다 앞선 사실이다 — 실행이
 * 무엇을 저장할지 정하기 전에 무엇을 돌릴지가 정해진다. 반대 방향도 없다: 저장소 모듈이
 * 이 파일을 수입하지 않는다.
 *
 * ★ 실측 폐포: **9개 모듈 / 4,613줄**(자기 자신 489 포함) — `git`(1,128)과 그것이 끄는
 *   `providers/error-catalog`(437)·`providers/resolve-binary`(291)·`state-root`(34),
 *   `reason-codes`(716)·`reason-text`(1,294), `util/freeze`(43)·`util/strings`(181).
 *   저장소 모듈은 **0개**이고 `content-projection` 도 `run-*` 도 없다.
 * ★ 수입하는 쪽(실측 grep): `src/engine.mjs`(`verifyProjectConfigSealed`) · `src/test-discovery.mjs`
 *   (`PROJECT_CONFIG_FILE`·`readProjectConfig`) · `src/deps-provision.mjs`(`PROJECT_CONFIG_FILE`, 태스크 5) ·
 *   `test/project-config.test.mjs` · `test/test-discovery.test.mjs`(동적). 「셋뿐」이라고 적혀 있던 자리다.
 *
 * ## 측정해서 얻은 git 사실 둘
 *
 * ★ `git rev-parse --verify --quiet <commit>:<path>` 는 있으면 exit 0 + blob sha 를,
 *   **없으면 exit 1 에 stdout·stderr 둘 다 빈 문자열**을 낸다(실측, git 2.55.0). 존재하지
 *   않는 커밋을 물어도 **똑같이** exit 1 + 빈 출력이라 둘을 가를 수 없다 — 그래서 이
 *   모듈은 커밋이 이미 검증된 값이라는 것을 전제로 받는다(HEAD 는 `inspectRepo` 가,
 *   baseline 은 `resolveRevisionIdentity` 가 검증한 뒤에 온다). 그 전제 위에서 exit 1 은
 *   "그 커밋에 이 파일이 없다" 이고, 없는 것은 **없는 설정**이지 오류가 아니다.
 *   ★★ 그 독해는 **정확히 그 모양에만** 건다(`configBlobId`): 스폰됐고 · exit 1 이고 ·
 *      stdout·stderr 가 둘 다 비었을 때. `runGit` 의 실패 모양들은 이 셋 중 하나를 반드시
 *      어기므로(스폰 전 거부와 스폰 실패와 미살해는 `exitCode: null`, 말을 남긴 비0 종료는
 *      stderr 가 비지 않는다) 「없다」와 「git 이 실패했다」가 값으로 갈린다. 실패를 없음으로
 *      접으면 사용자가 쓴 설정이 **조용히 무시된 채** 실행이 돈다 — 이 모듈이 막는 것이 그것이다.
 * ★ `runGit` 은 stdout 에 상한이 없다(실측: `child.stdout.on('data')` 가 문자열에 그대로
 *   누적한다 — `src/git.mjs`). 그래서 바이트를 읽기 **전에** `cat-file -s` 로 크기를 먼저
 *   묻고 상한을 넘으면 열지 않는다. 상한의 출처는 스키마 description 의 `<=64 KiB` 이고,
 *   그 문장이 바뀌면 대조 테스트가 붉어진다.
 */

/** 저장소 루트의 고정된 이름. 위치도 이름도 스키마 title 이 정본이다. */
export const PROJECT_CONFIG_FILE = '.bom-orch.json';

/** 스키마 description 의 `<=64 KiB`. 여기 상한이 있는 이유는 위 §측정해서 얻은 git 사실. */
export const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;

/** 이 서버가 구현하는 스키마 세대. 스키마의 `schemaVersion.const` 와 같아야 한다. */
export const SUPPORTED_SCHEMA_VERSION = 1;

const GIT_TIMEOUT_MS = 15_000;

/**
 * 설치 레이아웃. `src/test-evidence.mjs` 의 `resolveTestAssetUrl` 과 **같은 하나의 빌드
 * 정의**를 읽는다(`scripts/lib/build-bundle.mjs` 의 `TEST_ASSET_LAYOUT_DEFINE`) — 레이아웃
 * 계약이 둘이 되면 한쪽만 맞는 설치본이 생긴다. 체크아웃에서는 이 식별자가 선언조차 되지
 * 않으므로 `typeof` 가 유일하게 안전한 읽기다.
 */
const SCHEMA_LAYOUT =
  typeof __BOM_ORCH_TEST_ASSET_LAYOUT__ === 'string' ? __BOM_ORCH_TEST_ASSET_LAYOUT__ : 'source';

/**
 * 스키마 파일의 위치. 탐색도 폴백도 없다 — 두 레이아웃만 존재하고, 어느 쪽에서도 못 열면
 * 그것은 패키징 결함이지 사용자 설정의 문제가 아니다(그 사실이 `detail` 로 나간다).
 */
export function resolveProjectConfigSchemaUrl({ moduleUrl = import.meta.url, layout = SCHEMA_LAYOUT } = {}) {
  const names = {
    source: '../contract/project-config.schema.json',
    dist: './project-config.schema.json',
  };
  if (!Object.hasOwn(names, layout)) throw new TypeError('unknown project-config schema layout');
  return new URL(names[layout], moduleUrl);
}

/** 스키마를 읽어 파싱한다. 테스트는 `deps.schema` 로 다른 스키마를 넣어 해석기를 잰다. */
export async function loadProjectConfigSchema(deps = {}) {
  if (deps.schema !== undefined) return deps.schema;
  const url = deps.schemaUrl ?? resolveProjectConfigSchemaUrl();
  return JSON.parse(await readFile(url, 'utf8'));
}

// ── 스키마 부분집합 해석기 ────────────────────────────────────────────────

/** 값에 영향이 없는 주석용 키워드. 있어도 검증이 달라지지 않는다. */
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'default']);

/** 실제로 값을 거르는 키워드. 이 집합 **밖의** 키워드는 조용히 무시되지 않고 신고된다. */
const VALIDATING_KEYWORDS = new Set([
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength',
  'pattern', 'if', 'then',
]);

/** 해석기가 실제로 구별하는 `type` 값. 낯선 타입 이름도 조용한 통과이므로 함께 잰다. */
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean']);

/** 하위 스키마가 들어 있는 자리. 여기만 재귀한다 — `enum`·`const`·`examples` 는 값이다. */
function subschemas(schema) {
  const found = [];
  if (isPlainObject(schema.properties)) {
    for (const [name, value] of Object.entries(schema.properties)) found.push([`properties.${name}`, value]);
  }
  if (isPlainObject(schema.items)) found.push(['items', schema.items]);
  if (isPlainObject(schema.additionalProperties)) found.push(['additionalProperties', schema.additionalProperties]);
  for (const name of ['if', 'then']) {
    if (isPlainObject(schema[name])) found.push([name, schema[name]]);
  }
  return found;
}

/**
 * 스키마가 쓰는 구문 중 이 해석기가 **구현하지 않은** 것들. 빈 배열이면 스키마 전체가
 * 실제로 검증된다는 뜻이고, 비어 있지 않으면 그 구문은 지금 조용히 통과하고 있다.
 *
 * ★ 이 함수가 대조 테스트의 전부다: 스키마에 `oneOf` 한 줄이 들어오는 순간 목록이 자라고
 *   테스트가 붉어진다. 스키마 진화가 검증을 조용히 건너뛰는 길은 이것 하나뿐이다.
 */
export function unsupportedSchemaConstructs(schema, path = '#') {
  if (!isPlainObject(schema)) return [];
  const found = [];
  for (const key of Object.keys(schema)) {
    if (ANNOTATION_KEYWORDS.has(key) || VALIDATING_KEYWORDS.has(key)) continue;
    found.push(`${path}: ${key}`);
  }
  if (typeof schema.type === 'string' && !SUPPORTED_TYPES.has(schema.type)) {
    found.push(`${path}: type=${schema.type}`);
  }
  if (Array.isArray(schema.type)) found.push(`${path}: type[]`);
  // ★ `if`/`then` 은 **객체 값에만** 걸린다 — `checkAgainst` 가 그 둘을 `isPlainObject(value)`
  //   분기 **안**에서 평가하기 때문이다. 그래서 문자열·배열 하위 스키마(또는 `type` 을 아예 안
  //   적은 자리)에 붙은 조건은 지금 조용히 건너뛰어진다. 키워드를 아는 것과 그 자리에서 실제로
  //   거는 것은 다른 사실이고, 이 함수가 약속하는 것은 후자다.
  for (const key of ['if', 'then']) {
    if (Object.hasOwn(schema, key) && schema.type !== 'object') found.push(`${path}: ${key} outside type=object`);
  }
  for (const [name, child] of subschemas(schema)) {
    found.push(...unsupportedSchemaConstructs(child, `${path}/${name}`));
  }
  return found;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(a, b) {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function typeMatches(value, type) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  // 낯선 타입 이름은 `unsupportedSchemaConstructs` 가 이미 신고한다. 여기서는 통과시키지
  // 않는다 — 모르는 제약을 만족했다고 말하는 것보다 거부가 낫다.
  return false;
}

/**
 * 인스턴스 하나를 스키마 하나에 댄다. 첫 위반 문장 하나를 낸다(전부 모으지 않는다 —
 * `detail` 은 봉투의 평면 필드 한 칸이고, 사용자가 먼저 고칠 것은 첫 번째다).
 *
 * @returns 위반 문장(string) 또는 null.
 */
function checkAgainst(value, schema, path) {
  if (!isPlainObject(schema)) return null;
  const at = path === '' ? 'the configuration' : path;

  if (typeof schema.type === 'string' && !typeMatches(value, schema.type)) {
    return `${at} must be of type ${schema.type}`;
  }
  if (Object.hasOwn(schema, 'const') && !sameValue(value, schema.const)) {
    return `${at} must be ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((one) => sameValue(one, value))) {
    return `${at} must be one of ${schema.enum.map((one) => JSON.stringify(one)).join(', ')}`;
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      return `${at} must be at least ${schema.minLength} characters long`;
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      return `${at} must be at most ${schema.maxLength} characters long`;
    }
    if (typeof schema.pattern === 'string') {
      // ★ `u` 플래그를 붙이지 않는다. draft-07 의 `pattern` 은 ECMA-262 의 **비유니코드**
      //   문법이고, 유니코드 모드는 그 문법에서 합법인 이스케이프 일부를 던진다 — 던지면
      //   이 함수의 호출부가 봉투 대신 거부된 프로미스를 받는다. 컴파일 실패는 조용히
      //   통과시키지 않고 위반으로 낸다.
      let pattern;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        return `${at} cannot be checked because the schema pattern does not compile`;
      }
      if (!pattern.test(value)) return `${at} does not match the pattern the schema requires`;
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return `${at} must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return `${at} must have at most ${schema.maxItems} items`;
    }
    if (isPlainObject(schema.items)) {
      for (const [index, item] of value.entries()) {
        const failed = checkAgainst(item, schema.items, `${at}[${index}]`);
        if (failed !== null) return failed;
      }
    }
  }
  if (isPlainObject(value)) {
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, name)) return `${at === 'the configuration' ? '' : `${at}.`}${name} is required`;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of Object.keys(value)) {
      const child = properties[name];
      if (child === undefined) {
        if (schema.additionalProperties === false) {
          return `${name} is not a key ${at === 'the configuration' ? 'the configuration' : at} accepts`;
        }
        continue;
      }
      const failed = checkAgainst(value[name], child, at === 'the configuration' ? name : `${at}.${name}`);
      if (failed !== null) return failed;
    }
    // `if`/`then` 은 이 스키마가 쓰는 유일한 조건 구문이다(`reporter` 가 junit-xml·dotnet-trx
    // 면 `resultsPath` 가 필수). `if` 가 맞을 때만 `then` 을 건다 — draft-07 의 뜻 그대로다.
    if (isPlainObject(schema.if) && isPlainObject(schema.then) && checkAgainst(value, schema.if, at) === null) {
      const failed = checkAgainst(value, schema.then, at);
      if (failed !== null) return failed;
    }
  }
  return null;
}

/**
 * 스키마가 `default` 를 적은 자리에 값이 없으면 그 기본값을 채운다. **부모 객체가 실제로
 * 있을 때만** 채운다 — draft-07 의 `default` 는 주석이고, 없는 `tests` 를 이 함수가
 * 만들어 내면 사용자가 쓰지 않은 설정을 우리가 지어내는 셈이 된다.
 */
function withDefaults(value, schema) {
  if (!isPlainObject(value) || !isPlainObject(schema.properties)) return value;
  const filled = {};
  for (const [name, child] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, name)) {
      filled[name] = withDefaults(value[name], child);
      continue;
    }
    if (isPlainObject(child) && Object.hasOwn(child, 'default')) filled[name] = child.default;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!Object.hasOwn(filled, name)) filled[name] = entry;
  }
  return filled;
}

/**
 * 파싱된 값 하나를 스키마에 대고 정규화한다.
 *
 * `schemaVersion` 이 이 서버가 아는 세대보다 **위**인 것은 다른 위반과 다른 사실이다:
 * 사용자 파일이 틀린 것이 아니라 서버가 낡은 것이다(불변식 9 의 상위 버전 안전 후퇴).
 * 그래서 스키마 검증보다 **먼저** 보고 별도 코드로 낸다 — 새 세대가 늘린 키를
 * `additionalProperties: false` 가 먼저 잡으면 사용자는 "고칠 수 없는 오타" 를 본다.
 *
 * @returns `{ ok: true, config }` 또는 `fail()` 봉투(`config_schema_newer`·`config_invalid`).
 */
export function validateProjectConfig(value, schema) {
  const version = isPlainObject(value) ? value.schemaVersion : undefined;
  if (Number.isInteger(version) && version > SUPPORTED_SCHEMA_VERSION) {
    return fail(REASON.config_schema_newer, {
      file: PROJECT_CONFIG_FILE, version, supported: SUPPORTED_SCHEMA_VERSION,
    });
  }
  const unsupported = unsupportedSchemaConstructs(schema);
  if (unsupported.length > 0) {
    // 해석기가 못 재는 스키마로 "통과" 를 선언하지 않는다. 대조 테스트가 이 상태를 저장소
    // 안에서 막지만, 설치본에 낡은 코드와 새 스키마가 함께 놓이는 창은 그 테스트 밖이다.
    return fail(REASON.config_invalid, {
      file: PROJECT_CONFIG_FILE,
      detail: `this server cannot validate the schema constructs ${unsupported.join(', ')}`,
    });
  }
  const failed = checkAgainst(value, schema, '');
  if (failed !== null) return fail(REASON.config_invalid, { file: PROJECT_CONFIG_FILE, detail: failed });
  return { ok: true, config: deepFreeze(withDefaults(value, schema)) };
}

// ── baseline 읽기 ─────────────────────────────────────────────────────────

/**
 * 실패한 git 실행 하나를 `{detail}` 한 조각으로. **코드가 아니라 detail 로 나른다** — 등재된
 * git 코드(`src/reason-codes.mjs` 의 `git` 행)는 전부 「봉투의 reasonCode 가 아니다」로 등재돼
 * 있고, 실제로 `runGit` 결과가 코드를 들고 오는 것은 스폰 **전** 거부와 `git_process_unkillable`
 * 뿐이다(스폰 실패도 비0 종료도 `reasonCode: null`). 그 사실을 나르는 자리는 이 저장소에서
 * 언제나 도메인 코드의 `{detail}` 이었고(`src/worktree.mjs` 의 `gitReason`/`failGit`, 25곳),
 * 여기서도 같은 길을 쓴다 — 다만 코드는 `config_unreadable` 이다.
 */
function gitFailureDetail(result) {
  const exit = Number.isInteger(result?.exitCode) ? `exit ${result.exitCode}` : 'no exit status';
  const said = typeof result?.stderr === 'string' && result.stderr.trim() !== ''
    ? result.stderr
    : typeof result?.stdout === 'string' ? result.stdout : '';
  const first = said.split('\n')[0].trim();
  // 한 줄만, 그리고 짧게. 렌더가 `MAX_PARAM_CHARS`(200) 로 한 번 더 자르지만 그 상한은 이
  // 문장 **전체**의 것이라, 여기서 안 자르면 앞머리("git could not …")가 밀려 나간다.
  return first === '' ? exit : `${exit}: ${first.slice(0, 120)}`;
}

/**
 * git 실패를 이 모듈의 거부로 옮긴다. 어느 자리에서 실패했는지는 `what` 이 말한다.
 *
 * ★★ 코드가 `config_invalid` 가 **아닌** 이유(WS4a 태스크 11, 리뷰 m21). 여기서 실패한 것은
 *   사용자 파일이 아니라 **git 호출**이다. `config_invalid` 의 회복은 「{file} 을 스키마에 맞게
 *   고치고, 커밋하고, 다시 실행하라」인데, 그것은 파일이 멀쩡한 사용자를 없는 오타를 찾게
 *   만드는 조언이다. 실제로 할 수 있는 움직임은 다시 시도하는 것과 이 저장소에서 git 이
 *   도는지 보는 것뿐이고, `config_unreadable` 의 회복이 그 둘을 적는다. 스키마·JSON·크기 갈래는
 *   그대로 `config_invalid` 다 — 그쪽은 정말로 파일을 고쳐야 한다.
 */
function refuseGitFailure(what, result) {
  return fail(REASON.config_unreadable, {
    file: PROJECT_CONFIG_FILE, detail: `${what} (${gitFailureDetail(result)})`,
  });
}

/**
 * 한 커밋의 `.bom-orch.json` blob sha 를 **세 갈래로** 답한다: 있음(`{ok:true, blob}`) ·
 * 없음(`{ok:true, blob:null}`) · git 실패(`fail(config_unreadable)`).
 *
 * ★ 갈래가 셋인 이유. 예전에는 `!found.ok` 를 통째로 null 로 접었다 — 그러면 "그 커밋에 이
 *   파일이 없다" 와 "git 이 실패해서 있는지조차 모른다" 가 같은 값이 되고, 그 값은 위쪽에서
 *   **설정이 없는 실행**으로 읽힌다. 사용자가 쓴 설정이 무시된 채 실행이 도는 바로 그 결과다.
 * ★ 없음의 정확한 모양(위 §측정해서 얻은 git 사실): **exit 1 이고 stdout·stderr 가 둘 다
 *   비었고 스폰은 됐다.** `runGit` 의 실패 모양들은 이 셋 중 하나를 반드시 어긴다 —
 *   스폰 전 거부는 `exitCode: null` 에 문장을 stderr 로 싣고(`src/git.mjs:678`), 스폰 실패는
 *   `exitCode: null` + `failed: true`(`:892`), 죽지 않는 프로세스는 `exitCode: null`(`:928-937`),
 *   말을 남긴 비0 종료는 stderr 가 비지 않는다(`:946-957`). 그래서 이 셋을 **전부** 요구한다.
 */
async function configBlobId({ commit, cwd }, deps = {}) {
  const run = deps.run ?? runGit;
  const found = await run({
    args: ['rev-parse', '--verify', '--quiet', `${commit}:${PROJECT_CONFIG_FILE}`],
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (found.ok !== true) {
    const absent = found.failed !== true && found.exitCode === 1 && found.stdout === '' && found.stderr === '';
    if (!absent) return refuseGitFailure('the repository could not say whether it exists', found);
    return { ok: true, blob: null };
  }
  const id = typeof found.stdout === 'string' ? found.stdout.trim() : '';
  // 성공했는데 blob 이름이 아닌 것이 왔다 — 있는지 없는지 모르는 답이므로 없음으로 접지 않는다.
  if (!/^[0-9a-f]{40,64}$/.test(id)) return refuseGitFailure('the repository named no object for it', found);
  return { ok: true, blob: id };
}

/**
 * baseline 커밋의 설정. **없으면 설정이 없는 것이고 그것은 오류가 아니다** — 오늘의 동작이
 * 그대로 유지된다(로드맵 §3.6: "그 커밋에 없으면 없는 것으로 친다").
 *
 * @param {{commit: string, cwd: string}} where 검증된 커밋과 그 오브젝트를 볼 수 있는 저장소.
 * @returns `{ ok: true, config: null }`(없음) · `{ ok: true, config, text, blob }`
 *   (있음) · `fail()` 봉투(`config_schema_newer` · 파일이 틀린 `config_invalid` · 저장소가
 *   바이트를 못 준 `config_unreadable`). **절반 적용은 없다.**
 */
export async function readProjectConfig(where, deps = {}) {
  // ★ **절대 던지지 않는다.** 유일한 프로덕션 호출부(`deriveTestCommand`)는 자기 본문 전체를
  //   `catch { return null }` 로 감싸고 있어서, 여기서 던지면 "설정이 없다" 와 구별되지 않는
  //   조용한 후퇴가 된다 — 사용자가 쓴 설정이 무시된 채 실행이 도는 바로 그 결과다.
  try {
    return await readConfigAt(where, deps);
  } catch (error) {
    // 던진 것은 대부분 git 왕복이다(파싱과 스키마 읽기는 안에서 이미 잡힌다). 그래서 이 그물도
    // 「읽지 못했다」 쪽이다 — 코드가 갈리면 같은 문장이 두 회복을 갖게 된다.
    return fail(REASON.config_unreadable, { file: PROJECT_CONFIG_FILE, detail: `it could not be read (${error?.message ?? 'unknown error'})` });
  }
}

async function readConfigAt({ commit, cwd }, deps = {}) {
  const run = deps.run ?? runGit;
  const found = await configBlobId({ commit, cwd }, deps);
  if (found.ok !== true) return found;
  if (found.blob === null) return { ok: true, config: null };
  const blob = found.blob;

  const sized = await run({ args: ['cat-file', '-s', blob], cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (sized.ok !== true) return refuseGitFailure('its size could not be read from the repository', sized);
  const size = Number.parseInt(String(sized.stdout).trim(), 10);
  if (!Number.isInteger(size)) {
    return fail(REASON.config_unreadable, { file: PROJECT_CONFIG_FILE, detail: 'its size could not be read from the repository' });
  }
  if (size > MAX_PROJECT_CONFIG_BYTES) {
    return fail(REASON.config_invalid, {
      file: PROJECT_CONFIG_FILE, detail: `it is ${size} bytes and the limit is ${MAX_PROJECT_CONFIG_BYTES}`,
    });
  }

  const read = await run({ args: ['cat-file', 'blob', blob], cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (read.ok !== true) return refuseGitFailure('its bytes could not be read from the repository', read);
  if (typeof read.stdout !== 'string') {
    return fail(REASON.config_unreadable, { file: PROJECT_CONFIG_FILE, detail: 'its bytes could not be read from the repository' });
  }
  const text = read.stdout;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(REASON.config_invalid, { file: PROJECT_CONFIG_FILE, detail: `it is not strict JSON (${error.message})` });
  }

  let schema;
  try {
    schema = await loadProjectConfigSchema(deps);
  } catch (error) {
    // 패키징 결함이다(스키마가 설치본에 없다). 사용자 파일이 틀렸다고 말하지 않는 것은
    // `detail` 이고, 코드는 「이 설정을 검증할 수 없었다」는 같은 사실을 나른다.
    return fail(REASON.config_invalid, {
      file: PROJECT_CONFIG_FILE, detail: `the validation schema could not be read (${error.message})`,
    });
  }

  const validated = validateProjectConfig(parsed, schema);
  if (validated.ok !== true) return validated;
  return { ok: true, config: validated.config, text, blob };
}

/**
 * 파생이 읽은 커밋과 실행이 봉인한 baseline 이 **같은 설정 바이트**를 담고 있는지 본다.
 * 둘 다 없으면 같다(설정이 없는 실행이다). 하나만 있거나 blob 이 다르면 거부한다 —
 * 추가·수정·삭제 셋이 모두 같은 한 사실이다: 이 실행이 읽은 설정은 사용자가 지금 보고
 * 있는 설정이 아니다.
 *
 * ★★ **fail-closed.** 조회가 하나라도 실패하면 그 실패를 그대로 낸다 — 「모른다」 둘을 맞대어
 *   같다고 선언하면 대조가 통째로 무의미해지고(예전 코드는 두 실패를 `null === null` 로 접어
 *   `{ok:true}` 를 냈다), 한쪽만 실패한 경우에는 「사용자가 설정을 미커밋으로 고쳤다」는
 *   **지어낸 사실**이 봉투로 나간다. 그래서 비교는 두 답을 실제로 얻은 뒤에만 한다.
 *
 * @returns `{ ok: true }` · `fail(config_uncommitted)` · `fail(config_unreadable)`(git 실패).
 */
export async function verifyProjectConfigSealed({ cwd, derivedCommit, sealedCommit }, deps = {}) {
  const derived = await configBlobId({ commit: derivedCommit, cwd }, deps);
  if (derived.ok !== true) return derived;
  const sealed = await configBlobId({ commit: sealedCommit, cwd }, deps);
  if (sealed.ok !== true) return sealed;
  if (derived.blob === sealed.blob) return { ok: true };
  return fail(REASON.config_uncommitted, { file: PROJECT_CONFIG_FILE });
}
