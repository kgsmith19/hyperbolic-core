Title: CHORE(platform): production bootstrap -- Infisical, VPS, branch protection
Type: CHORE
Component: Platform (cross-cutting: deploy.yml, platform-migrations.yml, repo settings)
Milestone: M1 Platform foundations
Depends on: m1-05-chore-ci-platform-migrations-workflow.md, m2-07-chore-ci-deploy-shell.md
Blocks: none (every other issue's own CI/tests already run hermetically; this issue only unblocks the pipelines' first REAL execution against production)

## Problem

`deploy.yml` and `platform-migrations.yml` are both complete, real implementations (not stubs) -- verified by reading them directly -- but neither has ever run to a real outcome:

- `platform-migrations.yml` has zero successful standalone runs (`gh api` / GitHub Actions run history confirms `total_count: 0`); its one invocation via `deploy.yml`'s `migrate-platform` job failed in 11 seconds at the Infisical OIDC step with `Missing identity ID for OIDC auth`, because `vars.INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID` has never been set.
- `deploy.yml`'s `build-shell`/`deploy-shell` jobs are gated on `vars.DEPLOY_ENABLED == 'true'`, which has never been set, so they report `skipped`, not `failed` -- a deliberate safety default, not a bug.
- No Infisical org/project exists for this repo. `docs/ops/runbook.md` (added by the PR #9 stabilization pass) already documents *which* repository variables and Infisical paths the Shell deploy job needs, but does not name the platform-migrations identity, and neither it nor any other artifact documents how the VPS itself gets provisioned from nothing (the `deploy` OS user, its `authorized_keys`, the tailnet join, the initial `/home/deploy/{shell,lifeos-ui}` directory layout) -- every existing doc assumes a `deploy@$DEPLOY_HOST` that already exists and already trusts a key.
- Branch protection on `main` has never required the three existing PR Gate checks (Toolbelt, ACC, Shell); `10-cicd-deployment.md`'s own gate question 1 flagged this and it was never closed.
- This same PR #9 pass fixed the `deploy-shell` job's missing SSH-key-materialization step (it called `ssh`/`scp` with no key ever written to disk -- Infisical's action only exports secrets as environment variables, it has no SSH-key-file feature of its own) and introduced the exact secret name the fix expects: `SHELL_DEPLOY_SSH_KEY`, injected from Infisical path `/platform/shell-deploy/`.

None of this is disputed or blocked on a design decision -- every piece is already fully specified in `10-cicd-deployment.md` section 6, `04-adrs.md` ADR-05, and `docs/ops/runbook.md`. What's missing is the one consolidated, acceptance-criteria-bearing checklist an operator can actually execute end to end, and the one previously-undocumented secret name (`INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID`) plus the VPS-from-nothing steps this issue adds.

## Scope

In scope:
- Stand up an Infisical org + project for this repo (distinct from the standalone `kgsmith19/lifeos` repo's own separate Infisical project).
- Create environment `prod`, paths `/platform/shell-deploy/` (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `SHELL_DEPLOY_SSH_KEY`) and `/toolbelt/` (`SUPABASE_DB_URL`, a table-owner Postgres connection string).
- Create two GitHub-OIDC machine identities, one per pipeline (ADR-05's one-identity-per-pipeline rule): `shell-deploy` and `platform-migrations`.
- Provision one VPS: join it to the tailnet as an approved device; create the `deploy` OS user; install the public half of the deploy key pair into its `authorized_keys`; create the initial `shell/` and `lifeos-ui/` directories it owns.
- Set GitHub repository variables: `DEPLOY_ENABLED`, `DEPLOY_HOST`, `INFISICAL_PROJECT_SLUG`, `INFISICAL_SHELL_DEPLOY_IDENTITY_ID`, `INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID`.
- Configure branch protection on `main`: require `Toolbelt PR Gate`, `ACC PR Gate`, `Shell PR Gate` (add `Brain PR Gate` when m4-08 lands its own workflow; not yet, per this issue's own scope boundary).
- Update `docs/ops/runbook.md` with the platform-migrations identity variable and a short VPS-bootstrap section, so a future rebuild of the box has a real starting point instead of assuming one exists.

Out of scope:
- Applying the platform migrations themselves (that is `platform-migrations.yml`'s own normal-mode dispatch, already implemented; this issue only makes the dispatch capable of authenticating, per `docs/ops/runbook.md`'s existing "One-time platform migration adoption" section).
- The platform IdP owner setup (m1-07; a separate, already-specified operator runbook this issue does not duplicate).
- The standalone `kgsmith19/lifeos` repo's own, entirely separate production checklist (its own Infisical project, its own VPS story if not co-located, its `age` backup keypair, D-13's `build-backend` gate) -- tracked in `12-risk-register.md` section 5's Out-of-Brief Register, not here, because it is a different repository this issue's own PR gate cannot verify.
- Adding `Brain PR Gate` to branch protection (no such workflow exists yet; m4-08 owns creating it).

## Acceptance criteria

When `platform-migrations.yml` is dispatched manually with default (non-baseline) inputs, the Infisical OIDC step shall succeed and the job shall proceed to its own owner-preflight and `supabase db diff` parity checks (which may still legitimately halt the run if m1-07's owner setup has not separately landed -- that is a different, already-tracked gate, not this issue's failure).
When `deploy.yml`'s `build-shell`/`deploy-shell` jobs run with `vars.DEPLOY_ENABLED` set to `true`, the Infisical step, the SSH-key-load step, the tailnet join, and the `ssh`/`scp` calls to `deploy@$DEPLOY_HOST` shall all succeed.
`main`'s branch protection settings shall list `Toolbelt PR Gate`, `ACC PR Gate`, and `Shell PR Gate` as required status checks.
No Infisical value, private key, or Tailscale OAuth secret shall appear in any commit, workflow log, or command argument.

## Verification

Manual `workflow_dispatch` of `platform-migrations.yml` (mode: apply, no baseline flag) reaches its owner-preflight step rather than failing at the Infisical step.
Manual `workflow_dispatch` of `deploy.yml` (default inputs) completes `build-shell` and `deploy-shell` with the health-check step passing (`curl -fsS https://$DEPLOY_HOST/healthz` returns `{"status":"ok"}`).
GitHub Settings -> Branches -> `main`'s protection rule, inspected directly, lists the three required checks.
`gitleaks detect` on the PR diff for the `docs/ops/runbook.md` update returns zero findings.

## Estimated LOC delta

Added: 60 (runbook doc additions only; the Infisical project, VPS, and branch-protection settings are infrastructure/config, not repository code)
Deleted: 0
Net: +60

## Risk

High but entirely operational, not technical: every step here is infrastructure/account setup outside any coding session's reach (no coding session in this repository holds Infisical org-admin, GitHub repo-admin, or a VPS provider's credentials, by ADR-05's own design). The risk is elapsed time and operator error (e.g. a wrong Infisical path scoping one identity to read another's secrets), not implementation correctness -- every pipeline this issue activates has already been reviewed and tested against everything short of the real external services.
