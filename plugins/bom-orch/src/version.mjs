/**
 * 설치된 서버의 버전 정체성 정본.
 *
 * ★ 버전은 반드시 이 플러그인 루트의 `package.json`에서 읽는다. 소스 실행은
 *   `src/version.mjs -> ../package.json`, 번들 실행은 `dist/server.mjs -> ../package.json`
 *   로 같은 구조다. 코드에 버전 리터럴을 두면 매니페스트만 올린 릴리스가
 *   자기 봉투에 옛 버전을 싣게 된다.
 * ★ 업그레이드는 호스트당 두 단계다. marketplace 원본을 갱신한 뒤 설치본을
 *   갱신해야 하므로, 둘을 이름 있는 필드로 고정해 호출자가 순서를 추측하지 않게 한다.
 */

import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STRICT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

if (typeof packageJson.version !== 'string' || !STRICT_SEMVER.test(packageJson.version)) {
  throw new TypeError('package.json version must be a strict semantic version');
}

export const SERVER_VERSION = packageJson.version;

export const UPGRADE_COMMANDS = Object.freeze({
  claude: Object.freeze({
    marketplace: 'claude plugin marketplace update bom-orch-marketplace',
    plugin: 'claude plugin update bom-orch@bom-orch-marketplace --scope user',
  }),
  codex: Object.freeze({
    marketplace: 'codex plugin marketplace upgrade bom-orch-marketplace --json',
    plugin: 'codex plugin add bom-orch@bom-orch-marketplace --json',
  }),
});

/** 호출자가 정체성 필드를 위조해도 설치된 package 정보가 마지막에 이긴다. */
export function withVersionIdentity(envelope) {
  return {
    ...envelope,
    serverVersion: SERVER_VERSION,
    upgradeCommands: UPGRADE_COMMANDS,
  };
}

/** 최후 고정 봉투가 직렬화 기능을 다시 부르지 않고도 정체성을 싣도록 부팅 시 한 번만 만든다. */
export const VERSION_IDENTITY_JSON =
  `"serverVersion":${JSON.stringify(SERVER_VERSION)},"upgradeCommands":${JSON.stringify(UPGRADE_COMMANDS)}`;
