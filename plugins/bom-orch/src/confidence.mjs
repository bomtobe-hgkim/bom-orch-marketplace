/**
 * `confidence` 의 **단일 정의** — WS0 §2.2 의 도구별 표를 그대로 코드로 옮긴 순수 함수들.
 *
 * ★ 왜 한 파일인가. 값을 고르는 규칙이 생산자마다 있으면 같은 사건이 도구마다 다른 값으로
 *   나간다. 실측(WS2 리서치 `envelope-fields.json` item 8): `orch_models` 는 건강하게 프로브한
 *   설치에서도 `confidence` 를 아예 안 실어 봉투가 `unverified` 로 굳었고(`success()` 의 기본값),
 *   `orch_config` 의 조회는 파일을 읽었든 못 읽었든 `'verified'` 리터럴이었다. 두 자리 모두
 *   "이 호출이 무엇을 기계로 확립했나" 를 **묻지 않은** 채 값을 적은 것이다.
 *
 * ★ 이 파일은 아무것도 import 하지 않는 잎(leaf)이다. 봉투 어휘(`CONFIDENCE`)는
 *   `src/envelope.mjs` 가 정본이고, 두 파일이 갈리지 않는다는 것은
 *   `test/confidence.test.mjs` 의 첫 단언이 잰다 — 순환 없이 잇는 유일한 방법이다.
 *
 * ★ **불리언 `true` 만 참으로 본다.** 이 자리에 오는 값은 `x === 'verified'` 같은 비교의
 *   결과여야 한다. 진리값 흉내(`'verified'`·`1`)를 참으로 받으면, 호출부가 잘못 넘긴 값이
 *   그대로 "확립했다" 가 된다 — 이 파일이 없애려는 사고가 정확히 그것이다.
 * ★ 인자 생략은 여덟 헬퍼에서 안전한 `unverified` 로 닫고, 기본이 `verified` 인 scope 만 거짓 성공을 막으려고 던진다(그 함수의 WHY).
 * ★ 봉투에 실릴 때 `success()` 가 `normalizeConfidence` 를 불러 `finalConfidence` 를 계산한다.
 *   세 값 밖으로 나가면 조용히 `unverified` 가 되므로, 그 사실에 기대지 않고 세 값만 낸다.
 *
 * 세 값의 뜻(WS0 §2.2, 그대로 인용):
 *
 * > **verified** — `content` 가 서술하는 사실을 **이 호출이 기계로 확립**했다.
 * > **unverified** — `content` 는 최선의 보고이지만 기계 증거가 없거나 부분적·오래된 것이다.
 * > **disputed** — 기계 증거나 정책이 성공을 **반박**한다. `status` 는 강제로 `failed`.
 */

/** `x` 가 정확히 불리언 참인가. 위 ★ 셋째 문단이 이 함수의 이유다. */
const yes = (x) => x === true;

/**
 * `orch_run` 의 confidence. WS0 §2.2 의 `orch_run` 행:
 *
 * > **verified** — 선택된 후보 `terminalClass === 'verified'`(신뢰 테스트 통과 + 반대 벤더 PASS)
 * > **unverified** — 테스트 미신뢰·없음·데드라인·워커 무변경·`dry_run`·`cancelled`
 * > **disputed** — verifier 2회 FAIL · 보안 하드 리스트 위반 · 테스트 정의 변조
 *
 * 우선순위는 `disputed` > `unverified` > `verified` 다. 앞의 둘이 함께 참인 봉투는 없어야
 * 하지만, 만약 생긴다면 **덜 주장하는 쪽**으로 접히는 것이 맞다 — 반박이 있는데 성공으로
 * 내보내는 것이 이 제품에서 가장 비싼 거짓말이고, `success()` 의 `finalConfidence` 가 `disputed` 이면
 * `status` 를 `failed` 로 강등한다(로드맵 §5.12).
 *
 * `unverified` 를 **명시로** 받는 이유: 데드라인·워커 무변경처럼 §2.2 가 이름으로 적어 둔
 * 강등 사유를 호출부가 그대로 부를 수 있어야 한다. `verified: false` 로도 같은 값이 나오지만,
 * 그 모양은 "verified 를 계산해 봤더니 아니었다" 로 읽혀 사유가 봉투에서 사라진다.
 *
 * @param {{verified?: boolean, disputed?: boolean, unverified?: boolean}} [summary]
 * @returns {'verified'|'unverified'|'disputed'}
 */
export function confidenceOfRun({ verified = false, disputed = false, unverified = false } = {}) {
  if (yes(disputed)) return 'disputed';
  if (yes(unverified)) return 'unverified';
  return yes(verified) ? 'verified' : 'unverified';
}

/**
 * `orch_models` 의 confidence. WS0 §2.2 의 `orch_models` 행:
 *
 * > **verified** — 이번 호출이 CLI 를 실제로 프로브 / **unverified** — 캐시만 읽음
 *
 * ★ `probed` 는 "`refresh: true` 를 받았나" 가 아니라 **이번 호출이 CLI 를 띄웠나** 다. 캐시가
 *   낡았으면(`POINT_OF_USE_MAX_AGE_MS`) `refresh` 없이도 프로브가 돈다 — 그때는 verified 다.
 *   반대로 벤더 하나라도 캐시로 답했으면 목록 전체가 이 호출이 확립한 사실이 아니다.
 *   캐시로 답한 호출은 `NOTICE_TEXT.models_from_cache` 를 함께 실어 다음 수(`refresh:true`)를
 *   알려 준다 — 값만 낮추고 이유를 안 적으면 호출자는 무엇을 해야 할지 모른다(WS2 §6).
 *
 * @param {{probed?: boolean}} [report]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfModels({ probed = false } = {}) {
  return yes(probed) ? 'verified' : 'unverified';
}

/**
 * `orch_status` 의 confidence. WS0 §2.2 의 `orch_status` 행:
 *
 * > **verified** — manifest 읽음 + 해시 일치 / **unverified** — 실행 중 · manifest 없음/불일치
 *
 * 그 행의 세 조각이 세 인자다. `manifestRead` 는 매니페스트가 정규화됐나, `refsIntact` 는 이
 * 재구성이 연 기록들이 **매니페스트가 적어 둔 다이제스트와 맞았나**(그것이 「해시 일치」다 —
 * `src/run-read.mjs` 가 attempt 마다 재는 그 대조), `finished` 는 그 실행이 끝났나다.
 *
 * ★ `finished` 가 조건인 이유: 아직 도는 실행의 매니페스트는 **읽히지만** 그 답은 스냅샷이다.
 *   행이 그것을 "실행 중" 이라고 이름으로 적어 두었다.
 * ★ 인자 없는 최근 목록은 매니페스트를 한 장도 열지 않으므로 언제나 `unverified` 다(빈 인자로
 *   부른다). 목록이 저널을 읽었는지는 본문의 `journal` 이 말한다 — 확신 한 값에 두 사실을
 *   접으면 어느 쪽이 낮췄는지 아무도 모른다.
 * ★ `disputed` 는 없다(WS0 §2.2 의 그 행에 칸이 비어 있다): 읽기 전용 회수 경로에는 성공을
 *   반박할 기계 증거를 만드는 자리가 없다.
 *
 * @param {{manifestRead?: boolean, refsIntact?: boolean, finished?: boolean}} [read]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfStatus({ manifestRead = false, refsIntact = false, finished = false } = {}) {
  return yes(manifestRead) && yes(refsIntact) && yes(finished) ? 'verified' : 'unverified';
}

/**
 * `orch_config` 의 confidence. WS0 §2.2 의 `orch_config` 행:
 *
 * > **verified** — 쓴 뒤 재읽기 일치 · 조회는 정본 파일 읽음 / **unverified** — 파일 읽기 실패·부분
 *
 * 두 갈래가 한 함수인 이유: 호출부에서 보면 같은 도구의 같은 봉투다. 쓰기 갈래는
 * `readBackMatches` 를 주고(그것이 답이다), 조회 갈래는 주지 않는다(`readable` 이 답이다).
 *
 * ★ 쓰기 갈래에서 `readable` 은 답이 아니다. 파일을 **읽을 수 있었다**는 것과 **쓴 값이
 *   그대로 남았다**는 것은 다른 사실이고, 봉투가 주장하는 것은 뒤엣것이다.
 *
 * @param {{readBackMatches?: boolean, readable?: boolean}} [result]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfConfig({ readBackMatches, readable = false } = {}) {
  if (readBackMatches !== undefined) return yes(readBackMatches) ? 'verified' : 'unverified';
  return yes(readable) ? 'verified' : 'unverified';
}

/**
 * `orch_stats` 의 confidence. WS0 §2.2 의 `orch_stats` 행:
 *
 * > **verified** — posteriors·journal·generations 모두 읽음 / **unverified** — 하나라도 `unreadable`
 *
 * `readable` 은 그 **셋의 논리곱**이다. 어느 것이 안 읽혔는지는 봉투의 본문과 notice 가 적고,
 * 이 자리는 "다 읽었나" 하나만 본다 — 부분만 읽고 verified 를 내는 자리가 생기지 않게.
 *
 * @param {{readable?: boolean}} [state]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfStats({ readable = false } = {}) {
  return yes(readable) ? 'verified' : 'unverified';
}

/**
 * `orch_reward` 의 confidence. WS0 §2.2 의 `orch_reward` 행:
 *
 * > **verified** — posterior·journal 갱신 후 재읽기 일치 / **unverified** — pre-WAL 실패 뒤 fallback 행
 *
 * ★ "커밋이 ok 였다" 는 재읽기가 아니다. WAL 이 끝났다는 말이지 저널 줄이 그 값으로 보인다는
 *   말이 아니므로, 호출부는 정말로 다시 읽고 비교한 결과를 넘겨야 한다(`src/tools.mjs`).
 *
 * @param {{readBackMatches?: boolean}} [result]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfReward({ readBackMatches = false } = {}) {
  return yes(readBackMatches) ? 'verified' : 'unverified';
}

/**
 * `orch_reset`(오늘은 `orch_stats({reset:true})`) 의 confidence. WS0 §2.2 의 `orch_reset` 행:
 *
 * > **verified** — 지운 수를 셌고 스냅샷을 남김 / **unverified** — posteriors `unreadable`(몇 개였는지 못 셈)
 *
 * 세 인자가 그 행의 조각들이다: `counted` 는 "지운 수를 셌다"(하나도 못 지운 셀이 있으면 거짓),
 * `readable` 은 "사후분포를 읽고 지웠다"(읽지도 못한 채 버렸으면 거짓), `snapshotWritten` 은
 * "스냅샷을 남겼다" — WS2 Task 7 수정 M3: 이전 판은 「스냅샷을 남김」을 이 JSDoc 에 인용만 하고
 * 재지는 않아서, 지운 것이 있는데 스냅샷을 못 남긴 호출도 `counted && readable` 만으로
 * verified 였다.
 *
 * ★ `cleared === 0` 이면 `snapshotWritten` 을 안 본다 — 지운 것이 없는 호출(무연산)은 남길
 *   스냅샷도 없는 것이 맞고, 그때 값이 `false`(기본값)라고 낮추면 무연산까지 unverified 가
 *   된다. `resetPosteriors` 자신도 지울 것이 없으면 스냅샷을 안 쓴다(`cleared:0` 이면 디스크에
 *   손대지 않는다) — 이 조건은 그 사실을 그대로 옮긴 것이다.
 *
 * @param {{counted?: boolean, readable?: boolean, cleared?: number, snapshotWritten?: boolean}} [result]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfReset({ counted = false, readable = false, cleared = 0, snapshotWritten = false } = {}) {
  return yes(counted) && yes(readable) && (cleared === 0 || yes(snapshotWritten)) ? 'verified' : 'unverified';
}

/**
 * `orch_apply` 의 confidence. WS0 §2.2 · `contract/envelope.json` 의 `confidenceByTool.orch_apply`:
 *
 * > **verified** — 적용 뒤 확인이 통과 / **unverified** — `check_only`
 *
 * 두 인자가 그 두 행이다. `applied` 는 저장소가 실제로 바뀌었나(`check_only` 면 거짓이다),
 * `verified` 는 **사후 확인이 통과했나** — 갈래마다 다른 검사이고(직접은 역방향 `--check`,
 * 3-way 는 예상 트리 대조) 어느 쪽이 돌았는지는 본문의 `verifiedBy` 가 이름으로 말한다.
 *
 * ★ 왜 둘 다 필요한가: 「적용했다」와 「그것이 기록대로 들어갔다」는 다른 사실이다. 적용은 했는데
 *   확인이 안 된 봉투는 성공이 아니라 `apply_verification_failed` 라 여기 오지 않지만, 그때
 *   `applied` 하나로 verified 를 내는 모양을 남겨 두면 다음 갈래가 그 구멍으로 들어온다.
 * ★ `disputed` 는 이 함수에 없다. 계약의 그 행(「scope 미허용 flagged」)은 범위 축이고, 그것은
 *   아래 `confidenceOfScope` 가 낸다 — WS5 태스크 9 가 그 둘을 접는다.
 *
 * @param {{applied?: boolean, verified?: boolean}} [result]
 * @returns {'verified'|'unverified'}
 */
export function confidenceOfApply({ applied = false, verified = false } = {}) {
  return yes(applied) && yes(verified) ? 'verified' : 'unverified';
}

/**
 * 패치 범위 검사의 confidence. WS0 §2.2 의 `orch_apply` 행이 적은 축이다:
 *
 * > **disputed** — scope 미허용 flagged(→ 거부)
 *
 * `inspectPatch` 가 `confidenceOfScope({ flagged })` 의 유일한 생산자다. 승인된 플래그는
 * `confidence`·`recovery` 둘 다 생략하고, 미승인 scope 만 `disputed`와 회복 문장을 낸다.
 * 그 `disputed` 는 `orch_apply` 의 scope 실패 관문이 소비한다. 이 축은 신뢰도를 낮추기만 한다.
 *
 * ★ `hardViolation` 파라미터는 없앴다(WS2 Task 7 수정 M4). WS5 가 하드 축을
 *   `inspectPatch` 결과에 되살렸지만, 이 함수의 질문은 그대로 "미승인 범위가 있나" 하나다.
 *   하드인지는 scope 본문과 `orch_apply` 거부 관문이 소유하고, 여기서 둘째 인자를 받으면 같은
 *   축의 정본이 둘로 갈린다. 승인된 플래그에서는 이 함수를 부르지 않는다. 그 구분은 호출 흐름이
 *   소유한다. 이 함수는 승인 여부나 `recovery` 를 입력으로 받지 않는다.
 *   따라서 시그니처는 `{flagged}` 하나이고 생산자도 `inspectPatch` 하나다.
 *
 * ★ 인자 없이 부르면 `TypeError` 다 — 기본값이 `verified` 인 유일한 헬퍼라, 조용한 기본값은
 *   「범위 위반 없음」이라는 거짓 주장이 된다. 나머지 여덟은 안전한 쪽(`unverified`)이 기본값이다.
 *
 * @param {{flagged?: boolean}} scope
 * @returns {'verified'|'disputed'}
 */
export function confidenceOfScope({ flagged = false }) {
  return yes(flagged) ? 'disputed' : 'verified';
}
