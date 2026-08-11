import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * 상태(설정·학습 사후분포·원장·워크트리)를 쓸 디렉터리.
 *
 * 우선순위: BOM_ORCH_HOME(절대 경로일 때만) > ~/.bom-orch
 *
 * ★ 호스트가 주입하는 **플러그인 데이터 디렉터리** 변수를 의도적으로 쓰지 않는다.
 *   그것을 쓰면 Claude Code 와 Codex 가 서로 다른 디렉터리를 보게 되어 이 시스템의
 *   존재 이유인 **누적 학습이 호스트별로 갈라진다**. 뇌는 하나여야 한다.
 *
 * ★ 호스트의 **플러그인 설치 루트** 변수도 쓰지 않는다. 플러그인 캐시는
 *   <marketplace>/<plugin>/<version>/ 이라 버전 bump 마다 경로가 이동하고, 거기 쓴
 *   상태는 다음 업데이트가 파괴한다.
 *
 *   (두 변수의 정확한 이름은 설계 문서 §11.3 에 있다. 여기 글자 그대로 적지 않는
 *   이유는 test/guards/state-root.test.mjs 가 src/ 전체에서 그 이름의 등장을
 *   금지하기 때문이다 — 주석과 실제 읽기를 구분하려면 토크나이저가 필요한데, 그건
 *   실수 방지용 가드에 과하다.)
 *
 * 상대 경로는 기본값으로 무시한다: 이 프로세스는 MCP stdio 서버라 cwd 가 호스트에게서
 * 물려받은 값이고 고정되어 있지 않다(Codex 는 자신의 cwd 를 그대로 넘긴다). 상대 값을
 * cwd 기준으로 풀면 실행마다 다른 디렉터리에 상태가 흩어지고, 사용자의 프로젝트나 git
 * 저장소 안에 쓰일 수도 있다. 잘못 설정된 상대 값은 조용히 흩뿌리는 것보다 무시하는
 * 편이 낫다 — "고쳐서" cwd 기준으로 되돌리지 말 것.
 */
export function resolveStateRoot(env = process.env) {
  const injected = env.BOM_ORCH_HOME;
  if (typeof injected === 'string' && injected.trim() !== '' && isAbsolute(injected)) {
    return injected;
  }
  return join(homedir(), '.bom-orch');
}
