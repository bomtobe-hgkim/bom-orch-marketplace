/**
 * `orch_stats` 와 `orch_reset` 핸들러. WS7 은 읽기와 파괴를 서로 다른 도구로
 * 나눈다. 공유 배선은 `./context.mjs` 에서 받고 `../tools.mjs` 를 다시 수입하지
 * 않는다 — 그래야 도구 목록이 핸들러를 부르는 방향 하나만 남는다.
 */
import { join } from 'node:path';

import { confidenceOfReset, confidenceOfStats } from '../confidence.mjs';
import { MAX_CONTENT_CHARS, failure, success } from '../envelope.mjs';
import { AXES, OBSERVATION_THRESHOLD, armAllowed, observationsOf } from '../learn/bandit.mjs';
import { readRunsUnlocked } from '../learn/journal.mjs';
import { generationOf, readGenerationsUnlocked, withLearningLock } from '../learn/learning.mjs';
import {
  GENERATIONS_SNAPSHOT_FILE,
  PRIOR,
  SNAPSHOT_FILE,
  cellKeyOf,
  readPosteriorsUnlocked,
  resetPosteriors,
} from '../learn/posteriors.mjs';
import { REASON, normalizeLegacyReasonCode } from '../reason-codes.mjs';
import { renderNotice } from '../reason-text.mjs';
import { resolveStateRoot } from '../state-root.mjs';
import { stateSchemaNotice, stateSchemaReason } from '../state-schema.mjs';
import { clipPlain } from '../util/strings.mjs';
import {
  MAX_INSPECTED_ARTIFACT_REFS,
  inspectJournalArtifacts,
  toEngineDeps,
} from './context.mjs';

/** 축별로 전체 화면에도 남겨야 하는 운영적 제약. */
export const AXIS_NOTES = Object.freeze({
  mix: renderNotice('stats_axis_single_only'),
  placement: renderNotice('stats_placement_shared_cell'),
  tier: renderNotice('stats_tier_arms_identical'),
});

function splitCellKey(cellKey) {
  const at = cellKey.indexOf('::');
  if (at === -1) return { taskClass: null, axis: null };
  return { taskClass: cellKey.slice(0, at), axis: cellKey.slice(at + 2) };
}

/** 알려진 팔의 posterior mean 이 가장 큰 팔. 동률은 축의 기본 팔이 이긴다. */
function favoredArmOf(spec, arms) {
  if (spec === null) return null;
  const ordered = [spec.default, ...spec.arms.filter((arm) => arm !== spec.default)];
  let favored = ordered[0];
  let favoredMean = -1;
  for (const arm of ordered) {
    const posterior = arms?.[arm];
    const alpha = Number.isFinite(posterior?.alpha) && posterior.alpha > 0 ? posterior.alpha : PRIOR.alpha;
    const beta = Number.isFinite(posterior?.beta) && posterior.beta > 0 ? posterior.beta : PRIOR.beta;
    const mean = alpha / (alpha + beta);
    if (mean > favoredMean) {
      favored = arm;
      favoredMean = mean;
    }
  }
  return favored;
}

/** 현재 세대에 아직 반영된 가장 최근 실행을 셀별로 인덱싱한다. */
function lastAppliedByCell(runs, generations, generationsKnown) {
  const found = new Map();
  if (!Array.isArray(runs) || generationsKnown !== true) return found;
  for (const run of [...runs].reverse()) {
    if (typeof run?.runId !== 'string' || typeof run.taskClass !== 'string') continue;
    if (run.appliedGrade !== 'success' && run.appliedGrade !== 'failure') continue;
    if (!Array.isArray(run.appliedAxes)) continue;
    for (const axis of run.appliedAxes) {
      if (typeof axis !== 'string') continue;
      const cellKey = cellKeyOf(run.taskClass, axis);
      if (found.has(cellKey)) continue;
      const recorded = Number.isInteger(run.appliedGenerations?.[axis]) ? run.appliedGenerations[axis] : 0;
      if (generationOf(generations, cellKey) === recorded) found.set(cellKey, run.runId);
    }
  }
  return found;
}

function fullCellView(cellKey, arms, lastApplied) {
  const { taskClass, axis } = splitCellKey(cellKey);
  const spec = axis !== null && Object.hasOwn(AXES, axis) ? AXES[axis] : null;
  const observations = spec === null ? null : observationsOf(arms, spec.arms);
  const candidates = spec === null ? [] : spec.arms.filter((arm) => armAllowed(axis, arm, false));
  const withSingle = spec === null ? [] : spec.arms.filter((arm) => armAllowed(axis, arm, true));
  const optInArms = spec === null ? [] : spec.arms.filter((arm) => !armAllowed(axis, arm, false));
  const enough = observations !== null && observations >= OBSERVATION_THRESHOLD;
  const view = {
    cellKey,
    taskClass,
    axis,
    favoredArm: favoredArmOf(spec, arms),
    observations,
    untilActive: observations === null ? null : Math.max(0, OBSERVATION_THRESHOLD - observations),
    lastApplied: lastApplied.get(cellKey) ?? null,
    arms,
    banditActiveByDefault: enough && candidates.length >= 2,
    banditActiveIfAllowSingle: enough && withSingle.length >= 2,
  };
  if (spec === null) view.unknownAxis = true;
  if (optInArms.length > 0) view.optInArms = optInArms;
  if (axis !== null && Object.hasOwn(AXIS_NOTES, axis)) view.note = AXIS_NOTES[axis];
  return view;
}

/** summary 의 넷 집계 외에 셀 식별자만 남긴다. */
const summaryCellView = (cell) => ({
  cellKey: cell.cellKey,
  taskClass: cell.taskClass,
  axis: cell.axis,
  favoredArm: cell.favoredArm,
  observations: cell.observations,
  untilActive: cell.untilActive,
  lastApplied: cell.lastApplied,
});

const recentView = (run, generations, generationsKnown = true) => {
  const appliedAxes = Array.isArray(run.appliedAxes) ? run.appliedAxes : null;
  const appliedCurrent = run.appliedGrade === null || run.appliedGrade === undefined
    ? null
    : !generationsKnown
      ? null
      : appliedAxes !== null && typeof run.taskClass === 'string'
        ? appliedAxes.every((axis) => {
            const recorded = Number.isInteger(run.appliedGenerations?.[axis]) ? run.appliedGenerations[axis] : 0;
            return generationOf(generations, cellKeyOf(run.taskClass, axis)) === recorded;
          })
        : null;
  const text = (value) => (typeof value === 'string' ? value : null);
  return {
    runId: run.runId,
    at: Number.isFinite(run.at) ? run.at : null,
    taskClass: typeof run.taskClass === 'string' ? run.taskClass : null,
    stopReason: run.outcome?.stopReason ?? null,
    grade: run.outcome?.grade ?? null,
    appliedGrade: run.appliedGrade ?? null,
    appliedCurrent,
    appliedAxes,
    artifacts: null,
    terminal: {
      status: text(run.status),
      stopReason: text(run.stopReason),
      reasonCode: text(run.reasonCode) === null ? null : normalizeLegacyReasonCode(run.reasonCode) ?? run.reasonCode,
      startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
      finishedAt: Number.isFinite(run.finishedAt) ? run.finishedAt : null,
      project: text(run.project),
      taskPreview: text(run.taskPreview),
      resumedFrom: text(run.resumedFrom),
    },
    gradeable: typeof run.taskClass === 'string',
  };
};

const statsRung = (omitted) => omitted.cells
  ? 'fewer_cells'
  : omitted.arms === false
    ? 'no_arms'
    : omitted.recent
      ? 'fewer_recent'
      : omitted.cellKeys
        ? 'fewer_cell_keys'
        : 'full';

function renderStats(view) {
  const allCells = view.cells;
  const allRecent = view.recent;
  let keepRecent = allRecent === null ? 0 : allRecent.length;
  let keepCells = allCells.length;
  let withArms = view.view === 'full';

  for (let step = 0; step < 128; step += 1) {
    const omittedCounts = {};
    if (allRecent !== null && keepRecent < allRecent.length) {
      omittedCounts.recent = { asked: allRecent.length, kept: keepRecent };
    }
    if (view.view === 'full' && !withArms) omittedCounts.arms = false;
    if (keepCells < allCells.length) omittedCounts.cells = { asked: allCells.length, kept: keepCells };
    const reduced = statsRung(omittedCounts);
    const body = {
      view: view.view,
      threshold: view.threshold,
      posteriors: view.posteriors,
      journal: view.journal,
      cells: allCells.slice(0, keepCells).map((cell) => {
        if (view.view === 'summary') return summaryCellView(cell);
        return withArms ? cell : { ...cell, arms: null };
      }),
    };
    if (allRecent !== null) {
      body.recent = allRecent.slice(0, keepRecent);
      body.recentFiltered = false;
    }
    if (reduced !== 'full') Object.assign(body, { reduced, omittedCounts });
    const text = JSON.stringify(body);
    if (text.length <= MAX_CONTENT_CHARS) return { text, reduced, omittedCounts };
    if (keepRecent > 0) {
      keepRecent = Math.floor(keepRecent / 2);
      continue;
    }
    if (view.view === 'full' && withArms) {
      withArms = false;
      continue;
    }
    if (keepCells > 0) {
      keepCells = Math.floor(keepCells / 2);
      continue;
    }
    return { text, reduced, omittedCounts };
  }
  const floor = {
    view: view.view,
    threshold: view.threshold,
    posteriors: view.posteriors,
    journal: view.journal,
    cells: [],
    reduced: 'floor',
    omittedCounts: {},
  };
  return { text: JSON.stringify(floor), reduced: floor.reduced, omittedCounts: floor.omittedCounts };
}

/** `orch_reset` 본문은 예전 stats 본문의 `reset` 객체 자체다. */
function renderReset(reset) {
  const all = reset.cellKeys;
  let kept = all === null ? 0 : all.length;
  for (let step = 0; step < 128; step += 1) {
    const body = { ...reset, cellKeys: all === null ? null : all.slice(0, kept) };
    const omittedCounts = all !== null && kept < all.length ? { cellKeys: { asked: all.length, kept } } : {};
    const reduced = statsRung(omittedCounts);
    if (reduced !== 'full') Object.assign(body, { reduced, omittedCounts });
    const text = JSON.stringify(body);
    if (text.length <= MAX_CONTENT_CHARS || kept === 0) return { text, reduced, omittedCounts };
    kept = Math.floor(kept / 2);
  }
  const floor = { ...reset, cellKeys: [], reduced: 'floor', omittedCounts: {} };
  return { text: JSON.stringify(floor), reduced: floor.reduced, omittedCounts: floor.omittedCounts };
}

const RESET_KEY_CHARS = 100;
const RESET_REASON_CHARS = 120;
const RESET_NOTE_CHARS = 240;
const RESET_NOTES_KEPT = 5;

export function foldResetNotes(notes) {
  const kept = (Array.isArray(notes) ? notes : [])
    .filter((note) => typeof note === 'string' && note !== '')
    .map((note) => clipPlain(note, RESET_NOTE_CHARS));
  if (kept.length === 0) return undefined;
  if (kept.length <= RESET_NOTES_KEPT) return kept.join(' / ');
  const dropped = kept.length - RESET_NOTES_KEPT;
  return `${kept.slice(0, RESET_NOTES_KEPT).join(' / ')} ${renderNotice('stats_rows_folded', { dropped })}`;
}

function reductionNotice(reduced) {
  const parts = [];
  if (reduced.recent) parts.push(renderNotice('stats_recent_reduced', reduced.recent));
  if (reduced.arms === false) parts.push(renderNotice('stats_arm_posteriors_dropped'));
  if (reduced.cells) parts.push(renderNotice('stats_cells_reduced', reduced.cells));
  if (reduced.cellKeys) parts.push(renderNotice('stats_cleared_cells_reduced', reduced.cellKeys));
  return parts.length > 0
    ? renderNotice('stats_content_limit_reductions', { limit: MAX_CONTENT_CHARS, detail: parts.join(' / ') })
    : null;
}

const blockedByStateSchema = (stateSchema) => {
  const reason = stateSchemaReason(stateSchema);
  return reason === null ? null : failure({ status: 'blocked', ...reason });
};

const snapshotFor = (stateRoot) => {
  const path = join(stateRoot, SNAPSHOT_FILE);
  const generationPath = join(stateRoot, GENERATIONS_SNAPSHOT_FILE);
  return {
    path,
    generationPath,
    restore: renderNotice('learning_reset_snapshot', {
      path,
      generationPath,
      generationsFile: GENERATIONS_SNAPSHOT_FILE,
      posteriorsFile: SNAPSHOT_FILE,
    }),
  };
};

async function resetStats(stateRoot, taskClass, operationOptions) {
  if (taskClass === undefined) {
    const cleared = await resetPosteriors(stateRoot, operationOptions);
    if (!cleared.ok) {
      const schemaBlocked = blockedByStateSchema(cleared.stateSchema);
      if (schemaBlocked !== null) return schemaBlocked;
      return failure({
        status: 'failed',
        reasonCode: REASON.learning_posteriors_reset_failed,
        params: { detail: cleared.error },
      });
    }
    const snapshotWritten = cleared.cleared > 0 || cleared.discarded === true;
    const snapshot = snapshotWritten ? snapshotFor(stateRoot) : null;
    return success({
      content: JSON.stringify({
        taskClass: null,
        asked: null,
        cleared: cleared.cleared,
        failed: 0,
        cellKeys: null,
        posteriors: cleared.discarded ? 'unreadable' : 'ok',
        snapshot,
      }),
      confidence: confidenceOfReset({
        counted: true,
        readable: !cleared.discarded,
        cleared: cleared.cleared,
        snapshotWritten,
      }),
      notice: foldResetNotes([snapshot?.restore, cleared.notice]),
    });
  }

  const one = await resetPosteriors(stateRoot, { taskClass, ...(operationOptions ?? {}) });
  if (!one.ok) {
    const schemaBlocked = blockedByStateSchema(one.stateSchema);
    if (schemaBlocked !== null) return schemaBlocked;
  }
  if (!one.ok && !Number.isInteger(one.asked)) {
    return failure({
      status: 'failed',
      reasonCode: REASON.learning_scope_read_failed,
      params: { taskClass, detail: one.error },
    });
  }
  const asked = Number.isInteger(one.asked) ? one.asked : 0;
  const cleared = one.ok ? one.cleared : 0;
  const failed = one.ok ? 0 : asked;
  const selectedKeys = Array.isArray(one.cellKeys) ? one.cellKeys : [];
  const removed = one.ok ? selectedKeys : [];
  const perCell = one.ok
    ? [one.notice]
    : selectedKeys.map((cellKey) => renderNotice('stats_cell_clear_failed', {
        cell: clipPlain(cellKey, RESET_KEY_CHARS),
        reason: clipPlain(one.error, RESET_REASON_CHARS),
      }));
  const snapshot = cleared > 0 ? snapshotFor(stateRoot) : null;
  const rendered = renderReset({
    taskClass,
    asked,
    cleared,
    failed,
    cellKeys: removed,
    posteriors: 'ok',
    snapshot,
  });
  const notes = [];
  const shrank = reductionNotice(rendered.omittedCounts);
  if (shrank !== null) notes.push(shrank);
  return success({
    content: rendered.text,
    confidence: confidenceOfReset({ counted: failed === 0, readable: true, cleared, snapshotWritten: cleared > 0 }),
    notice: foldResetNotes([...notes, snapshot?.restore, ...perCell]),
  });
}

/**
 * 일반 인자 검증은 누락과 false 를 다른 문장으로 낸다. 초기화는 두 경우 모두
 * 하나의 회복 절차를 실어야 하므로 도구 검증 앞에서 공통 봉투를 만든다.
 */
export function resetConfirmationFailure(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, 'confirm');
  if (descriptor?.value === true) return null;
  return failure({
    status: 'invalid',
    reasonCode: REASON.config_argument_not_in_enum,
    params: {
      name: 'confirm',
      value: descriptor === undefined ? 'missing' : 'false',
      allowed: 'confirm:true to erase learning',
    },
  });
}

export async function runOrchReset(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();
  return resetStats(stateRoot, value.task_class, wired.learningOperationOptions);
}

export async function runOrchStats(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot = typeof wired.stateRoot === 'string' && wired.stateRoot !== '' ? wired.stateRoot : resolveStateRoot();
  const notices = [];

  // lastApplied 는 runs 목록을 요청하지 않아도 저널을 읽어야 알 수 있다.
  // readRunsUnlocked 는 어차피 전체 파일을 파싱하므로 여기서 전체 최신 행을 받아
  // 셀 인덱스와 사용자가 요청한 작은 recent 창을 같은 스냅샷에서 만든다.
  const snapshot = await withLearningLock(stateRoot, async () => ({
    posteriors: await readPosteriorsUnlocked(stateRoot),
    generations: await readGenerationsUnlocked(stateRoot),
    runs: await readRunsUnlocked(stateRoot, { limit: Number.MAX_SAFE_INTEGER }),
  }));
  const posteriors = snapshot.ok ? snapshot.value.posteriors : snapshot;
  const generationState = snapshot.ok ? snapshot.value.generations : snapshot;
  const runs = snapshot.ok ? snapshot.value.runs : snapshot;
  const posteriorSchemaNotice = stateSchemaNotice(posteriors.stateSchema);
  if (posteriorSchemaNotice !== null) {
    notices.push(posteriorSchemaNotice);
  } else if (!posteriors.ok) {
    notices.push(renderNotice('learning_posteriors_unreadable', { reason: posteriors.error }));
  }
  if (!generationState.ok && posteriorSchemaNotice === null) {
    notices.push(renderNotice('learning_generations_unreadable', { reason: generationState.error }));
  }
  if (!runs.ok && posteriorSchemaNotice === null) {
    notices.push(renderNotice('run_journal_unreadable', { reason: runs.error ?? snapshot.error }));
  }

  const allRuns = runs.ok ? runs.runs : [];
  const lastApplied = lastAppliedByCell(
    allRuns,
    generationState.ok ? generationState.generations : { global: 0, cells: {} },
    generationState.ok,
  );
  const cells = posteriors.ok
    ? Object.entries(posteriors.cells)
        .map(([cellKey, arms]) => fullCellView(cellKey, arms, lastApplied))
        .filter((cell) => value.task_class === undefined || cell.taskClass === value.task_class)
    : [];

  let recent = null;
  if (value.runs > 0) {
    const ordered = allRuns.slice(-value.runs).reverse();
    recent = ordered.map((run) => recentView(
      run,
      generationState.ok ? generationState.generations : { global: 0, cells: {} },
      generationState.ok,
    ));
    let budget = MAX_INSPECTED_ARTIFACT_REFS;
    let uninspectedRuns = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      const refs = ordered[index].artifactRefs;
      if (!Array.isArray(refs)) continue;
      if (refs.length > budget) {
        uninspectedRuns += 1;
        continue;
      }
      budget -= refs.length;
      const inspected = await inspectJournalArtifacts(stateRoot, refs, wired.artifactInspectionDeps);
      recent[index].artifacts = inspected.artifacts;
      if (inspected.failed) uninspectedRuns += 1;
    }
    if (uninspectedRuns > 0) {
      notices.push(renderNotice('artifact_inspection_incomplete', {
        count: uninspectedRuns,
        limit: MAX_INSPECTED_ARTIFACT_REFS,
      }));
    }
  }

  const rendered = renderStats({
    view: value.view,
    threshold: OBSERVATION_THRESHOLD,
    posteriors: posteriors.ok ? 'ok' : 'unreadable',
    journal: runs.ok ? 'ok' : 'unreadable',
    cells,
    recent,
  });
  const shrank = reductionNotice(rendered.omittedCounts);
  if (shrank !== null) notices.push(shrank);
  return success({
    content: rendered.text,
    confidence: confidenceOfStats({
      readable: posteriors.ok && posteriors.stateSchema === undefined && runs.ok && generationState.ok,
    }),
    notice: notices.length > 0 ? notices.join(' ') : undefined,
  });
}
