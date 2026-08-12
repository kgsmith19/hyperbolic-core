# Agentic Command Center migration into hyperbolic-core

Status: implemented.

## Background

This is the third and final component migration referenced by
`docs/superpowers/specs/2026-08-11-toolbelt-migration-design.md`'s
consolidation context: toolbelt → lifeos → agentic-command-center (ACC),
in that stated order, with ACC deliberately last because it's the
guard-rail/vault system and the subtree/CI-reconciliation pattern needed to
be proven on lower-stakes repos first. Both prior migrations are complete
(`apps/toolbelt/`, `apps/lifeos/`); this spec covers ACC.

The same consolidation decisions from the toolbelt design doc apply here
unchanged: layout under `apps/<name>/`, full history via `git subtree add`
(no squash), no root-tooling unification, and the original `agentic-command-
center` repo is left exactly as-is on GitHub — not archived, not deleted,
no decision made about its long-term fate.

ACC's own restructuring (GUI/UI consolidation, CI portability fixes, legacy
doc purge — see `agentic-command-center#84`) was done in the standalone repo
*before* this migration, so the subtree source is already clean.

## Merge mechanics

```bash
git subtree add --prefix=apps/agentic-command-center \
  https://github.com/kgsmith19/agentic-command-center \
  claude/agentic-engineering-restructure-bujav1 \
  -m "Merge agentic-command-center into apps/agentic-command-center via git subtree"
```

Pulled from the restructuring branch's tip (`f7018c9`, plus a same-branch
follow-up fix `b780476`) rather than `main`, since that branch is where the
pre-migration cleanup landed and `main` had not yet merged it at migration
time. Brings in ACC's full history under `apps/agentic-command-center/`,
unchanged: `AGENTS.md`, `CLAUDE.md`, `README.md`, `TEMPLATES/`,
`TEST_LEDGER.md`, `project.yaml`, `standard.lock`, `config.json`,
`policy.json`, `docs/`, `forgepad/`, `gui/`, `hooks/`, `kernel/`, `runner/`,
`shim/`, `ui/`, `watcher/`.

One file was missed in ACC's own ADR purge (`templates/ADR.md`, the last
survivor of ACC's pre-restructuring `templates/` dir) — removed in a
follow-up commit both in the standalone repo and here, post-merge.

## CI reconciliation

Unlike toolbelt (one `pr-gate` job) or lifeos (kept fully inert), ACC's
`.github/workflows/ci.yml` has three real jobs (`portable`,
`windows-integration`, `ui`) plus a `pr-gate` aggregator. Per this repo's own
safety invariant, `apps/agentic-command-center/.github/workflows/ci.yml` is
automatically inert the moment the subtree lands — GitHub never reads nested
workflow files. A relocated, path-scoped `acc-ci.yml` at the repo root
(mirroring `toolbelt-ci.yml`'s pattern) is the follow-up that makes it live;
tracked as the next piece of work (extracting Guards to `apps/toolbelt/guards`
touches the same workflow, so both land together).

`apps/agentic-command-center/.github/ISSUE_TEMPLATE/` and
`PULL_REQUEST_TEMPLATE.md` are, like toolbelt's, left in place as-is —
functionally inert once nested (GitHub only honors root `.github/`
templates) — same accepted, documented limitation as toolbelt's migration.

## Explicitly out of scope for this pass

- Not touching the original `agentic-command-center` repo beyond the
  pre-migration restructuring PR and its one follow-up fix commit.
- Not unifying root tooling.
- Not deciding the original repo's long-term fate.
- Wiring the root CI workflow and extracting Guards to `apps/toolbelt/guards`
  are separate, immediately-following changes, not part of the merge itself.
