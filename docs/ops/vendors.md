---
title: Third-Party Vendors
status: active
owner: Kyle
updated: 2026-10-29
---

# Third-Party Vendors

The platform is **local-only** (owner decision, 2026-10-29). Every sub-app runs on localhost or in
Docker, with SQLite for data. This page lists what is still external, and what has been superseded.

## Still used

| Vendor | Used for | Authentication |
| --- | --- | --- |
| GitHub | Code, Issues, Actions (PR verification and AI Review) | GitHub Apps (`hyperbolic-core-dev`, the reviewer App) and the Actions `GITHUB_TOKEN` |
| Infisical | Model keys and App credentials for AI Review and the dev agent only (`/review/`, `/dev-agent/`) | GitHub OIDC machine identities (see [`runbook.md`](runbook.md)) |
| Anthropic, OpenAI | Model APIs: AI Review (reviewer family ≠ builder family) and product LLM features | API keys read at run time; never committed |

## Superseded (being removed)

| Vendor | Was used for | Status |
| --- | --- | --- |
| Supabase | Postgres, PostgREST and Auth for the platform and LifeOS | Each sub-app moves to SQLite on localhost (std queue, Phase 2) |
| Hetzner (VPS and Storage Box) | Production host; restic backups | Deploy and backup workflows removed (#503); local backup and drill in #504 |
| Tailscale | Private access to the VPS; CI relay | Removed with the cloud workflows (#503) |
| Cloudflare | Public edge tunnel | Removed with the cloud workflows (#503) |
| Google (Gemini) | Model API | Superseded earlier; not provisioned |
