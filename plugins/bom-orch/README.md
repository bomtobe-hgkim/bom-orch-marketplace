# Bom Orchestration

### Two AI CLIs. One writes. The other has to prove it.

Bom Orchestration runs locally as an MCP server. It delegates a coding task to one
vendor's CLI inside a disposable git worktree, runs your repository's **own** test
suite itself, hands the result to a **different vendor** for read-only review, and
grades the outcome on machine evidence rather than a model's prose report.

When it cannot prove the change works, it says `unverified` and tells you why.

**Requirements:** Node.js 22.11 or newer, with `claude`, `codex`, and `git` on the
host application's `PATH`. Authenticate both worker CLIs before calling `orch_run`.

## The eight tools

| Tool | What it does |
|---|---|
| `orch_run` | Delegates a task, cross-checks it with the other vendor, returns a patch file and a structured outcome |
| `orch_models` | Lists installed vendors, versions, and available model choices |
| `orch_config` | Reads or updates the model and effort behind each tier |
| `orch_stats` | Read-only learning statistics: a compact summary by default, raw alpha/beta with `view:full`, plus optional recent runs |
| `orch_status` | Reads one finished run back off disk, or lists the recent runs when called with no arguments |
| `orch_apply` | Applies a finished run's patch to your repository — the explicit step `orch_run` never takes on its own |
| `orch_reward` | Human correction of a past run's automatic grade. Idempotent |
| `orch_reset` | Clears learned posteriors only when called with `confirm:true`; optionally narrowed by task class |

Argument tables and the full result contract ship with this plugin as skills, which
both hosts read.

## Before you rely on a result

This comes before the usage instructions on purpose. A tool that promises not to
claim success it cannot prove should lead with the cases where it stops.

- **Structured verifier, not prose.** The verifier returns structured JSON checks
  and issues. Callers that treated a prose approval as a pass need to be updated.
- **`candidates: 2` roughly doubles cost.** Two lanes each author, each
  cross-verify, and each run their own regression evidence.
- **Regression proof multiplies the test runs.** A run that must prove a regression
  runs your whole test suite up to six times in series per candidate per attempt,
  against two for a run that needs no proof — 22 at the default `budget: 5`, 42 with
  `candidates: 2`. `cost.testRuns` reports what it actually took, and preflight warns
  before any credit is spent when those runs cannot fit inside `wait_ms`.
- **One shared deadline.** `wait_ms` bounds the whole run, not each lane. After
  that shared deadline passes, no new provider, test, or judge call starts.
- **A `tie` keeps both patches and produces no representative patch.** When the
  judges disagree, both candidates stay on disk as recoverable artifacts. Read
  both and choose yourself.
- **A missing test runner caps the result at `unverified`.** A runner whose
  evidence cannot say which test covers which file still lets ordinary work reach
  `verified`; only a run that needs regression proof stops at `unverified`.
- **An overly long state path blocks before execution.** The run ends as `blocked`
  before any worktree or artifact is created. Point `BOM_ORCH_HOME` at a shorter
  directory and call again.
- **Patches are not applied automatically.** You read the returned patch file,
  then you apply it yourself — with `git apply`, or by calling `orch_apply` with
  that run's `run_id`.
- **The run baseline and apply-time HEAD are separate facts.** A clean start may reuse the starting HEAD.
  When uncommitted work is transplanted, the baseline becomes a server-created synthetic snapshot. An explicit `orch_apply` first checks the
  target working tree as it stands; only when direct application does not fit may it use that baseline
  for a verified three-way onto the target's current committed HEAD. A full apply report distinguishes
  `baseline`, `head`, and `repository.dirty`. Scope approval comes only from `scope.allow` in the committed
  `.bom-orch.json` at that HEAD; the earlier call's `scope_allow` is not retained. If the final pre-write
  recheck sees a HEAD move, it returns `apply_head_moved` without applying; that check and `git apply` are separate processes: avoid concurrent
  repository changes, and follow the failure envelope's top-level `recovery` for the next safe action.
- **The disposable worktree is not an OS sandbox.** Worker-authored code and your
  repository's own test scripts run with your user privileges.

## Post-install check

Open a new host session and confirm all eight `orch_*` tools above are present,
then call `orch_models`. Neither step spends model tokens. Call `orch_run` only
after both worker CLIs are authenticated.

## Troubleshooting

**The tools do not appear, and nothing reported an error.** Start here, because this
failure is silent by design rather than by accident. Codex does not substitute
`${CLAUDE_PLUGIN_ROOT}` anywhere in an MCP server entry — not in `command`, not in
`args`, not in `env`; that variable reaches lifecycle hooks only. A configuration
written for Claude Code therefore tries to use the literal string as a path, the
server never starts, and the host shows no error at all — only a plugin that is not
there. This plugin ships a separate MCP configuration per host for that reason.
Install from the marketplace instead of copying one host's entry into the other, and
check what the host registered with `claude mcp get plugin:bom-orch:bom-orch` or
`codex mcp list --json`.

**The plugin is installed but the server exits at once.** This server refuses to start
below Node.js 22.11 and writes `bom-orch requires Node.js 22.11 or newer` to stderr
before exiting with a non-zero code. A host that does not surface a plugin's stderr
turns that into the same symptom as above: no tools, no message.

**A run is refused before anything happens.** That is intended, and it spends no
credit. `preflight_no_provider_available` means neither vendor CLI answered;
`preflight_cross_vendor_unavailable` means only one is available and cross-vendor
verification needs two, unless you pass `allow_single` to accept a one-vendor run;
`preflight_gateway_env_unsupported` means the shell that started this server turns on
`CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX`. Every reason code, with the
same meaning and recovery sentence the envelope carries, is in `REASON_CODES.md`.

Questions and defects belong at
<https://github.com/bomtobe-hgkim/bom-orch-marketplace/issues>.

## Where your data goes

The server executes on your machine from the bundled `dist/server.mjs`. Prompts
and results may be sent to the selected Claude or OpenAI CLI providers according
to each provider's own configuration and terms. Learning state is stored under the
user's profile `.bom-orch` directory by default, shared by both hosts so the
learning does not fork per host. No hosted Bom Orchestration service receives
prompts, results, or learning state.

**Retention and manual cleanup.** The default state root is `~/.bom-orch` (or the exact absolute `BOM_ORCH_HOME` you set).
Patches, run records, and logs expire after 30 days; disposable scratch rooms after 6 hours; `effect_unknown` worktrees after 30 days; and the private npm cache after 30 idle days.
Apply-recovery and manually retained scratch rooms are kept indefinitely until manual cleanup. The learning journal is append-only and has no automatic retention deletion.
Retention cleanup is not a background service: it runs only when this MCP server starts or handles a run. Uninstalling either host/plugin does not delete this state.
To remove it safely, stop both Claude and Codex hosts, uninstall the plugin from both if applicable, and verify the exact state-root path. For the default root, use PowerShell: `Remove-Item -LiteralPath (Join-Path $env:USERPROFILE '.bom-orch') -Recurse -Force`. On POSIX: `rm -rf -- "$HOME/.bom-orch"`. If `BOM_ORCH_HOME` is set, substitute the exact absolute state root you verified instead of the default path.
Linux orphan cleanup identifies a process with the kernel boot ID plus `/proc` start ticks, and Windows uses process start ticks. On macOS, the process start identity reported by ps has one-second resolution; an extremely fast same-second PID reuse remains a documented residual, while any missing or malformed identity fails closed without killing or deleting anything.

**Dependencies are never installed unless the repository asks for it.** Set
`tests.provisionDeps` to `lockfile-install` in `.bom-orch.json` and the server
runs the lockfile install from the baseline commit, with lifecycle scripts
disabled, into the disposable worktree before any model writes a line; leave it
at the default `none` and no package manager is ever started. When it is on, the
package cache it uses lives at `cache/npm` under the state root, so your global
npm cache is neither read nor written and nothing lands outside `BOM_ORCH_HOME`.

**Vendor gateway deployments are not supported.** If the shell that starts this
server turns on `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` — any value
other than `0`, `false`, `no` or `off`, which are read as an explicit "not a
gateway" and let the run through — the run is refused before any vendor process starts,
with the reason code `preflight_gateway_env_unsupported`. The isolated environment
this server builds for a delegate drops those switches along with the credentials beside them,
so the delegate would fall back to subscription login and fail only after the run
had already spent time and credit. Unset them, or start the server from a shell
without them. Passing them through to the delegate would give that child a cloud
identity of its own, and this project has no environment in which it can verify
that the result actually works, so it refuses instead of guessing.

## Upgrade and removal

Version 0.2.2 predates the shared-state schema and fencing in this release. To keep one
`BOM_ORCH_HOME`, stop both Claude and Codex hosts, upgrade both, and only then restart them.
Do not restart or roll back a 0.2.2 host after either upgraded host has published the new schema.
Version-skew safety begins between schema-aware releases; an older schema-aware host falls back
to read-only access when it sees a newer schema.
Both host applications must run on the same machine and `BOM_ORCH_HOME` must be on its local
filesystem. Do not put it on a network share or use one state root from different machines;
remote process identity and distributed-filesystem locking are not supported.

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
