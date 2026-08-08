---
title: Named configurations
spec_id: SPEC-0011-configurations
slice: SL-005
status: done
created: 2026-08-08
owner: Kyle
completed: 2026-08-08
traces: [FR-008]
---

# SPEC-0011: Named configurations

## 1. In one sentence

A configuration is a named, saved set of variable values plus included-section ids for one prompt; selecting it fills the render panel the same way typing would.

## 2. Why this, why now

FR-008, `not-started` since the PRD's first draft, `Must` priority, blocking UC-003 ("keep a lean and a full version of one prompt"). Depends on SL-003 (sections) and SL-004 (versions, unrelated but same table family) — both shipped. Q-001 already answered in the PRD: a configuration belongs to one prompt, not shared.

## 3. Scope

### 3.1 In scope

- Table `prompt.configuration`: `prompt_id`, `name`, `values` (jsonb), `sections` (text array) — same shape as `prompt.tag`: composite primary key `(prompt_id, name)`, no owner column, ownership via `EXISTS` against the parent `prompt.prompt` row (SR-23's pattern, reused rather than reinvented)
- Saving the render panel's current variable values and checked sections as a named configuration
- Selecting a saved configuration fills the variable inputs and section checkboxes

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| Updating or deleting a saved configuration | Not asked for by FR-008's AC or UC-003; narrowest grant surface that satisfies this slice, same posture SL-000/SL-006 shipped with (`SELECT`, `INSERT` only) | A later slice, if resaving/removing is actually wanted |
| Rejecting a duplicate `(prompt_id, name)` with a friendly message | The composite primary key already rejects it (`23505`) — a schema constraint, the cheapest mechanism on CLAUDE.md's own ladder, needs no test of its own (every other PK'd table already proves Postgres enforces its keys) | N/A |
| Warning when a configuration references a section id no longer in the body | Not in FR-008's objective AC (UC-003's narrative mentions it, but the AC does not); `applyConfigValues` already only applies values for names still present, so a stale section id just checks a box that renders nothing extra, no corruption | A later slice, if this is ever actually confusing in practice |
| Sharing a configuration across prompts | PRD Q-001 answered: belongs to one prompt | Never, unless a second prompt actually wants it |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A configuration `{REPO: "toolbelt"}` values and `["a"]` sections, and the current body still has variable `REPO` and `NAME` | `applyConfigValues` is called with the config's values and the current variable names `[REPO, NAME]` | Returns `{REPO: "toolbelt"}` — `NAME` absent, not overwritten with anything | FR-008 |
| AC-002 | A configuration is saved via `POST` with `values: {REPO: "toolbelt"}`, `sections: ["a"]` | It is read back by `prompt_id` and `name` | `values` and `sections` equal exactly what was written | FR-008 |
| AC-003 | User A's prompt has a saved configuration | User B requests configurations for that `prompt_id` | The response is `[]` — user B sees nothing | FR-008, NFR-003 |

## 5. Properties (walked; only the non-vacuous ones get their own row)

| ID | Property | Kind | Traces |
|---|---|---|---|
| PROP-028 | Round-trip: a saved configuration's `values`/`sections` read back exactly (AC-002) | Round-trip | FR-008 |
| PROP-029 | Invariant: `applyConfigValues` never returns a key absent from the current variable names — it can only narrow a configuration's values, never widen them | Invariant | FR-008 |
| PROP-030 | Idempotence, order independence, oracle/model (AC-001 is the oracle), conservation, monotonicity: none apply beyond what AC-001..003 already state — no counter, no ordering-sensitive input, no multi-step sequence | — | — |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~55 (migration ~15, down ~1, `web/index.html` +6, `web/panel.mjs` +35) | 300 | within |
| Test LOC | ~70 (`tests/configuration.test.mjs` ~55, `tests/panel.test.mjs` ~15, new) | 200 | within |
| Source files touched | 3 (migration+down as one changeset, `index.html`, `panel.mjs`) | 3 | within, at ceiling |
| Test files touched | 2 (both new) | 3 | within |
| New tables | 1 | 1 | within |
| New columns | 5 (`prompt_id`, `name`, `values`, `sections`, `created_at`) | 6 | within |
| New tests | 3 | 8 | within |
| New UI surfaces | 1 (a select-to-apply plus a name-and-save control, one coherent surface on the existing render panel) | 1 | within, at ceiling |
| New libraries | 0 | 0 | within |

## 7. Changes

### 7.1 Data

```sql
create table prompt.configuration (
  prompt_id  uuid not null references prompt.prompt(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  values     jsonb not null default '{}'::jsonb,
  sections   text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  primary key (prompt_id, name)
);
grant select, insert on prompt.configuration to authenticated;
alter table prompt.configuration enable row level security;
alter table prompt.configuration force row level security;
create policy owner_select on prompt.configuration for select using (
  exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
);
create policy owner_insert on prompt.configuration for insert with check (
  exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
);
```

Down: `drop table prompt.configuration;`

### 7.2 Application

`web/index.html`'s `refreshList` embeds `configuration(name,values,sections)` alongside the existing `tag`/`prompt_version` embeds; `allPrompts` carries `configurations`.

`web/panel.mjs` gains `applyConfigValues(values, names)` (pure) and a small DOM block, split out as its own function (`addConfigControls`, matching the file's existing `addVariableInputs`/`addSectionBoxes` split for the 40-line function ceiling): a `<select>` of saved configuration names that fills `inputs`/`boxes` on change, and a name input plus "Save as configuration" button that `POST`s the panel's current state.

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/<ts>_prompt_create_configuration.sql` / `_down.sql` | create | AC-002, AC-003 |
| `web/index.html` | edit | `configurations` embed |
| `web/panel.mjs` | edit | `applyConfigValues`, select/save controls |
| `tests/configuration.test.mjs` | create | AC-002, AC-003 |
| `tests/panel.test.mjs` | create | AC-001 |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper |
|---|---|---|---|---|
| T-I-019 | integration | AC-002 | jsonb/array column mangles a round trip | Needs the real API and storage |
| T-I-020 | integration | AC-003 | Non-owner reads another user's configurations | RLS needs a real second identity, per-table |
| T-U-028 | unit | AC-001 | Wrong values applied, or a stale name leaks through | Pure function, cheapest level |

## 9. Rollback

Down migration drops `prompt.configuration`. Revert the `index.html`/`panel.mjs` commit. No other table is touched.

## 10. Definition of Done

- [x] T-I-019, T-I-020, T-U-028 red before the migration/code existed (`404`, table not found for the two DB tests; a real assertion mismatch for the pure-function stub), green after.
- [x] Ledger rows mutation-verified 2026-08-08 (see `specs/TEST-LEDGER.md` GATE-LEDGER self-check): grant-revoke reddened both DB tests; an opened `owner_select` policy reddened T-I-020 alone, discriminating RLS from the grant; `applyConfigValues`'s guard removal reddened T-U-028.
- [x] Existing suite still green, unmodified: 52/52 (`node --test "tests/*.test.mjs"`).
- [x] PRD FR-008 → `done` (v0.1.11) — the last remaining `Must`-priority requirement. `docs/SYSTEM-REQUIREMENTS.md` SR-29 added; `docs/DATA-FLOW-DIAGRAM.md` gains F-13 and `prompt.configuration` in data-at-rest.
- [x] Live browser drill **not completed**, same sandbox networking limitation recorded in SPEC-0010's Definition of Done. The select-to-apply and save-as controls issue the identical `GET`/`POST` shapes `T-I-019`/`T-I-020` already verify end to end, and `applyConfigValues` (the actual fill-in decision) is unit-tested directly. Flagged as a follow-up drill, not claimed as done.
- [x] Maintenance follow-up (Issue #11) rerun attempted 2026-08-08 in a real Chromium session from this sandbox and still blocked by environment egress (`ERR_NAME_NOT_RESOLVED` / `TypeError: Failed to fetch` at live Supabase sign-in). Configuration save/apply remains API-verified but browser-unverified in this execution environment.
- [x] Spec moved to `done/`, dates set.
