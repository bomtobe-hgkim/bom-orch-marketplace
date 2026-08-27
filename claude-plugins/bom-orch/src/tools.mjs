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
import { failure, success, validateArgs } from './envelope.mjs';
import { MAX_BUDGET, runOrchestration } from './engine.mjs';
import { TIERS, VENDORS, readSettingsStatus, writeSettings } from './config.mjs';
import { confidenceOfConfig, confidenceOfModels } from './confidence.mjs';
import { REASON } from './reason-codes.mjs';
import { renderNotice, renderReason } from './reason-text.mjs';
import { statusOfReasonCode } from './run-faults.mjs';
import { TASK_CLASSES } from './learn/classify.mjs';
import { INSTALL_RECOVERY, errorText } from './util/errors.mjs';
import { toEngineDeps, toEngineOptions } from './tools/context.mjs';
import { runOrchApply } from './tools/apply.mjs';
import { runOrchReward } from './tools/reward.mjs';
import {
  AXIS_NOTES,
  foldResetNotes,
  resetConfirmationFailure,
  runOrchReset,
  runOrchStats,
} from './tools/stats.mjs';
import { runOrchStatus } from './tools/status.mjs';
import { RECENT_RUNS_DEFAULT, RECENT_RUNS_MAX } from './run-read.mjs';
import { stateSchemaNotice, stateSchemaReason } from './state-schema.mjs';

// `toEngineDeps`·`toEngineOptions`·`inspectJournalArtifacts`·`MAX_INSPECTED_ARTIFACT_REFS` moved
// to `./tools/context.mjs`(WS2 Task 16, tools.mjs 를 <=1,459 로 되돌리는 분리) — `orch_reward`
// 도 같은 배선이 필요한데 `tools/reward.mjs` 가 이 파일을 다시 부르면 순환이 생기기 때문이다.
// `toEngineOptions` 는 `test/tools.test.mjs` 가 직접 부르므로 이 파일의 이름으로도 남긴다.
export { toEngineOptions };
export { AXIS_NOTES, foldResetNotes };

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
 *
 * ★ `description` 은 **영어**다(WS2 §7, Task 16). 이것은 실패 문구가 아니라 **도구 스키마의
 *   데이터**라서 `REASON_TEXT` 가 아니라 여기 산다 — 매 세션 `tools/list` 에 그대로 실려
 *   호스트와 모델이 도구를 고르는 유일한 근거가 된다. 문안을 바꾸면
 *   `contract/tools.json`(`npm run contract:snapshot`)과 `test/packaging.test.mjs` 의 낱말 표가
 *   같은 커밋에서 함께 움직여야 한다.
 */
export const TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: 'orch_models',
    description: 'Report the installation state of the claude and codex CLIs and the model list each one offers.',
    args: Object.freeze({
      refresh: Object.freeze({ type: 'boolean', required: false, default: false }),
    }),
  }),
  Object.freeze({
    name: 'orch_run',
    description:
      'Orchestrate one task across two vendor CLIs: a worker edits inside a disposable git worktree, ' +
      'this server runs the tests itself, and a verifier reads the result without changing it. ' +
      'The result is a patch you can apply to your own repository. ' +
      'project must be an absolute path, because the working directory of an MCP stdio server is ' +
      'whatever the host handed down and is not fixed. ' +
      'Pass resume_run_id to continue an earlier run: its sealed attempts are read instead of run ' +
      'again, and this call spends its budget on what is left - every lane starts at the same ' +
      'attempt number, so both candidates get the same number of fresh attempts. That works only ' +
      'when the source tree and the test environment are exactly the ones that run was built on; ' +
      'otherwise the call is refused and nothing starts, so call again without the argument.',
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
      candidates: Object.freeze({
        type: 'number',
        integer: true,
        enum: [1, 2],
        default: 1,
        description: 'How many independent candidates to run; 2 uses both providers with a per-lane budget.',
      }),
      // 설계 §9.2 는 "한 벤더만으로 조용히 돌려 '됐다'고 하면 요청을 배신한다" 고 못박는다.
      // 그래서 single 은 호출자가 **명시적으로** 허용해야만 밴딧이 뽑을 수 있고(계획 3 §7.2),
      // 기본값은 금지 쪽이다. 실제로 팔을 거르는 자리는 `src/learn/bandit.mjs` 의 `decide` 다.
      allow_single: Object.freeze({
        type: 'boolean',
        required: false,
        default: false,
        description: 'Explicitly allow this run to proceed with only one provider.',
      }),
      writer: Object.freeze({
        type: 'string',
        required: false,
        enum: Object.freeze([...VENDORS]),
        description: 'Pin the writer for this run; the other vendor verifies it. Not valid with candidates: 2.',
      }),
      // ★ WS0 §1.2 의 행 그대로(WS3 §0-R1). 스키마가 표현할 수 없는 것 둘은 서술자에 있다:
      //   재사용의 조건(정확히 같은 baseline 과 환경)과, 어긋나면 **새 실행을 시작하지 않는다**는 것.
      //   기본값이 없는 이유는 「재개하지 않음」이 값이 아니라 인자의 부재이기 때문이다.
      resume_run_id: Object.freeze({
        type: 'string',
        required: false,
        description: 'Continue an earlier run instead of starting its attempts over.',
      }),
      // ★ WS0 §1.2 의 행 그대로(WS5 스펙 §0 D1a). 스키마가 표현할 수 없는 것 둘이 서술자에 있다:
      //   프로젝트 설정 `.bom-orch.json` 의 `scope.allow` 와 **합집합**이라는 것과, 보안 하드
      //   리스트는 여기 적어도 무시된다는 것(계약 `project-config.schema.json` 의 같은 문장).
      //   개수·길이 상한은 `validateArgs` 에 축이 없어 합집합이 강제한다(`src/scope-allowlist.mjs`)
      //   — 그래서 서술자도 「거부한다」가 아니라 「쓰지 않고 알림으로 말한다」로 적는다.
      //   기본값이 없는 이유는 `resume_run_id` 와 같다: 「허용목록 없음」은 값이 아니라 인자의 부재다.
      scope_allow: Object.freeze({
        type: 'array',
        items: 'string',
        required: false,
        description: 'Globs (POSIX style, ** allowed) for paths this task is expected to change, ' +
          'unioned with scope.allow in the project .bom-orch.json. At most 32 entries of 256 characters ' +
          'are used and the rest are reported back unused. Security hard-list paths are ignored even ' +
          'when listed, so a lockfile or an editor-settings directory can be waived and a CI definition, ' +
          'a shell rc or anything that decides what the tests run cannot.',
      }),
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
      'Read or change the model and effort this orchestration uses. ' +
      'Called with no arguments it reports the current settings and the values you can choose. ' +
      'To change a model or effort, pass vendor and tier with it. Writer and learning are independent; ' +
      'an empty string clears any value back to its default.',
    args: Object.freeze({
      // ★ enum 은 `src/config.mjs` 의 VENDORS 에서 온다 — settings.ini 의 섹션 이름을
      //   아는 것은 그쪽이다. 여기 글자로 적으면 벤더가 늘 때 조용히 갈린다.
      vendor: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...VENDORS]) }),
      // ★ tier 도 같은 이유로 `src/config.mjs` 의 TIERS 에서 온다 — 두 줄 위 주석이
      //   금하는 바로 그 "글자로 적기" 가 여기 남아 있었다.
      tier: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...TIERS]) }),
      model: Object.freeze({ type: 'string', required: false }),
      effort: Object.freeze({ type: 'string', required: false }),
      learning: Object.freeze({ type: 'string', required: false, enum: Object.freeze(['on', 'off', '']) }),
      writer: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...VENDORS, '']) }),
    }),
  }),
  Object.freeze({
    name: 'orch_stats',
    description:
      'Read learning statistics without changing them. The default summary shows each cell\'s favored ' +
      'arm, observation count, observations remaining before activation, and last applied run. ' +
      'Pass view:full for raw alpha and beta values, or runs to include recent run_id values.',
    args: Object.freeze({
      // ★ enum 은 `src/learn/classify.mjs` 의 TASK_CLASSES 에서 온다 — 클래스를 아는 것은
      //   분류기다. 여기 글자로 적으면 클래스가 늘 때 이 도구만 조용히 뒤처진다
      //   (`VENDORS`↔섹션 · `TIERS`↔밴딧 팔 가드와 같은 축).
      task_class: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...TASK_CLASSES]) }),
      // ★ `orch_reward` 의 recovery 가 "orch_stats 로 최근 실행 목록을 확인하세요" 라고
      //   가리키므로 그 목록이 실제로 나와야 한다. 기본은 끈다 — 서술자·응답 크기를 매 호출
      //   키우지 않기 위해서다. 상한의 근거는 `MAX_RECENT_RUNS` 주석에 있다.
      runs: Object.freeze({ type: 'number', integer: true, min: 0, max: MAX_RECENT_RUNS, required: false, default: 0 }),
      view: Object.freeze({ type: 'string', required: false, default: 'summary', enum: ['summary', 'full'] }),
    }),
  }),
  Object.freeze({
    name: 'orch_status',
    // ★ 인자 둘의 권위는 WS0 §1.3 이다. `runs` 의 두 수는 `src/run-read.mjs` 에서 온다 —
    //   목록을 실제로 자르는 쪽이 그 상한을 아는 쪽이고, 여기 글자로 적으면 조용히 갈린다.
    description:
      'Read one run back from what it left on disk: how it ended, the summary of its manifest, the ' +
      'verifier issues and judge prose it kept, the tail of its log, and the paths of its artifacts. ' +
      'Called with no arguments it lists the recent runs with their run_id values, which is how a ' +
      'call that was cut off is recovered.',
    args: Object.freeze({
      run_id: Object.freeze({ type: 'string', required: false }),
      runs: Object.freeze({
        type: 'number',
        integer: true,
        min: 1,
        max: RECENT_RUNS_MAX,
        required: false,
        default: RECENT_RUNS_DEFAULT,
      }),
    }),
  }),
  Object.freeze({
    name: 'orch_apply',
    // ★ 인자 둘의 권위는 WS0 §1.4 와 `contract/envelope.json` 이다. WS0 §1.4 가 함께 적은
    //   `three_way`·`candidate_id` 는 **안 받는다** — 그 이유는 `src/tools/apply.mjs` 머리말에 있다.
    description:
      "Apply a finished run's patch to your own repository. This is the explicit step: orch_run " +
      'leaves the patch on disk and never applies it for you, so nothing reaches your working tree ' +
      'until this call is made. It refuses, each with its own registered code, a run this state root ' +
      'does not hold, a run whose records cannot be read, and a run whose patch is gone or is not a ' +
      'file. Pass check_only to have the call report what it would do and change nothing. ' +
      'orch_status is where a run_id comes from.',
    args: Object.freeze({
      run_id: Object.freeze({ type: 'string', required: true }),
      check_only: Object.freeze({ type: 'boolean', required: false, default: false }),
    }),
  }),
  Object.freeze({
    name: 'orch_reward',
    description:
      'Correct by hand the grade an earlier run was given. The contribution already applied is taken ' +
      'back before the new grade is applied, so repeating the correction with the same run_id leaves ' +
      'the same result. Ask orch_stats with runs for the run_id values.',
    args: Object.freeze({
      run_id: Object.freeze({ type: 'string', required: true }),
      good: Object.freeze({ type: 'boolean', required: true }),
      note: Object.freeze({ type: 'string', required: false }),
    }),
  }),
  Object.freeze({
    name: 'orch_reset',
    description:
      'Erase the learned posteriors, narrowed to one task class when task_class is given. ' +
      'This is destructive and runs only when confirm:true is passed.',
    args: Object.freeze({
      confirm: Object.freeze({
        type: 'boolean',
        required: true,
        enum: [true],
        description: 'Pass confirm:true to erase learning.',
      }),
      task_class: Object.freeze({ type: 'string', required: false, enum: Object.freeze([...TASK_CLASSES]) }),
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
    if (typeof fieldSpec.description === 'string') property.description = fieldSpec.description;
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
        error: typeof described.error === 'string' && described.error !== '' ? described.error : errorText(error),
        recovery:
          typeof described.recovery === 'string' && described.recovery !== '' ? described.recovery : INSTALL_RECOVERY,
      };
    }
  } catch {
    // describeError 자신이 깨진 경우 — 아래 폴백으로 간다.
  }
  return { error: errorText(error), recovery: INSTALL_RECOVERY };
}

/**
 * 프로바이더가 사유를 안 준(또는 응답 자체가 모양을 잃은) 자리의 문구. 정본은 레지스트리다 —
 * 이 파일이 "닿을 수 없습니다" 같은 문장을 스스로 쓰지 않는다(WS2 Task 16).
 */
const unclassifiedProbe = () => {
  const rendered = renderReason(REASON.provider_error_unclassified, { vendor: 'claude, codex' });
  return { error: rendered.error, recovery: rendered.recovery };
};

/** discover() 가 정상적으로 돌려준 결과를 벤더 리포트 모양으로 다듬는다. */
function normalizeDiscovered(discovered) {
  if (!discovered || typeof discovered !== 'object') {
    return { reachable: false, ...unclassifiedProbe(), recovery: INSTALL_RECOVERY };
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
    error: typeof discovered.error === 'string' && discovered.error !== '' ? discovered.error : unclassifiedProbe().error,
    recovery:
      typeof discovered.recovery === 'string' && discovered.recovery !== '' ? discovered.recovery : INSTALL_RECOVERY,
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
 *
 * ★ WS2 Task 7 수정 I1: `probed` 를 이 함수가 **직접** 낸다. 예전에는 호출부
 *   (`runOrchModels`)가 `cached !== true` 로 거꾸로 추측했는데, CLI 를 아예 안 띄운 두 자리
 *   (아래 catch, `providers:[]`)가 "캐시가 아니었다" 는 이유만으로 `probed` 로 잡혔다.
 *   이제 이 함수가 실제로 무엇을 했는지를 그대로 말한다: 캐시로 답한 갈래는 `probed:false`,
 *   discover 를 **불렀다면**(성공이든 던졌든) `probed:true` — 실패한 프로브도 "시도했다" 는
 *   사실은 확립했다. 아래 바깥 catch(캐시 판정 자체가 깨진 경우)는 CLI 를 부르지도 못했으니
 *   `probed:false` 다.
 */
async function probeVendor(provider, id, { catalog, refresh, stateRoot, shouldRefresh: checkStale = shouldRefresh }) {
  try {
    const cached = catalog?.[id];
    const stale = checkStale(catalog, id, POINT_OF_USE_MAX_AGE_MS);

    if (!refresh && !stale && cached) {
      return { reachable: true, cached: true, fetchedAt: cached.fetchedAt, models: cached.models, probed: false };
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

    return { ...report, probed: true };
  } catch (error) {
    // 위 블록 어디든(캐시 판정 포함) 예상 못 한 예외가 나도 이 벤더만 실패로
    // 강등한다 — 다른 벤더의 Promise.all 이 통째로 거부되면 안 된다. CLI 를 부르지도
    // 못했으므로 `probed:false` — 「캐시가 아니었다」와 「실제로 프로브했다」는 다른 사실이다.
    return { reachable: false, probed: false, ...safeDescribeError(provider, error) };
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
  // ★ I1 테스트 이음매 — 「캐시 판정 자체가 던지는」 outer catch 갈래는 실물로 재현할 수
  //   없다(정상 파일이면 판정이 안 던진다). `shouldRefresh` 스텁을 여기서만 갈아 끼운다.
  const checkStale = typeof wired.shouldRefresh === 'function' ? wired.shouldRefresh : shouldRefresh;

  const catalog = await readCatalog(stateRoot);

  const vendors = {};
  await Promise.all(
    providers.map(async (provider, index) => {
      const id = typeof provider?.id === 'string' && provider.id !== '' ? provider.id : `unknown-${index}`;
      vendors[id] = await probeVendor(provider, id, { catalog, refresh, stateRoot, shouldRefresh: checkStale });
    }),
  );

  // WS0 §2.2 — verified 는 「이번 호출이 CLI 를 실제로 프로브」다. `probeVendor` 가 낸
  // `probed` 를 그대로 접는다 — 벤더가 하나도 없으면(`providers:[]`) 아무것도 프로브하지
  // 않았으므로 `every` 의 공진리(vacuous truth)에 기대지 않고 `length > 0` 을 먼저 본다.
  const reports = Object.values(vendors);
  const probed = reports.length > 0 && reports.every((report) => report.probed === true);
  const notice = probed ? undefined : renderNotice('models_from_cache');
  return success({ content: JSON.stringify({ vendors }), confidence: confidenceOfModels({ probed }), notice });
}

// ── orch_config ───────────────────────────────────────────────────────────

/** tier(도구 어휘) → `writeSettings` 패치의 필드 이름. TIERS 에서 파생한다. */
const TIER_FIELDS = Object.freeze(
  Object.fromEntries(TIERS.map((tier) => [tier, Object.freeze({ model: tier, effort: `${tier}Effort` })])),
);

/** 저장소 접근 실패만 실행 전제 차단이다. 패치 내용 검증 실패는 계속 잘못된 인자다. */
const CONFIG_STORAGE_FAILURES = new Set([
  REASON.config_settings_lock_unavailable,
  REASON.config_settings_read_failed,
  REASON.config_settings_write_failed,
]);

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
  return renderNotice('model_catalog_empty', { vendors: empty.join(', ') });
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
  return renderNotice('model_not_in_catalog', { model: name, vendor: vendorId });
}

function configView(current, vendors, notices, confidence) {
  const notice = notices.filter((text) => typeof text === 'string' && text !== '').join(' ');
  return success({ content: JSON.stringify({ current, vendors }), confidence, notice: notice !== '' ? notice : undefined });
}

/** Explicit shared-state writers all use the same blocked envelope vocabulary. */
function blockedByStateSchema(stateSchema) {
  const reason = stateSchemaReason(stateSchema);
  return reason === null ? null : failure({ status: 'blocked', ...reason });
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
  const changingModel = value.model !== undefined || value.effort !== undefined;
  const changingControl = value.writer !== undefined || value.learning !== undefined;
  const changing = changingModel || changingControl;

  if (!changing) {
    if (value.vendor !== undefined || value.tier !== undefined) {
      return failure({ status: 'invalid', reasonCode: REASON.config_change_target_missing });
    }
    const read = await readSettingsStatus(stateRoot);
    return configView(
      read.settings,
      vendors,
      [stateSchemaNotice(read.stateSchema), emptyCatalogNotice(vendors)],
      confidenceOfConfig({ readable: read.readable && read.stateSchema === undefined }),
    );
  }

  if (changingModel && (value.vendor === undefined || value.tier === undefined)) {
    return failure({
      status: 'invalid',
      reasonCode: REASON.config_change_scope_missing,
      params: { vendors: VENDORS.join(', '), tiers: TIERS.join(', ') },
    });
  }

  if (!changingModel && (value.vendor !== undefined || value.tier !== undefined)) {
    return failure({ status: 'invalid', reasonCode: REASON.config_change_target_missing });
  }
  const fields = changingModel ? TIER_FIELDS[value.tier] : null;
  const patch = {};
  if (changingModel) {
    patch[value.vendor] = {};
    if (value.model !== undefined) patch[value.vendor][fields.model] = value.model;
    if (value.effort !== undefined) patch[value.vendor][fields.effort] = value.effort;
  }
  if (value.writer !== undefined) patch.writer = value.writer;
  if (value.learning !== undefined) patch.learning = value.learning;

  // 목록이 빈 벤더는 null 로 넘긴다 — `writeSettings` 는 그때 검사를 건너뛴다.
  const models = {};
  for (const id of VENDORS) models[id] = vendors[id].models.length > 0 ? vendors[id].models : null;

  // ★ 이음매(`toEngineDeps` 계약 그대로): 재읽기 불일치는 디스크가 거짓말한 경우라 스텁 없이 못 잰다.
  const wrote = await (wired.writeSettings ?? writeSettings)(stateRoot, patch, { models });
  // `writeSettings` 는 이제 `fail()` 봉투를 낸다 — 코드를 그대로 실어야 소비자가 문장이 아니라
  // 코드로 분기할 수 있다(문구는 이미 레지스트리가 렌더했으므로 다시 만들지 않는다).
  if (!wrote.ok) {
    const schemaBlocked = blockedByStateSchema(wrote.stateSchema);
    if (schemaBlocked !== null) return schemaBlocked;
    return failure({
      status: CONFIG_STORAGE_FAILURES.has(wrote.reasonCode) ? statusOfReasonCode(wrote.reasonCode) : 'invalid',
      reasonCode: wrote.reasonCode,
      error: wrote.error,
      recovery: wrote.recovery,
    });
  }

  const notices = [
    changingModel ? unknownModelNotice(value.vendor, wrote.settings[value.vendor][fields.model], vendors) : null,
    emptyCatalogNotice(vendors),
    wrote.notice,
  ];
  return configView(wrote.settings, vendors, notices, confidenceOfConfig({ readBackMatches: wrote.readBack }));
}

// 학습 통계와 초기화 핸들러는 `./tools/stats.mjs` 에 산다.
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
 * 무엇도 이름을 안 대는 이벤트가 쓰는 이름. **실패 문구가 아니라 진행 알림의 라벨**이라
 * 레지스트리가 아니라 여기 산다(MCP `notifications/progress` 의 `message` — 봉투 밖 채널이다).
 */
const PROGRESS_FALLBACK = 'infra';

/**
 * 엔진의 내부 단계 이름 → 호스트가 보는 어휘(계약 `envelope.json` 의 `progress.vocabulary`).
 *
 * ★ 접는 자리가 여기인 이유: 엔진은 자기 이름으로 말하고(`inspect`·`patch`·`verifier_format`),
 *   그 이름들은 후보가 하나일 때만 위로 새어 나갔다 — 같은 실행 단계가 `candidates` 값에 따라
 *   다른 단어로 보이는 것이 WS0 §4 가 적은 결함이다. 접기를 엔진에 두면 엔진이 호스트 어휘를
 *   알아야 하고, 호스트마다 다시 접어야 한다. 알림을 만드는 이 자리가 유일한 번역기다.
 */
export const PROGRESS_PHASES = new Map([
  ['inspect', 'preflight'], ['preflight', 'preflight'], ['worktree', 'worktree'],
  ['planner', 'planner'], ['worker', 'writer'], ['writer', 'writer'], ['patch', 'writer'],
  ['tests', 'tests'], ['verifier', 'verifier'], ['verifier_format', 'verifier'],
  ['judge', 'judge'], ['judge_format', 'judge'], ['thinker', 'judge'],
  ['seal', 'seal'], ['scope', 'scope'], ['cleanup', 'cleanup'],
]);

/** 바인딩의 역할 이름 → 호스트 어휘. 역할이 없으면 접힌 phase 로 한 번 더 찾는다. */
export const PROGRESS_ROLES = new Map([
  ['planner', 'planner'], ['worker', 'writer'], ['writer', 'writer'],
  ['tests', 'tests'], ['verifier', 'verifier'], ['thinker', 'judge'], ['judge', 'judge'],
]);

/** 음수도 실수도 알림에 실리지 않는다 — `attempt=<k>/<budget>` 은 정수 두 개다. */
const progressInt = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback);

/**
 * 호스트의 `notifications/progress` 생산자를 만든다. 진행 토큰이 없으면 `undefined` —
 * 호스트가 요청하지 않은 알림을 보내면 안 된다(MCP 스펙).
 *
 * ★ 왜 필요한가: MCP stdio 는 30분 유휴에서 끊긴다(§6). 엔진은 프로바이더의 진행을 위로
 *   올리는데 그것을 받아 호스트로 내보내는 곳이 없었다 — 중계는 살아 있고 생산자가 0곳
 *   이었다. 매니페스트 `timeout` 이 1겹 더 있지만(둘 다 3600000), 조용한 긴 스텝에서
 *   유휴 타이머를 리셋하는 것은 이 알림뿐이다.
 *
 * ★★ `message` 는 문장이 아니라 **고정 형식의 한 줄**이다(WS0 §4, 계약의 `messagePattern`):
 *    `<runId> lane=<A|B|-> role=<..> phase=<..> attempt=<k>/<budget>`. 봉투를 잃은 사용자가
 *    `run_id` 를 되찾는 경로가 이 알림이므로 runId 는 **첫 줄부터** 실린다. 실리는 값은 전부
 *    닫힌 어휘·정수·runId 다 — 모델 산문은 이 채널에도 안 들어온다(불변식 4).
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
  let total = 0;

  return (event) => {
    try {
      const phase = PROGRESS_PHASES.get(event?.phase) ?? PROGRESS_FALLBACK;
      const at = now();
      // 단계가 바뀌면 상한과 무관하게 보낸다 — 단계 전환이 사람에게 가장 쓸모 있는 신호다.
      if (phase === lastPhase && at - lastAt < gap) return;
      lastPhase = phase;
      lastAt = at;
      sequence += 1;
      const budget = progressInt(event?.budget, 0);
      const candidates = progressInt(event?.candidates, 1);
      // 추정기는 WS0 §4 의 값이다: 시도마다 프로바이더 네 번 + 레인마다 고정 세 단계.
      // 추정치는 늘 수는 있어도 줄지 않는다 — 줄면 호스트의 막대가 뒤로 간다.
      total = Math.max(total, candidates * (budget * 4 + 3), sequence);
      const lane = event?.laneId === 'lane-a' ? 'A' : event?.laneId === 'lane-b' ? 'B' : '-';
      const role = PROGRESS_ROLES.get(event?.role) ?? PROGRESS_ROLES.get(phase) ?? PROGRESS_FALLBACK;
      const runId = typeof event?.runId === 'string' && event.runId !== '' ? event.runId : '-';
      const sent = sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: sequence,
          total,
          message: `${runId} lane=${lane} role=${role} phase=${phase} attempt=${progressInt(event?.step, 0)}/${budget}`,
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
  orch_status: runOrchStatus,
  orch_apply: runOrchApply,
  orch_reward: runOrchReward,
  orch_reset: runOrchReset,
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
        reasonCode: REASON.config_tool_unknown,
        params: { name: errorText(name), tools: TOOL_SPECS.map((t) => t.name).join(', ') },
      });
    }

    // ★ MCP 스펙에서 `arguments` 는 optional 이고 SDK 는 생략된 값을 `{}` 로 정규화하지
    //   않는다(실측: 진짜 stdio 왕복에서 `{name:'orch_models'}` 만 보내면 `undefined` 가
    //   온다). 그것을 "인자는 JSON 객체여야 합니다" 로 거부하면, `arguments` 를 생략하는
    //   클라이언트에게 `orch_models` 는 아예 동작하지 않는 도구가 되고 오류 문구는 모델이
    //   JSON-RPC 프레임을 고치라는 뜻이라 스스로 회복할 수 없다.
    //   `undefined` 만 정규화한다 — `null` 은 "값을 명시적으로 비웠다" 라 계속 거부한다
    //   (`args ?? {}` 는 그 둘을 같게 만든다).
    const input = args === undefined ? {} : args;
    if (spec.name === 'orch_reset') {
      const confirmationFailure = resetConfirmationFailure(input);
      if (confirmationFailure !== null) return confirmationFailure;
    }
    const validated = validateArgs(input, spec.args);
    if (!validated.ok) {
      return failure({ status: 'invalid', reasonCode: validated.reasonCode, error: validated.error, recovery: validated.recovery });
    }

    // ★ 이 분기는 지금 도달할 수 없다 — `TOOL_SPECS` 의 두 이름이 `HANDLERS` 에 다 있다.
    //   그래도 남기되 **문구를 호출자 탓에서 우리 탓으로** 바꾼다. 이 분기가 발화하려면
    //   스펙과 핸들러 표가 어긋나야 하고 그건 서버 내부 배선 버그다. 호출자에게
    //   "계획 범위를 확인하세요" 라고 말하면 고칠 수 없는 일을 시키는 것이다.
    const handler = HANDLERS[spec.name];
    if (typeof handler !== 'function') {
      return failure({ status: 'failed', reasonCode: REASON.run_tool_handler_missing, params: { name: spec.name } });
    }

    return await handler(validated.value, context);
  } catch (error) {
    return failure({ status: 'failed', reasonCode: REASON.run_tool_failed, params: { detail: errorText(error) } });
  }
}
