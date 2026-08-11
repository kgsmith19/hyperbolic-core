---
title: Machine-wide launch cap uses check-then-launch with an accepted race window, not check-and-reserve
status: accepted
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle Smith
traces: [FR-003]
supersedes: none
superseded_by: none
---

# ADR-0003: Launch cap is check-then-launch, with an accepted race window

> Condensed from a retired launch-cap design note preserved in git history, which closed former OI-025.

## Context

`hooks/lane.mjs`'s launch lane already serializes *automated* `claude` spawns to one at a time. It cannot see or limit untracked manual `claude` invocations Kyle types directly, so a machine-wide count of real `claude.exe` processes was needed as a second, coarser layer: a PATH shim (`shim/claude`/`shim/claude.cmd`) that gates every launch, plus a standalone watcher (`watcher/claude-cap-watch.ps1`) that alerts on breach or fail-open.

## Decision

The shim counts currently-running `claude.exe` processes and refuses a new launch if the count is already at `policy.json`'s `lane.total` cap (default 3), then lets the launch proceed — it does not atomically reserve a slot before counting. There is a real, accepted race window: two processes launched within the same instant can both see a count under the cap and both proceed, momentarily exceeding it.

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **Check-then-launch (chosen)** | Shim counts live `claude.exe` processes, refuses if at cap, otherwise execs the real binary | Low — no new state file, no lock needed | Low | None | Small race window on simultaneous manual launches |
| Check-and-reserve (a real slot file, like the automated lane) | Shim would need to atomically claim a slot before exec, and release it on exit | Higher — needs the same mkdir-atomic-slot machinery `hooks/lane.mjs` already has, duplicated for manual launches | Would require tracking every manual process's lifetime, not just its start | None | Manual launches have no natural "release" hook the shim can hang a slot release off of cleanly |
| No cap on manual launches | Only automated spawns are limited | Zero cost | n/a | n/a | Does not address the original problem (concurrent `claude.exe` starving the automation slot's timing budget) |

## Why the chosen option

The cap's job is to catch the common case (too many concurrent sessions degrading shared transport timing), not to be a hard security boundary — `hooks/lane.mjs` already owns hard, race-free serialization for automated spawns, which is the case that actually needs correctness guarantees. Adding reservation-with-release machinery for manual, human-initiated launches (which have no reliable process-exit hook the shim can own) was judged not worth the complexity for a race window that only matters if two manual launches happen within the same instant.

## Consequences

| | |
|---|---|
| We can now | Alert when the machine-wide `claude.exe` count exceeds the cap, covering manual launches the automated lane can't see |
| We can no longer | Claim the cap is a hard, race-free guarantee — it is a best-effort alert-and-refuse, documented as such |
| We must maintain | The shim staying first on PATH (installed via `runbox/install-claude-cap-gate.ps1`, self-elevating) |
| We are exposed to | The accepted race window; and a fail-open default if the shim or watcher itself breaks, by design (never block a launch on the safety mechanism failing) |

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | Medium — would mean building the reserve/release slot machinery described in the rejected option |
| What would trigger a reversal | The race window is observed to matter in practice (concurrent manual launches actually exceeding the cap causing real harm) |
| What is proprietary and would not transfer | Nothing |

## Verification

`shim/claude.test.ps1` and `watcher/claude-cap-watch.test.ps1` cover the cap:0/cap:3 decision logic. No incident of the race window mattering in practice has been recorded as of 2026-08-07.
