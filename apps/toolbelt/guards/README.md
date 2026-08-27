# guards

A standalone Claude Code `PreToolUse` security hook: blocks reads/writes of
secret-shaped files, blocks direct writes to a protected path list, and
enforces per-repo "cell" path ownership declared in `config.<profile>.json`.

Extracted from `agentic-command-center`'s guard system so it can be used
independently of any particular control-panel/runner. This module has no
dependency on ACC or any other caller — it only needs a hook payload on
stdin and a config file.

## Files

- `guard.mjs` — the hook itself. `decide(payload, config)` is the pure rule
  set (exported for tests); the rest of the file is an I/O wrapper that only
  runs when this file is the process entry point (`node guard.mjs`, exactly
  how Claude Code invokes a hook).
- `cli.mjs` — mutates the config: `status`, `toggle on|off`,
  `secret-add/rm <glob>` (base `config.json`), `protected-add/rm <path>`
  (the resolved overlay). A caller (e.g. a web control panel) shells this for
  every guard-config change; `guard.mjs` itself never writes its config.
- `config.json` — the tracked base config: `enabled` and `secrets`, the
  parts that don't vary by machine.
- `config.<profile>.json` — a local, ignored per-machine overlay carrying the
  machine-varying parts (`runboxDir`, `protected`, `repos`). Copy its shape
  from `config.example.json`, fill in local values, and do not commit it.
- `config-loader.mjs` — shared by `guard.mjs` and `cli.mjs`: resolves and
  shallow-merges the base + overlay pair described below.

## Configuration

Both files resolve their config the same way (`config-loader.mjs`):

1. `GUARDS_CONFIG` environment variable, if set — an absolute pointer to one
   fully-resolved config file, bypassing everything below exactly as before
   this module had a profile concept. Existing callers (tests, an embedding
   caller's subprocess calls) are unaffected by anything below.
2. Otherwise, the tracked `config.json` colocated with the script (base) is
   shallow-merged with a local, ignored per-machine overlay
   `config.<profile>.json`, also colocated with the script. `<profile>` is the
   `GUARDS_PROFILE` environment variable if set, else the lowercased hostname.
   A missing overlay merges as base-only — the secret globs (the read-blocking
   check) still apply, but the machine-specific protected/repo rules are empty
   on an unrecognized machine.

Create this machine's overlay once, from this directory. It writes the profile
file the loader looks for, seeded from `config.example.json` — runbox, the
protected path list, and per-repo cell ownership with its `alwaysAllowed`
escape hatch — and refuses to overwrite an existing overlay:

```bash
node --input-type=module -e 'import { existsSync, readFileSync, writeFileSync } from "node:fs"; import { resolveProfile } from "./config-loader.mjs"; const f = `config.${resolveProfile()}.json`; if (existsSync(f)) throw new Error(`${f} already exists -- edit it instead`); const { _comment, ...overlay } = JSON.parse(readFileSync("config.example.json", "utf8"))["config.<profile>.json"]; writeFileSync(f, JSON.stringify(overlay, null, 2) + "\n"); console.log(`wrote ${f}`);'
```

Replace every placeholder path with a real local one. `node cli.mjs
protected-add <path>` then edits that same overlay — it fails closed until the
file exists — while `repos` cell ownership is edited by hand.

There is no dependency on any particular directory layout beyond that — set
`GUARDS_CONFIG` to point at a config anywhere, on any machine.

## Decision audit trail

If the `GUARDS_LOG` environment variable is set, `guard.mjs` appends exactly
one JSONL record per decision (`ts`, `tool`, `target`, `allow`, `rule`, and
`reason`/`profile` when applicable) to the file it names. Logging is
best-effort and always happens after the allow/deny decision is already
final: a failed append (unwritable path, etc.) never changes the decision.
Unset, nothing is written.

## Registering the hook

In `~/.claude/settings.json`, point a `PreToolUse` hook (matcher
`Edit|Write|NotebookEdit|Read`) at `node <path-to-this-dir>/guard.mjs`.

## Commands

```bash
node --test guard.test.mjs cli.test.mjs   # or: node --test "apps/toolbelt/guards/*.test.mjs" from the repo root
node cli.mjs status
node cli.mjs toggle on|off
node cli.mjs secret-add <glob>
node cli.mjs protected-add <path>
```
