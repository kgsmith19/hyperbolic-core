#!/usr/bin/env bash
# Idempotent operator step applying the one-origin `tailscale serve` route
# table (docs/planning/10-cicd-deployment.md section 4; ADR-07 in
# docs/planning/04-adrs.md; docs/planning/issues/m2-04-feat-shell-serve-routes.md).
#
# This is deliberately a plain script run by a human operator on the VPS,
# not a GitHub Actions workflow: m2-04's own scope excludes deploy
# automation ("that's m2-07"), and 10-cicd-deployment.md section 4 itself
# says the config is "applied by an idempotent operator step (the
# ops-workflow pattern, one dispatchable task), not hand-typed on the box" --
# a single script satisfies that without building the dispatchable-task
# wiring m2-07 owns.
#
# ROUTE TABLE (docs/planning/10-cicd-deployment.md section 4, verbatim):
#   /            -> Shell dist at /home/deploy/shell/current   (static)
#   /life/       -> LifeOS frontend dist                       (static)
#   /life/api/   -> http://127.0.0.1:8000                      (proxy, loopback)
#   /brain/stream -> RESERVED, no target configured (m4-21 has not built the
#                    Brain daemon yet; this script intentionally does not
#                    run any `tailscale serve` command for this path -- see
#                    "Why /brain/stream is absent below" further down)
#
# ADR-07 is explicit that serve enforces network-level access only and does
# ZERO app auth (that stays server-side, ADR-03) -- this script never adds
# an auth header, credential, or gating flag of any kind. It only maps
# paths to upstreams.
#
# COMMAND SYNTAX: sourced from Tailscale's own docs (tailscale.com/kb/1242
# and the `tailscale serve` CLI reference), specifically the `--set-path`
# mount-point form, which supports both a local directory (rendered/served
# as static files) and an http:// target (reverse-proxied). Re-running the
# identical `tailscale serve --set-path=X Y` command is documented as
# idempotent: it converges to the same config rather than duplicating an
# entry, which is what "idempotent operator step" in the acceptance
# criteria requires and what this script relies on for --apply to be safe
# to re-run.
#
# HONEST LIMITATION (matching the m1-07 runbook's own precedent for
# operator-only steps this sandbox cannot perform): there is no real
# tailnet, no `tailscaled`, and no VPS reachable from this environment, so
# --apply has never been run for real here and cannot be. What IS verified,
# by this script's companion test (tailscale-serve-apply.test.mjs):
#   - every command this script would run is a syntactically valid
#     `tailscale serve` invocation (right subcommand, flags, and shape);
#   - running the --dry-run path twice produces byte-identical output
#     (proving the command set is a pure function of the route table, not
#     of any prior invocation -- the property idempotency depends on);
#   - --dry-run never shells out to a `tailscale` binary at all (proven by
#     clearing PATH and confirming it still succeeds), so operators can
#     safely preview this script's plan on a machine that doesn't even have
#     tailscale installed.
# None of that is a substitute for running this for real against the VPS
# and confirming with `tailscale serve status` and the curl checks in
# docs/ops/runbook.md -- that step is recorded there as an operator task,
# not faked here as a passing CI check.
#
# USAGE:
#   docs/ops/tailscale-serve-apply.sh              # dry run (default): print the plan
#   docs/ops/tailscale-serve-apply.sh --dry-run     # same, explicit
#   docs/ops/tailscale-serve-apply.sh --apply       # actually run each `tailscale serve` command
#
# Run on the VPS as the operator account that already manages the
# `lifeos` tailscale serve config (the same one section 4 says already
# terminates TLS for LifeOS today).

set -euo pipefail

# --https port is fixed at 443: ADR-07's whole premise is ONE origin
# terminating TLS on the tailnet's standard HTTPS port; a second port would
# be a second origin, contradicting ADR-02/ADR-07 outright.
HTTPS_PORT="${TAILSCALE_SERVE_HTTPS_PORT:-443}"

# Each entry: "<mount path>|<local dir or http:// upstream>". Order matches
# the table above and 10-cicd-deployment.md section 4's row order.
ROUTES=(
  "/|/home/deploy/shell/current"
  "/life/|/home/deploy/lifeos-ui/dist"
  "/life/api/|http://127.0.0.1:8000"
)

# Why /brain/stream is absent above: the issue scope is explicit --
# "reserve the path, do not implement a target" -- because m4-21 (the Brain
# daemon) has not been built. There is no upstream to point `tailscale
# serve` at yet; adding a route with a fake or placeholder target would be
# worse than no route (a 502/timeout dressed up as configured
# infrastructure). The path is reserved in prose only, in
# docs/ops/runbook.md's route table, until m4-21 lands a real
# 127.0.0.1:8100 upstream (docs/planning/10-cicd-deployment.md section 2.3)
# for this script to add as a fourth ROUTES entry.

mode="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply) mode="apply" ;;
    --dry-run) mode="dry-run" ;;
    -h | --help)
      sed -n '1,60p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "usage: $0 [--apply|--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "apply" ] && ! command -v tailscale >/dev/null 2>&1; then
  echo "error: --apply requires the 'tailscale' CLI on PATH; none found." >&2
  exit 1
fi

for route in "${ROUTES[@]}"; do
  mount_path="${route%%|*}"
  target="${route#*|}"
  cmd=(tailscale serve --bg --https="${HTTPS_PORT}" --set-path="${mount_path}" "${target}")

  if [ "$mode" = "apply" ]; then
    echo "+ ${cmd[*]}"
    "${cmd[@]}"
  else
    echo "${cmd[*]}"
  fi
done

if [ "$mode" = "apply" ]; then
  echo "--- applied. Verify with: tailscale serve status"
fi
