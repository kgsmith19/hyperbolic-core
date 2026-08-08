---
title: Archive a prompt (soft delete)
spec_id: SPEC-0010-archive-prompt
slice: SL-011
status: done
created: 2026-08-08
owner: Kyle
completed: 2026-08-08
traces: [FR-014]
---

# SPEC-0010: Archive a prompt

## 1. In one sentence

A boolean `is_active` column on `prompt.prompt` is the delete half of CRUD: archiving sets it `false`, which hides the prompt from the default list and search; nothing is ever actually deleted, matching this schema's existing never-delete posture for versions.

## 2. Why this, why now

The PRD's CRUD story was Create/Read/Update without a Delete — no `DELETE` grant exists anywhere in this schema, by design (SR-06). Asked directly for delete, hard `DELETE` is the wrong mechanism here: `prompt.prompt` cascades to `prompt.prompt_version` and `prompt.tag`, so a real `DELETE` would erase version history, directly contradicting DR-002 ("every version kept forever") and NFR-005. A single active flag gives the same everyday behavior a delete would (the prompt disappears from your list) with none of the data loss, and doubles as the "which version of a prompt is the one you're using" signal the PRD already asked for informally — except that concern is already solved (current version = `max(version_no)`, unchanged by this slice); this flag is about the *prompt*, not the version.

## 3. Scope

### 3.1 In scope

- Column `prompt.prompt.is_active boolean not null default true`
- Column-scoped `UPDATE (is_active)` grant to `authenticated`, same posture as SPEC-0002's `title, body` grant
- Client: a prompt list fetch keeps returning every row (unchanged query shape); a pure function decides which ones to render by default
- Client: one control per prompt to archive/restore it, one page-level checkbox to reveal archived prompts

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| Freeing an archived prompt's title for reuse | Not asked for; `prompt_title_unique` is a global case-folded index with no `where is_active` predicate today, and loosening it is a real, separate decision with its own edge cases (which of two same-titled prompts does a lookup-by-title resolve to?) | A later slice, if Kyle wants title reuse after archiving. T-I-017 pins today's behavior so a future change is a deliberate diff, not silent drift |
| A real `DELETE` | Contradicts DR-002 and NFR-005 (see section 2) | Never, unless the PRD's durability requirements change first |
| Excluding archived prompts at the RLS layer | `is_active` is a display filter, not a security boundary — ownership is the only thing RLS ever gated (NFR-003); an owner can always read her own archived prompt directly by id | N/A — this is a permanent design position, recorded in `docs/SYSTEM-REQUIREMENTS.md` SR-28 |
| Archiving cascading to tags, versions, or usage rows | Nothing about those rows needs to change; they belong to the prompt regardless of its active state | N/A |
| A separate "trash" view or auto-purge after N days | No `AC` demands it; "show archived" already answers "where did it go" | Never, most likely — same reasoning as OOS-006 |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | An active prompt with one version | It is archived (`is_active: false`), then reactivated (`is_active: true`) | After archiving: excluded from an `is_active=eq.true` read, but its row and its one version row are unchanged when read directly by id. After reactivating: included again in the `is_active=eq.true` read | FR-014 |
| AC-002 | An archived prompt titled `X` | A new prompt titled `x` (case-folded duplicate) is created | The create is rejected `409`, `23505` — archiving does not free the title | FR-014, FR-002 |
| AC-003 | User A's active prompt | User B sends `PATCH is_active=false` on it | The update affects 0 rows (RLS silently filters); reading as A afterward shows `is_active: true`, unchanged | FR-014, NFR-003 |

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-019 | Every `is_active` update ends in success (200, possibly 0 rows for a non-owner) or a named rejection (`23514` if a future bound were added — none exists for a boolean); never a crash. | Error totality | true/false, owner/non-owner | FR-014 |
| PROP-020 | Round-trip: `is_active` read back after a write equals exactly what was written; every other column (`title`, `body`, `created_at`) is byte-for-byte unchanged. | Round-trip | AC-001's archive and reactivate writes | FR-014 |
| PROP-021 | Invariant: `count(prompt.prompt)` and `count(prompt.prompt_version)` for the row are identical before and after any `is_active` toggle — archiving inserts or deletes nothing. | Invariant | AC-001 | FR-014 |
| PROP-022 | Idempotence: setting `is_active` to its current value twice produces the same end state, and — since `is_active` is not in the version trigger's watched column list (`update of body`) — appends no spurious version row. | Idempotence | Repeated identical writes | FR-014 |
| PROP-023 | Order independence: n/a — archive-then-reactivate is an intentionally ordered sequence, not two independent operations; AC-001 tests that exact order. | Order independence | n/a | — |
| PROP-024 | Oracle / model: FR-014's own acceptance criterion (hidden when archived, row+versions intact, visible again when reactivated) is the oracle; T-A-006 asserts against it directly. | Oracle / model | FR-014's stated AC | FR-014 |
| PROP-025 | Metamorphic: none beyond PROP-021's conservation, below. | Metamorphic | n/a | — |
| PROP-026 | Conservation: total row count of `prompt.prompt` is conserved across an archive/reactivate cycle — implied by PROP-021, not tested separately. | Conservation | n/a | — |
| PROP-027 | Monotonicity: none applies; `is_active` is a two-state flag, not a counter. | Monotonicity | n/a | — |

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~35 (migration ~6, down ~2, `search.mjs` +4, `index.html` +23) | 300 | within |
| Test LOC | ~110 (`tests/archive.test.mjs` ~85, `tests/search.test.mjs` +12) | 200 | within |
| Source files touched | 3 (migration+down as one changeset, `search.mjs`, `index.html`) | 3 | within, at ceiling |
| Test files touched | 2 (`tests/archive.test.mjs` new, `tests/search.test.mjs` extended) | 3 | within |
| New tables | 0 | 1 | within |
| New columns | 1 (`is_active`) | 6 | within |
| New tests | 4 | 8 | within |
| New UI surfaces | 1 (archive/restore control + show-archived checkbox, one coherent surface) | 1 | within, at ceiling |
| New libraries | 0 | 0 | within |

## 7. Changes

### 7.1 Data

`supabase/migrations/<ts>_prompt_add_is_active.sql` (+ `_down.sql`):

```sql
alter table prompt.prompt add column is_active boolean not null default true;
grant update (is_active) on prompt.prompt to authenticated;
```

Down: `alter table prompt.prompt drop column is_active;` — dropping the column also drops the column-scoped grant tied to it; nothing else to revert.

### 7.2 Application

`web/search.mjs` gains `filterByActive(prompts, showArchived)`: returns `prompts` unchanged if `showArchived`, else only prompts with `isActive !== false`. Pure, one new export, same shape as the existing `toggleTagFilter`.

`web/index.html`: `refreshList`'s select gains `is_active`; `allPrompts` carries `isActive`. `renderList` applies `filterByActive` before the existing tag filter and search. A page-level "Show archived" checkbox toggles `showArchived` and calls `renderList`. `showPrompt` gains one button per prompt, labeled `Archive` or `Restore` depending on `isActive`, that `PATCH`es `is_active` and updates local state.

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/<ts>_prompt_add_is_active.sql` / `_down.sql` | create | AC-001, AC-002, AC-003 |
| `web/search.mjs` | edit | `filterByActive` |
| `web/index.html` | edit | Archive/restore control, show-archived checkbox, `is_active` in the fetch |
| `tests/archive.test.mjs` | create | AC-001, AC-002, AC-003 |
| `tests/search.test.mjs` | edit | `filterByActive` unit test |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate |
|---|---|---|---|---|---|
| T-A-006 | acceptance | AC-001 | Archive/reactivate loses data or fails to hide/show the prompt | End-to-end through the real API is the AC as written | Only full round-trip test |
| T-I-017 | integration | AC-002 | Archiving frees a title for reuse | Needs the real unique index | Only archived-title-collision test |
| T-I-018 | integration | AC-003 | A non-owner can archive another user's prompt | RLS needs a real second identity | Only cross-user test in this file |
| T-U-027 | unit | AC-001 | `filterByActive` leaks or hides the wrong prompts | Pure function; cheapest level | Only test of this decision |

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Accepted by |
|---|---|---|---|---|---|
| RISK-005 | A future slice wants archived-title reuse and has to add a partial unique index, a real migration | possible | low — additive, no breaking change to today's behavior | Recorded in 3.2 and pinned by T-I-017 so the change is deliberate | Kyle |

## 10. Rollback

Down migration drops `is_active` (and its grant with it); revert the `index.html`/`search.mjs` commit. No data loss beyond the dropped column itself — no prompt or version row is ever touched by this slice.

## 11. Definition of Done

- [x] T-A-006, T-I-017, T-I-018, T-U-027 red before the migration/code existed (`PGRST204`, column not found — a real 400, not an import error, and one clean assertion failure for the pure-function stub), green after.
- [x] Ledger rows mutation-verified 2026-08-08 (see `specs/TEST-LEDGER.md` GATE-LEDGER self-check for the full account): grant-revoke reddened T-A-006 and T-I-018; an opened `owner_all` policy reddened only T-I-018, discriminating the RLS mechanism specifically; T-I-017's own assertion mutated (no new mechanism on that call path); T-U-027's `filterByActive` reduced to a no-op.
- [x] Existing suite still green, unmodified: 49/49 (`node --test "tests/*.test.mjs"`).
- [x] PRD FR-014 → `done` (v0.1.10); `docs/SYSTEM-REQUIREMENTS.md` SR-06 extended, SR-28 added; `docs/DATA-FLOW-DIAGRAM.md` gains F-12 and DR-007 in data-at-rest.
- [x] Live browser drill **not completed**, recorded rather than silently skipped: headless Chromium in this session's sandbox cannot reach the live Supabase host (a network-path limitation of this execution environment, not of the code), so the click-through archive/restore flow was not driven end to end in a real browser the way SL-002/SL-007/SL-008 were. The archive button's PATCH call (`prompt?id=eq.<id>`, body `{is_active}`) is the identical shape T-A-006 exercises end to end against the real database, and a static load of `web/index.html` confirmed zero console/page errors with the new import and DOM wiring in place. Flagged as a follow-up drill for whoever next has a working browser path to the project, not treated as equivalent to one.
- [x] Spec moved to `done/`, dates set. **Renumbered from SPEC-0009 to SPEC-0010 during merge**: this slice was built in parallel with an independent session that also claimed `SPEC-0009` (`specs/done/SPEC-0009-log-run-call.md`, NFR-010), and reused `F-11`/`SR-27` for unrelated content. Resolved on merge into `main` by renumbering every reference in this slice's own files (`F-11`→`F-12`, `SR-27`→`SR-28`, PRD version `0.1.9`→`0.1.10`); nothing about SL-011's scope, tests, or schema changed.
