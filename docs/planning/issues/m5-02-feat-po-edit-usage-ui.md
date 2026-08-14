Title: FEAT(prompt-organizer): body edit, rename refusal, and usage surfacing
Type: FEAT
Component: Prompt Organizer
Milestone: M5 Component upgrades
Depends on: m5-01-feat-po-shell-contract.md
Blocks: none

## Problem
The update grant exists but no edit UI does (02-health-audit.md gap register); a system prompt store whose only body-change path is restore gymnastics fails its consumers. 05-d section 10 decides body edit, section 5 sets the rename rule, and section 9 ships usage telemetry (rank 1) and the token estimate (rank 2).

## Scope
In scope:
- Body-edit UI; every save versioned by the existing trigger
- Title edits refused in the UI for namespaced prompts (create-new-and-archive-old is the rename path); permitted for legacy personal prompts
- Usage count badge from the usage table; chars/4 token estimate labeled as an estimate
Out of scope:
- Diff view, linting, composition, environment scoping, A/B, eval links (all deferred per 05-d section 9)

## Acceptance criteria
When a body is edited and saved, a new version row shall appear with the incremented max version_no and history unchanged.
When a title edit is attempted on a prompt matching the namespace grammar, the UI shall refuse it.
The list surface shall show a per-prompt usage count matching the usage table.
The rendered preview shall show a token estimate visibly labeled as an estimate.

## Verification
node --test apps/toolbelt/apps/prompt-organizer/tests/edit.test.mjs (version increment case)
E2E rename-refusal case for a namespaced fixture and an allowed legacy fixture
Badge count asserted equal to a seeded usage count in the e2e suite
Preview label assertion in the same suite

## Estimated LOC delta
Added: 210  Deleted: 0  Net: +210

## Actual outcome (as implemented, combined with m5-01)

Implemented as a full React port of Prompt Organizer into the Shell at
`/prompts` (ADR-01/ADR-02's "the Shell absorbs the Toolbelt tool UIs"),
not just the four capabilities this issue names in isolation -- the
existing feature set (search, tag filter/toggle, archive, render/copy
with variables and optional sections, saved configurations, version
history) had to be ported alongside the new ones to give the Shell a real
`/prompts` page at all, replacing the placeholder m2-02 shipped. Structure:
`apps/shell/src/lib/prompts.ts` (PostgREST data access, same convention as
`intake.ts`/`registry.ts`), `apps/shell/src/lib/prompt-render.ts` and
`prompt-search.ts` (narrow local ports of `web/render.mjs`/`search.mjs`,
each parity-tested against the original directly), `apps/shell/src/lib/prompt-namespace.ts`
(the section 5 rename-refusal grammar), and
`apps/shell/src/pages/prompts/{list,prompt-card,render-panel,version-history}.tsx`.

This issue's own four acceptance criteria, as built:
- Body edit is in-place on the card (no separate editor route); saving
  PATCHes `body` and the existing `record_version` trigger versions it,
  same as a restore.
- Title edits are refused in the UI (`isNamespacedTitle`, exact grammar
  `^[a-z0-9-]+(/[a-z0-9-]+){1,2}$`) with a visible explanatory note in
  place of the Rename control; permitted and real for legacy titles.
- The usage badge counts real `prompt.usage` rows client-side (no
  dependency on PostgREST's optional aggregate-embed feature, which is not
  guaranteed enabled on every project) and updates live after a copy.
- The render preview shows the rendered text plus a `~N tokens (estimate)`
  label (chars/4), both proven with real seeded data in `e2e/prompts.spec.ts`.

Tests: 45 new vitest unit tests plus a 22-test `list.test.tsx` integration
suite (mutation-verified), and `e2e/prompts.spec.ts` (7 tests) against a
real local-Postgres-backed fixture (`e2e/support/prompt-fixture.ts`,
mirroring `e2e/support/intake-fixture.ts`'s approach) -- covering exactly
the four cases above against real data and the real `record_version`
trigger, not mocks. Building the restore case surfaced a genuine bug
(`VersionHistory` never refetched after a restore, so a second restore
would have offered "Restore" against an already-stale version list),
fixed and covered before this issue was called done.

## Risk
Low; edit is safe by construction because the trigger versions every body update.
