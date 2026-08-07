# toolbelt

## What this is

The shared spine every small tool in Kyle's tool portfolio plugs into: one Postgres schema (`core`) every tool logs runs, costs, and outcomes to, and one schema (`idea`) holding the backlog of tools not built yet. Tools themselves live in their own repos.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | 22 or newer | Runs the tests with the built-in `node:test` runner and native `fetch`. Nothing is installed; there is no `package.json`. |
| Python | 3 (any) | Only to serve the page locally. Any static file server works. |

There is no build step, no framework, and no dependency to install.

## Run it

```bash
python3 -m http.server 8811     # from the repo root
```

Open `http://localhost:8811/web/index.html`, sign in with a Supabase account
on the `toolbelt` project, and the idea list loads.

## Test it

```bash
node --test "tests/*.test.mjs"
```

The suite runs against the live `toolbelt` project using only the public anon
key in `config.mjs`. No database credentials and no service-role key are
needed, or accepted.

## Apply migrations

Migrations in `supabase/migrations/` are applied to the `toolbelt` project
through the Supabase API. Each `<name>.sql` has a matching `<name>_down.sql`
that removes exactly what it added.

## Where things are

| Doc | Purpose |
|---|---|
| `docs/PRD.md` | Source of truth for what this repo delivers |
| `docs/SYSTEM-REQUIREMENTS.md` | What the system must be |
| `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, rests |
| `specs/active/`, `specs/done/` | Specs in progress and completed |

## Workflow

Requirements live in `docs/PRD.md`. Each change is a spec in `specs/active/`, built red-then-green under the budgets in `rules/01-BUDGETS.md`, reviewed against `rules/02-GATES.md`, then moved to `specs/done/`. Full procedure: `prompts/` in the SDD pack this repo was scaffolded from.
