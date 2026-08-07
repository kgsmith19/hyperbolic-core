---
title: toolbelt Product Requirements Document
status: draft
created: 2026-08-06
updated: 2026-08-07
owner: Kyle
version: 0.1.3
---

# toolbelt PRD

> **This document is the source of truth.** Code, specs, and tests derive from it. If reality differs from this document, one of them is wrong and it gets fixed the same day. This is a living document: it is updated as requirements are discovered, and every change is logged in section 16.
>
> **Writing standard:** every line must pass the four-reader test (a child, a business person, a programmer, and an LLM must all read it the same way). No adjective without a number. See `rules/03-WRITING.md`.

---

## 1. What this is

This is one shared place in the database where every small tool Kyle builds writes down what it ran, what it cost, and what happened. It also holds the list of tool ideas that have not been built yet, so the list lives in a table instead of only in a document.

## 2. Problem

| Field | Answer |
|---|---|
| Who has the problem | Kyle, building a portfolio of small internal tools that need to read each other's data |
| What they do today | The 33-idea backlog lives only in a written document. Each new tool would invent its own tables for logging runs and costs. |
| What it costs them | A scoring tool (Optimize Metrics, Cost-Per-Outcome Tracker) cannot compare tools against each other without a shared table shape. The idea list cannot be sorted, filtered, or scored without manual copy-paste. |
| Why solve it now | Prompt Organizer is about to be built and needs a place to register itself; the idea backlog needs a queryable home before anything can be prioritized against it. |
| What happens if we do nothing | Each tool builds an incompatible version of the same tables, and every "what should I build next" question stays a manual judgment call instead of a query. |

## 3. Users

| ID | User type | What they need to do | How often | Technical level |
|---|---|---|---|---|
| U-001 | Kyle (sole user) | See the list of tool ideas with their category, one-liner, and status | Weekly | Expert |
| U-002 | A tool in the portfolio (e.g. Prompt Organizer) | Register itself, then write run/cost/event/outcome rows | Every time that tool runs | n/a |

## 4. Scope

### 4.1 In scope

- A `core` Postgres schema with the tables every tool writes to: `app`, `run`, `event`, `cost`, `outcome`, `run_outcome`, `metric_def`, `metric_value`, `assumption`, `intervention`
- An `idea` Postgres schema holding the tool backlog: `idea`, `dependency`, `score`
- A page listing every row in `idea.idea` with its name, category, one-liner, and status
- A sign-in form on that page, the minimum needed for it to hold an authenticated session (NFR-001 requires one; nothing reads `idea.idea` unauthenticated)
- Row-level security, enabled and forced, on every table above

### 4.2 Out of scope (non-goals)

| ID | Not doing | Why not | Revisit when |
|---|---|---|---|
| OOS-001 | Editing ideas from the UI | Nothing needs to write to `idea.idea` yet except the seed data | A tool needs to change idea status from its own UI |
| OOS-002 | An idea dependency graph or scoring UI | `idea.dependency` and `idea.score` have no reader yet | A tool (Golden Goose, Constraint Finder) is specced against them |
| OOS-003 | A client library wrapping `core.run`/`core.event` writes | No tool has been instrumented yet; a wrapper's shape should follow real usage, not precede it | The first tool (Prompt Organizer) actually needs to write a `core.run` row |
| OOS-004 | Sign-up, password reset, and multi-user account management | Kyle is the only user across every tool in the portfolio and already has one Supabase auth identity | A second person needs access |
| OOS-005 | A retention job for `core.event` | No tool has written an event yet, so there is nothing to retain | `core.event` has real rows and the 90-day risk in the topology note becomes concrete |

## 5. Use cases

### UC-001: Check what tool to build next

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | `idea.idea` has at least one row |
| Trigger | Kyle wants to decide what to build next |
| Main path | 1. Opens the idea list page. 2. Reads name, category, one-liner, and status for every idea. |
| Success outcome | Every row in `idea.idea` is visible on the page |
| Failure paths | `idea.idea` is empty -> the page states that no ideas are recorded |
| Frequency | Weekly |
| Traces to | FR-001 |

### UC-002: A tool registers itself and starts logging

| Field | Content |
|---|---|
| Actor | U-002 |
| Precondition | None |
| Trigger | A tool runs a slice, a workflow, or a review for the first time |
| Main path | 1. The tool's operator inserts a row into `core.app` naming that tool. 2. The tool inserts a row into `core.run` referencing its own `app_id`. 3. The tool inserts related `core.event`, `core.cost`, or `core.outcome` rows referencing that run. |
| Success outcome | Every row is stored and readable by an authenticated caller |
| Failure paths | The tool has no row in `core.app` yet -> the `core.run` insert is rejected by a foreign key constraint |
| Frequency | Every run, after the tool registers once |
| Traces to | FR-002, FR-003 |

## 6. Functional requirements

| ID | Requirement | Priority | Acceptance criterion (objective) | Traces to | Status |
|---|---|---|---|---|---|
| FR-001 | The system must display every row in `idea.idea` with its `name`, `category`, `one_liner`, and `status`. | Must | Given `idea.idea` contains a row with `id` `prompt-organizer`, `name` `Prompt Organizer`, `category` `Agentic / LLM systems tooling`, `one_liner` `A place to save AI prompts and reuse them instead of retyping them.`, and `status` `building`, when the idea list page loads, then all four of those values appear on the page for that row. | UC-001 | done |
| FR-002 | The system must reject an insert into `core.run` whose `app_id` has no matching row in `core.app`. | Must | Given `core.app` has no row with `id` `test-app`, when inserting into `core.run` with `app_id` `test-app` and `kind` `job`, then the insert fails with a foreign key violation and no row is created. | UC-002 | done |
| FR-003 | The system must provide the `core.app`, `core.run`, `core.event`, `core.cost`, `core.outcome`, `core.run_outcome`, `core.metric_def`, `core.metric_value`, `core.assumption`, and `core.intervention` tables, matching the column definitions in `docs/notes/2026-08-06-supabase-project-topology.md` section 2. | Must | Given the `core` schema migration has been applied, when a row is inserted into `core.metric_def` with `id` `cost_per_requirement`, `name` `Cost per requirement`, `formula` `total cost / total requirements shipped`, `unit` `USD`, and `gaming_risk` omitted, then the insert fails a `NOT NULL` constraint on `gaming_risk`. | UC-002 | done |

## 7. Non-functional requirements

| ID | Category | Requirement | Threshold | How it is measured | Status |
|---|---|---|---|---|---|
| NFR-001 | Security | Every read and write to a `core.*` or `idea.*` table must be rejected unless the caller is authenticated. | 100% of unauthenticated attempts rejected | RLS policy test as an unauthenticated caller, one per table | done |
| NFR-002 | Cost | Infrastructure cost must be $0 beyond the one new Supabase project this repo creates. | $0 marginal | Billing report | done |
| NFR-003 | Maintainability | No source file over 250 lines; no function over 40 lines. | 250 / 40 | Manual line count (no build step yet to lint) | done |
| NFR-004 | Durability | Every migration must have a tested down migration. | 100% of migrations | Down migration run against the project and confirmed to remove exactly what the up migration added | done |

Categories considered and not applicable: performance (no real traffic yet), scalability (single user), availability (inherits Supabase's own SLA, not controlled by this repo), compliance (no regulated data), internationalization (single user, English), portability (Postgres only, by choice).

## 8. Data requirements

| ID | Data item | Meaning in plain language | Source | Classification | Retention | Traces to |
|---|---|---|---|---|---|---|
| DR-001 | Idea record | One row per tool idea: its name, category, one-liner, and build status | Transcribed once from the topology note's planning table | internal | Forever, until Kyle deletes an idea | FR-001 |
| DR-002 | Run record | One row per execution of anything worth measuring, across every tool | Written by each tool | internal | Forever. SL-004's job drops `core.event` rows only, and `core.cost`/`core.outcome`/`core.run_outcome` reference runs. | FR-002, FR-003 |
| DR-003 | Event record | An append-only log entry belonging to a run | Written by each tool | internal | 90 days hot, then a monthly aggregate kept forever (ratified via Q-002) | FR-003 |

## 9. Constraints

| ID | Constraint | Type | Source | Consequence |
|---|---|---|---|---|
| CON-001 | Lives in a new Supabase project named `toolbelt`, never an existing one. | technical | `docs/notes/2026-08-06-supabase-project-topology.md` | No reuse of `lifeos`, `lifeos-test`, `netcheck`, or `marketmind` |
| CON-002 | Every table lives in the `core` or `idea` Postgres schema; no table without a schema prefix. | technical | Same topology note | Tool-specific schemas (`prompt`, `agentic`, etc.) are entirely out of scope for this repo |
| CON-003 | Sole user for the foreseeable future. | business | Owner | No collaboration features, no per-row `user_id` ownership model |

## 10. Assumptions

| ID | Assumption | How to verify | Cost if wrong | Status |
|---|---|---|---|---|
| ASM-001 | One Supabase auth identity (Kyle's) is sufficient for every tool's authenticated access. | Watch whether a second person ever needs access to any tool | Every `core.*`/`idea.*` RLS policy needs a per-row owner model added; a breaking change | unverified |
| ASM-002 | `core.event`'s retention policy can wait until a tool actually writes to it. | Watch whether `core.event` grows before a retention job exists | A manual cleanup query instead of a scheduled job, until SL-004 | unverified |

## 11. External interfaces

None. Every tool that reads or writes this schema lives in its own repo and connects to the same Supabase project directly; that connection is not a third-party integration. Adding a true external interface requires a PRD change per halt H7 in `rules/00-CORE.md`.

## 12. Success metrics

| ID | Metric | Definition (exact formula) | Baseline today | Target | Measured by | Review cadence |
|---|---|---|---|---|---|---|
| MET-001 | Ideas recorded | `count(idea.idea)` | 0 | 33 by the end of SL-000 | Query on `idea.idea` | Once, at slice close |

**Gaming risk:** MET-001 is gamed by inserting placeholder rows to hit the count. It is checked against the topology note's 33-row table by name, not counted alone.

## 13. Slice plan

| Slice | Name | What becomes true | Requirements delivered | Est. net LOC | Depends on |
|---|---|---|---|---|---|
| SL-000 | Core + idea spine | The `core` and `idea` Postgres schemas exist with all 13 tables, RLS forced on every one, `idea.idea` seeded with 33 rows, and a page lists every idea. | FR-001, FR-002, FR-003 | ~450 SQL + ~60 UI (exceeds `MAX_NET_LOC` and `MAX_NEW_TABLES`; exception recorded in `SPEC-0000` section 6) | - |
| SL-001 | Idea scoring | `idea.score` rows are visible next to each idea on the list page. | none yet | 150 | SL-000 |
| SL-002 | Idea dependencies | `idea.dependency` edges are visible as a simple list under each idea. | none yet | 150 | SL-000 |
| SL-003 | First tool writes a run | A thin client library lets a tool insert a `core.run`/`core.event` row, proven by Prompt Organizer's first real write. | none yet | 200 | SL-000, Prompt Organizer repo exists |
| SL-004 | `core.event` retention | A scheduled job drops `core.event` rows older than 90 days, keeping a monthly aggregate. | none yet | 200 | SL-003 |

Rules:

- A slice delivers at most 1 user story, except SL-000, which carries a written budget exception (see `SPEC-0000` section 6).
- Reordering slices after SL-000 is fine and expected. Growing them is not.

## 14. Glossary

| Term | Definition (plain language) | Not to be confused with |
|---|---|---|
| Tool | A small, single-purpose application in the portfolio, each in its own repo | Idea, which is a tool not yet built |
| Idea | A row in `idea.idea` describing a tool not yet built, or a tool that has been built and linked via `app_id` | Tool |
| Run | One execution of anything worth measuring (an agent, workflow, slice, review, or job); one row in `core.run` | Event, which is one step inside a run |
| Event | One append-only log entry belonging to a run | Run |
| Schema | A Postgres namespace (`core`, `idea`, or a tool's own) | Project, which is the whole Supabase database |

## 15. Open questions

| ID | Question | Blocks | Owner | Needed by | Answer |
|---|---|---|---|---|---|
| Q-001 | Where do tool runs actually get instrumented: a shared client library, a hook, or manual writes per tool? | SL-003 | Kyle | before SL-003 | **Ratified 2026-08-07:** a thin wrapper library, one function, written when the first tool needs it. Not written speculatively; SL-003 builds it against Prompt Organizer's first real write. |
| Q-002 | What is `core.event`'s retention: 90 days, or longer for provenance? | SL-004 | Kyle | before `core.event` has real rows | **Ratified 2026-08-07:** 90 days hot, monthly aggregate kept forever. Applies to `core.event` only; `core.run` is retained indefinitely (DR-002). |

Both questions are settled. Neither creates a requirement: SL-003 and SL-004 still deliver no `FR-`/`NFR-`, so neither can be built until section 6 or 7 names what it must do.

## 16. Change log

| Date | Version | Change | Reason | Affected IDs |
|---|---|---|---|---|
| 2026-08-06 | 0.1.0 | Initial draft. | First PRD for the toolbelt spine, written ahead of `SPEC-0000`. | - |
| 2026-08-07 | 0.1.1 | Narrowed OOS-004 to sign-up, password reset, and multi-user account management; added a sign-in form to section 4.1. | FR-001 requires the page to display idea rows and NFR-001 requires every read to be authenticated. With sign-in entirely out of scope the two contradicted each other and the page could not exist. The form is the smallest thing that resolves it: email, password, no sign-up, no reset, no session persistence. | FR-001, NFR-001, OOS-004 |
| 2026-08-07 | 0.1.2 | Set FR-001, FR-002, FR-003 and NFR-001 through NFR-004 to `done`. | SL-000 shipped and every acceptance criterion has a passing test. | FR-001, FR-002, FR-003, NFR-001, NFR-002, NFR-003, NFR-004 |
| 2026-08-07 | 0.1.3 | FR-001's acceptance criterion literal for the `prompt-organizer` row's `status` updated `specced` -> `building`. | The row is alive by design: Prompt Organizer's walking skeleton started implementation, so its status legitimately moved (migration `20260807030000`). The AC's literal is a snapshot of the fixture row and tracks its real lifecycle; it will change again at most twice (`live`, or `parked`/`killed`). This is a PRD-first amendment with the test updated to match, not a test edited to pass: the defect D-001 rule (assert the specified value) still holds — the specified value itself moved. | FR-001 |
| 2026-08-07 | 0.1.4 | Ratified Q-001 and Q-002 at their recorded defaults. Corrected DR-002's retention from "Not yet decided; see Q-002" to "Forever", and restated DR-003's as ratified rather than a topology-note default. | Both questions had carried a recorded default since 0.1.0 and neither had been contested; leaving them open blocked SL-003 and SL-004 for no reason. Ratifying exposed that DR-002 pointed at Q-002 for its answer, but Q-002 only ever asked about `core.event`. SL-004's slice plan entry already says the job drops `core.event` rows only, so runs being retained was implied by the plan and merely unstated here. No requirement is created: SL-003 and SL-004 still deliver no `FR-`/`NFR-`. | Q-001, Q-002, DR-002, DR-003 |

---

## Appendix A: PRD self-check (GATE-PRD)

- [x] Section 1 is understandable by a ten-year-old.
- [x] Every FR is testable as written, with concrete values in its acceptance criterion.
- [x] Every NFR has a number and a measurement method.
- [x] No banned word appears (robust, seamless, intuitive, scalable, simple, flexible, appropriate, as needed...).
- [x] Out-of-scope section is non-empty (5 entries).
- [x] Every term used more than once appears in the Glossary exactly once.
- [x] Every data item classified PII or secret has a matching protective NFR. (None classified PII or secret; all `internal`.)
- [x] Every metric has a stated gaming risk.
- [x] The slice plan's first entry is a Phase 0 skeleton. It delivers FR-001 through FR-003 rather than none, a deliberate deviation recorded here: this slice already carries an explicit budget exception (section 13), so hiding its real requirement coverage behind "none" would make the PRD's own status columns dishonest once GATE-GREEN passes.
- [x] No unfilled `<placeholder>` remains.
- [x] Every FR/NFR has a Status value.
- [x] Two requirements do not contradict each other.
