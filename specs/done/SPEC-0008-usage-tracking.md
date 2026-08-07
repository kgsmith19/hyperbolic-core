---
title: Usage tracking on copy
spec_id: SPEC-0008-usage-tracking
slice: SL-007
status: done
created: 2026-08-07
owner: Kyle
completed: 2026-08-07
traces: [FR-011]
---

# SPEC-0008: Usage tracking on copy

## 1. In one sentence

Every time a rendered prompt is copied, one row is written to a new `prompt.usage` table naming the prompt, its version, and when.

## 2. Why this, why now

FR-011, `not-started` since the PRD's first draft. Depends only on SL-002 (render/copy must exist to instrument) and SL-004 (a `version_no` to name), both already shipped — this slice was buildable the moment those landed and simply hadn't been picked up.

## 2.1 A contradiction found while scoping this, not resolved here

The PRD's slice-plan row for SL-007 delivers both FR-011 and NFR-010. `NFR-010` reads: *"Every render must write one `core.run` row and one `core.cost` row with wall-clock time."* This repo's own `CLAUDE.md` says, in its "Never" section: *"Never write to any schema except `prompt` (cross-schema writes belong to the owning repo; reads of `core` arrive in SL-007)."*

Those two statements cannot both hold for this repo. `NFR-010` as worded requires a write into `toolbelt`'s `core` schema; `CLAUDE.md` forbids writing anywhere but `prompt`, without exception. This is not a new decision this slice is making — it is a standing contradiction in the PRD that scoping SL-007 exposed. Per this repo's own STOP conditions ("a spec contradicts the PRD"), the honest move is to report it, not silently pick a side.

**This spec delivers FR-011 only.** `NFR-010` stays `not-started`, explicitly, with this note attached, until Kyle decides the actual mechanism (a `core`-side RPC that `toolbelt` exposes and this repo merely *calls* rather than writes to directly? `toolbelt` reading `prompt.usage` itself and deriving `core.run`/`core.cost` from it? Rewording `NFR-010` to name `prompt.usage` instead? All are real options with real tradeoffs; none is this implementer's to pick unilaterally).

Also stale, found the same way: `docs/SYSTEM-REQUIREMENTS.md` `SR-04` says *"Reads of `core` begin in SL-007."* This slice reads nothing from `core` either. Corrected in section 7.4.

## 3. Scope

### 3.1 In scope

- Table `prompt.usage`: `prompt_id`, `version_no` (composite-FK'd to `prompt.prompt_version`, so a usage row can never name a version that was never actually created), `config_name` (nullable — see 3.2), `user_id`, `created_at`
- Writing one `prompt.usage` row every time the copy control succeeds (the same click FR-007 already instruments for the clipboard)
- The prompt object the render panel already has extended with its current `version_no`, read from the existing list query

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| `core.run`/`core.cost` writes (`NFR-010`) | Forbidden by this repo's own `CLAUDE.md`; a real architecture decision this implementer cannot make unilaterally | Section 2.1; Kyle |
| Populating `config_name` with a real value | `FR-008` (named configurations) is `not-started`; nothing exists yet for a user to select | `FR-008`'s own slice; this column exists now so `FR-008` does not need a schema migration later, and stays `null` until then |
| A UI count display ("counts are visible" per the slice-plan blurb) | `FR-011`'s own acceptance criterion only requires the count be *readable*, not rendered — a REST query already answers it; no `AC` demands a DOM element for it | A later slice, if Kyle wants a visible number rather than a query |
| Deleting or editing a usage row | No `AC` asks for it; a usage log is a record of what happened, not a working set | Never, by design — same posture as `prompt.prompt_version` (`NFR-005`) |
| Retention / aggregation past 365 days | `DR-005` names a retention policy but no slice builds the job yet, same as `toolbelt`'s own `core.event` (`OOS-005`-equivalent gap there) | A later slice, when `prompt.usage` has enough real rows to make it concrete |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A saved prompt at version 1 | Its render panel's copy control is activated twice | Two rows exist in `prompt.usage` for that prompt, each naming `version_no=1`, with two distinct `created_at` timestamps | FR-011 |
| AC-002 | A saved prompt exists, currently at version 1 | A row is inserted into `prompt.usage` naming `version_no=2` for it (a version that was never created) | The insert fails with Postgres error code `23503` (foreign key violation) and no row is created | FR-011 |

AC-002 is the failure case.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-010 | Every `prompt.usage` insert ends in success or a named error (`23503` bad `prompt_id`/`version_no` pair, `23502` a missing required column); never a crash or a partial row. | Error totality | Every column combination valid and invalid per the table's `not null` columns and composite FK | FR-011 |
| PROP-011 | A usage row, read back by its `id`, returns exactly the `prompt_id`, `version_no`, and `config_name` (`null` today) it was inserted with. | Round-trip | The rows AC-001 creates | FR-011 |
| PROP-012 | Invariant: every `prompt.usage` row's `(prompt_id, version_no)` pair always names a version that actually exists in `prompt.prompt_version`. | Invariant | All usage rows | FR-011 |
| PROP-013 | Idempotence: none applies, by design. Usage is an append-only event log; copying the same prompt twice legitimately creates two rows, not one — AC-001 tests exactly this. | Idempotence | n/a | FR-011 |
| PROP-014 | Order independence: none applies. Two usage inserts do not interact; either order produces the same final row set. | Order independence | n/a | — |
| PROP-015 | Oracle / model: FR-011's own acceptance criterion ("copied twice → count is 2, two rows with distinct timestamps") is the oracle; AC-001 asserts against it directly. | Oracle / model | FR-011's stated AC | FR-011 |
| PROP-016 | Metamorphic: none applies beyond PROP-018's monotonicity below — no numeric input this slice transforms. | Metamorphic | n/a | — |
| PROP-017 | Conservation: none demanded. `count(prompt.prompt)` is trivially unchanged by a `prompt.usage` write (a different table, no shared trigger); not separately tested, same reasoning as `toolbelt` SPEC-0000 PROP-007. | Conservation | n/a | — |
| PROP-018 | Monotonicity: a prompt's usage count never decreases over time (append-only, no delete grant). AC-001 (two copies → count 2) is the non-vacuous instance of this; not tested as a separate property beyond it. | Monotonicity | n/a | — |

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~45 (migration ~20, down ~2, `index.html` delta ~15, `panel.mjs` delta ~5) | 300 | within |
| Test LOC | ~50 (`tests/usage.test.mjs`) | 200 | within |
| New modules | 0 | 2 | within |
| Source files touched | 4 (migration, down migration, `index.html`, `panel.mjs`) | 3 | **exceeds by 1** |
| Test files touched | 1 (`tests/usage.test.mjs`, new) | 3 | within |
| New tables | 1 (`prompt.usage`) | 1 | within |
| New columns | 5 (`id`, `prompt_id`, `version_no`, `config_name`, `created_at`; `user_id` is 6th) | 6 | within, at ceiling |
| New tests | 2 | 8 | within |

**Budget breach, reported per this repo's own protocol (never self-approved):** source files touched is 4 against a ceiling of 3. The two application files (`index.html`, `panel.mjs`) are not splittable into separate slices — the current `version_no` has to be read into the prompt object (`index.html`'s `refreshList`) before the copy handler that uses it (`panel.mjs`) can write anything meaningful, and both are needed for one coherent, testable behavior. Counting the migration/down-migration pair as one changeset (the convention SPEC-0004 6 used: "3 (migration, `search.mjs`, `index.html`) ... 4 physical files if counted separately") brings this to 3, within budget. Flagged explicitly rather than silently applying that convention, since SPEC-0004 stated it as a declared choice, not a blanket rule.

## 7. Changes

### 7.1 Data

`supabase/migrations/<ts>_prompt_create_usage.sql` (+ `_down.sql`):

```sql
create table prompt.usage (
  id          uuid primary key default gen_random_uuid(),
  prompt_id   uuid not null,
  version_no  integer not null,
  config_name text,
  user_id     uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (prompt_id, version_no)
    references prompt.prompt_version(prompt_id, version_no)
    on delete cascade
);
grant select, insert on prompt.usage to authenticated;
-- No update or delete grant: append-only, same posture as prompt_version (NFR-005's principle).
alter table prompt.usage enable row level security;
alter table prompt.usage force row level security;
create policy owner_select on prompt.usage for select using (user_id = auth.uid());
create policy owner_insert on prompt.usage for insert with check (user_id = auth.uid());
```

No separate FK to `prompt.prompt(id)`: the composite FK to `prompt_version(prompt_id, version_no)` already implies a real prompt, since every `prompt_version` row itself cascades from `prompt.prompt`. `on delete cascade` here means a future prompt-delete capability (none exists yet) would cascade through `prompt_version` into `usage` automatically, with no separate mechanism to add later.

### 7.2 Application

`web/index.html`'s `refreshList` query gains an embedded, limited-and-ordered `prompt_version(version_no)` so each fetched prompt object carries `currentVersion` (its highest `version_no`) without a second round trip. `showPrompt` passes the module's existing `api` closure into `buildRenderPanel(prompt, api)`.

`web/panel.mjs`'s copy handler, after the clipboard write and status update already there, adds one line: `await api("usage", { method: "POST", body: { prompt_id: prompt.id, version_no: prompt.currentVersion } })`. No new function extracted — one call site, matching this repo's "no abstraction with one caller" rule the same way `tags.mjs`'s inline pattern already does.

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/<ts>_prompt_create_usage.sql` / `_down.sql` | create | AC-001, AC-002 |
| `web/index.html` | edit | `currentVersion` embed; pass `api` to `buildRenderPanel` |
| `web/panel.mjs` | edit | The usage write itself |
| `tests/usage.test.mjs` | create | AC-001, AC-002 |

### 7.4 Docs corrections found while scoping (not new decisions)

`docs/SYSTEM-REQUIREMENTS.md` `SR-04` currently reads "Reads of `core` begin in SL-007" — stale; this slice reads nothing from `core`. Corrected to describe what this slice actually does.

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-A-005 | acceptance | AC-001, PROP-011 | A prompt copied twice does not produce two distinct-timestamp usage rows | End-to-end through the real API is the AC as written | Only test that reads back a usage count | Never; FR-011's own stated guarantee |
| T-I-016 | integration | AC-002, PROP-012 | A usage row is stored naming a version that was never created | The composite FK is the mechanism; this proves it is wired | Only test that writes an out-of-range `version_no` | Never; keeps usage history honest |

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Accepted by |
|---|---|---|---|---|---|
| RISK-004 | `NFR-010` stays unbuilt and unresolved after this slice ships, so `SL-007`'s slice-plan row is only half-delivered. | certain | none this slice (the half that ships is real and correct); the observability gap NFR-010 wanted is real and unaddressed | Reported in section 2.1 rather than worked around | Kyle |

## 10. Rollback

Down migration drops `prompt.usage`; revert the `index.html`/`panel.mjs` commit. No data survives rollback beyond the dropped table itself.

## 11. Assumptions made during implementation

| ID | Assumption | Why |
|---|---|---|
| ASM-015 | `prompt.usage`'s `config_name` is a bare nullable `text` column, not a foreign key to a `configuration` table | `FR-008` (named configurations) is `not-started`; no such table exists yet to reference. A `text` column needs no migration when `FR-008` ships — that slice adds the real table and, if needed, its own FK; this column just starts getting populated. |
| ASM-016 | `web/index.html`'s `refreshList` scopes the `prompt_version` embed with `&prompt_version.order=version_no.desc&prompt_version.limit=1` (PostgREST's per-embed order/limit query params) rather than fetching full version history and taking the max client-side | Cheaper: one round trip either way, but this sends less data over the wire. **The "every prompt already has a version row, no defensive fallback needed" half of this assumption was wrong** — the live browser drill crashed with `TypeError: Cannot read properties of undefined (reading 'version_no')`, because 21 prompts created before SL-004's versioning trigger existed (02:13–02:48 UTC 2026-08-07, all SL-000/SL-002-era fixtures) had zero `prompt_version` rows. Not worked around in the client (a fallback would have hidden real data drift); fixed at the source instead — see ASM-018. This is exactly why it was verified live rather than left as an unverified worker note: the assumption was false, and only running it against real data caught that. |
| ASM-017 | The usage write is `await`ed inside the copy handler, after `status.textContent = "Copied!"` is already set, with no `try`/`catch` around it | Matches the handler's existing error-handling posture exactly — `navigator.clipboard.writeText` above it has none either, so this call is no more fragile than code already shipped. Placing it after the status update means a slow or failed write never delays or blocks the user's copy confirmation, which is the action FR-007 actually promises within 1 second. |
| ASM-018 | The migration backfills a synthetic `version_no=1` row (from each affected prompt's own current `body`/`user_id`/`created_at`) for every pre-SL-004 prompt with zero `prompt_version` rows, rather than making the client tolerate an empty embed | A client-side fallback (e.g. `?? 1`) would let a `prompt.usage` row claim `version_no=1` for a prompt that, per the database, never actually had a version 1 recorded — reintroducing the exact problem the composite FK (SR-25) exists to prevent, just one layer up. Backfilling makes the invariant SL-004 always intended ("every prompt has at least one version") actually true for all 21 legacy rows, the same "fix the data, not a workaround" precedent `SPEC-0002`'s duplicate-title dedup already set on this same table family. The down migration deliberately does not revert this backfill — see its own comment. |

## 12. Definition of Done

- [x] T-A-005, T-I-016 green; red recorded first (`PGRST205`, table not found — a real 404, not a collection/import error) before the migration existed.
- [x] Ledger rows predate the tests; mutation-verified 2026-08-07. T-I-016: dropped the composite FK, red (`201` instead of `409`), restored. T-A-005 (and, incidentally, T-I-016 a second way): dropped `owner_select`, both went red `403` (`Prefer: return=representation` needs read-back permission on any write — a real, secondary finding, not just T-A-005's own mechanism), restored.
- [x] Existing suite still passes unmodified: 45/45 green, 5.4s, after every change including the backfill.
- [x] Browser drill, 2026-08-07 (Chromium via the Node-relay technique, clipboard permissions granted explicitly since headless Chromium otherwise hangs on `navigator.clipboard`): opened the real `Render Drill 1786072869293` fixture, filled both variables, clicked copy. Clipboard read back `Hello Kyle, repo is prompt-organizer.` — exact, zero console errors. Queried `prompt.usage` afterward: two real rows for that prompt, `version_no=1`, real distinct timestamps, written by the actual click path, not the test suite. First run crashed on a real defect (see ASM-016/018), fixed, then passed clean.
- [x] PRD FR-011 → `done`; NFR-010 → `blocked` (not `not-started`, which reads as merely unscheduled — this is a standing contradiction with `CLAUDE.md`, not a scheduling gap) with section 2.1 referenced directly in its PRD row; change-log entry v0.1.8.
- [x] `docs/SYSTEM-REQUIREMENTS.md` SR-04 corrected (no longer claims this slice reads `core`); SR-25, SR-26 added for `prompt.usage`. `docs/DATA-FLOW-DIAGRAM.md` F-8's "no network hop" note left accurate for render itself; new F-10 for the usage write; data-at-rest table gained `prompt.usage`.
- [x] Spec moved to `done/`, dates set.
