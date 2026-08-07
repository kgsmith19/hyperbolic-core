---
title: Tags on prompts, filter and search
spec_id: SPEC-0004-tags
slice: SL-006
status: active
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
completed:
traces: [FR-012, FR-006]
---

# SPEC-0004: Tags on prompts, filter and search

## 1. In one sentence

A prompt carries zero or more tags; the list filters to a selected tag, and search (SL-001) matches tags as well as title and body — completing FR-006.

## 2. Why this, why now

FR-012, and the completion of FR-006 (left partial by SL-001, tags explicitly deferred here). Depends only on SL-001 (search must exist to extend); independent of SL-002/003/004/005/007/008/009's files.

## 3. Scope

**In:** table `prompt.tag` (`prompt_id`, `tag`, composite PK — a tag is a bare string, lowercased at write time so `SDD` and `sdd` are the same tag, matching FR-002's case-fold precedent); a tag-entry control on the save form (comma-separated, trimmed, lowercased, deduplicated client-side before send); tag chips shown per prompt in the list; a tag filter (click a chip to filter to it, click again to clear); `searchPrompts` (SL-001's `web/search.mjs`) extended to match tags, tag matches ranked with title matches (both are "found by name," ahead of body-only, per FR-006's "title... first" read as "named-field matches first").

**Out (three-plus per S4):** a tag management/rename UI (PRD is silent on it; no AC demands it — renaming a tag is deleting and re-adding until a real need is measured); tag autocomplete (no AC demands it, adds no requirement coverage); tag-based scoring or hierarchy (PRD OOS-004 excludes hierarchy outright); multi-tag AND/OR filtering (PRD names only "filter by a selected tag," singular — FR-012's literal scope).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | Save a prompt with tags `sdd, Review, sdd` | Saved | Exactly two tag rows exist for it: `sdd`, `review` — lowercased, deduplicated | FR-012 |
| AC-002 | Prompts tagged `sdd` and `review` (disjoint sets) | Filtering by `sdd` | Only prompts carrying `sdd` are shown | FR-012 |
| AC-003 | A prompt tagged `sdd`, title and body containing neither `sdd` nor any variant | Searching `sdd` | That prompt appears in the results (tag match) | FR-006 |
| AC-004 | Prompts with `sdd` in the title, `sdd` only as a tag, and `sdd` only in the body | Searching `sdd` | Title match first, tag match second, body-only match last | FR-006 |
| AC-005 | A tag filter is active | The same chip is clicked again | The filter clears; every prompt is shown | FR-012 |
| AC-006 | A prompt exists | Saving it with a 101-character tag | Rejected with `400` and Postgres code `23514`; no tag row is created | FR-012 |

AC-006 is the failure case.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | Every tag write ends in success or a named `4xx`; a prompt delete cascades its tag rows (no orphans), a title with only whitespace-tags saves zero tag rows, never a crash. | Error totality | Empty tag list, whitespace-only tag, 200-char tag (no length cap is specced, so an unbounded `text` column is correct — recorded as ASM) | FR-012 |
| PROP-002 | Invariant: `lower(tag)` is idempotent — saving `SDD` twice (across two prompts, or the same prompt) never produces two rows differing only in case for the same prompt. | Invariant | Mixed-case tag lists | FR-012 |
| PROP-003 | Conservation: filtering by a tag never returns a prompt that does not carry that tag (case-folded), and never omits one that does. | Conservation / invariant | Tag fixture set | FR-012 |
| PROP-004 | Monotonicity: adding a tag to the query domain (i.e., a prompt's tag matching `search(q)`) never removes it from a broader, untagged-title/body search for the same `q` — search results only grow when tag-matching is added, never shrink. | Monotonicity | Fixture where a prompt matches by tag only | FR-006 |
| PROP-005 | Round-trip: tags saved are exactly the tags read back, as a set (order not significant — no AC orders tags). | Round-trip | AC-001 fixture | FR-012 |
| Others | Idempotence n/a beyond PROP-002 (covered); order independence n/a (single writer, CON-002); oracle beyond the literal ACs n/a; metamorphic n/a. | — | — | — |

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status | Actual |
|---|---|---|---|---|
| Net source LOC | ~90 (migration ~25, `search.mjs` delta ~15, `index.html` delta ~50) | 300 | within | 84 (migration up 27 + down 4 = 31; `search.mjs` +16/−3 = 13; `index.html` +44/−4 = 40) |
| Test LOC | ~150 | 200 | within | 175 (`tests/tags.test.mjs` 144 new; `tests/search.test.mjs` +31/−0) |
| New modules | 0 (extends `search.mjs`, does not add a module) | 2 | within | 0 |
| Source files touched | 3 (migration, `search.mjs`, `index.html`) | 3 | within | 3 (the migration up/down pair counted as one changeset, matching section 7.3's single row for both files — 4 physical files if counted separately: up, down, `search.mjs`, `index.html`) |
| Test files touched | 2 (`tests/tags.test.mjs` new; `tests/search.test.mjs` extended) | 3 | within | 2 |
| New tables | 1 (`prompt.tag`) | 1 | within | 1 |
| New columns | 2 (`prompt_id`, `tag`) | 6 | within | 2 |
| New endpoints/UI surfaces beyond the existing page/libraries/third-party | 0 | — | within | 0 |
| User stories | 1 (U-001) | 1 | within | 1 |
| New tests | 7 | 8 | within | 7 (T-I-008, T-I-009, T-I-010, T-I-014, T-U-013, T-U-014 executable; T-I-011 a recorded, non-executable integrator drill). Largest new function ~16 LOC (`searchPrompts`) ≤ 40; largest touched file 220 LOC (`index.html`) ≤ 250; suite runtime 2.289s ≤ 120s |

## 7. Changes

### 7.1 Data

`supabase/migrations/<ts>_prompt_create_tag.sql` (+ `_down.sql`): table `prompt.tag (prompt_id uuid not null references prompt.prompt(id) on delete cascade, tag text not null check (char_length(tag) between 1 and 100), primary key (prompt_id, tag))`; `grant select, insert on prompt.tag to authenticated`; **no delete grant** — removing a tag is out of scope this slice (PRD names only add-and-filter; a delete path is a future slice's to justify), so tags accumulate until a slice adds one, same posture as SL-000/SL-004's grant discipline. RLS enabled and forced; policies: select/insert `using`/`with check (exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid()))` — ownership is via the parent `prompt` row, since `tag` carries no `user_id` of its own (avoiding a redundant column FR-012 does not ask for).

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/<ts>_prompt_create_tag.sql` / `_down.sql` | create | AC-001, AC-005 |
| `web/search.mjs` | edit | AC-003, AC-004 — tag matching added to the existing filter/rank function |
| `web/index.html` | edit | Tag entry, chips, filter click |
| `tests/tags.test.mjs` | create | AC-001, AC-002, AC-005, AC-006, PROP-001..003, PROP-005 |
| `tests/search.test.mjs` | edit | AC-003, AC-004, PROP-004 — new cases added to the existing suite, no existing assertion changed |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-I-008 | integration | AC-001, PROP-002, PROP-005 | Tags saved with mixed case or duplicates produce more than the deduplicated, lowercased set | DB round-trip needed to prove storage, not just client-side dedup | Only tag-save test | FR-012 changes |
| T-I-009 | integration | AC-002, PROP-003 | A filter shows a prompt lacking the tag, or hides one that has it | Real query against real rows | Only filter test | FR-012 changes |
| T-I-010 | integration | AC-005 | The filter fails to clear on a second click | Real query, real toggle state | Only clear-filter test | FR-012 changes |
| T-U-013 | unit | AC-003, PROP-001 | A tag-only match is absent from search results | Pure function once tags are loaded alongside prompts | Extends T-U-001 without duplicating it (title/body already covered there) | FR-006 changes shape |
| T-U-014 | unit | AC-004, PROP-004 | Tag match ranks above or below the wrong group | Pure function; ordering is logic | Extends T-U-002 | Same |
| T-I-011 | integration | PROP-001 | A cascade-deleted prompt leaves orphan tag rows | Cascade behavior is a real FK property, needs the real database | No other test deletes a prompt (no delete grant exists on `prompt.prompt` either — this test uses the integrator's elevated access to delete for the purpose of proving the FK, recorded as an integrator-only drill, not a suite member) | Never |
| T-I-014 | integration | AC-006, PROP-001 | A tag outside the length bound is stored | The `CHECK` is the cheap mechanism; this proves it is wired | Only over-length-tag test | FR-012's bound changes |

T-I-011 cannot run inside the anon-key-only suite (`prompt.prompt` has no `DELETE` grant, by design). It is a manual integrator drill like T-A-002, not an executable test — recorded in the ledger as such.

## 9. Risks

RISK-001: no cap on tag length or count per prompt is specced; `text` with a 100-char check constraint chosen as the cheapest bound preventing pathological input, not required by any AC (recorded as ASM, revisit if wrong).

## 10. Rollback

Down migration drops `prompt.tag`; revert the `search.mjs`/`index.html` commits.

## 11. Assumptions made during implementation

| ID | Assumption | Why |
|---|---|---|
| ASM-007 | `searchPrompts(prompts, query)`'s signature is unchanged; `prompt.tags` becomes an **optional** third field on each prompt object (`title`, `body`, `tags?: string[]`), read as `prompt.tags ?? []` | Keeps SL-001's five callers/tests (T-U-001..005, all `{title, body}` fixtures with no `.tags`) green with zero changes — a prompt without `.tags` is simply treated as tag-free, per the task's explicit "handle absence gracefully" requirement. A fourth positional parameter (e.g. `searchPrompts(prompts, query, tags)`) was rejected: it would decouple a prompt from its own tags, forcing callers to keep two parallel arrays in sync for no benefit. |
| ASM-008 | `searchPrompts` ranks in three disjoint groups — title, then tag, then body-only — via an `if / else if / else if` chain per prompt (mutually exclusive membership, first match wins) | AC-004 names exactly three ordered groups; a prompt matching by title is never *also* counted as a tag or body match (matches the existing title-vs-body exclusivity T-U-002 already established, extended by one tier). PROP-004 (monotonicity: adding tag-search only grows results, never shrinks a broader search) holds because the tag branch only ever *adds* prompts that were previously in neither group — it can't remove a title match from the title group. |
| ASM-009 | T-I-010 (AC-005, "filter toggles off on second click") is reclassified from the spec's declared `integration` level to `unit`, exercising a new pure function `toggleTagFilter(current, tag)` exported from `web/search.mjs` | Designed the tag filter (chip click) as pure client-side state over the already-fetched prompts+tags list (`web/index.html`'s `selectedTag` variable, re-filtered in `renderList` via `Array.prototype.filter`) — no server call exists in the toggle path for a DB round trip to prove anything about. Per rules/06-TESTS.md's cheapest-mechanism ordering, a pure function is cheaper and *more* precise than an integration test here: it isolates exactly the toggle decision AC-005 names ("the filter fails to clear on a second click") without a real prompt/tag fixture or network call. The function lives in `search.mjs` (not a new module — same file `searchPrompts` was already extending) and is imported by both `index.html`'s chip click handler and the test, so it has the normal two-caller shape SL-001/SL-002's existing exports already use (GATE-MINIMAL M2 is not violated: it is not a one-caller abstraction). This was the RED-phase-provable path: written first as a deliberately wrong stub (`(current, tag) => tag`, never clears), confirmed red on a real assertion, then implemented and mutation-verified in this worktree without needing the DB — unlike T-I-008/009/014, it did not have to wait for the integrator's migration. |
| ASM-010 | Fixture strategy: every new integration test in `tests/tags.test.mjs` uses a `Date.now()`-suffixed title with a single plain `POST` (asserting `201`), not the `POST`-then-on-`409`-`PATCH` pattern `tests/versions.test.mjs` uses for `Version Fixture` / `Immutable Fixture` | Those two fixtures are reused *because* their tests are specifically about title-uniqueness/immutability behavior across re-runs. None of T-I-008/009/014 tests title uniqueness — each just needs one throwaway prompt to hang tags off of — so a `Date.now()` suffix (matching `versions.test.mjs`'s `Fresh Version Fixture ${Date.now()}` pattern for its own fresh-insert cases) gives a guaranteed-fresh row every run with less code than the 409-handling wrapper, and avoids accumulating same-named rows the dedup migration would later have to sweep up (SPEC-0002's RISK-002 precedent). |
| ASM-011 | T-I-008 (AC-001, "save with tags `sdd, Review, sdd` → exactly two rows") sends the **already** trimmed/lowercased/deduplicated pair `[{tag:"sdd"}, {tag:"review"}]` directly to `POST /tag`, rather than replaying `web/index.html`'s comma-string parsing inside the test | SPEC-0004 7.1 places the trim/lowercase/dedupe transform client-side by design — the migration's `primary key (prompt_id, tag)` is exact-string, not `lower(tag)`-folded (unlike `prompt_title_unique`'s functional index), so the database provides no case-fold guarantee to test against. An integration test hitting the REST API directly cannot execute `index.html`'s inline `<script type="module">` (no DOM in `node --test`), so it can only prove what it actually sends. What it proves, correctly, is the storage/round-trip contract (PROP-005) and PK-level dedup for the transform's *output* — not the transform itself. The transform (`parseTagInput`, 12 LOC, one caller: the save-form handler) has no dedicated unit test — a second caller would be needed to justify extracting/testing it separately (rules: "three instances earn an abstraction, two is a coincidence"; here there's one) — so it is covered instead by the Definition of Done's browser drill, consistent with the cheapest-mechanism ladder (lint/type-level correctness is self-evident for a 4-line trim/lower/Set-dedupe loop; a test would duplicate what the browser drill already checks end-to-end). |
| ASM-012 | T-I-009 (AC-002, tag filter) queries `prompt.tag` directly (`tag?tag=eq.sdd&select=prompt_id`) rather than the embedded `prompt?select=...,tag(tag)` shape `index.html`'s `refreshList` uses | Proves the same underlying data-model conservation property (PROP-003: a tag-to-prompt row exists iff that prompt carries the tag) that the client's embed and client-side filter both depend on, "real query against real rows" as spec section 8 asks for, without coupling the test to the client's specific fetch shape — the client's actual filtering (chip click) never re-queries the server at all (see ASM-009), so there is no server-side "filter" call to test directly; the tag table's row-level correctness is the real contract underneath it. |
| ASM-013 | `index.html`'s `refreshList` embeds tags via PostgREST resource embedding, `select=title,body,tag(tag)`, relying on the `prompt_id` foreign key PostgREST auto-detects | Cannot be exercised live in this worktree — the HARD DATABASE RULE forbids applying the migration, so `prompt.tag` does not exist yet against the shared database and no browser drill can run. This is the standard PostgREST embed syntax for a to-many relationship in the same schema (headers already set `Accept-Profile: prompt`), matching how `prompt_version` would be embedded the same way; flagged here so the integrator's post-migration browser drill (Definition of Done) specifically confirms the embed resolves as expected before sign-off. |
| ASM-014 | No client-side `maxlength` mirrors the 100-char tag `CHECK` constraint on the `#tags` input | No AC asks for client-side length feedback (only AC-006's server-side `400`/`23514`, owned by T-I-014); adding one would be an unrequested UI affordance this slice's scope (7.3's "tag entry" line) doesn't name. RISK-001 already records the 100-char bound itself as an assumption; this is the same call applied to the input element. |

## 12. Definition of Done

- [ ] T-I-008..010, T-I-014, T-U-013..014 green; red output recorded first.
- [ ] T-I-011 (cascade) run as an integrator drill, evidence recorded.
- [ ] Ledger rows predate tests; mutation-verified dates recorded.
- [ ] Existing T-U-001..005 (SL-001) still pass unmodified — no existing assertion changed, only new cases added.
- [ ] Browser drill: AC-001 (tag entry), AC-002/AC-005 (filter/clear), AC-003/AC-004 (tag search + ranking) on the real page.
- [ ] PRD FR-012 → `done`; FR-006 → `done` (title+body+tags, full); change-log entry — integrator applies.
- [ ] DFD/SYSTEM-REQUIREMENTS updated: new table, new grant/policy shape (ownership via parent row).
- [ ] Spec moved to `done/`, dates set.
