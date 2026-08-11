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

## Runtime and data handling

The repository publishes readable source plus a prebuilt, self-contained server bundle. Execution remains local on your machine. Prompts and results may be sent to the selected Claude or OpenAI CLI provider according to that provider's configuration and terms. Learning state is stored under the user's profile `.bom-orch` directory by default. No hosted Bom Orchestration service receives prompts, results, or learning state.

References to Desktop support mean the Codex surface in ChatGPT Desktop, and Desktop discovery/load must be verified against each release. Providing the core `orch_*` runtime in general ChatGPT Work would require a separate public HTTPS MCP/app package; this local stdio release does not support that surface. A possible skills-only official-directory listing would not be equivalent to the orchestration runtime.

This release supports installation from this repository marketplace. It is not a listing in an OpenAI or Anthropic official curated directory.
