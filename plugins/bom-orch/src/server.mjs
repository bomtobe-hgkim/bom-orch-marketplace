#!/usr/bin/env node
/**
 * stdio MCP 서버.
 *
 * ★ stdout 은 프로토콜 전용이다. 모든 바이트가 JSON-RPC 프레임이라 로그 한 줄이
 *   프레임 사이에 끼면 호스트가 연결을 끊는다. 증상은 "플러그인이 그냥 안 뜬다"로만
 *   보여서 원인을 짚기 매우 어렵다. 로그는 stderr 로만 — 그리고 그걸 사람 기억이
 *   아니라 test/guards/no-stdout-writes.test.mjs 가 막는다.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { callTool, listTools, makeProgressReporter } from './tools.mjs';
import { HOST_ABORT_REASON } from './deadline.mjs';
import { failure, serializeToolResult } from './envelope.mjs';
import { sweepOrphans } from './reaper.mjs';
import { joinNotices } from './run-faults.mjs';
import { resolveStateRoot } from './state-root.mjs';
import { stateSchemaNotice } from './state-schema.mjs';
import { afterStartupSweep } from './startup-barrier.mjs';
import { REASON } from './reason-codes.mjs';
import { errorText } from './util/errors.mjs';
import { SERVER_VERSION } from './version.mjs';
import { isWorktreeGitEffectHelper, runWorktreeGitEffectHelper } from './worktree-git-effect.mjs';

if (isWorktreeGitEffectHelper()) {
  await runWorktreeGitEffectHelper();
} else {
const REQUIRED_NODE_VERSION = { major: 22, minor: 11, patch: 0 };

/**
 * 협상할 MCP 프로토콜 버전을 의도적으로 고정한다.
 *
 * ★ SDK 의 기본 협상은 클라이언트가 요청한 버전이 SDK 가 아는 목록에 있으면 그걸
 *   그대로 돌려주고, 없으면 SDK 가 최신으로 아는 리비전으로 돌려준다. 그 "최신"은
 *   SDK 버전을 올릴 때마다 같이 올라간다 — 그중에는 initialize 핸드셰이크·
 *   Mcp-Session-Id·ping 을 들어내는 wire-breaking 리비전(2026-07-28 계열)도 있다.
 *   SDK 기본값을 무심코 따라가면 두 호스트 중 한쪽과의 호환이 조용히 깨질 수
 *   있으므로, 우리가 실제로 검증한 값 하나로 못박는다.
 */
const PINNED_PROTOCOL_VERSION = '2024-11-05';

/** "v22.11.0" 같은 문자열을 {major,minor,patch} 로 읽는다. 못 읽으면 null. */
function parseNodeVersion(raw) {
  const match = typeof raw === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** a 가 b 보다 낮은 버전인가. */
function isLowerVersion(a, b) {
  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  return a.patch < b.patch;
}

/**
 * 지금 이 프로세스가 최소 요구 버전(package.json 의 engines.node)을 만족하는가.
 *
 * ★ `BOM_ORCH_FAKE_NODE_VERSION` 은 테스트 전용 우회로다 — 이 게이트 자체를 검증하려면
 *   낮은 버전에서 도는 상황을 흉내 내야 하는데, 테스트를 실제로 낮은 Node 로 돌릴 수는
 *   없다. 그래서 환경 변수로 "가짜 버전"을 주입한다. 다만 실제 버전보다 **낮은** 값만
 *   받아들인다 — 그래야 진짜로 못 도는(실제로 더 낮은) 환경을 이 변수로 통과시키는
 *   용도로는 못 쓴다.
 */
function checkNodeVersion(env = process.env, actualVersionString = process.version) {
  const actual = parseNodeVersion(actualVersionString);
  let effective = actual;

  const fakeRaw = env.BOM_ORCH_FAKE_NODE_VERSION;
  if (typeof fakeRaw === 'string' && fakeRaw !== '') {
    const fake = parseNodeVersion(fakeRaw);
    if (fake && actual && isLowerVersion(fake, actual)) effective = fake;
  }

  return Boolean(effective) && !isLowerVersion(effective, REQUIRED_NODE_VERSION);
}

// ★ 부팅 진단 넷(이 줄과 아래 셋)은 **stderr 로만** 나가고 봉투에는 실리지 않는다. 그래서
//   `REASON_TEXT` 정본을 거치지 않고 여기 영어로 적는다 — 정본은 "밖으로 나가는 실패 문구"
//   (봉투의 error·recovery·notice)의 자리이고, 이 넷은 그 채널이 아직 없을 때의 로그다.
if (!checkNodeVersion()) {
  console.error(
    `bom-orch requires Node.js 22.11 or newer; this is ${process.version}. Upgrade Node and start it again.`,
  );
  process.exit(1);
}

// ★ 델리게이트 하나가 처리되지 않은 예외/거부를 던졌다고 서버 전체가 죽으면 그
//   세션의 모든 도구가 함께 사라진다. stderr 에 기록하고 살아남는다.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('uncaught exception:', error);
});

const stateRoot = resolveStateRoot();

// 부팅 시점에는 보호할 run ID 를 아직 모른다. 따라서 scratch 와 child/worktree
// 원장만 비동기로 정리하고 patch/run namespace 는 per-run collision 검사 뒤로 미룬다.
// ★ 부팅 훑기 — 딱 한 번, **여기서** 시작하고 아래 핸드셰이크에서는 await 하지 않는다. 세션
//   중간에 또 부르면 이 세션이 방금 등록한 자식을 죽인다(reaper 의 원장은 상태 루트당 하나다).
//   타이머도, 두 번째 호출 지점도 두지 않는다. 기록마다 프로세스 프로브를 돌려 수백 ms 씩
//   걸리는데 MCP 핸드셰이크가 그걸 기다리면 안 된다. sweepOrphans 는 던지지 않으므로
//   잡을 것도 없다(reaper.mjs 참고).
const startupSweep = sweepOrphans({ stateRoot, sweepPatches: false, sweepRuns: false });

/** 핸드셰이크는 기다리지 않되, 도구 응답은 부팅 스윕이 발견한 버전 스큐를 숨기지 않는다. */
function withStartupNotices(envelope, swept) {
  const notices = [
    typeof envelope?.notice === 'string' && envelope.notice !== '' ? envelope.notice : null,
    stateSchemaNotice(swept?.stateSchema), stateSchemaNotice(swept?.npmCache?.stateSchema),
  ].filter((notice) => notice !== null);
  return notices.length === 0 ? envelope : { ...envelope, notice: joinNotices(notices) };
}

/**
 * ★ 중첩 실행 가드. 델리게이트를 스폰할 때 자식 env 에 `BOM_ORCH_RUN_ID` 를 찍는다
 *   (providers/child-env.mjs). 이 프로세스가 부팅할 때 **자기 자신의** env 에 그게
 *   이미 있다면, 이 프로세스 자체가 우리가 만든 자식 프로세스 안에서 또 도는
 *   것이다 — 막지 않으면 델리게이트가 델리게이트를 부르는 무한 재귀가 된다.
 *
 *   서버 기동 자체를 실패시키지 않는다(★) — 도구 호출만 거부한다. 호스트가 서버
 *   기동 실패를 조용히 삼키면 사용자는 이유를 전혀 볼 수 없기 때문이다. 대신
 *   서버는 정상적으로 뜨고, 모든 도구 호출에 `status: "blocked"` 봉투로 이유와
 *   recovery 를 실어 응답한다.
 */
const nestedRunId =
  typeof process.env.BOM_ORCH_RUN_ID === 'string' && process.env.BOM_ORCH_RUN_ID !== ''
    ? process.env.BOM_ORCH_RUN_ID
    : null;
if (nestedRunId !== null) {
  console.error(
    `nested run detected: BOM_ORCH_RUN_ID=${nestedRunId} is already set. ` +
      'This process looks like it is running inside a delegate we started, so every tool call is refused.',
  );
}

const server = new Server({ name: 'bom-orch', version: SERVER_VERSION }, { capabilities: { tools: {} } });

// ★ 프로토콜 버전 핀. `Server` 생성자에는 협상 버전을 지정하는 옵션이 없다(SDK
//   1.29.0 확인) — 유일한 지점은 `initialize` 요청 핸들러뿐이다. `setRequestHandler`
//   는 같은 메서드에 대해 나중 호출이 이전 핸들러를 대체한다고 SDK 가 문서화하므로,
//   생성자가 등록한 기본 `_oninitialize` 를 그대로 불러(클라이언트 capabilities 기록
//   등 부수효과를 보존한다) 결과의 `protocolVersion` 필드만 우리가 검증한 값으로
//   덮어쓴다.
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  const result = await server._oninitialize(request);
  return { ...result, protocolVersion: PINNED_PROTOCOL_VERSION };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

/**
 * ★ 호스트가 실행을 끊는 **세 경로**를 도구 호출 하나당 AbortController 하나로 접는다
 *   (WS3 §0-C1). 셋: 요청 취소(`extra.signal` — SDK 가 `notifications/cancelled` 를 받으면
 *   발화시킨다), 프로세스 종료 신호(SIGTERM), 전송 종료(호스트가 파이프를 닫거나
 *   `server.close()` 로 transport 가 닫힌다). 예전에는 셋 다 이 프로세스에 **아무 흔적도
 *   남기지 않았다** — `extra` 에서 읽는 것은 `sendNotification` 하나뿐이었고 수명주기 훅은
 *   없었다. 호스트가 취소해도 실행은 데드라인까지 벤더를 계속 돌렸다.
 *
 * ★ 이 태스크는 **배선까지만**이다. 엔진은 이 신호를 아직 읽지 않는다(정지 권위는 여전히
 *   데드라인 하나다). 태스크 7 이 `AbortSignal.any([deadline, hostSignal])` 로 둘을 합치고
 *   `signal.reason` 으로 갈라 `run_cancelled` 봉투를 만든다 — 그래서 abort 에 이유를 싣는다.
 *
 * ★ 왜 집합인가: SIGTERM 과 전송 종료는 **프로세스 하나**의 사건이라 호출마다 리스너를 달면
 *   동시 호출 수만큼 샌다. 리스너는 첫 호출이 달고 마지막 호출이 뗀다(`armHostShutdown`/
 *   `disarmHostShutdown`) — 그 하나가 살아 있는 컨트롤러 전부를 끊는다.
 */
const inFlightHostAborts = new Set();
/** 호출 하나가 **봉투로 정산될 때** 풀리는 약속들. 종료가 기다리는 것이 이것이다. */
const inFlightSettlements = new Set();
/** 전송이 아직 쓰고 있는 응답들. 이것이 비어야 취소 봉투의 바이트가 호스트에 닿는다. */
const pendingSends = new Set();
let shuttingDown = false;

/**
 * 종료가 정산을 기다리는 상한.
 *
 * ★ 엔진의 하드스톱 유예(10초, `HARD_STOP_GRACE_MS`)보다 커야 한다 — 여기서 더 짧게 기다리면
 *   단계 하나가 그 유예를 다 쓰는 것만으로 우리가 만든 취소 봉투를 우리가 버린다.
 * ★★ **이 수는 abort→봉투 구간의 상한이 아니다**(최종 리뷰 M6). 같은 구간을 엔진은 70초로
 *   잡는다(`test/guards/wait-budget-inequality.test.mjs` 의 `SETTLEMENT_HEADROOM_MS` = 하드스톱
 *   10초 + 워크트리 정리 최대 60초, 근거는 `src/engine.mjs` 의 `MAX_WAIT_MS` 머리말) — 4.7배 차이다. 두 수가 다른 이유는 재는 질문이 다르기 때문이다:
 *   엔진의 70초는 **호스트가 우리를 끊기 전에** 우리가 봉투를 낼 수 있어야 한다는 부등식의
 *   여유분(`MAX_WAIT_MS + 70_000 <= min(호스트 타임아웃들)`, `test/guards/wait-budget-inequality.test.mjs`)
 *   이고, 이 15초는 **우리가 죽기 전에** 얼마나 기다려 줄 것인가라는 전송의 예산이다. 그래서
 *   엔진 상수를 수입하지 않는다 — 엔진이 자기 여유분을 바꿔도 이 질문의 답은 그대로다.
 * ★ 실행이 이 유예 **안에** 봉투를 만든다는 보장은 없다. 취소된 실행은 `raceHardStop` 으로
 *   감싸인 단계 열둘을 차례로 지나고 각 단계가 자기 타이머를 새로 잡으므로, 최악의 합은 15초를
 *   넘길 수 있다. 그때 잃는 것은 봉투 하나이지 종료가 아니다 — 상한이 아예 없으면 한 번도
 *   정산되지 않는 호출 하나가 호스트의 종료를 영원히 붙잡는다. 실제 취소 경로가 가장 비싼
 *   구간(대형 저장소의 인라인 `git worktree remove --force`, 최대 30초)을 **안 지난다**는 것이
 *   이 값이 실측상 충분한 이유다: `src/run-finalization.mjs` 가 모든 취소에서
 *   `preserveAuthoring` 을 세우므로(취소된 레인은 `terminalClass === 'blocked'`) 그 제거는 건너뛴다.
 *   값 자체는 재정된 절충이다(태스크 7 보고서 · 장부 「Adjudication 3」) — 여기서 바꾸지 않는다.
 */
const SHUTDOWN_SETTLE_GRACE_MS = 15_000;

/** 살아 있는 호출 전부를 같은 이유로 끊는다. 이미 끊긴 signal 의 두 번째 abort 는 무시된다. */
function abortInFlight(reason) {
  for (const controller of inFlightHostAborts) controller.abort(reason);
}

/**
 * SIGTERM — 살아 있는 호출을 끊고, **정산된 뒤에** 죽는다(WS3 §0-C2).
 *
 * ★★ 순서가 계약이다: 끊는다 → 실행이 `run_cancelled` 봉투를 만든다 → 그 응답이 전송에 실린다
 *    → 죽는다. 태스크 6 은 abort 하고 **같은 틱에** 죽었는데(그때는 신호를 소비하는 곳이 아예
 *    없었다), 그러면 호스트가 보는 것은 봉투가 아니라 끊긴 전송이다 — 사유 코드도 로그 경로도
 *    실행 이름도 어느 채널에도 안 남는다. 취소가 봉투를 만들 수 있게 된 순간부터 그 봉투를
 *    내보내는 것이 이 자리의 일이다.
 * ★★ 그래도 **반드시 죽는다.** SIGTERM 리스너를 다는 순간 Node 의 기본 종료가 사라지므로,
 *    여기서 안 죽으면 호스트가 끈 서버가 최대 55분(`MAX_WAIT_MS`) 더 벤더를 돌린다.
 * ★ 리스너를 **먼저** 뗀다: 호스트가 참지 못하고 두 번째 SIGTERM 을 보내면 그때는 기본 처분
 *   (즉시 종료)이 옳은 답이고, 이 프로세스는 어차피 아래에서 스스로 같은 신호로 죽는다.
 */
function onHostShutdownSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.off('SIGTERM', onHostShutdownSignal);
  const settlements = [...inFlightSettlements];
  abortInFlight(HOST_ABORT_REASON.shutdown);
  void settleThenExit(settlements);
}

/** 정산과 응답 쓰기를 상한 안에서 기다린 뒤 기본 처분으로 죽는다. */
async function settleThenExit(settlements) {
  try {
    await Promise.race([
      Promise.allSettled(settlements),
      new Promise((resolve) => { setTimeout(resolve, SHUTDOWN_SETTLE_GRACE_MS).unref?.(); }),
    ]);
    // 핸들러가 값을 돌려준 **뒤에** SDK 가 전송에 쓴다. 한 틱을 양보한 다음에 남은 쓰기를 센다 —
    // 여기서 안 기다리면 종료가 자기가 만든 응답을 앞질러 파이프를 닫는다.
    //
    // ★ 이 두 줄은 **Windows 에서는 뮤턴트가 안 잡힌다**(실측: 지우고도 취소 봉투 테스트가 통과).
    //   파이프 쓰기가 동기라 응답이 이미 나가 있기 때문이고, 같은 플랫폼 차이를 이 저장소가 이미
    //   한 번 물었다 — `test/server.test.mjs` 의 관측 프리로드가 `console.error` 대신 동기 쓰기를
    //   쓰는 이유가 「macOS 에서 파이프는 비동기라 SIGTERM 직후의 줄이 통째로 사라진다」다.
    //   비동기 파이프 위에서 이 두 줄이 없으면 사라지는 것이 진단 한 줄이 아니라 취소 봉투다.
    await new Promise((resolve) => { setImmediate(resolve); });
    await Promise.allSettled([...pendingSends]);
  } finally {
    // 남은 상태를 비운다(태스크 6 인계 L3). 다시 무장할 호출은 없고, stdin 리스너가 남으면
    // 종료 중에 도착한 EOF 가 살아 있는 컨트롤러도 없이 접기를 한 번 더 돈다.
    inFlightHostAborts.clear();
    process.stdin.off('end', onHostTransportClose);
    process.kill(process.pid, 'SIGTERM');
  }
}

/**
 * 전송이 닫혔다 — 실행 중인 호출을 **취소하고**, 프로세스는 우리가 죽이지 않는다.
 *
 * ★★ stdin 의 EOF 를 「실행 취소」로 읽는 것은 WS3 태스크 7 의 의도적 판정이다. 파이프를 닫은
 *    호스트는 이 답을 받을 채널 하나를 스스로 버린 것이고(요청은 더 올 수 없다), 그런데도
 *    실행을 계속하면 벤더 CLI 자식들이 최대 55분(`MAX_WAIT_MS`)을 더 돌면서 아무도 안 읽을
 *    답을 만든다. 로드맵 §3.5 의 종료 기준이 「취소 시 자식 CLI 즉시 회수」인 이유가 그것이다 —
 *    취소된 실행은 엔진에서 자식을 즉시 끊고 워크트리를 리퍼에게 넘긴 뒤 봉투로 정산한다.
 * ★★ 그래도 **프로세스는 안 죽인다.** EOF 는 「더 보낼 요청이 없다」이지 「죽어라」가 아니고,
 *    죽이는 신호는 SIGTERM 이다(위). 그 대신 마지막 호출이 정산되면 닫힌 stdin 위에서 이벤트
 *    루프가 비어 세션이 **스스로**(종료 코드 0) 끝난다 — 그것은 우리가 죽인 것이 아니라 할 일이
 *    없어진 것이다. 응답은 그 전에 나간다: 파이프는 방향이 둘이라 stdout 은 살아 있다.
 * ★ 자리가 둘인 이유(실측, SDK 1.29.0): `StdioServerTransport` 는 stdin 의 `data`·`error` 만
 *   듣는다 — EOF 를 안 본다. 그래서 **파이프가 닫히는** 진짜 경로는 스트림의 `end` 뿐이고,
 *   transport 자신의 `onclose` 는 `server.close()` 같은 명시적 종료에서만 온다. 둘 다 같은
 *   접기로 보낸다. `close` 는 듣지 않는다 — `end` 와 겹쳐 발화하면 같은 사건이 두 번 센다.
 */
function onHostTransportClose() {
  abortInFlight(HOST_ABORT_REASON.shutdown);
}

/** 첫 호출이 프로세스 리스너를 달고, 마지막 호출이 뗀다. 유휴 서버의 수명주기는 오늘 그대로다. */
function armHostShutdown(controller) {
  // 종료가 시작된 뒤에는 다시 무장하지 않는다 — 그러면 이미 놓아준 수명주기를 새 호출이 다시
  // 붙잡고(SIGTERM 리스너가 되살아나고), 두 번째 SIGTERM 이 아무 처분도 못 받는다.
  if (shuttingDown) {
    inFlightHostAborts.add(controller);
    return;
  }
  if (inFlightHostAborts.size === 0) {
    process.on('SIGTERM', onHostShutdownSignal);
    process.stdin.on('end', onHostTransportClose);
  }
  inFlightHostAborts.add(controller);
}

function disarmHostShutdown(controller) {
  inFlightHostAborts.delete(controller);
  if (inFlightHostAborts.size === 0) {
    process.off('SIGTERM', onHostShutdownSignal);
    process.stdin.off('end', onHostTransportClose);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  // ★ 이 호출 하나의 취소 신호. 세 소스가 여기로 접힌다(위 머리말). `extra.signal` 은 핸들러가
  //   돌기 **전에** 이미 끊겨 있을 수 있다 — 취소 알림이 요청과 같은 읽기 버퍼에 실려 오면 SDK 가
  //   핸들러 마이크로태스크보다 먼저 abort 한다(실측). 그래서 리스너만 달면 그 경우를 통째로 놓친다.
  const hostAbort = new AbortController();
  const requestSignal = extra?.signal;
  const onRequestAbort = () => hostAbort.abort(HOST_ABORT_REASON.cancel);
  if (requestSignal?.aborted === true) onRequestAbort();
  else requestSignal?.addEventListener?.('abort', onRequestAbort, { once: true });
  armHostShutdown(hostAbort);
  // 종료가 이미 시작됐으면 이 호출은 시작하자마자 취소다 — 정산을 기다리는 쪽은 이 호출을
  // 모르므로(약속 목록은 이미 찍혔다), 여기서 안 끊으면 아무도 안 기다리는 실행이 하나 뜬다.
  if (shuttingDown) hostAbort.abort(HOST_ABORT_REASON.shutdown);
  // 이 호출이 **봉투로 정산됐다**는 약속. 종료 경로가 기다리는 것이 이것이고, 그래서 풀리는
  // 자리는 아래 `finally` — 봉투를 만들었든 예외를 봉투로 강등했든 같은 자리다.
  let settleCall;
  const settlement = new Promise((resolve) => { settleCall = resolve; });
  inFlightSettlements.add(settlement);

  // ★ 전체를 try 로 감싼다 — 어떤 예외도 봉투로 강등한다. 던지면 SDK 가 JSON-RPC
  //   오류로 바꾸는데, 그러면 우리 봉투(recovery 포함)가 사라진다. 호출자는 모델이라
  //   다음 행동을 알아야 한다.
  let swept = null;
  try {
    return await afterStartupSweep(startupSweep, async (startupResult) => {
      swept = startupResult;
      if (nestedRunId !== null) {
        return serializeToolResult(
          withStartupNotices(failure({ status: 'blocked', reasonCode: REASON.run_nested_invocation,
            params: { runId: nestedRunId } }), swept),
        );
      }

      // ★ 진행 알림의 생산자. 호스트가 `_meta.progressToken` 을 준 요청에만 만든다 — 요청하지
      //   않은 알림을 보내면 안 된다(MCP 스펙). 이게 없으면 엔진의 진행 중계는 살아 있는데
      //   내보내는 곳이 없어서, 조용한 긴 스텝에서 stdio 의 30분 유휴 타이머가 먼저 끊는다(§6).
      const onProgress = makeProgressReporter({
        sendNotification: extra?.sendNotification,
        progressToken: request.params?._meta?.progressToken,
      });
      const envelope = await callTool(request.params.name, request.params.arguments, {
        stateRoot, onProgress, hostSignal: hostAbort.signal,
      });
      return serializeToolResult(withStartupNotices(envelope, swept));
    });
  } catch (error) {
    return serializeToolResult(
      withStartupNotices(failure({ status: 'failed', reasonCode: REASON.run_tool_failed,
        params: { detail: errorText(error) } }), swept),
    );
  } finally {
    // 정산에서 회수한다 — 리스너가 호출마다 쌓이면 동시 호출 수만큼 새고, 유휴 서버에 SIGTERM
    // 리스너가 남으면 기본 종료가 사라진 채로 남는다. `{ once: true }` 는 이미 발화한 리스너를
    // 스스로 떼므로 아래 제거는 발화하지 않은 경우를 위한 것이다.
    disarmHostShutdown(hostAbort);
    requestSignal?.removeEventListener?.('abort', onRequestAbort);
    inFlightSettlements.delete(settlement);
    settleCall();
  }
});

const transport = new StdioServerTransport();
// ★ 나가는 응답을 센다. 종료 경로가 기다려야 하는 것은 「봉투가 만들어졌다」가 아니라 「바이트가
//   나갔다」이기 때문이다 — SDK 의 `send` 는 전송이 그 프레임을 받아들일 때 resolve 한다.
//   래핑은 `connect` **전에** 한다: 그 뒤에는 프로토콜이 이미 이 객체를 붙잡고 있다.
const sendMessage = transport.send.bind(transport);
transport.send = (message) => {
  const pending = Promise.resolve(sendMessage(message)).finally(() => pendingSends.delete(pending));
  pendingSends.add(pending);
  return pending;
};
// ★ `connect` **전에** 단다. SDK 의 `connect` 는 transport 에 이미 붙어 있던 `onclose` 를 잡아
//   자기 것 앞에 부른다(protocol.js:220-223 실측). 뒤에 달면 SDK 것을 덮어써 프로토콜 정리가
//   사라지고, 순서도 뒤집힌다 — SDK 의 `_onclose` 가 먼저 돌면 그것이 `extra.signal` 을 이유
//   없이 abort 해서 「호스트가 서버를 내렸다」가 「이 요청 하나가 취소됐다」로 읽힌다.
// ★ 이 줄은 **in-process 테스트가 밖에서 발화시킬 수 없다**(태스크 6 인계 2, 태스크 7 판정):
//   `transport.close()`/`server.close()` 를 부르는 코드가 저장소에 없고, stdio transport 는 EOF
//   로는 안 닫힌다(위 실측). 발화시키려면 서버 모듈 **안에서** close 를 부르는 수밖에 없는데,
//   그러면 재는 것이 배선이 아니라 테스트가 만든 사건이다. 그래서 이 자리에서 실제로 도는 경로 —
//   호스트가 파이프를 닫는다 — 는 stdin `end` 쪽이고 그쪽에는 프로세스를 진짜로 돌리는 테스트가
//   있다. 이 줄이 지키는 것은 **순서**이고(SDK 의 `_onclose` 가 먼저 돌면 서버 종료가 요청 취소로
//   읽힌다), 그 순서는 `test/server.test.mjs` 가 소스에서 잰다.
transport.onclose = onHostTransportClose;
await server.connect(transport);
}
