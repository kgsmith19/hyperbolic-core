# 02. Health Audit

Evidence date: 2026-08-12. Method: three parallel ground-truth inventory passes (cited in `01-inventory.md`), plus direct suite execution in this sandbox. Severity scale: S1 blocks V1, S2 degrades V1, S3 cosmetic. Labels per the engagement charter.

Headline: zero S1 defects. Every runnable suite passes (ACC 549/549, Toolbelt 15/15, Guards 35/35, Prompt Organizer 60/60, Network Checker 298/298) [VERIFIED: execution 2026-08-12]. The system's health problem is not brokenness; it is drift, orphaned work, missing platform structure, and three disjoint auth models.

## 1. Defect register

| ID | Sev | Component | Defect | Reproduction / evidence | Location |
| --- | --- | --- | --- | --- | --- |
| D-01 | S2 | ACC | Forgepad is half-shipped: a complete, tested idea store is unreachable because the server defines no `/api/forgepad*` routes, the HTML page can no longer be served, and its test file is not in the `npm test` list, so CI never runs it | open `gui/server.mjs`, search forgepad: zero routes; `package.json:9-10` lacks `forgepad/store.test.mjs` | `apps/agentic-command-center/forgepad/`; `gui/forgepad.html` |
| D-02 | S2 | ACC | `hooks/usage.mjs` has a genuine test-coverage gap; covgate floors (70/55/50) were added only to unblock the migration and are documented as unresolved debt | `policy.json:129` `_note` final sentences; `usage.test.mjs` covers only the bucket cache | `apps/agentic-command-center/hooks/usage.mjs` |
| D-03 | S2 | Network Checker | `watch.py` is the only netcheck module with no dedicated test file; it is the long-running loop that everything else feeds | grep tests/ for watch: comments only | `apps/toolbelt/apps/network-checker/netcheck/watch.py` |
| D-04 | S2 | Network Checker | The entire dashboard frontend (10 JS modules, SSE client, service worker) has zero tests | no JS test harness exists in the tree | `apps/toolbelt/apps/network-checker/frontend/` |
| D-05 | S2 | Toolbelt root | The root idea client's browser logic is untested (root tests are API-level only; browser check is manual) | `apps/toolbelt/AGENTS.md:55` | `apps/toolbelt/web/index.html` |
| D-06 | S3 | ACC | README advertises `npm run e2e:gui`, `docs/SYSTEM-REQUIREMENTS.md`, `docs/DATA-FLOW-DIAGRAM.md`, `docs/adr/`, `specs/TEST-LEDGER.md`; none exist | `README.md:33,49-52` vs file listing | `apps/agentic-command-center/README.md` |
| D-07 | S3 | ACC | `policy.json:100` cites `docs/adr/ADR-0003-launch-cap-check-then-launch.md`, deleted in the purge | file absent | `apps/agentic-command-center/policy.json` |
| D-08 | S3 | ACC | `runner/README.md` uses stale standalone paths (`C:\code\guards\runner\runner.mjs`) and references the extracted `guard.mjs`; `runner/runner.mjs:131-133` comment likewise | file reads | `apps/agentic-command-center/runner/` |
| D-09 | S3 | ACC | `project.yaml` cites `ci: .github/workflows/ci.yml`, which does not exist in the subtree (CI moved to the monorepo root `acc-ci.yml`) | nested `.github/` holds only templates | `apps/agentic-command-center/project.yaml` |
| D-10 | S3 | Network Checker | Dockerfile image-source label points at defunct `github.com/kgsmith19/network-checker`; README quick-start clones defunct `toolbelt` repo | `Dockerfile:13`; `README.md:14` | `apps/toolbelt/apps/network-checker/` |
| D-11 | S3 | ACC/root | Ledger rows blank: ACC `TEST_LEDGER.md` Windows suites row has no last-run; root ledger lifeos row untracked here by design | file reads | `TEST_LEDGER.md` files |
| D-12 | S2 | Prompt Organizer | E2E flakiness surface is structural even after stabilization: one shared fixture account "intentionally contains many other prompts", live Auth latency and 429s, `retries: 0` | test comments at `critical-flow.test.mjs:83-86`; two distinct historical timeout symptoms | `apps/toolbelt/apps/prompt-organizer/tests/e2e/` |
| D-13 | S3 | LifeOS (standalone repo scope) | `build-backend` job runs ungated on every push to main and publishes a Docker image; documented as a hazard by root AGENTS.md, live in the standalone repo | `apps/lifeos/.github/workflows/ci.yml:120-140`; root AGENTS.md | standalone `kgsmith19/lifeos` |

## 2. Dead code register

| Item | State | Evidence | Disposition proposal (final call in Phase 5) |
| --- | --- | --- | --- |
| `apps/agentic-command-center/forgepad/store.mjs` + `store.test.mjs` | working, orphaned, unimported by anything | grep imports: only its own test | Supersede via Idea Intake (`05-h`); delete after migration of any live ideas |
| `apps/agentic-command-center/gui/forgepad.html` | unreachable (no serving path, no routes) | `gui/server.mjs:28-32`; no /api/forgepad | Delete in V1 |
| `netcheck/synthesis.py` | deliberate unwired stub (Protocol + NullSynthesizer, issue #93) | imported by nothing but its test | Keep as the stable LLM-summary seam or delete; decided in `05-f` |
| ACC `runner/state/scan-cache.json` on disk | untracked local artifact embedding `/root/.claude` transcript paths | git ls-files empty for runner/state | Local hygiene only; no repo action |
| Duplicated `TEMPLATES/`, `standard.lock`, `project.yaml` per app | deliberate distribution, not dead | restructure commits | Keep; consolidation considered in ADR-01 |

## 3. Gap register (documented purpose vs implemented behavior)

| Component | Documented | Implemented | Delta |
| --- | --- | --- | --- |
| Toolbelt root | "home for general-purpose tools, apps, and services"; README lists `apps/idea-intake/` as intentionally absent | one read-only idea table + shared schemas; no registry, no launcher, no intake app | The platform layer is absent; see Section 5 diagnosis |
| ACC | README advertises purged docs and a nonexistent script | code is healthy; docs lag the 2026-08-12 restructure | Doc reconciliation pass needed (D-06..D-09) |
| Network Checker | AGENTS.md layout table lists 17 entries | 6 additional wired modules exist (bundle, experiment, exposure, geoip, topology, synthesis) undocumented in the table | Docs under-sell the product; table refresh needed |
| Prompt Organizer | grants allow `update (title, body)` | no edit UI exists; only version-restore updates body | Either ship edit UI or note the grant as restore-only surface (`05-d`) |
| Guards | brief treats its role as undefined | fully defined convention enforcer with explicit non-goals (Bash writes uninspected) | Definition gap is in the brief, not the code; `05-g` formalizes |
| LifeOS | docs claim matches implementation across 19 ADRs, invariants, constitutions | verified consistent at inventory depth | none found at this depth |

## 4. Security findings

No committed secrets anywhere; `hyperbolic-core` is a private repository [VERIFIED: GitHub API `"private": true`, 2026-08-12]. Findings ranked by real-world exposure for a single-operator system:

| ID | Sev | Finding | Evidence | Note for ADRs |
| --- | --- | --- | --- | --- |
| SEC-01 | S2 | ACC vault stores secret values as plaintext JSON at `<ACC_ROOT>/vault.json`; protection is filesystem-only | `hooks/engine.mjs:49-52` | ADR-05 must pick an at-rest mechanism; the Brain key must not live in a plaintext file readable by every local process |
| SEC-02 | S2 | ACC runner and kernel spawn `claude` with `--permission-mode bypassPermissions`; kernel does so deliberately behind its own deny-by-default guardhook (fails closed), the runner path relies on Guards + lane + budget | `runner/runner.mjs:142`; `kernel/settings.mjs:9-13`; `kernel/guardhook.mjs:5-8` | Acceptable by design for the kernel; runner-path blast radius is revisited in `07` autonomy levels |
| SEC-03 | S2 | Toolbelt fixture-user passwords are committed and those users can write to live `core`/`idea`/`prompt` schemas under `authenticated_all`-style RLS; mitigated today by repo privacy | `tests/helpers.mjs:8-9`; RLS baseline migration | ADR-03 single-principal design must retire shared fixture write access or fence it to a test schema |
| SEC-04 | S3 | ACC loopback API has no authentication; any local process can drive it (X-ACC header is CSRF hygiene, not auth) | `gui/server.mjs` bind + header check | Single-operator machine; revisit only if the Shell exposes ACC beyond loopback (ADR-06/07) |
| SEC-05 | S3 | Guards is a convention enforcer, not a security boundary: Bash-mediated writes bypass it by design | `guard.mjs:17-18` | State this limit in `05-g`; do not oversell Guards in V1 claims |
| SEC-06 | info | LifeOS auth posture is strong: ES256-only local JWKS verification, single-owner subject check, fail-closed mode, RLS deny-all on kernel tables, scoped MCP read-only tokens | `src/api/auth.py`; migration 20260726004147 | Baseline pattern for ADR-03 |
| SEC-07 | info | Egress: ACC makes zero network calls; netcheck calls ipapi.co and probe targets; LifeOS backend calls Anthropic, SimpleFIN, SleepHQ, ICS feeds | inventory section 3 | Feeds ADR-06 egress policy |

## 5. Toolbelt underdevelopment assessment (required diagnosis)

The brief's feeling is confirmed and the cause is concrete. Toolbelt is a data spine without a platform layer:

1. Missing tool contract. Nothing defines what a "tool" is: no manifest, no declared inputs/outputs, no permissions model, no lifecycle hooks. `core.app` is a bare registry row (id, name, status) [VERIFIED: core schema migration].
2. Missing registry mechanics. Exactly one app has ever been registered, by hand-written migration; 32 of 33 seeded ideas never left status `idea` [VERIFIED: migrations 20260807040000, seed].
3. Missing discovery and navigation. The root client is a read-only backlog table; Prompt Organizer and the netcheck dashboard live on separate ports with separate sign-ins; nothing enumerates or launches tools [VERIFIED: web/index.html; AGENTS.md commands].
4. Missing lifecycle. Adding a tool today is roughly 8 manual steps touching 3+ files outside the new app plus out-of-band SQL execution [VERIFIED: reconstruction in toolbelt inventory, section 7].
5. Missing shared runtime. Each client hand-rolls its own Supabase fetch wrapper; there is no shared client library, no workspace tooling, no package manifest at all [VERIFIED: file scan].

Conclusion: the fix is not "more tools", it is the contract + registry + shell integration specified in `05-c`, after which tools become cheap.

## 6. Network Checker deep dive (required)

Capability-by-capability status. Test tier: 298 hermetic tests all pass; scanners and doc checks pass [VERIFIED: execution]. Live tier, in this Linux sandbox:

| Capability | Status here | Evidence |
| --- | --- | --- |
| probe (gateway/hop/inet ICMP) | `unavailable` with explicit reasons (no gateway/ICMP in container); no silent failure | probe output 2026-08-12 |
| probe (public DNS, TLS, HTTP) | works: dns 2.1 ms, tls 29.4 ms, http 120.9 ms | same |
| scan (wifi/driver/events/tcp) | `unavailable` with reasons (netsh missing, not Windows); by-design platform gating | scan output |
| diagnose | runs; reports no causes with 1 sample, correct behavior | diagnose output |
| serve/dashboard | binds 127.0.0.1, routes verified in code and server tests | `server.py:79-163` |
| store + mirror | SQLite WAL source of truth; mirror explicit-unavailable when unconfigured; retry-safe sync flags | `store.py:154-209` |
| remote (modem/router/DOCSIS/SSDP/SNMP), wlan parsers | hermetic-tested pure parsers; live behavior on the operator's actual network [UNKNOWN in sandbox]; private-address gate before any credential is sent | `remote.py:84-144` |
| synthesis | stub by design, unwired | `synthesis.py` |
| watch loop | implemented, exercised only indirectly; no dedicated test (D-03) | `watch.py` |

What silently fails: nothing observed. The three-state ok/fail/unavailable contract is honored everywhere exercised; degradation is explicit, which matches the product invariant [VERIFIED: AGENTS.md invariants; live outputs].

Gap vs the brief's governing philosophy: the product measures and diagnoses well, but "know every property", full device/config inventory, and sign-off-gated configuration change are only partially present (topology + exposure exist as deep-tier scans; fix scripts exist as human-run shell helpers with no propose/dry-run/verify/rollback lifecycle). That lifecycle is exactly the `05-f` design surface.

## 7. Deletion list for this phase

Planning-phase proposals recorded now, executed via Phase 11 issues: D-01 forgepad HTML, superseded forgepad store (post-migration), ACC README drift lines (D-06..D-09 fixes are edits, net-negative LOC), netcheck stale labels (D-10). Estimated net LOC delta from this register alone: approximately -700 (forgepad HTML ~300, store + test ~260, doc lines) against +0 code.

## Gate questions (batched, non-blocking)

1. D-13 (`build-backend` ungated) lives in the standalone lifeos repo. Fixing it is a one-line `if:` guard but out of this monorepo's reach; flagged to the Out-of-Brief Register.
2. SEC-03 remediation options (dedicated test schema vs rotating fixture creds vs keeping repo-privacy mitigation) are ranked in ADR-03; no action taken here.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: N/A (no technology recommendations)
- Machine-verifiable acceptance criteria: N/A (audit artifact; registers carry reproduction paths instead)
- LOC delta reported: PASS (Section 7)
- Deletion list present: PASS (Section 7)
- Latency budgets: N/A (no new paths)
- Questions batched: PASS (2, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none
