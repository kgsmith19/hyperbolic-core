---
description: Change dev or reviewer model/provider
---

Update `/agent-roles.yaml` with a new model or provider.

Usage: `/role set dev anthropic claude-opus-4-20250514`
       `/role set review openai gpt-4o`

Validates:
- Provider is one of: anthropic, openai, gemini
- Model name is non-empty
- After update: review.provider ≠ dev.provider family (fails if they match)

Edits the YAML file in-place and reloads Kilo agents.
