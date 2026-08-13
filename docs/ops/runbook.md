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
