---
description: Read or change this orchestration's model settings
argument-hint: "[vendor] [tier] [model]"
---

Follow the orch-model skill to handle the model settings. Arguments: $ARGUMENTS

With no arguments, call `orch_config` with no arguments and show the current settings. A call
that changes a value needs both a `vendor` and a `tier`; every other rule lives in the
orch-model skill and this command deliberately repeats none of them. Codex reads skills but
never reads `commands/`, so anything written only here would be invisible to Codex users.

The command is `/orch-setup` while the skill stays orch-model on purpose: a command and a skill
that share a name collapse into one row in the Claude Code listing and the command description
wins, which is how the orch-model skill's own description went missing for a release.
