import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { REASON } from './reason-codes.mjs';
import { renderReason } from './reason-text.mjs';
import { closeScratchRoom, createScratchRoom } from './scratch-rooms.mjs';
import { errorText } from './util/errors.mjs';
import { WORKTREE_TIMEOUT_MS } from './worktree-patch.mjs';

/**
 * `git diff` 의 출력을 파일로 직접 받아 원시 바이트로 돌려주는 공용 경계다.
 * revision 증거와 현재 워크트리 패치가 함께 쓰므로 어느 한 흐름의 모듈에 둘 수 없다.
 */
export async function diffToFile({ run, args, cwd, env, patchPath }) {
  const separator = args.indexOf('--');
  const outputArg = `--output=${patchPath}`;
  const finalArgs = separator === -1
    ? [...args, outputArg]
    : [...args.slice(0, separator), outputArg, ...args.slice(separator)];
  const got = await run({
    args: finalArgs,
    cwd,
    env,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });

  // 실패를 먼저 본다. 실패가 우연히 남긴 0바이트 파일을 "변경 없음"으로 읽으면 안 된다.
  if (!got.ok) return { failure: got };

  // 실측 git은 빈 diff도 0바이트 output 파일을 만든다. 성공했는데 파일이 없으면 정상값이 아니다.
  const size = await stat(patchPath).then((entry) => entry.size, () => null);
  if (size === null) {
    return {
      failure: {
        ok: false,
        stdout: '',
        stderr: renderReason(REASON.worktree_diff_output_missing, { path: patchPath }).error,
        exitCode: null,
        failed: true,
        timedOut: false,
        reasonCode: REASON.worktree_diff_output_missing,
        stderrTail: null,
      },
    };
  }
  return { size };
}

/**
 * 임시 파일의 수명은 durable scratch-room registry가 소유한다. 정상 종료는 정확한 token과
 * identity가 맞는 방만 닫고, 교체되었거나 소유권이 흐린 방은 보존해 다음 sweep에 넘긴다.
 */
export async function diffToBytes({ run, args, cwd, env, stateRoot }) {
  let scratchRoom = null;
  let outcome;
  try {
    const opened = await createScratchRoom({ stateRoot, kind: 'diff' });
    if (!opened.ok) throw new Error(renderReason(REASON.worktree_scratch_unusable).error);
    scratchRoom = opened.handle;
    const patchPath = join(opened.handle.path, 'patch');
    const wrote = await diffToFile({ run, args, cwd, env, patchPath });
    if (wrote.failure) outcome = wrote;
    else if (wrote.size === 0) outcome = { bytes: Buffer.alloc(0) };
    else outcome = { bytes: await readFile(patchPath) };
  } catch (error) {
    outcome = { crashed: new Error(renderReason(REASON.worktree_scratch_failed, { detail: errorText(error) }).error) };
  }
  if (scratchRoom !== null) {
    const closed = await closeScratchRoom(scratchRoom).catch(() => ({ ok: false }));
    if (!closed.ok) return { crashed: new Error(renderReason(REASON.worktree_scratch_not_removed).error) };
  }
  return outcome;
}
