// src/learn/bandit.mjs
import { cellKeyOf, PRIOR } from './posteriors.mjs';

/**
 * §7.2 의 결정 축과 팔, 그리고 그 위의 Thompson sampling.
 *
 * 이 모듈은 **순수하다** — 파일도 시각도 전역 난수도 읽지 않는다. 사후분포는 인자로 받고
 * (`cells`), 주사위도 인자로 받는다(`random`). 태스크 8 이 `readPosteriors` 를 부르고 그
 * 결과를 여기 넘긴다. 그래야 밴딧이 잠금과 무관해지고, 테스트가 주사위에 걸리지 않는다.
 *
 * ★ `default` 는 밴딧을 안 태울 때 쓰는 값이고, **아무렇게나 고른 값이 아니다**:
 *   - `mix` — 설계 §9.2: "orch_run 을 부른 건 교차검증을 요구한 것"
 *   - `claude>codex` — `providers/index.mjs` 의 레지스트리 순서(worker=첫째, verifier=둘째)
 *   - `deep` — 계획 2 의 엔진이 하던 것(모든 스텝이 같은 배치를 쓰고 피드백만 넘긴다)
 *   - `strong` — 설계 §9.3: 강한 티어가 오케스트레이션 붕괴 자체를 덜 낸다
 *
 * 팔 이름의 `claude`·`codex` 는 **벤더 이름**이지 모델 식별자가 아니다.
 */
export const AXES = Object.freeze({
  mix: Object.freeze({ arms: Object.freeze(['mix', 'single']), default: 'mix' }),
  placement: Object.freeze({ arms: Object.freeze(['claude>codex', 'codex>claude']), default: 'claude>codex' }),
  rewrite: Object.freeze({ arms: Object.freeze(['deep', 'wide']), default: 'deep' }),
  tier: Object.freeze({ arms: Object.freeze(['strong', 'fast']), default: 'strong' }),
});

/**
 * 이 수의 관측이 쌓이기 전에는 밴딧을 안 태운다.
 *
 * 설계 §7.5 는 "밴딧이 증거를 공급한다" 고만 하고 증거가 없을 때를 안 적었다. 게이트가
 * 하는 일은 **표본 0 에서 기본값을 흔들지 않는 것**이다. 그 기본값들은 아무렇게나 고른 값이
 * 아니고(위 `AXES` 주석), 증거가 0 인 주사위로 그것을 뒤집을 근거가 없다.
 *
 * ★ 게이트는 **채점 5회 뒤의 진동을 줄이지 않는다.** 처음 여기 적었던 「그 진동이 표본을
 *   채우기 전에 신뢰를 깬다」는 게이트가 진동을 없앤다는 뜻으로 읽히는데, 실측은 그렇지
 *   않다. 시뮬레이션을 **읽는 사람이 같은 수를 얻을 만큼** 적는다 — 아래 여섯이 다 고정돼야
 *   같은 표가 나온다. (한 줄만 달라도 표가 통째로 바뀐다는 실측이 이 블록 끝에 있다.)
 *     (1) 난수는 `test/learn-bandit.test.mjs` 의 mulberry32(`prng`), 시드 1·2·3.
 *     (2) `decide` 와 등급 추첨이 **스트림 하나**를 이어 쓴다(따로 만들지 않는다).
 *     (3) 셀은 빈 `{}` 에서 시작하고 `allowed: { single: true }` 다.
 *     (4) 실행 1000회. 실행 하나는 `decide` → 등급 추첨 → 네 축 셀 갱신 순서다.
 *     (5) 등급은 **실행마다 하나**를 Bernoulli(0.7)로 뽑아 **네 축에 똑같이** 준다. 태스크 8
 *         이 그렇게 한다 — 등급 하나(`gradeOfRun`)로 네 축을 갱신한다(계획 :1363-1372).
 *         두 팔의 진짜 성공률이 같으므로 어느 팔을 골랐든 같은 0.7 이다.
 *     (6) 세는 것은 "직전 실행과 결정이 달라진 축 수" 이고 100실행 구간마다 합한다(최대 400).
 *   그러면:
 *     seed=1  78/66/100/95/110/131/139/98/106/83
 *     seed=2  127/103/112/94/93/101/125/112/136/96
 *     seed=3  108/124/149/151/142/141/120/143/113/187
 *   ★ **0 으로 감쇠하지 않는다.** 구간 30개가 전부 66~187(400의 17~47%) 안에 있다. 그 이상은
 *     말하지 않는다 — 시드 3개로는 "감쇠가 전혀 없다" 를 못 세운다(seed=2 는 마지막 구간이
 *     첫 구간보다 낮고 seed=3 은 높다).
 *   ★ (5)를 「축마다 따로 Bernoulli(0.7)」로 바꾸기만 해도 같은 시드에서 표가 **달라진다**:
 *     seed=1 이 115/141/92/77/56/60/75/75/60/72 가 되어 초반보다 낮은 수준(56~75)에서
 *     평탄해진다. 그 변형은 태스크 8 의 갱신 규칙이 아니지만 **수를 결정하는 것은 설정**
 *     이라는 증거다. 결론(0 으로 감쇠하지 않는다)은 두 표에서 같다.
 *   게이트가 열리는 **순간**도 조용하지 않다 — 기본 팔에 5건이 쌓이고 대안은
 *   prior 일 때 대안 선택률은 5건 전부 성공이면 14.3%, 전부 실패면 85.7%, 3승2패면 42.9%
 *   다(해석값 1/7·6/7·3/7, 몬테카를로 400000표본에서 소수 첫째 자리까지 일치).
 *   ★ 그래서 게이트는 **미루는 장치**이지 안정화 장치가 아니다. 진짜 안정화는 태스크 6·8
 *     에서 정한다 — 여기서 즉흥으로 넣지 않는다.
 *
 * ★ 태스크 8 은 채점된 실행마다 **배울 것이 있는 축만** 갱신한다 — 네 축 전부가 아니다.
 *   밴딧이 여기서 알아야 하는 사실은 그 한 줄이 전부다.
 *
 *   **정본은 `src/engine.mjs` 의 `axesFor` 다.** 구조만 적어 둔다: 거르기가 **두 겹**이다 —
 *   `learnable` 이 **결정 시점에** 한 번 거르고, `axesFor` 가 봉투의 `stopReason` 으로 **다시**
 *   거른다(둘째 겹의 이유는 `axesFor` 바로 위 주석에 있다). 어느 조합이 어떤 값을 내는지는
 *   **여기 적지 않는다.** 조합별 실제 값은 `test/engine.test.mjs` 의
 *   `★ ③ …`·`★ ④ …`·`★ 테스트 정의 위조는 …` 픽스처들이 **정확값으로** 고정하므로, 알고
 *   싶으면 그것을 읽어라.
 *
 *   ★★ **여기에 목록도 규칙도 적지 마라 — 세 번 틀렸다.** ①조합 목록에 `mix` 팔을 결정 요인
 *      으로 적었는데 그 참조는 이미 지워진 뒤였다. ②같은 목록의 「그 밖의 평범한 실행은 네 축
 *      전부」는 역할을 **하나만** 지정한 실행에서 거짓이었다. ③목록을 지우고 「무연산인 축과
 *      실제와 갈리는 축을 뺀 나머지」라는 **규칙**으로 바꿨는데 그 규칙도 거짓이었다.
 *      **네 번째 시도는 하지 않는다.** 세 번 다 같은 방식으로 들통났다 — **저장소 안의 테스트가
 *      이 주석을 반증했다.** **목록도 규칙도 코드보다 오래 못 산다. 코드를 가리켜라.**
 *   **그래서 문턱 도달이 축마다 갈린다** — 축이 따로 켜질 수 있다.
 *   옛 실측은 전제를 붙여야 참이다: **네 축이 함께 갱신되는 실행만 이어질 때** 채점 1~4회 뒤
 *   0축, 5회 뒤 3축이 동시에 켜진다(나머지 하나인 `mix` 는 `allow_single` 없이는 팔이 하나뿐
 *   이라 켜질 자리가 없다). `test/learn-bandit.test.mjs` 의 짝 테스트가 그 조건부 사실을 잰다.
 */
export const OBSERVATION_THRESHOLD = 5;

/** 태스크 클래스를 못 알아볼 때 떨어지는 곳. `classifyTask` 의 낙하지점과 같다. */
const FALLBACK_CLASS = 'analysis';

/**
 * Marsaglia–Tsang 의 채택 루프 상한.
 *
 * 실측(shape 1·1.0001·2·6·51 각 300000표본): 채택률 95.2~99.9%, 최악 shape 에서 관찰된
 * 최대 반복은 **5회**였다. 채택률 하한 0.952 로 잡아도 200회 연속 기각은 0.048^200 이라
 * 정상 난수로는 도달하지 않는다.
 *
 * ★ 아래 `unit` 이 (0,1) 밖을 0.5 로 접어도 **(0,1) 안의 상수는 그대로 통과하고, 그중 일부는
 *   여기를 소진한다.** 실측(셀 `{strong:(2,20), fast:(20,2)}`, `decide` 한 번당 난수 호출 수):
 *     - 12회로 끝남: 0·0.25·0.5·0.75·0.99·1·2·-1·NaN·±Infinity·`1-2^-53`·0.999999999999
 *     - **1206회(=이 상한까지 간 뒤 폴백)**: `1 - k·2^-53` 의 k=2·3·8·13·14(k=1..200 중
 *       그 다섯. k=201..2000 에는 없다), 그리고 **약 1.36e-104 이하**의 극소수(1e-300·
 *       5e-324 포함). 벽시계 0.06~0.5ms.
 *       ★ 그 경계를 처음엔 「1e-200 이하」로 적었는데 **100자리 틀렸다.** 이 픽스처에서
 *         10의 거듭제곱은 1e-103 이 12회, **1e-104 가 1206회**이고, 이분탐색으로 좁히면
 *         1.3625480831669655e-104(소진)와 그 바로 위 …656e-104(12회) 사이다. 경계는
 *         픽스처에 딸린 수다 — 다른 (α,β) 에서 다시 재야 한다.
 *   격자 스캔으로는 안 잡혔다 — 등간격 999점 · 1e-4 간격 9999점 · 0.9~1.0 을 1e-6 간격
 *   100000점에서 반례 0. ★ 이것은 "그 밖에는 없다" 가 **아니다**: 고정 z 에서 채택 여부는
 *   결정론적이라 스캔은 반례의 부재를 증명하지 못한다. 재 본 격자에서 못 찾았을 뿐이다.
 *   위 경계도 마찬가지다 — 경계 아래 2994점·위 5000점을 무작위로 찍어 예외를 못 찾았을 뿐,
 *   소진 집합이 구간 하나라는 것을 증명하지는 않았다(1 에 붙은 다섯 값이 이미 경계 위다).
 *
 *   결정은 소진해도 바뀌지 않았다(위 픽스처에서 전부 `fast`). 상한을 두는 이유가 그것이다 —
 *   200 은 정상 난수로는 닿지 않으면서 고장 난 주사위의 비용을 **축당 2404회**
 *   (= 2 팔 × 2 감마 × (3·ACCEPT_TRIES + 1). `shape < 1` 부스트가 감마마다 `unit()` 을
 *   하나 더 쓴다) 안으로 묶는다. 게이트를 넘는 (α,β) 조합 1,105,874회를 병적인 상수 일곱
 *   가지로 스캔한 **실측 최대는 2402회**다(`{strong:(0.1,0.1), fast:(2,5)}` ·
 *   `random()=1e-300`, 0.6ms). 처음 적었던 「2400회 이내」는 그 실측보다 작았다.
 */
const ACCEPT_TRIES = 200;

/** 유한한 양수 쌍만 통과. 하나라도 아니면 그 팔은 prior 다 — `posteriors.mjs` 의 `clampArm` 과 같은 판정. */
function shapesOf(cell, arm) {
  const value = cell !== null && typeof cell === 'object' && Object.hasOwn(cell, arm) ? cell[arm] : null;
  const alpha = value?.alpha;
  const beta = value?.beta;
  const good = Number.isFinite(alpha) && alpha > 0 && Number.isFinite(beta) && beta > 0;
  return good ? { alpha, beta } : { ...PRIOR };
}

/**
 * 이 축의 팔들에 쌓인 관측 수. prior 위에 얹힌 것만 세고 팔마다 0 에서 막는다.
 *
 * ★ `knownArms` 를 받는 이유: 셀에 **이 축의 팔이 아닌 것**이 남아 있을 수 있다(티어가
 *   셋이던 시절의 팔, 손으로 쓴 파일). 그 관측은 지금 고르는 두 팔에 대해 아무것도 말하지
 *   않는데, 세어 버리면 증거 0 인 채로 게이트가 열린다 — 실측: 셀이 `{medium:(1,21)}` 뿐일
 *   때 셀 전체 합은 20 이라 밴딧이 켜지고, strong 과 fast 는 둘 다 prior 인 채로 동전
 *   던지기가 된다. 게이트가 막으려던 바로 그 상태다.
 *
 * ★ 팔마다 `Math.max(0, …)` 로 막는 것은 prior 밑으로 내려간 팔(사람이 쓴 파일)이 형제
 *   팔의 관측을 **깎지** 않게 하기 위해서다.
 *
 * `orch_stats`(태스크 10)가 셀마다 "관측 몇 건 · 밴딧 켜짐?" 을 보여줄 때 같은 함수를
 * 쓰면 화면의 수와 게이트의 수가 어긋나지 않는다.
 *
 * ★ `knownArms` 는 **필수**다(배열이 아니면 0). 선택 인자로 두면 인자를 뺀 호출이 셀 전체
 *   팔을 합하던 결함으로 조용히 돌아간다 — 실측(필수화 전): `observationsOf({a:(4,1),
 *   z:(40,1)})` 가 42, 3티어 시절 팔이 남은 `{strong:(1,1), medium:(1,21), fast:(1,1)}` 가
 *   20 을 냈다. 0 은 눈에 띄고(화면이 "관측 0건" 인데 게이트가 열려 있으면 바로 보인다)
 *   그럴듯한 큰 수는 안 띈다. 인계 문장보다 코드가 세다.
 */
export function observationsOf(arms, knownArms) {
  if (!Array.isArray(knownArms)) return 0;
  // 셀이 객체가 아닐 때를 여기서 또 거르지 않는다 — `shapesOf` 가 그때 PRIOR 를 내므로
  // 합이 0 이 된다. 별도 가드를 두었더니 **죽는 뮤턴트가 오히려 줄었다**(실측: 가드가 있으면
  // `shapesOf` 의 셀 판정을 지워도 전부 초록, 가드를 빼면 아래 `observationsOf(null, arms)`
  // 단언이 그것을 잡는다).
  let total = 0;
  for (const name of knownArms) {
    const { alpha, beta } = shapesOf(arms, name);
    total += Math.max(0, alpha + beta - PRIOR.alpha - PRIOR.beta);
  }
  return total;
}

/**
 * 주입된 난수를 (0,1) 안으로 정규화한다.
 *
 * ★ 두 경우를 **다르게** 다룬다:
 *   - `0` 은 `Math.random()` 이 실제로 낼 수 있는 값이다(확률 2^-53). 값을 부정하지 않고
 *     로그 특이점만 피해 옮긴다. 정규화가 **통째로** 없으면 `Math.log(0) = -Infinity` 로
 *     z 가 폭발한다. (이 한 줄만 지우면 `Math.log(0)` 은 안 불린다 — 다음 줄의
 *     `!(value > 0 …)` 이 0 을 이미 잡기 때문이다. 이 줄이 정하는 것은 0 을 **극소값으로 볼지
 *     동전으로 볼지**이고, 그 차이는 관측된다: 실측 `sampleBeta(2,20)` 이 0.38539573 vs
 *     0.03635636, 셀 `{deep:(6,1), wide:(12,2)}` 의 결정이 `wide` vs `deep`.)
 *   - (0,1) 밖의 값과 `NaN` 은 `Math.random()` 이 **낼 수 없는** 값이다. 주사위가 고장 난
 *     것이므로 동전(0.5)으로 본다.
 *
 * ★ (0,1) 밖을 0.5 로 보내는 것이 `1 - Number.EPSILON` 으로 보내는 것보다 낫다.
 *   실측: `random()` 이 늘 1 일 때 `1 - Number.EPSILON` 은 z≈0 · v≈1 이라 채택 조건의
 *   양변이 거의 같아져 **채택이 영영 안 된다** — `decide` 한 번에 random 호출이 12회에서
 *   1206회로 뛴다. 0.5 로 보내면 첫 반복에 채택된다(12회). 이 픽스처에서는 결정이 같았지만
 *   ((2,20) vs (20,2) 에서 둘 다 `fast`), (0,1) **밖의** 상수가 채택 루프를 소진하지 않는
 *   편이 계약이 단순하다. (0,1) **안**은 그렇게 못 만든다 — `ACCEPT_TRIES` 주석을 보라.
 */
function unit(random) {
  const value = random();
  if (value === 0) return Number.EPSILON;
  // `!(… )` 로 쓰는 이유는 `NaN` 을 함께 걸기 위해서다 — `NaN > 0` 도 `NaN < 1` 도 false 다.
  if (!(value > 0 && value < 1)) return 0.5;
  return value;
}

/**
 * Gamma(shape, 1) 표본. Marsaglia–Tsang.
 *
 * `shape` 는 호출자가 유한한 양수로 보장한다. ★ 그 보장이 없으면 `shape = -Infinity` 에서
 * `-Infinity + 1 === -Infinity` 라 아래 재귀가 끝나지 않는다 — 실측으로 RangeError
 * (Maximum call stack size exceeded)가 났다. 태스크 8 은 이 자리를 `try` 없이 부른다.
 */
function sampleGamma(shape, random) {
  // shape < 1 은 boost 로 처리한다: X ~ Gamma(a+1) 이고 U ~ U(0,1) 이면 X·U^(1/a) ~ Gamma(a).
  // 호출자가 shape > 0 을 보장하므로 재귀는 정확히 한 겹이다.
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(unit(random), 1 / shape);

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < ACCEPT_TRIES; attempt += 1) {
    // Box–Muller 로 표준정규 하나.
    const u1 = unit(random);
    const u2 = unit(random);
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const v = (1 + c * z) ** 3;
    if (v <= 0) continue;
    const u = unit(random);
    if (Math.log(u) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v;
  }
  // 여기 닿는 것은 (0,1) 안의 일부 상수와 기각만 내도록 짜인 수열이다(위 `ACCEPT_TRIES` 주석).
  // 평균으로 떨어뜨린다 — 결정은 반드시 나온다.
  //
  // ★ 그때의 규칙은 **탐욕 규칙이 아니다.** 폴백 draw 는 f(α,β) = (α−1/3)/(α+β−2/3) 이라
  //   사후평균 m 에서 (2m−1)/(3n−2) 만큼 어긋나고, m<0.5 이면 그 결손이 관측 수 n 에 반비례해
  //   줄어든다 → **사후평균은 낮지만 관측이 많은 팔이 이긴다.** 실측 반례(도달 가능한 값):
  //   (5,6) 사후평균 0.454545·폴백 0.451613 vs (452,548) 사후평균 0.452000·폴백 0.451968 —
  //   사후평균은 앞을, 폴백은 뒤를 고른다. 순서가 뒤집힐 수 있다는 뜻이다.
  //
  // ★ 폴백 **값 자체**도 결정에 보인다. 한 팔의 감마 둘이 **모두** 폴백이면 `d` 를 상수배해도
  //   `x/(x+y)` 가 안 움직이지만, **하나만** 폴백이면 움직인다 — 실측: 셀
  //   `{strong:(1,1), fast:(5,7)}` · `random()=1-Number.EPSILON`(난수 609회, 감마 넷 중
  //   하나만 소진)에서 이 `return d` 를 `return d * 2` 로 바꾸면 결정이 `strong` → `fast` 다.
  return d;
}

/**
 * Beta(alpha, beta) 표본. Gamma 두 개의 비로 만든다 — 의존성 없이 충분하다.
 *
 * ★ 내보내는 이유는 **분포가 맞는지가 이 모듈의 핵심 성질인데 `decide` 를 통해서는 argmax
 *   밖에 볼 수 없기 때문**이다. `test/learn-bandit.test.mjs` 가 표본 평균·분산을 해석적
 *   값 `α/(α+β)` · `αβ/((α+β)²(α+β+1))` 와 맞춰 본다. `classify.mjs` 가 순서 실험을
 *   재현하려고 `CLASSIFY_PATTERNS` 를 내보내는 것과 같은 이유다.
 */
export function sampleBeta(alpha, beta, random) {
  const draw = typeof random === 'function' ? random : Math.random;
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : PRIOR.alpha;
  const b = Number.isFinite(beta) && beta > 0 ? beta : PRIOR.beta;
  const x = sampleGamma(a, draw);
  const y = sampleGamma(b, draw);
  // 0 나눗셈을 막는다. 도달 경로는 α 가 극히 작을 때의 언더플로다 — 예를 들어 α=1e-300 이면
  // 부스트의 `u^(1/α)` 가 0 으로 내려앉는다. 위에서 shape 를 정규화했으므로 x·y 가 NaN 이나
  // 음수가 되는 경로는 없고, 그래서 `> 0` 과 `!== 0` 은 여기서 같은 뜻이다.
  return x + y > 0 ? x / (x + y) : 0.5;
}

/**
 * 소수 관측(손으로 쓴 파일)을 사람이 읽을 수로. 정수는 정수로 둔다.
 *
 * ★ 상한을 두는 이유: `posteriors.mjs` 의 `clampArm` 이 **유한한 양수**를 전부 통과시키므로
 *   손으로 쓴/깨진 사후분포가 거대 α 를 들여올 수 있고, 이 문자열은 태스크 8 이 플래너
 *   지시문 **앞에** 붙인다. 실측(상한 없을 때): 셀 `{strong:(1e308,1), fast:(1e308,1)}` 이
 *   `"· tier: strong — 관측 1e+308건 중 성공 1e+308건 (이 축 전체 Infinity건)"` 을 냈다.
 *   던지지도 무한 루프도 아니지만 사람이 읽는 수가 아니고, `Infinity` 라는 낱말이 모델의
 *   입력으로 들어간다.
 *
 * ★ 1e6 이라는 **값 자체에는 운영 근거가 없다.** 잰 것은 거대 α 가 들어올 수 있다는 것뿐
 *   (1e308)이고, 실제 운영에서 관측이 6자리를 넘는지는 **재지 않았다.** 화면을 만드는
 *   태스크 10 이 다시 정할 값이다.
 */
const COUNT_CAP = 1e6;
const count = (value) => {
  // `!(value <= CAP)` 으로 쓰는 이유는 `NaN` 과 `Infinity` 를 함께 걸기 위해서다. `<` 로 쓰면
  // **정확히** 1,000,000 인 관측이 `"1,000,000+"` 로 나가 한 건 더 있다고 말한다 — 실측:
  // 팔 (α=1000001, β=1) 이 `"관측 1,000,000+건"` 이었고 `<=` 에서 `"관측 1000000건"` 이다.
  if (!(value <= COUNT_CAP)) return '1,000,000+';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/**
 * §9.2: `single` 은 호출자가 명시적으로 허용해야만 후보가 된다.
 *
 * ★ 내보내는 이유는 `observationsOf` 와 같다 — **화면과 게이트가 같은 것을 봐야 한다.**
 *   `decide` 는 관측 게이트보다 **먼저** `arms.length < 2` 에서 떨어뜨리므로, `mix` 축은
 *   `allow_single` 없이는 관측이 아무리 쌓여도 기본값으로 돈다. `orch_stats`(태스크 10)가
 *   관측 수만 보고 "밴딧 켜짐" 이라고 쓰면 그 축에서 거짓말이 된다 — 그쪽도 이 함수를 쓴다.
 */
export const armAllowed = (axis, arm, allowSingle) => axis !== 'mix' || arm !== 'single' || allowSingle;

const EVIDENCE_HEADER = '━━━ 이 저장소에서 관찰된 사실 ━━━';

/**
 * 옵션 하나를 던지는 게터를 견디며 읽는다. 실패하면 `fallback`.
 *
 * ★ 필요한 이유: `decide` 의 계약이 「절대 throw 하지 않는다」인데 옵션을 **읽는 것만으로도**
 *   던질 수 있다 — 실측(도입 전): `{ get cells() { throw } }`·`{ get taskClass() {…} }`·
 *   `{ get allowed() {…} }`·`{ get random() {…} }`·`{ allowed: { get single() {…} } }`
 *   다섯 자리가 전부 밖으로 나갔다.
 */
function readOption(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * 네 축의 결정을 한 번에 고른다. **절대 throw 하지 않고 항상 완전한 결정을 낸다.**
 *
 * @param spec.cells    `readPosteriors()` 의 `cells` — 이 모듈은 파일을 읽지 않는다
 * @param spec.taskClass `classifyTask()` 의 결과
 * @param spec.allowed  `{ single: boolean }` — `single` 은 호출자가 허용해야만 뽑힌다(§9.2)
 * @param spec.random   주입 가능한 난수. 테스트가 주사위에 걸리지 않게 한다
 * @returns `{ decisions, sources, evidence }` — `sources[axis]` 는 `'bandit'` 또는 `'default'`
 *
 * ★ `taskClass` 가 문자열이 아니면 `analysis` 로 떨어진다. 그 자리에서 **읽는 셀과 쓰는 셀이
 *   갈라진다** — 태스크 8 은 자기가 들고 있는 값으로 `cellKeyOf` 를 부르므로 결정은
 *   `analysis::*` 를 읽고 갱신은 다른 키로 간다. 실제 경로에서는 `classifyTask` 가 늘 네
 *   문자열 중 하나를 내므로 닿지 않고, 닿아도 양쪽 다 없는 셀이라 기본값으로 돌 뿐이다.
 *
 * ★ 축마다 같은 `random` **스트림**을 이어서 쓴다. 스트림의 연속 출력이 서로 독립이므로
 *   축도 독립이다 — 실측(네 축이 모두 (6,6)인 셀, 20000회): 각 축의 첫 팔 선택률
 *   0.4963~0.5012, 축쌍 일치율 0.4976~0.5020.
 *
 *   ★ 원인은 **소비 개수가 축마다 다른 것이 아니다.** 소비는 사실상 상수다 — mulberry32
 *   시드 3개 × N=200000 에서 `decide` 한 번이 48회(네 축 12회씩)를 쓰는 실행이
 *   **92.09~92.19%**(나머지는 51회 7.5% · 54회 0.3% · 57회 0.01%). 소비가 정확히 48회인
 *   실행만 골라 다시 재도 축쌍 상관은 |r| ≤ **0.00536**(n≈184,200, 잡음 1/√n≈0.0023)로
 *   무조건부(|r| ≤ 0.00504)와 구별되지 않는다. 위험한 것은 개수가 아니라 **축마다 새
 *   생성기를 같은 시드로 만드는 것**이고, 이 함수는 그러지 않는다.
 *
 *   상수 난수를 넣으면 모든 축이 같은 draw 를 받지만, 그때는 표본기 자체가 결정적이라
 *   밴딧이 결정론적 규칙으로 바뀐 것이고 축 간 상관은 그 결과일 뿐이다.
 */
export function decide(spec) {
  const options = spec !== null && typeof spec === 'object' ? spec : {};
  const cells = readOption(() => (options.cells !== null && typeof options.cells === 'object' ? options.cells : {}), {});
  const taskClass = readOption(
    () => (typeof options.taskClass === 'string' && options.taskClass !== '' ? options.taskClass : FALLBACK_CLASS),
    FALLBACK_CLASS,
  );
  const allowSingle = readOption(() => options.allowed?.single === true, false);
  // ★ 여기의 `typeof … === 'function'` 은 **지금 도달 불가**다 — `decide` 는 `random` 을
  //   `sampleBeta` 에만 넘기고 그쪽이 같은 판정을 한다. 실측: 이 줄을
  //   `readOption(() => options.random, Math.random)` 으로 줄여도 태스크 36/36 · 전체
  //   838/838 초록이다. 그래도 지우지 않은 이유는 **지워서 죽는 뮤턴트가 늘지 않기** 때문
  //   이다. `observationsOf` 의 겹치던 가드는 지우니 늘어서 지웠다 — 기준은 그것 하나다.
  const random = readOption(() => (typeof options.random === 'function' ? options.random : Math.random), Math.random);

  const decisions = {};
  const sources = {};
  const lines = [];

  for (const [axis, axisSpec] of Object.entries(AXES)) {
    // ★ 축 하나가 던져도 나머지 축은 낸다. 이 `catch` 가 없으면 「절대 throw 하지 않는다」가
    //   문장으로만 남는다 — 실측(도입 전): 던지는 `random` 은 게이트가 **열린** 뒤에만 밖으로
    //   나갔고(닫혀 있으면 표본을 안 뽑으니 안 부른다), `cells`·`allowed`·`taskClass`·
    //   `random` 의 던지는 게터와 팔 값의 `alpha` 게터까지 여덟 자리가 나갔다.
    //   태스크 8 이 이 자리를 `try` 없이 부른다.
    // ★ 대가: 호출자 버그도 이 자리에서 삼켜진다. 남는 흔적은 `sources[axis] === 'default'`
    //   뿐이고, 그것은 "관측이 모자라 기본값" 과 구별되지 않는다. **이 태스크에서는 더 안
    //   남긴다** — `sources` 의 세 번째 값을 만들지, notice 를 낼지는 태스크 8·10 이 정한다.
    // ☞ 인계(태스크 8·10): 던지는 게터를 가진 호출자가 붙으면 `orch_stats` 화면은 "밴딧
    //   켜짐" 인데 그 축의 결정은 영원히 기본값이다. 그 구별을 넣을 자리가 여기다.
    try {
      // 셀은 **우리가 소유한 속성**일 때만 셀이다. 프로토타입에서 상속된 값은 이 저장소가
      // 쓴 학습 결과가 아니다(`posteriors.mjs` 가 `Object.fromEntries`·`Map` 을 쓰는 것과 같은 축).
      const key = cellKeyOf(taskClass, axis);
      const raw = Object.hasOwn(cells, key) ? cells[key] : null;
      const cell = raw !== null && typeof raw === 'object' ? raw : {};

      const arms = axisSpec.arms.filter((arm) => armAllowed(axis, arm, allowSingle));
      if (arms.length < 2) {
        decisions[axis] = axisSpec.default;
        sources[axis] = 'default';
        continue;
      }

      // 게이트는 **이 축의 팔 전체**로 잰다 — `allowed` 로 후보에서 빠진 팔의 관측도 이 축에
      // 대한 증거이고, 그래야 `orch_stats` 가 보여주는 수와 게이트가 같은 것을 센다.
      // ★ 앞을 내다본 선택이다. **지금 AXES 로는 두 계산이 구별되지 않는다** — 축마다 팔이
      //   둘뿐이라 하나가 빠지면 위 `arms.length < 2` 에서 먼저 걸린다. 팔이 셋 이상이 되는
      //   날에 갈라진다.
      const seen = observationsOf(cell, axisSpec.arms);
      if (seen < OBSERVATION_THRESHOLD) {
        decisions[axis] = axisSpec.default;
        sources[axis] = 'default';
        continue;
      }

      let best = arms[0];
      let bestDraw = -1;
      for (const arm of arms) {
        const { alpha, beta } = shapesOf(cell, arm);
        const draw = sampleBeta(alpha, beta, random);
        if (draw > bestDraw) {
          bestDraw = draw;
          best = arm;
        }
      }

      // ★ 뽑힌 팔의 관측을 말한다. 브리프는 여기서 **셀 전체 관측**과 **뽑힌 팔의 성공 수**를
      //   한 문장에 섞었다 — 실측: `{claude>codex:(2,1), codex>claude:(1,10)}` 에서
      //   `claude>codex` 를 뽑고 "관측 10건 중 성공 1건" 이라고 썼다. 그 팔의 관측은 1건이고
      //   10 은 형제 팔의 것이다. 태스크 8 이 이 문자열을 플래너 지시문에 붙이므로 틀린 수가
      //   모델의 입력이 된다.
      const picked = shapesOf(cell, best);
      const armSeen = Math.max(0, picked.alpha + picked.beta - PRIOR.alpha - PRIOR.beta);
      const wins = Math.max(0, picked.alpha - PRIOR.alpha);
      const line =
        armSeen === 0
          ? `· ${axis}: ${best} — 아직 관측이 없어 탐색으로 골랐습니다 (이 축 전체 ${count(seen)}건)`
          : `· ${axis}: ${best} — 관측 ${count(armSeen)}건 중 성공 ${count(wins)}건 (이 축 전체 ${count(seen)}건)`;

      // 결정과 근거를 **한꺼번에** 확정한다 — 위에서 던지면 이 축은 아래 `catch` 로 간다.
      decisions[axis] = best;
      sources[axis] = 'bandit';
      lines.push(line);
    } catch {
      decisions[axis] = axisSpec.default;
      sources[axis] = 'default';
    }
  }

  const evidence =
    lines.length > 0
      ? `${EVIDENCE_HEADER}\n${lines.join('\n')}`
      : `${EVIDENCE_HEADER}\n· 아직 판단할 만큼의 관측이 없어(축마다 ${OBSERVATION_THRESHOLD}건 필요) 기본값으로 진행합니다.`;

  return { decisions, sources, evidence };
}

/**
 * 결과 등급 → Beta 델타. 설계 §7.4.
 *
 * ★ `null` 은 "이 실행으로는 아무 셀도 갱신하지 않는다" 이다. 태스크 8 의 `gradeOfRun`
 *   (계획 문서 :1363-1372)이 내는 값은 `'success'`·`'failure'`·`null` **셋뿐**이므로,
 *   갱신하지 않기로 한 실행은 등급 문자열이 아니라 `null` 로 여기 들어온다.
 *   `'blocked'`·`'unverified'` 같은 **정지 사유**가 등급 자리에 잘못 흘러들어도 같은 답이
 *   나오게 두었다 — 모르는 값에 델타를 주는 것보다 안 배우는 쪽이 싸다.
 *
 * ★ 태스크 10 의 `orch_reward` 는 이미 반영된 기여를 `-alphaDelta`·`-betaDelta` 로 뺀다.
 *   그래서 두 등급의 델타 합이 정확히 관측 1건이어야 되돌리기가 원점으로 돌아간다.
 *
 * ★ 설계 §7.4 의 "약함 0.3" 등급은 **만들지 않는다.** 그 입력(verifier 의 PASS/FAIL)이
 *   코드에 없다 — `verifierOk` 는 프로바이더 에러와 워크트리 변경으로만 정해지고 베리파이어
 *   본문은 제어 흐름에 안 닿는다(실측). 그것을 만들려면 LLM 생성 형식을 새로 파싱해야 하고,
 *   그건 §12.-1 이 "델리게이트의 자기 보고 대신 우리가 읽은 종료 코드" 로 갈아엎은 방향의
 *   역주행이다. 테스트가 실제로 돈 실행만 학습한다.
 */
export function gradeToDeltas(grade) {
  if (grade === 'success') return { alphaDelta: 1, betaDelta: 0 };
  if (grade === 'failure') return { alphaDelta: 0, betaDelta: 1 };
  return null;
}
