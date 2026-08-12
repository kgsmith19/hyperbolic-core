# toolbelt

`toolbelt` is the monorepo for small portfolio tools. The root shared foundation
owns the `core` schema for runs, costs, outcomes, metrics, and events plus the
`idea` schema and dependency-free idea-list client. `apps/prompt-organizer/`
owns the `prompt` schema and prompt-library client. `apps/network-checker/`
owns the standard-library-only network diagnostic CLI and offline dashboard.

## Applications

- `apps/prompt-organizer/` - store, search, render, and copy reusable prompts.
- `apps/network-checker/` - diagnose Wi-Fi, router, ISP, and endpoint failures.
- `apps/idea-intake/` - intentionally absent until implementation begins.

## Prerequisites

- Node.js 22 or newer for the built-in test runner and native `fetch`.
- Python 3, or another static file server, for local browser verification.

There is no package manifest, framework, dependency installation, or application
compilation step. Network Checker can optionally be packaged as a Docker image.

## Run locally

```bash
python3 -m http.server 8811
```

Open `http://localhost:8811/web/index.html`, sign in to the `toolbelt` Supabase project, and verify the affected idea-list flow.

## Verify

```bash
node --test "tests/*.test.mjs"
cd apps/prompt-organizer && node --test "tests/*.test.mjs"
cd apps/network-checker && bash tools/check.sh
```

The suites use the live `toolbelt` Supabase project and its public anon key. A
service-role key is neither required nor accepted. The `Toolbelt PR Gate`
workflow also runs Prompt Organizer's critical browser journey.

## Migrations

Apply `supabase/migrations/*.sql` through the Supabase API. Each up migration has a matching `_down.sql` migration that reverses the same change.

## Documentation

- `docs/SYSTEM-REQUIREMENTS.md` describes current system constraints.
- `docs/DATA-FLOW-DIAGRAM.md` describes trust boundaries and data movement.
- `docs/notes/2026-08-06-supabase-project-topology.md` describes the shared project topology.
- `specs/done/` preserves shipped design history.
- `specs/TEST-LEDGER.md` is a historical evidence record, not a required planning artifact.
- `apps/prompt-organizer/README.md` documents the prompt application.
- `apps/network-checker/README.md` documents the network diagnostic.

New work starts in GitHub Issues. Pull requests are verified by the sole `.github/workflows/toolbelt-ci.yml` workflow at the hyperbolic-core repo root (this project now lives at `apps/toolbelt/` inside the hyperbolic-core monorepo), whose workflow and check names are both `Toolbelt PR Gate`. Successful pull requests use native squash auto-merge.
