/**
 * 밖으로 나가는 문구의 유일한 정본 — reason code 하나에 영어 `message` 하나와 `recovery` 하나.
 *
 * WS2(§7.2 · §0 결정표 「봉투 밖 문구의 정본 위치」)가 만들었다. 이전에는 171 곳의 `blocked()` 가
 * 두 방언(코드 69 · 한국어 문장 102)으로 `error` 를 만들고, 26 곳의 `artifactBlocked()` 는 raw code 를
 * 그대로 `error` 로 냈다. 같은 결함이 부르는 자리마다 다른 문장으로 나갔고, 어떤 자리는 문장이
 * 아니라 식별자를 냈다. 여기서는 **코드가 문구를 정한다** — 생산자는 `fail(REASON.x, params)` 를
 * 부르고 문장을 쓰지 않는다.
 *
 * ★ 두 층이다. `src/reason-codes.mjs` 는 **어휘**(코드·주체·stopReason·뜻)를 알고, 이 파일은
 *   **문구**(사용자가 읽는 영어 한 문장 + 다음에 할 한 문장)를 안다. 어휘 없이 문구를 만들 수 없고
 *   (`reasonCodeEntry` 가 없으면 throw), 문구 없이 코드를 등재해도 게이트가 잡는다
 *   (`test/reason-text.test.mjs` 의 양방향 단언 — 184 코드 ↔ 184 문구).
 *
 * ★ 문체 규칙(테스트가 잰다):
 *   - `message` 는 **무엇이 실패했는가**를 능동태 한 문장으로. 내부 식별자·상수 이름을 산문으로
 *     내보내지 않는다(`MAX_JSON_ARTIFACT_BYTES` 가 아니라 `{limit}`). 마침표로 끝내지 않는다 —
 *     한 자리에서만 붙는 마침표는 봉투 바이트를 조용히 갈라 놓는다.
 *   - `recovery` 는 **사용자가 다음에 할 한 문장**(명령형). 엔진 내부 불변식이라 사용자가 할 수 있는
 *     것이 재시도뿐이면 그렇게 솔직히 적는다(`RECOVERY_RETRY_REPORT`) — 고칠 수 없는 것을
 *     고치라고 적는 회복 문구는 아무 회복도 아니다.
 *   - 미국 철자로 적는다("Stabilize", "labeled") — 한 문구가 두 철자로 갈리면 골든이 두 줄이 된다.
 *   - 호출자가 넘길 수 없는 것을 넘기라고 적지 않는다: `orch_run` 에는 `runId` 인자가 없고
 *     (서버가 만든다) argv 빌더의 필드(`allowedTools`·`permissionMode`·`role`·`model`·`effort`)도
 *     도구 인자가 아니다. 그 자리의 회복은 "새 실행을 시작하라" 또는 "재시도하고 신고하라" 다.
 *   - 단위는 **템플릿**에 적고 값은 맨 숫자로 받되(`limit of {limit} bytes`) 수는 상한 이름 **뒤**다
 *     (Task 19): 값이 섞이면 "4 MiB"·"4194304" 로 갈리고, 앞에 두면 상한의 이름이 4194304 로 읽힌다.
 *   - 한글 0(언어 게이트, §7.3). `undefined`·`null`·`[object Object]` 는 결과에 절대 없다.
 *
 * ★ 자리표시자는 `{name}` 이고 `renderReason`/`renderNotice` 가 채운다. **빠진 인자는 throw** 다 —
 *   개발자 오류이고, 봉투에 `{path}` 나 `undefined` 가 실려 나가는 것보다 테스트에서 터지는 것이 낫다.
 *   `undefined` 를 넘긴 것은 "안 넘긴 것" 과 같게 취급한다(값이 없다는 사실을 문장으로 감추지 않는다).
 *
 * ★ 값은 `String(v)` → `setRedactor` 로 꽂은 세척기 → `MAX_PARAM_CHARS` clip 순서로 지난다.
 *   세척이 clip 보다 **먼저**인 이유: 뒤에 자르면 비밀 하나가 200 자 경계에서 갈려 앞 절반이
 *   세척되지 않은 채 살아남는다 — 여섯 글자만 남은 토큰도 남은 것은 비밀의 조각이다. Task 4 의
 *   `redactText` 는 값을 짧게 만드는 치환이라, 세척 뒤에 재면 clip 이 먹는 정보도 줄어든다.
 *   clip 은 **코드 포인트** 단위다 — 코드 유닛으로 자르면 astral 글자가 반쪽 서로게이트로 남고
 *   그 바이트는 봉투를 읽는 쪽에서 깨진 글자가 된다.
 *   기본값은 항등 함수다 — Task 4 가 실제 세척기를 꽂기 전까지는 아무것도 지우지 않는다.
 *
 * ★ 스냅샷: `contract/golden-failures.json`(코드마다 봉투 한 건, 불변식 8)과
 *   `distribution/REASON_CODES.md`(사용자 문서 표)는 이 파일에서 **생성**된다
 *   (`scripts/lib/contract-snapshot.mjs`). 손으로 고치지 않는다.
 */
import { reasonCodeEntry, stopReasonOf } from './reason-codes.mjs';
import { deepFreeze } from './util/freeze.mjs';
import { OPAQUE_OBJECT_TEXT, endsWithLoneSurrogate } from './util/strings.mjs';

/** 인자 값 하나의 최대 글자 수. 넘으면 잘리고 `CLIP_SUFFIX` 가 붙는다. */
export const MAX_PARAM_CHARS = 200;

/** 잘렸다는 표시. 한 글자라 상한 안쪽 정보를 더 뺏지 않는다. */
const CLIP_SUFFIX = '…';

/** `{name}` — 이름은 영문자만. 숫자·`_` 를 허용하면 문장 속 `{1}`·`{a_b}` 가 자리표시자로 오독된다. */
const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/**
 * 발췌·인자 세척 훅. 기본값은 항등이다.
 *
 * WS2 Task 4 가 `redactText` 를 여기에 꽂는다. 훅으로 두는 이유는 순환 import 를 피하려는 것이
 * 아니라, 세척기가 **상태 루트·프로젝트 경로·홈**을 알아야 하기 때문이다 — 그 세 값은 실행마다
 * 다르고 이 모듈은 실행을 모른다.
 */
const IDENTITY = (value) => value;
let redactor = IDENTITY;

/** 세척기를 꽂는다. `null`/`undefined` 는 항등으로 되돌린다(테스트가 원상복구에 쓴다). */
export function setRedactor(fn) {
  if (fn === null || fn === undefined) {
    redactor = IDENTITY;
    return;
  }
  if (typeof fn !== 'function') throw new TypeError('redactor must be a function');
  redactor = fn;
}

/**
 * 지금 꽂혀 있는 세척기, 없으면 `null`(항등은 "없다" 로 답한다). 훅이 모듈 전역이라 실행 둘이
 * 겹치면 한 자리를 두고 다툰다 — 나중에 꽂은 쪽이 이기고, 먼저 끝난 쪽은 **지금 걸린 것이 아직
 * 자기 것일 때만** 반납한다(engine 의 `closeLog`). 조건 없이 반납하면 아직 도는 실행이 세척을 잃는다.
 */
export function getRedactor() {
  return redactor === IDENTITY ? null : redactor;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공용 recovery — 같은 조언이 여러 코드에 걸린다. 문장을 한 곳에 두면 "재시도하세요" 가
// 스무 가지 바이트로 갈라지지 않는다. 앞의 셋은 `src/util/errors.mjs` 의 한국어 세 사본
// (`GENERIC_RECOVERY`·`INSTALL_RECOVERY`·`ARTIFACT_RECOVERY`)의 영어판이고, Task 9 가 그
// 모듈을 여기서 re-export 하도록 바꾼다.
// ─────────────────────────────────────────────────────────────────────────────

/** 일반 실패. `util/errors.mjs GENERIC_RECOVERY` 의 영어판. */
export const RECOVERY_GENERIC = 'Check the run log or retry the run';

/** 벤더 CLI 를 찾지 못한 실패. `util/errors.mjs INSTALL_RECOVERY` 의 영어판. */
export const RECOVERY_INSTALL = 'Check the installation and PATH, then retry the run';

/**
 * 실행 artifact 저장소. `util/errors.mjs ARTIFACT_RECOVERY` 를 대체한다 — 원문은 "Use a fresh runId"
 * 였지만 `orch_run` 에는 `runId` 인자가 없다(서버가 만든다). 없는 인자를 넘기라는 문장은 회복이
 * 아니므로, 사용자가 실제로 할 수 있는 것(새 실행 · 상태 루트 확인 · 신고)만 적는다.
 */
export const RECOVERY_ARTIFACT = 'Start a new run; if it recurs, check that the state root is intact and report the reasonCode';

/** 엔진 내부 불변식 — 사용자가 할 수 있는 것은 재시도와 신고뿐이다. 그렇게 적는다. */
const RECOVERY_RETRY_REPORT = 'Retry the run; if it recurs, report the reasonCode and the run log';

/** 상태 루트 쓰기·디스크 여유. `worktree.mjs` 의 네 사본이 쓰던 조언. */
const RECOVERY_STATE_ROOT = 'Check that the state root is writable and the disk has free space, then retry';

/** 데드라인. `engine.mjs` 의 네 사본이 쓰던 조언. */
const RECOVERY_WAIT_MS = 'Raise wait_ms and retry the run';

/**
 * 이 실행이 쌓은 상태를 믿을 수 없다. `engine.mjs` 두 사본은 "fresh runId" 라고 적었지만 `runId` 는
 * 호출자가 고를 수 있는 값이 아니다 — 새 실행이 새 이름공간을 받는다.
 */
const RECOVERY_NEW_RUN = 'Start a new run; the state this run built can no longer be trusted';

/** 벤더가 남긴 것을 읽는다. 모델 산문이 아니라 라벨된 stderr 발췌를 읽으라는 뜻이다. */
const RECOVERY_VENDOR_LOG = 'Read the labeled vendor stderr excerpt in the result, then retry the run';

/** 검증이 성립하지 않은 후보 — 사람이 직접 읽는 것이 유일한 회복이다. */
const RECOVERY_READ_DIFF = 'Read the candidate diff yourself before applying it, or retry the run';

/** 테스트가 실패했다. 무엇이 실패했는지는 본문에 있다. */
const RECOVERY_READ_TESTS = 'Read the failing tests in the result, then retry with a narrower task';

/** 후보별 사유가 본문에 있다. */
const RECOVERY_CANDIDATE_REASONS = 'Read the per-candidate reasons in the result, fix what they name, then retry';

/** 델리게이트가 낸 패치 자체를 믿을 수 없다. */
const RECOVERY_RETRY_PATCH = 'Retry the run; the patch this attempt produced cannot be trusted';

/** 대상 저장소의 git 상태. */
const RECOVERY_GIT_REPO = 'Check that the target path is a healthy git repository, then retry';

/** 벤더 CLI 설치. 벤더 이름을 문장에 넣는다 — 어느 CLI 인지가 회복의 절반이다. */
const RECOVERY_INSTALL_VENDOR = 'Install the {vendor} CLI and check that PATH reaches it, then retry';

/** 심판 답이 쓸 수 없었다. */
const RECOVERY_RETRY_JUDGE = 'Retry the run; if the judge keeps answering unusably, report the reasonCode and the run log';

/** 예산이 모자랐다. */
const RECOVERY_MORE_BUDGET = 'Raise the step budget and retry the run';

/**
 * 물어본 실행을 못 찾았거나 못 읽었다. **이름을 고치라고 하지 않는다** — 실행 이름은 서버가
 * 짓고(`makeRunId`) `orch_run` 에는 그 인자가 없으므로, 호출자가 할 수 있는 유일한 일은 목록을
 * 받아 거기 있는 이름을 쓰는 것이다. `orch_reward` 가 `learning_run_not_found` 에서 쓴 것과 같은
 * 모양이고, 레지스트리 전역 가드가 회복 문구의 `runId`·`run id` 를 금하는 이유도 같다.
 */
const RECOVERY_STATUS_LIST = 'Call orch_status with no arguments to list the recent runs';

/**
 * 재개가 성립하지 않았다. 사용자가 할 수 있는 것은 **그 인자 없이 부르는 것** 하나다 — 봉인
 * attempt 는 정확한 정체성(baseline + 환경 지문)에서만 재사용되고, 그 정체성은 사용자가 인자로
 * 바꿀 수 있는 값이 아니다. `resume_run_id` 를 이름으로 적는 것은 그것이 진짜 도구 인자이기
 * 때문이다(금지되는 것은 서버가 짓는 `runId`·`run id` 다).
 */
const RECOVERY_RESUME_FRESH = 'Call orch_run again without resume_run_id to start a fresh run';

/** 한 항목. 프리즈는 아래 `deepFreeze(REASON_TEXT)` 가 한 번에 한다. */
function text(message, recovery) {
  return { message, recovery };
}

/**
 * 코드마다 영어 문구 하나. 키 순서는 `REASON_CODES` 와 같은 사전순 — 표를 눈으로 대조할 수 있게.
 *
 * ★ `message` 의 재료는 레지스트리의 `meaning`(이미 영어)이고, 인자는 옛 한국어 리터럴이 담고
 *   있던 구체값이다(리서치 `strings.json translationWorklist` 의 error/recovery 542). 뜻을 옮길 때
 *   내부 함수 이름·상수 이름은 산문에서 빼고 그 자리에 `{limit}`·`{path}` 를 놓았다 —
 *   `writeAttemptArtifact` 는 호출자에게 아무 말도 하지 않는다.
 */
export const REASON_TEXT = deepFreeze({
  // apply — `orch_apply` 가 사용자 저장소를 건드리기 **전에** 멈추는 자리들(WS5 태스크 7).
  // 회복 문구가 전부 「다른 이름을 대라」·「직접 적용하라」로 끝나는 것은 이 도구의 실패가
  // 재시도로 낫는 종류가 아니기 때문이다 — 없는 실행은 다시 불러도 없다.
  // ★ 이 문구가 짧은 것은 취향이 아니라 상한이다. `test/reason-text.test.mjs` 의 clip 테스트는
  //   `{path}` **하나만** 쓰는 첫 코드를 골라 「200자 인자 + 템플릿 < 300」을 재므로, 알파벳 순서에서
  //   고정 대표인 이 문장이 곧 그 예산이다(템플릿 77자 — `{path}` 하나라는 전제도 그 테스트가 잰다). 긴 설명은 `src/reason-codes.mjs` 의
  //   `meaning` 이 나른다 — 그쪽은 상한이 없고 이쪽은 봉투 바이트다.
  apply_applied_unverified: text(
    'Git reported a completed three-way write in {path}, but the post-apply check could not run; mapped paths may match their pre-write snapshots or may have changed again, and the index is unproven: {detail}',
    'Inspect git status, git diff, and git diff --cached in that repository, then review the working tree and index; do not assume the patch is currently applied or staged',
  ),
  apply_artifact_mismatch: text(
    'The bytes at {path} do not hash to the digest this run recorded for its patch',
    'Start a new run rather than applying bytes the run cannot vouch for',
  ),
  apply_baseline_moved: text(
    'The patch does not apply to {path} as it stands; either the temporary baseline merge reached no clean result or the real three-way write failed without a measured patch-path or porcelain change',
    'Inspect git status --untracked-files=all for an untracked file occupying a path this patch creates; move or preserve it if present, otherwise start a new run against the repository as it is now',
  ),
  apply_baseline_pruned: text(
    'Patch preimage material needed for a three-way merge is no longer available in {path}; that may be a referenced blob or the baseline index entry a pure mode-only change needs, and git can discard unreachable objects before this server\'s retained patch expires',
    'Start a new run against the repository as it is now, or apply the patch by hand with git apply and resolve the differences yourself',
  ),
  apply_git_failed: text(
    'A required Git-related preparation or operation could not complete: {detail}',
    'Fix the reported Git or filesystem problem, then call orch_apply again',
  ),
  apply_head_moved: text(
    'The target repository HEAD changed after the pre-write checks, so this call did not apply the patch to {path}',
    'Review the new HEAD and its committed .bom-orch.json, then call orch_apply again only if that policy still approves the patch',
  ),
  apply_patch_empty: text(
    'The patch this run left is empty, so there is nothing to apply and {path} was not touched',
    'Call orch_status with this run_id: an empty patch means the delegate changed no file',
  ),
  apply_patch_missing: text(
    'Run {runId} has no patch to apply on this state root: it left no representative patch, or the cleanup has already reclaimed it',
    'Call orch_status with this run_id to see which candidate patches are still on disk',
  ),
  apply_patch_unreadable: text(
    'Something is at {path} but it is not a readable patch file',
    'Look at what occupies that path, then start a new run rather than applying whatever is there',
  ),
  apply_run_not_found: text('No run named {runId} is on this state root, so there is nothing to apply', RECOVERY_STATUS_LIST),
  apply_project_unknown: text(
    'The records of run {runId} do not name the repository it was started in, so there is no repository to apply its patch to',
    'Locate the repository that run was started in from your own records, then apply the retained representative patch there with git apply; orch_apply cannot infer the target',
  ),
  apply_project_unusable: text(
    'The repository this run was started in, {path}, is missing, is not a git repository, or has no commit to apply against',
    'Restore that repository, or apply the patch yourself with git apply where you want the changes',
  ),
  apply_rollback_incomplete: text(
    'The apply into {path} stopped after writing and {count} patch paths now differ from the pre-write snapshot or could not be inspected safely; the current tree was left untouched and the mapped backup is kept at {backup}: {detail}',
    'Copy backup/manifest.json and any bytes you need out of {backup} before anything else, then inspect git status and repair the repository by hand; nothing on this server reclaims that directory',
  ),
  apply_run_unreadable: text(
    'The records of that run could not be read, so its patch cannot be checked against the run it came from',
    RECOVERY_STATUS_LIST,
  ),
  apply_scope_refused: text(
    'The patch has scope-policy findings that are not approved by scope.allow at the target repository\'s current HEAD, so nothing was applied',
    'Review scope.reasons; if every finding is intended and waivable, commit matching scope.allow entries and retry, otherwise start a new run or apply the patch manually',
  ),
  apply_three_way_conflicted: text(
    'Merging this patch into {path} ends in conflicts; that was measured in a temporary index, so nothing was written to your files',
    'Apply the patch by hand with git apply --3way and resolve the conflicts, or start a new run against the repository as it is now',
  ),
  apply_verification_failed: text(
    'The final post-write check for {path} disagreed or could not run, so the working tree or index cannot be vouched for: {detail}',
    'Before changing anything else, inspect git status, git diff, and git diff --cached in that repository; preserve any work you need, then repair the reported working-tree or index state by hand',
  ),
  apply_worktree_dirty: text(
    'This patch needs a three-way merge, but {count} tracked changes in {path} either touch a patch path that does not match the index or are already staged; Git refuses the former, and the latter prevents orch_apply from predicting and verifying the result against a HEAD-seeded index',
    'Commit or stash those changes, then call orch_apply again',
  ),
  apply_write_blocked: text(
    'git could not safely finish this patch in {path}: an unsafe path shape blocked the write, or a failed direct write left no measured patch-path or porcelain change',
    'Inspect git status and the paths this patch names, clear any obstruction, then call orch_apply again or start a new run against the repository as it is now',
  ),
  // artifact — 실행 artifact 저장소. 대부분 infrastructure_failed 이고, 사용자가 고칠 수 있는 것은
  // 상태 루트(권한·공간·경로)와 runId 뿐이다. 나머지는 재시도와 신고로 솔직하게 끝낸다.
  artifact_allocation_checkpoint_failed: text('The run manifest could not durably record the attempt allocation, so the attempt never started', RECOVERY_ARTIFACT),
  artifact_attempt_input_invalid: text('The attempt record was requested with input that failed validation or named an unknown attempt', RECOVERY_RETRY_REPORT),
  artifact_attempt_record_invalid: text('The attempt record failed normalization, so it was never written', RECOVERY_RETRY_REPORT),
  artifact_attempt_too_large: text('The attempt record exceeded the artifact size limit of {limit} bytes', 'Retry with a narrower task so the attempt record stays under {limit} bytes'),
  artifact_attempt_write_failed: text('The immutable attempt record could not be written or failed its byte verification', RECOVERY_ARTIFACT),
  artifact_base_directory_not_private: text('The artifact base directory {path} is not owner-only', 'Restrict that directory to its owner, then retry the run'),
  artifact_candidate_checkpoint_failed: text('A candidate checkpoint could not be recorded in the run manifest', RECOVERY_ARTIFACT),
  artifact_candidate_input_invalid: text('The candidate patch was requested with input that failed validation', RECOVERY_RETRY_REPORT),
  artifact_candidate_patch_mismatch: text('The candidate patch bytes did not match the digest sealed for that attempt', RECOVERY_NEW_RUN),
  artifact_candidate_path_mismatch: text('A candidate lane wrote its patch somewhere other than the path the frozen budget reserved', RECOVERY_RETRY_REPORT),
  artifact_candidate_write_failed: text('The candidate patch could not be stored or failed its reference check', RECOVERY_ARTIFACT),
  artifact_collision_input_invalid: text('The namespace collision probe was called with a malformed input object', RECOVERY_RETRY_REPORT),
  artifact_collision_inspection_failed: text('The namespace collision probe could not read the artifact root {path}', 'Check that the artifact root exists and is readable by this user, then retry'),
  artifact_create_once_publish_failed: text('Publishing the artifact from its temporary file to its final path failed', RECOVERY_ARTIFACT),
  artifact_destination_exists_or_publish_failed: text('The final artifact path was already taken, or publishing to it failed', RECOVERY_NEW_RUN),
  artifact_directory_sync_failed: text('The artifact directory could not be flushed to disk, so the write cannot be proven durable', RECOVERY_STATE_ROOT),
  artifact_evidence_input_invalid: text('The evidence record was requested with input that failed validation', RECOVERY_RETRY_REPORT),
  artifact_evidence_record_invalid: text('The evidence record failed normalization, so it was never written', RECOVERY_RETRY_REPORT),
  artifact_final_inspection_failed: text('The published artifact could not be inspected afterwards, so the write stays unproven', RECOVERY_ARTIFACT),
  artifact_identity_invalid: text('The artifact path could not be derived from the frozen run identity', RECOVERY_RETRY_REPORT),
  artifact_init_lock_collision: text('Another initializer already owns the artifact namespace for run {runId}', 'Wait for the other run to finish, then start a new run'),
  artifact_initial_manifest_invalid: text('The initial run manifest did not normalize, so the run namespace was never created', RECOVERY_RETRY_REPORT),
  artifact_initial_manifest_too_large: text('The initial run manifest exceeded the manifest size limit of {limit} bytes', 'Retry with a narrower task so the manifest stays under {limit} bytes'),
  artifact_initialization_dependency_failed: text('A filesystem dependency the artifact store needs was missing or refused', RECOVERY_STATE_ROOT),
  artifact_initialization_failed: text('The artifact store failed to initialize and left no evidence of a crash', RECOVERY_ARTIFACT),
  artifact_initialization_interrupted: text('Artifact store initialization crashed midway and left partial state behind', RECOVERY_ARTIFACT),
  artifact_inspection_input_invalid: text('The artifact reference inspection was called with a malformed input object', RECOVERY_RETRY_REPORT),
  artifact_manifest_authority_mismatch: text('The run manifest on disk did not match the authority frozen for this run', RECOVERY_NEW_RUN),
  artifact_manifest_checkpoint_failed: text('A run manifest checkpoint failed, so the artifact store lost its authority', RECOVERY_ARTIFACT),
  artifact_manifest_event_invalid: text('A run manifest checkpoint event failed validation', RECOVERY_RETRY_REPORT),
  artifact_manifest_event_path_invalid: text('A run manifest event named the path {path}, which is outside this run namespace', RECOVERY_RETRY_REPORT),
  artifact_manifest_event_payload_mismatch: text('A replayed manifest event arrived with a different payload than the one already applied', RECOVERY_NEW_RUN),
  artifact_manifest_replace_failed: text('The run manifest file could not be replaced atomically', RECOVERY_STATE_ROOT),
  artifact_manifest_transition_invalid: text('A manifest event would move the run into a state the manifest forbids', RECOVERY_RETRY_REPORT),
  artifact_namespace_collision: text('An artifact namespace already exists for run {runId}, and existing bytes are never adopted', 'Start a new run; the existing bytes were left untouched'),
  artifact_partial_write_requires_recovery: text('A partial artifact file is still on disk, so the write cannot be retried until recovery runs', RECOVERY_ARTIFACT),
  artifact_patch_write_failed: text('The candidate patch bytes could not be collected, or they did not match the delta they must match', RECOVERY_NEW_RUN),
  artifact_path_budget_exceeded: text('The artifact paths for this run would exceed the {limit} character path budget, so the run was refused before any credit was spent', 'Move BOM_ORCH_HOME to a shorter absolute path, then retry'),
  artifact_paths_invalid: text('The artifact path budget was checked with a non-canonical state root, an invalid run identity, or an unsupported candidate count', 'Set BOM_ORCH_HOME to an existing absolute path and ask for one or two candidates'),
  artifact_pending_final_mismatch: text('The published artifact did not match the immutable reference recorded for it', RECOVERY_NEW_RUN),
  artifact_pending_replay_mismatch: text('A pending artifact reservation named a different path than the write that replayed it', RECOVERY_NEW_RUN),
  artifact_permission_verification_failed: text('The artifact path {path} could not be proven owner-only', 'Check the owner and the permission bits under the artifact root, then retry'),
  artifact_plan_record_invalid: text('The plan this run made could not be recorded, so the run kept no readable copy of it', 'The run itself is unaffected; report this if orch_status keeps showing no plan for finished runs'),
  artifact_replay_mismatch: text('A replayed write found bytes on disk that do not match what the run manifest recorded', RECOVERY_NEW_RUN),
  artifact_reservation_lost: text('The pending write reservation disappeared from the run manifest mid-write', RECOVERY_ARTIFACT),
  artifact_root_not_canonical: text('The artifact root {path} could not be resolved to a canonical directory', 'Create BOM_ORCH_HOME as a real absolute directory with no symlink loop, then retry'),
  artifact_root_overlaps_project: text('The artifact root lives inside the target repository, which would make artifacts part of the diff', 'Move BOM_ORCH_HOME to a path outside the target repository, then retry'),
  artifact_selection_checkpoint_failed: text('A usage or selection checkpoint could not be recorded in the run manifest', RECOVERY_ARTIFACT),
  artifact_store_authority_lost: text('A manifest checkpoint settled in an unknown state, so the artifact store can no longer be trusted', RECOVERY_ARTIFACT),
  artifact_store_handle_invalid: text('The artifact store handle passed in was not one this server created', RECOVERY_RETRY_REPORT),
  artifact_store_initialization_failed: text('The artifact store refused to initialize and reported no reason of its own', RECOVERY_ARTIFACT),
  artifact_store_input_invalid: text('The artifact store was created with a malformed input object', RECOVERY_RETRY_REPORT),
  artifact_store_invalid: text('The artifact store failed its shape or authority check right after it was created', RECOVERY_RETRY_REPORT),
  artifact_store_poisoned: text('An earlier fault poisoned the artifact store, so every later write is refused', RECOVERY_NEW_RUN),
  artifact_temp_inspection_failed: text('The temporary artifact file could not be inspected', RECOVERY_STATE_ROOT),
  artifact_temp_mismatch: text('The temporary artifact path is not the regular file this server created', RECOVERY_ARTIFACT),
  artifact_temp_name_failed: text('A unique temporary artifact name could not be produced', RECOVERY_STATE_ROOT),
  artifact_temp_write_failed: text('Writing the temporary artifact file failed', RECOVERY_STATE_ROOT),
  artifact_unowned_final_collision: text('A file this server does not own already occupies the artifact path {path}', 'Move or remove that file, then start a new run'),
  artifact_winner_alias_failed: text('The winner was selected but its patch alias could not be written, so no representative patch path exists', RECOVERY_ARTIFACT),
  artifact_winner_alias_not_selected: text('A winner alias was requested for a run whose selection names no candidate', RECOVERY_RETRY_REPORT),
  artifact_winner_candidate_mismatch: text('The candidate patch on disk no longer matches the reference the run manifest recorded', RECOVERY_NEW_RUN),
  artifact_winner_candidate_unavailable: text('The selected candidate has no stored patch to point the winner alias at', RECOVERY_NEW_RUN),
  artifact_write_failed: text('A guarded artifact write was refused for a reason this server does not classify yet', RECOVERY_ARTIFACT),
  artifact_write_interrupted: text('The artifact write was cut short, so its effect on disk is unknown', RECOVERY_ARTIFACT),

  // auth · config — 로그인은 사용자가 하는 일이다. 나머지 일곱은 **엔진이 argv 를 만들다 낸 실패**이고
  // 그 필드(`allowedTools`·`permissionMode`·`role`·`model`·`effort`·`cwd`)는 도구 인자가 아니다 —
  // 호출자가 넘길 수 없는 것을 고치라고 적으면 회복 문구가 거짓말이 된다(D4b).
  auth_login_required: text('The {vendor} CLI is installed but not logged in for this run', 'Log in to the {vendor} CLI, then retry the run'),
  config_allowed_tools_missing: text('A write role was built with no allowed-tools list, so the call was refused', RECOVERY_RETRY_REPORT),
  config_argument_above_maximum: text('The argument {name} was {value}, above the largest value this tool accepts ({max})', 'Pass {max} or less for {name}, then call the tool again'),
  config_argument_below_minimum: text('The argument {name} was {value}, below the smallest value this tool accepts ({min})', 'Pass {min} or more for {name}, then call the tool again'),
  config_argument_item_type_invalid: text('Item {index} of the argument {name} is not {expected}', 'Make every item of {name} {expected}, then call the tool again'),
  config_argument_misspelled: text('{name} is not an argument this tool accepts; the closest one is {suggestion}', 'Call the tool again with {suggestion}, or with only these arguments: {allowed}'),
  config_argument_not_finite: text('The argument {name} was {value}, which is not a finite number', 'Pass a finite number for {name}, then call the tool again'),
  config_argument_not_in_enum: text('The argument {name} was {value}, which is not one of the values this tool accepts', 'Pass one of these for {name}: {allowed}'),
  config_argument_not_integer: text('The argument {name} was {value}, and this tool takes a whole number there', 'Pass a whole number for {name}, then call the tool again'),
  config_argument_required_missing: text('The argument {name} is required and was not given', 'Call the tool again and include {name}'),
  config_argument_type_invalid: text('The argument {name} must be {expected}', 'Pass {expected} for {name}, then call the tool again'),
  config_argument_unknown: text('{name} is not an argument this tool accepts', 'Call the tool again with only these arguments: {allowed}'),
  config_argument_unsafe: text('A model, effort or working-directory value looked like a command-line flag', RECOVERY_RETRY_REPORT),
  config_arguments_invalid: text('The call arguments were not a plain JSON object whose properties are plain values', 'Call again with a plain JSON object'),
  config_arguments_not_accepted: text('{name} was given, but this tool takes no arguments', 'Call the tool again with no arguments'),
  config_budget_invalid: text('The step budget {budget} is outside the range of 1 to {limit} steps', 'Ask for a whole number of steps between 1 and {limit}'),
  config_candidate_count_invalid: text('The candidate count {count} is neither one nor two', 'Ask for one or two candidates'),
  config_change_scope_missing: text('A model or effort was given without the vendor and tier they belong to', 'Pass vendor and tier as well; the vendors are {vendors} and the tiers are {tiers}'),
  config_change_target_missing: text('A vendor and tier were given with no model and no effort, so there is nothing to change', 'Pass model or effort together with them, or call the tool with no arguments to read the current settings'),
  config_effort_unsupported: text('The model {model} does not offer the effort {effort}', 'Choose one of the efforts {model} offers ({efforts}), or leave effort empty to use the CLI default'),
  config_flag_banned: text('The built command line carried a flag this server refuses to pass', RECOVERY_RETRY_REPORT),
  // ★ 셋 다 **크레딧을 쓰기 전에** 끝나는 거부다(WS0 §5). 문장의 주어는 사용자 파일이고,
  //   회복은 그 파일에 대해 사용자가 실제로 할 수 있는 한 가지를 적는다. `config_invalid` 의
  //   `{detail}` 은 스키마 해석기가 만든 첫 위반 한 문장이다 — 어느 키가 왜 걸렸는지가
  //   없으면 "스키마를 보라" 는 조언은 사용자에게 파일 전체를 다시 읽으라는 말이 된다.
  config_invalid: text('The project configuration file {file} could not be validated: {detail}', 'Fix {file} so it matches the project configuration schema, commit it, then retry the run'),
  config_isolation_unsupported: text('The isolation mode {isolation} is not one this server implements', 'Leave the isolation argument unset; the disposable worktree is the only mode'),
  config_permission_mode_invalid: text('The permission mode this server builds for the delegate call was missing or empty', RECOVERY_RETRY_REPORT),
  config_project_path_invalid: text('The project path {path} is not an absolute path', 'Pass the absolute path of the target git repository'),
  config_provider_unknown: text('The {role} role was pinned to {vendor}, which is not a vendor this server registers', 'Use one of these vendors instead: {vendors}'),
  config_role_override_conflict: text('Two candidates run a fixed mirrored placement, so a global worker or verifier pin cannot be honored', 'Drop the worker and verifier pins, or ask for one candidate'),
  config_role_unknown: text('The delegate role {role} is not one this server can build a command line for', RECOVERY_RETRY_REPORT),
  config_schema_newer: text('The project configuration file {file} declares schemaVersion {version}, and this server implements schemaVersion {supported}', 'Update this plugin to a version that reads schemaVersion {version}, or set {file} back to schemaVersion {supported}, then retry the run'),
  config_settings_effort_unsupported: text('The {vendor} {tier} model {model} does not offer the effort {effort}', 'Choose one of the efforts {model} offers ({efforts}), or leave effort empty to use the CLI default'),
  config_settings_key_unknown: text('{key} is not a key the settings section for {vendor} defines', 'Use one of these keys instead: {keys}'),
  config_settings_lock_unavailable: text('The settings lock could not be taken: {detail}', 'Another process may be writing the settings; retry in a moment, the settings file was not changed'),
  config_settings_patch_empty: text('The settings change carried no value to write', 'Call orch_config with no arguments to see the vendors, tiers and models you can set'),
  config_settings_patch_invalid: text('The settings change was not an object', 'Call orch_config with no arguments to see the vendors, tiers and models you can set'),
  config_settings_read_failed: text('The existing settings file could not be read: {detail}', 'Check the file permissions and contents, then retry; the existing settings file was left unchanged'),
  config_settings_section_invalid: text('The settings given for the vendor {vendor} were not an object', 'Call orch_config with no arguments to see the vendors, tiers and models you can set'),
  config_settings_value_not_string: text('The {key} value for the vendor {vendor} was not text', 'Pass text for {key}, or an empty string to clear it'),
  config_settings_value_unsafe: text('The {key} value for the vendor {vendor} contains a line break or a zero byte', 'Pass {key} as a single line with no zero bytes'),
  config_settings_vendor_unknown: text('{vendor} has no section in the settings file', 'Use one of these vendors instead: {vendors}'),
  config_settings_write_failed: text('The settings file could not be written: {detail}', 'Check the contents of the settings file and the permissions and free space on that path; this was the write itself failing, not a race'),
  config_single_vendor_conflict: text('Two candidates and the single-vendor allowance cannot be asked for in the same call', 'Ask for two candidates without the single-vendor allowance, or ask for one candidate'),
  config_task_missing: text('The task text was empty, so there was nothing to delegate', 'Describe what to do in at least one sentence'),
  // ★★ 이 자리가 `test_plan_invalid` 였다(WS4a 최종 리뷰). 그 코드의 문장은 「얼어붙은 테스트
  //   계획이 검증에 실패했다」이고 회복은 `RECOVERY_RETRY_REPORT` — **재시도하고 신고하라**다.
  //   그런데 거절된 것은 사용자가 `.bom-orch.json` 에 적은 디렉터리 이름 하나이고, 재시도는
  //   그것을 절대 고치지 못한다. 태스크 4 가 이 파일에 세운 규칙(사용자 파일의 잘못은
  //   config/blocked 로, 회복은 그 파일에 대해 실제로 할 수 있는 한 가지로)을 뒤집은 자리라
  //   코드를 그 가족으로 옮겼다. 문장에 자리표시자가 없는 이유: 거절은 스폰 직전에 일어나고
  //   그 자리는 코드 하나만 나르는 `noRun` 이다 — 채울 수 없는 자리표시자는 문장이 아니라
  //   `{path}` 라는 글자로 사용자에게 나간다.
  config_tests_cwd_unusable: text('The tests.cwd directory named in the project configuration does not exist inside the isolated worktree, or leads out of it', 'Fix tests.cwd in .bom-orch.json so it names a directory that the repository actually carries, commit it, then retry the run'),
  config_tool_pattern_unsafe: text('An allowed-tools entry looked like a command-line flag', RECOVERY_RETRY_REPORT),
  config_tool_set_missing: text('The role needs an explicit tool set and none was given', RECOVERY_RETRY_REPORT),
  config_tool_unknown: text('{name} is not a tool this server serves', 'Call one of these instead: {tools}'),
  // ★★ 이 문장은 **소스의 미커밋 변경을 나무라지 않는다.** 미커밋 소스는 그대로 실행된다 —
  //   그것이 실행의 대상이다. 갈린 것은 설정 파일 하나이고, 그 파일만 커밋된 사본에서 읽히기
  //   때문에 "지금 보고 있는 설정" 과 "이 실행이 읽은 설정" 이 달라진다.
  config_uncommitted: text('The project configuration file {file} has an uncommitted change, so the settings this run read are not the ones in the working tree', 'Commit or stash the change to {file}, then retry the run'),
  // ★ 회복이 `config_invalid` 와 다른 이유: 여기서 실패한 것은 **파일이 아니라 git 호출**이다.
  //   "{file} 을 스키마에 맞게 고치고 커밋하라" 는 조언은 멀쩡한 파일을 가진 사용자를 없는
  //   오타를 찾게 만든다. 사용자가 실제로 할 수 있는 움직임은 둘뿐이다 — 다시 시도하는 것과,
  //   이 저장소에서 git 이 도는지 보는 것.
  config_unreadable: text('The project configuration file {file} could not be read from the repository: {detail}', 'Retry the run; if it fails again, check that git can run in this repository'),
  config_wait_ms_invalid: text('The wait budget {waitMs} is not a finite, non-negative number of milliseconds', 'Pass the wait budget in whole milliseconds, or leave it unset'),

  // deps — 의존성 제공(로드맵 §3.6). 옵트인이 **있을 때만** 도달할 수 있는 코드 하나다.
  // ★ 문장의 첫 절이 「켜져 있다」인 이유: 이 실패는 옵트인하지 않은 사용자에게는 존재하지
  //   않는다. 그 사실을 문장이 말하지 않으면 설정을 만진 적 없는 사람이 이 코드를 받고
  //   자기가 무엇을 켰는지 찾아 헤맨다. `{detail}` 이 두 갈래(잠금 파일 부재 / 설치 실패)를
  //   가르는 유일한 값이고, 설치 실패 쪽은 종료 코드와 stderr 첫 줄만 나른다(불변식 4).
  // ★ 회복 문장이 **두 갈래를 다 부른다**(재리뷰 Minor 6). 예전에는 「잠금 파일을 커밋하라」
  //   하나였는데, 그것은 설치 실패 갈래에 틀린 조언이다 — 그 갈래는 오프라인 기계에서 **첫
  //   실행의 예상 결과**이고(모듈 머리: 전역 캐시를 재사용하지 않는다) 잠금 파일은 이미 있다.
  //   어느 갈래인지는 `{detail}` 이 이미 말하므로, 회복은 그 둘에 각각 붙는 한 수씩을 이름으로
  //   부르고 끄는 법을 마지막에 둔다. 코드는 하나다(계획이 정한 어휘) — 갈리는 것은 문장뿐이다.
  deps_unavailable: text('Dependency provisioning is switched on in {file}, but the dependencies could not be installed: {detail}', 'Commit a lockfile that matches package.json if the baseline carries none, or make the package registry reachable and retry if the install itself failed, or set tests.provisionDeps to "none" in {file} to run without it'),

  // evidence — 기계 증거와 그 봉인. 증거가 없으면 후보는 unverified 로만 나갈 수 있다.
  evidence_adapter_incomplete: text('The test reporter produced no readable events, so this run carries no machine evidence', 'Check that the project test command runs a supported reporter, then retry'),
  evidence_artifact_too_large: text('The evidence record exceeded the artifact size limit of {limit} bytes', 'Narrow the test scope so the evidence stays under {limit} bytes, then retry'),
  evidence_authority_mismatch: text('The stored evidence did not match the sealed attempt it claims to describe, so it carries no authority', RECOVERY_NEW_RUN),
  evidence_cleanup_unproven: text('An evidence worktree could not be proven removed, and handing it to the reaper failed', 'Remove the leftover worktree under the state root, then retry'),
  evidence_controller_authority_lost: text('The evidence controller hard-stopped, so the artifact store it owned can no longer be trusted', RECOVERY_ARTIFACT),
  evidence_persistence_failed: text('An evidence artifact could not be written durably during the proof run', RECOVERY_STATE_ROOT),
  evidence_revision_mismatch: text('The evidence worktree sits on a different commit than the proof asked for', RECOVERY_NEW_RUN),
  evidence_seal_failed: text('The revision identity did not match the snapshot it claims to seal, so the attempt could not be sealed', RECOVERY_RETRY_REPORT),
  evidence_snapshot_failed: text('The snapshot that seals a writer attempt produced no commit id, so there is nothing to build evidence on', RECOVERY_GIT_REPO),
  evidence_spec_invalid: text('The evidence run was requested with a specification that failed validation', RECOVERY_RETRY_REPORT),
  evidence_store_authority_lost: text('The evidence writer lost the artifact store authority it was given, so the store can no longer be trusted', RECOVERY_ARTIFACT),
  evidence_unavailable: text('Machine evidence or the regression proof could not be obtained at all, so the candidate is only usable unverified', RECOVERY_READ_DIFF),
  evidence_unstable: text('Two repetitions of the same test group disagreed, so the evidence is flaky', 'Stabilize the flaky test, then retry the run'),
  evidence_worktree_invalid: text('The evidence worktree failed its shape check, so no test could run in it', RECOVERY_RETRY_REPORT),
  evidence_worktree_unavailable: text('The evidence worktree for the proof run could not be created', RECOVERY_STATE_ROOT),

  // git — 사용자 저장소를 상대로 한 명령. 회복은 저장소 상태를 보라는 것이다.
  git_argument_count_exceeded: text('A git command was assembled with more than {limit} arguments, so it was refused before the spawn', RECOVERY_RETRY_REPORT),
  git_arguments_invalid: text('A Git invocation request was refused before spawn because {detail}', 'Pass arguments as a plain array of strings and optional stdin as a finite bounded Buffer, then retry the run'),
  git_cli_unavailable: text('The git executable could not be run, so the project repository could not be inspected', 'Install git and check that PATH reaches it, then retry the run'),
  git_command_failed: text('A git command exited with a non-zero status and wrote nothing this server could report', RECOVERY_GIT_REPO),
  git_diff_failed: text('The revision delta listing failed, or it returned entries that are not a valid sorted diff', RECOVERY_GIT_REPO),
  git_environment_invalid: text('A git command was assembled with an environment that is not a plain object of string values, so it was refused before the spawn', RECOVERY_RETRY_REPORT),
  git_environment_value_invalid: text('The git environment entry {name} is not a string, so the command was refused before the spawn', RECOVERY_RETRY_REPORT),
  git_global_option_refused: text('The git command carried the leading global option {option}, which is not on the hardening allow list', RECOVERY_RETRY_REPORT),
  git_head_unborn: text('The project repository has no commit for HEAD to point at, so no worktree can be created', 'Make at least one commit in the project, or run against a repository that already has one, then retry'),
  git_invocation_failed: text('Reading the call arguments or starting git raised a fault, so the command was refused rather than run unscreened', RECOVERY_RETRY_REPORT),
  git_process_unkillable: text('The git process did not exit after the deadline kill, so the child may still be running', 'Check the host for a git process left behind, then retry the run'),
  git_project_path_missing: text('No project path was given, so there is no repository to inspect', 'Pass the absolute path of the target git repository'),
  git_project_root_not_canonical: text('The project path {path} could not be resolved to a canonical directory', 'Give the absolute path of an existing git repository, then retry'),
  git_repository_missing: text('The project path {path} exists but is not inside a git repository', 'Give the path of a git repository as the project, then retry the run'),
  git_seal_failed: text('A writer attempt could not be sealed: the snapshot, the revision delta or the collected patch did not verify', RECOVERY_RETRY_REPORT),
  git_snapshot_failed: text('The snapshot of the writer step produced no commit id, so the attempt could not be sealed', RECOVERY_GIT_REPO),
  // ★ 하한을 문장에 박지 않고 인자로 받는다 — 두 자리(여기와 git.mjs 의 상수)에 적으면 갈린다.
  git_spawn_failed: text('The git process never started, so the command produced no exit status', 'Install git and check that PATH reaches it, then retry the run'),
  git_version_below_floor: text('The installed git {version} is older than {floor}, the first release that stops following out-of-tree symlinks during checkout on case-insensitive filesystems (CVE-2024-32002)', 'Upgrade git to {floor} or later, then retry the run'),

  git_working_directory_invalid: text('A git command was assembled with a working directory that is not an absolute path, so it was refused before the spawn', RECOVERY_RETRY_REPORT),
  // judge — 눈을 가린 심판 두 명. 답을 읽을 수 없으면 선택이 성립하지 않는다.
  // ★★ 심판 자리의 **취소**(최종 리뷰 M7). 심판 경로는 접힌 신호로 판정하므로 스스로는 마감과
  //   취소를 못 가른다 — 실행 수준의 답(`haltReasonCode`)을 이 코드가 심판 슬롯으로 나른다.
  //   `run_cancelled` 를 그 자리에 그대로 실을 수는 없다: `JUDGE_CODES` 밖이라 본문이 무너진다.
  judge_cancelled: text('The host cancelled this run before the blind judge could finish', 'Start a new run when you want the work again'),
  judge_deadline: text('The run deadline passed before the blind judge could finish', RECOVERY_WAIT_MS),
  judge_decision_invalid: text('The judge decision named neither a tie nor a known candidate lane', RECOVERY_RETRY_JUDGE),
  judge_format_invalid: text('The judge answer was empty, oversized, malformed, or could not be matched back to the blinded lanes', RECOVERY_RETRY_JUDGE),
  judge_invalid: text('Neither blind judge produced a decision this server could use, so no candidate was selected', RECOVERY_RETRY_JUDGE),
  judge_json_invalid: text('The judge answer was not valid JSON', RECOVERY_RETRY_JUDGE),
  judge_nonce_preparation_failed: text('The blind judge identity could not be prepared, so judging never ran', RECOVERY_RETRY_REPORT),
  judge_provider_failure: text('The judge call to the {vendor} CLI failed, was truncated, or ran out of time', RECOVERY_VENDOR_LOG),
  judge_schema_invalid: text('The judge answer did not match the verdict shape this server requires', RECOVERY_RETRY_JUDGE),
  judge_scratch_failed: text('The judge scratch worktree could not be prepared or cleaned, so the decision is invalid', RECOVERY_STATE_ROOT),
  judge_tie: text('The blind judges disagreed, reported a tie, or found major defects, so no candidate was selected', 'Read both candidate patches and choose one yourself, or retry the run'),
  judge_view_unavailable: text('A blind judge pair could not be built from the candidate summaries, so judging never ran', RECOVERY_RETRY_REPORT),

  // lane — 후보 레인 하나가 끝난 이유. `lane_verified` 는 성공이다.
  lane_budget_exhausted: text('The lane used every attempt in its budget without reaching a decision', 'Raise the step budget or narrow the task, then retry'),
  lane_stagnated: text('Two attempts in a row produced the same tree and the same open issues, so the lane stopped', 'Narrow the task or split it, then retry'),
  lane_unverified: text('The verifier verdict could not be read even after the format-correction retry', RECOVERY_READ_DIFF),
  lane_verified: text('Every gate passed: the verifier approved, no issues are open, and the machine evidence and regression proof are green', 'Review the patch and apply it if you agree'),
  learning_applied_axes_missing: text('This run record does not say which cells its grade was applied to, so that contribution cannot be taken back', 'Clear the learning state with a reset and let it fill again; that is the recovery path for records written in the old format'),
  learning_applied_grade_unknown: text('This run record claims the grade {grade}, which cannot be turned back into a contribution', 'Adding a new grade without taking the old one back would count it twice; read the journal row before correcting it again'),
  learning_arm_missing: text('A learning update named no arm', RECOVERY_RETRY_REPORT),
  learning_cell_key_conflict: text('A reset named both a single cell and a list of cells', 'Name either one cell or a list of cells, not both'),
  learning_cell_key_duplicated: text('The cell {cell} came twice in one transaction, and one run makes at most one observation per axis', RECOVERY_RETRY_REPORT),
  learning_cell_key_invalid: text('The cell name was empty or was not text', 'Name the cell as text, or leave it out to clear everything'),
  learning_cell_key_missing: text('A learning update named no cell', RECOVERY_RETRY_REPORT),
  learning_cell_keys_invalid: text('The list of cells to clear was not a list of non-empty names', 'Pass a list of cell names, or leave it out to clear everything'),
  learning_choice_map_invalid: text('This run record was written by policy version 2 but its recorded choices are not intact', 'Leave this journal row alone; start a new run to get a record in the current format'),
  learning_generation_expired: text('A reset retired the learning generation this run belongs to, so its grade can no longer be corrected', 'Start a new run and correct that one instead'),
  learning_generations_read_failed: text('The learning generations file could not be read: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_generations_snapshot_failed: text('The generations snapshot could not be written, so nothing was reset: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_journal_read_failed: text('The run journal could not be read: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_journal_record_invalid: text('The journal record was not an object carrying a run identity', RECOVERY_RETRY_REPORT),
  learning_journal_record_unserializable: text('The journal record could not be turned into JSON: {detail}', RECOVERY_RETRY_REPORT),
  learning_journal_row_unbuildable: text('The replacement journal row could not be built: {detail}', RECOVERY_RETRY_REPORT),
  learning_journal_row_write_failed: text('The journal row that explains this learning change could not be appended: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_lock_unavailable: text('The learning lock could not be taken: {detail}', 'Retry in a moment; pending learning work is replayed by the next read or retry'),
  learning_mutation_failed: text('The learning state and the run record could not be changed together: {detail}', 'Retry in a moment; pending learning work is replayed by the next read or retry'),
  learning_pending_work_invalid: text('The pending learning work is malformed, so it cannot be replayed: {detail}', RECOVERY_RETRY_REPORT),
  learning_pending_work_read_failed: text('The pending learning work could not be read: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_pending_work_unclearable: text('The pending learning work was replayed but its record could not be removed: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_policy_version_unknown: text('This run record was written by learning policy version {version}, which this server cannot correct', 'Correct it with the version of this server that wrote the row; rolling it back with a different version counts the contribution twice'),
  learning_posteriors_not_json: text('The learning state file is not readable as JSON: {detail}', 'Clear the learning state with a reset; the unreadable bytes are kept beside it first'),
  learning_posteriors_quarantine_failed: text('The learning state could not be read and could not be set aside as {path} either: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_posteriors_read_failed: text('The learning state file could not be read: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_posteriors_reset_failed: text('The learning state could not be cleared: {detail}', 'Retry the same reset in a moment; pending work is replayed by the next read, and if it keeps failing stop every server on this state root and restore the paired snapshot'),
  learning_posteriors_shape_invalid: text('The learning state file is JSON but not a set of cells', 'Clear the learning state with a reset; the unusable bytes are kept beside it first'),
  learning_run_not_found: text('No run named {runId} is in the journal', 'Ask orch_stats for the recent run list and use one of the identities it prints'),
  learning_run_task_class_missing: text('The run {runId} has no task class, so there is no learning cell to correct', 'This run is not tied to a learning cell; choose a different run'),
  learning_scope_read_failed: text('The learning state could not be read, so the cells of {taskClass} alone could not be cleared: {detail}', 'Ask for a reset without a task class; that discards the unreadable file whole'),
  learning_scope_unreadable: text('A single task class cannot be picked out of a corrupt learning state', 'Ask for a reset without a task class; that discards the unreadable file whole'),
  learning_snapshot_failed: text('The snapshot could not be written, so nothing was reset: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_task_class_conflict: text('A task class was named together with an explicit cell list', 'Name either a task class or a cell list, not both'),
  learning_task_class_invalid: text('The task class was empty or was not text', 'Name the task class as text, or leave it out to clear everything'),
  learning_updates_invalid: text('The learning updates were not a list', RECOVERY_RETRY_REPORT),
  learning_work_failed: text('The learning write failed', 'Retry in a moment; pending learning work is replayed by the next read or retry'),
  learning_work_invalid: text('The learning work is missing its version, its operation identity or its learning target', RECOVERY_RETRY_REPORT),
  learning_work_journal_invalid: text('The journal target of the learning work was not an object', RECOVERY_RETRY_REPORT),
  learning_work_journal_run_id_missing: text('The journal target of the learning work carries no run identity', RECOVERY_RETRY_REPORT),
  learning_work_publish_failed: text('{name} could not be moved into place: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_work_quarantine_invalid: text('The quarantine target of the learning work was not the corrupt learning state bytes', RECOVERY_RETRY_REPORT),
  learning_work_unserializable: text('{name} could not be turned into JSON: {detail}', RECOVERY_RETRY_REPORT),
  learning_work_write_failed: text('{name} could not be written: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  learning_write_boundary_failed: text('The learning write failed at the {name} boundary: {detail}', 'Retry in a moment; pending learning work is replayed by the next read or retry'),

  // provider — 벤더 CLI 프로세스와 그 스트림. 문장에 벤더 이름이 들어간다.
  preflight_cross_vendor_unavailable: text('Cross-vendor verification needs two vendor CLIs and only one is available', 'Install both vendor CLIs, or pass the single-vendor allowance to accept a one-vendor run'),
  // ★ 이름을 **문장에** 싣는다. 「지원되지 않는 구성」만 말하면 읽는 사람은 자기 셸의 어느
  //   변수가 그것인지 모르고, 그것을 모르면 조치가 없다. 값은 안 싣는다(자격일 수 있다).
  preflight_gateway_env_unsupported: text('This host selects a vendor gateway deployment ({names}), which this server does not support', 'Unset {names} in the shell that starts this server, or start it from a shell without them, then retry the run'),
  preflight_no_provider_available: text('No vendor CLI answered the preflight, so no role could be filled', RECOVERY_INSTALL),
  preflight_provider_unavailable: text('The {role} role was pinned to {vendor}, which the preflight reported unavailable', 'Install that vendor CLI and check that PATH reaches it, then retry the run'),
  provider_below_security_floor: text('The {vendor} CLI at version {version} is below the security floor a write role requires', 'Update the {vendor} CLI to {floor} or newer, or pin a different vendor as the writer'),
  provider_cli_not_found: text('The {vendor} CLI was not found on PATH', RECOVERY_INSTALL_VENDOR),
  provider_cli_shim_only: text('Only a shell shim was found for the {vendor} CLI, and this server spawns without a shell', 'Install the native {vendor} executable, then retry'),
  // ★★ **중립 이름**이다(최종 리뷰 I1). 카탈로그는 「우리가 이 호출을 끊었다」까지만 알고
  //   「누가 껐는가」는 원리적으로 모른다 — 벤더에게 간 신호는 마감과 호스트 취소가 접힌
  //   하나다(`src/deadline.mjs haltSignal`). 그래서 이 문장에는 마감도 wait_ms 도 없다.
  provider_call_halted: text('The {vendor} call was cut short before it produced a result', RECOVERY_GENERIC),
  provider_deadline_exceeded: text('The {vendor} writer call ran out of time at the deadline boundary, or the lane deadline passed first', RECOVERY_WAIT_MS),
  provider_error_unclassified: text('The {vendor} CLI failed in a way this server does not classify yet', RECOVERY_VENDOR_LOG),
  provider_exit_nonzero: text('The {vendor} CLI exited with a non-zero status', RECOVERY_VENDOR_LOG),
  provider_no_terminal_record: text('The {vendor} event stream ended without a final record, so the answer is incomplete', RECOVERY_VENDOR_LOG),
  provider_outcome_unknown: text('It cannot be proven whether the writer call changed the worktree, so that worktree was quarantined', 'Start a new run; the quarantined worktree is left for the reaper'),
  provider_output_truncated: text('The {vendor} CLI stopped at its own output or turn limit before finishing the answer', 'Narrow the task so the answer fits, then retry'),
  provider_rate_limited: text('The {vendor} CLI refused the call because the account usage limit is exhausted', 'Wait for the {vendor} usage limit to reset, or run with the other vendor'),
  provider_reported_failure: text('The {vendor} CLI reported that the writer step failed', RECOVERY_VENDOR_LOG),
  provider_signal_killed: text('The {vendor} process was killed by a signal before it produced a result', 'Retry the run; if it recurs, check the host for memory pressure or an external process reaper'),
  provider_spawn_denied: text('The operating system refused to execute the {vendor} CLI at {path}', 'Install the native {vendor} executable, or fix the execute permission on that file, then retry'),
  provider_spawn_failed: text('The {vendor} executable disappeared between the PATH lookup and the spawn', RECOVERY_INSTALL_VENDOR),
  provider_stream_unparsable: text('The {vendor} event stream carried records this server could not read, so the result is incomplete', 'Retry the run; if it recurs, report the reasonCode and the {vendor} CLI version'),
  // ★ 회복이 발췌를 가리키지 않는다 — 이 코드에는 발췌가 붙지 않는다(EXCERPT_ALLOWED 밖). 벤더가
  //   보낸 문장은 실행 로그에만 남으므로, 읽을 곳을 정직하게 로그로 적는다.
  provider_turn_failed: text('The {vendor} CLI reported that the turn itself failed', RECOVERY_GENERIC),

  // resume — `orch_run(resume_run_id)` 의 거부 넷(WS3 §3). 넷 다 **아무것도 시작하지 않은** 실행이라
  // 회복은 하나뿐이다: 그 인자 없이 새 실행을 부른다. ★ 회복이 `resume_run_id` 를 이름으로 적는
  // 것은 그것이 **호출자가 실제로 넘기는 인자**이기 때문이다(레지스트리 전역 가드가 금하는 것은
  // 서버가 짓는 `runId`·`run id` 다). 이름을 못 찾은 쪽만 목록을 함께 가리킨다 — 나머지 셋은 이름을
  // 옳게 댔고, 그 실행이 이 실행의 재료가 못 되는 것뿐이다.
  resume_baseline_mismatch: text('The run named {runId} was built on a different baseline than this call prepared, so its sealed attempts describe a different source tree', RECOVERY_RESUME_FRESH),
  resume_environment_mismatch: text('The run named {runId} froze its test plan in a different environment, so the evidence it sealed would not be evidence here', RECOVERY_RESUME_FRESH),
  resume_manifest_unreadable: text('The run named {runId} is on this state root but what it left could not be read', RECOVERY_RESUME_FRESH),
  resume_run_not_found: text('No run named {runId} is on this state root, so there is nothing to resume', RECOVERY_STATUS_LIST),

  // run — 실행 전체가 끝난 이유. 후보별 사유는 본문에 있다.
  run_all_candidates_blocked: text('Every candidate lane was blocked, so no patch was produced', RECOVERY_CANDIDATE_REASONS),
  run_all_candidates_rejected: text('Every candidate was rejected, so there was nothing eligible to select', RECOVERY_CANDIDATE_REASONS),
  run_binding_invalid: text('The planner, worker and verifier could not be bound to distinct available vendors', 'Install both vendor CLIs, or pass allow_single to accept a single-vendor run'),
  run_binding_preparation_failed: text('Assigning the vendor roles for this run failed before any call was made', RECOVERY_RETRY_REPORT),
  // ★★ WS3 태스크 7 이 문장을 고쳤다. 예전 문장은 「벤더 호출이 도는 중에 취소됐고 워크트리를
  //   격리했다」였는데, 생산자를 실어 보니 그 둘 다 **모든 취소에서 참이 아니다**: 취소는 사전
  //   점검 앞에서도 오고(워크트리도 벤더 호출도 아직 없다) 격리는 워크트리가 있을 때만 일어난다.
  //   남은 워크트리의 운명은 이미 알림(`worktree_handed_to_reaper`/`_manual_cleanup_required`)이
  //   정확히 나르므로, 코드 문장은 언제나 참인 사실 하나만 말한다 — `run_deadline_exceeded` 가
  //   같은 규칙으로 쓰여 있다. 생산자 없는 문구는 그 자리가 생기는 날 거짓이 된다(WS2 §14).
  run_cancelled: text('The host cancelled this run before it finished', 'Start a new run when you want the work again'),
  run_deadline_exceeded: text('The {waitMs} millisecond deadline for this run passed before it finished', RECOVERY_WAIT_MS),
  run_deadline_unrepresentable: text('The clock and the wait budget do not produce a deadline this server can represent exactly', 'Check the system clock and the wait budget, then retry'),
  run_nested_invocation: text('This server is running inside a delegate that an orchestration started (run {runId}), so it refuses every tool call', 'You are already inside an orchestration; run the tool from the outer process instead'),
  run_orchestration_failed: text('The orchestration stopped on an unexpected internal fault', 'Retry the run; if a worktree is left behind, check the worktrees directory under the state root'),
  run_preparation_input_invalid: text('The run preparation was entered with input that had already failed validation', RECOVERY_RETRY_REPORT),
  run_result_unserializable: text('The result could not be turned into JSON', 'The result may be too large or hold a cycle; retry with a narrower request'),
  run_selection_unavailable: text('The candidates ended in a mix of outcomes that no selection rule covers', RECOVERY_CANDIDATE_REASONS),
  run_tool_failed: text('The tool call failed: {detail}', 'Retry the call or read the server log'),
  run_tool_handler_missing: text('The tool {name} is published but this server has no handler wired for it', 'This is not something a caller can fix; report this sentence together with the server log'),

  // scope — 패치가 건드려도 되는 범위. 정책 위반은 재시도로 사라지지 않는다.
  scope_files_input_invalid: text('The changed-file list was not a list of strings, so the patch scope could not be checked', RECOVERY_RETRY_REPORT),
  scope_index_unreadable: text('The worktree index could not be read, so the symbolic links the patch touches could not be resolved', RECOVERY_RETRY_PATCH),
  scope_inspection_failed: text('The patch scope check stopped on an unexpected internal fault', RECOVERY_RETRY_REPORT),
  scope_path_policy_unavailable: text('The patch scope policy could not run because the ignored and unsafe path lists were missing', RECOVERY_RETRY_REPORT),
  scope_policy_failure: text('The patch touched a path the scope policy forbids, or it changed what the tests are', 'Read the flagged paths in the result, then ask for a change that stays inside the allowed paths'),
  scope_tamper_failure: text('A tamper signal was raised for this attempt, so its decision cannot be trusted', 'Retry with a narrower task; if it recurs, report the reasonCode and the run log'),
  scope_worktree_path_missing: text('The worktree path was missing, so the symbolic links the patch touches could not be checked', RECOVERY_RETRY_REPORT),
  state_directory_create_failed: text('The state directory could not be created: {detail}', 'Check the permissions on that path, then retry'),
  state_lock_create_failed: text('The lock file could not be created: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),
  state_lock_path_invalid: text('The lock was asked for with an empty path', RECOVERY_RETRY_REPORT),
  state_lock_timeout: text('The lock was still held when the wait budget ran out (last error: {code})', 'Retry in a moment; if it never clears, check the permissions on the state root'),
  state_lock_token_write_failed: text('The ownership marker could not be written, so the work under the lock never started: {detail}', 'Check that the state root is writable and the disk has free space, then retry'),

  // state — 상태 루트 락.
  state_lock_work_failed: text('The work under the state-root lock failed after the lock was taken: {detail}', RECOVERY_STATE_ROOT),
  state_lock_work_not_callable: text('The work to run under the lock was not a function', RECOVERY_RETRY_REPORT),
  state_recovery_intent_unavailable: text(
    'The durable recovery intent could not be recorded, so the worktree effect was not started',
    'Check that the state root is writable and has free space, then retry',
  ),
  state_root_not_absolute: text('The state root is not an absolute path', 'Set BOM_ORCH_HOME to an absolute path or leave it empty'),
  state_schema_newer: text(
    'The write to shared state file {file} was blocked because it declares schemaVersion {version}, and this server implements schemaVersion {supported}',
    'Update this plugin to a version that reads schemaVersion {version}, then retry without changing or downgrading {file}',
  ),

  // status — 끝난 실행을 되읽는 경로. ★ 두 회복 모두 **목록**을 가리킨다: 이름은 서버가 짓고
  // 호출자는 고를 수 없으므로 "고쳐서 다시 물어보라" 는 회복이 아니다(레지스트리 전역 가드가
  // `runId`·`run id` 를 회복 문구에서 금한다 — `test/reason-text.test.mjs`).
  // ★ `unreadable` 쪽에 `{runId}` 를 안 넣는 이유: 같은 문장이 「이 실행의 매니페스트를 못 읽었다」
  //   와 「최근 목록을 열거하지 못했다」 둘 다에 실린다. 뒤쪽에는 실행 이름이 없고, 없는 인자를
  //   요구하는 문구는 렌더를 강등시켜 코드만 남긴 봉투를 만든다. 이름은 봉투의 `runId` 가 나른다.
  status_run_not_found: text('No run named {runId} is on this state root', RECOVERY_STATUS_LIST),
  status_run_unreadable: text('The run records on this state root could not be read', RECOVERY_STATUS_LIST),

  // test · evidence 실행 — 서버가 직접 돌리는 테스트. 여기 문장이 사용자에게 가장 자주 보인다.
  test_abort_signal_invalid: text('The frozen test run was handed something that is not an abort signal', RECOVERY_RETRY_REPORT),
  test_aborted_before_start: text('The run was already cancelled when the test was asked to start, so nothing ran', 'Start a new run when you want the work again; if it keeps stopping early, raise wait_ms'),
  test_baseline_not_green: text('The baseline test run did not pass, so a later failure would prove nothing', 'Make the project test suite pass on the baseline commit, then retry'),
  test_cache_entry_invalid: text('The evidence cache held a record this server did not write, so the whole cache was refused', RECOVERY_NEW_RUN),
  test_candidate_failed: text('The candidate test run did not pass', RECOVERY_READ_TESTS),
  test_candidate_witness_missing: text('The candidate test run did not observe the exact failures the regression test identified', RECOVERY_READ_TESTS),
  test_command_unavailable: text('The frozen test plan has no runnable command in this environment', 'Install the project test tool and check that PATH reaches it, then retry'),
  test_deadline_expired: text('The run deadline passed inside the test queue, so no further test could run', RECOVERY_WAIT_MS),
  test_definition_tampering: text('The delegate changed a file that defines what the tests are', 'Ask for a change that leaves the test configuration alone, then retry'),
  test_delta_apply_failed: text('Applying the test-only part of the patch to the evidence worktree failed', RECOVERY_RETRY_REPORT),
  test_delta_authority_mismatch: text('The test-only patch did not verify against its own bytes, digest and path list', RECOVERY_NEW_RUN),
  test_delta_collection_failed: text('Collecting the test-only part of the patch from git failed', RECOVERY_GIT_REPO),
  test_delta_collection_mismatch: text('The collected test-only patch did not list exactly the paths that were requested', RECOVERY_RETRY_REPORT),
  test_delta_deletion_only: text('Every test change in the patch is a deletion', 'Ask for a change that adds a failing test instead of removing tests, then retry'),
  test_delta_duplicate_path: text('The patch listed the path {path} twice', RECOVERY_RETRY_PATCH),
  test_delta_empty: text('The candidate changed no test files at all', 'Ask for a change that adds a test proving the fix, then retry'),
  test_delta_ignored_path: text('The patch touched {path}, which this repository tells git to ignore', 'Ask for a change that stays inside tracked paths, then retry'),
  test_delta_ignored_path_invalid: text('An ignored path in the patch failed the strict relative-path check', RECOVERY_RETRY_PATCH),
  test_delta_input_invalid: text('The test-only split was given an entry list or a revision it could not read', RECOVERY_RETRY_REPORT),
  test_delta_path_invalid: text('A path in the patch failed the strict relative-path check', RECOVERY_RETRY_PATCH),
  test_delta_unavailable: text('The patch carried no test-only part that could be separated from the rest', RECOVERY_RETRY_PATCH),
  test_delta_unsafe_path: text('The patch touched a path git flagged unsafe, or a file mode this server refuses to apply', RECOVERY_RETRY_PATCH),
  test_delta_unsafe_path_invalid: text('An unsafe path in the patch failed the strict relative-path check', RECOVERY_RETRY_PATCH),
  test_dependency_unavailable: text('The test run failed because the project dependencies are not installed', 'Install the project dependencies, then retry'),
  test_environment_drift: text('The runtime environment no longer matches the frozen test plan', 'Retry the run so the plan is frozen against the current environment'),
  test_event_file_cleanup_unproven: text('The reporter event file could not be proven removed, so its bytes are not trusted as evidence', RECOVERY_STATE_ROOT),
  test_event_file_creation_unproven: text('The reporter event file could not be proven to be the file this server just created', RECOVERY_STATE_ROOT),
  test_event_file_identity_drift: text('The reporter event file is no longer the file this server created before the test spawned', 'Retry the run; if it recurs, check for another process writing under the state root'),
  test_executable_drift: text('The test executable changed since the test plan was frozen', 'Retry the run so the plan is frozen against the current executable'),
  test_execution_unavailable: text('The test run never completed, so it produced no result to read', 'Retry the run; if it recurs, check whether the project test command hangs on this host'),
  // ★ `{detail}` 은 **던진 것**의 텍스트다(`errorText`). 이 자리는 러너가 계획한 적 없는 실패의
  //   마지막 그물이라, 코드만 내면 무엇이 터졌는지가 어느 채널에도 남지 않는다.
  test_frozen_execution_failed: text('The test run failed before it could report an exit code ({detail})', RECOVERY_RETRY_REPORT),
  test_helper_untrusted: text('The patch touched a test file the reporter does not trust as an ordinary test', RECOVERY_READ_DIFF),
  test_launcher_drift: text('A launcher in the test command no longer resolves to the executable the plan froze', 'Retry the run so the plan is frozen against the current executable'),
  test_machine_failed: text('The tests report failure and there is no budget left to repair it', 'Read the failing tests in the result, then retry with a bigger step budget'),
  // ★ 「테스트를 정의하는 파일」이 넷인 프로젝트에서 이름 없는 문장은 아무것도 가리키지 않는다.
  //   `{file}` 은 **저장소 상대 이름**이고(`package.json`·`.npmrc`) 파일 **내용**은 절대 싣지
  //   않는다 — 어긋난 값은 `drift.project`/`drift.worktree` 의 지문 요약이 나른다.
  test_pinned_definition_drift: text('{file} defines what the tests are, and its {key} changed after the plan was frozen', 'Leave the test configuration unchanged while a run is in flight, then retry'),
  test_plan_invalid: text('The frozen test plan failed validation, so no test could be started', RECOVERY_RETRY_REPORT),
  test_plan_untrusted: text('The project test command is not one of the reporters this server trusts as a regression witness', 'Run the project tests through a supported reporter, or accept the candidate as unverified'),
  test_process_cleanup_unproven: text('Test child processes could not be proven dead, so no further test could run in this run', 'Kill the leftover test processes, then retry'),
  test_proof_not_proven: text('The regression proof is repairable but unproven, and there is no budget left', RECOVERY_MORE_BUDGET),
  test_queue_poisoned: text('An earlier fault poisoned the test queue, so no further test could run in this run', RECOVERY_NEW_RUN),
  test_record_invalid: text('A test record failed its shape check, so it cannot be used as evidence', RECOVERY_RETRY_REPORT),
  test_regression_collection_failed: text('The regression test failed while collecting tests instead of at an assertion', RECOVERY_READ_TESTS),
  test_regression_did_not_fail: text('The baseline plus the new test passed, so the new test does not reproduce the bug', 'Describe the failure you want reproduced more precisely, then retry'),
  test_regression_witness_missing: text('The regression test failed without the reproduced assertion this server needs as a witness', RECOVERY_READ_TESTS),
  test_start_invalid: text('The test queue was handed something other than a test to start', RECOVERY_RETRY_REPORT),

  // verifier — 읽기 전용 교차검증. 판정을 읽을 수 없으면 후보는 unverified 다.
  verifier_failed: text('The verifier returned a structured FAIL verdict and there was no budget left to repair it', 'Read the verifier issues in the result, then retry with a bigger step budget'),
  verifier_issue_limit_exceeded: text('The issue ledger would exceed the {limit} blocking-issue limit', 'Narrow the task so fewer issues are raised, then retry'),
  verifier_issues_open: text('Blocking issues are still open after the verdict and the budget is exhausted', 'Read the open issues in the result, then retry with a bigger step budget'),
  verifier_mutation: text('The read-only verifier changed the worktree, so its verdict cannot be trusted', 'Retry the run; if it recurs, run with the other vendor as the verifier'),
  verifier_operational_failure: text('The verifier call itself failed, or its mutation check could not be taken at all', RECOVERY_VENDOR_LOG),
  verifier_verdict_invalid: text('The verifier verdict could not be read: {detail}', RECOVERY_READ_DIFF),

  // worktree — 우리 소유의 일회용 워크트리.
  worktree_add_failed: text('The disposable worktree could not be created: {detail}', 'Check that the target is a git repository with at least one commit, then remove any leftover worktree of the same name under the state root and retry'),
  worktree_baseline_missing: text('The source worktree handle carries no shared baseline commit, so no revision worktree could be derived from it', RECOVERY_RETRY_REPORT),
  worktree_creation_crashed: text('Creating the worktree stopped on an unexpected fault: {detail}', RECOVERY_STATE_ROOT),
  worktree_creation_failed: text('The worktree for this step could not be created and no reason was reported', RECOVERY_STATE_ROOT),
  worktree_delta_listing_failed: text('The revision delta could not be listed: {detail}', RECOVERY_GIT_REPO),
  worktree_delta_mode_inconsistent: text('The delta entry for {path} pairs a status with file modes that cannot both be true', RECOVERY_RETRY_PATCH),
  worktree_delta_output_invalid: text('The raw revision delta from git was truncated, unterminated, or not in the record format this server reads', RECOVERY_RETRY_REPORT),
  worktree_delta_path_unexpected: text('git returned the delta path {path}, which is not literally one of the requested paths', 'Ask for the exact repository paths git returns, not case or normalization aliases'),
  worktree_delta_type_change: text('The delta entry for {path} is a file type change, which a path-only delta cannot carry safely', RECOVERY_RETRY_PATCH),
  worktree_delta_unsafe_mode: text('The delta entry for {path} carries a symbolic link or nested repository mode, which is never used as apply authority', RECOVERY_RETRY_PATCH),
  worktree_diff_output_missing: text('git reported a successful diff but left no patch file at {path}', RECOVERY_STATE_ROOT),
  worktree_final_files_failed: text('The changed-file list of the final patch could not be read, so the change scope cannot be checked: {detail}', RECOVERY_GIT_REPO),
  worktree_final_patch_failed: text('The final patch could not be produced: {detail}', RECOVERY_GIT_REPO),
  worktree_final_patch_unreadable: text('The final patch bytes could not be read back: {detail}', RECOVERY_STATE_ROOT),
  worktree_handle_invalid: text('The worktree handle failed its shape check, so nothing was run in it', RECOVERY_RETRY_REPORT),
  worktree_handle_path_unresolved: text('The paths on the worktree handle could not be resolved to canonical paths inside the state root', RECOVERY_RETRY_REPORT),
  worktree_head_unreadable: text('HEAD could not be read inside the worktree: {detail}', 'Check that the worktree still exists under the state root, then retry'),
  worktree_id_invalid: text('The worktree id is not usable as a directory name under the state root', RECOVERY_RETRY_REPORT),
  worktree_id_underivable: text('No safe worktree directory name of at most 64 characters could be derived for this run', RECOVERY_RETRY_REPORT),
  worktree_index_unlocatable: text('The worktree index could not be located at a canonical path that worktree owns', RECOVERY_NEW_RUN),
  worktree_not_pristine: text('The revision worktree was not pristine, so the patch was not applied into it', RECOVERY_NEW_RUN),
  worktree_patch_apply_failed: text('The patch did not apply to the worktree, which was rolled back: {detail}', RECOVERY_RETRY_PATCH),
  worktree_patch_bytes_invalid: text('The patch to apply was not raw bytes', RECOVERY_RETRY_REPORT),
  worktree_patch_delta_empty: text('The patch produced no file delta at all, so there was nothing to apply', RECOVERY_RETRY_PATCH),
  worktree_patch_digest_invalid: text('The declared patch digest was not a full lowercase 64 character hex value', RECOVERY_RETRY_REPORT),
  worktree_patch_digest_mismatch: text('The patch bytes do not hash to the digest declared with them', RECOVERY_RETRY_PATCH),
  worktree_patch_preflight_delta_unreadable: text('The path and mode preflight of the patch could not be read back: {detail}', RECOVERY_GIT_REPO),
  worktree_patch_preflight_index_failed: text('The temporary index for the patch preflight could not be built: {detail}', RECOVERY_STATE_ROOT),
  worktree_patch_preflight_rejected: text('The patch does not apply cleanly to the revision it names: {detail}', RECOVERY_RETRY_PATCH),
  worktree_patch_preflight_tree_failed: text('The expected tree of the patch preflight could not be written: {detail}', RECOVERY_GIT_REPO),
  worktree_patch_processing_failed: text('Handling the patch bytes stopped on an unexpected fault: {detail}', RECOVERY_STATE_ROOT),
  worktree_patch_tree_mismatch: text('The commit made from the applied patch does not carry exactly the tree the preflight produced', 'Check the filter and ignore settings of the target repository, then retry'),
  worktree_path_duplicate: text('The path {path} appears twice in the list, either literally or under case and Unicode folding', RECOVERY_RETRY_PATCH),
  worktree_path_in_use: text('The worktree path {path} is registered to another run, so it was left untouched', 'Wait for the other run to finish, or prune that registration in the target repository, then retry'),
  worktree_path_list_invalid: text('The path list was not a list of at most {limit} non-empty strings', RECOVERY_RETRY_REPORT),
  worktree_path_not_canonical: text('The path {path} could not be resolved to a canonical path, so it was left untouched', 'Check that the path exists and is readable by this user, then retry'),
  worktree_path_outside_state_root: text('The worktree path {path} resolves outside the worktrees directory of the state root', 'Check the worktrees directory under the state root for links that point elsewhere, then set BOM_ORCH_HOME to a clean absolute path and retry'),
  worktree_path_undecodable: text('A path in the list carries a NUL byte or a character that did not decode as UTF-8, so it was refused rather than guessed', RECOVERY_RETRY_PATCH),
  worktree_path_unsafe: text('The path {path} is absolute, ambiguous across platforms, or able to escape the repository', RECOVERY_RETRY_PATCH),
  worktree_path_windows_ambiguous: text('The path {path} could resolve to a different file, an alternate data stream, or a device name on Windows', RECOVERY_RETRY_PATCH),
  worktree_project_path_missing: text('The worktree creation call carried no project path', RECOVERY_RETRY_REPORT),
  worktree_purpose_invalid: text('The worktree purpose is not one of the lane or evidence purposes this server allows', RECOVERY_RETRY_REPORT),
  worktree_restore_unproven: text('A patch step failed and the worktree could not be proven restored, so it is quarantined', RECOVERY_NEW_RUN),
  worktree_revision_invalid: text('The revision is not a full lowercase commit id', 'Use the full commit id git returned, then retry'),
  worktree_revision_not_commit: text('The revision {revision} did not resolve to exactly that commit object: {detail}', 'Use a full lowercase commit id that exists in the repository, then retry'),
  worktree_revision_pair_invalid: text('The from and to revisions are not both full lowercase object ids', 'Use the full object ids git returned, then retry'),
  worktree_revision_patch_failed: text('The patch between the two revisions could not be produced: {detail}', RECOVERY_GIT_REPO),
  worktree_revision_patch_unreadable: text('The revision patch bytes could not be read back: {detail}', RECOVERY_STATE_ROOT),
  worktree_revision_tree_unresolved: text('The tree of the resolved commit could not be read: {detail}', RECOVERY_GIT_REPO),
  worktree_run_id_invalid: text('The run id is not usable as a worktree directory name on every supported platform', RECOVERY_RETRY_REPORT),
  worktree_scratch_cleanup_failed: text('The private patch scratch directory could not be cleaned up, so the applied result was rolled back', 'Clear the locked files under the scratch directory of the state root, then start a new run'),
  worktree_scratch_failed: text('The patch scratch directory could not be prepared or read: {detail}', RECOVERY_STATE_ROOT),
  worktree_scratch_not_removed: text('The private patch scratch directory could not be proven removed, so its bytes may still be on disk', RECOVERY_STATE_ROOT),
  worktree_scratch_unusable: text('The scratch directory under the state root could not be proven to be ours and inside the state root', 'Remove any link at the scratch directory under the state root, then retry'),
  worktree_shared_baseline_mismatch: text('The second candidate worktree did not share the baseline commit of the first, so the two candidates would not be comparable', RECOVERY_NEW_RUN),
  worktree_snapshot_commit_failed: text('The worktree snapshot commit failed: {detail}', RECOVERY_GIT_REPO),
  worktree_source_baseline_mismatch: text('The source worktree handle declares a baseline commit and tree that git does not resolve it to, so the handle itself is corrupt', 'Start a new run so the worktree handle is built fresh; nothing derived from this one can be trusted'),
  worktree_stage_failed: text('The worktree changes could not be staged: {detail}', 'Check the file permissions inside the worktree, then retry'),
  worktree_stale_registration_unreclaimed: text('The dead worktree registration for {path} could not be reclaimed: {detail}', 'Prune the stale worktree registrations in the target repository, then retry'),
  worktree_state_root_inside_project: text('The state root {path} is inside the target repository, so the worktrees would see each other and the final patch would carry the state root', 'Set BOM_ORCH_HOME to an absolute path outside the target repository, then retry'),
  worktree_state_root_missing: text('The worktree creation call carried no state root path', RECOVERY_RETRY_REPORT),
  worktree_status_unreadable: text('The worktree status could not be read: {detail}', 'Check that the worktree still exists under the state root, then retry'),
  worktree_step_diff_failed: text('The diff of this step could not be produced: {detail}', RECOVERY_GIT_REPO),
  worktree_step_diff_unreadable: text('The diff bytes of this step could not be read back: {detail}', RECOVERY_STATE_ROOT),
  worktree_step_files_failed: text('The changed-file list of this step could not be read, so what the step touched cannot be checked: {detail}', RECOVERY_GIT_REPO),
  worktree_transplant_apply_failed: text('The uncommitted changes could not be applied into the worktree, so the delegate would have edited stale code: {detail}', 'Commit or stash the local changes, then retry the run'),
  worktree_transplant_diff_failed: text('The patch of the uncommitted changes could not be produced: {detail}', RECOVERY_GIT_REPO),
  worktree_transplant_files_failed: text('The uncommitted changes were transplanted, but the list of which files they were could not be read, so the run cannot say what its baseline contains: {detail}', RECOVERY_GIT_REPO),
  worktree_transplant_index_failed: text('The temporary index for transplanting the uncommitted changes could not be built: {detail}', RECOVERY_GIT_REPO),
  worktree_transplant_stage_failed: text('The uncommitted changes could not be staged for transplant: {detail}', 'Check the target repository for files this user cannot read, then retry'),
});

/**
 * 실패가 아닌 알림의 정본. `notices[]` 로 봉투에 실린다 — reason code 가 아니므로 stopReason 이 없다.
 *
 * ★ 재료는 리서치 `strings.json` 의 notice 76 리터럴이다. 그중 여러 줄로 쪼개져 있던 조각들
 *   (PATH 축소 세 묶음, 샌드박스 경고, 맨이름 안내 등)은 **한 키 한 문장**으로 합쳤다 — 조각을
 *   그대로 옮기면 이전 중에 같은 알림이 두 문장으로 갈린다.
 * ★ 키는 코드처럼 snake_case 다(`test/reason-text.test.mjs` 가 잰다). 마지막 다섯은 아직 생산자가
 *   없다 — 로그 두 개(WS2 §5)·스트림 드리프트·사다리 rung·모델 캐시(§6)가 그 커밋에서 쓴다.
 * ★ 네 자리는 인자 하나에 **목록**을 담는다: `codex_tool_set_not_applied.{tools}` ·
 *   `stats_content_limit_reductions.{detail}` · `reward_unknown_axes_skipped.{detail}` ·
 *   `test_command_bare_name_unresolved.{path}`. 그 값에도 `MAX_PARAM_CHARS`(200) clip 이 그대로
 *   걸리므로 목록이 길어지면 꼬리가 잘린다. 상한을 키별로 올리지 않는 이유: 봉투 한 줄의 길이
 *   상한이 키마다 다르면 어느 알림이 잘릴 수 있는지 아무도 모른다. 목록이 200 자를 넘길 수 있는
 *   생산자는 **항목마다 알림 하나**를 내야 한다(WS2 Task 16).
 */
export const NOTICE_TEXT = deepFreeze({
  // 실행·정리
  worktree_handed_to_reaper: 'Worktree cleanup was handed to the reaper: {path}',
  worktree_manual_cleanup_required: 'This worktree could not be removed and the reaper would not take it, so it needs manual cleanup: {path}',
  scratch_manual_cleanup_required: 'This scratch directory could not be removed, so it needs manual cleanup: {path}',
  // ★ `skipped` 는 "봤고 남겨 뒀다" 다. 던진 스윕은 무엇을 남겼는지조차 모르므로 따로 센다.
  retention_swept: 'The retention sweep removed {removed} expired files and left {skipped} in place; {failed} sweeps failed',
  cleanup_manifest_pending: 'The cleanup was done but the run manifest could not record it, so the manifest is one event behind',
  planner_failed_task_used: 'The planner produced no usable plan, so the original task text was used instead',
  planner_partial_kept: 'The planner ran out of time, so the partial plan it had already produced was used instead of the raw task text',
  planner_scratch_identity_unproven: 'The planner scratch directory could not be proven to be the one this run created',
  planner_scratch_cleanup_pending: 'The planner scratch directory is still on disk and needs manual cleanup: {path}',
  // ★ 실행은 계속됐다 — 계획은 워커·검증자의 프롬프트에 이미 실려 있고, 잃은 것은 **되읽기**다.
  //   그 구별을 문장이 직접 말하지 않으면 이 알림은 「계획 없이 돌았다」로 읽힌다.
  planner_canon_unrecorded: 'The plan could not be saved with this run, so orch_status will not be able to show it later; the run itself used the plan normally',
  // ★ 재개가 성립한 실행이 나르는 유일한 문장(WS3 §3). 봉투의 `runId` 는 **이** 실행의 이름이므로,
  //   재사용된 쪽의 이름은 어디에도 안 실리면 사라진다 — 그 둘을 잇는 자리가 이 알림이다.
  // ★★ 시작 서수와 남은 시도 수를 함께 말한다(최종 리뷰 I5). 「재사용 N 개」만으로는 이 호출이
  //   레인마다 몇 번 더 도는지 읽을 수 없고, 그것이 사용자가 예산을 정할 때 필요한 유일한 수다.
  //   「every lane」이 참인 이유는 재개가 서수를 실행 전체에서 하나로 맞추기 때문이다(`resumeStarts`).
  resume_attempts_reused: 'This run continues the run named {source}: the {reused} attempts it sealed were read, not run again, so every lane of this call starts at attempt {startOrdinal} and has {fresh} of this budget left to spend',
  // ★★ HEAD 기준 고지(WS5 태스크 6). 본문의 `baseline` 행과 **같은 사실**을 한 문장으로 적는다 —
  //   패치를 적용할지 정하는 사람은 본문을 파싱하기 전에 이것을 읽는다. 문장이 흐리면 안 되는
  //   지점은 하나다: 이 실행의 기준점은 사용자의 HEAD 가 아니라 미커밋 작업을 이미 담은 스냅샷이고,
  //   그래서 패치는 그 위에 얹힌다(그 파일들이 다시 바뀌면 얹히지 않는다).
  baseline_included_uncommitted_changes: 'This repository had {count} uncommitted files when the run started, so the run took its baseline from a snapshot that already contains them rather than from the HEAD commit; the patch is written against that snapshot, and the baseline row of the result body names those files',
  notices_folded: '{dropped} more notices were folded away',
  stage_authority_revoked: 'The {stage} step did not finish before the run was halted, so its result authority was revoked',
  learning_record_incomplete: 'The learning record for this run could not be completed',

  // 패치 범위(src/patch-scope.mjs) — `scope.reasons[].detail` 과 그 회복.
  // ★ 이 문장들은 봉투의 **본문**을 타고 나간다(WS2 Task 11 이 `scope.reasons` 를 실제로 싣기
  //   시작했다). 그래서 생산자가 아니라 여기 정본에 산다 — 같은 규칙이 두 문장으로 갈리면
  //   읽는 쪽은 두 위험이라고 읽는다.
  scope_sensitive_segment: 'The path segment {segment} is a place where commands run after the patch is applied',
  scope_short_name_segment: 'The segment {segment} has the shape of a Windows 8.3 short name, so it can expand to a different long name in the repository the patch is applied to',
  scope_sensitive_file: '{name} is a configuration file that tools read on their own',
  scope_symlink_unreadable: 'This entry is a symbolic link whose target could not be read, so where it points cannot be checked',
  scope_symlink_target_empty: 'The symbolic link target is empty',
  scope_symlink_target_absolute: 'The symbolic link target is an absolute path: {target}',
  scope_symlink_target_worktree_root: 'The symbolic link target is the worktree root itself: {target}',
  scope_symlink_target_outside: 'The symbolic link target points outside the worktree: {target}',
  scope_symlink_target_git_internals: 'The symbolic link target points inside the repository internals (.git): {target}',
  scope_package_baseline_missing: 'Without a baseline the scripts block of package.json could not be checked for changes',
  scope_package_unreadable: 'This package.json could not be read as JSON, so its scripts block could not be compared',
  scope_package_baseline_unreadable: 'The baseline package.json could not be read as JSON, so the scripts block could not be compared',
  scope_package_scripts_changed: 'The scripts block changed: {keys}; the commands there run during a later install or run, not while the patch is applied',
  scope_reasons_omitted: '{omitted} more scope reasons were left out of the list',
  // 허용목록(WS5 태스크 2). 사유가 아니라 **호출의 설정**에 대한 알림이라 실행 알림 채널로 나간다 —
  // 생산자는 `src/engine.mjs` 이고, 사실을 내는 곳은 `patch-scope.mjs refusedScopeAllow` 와
  // `scope-allowlist.mjs unionScopeAllow` 다. 문장은 계약의 어휘를 그대로 쓴다:
  // `contract/project-config.schema.json` 의 `scope.allow` 가 "Security hard-list paths … are
  // ignored even if listed" 라고 이미 적었고, 같은 사실을 두 문장으로 적으면 둘이 갈린다.
  scope_allow_hard_list_ignored: 'These scope allowlist entries name paths on the security hard list, so they were ignored and what they cover still needs a person to look: {entries}',
  scope_allow_entries_dropped: 'The scope allowlist takes at most {kept} entries of at most {chars} characters each, so {dropped} of the entries given were not used',

  // 상태 루트 · 락
  config_lock_left_behind: 'A settings lock was left behind: {reason}',
  journal_lock_left_behind: 'A journal lock was left behind: {reason}',
  apply_journal_record_incomplete: 'The patch was applied and verified, but its run journal note could not be recorded: {reason}',
  posteriors_lock_left_behind: 'A learning lock was left behind: {reason}',
  state_schema_newer: 'The shared state file {file} declares schemaVersion {version}, newer than the schemaVersion {supported} this server implements, so the whole file was treated as opaque and left unchanged',
  lock_handle_close_failed: 'A lock file handle could not be closed, which leaks a descriptor: {detail}',
  // 해제 실패 셋. 봉투의 `reasonCode` 가 되지 않고 `releaseReason` 을 거쳐 위 세 `*_lock_left_behind`
  // 알림의 `{reason}` 으로 들어간다 — 그래서 reason code 가 아니라 알림 문구다.
  lock_file_unverifiable: 'The lock file could not be read, so it was left in place: {detail}',
  lock_file_taken_over: 'The lock file is not the one this process wrote, so another holder took it over and it was left alone',
  lock_file_unremovable: 'The lock file could not be removed, so the next writer waits for it to go stale: {detail}',

  // 학습 상태
  posteriors_corrupt_set_aside: 'The corrupt learning state was set aside as {path} and learning restarts from empty: {reason}',
  posteriors_corrupt_preserved: 'The corrupt learning state is preserved as {path} and learning restarts from empty: {reason}',
  posteriors_unreadable_discarded: 'The unreadable learning state was discarded: {reason}',
  posterior_out_of_finite_range: '{name} was not updated because the new value fell outside the allowed range',
  posterior_floor_clamped: '{name} was held at its floor {floor} instead of {base} plus {step}, so learning cannot push it lower',

  // 자식 프로세스 환경
  path_shrink_left_nothing: 'PATH was {chars} characters and every one of its {count} entries was filtered out, so the original was passed through instead of an empty PATH',
  path_shrunk: 'PATH was shortened from {before} to {chars} characters by dropping {duplicates} duplicate entries and {missing} unusable entries, because a value over {limit} characters is seen as empty by the Windows command processor',
  path_still_over_limit: 'PATH is still {chars} characters after cleanup and was left intact, because truncating it silently loses the tools in the trailing directories',

  // 벤더 경계
  claude_windows_no_os_sandbox: 'On native Windows the claude CLI runs without an OS sandbox and its allowed-tools list does not restrict command execution, so shell and network access are effectively unrestricted for this run; the only real isolation is the disposable worktree',
  codex_tool_set_not_applied: 'The codex CLI has no flag that narrows its tool set, so the requested tools ({tools}) were not applied and the only boundary is the sandbox file scope plus the disposable worktree',
  provider_stream_drift: 'The {vendor} event stream carried {unknown} unknown and {unparsable} unparsable records',
  // ★ 불변식 4 의 자리다: 벤더의 수치가 사용자에게 닿는 길은 **라벨된 알림** 하나뿐이고, 이 문장이
  //   그 라벨이다. 두 수는 벤더가 보낸 것이고 우리가 계산한 것이 아니다 — 문장이 그것을 말한다.
  // ★★ (최종 폴리시, 라이브 캡처 2026-08-25) 단위는 이제 `src/providers/claude-stream.mjs`
  //   `rateLimitFacts` 가 여기 오기 전에 접는다: 0..1 분수로 실측된 utilization 은 "N percent"
  //   (로케일 없는 반올림)로, epoch 초로 읽히는 resetsAt 은 UTC ISO 순간으로. 창 밖의 값은 그
  //   함수가 원값을 정직한 꼬리(척도 미상)나 `unknown` 으로 그대로 낸다 — fail-safe, 안 지웠다.
  provider_rate_limit_reported: 'The {vendor} CLI reported its own account limit while this run was working: a utilization of {utilization}, and a reset point of {resetsAt}',

  // 테스트 실행
  test_file_absent_from_worktree: '{path} is in the project but not in the worktree, because git does not track it; if that file affects the run, this run is not the same as the project',
  test_ran_with_user_privileges: 'This suite ran with your user privileges and could read your whole home directory, credential files included; this runner has no way to prevent that',
  test_command_bare_name_unresolved: 'The test command calls {path} in the worktree root by the bare name {token}, which does not resolve because this runner removes the working directory from executable lookup; write it with a path separator instead',
  test_command_spawn_failed: 'The test command could not be started: {detail}',
  test_background_process_lingering: 'The suite finished but a background process still holds its output pipe, so the exit code is the suite\'s own; that process keeps running inside the worktree and this runner has no way to reclaim it',
  test_output_pipe_unclosed: 'The output pipe stayed open after the test was cut off, so this runner left without waiting; a process may still be running inside the worktree',
  // ★ 의존성 부재는 "테스트가 실패했다" 가 아니다. 이 러너는 워크트리에 의존성을 설치하지도
  //   링크하지도 않으므로(설계상), 그 대가를 결과가 직접 말한다. 두 문장으로 나눈 이유는
  //   `package.json` 프로젝트만 `node_modules` 라는 구체적인 자리를 가리킬 수 있기 때문이다.
  test_node_modules_absent: 'The worktree has no node_modules, so the dependencies could not be found; this runner neither installs nor links dependencies',
  test_dependencies_missing: 'The run failed because it could not find its dependencies; this runner neither installs nor links dependencies',
  // ★ 태스크 4 의 `project_config_keys_not_honored` 가 있던 자리다. WS4a 태스크 7 이 그 네 키를
  //   전부 소비하면서 그 문구는 생산자를 잃었고, 생산자 없는 문구는 다음 사람에게 「이 키는 안
  //   걸린다」는 거짓을 말하므로 함께 걷었다. (최종 수정 파동 정정: 「전부 소비」는 `dotnet-trx`
  //   에서 반쪽이었다 — 스키마가 그 리포터에도 `resultsPath` 를 **요구**했는데 런타임은
  //   `junit-xml` 갈래에서만 그 값을 읽고 trx 는 서버가 만든 경로를 자식에게 넘긴다. 요구를
  //   걷어 두 문장이 같아졌다.)
  //
  // ★ 남은 한 갈래에는 문장이 필요하다: 사용자가 컨트롤러가 **주입해야** 하는 리포터
  //   (`node-events`·`pytest-events`·`dotnet-trx`)를 적었는데 유도된 명령이 그것을 낼 수 없는
  //   경우다. 거부는 과하다(설정은 유효하고, 사용자가 도구를 바꾸는 중일 수 있다). 다른 어댑터로
  //   조용히 대체하는 것은 더 나쁘다 — 사용자가 고른 것이 아닌 증거가 그 이름으로 나간다. 그래서
  //   어댑터를 아예 끄고, 무엇이 왜 안 걸렸는지를 한 줄로 말한다.
  project_config_reporter_unavailable: 'The project configuration requires the {reporter} reporter, but the derived test command cannot produce that evidence, so this run carries no machine evidence at all',
  // ★ 의존성 제공은 **옵트인이 켜졌을 때만** 도는 유일한 설치 동작이다(로드맵 §3.6). 봉투가 그
  //   사실을 한 번 말하지 않으면, 워크트리 안에 `node_modules` 가 생긴 이유도 패키지 캐시가
  //   어디에 쌓이는지도 사용자가 알 길이 없다 — §5.5 는 「stateRoot 밖에 쓰지 않는다」를 봉투가
  //   말할 것을 요구하고, 이 문장이 그 자리다. 캐시 경로를 싣는 이유가 그것이다: 전역 캐시를
  //   쓰지 않는다는 주장은 실제 경로를 대야 검증할 수 있다.
  deps_provisioned: 'Dependencies were installed into the worktree from the baseline {lockfile} with lifecycle scripts disabled; the package cache for this run is {cache}, so nothing was written outside the state root',
  // lease 해제는 이미 성공한 설치의 뒤정리다. 실패를 재설치 사유로 바꾸지 않되, 활성 상태가
  // 남아 retention이 보수적으로 보존할 수 있다는 사실은 성공 봉투가 말해야 한다.
  deps_cache_lease_release_failed: 'The package cache lease could not be released; the cache was left in place for a later retention sweep',

  // ── 크레딧 전 예측(WS4b §0-PF) — 생산자는 `src/preflight.mjs` 의 순수 판정 넷이다 ──────
  // ★★ 넷 다 **막지 않는다.** preflight 는 크레딧을 쓰기 전에 아는 사실을 말하는 자리이고, 그
  //   사실 중 어느 것도 「이 실행을 하면 안 된다」가 아니다 — 예산은 사용자의 것이다. 그래서
  //   사유 코드가 아니라 알림이고, 실행은 이 문장들을 달고 그대로 계속된다.
  // ★ `evidence` 문장이 「증명에 닿을 수 없다」이지 「테스트가 없다」가 아닌 이유: 어댑터 없음은
  //   보통 일을 막지 않고 증명만 막는다(`src/test-evidence.mjs:722-725`). 그 구별을 흐리면
  //   배포 문서의 부정 게이트(`test/packaging.test.mjs:1721`)가 금지한 종류의 거짓 문장이 된다.
  preflight_evidence_unreachable: 'Before this run spent anything it was already certain that it cannot produce verified regression evidence ({reason}), so its confidence stops at unverified',
  preflight_adapter_not_derived: 'Test ecosystems were found in this project ({ecosystems}) but the frozen test plan derived no trusted-evidence adapter, so this run collects no machine evidence; naming a reporter in .bom-orch.json is the only way to change that',
  // ★ 실측 산술 하나가 이 문장의 이유다: 기본값에서 6 x 600,000 = 3,600,000 이고 엔진의 절대
  //   상한은 3,300,000 이다. 오늘 사용자는 그것을 `test_deadline_expired` 로 뒤늦게 안다.
  preflight_proof_time_exceeds_wait: 'Proving this change can run the whole suite up to {multiplier} times in series, which is {worstCaseMs} ms at the {timeoutMs} ms per-suite timeout and longer than the {waitMs} ms this call may wait, so the deadline can arrive before the proof does',
  preflight_codex_prompt_over_budget: 'The task text projects a codex prompt of {projectedChars} characters, over the {budgetChars} character command-line budget measured for that CLI, so a codex step in this run can fail to start',

  // 모델 카탈로그 · 설정
  models_from_cache: 'This model list comes from cache; pass refresh:true to probe the vendor CLIs',
  model_catalog_empty: 'The model list for {vendors} is empty; call orch_models first to fill the catalog, and vendors without a list skip the effort check',
  model_not_in_catalog: 'The model {model} is not in the discovered {vendor} list; check the spelling, and if it is a new model it is used as given',

  // 학습 통계 · 정정
  stats_axis_single_only: 'This axis only grows a second arm on runs called with allow_single, so before that the default is used even as observations pile up',
  stats_placement_shared_cell: 'Observations from single-vendor runs land in this cell too, so who goes first and who goes alone are counted together',
  stats_tier_arms_identical: 'Both arms of this axis are the same run until this vendor has different strong and fast models, so nothing is learned yet',
  stats_rows_folded: '({dropped} more rows were folded away; the number of cells that failed is reset.failed in the body)',
  stats_recent_reduced: 'The recent-run list was cut from {asked} to {kept}',
  stats_arm_posteriors_dropped: 'The per-arm learning parameters were dropped',
  stats_cells_reduced: 'The cell list was cut from {asked} to {kept}',
  stats_cleared_cells_reduced: 'The cleared-cell list was cut from {asked} to {kept}',
  stats_content_limit_reductions: 'The {limit} character response limit forced these reductions: {detail}',
  stats_cell_clear_failed: 'The cell {cell} could not be cleared: {reason}',
  // ★ 파일명이 **앞**, 경로가 **뒤**다 — 알림은 400자에서 클립되고(NOTICE_CHARS), 절대경로 둘이
  //   앞에 서면 macOS 러너(/private/var/folders/… 급 tmpdir)에서 뒤의 파일명들이 잘려 나간다
  //   (실측 CI: tools.test.mjs 의 세대-스냅샷 단언이 macos 에서만 붉었다). 회복 절차의 핵심은
  //   「어느 파일을 어떤 순서로 되돌리는가」이므로 그 부분이 어떤 호스트에서도 클립을 살아남는다.
  learning_reset_snapshot: 'Pre-reset snapshots were written: to undo this reset, stop every server using this state root, copy {generationsFile} back first, then copy {posteriorsFile} back and restart; the files sit at {path} beside {generationPath}',
  learning_posteriors_unreadable: 'The learning state could not be read: {reason}',
  learning_generations_unreadable: 'The learning generations could not be read: {reason}',
  // ★ 자기 문장을 겹쳐 적지 않는다(최종 리뷰 M3). `{reason}` 으로 들어오는 값은 리더가 이미
  //   렌더한 문장("The run journal could not be read: …")이라, 이 문구가 같은 말로 시작하면 한
  //   알림이 그 문장을 두 번 말하고 35자가 200자 상한을 먹어 긴 detail 의 파일명이 잘려 나간다.
  run_journal_unreadable: 'Run grades are missing from this answer: {reason}',
  // ★ 이것은 **실패가 아니다**(스펙 §1: notice 급이면 코드가 필요 없다). 로그를 못 읽었다고
  //   재구성을 거절하면 이 도구가 존재하는 이유 — 남은 것을 최대한 되찾는 것 — 을 배신한다.
  //   경로를 싣는 이유는 다음 수가 그 파일을 직접 보는 것이기 때문이다.
  status_log_unreadable: 'The run log at {path} could not be read, so this reconstruction carries no log tail',
  artifact_inspection_incomplete: '{count} runs were not inspected for artifact state, because at most {limit} references are opened at a time',
  reward_artifact_state_unchecked: 'The artifact state could not be inspected; the correction itself was recorded',
  reward_artifact_refs_omitted: '{count} artifact references were not inspected, because at most {limit} are opened at a time',
  reward_axes_missing_legacy_applied: 'This run record has no rewardable axes, so the new grade was written only to the axes it had already been applied to',
  reward_axes_missing_no_cell: 'This run record has no rewardable axes and no recorded contribution, so there is no cell to write the new grade to',
  reward_unknown_axes_skipped: 'These axes are not known now and were skipped: {detail}',
  reward_axis_arm_missing: 'The {axis} axis was skipped because the arm this run used is not in the journal',
  reward_note_cleared: 'No note was given, so the previous note ({note}) was cleared; pass the same sentence again to keep it',

  // 봉투 · 로그(WS2 §5 가 생산자를 붙인다)
  // ★ `{reason}` 을 인자로 받는 이유: 로그가 없는 경우는 하나가 아니다(`src/diag.mjs` 의 닫힌
  //   집합 `invalid_target | open_failed | write_failed`). 원인 하나를 문장에 박아 두면 나머지
  //   두 경우에 문구가 거짓이 된다 — 읽는 사람은 상태 루트를 고치러 가고 정작 꽉 찬 디스크는 못 본다.
  // ★ 강등은 조용하면 안 된다. 문구를 만들지 못한 것은 **생산자 결함**이고, 알림이 없으면 그 결함은
  //   평범한 실패 문장으로 위장한 채 영영 보이지 않는다. 어느 코드에서 났는지를 문장이 말한다.
  envelope_render_degraded: 'The failure text for {reasonCode} could not be rendered; a generic description was used',
  log_unavailable: 'The run log could not be written ({reason}); the run itself was not affected',
  // ★ 방향이 곧 사실이다. diag 의 상한은 **머리를 남기고 뒤를 버린다**(스펙 §5) — 옛 문구의
  //   "older lines were dropped" 는 반대였고, 그러면 읽는 사람은 없는 앞부분을 찾아 로그를 뒤진다.
  log_truncated: 'The run log reached its {limit} byte cap and later lines were not written',
  ladder_rung_failed: 'The {rung} form of this result could not be built, so a fixed summary was sent instead',
});

/**
 * 코드마다 골든·문서가 쓰는 표본 인자. **자리표시자가 있는 코드만** 실린다
 * (양방향을 `test/reason-text.test.mjs` 가 잰다 — 남거나 빠지면 실패).
 *
 * ★ 값은 진짜처럼 보이지만 **아무 실제 값도 아니다**. 골든 픽스처는 커밋에 남는 바이트라
 *   실제 경로·runId 를 넣으면 그 커밋이 그 호스트의 사실을 기록해 버린다.
 */
export const SAMPLE_PARAMS = deepFreeze({
  apply_applied_unverified: { path: '<project>', detail: 'the index could not be copied for the post-apply check' },
  apply_artifact_mismatch: { path: '<stateRoot>/patches/run-0000000000000-aaaaaaaa.patch' },
  apply_baseline_moved: { path: '<project>' },
  apply_baseline_pruned: { path: '<project>' },
  apply_git_failed: { detail: 'fatal: not a git repository' },
  apply_head_moved: { path: '<project>' },
  apply_patch_empty: { path: '<project>' },
  apply_patch_missing: { runId: 'run-0000000000000-aaaaaaaa' },
  apply_patch_unreadable: { path: '<stateRoot>/patches/run-0000000000000-aaaaaaaa.patch' },
  apply_project_unknown: { runId: 'run-0000000000000-aaaaaaaa' },
  apply_project_unusable: { path: '<project>' },
  apply_run_not_found: { runId: 'run-0000000000000-aaaaaaaa' },
  apply_rollback_incomplete: {
    path: '<project>', count: 2, backup: '<stateRoot>/scratch/apply-aaaaaa/backup',
    detail: '2 paths differ from or could not be safely compared with the pre-write snapshot: src/a.txt, src/b.txt',
  },
  apply_three_way_conflicted: { path: '<project>' },
  apply_verification_failed: { path: '<project>', detail: 'the tree this merge produced is not the tree the temporary index predicted' },
  apply_worktree_dirty: { count: 3, path: '<project>' },
  apply_write_blocked: { path: '<project>' },
  artifact_attempt_too_large: { limit: 4_194_304 },
  artifact_base_directory_not_private: { path: '<stateRoot>/runs' },
  artifact_collision_inspection_failed: { path: '<stateRoot>/runs' },
  artifact_init_lock_collision: { runId: 'run-0000000000000-aaaaaaaa' },
  artifact_initial_manifest_too_large: { limit: 4_194_304 },
  artifact_manifest_event_path_invalid: { path: '<stateRoot>/runs/other' },
  artifact_namespace_collision: { runId: 'run-0000000000000-aaaaaaaa' },
  artifact_path_budget_exceeded: { limit: 5_000 },
  artifact_permission_verification_failed: { path: '<stateRoot>/runs/attempt.json' },
  artifact_root_not_canonical: { path: '<stateRoot>' },
  artifact_unowned_final_collision: { path: '<stateRoot>/runs/attempt.json' },
  auth_login_required: { vendor: 'claude' },
  config_argument_above_maximum: { name: 'budget', value: 40, max: 10 },
  config_argument_below_minimum: { name: 'wait_ms', value: -1, min: 0 },
  config_argument_item_type_invalid: { name: 'files', index: 2, expected: 'a string' },
  config_argument_misspelled: { name: 'projct', suggestion: 'project', allowed: 'task, project, budget' },
  config_argument_not_finite: { name: 'budget', value: 'NaN' },
  config_argument_not_in_enum: { name: 'isolation', value: 'none', allowed: 'worktree' },
  config_argument_not_integer: { name: 'budget', value: 2.5 },
  config_argument_required_missing: { name: 'project' },
  config_argument_type_invalid: { name: 'task', expected: 'a string' },
  config_argument_unknown: { name: 'depth', allowed: 'task, project, budget' },
  config_arguments_not_accepted: { name: 'depth' },
  config_budget_invalid: { budget: 0, limit: 10 },
  config_candidate_count_invalid: { count: 3 },
  config_change_scope_missing: { vendors: 'claude, codex', tiers: 'strong, fast' },
  config_effort_unsupported: { model: 'claude-x-strong', effort: 'ultra', efforts: 'low, medium, high' },
  config_invalid: { file: '.bom-orch.json', detail: 'tests.command must have at least 1 item' },
  config_isolation_unsupported: { isolation: 'none' },
  config_project_path_invalid: { path: 'relative/path' },
  config_provider_unknown: { role: 'worker', vendor: 'acme', vendors: 'claude, codex' },
  config_role_unknown: { role: 'reviewer' },
  config_schema_newer: { file: '.bom-orch.json', version: 2, supported: 1 },
  config_settings_effort_unsupported: { vendor: 'codex', tier: 'fast', model: 'gpt-x-small', effort: 'ultra', efforts: 'low, medium' },
  config_settings_key_unknown: { vendor: 'claude', key: 'quick', keys: 'strong, strongEffort, fast, fastEffort' },
  config_settings_lock_unavailable: { detail: 'the lock was still held when the wait budget ran out' },
  config_settings_read_failed: { detail: 'EACCES: permission denied' },
  config_settings_section_invalid: { vendor: 'claude' },
  config_settings_value_not_string: { vendor: 'claude', key: 'strong' },
  config_settings_value_unsafe: { vendor: 'claude', key: 'strong' },
  config_settings_vendor_unknown: { vendor: 'acme', vendors: 'claude, codex' },
  config_settings_write_failed: { detail: 'EACCES: permission denied' },
  // ★ 표본 이름은 **실재하지 않는** 도구여야 한다. 이 함정은 이제 **두 번** 터졌다: `orch_apply`
  //   였는데 WS5 태스크 7 이 그것을 실재로 만들었고, 그 자리를 물려받은 `orch_reset` 도 WS7 이
  //   실재로 만들었다 — 골든이 "… is not a tool this server serves" 라고 적은 채 그 도구를
  //   서빙하게 된다(리서치 메모 §C.1 이 미리 적어 둔 함정이다).
  //   그래서 이번에는 **예약 목록에서 고르지 않는다** — 예약된 이름은 언젠가 실재가 되고, 그때
  //   같은 자기모순이 세 번째로 돌아온다. `orch_cancel` 은 WS0 계약이 여덟으로 못박은 도구
  //   집합 **밖**이고(취소는 `orch_status` 가 서빙한다), 그래서 호출자가 실제로 틀리는 이름
  //   이면서 실재가 될 자리가 없다. `test/tool-contract.test.mjs` 가 두 사실을 잰다.
  config_tool_unknown: { name: 'orch_cancel', tools: 'orch_models, orch_run, orch_config, orch_stats, orch_status, orch_apply, orch_reward, orch_reset' },
  config_uncommitted: { file: '.bom-orch.json' },
  config_unreadable: { file: '.bom-orch.json', detail: 'the repository could not say whether it exists (exit 128: fatal: not a git repository)' },
  config_wait_ms_invalid: { waitMs: -1 },
  deps_unavailable: { file: '.bom-orch.json', detail: 'the baseline commit carries no package-lock.json or npm-shrinkwrap.json' },
  evidence_artifact_too_large: { limit: 4_194_304 },
  git_argument_count_exceeded: { limit: 4_096 },
  git_arguments_invalid: { detail: 'its arguments are not a plain array of strings' },
  git_environment_value_invalid: { name: 'GIT_INDEX_FILE' },
  git_global_option_refused: { option: '--upload-pack=evil' },
  git_project_root_not_canonical: { path: '<project>' },
  git_repository_missing: { path: '<project>' },
  git_version_below_floor: { version: '2.39.0', floor: '2.45.1' },
  judge_provider_failure: { vendor: 'codex' },
  learning_applied_grade_unknown: { grade: 'partial' },
  learning_cell_key_duplicated: { cell: 'analysis::mix' },
  learning_generations_read_failed: { detail: 'EACCES: permission denied' },
  learning_generations_snapshot_failed: { detail: 'ENOSPC: no space left on device' },
  learning_journal_read_failed: { detail: 'EACCES: permission denied' },
  learning_journal_record_unserializable: { detail: 'Converting circular structure to JSON' },
  learning_journal_row_unbuildable: { detail: 'Converting circular structure to JSON' },
  learning_journal_row_write_failed: { detail: 'ENOSPC: no space left on device' },
  learning_lock_unavailable: { detail: 'the lock was still held when the wait budget ran out' },
  learning_mutation_failed: { detail: 'ENOSPC: no space left on device' },
  learning_pending_work_invalid: { detail: 'the work is missing its operation identity' },
  learning_pending_work_read_failed: { detail: 'EACCES: permission denied' },
  learning_pending_work_unclearable: { detail: 'EPERM: operation not permitted' },
  learning_policy_version_unknown: { version: 7 },
  learning_posteriors_not_json: { detail: 'Unexpected end of JSON input' },
  learning_posteriors_quarantine_failed: { path: 'posteriors.corrupt.json', detail: 'EPERM: operation not permitted' },
  learning_posteriors_read_failed: { detail: 'EACCES: permission denied' },
  learning_posteriors_reset_failed: { detail: 'ENOSPC: no space left on device' },
  learning_run_not_found: { runId: 'run-0000000000000-aaaaaaaa' },
  learning_run_task_class_missing: { runId: 'run-0000000000000-aaaaaaaa' },
  learning_scope_read_failed: { taskClass: 'analysis', detail: 'EACCES: permission denied' },
  learning_snapshot_failed: { detail: 'ENOSPC: no space left on device' },
  learning_work_publish_failed: { name: 'posteriors.json', detail: 'EPERM: operation not permitted' },
  learning_work_unserializable: { name: 'posteriors.json', detail: 'Converting circular structure to JSON' },
  learning_work_write_failed: { name: 'posteriors.json', detail: 'ENOSPC: no space left on device' },
  learning_write_boundary_failed: { name: 'after-pending', detail: 'EPERM: operation not permitted' },
  preflight_gateway_env_unsupported: { names: 'CLAUDE_CODE_USE_BEDROCK' },
  preflight_provider_unavailable: { role: 'verifier', vendor: 'codex' },
  provider_below_security_floor: { vendor: 'claude', version: '1.0.0', floor: '2.0.0' },
  provider_cli_not_found: { vendor: 'codex' },
  provider_cli_shim_only: { vendor: 'claude' },
  provider_call_halted: { vendor: 'claude' },
  provider_deadline_exceeded: { vendor: 'claude' },
  provider_error_unclassified: { vendor: 'codex' },
  provider_exit_nonzero: { vendor: 'codex' },
  provider_no_terminal_record: { vendor: 'claude' },
  provider_output_truncated: { vendor: 'claude' },
  provider_rate_limited: { vendor: 'claude' },
  provider_reported_failure: { vendor: 'codex' },
  provider_signal_killed: { vendor: 'codex' },
  provider_spawn_denied: { vendor: 'codex', path: '<home>/.local/bin/codex' },
  provider_spawn_failed: { vendor: 'codex' },
  provider_stream_unparsable: { vendor: 'codex' },
  provider_turn_failed: { vendor: 'codex' },
  // 재개가 지목한 실행의 이름. 넷 다 같은 자리에 같은 값을 받는다 — 거부의 주어는 그 실행이다.
  resume_baseline_mismatch: { runId: 'run-0000000000000-aaaaaaaa' },
  resume_environment_mismatch: { runId: 'run-0000000000000-aaaaaaaa' },
  resume_manifest_unreadable: { runId: 'run-0000000000000-aaaaaaaa' },
  resume_run_not_found: { runId: 'run-0000000000000-aaaaaaaa' },
  // ★ 엔진의 `MAX_WAIT_MS` 와 같은 수다(WS3 §0-W1 이 3,600,000 → 3,300,000 으로 내렸다).
  //   여기서 engine 을 import 하면 순환이 생기므로(engine 이 이 파일을 부른다) 값을 적고,
  //   `test/guards/wait-budget-inequality.test.mjs` 가 두 수가 갈리는 순간 붉어진다.
  run_deadline_exceeded: { waitMs: 3_300_000 },
  run_nested_invocation: { runId: 'run-0000000000000-aaaaaaaa' },
  run_tool_failed: { detail: 'Cannot read properties of undefined' },
  run_tool_handler_missing: { name: 'orch_run' },
  state_directory_create_failed: { detail: 'EACCES: permission denied' },
  state_lock_create_failed: { detail: 'EACCES: permission denied' },
  state_lock_timeout: { code: 'EEXIST' },
  state_lock_token_write_failed: { detail: 'ENOSPC: no space left on device' },
  state_lock_work_failed: { detail: 'ENOSPC: no space left on device' },
  state_schema_newer: { file: 'posteriors.json', version: 2, supported: 1 },
  status_run_not_found: { runId: 'run-0000000000000-aaaaaaaa' },
  test_delta_duplicate_path: { path: 'test/example.test.mjs' },
  test_delta_ignored_path: { path: 'test/generated/example.test.mjs' },
  test_frozen_execution_failed: { detail: 'EPERM: operation not permitted' },
  test_pinned_definition_drift: { file: 'package.json', key: 'scripts.test' },
  verifier_issue_limit_exceeded: { limit: 100 },
  verifier_verdict_invalid: { detail: 'verdict was not an object' },
  worktree_add_failed: { detail: "fatal: '<stateRoot>/worktrees/<id>' already exists" },
  worktree_creation_crashed: { detail: 'ENOSPC: no space left on device' },
  worktree_delta_listing_failed: { detail: 'fatal: bad object' },
  worktree_delta_mode_inconsistent: { path: 'src/example.mjs' },
  worktree_delta_path_unexpected: { path: 'src/Example.mjs' },
  worktree_delta_type_change: { path: 'src/example.mjs' },
  worktree_delta_unsafe_mode: { path: 'src/link' },
  worktree_diff_output_missing: { path: '<stateRoot>/scratch/diff-000000/patch' },
  worktree_final_files_failed: { detail: 'fatal: bad revision' },
  worktree_final_patch_failed: { detail: 'fatal: bad revision' },
  worktree_final_patch_unreadable: { detail: 'EACCES: permission denied' },
  worktree_head_unreadable: { detail: 'fatal: not a git repository' },
  worktree_patch_apply_failed: { detail: 'error: patch does not apply' },
  worktree_patch_preflight_delta_unreadable: { detail: 'fatal: bad object' },
  worktree_patch_preflight_index_failed: { detail: 'fatal: unable to read tree' },
  worktree_patch_preflight_rejected: { detail: 'error: patch does not apply' },
  worktree_patch_preflight_tree_failed: { detail: 'fatal: unable to write tree' },
  worktree_patch_processing_failed: { detail: 'EBUSY: resource busy or locked' },
  worktree_path_duplicate: { path: 'src/example.mjs' },
  worktree_path_in_use: { path: '<stateRoot>/worktrees/<id>' },
  worktree_path_list_invalid: { limit: 4_000 },
  worktree_path_not_canonical: { path: '<project>' },
  worktree_path_outside_state_root: { path: '<stateRoot>/worktrees/<id>' },
  worktree_path_unsafe: { path: '../outside/example.mjs' },
  worktree_path_windows_ambiguous: { path: 'src/nul' },
  worktree_revision_not_commit: { revision: '0'.repeat(40), detail: 'fatal: bad object' },
  worktree_revision_patch_failed: { detail: 'fatal: bad object' },
  worktree_revision_patch_unreadable: { detail: 'EACCES: permission denied' },
  worktree_revision_tree_unresolved: { detail: 'fatal: bad object' },
  worktree_scratch_failed: { detail: 'EPERM: operation not permitted' },
  worktree_snapshot_commit_failed: { detail: 'error: Author identity unknown' },
  worktree_stage_failed: { detail: 'error: unable to index file' },
  worktree_stale_registration_unreclaimed: { path: '<stateRoot>/worktrees/<id>', detail: 'fatal: validation failed' },
  worktree_state_root_inside_project: { path: '<project>/.bom-orch' },
  worktree_status_unreadable: { detail: 'fatal: not a git repository' },
  worktree_step_diff_failed: { detail: 'fatal: bad revision' },
  worktree_step_diff_unreadable: { detail: 'EACCES: permission denied' },
  worktree_step_files_failed: { detail: 'fatal: bad revision' },
  worktree_transplant_apply_failed: { detail: 'error: patch failed' },
  worktree_transplant_diff_failed: { detail: 'fatal: bad revision' },
  worktree_transplant_files_failed: { detail: 'fatal: bad revision' },
  worktree_transplant_index_failed: { detail: 'fatal: not a tree object' },
  worktree_transplant_stage_failed: { detail: 'error: unable to index file' },
});

/**
 * `MAX_PARAM_CHARS` **코드 포인트**로 자른다. 코드 유닛(`slice`)으로 자르면 경계에 걸친 astral
 * 글자가 반쪽 서로게이트로 남고, 그 바이트는 봉투를 읽는 쪽에서 깨진 글자 하나가 된다.
 *
 * ★ 꼬리 판정(`endsWithLoneSurrogate`)은 `src/util/strings.mjs` 것 하나를 쓴다. 코드 포인트로
 *   잘랐으므로 정상적인 쌍은 한 원소로 남는다 — 여기 걸리는 것은 **들어온 값 자체가** 깨져
 *   있던 경우다.
 */
function clipToLimit(text) {
  const points = [...text];
  if (points.length <= MAX_PARAM_CHARS) return text;
  let head = points.slice(0, MAX_PARAM_CHARS).join('');
  while (head.length > 0 && endsWithLoneSurrogate(head)) head = head.slice(0, -1);
  return `${head}${CLIP_SUFFIX}`;
}

/**
 * 인자 값 하나 → 봉투에 실릴 문자열. `String` → 세척 → clip 순서다(머리말 참고).
 *
 * ★ `null` 과 `String()` 이 `[object Object]` 를 내는 값은 `undefined` 와 **같은 등급의 개발자
 *   오류**라 throw 다. 통과시키면 문장 속 값 자리에 "null" 이나 "[object Object]" 가 실려 나가고,
 *   그것은 값이 없다는 사실을 값처럼 보이게 만든다 — 테스트에서 터지는 것이 낫다.
 */
function paramText(value, where) {
  if (value === null) throw new TypeError(`${where}: param value is null`);
  const asText = String(value);
  if (asText === OPAQUE_OBJECT_TEXT) throw new TypeError(`${where}: param value has no printable text`);
  const redacted = redactor(asText);
  return clipToLimit(typeof redacted === 'string' ? redacted : asText);
}

/**
 * 템플릿 하나를 채운다. 빠진 인자·`undefined` 인자는 throw 다 — `where` 가 어느 문구인지 말한다.
 *
 * ★ `undefined` 를 "빠진 것" 과 같게 보는 이유: 호출부가 `params.path` 를 옵셔널 체이닝으로
 *   만들었을 때 조용히 `<missing>` 이나 `undefined` 가 봉투로 나가는 것이 가장 흔한 사고였다.
 */
function renderTemplate(template, params, where) {
  return template.replace(PLACEHOLDER, (_match, name) => {
    const value = params?.[name];
    if (value === undefined) throw new TypeError(`${where}: missing param {${name}}`);
    return paramText(value, `${where} {${name}}`);
  });
}

/**
 * 코드 하나를 문구로 만든다. `stopReason` 은 **넘기지 않는다** — 레지스트리 항목에서 온다
 * (한 코드가 두 조악값으로 나가는 자리를 없애는 것이 WS2 §2 의 절반이다).
 */
export function renderReason(code, params = {}) {
  const entry = reasonCodeEntry(code);
  if (entry === undefined) throw new TypeError(`unknown reason code: ${String(code)}`);
  const template = REASON_TEXT[code];
  if (template === undefined) throw new TypeError(`unknown reason code text: ${String(code)}`);
  return {
    reasonCode: entry.code,
    stopReason: entry.stopReason,
    error: renderTemplate(template.message, params, `${entry.code} message`),
    recovery: renderTemplate(template.recovery, params, `${entry.code} recovery`),
  };
}

/**
 * 렌더가 성립하지 않았을 때 `error` 자리에 실리는 문장. **자리표시자가 하나도 없다** — 이 문장이
 * 나가는 경우가 정확히 "인자가 없어 문구를 못 만든 경우" 라서, 여기에 `{...}` 가 있으면 같은 결함이
 * 한 층 더 깊은 곳에서 그대로 반복된다. 잃은 것은 문장뿐이고 `reasonCode` 는 여전히 정확하므로,
 * 문장이 그 사실을 말한다 — 읽는 쪽이 코드로 분기하는 것을 막지 않기 위해서다.
 */
export const RENDER_FALLBACK_MESSAGE = 'The failure could not be described because its details were missing; the reasonCode is still accurate';

/**
 * **절대 던지지 않는** `renderReason`. 봉투 생성자(`src/envelope.mjs failure()`)가 부르는 자리다.
 *
 * ★ 왜 이 함수가 따로 있는가. `renderReason` 이 빠진 인자에 던지는 것은 옳다 — 개발자 오류이고,
 *   봉투에 `{limit}` 가 실려 나가는 것보다 테스트에서 터지는 것이 낫다. 하지만 봉투를 **만들다**
 *   던지면 원래 실패가 통째로 사라지고 코드도 회복도 없는 다른 문장이 밖으로 나간다 — 실패를
 *   설명하려다 실패를 지우는 것이다. 그래서 이 자리에서는 **문구만** 강등하고 `reasonCode` 와
 *   `stopReason` 은 정확한 값 그대로 남긴다. 그 둘은 인자 없이도 알 수 있다.
 *   `degraded:true` 는 호출부가 알림(`NOTICE_TEXT.envelope_render_degraded`)을 붙이라는 신호다 —
 *   강등을 조용히 하면 생산자 결함이 평범한 실패로 위장한다.
 *
 * @returns {null|{reasonCode: string, stopReason: string, error: string, recovery: string, degraded?: true}}
 *   등재되지 않은 코드는 `null` 이다: 실을 것이 없다는 뜻이지 실패가 아니다(닫힌 어휘 — 오타는
 *   키 자체가 생기지 않는다).
 */
export function safeRender(code, params = {}) {
  if (reasonCodeEntry(code) === undefined) return null;
  try {
    return renderReason(code, params);
  } catch {
    // 세척 훅(`setRedactor`)이 던지는 경우도 여기로 온다 — 훅은 밖에서 꽂히므로 이 모듈이 통제하지 못한다.
    return {
      reasonCode: code,
      stopReason: stopReasonOf(code),
      error: RENDER_FALLBACK_MESSAGE,
      recovery: RECOVERY_GENERIC,
      degraded: true,
    };
  }
}

/** 알림 하나를 문구로 만든다. 실패가 아니므로 문자열 하나만 낸다. */
export function renderNotice(key, params = {}) {
  const template = NOTICE_TEXT[key];
  if (typeof template !== 'string') throw new TypeError(`unknown notice key: ${String(key)}`);
  return renderTemplate(template, params, `notice ${key}`);
}

/** `fail()` 의 `extra` 가 덮을 수 없는 다섯 키 — 봉투 셰이프의 계약이다. */
const FAIL_RESERVED_KEYS = Object.freeze(['ok', 'blocked', 'reasonCode', 'error', 'recovery']);

/**
 * 모듈 내부의 실패 봉투 — `util/errors.mjs blocked()` 의 코드 있는 판이다.
 *
 * 키 순서가 계약이다(`ok`·`blocked`·`reasonCode`·`error`·`recovery`, 그다음 사이트별 `extra`):
 * `contract/envelope.json` 의 `internalBlocked` 행과 `artifact-settlement.mjs` 의 두 검증기가
 * 이 다섯 키를 본다. `extra` 를 앞에 얹을 수 있게 두면 그 셰이프가 호출부마다 갈린다.
 */
export function fail(code, params = {}, extra = {}) {
  // 다섯 키를 `extra` 로 덮으면 봉투가 조용히 다른 셰이프가 된다(`ok:true` 인 실패, 코드와 다른
  // `reasonCode`, 정본을 우회한 `error`). 스프레드가 이기는 자리라 검사 없이는 아무 신호도 없다.
  const carried = extra ?? {}; // `...null` 은 합법이므로 검사 쪽에서만 없는 것으로 본다
  for (const key of FAIL_RESERVED_KEYS) {
    if (Object.hasOwn(carried, key)) throw new TypeError(`fail(): extra must not carry ${key}`);
  }
  const { reasonCode, error, recovery } = renderReason(code, params);
  return deepFreeze({ ok: false, blocked: true, reasonCode, error, recovery, ...extra });
}
