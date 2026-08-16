# Bom Orchestration marketplace

Bom Orchestration is a local MCP server that delegates work to Claude and OpenAI CLI workers, cross-checks their results, and learns from reward feedback. This release is distributed through a repository marketplace with separate Codex and Claude Code packages.

## Prerequisites

- Node.js 20.10+.
- `codex`, `claude`, and `git` available on the host application's `PATH`.
- Both worker CLIs authenticated before using `orch_run`.

## Install

Codex:

```powershell
codex plugin marketplace add bomtobe-hgkim/bom-orch-marketplace
codex plugin add bom-orch@bom-orch-marketplace
```

Verify, upgrade, or remove the Codex installation:

```powershell
codex plugin marketplace list --json
codex plugin list --json
codex plugin marketplace upgrade bom-orch-marketplace --json
codex plugin add bom-orch@bom-orch-marketplace --json
codex plugin remove bom-orch@bom-orch-marketplace --json
codex plugin marketplace remove bom-orch-marketplace --json
```

Claude Code on PowerShell:

```powershell
$env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS = '1'
claude plugin marketplace add bomtobe-hgkim/bom-orch-marketplace
claude plugin install bom-orch@bom-orch-marketplace
```

Verify, update, or remove the Claude Code installation:

```powershell
claude plugin marketplace list --json
claude plugin list --json
claude plugin details bom-orch@bom-orch-marketplace
claude plugin marketplace update bom-orch-marketplace
claude plugin update bom-orch@bom-orch-marketplace --scope user
claude plugin uninstall bom-orch@bom-orch-marketplace --scope user
claude plugin marketplace remove bom-orch-marketplace --scope user
```

Claude's GitHub shorthand otherwise prefers SSH. The environment setting forces HTTPS for users who do not have GitHub SSH keys. In Bash or Zsh, the equivalent one-command form is:

```bash
CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1 claude plugin marketplace add bomtobe-hgkim/bom-orch-marketplace
```

Automation that may already configure this variable should preserve the existing value. For example, use `if (-not $env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS) { $env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS = '1' }` in PowerShell or `: "${CLAUDE_CODE_PLUGIN_PREFER_HTTPS:=1}"` in Bash/Zsh before invoking Claude.

## What `orch_run` promises, and what it does not

`orch_run` decides an outcome from a structured verifier verdict and revision-bound machine
evidence, not from a worker's prose report. Opt in to `candidates: 2` to compete two
independent candidates. Read these eight limits before you rely on a result.

- **Structured verifier migration.** The verifier now returns structured JSON checks and
  issues. Callers that treated a prose approval as a pass need to be updated.
- **`candidates: 2` roughly doubles cost.** Two lanes each author, each cross-verify, and each
  run their own regression evidence, so provider, writer, and test calls all roughly double.
- **One shared deadline.** `wait_ms` bounds the whole run, not each lane. After it passes no
  new provider, test, or judge call starts.
- **A `tie` has no representative patch.** When the judges disagree, both candidate patches
  stay on disk as recoverable artifacts and no top-level patch is produced. Read both and
  choose yourself.
- **Missing or untrusted tests cap confidence at `unverified`.** If no test command was found,
  or the runner cannot prove which test covers which changed file, the envelope stops there.
- **Overly long state or artifact paths block before execution.** A state root deep enough to
  overflow the response budget ends as `blocked` before any worktree or artifact is created.
  Point `BOM_ORCH_HOME` at a shorter directory and call again.
- **Patches are not applied automatically.** The result is a patch file path; you apply it
  with `git apply` after reading it.
- **A disposable worktree is not an OS sandbox.** Worker-authored code and the repository's
  own test scripts run with your user privileges. Do not point this at a repository you do
  not trust.

## Runtime and data handling

The repository publishes readable source plus a prebuilt, self-contained server bundle. Execution remains local on your machine. Prompts and results may be sent to the selected Claude or OpenAI CLI provider according to that provider's configuration and terms. Learning state is stored under the user's profile `.bom-orch` directory by default. No hosted Bom Orchestration service receives prompts, results, or learning state.

References to Desktop support mean the Codex surface in ChatGPT Desktop, and Desktop discovery/load must be verified against each release. Providing the core `orch_*` runtime in general ChatGPT Work would require a separate public HTTPS MCP/app package; this local stdio release does not support that surface. A possible skills-only official-directory listing would not be equivalent to the orchestration runtime.

This release supports installation from this repository marketplace. It is not a listing in an OpenAI or Anthropic official curated directory.
