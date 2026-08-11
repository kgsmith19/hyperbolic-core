# Toolbelt migration into hyperbolic-core

Status: approved design, not yet implemented.

## Background

`hyperbolic-core` is intended to be the consolidated home for this user's
agentic-work repos, currently spread across three independent, actively
developed repositories:

- `toolbelt` — portfolio-tool monorepo (Node/Python, no root package manager)
- `lifeos` — mixed Python backend + JS frontend app
- `agentic-command-center` (ACC) — the local coding-agent guard-rail/vault
  system this user's global CLAUDE.md refers to as "guards"

This is three independent subsystem migrations, not one task. Each gets its
own spec → plan → implementation cycle. This document covers the first:
**toolbelt**.

## Consolidation context (applies across all three migrations)

These decisions were made once and apply to every component's migration, so
later specs (lifeos, ACC) can reference this section instead of re-deciding:

- **Layout**: each component lands under `apps/<name>/` in `hyperbolic-core`
  (e.g. `apps/toolbelt/`, `apps/lifeos/`, `apps/agentic-command-center/`).
- **History**: preserved via `git subtree add --prefix=apps/<name> <remote>
  main`, not a flat copy. Full commit history for each component remains
  intact and inspectable via `git log` scoped to its subdirectory.
- **Tooling**: components stay independent — each keeps its own
  package manager files, its own test commands, its own CI workflow. No
  root-level workspace/build unification in this pass.
- **Order**: toolbelt → lifeos → agentic-command-center. ACC is last and
  gets extra scrutiny because it's the guard-rail/vault system, and the
  monorepo pattern (subtree mechanics, CI reconciliation) should be proven
  on lower-stakes repos first.
- **Original repos**: left exactly as-is on GitHub for now (not archived,
  not deleted). No decision has been made about their long-term fate.

## This spec: migrate `toolbelt`

### 1. Merge mechanics

In `hyperbolic-core`:

```bash
git remote add toolbelt-origin https://github.com/kgsmith19/toolbelt.git
git fetch toolbelt-origin
git subtree add --prefix=apps/toolbelt toolbelt-origin main
git remote remove toolbelt-origin
```

This brings in the full `toolbelt` history under `apps/toolbelt/`, unchanged:
`AGENTS.md`, `CLAUDE.md`, `README.md`, `config.mjs`, `.agent/`,
`apps/prompt-organizer/`, `apps/network-checker/`, `docs/`, `specs/`,
`supabase/`, `tests/`, `web/`. None of toolbelt's internal docs or command
references need path rewrites — they're already relative to toolbelt's own
root, which is preserved as `apps/toolbelt/`.

### 2. CI reconciliation

GitHub Actions only reads workflows from a repo's root `.github/workflows/`,
so the two toolbelt workflow files must move there (they don't work left
inside `apps/toolbelt/.github/`):

- `apps/toolbelt/.github/workflows/ci.yml` →
  `hyperbolic-core/.github/workflows/toolbelt-ci.yml`
  - Prefix every `working-directory:` value with `apps/toolbelt/`.
  - Add `paths: ['apps/toolbelt/**']` to the `pull_request` trigger, so this
    workflow only runs on toolbelt changes (necessary once lifeos/ACC share
    the same repo and PR history).
- `apps/toolbelt/.github/workflows/network-checker-release.yml` →
  `hyperbolic-core/.github/workflows/toolbelt-network-checker-release.yml`
  - Prefix `working-directory:` and the `docker build` path with
    `apps/toolbelt/`.
  - No `paths` filter needed — it's `workflow_dispatch`-only, already gated
    by its `network-checker-v*` tag-name validation.
- The now-empty `apps/toolbelt/.github/workflows/` directory is removed
  after the files are moved.
- `apps/toolbelt/.github/ISSUE_TEMPLATE/work-item.md` and
  `PULL_REQUEST_TEMPLATE.md` are left in place as-is. Note: like workflows,
  GitHub only honors these from a repo's root `.github/`, so once nested
  under `apps/toolbelt/` they stop being functionally active (no more
  toolbelt-specific issue/PR template on hyperbolic-core). Reconciling that
  — e.g. promoting them to root or accepting the loss — is out of scope for
  this pass and left as a follow-up.

### 3. Verification

From the new location, confirm nothing broke in the move:

```bash
node --test "apps/toolbelt/tests/*.test.mjs"
cd apps/toolbelt/apps/prompt-organizer && node --test "tests/*.test.mjs"
cd apps/toolbelt/apps/network-checker && bash tools/check.sh
```

The two relocated CI workflow files are checked for valid YAML and correct
path prefixing, but can't be proven green until they actually run on GitHub
(first PR touching `apps/toolbelt/**`).

### 4. Explicitly out of scope for this pass

- Not touching the original `toolbelt` repo or its GitHub remote — it stays
  fully intact and independently usable.
- Not unifying root tooling (no npm workspaces, no shared root
  package.json/CI pipeline across components).
- Not migrating `lifeos` or `agentic-command-center` — separate specs.
- Not deciding the original repos' long-term fate (archive/delete) — noted
  above as an open decision for later.
