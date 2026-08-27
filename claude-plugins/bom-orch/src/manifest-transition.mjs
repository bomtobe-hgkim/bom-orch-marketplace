/**
 * 매니페스트 v1 의 **합법 전이** — 문서 둘 사이의 한 걸음이 적법한가만 재는 검증기.
 *
 * ★ 방향은 이쪽이 위다: 이 파일이 `src/run-manifest.mjs` 를 수입하고, 저쪽은 이 파일을 수입하지 않는다.
 *   `validateRunManifestTransitionV1` 은 두 값을 각각 `normalizeRunManifestV1` 로 통과시킨 **뒤에야** 비교를 시작하므로
 *   반대 방향은 순환이다 — 그래서 이 이름을 쓰는 셋(`src/run-artifacts.mjs`·`src/reaper.mjs`·`test/run-manifest.test.mjs`)이
 *   문서를 거치지 않고 여기서 직접 가져간다. 저장소가 그 이름을 계속 재수출하는 것은 별개다(테스트가 저장소 표면에서 잰다).
 *
 * ★ 「한 걸음」의 정의는 셋이 전부다: `revision` 이 정확히 +1, `MANIFEST_KEYS` 에서 `revision` 앞에 오는 불변 키 열둘이
 *   한 글자도 안 바뀔 것, `appliedEvents` 가 정확히 하나 늘고 옛 항목이 그대로일 것. 그 새 이벤트 하나가 어느 행을
 *   건드려도 되는지는 `validManifestStateTransition` 의 **닫힌 목록**이 정한다 — 목록에 없는 조합은 거부다.
 *
 * ★ 저장소 모듈(`run-artifacts`·`run-store-fs`·`run-records`·`run-inspect`)은 하나도 수입하지 않는다.
 * ★ 실측 폐포: **13개 모듈 / 4,150줄**(자기 자신 125 포함) — `run-manifest` 과 그것이 끄는 `manifest-vocabulary`·`manifest-selection`·`candidate-selection`·`verdict`·`reason-codes`·`preflight`(WS4b)·`util/{freeze,hash,objects,paths,strings}`.
 */

import { sameJson } from './manifest-vocabulary.mjs';
import { identityFromInventory, identityKey, MANIFEST_KEYS, normalizeRunManifestV1, ordinal } from './run-manifest.mjs';

const TRANSITION_STATE_KEYS = Object.freeze([
  'pendingArtifacts', 'committedArtifacts', 'attempts', 'evidenceRefs', 'candidateRefs', 'verdictRefs',
  'usage', 'issueSummary', 'selection', 'winnerAlias', 'cleanup',
]);

function arrayDelta(before, after) {
  const remaining = [...after];
  for (const entry of before) {
    const index = remaining.findIndex((candidate) => sameJson(candidate, entry));
    if (index < 0) return null;
    remaining.splice(index, 1);
  }
  return remaining;
}

function oneArrayAddition(before, after) {
  if (after.length !== before.length + 1) return null;
  const added = arrayDelta(before, after);
  return added?.length === 1 ? added[0] : null;
}

function oneArrayRemoval(before, after) {
  if (before.length !== after.length + 1) return null;
  const removed = arrayDelta(after, before);
  return removed?.length === 1 ? removed[0] : null;
}

function exactChanges(current, next, expected) {
  const changed = TRANSITION_STATE_KEYS.filter((key) => !sameJson(current[key], next[key]));
  return sameJson([...changed].sort(), [...expected].sort());
}

function validAllocationTransition(current, next) {
  if (!exactChanges(current, next, ['attempts'])) return false;
  const added = oneArrayAddition(current.attempts, next.attempts);
  return added !== null && added.status === 'allocated';
}

function validReservationTransition(current, next, applied) {
  if (!exactChanges(current, next, ['pendingArtifacts'])) return false;
  const added = oneArrayAddition(current.pendingArtifacts, next.pendingArtifacts);
  return added !== null && added.reservedEventId === applied.eventId;
}

function validCommitTransition(current, next, applied) {
  const added = oneArrayAddition(current.committedArtifacts, next.committedArtifacts);
  const removed = oneArrayRemoval(current.pendingArtifacts, next.pendingArtifacts);
  if (added === null || removed === null || added.committedEventId !== applied.eventId ||
      identityKey(identityFromInventory(added)) !== identityKey(identityFromInventory(removed)) ||
      added.relativePath !== removed.relativePath || added.ref.sha256 !== removed.expectedSha256 ||
      added.ref.bytes !== removed.expectedBytes) return false;
  if (added.artifactKind === 'evidence') {
    if (!exactChanges(current, next, ['pendingArtifacts', 'committedArtifacts', 'evidenceRefs'])) return false;
    const evidence = oneArrayAddition(current.evidenceRefs, next.evidenceRefs);
    return evidence !== null && sameJson(evidence.ref, added.ref);
  }
  return exactChanges(current, next, ['pendingArtifacts', 'committedArtifacts']);
}

function validTerminalTransition(current, next, applied) {
  if (!exactChanges(current, next, ['attempts']) &&
      !exactChanges(current, next, ['attempts', 'verdictRefs'])) return false;
  if (current.attempts.length !== next.attempts.length) return false;
  const before = current.attempts.filter((entry, index) => !sameJson(entry, next.attempts[index]));
  const after = next.attempts.filter((entry, index) => !sameJson(entry, current.attempts[index]));
  if (before.length !== 1 || after.length !== 1 || before[0].status !== 'allocated' || after[0].status !== 'terminal' ||
      before[0].laneId !== after[0].laneId || before[0].ordinal !== after[0].ordinal ||
      before[0].attemptId !== after[0].attemptId || before[0].retryOf !== after[0].retryOf ||
      applied.eventId !== `attempt:${after[0].laneId}:${ordinal(after[0].ordinal)}:terminal`) return false;
  if (sameJson(current.verdictRefs, next.verdictRefs)) return true;
  const verdict = oneArrayAddition(current.verdictRefs, next.verdictRefs);
  return verdict !== null && verdict.laneId === after[0].laneId && verdict.attemptId === after[0].attemptId;
}

function validSingleRowTransition(current, next, key) {
  return exactChanges(current, next, [key]) && oneArrayAddition(current[key], next[key]) !== null;
}

function validManifestStateTransition(current, next, applied) {
  if (validAllocationTransition(current, next) || validReservationTransition(current, next, applied) ||
      validCommitTransition(current, next, applied) || validTerminalTransition(current, next, applied)) return true;
  if (validSingleRowTransition(current, next, 'candidateRefs') ||
      validSingleRowTransition(current, next, 'issueSummary') ||
      validSingleRowTransition(current, next, 'cleanup')) return true;
  if (exactChanges(current, next, ['usage'])) return current.usage === null && next.usage !== null;
  if (exactChanges(current, next, ['selection'])) return current.selection === null && next.selection !== null;
  if (exactChanges(current, next, ['winnerAlias'])) {
    return current.winnerAlias === null && next.winnerAlias !== null &&
      applied.eventId === `winner:${next.winnerAlias.candidateId}:recorded`;
  }
  return false;
}

export function validateRunManifestTransitionV1(currentValue, nextValue) {
  const current = normalizeRunManifestV1(currentValue);
  const next = normalizeRunManifestV1(nextValue);
  if (current === null || next === null || next.revision !== current.revision + 1) return null;
  const immutableKeys = MANIFEST_KEYS.slice(0, MANIFEST_KEYS.indexOf('revision'));
  if (immutableKeys.some((key) => !sameJson(current[key], next[key]))) return null;
  const currentEvents = new Map(current.appliedEvents.map((entry) => [entry.eventId, entry]));
  if (next.appliedEvents.length !== current.appliedEvents.length + 1 ||
      current.appliedEvents.some((entry) => !sameJson(entry, next.appliedEvents.find((item) => item.eventId === entry.eventId)))) return null;
  const addedEvents = next.appliedEvents.filter((entry) => !currentEvents.has(entry.eventId));
  if (addedEvents.length !== 1 || !validManifestStateTransition(current, next, addedEvents[0])) return null;
  return next;
}
