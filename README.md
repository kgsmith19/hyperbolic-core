# toolbelt

## What this is

The shared spine every small tool in Kyle's tool portfolio plugs into: one Postgres schema (`core`) every tool logs runs, costs, and outcomes to, and one schema (`idea`) holding the backlog of tools not built yet. Tools themselves live in their own repos.

## Prerequisites

<TBD>

## Run it

<TBD>

## Test it

<TBD>

## Where things are

| Doc | Purpose |
|---|---|
| `docs/PRD.md` | Source of truth for what this repo delivers |
| `docs/SYSTEM-REQUIREMENTS.md` | What the system must be |
| `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, rests |
| `specs/active/`, `specs/done/` | Specs in progress and completed |

## Workflow

Requirements live in `docs/PRD.md`. Each change is a spec in `specs/active/`, built red-then-green under the budgets in `rules/01-BUDGETS.md`, reviewed against `rules/02-GATES.md`, then moved to `specs/done/`. Full procedure: `prompts/` in the SDD pack this repo was scaffolded from.
