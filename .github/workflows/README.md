# GitHub Actions workflows

This repository has two active workflows.

## PR Gate (`ci.yml`)

Runs automatically for pull requests and merge groups. The workflow and its
single check are both named `PR Gate`. It checks out the repository, selects
Python 3.12, and runs:

```bash
bash tools/check.sh
```

That command is also the local verification entry point. It runs the complete
unit test suite, complexity checks, the deterministic security scanner,
documentation checks, and shell syntax checks.

## Release (`release.yml`)

Runs only when manually dispatched from a selected `vX.Y.Z` tag. It first
runs `bash tools/check.sh`, then builds and smoke-tests the Docker image,
uploads the image artifact, and creates a draft GitHub Release.

Use `bash tools/deploy.sh` for a local build and smoke test when no GitHub
release is needed.
