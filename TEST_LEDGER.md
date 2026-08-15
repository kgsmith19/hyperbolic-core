# Test Ledger

This is a monorepo — each app under `apps/` owns its own test suites and, where relevant, its own `TEST_LEDGER.md`. This root ledger tracks every workflow in `.github/workflows/`, grouped by what actually triggers it.

## PR gates

These run on `pull_request` and `merge_group`. A change is not mergeable until the ones its paths touch are green.

| Gate | Covers | Workflow |
| --- | --- | --- |
| `Toolbelt PR Gate` | `apps/toolbelt/**` (root tools, `guards/`, `prompt-organizer`, `idea-intake`, `network-checker`) | `toolbelt-ci.yml` |
| `ACC PR Gate` | `apps/agentic-command-center/**`, `apps/toolbelt/guards/**` | `acc-ci.yml` |
| `Brain PR Gate` | `services/brain/**` | `brain-ci.yml` |
| `Shell PR Gate` | `apps/shell/**`, `packages/**` | `shell-ci.yml` |
| `Gitleaks` | the whole repo, every PR | `secret-scan.yml` |

## Deploy

| Workflow | Trigger | Notes |
| --- | --- | --- |
| `deploy.yml` | push to `main`, `workflow_dispatch` | Shell, Handler A, and the Brain. Every job is gated on the `DEPLOY_ENABLED` repository variable **except** `migrate-platform`, which applies Supabase migrations whenever they change on `main` — migrations target the hosted project, which exists independently of the VPS the other jobs deploy to. |
| `platform-migrations.yml` | `workflow_call`, `workflow_dispatch` | Called by `deploy.yml`; also runnable on its own. |
| `platform-contract.yml` | `workflow_call`, `workflow_dispatch` | Verifies the deployed platform contract. |

## Scheduled

| Workflow | Trigger | Notes |
| --- | --- | --- |
| `platform-backup.yml` | schedule, `workflow_dispatch` | Age-encrypted backup of the platform project. |
| `brain-eval-nightly.yml` | schedule, `workflow_dispatch` | Runs the Brain's eval corpus. |

## Manual only

| Workflow | Notes |
| --- | --- |
| `toolbelt-network-checker-release.yml` | Builds a Network Checker release artifact. |
| `shell-idp-down.yml` | Tears down the Shell's IdP configuration. Destructive; `workflow_dispatch` only. |

## Inert here

`apps/lifeos/.github/workflows/` is **not** executed. GitHub only runs workflows from the repository root's `.github/workflows/`, never from a nested path, and those files are kept as-is from the standalone `lifeos` repo. See the repo-root `AGENTS.md` for why they must never be copied to the root.

See `apps/toolbelt/TEST_LEDGER.md` and `apps/agentic-command-center/TEST_LEDGER.md` for suite-level detail within each app.
