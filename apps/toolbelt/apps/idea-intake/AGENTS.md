# AGENTS.md

## Purpose

Idea Intake is the Toolbelt-owned system of record for capturing, refining,
and submitting ideas. It owns the `intake` schema and the one-shot migration
from ACC's legacy Forgepad files.

## Product boundaries

- Owns the `intake` schema in the shared toolbelt Supabase project. Write only within that schema (plus `core`, for `core.log_run` if this tool logs runs). Cross-schema writes belong to the repository that owns the target schema.
- Treat row-level security as the authorization boundary; do not weaken RLS or grants to make a test pass.
- Keep every migration paired with a down migration that reverses the same change (existing toolbelt convention).
- `ownership.owner` in `tool.json` is fixed to `kylegsmith19@gmail.com` by `tool.schema.json`; do not change it.

## Layout

```
tool.json                     the app manifest, read by the Toolbelt validators
backend/supabase/migrations/  the intake schema, paired up/down
backend/tests/                schema, guard-trigger and RLS suites
backend/tools/                the one-shot Forgepad migration CLI
frontend/                     the app's own page shell; the real UI is the
                              Shell's Idea Intake surface
```

## Commands

```bash
node --test "backend/tests/*.test.mjs"
```

Run `npm run manifests:check -- --registry` from `apps/toolbelt/` after any
`tool.json` edit. The platform migration workflow discovers and stages this
app's forward migrations into the shared global ledger; never invoke a second
app-local `supabase db push` against that ledger.
