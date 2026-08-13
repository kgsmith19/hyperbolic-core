---
title: Platform Operations Runbook
status: active
scope: repo
created: 2026-08-13
updated: 2026-08-13
owner: Kyle
---

# Platform Operations Runbook

This is the cumulative operator runbook `docs/planning/10-cicd-deployment.md`
section 9 refers to ("Runbook: rotation rows, rollback procedures, serve
routes | add rows | Ops documentation") and `04-adrs.md` ADR-05 refers to
("the runbook gains a per-secret rotation row"). It did not exist on disk
before this issue; this file's first section is the one this issue
(`docs/planning/issues/m2-04-feat-shell-serve-routes.md`) owns. Later
issues add their own sections here (ADR-05 secret-rotation rows,
`10-cicd-deployment.md` section 8's per-unit rollback procedures) rather
than starting a second runbook file, matching the "add rows" language in
the source table.

Placement note: `apps/toolbelt/docs/notes/` holds toolbelt-scoped operator
notes (see `2026-08-12-platform-idp-owner-setup.md`, the m1-07 precedent
this file's structure and honesty section follow). This runbook is not
toolbelt-scoped -- it documents the VPS origin shared by the Shell, LifeOS,
and (later) the Brain -- so it lives at the repo root under `docs/ops/`
instead of inside any one app's tree.

## Tailscale serve routes (m2-04)

**Context.** ADR-02 (multi-zone routing behind one origin) and ADR-07
(`tailscale serve` as the zero-new-units gateway) require path routing on
the VPS's existing `tailscaled`. `docs/planning/10-cicd-deployment.md`
section 4 is the source-of-truth route table; this section operationalizes
it. ADR-07 is explicit that serve enforces network-level access only --
**zero app auth at the edge**; that stays server-side per ADR-03. Nothing
below adds, checks, or forwards a credential of any kind.

### Route table

| Route | Upstream | Kind | Status |
| --- | --- | --- | --- |
| `/` | `/home/deploy/shell/current` | static directory | active |
| `/life/*` | `/home/deploy/lifeos-ui/dist` | static directory | active |
| `/life/api/*` | `http://127.0.0.1:8000` | reverse proxy (loopback) | active |
| `/brain/stream` | *(none)* | reserved | **not configured** -- m4-21 has not built the Brain daemon yet. The path is reserved here in prose only; do not point it at a placeholder. Add a fourth row to `docs/ops/tailscale-serve-apply.sh`'s `ROUTES` array (target `http://127.0.0.1:8100`, matching `10-cicd-deployment.md` section 2.3's Brain healthcheck port) once m4-21 lands a real upstream. |

### Applying the route table

The route table is applied by `docs/ops/tailscale-serve-apply.sh`, run by
an operator on the VPS (the same account that already manages the
`lifeos` tailscale serve config today):

```bash
# Preview the plan (default; makes no changes):
docs/ops/tailscale-serve-apply.sh

# Apply for real (requires the tailscale CLI and an authenticated tailscaled):
docs/ops/tailscale-serve-apply.sh --apply
```

The script is idempotent: re-running `--apply` with an unchanged route
table converges to the same `tailscale serve` config rather than
duplicating entries (documented Tailscale behavior for repeated identical
`--set-path` commands), so it is safe to re-run after any operator error or
as a periodic drift check.

### Verification (the issue's own Verification section)

From a tailnet device, after `--apply` has actually run on the VPS:

```bash
# Root: the Shell bundle, 200 with the built asset hash present in index.html
curl -s -o /dev/null -w '%{http_code}' https://<origin>/

# LifeOS zone: 200
curl -s -o /dev/null -w '%{http_code}' https://<origin>/life/

# Shell health route: 200 (see apps/shell/public/healthz and
# apps/shell/test/healthz-check.mjs for what makes this a real static
# asset, not a client-side-only route that a bare curl can't reach)
curl -s -o /dev/null -w '%{http_code}' https://<origin>/healthz

# Confirm the origin is the ONLY thing tailscaled is fronting, and that no
# app process itself has bound a non-loopback port (ADR-06: internal-only
# means loopback-only)
tailscale serve status
ssh deploy@host ss -tlnp
```

The last two commands are how an operator confirms "No service beyond the
origin shall listen on a non-loopback interface" (this issue's acceptance
criteria) -- `ss -tlnp` should show only `tailscaled` itself bound to a
non-loopback address; the Shell has no server process at all (static
files), and the LifeOS API (`127.0.0.1:8000`) must appear loopback-only.

### Rolling back a single route

```bash
tailscale serve --bg --https=443 --set-path=/life/api/ off
```

then re-run `docs/ops/tailscale-serve-apply.sh --apply` once the upstream
is fixed. `tailscale serve reset` clears the entire config (all routes,
not just one) -- prefer the targeted `off` form above unless a full
rebuild from the route table is actually intended.

### Why the live-tailnet verification steps above were not run for this issue

This session has no real tailnet, no `tailscaled`, and no VPS -- the same
category of limitation `apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md`
(m1-07) documented for its own operator-only steps. What was verified from
inside this repo instead, and is real, automated, red/green-checked proof
(not a stand-in for the live checks above):

- `docs/ops/tailscale-serve-apply.sh --dry-run` emits exactly the three
  active routes above as syntactically valid `tailscale serve`
  invocations, deterministically, and without needing the `tailscale` CLI
  on `PATH` at all -- `docs/ops/tailscale-serve-apply.test.mjs`
  (`node --test docs/ops/tailscale-serve-apply.test.mjs`).
- `--apply` genuinely attempts to exec `tailscale` (proven by making it
  fail loudly, not silently, when the CLI is absent) rather than being a
  dry-run in disguise.
- `apps/shell/dist/healthz` exists after a real production build and, when
  served by the same static-file server this app's own Playwright e2e
  suite uses (`vite preview`), answers `GET /healthz` with 200 and content
  distinguishable from the SPA's index.html fallback --
  `apps/shell/test/healthz-check.mjs` (`npm run healthz-check --workspace=apps/shell`,
  also wired into `Shell PR Gate`).

None of that is a substitute for actually running `--apply` against the
VPS and reading real `curl`/`ss -tlnp` output. That remains an open
operator task, flagged here rather than faked.

## Shell deploy pipeline and rollback (m2-07)

**Context.** `docs/planning/10-cicd-deployment.md` section 2.2 specifies
the Shell static unit's deploy pipeline; `.github/workflows/deploy.yml`
(new, this issue) implements it. This is a REAL, active root workflow --
see that file's own header comment for the safety framing required by
root `AGENTS.md`'s "Workflow safety invariant". This section is the
operator-facing counterpart: what repository configuration the pipeline
needs, what the DEPLOY_ENABLED gate does, and how to roll back.

### Required repository variables

None of these exist in this sandbox (no live GitHub repo settings to
read or set) -- listed here as the operator's setup checklist, derived
from what `deploy.yml` and `platform-migrations.yml` actually reference:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DEPLOY_ENABLED` | `build-shell`, `deploy-shell` | Must be the literal string `'true'` or neither job runs at all (see "The DEPLOY_ENABLED gate" below). |
| `DEPLOY_HOST` | `deploy-shell` | Tailnet hostname of the VPS; used for both `ssh`/`scp` and the post-deploy `https://$DEPLOY_HOST/healthz` curl. Same variable `apps/lifeos/.github/workflows/ci.yml` already uses (read-only reference; that file never executes here). |
| `INFISICAL_PROJECT_SLUG` | `deploy-shell`, `migrate-platform` (via `platform-migrations.yml`) | Already required today for `platform-migrations.yml`; shared across identities. |
| `INFISICAL_SHELL_DEPLOY_IDENTITY_ID` | `deploy-shell` | NEW. A machine identity distinct from `INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID` (ADR-05's one-identity-per-pipeline rule), scoped to `/platform/` for the tailnet OAuth client values. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_ACC_API`, `VITE_LIFEOS_API` | `build-shell` | Optional. Every one of these already has a correct production default baked into `apps/shell/src/lib/session.ts` / `units.ts` / `acc.ts` (see `apps/shell/.env.example`) -- set a repo variable only to override the default for a non-standard topology. Leaving them unset is the normal, correct production state, not a misconfiguration. |

### The DEPLOY_ENABLED gate

`build-shell` and `deploy-shell` each carry `vars.DEPLOY_ENABLED == 'true'`
directly on their own job-level `if:` (not inherited from one shared
upstream check) -- the exact expression
`apps/lifeos/.github/workflows/ci.yml` already uses on `deploy-backend`/
`deploy-frontend` (read as a reference pattern; that file is inert and
never executes from `apps/lifeos/.github/workflows/`, per that app's own
`AGENTS.md`). While `DEPLOY_ENABLED` is unset or anything other than the
literal string `true`, both jobs show as **skipped** in the Actions run
graph, not run-and-no-op -- no build artifact is produced, no SSH/SCP
connection to the deploy host is attempted, and no Infisical or Tailscale
credential is ever requested. `migrate-platform` is deliberately NOT
covered by this gate; `deploy.yml`'s own comment on that job explains why
(schema state is section 2.5's Unit 5, modeled as always-live, not gated
the way the four application units are).

### Deploy flow (section 2.2, as implemented)

1. `build-shell` produces `apps/shell/dist/` and uploads it as artifact
   `shell-dist-<sha>`.
2. `deploy-shell` downloads that artifact, joins the tailnet, and ships it
   to `deploy@$DEPLOY_HOST:shell-incoming` over `scp`.
3. On the host: `mv shell-incoming shell/dist-<sha>`, then
   `ln -sfn dist-<sha> shell/current` (the exact path
   `docs/ops/tailscale-serve-apply.sh`'s `/` route already points at --
   see that script's `ROUTES` array and the route table above).
4. `docs/ops/prune-dist-dirs.sh` (scp'd to the host as part of step 2)
   prunes `shell/dist-*` to the newest 3, always additionally protecting
   whatever `current` currently resolves to even if it falls outside that
   window (see that script's own header comment for the rollback-survival
   scenario this protects against, and `docs/ops/prune-dist-dirs.test.mjs`
   for the real red/green test proving it -- run with
   `node --test docs/ops/prune-dist-dirs.test.mjs`).
5. The runner (already tailnet-joined) curls `https://$DEPLOY_HOST/healthz`
   for a 200 and confirms the just-built JS asset filename (read from the
   downloaded artifact's `index.html`) appears in the live root response,
   satisfying SH-5's verification form:
   `curl -s -o /dev/null -w '%{http_code}' https://<origin>/healthz`.

### Rollback (section 8.2)

No rebuild, no network transfer -- repoint the symlink to a prior
`dist-<sha>` directory still on the host (protected from pruning by
construction as long as it was one of the 3 most recent deploys, or is
the current active target per the prune script's protection rule above):

```bash
ssh deploy@host 'ln -sfn dist-<prior-sha> shell/current'
curl -s -o /dev/null -w '%{http_code}' https://<origin>/healthz   # expect 200
curl -fsS https://<origin>/ | grep -o '/assets/[A-Za-z0-9_.-]*\.js'  # expect the prior build's asset hash
```

Target: under 5 minutes (the acceptance criteria's own bound), since this
is a single `ssh` round trip with no build, no `scp`, and no Infisical or
Tailscale re-auth beyond the SSH session itself.

### Why the live-deploy verification steps above were not run for this issue

Same category of limitation as the section above: this sandbox has no
real GitHub repository variables, no Infisical project, no tailnet, and
no VPS, so `deploy.yml` has never actually been dispatched and its
`build-shell`/`deploy-shell` jobs have never run for real. What WAS
verified from inside this repo, and is real:

- `.github/workflows/deploy.yml` passes `actionlint` v1.7.7 with its
  shellcheck integration active (`apt-get install shellcheck`, confirmed
  working via a deliberately broken copy of the file that actionlint did
  flag, before linting the real file clean) -- real GitHub Actions schema
  and expression-type validation, not just YAML parsing.
- Every SHA-pinned action `deploy.yml` references was confirmed to
  resolve to a real commit via `git fetch <repo> <sha>` against the
  actual upstream repository (not just `git ls-remote`, which only lists
  refs): `actions/checkout`, `actions/setup-node`,
  `actions/upload-artifact`, `actions/download-artifact`,
  `dorny/paths-filter`, `Infisical/secrets-action`,
  `tailscale/github-action`.
- `build-shell`'s actual steps were run for real, locally, against this
  checkout: `npm ci`, `npm run build --workspace=packages/ui`,
  `npm run build --workspace=apps/shell` (real production build,
  producing real hashed asset filenames like
  `dist/assets/index-DnWGEIdf.js`), and
  `npm run healthz-check --workspace=apps/shell`, all passing. The
  `deploy-shell` health-check step's asset-hash regex was validated
  against that real `dist/index.html`, not assumed.
- `docs/ops/prune-dist-dirs.sh`'s branching logic (newest-N selection,
  the rollback-survival protection for `current`'s target, the
  boundary/off-by-one cases, and the missing-symlink/missing-directory
  cases) has a real `node --test` suite
  (`docs/ops/prune-dist-dirs.test.mjs`) that was run both green (against
  the real script) and, deliberately, red (against a one-line-changed
  copy that removed the rollback-protection branch, to prove the test
  actually catches that exact regression rather than trivially passing).

None of that is a substitute for actually dispatching `deploy.yml`
against a real deploy host and reading a real `200` from
`https://<origin>/healthz`. That remains an open operator task, flagged
here rather than faked, exactly like the tailscale-serve-apply.sh section
above.
