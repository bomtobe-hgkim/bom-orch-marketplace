---
name: orch-learn
description: See the learning statistics this orchestration keeps, correct by hand the grade an earlier run was given, or erase what it learned — that last one is destructive.
---

# Learning statistics and corrections

`orch_stats` reads learning without changing it. Its default summary reports the favored arm,
observation count, distance to activation, and last applied run for each cell; `view:full` adds raw
alpha/beta values and diagnostics. `orch_reward` corrects an earlier run's grade idempotently.
`orch_reset` is the separate destructive clear. Failure codes and recoveries are in
`REASON_CODES.md` at the plugin root.

## Arguments

| Tool | Argument | Required | Default | Allowed |
| --- | --- | --- | --- | --- |
| `orch_stats` | `task_class` | optional | — | `code:test-bearing`, `code:no-tests`, `prose`, `analysis` |
| `orch_stats` | `runs` | optional | `0` | integer 0-50 |
| `orch_stats` | `view` | optional | `summary` | `summary`, `full` |
| `orch_reward` | `run_id` | required | — | — |
| `orch_reward` | `good` | required | — | — |
| `orch_reward` | `note` | optional | — | — |
| `orch_reset` | `confirm` | required | — | `true` |
| `orch_reset` | `task_class` | optional | — | `code:test-bearing`, `code:no-tests`, `prose`, `analysis` |

`orch_stats.task_class` filters cells, but not the recent-run list. `orch_reset.task_class` narrows
the destructive clear to that class. A reset without `confirm:true` is rejected before learning changes.

## Top-level fields of the response

| Field | Meaning |
| --- | --- |
| `view` | `summary` by default, or `full` when requested |
| `threshold` | the observation count at which the bandit starts running |
| `posteriors` | whether the posterior file was read — `ok` or `unreadable` |
| `journal` | whether the run journal needed for `lastApplied` was read — `ok` or `unreadable` |
| `cells` | the cell list; see the table below |
| `recent` | the recent run list. Present only when `runs` was given |
| `recentFiltered` | whether the recent list was narrowed by `task_class`. Always false, and present only when `runs` was given |
| `reduced` | which rung shipped when the response had to shrink — `fewer_recent`, `no_arms`, `fewer_cells`, `fewer_cell_keys` or `floor`. Absent when nothing was cut |
| `omittedCounts` | what that rung dropped, and how much. Comes only with `reduced` |

## What one cell reports

| Field | Meaning |
| --- | --- |
| `cellKey` | the task class joined to the axis |
| `taskClass` | this cell's task class. `null` for a hand-written key with no separator |
| `axis` | the decision axis name. `null` when there is no separator |
| `favoredArm` | the arm with the highest posterior mean |
| `observations` | counted **from that axis's own arms**. `null` for an axis this code does not know — not 0 |
| `untilActive` | observations still needed to reach the threshold; 0 once reached, `null` for an unknown axis |
| `lastApplied` | the latest run still applied to this cell's current reset generation, or `null` |
| `arms` | each arm's raw alpha and beta; `full` only |
| `banditActiveByDefault` | whether a plain run can activate the bandit here; `full` only |
| `banditActiveIfAllowSingle` | whether `allow_single` can activate it; `full` only |
| `optInArms` | arms requiring explicit opt-in; `full` only |
| `note` | an operational constraint needed to read the axis; `full` only |
| `unknownAxis` | marks an axis this code does not know; `full` only |

In `full`, activity stays two booleans because an `orch_run` with `allow_single` grows a second
`mix` candidate arm; the two values differ there.

`observations` counts that axis's own arms and not the cell's total, so a cell still holding arm names
from an older scheme can show a large sum and zero observations.

## What one recent run reports

| Field | Meaning |
| --- | --- |
| `runId` | the identifier to hand `orch_reward` |
| `at` | when the run originally happened |
| `taskClass` | the run's task class |
| `stopReason` | why the run ended, as the lane's own detailed code; the coarse value the envelope shipped is inside `terminal` |
| `grade` | the automatic grade of the result |
| `appliedGrade` | the grade actually applied **when the row was written**; it stays a past fact after a clear |
| `appliedCurrent` | whether that application still counts in the current generation. `null` for an old row with no applied axes, or when the generation could not be read |
| `appliedAxes` | the axes applied at the time. `null` when the old format cannot say |
| `artifacts` | how that run's artifacts look now: the frozen reference plus two fields. `null` for a row that was not inspected or kept no reference |
| `terminal` | how the run ended, read from the same row: the status, coarse stop reason and reason code the envelope shipped, when the run started and finished, its project, its task preview, and the run it continued. Every one of those is null for a row written before 0.3.0 |
| `gradeable` | whether `orch_reward` can correct this run. A run that never reached the learning step — blocked at preflight, cancelled — is listed with its terminal record and this set to false, instead of appearing as a row of nulls you cannot tell from a damaged one |

## What one artifact reports

| Field | Meaning |
| --- | --- |
| `exists` | whether a file is still at that path |
| `expired` | whether retention has passed, or the bytes no longer match the recorded reference. An expired artifact does not block a correction — only an expired reset generation does |

## One run makes at most one observation

A run produces at most one grade and touches each axis at most once; a winner is never credited with a
success while the loser is charged with a failure for the same run.

- **success** — only when the selected candidate is `verified`.
- **failure** — only when every candidate fell to trustworthy machine evidence — a stably reproduced
  test failure — or to an explicit policy violation.
- **abstain otherwise** — a verifier-only FAIL, untrusted tests, a flapping result, or a run that
  ended in `tie`, `blocked`, a deadline or a provider fault leaves the posteriors untouched.

An abstaining run still leaves somewhere to correct — its rewardable axis list, which is exactly what
hand correction is for. Which axes may be updated turns on whether the axis was a real choice:

- placement, only with one candidate. Two candidates run both placements, so neither can be credited.
- mix, with one candidate only when `allow_single` made a single vendor a real candidate; with
  two candidates once, after both lanes cross-checked and the outcome was not `single_survivor`.
- tier, only when every evaluated lane really used the same abstract tier.
- Nothing at all when the roles were pinned by hand, or a missing vendor left no choice to make.
- The rewrite axis is **retired**: new runs neither choose nor reward it, but its old
  observations are kept for reading and for hand correction.

## Corrections

`orch_reward` takes back the contribution already applied and writes the new grade, so calling
it repeatedly with the same `run_id` leaves the same result. Read `run_id` from `orch_stats`
with `runs`, or from `orch_status` with no arguments — that one reads the disk, so it also finds
runs this journal never recorded. Passing no `note` erases the note that run carried, and says so
in a notice.

★ **The authority for a correction is the choice the run froze.** The journal row holds the axis
and the arm that run really used, and a correction reads only those — a later reconstruction
could reward an arm no lane ran. A row whose frozen choice is damaged fails without a byte written.

★ **A run from before a clear can expire.** Once that run's cell generation is gone, `orch_reward`
refuses with `invalid` instead of re-entering it as new evidence. Make a new run and correct its `run_id`.

## Clearing

`orch_reset` clears posteriors only with `confirm:true`: with `task_class`, only that class's
cells; without it, everything. Its content is this object directly, without a wrapper object:

| Field | Meaning |
| --- | --- |
| `taskClass` | narrowed scope, or `null` for a full clear |
| `asked` | cells in scope, or `null` for a full clear |
| `cleared` | cells cleared |
| `failed` | cells not cleared |
| `cellKeys` | cleared keys, or `null` for a full clear |
| `posteriors` | `ok`, or `unreadable` when a full clear rescued unreadable bytes |
| `snapshot` | paired recovery paths and procedure, or `null` when nothing was cleared |

A hand-written key with no separator is removed only by a full clear.

★ A full clear can rescue an unreadable posterior file by snapshotting its bytes and matching
generation first. With both servers stopped, follow the procedure in `snapshot` and restore the
generation before the posterior file. Read `failed` with `cleared`; a failed scoped clear reports
all asked cells as failed and can be retried safely.
