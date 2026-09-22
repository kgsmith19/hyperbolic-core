# Approved Exception List (INT-09 #397)

| consumer | justification | approved-by |
|---|---|---|
| `secrets.GITHUB_TOKEN` (ephemeral per-run) | GitHub-provided token, not vault-managed by design | standing exception |
| `secrets.TOOLBELT_OWNER_*` (GitHub secrets) | Owner-managed deploy tokens pending vault migration; each migration needs its own child | standing exception, migration-tracked |

No forced migration: listed consumers stay until their separately-authorized child lands.
