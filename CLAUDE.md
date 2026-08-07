# CLAUDE.md

## What this repo is

Prompt Organizer: save AI prompts once, fill in their variables, copy the rendered text. Owns schema `prompt` in the `toolbelt` Supabase project. One tool in Kyle's portfolio; the shared spine lives in the `toolbelt` repo.

## Read before you act

1. `docs/PRD.md` — **source of truth.** Living document.
2. This file.
3. The spec in `specs/active/` for the slice being built.

`docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md` when work touches architecture, data, or security.

## Process

This repo follows Kyle's SDD pack (canonical copy on Kyle's machine; the `toolbelt` repo carries the full rule cards). The rules this repo runs on are inlined here so a clean clone needs nothing external.

### STOP conditions

Report and ask instead of proceeding when: the PRD is missing, has an unfilled placeholder, or a requirement without a Status; the work implements something no PRD requirement asks for; a budget ceiling would be breached; a new library, service, or third-party integration is needed; a spec contradicts the PRD.

### Non-negotiables

1. No production code without a failing test demanding it. Red must fail on an assertion, not an import error.
2. Every test gets a `specs/TEST-LEDGER.md` row **before** it is written. No row, no test.
3. Cheapest sufficient mechanism: schema constraint → lint → pure function → DB constraint → test → runtime check → network call → LLM call.
4. Budget breach means the slice is wrong: stop, report, split. Never self-approve.
5. Docs update in the same commit as the behavior change.
6. No abstraction with one caller. Deletion is progress.
7. Never declare a gate passed without showing its command output.
8. No `TODO`/`FIXME`/commented-out code in a green slice. No scope widening mid-slice — discoveries become spec entries.

### Budget ceilings (per slice)

```
net source LOC 300 | test LOC 200 | source files 3 | test files 3
new tables 1 | new columns 6 | new endpoints 1 | new UI surfaces 1
new libraries 0 | new third-party 0 | user stories 1 | new tests 8
function LOC 40 | file LOC 250 | complexity 8 | suite seconds 120
red-green cycles before halt 3
Phase 0 tighter: net LOC 150 | repo files 12 | tests 4
```

## Commands

```bash
node --test "tests/*.test.mjs"        # run the suite (Node 22+, no install)
python3 -m http.server 8812           # serve the page; open /web/index.html
# lint / typecheck / build: none exist, deliberately (0 libraries, no build step)
# migrations: supabase/migrations/*.sql applied via the Supabase API; every
#   <name>.sql has a tested <name>_down.sql
```

## Project variables

```yaml
PROJECT_NAME:  prompt-organizer
LANGUAGE:      SQL (Postgres/Supabase) + vanilla JS (no framework, no build step)
DATABASE:      Supabase project "toolbelt" (woltgcggxaehtuypkxqk), schema "prompt" only
TEST_CMD:      node --test "tests/*.test.mjs"
MAIN_BRANCH:   main
```

## Never

- Write to any schema except `prompt` (cross-schema writes belong to the owning repo; reads of `core` arrive in SL-007).
- Commit a service-role key. The anon key is public by design; RLS is the boundary.
- Reference a path outside this repo.
- Create `archive/`, `old/`, or `_backup/`. Git is the archive.
