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

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~90 (migration ~25, `search.mjs` delta ~15, `index.html` delta ~50) | 300 | within |
| Test LOC | ~150 | 200 | within |
| New modules | 0 (extends `search.mjs`, does not add a module) | 2 | within |
| Source files touched | 3 (migration, `search.mjs`, `index.html`) | 3 | within |
| Test files touched | 2 (`tests/tags.test.mjs` new; `tests/search.test.mjs` extended) | 3 | within |
| New tables | 1 (`prompt.tag`) | 1 | within |
| New columns | 2 (`prompt_id`, `tag`) | 6 | within |
| New endpoints/UI surfaces beyond the existing page/libraries/third-party | 0 | — | within |
| User stories | 1 (U-001) | 1 | within |
| New tests | 7 | 8 | within |

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

(Implementer fills.)

## 12. Definition of Done

- [ ] T-I-008..010, T-I-014, T-U-013..014 green; red output recorded first.
- [ ] T-I-011 (cascade) run as an integrator drill, evidence recorded.
- [ ] Ledger rows predate tests; mutation-verified dates recorded.
- [ ] Existing T-U-001..005 (SL-001) still pass unmodified — no existing assertion changed, only new cases added.
- [ ] Browser drill: AC-001 (tag entry), AC-002/AC-005 (filter/clear), AC-003/AC-004 (tag search + ranking) on the real page.
- [ ] PRD FR-012 → `done`; FR-006 → `done` (title+body+tags, full); change-log entry — integrator applies.
- [ ] DFD/SYSTEM-REQUIREMENTS updated: new table, new grant/policy shape (ownership via parent row).
- [ ] Spec moved to `done/`, dates set.
