# toolbelt

`toolbelt` is the monorepo for small portfolio tools. The root shared foundation
owns the `core` schema for runs, costs, outcomes, metrics, and events plus the
`idea` schema (the idea-list client lives in the Shell's Idea Intake surface,
`apps/shell/frontend/src/pages/ideas/`; the root's own static client was deleted once
that surface and the Shell's registry-driven tools list were both live --
m3-09). `apps/prompt-organizer/`
owns the `prompt` schema and prompt-library client. `apps/network-checker/`
owns the standard-library-only network diagnostic CLI and offline dashboard.

## Prerequisites

- Node.js 22 or newer for the built-in test runner and native `fetch`.
- Python 3, or another static file server, for Prompt Organizer's local browser verification (see `apps/prompt-organizer/README.md`).

There is no package manifest, framework, dependency installation, or application
compilation step. Network Checker can optionally be packaged as a Docker image.

## Commands

```bash
node --test "tests/*.test.mjs"
cd apps/prompt-organizer && node --test "tests/*.test.mjs"
cd apps/network-checker && bash tools/check.sh
```

The suites use the live `toolbelt` Supabase project and its public anon key. A
service-role key is neither required nor accepted. The `Verify: Tests (Toolbelt)`
workflow also runs Prompt Organizer's critical browser journey.

Apply `supabase/migrations/*.sql` through the Supabase API. Each up migration has a matching `_down.sql` migration that reverses the same change.

## Layout

- `apps/prompt-organizer/` - store, search, render, and copy reusable prompts.
- `apps/network-checker/` - diagnose Wi-Fi, router, ISP, and endpoint failures.
- `apps/idea-intake/` - intentionally absent until implementation begins.

## Documentation

- `docs/notes/2026-08-06-supabase-project-topology.md` describes the shared project topology.
- `TEST_LEDGER.md` tracks this app's own test suites.
- `apps/prompt-organizer/README.md` documents the prompt application.
- `apps/network-checker/README.md` documents the network diagnostic.
- `guards/README.md` documents the standalone guard hook.

New work starts in GitHub Issues. Pull requests are verified by `.github/workflows/toolbelt-ci.yml` at the hyperbolic-core repo root (this project now lives at `apps/toolbelt/` inside the hyperbolic-core monorepo), called as the `Verify: Tests (Toolbelt)` stage of the root's sequential `pr-verify.yml` chain. Successful pull requests use native squash auto-merge.
