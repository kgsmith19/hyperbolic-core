---
title: GUI platform is web (Node HTTP server + HTML/JS), migrated incrementally from WinForms
status: accepted
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle Smith
traces: [FR-010]
supersedes: none
superseded_by: none
---

# ADR-0002: GUI platform is web, migrated incrementally from WinForms

> Condensed from a retired UI migration design note preserved in git history, which resolved former OI-022.
>
> **Update 2026-08-07:** ADR-0004 converts this ADR's "incremental, no fixed date" pace into a finish-and-delete plan. The migration is now nearly complete — every tab except "Start work" is on the web (SPEC-0002/0003/0004). The "both shells indefinitely" consequence below no longer holds: `guards-gui.ps1` is deleted once SL-011 ports the last (launch) tab.
>
> **Amendment 2026-08-08 (ADR-0006):** the Start-work tab is now on the web too (SPEC-0005 PR-1), completing this migration — and its in-repo-plain-HTML trajectory is superseded: the UI's future is a separate repo (`agentic-command-center-ui`) with ACC serving its built dist same-origin. The in-repo pages this ADR produced stay until that repo reaches the parity criterion recorded in ADR-0006.

## Context

The original GUI (`guards-gui.ps1`) is a single ~1,500-line WinForms file: absolute-pixel layout, no automated coverage, "not safely modifiable by anyone but the original author-plus-agent" (2026-08-03 adversarial review). A platform decision was needed for new surfaces (the kernel policy editor, the embedded terminal) without a risky big-bang rewrite of the working WinForms shell.

## Decision

New GUI surfaces are built as a local web app (`gui/server.mjs` serving `gui/kernel.html`/`gui/term.html`, Playwright-tested), added tab by tab, while the existing WinForms shell (`guards-gui.ps1`) keeps the tabs not yet migrated. There is no fixed date to finish the migration.

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **Web, migrated incrementally (chosen)** | Node HTTP server + plain HTML/JS/Playwright, tab by tab | Low — plain web stack, testable in CI (Linux) unlike WinForms | Low — each tab migrates independently | None | None |
| Full rewrite (Tauri/Electron) | Replace WinForms entirely with a packaged desktop web app | High — new build/packaging pipeline, new dependency surface | High — all-at-once cutover risk | Framework-specific packaging | Electron's binary size / Tauri's newer ecosystem |
| Keep WinForms only | Add new tabs as more WinForms code | Zero new stack to learn | n/a | Windows-only, already true today | Zero automated coverage for anything added |

## Why the chosen option

A local web server is testable on Linux CI (Playwright), has zero packaging overhead (no install step, `node gui/server.mjs`), and lets each tab migrate independently instead of committing to an all-at-once rewrite of code that currently works. This followed the then-recorded lean principle: build the surface in front of you, not a platform migration nobody had asked for yet.

## Consequences

| | |
|---|---|
| We can now | Test new GUI surfaces in CI (`gui/server.test.mjs`, `npm run e2e:gui`), unlike anything in WinForms |
| We can no longer | Treat the GUI as one file — it is now two coordinated codebases until migration finishes |
| We must maintain | Both `guards-gui.ps1` and `gui/server.mjs` simultaneously, indefinitely, until every tab has moved |
| We are exposed to | Drift between the two shells' look/behavior while both exist |

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | Low — no tab has been forced to migrate; reverting means simply not migrating further tabs |
| What would trigger a reversal | The web shell proves harder to maintain than WinForms for some class of surface (e.g. anything needing raw console handles, which is why the ConPTY terminal itself stayed C#/WinForms-hosted) |
| What is proprietary and would not transfer | Nothing |

## Verification

Each newly migrated tab ships with its own Playwright test in `npm run e2e:gui`. No fixed 90-day target — this is an ongoing, self-paced migration.
