---
description: Manual bridge from agent-roles.yaml to GitHub repo variables (if needed)
---

Reads `/agent-roles.yaml` and syncs values to GitHub repository variables via the GitHub API.

Usage: `/roles sync`

This command is **optional** — use only if GitHub Actions still require the legacy `vars.DEV_*` and `vars.REVIEW_*` variables. After workflow migration to read from `agent-roles.yaml` directly, this command becomes unnecessary.

Requires: `GH_TOKEN` with `repo` scope.
