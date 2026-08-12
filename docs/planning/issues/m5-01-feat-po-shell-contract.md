Title: FEAT(prompt-organizer): Shell session, contract suite, and e2e namespacing
Type: FEAT
Component: Prompt Organizer
Milestone: M5 Component upgrades
Depends on: m2-03-feat-shell-login-gate.md, m1-08-feat-db-rls-owner-repin.md
Blocks: m5-02-feat-po-edit-usage-ui.md

## Problem
Prompt Organizer still runs its own password-grant sign-in (one of the three disjoint auth flows), has no contract suite over its endpoint table, and its e2e flakiness is structural (D-12: shared fixture data, live Auth latency, retries 0). Fixes are 05-d-prompt-organizer.md sections 1.2, 2, and 10.

## Scope
In scope:
- Session from packages/platform-client; deletion of the password-grant sign-in form and its token fetch (~50 lines); /prompts/* reached through the Shell
- Contract suite: one case per row of the 05-d section 1.2 endpoint table, including the fixture-token negative case and the PO-3 rollback-visibility assertion
- E2E per-run namespacing: every e2e row titled under a run-id namespace, assertions scoped to it, retries stays 0 (D-12 layer 1; layer 2 rides the owner-account decision of 06 section 5.4)
Out of scope:
- Edit UI and usage surfacing (m5-02); get_prompt and seed (landed in m4-03)

## Acceptance criteria
The system shall serve every endpoint in the 05-d section 1.2 table per its stated contract and auth requirement (PO-1a).
If a request presents a token whose subject is not the owner UUID, then the system shall return zero rows and refuse writes on every prompt table (PO-1b).
Published versions shall be immutable and rollback shall restore any prior version as a new version with a new max version_no (PO-3).
When the e2e suite runs twice concurrently, both runs shall pass (D-12).
The client shall contain no local sign-in call.

## Verification
node --test apps/toolbelt/apps/prompt-organizer/tests/contract.test.mjs
Fixture-token case inside the same suite (empty select, 4xx insert)
node --test apps/toolbelt/apps/prompt-organizer/tests/versions.test.mjs tests/restore.test.mjs (max version_no assertion)
Two parallel npx playwright test invocations with distinct run ids; both exit 0
grep -rn signInWithPassword apps/toolbelt/apps/prompt-organizer/web returns zero hits

## Estimated LOC delta
Added: 310  Deleted: 50  Net: +260

## Risk
Low; deletions remove an auth flow; the suite is additive protection.
