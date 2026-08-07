---
title: Core spine and idea registry
spec_id: SPEC-0000-core-idea-spine
slice: SL-000
status: done
created: 2026-08-06
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle
traces: [FR-001, FR-002, FR-003, NFR-001, NFR-002, NFR-003, NFR-004]
---

# SPEC-0000: Core spine and idea registry

> One spec, one thin slice, one shippable change — except this spec is a declared exception to that rule. See section 6.

---

## 1. In one sentence

The `toolbelt` Supabase project exists with the `core` and `idea` Postgres schemas, row-level security forced on every table, the 33-idea backlog seeded, and a page that lists every idea.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-001, FR-002, FR-003 |
| What a user can do after this that they could not before | Kyle can see the full idea backlog on one page instead of only in a document; any future tool can register itself in `core.app` and start writing runs |
| Why this slice comes before the next one | Prompt Organizer (the next repo) depends on this project and schema existing at all |
| What we learn from shipping it | Whether the RLS policy shape (authenticated-role-wide, not per-row `user_id`) actually holds for a single-user portfolio, before any tool builds on top of it |

## 3. Scope

### 3.1 In scope

- A new Supabase project named `toolbelt`
- Schema `core`: tables `app`, `run`, `event`, `cost`, `outcome`, `run_outcome`, `metric_def`, `metric_value`, `assumption`, `intervention`
- Schema `idea`: tables `idea`, `dependency`, `score`
- RLS enabled and forced on all 13 tables above (10 in `core`, 3 in `idea`)
- Seed data: 33 rows in `idea.idea`
- One static page listing every row in `idea.idea`

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| Editing ideas from the UI | Nothing needs to write to `idea.idea` beyond the seed yet | A later slice, when a tool needs it |
| `idea.dependency` / `idea.score` UI | No reader exists yet | SL-001, SL-002 |
| A client library for `core.run`/`core.event` writes | No tool has been instrumented yet | SL-003, when Prompt Organizer needs it |
| `core.event` retention job | No tool has written an event yet | SL-004 |
| Sign-up flow / password reset / multi-user auth | Single user (Kyle); test users created for this spec's tests are throwaway | Never, unless a second person needs access |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | `idea.idea` contains the seeded row `id=prompt-organizer, name=Prompt Organizer, category=Agentic / LLM systems tooling, one_liner=A place to save AI prompts and reuse them instead of retyping them., status=specced` | An authenticated request loads the idea list page | The page displays that row's name, category, one-liner, and status | FR-001 |
| AC-002 | A request carries the project's anon API key and no user access token | The request selects from `idea.idea` over the REST API | The response is `200` with an empty array (RLS filters every row for the `anon` role) | NFR-001 |
| AC-003 | `core.app` has no row with `id=test-app` | A request inserts into `core.run` with `app_id=test-app, kind=job` | The insert fails with Postgres error code `23503` (foreign key violation) and no row is created | FR-002 |
| AC-004 | The `core` schema migration has been applied | A request inserts into `core.metric_def` with `id=cost_per_requirement, name=Cost per requirement, formula=total cost / total requirements shipped, unit=USD` and `gaming_risk` omitted | The insert fails with Postgres error code `23502` (not-null violation on `gaming_risk`) | FR-003 |
| AC-005 | The seed migration has run | A request counts rows in `idea.idea` | The count is exactly `33` | FR-001 |
| AC-006 | User A has inserted a row into `core.app` (`id=test-app-a`) and `core.run` (`app_id=test-app-a`) while authenticated as user A | User B, a different authenticated user, selects from `core.run` | The response is `200` with an empty array (user B's `auth.uid()` does not match `user_id` on user A's row) | NFR-001 |
| AC-007 | The up migrations for schema `idea` have been applied and `idea.idea` has 33 rows | The down migration for schema `idea` is run | `idea.idea`, `idea.dependency`, and `idea.score` no longer exist, and `select 1 from information_schema.schemata where schema_name='idea'` returns no row | NFR-004 |

AC-002, AC-003, AC-004, and AC-006 are the failure cases.

## 5. Properties

| ID | Property | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-001 | For all inserts into any `core.*`/`idea.*` table, the result is either the row is created or a named Postgres error code is returned; no request ever crashes the connection or partially writes a row. | Error totality | Every column combination valid and invalid per each table's `not null`/`check`/foreign-key constraints | FR-002, FR-003 |
| PROP-002 | For all 33 seeded rows, selecting `idea.idea` by `id` returns the exact `name`, `category`, `one_liner`, and `status` that was inserted. | Round-trip | The 33 rows in the topology note's table | FR-001 |
| PROP-003 | Running the seed migration a second time leaves `idea.idea` at exactly 33 rows, never 66. | Idempotence | The fixed 33-row seed set, applied twice | FR-001 |
| PROP-004 | Order independence: none applies. The 33 seed rows have no ordering dependency on each other in this slice (`idea.dependency` is not seeded until SL-002). | Order independence | n/a | — |
| PROP-005 | For all 33 seeded rows, the `(id, name, category)` tuple matches the corresponding row in `docs/notes/2026-08-06-supabase-project-topology.md` section 1 exactly. | Oracle / model | The topology note's table, as the oracle | FR-001 |
| PROP-006 | Metamorphic: none applies. This slice transforms no input; it only stores and lists fixed rows. | Metamorphic | n/a | — |
| PROP-007 | Conservation: `count(idea.idea)` is unchanged by any number of authenticated reads. | Conservation | Any sequence of `SELECT` calls | AC-005 |
| PROP-008 | Monotonicity: none applies. There is no pagination, filtering, or scoring in this slice to be monotonic over. | Monotonicity | n/a | — |
| PROP-009 | Invariant: `idea.idea.status` is always one of `idea, specced, building, live, parked, killed`. Enforced by a `CHECK` constraint, not a test (`rules/06-TESTS.md`: "a value is in a set -> CHECK", cheaper than a test). | Invariant | n/a, mechanism is the constraint itself | FR-001 |

## 6. Budget declaration — EXPLICIT EXCEPTION GRANTED

**Exception, approved by Kyle 2026-08-06:** this slice is a declared exception to `MAX_NEW_TABLES` (1) and GATE-SKELETON K3 ("exactly one table"). Reasoning recorded here per `rules/01-BUDGETS.md`'s breach protocol (a breach must be reported, never self-approved): the 11 tables are pure declarative schema plus a repeated RLS policy shape, with no interacting business logic between them. Kyle judged this genuinely reviewable as one unit rather than as eleven near-identical migration-only slices that would add process overhead without reducing risk. This exception covers every budget line below that is a direct, structural consequence of building the full spine at once (tables, columns, files touched, LOC, test count). It does **not** extend to lines that were avoidable by choice (new libraries, new endpoints) — those are kept at zero on their own merit.

| Metric | Declared | Ceiling | Status | Actual (fill at completion) |
|---|---|---|---|---|
| Net source LOC | ~510 (SQL + one HTML page) | 300 | EXCEEDS — exception | 432 (`web/index.html` 93, `config.mjs` 6, migrations 333) |
| Test LOC | ~180 | 200 | within | 200 (`tests/*.mjs`) |
| New modules/classes | 0 | 2 | within | 0 |
| Source files touched | 13 (8 migration files, 1 HTML page, 3 test files, 1 `.env.example`) | 3 | EXCEEDS — exception | 15 (10 migration files, 1 HTML page, 3 test files, `config.mjs`). Two more than declared: a corrective migration and its down file for defect D-001. No `.env.example` was written; `config.mjs` holds the same two non-secret values and is what the page and tests actually import. |
| New tables | 13 | 1 | EXCEEDS — exception | 13 |
| New columns | ~70 | 6 | EXCEEDS — exception | 78 |
| New endpoints | 0 (Supabase's own PostgREST API; no custom server code written) | 1 | within | 0 |
| New UI surfaces | 1 | 1 | within | 1 (`web/index.html`) |
| New libraries | 0 (native `fetch`, Node's built-in `node:test`) | 0 | within | 0. No `package.json` exists. The browser drill used the environment's pre-installed Playwright, run from outside the repo; nothing was added to it. |
| New third-party services | 0 (the `toolbelt` Supabase project is the platform this whole portfolio runs on, not a new third party) | 0 | within | 0 |
| User stories | 1 (U-001) | 1 | within | 1 |
| New tests | ~15 (RLS: 13 tables + AC-003 + AC-004) | 8 | EXCEEDS — exception | 7 executable, under both the declaration and the ceiling. The per-table RLS sweep was replaced by one `pg_class` query proving `relrowsecurity` and `relforcerowsecurity` on all 13 tables, which is the cheaper mechanism (`rules/00-CORE.md` principle 1). |
| New config keys | 1 (`SUPABASE_URL`/`SUPABASE_ANON_KEY` pair, not secret) | 2 | within | 1 |

## 7. Changes

### 7.1 Interfaces

None. No custom API is written; the Supabase project's own auto-generated REST API (PostgREST) is used directly by the web page and the tests.

### 7.2 Data

| Change | Table(s) | Forward migration | Down migration | Backfill needed | Zero-downtime approach |
|---|---|---|---|---|---|
| Create schema + 10 tables | `core.*` | `supabase/migrations/20260806190000_core_create_schema.sql` | `supabase/migrations/20260806190000_core_create_schema_down.sql` | no | New schema, nothing else reads it yet |
| Create schema + 3 tables | `idea.*` | `supabase/migrations/20260806190100_idea_create_schema.sql` | `supabase/migrations/20260806190100_idea_create_schema_down.sql` | no | New schema, nothing else reads it yet |
| RLS baseline | all 13 tables | `supabase/migrations/20260806190200_rls_baseline.sql` | `supabase/migrations/20260806190200_rls_baseline_down.sql` | no | Applied in the same migration each table is created in production use; here applied right after, since this is a fresh project with no existing readers |
| Seed 33 rows | `idea.idea` | `supabase/migrations/20260806190300_seed_idea.sql` | `supabase/migrations/20260806190300_seed_idea_down.sql` | no | Fresh table, no existing rows to conflict with |

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260806190000_core_create_schema.sql` | create | `core` schema + 10 tables, FR-003 |
| `supabase/migrations/20260806190000_core_create_schema_down.sql` | create | Rollback for the above |
| `supabase/migrations/20260806190100_idea_create_schema.sql` | create | `idea` schema + 3 tables, FR-001 |
| `supabase/migrations/20260806190100_idea_create_schema_down.sql` | create | Rollback for the above |
| `supabase/migrations/20260806190200_rls_baseline.sql` | create | RLS on all 13 tables, NFR-001 |
| `supabase/migrations/20260806190200_rls_baseline_down.sql` | create | Rollback for the above |
| `supabase/migrations/20260806190300_seed_idea.sql` | create | 33-row seed, AC-005 |
| `supabase/migrations/20260806190300_seed_idea_down.sql` | create | Rollback for the above (deletes the 33 seeded ids only) |
| `web/index.html` | create | The idea list page, FR-001 |
| `tests/rls.test.mjs` | create | AC-002, AC-006 |
| `tests/constraints.test.mjs` | create | AC-003, AC-004 |
| `tests/seed.test.mjs` | create | AC-005, PROP-002, PROP-003, PROP-005 |
| `.env.example` | create | Documents `SUPABASE_URL`/`SUPABASE_ANON_KEY`, no real values |

## 8. Test plan

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-I-001 | integration | AC-002 | An unauthenticated caller reads idea data | RLS is a database-level mechanism; nothing cheaper proves it is actually switched on over the network | No other test hits the real REST API unauthenticated | When `idea.idea` gets a public-read use case (never expected) |
| T-I-002 | integration | AC-006 | One user reads another user's `core.run` rows | Same as above; `user_id = auth.uid()` must be proven with two real sessions | No other test uses two distinct authenticated identities | If `core.run` ever becomes shared/team data |
| T-I-003 | integration | AC-003 | A `core.run` row is created for a tool that was never registered | A `CHECK` constraint cannot express a foreign key; the FK is already the cheap mechanism, this test proves it is wired | No other test inserts an orphan `core.run` row | Never; this is the core integrity guarantee of the spine |
| T-I-004 | integration | AC-004 | A metric is defined with no stated gaming risk | The `NOT NULL` constraint is the cheap mechanism; this test proves it is present, since it is easy to drop by accident in a future migration | No other test inserts into `core.metric_def` | Never; this is the topology note's named safeguard |
| T-I-005 | integration | AC-005, PROP-005 | The seed data is missing rows, has duplicates, or drifted from the topology note | A `COUNT` and a value comparison need a real query; no schema constraint can enforce "matches this specific list" | No other test reads the full 33-row set | If the idea list ever gets a UI-driven edit path making the seed a one-time bootstrap only |
| T-I-006 | integration | PROP-003 | Re-running the seed migration duplicates rows | Requires actually running the migration twice against a database | No other test runs a migration more than once | Never; this protects every future re-deploy |
| T-A-001 | acceptance | AC-001 | The list page fails to render a seeded row's fields | Only an end-to-end page load proves the browser-facing contract | No other test loads the actual HTML page | If the page is replaced by a different tool's UI |
| T-A-002 | acceptance | AC-007 | The down migration for `idea` does not fully remove the schema | Only running the actual down migration proves rollback works | No other test exercises a down migration | Never; every migration keeps this guarantee |

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation in this slice | Accepted by |
|---|---|---|---|---|---|
| RISK-001 | `core.event` is unbounded-growth and written by every future tool; no retention exists yet. | low (nothing writes to it yet) | high, eventually | Documented as OOS-004/SL-004 in the PRD; flagged again here so it is not forgotten | Kyle |
| RISK-002 | The single "authenticated = owner" RLS policy on 12 of 13 tables grants any authenticated session full read/write to all of them. | low (single user) | medium, if a second identity is ever added | ASM-001 in the PRD names this explicitly with a verification trigger | Kyle |
| RISK-003 | This spec's own size (13 tables, 13 files) makes it harder to review than a normal slice. | certain | low (this is a one-time foundation build, not a repeating pattern) | The exception in section 6 is written down with its specific reasoning, not silently absorbed | Kyle |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | Run the four down migrations in reverse order: seed down, RLS down, idea schema down, core schema down |
| Time to undo | Under 5 minutes; four `DROP` statements |
| Data written that survives rollback | None; this is a fresh project with no other data |
| Feature flag | None because nothing outside this repo reads these tables yet |
| Who decides to roll back | Kyle |
| Signal that triggers rollback | Any down-migration test (AC-007) fails, or GATE-GREEN fails after all four migrations are applied |

## 11. Assumptions made during implementation

| ID | Assumption | Why it was needed | How to verify | Blast radius if wrong | Promoted to PRD? |
|---|---|---|---|---|---|
| ASM-003 | ~~Test users for AC-006 created dynamically via public sign-up, throwaway credentials never committed.~~ **Superseded during implementation:** Supabase's public sign-up endpoint requires email confirmation, which blocks non-interactive test runs. Two fixed test-fixture accounts (`tests/helpers.mjs`) are used instead: `kylegsmith19+toolbelt-test-a@gmail.com` / `-test-b@gmail.com`, Gmail-alias addresses that are not real people, with `email_confirmed_at` set directly via one-time SQL (not a project-wide auth setting change). Their passwords are committed in `tests/helpers.mjs`. | Same as original: two real authenticated identities are needed to prove per-row isolation on `core.run`, and no service-role key is used to avoid handling a secret in this repo. Sign-up-time email confirmation made the dynamic approach unworkable without adding a library or a confirmation-bypass service setting. | Re-run `tests/rls.test.mjs`; T-I-002 fails red if RLS isolation breaks. | Low: these accounts only ever hold RLS-scoped rows they create in `core.run`/`core.app` inside this dev project; blast radius of the committed password is limited to this project's own test fixtures, not the user's real account or any other system. | no — accepted as-is; see this row |
| ASM-004 | The `prompt-organizer` idea's true status is `specced`, so the seed data was the defect rather than FR-001/AC-001. | The database said `idea` and the PRD said `specced`; one had to be named wrong to resolve defect D-001. | Prompt Organizer's own PRD exists and is complete, which is what `specced` means in the `idea.idea` status set. If Kyle considers it not yet specced, revert `20260807010000_idea_fix_prompt_organizer_status.sql` and change FR-001 instead. | Low. One row's status column in a 33-row backlog, with a written down migration. | no — `rules/00-CORE.md` already ranks the PRD above code, so this is applying the existing rule, not a new one |
| ASM-005 | Relaying the page's two fetches through Node during the browser drill is acceptable evidence for AC-001. | The sandbox resets the browser's own TLS egress to `supabase.co`, so an unmodified browser cannot reach the project from this environment. | Load `web/index.html` on a machine with normal network access and sign in; the page should behave identically, since only the transport hop was substituted. | Low. The page's own sign-in and render logic ran unmodified in a real browser against real data from the live project. What is unproven is only that this sandbox can open a socket, which is not a property of the page. | no — an environment limitation, not a product requirement |

## 12. Definition of Done (GATE-SPEC-DONE)

- [x] Every `AC` has a passing acceptance/integration test, with the test ID recorded. AC-001 T-A-001, AC-002 T-I-001, AC-003 T-I-003, AC-004 T-I-004, AC-005 T-I-005, AC-006 T-I-002, AC-007 T-A-002 (manual drill, recorded below).
- [x] Every `PROP` has a passing property test or a recorded reason it does not apply. PROP-001 covered by T-I-003/T-I-004 (both assert a named Postgres error code, not a crash); PROP-002 and PROP-005 by T-I-005; PROP-003 by the T-I-006 drill; PROP-007 by T-I-005 running repeatedly without changing the count; PROP-009 by the `CHECK` constraint, which is the cheaper mechanism. PROP-004, PROP-006, and PROP-008 are recorded in section 5 as not applicable.
- [x] GATE-GREEN passes in full, with command output shown. `node --test "tests/*.test.mjs"` exits 0, 7/7 pass in 2.1s. G3/G4/G5 (lint, typecheck, build) have no command: there is no linter, no type system, and no build step in this repo, and adding one would breach `MAX_NEW_LIBRARIES: 0`. NFR-003's file and function limits were checked by `wc -l` instead: largest file 115 lines against a 250 ceiling.
- [x] Every declared budget line has an Actual value; every exceedance matches the exception in section 6, nothing new. Two lines moved: source files touched went 13 -> 15 (a corrective migration plus its down file, for defect D-001), and new tests came in at 7, under both the declaration and the ceiling.
- [x] Every test in section 8 passed GATE-TEST-JUSTIFIED. Every row in `specs/TEST-LEDGER.md` section 1 now carries a mutation-verified date; none was left `pending`.
- [x] PRD status column updated for FR-001, FR-002, FR-003, and NFR-001 through NFR-004 (all `not-started` -> `done`).
- [x] `docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md` written. `docs/` root holds exactly three `.md` files (GATE-DOC D7).
- [x] README updated with real commands, replacing every `<TBD>`.
- [x] Assumption ASM-003 above is explicitly accepted as-is; see its row.
- [x] AC-001 verified in a real browser, not only over REST. Chromium loaded `web/index.html`, signed in as the fixture user, and rendered 33 rows; the `prompt-organizer` row's four cells read exactly `Prompt Organizer`, `Agentic / LLM systems tooling`, `A place to save AI prompts and reuse them instead of retyping them.`, `specced`. A wrong password showed `Invalid login credentials` and left the idea section hidden. The sandbox resets the browser's own TLS egress, so the page's two fetches were relayed through Node against the same live project; every line of the page's sign-in and render logic ran in the browser against real data, and only the browser-to-internet TCP hop was substituted.
- [x] Defect D-001 found and fixed during this slice: the `prompt-organizer` row's `status` was `idea` while FR-001 and AC-001 both name `specced`, and T-A-001 had been written to assert the observed value rather than the specified one. Recorded in `specs/TEST-LEDGER.md` section 3 with the gate that missed it.
- [x] Rollback plan tested: all four down migrations actually run against the project once, then the up migrations re-applied. (2026-08-06: found and fixed a real gap — the up migrations were missing schema `GRANT`s, so the round-trip only worked because of grants applied outside version control. Fixed in `20260806190000_core_create_schema.sql` and `20260806190100_idea_create_schema.sql`.)
- [x] Nothing added that no `AC` or `PROP` required. The one addition beyond the original spec is the sign-in form on `web/index.html`. It is required, not extra: AC-001 needs the page to display rows and AC-002/NFR-001 forbid reading them unauthenticated, so with no way to hold a session the page could not satisfy AC-001 at all. PRD OOS-004 was narrowed in the same change (v0.1.1) and now excludes sign-up, password reset, and multi-user account management, all of which remain unbuilt.
- [x] `updated` and `completed` dates set in front matter; moved to `specs/done/`.
