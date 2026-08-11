/**
 * MCP 툴 표면. 저수준 Server 가 부를 `listTools`/`callTool` 과, 서버가 진행 알림을
 * 만들 때 쓰는 `makeProgressReporter` 를 낸다 — 뒤엣것은 순수 함수가 아니라 배선이다.
 *
 * 지금 있는 도구는 `TOOL_SPECS` 가 권위다 — 여기 목록을 글자로 적으면 도구가 늘 때
 * 조용히 갈린다. 설계 §8.1 이 적은 다섯 중 아직 없는 것은 `HANDLERS` 에 없는 이름이다.
 */
import { listProviders } from './providers/index.mjs';
import { resolveStateRoot } from './state-root.mjs';
import { POINT_OF_USE_MAX_AGE_MS, readCatalog, shouldRefresh, writeCatalog } from './providers/catalog.mjs';
import { MAX_CONTENT_CHARS, failure, success, validateArgs } from './envelope.mjs';
import { MAX_BUDGET, runOrchestration } from './engine.mjs';
import { TIERS, VENDORS, readSettings, writeSettings } from './config.mjs';
import { AXES, OBSERVATION_THRESHOLD, armAllowed, gradeToDeltas, observationsOf } from './learn/bandit.mjs';
import { TASK_CLASSES } from './learn/classify.mjs';
import { findRunUnlocked, readRunsUnlocked } from './learn/journal.mjs';
import { join } from 'node:path';
import { GENERATIONS_SNAPSHOT_FILE, SNAPSHOT_FILE, cellKeyOf, commitLearningMutationUnlocked, readPosteriors, readPosteriorsUnlocked, resetPosteriors } from './learn/posteriors.mjs';
import { generationOf, readGenerationsUnlocked, withLearningLock } from './learn/learning.mjs';

const GENERIC_RECOVERY = '설치 상태와 PATH 를 확인하거나 다시 시도하세요.';

/** 어떤 값에서도(toString 이 던지는 값 포함) 사람이 읽을 문자열을 뽑는다. */
function safeErrorText(error) {
  if (typeof error === 'string') return error !== '' ? error : '알 수 없는 오류';
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message;
  try {
    const text = String(error);
    return text !== '' ? text : '알 수 없는 오류';
  } catch {
    return '알 수 없는 오류';
  }
}

/**
 * `orch_stats({runs})` 의 상한.
 *
 * ★★ **이 수는 응답 크기의 보증이 아니다 — 보증은 `renderStats` 의 축소 사다리가 한다.**
 *   앞선 라운드에 여기 적었던 "50건이 9,800자쯤으로 아슬아슬하게 들어간다" 는 **셀이 없는
 *   저장소에서만** 참이었다. 조건을 달아 다시 적는다.
 *   실측(수정 라운드 1 · `test/tools.test.mjs` 의 크기 픽스처를 그대로 태운 프로브,
 *   지금 트리의 `recentView`·`cellView` 모양):
 *     · `runs:0`(기본) — 셀이 없으면 **64자**, 4클래스×4축=16셀이면 **4,447자**.
 *     · 네 축이 다 실린 기록 하나 = runId 108자면 **280자**, `makeRunId` 가 내는 실제
 *       runId(**19자**)면 **191자**.
 *     · `runs:50` · 셀 없음 — 실제 runId 로 **9,693자**(사다리 안 탐, 여유 **3.1%**),
 *       108자 runId 로는 상한을 넘겨 사다리가 **25건 · 7,162자**로 줄인다.
 *     · `runs:50` · 16셀 — 실제 runId 로도 **사다리가 탄다**(25건 · 9,320자).
 *       ★ 셀까지 있는 성숙한 저장소에서는 50건이 그냥 안 들어간다.
 *   상한을 두는 것은 "저널 전체를 실어 달라" 는 호출을 스키마에서 미리 막기 위해서다 —
 *   `readRuns` 의 기본 창은 500건이고, 그것을 그대로 받으면 사다리가 매번 그 목록의 대부분을
 *   버리는 일을 하게 된다.
 */
const MAX_RECENT_RUNS = 50;

/**
 * 도구 스펙. 얼려서 낸다 — 호출부가 실수로 목록을 바꾸면 조용히 다음 요청부터
 * 도구가 늘거나 줄어드는 사고가 난다.
 */
export const TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: 'orch_models',
    description: 'claude·codex 두 벤더의 설치 상태와 사용 가능한 모델 목록을 조회한다.',
    args: Object.freeze({
      refresh: Object.freeze({ type: 'boolean', required: false, default: false }),
    }),
  }),
  Object.freeze({
    name: 'orch_run',
    description:
      '작업을 두 벤더 CLI 로 오케스트레이션한다. 일회용 git 워크트리에서 워커가 고치고, ' +
      '테스트는 이 서버가 직접 돌리며, 검증자가 읽기 전용으로 확인한다. ' +
      '결과는 사용자 저장소에 적용할 수 있는 패치다. ' +
      'project 는 절대 경로여야 한다 — MCP stdio 서버의 cwd 는 호스트가 물려준 값이라 고정돼 있지 않다.',
    args: Object.freeze({
      // 설계 §8.2. 기본값은 **여기**가 권위다 — 엔진 기본값(budget 1 · waitMs 0)은
      // 라이브러리로서의 최소값이라 도구 층에서 설계값으로 덮는다.
      task: Object.freeze({ type: 'string', required: true }),
      // ★ cwd 를 쓰지 않고 절대 경로를 필수로 받는 근거(실측): MCP stdio 서버의 cwd 는
      //   호스트가 물려준 값이라 고정돼 있지 않다. codex 는 자기 cwd 를 그대로 넘긴다.
      //   추측하면 엉뚱한 저장소에 워크트리를 만든다.
      project: Object.freeze({ type: 'string', required: true }),
      // ★ 설계 §8.2 는 `in-place`·`read-only` 도 적었지만 그 문장은 §12.0 **이전**이다.
      //   라이브 실측으로 벤더 CLI 의 도구 권한 플래그가 델리게이트의 셸을 제한하지 못한다는
      //   것이 확인돼, 실제로 성립하는 격리가 일회용 워크트리뿐이 됐다. 엔진도 그 둘을
      //   거부한다. 스키마에 남겨 두면 호출자가 지원되는 줄 알고 고르므로 여기서도 뺀다.
      isolation: Object.freeze({
        type: 'string',
        required: false,
        default: 'worktree',
        enum: ['worktree'],
      }),
      // ★ 수치 제약을 **여기** 적는다. 엔진이 1~10 정수, 0 이상 유한을 강제하는데 도구 층이
      //   그것을 선언도 검증도 안 하면, `budget:2.5` 가 왕복 한 번을 태운 뒤 엔진에서 뒤늦게
      //   거부되고 `budget:NaN` 은 통과한다. 선언과 검증이 어긋나면 그 자체가 결함이다.
      budget: Object.freeze({ type: 'number', integer: true, min: 1, max: MAX_BUDGET, required: false, default: 5 }),
      wait_ms: Object.freeze({ type: 'number', min: 0, required: false, default: 1_800_000 }),
      // 설계 §9.2 는 "한 벤더만으로 조용히 돌려 '됐다'고 하면 요청을 배신한다" 고 못박는다.
      // 그래서 single 은 호출자가 **명시적으로** 허용해야만 밴딧이 뽑을 수 있고(계획 3 §7.2),
      // 기본값은 금지 쪽이다. 실제로 팔을 거르는 자리는 `src/learn/bandit.mjs` 의 `decide` 다.
      allow_single: Object.freeze({ type: 'boolean', required: false, default: false }),
      // ⚠ 설계 §8.2 의 `files`(프로젝트 밖 참고 파일)는 **여기 없다.** 엔진에 소비자가 없어
      //   받아서 버리기만 했고, 선언까지 해 두면 호출자(모델)는 참고 파일을 줬다고 믿고 그
      //   전제 위에서 task 를 짧게 쓴다. 이 기능은 후속 계획으로 이월했다.
    }),
  }),
  Object.freeze({
    name: 'orch_config',
    // 서술자는 매 세션 tools/list 에 실려 토큰을 먹는다(§8.1). 짧게 쓰되, 스키마가
    // 표현할 수 없는 **인자 사이의 의존**(vendor·tier 는 값과 함께 와야 한다)은 적는다 —
    // `toInputSchema` 는 필드별 제약만 옮길 수 있다.
    description:
      '오케스트레이션이 쓸 모델과 effort 를 조회하거나 바꿉니다. ' +
      '인자 없이 부르면 현재 설정과 고를 수 있는 값을 봅니다. ' +
      '바꾸려면 vendor 와 tier 에 model 또는 effort 를 함께 주세요. 빈 문자열은 값을 지웁니다(= CLI 기본값).',
    args: Object.freeze({
      // ★ enum 은 `src/config.mjs` 의 VENDORS 에서 온다 — settings.ini 의 섹션 이름을
      //   아는 것은 그쪽이다. 여기 글자로 적으면 벤더가 늘 때 조용히 갈린다.
      vendor: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...VENDORS]) }),
      // ★ tier 도 같은 이유로 `src/config.mjs` 의 TIERS 에서 온다 — 두 줄 위 주석이
      //   금하는 바로 그 "글자로 적기" 가 여기 남아 있었다.
      tier: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...TIERS]) }),
      model: Object.freeze({ type: 'string', required: false }),
      effort: Object.freeze({ type: 'string', required: false }),
    }),
  }),
  Object.freeze({
    name: 'orch_stats',
    description:
      '학습 통계를 봅니다 — 태스크 클래스 × 결정 축 셀마다 관측 수와 밴딧 활성 여부. ' +
      'runs 를 주면 최근 실행 목록(run_id 포함)도 냅니다. ' +
      'reset 은 사후분포를 지웁니다 — task_class 를 함께 주면 그 클래스의 셀만 지웁니다.',
    args: Object.freeze({
      // ★ enum 은 `src/learn/classify.mjs` 의 TASK_CLASSES 에서 온다 — 클래스를 아는 것은
      //   분류기다. 여기 글자로 적으면 클래스가 늘 때 이 도구만 조용히 뒤처진다
      //   (`VENDORS`↔섹션 · `TIERS`↔밴딧 팔 가드와 같은 축).
      task_class: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...TASK_CLASSES]) }),
      // ★ `orch_reward` 의 recovery 가 "orch_stats 로 최근 실행 목록을 확인하세요" 라고
      //   가리키므로 그 목록이 실제로 나와야 한다. 기본은 끈다 — 서술자·응답 크기를 매 호출
      //   키우지 않기 위해서다. 상한의 근거는 `MAX_RECENT_RUNS` 주석에 있다.
      runs: Object.freeze({ type: 'number', integer: true, min: 0, max: MAX_RECENT_RUNS, required: false, default: 0 }),
      reset: Object.freeze({ type: 'boolean', required: false, default: false }),
    }),
  }),
  Object.freeze({
    name: 'orch_reward',
    description:
      '지난 실행의 평가를 사람이 정정합니다. 이미 반영된 기여를 되돌리고 새 등급을 적용하므로 ' +
      '같은 run_id 로 여러 번 불러도 결과가 같습니다. run_id 는 orch_stats({runs: 20}) 으로 봅니다.',
    args: Object.freeze({
      run_id: Object.freeze({ type: 'string', required: true }),
      good: Object.freeze({ type: 'boolean', required: true }),
      note: Object.freeze({ type: 'string', required: false }),
    }),
  }),
]);

/**
 * 스펙을 JSON Schema 로 옮긴다.
 *
 * ★ 선언은 `validateArgs` 가 **실제로 거부하는 것**과 같아야 한다. 느슨한 선언은 호출자에게
 *   거짓 약속이고(모르는 키를 넣어도 되는 줄 안다), 빡빡한 선언은 통과할 값을 안 보내게 만든다.
 */
function toInputSchema(argsSpec) {
  const properties = {};
  const required = [];
  for (const [key, fieldSpec] of Object.entries(argsSpec)) {
    const property = { type: fieldSpec.integer === true ? 'integer' : fieldSpec.type };
    // 배열이면 원소 타입까지 적는다. `validateArgs` 가 실제로 원소를 검사하므로, 선언에서
    // 빠뜨리면 스키마가 검증보다 느슨해 보이고 호출자가 아무 원소나 넣어도 되는 줄 안다.
    if (fieldSpec.type === 'array' && typeof fieldSpec.items === 'string') {
      property.items = { type: fieldSpec.items };
    }
    // `enum` 은 배열 타입에 적지 않는다 — `validateArgs` 의 배열 분기는 enum 을 보지 않으므로
    // 적으면 선언만 빡빡해진다(그 조합은 현재 스펙에 없다).
    if (Array.isArray(fieldSpec.enum) && fieldSpec.type !== 'array') property.enum = fieldSpec.enum;
    if (typeof fieldSpec.min === 'number') property.minimum = fieldSpec.min;
    if (typeof fieldSpec.max === 'number') property.maximum = fieldSpec.max;
    if (Object.hasOwn(fieldSpec, 'default')) property.default = fieldSpec.default;
    properties[key] = property;
    if (fieldSpec.required) required.push(key);
  }
  // `validateArgs` 는 모르는 키를 하드 거부한다 — 그 사실을 선언에도 적는다.
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * MCP 가 기대하는 `{ name, description, inputSchema }` 목록을 낸다.
 *
 * inputSchema 는 선언용이다 — 저수준 Server 가 이걸로 검증해주지 않으므로 실제
 * 검증은 항상 `validateArgs`(callTool 안)가 한다.
 */
export function listTools() {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toInputSchema(spec.args),
  }));
}

/** provider.describeError 자신이 깨져도 최소 봉투를 낸다. */
function safeDescribeError(provider, error) {
  try {
    const described = provider?.describeError?.(error);
    if (described && typeof described === 'object') {
      return {
        error: typeof described.error === 'string' && described.error !== '' ? described.error : safeErrorText(error),
        recovery:
          typeof described.recovery === 'string' && described.recovery !== '' ? described.recovery : GENERIC_RECOVERY,
      };
    }
  } catch {
    // describeError 자신이 깨진 경우 — 아래 폴백으로 간다.
  }
  return { error: safeErrorText(error), recovery: GENERIC_RECOVERY };
}

/** discover() 가 정상적으로 돌려준 결과를 벤더 리포트 모양으로 다듬는다. */
function normalizeDiscovered(discovered) {
  if (!discovered || typeof discovered !== 'object') {
    return { reachable: false, error: '프로바이더가 알 수 없는 응답을 냈습니다.', recovery: GENERIC_RECOVERY };
  }

  if (discovered.reachable === true) {
    return {
      reachable: true,
      version: typeof discovered.version === 'string' ? discovered.version : null,
      models: Array.isArray(discovered.models) ? discovered.models : [],
    };
  }

  const report = {
    reachable: false,
    error: typeof discovered.error === 'string' && discovered.error !== '' ? discovered.error : '닿을 수 없습니다.',
    recovery:
      typeof discovered.recovery === 'string' && discovered.recovery !== '' ? discovered.recovery : GENERIC_RECOVERY,
  };
  if (discovered.discoveryTimeout === true) report.discoveryTimeout = true;
  return report;
}

/**
 * 한 벤더를 프로브한다. discover 가 던지는 경우까지 포함해 개별적으로 감싼다(★) —
 * 계약(contract.mjs)은 "throw 하지 않는다"고 하지만 강제되지 않고, 서브프로세스
 * 스폰이 동기로 던지는 경우가 실제로 있다. 한쪽이 터지거나 안 닿아도 다른 벤더는
 * 정상 보고돼야 한다.
 *
 * 캐시(Task 7)가 신선하면(POINT_OF_USE_MAX_AGE_MS 안) 프로브를 건너뛴다. refresh
 * 가 참이면 신선해도 강제로 다시 프로브한다.
 */
async function probeVendor(provider, id, { catalog, refresh, stateRoot }) {
  try {
    const cached = catalog?.[id];
    const stale = shouldRefresh(catalog, id, POINT_OF_USE_MAX_AGE_MS);

    if (!refresh && !stale && cached) {
      return { reachable: true, cached: true, fetchedAt: cached.fetchedAt, models: cached.models };
    }

    let discovered;
    try {
      discovered = await provider.discover();
    } catch (error) {
      discovered = { reachable: false, ...safeDescribeError(provider, error) };
    }

    const report = normalizeDiscovered(discovered);

    if (report.reachable && report.models.length > 0) {
      await writeCatalog(stateRoot, id, report.models).catch(() => false);
    }

    return report;
  } catch (error) {
    // 위 블록 어디든(캐시 판정 포함) 예상 못 한 예외가 나도 이 벤더만 실패로
    // 강등한다 — 다른 벤더의 Promise.all 이 통째로 거부되면 안 된다.
    return { reachable: false, ...safeDescribeError(provider, error) };
  }
}

/** `orch_models` 핸들러: 두 벤더의 설치·모델 상태를 낸다. */
async function runOrchModels(value, context) {
  // `orch_run` 과 같은 계약을 쓴다(`toEngineDeps`) — 두 핸들러가 같은 context 필드를 다르게
  // 해석하면 호출자는 어느 쪽이 통하는지 시험해 봐야 한다.
  const wired = toEngineDeps(context);
  const providers = Array.isArray(wired.providers) ? wired.providers : listProviders();
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();
  const refresh = value.refresh === true;

  const catalog = await readCatalog(stateRoot);

  const vendors = {};
  await Promise.all(
    providers.map(async (provider, index) => {
      const id = typeof provider?.id === 'string' && provider.id !== '' ? provider.id : `unknown-${index}`;
      vendors[id] = await probeVendor(provider, id, { catalog, refresh, stateRoot });
    }),
  );

  return success({ content: JSON.stringify({ vendors }) });
}

// ── orch_config ───────────────────────────────────────────────────────────

/** tier(도구 어휘) → `writeSettings` 패치의 필드 이름. TIERS 에서 파생한다. */
const TIER_FIELDS = Object.freeze(
  Object.fromEntries(TIERS.map((tier) => [tier, Object.freeze({ model: tier, effort: `${tier}Effort` })])),
);

/**
 * 고를 수 있는 모델을 벤더별로 낸다.
 *
 * ★ **프로브하지 않는다.** `orch_models` 는 CLI 를 띄워서 조사하지만, 설정을 보는 일이
 *   CLI 두 개를 스폰하는 일이 되면 안 된다 — 설치가 안 됐거나 느린 벤더 하나가 설정
 *   조회를 붙든다. 여기서는 `orch_models`(와 그 캐시)가 남긴 카탈로그만 읽는다.
 */
async function describeCatalog(stateRoot) {
  const catalog = await readCatalog(stateRoot);
  const vendors = {};
  for (const id of VENDORS) {
    const entry = catalog[id];
    vendors[id] = {
      models: Array.isArray(entry?.models) ? entry.models : [],
      fetchedAt: typeof entry?.fetchedAt === 'string' ? entry.fetchedAt : null,
    };
  }
  return vendors;
}

/** 목록을 못 얻은 벤더가 있으면 그 사실을 말한다 — 빈 배열만 내면 "모델이 없다"로 읽힌다. */
function emptyCatalogNotice(vendors) {
  const empty = VENDORS.filter((id) => vendors[id].models.length === 0);
  if (empty.length === 0) return null;
  return (
    `${empty.join(', ')} 의 모델 목록이 비어 있습니다 — orch_models 를 먼저 부르면 카탈로그가 채워집니다. ` +
    '목록이 없는 벤더는 effort 검사를 건너뜁니다.'
  );
}

/**
 * 목록 밖 모델을 **막지 않고** 알린다.
 *
 * ★ 막으면 안 되는 이유(`src/config.mjs` 의 `validateSelection` 이 적은 성질): claude 쪽
 *   목록에는 정식 모델 id 가 **들어올 수 없다.** `src/providers/discover-parse.mjs` 의
 *   `parseClaudeHelp` 이 `alias.startsWith('claude-')` 인 것을 일부러 걸러낸다(별칭만
 *   써야 새 모델이 나와도 안 썩기 때문이다). 그래서 목록 밖 모델을 거부하면, 정식 id 를
 *   적은 사용자는 그 값을 **영영** 못 쓴다. 막지 않고 알리기만 한다.
 *
 * ★ `model` 은 이번 호출의 **인자가 아니라 쓰고 난 뒤의 실효 값**이어야 한다. 인자만
 *   보면 `effort` 만 바꾸는 호출에서 파일에 이미 있던 모델을 한 번도 안 본다 — 손으로
 *   적어 둔 오타 위에 effort 를 얹으면서 아무 말도 안 하게 된다(실측). `writeSettings`
 *   의 `validateMerged` 가 쓰는 원칙과 같다: 조각이 아니라 **합친 결과**를 본다.
 */
function unknownModelNotice(vendorId, model, vendors) {
  if (typeof model !== 'string') return null;
  const name = model.trim();
  if (name === '') return null;
  const list = vendors[vendorId].models;
  if (list.length === 0 || list.some((entry) => entry?.name === name)) return null;
  return `'${name}' 은 지금 발견된 ${vendorId} 목록에 없습니다 — 오타가 아닌지 확인하세요. 새 모델이면 그대로 씁니다.`;
}

function configView(current, vendors, notices) {
  const notice = notices.filter((text) => typeof text === 'string' && text !== '').join(' ');
  return success({
    content: JSON.stringify({ current, vendors }),
    confidence: 'verified',
    notice: notice !== '' ? notice : undefined,
  });
}

/**
 * `orch_config` 핸들러: 설정을 보거나 바꾼다.
 *
 * ★ `vendor` 를 받는 이유: settings.ini 의 섹션이 벤더 id 이고 모델은 벤더마다 다르다.
 *   tier 만 받으면 어느 벤더의 모델인지 알 수 없어 쓸 곳을 정할 수 없다.
 */
async function runOrchConfig(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();
  const vendors = await describeCatalog(stateRoot);

  // `undefined` 로만 "안 줬다"를 판정한다. 빈 문자열은 **지우라는 뜻**이라 다른 값이다.
  const changing = value.model !== undefined || value.effort !== undefined;

  if (!changing) {
    if (value.vendor !== undefined || value.tier !== undefined) {
      return failure({
        status: 'invalid',
        error: 'vendor·tier 만으로는 바꿀 것이 없습니다 — model 이나 effort 를 주세요.',
        recovery: 'model 이나 effort 를 함께 주세요. 조회만 하려면 인자 없이 부르세요.',
      });
    }
    return configView(await readSettings(stateRoot), vendors, [emptyCatalogNotice(vendors)]);
  }

  if (value.vendor === undefined || value.tier === undefined) {
    return failure({
      status: 'invalid',
      error: 'model·effort 를 바꾸려면 vendor 와 tier 를 함께 주세요.',
      recovery: `vendor: ${VENDORS.join(', ')} / tier: ${TIERS.join(', ')}`,
    });
  }

  const fields = TIER_FIELDS[value.tier];
  const patch = { [value.vendor]: {} };
  if (value.model !== undefined) patch[value.vendor][fields.model] = value.model;
  if (value.effort !== undefined) patch[value.vendor][fields.effort] = value.effort;

  // 목록이 빈 벤더는 null 로 넘긴다 — `writeSettings` 는 그때 검사를 건너뛴다.
  const models = {};
  for (const id of VENDORS) models[id] = vendors[id].models.length > 0 ? vendors[id].models : null;

  const wrote = await writeSettings(stateRoot, patch, { models });
  if (!wrote.ok) return failure({ status: 'invalid', error: wrote.error, recovery: wrote.recovery });

  return configView(wrote.settings, vendors, [
    unknownModelNotice(value.vendor, wrote.settings[value.vendor][fields.model], vendors),
    emptyCatalogNotice(vendors),
    wrote.notice,
  ]);
}

// ── orch_stats · orch_reward (계획 3 태스크 10) ───────────────────────────

/**
 * 축마다 화면에 함께 실어야 하는 사실. **화면에만 있는 사실이 아니라 코드의 성질**이다.
 *
 * · `mix` — `decide` 는 관측 게이트보다 **먼저** 후보 팔 수를 본다. `allow_single` 없이는
 *   이 축의 후보가 하나뿐이라 관측이 아무리 쌓여도 기본값으로 돈다(§9.2). 그래서 이 축의
 *   활성 여부는 `armAllowed` 를 함께 봐야 참이 된다 — 아래 `cellView` 가 그렇게 한다.
 * · `placement` — `single` 실행도 이 셀을 갱신한다(태스크 8 결정 ②, `src/engine.mjs` 의
 *   `learnable` 주석). 「누가 혼자 다 하나」와 「누가 먼저 하나」가 **한 셀에 합산**되므로,
 *   이 셀의 수를 배치 비교로만 읽으면 안 된다.
 *
 * ★ 키가 `AXES` 밖으로 새면 그 설명은 어떤 셀에도 안 붙는다 — `test/tools.test.mjs` 의
 *   드리프트 가드가 그것을 막는다. 그래서 내보낸다.
 */
export const AXIS_NOTES = Object.freeze({
  mix: 'allow_single:true 로 부른 실행에서만 이 축의 팔이 둘이 됩니다(설계 §9.2) — 그 전에는 관측이 쌓여도 기본값으로 돕니다.',
  placement:
    'single 실행의 관측도 이 셀에 합산됩니다 — 「누가 먼저 하나」와 「혼자면 누구인가」가 한 셀에 쌓입니다(태스크 8 결정 ②).',
});

/**
 * `cellKeyOf` 를 되돌린다. 구분자는 **첫** `::` 다.
 *
 * ★ `split('::')` 로 두 조각을 꺼내면 손으로 쓴 `a::b::c` 에서 꼬리를 조용히 버리고 축 이름을
 *   `b` 라고 지어낸다 — 있지도 않은 축을 화면에 만드는 것이다. 구분자가 아예 없는 키
 *   (손으로 쓴 파일)는 태스크 클래스도 축도 모르는 것이지 `analysis` 가 아니다.
 */
function splitCellKey(cellKey) {
  const at = cellKey.indexOf('::');
  if (at === -1) return { taskClass: null, axis: null };
  return { taskClass: cellKey.slice(0, at), axis: cellKey.slice(at + 2) };
}

/**
 * 셀 하나를 화면 모형으로.
 *
 * ★★ **화면과 게이트가 같은 것을 세야 한다.** 두 가지가 그것을 어긴 적이 있다:
 *   ① 관측 수를 `Object.values(arms)` 합으로 세기. 밴딧은 `observationsOf(cell, 그 축의 팔)`
 *      로 센다 — 실측(태스크 5): `{medium:{alpha:1,beta:21}}` 는 셀 합 20, 축의 팔로는 0 이다.
 *      화면이 "밴딧 켜짐" 이라고 하는데 게이트는 안 열린다.
 *   ② 관측 수만 보고 활성 여부를 쓰기. `decide` 는 관측 게이트보다 **먼저**
 *      `arms.length < 2` 에서 떨어뜨리므로 `mix` 축은 `allow_single` 없이 영영 안 켜진다.
 *      그래서 여기서도 `armAllowed` 를 쓴다 — 판정을 베끼지 않고 같은 함수를 부른다.
 *
 * ★★ **불리언 하나로는 답이 안 된다 — 활성 여부는 호출자의 `allow_single` 에 달려 있다.**
 *   `banditActive` 라는 이름 하나로 내면 `armAllowed(axis, arm, false)` 를 못박은 값이라
 *   `mix` 축에서 절반만 참이다. 실측(수정 라운드 1): `analysis::mix = {mix:(11,11),
 *   single:(9,2)}` 에서 화면은 `false` 인데 `decide({allowed:{single:true}})` 는
 *   `sources.mix==='bandit'` 로 밴딧을 태운다. `optInArms` 와 `note` 가 산문으로 보완하지만
 *   **불리언만 읽는 소비자**(태스크 12 의 화면)는 그것을 안 읽는다. 그래서 조건을 이름에
 *   담아 두 값을 낸다 — `byDefault` 는 그냥 부른 `orch_run`, `ifAllowSingle` 은
 *   `allow_single:true` 로 부른 `orch_run` 이다. `mix` 밖의 축은 두 값이 늘 같다.
 *
 * ★ `AXES` 에 없는 축(손으로 쓴 셀 · 옛 축)은 `observations: null` 이다. `0` 으로 내면
 *   데이터가 있는데 없다고 거짓말하는 것이다. `Object.hasOwn` 으로 읽는 이유는 셀 키가
 *   `analysis::toString` 일 수 있기 때문이다 — `AXES[axis]` 로 읽으면 프로토타입에서
 *   함수가 나와 `spec.arms.filter` 가 던진다(실측으로 확인했다). `AXIS_NOTES` 도 같은 이유로
 *   `Object.hasOwn` 이다 — `AXIS_NOTES['__proto__']` 는 `Object.prototype` 이라 그대로 두면
 *   셀에 `"note":{}` 가 붙어 나간다(실측).
 */
function cellView(cellKey, arms) {
  const { taskClass, axis } = splitCellKey(cellKey);
  const spec = axis !== null && Object.hasOwn(AXES, axis) ? AXES[axis] : null;
  const observations = spec === null ? null : observationsOf(arms, spec.arms);
  const candidates = spec === null ? [] : spec.arms.filter((arm) => armAllowed(axis, arm, false));
  const withSingle = spec === null ? [] : spec.arms.filter((arm) => armAllowed(axis, arm, true));
  const optInArms = spec === null ? [] : spec.arms.filter((arm) => !armAllowed(axis, arm, false));
  const enough = observations !== null && observations >= OBSERVATION_THRESHOLD;

  const view = {
    cellKey,
    taskClass,
    axis,
    arms,
    observations,
    banditActiveByDefault: enough && candidates.length >= 2,
    banditActiveIfAllowSingle: enough && withSingle.length >= 2,
  };
  if (spec === null) view.unknownAxis = true;
  if (optInArms.length > 0) view.optInArms = optInArms;
  if (axis !== null && Object.hasOwn(AXIS_NOTES, axis)) view.note = AXIS_NOTES[axis];
  return view;
}

/**
 * 저널 한 줄을 최근 목록 모형으로.
 *
 * ★ `appliedAxes` 가 없는 옛 줄은 `[]` 가 아니라 `null` 이다 — "반영한 축이 없다" 와
 *   "어디에 반영했는지 모른다" 는 다른 사실이고, `orch_reward` 가 뒤엣것을 거부하기 때문에
 *   화면에서도 갈라 보여야 한다.
 */
const recentView = (run, generations, generationsKnown = true) => {
  const appliedAxes = Array.isArray(run.appliedAxes) ? run.appliedAxes : null;
  const appliedCurrent = run.appliedGrade === null || run.appliedGrade === undefined
    ? null
    : !generationsKnown
      ? null
    : appliedAxes !== null && typeof run.taskClass === 'string'
      ? appliedAxes.every((axis) => {
          const recorded = Number.isInteger(run.appliedGenerations?.[axis]) ? run.appliedGenerations[axis] : 0;
          return generationOf(generations, cellKeyOf(run.taskClass, axis)) === recorded;
        })
      : null;
  return {
  runId: run.runId,
  at: Number.isFinite(run.at) ? run.at : null,
  taskClass: typeof run.taskClass === 'string' ? run.taskClass : null,
  stopReason: run.outcome?.stopReason ?? null,
  grade: run.outcome?.grade ?? null,
  appliedGrade: run.appliedGrade ?? null,
  appliedCurrent,
  appliedAxes,
};
};

/**
 * 응답을 `MAX_CONTENT_CHARS` 안으로 줄인다.
 *
 * ★ 왜 봉투에 맡기지 않는가: `success()` 의 자동 자르기는 문자열을 자르므로 **JSON 이
 *   깨진다.** 그러면 호출자는 통계 대신 파싱 오류를 받고, 그것이 하필 통계가 가장 많을 때
 *   일어난다. 그래서 도구가 스스로 줄이고 **무엇을 줄였는지 본문에 적는다** —
 *   notice 만으로는 본문만 읽는 소비자가 그 사실을 못 본다.
 *
 * 사다리 순서는 버려도 덜 아픈 것부터다: 최근 실행 목록 → 팔별 α·β → 셀 자체.
 * 셀은 태스크 클래스 × 축으로 상한이 있어(실행마다 늘지 않는다) 마지막에 둔다.
 */
function renderStats(view) {
  const allCells = view.cells;
  const allRecent = view.recent; // null = 호출자가 요청하지 않았다
  let keepRecent = allRecent === null ? 0 : allRecent.length;
  let keepCells = allCells.length;
  let withArms = true;

  // 사다리는 유한하다: recent 반감 → 팔 제거 → 셀 반감 → 포기. 상한은 그 사실의 그물이다.
  for (let step = 0; step < 128; step += 1) {
    const reduced = {};
    if (allRecent !== null && keepRecent < allRecent.length) {
      reduced.recent = { asked: allRecent.length, kept: keepRecent };
    }
    if (!withArms) reduced.arms = false;
    if (keepCells < allCells.length) reduced.cells = { asked: allCells.length, kept: keepCells };

    const body = {
      threshold: view.threshold,
      posteriors: view.posteriors,
      journal: view.journal,
      cells: allCells.slice(0, keepCells).map((cell) => (withArms ? cell : { ...cell, arms: null })),
    };
    if (allRecent !== null) {
      body.recent = allRecent.slice(0, keepRecent);
      // ★ 최근 목록은 `task_class` 로 **안 걸러진다**(아래 `runOrchStats` 의 주석이 이유다).
      //   그 사실이 주석에만 있으면 본문을 읽는 소비자는 걸러진 목록으로 안다.
      body.recentFiltered = false;
    }
    if (Object.keys(reduced).length > 0) body.reduced = reduced;

    const text = JSON.stringify(body);
    if (text.length <= MAX_CONTENT_CHARS) return { text, reduced };
    if (keepRecent > 0) {
      keepRecent = Math.floor(keepRecent / 2);
      continue;
    }
    if (withArms) {
      withArms = false;
      continue;
    }
    if (keepCells > 0) {
      keepCells = Math.floor(keepCells / 2);
      continue;
    }
    // 셀도 최근 목록도 없는데 넘친다 — 고정 머리말만 남았다는 뜻이라 도달할 수 없다.
    // 그래도 무한 루프 대신 봉투의 자르기로 넘긴다.
    return { text, reduced };
  }
  return { text: JSON.stringify({ threshold: view.threshold, posteriors: view.posteriors, journal: view.journal, cells: [] }), reduced: {} };
}

/**
 * `reset` 응답을 `MAX_CONTENT_CHARS` 안으로 줄인다.
 *
 * ★★ **자매 경로가 같은 실패를 갖고 있었다.** `renderStats` 가 사다리를 타는 이유(봉투의
 *    자동 자르기는 JSON 을 깨뜨린다)는 여기에도 그대로 적용되는데 이쪽만 그냥 냈다.
 *    실측(수정 라운드 1): `prose::` 접두 셀 120개를 범위 reset 하면 본문이 상한을 넘어
 *    `SyntaxError: Unterminated string in JSON` 이 났다. 지운 셀의 목록은 길이에 상한이
 *    없다 — 손으로 쓴 셀 키는 얼마든지 길 수 있으므로 개수 상한이 아니라 **길이로** 줄인다.
 */
function renderReset(reset) {
  const all = reset.cellKeys;
  let kept = all === null ? 0 : all.length;
  for (let step = 0; step < 128; step += 1) {
    const body = { reset: { ...reset, cellKeys: all === null ? null : all.slice(0, kept) } };
    const reduced = all !== null && kept < all.length ? { cellKeys: { asked: all.length, kept } } : {};
    if (all !== null && kept < all.length) body.reduced = reduced;
    const text = JSON.stringify(body);
    if (text.length <= MAX_CONTENT_CHARS || kept === 0) return { text, reduced };
    kept = Math.floor(kept / 2);
  }
  // 128번을 반씩 줄이면 0 에 닿는다(`kept === 0` 에서 위가 반환한다) — 여기는 도달하지 않는다.
  return { text: JSON.stringify({ reset: { ...reset, cellKeys: [] } }), reduced: {} };
}

/**
 * reset notice 한 조각의 상한. 셀 키와 사유를 **따로** 자른다.
 *
 * ★ 통째로 자르면 긴 셀 키 하나가 상한을 다 먹고 사유가 사라진다 — 손으로 쓴 셀 키에는
 *   길이 상한이 없다(`renderReset` 이 개수가 아니라 길이로 줄이는 것과 같은 이유).
 *   원본 길이를 꼬리에 안 적는 이유는 그것이 자릿수만큼 길이를 흔들어, 이 값을 정확값으로
 *   재는 테스트를 불가능하게 만들기 때문이다.
 */
const RESET_KEY_CHARS = 100;
const RESET_REASON_CHARS = 120;
/**
 * 문장 하나의 마지막 상한. 위 둘(100 + 이음말 13 + 120)을 다 쓴 문장이 233자라 그보다 조금
 * 넉넉하다. **이 상한이 `foldResetNotes` 안에 있어야** 그 함수 하나로 합계가 유한해진다 —
 * 호출부의 `clipTo` 에만 기대면 다음 호출부가 그것을 빠뜨리는 순간 상한이 사라진다.
 */
const RESET_NOTE_CHARS = 240;
/** 봉투에 싣는 notice 문장의 수. 넘으면 뒤를 접고 개수만 적는다. */
const RESET_NOTES_KEPT = 5;

const clipTo = (text, limit) => {
  const value = typeof text === 'string' ? text : String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

/**
 * 범위 reset 의 notice 를 봉투에 실을 한 덩어리로 접는다.
 *
 * ★★ **자매 필드가 같은 실패를 갖고 있었다.** 태스크 10 이 `content` 를 축소 사다리로
 *    묶었지만 `notice` 는 그대로였고, 봉투(`src/envelope.mjs`)는 `content` 만 자른다.
 *    실측(커밋 4c50a4b, 이 기계): 셀 12개가 전부 실패하면 notice 가 **4,401자**,
 *    60개면 **22,017자**였다. 그 상태로 25k 토큰 상한에 부딪히면 잘리는 것은 우리가 고른
 *    것이 아니라 호스트가 고른 꼬리다.
 *
 * 앞쪽(호출자 인자 처리·축소 사실)은 접히지 않고 셀 단위 문장만 접힌다 — 호출부가 그
 * 순서로 넘긴다. `src/engine.mjs` 의 `joinNotices` 가 뒤부터 접는 것과 같은 규칙이다.
 */
export function foldResetNotes(notes) {
  const kept = (Array.isArray(notes) ? notes : [])
    .filter((note) => typeof note === 'string' && note !== '')
    .map((note) => clipTo(note, RESET_NOTE_CHARS));
  if (kept.length === 0) return undefined;
  if (kept.length <= RESET_NOTES_KEPT) return kept.join(' / ');
  const dropped = kept.length - RESET_NOTES_KEPT;
  return (
    `${kept.slice(0, RESET_NOTES_KEPT).join(' / ')} ` +
    `(그 밖에 ${dropped}건은 접었습니다 — 실패한 셀 수는 본문 reset.failed 입니다.)`
  );
}

/** 무엇을 줄였는지 사람 문장으로. 본문의 `reduced` 와 같은 사실을 말한다. */
function reductionNotice(reduced) {
  const parts = [];
  if (reduced.recent) parts.push(`최근 실행 목록을 ${reduced.recent.asked}건에서 ${reduced.recent.kept}건으로 줄였습니다`);
  if (reduced.arms === false) parts.push('팔별 α·β 를 뺐습니다');
  if (reduced.cells) parts.push(`셀 목록을 ${reduced.cells.asked}개에서 ${reduced.cells.kept}개로 줄였습니다`);
  if (reduced.cellKeys) {
    parts.push(`지운 셀 목록을 ${reduced.cellKeys.asked}개에서 ${reduced.cellKeys.kept}개로 줄였습니다(실제로 지운 수는 cleared 입니다)`);
  }
  return parts.length > 0 ? `응답 상한(${MAX_CONTENT_CHARS}자) 때문에 ${parts.join(' / ')}.` : null;
}

/**
 * `reset`. `task_class` 를 주면 그 클래스의 셀만 지운다.
 *
 * ★★ 범위를 안 좁히면 **필터해 놓고 전부 지우는 도구**가 된다. `orch_stats({task_class})`
 *    로 한 클래스만 보던 사용자가 그 호출에 `reset:true` 를 더하면 화면에 없던 셀까지
 *    사라진다. `src/learn/posteriors.mjs` 의 `resetPosteriors` 주석이 이 자리를 미리
 *    지목해 뒀다("orch_stats 에 이미 task_class 인자가 있으니 …").
 *
 * ★ 손상된 파일에서 **범위** 초기화는 거절한다 — 어느 셀이 그 클래스인지 읽을 수가 없다.
 *   `task_class` 없는 전체 초기화는 그때도 된다(`resetPosteriors` 가 통째로 버린다).
 *
 * ★ 구분자(`::`)가 없는 셀 키는 `taskClass` 가 `null` 이라 **어떤 범위 reset 에도 안 걸린다.**
 *   손으로 쓴 파일에서만 나오는 키인데, 지우는 길은 `task_class` 없는 전체 reset 하나뿐이다.
 *   `orch_stats` 는 그런 셀을 `taskClass:null` 로 보여 주므로 화면에서는 보인다.
 *
 * ★ 범위의 셀 키를 `resetPosteriors` 한 번에 넘긴다. 그러면 잠금·스냅샷·본문 쓰기가 각각
 *   한 번이고 전부 지워지거나 하나도 안 지워진다. 셀마다 부르면 마지막 셀 직전 상태만
 *   스냅샷에 남아 복구가 거짓말이 된다.
 */
async function resetStats(stateRoot, taskClass, preNotes, operationOptions) {
  const snapshotFor = () => ({
    path: join(stateRoot, SNAPSHOT_FILE),
    generationPath: join(stateRoot, GENERATIONS_SNAPSHOT_FILE),
    restore: `관련 서버를 중지한 상태에서 ${GENERATIONS_SNAPSHOT_FILE} 을 learning.generations.json 으로 먼저 복사한 뒤 ${SNAPSHOT_FILE} 을 posteriors.json 으로 복사하고 서버를 다시 시작하세요.`,
  });
  const snapshotNotice = (snapshot) =>
    `reset 전 스냅샷은 ${snapshot.path} 및 ${snapshot.generationPath} 입니다. 되돌리려면 관련 서버를 중지한 상태에서 ${GENERATIONS_SNAPSHOT_FILE} 을 learning.generations.json 으로 먼저 복사한 뒤 ${SNAPSHOT_FILE} 을 posteriors.json 으로 복사하고 서버를 다시 시작하세요.`;
  if (taskClass === undefined) {
    const cleared = await resetPosteriors(stateRoot, operationOptions);
    if (!cleared.ok) {
      return failure({
        status: 'failed',
        error: `사후분포를 지우지 못했습니다: ${cleared.reason}`,
        recovery: '잠시 뒤 같은 reset 을 다시 시도하세요. 보류 중인 작업은 다음 조회가 복구합니다. 필요하면 관련 서버를 중지하고 paired snapshot 복구 절차를 따르세요.',
      });
    }
    return success({
      // ★ `asked` 는 **모른다**(`null`). 전체 초기화는 셀을 세지 않고 파일을 통째로 버리므로
      //   "몇 개가 범위였나"에 답할 근거가 없다 — `cleared` 를 그대로 적으면 손상된 파일을
      //   버렸을 때(`cleared:0`) "범위가 0개였다"는 거짓이 된다. 범위 reset 응답과 필드
      //   집합을 맞춰 소비자가 두 갈래로 분기하지 않게 한다.
      //
      // ★★ `posteriors` 가 **읽지도 못한 채 버렸다**를 본문에 낸다. 이 필드가 없던 동안
      //    손상 파일을 버린 응답의 본문이 지울 것이 아예 없던 경우와 **바이트로 같았다**
      //    (실측, 수정 라운드 1 · 커밋 ab0e98a · 둘 다
      //    `{"reset":{"taskClass":null,"asked":null,"cleared":0,"failed":0,"cellKeys":null}}`
      //    · 둘 다 `verified`). 그 사실은 한국어 notice 안에만 있었다 — 이 파일이 §3② 에서
      //    이미 세운 기준(「notice 에만 있으면 본문 소비자는 못 본다」)을 자기 자매 갈래에
      //    못 적용한 것이다.
      //    이름과 값(`ok`/`unreadable`)은 **조회 갈래의 최상위 `posteriors`** 와 같게 맞췄다.
      //    자매끼리 어휘가 갈리면 소비자가 같은 사실을 두 번 배워야 한다.
      content: JSON.stringify({
        reset: {
          taskClass: null,
          asked: null,
          cleared: cleared.cleared,
          failed: 0,
          cellKeys: null,
          posteriors: cleared.discarded ? 'unreadable' : 'ok',
          snapshot: cleared.cleared > 0 || cleared.discarded ? snapshotFor() : null,
        },
      }),
      // ★ 조회 갈래가 손상에 `unverified` 를 내는 것과 **같은 규칙**이다. 읽지도 못한 파일을
      //   버린 것을 "직접 확인했다" 고 말할 수 없다.
      confidence: cleared.discarded ? 'unverified' : 'verified',
      notice: foldResetNotes([
        ...preNotes,
        cleared.cleared > 0 || cleared.discarded ? snapshotNotice(snapshotFor()) : null,
        cleared.notice,
      ]),
    });
  }

  // Scope selection belongs to resetPosteriors' coordinator callback.  Reading
  // keys here and locking later lets a reward/automatic mutation slip between
  // selection and generation invalidation.
  const head = [...preNotes];
  const one = await resetPosteriors(stateRoot, { taskClass, ...(operationOptions ?? {}) });
  if (!one.ok && !Number.isInteger(one.asked)) {
    return failure({
      status: 'failed',
      error: `사후분포를 읽지 못해 ${taskClass} 범위만 지울 수 없습니다: ${one.reason}`,
      recovery: 'task_class 없이 orch_stats({reset:true}) 로 부르면 읽을 수 없는 파일을 통째로 버립니다.',
    });
  }
  const asked = Number.isInteger(one.asked) ? one.asked : 0;
  const cleared = one.ok ? one.cleared : 0;
  const failed = one.ok ? 0 : asked;
  const selectedKeys = Array.isArray(one.cellKeys) ? one.cellKeys : [];
  const removed = one.ok ? selectedKeys : [];
  const perCell = one.ok
    ? [one.notice]
    : selectedKeys.map((cellKey) => `${clipTo(cellKey, RESET_KEY_CHARS)} 를 지우지 못했습니다: ${clipTo(one.reason, RESET_REASON_CHARS)}`);
  // ★★ `asked`·`failed` 를 **본문**에 적는다. 이 둘이 없던 동안 12셀이 전부 실패한 응답의
  //    본문이 `{"reset":{"taskClass":"prose","cleared":0,"cellKeys":[]}}` 였고(실측,
  //    커밋 4c50a4b), 본문만 읽는 소비자에게 그것은 「그 클래스에는 지울 것이 없었다」로
  //    읽힌다. 실패는 한국어 notice 안에만 있었다 — 태스크 10 이 다른 자리에서 세운 기준
  //    (「notice 에만 있으면 본문 소비자는 못 본다」)을 자기 자매 경로에 못 적용한 것이다.
  // `posteriors:'ok'` — 이 갈래는 위에서 읽기에 **성공**했을 때만 온다. 전체 reset 과 같은
  // 필드 집합을 유지한다.
  const rendered = renderReset({
    taskClass,
    asked,
    cleared,
    failed,
    cellKeys: removed,
    posteriors: 'ok',
    snapshot: cleared > 0 ? snapshotFor() : null,
  });
  const shrank = reductionNotice(rendered.reduced);
  if (shrank !== null) head.push(shrank);
  return success({
    content: rendered.text,
    // ★ 하나라도 못 지웠으면 "직접 확인했다"고 말할 수 없다. status 는 `succeeded` 로 둔다 —
    //   reset 은 멱등이라 같은 호출을 그대로 다시 하면 남은 것을 마저 지운다.
    confidence: failed === 0 ? 'verified' : 'unverified',
    notice: foldResetNotes([...head, cleared > 0 ? snapshotNotice(snapshotFor()) : null, ...perCell]),
  });
}

/** `orch_stats` 핸들러: 학습 통계를 보거나 사후분포를 지운다. */
async function runOrchStats(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();

  if (value.reset === true) {
    // ★ `runs` 는 reset 응답에 실을 데가 없다. 조용히 버리면 최근 실행 목록을 보러 온
    //   호출자가 빈손으로 돌아가면서 그 사실을 모른다 — 이 도구가 없애려는 조용한 무연산이다.
    const ignored =
      value.runs > 0
        ? [`reset 호출이라 runs:${value.runs} 는 무시했습니다 — 최근 실행 목록은 reset 없이 다시 부르세요.`]
        : [];
    return resetStats(stateRoot, value.task_class, ignored, wired.learningOperationOptions);
  }

  const notices = [];

  // Read all three facts inside one coordinator callback.  Reading a posterior,
  // then an epoch, then a journal under unrelated locks can label an old row as
  // current (or vice versa) while a reward/reset commits between reads.
  const snapshot = await withLearningLock(stateRoot, async () => ({
    posteriors: await readPosteriorsUnlocked(stateRoot),
    generations: await readGenerationsUnlocked(stateRoot),
    runs: value.runs > 0 ? await readRunsUnlocked(stateRoot, { limit: value.runs }) : null,
  }));
  const posteriors = snapshot.ok
    ? snapshot.value.posteriors
    : { ok: false, reason: `학습 coordinator 복구 또는 잠금 실패: ${snapshot.reason}` };
  const generationState = snapshot.ok
    ? snapshot.value.generations
    : { ok: false, reason: snapshot.reason };
  const runs = snapshot.ok ? snapshot.value.runs : null;
  // ★ 손상(`{ok:false}`)과 빈 것(`{ok:true, cells:{}}`)을 갈라서 낸다. 뭉개면 "아직 학습이
  //   없다" 와 "파일이 손상돼 격리됐다" 가 사용자에게 똑같이 보인다 — 태스크 4 가 남긴 인계다.
  if (!posteriors.ok) notices.push(`학습 사후분포를 읽지 못했습니다: ${posteriors.reason}`);
  const cells = posteriors.ok
    ? Object.entries(posteriors.cells)
        .map(([cellKey, arms]) => cellView(cellKey, arms))
        .filter((cell) => value.task_class === undefined || cell.taskClass === value.task_class)
    : [];
  if (!generationState.ok) notices.push(`학습 세대를 읽지 못했습니다: ${generationState.reason}`);

  // ★ `readRuns` 는 `at` 오름차순이다 — 최근순으로 보이려면 뒤집는다.
  // ★ `task_class` 로 **거르지 않는다.** `readRuns` 의 창은 `at` 기준 N 건이라, 거른 뒤 세면
  //   요청한 수를 못 채우면서 "그 클래스의 최근 N 건" 처럼 보인다. 셀만 거른다.
  let recent = null;
  let journal = 'skipped';
  if (value.runs > 0) {
    if (runs?.ok) {
      recent = [...runs.runs]
        .reverse()
        .map((run) => recentView(run, generationState.ok ? generationState.generations : { global: 0, cells: {} }, generationState.ok));
      journal = 'ok';
    } else {
      recent = [];
      journal = 'unreadable';
      notices.push(`실행 저널을 읽지 못했습니다: ${runs?.reason ?? snapshot.reason}`);
    }
  }

  const rendered = renderStats({
    threshold: OBSERVATION_THRESHOLD,
    posteriors: posteriors.ok ? 'ok' : 'unreadable',
    journal,
    cells,
    recent,
  });
  const shrank = reductionNotice(rendered.reduced);
  if (shrank !== null) notices.push(shrank);

  return success({
    content: rendered.text,
    // 파일을 직접 읽은 값이다. 못 읽은 것이 하나라도 있으면 그렇게 말한다.
    confidence: posteriors.ok && journal !== 'unreadable' && generationState.ok ? 'verified' : 'unverified',
    notice: notices.length > 0 ? notices.join(' ') : undefined,
  });
}

const ZERO_DELTA = Object.freeze({ alphaDelta: 0, betaDelta: 0 });

const sameAxes = (a, b) => Array.isArray(a) && a.length === b.length && a.every((axis, i) => axis === b[i]);

/**
 * `orch_reward` 핸들러. 멱등·교체(설계 §7.4).
 *
 * ★★ **되돌리기와 새로 적기는 서로 다른 질문에 답한다.**
 *   · 되돌릴 곳 = `appliedAxes` — 지금 사후분포에 **실제로 들어 있는** 기여.
 *   · 새로 적을 곳 = `rewardableAxes` — 이 실행에 등급을 준다면 갈 곳(엔진의 `axesFor`).
 *   둘을 하나로 뭉개면 두 방향으로 다 틀린다: `appliedAxes` 로만 적으면 **자동 채점이
 *   기권한 실행**(테스트 판정을 못 믿었다 · blocked · 빈 패치)은 정정할 곳이 0개가 되어
 *   사람 손 정정이 조용한 무연산이 되고, `Object.keys(AXES)` 로 적으면 이 실행에서
 *   **무연산이었던 축**(벤더 하나 · 역할 지정 · `test-definition-changed`)에까지 보상이
 *   얹혀 `learnable`·`axesFor` 가 막으려던 거짓 귀속이 사용자 정정 문으로 되돌아온다.
 *
 * ★★ 되돌리기와 적용을 축마다 **순 델타 하나**로 합치고, 그 델타들을 **한 번의
 *   완전 목표를 담은 **학습 WAL 작업 하나**(coordinator 하나 · posterior/journal 목표
 *   쓰기)로 낸다. 두 층 다 이유가 같다 — 중간에서 죽어도 다음 읽기/작업이 같은 목표를
 *   정확히 재생해야 저널의 스칼라 `appliedGrade` 와 사후분포가 어긋나지 않는다.
 *   `posteriors.json` 과 저널은 함께 의도된 목표로 수렴하며, operationId 가 저널 행의
 *   중복 추가를 막는다.
 *   성분별 하한은 순 델타든 두 번 호출이든 같은 값을 낸다(`bump` 이 성분마다 따로 막는다).
 *
 * ★ **쓰기 중 실패하면 pending WAL을 남긴다.** 이후 읽기/작업은 같은 목표를 재생해
 *   posterior와 저널을 정확히 한 번 수렴시킨다. 이번 호출은 `failed` 봉투이지만, 실행
 *   결과 자체를 막지는 않는다.
 *
 * ★ 던지지 않는다. 실패는 봉투다.
 */
async function runOrchReward(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();

  const locked = await withLearningLock(stateRoot, async () => runOrchRewardUnlocked(value, stateRoot));
  if (locked.ok) return locked.value;
  return failure({
    status: 'failed',
    error: `학습 조정 잠금을 잡지 못했습니다: ${locked.reason}`,
    recovery: '잠시 뒤 같은 run_id 로 다시 시도하세요. 보류 중인 학습 작업은 다음 읽기 또는 재시도에서 복구됩니다.',
  });
}

async function runOrchRewardUnlocked(value, stateRoot) {
  // `findRun` 은 같은 coordinator 를 다시 잡으므로 여기서는 unlocked helper 만 쓴다.
  const run = await findRunUnlocked(stateRoot, value.run_id);

  if (run === null) {
    return failure({
      status: 'invalid',
      error: `run_id "${safeErrorText(value.run_id)}" 를 저널에서 찾지 못했습니다.`,
      recovery: 'orch_stats({runs: 20}) 으로 최근 실행 목록을 확인하세요.',
    });
  }
  if (typeof run.taskClass !== 'string' || run.taskClass === '') {
    return failure({
      status: 'failed',
      error: `실행 기록 "${safeErrorText(value.run_id)}" 에 taskClass 가 없어 어느 셀을 고칠지 알 수 없습니다.`,
      recovery: '이 실행은 학습 셀과 연결돼 있지 않습니다. 다른 run_id 를 고르세요.',
    });
  }

  const generations = await readGenerationsUnlocked(stateRoot);
  if (!generations.ok) {
    return failure({
      status: 'failed',
      error: `학습 세대를 읽지 못해 정정하지 않았습니다: ${generations.reason}`,
      recovery: '잠시 뒤 다시 시도하세요. 상태 루트의 learning.generations.json 접근도 확인하세요.',
    });
  }
  const hasExpiredAxis = (axes, recordedGenerations) => axes.some((axis) => {
    if (typeof axis !== 'string' || axis === '') return false;
    const recorded = Number.isInteger(recordedGenerations?.[axis]) ? recordedGenerations[axis] : 0;
    return generationOf(generations.generations, cellKeyOf(run.taskClass, axis)) !== recorded;
  });
  // `appliedAxes` and `rewardableAxes` describe independent contracts.  A
  // null-applied run intentionally has no applied generation, but its current
  // rewardable generation still makes a later manual grade safe.  Missing maps
  // remain legacy generation 0 rather than borrowing the other contract's map.
  const isExpired =
    (run.appliedGrade !== null && run.appliedGrade !== undefined &&
      Array.isArray(run.appliedAxes) && hasExpiredAxis(run.appliedAxes, run.appliedGenerations)) ||
    (Array.isArray(run.rewardableAxes) && hasExpiredAxis(run.rewardableAxes, run.rewardableGenerations));
  if (isExpired) {
    return failure({
      status: 'invalid',
      error: '이 실행의 학습 세대가 reset 으로 만료되어 정정할 수 없습니다.',
      recovery: '새 orchestration 을 실행해 현재 학습 세대의 run_id 를 만든 뒤 그 실행을 정정하세요.',
    });
  }

  const nextGrade = value.good === true ? 'success' : 'failure';
  const redoDeltas = gradeToDeltas(nextGrade);
  const appliedGrade = run.appliedGrade ?? null;
  const undoDeltas = gradeToDeltas(appliedGrade);

  if (appliedGrade !== null && undoDeltas === null) {
    return failure({
      status: 'failed',
      error: `실행 기록이 모르는 등급(${safeErrorText(appliedGrade)})을 반영했다고 적고 있어 되돌릴 수 없습니다.`,
      recovery: '되돌리지 않고 새 등급만 더하면 이중 계산이 됩니다. 저널 줄을 확인하세요.',
    });
  }
  // ★ `?? []` 로 읽지 마라. 옛 줄은 `appliedGrade:'success'` 인데 `appliedAxes` 가 없다 —
  //   `[]` 로 읽으면 되돌릴 축이 0개가 되어 그 α 가 **영원히** 남고 새 등급이 그 위에 얹힌다.
  if (undoDeltas !== null && !Array.isArray(run.appliedAxes)) {
    return failure({
      status: 'failed',
      error: '실행 기록에 appliedAxes 가 없습니다(옛 형식) — 어느 셀에 반영됐는지 몰라 되돌릴 수 없습니다.',
      recovery:
        '되돌리지 않고 새 등급만 더하면 이중 계산이 됩니다. orch_stats({reset:true}) 로 사후분포를 초기화하고 다시 쌓는 것이 회복 경로입니다.',
    });
  }

  const undoAxes = undoDeltas === null ? [] : run.appliedAxes;
  const notes = [];
  let redoAxes;
  if (Array.isArray(run.rewardableAxes)) {
    redoAxes = run.rewardableAxes;
  } else if (undoDeltas !== null) {
    redoAxes = undoAxes;
    notes.push('실행 기록에 rewardableAxes 가 없어(옛 형식) 이미 반영돼 있던 축에만 새 등급을 적었습니다.');
  } else {
    redoAxes = [];
    notes.push(
      '실행 기록에 rewardableAxes 가 없고 사후분포에 반영된 기여도 없어(옛 형식) 새 등급을 적을 셀을 정할 수 없습니다.',
    );
  }

  // ★ 모르는 축은 **조용히** 버리지 않는다. 형제 경로(팔이 없는 축)가 문장을 남기는데
  //   여기만 침묵하면 `rewardableAxes:['oldaxis']` 같은 줄이 `axes:[]` · notice 없음으로
  //   나가서, 사용자는 정정이 됐다고 믿는다 — 이 도구의 논거가 「조용한 무연산을 없앤다」다.
  const named = [...new Set([...undoAxes, ...redoAxes])];
  const axes = named.filter((axis) => Object.hasOwn(AXES, axis));
  const unknown = named.filter((axis) => !Object.hasOwn(AXES, axis));
  if (unknown.length > 0) {
    notes.push(`지금 없는 축이라 건너뜁니다: ${unknown.map((axis) => safeErrorText(axis)).join(', ')}.`);
  }

  const holding = [];
  const updates = [];
  for (const axis of axes) {
    const decisions = run.decisions !== null && typeof run.decisions === 'object' ? run.decisions : {};
    const arm = Object.hasOwn(decisions, axis) ? decisions[axis] : null;
    if (typeof arm !== 'string' || arm === '') {
      notes.push(`${axis}: 이 실행이 쓴 팔이 저널에 없어 건너뜁니다.`);
      continue;
    }
    const back = undoAxes.includes(axis) ? undoDeltas ?? ZERO_DELTA : ZERO_DELTA;
    const inRedo = redoAxes.includes(axis);
    const forward = inRedo ? redoDeltas : ZERO_DELTA;
    const alphaDelta = forward.alphaDelta - back.alphaDelta;
    const betaDelta = forward.betaDelta - back.betaDelta;

    if (alphaDelta !== 0 || betaDelta !== 0) {
      updates.push({ cellKey: cellKeyOf(run.taskClass, axis), arm, alphaDelta, betaDelta });
    }
    if (inRedo) holding.push(axis);
  }

  // ★★ **한 번의 쓰기다.** 축마다 따로 쓰면 세 축을 고치고 네 번째에서 죽는 반쪽 상태가
  //    남는데, 저널의 스칼라 `appliedGrade` 로는 그것을 적을 수가 없어 다음 정정이 이중
  //    계산한다. 실패하면 **저널을 건드리지 않고** 실패 봉투로 나간다 — 아무것도 안 움직인
  //    상태라 같은 호출을 다시 하면 정확히 같은 결과가 난다(멱등 회복).
  const wrote = updates.length > 0;
  const nextApplied = holding.length > 0 ? nextGrade : null;
  const note = typeof value.note === 'string' ? value.note : null;
  // ★ `note` 를 안 주면 이전 note 가 **지워진다**(줄 전체를 새로 쓰기 때문이다). 그것이
  //   틀린 동작은 아니지만 — 안 준 것은 "비워라" 로 읽는 편이 예측 가능하다 — 조용하면 안 된다.
  if (note === null && typeof run.note === 'string' && run.note !== '') {
    notes.push(`note 를 주지 않아 이전 기록("${run.note}")을 지웠습니다. 남기려면 같은 문장을 다시 주세요.`);
  }
  // ★ 바뀔 것이 없으면 줄을 얹지 않는다 — 그것이 멱등이다. 사후분포도 저널도 그대로여야 한다.
  const unchanged =
    !wrote &&
    appliedGrade === nextApplied &&
    sameAxes(run.appliedAxes, holding) &&
    (run.rewardApplied ?? null) === 'user' &&
    (run.note ?? null) === note;

  if (!unchanged) {
    // The pending WAL holds this complete posterior target and this complete
    // replacement row before either is touched.  Never call a public storage
    // writer here: this callback already owns learning.lock.
    const committed = await commitLearningMutationUnlocked(stateRoot, {
      updates,
      journal: {
      ...run,
      appliedGrade: nextApplied,
      appliedAxes: holding,
      rewardApplied: 'user',
      note,
      },
    });
    if (committed.ok !== true) {
      return failure({
        status: 'failed',
        error: `사후분포와 실행 기록을 함께 고치지 못했습니다: ${committed.reason}`,
        recovery: '보류 중인 작업은 다음 읽기 또는 같은 run_id 로 다시 시도할 때 복구됩니다. 문제가 계속되면 새 orchestration 을 실행하세요.',
      });
    }
    if (Array.isArray(committed.notes) && committed.notes.length > 0) notes.push(committed.notes.join(' / '));
  }

  return success({
    content: JSON.stringify({
      runId: run.runId,
      previousGrade: appliedGrade,
      grade: nextApplied,
      axes: holding,
      changed: !unchanged,
    }),
    confidence: 'verified',
    notice: notes.length > 0 ? notes.join(' / ') : undefined,
  });
}

/**
 * `context` 의 어느 필드가 엔진의 어디로 가는가 — 두 핸들러가 같은 계약을 쓴다.
 *
 * ★ 왜 한자리에 모으는가(실측): 예전에는 `orch_run` 이 `stateRoot` 를 **최상위 옵션**으로
 *   넘겼는데 엔진은 `deps.stateRoot` 만 읽었다. 그래서 `callTool(name, args, { stateRoot })`
 *   로 부르면 워크트리·patches·plans 가 그 디렉터리가 아니라 개발자의 실제 상태 루트에
 *   생겼다(테스트가 실제로 홈을 오염시켰다). `providers` 는 중계 자체가 없어서, 가짜
 *   프로바이더를 주입해도 진짜 레지스트리의 claude 가 떴다. 같은 `context` 를 받는
 *   `orch_models` 는 두 필드를 정상 존중했다 — 두 핸들러가 같은 필드를 다르게 해석했다.
 *
 * 우선순위: 호출자가 `context.deps` 에 직접 적은 값이 이긴다. 그쪽이 더 구체적인 채널이다.
 */
function toEngineDeps(context) {
  const deps = context?.deps && typeof context.deps === 'object' ? context.deps : {};
  const shorthand = {};
  if (typeof context?.stateRoot === 'string' && context.stateRoot !== '') shorthand.stateRoot = context.stateRoot;
  if (Array.isArray(context?.providers)) shorthand.providers = context.providers;
  return { ...shorthand, ...deps };
}

/**
 * 검증을 통과한 `orch_run` 인자를 엔진 옵션으로 옮긴다.
 *
 * ★ 이름이 다른 이유: MCP 인자는 설계 §8.2 의 snake_case(`wait_ms`·`allow_single`)이고
 *   엔진은 camelCase(`waitMs`·`allowSingle`)다. 옮기는 자리를 하나로 두어 어느 쪽을
 *   바꿔도 여기만 보면 된다.
 *
 * `onProgress` 는 호스트가 `context` 로 준다(`src/server.mjs` 가 진행 토큰이 있을 때만
 * 만든다) — 중계하지 않으면 조용한 긴 스텝에서 호스트의 유휴 타이머가 먼저 끊는다(§6).
 *
 * ★ **내보내는 이유**: `allow_single` 은 계획 3 태스크 6 시점에 엔진 안에 소비자가 없다
 *   (밴딧 배선은 태스크 8 이다). 그래서 완주 테스트로는 이 배선을 잴 수 없고 — 매핑을
 *   통째로 지워도 봉투가 똑같다 — 이 함수를 직접 부르는 것이 재는 유일한 길이다.
 *   `envelope.mjs` 가 `validateArgs` 를 순수 함수로 두는 것과 같은 이유다.
 */
export function toEngineOptions(value, context) {
  return {
    task: value.task,
    projectPath: value.project,
    isolation: value.isolation,
    budget: value.budget,
    waitMs: value.wait_ms,
    // ☞ 태스크 8 이 읽는다: `decide({ allowed: { single: options.allowSingle === true } })`.
    allowSingle: value.allow_single === true,
    onProgress: typeof context?.onProgress === 'function' ? context.onProgress : undefined,
    deps: toEngineDeps(context),
  };
}

/**
 * `orch_run` 핸들러: 옮긴 옵션을 그대로 엔진에 넘긴다.
 *
 * ★ 봉투를 여기서 다시 만들지 않는다. `runOrchestration` 이 이미 `envelope.mjs` 의
 *   `success`/`failure` 로 완성된 봉투를 내고, `confidence` 산정과 `disputed → failed`
 *   강등도 거기서 끝난다. 여기서 손대면 두 곳이 어긋난다.
 */
async function runOrchRun(value, context) {
  return runOrchestration(toEngineOptions(value, context));
}

/** 진행 알림을 하나 보내기까지의 최소 간격. 스트림 이벤트는 초당 수십 개 온다. */
const PROGRESS_MIN_INTERVAL_MS = 5_000;

/**
 * 호스트의 `notifications/progress` 생산자를 만든다. 진행 토큰이 없으면 `undefined` —
 * 호스트가 요청하지 않은 알림을 보내면 안 된다(MCP 스펙).
 *
 * ★ 왜 필요한가: MCP stdio 는 30분 유휴에서 끊긴다(§6). 엔진은 프로바이더의 진행을 위로
 *   올리는데 그것을 받아 호스트로 내보내는 곳이 없었다 — 중계는 살아 있고 생산자가 0곳
 *   이었다. 매니페스트 `timeout` 이 1겹 더 있지만(둘 다 3600000), 조용한 긴 스텝에서
 *   유휴 타이머를 리셋하는 것은 이 알림뿐이다.
 *
 * ★ 절대 던지지 않는다. 전송 실패(닫힌 transport)로 이미 도는 델리게이트를 죽이면 안 된다.
 */
export function makeProgressReporter({ sendNotification, progressToken, minIntervalMs, now = Date.now } = {}) {
  if (typeof sendNotification !== 'function') return undefined;
  if (typeof progressToken !== 'string' && typeof progressToken !== 'number') return undefined;
  const gap = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : PROGRESS_MIN_INTERVAL_MS;

  let sequence = 0;
  let lastAt = -Infinity;
  let lastPhase = null;

  return (event) => {
    try {
      const phase = typeof event?.phase === 'string' ? event.phase : '진행';
      const at = now();
      // 단계가 바뀌면 상한과 무관하게 보낸다 — 단계 전환이 사람에게 가장 쓸모 있는 신호다.
      if (phase === lastPhase && at - lastAt < gap) return;
      lastPhase = phase;
      lastAt = at;
      sequence += 1;
      const step = Number.isInteger(event?.step) ? event.step : null;
      const sent = sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: sequence,
          message: step !== null && step > 0 ? `${phase} (스텝 ${step})` : phase,
        },
      });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch {
      // 진행 알림은 부가 기능이다.
    }
  };
}

const HANDLERS = {
  orch_models: runOrchModels,
  orch_run: runOrchRun,
  orch_config: runOrchConfig,
  orch_stats: runOrchStats,
  orch_reward: runOrchReward,
};

/**
 * 도구를 부른다. 어떤 입력에도(도구 이름·인자가 무엇이든) throw 하지 않고 항상
 * 봉투를 낸다.
 *
 *   1. 이름을 못 찾으면 invalid 봉투.
 *   2. validateArgs 실패면 invalid 봉투.
 *   3. 핸들러가 던지면(방어적으로만 기대) failed 봉투로 강등.
 */
export async function callTool(name, args, context = {}) {
  try {
    const spec = TOOL_SPECS.find((t) => t.name === name);
    if (!spec) {
      return failure({
        status: 'invalid',
        error: `알 수 없는 도구: ${safeErrorText(name)}`,
        recovery: `사용 가능한 도구: ${TOOL_SPECS.map((t) => t.name).join(', ')}`,
      });
    }

    // ★ MCP 스펙에서 `arguments` 는 optional 이고 SDK 는 생략된 값을 `{}` 로 정규화하지
    //   않는다(실측: 진짜 stdio 왕복에서 `{name:'orch_models'}` 만 보내면 `undefined` 가
    //   온다). 그것을 "인자는 JSON 객체여야 합니다" 로 거부하면, `arguments` 를 생략하는
    //   클라이언트에게 `orch_models` 는 아예 동작하지 않는 도구가 되고 오류 문구는 모델이
    //   JSON-RPC 프레임을 고치라는 뜻이라 스스로 회복할 수 없다.
    //   `undefined` 만 정규화한다 — `null` 은 "값을 명시적으로 비웠다" 라 계속 거부한다
    //   (`args ?? {}` 는 그 둘을 같게 만든다).
    const validated = validateArgs(args === undefined ? {} : args, spec.args);
    if (!validated.ok) {
      return failure({ status: 'invalid', error: validated.error, recovery: validated.recovery });
    }

    // ★ 이 분기는 지금 도달할 수 없다 — `TOOL_SPECS` 의 두 이름이 `HANDLERS` 에 다 있다.
    //   그래도 남기되 **문구를 호출자 탓에서 우리 탓으로** 바꾼다. 이 분기가 발화하려면
    //   스펙과 핸들러 표가 어긋나야 하고 그건 서버 내부 배선 버그다. 호출자에게
    //   "계획 범위를 확인하세요" 라고 말하면 고칠 수 없는 일을 시키는 것이다.
    const handler = HANDLERS[spec.name];
    if (typeof handler !== 'function') {
      return failure({
        status: 'failed',
        error: `서버 내부 배선 오류: 도구 '${spec.name}' 의 스펙은 있는데 핸들러가 없습니다.`,
        recovery: '호출자가 고칠 수 있는 문제가 아닙니다. 서버 로그와 함께 이 문장을 그대로 신고하세요.',
      });
    }

    return await handler(validated.value, context);
  } catch (error) {
    return failure({
      status: 'failed',
      error: safeErrorText(error),
      recovery: '다시 시도하거나 서버 로그를 확인하세요.',
    });
  }
}
