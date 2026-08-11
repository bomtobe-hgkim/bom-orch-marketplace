import { realpath as realpathCallback } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * 경로 동일성 판정의 **유일한 좌표계**.
 *
 * 이 저장소는 같은 결함을 세 번 냈다 — 경로를 문자열로 비교했고, 그 비교의 결과가
 * 되돌릴 수 없는 삭제였다. 판정에 들어가는 경로는 전부 이 함수를 지난 값이어야 한다.
 * 두 모듈이 각자 자기 규칙으로 펴면 그 차이가 곧 다음 결함이므로 여기 한 곳에 둔다
 * (`src/worktree.mjs` 와 `src/reaper.mjs` 가 이 함수를 공유한다).
 */

/** `fs.realpath.native` 의 프로미스 판. OS 에게 직접 묻는 경로다. */
const realpathNative = promisify(realpathCallback.native);

/**
 * 경로를 **실체 경로**로 편다. 못 펴면 `null`(= 모른다 → 호출부가 fail-closed).
 *
 * 왜 필요한가 (실측 git 2.55.0.windows.3): `git worktree add` 는 우리가 준 문자열이
 * 아니라 **정규화한 경로**를 등록한다. 두 축이 실제로 관측됐다.
 *
 *     [정션] 요청 …/link/worktrees/run1     등록 …/real/worktrees/run1
 *     [8.3 ] 요청 …/VERYLO~1/worktrees/run1 등록 …/VeryLongStateRootName/worktrees/run1
 *
 * 그래서 등록 목록과 우리 경로를 문자열로 비교하면 **영영 같아지지 않는다.** 워크트리
 * 판정(우리 것인가 / 살아 있는 남의 것인가 / 상태 루트 안인가)이 전부 경로 동일성에
 * 걸려 있으므로, 비교에 들어가는 모든 경로를 여기서 같은 좌표계로 옮긴 뒤 쓴다.
 *
 * 아직 없는 경로도 다뤄야 한다(워크트리를 만들기 **전에** 판정한다). 존재하는 최상위
 * 조상까지 편 뒤 나머지 조각을 다시 붙인다 — 실측으로 `realpath.native` 는 정션도
 * 8.3 조각도 접는다.
 *
 * ENOENT 가 아닌 실패(권한·I/O)는 **모르는 것**이므로 `null` 이다. 되돌릴 수 없는
 * 삭제 앞에서 "우리 것임을 증명하지 못하면 손대지 않는다" 가 기본값이다.
 */
export async function canonical(input) {
  if (typeof input !== 'string' || input === '') return null;
  let current = resolve(input);
  const tail = [];
  for (;;) {
    try {
      const real = await realpathNative(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = dirname(current);
      // 루트까지 갔는데도 못 폈다 — 드라이브 자체가 없다.
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}
