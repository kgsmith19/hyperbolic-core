# AGENTS.md

Operational map for agents working in this repo. Not an encyclopedia -- if you need more than this, the pointer you need is below.

## Standard

This repo runs on [`agent-engineering-standard`](https://github.com/kgsmith19/agent-engineering-standard), pinned at the commit in `.agent/standard.lock`. Read that repo's `README.md`, `LIFECYCLE.md`, `AGENT_RULES.md`, `QUALITY_RULES.md`, `SECURITY_RISK_AUTONOMY.md`, `DELIVERY_GITHUB.md`, `EVIDENCE_LEARNING.md` for the full rules. This file only states what is specific to `toolbelt`.

`rules/*.md` and the older parts of `CLAUDE.md` predate this standard and are **superseded** -- kept for history because past specs cite their gate/property IDs (`GATE-RED R2`, `PROP-005`, etc.), not as active guidance. Do not follow them for new work; follow this file and the pinned standard. (`rules/08-SUBAGENT-ROLES.md` is the old `AGENTS.md` -- a default multi-role subagent worktree pattern the standard explicitly says not to default to; see `AGENT_RULES.md` in the standard and the note at the top of that file.)

## What this repo is

The shared spine and idea list every other tool in Kyle's portfolio plugs into: a `core` schema every tool logs runs/costs/events to, and an `idea` schema holding the tool backlog. See `docs/PRD.md`.

## Product truth

| What | Where |
|---|---|
| Source of truth | `docs/PRD.md` -- every `FR-`/`NFR-` has a Status; if code and PRD disagree, one is a defect |
| System shape | `docs/SYSTEM-REQUIREMENTS.md` |
| Data flow / trust boundaries | `docs/DATA-FLOW-DIAGRAM.md` |
| Completed specs (history + evidence) | `specs/done/SPEC-NNNN-*.md` |
| Active spec (if any) | `specs/active/SPEC-NNNN-*.md` -- empty when nothing is in flight |
| ADRs | none yet. Create `docs/adr/ADR-NNNN-<kebab>.md` only for a consequential, hard-to-reverse decision |
| Test evidence ledger | `specs/TEST-LEDGER.md` -- every test's justification, mutation-verified date, deletion criterion |

As of this migration, every `FR-`/`NFR-` in the PRD is `done`; the slice plan (PRD section 13) has no open row. The next unit of work starts from a new GitHub Issue, not from an existing backlog.

## Commands

```bash
node --test "tests/*.test.mjs"    # test (fast == full: one suite, ~2.5s)
none                              # setup / build / format / lint / typecheck -- deliberately absent (SR-023)
python3 -m http.server 8811       # run locally, then open /web/index.html
```

No E2E automation exists. Verify UI changes by hand in a browser against the command above; say so explicitly rather than claiming automated coverage that doesn't exist.

Migrations apply directly against the live Supabase project (`woltgcggxaehtuypkxqk`) via the Supabase API/MCP -- there is no local migration runner and no separate deploy step.

## Work

```
Issue (GitHub) -> SPEC only if behavior/decisions are nontrivial -> thin slice(s) -> PR -> CI -> merge
```

- GitHub Issues are the durable work-item system. Do not create a second one.
- This repo already has a working `FR-NNN` / `NFR-NNN` / `SPEC-NNNN` / `SL-NNN` traceability convention in `docs/PRD.md` and `specs/`. Keep using it -- link the Issue from the PRD/spec and the spec from the Issue. It is a proven refinement of "use durable identifiers when they add value," not a competing system.
- Work one thin slice at a time, in a short-lived branch (worktree when running slices in parallel). A slice that does not fit in one PR is too big.
- `specs/TEST-LEDGER.md` stays in use: every test gets a row, with a named failure mode, before it is written. This is stricter than the shared standard requires and it is working -- keep it.
- Default to one primary agent per slice. A second, separately scoped reviewer/evaluator is worth adding only when risk or evidence justifies it -- not as a standing default (see `rules/08-SUBAGENT-ROLES.md`'s note).

## Evidence before implementation

```
Acceptance criteria -> important properties/invariants -> strongest economical test -> meaningful RED -> minimum GREEN -> verify
```

- RED must fail because behavior is missing or wrong, never because the harness is broken.
- Implement the smallest change that satisfies the evidence. Refactor only after GREEN.
- This repo's tests run against the real Supabase project over HTTPS with the public anon key -- there is no mock layer and no local DB. That is the chosen oracle; do not add one to avoid hitting the network.
- Match evidence to the change: a schema/RLS change needs an integration test against the live project; a pure JS function (if one is ever extracted) needs a unit test; a UI change needs a browser check.

## Risk and authority

Use the standard's `R0`-`R4` scale. Effective default for this repo: **R2** (normal schema/product change against a live, shared, multi-tenant Postgres project -- not local-only, so not R1).

Protected paths (see `.agent/project.yaml`): `supabase/migrations/**`, `.github/workflows/**`, `.agent/**`, `rules/**`. Changes here are at least R3 -- they touch the schema every other tool in the portfolio depends on, or the controls governing this repo's own CI.

- An implementing agent may raise risk, never lower it, and must not modify the CI checks, branch protection, or this file's own risk section in the same run that implements a feature.
- Routine, reversible, tested R0-R2 work should not wait on a human. R3+ (schema changes, RLS changes, anything touching `core.*` other tools read) gets called out explicitly in the PR description even when CI is green.

## Verification before completion

Writing code is not done. Before claiming a slice complete:

1. The test suite passes (`node --test "tests/*.test.mjs"`), shown, not asserted.
2. `specs/TEST-LEDGER.md` has a row per new test, mutation-verified.
3. `docs/PRD.md` status column and `docs/SYSTEM-REQUIREMENTS.md` / `docs/DATA-FLOW-DIAGRAM.md` are updated in the same commit as the behavior change -- never later.
4. State exactly what remains unverified (e.g. "browser-checked manually, no automated E2E exists") rather than implying coverage that isn't there.

## Notes

- Zero dependencies, zero build step, zero CI secrets are deliberate choices (`SR-023`, `.agent/project.yaml`), not gaps -- don't "fix" them.
- `docs/notes/2026-08-07-repo-references-prompts-and-templates-it-does-not-contain.md` recorded a real defect: `CLAUDE.md`/`rules/*.md` referenced a `prompts/`/`templates/` pack that does not exist in this repo. This migration resolves it (Option 3 from that note): the pack is now the published, pinned `agent-engineering-standard` repo instead of a phantom local path.
