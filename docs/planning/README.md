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
| `00-canonical-names.md` | 1 | complete |
| `01-inventory.md` | 1 | complete |
| `02-health-audit.md` | 2 | complete |
| `03-v1-definition.md` | 3 | complete |
| `04-adrs.md` | 4 | complete |
| `05-a-hyperbolic-core.md` … `05-h-idea-intake.md` | 5 | complete (8 files) |
| `06-supabase-schema.md` | 6 | complete |
| `07-brain-architecture.md` | 7 | complete |
| `08-llm-handlers.md` | 8 | complete |
| `09-design-system.md` | 9 | complete |
| `10-cicd-deployment.md` | 10 | complete |
| `11-roadmap.md` + `issues/` (64 drafts) | 11 | complete |
| `12-risk-register.md` | 12 | complete |
| `13-dissent.md` | 12 | complete |

The engagement is complete. The Open Decisions Register in `12-risk-register.md` section 6 lists the thirteen operator decisions (defaults adopted throughout); `11-roadmap.md` sequences all 64 issues across six milestones with the EARS coverage assertion.

## Freeze notice (m6-04, 13-dissent.md C1 / Open Decision OD-05)

As of M6 (Hardening), `docs/planning/` is frozen: point-in-time provenance for the V1 engagement, not living governance. Every gate question this set ever raised now carries a recorded disposition (`12-risk-register.md` section 8's disposition ledger, 60/60 answered), the Brain harness-economics decision is closed with an explicit kill criterion (`12-risk-register.md` section 7), and every accepted risk is signed off with an owner and reversal trigger (`12-risk-register.md` section 9).

**The superseding-Issue rule**: this freeze means no file under `docs/planning/` is edited directly after this notice lands. A decision recorded here that needs to change gets a new GitHub Issue stating what changed and why; that Issue is the durable record of the change, the same way every other piece of V1 work already is. `docs/planning/` itself stays exactly as frozen, a snapshot of the reasoning V1 was actually built against -- not silently rewritten to look as if the final state were the plan all along.

GitHub Issues remain the one durable, living source of truth for all work past this point (13-dissent.md C1's own resolution, restated here as now in force, not just recommended).

## Standing note on the committed-artifacts rule

The agent-engineering-standard baseline referenced by `standard.lock` forbids committed SPEC and ADR documents. This directory exists because the operator's planning brief explicitly mandates committed planning artifacts under `docs/planning/`, and repository-specific operator instructions take precedence over the informational standard reference. The tension is treated as a first-class dissent item in `13-dissent.md`.
