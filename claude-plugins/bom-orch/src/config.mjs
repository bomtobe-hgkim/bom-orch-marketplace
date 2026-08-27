import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { withLock } from './lockfile.mjs';
import { REASON } from './reason-codes.mjs';
import { fail, renderNotice } from './reason-text.mjs';
import { errorText } from './util/errors.mjs';
import { writeFileAtomic } from './util/fs-atomic.mjs';

const FILENAME = 'settings.ini';
const LOCKNAME = 'settings.lock';
const METADATA_SECTION = 'bom-orch';
export const SETTINGS_SCHEMA_VERSION = 1;
const SETTINGS_DECODER = new TextDecoder('utf-8', { fatal: true });
const AMBIGUOUS_SETTINGS = 'settings.ini contains ambiguous or invalid schema metadata, or invalid UTF-8';

/**
 * settings.ini 의 섹션 이름이 되는 벤더 id.
 *
 * `src/providers/index.mjs` 의 `PROVIDER_IDS` 와 같아야 한다 — 갈리면 그 벤더의 섹션은
 * 아무도 안 읽고 사용자가 값을 적어도 조용한 no-op 이 된다. `test/config.test.mjs` 의
 * '★ 설정 섹션 목록과 프로바이더 목록이 갈리지 않는다' 가 그 둘을 대조한다. 여기서
 * import 하지 않는 이유는 그 모듈이 프로바이더 구현을 통째로 끌어오기 때문이다 —
 * 설정 파서가 CLI 실행 코드에 의존할 이유가 없다.
 */
export const VENDORS = Object.freeze(['claude', 'codex']);

/**
 * 플래너가 내는 tier 이름.
 *
 * ★ **정본은 둘이다 — 여기와 `src/learn/bandit.mjs` 의 `AXES.tier.arms`.** 「여기가 유일한
 *   출처」라고 적어 두었던 것은 거짓이었다: `grep -rn "'strong'\|'fast'" src/` 가 잡는
 *   **코드** 줄은 그 둘이고, 하나로 합치면 학습 모듈이 설정 모듈을 import 하거나 그 반대가
 *   되어 층이 섞인다(`bandit.mjs` 를 파일·시각·전역 난수를 안 읽는 순수 모듈로 둔 것이
 *   태스크 8 의 결정이다). 그래서 **합치지 않고 묶으며**, 아래 드리프트 가드가 둘을 잠근다.
 *
 * ★ 둘을 묶는 것은 드리프트 가드다: `test/config.test.mjs` 의
 *   '★ 설정의 티어 목록과 밴딧의 티어 팔이 갈리지 않는다' 가 `[...TIERS]` 와
 *   `[...AXES.tier.arms]` 를 정확값으로 대조하고, **모르는 값의 낙하지점**(`resolveTier` 의
 *   `TIERS[0]` ↔ `AXES.tier.default`)까지 같은지 본다. `VENDORS` ↔ `PROVIDER_IDS` 가드와
 *   같은 축이다(그쪽은 settings.ini 의 섹션 이름).
 *
 * ★ 이 배열에서 파생되는 것: 아래 `TIER_FIELDS`·`INI_KEY_TIER`·`resolveTier`,
 *   `src/tools.mjs` 의 `TIER_FIELDS`·도구 스키마 `tier` enum·「vendor 와 tier 를 함께
 *   주세요」 recovery 문구. `src/engine.mjs` 의 `tier.name` 만 **`AXES.tier` 쪽에서**
 *   파생한다 — 거기는 밴딧이 고른 팔을 받는 낙하지점이라 그쪽 정본을 따르는 것이 맞고,
 *   위 가드가 두 정본을 같게 잡아 준다.
 *
 * ★ 예전에는 다섯 곳에 글자로 흩어져 있었다. 가장 나빴던 것은 ini 키 → 티어 판정이
 *   `field.startsWith('fast') ? 'fast' : 'strong'` 이었다는 점이다 — 나중에 `balanced`
 *   티어를 더하면 그 키가 **조용히 `'strong'` 으로 분류돼 엉뚱한 티어 쌍을 검사**한다.
 *   `src/engine.mjs` 에는 같은 형태(`decisions.tier === 'fast' ? 'fast' : 'strong'`)가
 *   한 라운드 더 살아남아 있었다 — 수정 라운드 2 가 그것도 `AXES.tier` 파생으로 바꿨다.
 */
export const TIERS = Object.freeze(['strong', 'fast']);

/**
 * 우리가 내는 tier 필드 이름 ↔ settings.ini 의 키 이름.
 *
 * ★ 읽기(`tierConfig`)와 쓰기(`writeSettings`)가 **이 표 하나만** 본다. 예전처럼 양쪽에
 *   글자로 적으면 한쪽만 고쳤을 때 쓴 값을 다시 못 읽는다 — 쓰기 경로에서 실제로 그렇게
 *   될 뻔했다(브리프의 `serializeIni` 는 `strongEffort` 를 그대로 키로 썼고, 그것은
 *   `strong_effort` 를 찾는 이 표에 안 걸린다).
 */
const TIER_FIELDS = Object.freeze(
  Object.fromEntries(TIERS.flatMap((tier) => [[tier, tier], [`${tier}Effort`, `${tier}_effort`]])),
);

/** ini 키 → 그 키가 속한 티어. 패치가 건드린 티어만 검증하려고 쓴다. */
const INI_KEY_TIER = Object.freeze(
  Object.fromEntries(TIERS.flatMap((tier) => [[tier, tier], [`${tier}_effort`, tier]])),
);

/**
 * 헤더 줄: `[이름]`. 닫는 대괄호 뒤에 뭐가 오든 신경 쓰지 않는다 — 주석이든 잡동사니든.
 *
 * 줄 전체가 맞아야 한다고 하면(`…\]\s*(?:[;#].*)?$`) `[claude] 메모` 같은 줄이 헤더로
 * 안 잡히고, 그 뒤 규칙은 그런 줄을 만나면 섹션을 닫아버리므로 멀쩡한 나머지 설정까지
 * 통째로 사라진다(실측). 반면 닫는 대괄호가 아예 없는 `[claude` 는 여전히 안 맞아서
 * 섹션이 닫힌다 — 이름을 어디서 끊어야 할지 알 수 없으니 그게 맞다.
 */
const SECTION_HEADER = /^\[([^\]]*)\]/;

/**
 * 아주 작은 INI 파서. 섹션 밖의 키는 무시한다 — 섹션을 무시하는 정규식은 다른 섹션의
 * 값을 훔친다(Bom 의 nvidia 어댑터가 정확히 그 버그를 고쳤다).
 *
 * 내부 축적은 프로토타입 없는 객체에 한다. 평범한 `{}` 에 모으면 `[__proto__]` 섹션이
 * 진짜 Object.prototype 에 값을 써서 프로세스 전체를 오염시키고(실측: 그 뒤 만들어진
 * 모든 `{}` 에 그 키가 보인다), `[constructor]` 섹션은 네이티브 함수의 읽기 전용
 * 속성에 대입하다 TypeError 를 던진다. 사용자가 직접 고치는 파일이라 이런 이름이
 * 악의가 아니라 오타로도 들어올 수 있다.
 *
 * ★ **값 뒤의 인라인 주석은 지원하지 않는다 — 주석까지 값의 일부가 된다.** `=` 뒤를
 *   `trim()` 만 하기 때문이다. 실측: `[claude]` 아래 `strong = opus ; 내 메모` 는
 *   `readSettings().claude.strong === 'opus ; 내 메모'` 가 되고, 그 문자열이 그대로
 *   `resolveTier` → `provider.run` 의 `model` 로 가 CLI 의 `--model` 값이 된다.
 *   **헤더 뒤**의 인라인 주석은 처리하는데(`SECTION_HEADER` 가 닫는 대괄호 뒤를 버린다)
 *   값 뒤는 안 하는 비대칭이 있다. 고치는 쪽(`;` 앞을 자르기)은 값에 `;` 를 쓰는 길을
 *   막으므로 별도 판정거리다 — 지금은 지원하지 않는다는 사실만 못박는다.
 */
export function parseIni(text) {
  const sections = Object.create(null);
  let section = null;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      // `[` 로 시작한 줄은 헤더 자리다. 형식이 깨졌어도(`[claude`, `[claude] 뒤에 잡동사니`)
      // 그냥 흘려보내면 안 된다 — 뒤따르는 키가 앞 섹션에 얹혀서, 이 함수가 막으려던
      // "다른 섹션 값을 훔치는" 상황이 그대로 재현된다. 섹션 밖 상태로 되돌린다.
      // 이름 없는 `[]` 도 같다.
      const match = SECTION_HEADER.exec(line);
      const name = match ? match[1].trim() : '';
      section = name === '' ? null : name;
      if (section !== null && sections[section] === undefined) sections[section] = Object.create(null);
      continue;
    }

    if (section === null) continue; // 섹션 밖의 키는 버린다

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== '' && value !== '') sections[section][key] = value;
  }

  // 평범한 객체로 되돌려 내보낸다. 전개(spread)는 대입이 아니라 속성 생성이라
  // `__proto__` 라는 이름도 세터를 타지 않고 제 몫의 own 속성으로 남는다(실측).
  for (const name of Object.keys(sections)) sections[name] = { ...sections[name] };
  return { ...sections };
}

function tierConfig(section) {
  const source = section && typeof section === 'object' ? section : {};
  const config = {};
  for (const [field, iniKey] of Object.entries(TIER_FIELDS)) config[field] = source[iniKey] ?? null;
  return config;
}

/** 파싱된 ini 를 벤더별 tier 설정으로 옮긴다. 읽기와 쓰기가 같은 함수를 쓴다. */
function toSettings(ini) {
  const control = ini?.[METADATA_SECTION] ?? {};
  const settings = {
    writer: VENDORS.includes(control.writer) ? control.writer : null,
    learning: control.learning === 'off' ? 'off' : 'on',
  };
  for (const vendor of VENDORS) settings[vendor] = tierConfig(ini[vendor]);
  return settings;
}

/** JSON은 400자리 정수를 +Infinity로 읽으므로 진단 가능한 유한 상한으로 포화한다. */
function jsonSafeSchemaVersion(value) {
  if (Number.isInteger(value)) return value;
  return value === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : null;
}

function classifySettingsSchema(text, ini) {
  let markers = 0;
  let section = null;
  for (const line of splitLines(text)) {
    const trimmed = line.text.trim();
    if (trimmed.startsWith('[')) {
      section = headerNameOf(trimmed);
    } else if (section === METADATA_SECTION && keyNameOf(trimmed) === 'schemaVersion') {
      markers += 1;
    }
  }
  if (markers === 0) return { status: 'legacy' };
  if (markers > 1) return { status: 'invalid' };
  const raw = ini?.[METADATA_SECTION]?.schemaVersion;
  const found = typeof raw === 'string' && /^(?:0|[1-9]\d*)$/.test(raw)
    ? jsonSafeSchemaVersion(Number(raw))
    : null;
  if (!Number.isInteger(found)) return { status: 'invalid' };
  if (found > SETTINGS_SCHEMA_VERSION) {
    return {
      status: 'newer',
      stateSchema: { file: FILENAME, status: 'newer', found, supported: SETTINGS_SCHEMA_VERSION },
    };
  }
  return { status: found === SETTINGS_SCHEMA_VERSION ? 'current' : 'legacy' };
}

function settingsTextOf(raw) {
  if (typeof raw === 'string') return raw;
  if (!ArrayBuffer.isView(raw)) return null;
  try {
    return SETTINGS_DECODER.decode(raw);
  } catch {
    return null;
  }
}

/**
 * settings.ini 를 읽는다. 파일이 없으면 전부 null 인 설정 — 그게 "CLI 자신의 기본
 * 모델·effort 를 쓰라"는 뜻이다. 설치 직후 아무 설정 없이 바로 동작해야 한다.
 *
 * ★ `[worktree] link_dirs` 는 **읽지 않는다.** 설계 §5.6 이 `node_modules`·`.venv` 를
 *   워크트리에 정션/심링크로 걸어 주는 손잡이로 적어 두었지만, 계획 2 는 링크를 걸지
 *   않기로 했다 — 심링크는 이 제품에서 실제로 성립하는 유일한 격리(일회용 워크트리,
 *   §12.0)를 그대로 뚫는다. 파싱만 남겨 두었더니 `src/` 안의 소비자가 0곳인 채로
 *   사용자가 값을 적으면 아무 일도 안 일어나고 아무도 알려주지 않았다. **일부러 안
 *   만든 기능의 손잡이**라 조용한 no-op 중에서도 나쁜 쪽이라 파싱을 지운다. 그 섹션은
 *   다른 미지의 키와 마찬가지로 무시된다.
 *
 * ★ `readable` 은 봉투의 `confidence` 가 쓰는 신호다(WS0 §2.2: 「조회는 정본 파일 읽음」이
 *   verified, 「파일 읽기 실패」가 unverified). **없는 파일은 읽기 실패가 아니다** — 그때의
 *   「전부 null」 은 이 호출이 확립한 사실이다(파일이 없다는 것을 방금 봤다). 권한·EISDIR
 *   처럼 파일이 있는데 못 읽은 경우만 거짓이고, 그때의 「전부 null」 은 지어낸 답이다.
 */
export async function readSettingsStatus(stateRoot) {
  try {
    const text = settingsTextOf(await readFile(join(stateRoot, FILENAME)));
    if (text === null) return { settings: toSettings({}), readable: false };
    const ini = parseIni(text);
    const schema = classifySettingsSchema(text, ini);
    if (schema.status === 'invalid') return { settings: toSettings({}), readable: false };
    return schema.status === 'newer'
      ? { settings: toSettings({}), readable: true, stateSchema: schema.stateSchema }
      : { settings: toSettings(ini), readable: true };
  } catch (error) {
    return { settings: toSettings({}), readable: error?.code === 'ENOENT' };
  }
}

/** 설정만. 읽을 수 있었는지까지 필요하면 `readSettingsStatus` 를 쓴다. */
export async function readSettings(stateRoot) {
  return (await readSettingsStatus(stateRoot)).settings;
}

/**
 * tier 를 구체적인 (model, effort)로 해석한다.
 * null 은 "지정 안 함" = CLI 자신의 설정을 쓴다. 플랜에는 모델 이름이 없고 tier 만
 * 들어가므로, 모델이 교체돼도 저장된 플랜과 학습 통계가 그대로 유효하다.
 *
 * 모르는 tier 는 `TIERS[0]` 으로 읽는다 — tier 는 플래너가 내는 내부 열거값이지 사용자
 * 입력이 아니라, 여기서 던지면 오케스트레이션이 통째로 멈춘다. 그 기본 가지를
 * `test/config.test.mjs` 가 못박는다.
 */
export function resolveTier(settings, vendorId, tier) {
  const config = settings?.[vendorId];
  if (!config) return { model: null, effort: null };

  const name = TIERS.includes(tier) ? tier : TIERS[0];
  return { model: config[name] ?? null, effort: config[`${name}Effort`] ?? null };
}

/**
 * 선택한 모델·effort 조합이 유효한지 본다.
 *
 * 발견된 목록 밖의 모델은 **막지 않는다** — 새 모델이 나왔는데 우리 목록이 안
 * 따라갔다고 못 쓰게 하면 안 된다. 목록에 있는 모델일 때만 그 모델의 effort 사다리를
 * 검사한다(예: 어떤 모델엔 ultra 가 없다). 실행 중에 터지지 않고 설정 시점에 막힌다.
 *
 * 호출부는 같은 파일의 `writeSettings` 다 — 검사 대상은 패치 조각이 아니라 **파일과
 * 합친 결과**다. 조각만 보면 `{strongEffort:'ultra'}` 처럼 모델이 안 실린 패치에서
 * 위 첫 줄의 이른 반환에 걸려 늘 통과한다(실측).
 *
 * ★ `scope`(WS2 Task 16): `writeSettings` 는 벤더·티어를 다루지만 이 함수는 그것을 모른다
 *   — 밴딧 팔과 같은 목록을 여러 벤더·티어에 걸쳐 검사하기 때문에, vendor·tier 를 하드코딩
 *   하면 이 함수가 한 벤더에 묶인다. `scope` 를 주면 `config_settings_effort_unsupported`
 *   (문구에 vendor·tier 가 실린다)를, 안 주면 도구 인자 검증(`src/envelope.mjs`)이 쓰는
 *   `config_effort_unsupported` 를 낸다 — 실측 결함(vendor/tier 를 몰라 fast 사다리 위반을
 *   strong 사다리로 잰 것처럼 보이는 오류가 나갔다)의 수정이다.
 */
export function validateSelection(models, model, effort, scope) {
  if (model === null || model === undefined || effort === null || effort === undefined) return { ok: true };

  const entry = Array.isArray(models) ? models.find((m) => m.name === model) : undefined;
  if (!entry || !Array.isArray(entry.efforts) || entry.efforts.length === 0) return { ok: true };

  if (entry.efforts.includes(effort)) return { ok: true };

  const params = { model, effort, efforts: entry.efforts.join(', ') };
  return scope
    ? fail(REASON.config_settings_effort_unsupported, { ...scope, ...params })
    : fail(REASON.config_effort_unsupported, params);
}

// ── 쓰기 경로 ──────────────────────────────────────────────────────────────

/**
 * 이 모듈의 실패 봉투 — `fail()` 의 다섯 키 그대로다(WS2 Task 16).
 *
 * ★ 예전에는 `{ok:false, error, recovery}` 세 키를 손으로 지었고 문장이 여기 살았다. 이제
 *   문구는 `src/reason-text.mjs` 가 정하고 이 모듈은 **코드만** 고른다 — 호출부
 *   (`src/tools.mjs runOrchConfig`)는 `reasonCode` 를 봉투에 그대로 싣는다.
 */
const reject = (code, params) => fail(code, params);

/**
 * 패치를 `[[vendor, {iniKey: string|null}]]` 로 정규화한다. `null` 은 그 키를 지우라는 뜻.
 *
 * 모르는 벤더·모르는 필드는 **거부한다.** 조용히 버리면 사용자는 값을 적었는데 아무
 * 일도 안 일어나는 상태에 남는다 — 계획 2 가 `link_dirs` 를 지운 것과 같은 판정이다.
 */
function normalizePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return reject(REASON.config_settings_patch_invalid);
  }

  const entries = [];
  const controls = {};
  for (const [key, allowed] of [['writer', VENDORS], ['learning', ['on', 'off']]]) {
    if (!Object.hasOwn(patch, key)) continue;
    const raw = patch[key];
    if (typeof raw !== 'string') {
      return reject(REASON.config_settings_value_not_string, { vendor: METADATA_SECTION, key });
    }
    if (/[\r\n\u0000]/.test(raw)) {
      return reject(REASON.config_settings_value_unsafe, { vendor: METADATA_SECTION, key });
    }
    const value = raw.trim();
    if (value !== '' && !allowed.includes(value)) {
      return reject(REASON.config_argument_not_in_enum, { name: key, value, allowed: [...allowed, ''].join(', ') });
    }
    controls[key] = value === '' ? null : value;
  }
  if (Object.keys(controls).length > 0) entries.push([METADATA_SECTION, controls]);
  for (const vendor of Object.keys(patch)) {
    if (vendor === 'writer' || vendor === 'learning') continue;
    if (!VENDORS.includes(vendor)) {
      return reject(REASON.config_settings_vendor_unknown, { vendor, vendors: VENDORS.join(', ') });
    }
    const fields = patch[vendor];
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      return reject(REASON.config_settings_section_invalid, { vendor });
    }

    const normalized = {};
    for (const field of Object.keys(fields)) {
      if (!Object.hasOwn(TIER_FIELDS, field)) {
        return reject(REASON.config_settings_key_unknown, { vendor, key: field, keys: Object.keys(TIER_FIELDS).join(', ') });
      }
      const raw = fields[field];
      if (raw === null || raw === undefined) {
        normalized[TIER_FIELDS[field]] = null;
        continue;
      }
      if (typeof raw !== 'string') {
        return reject(REASON.config_settings_value_not_string, { vendor, key: field });
      }
      // 한 줄을 넘기는 값은 뒷줄이 **다른 키**가 된다. NUL 은 경로·파일 취급이 갈린다.
      if (/[\r\n\u0000]/.test(raw)) {
        return reject(REASON.config_settings_value_unsafe, { vendor, key: field });
      }
      const trimmed = raw.trim(); // parseIni 가 어차피 다듬는다 — 쓸 때 맞춰 둔다.
      normalized[TIER_FIELDS[field]] = trimmed === '' ? null : trimmed;
    }
    if (Object.keys(normalized).length > 0) entries.push([vendor, normalized]);
  }

  if (entries.length === 0) return reject(REASON.config_settings_patch_empty);
  return { ok: true, entries };
}

/** 패치를 적용한 뒤의 (model, effort) 를 티어별로 검사한다. 건드린 티어만 본다. */
function validateMerged(ini, entries, models) {
  for (const [vendor, fields] of entries) {
    if (vendor === METADATA_SECTION) continue;
    const list = models && Array.isArray(models[vendor]) ? models[vendor] : null;
    if (list === null) continue; // 목록을 못 얻었다 — 사용자가 적은 값을 믿는다.

    const merged = { ...(ini[vendor] ?? {}) };
    for (const [iniKey, value] of Object.entries(fields)) {
      if (value === null) delete merged[iniKey];
      else merged[iniKey] = value;
    }

    for (const tier of new Set(Object.keys(fields).map((iniKey) => INI_KEY_TIER[iniKey]))) {
      const model = merged[TIER_FIELDS[tier]] ?? null;
      const effort = merged[TIER_FIELDS[`${tier}Effort`]] ?? null;
      const verdict = validateSelection(list, model, effort, { vendor, tier });
      // `validateSelection` 이 이미 `fail(REASON.config_effort_unsupported, …)` 를 낸다(WS2 Task
      // 16) — 그 봉투를 그대로 돌려준다. ★★ 예전에는 여기서 `reject(문장, recovery)` 로 새
      // 봉투를 지었는데, `reject` 가 `fail(code, params)` 로 바뀐 뒤에도 첫 인자가 여전히
      // 조립한 **문장**이었다 — `renderReason` 은 모르는 코드에 `TypeError` 를 던진다. 이
      // 함수는 `withLock` 본문 안에서 불리므로 그 예외는 `state_lock_work_failed` 로 둔갑해
      // 나갔고, 호출자는 "effort 를 지원하지 않는다" 대신 "쓰기 자체가 실패했다" 는 거짓을
      // 봤다(실측: `npm test` 의 orch_config effort 거부 테스트).
      if (!verdict.ok) return verdict;
    }
  }
  return { ok: true };
}

/**
 * 줄을 종결자까지 그대로 쪼갠다.
 *
 * 「손대지 않은 줄은 바이트 그대로」는 **전칭이 아니다.** 예외가 하나 있다: 마지막 줄에
 * 줄 종결자가 없으면 하나 붙는다(`patchIniText` 가 `eol` 로 채운다) — 그 줄을 끝내지
 * 않으면 뒤에 붙일 키가 같은 줄에 이어져 값이 뭉개진다. 실측 반례:
 * `[claude]` + 개행 + `strong = old`(끝 개행 없음) 에 `fast` 를 더하면 손대지 않은
 * `strong = old` 줄이 개행을 얻는다. 그 외에는 자기 줄 종결자까지 바이트 그대로다
 * (`test/config.test.mjs` 의 '★ 사용자의 주석…' 과 '…종결자를 얻는다' 가 양쪽을 잰다).
 */
function splitLines(text) {
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n)/g;
  let consumed = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    lines.push({ text: match[1], eol: match[2] });
    consumed = pattern.lastIndex;
  }
  if (consumed < text.length) lines.push({ text: text.slice(consumed), eol: '' });
  return lines;
}

/** `parseIni` 와 **같은 규칙**으로 헤더를 읽는다. 두 곳이 갈리면 엉뚱한 섹션에 쓴다. */
function headerNameOf(trimmed) {
  const match = SECTION_HEADER.exec(trimmed);
  const name = match ? match[1].trim() : '';
  return name === '' ? null : name;
}

/** `parseIni` 와 같은 규칙으로 `key = value` 줄의 키를 읽는다. 키 줄이 아니면 null. */
function keyNameOf(trimmed) {
  if (trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('[')) return null;
  const eq = trimmed.indexOf('=');
  if (eq < 0) return null;
  const key = trimmed.slice(0, eq).trim();
  return key === '' ? null : key;
}

/**
 * 원문을 줄 단위로 **수술**한다. 파싱 결과를 다시 직렬화하지 않는 이유: settings.ini 는
 * 사용자가 직접 고치는 파일이고 `parseIni` 는 주석도, 우리가 안 읽는 키도 안 들고 있다.
 * 다시 찍어내면 그 전부가 사라진다.
 *
 * 값을 바꿀 때는 **마지막** 등장 줄을 고친다(`parseIni` 는 뒤가 앞을 이긴다). 지울 때는
 * 그 섹션의 **모든** 등장 줄을 지운다 — 하나라도 남기면 지운 줄 앞의 옛 값이 되살아난다.
 */
function patchIniText(text, entries) {
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';

  // 줄마다 어느 섹션에 속하는지 표시한다. 헤더 줄은 자기 섹션에 속한다.
  const owner = new Array(lines.length).fill(null);
  let section = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].text.trim();
    if (trimmed.startsWith('[')) {
      section = headerNameOf(trimmed);
      owner[i] = section;
      continue;
    }
    owner[i] = section;
  }

  const replaced = new Map(); // index -> 새 줄 텍스트
  const removed = new Set();
  const inserted = new Map(); // index -> [줄 텍스트]
  const appended = [];

  for (const [vendor, fields] of entries) {
    const own = [];
    for (let i = 0; i < lines.length; i += 1) if (owner[i] === vendor) own.push(i);

    // 새 키를 꽂을 자리: 그 섹션의 마지막 **비어 있지 않은** 줄 바로 뒤.
    let insertAfter = null;
    for (const i of own) if (lines[i].text.trim() !== '') insertAfter = i;

    // 섹션이 아예 없어 끝에 새로 만드는 경우, 헤더는 이 벤더에 대해 한 번만 붙인다.
    let headerAppended = false;

    for (const [iniKey, value] of Object.entries(fields)) {
      const hits = own.filter((i) => keyNameOf(lines[i].text.trim()) === iniKey);

      if (value === null) {
        for (const i of hits) removed.add(i);
        continue;
      }

      if (hits.length > 0) {
        const target = hits[hits.length - 1];
        const indent = /^[ \t]*/.exec(lines[target].text)[0];
        replaced.set(target, `${indent}${iniKey} = ${value}`);
        continue;
      }

      if (insertAfter === null) {
        if (!headerAppended) {
          appended.push(`[${vendor}]`);
          headerAppended = true;
        }
        appended.push(`${iniKey} = ${value}`);
        continue;
      }
      if (!inserted.has(insertAfter)) inserted.set(insertAfter, []);
      inserted.get(insertAfter).push(`${iniKey} = ${value}`);
    }

  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!removed.has(i)) {
      const body = replaced.has(i) ? replaced.get(i) : lines[i].text;
      out.push(body + (lines[i].eol === '' ? eol : lines[i].eol));
    }
    for (const extra of inserted.get(i) ?? []) out.push(extra + eol);
  }
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push(eol);
    for (const extra of appended) out.push(extra + eol);
  }
  return out.join('');
}

let tempCounter = 0;

/**
 * 설정을 쓴다. `patch` 는 `{ [vendorId]: { strong?, strongEffort?, fast?, fastEffort? } }`
 * 의 **부분** 갱신이다 — `readSettings` 가 내는 것과 같은 모양이라 읽은 것을 고쳐 그대로
 * 되먹일 수 있다. 값이 `null`·빈 문자열이면 그 키를 지운다(= CLI 자신의 기본값으로).
 *
 * ★ 검증을 통과하지 못하면 **파일을 건드리지 않는다.** 반쯤 쓰고 실패하면 사용자는
 *   자기 설정이 어떤 상태인지 모른다.
 *
 * ★ `models` 는 `{ [vendorId]: [{name, efforts}] }` 다. 모델은 벤더별이므로 한 덩어리로
 *   합쳐 넘기면 안 된다 — 다른 벤더의 effort 사다리로 검사하게 된다. 어떤 벤더의 목록을
 *   못 얻었으면 그 벤더는 검사를 건너뛴다(카탈로그가 비었을 때다). 그때는 사용자가 적은
 *   값을 믿는다.
 *
 * ★ 실패해도 throw 하지 않는다. `{ok:false, error, recovery}` — `error`/`recovery` 는
 *   `validateSelection` 및 실패 봉투와 같은 어휘다(브리프의 `reason` 을 쓰면 봉투가
 *   recovery 를 잃고 일반 문구로 채워진다).
 */
export async function writeSettings(
  stateRoot,
  patch,
  { models = null, readSettingsFile = readFile, writeSettingsFile = writeFileAtomic } = {},
) {
  if (typeof stateRoot !== 'string' || stateRoot === '' || !isAbsolute(stateRoot)) {
    return reject(REASON.state_root_not_absolute);
  }

  const normalized = normalizePatch(patch);
  if (!normalized.ok) return normalized;

  const file = join(stateRoot, FILENAME);
  try {
    await mkdir(stateRoot, { recursive: true });
  } catch (error) {
    // WS1 C2 — `?? error` 는 message 가 빈 오류에서 `[object Object]` 를 냈다. 사다리는 하나다.
    return reject(REASON.state_directory_create_failed, { detail: errorText(error) });
  }

  // 잠금 본문은 읽기 → 검증 → 임시 파일 → rename 이다. `withLock` 은 본문이 staleMs
  // (기본 60초)보다 오래 걸리면 상호 배제가 깨진다 — 그쪽 파일이 실측으로 적어 두었다.
  //
  // 실측(WS1 태스크 15 재측정, Windows 11/NTFS/Node v24.18.0, 로컬 tmpdir, `writeSettings`
  // 호출 **전체**, 50회 × 3판 = 케이스당 150표본). 본문은 그보다 짧다:
  //     빈 파일  2.1~12.6ms (판별 중앙값 2.6·2.4·2.4, 판별 최댓값 12.6·3.2·3.1)
  //     4000줄   2.8~5.9ms  (판별 중앙값 3.3·4.1·3.6, 판별 최댓값 5.9·5.3·4.5)
  // ★ 이것은 **상한이 아니라 관측 범위**다. 두 케이스 모두 전체 최댓값이 **첫 판에서만**
  //   나왔고(빈 파일 12.6ms 대 나머지 두 판 3.2·3.1ms) 그 판 50표본 중 1건이다 — 워밍업
  //   이지 이 코드의 비용이 아니다. 자릿수가 같아 결론(staleMs 60초에 한참 못 미친다)은
  //   변함없지만, 여기 적힌 최댓값을 「이 값을 안 넘는다」로 읽으면 안 된다. 하드 실링을
  //   원하면 재는 것이 아니라 staleMs 를 명시로 넘겨야 한다.
  // ★ 이 수는 쓰기를 `src/util/fs-atomic.mjs` 로 옮긴 **뒤**의 것이다. 같은 세션·같은
  //   방법으로 옮기기 직전에 잰 대조군은 빈 파일 2.0~3.9ms(중앙값 2.4·2.5·2.4)·4000줄
  //   2.4~5.9ms(중앙값 3.2·3.2·3.3) 였다 — 중앙값이 그대로다. 이전이 이 수를 움직이지
  //   않은 이유는 아래에서 `fsync:false` 로 명시 옵트아웃했기 때문이다(fsync 는 쓰기당
  //   +1.3ms — `src/learn/posteriors.mjs` 헤더의 실측). 그 줄을 지우면 이 표가 거짓이 된다.
  // ★ 이 수는 전부 **무경합** 수치다. 잠금이 남에게 잡혀 있으면 여기는 timeoutMs 를
  //   다 쓰고 실패한다 — 실측 **5.0초**('★ 잠금을 못 잡으면 …' 테스트). 그 값은 측정이
  //   아니라 구조다(`withLock` 의 기본 `timeoutMs` 가 5000ms 다).
  //   `orch_config` 를 두 세션이 동시에 부르면 한쪽이 그만큼 붙잡힌다.
  // ⚠ 느린 네트워크 드라이브나 아주 큰 settings.ini 에서도 60초 안에 끝난다고는 **재지
  //   않았다.** 그런 환경이 확인되면 여기에 staleMs 를 명시로 넘겨야 한다.
  const held = await withLock(join(stateRoot, LOCKNAME), async () => {
    let raw;
    try {
      const bytes = await readSettingsFile(file);
      raw = settingsTextOf(bytes);
      if (raw === null) return reject(REASON.config_settings_read_failed, { detail: AMBIGUOUS_SETTINGS });
    } catch (error) {
      // 없는 파일만 빈 legacy 상태다. 읽을 수 없는 기존 파일까지 빈 값으로 접으면 POSIX의
      // writable 부모에서는 atomic rename이 그 불투명한 바이트를 새 v1 파일로 교체할 수 있다.
      if (error?.code !== 'ENOENT') return reject(REASON.config_settings_read_failed, { detail: errorText(error) });
      raw = '';
    }
    const ini = parseIni(raw);
    const schema = classifySettingsSchema(raw, ini);
    if (schema.status === 'invalid') {
      return reject(REASON.config_settings_read_failed, { detail: AMBIGUOUS_SETTINGS });
    }
    if (schema.status === 'newer') return { ok: false, stateSchema: schema.stateSchema };

    const verdict = validateMerged(ini, normalized.entries, models);
    if (!verdict.ok) return verdict;

    const userNext = patchIniText(raw, normalized.entries);
    // 값도 없고 원문도 없으면 쓰지 않는다. 없는 파일을 만들지 않으려는 것이다 — 공백만 준
    // 요청(`{strong:'   '}` = 없는 키를 지우라)이 실측으로 **빈 settings.ini 를 만들었고**,
    // 그것은 "거부하면 파일이 안 생긴다" 규칙과 어긋나 보인다. 원문이 있는 v0 파일은 값이
    // 같아도 아래 메타 섹션을 더하는 첫 정상 쓰기이므로 이 갈래에 들어오지 않는다.
    if (userNext === raw && raw === '') return { ok: true, settings: toSettings(ini), readBack: true };
    const entries = schema.status === 'current' ? normalized.entries : normalized.entries.map(([section, fields]) =>
      section === METADATA_SECTION
        ? [section, { schemaVersion: String(SETTINGS_SCHEMA_VERSION), ...fields }]
        : [section, fields]);
    if (schema.status !== 'current' && !entries.some(([section]) => section === METADATA_SECTION)) {
      entries.push([METADATA_SECTION, { schemaVersion: String(SETTINGS_SCHEMA_VERSION) }]);
    }
    const next = schema.status === 'current' ? userNext : patchIniText(raw, entries);
    if (next === raw) return { ok: true, settings: toSettings(ini), readBack: true };

    const temp = `${file}.${process.pid}.${tempCounter++}.tmp`;
    // 임시 이름은 오늘 것 그대로 넘긴다 — 도우미는 이름을 지어내지 않는다(`src/util/fs-atomic.mjs`).
    // `fsync:false` 는 명시 옵트아웃이다. 이 쓰기는 **잠금 본문 안**이고 바로 위 실측이
    // 재는 것이 그 본문인데, fsync 는 쓰기마다 +1.3ms 다(`src/learn/posteriors.mjs` 헤더).
    // settings.ini 는 사용자가 다시 쓸 수 있는 텍스트지 복구 불가능한 학습 상태가 아니다.
    // `exclusive:false` 도 오늘 동작이다 — `writeFile` 은 고아 임시 파일 위에 그냥 썼고,
    // 이름이 `<pid>.<카운터>` 라 죽은 프로세스의 고아와 겹칠 수 있어 'wx' 로 막으면 사람이
    // 지울 때까지 설정 쓰기가 영영 실패한다.
    const written = await writeSettingsFile(file, Buffer.from(next, 'utf8'), {
      tempPath: temp, fsync: false, exclusive: false,
    });
    // 던진다 — `withLock` 이 「본문이 …」 앞머리를 붙여 주고, 아래가 그 앞머리로 잠금
    // 실패와 쓰기 실패를 가른다. `{ok:false}` 로 돌려주면 그 구분이 사라진다.
    if (!written.ok) throw new Error(written.reason);
    // WS0 §2.2 는 쓰기의 verified 를 「쓴 뒤 **재읽기 일치**」로 정의한다. 방금 만든 문자열을
    // 다시 파싱한 값은 그 증거가 아니다 — 그것은 rename 이 무엇을 남겼든 똑같이 나온다.
    // 잠금 **안**에서 읽는다: 밖에서 읽으면 다른 writer 가 끼어든 것을 우리 쓰기 실패로 읽는다.
    // (위 실측 표는 이 읽기 **이전**의 본문이다. 파일 읽기 한 번이 늘었고, 자릿수는 그대로다.)
    const settings = toSettings(parseIni(next));
    const back = await readSettingsStatus(stateRoot);
    return { ok: true, settings, readBack: back.readable && JSON.stringify(back.settings) === JSON.stringify(settings) };
  });

  // ★★ 잠금 실패와 본문 실패는 **호출자에게 다른 뜻**이다. 잠금을 못 잡았으면 본문이 아예
  //   안 돌았으니 파일은 그대로고 다시 시도하면 된다. 본문이 죽었으면 rename 이 권한·디스크로
  //   실패했을 수 있고 그때는 다시 시도해도 같은 결과다 — 둘을 같은 문구로 접으면 사용자가
  //   **존재하지 않는 경합**을 기다린다.
  //
  // ★ 판정은 `reasonCode` 다. WS2 Task 16 이전에는 `held.reason.startsWith('본문이')` 였다 —
  //   한국어 산문이 제어 흐름이었고, 그 문장을 영어로 옮기는 순간 이 분기가 조용히 죽는다.
  //   `src/lockfile.mjs` 는 이제 본문 실패에만 `state_lock_work_failed` 를 붙인다.
  if (!held.ok) {
    return held.reasonCode === REASON.state_lock_work_failed
      ? reject(REASON.config_settings_write_failed, { detail: held.error })
      : reject(REASON.config_settings_lock_unavailable, { detail: held.error });
  }

  // 잠금이 남았으면 뒤이은 쓰기가 staleMs 동안 조용히 실패한다(lockfile.mjs). 이 서버는
  // stdout 에 못 쓰므로 알릴 채널이 봉투뿐이다.
  if (held.released === false && held.value.ok) {
    return {
      ...held.value,
      notice: renderNotice('config_lock_left_behind', { reason: held.releaseReason ?? errorText(undefined) }),
    };
  }
  return held.value;
}
