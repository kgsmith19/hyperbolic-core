# ACC Migration Implementation Record

**Goal:** Fold the standalone `agentic-command-center` repository into
`hyperbolic-core` at `apps/agentic-command-center/`, preserving its full git
history, without breaking its CI or test suites — the third and final
component migration per `docs/archived/2026-08-11/toolbelt-migration-design-spec.md`'s
consolidation context.

See `docs/archived/2026-08-12/acc-migration-design-spec.md` for the full
design. This record is retrospective (the migration was executed directly,
not handed off task-by-task).

## What happened

1. **Pre-migration restructuring**, in the standalone `agentic-command-
   center` repo (`agentic-command-center#84`): GUI/UI duplicate-page
   consolidation, CI Windows-fixture-directory removal, hardcoded-path
   fixes, ADR/SPEC/legacy-doc purge, template sync. This kept the subtree
   source clean rather than importing history and then immediately gutting
   it.
2. **Subtree merge**: `git subtree add --prefix=apps/agentic-command-center
   https://github.com/kgsmith19/agentic-command-center
   claude/agentic-engineering-restructure-bujav1` (full history, no
   `--squash`) — one command, one merge commit.
3. **Post-merge fix**: a single leftover file (`templates/ADR.md`, missed by
   the standalone repo's own purge) removed both upstream and in the merged
   copy.
4. Root README's Components section updated with an
   `apps/agentic-command-center/` entry.

## Verification

- `ls apps/agentic-command-center` — the full expected tree present
  (`AGENTS.md`, `CLAUDE.md`, `README.md`, `TEMPLATES/`, `TEST_LEDGER.md`,
  `project.yaml`, `standard.lock`, `config.json`, `policy.json`, `docs/`,
  `forgepad/`, `gui/`, `hooks/`, `kernel/`, `runner/`, `shim/`, `ui/`,
  `watcher/`).
- History preserved (not a flat copy): confirmed via the merge commit's
  two-parent shape and the imported branch's own commit graph.
- The original `agentic-command-center` repo was left untouched beyond the
  restructuring PR and its one follow-up fix — same branch, same repo,
  nothing force-pushed or rewritten.

## Explicitly out of scope for this pass

Same as the design doc: no root-tooling unification, no decision on the
original repo's long-term fate. Wiring `apps/agentic-command-center`'s CI at
the repo root and extracting Guards to `apps/toolbelt/guards` are the
immediately-following changes, tracked separately.
