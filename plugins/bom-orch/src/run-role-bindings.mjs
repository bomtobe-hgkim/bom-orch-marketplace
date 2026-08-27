/**
 * 이 실행의 **역할 바인딩**이 정해지는 자리 — 모델 설정 읽기, 밴딧 결정, 프로바이더→역할 배정,
 * 쓰기 역할의 **보안 하한**, 그리고 티어가 정한 역할별 바인딩(플래너·레인 둘·심판)까지.
 * 이 함수가 끝나면 「누가 무엇을 어떤 모델로 하는가」에 남은 자유도가 없다.
 *
 * WS8 컷 2 가 `src/engine.mjs` 의 `prepareRunNamespace` 에서 뽑았다(로드맵 §3.11).
 *
 * ★★ **왜 별도 모듈인가.** 이 줄들은 **하나의 판정 사슬**이다: 설정이 티어를 고르고, 티어가
 *   모델을 고르고, 배정이 writer 를 정하고, 보안 하한이 그 writer 를 거부할 수 있다. 사슬의
 *   한 칸을 옮기면 나머지 넷의 전제가 깨지는데, 엔진 본문에 있는 동안에는 그 사실을 말하는
 *   자리가 없었다. 특히 보안 하한의 자리 근거(「writer 가 방금 확정됐고 아직 어떤 CLI 도 안
 *   띄웠다」)는 **바로 위 세 줄**에 대한 주장이라, 그 셋과 떨어지면 검증할 수 없는 문장이 된다.
 *   **새 역할·바인딩 판정은 이 파일로 들어간다.**
 *
 * ★ `configNotices` 는 **배열 그대로** 받아 밀어 넣는다(상위 schema 고지 둘이 여기서 난다) —
 *   종료 봉투가 나르는 채널을 새로 만들지 않는다.
 *
 * ★ `cleanupWorktrees`·`preparationExtras` 는 함수로 받는다: 거부 다섯 갈래가 전부 워크트리를
 *   치우고 그 결과를 봉투에 싣는데, 무엇을 치울지와 무엇이 앞에 붙을지는 부르는 자리가 안다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지). `requiredClone` 은
 *   `src/run-lane-adapters.mjs` 가 정본이고(WS8 컷 1) 이 파일은 그 이름을 수입한다 —
 *   스무 줄짜리 계약 docblock 을 들고 있어 복사하면 두 벌이 갈린다.
 */
import { readSettingsStatus as defaultReadSettingsStatus, resolveTier } from './config.mjs';
import { AXES, decide, evidenceParagraph } from './learn/bandit.mjs';
import {
  bindRunProviders,
  freezeEffectiveChoices,
  mergeRunDecisions,
  resolveRunControls,
} from './learn/effective-choices.mjs';
import { readPosteriors as defaultReadPosteriors } from './learn/posteriors.mjs';
import { POLICY_V2_AXES } from './learn/policy-v2.mjs';
import { REASON } from './reason-codes.mjs';
import { artifactBlocked } from './run-faults.mjs';
import { requiredClone } from './run-lane-adapters.mjs';
import { stateSchemaNotice } from './state-schema.mjs';
import { deepFreeze } from './util/freeze.mjs';

/**
 * 값이 없을 때 문장에 들어가는 토큰 — `src/engine.mjs` 의 같은 상수를 **복사**했다. 한 낱말짜리
 * 순수 상수를 이음매로 나르면 그 이음매가 조각 배달부가 된다(`src/run-finalization.mjs` 가 같은
 * 이름에 대해 이미 같은 판정을 내렸다).
 */
const UNKNOWN_VALUE = '<unknown>';

function exactRoleBinding(provider, settings, tier, role) {
  const selected = resolveTier(settings, provider.id, tier);
  return deepFreeze({
    providerId: provider.id,
    model: selected.model ?? null,
    effort: selected.effort ?? null,
    tier,
    role,
  });
}

/**
 * 역할 바인딩 사슬 하나. 거부는 `{ refusal }` 로 나가고(엔진이 자기 `halt` 로 감싼다), 통과는
 * 아래 준비 단계와 레인이 읽는 열셋을 낸다.
 */
export async function bindRunRoles({
  providers, runOptions, candidateCount, taskClass, baselineConfig, stateRoot, runId, deadline,
  deps, stage, logLine, configNotices, cleanupWorktrees, preparationExtras,
}) {
  let settings;
  try {
    const rawSettingsRead = await stage('model settings read', () => deps.readSettings === undefined
      ? defaultReadSettingsStatus(stateRoot)
      : deps.readSettings(stateRoot)).catch(() => ({}));
    // The long-standing injection seam returns the settings object itself.  The
    // default reader adds status metadata so an upper schema can be reported;
    // injected status-shaped readers are accepted without changing legacy ones.
    const statusShaped = rawSettingsRead !== null && typeof rawSettingsRead === 'object' &&
      Object.hasOwn(rawSettingsRead, 'settings') &&
      (Object.hasOwn(rawSettingsRead, 'readable') || Object.hasOwn(rawSettingsRead, 'stateSchema'));
    const settingsSchemaNotice = stateSchemaNotice(statusShaped ? rawSettingsRead.stateSchema : undefined);
    if (settingsSchemaNotice !== null) configNotices.push(settingsSchemaNotice);
    const settingsValue = statusShaped ? rawSettingsRead.settings : rawSettingsRead;
    settings = deepFreeze(requiredClone((settingsSchemaNotice === null ? settingsValue : {}) ?? {}));
  } catch {
    const cleanup = await cleanupWorktrees('settings preparation failure');
    return { refusal: artifactBlocked(runId, REASON.run_binding_preparation_failed, {}, preparationExtras(cleanup.notices)) };
  }
  const controls = resolveRunControls({
    candidateCount,
    callWriter: runOptions.writer,
    projectWriter: baselineConfig?.delegation?.writer,
    settings,
  });
  let decisions;
  let decisionSources;
  let bandit = null;
  try {
    if (controls.banditEnabled) {
      const rawPosteriors = await stage('learning state read', () =>
        (deps.readPosteriors ?? defaultReadPosteriors)(stateRoot)).catch(() => ({ ok: false, cells: {} }));
      const posteriors = requiredClone(rawPosteriors);
      const posteriorSchemaNotice = stateSchemaNotice(posteriors?.stateSchema);
      if (posteriorSchemaNotice !== null) configNotices.push(posteriorSchemaNotice);
      bandit = decide({
        cells: posteriors?.ok === true && posteriorSchemaNotice === null ? posteriors.cells : {}, taskClass,
        allowed: { single: runOptions.allowSingle === true },
        random: typeof deps.random === 'function' ? deps.random : Math.random,
      });
    }
    ({ decisions, sources: decisionSources } = mergeRunDecisions(bandit, runOptions.decisions));
  } catch {
    const cleanup = await cleanupWorktrees('binding preparation failure');
    return { refusal: artifactBlocked(runId, REASON.run_binding_preparation_failed, {}, preparationExtras(cleanup.notices)) };
  }
  const boundProviders = bindRunProviders({
    providers, candidateCount, runOptions, decisions, writer: controls.writer,
  });
  const plannerProvider = boundProviders.planner;
  const writerProvider = boundProviders.writer;
  const verifierProvider = boundProviders.verifier;
  if (!plannerProvider || !writerProvider || !verifierProvider || writerProvider.id === verifierProvider.id && runOptions.allowSingle !== true) {
    const cleanup = await cleanupWorktrees('invalid binding worktree');
    return { refusal: artifactBlocked(runId, REASON.run_binding_invalid, {}, preparationExtras(cleanup.notices)) };
  }
  // ★★ 설계 §5.8 S2(a) — 쓰기 역할의 보안 하한. 여기가 자리인 이유가 둘이다: writer 가 방금
  //   확정됐고, 아직 어떤 CLI 도 안 띄웠다. 막을 거면 워크트리를 쥐여주기 **전**에 막아야 한다.
  //
  // ★ c2 는 두 레인이 서로 바꿔 쓰므로 두 프로바이더가 **모두** writer 후보다. c1 은 writer 만
  //   묻는다 — 읽기 전용 역할은 강등 대상이 아니므로 그것 때문에 프로브를 돌리지 않는다.
  //   (설계 문구 그대로 "read-only 로 강등" 이다. 실행 금지가 아니다.)
  const writerCandidates = candidateCount === 2
    ? [writerProvider, verifierProvider]
    : [writerProvider];
  for (const candidate of new Set(writerCandidates)) {
    const probe = deps.securityFloor ?? (typeof candidate.securityFloor === 'function'
      ? (() => candidate.securityFloor(deadline))
      : null);
    if (probe === null) continue;
    let floor;
    try {
      floor = await stage(`${candidate.id} security floor`, () => probe(candidate.id, candidate));
    } catch {
      floor = null;
    }
    // 모르면 막지 않는다. 읽지 못한 버전은 「취약하다」의 증거가 아니고, 추측하는 게이트는
    // 버전 문자열 형식이 바뀌는 날 멀쩡한 설치를 전부 벽돌로 만든다.
    if (floor?.writable !== false) continue;
    const cleanup = await cleanupWorktrees('security floor rejection');
    // 설치된 버전은 **엔진이** 싣는다. 조치하는 사람이 가장 먼저 알아야 하는 값이라
    // 프로바이더가 문구에 넣어줬기를 기대하지 않는다. 프로바이더가 적어 온 사유는 로그로 간다 —
    // 그것은 벤더의 산문이고 봉투의 문구는 코드가 정한다.
    // ★ 하한 값도 **엔진이** 싣는다. "올리세요" 는 어디까지 올릴지 모르면 조치가 아니다 —
    //   프로바이더는 그 수를 `floor` 필드로 들고 오는데(산문에 섞지 않는다) 예전에는 그것을
    //   읽는 채널이 테스트뿐이었다. 봉투와 로그 둘 다 같은 값을 본다.
    const floorVersion = typeof floor.floor === 'string' && floor.floor !== '' ? floor.floor : UNKNOWN_VALUE;
    logLine('warn', REASON.provider_below_security_floor, 'security floor', {
      vendor: candidate.id, version: floor.version ?? '', floor: floorVersion, detail: floor.error ?? '',
    });
    return { refusal: artifactBlocked(runId, REASON.provider_below_security_floor, {
      vendor: candidate.id, version: typeof floor.version === 'string' ? floor.version : UNKNOWN_VALUE,
      floor: floorVersion,
    }, preparationExtras(cleanup.notices)) };
  }

  let tier;
  let plannerBinding;
  let laneBinding;
  try {
    tier = AXES.tier.arms.includes(decisions.tier) ? decisions.tier : AXES.tier.default;
    plannerBinding = exactRoleBinding(plannerProvider, settings, tier, 'planner');
    laneBinding = deepFreeze({
      writer: exactRoleBinding(writerProvider, settings, tier, 'worker'),
      verifier: exactRoleBinding(verifierProvider, settings, tier, 'verifier'),
    });
  } catch {
    const cleanup = await cleanupWorktrees('settings preparation failure');
    return { refusal: artifactBlocked(runId, REASON.run_binding_preparation_failed, {}, preparationExtras(cleanup.notices)) };
  }
  const laneBindings = candidateCount === 1 ? [laneBinding] : [
    laneBinding,
    deepFreeze({
      writer: exactRoleBinding(verifierProvider, settings, tier, 'worker'),
      verifier: exactRoleBinding(writerProvider, settings, tier, 'verifier'),
    }),
  ];
  const laneProviders = candidateCount === 1 ? [{ writer: writerProvider, verifier: verifierProvider }] : [
    { writer: writerProvider, verifier: verifierProvider },
    { writer: verifierProvider, verifier: writerProvider },
  ];
  const effectiveChoices = freezeEffectiveChoices({
    candidateCount, providers, decisions, tier, writerProvider, verifierProvider, runOptions, settings,
    writerPinned: controls.writer !== null,
  });
  /**
   * 설계 §7.5 의 근거 문단 — 밴딧이 계획을 짜는 게 아니라 **증거를 공급한다**.
   *
   * ★★ 이 배선은 `4b53bfe` 가 조용히 끊었다(`evidence: {}`). 그대로 되살리면 안 된다: 문단은
   *   `AXES` 전체를 돌며 만들어지므로 `rewrite`(엔진이 결정에서 버리는 축)와 구분되지 않는
   *   `tier`(팔 뒤에 아무것도 없는 상태)에 대한 문장까지 살아 있는 모델에게 간다. 기본 설치에서는
   *   문단의 절반 이상이 사실상 거짓이 된다.
   *
   * ★ 그래서 **이 실행이 실제로 고를 수 있었던 축만** 싣는다. `identifiable` 이 정확히 그
   *   질문의 답이고, 이미 위에서 얼어붙었다. 학습이 보상하지 않는 축은 모델에게도 말하지 않는다 —
   *   한 실행에 대해 두 곳이 다른 말을 하면 어느 쪽도 못 믿는다.
   *
   * ★ c2 블라인딩이 공짜로 지켜진다: 벤더 이름을 담은 축은 `placement` 하나뿐이고, c2 는 그것을
   *   `mirrored_two_lane_placement` 로 이미 식별 불가로 표시한다. 두 레인이 공유하는 계획
   *   텍스트에 벤더 이름이 실릴 길이 없다.
   */
  const plannerEvidence = bandit === null ? '' : evidenceParagraph(
    bandit, POLICY_V2_AXES.filter((axis) => effectiveChoices[axis]?.identifiable === true),
  );
  const judgeBindings = candidateCount === 2
    ? laneProviders.map(({ writer }) => exactRoleBinding(writer, settings, tier, 'thinker'))
    : [];
  return {
    refusal: null, controls, decisions, decisionSources, plannerProvider, writerProvider,
    verifierProvider, tier, plannerBinding, laneBindings, laneProviders, effectiveChoices,
    plannerEvidence, judgeBindings,
  };
}
