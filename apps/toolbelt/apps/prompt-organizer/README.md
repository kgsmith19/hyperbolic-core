# prompt-organizer

Prompt Organizer stores reusable AI prompts, fills their variables, and copies the rendered result. It is a zero-build static web application backed by the `prompt` schema in the shared `toolbelt` Supabase project.

## Prerequisites

- Node.js 22 or newer for the built-in test runner and native `fetch`.
- Python 3, or another static file server, for local use.
- Chromium for the Playwright browser journey. The CI workflow installs it automatically.

There is no package manifest, application server, framework, or build step.

## Run locally

```bash
python3 -m http.server 8812 --directory frontend
```

Open `http://localhost:8812`, sign in to the `toolbelt` Supabase project, and use the prompt library.

## Verify

Run the Node suite:

```bash
node --test "backend/tests/*.test.mjs" "frontend/tests/*.test.mjs"
```

Run the critical browser journey:

```bash
npm install --no-save --no-package-lock @playwright/test@1.52.0
npx playwright install --with-deps chromium
python3 -m http.server 8812 --directory frontend &
PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config frontend/playwright.config.mjs
```

Both suites use the live Supabase project and its public anon key. A service-role key is neither required nor accepted.

## Migrations

Apply `supabase/migrations/*.sql` through the Supabase API. Each up migration has a matching `_down.sql` migration that reverses the same change.

## Documentation

- `TEST_LEDGER.md` tracks this app's own test suites.

New work starts in Toolbelt GitHub Issues. Pull requests are verified by the
hyperbolic-core root's `.github/workflows/toolbelt-ci.yml`, sharing its
composite actions with the `Toolbelt` job of the root's `pr-verify.yml`.
Successful pull requests use native squash auto-merge.
