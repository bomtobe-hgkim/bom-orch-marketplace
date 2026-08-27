// 모델 발견 파서. 순수 함수라 실제 CLI 없이 커밋된 캡처로 검증한다.
//
// 이전 C# 구현의 ProviderModelProbe.cs 에서 이식했다.

/**
 * `claude --help` 텍스트에서 모델 별칭과 effort 목록을 뽑는다.
 *
 * claude 는 기계 판독 가능한 모델 목록 명령이 없다 — `claude models` 는 서브커맨드가
 * 아니라 LLM 에게 "models" 라고 물어 비결정적 산문을 돌려준다. `--help` 는 준-기계판독
 * 대용이다: --model 옵션 블록에 따옴표로 감싼 별칭 예시가, --effort 블록에 괄호로
 * 감싼 열거가 들어 있다.
 *
 * 형식이 어긋나면(help 포맷 변경) 빈 배열을 낸다. **물러날 폴백 목록은 없다** — 계획 3
 * 태스크 9 가 `fallback-models.mjs` 를 지웠다. 그때 도는 것은: `discover` 가
 * `models: []` 로 reachable 을 보고하고 → `catalog.mjs` 의 `writeCatalog` 가 빈 목록을
 * 거절해 **이미 있던 좋은 캐시를 지키고** → 캐시도 없으면 `orch_config` 가 빈 목록에
 * `orch_models 를 먼저 부르세요` notice 를 붙여 낸다(`src/tools.mjs` 의
 * `emptyCatalogNotice`). 목록이 없는 벤더는 effort 검사를 건너뛴다.
 */
export function parseClaudeHelp(helpText) {
  if (typeof helpText !== 'string' || helpText.trim() === '') return { aliases: [], efforts: [] };

  const modelBlock = extractOptionBlock(helpText, '--model <model>');
  const aliases = [...modelBlock.matchAll(/'([a-z][a-z0-9.\-]*)'/g)]
    .map((m) => m[1])
    // 전체 모델 이름(claude-…)은 별칭이 아니다. 별칭만 쓰면 새 모델이 나와도 안 썩는다.
    .filter((alias) => !alias.startsWith('claude-'))
    .filter((alias, i, all) => all.indexOf(alias) === i);

  const effortBlock = extractOptionBlock(helpText, '--effort <level>');
  const effortMatch = effortBlock.match(/\(([a-z]+(?:\s*,\s*[a-z]+)+)\)/);
  const efforts = effortMatch
    ? effortMatch[1].split(',').map((e) => e.trim()).filter((e) => e !== '')
    : [];

  return { aliases, efforts };
}

/** 옵션 시작 줄부터 다음 옵션 줄(선행 공백 후 -/-- 로 시작) 직전까지. */
function extractOptionBlock(helpText, optionStart) {
  const lines = helpText.split('\n');
  const block = [];
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!inBlock) {
      if (line.trimStart().startsWith(optionStart)) {
        inBlock = true;
        block.push(line);
      }
      continue;
    }
    // 다음 옵션 줄에서 끊는다. 들여쓰기 상한 10칸은 "옵션 줄"과 "이어지는 설명 줄"을
    // 가르는 경계다 — 실측 help 는 옵션을 2칸으로 들여쓰고 설명을 그보다 훨씬 깊게
    // 정렬하므로, 설명 안의 하이픈(예: 줄 첫머리의 "- item")을 옵션으로 오인해 블록을
    // 일찍 끊는 일이 없다.
    if (/^\s{0,10}-{1,2}[A-Za-z]/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * 인증을 다루는 하위 명령의 **설명문**을 알아보는 문구. 이름이 아니라 설명을 보는 것이 요점이다
 * (WS4b §0-AU: "하위 명령 이름을 계약에 박지 않는다").
 *
 * ★★ 왜 이름이 아니라 설명인가. 이름은 벤더마다 다르고 판마다 바뀐다 — 캡처가 오늘 보여 주는
 *   것은 claude 의 `auth`(`test/captures/claude-help.txt:217`) 하나뿐이고, `codex --help` 는 이
 *   저장소에 캡처가 아예 없다(메모 §E.4). 이름 목록을 코드에 적으면 그 목록이 곧 계약이 되고,
 *   벤더가 이름을 바꾸는 날 프로브는 조용히 「인증 명령이 없다」고 답한다. 설명문은 두 CLI 가
 *   같은 낱말(authenticate·login)을 쓰고, 안 쓰게 되면 프로브는 `auth_unknown` 으로 물러난다 —
 *   그것이 이 설계의 기본값이고 아무것도 막지 않는다.
 */
export const AUTH_COMMAND_TEXT = /authenticat|log ?in\b|sign ?in\b|credential/i;

/**
 * 실행해도 되는 **조회 이름**. 두 벤더 실측이 둘 다 `status` 다 — claude 는 `auth status`,
 * codex 는 `login status`(2026-08-25 컨트롤러 라이브 캡처, `test/captures/vendor-auth-probe.json`).
 *
 * ★★ 이것은 **발견의 계약이 아니라 실행의 안전장치**다. 발견은 여전히 설명문으로만 한다
 *   (§0-AU: 하위 명령 이름을 계약에 박지 않는다) — 이 목록이 하는 일은 「설명문이 조회라고 말한
 *   명령을 **정말로 실행할 것인가**」에 한 번 더 아니라고 답하는 것뿐이라, 목록 밖의 이름에
 *   대해서는 프로브가 아무것도 실행하지 않고 `auth_unknown` 으로 물러난다. 벤더가 이름을 바꾸는
 *   날 이 게이트가 하는 일은 **막지 않는 답을 내는 것**이고, 그것이 이 설계의 기본값이다(§0-D2).
 */
export const AUTH_QUERY_NAME = /^(?:status|whoami|who-am-i)$/;

/** 설명문이 **읽기 동사로 시작**해야 한다. 실측 둘: "Show authentication status" · "Show login status". */
const READ_VERB_LEAD = /^(?:show|print|display|report|check|view|list|get|inspect|describe)\b/i;

/** 이름 축의 거부. 이름 허용목록이 언젠가 넓어져도 남는 바닥이다. */
const MUTATING_NAME = /(?:^|[-_])(?:login|logout|signin|signout|sign|revoke|rotate|refresh|renew|switch|set|setup|add|create|remove|delete|clear|reset|change|update|configure|register|token|key|secret)(?:$|[-_])/i;

/** 설명문 축의 거부 — 변경 동사와 **자격 노출** 낱말. */
const MUTATING_TEXT = /\b(?:log ?out|sign ?in|sign ?out|revoke|rotate|refresh|renew|switch|set|setup|set ?up|unset|register|add|create|remove|delete|clear|reset|change|update|configure|store|browser|token|key|secret|credential)/i;

/**
 * 인증 **조회**(읽기 전용) 하위 하위 명령인가. `login`·`logout` 을 부르지 않기 위한 것이다:
 * 이름을 모르는 명령을 그냥 부르면 프로브가 사용자의 세션을 끊거나 브라우저를 여는 사고가 난다.
 *
 * ★★ **술어 하나로는 그것을 못 막는다는 것이 실측이다**(WS4b 태스크 4 리뷰 C1). 예전 판은 설명문
 *   하나만 봤고(`/status|who ?am ?i|(?:show|print|display|current)…(?:account|login|session)/`),
 *   그 술어에 `Revoke the current login session` · `Rotate the current account key` ·
 *   `Switch the current account` · `Set your presence status` 가 **전부 걸렸다**. 게다가 문서 순서
 *   첫 일치가 이기므로, 벤더 help 가 그런 줄을 조회보다 먼저 적는 날 프로브는 사용자의 실제
 *   자격으로 그 명령을 **실행한다**. 그 배치는 가설이 아니다 — 2026-08-25 라이브 캡처의
 *   `codex --help` 는 `login  Manage login` 을 어떤 조회 낱말보다 먼저 적는다.
 *
 * 그래서 실행 대상은 **양성 둘과 거부 둘을 전부** 통과해야 하고, 하나라도 못 넘으면 실행이 0 이다:
 *   (1) 이름이 `AUTH_QUERY_NAME` · (2) 설명문이 읽기 동사로 시작 ·
 *   (3) 이름에 변경 낱말 없음 · (4) 설명문에 변경 동사·자격 낱말 없음.
 *
 * ★ `login`·`logout` 은 (4)에 **없다**. 실측 설명문 "Show login status" 가 그 낱말을 명사로 쓰기
 *   때문이다 — 동사 자리는 (2)가 이미 막고, 이름 자리는 (3)이 막는다.
 * ★ `token`·`key`·`secret`·`credential` 은 변경이 아니라 **노출**이다. `Print the current session
 *   token` 은 (2)를 통과하지만 그 출력은 자격일 수 있고, 프로브는 그 출력을 벤더 표에 태운다.
 */
export function isReadOnlyAuthQuery(name, description) {
  if (typeof name !== 'string' || typeof description !== 'string') return false;
  const text = description.trim();
  return AUTH_QUERY_NAME.test(name) && !MUTATING_NAME.test(name)
    && READ_VERB_LEAD.test(text) && !MUTATING_TEXT.test(text);
}

/**
 * `--help` 의 명령 목록에서 **실행해도 되는 조회**의 이름을 낸다. 없으면 null — 그때 프로브는
 * 아무것도 실행하지 않는다. 「첫 일치로 물러나는」 갈래는 없다(그것이 C1 이었다).
 */
export function findAuthQueryCommand(helpText) {
  for (const { name, description } of helpCommandLines(helpText)) {
    if (isReadOnlyAuthQuery(name, description)) return name;
  }
  return null;
}

/**
 * `--help` 의 명령 목록 줄을 `{name, description}` 으로 낸다.
 *
 * 두 CLI 의 help 형식(commander 두 칸 정렬 · clap 들여쓰기)이 같은 모양을 공유한다: 얕게 들여쓴
 * 이름, 선택적 별칭·인자 표기, 두 칸 이상의 공백, 설명. 그래서 파서 하나가 둘을 다 읽는다.
 *
 * ★ 들여쓰기 상한 8칸이 **이어지는 설명 줄**을 배제한다(실측 claude help 의 이어지는 줄은 40칸
 *   들여쓰기다) — 없으면 설명의 둘째 줄 첫 낱말이 명령 이름으로 잡힌다.
 * ★ 옵션 줄(`-`/`--` 로 시작)은 이름 문법이 소문자 글자로 시작하도록 요구해 자동으로 빠진다.
 */
function* helpCommandLines(helpText) {
  if (typeof helpText !== 'string') return;
  for (const raw of helpText.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const match = /^\s{1,8}([a-z][a-z0-9-]*)(?:\|[a-z0-9|-]+)?(?:\s+(?:\[[^\]]*\]|<[^>]*>))*\s{2,}(\S.*)$/.exec(line);
    if (match !== null) yield { name: match[1], description: match[2] };
  }
}

/**
 * 설명문이 `wanted` 에 걸리는 **첫 명령의 이름**을 낸다. 없으면 null.
 *
 * ★★ 첫 일치가 이긴다. **이 이름은 조회 실행의 argv[0] 이기도 하다**(`claude.mjs:404`·`codex.mjs:306`
 *   의 `probe([command, query])`; `test/discover-parse.test.mjs:214` 가 그 argv 를 못 박는다). 이름 축
 *   거부(`MUTATING_NAME`)는 leaf 에만 걸리므로 안전의 근거는 **합성**이다: argv[0] 은 네임스페이스
 *   선택자이고 실행되는 것은 그룹 help 가 광고했고 게이트 넷을 넘은 leaf 하나뿐이며, 그룹 이름
 *   단독으로는 실행되지 않는다(사슬 `login status` 의 `login` 은 `MUTATING_NAME` · 2026-08-25 캡처).
 */
export function findHelpCommand(helpText, wanted) {
  if (!(wanted instanceof RegExp)) return null;
  for (const { name, description } of helpCommandLines(helpText)) {
    if (wanted.test(description)) return name;
  }
  return null;
}

/**
 * `codex debug models` 의 JSON 을 파싱한다. 실제 서브커맨드이므로 결정론적이다.
 *
 * visibility === "list" 인 모델만 남기고 priority 오름차순으로 정렬한다(CLI 자신의
 * 순서와 일치). 알 수 없는 값은 0 이나 false 가 아니라 **null** 로 남긴다 — "모른다"와
 * "0"은 다르고, 0 을 사실로 읽으면 컨텍스트 예산 계산이 조용히 틀린다.
 */
export function parseCodexModels(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.trim() === '') return { ok: false, models: [] };

  let root;
  try {
    root = JSON.parse(jsonText);
  } catch {
    return { ok: false, models: [] };
  }
  if (root === null || typeof root !== 'object' || !Array.isArray(root.models)) {
    return { ok: false, models: [] };
  }

  const listed = [];
  for (const model of root.models) {
    if (model === null || typeof model !== 'object') continue;
    if (typeof model.visibility !== 'string' || model.visibility.toLowerCase() !== 'list') continue;
    if (typeof model.slug !== 'string' || model.slug.trim() === '') continue;

    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .filter((l) => l !== null && typeof l === 'object' && typeof l.effort === 'string' && l.effort !== '')
          .map((l) => l.effort)
          .filter((e, i, all) => all.indexOf(e) === i)
      : [];

    const defaultEffort =
      typeof model.default_reasoning_level === 'string' && model.default_reasoning_level !== ''
        ? model.default_reasoning_level
        : null;

    const contextWindow =
      Number.isInteger(model.context_window) && model.context_window > 0 ? model.context_window : null;

    const priority = Number.isInteger(model.priority) ? model.priority : Number.MAX_SAFE_INTEGER;

    listed.push({ entry: { name: model.slug, efforts, defaultEffort, contextWindow }, priority });
  }

  if (listed.length === 0) return { ok: false, models: [] };

  // 동점이면 원래 순서를 유지한다. ES2019 부터 Array.prototype.sort 는 안정 정렬이
  // 보장되므로 별도의 index 타이브레이커는 필요 없다 — 실측으로도 확인했다.
  // priority 는 위에서 항상 정수로 정규화되므로 뺄셈이 NaN 이 될 일도 없다.
  const models = listed.sort((a, b) => a.priority - b.priority).map((item) => item.entry);

  return { ok: true, models };
}
