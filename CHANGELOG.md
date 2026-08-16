# Changelog

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
