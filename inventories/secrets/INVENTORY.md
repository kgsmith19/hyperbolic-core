# Runtime Secret Consumers — Metadata-Only Inventory (INT-09 #397)

Schema (header contract — every row carries exactly these fields, never values):

| handle | consumer | scope | location | last-verified |
|---|---|---|---|---|
| `infisical://<project>/<env>/<role>/<path>` | workflow/action file | Infisical secret-path | repo path of the consumer | UTC date verified |

No secret material appears here. Handles are references only.

| handle | consumer | scope | location | last-verified |
|---|---|---|---|---|
| `infisical://hyperbolic-core/prod/dev/*` | `.github/workflows/dev-agent-dispatch.yml` | `/dev/` | `.github/workflows/dev-agent-dispatch.yml` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/review/*` | `.github/workflows/llm-review*.yml` | `/review/` | `.github/workflows/llm-review.yml` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/*` | `.github/workflows/platform-*.yml` | `/platform/` | `.github/workflows/platform-backup.yml` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/backup/*` | `.github/workflows/platform-backup.yml` | `/platform/backup/` | `.github/workflows/platform-backup.yml` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/broker/*` | `.github/workflows/*broker*` | `/platform/broker/` | `.github/workflows/` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/edge/*` | `.github/workflows/*edge*` | `/platform/edge/` | `.github/workflows/` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/llm-handler/*` | `.github/workflows/*llm-handler*` | `/platform/llm-handler/` | `.github/workflows/` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/lifeos-deploy/*` | `.github/workflows/lifeos-deploy.yml` | `/platform/lifeos-deploy/` | `.github/workflows/lifeos-deploy.yml` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/platform/shell-deploy/*` | `.github/workflows/*shell-deploy*` | `/platform/shell-deploy/` | `.github/workflows/` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/brain/*` | `.github/workflows/brain-*.yml` | `/brain/` | `.github/workflows/` | 2026-09-22 |
| `infisical://hyperbolic-core/prod/toolbelt/*` | `.github/workflows/*toolbelt*` | `/toolbelt/` | `.github/workflows/` | 2026-09-22 |
| `secrets.GITHUB_TOKEN` | all workflows (ephemeral) | github-provided | `.github/workflows/` | 2026-09-22 |
| `secrets.TOOLBELT_OWNER_TOKEN` | deploy workflows | github-secret | `.github/workflows/deploy.yml` | 2026-09-22 |
| `secrets.TOOLBELT_OWNER_REFRESH_TOKEN` | deploy workflows | github-secret | `.github/workflows/deploy.yml` | 2026-09-22 |

## Public configuration (excluded from the vault, AC4)

- `vars.INFISICAL_*_IDENTITY_ID` — OIDC identity selectors, not secrets.
- `vars.INFISICAL_PROJECT_SLUG` — project selector, not a secret.

## Per-consumer migration children (AC2)

Filed from this inventory; each child separately authorized before any live change.
None open at publication — this inventory is the parent record.
