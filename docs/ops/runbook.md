---
title: Platform Operations Runbook
status: active
owner: Kyle
updated: 2026-10-29
---

# Platform Operations Runbook

> [!IMPORTANT]
> **The platform is local-only (owner decision, 2026-10-29).** Supabase, Tailscale and Hetzner (the
> VPS, the Storage Box and the Cloudflare edge) are superseded. Every cloud deploy, backup, restore
> drill, canary and smoke workflow was removed by #503, along with the scripts and tests that served
> them. Every sub-app moves to SQLite on localhost or Docker. The local operations take this
> runbook's place as they land:
>
> - root `compose.yaml` plus `make up`, `make test`, `make backup` and `make restore-drill`, with a
>   local release (`make release NAME=vN`: canary, deploy, health, invariant and telemetry gates,
>   automatic rollback, a signed attestation and the tag; `make verify NAME=vN` re-checks it) and
>   `make rollback`: landed by #504, proven at every PR head that touches the stack by the PR Gate Platform lane
>   (`.github/actions/verify-local-stack`);
> - per-app SQLite migrations: the std queue, Phase 2.
>
> Whatever the VPS last ran keeps running untouched; nothing in this repository deploys to it any more.

## Local first-use path

From a clean clone, run:

```sh
npm ci
make up
make readiness
make telemetry
make test
```

`make readiness` writes `var/local-readiness.md`. It lists every declared app and service,
the local URL or next command, the observed Compose state where one exists, and the smallest
next action. It deliberately reports separate or cloud-dependent components as such instead of
pretending they started. It is read-only and never reads credentials.

Use `make down` to stop the root stack. `make backup` then `make restore-drill` verifies local
state before a release experiment.

CI has no cloud dependency for review any more. The AI Review lane, its dialogue, recheck and
dev-agent workflows, and the two GitHub App identities they posted as (the reviewer App and
`hyperbolic-core-dev`) were removed by owner decision on 2026-11-04 (#547). Independent review
and agent work move to `kgsmith19/hyper-agents`. The Infisical identities `review-gate` and
`dev-agent` and the repository variables `INFISICAL_REVIEW_IDENTITY_ID`,
`INFISICAL_DEV_IDENTITY_ID`, `REVIEW_PROVIDER`, `REVIEW_MODEL`, `DEV_PROVIDER` and `DEV_MODEL`
are no longer read by any workflow here; retire them when hyper-agents takes over.
