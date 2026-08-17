# AGENTS.md

## 🎯 Purpose

Prompt Organizer stores reusable AI prompts, substitutes variables, and copies rendered text. It owns the `prompt` schema in the shared `toolbelt` Supabase project.

## 🧭 Working Model

Use this lean lifecycle:

1. Start with a GitHub Issue that states the outcome and acceptance criteria.
2. Implement the smallest coherent change that satisfies the Issue.
3. Run the relevant tests and update affected product documentation.
4. Open one Toolbelt pull request and let the hyperbolic-core root's `Verify: Tests (Toolbelt)` verify the change.
5. Successful pull requests may complete through native squash auto-merge.

This app does not keep committed specs or ADRs — see `TEST_LEDGER.md` for the current, lean test-tracking convention. Future work is tracked in GitHub Issues.

## 📋 Product Boundaries

- Write only to the `prompt` schema. Cross-schema write behavior belongs to the repository that owns the target schema.
- Use the public anon key in clients and tests. Never commit or use a service-role key in this repository.
- Treat row-level security as the authorization boundary; do not weaken RLS or grants to make a test pass.
- Keep `prompt.prompt_version` and `prompt.usage` append-only. Do not add `UPDATE` or `DELETE` grants.
- Keep every migration paired with a down migration that reverses the same change.
- Preserve product schema, migrations, tests, and existing security invariants unless the linked Issue explicitly changes them.

## 📂 Layout

```
tool.json                     the app manifest, read by the Toolbelt validators
backend/supabase/migrations/  the prompt schema, paired up/down
backend/tests/                schema, RLS and live-Supabase suites
frontend/                     the browser client (index.html + four modules)
frontend/tests/               unit tests for those modules, no database
frontend/e2e/                 the Playwright critical journey
frontend/playwright.config.mjs
```

## ⚙️ Commands

```bash
node --test "backend/tests/*.test.mjs" "frontend/tests/*.test.mjs"
python3 -m http.server 8812 --directory frontend
npm install --no-save --no-package-lock @playwright/test@1.52.0
npx playwright install --with-deps chromium
PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config frontend/playwright.config.mjs
```

The Node and browser suites call the live Supabase project using the public anon key. Report network or rate-limit failures accurately; do not relabel them as passing.

## 📚 Documentation

- `TEST_LEDGER.md` tracks this app's own test suites.
- The root `project.yaml` contains repository commands and facts.
- The root `standard.lock` is informational and non-enforcing.

## ✅ Completion

A change is ready when its acceptance criteria are satisfied, relevant
documentation is accurate, applicable local checks pass, and the
hyperbolic-core root's `Verify: Tests (Toolbelt)` reports success. State any
unverified item explicitly.

## 🔒 Collaboration Boundary

When explicitly assigned, an AI coding agent may create an Issue, branch, commit, or pull request. It may respond in an existing Issue or pull-request conversation only when it is explicitly tagged with a direct question. An AI agent must not submit a review, request reviewers, approve or block a pull request, change repository protections, or post unsolicited Issue or pull-request comments.
