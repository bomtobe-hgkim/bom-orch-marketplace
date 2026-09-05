// src/worktree-patch.mjs
/**
 * 일회용 워크트리의 패치 적용·최종 패치 수집 seam.
 *
 * 이 파일은 `src/worktree.mjs` 를 역수입하지 않는다. 경로 소유권·핸들 검증처럼 워크트리
 * 수명주기에 속한 권한은 factory의 lexical 인자로만 받는다. 공개 `deps` 는 git runner만
 * 바꿀 수 있으므로 호출자가 `canonicalHandle`·`checkHandle` 을 덮어써 격리를 약하게
 * 만들 수 없다. 사용자 저장소 적용기(`src/apply-patch.mjs`)와 공유하는 것은 값이 같은
 * 타임아웃과 객체 id 판정뿐이다. 두 적용기의 복구·커밋 권한은 의도적으로 합치지 않는다.
 *
 * ★ 실측 폐포: **18개 모듈 / 6,337줄**(자기 자신 496 포함) — 저장소와 엔진은 0개다.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runGit } from './git.mjs';
import { canonical } from './real-path.mjs';
import { REASON } from './reason-codes.mjs';
import { fail } from './reason-text.mjs';
import { closeScratchRoom, createScratchRoom } from './scratch-rooms.mjs';
import { errorText } from './util/errors.mjs';

/**
 * 워크트리 명령의 시간 상한. `runGit` 의 기본값(30초)보다 넉넉하게 잡는다 — 큰 저장소의
 * `worktree add`(= 전체 체크아웃)와 `add -A`(= 전체 스테이징)는 30초를 넘길 수 있고,
 * 그때 타임아웃으로 끊기면 반쯤 만들어진 워크트리가 남는다.
 */
export const WORKTREE_TIMEOUT_MS = 300_000;

const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const isFullObjectId = (value) => typeof value === 'string' && FULL_OBJECT_ID_PATTERN.test(value);

/**
 * 워크트리 수명주기의 private 권한을 붙여 공개 patch 연산 셋을 만든다.
 *
 * 객체 전체를 보관하거나 공개 deps와 합치지 않고 필요한 이름을 여기서 바로 꺼낸다.
 * 그러면 호출마다 들어오는 `deps`가 권한 함수를 같은 이름으로 덮어쓸 자리가 없다.
 */
export function createWorktreePatchOperations({
  absenceProven,
  canonicalHandle,
  checkHandle,
  commitAll,
  diffToBytes,
  failGit,
  parseRawRevisionDelta,
  resolveRevisionIdentity,
  samePath,
  validateMaterializationPaths,
}) {
  async function locateIndex({ run, cwd }) {
    const [gitDirResult, indexResult] = await Promise.all([
      run({ args: ['rev-parse', '--absolute-git-dir'], cwd, timeoutMs: WORKTREE_TIMEOUT_MS }).catch(() => null),
      run({
        args: ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
        cwd,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      }).catch(() => null),
    ]);
    if (!gitDirResult?.ok || !indexResult?.ok) return null;
    const [gitDir, indexPath] = await Promise.all([
      canonical(gitDirResult.stdout.trim()),
      canonical(indexResult.stdout.trim()),
    ]);
    if (gitDir === null || indexPath === null || !samePath(dirname(indexPath), gitDir)) return null;
    const bytes = await readFile(indexPath).catch(() => null);
    return bytes === null ? null : { gitDir, indexPath, bytes };
  }

  async function restoreAppliedWorktree({ run, cwd, original, savedIndex }) {
    const reset = await run({
      args: ['reset', '--hard', '-q', original.commit],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    const cleaned = await run({
      args: ['clean', '-fdx', '-q'],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    if (!reset?.ok || !cleaned?.ok) return false;

    // reset reconstructs a semantically equal index but can change stat-cache bytes. Restore the exact
    // pristine index only after proving Git put HEAD/worktree back, and revalidate its canonical owner.
    const currentIndex = await locateIndex({ run, cwd });
    if (currentIndex === null || !samePath(currentIndex.gitDir, savedIndex.gitDir) || !samePath(currentIndex.indexPath, savedIndex.indexPath)) {
      return false;
    }
    try {
      await writeFile(currentIndex.indexPath, savedIndex.bytes);
    } catch {
      return false;
    }
    const [identity, status] = await Promise.all([
      resolveRevisionIdentity({ run, cwd, revision: original.commit, requireExact: true }),
      run({
        args: ['status', '--porcelain', '-z', '--ignored=matching'],
        cwd,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      }).catch(() => null),
    ]);
    return identity.ok === true && identity.commit === original.commit && identity.tree === original.tree && status?.ok === true && status.stdout === '';
  }

  /** Verify and apply raw patch bytes only inside a pristine isolated revision worktree. */
  async function applyPatchBytes(wt, spec, deps = {}) {
    const options = spec ?? {};
    const patch = options.patch;
    const expectedSha = options.sha256;
    if (!Buffer.isBuffer(patch)) {
      return fail(REASON.worktree_patch_bytes_invalid);
    }
    if (typeof expectedSha !== 'string' || !SHA256_PATTERN.test(expectedSha)) {
      return fail(REASON.worktree_patch_digest_invalid);
    }
    // ★ `allowIgnored` 는 기본 `false` 다 — 나머지 두 옵션과 같은 자리에서, 같은 셰이프로
    //   검증한다. `undefined`(안 준 것)만 false 로 접고, 그 밖의 비 boolean 은 다른 스펙
    //   결함과 같은 사유(`worktree_patch_bytes_invalid`)로 fail-closed 한다 — 조용히 false 로
    //   접으면 호출자가 오타(`allowIgnored: 'true'`)를 넣었을 때 그대로 엄격 모드로 통과해
    //   버그가 숨는다.
    if (options.allowIgnored !== undefined && typeof options.allowIgnored !== 'boolean') {
      return fail(REASON.worktree_patch_bytes_invalid);
    }
    const allowIgnored = options.allowIgnored === true;
    const actualSha = createHash('sha256').update(patch).digest('hex');
    if (actualSha !== expectedSha) {
      return fail(REASON.worktree_patch_digest_mismatch);
    }

    const paths = await canonicalHandle(wt);
    if (paths.blocked) return paths;
    const run = deps?.run ?? runGit;
    const original = await resolveRevisionIdentity({ run, cwd: paths.path, revision: 'HEAD', requireExact: false });
    if (original.blocked) return original;
    // ★★ 기본은 `--ignored=matching` 로 무시된 항목까지 pristine 판정에 넣는다 — 레인/재시도
    //   패치는 **손대지 않은** 트리에만 얹혀야 하고(무시된 산출물이 있다는 것 자체가 워크트리가
    //   더 이상 그때 그 바닥이 아니라는 신호다), 이 검사가 느슨해지면 조용히 섞여든 빌드
    //   산출물 위에 패치가 얹혀서 다음 스텝이 뭘 보고 있는지 아무도 모르게 된다.
    //
    //   `allowIgnored:true` 는 그 규칙의 **유일한** 예외다: 증거 셀(`br`)의 워크트리는
    //   `createWorktree` 가 만들자마자 그 자리에서 lockfile 로 `node_modules/` 를 심는다
    //   (레인은 `createEvidenceWorktree`(`src/run-lane-adapters.mjs`), prove 는
    //   `createProofWorktree`(`src/proof-stage.mjs`)) — 그 뒤에야 이 함수가 테스트 전용
    //   델타를 얹는다. 그 `node_modules/` 는 침입이 아니라 **이번 실행이 기록한 환경 그
    //   자체**다. 실행 10, prove attempt 3(2026-08-31) 실측: `tests.provisionDeps:
    //   'lockfile-install'` 켜진 여섯 칸 증명에서 c/1·b0/1·b0/2 가 초록으로 끝난 뒤 br/1 이
    //   `--ignored=matching` 에 걸려 `worktree_not_pristine` → `test_delta_apply_failed` 로
    //   죽었고 증명 전체가 `unavailable` 로 기록됐다(`cost.testRuns.count` 4). b0/c 는 이
    //   함수를 아예 안 부르고, provisioning 이 없으면 `node_modules/` 도 없어 통과했으므로
    //   실행 1~9 나 어떤 단위 테스트도 이 자리를 밟지 못했다.
    const pristineArgs = allowIgnored
      ? ['status', '--porcelain', '-z']
      : ['status', '--porcelain', '-z', '--ignored=matching'];
    const pristine = await run({
      args: pristineArgs,
      cwd: paths.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    }).catch(() => null);
    if (!pristine?.ok || pristine.stdout !== '') {
      return fail(REASON.worktree_not_pristine);
    }
    const savedIndex = await locateIndex({ run, cwd: paths.path });
    if (savedIndex === null) {
      return fail(REASON.worktree_index_unlocatable);
    }
    if (patch.length === 0) return original;

    let scratchRoom = null;
    let operationPath;
    let patchPath;
    let indexPath;
    let actualStarted = false;
    let successfulIdentity = null;
    try {
      const opened = await createScratchRoom({ stateRoot: paths.stateRoot, kind: 'worktree_apply' });
      if (!opened.ok) return fail(REASON.worktree_scratch_unusable);
      scratchRoom = opened.handle;
      operationPath = opened.handle.path;
      patchPath = join(operationPath, 'patch');
      indexPath = join(operationPath, 'index');
      await writeFile(patchPath, patch, { flag: 'wx' });
      const tempEnv = { GIT_INDEX_FILE: indexPath };
      const readTree = await run({
        args: ['read-tree', original.commit],
        cwd: paths.path,
        env: tempEnv,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
      if (!readTree.ok) {
        return failGit(REASON.worktree_patch_preflight_index_failed, readTree);
      }
      const preflightApply = await run({
        args: ['apply', '--cached', '--whitespace=nowarn', patchPath],
        cwd: paths.path,
        env: tempEnv,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
      if (!preflightApply.ok) {
        return failGit(REASON.worktree_patch_preflight_rejected, preflightApply);
      }
      const raw = await run({
        args: ['diff', '--cached', '--no-patch', '--raw', '-z', '--no-abbrev', '--no-renames', original.commit],
        cwd: paths.path,
        env: tempEnv,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
      if (!raw.ok) {
        return failGit(REASON.worktree_patch_preflight_delta_unreadable, raw);
      }
      const delta = parseRawRevisionDelta(raw.stdout);
      if (!delta.ok || delta.entries.length === 0) {
        return delta.ok ? fail(REASON.worktree_patch_delta_empty) : fail(delta.reasonCode, delta.params);
      }
      const materialization = validateMaterializationPaths(delta.entries.map((entry) => entry.path));
      if (!materialization.ok) {
        return fail(materialization.reasonCode, materialization.params);
      }
      const expectedTreeResult = await run({
        args: ['write-tree'],
        cwd: paths.path,
        env: tempEnv,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
      const expectedTree = expectedTreeResult?.ok && typeof expectedTreeResult.stdout === 'string'
        ? expectedTreeResult.stdout.trim()
        : '';
      if (!isFullObjectId(expectedTree)) {
        return failGit(REASON.worktree_patch_preflight_tree_failed, expectedTreeResult);
      }

      actualStarted = true;
      const applied = await run({
        args: ['apply', '--index', '--whitespace=nowarn', patchPath],
        cwd: paths.path,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
      if (!applied.ok) {
        const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
        if (!restored) {
          return fail(REASON.worktree_restore_unproven);
        }
        return failGit(REASON.worktree_patch_apply_failed, applied);
      }
      const committed = await commitAll({ run, worktreePath: paths.path, label: `bom-orch apply ${actualSha.slice(0, 12)}` });
      if (committed.blocked) {
        const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
        if (!restored) {
          return fail(REASON.worktree_restore_unproven);
        }
        return committed;
      }
      const identity = await resolveRevisionIdentity({ run, cwd: paths.path, revision: committed.commit, requireExact: true });
      if (identity.blocked) {
        const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
        if (!restored) {
          return fail(REASON.worktree_restore_unproven);
        }
        return identity;
      }
      // ★ 같은 `allowIgnored` 로 같은 완화다 — 사전 pristine 검사가 통과시킨 무시 경로를
      //   사후 clean 검사가 다시 걸어 넣으면(둘이 다른 인자를 쓰면) 위 예외가 반쪽만 선다.
      const clean = await run({
        args: pristineArgs,
        cwd: paths.path,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      }).catch(() => null);
      if (identity.tree !== expectedTree || !clean?.ok || clean.stdout !== '') {
        const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex });
        if (!restored) {
          return fail(REASON.worktree_restore_unproven);
        }
        return fail(REASON.worktree_patch_tree_mismatch);
      }
      successfulIdentity = identity;
      return identity;
    } catch (error) {
      if (actualStarted) {
        const restored = await restoreAppliedWorktree({ run, cwd: paths.path, original, savedIndex }).catch(() => false);
        if (!restored) {
          return fail(REASON.worktree_restore_unproven);
        }
      }
      return fail(REASON.worktree_patch_processing_failed, { detail: errorText(error) });
    } finally {
      const closed = scratchRoom === null
        ? { ok: true }
        : await closeScratchRoom(scratchRoom).catch(() => ({ ok: false }));
      const operationRemoved = closed.ok && (scratchRoom === null || await absenceProven(operationPath));
      if (!operationRemoved) {
        const restored = !actualStarted || await restoreAppliedWorktree({
          run,
          cwd: paths.path,
          original,
          savedIndex,
        }).catch(() => false);
        return fail(restored ? REASON.worktree_scratch_cleanup_failed : REASON.worktree_restore_unproven);
      }
      if (successfulIdentity !== null) wt.lastSnapshot = successfulIdentity.commit;
    }
  }

  // ── 최종 패치 ─────────────────────────────────────────────────────────────

  /**
   * baseline 대비 워크트리의 변경을 하나의 패치로 뽑는다.
   *
   * ★ **"전체" 가 아니다.** 예전 문장은 "baseline 대비 워크트리의 **전체** 변경"이라고
   *   확언했는데 거짓이다 — `add -A` 는 무시 규칙을 존중하고 gitlink 경계에서 멈춘다.
   *   실제로 빠지는 것과 그때 봉투에 실리는 신호는 이렇다:
   *
   *     저장소가 커밋한 `.gitignore` 에 걸린 파일  -> `ignoredPaths`
   *     gitlink(중첩 저장소·서브모듈) 안의 내용     -> `gitlinks`
   *     인덱스에만 있는 모드 변경                   -> 아래 '알려진 한계'
   *
   *   그래서 `empty: true` 를 "델리게이트가 아무것도 안 했다"로 읽으면 안 된다.
   *   `ignoredPaths`·`gitlinks` 가 비어 있을 때만 그렇게 읽을 수 있고, 둘 중 하나가
   *   `null` 이면 **모르는 것**이다.
   *
   * 마지막 스냅샷 뒤에 남은 미커밋 작업도 담아야 하므로, 커밋을 쌓는 대신 워크트리
   * 인덱스에 `add -A` 로 전부 올려 두고 baseline 과 비교한다(워크트리는 일회용이라
   * 인덱스를 건드려도 사용자에게 영향이 없다).
   *
   * `--binary` 는 필수다 — 없으면 바이너리 변경이 "Binary files differ" 한 줄로 뭉개져
   * 적용할 수 없는 패치가 된다.
   *
   * ★ 이 패치는 **사용자 저장소에 적용된다.** 그래서 바이트가 걸린 자리 중 가장 위험한
   *   곳이다: 델리게이트가 EUC-KR 파일을 쓰면 utf8 왕복이 모지바케 패치를 만들고, 그것이
   *   사용자 파일을 손상시킨다. 여기서만은 문자열을 거치지 않는다(모듈 상단의 바이트 계약).
   *
   * @returns `{ ok: true, patch, empty, files, ignoredPaths, gitlinks }` 또는 blocked 봉투.
   *   `patch` 는 **Buffer** 다 — 파일로 쓸 때는 그대로, 헤더를 볼 때는 `toString('latin1')`.
   *   나머지 셋은 모듈 상단의 "무엇이 바뀌었는지는 `files` 에서만 읽어라" 계약과
   *   아래 각 헬퍼의 주석을 보라.
   */
  async function collectPatch(wt, deps = {}) {
    const run = deps.run ?? runGit;
    const guard = checkHandle(wt);
    if (guard) return guard;

    const staged = await run({ args: ['add', '-A'], cwd: wt.path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!staged.ok) {
      return failGit(REASON.worktree_stage_failed, staged);
    }

    const patch = await diffToBytes({
      run,
      args: ['diff', '--cached', '--binary', wt.baseline],
      cwd: wt.path,
      stateRoot: wt.stateRoot,
    });
    // 여기서도 `ok` 를 먼저 본다(diffToBytes 가 그 순서를 지킨다). 빈 패치를 "변경 없음"
    // 으로 먼저 읽으면 diff 실패가 "델리게이트가 아무것도 안 했다" 로 둔갑하고,
    // 오케스트레이터는 성과 0 으로 기록한 뒤 실제로 만들어진 코드를 통째로 버린다.
    if (patch.failure) return failGit(REASON.worktree_final_patch_failed, patch.failure);
    if (patch.crashed) return fail(REASON.worktree_final_patch_unreadable, { detail: errorText(patch.crashed) });

    // ★ I-7. 패치 파싱에 의존하지 않는 **파일 목록**을 같은 리비전 쌍으로 한 번 더 뜬다.
    //   이유와 계약은 모듈 상단의 "무엇이 바뀌었는지는 `files` 에서만 읽어라" 를 보라.
    //   여기서 실패하면 **blocked** 다 — 빈 배열로 떨어뜨리면 "델리게이트가 아무것도
    //   안 건드렸다" 가 되어 스코프 검사가 무조건 통과한다. `patch.failure` 를 blocked
    //   로 다루는 것과 같은 근거이고, 같은 `diff` 명령 계열이라 대칭이기도 하다.
    const names = await run({
      args: ['diff', '--cached', '--name-only', '-z', '--no-renames', wt.baseline],
      cwd: wt.path,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!names.ok) return failGit(REASON.worktree_final_files_failed, names);
    const files = names.stdout.split('\0').filter((entry) => entry !== '');

    return {
      ok: true,
      patch: patch.bytes,
      empty: patch.bytes.length === 0,
      files,
      ignoredPaths: await collectIgnoredPaths({ run, cwd: wt.path }),
      gitlinks: await collectGitlinks({ run, cwd: wt.path }),
    };
  }

  /**
   * 무시 규칙에 걸려 **패치에 실리지 않은**(수집 방향) 또는 **워크트리에 오지 않은**
   * (이식 방향) 경로. 없으면 `[]`, 못 보면 `null`.
   *
   * ★ C-2b. 적대자가 없는 경로다. 평범한 저장소의 커밋된 `.gitignore` 가
   *   `build/`·`dist/` 를 무시하는데 델리게이트에게 "생성물을 거기 만들어라"라고 지시하는
   *   것은 극히 흔하다. 그러면 세 API 가 전부 "아무 일도 없었다"고 보고하는데 파일은
   *   디스크에 있다(리뷰어 재현: `clean:true` / `empty:true` / 파일 존재).
   *   `collectPatch` 자신의 주석이 그 결과를 금지한다.
   *
   *   무시 규칙 자체는 무력화하지 않는다 — 커밋된 `.gitignore` 도, 사용자의 전역 무시
   *   파일도 정당한 설정이다(`src/git.mjs` 의 `HARDENING_ARGS` 주석 참조). 대신 조용하지
   *   않게 한다. 특히 `empty:true` + 무시된 산출물 존재 조합은 "성과 0" 과 반드시
   *   구분해야 한다.
   *
   * ★ **`-z` 가 필수다.** `--porcelain` 의 기본 출력은 경로를 C-인용한다 — 이 축은
   *   `core.quotePath` 와 무관하게 **공백 하나로도** 발화한다(실측):
   *
   *     기본            !! plain.log / !! "sub dir/deep.log" / !! "with space.log"
   *                     !! "\355\225\234\352\270\200\353\241\234\352\267\270.log"
   *     quotePath=false !! "sub dir/deep.log" / !! "with space.log"   <- 공백은 그대로 인용
   *     -z              !! plain.log | !! sub dir/deep.log | !! with space.log | !! 한글로그.log
   *
   *   이 필드는 계약상 **경로 목록**이고 다운스트림이 `join()` 해서 연다. 인용된 문자열은
   *   존재하지 않는 경로가 되어 검사가 조용히 no-op 이 된다. 같은 이유로 `.trim()` 도
   *   쓰지 않는다 — POSIX 에서 이름 끝의 정당한 공백을 먹는다.
   *
   * ★ `null` 을 `[]` 로 뭉개지 마라. 빈 배열은 "무시된 변경이 없다", `null` 은 "확인하지
   *   못했다" 다. 조회 실패로 blocked 를 내지는 않는다 — 이것은 정보를 **더하는** 진단이라,
   *   실패했다고 델리게이트의 진짜 작업이 든 패치를 통째로 버리는 것이 더 나쁘다.
   */
  async function collectIgnoredPaths({ run, cwd }) {
    const got = await run({
      args: ['status', '--porcelain', '-z', '--ignored=matching'],
      cwd,
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!got.ok || typeof got.stdout !== 'string') return null;
    return got.stdout
      .split('\0')
      .filter((record) => record.startsWith('!! '))
      .map((record) => record.slice(3))
      .filter((entry) => entry !== '');
  }

  /**
   * 워크트리 인덱스의 **gitlink**(mode `160000`) 목록. 없으면 `[]`, 못 보면 `null`.
   *
   * ★ I-1. 델리게이트가 `git init` 한 디렉터리(스캐폴더가 흔히 한다)나 사용자 저장소의
   *   서브모듈은 gitlink 로만 기록되고 **내용이 패치에 실리지 않는다.** 리뷰어 재현:
   *   최종 패치는 `new file mode 160000` + `+Subproject commit …` 뿐이고, 적용해도
   *   `vendor/lib.js` 는 생기지 않는다 — 산출물 전량 유실인데 봉투는 `ok:true` 다.
   *
   *   **완전한 서브모듈 지원은 이번 범위 밖이다.** 여기서 하는 것은 "내용이 사라졌다"를
   *   성공으로 조용히 보고하지 않는 것뿐이다.
   *
   * ★ 왜 하필 `ls-files -s` 인가 (다른 후보는 전부 무효임이 실측됐다):
   *   `status --porcelain --ignored=matching`·`-uall`·`ls-files -o`·`add -A --dry-run` 은
   *   서브모듈 경우에 **전부 빈 출력**이다. `add -A` 의 stderr 경고
   *   ("adding embedded git repository")는 새로 만든 gitlink 에만 나오고 exit 0 이라
   *   놓치기 쉽다. `160000` 항목은 새 gitlink 와 기존 gitlink 를 **둘 다** 잡는다.
   *
   * ★ **`-z` 가 필수다.** `ls-files -s` 의 기본 출력도 경로를 C-인용한다. 여기서는 공백이
   *   아니라 **비 ASCII** 가 축이다(실측):
   *
   *     기본  160000 … 0\tsub plain                      <- 공백은 그대로 나온다
   *           160000 … 0\t"\354\204\234\353\270\214…"    <- 비 ASCII 는 인용된다
   *     -z    160000 … 0\t서브모듈
   *
   *   한국어 경로가 일상인 이 프로젝트에서는 평범한 입력이다. `-z` 를 붙여도 레코드
   *   형식(`<mode> <sha> <stage>\t<path>`)은 그대로다.
   *
   * ★ `null` 과 `[]` 의 구분은 위 `collectIgnoredPaths` 와 같다.
   */
  async function collectGitlinks({ run, cwd }) {
    const got = await run({ args: ['ls-files', '-s', '-z'], cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!got.ok || typeof got.stdout !== 'string') return null;
    const found = [];
    for (const record of got.stdout.split('\0')) {
      if (!record.startsWith('160000 ')) continue;
      // "160000 <sha> <stage>\t<path>" — 경로는 탭 뒤다. `-z` 라 인용도 escape 도 없다.
      const tab = record.indexOf('\t');
      if (tab !== -1) found.push(record.slice(tab + 1));
    }
    return found;
  }

  // ── 상태 조회 ─────────────────────────────────────────────────────────────

  /**
   * 이 워크트리에서 **무시 규칙에 걸린** 경로. 없으면 `[]`, 못 보면 `null`.
   *
   * `collectPatch` 가 봉투에 싣는 것과 같은 값이지만, 호출자가 **최종 패치를 뜨기 전에도**
   * 물을 수 있어야 한다. 스텝별 스코프 검사가 그렇다: `add -A` 기반 관측(스냅샷·`files`)은
   * 무시 규칙에 걸린 쓰기를 전부 놓치므로, 그 목록을 따로 얹지 않으면 예컨대 사용자 전역
   * 무시 규칙에 걸리는 `.claude/settings.local.json` 같은 쓰기가 검사에 아예 안 보인다.
   *
   * 갓 만든 워크트리에는 무시된 파일이 없다 — 이식이 무시 규칙을 존중하기 때문이다. 그래서
   * 여기 나오는 것은 그 워크트리 안에서 **새로 생긴** 것이다.
   */
  async function listIgnoredPaths(wt, deps = {}) {
    const run = deps.run ?? runGit;
    const guard = checkHandle(wt);
    if (guard) return guard;
    return collectIgnoredPaths({ run, cwd: wt.path });
  }

  return Object.freeze({
    applyPatchBytes,
    collectIgnoredPaths,
    collectPatch,
    listIgnoredPaths,
  });
}
