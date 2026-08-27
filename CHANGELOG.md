# Changelog

## 1.0.1 - 2026-08-27

A documentation fix. There is no code change in this release: the server, the tool surface and
the state format are byte-identical to 1.0.0.

- **Corrected: the 1.0.0 notes announced themselves as `0.5.0`.** The heading above the feature
  list read "What you will notice in 0.5.0" — a version that was never published and cannot be
  installed. The entry had been written while this release was still numbered 0.5.0, and the
  renumbering to 1.0.0 missed that one line. It shipped in all three copies of the changelog
  (the marketplace root and both plugin roots) and in the v1.0.0 tag.

  The v1.0.0 tag is left exactly as it is. Moving or deleting a published tag would break anyone
  who already pinned it, so the correction ships forward as 1.0.1 instead. If you installed
  1.0.0, you lose nothing by staying on it except that one wrong version number in the notes.

## 1.0.0 - 2026-08-27

This is the first public release since 0.2.2. The `0.4.0` and `0.3.0` entries below were internal
staging points that were never published — there is no way to install them, and everything they
describe ships here. Read all three entries when upgrading from 0.2.2.

**Important first-upgrade boundary.** Version 0.2.2 predates the state schema and fencing used by
this release, so it cannot safely run against the same `BOM_ORCH_HOME` while this release is
running. For the first upgrade, stop both Claude and Codex hosts, upgrade both, and only then
restart them. Do not restart or roll back a 0.2.2 host after either upgraded host has published
the new schema. Version-skew safety begins only between schema-aware releases: when such an older
host sees a newer schema, it falls back to read-only access instead of rewriting the state.
Both host applications must run on the same machine and the state root must be on its local
filesystem. Do not put `BOM_ORCH_HOME` on a network share or use one root from different machines;
remote process identity and distributed-filesystem locking are not supported.

What you will notice in 1.0.0:

- **Shared state files carry a schema version, and a newer one is never rewritten.** `children.json`,
  `posteriors.json` and `settings.ini` record the version that wrote them. A server that meets a
  higher version treats that file as opaque: it runs on defaults, reclaims nothing from it, refuses
  every write, and says so in a notice rather than failing the run. The bytes are left exactly as
  they were found.
- **A worktree records its recovery authority before Git touches the disk.** Creation writes a durable
  row naming the owning process, so a crash between `git worktree add` and the first checkpoint leaves
  something the next start can reclaim instead of an orphan nobody owns. Removal proves it owns that
  exact row before it deletes anything.
- **The reaper ledger is locked across processes.** Two hosts on one machine no longer interleave
  read-modify-write on `children.json`, and a crashed run's worktree is unregistered from the
  repository it belonged to rather than only deleted from disk.
- **Recovery material outlives the boot sweep.** The isolation directory kept for an `effect_unknown`
  result now survives restarts for its full retention period instead of being swept on the next start,
  and the first tool call waits for that sweep to finish so a live child is never mistaken for debris.
- **Every envelope names the server version and how to upgrade it.** The bundled `CHANGELOG.md` ships
  at the plugin root, and its top entry is checked against the package version.
- **`orch_stats` is read-only, and destruction has its own name.** Statistics default to a summary:
  the favored arm per cell, how many observations remain until it activates, and the last run that
  moved it. Pass `view: "full"` for the raw alpha and beta values. Clearing what was learned is now
  the separate `orch_reset` tool, which refuses to run without `confirm: true`.
- **You can pin the writer, or turn learning off.** `orch_config` gained `writer` and `learning`;
  `orch_run` gained `writer` for a single run. A pinned writer skips the bandit for that choice and
  the other vendor still cross-checks the result.
- **A false claim is gone from the planner prompt.** The learning statistics were introduced to the
  model as facts observed in this repository. They are not: a cell is keyed by task class and axis
  only, with no repository dimension, so observations from every repository share one cell. The
  header is removed rather than reworded.
- **Runs with no tests no longer teach the bandit by default.** A `code:no-tests` run cannot produce
  an automatic grade, so it records the exact arms it used and waits for a human `orch_reward`
  instead of counting itself a success.
- **The README answers the five questions before it asks you to install anything.** What it is, why
  it is different, what a run costs, when not to use it, and how to start — in that order, above the
  install command, with the thirteen limits summarised in one line and linked. Added: a real result
  envelope taken from the checked-in goldens, a troubleshooting section that starts from the failure
  you are most likely to hit first — the tools do not appear and nothing reported an error — and a
  link to the issue tracker.
- **Corrected: the install checks told you to look for the wrong number of tools.** One document
  said five and the other said seven while both of their own tables were headed "The eight tools".
  Both now say eight and a test derives that number from the tool set, so it cannot drift again. The
  two stale `v0.2.0` marketplace pins in the upgrade instructions were also wrong and are now
  checked against the package version.

## 0.4.0 (Unreleased)

Two additional manifest fields change on disk:

- **Run manifests gained a fifth artifact kind, `plan`.** The planner's output is written once to
  `runs/<runId>/plan.json` and registered in the manifest like the four kinds before it, so it gets
  the same digest, the same expiry and the same 30-day reclamation.
- **The recorded usage totals gained a fifth key, `vendors`.** Every finalized
  run now checkpoints `usage` as `{calls, promptTokensKnown, evalTokensKnown, incomplete,
  vendors}`, where `vendors` is the per-vendor breakdown `orch_status` reports. It reaches runs
  the `plan` kind does not: a run whose planner never answered writes no plan artifact and still
  carries the new key.

What you will notice in 0.4.0:

- **A committed `.bom-orch.json` now configures the run.** It is read from git commit objects
  only - never from a checkout copy - so a worker can never alter what runs. An uncommitted
  edit to that one file refuses the run with `config_uncommitted` and says to commit or stash
  it; uncommitted source changes keep working exactly as before.
- **Dependency provisioning, strictly opt-in.** `tests.provisionDeps: "lockfile-install"` runs
  your lockfile install with lifecycle scripts disabled, inside the run's worktree, with its
  package cache under the state root - nothing is written outside it, and without the opt-in
  nothing is ever installed.
- **JUnit XML becomes trusted test evidence, when you opt in.** One adapter (`junit-xml-v1`)
  parses Gradle, Maven, cargo-nextest, gotestsum, jest-junit and Vitest output - directories of
  per-class files included. It is never selected automatically: a committed `.bom-orch.json` has
  to declare `tests.reporter: "junit-xml"` and `tests.resultsPath`, and the four JVM/Go/Rust
  ecosystems need `tests.command` as well. The README ecosystem table above the install commands
  says exactly what evidence each ecosystem yields, what each one has to declare, and where
  regression proof stops.
- **`orch_status` can show the planner's plan** for a run, labeled as model prose with the
  same caps and canary as every other model-authored field.
- **The envelope now answers what it could know before spending credit.** A `preflight` row
  carries the run's own predictions: whether trusted regression evidence is reachable at all in
  this repository, each vendor's login state, and warnings for the ones that need a decision -
  the proof multiplier against the wait budget, and a codex command line that would not fit.
  None of them stop the run: the wait budget and the money are yours. They are facts you get
  before the first vendor call instead of after it.
- **And what the run actually cost.** A `cost` row reports elapsed wall clock, how many times
  the test suite really ran (a cache hit is correctly not a run), and per-vendor call counts
  with prompt and eval tokens. Token counts are omitted for a vendor whose accounting did not
  close, rather than reported as a total that is really a floor.
- **A run that must prove a regression runs your whole test suite up to six times in series per
  candidate per attempt**, against two for a run that needs no proof. Only the two plain baseline
  runs are shared across the whole run, so the run's own ceiling is 22 serial suite runs at the
  default `budget: 5` and 42 with `candidates: 2` - and that is the number the pre-credit warning
  compares against `wait_ms`. That is your suite against your deadline, not vendor calls - the
  limits list in every README says so now, with the arithmetic.
- **Vendor login is checked read-only, before credit.** The check runs one subcommand and only
  one it has confirmed is a query: the name has to be a known query name AND the vendor's own
  help text has to describe it with a read verb and no mutating or credential word. If nothing
  matches, nothing is executed and the run continues with the login state unknown - it never
  blocks on what it could not confirm. Only a confirmed logged-out vendor stops the run, with
  the existing "log in" failure.
- **Gateway deployments are refused before credit, not after.** If `CLAUDE_CODE_USE_BEDROCK` or
  `CLAUDE_CODE_USE_VERTEX` is turned on in the shell that starts this server - any value but an
  explicit `0`, `false`, `no` or `off` - the run stops with
  `preflight_gateway_env_unsupported` and says which variable it saw. Those variables never
  reached the vendor child anyway - the child environment allowlist drops them - so before this
  release a gateway user paid for a run and got "the stream ended" or "log in" instead.
- **When Anthropic reports its own account limit, you see it once.** The rate-limit numbers the
  claude CLI already sends now arrive as a single labeled notice per vendor, in the vendor's own
  units: a raw utilization, and a reset point only when it is a timestamp we can actually read.
- **The codex judge prompt is bounded to fit the command line.** Judging with `candidates: 2`
  always puts one judge on codex, which takes its prompt as an argument; its upper bound was
  48,439 characters against a 32,767-character whole-command-line limit. The judge's view of a
  candidate is now clipped to a derived cap and labeled with what was left out, using the same
  excerpt vocabulary as everywhere else. The cap is derived in the units the limit actually
  counts - Windows escapes every `"` inside an argument, and the prompt is JSON - and 1,024
  characters are reserved for the rest of the command line, which varies with how deep your
  `BOM_ORCH_HOME`, your node and your codex install sit. Longer paths than that reservation
  covers are the one case this bound does not cover.
- **Scope findings now distinguish hard boundaries from changes you explicitly allow.** CI,
  hooks, shell startup files, package-manager execution settings and test-command definitions
  remain hard; lockfiles and named editor settings can be acknowledged with `scope_allow` or
  committed `scope.allow`. The result still reports that the path was flagged.
- **Applying a result is a separate, explicit `orch_apply` call.** `orch_run` still never changes
  your repository, and `check_only: true` checks the same candidate without writing it.
- **Every result names the baseline it was written against.** A moved HEAD alone does not select
  three-way: `orch_apply` tries the authenticated patch directly against the current working tree
  first, then uses its baseline and temporary index only if direct application does not fit. A
  conflict or missing preimage is refused instead of leaving conflict markers behind.
- **Apply decisions are checked, reported and recorded.** The patch is rechecked against current
  scope policy, the response says which files and mode were used, and a successful application
  annotates the run journal without changing bandit rewards.
- **Provider notices no longer disappear at finalization.** Sandbox limitations, unsupported
  tool-set restrictions and the other bounded provider notices now reach the run envelope.
- **The smallest result body is bounded even with duplicated issue IDs.** The contract-required
  `issues` and `candidates` views keep the same sorted subset, report logical omissions, and stay
  within the 10,000-character envelope floor under worst-case escaped IDs.

## 0.3.0 (Unreleased)

Two things change on disk. This staging line is not safe to run concurrently with 0.2.2 against
one state root; follow the coordinated first-upgrade boundary at the top of this changelog.

- **Every `planFingerprint` differs from 0.2.2.** The frozen test plan pins each definition
  under a key, and those keys are hash input; this release rewrites them into English
  (`root *.test.mjs`, `test target`). Nothing is lost and nothing needs migrating, but a plan
  frozen by 0.2.2 no longer matches one frozen here, so cached evidence from the older
  version is re-collected rather than reused.
- **Run manifests gained fields 0.2.2 does not know.** A copied legacy reader reports those
  manifests as `invalid_manifest`; that observation is not a coexistence guarantee and is not
  permission to point a running 0.2.2 host at upgraded state.

What you will notice:

- Every failure now carries a `reasonCode` from a closed registry next to the coarse
  `stopReason`, so two different faults stop reading as the same one.
- The whole runtime surface is English: messages, recovery advice, notices, skills and tool
  descriptions. Each failure names what to do next instead of restating what broke.
- Labeled vendor `stderr` excerpts ride along on the failures they explain, never on other
  ones, and never from model output.
- Each run writes a JSONL log under the state root and the envelope points at it (`log.path`).
  The log now opens before the vendors are checked, so a run that stops at the preflight has one
  too: "not logged in", "binary missing" and "below the security floor" used to reach no channel
  at all, because the envelope may not carry vendor output. One consequence is worth knowing: if
  your state root and your vendor CLIs are both broken, the state root is now the failure you are
  told about first, and it is the one to fix first.
- How a run ended is written down. Each run appends one row to the learning journal and one line
  to its own log naming its status, stop reason and reason code, which is what `orch_status`
  reads back. A 0.2.2 host reading the same journal ignores the new fields rather than choking on
  them.
- Oversized results shrink by named rungs instead of silently: `reduced` says which rung
  shipped and `omittedCounts` says what it left behind.
- `orch_stats` folds long tables the same way and says how many rows it folded.
- A new `orch_status` tool reads a finished run back off disk: call it with a `run_id` to get
  how that run ended, its manifest summary, the verifier issues and judge prose it kept, the
  tail of its log and its artifact paths — or with no arguments to list the recent runs. It is
  how a run is recovered when the host times the call out or the session ends before it does.
  The model-written text it carries is labelled `source: "model"` and never becomes a failure
  sentence.
- `orch_run` can continue an earlier run. Pass `resume_run_id` and the attempts that run **sealed**
  are read rather than run again, so this call's `budget` is spent on what is left: a source that
  sealed two attempts under a budget of three leaves one attempt to run, and the saving is the
  writer, verifier and test time of the two it reused. An attempt the source allocated but never
  sealed — a crash, a killed process, a failed artifact write — costs you nothing: only sealed
  attempts count. With two candidates both lanes start at the same attempt number, so they get the
  same number of fresh attempts rather than inheriting whatever number each lane happened to stop
  at. What is reused is the attempt numbering, not the earlier patch — the resumed run starts from
  the current baseline and gets its own `run_id`, and the envelope carries a notice naming the run
  it continued, the attempt number every lane starts at and how many attempts of this budget are
  left. It refuses before it starts anything if the named run is missing or unreadable, or was
  built on a different source tree or frozen in a different environment; if that run already used
  the whole budget this call gives it, there is no room left and the run answers `budget_exhausted`
  instead of pretending to work.
  The match is on the **tree**, not on a commit id. The preparation step commits your uncommitted
  work inside its own worktree, and that commit is minted fresh for every run — so keying the
  check on a commit made resume impossible on any project with a single uncommitted edit, forever.
  Two runs over byte-identical sources now resume, and only a real change to the source refuses.
- Each run's journal row records when the run **started**, not only when it finished, and names the
  run it resumed from if it was a resume. `orch_status` reports both, so a run that was cancelled
  or hit its deadline finally answers "how long did it run before it was cut" — that pair used to
  read as zero or a negative duration, because the only timestamp available was the moment the row
  itself was written. A 0.2.2 host ignores the two new fields rather than choking on them.
- Progress notifications say which run they belong to. Each one now carries a `total` and a
  fixed one-line `message` — `<runId> lane=<A|B|-> role=<...> phase=<...> attempt=<k>/<budget>`
  — so a long run is readable while it happens, and the `run_id` to hand to `orch_status` is
  there from the first notification. The step names no longer change wording depending on
  whether the run had one candidate or two.
- The engine's own deadline cap moved from 60 to 55 minutes. It has to expire before the host's
  tool timeout does: if the host gives up first you get a transport error instead of an
  envelope, and the run's partial result and reason code reach no channel at all. The default
  `wait_ms` is unchanged at 30 minutes, and a run that asks for more is still capped rather
  than refused.
- The host can stop a run. A cancel notification, a `SIGTERM`, or a closed stdio pipe now
  reaches the engine as one abort: the vendor CLIs the run started are killed at once instead
  of waiting for the next boot sweep, an authoring worktree that is left behind is quarantined
  and handed to the reaper — a cancel that lands before one exists, or after one was cleanly
  removed, has nothing to hand over, so the worktree notice appears only when something really
  was left, and its absence means nothing was — and the call answers with a `cancelled`
  envelope carrying `run_cancelled` rather
  than dying with the transport. `status` gains `cancelled` for exactly that case — a run our own deadline cut
  still answers `deadline_exceeded`, because the two are told apart by which signal fired and
  not by what the vendor reported. On `SIGTERM` the server settles the in-flight call, sends
  its envelope, and only then exits. A cancelled run teaches the model chooser nothing: pressing
  stop is not evidence against whichever vendor happened to be running. Nothing a cancelled run
  writes tells you to raise `wait_ms`: the vendor fault ledger, the run log and the blockers say
  the call was cut short and stop there, and a blind judge cut off mid-decision records a
  cancellation rather than a deadline. Only the signal source decides which of the two it was.
- `orch_status` with no arguments lists a run the journal alone remembers. The listing used to
  be the union of the run directories and the log files, so a run whose log could not be opened,
  and every run once the 30-day sweep has taken its directory and its log, was invisible — while
  `status_run_not_found` and `resume_run_not_found` both tell you to call exactly that listing.
  Reading one run also stops answering "no run of that name is on this state root" when the
  witness merely could not be read: an unopenable journal or an oversized log file now answers
  "unreadable" and says which one, and a manifest that names a different run than the directory
  it sits in is refused instead of quietly serving that other run's attempts and its review prose.
- `orch_stats`' recent list is readable for a run that never reached the learning step. A run
  blocked at preflight or cancelled used to arrive as an id, a timestamp and seven nulls — the
  same shape as a damaged line — while still taking a slot in the window you asked for. Each row
  now carries the terminal record that was in the same journal line all along and says whether
  `orch_reward` can correct that run.
- A new `/orch-setup` command walks first-run configuration.

## 0.2.2 - 2026-08-16

- Correct the README: learning is **not** scoped per repository. Runs are bucketed by task
  class into a single `.bom-orch` store shared by every project and both hosts, and 0.2.1
  said otherwise. `BOM_ORCH_HOME` is the way to keep projects apart.

## 0.2.1 - 2026-08-16

- Rewrite the marketplace and plugin READMEs to lead with the limits this release enforces
  instead of filing them below the install instructions.
- Derive the README release gate from package metadata, so it cannot keep demanding a version
  the documentation has already moved past.
- Stop the `claude-run` abort and timeout fixtures from racing stub startup under load.

## 0.2.0 - 2026-08-16

- Decide every `orch_run` from a structured verifier verdict and revision-bound machine
  evidence instead of a worker's prose report.
- Add opt-in `candidates: 2` competition with deterministic selection, blinded judges for
  distinct objective ties, and honest `tie` results that keep both candidate patches.
- Persist bounded immutable run artifacts (manifest, attempts, evidence, candidate patches)
  under a private per-run namespace with 30-day retention.
- Record at most one learning sample per run, never reward an arm no lane executed, and keep
  the policy-v1 `rewrite` history readable for manual correction.
- Install the Node and pytest reporter assets beside the bundled server so trusted regression
  witnesses work from an installed plugin.
- Report in the run envelope that the repository test suite executed with your own privileges
  and could read your home directory, including credential files (design §5.8 S1).
- Refuse to let a Claude Code below 2.1.84 hold the writer role (CVE-2026-40068 worktree
  escape); read-only roles are unaffected, and an unreadable version never blocks a run.
- Show the verifier what our own test run concluded, as classified facts only — never raw
  test output.
- Accept a provider verdict wrapped in a fenced code block without loosening the schema.
- Read `icacls` grants independently of the host UI language, so non-English Windows hosts
  can create private run artifacts.
- Accept host-separator paths from the pytest adapter so Windows Python projects can produce
  regression witnesses, and keep compiled Python bytecode out of the published plugins.
- Stop learning a tier distinction that does not exist until `orch_config` sets the models,
  and supply the planner only with evidence for axes the run could actually choose.

## 0.1.1 - 2026-08-12

- Document the published GitHub marketplace and verified CLI installation paths accurately.
- Keep Desktop discovery/load and live model/provider calls explicitly unverified.
- Make the Claude default-timeout regression test deterministic under full-suite load.

## 0.1.0 - 2026-08-11

- Publish separate Codex and Claude Code plugin roots from one repository marketplace.
- Include readable source, shared skills, host-specific MCP configuration, and a self-contained server bundle.
- Preserve bundled dependency license notices in the repository and both plugin packages.
