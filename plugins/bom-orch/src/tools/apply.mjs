// src/tools/apply.mjs
/**
 * `orch_apply` — 끝난 실행이 남긴 패치를 **사용자 저장소에 명시적으로** 적용하는 경로
 * (WS0 §1.4, WS5 스펙 §0 AP). 새 핸들러는 `src/tools/<name>.mjs` 로 간다(WS0 §8: `src/tools.mjs`
 * 증가는 스펙 행과 배선뿐) — 공유 배선은 `src/tools/context.mjs` 에서 오고 `tools.mjs` 를
 * 되부르면 순환이다.
 *
 * ★★ **이 파일은 관문이고 배선이지, 적용기가 아니다.** git 판정 자체는 `src/apply-patch.mjs`
 *   (WS5 태스크 8)가 하고 이 파일은 그 앞뒤를 안다: 이름·기록·패치의 존재, **이 바이트가 그
 *   실행의 패치인가**(WS0 §1.4 (1)), **어느 저장소인가**, 그리고 결과를 봉투로 옮기는 일.
 *   나뉜 이유는 폐포다 — 판정기는 진짜 저장소 하나만 있으면 전부 잴 수 있고, 실행이 무엇인지
 *   알게 되는 순간 그 성질이 사라진다.
 *
 * ★ 실측 폐포: **51개 모듈 / 20,446줄**(자기 자신 557 포함) — 리더 열(`run-read`·`run-manifest`·`manifest-selection`·
 *   `manifest-vocabulary`·`proof-record`·`candidate-selection`·`verdict`·`preflight`·`run-records`·`run-store-fs`·`real-path`) 11, 저널 열(`learn/journal`·`learn/learning`·`lockfile`·`diag`) 4,
 *   문맥 열(`tools/context`·`run-inspect`) 2, 범위 열(`patch-scope`·`scope-allowlist`·`test-discovery`·
 *   `deps-provision`·`project-config`·`deadline`·`providers/child-env`) 7, 봉투 넷(`envelope`·`reason-codes`·
 *   `reason-text`·`run-faults`), 적용 다섯(`apply-patch`·`git`·`providers/error-catalog`·
 *   `providers/resolve-binary`·`worktree-patch`), `confidence`·`redact`·`state-root` 3, 유틸 일곱
 *   (`util/errors`·`util/freeze`·`util/fs-atomic`·`util/hash`·`util/objects`·`util/paths`·`util/strings`) — 의존 43개 전수다. **`engine` 도 저장소(`run-artifacts`)도 0개다** — 이 관문은
 *   끝난 실행을 읽어 현재 HEAD 정책으로 범위를 다시 재고 저널의 최신 행을 주석할 뿐 실행을 **만들지** 않으며,
 *   `test/guards/module-directions.test.mjs` 의 방향 표가 오케스트레이터/저장소 수입을 못 박는다.
 *
 * ★ **불변식 5**: 이 서버가 `stateRoot` 밖에 쓰는 자리는 로드맵 `:532-535` 가 예외 (b) 로 이미
 *   이름 부른 **이 호출의 적용 그 자체**뿐이다. 그 예외는 `src/apply-patch.mjs` 의 두 명령
 *   (`git apply` · `git apply --3way`)뿐이다. 그 둘이 실패한 뒤에는 저장소를 더 쓰지 않고
 *   적용 직전에 뜬 바이트·모드와 현재 상태를 비교해, 다르면 양쪽을 보존하고 수동 복구를
 *   요구한다. 임시
 *   인덱스도 **판정이 쓰는 객체**도 백업도 `<stateRoot>/scratch/` 에서 산다(태스크 8 리뷰 I1).
 *   그래서 `check_only` 와 **관문의 거절 전부**가 사용자 저장소를 **바이트 그대로** 남긴다:
 *   작업 트리·인덱스·porcelain·객체 DB 넷을 `test/apply-patch.test.mjs` 가 전수 대조한다.
 *   경계 둘은 정직하게 적는다 — (1) 쓰기 뒤에는 자동 복원하지 않고, 같다고 직접 잰 patch 경로·
 *   porcelain 만 주장한다(`git apply --3way` 도 객체를 남길 수 있고 status 는 index 바이트 증명이
 *   아니다), (2) 경로는 같아도 status 를 못 믿으면 `apply_verification_failed`, 경로가 다르거나
 *   unsafe 면 mapped backup 을 남긴 `apply_rollback_incomplete` 다. 이 파일 자신은 읽기만 한다.
 *
 * ★ **인자는 계약이 예약한 것만 받는다**(WS5 태스크 7 판정, 「없는 필드를 지어내지 않는다」):
 *     · `run_id`     — 필수. `contract/envelope.json:95` 가 최상위 `runId` 행의 `when` 에
 *                      `orch_apply` 를 이름으로 적어 둔 그 값이다.
 *     · `check_only` — 선택. `contract/envelope.json` 의 `confidenceByTool.orch_apply` 가
 *                      `unverified: "check_only"` 라고 적어 두었다. 그 행이 가리키는 인자가
 *                      없으면 계약의 그 줄은 닿을 수 없는 문장이다(D11 이 없애려는 유령의
 *                      한 종류다).
 *     · `allow_unproven` — 선택. `contract/envelope.json` 의 `applyBody.proof` 행이 본문의
 *                      `proof.overridden` 을 이 인자의 흔적으로 못박고, `confidenceByTool.
 *                      orch_apply` 의 `unverified` 행이 그 뜻을 적는다. 이 인자가 없으면
 *                      증명 게이트는 **탈출구 없는 문**이다 — 증명을 못 돌리는 저장소에서
 *                      적용이 영영 막힌다.
 *   WS0 §1.4 가 함께 적어 둔 `three_way`·`candidate_id` 는 **안 받는다.**
 *     · `three_way`: WS5 스펙 §0 D4 는 HEAD 이동만으로 3-way를 고르지 않는다. 현재 작업
 *       트리에 direct를 먼저 시도하고, 그것이 안 붙을 때만 임시 인덱스 3-way와 `ls-files -u`로
 *       판정한다 — 플래그가 지키던 문(門)이 사라졌으므로 플래그만 남기면 아무 데도 안 걸리는
 *       인자가 된다.
 *     · `candidate_id`: WS5 스펙 §0 AP 는 이 도구를 실행의 **대표 패치** 하나에 묶는다.
 *       `tie`·`none` 은 대표 패치가 없고(그때는 `apply_patch_missing` 이 후보 경로를 가리키는
 *       회복을 낸다), 후보를 골라 적용하는 것은 아직 아무 스펙도 정의하지 않았다.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { applyPatchToRepository } from '../apply-patch.mjs';
import { confidenceOfApply } from '../confidence.mjs';
import { failure, success } from '../envelope.mjs';
import { inspectRepo } from '../git.mjs';
import { readRuns, recordRunNote } from '../learn/journal.mjs';
import { PROOF_STATUSES } from '../manifest-vocabulary.mjs';
import { inspectPatch } from '../patch-scope.mjs';
import { readProjectConfig } from '../project-config.mjs';
import { readProofRecord } from '../proof-record.mjs';
import { REASON } from '../reason-codes.mjs';
import { renderNotice } from '../reason-text.mjs';
import { statusOfReasonCode } from '../run-faults.mjs';
import { unionScopeAllow } from '../scope-allowlist.mjs';
import { resolveStateRoot } from '../state-root.mjs';
import { readRunManifest, runIdText, usableRunId } from '../run-read.mjs';
import { errorText } from '../util/errors.mjs';
import { sha256 } from '../util/hash.mjs';
import { clipPlain } from '../util/strings.mjs';
import { toEngineDeps } from './context.mjs';

/**
 * 실행의 **대표 패치**가 사는 자리 — `<stateRoot>/patches/<runId>.patch`.
 *
 * ★ 경로를 여기서 다시 조립하는 이유: 이 값을 만드는 정본은 `src/content-projection.mjs`
 *   `artifactPaths` 의 `winnerAliasPath` 인데 그 함수는 내보내지지 않고, 그것을 내보내게 하려면
 *   봉투 투영 모듈(1,641줄)이 이 읽기 전용 경로의 폐포에 들어온다. 조각은 두 부분(`patches`
 *   디렉터리와 `<runId>.patch`)뿐이고, 같은 두 부분을 `src/run-manifest.mjs:639`(매니페스트가
 *   ref 를 검증하는 자리)와 `src/run-inspect.mjs:48`(리퍼가 읽는 자리)도 각자 적고 있다 —
 *   즉 이미 사본이 셋인 모양이고, 넷째를 더하는 대신 정본을 만드는 것은 태스크 8/WS6 의 일이다.
 */
const winnerPatchPath = (stateRoot, runId) => join(stateRoot, 'patches', `${runId}.patch`);

/**
 * 실패 봉투의 `status` 는 코드가 정한다(`statusOfReasonCode`) — **예외 하나**를 빼고.
 *
 * ★ `apply_run_not_found` 의 조악값은 `blocked` 지만 봉투는 `invalid` 로 나간다.
 *   `orch_status` 가 `status_run_not_found` 에서, `orch_reward` 가 `learning_run_not_found` 에서
 *   하는 것과 같다: 「그런 이름의 실행이 없다」는 실행 전의 전제 조건 실패가 아니라 **호출자가
 *   지목한 값**의 문제이고, 다음 행동은 재시도가 아니라 다른 이름을 대는 것이다.
 */
const envelopeStatusOf = (reasonCode) =>
  (reasonCode === REASON.apply_run_not_found ? 'invalid' : statusOfReasonCode(reasonCode));

/**
 * 거절 봉투 하나. 문구는 레지스트리가 렌더한다 — 이 파일은 문장을 쓰지 않는다(WS2 §7.2).
 *
 * ★ `runId` 는 **쓸 수 있는 이름일 때만** 싣는다. 그 자리는 읽기에서 상한을 받지 않는 유일한
 *   문자열이고(`src/tools/status.mjs` 의 같은 판단, 최종 리뷰 M1), 20만 자짜리 이름을 그대로
 *   최상위에 실으면 봉투가 자기 상한 밖으로 나간다. 모양이 아닌 이름은 문장 안에서만 보이고
 *   거기서는 `MAX_PARAM_CHARS` 가 자른다.
 */
const refuse = (reasonCode, { runId, params } = {}) => failure({
  status: envelopeStatusOf(reasonCode),
  reasonCode,
  params,
  ...(typeof runId === 'string' && usableRunId(runId) ? { runId } : {}),
});

/** 봉투에 실리는 경로 하나의 상한. `src/tools/status.mjs` 와 같은 값이다(같은 종류의 값이다). */
const PATH_CHARS = 1_024;

/** 파일 목록의 상한 셋 — WS5 태스크 6 의 `dirtyFiles` 와 **같은 산술**이다(개수·낱개·총합). */
const MAX_FILES = 10;
const FILE_PATH_CHARS = 256;
const FILE_TOTAL_CHARS = 1_000;
const MAX_SCOPE_REASONS = 10;
const SCOPE_TEXT_CHARS = 200;

const clipPath = (value, limit) =>
  (typeof value === 'string' && value.length > limit ? `${value.slice(0, limit - 1)}…` : value ?? null);

/**
 * 파일 목록 하나를 세 상한으로 동시에 자른다. 상한을 넘는 항목은 **자르지 않고 버린다** —
 * 반쯤 잘린 경로는 붙여넣어도 안 열리므로 실려 봐야 자리만 차지한다(태스크 6 의 같은 판단).
 */
function boundedFiles(files) {
  const kept = [];
  let total = 0;
  let omitted = 0;
  for (const one of Array.isArray(files) ? files : []) {
    const path = typeof one?.path === 'string' ? one.path : null;
    if (path === null || path.length > FILE_PATH_CHARS || kept.length >= MAX_FILES || total + path.length > FILE_TOTAL_CHARS) {
      omitted += 1;
      continue;
    }
    kept.push(path);
    total += path.length;
  }
  return { kept, omitted };
}

/** Task 4의 여섯 독자와 같은 fail-closed 컷. Task 9가 일곱째 독자다. */
function unapprovedScope(scope) { return scope?.flagged !== false && scope?.allowlisted !== true; }

/** 내부 tier/promotable 축은 빼고 host 계약의 `{path, rule, detail}`만 유계로 투영한다. */
function boundedScope(scope) {
  const source = Array.isArray(scope?.reasons) ? scope.reasons : [];
  const reasons = source.slice(0, MAX_SCOPE_REASONS).map((reason) => ({
    path: clipPlain(reason.path, SCOPE_TEXT_CHARS),
    rule: clipPlain(reason.rule, SCOPE_TEXT_CHARS),
    detail: clipPlain(reason.detail, SCOPE_TEXT_CHARS),
  }));
  const producerOmitted = Number.isSafeInteger(scope?.omitted) && scope.omitted >= 0 ? scope.omitted : 0;
  const reasonCount = source.length + producerOmitted;
  return {
    flagged: scope?.flagged === true,
    hardViolation: scope?.hardViolation === true,
    allowlisted: scope?.allowlisted === true,
    reasons,
    reasonCount,
    omittedReasonCount: reasonCount - reasons.length,
  };
}

/** 대표 별칭과 같은 후보의 결과 tree. 매니페스트 정규화 뒤에도 다시 같은 관계를 이름으로 읽는다. */
function winnerTreeOf(manifest) {
  const candidateId = manifest?.selection?.selectedCandidateId;
  const candidate = Array.isArray(manifest?.candidateRefs)
    ? manifest.candidateRefs.find((one) => one.candidateId === candidateId)
    : null;
  return typeof candidate?.treeHash === 'string' ? candidate.treeHash : null;
}

/**
 * 오버라이드가 **없는** 두 값 — 증명이 돌았고 서지 않았다. 어휘의 정본은 `PROOF_STATUSES` 이고
 * 여기서 걸러 쓰는 이유는 사본을 만들지 않기 위해서다(어휘가 줄면 이 목록도 같이 준다).
 */
const PROOF_FAILED = Object.freeze(PROOF_STATUSES.filter((one) => one === 'not_proven' || one === 'flaky'));

/**
 * ★★ **증명 게이트**(설계 §1.4). 읽기만 한다 — 이 함수는 아무것도 돌리지 않고 아무것도 쓰지 않는다.
 *
 *   proofGate({ stateRoot, runId, manifest, allowUnproven }, wired) ->
 *     { ok: true, proof: {status, attemptId, overridden} } | { ok: false, reasonCode, params }
 *
 * ★★ 왜 이 문이 생겼나(실측): 실행 9(`run-mtcz280y-01xnz4`, 2026-08-28)는 첫 수용 후보를 냈는데도
 *   봉투가 `unverified` 였다 — 회귀 증명은 전체 스위트 여섯 번이고 이 저장소는 한 번 ~7분이라
 *   55분 상한이 다섯 번째 실행 뒤에 끊었다. 그래서 증명은 실행에서 떨어져 `orch_prove` 로 갔고,
 *   「적용 시점에 증명이 아직 없다」가 예외가 아니라 **기본 상태**가 됐다. 그 상태를 조용히
 *   통과시키면 이 도구는 증명이 있다는 인상만 주고 아무것도 확인하지 않는다.
 * ★ 정체성은 **트리 해시와 패치 바이트**다(커밋 sha 가 아니다 — resume 게이트와 같은 원칙).
 *   그 둘이 다르면 그 증명은 이 패치의 것이 아니고, 「증명이 있다」는 문장이 다른 패치를 가리킨다.
 * ★ 못 읽은 기록은 **없는 기록과 같은 행**이다: 둘 다 「이 패치가 증명됐다」를 못 말한다. 다만
 *   실패한 증명(`not_proven`·`flaky`)과는 절대 섞지 않는다 — 그쪽은 오버라이드가 없다.
 */
async function proofGate({ stateRoot, runId, manifest, allowUnproven }, wired = {}) {
  if (manifest?.proofRequirement?.required !== true) {
    return { ok: true, proof: { status: 'not_applicable', attemptId: null, overridden: false } };
  }
  const read = typeof wired.readProofRecord === 'function' ? wired.readProofRecord : readProofRecord;
  const got = await read({ stateRoot, runId });
  const record = got?.ok === true ? got.record : null;
  const status = PROOF_STATUSES.includes(record?.status) ? record.status : null;
  const attemptId = typeof record?.attemptId === 'string' ? record.attemptId : null;
  if (PROOF_FAILED.includes(status)) {
    return { ok: false, reasonCode: REASON.apply_proof_failed, params: { runId } };
  }
  if (status === 'proved' && record.treeHash === winnerTreeOf(manifest) &&
      record.patchSha256 === manifest.winnerAlias?.sha256) {
    return { ok: true, proof: { status, attemptId, overridden: false } };
  }
  return allowUnproven === true
    ? { ok: true, proof: { status: status ?? 'unavailable', attemptId, overridden: true } }
    : { ok: false, reasonCode: REASON.apply_proof_missing, params: { runId } };
}

/**
 * 후보의 **post-patch tree**를 stateRoot 임시 index로 읽어 scope를 다시 잰다.
 * 대상 작업 트리를 그대로 읽으면 새 symlink와 바뀐 package scripts가 아직 없어서 fail-open이다.
 * 승인 권위는 대상 저장소의 현재 HEAD에 커밋된 `.bom-orch.json`뿐이다. 일회성 `scope_allow`는
 * 어느 durable record에도 없으므로 나중 권한으로 추정하지 않는다.
 */
async function inspectApplyScope({ manifest, project, wired, boundary }) {
  const tree = winnerTreeOf(manifest);
  if (tree === null) return { blocked: true, reasonCode: REASON.scope_index_unreadable };
  const index = join(boundary.scratch, 'scope-index');
  const seeded = await boundary.git(['read-tree', tree], { GIT_INDEX_FILE: index });
  if (seeded?.ok !== true) return { blocked: true, reasonCode: REASON.scope_index_unreadable };

  const readConfig = typeof wired.readProjectConfig === 'function' ? wired.readProjectConfig : readProjectConfig;
  // 설정도 후보 index와 같은 replace-disabled Git 경계를 지나야 한다. 아니면 실제 HEAD를
  // 바꾸지 않고 replacement commit 하나만으로 scope.allow를 넓힐 수 있다.
  const configured = await readConfig(
    { commit: boundary.head, cwd: project },
    { run: ({ args, env }) => boundary.git(args, env) },
  );
  if (configured?.ok !== true) return configured;
  const allow = unionScopeAllow(configured.config?.scope?.allow).entries;
  // 합성 commit은 패치 보존 기간보다 먼저 GC될 수 있지만 manifest의 baseline tree가 살아 있으면
  // package scripts의 전후 대조는 계속할 수 있다. tree 자체를 먼저 확인해, 못 읽는 tree:path를
  // "그 파일은 원래 없었다"로 접는 inspectPatch의 빈 파일 의미와 섞지 않는다. 확인 실패는
  // baseline을 생략해 package.json을 보수적인 package-baseline-missing으로 플래그하게 한다.
  const baselineTree = manifest?.baseline?.tree;
  const baselineProbe = typeof baselineTree === 'string' && baselineTree !== ''
    ? await boundary.git(['cat-file', '-e', `${baselineTree}^{tree}`], { GIT_INDEX_FILE: index })
    : null;
  const inspect = typeof wired.inspectPatch === 'function' ? wired.inspectPatch : inspectPatch;
  const scope = await inspect({
    files: boundary.patchPaths,
    worktree: project,
    baseline: baselineProbe?.ok === true ? baselineTree : undefined,
    allow,
  }, {
    // 모든 index 읽기를 후보 tree로 고정한다. blob과 baseline commit은 사용자 object DB에서 읽기만 한다.
    run: ({ args }) => boundary.git(args, { GIT_INDEX_FILE: index }),
  });
  if (scope?.ok !== true) return scope;
  return unapprovedScope(scope)
    ? { blocked: true, reasonCode: REASON.apply_scope_refused, scope }
    : { ok: true, scope };
}

/**
 * 이 실행이 **어느 저장소**에서 시작됐나 — 저널 행의 `project` 다.
 *
 * ★★ 왜 인자가 아닌가: 패치는 자기 baseline 이 담은 저장소에 묶인다. 저장소 경로를 인자로
 *   받으면 「A 에서 만든 패치를 B 에 적용」이 한 번의 오타로 가능해지고, 그것은 이 도구가
 *   막으려는 바로 그 사고다. 서버의 cwd 도 답이 아니다 — `orch_run` 이 `project` 를 **필수**
 *   인자로 받는 이유가 그것이다(호스트가 어디서 떴는지는 사용자의 의도가 아니다).
 * ★ 왜 저널인가: 그 값을 남기는 durable 한 자리가 저널 하나다(매니페스트에는 없다 —
 *   `MANIFEST_KEYS` 25 에 프로젝트 경로가 없다). 그리고 저널에는 **보존 정책이 없어서**
 *   30일 보존의 패치보다 오래 산다 — 이 도구가 필요로 하는 방향의 어긋남이다(§C.5 의 반대).
 * ★ 왜 `readRuns` 인가(`findRunUnlocked` 가 아니라): pending WAL이 있으면 학습 프로토콜 아래에서
 *   먼저 회복한다. 그 뒤의 평범한 저널 읽기는 lock-free이고 부분 JSON 행을 안전하게 건너뛴다 —
 *   다른 `orch_run` 의 마감과 직렬화한다고 주장하지 않는다. `orch_status` 가 같은 리더를 쓴다.
 */
async function projectOf(stateRoot, runId) {
  const read = await readRuns(stateRoot, { limit: Number.MAX_SAFE_INTEGER });
  if (read?.ok !== true) return read;
  const row = read.runs.find((one) => one.runId === runId) ?? null;
  const project = row?.project;
  return { ok: true, project: typeof project === 'string' && project !== '' && isAbsolute(project) ? project : null };
}

const FORWARDED_INSPECTION_CODES = new Set([
  REASON.git_cli_unavailable,
  REASON.git_version_below_floor,
]);

/** Git 설치 자체의 조치 가능한 실패만 보존하고, 저장소 상태 실패는 apply 주체로 번역한다. */
export function routeRepositoryInspection(repository, project) {
  if (repository?.ok === true) return null;
  return FORWARDED_INSPECTION_CODES.has(repository?.reasonCode)
    ? { kind: 'forward', failure: repository }
    : { kind: 'map', reasonCode: REASON.apply_project_unusable, params: { path: project } };
}

/** 이미 렌더된 하위 실패를 다른 문구로 추측하지 않고 적용 호출의 runId 만 보탠다. */
const carryFailure = (source, runId) => failure({
  status: statusOfReasonCode(source.reasonCode),
  reasonCode: source.reasonCode,
  error: source.error,
  recovery: source.recovery,
  runId,
});

/**
 * ★★ 적용. 관문 셋을 지난 뒤 판정기(`src/apply-patch.mjs`)를 부르고 결과를 봉투로 옮긴다.
 *
 *   applyRun({ stateRoot, runId, manifest, patchPath, checkOnly }) -> Promise<envelope>
 *
 *   · `stateRoot`  절대 경로, 이미 정규화됐다. 임시 인덱스도 여기 아래에서 산다.
 *   · `runId`      `usableRunId` 를 통과한 이름.
 *   · `manifest`   `normalizeRunManifestV1` 을 지난 매니페스트. `manifest.baseline` 은
 *                  `{commit, tree}` **정확히 두 키**다(WS5 태스크 6 인계). 깨끗한 시작이면 그
 *                  commit 은 시작 HEAD 이고, 이식할 작업이 있으면 서버가 찍은 합성 커밋이다 —
 *                  어느 쪽이든 대조 대상은 지금 저장소의 `git status` 이지 봉투의 `baseline`
 *                  행이 아니다(그 행은 고지일 뿐이다).
 *   · `patchPath`  존재가 확인된 대표 패치의 절대 경로.
 *   · `checkOnly`  참이면 저장소를 바꾸지 않고 「무엇을 했을 것인가」만 보고한다.
 *   · `proof`      `proofGate` 가 낸 `{status, attemptId, overridden}`. 이 함수는 그것을 **나르기만**
 *                  한다 — 판정은 이미 관문에서 끝났고, 여기서 다시 재면 두 곳이 갈린다.
 *
 * 관문 셋(전부 저장소를 열기 **전**이다):
 *   1. **이 바이트가 그 실행의 패치인가** — WS0 §1.4 절차 (1). 매니페스트가 적어 둔 sha256·
 *      바이트 수와 대조한다. 이것이 마감 중인 다른 실행과의 경합에 대한 답이기도 하다:
 *      별칭은 create-once rename 으로 발행되므로 우리가 보는 것은 옛 바이트이거나 새 바이트고,
 *      어느 쪽이든 매니페스트가 말하는 것과 다르면 적용하지 않는다.
 *   2. **어느 저장소인가** — 저널 행. 모르면 `apply_project_unknown`.
 *   3. **그 저장소가 지금 쓸 수 있나** — `inspectRepo`. 설치·하한 실패는 기존 Git 코드와 회복을
 *      그대로 나르고, 경로·저장소·HEAD 실패만 `apply_project_unusable` 로 접는다. 그쪽 Git 회복은
 *      `orch_run` 의 `project` 인자를 고치라고 말하기 때문이다 — 이 도구에는 그 인자가 없다.
 *
 * ★ 성공 봉투의 `confidence` 는 계약의 `confidenceByTool.orch_apply` 두 행 그대로다:
 *   적용하고 사후 확인이 통과했으면 `verified`, `check_only` 면 `unverified`. 태스크 7 은 그
 *   둘을 같은 거절에 묶어 두었고(적용기가 없었으므로) `unverified: "check_only"` 는 닿을 수
 *   없는 문장이었다 — 이 커밋에서 닿는다.
 */
async function applyRun({ stateRoot, runId, manifest, patchPath, checkOnly, proof }, wired = {}) {
  let patchBytes = null;
  try {
    patchBytes = await readFile(patchPath);
  } catch {
    return refuse(REASON.apply_patch_unreadable, { runId, params: { path: patchPath } });
  }
  const alias = manifest.winnerAlias;
  // 기록이 「대표 패치 없음」이라고 말하는데 그 자리에 파일이 있으면, 그것은 우리 것이 아니다.
  if (alias === null) return refuse(REASON.apply_patch_missing, { runId, params: { runId } });
  if (patchBytes.length !== alias.bytes || sha256(patchBytes) !== alias.sha256) {
    return refuse(REASON.apply_artifact_mismatch, { runId, params: { path: patchPath } });
  }

  const located = await projectOf(stateRoot, runId);
  if (located?.ok !== true) return carryFailure(located, runId);
  const project = located.project;
  if (project === null) return refuse(REASON.apply_project_unknown, { runId, params: { runId } });
  const repository = await inspectRepo(project);
  const inspectionFailure = routeRepositoryInspection(repository, project);
  if (inspectionFailure?.kind === 'forward') return carryFailure(inspectionFailure.failure, runId);
  if (inspectionFailure?.kind === 'map') {
    return refuse(inspectionFailure.reasonCode, { runId, params: inspectionFailure.params });
  }

  const applyPatch = typeof wired.applyPatchToRepository === 'function'
    ? wired.applyPatchToRepository
    : applyPatchToRepository;
  const outcome = await applyPatch({
    repoPath: project,
    patchPath,
    patchBytes,
    baseline: manifest.baseline,
    scratchRoot: stateRoot,
    checkOnly,
  }, {
    inspectBeforeWrite: (boundary) => inspectApplyScope({ manifest, project, wired, boundary }),
  });
  if (outcome.blocked === true) {
    if (outcome.reasonCode === REASON.apply_scope_refused && outcome.scope !== undefined) {
      const scope = boundedScope(outcome.scope);
      return failure({
        status: 'failed',
        reasonCode: outcome.reasonCode,
        content: JSON.stringify({
          runId, applied: false, checkOnly, mode: outcome.mode, head: outcome.head,
          project: clipPath(project, PATH_CHARS), scope,
        }),
        contentFallback: JSON.stringify({
          runId, applied: false, checkOnly, mode: outcome.mode, head: outcome.head,
          scope: {
            flagged: scope.flagged,
            hardViolation: scope.hardViolation,
            allowlisted: scope.allowlisted,
            reasonCount: scope.reasonCount,
            omittedReasonCount: scope.omittedReasonCount,
          },
          reduced: 'floor',
        }),
        confidence: outcome.scope.confidence,
        runId,
      });
    }
    return typeof outcome.error === 'string' || typeof outcome.recovery === 'string'
      ? carryFailure(outcome, runId)
      : refuse(outcome.reasonCode, { runId, params: outcome.params });
  }

  const files = boundedFiles(outcome.files);
  const scope = boundedScope(outcome.scope);
  const body = {
    runId,
    applied: outcome.applied,
    checkOnly,
    proof,
    mode: outcome.mode,
    staged: outcome.staged,
    verifiedBy: outcome.verifiedBy,
    project: clipPath(project, PATH_CHARS),
    // ★ `inspectRepo` 가 읽은 HEAD 가 아니라 **판정기가 실제로 판단에 쓴** HEAD 다. 둘을 섞으면
    //   봉투가 말하는 기준과 적용이 선 기준이 갈릴 수 있다(그 사이에 HEAD 가 움직인 저장소).
    head: outcome.head,
    baseline: { ...manifest.baseline, available: outcome.baselineAvailable },
    repository: {
      dirty: outcome.dirtyBefore,
      trackedChanges: outcome.dirtyTrackedCount,
      untracked: outcome.untrackedCount,
    },
    patch: { path: clipPath(patchPath, PATH_CHARS), sha256: alias.sha256, bytes: alias.bytes },
    scope,
    files: files.kept,
    omittedCounts: { files: files.omitted + outcome.filesOmitted },
  };
  let notice;
  if (outcome.applied === true) {
    const writeNote = typeof wired.recordRunNote === 'function' ? wired.recordRunNote : recordRunNote;
    const note = `orch_apply applied the representative patch in ${outcome.mode} mode at HEAD ${outcome.head}.`;
    try {
      const recorded = await writeNote(stateRoot, runId, note, { now: wired.now });
      notice = recorded?.ok === true
        ? recorded.notice
        : renderNotice('apply_journal_record_incomplete', {
          reason: errorText(recorded?.error ?? recorded?.reasonCode ?? recorded),
        });
    } catch (error) {
      notice = renderNotice('apply_journal_record_incomplete', { reason: errorText(error) });
    }
  }
  return success({
    content: JSON.stringify(body),
    // 바닥 한 장 — 긴 경로·긴 목록이 상한을 넘겨도 **무엇을 했는가**는 남는다. 이것이 없으면
    // `success()` 가 본문을 `{"truncatedReport:true"}` 로 조용히 갈아치운다.
    contentFallback: JSON.stringify({
      runId, applied: outcome.applied, checkOnly, proof, mode: outcome.mode, staged: outcome.staged,
      verifiedBy: outcome.verifiedBy, head: outcome.head,
      scope: {
        flagged: scope.flagged,
        hardViolation: scope.hardViolation,
        allowlisted: scope.allowlisted,
        reasonCount: scope.reasonCount,
        omittedReasonCount: scope.omittedReasonCount,
      },
      reduced: 'floor',
    }),
    // ★ 값을 여기서 **고르지 않는다**(WS2 §3): `src/confidence.mjs` 가 도구별 표의 정본이고,
    //   `test/guards/confidence-literals.test.mjs` 가 이 자리의 리터럴을 금지한다.
    // ★ 리뷰 확인(Task 7 수정): `overridden` 을 나르지 않으면 `allow_unproven` 이 연 REAL apply가
    //   git apply 성공 + 사후 확인 통과만으로 `verified` 를 낸다 — 증명된 적용과 구별되지 않는다.
    //   `proof.overridden` 이 `proofGate` 가 이미 낸 값이므로 여기서는 나르기만 한다.
    confidence: confidenceOfApply({
      applied: outcome.applied, verified: outcome.verifiedBy !== null, overridden: proof.overridden === true,
    }),
    notice,
    runId,
  });
}

/**
 * `orch_apply` 의 관문 — 순서가 고정이고, 각 단이 **자기 코드**로 거절한다.
 *
 *   1. 이름의 모양       → `apply_run_not_found`(invalid)
 *   2. 상태 루트         → 리더가 낸 `state_root_not_absolute` 를 그대로 나른다
 *   3. 그런 실행이 없다   → `apply_run_not_found`(invalid)
 *   4. 기록을 못 읽는다   → `apply_run_unreadable`
 *   5. 패치가 없다       → `apply_patch_missing`
 *   6. 패치가 파일이 아니다/못 읽는다 → `apply_patch_unreadable`
 *   7. 증명이 없다/이 패치의 것이 아니다 → `apply_proof_missing`(`allow_unproven` 이 연다)
 *      증명이 돌았고 서지 않았다        → `apply_proof_failed`(**아무것도 못 연다**)
 *   8. 적용             → `applyRun`(바이트 대조 · 저장소 확정 · `src/apply-patch.mjs`)
 *
 * ★ 3 과 4 를 가르는 것은 리더다(`readRunManifest`): 디렉터리가 있으면 「있었는데 못 읽는다」이고
 *   (`status_run_unreadable`), 아무것도 없으면 「없다」다(`status_run_not_found`). 같은 사실을 이
 *   도구의 어휘로 다시 말한다 — 「고치려면 무엇을 바꿔야 하나」가 다르기 때문이다(다른 이름을
 *   대는 것 대 상태 루트를 고치는 것).
 * ★ 5 와 6 도 가른다. 「없다」는 리퍼가 이미 가져갔거나(패치 보존 30일) 애초에 대표 패치가 없는
 *   종료(`tie`·`none`)이고, 「못 읽는다」는 그 경로에 우리 것이 아닌 무엇이 있다는 뜻이다.
 *   둘을 한 코드로 뭉개면 회복 문구가 둘 중 하나에게는 거짓말이 된다.
 */
export async function runOrchApply(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();
  const runId = value.run_id;

  // 1. 경로가 되기 전에 이름을 본다 — 리더와 **같은 술어**를 쓴다(사본이 생기면 문턱이 갈린다).
  if (!usableRunId(runId)) return refuse(REASON.apply_run_not_found, { params: { runId: runIdText(runId) } });

  const read = await readRunManifest({ stateRoot, runId });
  if (read.blocked === true) {
    // 2. 상태 루트 자체가 못 쓰는 값이면 그것은 이 실행에 대한 답이 아니다 — 리더의 코드 그대로.
    if (read.reasonCode === REASON.state_root_not_absolute) {
      return failure({ status: statusOfReasonCode(read.reasonCode), reasonCode: read.reasonCode, error: read.error, recovery: read.recovery });
    }
    // 3·4.
    return read.reasonCode === REASON.status_run_not_found
      ? refuse(REASON.apply_run_not_found, { runId, params: { runId } })
      : refuse(REASON.apply_run_unreadable, { runId });
  }

  const patchPath = winnerPatchPath(stateRoot, runId);
  let entry = null;
  try {
    entry = await stat(patchPath);
  } catch (error) {
    // 5·6. ENOENT 만 「없다」다. 나머지(권한·이름 길이·장치 오류)는 「못 읽는다」이고, 그 둘은
    //      호출자가 할 일이 다르다.
    return error?.code === 'ENOENT'
      ? refuse(REASON.apply_patch_missing, { runId, params: { runId } })
      : refuse(REASON.apply_patch_unreadable, { runId, params: { path: patchPath } });
  }
  // 그 경로에 **파일이 아닌 것**이 있으면 패치가 아니다. 이것을 「없다」로 접으면 회복 문구가
  // "그 실행은 대표 패치를 안 남겼다" 고 말하는데, 실제로는 그 자리를 무엇이 차지하고 있다.
  if (!entry.isFile()) return refuse(REASON.apply_patch_unreadable, { runId, params: { path: patchPath } });

  // 7. 증명. `check_only` 도 같은 문을 지난다 — 「무엇을 했을 것인가」의 답에는 「그때 이 증명을
  //    믿었을 것인가」가 들어 있고, 미리보기만 통과시키면 사용자는 다음 호출이 될 줄 안다.
  const gate = await proofGate({
    stateRoot, runId, manifest: read.manifest, allowUnproven: value.allow_unproven === true,
  }, wired);
  if (gate.ok !== true) return refuse(gate.reasonCode, { runId, params: gate.params });

  return applyRun({
    stateRoot,
    runId,
    manifest: read.manifest,
    patchPath,
    checkOnly: value.check_only === true,
    proof: gate.proof,
  }, wired);
}
