# AGENTS.md

## Repository purpose

`toolbelt` is the monorepo for small portfolio tools. The root owns the shared
Supabase `core` schema for runs, costs, outcomes, metrics, and events plus the
`idea` schema and static idea-list client. `apps/prompt-organizer/` owns the
`prompt` schema and prompt-library client. `apps/network-checker/` owns the
local-first network diagnostic CLI and dashboard.

## Working model

Use this lean lifecycle:

1. Start with a GitHub Issue that states the outcome and acceptance criteria.
2. Implement the smallest coherent change that satisfies the Issue.
3. Run the relevant tests, perform any necessary browser check, and update affected product documentation.
4. Open a pull request and let the single `Toolbelt PR Gate` workflow verify the change.
5. Successful pull requests may complete through native squash auto-merge.

Completed specs and `specs/TEST-LEDGER.md` are historical product records. They can explain shipped decisions, but they do not require new specs, new ledger rows, independent reviews, or any separate approval process. Future work is tracked in GitHub Issues.

## Agent permissions

When explicitly assigned, an AI coding agent may create an Issue, branch, commit, or pull request. It may respond in an existing Issue or pull-request conversation only when it is explicitly tagged with a direct question. An AI agent must not submit a review, request reviewers, approve or block a pull request, change repository protections, or post unsolicited Issue or pull-request comments.

## Product boundaries

- Write portfolio database data only within this monorepo's `core`, `idea`,
  and `prompt` schemas. Follow the narrower instructions under each application.
- The root and Prompt Organizer clients/tests use only the public anon key.
  Never commit a service-role key; Network Checker's optional mirror credential
  remains in its local, ignored environment only.
- Treat row-level security as the authorization boundary; do not weaken RLS or grants to make a test pass.
- Preserve ownership constraints, foreign keys, retention behavior, and append-only records unless the linked Issue explicitly changes them.
- Keep every migration paired with a down migration that reverses the same change.
- Keep the runtime dependency-free unless a linked Issue establishes a concrete need.

## Commands

```bash
node --test "tests/*.test.mjs"
python3 -m http.server 8811
cd apps/prompt-organizer && node --test "tests/*.test.mjs"
cd apps/prompt-organizer && python3 -m http.server 8812 --directory web
cd apps/prompt-organizer && npm install --no-save --no-package-lock @playwright/test@1.52.0
cd apps/prompt-organizer && PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config playwright.config.mjs
cd apps/network-checker && bash tools/check.sh
```

Open `http://localhost:8811/web/index.html` for a manual browser check when the UI changes. The Node suite calls the live Supabase project using the public anon key. Report network or rate-limit failures accurately; do not relabel them as passing.

## Documentation

- `docs/SYSTEM-REQUIREMENTS.md` records current system constraints.
- `docs/DATA-FLOW-DIAGRAM.md` records trust boundaries and data movement.
- `docs/notes/2026-08-06-supabase-project-topology.md` records the shared project topology.
- `specs/done/` preserves shipped design history.
- `apps/prompt-organizer/` contains its product documentation, migrations,
  tests, and nested `AGENTS.md`.
- `apps/network-checker/` contains its product documentation, CLI, dashboard,
  deterministic scanners, fix scripts, tests, and nested `AGENTS.md`.
- `.agent/project.yaml` contains root commands and repository facts.
- `.agent/standard.lock` is an informational reference only and does not impose policy.

## Completion

A change is ready when its acceptance criteria are satisfied, relevant documentation is accurate, applicable local checks pass, and the pull request's `Toolbelt PR Gate` reports success. State any unverified item explicitly.
