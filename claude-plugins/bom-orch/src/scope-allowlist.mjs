/**
 * 허용목록 매처 — 호출 인자 `scope_allow` 와 프로젝트 설정 `scope.allow` 의 **합집합**, 그리고
 * 그 글롭 하나가 경로 하나를 덮는가 (WS5 스펙 §0 D1a, 태스크 2).
 *
 * ## 이 파일이 하지 **않는** 것
 *
 * 여기에는 정책이 없다. 「무엇이 지워질 수 있나」는 등급이 정하고(`src/patch-scope.mjs` 의
 * `tier`·`promotable`, 스펙 §0 D1/D1a), 「허용목록이 이름 부를 수 없는 경로」는 테스트 명령
 * 설정의 정본이 정한다(`src/test-discovery.mjs`, D3). 이 파일은 그 두 판정을 **읽기만** 한다 —
 * 그래서 상대 import 가 **0** 이고, 그 0 이 이 잎의 정의다: 매처가 표지 목록을 알게 되는 순간
 * 배분이 두 곳에서 정해지고, 그것이 이 WS 가 태스크 1·3 에서 두 번 막은 실패다.
 *
 * ## 글롭 방언 — 새로 짓지 않는다
 *
 * 이 저장소에는 이미 경로를 보는 어휘가 있다(`patch-scope.mjs` 의 `segmentsOf`·대소문자 접기,
 * `test-discovery.mjs` 의 `foldPath`). 그 경로 조각 규율을 이어 쓰되, 아래 항목 정규화는 별도다:
 *
 *   구분자    `/` 하나. 빈 조각과 `.` 은 걷고 세그먼트로 본다(부분 문자열 금지 — 계획 1 의 오탐이 출처다).
 *   대소문자  접는다. 표지가 접으므로 여기서 안 접으면 `.CLAUDE/**` 가 플래그된 `.claude/x` 를
 *             못 덮는다 — 같은 경로를 한쪽은 걸고 한쪽은 못 지우는 것이 가장 나쁜 조합이다.
 *   `*`       세그먼트 **안**에서만 아무거나(`/` 를 넘지 않는다).
 *   `**`      세그먼트를 **0개 이상** 먹는다. 그래서 `.claude/**` 는 `.claude/x/y` 도, `.claude`
 *             자신도 덮는다 — 스키마의 예시가 그 철자다(`contract/project-config.schema.json`).
 *   그 밖     전부 리터럴이다. `?`·`[...]` 는 **와일드카드가 아니다** — POSIX 글롭의 나머지를
 *             들이면 방언이 하나 더 생기고, 계약이 약속한 것은 「POSIX 스타일, `**` 허용」뿐이다.
 *
 * ★★ 양쪽이 **닫혀 있다**(two-sided). 패턴은 경로 **전체**와 맞아야 한다 — 접두사도 부분 문자열도
 *   아니다. `docs` 는 `docsite/a.md` 를 안 덮고 `.claude` 는 `.claude/settings.json` 을 안 덮는다
 *   (덮으려면 `.claude/**`). 열린 쪽을 하나라도 두면 허용목록이 자기가 적은 것보다 넓어지고,
 *   이 축에서 넓어진다는 것은 **사람이 안 본 변경이 통과한다**는 뜻이다.
 *
 * ★ 항목의 역슬래시는 접고(`\` -> `/`) **경로의 역슬래시는 안 접는다.** 항목은 사람이 쓴 것이라
 *   `.claude\**` 가 같은 경로의 다른 철자이지만, 경로는 git 이 낸 것이라 역슬래시가 든 이름은
 *   POSIX 의 정당한 파일 이름 하나다(`patch-scope.mjs` 의 `segmentsOf` 머리말이 그 실측이다).
 *   접기를 양쪽에 걸면 `a\b` 라는 이름의 파일이 `a/b` 를 뜻한 항목에 덮인다 — 이 축에서 과잉
 *   일치는 「지워지면 안 되는 것이 지워진다」이므로 닫는 쪽으로 둔다.
 *
 * ★ 실측 폐포: **1개 모듈 / 203줄**(자기 자신뿐). 상대 import 0.
 */

/**
 * 합집합이 실제로 쓰는 항목 수와 항목 하나의 길이. 정본은 계약이다 —
 * `contract/project-config.schema.json` 의 `scope.allow` 가 `maxItems: 32`·`maxLength: 256` 을
 * 이미 검증하고(설정 쪽은 `src/project-config.mjs` 가 그 스키마로 거부한다), 호출 인자 쪽은
 * `validateArgs` 에 개수·길이 축이 없어 여기가 유일한 자리다.
 *
 * ★ 넘치면 **조용히 자르지 않는다** — 버린 개수를 `ignored` 로 내고 엔진이 알림으로 말한다
 *   (`MAX_INSPECTED_ARTIFACT_REFS` 가 이미 쓰는 규율이다). 거부가 아니라 무시인 이유는 두 축이
 *   비대칭이기 때문이다: 못 쓴 항목은 아무것도 지우지 못하므로 **닫는 쪽**으로 실패한다.
 */
export const MAX_ALLOW_ENTRIES = 32;
export const MAX_ALLOW_ENTRY_CHARS = 256;

/**
 * 항목 하나를 비교용 철자로 접는다. 못 쓰는 항목은 빈 문자열이다(던지지 않는다).
 *
 * 앞의 `./` 와 뒤의 `/` 를 걷는 것은 `patch-scope.mjs` 의 `rejectTestCommandConfigAllow` 와
 * 공유한다. 이 매처는 길이 상한·소문자 접기·`.` 조각 제거를 더한다 — 저쪽은 거절 진단용 철자, 여기는 실제 글롭 비교 철자를 만든다.
 */
export function normalizeAllowEntry(value) {
  if (typeof value !== 'string' || value.length > MAX_ALLOW_ENTRY_CHARS) return '';
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

/** 접은 경로를 세그먼트로. 빈 조각과 `.` 은 경로가 아니다. */
const segmentsOf = (value) => value.split('/').filter((segment) => segment !== '' && segment !== '.');

/**
 * 와일드카드 매칭 **한 벌**. 이 파일의 두 층은 같은 문제라 같은 걸음으로 푼다: 세그먼트 목록 위의
 * `**`(세그먼트 0개 이상)와 세그먼트 **안**의 `*`(글자 0개 이상). 왼쪽부터 조각 하나씩 「여기까지
 * 맞출 수 있나」를 한 줄씩 밀고, 마지막 칸이 답이다. `parts`·`targets` 는 `length` 와 `[i]` 만
 * 쓰므로 세그먼트 배열도 글자 문자열도 그대로 들어온다 — 철자가 하나면 두 층이 갈리지 않는다.
 *
 * ★★ **사용자 문자열로 정규식을 짓지 않는다.** 예전 판은 세그먼트 안 매칭만 정규식으로 지었고
 *   (`pattern.split('*').join('[^/]*')`), 인접·반복된 `*` 가 중첩 수량자 열이 되어 **실패하는**
 *   매칭에서 파국적 백트래킹을 했다. 이 기계 실측(WS5 T2 리뷰 C1): `********z` × `a`×80 이
 *   227,520 ms, `*a*a*a*a*a*a*a*ab` × `a`×120 이 285,635 ms. Node 는 단일 스레드이고 정규식은
 *   중단 불가라, 그 몇 분 동안 마감 타이머·취소·SIGTERM 정산·다른 실행이 **전부 함께** 얼어붙는다.
 *   도달에 필요한 것은 평범하다: 세그먼트 안 `*` 가 여럿인 허용목록 항목 하나(호출 인자
 *   `scope_allow` 또는 프로젝트 설정)와, 델리게이트가 자유롭게 짓는 긴 파일 이름 하나.
 *   이 DP 에는 되돌아가는 길이 없다 — 비용의 상계가 `parts.length × targets.length` 이고,
 *   그 둘은 각각 항목 길이(`MAX_ALLOW_ENTRY_CHARS`, 256)와 경로 길이다. 보안 판정이 아니라
 *   **가용성** 판정이었다: 옛 판은 아무것도 안 지웠지만 서버 하나를 인자 한 개로 세웠다.
 * ★ 한 줄이 통째로 거짓이면 그 자리에서 끝낸다. 뒤 조각이 무엇이든 답은 이미 거짓이고, 이 한 줄이
 *   「별표만 잔뜩인 패턴」을 첫 리터럴에서 끊는다.
 */
function wildcardCovers(parts, targets, wildcard, unitMatches) {
  let reach = new Array(targets.length + 1).fill(false);
  reach[0] = true;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = new Array(targets.length + 1).fill(false);
    let any = false;
    if (part === wildcard) {
      let seen = false;
      for (let at = 0; at <= targets.length; at += 1) {
        seen = seen || reach[at];
        next[at] = seen;
      }
      any = seen;
    } else {
      for (let at = 1; at <= targets.length; at += 1) {
        next[at] = reach[at - 1] && unitMatches(part, targets[at - 1]);
        any = any || next[at];
      }
    }
    if (!any) return false;
    reach = next;
  }
  return reach[targets.length];
}

/**
 * 글자 하나의 동일성 — `*` 층의 `unitMatches`. 세그먼트 안에는 `/` 가 없으므로 옛 정규식의
 * `[^/]` 와 같은 집합이고, UTF-16 코드 단위로 읽는 것도 같다(의미론은 한 바이트도 안 바뀐다).
 */
const sameUnit = (pattern, value) => pattern === value;

/** 세그먼트 하나의 `*` 매칭. `**` 는 여기 오지 않는다(위 갈래가 먼저 잡는다). */
function segmentMatches(pattern, value) {
  if (!pattern.includes('*')) return pattern === value;
  return wildcardCovers(pattern, value, '*', sameUnit);
}

/**
 * 글롭 하나가 세그먼트 목록을 덮는가. `**` 가 세그먼트 0개 이상을 먹는 층이고, 조각 하나의
 * 판정은 `segmentMatches` 가 한다 — 즉 같은 DP 가 두 번, 바깥은 세그먼트로 안쪽은 글자로 돈다.
 *
 * ★ 아무것도 캐시하지 않는다. 호출 상계는 사유 `MAX_REASONS`(100) × 항목 `MAX_ALLOW_ENTRIES`(32)
 *   이고 **호출 하나의 상계는 위 DP 가 정한다**(패턴 길이 × 경로 길이). 캐시를 두면 사용자가 쓴
 *   문자열이 그것을 준 실행보다 오래 사는 서버 전역 표가 된다 — 값도 없다, 한 번이 이미 싸다.
 */
function globCovers(pattern, target) {
  const parts = segmentsOf(pattern);
  if (parts.length === 0) return false; // 빈 글롭은 아무것도 안 덮는다 — `**` 를 적어야 전부다
  return wildcardCovers(parts, target, '**', segmentMatches);
}

/**
 * 호출 인자와 프로젝트 설정의 **합집합**(WS0 §1.2 의 행: 「프로젝트 설정 `scope.allow` 와 합집합」).
 *
 * @param {...unknown} sources 문자열 배열들. 배열이 아니거나 원소가 문자열이 아니면 **던지지 않고**
 *   그 항목만 버린다(모양 검증은 스키마와 `validateArgs` 의 축이다).
 * @returns {{entries: {entry: string, path: string}[], ignored: number}}
 *   `entry` 는 사용자가 쓴 원문(알림이 그대로 인용한다) · `path` 는 접은 철자(매처가 읽는다).
 *   `{entry, path}` 는 `rejectTestCommandConfigAllow` 가 이미 쓰는 모양이다 — 같은 사실의 두 면이
 *   다른 모양으로 다니면 부르는 쪽이 매번 옮겨 적는다.
 *
 * ★ 중복은 `ignored` 가 아니다. 두 원천이 같은 글롭을 적는 것은 손실이 아니라 합집합의 정의다.
 */
export function unionScopeAllow(...sources) {
  const seen = new Set();
  const entries = [];
  let ignored = 0;
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      const path = normalizeAllowEntry(entry);
      if (path === '') { ignored += 1; continue; }
      if (seen.has(path)) continue;
      if (entries.length >= MAX_ALLOW_ENTRIES) { ignored += 1; continue; }
      seen.add(path);
      entries.push(Object.freeze({ entry, path }));
    }
  }
  return Object.freeze({ entries: Object.freeze(entries), ignored });
}

/**
 * 허용목록의 어느 항목이든 이 경로를 덮는가. 순수·무throw.
 *
 * ★ 항목은 `unionScopeAllow().entries` 의 `{entry, path}` 행이지만 **날 문자열도 받는다** — 그때는
 *   여기서 접는다. 한쪽 모양만 받고 다른 쪽을 조용히 「아무것도 안 덮는다」로 답하면, 잘못 부른
 *   호출부는 붉어지는 자리 없이 허용목록이 통째로 죽은 채로 돈다.
 */
export function allowlistCovers(entries, path) {
  if (!Array.isArray(entries) || typeof path !== 'string' || path === '') return false;
  const target = segmentsOf(path.toLowerCase());
  if (target.length === 0) return false;
  return entries.some((one) => {
    const pattern = typeof one === 'string' ? normalizeAllowEntry(one) : (typeof one?.path === 'string' ? one.path : '');
    return pattern !== '' && globCovers(pattern, target);
  });
}

/**
 * 사유 하나의 **허용목록 판정** — 태스크 4 의 컷이 다시 유도하지 않고 읽는 자리다.
 *
 * 두 조건의 곱이다:
 *   (1) 등급이 지우는 것을 허락하는가 — `allowable`(lockfile 열, 기본 허용 후보) 또는
 *       **승격 가능한 하드**(D1a: 편집기·에이전트 설정). 승격 불가 하드 코어는 여기서 언제나
 *       거짓이고, 그것이 「어떤 허용목록으로도 통과 불가」의 기계적 뜻이다.
 *   (2) 허용목록이 그 경로를 덮는가.
 *
 * ★ `promotable` 을 사유에 싣는 쪽이 `src/patch-scope.mjs` 다(스펙 §0 D1a의 배치가 거기 산다).
 *   이 함수는 그 값을 **읽기만** 한다 — 없으면 거짓이고, 그 부재는 **닫는 쪽**이다: 축을 아무도
 *   말하지 않은 표지는 지워지지 않는 채로 남는다.
 */
export function allowlistVerdict(reason, entries) {
  if (reason === null || typeof reason !== 'object') return false;
  const waivable = reason.tier === 'allowable' || reason.promotable === true;
  return waivable && allowlistCovers(entries, reason.path);
}
