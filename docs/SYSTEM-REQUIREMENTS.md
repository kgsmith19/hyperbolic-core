---
title: Prompt Organizer System Requirements
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-08
owner: Kyle
traces: [FR-001, FR-002, FR-003, FR-004, FR-007, FR-008, FR-010, FR-011, FR-012, FR-013, FR-014, NFR-003, NFR-004, NFR-005, NFR-006, NFR-007, NFR-009, NFR-010, CON-001]
---

# System Requirements

What the system must be. What it must do lives in `docs/PRD.md`.

## 1. Runtime shape

| ID | Requirement | Value | Verified by |
|---|---|---|---|
| SR-01 | Lives in the `toolbelt` Supabase project, schema `prompt` only. No project of its own. | project ref `woltgcggxaehtuypkxqk` | CON-001; `information_schema` |
| SR-02 | No application server. The page and tests call Supabase's own PostgREST and GoTrue directly. | 0 custom services | No server code exists in this repo |
| SR-03 | The web surface is one static HTML file; no framework, no build step, zero dependencies. | 1 file, 0 libraries | No `package.json` exists |
| SR-04 | This repo writes only to schema `prompt` via a direct, schema-qualified statement, without exception. Calling `toolbelt`'s `core.log_run` RPC (SR-27) is not an exception to this: the RPC's own write logic lives in, and is owned by, `toolbelt`'s migration — this repo's code never contains a statement naming `core.run` or `core.cost`. | 1 schema written to directly | Code inspection; grants |

## 2. Security

| ID | Requirement | Mechanism | Verified by |
|---|---|---|---|
| SR-05 | RLS enabled **and forced** on every `prompt.*` table; rows are owner-scoped. | `force row level security` + `owner_all` policy on `user_id = auth.uid()` | T-I-002, T-I-003; `pg_class` |
| SR-06 | The grant surface is the narrowest that satisfies the shipped slices: `prompt.prompt` has `SELECT` (anon, authenticated), `INSERT` (authenticated), and a column-scoped `UPDATE` on `title, body` (since SL-004) plus `is_active` (since SL-011) only (`id`, `user_id`, `created_at` stay unwritable) — never `DELETE`. `prompt.prompt_version` has only `SELECT` and `INSERT`; no `UPDATE` or `DELETE` grant exists on it at all, ever (SR-19). | Postgres grants | `information_schema.role_table_grants` |
| SR-07 | Only the anon key appears in this repo; it is public by design and RLS is the boundary. The service-role key never appears anywhere. | Key choice + grep | GATE-SHIP SH6 |
| SR-08 | Prompt bodies (confidential, DR-002) reach only the Supabase project; no other host. | The page's two `fetch` targets | Code inspection of `web/index.html` |
| SR-18 | Two prompts can never share a title, case-insensitively. | `unique index (lower(title))` on `prompt.prompt` | T-I-004 |
| SR-19 | A stored version row is never modified or deleted, by any caller, ever. | The absence of any `UPDATE`/`DELETE` grant or policy on `prompt.prompt_version` — an absence is the mechanism, not a rule enforced in application code | T-I-006 |
| SR-20 | A duplicate-title rejection (`23505`) does not reveal the conflicting prompt's title or body in its response. | Postgres suppresses the constraint-violation `details` field for a non-superuser role; `message` names only the constraint | Confirmed live 2026-08-07 (SPEC-0002 AC-001); `code` is the tested signal |
| SR-23 | `prompt.tag` carries no `user_id` column of its own; ownership is checked through the parent `prompt.prompt` row on every read and write. | `EXISTS (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())` in both the select and insert policies | T-I-008, T-I-009 |
| SR-24 | A prompt's tags are deleted when the prompt is, with no separate mechanism required. | `prompt_id ... references prompt.prompt(id) on delete cascade` | T-I-011 (integrator drill) |
| SR-25 | A `prompt.usage` row can never name a `(prompt_id, version_no)` pair that was never actually created. | Composite foreign key `(prompt_id, version_no) references prompt.prompt_version(prompt_id, version_no)` — a plain `CHECK` cannot express a cross-table reference | T-I-016 |
| SR-26 | `prompt.usage` is append-only: no caller, ever, can modify or delete a usage row. | No `UPDATE` or `DELETE` grant or policy exists on it, same absence-is-the-mechanism pattern as `prompt.prompt_version` (SR-19) | Code inspection; `information_schema.role_table_grants` |
| SR-27 | Every render logs a run to `toolbelt`'s shared spine, without this repo ever writing a schema-qualified statement against `core.*`. | `POST /rest/v1/rpc/log_run` under `Content-Profile: core` — a function call, not a table write; `toolbelt`'s `core.log_run` owns the actual `INSERT`s | Browser drill, 2026-08-07: a real copy produced a real `core.run`/`core.cost` row pair in `toolbelt`'s project, `wall_clock_ms` matching the render's own measured duration |
| SR-28 | `prompt.prompt.is_active` is a display filter, not a security boundary: an owner can always read her own archived prompt directly by id, the same as any other row she owns. Ownership (RLS) is the only access control this schema has, before and after SL-011. | The `owner_all` policy is unchanged by SL-011 — no new policy exists for `is_active` | T-I-018 |
| SR-29 | `prompt.configuration` carries no `user_id` of its own; ownership is checked through the parent `prompt.prompt` row, the same shape as `prompt.tag` (SR-23) rather than a new pattern. Grant surface is `SELECT`/`INSERT` only — no `UPDATE` or `DELETE`, not asked for by FR-008. | `EXISTS (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())` in both policies | T-I-019, T-I-020 |
| SR-30 | `prompt.render_prompt(p_name, p_config)` is `security invoker`, not `definer`: it inherits the caller's own RLS with no new policy. `EXECUTE` is revoked from `PUBLIC` (Postgres's own default on every new function) and granted to `authenticated` only. | `security invoker`; `revoke execute ... from public` before the `authenticated` grant | T-I-023 (RLS composes through the RPC); T-A-007 (the grant is what's actually load-bearing, not `PUBLIC`'s default) |

## 3. Data integrity

| ID | Requirement | Mechanism | Verified by |
|---|---|---|---|
| SR-09 | Title length 1–200 and body length 1–100,000 are enforced in the database, not only the UI. | `CHECK` constraints | T-I-001 |
| SR-10 | Every row carries its owner; ownership defaults to the authenticated caller and cannot be null. | `user_id uuid not null default auth.uid()` | Column definition |
| SR-11 | A stored body is returned byte-identical: template tokens, fences, newlines, non-ASCII untouched. | Postgres `text` + PostgREST JSON, proven end to end | T-A-001 |
| SR-21 | Every insert and every distinct-value body update writes exactly one `prompt.prompt_version` row; a same-value update (title-only, or body set to its current value) writes none. | An `after insert or update of body` trigger with an in-function distinct-body guard — the guard cannot live in a trigger `WHEN` clause, since Postgres rejects `OLD` references there on a trigger that also fires on `INSERT` | T-I-005, T-A-003, T-I-007 |
| SR-22 | `version_no` increases by exactly 1 per recorded change, starting at 1, no gaps, no reuse. | `coalesce(max(version_no), 0) + 1` computed inside the trigger | T-I-005, T-A-003 |

## 4. Operations

| ID | Requirement | Value | Verified by |
|---|---|---|---|
| SR-12 | Every migration has a down migration that removes exactly what the up added, tested against the live project. | 3 of 3 | T-A-002 (SL-000), the SL-004 round-trip, and the SL-006 round-trip, all drilled 2026-08-07 |
| SR-13 | Migrations rehearse on `lifeos-test` before touching the real project (DDL portion; the PostgREST exposure line cannot run there and is exercised by the red→green transition itself). | topology convention | Rehearsal record in SPEC-0000 |
| SR-14 | The suite runs with the public anon key only; no secret is required or accepted. | 0 secrets | `node --test "tests/*.test.mjs"` |
| SR-15 | Marginal infrastructure cost is $0. | $0 | NFR-007; no new project or service |

## 5. Maintainability

| ID | Limit | Value | Verified by |
|---|---|---|---|
| SR-16 | No source file over 250 lines; no function over 40. | 250 / 40 | `wc -l` (no linter exists; adding one breaches the 0-library budget) |
| SR-17 | Zero runtime dependencies, zero build step, deliberately. | 0 | No manifest exists |

## 6. Explicitly not required

| Not required | Why |
|---|---|
| Availability / latency targets beyond NFR-001/NFR-002 (which activate with their slices) | One user; inherits Supabase's SLA |
| Browser support matrix | One user, one current browser; baseline ES modules and `fetch` only |
| Compliance regime | No regulated data; DR classifications are internal/confidential, protected by SR-05..SR-08 |

## Appendix: GATE-SYSREQ self-check

- [x] Every requirement has an ID, a value, and a verification method.
- [x] Security requirements name mechanisms, not intents.
- [x] Nothing here duplicates a PRD functional requirement.
- [x] "Not required" is non-empty with a reason per line.
- [x] No unfilled placeholder remains.
