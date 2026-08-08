---
title: toolbelt System Requirements
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-08
owner: Kyle
traces: [FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, NFR-001, NFR-002, NFR-003, NFR-004]
---

# System Requirements

What the system must be, as opposed to what it must do. What it does lives in `docs/PRD.md`.

## 1. Runtime shape

| ID | Requirement | Value | Verified by |
|---|---|---|---|
| SR-001 | The system is one Supabase Postgres project named `toolbelt`. | project ref `woltgcggxaehtuypkxqk`, region `us-east-1`, Postgres 17 | `list_projects` against the Supabase API |
| SR-002 | There is no application server. Clients talk to Supabase's own PostgREST and GoTrue endpoints directly. | 0 custom services | No server code exists in this repo |
| SR-003 | The web surface is one static HTML file with no build step and no framework. | `web/index.html`, 1 file | The file loads from any static file server |
| SR-004 | Tables live only in the `core` or `idea` Postgres schema. | 2 schemas, 14 tables | `information_schema.tables` |

## 2. Interfaces the system depends on

| ID | Interface | Provider | Used for | Failure behavior |
|---|---|---|---|---|
| SR-005 | `POST /auth/v1/token?grant_type=password` | Supabase GoTrue | Exchanging email and password for an access token | Non-200 surfaces the returned message on the page; no idea data is shown |
| SR-006 | `GET /rest/v1/idea` with header `Accept-Profile: idea` | Supabase PostgREST | Reading the idea list | Non-200 leaves the table empty and the section hidden |
| SR-024 | `GET /rest/v1/score` with header `Accept-Profile: idea` | Supabase PostgREST | Reading each idea's scores | Non-200 leaves the section hidden (thrown before render, same as SR-006) |
| SR-025 | `GET /rest/v1/metric_def` with header `Accept-Profile: core` | Supabase PostgREST | Reading metric names to label scores | Non-200 leaves the section hidden, same as SR-024 |
| SR-027 | `GET /rest/v1/dependency` with header `Accept-Profile: idea` | Supabase PostgREST | Reading each idea's dependencies | Non-200 leaves the section hidden, same as SR-024 |

All four are provided by the same Supabase project as the database. None is a third-party integration (PRD section 11).

## 2a. Interfaces the system provides to other tools

| ID | Interface | Consumer | Used for | Failure behavior |
|---|---|---|---|---|
| SR-028 | `POST /rest/v1/rpc/log_run` (`core.log_run`, `security definer`) | Any authenticated tool in the portfolio (first caller: `prompt-organizer`) | Recording one `core.run` row and one `core.cost` row without the caller ever writing directly into `core.*` | A bad `app_id` returns `409`/`23503`, the caller's own responsibility to surface; any other failure is the same class of error a direct `POST /rest/v1/run` would return |

This is the mechanism `prompt-organizer`'s own `CLAUDE.md` names as the boundary: "cross-schema writes belong to the owning repo." `core.run`/`core.cost` are owned here; no other repo's client code should ever contain a schema-qualified write against either.

| ID | Interface | Consumer | Used for | Failure behavior |
|---|---|---|---|---|
| SR-029 | `POST /rest/v1/rpc/purge_old_events` (`core.purge_old_events`, `security definer`) | A daily `pg_cron` schedule; also directly callable by any authenticated caller as a manual backstop | Deleting every `core.event` row older than 90 days, recording each deleted row's month in `core.event_monthly_agg` first | Returns the count of rows deleted; a caller does not need to check `core.event` itself to know the job ran |

## 3. Security requirements

| ID | Requirement | Mechanism | Verified by |
|---|---|---|---|
| SR-007 | Row-level security is enabled **and forced** on all 14 tables. | `alter table ... enable row level security` plus `force row level security` | `pg_class.relrowsecurity` and `relforcerowsecurity` |
| SR-008 | An unauthenticated caller reads zero rows from every table. | RLS policies scoped to the `authenticated` role | T-I-001 |
| SR-009 | `core.run` rows are visible only to the user who created them. | `using (user_id = auth.uid())` | T-I-002 |
| SR-010 | The service-role key never appears in this repo, in a browser bundle, or in git history. | Only the anon key is committed; it is designed for client exposure and RLS is the real boundary | GATE-SHIP SH6 |
| SR-011 | Credentials entered on the idea list page are sent only to the Supabase auth endpoint and are never persisted by the page. | The access token is held in a local variable for the lifetime of the page load; nothing is written to storage or cookies | Reading `web/index.html` |

## 4. Data integrity requirements

| ID | Requirement | Mechanism | Verified by |
|---|---|---|---|
| SR-012 | A `core.run` row cannot reference a tool absent from `core.app`. | Foreign key `run.app_id -> app.id` | T-I-003 |
| SR-013 | A `core.metric_def` row cannot exist without a written gaming risk. | `gaming_risk text not null` | T-I-004 |
| SR-014 | Enum-like columns are `text` with a `CHECK`, never a Postgres `enum` type. | `CHECK (status in (...))` on `app`, `run`, `idea`, `assumption` | `pg_constraint` |
| SR-015 | Every timestamp column is `timestamptz`. | Column types | `information_schema.columns` |
| SR-016 | Money is `numeric`, never a float type. | `core.cost.usd numeric(12,6)` | `information_schema.columns` |
| SR-026 | An `idea.score` row cannot hold a value outside its metric's declared `min_value`/`max_value`. | A trigger, not a `CHECK`: a `CHECK` constraint cannot look up another table, so `idea.enforce_score_bounds()` reads `core.metric_def` on every insert/update | T-I-007, T-I-008 |
| SR-030 | `core.event_monthly_agg.event_count` for a given month never decreases and is never replaced by a later run; each run adds to it. | `on conflict (month) do update set event_count = event_count + excluded.event_count`, not a plain overwrite | T-I-010 |

## 5. Operational requirements

| ID | Requirement | Threshold | Verified by |
|---|---|---|---|
| SR-017 | Every migration has a down migration that removes exactly what the up migration added. | 100% of migrations | A file named `<migration>_down.sql` exists for each; round-trip run once (SPEC-0000 section 12) |
| SR-018 | Re-running the seed migration leaves `idea.idea` at 33 rows. | exactly 33 | `on conflict (id) do nothing`, plus PROP-003 |
| SR-019 | The whole test suite runs without database credentials, using only the public anon key. | 0 secrets required | `node --test "tests/*.test.mjs"` |
| SR-020 | Marginal infrastructure cost is $0 beyond this one Supabase project. | $0 | PRD NFR-002 |
| SR-031 | No `core.event` row is older than 90 days for long; a daily job deletes every row that crosses that age, recording its month in `core.event_monthly_agg` first. | `pg_cron` schedule `core-purge-old-events`, `0 3 * * *`, calling `core.purge_old_events()` | T-A-007 |

## 6. Maintainability limits

| ID | Limit | Value | Verified by |
|---|---|---|---|
| SR-021 | No source file exceeds 250 lines. | 250 | `wc -l` |
| SR-022 | No function exceeds 40 lines. | 40 | Manual count; no linter is configured yet |
| SR-023 | Zero runtime dependencies. Zero build step. | 0 | No `package.json` exists |

SR-023 is why the tests use Node's built-in `node:test` and the page uses native `fetch`: `MAX_NEW_LIBRARIES` is 0 and nothing here has needed to break it.

## 7. Explicitly not required

| Not required | Why |
|---|---|
| Availability or uptime target | Inherits Supabase's own SLA; not controlled by this repo |
| Performance or latency target | One user, 33 rows, no real traffic |
| Horizontal scalability | Single user (PRD CON-003) |
| Browser support matrix | One user, one current browser; the page uses only baseline ES modules and `fetch` |
| Compliance regime | No regulated data; every data item is classified `internal` (PRD section 8) |

## Appendix: GATE-SYSREQ self-check

- [x] Every requirement has an ID, a value, and a verification method.
- [x] No requirement duplicates a PRD functional requirement; these constrain how, not what.
- [x] Every security requirement names its mechanism, not just its intent.
- [x] Every interface names its failure behavior.
- [x] The "not required" section is non-empty and gives a reason per line.
- [x] No unfilled `<placeholder>` remains.
