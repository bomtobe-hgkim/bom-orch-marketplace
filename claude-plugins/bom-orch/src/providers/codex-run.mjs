import { CODEX_AUTH_NAMES } from './child-env.mjs';
import { collectCodexStream } from './codex-stream.mjs';
import { runCli } from './run-cli.mjs';

/**
 * ★ sendStdin: false — codex exec 는 프롬프트를 **인자로 줘도** stdin EOF 를
 *   기다린다. stderr 에 "Reading additional input from stdin..." 을 찍고 멈춘다
 *   (실측: 닫지 않으면 2분 타임아웃). claude 와 정반대다.
 *
 * 그래서 codex 는 지시문을 argv 로 보낸다. 상한은 8,191(cmd.exe)이 아니라 CreateProcessW 의 명령줄
 * **전체** 32,767자이고, 부딪히는 것은 길이가 아니라 **이스케이프된** 명령줄이다(libuv 가 `"` 마다
 * `\` 를 앞세운다) — 예산·단위·예약분은 `src/preflight.mjs` 에 있다. 넘치면 spawn 이 ENAMETOOLONG.
 */
export function runCodex(options = {}) {
  return runCli({ ...options, authNames: CODEX_AUTH_NAMES, collect: collectCodexStream, sendStdin: false });
}
