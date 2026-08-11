---
title: ACC serves the UI repo's built dist same-origin (--ui-dist)
spec_id: SPEC-0006-ui-dist-serving
slice: SL-014
status: historical
created: 2026-08-08
updated: 2026-08-11
completed: 2026-08-11
owner: Kyle Smith
traces: [FR-010, FR-012, NFR-001]
---
> **ARCHIVED / VOID AS PROCEDURE.** This file preserves shipped product history and technical evidence only. Do not use it as an active plan, checklist, gate, or instruction. New work starts in GitHub Issues and is verified by `PR Gate`.


# SPEC-0006: `--ui-dist` static serving

## 1. In one sentence

`node gui/server.mjs --ui-dist <path>` (or `ACC_UI_DIST`) makes `/` and every non-API GET serve the UI repo's built `dist/` same-origin — the security model (loopback, X-ACC, no CORS) unchanged — with the built-ins still at `/guards` and `/kernel.html` until ADR-0006's parity criterion retires them.

## 2. Why / scope

The ACC half of ADR-0006 (the UI-repo split): ~45 LOC in `gui/server.mjs`, nothing else. This is the FIRST request-derived filesystem path in the server, so the traversal containment IS the spec. Out of scope: deleting the built-ins (parity criterion), any dist path committed to this repo (none — the flag names it at launch).

## 4. Acceptance criteria (all red-first in `gui/server.test.mjs`, "ui-dist" group)

| ID | Given a fixture dist | When | Then | Traces |
|---|---|---|---|---|
| AC-301 | `ACC_UI_DIST` set | GET `/`, `/assets/app.js`, `/spending` | dist index; asset with its content type; SPA fallback to index for client routes | FR-012 |
| AC-302 | same | GET `/guards`, `/kernel.html`, `/api/*` | built-ins and API unshadowed | FR-010 |
| AC-303 | a secret file OUTSIDE the dist | GET `/../s`, `/..%2Fs`, `/%2e%2e/s`, `/assets/../../s`, `/..\\s` | the outside file's content is NEVER served (no decode by design; backslashes normalized; resolved-path containment) | NFR-001 |
| AC-304 | unset / broken dist | GET `/` | unset: kernel page byte-identical to before; dist without index.html: 500, never a crash | FR-010 |
| AC-305 | the CLI flag | `--ui-dist <path>` | sets the env the handler reads; unknown extensions serve as octet-stream | FR-012 |

## 5. Properties

PROP-301: for all request paths, the file read is inside `resolve(dist)` or is `dist/index.html` — no decoding, `\\`→`/` normalization, prefix check on the resolved path (AC-303's generator: raw/encoded/backslash traversal shapes).

## 8/12. Recorded tests, budget, and outcome

T-I-007 in the historical ledger records the integration coverage. The implementation added 45 source lines and 75 test lines with no new dependencies. Recorded automated evidence was 67/67 tests green and covgate for `gui/server.mjs` at 100/100/90.2; `gui/README.md` was updated in the same implementation commit.

The former completion text also requested verification with a real UI-repository dist and Kyle's guards-toggle round trip into `config.json`. This file contains no completed record of those manual observations. They remain unverified historical evidence only, not active tasks, gates, or instructions.

This file was archived under `specs/done/` during the 2026-08-11 lean-process reset. Its archival does not claim that unrecorded manual evidence passed.
