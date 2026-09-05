// src/tools/prove.mjs
/**
 * `orch_prove` — 끝난 실행의 **선택된 후보 하나**에 대해 회귀 증명을 돌리고 그 결과를 봉투로
 * 옮기는 관문(설계 2026-08-28 §1.1·§1.3). 새 핸들러는 `src/tools/<name>.mjs` 로 간다
 * (WS0 §8: `src/tools.mjs` 증가는 스펙 행과 배선뿐) — 공유 배선은 `src/tools/context.mjs` 에서
 * 오고 `tools.mjs` 를 되부르면 순환이다.
 *
 * ★★ **이 파일은 관문이고 배선이지, 증명기가 아니다.** 재현(워크트리·플랜·후보·델타)과 여섯
 *   칸의 실행은 `src/proof-stage.mjs` 가 하고, 증명 규칙 자체는 `completeRegressionProof` 가
 *   한다. 이 파일이 아는 것은 셋이다: 인자, 어느 사건이 어느 봉투인가, 그리고 원문·패치
 *   바이트를 **안 싣는다**는 것. `src/tools/apply.mjs` 와 같은 자세다.
 *
 * ★ **이 호출은 아무것도 적용하지 않는다.** 패치는 실행이 둔 자리에 그대로 있고, 이 호출이
 *   쓰는 곳은 `<stateRoot>/proofs/<runId>/` 하나다 — 끝난 실행의 `runs/<runId>/` 에는 한
 *   바이트도 쓰지 않는다. 적용은 여전히 `orch_apply` 라는 명시적 한 걸음이다.
 *
 * ★ 2026-08-28 실측이 이 도구의 이유다: 실행 9 는 첫 수용 후보를 냈는데도 봉투가
 *   `unverified` 였다 — 스위트 한 번이 ~7분이라 여섯 번은 42분인데 55분 상한이 다섯 번째
 *   실행 뒤에 잘랐다. 증명을 실행 밖으로 떼서 **적용할 후보 하나**에만 들이는 것이 그 산수의
 *   유일한 해다.
 *
 * ★ 실측 폐포: **66개 모듈 / 26,658줄**(자기 자신 143 포함).
 */
import { confidenceOfProve } from '../confidence.mjs';
import { failure, success } from '../envelope.mjs';
import { proofRecordPath } from '../proof-record.mjs';
import { runProofStage as defaultRunProofStage } from '../proof-stage.mjs';
import { REASON } from '../reason-codes.mjs';
import { statusOfReasonCode } from '../run-faults.mjs';
import { resolveStateRoot } from '../state-root.mjs';
import { usableRunId } from '../run-read.mjs';
import { toProveOptions } from './context.mjs';

/** 봉투에 실리는 경로 하나의 상한. `src/tools/apply.mjs`·`src/tools/status.mjs` 와 같은 값이다. */
const PATH_CHARS = 1_024;

const clipPath = (value, limit) =>
  (typeof value === 'string' && value.length > limit ? `${value.slice(0, limit - 1)}…` : value ?? null);

/**
 * 증거 행 하나. 러너가 낸 기록에서 **결정에 쓰이는 넷**만 뽑는다 — 원문도 실패 지문도 싣지
 * 않는다(불변식: 증명 봉투에 테스트 출력은 없다).
 */
const evidenceRow = (entry) => ({
  evidenceId: entry.evidenceId,
  kind: entry.kind,
  repetition: entry.repetition,
  outcome: entry.outcome,
  witnessCount: entry.witnessCount,
});

/**
 * `orch_prove` 핸들러.
 *
 * ★ 거부의 `status` 는 **코드가 정한다**(`statusOfReasonCode`) — 예외를 두지 않는다.
 *   `src/tools/apply.mjs` 는 `apply_run_not_found` 하나를 `invalid` 로 강등하는데, 그것은 그
 *   도구가 사용자 저장소를 건드리기 **전에** 호출자의 값을 되묻는 자리이기 때문이다.
 *   증명 게이트의 거부는 코드가 정한다 — 부재 여섯은 `blocked`, 재현 불일치 셋은
 *   `policy_failure`(봉투 status `failed`), 판독 실패 둘은 `infrastructure_failed` 다
 *   (설계 §1.7 정정; 등록표는 `src/reason-codes.mjs` 다). 조악값과 봉투가 갈리는 것이
 *   `stopReasonOf()` 가 없애려는 결함 그 자체이므로 여기서 status 를 손으로 고르지 않는다.
 * ★ 거부 봉투의 `stopReason` 도 손으로 안 고른다: `failure()` 는 `reasonCode` 가 있으면
 *   레지스트리가 렌더한 `stopReason` 을 쓰고 호출부가 준 값을 **무시한다**
 *   (`src/envelope.mjs`: `const finalStopReason = rendered === null ? stopReason : rendered.stopReason;`).
 *   그래서 여기서 `stopReason` 을 넘기는 것은 없는 일이고, 넘기면 읽는 사람만 속는다.
 * ★ 신뢰도는 **재현 불일치에만** 싣는다. 「그런 실행이 없다」는 반박이 아니라 부재이고,
 *   `disputed` 를 실으면 `success()` 의 규칙에 따라 봉투가 실패로 강등되면서 아무것도 재 본
 *   적 없는 호출이 "기계 증거가 성공을 반박한다" 고 말한다.
 */
export async function runOrchProve(value, context) {
  const options = toProveOptions(value, context);
  const wired = options.deps;
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== ''
    ? wired.stateRoot
    : resolveStateRoot();
  const stage = typeof wired.runProofStage === 'function' ? wired.runProofStage : defaultRunProofStage;

  const outcome = await stage({
    stateRoot,
    runId: options.runId,
    waitMs: options.waitMs,
    onProgress: options.onProgress,
    hostSignal: options.hostSignal,
  }, wired);

  if (outcome.ok !== true) {
    const disputed = outcome.disputed === true;
    return failure({
      status: statusOfReasonCode(outcome.reasonCode),
      reasonCode: outcome.reasonCode,
      params: outcome.params,
      ...(disputed ? { confidence: confidenceOfProve({ refused: true }) } : {}),
      // 쓸 수 있는 이름일 때만 최상위에 싣는다 — 모양이 아닌 이름은 문장 안에서만 보이고
      // 거기서는 `MAX_PARAM_CHARS` 가 자른다(`src/tools/apply.mjs` 의 같은 판단).
      ...(usableRunId(options.runId) ? { runId: options.runId } : {}),
      // ★ 프로비저너(`src/deps-provision.mjs`)는 앵커·셀 실패에서 이미 렌더된 `error`/`recovery`
      //   를 들고 온다(`src/proof-stage.mjs` ~:338-345) — `{file}`/`{detail}` 을 그 문장에 채운
      //   것은 프로비저너이지 이 관문이 아니고, 여기서 다시 `params` 없이 레지스트리에 넘기면
      //   `safeRender` 가 그 자리표시자를 못 채워 던지고 일반 문구로 강등된다(`carryFailure`,
      //   `src/tools/apply.mjs`:309 와 같은 자세). 문자열일 때만 나른다 — 거부(`refuse()`)는
      //   이 둘을 안 주므로 영향이 없다.
      ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
      ...(typeof outcome.recovery === 'string' ? { recovery: outcome.recovery } : {}),
    });
  }

  const record = outcome.record;
  const testRuns = record.cost.testRuns;
  // ★ 리터럴을 `reasonCode:` 자리 밖에서 비교한다 — `test/guards/reason-code-literals.test.mjs`
  //   는 그 자리의 값 트리 **안**에서 snake_case 문자열이면 사유 코드 흉내로 본다(`not_applicable`
  //   에는 밑줄이 있다). 판정을 여기로 빼면 그 자리에는 식별자와 `REASON.x` 만 남는다.
  const notApplicable = record.status === 'not_applicable';
  const body = {
    runId: record.runId,
    candidateId: record.candidateId,
    attemptId: record.attemptId,
    status: record.status,
    repairable: record.repairable,
    reasonCodes: [...record.reasonCodes],
    evidence: (outcome.evidence ?? []).map(evidenceRow),
    // 벽시계는 기록의 두 시각에서 뺀다 — 두 번째 시계를 만들면 봉투와 기록이 갈린다.
    cost: { elapsedMs: Math.max(record.finishedAt - record.startedAt, 0), testRuns },
    path: clipPath(proofRecordPath(stateRoot, record.runId), PATH_CHARS),
  };
  return success({
    content: JSON.stringify(body),
    // 바닥 한 장 — 증거 목록이 상한을 넘겨도 **무엇을 증명했는가**는 남는다. 이것이 없으면
    // `success()` 가 본문을 `{"truncatedReport":true}` 로 조용히 갈아치운다.
    contentFallback: JSON.stringify({
      runId: record.runId,
      status: record.status,
      attemptId: record.attemptId,
      repairable: record.repairable,
      cost: { elapsedMs: Math.max(record.finishedAt - record.startedAt, 0), testRuns },
      reduced: 'floor',
    }),
    confidence: confidenceOfProve({ status: record.status }),
    // 유예된 증명이 실행에서 그랬듯, 「증명했다」와 「못 했다」는 조악값으로도 갈린다.
    stopReason: record.status === 'proved' ? 'verified' : 'unverified',
    reasonCode: notApplicable ? REASON.proof_not_required : undefined,
    runId: record.runId,
  });
}
