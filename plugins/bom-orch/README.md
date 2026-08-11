# Bom Orchestration

Bom Orchestration runs locally as an MCP server and coordinates authenticated Claude and OpenAI CLI workers. It requires Node.js 20.10 or newer and `codex`, `claude`, and `git` on the host application's `PATH`. Authenticate both worker CLIs before calling `orch_run`.

## Tools

- `orch_run` delegates a task to selected workers, cross-checks their results, and returns a structured outcome.
- `orch_models` lists the currently available providers and model choices.
- `orch_config` reads or updates orchestration defaults.
- `orch_stats` reports execution and learning statistics.
- `orch_reward` records human reward feedback for a completed run.

## Post-install check

After installation, open a new host session and ask it to list the Bom Orchestration tools. Confirm that all five `orch_*` tools above are present, then call `orch_models`. Call `orch_run` only after both worker CLIs are authenticated.

The server executes on your machine from the bundled `dist/server.mjs`. Prompts and results may be sent to the selected Claude or OpenAI CLI providers. Learning state is stored under the user's profile `.bom-orch` directory by default, and no hosted Bom Orchestration service receives it.

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

These commands manage a repository marketplace installation. This plugin is not currently listed in an OpenAI or Anthropic official curated directory, and a possible skills-only directory listing would not provide the local `orch_*` MCP runtime.
