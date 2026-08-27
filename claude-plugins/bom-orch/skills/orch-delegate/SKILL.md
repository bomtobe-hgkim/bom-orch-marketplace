---
name: orch-delegate
description: Hand a coding task to another vendor's CLI and get it cross-checked. The result is a patch file that nothing applies for you; orch_apply is the explicit step that puts it in your repository. If the call is cut off, read the run back with orch_status.
---

# Delegating a task and cross-checking it

`orch_run` gives one task to a worker inside a disposable git worktree, has a **different
vendor** verify the result read-only, and runs the tests itself, so pass or fail comes from an
exit code and not a model's word. `orch_status` reads a run back afterwards, and `orch_apply` is the separate call
that puts a finished run's patch into your repository. Every non-success envelope carries top-level `recovery`.
It names the next safe action; `REASON_CODES.md` at the plugin root lists every code and the same recovery.

## Arguments

| Tool | Argument | Required | Default | Allowed |
| --- | --- | --- | --- | --- |
| `orch_run` | `task` | required | — | — |
| `orch_run` | `project` | required | — | — |
| `orch_run` | `isolation` | optional | `worktree` | `worktree` |
| `orch_run` | `budget` | optional | `5` | integer 1-10 |
| `orch_run` | `wait_ms` | optional | `1800000` | number >= 0 |
| `orch_run` | `candidates` | optional | `1` | `1`, `2` |
| `orch_run` | `allow_single` | optional | `false` | — |
| `orch_run` | `resume_run_id` | optional | — | — |
| `orch_run` | `scope_allow` | optional | — | — |
| `orch_run` | `writer` | optional | — | `claude`, `codex` |
| `orch_status` | `run_id` | optional | — | — |
| `orch_status` | `runs` | optional | `10` | integer 1-50 |
| `orch_apply` | `run_id` | required | — | — |
| `orch_apply` | `check_only` | optional | `false` | — |

- `task` — what to do; the more specific, the better.
- `project` — an **absolute path** to a git repository. This server's working directory is
  whatever the host handed down, so a relative path lands in the wrong repository.
- `budget` — attempts a lane may spend, counted **per lane**. A writer call that started costs one
  attempt even if it is cut short; a format-only verifier retry is read-only and costs nothing.
- `wait_ms` — the run's one **shared deadline** in milliseconds, never a per-lane allowance.
  After it passes no new provider, test or judge call starts and only existing artifacts survive.
- `candidates` — how many independent candidates to run. `2` uses both providers with a
  per-lane `budget` and cannot be combined with `allow_single`.
- `isolation` — one value today: vendor CLI tool-permission flags were measured not to
  constrain the worker's shell, so the disposable worktree is the only isolation that holds.
- `scope_allow` — globs (POSIX style, `**` allowed) for paths this task is expected to change,
  unioned with `scope.allow` in the project's `.bom-orch.json`. Matching is two-sided, so `.claude`
  covers that directory itself and `.claude/**` covers what is under it. It waives a lockfile or an
  editor-settings directory; it never waives a CI definition, a shell rc, or anything that decides
  what the tests run — those are ignored even when listed, and a notice says which entries were.
- `writer` — pin the vendor that writes this run's patch, instead of letting the learned
  statistics choose. The other vendor still cross-checks it. One run only; `orch_config`
  sets the standing pin. It cannot be combined with `candidates: 2`, which needs both.
- `resume_run_id` — continue an earlier run, named by `orch_status`. Its sealed attempts are
  **read**, never run again, and this call numbers its own attempts from where that run stopped,
  so `budget` covers what is left. Reuse needs an exact match on the baseline tree and the
  test environment fingerprint; the synthetic commit may differ even for the same tree. On any mismatch the call is refused with a `resume_*`
  code and nothing starts, so call again without it. The resumed run gets its own `run_id`.

★ **`candidates: 2` roughly doubles the provider, writer and test cost.** Both lanes write, both
cross-check, and regression evidence is produced once per lane.

★ **Regression proof multiplies the test runs.** A run that must prove a regression runs your
whole test suite up to six times in series per candidate per attempt, against two for a run that
needs no proof — 22 at the default `budget: 5`. `cost.testRuns` reports it, `preflight.warnings` predicts it.

★ **`allow_single` defaults to `false`.** Calling `orch_run` asks for cross-checking and one vendor
alone betrays that request. Turning it on is what gives the `mix` axis a second arm — see orch-learn.

## Getting a run back

`orch_status` reads a finished run off disk: with `run_id` it reconstructs one run; with no
arguments it lists the recent runs, which is how a `run_id` is found after the host cut the call
off. `runs` sizes that list and means nothing beside `run_id`. A reconstruction carries how the
run ended — the stored code, whose sentence is re-rendered on the way out because sentences are
never written to disk — plus a manifest summary, the plan the run worked from, the verifier
issues and judge prose it kept, the tail of the log, and the artifact paths.

★ **Model prose there is labelled, never evidence.** Every row carrying model text says
source: "model", and that text reaches none of the envelope's own sentences. A run with no
journal row is reported as unknown instead of being given an invented ending, and its
confidence stays `unverified` until the manifest reads cleanly and the run is over.

## Result

The patch **file path** comes back as `patch.path`. **`orch_run` never applies the patch** — putting
it in your repository is a separate `orch_apply` call you make after reading what it changes.
`patch.empty: true` means the worker changed nothing, and `runId` is the value `orch_reward` takes
to correct this run's grade.

★ **A flagged scope is a verdict for a human, not a discarded run.** `scope.flagged: true` means
the patch touched files the policy did not expect; the patch file stays on disk and `scope.reasons`
says what tripped. The envelope goes out on the failure side rather than `succeeded` UNLESS
`scope.allowlisted: true`, which says every one of those reasons was one the allowlist named in
advance — such a run is flagged and still judged on its evidence like any other.

### Top-level fields of the result body

| Field | Meaning |
| --- | --- |
| `runId` | this run's identifier |
| `stopReason` | why the run ended — the same closed thirteen-value vocabulary as the envelope, and every one of the thirteen is listed in the `stopReason` column of `REASON_CODES.md` |
| `reasonCode` | the registered detail code for that same stop. A success envelope leaves it off the top level, so the body is where the detail survives |
| `stepCount` | how many attempts the selected candidate spent |
| `baseline` | the commit and tree the patch is written against, whether the repository was dirty when the run started, and which files that was. A clean start may reuse its HEAD; after uncommitted work is transplanted, the server makes a synthetic commit that no caller ref points at |
| `patch` | the patch chosen as this run's result. Absent on stops that have no representative patch |
| `scope` | whether the patch touched files that were not expected |
| `worktree` | how the disposable worktree was cleaned up |
| `blockers` | which lanes were stopped, each with a registered code and a sentence |
| `learning` | the decision axes this run used and the grade it actually applied |
| `plan` | the provider that planned, and the planner's own text |
| `steps` | the selected candidate's attempt order |
| `verdict` | the verifier's structured verdict on the selected candidate |
| `issues` | the blocking issue identifiers still open, per lane |
| `candidates` | each candidate's terminal class, patch and proof status |
| `attempts` | references to the immutable attempt records |
| `excerpts` | labeled vendor stderr; the first thing a reduced body drops. Today the excerpts a run actually ships ride at the envelope top level, on failure envelopes only |
| `regressionProof` | the state of the regression proof and its evidence references |
| `selection` | which candidate was taken, and why |
| `artifacts` | the manifest and candidate patch paths this run left, and when they expire |
| `cost` | what this run spent: elapsed time, calls and tokens per vendor, and how many times the suite ran |
| `preflight` | what was known before any credit was spent: whether evidence was reachable, each vendor's auth state, and the warning keys this run raised |
| `omittedCounts` | how many items were dropped, per kind |
| `reduced` | which rung shipped (see below) — `full`, `no_excerpts`, `summarized_attempts`, `limited` or `floor` |

`artifacts.manifestPath` and `artifacts.candidatePaths` are **absolute paths**; `artifacts.expiresAt`
is when this server's cleanup may delete them. `regressionProof.status` matters for a run that needs
regression proof — the default for code work unless the task reads as a feature, refactor, or docs change.

★ **Retention and manual cleanup.** The default state root is `~/.bom-orch` (or the exact absolute `BOM_ORCH_HOME` you set).
Patches, run records, and logs expire after 30 days; disposable scratch rooms after 6 hours; `effect_unknown` worktrees after 30 days; and the private npm cache after 30 idle days.
Apply-recovery and manually retained scratch rooms are kept indefinitely until manual cleanup. The learning journal is append-only and has no automatic retention deletion.
Retention cleanup is not a background service: it runs only when this MCP server starts or handles a run. Uninstalling either host/plugin does not delete this state.
To remove it safely, stop both Claude and Codex hosts, uninstall the plugin from both if applicable, and verify the exact state-root path. For the default root, use PowerShell: `Remove-Item -LiteralPath (Join-Path $env:USERPROFILE '.bom-orch') -Recurse -Force`. On POSIX: `rm -rf -- "$HOME/.bom-orch"`. If `BOM_ORCH_HOME` is set, substitute the exact absolute state root you verified instead of the default path. Linux orphan cleanup identifies a process with the kernel boot ID plus `/proc` start ticks, and Windows uses process start ticks. On macOS, the process start identity reported by ps has one-second resolution; an extremely fast same-second PID reuse remains a documented residual, while any missing or malformed identity fails closed without killing or deleting anything.

### The five `selection.outcome` values

| Value | Meaning |
| --- | --- |
| `winner` | one candidate won, and `patch.path` holds its result |
| `single_survivor` | the other lane dropped out and the remaining one was taken |
| `equivalent` | the two patches were byte-identical, so the first lane is used without a judgment |
| `tie` | the judgment split |
| `none` | there was no candidate to take |

★ **A `tie` ships no representative patch**: `selection.selectedCandidateId` is `null` and there
is no `patch`. Both patches stay in `artifacts.candidatePaths`. `none` ships none either.

★ **Confidence has three values.** `verified` — this call established the fact by machine.
`unverified` — the best report with no machine evidence, or with partial or stale evidence.
`disputed` — evidence or policy **contradicts** success, and the status is forced to `failed`.

★ **A run whose tests were missing or untrusted is capped at `unverified`.** That result is
usable but must not be read as "the tests passed". `disputed` is what a verifier that failed
twice, a broken hard scope rule, or tampering with the test definitions produces.

★ **What `verified` needs depends on the test ecosystem.** The table above the install commands in
the marketplace repository's README says what each one yields; outside those rows nothing tells this
server which test covered which file, so a run that needs regression proof stops at `unverified`.

★ **The verifier is read-only and returns a structured verifier verdict** — checks and issues,
not a prose approval. That verdict alone never makes a run `verified`; machine evidence does.

★ **Model prose is never evidence.** The verifier's issue bodies are kept with the run artifacts
under the label "what the model said" — a claim to check, never proof. `excerpts`, labeled vendor
stderr, is the only text in the envelope this server did not write itself — and even that is a
process's stderr, never a model's answer.

★ **Long state-root paths are refused before the run starts**: the call ends `blocked` before any
provider, worktree or artifact exists. Point `BOM_ORCH_HOME` at a shorter directory and retry.

★ **This is not an OS sandbox.** The worker's code and your repository's test scripts run with
your own user's privileges inside the disposable worktree — never on a repository you distrust.

★ **Models are not chosen here.** Which vendor runs which role is decided by configuration and
learning; to change it, see the orch-model skill, which also says where the names come from.

## Applying the patch

`orch_apply` takes the `run_id` of a finished run and puts that run's patch into your repository.
It is the one call in this server that writes outside its own state directory, and it writes only
when you make it — which is what "the patch is never applied for you" means in practice.

★ **The run baseline and apply-time HEAD are separate facts.** A clean start may reuse the starting HEAD.
When uncommitted work is transplanted, the baseline becomes a server-created synthetic snapshot. An explicit `orch_apply` first checks the target
working tree as it stands; only when direct application does not fit may it use that baseline for a
verified three-way onto the target's current committed HEAD. A full apply report distinguishes the run `baseline`,
target HEAD, and current repository dirtiness. Scope approval comes only from `scope.allow` in the committed `.bom-orch.json`
at that HEAD; the earlier call's `scope_allow` is not retained. If the final pre-write recheck sees a HEAD
move, it returns `apply_head_moved` without applying; that check and `git apply` are separate processes: avoid concurrent repository
changes, and follow the failure envelope's top-level `recovery` for the next safe action.

Before touching anything it checks, in this order, that the name is one this server makes, that the
run is on this state root, that its records read cleanly, and that the patch itself is there and is
a file. Each of those refusals carries its own registered reason code: apply-specific gates use an
`apply_*` code, while state_root_not_absolute and learning_journal_read_failed stay exact. Thus
"there is no such run" and "the patch was already reclaimed" never arrive as the same answer. `check_only: true` asks for the report without the change.

★ **A run with no representative patch cannot be applied.** A `tie` and a `none` leave nothing under
`patch.path`, and the cleanup reclaims patch files on its own schedule, so a missing-patch refusal is
a normal answer for an old run rather than a defect. `orch_status` lists which candidate patches are
still on disk.

## ★ The body can arrive reduced — not every field above is always present

The body has a size cap; the first rung that fits ships, and `reduced` names it, so "this rung
dropped it" never has to be inferred from "this field is missing".

- `no_excerpts` drops `excerpts`; `summarized_attempts` keeps each lane's last attempt only; `limited`
  empties `scope.reasons` (keeping `scope.flagged`, `scope.hardViolation`, `scope.allowlisted` and
  `scope.reasonCount`), drops the
  planner text and caps blockers; `floor` is a fixed summary. `omittedCounts` carries a number for every list
  it dropped; `preflight` disappears at `floor` and `learning`/`steps` empty there, uncounted — `reduced` tells you.
- A missing `scope.reasons` therefore never means "there were no reasons" — read
  `scope.reasonCount`, which every rung carries.
- No rung truncates an absolute path, so a `patch.path` from a reduced body is still a usable path.
- `truncatedReport` is not a field of the body. `{"truncatedReport":true}` replaces the **whole
  body** as a last-resort constant when even the fixed floor cannot be serialized.
- The envelope carries `log.path`, this run's JSONL diagnostic file, whenever one was opened;
  that is an envelope field, not a body field, and it does not follow the rungs.

## Example envelope

The `floor` rung, taken from this server's golden envelopes — what a body cut to the bone still tells you.

```json
{
  "status": "succeeded",
  "content": "{\"runId\":\"run-golden\",\"stopReason\":\"verified\",\"reasonCode\":\"lane_verified\",\"stepCount\":10,\"baseline\":{\"commit\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"tree\":\"cccccccccccccccccccccccccccccccccccccccc\",\"dirty\":true,\"dirtyFiles\":[\"docs/notes.md\",\"src/lane-a/000-changed-module.mjs\"]},\"patch\":{\"path\":\"/golden/state/patches/run-golden.patch\"},\"scope\":{\"flagged\":false,\"hardViolation\":false,\"allowlisted\":false,\"reasonCount\":2,\"omittedReasonCount\":0},\"worktree\":{\"transplanted\":true,\"ignoredPathCount\":16,\"sharedRuleCount\":0,\"cleanup\":{\"removed\":true,\"unregistered\":true,\"tracked\":false}},\"blockers\":[],\"learning\":null,\"plan\":{\"provider\":\"claude\",\"content\":null,\"source\":\"model\"},\"steps\":[],\"verdict\":{\"candidateId\":\"lane-a\",\"attemptId\":\"run-golden/lane-a/010\",\"verdict\":\"PASS\"},\"issues\":[{\"candidateId\":\"lane-a\",\"openIssueIds\":[],\"openIssueCount\":0,\"resolvedOmittedCount\":0}],\"candidates\":[{\"candidateId\":\"lane-a\",\"patch\":{\"path\":\"/golden/state/runs/run-golden/candidates/lane-a.patch\"},\"proofStatus\":\"proved\",\"openIssueIds\":[],\"openIssueCount\":0}],\"attempts\":[],\"regressionProof\":{\"status\":\"proved\",\"selectedCandidateId\":\"lane-a\",\"evidenceRefs\":[],\"omittedEvidenceCount\":0},\"selection\":{\"outcome\":\"winner\",\"selectedCandidateId\":\"lane-a\"},\"artifacts\":{\"manifestPath\":\"/golden/state/runs/run-golden/manifest.json\",\"candidatePaths\":[\"/golden/state/runs/run-golden/candidates/lane-a.patch\"],\"omittedCount\":0},\"cost\":{\"elapsedMs\":1234567,\"providers\":{\"claude\":{\"calls\":12,\"promptTokens\":1234567,\"evalTokens\":1234567},\"codex\":{\"calls\":9,\"promptTokens\":1234567,\"evalTokens\":1234567}},\"testRuns\":{\"count\":6,\"totalMs\":1098765}},\"omittedCounts\":{\"issues\":0,\"attempts\":10,\"evidence\":0,\"files\":22,\"artifacts\":0,\"scopeReasons\":2,\"blockers\":1,\"planChars\":66},\"reduced\":\"floor\"}",
  "confidence": "verified",
  "runId": "run-golden",
  "stopReason": "verified",
  "log": { "path": "/golden/state/logs/run-golden.jsonl" }
}
```
