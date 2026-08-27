import { isAbsolute, resolve } from 'node:path';
import { canonical } from './real-path.mjs';
// ★ `contained` 에 넣는 두 경로는 **이미 같은 좌표계로 편 값**이어야 한다(사라진
//   `isUnder` 가 지고 있던 계약이다). 링크·8.3 표기를 섞으면 거짓을 내고, 거짓은
//   이 술어에서 "지우지 않는다" 로 읽힌다 — 펴는 일은 `canonical` 이 한다.
import { contained } from './util/paths.mjs';

/**
 * 워크트리 경로의 **순수 술어 둘**. 잎 모듈이다 — 이 파일은 저장소의 다른 모듈을 하나도
 * 수입하지 않는다(`real-path` 와 `util/paths` 는 그 자신이 잎이다).
 *
 * ★ 왜 따로 있는가 (WS4a P2): 두 술어는 `src/reaper.mjs` 에 살았고 `src/worktree.mjs` 가
 *   거기서 수입했다. 그 방향 때문에 리퍼는 `worktree.removeWorktree` 를 부를 수 없었다 —
 *   부르는 순간 `reaper → worktree → reaper` 가 닫힌다. 그래서 부팅 스윕은 진짜 API 대신
 *   맨 `rm` 을 걸었고, 넘겨받은 워크트리의 **git 등록**이 영원히 남았다. 순수 경로 술어의
 *   제자리는 어차피 잎이다. 이 파일이 저장소 모듈을 수입하기 시작하면 그 순환이 되돌아온다.
 */

/**
 * 이 경로를 지워도 되는가. **표기만 비교하는 순수 함수다.**
 *
 * ★ 두 인자는 **이미 같은 좌표계로 편 값**이어야 한다. 링크·8.3 표기를 섞어서
 *   넣으면 거짓을 낸다. 편지 않은 값에서 출발한다면 아래 `resolveSafeWorktree` 를
 *   써라 — 그쪽이 두 인자를 먼저 눕힌다.
 *
 * ★ 문자열이 비었는지만 보던 시절에, 기록의 worktree 가 상태 루트를 가리키면
 *   `rm -rf` 가 상태 루트를 통째로 날렸다(리뷰어 실증: 다른 세션의 카탈로그와
 *   워크트리까지 전부 사라졌다). 이 모듈이 막으려는 "남의 프로세스를 죽인다"보다
 *   더 나쁜 결과다.
 *
 * 워크트리는 설계상 `<stateRoot>/worktrees/<runId>` 아래에만 만들어진다(§5.2).
 * 그 밖의 경로는 우리가 만든 것이 아니므로 지우지 않는다. 절대 경로여야 하고,
 * worktrees 디렉터리 자신이어서도 안 되며, `..` 로 빠져나가서도 안 된다.
 *
 * ★ 담김 판정은 공유 `contained` 다. 이전의 손수 쓴 술어는 `rel.startsWith('..')` 라
 *   `..leftover` 처럼 **점 둘로 시작하는 평범한 이름**의 워크트리를 "바깥" 으로 읽어
 *   rm 을 건너뛰었다. 그 결과 남는 것은 사용자 저장소의 완전한 사본이다. 빠져나가는
 *   경로는 `..` 다음에 구분자가 오는 경우와 `rel` 이 정확히 `..` 인 경우뿐이다.
 *
 * ★ 이 함수를 부르는 것은 이 파일만이 아니다. `src/worktree.mjs` 가 **일곱 곳**에서
 *   부른다: `:877`(createBody 의 경로 확인) · `:961`(원본 워크트리) · `:998`(요청 경로) ·
 *   `:1058` · `:1532`(`discard` 의 `rm(worktreePath, {recursive:true, force:true})` 게이트) ·
 *   `:1740` · **`:1900`(공개 `removeWorktree`)**.
 *
 *   앞의 여섯에서 위 `..name` 폭 넓힘이 공개 API 에 닿지 않는 이유는 id 문법이다: 그쪽이
 *   받는 워크트리 id 는 `worktree.mjs` 의 `RUN_ID_PATTERN`(`^[a-z0-9][a-z0-9_-]{0,63}$`)을
 *   먼저 지나고, 이 패턴은 첫 글자를 `[a-z0-9]` 로만 허용해 `..` 로 시작하는 id 를 애초에
 *   낼 수 없다. `test/worktree.test.mjs` 의 `makeWorktreeId` 테스트가 그 경계를 고정한다.
 *
 *   ★ **`:1900` 에서는 그 논증이 성립하지 않는다.** `removeWorktree(wt)` 의 `wt.path` 는
 *     호출자가 준 핸들에서 글자 그대로 오고, `checkHandle`(worktree.mjs ~:1912)은
 *     path·projectPath·stateRoot 가 빈 문자열이 아닌지만 본다 — 그 경로에 RUN_ID_PATTERN
 *     은 어디에도 적용되지 않는다. 거기서 실제로 성립하는 경계는 **`contained()` 하나**다:
 *     양쪽을 `canonical` 로 편 뒤 정규 경로가 `<stateRoot>/worktrees` 밑에 **엄격히**
 *     들어 있어야 하고(디렉터리 자신은 거짓), `..` 세그먼트로 빠져나가면 거짓이다.
 *     그래서 `<stateRoot>/worktrees/..leftover` 는 지워지고
 *     `<stateRoot>/worktrees/../escape` 는 거부된다 — 그 두 경계를 진짜 파일시스템으로
 *     `test/worktree.test.mjs` 가 못박는다. 되돌릴 수 없는 삭제를 넓히는 논증이므로,
 *     그 사정거리는 id 문법이 아니라 담김 판정으로 읽어야 한다.
 */
export function isSafeWorktree(stateRoot, worktree) {
  if (typeof stateRoot !== 'string' || stateRoot === '') return false;
  if (typeof worktree !== 'string' || worktree === '') return false;
  if (!isAbsolute(worktree)) return false;

  // base 자신은 거짓이고, 바깥(`..` 로 나가는 경로·다른 볼륨)도 거짓이다.
  return contained(resolve(stateRoot, 'worktrees'), resolve(worktree));
}

/**
 * 두 경로를 같은 좌표계로 눕힌 뒤 `isSafeWorktree` 를 묻는다. 통과하면 **편 워크트리
 * 경로**, 아니면 `null`.
 *
 * ★ 왜 필요한가 (실측): 원장에 실리는 워크트리 경로는 `createWorktree` 가 실체 경로로
 *   편 값인데, 리퍼는 `src/state-root.mjs` 가 낸 값 — 사용자가 `BOM_ORCH_HOME` 에 적은
 *   문자열 그대로 — 으로 스윕한다. 상태 루트가 정션이나 8.3 단축 이름을 경유하면 두
 *   표기가 영영 같아지지 않아 `isSafeWorktree` 가 거짓을 냈고, 스윕이 프로세스만 죽이고
 *   `rm` 을 건너뛰었다. 남는 것은 사용자 저장소의 완전한 사본(이식된 미커밋 내용 포함)
 *   이다. 재현:
 *
 *     같은 표기      -> true
 *     정션 vs 실경로 -> false   ← rm 을 건너뛰었다
 *     8.3 vs 긴 이름 -> false   ← 같음
 *
 *   펴는 규칙은 `src/worktree.mjs` 와 **같은 함수**(`src/real-path.mjs` 의 `canonical`)
 *   를 쓴다. 두 곳이 다르면 그 차이가 다음 결함이 된다.
 *
 * 못 펴면(권한·I/O) `null` 이다 — 모르는 경로는 지우지 않는다.
 */
export async function resolveSafeWorktree(stateRoot, worktree) {
  if (typeof worktree !== 'string' || worktree === '' || !isAbsolute(worktree)) return null;
  const [realRoot, realWorktree] = await Promise.all([canonical(stateRoot), canonical(worktree)]);
  if (realRoot === null || realWorktree === null) return null;
  return isSafeWorktree(realRoot, realWorktree) ? realWorktree : null;
}
