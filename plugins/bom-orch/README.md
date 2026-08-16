# Bom Orchestration

### Two AI CLIs. One writes. The other has to prove it.

Bom Orchestration runs locally as an MCP server. It delegates a coding task to one
vendor's CLI inside a disposable git worktree, runs your repository's **own** test
suite itself, hands the result to a **different vendor** for read-only review, and
grades the outcome on machine evidence rather than a model's prose report.

When it cannot prove the change works, it says `unverified` and tells you why.

**Requirements:** Node.js 20.10 or newer, with `claude`, `codex`, and `git` on the
host application's `PATH`. Authenticate both worker CLIs before calling `orch_run`.

## The five tools

| Tool | What it does |
|---|---|
| `orch_run` | Delegates a task, cross-checks it with the other vendor, returns a patch file and a structured outcome |
| `orch_models` | Lists installed vendors, versions, and available model choices |
| `orch_config` | Reads or updates the model and effort behind each tier |
| `orch_stats` | Learning statistics per task class and decision axis, plus recent runs |
| `orch_reward` | Human correction of a past run's automatic grade. Idempotent |

Argument tables and the full result contract ship with this plugin as skills, which
both hosts read.

## Before you rely on a result

This comes before the usage instructions on purpose. A tool that promises not to
claim success it cannot prove should lead with the cases where it stops.

- **Structured verifier, not prose.** The verifier returns structured JSON checks
  and issues. Callers that treated a prose approval as a pass need to be updated.
- **`candidates: 2` roughly doubles cost.** Two lanes each author, each
  cross-verify, and each run their own regression evidence.
- **One shared deadline.** `wait_ms` bounds the whole run, not each lane. After
  that shared deadline passes, no new provider, test, or judge call starts.
- **A `tie` keeps both patches and produces no representative patch.** When the
  judges disagree, both candidates stay on disk as recoverable artifacts. Read
  both and choose yourself.
- **A missing or untrusted test runner caps the result at `unverified`.**
- **An overly long state path blocks before execution.** The run ends as `blocked`
  before any worktree or artifact is created. Point `BOM_ORCH_HOME` at a shorter
  directory and call again.
- **Patches are not applied automatically.** You read the returned patch file,
  then you apply it yourself.
- **The disposable worktree is not an OS sandbox.** Worker-authored code and your
  repository's own test scripts run with your user privileges.

## Post-install check

Open a new host session and confirm all five `orch_*` tools above are present,
then call `orch_models`. Neither step spends model tokens. Call `orch_run` only
after both worker CLIs are authenticated.

## Where your data goes

The server executes on your machine from the bundled `dist/server.mjs`. Prompts
and results may be sent to the selected Claude or OpenAI CLI providers according
to each provider's own configuration and terms. Learning state is stored under the
user's profile `.bom-orch` directory by default, shared by both hosts so the
learning does not fork per host. No hosted Bom Orchestration service receives
prompts, results, or learning state.

## Upgrade and removal

Codex:

```powershell
codex plugin marketplace upgrade bom-orch-marketplace --json
codex plugin add bom-orch@bom-orch-marketplace --json
codex plugin remove bom-orch@bom-orch-marketplace --json
codex plugin marketplace remove bom-orch-marketplace --json
```

Claude Code:

```powershell
claude plugin marketplace update bom-orch-marketplace
claude plugin update bom-orch@bom-orch-marketplace --scope user
claude plugin uninstall bom-orch@bom-orch-marketplace --scope user
claude plugin marketplace remove bom-orch-marketplace --scope user
```

These commands manage a repository marketplace installation. This plugin is not
currently listed in an OpenAI or Anthropic official curated directory, and a
possible skills-only directory listing would not provide the local `orch_*` MCP
runtime.
