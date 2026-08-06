---
title: toolbelt Product Requirements Document
status: draft
created: 2026-08-06
updated: 2026-08-06
owner: Kyle
version: 0.1.0
---

# <Product name> PRD

> **This document is the source of truth.** Code, specs, and tests derive from it. If reality differs from this document, one of them is wrong and it gets fixed the same day. This is a living document: it is updated as requirements are discovered, and every change is logged in section 15.
>
> **Writing standard:** every line must pass the four-reader test (a child, a business person, a programmer, and an LLM must all read it the same way). No adjective without a number. See `rules/03-WRITING.md`.
>
> Structure follows ISO/IEC/IEEE 29148 requirements-engineering practice, trimmed to what a small team actually uses. Delete no section; write "None" if a section is empty, so a reader knows it was considered.

---

## 1. What this is

<Two to four sentences. What the product does, for whom, in words a ten-year-old understands. No jargon, no acronyms, no benefits language. If you cannot do this, you do not understand the product yet.>

**Example of the right register:** "This is a website where a person types in a street address and gets back the date their trash is collected. It works in one city. It is free to use."

## 2. Problem

| Field | Answer |
|---|---|
| Who has the problem | <specific person or role> |
| What they do today | <current behavior, including the workaround> |
| What it costs them | <time, money, errors, or risk, with a number> |
| Why solve it now | <the thing that changed> |
| What happens if we do nothing | <plain answer> |

## 3. Users

| ID | User type | What they need to do | How often | Technical level |
|---|---|---|---|---|
| U-001 | <role> | <goal in one sentence> | <daily/weekly/once> | <none/some/expert> |

## 4. Scope

### 4.1 In scope

- <capability>

### 4.2 Out of scope (non-goals)

State what this product deliberately does not do. This section prevents more waste than any other.

| ID | Not doing | Why not | Revisit when |
|---|---|---|---|
| OOS-001 | <thing> | <reason> | <condition, or "never"> |

## 5. Use cases

One row per use case. The "Main path" is what happens when nothing goes wrong.

### UC-001: <verb + object, e.g. "Look up a collection date">

| Field | Content |
|---|---|
| Actor | <U-00x> |
| Precondition | <what must be true before this starts> |
| Trigger | <what starts it> |
| Main path | 1. <actor action> 2. <system response> 3. ... |
| Success outcome | <observable end state> |
| Failure paths | <named condition> -> <what the system does> |
| Frequency | <n per day/week> |
| Traces to | FR-00x, FR-00y |

## 6. Functional requirements

One requirement per row. Each must be testable as written. Use "must"; never "should".

| ID | Requirement | Priority | Acceptance criterion (objective) | Traces to | Status |
|---|---|---|---|---|---|
| FR-001 | The system must <do X> when <condition Y>. | Must | Given <state>, when <action>, then <observable result with concrete values>. | UC-001 | not-started |

**Priority values:** `Must` (product does not exist without it), `Should` (product is materially worse without it), `Could` (nice, cut it first), `Won't` (recorded so it is not re-litigated).

**Status values:** `not-started`, `in-slice-NNN`, `done`, `dropped`. This column is what GATE-DOC check D1 verifies.

## 7. Non-functional requirements

Every NFR has a number and a way to measure it. An NFR without a threshold is deleted.

| ID | Category | Requirement | Threshold | How it is measured | Status |
|---|---|---|---|---|---|
| NFR-001 | Performance | <endpoint> must respond within <n> ms at p95 under <n> concurrent users. | <n> ms | <load test command> | not-started |
| NFR-002 | Security | The system must reject any request without a valid <token type>. | 100% of unauthenticated requests | <test id> | not-started |
| NFR-003 | Availability | The system must be reachable <n>% of minutes per calendar month. | <n>% | <monitor> | not-started |
| NFR-004 | Cost | Monthly infrastructure cost must not exceed $<n> at <n> users. | $<n> | <billing report> | not-started |
| NFR-005 | Data durability | No committed write is lost. Recovery point objective <n> minutes. | RPO <n> min | <restore drill> | not-started |
| NFR-006 | Observability | Every request must be traceable end to end by a single correlation ID. | 100% of requests | <log query> | not-started |
| NFR-007 | Accessibility | All interactive elements must be operable by keyboard alone. | 0 violations | <axe scan> | not-started |
| NFR-008 | Maintainability | No source file exceeds <n> lines; no function exceeds <n> lines. | <n> / <n> | <lint rule> | not-started |

Categories to consider and explicitly write "None, because <reason>" if not applicable: performance, security, privacy, availability, durability, cost, scalability limits, observability, accessibility, internationalization, maintainability, portability, compliance.

## 8. Data requirements

| ID | Data item | Meaning in plain language | Source | Classification | Retention | Traces to |
|---|---|---|---|---|---|---|
| DR-001 | <field or entity> | <what it is, to a non-technical reader> | <where it comes from> | public / internal / confidential / PII / secret | <duration + deletion trigger> | FR-00x |

Rules:

- Anything classified `PII` or `secret` must have a matching NFR describing how it is protected.
- Retention "forever" is a decision, not a default. Write the reason.

## 9. Constraints

Things that are true regardless of what we would prefer.

| ID | Constraint | Type | Source | Consequence |
|---|---|---|---|---|
| CON-001 | <statement> | technical / legal / business / time / cost | <who or what imposes it> | <what it rules out> |

## 10. Assumptions

Things believed true but not verified. Each must have a way to check it and a cost if it is wrong.

| ID | Assumption | How to verify | Cost if wrong | Status |
|---|---|---|---|---|
| ASM-001 | <statement> | <check> | <impact> | unverified / verified / false |

## 11. External interfaces

| ID | System | Direction | Protocol | Data exchanged | Failure behavior | Rate limit / cost |
|---|---|---|---|---|---|---|
| EXT-001 | <name> | inbound / outbound / both | <REST/webhook/SQL/...> | <what> | <what happens when it is down> | <limits> |

If there are none, write "None." Adding one later requires a PRD change and human approval per halt H7 in `rules/00-CORE.md`.

## 12. Success metrics

Objective, measurable, and tied to the problem in section 2. Not vanity counts.

| ID | Metric | Definition (exact formula) | Baseline today | Target | Measured by | Review cadence |
|---|---|---|---|---|---|---|
| MET-001 | <name> | <formula, unambiguous> | <value> | <value by date> | <query or tool> | <weekly/monthly> |

For each metric, answer in one line: **how could this metric be gamed while the product gets worse?** If there is no answer, you have not thought about it yet.

## 13. Slice plan

The build order. Each slice is thin, independently shippable, and produces something observable. `SL-000` is always the Phase 0 skeleton.

| Slice | Name | What becomes true | Requirements delivered | Est. net LOC | Depends on |
|---|---|---|---|---|---|
| SL-000 | Skeleton | One request travels the full stack and returns a hardcoded value. | none (infrastructure only) | <=150 | - |
| SL-001 | <name> | <single observable capability> | FR-001 | <=300 | SL-000 |

Rules:

- A slice delivers at most `{{MAX_USER_STORIES}}` user story.
- If a slice's estimate exceeds `{{MAX_NET_LOC}}`, split it before writing the spec.
- Reordering slices is fine and expected. Growing them is not.

## 14. Glossary

Every domain term used anywhere in this repo, defined once. If a word appears in two forms (for example "user" and "customer"), pick one and delete the other everywhere.

| Term | Definition (plain language) | Not to be confused with |
|---|---|---|

## 15. Open questions

| ID | Question | Blocks | Owner | Needed by | Answer |
|---|---|---|---|---|---|
| Q-001 | <question> | <FR/slice> | <name> | <date> | <fill when answered, do not delete the row> |

## 16. Change log

Append only. Never rewrite history. One row per meaningful change.

| Date | Version | Change | Reason | Affected IDs |
|---|---|---|---|---|
| <YYYY-MM-DD> | 0.1.0 | Initial draft. | - | - |

---

## Appendix A: PRD self-check (GATE-PRD)

The PRD is not ready until every box is true.

- [ ] Section 1 is understandable by a ten-year-old.
- [ ] Every FR is testable as written, with concrete values in its acceptance criterion.
- [ ] Every NFR has a number and a measurement method.
- [ ] No banned word appears (robust, seamless, intuitive, scalable, simple, flexible, appropriate, as needed...).
- [ ] Out-of-scope section is non-empty.
- [ ] Every term used more than once appears in the Glossary exactly once.
- [ ] Every data item classified PII or secret has a matching protective NFR.
- [ ] Every metric has a stated gaming risk.
- [ ] The slice plan's first entry is a Phase 0 skeleton delivering no features.
- [ ] No unfilled `<placeholder>` remains.
- [ ] Every FR/NFR has a Status value.
- [ ] Two requirements do not contradict each other (check pairwise within each section).
