---
title: Agentic Command Center (ACC) Product Requirements Document
status: active
created: 2026-08-07
updated: 2026-08-08
owner: Kyle Smith
version: 1.5.0
---

# Agentic Command Center PRD

> **This document is the source of truth.** Code, specs, and tests derive from it. If reality differs from this document, one of them is wrong and it gets fixed the same day. This is a living document: it is updated as requirements are discovered, and every change is logged in section 15.
>
> **Writing standard:** every line must pass the four-reader test (a child, a business person, a programmer, and an LLM must all read it the same way). See `rules/03-WRITING.md`.
>
> This PRD was written after most of the system already existed (SL-000 through the kernel hardening pass). Status columns reflect that: most requirements are `done`, describing working software, not a plan.

---

## 1. What this is

This is a set of programs that watch over Claude Code (an AI coding assistant) while it works on Kyle's computer, so it can be given more freedom without more risk. One part blocks it from touching secret files or other people's code. One part is a small control panel with buttons to start, stop, and approve its work. One part lets it keep working on a task even after its memory resets. One part runs it inside hard boundaries — a list of files it may touch, a time limit, a token limit — and checks afterward, independently, whether it actually did what it was told. It runs on one person's machine today. It is free to use because there is nothing to sell.

## 2. Problem

| Field | Answer |
|---|---|
| Who has the problem | Kyle, running many long, semi-unattended Claude Code sessions on one Windows machine |
| What they do today | Watches sessions manually, retypes `/clear` by hand, re-approves risky edits by eye, and re-explains context after every reset |
| What it costs them | Attention that should go to real work, and real incidents when an unattended session touches something it should not (guard hook `~/.claude/settings.json` edit attempt, the autoApprove/runbox interaction recorded as accepted risk) |
| Why solve it now | Sessions run longer and more unattended as trust in the model grows; the blast radius of an unwatched mistake grows with it |
| What happens if we do nothing | Kyle keeps babysitting sessions by hand, or accepts undetected risk from running them fully unattended |

## 3. Users

| ID | User type | What they need to do | How often | Technical level |
|---|---|---|---|---|
| U-001 | Kyle (owner/operator) | Launch, watch, approve, and stop Claude Code sessions across several repos without re-explaining context every time | Daily | Expert |
| U-002 | A Claude Code session running inside a guarded repo | Read/write files, run commands, and hand off risky operations, all within a boundary it cannot widen itself | Continuous, every tool call | N/A (machine actor) |
| U-003 | A headless kernel-launched harness run | Execute one bounded task contract and have its real end-state verified independently of its own claims | Per kernel run | N/A (machine actor) |

## 4. Scope

### 4.1 In scope

- Blocking an agent from reading or writing secret files, guard machinery, or another cell's owned paths (`hooks/guard.mjs`, `config.json`).
- A web GUI control panel to launch, watch, stop, and approve agent work (`gui/server.mjs` + pages).
- A headless kernel that runs one bounded AI-harness task at a time under a deny-by-default policy, verifies the real end-state, and records every run in a structured ledger (`kernel/`).
- A directive store that lets work survive context resets: the headless runner relaunches fresh sessions carrying `ACC_DIRECTIVE`, and each one gets the directive re-injected (`hooks/directive.mjs`, `runner/runner.mjs`).
- A launch lane that serializes every automated `claude` process spawn on the machine so concurrent bursts do not break the transport (`hooks/lane.mjs`).
- Folder routing that scopes a session to the narrowest correct working directory for the task it was given (`hooks/route.mjs`, `hooks/fixtures/ROUTING.md`).
- A launch-cap alerter that detects too many concurrent real `claude.exe` processes (`watcher/claude-cap-watch.ps1`).
- A vault for handing named secrets to an agent's process environment without ever showing it the value (`kernel/credentials.mjs`, `vault.json`).
- A machine-wide launch cap enforced at PATH-resolution time (`shim/`), with the alerter above as its watch half.

### 4.2 Out of scope (non-goals)

| ID | Not doing | Why not | Revisit when |
|---|---|---|---|
| OOS-001 | Multi-user / multi-tenant operation | Built for one operator on one machine | Never, unless someone else adopts it |
| OOS-002 | Multi-agent orchestration or concurrent kernel runs | The launch lane deliberately serializes to one run at a time; concurrency is a different, harder problem | If a real workload needs true parallelism |
| OOS-003 | Per-tool-call human approval queue | Guards decide in code at the boundary; the interactive runbox/approve flow is a separate, coarser escape hatch | Never planned |
| OOS-004 | A ledger dashboard / UI beyond the query CLI | `kernel/ledger.mjs query` plus the JSONL file is the whole "queryable" requirement | If ledger volume makes CLI browsing impractical |
| OOS-005 | An OS-level sandbox (containers, VMs) around the guarded process | The guard is a deterministic process-level boundary, documented as a convention enforcer, not a security boundary | If the threat model changes to untrusted code, not a trusted operator's own agent |
| OOS-006 | Any non-Windows platform for the shim/cap-watch layer | Built for Kyle's one Windows machine; everything else (kernel, hooks, runner, web GUI) is Node and runs and tests on Linux CI | If ACC needs to run on a second machine |

## 5. Use cases

### UC-001: Launch a guarded, watched Claude Code session

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | Guard hook registered in `~/.claude/settings.json`; `npm run gui` serving the Command Center |
| Trigger | Kyle types a task on the Start-work page and presses GO (or launches `claude` from his own terminal) |
| Main path | 1. The page creates a directive (routed folder + profile) and launches the headless runner for it. 2. Each `claude -p` run starts through the launch lane and the shim cap with the guard PreToolUse hook attached. 3. Every Edit/Write/Read the session attempts is checked against secrets, protected paths, and cell ownership before it runs. 4. The loop runs until the directive reports done/blocked or a brake trips. |
| Success outcome | The session completes its work, or hits its context ceiling and is handed off cleanly (UC-002), with no secret or protected-path touch having occurred |
| Failure paths | Guard denies a touch -> tool call fails with a message naming why; a second launch of the same directive -> HTTP 409 / runner exit 6, no second loop |
| Frequency | Many times per day |
| Traces to | FR-001, FR-002, FR-003 |

### UC-002: Survive a context-limit reset without losing the task

| Field | Content |
|---|---|
| Actor | U-002 |
| Precondition | An active directive with a working folder; the headless runner pointed at it |
| Trigger | A run ends (over budget, or simply finished its turn) with the directive still active |
| Main path | 1. The Stop hook captures the closing summary as the next cycle's handoff. 2. The runner relaunches `claude -p` with `ACC_DIRECTIVE=<id>` — the relaunch IS the context reset. 3. The new session's SessionStart hook injects the directive text, log tail, and done/blocked protocol. |
| Success outcome | The fresh session continues the same directive with no human retyping context |
| Failure paths | Identical consecutive summaries -> stuck brake (alert, exit 2); week token tier red -> runs held (exit 5); per-directive hard ceiling hit -> loop halts with an alert/log entry (exit 7); maxRuns/timeout ceilings |
| Frequency | Whenever a long task outruns one context window |
| Traces to | FR-004, FR-005 |

### UC-003: Run one bounded task through the headless kernel and trust the result

| Field | Content |
|---|---|
| Actor | U-003 |
| Precondition | A valid task contract (directive, allowed actions, budget, acceptance criteria, rollback plan) |
| Trigger | `node kernel/run.mjs <contract.json>` |
| Main path | 1. Contract is validated; a run refused before validation gets no ledger entry. 2. The harness launches with a derived tool allowlist and a guardhook enforcing contract + policy on every tool call. 3. A supervisor tick checks wall-clock, token, and tool-call ceilings, tightened by autonomy state. 4. On completion, every acceptance criterion is verified independently of the harness's own claim. 5. One `run_finalized` ledger record is written. |
| Success outcome | `accepted` (all criteria pass) or `rejected` (contract ran, criteria failed) — both are honest, ledgered outcomes |
| Failure paths | Budget breach -> `aborted-by-budget`; harness will not start -> `failed-to-start`, still ledgered; contract invalid -> `refused`, no run ever exists |
| Frequency | Per headless task |
| Traces to | FR-006, FR-007, FR-008 |

## 6. Functional requirements

| ID | Requirement | Priority | Acceptance criterion (objective) | Traces to | Status |
|---|---|---|---|---|---|
| FR-001 | The system must block an agent tool call that would read or write a file matching a `secrets` glob in `config.json`. | Must | Given a `.env` file in a guarded repo, when an agent Edit/Write/Read targets it, then the call is denied with a message naming the reason. | UC-001 | done |
| FR-002 | The system must block a write to a cell-owned path unless `.agents/task.json` declares that cell as the writer. | Must | Given a repo with `cells` configured and no `task.json`, when an agent writes inside a cell path, then the call is denied. | UC-001 | done |
| FR-003 | The system must refuse to let more than one automated `claude` process hold the launch lane at a time. | Must | Given one automated launch already holding the lane, when a second automated launch requests it, then the second is refused with a busy indication, not queued silently as a duplicate process. | UC-001 | done |
| FR-004 | ~~Console-bound `/clear` survival~~ Retired 2026-08-08 (ADR-0005): the console/keystroke mechanism was deleted; FR-011's headless loop is the continuity mechanism. | Must | (superseded by FR-011) | UC-002 | retired |
| FR-005 | The system must stop resuming a directive once the week's token tier is red. | Must | Given the week tier is red, when the runner would start a directive run, then no run starts (exit 5, alert written). | UC-002 | done |
| FR-006 | The kernel must refuse to launch a harness for a contract with no acceptance criteria or an unrecognized `verify.method`. | Must | Given a contract with an empty `acceptanceCriteria` array, when `run.mjs` is invoked, then the outcome is `refused` and no ledger entry exists. | UC-003 | done |
| FR-007 | The kernel must verify every acceptance criterion against the real end-state after the harness reports done, independent of the harness's own claim. | Must | Given a harness that claims success but never created the file an `AC` requires, when verification runs, then that criterion fails and the run is `rejected`. | UC-003 | done |
| FR-008 | The kernel must record exactly one `run_started` and one `run_finalized` ledger line per run, even under concurrent retries or a mid-run crash. | Must | Given 20 concurrent append attempts for the same run, when the ledger is read back, then no duplicate `run_started` line exists. | UC-003 | done |
| FR-009 | The system must route a session to the narrowest folder its task text names, as advice only (one injected line; never blocking a prompt). | Should | Given a task naming a specific sub-project, when routing runs, then the verdict names that sub-project's folder, not its parent. | UC-001 | done |
| FR-010 | The system must let a human hand off any operation the guard blocks or that needs elevated rights, as a reviewable script the human runs deliberately. | Must | Given a guard-denied edit to protected machinery, when an agent needs it done, then it writes a runbox script instead of failing silently. | UC-001 | done |
| FR-011 | The system must run a bound directive to completion headless — no console, no keystrokes — resuming across fresh contexts via the directive log, and holding all runs while the week token tier is red. | Must | Given an active directive with a working folder, when the runner is pointed at it, then each run receives the directive context (text, progress log, done/blocked protocol) and the loop ends only when the directive's own status leaves `active` — and given a red week tier, no run starts. | UC-002 | in-progress |
| FR-012 | The system must let Kyle create, route, launch, watch, and close a headless directive entirely from the web GUI, with at most one runner loop per directive machine-wide. | Must | Given the `/guards` page and a task description, when Kyle presses GO, then a directive exists in the store with the routed (or overridden) folder, a runner loop starts for it, the page shows its live/idle state and log tail, and a second launch of the same directive is refused (HTTP 409 / runner exit 6) while the first loop lives. | UC-001, UC-002 | done |
| FR-013 | A directive must carry a `tags` array; the routing verdict label is added automatically at creation time; the Command Center list must be filterable by tag. | Should | Given a directive created with task text that routes to `guards`, when the list is viewed, then the directive has at least the `guards` tag; filtering by `guards` shows it and hides unrelated directives. | UC-001 | done |
| FR-014 | A directive must carry a `doneWhen` field (natural language); the directive context injected into each session must include it so the model can self-evaluate completion without Kyle re-explaining the goal. | Should | Given a directive with `doneWhen: "the failing test is green and the PR is merged"`, when a new session starts for that directive, then the injected context includes the `doneWhen` text alongside the directive text and log tail. | UC-002 | done |

**Priority values:** `Must` (product does not exist without it), `Should` (product is materially worse without it), `Could` (nice, cut it first), `Won't` (recorded so it is not re-litigated).

## 7. Non-functional requirements

| ID | Category | Requirement | Threshold | How it is measured | Status |
|---|---|---|---|---|---|
| NFR-001 | Security | Every guard decision must fail closed on an unreadable payload or config. | 100% of unreadable-input cases deny, never allow | `kernel/guard.test.mjs`, `hooks/guard.mjs` tests | done |
| NFR-002 | Reliability | A single crashed harness or tick fault must never take down the whole kernel process. | 0 uncaught process exits from a harness fault, across the documented scenario-enumeration pass | `kernel/run.test.mjs` supervisor-fault tests | done |
| NFR-003 | Correctness | Ledger appends must be idempotent per `(runId, event)` under concurrent writers. | 0 duplicate ledger lines across 20+ concurrent writers in test | `kernel/ledger.test.mjs` | done |
| NFR-004 | Test coverage | Every CHANGED library file must meet the coverage floor before merge. | lines 100%, functions 100%, branches 90% (documented per-file overrides where node's coverage merge under-reports) | `node hooks/covgate.mjs` | done |
| NFR-005 | Maintainability | No source file should exceed roughly 250 lines without a stated reason; this is advisory here, not yet lint-enforced. | 250 lines, advisory | deterministic sweep + verdict ledger in `docs/notes/2026-08-09-nfr-005-source-size-sweep.md` | done |
| NFR-006 | Cost | Weekly token spend must be visible and gated before it becomes a surprise. | amber/red thresholds configured in `policy.json`, enforced by `hooks/usage.mjs` | `hooks/usage.mjs week`/`check` | done |
| NFR-007 | Availability | Runner liveness must be visible and duplicate loops impossible: at most one loop per directive machine-wide, with running state surfaced. | pid-file singleton refuses duplicates (exit 6); `running` badge on the Command Center list | `runner/runner.test.mjs` singleton group; `gui/server.test.mjs` AC-106 | done |
| NFR-008 | Portability | The hermetic fast-tier test suite must run identically on Linux CI and Windows. | same pass/fail; the only Windows-only suites left are the three shim/cap-watch PowerShell files | `npm test` / `npm run test:windows` + CI windows job | done |
| NFR-009 | Data durability | No committed ledger write is lost to a process crash mid-write. | lock-protected append with stale-lock reap; no test-observed loss across repeated concurrent runs | `kernel/ledger.test.mjs` | done |
| NFR-010 | Privacy | None, because this system handles no PII — its only sensitive data is API keys/secrets, covered by NFR-001 and the vault design. | n/a | n/a | done |

## 8. Data requirements

| ID | Data item | Meaning in plain language | Source | Classification | Retention | Traces to |
|---|---|---|---|---|---|---|
| DR-001 | Vault keys (`vault.json`) | API keys/secrets an agent's process may need, by name | Kyle, via the web GUI's vault section | secret | Until Kyle removes the key; gitignored, plaintext on disk | FR-010 |
| DR-002 | Kernel ledger (`runner/ledger/*.jsonl`) | One record per kernel run: contract summary, outcome, criteria results | `kernel/ledger.mjs` | internal | Kept indefinitely; it is the audit trail | FR-008 |
| DR-003 | Directive store (`runner/directives/*.json`) | A task's text and progress log, bound by directive id (`ACC_DIRECTIVE`) to each session that carries it | `hooks/directive.mjs` | internal | Archived to `runner/directives/done/` on completion | FR-011 |
| DR-004 | ~~Approvals log~~ Retired 2026-08-08 (ADR-0005): unattended auto-run died with the watcher; every runbox script now runs by explicit human action | — | — | — | FR-010 |

Rules: anything classified `PII` or `secret` must have a matching NFR — DR-001 is covered by NFR-001 (fail-closed guard) and the vault's by-name-not-by-value design.

## 9. Constraints

| ID | Constraint | Type | Source | Consequence |
|---|---|---|---|---|
| CON-001 | The launch shim and cap-watch are Windows-only PowerShell; everything else is portable Node. | technical | Built for Kyle's one Windows machine | Three PS1 suites run only on the CI windows job; the rest tests on Linux |
| CON-002 | No runtime dependencies beyond `node:test`; `@playwright/test` is the one devDependency. | technical | Deliberate choice to keep the harness simple and auditable | Any new capability is either hand-rolled or needs written approval to add a library (rules/00-CORE.md) |
| CON-003 | The guard is a convention enforcer, not a security boundary. | technical | Documented ceiling in `kernel/guard.mjs`'s own header | Symlink and exotic-Windows-path bypasses are accepted risk, not defects |
| CON-004 | ~~autoApprove unattended runbox runs~~ Retired 2026-08-08 (ADR-0005): the auto-run daemon died with the watcher; runbox scripts now require explicit human action, restoring the guard's review moment | business | — | — |

## 10. Assumptions

| ID | Assumption | How to verify | Cost if wrong | Status |
|---|---|---|---|---|
| ASM-001 | Only one operator (Kyle) ever runs this harness. | No multi-user code path exists to contradict it | Low — would need real multi-tenant work to extend | verified |
| ASM-002 | An agent's own claims about what it did cannot be trusted without independent verification. | The kernel's whole verification design assumes this | High if false in the other direction (verification is unnecessary overhead) — no evidence of that | verified |

## 11. External interfaces

| ID | System | Direction | Protocol | Data exchanged | Failure behavior | Rate limit / cost |
|---|---|---|---|---|---|---|
| EXT-001 | Claude Code CLI (`claude` process) | outbound (spawned) + inbound (hooks) | process spawn + stdin/stdout, PreToolUse/PostToolUse/Stop/SessionStart hooks | prompts, tool calls, tool results | Transport failure retried with backoff via the launch lane; a hang is bounded by wall-clock/token/tool-call ceilings | One account; the launch lane serializes to avoid `econnreset` under concurrent bursts |
| EXT-002 | GitHub | outbound | git over HTTPS/SSH | commits, pushes, PRs, issues | Push/PR failures surface to the operator; no automatic retry beyond git's own | Standard GitHub API/git limits |

## 12. Success metrics

| ID | Metric | Definition (exact formula) | Baseline today | Target | Measured by | Review cadence |
|---|---|---|---|---|---|---|
| MET-001 | Fast-tier suite pass rate | passing tests / total tests, excluding documented pre-existing skips | 437/438 (1 known root-permission artifact under sandboxed CI) | 438/438 (100% excluding documented skips) | `npm test` | Every push |
| MET-002 | Coverage floor compliance | CHANGED files meeting lines 100% / functions 100% / branches 90% | passing today | stays passing | `node hooks/covgate.mjs` | Every push |
| MET-003 | Weekly token spend vs. red threshold | tokens burned in trailing 7 days / `week.redTokens` | tracked in `policy.json` | stay under amber (52% of pre-ACC baseline) most weeks | `hooks/usage.mjs week` | Weekly |

**Gaming risk for each:** MET-001/002 could be gamed by deleting or loosening tests to force green — guarded against by `rules/06-TESTS.md`'s ledger discipline (a test needs a row and a deletion criterion, not just removal). MET-003 could be gamed by turning off tracking rather than reducing spend — guarded against by the metric being read directly from `policy.json`'s `effectiveFrom` date, not a self-reported number.

## 13. Slice plan

This system was built before this PRD existed. The slice plan below is historical record, not a forward plan — new work follows the SDD cycle in `CLAUDE.md` from here on.

| Slice | Name | What becomes true | Requirements delivered | Est. net LOC | Depends on |
|---|---|---|---|---|---|
| SL-000 | Guard hook + engine | An agent tool call can be denied by a PreToolUse hook | FR-001, FR-002 | historical | - |
| SL-001 | GUI control panel | Kyle can launch/stop/approve from a window instead of raw CLI | FR-010 | historical | SL-000 |
| SL-002 | Launch lane | Concurrent automated `claude` spawns stop breaking transport | FR-003 | historical | SL-000 |
| SL-003 | Directive loop | A task survives a context-limit `/clear` | FR-004, FR-005 | historical | SL-001 |
| SL-004 | Reliability kernel | A headless, bounded, independently-verified harness run | FR-006, FR-007, FR-008 | historical | SL-000 |
| SL-005 | Kernel scenario-enumeration hardening | 12 kernel modules audited for TOCTOU/uncaught-throw gaps; 8 real bugs fixed | NFR-002, NFR-003 | historical | SL-004 |
| SL-006 | SDD rearchitecture (this change) | Repo adopts PRD-as-source-of-truth doc contract; OPEN-ISSUES.md ledger replaced by GitHub issues; dead code, redundant docs, and low-value tests removed | — | ~-2000 (net deletion) | SL-005 |

Forward plan (the ADR-0004 consolidation program — one Node core, delete the script sprawl):

| Slice | Name | What becomes true | Requirements delivered | Est. net LOC | Depends on |
|---|---|---|---|---|---|
| SL-007 | Runner ↔ directive wiring (SPEC-0001) | A directive can run headless to completion; red week tier holds runs | FR-011, FR-005 (headless path) | ~+80 | - |
| SL-008 | First real headless run (re-targeted by ADR-0005 from deletion-gate to FR-011 proof) | One real, low-stakes directive completes unattended, watched (Kyle runs; issue #15 adds the per-run ceiling first) | validates FR-011 | 0 | SL-007 |
| SL-009 | Web-GUI completion | Every WinForms tab exists in `gui/server.mjs`+HTML with Playwright coverage; the WinForms shell deleted | FR-010 (web surface) | done 2026-08-08 (tabs via SPEC-0002/3/4; shell deleted in SPEC-0005 PR-2) | - |
| SL-010 | Watcher fold-in | Re-scoped 2026-08-08: heartbeat is obsolete (no watcher) and auto-approve was retired, not ported (ADR-0005); revival would be a new spec | NFR-007 | closed by SPEC-0005 PR-2 | SL-007 |
| SL-011 | Keystroke-stack deletion | done 2026-08-08 (SPEC-0005 PR-2, ahead of SL-008 per ADR-0005): the whole console stack gone; FR-004 retired | FR-004 superseded by FR-011 | ~-6,000 actual | ADR-0005 |
| SL-012 | Launcher/root cleanup | done 2026-08-08 (SPEC-0005 PR-2): no `.cmd` survives; `npm run gui` is the entry point | — | done | SL-009, SL-011 |
| SL-013 | Web launch surface (SPEC-0005 PR-1) | A directive can be created, routed, launched headless, watched, and closed from `/guards`; one runner loop per directive enforced by a pid-file singleton | FR-012 | done (+405) | SL-007, SL-009 |
| SL-014 | `--ui-dist` serving (SPEC-0006) | ACC serves the `agentic-command-center-ui` repo's built dist same-origin; built-ins stay until ADR-0006 parity | FR-010, FR-012 | ~+45 | SL-013, ADR-0006 |

## 14. Glossary

| Term | Definition (plain language) | Not to be confused with |
|---|---|---|
| ACC | Agentic Command Center — this whole system's name | "the kernel" (one subsystem of ACC) |
| Guard | The PreToolUse hook that denies risky file reads/writes | "guardhook" (the kernel's own, separate enforcement point) |
| Kernel | The headless, bounded, independently-verified task runner under `kernel/` | The guard hook |
| Directive | A piece of work that outlives any one session: stored as a file, carried by `ACC_DIRECTIVE`, resumed headless by the runner. Renamed from "goal" 2026-08-07 (GitHub issue #12) | The third-party "Goal" plugin, which is a different mechanism entirely |
| Runbox | A folder where an agent leaves a script for a human to run deliberately | A queued prompt (a different handoff mechanism) |
| Launch lane | The machine-wide semaphore serializing automated `claude` process spawns | The launch cap (`shim/`), which is an alert-only detector, not an enforcer |
| Vault | The store of named secrets an agent's process env may receive by name, never by value | `config.json`'s `secrets` globs (files the guard blocks entirely) |
| Cell | A path prefix inside another repo owned by one contributor/agent at a time | A worktree (a git mechanism; unrelated) |
| Ledger | The kernel's append-only JSONL record of every run | The (now-deleted) `OPEN-ISSUES.md` issue tracker |

## 15. Open questions

| ID | Question | Blocks | Owner | Needed by | Answer |
|---|---|---|---|---|---|
| Q-001 | Should ACC's "goal" concept be renamed to avoid colliding with the third-party Claude Code "Goal" plugin? | FR-004 terminology | Kyle | — | **answered 2026-08-07**: renamed to "Directive" throughout this repo (`hooks/goal.mjs` → `hooks/directive.mjs`, `runner/goals/` → `runner/directives/`, `policy.json`'s `goals` key → `directives`). Kyle still needs to rename the `~/.claude/skills/goal/` skill on his own machine — that path is outside this repo and outside what a cloud session can reach. |
| Q-002 | Is the GUI's interactive-lane MessageBox/release path provably correct on a real Windows box? | NFR-002 confidence for the interactive (non-automated) launch path | Kyle | — | **answered 2026-08-07**: Kyle ran it live — Go/Stop/Start all work, busy-refusal popup renders correctly. Closed as GitHub issue #11. |

## 16. Change log

| Date | Version | Change | Reason | Affected IDs |
|---|---|---|---|---|
| 2026-08-09 | 1.6.0 | Delivered FR-013: directive-tag normalization (legacy-safe `[]` reads), route-label auto-tag insertion at create time, and inclusive tag filtering in the Command Center list. | Make active work discoverable by domain/repo without creating a second task system. | FR-013 |
| 2026-08-08 | 1.5.0 | Added FR-013 (directive tags + Command Center filtering) and FR-014 (directive `doneWhen` field injected into session context), sourced from issue #17's future-direction clarification. | Thread 2 (better categories) and thread 3 (more autonomy) from Kyle's 2026-08-07 remark, interpreted and scoped in `docs/notes/2026-08-08-future-direction-unpacked.md`. | FR-013, FR-014 |
| 2026-08-07 | 1.0.0 | Initial PRD, written retroactively against the existing system. `OPEN-ISSUES.md` retired in favor of GitHub issues; its two genuinely open entries became issues #11 and #12. | Rearchitect the repo onto an SDD documentation contract and start a simplification pass. | All |
| 2026-08-07 | 1.1.0 | Added FR-011 (headless directive continuity) and the ADR-0004 forward slice plan (SL-007…SL-012): consolidate onto one Node core, finish the web-GUI migration, retire the keystroke stack and WinForms. | Kyle's rearchitecture directive — fewer files, fewer languages, one mechanism per concern. | FR-011, FR-004, FR-005, §13 |
| 2026-08-08 | 1.4.1 | Strict leanness pass over every line (Kyle's order): the WinForms-era interactive lane category deleted from `hooks/lane.mjs`+policy (its only caller died with the GUI — `/api/lane/status` loses the `interactive` field, contract updated both repos); `budget.mjs`'s duplicate week scan replaced by usage.mjs's cached authority; dead CLI verbs (`usage context/clears`), dead fixtures, dead policy keys (`promptOptimizer`, `review.localFullSuiteInReview`, `lane.breakerBlocking`), duplicated test helpers, and the kernel e2e's silently-vacuous `runner/goals` pollution check (renamed dir) all fixed. ~700 LOC net deleted across both repos. | Leaner is safer: every deleted line is one an unattended session can no longer trip on. | §13, gui/README.md contract |
| 2026-08-08 | 1.4.0 | Added SL-014 (SPEC-0006): `--ui-dist`/`ACC_UI_DIST` serves the UI repo's built dist same-origin with resolved-path containment; built-ins stay until parity. | The ACC half of ADR-0006 — the new React UI repo (`agentic-command-center-ui`) needs a same-origin host to keep the loopback/no-CORS security model. | FR-010, FR-012, §13 |
| 2026-08-08 | 1.3.0 | SPEC-0005 PR-2 (the demolition): keystroke/ConPTY/WinForms stack deleted per ADR-0005 — FR-004, DR-004, CON-004 retired; FR-005/FR-009 ACs reworded to the headless path; NFR-007 re-targeted to runner liveness; UC-001/UC-002, scope 4.1, OOS-006, CON-001, DR-001/DR-003 updated; SL-009/010/011/012 closed; checkpoint board moved to cwd-relative `.acc/BOARD.md`. | The destination (web launch + headless loop, PR-1) was live; keeping two continuity mechanisms violated one-mechanism-per-concern. | FR-004, FR-005, FR-009, NFR-007, NFR-008, DR-003, DR-004, CON-001, CON-004, §4, §5, §13 |
| 2026-08-08 | 1.2.0 | Added FR-012 (web launch surface) + SL-013, delivered by SPEC-0005 PR-1. ADR-0005 supersedes ADR-0001's deletion-behind-F1 sequencing (Kyle's order); ADR-0006 moves the UI's future to a separate repo (`agentic-command-center-ui`) with ACC as headless core + loopback API. The keystroke-stack demolition (SPEC-0005 PR-2) will retire FR-004's console mechanism and rewrite the affected FR/NFR/DR/CON rows in its own commit. | Kyle's 2026-08-07 restructure order: web launch surface now, keystroke stack deleted now, modern UI in its own repo. | FR-012, §13, ADR-0005, ADR-0006 |
