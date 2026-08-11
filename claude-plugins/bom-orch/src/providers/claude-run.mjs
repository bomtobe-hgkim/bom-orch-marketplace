import { CLAUDE_AUTH_NAMES } from './child-env.mjs';
import { collectStream } from './claude-stream.mjs';
import { runCli } from './run-cli.mjs';

export { createLineSplitter } from './run-cli.mjs';

/** claude 는 지시문을 stdin 으로 받는다. argv 로 보내면 Windows 명령줄 상한에 걸린다. */
export function runClaude(options = {}) {
  return runCli({ ...options, authNames: CLAUDE_AUTH_NAMES, collect: collectStream, sendStdin: true });
}
