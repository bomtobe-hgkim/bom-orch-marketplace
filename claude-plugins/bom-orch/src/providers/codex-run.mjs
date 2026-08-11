import { CODEX_AUTH_NAMES } from './child-env.mjs';
import { collectCodexStream } from './codex-stream.mjs';
import { runCli } from './run-cli.mjs';

/**
 * ★ sendStdin: false — codex exec 는 프롬프트를 **인자로 줘도** stdin EOF 를
 *   기다린다. stderr 에 "Reading additional input from stdin..." 을 찍고 멈춘다
 *   (실측: 닫지 않으면 2분 타임아웃). claude 와 정반대다.
 *
 * 그래서 codex 는 지시문을 argv 로 보낸다. Windows 명령줄 상한(8191자)에 걸릴 수
 * 있는데, 프롬프트가 그보다 길면 codex 쪽 실행이 실패한다 — Task 20 에서 실제
 * 상한을 재고, 필요하면 `-` 를 써서 stdin 으로 넘기는 경로를 검토한다.
 */
export function runCodex(options = {}) {
  return runCli({ ...options, authNames: CODEX_AUTH_NAMES, collect: collectCodexStream, sendStdin: false });
}
