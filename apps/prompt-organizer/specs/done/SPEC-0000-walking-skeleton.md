---
title: Walking skeleton, save and list a prompt
spec_id: SPEC-0000-walking-skeleton
slice: SL-000
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle
traces: [FR-001, NFR-003, NFR-007, NFR-009, CON-001, CON-003]
---

# SPEC-0000: Walking skeleton, save and list a prompt

> One spec, one thin slice, one shippable change. This slice fits every Phase 0 ceiling with no exception.

---

## 1. In one sentence

A signed-in user saves a prompt with a title and body into the `prompt` schema of the `toolbelt` Supabase project and reads it back, character for character, on one page.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-001 in full; NFR-003 for the one table that exists after this slice |
| What a user can do after this that they could not before | Kyle can put a prompt somewhere permanent and get it back exactly, instead of keeping it in a file or a transcript |
| Why this slice comes before the next one | Every later slice (search, variables, render, versions) reads or transforms rows this slice makes storable |
| What we learn from shipping it | Whether the whole path — schema in the shared project, PostgREST exposure, owner-scoped RLS, static page, fixture-user tests — works end to end at minimum size, before any feature logic exists |

The PRD's slice plan lists SL-000 as delivering "none". Its own acceptance criterion for FR-001 is exactly what this skeleton does, so this spec declares FR-001 honestly rather than hiding coverage behind "none" — the same recorded deviation the toolbelt PRD made for its own Phase 0, and for the same reason: status columns must not be dishonest once GATE-GREEN passes. PRD change logged as v0.1.1.

## 3. Scope

### 3.1 In scope

- Table `prompt.prompt`: id, owner, title, body, created-at — with FR-001's bounds as `CHECK` constraints
- Owner-scoped RLS, enabled **and** forced, in the same migration that creates the table
- The `prompt` schema exposed over the project's PostgREST API
- One page: sign in, save a prompt, list saved prompts with their bodies
- A tested down migration

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| Duplicate-title rejection (FR-002) | The PRD assigns it to SL-004 with versions | SL-004 |
| Search, tags, filtering (FR-006, FR-012) | Nothing to search yet | SL-001, SL-006 |
| Variables, sections, render, copy (FR-004, FR-005, FR-007, FR-010) | The skeleton proves storage, not transformation | SL-002, SL-003 |
| Versions (FR-003) | One row per prompt is enough to walk | SL-004 |
| Editing or deleting a saved prompt | No `UPDATE`/`DELETE` grant is issued at all in this slice — the narrowest surface that satisfies FR-001, and NFR-005's spirit early | The slice that first needs it |
| Registering in `core.app` / writing `core.run` | NFR-010 assigns instrumentation to SL-007; registering before anything runs records nothing | SL-007 |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | User A is signed in | A prompt titled `Spec Author` with the 500-character fixture body (defined in section 8; contains `{{REPO}}`, an `<!--OPTIONAL:lean-->…<!--/OPTIONAL:lean-->` fence, a newline, and `é`) is saved via `POST /rest/v1/prompt` | The response is `201`; a `GET` for that row's `id` returns the body unchanged, character for character, and the row appears in the list the page reads | FR-001 |
| AC-002 | User A is signed in | A prompt with title `` (empty) is saved | The response is `400` with Postgres error code `23514` (check violation) and no row is created | FR-001 |
| AC-003 | User A is signed in | A prompt with a 201-character title is saved; separately, a prompt with a 100,001-character body is saved | Each response is `400` with code `23514` and no row is created | FR-001 |
| AC-004 | A request carries only the anon API key, no user token | `GET /rest/v1/prompt?select=id` | The response is `200` with `[]` | NFR-003 |
| AC-005 | User A has saved a prompt; user B is a different authenticated user | User B `GET`s that prompt's `id`; user A does the same (positive control) | User B receives `200` with `[]`; user A receives the row | NFR-003 |
| AC-006 | The up migration has been applied and the suite is green | The down migration runs | `prompt.prompt` and schema `prompt` no longer exist, and `pgrst.db_schemas` on role `authenticator` reads exactly `public, core, idea`; re-applying the up migration returns the suite to green | CON-003 |

AC-002, AC-003, AC-004, and AC-005 are the failure cases.

## 5. Properties

All nine kinds walked per `rules/06-TESTS.md`:

| ID | Property | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-001 | Every save attempt ends in `201` or a named `4xx` carrying a Postgres error code (`23514` bounds, `42501` permission); never a crash or a partial row. Spot-checked at the named boundaries, not a generated sweep — no property library exists in this repo (`MAX_NEW_LIBRARIES: 0`). | Error totality | Titles of length 0, 1, 200, 201; bodies of length 500, 100,001; anon and authenticated callers | FR-001, NFR-003 |
| PROP-002 | The body comes back byte-identical to what was stored: template tokens, section fences, newlines, and non-ASCII pass through untouched. This is the property the whole tool rests on — CON-004 requires stored pack files to stay valid input. | Round-trip | The 500-character fixture exercising `{{VAR}}`, `<!--OPTIONAL:id-->`, `\n`, `é` | FR-001, CON-004 |
| PROP-003 | Title length is always 1–200 and body length 1–100,000. Enforced by `CHECK` constraints (the cheaper mechanism); AC-002/AC-003 prove the constraints are wired. | Invariant | n/a — mechanism is the constraint | FR-001 |
| PROP-004 | Idempotence: none applies. No data migration exists; the DDL migration is applied once by the platform's migration history. | Idempotence | n/a | — |
| PROP-005 | Order independence: none applies. One user, no concurrent writers, and the list carries no ordering contract in this slice (`created_at desc` is display preference, not behavior). | Order independence | n/a | — |
| PROP-006 | Oracle: none applies beyond PROP-002's fixture, which is its own expected value. | Oracle / model | n/a | — |
| PROP-007 | Metamorphic: none applies. This slice transforms nothing; render arrives in SL-002. | Metamorphic | n/a | — |
| PROP-008 | Conservation: row count is unchanged by any number of reads. Postgres `SELECT` semantics are the mechanism; a test would assert a property of Postgres, not of this system (toolbelt SPEC-0000 precedent). | Conservation | n/a | — |
| PROP-009 | Monotonicity: none applies. No pagination, filtering, or scoring exists in this slice. | Monotonicity | n/a | — |

## 6. Budget declaration

Phase 0 ceilings apply (`rules/01-BUDGETS.md`). Every line is within; no exception is requested.

| Metric | Declared | Ceiling | Status | Actual (fill at completion) |
|---|---|---|---|---|
| Net source LOC | ~140 (migration ~30 + down ~10 + page ~100) | 150 (PHASE0) | within | 147 (30 + 6 + 111). First draft of the page was 124 lines, putting the slice at 160; thirteen lines of undemanded styling and multi-line literals were deleted rather than requesting an exception. |
| Test LOC | ~135 (one file, helpers inline) | 200 | within | 120 |
| Total repo files | 11 | 12 (PHASE0) | within | 11 |
| New modules/classes | 0 | 2 | within | 0 |
| Source files touched | 3 (up migration, down migration, page) | 3 | within | 3 |
| Test files touched | 1 | 3 | within | 1 |
| New tables | 1 (`prompt.prompt`) | 1 | within | 1 |
| New columns | 5 (id, user_id, title, body, created_at) | 6 | within | 5 |
| New endpoints | 0 custom (PostgREST auto-API; toolbelt precedent) | 1 | within | 0 |
| New UI surfaces | 1 (`web/index.html`) | 1 | within | 1 |
| New libraries | 0 | 0 | within | 0 |
| New third-party services | 0 (same Supabase project; CON-001) | 0 | within | 0 |
| User stories | 1 (U-001) | 1 | within | 1 |
| New tests | 4 executable | 4 (PHASE0) | within | 4 |
| New config keys | 1 (the `SUPABASE_URL`/anon-key pair, inlined) | 2 | within | 1 |

`updated_at` is deliberately absent from the table: nothing can update a row in this slice (no grant), so the column would be a constant. SL-004's versioning reshapes write behavior anyway.

## 7. Changes

### 7.1 Interfaces

None custom. The page and tests use the project's own PostgREST (`/rest/v1/prompt`, profile header `prompt`) and GoTrue (`/auth/v1/token`) endpoints.

### 7.2 Data

| Change | Table(s) | Forward migration | Down migration | Backfill | Zero-downtime approach |
|---|---|---|---|---|---|
| Create schema + table + RLS + grants + PostgREST exposure | `prompt.prompt` | `supabase/migrations/20260807020000_prompt_create_prompt.sql` | `..._down.sql` | no | New schema; nothing reads it yet. Exposure appends `prompt` to the confirmed-current `pgrst.db_schemas` value (`public, core, idea`, read from the live role 2026-08-07); the down restores that exact value. |

Rehearsal per the topology convention: the DDL portion (schema, table, grants, RLS, and its down) runs on `lifeos-test` first. The exposure line is excluded from rehearsal — `lifeos-test` has no `core`/`idea` schemas, so setting that list there would break its API. Exposure is exercised on the real project by the red→green transition itself.

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260807020000_prompt_create_prompt.sql` | create | AC-001 through AC-005 |
| `supabase/migrations/20260807020000_prompt_create_prompt_down.sql` | create | AC-006 |
| `web/index.html` | create | AC-001's "appears in the list", FR-001 |
| `tests/skeleton.test.mjs` | create | All executable ACs |

## 8. Test plan

Phase 0 caps executable tests at 4. Every row passed GATE-TEST-JUSTIFIED on paper; ledger rows are written before the tests.

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-A-001 | acceptance | AC-001, PROP-002 | A saved body comes back altered — a template token, fence, newline, or non-ASCII character corrupted — so every later render is built on corrupted input | Round-trip through the real API and storage is the only place encoding loss can occur | No other test reads a saved body back | Never; this is the storage contract every slice above it assumes |
| T-I-001 | integration | AC-002, AC-003, PROP-003 | A prompt outside FR-001's bounds is stored | The `CHECK` is the cheap mechanism; this proves it is wired and survives future migrations. One test, one failure mode ("an out-of-bounds prompt is stored"), three boundary probes — consolidated under the Phase 0 test cap, recorded here | No other test sends invalid input | When FR-001's bounds change in the PRD |
| T-I-002 | integration | AC-004 | An unauthenticated caller reads prompt data (DR-002 is confidential) | RLS is database-level; only a real unauthenticated network call proves it is on | No other test calls without a token | Never while DR-002 stays confidential |
| T-I-003 | integration | AC-005 | One user reads another user's prompts | Owner-scoped policy needs two real sessions; positive control prevents a vacuous pass | No other test uses two identities | If the tool ever becomes deliberately multi-user (OOS-001 revisit) |
| T-A-002 | acceptance (manual drill, not executable) | AC-006 | The down migration strands schema, table, or the PostgREST exposure list | Only running the actual down proves rollback | No other step exercises the down | Never; every migration keeps this guarantee |

**The 500-character fixture** (T-A-001): built in-test as a fixed literal — `"# Spec Author\n"` + `"Repo is {{REPO}}. é "` + `"<!--OPTIONAL:lean-->keep it lean<!--/OPTIONAL:lean-->"` + `"x"` repeated to exactly 500 characters, with `assert.equal(BODY.length, 500)` in the arrange step. Deterministic, no clock, no randomness (J8).

**Fixture users:** the two project-level test accounts created for toolbelt SPEC-0000 (`kylegsmith19+toolbelt-test-a@gmail.com` / `-b@…`), credentials inlined in the test file. Recorded as ASM-002 below.

### Red→green execution order (GATE-RED / GATE-GREEN)

1. Ledger rows for all four tests (no row, no test).
2. Write `tests/skeleton.test.mjs`. **Red run** before any migration exists. Expected reason, written here first (R4): every test fails its first status assertion with actual `404` (PostgREST error `PGRST106`, schema `prompt` not exposed) against expected `201`/`200`/`400` — an assertion failure naming expected and actual (R2, R3), not an import error. R7 holds: the repo diff at red contains only test files and docs.
3. Rehearse DDL + down on `lifeos-test`; then apply the up migration to the real project. No page yet, no other code.
4. **Green run**: all four pass. G7: every non-test line in the diff is demanded by an AC (the migration by AC-001–AC-005, the page by AC-001's list clause).
5. Build `web/index.html`; verify AC-001's page clause in a real browser.
6. T-A-002 drill: down against the real project, probe, re-apply up, suite green again.

Cycle budget: `MAX_RED_GREEN_CYCLES: 3` before halt.

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation in this slice | Accepted by |
|---|---|---|---|---|---|
| RISK-001 | The exposure line hardcodes `public, core, idea, prompt`; a later tool's migration that also hardcodes could clobber `prompt` from the list | medium, eventually | medium (API 404s for the dropped schema; data intact) | The down/up pair restores exactly; the current value was read from the live role before writing, and this risk is recorded for the next tool's spec to handle | Kyle |
| RISK-002 | Test fixture rows accumulate in the real table across suite runs (no `DELETE` grant exists to clean them) | certain | low (a few rows per run, owned by fixture users; SL-004 reshapes writes anyway) | Accepted; noted in ledger. The alternative — issuing `DELETE` grants for test hygiene — widens the security surface the slice deliberately keeps shut | Kyle |
| RISK-003 | The `toolbelt` repo's CI-less flow means nothing re-runs these tests automatically | certain | low at this scale | Same posture as toolbelt SPEC-0000; revisit when any second contributor or scheduled run exists | Kyle |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | Run `supabase/migrations/20260807020000_prompt_create_prompt_down.sql` — drops the table and schema, restores `pgrst.db_schemas` to `public, core, idea` |
| Time to undo | Under 2 minutes; one file |
| Data written that survives rollback | None worth keeping — only test fixture rows exist until the tool is used in anger |
| Feature flag | None; nothing outside this repo reads the schema |
| Who decides | Kyle |
| Signal that triggers rollback | AC-006 drill failure, or GATE-GREEN failing after apply |

## 11. Assumptions made during implementation

| ID | Assumption | Why it was needed | How to verify | Blast radius | Promoted to PRD? |
|---|---|---|---|---|---|
| ASM-001 | "Source files touched" counts non-test files only; test files count under `MAX_TEST_FILES_TOUCHED`. | `rules/01-BUDGETS.md` lists the two ceilings separately, but toolbelt SPEC-0000 folded tests into its source-file count (under a blanket exception, so the convention was never scrutinized). This slice needs the reading to be explicit. | Kyle confirms or corrects at review; if tests count as source, this slice is at 4/3 and needs a split or exception | Low — a counting convention, not behavior | no |
| ASM-002 | Reusing toolbelt's two fixture users (credentials duplicated into this repo's test file) is acceptable. | NFR-003 needs two real identities; the accounts are project-level fixtures that already exist, and creating new ones would repeat toolbelt ASM-003's whole dance for zero added proof | Same as toolbelt ASM-003; rotating those credentials means updating both repos (the cost of self-containment) | Low — fixture accounts hold only test rows | no |
| ASM-003 | `status` of the `prompt-organizer` row in `idea.idea` moves `specced` → `building` when this slice's implementation starts. That update belongs to the toolbelt repo (its schema), not this one. | Specs never cross repos (`rules/05-SPECS.md`) | A one-line data migration in toolbelt, noted for its next commit | None here | no |

## 12. Definition of Done (GATE-SPEC-DONE)

- [x] Every AC has a passing test or recorded drill. AC-001 T-A-001 + browser drill; AC-002/AC-003 T-I-001; AC-004 T-I-002; AC-005 T-I-003; AC-006 T-A-002.
- [x] Every PROP has a passing test or a recorded reason. PROP-001 spot-checked via T-I-001 (named codes at named boundaries, as declared); PROP-002 T-A-001; PROP-003 the `CHECK`s, proven wired by T-I-001; PROP-004..009 recorded n/a in section 5.
- [x] GATE-GREEN: `node --test "tests/*.test.mjs"` exits 0, 4/4 in 1.9 s. Red run first: all four failed their opening status assertion with `PGRST106` ("Invalid schema: prompt") — actual status was `406`, not the predicted `404`; same root cause, recorded honestly. One red-green cycle of the allowed 3. Toolbelt's 7-test suite re-run green after the exposure change (the one cross-repo risk this slice carries). G3/G4/G5 have no commands here — no linter, types, or build step exists; NFR-009 checked by `wc -l` (largest file after the trim: `tests/skeleton.test.mjs` at 120 of 250; largest source file `web/index.html` at 111).
- [x] Every budget line has an Actual; every line within ceiling. The one near-breach (160 > 150 at first page draft) was resolved by deletion, recorded in the budget table.
- [x] GATE-TEST-JUSTIFIED: ledger rows predate tests (commit order shows it); all four tests plus the drill mutation-verified 2026-08-07 — oracle mutation for T-A-001, dropped CHECK for T-I-001 (red: `201` for an out-of-bounds title), open policy for T-I-002/T-I-003 (red: anon and user B both received rows). Every mutation reverted and re-proven green; the open-policy window also caught one escaped empty-title row, deleted during constraint restore.
- [x] PRD updated to v0.1.1: SL-000 delivers FR-001; FR-001, NFR-003, NFR-007, NFR-009 → `done`; change log entry records the deviation and the reason.
- [x] `docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md` written; `docs/` root holds exactly three `.md` files.
- [x] AC-001's page clause verified in Chromium: app hidden before sign-in; saved through the real form; title in the list; body read back from the DOM at 500 characters, verbatim (`bodyVerbatim:true`); a 201-character title surfaced the server rejection on the page. Same Node-relay caveat as toolbelt's drill (its ASM-005): the sandbox resets browser TLS egress, so the page's fetches were serviced by Node against the live project — page logic ran unmodified.
- [x] T-A-002 drill run against the real project 2026-08-07: down → schema absent and `pgrst.db_schemas` restored to exactly `public, core, idea` (query shown in ledger row); up re-applied → suite green. DDL half rehearsed on `lifeos-test` first, per the topology convention.
- [x] Nothing added that no AC or PROP required; thirteen lines of styling were deleted for exactly this reason.
- [x] `updated`/`completed` set; moved to `specs/done/`.
