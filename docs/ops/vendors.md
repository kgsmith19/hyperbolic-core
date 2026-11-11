---
title: Third-Party Vendors
status: active
owner: Kyle
updated: 2026-11-11
---

# Third-Party Vendors

The platform is **local-only** (owner decision, 2026-10-29). Every sub-app runs on localhost or in
Docker, with SQLite for data. Since 2026-11-11 (#562) the same stack also runs on one cloud host,
`hyperbolic-core-prod`, behind Cloudflare. This page lists what is still external, and what has been superseded.

## Still used

| Vendor | Used for | Authentication |
| --- | --- | --- |
| GitHub | Code, Issues, Actions (PR verification) | the Actions `GITHUB_TOKEN` (the reviewer and dev GitHub Apps are retired, #547) |
| Infisical | Model keys for product LLM features; the `/review/` and `/dev-agent/` paths are retired with AI Review (#547) | GitHub OIDC machine identities |
| Anthropic, OpenAI | Model APIs for product LLM features | API keys read at run time; never committed |
| Hetzner Cloud | `hyperbolic-core-prod` (CX33) + provider backups; Storage Box `hyperbolic-backups` (restic) | API token and Storage Box key in Infisical (`/providers/hetzner`, `/platform/backup`) |
| Cloudflare | DNS for `kylegsmith.com`, Tunnel `hyperbolic-core-prod`, Access app `Hyperbolic Core` (Zero Trust free tier) | Scoped API token in Infisical (`/CLOUDFLARE_API_TOKEN`); tunnel token separately (`/platform/core-tunnel`) |

## Superseded (being removed)

| Vendor | Was used for | Status |
| --- | --- | --- |
| Supabase | Postgres, PostgREST and Auth for the platform and LifeOS | Each sub-app moves to SQLite on localhost (std queue, Phase 2) |
| Hetzner VPS `lifeos-prod` | The old LifeOS production host | Idle since #503; kept until its data is checked, then a decommission proposal (#562 follow-up) |
| Tailscale | Private access to the VPS; CI relay | Removed with the cloud workflows (#503) |
| Google (Gemini) | Model API | Superseded earlier; not provisioned |
