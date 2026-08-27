/**
 * 이 실행이 **실제로 고른 것**과 그 선택이 팔에 귀속되는지를 얼려 내준다 — 학습의 장부이지
 * 조율이 아니다. 배치 팔의 정본에서 파생되는 상수 둘과 역할 배정(`assignRoles`)도 여기 산다.
 *
 * WS3 태스크 8(스펙 §0-M1)이 `src/engine.mjs` 에서 **바이트 보존**으로 옮겼다:
 * `tierArmsDistinguishable`+`freezeEffectiveChoices`(91줄)와 배치 상수 둘+`assignRoles`(33줄).
 *
 * ★ 왜 `learn/policy-v2.mjs` 가 아닌가. 그 파일은 :9-13 에서 스스로를 순수하다고 선언한다
 *   — 파일·시계·난수·사후분포·벤더 산문을 읽지 않는다. 이 클러스터는 `resolveTier` 로
 *   `settings` 를 읽으므로 거기 두면 그 문장이 깨진다. 게다가 같은 파일 :15-23 은 「왜 이
 *   모듈이 `effectiveChoices` 를 짓지 않는가」를 **부정 결과로** 기록해 둔 자리다.
 *
 * ★ 왜 `assignRoles` 와 배치 상수 둘이 같이 왔나. 남겨 두면 순환이다:
 *   `freezeEffectiveChoices` 가 `assignRoles` 를 부르므로 이 파일이 엔진을 수입하게 되고,
 *   엔진은 이 파일을 수입한다. 그래서 셋이 함께 왔고, 엔진은 `assignRoles` 를 다시 수입하고
 *   배치 상수 둘은 재수출한다(그 두 이름을 엔진에서 수입하는 자리가 있다).
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지). 방향은 engine → learn 이다.
 *   `tierArmsDistinguishable` 은 밖으로 내보내지 않는다 — 팔이 구별되는지의 판정은
 *   `freezeEffectiveChoices` 의 입력이지 계약이 아니다.
 */
import { AXES } from './bandit.mjs';
import { resolveTier, VENDORS } from '../config.mjs';
import { deepFreeze } from '../util/freeze.mjs';

const RUN_AXES = Object.freeze(['mix', 'placement', 'tier']);

/** pin/off를 밴딧 읽기보다 먼저 확정한다. c2는 두 벤더가 모두 writer라 지속 pin을 적용하지 않는다. */
export function resolveRunControls({ candidateCount, callWriter, projectWriter, settings }) {
  const writer = candidateCount === 1
    ? [callWriter, projectWriter, settings?.writer].find((value) => VENDORS.includes(value)) ?? null
    : null;
  const learning = settings?.learning === 'off' ? 'off' : 'on';
  const learningEnabled = learning === 'on' && writer === null;
  return deepFreeze({ writer, learning, banditEnabled: learningEnabled, mutationEnabled: learningEnabled });
}

/** 밴딧을 끈 실행은 AXES의 명시적 기본값만 쓰고, 내부 caller override 이음매는 보존한다. */
export function mergeRunDecisions(advice, overrides) {
  const supplied = overrides && typeof overrides === 'object' ? overrides : {};
  const decisions = {};
  const sources = {};
  for (const axis of RUN_AXES) {
    decisions[axis] = supplied[axis] ?? advice?.decisions?.[axis] ?? AXES[axis].default;
    sources[axis] = supplied[axis] === undefined ? advice?.sources?.[axis] ?? 'default' : 'caller';
  }
  return deepFreeze({ decisions, sources });
}

/** c1 역할을 한 자리에서 묶는다. writer pin의 verifier는 언제나 반대 벤더다. */
export function bindRunProviders({ providers, candidateCount, runOptions, decisions, writer }) {
  const pick = (wanted, fallback) => wanted == null ? fallback : providers.find((provider) => provider.id === wanted);
  const base = assignRoles(providers, decisions);
  if (candidateCount === 2) {
    return { planner: pick(runOptions.planner, providers[0]), writer: providers[0], verifier: providers[1] };
  }
  if (writer !== null) {
    const pinned = providers.find((provider) => provider.id === writer);
    return {
      planner: pick(runOptions.planner, pinned),
      writer: pinned,
      verifier: providers.find((provider) => provider.id !== writer),
    };
  }
  return {
    planner: pick(runOptions.planner, base.planner),
    writer: pick(runOptions.worker, base.worker),
    verifier: pick(runOptions.verifier, base.verifier),
  };
}

/**
 * 배치 팔의 정본은 `src/learn/bandit.mjs` 의 `AXES.placement` 하나다. 여기서 **파생**시킨다.
 *
 * ★ 왜 리터럴로 두면 안 되나: `assignRoles` 는 문자열 동등성으로 역전을 판단하므로 **모르는 값은
 *   전부 정방향으로 떨어진다**. 팔 이름을 바꾸면 밴딧은 새 이름을 뽑고, 엔진은 조용히 정방향으로
 *   돌고, 그 실행의 보상은 새 이름 셀로 들어간다 — 돌지도 않은 배치를 배웠다고 기록한다. 컴파일도
 *   테스트도 안 깨지므로 아무도 모른다. `tier` 축은 이미 `AXES.tier.arms` 를 읽는다.
 *
 * ★ `default` 가 정방향이라는 것은 우연이 아니다: `'claude>codex'` 는 등록 순서대로 첫째가
 *   쓰고 둘째가 검증한다는 뜻이고, 그것이 이 엔진의 정방향 정의다.
 */
export const FORWARD_PLACEMENT = AXES.placement.default;
export const REVERSED_PLACEMENT = AXES.placement.arms.find((arm) => arm !== FORWARD_PLACEMENT) ?? null;

export function assignRoles(providers, decisions) {
  const first = providers[0];
  const second = providers[1] ?? null;
  const reversed = decisions?.placement === REVERSED_PLACEMENT;

  if (second === null) return { planner: first, worker: first, verifier: first };

  // `single` 도 **어느 벤더로** 도는지는 placement 가 정한다. 첫째 벤더로 못 박으면 두 팔이
  // 같은 실행을 내므로 `single` 실행에서 placement 축이 무연산이 되고, 태스크 8 이 그 실행의
  // placement 셀에 보상을 준다 — 아무 일도 하지 않은 결정을 배웠다고 기록하는 것이다.
  if (decisions?.mix === 'single') {
    const only = reversed ? second : first;
    return { planner: only, worker: only, verifier: only };
  }

  const worker = reversed ? second : first;
  const verifier = reversed ? first : second;
  return { planner: worker, worker, verifier };
}

/**
 * Freeze what this Run actually chose, and whether that choice is attributable.
 *
 * ★ Only the coordinator can answer "was this a real choice?".  A terminal
 *   candidate summary shows the binding that ran but not why: it cannot tell a
 *   caller's role pin from a bandit draw, cannot see that `single` was never an
 *   offered arm, and cannot know the registry order the placement arm mapped
 *   onto.  `learn/policy-v2.mjs` therefore never reconstructs this — it only
 *   narrows what we assert here with facts it can check itself.
 *
 * ★ `arm` is the arm that **ran**, not the arm that was sampled.  c2 runs both
 *   placements mirrored and always cross-verifies, so its mix arm is `mix` even
 *   when the bandit had sampled `single` and the coordinator ignored it.
 *   Recording the sampled value would reward an arm no provider ever executed.
 */
/**
 * Did the tier arms actually name different runs?
 *
 * ★★ With no `settings.ini` — the out-of-box state — `resolveTier` returns the same
 *   `{ model: null, effort: null }` for **every** arm, so both arms spawn the identical CLI at
 *   identical effort.  The arm is then a label with nothing behind it, and rewarding it writes an
 *   observation about a distinction that never existed.  This file already refuses that three times
 *   over (`assignRoles` for `single` placement, §14.2 for c2 placement, `single_arm_not_offered`
 *   for mix); `learn/policy-v2.mjs` states the rule outright — what was never a choice stays out of
 *   both maps.  Tier was simply the axis nobody applied it to.
 *
 * ★ One configured tier is enough to make the axis real: `strong` resolves to that model while
 *   `fast` stays the CLI's own default.  So this asks whether the arms **differ**, not whether the
 *   user configured all of them.
 *
 * ★ Why it matters later rather than now: while the arms are identical every draw is free.  The
 *   counterfeit observations only bite once the owner runs `orch_config`, and design §7.6's decay
 *   was never built, so nothing washes them out.
 */
function tierArmsDistinguishable(settings, participants) {
  const vendors = [...new Set(participants.filter((provider) => provider != null).map((provider) => provider.id))];
  return vendors.some((vendorId) => {
    const resolved = AXES.tier.arms.map((arm) => {
      const value = resolveTier(settings, vendorId, arm);
      return JSON.stringify([value?.model ?? null, value?.effort ?? null]);
    });
    return resolved.some((value) => value !== resolved[0]);
  });
}

export function freezeEffectiveChoices({
  candidateCount, providers, decisions, tier, writerProvider, verifierProvider, runOptions, settings,
  writerPinned = false,
}) {
  // c2 refuses placement but still rewards tier, so the no-op guard belongs on both branches.
  const tierReal = tierArmsDistinguishable(settings, [writerProvider, verifierProvider]);
  if (candidateCount === 2) {
    return deepFreeze({
      // Two mirrored lanes are exactly the cross-verified mix; §14.2 refuses
      // placement because both arms ran and neither produced the result alone.
      mix: { arm: 'mix', identifiable: true, reason: 'mirrored_cross_verification' },
      placement: { arm: null, identifiable: false, reason: 'mirrored_two_lane_placement' },
      tier: {
        arm: tier,
        identifiable: tierReal,
        reason: tierReal ? 'actual_run_tier' : 'tier_not_distinguishable',
      },
    });
  }
  const rolePinned = writerPinned || runOptions.writer != null || runOptions.worker != null || runOptions.verifier != null;
  const expected = assignRoles(providers, decisions);
  // "The actual binding equals the recorded arm" is checked against the same
  // mapping the Run used, not re-derived from provider ids by hand.
  const bindingMatchesArm = providers.length >= 2 &&
    writerProvider.id === expected.worker.id && verifierProvider.id === expected.verifier.id;
  const actualMixArm = writerProvider.id === verifierProvider.id ? 'single' : 'mix';
  const singleWasOffered = runOptions.allowSingle === true;
  return deepFreeze({
    mix: {
      arm: actualMixArm,
      identifiable: !rolePinned && singleWasOffered && bindingMatchesArm && actualMixArm === decisions.mix,
      reason: rolePinned ? 'role_pin'
        : !singleWasOffered ? 'single_arm_not_offered'
        : !bindingMatchesArm ? 'provider_shortage'
        : actualMixArm !== decisions.mix ? 'arm_not_executed'
        : 'actual_single_lane_binding',
    },
    placement: {
      arm: decisions.placement,
      identifiable: !rolePinned && bindingMatchesArm,
      reason: rolePinned ? 'role_pin' : bindingMatchesArm ? 'actual_single_lane_binding' : 'provider_shortage',
    },
    tier: {
      arm: tier,
      identifiable: !rolePinned && tierReal,
      reason: rolePinned ? 'role_pin' : tierReal ? 'actual_run_tier' : 'tier_not_distinguishable',
    },
  });
}
