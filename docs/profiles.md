# Profiles and role settings

Each role has four settings in a session: whether it is enabled, the backend a fresh run of it goes to, and the model and effort it runs with there. A **profile** is a named snapshot of all five roles' settings. Profiles are kept in one file shared by every project, and each session chooses one. You can change a session's settings with `/fusion config`, or edit the file and load the profile again.

## Commands

| Command | What it does |
| --- | --- |
| `/fusion config` | Shows this session's settings and opens the editor (see [The editor](#the-editor)). Without dialogs, it prints the table and the path of the profiles file. |
| `/fusion profile` | Opens a chooser that lists the saved profiles and `builtin`, and loads the one you pick. Without dialogs, it prints the list and the usage. |
| `/fusion profile list` | Lists the profiles. Marks the one this session uses, whether you have edited it since, and the one new sessions start with. |
| `/fusion profile use <name>` | Loads a saved profile into this session. |
| `/fusion profile use builtin` | Puts this session back on the built-in configuration. |
| `/fusion profile save <name>` | Saves this session's current settings under a name. If the name is taken, the profile is replaced, and the notice says `replaced`. |
| `/fusion profile default <name>` | Sets the profile future sessions start with. This session is not changed. |
| `/fusion profile default builtin` | Makes future sessions start on the built-in configuration again. |

A profile name starts with a letter or digit, uses only letters, digits, `.`, `_` and `-`, is at most 64 characters, and is case-sensitive. `builtin` is reserved: it names the built-in configuration, which is never stored as a profile, so it cannot be saved over.

There is no command to delete or rename a profile. Edit the file to do either.

Choosing a profile never turns Fusion on or off, and these commands still work while Fusion is off.

## When settings can be applied

`use`, `use builtin` and the editor's Apply change this session's settings. Each is refused while any run is unfinished, which is the same rule `/fusion off` follows. A run counts as unfinished while it is running, waiting for an answer, or finishing, and reviews count too. The refusal names the runs:

```
fusion settings stay as they are while runs are unfinished: run-3 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry.
```

The check runs once before a dialog opens. It runs again just before the settings change, after every dialog and file read. If a run started while the editor was open, nothing is applied. A refusal changes nothing, and it never cancels or waits for a run.

`list`, `save` and `default` work while runs are going. They don't change the settings this session runs with.

The host itself does not have to be idle. Applying settings updates the tools' descriptions and guidance at once, so the host's next response reads them. If that update fails, the settings are not applied and Fusion attempts to restore the previous guidance and active-tool list. A model request already in progress keeps the guidance it was sent with. A call the host made from older guidance is still checked against the current settings, so a disabled role is refused either way.

## The built-in configuration and the session's lifetime

The built-in configuration is the legacy behavior. Every role is enabled. `security` runs on `pi`, and every other role runs on `claude`. Models and efforts come from the [role variables](configuration.md), read once when the extension instance starts. `security` stays unconfigured until `PI_FUSION_PI_SECURITY_MODEL` names a model.

When an extension instance starts, it loads the default profile from the file. Starting Pi, `/new`, a reload, a resume and a fork each start a new instance. If there is no default profile, the session starts on `builtin`. If the file can't be read, isn't valid, or names a default it doesn't hold, the session also starts on `builtin`, and you get a warning once a notice can be shown. Nothing rewrites the file in that case.

A session's choice of profile, and any edits it makes, live in memory only, like whether Fusion is on. A new instance loads the default profile again.

Loading a profile copies its settings into the session. A later save from another session does not change this one, and neither does editing the file. External edits reach a session only when it loads a profile again; nothing watches the file. Changing the default affects only future sessions, and other running sessions keep what they have.

A saved profile is a snapshot. Its settings don't follow environment variables that change later. A Pi role saved with no model stays unconfigured.

## What a call runs on

A fresh run goes to the backend the call names. If the call names none, it goes to the backend the session's settings give the role. When that backend matches the role's setting, the call's own `model` and `effort` win, and the settings fill in whatever the call leaves out. A profile never falls back on an environment variable for a field it leaves out.

A call that names the other backend is a one-off override. It runs on that backend's legacy defaults, taken from the role variables when the instance started, and never on the model or effort set for the role's other backend. The compatibility `claude` tool works this way for a role whose setting is `pi`. Both tools' guidance recommends `fusion` for Pi-routed roles; `claude` remains an explicit Claude Code override.

A Pi role with no model is shown as `unconfigured`. A call to it is refused before anything starts, unless the call names a model. Nothing picks a model or a backend for you.

A disabled role is refused before a handle is taken, a child starts or a file is snapshotted. That holds for both `fusion` and `claude`, for continuations, and for calls that name their own backend, model or effort:

```
role ultracode is disabled in profile work; change /fusion config or select another profile
```

Disabling a role keeps both backends registered and leaves all four tools in place. The guidance stops recommending a disabled role and says that it is refused. `security` is still used only when you ask for it, even when it is enabled.

Continuations, plan handoffs and recorded settings follow [Runs, handles and background work](runs.md). A profile switch alone doesn't change what a recorded run continues on.

A review is a fresh `ask` run using this session's `ask` settings; see [Independent reviews](reviews.md).

## The editor

`/fusion config` shows the profile the settings came from, marked `(modified)` once you have edited them in this session, and a table of the roles:

```
role       enabled  backend  model                   effort
plan       yes      claude   fable                   xhigh
implement  yes      pi       deepseek/deepseek-chat  high
ultracode  no       claude   fable                   ultracode (fixed)
ask        yes      claude   opus                    high
security   yes      pi       unconfigured            child default
```

Pick a role to change these settings:

- **enabled:** switch the role on or off.
- **backend:** only for a role that runs on both backends.
- **model:** for Pi, pick one of the models the host already has credentials for, type a `provider/model-id`, or choose Unconfigured. For Claude, type an alias or id.
- **effort:** pick one of that backend's levels. A Pi role can also go back to the child's own default. `ultracode`'s effort is always `ultracode` and can't be edited, but its main model can. That model is not the model of the workflow agents its contract names.

Changing a role's backend replaces its model and effort with that backend's legacy defaults. The old backend's values are not carried over.

Every change is kept in a draft. **Apply** checks the whole draft and applies it to the session in one step. **Cancel**, or closing the dialog, leaves everything as it was. Apply never writes the profiles file; use `/fusion profile save <name>` to keep the settings.

The Pi model list is the host's own list of available models. Showing it fetches nothing, authenticates nothing and doesn't switch the host's model. A Pi child resolves its model against Fusion's own catalog, so a model in the list can still be one a child refuses when it starts.

## The profiles file

Profiles live in `<agent dir>/pi-fusion/profiles.json`. The agent directory is the one Pi resolves: `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. `/fusion config` shows the path.

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

`defaultProfile: null` means `builtin`. Each profile names all five roles, and each role has these fields:

- **`enabled` and `backend`:** always present.
- **`model`:** a Claude alias or id, or a Pi `provider/model-id` split at the first slash. The id may itself contain slashes, as `openrouter/deepseek/deepseek-chat` does.
- **`effort`:** a level the backend has:
  - `low`, `medium`, `high`, `xhigh` or `max` on `claude`;
  - `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` on `pi`;
  - for `ultracode`, either `ultracode` or left out.

An enabled Claude role needs a model, and every enabled Claude role except `ultracode` needs an effort. A disabled role needs neither, but any field it does supply is still checked. `ultracode` runs on `claude` only, and `security` on `pi` only.

The file is refused as a whole if it has:

- an unknown version, role or field;
- a malformed name;
- a value that is not a boolean where one is expected;
- a backend, role and effort that don't go together.

Profiles are checked locally only. Loading, editing or saving one never starts a child and never asks a provider whether a model exists.

The file holds no credentials, and Fusion copies none into it.

### How the file is written

Reading a missing file gives an empty set of profiles and creates nothing. Only a save or a default change creates the directory and the file. The directory is the Fusion-owned `pi-fusion` directory, created with mode `0700` through the same check the Pi backend uses for it, and the file is written with mode `0600`.

A write rereads the file and changes only the profile or default it was asked to change. It writes a temporary file beside the original and renames it over the original, so a reader never sees a half-written file. That is not a guarantee against power loss. A write that fails leaves the old file as it was and removes the temporary file it made. A file that can't be read or isn't valid is never overwritten as a side effect: the command says what is wrong, and the file is left for you to fix.

Writes from one Pi process are queued and each rereads the latest file, so they never lose each other's changes. Nothing coordinates separate Pi processes, or a person editing the file, with each other. Two saves at the same moment from different processes can each read the same file, and the last rename wins. There is no lock and nothing to recover.
