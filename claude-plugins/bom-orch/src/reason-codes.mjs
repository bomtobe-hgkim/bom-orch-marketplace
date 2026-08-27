/**
 * reason code 레지스트리 — 봉투·본문·저널에 실리는 "왜" 어휘의 유일한 정본.
 *
 * WS0(2026-08-16 v1.0 도구 계약 §2.3~2.4)이 만들고 WS2(§2)가 개명·확장했다. 두 층이다:
 *
 *   `STOP_REASONS`  실행이 끝난 이유의 **닫힌 조악 어휘**(13개). 봉투 최상위 `stopReason` 은
 *                   이 값만 낸다. 생산자는 이 값을 직접 고르지 않고 `stopReasonOf(reasonCode)` 로 얻는다.
 *   `REASON_CODES`  세부 원인. `<주체>_<사건>` snake_case. 봉투 `reasonCode` · `blockers[].reasonCode`
 *                   · `candidates[].reasonCode` · provider `describeError` 의 `reasonCode` 가 전부
 *                   여기서 온다. 항목마다 어느 조악 stopReason 에 속하는지가 적혀 있다.
 *
 * ★ 이 파일은 데이터다. 생산자는 `REASON.x` 를 import 해서 쓰고 문자열 리터럴을 쓰지 않는다
 *   (가드 `test/guards/reason-code-literals.test.mjs`(Task 3)). 문구(`error`·`recovery`)는 여기 없다 —
 *   `src/reason-text.mjs`(Task 2)가 정본이다. 이 모듈은 어휘만 안다. 두 파일은 아직 없다 —
 *   그 태스크가 만든다. 지금은 생산자가 옛 리터럴을 쓰고 이 레지스트리를 import 하지 않는다.
 *
 * ★ `legacy` 는 0 이다(WS2 §2.2-2). WS0 이 인벤토리로 등재한 92개의 형식 위반 이름을 주체표대로
 *   개명했고(형식은 맞지만 조악값 `provider_failed` 와 철자가 같던 한 건을 더해 93건), 옛 이름은
 *   레지스트리에서 **지웠다**. 디스크에 남은 옛 값은 `LEGACY_REASON_ALIASES`
 *   (옛→새)를 거쳐 `normalizeLegacyReasonCode()` 가 **읽기**에서만 올린다 — 쓰기는 항상 새 이름이다
 *   (불변식 9, WS2 §2.4). `legacy: false` 필드는 "1.0 시점에 legacy 0" 을 기계가 계속 재게 하려고 남겼다.
 *
 * ★ 주체 정의표(WS2 §2.2-1). **주체 = 복구하려면 상태를 바꿔야 하는 쪽.** "어디서 감지했나" 가 아니다 —
 *   그것으로 정하면 같은 결함이 매번 다른 주체로 갈린다(§0 결정표의 여덟 충돌).
 *
 *   | 주체 | 뜻 | 예 |
 *   | --- | --- | --- |
 *   | `provider` | 벤더 CLI 프로세스·스트림 자체 | `provider_spawn_failed` `provider_exit_nonzero` `provider_signal_killed` `provider_stream_unparsable` `provider_rate_limited` `provider_error_unclassified` |
 *   | `auth` | 벤더 로그인·자격 | `auth_login_required` |
 *   | `config` | 호출 인자·settings·역할 정의 — 사용자가 고친다 | `config_role_unknown` `config_allowed_tools_missing` `config_tool_set_missing` `config_tool_pattern_unsafe` `config_permission_mode_invalid` `config_argument_unsafe` `config_flag_banned` |
 *   | `git` / `worktree` | 사용자 저장소 git 명령 / 우리 worktree 등록 | `git_diff_failed` `worktree_handle_invalid` |
 *   | `artifact` / `state` | 실행 artifact 저장소 / 상태 루트·락 | `artifact_store_authority_lost` `state_lock_work_failed` |
 *   | `test` / `evidence` | 서버 소유 테스트 실행 / 그 결과의 봉인 | `test_command_unavailable` `evidence_seal_failed` |
 *   | `verifier` / `judge` / `lane` / `scope` / `run` | 교차검증 단계 / 심판 / 후보 레인 / 패치 범위 / 실행 전체 | `verifier_verdict_invalid` `judge_deadline` `lane_unverified` `scope_policy_failure` `run_cancelled` |
 *   | `learning` / `apply` / `resume` / `preflight` / `deps` | 학습 · 적용(WS5 태스크 7 이 관문 넷, 태스크 8 이 적용기 열) · 재개(WS3, 거부 넷) · 실행 전 검사 · 의존성(WS4a) | `apply_run_not_found` `apply_patch_missing` `apply_artifact_mismatch` `apply_baseline_pruned` `apply_three_way_conflicted` `apply_worktree_dirty` · `resume_run_not_found` `resume_manifest_unreadable` `resume_baseline_mismatch` `resume_environment_mismatch` |
 *   | `status` | 끝난 실행을 **되읽는** 경로(WS3 `orch_status`) — 고칠 상태는 실행 자체가 아니라 「어느 실행을 물었나」와 그 실행이 디스크에 남긴 것이다 | `status_run_not_found` `status_run_unreadable` |
 *
 *   `unknown_`·`error_`·`failed_` 접두는 금지다(주체 없는 이름). 사건은 명사/과거분사
 *   (`_failed`·`_missing`·`_invalid`·`_exceeded`)이고 토큰은 둘 이상이다.
 *
 * ★ `poison: true` 는 "이 결함이 나면 artifact 저장소를 더는 믿을 수 없다" 는 표시다. engine 이
 *   `error.endsWith('_authority_lost')` 같은 **부분 문자열**로 판정하던 것을 대체한다(WS2 §2.3) —
 *   판정은 `isPoisonCode(code)` 하나로만 한다. 이름을 고쳐도 승격 규칙이 조용히 깨지지 않는다.
 *
 * ★ 확장 절차(로드맵 §5.10): (1) 여기 추가 (2) `npm run contract:snapshot` 으로
 *   `contract/reason-codes.json` 재생성 커밋 (3) 스킬·문서 표 갱신 (4) 그다음 소비 코드.
 *   `contract/reason-codes.json` 을 손으로 고쳐 이 모듈과 갈라 놓는 것은 금지 —
 *   `test/tool-contract.test.mjs` 가 둘이 같은지 잰다.
 *
 * ★ 벤더가 내는 값(claude `stop_reason`/`subtype`, codex 스트림 오류 문구)은 여기 넣지 않는다.
 *   그것은 라벨된 발췌 안에 원문으로 남고, 우리 쪽 분류는 항상 우리 코드다.
 */

/** 실행이 끝난 이유의 닫힌 조악 어휘. 순서는 문서 표 순서다. */
export const STOP_REASONS = Object.freeze([
  'verified',
  'unverified',
  'rejected',
  'policy_failure',
  'budget_exhausted',
  'deadline_exceeded',
  'cancelled',
  'provider_failed',
  'infrastructure_failed',
  'blocked',
  'tie',
  'no_candidate',
  'dry_run',
]);

/** reason code 의 첫 토큰으로 허용되는 주체. 위 주체 정의표와 같은 집합이다. */
export const SUBJECTS = Object.freeze([
  'provider', 'auth', 'git', 'worktree', 'artifact', 'test', 'evidence', 'verifier', 'judge',
  'scope', 'run', 'lane', 'state', 'config', 'learning', 'apply', 'resume', 'preflight', 'deps',
  'status',
]);

/** 형식: 소문자 snake_case, 토큰 둘 이상. */
export const REASON_CODE_FORMAT = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** 주체 없는 이름을 막는다 — 이 접두사로 시작하는 코드는 등재할 수 없다. */
export const FORBIDDEN_PREFIXES = Object.freeze(['error_', 'unknown_', 'failed_']);

/**
 * 한 항목. `since` 는 그 코드가 계약에 들어온 버전 — WS0 이 등재한 것은 `'0.2.2'`(개명해도 같은
 * 코드이므로 그대로), WS2 가 신설한 것은 `'0.3.0'`. `poison` 은 참일 때만 실린다(없음 = 아님).
 *
 * ★ WS2 Task 19 가 `surfaces`(이 값이 어느 봉투/본문 필드에 나타날 것인가의 **이전 지도**)를
 *   지웠다. 이전이 끝난 지금 그것은 지도가 아니라 두 번째 장부이고, 틀려도 아무것도 붉어지지
 *   않았다(실측: git 코드 열이 닿지도 않는 `stopReason` 을 주장했다). 읽는 사람에게 필요한 사실은
 *   `meaning` 안에 문장으로 적는다 — 문장은 스냅샷·문서로 그대로 나가 사본이 생기지 않는다.
 */
function entry(code, subject, stopReason, meaning, { poison = false, since = '0.2.2' } = {}) {
  return Object.freeze({
    code,
    subject,
    stopReason,
    since,
    legacy: false,
    ...(poison ? { poison: true } : {}),
    meaning,
  });
}

/** 세부 reason code 전체. 코드 사전순. */
export const REASON_CODES = Object.freeze([
  // apply — WS5 태스크 7 이 이 주체의 **첫** 코드 다섯을 등재했고 태스크 8 이 적용기 자신의
  // 거절 열을 더했다. WS0 이 주체만 예약해 두고(`SUBJECTS` 의 `'apply'`) 코드는 0 개였다.
  // 태스크 7 의 다섯 중 `apply_not_implemented` 는 **지웠다**(태스크 8 배선 커밋): 적용 단계가
  // 생긴 순간 그 코드가 말하던 사실이 없어졌고, 아무것도 안 말하는 코드는 이 레지스트리가
  // 막으려는 것이다. 등재를 지우는 절차의 실례이기도 하다 — 코드·문구·스냅샷 셋·수 핀이 한
  // 커밋에서 같이 움직인다.
  //
  // ★ 왜 「안 붙는다」를 한 코드로 뭉개지 않는가: 이 도구의 실패는 사용자가 다음에 할 일이
  //   전부 다르다 — 프룬된 baseline 은 아무도 되살릴 수 없고(손으로 붙이는 수밖에 없다),
  //   더러운 트리는 커밋/stash 한 번이면 풀리고, 충돌은 사람이 골라야 하고, 사후 확인 실패는
  //   **저장소가 이미 바뀐** 유일한 실패라 제일 먼저 트리를 봐야 한다.
  entry('apply_applied_unverified', 'apply', 'infrastructure_failed', 'Git reported a completed three-way write, but the copied-index post-apply check could not run: either the real index could not be copied or a copied-index Git command could not complete. The later read-only classifier found every mapped path at its pre-write kind, bytes and mode; by the time this result is read, however, mapped paths may match their pre-write snapshots or may have changed again, and the index state is unproven. This code therefore makes no claim that the patch is currently applied or staged. If that classifier instead finds a changed or unsafe path, apply_rollback_incomplete reports it and keeps the mapped backup. Distinct from apply_verification_failed, where the completed copied-index check ran and disagreed, or where a failed write reached a final status check that disagreed or could not run.', { since: '0.3.0' }),
  entry('apply_artifact_mismatch', 'apply', 'infrastructure_failed', 'The bytes at the run\'s representative patch path do not hash to the digest the run manifest recorded for it, so the file is not the patch that run produced. WS0 §1.4 step (1). Nothing is applied from bytes the run cannot vouch for - a partially rewritten alias and a foreign file land here alike.', { since: '0.3.0' }),
  entry('apply_baseline_moved', 'apply', 'blocked', 'The patch does not apply directly, and the three-way path left no usable result. It has two producers after Git built the fake ancestor from the required patch preimage material and the three-way preconditions passed: either the temporary-index probe reached no clean result, or the real three-way write failed and a read-only comparison found every patch-named path at the same kind, bytes and file mode as its pre-write snapshot while final no-optional-locks porcelain exactly matched its pre-write value. An untracked file occupying a path the patch must create is the measured second case. Porcelain equality does not prove index bytes or object-database identity, so this code claims neither. Distinct from apply_write_blocked, whose pre-write path-safety gate can stop either branch and whose measured failed-write producer belongs to the direct branch.', { since: '0.3.0' }),
  entry('apply_baseline_pruned', 'apply', 'blocked', 'Git cannot build the fake-ancestor index because required patch preimage material is unavailable. Usually that material is a blob identity named by the patch; a pure mode-only change names no blob and instead needs the baseline tree\'s index entry. The manifest commit identity is reporting data, and tree presence is not a general prerequisite: a synthetic commit or tree can be pruned while every blob preimage remains reachable, and a commit/tree name can resolve while a required loose blob is missing. A resolvable baseline tree is used only to seed mode-only input before git apply --build-fake-ancestor makes the verdict, never from vendor prose. WS5 spec §0 D5 still supplies the retention mismatch: unreachable objects may be pruned before this server\'s thirty-day patch expires.', { since: '0.3.0' }),
  entry('apply_git_failed', 'apply', 'infrastructure_failed', 'A required Git-related preparation or operation could not complete for a reason that is not about the patch fitting. Producers include repository reads and Git invocation, invalid or unavailable patch bytes, a missing scratch root, working-tree backup or manifest creation, and temporary index or object-directory setup. Every producer occurs before the target-repository write begins, so the repository is left as it was.', { since: '0.3.0' }),
  entry('apply_head_moved', 'apply', 'blocked', 'The target repository HEAD changed after applicability and scope inspection began. The applier re-reads HEAD after its state-root backup manifest is complete and immediately before the real Git write; a mismatch refuses without applying the patch, because both applicability and scope.allow authority were measured at the earlier commit. This catches movement during inspection and backup. No portable repository lock excludes an unrelated Git process in the final subprocess gap between that read and git apply, so callers must still avoid concurrent repository mutation while applying.', { since: '0.3.0' }),
  entry('apply_patch_empty', 'apply', 'blocked', 'The run left a representative patch of zero bytes, which is not a patch that can be applied - git rejects empty input outright. It says the delegate changed no file, which is a fact about the run rather than a fault of this call.', { since: '0.3.0' }),
  entry('apply_patch_missing', 'apply', 'blocked', 'The run read cleanly but the patch orch_apply would apply is not on this state root: the run ended with no representative patch (a tie, or no candidate) or the cleanup has already reclaimed it. It mirrors status_run_not_found - the caller named something that is not there - so the coarse value is blocked and nothing was attempted.', { since: '0.3.0' }),
  entry('apply_patch_unreadable', 'apply', 'infrastructure_failed', 'Something is at the representative patch path but it is not a readable file. This is not "there is no patch": the difference decides whether the caller looks for another run or looks at what is occupying that path.', { since: '0.3.0' }),
  entry('apply_run_not_found', 'apply', 'blocked', 'No run of that name is on this state root, so there is nothing to apply. It mirrors status_run_not_found and learning_run_not_found: the caller named something that is not there, the coarse value is blocked, and the handler ships status invalid because the fault is in the value the caller chose. A run id that is not even shaped like one this server makes lands here too, before any path is built from it. So does the reaper-shaped case where the patch alias outlived its run directory (patches are kept longer than what is under runs/): the baseline the patch was written against lives in the manifest, so a patch with no run records is not applicable, only present.', { since: '0.3.0' }),
  entry('apply_project_unknown', 'apply', 'blocked', 'The durable records of this run do not name the repository it was started in, so orch_apply has no target to apply to. The tool takes exactly two arguments and a repository path is not one of them by design: a patch is bound to the repository whose state its baseline captured, and applying it wherever the server happens to be running is the foot-gun that binding exists to prevent.', { since: '0.3.0' }),
  entry('apply_project_unusable', 'apply', 'blocked', 'The repository this run was started in is named in the run records but cannot be used now: the path is gone, it is not a git repository, or it has no commit to compare against. Distinct from not knowing which repository it was, because the next thing to do differs - restoring or renaming a directory rather than reading the run records.', { since: '0.3.0' }),
  entry('apply_rollback_incomplete', 'apply', 'infrastructure_failed', 'The apply had already started writing when it failed or its success could not be verified, and a read-only comparison found patch-named paths that differ from the pre-write snapshot or cannot be inspected safely. The failure handler does not write, remove, chmod or recreate any repository path, so the current partial tree is preserved exactly as observed. The pre-write copies and backup/manifest.json are KEPT at params.backup; the manifest maps every patch path to its original kind, bytes, mode, size and digest and records descendant-directory recovery information. Nothing on this server reclaims that directory afterwards. params.count is the number of differing or unsafe patch paths and params.detail names them with that count FIRST, so a list clipped by the parameter cap can never read as complete.', { since: '0.3.0' }),
  entry('apply_run_unreadable', 'apply', 'infrastructure_failed', 'The run exists on this state root but its manifest could not be read or did not normalize, so the patch cannot be checked against the run it came from. Bytes are never rewritten to make a run readable, so this names an unreadable record rather than a missing one.', { since: '0.3.0' }),
  entry('apply_scope_refused', 'apply', 'policy_failure', 'The representative patch still has scope-policy findings that the target repository has not approved, so orch_apply stops after its isolated applicability and scope checks and before either real Git write. Approval is re-evaluated from scope.allow in the target repository\'s current committed .bom-orch.json. A per-call scope_allow used by the earlier orch_run is not durable in the manifest or journal and is therefore never guessed into later apply authority. The failure body carries the bounded {path, rule, detail} reasons and the full-list aggregates; confidence is disputed.', { since: '0.3.0' }),
  entry('apply_three_way_conflicted', 'apply', 'blocked', 'The three-way merge of this patch reaches a result but that result carries conflicts, so the repository was left untouched. WS5 spec §0 D4: the verdict comes from an unmerged-entry test in a temporary index, never from the exit code and never from vendor prose - measured, `git apply --3way --check` exits 0 on conflicts and `git apply --3way` exits 1 after it has already written conflict markers into the working tree, so both of the obvious signals say the opposite of what happened.', { since: '0.3.0' }),
  entry('apply_verification_failed', 'apply', 'infrastructure_failed', 'A post-write final check disagreed or could not complete, so the repository state cannot be vouched for. It has two producer shapes: after a failed write, every patch-named path matched its pre-write kind, bytes and mode but final no-optional-locks porcelain differed or could not be read; after a completed three-way write, the copied-index check ran and disagreed with the temporary-index prediction. Failure handling after the write is read-only. params.detail names the failed check or the paths and real git status codes that differ. This code promises no retained backup; if a patch-named path differs or is unsafe to inspect, apply_rollback_incomplete reports that state and names the kept backup instead. A copied-index command that cannot run is apply_applied_unverified instead, because Git reported a completed three-way write but no copied-index verdict exists and the later mapped-path classifier found no changed or unsafe path; neither code proves the current index state.', { since: '0.3.0' }),
  entry('apply_worktree_dirty', 'apply', 'blocked', 'A three-way merge is needed, but tracked changes in the target repository break one of two preconditions. A patch-named path that differs from the index is refused by Git itself (measured: "does not match index"). Any tracked staged change, including one on an unrelated path, makes the real index differ from the HEAD-seeded temporary index, so orch_apply cannot predict and verify the result; measured, raw git apply --3way can succeed in that second case. The tool may not reset, clean or rewrite anyone\'s staged work, so the merge is not started. A patch that applies directly is NOT refused for a dirty tree: the baseline already contains the work that was uncommitted at run start, so an ordinary apply lands on a dirty tree by design.', { since: '0.3.0' }),
  entry('apply_write_blocked', 'apply', 'blocked', 'git could not safely begin or finish application of this patch. A pre-write path-safety gate returns this code on either branch when a patch path or one of its descendant ancestors is a symlink, junction or another non-file/non-directory shape that git must not follow. On the direct branch only, a real write may instead fail; this code then means a read-only comparison found every patch-named path at the same kind, bytes and file mode as its pre-write snapshot and final no-optional-locks porcelain exactly matched its pre-write value. Porcelain equality does not prove index bytes or object-database identity, so this code claims neither. Distinct from apply_baseline_moved, whose measured failed-write producer belongs to the three-way branch, and from apply_rollback_incomplete, where at least one patch path differs or is unsafe to inspect.', { since: '0.3.0' }),
  entry('artifact_allocation_checkpoint_failed', 'artifact', 'infrastructure_failed', 'The manifest could not durably record the attempt allocation, so the attempt never started.'),
  entry('artifact_attempt_input_invalid', 'artifact', 'infrastructure_failed', 'writeAttemptArtifact input failed validation or named an unknown attempt.'),
  entry('artifact_attempt_record_invalid', 'artifact', 'infrastructure_failed', 'The attempt record failed normalization.'),
  entry('artifact_attempt_too_large', 'artifact', 'infrastructure_failed', 'The attempt JSON exceeded MAX_JSON_ARTIFACT_BYTES.'),
  entry('artifact_attempt_write_failed', 'artifact', 'infrastructure_failed', 'The immutable attempt record could not be written or failed its byte/ref verification; it overrides every other lane stop reason.'),
  entry('artifact_base_directory_not_private', 'artifact', 'blocked', 'The artifact base directory is not owner-only.'),
  entry('artifact_candidate_checkpoint_failed', 'artifact', 'infrastructure_failed', 'The candidate_recorded or issues_recorded manifest checkpoint was blocked.'),
  entry('artifact_candidate_input_invalid', 'artifact', 'infrastructure_failed', 'writeCandidatePatch input failed validation.'),
  entry('artifact_candidate_patch_mismatch', 'artifact', 'infrastructure_failed', 'The candidate patch bytes did not match the sealed attempt digest.'),
  entry('artifact_candidate_path_mismatch', 'artifact', 'infrastructure_failed', 'A lane wrote its candidate patch to a path other than the one the frozen path budget reserved.'),
  entry('artifact_candidate_write_failed', 'artifact', 'infrastructure_failed', 'The lane\'s candidate patch artifact could not be persisted or failed ref verification.'),
  entry('artifact_collision_input_invalid', 'artifact', 'infrastructure_failed', 'inspectRunArtifactCollision received a malformed input object.'),
  entry('artifact_collision_inspection_failed', 'artifact', 'infrastructure_failed', 'The namespace collision probe could not read the artifact root.'),
  entry('artifact_create_once_publish_failed', 'artifact', 'infrastructure_failed', 'The create-once rename from temp to final failed.'),
  entry('artifact_destination_exists_or_publish_failed', 'artifact', 'infrastructure_failed', 'A create-once publish found the destination already present, or the rename failed.'),
  entry('artifact_directory_sync_failed', 'artifact', 'infrastructure_failed', 'fsync of the artifact directory failed, so a publish cannot be proven durable.'),
  entry('artifact_evidence_input_invalid', 'artifact', 'infrastructure_failed', 'writeEvidenceArtifact input failed validation.'),
  entry('artifact_evidence_record_invalid', 'artifact', 'infrastructure_failed', 'The evidence record failed normalization.'),
  entry('artifact_final_inspection_failed', 'artifact', 'infrastructure_failed', 'The final path could not be inspected after publish.'),
  entry('artifact_identity_invalid', 'artifact', 'infrastructure_failed', 'The final artifact path could not be derived from the frozen identity.'),
  entry('artifact_init_lock_collision', 'artifact', 'infrastructure_failed', 'Another initializer already owns this run namespace.'),
  entry('artifact_initial_manifest_invalid', 'artifact', 'infrastructure_failed', 'The initial manifest value did not normalize.'),
  entry('artifact_initial_manifest_too_large', 'artifact', 'infrastructure_failed', 'The initial manifest exceeded MAX_RUN_MANIFEST_BYTES (4 MiB).'),
  entry('artifact_initialization_dependency_failed', 'artifact', 'infrastructure_failed', 'A filesystem dependency needed for initialization was missing or threw.'),
  entry('artifact_initialization_failed', 'artifact', 'infrastructure_failed', 'Initialization failed without evidence of a crash.'),
  entry('artifact_initialization_interrupted', 'artifact', 'infrastructure_failed', 'Initialization crashed midway (context.crashed) and left partial state.'),
  entry('artifact_inspection_input_invalid', 'artifact', 'infrastructure_failed', 'inspectArtifactRefs received a malformed input object.'),
  entry('artifact_manifest_authority_mismatch', 'artifact', 'infrastructure_failed', 'The loaded manifest did not match the frozen authority for this run.', { poison: true }),
  entry('artifact_manifest_checkpoint_failed', 'artifact', 'infrastructure_failed', 'checkpointManifest threw, or its publish step failed; reaches stopReason through the artifact-store poison.', { poison: true }),
  entry('artifact_manifest_event_invalid', 'artifact', 'infrastructure_failed', 'The checkpoint event object failed validation.'),
  entry('artifact_manifest_event_path_invalid', 'artifact', 'infrastructure_failed', 'The event carried a path outside the run namespace, or one that would not digest.'),
  entry('artifact_manifest_event_payload_mismatch', 'artifact', 'infrastructure_failed', 'A replayed eventId arrived with a different payload digest than the one already applied.'),
  entry('artifact_manifest_replace_failed', 'artifact', 'infrastructure_failed', 'Atomic replace of the manifest file failed.'),
  entry('artifact_manifest_transition_invalid', 'artifact', 'infrastructure_failed', 'The event would move the manifest into a state the state machine forbids.'),
  entry('artifact_namespace_collision', 'artifact', 'blocked', 'An artifact namespace for this runId already exists; existing bytes are preserved and never adopted.'),
  entry('artifact_partial_write_requires_recovery', 'artifact', 'infrastructure_failed', 'A partial temp file exists; recovery must run before the write can be retried.'),
  entry('artifact_patch_write_failed', 'artifact', 'infrastructure_failed', 'The candidate patch bytes could not be collected, or they did not verify against the delta they must match.', { since: '0.3.0' }),
  entry('artifact_path_budget_exceeded', 'artifact', 'blocked', 'The worst-case artifact path JSON would exceed ARTIFACT_PATH_JSON_BUDGET (5000 chars); refused before any credit is spent.'),
  entry('artifact_paths_invalid', 'artifact', 'infrastructure_failed', 'validateArtifactPathBudget got a non-canonical state root, a bad runId, or a candidateCount outside {1,2}.'),
  entry('artifact_pending_final_mismatch', 'artifact', 'infrastructure_failed', 'The published file did not match the immutable ref recorded for it.'),
  entry('artifact_pending_replay_mismatch', 'artifact', 'infrastructure_failed', 'A pending reservation names a different relative path than the current write.'),
  entry('artifact_permission_verification_failed', 'artifact', 'infrastructure_failed', 'The artifact directory/file could not be proven owner-only (mode bits or owner check failed).'),
  entry('artifact_plan_record_invalid', 'artifact', 'infrastructure_failed', 'The planner canon record failed normalization, so runs/<runId>/plan.json was never written.', { since: '0.3.0' }),
  entry('artifact_replay_mismatch', 'artifact', 'infrastructure_failed', 'A replayed write found different bytes on disk than the manifest recorded.'),
  entry('artifact_reservation_lost', 'artifact', 'infrastructure_failed', 'The pending write reservation disappeared from the manifest mid-write.'),
  entry('artifact_root_not_canonical', 'artifact', 'blocked', 'BOM_ORCH_HOME could not be canonicalised (missing directory, symlink loop, or 8.3 alias).'),
  entry('artifact_root_overlaps_project', 'artifact', 'blocked', 'BOM_ORCH_HOME lives inside the target repository, which would make artifacts part of the diff.'),
  entry('artifact_selection_checkpoint_failed', 'artifact', 'infrastructure_failed', 'The usage_recorded or selection_recorded manifest checkpoint was blocked.'),
  entry('artifact_store_authority_lost', 'artifact', 'infrastructure_failed', 'A manifest checkpoint settled in an unknown state, or its revision no longer matched the frozen authority - the store can no longer be trusted.', { poison: true }),
  entry('artifact_store_handle_invalid', 'artifact', 'infrastructure_failed', 'The store handle passed in is not one this module created.'),
  entry('artifact_store_initialization_failed', 'artifact', 'infrastructure_failed', 'createRunArtifacts returned blocked with no error string of its own.'),
  entry('artifact_store_input_invalid', 'artifact', 'infrastructure_failed', 'createRunArtifacts received a malformed input object.'),
  entry('artifact_store_invalid', 'artifact', 'infrastructure_failed', 'createRunArtifacts returned something that failed the store-shape or authority snapshot check.'),
  entry('artifact_store_poisoned', 'artifact', 'infrastructure_failed', 'A previous fault poisoned the store; every later write is refused.', { poison: true }),
  entry('artifact_temp_inspection_failed', 'artifact', 'infrastructure_failed', 'The temp file could not be inspected.'),
  entry('artifact_temp_mismatch', 'artifact', 'infrastructure_failed', 'The temp path is not the regular file we created.'),
  entry('artifact_temp_name_failed', 'artifact', 'infrastructure_failed', 'A unique temp file name could not be produced.'),
  entry('artifact_temp_write_failed', 'artifact', 'infrastructure_failed', 'Writing the temp file failed.'),
  entry('artifact_unowned_final_collision', 'artifact', 'infrastructure_failed', 'A file we do not own already occupies the final artifact path.'),
  entry('artifact_winner_alias_failed', 'artifact', 'infrastructure_failed', 'Selection succeeded but the winner alias artifact could not be written or verified, so no representative patch path exists.'),
  entry('artifact_winner_alias_not_selected', 'artifact', 'infrastructure_failed', 'writeWinnerAlias was called for a run whose selection names no candidate.'),
  entry('artifact_winner_candidate_mismatch', 'artifact', 'infrastructure_failed', 'The candidate artifact on disk no longer matches the manifest ref.'),
  entry('artifact_winner_candidate_unavailable', 'artifact', 'infrastructure_failed', 'The selected candidate has no persisted patch artifact to alias.'),
  entry('artifact_write_failed', 'artifact', 'infrastructure_failed', 'A guarded artifact write rejected for an unclassified reason.'),
  entry('artifact_write_interrupted', 'artifact', 'infrastructure_failed', 'The write was cut short (deadline/abort) at a point where the on-disk effect is unknown.'),
  entry('auth_login_required', 'auth', 'provider_failed', 'The vendor CLI is installed but not authenticated for this run.', { since: '0.3.0' }),
  entry('config_allowed_tools_missing', 'config', 'provider_failed', 'A write role was built without a non-empty allowedTools list. (claude only)'),
  entry('config_argument_above_maximum', 'config', 'blocked', 'A tool argument was above the maximum its schema declares.', { since: '0.3.0' }),
  entry('config_argument_below_minimum', 'config', 'blocked', 'A tool argument was below the minimum its schema declares.', { since: '0.3.0' }),
  entry('config_argument_item_type_invalid', 'config', 'blocked', 'An item of an array tool argument had a type the schema does not allow.', { since: '0.3.0' }),
  entry('config_argument_misspelled', 'config', 'blocked', 'A tool argument name is unknown and is one small edit away from a name the tool accepts.', { since: '0.3.0' }),
  entry('config_argument_not_finite', 'config', 'blocked', 'A numeric tool argument was not a finite number.', { since: '0.3.0' }),
  entry('config_argument_not_in_enum', 'config', 'blocked', 'A tool argument fell outside the closed list of values its schema allows.', { since: '0.3.0' }),
  entry('config_argument_not_integer', 'config', 'blocked', 'A tool argument the schema declares as a whole number carried a fraction.', { since: '0.3.0' }),
  entry('config_argument_required_missing', 'config', 'blocked', 'A tool argument the schema marks required was not given.', { since: '0.3.0' }),
  entry('config_argument_type_invalid', 'config', 'blocked', 'A tool argument had a type the schema does not allow.', { since: '0.3.0' }),
  entry('config_argument_unknown', 'config', 'blocked', 'A tool argument name is not one the tool accepts.', { since: '0.3.0' }),
  entry('config_argument_unsafe', 'config', 'provider_failed', 'A model / effort / cwd value looked like a CLI flag. (codex only)'),
  entry('config_arguments_invalid', 'config', 'blocked', 'The call arguments were not a plain JSON object, or one of their properties was an accessor instead of a data property.', { since: '0.3.0' }),
  entry('config_arguments_not_accepted', 'config', 'blocked', 'Arguments were given to a tool whose schema declares none.', { since: '0.3.0' }),
  entry('config_budget_invalid', 'config', 'blocked', 'The step budget was not an integer inside the allowed range.', { since: '0.3.0' }),
  entry('config_candidate_count_invalid', 'config', 'blocked', 'The requested candidate count was neither one nor two.', { since: '0.3.0' }),
  entry('config_change_scope_missing', 'config', 'blocked', 'A settings change named a model or an effort without the vendor and tier they belong to.', { since: '0.3.0' }),
  entry('config_change_target_missing', 'config', 'blocked', 'A settings change named a vendor and tier but no model or effort, so there was nothing to change.', { since: '0.3.0' }),
  entry('config_effort_unsupported', 'config', 'blocked', 'The chosen effort is not one the chosen model offers.', { since: '0.3.0' }),
  entry('config_flag_banned', 'config', 'provider_failed', 'The built argv contained a banned flag. (codex only)'),
  entry('config_invalid', 'config', 'blocked', 'The project configuration file read from the baseline commit is not strict JSON, is larger than the schema allows, or violates contract/project-config.schema.json; the run stops before any credit is spent (WS0 §5).', { since: '0.3.0' }),
  entry('config_isolation_unsupported', 'config', 'blocked', 'The requested isolation mode is not one this server implements.', { since: '0.3.0' }),
  entry('config_permission_mode_invalid', 'config', 'provider_failed', 'permissionMode was not a non-empty string. (claude only)'),
  entry('config_project_path_invalid', 'config', 'blocked', 'The project path was missing or was not an absolute path.', { since: '0.3.0' }),
  entry('config_provider_unknown', 'config', 'blocked', 'A role was pinned to a vendor id this server does not register.', { since: '0.3.0' }),
  entry('config_role_override_conflict', 'config', 'blocked', 'Two candidate lanes use a fixed mirrored placement, so a global worker or verifier pin cannot be honored.', { since: '0.3.0' }),
  entry('config_role_unknown', 'config', 'provider_failed', 'The caller asked for a delegate role the argv builder does not know.'),
  entry('config_schema_newer', 'config', 'blocked', 'The project configuration file declares a schemaVersion newer than the one this server implements, so it is refused instead of half-read (roadmap §5.9 upper-version safe retreat).', { since: '0.3.0' }),
  entry('config_settings_effort_unsupported', 'config', 'blocked', 'A settings patch chose an effort a vendor+tier model does not offer; carries the vendor and tier the tool-argument-level config_effort_unsupported cannot see.', { since: '0.3.0' }),
  entry('config_settings_key_unknown', 'config', 'blocked', 'The settings patch named a key that no vendor section defines.', { since: '0.3.0' }),
  entry('config_settings_lock_unavailable', 'config', 'blocked', 'The settings lock could not be taken, so the settings file was never opened.', { since: '0.3.0' }),
  entry('config_settings_patch_empty', 'config', 'blocked', 'The settings patch carried no value to write.', { since: '0.3.0' }),
  entry('config_settings_patch_invalid', 'config', 'blocked', 'The settings patch was not a plain object.', { since: '0.3.0' }),
  entry('config_settings_read_failed', 'config', 'blocked', 'The existing settings file could not be read under the settings lock, so the mutation was refused instead of treating it as an empty legacy file.', { since: '0.3.0' }),
  entry('config_settings_section_invalid', 'config', 'blocked', 'A vendor section of the settings patch was not a plain object.', { since: '0.3.0' }),
  entry('config_settings_value_not_string', 'config', 'blocked', 'A settings value was neither a string nor an instruction to clear the key.', { since: '0.3.0' }),
  entry('config_settings_value_unsafe', 'config', 'blocked', 'A settings value carried a line break or a zero byte, which would turn the rest of the line into another key.', { since: '0.3.0' }),
  entry('config_settings_vendor_unknown', 'config', 'blocked', 'The settings patch named a vendor that has no section in the settings file.', { since: '0.3.0' }),
  entry('config_settings_write_failed', 'config', 'blocked', 'The settings file itself could not be written after the lock was taken.', { since: '0.3.0' }),
  entry('config_single_vendor_conflict', 'config', 'blocked', 'Two candidate lanes and a single-vendor allowance were asked for in the same call.', { since: '0.3.0' }),
  entry('config_task_missing', 'config', 'blocked', 'The task text was missing or blank, so there was nothing to delegate.', { since: '0.3.0' }),
  entry('config_tests_cwd_unusable', 'config', 'blocked', 'The project configuration names a tests.cwd that is not a usable directory inside the evidence worktree: it does not exist, it is not a directory, or a symbolic link on the way out of it leaves the isolated tree. The server creates no directory there, so the run stops instead of falling back to the repository root and producing evidence about a different tree.', { since: '0.3.0' }),
  entry('config_tool_pattern_unsafe', 'config', 'provider_failed', 'An allowedTools entry looked like a CLI flag. (claude only)'),
  entry('config_tool_set_missing', 'config', 'provider_failed', 'The role requires an explicit tool set and none was given. (claude only)'),
  entry('config_tool_unknown', 'config', 'blocked', 'The call named a tool this server does not serve.', { since: '0.3.0' }),
  entry('config_uncommitted', 'config', 'blocked', 'The project configuration file differs between the commit the frozen test plan read and the baseline this run sealed, which means the working tree carries an uncommitted edit to it; the run stops rather than half-applying it.', { since: '0.3.0' }),
  entry('config_unreadable', 'config', 'blocked', 'The repository could not say whether the project configuration file exists at a commit, or could not hand over its bytes; the file itself may be perfectly valid, so the run stops instead of treating an unreadable file as an absent one.', { since: '0.3.0' }),
  entry('config_wait_ms_invalid', 'config', 'blocked', 'The wait budget was not a finite, non-negative number of milliseconds.', { since: '0.3.0' }),
  entry('deps_unavailable', 'deps', 'blocked', 'Dependency provisioning was opted in through .bom-orch.json (tests.provisionDeps: "lockfile-install") and could not be carried out: the baseline commit carries no package-lock.json or npm-shrinkwrap.json, or the lockfile install itself failed (non-zero exit, timeout, or the package manager never started). The run stops before any credit is spent rather than continuing without the dependencies the caller asked for; without the opt-in this code is unreachable, because nothing is installed at all (roadmap §3.6).', { since: '0.3.0' }),
  entry('evidence_adapter_incomplete', 'evidence', 'infrastructure_failed', 'The reporter adapter produced no readable event bytes, so the run carries no machine evidence.', { since: '0.3.0' }),
  entry('evidence_artifact_too_large', 'evidence', 'infrastructure_failed', 'The evidence JSON exceeded MAX_JSON_ARTIFACT_BYTES (4 MiB).'),
  entry('evidence_authority_mismatch', 'evidence', 'infrastructure_failed', 'The persisted evidence records/refs did not match the sealed attempt they claim to describe, so the evidence carries no authority.'),
  entry('evidence_cleanup_unproven', 'evidence', 'infrastructure_failed', 'An evidence worktree could not be proven removed and its handoff to the reaper failed or was still pending.'),
  entry('evidence_controller_authority_lost', 'evidence', 'infrastructure_failed', 'The evidence controller hard-stopped, so the artifact store it owned can no longer be trusted.', { poison: true, since: '0.3.0' }),
  entry('evidence_persistence_failed', 'evidence', 'infrastructure_failed', 'An evidence artifact could not be written durably during the proof run.'),
  entry('evidence_revision_mismatch', 'evidence', 'infrastructure_failed', 'The evidence worktree sits on a different commit or tree than the proof spec named.', { since: '0.3.0' }),
  entry('evidence_seal_failed', 'evidence', 'infrastructure_failed', 'The revision identity did not match the snapshot it claims to seal, so the attempt cannot be sealed.', { since: '0.3.0' }),
  entry('evidence_snapshot_failed', 'evidence', 'infrastructure_failed', 'The git snapshot that seals a writer attempt produced no valid commit id, so there is nothing to build evidence on.', { since: '0.3.0' }),
  entry('evidence_spec_invalid', 'evidence', 'infrastructure_failed', 'runCandidateEvidence was called with a spec that failed validEvidenceSpec.'),
  entry('evidence_store_authority_lost', 'evidence', 'infrastructure_failed', 'The evidence writer lost the artifact-store authority it was given (its abort signal fired), so the store can no longer be trusted.', { poison: true, since: '0.3.0' }),
  entry('evidence_unavailable', 'evidence', 'unverified', 'The candidate is accepted as usable_unverified because machine evidence or the regression proof could not be obtained at all. It is the only stopReason a usable_unverified candidate may carry: candidate-selection.mjs drops such a candidate from selection, and content-projection.mjs refuses to project it, whenever the stopReason is anything else. Its coarse value is unverified, not infrastructure_failed: both producers are ACCEPT branches (candidate-lane.mjs, terminalClass usable_unverified) and the envelope they build is a SUCCESS. Registering it as an infrastructure failure while every path shipped unverified is how one code came to have two coarse values - the one thing stopReasonOf() exists to prevent - and it published the wrong one in REASON_CODES.md and golden-failures.json.'),
  entry('evidence_unstable', 'evidence', 'infrastructure_failed', 'The two repetitions of a group produced different stable signatures, or the BR witness sets diverged. (proof status: flaky)'),
  entry('evidence_worktree_invalid', 'evidence', 'infrastructure_failed', 'The evidence worktree handle failed its exact-shape check, so no test could run in it.', { since: '0.3.0' }),
  entry('evidence_worktree_unavailable', 'evidence', 'infrastructure_failed', 'The evidence worktree for a proof run could not be created.', { since: '0.3.0' }),
  entry('git_argument_count_exceeded', 'git', 'infrastructure_failed', 'A git command was assembled with more arguments than the hard cap this server will spawn with, so it was refused before the spawn. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_arguments_invalid', 'git', 'infrastructure_failed', 'An invalid Git invocation request was refused before spawn. Arguments must be a plain array of strings, and optional stdin must be a finite bounded Buffer. params.detail identifies which part of the request was invalid without conflating argument and stdin diagnostics. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_cli_unavailable', 'git', 'blocked', 'git could not be run at all: the executable was not found as an absolute path on PATH, or the version probe itself failed (src/git.mjs resolveGitPath / checkGitVersion).', { since: '0.3.0' }),
  entry('git_command_failed', 'git', 'infrastructure_failed', 'A git command exited non-zero and wrote nothing to stdout or stderr, so its exit status is all that is known about it. No producer sets it as a reasonCode: src/worktree.mjs gitReason() renders this sentence when a failed git run said nothing on either stream, and the sentence travels as the params.detail of a worktree_* code.', { since: '0.3.0' }),
  entry('git_diff_failed', 'git', 'infrastructure_failed', 'The revision delta listing failed or returned entries that are not a valid, sorted, regular-file diff.', { since: '0.3.0' }),
  entry('git_environment_invalid', 'git', 'infrastructure_failed', 'A git command was assembled with an environment that is not a plain object of string values, so it was refused before the spawn. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_environment_value_invalid', 'git', 'infrastructure_failed', 'A git command was assembled with an environment entry whose value is not a string, so it was refused before the spawn. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_global_option_refused', 'git', 'infrastructure_failed', 'A git command carried a leading global option that is not on the hardening allow list, so it was refused before the spawn. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_head_unborn', 'git', 'blocked', 'HEAD names no commit in the project repository (empty repository or unborn branch), so no worktree can be added.', { since: '0.3.0' }),
  entry('git_invocation_failed', 'git', 'infrastructure_failed', 'Reading the caller arguments or spawning git threw, so the command was refused rather than run unscreened. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_process_unkillable', 'git', 'infrastructure_failed', 'A git process did not exit within the grace period after the deadline kill, so the child may still be running. No envelope producer: src/git.mjs puts it on the runGit result after the kill grace period and appends the rendered sentence to stderr, which the caller carries as the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('git_project_path_missing', 'git', 'blocked', 'The repository inspection was called with no project path at all, so there was no repository to inspect.', { since: '0.3.0' }),
  entry('git_project_root_not_canonical', 'git', 'blocked', 'The project path could not be canonicalised.'),
  entry('git_repository_missing', 'git', 'blocked', 'The project path exists but is not inside a git repository.', { since: '0.3.0' }),
  entry('git_seal_failed', 'git', 'infrastructure_failed', 'The pre-WS2 umbrella code: three of the four failure returns in engine.mjs sealAttempt (revision identity mismatch, a revision delta whose entry shape or path ordering did not verify, and candidate patch collection that did not match the delta) all reported it, and only the snapshot return had a code of its own. Task 10 gives each of the four returns its own code - evidence_snapshot_failed, git_diff_failed, evidence_seal_failed, artifact_patch_write_failed - which is what the fault registry now records. This code did NOT become producerless (WS2 Task 19 re-measured it): the same four returns still hand it back as the attempt record writerResult, which is a closed on-disk vocabulary, and src/candidate-lane.mjs raises that value to the lane stopReason when the terminal attempt is written. The on-disk alias seal_failed reads to it.'),
  entry('git_snapshot_failed', 'git', 'infrastructure_failed', 'The git snapshot of the writer step did not produce a valid commit id, so the attempt could not be sealed.'),
  entry('git_spawn_failed', 'git', 'infrastructure_failed', 'The git process never started, so the command produced no exit status of its own. No producer sets it as a reasonCode: src/worktree.mjs gitReason() renders this sentence when a failed git run said nothing on either stream, and the sentence travels as the params.detail of a worktree_* code.', { since: '0.3.0' }),
  entry('git_version_below_floor', 'git', 'blocked', 'The installed git is older than the 2.45.1 floor, which follows out-of-tree symlinks on case-insensitive filesystems (CVE-2024-32002).', { since: '0.3.0' }),
  entry('git_working_directory_invalid', 'git', 'infrastructure_failed', 'A git command was assembled with a working directory that is not an absolute path, so it was refused before the spawn. No envelope producer: src/git.mjs returns it on the runGit result before any spawn and the caller turns the rendered sentence into the params.detail of a worktree_* code, so it is never an envelope reasonCode.', { since: '0.3.0' }),
  entry('judge_cancelled', 'judge', 'cancelled', 'The host aborted the run while a blind judge step was in flight. It exists because the judge path classifies from the FOLDED halt signal (deadline OR host cancel, src/deadline.mjs haltSignal) and therefore cannot tell the two apart on its own - the run-level answer is decided at the signal source (src/engine.mjs haltReasonCode) and this code carries that answer into the judge slot. Routing run_cancelled itself into that slot is not an option: it is outside JUDGE_CODES, so projectJudge returns null, projectSelection throws, and the whole body collapses to the fixed floor at every rung.', { since: '0.3.0' }),
  entry('judge_deadline', 'judge', 'deadline_exceeded', 'The shared run deadline (wait_ms) passed before a blind judge step could finish.'),
  entry('judge_decision_invalid', 'judge', 'provider_failed', 'The de-blinded decision was neither TIE nor a known lane.'),
  entry('judge_format_invalid', 'judge', 'provider_failed', 'The raw judge answer was empty, oversized, had a duplicate JSON key, or failed the de-blind remap.'),
  entry('judge_invalid', 'judge', 'provider_failed', 'Judging produced outcome `none` with no other failure reason - the decisions themselves were invalid.'),
  entry('judge_json_invalid', 'judge', 'provider_failed', 'The judge answer was not parsable JSON after one code-fence layer was stripped.'),
  entry('judge_nonce_preparation_failed', 'judge', 'infrastructure_failed', 'The blind judge nonces or scratch identity could not be prepared before judging.'),
  entry('judge_provider_failure', 'judge', 'provider_failed', 'The judge provider call failed, was truncated, or ended with a timeout/aborted doneReason.'),
  entry('judge_schema_invalid', 'judge', 'provider_failed', 'The judge object did not match the four-key schema, or schemaVersion was not 1.'),
  entry('judge_scratch_failed', 'judge', 'infrastructure_failed', 'The judge scratch worktree could not be prepared or cleaned, so the judge decision is invalid.'),
  entry('judge_tie', 'judge', 'tie', 'Two blind judges disagreed, reported TIE, or found major defects, so no candidate was selected.'),
  entry('judge_view_unavailable', 'judge', 'infrastructure_failed', 'A blind judge pair could not be built from the candidate summaries, so judging never ran.'),
  entry('lane_budget_exhausted', 'lane', 'budget_exhausted', 'Lane ran every attempt in its budget without reaching a terminal decision; the initial value of the lane loop.'),
  entry('lane_stagnated', 'lane', 'rejected', 'Two consecutive attempts produced an identical stagnation fingerprint (same tree, same open issues, same trusted failure fingerprints).'),
  entry('lane_unverified', 'lane', 'unverified', 'The verifier verdict could not be parsed even after the format-correction retry. No envelope producer: nothing in src/ passes this code to fail() or sets it as a reasonCode - src/run-faults.mjs stopReasonOf only reads it, to keep the coarse stopReason when a lane already carries a lane_* verdict. It stays registered so the on-disk alias unverified can still be read.'),
  entry('lane_verified', 'lane', 'verified', 'Every gate passed: verifier PASS, no open issues, machine evidence green, proof satisfied.'),
  entry('learning_applied_axes_missing', 'learning', 'blocked', 'The run record carries an applied grade but not the axes it was applied to, so the contribution cannot be taken back.', { since: '0.3.0' }),
  entry('learning_applied_grade_unknown', 'learning', 'blocked', 'The run record claims a grade this server cannot turn back into a contribution.', { since: '0.3.0' }),
  entry('learning_arm_missing', 'learning', 'blocked', 'A learning update named no arm.', { since: '0.3.0' }),
  entry('learning_cell_key_conflict', 'learning', 'blocked', 'A reset named both a single cell and a list of cells.', { since: '0.3.0' }),
  entry('learning_cell_key_duplicated', 'learning', 'blocked', 'One transaction carried the same cell twice, so one run would make two observations on one axis.', { since: '0.3.0' }),
  entry('learning_cell_key_invalid', 'learning', 'blocked', 'A cell name was empty or was not text.', { since: '0.3.0' }),
  entry('learning_cell_key_missing', 'learning', 'blocked', 'A learning update named no cell.', { since: '0.3.0' }),
  entry('learning_cell_keys_invalid', 'learning', 'blocked', 'A reset was given a cell list that was not a list of non-empty names.', { since: '0.3.0' }),
  entry('learning_choice_map_invalid', 'learning', 'blocked', 'A policy version 2 run record carries applied or rewardable choices that are not intact.', { since: '0.3.0' }),
  entry('learning_generation_expired', 'learning', 'blocked', 'A reset retired the learning generation this run belongs to, so its grade can no longer be corrected.', { since: '0.3.0' }),
  entry('learning_generations_read_failed', 'learning', 'infrastructure_failed', 'The learning generations file could not be read.', { since: '0.3.0' }),
  entry('learning_generations_snapshot_failed', 'learning', 'infrastructure_failed', 'The generations snapshot could not be written, so the reset stopped before it touched anything.', { since: '0.3.0' }),
  entry('learning_journal_read_failed', 'learning', 'infrastructure_failed', 'The run journal could not be read.', { since: '0.3.0' }),
  entry('learning_journal_record_invalid', 'learning', 'blocked', 'A journal record was not an object carrying a run identity.', { since: '0.3.0' }),
  entry('learning_journal_record_unserializable', 'learning', 'blocked', 'A journal record could not be turned into JSON.', { since: '0.3.0' }),
  entry('learning_journal_row_unbuildable', 'learning', 'infrastructure_failed', 'The replacement journal row could not be built.', { since: '0.3.0' }),
  entry('learning_journal_row_write_failed', 'learning', 'infrastructure_failed', 'The journal row that explains a learning change could not be appended.', { since: '0.3.0' }),
  entry('learning_lock_unavailable', 'learning', 'blocked', 'The learning coordinator lock could not be taken, so nothing was read or written.', { since: '0.3.0' }),
  entry('learning_mutation_failed', 'learning', 'infrastructure_failed', 'The learning change and the journal row that explains it could not be committed together.', { since: '0.3.0' }),
  entry('learning_pending_work_invalid', 'learning', 'infrastructure_failed', 'The pending learning work on disk is malformed, so it cannot be replayed.', { since: '0.3.0' }),
  entry('learning_pending_work_read_failed', 'learning', 'infrastructure_failed', 'The pending learning work could not be read.', { since: '0.3.0' }),
  entry('learning_pending_work_unclearable', 'learning', 'infrastructure_failed', 'The pending learning work was replayed but its record could not be removed.', { since: '0.3.0' }),
  entry('learning_policy_version_unknown', 'learning', 'blocked', 'The run record carries a learning policy version this server cannot correct.', { since: '0.3.0' }),
  entry('learning_posteriors_not_json', 'learning', 'infrastructure_failed', 'The learning state file is not readable as JSON.', { since: '0.3.0' }),
  entry('learning_posteriors_quarantine_failed', 'learning', 'infrastructure_failed', 'The corrupt learning state could not be read and could not be set aside either.', { since: '0.3.0' }),
  entry('learning_posteriors_read_failed', 'learning', 'infrastructure_failed', 'The learning state file could not be read.', { since: '0.3.0' }),
  entry('learning_posteriors_reset_failed', 'learning', 'infrastructure_failed', 'The learning state could not be cleared.', { since: '0.3.0' }),
  entry('learning_posteriors_shape_invalid', 'learning', 'infrastructure_failed', 'The learning state file is JSON but not a set of cells.', { since: '0.3.0' }),
  entry('learning_run_not_found', 'learning', 'blocked', 'No run with that identity is in the journal.', { since: '0.3.0' }),
  entry('learning_run_task_class_missing', 'learning', 'blocked', 'The run record has no task class, so there is no learning cell to correct.', { since: '0.3.0' }),
  entry('learning_scope_read_failed', 'learning', 'infrastructure_failed', 'The learning state could not be read, so a single task class could not be cleared on its own.', { since: '0.3.0' }),
  entry('learning_scope_unreadable', 'learning', 'infrastructure_failed', 'A task-class scope cannot be chosen out of a corrupt learning state.', { since: '0.3.0' }),
  entry('learning_snapshot_failed', 'learning', 'infrastructure_failed', 'The pre-reset snapshot could not be written, so the reset stopped before it touched anything.', { since: '0.3.0' }),
  entry('learning_task_class_conflict', 'learning', 'blocked', 'A reset named a task class together with an explicit cell list.', { since: '0.3.0' }),
  entry('learning_task_class_invalid', 'learning', 'blocked', 'A reset named a task class that was not a non-empty name.', { since: '0.3.0' }),
  entry('learning_updates_invalid', 'learning', 'blocked', 'The learning updates were not a list.', { since: '0.3.0' }),
  entry('learning_work_failed', 'learning', 'infrastructure_failed', 'The learning write failed without a more specific cause.', { since: '0.3.0' }),
  entry('learning_work_invalid', 'learning', 'blocked', 'A learning operation lacked the version, operation identity or learning target it must carry.', { since: '0.3.0' }),
  entry('learning_work_journal_invalid', 'learning', 'blocked', 'The journal target of a learning operation was neither an object nor absent.', { since: '0.3.0' }),
  entry('learning_work_journal_run_id_missing', 'learning', 'blocked', 'The journal target of a learning operation carries no run identity.', { since: '0.3.0' }),
  entry('learning_work_publish_failed', 'learning', 'infrastructure_failed', 'A learning file could not be moved from its temporary path into place.', { since: '0.3.0' }),
  entry('learning_work_quarantine_invalid', 'learning', 'blocked', 'The quarantine target of a learning operation was not the corrupt learning state bytes.', { since: '0.3.0' }),
  entry('learning_work_unserializable', 'learning', 'infrastructure_failed', 'A learning file could not be turned into JSON.', { since: '0.3.0' }),
  entry('learning_work_write_failed', 'learning', 'infrastructure_failed', 'A learning file could not be written.', { since: '0.3.0' }),
  entry('learning_write_boundary_failed', 'learning', 'infrastructure_failed', 'A learning write boundary hook failed, so the operation stopped there.', { since: '0.3.0' }),
  entry('preflight_cross_vendor_unavailable', 'preflight', 'blocked', 'Cross-vendor verification needs two available vendor CLIs and only one answered the preflight.', { since: '0.3.0' }),
  entry('preflight_gateway_env_unsupported', 'preflight', 'blocked', 'The host environment selects a vendor gateway deployment (Bedrock / Vertex), which this server does not support. The isolated child environment it builds for a delegate drops those variables by design, so the delegate would authenticate as an ordinary subscription user and fail after the run had already spent time and credit; the run is refused before any vendor process is started instead. Adding the variables to the opt-in allow list is a separate, owner-level decision (WS4b spec §8) because this repository cannot verify the claim that passing them through makes a gateway deployment work.', { since: '0.3.0' }),
  entry('preflight_no_provider_available', 'preflight', 'blocked', 'No registered vendor CLI answered the preflight, so no role could be filled.', { since: '0.3.0' }),
  entry('preflight_provider_unavailable', 'preflight', 'blocked', 'A role was pinned to a vendor whose preflight reported it unavailable.', { since: '0.3.0' }),
  entry('provider_below_security_floor', 'provider', 'blocked', 'The vendor CLI chosen to write is below the security floor this server requires of a write role.', { since: '0.3.0' }),
  entry('provider_cli_not_found', 'provider', 'provider_failed', 'resolveBinary could not find the vendor CLI on PATH.'),
  entry('provider_cli_shim_only', 'provider', 'provider_failed', 'Only a .CMD/.BAT shell shim was found; this repo only spawns with shell:false.'),
  entry('provider_call_halted', 'provider', 'provider_failed', 'This server cut the vendor call short before it produced a result. The catalog cannot know WHO cut it: the signal handed to the vendor is the folded one (deadline OR host cancel, src/deadline.mjs haltSignal), so the run-level reason is decided at the signal source (src/engine.mjs haltReasonCode) and never here. The name is deliberately neutral for that reason - until the WS3 final review this shape was filed as provider_deadline_exceeded, so a run the user cancelled answered its blockers, its vendor fault ledger and its run log with a deadline sentence telling them to raise wait_ms.', { since: '0.3.0' }),
  entry('provider_deadline_exceeded', 'provider', 'deadline_exceeded', 'The writer call was cut short before the deadline boundary (error.preBoundary === true), or the lane deadline passed with a writer result other than provider_outcome_unknown.'),
  entry('provider_error_unclassified', 'provider', 'provider_failed', 'The vendor CLI failed in a way this server does not classify yet; the labelled stderr excerpt is the only evidence.', { since: '0.3.0' }),
  entry('provider_exit_nonzero', 'provider', 'provider_failed', 'The process spawned and exited non-zero, and no more specific catalog entry matched - it is the last row of both vendor tables in src/providers/error-catalog.mjs. The vendor stderr tail travels beside it as evidence material, but no excerpt is attached (EXCERPT_ALLOWED covers spawn, auth, rate-limit and git faults only).'),
  entry('provider_no_terminal_record', 'provider', 'provider_failed', 'The vendor stream ended without a terminal record, so the answer is incomplete.', { since: '0.3.0' }),
  entry('provider_outcome_unknown', 'provider', 'provider_failed', 'The writer call may or may not have touched the worktree - we cannot prove either way, so the worktree is quarantined and handed to the reaper.'),
  entry('provider_output_truncated', 'provider', 'provider_failed', 'The vendor stopped at its own output or turn limit before finishing the answer.', { since: '0.3.0' }),
  entry('provider_rate_limited', 'provider', 'provider_failed', 'The vendor refused the call because the account usage limit is exhausted.', { since: '0.3.0' }),
  entry('provider_reported_failure', 'provider', 'provider_failed', 'The writer provider reported a failure through a channel the engine trusts, and the value is a member of the candidate-lane OPERATIONAL_RESULTS set. No engine path produces it today: qualityWriterSettlement collapses hardStopped, truncated, a timeout/aborted doneReason and any provider error string into the writerResult effect_unknown (provider_outcome_unknown), so the spelling survives only in the closed writerResults whitelist that run-artifacts.mjs persists in the attempt record - which is why the read side keeps the alias provider_failed.'),
  entry('provider_signal_killed', 'provider', 'provider_failed', 'The vendor process was killed by a signal without producing a result.', { since: '0.3.0' }),
  entry('provider_spawn_denied', 'provider', 'provider_failed', 'The operating system refused to execute the resolved vendor path (EACCES, EISDIR, or a Windows batch shim under shell:false).', { since: '0.3.0' }),
  entry('provider_spawn_failed', 'provider', 'provider_failed', 'The vendor executable disappeared between PATH resolution and spawn (ENOENT).', { since: '0.3.0' }),
  entry('provider_stream_unparsable', 'provider', 'provider_failed', 'The vendor event stream carried records this server could not read, so the result is incomplete.', { since: '0.3.0' }),
  entry('provider_turn_failed', 'provider', 'provider_failed', 'The codex stream reported turn.failed with a message that matched no more specific catalog entry; the vendor message goes to the run log, not to an excerpt.', { since: '0.3.0' }),
  entry('resume_baseline_mismatch', 'resume', 'blocked', 'The run named for the resume was built from a different baseline tree than the one this call prepared, so its sealed attempts describe different source bytes. Reuse requires that tree and the test-environment fingerprint; a synthetic baseline commit may differ even when its tree is identical. Nothing of the mismatched run is read further and no attempt is copied.', { since: '0.3.0' }),
  entry('resume_environment_mismatch', 'resume', 'blocked', 'The frozen test plan of this call has a different environment fingerprint than the run named for the resume, so evidence sealed there would not be evidence here. It is the second half of the exact-identity condition that alone permits reuse (WS3 spec R1).', { since: '0.3.0' }),
  entry('resume_manifest_unreadable', 'resume', 'blocked', 'The run named for the resume is on this state root but what it left could not be read: the manifest is missing, too large, not JSON, or did not normalize. Bytes are never rewritten to make a run readable, so a resume cannot repair it - the run either reads as it was written or it is not a resume source.', { since: '0.3.0' }),
  entry('resume_run_not_found', 'resume', 'blocked', 'No run of that name is on this state root, so there is nothing to resume. It mirrors status_run_not_found: the caller named something that is not there, and the coarse value is blocked because nothing of this run had started.', { since: '0.3.0' }),
  entry('run_all_candidates_blocked', 'run', 'blocked', 'Every candidate ended terminalClass `blocked`.'),
  entry('run_all_candidates_rejected', 'run', 'rejected', 'Every candidate ended terminalClass `rejected`, so there was nothing eligible to select.'),
  entry('run_binding_invalid', 'run', 'blocked', 'planner/worker/verifier could not be resolved to distinct available providers (or a single provider was used without allow_single).'),
  entry('run_binding_preparation_failed', 'run', 'blocked', 'The bandit decision or role assignment threw while freezing the run binding.'),
  entry('run_cancelled', 'run', 'cancelled', 'The host aborted this run - a cancel notification, SIGTERM, or a closed transport - and the engine stopped at its next halt point. Which of the two halt envelopes ships is decided by the signal source (src/engine.mjs haltReasonCode reads hostSignal.aborted), never by a fault text. Live children are killed at the abort. Quarantine is conditional, and the sentence used to promise it unconditionally: a cancel that lands before any authoring worktree exists - ahead of preflight, at the resume refusal, at the lane-b halt - has nothing to hand over, and a worktree that was cleanly removed is not handed over either; the envelope carries a worktree notice only when one was actually left behind, and its absence means nothing was.', { since: '0.3.0' }),
  entry('run_deadline_exceeded', 'run', 'deadline_exceeded', 'The deadline shared by every step of this run passed before the run could finish.', { since: '0.3.0' }),
  entry('run_deadline_unrepresentable', 'run', 'blocked', 'The clock and the wait budget together do not produce a deadline this server can represent exactly.', { since: '0.3.0' }),
  entry('run_nested_invocation', 'run', 'blocked', 'This server is itself running inside a delegate this orchestrator started, so every tool call is refused.', { since: '0.3.0' }),
  entry('run_orchestration_failed', 'run', 'infrastructure_failed', 'The orchestrator itself threw, so the run stopped before it could report a more specific cause.', { since: '0.3.0' }),
  entry('run_preparation_input_invalid', 'run', 'blocked', 'The frozen run preparation was entered with input that had already failed validation.', { since: '0.3.0' }),
  entry('run_result_unserializable', 'run', 'infrastructure_failed', 'The result envelope could not be turned into JSON.', { since: '0.3.0' }),
  entry('run_selection_unavailable', 'run', 'no_candidate', 'Fallback when candidates are mixed and none of the more specific run-level reasons apply.'),
  entry('run_tool_failed', 'run', 'infrastructure_failed', 'A tool handler threw, so the call ended without a more specific cause.', { since: '0.3.0' }),
  entry('run_tool_handler_missing', 'run', 'infrastructure_failed', 'A tool is declared in the schema but this server has no handler wired for it.', { since: '0.3.0' }),
  entry('scope_files_input_invalid', 'scope', 'infrastructure_failed', 'inspectPatch was given something other than a list of changed-file strings, so the patch scope could not be checked at all.', { since: '0.3.0' }),
  entry('scope_index_unreadable', 'scope', 'infrastructure_failed', 'The worktree index could not be listed, so the symbolic links the patch touches could not be resolved; an unchecked worktree is never recorded as "no symlinks".', { since: '0.3.0' }),
  entry('scope_inspection_failed', 'scope', 'infrastructure_failed', 'The patch scope check threw before it reached a verdict.', { since: '0.3.0' }),
  entry('scope_path_policy_unavailable', 'scope', 'policy_failure', 'ignoredPaths / unsafePaths were not supplied, so the path policy could not be applied. (unsafe)'),
  entry('scope_policy_failure', 'scope', 'policy_failure', 'The patch touched a path the scope policy forbids (patch-scope flag), or the test delta tampered with test definitions.'),
  entry('scope_tamper_failure', 'scope', 'policy_failure', 'Decision-level tamper signal (input.tamperFailure). No production caller sets it - runCandidateLane never passes tamperFailure to decideAttempt.'),
  entry('scope_worktree_path_missing', 'scope', 'infrastructure_failed', 'inspectPatch was given no worktree path, so the symbolic link axis could not be measured; running only half the check silently would report a scope it never looked at.', { since: '0.3.0' }),
  entry('state_directory_create_failed', 'state', 'blocked', 'The state directory could not be created.', { since: '0.3.0' }),
  entry('state_lock_create_failed', 'state', 'blocked', 'The lock file could not be created, and the error was not one a retry can clear.', { since: '0.3.0' }),
  entry('state_lock_path_invalid', 'state', 'blocked', 'The lock was asked for with an empty path.', { since: '0.3.0' }),
  entry('state_lock_timeout', 'state', 'blocked', 'The lock was still held by someone else when the wait budget ran out.', { since: '0.3.0' }),
  entry('state_lock_token_write_failed', 'state', 'blocked', 'The ownership marker could not be written, so the work under the lock never started.', { since: '0.3.0' }),
  entry('state_lock_work_failed', 'state', 'blocked', 'The work under the state-root lock failed after the lock was taken, so the write itself failed rather than losing a race.', { since: '0.3.0' }),
  entry('state_lock_work_not_callable', 'state', 'blocked', 'The work to run under the lock was not a function.', { since: '0.3.0' }),
  entry('state_recovery_intent_unavailable', 'state', 'blocked', 'The durable recovery intent could not be recorded before a worktree effect, so the effect was not started.', { since: '0.3.0' }),
  entry('state_root_not_absolute', 'state', 'blocked', 'The state root is not an absolute path.', { since: '0.3.0' }),
  entry('state_schema_newer', 'state', 'blocked', 'A shared state file declares a schemaVersion newer than this server implements, so the whole file is opaque and every write to it is refused.', { since: '0.3.0' }),
  entry('status_run_not_found', 'status', 'blocked', 'No run of that name is on this state root: neither a run directory nor a run log carries it. It mirrors learning_run_not_found - the caller named something that is not there, so the coarse value is blocked and the handler ships status invalid.', { since: '0.3.0' }),
  entry('status_run_unreadable', 'status', 'infrastructure_failed', 'The run exists on disk but what it left could not be read: the manifest did not normalize, or the run listing could not be enumerated. Bytes are never rewritten to make a run readable (a rewritten manifest breaks its own event digests and the reaper then refuses to reclaim it forever), so this names an unreadable record rather than a missing one - the run log is a separate read and may still answer.', { since: '0.3.0' }),
  entry('test_abort_signal_invalid', 'test', 'infrastructure_failed', 'The abort signal handed to the frozen test run was not an AbortSignal.', { since: '0.3.0' }),
  entry('test_aborted_before_start', 'test', 'infrastructure_failed', 'The abort signal was already set when the frozen test run was asked to start, so nothing ran.', { since: '0.3.0' }),
  entry('test_baseline_not_green', 'test', 'rejected', 'The baseline (B0) run did not complete-and-pass, so a later failure proves nothing.'),
  entry('test_cache_entry_invalid', 'test', 'infrastructure_failed', 'The evidence cache held a slot shape this server did not write, so the whole cache is refused.', { since: '0.3.0' }),
  entry('test_candidate_failed', 'test', 'rejected', 'The candidate (C) run did not complete-and-pass. (repairable)'),
  entry('test_candidate_witness_missing', 'test', 'rejected', 'The candidate run did not observe the exact witnesses BR identified. (repairable)'),
  entry('test_command_unavailable', 'test', 'infrastructure_failed', 'The frozen plan has no runnable derived command / executable in this environment.'),
  entry('test_deadline_expired', 'test', 'deadline_exceeded', 'The deadline passed inside the serial test queue or the evidence run; it poisons the queue for the rest of the run.'),
  entry('test_definition_tampering', 'test', 'policy_failure', 'The delegate changed a file that defines what the tests are - anything under the frozen plan pinnedDefinitions, package.json, .npmrc, a Makefile, pytest.ini / pyproject.toml / tox.ini / setup.cfg / conftest.py, an MSBuild or NuGet root file, any *.sln / *.slnx / *.slnf / *.csproj, or anything under node_modules/.bin/. splitTestOnlyDelta refuses the whole delta as unsafe and engine.mjs counts the code among its policyReasons, so the candidate ends as a policy_failure that no repair attempt may retry.'),
  entry('test_delta_apply_failed', 'test', 'infrastructure_failed', 'Applying the test-only delta patch to the evidence worktree failed.'),
  entry('test_delta_authority_mismatch', 'test', 'infrastructure_failed', 'The separable delta\'s patch bytes / sha256 / paths did not verify against each other.'),
  entry('test_delta_collection_failed', 'test', 'infrastructure_failed', 'Collecting the path-filtered test-only patch from git failed or was blocked. (ambiguous)'),
  entry('test_delta_collection_mismatch', 'test', 'infrastructure_failed', 'The collected patch did not list exactly the paths that were requested. (ambiguous)'),
  entry('test_delta_deletion_only', 'test', 'rejected', 'Every test entry in the delta is a deletion. (deletion_only; repairable)'),
  entry('test_delta_duplicate_path', 'test', 'policy_failure', 'The same path appears twice in the delta. (unsafe; policy failure)'),
  entry('test_delta_empty', 'test', 'rejected', 'The candidate changed no test files at all. (empty; repairable)'),
  entry('test_delta_ignored_path', 'test', 'policy_failure', 'The delta touched a gitignored path. (unsafe; policy failure)'),
  entry('test_delta_ignored_path_invalid', 'test', 'policy_failure', 'An ignored path failed the strict relative-path shape check. (unsafe; counts as a policy failure at engine.mjs:2204)'),
  entry('test_delta_input_invalid', 'test', 'infrastructure_failed', 'splitTestOnlyDelta got a non-array entry list or an unparsable baseline/candidate revision. (testDelta status: unsafe)'),
  entry('test_delta_path_invalid', 'test', 'policy_failure', 'A delta entry path failed the strict relative-path shape check. (unsafe; policy failure)'),
  entry('test_delta_unavailable', 'test', 'infrastructure_failed', 'No test delta object at all, or a non-separable delta that carried no reason codes of its own.'),
  entry('test_delta_unsafe_path', 'test', 'policy_failure', 'The delta touched a path git flagged unsafe, or a file mode outside {100644,100755}. (unsafe; policy failure)'),
  entry('test_delta_unsafe_path_invalid', 'test', 'policy_failure', 'An unsafe path failed the strict relative-path shape check. (unsafe; policy failure)'),
  entry('test_dependency_unavailable', 'test', 'infrastructure_failed', 'A test run failed with failureKind `dependency` - the suite\'s dependencies are not installed.'),
  entry('test_environment_drift', 'test', 'infrastructure_failed', 'The runtime environment fingerprint no longer matches the frozen test plan.'),
  entry('test_event_file_cleanup_unproven', 'test', 'infrastructure_failed', 'The adapter event file could not be proven removed, so its bytes are not trusted as evidence.', { since: '0.3.0' }),
  entry('test_event_file_creation_unproven', 'test', 'infrastructure_failed', 'The adapter event file could not be proven to be the regular file this server just created.', { since: '0.3.0' }),
  entry('test_event_file_identity_drift', 'test', 'infrastructure_failed', 'The adapter event file is no longer the same inode this server created before the spawn.', { since: '0.3.0' }),
  entry('test_executable_drift', 'test', 'infrastructure_failed', 'The test executable\'s identity digest changed since the plan was frozen.'),
  entry('test_execution_unavailable', 'test', 'infrastructure_failed', 'A test run never completed (not_run / spawn_error / timeout / aborted / hung / lingering).'),
  entry('test_frozen_execution_failed', 'test', 'infrastructure_failed', 'The frozen test execution threw before it could report an exit code.', { since: '0.3.0' }),
  entry('test_helper_untrusted', 'test', 'infrastructure_failed', 'The delta touched a test file the adapter\'s witness policy does not trust as an ordinary test. (ambiguous)'),
  entry('test_launcher_drift', 'test', 'infrastructure_failed', 'A launcher token in the argv could not be reconstructed to the same executable.'),
  entry('test_machine_failed', 'test', 'infrastructure_failed', 'The machine (test) channel says fail and the failure is not repairable within the remaining budget.'),
  entry('test_pinned_definition_drift', 'test', 'infrastructure_failed', 'A file that defines what the tests are changed after the plan was frozen.', { since: '0.3.0' }),
  entry('test_plan_invalid', 'test', 'infrastructure_failed', 'The frozen test plan object failed validation or carries no runtime, so no test could be started.', { since: '0.3.0' }),
  entry('test_plan_untrusted', 'test', 'infrastructure_failed', 'The frozen test plan is not a trusted regression-witness adapter - only node-events-v1 and pytest-events-v1 qualify. (ambiguous)'),
  entry('test_process_cleanup_unproven', 'test', 'infrastructure_failed', 'Test child processes could not be proven dead, so no further test may run in this run.'),
  entry('test_proof_not_proven', 'test', 'rejected', 'A required regression proof is repairable-but-unproven and there is no budget left.'),
  entry('test_queue_poisoned', 'test', 'infrastructure_failed', 'The serial test queue was poisoned by an earlier fault; no further test may run in this run.'),
  entry('test_record_invalid', 'test', 'infrastructure_failed', 'A classified test record failed the cache-cell shape check, so it cannot be used as evidence.', { since: '0.3.0' }),
  entry('test_regression_collection_failed', 'test', 'rejected', 'BR failed at collection time rather than at an assertion. (repairable)'),
  entry('test_regression_did_not_fail', 'test', 'rejected', 'Baseline + regression test (BR) passed - the new test does not reproduce the bug. (repairable)'),
  entry('test_regression_witness_missing', 'test', 'rejected', 'BR failed but not with a reproduced assertion witness, or the companion assertion witness ids were empty. (repairable)'),
  entry('test_start_invalid', 'test', 'infrastructure_failed', 'The serial test queue was handed something other than a function to start.', { since: '0.3.0' }),
  entry('verifier_failed', 'verifier', 'provider_failed', 'The verifier returned a structured FAIL verdict and there was no budget left to repair.'),
  entry('verifier_issue_limit_exceeded', 'verifier', 'rejected', 'The issue ledger would exceed MAX_BLOCKING_ISSUES (100) while applying machine issues or a verdict.'),
  entry('verifier_issues_open', 'verifier', 'rejected', 'Blocking issues are still open in the ledger after the verdict and the budget is exhausted.'),
  entry('verifier_mutation', 'verifier', 'policy_failure', 'The read-only verifier was detected mutating the worktree (touched sources or a dirty mutation check).'),
  entry('verifier_operational_failure', 'verifier', 'provider_failed', 'The verifier call itself failed operationally, or its mutation check could not be taken at all.'),
  entry('verifier_verdict_invalid', 'verifier', 'unverified', 'The verifier verdict could not be parsed, bound to the blind expectation, or reconciled with the issue ledger; the parser detail travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_add_failed', 'worktree', 'infrastructure_failed', 'git worktree add refused to create the disposable worktree; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_baseline_missing', 'worktree', 'blocked', 'The source worktree handle carried no shared baseline commit, so a revision worktree could not be derived from it.', { since: '0.3.0' }),
  entry('worktree_creation_crashed', 'worktree', 'infrastructure_failed', 'Creating a worktree stopped on an unexpected filesystem fault; the thrown text travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_creation_failed', 'worktree', 'infrastructure_failed', 'Default code used when createWorktree returned a blocked result carrying no error string of its own.'),
  entry('worktree_delta_listing_failed', 'worktree', 'infrastructure_failed', 'The raw revision delta could not be listed from git; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_delta_mode_inconsistent', 'worktree', 'policy_failure', 'A delta record paired a status letter with file modes that cannot both be true, so it was not trusted as apply authority.', { since: '0.3.0' }),
  entry('worktree_delta_output_invalid', 'worktree', 'infrastructure_failed', 'The raw revision delta from git was truncated, unterminated, or did not match the record format this server parses.', { since: '0.3.0' }),
  entry('worktree_delta_path_unexpected', 'worktree', 'policy_failure', 'git returned a delta path that is not literally one of the requested paths, so a case or normalization alias was refused.', { since: '0.3.0' }),
  entry('worktree_delta_type_change', 'worktree', 'policy_failure', 'A delta record reported a file type change, which a path-only delta cannot represent safely.', { since: '0.3.0' }),
  entry('worktree_delta_unsafe_mode', 'worktree', 'policy_failure', 'A delta record carried a symbolic link or gitlink mode, which is never used as apply authority.', { since: '0.3.0' }),
  entry('worktree_diff_output_missing', 'worktree', 'infrastructure_failed', 'git reported a successful diff but wrote no patch file, so the diff result could not be trusted.', { since: '0.3.0' }),
  entry('worktree_final_files_failed', 'worktree', 'infrastructure_failed', 'The changed-file list for the final patch could not be listed; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_final_patch_failed', 'worktree', 'infrastructure_failed', 'The final patch could not be produced; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_final_patch_unreadable', 'worktree', 'infrastructure_failed', 'The final patch bytes could not be read back from the scratch directory; the thrown text travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_handle_invalid', 'worktree', 'blocked', 'createWorktree threw, or the returned handle failed its exact-shape snapshot check.'),
  entry('worktree_handle_path_unresolved', 'worktree', 'blocked', 'The paths on a worktree handle could not be resolved to canonical paths inside the state root.', { since: '0.3.0' }),
  entry('worktree_head_unreadable', 'worktree', 'infrastructure_failed', 'HEAD could not be read inside the worktree; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_id_invalid', 'worktree', 'blocked', 'The worktree id is not usable as a directory name under the state root.', { since: '0.3.0' }),
  entry('worktree_id_underivable', 'worktree', 'blocked', 'No filesystem worktree id of at most 64 safe characters could be derived from the run id and purpose.', { since: '0.3.0' }),
  entry('worktree_index_unlocatable', 'worktree', 'infrastructure_failed', 'The worktree index file could not be located at a canonical path owned by that worktree.', { since: '0.3.0' }),
  entry('worktree_not_pristine', 'worktree', 'blocked', 'The revision worktree was not pristine, so patch bytes were not applied into it.', { since: '0.3.0' }),
  entry('worktree_patch_apply_failed', 'worktree', 'infrastructure_failed', 'Applying the verified patch bytes failed and the worktree was rolled back; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_patch_bytes_invalid', 'worktree', 'blocked', 'The patch to apply was not raw buffer bytes.', { since: '0.3.0' }),
  entry('worktree_patch_delta_empty', 'worktree', 'blocked', 'The patch produced no file delta at all, so there was nothing to apply.', { since: '0.3.0' }),
  entry('worktree_patch_digest_invalid', 'worktree', 'blocked', 'The declared patch digest was not a full lowercase 64 character hex string.', { since: '0.3.0' }),
  entry('worktree_patch_digest_mismatch', 'worktree', 'blocked', 'The patch bytes did not hash to the digest declared with them.', { since: '0.3.0' }),
  entry('worktree_patch_preflight_delta_unreadable', 'worktree', 'infrastructure_failed', 'The path and mode preflight of the patch could not be read back from the temporary index; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_patch_preflight_index_failed', 'worktree', 'infrastructure_failed', 'The temporary index for the patch preflight could not be built; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_patch_preflight_rejected', 'worktree', 'blocked', 'The patch did not apply cleanly against the revision in the preflight index; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_patch_preflight_tree_failed', 'worktree', 'infrastructure_failed', 'The expected tree of the patch preflight could not be written; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_patch_processing_failed', 'worktree', 'infrastructure_failed', 'Handling the patch bytes stopped on an unexpected filesystem fault; the thrown text travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_patch_tree_mismatch', 'worktree', 'infrastructure_failed', 'The commit made from the applied patch did not carry exactly the tree the preflight produced.', { since: '0.3.0' }),
  entry('worktree_path_duplicate', 'worktree', 'policy_failure', 'A path appears twice in the authority list, either literally or under case and Unicode folding.', { since: '0.3.0' }),
  entry('worktree_path_in_use', 'worktree', 'blocked', 'The worktree path is registered to a live run, so it was left untouched.', { since: '0.3.0' }),
  entry('worktree_path_list_invalid', 'worktree', 'infrastructure_failed', 'The path allowlist was not a list of non-empty strings, or it exceeded the entry cap.', { since: '0.3.0' }),
  entry('worktree_path_not_canonical', 'worktree', 'blocked', 'A path handed to the worktree layer could not be resolved to a canonical path.', { since: '0.3.0' }),
  entry('worktree_path_outside_state_root', 'worktree', 'blocked', 'A worktree path resolves outside the state root worktrees directory, so it was refused before anything was created or removed.', { since: '0.3.0' }),
  entry('worktree_path_undecodable', 'worktree', 'policy_failure', 'A path carried a NUL byte or a character that did not decode as UTF-8, so it was refused rather than guessed.', { since: '0.3.0' }),
  entry('worktree_path_unsafe', 'worktree', 'policy_failure', 'A path is absolute, ambiguous across platforms, or able to escape the repository, so it was refused.', { since: '0.3.0' }),
  entry('worktree_path_windows_ambiguous', 'worktree', 'policy_failure', 'A path could resolve to a different file, an alternate data stream, or a device name on Windows, so it was not materialized.', { since: '0.3.0' }),
  entry('worktree_project_path_missing', 'worktree', 'blocked', 'The worktree creation call carried no project path.', { since: '0.3.0' }),
  entry('worktree_purpose_invalid', 'worktree', 'blocked', 'The worktree purpose is not one of the lane or evidence purposes this server allows.', { since: '0.3.0' }),
  entry('worktree_restore_unproven', 'worktree', 'infrastructure_failed', 'A patch step failed and the worktree could not be proven restored, so that worktree is quarantined.', { since: '0.3.0' }),
  entry('worktree_revision_invalid', 'worktree', 'blocked', 'The revision is not a full lowercase commit id.', { since: '0.3.0' }),
  entry('worktree_revision_not_commit', 'worktree', 'blocked', 'The revision did not resolve to exactly that commit object; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_revision_pair_invalid', 'worktree', 'blocked', 'The from and to revisions of a delta request are not both full lowercase object ids.', { since: '0.3.0' }),
  entry('worktree_revision_patch_failed', 'worktree', 'infrastructure_failed', 'The patch between two revisions could not be produced; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_revision_patch_unreadable', 'worktree', 'infrastructure_failed', 'The revision patch bytes could not be read back from the scratch directory; the thrown text travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_revision_tree_unresolved', 'worktree', 'infrastructure_failed', 'The tree of a resolved commit could not be read; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_run_id_invalid', 'worktree', 'blocked', 'The run id is not usable as a worktree directory name on every supported platform.', { since: '0.3.0' }),
  entry('worktree_scratch_cleanup_failed', 'worktree', 'infrastructure_failed', 'The private patch scratch directory could not be cleaned up, so the applied result was rolled back.', { since: '0.3.0' }),
  entry('worktree_scratch_failed', 'worktree', 'infrastructure_failed', 'Preparing or reading the patch scratch directory failed; the thrown text travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_scratch_not_removed', 'worktree', 'infrastructure_failed', 'The private patch scratch directory could not be proven removed, so its bytes may still be on disk.', { since: '0.3.0' }),
  entry('worktree_scratch_unusable', 'worktree', 'blocked', 'The scratch directory under the state root could not be proven to be ours and inside the state root.', { since: '0.3.0' }),
  entry('worktree_shared_baseline_mismatch', 'worktree', 'blocked', 'Lane B\'s worktree did not share lane A\'s baseline commit/tree, so the two candidates would not be comparable.'),
  entry('worktree_snapshot_commit_failed', 'worktree', 'infrastructure_failed', 'The worktree snapshot commit failed; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_source_baseline_mismatch', 'worktree', 'blocked', 'The source worktree handle declared a baseline commit/tree that is not what git resolves for it, so the handle itself is corrupt and nothing derived from it can be trusted. Distinct from worktree_shared_baseline_mismatch, which says two candidate lanes do not share one baseline: there the lanes are wrong, here the handle is.', { since: '0.3.0' }),
  entry('worktree_stage_failed', 'worktree', 'infrastructure_failed', 'Staging the worktree changes failed; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_stale_registration_unreclaimed', 'worktree', 'blocked', 'A dead worktree registration left by an earlier run could not be reclaimed; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_state_root_inside_project', 'worktree', 'blocked', 'The state root lives inside the target repository, so worktrees would see each other and the final patch would carry the state root.', { since: '0.3.0' }),
  entry('worktree_state_root_missing', 'worktree', 'blocked', 'The worktree creation call carried no state root path.', { since: '0.3.0' }),
  entry('worktree_status_unreadable', 'worktree', 'infrastructure_failed', 'The worktree status could not be read; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_step_diff_failed', 'worktree', 'infrastructure_failed', 'The diff of a step snapshot could not be produced; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_step_diff_unreadable', 'worktree', 'infrastructure_failed', 'The diff bytes of a step snapshot could not be read back from the scratch directory; the thrown text travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_step_files_failed', 'worktree', 'infrastructure_failed', 'The changed-file list of a step snapshot could not be listed; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_transplant_apply_failed', 'worktree', 'blocked', 'The uncommitted user changes could not be applied into the worktree, so the delegate would have edited stale code; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_transplant_diff_failed', 'worktree', 'infrastructure_failed', 'The patch of the uncommitted user changes could not be produced; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_transplant_files_failed', 'worktree', 'infrastructure_failed', 'The transplant patch was produced, but the list of which uncommitted files it carries could not be read; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_transplant_index_failed', 'worktree', 'infrastructure_failed', 'The temporary index used to transplant uncommitted user changes could not be built; the git output travels in params.detail.', { since: '0.3.0' }),
  entry('worktree_transplant_stage_failed', 'worktree', 'infrastructure_failed', 'The uncommitted user changes could not be staged into the temporary index; the git output travels in params.detail.', { since: '0.3.0' }),
]);

const BY_CODE = new Map(REASON_CODES.map((e) => [e.code, e]));

/**
 * 코드→코드 사상. 생산자는 `REASON.provider_exit_nonzero` 처럼 쓴다 — 오타는 `undefined` 가 되어
 * `fail()` 의 인자 검증과 리터럴 가드에서 죽는다(WS2 §2.2-6). 문자열 리터럴을 쓰면 오타가
 * 조용히 봉투까지 간다.
 */
export const REASON = Object.freeze(Object.fromEntries(REASON_CODES.map((e) => [e.code, e.code])));

/**
 * 옛 이름 → 새 이름. **읽기 전용 별칭**이다(불변식 9, WS2 §2.4).
 *
 * 이미 디스크에 있는 매니페스트·evidence artifact 가 옛 철자를 들고 있고(`stagnated`·`timeout` 은
 * `run-artifacts` 의 닫힌 목록으로 저장되며 reaper 는 다른 플러그인 버전이 쓴 매니페스트도 읽는다),
 * 테스트 러너의 진단 코드는 evidence artifact 에 그대로 실려 있다. 그래서 표는 두 묶음이다:
 * WS0 이 등재했던 93개(형식 위반 92 + 조악값과 철자가 같던 `provider_failed`)의 개명과,
 * 레지스트리에 없던 채로 디스크에 쓰이던 13개의 개명.
 * `schemaVersion` 은 올리지 않는다 — 값 어휘의 확장이지 구조 변경이 아니다.
 *
 * ★ 키 여섯(`verified`·`unverified`·`policy_failure`·`budget_exhausted`·`deadline_exceeded`·
 *   `provider_failed`)은 `STOP_REASONS`·`STATUSES`·`CONFIDENCE` 의 **살아 있는 값**과 철자가 같다.
 *   그래서 이 표는 reasonCode 자리에서만 적용한다 — `normalizeLegacyReasonCode` 의 JSDoc 을 보라.
 */
export const LEGACY_REASON_ALIASES = Object.freeze({
  aborted_before_test: 'test_aborted_before_start',
  adapter_evidence_incomplete: 'evidence_adapter_incomplete',
  all_candidates_blocked: 'run_all_candidates_blocked',
  all_candidates_rejected: 'run_all_candidates_rejected',
  allocation_checkpoint_failed: 'artifact_allocation_checkpoint_failed',
  allowed_tools_required: 'config_allowed_tools_missing',
  attempt_artifact_failed: 'artifact_attempt_write_failed',
  attempt_artifact_too_large: 'artifact_attempt_too_large',
  banned_flag: 'config_flag_banned',
  baseline_not_green: 'test_baseline_not_green',
  binding_preparation_failed: 'run_binding_preparation_failed',
  budget_exhausted: 'lane_budget_exhausted',
  candidate_artifact_failed: 'artifact_candidate_write_failed',
  candidate_manifest_failed: 'artifact_candidate_checkpoint_failed',
  candidate_patch_authority_mismatch: 'artifact_candidate_patch_mismatch',
  candidate_path_authority_mismatch: 'artifact_candidate_path_mismatch',
  candidate_tests_failed: 'test_candidate_failed',
  candidate_witness_missing: 'test_candidate_witness_missing',
  classified_test_record_invalid: 'test_record_invalid',
  cli_exit_nonzero: 'provider_exit_nonzero',
  cli_not_found: 'provider_cli_not_found',
  cli_shim_only: 'provider_cli_shim_only',
  deadline_exceeded: 'judge_deadline',
  deadline_expired: 'test_deadline_expired',
  duplicate_delta_path: 'test_delta_duplicate_path',
  effect_unknown: 'provider_outcome_unknown',
  environment_fingerprint_drift: 'test_environment_drift',
  event_file_cleanup_unproven: 'test_event_file_cleanup_unproven',
  event_file_creation_unproven: 'test_event_file_creation_unproven',
  event_file_identity_drift: 'test_event_file_identity_drift',
  executable_identity_drift: 'test_executable_drift',
  frozen_test_execution_failed: 'test_frozen_execution_failed',
  ignored_test_path: 'test_delta_ignored_path',
  invalid_abort_signal: 'test_abort_signal_invalid',
  invalid_artifact_collision_input: 'artifact_collision_input_invalid',
  invalid_artifact_identity: 'artifact_identity_invalid',
  invalid_artifact_inspection_input: 'artifact_inspection_input_invalid',
  invalid_artifact_paths: 'artifact_paths_invalid',
  invalid_artifact_store: 'artifact_store_invalid',
  invalid_artifact_store_input: 'artifact_store_input_invalid',
  invalid_attempt_artifact_input: 'artifact_attempt_input_invalid',
  invalid_attempt_artifact_record: 'artifact_attempt_record_invalid',
  invalid_candidate_artifact_input: 'artifact_candidate_input_invalid',
  invalid_decision: 'judge_decision_invalid',
  invalid_delta_input: 'test_delta_input_invalid',
  invalid_delta_path: 'test_delta_path_invalid',
  invalid_evidence_artifact_input: 'artifact_evidence_input_invalid',
  invalid_evidence_artifact_record: 'artifact_evidence_record_invalid',
  invalid_evidence_spec: 'evidence_spec_invalid',
  invalid_evidence_worktree: 'evidence_worktree_invalid',
  invalid_format: 'judge_format_invalid',
  invalid_frozen_binding: 'run_binding_invalid',
  invalid_frozen_plan: 'test_plan_invalid',
  invalid_ignored_path: 'test_delta_ignored_path_invalid',
  invalid_initial_manifest: 'artifact_initial_manifest_invalid',
  invalid_json: 'judge_json_invalid',
  invalid_manifest_event: 'artifact_manifest_event_invalid',
  invalid_manifest_event_path: 'artifact_manifest_event_path_invalid',
  invalid_manifest_transition: 'artifact_manifest_transition_invalid',
  invalid_permission_mode: 'config_permission_mode_invalid',
  invalid_run_artifact_store: 'artifact_store_handle_invalid',
  invalid_schema: 'judge_schema_invalid',
  invalid_test_cache_entry: 'test_cache_entry_invalid',
  invalid_test_start: 'test_start_invalid',
  invalid_unsafe_path: 'test_delta_unsafe_path_invalid',
  invalid_worktree_handle: 'worktree_handle_invalid',
  issue_limit_exceeded: 'verifier_issue_limit_exceeded',
  issues_open: 'verifier_issues_open',
  launcher_identity_drift: 'test_launcher_drift',
  machine_failed: 'test_machine_failed',
  manifest_atomic_replace_failed: 'artifact_manifest_replace_failed',
  manifest_authority_mismatch: 'artifact_manifest_authority_mismatch',
  manifest_checkpoint_failed: 'artifact_manifest_checkpoint_failed',
  manifest_event_id_payload_mismatch: 'artifact_manifest_event_payload_mismatch',
  no_test_delta: 'test_delta_empty',
  path_policy_unavailable: 'scope_path_policy_unavailable',
  pinned_definition_drift: 'test_pinned_definition_drift',
  policy_failure: 'scope_policy_failure',
  project_root_not_canonical: 'git_project_root_not_canonical',
  proof_not_proven: 'test_proof_not_proven',
  // 이 키는 조악값 `provider_failed` 와 철자가 같다 — `run-artifacts.mjs` 의 닫힌 writerResults
  // 목록이 이 철자를 attempt 기록에 저장해 왔으므로 읽기 별칭이 필요하다. 그래서
  // `normalizeLegacyReasonCode` 는 reasonCode 자리의 값만 받는다(아래 JSDoc).
  provider_failed: 'provider_reported_failure',
  regression_collection_failed: 'test_regression_collection_failed',
  regression_test_did_not_fail: 'test_regression_did_not_fail',
  regression_witness_missing: 'test_regression_witness_missing',
  seal_failed: 'git_seal_failed',
  selection_manifest_failed: 'artifact_selection_checkpoint_failed',
  selection_unavailable: 'run_selection_unavailable',
  shared_baseline_mismatch: 'worktree_shared_baseline_mismatch',
  snapshot_failed: 'git_snapshot_failed',
  stagnated: 'lane_stagnated',
  tamper_failure: 'scope_tamper_failure',
  timeout: 'provider_deadline_exceeded',
  tool_set_required: 'config_tool_set_missing',
  unknown_role: 'config_role_unknown',
  unsafe_argument: 'config_argument_unsafe',
  unsafe_test_path: 'test_delta_unsafe_path',
  unsafe_tool_pattern: 'config_tool_pattern_unsafe',
  unstable_test_evidence: 'evidence_unstable',
  untrusted_test_helper: 'test_helper_untrusted',
  untrusted_test_plan: 'test_plan_untrusted',
  unverified: 'lane_unverified',
  verified: 'lane_verified',
  winner_alias_failed: 'artifact_winner_alias_failed',
  winner_alias_not_selected: 'artifact_winner_alias_not_selected',
  winner_candidate_artifact_mismatch: 'artifact_winner_candidate_mismatch',
  winner_candidate_artifact_unavailable: 'artifact_winner_candidate_unavailable',
});

/** 코드가 등재돼 있는가. */
export function isReasonCode(code) {
  return typeof code === 'string' && BY_CODE.has(code);
}

/** 등재된 항목을 낸다. 없으면 `undefined` — 던지지 않는다(봉투 경로에서 쓰이므로). */
export function reasonCodeEntry(code) {
  return BY_CODE.get(code);
}

/**
 * 세부 코드가 속한 조악 `stopReason`. 생산자는 `stopReason` 을 직접 고르지 않는다 — 한 코드가
 * 두 조악값으로 나가는 일을 이 함수가 원천 차단한다.
 * 등재 안 된 코드는 **던진다**: 봉투에 실릴 값이 아니라 개발자 오류이므로 조용히 넘기지 않는다.
 */
export function stopReasonOf(code) {
  const found = BY_CODE.get(code);
  if (found === undefined) throw new Error(`unknown reason code: ${String(code)}`);
  return found.stopReason;
}

/** 이 결함이 artifact 저장소를 오염시키는가(WS2 §2.3 — 부분 문자열 판정을 대체한다). */
export function isPoisonCode(code) {
  return BY_CODE.get(code)?.poison === true;
}

/**
 * 디스크에서 읽은 **reasonCode 자리의 값만** 지금 어휘로 올린다. 옛 이름이면 새 이름,
 * 이미 등재된 새 이름이면 그대로, 둘 다 아니면 `null`(호출부가 "모르는 값" 으로 다루게 한다 —
 * 지어내지 않는다).
 *
 * ★ **`stopReason`·`status`·`confidence` 자리의 값은 절대 이 함수에 넣지 않는다.** 그 세 어휘는
 *   닫혀 있고 그 현행 값 여섯이 별칭 표의 **키**와 철자가 같다 — `verified`·`unverified`·
 *   `policy_failure`·`budget_exhausted`·`deadline_exceeded`·`provider_failed`. 예: 봉투의
 *   `confidence: 'unverified'` 를 여기 넣으면 `'lane_unverified'` 라는 **세부 코드**가 조용히
 *   돌아온다(그 자리에 그런 값은 없다). 그 어휘들은 개명 대상이 아니었으므로 정규화할 것이 없다 —
 *   읽은 값을 그대로 쓰고, 이 함수는 `reasonCode`·`blockers[].reasonCode`·`candidates[].reasonCode`·
 *   `operationalFailure.code`·`regressionProof.reasonCodes[]`·`classified.diagnostics[]` 처럼
 *   **세부 코드가 실리는 자리**에서만 부른다(WS2 §2.4). 충돌은 `test/reason-codes.test.mjs` 가 고정한다.
 */
export function normalizeLegacyReasonCode(value) {
  if (typeof value !== 'string') return null;
  if (BY_CODE.has(value)) return value;
  const aliased = Object.hasOwn(LEGACY_REASON_ALIASES, value) ? LEGACY_REASON_ALIASES[value] : null;
  return aliased !== null && BY_CODE.has(aliased) ? aliased : null;
}

/** 형식 규칙 하나로 모은 검사 — 레지스트리 자신과 새 항목 둘 다 이걸로 잰다. */
export function validateReasonCodeShape(code) {
  if (typeof code !== 'string' || !REASON_CODE_FORMAT.test(code)) return 'format';
  if (FORBIDDEN_PREFIXES.some((p) => code.startsWith(p))) return 'forbidden_prefix';
  if (!SUBJECTS.includes(code.split('_')[0])) return 'unknown_subject';
  return null;
}
