---
description: Display current dev/reviewer role configuration
---

Show the current model and provider for both dev and reviewer roles from `/agent-roles.yaml`.

Example output:
```
dev:
  provider: anthropic
  model: claude-sonnet-4-20250514

review:
  provider: anthropic
  model: claude-opus-4-20250514

(note: provider families match; future change may enforce separation)
```
