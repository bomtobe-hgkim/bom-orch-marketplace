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
