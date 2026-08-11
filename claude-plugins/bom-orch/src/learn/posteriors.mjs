// src/learn/posteriors.mjs
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  commitLearningOperationUnlocked,
  generationOf,
  hasPendingLearningOperation,
  makeOperationId,
  readGenerationsUnlocked,
  recoverLearning,
  withLearningLock,
} from './learning.mjs';

/**
 * Beta 사후분포 — `<stateRoot>/posteriors.json`.
 *
 * 모양: `{ "<cellKey>": { "<arm>": { alpha, beta } } }`. prior 는 (1,1) 이고 파일에 없는
 * 팔은 그 값으로 취급한다 — 안 해본 선택지가 넓은 분포를 갖는 것이 Thompson sampling 의
 * 탐색이다(설계 §7.3).
 *
 * ★ 읽을 때 팔 단위로 클램프한다(설계 §7.7). `alpha`/`beta` 가 유한한 양수가 아니면 **그
 *   팔만** (1,1) 로 되돌린다. 같은 셀의 멀쩡한 팔은 건드리지 않는다.
 *
 * ★ **"안 읽힌다" 와 "비었다" 는 다른 답이다.** 파일이 없으면 `{ok:true, cells:{}}` 이고,
 *   있는데 JSON 이 아니거나 셀 객체가 아니면 `{ok:false, reason}` 이다. 둘을 같은 답으로
 *   내면 그 위에 `updatePosterior` 가 쓰는 순간 그동안의 학습이 통째로 사라진다. 소비자는
 *   이미 `ok` 를 갈라 보고 있다(태스크 8·10 의 `got.ok ? got.cells : {}`) — 밴딧은 그때
 *   기본값으로 돌고 실행은 계속된다.
 *
 * ★ 손상된 파일 위에 덮어쓰지 않는다. `updatePosterior` 는 그 파일을
 *   `posteriors.corrupt.json` 으로 **옮기고** 백지에서 다시 시작하며 `notice` 로 알린다.
 *   끊긴 꼬리(`…"alpha":30,"beta`)는 사람이 손으로 되살릴 수 있는 정보라 지우면 안 되고,
 *   그렇다고 영영 실패로 두면 자동으로 도는 학습이 사람 손을 기다리며 멈춘다. 옮기지도
 *   못하면(격리 경로가 디렉터리 등) 아무것도 쓰지 않고 실패한다 — 모르는 바이트를
 *   파괴하느니 학습 한 번을 잃는 쪽이 낫다. 손상이 두 번 나면 두 번째가 첫 번째 격리본을
 *   덮는다. 지금 무엇이 깨졌는지가 사람에게 필요한 정보라고 보고 그렇게 뒀다.
 *   `resetPosteriors` 는 사용자가 명시적으로 "지워라" 라고 부른 손상 파일도 회복시키되,
 *   `posteriors.prev.json` 에 원본 바이트를 먼저 남긴다. update의 `corrupt` 격리본과 다른
 *   이름이라 두 경로가 서로의 증거를 덮지 않고, 스냅샷 실패면 본 파일은 그대로 둔다.
 *
 * ★ 되돌리기는 하한에서 멈추되 **성분별로** 멈춘다. `orch_reward`(태스크 10)는 이미 반영된
 *   기여를 음수 델타로 뺀다. 저널과 사후분포가 어긋나 있으면(그 사이에 reset 이 돌았다)
 *   결과가 prior 밑으로 내려가는데, 그때 팔 전체를 (1,1) 로 되돌리면 **형제 성분의 관측이
 *   같이 사라진다** — `{alpha:1, beta:5}` 에 `alphaDelta:-1` 을 주면 실패 4건이 증발한다.
 *   그래서 내려간 성분만 하한으로 막고 `notice` 로 알린다. 하한은 prior 인데, 현재 값이
 *   이미 prior 보다 작으면(손으로 쓴 파일) 현재 값이 하한이다 — 막는다고 없던 관측을
 *   만들어 내지 않기 위해서다.
 *
 * 쓰기 경로 — 잠금 + 임시 파일 + rename. 실측한 사실만:
 * - `readPosteriors` 는 **잠금을 잡지 않는다.** 잡으면 `updatePosterior` 가 제 잠금 안에서
 *   자기를 부르는 꼴이라 `open(...,'wx')` 가 EEXIST 로 제 자신을 기다린다. 실측: 잠금을
 *   잡는 읽기를 만들어 잠금 안에서 부르자 5010ms(=timeoutMs 5초)를 다 쓰고
 *   `잠금을 제한 시간 안에 잡지 못했습니다. (마지막 오류: EEXIST)` 로 끝났다.
 *   읽기가 잠금 밖이어도 rename 은 원자적이라 리더는 옛 파일 아니면 새 파일을 본다 —
 *   rename 300회를 4-way 동시 읽기와 겹쳐 돌려 읽기 실패 0회였다.
 * - 반대 방향은 Windows 에서 실제로 깨진다: **목적지 파일이 열려 있으면 rename 이 EPERM 이다.**
 *   실측(Windows 11 / Node v24.18.0). 조건마다 쓰기 200회를 6번 되풀이한 범위이고,
 *   리더는 `readFile` 을 도는 루프이며 간격은 그 루프의 `setTimeout` 값이다:
 *
 *   | 리더 | 재시도 없음 | 10회@5ms | `updatePosterior` |
 *   |---|---|---|---|
 *   | 없음 | 0/200 | 0/200 (재시도 0건) | 0/200 |
 *   | 1개 @20ms | 9~15/200 | 0/200 | 0/200 |
 *   | 1개 @5ms | 28~35/200 | 19~29/200 | 2~13/200 |
 *   | 1개 @0ms | 141~150/200 | 102~122/200 | 8~82/200 |
 *   | 1개, 타이머 없이 | 166~181/200 | 124~136/200 | 114~128/200 |
 *   | 4개, 타이머 없이 | 200/200 | 200/200 | 200/200 |
 *
 *   ★ 재시도는 **드문드문 여는 리더**만 흡수한다. 리더가 빨라지면 절반 넘게 실패하고, 쉬지
 *   않고 여는 리더가 넷이면 전부 실패한다 — 그 자리에서 학습은 사실상 멈춘다. 실제 배치는
 *   실행 시작에 읽기 1회·끝에 쓰기 4회라 위 표의 첫 두 줄에 가깝지만, `orch_stats` 를
 *   폴링하는 사용자가 있으면 아래로 내려간다. 핸들을 놓지 않는 리더 하나면 10회(≈142ms)를
 *   다 쓰고 EPERM 으로 끝난다. 그때는 임시 파일을 지우고 `ok:false` 를 낸다.
 * - 임시 파일 이름에 pid **와 UUID** 를 함께 넣는다. pid 만으로는 부족하다 — 상태 루트는
 *   호스트 공통이라(설계 §11.3) 다른 기계·컨테이너의 같은 pid 가 같은 임시 경로를 고른다.
 * - 임시 파일에 `fsync` 를 한다. 실측: 200회에 66ms(없음) 대 330ms(있음) — 쓰기 한 번에
 *   +1.3ms 다. 없으면 전원 손실 시 rename 이 데이터보다 먼저 닿아 빈 파일이 남을 수 있고,
 *   그 상태는 위의 격리 경로로 흘러 학습이 통째로 백지가 된다. **디렉터리는 fsync 하지
 *   않는다** — Windows 에서 디렉터리 핸들은 열리지만 그 핸들의 `sync()` 가 EPERM 이다(실측).
 *   그래서 rename 자체가 디스크에 안 닿는 창은 남아 있다.
 *
 * 규모 — 태스크 클래스 4개 × 축 4개 × 팔 2개 = 셀 16개로 실측: 파일 2422바이트,
 * `readFile`+`JSON.parse` 200회에 132ms(0.7ms/회). 경합 없는 `updatePosterior` 는 잠금
 * 획득·해제까지 합쳐 1회 4.15ms 였다(100회 415ms). `withLock` 의 알려진 한계는 본문이
 * `staleMs`(60초)를 넘기면 상호 배제가 깨지는 것인데(`src/lockfile.mjs:30-35`), 지금 본문은
 * 그 1/14000 이다. 셀 수는 태스크 클래스 × 축으로 상한이 있고 저널처럼 실행마다 늘지 않는다.
 *
 * **어떤 값을 넘겨도** throw 하지 않는다 — 실패는 `{ok:false, reason}` 이다. 태스크 8 은
 * 실행이 다 끝난 뒤 `try` 없이 이 모듈을 부르고 `.ok` 만 본다. 여기서 던지면 학습 실패가
 * `orch_run` 전체를 죽인다. 값이 아니라 **읽는 행위가 던지는 것**은 다르다: 던지는 getter 를
 * 단 객체나 Proxy 를 `options` 로 넘기면 구조 분해 자리에서 그대로 나간다. 형제
 * `lockfile.mjs:45` 도 같은 모양이라 저장소 수준에서 같은 폭의 계약이다.
 */
const FILE = 'posteriors.json';
const CORRUPT = 'posteriors.corrupt.json';
export const SNAPSHOT_FILE = 'posteriors.prev.json';
export const GENERATIONS_SNAPSHOT_FILE = 'learning.generations.prev.json';

/** rename 재시도. 위 헤더의 실측이 이 두 수를 고른 근거다. */
const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 5;

export const PRIOR = Object.freeze({ alpha: 1, beta: 1 });

/**
 * 셀 키. 태스크 클래스 × 결정 축.
 *
 * 태스크 10 은 `cellKey.split('::')` 로 되돌린다. 태스크 클래스에 `:` 가 하나 들어 있어도
 * (`code:test-bearing`) 구분자와 겹치지 않는다. Symbol 이 와도 던지지 않게 `String` 을 쓴다.
 */
export function cellKeyOf(taskClass, axis) {
  return `${String(taskClass)}::${String(axis)}`;
}

const pathsFor = (stateRoot) =>
  typeof stateRoot === 'string' && stateRoot !== '' && isAbsolute(stateRoot)
    ? {
        root: stateRoot,
        file: join(stateRoot, FILE),
        corrupt: join(stateRoot, CORRUPT),
        snapshot: join(stateRoot, SNAPSHOT_FILE),
        generations: join(stateRoot, 'learning.generations.json'),
        generationSnapshot: join(stateRoot, GENERATIONS_SNAPSHOT_FILE),
      }
    : null;

// `Number.isFinite` 는 강제 변환을 하지 않는다 — 수가 아닌 값은 여기서 이미 걸린다
// (`Number.isFinite('4') === false`). 앞에 `typeof value === 'number'` 를 더 두면 잉여다.
const isPositiveFinite = (value) => Number.isFinite(value) && value > 0;

/** 유한한 양수 쌍만 통과. 하나라도 아니면 그 팔은 prior 다. */
const clampArm = (value) => {
  const alpha = value?.alpha;
  const beta = value?.beta;
  return isPositiveFinite(alpha) && isPositiveFinite(beta) ? { alpha, beta } : { ...PRIOR };
};

/**
 * 파일의 날것을 메모리 모형으로 옮긴다.
 *
 * 팔 객체가 아닌 셀은 건너뛴다 — 저널이 깨진 **줄**만 건너뛰고 나머지를 살리는 것과 같은
 * 층위다. `Object.fromEntries` 로 만드는 이유는 `obj[k] = v` 가 `k === '__proto__'` 일 때
 * 값을 넣는 대신 프로토타입을 바꿔 버리기 때문이다(실측: 그 키가 목록에서 사라지고
 * 없는 셀 조회가 값을 상속해 냈다). `fromEntries` 는 진짜 자기 속성으로 만든다.
 */
function clampCells(raw) {
  const cells = [];
  for (const [cellKey, arms] of Object.entries(raw)) {
    if (arms === null || typeof arms !== 'object' || Array.isArray(arms)) continue;
    cells.push([cellKey, Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, clampArm(value)]))]);
  }
  return Object.fromEntries(cells);
}

/**
 * 파일을 네 상태 중 하나로 읽는다: `missing` · `unreadable` · `corrupt` · `ok`.
 *
 * `unreadable`(EACCES·EISDIR…)과 `corrupt`(JSON 이 아님)를 가르는 이유는 격리 때문이다.
 * 접근 자체가 막힌 파일을 옮기려 들면 멀쩡한 내용을 엉뚱한 이름으로 밀어낼 수 있다.
 */
async function load(file) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: `사후분포를 읽지 못했습니다: ${describe(error)}` };
  }
  const text = bytes.toString('utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { state: 'corrupt', bytes, reason: `사후분포가 JSON 으로 읽히지 않습니다: ${describe(error)}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'corrupt', bytes, reason: '사후분포 파일이 셀 객체가 아닙니다.' };
  }
  return { state: 'ok', raw, bytes };
}

export async function readPosteriors(stateRoot) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  // Atomic rename lets ordinary reads stay nonblocking.  Only a visible WAL
  // requires the coordinator so the reader can finish the interrupted pair.
  if (await hasPendingLearningOperation(stateRoot)) {
    const recovered = await recoverLearning(stateRoot);
    if (!recovered.ok) return recovered;
  }
  return readPosteriorsUnlocked(stateRoot);
}

/** Read without the coordinator; only a coordinator callback may use it. */
export async function readPosteriorsUnlocked(stateRoot) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  const loaded = await load(paths.file);
  if (loaded.state === 'missing') return { ok: true, cells: {} };
  if (loaded.state === 'ok') return { ok: true, cells: clampCells(loaded.raw) };
  return { ok: false, reason: loaded.reason };
}

/**
 * 셀 하나를 갱신한다. `updatePosteriors` 에 항목 하나를 넘기는 것과 **정확히 같다.**
 *
 * 두 이름을 남기는 이유는 호출부다 — 엔진(`recordLearning`)은 축마다 성패를 따로 알아야
 * 저널에 **사실**(성공한 축만)을 적을 수 있어서 한 번에 하나씩 부른다.
 */
export async function updatePosterior(stateRoot, options) {
  return updatePosteriors(stateRoot, [options]);
}

/**
 * 여러 셀을 **한 번의 잠금 · 한 번의 쓰기**로 갱신한다 — 전부 적용되거나 하나도 안 된다.
 *
 * ★★ 왜 필요한가(태스크 10 수정 라운드 1 의 Critical). `orch_reward` 는 네 축의 기여를
 *   되돌리고 새로 적는데, 축마다 따로 쓰면 세 축을 고치고 네 번째에서 죽는 **반쪽 상태**가
 *   생긴다. 저널의 `appliedGrade` 는 스칼라라 그 상태를 표현할 수 없어서, 다음 정정이
 *   「어디까지 반영됐는지」를 틀리게 믿고 **이중 계산**한다. 실측했던 것:
 *   자동 채점 success 로 `{alpha:2,beta:1}` → 쓰기를 막고 정정 → 저널만 `appliedGrade:null`
 *   → 장애 해소 후 재호출 → `{alpha:2,beta:2}`(옳은 값은 `{alpha:1,beta:2}`).
 *   `posteriors.json` 은 **파일 하나**라 잠금 하나 안에서 전부 적용하면 그 상태가
 *   구조적으로 사라진다.
 *
 * ★ 검증도 전부 아니면 전무다 — 항목 하나라도 `cellKey`·`arm` 이 비면 아무것도 안 쓴다.
 *   일부만 쓰고 나머지를 거절하면 호출자가 되돌릴 수 없는 반쪽 상태를 다시 만든다.
 *
 * ★ 같은 `{cellKey, arm}` 이 두 번 오면 **순서대로 누적**한다(두 번째는 첫 번째의 결과 위에
 *   더한다). 하한도 그 중간값을 기준으로 걸린다 — 합쳐서 한 번에 더한 것과 다를 수 있으므로
 *   호출자가 순 델타로 합쳐 넘기는 편이 낫다.
 *
 * ★ 잠금 본문은 여전히 **load 1회 + writeAtomic 1회** 다. 늘어나는 것은 메모리 위의 `bump`
 *   뿐이라 본문 길이가 `staleMs`(60초) 쪽으로 자라지 않는다(`src/lockfile.mjs:30-35` 의
 *   알려진 한계). 실측 근거는 이 파일 헤더의 규모 문단이다.
 *
 * 빈 배열은 **디스크를 건드리지 않고** `{ok:true}` 다 — 쓸 것이 없는데 잠금을 잡고 파일
 * 시각을 흔들 이유가 없다(손상 격리도 일어나지 않는다).
 */
export async function updatePosteriors(stateRoot, updates) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  if (!Array.isArray(updates)) return { ok: false, reason: 'updates 가 배열이 아닙니다.' };

  // `= {}` 파라미터 기본값은 `undefined` 에만 걸린다 — `null` 을 넘기면 구조 분해가 그
  // 자리에서 던진다. `lockfile.mjs:42-45`·`journal.mjs:117-120` 와 같은 층위로 여기서
  // 직접 정규화한다(배열·원시값은 구조 분해가 그대로 통하므로 손대지 않는다).
  const plan = [];
  for (const options of updates) {
    const { cellKey, arm, alphaDelta = 0, betaDelta = 0 } = options !== null && typeof options === 'object' ? options : {};
    if (typeof cellKey !== 'string' || cellKey === '') return { ok: false, reason: 'cellKey 가 비어 있습니다.' };
    if (typeof arm !== 'string' || arm === '') return { ok: false, reason: 'arm 이 비어 있습니다.' };
    plan.push({ cellKey, arm, alphaDelta, betaDelta });
  }
  if (plan.length === 0) return { ok: true };

  const got = await withLearningLock(stateRoot, async () => {
    const loaded = await load(paths.file);
    if (loaded.state === 'unreadable') return { ok: false, reason: loaded.reason };

    const notes = [];
    let cells = {};
    if (loaded.state === 'corrupt') {
      const moved = await renameWithRetry(paths.file, paths.corrupt);
      if (!moved.ok) {
        return { ok: false, reason: `${loaded.reason} 그리고 ${CORRUPT} 로 치우지도 못했습니다: ${moved.reason}` };
      }
      notes.push(`손상된 사후분포를 ${CORRUPT} 로 치우고 백지에서 다시 시작합니다: ${loaded.reason}`);
    } else if (loaded.state === 'ok') {
      cells = clampCells(loaded.raw);
    }

    // Map 으로 다룬다 — `cells[cellKey]` 형태의 읽기·쓰기는 `'__proto__'`·`'toString'` 같은
    // 키에서 프로토타입 사슬로 새어 나간다(clampCells 주석의 실측과 같은 축).
    const byCell = new Map(Object.entries(cells));
    for (const { cellKey, arm, alphaDelta, betaDelta } of plan) {
      const byArm = new Map(Object.entries(byCell.get(cellKey) ?? {}));
      const current = byArm.get(arm) ?? { ...PRIOR };
      const alpha = bump(current.alpha, alphaDelta, 'alpha');
      const beta = bump(current.beta, betaDelta, 'beta');
      // ★ 어느 셀에서 걸렸는지를 붙인다. 배치가 되면 셀이 여럿이라 `alpha 가 하한…` 만으로는
      //   호출자가 그 문장을 어느 축에 붙여야 할지 모른다(`cellKey` 가 곧 축을 담고 있다).
      if (alpha.note) notes.push(`${cellKey}: ${alpha.note}`);
      if (beta.note) notes.push(`${cellKey}: ${beta.note}`);
      byArm.set(arm, { alpha: alpha.value, beta: beta.value });
      byCell.set(cellKey, Object.fromEntries(byArm));
    }

    const written = await writeAtomic(paths, Object.fromEntries(byCell));
    return written.ok ? { ok: true, notes } : { ok: false, reason: written.reason };
  });

  return settle(got);
}

/**
 * Atomically pair a complete posterior target with its explanatory journal row.
 * Callers that already hold `learning.lock` use the unlocked form below; that
 * is the only way to avoid recursively taking the coordinator.
 */
export async function commitLearningMutation(stateRoot, mutation, options) {
  const locked = await withLearningLock(stateRoot, async () => commitLearningMutationUnlocked(stateRoot, mutation, options));
  const settled = settle(locked);
  // Keep the pre-WAL/pending distinction for the automatic-learning caller.
  // `settle` intentionally has a small legacy envelope, so this is additive
  // only on failures that the unlocked transaction classified.
  if (!settled.ok && locked.ok && typeof locked.value?.pending === 'boolean') {
    return { ...settled, pending: locked.value.pending };
  }
  return settled;
}

export async function commitLearningMutationUnlocked(stateRoot, mutation, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  const updates = Array.isArray(mutation?.updates) ? mutation.updates : [];
  const plan = normalizeUpdates(updates);
  if (!plan.ok) return plan;

  let target = { cells: null, notes: [], quarantine: null };
  if (plan.plan.length > 0) {
    target = await buildPosteriorTarget(paths, plan.plan);
    if (!target.ok) return { ...target, pending: false };
  }

  let journal = null;
  if (mutation?.journal !== null && mutation?.journal !== undefined) {
    const generations = await readGenerationsUnlocked(stateRoot);
    if (!generations.ok) return { ...generations, pending: false };
    const prepared = prepareJournalTarget(mutation.journal, generations.generations);
    if (!prepared.ok) return { ...prepared, pending: false };
    journal = prepared.entry;
  }

  const operation = {
    version: 1,
    operationId: makeOperationId(),
    targets: { posteriors: target.cells, generations: null, journal, quarantine: target.quarantine },
  };
  const committed = await commitLearningOperationUnlocked(stateRoot, operation, options);
  if (!committed.ok) {
    // Preparation failures have not created a durable operation; callers may
    // safely record a journal-only, manually rewardable run.  Once the WAL is
    // visible, however, a fallback row would race and overwrite its exact
    // recovery target, so expose that distinction explicitly.
    return { ...committed, pending: await hasPendingLearningOperation(stateRoot) };
  }
  return target.notes.length > 0 ? { ok: true, notes: target.notes } : { ok: true, notes: [] };
}

function normalizeUpdates(updates) {
  if (!Array.isArray(updates)) return { ok: false, reason: 'updates 가 배열이 아닙니다.' };
  const plan = [];
  for (const options of updates) {
    const { cellKey, arm, alphaDelta = 0, betaDelta = 0 } = options !== null && typeof options === 'object' ? options : {};
    if (typeof cellKey !== 'string' || cellKey === '') return { ok: false, reason: 'cellKey 가 비어 있습니다.' };
    if (typeof arm !== 'string' || arm === '') return { ok: false, reason: 'arm 이 비어 있습니다.' };
    plan.push({ cellKey, arm, alphaDelta, betaDelta });
  }
  return { ok: true, plan };
}

async function buildPosteriorTarget(paths, plan) {
  const loaded = await load(paths.file);
  if (loaded.state === 'unreadable') return { ok: false, reason: loaded.reason };
  const notes = [];
  let quarantine = null;
  let cells = {};
  if (loaded.state === 'corrupt') {
    // Do not rename the only corrupt bytes while merely preparing a logical
    // learning operation.  The WAL carries a deterministic quarantine copy;
    // recovery writes that copy and the posterior target in the same replay.
    // A process crash before the WAL therefore leaves the original untouched.
    quarantine = { file: CORRUPT, bytes: loaded.bytes.toString('base64') };
    notes.push(`손상된 사후분포를 ${CORRUPT} 로 보존하고 백지에서 다시 시작합니다: ${loaded.reason}`);
  } else if (loaded.state === 'ok') {
    cells = clampCells(loaded.raw);
  }
  const byCell = new Map(Object.entries(cells));
  for (const { cellKey, arm, alphaDelta, betaDelta } of plan) {
    const byArm = new Map(Object.entries(byCell.get(cellKey) ?? {}));
    const current = byArm.get(arm) ?? { ...PRIOR };
    const alpha = bump(current.alpha, alphaDelta, 'alpha');
    const beta = bump(current.beta, betaDelta, 'beta');
    if (alpha.note) notes.push(`${cellKey}: ${alpha.note}`);
    if (beta.note) notes.push(`${cellKey}: ${beta.note}`);
    byArm.set(arm, { alpha: alpha.value, beta: beta.value });
    byCell.set(cellKey, Object.fromEntries(byArm));
  }
  return { ok: true, cells: Object.fromEntries(byCell), notes, quarantine };
}

function prepareJournalTarget(entry, generations) {
  try {
    if (entry === null || typeof entry !== 'object' || typeof entry.runId !== 'string' || entry.runId === '') {
      return { ok: false, reason: 'runId 가 있는 객체여야 합니다.' };
    }
    const now = Date.now();
    const taskClass = typeof entry.taskClass === 'string' ? entry.taskClass : null;
    const axesOf = (value) => (Array.isArray(value) ? value.filter((axis) => typeof axis === 'string' && axis !== '') : []);
    const mapFor = (axes) => Object.fromEntries(axes.map((axis) => [axis, taskClass === null ? 0 : generationOf(generations, cellKeyOf(taskClass, axis))]));
    const appliedAxes = axesOf(entry.appliedAxes);
    const rewardableAxes = axesOf(entry.rewardableAxes);
    return {
      ok: true,
      entry: {
        ...entry,
        at: Number.isFinite(entry.at) ? entry.at : now,
        updatedAt: now,
        appliedGenerations: mapFor(appliedAxes),
        rewardableGenerations: mapFor(rewardableAxes),
      },
    };
  } catch (error) {
    return { ok: false, reason: `실행 저널 작업을 만들지 못했습니다: ${describe(error)}` };
  }
}

export async function resetPosteriors(stateRoot, options) {
  const paths = pathsFor(stateRoot);
  if (paths === null) return { ok: false, reason: '상태 루트가 절대 경로가 아닙니다.' };
  const { cellKey = null, cellKeys, taskClass, onPhase } = options !== null && typeof options === 'object' ? options : {};
  // ★ 문자열이 아닌 `cellKey` 를 조용히 **전체 삭제**로 떨어뜨리지 않는다. `null`·`undefined`
  //   는 "전부 지워라" 라는 뜻이지만 `42`·`['a::b']`·`{toString(){…}}` 는 셀 하나를 지우려다
  //   손이 미끄러진 것이다 — 그 둘을 같은 답으로 처리하면 사용자가 지우라고 하지 않은 셀까지
  //   사라지고 `{ok:true, cleared:2}` 라는 답만 남는다. `orch_stats` 에 이미 `task_class`
  //   인자가 있으니 셀 범위 reset 이 붙는 순간 이 자리에 값이 흘러든다.
  if (cellKey !== null && cellKey !== undefined) {
    if (typeof cellKey !== 'string') return { ok: false, reason: 'cellKey 가 문자열이 아닙니다.' };
    if (cellKey === '') return { ok: false, reason: 'cellKey 가 비어 있습니다.' };
  }
  if (cellKeys !== undefined) {
    if (cellKey !== null && cellKey !== undefined) return { ok: false, reason: 'cellKey 와 cellKeys 를 함께 줄 수 없습니다.' };
    if (!Array.isArray(cellKeys)) return { ok: false, reason: 'cellKeys 가 배열이 아닙니다.' };
    for (const key of cellKeys) {
      if (typeof key !== 'string' || key === '') return { ok: false, reason: 'cellKeys 에 빈 문자열 아닌 문자열만 넣으세요.' };
    }
  }
  if (taskClass !== undefined) {
    if (typeof taskClass !== 'string' || taskClass === '') return { ok: false, reason: 'taskClass 가 빈 문자열 아닌 문자열이 아닙니다.' };
    if (cellKey !== null && cellKey !== undefined || cellKeys !== undefined) {
      return { ok: false, reason: 'taskClass 는 cellKey 또는 cellKeys 와 함께 줄 수 없습니다.' };
    }
  }
  // `cellKey` 는 기존 단일 호출 계약이다. 범위 reset 은 목록을 이 자리로 넘겨 한 번의
  // 잠금·스냅샷·원자 쓰기로 끝낸다 — 셀마다 부르면 마지막 셀 직전만 복구할 수 있다.
  let only = cellKeys === undefined ? (cellKey ?? null) : new Set(cellKeys);

  const got = await withLearningLock(stateRoot, async () => {
    const loaded = await load(paths.file);
    if (loaded.state === 'unreadable') return { ok: false, reason: loaded.reason };
    if (taskClass !== undefined) {
      if (loaded.state === 'missing') return { ok: true, cleared: 0, asked: 0, cellKeys: [], notes: [] };
      if (loaded.state !== 'ok') return { ok: false, reason: '손상된 사후분포에서는 taskClass 범위를 정할 수 없습니다. 전체 reset을 사용하세요.' };
      only = new Set(
        Object.keys(loaded.raw).filter((key) => {
          const marker = key.indexOf('::');
          return marker >= 0 && key.slice(0, marker) === taskClass;
        }),
      );
    }
    const asked = taskClass === undefined ? undefined : only instanceof Set ? only.size : 0;
    const selectedKeys = taskClass === undefined || !(only instanceof Set) ? null : [...only];
    if (loaded.state === 'missing') {
      // Reset invalidates cleared posterior cells.  With no file there is no
      // cleared cell, so this is a true no-op: it preserves the last paired
      // snapshot and makes a retry after pending-reset recovery idempotent.
      return { ok: true, cleared: 0, ...(asked === undefined ? {} : { asked, cellKeys: selectedKeys }), notes: [] };
    }
    // 빈 범위는 정상·손상 파일 모두에서 무연산이다. 손상 갈래보다 뒤에 두면 "지울 셀이
    // 없다"는 호출이 증거 스냅샷을 덮고 원본을 {}로 바꾸는 파괴적 reset 이 된다.
    if (only instanceof Set && only.size === 0) return { ok: true, cleared: 0, ...(asked === undefined ? {} : { asked, cellKeys: selectedKeys }), notes: [] };
    if (loaded.state === 'corrupt') {
      // 사용자가 "지워라" 라고 부른 자리다. 여기서도 거절하면 손상 상태에서 손으로 파일을
      // 지우는 것 말고 회복 경로가 없다. 몇 개를 지웠는지는 셀 수 없으니 0 으로 두고
      // 무엇을 버렸는지만 말한다.
      //
      // ★★ 그 사실을 **구조로도** 낸다(`discarded`). 한국어 `notes` 문장에만 담으면 호출부가
      //    문장을 정규식으로 훑어야 하고, 문장을 다듬는 순간 조용히 안 잡힌다. 실측(수정
      //    라운드 1, 커밋 ab0e98a): 이 갈래를 탄 `orch_stats` 전체 reset 의 본문이 지울 것이
      //    아예 없던 경우와 **바이트로 같았다** — 둘 다
      //    `{"reset":{"taskClass":null,"asked":null,"cleared":0,"failed":0,"cellKeys":null}}`
      //    이고 confidence 도 둘 다 `verified` 였다. 파일을 읽지도 못한 채 버렸는데.
      // `posteriors.prev.json` 은 reset의 마지막 회복점, `posteriors.corrupt.json` 은 update의
      // 격리본이라 서로 덮지 않는다. 어느 쪽도 증거를 잃지 않게 손상 바이트 자체를 먼저 쓴다.
      const snapshotted = await writeSnapshot(paths, loaded.bytes);
      if (!snapshotted.ok) return { ok: false, reason: `스냅샷을 쓰지 못해 reset 하지 않았습니다: ${snapshotted.reason}` };
      const generationsSnapshotted = await writeGenerationSnapshot(paths);
      if (!generationsSnapshotted.ok) return { ok: false, reason: `세대 스냅샷을 쓰지 못해 reset 하지 않았습니다: ${generationsSnapshotted.reason}` };
      const advanced = await resetGenerationTarget(stateRoot, {}, null, onPhase);
      if (!advanced.ok) return { ...advanced, ...(asked === undefined ? {} : { asked, cellKeys: selectedKeys }) };
      return { ok: true, cleared: 0, discarded: true, snapshotted: true, notes: [`읽을 수 없는 사후분포를 버렸습니다: ${loaded.reason}`] };
    }

    // ★ 클램프한 뷰가 아니라 **날것**에서 지운다. 클램프는 팔 객체가 아닌 셀을 버리는데,
    //   그 뷰를 도로 쓰면 셀 하나를 지우라는 호출이 사용자가 지우라고 하지 않은 셀까지
    //   함께 없앤다. 지우라고 한 것만 지운다 — 남는 쓰레기는 `readPosteriors` 가 어차피
    //   무시하고, 다음 `updatePosterior` 가 정상화한다.
    const byCell = new Map(Object.entries(loaded.raw));
    if (only === null) byCell.clear();
    else if (only instanceof Set) {
      for (const key of only) byCell.delete(key);
    } else byCell.delete(only);

    // ★ `cleared` 는 **파일에서 사라진 최상위 셀의 수**다. 전체 삭제와 셀 삭제를 같은 축으로
    //   센다 — 지운 것보다 적게 말하면 사용자가 남았다고 믿는다.
    const cleared = Object.keys(loaded.raw).length - byCell.size;
    // 지울 것이 없으면 쓰지 않는다 — 없던 파일을 만들지도, 멀쩡한 파일의 시각을 흔들지도
    // 않는다.
    if (cleared === 0) return { ok: true, cleared: 0, ...(asked === undefined ? {} : { asked, cellKeys: selectedKeys }), notes: [] };

    // 삭제와 같은 잠금 안에서, 본 파일보다 먼저 쓴다. 실패하면 본 파일은 아직 그대로다.
    const snapshotted = await writeSnapshot(paths, loaded.bytes);
    if (!snapshotted.ok) return { ok: false, reason: `스냅샷을 쓰지 못해 reset 하지 않았습니다: ${snapshotted.reason}` };
    const generationsSnapshotted = await writeGenerationSnapshot(paths);
    if (!generationsSnapshotted.ok) return { ok: false, reason: `세대 스냅샷을 쓰지 못해 reset 하지 않았습니다: ${generationsSnapshotted.reason}` };
    const removed = Object.keys(loaded.raw).filter((key) => !byCell.has(key));
    const advanced = await resetGenerationTarget(stateRoot, Object.fromEntries(byCell), only === null ? null : removed, onPhase);
    return advanced.ok
      ? { ok: true, cleared, snapshotted: true, ...(asked === undefined ? {} : { asked, cellKeys: removed }), notes: [] }
      : { ...advanced, ...(asked === undefined ? {} : { asked, cellKeys: selectedKeys }) };
  });

  const settled = settle(got);
  // `discarded:true` 는 "읽을 수 없는 파일을 통째로 버렸다" 는 뜻이다 — `cleared:0` 이 그것을
  // "지울 것이 없었다" 와 구별하지 못한다. `notice` 와 같은 **덧붙는 키**로 둔다(그 갈래에서만
  // 나타난다) — 늘 싣게 하면 이 봉투를 정확 집합으로 재는 기존 단언 다섯이 뜻 없이 붉어진다.
  const 버렸나 = got.value?.discarded === true ? { discarded: true } : {};
  if (!settled.ok) {
    return got.ok && Number.isInteger(got.value?.asked)
      ? { ...settled, asked: got.value.asked, cellKeys: got.value.cellKeys }
      : settled;
  }
  return {
    ...settled,
    ...버렸나,
    cleared: got.value.cleared,
    ...(Number.isInteger(got.value?.asked) ? { asked: got.value.asked, cellKeys: got.value.cellKeys } : {}),
  };
}

/** Advance reset validity in the same WAL as the target posterior file. */
async function resetGenerationTarget(stateRoot, posteriors, scopedKeys, onPhase) {
  const existing = await readGenerationsUnlocked(stateRoot);
  if (!existing.ok) return existing;
  const next = {
    global: existing.generations.global,
    cells: { ...existing.generations.cells },
  };
  if (scopedKeys === null) {
    // A global epoch must outrun *every* scoped override.  Merely incrementing
    // global from 0 to 1 leaves a previous scoped cell at local generation 1
    // unchanged under generationOf(max), allowing an old correction through.
    next.global = Math.max(existing.generations.global, ...Object.values(existing.generations.cells), 0) + 1;
    next.cells = {};
  } else {
    for (const key of scopedKeys) next.cells[key] = generationOf(existing.generations, key) + 1;
  }
  return commitLearningOperationUnlocked(stateRoot, {
    version: 1,
    operationId: makeOperationId(),
    targets: { posteriors, generations: next, journal: null },
  }, { onPhase });
}

/**
 * `withLock` 의 결과를 이 모듈의 봉투로 옮긴다.
 *
 * `released:false` 는 본문이 잘 끝났어도 잠금 경로에 뭔가 남아 다음 호출을 `staleMs`(기본
 * 60초) 동안 막는다는 뜻이다(`src/lockfile.mjs:21-26`). 저널이 그것을 `notice` 로 올리는
 * 것과 같은 이유로 여기서도 올린다 — 버리면 그 창에서 학습이 조용히 멈춘다. `notice` 는
 * 덧붙는 키라 `.ok` 만 보는 태스크 8·10 과 어긋나지 않는다.
 */
function settle(got) {
  const leftover = got.released === false ? `사후분포 잠금이 남았습니다: ${got.releaseReason}` : null;
  if (!got.ok) return { ok: false, reason: [got.reason, leftover].filter(Boolean).join(' / ') };
  const inner = got.value;
  if (!inner.ok) return { ok: false, reason: [inner.reason, leftover].filter(Boolean).join(' / ') };
  const notices = [...inner.notes, leftover].filter(Boolean);
  return notices.length > 0 ? { ok: true, notice: notices.join(' / ') } : { ok: true };
}

/**
 * 델타 하나를 더한다. 하한 밑으로는 내려가지 않는다.
 *
 * 하한은 prior 이되 현재 값이 이미 그보다 작으면 현재 값이다 — 헤더의 "없던 관측을 만들어
 * 내지 않는다" 가 이 한 줄이다.
 */
function bump(base, delta, name) {
  const step = Number.isFinite(delta) ? delta : 0;
  const next = base + step;
  if (!Number.isFinite(next)) {
    return { value: base, note: `${name} 가 유한한 범위를 넘어 갱신하지 않았습니다.` };
  }
  const floor = Math.min(base, PRIOR[name]);
  if (next < floor) {
    return { value: floor, note: `${name} 가 하한 ${floor} 밑으로 내려가 막았습니다(${base} + ${step} = ${next}).` };
  }
  return { value: next, note: null };
}

/**
 * 임시 파일에 쓰고 fsync 한 뒤 제자리로 옮긴다. 실패하든 성공하든 임시 파일은 남기지 않는다.
 *
 * rename 이 성공하면 임시 경로는 이미 없어 `rm` 이 무연산이고, 실패하면 그것이 치운다.
 */
async function writeAtomic(paths, cells) {
  return writeAtomicBytes(paths, paths.file, FILE, Buffer.from(`${JSON.stringify(cells, null, 2)}\n`, 'utf8'), '사후분포');
}

/** reset 전 원본 바이트 하나를 남긴다. JSON으로 다시 만들면 손상 바이트를 잃는다. */
async function writeSnapshot(paths, bytes) {
  return writeAtomicBytes(paths, paths.snapshot, SNAPSHOT_FILE, bytes, '사후분포 스냅샷');
}

/** Reset validity is part of the restorable learning state, not disposable metadata. */
async function writeGenerationSnapshot(paths) {
  let bytes;
  try {
    bytes = await readFile(paths.generations);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, reason: describe(error) };
    // A missing sidecar is legacy generation 0.  Materialize that exact
    // meaning in the snapshot so restoring it also restores old journal rows.
    bytes = Buffer.from('{\n  "global": 0,\n  "cells": {}\n}\n', 'utf8');
  }
  return writeAtomicBytes(paths, paths.generationSnapshot, GENERATIONS_SNAPSHOT_FILE, bytes, '학습 세대 스냅샷');
}

async function writeAtomicBytes(paths, target, name, bytes, label) {
  const tmp = join(paths.root, `${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    // 'wx' — 남의 임시 파일 위에 쓰지 않는다. UUID 가 겹칠 일은 없지만 앞선 실행이 남긴
    // 잔재와 이름이 같을 때 조용히 이어 쓰는 것보다 실패하는 편이 낫다.
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(bytes);
      // fsync 실패는 쓰기 실패가 아니다(네트워크 마운트에서 EINVAL 이 난다) — 내구성만
      // 잃고 내용은 그대로다. 그래서 삼킨다.
      await handle.sync().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    const moved = await renameWithRetry(tmp, target);
    return moved.ok ? { ok: true } : { ok: false, reason: `${label}을(를) 제자리로 옮기지 못했습니다: ${moved.reason}` };
  } catch (error) {
    return { ok: false, reason: `${label}을(를) 쓰지 못했습니다: ${describe(error)}` };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Windows 의 rename EPERM(목적지가 열려 있음)은 대개 몇 ms 안에 풀린다. 헤더의 실측 참고. */
async function renameWithRetry(from, to) {
  let last = null;
  for (let attempt = 1; attempt <= RENAME_TRIES; attempt += 1) {
    try {
      await rename(from, to);
      return { ok: true };
    } catch (error) {
      last = error;
      const retryable = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY';
      if (!retryable || attempt === RENAME_TRIES) break;
      await new Promise((r) => setTimeout(r, RENAME_WAIT_MS));
    }
  }
  return { ok: false, reason: describe(last) };
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
