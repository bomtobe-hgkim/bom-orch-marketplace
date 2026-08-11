// src/learn/journal.mjs
import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hasPendingLearningOperation, recoverLearning, withLearningLock } from './learning.mjs';

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
 *   `본문이 …` 사유로 구분해 돌려준다.
 *
 * ★ 깨진 줄은 건너뛴다. 한 줄이 손상됐다고 학습 전체를 잃으면 안 된다.
 *
 * 절대 throw 하지 않는다 — 실패는 `{ok:false, reason}` 이다. 태스크 8 은 실행이 다 끝난
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
 * `{ok:false, reason:'잠금을 제한 시간 안에 …(마지막 오류: EEXIST)'}` 로 끝난다. 그 창에서
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
export const RUN_ENTRY_KEYS = Object.freeze([
  'runId', 'at', 'updatedAt', 'taskClass', 'decisions', 'outcome',
  'appliedGrade', 'appliedAxes', 'rewardableAxes', 'appliedGenerations', 'rewardableGenerations', 'operationId', 'rewardApplied', 'note',
]);

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

export async function appendRun(stateRoot, entry) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };

  let line;
  try {
    // 이 블록 전체가 try 안에 있어야 한다. `entry.runId` 는 던지는 getter 일 수 있고,
    // 전개와 `JSON.stringify` 는 순환 참조·BigInt·던지는 `toJSON` 에서 던진다.
    if (entry === null || typeof entry !== 'object' || typeof entry.runId !== 'string' || entry.runId === '') {
      return { ok: false, reason: 'runId 가 있는 객체여야 합니다.' };
    }
    const now = Date.now();
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
    line = `${JSON.stringify({ ...entry, at, updatedAt: now })}\n`;
  } catch (error) {
    return { ok: false, reason: `기록을 JSON 으로 만들지 못했습니다: ${describe(error)}` };
  }

  // 끝 바이트 확인과 이어붙이기 사이가 갈라지면 안 된다 — 둘 다 잠금 안에서 한다.
  const got = await withLearningLock(stateRoot, async () => {
    const prefix = (await endsWithNewline(paths.file)) ? '' : '\n';
    const handle = await open(paths.file, 'a');
    try {
      await handle.writeFile(`${prefix}${line}`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  });
  if (!got.ok) return { ok: false, reason: got.reason };
  // `released:false` 는 본문(위 콜백)이 잘 끝났어도 잠금 파일이 남았다는 뜻이다 —
  // `src/lockfile.mjs:22-24` 는 호출자가 그것을 로그할 수 있어야 한다고 명시하는데
  // 지금까지는 여기서 버려졌다. 방아쇠는 희박하다: 본문이 `staleMs`(기본 60초)를
  // 넘겨야 남이 잠금을 훔쳐 갈 수 있다(`src/lockfile.mjs:31-35`). `notice` 는 새 필드라
  // `.ok` 만 보는 기존 소비자(태스크 8)와 호환된다.
  return got.released === false ? { ok: true, notice: `저널 잠금이 남았습니다: ${got.releaseReason}` } : { ok: true };
}

export async function readRuns(stateRoot, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  if (await hasPendingLearningOperation(stateRoot)) {
    const recovered = await recoverLearning(stateRoot);
    if (!recovered.ok) return recovered;
  }
  return readRunsAtPaths(paths, options);
}

/** Read without taking `learning.lock`; only coordinator callbacks may use it. */
export async function readRunsUnlocked(stateRoot, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
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
    return { ok: false, reason: `저널을 읽지 못했습니다: ${String(error?.message ?? error)}` };
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

/** 던져진 것에서 사람이 읽을 사유를 만든다. 사유를 만들다 또 던지면 계약이 깨진다. */
function describe(error) {
  if (error === undefined) return '사유 없이 undefined 가 던져졌습니다.';
  if (error === null) return '사유 없이 null 이 던져졌습니다.';
  try {
    const message = error?.message;
    if (typeof message === 'string' && message !== '') return message;
    return String(error);
  } catch {
    return '사유를 읽지 못했습니다.';
  }
}
