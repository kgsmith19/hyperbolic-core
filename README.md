# prompt-organizer

## What this is

A place to keep the instructions you write for AI tools, so you can find them again and reuse them instead of retyping them. Save a prompt once, mark the parts that change, fill them in later, copy the finished text. Owns schema `prompt` in the `toolbelt` Supabase project; the shared spine lives in the `toolbelt` repo.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | 22 or newer | Runs the tests with the built-in `node:test` runner and native `fetch`. Nothing to install; there is no `package.json`. |
| Python | 3 (any) | Only to serve the page locally. Any static file server works. |

## Run it

```bash
python3 -m http.server 8812     # from the repo root
```

Open `http://localhost:8812/web/index.html`, sign in with a Supabase account on the `toolbelt` project, save a prompt, see it listed.

## Test it

```bash
node --test "tests/*.test.mjs"
```

Runs against the live project using only the public anon key. No database credentials are needed, or accepted.

## Apply migrations

`supabase/migrations/*.sql`, applied through the Supabase API. Every `<name>.sql` has a matching `<name>_down.sql` that removes exactly what it added. DDL rehearses on `lifeos-test` first, per the topology convention.

## Where things are

| Doc | Purpose |
|---|---|
| `docs/PRD.md` | Source of truth for what this tool delivers |
| `docs/SYSTEM-REQUIREMENTS.md` | What the system must be |
| `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, rests |
| `specs/active/`, `specs/done/` | Specs in progress and completed |
| `specs/TEST-LEDGER.md` | Every test's justification |

## Workflow

Requirements live in `docs/PRD.md`. Each change is one spec in `specs/active/`, built red-then-green under the budgets in `CLAUDE.md`, then moved to `specs/done/`. The full procedure is Kyle's SDD pack; the rules this repo runs on are inlined in `CLAUDE.md`.
