/**
 * codex CLI 의 argv 를 만든다.
 *
 * 플래그 근거는 전부 실측이다 — test/captures/codex-exec-help.txt (codex-cli 0.146.1).
 *
 * ★ 설계 §5.1 정정: `--ask-for-approval` 은 `codex exec` 에 **없다**. 설계는 비대화
 *   실행에 필수라고 적어뒀지만 0.146.1 의 옵션 목록에 존재하지 않고, 붙이면 오류가
 *   난다. 승인 정책은 --sandbox 로 갈린다.
 *
 * ★ claude 쪽과 같은 비대칭: 실수하면 권한이 줄지 않고 는다. 그래서 기본 거부다.
 *
 * ## ★ 잔여 위험 — "도구 집합 옆의 문" 을 codex 쪽에서 확인한 결과
 *
 * claude 에서는 대상 저장소의 `.claude/settings.json` 훅이 도구 집합과 무관하게 임의 셸
 * 명령을 실행했고(라이브 실측 — `test/captures/claude-setting-sources.txt`),
 * `--setting-sources user --strict-mcp-config` 로 닫았다. codex 의 같은 축을 캡처된
 * `codex exec --help`(0.147.0)로 훑은 결과:
 *
 *   · 설정과 MCP 는 전부 `$CODEX_HOME` 아래다 — `-c` 는 "`~/.codex/config.toml` 에서
 *     로드될 값을 덮어쓴다", `-p` 는 `$CODEX_HOME/<name>.config.toml` 을 얹는다.
 *     **대상 저장소가 심을 수 있는 자리가 아니다.** 그래서 claude 의 project/local
 *     settings 에 해당하는 채널이 이 경로에는 없다.
 *   · 훅은 있지만 **persisted hook trust** 를 요구한다("Run enabled hooks without
 *     requiring persisted hook trust … DANGEROUS"). 그 신뢰를 우회하는 유일한 플래그
 *     `--dangerously-bypass-hook-trust` 는 아래 `BANNED_EXACT` 가 이미 막는다.
 *   · ⚠ **닫지 않은 것: execpolicy `.rules`.** `--ignore-rules` 의 설명이 "Do not load
 *     user or **project** execpolicy `.rules` files" 라, 프로젝트 쪽 파일이 존재한다 —
 *     즉 대상 저장소가 심을 수 있다. 붙이지 않은 이유는 그 플래그가 **사용자 자신의**
 *     `.rules` 까지 같이 끊기 때문이다(claude 에서 `--setting-sources` 를 빈 값이 아니라
 *     `user` 로 둔 것과 같은 판단). 그리고 execpolicy 가 허용을 **넓힐** 수 있는지
 *     좁히기만 하는지는 재지 않았다 — 좁히기만 한다면 적대적 저장소가 얻는 것이 없다.
 *     그 방향을 실측하기 전에는 사용자의 정당한 하드닝을 끊지 않는다. 사실만 적는다.
 *   · ⚠ **닫지 않은 것: 사용자 자신의 `config.toml [mcp_servers]`.** 이 argv 는 그것을 안 건드려
 *     모든 역할(플래너·심판 포함)에 그 서버들이 뜬다. 중첩 bom-orch 만 `BOM_ORCH_RUN_ID` 가 막는다
 *     (`src/server.mjs`). `-c mcp_servers={}` 로 비울 수 있는지는 실측 전이라 붙이지 않았다(2026-09-05).
 */

/** 일회용 빈 디렉터리에서 돌고, 읽기만 한다. */
export const READ_ONLY_ROLES = Object.freeze(['planner', 'thinker']);

/** 워크트리에서 돌고, 도구를 받아야 하는 역할. */
export const WRITE_ROLES = Object.freeze(['worker', 'verifier']);

/**
 * 워크스페이스에 **쓸** 필요가 있는 역할. `WRITE_ROLES` 와 갈라지는 곳은 verifier 다 —
 * 그쪽은 "도구를 받아야 하는 역할" 이라는 다른 뜻이고, verifier 는 읽기만 한다.
 */
export const WORKSPACE_WRITE_ROLES = Object.freeze(['worker']);

/**
 * `--json` 은 JSONL 이벤트를, `--ephemeral` 은 세션 파일을 안 남기게 한다.
 * 우리는 실행마다 일회용 작업공간을 쓰므로 디스크에 세션을 쌓을 이유가 없다.
 */
const BASE_ARGS = Object.freeze(['exec', '--json', '--ephemeral']);

/**
 * argv 원소로 **그대로** 나타나서는 안 되는 것들. 설계 §5.1 의 공짜 방어다.
 *
 * - 샌드박스를 통째로 끄는 플래그
 * - danger-full-access 샌드박스 모드
 *
 * ★ 부분 문자열이 아니라 완전 일치로 본다. 처음에는 부분 문자열로 짰는데 실제
 *   경로에 오탐이 났다(리뷰어 실측): `C:\repos\network_access\worktree-1` 같은
 *   워크트리 경로나 그 단어가 들어간 모델 이름이 통째로 거부됐다.
 *
 *   완전 일치로도 충분한 이유: argv 는 배열이라 한 원소 안의 공백이 두 인자로
 *   쪼개지지 않는다. 그러니 `-m "뭐라뭐라 danger-full-access"` 는 모델 이름이지
 *   샌드박스 모드가 될 수 없다. 진짜 위험은 값이 **통째로** 그 플래그일 때이고,
 *   그건 완전 일치가 잡는다.
 */
const BANNED_EXACT = Object.freeze([
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  'danger-full-access',
]);

/**
 * `-c` 설정 덮어쓰기로 켜서는 안 되는 키.
 *
 * codex 는 workspace-write 에서 네트워크가 기본 OFF 다. 안 켜는 것만으로 방어가
 * 되므로 절대 켜지 않는다. 여기는 `-c` 값의 **키 부분**만 본다 — 경로나 모델 이름에
 * 우연히 같은 단어가 들어 있는 것과 구분하기 위해서다.
 */
const BANNED_CONFIG_KEYS = Object.freeze(['sandbox_workspace_write.network_access']);

function unknownRoleError(role) {
  const error = new Error(`unknown delegate role: ${JSON.stringify(role)}`);
  error.code = 'unknown_role';
  error.role = role;
  return error;
}

function unsafeArgumentError(name, value) {
  const error = new Error(`${name} looks like a flag: ${JSON.stringify(value)}`);
  error.code = 'unsafe_argument';
  error.argument = name;
  error.value = value;
  return error;
}

/**
 * 값 자리에 들어갈 문자열인지 본다.
 *
 * `-m` 과 `-c` 는 바로 뒤 토큰을 값으로 먹는다. 거기에 `-` 로 시작하는 것이 들어가면
 * 무엇이 실행될지 우리가 통제하지 못한다. 정상적인 모델 이름과 effort 는 `-` 로
 * 시작하지 않으므로 과잉 차단 위험 없이 막을 수 있다.
 */
function assertValueLike(name, value) {
  if (typeof value === 'string' && value.startsWith('-')) throw unsafeArgumentError(name, value);
}

/**
 * 조립이 끝난 argv 에 금지된 것이 섞였는지 마지막으로 본다. 내보내는 이유는,
 * 나중에 argv 를 손보는 호출부가 생겨도 같은 검사를 통과하게 하기 위해서다.
 *
 * ★ "이 문자열은 코드 어디에도 안 쓰니까 안 실린다" 는 보증이 아니다. 실제로 그
 *   전제가 이미 한 번 깨졌다 — cwd 값 검사를 빠뜨려서 사용자가 준 경로를 타고
 *   금지 플래그가 그대로 argv 에 실렸다(리뷰어 실측). 값 자리 검사를 하나 더
 *   추가하는 것으로는 다음 구멍을 못 막는다. 구조적으로 막는다.
 */
function bannedFlagError(banned, argument) {
  const error = new Error(`refusing to build argv containing ${JSON.stringify(banned)}`);
  error.code = 'banned_flag';
  error.banned = banned;
  error.argument = argument;
  return error;
}

export function assertNoBannedFlags(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    for (const banned of BANNED_EXACT) {
      if (arg === banned) throw bannedFlagError(banned, arg);
    }

    // `-c key=value` 의 키 부분만 본다. 값이나 경로에 우연히 같은 단어가 들어 있는
    // 것과 구분해야 오탐이 안 난다.
    if (arg === '-c' || arg === '--config') {
      const next = String(args[i + 1] ?? '');
      const key = next.slice(0, next.indexOf('='));
      for (const banned of BANNED_CONFIG_KEYS) {
        if (key === banned) throw bannedFlagError(banned, next);
      }
    }
  }
  return args;
}

/**
 * @param role             'planner' | 'thinker' | 'worker' | 'verifier'
 * @param model            null 이면 붙이지 않는다 = CLI 자신의 기본 모델
 * @param effort           null 이면 붙이지 않는다. `-c model_reasoning_effort=` 로 간다
 * @param cwd              작업 루트(-C). 없으면 붙이지 않는다
 * @param skipGitRepoCheck 저장소 밖에서 돌아야 하면 true. planner/thinker 의 일회용
 *                         빈 디렉터리는 저장소가 아니라 이게 없으면 아예 못 돈다
 */
export function buildCodexArgs({
  role,
  model = null,
  effort = null,
  cwd = null,
  skipGitRepoCheck = false,
} = {}) {
  const readOnly = READ_ONLY_ROLES.includes(role);
  const write = WRITE_ROLES.includes(role);
  if (!readOnly && !write) throw unknownRoleError(role);

  assertValueLike('model', model);
  assertValueLike('effort', effort);
  // cwd 도 `-C` 바로 뒤 값 자리에 들어간다. 빠뜨렸더니 이 파일이 "절대 안 실린다"고
  // 적어둔 문자열이 cwd 를 타고 그대로 argv 에 실렸다(리뷰어 실측).
  assertValueLike('cwd', cwd);

  const args = [...BASE_ARGS];

  // ★ 샌드박스는 `WRITE_ROLES` 가 아니라 `WORKSPACE_WRITE_ROLES` 로 가른다.
  //
  //   두 집합이 갈라지는 곳은 verifier 다. `WRITE_ROLES` 는 "이 역할은 도구를 받아야
  //   한다"(claude 쪽에서 `allowedTools` 필수 판정)는 뜻이라 verifier 도 거기 남아야
  //   하지만, 워크스페이스에 **쓸** 필요가 있는 역할은 worker 뿐이다.
  //
  //   전에는 둘을 같은 집합으로 갈라서 codex verifier 가 `workspace-write` 를 받았다.
  //   claude verifier 는 도구 집합이 `Read,Glob,Grep` 이라 읽기 전용인데 codex verifier
  //   만 쓸 수 있었다 — 설계가 "베리파이어는 읽기 전용" 이라 적은 것이 한 벤더에서만
  //   참이었다. §12.-1 이 테스트 실행을 오케스트레이터로 옮긴 뒤로 verifier 가 워크트리에
  //   쓸 이유는 남아 있지 않다.
  //
  // ★ danger-full-access 로 가는 경로도, --dangerously-bypass-approvals-and-sandbox 를
  //   붙이는 경로도 만들지 않는다. 그리고 codex 는 workspace-write 에서 네트워크가
  //   기본 OFF 라, `-c sandbox_workspace_write.network_access=true` 를 붙이지 않는
  //   것만으로 공짜 방어가 된다(설계 §5.1). 그 문자열은 이 파일 어디에도 없다.
  //
  // ⚠ 라이브 미검증: codex 한도(2026-08-11)로 read-only verifier 를 실제 CLI 로
  //   돌려보지 못했다. argv 수준까지만 확인했다.
  args.push('--sandbox', WORKSPACE_WRITE_ROLES.includes(role) ? 'workspace-write' : 'read-only');

  if (typeof model === 'string' && model !== '') args.push('-m', model);
  if (typeof effort === 'string' && effort !== '') args.push('-c', `model_reasoning_effort=${effort}`);
  if (typeof cwd === 'string' && cwd !== '') args.push('-C', cwd);

  // ★ 읽기 전용 역할에만 허용한다.
  //
  //   이 플래그가 필요한 이유는 planner/thinker 가 일회용 **빈 디렉터리**에서 돌기
  //   때문이다. worker/verifier 는 워크트리에서 도는데 워크트리는 그 자체로 git
  //   저장소라 이 플래그가 필요 없다. 쓰기 역할에 열어두면 "워커는 항상 격리된
  //   워크트리 안에서 돈다"는 보안 모델의 전제를 호출부 실수 하나로 깰 수 있다.
  if (skipGitRepoCheck === true && readOnly) args.push('--skip-git-repo-check');

  return assertNoBannedFlags(args);
}
