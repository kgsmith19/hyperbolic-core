# AGENTS.md

## Repository purpose

`hyperbolic-core` is a monorepo consolidating multiple standalone repos under `apps/<name>/`. Each app was imported via `git subtree` and retains its own upstream `AGENTS.md`, `CLAUDE.md`, and docs, which describe that app as it looked as a standalone repo. Read the nested `AGENTS.md` under an app's directory for that app's actual rules before working in it.

## Workflow safety invariant

The repo-root `.github/workflows/` contains only workflows deliberately activated for `hyperbolic-core` itself. Files under any `apps/*/.github/workflows/` are inert by design — GitHub only executes workflows from a repository's root `.github/workflows/`, never from a nested path — and they must never be copied or moved to the root.

This matters concretely, not just abstractly. `apps/lifeos/.github/workflows/ci.yml` contains a `build-backend` job that, unlike its sibling deploy jobs, has no repository-variable gate on it. If that workflow were ever relocated to the root, `build-backend` would run for real on every push to `main` and publish a Docker image to `ghcr.io/kgsmith19/hyperbolic-core`. That is the kind of accident this rule exists to prevent.
