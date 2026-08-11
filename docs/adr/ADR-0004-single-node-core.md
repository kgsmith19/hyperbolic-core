---
title: Consolidate ACC onto a single Node core; finish the web-GUI migration; keep Node 22 zero-deps as the foundation
status: accepted
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle Smith
traces: [FR-004, FR-010, FR-011, NFR-005, NFR-008]
supersedes: none
superseded_by: none
---

# ADR-0004: Consolidate ACC onto a single Node core

> Kyle, 2026-08-07: "I hate the scripts everywhere... I'd rather have a rearchitecture to something much better... Less files, less lines of code, consolidate/fold things together. Be open to different architecture, language, backend, foundation." This ADR is the answer to that directive. It executes ADR-0001, amends ADR-0002's pace (from "incremental, no fixed date" to "finish the migration and delete WinForms"), and records the language/foundation verdict explicitly.

## Context (measured 2026-08-07)

| Surface | Prod LOC | Files | Language | Tested? |
|---|---|---|---|---|
| Node core (hooks, kernel, runner, gui/server) | 5,521 | 16 | Node 22, zero deps | 7,069 test LOC, covgate-gated |
| PowerShell/C#/cmd sprawl | 3,578 | 24 | PS 5.1, C#, batch | Mostly untested; Windows-only |
| Vendored terminal assets (`gui/vendor/`) | — | 7 (1.1 MB) | JS bundles | n/a — exist only for the embedded ConPTY terminal |

The sprawl is not incidental: nearly all of it exists to automate a live Windows console (type keystrokes, host a ConPTY, watch window PIDs) or to render a WinForms GUI. Both of those approaches already have accepted replacement decisions (ADR-0001: headless runner; ADR-0002: web GUI) — what has been missing is a commitment to finish and delete.

## Decision

1. **One core, one language.** Everything that can be Node 22 zero-deps becomes Node 22 zero-deps. PowerShell survives only where Windows genuinely requires it (UAC elevation installers, the `schtasks` shim) — target ≤ ~150 LOC total of PS1, each file with a one-line reason.
2. **Continuity goes headless** (executes ADR-0001): the runner gains directive-backed jobs (`ACC_DIRECTIVE` wiring, ~60 LOC — the SessionStart hook already composes the full directive context for any child carrying that env var). The keystroke stack (`clearbot.ps1`, `sendconsole.ps1`, `winfind.ps1`, `PtyHost.cs`, `term.html`, `gui/vendor/`, their stubs and tests — ~1,900 LOC + 1.1 MB) is deleted **after** the F1 overnight proof (issue #15), per ADR-0001's own sequencing.
3. **GUI migration finishes** (amends ADR-0002): the remaining WinForms tabs port to `gui/server.mjs` + HTML with Playwright coverage, then `guards-gui.ps1` (1,636 LOC, the largest and least-testable file in the repo) is deleted. ADR-0002's platform choice stands; its "both shells indefinitely" consequence does not.
4. **Watcher duties fold into the core**: auto-approve and heartbeat move into Node (testable on Linux CI); the kick/typing duties die with the keystroke stack; only the scheduled-task/elevation installers stay PS1.
5. **Foundation verdict: keep Node 22, zero runtime dependencies, JSONL files.** Considered and rejected: rewriting the core in Go/Rust (discards ~7,000 LOC of hard-won regression tests tied to real historical bugs, for zero functional gain — the sprawl came from the console-automation approach, not from Node), adding a database (JSONL + locks already meet NFR-003/NFR-009 with zero deps — CON-002), and a packaged desktop app (re-litigates ADR-0002, which already chose local web for testability).

## Options considered

| Option | How it works | Why not chosen |
|---|---|---|
| **Consolidate onto existing Node core (chosen)** | Finish two already-accepted migrations, fold the watcher, delete ~5,200 LOC + 1.1 MB | — |
| Rewrite in Go/Rust single binary | New codebase, single artifact | Discards the tested core; months of re-proving; zero-dep Node already deploys as "have Node 22" |
| Keep current architecture, keep deleting at the margins | More leanness passes | Three passes just completed; the remaining mass IS the two-stack architecture — margins are exhausted |
| Electron/Tauri app | Package GUI + core together | Rejected in ADR-0002 for dependency surface and packaging overhead; nothing changed |

## Consequences

| | |
|---|---|
| We can now | Test ~everything on Linux CI; reason about one process model; onboard with one language |
| We can no longer | Watch a live session typing in an embedded terminal (the GUI becomes control + logs, per ADR-0001) |
| We must maintain | The runner's job/directive contract as the single continuity mechanism |
| We are exposed to | The F1 proof failing — in which case the keystroke stack stays and this ADR's step 2 reverses via a superseding ADR (ADR-0001's own reversal clause) |

## End state (the measurable target)

Languages 5 → 2 (Node + minimal PS1). Non-test prod LOC ~9,100 → ~5,700 (−≈37%). Script files 24 → ≤5. Vendored assets 1.1 MB → 0. One GUI, one continuity mechanism, one entry point per concern.

## Historical implementation sequence

The now-retired PRD §13 recorded this implementation order: SL-007 runner↔directive wiring (SPEC-0001) → SL-008 F1 proof (Kyle, real tokens, issue #15) → SL-009 web-GUI completion → SL-010 watcher fold-in → SL-011 keystroke-stack deletion (gated on SL-008) → SL-012 launcher/root cleanup. The implementation record captured red-green evidence, covgate results, and accompanying documentation in the corresponding commits.
