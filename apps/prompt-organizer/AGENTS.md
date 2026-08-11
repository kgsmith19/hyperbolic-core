# AGENTS.md

## Application purpose

Prompt Organizer stores reusable AI prompts, substitutes variables, and copies rendered text. It owns the `prompt` schema in the shared `toolbelt` Supabase project.

## Working model

Use this lean lifecycle:

1. Start with a GitHub Issue that states the outcome and acceptance criteria.
2. Implement the smallest coherent change that satisfies the Issue.
3. Run the relevant tests and update affected product documentation.
4. Open one Toolbelt pull request and let the root `PR Gate` verify the change.
5. Successful pull requests may complete through native squash auto-merge.

Completed specs, ADRs, and `specs/TEST-LEDGER.md` are historical product records. They can explain shipped decisions, but they do not require new specs, new ledger rows, independent reviews, or any separate approval process. Future work is tracked in GitHub Issues.

## Agent permissions

When explicitly assigned, an AI coding agent may create an Issue, branch, commit, or pull request. It may respond in an existing Issue or pull-request conversation only when it is explicitly tagged with a direct question. An AI agent must not submit a review, request reviewers, approve or block a pull request, change repository protections, or post unsolicited Issue or pull-request comments.

## Product boundaries

- Write only to the `prompt` schema. Cross-schema write behavior belongs to the repository that owns the target schema.
- Use the public anon key in clients and tests. Never commit or use a service-role key in this repository.
- Treat row-level security as the authorization boundary; do not weaken RLS or grants to make a test pass.
- Keep `prompt.prompt_version` and `prompt.usage` append-only. Do not add `UPDATE` or `DELETE` grants.
- Keep every migration paired with a down migration that reverses the same change.
- Preserve product schema, migrations, tests, and existing security invariants unless the linked Issue explicitly changes them.

## Commands

```bash
node --test "tests/*.test.mjs"
python3 -m http.server 8812 --directory web
npm install --no-save --no-package-lock @playwright/test@1.52.0
npx playwright install --with-deps chromium
PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config playwright.config.mjs
```

The Node and browser suites call the live Supabase project using the public anon key. Report network or rate-limit failures accurately; do not relabel them as passing.

## Documentation

- `docs/SYSTEM-REQUIREMENTS.md` records current system constraints.
- `docs/DATA-FLOW-DIAGRAM.md` records trust boundaries and data movement.
- `docs/adr/` and `specs/done/` preserve shipped design history.
- The root `.agent/project.yaml` contains repository commands and facts.
- The root `.agent/standard.lock` is informational and non-enforcing.

## Completion

A change is ready when its acceptance criteria are satisfied, relevant
documentation is accurate, applicable local checks pass, and Toolbelt's root
`PR Gate` reports success. State any unverified item explicitly.
