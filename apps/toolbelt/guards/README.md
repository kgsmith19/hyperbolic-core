# guards

A standalone Claude Code `PreToolUse` security hook: blocks reads/writes of
secret-shaped files, blocks direct writes to a protected path list, and
enforces per-repo "cell" path ownership declared in `config.json`.

Extracted from `agentic-command-center`'s guard system so it can be used
independently of any particular control-panel/runner. This module has no
dependency on ACC or any other caller — it only needs a hook payload on
stdin and a config file.

## Files

- `guard.mjs` — the hook itself. `decide(payload, config)` is the pure rule
  set (exported for tests); the rest of the file is an I/O wrapper that only
  runs when this file is the process entry point (`node guard.mjs`, exactly
  how Claude Code invokes a hook).
- `cli.mjs` — mutates `config.json`: `status`, `toggle on|off`,
  `secret-add/rm <glob>`, `protected-add/rm <path>`. A caller (e.g. a web
  control panel) shells this for every guard-config change; `guard.mjs`
  itself never writes its config.
- `config.json` — the real, live config, tracked as-is (this repo's copy is
  the operator's own — secrets/protected paths/repo cell data). See
  `config.example.json` for the shape without real values.

## Configuration

Both files resolve their config path the same way: the `GUARDS_CONFIG`
environment variable if set, otherwise `config.json` colocated with the
script. There is no dependency on any particular directory layout beyond
that — set `GUARDS_CONFIG` to point at a config anywhere.

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
