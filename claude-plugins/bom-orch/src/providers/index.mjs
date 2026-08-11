import { assertProviderShape } from './contract.mjs';
import { claudeProvider } from './claude.mjs';
import { codexProvider } from './codex.mjs';

// 등록 시점에 형태를 검증한다 — 잘못된 모듈은 첫 호출이 아니라 로드에서 죽어야 한다.
const REGISTRY = new Map([claudeProvider, codexProvider].map((p) => [assertProviderShape(p).id, p]));

/** 도구 스키마의 enum 이 여기서 만들어진다. */
export const PROVIDER_IDS = Object.freeze([...REGISTRY.keys()]);

export function listProviders() {
  return [...REGISTRY.values()];
}

/**
 * 모르는 id 는 undefined. throw 하지 않는다 — 호출부가 잘못된 id 를 넘겨도 서버가
 * 죽으면 안 되고 정상 오류 봉투로 강등돼야 한다.
 *
 * Map 을 쓰는 이유: 평범한 객체면 '__proto__'·'constructor' 같은 키에 상속된 값이
 * 나온다. 그걸 프로바이더로 착각하면 첫 호출에서 터진다.
 */
export function getProvider(id) {
  return typeof id === 'string' ? REGISTRY.get(id) : undefined;
}
