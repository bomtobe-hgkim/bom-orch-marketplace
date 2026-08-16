#!/usr/bin/env node
/**
 * stdio MCP 서버.
 *
 * ★ stdout 은 프로토콜 전용이다. 모든 바이트가 JSON-RPC 프레임이라 로그 한 줄이
 *   프레임 사이에 끼면 호스트가 연결을 끊는다. 증상은 "플러그인이 그냥 안 뜬다"로만
 *   보여서 원인을 짚기 매우 어렵다. 로그는 stderr 로만 — 그리고 그걸 사람 기억이
 *   아니라 test/guards/no-stdout-writes.test.mjs 가 막는다.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { callTool, listTools, makeProgressReporter } from './tools.mjs';
import { failure, serializeToolResult } from './envelope.mjs';
import { sweepOrphans } from './reaper.mjs';
import { resolveStateRoot } from './state-root.mjs';

const REQUIRED_NODE_VERSION = { major: 20, minor: 10, patch: 0 };

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

/** "v20.10.0" 같은 문자열을 {major,minor,patch} 로 읽는다. 못 읽으면 null. */
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

if (!checkNodeVersion()) {
  console.error(
    `bom-orch 는 Node.js >=20.10 이 필요합니다. 현재 버전: ${process.version}. Node 를 20.10 이상으로 올리고 다시 실행하세요.`,
  );
  process.exit(1);
}

// ★ 델리게이트 하나가 처리되지 않은 예외/거부를 던졌다고 서버 전체가 죽으면 그
//   세션의 모든 도구가 함께 사라진다. stderr 에 기록하고 살아남는다.
process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 프라미스 거부:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('처리되지 않은 예외:', error);
});

/** 어떤 값에서도(toString 이 던지는 값 포함) 사람이 읽을 문자열을 뽑는다. */
function describeThrown(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message;
  try {
    const text = String(error);
    return text !== '' ? text : '알 수 없는 오류';
  } catch {
    return '알 수 없는 오류';
  }
}

// version 은 package.json 에서 읽는다 — 두 곳에 적으면 갈린다.
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

const stateRoot = resolveStateRoot();

// 부팅 시점에는 보호할 run ID 를 아직 모른다. 따라서 scratch 와 child/worktree
// 원장만 비동기로 정리하고 patch/run namespace 는 per-run collision 검사 뒤로 미룬다.
sweepOrphans({ stateRoot, sweepPatches: false, sweepRuns: false });

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
    `중첩 실행 감지: BOM_ORCH_RUN_ID=${nestedRunId} 가 이미 설정돼 있습니다. ` +
      '이 프로세스는 우리가 만든 델리게이트 자식 안에서 돌고 있는 것으로 보고, 도구 호출을 모두 거부합니다.',
  );
}

const server = new Server({ name: 'bom-orch', version: packageJson.version }, { capabilities: { tools: {} } });

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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (nestedRunId !== null) {
    return serializeToolResult(
      failure({
        status: 'blocked',
        error: `중첩 실행이 감지되었습니다 (nested run, BOM_ORCH_RUN_ID=${nestedRunId}).`,
        recovery: '이미 오케스트레이션 안에서 돌고 있습니다(중첩/nested). 바깥 프로세스에서 다시 시도하세요.',
      }),
    );
  }

  // ★ 전체를 try 로 감싼다 — 어떤 예외도 봉투로 강등한다. 던지면 SDK 가 JSON-RPC
  //   오류로 바꾸는데, 그러면 우리 봉투(recovery 포함)가 사라진다. 호출자는 모델이라
  //   다음 행동을 알아야 한다.
  try {
    // ★ 진행 알림의 생산자. 호스트가 `_meta.progressToken` 을 준 요청에만 만든다 — 요청하지
    //   않은 알림을 보내면 안 된다(MCP 스펙). 이게 없으면 엔진의 진행 중계는 살아 있는데
    //   내보내는 곳이 없어서, 조용한 긴 스텝에서 stdio 의 30분 유휴 타이머가 먼저 끊는다(§6).
    const onProgress = makeProgressReporter({
      sendNotification: extra?.sendNotification,
      progressToken: request.params?._meta?.progressToken,
    });
    const envelope = await callTool(request.params.name, request.params.arguments, { stateRoot, onProgress });
    return serializeToolResult(envelope);
  } catch (error) {
    return serializeToolResult(
      failure({
        status: 'failed',
        error: describeThrown(error),
        recovery: '다시 시도하거나 서버 로그를 확인하세요.',
      }),
    );
  }
});

// ★ 부팅 훑기 — 딱 한 번, 여기서 시작하고 핸드셰이크에서는 await 하지 않는다. 세션 중간에 또 부르면 이
//   세션이 방금 등록한 자식을 죽인다(reaper 의 원장은 상태 루트당 하나다). 타이머도,
//   두 번째 호출 지점도 두지 않는다. 기록마다 프로세스 프로브를 돌려 수백 ms 씩
//   걸리는데 MCP 핸드셰이크가 그걸 기다리면 안 된다. sweepOrphans 는 던지지 않으므로
//   잡을 것도 없다(reaper.mjs 참고).
await server.connect(new StdioServerTransport());
