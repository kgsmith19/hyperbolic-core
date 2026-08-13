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

## Actual outcome (as implemented, combined with m5-02)

Delivered together with m5-02 in one slice (~3650 lines added across both,
dominated by the Shell React port and its tests -- the ADR-01/ADR-02
"the Shell absorbs... the Toolbelt tool UIs" decision, not a scope
expansion of this issue's own contract/deletion work):

- `tests/contract.test.mjs` (new, 22 tests): one real-Postgres case per
  05-d section 1.2 endpoint row, proving PO-1a's grant/RLS contract and
  PO-1b's fail-closed non-owner boundary (RLS-refused writes, not silent
  no-ops) on every `prompt.*` table. Deep branch coverage already owned by
  `render-endpoint.test.mjs`/`get-prompt.test.mjs` is deliberately not
  re-proven here (see the file's own header comment).
- `web/index.html`'s password-grant sign-in form is gone; the page now
  boots from an access token primed into `sessionStorage` (its own
  manual-check convenience -- see the file's own comment). D-12's per-run
  namespacing was already in place before this issue (RUN_ID-titled
  fixture rows, locator assertions scoped to that title); `retries: 0`
  unchanged.
- `/prompts` in the Shell is now the real production UI (list + expandable
  cards), not a placeholder -- `apps/shell/src/lib/prompts.ts`,
  `apps/shell/src/pages/prompts/*`. This was originally scoped to m5-02,
  but the two issues share one Shell surface and were implemented as one
  slice; see m5-02's own "Actual outcome" for the UI-side detail.
- One real bug caught and fixed along the way, unrelated to either issue's
  stated scope: importing `{ render, extractVariables, extractSections }`
  from `@hyperbolic/llm`'s barrel pulled in that package's provider SDK
  dependencies (Anthropic/Gemini/OpenAI clients) transitively, blowing
  `apps/shell`'s 250 KB gzipped bundle budget (09 section 6) by ~33 KB.
  Fixed by giving `apps/shell` its own narrow copy of the pure render
  model (`src/lib/prompt-render.ts`, parity-tested against
  `web/render.mjs` directly) instead of importing the package.

## Risk
Low; deletions remove an auth flow; the suite is additive protection.
