/**
 * claude CLI 의 argv 를 만든다.
 *
 * ★ 이 모듈의 실패 모드는 전부 "너무 열리는" 쪽이다. 플래그가 빠지면 델리게이트가
 *   권한을 덜 받는 게 아니라 더 받는다. 그래서 아는 역할이 아니면 argv 를 만들지
 *   않고 던진다 — 기본 거부다.
 *
 * 지시문은 argv 가 아니라 stdin 으로 보낸다. Windows 의 명령줄 상한(8191자)에
 * 걸리지 않고, 프롬프트 텍스트가 명령줄 인용 규칙을 만날 일도 없다.
 */

/** 일회용 빈 디렉터리에서 돌고, 도구 없이 텍스트만 낸다. */
export const READ_ONLY_ROLES = Object.freeze(['planner', 'thinker']);

/** 워크트리에서 돌고, 실제로 파일을 고치고 테스트를 실행한다. */
export const WRITE_ROLES = Object.freeze(['worker', 'verifier']);

/**
 * `--print` 모드에서 스트림을 받기 위한 최소 조합.
 * `--output-format stream-json` 은 `--print` 와만 동작하고, `--verbose` 가 없으면
 * 스트림이 나오지 않는다(캡처된 --help 로 확인).
 */
const BASE_ARGS = Object.freeze(['-p', '--output-format', 'stream-json', '--verbose']);

/**
 * 쓰기 역할이 읽어도 되는 설정 출처.
 *
 * `user` = 사용자 자신의 `~/.claude`. 그 사람의 기계이고 모델·인증 설정이 거기 있으므로
 * 끊으면 정상 실행이 깨진다. 끊어야 하는 것은 **대상 저장소에서 오는** `project`(추적된
 * `.claude/settings.json`)와 `local`(`.claude/settings.local.json`)이다 — 그 둘의 훅은
 * 도구 집합과 무관하게 임의 셸 명령을 실행한다.
 *
 * 값을 여기 상수로 두는 이유는 라이브 검증(`test/live/setting-sources.test.mjs`)이 이
 * 값을 그대로 쓰기 때문이다. 두 곳에 적으면 갈린다.
 */
export const SETTING_SOURCES = 'user';

function unknownRoleError(role) {
  const error = new Error(`unknown delegate role: ${JSON.stringify(role)}`);
  error.code = 'unknown_role';
  error.role = role;
  return error;
}

function allowedToolsRequiredError(role) {
  const error = new Error(`role '${role}' needs a non-empty allowedTools list`);
  error.code = 'allowed_tools_required';
  error.role = role;
  return error;
}

function unsafeToolPatternError(role, pattern) {
  const error = new Error(`allowedTools entry looks like a flag: ${JSON.stringify(pattern)}`);
  error.code = 'unsafe_tool_pattern';
  error.role = role;
  error.pattern = pattern;
  return error;
}

function toolSetRequiredError(role, value) {
  const error = new Error(
    `role '${role}' needs a non-empty toolSet — the tool set is the only flag that is actually enforced ` +
      `(got ${JSON.stringify(value) ?? String(value)})`,
  );
  error.code = 'tool_set_required';
  error.role = role;
  error.toolSet = value;
  return error;
}

function invalidPermissionModeError(mode) {
  const error = new Error(`permissionMode must be a non-empty string, got ${typeof mode}`);
  error.code = 'invalid_permission_mode';
  error.permissionMode = mode;
  return error;
}

/**
 * @param role           'planner' | 'thinker' | 'worker' | 'verifier'
 * @param model          null 이면 붙이지 않는다 = CLI 자신의 기본 모델
 * @param effort         null 이면 붙이지 않는다 = CLI 자신의 기본 effort
 * @param allowedTools   쓰기 역할에서 실제로 허용할 명령 패턴. 비면 던진다.
 * @param toolSet        쓰기 역할이 **실제로 받을 도구 집합**. 아래 `--tools` 문단 참조.
 *                       쓰기 역할에서 비면 **던진다**(fail-closed) — 유일하게 강제되는
 *                       플래그를 옵트인으로 두면 빠뜨린 호출부가 기본 집합 전부를 받는다.
 * @param permissionMode 쓰기 역할의 권한 모드. 정책을 여기서 고정하지 않는 이유는
 *                       Task 20 이 실측으로 정하기 때문이다.
 */
export function buildClaudeArgs({
  role,
  model = null,
  effort = null,
  allowedTools = [],
  toolSet = null,
  permissionMode = 'bypassPermissions',
} = {}) {
  const readOnly = READ_ONLY_ROLES.includes(role);
  const write = WRITE_ROLES.includes(role);
  if (!readOnly && !write) throw unknownRoleError(role);

  const args = [...BASE_ARGS];

  // 값이 없으면 플래그 자체를 붙이지 않는다. 값 없는 플래그를 붙이면 그 다음 인자가
  // 값으로 먹혀 argv 전체가 한 칸씩 밀린다.
  if (typeof model === 'string' && model !== '') args.push('--model', model);
  if (typeof effort === 'string' && effort !== '') args.push('--effort', effort);

  if (readOnly) {
    // 빈 문자열이 "도구 전부 끔"이다. 이 값을 걸러내면 정반대로 전부 켜진다.
    // allowedTools 가 들어와도 여기서는 쓰지 않는다 — 읽기 전용이 권한 상승
    // 경로가 되면 안 된다.
    args.push('--tools', '');
    return args;
  }

  const tools = Array.isArray(allowedTools) ? allowedTools.filter((t) => typeof t === 'string' && t !== '') : [];
  // 목록을 못 유도했으면 좁히는 장치 없이 권한 모드만 열린 채로 돈다. 실행을 막는다.
  if (tools.length === 0) throw allowedToolsRequiredError(role);

  // ★ `--allowedTools <tools...>` 는 가변 인자다. 값 자리에 `-` 로 시작하는 문자열이
  //   들어가면 CLI 파서가 그걸 값이 아니라 새 플래그로 읽을 수 있다.
  //
  //   이게 가상의 호출부 버그가 아닌 이유: 이 목록은 §7.1 분류기가 **작업 대상
  //   저장소의 파일**(package.json 의 scripts, Makefile 타깃)에서 유도한다. 즉 우리가
  //   쓰지 않은 내용이 값 자리로 들어오는 실제 주입면이다. 게다가 native Windows 에는
  //   OS 샌드박스가 없어(설계 §5.1) 이 목록이 유일한 방어선이다.
  //
  //   정상적인 패턴은 `Bash(npm test:*)`, `Edit`, `Read` 처럼 `-` 로 시작하지 않는다.
  //   조용히 버리지 않고 던지는 이유는, 유도가 이상한 것을 뱉었다는 사실 자체를
  //   운영자가 봐야 하기 때문이다.
  for (const tool of tools) {
    if (tool.startsWith('-')) throw unsafeToolPatternError(role, tool);
  }

  // 문자열이 아니면 argv 에 그대로 실려 spawn 안에서 불투명한 TypeError 가 된다.
  // 경계에서 구조화된 오류로 막는다.
  if (typeof permissionMode !== 'string' || permissionMode === '') {
    throw invalidPermissionModeError(permissionMode);
  }

  // ★★ 쓰기 역할의 **도구 집합**. 실측(설계 §12.0)으로 `--allowedTools` 는 실행을
  //    제한하지 못했고 강제되는 것은 `--tools` 하나뿐이다. 그런데 이 함수는 오랫동안
  //    쓰기 역할에 `--tools` 를 아예 붙이지 않았다 — 즉 워커·베리파이어가 Bash 를
  //    포함한 기본 집합 전부를 받았고, "워커에게 Bash 를 주지 않는다"(설계 §12.-1)는
  //    argv 어디에도 없었다.
  //
  //    캡처된 --help(claude 2.1.223)의 문구 그대로다:
  //      --tools <tools...>  Specify the list of available tools from the built-in set.
  //                          Use "" to disable all tools, "default" to use all tools,
  //                          or specify tool names (e.g. "Bash,Edit,Read").
  //
  //    쉼표로 이어 **한 원소**로 넘긴다. `<tools...>` 는 가변 인자라 항목마다 원소를
  //    나누면 뒤따르는 값이 목록에 먹힐 수 있고, help 의 예시 자체가 쉼표 형태다.
  //
  //    ★★ **fail-closed 다.** 처음에는 생략을 "제한하지 않는다"로 두었는데, 강제력이
  //    없다고 실측된 `allowedTools` 는 비면 던지면서 **유일하게 강제되는 플래그만
  //    옵트인**이라는 비대칭이 남았다. 이 모듈의 실패는 전부 "더 열리는" 쪽이고, 빠뜨린
  //    호출부가 받는 것은 `--permission-mode bypassPermissions` + Bash 포함 기본 집합
  //    전부다. 호환시켜 줄 기존 호출부도 없다(쓰기 역할의 호출부는 `src/engine.mjs`
  //    하나뿐이고 두 역할 모두 집합을 싣는다).
  const set = (Array.isArray(toolSet) ? toolSet : [])
    .filter((tool) => typeof tool === 'string')
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '');
  if (set.length === 0) throw toolSetRequiredError(role, toolSet);
  for (const tool of set) {
    if (tool.startsWith('-')) throw unsafeToolPatternError(role, tool);
  }
  args.push('--tools', set.join(','));

  // ★★ `--tools` **옆의 문**. 그 플래그는 내장 도구 집합에만 적용되고, 벤더의 별도
  //    채널은 그것과 무관하게 임의 셸 명령을 실행한다(라이브 실측, 아래 표):
  //
  //      settings/hooks — 작업 디렉터리의 `.claude/settings.json`(추적 파일이면
  //        `worktree add` 가 그대로 체크아웃한다) 과 `settings.local.json` 의 훅.
  //        SessionStart·PreToolUse 훅이 `--tools` 에 Bash 가 없는데도 실행됐고
  //        `permission_denials` 는 비어 있었다. **델리게이트의 협조가 필요 없다** —
  //        적대적 대상 저장소 하나로 성립한다.
  //      MCP — 대상 저장소의 `.mcp.json` 이 서버를 붙이면 그 도구는 내장 집합 밖이다.
  //
  //    `--setting-sources user` 는 project/local 을 끊고 사용자 자신의 `~/.claude`
  //    (그 사람 기계다 — 모델·인증 설정이 거기 있다)만 남긴다. `--strict-mcp-config` 는
  //    `--mcp-config` 로 준 것 말고는 아무 MCP 설정도 읽지 않게 한다.
  //
  //    두 플래그는 읽기 전용 역할에는 붙이지 않는다 — 그쪽은 `--tools ''` 로 도구가
  //    통째로 꺼져 있어 훅을 발화시킬 도구 호출 자체가 없다. (SessionStart 는 도구와
  //    무관하지만, 읽기 전용 역할은 사용자 저장소가 아니라 일회용 **빈 디렉터리**에서
  //    돌므로 프로젝트 settings 가 존재하지 않는다.)
  args.push('--setting-sources', SETTING_SOURCES, '--strict-mcp-config');

  args.push('--permission-mode', permissionMode);
  // 항목마다 별도 원소로 넣는다. 합쳐서 하나로 주면 CLI 가 다른 경계로 쪼갠다.
  args.push('--allowedTools', ...tools);
  return args;
}
