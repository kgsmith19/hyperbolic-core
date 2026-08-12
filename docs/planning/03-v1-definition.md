# 03. V1 Definition

V1 ships to a single operator. Per component, done means: no S1 defects, the stated capability works end to end, it is deployable by one command, and it is observable. Acceptance criteria use EARS notation; every line names the command or query that proves it. Component targets here are interface-level; mechanism choices live in the ADRs (`04-adrs.md`) and per-component plans (`05-*`). Names per `00-canonical-names.md`.

## Definition of observable (applies system-wide)

The system shall expose, for every deployable unit: a health endpoint or health command, structured logs, and per-call LLM cost attribution where LLM calls exist. Verification is listed per component below.

## 1. Shell

| # | Criterion (EARS) | Verification |
| --- | --- | --- |
| SH-1 | The Shell shall serve LifeOS, ACC, and Toolbelt surfaces under one origin with one navigation chrome. | Playwright: log in once, visit each app route, assert shared nav present; exact spec lands with the Shell test suite (Phase 11 issue) |
| SH-2 | When an unauthenticated browser requests any Shell route, the Shell shall present the login flow and shall not render app data. | Playwright: fresh context, goto each route, assert login form and zero data nodes |
| SH-3 | When the operator authenticates once, every composed app shall accept that session with no second login. | Playwright: single `signInWithPassword`, then one authenticated API call per app returns 200 |
| SH-4 | If a request reaches any `/api/*` route without a valid session, then the system shall respond 401 within 50 ms (excluding network RTT). | `curl -w '%{http_code} %{time_total}'` against each API base, no auth header |
| SH-5 | The Shell shall build and deploy with one command. | the single deploy command defined in `10-cicd-deployment.md` exits 0 and the deployed health route returns 200 |

## 2. ACC (non-Brain)

| # | Criterion | Verification |
| --- | --- | --- |
| ACC-1 | The existing gate shall stay green: `npm test` passes and covgate passes with no new floor overrides. | `cd apps/agentic-command-center && npm test && npm run covgate` |
| ACC-2 | The system shall close defect D-02: `hooks/usage.mjs` reaches the default floors and its overrides are removed from `policy.json`. | `npm run covgate` after deleting the usage.mjs override keys; exit 0 |
| ACC-3 | The system shall resolve doc drift D-06 through D-09 (README, policy.json ADR citation, runner README, project.yaml). | `grep -n "e2e:gui\|SYSTEM-REQUIREMENTS\|DATA-FLOW\|docs/adr\|C:\\\\code\\\\guards" README.md policy.json runner/README.md project.yaml` returns zero hits |
| ACC-4 | Forgepad shall be superseded: routes absent, files deleted, and any live ideas migrated to Idea Intake. | `grep -rn forgepad apps/agentic-command-center --include='*.mjs' --include='*.html'` returns zero hits; Idea Intake migration query shows the row count moved |
| ACC-5 | While the ACC UI is served through the Shell session, the loopback API shall refuse requests lacking the session credential defined in ADR-03. | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:43117/api/guards/status` without credential returns 401 |

## 3. The Brain

V1 cut line detail lives in `07-brain-architecture.md` section 7.13. Definition-level acceptance:

| # | Criterion | Verification |
| --- | --- | --- |
| BR-1 | When the operator submits a task through any Brain surface (CLI, UI, programmatic), the Brain shall issue a task contract to exactly one harness and record a run row before the harness starts. | CLI: `brain run --dry-run` prints the contract; DB query for the run row keyed by the printed run id |
| BR-2 | The Brain shall parse harness structured output and persist verdicts; a run with a failing verification command shall be recorded failed, never silently dropped. | seed a task whose verify command is `false`; query run status = failed |
| BR-3 | The Brain key shall be unreadable by every other component. | the isolation check defined in ADR-05 (e.g. attempt read from a non-Brain process context) exits non-zero |
| BR-4 | The Brain shall stream progress to the ACC UI and survive a UI reconnect without losing run state. | Playwright: start run, kill the socket, reconnect, assert state resumes from the store |
| BR-5 | Every Brain-initiated harness invocation shall have cost and token accounting attributed to its run id. | query the cost table for the run id; non-null tokens and dollars |
| BR-6 | The Brain daemon shall start with one command and report health. | the start command from `07` section 7.3, then `brain status` exits 0 |

## 4. Toolbelt (platform)

| # | Criterion | Verification |
| --- | --- | --- |
| TB-1 | Every tool shall carry a manifest conforming to the schema in `05-c`; the registry shall list all manifests. | the validation command from `05-c` over `apps/toolbelt/apps/*/tool.json` exits 0; registry query count equals manifest count |
| TB-2 | The Shell shall render tool discovery from the registry, not from hardcoded lists. | delete no manifests; add a fixture manifest in a temp branch; Shell list shows it without a Shell code change |
| TB-3 | Adding a new tool shall require at most 3 steps (scaffold, migrate, register) with no file edits outside the new tool's directory except generated registration. | follow the documented steps for a scratch tool; `git status` shows changes only under the new tool dir plus generated files |
| TB-4 | Idea Intake shall be live per section 9 below. | see II rows |

## 5. Prompt Organizer

| # | Criterion | Verification |
| --- | --- | --- |
| PO-1 | Every endpoint enumerated in `05-d` shall respond per its contract with auth per ADR-03. | the contract test suite added by `05-d` issues; exit 0 |
| PO-2 | The read path used for prompt injection shall return a rendered prompt in at most 150 ms p95 from a warm client. | performance suite asserting p95 over 50 calls to the render path |
| PO-3 | Published prompt versions shall be immutable; rollback shall restore any prior version as a new version. | existing versions suite plus a rollback test; `node --test tests/versions.test.mjs` |
| PO-4 | Starter prompts shall exist for every category in the `05-d` taxonomy. | seed-verification query: one active prompt minimum per category |
| PO-5 | When another component requests a prompt by name through the injection API, the system shall serve it without that component holding schema knowledge. | injection client call from a scratch script using only the published client contract |

## 6. LifeOS

| # | Criterion | Verification |
| --- | --- | --- |
| LO-1 | Existing gates stay green in the standalone repo. | standalone repo `PR Gate` run link recorded in the ledger |
| LO-2 | Login shall move to the Shell session per ADR-03; the LifeOS-local login page shall be retired. | Playwright: Shell login then LifeOS route renders data; grep frontend for `signInWithPassword` outside the Shell auth module returns zero |
| LO-3 | The two selected V1 features from `05-e` shall each pass their own EARS criteria defined there. | per-feature suites named in `05-e` |
| LO-4 | The Brain's LifeOS surface (per `07` section 7.12) shall be callable and scope-limited. | programmatic call with a read scope succeeds; write scope without approval is refused |

## 7. Network Checker

| # | Criterion | Verification |
| --- | --- | --- |
| NC-1 | Existing suite and scanners stay green. | `bash tools/check.sh` |
| NC-2 | D-03 closes: `watch.py` gains a dedicated hermetic test. | `python3 -m unittest tests.test_watch` |
| NC-3 | The selected V1 feature from `05-f` shall pass its own criteria there. | per-feature test named in `05-f` |
| NC-4 | The change lifecycle shall enforce: no configuration write without a recorded dry-run result and an explicit operator approval token. | attempt an apply without approval in the lifecycle harness; exit non-zero and no device write recorded |

## 8. Guards

| # | Criterion | Verification |
| --- | --- | --- |
| GU-1 | Existing suite stays green. | `cd apps/toolbelt/guards && node --test "*.test.mjs"` |
| GU-2 | The V1 enforcement set defined in `05-g` shall be registered and active for every Brain- and ACC-launched harness session. | launch a kernel run against a fixture repo; a write to a protected fixture path is denied exit 2 and ledgered |
| GU-3 | Guards shall keep failing closed on unreadable config or stdin. | existing wrapper tests within GU-1 |

## 9. Idea Intake

| # | Criterion | Verification |
| --- | --- | --- |
| II-1 | Ideas shall move only draft to idea to submitted; the database shall make any other transition impossible, not merely unvalidated. | SQL attempt of each forbidden transition returns a check/trigger violation |
| II-2 | When an idea is submitted, the system shall create exactly one GitHub Issue with the label scheme from `05-h`, idempotently. | submit twice with the same idempotency key; exactly one Issue exists |
| II-3 | Once submitted, the intake app shall never update that Issue; optimization shall create a new derivative idea only. | attempt an update path against a submitted idea; refused at both API and DB layers |
| II-4 | Idea Intake shall use the general-purpose LLM handler, never the Brain key. | key-isolation check from ADR-05 run against the Idea Intake process context |

## Deferred past V1 (explicit)

| Deferred item | Reason |
| --- | --- |
| Multi-harness parallel orchestration at scale (fleets) | The Brain V1 proves the contract with serial or small-N runs; fleets multiply blast radius before the eval harness exists |
| Prompt Organizer A/B comparison and eval-linked prompts | Positive-ROI bar not cleared until usage telemetry exists (candidate ranking in `05-d`) |
| Network Checker automated remediation without sign-off | Violates the product's own consent invariant; lifecycle ships with mandatory approval first |
| LifeOS features beyond the two selected | Ranked list preserved in `05-e`; foundation over completeness |
| Public exposure of anything beyond the tailnet | Single operator; no requirement exists |
| Windows CI for Guards | Hook runs on the operator machine; CI covers POSIX semantics today; revisit if a Windows-specific defect appears |
| Replacing the fixture-user test model wholesale | SEC-03 is mitigated by repo privacy; ADR-03 sequences the fix behind Shell auth |

## Gate questions (batched, non-blocking)

1. SH-4's 50 ms budget assumes same-host or tailnet RTT; confirm the operator accepts measuring at the gateway rather than the browser.
2. LO-2 retires LifeOS-local login; if the operator wants a break-glass local login path, it must be named in ADR-03 before implementation issues are cut.

## Self-check (Section 10)

- Every factual claim labeled: PASS (criteria are normative, not factual claims; evidence lines cite prior artifacts)
- No implementation code produced: PASS
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: N/A (no technology selection here)
- Every acceptance criterion machine-verifiable with a stated command: PASS
- LOC delta: documentation only this phase
- Deletion list: carried from Phase 2 (forgepad, doc drift); no new deletions defined here
- Latency budgets stated for new paths: PASS (SH-4, PO-2; remainder set in owning artifacts)
- Questions batched: PASS (2)
- Zero em dashes: PASS
- Complexity budget breaches: none
