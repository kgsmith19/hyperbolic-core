# lifeos migration into hyperbolic-core

Status: approved design, not yet implemented.

Second of the three-part consolidation described in
`docs/archived/2026-08-11/toolbelt-migration-design-spec.md` (toolbelt,
already merged). That document's "Consolidation context" section (layout,
history strategy, tooling independence, migration order, original-repo
fate) applies unchanged here. This document covers what's specific to
`lifeos`.

## What's different about lifeos

Unlike toolbelt (a portfolio-tools monorepo with no production surface),
`lifeos` is a live personal system — calendar, bills, health data — with
real infrastructure behind it:

- `ci.yml` deploys to a production VPS over Tailscale SSH on every push to
  `main` (gated by a `DEPLOY_ENABLED` repo variable), and unconditionally
  builds+pushes a Docker image to `ghcr.io/<repo>` on every push to `main`
  (no gate at all on that job).
- `backup.yml` runs a nightly cron job that dumps the production database
  and blob volume, encrypts it, and uploads it as a build artifact.
- `ops.yml` is a manually-triggered workflow with SSH access to production
  for running one-off migrations and installing/running a cron job on the
  VPS.
- `release-smoke.yml` runs a weekly cron job that logs into the real
  deployed app with real credentials (`SMOKE_EMAIL`/`SMOKE_PASSWORD`
  secrets) as a canary check.

**Decision (confirmed with the user):** migrate the code, leave the
operational CI surface exactly where it is. Do not relocate any of these
four workflow files to `hyperbolic-core`'s root `.github/workflows/`. They
land under `apps/lifeos/.github/workflows/` via the subtree merge like
everything else, but are left there — GitHub does not execute workflows
from a nested path, so they become inert at the new location while
continuing to run unaffected from the standalone `lifeos` repo (which,
per the toolbelt spec's "original repos" decision, is untouched by this
migration regardless). This is the opposite of toolbelt's Task 2: there
*is* no CI-relocation task for lifeos, by design, not by oversight.

This also means there's no `.agent/project.yaml` CI-facts reconciliation
task like toolbelt needed — nothing about the CI's location changes (it's
still at the same path relative to `apps/lifeos/`, just no longer
functionally reachable by GitHub from there), so no path or name becomes
factually wrong the way toolbelt's did.

## Migration steps

### 1. Merge mechanics

Same as toolbelt: temporary remote to `https://github.com/kgsmith19/lifeos.git`,
`git subtree add --prefix=apps/lifeos <remote> main`, remove the temporary
remote. Brings in `lifeos`'s full history (source, docs, both apps) intact
under `apps/lifeos/`, workflow files included but inert as described above.

### 2. Root README update

Add `apps/lifeos/` to the "Components" section added during the toolbelt
migration, with provenance (source URL, merge commit) and an explicit note
that its CI/deploy/backup/ops workflows remain on the standalone `lifeos`
repo and are not active from this location — so a future reader isn't
surprised that `apps/lifeos/.github/workflows/*.yml` exist but never run.

### 3. Verification

No Docker and no isolated test database are available in this environment,
and `backend/tests/conftest.py` explicitly wipes whatever database it's
pointed at (with a hard-coded refusal to run against the production
project ref) — running `pytest` here without a safe, isolated
`TEST_DATABASE_URL` is not an acceptable risk, and none is configured.
Verification is therefore scoped to what's safe to run without a database:

Backend (from `apps/lifeos/backend/`):
```bash
python -m pip install -e .[dev]
ruff check .
mypy
```
This proves the package installs and imports resolve correctly from the
new nested location — the actual test suite continues being exercised
safely by the standalone repo's CI, which is untouched.

Frontend (from `apps/lifeos/frontend/`), using the same dummy,
non-production env values `ci.yml` uses so nothing attempts a real network
call:
```bash
VITE_SUPABASE_URL=https://test.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=test-public-anon-key \
VITE_API_URL=https://api.test.invalid \
npm ci && npm run lint && npx tsc -b && npm run test && npm run build
```
Browser (Playwright) tests are included if they run cleanly in this
environment; if browser install/execution proves impractical here, that's
noted rather than silently skipped — CI on the standalone repo already
covers this suite.

Finally, confirm the original `lifeos` repo (`C:\code\lifeos`) is
unmodified — same check as toolbelt's Task 3 Step 4.

## Explicitly out of scope for this pass

- Relocating or activating any of lifeos's 4 workflow files.
- Migrating repo variables, secrets, or the Infisical OIDC trust
  relationship to `hyperbolic-core`.
- Running the backend pytest suite (no safe isolated database available
  here; unaffected — it keeps running via the standalone repo's CI).
- Everything already out of scope per the toolbelt spec's consolidation
  context (root tooling unification, touching the original repo, deciding
  the original repo's long-term fate).
