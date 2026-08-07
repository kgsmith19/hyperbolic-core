---
title: Prompt Organizer System Requirements
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
traces: [FR-001, NFR-003, NFR-004, NFR-005, NFR-006, NFR-007, NFR-009, CON-001]
---

# System Requirements

What the system must be. What it must do lives in `docs/PRD.md`.

## 1. Runtime shape

| ID | Requirement | Value | Verified by |
|---|---|---|---|
| SR-01 | Lives in the `toolbelt` Supabase project, schema `prompt` only. No project of its own. | project ref `woltgcggxaehtuypkxqk` | CON-001; `information_schema` |
| SR-02 | No application server. The page and tests call Supabase's own PostgREST and GoTrue directly. | 0 custom services | No server code exists in this repo |
| SR-03 | The web surface is one static HTML file; no framework, no build step, zero dependencies. | 1 file, 0 libraries | No `package.json` exists |
| SR-04 | This repo writes only to schema `prompt`. Reads of `core` begin in SL-007. | 1 schema | Code inspection; grants |

## 2. Security

| ID | Requirement | Mechanism | Verified by |
|---|---|---|---|
| SR-05 | RLS enabled **and forced** on every `prompt.*` table; rows are owner-scoped. | `force row level security` + `owner_all` policy on `user_id = auth.uid()` | T-I-002, T-I-003; `pg_class` |
| SR-06 | The grant surface is the narrowest that satisfies the shipped slices: today `SELECT` (anon, authenticated) and `INSERT` (authenticated). No `UPDATE` or `DELETE` grant exists at all. | Postgres grants | `information_schema.role_table_grants` |
| SR-07 | Only the anon key appears in this repo; it is public by design and RLS is the boundary. The service-role key never appears anywhere. | Key choice + grep | GATE-SHIP SH6 |
| SR-08 | Prompt bodies (confidential, DR-002) reach only the Supabase project; no other host. | The page's two `fetch` targets | Code inspection of `web/index.html` |

## 3. Data integrity

| ID | Requirement | Mechanism | Verified by |
|---|---|---|---|
| SR-09 | Title length 1–200 and body length 1–100,000 are enforced in the database, not only the UI. | `CHECK` constraints | T-I-001 |
| SR-10 | Every row carries its owner; ownership defaults to the authenticated caller and cannot be null. | `user_id uuid not null default auth.uid()` | Column definition |
| SR-11 | A stored body is returned byte-identical: template tokens, fences, newlines, non-ASCII untouched. | Postgres `text` + PostgREST JSON, proven end to end | T-A-001 |

## 4. Operations

| ID | Requirement | Value | Verified by |
|---|---|---|---|
| SR-12 | Every migration has a down migration that removes exactly what the up added, tested against the live project. | 1 of 1 | T-A-002 drill, 2026-08-07 |
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
