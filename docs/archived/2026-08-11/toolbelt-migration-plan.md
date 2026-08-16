# Toolbelt Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the standalone `toolbelt` repository into `hyperbolic-core` at `apps/toolbelt/`, preserving its full git history, without breaking its CI or test suites.

**Architecture:** A `git subtree add` merges toolbelt's entire history into `apps/toolbelt/` as a subdirectory. Because GitHub Actions only reads workflow files from a repo's root `.github/workflows/`, toolbelt's two workflow files are relocated there and every path they reference gets an `apps/toolbelt/` prefix. Everything else in toolbelt (its own `AGENTS.md`, `.agent/project.yaml`, docs, app code) needs no changes, since those already refer to paths relative to toolbelt's own root, which is preserved intact.

**Tech Stack:** git (subtree), GitHub Actions (YAML), Node.js test runner (`node --test`), Python 3 (network-checker's `tools/check.sh`).

## Global Constraints

(From `docs/archived/2026-08-11/toolbelt-migration-design-spec.md`)

- History must be preserved via `git subtree add --prefix=apps/toolbelt <remote> main` — no squash, no flat copy.
- The original `toolbelt` repo and its GitHub remote (`https://github.com/kgsmith19/toolbelt.git`) must not be modified.
- No root-level tooling unification (no npm workspaces, no shared root CI/build config) — toolbelt stays self-contained under `apps/toolbelt/`.
- CI workflow files must end up at `hyperbolic-core`'s root `.github/workflows/`, prefixed `toolbelt-*`, with every internal path updated to account for the new `apps/toolbelt/` prefix.
- `toolbelt-ci.yml`'s `pull_request` trigger must be scoped with `paths: ['apps/toolbelt/**']` so it doesn't fire on unrelated changes once other components are migrated later.

---

## File Structure

- **Create (via `git subtree add`, not manual authoring):** `apps/toolbelt/**` — toolbelt's entire tree (`AGENTS.md`, `CLAUDE.md`, `README.md`, `config.mjs`, `.agent/`, `.github/` templates, `apps/prompt-organizer/`, `apps/network-checker/`, `docs/`, `specs/`, `supabase/`, `tests/`, `web/`), with full commit history.
- **Create:** `.github/workflows/toolbelt-ci.yml` — relocated, path-prefixed copy of toolbelt's PR Gate.
- **Create:** `.github/workflows/toolbelt-network-checker-release.yml` — relocated, path-prefixed copy of toolbelt's release workflow.
- **Delete:** `apps/toolbelt/.github/workflows/ci.yml` (superseded by the file above).
- **Delete:** `apps/toolbelt/.github/workflows/network-checker-release.yml` (superseded by the file above).

---

### Task 1: Subtree-merge toolbelt into `apps/toolbelt/`

**Files:**
- Create (via git, not a text edit): `apps/toolbelt/**`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `apps/toolbelt/` directory tree on the `main` branch of `hyperbolic-core`, containing toolbelt's full history, for Task 2 and Task 3 to build on.

- [ ] **Step 1: Confirm the working tree is clean before merging**

Run: `git status --short`
Expected: no output (clean working tree). If anything is listed, stop — do not proceed with uncommitted changes present.

- [ ] **Step 2: Add a temporary remote for toolbelt**

Run: `git remote add toolbelt-origin https://github.com/kgsmith19/toolbelt.git`

- [ ] **Step 3: Fetch toolbelt's history**

Run: `git fetch toolbelt-origin`
Expected: fetch completes and reports received objects.

- [ ] **Step 4: Run the subtree merge**

Run: `git subtree add --prefix=apps/toolbelt toolbelt-origin main -m "Merge toolbelt into apps/toolbelt via git subtree"`
Expected: output ending in `Added dir 'apps/toolbelt'`. This command creates its own commit(s) automatically (a squashed split commit plus a merge commit) — this is the commit for this task. Do not run a separate `git commit` afterward.

- [ ] **Step 5: Remove the temporary remote**

Run: `git remote remove toolbelt-origin`

- [ ] **Step 6: Verify the file tree landed correctly**

Run: `ls apps/toolbelt`
Expected: `AGENTS.md`, `CLAUDE.md`, `README.md`, `config.mjs`, `apps`, `docs`, `specs`, `supabase`, `tests`, `web` (plus hidden `.agent`, `.github`, `.gitignore`).

- [ ] **Step 7: Verify history was preserved, not squashed into one commit**

Run: `git log --oneline -- apps/toolbelt | wc -l`
Expected: a count well above 1 (toolbelt has 251 commits reachable from its own `main` as of this plan's writing) — confirms real history came across rather than a flat single-commit import.

---

### Task 2: Relocate and reconcile the CI workflows

**Files:**
- Create: `.github/workflows/toolbelt-ci.yml`
- Create: `.github/workflows/toolbelt-network-checker-release.yml`
- Delete: `apps/toolbelt/.github/workflows/ci.yml`
- Delete: `apps/toolbelt/.github/workflows/network-checker-release.yml`

**Interfaces:**
- Consumes: `apps/toolbelt/` tree from Task 1.
- Produces: root-level workflow files. Nothing later in this plan depends on their exact content programmatically, but Task 3 assumes the old in-tree workflow files are gone (so there's no confusion about which copy is live).

- [ ] **Step 1: Create the root workflows directory if needed**

Run: `mkdir -p .github/workflows`

- [ ] **Step 2: Write `.github/workflows/toolbelt-ci.yml`**

```yaml
name: "Toolbelt PR Gate"

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths:
      - "apps/toolbelt/**"
  merge_group:

concurrency:
  group: toolbelt-pr-gate-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  pr-gate:
    name: Toolbelt PR Gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "22"
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.12"
      - name: Prepare Prompt Organizer test sessions
        run: node tests/export-test-sessions.mjs
        working-directory: apps/toolbelt/apps/prompt-organizer
      - name: Run Toolbelt tests
        run: node --test "tests/*.test.mjs"
        working-directory: apps/toolbelt
      - name: Run Prompt Organizer tests
        run: node --test "tests/*.test.mjs"
        working-directory: apps/toolbelt/apps/prompt-organizer
      - name: Install Prompt Organizer browser test
        run: |
          npm install --no-save --no-package-lock @playwright/test@1.52.0
          npx playwright install --with-deps chromium
        working-directory: apps/toolbelt/apps/prompt-organizer
      - name: Start Prompt Organizer
        run: python3 -m http.server 8812 --directory web >/tmp/prompt-organizer.log 2>&1 &
        working-directory: apps/toolbelt/apps/prompt-organizer
      - name: Wait for Prompt Organizer
        shell: bash
        run: |
          for attempt in $(seq 1 20); do
            if curl --fail --silent http://localhost:8812 >/dev/null; then
              exit 0
            fi
            sleep 1
          done
          cat /tmp/prompt-organizer.log
          echo "Prompt Organizer did not become ready." >&2
          exit 1
      - name: Run Prompt Organizer critical browser journey
        run: npx playwright test --config playwright.config.mjs
        working-directory: apps/toolbelt/apps/prompt-organizer
        env:
          PLAYWRIGHT_BASE_URL: http://localhost:8812
      - name: Upload Prompt Organizer browser evidence
        if: failure()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: prompt-organizer-e2e-evidence
          path: |
            apps/toolbelt/apps/prompt-organizer/playwright-report/
            apps/toolbelt/apps/prompt-organizer/test-results/
          if-no-files-found: ignore
          retention-days: 14
      - name: Run Network Checker tests and deterministic scanners
        run: bash tools/check.sh
        working-directory: apps/toolbelt/apps/network-checker
```

Note: the workflow `name:`, job `name:`, and `concurrency.group` were each prefixed with "Toolbelt" beyond what a literal find-replace would produce. This is a deliberate, in-spec-spirit addition (the design spec already renames the *file* to avoid collisions with future components) — without it, once `lifeos`/`agentic-command-center` land with their own "PR Gate" workflows, the GitHub Actions UI would show multiple identically-named, indistinguishable runs.

- [ ] **Step 3: Write `.github/workflows/toolbelt-network-checker-release.yml`**

```yaml
name: Toolbelt Network Checker Release

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/toolbelt/apps/network-checker
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.12"
      - name: Validate selected release tag
        shell: bash
        run: |
          [[ "$GITHUB_REF_NAME" =~ ^network-checker-v[0-9]+\.[0-9]+\.[0-9]+$ ]]
      - run: bash tools/check.sh

  build-and-verify-image:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Build and smoke-test image
        env:
          RELEASE_TAG: ${{ github.ref_name }}
        run: |
          version="${RELEASE_TAG#network-checker-}"
          docker build -t "netcheck:$version" apps/toolbelt/apps/network-checker
          docker run --rm "netcheck:$version" --version
          docker run --rm "netcheck:$version" scan
      - name: Save image
        env:
          RELEASE_TAG: ${{ github.ref_name }}
        run: |
          version="${RELEASE_TAG#network-checker-}"
          docker save "netcheck:$version" | gzip > netcheck-image.tar.gz
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: network-checker-image
          path: netcheck-image.tar.gz
          if-no-files-found: error
          retention-days: 14

  publish-draft:
    needs: build-and-verify-image
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: network-checker-image
      - name: Extract release notes
        env:
          RELEASE_TAG: ${{ github.ref_name }}
        run: |
          python3 - "${RELEASE_TAG#network-checker-v}" <<'PYEOF' > network-checker-release-notes.md
          import re
          import sys

          version = sys.argv[1]
          text = open("apps/toolbelt/apps/network-checker/CHANGELOG.md", encoding="utf-8").read()
          pattern = rf"## \[{re.escape(version)}\].*?\n(.*?)(?=\n## \[|\Z)"
          match = re.search(pattern, text, re.DOTALL)
          print(match.group(1).strip() if match else f"See CHANGELOG.md for {version}.")
          PYEOF
      - name: Create draft release
        uses: softprops/action-gh-release@fe965f7af51af5f2602596916f38a38df2e33de0 # v3.0.2
        with:
          name: Network Checker ${{ github.ref_name }}
          body_path: network-checker-release-notes.md
          files: netcheck-image.tar.gz
          draft: true
```

- [ ] **Step 4: Validate both new files are syntactically valid YAML**

Run: `npx --yes js-yaml .github/workflows/toolbelt-ci.yml >/dev/null && echo OK`
Expected: `OK`

Run: `npx --yes js-yaml .github/workflows/toolbelt-network-checker-release.yml >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 5: Remove the superseded in-tree workflow files**

Run: `git rm apps/toolbelt/.github/workflows/ci.yml apps/toolbelt/.github/workflows/network-checker-release.yml`
Expected: both files staged for deletion. If `apps/toolbelt/.github/workflows/` is now empty on disk, that's fine — git doesn't track empty directories, no further action needed.

- [ ] **Step 6: Stage and commit**

```bash
git add .github/workflows/toolbelt-ci.yml .github/workflows/toolbelt-network-checker-release.yml
git commit -m "Relocate toolbelt CI workflows to repo root and scope to apps/toolbelt"
```

---

### Task 3: Verify the relocated toolbelt runs correctly in its new home

**Files:** none (verification only).

**Interfaces:**
- Consumes: `apps/toolbelt/` tree (Task 1) and the reconciled workflows (Task 2).
- Produces: confirmation that the migration didn't break path resolution. This is the plan's final task.

- [ ] **Step 1: Run toolbelt's root test suite from the new location**

Run: `node --test "apps/toolbelt/tests/*.test.mjs"`
Expected: tests execute (no "module not found" / path-resolution errors). Per toolbelt's own `AGENTS.md`, this suite calls a live Supabase project — report any network/rate-limit failures accurately rather than treating them as a migration break; the thing this step is checking is that paths resolve, not that Supabase is reachable from this environment.

- [ ] **Step 2: Run Prompt Organizer's test suite from the new location**

Run:
```bash
cd apps/toolbelt/apps/prompt-organizer
node --test "tests/*.test.mjs"
cd -
```
Expected: same caveat as Step 1 — tests execute without path errors.

- [ ] **Step 3: Run Network Checker's deterministic checks from the new location**

Run:
```bash
cd apps/toolbelt/apps/network-checker
bash tools/check.sh
cd -
```
Expected: PASS. Unlike the two suites above, this one is local/deterministic (no external network dependency), so this should be a clean pass.

- [ ] **Step 4: Confirm the original toolbelt repo was untouched**

Run: `cd /c/code/toolbelt && git status --short && git log --oneline -1 && cd -`
Expected: clean working tree, `HEAD` still at the same commit it was before this plan started (`e25010a`) — confirms the standalone repo was never modified, only read from via the temporary remote.
