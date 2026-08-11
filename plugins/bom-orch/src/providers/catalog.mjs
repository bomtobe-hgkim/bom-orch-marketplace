import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILENAME = 'model-catalog.json';

/** 부팅 프로브의 TTL. */
export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * 사용 시점(orch_models 호출)의 TTL. 부팅 창보다 훨씬 짧다 — 부팅 프로브 이후에 나온
 * 모델이 TTL 만료 + 서버 재시작을 기다리지 않고 다음 조회에 바로 보이게 한다.
 */
export const POINT_OF_USE_MAX_AGE_MS = 5 * 60 * 1000;

/** 캐시를 읽는다. 없거나 깨졌으면 빈 객체 — 절대 throw 하지 않는다. */
export async function readCatalog(stateRoot) {
  try {
    const text = await readFile(join(stateRoot, FILENAME), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    // 없음·깨짐·권한 없음 — 전부 "캐시 없음"으로 강등한다. 캐시는 최적화이지
    // 정확성 요건이 아니다. 여기서 던지면 프로브 하나 때문에 서버가 안 뜬다.
    return {};
  }
}

/**
 * 한 벤더의 목록을 쓴다. 임시 파일 + rename 으로 원자적으로 — 부분 쓰기로 파일이
 * 깨지면 다음 부팅에 캐시를 통째로 잃는다.
 *
 * 빈 목록은 쓰지 않는다: 프로브가 일시적으로 실패했다고 이미 있는 좋은 캐시를
 * 지우면 **되돌아갈 목록이 아무 데도 없다**. 계획 3 태스크 9 가 폴백 목록 파일을
 * 지웠으므로(소비자 0곳) 캐시를 잃은 벤더는 `orch_config` 에서 빈 목록 +
 * `orch_models 를 먼저 부르세요` notice 로 나오고 effort 검사를 건너뛴다.
 *
 * 절대 throw 하지 않는다. 디스크에 남았으면 true, 건너뛰었거나 실패했으면 false.
 */
export async function writeCatalog(stateRoot, vendorId, models, now = Date.now()) {
  if (!Array.isArray(models) || models.length === 0) return false;

  // 읽고-고쳐-쓰기라 병렬 호출이 서로를 덮어쓴다. 부팅 프로브가 두 벤더를 동시에
  // 돌리므로 이건 가상의 경합이 아니라 기본 사용 경로다. 프로세스 안에서 쓰기를
  // 한 줄로 세워 lost update 를 막는다.
  //
  // 큐에는 절대 거부된 프라미스가 실리면 안 된다. 한 번 실리면 이후의 .then 은
  // 콜백을 부르지 않고 그대로 통과시키므로, 잘못된 호출 하나가 프로세스가 사는
  // 내내 모든 벤더의 캐시 쓰기를 죽인다(실측). writeOne 이 스스로 삼킨다는 사실에
  // 기대지 않고 여기서 한 번 더 막는다 — 그래야 미래의 편집 한 줄이 큐를 망가뜨리지
  // 못한다. 거부 핸들러까지 두는 건 큐가 어떤 경로로든 거부됐을 때의 자가 복구다.
  const run = async () => {
    try {
      return await writeOne(stateRoot, vendorId, models, now);
    } catch {
      return false;
    }
  };

  writeQueue = writeQueue.then(run, run);
  return writeQueue;
}

let writeQueue = Promise.resolve();
let tempCounter = 0;

async function writeOne(stateRoot, vendorId, models, now) {
  // try 는 함수 본문 전체를 덮어야 한다. 파일 접근만 감싸면 그 앞줄들이 새어나간다 —
  // new Date(NaN).toISOString() 은 RangeError 를, join(비문자열, …) 은 TypeError 를
  // 던진다. 둘 다 실제로 큐를 거부시켜 이후 모든 쓰기를 죽였다(실측).
  let temp;
  try {
    const catalog = await readCatalog(stateRoot);
    catalog[vendorId] = { models, fetchedAt: new Date(now).toISOString() };

    const target = join(stateRoot, FILENAME);
    // pid 만으로는 같은 프로세스의 두 쓰기가 같은 임시 경로를 쓴다. 카운터를 붙인다.
    temp = `${target}.${process.pid}.${tempCounter++}.tmp`;

    await mkdir(stateRoot, { recursive: true });
    await writeFile(temp, JSON.stringify(catalog, null, 2), 'utf8');
    await rename(temp, target);
    return true;
  } catch {
    // 읽기와 같은 이유로 삼킨다: 캐시는 최적화이지 정확성 요건이 아니다. 여기서
    // 던지면 await 없이 부른 호출부에서 처리되지 않은 거부가 되어 프로세스가 죽는다.
    if (temp !== undefined) await rm(temp, { force: true }).catch(() => {});
    return false;
  }
}

/** 항목이 없거나 maxAgeMs 보다 오래됐으면 true. */
export function shouldRefresh(catalog, vendorId, maxAgeMs, now = Date.now()) {
  const entry = catalog?.[vendorId];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return true;

  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return true;

  // 미래 시각은 시계가 되돌아왔다는 뜻이다. "아직 신선함"으로 읽으면 그 시각이 될
  // 때까지 굳은 캐시를 붙들고 있게 되므로, 믿지 말고 갱신한다.
  if (fetchedAt > now) return true;

  return now - fetchedAt >= maxAgeMs;
}
