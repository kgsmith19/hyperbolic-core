# Idea Intake

Captures rough ideas as drafts, optionally refines them with LLM help, promotes
the good ones, and submits them as GitHub Issues. It owns the `intake` schema.
The user-facing surface is the Shell's Idea Intake page; `frontend/` here is the
app's own page shell.

## Layout

| Path | What it holds |
| --- | --- |
| `tool.json` | The app manifest, read by the manifest validators |
| `project.yaml` | Commands and the CI lane |
| `backend/supabase/migrations/` | The `intake` schema, paired up/down migrations |
| `backend/tests/` | Schema, guard-trigger and RLS suites |
| `backend/tools/` | The one-shot Forgepad migration CLI |
| `frontend/` | The app's page shell |

## Test

```bash
node --test --test-concurrency=1 "backend/tests/*.test.mjs"
```

Suites that need a disposable Postgres skip without one; CI sets
`TOOLBELT_REQUIRE_POSTGRES=1` so they run there. See `AGENTS.md` for the rules
that apply to every change.
