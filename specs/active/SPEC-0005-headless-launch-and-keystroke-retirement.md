---
title: The web GUI launches and manages headless directives; the keystroke stack retires
spec_id: SPEC-0005-headless-launch-and-keystroke-retirement
slice: SL-013 (PR-1), SL-011 + SL-012 (PR-2)
status: in-progress
created: 2026-08-08
updated: 2026-08-09
completed:
owner: Kyle Smith
traces: [FR-005, FR-011, FR-012, NFR-007, NFR-008]
---

# SPEC-0005: Web launch surface, then keystroke-stack demolition

> One spec, two PRs, because the second is meaningless without the first: **PR-1** builds the web Start-work surface (additive, no deletions) so a directive can be created, routed, launched headless, watched, and closed from the browser. **PR-2** then deletes the entire ConPTY/keystroke continuity stack (~5,600 LOC, 1.1 MB vendored assets) that the web surface + headless runner replace. Kyle ordered the deletion ahead of the F1 proof gate on 2026-08-07 — that sequencing change is ADR-0005's decision, not this spec's.

## 1. In one sentence

Kyle can type a task into the `/guards` page, press GO, and a headless `claude -p` loop runs it to completion across context resets — after which the console-typing machinery (clearbot, ConPTY host, WinForms GUI, launcher `.cmd`s) is deleted because nothing needs it.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-012 (web launch surface — new), FR-011 (headless continuity), FR-005 (red-tier hold, headless path) |
| What Kyle can do after this that he could not before | Start, watch, and stop directive work entirely from the browser; no WinForms window, no console babysitting |
| Why this slice comes before the next one | The destination (web launch + headless loop) must exist and be tested before the only working launch UI (WinForms) is demolished |
| What we learn from shipping it | Whether the web GUI + headless runner can own the full lifecycle with no keystroke fallback |

## 3. Scope

### 3.1 In scope — PR-1 (additive)

- `gui/server.mjs`: 7 routes (`/api/route/suggest`, `GET|POST /api/directives`, `/api/directives/status`, `/api/directives/log`, `/api/lane/status`, `/api/launch`) + `profiles` on `/api/process/status` + `ACC_RUNNER` fake seam.
- `runner/runner.mjs`: pid-file singleton — one loop per job machine-wide, exit 6 on refusal, stale reclaim, release in `finally`.
- `gui/guards.html`: Start-work fieldset (suggest-on-blur folder routing, profile radios, GO = create+launch, live directive list with Mark finished / Stop restarting / 5s-polled log tail, lane/breaker line).
- Playwright: `gui/e2e/start-work.spec.mjs` + `gui/e2e/fake-runner.e2e.mjs`; config gains `ACC_RUNNER`/`ACC_ROUTING_MD`/`ACC_LANE_DIR` sandbox env and `workers: 1` (specs share one sandbox).
- Docs in the same commit: this spec, ADR-0005, ADR-0006, ADR-0001/0002 amendment notes, PRD FR-012 + SL-013, `gui/README.md` (the API contract the future UI repo builds against), TEST-LEDGER rows.

### 3.2 In scope — PR-2 (demolition)

- Delete: `guards-gui.ps1`, all four root `.cmd` launchers, `SLICE-RUNNER.md`, `gui/PtyHost.cs`, `gui/term.html`, `gui/vendor/`, `gui/ptyhost.test.ps1`, `gui/ptyhost.e2e.ps1`, `gui/guards-gui.test.mjs`, `hooks/winfind.ps1`, `hooks/clearbot.test.mjs`, `watcher/clearbot.ps1` + `sendconsole.ps1` + `stubconsole.ps1` + `stubpipe.ps1` + `screenshot-gui.ps1` + `start/stop-clearbot.cmd` + `watchdog/`, `e2e/loop.e2e.mjs`.
- Surgery: `budget.mjs` (window/clearbot/requestClear/queued machinery out; Stop messages reworded to the runner-resume path), `directive.mjs` (kick/console fields and verbs out; `KICK_TEXT` stays as the runner bootstrap constant), `route.mjs` (deny/cd-request out — purely advisory), `statusline.mjs` (`botDead` out), `usage.mjs` (`ptyAnchorPid` out), `policy.json` (`autoClear`/`directives`/`tui`/`autoCd`/`autoApprove` out; `runner.statusFile` → `.acc/BOARD.md`), server/page cleanup controls out, CI rewrite, full doc choreography (PRD, SYSTEM-REQUIREMENTS, DATA-FLOW, AGENTS.md, CLAUDE.md, README, TEST-LEDGER, spec moves).
- Grep gate: no reference to any deleted path outside `docs/adr/`, `docs/notes/`, `specs/done/`.

### 3.3 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| The React UI repo (`agentic-command-center-ui`) | Different repo; ACC only needs the API contract (`gui/README.md`) and later `--ui-dist` serving | UI-repo PR-1 + ACC PR-3 (ADR-0006) |
| `--ui-dist` static serving | First request-derived fs path in the server; wants its own traversal tests alongside a real dist to serve | ACC PR-3 |
| Deleting built-in `guards.html`/`kernel.html` | They are the only UI until the new repo reaches parity | ADR-0006's parity criterion |
| Porting autoApprove (runbox auto-run) to Node | It lived inside clearbot.ps1 and dies with it; reviving it is a scoped future feature, not a port | future spec if Kyle asks |
| A per-directive hard token ceiling | Real gap, pre-existing (issue #15) | next slice after PR-2 |

## 4. Acceptance criteria

PR-1 (all implemented red-first; server.test.mjs AC-101…AC-113, runner.test.mjs singleton group, start-work.spec.mjs):

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-101 | Routing table with signals "guards/hook" | POST `/api/route/suggest` `{text:"fix\nthe   guards hook"}` | 200; verdict names the guards route (whitespace collapsed); no-match text → `{path:null}` | FR-012 |
| AC-102 | Missing/empty/non-string/2001-char text | POST suggest | 400 before any exec | NFR-001 |
| AC-103 | Multi-line task text with quotes | POST `/api/directives` | 200; store entry byte-exact (the `--text-file` path); list shows it | FR-012 |
| AC-104 | Empty/oversize text, relative or ghost cwd, unknown or `_note` profile | POST create | 400 each; store untouched | NFR-001 |
| AC-106 | A live pid in `runner/state/directive-<id>.pid` vs a dead one vs none | GET `/api/directives` | `running` true / false / false | FR-012 |
| AC-107 | Bad status (`dead`/`active`), malformed/traversal id, multi-line or 501-char why | POST `/api/directives/status` | 400 each, store untouched; `done` archives out of the live list | FR-012 |
| AC-108 | A live log, a >16 KiB log, an archived (done) log, a traversal-shaped id, an unknown id | GET `/api/directives/log?id=` | tail served (bounded 16 KiB), done/ fallback served, 400 pre-path-build, 404 | FR-012, NFR-001 |
| AC-109 | An idle directive; then a live pid file; then a stale one | POST `/api/launch` | spawns `ACC_RUNNER` with exactly `directive:<id>` (argv recorded); 409 while live; 200 again when stale | FR-012 |
| AC-110 | Malformed ids incl. `d-a/../b`, 39-char overlength, non-strings | POST launch | 400 each, nothing spawned | NFR-001 |
| AC-113 | Any launch-surface mutation | no X-ACC / foreign Origin | 403, nothing invoked | NFR-001 |
| AC-120 | A live pid holds `state/<job>.pid` | a second `runLoop` starts | exit 6, `run` never called, holder's file untouched | FR-011 |
| AC-121 | A stale pid file (dead pid or garbage) | `runLoop` starts | reclaimed, loop proceeds, file released on exit — every exit path (done/stop/red) releases | FR-011, FR-005 |
| AC-122 | The `/guards` page, sandboxed backend | type task → blur → GO | folder auto-fills from the router, directive created with the chosen profile, fake runner receives `directive:<id>`, list shows it; Mark finished archives it; the open log tail picks up appended lines within 10s | FR-012, NFR-008 |

PR-2:

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-201 | The demolished tree | `npm test` + covgate + `npm run e2e:gui` | green; changed files at 100/100/90 | NFR-008 |
| AC-202 | The demolished tree | the grep gate (clearbot\|winfind\|PtyHost\|sendconsole\|guards-gui\|SLICE-RUNNER\|Guards Control\|conpty\|term\.html\|stubconsole\|stubpipe\|watchdog\|autoClear\|autoCd\|pendingKicks\|consolePid) | hits only `docs/adr/`, `docs/notes/`, `specs/done/`, git history — plus the three documented pin classes: this spec itself (it orders the deletion), TEST-LEDGER's deleted-tests section (it records it), and negative assertions/fixtures that pin the machinery's ABSENCE | — |
| AC-203 | An interactive session ends over hard budget with an active directive | Stop hook fires | systemMessage names the checkpoint, `>>> TYPE /clear NOW <<<`, and the exact `runner.mjs directive:<id>` resume command; no clear-request file is ever written | FR-011 |
| AC-204 | A session starts with `ACC_DIRECTIVE` set | SessionStart | binds by directive id alone (no console PID, no window state) and injects the directive context | FR-011 |

## 5. Properties

| ID | Property (for all X, …) | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-101 | For all request bodies, a directive id reaches the filesystem or argv only after matching `/^d-[A-Za-z0-9_-]{1,38}$/` — no browser string is ever a path fragment | invariant | all id-carrying routes (status/log/launch), incl. traversal shapes | NFR-001 |
| PROP-102 | For all directive texts, create(text) then read yields byte-identical text (newlines, quotes) | round-trip | strings 1..32768 incl. `\n`, `"` | FR-012 |
| PROP-103 | For all interleavings of two runLoop starts on one job, at most one proceeds; the loser exits 6 without spawning | invariant | live/stale/garbage/absent pid file states | FR-011 |
| PROP-104 | Every runLoop exit path (0/2/3/4/5/6-loser excepted) leaves no pid file behind | invariant | done, stop-file, red-tier, normal exits | FR-011 |

## 6. Budget declaration (PR-1)

| Metric | Declared | Actual |
|---|---|---|
| Net source LOC | ~450 | +199 (server) +46 (runner) +139 (guards.html) +21 (config/fake) ≈ +405 |
| Test LOC | ~350 | ~330 (server 220, runner 60, e2e 120 — net) |
| New modules | 0 | 0 |
| New endpoints | 7 | 7 |
| New UI surfaces | 1 (fieldset) | 1 |
| New libraries | 0 | 0 |
| New tests | ~20 | 17 server + 4 runner + 5 e2e = 26 (validation refusal groups counted as one each in the plan; accepted) |
| New config keys | 0 | 0 |

PR-2 is net-negative (~-5,600 LOC) — demolition has no LOC ceiling, only the grep gate and green suite.

## 7. Changes — files (PR-1, actual)

| Path | Action | Why |
|---|---|---|
| `gui/server.mjs` | modify | 7 launch routes, profiles, seams |
| `runner/runner.mjs` | modify | pid-file singleton (exit 6) |
| `gui/guards.html` | modify | Start-work fieldset |
| `gui/server.test.mjs`, `runner/runner.test.mjs` | modify | red-first suites |
| `gui/e2e/start-work.spec.mjs`, `gui/e2e/fake-runner.e2e.mjs` | create | e2e + fake seam |
| `playwright.config.mjs` | modify | sandbox env, workers:1 |
| `gui/README.md` | create | the API contract (UI repo builds against it) |
| PRD, ADR-0005/0006, ADR-0001/0002 notes, TEST-LEDGER, `specs/active/README.md` | modify/create | docs in the same commit |

## 8. Test plan

Rows copied to `specs/TEST-LEDGER.md` (T-I-006, T-U-007, T-E-004). Red runs recorded: server.test.mjs 13 fail / runner.test.mjs 3 fail before implementation; all green after (65/65, 57/57, e2e 17/17).

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Accepted by |
|---|---|---|---|---|---|
| RISK-001 | Headless runner becomes the only continuity loop before its F1 proof | med | high | ADR-0005 records the acceptance; runner already has maxRuns/maxStuck/runTimeoutMin + red-tier hold + lane + shim cap; SL-008 re-targets to a watched first real run; issue #15 next | Kyle (2026-08-07 order) |
| RISK-002 | Interactive over-budget sessions stall at the Stop message (auto-clear gone) | high | low | The message prints the exact resume command; the Start-work page relaunches in one click | Kyle |
| RISK-003 | autoApprove dies silently with clearbot | certain | med | Named in ADR-0005 consequences + PR description; web Run button covers the flow | Kyle |
| RISK-004 | Two launch paths race one directive | low | med | Runner-owned wx-claim pid singleton (PROP-103); server 409 is UX only | — |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | PR-1: revert the commit (additive, nothing depends on it). PR-2: `git revert` restores the stack wholesale; ADR-0005 records that reversal cost |
| Time to undo | minutes (git) |
| Data written that survives rollback | directive store entries and pid files under gitignored `runner/` — inert either way |
| Feature flag | none — the old and new launch surfaces coexist through PR-1 |
| Who decides | Kyle |
| Signal | headless loop proves unreliable on real work (the ADR-0001 reversal trigger, unchanged) |

## 11. Assumptions made during implementation

| ID | Assumption | Why | How to verify | Blast radius | Promoted? |
|---|---|---|---|---|---|
| ASM-101 | Playwright spec files must not share the sandbox concurrently — `workers: 1` | start-work.spec's beforeEach rewrites guards-state.json/policy.json under guards.spec mid-test (observed: 1 real failure) | suite green serialized (17/17, ~21s) | none — suite is small | no |
| ASM-102 | `_`-prefixed keys in `policy.profiles` are documentation, not profiles | `profiles._note` exists in the live policy | AC-104 refuses `_note` as a profile | none | no |

## 12. Definition of Done (GATE-SPEC-DONE)

- [x] PR-1 ACs green with recorded red runs (65/65, 57/57, 17/17 e2e).
- [x] PR-1 budget actuals filled, none over.
- [x] PR-2 ACs green (AC-201…204: fast tier 495/498 with only the pre-existing root artifact red, e2e 17/17, reworded Stop/SessionStart pins recorded red pre-surgery: budget 5, statusline 1, server 2) + grep gate clean (recorded in the PR).
- [x] PRD statuses updated per §5 of the demolition choreography (PRD 1.3.0, same commit).
- [ ] Kyle's Windows manual check: `npm run gui` → task → GO → real run under the shim; double-GO → 409/exit 6.
- [ ] Spec moves to `specs/done/` after that check (with SL-008's watched real run as FR-011's proof).

## 13. SL-008 watched real-run evidence block (manual Windows proof)

This proof is **execution-environment bound**: it must be run on Kyle's Windows machine with the installed shim/guard stack. A cloud CI/session cannot truthfully close FR-011.

### 13.1 Evidence checklist to record in this file

- [ ] `npm run gui` started from current `main` on Windows under the installed shim/guard environment.
- [ ] A bounded disposable directive was created from `/guards` with an objective `done` condition.
- [ ] First GO launched a real `claude -p` runner with the routed folder + directive context.
- [ ] Second GO while loop 1 was live was refused (HTTP 409 and/or runner exit 6), with no second working loop.
- [ ] The directive reached `done` or a correctly reported `blocked` state without console keystrokes.
- [ ] If a fresh context occurred, the next run received directive text + progress log + done/blocked protocol.

### 13.2 Closeout rule

- If every checkbox above passes: move this spec to `specs/done/` and set PRD `FR-011` to `done` in the same commit.
- If any checkbox fails: keep this spec in `specs/active/`, keep PRD `FR-011` as `in-progress`, and open a regression issue with the exact observed evidence.
