# 13. Dissent

The operator asked to be pushed back on. Eight challenges to assumptions embedded in the brief, each with: the assumption, why it may be wrong, what this plan does instead, and the cost of the alternative. Explicit agreements follow, then the brief's internal contradictions and how the plan resolves each. Names per `00-canonical-names.md`.

## Challenges

### C1. Committed planning artifacts contradict the operator's own 24-hour-old standard

- Assumption: planning artifacts belong in `docs/planning/` as committed files (brief, Sections 0 and 5).
- Why it may be wrong: on 2026-08-12 the operator's own agent-engineering-standard, pinned by this repo's `standard.lock`, declared SPEC files and ADRs forbidden artifacts to be "removed on sight", after deliberately purging exactly this class of document [VERIFIED: standard AGENTS.md forbidden-artifacts section; purge commits cba837d, f7018c9]. This engagement re-grows, in one day, the process weight the operator spent the previous day deleting. The stated philosophy was "the Issue is the durable artifact".
- What this plan does instead: obeys the brief (operator instruction outranks the informational standard) but treats these artifacts as point-in-time provenance, not living governance: Phase 11 converts every actionable item into GitHub Issues, and the recommendation is to freeze `docs/planning/` after V1 implementation starts (edits only via a superseding Issue), preventing a parallel source of truth.
- Cost of the alternative (Issues-only, no committed docs): a 12-phase interdependent design cannot be reviewed or diffed as 80 scattered Issues; cross-references (contracts, DDL, budgets) would live nowhere stable. The committed set is the lesser evil; the freeze rule is the guard against the failure mode the standard was written to prevent.

### C2. The backend/UI folder split is the wrong cut

- Assumption: hyperbolic-core should split into `backend/` and `UI/` (brief, ADR-01 prompt).
- Why it is wrong: it organizes by technical layer while the brief's own constraint says organize by sub-app; it would shear LifeOS (a working, deployed product) across two trees, break subtree provenance, and force every CI path filter to churn for zero single-operator benefit [VERIFIED: current path-scoped workflows; 01-inventory].
- Instead: ADR-01 keeps the `apps/` per-product layout, adds `apps/shell/`, `packages/`, `services/`.
- Cost of the alternative kept: first workspace tooling at the root (~30 config lines) and a standing risk that shared `packages/` code drifts from app conventions.

### C3. Two LLM handlers is the wrong shape for the right instinct

- Assumption: two separate handlers, general-purpose and Brain-specific (brief, Phase 8).
- Why it may be wrong: two independently coded handlers duplicate the expensive part (provider abstraction, ~1,100 LOC plus double maintenance on every provider drift), while one shared handler service violates the Brain-key isolation requirement structurally.
- Instead: 08 splits abstraction from deployment: one `packages/llm` library, two instances (Handler A service with general keys; the Brain linking the library in-process with its isolated key).
- Cost: shared contracts mean a breaking library change touches both consumers; accepted as the point of contracts.

### C4. Full ACC-LifeOS shell unification is speculative beyond navigation and session

- Assumption: one coherent product uniting LifeOS, ACC, and Toolbelt implies deep unification.
- Why it may be wrong: LifeOS is a finished, deployed product with its own test discipline and release cadence [VERIFIED: standalone CI, 19 ADRs]; ACC surfaces are operational tooling. The demonstrated V1 value is one login, one origin, one nav chrome, not a merged codebase; forcing single-app unification would touch the only working production pipeline for aesthetic coherence.
- Instead: ADR-02 multi-zone behind one origin, shared tokens via `packages/ui`, with a mechanical later path to full absorption and an explicit reversal trigger (visible drift).
- Cost: two React bundles and a drift risk between zones, mitigated but real.

### C5. The Brain's V1 complexity must be earned, and the economics have a hole

- Assumption: the Brain ships in V1 as specified.
- Why it may be wrong: it is the single largest addition (~6,300 LOC, a deployable unit, a metered API key). The sharpest issue is economic, flagged in 7.14 gate questions: harnesses dispatched on the VPS authenticate with API-key billing rather than the operator's Claude Code subscription, so the Brain silently converts subscription-covered work into metered spend. At high harness volume that is a real dollar regression against today's workflow.
- Instead: 07 keeps the Brain but caps V1 blast radius: kernel reuse (~4,000 LOC avoided), N=2 concurrency, per-run dollar ceilings, and the cut line stubbing everything non-essential. The economics question is a named gate question and a kill-criterion input for 12.
- Cost of the leaner alternative (no Brain; keep ACC runner + manual orchestration): no unified task contract, no independent verification, no LifeOS handoff; the foundation the whole brief orbits would slip a version. The plan ships the Brain and accepts the watch-item.

### C6. "Store all prompts" overreaches for repo-adjacent prompts

- Assumption: Prompt Organizer stores all prompts for the entire system (brief, 05-d).
- Why it may be wrong: prompts that version with code (harness system prompts, eval rubrics pinned to eval code, CI prompt fixtures) belong in git next to the code they test; moving them into a database adds a runtime dependency to builds and a drift channel between the prompt a test expects and the prompt the store serves.
- Instead: 05-d stores all runtime-injected prompts (the Brain's operational prompts, LifeOS chat, Idea Intake optimization) with name@version pinning; repo-adjacent prompts stay in git, optionally mirrored read-only for visibility.
- Cost: two homes for prompts with a stated boundary rule instead of one absolute rule; the boundary needs discipline.

### C7. Network Checker's full-configuration-control ambition is not a V1 deliverable

- Assumption: know every property and modify configuration across the network (brief philosophy).
- Why it may be wrong: honest coverage says DHCP and ethernet link-layer are not measured at all today, device write surfaces are vendor-specific, and the consent lifecycle did not exist [VERIFIED: 05-f coverage matrix; 02 section 6].
- Instead: 05-f ships the inventory model plus the sign-off change lifecycle with exactly the three existing fixes migrated; broader modification capability accrues per-device-class behind the lifecycle.
- Cost: the philosophy lands incrementally; V1 modifies only what it can dry-run, verify, and roll back.

### C8. Single-principal absolutism meets machine reality

- Assumption: exactly one authorized principal, every other principal denied every action, without exception (brief, ADR-03 requirements).
- Why it may be wrong taken literally: CI must authenticate to run live-API suites, services must call each other, and the fixture-user test model exists precisely because tests need principals [VERIFIED: SEC-03; CI token minting]. A literal reading breaks the gates the brief also requires.
- Instead: ADR-03 reads the requirement as one human principal: machine principals exist as scoped, non-interactive tokens (read-only or schema-fenced), and fixtures are fenced to a test schema.
- Cost: the purity of the one-line rule; gained: gates that still run.

## Explicit agreements (so agreement is distinguishable from omission)

1. Single-reader constraint as a design razor: agreed and applied everywhere (no roles, no staging, no multi-tenant patterns).
2. Foundation over completeness: agreed; the cut lines in 03/07 exist because of it.
3. Anthropic for the Brain key: agreed (7.2), with the reversal trigger the brief demanded.
4. Toolbelt is underdeveloped and the fix is platform structure, not more tools: agreed and diagnosed concretely (02 section 5).
5. The Idea Intake hard rule (submitted Issues are never updated by the intake app): agreed without reservation; structurally enforced (05-h).
6. Machine-verifiable acceptance criteria in EARS form: agreed; enforced across every artifact.

## Internal contradictions in the brief, named and resolved

| Tension | Resolution in this plan |
| --- | --- |
| "Most innovative 2026 solutions welcome" vs "super lean, minimal LOC, control complexity" | The innovation budget is spent on exactly one novel component (the Brain); every other decision deliberately takes the boring option, and the complexity budget in 04 is the arbiter |
| "Zero ambiguity, pinpoint specificity" vs "questions are rationed" | Three-state labeling: what cannot be verified is marked UNKNOWN with the exact command that would resolve it, and questions batch at gates instead of blocking |
| "Agents must not block on humans" (operator standing preference, cited in 7.7) vs mandatory sign-off gates (NC change lifecycle, Brain approvals) | Approvals are asynchronous parking, never synchronous polling: work continues on independent branches, and unapproved items expire with a journaled rationale |
| "Reuse LifeOS resources at the shell level" vs "LifeOS retains its specifically required operational runtime steps" | ADR-04 splits ownership: patterns and infrastructure (Tailscale, Infisical, deploy transport) generalize; LifeOS's own workflows stay untouched in its standalone repo |
| Planning artifacts mandated vs the operator's forbidden-artifacts standard | C1 above: obey the brief, freeze after V1, Issues remain the durable work source |

## Gate questions (batched, non-blocking)

1. C1's freeze rule (docs/planning becomes read-only provenance once implementation starts) needs the operator's explicit yes or no at V1 kickoff.
2. C5's harness-economics question is the one dissent item that could change an architecture decision (VPS dispatch vs operator-machine workers); it is listed in the Open Decisions Register with a cost of delay.

## Self-check (Section 10)

- Every factual claim labeled: PASS (citations to artifacts and commits throughout)
- No implementation code produced: PASS
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: N/A (no new technology recommended here)
- Acceptance criteria: N/A (dissent artifact)
- LOC delta: none (documentation)
- Deletion list: none
- Latency budgets: N/A
- Questions batched: PASS (2)
- Zero em dashes: PASS
- Complexity budget breaches: none; C5 records the pressure on the budget honestly
