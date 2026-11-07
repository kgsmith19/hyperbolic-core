# Local activation evidence (#559, AC1 and AC2)

Recorded 2026-11-07 from a clean checkout of `main` at `4c34326`, in a sandbox
with Node 22, Python 3.12 and no Docker daemon. Nothing here reads a credential.

## Commands run

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 |
| `make test` | exit 0 (manifest-tools, hyp-cli, platform-api, ops unittest, docs/ops node tests: 0 failures) |
| `make readiness` | wrote `var/local-readiness.md` (one row per app and service) |

## Readiness state

Every compose service was reported as `prerequisite blocked` for one reason only:
the Docker daemon is not running in this sandbox. The report names the next action
(`install or start Docker, then run make up`). `llm-handler` is an external
dependency (retired Supabase and GitHub-intake configuration). `creative-studio`
is tests-only. `deep-search` runs its own UI server and is not yet in the root stack.

## Not yet proven here

- `make up`, `make telemetry`, backup and restore drill, and `make canary` need a
  Docker runner. The PR Gate's `verify-local-stack` action runs exactly these on
  every PR that touches `ops/**`, `compose.yaml`, `Makefile` or a Dockerfile. This
  file is in `ops/`, so the stack proof runs on this PR's head.
- Acceptance criteria 3 to 7 of #559 stay open until that run and the remaining
  app smoke proofs are recorded.
