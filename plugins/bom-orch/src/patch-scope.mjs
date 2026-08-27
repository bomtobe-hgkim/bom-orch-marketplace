import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runGit } from './git.mjs';
import { confidenceOfScope } from './confidence.mjs';
import { REASON } from './reason-codes.mjs';
import { fail, renderNotice, renderReason } from './reason-text.mjs';
import { TEST_RUNNER_CONFIG_NAMES, isTestCommandConfigPath } from './test-discovery.mjs';
import { allowlistVerdict } from './scope-allowlist.mjs';
import { clipPlain } from './util/strings.mjs';

/**
 * 델리게이트가 돌려보내는 패치의 **범위**를 기계적으로 검사한다 (S3c · S4).
 *
 * 이 패치는 사용자 저장소에 `git apply` 된다. 델리게이트가 `.github/workflows/*` ·
 * `.npmrc` · 셸 rc 를 고쳐 놓으면 적용하는 순간이 아니라 **그 뒤의 실행**(다음 CI,
 * 다음 `npm install`, 다음 셸)에서 발화한다. 라이브 실측으로 두 벤더 CLI 의 도구 권한
 * 플래그로는 델리게이트의 셸을 제한할 수 없다는 것이 확인됐으므로, 무엇을 건드렸는지
 * 세는 일은 여기서 한다. **LLM 에게 묻지 않는다.**
 *
 * ## ★ 입력은 `collectPatch().files` 다 — 패치 본문을 파싱하지 않는다
 *
 * 계획서의 시그니처는 `inspectPatch({ patchText, changedPaths })` 였는데 그 문장은
 * 계획 2 Task 2 **이전**에 쓰였다. Task 2 가 패치 파싱이 원리적으로 틀린다는 것을
 * 실측하고 다른 계약을 세웠고(`src/worktree.mjs` 모듈 상단), 그 계약을 여기서 쓴다:
 *
 *   - **rename 은 `---`/`+++` 줄을 아예 만들지 않는다.** rename 감지는 `diff.renames`
 *     기본값이라 항상 켜져 있다. `+++ b/` 에서 경로를 모으면
 *     `src/x.js` → `.github/workflows/x.yml` 이동이 **파일 0개**로 보여 이 검사를
 *     그냥 통과한다 — 막으려는 바로 그 공격이 무증상으로 지나간다.
 *   - `diff --git` 줄은 공백이 든 경로에서 두 경로의 경계가 모호하고, `core.quotePath`
 *     기본값에서 헤더 경로가 C-인용된다.
 *
 * `files` 는 `diff --cached --name-only -z --no-renames <baseline>` 로 뜬 원시 경로다.
 * 구분자는 `/`, 인용도 escape 도 없고, `--no-renames` 라 이동의 원본과 대상이 둘 다
 * 들어 있다. 그래서 이 모듈은 `patchText` 를 아예 받지 않는다.
 *
 * ## 이 검사가 하는 일과 하지 않는 일
 *
 * 목적은 완전 차단이 아니라 **플래그를 세우는 것**이다. 플래그가 서면
 * `confidence: 'disputed'` 를 낸다 — `src/envelope.mjs` 의 `success()` 가 그 값을
 * `status: 'failed'` 로 강등하므로 상호배타는 거기서 이미 강제된다. 여기서 다시
 * 구현하지 않는다.
 *
 * **차단 목록은 열거이고 열거는 뒤처진다.** 못 막는 것을 아래 [[잔여 위험]] 에 적어 둔다.
 *
 * ★ 실측 폐포: **25개 모듈 / 10,236줄**(자기 자신 949 포함). WS5 T3 의 정본 수입(스펙 §0 D3)이 여섯
 *   모듈 / 2,772줄을 더했다(그 전은 10개 모듈 / 4,801줄) — `test-discovery` 와 그것이 끄는
 *   `deps-provision`·`deadline`·`providers/child-env`·`project-config`·`util/errors`. 그 값으로
 *   산 것은 「테스트 명령 설정 파일 목록이 두 곳에 있지 않다」이고, 값이 비싸다고 판단되면 되돌리는
 *   길은 그 목록을 **잎으로 빼는 것**이지 여기 베끼는 것이 아니다(베끼면 목록이 둘이 된다).
 *   저장소 모듈도 `engine` 도 **0개**이고, 그것을 `test/guards/module-directions.test.mjs` 의
 *   방향 표가 잰다. T3 재심 N1–N3 수정 파도(올림, 실측): 자기 자신 763 -> 785(+22 — `gradlew.bat`
 *   표지 한 줄과 N1·N3 의 정정/기록 주석), `test-discovery` 도 25줄 늘어 폐포 총합은 7,688 ->
 *   7,735(+47 = 22 + 25). WS5 T2(올림, 실측): 자기 자신 785 -> 905 이고 모듈 하나가 늘었다 —
 *   `src/scope-allowlist.mjs`(169, 상대 import 0 인 잎). 폐포 7,735 -> **8,031**
 *   (+296 = 120 + 169 + 7 — 끝 항은 `reason-text` 의 알림 둘이다. 이 줄은 T2 가 +289 라고 적어
 *   위 표지 문장과 7 만큼 어긋나 있었고, T2 리뷰 M2 가 그것을 잡았다). T2 리뷰 C1 수정(올림,
 *   실측): 그 잎이 169 -> 203 이다 — 세그먼트 안 매칭의 백트래킹 정규식을 `**` 층과 **같은**
 *   선형 DP 로 바꿨다. 자기 자신도 905 -> 909(이 정정 문장 넉 줄)라 폐포는 8,031 -> 8,069 다.
 *   그 잎이 **매칭만** 알고 표지 목록을 모르는 것이 이 수의 값이다: 매처가 표지를 알게 되면
 *   등급 배분이 두 곳에서 정해지고, 그것이 T1·T3 이 두 번 막은 실패다.
 */

/** 인덱스 조회의 시간 상한. 큰 저장소의 `ls-files` 를 감안해 runGit 기본값보다 넉넉하다. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * `reasons` 의 상한. `src/envelope.mjs` 는 content 를 **꼬리부터** 자르므로, 이유 목록이
 * 상한 없이 늘어나면 정확히 많이 걸린 경우에 뒷부분이 사라진다. 잘라낸 개수는
 * `omitted` 와 `recovery` 에 남긴다.
 */
const MAX_REASONS = 100;

/**
 * 사유 하나가 들 수 있는 `rule` 의 **전부**. 이 모듈이 짓는 것이 정본이다.
 *
 * ★★ export 하는 이유는 봉투 쪽에 있다. `src/content-projection.mjs` 가 `rule` 을 **열거로
 *   검증**한다(WS2 스펙 §4). 그 열거를 저쪽에 손으로 베껴 두면, 여기에 규칙 하나가 늘어난 날
 *   봉투는 그 사유를 **조용히 통째로 버린다** — 붉어지는 자리 없이. 한 곳에서 태어나게 하고
 *   `test/patch-scope.test.mjs` 가 이 목록과 소스의 `rule:` 리터럴을 대조한다.
 */
export const SCOPE_RULES = Object.freeze([
  'package-baseline-missing',
  'package-baseline-unreadable',
  'package-scripts',
  'package-unreadable',
  'sensitive-path',
  'short-name',
  'symlink-escape',
  'symlink-unreadable',
]);

/**
 * 표지의 **등급** 둘. `SCOPE_RULES` 와 마찬가지로 이 모듈이 짓는 것이 정본이다 (WS5 스펙 §0 D1).
 *
 *   `hard`       적용 뒤 **명령이 도는** 자리와, **어떤 테스트 명령이 도는지를 정하는** 설정.
 *                허용목록으로 지울 수 없는 등급이다 — 그 규칙의 정본은
 *                `contract/project-config.schema.json` 의 `scope.allow` 설명이고, 그것을
 *                실제로 강제하는 입구는 WS5 T2 가 짓는다.
 *   `allowable`  lockfile 열. 위험이 없어서가 아니라(아래 lockfile 주석) 그 위험이 **다음
 *                install 에서만** 발화하고 그 install 이 이 파이프라인에 없어서다 — 워커에게
 *                Bash 가 없고 `src/test-runner.mjs` 는 의존성을 설치하지도 링크하지도 않는다
 *                (둘 다 실측). 그래서 사람이 보고 판단할 수 있는 등급이다.
 *
 * ★★ 등급은 `rule` 을 **가르지 않는다.** `rule` 은 봉투가 열거로 검증하는 값이라(위 ★★)
 *   `sensitive-path` 를 둘로 쪼개면 그 열거를 읽는 소비자가 전부 같은 날 바뀌어야 한다.
 *   등급은 「무엇에 걸렸나」가 아니라 「사람이 지울 수 있나」라서 **직교하는 축**이고,
 *   그래서 자기 필드(`tier`)로 낸다.
 * ★ 등급은 여기서 **결과를 바꾸지 않는다.** 오늘은 두 등급 다 `flagged` 이고 `disputed` 다
 *   (`confidenceOfScope` 는 `{flagged}` 하나만 받는 채로 둔다 — 스펙 §0 D2). 허용 등급이
 *   실패를 면하는 컷은 상류 셋에서 T4 가 짓는다. 여기서 먼저 면제하면 릴리스 하나가
 *   조용히 정책을 바꾼 것이 된다.
 */
export const SCOPE_TIERS = Object.freeze(['hard', 'allowable']);

/**
 * 하드 등급 **안**의 둘째 축: 프로젝트가 인수할 수 있는 표지 (WS5 스펙 §0 D1a).
 *
 * 여기 든 넷은 허용목록이 **경로를 명시했을 때만** 통과한다. 나머지 하드는 전부 **승격 불가
 * 코어**이고 어떤 허용목록으로도 지워지지 않는다. 스펙의 전수 배치가 이 목록이다:
 *
 *   `.vscode` `.claude` `.devcontainer`   편집기·에이전트·컨테이너 설정 디렉터리
 *   `.devcontainer.json`                   같은 류의 루트 파일형(그 셋과 한 부류다)
 *
 * ★ 왜 이 넷만인가: 위험이 **사용자 소유의 로컬 도구 실행**이다 — 그 도구를 켜는 사람과 이
 *   프로젝트를 여는 사람이 같으므로 프로젝트가 「우리는 이 디렉터리를 편집한다」를 선언하면 그
 *   판단은 그 사람의 것이다. 코어는 다르다: CI 다섯과 `.husky` 는 **다른 사람의 기계**(러너·
 *   커밋하는 동료)에서 돌고, `.git` 은 저장소 내부이며, 셸 rc·`.npmrc` 계열·`.mcp.json`·빌드
 *   설정·`.bom-orch.json`·테스트 명령 설정은 「무엇이 도는지」 자체를 정한다.
 * ★ gap 13 의 소음(플래그 56 중 37이 `.claude`)을 줄이는 축이 이것뿐이다 — 그 열 개를 통째로
 *   `allowable` 로 내리면 CI 도 같이 내려간다(등급은 부류가 아니라 한 값이다).
 *
 * ★★ 승격은 **표지의 축이지 경로의 허가증이 아니다.** 같은 표지에 걸린 경로라도 그 경로가
 *   테스트 명령 설정 정본(D3)이면 승격이 **철회된다** — `.claude/Makefile` 이 그 모양이다.
 *   그 자리가 `promotableAt` 이고, 그것이 T3 §5-(2)의 「매치 시점에도 술어를 걸어라」를 이행하는
 *   자리다: 어떤 글롭이 그 경로를 덮더라도 승격이 없으면 지워지지 않는다.
 */
const PROMOTABLE_MARKERS = new Set(['.vscode', '.claude', '.devcontainer', '.devcontainer.json']);

/**
 * 이 표지에 이 경로가 걸렸을 때 승격 가능한가. 사유에 얹을 **조각**을 낸다(아니면 빈 객체).
 *
 * ★ 참일 때만 키를 싣는다. 집계 `hardViolation` 과 반대인 이유는 방향이다 — 부재가 여기서는
 *   **닫는 쪽**이다(승격 안 됨 = 안 지워짐). 축을 아무도 말하지 않은 새 표지는 남는다.
 */
function promotableAt(marker, path) {
  if (!PROMOTABLE_MARKERS.has(marker)) return {};
  if (isTestCommandConfigPath(path)) return {};
  return { promotable: true };
}

/**
 * 허용목록(`scope.allow` ∪ 호출 인자)이 **이름 부를 수 없는** 항목을 고른다 — 테스트 명령 설정
 * 파일이다(스펙 §0 D3, 종료 기준 EC-5). T2 의 허용목록 검증이 이 함수를 부른다.
 *
 * ★★ 목록은 여기서 짓지 않는다. 정본은 `src/test-discovery.mjs` 가 export 하고 이 파일은 그것을
 *   **받는다**(D3). 유도의 입력(`Makefile` · pytest 설정 넷 · MSBuild 설정 · `node_modules/.bin` …)을
 *   여기 베껴 두면 갈래가 하나 늘어난 날 조용히 낡는다 — `SCOPE_RULES` 가 위 ★★ 에서 적은 것과
 *   같은 실패다.
 * ★ 문구를 만들지 않고 **사실만** 낸다. 봉투 문장의 정본은 `src/reason-text.mjs` 이고(WS2 §7.2)
 *   이 거부를 봉투에 싣는 자리는 허용목록 검증기(T2)다 — 여기서 문장을 지으면 같은 사실이 두
 *   문장으로 갈린다.
 * ★ 던지지 않는다. 목록이 아니거나 원소가 문자열이 아닌 것은 **모양**의 문제이고 그것은 스키마와
 *   검증기가 이미 보는 축이다.
 *
 * ⚠ **이 관문이 보안 경계는 아니다.** 부분 와일드카드(`Make*` · `pytest.*`)는 여기서 안 걸리고,
 *   Windows 에서는 `Make*` 가 `MAKEFI~1` 별칭까지 덮을 수 있다. 매처(T2)는 그 사실을 알지만 실제
 *   패치 경로의 8.3 모양은 `short-name` 하드 등급이 막고, 정본과 겹치는 나머지 표지도 전부 `hard` 다.
 *   그 맞물림은 `test/patch-scope.test.mjs` 의 EC-5 둘이 잰다. 이 함수가 얹는 것은 정직함 하나다 —
 *   **이름으로 부른 것은 즉시 거부하고 그 사실을 말한다.**
 *
 * @param {unknown} allow 허용목록 항목들(POSIX 글롭 문자열)
 * @returns {{entry: string, path: string}[]} 거부된 항목. 빈 배열이면 이 축에서 거부할 것이 없다.
 */
export function rejectTestCommandConfigAllow(allow) {
  return refuseAllowEntries(allow, (path) => isTestCommandConfigPath(path));
}

/**
 * 같은 관문의 **형제**: 항목이 승격 불가 하드 코어 표지를 이름 부르는가 (WS5 스펙 §0 D1a).
 *
 * T3 은 하드 코어의 **D3 조각**(테스트 명령 설정)만 냈고 CI 다섯 · `.husky` · `.git` · 셸 rc ·
 * `.npmrc` 계열 · `.mcp.json` · 빌드 설정은 「허용목록이 이름 부를 수 있나」를 말하는 자리가
 * 없었다(T3 §5-(3), C3). 이 함수가 그 자리다. 위 함수와 **한 모양**(`{entry, path}`)인 것이
 * 요점이다 — 사용자에게는 한 가지 사실이기 때문이다: 「이 항목이 부른 것은 보안 하드 리스트라
 * 무시된다」(`contract/project-config.schema.json` 의 `scope.allow` 설명 그대로).
 *
 * ⚠ 위 함수와 같은 한계다: 와일드카드가 든 세그먼트(`.git*` 로 시작하는 글롭)는 여기서 안 걸리고,
 *   그래도 지워지지 않는 것은 등급이 막기 때문이다(`promotableAt` 이 승격을 안 준다).
 */
export function rejectHardCoreAllow(allow) {
  return refuseAllowEntries(allow, hardCoreMarkerIn);
}

/**
 * 허용목록이 이름 부를 수 없는 항목 **전부**(위 둘의 합집합, 항목 기준 중복 제거).
 * 호출부(엔진)는 이것 하나만 부르고 문구는 `NOTICE_TEXT.scope_allow_hard_list_ignored` 가 짓는다.
 */
export function refusedScopeAllow(allow) {
  // 순서는 **사용자가 준 순서**다. 두 술어의 결과를 이어 붙이면 같은 목록이 부류별로 재배열되고,
  // 알림을 읽는 사람은 자기가 쓴 파일에서 그 항목을 찾을 수 없게 된다.
  const seen = new Set();
  const refused = [];
  for (const one of refuseAllowEntries(allow, (path) => isTestCommandConfigPath(path) || hardCoreMarkerIn(path) !== null)) {
    // 접은 철자로 센다 — `.npmrc` 와 `./.npmrc` 는 한 항목이고 문장에 두 번 실릴 이유가 없다.
    if (seen.has(one.path)) continue;
    seen.add(one.path);
    refused.push(one);
  }
  return refused;
}

/** 위 셋이 공유하는 걸음 — 접기와 「던지지 않는다」가 한 자리에 있어야 두 관문이 안 갈린다. */
function refuseAllowEntries(allow, refuses) {
  if (!Array.isArray(allow)) return [];
  const rejected = [];
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry === '') continue;
    // 앞의 `./` 와 뒤의 `/` 는 진단·중복 제거에서 같은 경로로 적는다. 실제 거절은 `refuses` 가 정한다.
    const path = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (refuses(path)) rejected.push({ entry, path });
  }
  return rejected;
}

/**
 * 이 경로가 승격 불가 하드 코어 표지에 걸리는가 — 걸리면 그 표지 이름, 아니면 null.
 *
 * `inspectPath` 와 **같은 규칙**으로 본다(모든 세그먼트에서 디렉터리 표지, 마지막 세그먼트에서
 * 파일 표지, 대소문자 접기). 두 걸음이 갈리면 「플래그되는데 거부는 안 되는」 항목이 생긴다.
 */
function hardCoreMarkerIn(path) {
  const segments = segmentsOf(path);
  const core = (name) => !PROMOTABLE_MARKERS.has(name);
  for (const segment of segments) {
    const folded = segment.toLowerCase();
    if (SENSITIVE_DIR_SEGMENTS.get(folded) === 'hard' && core(folded)) return folded;
  }
  const last = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : '';
  return SENSITIVE_FILE_NAMES.get(last) === 'hard' && core(last) ? last : null;
}

/**
 * 경로 **세그먼트** 어디에 나타나도 걸리는 디렉터리 이름 -> 등급 (소문자 비교).
 *
 * **열 개 전부 `hard` 다**(스펙 §0 D1). 근거는 새로 짓지 않았다 — 아래 목록이 각각을
 * "적용 뒤의 실행에서 명령이 도는 자리" 로 이미 분류해 두었고, 그 문장이 곧 하드의 정의다.
 * 로드맵 §2 `:80` 의 「CI 설정 → 허용」은 스펙이 뒤집었다: `.github/workflows` 가 곧 CI
 * 설정이라 그 문장은 자기모순이었다.
 *
 * 전부 "적용 뒤의 실행에서 명령이 도는" 자리다:
 *   `.github`      workflows·actions — 다음 CI 실행
 *   `.gitlab`      CI include 조각
 *   `.circleci`    config.yml
 *   `.husky`       git hook 관리자 — 다음 커밋
 *   `.devcontainer` postCreateCommand — 컨테이너를 다시 열 때
 *   `.vscode`      tasks.json 의 자동 실행, settings.json 의 도구 경로 지정
 *   `.git`         hooks/ · info/ · config
 *   `.claude`      settings.json 의 hooks — 이 서버의 결과를 받는 쪽이 Claude Code 다
 *   `.gitea`       `.gitea/workflows` — Actions 워크플로 형식이 `.github` 와 같다
 *   `.forgejo`     같음
 *
 * ★ `.claude` 의 노이즈 실측: 사용자의 실제 저장소 14개, 커밋 2,059개를 태운 결과 플래그
 *   56개 중 **37개가 `.claude` 만이 이유**였다(66%). 최다 항목은
 *   `.claude/settings.local.json`. 이 서버를 쓰는 사람의 프로젝트에는 그 디렉터리가
 *   일상적으로 들어 있으므로 플래그가 자주 뜬다. 그래도 목록에 남긴다 — `settings.json`
 *   의 hooks 와 `commands/`·`agents/` 의 본문은 모두 명령을 실행시킬 수 있고, 이 서버의
 *   결과를 받는 쪽이 바로 Claude Code 다. under-flag 는 구멍이고 over-flag 는 소음이라
 *   기본값은 안전한 쪽으로 둔다. 빈도를 줄이는 것은 배선 계층의 표시 방식이 정할 문제다.
 */
const SENSITIVE_DIR_SEGMENTS = new Map([
  ['.github', 'hard'],
  ['.gitlab', 'hard'],
  ['.circleci', 'hard'],
  ['.husky', 'hard'],
  ['.devcontainer', 'hard'],
  ['.vscode', 'hard'],
  ['.git', 'hard'],
  ['.claude', 'hard'],
  ['.gitea', 'hard'],
  ['.forgejo', 'hard'],
]);

/**
 * 마지막 세그먼트(= 파일 이름)가 이것이면 걸린다 -> 등급 (소문자 비교). 중첩 경로에서도 본다 —
 * `packages/ui/.npmrc` 는 npm 이 실제로 읽는 자리이고 루트의 것과 위험이 같다.
 *
 * 등급은 부류마다 한 덩어리다(스펙 §0 D1). **`allowable` 은 lockfile 열뿐**이고 나머지 서른넷은
 * 전부 `hard` 다 — 각 부류의 근거는 그 부류 위의 주석이 이미 적어 둔 문장 그대로다.
 *
 * ★ 이 열거가 표지의 **전부는 아니다.** 아래 `SENSITIVE_FILE_NAMES` 가 여기에 러너 설정
 *   (정본이 계산해 준 이름들)을 더한다 — 그쪽은 이 파일이 짓지 않는다.
 */
const SENSITIVE_FILE_LITERALS = new Map([
  // CI 정의 — 다음 CI 실행에서 명령이 돈다. 전부 하드다(로드맵 §2 `:80` 을 스펙이 뒤집었다).
  ['.gitlab-ci.yml', 'hard'],
  ['.gitlab-ci.yaml', 'hard'],
  ['azure-pipelines.yml', 'hard'],
  ['azure-pipelines.yaml', 'hard'],
  ['jenkinsfile', 'hard'],
  ['.travis.yml', 'hard'],
  ['appveyor.yml', 'hard'],
  ['.appveyor.yml', 'hard'],
  ['bitbucket-pipelines.yml', 'hard'],
  // 패키지 매니저 — install 시점에 스크립트·레지스트리·자격증명이 걸린다. 여기 적힌 것이
  // **어떤 명령이 무엇을 받아 도는지**를 정하므로 하드다.
  ['.npmrc', 'hard'],
  ['.yarnrc', 'hard'],
  ['.yarnrc.yml', 'hard'],
  ['.pnpmfile.cjs', 'hard'],
  ['.pypirc', 'hard'],
  ['nuget.config', 'hard'],
  // lockfile — 설계 §5.8:387 이 차단 목록에 명시했는데 코드에서 빠져 있었다(실측:
  // `package-lock.json`·`yarn.lock`·`pnpm-lock.yaml`·`Cargo.lock` 넷 전부
  // flagged=false). 잠긴 URL·integrity 를 바꾸면 다음 install 이 공격자 tarball 을
  // 가져오고 그 postinstall 이 돈다.
  //
  // 오탐 비용이 낮은 근거(둘 다 실측 기반): 워커에게는 Bash 가 없고(§12.-1),
  // `src/test-runner.mjs` 는 **의존성을 설치하지도 링크하지도 않는다.** 즉 아래
  // 이름들을 다시 쓸 수 있는 프로세스가 이 파이프라인에 없다 — 바뀌었다면 델리게이트가
  // 손으로 고친 것이다.
  //
  // ⚠ `packages.lock.json`(NuGet)은 **일부러 뺐다.** 러너가 지원하는 `dotnet test` 가
  //   암묵적 restore 를 돌리고, `RestorePackagesWithLockFile` 을 켠 프로젝트에서는 그
  //   restore 가 그 파일을 다시 쓴다 — 우리가 한 일로 사용자의 실행을 disputed 로
  //   강등하게 된다. 대신 아래 [[잔여 위험]] 에 적는다.
  //
  // ★★ **이 열이 `allowable` 등급의 전부다**(스펙 §0 D1). 위험이 작아서가 아니라 — 위 문단이
  //   적은 대로 다음 install 이 공격자 tarball 을 가져온다 — 그 install 이 **이 파이프라인에
  //   없기** 때문이다(바로 위 문단의 실측 둘). 즉 여기 걸린 변경은 「지금 명령이 돌게 되는
  //   것」이 아니라 「나중에 사람이 install 을 할 때 돌게 되는 것」이라, 사람이 보고 판단할
  //   자리가 남아 있다. 다른 표지에는 그 자리가 없다.
  ['package-lock.json', 'allowable'],
  ['npm-shrinkwrap.json', 'allowable'],
  ['yarn.lock', 'allowable'],
  ['pnpm-lock.yaml', 'allowable'],
  ['bun.lockb', 'allowable'],
  ['cargo.lock', 'allowable'],
  ['poetry.lock', 'allowable'],
  ['gemfile.lock', 'allowable'],
  ['composer.lock', 'allowable'],
  ['go.sum', 'allowable'],
  // 셸 rc — 다음 대화형 셸에서 **명령이 돈다**. 하드다.
  ['.bashrc', 'hard'],
  ['.bash_profile', 'hard'],
  ['.bash_login', 'hard'],
  ['.bash_logout', 'hard'],
  ['.profile', 'hard'],
  ['.zshrc', 'hard'],
  ['.zshenv', 'hard'],
  ['.zprofile', 'hard'],
  ['.zlogin', 'hard'],
  ['.kshrc', 'hard'],
  ['.cshrc', 'hard'],
  ['.envrc', 'hard'], // direnv — 디렉터리에 들어가는 것만으로 실행된다
  // 빌드 시스템이 자동으로 읽는 설정 — 다음 빌드에서 명령이 돈다. 하드다.
  ['directory.build.props', 'hard'],
  ['directory.build.targets', 'hard'],
  ['directory.build.rsp', 'hard'],
  ['directory.packages.props', 'hard'],
  // 이 서버의 호출자
  ['.mcp.json', 'hard'],
  // ★ 이 서버의 **프로젝트 설정**(로드맵 §3.6 / WS0 §5). 여기에 적힌 `tests.command` 가
  //   실행될 명령이 되고 `tests.reporter` 가 신뢰 증거 어댑터를 고른다 — 즉 이 파일을 고치는
  //   것은 `scripts.test` 를 고치는 것과 **같은 힘**이다. 그래서 같은 취급을 한다.
  //   `src/project-config.mjs` 는 이 파일을 커밋 오브젝트에서만 읽어 워커가 쓴 사본이
  //   명령을 정할 수 없게 하고, 이 줄은 그 위에 「고친 흔적이 있으면 사람이 본다」를 얹는다.
  //   ★ **허용목록으로 지울 수 없다** — 이 줄은 하드 코어(테스트 명령 설정, 스펙 §0 D1a)이고,
  //     하드 코어는 어떤 허용목록으로도 통과하지 않는다. 그 경로 목록의 정본은 이 파일이 아니라
  //     `src/test-discovery.mjs` 가 export 하고(D3) 위 `rejectTestCommandConfigAllow` 가 받는다.
  //   ⚠ 예전 판은 그 근거를 「`inspectPatch` 에는 플래그를 지우는 입구가 없다」라고 적었다. 그
  //     문장은 T2 가 그 입구를 뚫는 날 거짓이 되고, 그러면 이 줄의 근거가 통째로 사라진다 —
  //     근거는 입구의 **부재**가 아니라 **등급**이다. 그래서 지금 다시 썼다.
  ['.bom-orch.json', 'hard'],
  // Dev Containers 의 공식 설정 위치는 셋이다:
  //   .devcontainer/devcontainer.json · .devcontainer/<folder>/devcontainer.json · 루트 .devcontainer.json
  // 앞의 둘은 위 SENSITIVE_DIR_SEGMENTS 의 `.devcontainer` 가 잡지만, 루트 형태는 세그먼트가
  // `.devcontainer.json` 하나뿐이라 안 걸렸다. 실측: 델리게이트의 Write 한 번으로
  // `{"initializeCommand": …}` 를 심었더니 flagged=false 로 통과하고 git apply 가 exit 0 으로
  // 사용자 저장소 루트에 떨어뜨렸다. `initializeCommand` 는 컨테이너가 아니라 호스트에서 돈다.
  //
  // ⚠ 메모 §A.1 은 이 목록을 **43** 으로 셌지만 같은 칸의 열거(9+6+10+12+4+3)는 44 다. 빠진
  //   하나가 이 줄이고, 스펙 §0 D1 의 「허용 = lockfile 열뿐」이 그것을 하드로 닫는다.
  ['.devcontainer.json', 'hard'],
]);

/**
 * 파일 이름 표지의 **정본** = 위 열거 ∪ **러너 설정**(`jest.config.*` · `vitest/vite.config.*` ·
 * `nextest.toml` · `build.gradle(.kts)` · `gradlew`·`gradlew.bat` · `pom.xml`).
 *
 * ★★ 뒤쪽 목록은 여기서 짓지 않는다 — `src/test-discovery.mjs` 가 **발견이 실제로 읽는 이름들에서
 *   계산해** 내보내는 것(`TEST_RUNNER_CONFIG_NAMES`)을 받는다. 위 `rejectTestCommandConfigAllow`
 *   가 정본을 받는 것과 같은 이유이고, 같은 사실의 두 면이라 **한 원천에서 와야 한다**: 표지가
 *   플래그를 세우고 정본이 「허용목록이 그것을 지울 수 없다」를 세운다. 둘이 갈리면 허용목록이
 *   지울 수 있는 러너 설정이 생기고, 그때 종료 기준 EC-5 는 거부 술어가 초록인 채로 거짓이 된다.
 * ★ 전부 `hard` 다(D1/D1a). **`vite.config.*` 넷을 뺀 나머지**는 어떤 테스트 명령이 무엇을
 *   실행하는지를 정하므로 `.bom-orch.json` 과 같은 힘이다 — 후보가 `jest.config.js` 의
 *   `testMatch` 를 좁히면 자기 증명이 통과할 스위트를 자기가 고른 것이 된다.
 * ⚠ **`vite.config.*` 는 그 문장이 거짓인 채로 하드다(T3 재심 N1, 조정자 채택 — KEEP, 비용은
 *   기록).** 그것은 빌드 도구 설정이라 후보가 alias·plugin·build target·dev server 때문에
 *   **정당하게 계속 고치는 파일**이고, vitest 가 그것을 읽는 것은 vitest.config 가 없을 때의
 *   fallback 뿐이다. 그런데 패치 하나만 보는 이 검사는 그 프로젝트가 vitest 를 쓰는지 알 방법이
 *   없다(context-free) — vitest 를 쓰는 프로젝트에서 열어 두면 관문이 그 파일로 우회되므로 안전한
 *   쪽(하드)을 택했다. 비용은 순수 Vite 프로젝트의 평범한 편집이 지울 수 없는 disputed 가 되는
 *   것 — `package.json` 이 이미 기록한 것과 같은 실패 모양이고(아래 `inspectPackageScripts` 의
 *   WHY, 「거의 모든 JS 작업이 disputed」), 반경만 작다. 전체 논증은
 *   `src/test-discovery.mjs` 의 `TEST_RUNNER_CONFIG_NAMES` WHY — 정본이 여기서 짓지 않는 것과
 *   같은 이유로 이 논증도 저기서 짓는다.
 *
 * 허용 등급은 「나중에 사람이 install 할 때 발화한다」는 lockfile 열의 성질(위 ★★)로 정의되는데,
 * 여기 걸린 변경은 **다음 실행에서 바로** 발화한다.
 * ⚠ 겹치면 하드가 이긴다(뒤가 이기는 spread). 오늘 겹치는 이름은 **0** 이고, 겹치는 날 그 사실을
 *   `test/patch-scope.test.mjs` 의 D1 표가 붉게 말한다 — 그때 배분을 다시 판단해야 하는 것은
 *   등급이 아니라 「그 이름이 왜 두 목록에 다 있나」다.
 */
const SENSITIVE_FILE_NAMES = new Map([
  ...SENSITIVE_FILE_LITERALS,
  ...TEST_RUNNER_CONFIG_NAMES.map((name) => [name, 'hard']),
]);

/**
 * Windows 8.3 단축 이름 모양의 base. **이 축은 실측으로 재현된 공격이다.**
 *
 * 워크트리에 `.github` 가 없어도 델리게이트는 `GITHUB~1/workflows/evil.yml` 을 만들 수
 * 있고, 그 이름이 `files` 에 그대로 실린다(git 은 자기가 열거한 이름을 낸다). 그 패치를
 * `.github` 가 있는 저장소에 apply 하면 **exit 0 으로 `.github/workflows/evil.yml` 이
 * 생긴다**(실측, C: 볼륨의 8dot3name 생성이 켜져 있다). 세그먼트 정확 일치만으로는
 * 통째로 지나간다.
 *
 * git 은 `.git` 에만 특례를 둔다 — `GIT~1/hooks/pre-commit` 은 `git apply` 가 exit 128
 * `invalid path` 로 거부한다(실측). `.github` 에는 그 특례가 없다.
 *
 * 어떤 긴 이름으로 풀릴지는 대상 저장소를 봐야 알 수 있으므로 **모양만 보고 플래그**한다.
 * 실측으로 관찰한 모양: `GITHUB~1` `GITHUB~4` `GIBC34~1` `NPMRC~1` `AZURE-~1.YML`
 * `DIRECT~1.PRO` — base 는 8자 이하, 확장자는 3자 이하, `~` 뒤는 한두 자리다
 * (Windows 는 ~1..~4 를 쓰고 그 뒤로는 해시 base + `~1` 로 바꾼다).
 */
const SHORT_NAME_BASE = /^[^.]+~[0-9]{1,2}$/;

/**
 * git 이 낸 경로를 세그먼트로 쪼갠다.
 *
 * 구분자는 `/` 하나다. 역슬래시로도 쪼개지 않는 이유는 실측이다: Windows 에서는
 * 이름에 역슬래시가 든 파일을 만들 수 없고(ENOENT), 그런 경로가 든 패치는 `git apply`
 * 자신이 exit 128 `invalid path` 로 거부한다. 쪼개 봐야 막을 것이 없고 POSIX 의 정당한
 * 파일 이름(`a\b.txt`)만 잘게 나뉜다.
 */
function segmentsOf(path) {
  return path.split('/').filter((segment) => segment !== '');
}

/** 8.3 단축 이름 모양인가. */
function looksLikeShortName(segment) {
  const dot = segment.lastIndexOf('.');
  const base = dot > 0 ? segment.slice(0, dot) : segment;
  const extension = dot > 0 ? segment.slice(dot + 1) : '';
  if (base.length > 8 || extension.length > 3) return false;
  return SHORT_NAME_BASE.test(base);
}

/**
 * 한 경로에 대한 판정. 걸린 이유를 배열로 낸다(없으면 빈 배열).
 *
 * ★ 판정 단위는 **경로 세그먼트**다. 계획 1 에서 부분 문자열 금지가 실제 경로를
 *   오탐했다 — `C:\repos\network_access\worktree-1` 이 `network_access` 를 포함한다는
 *   이유로 통째로 거부됐다. `my.github.notes.md` 나 `docs/github-actions-guide.md` 가
 *   걸리면 이 검사는 곧 무시된다.
 *
 * ★ 대소문자는 접는다. 실측: 워크트리에 `.GITHUB/workflows/evil.yml` 을 만들면 그
 *   대소문자 그대로 `files` 에 실리고, `.github` 가 있는 저장소에 apply 하면 exit 0 으로
 *   **기존 `.github/workflows/` 안에** 들어간다. POSIX 에서는 `.GITHUB` 이 다른
 *   디렉터리라 이 접기가 과잉 일치이지만, 이 검사의 결과는 차단이 아니라 사람 확인
 *   요청이므로 그쪽으로 기운다.
 */
function inspectPath(path) {
  const found = [];
  const segments = segmentsOf(path);
  const last = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : '';

  for (const segment of segments) {
    const folded = segment.toLowerCase();
    if (SENSITIVE_DIR_SEGMENTS.has(folded)) {
      found.push({ path, rule: 'sensitive-path', tier: SENSITIVE_DIR_SEGMENTS.get(folded), ...promotableAt(folded, path), detail: renderNotice('scope_sensitive_segment', { segment }) });
    }
    if (looksLikeShortName(segment)) {
      // ★ 8.3 별칭은 **어떤 긴 이름으로 풀릴지 여기서 알 수 없다**(위 `SHORT_NAME_BASE` 머리말).
      //   `GITHUB~1` 이 `.github` 로 풀리는 것이 실측된 공격이므로 등급은 가장 무거운 쪽으로
      //   둔다 — 모르는 것을 허용 등급으로 부르면 그 무지가 곧 우회로가 된다.
      found.push({ path, rule: 'short-name', tier: 'hard', detail: renderNotice('scope_short_name_segment', { segment }) });
    }
  }

  if (SENSITIVE_FILE_NAMES.has(last)) {
    found.push({ path, rule: 'sensitive-path', tier: SENSITIVE_FILE_NAMES.get(last), ...promotableAt(last, path), detail: renderNotice('scope_sensitive_file', { name: segments[segments.length - 1] }) });
  }
  return found;
}

/**
 * 워크트리 인덱스의 **mode 120000**(심볼릭 링크) 항목. `{ entries }` 또는 `{ failure }`.
 *
 * ★ 계획서는 `git diff --summary` 의 mode-120000 항목을 보라고 했는데 그 처방은
 *   델리게이트가 실제로 도달할 수 있는 경우를 놓친다(실측):
 *
 *     새 심링크 생성        diff --summary: `create mode 120000 x`   ls-files -s: 120000
 *     기존 심링크 재지정    diff --summary: **아무것도 없음**        ls-files -s: 120000
 *
 *   재지정 쪽이 델리게이트에게 열려 있는 경로다. 도구가 Read/Write/Edit 뿐이라 심링크를
 *   새로 만들 수는 없지만, 하드닝의 `core.symlinks=false` 때문에 사용자 저장소의 심링크는
 *   워크트리에서 **타깃 경로가 든 일반 파일**로 체크아웃된다. 그 파일을 Write 로 고치면
 *   인덱스의 mode 는 120000 인 채 blob 만 바뀌고, 패치가 사용자 저장소의 심링크를
 *   재지정한다. `--summary` 는 create/delete/mode 변경만 적으므로 그 변화가 보이지 않는다.
 *
 *   재지정 뒤 네 출처를 나란히 잰 결과(날것 git — `runGit` 은 diff 뒤에 `-U3` 를 끼워
 *   `--summary` 전용 출력을 못 낸다):
 *
 *     diff --cached --summary     ""
 *     diff --cached --raw         ":120000 120000 c9c61fe 84476a2 M\tlink"
 *     diff-index --cached --raw   같음
 *     ls-files -s                 "120000 84476a28… 0\tlink"
 *
 *   `--raw` 계열도 낸다. 여기서 `ls-files -s` 를 쓰는 것은 인덱스 전체를 한 번에 보기
 *   때문이지 그것만 낼 수 있어서가 아니다.
 *
 * ★ **`-z` 가 필수다.** `ls-files -s` 의 기본 출력은 비 ASCII 경로를 C-인용한다
 *   (`src/worktree-patch.mjs` 의 `collectGitlinks` 가 같은 축을 기록해 뒀다). 인용된 문자열은
 *   `files` 의 원시 경로와 절대 일치하지 않아 대조가 통째로 no-op 이 된다.
 */
async function listIndexEntries({ run, worktree }) {
  const listed = await run({ args: ['ls-files', '-s', '-z'], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  if (!listed.ok || typeof listed.stdout !== 'string') return { failure: listed };

  const entries = [];
  for (const record of listed.stdout.split('\0')) {
    // "<mode> <sha> <stage>\t<path>" — `-z` 라 인용도 escape 도 없다. sha 길이를 고정해
    // 잘라내지 않는다: SHA-256 저장소는 64자다.
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, sha] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (typeof mode === 'string' && typeof sha === 'string' && sha !== '' && path !== '') {
      entries.push({ path, sha, mode });
    }
  }
  return { entries };
}

/** 인덱스 항목 하나의 blob 을 문자열로. 못 읽으면 null. */
async function readBlob({ run, worktree, sha }) {
  const blob = await run({ args: ['cat-file', 'blob', sha], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  return blob.ok && typeof blob.stdout === 'string' ? blob.stdout : null;
}

/**
 * `package.json` 의 `scripts` 블록. **읽지 못하면 `undefined`**("모른다"), 파일은 읽혔지만
 * 블록이 없으면 `{}`("없다"). 그 둘을 뭉개면 확인하지 못한 것을 "안 바뀌었다"로 기록한다.
 */
function readScripts(text) {
  if (typeof text !== 'string') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const scripts = parsed.scripts;
  return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
}

/**
 * 두 `scripts` 블록에서 **달라진 키 이름**. 같으면 빈 배열.
 *
 * 키 순서는 무시한다 — JSON 객체의 키 순서는 실행에 영향을 주지 않으므로 그것으로
 * 플래그하면 포매터 한 번에 사용자 작업이 막힌다.
 *
 * 값은 비교에만 쓰고 **밖으로 내지 않는다.** 이 모듈의 `reasons` 는 봉투를 타고 나가고,
 * 사람이 확인하는 데 필요한 것은 "어느 스크립트가 달라졌나" 다.
 */
function changedScriptKeys(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changed.push(key);
  }
  return changed.sort();
}

/** baseline의 package.json 하나를 「없음」과 「못 읽음」으로 갈라 읽는다. */
async function readBaselinePackage({ run, worktree, baseline, path }) {
  // `cat-file <tree>:<path>` 비0만 보면 경로 부재와 tree/blob 손상을 구별할 수 없다. 먼저
  // tree 항목을 이름으로 찾고, 존재한다면 그 OID를 따로 읽는다. 두 Git 호출 사이에 객체가
  // 회수돼도 둘째 실패가 unreadable로 닫힌다. literal pathspec은 파일명이 pathspec 문법처럼
  // 생겨도 다른 항목을 대신 읽지 않게 한다.
  const listed = await run({
    args: ['ls-tree', '-z', '--full-tree', baseline, '--', `:(literal)${path}`],
    cwd: worktree,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!listed.ok || typeof listed.stdout !== 'string') return { ok: false };
  const records = listed.stdout.split('\0').filter((record) => record !== '');
  if (records.length === 0) return { ok: true, text: null };
  if (records.length !== 1) return { ok: false };
  const tab = records[0].indexOf('\t');
  const [mode, type, oid] = tab === -1 ? [] : records[0].slice(0, tab).split(' ');
  const named = tab === -1 ? '' : records[0].slice(tab + 1);
  if (!/^\d{6}$/.test(mode ?? '') || type !== 'blob' || !/^[0-9a-f]{40,64}$/.test(oid ?? '') || named !== path) {
    return { ok: false };
  }
  const read = await run({ args: ['cat-file', 'blob', oid], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  return read.ok && typeof read.stdout === 'string' ? { ok: true, text: read.stdout } : { ok: false };
}

/**
 * `package.json` 의 `scripts` 블록만 베이스라인과 대조한다 (계획 2 이월 3).
 *
 * ## 왜 이름 목록이 아니라 대조인가
 *
 * `package.json` 은 이 모듈의 잔여 위험 1번이었다 — `scripts.postinstall`·`preinstall` 은
 * 적용 뒤 `npm install` 에서 돌지만, 델리게이트가 **정당하게 계속 고치는 파일**이라
 * `SENSITIVE_FILE_NAMES` 에 넣으면 거의 모든 JS 작업이 disputed 가 된다. 그래서 아무
 * 검사도 없었다(실측, 커밋 9bf38a6: 플래그 0건). 실행되는 자리는 `scripts` 하나뿐이므로
 * 그 블록만 보면 오탐 없이 그 구멍을 닫을 수 있다.
 *
 * ## `baseline` 은 커밋-ish **또는 경로 -> 원문 map** 이다
 *
 * 실제 워크트리 호출부는 이식 직후의 커밋-ish(`wt.baseline`)를 준다. 반면 순수 호출자는
 * 이미 가진 원문 map 을 준다. 둘을 한 계약으로 받으면 호출자가 원문을 다시 git 에서 읽을
 * 필요도 없고, 기존 호출도 깨지지 않는다.
 *
 * `baseline` 이 없으면 `package.json` 이 files 에 있다는 사실만으로 보수적으로 플래그한다.
 * 대조 기준이 없다고 자동 실행 설정 검사를 통째로 빼면, 인자를 빼는 호출 하나가 위험한
 * scripts 변경을 조용히 통과시킨다.
 */
async function inspectPackageScripts({ run, worktree, baseline, files, entries }) {
  const wanted = new Set(files.filter((path) => segmentsOf(path).at(-1)?.toLowerCase() === 'package.json'));
  if (wanted.size === 0) return [];

  const commitBaseline = typeof baseline === 'string' && baseline !== '';
  const sourceBaseline = baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline);
  if (!commitBaseline && !sourceBaseline) {
    return [...wanted].map((path) => ({
      path,
      rule: 'package-baseline-missing',
      tier: 'hard',
      detail: renderNotice('scope_package_baseline_missing', {}),
    }));
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const reasons = [];
  for (const path of wanted) {
    // 삭제된 파일은 인덱스에 없지만, scripts 가 사라진 것도 실행 동작의 변화다.
    const entry = byPath.get(path);
    const current = entry ? readScripts(await readBlob({ run, worktree, sha: entry.sha })) : {};
    if (current === undefined) {
      reasons.push({
        path,
        rule: 'package-unreadable',
        tier: 'hard',
        detail: renderNotice('scope_package_unreadable', {}),
      });
      continue;
    }

    let beforeText = null;
    if (commitBaseline) {
      const before = await readBaselinePackage({ run, worktree, baseline, path });
      if (!before.ok) {
        reasons.push({
          path,
          rule: 'package-baseline-unreadable',
          tier: 'hard',
          detail: renderNotice('scope_package_baseline_unreadable', {}),
        });
        continue;
      }
      beforeText = before.text;
    } else if (Object.hasOwn(baseline, path)) {
      beforeText = baseline[path];
    }
    const baselineScripts = beforeText === null ? {} : readScripts(beforeText);
    if (baselineScripts === undefined) {
      reasons.push({
        path,
        rule: 'package-unreadable',
        tier: 'hard',
        detail: renderNotice('scope_package_baseline_unreadable', {}),
      });
      continue;
    }

    const changed = changedScriptKeys(baselineScripts, current);
    if (changed.length > 0) {
      reasons.push({
        path,
        rule: 'package-scripts',
        tier: 'hard',
        detail: renderNotice('scope_package_scripts_changed', { keys: changed.join(', ') }),
      });
    }
  }
  return reasons;
}

/**
 * 심링크 타깃이 델리게이트의 작업 범위를 벗어나는가. 벗어나면 사유 문자열, 아니면 null.
 *
 * ★ 타깃은 `git apply` 가 **전혀 검사하지 않는다**(실측): 타깃이 `.git/hooks/pre-commit`
 *   이든 `../../../evil` 이든 exit 0 으로 깨끗이 적용된다. 경로 규칙(`inspectPath`)은
 *   링크가 **놓이는 자리**만 본다.
 *
 * ★ `.git` 판정은 `rel` 의 **모든** 세그먼트를 본다. 첫 세그먼트만 보면
 *   `../sub/.git/hooks/pre-commit` 처럼 중첩·벤더링된 저장소를 겨냥한 타깃이 빠져나간다
 *   (실측: 첫 세그먼트가 `sub` 라 걸리지 않았다). `inspectPath` 가 `SENSITIVE_DIR_SEGMENTS`
 *   를 모든 세그먼트에서 보는 것과 같은 규칙이다.
 *
 * ⚠ 타깃에는 이 모듈의 나머지 경로 규칙(8.3 단축 이름, `.git` 외의 차단 세그먼트)이
 *   적용되지 않는다. 고치지 않고 사실만 적는다.
 */
function describeTargetEscape(worktree, linkPath, target) {
  if (target === '') return renderNotice('scope_symlink_target_empty', {});
  // 절대 경로는 워크트리 안을 가리켜도 걸린다 — 워크트리는 일회용이라 그 경로를 사용자
  // 저장소에 심으면 곧 존재하지 않는 곳을 가리키는 링크가 남는다. (`isAbsolute` 는
  // 플랫폼 것이라 Windows 에서는 `C:\…` 와 UNC 도 여기서 걸린다.)
  if (isAbsolute(target)) return renderNotice('scope_symlink_target_absolute', { target });

  const resolved = resolve(dirname(join(worktree, linkPath)), target);
  const rel = relative(worktree, resolved);
  if (rel === '') return renderNotice('scope_symlink_target_worktree_root', { target });
  const segments = rel.split(/[\\/]/);
  if (isAbsolute(rel) || segments[0] === '..') return renderNotice('scope_symlink_target_outside', { target });
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return renderNotice('scope_symlink_target_git_internals', { target });
  }
  return null;
}

/**
 * 패치 범위를 검사한다. **절대 throw 하지 않는다.**
 *
 * @param {{ files: string[], worktree: string, baseline?: string|Record<string,string>,
 *           allow?: {entry: string, path: string}[] }} spec
 *   `files` 는 `collectPatch().files` 를 그대로, `worktree` 는 그 워크트리 경로
 *   (`wt.path`)를 준다. 구조분해로 받지 않는 것은 `spec` 이 객체가 아닐 때도 봉투를
 *   내야 하기 때문이다.
 *   `baseline` 은 선택이고 `wt.baseline`(이식 직후 커밋) 또는 경로 -> 원문 map 이다.
 *   주면 `package.json` 의 `scripts` 블록을 대조한다(`inspectPackageScripts`). 안 주면
 *   package.json 이 files 에 있다는 사실만으로 보수적으로 플래그한다.
 *   `allow` 는 허용목록의 합집합(`unionScopeAllow().entries`, WS5 T2)이다. 없거나 모양이
 *   이상하면 **아무것도 지워지지 않는다** — 이 축의 실패는 언제나 닫는 쪽이다.
 * @param {{ run?: Function }} [deps]
 * @returns `{ ok: true, flagged, hardViolation, allowlisted, reasons, omitted, confidence?, recovery? }` 또는
 *   `fail()` 봉투. `reasons` 는 `{path, rule, tier, promotable?, allowlisted, detail}` 객체이고 `detail` 은
 *   `src/reason-text.mjs` 의 정본에서 렌더된 영어 한 문장이다. `tier`·`promotable`·사유별 `allowlisted` 는
 *   **프로세스 안에서만** 산다(T4 의 판정 술어가 소비) —
 *   봉투로는 안 나간다. `content-projection.mjs` 의 `projectScopeReasons` 가 `scope.reasons` 를
 *   `{path, rule, detail}` 로 다시 지으며 셋을 뺀다 — 봉투가 싣는 것은 집계 둘
 *   (`hardViolation`·`allowlisted`)뿐이다. `confidence`/`recovery` 는
 *   **플래그가 섰고 그중 미승인이 남았을 때만** 실린다(T4 의 컷) — 이 모듈은 신뢰도를 낮추기만 하고 올리지 않는다. 호출자는 `success({ confidence, recovery })` 에 그대로 넘기면 된다.
 *
 *   ★★ `hardViolation` 은 **항상** 실린다(플래그가 없으면 `false`). 있을 때만 실으면 「없다」와
 *     「생산자가 말하지 않았다」가 같은 바이트가 되고, 그것을 읽는 컷(T4)은 두 경우에 다르게
 *     굴어야 한다. 이 자리가 D2 가 고른 자리다 — `confidenceOfScope` 의 둘째 인자를 되살리지
 *     않는다(WS2 Task 7 M4 가 「채우는 생산자가 하나도 없다」는 이유로 지운 인자다. 이제
 *     생산자는 있지만, 신뢰도 함수의 뜻은 「이 축이 신뢰도를 낮추는가」 하나로 남는 편이
 *     변경 표면이 작다 — 스펙 §0 D2).
 *   ★★ 집계 `allowlisted` 도 **항상** 실린다. 뜻은 본문의 ★★ 가 적는다: 「플래그된 사유
 *     전부가 개별로 승인됐나」(스펙 §0 D12). 컷은 `flagged && !allowlisted` 이고 그 술어를
 *     이 파일과 레인·엔진·선정이 **같은 두 불린으로** 읽는다.
 */
export async function inspectPatch(spec, deps = {}) {
  try {
    const options = spec ?? {};
    const files = options.files;
    const worktree = options.worktree;
    const run = deps?.run ?? runGit;

    // 문구는 넘기지 않는다 — 코드 하나가 `error`·`recovery`·`stopReason` 셋을 정한다(WS2 §7.2).
    // 목록이 배열이 아닌 것과 원소 하나가 문자열이 아닌 것은 **같은 사실**이다: "바뀐 파일
    // 목록을 받지 못했다". 둘을 가르던 것은 문구였고, 문구는 이제 코드가 정한다.
    if (!Array.isArray(files) || files.some((entry) => typeof entry !== 'string')) {
      return fail(REASON.scope_files_input_invalid);
    }
    // 워크트리를 모르면 심링크 축을 아예 잴 수 없다. 그 경우 경로 검사 결과만 내면
    // 호출자는 검사가 다 돌았다고 믿는다 — 조용히 절반만 도는 쪽보다 거부가 낫다.
    if (typeof worktree !== 'string' || worktree === '') return fail(REASON.scope_worktree_path_missing);

    const reasons = [];
    for (const path of files) reasons.push(...inspectPath(path));

    const listed = await listIndexEntries({ run, worktree });
    // 확인하지 못한 것을 "심링크 없음" 으로 기록하지 않는다 — 조용한 절반보다 거부가 낫다.
    //
    // ★★ 문구는 코드 하나가 정하지만(WS2 §7.2), git 이 말한 것까지 버리지는 않는다. 예전에는
    //   `listed.failure.stderr` 가 **모든 채널에서** 사라졌고, 그러면 왜 인덱스를 못 읽었는지를
    //   사후에 알 길이 없다. `detail` 은 봉투 문장이 아니라 **평면 필드**다 — 호출부(엔진)가
    //   실행 로그에 적고, 그 채널은 세척기를 지난다(`src/diag.mjs`). 200자에서 자른다.
    if (listed.failure) {
      return fail(REASON.scope_index_unreadable, {}, { detail: clipPlain(listed.failure.stderr ?? '', 200) });
    }

    const touched = new Set(files);
    for (const entry of listed.entries) {
      if (entry.mode !== '120000') continue;
      // 델리게이트가 건드리지 않은 심링크는 패치에 실리지 않는다. 사용자 저장소에 원래
      // 있던 심링크 때문에 모든 실행이 disputed 가 되면 이 검사는 곧 무시된다.
      if (!touched.has(entry.path)) continue;

      const target = await readBlob({ run, worktree, sha: entry.sha });
      if (target === null) {
        reasons.push({
          path: entry.path,
          rule: 'symlink-unreadable',
          tier: 'hard',
          detail: renderNotice('scope_symlink_unreadable', {}),
        });
        continue;
      }
      // 심링크 타깃 blob 에는 개행이 없다. 파이프라인이 붙인 꼬리 개행만 걷어낸다.
      const escape = describeTargetEscape(worktree, entry.path, target.replace(/[\r\n]+$/, ''));
      if (escape !== null) reasons.push({ path: entry.path, rule: 'symlink-escape', tier: 'hard', detail: escape });
    }

    reasons.push(
      ...(await inspectPackageScripts({ run, worktree, baseline: options.baseline, files, entries: listed.entries })),
    );

    // ★ 사유마다 허용목록 판정을 얹는다(WS5 T2). 판정 자체는 순수 잎이 하고(`scope-allowlist`)
    //   이 파일은 등급·승격 축을 사유에 실어 그 판정의 입력을 만든다 — 즉 정책은 여기, 매칭은 저기다.
    for (const reason of reasons) reason.allowlisted = allowlistVerdict(reason, options.allow);

    const flagged = reasons.length > 0;
    // ★★ 등급 판정은 **자르기 전의** 목록을 본다. `kept` 로 재면 허용 등급 백 건 뒤에 선 하드
    //   한 건이 `MAX_REASONS` 에 밀려 사라지고, 결과는 "하드 없음" 이라고 거짓말을 한다 —
    //   그것을 읽는 컷(T4)에게는 정확히 그 거짓말이 우회로가 된다.
    const hardViolation = reasons.some((reason) => reason.tier === 'hard');
    // ★★ 집계 `allowlisted` 가 답하는 질문은 **하나**다: 「플래그된 사유 **전부**가 개별로
    //   승인됐나」(스펙 §0 D12). 그래서 이 값은 T4 컷의 정확한 여집합이다 — 컷은
    //   `flagged && !allowlisted` 이고, 그 두 불린이 봉투의 바닥 단까지 함께 산다.
    //   세 성질이 의도된 것이다:
    //   (1) **모든** 사유가 투표한다 — 허용 등급(lockfile 열)도 예외가 아니다. lockfile 은 기본
    //       허용 **후보**이지 기본 통과가 아니고, 허용목록 항목이 그 경로를 덮을 때만 승인된다.
    //       ⚠ T2 는 이 집계를 하드 축으로 지었다(「하드가 있고 그 하드 전부가 이름 불렸나」).
    //       그 정의로는 항목 없는 lockfile bump 가 컷을 **그냥** 통과했고, 그것은 종료 기준
    //       EC-1 의 문언(「허용목록으로 succeeded」)과 어긋난다 — D12 가 그 어긋남을 닫았다.
    //   (2) 플래그가 하나도 없으면 **거짓**이다. 「지울 것이 없다」와 「전부 지웠다」는 다른
    //       사실이고, `flagged` 와 함께 읽으면 둘이 갈린다(공허한 참을 만들지 않는다).
    //   (3) `hardViolation` 과 **같은 목록**(자르기 전)에서 잰다. `kept` 로 재면 승인된 백 건
    //       뒤에 선 미승인 하나가 사라지고 집계가 "전부 승인됐다"고 거짓말한다 —
    //       그것을 읽는 컷에게는 정확히 그 거짓말이 우회로가 된다.
    const allowlisted = flagged && reasons.every((reason) => reason.allowlisted === true);
    const kept = reasons.slice(0, MAX_REASONS);
    const omitted = reasons.length - kept.length;
    const result = { ok: true, flagged, hardViolation, allowlisted, reasons: kept, omitted };
    // ★★ **컷 (1)/셋** (WS5 T4, 스펙 §0 D12·D2). 플래그가 섰고 그중 **미승인이 하나라도**
    //   남았을 때만 두 필드를 얹는다 — `flagged` 항을 남기는 것은 기본 모양 가드다(집계는
    //   플래그가 없으면 거짓이므로 `!allowlisted` 만 읽으면 깨끗한 패치가 컷에 걸린다).
    //   승인된 집합에는 `confidence` 도 `recovery` 도 붙지 않고, `flagged` 와 `reasons` 는
    //   **그대로 실린다**: 통과는 「안 걸렸다」가 아니라 「걸렸고 프로젝트가 미리 승인했다」이다.
    //   `disputed` 를 여기서 고르지 않고 `confidenceOfScope` 에 묻는 이유는 `src/confidence.mjs`
    //   헤더에 있다(WS0 §2.2) — D2 대로 그 함수의 2인자는 되살리지 않는다.
    if (flagged && !allowlisted) {
      Object.assign(result, { confidence: confidenceOfScope({ flagged }), recovery: buildRecovery(omitted) });
    }
    return result;
  } catch {
    // ★ 예전에는 `String(error?.message ?? error)` 로 던진 값을 문장으로 만들었고, 그 모양은
    //   `throw undefined` 에서 리터럴 'undefined' 를 봉투에 실었다(계약 `contract/envelope.json`
    //   의 error 행이 그 열두 자리를 열거한다). 던진 값은 사유가 아니므로 코드 하나로 닫는다.
    return fail(REASON.scope_inspection_failed);
  }
}

/**
 * 사람이 무엇을 확인해야 하는지. 플래그가 섰을 때 반드시 채운다.
 *
 * ★ 예전에는 이 문장이 경로 다섯과 그 사유를 **되풀이해** 적었다. 그래야 했던 이유는
 *   `reasons` 가 봉투까지 못 갔기 때문이다 — 엔진이 `scope.reasons: []` 로 버렸다. WS2
 *   Task 11 이 그 배선을 이었으므로 사유는 본문이 나르고, 회복은 다음에 할 한 문장만 말한다.
 *   문구 정본은 `src/reason-text.mjs` 다: 같은 조언이 두 문장으로 갈리면 골든이 두 줄이 된다.
 */
function buildRecovery(omitted) {
  const advice = renderReason(REASON.scope_policy_failure).recovery;
  // 잘린 개수는 사실이므로 남긴다 — 목록이 전부가 아니라는 것을 읽는 쪽이 알아야 한다.
  return omitted > 0 ? `${advice}; ${renderNotice('scope_reasons_omitted', { omitted })}` : advice;
}

/**
 * ## 잔여 위험 — 이 검사가 **못 막는** 것
 *
 * 열거는 뒤처진다(계획 2 Task 3 의 교훈). 지금 통과하는 것 중 알려진 것:
 *
 *   - `package.json` 의 `scripts` — `baseline` 이 있으면 scripts 블록만 대조하고, 없으면
 *     파일 존재만으로 보수적으로 플래그한다(계획 2 이월 3). `src/engine.mjs` 의 두
 *     호출부는 커밋-ish 를 준다. 그리고 대조하는 것은 `scripts` 블록뿐이라, `npm` 이 실행하는 다른 자리
 *     (`config`·`workspaces`·`packageManager`)는 여전히 안 본다.
 *   - `setup.py`·`conftest.py`·`Makefile` 등 빌드/테스트가 실행하는 코드. 소스 코드와 구분할
 *     방법이 없다. ★ 이 줄은 예전에 `build.gradle` 도 이름으로 적었는데 그것은 이제 표지다 —
 *     WS5 T3 의 수정 파도가 **발견이 읽는** 러너 설정(jest·vitest/vite·nextest·gradle·maven)을
 *     정본과 표지에 함께 넣었다(위 `SENSITIVE_FILE_NAMES`). 경계는 「발견이 그 이름을 생태계의
 *     증거로 읽는가」이고, 그 판정은 열거가 아니라 계산이라 여기 다시 적히지 않는다.
 *   - `go.mod`·`Cargo.toml`. 발견이 읽지만 **일부러** 표지가 아니다: 의존성 매니페스트이고 짝이
 *     되는 lockfile(`go.sum`·`cargo.lock`)이 `allowable` 이라, 하드로 두면 의존성 bump 한 번이
 *     허용목록으로도 못 지우는 플래그가 된다(그 판단의 정본은 `src/test-discovery.mjs` 의
 *     `RUNNER_COMMAND_CONFIGS` 머리말이고, 그 제외를 소스 스크레이프가 지킨다). ⚠ `Cargo.toml` 은
 *     `[[test]]`·`harness = false` 로 무엇이 도는지를 실제로 정하지만(T3 재심 N3) 제외는 그
 *     사실과 무관하다 — 서는 것은 lockfile-짝 이유 하나뿐이다.
 *   - **반대 방향의 잔여 위험(과다 차단, T3 재심 N1)**: `vite.config.*` 넷은 하드 표지인데 그
 *     등급의 근거(「고칠 정당한 이유는 무엇이 도는지를 바꾼다 뿐」)가 그 넷에는 거짓이다 —
 *     vite.config 는 빌드 도구 설정이라 vitest 를 안 쓰는 프로젝트에서도 정당하게 계속 고쳐진다.
 *     그래도 하드로 둔 이유(패치 하나만 보는 이 검사는 프로젝트가 vitest 를 쓰는지 알 방법이
 *     없다)와 그 비용(순수 Vite 프로젝트의 평범한 편집이 지울 수 없는 disputed 가 된다,
 *     `package.json` 과 같은 실패 모양·작은 반경)은 `SENSITIVE_FILE_NAMES` 머리말에 적었다 —
 *     이 줄은 그 반대쪽 실패가 어디 적혀 있는지를 가리킬 뿐이다.
 *   - `.gitattributes`(filter 드라이버)·`.gitmodules`(서브모듈 URL). 둘 다 별도 설정이
 *     있어야 발화해서 넣지 않았다.
 *   - `packages.lock.json`(NuGet). 다른 lockfile 은 위 목록에 있지만 이것만 뺐다 —
 *     러너의 `dotnet test` 가 도는 암묵적 restore 가 그 파일을 정당하게 다시 쓰므로,
 *     넣으면 **우리가 한 일**로 사용자의 실행이 disputed 로 강등된다.
 *   - `.idea/`·`.cursor/` 등 다른 편집기 설정.
 *   - 소스 파일 자체에 심은 백도어. 이 모듈은 **경로만** 본다.
 *   - `collectPatch().ignoredPaths`·`gitlinks` 가 가리키는, 패치에 실리지 않은 변경.
 *   - **자동 실행 설정이라는 부류 자체가 열거로 덮이지 않는다.** 목록에 넣은 것과 같은
 *     등급인데 빠진 것이 계속 나온다 — 편집기·컨테이너·태스크 러너·CI 벤더마다 자기
 *     위치가 있고 새 도구가 계속 생긴다. 이 목록은 "알려진 자리"를 덮을 뿐이다.
 *   - **심링크 타깃**에는 `.git` 세그먼트 검사만 걸린다. 8.3 단축 이름과 `.git` 외의
 *     차단 세그먼트는 타깃 쪽에 적용되지 않는다.
 *
 * ## 이 플랫폼에서 **재현되지 않은** 경로 동등성 축 (전부 실측)
 *
 *   - **후행 점·공백** (`.github./workflows`, `.github /workflows`): Node 로 그런
 *     디렉터리를 만들 수는 있지만 git 이 그 안을 열지 못한다. 어느 쪽으로 실패하는지는
 *     워크트리 상태에 따라 갈린다(실측):
 *       · 같은 이름의 정상 디렉터리가 이미 있으면 `git add -A` 가 exit 128
 *         `fatal: adding files failed` 로 죽는다 — `collectPatch` 가 blocked 를 낸다.
 *       · 없으면 `git add -A` 가 **exit 0 으로 조용히 건너뛴다** — 그 경로는 `files` 에
 *         아예 실리지 않으므로 패치에도 없다.
 *     어느 경우든 이 검사를 우회해 파일이 떨어지지는 않는다. 그런 경로가 든 패치를 손으로
 *     만들어도 `git apply` 가 exit 128 `invalid path` 로 거부한다.
 *   - **ADS** (`normal.txt:evil`): 스트림 생성은 성공하지만 git 은 스트림을 열거하지
 *     않는다. `files` 에 `경로:스트림` 이 나오지 않는다.
 *   - **`..` 세그먼트**: git 은 저장소 루트 기준으로 정규화한 경로만 낸다. 하위
 *     디렉터리에서 `git add ../deep/c.txt` 를 해도 `deep/c.txt` 로 나온다. `..` 라는
 *     이름의 파일은 만들 수 없다.
 *   - **유니코드 NFC/NFD**: git 은 이름 바이트를 그대로 낸다(NFC 와 NFD 가 서로 다른
 *     항목으로 보인다). 위 두 목록은 전부 ASCII 라 분해형이 존재하지 않는다.
 *   - **역슬래시**: 위 `segmentsOf` 주석 참조.
 *   - **디렉터리 정션**: git 이 따라 들어가 내용을 일반 파일로 스테이징한다(120000 이
 *     아니다). 링크 자체는 패치에 실리지 않는다.
 */
