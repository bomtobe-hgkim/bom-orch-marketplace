---
name: orch-model
description: Read or change which vendor, model and effort this orchestration uses.
---

# Model settings

`orch_models` reports which vendor CLIs are installed and which models each one offers.
`orch_config` reads or changes which of them this orchestration uses. Every failure code these two
tools can report is listed, with its recovery line, in `REASON_CODES.md` at the plugin root.

★ **Model names are deliberately absent from this document.** Written down they rot before the code
does, and a model that reads them picks a name that no longer exists. Take the list from `orch_models`.

## Arguments

| Tool | Argument | Required | Default | Allowed |
| --- | --- | --- | --- | --- |
| `orch_models` | `refresh` | optional | `false` | — |
| `orch_config` | `vendor` | optional | — | `claude`, `codex` |
| `orch_config` | `tier` | optional | — | `strong`, `fast` |
| `orch_config` | `model` | optional | — | — |
| `orch_config` | `effort` | optional | — | — |
| `orch_config` | `writer` | optional | — | `claude`, `codex`, `` |
| `orch_config` | `learning` | optional | — | `on`, `off`, `` |

## What `orch_models` reports for one vendor

| Field | Meaning |
| --- | --- |
| `reachable` | whether this vendor's CLI answered at all |
| `probed` | whether this call launched the CLI. `false` means the answer came from the catalog, or that the probe could not be attempted |
| `version` | the version string the probe read, or `null`. Probed and reachable answers only |
| `models` | that vendor's model list, each entry with the efforts it takes. Reachable answers only |
| `cached` | present, and `true`, only when the answer came from the catalog instead of a probe |
| `fetchedAt` | when that cached list was fetched. Cached answers only |
| `error` | why the vendor could not be reached |
| `recovery` | what to do about that |
| `discoveryTimeout` | present, and `true`, only when the probe ran out of time |

## What `orch_config` reports

| Field | Meaning |
| --- | --- |
| `current` | the settings in force: `writer` and `learning`, then per vendor each tier's model and that tier's effort |
| `vendors` | what you may choose, per vendor: the catalog's `models` and its `fetchedAt` |

## Reading

Call `orch_config` with no arguments and it reports the current settings next to the values you may
choose. It launches no CLI: the current settings come from the settings file, and the values you may
choose come from the catalog `orch_models` left behind. A read that got the settings file whole
answers `verified`; one that could not read it in full answers `unverified`.

`orch_models` answers `verified` only when this call actually probed the CLIs. An answer served
from the catalog cache is `unverified` and says so in a notice — pass `refresh: true` to force a probe.

## Changing — `vendor` and `tier` travel together

Pass `vendor` and `tier` along with `model` or `effort`. All four read `optional` above only because
the reading call takes no arguments; a change needs `vendor` **and** `tier`, and missing either makes
the call `invalid`, with the refusal naming the values you may use. `vendor` is needed because the
settings file's sections are vendor ids and models differ by vendor: `tier` alone cannot say where.

Passing `vendor` and `tier` with neither `model` nor `effort` is `invalid` too — a silent no-op would
be worse. An empty-string `model` or `effort`, by contrast, **clears** that value and returns the
vendor and tier to the CLI's own default. A write is `verified` when the re-read matches what was
written, `unverified` otherwise.

## What is refused and what is not

- **A model name outside the discovered list is not refused.** It is stored, with a notice that it is
  not in the list found so far. Refusing would be worse: the `claude` vendor's discovery list carries
  aliases only and filters the formal ids out on purpose, so a user who typed a formal id would be
  locked out of it forever. Read the notice as a prompt to check your spelling.
- **An `effort` the listed model does not support is refused**, the settings file is not touched
  by one byte, and the refusal names the values that model does support.
- For a vendor whose list has not been fetched yet, the effort check is skipped entirely. Call
  `orch_models` first and the list fills in.

## Editing the settings file by hand

Settings live in settings.ini under the state root, `~/.bom-orch/` unless `BOM_ORCH_HOME` says
otherwise, and may be edited by hand. Section names are vendor ids and keys are tier names.

★ **Never write a `;` or `#` note after a value — the note becomes part of the value.** This parser takes
everything after `=`, trims surrounding whitespace and stores what is left, so the whole sentence becomes
the model name handed to the CLI as its model argument. There is an asymmetry: a note after a **section
header** is handled, a note after a value is not — write notes as whole lines beginning with `;`.

## Example envelope

`orch_config` called with no arguments on a state root whose catalog is still empty.

```json
{
  "status": "succeeded",
  "content": "{\"current\":{\"claude\":{\"strong\":null,\"strongEffort\":null,\"fast\":null,\"fastEffort\":null},\"codex\":{\"strong\":null,\"strongEffort\":null,\"fast\":null,\"fastEffort\":null}},\"vendors\":{\"claude\":{\"models\":[],\"fetchedAt\":null},\"codex\":{\"models\":[],\"fetchedAt\":null}}}",
  "confidence": "verified",
  "notice": "The model list for claude, codex is empty; call orch_models first to fill the catalog, and vendors without a list skip the effort check"
}
```
