/**
 * 재개의 관문 **셋**과 그 산술 하나 — 「지목된 실행이 있고 읽히는가」, 「환경 지문이 같은가」,
 * 「baseline 트리가 같은가」, 그리고 「이 실행이 쓸 시도가 남아 있는가」.
 *
 * WS8 컷 2 가 `src/engine.mjs` 의 `prepareRunNamespace` 에서 뽑았다(로드맵 §3.11).
 *
 * ★★ **왜 별도 모듈인가.** 셋의 **자리**가 곧 계약이다(§0-R1): 첫째는 사전 점검보다 앞(없는
 *   실행을 재개하려는 호출이 벤더 CLI 를 깨운 뒤에 거부되면 안 된다)이고 보존 스윕보다도
 *   앞이며, 둘째는 워크트리 앞(지문은 워크트리 없이 알 수 있다), 셋째는 lane-a 워크트리
 *   **뒤**다(트리 해시는 그 전에 존재하지 않는다). 그 셋이 엔진 본문에 1,200줄 간격으로
 *   흩어져 있는 동안, 「왜 여기인가」를 적은 ★★ 주석들은 서로를 「위/아래」로만 가리켰다.
 *   한 파일에 모으면 그 논증이 한 화면에 들어오고, 관문을 하나 더 붙이거나 순서를 바꾸려는
 *   사람이 셋을 한꺼번에 본다. **새 재개 판정은 이 파일로 들어간다.**
 *
 * ★ 재사용은 **읽기**다(§5.14). 이 파일은 원본 실행에 한 바이트도 쓰지 않는다 — 유일한 I/O 는
 *   `readRunManifest` 한 번이고, 나머지 셋은 순수 비교다.
 *
 * ★ 반환 규약은 `src/run-precredit-gates.mjs` 와 같다: `{ refusal, …산출 }` 이고 `refusal` 이
 *   `null` 이면 통과다. 엔진이 그 봉투를 자기 `halt` 로 감싼다.
 *
 * ★ `cleanupWorktrees` 와 `envelopeExtras` 는 **함수로** 받는다. 관문 셋의 거부가 치울 워크트리
 *   목록과 봉투에 실을 알림 앞부분은 부르는 자리가 알고 이 파일은 모른다.
 *
 * ★ 이 파일은 `src/engine.mjs` 를 import 하지 않는다(순환 금지).
 */
import { failure } from './envelope.mjs';
import { REASON } from './reason-codes.mjs';
import { renderNotice } from './reason-text.mjs';
import { artifactBlocked, statusOfReasonCode } from './run-faults.mjs';
// 재개가 원본 실행을 읽는 유일한 경로(WS3 §0-D2). 저장소 핸들은 그 프로세스와 함께 죽었다.
import { readRunManifest } from './run-read.mjs';
import { deepFreeze } from './util/freeze.mjs';

/**
 * 재개 거부 봉투 하나(WS3 §3). 넷 다 **아무것도 시작하지 않은** 실행이라 status 는 코드가 정하고
 * (전부 조악 `blocked`), 문장의 주어는 지목된 실행이다 — 봉투의 `runId` 는 방금 이름을 받은 이
 * 실행이므로, 원본의 이름은 문구의 `{runId}` 인자로만 실린다.
 */
function resumeRefused(runId, reasonCode, resumeRunId, extras) {
  return failure({
    status: statusOfReasonCode(reasonCode), runId, reasonCode, params: { runId: resumeRunId }, ...extras,
  });
}

/**
 * 관문 1 — 지목된 실행의 매니페스트를 읽는다. 재개가 아닌 호출은 `resumeSource: null` 로 통과한다.
 * `envelopeExtras` 는 아직 스윕 전이라 인자 없이 불린다.
 */
export async function openResumeSource({ runOptions, stateRoot, runId, envelopeExtras }) {
  // ★★ 재개의 첫 관문(WS3 §0-R1): 지목된 실행이 **있고 읽히는가**. 이 자리인 이유 둘. (a) 사전
  //   점검보다 앞이다 — 없는 실행을 재개하려는 호출이 벤더 CLI 를 전부 깨운 뒤에야 거부되면, 그
  //   봉투는 자기가 못 찾은 실행이 아니라 벤더 문제로 읽힌다. (b) 보존 스윕(아래)보다 앞이다 —
  //   만료된 원본은 **이 실행의 스윕**이 지울 수 있고, 그러면 방금 있던 실행이 읽는 중에 사라진다.
  // ★ 재사용은 읽기다(§5.14): 이 층은 원본에 한 바이트도 쓰지 않고, 아래 두 관문도 마찬가지다.
  const resumeRunId = runOptions.resumeRunId;
  let resumeSource = null;
  if (resumeRunId !== undefined) {
    const read = await readRunManifest({ stateRoot, runId: resumeRunId });
    if (read.ok !== true) {
      // 「그 이름의 실행이 없다」와 「있는데 못 읽는다」는 다른 답이고 다음 행동도 다르다.
      const reasonCode = read.reasonCode === REASON.status_run_not_found
        ? REASON.resume_run_not_found
        : REASON.resume_manifest_unreadable;
      return { refusal: resumeRefused(runId, reasonCode, resumeRunId, envelopeExtras()) };
    }
    resumeSource = read.manifest;
  }
  return { refusal: null, resumeRunId, resumeSource };
}

/** 관문 2 — 환경 지문. 순수 비교이고 치울 것이 없다. */
export function refuseEnvironmentDrift({ resumeSource, frozenTestPlan, runId, resumeRunId, envelopeExtras }) {
  // ★★ 재개의 둘째 관문: 환경 지문. 워크트리보다 **앞**이다 — 지문은 워크트리 없이 알 수 있는
  //   사실이라 이 자리가 가장 이르고, 거부에 치울 것이 하나도 남지 않는다. 둘 다 어긋난 호출은
  //   이 답을 먼저 받는다: 같은 계획조차 동결할 수 없는 실행에 baseline 을 묻는 것은 순서가 뒤다.
  if (resumeSource !== null &&
      resumeSource.frozenTestPlan.environmentFingerprint !== frozenTestPlan.environmentFingerprint) {
    return { refusal: resumeRefused(runId, REASON.resume_environment_mismatch, resumeRunId, envelopeExtras()) };
  }
  return { refusal: null };
}

/**
 * 재개가 이어 쓸 서수 **하나**와 재사용된 attempt 수 — 원본이 **봉인한** 마지막 서수의 다음부터
 * 쓴다(§0-R1 「재개도 새 attempt 를 만든다」).
 *
 * ★ 예산은 새 호출의 값이고 재사용된 만큼 차감된다(WS0 §1.2): 레인의 루프가 `startOrdinal` 부터
 *   `budget` 까지 도므로, 예산 3 에 둘을 재사용한 레인은 시도 하나만 더 쓴다. 원본이 예산보다 더
 *   많이 썼으면 남는 시도가 없고, 그 실행은 아무 벤더도 부르지 않은 채 예산 소진으로 끝난다 —
 *   지어낼 것이 없다는 뜻이고, 그 사실은 알림이 이미 말한다.
 * ★★ **`terminal` 만 센다**(최종 리뷰 I4). attempt 는 할당 시점에 `{status:'allocated',
 *   attemptRef:null}` 로 매니페스트에 실리고 나중 체크포인트에서만 terminal 이 된다 — 그 사이에
 *   프로세스가 죽거나 attempt 산출물 쓰기가 실패하면 완벽히 읽히는 매니페스트에 봉인되지 않은
 *   꼬리가 남는다. 그것을 세면 writer 출력도 패치도 피드백도 없는 시도 하나가 서수와 예산 한 칸을
 *   먹고, 알림은 「봉인한 N 개를 읽었다」고 거짓을 말한다. 계약(`contract/tools.json`·`src/tools.mjs`
 *   ·`distribution/CHANGELOG.md`)이 한결같이 적는 낱말이 **sealed** 다.
 * ★★ **서수는 레인마다가 아니라 실행 전체에서 하나**다(최종 리뷰 I5). 원본의 레인들이 서로 다른
 *   서수에서 멈추는 것은 정상이고(이른 검증·정체·마감·취소 — 레인은 독립이고 accept 에서 끊긴다),
 *   재개는 소스의 패치도 검증 피드백도 나르지 않으므로(§0.1-3) 그 서수는 이 실행의 레인에게 아무
 *   것도 사 주지 않는다. 레인별로 물려주면 한 레인은 새 시도를 둘, 다른 레인은 셋 받는 **기울어진
 *   A/B** 가 되고, 그 비교가 그대로 밴딧의 사후분포로 들어간다(`commitRunLearning` 은 재개 표시를
 *   따로 안 받았다 — 아래 `resumedFrom` 이 그 자리다). 최대값으로 맞추면 두 레인이 같은 baseline
 *   에서 **같은 수의** 시도를 받는다. 낮은 쪽으로 맞추는 것은 답이 아니다: 이미 봉인된 서수를 다시
 *   돌리게 되고 그것이 §5.14 위반이다.
 */
function resumeStarts(manifest, { candidateCount, budget }) {
  const laneIds = candidateCount === 2 ? ['lane-a', 'lane-b'] : ['lane-a'];
  const sealed = manifest.attempts.filter((entry) => entry.status === 'terminal');
  const lastSealed = (laneId) => sealed.reduce(
    (highest, entry) => entry.laneId === laneId && entry.ordinal > highest ? entry.ordinal : highest, 0);
  const startOrdinal = Math.max(...laneIds.map((laneId) => lastSealed(laneId) + 1));
  return deepFreeze({
    from: manifest.runId,
    reusedAttempts: sealed.length,
    startOrdinal,
    // 알림의 인자를 여기서 **한 번** 짓는다: 이 문장을 부르는 자리가 둘이고(예산 소진 halt 와
    // 종료 경로의 `baseNotices`), 인자 목록이 갈리면 같은 실행이 두 문장을 말한다.
    // 「내 레인은 몇 번 더 도는가」는 재사용 수만으로는 못 읽는 값이라 `fresh` 가 따로 있다.
    noticeParams: {
      source: manifest.runId,
      reused: sealed.length,
      startOrdinal,
      fresh: Math.max(budget - startOrdinal + 1, 0),
    },
  });
}

/**
 * 관문 3 — baseline 트리 해시. 통과하면 이 실행이 이어 쓸 서수 하나를 함께 낸다(`resume`).
 * 거부는 방금 만든 워크트리를 `cleanupWorktrees` 로 도로 치운다.
 */
export async function startResume({
  resumeSource, resumeRunId, baseline, candidateCount, budget, runId, cleanupWorktrees, envelopeExtras,
}) {
  // ★★ 재개의 셋째 관문: baseline 의 **트리 해시**. baseline 은 lane-a 워크트리가 HEAD 를 고정한
  //   **뒤에야** 알 수 있는 사실이라(그 위에는 이 값이 존재하지 않는다) 이 자리가 가장 이르고,
  //   거부는 방금 만든 워크트리 하나를 도로 치운다. 두 번째 레인은 아직 만들지 않았다.
  // ★★ **커밋 반쪽은 정체성이 아니다**(최종 리뷰 C1). `createWorktree` 는 작업 트리에 스테이징할
  //   것이 하나라도 있으면 `bom-orch baseline <runId>` 라는 메시지로 합성 커밋을 하나 찍는다
  //   (`src/worktree.mjs` 의 `commitAll`) — 메시지에 runId 가 들어 있고 커밋 객체에는 벽시계가
  //   들어 있어서, **같은 바이트의 트리**를 두 번 준비해도 커밋 sha 는 절대 같지 않다. 그래서
  //   커밋을 열쇠로 쓰면 미커밋 편집이 하나라도 있는 프로젝트에서는 재개가 영영 성립하지 않고
  //   (재시도마다 커밋이 또 새로 생긴다), 거부 문장은 「다른 소스 트리를 서술한다」고 거짓을
  //   말한다 — 트리 해시는 같기 때문이다. 실측: 깨끗한 트리에서만 `commitAll` 이 HEAD 로 단락돼
  //   두 실행의 커밋이 같았고, 추적 파일 수정 하나 또는 무시되지 않은 미추적 파일 하나로 갈렸다.
  //   내용 동일성을 나르는 것은 **트리**다 — 같은 근거로 `src/regression-proof.mjs` 도 증거 id 를
  //   `spec.baseline.tree` 로 짓는다. 관문은 여전히 둘이다: 이 트리 해시 **와** 위의
  //   `environmentFingerprint`(§0-R1 의 「정확한 정체성 둘」).
  const resume = resumeSource === null ? null : resumeStarts(resumeSource, { candidateCount, budget });
  if (resumeSource !== null && resumeSource.baseline.tree !== baseline.tree) {
    const cleanup = await cleanupWorktrees('resume baseline mismatch');
    return { refusal: resumeRefused(runId, REASON.resume_baseline_mismatch, resumeRunId,
      envelopeExtras(cleanup.notices)) };
  }
  return { refusal: null, resume };
}

/** 재개에 남은 방이 있는가 — 관문이 아니라 **산술**이고, 답은 예산 소진이다. */
export async function refuseWhenNoResumeRoom({ resume, budget, runId, cleanupWorktrees, envelopeExtras }) {
  // ★★ 재개에 **남은 방이 없는** 실행(WS3 태스크 11 수정 라운드 Q1). 예산은 이 호출의 값이고
  //   재사용된 서수만큼 차감되므로(WS0 §1.2), 원본이 예산 이상을 썼으면 이 실행이 쓸 시도가
  //   하나도 없다. 그것은 산술이지 결함이 아니고, 답은 **예산 소진**이다. 예산이 원본의 봉인
  //   수보다 적어도 같은 답이다 — 재사용은 상한까지이고 그 뒤엔 방이 없다.
  // ★★ 왜 레인을 돌리기 **전에** 끝내는가. 시도가 하나도 없는 레인의 후보 ref 는 가리킬 attempt
  //   를 갖지 못하고, 저장소는 그런 ref 를 옳게 거절한다(`applyCandidateRecorded`: 후보가 아무
  //   attempt 도 안 가리키려면 그 레인이 blocked 여야 한다). 그리고 선택 이벤트는 레인 수만큼의
  //   후보 ref 를 요구한다(`applySelectionRecorded`) — 즉 방이 없는 레인이 하나라도 있으면 이
  //   실행은 어차피 선택을 기록하지 못한다. 그 사실을 레인이 벤더를 태운 **뒤에** 알면 봉투는
  //   「후보 체크포인트를 기록하지 못했다 · 상태 루트가 온전한지 확인하라」로 나갔다(리뷰가 잰
  //   것이 그것이다): 예산 산술을 저장소 손상으로 읽게 만드는 문장이다. 여기서 끝내면 벤더 호출
  //   0 회로 정확한 답이 나가고, 저장소의 거절(그 가드는 옳다)은 손댈 것이 없다.
  // ★ 자리는 재개 관문 **셋 다음**이다: 정체성이 어긋난 원본은 「방이 없다」가 아니라 자기
  //   이름의 거부를 받아야 한다.
  if (resume !== null && resume.startOrdinal > budget) {
    const cleanup = await cleanupWorktrees('resume budget exhausted');
    // 알림은 이 봉투에도 실린다 — 종료 경로(`src/run-finalization.mjs` 의 `baseNotices`)가 짓는
    // 그 문장이고, 이 실행은 거기까지 가지 않으므로 여기서 같은 정본을 부른다.
    return { refusal: artifactBlocked(runId, REASON.lane_budget_exhausted, {}, envelopeExtras([
      renderNotice('resume_attempts_reused', resume.noticeParams),
      ...cleanup.notices,
    ])) };
  }
  return { refusal: null };
}
