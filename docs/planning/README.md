# Hyperbolic-Core V1 Planning Commission

Planning-only engagement. These artifacts contain architecture decisions, specifications, schemas, interface contracts, directory trees, migration plans, and GitHub issue drafts. They contain no implementation code. A separate implementation engagement codes against these artifacts.

## Statement of understanding

1. This is a planning engagement for hyperbolic-core V1. The deliverables are the numbered artifacts in this directory, specific enough that two independent engineers or coding harnesses would build the same system without guessing.
2. Every claim about current behavior is labeled `[VERIFIED: <path or command>]`, `[INFERRED: <reasoning>]`, or `[UNKNOWN]`. Unlabeled assertions are a failure condition.
3. The system serves exactly one operator (`kylegsmith19@gmail.com`). Every recommendation is scored against the Section 4 global constraints: minimal net LOC, low friction, high ROI, industry standard by default, speed, a hard complexity budget, and foundation over completeness.
4. Twelve forced decisions receive exactly one recommendation each. "It depends" is a failure condition. Dissent against the brief itself is mandatory (`13-dissent.md`, at least six challenges).
5. Phases execute in order, one commit per phase on this branch. Gate questions are batched per artifact and consolidated into the Open Decisions Register in `12-risk-register.md`. Nothing blocks on the operator; the operator can interrupt at any commit checkpoint.

## Artifact index

| Artifact | Phase | Status |
| --- | --- | --- |
| `00-canonical-names.md` | 1 | pending |
| `01-inventory.md` | 1 | pending |
| `02-health-audit.md` | 2 | pending |
| `03-v1-definition.md` | 3 | pending |
| `04-adrs.md` | 4 | pending |
| `05-a-hyperbolic-core.md` … `05-h-idea-intake.md` | 5 | pending |
| `06-supabase-schema.md` | 6 | pending |
| `07-brain-architecture.md` | 7 | pending |
| `08-llm-handlers.md` | 8 | pending |
| `09-design-system.md` | 9 | pending |
| `10-cicd-deployment.md` | 10 | pending |
| `11-roadmap.md` + `issues/` | 11 | pending |
| `12-risk-register.md` | 12 | pending |
| `13-dissent.md` | 12 | pending |

## Standing note on the committed-artifacts rule

The agent-engineering-standard baseline referenced by `standard.lock` forbids committed SPEC and ADR documents. This directory exists because the operator's planning brief explicitly mandates committed planning artifacts under `docs/planning/`, and repository-specific operator instructions take precedence over the informational standard reference. The tension is treated as a first-class dissent item in `13-dissent.md`.
