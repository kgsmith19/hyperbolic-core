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
| Deployable units | 5 | 5: LifeOS stack, Shell static, Brain container, Handler A service, hyperbolic-core platform container | AT ceiling (5 units approved for V1); hyperbolic-core is the platform container for shared services, migrations, platform-layer updates; Caddy reserve displaced, recorded in 08 section 3 and 10 section 2; any sixth unit must displace one. Handler A's skeleton (Dockerfile, compose.yaml, deploy.yml jobs, its own Infisical identity/path) is no longer just approved-on-paper -- m3-06 built and pulled it forward from M4 to give Idea Intake's submit API a real place to run (05-h gate 1's resolution). Count and displacement unchanged; only the timing moved. |
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
| ~~release-smoke tailnet conversion (drop Funnel exposure if present)~~ RESOLVED at the infra layer: the standing Funnel grant on `lifeos-prod` (100.81.145.92) was removed from the live tailnet ACL directly, closing the public-exposure question without needing the release-smoke.yml conversion this row originally called for | standalone lifeos | ~~~6 workflow lines~~ 0 (fixed via Tailscale ACL, not a workflow change) | closes ADR-06's [UNKNOWN] public-exposure question -- RESOLVED; see 01-inventory.md gate question 4 and 10-cicd-deployment.md section 9.1 |
| lifeos image retention + explicit rollback runbook rows | standalone lifeos | docs + retention flag | 10 section 8.1 assumes it |
| `/life/*` base-path configuration (Vite base, router basename, FastAPI root_path) + smoke URL updates | standalone lifeos | ~20 lines config | required by ADR-02 one-origin routing (OD-03 confirms direction first) |
| Auth re-point deploy train execution (Infisical values + one redeploy) | standalone lifeos pipeline + Infisical | config only | LO-2; must run as one train (R-04) |
| Verify/instate Guards + ACC hook registration | operator machine ~/.claude | minutes | 01-inventory gate 2; GU posture assumption |
| Branch-protection required checks for the four PR Gates | GitHub settings | minutes | 10 gate 1; owned by `m1-13-chore-platform-production-bootstrap.md` for the first three checks (Toolbelt/ACC/Shell); the fourth (Brain) is added when m4-08 lands |
| Infisical paths and machine identities per ADR-05 | Infisical | config | prerequisite for M1; owned by `m1-13-chore-platform-production-bootstrap.md`. m3-06 adds one more identity to this list: `llm-handler-deploy`, reading `/platform/llm-handler/` (TS_OAUTH_CLIENT_ID, TS_OAUTH_SECRET, LLM_HANDLER_SSH_KEY, TOOLBELT_GITHUB_INTAKE_PAT, SUPABASE_SERVICE_ROLE_KEY) -- the last of those bypasses RLS entirely and deserves the same operational care as platform-migrations' SUPABASE_DB_URL (`docs/ops/runbook.md`'s "Handler A deployment" section). |
| VPS capacity check (RAM/CPU headroom for 3 new services) | VPS | minutes | R-03 input, before M2 deploys; VPS provisioning itself is now owned by `m1-13-chore-platform-production-bootstrap.md`; the capacity re-check before Brain/Handler A join the box remains a separate, later confirmation |
| GitHub label conventions audit for Idea Intake's scheme | GitHub repos | minutes | 05-h gate 3 |
| `TOOLBELT_OWNER_TOKEN` repository secret for `toolbelt-ci.yml` | GitHub Settings -> Secrets | minutes, once the operator holds the real owner's access token (`apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md` step 3) | Found while landing PR #11 (m3-06 review pass): once `prompt.*` RLS is pinned to the real owner (already merged), Prompt Organizer's own E2E acceptance test (`apps/toolbelt/apps/prompt-organizer/tests/e2e/critical-flow.test.mjs`) silently RLS-denies every write it depends on unless this token is threaded into the sign-in form's own auth response (the test file's own header comment documents the mechanism). `toolbelt-ci.yml` never references this variable today -- confirmed by grep -- so this job has been failing (or skipping, when path-filtered out) since the owner re-pin landed, without anyone noticing until a PR touched `apps/toolbelt/apps/prompt-organizer/` broadly enough to trigger it. No coding session holds the real owner's token (ADR-05); this is a pure operator action, same category as m1-07. |
| Propose agent-engineering-standard exception for bounded planning engagements | agent-engineering-standard AGENTS.md §Forbidden artifacts | two sentences added to the exception list | permits temporary docs/planning/ when repository's CLAUDE.md mandates them for a bounded engagement; requires freeze after implementation starts (Issues remain durable source); resolves the C1 contradiction (13-dissent.md) |

## 6. Open Decisions Register

Only items where the operator's answer changes work. Every other artifact gate question adopts its stated default silently; `11-roadmap.md` is generated against these defaults.

**Authority and revisability**: This register records the current recommended decision, rationale, and owner, but is not an immutable contract. The operator retains full authority to revise any decision at any time during implementation. When a decision changes, the register is updated and the resulting implementation impact is assessed. Agents may identify the consequences of a change but must not argue with, resist, or silently reverse an operator decision.

| ID | Decision | Options | Recommendation | Cost of delay |
| --- | --- | --- | --- | --- |
| OD-01 | Brain harness dispatch placement (the economics question, 07 gate 1 / 13 C5) | (a) VPS dispatch on the metered key; (b) operator-machine worker keeping subscription billing | (a) for V1 simplicity, with R-01's ceilings and warning signal armed | Highest of all: (b) reshapes 07 sections 7.3/7.4; deciding after M4 starts means rework of the dispatch path |
| OD-02 | Platform IdP project direction (04 gate 1) | toolbelt project as IdP (chosen) vs lifeos project | keep toolbelt project | blocks M1 owner-user setup; zero cost if decided at kickoff |
| OD-03 | LifeOS under `/life/*` vs LifeOS at origin root (05-a gate 2) | prefix LifeOS (chosen) vs prefix the Shell | prefix LifeOS | blocks the serve-routes issue and the standalone base-path item |
| OD-04 | Handler A as fourth unit vs Edge Function deferral (08 gate 1 / 10) | unit (chosen) vs Deno Edge Function | unit | **Acted on**: m3-06 built and deployed Handler A's skeleton ahead of M4 (05-h gate 1's resolution), confirming this decision rather than just recording it. Remaining cost of delay is unchanged for what's left: m4-05's /v1/* routes. |
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

## 7. Harness-economics decision (m6-04 closure, 13 C5 / OD-01)

Recorded as decided, not merely recommended, at V1 finalization: **(a) VPS dispatch on the metered Brain key**, OD-01's own recommendation. This is also what M4's implementation actually built -- the Brain's harness adapters (`services/brain/src/adapters/`) dispatch through the ACC kernel subprocess wherever the Brain daemon runs, with no operator-machine-worker alternative ever built alongside it -- so the decision has been exercised throughout, not left open pending this closure.

**Kill criterion** (explicit and standalone, per this issue's own acceptance bullet -- previously only implicit inside the Brain's general kill criteria in section 4 above):

> Abandon VPS-metered dispatch and fall back to an operator-machine worker (subscription billing, OD-01's option (b)) if, in any rolling 30-day window post-V1, metered harness spend (the `core.llm_call`/`core.cost` roll-up the m6-02 cost dashboard renders) exceeds twice the value-equivalent baseline of the same work done under the operator's subscription, with no mitigating per-run ceiling change already in flight.

Status against the rest of the Brain's section-4 kill criteria: the "seed eval corpus cannot be made to pass deterministically" clause is now resolved-safe -- m6-01 shipped all 5 named cases passing deterministically in PR-gate CI (`services/brain/evals/cases/`), re-verified on every future PR touching `services/brain/**`. The approval-flow-bypass clause stays a live, ongoing watch item by nature (a point-in-time freeze cannot close an operational-drift condition); R-01's own early warning signal below remains the standing detector.

## 8. Gate question disposition ledger

Cross-checks every "## Gate questions" section across artifacts 01 through 13 against this register (60 items total, including 13-dissent.md's own 2, already covered by C1/C5 above and OD-05/OD-01). Three disposition values, per this issue's own acceptance criterion:

- **answered** -- an OD-XX row, this artifact's own section 7 above, or another explicit resolution exists.
- **accepted-default** -- the artifact's own stated default stands, uncontested through V1 completion; per section 6's own rule, this was always the silent behavior for any gate question not promoted to an OD row.
- **reversed-with-issue-link** -- implementation diverged from the plan's stated default, with the issue that did it named.

| Artifact:# | Question (short) | Disposition |
| --- | --- | --- |
| 01:1 | LifeOS CI status / `DEPLOY_ENABLED`/`BACKUP_ENABLED` values | accepted-default: informational confirmation only (section 6's own list); does not block V1 |
| 01:2 | Guards/ACC hook registration in the live `~/.claude/settings.json` | accepted-default: informational, operator-machine-local state; GU-2 does not depend on it (05-g:1) |
| 01:3 | Netcheck mirror Supabase project existence | accepted-default: informational; the mirror stays optional and unconfigured-safe (05-f:3) |
| 01:4 | Release-smoke tailnet reachability mechanism | accepted-default: Out-of-Brief Register item (section 5); resolution recommended (10 section 9.1) but lands in the standalone lifeos repo |
| 02:1 | D-13 `build-backend` ungated | accepted-default: Out-of-Brief Register item (section 5); one-line `if:` guard, standalone repo |
| 02:2 | SEC-03 remediation ranking | answered: ADR-03 ranked it (dedicated test schema); implemented as the platform test-fence schema (m1-06) |
| 03:1 | SH-4 measured at gateway vs browser | answered (OD-12): gateway |
| 03:2 | LO-2 break-glass local login | accepted-default: no separate path named; LifeOS keeps only its documented `LIFEOS_AUTH_MODE=disabled` break-glass |
| 04:1 | ADR-03 toolbelt vs lifeos project as IdP | answered (OD-02): toolbelt project |
| 04:2 | ADR-04 VPS capacity headroom | accepted-default: informational (section 6); Out-of-Brief Register item owned by m1-13's VPS provisioning |
| 04:3 | ADR-06 egress control deferral | accepted-default: deferred, stands; no V1 harness-egress firewalling built |
| 05-a:1 | Command palette keep/cut | answered (OD-10): keep |
| 05-a:2 | `/life/*` base-path config touching the standalone lifeos repo | accepted-default: accepted (Out-of-Brief Register item, section 5) |
| 05-a:3 | Notification persistence absent in V1 | accepted-default: accepted; m2-05's notifications remain session-ephemeral as shipped |
| 05-b:1 | Token bootstrap UX (printed fragment URL vs paste-into-page) | accepted-default: printed-fragment-URL design shipped as specified (m2-09) |
| 05-b:2 | Rejected Forgepad ideas migration | answered (OD-07): default (archive tarball, printed audit) |
| 05-b:3 | Absorption timing (four-page port post-V1) | accepted-default: accepted; only the `/acc` status card + link-out shipped (m3-08's forgepad supersession) |
| 05-c:1 | Network Checker registered in `core.app` for discovery-completeness | accepted-default: accepted, listed (`kind=cli`, no route; m3-04) |
| 05-c:2 | Manifest `permissions` review- vs runtime-enforced | accepted-default: review-enforced stands, no runtime egress enforcement built |
| 05-c:3 | Golden Goose conditional slot | accepted-default: stays out of V1 (same item as 11:2) |
| 05-d:1 | LifeOS chat system prompt store-consumption timing | answered (OD-13): default (seed-as-canonical-copy until post-V1) |
| 05-d:2 | Rename-refusal UI-level vs DB-trigger | accepted-default: UI-level stands, as shipped (m5-01/m5-02) |
| 05-d:3 | `name@latest` cache TTL (60s) | accepted-default: 60s stands, no objection recorded |
| 05-e:1 | LifeOS V1 feature pair (a)+(g) vs swap in (e) | answered (OD-06): (a)+(g) |
| 05-e:2 | Auth deploy train run as one train | accepted-default: accepted; Out-of-Brief Register item (section 5) |
| 05-e:3 | Brain read lane transport (MCP vs HTTP+agent token) | answered: HTTP + agent token, as built (`services/brain/src/lifeos-surface.ts`, m4-20) |
| 05-f:1 | Future Network Checker writer enablement | accepted-default: no writer enabled in V1 (M5-04's change lifecycle covers only the three existing fixes) |
| 05-f:2 | `change approve` TTY-only, no browser/Brain approval surface | accepted-default: stands; no browser approval surface built |
| 05-f:3 | Netcheck mirror project | accepted-default: informational (same item as 01:3) |
| 05-g:1 | Guards hook registration state | accepted-default: informational (same item as 01:2) |
| 05-g:2 | Gitleaks-style CI step | answered (OD-09): keep; shipped (M1-10) |
| 05-g:3 | Per-machine overlay files tracked vs gitignored | accepted-default: tracked stands, as shipped (M1-12) |
| 05-h:1 | Submit endpoint placement (Shell serving unit vs Handler A co-location) | reversed-with-issue-link: resolved during m3-06's implementation, Handler A co-location chosen (Shell turned out static-only); see m3-06's "Architecture gap found and resolved" note (same underlying fact as OD-04's "Acted on") |
| 05-h:2 | Rejected forgepad ideas | answered (OD-07): default (shared row with 05-b:2) |
| 05-h:3 | Type label set `FEAT\|BUG\|CHORE` casing/completeness | accepted-default: as specified, used throughout every `docs/planning/issues/` file |
| 05-h:4 | `intake.optimization` read view in V1 UI | accepted-default: not added; table-only stands |
| 06:1 | e2e suite as owner+per-run-namespacing vs fixture-account test schema | accepted-default: owner + per-run namespacing, as shipped throughout `apps/toolbelt/tests/` |
| 06:2 | Owner refresh token: GitHub secret first vs Infisical immediately | accepted-default: GitHub-secret-first executed as the interim (m1-07); deploy-adjacent pipelines later moved to Infisical per ADR-05, `TOOLBELT_OWNER_TOKEN` remains a GH Actions secret for the live-Supabase test suites specifically (section 5's own Out-of-Brief Register entry), matching the stated default |
| 06:3 | Prompt Organizer migration filename rename | answered (OD-08): rename executed |
| 06:4 | `prompt.usage` hot retention (365 days) | accepted-default: 365 days stands, shipped (M1-09) |
| 06:5 | Live-schema `supabase db diff` parity | accepted-default upgraded to standing practice: `platform-migrations.yml`'s own "Prove the ledger-applied schema has not drifted" step re-verifies parity on every dispatch (m1-05), not just a one-time confirmation |
| 07:1 | Harness dispatch economics | answered (OD-01 / 13 C5): see section 7 above, now closed with an explicit kill criterion |
| 07:2 | Codex/Gemini exact headless flags | accepted-default: remain stubs in V1, as specified (`services/brain/src/adapters/stub.ts`) |
| 07:3 | `kernel.contract.v1` versioning | accepted-default: accepted, versioned as specified |
| 08:1 | Handler A as 4th deployable unit vs Edge Function deferral | answered (OD-04): unit; acted on via m3-06 (timing note in the artifact's own text) |
| 08:2 | `usd_estimate` rates via ACC's rates-table convention, no billing-API integration | accepted-default: accepted, as shipped (`services/llm-handler` pricing) |
| 09:1 | Theme default: follow OS vs forced dark | answered (OD-11): follow OS |
| 09:2 | `packages/ui` chat-bucket scope tracks the Brain milestone, not Shell day one | accepted-default: accepted; chat primitives landed with m4-15/m4-16 |
| 09:3 | Geist Mono font vs zero-byte system stack | accepted-default: font addition accepted, as shipped |
| 10:1 | Branch-protection required-check settings | accepted-default: informational GitHub-settings action; owned by m1-13 for the first three checks, `Brain PR Gate` added as the fourth once m4-08 landed (complete) |
| 10:2 | release-smoke conversion + lifeos retention rows to Out-of-Brief Register | accepted-default: accepted, recorded there (section 5) |
| 10:3 | Brain runtime Node 22 vs Python | accepted-default: Node 22 confirmed, as shipped throughout `services/brain` |
| 10:4 | Destructive migrations forbidden until the backup workflow exists | answered: m6-03 (this milestone) shipped `platform-backup.yml`; the sequencing concern is now moot -- the backup workflow exists before any destructive platform migration has been proposed |
| 11:1 | Command palette keep/cut before M2 | answered (OD-10, duplicate of 05-a:1): keep |
| 11:2 | Golden Goose conditional slot | accepted-default (duplicate of 05-c:3): stays out of V1 |
| 11:3 | Harness-economics decision as m6-04 exit criterion | answered: recorded in section 7 above, this same issue |
| 11:4 | Branch protection / m1-13 / `Brain PR Gate` fourth check | accepted-default (duplicate of 10:1) |
| 11:5 | Freeze rule executed by m6-04 | answered: executed by this issue -- freeze notice added to `README.md` (below) |
| 13:1 (C1) | Freeze rule needs the operator's yes/no at V1 kickoff | answered (OD-05): freeze; executed by m6-04 at V1 finalization rather than kickoff, per 11:5's own contingency wording -- this issue's own assignment and title (`DOCS(planning): freeze docs/planning...`) is the authorization to execute, not a separate future step |
| 13:2 (C5) | Harness-economics | answered: see section 7 above (same item as 07:1 / OD-01) |
| 12 | (none new) | closes the loop by its own text; every item above resolves to an OD row, an accepted default, or a named reversal |

Cross-check result: 60/60 gate questions carry a disposition. Zero unanswered.

## 9. Risk sign-off

Every risk in section 1's register, signed off at V1 finalization. "Reversal trigger" restates section 1's own "Early warning signal" column explicitly as the condition that would reopen this risk for re-mitigation -- observing it does not itself require action, but it ends this sign-off and returns the risk to active review.

| ID | Risk | Owner | Status at V1 finalization | Reversal trigger |
| --- | --- | --- | --- | --- |
| R-01 | Brain harness economics (metered spend vs subscription) | Operator + 07 | Accepted; mitigated by per-run ceilings, the m6-02 cost dashboard, and the explicit kill criterion in section 7 above | first weekly `core.llm_call` roll-up exceeding the subscription-equivalent baseline |
| R-02 | Provider correlation (one Anthropic incident degrades both the Brain and the primary harness) | 07 | Accepted; Codex/Gemini remain stubs (07:2, accepted-default), so the fallback mitigation is not yet load-bearing -- watched, not closed | provider status page incidents coinciding with parked runs |
| R-03 | Single-VPS concentration (LifeOS + Shell + Brain + Handler A on one host) | Operator | Accepted; ADR-04 split-out order followed | sustained memory pressure or healthz latency drift |
| R-04 | Platform IdP re-point stranding the LifeOS frontend | 05-e | Accepted; one-train deploy sequence and break-glass documented | login failures immediately after the auth train |
| R-05 | RLS re-pin breaking live CI suites mid-transition | 06 | Accepted and closed in practice; the S1-S6 sequence completed (m1-08) | any red PR Gate during a future RLS change |
| R-06 | Kernel contract coupling (Brain releases blocked by ACC kernel changes) | 07 + ACC | Accepted; `kernel.contract.v1` versioned as specified (07:3) | a Brain issue blocked on an ACC PR |
| R-07 | Zone drift (Shell and LifeOS diverge despite `packages/ui`) | 09 | Accepted; shared tokens shipped, ADR-02 reversal trigger stands as written | operator notices two products at V1 review |
| R-08 | Prompt injection steering Brain planning or harness actions | 07 | Accepted; data-fenced assembly, contract-derived allowlists, Guards, approval gates all shipped (m4-18) | eval corpus injection cases failing; unexplained contract deviations in the journal |
| R-09 | Infisical single point of failure for deploys | ADR-05 | Accepted; SOPS/age reversal path documented, not exercised | two consecutive deploy failures on Infisical errors |
| R-10 | Workspace tooling introducing cross-app build coupling | ADR-01 | Accepted; no cross-pipeline breakage observed through M6 | a change in `packages/*` breaking two app pipelines at once |
| R-11 | Live-Supabase e2e flakiness | 05-d | Accepted; per-run namespacing shipped (06:1) | a second timing-symptom failure post-fix |
| R-12 | Process-artifact regrowth (`docs/planning` becomes a living second source of truth) | Operator | Closed by this section and the freeze notice below -- the mechanism this risk named is now in force | edits to `docs/planning/` after this freeze, without a superseding Issue |

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
