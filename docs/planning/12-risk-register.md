# 12. Risk, Complexity, and Kill Criteria

Consolidates every artifact's exposure: the risk register, complexity accounting against the Section 4 budget, the net LOC roll-up, kill criteria for each major proposal, the Out-of-Brief Register, and the Open Decisions Register (every batched gate question from artifacts 01 through 13, distilled to what actually needs the operator). Names per `00-canonical-names.md`.

## 1. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Early warning signal |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Brain harness economics: VPS-dispatched Claude Code bills the metered Brain key instead of the operator's subscription, silently raising cost per task | High | High | Per-run dollar ceilings (7.7); cost ticker surfaced in UI; OD-01 decides dispatch placement before the Brain milestone | Operator + 07 | first weekly `core.llm_call` roll-up exceeding the subscription-equivalent baseline |
| R-02 | Provider correlation: one Anthropic incident degrades the Brain and the primary harness together | Medium | Medium | queue-and-hold degradation (7.2); Codex/Gemini adapters as routing fallback once implemented | 07 | provider status page incidents coinciding with parked runs |
| R-03 | Single-VPS concentration: LifeOS + Shell + Brain + Handler A on one host with unverified capacity | Medium | High | ADR-04 split-out order (Brain first); OD-16 capacity check before the Brain deploy issue | Operator | sustained memory pressure or healthz latency drift after M2 |
| R-04 | Platform IdP re-point executed partially, stranding the LifeOS frontend against the wrong issuer | Low | High | 05-e one-train deploy sequence; break-glass `LIFEOS_AUTH_MODE=disabled` documented | 05-e | login failures immediately after the auth train |
| R-05 | RLS re-pin breaks live CI suites mid-transition | Medium | Medium | 06 six-step sequence keeps owner-credential suites green before the pin lands; `supabase db diff` parity check first (06 gate 5) | 06 | any red PR Gate during S1-S6 |
| R-06 | Kernel contract coupling: Brain releases blocked by ACC kernel changes or vice versa | Medium | Medium | `kernel.contract.v1` versioning (07 gate 3); acc-ci gates kernel changes | 07 + ACC | a Brain issue blocked on an ACC PR |
| R-07 | Zone drift: Shell and LifeOS zones diverge visually/behaviorally despite packages/ui | Medium | Low | shared tokens with CI contrast checks (09); ADR-02 reversal trigger to full absorption | 09 | operator notices two products at V1 review |
| R-08 | Prompt injection via repository content steering Brain planning or harness actions | Medium | High | data-fenced prompt assembly, contract-derived tool allowlists, Brain-executed verification, Guards fail-closed, approval gates (7.10) | 07 | eval corpus injection cases failing; unexplained contract deviations in the journal |
| R-09 | Infisical becomes a single point of failure for all deploys | Low | Medium | ADR-05 reversal to SOPS/age with the same path layout; deploys are the only dependency, runtime is env-injected | ADR-05 | two consecutive deploy failures on Infisical errors |
| R-10 | Workspace tooling (first root package.json) introduces cross-app build coupling | Low | Medium | packages are leaf libraries only; apps keep independent builds and CI path scopes | ADR-01 | a change in packages/* breaking two app pipelines at once |
| R-11 | Live-Supabase e2e flakiness persists despite D-12 fixes | Medium | Low | per-run namespacing + owner-credential run (06); retries stay 0 by policy | 05-d | a second timing-symptom failure post-fix |
| R-12 | Process-artifact regrowth: docs/planning becomes a living second source of truth, recreating what the operator purged | Medium | Medium | C1 freeze rule at V1 kickoff (OD-05); Issues remain the durable work source | Operator | edits to docs/planning after implementation starts |

## 2. Complexity accounting (against the 04 budget)

| Dimension | Ceiling | End-state usage | Verdict |
| --- | --- | --- | --- |
| Deployable units | 5 | 5: LifeOS stack, Shell static, Brain container, Handler A service, hyperbolic-core platform container | AT ceiling (5 units approved for V1); hyperbolic-core is the platform container for shared services, migrations, platform-layer updates; Caddy reserve displaced, recorded in 08 section 3 and 10 section 2; any sixth unit must displace one |
| Distinct runtimes | 3 (Node 22, Python, browser) | 3 (PowerShell remains operator-machine only, outside deployables) | PASS |
| Databases | 2 Supabase projects + SQLite + ACC local JSON | unchanged; Brain state = SQLite (existing class), platform telemetry = existing project | PASS |
| Auth flows | 1 (+ documented break-glass) | 1 platform Supabase Auth session; break-glass LifeOS disabled-mode; ACC loopback token is a local credential, not a login flow (05-b argument accepted) | PASS |

## 3. Net LOC delta summary (all phases, estimates from the owning artifacts)

| Artifact | Added | Deleted | Net |
| --- | --- | --- | --- |
| 05-a Shell | ~2,780 | 0 | +2,780 |
| 05-b ACC fixes + supersession | ~470 | ~660 | -189 (V1 scope; ui/ deletion ~1,900 deferred) |
| 05-c Toolbelt platform | ~1,150 | ~171 | +979 |
| 05-d Prompt Organizer | ~1,100 | ~60 | +1,040 |
| 05-e LifeOS | ~900 | ~50 | +850 |
| 05-f Network Checker | ~1,209 | ~100 | +1,109 |
| 05-g Guards | ~279 | 0 | +279 |
| 05-h Idea Intake | ~1,050 | 0 (forgepad deletion counted in 05-b) | +1,050 |
| 06 platform DDL | ~560 | 23 policies/grants replaced | +560 |
| 07 the Brain | ~6,300 (4,000 avoided via kernel reuse) | 0 | +6,300 |
| 08 packages/llm + Handler A | ~1,860 | 0 | +1,860 |
| 09 packages/ui | ~2,700 total, of which ~900 is the Brain-gated chat bucket overlapping 07's 1,200 UI estimate; overlap adjustment -1,000 | deferred deletions (ACC components, LifeOS bespoke styles) | +1,700 adjusted |
| 10 CI/CD | ~680 | ~45 deferred | +680 |
| Total | ~21,000 raw, ~20,000 after the 07/09 overlap adjustment | ~1,100 immediate (+~2,000 deferred deletions post-absorption) | ~ +19,000 |

Reading: V1 is a net-additive foundation dominated by one component (the Brain plus its UI is roughly 40 percent of all new code). Every other line item stays in the hundreds-to-low-thousands, and the deferred deletion pipeline (ACC ui/, LifeOS bespoke styles, forgepad) claws back ~2,600 after absorption.

## 4. Kill criteria (observable conditions to abandon, not push through)

| Proposal | Kill condition |
| --- | --- |
| The Brain | Seed eval corpus (5 cases) cannot be made to pass deterministically within the first two implementation weeks of M4; or first-month metered spend exceeds twice the value-equivalent baseline with OD-01 unresolved; or the approval flow is bypassed by the operator in practice (approvals auto-expire unused three times in a row) |
| Multi-zone Shell | Session propagation across zones requires more than the packages/platform-client contract to work (any zone-specific auth hack appears); fallback: full absorption (Option A) or plain links |
| Handler A service | Fewer than two real consumers by the end of M4; fold back to library-only and revisit II-4's compute placement |
| Idea Intake | The structural immutability mechanism (05-h) cannot be expressed in Supabase Postgres as specified (triggers/grants insufficient in practice); descope to API-level enforcement is NOT acceptable per the brief; the app ships later instead |
| RLS re-pin | CI cannot be kept green through the 06 S1-S6 sequence after two attempts; revert to authenticated_all and re-plan with clone-table fencing |
| packages/ui | Sub-app adoption measurably exceeds 3 steps or both app teams (operator hats) route around it; freeze the package and keep per-app styles |
| NC change lifecycle | The three seed fixes cannot produce deterministic dry-run/verify probes; ship the inventory model alone and keep fixes human-run |
| tailscale serve as gateway | First concrete need for edge logic serve cannot express (ADR-07 trigger); successor Caddy must displace a unit |

## 5. Out-of-Brief Register (work outside this monorepo's reach, with cost and justification)

| Item | Where | Cost | Justification |
| --- | --- | --- | --- |
| D-13: gate `build-backend` on a repository variable | standalone kgsmith19/lifeos ci.yml | one `if:` line | ungated image publish on every main push is the exact hazard root AGENTS.md documents |
| release-smoke tailnet conversion (drop Funnel exposure if present) | standalone lifeos | ~6 workflow lines | closes ADR-06's [UNKNOWN] public-exposure question |
| lifeos image retention + explicit rollback runbook rows | standalone lifeos | docs + retention flag | 10 section 8.1 assumes it |
| `/life/*` base-path configuration (Vite base, router basename, FastAPI root_path) + smoke URL updates | standalone lifeos | ~20 lines config | required by ADR-02 one-origin routing (OD-03 confirms direction first) |
| Auth re-point deploy train execution (Infisical values + one redeploy) | standalone lifeos pipeline + Infisical | config only | LO-2; must run as one train (R-04) |
| Verify/instate Guards + ACC hook registration | operator machine ~/.claude | minutes | 01-inventory gate 2; GU posture assumption |
| Branch-protection required checks for the four PR Gates | GitHub settings | minutes | 10 gate 1 |
| Infisical paths and machine identities per ADR-05 | Infisical | config | prerequisite for M1 |
| VPS capacity check (RAM/CPU headroom for 3 new services) | VPS | minutes | R-03 input, before M2 deploys |
| GitHub label conventions audit for Idea Intake's scheme | GitHub repos | minutes | 05-h gate 3 |
| Propose agent-engineering-standard exception for bounded planning engagements | agent-engineering-standard AGENTS.md §Forbidden artifacts | two sentences added to the exception list | permits temporary docs/planning/ when repository's CLAUDE.md mandates them for a bounded engagement; requires freeze after implementation starts (Issues remain durable source); resolves the C1 contradiction (13-dissent.md) |

## 6. Open Decisions Register

Only items where the operator's answer changes work. Every other artifact gate question adopts its stated default silently; `11-roadmap.md` is generated against these defaults.

**Authority and revisability**: This register records the current recommended decision, rationale, and owner, but is not an immutable contract. The operator retains full authority to revise any decision at any time during implementation. When a decision changes, the register is updated and the resulting implementation impact is assessed. Agents may identify the consequences of a change but must not argue with, resist, or silently reverse an operator decision.

| ID | Decision | Options | Recommendation | Cost of delay |
| --- | --- | --- | --- | --- |
| OD-01 | Brain harness dispatch placement (the economics question, 07 gate 1 / 13 C5) | (a) VPS dispatch on the metered key; (b) operator-machine worker keeping subscription billing | (a) for V1 simplicity, with R-01's ceilings and warning signal armed | Highest of all: (b) reshapes 07 sections 7.3/7.4; deciding after M4 starts means rework of the dispatch path |
| OD-02 | Platform IdP project direction (04 gate 1) | toolbelt project as IdP (chosen) vs lifeos project | keep toolbelt project | blocks M1 owner-user setup; zero cost if decided at kickoff |
| OD-03 | LifeOS under `/life/*` vs LifeOS at origin root (05-a gate 2) | prefix LifeOS (chosen) vs prefix the Shell | prefix LifeOS | blocks the serve-routes issue and the standalone base-path item |
| OD-04 | Handler A as fourth unit vs Edge Function deferral (08 gate 1 / 10) | unit (chosen) vs Deno Edge Function | unit | blocks M4 Handler A issues; Edge Function path breaches the runtime ceiling instead |
| OD-05 | docs/planning freeze rule at implementation start (13 C1) | freeze (recommended) vs living docs | freeze; Issues are the durable source | R-12 grows with every week undecided |
| OD-06 | LifeOS V1 feature pair (05-e gate 1) | (a)+(g) recommended vs swapping in money rollup (e) | (a)+(g) | blocks two M5 issues only |
| OD-07 | Forgepad `rejected` ideas disposition (05-b/05-h) | archive tarball with printed audit (default) vs import as drafts with a note prefix | default | none until the migration issue runs |
| OD-08 | Prompt Organizer migration filename rename for the ledger baseline (06 gate 3) | rename once (recommended) vs no clean CLI ledger | rename | blocks toolbelt-db workflow issue |
| OD-09 | Gitleaks-style secret-scan CI step (05-g gate 2) | keep (recommended) vs strike | keep | none; 24 lines either way |
| OD-10 | Command palette in V1 Shell (05-a gate 1) | keep (lowest ROI, cuttable) vs cut | keep unless M2 runs long | none until M2 sequencing |
| OD-11 | Theme default posture (09 gate 1) | follow OS (recommended) vs forced dark | follow OS | none; one line |
| OD-12 | SH-4 latency measured at the gateway (03 gate 1) | gateway measurement (recommended) vs browser | gateway | none; test-harness detail |
| OD-13 | LifeOS chat system prompt served from the store in V1 (05-d gate 1) | seed-as-canonical-copy until post-V1 (default) vs live consumption now | default | none until the LifeOS chat issue |

Informational confirmations wanted, not decisions: live values of `DEPLOY_ENABLED`/`BACKUP_ENABLED`; `supabase db diff` parity result (06 gate 5); netcheck mirror project existence; hook registration state; VPS capacity numbers.

## Gate questions (batched, non-blocking)

None new. This artifact closes the question loop: everything is either an OD row, an informational confirmation, or an adopted default.

## Self-check (Section 10)

- Every factual claim labeled: PASS (figures cite their owning artifacts)
- No implementation code produced: PASS
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: N/A (no new technology here)
- Acceptance criteria: N/A (register artifact)
- LOC delta reported: PASS (section 3, additions and deletions, with the overlap adjustment stated)
- Deletion list: PASS (immediate ~1,100 and deferred ~2,000 tracked in section 3)
- Latency budgets: N/A (no new paths)
- Questions batched: PASS (none new; register consolidates all prior gates)
- Zero em dashes: PASS
- Complexity budget breaches: none; section 2 shows AT-ceiling on units with the displacement recorded
