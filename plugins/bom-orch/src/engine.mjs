import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readSettings as defaultReadSettings, resolveTier } from './config.mjs';
import { timeoutSignal } from './deadline.mjs';
import { failure, MAX_CONTENT_CHARS, success } from './envelope.mjs';
import { inspectRepo as defaultInspectRepo, runGit as defaultRunGit } from './git.mjs';
import { AXES, decide, gradeToDeltas } from './learn/bandit.mjs';
import { classifyTask } from './learn/classify.mjs';
import { JOURNAL_LARGE_BYTES, appendRun as defaultAppendRun, journalBytes } from './learn/journal.mjs';
import {
  cellKeyOf,
  commitLearningMutation as defaultCommitLearningMutation,
  readPosteriors as defaultReadPosteriors,
  updatePosterior as defaultUpdatePosterior,
} from './learn/posteriors.mjs';
import { inspectPatch as defaultInspectPatch } from './patch-scope.mjs';
import { listProviders } from './providers/index.mjs';
import {
  resolveSafeWorktree,
  sweepPatches,
  sweepScratch,
  trackChild as defaultTrackChild,
  trackWorktree as defaultTrackWorktree,
  treeKill as defaultTreeKill,
} from './reaper.mjs';
import { resolveStateRoot } from './state-root.mjs';
import {
  USER_PRIVILEGE_NOTE,
  deriveTestCommand as defaultDeriveTestCommand,
  runTests as defaultRunTests,
} from './test-runner.mjs';
import {
  collectPatch as defaultCollectPatch,
  createWorktree as defaultCreateWorktree,
  listIgnoredPaths as defaultListIgnoredPaths,
  removeWorktree as defaultRemoveWorktree,
  snapshotStep as defaultSnapshotStep,
} from './worktree.mjs';

/**
 * 실행 엔진 — 계획 2 의 조각들이 만나는 자리.
 *
 * ```
 * 플래너   읽기 전용 · 일회용 **빈 디렉터리**(사용자 저장소가 아니다)
 *   ↓ 계획
 * [ 워커     워크트리 · 쓰기 · Bash 없는 도구 집합
 *   ↓
 *   우리가 테스트   ← 델리게이트가 아니라 오케스트레이터가 돌린다 (설계 §12.-1)
 *   ↓
 *   베리파이어  워크트리 · 읽기 전용 도구 집합 ] × N 스텝
 * ```
 *
 * ## ★ 왜 워커에게 Bash 를 안 주는가 (라이브 실측, 설계 §12.0)
 *
 * claude 2.1.223 에서 `--allowedTools` 는 **강제력이 없다.** 허용 목록 밖 명령이 네 가지
 * 권한 모드 전부에서 그대로 실행됐고 `permission_denials` 도 비어 있었다. 강제되는 것은
 * 도구 **집합**(`--tools`) 하나뿐이다. 그래서 이 엔진은 역할마다 집합을 명시해서 넘기고
 * (`WORKER_TOOLS`/`VERIFIER_TOOLS`), 그 집합을 argv 로 표현할 채널이 없는 벤더는 그
 * 사실을 `notice` 로 올려 보낸다(`src/providers/codex.mjs`). 삼키면 호출부는 워커에게
 * 셸이 없다고 믿는다.
 *
 * 그래도 실제로 성립하는 격리는 일회용 워크트리(파일시스템 범위) 하나다
 * (`src/worktree.mjs` 의 같은 문단).
 *
 * ## ★ 베리파이어를 어느 쪽으로 뒀는가 (부록이 판단을 요구한 불일치)
 *
 * 브리프는 베리파이어를 "읽기 전용" 이라 부르는데 `claude-args.mjs` 는 `WRITE_ROLES` 에
 * 넣는다. 여기서는 **역할은 `verifier`(쓰기) 그대로 두고 도구 집합만 읽기 전용으로**
 * 준다. 근거:
 *
 *   · 읽기 전용 **역할**은 `--tools ''`(도구 전부 끔)를 받는다. 그 베리파이어는 워크트리를
 *     읽지도 못하므로 검증을 할 수 없다.
 *   · 강제되는 것이 집합이므로, 쓰기 역할에 읽기 전용 집합을 주면 실제로 좁혀진다.
 *
 * §5.5 의 몰래 고치기 탐지는 그대로 둔다. 집합 제한이 argv 로 표현되지 않는 벤더가 있고
 * (codex exec 에는 그 플래그가 없다 — 실측), 델리게이트가 자기 셸로 파일을 고칠 수 있는
 * 경로가 그때 열려 있기 때문이다.
 *
 * ## ★ 탐지에 `git status --porcelain` 을 쓰지 않는다 (브리프와 갈리는 지점)
 *
 * 브리프 §5.5 는 베리파이어 전후 `status --porcelain` 비교를 처방한다. 그 재료는 두 축에서
 * 눈이 먼다(`src/worktree.mjs` 의 `commitAll` 주석에 실측이 있다):
 *
 *   · `status.showUntrackedFiles=no` 저장소에서는 **미추적 신규 파일이 안 보인다.**
 *     베리파이어가 새 파일을 심는 것이 정확히 그 모양이다.
 *   · 중첩 저장소 안의 수정은 반대 방향으로 어긋난다(늘 더러워 보인다).
 *
 * 그래서 재료를 바꾼다: 테스트 실행 **뒤** 스냅샷을 하나 찍어 기준점을 세우고, 베리파이어
 * 뒤에 한 번 더 찍어 `changed`/`files` 를 본다. `snapshotStep` 은 `add -A` 뒤
 * `diff --cached --quiet HEAD` 로 판정하므로 위 두 축을 지나간다. 덤으로 **무엇을 고쳤는지**
 * 경로 목록이 나온다.
 *
 * 기준점을 테스트 뒤에 두는 것이 요점이다 — 테스트가 남긴 산출물(coverage·캐시)을
 * 베리파이어 탓으로 돌리면 탐지가 곧 무시된다.
 *
 * ⚠ 남는 틈: 무시 규칙에 걸린 파일은 `add -A` 도 안 본다. 베리파이어가 `build/` 안을
 *   고치면 이 탐지는 침묵한다. 최종 패치의 `ignoredPaths` 가 그 자리에 무언가 있다는
 *   사실까지만 알린다. 그리고 고쳤다가 정확히 되돌린 경우도 못 본다.
 *
 * ## 봉투
 *
 * 이 함수는 **절대 throw 하지 않는다.** 하위 모듈의 `{ blocked: true, error, recovery }` 는
 * 전부 `envelope.mjs` 의 `failure({ status: 'blocked', … })` 로 번역해서 낸다 — `STATUSES`
 * 어휘를 안 거친 결과가 클라이언트로 새면 안 된다.
 *
 * `status` 는 "오케스트레이션이 돌아 보고를 냈나" 이고, "테스트가 통과했나" 는 `confidence`
 * 와 content 가 말한다. 스코프 플래그만 `confidence:'disputed'` 를 통해 `failed` 로
 * 강등되는데, 그 강등은 `envelope.mjs` 가 하고 여기서 다시 구현하지 않는다.
 */

/** 워커가 받을 도구 집합. Bash 가 없다 — 테스트는 우리가 돌린다(§12.-1). */
export const WORKER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);

/** 베리파이어가 받을 도구 집합. 읽기만 한다. */
export const VERIFIER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);

/** 플래너는 도구 없이 텍스트만 낸다 — 프로바이더의 읽기 전용 역할이 `--tools ''` 를 준다. */
const PLANNER_ROLE = 'planner';

/** 스텝 수 상한. 한 번의 도구 호출이 무한정 델리게이트를 부르지 않게 한다. */
export const MAX_BUDGET = 10;

/**
 * ★★ 엔진 자체의 절대 상한. **`waitMs` 와 무관하다.**
 *
 * 브리프는 "데드라인이 정지의 유일한 권위" 라고 요구하는데, `waitMs: 0`(기본값)은
 * `timeoutSignal` 이 `undefined` 를 돌려주므로 **권위가 아예 없는 상태**였다. 그 둘은
 * 양립하지 않는다. 그래서 `waitMs` 를 "호출자가 정한 상한", 이 값을 "그것과 무관한 상한"
 * 으로 나눈다 — 호출자가 0 을 주면 이 값이 데드라인이 되고, 더 큰 값을 주면 이 값으로 깎인다.
 *
 * 데드라인이 지난 뒤 봉투가 나가는 시각은 `min(waitMs, MAX_WAIT_MS)` + (매달린 단계 수 ×
 * `HARD_STOP_GRACE_MS`) 다. 매달린 단계 수는 경로 구조가 묶는다 — 스텝 루프는 데드라인 뒤
 * 한 스텝만 더 지나고, 매달린 단계는 blocker 로 루프를 끊는다.
 *
 * 1시간인 이유: 예산이 아니라 못이다. 정상적인 오케스트레이션(최대 10스텝 × 플래너·워커·
 * 테스트·베리파이어)이 여기 닿는 것은 이상 상태이고, 그때는 부분 결과라도 내보내는 편이
 * MCP 요청이 영영 매달리는 것보다 낫다.
 */
export const MAX_WAIT_MS = 3_600_000;

/**
 * 데드라인이 발동한 뒤 각 단계가 스스로 끝나기를 기다리는 유예. 넘기면 우리가 손을 뗀다.
 *
 * ★ 왜 필요한가(실측): 자식이 손자에게 stdout 을 물려주고 스스로 끝나면 `close` 가 영영
 *   오지 않는다. `src/providers/run-cli.mjs` 와 `src/test-runner.mjs` 가 각자 하드 못을
 *   갖고 있지만, 프로바이더는 **주입**받는 자리라 그 못이 없는 구현이 들어올 수 있다.
 *   봉투가 나가는 것을 보장하는 마지막 자리는 여기다.
 *
 *   ★ 프로바이더 호출뿐 아니라 git·러너·스코프 이음매에도 두른다(`stage`). 리뷰어
 *     실측: 프로바이더 한 축만 감쌌을 때 나머지 일곱 이음매를 하나씩 영영 pending 으로
 *     두면 6초 안에 봉투가 아예 나오지 않았다. 기본 구현들은 각자 상한이 있지만 그 값의
 *     합은 데드라인과 무관하고, 이 자리들도 전부 주입받는 자리다.
 *
 *   손을 뗀 뒤에도 그 단계는 계속 돌 수 있다 — 우리가 아는 자식은 트리 킬하지만
 *   reparent 된 손자는 못 잡는다(`src/reaper.mjs` 의 같은 한계). 봉투가 그 사실을 싣는다.
 */
const HARD_STOP_GRACE_MS = 10_000;

/** `raceHardStop` 이 유예를 다 쓰고 돌려주는 표식. 프로바이더 결과와 섞이지 않는다. */
const HARD_STOP = Symbol('bom-orch:hard-stop');

/** `src/worktree.mjs` 의 `RUN_ID_PATTERN` 과 같은 값. 갈리면 워크트리 생성이 거부된다. */
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const GENERIC_RECOVERY = '오류 로그를 확인하거나 다시 시도하세요.';

/** 봉투에 실을 각 텍스트의 상한(문자). 자세한 것은 `renderContent` 를 보라. */
const EXCERPT_CHARS = 1_200;
const OLD_STEP_EXCERPT_CHARS = 200;
const TEST_OUTPUT_CHARS = 800;
const MAX_REASONS_PER_STEP = 5;
/** 마지막 요약 단계에서 문자열 하나가 차지할 수 있는 상한. */
const SUMMARY_FIELD_CHARS = 400;
/**
 * 마지막 요약 단계가 싣는 축의 최대 개수.
 *
 * `AXES` 는 넷이고 엔진은 그 키만 담지만, `renderContent` 는 **내보낸 순수 함수**라 임의의
 * payload 를 받는다(그것이 이 함수를 내보내는 이유다). 그래서 축 수에도 상한이 필요하다 —
 * 이 상한이 없으면 축 수가 늘어난 만큼 마지막 단계가 그대로 커진다.
 *
 * ★★ **다만 「고정 크기」를 `MAX_CONTENT_CHARS` 안에서 지킨다고 말하지 않는다.** 한때 그렇게
 *    적었는데 재 보니 거짓이었다.
 *
 *    ★ 아래 수는 **픽스처를 못 박아야만** 재현된다. 한때 픽스처 없이 적었더니 재리뷰의
 *      재구성과 상수 814 만큼 어긋났다 — 「몇 자냐」는 payload 전체가 정하는 값이지 축 수만의
 *      함수가 아니다. 픽스처는 `test/engine.test.mjs` 의
 *      `★ ⑤ 축이 아무리 많아도 마지막 단계는 여덟 축까지만 싣는다` 의 payload **그대로**이고
 *      (`giant = 'x'.repeat(100_000)` 를 `patch.path` 와 `plan.content` 에, `steps: []`),
 *      `learning.decisions`·`sources` 의 축 수와 키/값 길이만 바꿨다.
 *      측정 시점: 커밋 `2ad2415` · `renderContent` 직접 호출 · 반환 문자열 길이.
 *      (「(HEAD)」라고 적어 뒀었는데 커밋 하나 만에 거짓이 됐다 — 수에는 **해시**만 적는다.
 *      「지금」을 가리키는 말은 다음 커밋에서 반드시 낡는다.)
 *
 *      키 `axis<i>-<giant>` · 값 `giant`  → 축 4 → 9,147자 · 8 → 17,587 · 12 → 17,587 · 20 → 17,587
 *      키 `axis<i>`         · 값 `giant`  → 축 4 → 4,179자 · 8 →  7,651 · 12 →  7,651 · 20 →  7,651
 *      키 `axis<i>`  · 값 `arm-axis<i>`   → 축 4 →   899자 · 8 →  1,091 · 12 →  1,091 · 20 →  1,091
 *      (`MAX_CONTENT_CHARS` = 10,000)
 *
 *    즉 이 상한이 지키는 것은 **"입력 크기에 비례하지 않는다"** 뿐이고(세 줄 다 축 8 부터
 *    평평해진다), 거대한 축 **이름**에서는 그 고정점이 상한 **위**다. 이름이 짧으면 팔 문자열이
 *    거대해도 고정점이 상한 안이다 — 넘기는 것은 이름 쪽이다.
 *    엔진 경로는 축이 넷이라(`AXES`) 도달하지 않는다. 같은 파일의 「여기서도 넘기면 잘린
 *    JSON 이 나간다」 주석이 이 갈래의 결과를 이미 인정하고 있다.
 *    ☞ 학습 요약에 자체 예산을 줄지는 태스크 12 의 렌더 예산과 함께 정한다.
 */
const AXIS_SUMMARY_LIMIT = 8;

/**
 * notice 의 상한 — 개별과 합계 둘 다.
 *
 * ★ 왜 필요한가(실측): `content` 는 `envelope.mjs` 가 10,000자로 깎는데 `notice` 를 깎는
 *   코드는 저장소 어디에도 없었다. 진짜 저장소로 재니 `content` 800자 : `notice` 51,133자
 *   = 64배가 나왔고 봉투 하나가 52KB 로 나갔다 — `.gitignore` 에 `*.log` 하나가 있고 워커가
 *   로그 2,000개를 남기면 그 목록이 그대로 문장에 박힌다. 길이를 정하는 쪽이 우리가 아니라
 *   델리게이트다. 호스트가 결과를 자르면 꼬리의 `patch` 경로·`recovery` 가 먼저 사라진다.
 */
const NOTICE_CHARS = 400;
const NOTICES_TOTAL_CHARS = 1_600;
/** 문장에 박는 목록의 앞 몇 개. 나머지는 개수로만 적는다. */
const NOTICE_LIST_ITEMS = 3;
/** 문장에 박는 목록 원소 하나의 상한. 경로 이름은 델리게이트가 정한다. */
const NOTICE_ITEM_CHARS = 120;

/** 어떤 값에서도(toString 이 던지는 값 포함) 사람이 읽을 문자열을 뽑는다. */
function safeText(value) {
  if (typeof value === 'string') return value !== '' ? value : '알 수 없는 오류';
  try {
    const text = String(value?.message ?? value);
    return text !== '' ? text : '알 수 없는 오류';
  } catch {
    return '알 수 없는 오류';
  }
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit)}…(${text.length}자 중 앞 ${limit}자)` : text;
}

/**
 * 목록을 문장에 박을 때 앞 몇 개 + 개수만 적는다. 전체 목록은 상한 사다리를 지나는
 * `content` 쪽(`patch.ignoredPaths` · `verifier.touchedFiles`)에만 둔다.
 */
function few(list, keep = NOTICE_LIST_ITEMS) {
  if (!Array.isArray(list) || list.length === 0) return '없음';
  const head = list.slice(0, keep).map((item) => {
    const text = typeof item === 'string' ? item : show(item);
    return text.length > NOTICE_ITEM_CHARS ? `${text.slice(0, NOTICE_ITEM_CHARS)}…` : text;
  });
  return list.length > keep ? `${head.join(', ')} 외 ${list.length - keep}건` : head.join(', ');
}

/** 쌓인 notice 를 봉투에 실을 한 덩어리로 합친다. 합계 상한을 넘기면 뒤를 접는다. */
function joinNotices(list) {
  if (list.length === 0) return undefined;
  const kept = [];
  let used = 0;
  for (const text of list) {
    if (kept.length > 0 && used + text.length + 1 > NOTICES_TOTAL_CHARS) break;
    kept.push(text);
    used += text.length + 1;
  }
  const dropped = list.length - kept.length;
  return dropped > 0 ? `${kept.join(' ')} (그 밖에 알림 ${dropped}건이 더 있어 접었습니다.)` : kept.join(' ');
}

/**
 * 인자 검증의 오류 메시지에 값을 적는다. **절대 던지지 않는다.**
 *
 * ★ `JSON.stringify` 를 그대로 쓰면 BigInt 에서 던지고 `toJSON` 이 던지는 객체에서도
 *   던진다(실측: `waitMs=5n` 이 `invalid` 가 아니라 `failed` 로 나갔다). 두 status 는
 *   호출자의 다음 행동이 정반대다 — `invalid` 는 "네 인자를 고쳐라", `failed` 는
 *   "우리 버그다". 거부는 옳게 하면서 **거부 메시지를 만들다가** 뒤집히면 안 된다.
 *   `undefined` 를 넘겼을 때 `JSON.stringify` 가 `undefined` 를 돌려주는 것도 여기서 흡수한다.
 */
function show(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text === 'string') return text;
  } catch {
    // 아래로 떨어진다.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '(표현할 수 없는 값)';
  }
}

/** 하위 모듈의 `{blocked:true}` 인가. `ok:true` 결과와 겹치지 않는다. */
const isBlocked = (result) => result !== null && typeof result === 'object' && result.blocked === true;

/**
 * 실행 ID 를 만든다 (배선 숙제 2).
 *
 * 세 가지 제약을 동시에 만족해야 한다:
 *
 *   · `src/worktree.mjs` 의 `RUN_ID_PATTERN` — 소문자·숫자로 시작하고 `.` 과 대문자를 쓰지
 *     않는다(Windows 가 그 둘을 같은 디렉터리로 접기 때문이다).
 *   · Windows 예약 장치명(`nul`/`con`/`aux`/`prn`/`com1..9`/`lpt1..9`)이 아니어야 한다.
 *     그 이름은 패턴을 통과하지만 `worktree add` 가 `Invalid argument` 로 죽는다(실측).
 *   · 같은 밀리초에 두 번 불려도 서로 달라야 한다 — 같으면 두 실행이 같은 디렉터리를 두고
 *     충돌한다.
 *
 * 셋 다 접두사 + 타임스탬프 + 카운터/난수로 자연히 해결된다. 접두사가 있으므로 결과가
 * 예약 장치명이 될 수 없고, 36진수 표기는 소문자만 낸다.
 */
let runIdSeq = 0;
export function makeRunId({ now = Date.now, random = Math.random } = {}) {
  runIdSeq = (runIdSeq + 1) % 1_296; // 36^2
  const stamp = Math.floor(now()).toString(36);
  const seq = runIdSeq.toString(36).padStart(2, '0');
  const salt = Math.floor(random() * 1_679_616).toString(36).padStart(4, '0');
  return `run-${stamp}-${seq}${salt}`;
}

/**
 * `AXES.placement` 의 두 팔. 정본은 `src/learn/bandit.mjs` 이고 여기서는 **문자열 하나가 두
 * 자리(배치 판정과 WIDE 뒤집기)에서 갈리지 않게** 이름을 붙여 둔다. 벤더 이름이 아니라
 * "레지스트리 순서의 첫째·둘째 중 누가 앞이냐" 로만 읽는다(아래 `assignRoles`).
 */
const FORWARD_PLACEMENT = 'claude>codex';
const REVERSED_PLACEMENT = 'codex>claude';

/**
 * placement 두 팔을 맞바꾼다 — §7.2 결정③ WIDE 가 실패한 스텝 **다음** 스텝에서 부른다.
 *
 * ★ 모르는 값(`undefined`·오타)은 `assignRoles` 가 `claude>codex` 로 읽으므로 그 반대편을
 *   낸다. 그래야 첫 뒤집기가 실제로 배치를 바꾼다 — `flip(undefined)` 가 `claude>codex` 를
 *   내면 기본 팔로 도는 실행(=`decisions.placement` 가 비어 있는 실행)에서 첫 뒤집기가
 *   무연산이 되고, WIDE 와 DEEP 이 우연히 같아진다.
 */
const flipPlacement = (placement) =>
  placement === REVERSED_PLACEMENT ? FORWARD_PLACEMENT : REVERSED_PLACEMENT;

/**
 * 설계 §7.2 의 결정 축(`mix`·`placement`)을 실제 역할 배치로 옮긴다. 순수 함수다 —
 * §7.2 결정③ 의 WIDE 경로가 스텝마다 다시 부른다(아래 `placeRoles`).
 *
 * 팔 이름의 정본은 `src/learn/bandit.mjs` 의 `AXES` 다. 이 파일은 벤더 이름을 알면 안 되므로
 * (`providers/contract.mjs`) 팔 이름의 `claude`·`codex` 는 **레지스트리 순서의 첫째·둘째**로만
 * 읽는다: 앞에 적힌 쪽이 워커, 뒤에 적힌 쪽이 베리파이어다.
 *
 * ★ 아는 팔이 아니면 그 축의 기본 팔로 떨어진다(`placement` → `claude>codex`,
 *   `mix` → `mix`). 라이브러리 입구라 아무 값이나 올 수 있고, 여기서 실행을 거부하면
 *   학습 계층의 사소한 오타가 사용자 작업을 막는다.
 *
 * ★ 플래너가 워커를 따라간다. 첫째 벤더에 못 박으면 두 팔이 서로의 거울상이 아니게 되고
 *   (`claude>codex` 는 플래너·워커가 같은 벤더, `codex>claude` 는 다른 벤더), 밴딧이 한
 *   축에서 "어느 벤더가 워커에 나은가" 와 "플래너·워커가 같은 벤더인 편이 나은가" 를
 *   섞어 배운다. 계획 2 의 고정 배치도 플래너·워커가 같은 벤더였다.
 *
 * ★ 벤더가 하나뿐이면 두 축 다 성립하지 않는다 — 세 역할이 같은 벤더가 된다. 그 사실은
 *   봉투의 notice 가 말한다(아래 `crossCheckNotice`).
 *
 * ★ 호출자가 **최소 하나**의 프로바이더를 보장한다. 빈 목록을 주면 던지지 않고(라이브러리
 *   규약) 세 역할이 전부 `undefined` 인 객체가 나온다 — 실측이다. `orchestrate` 는 빈 목록을
 *   이 함수 앞에서 blocked 봉투로 거르므로(실측) 엔진 안에서는 도달하지 않는다. 스텝마다
 *   다시 부르는 `placeRoles` 도 같은 `providers` 를 쓰므로 그 보장을 물려받는다.
 *
 * ★ 벤더가 하나뿐이면 두 팔이 **같은 배치**를 낸다(세 역할이 전부 첫째 벤더). 그래서 WIDE
 *   뒤집기가 그 실행에서 무연산이다 — 봉투의 `rewrite.flips` 가 0 으로 그 사실을 말한다.
 */
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
 * 교차검증 없이 끝난 실행이 그 사실을 말하는 문장. 교차검증이 됐으면 `null`.
 *
 * ★ **결정이 아니라 오버라이드까지 반영된 최종 배치**를 본다 — 실제 호출 여부는 안 본다.
 *   `options.worker`/`verifier` 로 벤더를 직접 지정하면 결정과 배치가 갈리는데(예:
 *   `mix:'single'` 인데 `verifier:'beta'`), 결정만 보고 문장을 만들면 교차검증을 한 실행이
 *   안 했다고 신고한다. 반대로 이 문장은 프로바이더를 하나도 안 띄운 실행(사전 점검·워크트리
 *   blocked)에도 실리므로 **과거형으로 쓰면 안 된다** — 말하는 것은 "무엇이 돌았나" 가
 *   아니라 "어떻게 배치됐나" 이고, 그 사실은 호출 여부와 무관하게 참이다.
 *
 * ★ 벤더는 **id** 로 센다. 객체 동일성으로 비교하면 같은 id 의 프로바이더 객체가 둘 주입될 때
 *   §9.2 신고가 조용히 꺼진다. 그 목록은 라이브러리 입구로만 올 수 있지만(`listProviders()`
 *   는 id 로 키를 잡은 Map 이라 중복을 못 낸다) 이 함수는 호출자가 준 임의의 목록을 받는다.
 *
 * ★ id 가 문자열이 아닌(주로 `undefined`) 프로바이더끼리는 판정하지 않고 `null` 을 낸다.
 *   `id` 비교를 `!==` 로만 하면 서로 다른 두 객체가 **둘 다** id 를 안 갖고 있을 때
 *   `undefined !== undefined` 가 거짓이 되어 "같은 벤더" 로 오판하고, 아래 `vendorCount`
 *   도(호출부의 `new Set(ids)` 가 문자열이 아닌 id 를 이미 걸러내므로) 0 이 되어
 *   "벤더가 하나뿐이라…" 를 거짓으로 신고한다. 이 목록도 라이브러리 입구로만 올 수 있다 —
 *   레지스트리는 `assertProviderShape` 가 로드 시점에 id 를 강제한다.
 *
 * ★ 두 경우를 나누는 이유는 **사용자가 할 일이 다르기 때문**이다. 벤더가 하나뿐이면 다른
 *   벤더 CLI 를 설치해야 하고, 둘 있는데 한 벤더로 돈 것은 이 실행이 그렇게 정해진 것이다.
 *   설계 §9.2 가 금지하는 것은 한 벤더로 도는 것 자체가 아니라 **조용히** 그러는 것이다.
 *
 * ★★ 이 함수가 내는 것은 **실행 단위** 문장이다("이 실행이 …정해졌습니다"). 스텝 단위 사실에
 *    재사용하지 마라 — 봉투가 스코프를 과장한다. 실측: `worker:'alpha'` + `rewrite:'wide'` +
 *    budget 3 은 1·3 스텝이 alpha/beta 로 교차검증됐는데도 이 문장이 실렸다.
 *    ⚠ **시작 배치를 넣어 부르는 것만으로는 실행 단위 사실이 아니다.** WIDE 아래에서 시작
 *    배치는 1 스텝의 사실이다. 호출부(`crossCheckLines`)는 스텝이 돌았으면
 *    `singleVendorSteps === steps.length` 일 때만 이 문장을 쓴다 — 실측: 그 조건 없이 루프
 *    앞에서 부르면 `verifier:'alpha'`·`worker:'beta'` 두 조합이 이 문장과 스텝 단위 문장을
 *    한 봉투에 함께 실었다.
 */
function crossCheckNotice(worker, verifier, vendorCount) {
  if (typeof worker?.id !== 'string' || typeof verifier?.id !== 'string' || worker.id !== verifier.id) return null;
  return vendorCount > 1
    ? '교차검증 없이 단일 벤더로 돌도록 배치됐습니다 — 워커와 베리파이어가 같은 벤더입니다. ' +
        '이 실행이 한 벤더만 쓰도록 정해졌습니다(mix=single 또는 역할 지정). 교차검증이 필요하면 그 지정을 빼세요.'
    : '벤더가 하나뿐이라 교차검증 없이 단일 벤더로 돌도록 배치됐습니다 — 워커와 베리파이어가 같은 벤더입니다. ' +
        '다른 벤더 CLI 를 설치하면 교차검증이 켜집니다.';
}

/** 워크트리 등록 조회·회수의 시간 상한. `src/worktree.mjs` 와 같은 값을 쓴다. */
const WORKTREE_TIMEOUT_MS = 300_000;

/**
 * 앞선 실행이 남긴 **워크트리 등록 잔재**를 회수한다 (배선 숙제 1). 절대 throw 하지 않는다.
 *
 * 무엇이 열려 있었나(`src/worktree.mjs` 의 M-2): 리퍼는 디렉터리만 `rm` 하고 등록 해제를
 * 하지 않는다. 그리고 계획 2 Task 2 가 무조건 돌던 전역 `worktree prune` 을 제거하면서
 * (그게 사용자의 다른 워크트리 관리 상태를 파괴했다) 그 잔재가 실제로 남게 됐다.
 * `createWorktree` 는 **같은 runId** 의 죽은 등록만 회수하는데 runId 는 매번 달라서,
 * 강제 종료된 실행의 등록은 아무도 치우지 않는다.
 *
 * 여기서 회수 대상은 두 조건을 **동시에** 만족하는 것뿐이다:
 *   · git 자신이 `prunable` 이라고 말한다(= 그 등록은 죽었다). 살아 있는 워크트리는
 *     — 우리 것이든 사용자 것이든 — 이 표식이 없다.
 *   · 경로가 `<stateRoot>/worktrees/` 아래다(`resolveSafeWorktree`). 사용자의 워크트리는
 *     거기 있을 수 없다. 판정은 실체 경로로 한다 — 등록 목록과 우리 문자열이 정션·8.3
 *     경유에서 갈린다(`src/real-path.mjs`). 다만 `worktree remove` 에 넘기는 값은 git 이
 *     등록한 그 문자열이어야 한다.
 *
 * 전역 `worktree prune` 은 쓰지 않는다 — 그것이 I-6 에서 제거한 파괴 경로다. 항목마다
 * `worktree remove --force <우리 경로>` 로 그 등록만 뺀다.
 */
async function reclaimOrphanRegistrations({ run, projectPath, stateRoot }) {
  const listed = await run({
    args: ['worktree', 'list', '--porcelain'],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  }).catch(() => null);
  // 조회에 실패하면 **모르는 것**이다. 모르는 채로 지우지 않는다.
  if (!listed?.ok || typeof listed.stdout !== 'string') return { reclaimed: 0, checked: false };

  const entries = [];
  for (const raw of listed.stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) entries.push({ path: line.slice('worktree '.length), prunable: false });
    else if ((line === 'prunable' || line.startsWith('prunable ')) && entries.length > 0) {
      entries[entries.length - 1].prunable = true;
    }
  }

  let reclaimed = 0;
  for (const entry of entries) {
    if (!entry.prunable) continue;
    if ((await resolveSafeWorktree(stateRoot, entry.path)) === null) continue;
    const removed = await run({
      args: ['worktree', 'remove', '--force', entry.path],
      cwd: projectPath,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    if (removed?.ok === true) reclaimed += 1;
  }
  return { reclaimed, checked: true };
}

// ── 지시문 ────────────────────────────────────────────────────────────────

/**
 * @param evidence §7.5 의 근거 문단(`decide().evidence`). **지시문 앞에** 붙는다.
 *
 * ★ 앞에 두는 이유: 이 문단은 "이 저장소에서 실제로 관찰된 사실" 이고 계획을 세우기 전에
 *   읽혀야 한다. 뒤에 붙이면 긴 작업 설명 뒤로 밀린다.
 * ⚠ 문단은 **밴딧이 고른 축만** 말한다. 호출자가 축을 직접 지정하면(`options.decisions`)
 *   그 축은 문단에 안 나오거나, 밴딧이 골랐던 다른 팔이 적혀 있을 수 있다 — 문단은 결정의
 *   근거이지 이번 실행의 배치 기록이 아니다. 배치 기록은 `content.learning.decisions` 다.
 */
function plannerInstruction({ task, testPlan, evidence }) {
  const testLine =
    testPlan === null
      ? '이 프로젝트에서는 테스트 명령을 유도하지 못했습니다 — 검증은 사람이 합니다.'
      : `테스트는 오케스트레이터가 직접 돌립니다: ${testPlan.source} 의 정의(${testPlan.definition.key}).`;
  return [
    ...(typeof evidence === 'string' && evidence !== '' ? [clip(evidence, EXCERPT_CHARS), ''] : []),
    '다음 작업의 실행 계획을 세우세요. 당신은 파일을 읽거나 쓸 수 없습니다 — 텍스트 계획만 냅니다.',
    '',
    `작업: ${task}`,
    '',
    testLine,
    '계획을 실행할 워커는 셸을 쓸 수 없고 파일 읽기·쓰기·검색만 합니다. 테스트 명령을 바꾸라고',
    '지시하지 마세요 — 바뀌면 실행이 거부됩니다.',
    '',
    '무엇을 어떤 순서로 고칠지, 무엇을 근거로 다 됐다고 판단할지 짧게 적으세요.',
  ].join('\n');
}

function workerInstruction({ task, plan, step, budget, feedback }) {
  const lines = [
    `작업: ${task}`,
    '',
    '계획:',
    clip(plan, EXCERPT_CHARS),
    '',
    `이번은 ${step}/${budget} 번째 스텝입니다. 당신은 일회용 워크트리 안에서 일합니다 —`,
    '이 디렉터리 밖은 보이지도 닿지도 않습니다. 셸은 없습니다.',
    '테스트는 이 실행이 끝난 뒤 오케스트레이터가 직접 돌립니다. 테스트 정의(package.json 의',
    'scripts.test, Makefile 의 test 타깃, pytest 설정 등)를 고치지 마세요 — 고치면 실행이 거부됩니다.',
  ];
  if (feedback !== null) {
    lines.push('', '앞 스텝의 결과:', clip(feedback, EXCERPT_CHARS));
  }
  return lines.join('\n');
}

function verifierInstruction({ task, plan, files, tests }) {
  return [
    '아래 작업의 결과를 검토하세요. 당신은 읽기만 합니다 — 파일을 고치지 마세요.',
    '고치면 탐지되고 당신의 판정은 신뢰도 낮음으로 기록됩니다.',
    '',
    `작업: ${task}`,
    '',
    '계획:',
    clip(plan, EXCERPT_CHARS),
    '',
    `이번 스텝이 건드린 파일: ${files.length === 0 ? '(없음)' : files.join(', ')}`,
    '',
    '테스트 결과:',
    clip(tests, EXCERPT_CHARS),
    '',
    '작업이 실제로 끝났는지, 빠진 것이나 잘못된 것이 있는지 적으세요.',
  ].join('\n');
}

// ── content 렌더링 ────────────────────────────────────────────────────────

/**
 * 봉투의 content 를 만든다.
 *
 * `envelope.mjs` 는 상한을 넘는 content 를 **꼬리부터** 자른다 — 잘린 JSON 은 파싱조차
 * 안 되므로 여기서 먼저 줄인다. 줄이는 순서는 "덜 중요한 것부터": 옛 스텝의 본문 →
 * 모든 본문 → 목록 → 스텝 목록 자체 → 크기가 고정된 요약.
 *
 * ★ **내보내는 이유는 테스트다.** 이 함수의 계약은 "**어떤** payload 에도 상한 안의 파싱
 *   가능한 JSON 을 낸다" 인데, 마지막 단계는 정의상 그 앞 단계들이 전부 실패했을 때만
 *   쓰인다. 엔진을 통째로 돌려서 그 상태를 만들려면 비현실적인 픽스처가 필요하고(실제로
 *   시도했다), 그러면 정작 그 단계를 재지 못한 채 초록이 된다 — 뮤테이션으로 확인했다.
 *   순수 함수이므로 적대적 payload 를 직접 먹여서 계약을 그대로 잰다.
 */
export function renderContent(payload) {
  const levels = [
    (p) => p,
    (p) => ({ ...p, steps: p.steps.map(stripStepText) }),
    (p) => ({ ...p, plan: { ...p.plan, content: '' }, steps: p.steps.map(stripStepText) }),
    // ★ 여기서부터 **경로 목록**을 줄인다. 앞 단계들은 텍스트만 비우는데, 상한을 넘기는
    //   실제 원인은 `patch.files`(테스트가 남긴 산출물까지 섞여 들어온다)와
    //   `scope.reasons`(patch-scope 의 상한이 100건이다) 같은 목록이다. 실측: 50자짜리
    //   현실적 경로 200개만으로 잘린 JSON 이 나갔다.
    (p) => trim(p, 40, 10),
    (p) => trim({ ...p, plan: { ...p.plan, content: '' }, steps: [], stepsOmitted: p.steps.length }, 10, 3),
    // ★ 마지막은 **입력 크기에 비례하지 않는 고정 요약**이다. 앞 단계가 전부 상한을
    //   넘기면 여기로 오고, 여기서도 넘기면 잘린 JSON — 즉 파싱 불가능한 content —
    //   이 나간다.
    //
    //   ★ 문자열도 반드시 자른다. "목록만 줄이면 된다"는 틀렸다: 목록이 짧아도 **원소
    //     하나가** 거대할 수 있고(경로 이름은 델리게이트가 정한다), `patch.path` 조차
    //     상태 루트 설정에 따라 길어진다. 자르지 않았더니 이 단계의 출력이 20,176자로
    //     나왔다 — 정확히 이 단계가 막으려던 결과다.
    (p) => ({
      runId: clip(p.runId, SUMMARY_FIELD_CHARS),
      stopReason: clip(p.stopReason, SUMMARY_FIELD_CHARS),
      stepCount: p.stepCount,
      patch: {
        path: clip(p.patch.path, SUMMARY_FIELD_CHARS),
        bytes: p.patch.bytes,
        empty: p.patch.empty,
        fileCount: count(p.patch.files),
      },
      scope: { flagged: p.scope.flagged, reasonCount: count(p.scope.reasons) },
      // ★ 학습 사실은 마지막 단계에서도 남긴다. §7 의 결정과 그 반영 여부는 이 봉투에만 있는
      //   정보이고(저널은 사용자가 따로 열어야 한다), 크기는 `AXES` 로 묶여 있다 — 축 넷 ×
      //   짧은 팔 이름이다. 다만 팔 문자열은 **라이브러리 호출자가 정할 수 있으므로**
      //   (`options.decisions.placement`) 값마다 잘라야 이 단계의 "입력 크기에 비례하지
      //   않는다" 가 유지된다. 실측(자르기 없이): 팔에 100,000자를 넣으면 이 단계가
      //   400,038자를 냈다 — 정확히 이 단계가 막으려던 결과다.
      ...(p.learning !== null && typeof p.learning === 'object' ? { learning: summarizeLearning(p.learning) } : {}),
      truncatedReport: true,
    }),
  ];
  let last = '';
  for (const level of levels) {
    last = JSON.stringify(level(payload));
    if (typeof last === 'string' && last.length <= MAX_CONTENT_CHARS) return last;
  }
  return last;
}

const count = (value) => (Array.isArray(value) ? value.length : 0);

/** 문자열이면 자르고 아니면 `null`. 요약 단계가 `null` 과 `''` 를 섞지 않게 한다. */
const clipOrNull = (value) => (typeof value === 'string' ? clip(value, SUMMARY_FIELD_CHARS) : null);

/** 축별 팔 문자열 맵 하나를 자른다. 축 수는 `AXES` 가, 값 길이는 여기서 묶는다. */
function clipArms(map) {
  if (map === null || typeof map !== 'object') return {};
  return Object.fromEntries(
    Object.entries(map)
      .slice(0, AXIS_SUMMARY_LIMIT)
      .map(([axis, arm]) => [clip(axis, SUMMARY_FIELD_CHARS), clipOrNull(arm)]),
  );
}

/** `renderContent` 의 마지막(고정 크기) 단계가 쓰는 학습 요약. */
function summarizeLearning(learning) {
  const applied = learning.applied;
  return {
    taskClass: clipOrNull(learning.taskClass),
    decisions: clipArms(learning.decisions),
    sources: clipArms(learning.sources),
    applied:
      applied === null || typeof applied !== 'object'
        ? null
        : {
            grade: clipOrNull(applied.grade),
            axes: (Array.isArray(applied.axes) ? applied.axes : [])
              .slice(0, AXIS_SUMMARY_LIMIT)
              .map((axis) => clip(axis, SUMMARY_FIELD_CHARS)),
          },
  };
}

/** 배열 하나를 N개로 자르고 몇 개를 뺐는지 남긴다. 목록이 없으면 그대로 둔다. */
function cut(list, keep) {
  if (!Array.isArray(list) || list.length <= keep) return { list, omitted: 0 };
  return { list: list.slice(0, keep), omitted: list.length - keep };
}

/** payload 의 지배 항목(경로 목록·스코프 사유)을 줄인다. */
function trim(payload, keepFiles, keepReasons) {
  const files = cut(payload.patch.files, keepFiles);
  const ignored = cut(payload.patch.ignoredPaths, keepFiles);
  // gitlinks 와 워크트리 쪽 목록도 길이를 델리게이트가 정한다 — 안 줄이면 그 둘이 큰
  // 실행에서 어느 단계도 상한 안에 못 들어온다.
  const gitlinks = cut(payload.patch.gitlinks, keepReasons);
  const wtIgnored = cut(payload.worktree?.ignoredPaths, keepReasons);
  const reasons = cut(payload.scope.reasons, keepReasons);
  const blockers = cut(payload.blockers, keepReasons);
  return {
    ...payload,
    patch: {
      ...payload.patch,
      files: files.list,
      filesOmitted: files.omitted,
      ignoredPaths: ignored.list,
      ignoredPathsOmitted: ignored.omitted,
      gitlinks: gitlinks.list,
      gitlinksOmitted: gitlinks.omitted,
    },
    worktree: { ...payload.worktree, ignoredPaths: wtIgnored.list, ignoredPathsOmitted: wtIgnored.omitted },
    scope: { ...payload.scope, reasons: reasons.list, reasonsOmitted: reasons.omitted },
    blockers: blockers.list,
    steps: (payload.steps ?? []).map((step) => {
      const stepFiles = cut(step.worker?.files, keepFiles);
      const stepReasons = cut(step.scope?.reasons, keepReasons);
      return {
        ...step,
        ...(step.worker ? { worker: { ...step.worker, files: stepFiles.list, filesOmitted: stepFiles.omitted } } : {}),
        ...(step.scope ? { scope: { ...step.scope, reasons: stepReasons.list } } : {}),
      };
    }),
  };
}

function stripStepText(step) {
  const out = { ...step };
  if (out.worker) out.worker = { ...out.worker, content: '' };
  if (out.verifier) out.verifier = { ...out.verifier, content: '' };
  if (out.tests) out.tests = { ...out.tests, output: '' };
  return out;
}

// ── 본체 ──────────────────────────────────────────────────────────────────

/**
 * 오케스트레이션을 한 번 돈다. **절대 throw 하지 않는다.**
 *
 * ★ 티어의 입구는 `decisions.tier` 뿐이다. 계획 2 의 최상위 `options.tier` 는 계획 3 태스크 6
 *   이 지웠다 — 같은 어휘를 말하는 입구가 둘이면 태스크 8 이 저널에 적는 팔과 실제로 쓴
 *   티어가 조용히 갈린다. 이 줄에 `tier?: string` 을 남겨 두면 문서대로 부른 호출자가 아무
 *   말도 못 듣고 강한 티어로 돈다 — 실측이다. 최상위 입구를 되살리는 뮤턴트에서
 *   「티어의 입구는 decisions.tier 하나뿐이다」 하나가 붉어진다.
 *
 * @param {{ task: string, projectPath: string, isolation?: string, budget?: number,
 *           waitMs?: number, decisions?: { mix?: string, placement?: string, tier?: string },
 *           planner?: string, worker?: string, verifier?: string,
 *           onProgress?: Function, deps?: object }} spec
 * @returns MCP 봉투(`src/envelope.mjs`). content 는 JSON 문자열이다.
 */
export async function runOrchestration(spec) {
  // ★ 구조분해로 받지 않는다. `runOrchestration(null)` 이 구조분해 자리에서 TypeError 를
  //   던지면 봉투가 아니라 거부된 프로미스가 나간다(worktree.mjs 가 같은 이유로 버렸다).
  const options = spec !== null && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  if (options === null) {
    return failure({
      status: 'invalid',
      error: `인자는 JSON 객체여야 합니다 — ${spec === null ? 'null' : Array.isArray(spec) ? 'array' : typeof spec} 를 받았습니다.`,
      recovery: '{ task, projectPath } 를 담은 객체로 다시 부르세요.',
    });
  }

  try {
    return await orchestrate(options);
  } catch (error) {
    return failure({
      status: 'failed',
      error: `오케스트레이션이 예기치 못한 오류로 멈췄습니다: ${safeText(error)}`,
      recovery: '서버 로그를 확인한 뒤 다시 시도하세요. 워크트리가 남아 있으면 상태 루트의 worktrees/ 를 확인하세요.',
    });
  }
}

async function orchestrate(options) {
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};

  // ── 인자 검증 ───────────────────────────────────────────────────────────
  const task = options.task;
  if (typeof task !== 'string' || task.trim() === '') {
    return failure({
      status: 'invalid',
      error: 'task 가 비어 있습니다.',
      recovery: '무엇을 해야 하는지 한 문장 이상으로 적어 주세요.',
    });
  }
  const projectPath = options.projectPath;
  if (typeof projectPath !== 'string' || projectPath === '' || !isAbsolute(projectPath)) {
    return failure({
      status: 'invalid',
      error: `projectPath 가 절대 경로가 아닙니다: ${show(projectPath)}`,
      recovery: '대상 git 저장소의 절대 경로를 주세요. 상대 경로는 이 서버의 cwd 기준으로 풀립니다.',
    });
  }

  // ★ `isolation` 은 워크트리만 받는다. "격리 없음" 을 조용히 받아들이면 델리게이트가
  //   사용자 저장소에서 직접 돈다 — 라이브 실측으로 도구 권한 플래그가 셸을 제한하지
  //   못한다는 것이 확인됐으므로(설계 §12.0) 그때 남는 경계가 하나도 없다.
  const isolation = options.isolation ?? 'worktree';
  if (isolation !== 'worktree') {
    return failure({
      status: 'invalid',
      error: `isolation 값을 지원하지 않습니다: ${show(isolation)}`,
      recovery:
        "isolation 은 'worktree' 뿐입니다. 실측 결과 벤더 CLI 의 도구 권한 플래그로는 델리게이트의 셸을 " +
        '제한할 수 없어, 실제로 성립하는 격리가 일회용 워크트리뿐입니다.',
    });
  }

  const budget = options.budget ?? 1;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) {
    return failure({
      status: 'invalid',
      error: `budget 은 1 이상 ${MAX_BUDGET} 이하의 정수여야 합니다: ${show(budget)}`,
      recovery: `스텝 수를 1~${MAX_BUDGET} 사이의 정수로 주세요.`,
    });
  }

  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    return failure({
      status: 'invalid',
      error: `waitMs 는 0 이상의 유한한 수여야 합니다: ${show(waitMs)}`,
      recovery: `밀리초 단위 상한을 주세요. 0 은 "호출자가 상한을 정하지 않는다" 이고, 그때도 엔진 자체 상한(${MAX_WAIT_MS}ms)이 걸립니다.`,
    });
  }

  // ★ 주입한 목록은 **길이와 무관하게** 존중한다. 예전에는 빈 배열이 조용히 실제
  //   레지스트리로 폴백해서, "엔진 테스트는 진짜 CLI 를 안 쓴다" 는 전제를 어기고 진짜
  //   벤더 프로바이더를 태웠다(실측: 주입 `[]` 로 부르면 claude 가 불렸다). 덤으로 아래
  //   blocked 분기가 도달 불가능했다 — 레지스트리는 항상 둘을 낸다.
  const providers = Array.isArray(deps.providers) ? deps.providers : listProviders();
  const ids = providers.map((p) => p?.id).filter((id) => typeof id === 'string' && id !== '');
  if (providers.length === 0) {
    return failure({
      status: 'blocked',
      error: '쓸 수 있는 프로바이더가 하나도 없습니다.',
      recovery: '프로바이더 목록이 비어 있습니다. 주입한 목록을 확인하세요.',
    });
  }

  // 설계 §7.2 의 결정 축. 아래 `decide()` 가 비어 있는 축을 채운다 — **호출자가 적은 축이
  // 이긴다**(라이브러리 입구가 더 구체적인 채널이다. 역할 id 가 placement 팔을 이기는 것과
  // 같은 축이다).
  //
  // ★ 여기서 `options.allowSingle` 을 보지 **않는다.** §9.2 의 "single 은 명시적 허용이
  //   있어야 한다" 는 `src/learn/bandit.mjs` 의 `decide` 가 팔을 거르는 자리에서 지킨다.
  //   엔진이 한 번 더 걸러 `single` 을 `mix` 로 되돌리면, 저널·사후분포에 기록하는
  //   팔(`decide` 가 고른 `single`)과 실제로 돈 배치(`mix`)가 갈린다 — 하지 않은 것을
  //   했다고 배운다. 결정은 한 곳에서만 하고 엔진은 받은 대로 돌고 실제를 신고한다.
  //
  // ★★ 호출자의 객체를 **그대로 들고 다니지 않는다.** `AXES` 의 축만, 축마다 따로 감싸서,
  //    문자열일 때만 옮긴다. 세 가지를 한 줄에서 지킨다:
  //      · 축과 **무관한** own 속성을 읽지 않는다 — 태스크 7 실측: `{...decisions}` 로 펴자
  //        `get zzz(){throw}` 하나가 실행을 succeeded → failed 로 뒤집었다.
  //      · 축 **자신**이 던지는 게터여도 실행이 죽지 않는다(그 축만 밴딧/기본값으로 떨어진다).
  //      · 축 목록을 `AXES` 에서 **읽는다** — 손으로 적으면 축이 하나 늘 때 조용히 빠진다.
  //    그 대가로 아래 `placeRoles` 가 넘기는 객체는 우리가 만든 평범한 객체다 — 펴도 안전하다.
  const rawDecisions = options.decisions !== null && typeof options.decisions === 'object' ? options.decisions : {};
  const callerArm = (axis) => {
    try {
      const value = rawDecisions[axis];
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  };
  /** 이 실행이 **실제로** 쓰는 네 팔. `decide()` 뒤에 빈 축이 채워진다. */
  const decisions = {};
  for (const axis of Object.keys(AXES)) {
    const arm = callerArm(axis);
    if (arm !== undefined) decisions[axis] = arm;
  }
  /** 축마다 그 팔이 어디서 왔나 — `'caller'` · `'bandit'` · `'default'`. */
  const sources = {};
  for (const axis of Object.keys(decisions)) sources[axis] = 'caller';

  // 기본 배치는 위 결정이 정한다 — 이 파일은 벤더 이름을 알면 안 된다(contract.mjs).
  // 호출자가 역할에 벤더 id 를 직접 적으면 그쪽이 이긴다: 팔은 "어느 쪽이 앞이냐" 만 말하고
  // id 는 "바로 이 벤더" 라 더 구체적인 채널이다(`deps` 보다 `deps.X` 가 이기는 것과 같은 축).
  const pick = (wanted, fallback) => {
    if (wanted === undefined || wanted === null) return { provider: fallback };
    const found = providers.find((p) => p?.id === wanted);
    return found ? { provider: found } : { unknown: wanted };
  };
  /**
   * placement 팔 하나에 대한 **최종** 배치. §7.2 결정③ WIDE 가 스텝마다 다시 부른다.
   *
   * ★ 역할 오버라이드를 여기 안에 둔다. 밖에 두면 스텝마다 우선순위가 달라질 수 있고, 그러면
   *   "id 가 팔을 이긴다" 가 첫 스텝에서만 참인 규칙이 된다.
   * ★ `decisions` 를 **펴지 않고** 프로토타입으로 얹는다. 두 가지를 함께 지키기 위해서다:
   *     · `assignRoles` 가 나중에 다른 축을 보게 되어도 그 값이 스텝마다 사라지지 않는다
   *       (`{ mix: decisions.mix, placement }` 로 축을 손으로 적으면 조용히 빠진다).
   *     · 축과 **무관한** 속성을 읽지 않는다. 폈더니 결정 객체의 own 속성을 전부 읽어서,
   *       `{ rewrite:'deep', get zzz() { throw } }` 하나로 실행이 succeeded → failed 로
   *       뒤집혔다(실측). 이 파일은 그 게터가 없던 계획 2 에서 안 읽던 자리다.
   *       ☞ 그 위험의 1차 방어선은 이제 위의 `callerArm` 이다(호출자 객체를 아예 안 들고
   *         다닌다). 여기 프로토타입 얹기는 그대로 둔다 — 지워서 죽는 뮤턴트가 늘지 않고,
   *         `decisions` 를 나중에 누가 다시 호출자 객체로 되돌려도 이 자리는 안 무너진다.
   * ⚠ 그 대가로 이 객체는 own 속성이 `placement` 하나다. 펴거나 직렬화하면(`{...obj}` ·
   *   `Object.entries` · `JSON.stringify` · `structuredClone`) `mix`·`tier`·`rewrite` 가
   *   전부 사라진다 — 실측: `{...Object.create({mix:'single'},{placement:{value:'codex>claude',
   *   enumerable:true}})}` 는 `{placement:'codex>claude'}` 뿐이다. **속성 접근**으로 읽는
   *   소비자(`assignRoles`)에게만 넘겨라. 저널·로깅에는 원본 `decisions` 를 써라.
   */
  const placeRoles = (placement) => {
    const roles = assignRoles(providers, Object.create(decisions, { placement: { value: placement, enumerable: true } }));
    return {
      planner: pick(options.planner, roles.planner),
      worker: pick(options.worker, roles.worker),
      verifier: pick(options.verifier, roles.verifier),
    };
  };
  // 이 실행이 **시작하는** 배치. WIDE 는 여기서 출발해 실패할 때마다 뒤집는다.
  //
  // ★ `let` 이다. 여기 값은 **호출자가 적은 것만** 반영한 잠정 배치이고, 밴딧이 빈 축을
  //   채운 뒤(`decide` 는 `deriveTestCommand` 뒤에 돈다 — `classifyTask` 가 테스트 소스를
  //   봐야 하기 때문이다) 다시 계산한다. 그 사이에 나가는 봉투(사전 점검 blocked ·
  //   워크트리 blocked)는 결정을 한 적이 없는 실행이므로 이 잠정 배치가 그 봉투의 사실이다.
  let basePlacement = decisions.placement;
  let chosen = placeRoles(basePlacement);
  for (const [role, result] of Object.entries(chosen)) {
    if (result.unknown !== undefined) {
      return failure({
        status: 'invalid',
        error: `모르는 프로바이더 id 입니다 (${role}): ${show(result.unknown)}`,
        recovery: `쓸 수 있는 프로바이더: ${ids.join(', ')}`,
      });
    }
  }

  // 호출자가 준(또는 `BOM_ORCH_HOME` 에 적힌) 문자열 그대로다. `createWorktree` 에 넘기는
  // 것 말고는 쓰지 않는다 — 그 뒤로는 아래 `runStateRoot` 하나만 쓴다.
  const stateRoot =
    typeof deps.stateRoot === 'string' && deps.stateRoot !== '' ? deps.stateRoot : resolveStateRoot();
  const runId =
    typeof deps.runId === 'string' && RUN_ID_PATTERN.test(deps.runId) ? deps.runId : makeRunId();

  const inspectRepo = deps.inspectRepo ?? defaultInspectRepo;
  const createWorktree = deps.createWorktree ?? defaultCreateWorktree;
  const snapshotStep = deps.snapshotStep ?? defaultSnapshotStep;
  const collectPatch = deps.collectPatch ?? defaultCollectPatch;
  const removeWorktree = deps.removeWorktree ?? defaultRemoveWorktree;
  const deriveTestCommand = deps.deriveTestCommand ?? defaultDeriveTestCommand;
  const runTests = deps.runTests ?? defaultRunTests;
  const inspectPatch = deps.inspectPatch ?? defaultInspectPatch;
  const trackChild = deps.trackChild ?? defaultTrackChild;
  const trackWorktree = deps.trackWorktree ?? defaultTrackWorktree;
  const listIgnoredPaths = deps.listIgnoredPaths ?? defaultListIgnoredPaths;
  const treeKill = deps.treeKill ?? defaultTreeKill;
  const readSettings = deps.readSettings ?? defaultReadSettings;
  const readPosteriors = deps.readPosteriors ?? defaultReadPosteriors;
  const updatePosterior = deps.updatePosterior ?? defaultUpdatePosterior;
  const appendRun = deps.appendRun ?? defaultAppendRun;
  const commitLearningMutation = deps.commitLearningMutation ?? defaultCommitLearningMutation;
  // Existing dependency seams are intentionally retained for focused legacy
  // tests/integrations.  The real production path below takes one WAL-backed
  // operation instead of independently updating four cells then appending.
  const legacyLearningSeams = Object.hasOwn(deps, 'updatePosterior') || Object.hasOwn(deps, 'appendRun');
  const learningOperationOptions = deps.learningOperationOptions;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  /**
   * 밴딧에게 넘길 주사위. **명시적으로 넘긴다.**
   *
   * ★ 안 넘기면 `decide` 가 `Math.random` 으로 조용히 떨어져 엔진이 재현 불가가 되고, 그
   *   폴백을 타는 테스트가 하나도 없어 **아무것도 안 붉어진다**(태스크 5 가 자기 모듈에서
   *   같은 구멍을 실측했다). 아래 `학습: 결정` 블록이 이 값을 `decide` 에 넘긴다.
   *
   * ★ `options.random` 이 아니라 `deps.random` 이다. 최상위 옵션은 §8.2 의 호출자 어휘
   *   (`task`·`budget`·`wait_ms`…)이고 주입 자리는 전부 `deps` 다(`deps.now` 와 같은 축).
   *   `orch_run` 은 이 값을 만들지 않으므로 최상위에 두면 도구 스키마에 없는 옵션이
   *   계약 주석에만 사는 유령이 된다.
   */
  const random = typeof deps.random === 'function' ? deps.random : Math.random;

  // ── 데드라인: 정지의 유일한 권위 (§11.1) ────────────────────────────────
  //
  // MCP 취소는 협조적이라 못 믿는다. 상한 처리는 `timeoutSignal` 이 한다 — 손으로 하면
  // 계획 1 의 Critical 이 돌아온다(2^31~2^32-1 구간이 delay 를 1ms 로 깎아 **긴 데드라인이
  // 즉시 중단으로 뒤집혔다**).
  // ★★ **항상** 데드라인이 있다. `waitMs: 0` 은 "호출자가 상한을 정하지 않는다" 이지
  //    "정지 권위가 없다" 가 아니다 — 그 둘을 같게 두면 기본값에 권위가 없다.
  const effectiveWaitMs = waitMs > 0 ? Math.min(waitMs, MAX_WAIT_MS) : MAX_WAIT_MS;
  const deadline = timeoutSignal(effectiveWaitMs);
  const aborted = () => deadline?.aborted === true;

  /**
   * 단계 하나를 데드라인 뒤 유예와 경주시킨다. 유예를 다 쓰면 `HARD_STOP` 을 낸다.
   *
   * 프로바이더는 주입받는 자리라 하드 못이 없는 구현이 들어올 수 있고, 진짜 프로바이더
   * 에서도 reparent 된 손자는 트리 킬로 안 잡힌다. 봉투가 나가는 것을 보장하는 마지막 자리다.
   *
   * ★ 유예는 **매달린 단계마다** 한 번씩 쓴다(실행 전체에 한 번이 아니다). 전체에 한 번으로
   *   묶어 봤더니 첫 하드 못 이후의 마무리 단계가 전부 즉시 단락됐다 — 패치 수집도 워크트리
   *   회수도 못 하고 나가서, "고아 워크트리를 남기지 않는다" 와 "작업을 버리지 않는다" 를
   *   둘 다 어겼다. 대신 이 값이 곱해지는 횟수를 경로 구조가 묶는다: 스텝 루프는 데드라인
   *   뒤 한 스텝만 더 지나고(스텝마다 abort 를 본다), 매달린 단계는 blocker 로 루프를 끊는다.
   */
  const hardStopGraceMs =
    Number.isFinite(deps.hardStopGraceMs) && deps.hardStopGraceMs > 0 ? deps.hardStopGraceMs : HARD_STOP_GRACE_MS;
  const raceHardStop = (work) => {
    if (deadline === undefined) return work;
    let timer = null;
    let arm = null;
    const guard = new Promise((resolve) => {
      arm = () => {
        if (timer === null) timer = setTimeout(() => resolve(HARD_STOP), hardStopGraceMs);
        timer?.unref?.();
      };
      if (deadline.aborted) arm();
      else deadline.addEventListener('abort', arm, { once: true });
    });
    return Promise.race([work, guard]).finally(() => {
      clearTimeout(timer);
      try {
        deadline.removeEventListener?.('abort', arm);
      } catch {
        // 뗄 수 없으면 그냥 둔다.
      }
    });
  };

  // 우리가 띄운 자식들. 데드라인이 발동하면 트리 킬한다 — `kill()` 만으로는 손자가 남는다.
  //
  // ★ 같은 pid 를 두 번 끊지 않는다. 데드라인에 이미 보낸 pid 에 finally 가 한 번 더
  //   보내면, 그 사이에 OS 가 pid 를 재사용했을 때 **무관한 프로세스**를 끊는다
  //   (`src/reaper.mjs` 가 pid 재사용 방어를 두는 것과 같은 축이다).
  const liveChildren = new Map();
  const killedPids = new Set();
  const killTree = (pid) => {
    if (killedPids.has(pid)) return undefined;
    killedPids.add(pid);
    try {
      const killed = treeKill(pid);
      if (killed && typeof killed.then === 'function') return Promise.resolve(killed).catch(() => false);
      return Promise.resolve(killed);
    } catch {
      // 끊지 못해도 봉투는 나가야 한다.
      return Promise.resolve(false);
    }
  };
  const onDeadlineAbort = () => {
    for (const pid of liveChildren.keys()) killTree(pid);
  };
  /** 남은 자식을 끊고 **끝날 때까지 기다린다**. 절대 던지지 않는다. */
  const killLiveChildren = async () => {
    const pending = [];
    for (const pid of liveChildren.keys()) {
      const killed = killTree(pid);
      if (killed !== undefined) pending.push(killed);
    }
    if (pending.length > 0) await Promise.allSettled(pending);
  };
  deadline?.addEventListener('abort', onDeadlineAbort, { once: true });

  // ★ I-1. `notice` 는 "당신이 기대한 격리가 실제로는 적용되지 않았다" 를 말하는 유일한
  //   채널이다(codex 워커의 셸 · 베리파이어 몰래 고치기 · scratch 정리 · 워크트리 회수 실패).
  //   예전에는 정상 종료와 데드라인 두 경로에만 실렸고 blocked·failed 다섯 경로에서는
  //   통째로 사라졌다 — blocked 는 러너 거부·패치 실패처럼 **흔한** 경로다.
  //   그래서 봉투를 내는 자리를 하나로 묶고 모든 return 이 여기를 지나게 한다.
  //
  // ★ M-6. 같은 문장을 스텝마다 쌓지 않는다. 프로바이더의 notice 는 매 호출 같은 값이고
  //   (`sandboxNotice`·`toolSetNotice`), `notice` 는 봉투가 자르지 않는 필드라 budget=10
  //   이면 같은 경고가 1,800자가 된다 — 서로 다른 경고가 그 반복문 속에 묻힌다.
  //
  // ★ I-1(이번 라운드). 개별·합계 상한을 여기서 건다 — `notice` 는 봉투가 자르지 않는
  //   필드이고, 그 안에 박히는 목록의 길이를 정하는 쪽이 델리게이트다.
  const notices = [];
  const addNotice = (text) => {
    if (typeof text !== 'string' || text === '') return;
    const one = clip(text, NOTICE_CHARS);
    if (!notices.includes(one)) notices.push(one);
  };
  /**
   * **접히면 안 되는** notice. 교차검증 문장 바로 뒤, 나머지 앞에 붙는다.
   *
   * ★ 왜 따로 두는가(실측): `joinNotices` 는 합계 상한을 넘으면 **뒤부터** 접는다. 학습
   *   실패를 보통 큐에 넣고 시끄러운 실행(budget 10 · 프로바이더가 스텝마다 200자 notice)을
   *   재 봤더니 `★저널실패★`·`★갱신실패★` 가 **둘 다 통째로 사라지고** 「그 밖에 알림 21건이
   *   더 있어 접었습니다」만 남았다. 그 문장들이 말하는 것은 "이 실행의 학습이 통째로
   *   날아갔다" 이고, 그것은 프로바이더의 반복 경고보다 뒤로 밀릴 사실이 아니다 —
   *   `crossCheckLines` 를 목록 앞에 붙이는 것과 같은 근거다.
   *
   * 여기 들어가는 것은 **이상 신호**뿐이다(못 읽음 · 못 씀 · 격리 · 하한 · 잠금 잔여).
   * "이 실행은 배울 축이 없다" 같은 정상 설명은 보통 큐로 간다.
   */
  const leadNotices = [];
  const addLeadNotice = (text) => {
    if (typeof text !== 'string' || text === '') return;
    const one = clip(text, NOTICE_CHARS);
    if (!leadNotices.includes(one)) leadNotices.push(one);
  };
  // 세는 것은 항목 수가 아니라 **서로 다른 벤더 수**다(위 `crossCheckNotice` 의 두 번째 ★).
  const vendorCount = new Set(ids).size;

  // 스텝 루프의 기록. 루프보다 훨씬 위에 두는 이유는 아래 `crossCheckLines` 가 **봉투를 낼 때**
  // 이 둘을 읽어야 하기 때문이다 — 루프에 못 들어간 봉투는 둘 다 0 이다.
  const steps = [];
  /**
   * 워커와 베리파이어가 **같은 벤더**였던 스텝의 수.
   *
   * ★ 항목이 아니라 **id** 로 센다 — `crossCheckNotice` 의 두 번째 ★ 와 같은 기준이다.
   */
  let singleVendorSteps = 0;

  /**
   * 이 실행의 교차검증 사실을 **봉투를 낼 때** 문장으로 만든다. 목록의 **맨 앞**에 붙는다.
   *
   * ★ 왜 루프 앞에서 미리 `addNotice` 하지 않나(2차 수정). 루프 앞에서 낼 수 있는 판정은
   *   **시작 배치**의 것뿐인데, WIDE 아래에서 시작 배치는 실행 단위 사실이 아니라 1 스텝의
   *   사실이다. 그래서 못 박은 역할이 시작 배치의 상대와 같은 벤더면 실행 단위 문장이
   *   거짓으로 실렸고, 그 위에 스텝 단위 문장이 **정반대 내용으로** 겹쳤다(실측: `wide` +
   *   budget 3 + 매 스텝 실패에서 `verifier:'alpha'` 는 워커 `[alpha,beta,alpha]` /
   *   베리파이어 `[alpha,alpha,alpha]`, `worker:'beta'` 는 워커 `[beta,beta,beta]` /
   *   베리파이어 `[beta,alpha,beta]` — 둘 다 한 봉투가 「이 실행이 한 벤더만 쓰도록
   *   정해졌습니다」와 「일부 스텝만 그랬다」를 나란히 실었다. 역할 하나를 못 박는 네 조합 중
   *   둘이다 — 이 수는 **기본 placement** 기준이다. `placement:'codex>claude'` 로 두면
   *   겹치는 쌍이 반대 둘(`worker:'alpha'`·`verifier:'beta'`)이 된다(실측: 그 배치에서
   *   `worker:'alpha'` 는 워커 `[alpha,alpha,alpha]` / 베리파이어 `[alpha,beta,alpha]`,
   *   `verifier:'beta'` 는 워커 `[beta,alpha,beta]` / 베리파이어 `[beta,beta,beta]` — 시작
   *   스텝이 같은 벤더라 겹친다. 반대로 기본에서 겹치던 `verifier:'alpha'`·`worker:'beta'` 는
   *   그 배치에서는 시작 스텝부터 다른 벤더라 안 겹친다). 여기서 한 번에 고르면 두 문장이
   *   배타가 된다.
   *
   * ★ 스텝 0 개 봉투에서 문장이 사라지면 안 된다. 워크트리 blocked 처럼 배치는 정해졌는데
   *   프로바이더를 하나도 안 띄운 봉투가 그렇다(실측: 그 갈래는 프로바이더 호출 0회). 그
   *   자리에서 말할 수 있는 유일한 사실이 시작 배치라 그때는 그대로 쓴다.
   *   이 함수 **앞**에서, **이 함수(`orchestrate`) 안에서** 봉투를 내는 자리는 일곱이고
   *   (실측: 인자 검증 다섯 — task·projectPath·isolation·budget·waitMs — 에 프로바이더 0개
   *   blocked 와 모르는 프로바이더 id invalid) 거기에는 `seal` 을 안 지나므로 실리지 않는다.
   *   `runOrchestration` 이 인자 자체가 객체가 아니라고 거부하는 자리는 이 함수 진입 전이라
   *   이 셈에 넣지 않았다. 전부 배치가 정해지기 전이라 신고할 배치 자체가 없다. 이 수를
   *   고정하는 테스트는 없다 — 인자 가드가 하나 늘면 이 주석은 조용히 낡을 수 있다.
   *
   * ★ 스텝이 하나라도 돌면 실행 단위 판정을 `singleVendorSteps === steps.length` 로 다시
   *   낸다. 1 스텝은 시작 배치 그대로 도므로(`placement` 의 초기값이 `basePlacement`) 이
   *   갈래의 `crossCheckNotice` 는 그 1 스텝의 사실과 어긋나지 않는다.
   *
   * ★ 목록 **앞**에 붙이는 이유. `joinNotices` 는 합계 상한을 넘으면 **뒤부터** 접는다.
   *   루프 뒤에서 `addNotice` 로 밀어 넣었더니 큐 맨 뒤라 가장 먼저 접혔다(실측: 프로바이더
   *   호출마다 380자 notice · budget 5 → 스텝 단위 문장이 통째로 사라지고 프로바이더
   *   notice 넷(001~004) + 「그 밖에 알림 10건이 더 있어 접었습니다」가 남았다 — 그 봉투에
   *   프로바이더 notice 가 전혀 없었던 것은 아니다). 이 문장은 "당신이 기대한 교차검증이
   *   실제로는 없었다" 를 말하는 유일한 채널이라 접히면 없는 것과 같다.
   */
  const crossCheckLines = () => {
    const startPlacement = crossCheckNotice(chosen.worker.provider, chosen.verifier.provider, vendorCount);
    if (steps.length === 0 || singleVendorSteps === steps.length) {
      return startPlacement === null ? [] : [clip(startPlacement, NOTICE_CHARS)];
    }
    if (singleVendorSteps === 0) return [];
    // ★ 원인을 지목하지 않는다. 「역할 지정이 남아서」라고 적었더니 `mix:'single'` +
    //   역할 오버라이드에서 거짓이 됐다(실측: `mix:'single'` + `verifier:'beta'` + wide +
    //   budget 3 은 워커 `[alpha,beta,alpha]` / 베리파이어 `[beta,beta,beta]` 인데, 그 실행은
    //   실제로 single 로 정해졌고 오버라이드가 그것을 깼다). 처방도 적지 않는다 — 같은 실측에서
    //   「역할 지정을 빼세요」는 mix:single 조합에서 오히려 교차검증을 없애는 조언이었다.
    //
    // ★ 과거형("…였습니다")을 쓰지 않는다. `singleVendorSteps` 는 스텝이 시작할 때 **배치
    //   기준**으로 세고(위 루프의 `active.worker.provider.id === active.verifier.provider?.id`),
    //   베리파이어가 실제로 돌았는지는 안 본다. 중간에 끊긴 스텝(예: `runTests` blocked)은
    //   `record.verifier` 가 content 에 아예 없는데도 이 셈에는 들어가 있다(실측:
    //   `worker:'beta'` + wide + budget 3, 3번째 `runTests` 를 blocked → `status:'blocked'`,
    //   notice 「3 스텝 중 2 스텝」, content 의 step3 은 `worker.provider:'beta'` 뿐이고
    //   `verifier` 필드가 없다). 그래서 "같은 벤더였습니다"(과거형) 가 아니라 "같은 벤더로
    //   배치됐습니다"(배치 서술)로 쓴다 — `crossCheckNotice` 의 같은 원칙과 맞춘다.
    return [
      clip(
        `${steps.length} 스텝 중 ${singleVendorSteps} 스텝이 교차검증 없이 한 벤더로 돌았습니다 — ` +
          '그 스텝은 워커와 베리파이어가 같은 벤더로 배치됐습니다. 스텝마다 배치가 달라졌습니다 — ' +
          '어느 스텝이 그랬는지는 content 의 steps[].worker.provider·verifier.provider 로 확인하세요 ' +
          '(끊긴 스텝은 verifier 기록이 없을 수 있습니다).',
        NOTICE_CHARS,
      ),
    ];
  };

  /** 모든 봉투가 지나는 자리. notice·runId·stopReason 을 빠짐없이 싣는다. */
  const seal = (envelope, stopReason) => {
    const notice = joinNotices([...crossCheckLines(), ...leadNotices, ...notices]);
    return {
      ...envelope,
      runId,
      // status 만 보는 통합 패턴이 "통과"·"실패"·"못 돌림"·"정의 위조" 를 구분할 수 있어야 한다.
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(notice !== undefined ? { notice } : {}),
    };
  };
  const progress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const emit = (event) => {
    if (progress === null) return;
    try {
      progress(event);
    } catch {
      // 진행 알림은 부가 기능이다. 호출부의 버그가 이미 돌고 있는 델리게이트를 죽이면 안 된다.
    }
  };
  const phaseStart = (phase, step) => emit({ phase, step, runId, event: { type: 'phase', phase } });

  const hardStopNotice = (label) =>
    `${label} 단계가 데드라인 뒤 ${hardStopGraceMs}ms 안에 끝나지 않아 기다리지 않고 나왔습니다 — ` +
    '그 단계의 프로세스가 워크트리 안에 남아 있을 수 있습니다.';

  /**
   * 프로바이더가 아닌 이음매(git·러너·스코프) 하나를 하드 못과 경주시킨다.
   *
   * ★ 왜 프로바이더만으로는 부족한가(실측): 하드 못이 프로바이더 호출 한 축에만 걸려 있을
   *   때, 나머지 일곱 이음매를 하나씩 영영 pending 으로 두면 봉투가 6초 안에 아예 나오지
   *   않았다. 기본 구현들은 각자 상한이 있지만(러너·git·워크트리 계열) 그 값의 합은
   *   데드라인과 무관하고, 이 자리들은 전부 **주입**받는 자리이기도 하다.
   *
   * 못이 이기면 그 자리가 이미 다루는 `{ blocked: true }` 모양으로 번역한다.
   *
   * 이음매를 **콜백으로** 받는다 — 주입된 구현이 동기로 던지면 프라미스 밖으로 새서 경주가
   * 아니라 예외가 된다.
   */
  const stage = async (label, call) => {
    const result = await raceHardStop((async () => call())());
    if (result !== HARD_STOP) return result;
    addNotice(hardStopNotice(label));
    return {
      blocked: true,
      error: `${label} 단계가 데드라인 뒤에도 끝나지 않았습니다.`,
      recovery: 'wait_ms 를 늘리거나 대상 저장소의 크기·상태를 확인하세요.',
    };
  };

  // 자식 등록 (배선 숙제 1). 지금까지 `src/` 에 `trackChild` 호출부가 0곳이었다 —
  // 그래서 강제 종료 뒤 테스트 자식·벤더 CLI 자식이 어떤 경로로도 회수되지 않았다.
  //
  // ★ `runStateRoot` 는 `createWorktree` 가 실체 경로로 편 상태 루트다. 워크트리가 생긴
  //   뒤의 모든 상태 루트 사용(원장·plans·patches·settings)이 이 값 하나를 쓴다 — 편 값과
  //   안 편 값을 섞어 쓰면 리퍼의 경로 판정이 갈려 고아 워크트리를 못 지운다.
  let runStateRoot = stateRoot;
  let worktreePath = null;
  const register = (child) => {
    try {
      const pid = child?.pid;
      if (Number.isInteger(pid) && pid > 0) {
        liveChildren.set(pid, child);
        try {
          child.on?.('exit', () => liveChildren.delete(pid));
        } catch {
          // 'exit' 을 못 붙이면 데드라인 때 이미 죽은 pid 에 트리 킬을 한 번 더 보낼 뿐이다.
        }
      }
      // ⚠ 리퍼는 자식 env 를 읽지 않는다. 소유권은 원장의 pid+startTime+ownerPid 로만
      //   판정하고 runId 는 여기 **인자**로 들어간다.
      const tracked = trackChild({ stateRoot: runStateRoot, child, runId, worktree: worktreePath });
      if (tracked && typeof tracked.catch === 'function') tracked.catch(() => {});
    } catch {
      // 원장은 최선의 노력이다. 여기서 던지면 이미 도는 델리게이트가 죽는다.
    }
  };

  /** 프로바이더를 한 번 부른다. 계약상 던지지 않지만 강제되지는 않으므로 감싼다. */
  const callProvider = async ({ provider, role, phase, step, workspace, instruction, tools, tier }) => {
    phaseStart(phase, step);
    const selection = resolveTier(tier.settings, provider.id, tier.name);
    try {
      const result = await raceHardStop(provider.run({
        role,
        model: selection.model,
        effort: selection.effort,
        instruction,
        workspace,
        tools,
        // 실측으로 강제되지 않는 채널이지만, 넘기는 것이 그 벤더의 기본값보다는 좁다.
        allowedTools: tools,
        signal: deadline,
        onProgress: (event) => emit({ phase, step, runId, event }),
        onSpawn: register,
        runId,
      }));
      if (result === HARD_STOP) {
        addNotice(hardStopNotice(phase));
        return { content: '', truncated: true, notice: null, hardStopped: true, error: `${phase} 단계가 데드라인 뒤에도 끝나지 않았습니다.` };
      }
      if (result === null || typeof result !== 'object') {
        return { content: '', truncated: true, notice: null, error: '프로바이더가 알 수 없는 응답을 냈습니다.' };
      }
      return result;
    } catch (error) {
      return {
        content: '',
        truncated: true,
        notice: null,
        error: `프로바이더가 던졌습니다: ${safeText(error)}`,
        recovery: '해당 벤더 CLI 의 설치 상태를 확인하세요.',
      };
    }
  };

  // ── 저장소 사전 점검 ────────────────────────────────────────────────────
  //
  // ★★ 계획 2 Task 1 이 만든 검사인데 `src/` 안의 호출부가 0곳이었다. 그래서 두 가지가
  //    프로덕션에서 죽어 있었다: 커밋 0개(또는 unborn 브랜치) 저장소는 `git worktree add` 의
  //    `fatal: invalid reference: HEAD` 라는 일반 오류로만 죽었고 — 그 사전 점검이 존재하는
  //    이유가 정확히 그 실패를 막는 것이다 — git 버전 하한(CVE-2024-32002) 검사는 어디서도
  //    발화하지 않았다. 여기가 그 유일한 발화 지점이다.
  //
  //    `choices` 가 실려 오면 그대로 봉투에 올린다. 무엇을 할지 호출자(모델)가 고르는
  //    상태이므로 선택지를 삼키면 그 봉투는 막다른 길이 된다.
  phaseStart('inspect', 0);
  const inspected = await stage('저장소 사전 점검', () => inspectRepo(projectPath));
  if (isBlocked(inspected)) {
    return seal(
      failure({
        status: 'blocked',
        error: inspected.error,
        recovery: inspected.recovery ?? GENERIC_RECOVERY,
        ...(Array.isArray(inspected.choices) ? { choices: inspected.choices } : {}),
      }),
      'blocked',
    );
  }

  // ── 워크트리 ────────────────────────────────────────────────────────────
  //
  // 플래너보다 **먼저** 만든다. 상태 루트가 대상 저장소 안인지 같은 확인을 `createWorktree`
  // 가 fail-closed 로 하고, 그 확인이 지나야 플래너의 일회용 디렉터리를 상태 루트 아래
  // (= 사용자 저장소 밖)에 만들 수 있다.
  phaseStart('worktree', 0);
  const worktree = await createWorktree({ projectPath, stateRoot, runId });
  if (isBlocked(worktree)) {
    return seal(
      failure({ status: 'blocked', error: worktree.error, recovery: worktree.recovery ?? GENERIC_RECOVERY }),
      'blocked',
    );
  }
  worktreePath = worktree.path;
  runStateRoot = worktree.stateRoot;

  // ── 오래된 scratch 잔재 (배선 숙제 6) ───────────────────────────────────
  //
  // 함수 자체는 `src/reaper.mjs` 에 있고 부팅 스윕도 같은 것을 부른다(계획 2 이월 1).
  // **여기를 지우면 안 된다**: 부팅은 며칠에 한 번인데 잔재는 실행마다 생길 수 있어,
  // 장수 서버에서는 부팅 스윕만으로 6시간 잔재가 영영 안 지워진다.
  //
  // ★ **`createWorktree` 뒤**다. 앞에 두었을 때 무슨 일이 났나(실측): 상태 루트를 저장소
  //   안(`<project>/.bom-orch`)으로 잡으면 `createWorktree` 가 fail-closed 로 거부하는데,
  //   그 거부 **전에** sweep 이 이미 파일을 지웠다 — 엔진이 "쓸 수 없다" 고 말한 디렉터리
  //   에서 되돌릴 수 없는 삭제를 먼저 한 것이다. 경로도 미검증 원시 문자열이었다.
  //   여기서는 `createWorktree` 가 검증하고 실체 경로로 편 값을 쓴다.
  const scratch = await sweepScratch(runStateRoot, nowMs);
  if (scratch.removed > 0) {
    addNotice(
      `상태 루트의 scratch 에서 오래된 잔재 ${scratch.removed}개를 지웠습니다 — 강제 종료된 실행이 남긴 ` +
        '임시 인덱스·state 패치이고, 거기에는 사용자의 미커밋 내용이 평문으로 들어 있습니다.',
    );
  }

  // ── patches 보존 정책 (계획 2 이월 2) ───────────────────────────────────
  //
  // 같은 자리에서 같은 이유로 돈다. **부팅 스윕에도 있지만 여기가 필요하다** — 장수
  // 서버에서는 실행 사이에 쌓인 패치를 이 실행의 봉투로 바로 알려야 한다.
  // 이 실행의 패치는 아래 `collectPatch` 뒤에 쓰므로 여기서는 아직 없다.
  const sweptPatches = await sweepPatches(runStateRoot, nowMs);
  if (sweptPatches.removed > 0) {
    addNotice(
      `상태 루트의 patches 에서 30일이 지난 패치 ${sweptPatches.removed}개를 지웠습니다 — 그 파일에는 ` +
        '델리게이트가 만든 소스가 평문으로 들어 있고, 보존 정책 없이는 무한히 쌓입니다.',
    );
  }

  // ★ 저널은 `patches/` 와 **같은 방식으로 다룰 수 없다** — 전부 한 파일이라 지우면 학습
  //   이력이 통째로 날아간다(`src/learn/journal.mjs` 의 같은 문단). 크기만 알린다.
  const journalSize = await journalBytes(runStateRoot);
  if (typeof journalSize === 'number' && journalSize > JOURNAL_LARGE_BYTES) {
    addNotice(
      `실행 저널이 커졌습니다: ${Math.round(journalSize / (1024 * 1024))}MB (임계 ` +
        `${JOURNAL_LARGE_BYTES / (1024 * 1024)}MB). 이 파일은 자동으로 잘리지 않습니다 — 잘라내면 ` +
        '사후분포에 남은 기여와 어긋나기 때문입니다. 필요하면 사용자가 직접 보관하고 비우세요.',
    );
  }

  // 앞선 실행이 남긴 등록 잔재. 우리 워크트리는 방금 만들어져 살아 있으므로 대상이 아니다.
  const reclaimed = await reclaimOrphanRegistrations({
    run: deps.runGit ?? defaultRunGit,
    projectPath: worktree.projectPath,
    stateRoot: runStateRoot,
  });
  if (reclaimed.reclaimed > 0) {
    addNotice(
      `앞선 실행이 남긴 죽은 워크트리 등록 ${reclaimed.reclaimed}개를 회수했습니다 — 리퍼는 디렉터리만 지우고 ` +
        '등록 해제를 하지 않습니다.',
    );
  }

  const planDir = join(runStateRoot, 'plans', runId);
  // `keepWorktree` = 회수하면 안 된다(작업을 못 꺼냈다). `released` = 회수 절차를 이미 지났다.
  let keepWorktree = false;
  let released = false;

  // ★ C1. 스코프 사실을 담는 자리를 반환 경로 **밖**에 둔다. 예전에는 이 계산이 마지막 세
  //   반환 경로 앞에만 있어서, 그보다 먼저 나가는 조기 return 두 개가 스코프 판정·워크트리
  //   회수 관측·원장·notice 를 한꺼번에 건너뛰었다 — 그 봉투는 "패치는 파일로 남겼습니다" 라고
  //   권하면서 그 패치가 `.github/workflows` 를 건드린다는 사실을 한 글자도 안 실었다.
  //   반환 경로는 앞으로도 늘어난다. 그래서 붙이는 자리를 `sealFailure` 하나로 둔다.
  let scopeConfidence = null;
  let scopeRecovery = null;
  let scopeFlagged = false;
  let scopeReasons = [];
  /**
   * 최종 패치가 비었나. `null` 은 "아직 패치를 수집하지 않았다".
   *
   * ★ `gradeOfRun` 이 이 값을 읽는다. 지역 변수로 두고 인자로 넘기지 않는 이유는 등급을 매기는
   *   자리가 둘(정상 경로와 `sealFailure`)이라, 인자로 넘기면 한쪽이 조용히 `undefined` 를
   *   넘기는 날 "빈 패치인데 α" 가 된다. 패치를 수집한 순간 여기에 적으면 두 자리가 같은 사실을 본다.
   */
  let patchEmpty = null;
  const noteScope = (result) => {
    scopeFlagged = true;
    scopeConfidence = result.confidence ?? 'disputed';
    scopeRecovery = result.recovery ?? GENERIC_RECOVERY;
    scopeReasons = Array.isArray(result.reasons) ? result.reasons : [];
  };

  /**
   * 워크트리 회수 + 실패 관측 + 원장. **모든** 종료가 여기를 지난다. 두 번 돌지 않는다 —
   * 두 번 지우면 봉투의 `removed`/`unregistered` 관측이 사실과 달라진다.
   *
   * `keepWorktree === true` 인 경로(패치를 못 뽑았다 · 우리 버그)는 회수를 건너뛴다. 지우면
   * 델리게이트의 작업이 통째로 사라지기 때문이다 — 그 경로는 대신 봉투에 경로를 싣는다.
   */
  const release = async () => {
    if (released) return;
    released = true;
    // ★ 자식을 **먼저** 끊고 끝날 때까지 기다린다. 러너가 방금 "남은 프로세스가 있다" 고
    //   신고했는데 그것을 쥔 채 `worktree remove` 를 먼저 시도하면, 우리 자신의 notice 가
    //   말하는 그 이유로 실패한다.
    await killLiveChildren();
    if (keepWorktree) return;
    const removal = await stage('워크트리 회수', () => removeWorktree(worktree)).catch((error) => ({
      blocked: true,
      error: safeText(error),
    }));
    if (isBlocked(removal) || removal?.removed === false || removal?.unregistered === false) {
      addNotice(
        `워크트리를 완전히 회수하지 못했습니다: ${worktree.path} — 남은 프로세스가 파일을 쥐고 있을 수 있습니다.`,
      );
      // ★★ 회수 못 한 워크트리는 리퍼의 **두 경로 모두**에 안 보인다: 등록 회수는
      //    `prunable` 만 보는데 이 등록은 살아 있고, 원장 기록은 자식이 죽는 순간 지워진다.
      //    남는 것은 사용자 저장소의 완전한 사본(이식된 미커밋 내용 포함)이다. 그래서
      //    **워크트리 자체를 가리키는 기록**을 원장에 남겨 다음 부팅의 스윕이 보게 한다.
      await Promise.resolve(
        trackWorktree({ stateRoot: runStateRoot, runId, worktree: worktree.path }),
      ).catch(() => {});
    }
  };

  // ── §7 학습: 이 실행분의 상태 ───────────────────────────────────────────
  //
  // `try` 블록 **밖**에 둔다 — `sealFailure` 가 읽어야 하는데 그쪽이 더 위에 있다.
  /**
   * `decide()` 를 지난 실행만 값이 있다. `null` 이면 결정을 한 적이 없으므로 기록할 것도 없다
   * (사전 점검 blocked · 워크트리 blocked · 그 사이에 던진 우리 버그).
   */
  let learning = null;
  /** 사후분포·저널을 두 번 쓰지 않는다. 정상 경로와 `sealFailure` 가 둘 다 부를 수 있다. */
  let learningRecorded = false;

  /** `{ok:false}` 봉투든 하드 못 봉투든 사람이 읽을 사유 하나를 뽑는다. */
  const reasonOf = (result) =>
    safeText(result?.reason ?? result?.error ?? '사유를 받지 못했습니다.');

  /**
   * 봉투 content 에 실을 학습 사실. 결정을 안 한 실행에는 아예 없다.
   *
   * `applied` 는 **실제로 사후분포에 반영한** 것이다(`null` = 아무것도 반영 안 했다).
   * `sources[axis]` 는 그 팔이 어디서 왔나 — `'caller'`(라이브러리 입구가 직접 적었다) ·
   * `'bandit'`(관측이 문턱을 넘어 Thompson 이 뽑았다) · `'default'`(그 축의 기본 팔).
   *
   * ⚠ 아래 `learning === null` 갈래는 **현재 도달하지 않는다.** 실측 — 수에는 **시점과 스코프**를
   *   붙인다(한때 「엔진 199개」라고만 적었고 그 수는 커밋 `9b254c8` 것이라 곧 낡았다):
   *     뮤턴트 `learning === null` → `false` · 커밋 `2ad2415` · 스코프 `test/engine.test.mjs`
   *     209개 → **0개 사망**.
   *   결정 전에 나가는 봉투에는 `content` 자체가 없어서 이 함수가
   *   불리지 않기 때문이다. 안전장치로 읽지 마라 — 남겨 둔 이유는 `renderContent` 가
   *   `learning: undefined` 를 이미 받아 내고(그 대조군 테스트가 있다) 이 함수의 반환 타입을
   *   그 계약에 맞춰 두는 편이 낫기 때문이지, 어떤 경로를 막아 주기 때문이 아니다.
   */
  const learningView = () =>
    learning === null
      ? undefined
      : {
          taskClass: learning.taskClass,
          decisions: learning.decisions,
          sources: learning.sources,
          applied: learning.applied,
        };

  /**
   * 실행 결과 → 학습 등급. 설계 §7.4 의 표를 코드로 옮긴 것이다.
   *
   * ★ `null` 은 "이 실행으로는 아무 셀도 갱신하지 않는다" 이다. **테스트가 실제로 돌고 그
   *   결과를 우리가 읽은 실행만 학습한다**(§12.-1). 검증 못 한 것을 성공으로 배우면 밴딧이
   *   "아무것도 안 해도 최고 등급" 을 학습한다.
   *
   * ★★ **테스트 판정의 신뢰도는 α 와 β 가 똑같이 요구한다** — 마지막 스텝의
   *    `tests.confidence === 'verified'`. 러너가 「믿지 마라」고 표시한 판정 위에는 **어느
   *    방향으로도** 배우지 않는다. 정본은 계획 문서 `:1279` 표다.
   *      · 이 픽스처는 이론이 아니다: `src/test-runner.mjs` 의 `DRAIN_MAX_MS` 주석이 그 상태를
   *        스스로 문서화한다 — 드레인 상한에 걸린 경로는 `hung` 으로 나가 **통과한 스위트가
   *        `unverified`** 가 된다. `passed:true + confidence:'unverified'` 는 실제 운영 상태다.
   *      · 한때 α 갈래는 `stopReason === 'verified'` 만 봤고 그 조건에는 `confidence` 가 아예
   *        없었다(`record.tests.passed === true && verifierOk` 뿐이다). 두 방향 다 미테스트였다.
   *
   * ★★ **봉투의** `confidence` 를 요구하면 안 된다(그것과 위 조건은 서로 다른 값이다). 봉투
   *    쪽은 **실행 단위로 끈끈한** 플래그라(한 스텝에서 워커가 죽으면 끝까지 붙어 있다) 아래
   *    실패 쪽의 **마지막 스텝** 기준과 비대칭이 된다 — 같은 워커 CLI 고장이 α 는 0, β 는 네
   *    축 전부가 된다(실측 B2↔B4, 두 테스트가 짝으로 그 대칭을 고정한다). 한 벤더 CLI 가
   *    불안정한 호스트에서 사후분포가 단조로 **비관화**한다.
   *    ☞ 그래서 앞 스텝이 삐끗했지만 **끝내 검증된** 실행은 α 를 받는다. WIDE 가 존재하는
   *      이유가 바로 그 실행이다.
   *
   * ★ **α 만 추가로 요구하는 셋.** α 는 「이 결정이 **검증된 성공**을 만들었다」는 주장이라
   *   그 주장이 성립하지 않는 세 갈래를 막는다. β 는 셋을 안 본다 — 실패는 실패다.
   *   · `patchEmpty` — 워커가 아무것도 안 했다. 테스트는 변경 전에도 통과하므로 그 `verified`
   *     는 아무것도 증명하지 않는다(M-3 되먹임: "아무것도 하지 않아도 최고 등급").
   *     ⚠ `patchEmpty === true` 는 「모른다」(`null`)를 「안 비었다」로 읽는다. 지금 그것이
   *       무해한 이유는 **verified 갈래에 `null` 이 못 오기 때문**이다: `stopReason` 이
   *       `'verified'` 인 봉투는 반드시 `collectPatch` 를 지나고, 그 계약은 `empty` 를 항상
   *       boolean 으로 낸다. `null` 이 남아 있는 것은 패치를 수집하기 전에 끊긴 봉투뿐이고
   *       (`partialContent` 쪽), 그 봉투의 `stopReason` 은 `'verified'` 가 아니다.
   *   · `scopeConfidence !== null` — 봉투가 `failed` 로 나갔다. 화면과 학습이 갈리면 안 된다.
   *   · `verifierTampered` — 베리파이어가 워크트리의 소스를 고쳤다. 그 판정은 **자기가 고친
   *     코드**에 대한 것이다.
   *   ★★ **「β 는 셋을 안 본다」는 문장에도 이제 그물이 있다.** 아래 `verifierTampered` 검사를
   *      이 `if (stopReason === 'verified')` 블록 **밖 맨 앞**으로 끌어올리면 「베리파이어가 뭘
   *      만졌으면 실패도 안 배운다」가 되는데, 그 뮤턴트가 커밋 `61a0f23` ·
   *      스코프 `test/engine.test.mjs` 209개 → **0개 사망**이었다. 워커가 못 고쳤다는 사실은
   *      베리파이어가 뭘 만졌든 그대로 참인데도 β 가 통째로 사라진다. 지금은
   *      `test/engine.test.mjs` 의 `★★ 베리파이어가 고쳐도 β 는 그대로 쌓인다 …` 픽스처가
   *      그것을 죽인다(budget 2 · 1스텝 베리파이어가 고침 · 매 스텝 테스트 실패).
   *
   * ★★ `verifierTampered` 는 **어느 스텝이든** 본다. 「마지막 스텝만」은 **구조적으로 죽은
   *    코드**다(실측: 이 라운드에 그렇게 먼저 짜고 재 봤다 — T1 테스트가 그대로 붉었다).
   *    베리파이어가 고친 스텝은 그 자리에서 `verifierOk = false` 가 되어 `stopReason` 이
   *    `'verified'` 로 나갈 수가 없기 때문이다. 그래서 이 조건이 발화하는 유일한 모양은
   *    「앞 스텝에서 고쳤고 뒤 스텝이 깨끗하게 끝났다」이고, 바로 그것이 막아야 하는 것이다 —
   *    **베리파이어가 고친 파일은 다음 스텝 워크트리에 그대로 남으므로** 「다음 스텝은
   *    깨끗했다」가 독립적 증거가 아니다. `test-definition-changed` 를 막는 이유와 정확히
   *    같은 되먹임이 반대 문으로 열려 있었다.
   *    ★ 「어느 스텝이든」의 **전칭**은 이 라운드까지 미테스트였다 — 손댐이 1스텝인 픽스처만
   *      있었으므로 `steps[0]?.verifier?.touchedSources === true` 로 좁혀도 커밋 `61a0f23` ·
   *      스코프 `test/engine.test.mjs` 209개 → **0개 사망**이었다. 지금은 손댐이 **가운데**
   *      스텝에 오는 픽스처(`★★ 중간 스텝의 베리파이어가 고친 것도 …`)가 그것을 죽인다.
   *
   * ★ 귀속이 `unknown` 인 변경은 **막지 않는다**(`touchedSources` 는 `changed && !ambiguous`).
   *   러너가 남은 프로세스를 신고한 스텝에서 늦게 쓰인 파일까지 막으면, 이 파일의
   *   `★★ 누가 고쳤는지 단정하지 않는다` 주석이 실측으로 지운 **거짓 라벨**이 보상 쪽으로
   *   되돌아온다. 그 경계를 대조군 테스트가 못 박는다.
   *
   * ★ 실패 쪽은 **테스트의** `confidence` 를 본다(봉투의 것이 아니다). 봉투 쪽은 테스트가
   *   떨어진 순간 항상 `unverified` 라 그 조건을 쓰면 β 가 영영 안 쌓인다 — 실측으로 확인했다.
   */
  const gradeOfRun = ({ stopReason }) => {
    const last = steps.at(-1)?.tests;
    if (stopReason === 'verified') {
      if (last?.confidence !== 'verified') return null;
      const verifierTampered = steps.some((record) => record.verifier?.touchedSources === true);
      if (verifierTampered) return null;
      return patchEmpty === true || scopeConfidence !== null ? null : 'success';
    }
    if (stopReason === 'test-definition-changed') return 'failure';
    if (stopReason !== 'budget') return null;
    if (last?.ran !== true) return null;
    if (last.confidence !== 'verified') return null;
    return last.passed === false ? 'failure' : null;
  };

  /**
   * 이 등급을 어느 축의 셀에 적을까. `learnable` 은 결정 시점에 정해진다(아래 참조).
   *
   * ★ `test-definition-changed` 는 **워커 벤더의 신뢰 문제**다 — `placement` 셀에만 β 를
   *   더한다. 재작성 전략·티어·교차검증 여부의 잘못이 아니다.
   */
  const axesFor = (stopReason) =>
    learning.learnable.filter((axis) => stopReason !== 'test-definition-changed' || axis === 'placement');

  /**
   * 사후분포와 저널에 이 실행을 남긴다. **절대 던지지 않고 절대 실행을 막지 않는다.**
   *
   * ★ 학습 실패(잠금 실패·저널 쓰기 실패·사후분포 손상)는 전부 notice 로만 알린다. 봉투는
   *   그대로 나간다 — 계획은 학습을 부가 기능으로 못박았지 차단 사유로 두지 않았다.
   * ★ `ok:true` 여도 `notice` 가 실려 올 수 있다(태스크 4 가 손상 파일을 격리했거나 되돌리기가
   *   하한에 막혔거나 잠금이 남은 경우). 그것을 버리면 "학습이 통째로 날아갔다" 가 묻힌다.
   */
  const recordLearning = async (stopReason) => {
    if (learning === null || learningRecorded) return;
    learningRecorded = true;
    try {
      const grade = gradeOfRun({ stopReason });
      const deltas = gradeToDeltas(grade);
      /**
       * ★ 등급이 **있었다면** 어느 축에 갔을 축들. `wanted` 와 달리 등급이 `null` 이어도 계산한다.
       *
       * 태스크 10 의 `orch_reward` 가 이 값을 읽는다. `appliedAxes` 만으로는 부족하다 —
       * 자동 채점이 기권한 실행(테스트 판정을 못 믿었다 · blocked · 빈 패치)은 `appliedAxes`
       * 가 `[]` 라, 사람이 뒤늦게 채점할 때 **어느 셀에 적을지 알 방법이 0개**가 된다.
       * `Object.keys(AXES)` 로 대신하면 이 실행이 **무연산이었던 축**(벤더 하나 · 역할 지정 ·
       * `test-definition-changed`)에까지 사람 손 보상을 얹어, `learnable`·`axesFor` 가 막으려던
       * 거짓 귀속이 사용자 정정 문으로 되돌아온다.
       * `test/engine.test.mjs` 의 `★ blocked 로 끝난 실행은 …` 픽스처가 그 자리에 「저널에는
       * 남는다 — orch_reward 가 나중에 사람 손으로 채점할 수 있어야 한다」고 적어 뒀는데,
       * 그 문장을 성립시키는 값이 이것이다.
       */
      const rewardable = axesFor(stopReason);
      const wanted = deltas === null ? [] : rewardable;
      if (deltas !== null && wanted.length === 0) addNotice(learning.skipNotice);
      if (!legacyLearningSeams) {
        const applied = deltas === null ? [] : wanted;
        const updates = deltas === null
          ? []
          : wanted.map((axis) => ({
              cellKey: cellKeyOf(learning.taskClass, axis),
              arm: learning.decisions[axis],
              ...deltas,
            }));
        const stored = await stage('학습 사후분포·실행 저널 기록', () =>
          commitLearningMutation(
            runStateRoot,
            {
              updates,
              journal: {
                runId,
                taskClass: learning.taskClass,
                decisions: learning.decisions,
                outcome: { grade, stopReason: stopReason ?? null },
                appliedGrade: applied.length > 0 ? grade : null,
                appliedAxes: applied,
                rewardableAxes: rewardable,
              },
            },
            learningOperationOptions,
          ),
        );
        if (stored?.ok !== true) {
          learning.applied = { grade: null, axes: [] };
          // A failure while preparing the posterior target has no WAL yet.
          // Preserve the run as a journal-only record so a human can reward it
          // after the storage fault is repaired.  Once a pending WAL exists,
          // never append this fallback: recovery owns the exact posterior and
          // journal targets and a null row would overwrite that operation.
          if (stored?.pending === false) {
            const fallback = await stage('학습 실행 저널 기록', () =>
              commitLearningMutation(runStateRoot, {
                updates: [],
                journal: {
                  runId,
                  taskClass: learning.taskClass,
                  decisions: learning.decisions,
                  outcome: { grade, stopReason: stopReason ?? null },
                  appliedGrade: null,
                  appliedAxes: [],
                  rewardableAxes: rewardable,
                },
              }),
            );
            if (fallback?.ok === true) {
              addLeadNotice(`학습 사후분포를 갱신하지 못해 실행 기록만 남겼습니다: ${reasonOf(stored)}`);
              if (typeof fallback.notice === 'string' && fallback.notice !== '') {
                addLeadNotice(`실행 기록 알림: ${fallback.notice}`);
              }
              return;
            }
            addLeadNotice(`학습 갱신과 실행 기록을 남기지 못했습니다: ${reasonOf(fallback)}`);
            return;
          }
          addLeadNotice(`학습 갱신을 못 했습니다: ${reasonOf(stored)} (보류 중인 작업은 다음 읽기 또는 재시도에서 복구됩니다.)`);
          return;
        }
        learning.applied = { grade: applied.length > 0 ? grade : null, axes: applied };
        if (typeof stored.notice === 'string' && stored.notice !== '') addLeadNotice(`학습 갱신 알림: ${stored.notice}`);
        return;
      }
      const applied = [];
      for (const axis of wanted) {
        const got = await stage('학습 사후분포 갱신', () =>
          updatePosterior(runStateRoot, {
            cellKey: cellKeyOf(learning.taskClass, axis),
            arm: learning.decisions[axis],
            ...deltas,
          }),
        );
        if (got?.ok !== true) {
          addLeadNotice(`학습 갱신을 못 했습니다(${axis}): ${reasonOf(got)}`);
          continue;
        }
        if (typeof got.notice === 'string' && got.notice !== '') addLeadNotice(`학습 갱신 알림: ${got.notice}`);
        applied.push(axis);
      }
      learning.applied = { grade: applied.length > 0 ? grade : null, axes: applied };

      // ★ `appliedGrade`·`appliedAxes` 는 "지금 사후분포에 반영돼 있는 것" 이다. 태스크 10 의
      //   `orch_reward` 가 그 기여를 되돌리려면 **어느 축에** 무엇이 반영됐는지 알아야 한다.
      //   등급만 남기면 네 축에 일괄로 빼는데, 이 실행은 축 일부만 갱신할 수 있다.
      //   `rewardableAxes` 는 그것과 다른 질문의 답이다 — "**앞으로** 이 실행에 등급을 주면
      //   어디로 가나". 둘의 관계는 `appliedAxes ⊆ rewardableAxes` 이고, 갱신에 실패한 축이
      //   있으면 진부분집합이 된다.
      const journaled = await stage('실행 저널 기록', () =>
        appendRun(runStateRoot, {
          runId,
          taskClass: learning.taskClass,
          decisions: learning.decisions,
          outcome: { grade, stopReason: stopReason ?? null },
          appliedGrade: learning.applied.grade,
          appliedAxes: applied,
          rewardableAxes: rewardable,
        }),
      );
      if (journaled?.ok !== true) addLeadNotice(`실행 기록을 남기지 못했습니다: ${reasonOf(journaled)}`);
      else if (typeof journaled.notice === 'string' && journaled.notice !== '') {
        addLeadNotice(`실행 기록 알림: ${journaled.notice}`);
      }
    } catch (error) {
      // 여기 닿는 것은 우리 버그다. 그래도 봉투는 나가야 한다.
      addLeadNotice(`학습을 기록하다 예기치 못한 오류가 났습니다: ${safeText(error)}`);
    }
  };

  /**
   * 실패 봉투를 내는 **유일한** 자리(워크트리를 만들기도 전의 거부는 제외). 마무리를 여기서
   * 다 한다: 학습 기록 → 회수·관측·원장 → 스코프 신뢰도 → recovery 앞의 스코프 사유 → notice.
   */
  const sealFailure = async ({ status, error, recovery, stopReason, ...rest }) => {
    // ★ `release()` 보다 **먼저** 부른다. 학습이 내는 notice 가 봉투에 닿아야 하고, `seal` 은
    //   이 뒤에 돈다. 정상 경로가 이미 기록했으면 무연산이다.
    await recordLearning(stopReason);
    await release();
    return seal(
      failure({
        status,
        error,
        recovery: `${scopeRecovery !== null ? `${scopeRecovery} ` : ''}${recovery}`,
        confidence: scopeConfidence ?? 'unverified',
        ...rest,
      }),
      stopReason,
    );
  };

  try {
    // ── 테스트 명령 고정 ──────────────────────────────────────────────────
    //
    // **사용자 프로젝트**에서 유도한다. 워크트리에서 다시 유도하면 델리게이트가
    // `scripts.test` 를 `exit 0` 으로 바꿔 둔 것을 그대로 실행한다(설계 §12.-1).
    const derived = await stage('테스트 명령 유도', () => deriveTestCommand(projectPath));
    const testPlan = isBlocked(derived) ? null : (derived ?? null);
    if (testPlan !== null && typeof testPlan.resolveError === 'string' && testPlan.resolveError !== '') {
      addNotice(`테스트 도구를 찾지 못했습니다: ${testPlan.resolveError}`);
    }

    // ── §7 학습: 결정 ─────────────────────────────────────────────────────
    //
    // ★★ **여기다.** 브리프는 "실행 시작 직후(워크트리 생성 전)" 라고 적었는데 두 가지가
    //    그것을 막는다:
    //      · `classifyTask` 는 `testSource` 를 봐야 `code:test-bearing` 과 `code:no-tests`
    //        를 가른다. 그 값은 바로 위 `deriveTestCommand` 가 처음 만든다 — 앞에서 부르면
    //        코드 요청이 전부 `code:no-tests` 로 뭉쳐 두 셀이 하나가 된다.
    //      · 읽는 상태 루트와 쓰는 상태 루트가 갈리면 안 된다. 워크트리 생성 전에는
    //        `runStateRoot` 가 아직 호출자 문자열 그대로이고(`createWorktree` 가 fail-closed
    //        검증을 하고 실체 경로로 편 값을 준다), 이 파일의 규약은 그 뒤로 상태 루트 사용을
    //        `runStateRoot` **하나**로 통일하는 것이다(`sweepScratch` 를 뒤로 옮긴 것과 같은 축).
    //    대가: 사전 점검·워크트리 blocked 로 나가는 봉투는 결정을 한 적이 없다. 그 봉투에는
    //    `content.learning` 도 저널 기록도 없다 — 실제로 아무 팔도 안 써 봤으므로 사실이다.
    const taskClass = classifyTask({ task, testSource: testPlan?.source ?? null });
    const posteriors = await stage('학습 사후분포 읽기', () => readPosteriors(runStateRoot));
    if (posteriors?.ok !== true) {
      // ★ "없다" 와 "못 읽는다" 를 뭉개지 않는다 — `readPosteriors` 는 파일이 없으면
      //   `{ok:true, cells:{}}` 다. 여기 오는 것은 손상·접근 불가뿐이고, 조용히 기본값으로
      //   돌면 사용자는 그동안의 학습이 통째로 안 보이는 것을 모른다.
      addLeadNotice(`학습 사후분포를 읽지 못해 이번 실행은 기본값으로 돕니다: ${reasonOf(posteriors)}`);
    }
    const advice = decide({
      cells: posteriors?.ok === true ? posteriors.cells : {},
      taskClass,
      // ① `orch_run` 의 `allow_single` 이 여기까지 온다. 안 넘기면 `allow_single: true` 가
      //    조용한 무연산이 된다(태스크 6 이 배선했는데 읽는 곳이 0곳이었다).
      allowed: { single: options.allowSingle === true },
      random,
    });
    for (const axis of Object.keys(AXES)) {
      if (decisions[axis] !== undefined) continue; // 호출자가 적은 축이 이긴다.
      decisions[axis] = advice.decisions[axis];
      // ★ `?? 'default'` 를 두지 않는다. `decide` 는 **축마다 반드시** source 를 낸다(정본:
      //   `src/learn/bandit.mjs` — 팔 부족·관측 부족·축별 catch 세 갈래가 전부 `'default'` 를
      //   적고, 성공 갈래가 `'bandit'` 을 적는다). 폴백을 두면 "안전을 준다" 고 읽히는데
      //   실측으로 도달하지 않는 죽은 코드다 — 수에 **시점과 스코프**를 붙인다:
      //     뮤턴트 `= advice.sources[axis] ?? 'default'` · 커밋 `2ad2415` ·
      //     스코프 `test/engine.test.mjs` 209개 → **0개 사망**(= 폴백이 한 번도 안 발화한다).
      //   (한때 「엔진 199개」라고만 적었고 그 수는 커밋 `9b254c8` 것이라 곧 낡았다.)
      sources[axis] = advice.sources[axis];
    }
    basePlacement = decisions.placement;
    chosen = placeRoles(basePlacement);

    // ── 어느 축이 이 실행에서 **배울 것이 있나** ──────────────────────────
    //
    // 무연산이거나 기록한 팔이 실제와 갈리는 축에 보상을 주면 **하지 않은 것을 했다고 배운다.**
    const roleOverrides = [options.planner, options.worker, options.verifier].filter(
      (id) => id !== undefined && id !== null,
    );
    const anyRolePinned = roleOverrides.length > 0;
    /**
     * ③ 재작성 뒤집기를 무연산으로 만드는 조건.
     *
     * ★★ **워커와 베리파이어 둘 다** 지정이면 무연산이다. 「세 역할 전부」가 아니다 —
     *    한때 `roleOverrides.length === 3` 이었고 그것은 **재지 않고 적은 전칭 명제**였다.
     *    실측(리뷰 I-2, 두 출처 독립 재현 · 위 조합의 테스트가 이 파일 옆에 있다):
     *    `worker:'alpha'` + `verifier:'beta'` + budget 3 + 매 스텝 테스트 실패는
     *    deep 과 wide 의 프로바이더 호출열이 **완전히 같은데**(planner:alpha ·
     *    worker:alpha ×3 · verifier:beta ×3 · flips 0) 서로 다른 팔에 β 를 적립했다.
     *    뒤집기가 관측 가능한 것을 바꾸려면 뒤집힌 배치가 워커나 베리파이어를 바꿔야 하는데,
     *    플래너는 루프 밖에서 한 번만 돈다(아래 `★ 플래너는 루프 밖에서…` 주석과 같은 사실).
     * ★ 이 집합은 옛 조건을 포함한다(세 역할 전부 지정 ⇒ 워커·베리파이어 지정). 넓히기만
     *   하고 좁히지 않는다 — 실측(논증이 아니라 실행): 이 줄로 바꾼 뒤 붉어진 기존 테스트는
     *   엔진 191개·전체 926개 중 **0개**였다.
     */
    const rewritePinned =
      options.worker !== undefined &&
      options.worker !== null &&
      options.verifier !== undefined &&
      options.verifier !== null;
    // ④ 벤더가 하나뿐이면 `assignRoles` 가 두 placement 팔에 **같은 배치**를 낸다 — 세 축이
    //    통째로 무연산이다. ★ `providers.length` 가 아니라 **서로 다른 id 수**로 재고, `=== 1`
    //    이 아니라 `<= 1` 로 잰다(둘 다 id 가 없으면 0 이다). 엔진의 교차검증 신고가 같은 수를
    //    쓰므로 신고와 판정이 갈리지 않는다.
    const soloVendor = vendorCount <= 1;
    const skipReasons = [];
    if (soloVendor) skipReasons.push('벤더가 하나뿐이라 배치·교차검증·재작성 축이 무연산입니다');
    if (rewritePinned) skipReasons.push('워커·베리파이어를 둘 다 지정해 재작성 뒤집기가 무연산입니다');
    else if (anyRolePinned) skipReasons.push('역할 지정이 결정을 이겨 배치·교차검증 축의 기록과 실제가 갈립니다');
    /**
     * 이 실행이 실제로 배울 수 있는 축.
     *
     * · `tier` — 언제나 배운다. 입구가 `decisions.tier` 하나뿐이라 갈릴 채널이 없고, 위 세
     *   조건 어느 것도 티어를 무연산으로 만들지 않는다.
     * · `rewrite` — 두 팔이 서로 다른 실행을 낼 수 있어야 한다. 벤더가 하나거나 워커·베리파이어가
     *   둘 다 못 박혔으면 WIDE 뒤집기가 배치를 못 바꾼다(위 `rewritePinned` 의 실측 참조).
     *   ★ `rewriteFlips === 0` 으로 재지 **않는다**
     *   — DEEP 은 정의상 언제나 0 이라 그 게이트는 비대칭이고 DEEP 이 영영 안 배운다(표본 편향).
     *   여기 두 조건은 두 팔에 **대칭**인 구조적 사실이다.
     * · `mix`·`placement` — 역할 오버라이드가 있으면 저널의 팔과 실제 배치가 갈린다(실측:
     *   `mix:'single'` + `verifier:'beta'` → 저널은 `single` 인데 실제로는 두 벤더가 교차검증).
     * · ② `placement` 는 `single` 실행에서도 **갱신한다**(합산). 예전에는 건너뛰었는데
     *   시뮬레이션으로 뒤집었다: single 이 승자인 세계(1000실행·60시드)에서 합산 76.3~77.4%
     *   대 건너뛰기 52.2~52.6% 로 건너뛰기가 셋 중 최악이었고, 부호 전환점 s≈0.60 부터
     *   단조로 나빠졌다(두 출처 독립 재현 — 상세는 리뷰 I-1 과 보고서 「수정 라운드 1」).
     *   원인은 자기잠금이다: single 실행의 관측을 안 쓰면 셀이 mix 통계에 얼어붙고 single
     *   실행은 영원히 그 기준으로 고른 벤더로 돈다. single 실행에서도 placement 는
     *   「누가 혼자 다 하나」를 정하는 실제 선택이다.
     *   ⚠ 합산의 대가는 사실이다 — 뜻이 조금 다른 두 관측이 한 셀에 쌓인다. 셀 키를 분기하는
     *     대안(split)이 격자 전체에서 합산보다 +0.33~+3.59%p 나았지만, **`decide()` 의 읽기
     *     쪽까지 분기해야** 효과가 난다(쓰기만 분기하면 아무도 안 읽는 죽은 셀이 되어 건너뛰기와
     *     소수점까지 같은 결과였다 — 실측). 그것은 `src/learn/bandit.mjs` 에 `AXES` 순회 순서에
     *     의존하는 축 간 결합을 새로 만든다. 여기서는 한 줄 삭제로 끝나는 합산을 고른다.
     */
    const learnable = Object.keys(AXES).filter((axis) => {
      if (axis === 'tier') return true;
      if (soloVendor) return false;
      if (axis === 'rewrite') return !rewritePinned;
      if (anyRolePinned) return false;
      return true;
    });
    learning = {
      taskClass,
      decisions,
      sources,
      learnable,
      applied: null,
      skipNotice:
        `이 실행의 결과를 학습에 반영하지 않았습니다 — ${skipReasons.join(' / ') || '반영할 축이 없습니다'}.`,
    };

    // ── 플래너: 일회용 **빈 디렉터리** ────────────────────────────────────
    await rm(planDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(planDir, { recursive: true });

    const settings = await readSettings(runStateRoot).catch(() => ({}));
    // 티어를 고르는 주체는 설계 §7.2 의 결정④다. 계획 2 에서는 그 자리가 `options.tier`
    // 라는 라이브러리 입구뿐이었고 도구 층이 안 넘겨 `tier.name` 이 항상 `'strong'` 이었다
    // (그래서 `src/config.mjs` 의 `fast`/`fastEffort` 가지에 도달하는 경로가 없었다).
    //
    // ★ 그 `options.tier` 를 남기지 않고 `decisions.tier` 로 **갈아 끼운다.** 두 입구를 다
    //   두면 같은 어휘(`'fast'`/`'strong'`)를 말하는 길이 둘이 되고, 태스크 8 이 저널에
    //   적는 팔과 실제로 쓴 티어가 조용히 갈릴 수 있다. 역할별 벤더 id 오버라이드와는
    //   다르다 — 그쪽은 팔(앞뒤)과 id(바로 이 벤더)라 어휘 자체가 다르다.
    //
    // ★ 여기는 정본이 아니라 **모르는 값의 낙하지점**이다. `decisions.tier` 는 밴딧이 고른
    //   팔이지만 저장된 저널·주입된 결정에서 온 모르는 글자일 수도 있다. 그때 어디로
    //   떨어질지를 정하는 자리이고, 팔 목록과 기본값을 **`AXES.tier` 에서 그대로 가져온다** —
    //   그래서 이 줄에 티어 이름이 글자로 남지 않는다. 예전의
    //   `decisions.tier === 'fast' ? 'fast' : 'strong'` 은 세 번째 팔이 생기면 그 팔을 조용히
    //   `'strong'` 으로 접었다(`src/config.mjs` 가 지운 `startsWith('fast')` 와 같은 함정이다).
    //
    //   `resolveTier` 의 낙하지점은 `TIERS[0]` 이라 **다른 배열**을 본다. 그 둘이 갈리지
    //   않는 것은 `test/config.test.mjs` 의
    //   '★ 설정의 티어 목록과 밴딧의 티어 팔이 갈리지 않는다' 가 잰다.
    const tier = {
      settings,
      name: AXES.tier.arms.includes(decisions.tier) ? decisions.tier : AXES.tier.default,
    };

    const planner = await callProvider({
      provider: chosen.planner.provider,
      role: PLANNER_ROLE,
      phase: 'planner',
      step: 0,
      workspace: planDir,
      instruction: plannerInstruction({ task, testPlan, evidence: advice.evidence }),
      // 읽기 전용 역할은 프로바이더가 도구를 전부 끈다. 집합을 넘기지 않는다.
      tools: undefined,
      tier,
    });
    addNotice(planner.notice);
    const plan = typeof planner.content === 'string' && planner.content !== '' ? planner.content : task;

    // ★ 일회용 계획 디렉터리는 **여기서** 치운다. 수명이 실제 용도(플래너가 도는 동안)와
    //   같아지고, 실패 사실이 봉투에 닿는다.
    //
    //   `finally` 로 미루면 실패를 알릴 수 없다: `try { return seal(...) } finally { … }`
    //   에서 반환값은 finally 보다 **먼저** 만들어지므로, 거기서 `addNotice` 를 불러도
    //   그 문장은 이미 만들어진 봉투에 들어가지 못한다. 알릴 수 없는 알림은 없는 것과 같다.
    if (!(await rm(planDir, { recursive: true, force: true }).then(() => true, () => false))) {
      addNotice(`일회용 계획 디렉터리를 지우지 못했습니다: ${planDir}`);
    }

    // ── 스텝 루프 ─────────────────────────────────────────────────────────
    // `steps` 와 `singleVendorSteps` 는 위(`crossCheckLines` 곁)에 있다 — 봉투를 내는 자리가
    // 그 둘을 읽는다.
    const blockers = [];
    let stopReason = 'budget';
    let unverified = testPlan === null;
    let feedback = null;

    // ── §7.2 결정③ rewrite ────────────────────────────────────────────────
    //
    // DEEP 은 실패한 스텝을 **같은 배치**로 다시 시도하고, WIDE 는 **다음 스텝에서 배치를
    // 뒤집는다**. 둘 다 피드백(앞 스텝의 테스트 결과·베리파이어 본문)은 그대로 넘긴다.
    //
    // ★ 계획 2 에서는 배치가 루프 **밖**에서 한 번 계산됐다 — 그래서 WIDE 경로가 코드에
    //   아예 없었고 밴딧이 고를 갈림길이 없었다.
    // ★ 플래너는 루프 밖에서 한 번만 도므로 뒤집기가 닿지 않는다. 봉투의 `plan.provider` 는
    //   실제로 계획을 쓴 벤더(=시작 배치의 플래너)를 계속 가리킨다.
    const rewriteArm = decisions.rewrite === 'wide' ? 'wide' : 'deep';
    let placement = basePlacement;
    /** 앞 스텝이 실제로 쓴 배치. 첫 스텝에는 없다. */
    let previousRoles = null;
    /**
     * 뒤집기가 **실제로** 배치를 바꾼 횟수.
     *
     * ★ 결정만으로는 알 수 없다. 벤더가 하나뿐이거나 · 역할을 전부 못 박았거나 ·
     *   `budget` 이 1 이거나 · 첫 스텝에서 끝난 실행에서는 WIDE 가 무연산이고, 그런 실행의
     *   `rewrite` 셀에 보상을 주면 **아무 일도 하지 않은 결정을 배웠다고 기록한다.**
     *   그 판단은 태스크 8 이 하고, 판단에 필요한 사실은 여기서 센다.
     * ★ 프로바이더 **객체**로 비교한다. 같은 id 의 객체 둘이 주입되면(라이브러리 입구로만
     *   가능하다) `run` 이 서로 다를 수 있으므로 배치는 실제로 바뀐 것이다 — 다만 벤더로는
     *   안 바뀐 것이라 이 수가 교차검증 신고(id 로 센다)와 **실제로 갈린다.** 실측: 같은 id
     *   `'alpha'` 인 객체 둘 + WIDE + budget 3 은 한 봉투에 `flips:2` 와 「벤더가 하나뿐이라
     *   교차검증 없이…」를 **함께** 싣는다. 테스트가 그 조합을 정책으로 못 박는다.
     * ★ id 로 바꾸지 않는 이유: `crossCheckNotice` 의 두 번째 ★ 와 거울상인 함정이 있다.
     *   id 가 없는(`undefined`) 서로 다른 객체 둘은 id 로 비교하면 「안 바뀌었다」가 되어
     *   실제로 일어난 뒤집기를 놓친다. 객체 비교는 그 방향으로 틀리지 않는다 — 이 수가
     *   말하는 것은 「어느 벤더냐」가 아니라 「배치가 실제로 바뀌었나」다.
     */
    let rewriteFlips = 0;

    for (let step = 1; step <= budget; step += 1) {
      if (aborted()) {
        stopReason = 'deadline';
        break;
      }
      const record = { step };
      steps.push(record);

      // 이 스텝의 배치. WIDE 라면 앞 스텝이 실패한 만큼 뒤집혀 들어온다.
      const active = placeRoles(placement);
      if (
        previousRoles !== null &&
        (previousRoles.worker.provider !== active.worker.provider ||
          previousRoles.verifier.provider !== active.verifier.provider)
      ) {
        rewriteFlips += 1;
      }
      previousRoles = active;
      // 배치가 스텝마다 달라지므로 교차검증 유무도 스텝마다 갈린다 — 세어만 두고 문장은
      // 봉투를 낼 때 `crossCheckLines` 가 한 번 고른다. 여기서 `crossCheckNotice` 를 그대로
      // 부르면 **실행 단위** 문장이 스텝 단위 사실에 실려 봉투가 스코프를 과장한다(실측:
      // `worker:'alpha'` + WIDE + budget 3 은 1·3 스텝이 교차검증됐는데도 「이 실행이 한
      // 벤더만 쓰도록 정해졌습니다」라고 말했다).
      if (
        typeof active.worker.provider?.id === 'string' &&
        active.worker.provider.id === active.verifier.provider?.id
      ) {
        singleVendorSteps += 1;
      }

      // 워커 — 워크트리 · 쓰기 · Bash 없는 집합
      const worker = await callProvider({
        provider: active.worker.provider,
        role: 'worker',
        phase: 'worker',
        step,
        workspace: worktree.path,
        instruction: workerInstruction({ task, plan, step, budget, feedback }),
        tools: [...WORKER_TOOLS],
        tier,
      });
      addNotice(worker.notice);
      record.worker = {
        provider: active.worker.provider.id,
        truncated: worker.truncated === true,
        content: clip(worker.content, EXCERPT_CHARS),
      };
      if (typeof worker.error === 'string' && worker.error !== '') {
        record.worker.error = worker.error;
        unverified = true;
      }

      const afterWorker = await stage('워커 뒤 스냅샷', () => snapshotStep(worktree, `bom-orch step ${step} worker`));
      if (isBlocked(afterWorker)) {
        blockers.push({ where: 'snapshot(worker)', error: afterWorker.error, recovery: afterWorker.recovery });
        stopReason = 'blocked';
        break;
      }
      record.worker.files = afterWorker.files;

      // 스텝별 스코프 검사 — 조기에 끊어 남은 예산을 태우지 않는다 (배선 숙제 4·7).
      //
      // ★ `files` 만으로는 부족하다. `add -A` 기반 관측은 **무시 규칙에 걸린 쓰기를 전부
      //   놓친다.** 실측(C-1): 사용자 전역 무시 규칙에 `**/.claude/settings.local.json` 이
      //   있으면 델리게이트가 그 파일을 심어도 `worker.files` · 스텝 스코프 · 몰래 고치기
      //   탐지 **세 곳이 전부 눈이 먼다**. 갓 만든 워크트리에는 무시된 파일이 없으므로
      //   여기 나오는 것은 그 안에서 새로 생긴 것이다.
      const ignoredNow = await stage('무시된 경로 조회', () => listIgnoredPaths(worktree));
      const ignoredList = Array.isArray(ignoredNow) ? ignoredNow : [];
      if (!Array.isArray(ignoredNow)) {
        addNotice('워크트리의 무시된 경로 목록을 확인하지 못했습니다 — 무시 규칙 뒤에 숨은 쓰기를 보지 못합니다.');
      }
      const scopeFiles = [...afterWorker.files, ...ignoredList.filter((path) => !afterWorker.files.includes(path))];
      // `baseline` 은 `package.json` 의 `scripts` 대조에만 쓰인다(계획 2 이월 3). 스텝
      // 단위에서도 **실행 시작 상태**와 견준다 — 앞 스텝이 심어 둔 것을 이 스텝이 안
      // 건드렸다고 통과시키면 조기 차단의 뜻이 없다.
      const stepScope = await stage('스텝 스코프 검사', () =>
        inspectPatch({ files: scopeFiles, worktree: worktree.path, baseline: worktree.baseline }));
      if (isBlocked(stepScope)) {
        blockers.push({ where: 'inspectPatch(step)', error: stepScope.error, recovery: stepScope.recovery });
        stopReason = 'blocked';
        break;
      }
      record.worker.ignoredPaths = ignoredList;
      record.scope = { flagged: stepScope.flagged, reasons: stepScope.reasons.slice(0, MAX_REASONS_PER_STEP) };
      if (stepScope.flagged) {
        noteScope(stepScope);
        stopReason = 'scope-flagged';
        break;
      }

      if (aborted()) {
        stopReason = 'deadline';
        break;
      }

      // 테스트 — 델리게이트가 아니라 우리가 돌린다 (§12.-1)
      const tests = await runStepTests({
        testPlan,
        worktree,
        runId,
        deadline,
        register,
        runTests,
        phaseStart,
        step,
        stage,
      });
      record.tests = tests.record;
      // ★ 러너는 스텝마다 「사용자 권한으로 돌았다」를 낸다(§5.8 S1). 봉투에는 **한 번**만
      //   올린다 — `addNotice` 가 같은 글자를 두 번 담지 않으므로 스텝 수와 무관하다.
      //   보통 큐로 보낸다: 이상 신호가 아니라 이 제품의 상시 성질이라, `leadNotices` 에
      //   넣으면 진짜 이상 신호(못 읽음·못 씀·격리)를 뒤로 밀어낸다.
      if (Array.isArray(tests.record?.notes) && tests.record.notes.includes(USER_PRIVILEGE_NOTE)) {
        addNotice(USER_PRIVILEGE_NOTE);
      }
      if (tests.definitionRejected) {
        // 배선 숙제 5: 정당한 수정이었을 수도 있다. 통째로 실패로 버리지 않고 사람에게 넘긴다 —
        // 거부는 재시도해도 같으므로 남은 스텝은 돌리지 않는다.
        stopReason = 'test-definition-changed';
        unverified = true;
        break;
      }
      if (tests.blocked !== null) {
        blockers.push(tests.blocked);
        stopReason = 'blocked';
        break;
      }
      if (tests.unverified) unverified = true;

      // ★ 몰래 고치기 탐지의 기준점. 테스트가 남긴 산출물이 베리파이어 탓이 되면 안 된다.
      const afterTests = await stage('테스트 뒤 스냅샷', () => snapshotStep(worktree, `bom-orch step ${step} tests`));
      if (isBlocked(afterTests)) {
        blockers.push({ where: 'snapshot(tests)', error: afterTests.error, recovery: afterTests.recovery });
        stopReason = 'blocked';
        break;
      }
      record.tests.artifacts = afterTests.files;

      if (aborted()) {
        stopReason = 'deadline';
        break;
      }

      // 베리파이어 — 워크트리 · 읽기 전용 집합
      const verifier = await callProvider({
        provider: active.verifier.provider,
        role: 'verifier',
        phase: 'verifier',
        step,
        workspace: worktree.path,
        instruction: verifierInstruction({
          task,
          plan,
          files: afterWorker.files,
          tests: describeTests(record.tests),
        }),
        tools: [...VERIFIER_TOOLS],
        tier,
      });
      addNotice(verifier.notice);

      const afterVerifier = await stage('베리파이어 뒤 스냅샷', () => snapshotStep(worktree, `bom-orch step ${step} verifier`));
      if (isBlocked(afterVerifier)) {
        blockers.push({ where: 'snapshot(verifier)', error: afterVerifier.error, recovery: afterVerifier.recovery });
        stopReason = 'blocked';
        break;
      }

      // ★★ 누가 고쳤는지 **단정하지 않는다**. 기준점을 테스트 직후에 찍는 것만으로는
      //    창이 닫히지 않는다 — 러너가 `lingering`/`hung` 으로 "남은 프로세스가 있다" 고
      //    신고한 스텝에서는 그 프로세스가 베리파이어가 도는 동안 워크트리에 쓴다.
      //    실측: 베리파이어가 파일 API 를 한 번도 안 불렀는데 테스트 자식이 400ms 뒤에 쓴
      //    `coverage-late.txt` 를 "베리파이어가 몰래 고쳤다" 로 보고했다. §7 학습 계층에
      //    들어가는 거짓 라벨이고, 진짜 몰래 고치기와 구별할 방법이 봉투 어디에도 없었다.
      //
      //    신뢰도는 그대로 낮춘다(안전한 방향). 귀속만 `unknown` 으로 둔다.
      const changed = afterVerifier.changed === true;
      const ambiguous = record.tests?.lingering === true || record.tests?.hung === true;
      const touchedBy = changed ? (ambiguous ? 'unknown' : 'verifier') : 'none';
      record.verifier = {
        provider: active.verifier.provider.id,
        truncated: verifier.truncated === true,
        touchedSources: changed && !ambiguous,
        touchedBy,
        touchedFiles: afterVerifier.files,
        confidence: changed ? 'unverified' : 'verified',
        content: clip(verifier.content, EXCERPT_CHARS),
      };
      let verifierOk = true;
      if (typeof verifier.error === 'string' && verifier.error !== '') {
        record.verifier.error = verifier.error;
        verifierOk = false;
        unverified = true;
      }
      if (changed) {
        verifierOk = false;
        unverified = true;
        // 목록은 앞 몇 개만 적는다 — 전체는 상한이 걸린 content 쪽(`verifier.touchedFiles`)에 있다.
        const where = afterVerifier.files.length > 0 ? few(afterVerifier.files) : '경로 불명';
        addNotice(
          ambiguous
            ? `베리파이어 뒤에 워크트리가 바뀌었습니다(${where}). 다만 이 스텝의 테스트가 남은 프로세스를 ` +
                '신고했으므로 누가 썼는지 확정할 수 없습니다 — 신뢰도만 낮췄습니다.'
            : `베리파이어가 워크트리의 소스를 고쳤습니다(${where}) — ` +
                '그 판정은 자기가 고친 코드에 대한 것이라 신뢰도를 낮췄습니다.',
        );
      }

      feedback = [
        `테스트: ${describeTests(record.tests)}`,
        `베리파이어: ${clip(verifier.content, EXCERPT_CHARS)}`,
      ].join('\n');

      if (record.tests.passed === true && verifierOk) {
        stopReason = 'verified';
        break;
      }
      if (aborted()) {
        stopReason = 'deadline';
        break;
      }

      // ★★ "스텝 실패" 의 정의. 이 줄에 닿았다는 것은 **이 스텝이 작업을 끝내지 못했다**는
      //    뜻이다 — 그것이 이 자리에서 알 수 있는 전부다. 다음 스텝이 남아 있으면 그 스텝이
      //    뒤집힌 배치로 돈다. 마지막 스텝(`step === budget`)에서도 이 줄에 닿아 뒤집지만
      //    그 뒤집기는 아무 데도 안 쓰인다 — `rewriteFlips` 는 스텝 **시작**에서 세므로
      //    거기에도 안 들어간다(실측: 매 스텝이 실패하는 WIDE 실행이 budget 3 에서
      //    `flips:2`, budget 5 에서 `flips:4`. 둘 다 테스트가 정확값으로 고정한다).
      //    ⚠ 그래서 루프를 빠져나온 `placement` 는 **마지막 스텝이 쓴 배치가 아니다**(한 번 더
      //    뒤집힌 값). 저널·로깅에 적으려면 `basePlacement` 나 `previousRoles` 를 써라.
      //
      //    루프 안의 `break` 는 열둘인데 **전부 실행을 끝낸다**(실측: deadline 넷 · blocked
      //    다섯 · scope-flagged · test-definition-changed · verified). `continue` 도 내부
      //    루프도 없다(실측). 다음 스텝으로 넘어가는 길은
      //    여기 하나뿐이라, 별도의 `stepFailed` 판정을 두면 그 판정과 루프의 계속 조건이
      //    갈리는 순간 WIDE 가 조용히 DEEP 이 된다(뒤집지 않고 다음 스텝을 도는 갈래) 또는
      //    다음 스텝이 없는 자리에서 뒤집는다.
      //
      //    그래서 여기 닿는 갈래는 "테스트 실패" 만이 아니다: 베리파이어 오류·베리파이어의
      //    몰래 고치기·테스트를 못 돌린 스텝도 포함된다. 셋 다 **이 배치로는 못 끝냈다**는
      //    같은 사실을 말한다.
      if (rewriteArm === 'wide') placement = flipPlacement(placement);
    }

    // 루프 안의 `break` 는 전부 여기로 떨어진다(루프 안에 `return` 이 없다 — 실측). 그래서
    // 조기 종료 봉투도 위에서 센 `singleVendorSteps` 를 그대로 들고 나간다 — 교차검증 문장은
    // 봉투를 내는 자리(`crossCheckLines`)가 고른다. DEEP 에서는 「일부 스텝만」이 나올 수
    // 없다 — `placeRoles` 의 입력(`placement`·`providers`·역할 오버라이드) 이 전부 실행 중
    // 안 바뀌므로 스텝마다 같은 배치를 낸다. 대조군 테스트가 그 갈래를 고정한다.

    // ★ I-4. abort 로 루프를 빠져나오는 세 자리는 이미 스스로 `'deadline'` 을 적는다.
    //   여기서 그 밖의 사유까지 덮으면 **정상 완료한 실행이 실패로 뒤집힌다** — 실측:
    //   모든 스텝이 `verified` 로 끝난 뒤 베리파이어 뒤 git 스냅샷(신호와 무관한 구간)에서
    //   데드라인이 지나자 봉투가 `deadline_exceeded / unverified` 로 나갔고, 그 content 는
    //   `tests.passed:true` · `verifier.confidence:'verified'` 였다. 호출자는 recovery 대로
    //   wait_ms 를 늘려 이미 끝난 작업을 통째로 다시 돌린다.
    //   덮어야 하는 것은 "예산을 다 썼는데 그 사이에 데드라인도 지났다" 하나뿐이다.
    if (stopReason === 'budget' && aborted()) stopReason = 'deadline';
    if (stopReason !== 'deadline' && aborted()) {
      addNotice('모든 단계가 끝난 뒤 뒷정리 구간에서 데드라인이 지났습니다 — 결과 판정은 뒤집지 않았습니다.');
    }

    /**
     * 조기 종료 봉투의 content. 정상 경로와 **같은** 상한 사다리를 지난다 — 봉투마다 다른
     * 규칙을 두면 그중 하나가 잘린(파싱 불가능한) JSON 을 낸다.
     */
    const partialContent = (patchInfo) =>
      renderContent({
        runId,
        stopReason,
        stepCount: steps.length,
        patch: patchInfo,
        scope: { flagged: scopeFlagged, reasons: scopeReasons, omitted: 0 },
        worktree: {
          // 경로는 **남겨 둔 경우에만** 싣는다. 회수한 디렉터리를 가리키면 사람은 없는 것을
          // 찾느라 시간을 쓴다.
          ...(keepWorktree ? { path: worktree.path } : {}),
          transplanted: worktree.transplanted,
          ignoredPaths: worktree.ignoredPaths,
          sharedRules: worktree.sharedRules,
        },
        blockers,
        rewrite: { arm: rewriteArm, flips: rewriteFlips },
        // ★ 이 갈래들은 `recordLearning` 보다 **먼저** content 를 만든다. 그래서 `applied` 가
        //   아직 `null` 인데, 이 갈래의 `stopReason` 은 전부 `'blocked'`·`'failed'` 라 등급이
        //   `null` 이고 실제로 아무것도 반영되지 않는다 — `null` 이 사실이다.
        learning: learningView(),
        plan: { provider: chosen.planner.provider.id, content: clip(plan, EXCERPT_CHARS) },
        steps: steps.map((record, index) => (index === steps.length - 1 ? record : stripToExcerpt(record))),
      });

    // ── 최종 패치 ─────────────────────────────────────────────────────────
    phaseStart('patch', 0);
    const patch = await stage('최종 패치 수집', () => collectPatch(worktree));
    if (isBlocked(patch)) {
      // ★ 여기서 워크트리를 지우면 델리게이트의 작업이 통째로 사라진다 — 회수하지 못한
      //   것을 지우지 않는다. 경로를 봉투에 실어 사람이 직접 꺼낼 수 있게 한다.
      keepWorktree = true;
      return await sealFailure({
        status: 'blocked',
        error: patch.error,
        recovery:
          `${patch.recovery ?? GENERIC_RECOVERY} 델리게이트의 작업을 잃지 않으려고 워크트리를 남겼습니다: ` +
          `${worktree.path} (필요 없으면 대상 저장소에서 \`git worktree remove --force\` 로 지우세요).`,
        content: partialContent({ path: null, bytes: 0, empty: null, files: [], ignoredPaths: null, gitlinks: null }),
        worktree: worktree.path,
        stopReason: 'blocked',
      });
    }

    const patchDir = join(runStateRoot, 'patches');
    await mkdir(patchDir, { recursive: true });
    const patchPath = join(patchDir, `${runId}.patch`);
    // ★ Buffer 를 **그대로** 쓴다. utf8 로 풀면 NUL 없는 비 UTF-8 본문(CP949·EUC-KR)이
    //   그 자리에서 U+FFFD 로 깨진다(`src/worktree.mjs` 의 바이트 계약).
    await writeFile(patchPath, patch.patch);

    // ★ M-1. `patches/` 는 실행마다 하나씩 쌓이고 그 파일에는 델리게이트가 만든 소스 전문이
    //   평문으로 들어 있다. **패치를 쓴 직후**에 알린다 — 뒤에 두면 그 사이의 조기 종료
    //   경로에서 이 사실이 사라진다.
    //
    // ★ 문장이 "자동으로 비워지지 않습니다" 였다. 계획 2 이월 2 가 30일 스윕을 넣었으므로
    //   그 말은 이제 거짓이고, 사용자는 이 경로의 파일이 영원히 남는다고 믿게 된다.
    //   보존 기간을 말한다.
    addNotice(
      `최종 패치를 ${patchPath} 에 남겼습니다 — 이 디렉터리는 실행마다 쌓이고, 30일이 지난 것은 ` +
        '다음 실행이나 서버 부팅이 지웁니다. 더 오래 두려면 다른 곳으로 옮기세요.',
    );

    // ★ M-3. 빈 패치는 **항상** 알린다. 예전에는 무시된 경로나 gitlink 가 있을 때만
    //   알려서, 워커가 정말 아무것도 안 한 실행이 notice·recovery 없이
    //   `succeeded / verified` 로 나갔다 — "작업을 끝내고 검증했다" 와 바이트 단위로 같다.
    //   테스트는 변경 전에도 통과했으므로 그 `verified` 는 아무것도 증명하지 않고,
    //   §7 학습 계층에는 "아무것도 하지 않아도 최고 등급" 이 기록된다.
    // ★ 학습 등급이 읽는 사실. `unverified` 와 **따로** 적는다 — 그 플래그는 실행 단위로
    //   끈끈해서 "이 실행이 아무것도 안 했다" 와 "중간에 워커가 한 번 죽었다" 를 뭉갠다.
    patchEmpty = patch.empty === true;
    if (patch.empty) {
      unverified = true;
      addNotice(
        '최종 패치가 비어 있습니다 — 워커가 워크트리에 남긴 변경이 없습니다. ' +
          `무시 규칙에 걸린 경로(${few(patch.ignoredPaths)})와 gitlink(${few(patch.gitlinks)}) 의 내용은 ` +
          '패치에 실리지 않으므로, 그 둘이 비어 있을 때만 "성과 0" 으로 읽을 수 있습니다.',
      );
    }
    if (patch.ignoredPaths === null || patch.gitlinks === null) {
      addNotice('무시된 경로 또는 gitlink 목록을 확인하지 못했습니다 — 패치에 안 실린 변경이 있는지 모릅니다.');
    }

    // ── 최종 스코프 검사 (배선 숙제 7) ────────────────────────────────────
    phaseStart('scope', 0);
    const finalScope = await stage('최종 스코프 검사', () =>
      inspectPatch({ files: patch.files, worktree: worktree.path, baseline: worktree.baseline }));
    if (isBlocked(finalScope)) {
      return await sealFailure({
        status: 'blocked',
        error: finalScope.error,
        recovery: `${finalScope.recovery ?? GENERIC_RECOVERY} 패치는 파일로 남겼습니다: ${patchPath}`,
        content: partialContent({
          path: patchPath,
          bytes: patch.patch.length,
          empty: patch.empty,
          files: patch.files,
          ignoredPaths: patch.ignoredPaths,
          gitlinks: patch.gitlinks,
        }),
        patchPath,
        stopReason: 'blocked',
      });
    }
    if (finalScope.flagged) noteScope(finalScope);

    // ── 신뢰도와 학습 등급 ────────────────────────────────────────────────
    //
    // ★★ content 를 만들기 **전에** 여기서 판정하고 기록한다. 계획 2 에서는 신뢰도 계산이
    //    `renderContent` 뒤에 있었는데, `content.learning.applied` 는 "**실제로** 사후분포에
    //    반영한 것" 이라 기록이 렌더보다 먼저여야 한다. 뒤로 미루면 봉투가 "반영했다" 고
    //    적어 놓고 실제로는 갱신에 실패한 실행이 나온다 — 태스크 10 이 그 봉투를 믿고
    //    되돌리면 없는 기여를 뺀다.
    const lastTests = steps.at(-1)?.tests;
    // 신뢰도. 스코프 플래그가 `disputed` 를 만들고, `envelope.mjs` 의 `success()` 가 그것을
    // `failed` 로 강등한다 — 여기서 다시 구현하지 않는다.
    if (lastTests?.passed !== true) unverified = true;

    // ★★ I-5. 델리게이트가 **테스트 정의를 위조해 거부된** 실행은 `disputed` 다.
    //    §12.-1 아키텍처 전체가 잡으려고 만들어진 사건인데 `succeeded` 로 내면, §7 보상
    //    신호가 "테스트 정의를 고치면 succeeded 를 받는다" 를 학습시킨다 — 워커에게서
    //    Bash 를 뺀 이유를 보상 쪽에서 되돌려 주는 셈이다. `envelope.mjs` 가 `disputed` 를
    //    `failed` 로 강등하는 근거가 그대로 적용된다. "작업을 버리지 않는다" 는 취지는
    //    patch 경로와 recovery 로 이미 지켜진다 — 바뀌는 것은 status 뿐이다.
    const confidence =
      scopeConfidence !== null
        ? scopeConfidence
        : stopReason === 'test-definition-changed'
          ? 'disputed'
          : unverified
            ? 'unverified'
            : 'verified';

    await recordLearning(stopReason);

    // ★ 순서가 중요하다. `envelope.mjs` 는 상한을 넘는 content 를 **꼬리부터** 자르므로
    //   요약(무엇이 나왔나·무엇이 걸렸나)을 앞에, 긴 본문(계획·스텝별 답변)을 뒤에 둔다.
    const payload = {
      runId,
      stopReason,
      stepCount: steps.length,
      patch: {
        path: patchPath,
        bytes: patch.patch.length,
        empty: patch.empty,
        files: patch.files,
        ignoredPaths: patch.ignoredPaths,
        gitlinks: patch.gitlinks,
      },
      // ★ 최종 검사의 판정만 싣지 않는다. 스텝 검사가 플래그해서 루프가 조기에 끊긴 실행은
      //   최종 검사가 통과하는 것이 정상인데(그 스텝의 변경이 최종 패치에 없을 수도 있다),
      //   그러면 봉투 최상위가 "스코프 문제 없음" 이라고 말하면서 confidence 만 disputed 가
      //   된다. `scope` 는 이 실행의 누적 판정이다.
      scope: {
        flagged: scopeFlagged,
        reasons: scopeFlagged ? scopeReasons : finalScope.reasons,
        omitted: finalScope.omitted,
      },
      worktree: {
        transplanted: worktree.transplanted,
        ignoredPaths: worktree.ignoredPaths,
        sharedRules: worktree.sharedRules,
      },
      blockers,
      // ★ §7.2 결정③ 이 **실제로** 무엇을 했는가. `arm` 은 이 실행이 돈 팔이고 `flips` 는
      //   뒤집기가 배치를 실제로 바꾼 횟수다 — `arm:'wide'` 인데 `flips:0` 이면 그 축은 이
      //   실행에서 무연산이었다(벤더 하나 · 역할 전부 지정 · budget 1 · 첫 스텝에서 종료).
      //   태스크 8 이 그런 실행의 `rewrite` 셀을 갱신할지 여기 값을 보고 정한다.
      rewrite: { arm: rewriteArm, flips: rewriteFlips },
      // ★ §7 학습이 **이 실행에서** 무엇을 골랐고 무엇을 배웠나. `applied.axes` 가 비어 있으면
      //   이 실행은 어느 셀도 갱신하지 않았다(등급이 없거나 · 그 축이 무연산이었다).
      learning: learningView(),
      plan: { provider: chosen.planner.provider.id, content: clip(plan, EXCERPT_CHARS) },
      // 마지막 스텝만 본문을 온전히 남긴다 — 옛 스텝까지 다 실으면 상한을 넘겨
      // `renderContent` 가 본문을 통째로 버려야 한다.
      steps: steps.map((record, index) => (index === steps.length - 1 ? record : stripToExcerpt(record))),
    };

    const content = renderContent(payload);

    if (stopReason === 'deadline') {
      return await sealFailure({
        status: 'deadline_exceeded',
        error: `데드라인(${effectiveWaitMs}ms)이 지나 중단했습니다. 스텝 ${steps.length}/${budget} 까지 돌았습니다.`,
        recovery:
          'wait_ms 를 늘리거나 budget 을 줄여 다시 시도하세요. ' +
          `지금까지의 작업은 패치 파일로 남겼습니다: ${patchPath}`,
        content,
        stopReason,
      });
    }

    if (blockers.length > 0) {
      const first = blockers[0];
      return await sealFailure({
        status: 'blocked',
        error: `${first.where}: ${first.error}`,
        recovery: `${first.recovery ?? GENERIC_RECOVERY} 지금까지의 작업은 패치 파일로 남겼습니다: ${patchPath}`,
        content,
        stopReason,
      });
    }

    // ★ 이 문장은 조기 종료 봉투(위 deadline·blockers)에는 붙지 않는다 — 그 갈래의 원인은
    //   테스트 실패가 아니라 데드라인·blocker 이고, 그 사실은 `error` 가 이미 말한다.
    //   그래서 신뢰도 계산과 달리 이 자리에 남겨 둔다.
    if (lastTests?.ran === true && lastTests.passed === false) {
      addNotice('테스트가 실패했습니다 — 이 패치는 검증을 통과하지 못했습니다.');
    }

    const recovery = buildRecovery({ stopReason, scopeRecovery, confidence, patchPath, lastTests });

    // 회수·관측·원장을 봉투를 만들기 **전에** 지난다 — `seal` 이 그때의 notice 를 읽는다.
    await release();
    return seal(success({ content, confidence, ...(recovery !== null ? { recovery } : {}) }), stopReason);
  } catch (error) {
    // ★ 여기까지 온 것은 우리 버그다. 아직 회수하지 않았다면 지우지 않는다 — 패치를 못 뽑은
    //   상태이므로 지우면 델리게이트의 작업이 통째로 사라진다. 위 `collectPatch` 실패 경로와
    //   같은 판단이고, 경로를 봉투에 실어 사람이 직접 꺼낼 수 있게 한다.
    //   ★ 이미 회수한 뒤에 던진 경우에는 "남겼습니다" 가 거짓이다 — 봉투가 없는 디렉터리를
    //     가리키면 사람은 그것을 찾느라 시간을 쓴다. 오늘 `release()` 뒤에 남은 문장은
    //     `seal(success(…))` 하나뿐이라 이 갈래는 사실상 도달하지 않는다(그래서 뮤테이션에서
    //     살아남는다). 회수 뒤에 문장이 늘면 그때부터 발화한다.
    const kept = released === false;
    keepWorktree = kept;
    return await sealFailure({
      status: 'failed',
      error: `오케스트레이션이 예기치 못한 오류로 멈췄습니다: ${safeText(error)}`,
      recovery: kept
        ? '서버 로그를 확인한 뒤 다시 시도하세요. 델리게이트의 작업을 잃지 않으려고 워크트리를 남겼습니다: ' +
          `${worktree.path} (필요 없으면 대상 저장소에서 \`git worktree remove --force\` 로 지우세요).`
        : '서버 로그를 확인한 뒤 다시 시도하세요. 워크트리는 이미 회수했습니다.',
      ...(kept ? { worktree: worktree.path } : {}),
      stopReason: 'failed',
    });
  } finally {
    deadline?.removeEventListener?.('abort', onDeadlineAbort);
    // 마지막 그물. 어느 경로로 나가도 회수·관측·원장을 지나게 한다 — `release` 는 한 번만
    // 돈다. 여기서 처음 도는 것은 위의 `return` 들을 지나지 않은 경우(우리 버그)뿐이고,
    // 그때 붙는 notice 는 이미 만들어진 봉투에 닿지 않는다(그래서 각 return 이 먼저 부른다).
    await release().catch(() => {});
    // 정상 경로는 플래너 직후에 이미 치웠고 실패도 거기서 알린다 — 여기서 알려도 봉투에는
    // 닿지 않는다.
    await rm(planDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 옛 스텝은 본문을 짧게 남긴다 — 상한을 넘기면 잘린 JSON 이 나간다. */
function stripToExcerpt(record) {
  const out = { ...record };
  if (out.worker) out.worker = { ...out.worker, content: clip(out.worker.content, OLD_STEP_EXCERPT_CHARS) };
  if (out.verifier) out.verifier = { ...out.verifier, content: clip(out.verifier.content, OLD_STEP_EXCERPT_CHARS) };
  if (out.tests) out.tests = { ...out.tests, output: clip(out.tests.output, OLD_STEP_EXCERPT_CHARS) };
  return out;
}

/** 델리게이트에게 보여 줄 테스트 결과 한 덩어리. */
function describeTests(tests) {
  if (tests.ran !== true) return `실행하지 못했습니다 — ${tests.reason ?? '사유 불명'}`;
  return [
    `통과: ${tests.passed === true ? '예' : tests.passed === false ? '아니오' : '모름'}`,
    `종료 코드: ${tests.exitCode}${tests.exitCodeExact === false ? ' (정확한 값이 아님)' : ''}`,
    tests.output ?? '',
  ].join('\n');
}

/**
 * 테스트 단계 하나. 러너의 blocked 봉투를 두 갈래로 나눈다 (배선 숙제 5).
 *
 *   · `definitionCheck` 가 실린 거부 — 워크트리의 테스트 정의가 고정값과 다르다. 델리게이트가
 *     **정당하게** 고친 경우도 여기로 온다. 실패로 끝내면 그 작업이 버려지므로 사람에게 넘긴다.
 *   · 그 밖의 거부 — 인자·워크트리 문제다. 그대로 blocker.
 */
async function runStepTests({ testPlan, worktree, runId, deadline, register, runTests, phaseStart, step, stage }) {
  phaseStart('tests', step);

  if (testPlan === null) {
    return {
      record: {
        ran: false,
        passed: null,
        confidence: 'unverified',
        reason:
          '이 프로젝트에서 테스트 명령을 유도하지 못했습니다 — 추측해서 엉뚱한 명령을 돌리지 않습니다. 검증은 사람이 해야 합니다.',
      },
      unverified: true,
      definitionRejected: false,
      blocked: null,
    };
  }
  if (typeof testPlan.command !== 'string' || testPlan.command === '') {
    return {
      record: {
        ran: false,
        passed: null,
        confidence: 'unverified',
        reason: testPlan.resolveError ?? '테스트 도구를 PATH 에서 찾지 못했습니다.',
      },
      unverified: true,
      definitionRejected: false,
      blocked: null,
    };
  }

  const result = await stage('테스트 실행', () =>
    runTests({
      ...testPlan,
      worktree: worktree.path,
      runId,
      signal: deadline,
      onSpawn: register,
    }),
  );

  if (isBlocked(result)) {
    const check = result.definitionCheck;
    if (typeof check === 'string' && check !== '') {
      return {
        record: {
          ran: false,
          passed: null,
          confidence: 'unverified',
          definitionCheck: check,
          reason: result.error,
        },
        unverified: true,
        definitionRejected: true,
        blocked: null,
      };
    }
    return {
      record: { ran: false, passed: null, confidence: 'unverified', reason: result.error },
      unverified: true,
      definitionRejected: false,
      blocked: { where: 'runTests', error: result.error, recovery: result.recovery },
    };
  }

  return {
    record: {
      ran: result.ran,
      passed: result.passed,
      exitCode: result.exitCode,
      exitCodeExact: result.exitCodeExact,
      launcher: result.launcher,
      source: result.source,
      definitionCheck: result.definitionCheck,
      timedOut: result.timedOut,
      aborted: result.aborted,
      hung: result.hung,
      lingering: result.lingering,
      confidence: result.confidence,
      notes: result.notes,
      durationMs: result.durationMs,
      output: clip(result.output, TEST_OUTPUT_CHARS),
    },
    unverified: result.confidence !== 'verified',
    definitionRejected: false,
    blocked: null,
  };
}

/**
 * 호출자가 다음에 무엇을 해야 하는지. 없으면 null(성공 봉투에는 recovery 가 필수가 아니다).
 *
 * `disputed` 로 강등되는 경우 `success()` 가 recovery 를 요구하므로 반드시 채운다.
 */
function buildRecovery({ stopReason, scopeRecovery, confidence, patchPath, lastTests }) {
  if (scopeRecovery !== null && scopeRecovery !== undefined) {
    return `${scopeRecovery} 패치는 적용하지 않았습니다: ${patchPath}`;
  }
  if (stopReason === 'test-definition-changed') {
    return (
      '워크트리의 테스트 정의가 고정값과 달라 테스트를 돌리지 않았습니다. 델리게이트의 수정이 정당한 것일 수 ' +
      `있으므로 작업은 버리지 않고 패치로 남겼습니다: ${patchPath}. 그 변경을 사람이 확인하고, 정당하다면 ` +
      '프로젝트 쪽 테스트 정의를 갱신한 뒤 다시 유도해서(재유도) 실행하세요.'
    );
  }
  if (confidence === 'unverified') {
    const why =
      lastTests?.ran === true && lastTests.passed === false
        ? '테스트가 실패했습니다.'
        : (lastTests?.reason ?? '검증을 끝내지 못했습니다.');
    return `${why} 패치를 적용하기 전에 결과를 직접 확인하세요: ${patchPath}`;
  }
  return null;
}
