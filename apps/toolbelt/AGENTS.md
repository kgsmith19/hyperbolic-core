# AGENTS.md

## Repository purpose

`toolbelt` is the monorepo for small portfolio tools. The root owns the shared
Supabase `core` schema for runs, costs, outcomes, metrics, and events plus the
`idea` schema (the idea-list client itself lives in the Shell's Idea Intake
surface, `apps/shell/src/pages/ideas/`; the root's own static client was
deleted once that surface and the Shell's registry-driven tools list were
both live -- m3-09). `apps/prompt-organizer/` owns the
`prompt` schema and prompt-library client. `apps/network-checker/` owns the
local-first network diagnostic CLI and dashboard. `guards/` owns a standalone
Claude Code `PreToolUse` security hook (secret-file blocking, protected-path
blocking, per-repo cell ownership) with no dependency on any particular
caller — extracted from `agentic-command-center`; see `guards/README.md`.

## Working model

Use this lean lifecycle:

1. Start with a GitHub Issue that states the outcome and acceptance criteria.
2. Implement the smallest coherent change that satisfies the Issue.
3. Run the relevant tests, perform any necessary browser check, and update affected product documentation.
4. Open a pull request and let the single `Toolbelt PR Gate` workflow verify the change.
5. Successful pull requests may complete through native squash auto-merge.

This repository does not keep committed specs or ADRs — see `TEST_LEDGER.md` for the current, lean test-tracking convention. Future work is tracked in GitHub Issues.

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
npm run manifests:check
npm run manifests:check -- --registry
cd guards && node --test "*.test.mjs"
cd apps/prompt-organizer && node --test "tests/*.test.mjs"
cd apps/prompt-organizer && python3 -m http.server 8812 --directory web
cd apps/prompt-organizer && npm install --no-save --no-package-lock @playwright/test@1.52.0
cd apps/prompt-organizer && PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config playwright.config.mjs
cd apps/network-checker && bash tools/check.sh
```

The root has no browser client of its own to check (m3-09: the static idea-list client was deleted once the Shell's registry-driven tools list and Idea Intake list surfaces were both live); a manual browser check for root-schema changes now means the Shell's `/tools` or `/ideas` pages. The Node suite calls the live Supabase project using the public anon key. Report network or rate-limit failures accurately; do not relabel them as passing.

## Documentation

- `docs/notes/2026-08-06-supabase-project-topology.md` records the shared project topology.
- `TEST_LEDGER.md` tracks this app's own test suites.
- `apps/prompt-organizer/` contains its product documentation, migrations,
  tests, and nested `AGENTS.md`.
- `apps/network-checker/` contains its product documentation, CLI, dashboard,
  deterministic scanners, fix scripts, tests, and nested `AGENTS.md`.
- `guards/` contains its own `README.md`.
- `project.yaml` contains root commands and repository facts.
- The root `standard.lock` is an informational reference only and does not impose policy.

## Completion

A change is ready when its acceptance criteria are satisfied, relevant documentation is accurate, applicable local checks pass, and the pull request's `Toolbelt PR Gate` reports success. State any unverified item explicitly.
