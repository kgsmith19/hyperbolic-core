# LifeOS consolidation preflight (2026-10-22)

Status: **read-only architecture audit; production cutover NOT authorized or performed**.

## Confirmed in source

- The canonical repository is `hyperbolic-core`; LifeOS source is already under `apps/lifeos/backend` (FastAPI) and `apps/lifeos/frontend` (React/Vite).
- Root workflows include `.github/workflows/deploy.yml`, `lifeos-deploy.yml`, `lifeos-ci.yml`, and `platform-smoke.yml`. These are distinct orchestration entrypoints today, not one pipeline.
- `apps/lifeos/backend/compose.yaml` runs one LifeOS API container, binds port 8000 to **127.0.0.1** on the host, uses a named blob volume, has a /healthz Docker health check, and caps JSON-file logs.
- LifeOS UI is built as static assets; the deployment workflow describes nginx routes under `/life/` and `/life/api/`.
- `lifeos-deploy.yml` has **both** `DEPLOY_ENABLED` and `LIFEOS_DEPLOY_ENABLED` deployment gates, uses Infisical OIDC and an ephemeral Tailscale CI node, and transports the image by Docker save/load over SSH.
- `platform-smoke.yml` defines gated private-origin probes. Presence of a probe does **not** establish that it passed in production.
- Existing LifeOS `domains.calendar.ingest` implements ICS ingestion with content-hash idempotency and source receipts; `domains.calendar.autolink` resolves exact-email identity with ambiguity review; `domains.ops.receipts` provides scheduled-job execution receipts.

## Direct Supabase read-only inventory

- Production project `vhbzblllaohuljtareza`: six public kernel tables, all RLS-enabled. The security advisor reports RLS with no policies for these six tables (consistent with an intentionally deny-all client posture, but effective privileges need verification); leaked-password protection is disabled.
- Test project `yueddwuhxflzbjehqufw`: the same six public kernel tables, all RLS-enabled. Migration history differs from production and includes rehearsal migrations.
- **No database writes or project consolidation were performed.**

## Safe implementation sequence

1. Read current GitHub Actions runs, deploy feature variables, and the old standalone writer status; establish whether one or two writers can deploy LifeOS. Stop before any cutover if unknown.
2. Verify actual VPS processes, free RAM, disk usage, Docker networks, container restart state, nginx routing, and active Tailscale Serve configuration through an authorized operational access path.
3. Establish reproducible read-only checks for deploy-path classification, rollback artifacts, smoke endpoint expectations, and Infisical/Tailscale boundaries.
4. Introduce a **single orchestrating deployment entrypoint** only after mapping all existing job triggers and concurrency guarantees; keep backend containers isolated and frontend bundles static. Preserve existing rollout gates while refactoring.
5. Build appointment automation as a separate thin domain around the existing kernel: ingest email metadata safely -> deterministic appointment candidate -> validation -> idempotent fingerprint -> calendar/task reconciliation -> notification -> execution receipt. Require scoped OAuth, explicit send/write policies, and replay tests before enabling live writes.
6. Validate CI against the PR branch; perform staged smoke and rollback drills before enabling any production switch.

## Stop conditions

- No automatic removal of standalone repos, services, Supabase projects, migrations, or backups.
- No changes to production `DEPLOY_ENABLED` / `LIFEOS_DEPLOY_ENABLED`, Infisical credentials, or external Google Calendar events without explicit cutover authorization.
- No assumption that deploy config, smoke checks, or backups are currently healthy solely because their files exist.

## Next evidence required

Actual GitHub workflow-run outcomes, old deploy-writer status, VPS runtime and capacity, nginx live config, Tailscale Serve listeners, Infisical secret identity presence (never secret values), and a reversible snapshot/rollback demonstration.
