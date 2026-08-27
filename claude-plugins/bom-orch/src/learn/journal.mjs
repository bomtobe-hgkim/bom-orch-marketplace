// src/learn/journal.mjs
import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hasPendingLearningOperation, recoverLearning, withLearningLock } from './learning.mjs';
import { REASON } from '../reason-codes.mjs';
import { fail, renderNotice } from '../reason-text.mjs';
import { errorText } from '../util/errors.mjs';
import { clipWhole } from '../util/strings.mjs';

/**
 * 실행 저널 — `<stateRoot>/journal.jsonl`.
 *
 * ★ 왜 이어붙이기 전용인가: `orch_reward(run_id, good)` 는 이미 자동 보상이 기록된 실행의
 *   기여를 **교체**해야 한다(설계 §7.4 의 멱등·교체 시맨틱). 같은 runId 로 새 줄을 얹고
 *   읽을 때 마지막이 이기게 한다. 제자리 수정은 부분 쓰기가 곧 손상이다.
 *
 * 부분 쓰기에서 무엇이 살고 무엇이 죽는가 — 실측한 사실만:
 * - 개행까지 다 쓴 줄은 남는다. 그 뒤에 얹힌 줄이 이긴다.
 * - 줄 도중에 끊긴 꼬리(개행 없음)는 그 자체로 손실이다. 게다가 그냥 이어붙이면 다음
 *   기록이 그 꼬리에 붙어 한 줄이 되어 **둘 다** 사라진다. 실측: 끊긴 꼬리 뒤에 두 실행을
 *   기록하자 첫 번째가 `{ok:true}` 를 받고도 `findRun` 에서 영영 나오지 않았다. 그래서
 *   이어붙이기 전에 파일 끝 바이트를 보고 개행이 없으면 줄 앞에 붙인다(`endsWithNewline`).
 * - 잠금을 잡았는데 본문이 죽으면 부분 쓰기가 남을 수 있다. `withLock` 이 그 경우를
 *   `REASON.state_lock_work_failed` 로 구분해 돌려준다(예전에는 문장 앞머리로 갈랐다).
 *
 * ★ 깨진 줄은 건너뛴다. 한 줄이 손상됐다고 학습 전체를 잃으면 안 된다.
 *
 * 절대 throw 하지 않는다 — 실패는 `fail(REASON.x, params)` 봉투다. 태스크 8 은 실행이 다 끝난
 * 뒤 `try` 로 감싸지 않고 이 모듈을 부른다(반환값 자체는 `.ok` 로 확인해 실패를 notice 로
 * 남긴다 — `docs/superpowers/plans/2026-08-09-plan-3-learning-layer.md` 의 태스크 8 코드는
 * `if (!journaled.ok) addNotice(...)` 다). 여기서 던지면 그 notice 대신 예외가 그대로
 * 올라가 `orch_run` 전체를 죽인다 — 계획은 학습을 부가 기능으로 못박았지 차단 사유로 두지
 * 않았다. 그래서 직렬화할 수 없는 entry(순환 참조·BigInt·던지는 `toJSON`·던지는 getter)도
 * 값으로 돌려준다.
 *
 * 규모 — 이 파일의 구현으로 실측(Windows 11 / Node 24, 줄당 315바이트, 2회 평균):
 *   n=  1000  파일= 0.3MB  readRuns(limit500)=  5ms  findRun=  4ms
 *   n= 10000  파일= 3.0MB  readRuns(limit500)= 23ms  findRun= 20ms
 *   n=100000  파일=30.0MB  readRuns(limit500)=237ms  findRun=263ms
 * `readRuns` 는 limit 과 무관하게 파일 전체를 읽고 정렬한다. 파일 끝에서 N 개만 세는 쪽이
 * 싸지만 틀린다: 정정 줄이 파일 끝에 붙으므로 오래된 run 이 최근 창으로 올라오고 진짜
 * 최근 실행이 잘려 나간다(실측: 실행 1000건 중 오래된 500건을 정정하자 기본 호출이 가장
 * 오래된 500건만 돌려주고 최근 500건을 전부 버렸다).
 *
 * ★ **보존 정책은 아직 없다.** 계획 3 태스크 13-2 가 `patches/` 에 30일 스윕을 넣었지만
 *   저널은 그 방식으로 다룰 수 없다 — `patches/` 는 실행마다 **파일 하나**씩이라 오래된
 *   것만 골라 지우면 되지만, 저널은 전부 **한 파일**이라 지우면 학습 이력이 통째로
 *   날아간다. 줄 단위로 잘라내려면 "잘라낸 run 의 기여가 사후분포에 남는다" 는 정합성을
 *   먼저 정해야 하고 그것은 이 계획 밖이다. 그래서 지금은 **크기를 재서 알리기만 한다**
 *   (아래 `JOURNAL_LARGE_BYTES` · `journalBytes`). 원장의 잔여 위험으로 남긴다.
 *
 * 멈춘 coordinator의 실패 모드 — 실측: 0바이트 `learning.lock` 이 남으면 `withLock` 의
 * `staleMs`(60초)가 지날 때까지 모든 학습 writer와 pending을 복구해야 하는 reader가 5초를 기다렸다가
 * `fail(REASON.state_lock_timeout, {code:'EEXIST'})` 로 끝난다. 그 창에서
 * 난 실행 기록은 남지 않는다. 잠금은 그래도 유지한다 — POSIX 에서 이식 가능한 배타 수단이
 * 이것뿐이다(Windows 의 `appendFile` 은 잠금 없이도 195KB 줄까지 원자적이었지만 그것은
 * 이 플랫폼의 성질이지 계약이 아니다).
 */
const FILE = 'journal.jsonl';
const DEFAULT_LIMIT = 500;

/**
 * 한 실행 기록의 키. 형태를 한자리에 둬서 소비자가 추측하지 않게 한다.
 *
 * `at` 은 **실행 시각**이다. 정정 줄이 얹혀도 유지된다 — `readRuns` 의 "최근" 이 이 값을
 * 기준으로 한다. `updatedAt` 은 **그 줄이 쓰여진 시각**이고 호출자가 덮어쓸 수 없다.
 *
 * `appliedGrade` 는 "지금 사후분포에 반영돼 있는 등급" 이다 — `orch_reward` 가 그 기여를
 * 되돌리려면 무엇이 반영됐는지 알아야 한다. 아무것도 반영 안 했으면 `null`.
 *
 * ★ `appliedAxes` 는 "그 등급이 **어느 축의 셀에** 반영됐나" 다(태스크 8 이 넣었다). 등급만
 *   남기면 `orch_reward` 가 네 축에 일괄로 되돌리는데, 태스크 8 은 실행마다 축 일부만
 *   갱신한다 — `stop_reason` 이 `test-definition-changed` 면 `placement` 하나뿐이고,
 *   벤더가 하나뿐인 호스트에서는 `tier` 하나뿐이다. 없는 기여를 빼면 형제 관측이 증발한다
 *   (`posteriors.mjs` 의 하한이 prior 까지만 막아 준다). `decisions` 는 **쓴 팔 전부**라
 *   이 정보를 대신하지 못한다. 옛 줄에는 이 키가 없다 — 소비자는 `?? []` 가 아니라
 *   `Array.isArray` 로 갈라서 "모른다" 를 "없다" 로 읽지 마라.
 *
 * ★ `rewardableAxes` 는 "**앞으로** 이 실행에 등급을 주면 어느 축의 셀로 가나" 다(태스크 10 이
 *   넣었다). `appliedAxes` 와 다른 질문이라 둘 다 있어야 한다 — 자동 채점이 기권한 실행은
 *   `appliedAxes` 가 `[]` 인데, 그것을 사람이 뒤늦게 채점할 때 적을 곳이 없어진다. 반대로
 *   `Object.keys(AXES)` 로 대신하면 이 실행에서 **무연산이었던 축**에까지 보상이 얹힌다.
 *   관계는 `appliedAxes ⊆ rewardableAxes` 이고, 갱신에 실패한 축이 있으면 진부분집합이다.
 *   이 키에도 같은 규칙이 걸린다 — 옛 줄에는 없으므로 `Array.isArray` 로 갈라라.
 */
/**
 * ★ 태스크 14(정책 v2)가 더한 여덟 키. 앞의 열넷은 **하나도 지우지 않는다.**
 *
 *   · `policyVersion` — 이 줄을 어느 규칙으로 읽어야 하는지. 없거나 1이면 v1 이다.
 *     `orch_reward` 가 이 값 하나로 갈라진다(폴백하지 않는다 — 그랬다가는 v2 줄의 동결된
 *     arm 대신 `decisions` 를 읽어 **실행하지 않은 팔**을 보상한다).
 *   · `candidateCount` · `selection` — 왜 어떤 축이 빠졌는지를 사후에 설명하는 사실.
 *     c2 는 두 arm 을 다 돌렸으므로 placement 가 없고, `single_survivor` 는 mix 가 없다.
 *   · `effectiveChoices` — `axis → { arm, identifiable, reason }`. 실제로 무엇이 돌았고
 *     왜 배울 수 없었는지를 남긴다. **보상 권위는 아니다**(아래 두 map 이다).
 *   · `appliedChoices` · `rewardableChoices` — `axis → arm`. **arm 까지** 동결하는 것이
 *     핵심이다(설계 §14.3): `decisions[axis]` 로 나중에 재구성하면 다중 후보에서 실행하지
 *     않은 arm 에 보상이 간다. `appliedAxes`/`rewardableAxes` 는 이 map 의 키에서 파생해
 *     계속 채우므로 두 형식이 한 소비자로 읽힌다.
 *   · `attemptRefs` · `artifactRefs` — **논리 ID 와 ref 만**이다. attempt 본문·패치 바이트는
 *     저널에 들어오지 않는다. artifact 는 30일 뒤 만료되지만 그것이 정정을 막지 않는다 —
 *     보상 권위는 동결된 choice map 이지 패치 내용이 아니다.
 */
/**
 * ★ WS3 태스크 2(스펙 §0-D1)가 더한 **종료 기록** 여덟. 앞의 스물둘은 하나도 지우지 않는다.
 *
 *   봉투는 디스크에 남지 않는다 — `src/envelope.mjs` 는 fs 를 수입하지도 않고, 실행 디렉터리는
 *   리퍼가 강제하는 닫힌 집합이라 파일 하나만 더 있어도 그 실행이 영영 회수되지 않는다. 그래서
 *   실행이 **어떻게 끝났는가**의 유일한 영구 기록이 이 여섯이다(그 짝은 종료 diag-log 한 줄).
 *
 *   · `project` · `taskPreview` — 인자 없는 `orch_status` 가 최근 목록에 실을 두 값(RM §3.5).
 *     `taskPreview` 는 세척기를 지난 **뒤** 120에서 자른다(`runTerminalKeys`).
 *   · `startedAt` · `finishedAt` — 실행이 시작한 순간과 봉투가 정해진 순간(epoch ms).
 *     ★★ `startedAt` 은 **`at` 으로 대신할 수 없다**(최종 리뷰 I8). `at` 은 이 줄이 **쓰인** 시각
 *     이고(`appendRun` 이 호출자 값이 없으면 그때의 시계로 찍는다), 종료 행은 `finishedAt` 을
 *     찍은 **몇 문장 뒤에** 쓰인다 — 그래서 디스크의 불변식이 `at >= finishedAt` 이고,
 *     `orch_status` 가 `at` 을 시작 시각으로 읽으면 모든 실행이 0 ms 또는 음수 동안 돈 것으로
 *     보인다(실측: 50분 돈 실행이 -2 ms). 「얼마나 돌다 잘렸나」는 `run_deadline_exceeded`·
 *     `run_cancelled` 행에 대한 첫 질문이라 두 시각이 이 행에 함께 있는 것이다. `at` 은 최근순
 *     정렬 키이기도 해서 용도를 겹쳐 쓸 수 없다.
 *   · `resumedFrom` — `resume_run_id` 로 이어 온 원본 실행의 이름, 아니면 `null`. 재개 사실이
 *     남는 다른 영구 채널은 로그의 `info` 한 줄뿐인데 `orch_status` 의 꼬리는 warn·error 만
 *     싣는다(§0-D3) — 그래서 재구성 본문이 「서수가 왜 3 부터인가」를 말할 자리가 없었다.
 *   · `status` · `stopReason` · `reasonCode` — 봉투가 실제로 낸 삼중값. ★ **문장은 절대
 *     저장하지 않는다**: 코드만 남기고 읽을 때 `REASON_TEXT` 로 다시 렌더한다(옛 철자는
 *     `normalizeLegacyReasonCode` 로 올려 읽는다). 문장을 저장하면 어휘가 갈라져 다음 편집에서
 *     불변식 7·10 이 깨진다 — 디스크의 문장은 레지스트리가 못 고친다.
 *
 *   ★ 옛 행에는 이 여덟이 **없다**. 소비자는 `?? ''` 가 아니라 키 유무로 갈라라 — 「모른다」를
 *     「빈 값이다」로 읽으면 0.2.2 실행이 프로젝트 없는 실행으로 보인다(불변식 9,
 *     `test/fixtures/journal/v022-row.json` 가 양방향을 못박는다).
 */
export const RUN_ENTRY_KEYS = Object.freeze([
  'runId', 'at', 'updatedAt', 'taskClass', 'decisions', 'outcome',
  'appliedGrade', 'appliedAxes', 'rewardableAxes', 'appliedGenerations', 'rewardableGenerations', 'operationId', 'rewardApplied', 'note',
  'policyVersion', 'candidateCount', 'attemptRefs', 'artifactRefs', 'selection',
  'effectiveChoices', 'appliedChoices', 'rewardableChoices',
  'project', 'taskPreview', 'startedAt', 'finishedAt', 'status', 'stopReason', 'reasonCode', 'resumedFrom',
]);

/** `taskPreview` 의 상한 — RM §3.5 가 "task 앞 120자" 로 정한 값. */
export const TASK_PREVIEW_CHARS = 120;

/**
 * 종료 기록 여덟 키를 만든다. 쓰는 자리가 **둘**이라(학습 WAL 의 행과 엔진 종료 sink 의 행) 그
 * 둘이 같은 바이트를 내야 한다 — 값을 짓는 자리는 여기 하나다.
 *
 * ★ `taskPreview` 는 **세척 먼저, 자르기 나중**(`src/diag.mjs` 와 같은 규칙). 먼저 자르면 비밀이
 *   반으로 잘려 남고 그 조각은 어느 규칙에도 안 걸린 채 나간다. 게다가 저널에는 **보존 정책이
 *   없다**(위 ★) — 로그와 달리 그 줄은 지워지지 않는다.
 * ★ 자르는 함수가 `clipWhole` 인 이유: 상한이 서로게이트 쌍 한가운데 떨어지면 반쪽이 남고,
 *   그 반쪽은 UTF-8 왕복에서 U+FFFD 가 되어 디스크의 바이트가 손상된다. 말줄임 한 글자를
 *   붙이므로 상한은 `-1` 로 준다 — 「120자를 넘지 않는다」가 한 글자 어긋나지 않게.
 * ★★ **`project` 는 세척기를 지나지 않는다** — 실측: 지나면 값이 리터럴 `'<project>'` 가 된다.
 *   세척기는 프로젝트 루트를 통째로 그 자리표시자로 접으므로(`src/redact.mjs` 의 `TOKEN`),
 *   프로젝트 경로 **자체**를 넣으면 남는 정보가 0 이고 실행 백 건이 모두 같은 문자열이 된다 —
 *   이 키가 존재하는 이유(인자 없는 `orch_status` 가 "어느 프로젝트였나" 를 말한다, RM §3.5)가
 *   그 자리에서 사라진다. 자리표시자는 **남의 산문 안에 섞인** 경로를 접으라고 있는 것이지 그
 *   경로를 이름으로 부르는 필드에 쓰라고 있는 것이 아니다(봉투의 `log.path` 도 같은 이유로
 *   절대 경로를 그대로 싣는다 — 계약 `topLevel.log`). 대신 값은 엔진이 정준화한 절대 경로다.
 * ★ 문자열이 아닌 입력은 `null` 이다. `''` 로 뭉개면 「모른다」가 「빈 값이다」가 된다.
 */
export function runTerminalKeys({ projectPath, task, startedAt, finishedAt, resumedFrom, outcome, redact }) {
  const preview = typeof task === 'string' ? (typeof redact === 'function' ? redact(task) : task) : null;
  const pick = (key) => (outcome !== null && typeof outcome === 'object' && typeof outcome[key] === 'string' ? outcome[key] : null);
  return {
    project: typeof projectPath === 'string' ? projectPath : null,
    taskPreview: preview === null || preview.length <= TASK_PREVIEW_CHARS ? preview : clipWhole(preview, TASK_PREVIEW_CHARS - 1),
    startedAt: Number.isSafeInteger(startedAt) ? startedAt : null,
    finishedAt: Number.isSafeInteger(finishedAt) ? finishedAt : null,
    status: pick('status'),
    stopReason: pick('stopReason'),
    reasonCode: pick('reasonCode'),
    resumedFrom: typeof resumedFrom === 'string' && resumedFrom !== '' ? resumedFrom : null,
  };
}

const pathsFor = (stateRoot) =>
  typeof stateRoot === 'string' && stateRoot !== '' && isAbsolute(stateRoot)
    ? { file: join(stateRoot, FILE) }
    : null;

/**
 * "이제 사람이 알아야 할 만큼 커졌다" 로 볼 크기.
 *
 * 위 실측 표의 두 점 사이다 — n=10,000 이 3.0MB(`findRun` 20ms 로 무시할 수준)이고
 * n=100,000 이 30.0MB(`findRun` 263ms)다. 10MB 는 그 사이에서 아직 아프지 않지만
 * **추세가 보이는** 자리다. 임계를 넘어도 우리는 아무것도 지우지 않는다(위 ★ 참조).
 */
export const JOURNAL_LARGE_BYTES = 10 * 1024 * 1024;

/**
 * 저널 파일의 바이트 수. 없거나 읽지 못하면 `null` — "모른다"를 0 으로 뭉개지 않는다.
 * 이 함수가 여기 있는 이유는 파일 이름이 이 모듈의 것이기 때문이다(`FILE`).
 */
export async function journalBytes(stateRoot) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return null;
  try {
    return (await stat(paths.file)).size;
  } catch {
    return null;
  }
}

/**
 * ★ `options.now` 는 **테스트가 시각을 못박기 위한 이음새**다(기본값은 진짜 시계라 옵션을
 *   안 주면 파일에 찍히는 바이트가 그대로다). 이것이 없으면 `at`·`updatedAt` 을 「기록 전후
 *   사이에 있다」는 창으로만 잴 수 있고, 두 줄의 선후는 `sleep(5)` 로 진짜 시간을 흘려
 *   보내야 만들어진다 — Windows 의 `Date.now()` 해상도가 1-16ms 라 그 sleep 은 언제든
 *   같은 ms 두 줄을 낼 수 있다. 함수가 아닌 값은 무시하고 진짜 시계로 되돌린다.
 */
function runLine(entry, options) {
  try {
    // 이 블록 전체가 try 안에 있어야 한다. `entry.runId` 는 던지는 getter 일 수 있고,
    // 전개와 `JSON.stringify` 는 순환 참조·BigInt·던지는 `toJSON` 에서 던진다.
    if (entry === null || typeof entry !== 'object' || typeof entry.runId !== 'string' || entry.runId === '') {
      return fail(REASON.learning_journal_record_invalid);
    }
    const now = typeof options?.now === 'function' ? options.now() : Date.now();
    // `at` 은 호출자가 실어 보낸 유한한 값을 물려받는다 — 태스크 10 은 `findRun` 이 돌려준
    // 기록을 통째로 전개해서(`{...run, appliedGrade, …}`) 얹으므로 원래 실행 시각이 따라온다.
    //
    // `at` 없는 부분 교체(`{runId, appliedGrade}` 만 얹기)는 원래 실행 시각을 되살릴 수
    // 없다. 물려받으려면 얹을 때마다 저널 전체를 뒤져야 하는데, appendRun 은 실행이 끝날
    // 때마다 도는 쓰기 경로다(실측으로 10k 줄에 20ms, 100k 줄에 263ms 를 잠금을 쥔 채 더
    // 쓰게 된다). 그래서 물려받지 않고 지금으로 찍되, `at` 과 `updatedAt` 에 **같은** `now`
    // 를 써서 그 사실이 파일에 남게 한다 — 앞에 같은 runId 줄이 있는데 `at === updatedAt`
    // 이면 그 줄은 `at` 을 실어 보내지 않은 교체다.
    const at = Number.isFinite(entry.at) ? entry.at : now;
    // 전개 뒤에 둔다: `at` 은 위에서 이미 호출자 값을 반영했고, `updatedAt` 은 호출자가
    // 덮어쓰면 안 된다.
    return { ok: true, line: `${JSON.stringify({ ...entry, at, updatedAt: now })}\n` };
  } catch (error) {
    return fail(REASON.learning_journal_record_unserializable, { detail: errorText(error) });
  }
}

/** 호출자가 `learning.lock` 을 쥔 동안 이미 직렬화한 한 행을 덧붙인다. */
async function appendLineUnlocked(paths, line) {
  const prefix = (await endsWithNewline(paths.file)) ? '' : '\n';
  const handle = await open(paths.file, 'a');
  try {
    await handle.writeFile(`${prefix}${line}`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  return { ok: true };
}

/** 드문 잠금 해제 경고를 버리지 않고 저널 쓰기 결과를 풀어낸다. */
function settleJournalWrite(got) {
  if (!got.ok) return got;
  if (got.value?.ok === false) return got.value;
  return got.released === false
    ? { ok: true, notice: renderNotice('journal_lock_left_behind', { reason: got.releaseReason }) }
    : { ok: true };
}

export async function appendRun(stateRoot, entry, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return fail(REASON.state_root_not_absolute);

  const prepared = runLine(entry, options);
  if (!prepared.ok) return prepared;

  // 끝 바이트 확인과 이어붙이기 사이가 갈라지면 안 된다 — 둘 다 잠금 안에서 한다.
  const got = await withLearningLock(stateRoot, async () => appendLineUnlocked(paths, prepared.line));
  // `released:false` 는 본문(위 콜백)이 잘 끝났어도 잠금 파일이 남았다는 뜻이다 —
  // `src/lockfile.mjs:22-24` 는 호출자가 그것을 로그할 수 있어야 한다고 명시하는데
  // 지금까지는 여기서 버려졌다. 방아쇠는 희박하다: 본문이 `staleMs`(기본 60초)를
  // 넘겨야 남이 잠금을 훔쳐 갈 수 있다(`src/lockfile.mjs:31-35`). `notice` 는 새 필드라
  // `.ok` 만 보는 기존 소비자(태스크 8)와 호환된다.
  return settleJournalWrite(got);
}

/**
 * 학습 사실은 바꾸지 않고 최신 이벤트 행에 조언용 note를 붙인다.
 *
 * 읽기와 교체 append는 한 coordinator lock을 공유한다. 먼저 읽고 `appendRun`을 부르면 그 사이
 * 잠금이 풀리고 여기서 재귀 획득하므로, 동시에 들어온 reward 정정을 이 함수가 본 낡은 행으로
 * 덮을 수 있다. JSONL의 이전 행은 그대로 남는다. note는 최신 이벤트 주석이므로, 뒤이은 동일
 * reward 정정이 note 차이 때문에 posterior 갱신 없는 교체 행 하나를 더 만들 수 있다.
 */
export async function recordRunNote(stateRoot, runId, note, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return fail(REASON.state_root_not_absolute);
  if (typeof runId !== 'string' || runId === '' || typeof note !== 'string' || note === '') {
    return fail(REASON.learning_journal_record_invalid);
  }

  const got = await withLearningLock(stateRoot, async () => {
    const read = await readRunsAtPaths(paths, { limit: Number.MAX_SAFE_INTEGER });
    if (!read.ok) return read;
    const current = read.runs.find((run) => run.runId === runId);
    if (current === undefined) return fail(REASON.learning_run_not_found, { runId });

    const prepared = runLine({ ...current, note }, options);
    if (!prepared.ok) return prepared;
    return appendLineUnlocked(paths, prepared.line);
  });
  return settleJournalWrite(got);
}

export async function readRuns(stateRoot, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return fail(REASON.state_root_not_absolute);
  if (await hasPendingLearningOperation(stateRoot)) {
    const recovered = await recoverLearning(stateRoot);
    if (!recovered.ok) return recovered;
  }
  return readRunsAtPaths(paths, options);
}

/** Read without taking `learning.lock`; only coordinator callbacks may use it. */
export async function readRunsUnlocked(stateRoot, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return fail(REASON.state_root_not_absolute);
  return readRunsAtPaths(paths, options);
}

async function readRunsAtPaths(paths, options) {
  // `= {}` 파라미터 기본값은 `undefined` 에만 걸린다 — `null` 을 넘기면 구조 분해가 그
  // 자리에서 던진다. `lockfile.mjs:42-45` 와 같은 층위로 어떤 값이 와도 던지지 않게
  // 여기서 직접 정규화한다(배열은 구조 분해가 그대로 통하므로 손대지 않는다).
  const { limit = DEFAULT_LIMIT } = options && typeof options === 'object' ? options : {};
  // 'abc'·-1·NaN 을 그대로 쓰면 `{ok:true, runs:[]}` 가 나와 "저널이 비었다" 와 구분되지
  // 않는다. `withLock` 이 모든 옵션에 쓰는 정규화와 같은 형태로 기본값으로 되돌린다.
  const take = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_LIMIT;

  let text;
  try {
    text = await readFile(paths.file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, runs: [] };
    // WS1 C2 — `String(error?.message ?? error)` 는 message 가 빈 오류에서 `[object Object]` 를
    // 냈다. 사다리는 저장소에 하나뿐이다(`errorText`).
    return fail(REASON.learning_journal_read_failed, { detail: errorText(error) });
  }

  const found = collect(text);
  found.sort(byRecency);
  return { ok: true, runs: found.slice(0, take).reverse().map((r) => r.entry) };
}

export async function findRun(stateRoot, runId) {
  if (typeof runId !== 'string' || runId === '') return null;
  const got = await readRuns(stateRoot, { limit: Number.MAX_SAFE_INTEGER });
  return got.ok ? got.runs.find((run) => run.runId === runId) ?? null : null;
}

/** Find without taking `learning.lock`; only coordinator callbacks may use it. */
export async function findRunUnlocked(stateRoot, runId) {
  if (typeof runId !== 'string' || runId === '') return null;
  // 최근 창이 아니라 저널 전체를 뒤진다 — `orch_reward` 는 임의로 오래된 실행도 정정한다.
  const got = await readRunsUnlocked(stateRoot, { limit: Number.MAX_SAFE_INTEGER });
  if (!got.ok) return null;
  return got.runs.find((r) => r.runId === runId) ?? null;
}

/**
 * 저널 전체에서 runId 별 **마지막** 줄만 남긴다 — 그것이 멱등·교체다.
 *
 * `at` 이 유한한 수가 아닌 줄(손으로 쓴 줄, 옛 형식)은 가장 오래된 것으로 취급한다.
 *
 * 왜 `MIN_SAFE_INTEGER`(유한값)를 쓰는가 — `-Infinity` 를 써도 결과는 같다. 실측:
 * `byRecency` 는 `a.at === b.at` 을 **먼저** 보고, 두 OLDEST 값이 같으면 그 동률 분기
 * (`b.pos - a.pos`)로 빠져 뺄셈 자체가 평가되지 않는다(`-Infinity === -Infinity` 는
 * 참이다). `OLDEST` 를 `-Infinity` 로 바꿔 같은 데이터를 정렬해 봐도 결과가 그대로였고
 * (`DBCA`), `test/learn-journal.test.mjs` 전체도 그 상태로 18/18 그대로 초록이었다.
 * `a.at !== b.at` 인데 뺄셈이 `Infinity - Infinity` 가 되는 조합도 만들어지지 않는다 —
 * OLDEST 는 상수 하나뿐이라 서로 다른 두 값이 둘 다 OLDEST 일 수 없다. `MIN_SAFE_INTEGER`
 * 를 고른 것은 "무한대가 아니라 유한한 수"라는 것 말고 특별한 근거는 없다.
 */
const OLDEST = Number.MIN_SAFE_INTEGER;

function collect(text) {
  const byId = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 깨진 줄은 건너뛴다.
    }
    const runId = parsed?.runId;
    if (typeof runId !== 'string' || runId === '') continue;
    byId.set(runId, { entry: parsed, at: Number.isFinite(parsed.at) ? parsed.at : OLDEST, pos: i });
  }
  return [...byId.values()];
}

/** 최근 순. `at` 이 같으면 파일에서 뒤에 있는 것이 나중에 쓰인 것이다. */
const byRecency = (a, b) => (a.at === b.at ? b.pos - a.pos : b.at - a.at);

/**
 * 파일 끝이 개행인가. 파일이 없거나 비었으면 `true` — 줄 앞에 개행이 필요 없다.
 *
 * 확인하지 못하면 `false` 를 돌려 개행을 붙인다. 불필요한 개행은 빈 줄 하나이고
 * `readRuns` 가 건너뛰지만, 빠뜨린 개행은 앞뒤 두 기록을 한 줄로 엉키게 해 둘 다 잃는다.
 * UTF-8 에서 0x0A 는 다른 문자의 연속 바이트로 나타나지 않으므로 마지막 한 바이트만
 * 보면 된다.
 */
async function endsWithNewline(file) {
  let handle = null;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buf, 0, 1, size - 1);
    return bytesRead === 1 && buf[0] === 0x0a;
  } catch (error) {
    return error?.code === 'ENOENT';
  } finally {
    await handle?.close().catch(() => {});
  }
}

