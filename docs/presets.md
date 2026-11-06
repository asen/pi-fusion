# Instruction presets

A **preset** chooses where one Fusion instance loads its instructions from: the [host policy](configuration.md#the-host-policy-file) and the six [role contracts](configuration.md#role-contract-overrides). It is chosen once, when the instance starts, and applies until `/reload`, a restart or a new or resumed session. It is not a [profile](profiles.md): a profile chooses role models and settings; a preset chooses instructions, and with them [role availability and built-in defaults](configuration.md#role-availability-and-defaults). A saved profile can still override a preset's model defaults, never its availability.

## The five presets

| Preset | Host policy and role contracts come from |
| --- | --- |
| `builtin` | This build's `contracts/` only |
| `architect` | This build's bundled `presets/architect/` only: complete, nothing borrowed from builtin |
| `user` | `<agent dir>/pi-fusion/`, a missing file falling back to builtin; no project file |
| `project` | Trusted `<cwd>/.pi/pi-fusion/`, a missing file falling back to builtin; no user file |
| `auto` | Trusted project, then user, then builtin, per file: the behavior without presets |

The names are fixed. There is no preset registry, inheritance, download or custom preset name. A selected preset reads only its own sources: under `builtin` or `architect` a broken user or project file cannot affect anything, and `user` never reads a project file. Inside a selected scope, the usual rules hold: a missing file falls back to builtin, an unusable role override [closes its role](configuration.md#unusable-role-overrides) and an unusable `host.md` falls back with a warning. Builtin's own files are validated first whatever the selection, and an unusable bundled `architect` file fails startup rather than switching preset.

`project` always means the startup working directory's `.pi/pi-fusion/`, not a directory recorded when it was chosen, and it needs Pi to report that directory as trusted. Without trust, a selection of `project` refuses at startup rather than becoming builtin; delegation is refused and the preset commands still work.

## How a startup selects

```text
this session's branch entry (latest wins)   -> use it
  else trusted <cwd>/.pi/pi-fusion/preset.json -> use its default
  else <agent dir>/pi-fusion/preset.json       -> use its default
  else auto
```

The first that names a preset decides alone; lower ones are not read. A default selects one source, not an extra layer. A default file is small JSON, the same at both paths:

```json
{ "version": 1, "defaultPreset": "architect" }
```

`defaultPreset` is one of the five names; `null`, an omitted field or a missing file means the file selects nothing and the next source decides. The `/fusion preset default` commands write it; editing it by hand works the same way. An unusable latest session entry or a present but unusable default file (invalid JSON, unknown field or name, newer version, unreadable, a dangling link) refuses startup instead of choosing another workflow; its diagnostic names the file, never its contents.

The startup reads the branch's choice before anything else, so a preset command issued while it loads changes only the next startup.

## Commands

| Command | Effect |
| --- | --- |
| `/fusion preset` or `/fusion preset list` | Show the active preset and what selected it, this branch's choice, what the next startup of this session would select, and both default files; reads only. Unlike a startup, it reads both files (the project one only with trust) to show their values and diagnostics, and applies neither. `/fusion config` and its editor show the same lines |
| `/fusion preset use <name>` | Record this session's choice for its next startup |
| `/fusion preset reset` | Clear this session's choice, so the defaults decide at the next startup |
| `/fusion preset default user <name>\|clear` | Set or clear the user default for new instances |
| `/fusion preset default project <name>\|clear` | Set or clear the trusted project default for new instances; refused without trust |

All of them work with Fusion off and after a failed startup; none changes this instance's instructions, guidance, mode or role settings, or reloads anything. `use` and `reset` append one `pi-fusion-preset` entry to the session branch and are refused while a run is unfinished (running, waiting or finishing) or the instance is shutting down. `use` checks nothing but the name: it reads no contract and starts no child. Default writes rewrite the file atomically and privately, refuse an unusable file, and need no idle session because they affect only later instances. Only these commands create a `preset.json` or the project's `.pi/pi-fusion/` directory; startup and `list` never do.

## Lifecycle

- The choice lives on the session branch, so it survives `/reload` and resuming the session and leaves other sessions alone. `/new` starts without it; `/fork` and `/clone` carry the branch they copy.
- `/tree` moves the choice with the branch for the next startup only. Active instructions never change until a reload.
- After a reload, Fusion is off again and the default profile loads, as always. Continuations keep their recorded backend and model but run under the instructions this instance loaded.

### Recovering from a refused startup

| Cause | Recovery |
| --- | --- |
| Unusable session entry | `/fusion preset reset` or `/fusion preset use <name>`, then `/reload` |
| Unusable default file | `/fusion preset use builtin` (or another explicit preset), then `/reload`; or fix or remove the file. `reset` alone does not help: it hands the choice back to the defaults |
| `project` without trust | Trust the project, or choose another preset, then `/reload` |

## The architect preset

`presets/architect/` is a bundled copy of an Architect workflow: the host plans and reviews, handles clear, low-risk, self-contained tasks directly, and delegates substantive implementation; `implement` critiques and implements under explicit `PLAN_REVIEW`/`IMPLEMENT` phases with live escalation; `ask` is external web research only, and its review mode declines. `plan`, `ultracode` and `security` are unavailable. Its built-in defaults pin `implement` to Claude `opus[1m]` at `high` and `ask` to Codex `gpt-6.1-sol` at `high`; a saved profile can change those models. Whether the configured `ask` child can actually search the web is not verified by Fusion; the policy tells the host to report a missing capability rather than substitute repository work.

Selecting `architect` bypasses every user and project instruction file. A project's own `.pi/pi-fusion/` set, such as a customized Architect copy, stays selectable through `project` or `auto`.
