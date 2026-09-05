/**
 * 벤더에게 보내는 지시문 — 저장소에서 **한국어가 허용되는 유일한 `src/` 경로**.
 *
 * 로드맵 §5.8 은 "벤더에게 보내는 프롬프트" 를 언어 게이트 **밖**에 둔다. WS1 까지 그 예외는
 * `src/engine.mjs` 안의 줄 번호로만 존재했고, 그래서 게이트는 파일이 아니라 리터럴 49개를
 * 이름으로 봐줘야 했다. 이 모듈은 그 예외를 **경로**로 만든다:
 * `contract/runtime-surface.json` 의 `runtime.code.exclude` 에 `src/prompts/**` 한 줄.
 *
 * ★ 벤더별 파일이 아니다(WS2 spec §0). 리서치가 세어 보니 프로바이더마다 다른 프롬프트 문구는
 *   **한 곳도 없었다** — 벤더 차이는 argv 빌더(`providers/claude-args.mjs`·`codex-args.mjs`)와
 *   스트림 파서에 산다. 그래서 `prompts/{claude,codex}.mjs` 는 만들지 않는다: 내용 없이 이름만
 *   있는 모듈은 줄 수 래칫과 고아 테스트 가드가 대신 짊어질 빚이다.
 * ★ 여기의 문장이 바뀌면 델리게이트의 행동이 바뀐다. 리팩터로 문구를 "다듬지" 마라 —
 *   `test/prompts-instructions.test.mjs` 가 한글 존재를, `test/engine.test.mjs` 와
 *   `test/candidate-lanes.test.mjs` 가 개별 문구(`BINDING_JSON:` · `앞선 답은 형식이 틀렸습니다.`)를
 *   못박고, 같은 파일의 **EC-6 삭제-판별 게이트**가 워커의 scope 고지 네 줄을 못박는다.
 * ★ 그리고 워커 지시문의 **길이**는 상수다: `src/preflight.mjs` 의
 *   `CODEX_WORKER_PROMPT_OVERHEAD_CHARS` 가 이 함수의 포화 산출을 실측값으로 들고 있고
 *   `test/preflight.test.mjs` 가 그것을 등식으로 잰다 — 한 글자를 더하면 그 상수도 같은 커밋에서
 *   다시 재야 한다(codex 는 지시문을 argv 로 받으므로 그 수가 곧 명령줄 예산이다).
 */

import { clipCounted } from '../util/strings.mjs';

/**
 * 프롬프트에 싣는 발췌 하나의 상한. 계획·피드백·테스트 결과가 모두 이 한도를 쓴다.
 *
 * ★ engine 도 이 값을 쓴다(플래너 답을 `plan` 으로 접을 때) — 두 곳이 다른 상한을 쓰면
 *   플래너가 낸 계획이 워커 프롬프트에서 한 번 더 잘린다. 그래서 정의는 여기 하나다.
 */
export const EXCERPT_CHARS = 1_200;

/**
 * @param evidence §7.5 의 근거 문단(`decide().evidence`). **지시문 앞에** 붙는다.
 *
 * ★ 앞에 두는 이유: 이 문단은 "이 저장소에서 실제로 관찰된 사실" 이고 계획을 세우기 전에
 *   읽혀야 한다. 뒤에 붙이면 긴 작업 설명 뒤로 밀린다.
 * ⚠ 문단은 **밴딧이 고른 축만** 말한다. 호출자가 축을 직접 지정하면(`options.decisions`)
 *   그 축은 문단에 안 나오거나, 밴딧이 골랐던 다른 팔이 적혀 있을 수 있다 — 문단은 결정의
 *   근거이지 이번 실행의 배치 기록이 아니다. 배치 기록은 `content.learning.decisions` 다.
 */
export function plannerInstruction({ task, testPlan, evidence }) {
  const testLine =
    testPlan === null || testPlan?.source === null
      ? '이 프로젝트에서는 테스트 명령을 유도하지 못했습니다 — 검증은 사람이 합니다.'
      : `테스트는 오케스트레이터가 직접 돌립니다: ${testPlan.source}의 고정된 테스트 계획입니다.`;
  return [
    ...(typeof evidence === 'string' && evidence !== '' ? [clipCounted(evidence, EXCERPT_CHARS), ''] : []),
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

/**
 * ★★ **scope 고지 네 줄은 영어다** — 이 파일에서 유일하게. WS5 Task 5(종료 기준 EC-6).
 *
 * 정책을 말하지 않던 판에서 델리게이트는 스텝과 크레딧을 전부 쓴 **뒤에** 컷에서 거부당했다.
 * 문단이 서술하는 것은 컷이 실제로 하는 일 그대로다(스펙 §0 D1·D1a·D12): 승격 불가 하드 코어는
 * 허용목록이 이름을 불러도 안 지워지고, lockfile 과 편집기·에이전트 설정은 **적혔을 때만**
 * 통과하며, 통과한 뒤에도 봉투의 `scope.flagged` 는 참으로 남는다.
 *
 * ★ 왜 영어인가: 나머지 문장은 사람이 쓴 태스크를 옮기는 산문이지만 이 넷은 **정책의 축자
 *   서술**이고, 정본(계약 문구 · `scope.allow` 스키마 설명 · 봉투의 사유)이 전부 영어다.
 *   번역본을 하나 더 두면 그 번역이 정본과 갈리는 날 델리게이트만 낡은 말을 듣는다.
 * ★ 수를 적지 않는다. 「CI 다섯」·「lockfile 열」은 표지가 하나 늘어난 날 거짓이 되고, 프롬프트는
 *   붉어질 자리가 없다 — 그래서 개수 대신 **부류**로 말한다(테스트가 숫자 금지를 잰다).
 */
export function workerInstruction({ task, plan, step, budget, feedback }) {
  const lines = [
    `작업: ${task}`,
    '',
    '계획:',
    clipCounted(plan, EXCERPT_CHARS),
    '',
    `이번은 ${step}/${budget} 번째 스텝입니다. 일회용 워크트리는 패치 격리 경계입니다.`,
    'OS 샌드박스가 아니므로 바깥 파일·네트워크 접근을 막는다고 가정하지 마세요. 셸은 없습니다.',
    '테스트는 이 실행이 끝난 뒤 오케스트레이터가 직접 돌립니다. 테스트 정의(package.json 의',
    'scripts.test, Makefile 의 test 타깃, pytest 설정 등)를 고치지 마세요 — 고치면 실행이 거부됩니다.',
    'Scope policy: never edit CI directories, git hooks, shell or package-manager config, build config,',
    'or test-command config. Those paths run commands after apply, so they are refused and no allowlist clears them.',
    'Lockfiles and editor or agent config directories pass only when the caller has already allowlisted the path;',
    'never write an allowlist yourself. Allowlisted edits still ship flagged as out of scope in the result.',
  ];
  if (feedback !== null) {
    lines.push('', '앞 스텝의 결과:', clipCounted(feedback, EXCERPT_CHARS));
  }
  return lines.join('\n');
}

/**
 * 피드백에 싣는 이슈 본문 **하나**의 상한. 슬롯 전체는 `EXCERPT_CHARS` 가 다시 자른다.
 *
 * ★ 둘이 따로 있는 이유: 본문 하나가 슬롯을 다 먹으면 두 번째 이슈부터는 ID 조차 안 실린다.
 *   400 이면 1,200 안에 본문 둘과 세 번째의 머리가 들어간다. 저장 상한(`MAX_ISSUE_CLAIM_CHARS`
 *   500)을 안 쓰는 이유는 그 값을 수입하면 기록 모듈이 프롬프트 폐포에 들어오기 때문이다.
 */
export const FEEDBACK_CLAIM_CHARS = 400;

/** 기계 증거 문단 안의 실패 테스트 이름 줄 상한 — 문단의 다른 줄(실행·판정·증거 ID)이 밀려나지 않게. */
const FAILURE_NAMES_CHARS = 600;

/**
 * 열린 이슈를 **본문과 함께** 한 줄씩 — 워커의 재시도 피드백과 verifier 의 재점검 목록이 같이 쓴다.
 *
 * ★★ 왜 ID 만으로는 안 되는가(2026-08-28 라이브 실측, 진짜 저장소·두 벤더 교차검증): 재시도 워커가
 *   받은 피드백 전부가 `열린 이슈: A-I001, A-I002` 였다. 워커는 새 세션이라 그 ID 가 무엇이었는지
 *   알 길이 없고, 실제로 **바이트 동일한** 패치를 다시 내 `lane_stagnated` 로 끝났다. 재점검
 *   verifier 도 같은 처지였다 — 자기가 안 쓴 ID 를 「다시 확인하라」고 받았다. 본문(claim)은 그때
 *   이미 원장에 있었다(WS2 가 `orch_status` 를 위해 넓혔다). 프롬프트에만 안 실렸을 뿐이다.
 * ★ machine 이슈에는 산문이 없다(지문뿐, 불변식 4) — 그때는 지어내지 않고 그 사실을 적는다.
 * ★ 원장(`{openIds, entries}`)을 그대로 받는다. 호출부가 본문을 골라 넘기게 하면 그 고르는 코드가
 *   두 호출부에 복사되고, 둘이 갈리는 순간 워커와 verifier 가 다른 이슈를 본다.
 */
export function openIssueLines(feedback) {
  const openIds = Array.isArray(feedback?.openIds) ? feedback.openIds : [];
  if (openIds.length === 0) return null;
  const entries = Array.isArray(feedback?.entries) ? feedback.entries : [];
  const byId = new Map(entries.map((entry) => [entry?.id, entry]));
  return openIds.map((id) => {
    const entry = byId.get(id);
    const claim = entry?.issue?.claim;
    const label = entry?.label;
    const body = typeof claim === 'string' && claim.trim() !== ''
      ? clipCounted(claim.trim(), FEEDBACK_CLAIM_CHARS)
      : typeof label === 'string' && label !== ''
        ? `실패한 테스트: ${clipCounted(label, FEEDBACK_CLAIM_CHARS)}`
        : '우리가 돌린 테스트가 실패했다 (본문 없음 — 기계 증거)';
    return `- ${id}: ${body}`;
  }).join('\n');
}

/**
 * 앞 스텝이 남긴 열린 이슈 — `workerInstruction` 의 `feedback` 인자.
 *
 * ★ 왜 호출부가 아니라 여기 있는가: 이 문장은 engine 의 워커 호출부에서 인라인으로 만들어졌고,
 *   그래서 프롬프트 한국어 한 조각이 블록 **밖**에 남아 있었다. 경로로 예외를 주는 이 모듈의
 *   전제가 "프롬프트 글자는 전부 여기" 이므로, 한 줄이라도 밖에 두면 그 전제가 거짓이 된다.
 */
export function workerFeedback(feedback) {
  const lines = openIssueLines(feedback);
  return lines === null ? null : `열린 이슈:\n${lines}`;
}

/**
 * 이번 attempt 의 기계 실행 증거를 verifier 가 읽을 한 문단으로.
 *
 * ★★ 왜 verifier 에게 이것을 주는가(설계 §12.-1): 테스트는 델리게이트가 아니라 우리가 돌린다 —
 *   그래야 결과를 지어낼 수 없다. 그런데 판정 스키마는 verifier 에게 `evidenceIds` 를 되돌려
 *   적으라고 요구한다. 그 증거가 무엇을 말했는지 안 보여주면서 증명을 요구하는 셈이라
 *   앞뒤가 안 맞는다. 품질 게이트 리팩터가 이 자리를 빈 문자열로 흘려서, 프롬프트에
 *   "테스트 결과:" 라는 **빈 절**만 남아 있었다.
 *
 * ★ 원문은 넣지 않는다. 분류된 사실(실행·판정·안정성·신뢰·완결)과 증거 ID 뿐이다 — 전역
 *   제약이 금지하는 것은 저장·반환만이 아니라 원문을 다루는 습관 자체이고, verifier 는
 *   읽기 도구로 워크트리를 직접 볼 수 있으므로 원문이 없어도 판단할 수 있다.
 *
 * ★ 이 값은 판정을 **대신하지 않는다.** `decideAttempt` 가 machine 채널과 verifier 채널을
 *   따로 요구하므로, 여기서 "통과" 를 읽은 verifier 가 PASS 를 내도 기계 실패를 지우지 못하고
 *   그 반대도 마찬가지다(설계 §1 의 고정 기준).
 */
export function describeMachineEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return '이 실행에 대한 기계 증거가 없습니다.';
  const ids = Array.isArray(evidence.evidenceIds) ? evidence.evidenceIds : [];
  // 실패한 테스트의 **이름**(어댑터가 파싱한 `경로 › 이름`, 원문 아님) — 있을 때만, 유계로. 이 문단의
  //   나머지가 잘리지 않게 이 줄 자체를 먼저 자른다(슬롯 1,200 중 600).
  const failures = Array.isArray(evidence.failures) ? evidence.failures.filter((name) => typeof name === 'string' && name !== '') : [];
  if (evidence.execution === 'not_run') {
    return ['우리가 테스트를 실행하지 못했습니다.', `봉인된 증거: ${ids.join(', ') || '(없음)'}`].join('\n');
  }
  return [
    '아래는 델리게이트의 보고가 아니라 이 오케스트레이터가 직접 실행한 결과입니다.',
    `실행: ${evidence.execution}`,
    `판정: ${evidence.outcome}`,
    `안정성: ${evidence.stability}`,
    `신뢰 가능한 러너: ${evidence.trusted === true ? '예' : '아니오'}`,
    `완결: ${evidence.complete === true ? '예' : '아니오'}`,
    `봉인된 증거: ${ids.join(', ') || '(없음)'}`,
    ...(failures.length > 0 ? [`실패한 테스트 ${failures.length}개: ${clipCounted(failures.join('; '), FAILURE_NAMES_CHARS)}`] : []),
  ].join('\n');
}

/**
 * ★ 파일 목록도 **발췌**다. `files.join(', ')` 는 이 지시문에서 `task` 와 함께 무계 슬롯 둘 중
 *   하나였는데, codex 는 지시문을 argv 로 받으므로(`src/providers/codex-run.mjs:14`) 짧은 태스크
 *   에도 파일이 ~800개면 명령줄 상한을 넘겼다(메모 §D.5 의 길 2). 상한은 다른 슬롯과 같은
 *   `EXCERPT_CHARS` 이고 꼬리표도 같은 `clipCounted` 다 — 새 절단 문구는 만들지 않는다.
 */
export function verifierInstruction({ task, plan, files, tests, expected, feedback, formatOnly = false }) {
  const binding = JSON.stringify(expected);
  // 재점검 목록도 본문으로 — 이유는 `openIssueLines` 에 있다. 슬롯 상한은 다른 발췌와 같다.
  const recheck = openIssueLines(feedback);
  const schema = expected.phase === 'recheck'
    ? '{"schemaVersion":1,"candidateId":"...","attemptId":"...","candidatePatchSha256":"64 lowercase hex","evidenceIds":["..."],"verdict":"PASS|FAIL","checks":[{"id":"...","status":"resolved|persists","evidence":"..."}],"newIssues":[],"notes":[]}'
    : '{"schemaVersion":1,"candidateId":"...","attemptId":"...","candidatePatchSha256":"64 lowercase hex","evidenceIds":["..."],"verdict":"PASS|FAIL","summary":"...","issues":[{"category":"correctness|security|requirements|scope|tests","claim":"...","evidence":"...","requiredFix":"..."}],"notes":[]}';
  return [
    formatOnly
      ? '앞선 답은 형식이 틀렸습니다. 내용을 재검토하지 말고 아래 JSON 형식으로만 결과를 다시 내세요.'
      : '아래 작업의 결과를 검토하세요. 당신은 읽기만 합니다 — 파일을 고치지 마세요.',
    '파일을 고치면 이 판정은 버려집니다.',
    `BINDING_JSON: ${binding}`,
    `정확히 이 JSON 스키마만 내세요: ${schema}`,
    '',
    `작업: ${task}`,
    '',
    '계획:',
    clipCounted(plan, EXCERPT_CHARS),
    '',
    `이번 스텝이 건드린 파일: ${files.length === 0 ? '(없음)' : clipCounted(files.join(', '), EXCERPT_CHARS)}`,
    '',
    '테스트 결과:',
    clipCounted(tests, EXCERPT_CHARS),
    ...(recheck === null ? [] : ['', '다시 확인할 열린 이슈:', clipCounted(recheck, EXCERPT_CHARS)]),
    '',
    '작업이 실제로 끝났는지, 빠진 것이나 잘못된 것이 있는지 판정하세요.',
  ].join('\n');
}

export function judgeInstruction(promptInput, { formatOnly = false } = {}) {
  return [
    formatOnly
      ? '앞선 답은 형식이 틀렸습니다. 후보를 다시 평가하지 말고 같은 판단을 정확한 JSON으로만 다시 내세요.'
      : '두 익명 후보를 읽기 전용으로 비교하세요. 익명 표식 밖의 신원이나 경로를 추측하지 마세요.',
    '정확히 이 JSON 스키마만 내세요:',
    '{"schemaVersion":1,"decision":"X|Y|TIE","rationale":"...","majorDefects":[{"category":"correctness|security|requirements|scope|tests","claim":"...","evidence":"..."}]}',
    `INPUT_JSON: ${JSON.stringify(promptInput)}`,
  ].join('\n');
}

/**
 * §7.5 근거 문단의 문장들 — **플래너 지시문의 일부**라서 여기 산다(WS2 Task 16).
 *
 * ★ 왜 `src/learn/bandit.mjs` 가 아닌가: 이 문단은 밴딧의 결정 결과이지만 **읽는 것은 벤더**다
 *   (`plannerInstruction({evidence})` 가 지시문 맨 앞에 붙인다). 로드맵 §5.8 이 벤더 프롬프트를
 *   언어 게이트 밖에 두므로 한국어로 남고, 그 예외는 **경로**여야 한다 — 밴딧에 두면 게이트가
 *   파일이 아니라 리터럴 셋을 이름으로 봐줘야 한다(이 모듈이 생긴 바로 그 이유다).
 * ★ 숫자 셋은 팔의 것과 축 전체의 것이 다르다. 한 문장에 섞으면 형제 팔의 관측이 이 팔의
 *   것처럼 읽힌다(bandit.mjs 의 실측 주석) — 그래서 인자 이름으로 갈라 받는다.
 */
/** 축 하나의 근거 한 줄. `armSeen === 0` 이면 "탐색으로 골랐다" 다. */
export function evidenceLine({ axis, arm, armSeen, wins, seen }) {
  return armSeen === '0'
    ? `· ${axis}: ${arm} — 아직 관측이 없어 탐색으로 골랐습니다 (이 축 전체 ${seen}건)`
    : `· ${axis}: ${arm} — 관측 ${armSeen}건 중 성공 ${wins}건 (이 축 전체 ${seen}건)`;
}

/** 줄들을 문단으로. 줄이 하나도 없으면 "아직 모른다" 를 말한다 — 침묵은 아무렇게나 읽힌다. */
export function evidenceParagraphText(lines, threshold) {
  return lines.length > 0
    ? lines.join('\n')
    : `· 아직 판단할 만큼의 관측이 없어(축마다 ${threshold}건 필요) 기본값으로 진행합니다.`;
}
