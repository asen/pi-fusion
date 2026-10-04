# Profiles and role settings

Each role has an enabled setting, backend, model, and effort. A **profile** is a named snapshot of all five roles, stored globally and copied into a session. Use `/fusion config` to edit the session; saving a profile is a separate action.

## Commands

| Command | Effect |
| --- | --- |
| `/fusion config` | Show settings and open the editor; without dialogs, print the table and file path |
| `/fusion profile` | Choose a saved profile or `builtin`; without dialogs, print list/usage |
| `/fusion profile list` | List profiles, current choice/modified state, and startup default |
| `/fusion profile use <name>` | Load a snapshot into this session |
| `/fusion profile use builtin` | Restore captured built-in settings |
| `/fusion profile save <name>` | Save current settings; replace an existing name with a notice |
| `/fusion profile default <name>` | Choose the default for future instances, not this session |
| `/fusion profile default builtin` | Restore built-in startup defaults |

Names are case-sensitive, at most 64 characters, begin with a letter/digit, and contain only letters/digits, `.`, `_`, and `-`. `builtin` is reserved and cannot be saved over. There is no delete/rename command; edit the file manually.

These commands work while Fusion is off and never change its mode. [Activation](fusion-command.md#turning-fusion-on-and-off) and role configuration are separate.

## When settings can be applied

Applying through `use`, `use builtin`, or the editor is refused while any run is **unfinished**: running, waiting, or finishing its entry/report, reviews included. It cancels/waits for nothing and names the handles to wait for or cancel before retrying.

The guard runs before opening a dialog and again after all dialog/file awaits, just before synchronous application. If work started while the editor was open, nothing applies. `list`, `save`, and `default` can run during work because they do not alter this session's settings.

Applying refreshes tool descriptions/guidance for the host's next response while preserving active tools, including unrelated inactive tools and Fusion's hidden tools while off. If refresh fails, settings roll back and Fusion **attempts** to restore previous guidance and the entire active list; persistent host failures cannot be promised recoverable. A model request already in flight keeps its earlier guidance, but its subsequent calls are checked against current settings.

## The built-in configuration and the session's lifetime

Builtin enables every role except **security**. Other roles default to Claude; security is assigned to Pi but must be enabled through settings or a saved profile. `PI_FUSION_PI_SECURITY_MODEL` supplies its model, not activation. Saved profiles—including older ones—keep their own enabled settings.

Models/efforts come from [role variables](configuration.md), captured once per instance. A default saved profile replaces them at startup. Missing default means `builtin`; unreadable/invalid files or absent named defaults also use `builtin` with a warning, leaving the file untouched.

Starting Pi, `/new`, reload, resume, or fork loads instance defaults again. Current profile choice, edits, and Fusion mode are in memory only. A loaded snapshot never follows another session's saves, later environment changes, or external file edits. Reload a profile to read edits; setting a default changes only future instances. A Pi role saved without a model stays unconfigured.

## What a call runs on

```text
fresh run
  call backend, otherwise role's configured backend
    matching backend -> call model/effort, otherwise role settings
    other backend    -> call model/effort, otherwise captured legacy defaults

continuation
  recorded backend -> call overrides, otherwise recorded selection
  enabled setting still applies
```

Profiles do not fill omitted configured fields from variables. An explicit other-backend call is a one-off override, not a profile change. `claude` uses that override when a role is configured on Pi; both tools' guidance recommends `fusion` for Pi roles unless you explicitly request Claude Code.

Pi with no model is shown as `unconfigured` and refuses before admission unless the call supplies one. A disabled role also refuses before any handle, child, or file snapshot, for new calls **and continuations**, despite explicit backend/model/effort parameters. Disabling a role unregisters neither backend and removes no workflow tool. Enabled security still requires an explicit user security request in host guidance.

Recorded settings, plan handoffs, and refusal recovery are described in [Runs](runs.md). Independent review always uses a fresh configured `ask` run; disabled `ask` means no reviewer.

## The editor

Example session table:

```text
role       enabled  backend  model                   effort
plan       yes      claude   fable                   xhigh
implement  yes      pi       deepseek/deepseek-chat  high
ultracode  no       claude   fable                   ultracode (fixed)
ask        yes      claude   opus                    high
security   no       pi       unconfigured            child default
```

Pick a role to change:

- **Enabled:** switch it on/off.
- **Backend:** only when the role supports both. Switching replaces model/effort with that backend's captured legacy defaults, not the previous backend's values.
- **Model:** for Claude, type an alias/id; for Pi, choose a host-available model, type `provider/model-id`, or select Unconfigured.
- **Effort:** select the backend's level, or Pi's child default. Ultracode effort is fixed, but its main model can change in settings; that is not its workflow agents' model.

Edits stay in a draft. **Apply** validates/applies the whole draft; **Cancel** or dialog close changes nothing. The current profile is marked `(modified)` after edits. Apply writes no profile file; use `save` to persist.

The Pi picker reads the host's available-model list without fetching/authenticating or changing the host model. Children resolve against their own Fusion catalog/resources, so a picker entry is not proof the child can use it.

## The profiles file

`<agent dir>/pi-fusion/profiles.json`, with agent dir resolved by Pi (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`). `/fusion config` prints its path.

```json
{
  "version": 1,
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "roles": {
        "plan": { "enabled": true, "backend": "claude", "model": "fable", "effort": "xhigh" },
        "implement": { "enabled": true, "backend": "claude", "model": "opus", "effort": "high" },
        "ultracode": { "enabled": false, "backend": "claude", "model": "fable" },
        "ask": { "enabled": true, "backend": "claude", "model": "opus", "effort": "high" },
        "security": { "enabled": false, "backend": "pi" }
      }
    }
  }
}
```

`defaultProfile: null` means builtin. Every profile names all five roles. Fields:

| Field | Rule |
| --- | --- |
| `enabled`, `backend` | Required boolean/backend name; role/backend capabilities must match |
| `model` | Claude alias/id, or Pi provider/id split at the first slash (the id may contain more slashes) |
| `effort` | Claude `low`, `medium`, `high`, `xhigh`, `max`; Pi also `off`, `minimal`; ultracode fixed `ultracode` or omitted |

An enabled Claude role needs a model and, except ultracode, an effort. Disabled roles need neither, but supplied fields are still validated. Pi can be enabled yet unconfigured; a later call must supply its missing model. Ultracode is Claude-only and security Pi-only.

Unknown versions/roles/fields, invalid names/types, or incompatible role/backend/effort combinations refuse the **whole file**. Validation is local; editing/loading/saving never starts a child or asks a provider whether the model exists. No credentials are copied into profiles.

### How the file is written

A missing file reads as empty and creates nothing. Save/default changes create the Fusion-owned directory (`0700`) and file (`0600`) where platform modes apply. Each write rereads current contents, changes only the requested profile/default, and replaces through a private neighboring temporary file plus rename. Readers avoid half-written files; this is not a power-loss durability guarantee. A failed write leaves the old file and removes its temporary file. Invalid/unreadable data is never silently overwritten.

Writes on the same path are queued within one process. Separate Pi processes and manual edits have **no lock**: overlapping read/modify/rename operations can lose a change, and the last rename wins. Nothing watches the file or recovers a competing write.
