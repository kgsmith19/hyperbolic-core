# lifeos Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the standalone `lifeos` repository into `hyperbolic-core` at `apps/lifeos/`, preserving its full git history, without activating any of its production-facing CI (deploy/backup/ops/release-smoke stay on the standalone repo).

**Architecture:** A `git subtree add` merges lifeos's entire history into `apps/lifeos/` as a subdirectory — same mechanism as the toolbelt migration. Unlike toolbelt, there is no CI-relocation task: lifeos's four workflow files land under `apps/lifeos/.github/workflows/` and are deliberately left there, inert (GitHub only executes workflows from a repo's root `.github/workflows/`), because they contain real production deploy/backup/ops automation that must keep running from the standalone repo.

**Tech Stack:** git (subtree), Python 3.12+/FastAPI (backend), React/TypeScript/Vite (frontend), ruff, mypy, vitest, Playwright.

## Global Constraints

(From `docs/archived/2026-08-11/lifeos-migration-design-spec.md` and the toolbelt spec's still-applicable consolidation context)

- History must be preserved via `git subtree add --prefix=apps/lifeos <remote> main` — no squash, no flat copy.
- The original `lifeos` repo and its GitHub remote (`https://github.com/kgsmith19/lifeos.git`) must not be modified.
- No root-level tooling unification.
- **None of the 4 workflow files (`ci.yml`, `backup.yml`, `ops.yml`, `release-smoke.yml`) may be relocated to `hyperbolic-core`'s root `.github/workflows/`, and no repo variables/secrets/OIDC trust may be migrated.** They stay exactly where the subtree merge puts them, inert.
- Backend `pytest` must NOT be run in this environment — there is no isolated test database available, and `backend/tests/conftest.py` wipes whatever database it's pointed at. Verification is limited to install + `ruff check .` + `mypy`.
- Frontend tests that touch environment config must use the same dummy values `ci.yml` uses (`VITE_SUPABASE_URL=https://test.supabase.co`, `VITE_SUPABASE_PUBLISHABLE_KEY=test-public-anon-key`, `VITE_API_URL=https://api.test.invalid`) so nothing attempts a real network call.

---

## File Structure

- **Create (via `git subtree add`, not manual authoring):** `apps/lifeos/**` — lifeos's entire tree (`AGENTS.md`, `CLAUDE.md`, `README.md`, `.agent/`, `backend/`, `frontend/`), with full commit history.
- **Modify:** `README.md` (repo root) — add an `apps/lifeos/` entry to the existing "Components" section.

---

### Task 1: Subtree-merge lifeos into `apps/lifeos/`, record provenance in the root README

**Files:**
- Create (via git, not a text edit): `apps/lifeos/**`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `apps/lifeos/` directory tree on `main`, containing lifeos's full history, for Task 2 to verify.

- [ ] **Step 1: Confirm the working tree is clean before merging**

Run: `git status --short`
Expected: no output (clean working tree). If anything is listed, stop.

- [ ] **Step 2: Add a temporary remote for lifeos**

Run: `git remote add lifeos-origin https://github.com/kgsmith19/lifeos.git`

- [ ] **Step 3: Fetch lifeos's history**

Run: `git fetch lifeos-origin`
Expected: fetch completes and reports received objects.

- [ ] **Step 4: Run the subtree merge**

Run: `git subtree add --prefix=apps/lifeos lifeos-origin main -m "Merge lifeos into apps/lifeos via git subtree"`
Expected: output ending in `Added dir 'apps/lifeos'`. This command creates its own commit automatically — do not run a separate `git commit` for the merge itself.

- [ ] **Step 5: Remove the temporary remote**

Run: `git remote remove lifeos-origin`

- [ ] **Step 6: Verify the file tree landed correctly**

Run: `ls apps/lifeos`
Expected: `AGENTS.md`, `CLAUDE.md`, `README.md`, `backend`, `frontend` (plus hidden `.agent`, `.github`, `.gitignore`).

- [ ] **Step 7: Verify history was preserved**

Run: `git log --oneline $(git rev-parse HEAD^2) | wc -l`
(The second parent of the merge commit is the tip of lifeos's imported history — `HEAD^2` right after Step 4.)
Expected: a count well above 1, confirming real history, not a flat import. Note: `git log --oneline -- apps/lifeos | wc -l` will NOT show this (it only shows 1-2, a known quirk of path-scoped log across a subtree merge boundary, per the finding recorded during the toolbelt migration's final review) — use the `HEAD^2` form above instead.

- [ ] **Step 8: Confirm no CI workflow files were relocated**

Run: `ls .github/workflows/`
Expected: only the two files from the toolbelt migration (`toolbelt-ci.yml`, `toolbelt-network-checker-release.yml`) — nothing lifeos-related. `apps/lifeos/.github/workflows/*.yml` should still be present but untouched at that nested path (verify with `ls apps/lifeos/.github/workflows/`, expect `backup.yml`, `ci.yml`, `ops.yml`, `release-smoke.yml`).

- [ ] **Step 9: Add lifeos to the root README's Components section**

Current `README.md`:
```markdown
# hyperbolic-core
A suite of all of my agentic work.

## Components

- `apps/toolbelt/` — a monorepo of small portfolio tools (a prompt-library
  client and a local-first network diagnostic CLI/dashboard). Imported via
  `git subtree add --prefix=apps/toolbelt` from
  `https://github.com/kgsmith19/toolbelt.git` (merge commit `8af33c8`). See
  `apps/toolbelt/README.md` and `apps/toolbelt/AGENTS.md` for details.
```

First, get the merge commit's short SHA from Step 4: run `git rev-parse --short HEAD`. Then append this entry after the existing `apps/toolbelt/` bullet, substituting that SHA for `<MERGE_SHA>`:

```markdown

- `apps/lifeos/` — a personal life-management system (FastAPI backend +
  React/TypeScript frontend: calendar, bills, health tracking). Imported via
  `git subtree add --prefix=apps/lifeos` from
  `https://github.com/kgsmith19/lifeos.git` (merge commit `<MERGE_SHA>`).
  **Its CI (`apps/lifeos/.github/workflows/`: `ci.yml`, `backup.yml`,
  `ops.yml`, `release-smoke.yml`) is intentionally inert here** — those
  workflows include real production deploy/backup/ops automation and
  continue running from the standalone `lifeos` repo, not from this one.
  See `apps/lifeos/README.md` and `apps/lifeos/AGENTS.md` for details.
```

- [ ] **Step 10: Stage and commit the README update**

```bash
git add README.md
git commit -m "Record lifeos migration provenance in root README"
```

---

### Task 2: Verify the migrated lifeos code, without touching any database

**Files:** none (verification only), except a possible fix if something is actually broken.

**Interfaces:**
- Consumes: `apps/lifeos/` tree from Task 1.
- Produces: confirmation that the subtree merge didn't break path resolution for either application. This is the plan's final task.

- [ ] **Step 1: Backend — install and static-check only, no test execution**

Run from `apps/lifeos/backend/`:
```bash
python -m pip install -e .[dev]
ruff check .
mypy
```
Expected: install succeeds, `ruff check .` and `mypy` both report no errors (or only pre-existing issues unrelated to the move — compare against what the standalone repo's own CI reports if anything looks new and path-related). Do NOT run `pytest` — there is no isolated test database available in this environment, and the suite wipes whatever database it connects to. This is a deliberate scope boundary, not an oversight.

- [ ] **Step 2: Frontend — install, lint, type-check, unit test, build**

Run from `apps/lifeos/frontend/`:
```bash
npm ci
VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=test-public-anon-key VITE_API_URL=https://api.test.invalid npm run lint
npx tsc -b
VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=test-public-anon-key VITE_API_URL=https://api.test.invalid npm run test
npm run build
```
Expected: all four commands succeed with no path-resolution errors. `npm run test` (vitest) intercepts external requests per `frontend/AGENTS.md`, so the dummy env values only need to let the Supabase client initialize, not reach a real backend.

- [ ] **Step 3: Frontend — browser tests, if practical in this environment**

Run from `apps/lifeos/frontend/`:
```bash
VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=test-public-anon-key VITE_API_URL=https://api.test.invalid npx playwright install --with-deps chromium
VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=test-public-anon-key VITE_API_URL=https://api.test.invalid npm run e2e
```
Expected: passes, matching what `ci.yml`'s frontend job already verifies. If Playwright/Chromium cannot install or run in this environment (sandboxing, missing system deps), report that specifically as DONE_WITH_CONCERNS rather than silently skipping — the standalone repo's CI already covers this suite either way, so it's not a blocker for this task, just something to report accurately.

- [ ] **Step 4: Confirm the original lifeos repo was untouched**

Run: `cd /c/code/lifeos && git status --short && git log --oneline -1 && git remote -v && cd -`
Expected: clean working tree, `HEAD` unchanged from before this plan started, only `origin` remote present — confirms the standalone repo was never modified, only read from via the temporary remote.
