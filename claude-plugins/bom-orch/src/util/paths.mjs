import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

/**
 * 경로 비교 — 저장소 전체에서 하나.
 *
 * 사본 셋(`reaper.sameCanonicalPath`·`run-artifacts.samePath`·
 * `run-artifacts.ownerSamePath`)은 비교 규칙이 같고 **플랫폼을 어디서 읽는지만**
 * 달랐다: import 시점의 모듈 상수, 호출 시점의 `process.platform`, 주입받은 인자.
 * 통합본은 셋째 모양을 고른다 — 그래야 어느 OS 에서도 양쪽 분기를 테스트할 수 있고,
 * 이미 플랫폼을 주입받아 쓰던 소유권 검사(run-artifacts:373)가 그대로 살아난다.
 *
 * ★ 구분자는 정규화하지 않는다. 세 사본 전부 소문자 비교만 했고, `C:/a` 를 `C:\a`
 *   와 같다고 보는 순간 `samePath(resolve(p), p)` 꼴의 **정규성 게이트**가 넓어진다
 *   (run-artifacts:2956, reaper:1422). 그건 동작 변경이라 이 티어의 범위 밖이다.
 */
export function samePath(a, b, platform = process.platform) {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * `path` 가 `root` **밑**인가 — 저장소 전체에서 하나.
 *
 * 사본 넷(`engine.pathContains`·`reaper.isUnder`·`reaper.isSafeWorktree` 안쪽 검사·
 * `run-artifacts.contained`)이 두 축에서 갈렸고, 통합본은 이렇게 정한다:
 *
 *   같은 경로(`root` 자신)  →  **거짓**. 넷 중 셋의 답이자 가장 엄격한 답이다.
 *                              담긴 것만 지우고 담긴 것만 상대 경로로 적는다.
 *                              엔진만 참으로 봤고, 그 자리는 바깥으로 나가는 이유
 *                              코드(`artifact_root_overlaps_project`)라 자기 파일에서
 *                              같음 검사를 더해 그대로 지킨다.
 *   `root/..name`           →  **참**. `..name` 은 `..` 로 시작할 뿐인 평범한 이름이다.
 *
 * ★ 리퍼 두 사본은 `startsWith('..')` 로 판정해 `..name` 을 "빠져나간다" 로 읽었다.
 *   빠져나가는 것은 `..` **다음에 구분자가 오는 경우**뿐이고, `rel` 이 정확히 `..`
 *   인 경우다. 그 오판 때문에 리퍼가 자기가 만든 워크트리를 못 지웠다 — 실제
 *   파일시스템 재현은 `test/reaper.test.mjs` 에 있다.
 *
 * ★ 접두사 비교는 안 된다. `/rx` 는 `/r` 로 시작하지만 `/r` 밑이 아니다. 판정은
 *   `relative` 가 내는 **세그먼트 단위** 결과로 한다.
 *
 * ★ win32 의 대소문자 무시와 구분자 정규화는 우리가 새로 넣는 것이 아니라
 *   `path.win32.relative` 가 원래 하던 일이다 — 사본 넷 전부 플랫폼 기본 `relative`
 *   를 썼으므로 Windows 에서의 답은 그대로다. 플랫폼 인자는 그 답을 어느 OS 에서도
 *   테스트할 수 있게 하려는 것이고, 기본값을 쓰면 오늘의 동작과 한 글자도 다르지 않다.
 *   (`samePath` 가 구분자를 정규화하지 않는 것과 모순이 아니다: 그쪽은 **같음**을 묻는
 *   정규성 게이트고, 이쪽은 **포함**을 묻는다.)
 *
 * ★ 옛 `isUnder` 에서 물려받은 전제: 두 인자는 **이미 절대/실체 경로로 편 값**이어야
 *   한다. 상대 경로나 빈 문자열을 넣으면 `path.relative` 가 그것을 **cwd 기준으로**
 *   풀어버려 답이 무의미해진다 — 호출자의 cwd 가 우연히 맞아떨어지면 `true` 가 나올
 *   수도 있다. 그래서 절대 경로가 아닌 입력은 좌표계를 확인할 수 없다는 뜻으로 곧장
 *   `false` 를 낸다. 리퍼 호출부에서 `false` 는 "지우지 마라" 다 — 안전한 쪽으로
 *   fail-closed 한다.
 */
export function contained(root, path, platform = process.platform) {
  const api = platform === 'win32' ? pathWin32 : pathPosix;
  if (!api.isAbsolute(root) || !api.isAbsolute(path)) return false;
  const rel = api.relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}
