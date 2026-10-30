---
title: Platform Operations Runbook
status: active
owner: Kyle
updated: 2026-10-29
---

# Platform Operations Runbook

> [!IMPORTANT]
> **The platform is local-only (owner decision, 2026-10-29).** Supabase, Tailscale and Hetzner (the
> VPS, the Storage Box and the Cloudflare edge) are superseded. Every cloud deploy, backup, restore
> drill, canary and smoke workflow was removed by #503, along with the scripts and tests that served
> them. Every sub-app moves to SQLite on localhost or Docker. The local operations take this
> runbook's place as they land:
>
> - root `compose.yaml` plus `make up`, `make test`, `make backup` and `make restore-drill`, with a
>   local release tag and rollback: #504;
> - per-app SQLite migrations: the std queue, Phase 2.
>
> Whatever the VPS last ran keeps running untouched; nothing in this repository deploys to it any more.

The only remaining cloud dependency in CI is the pair of GitHub App identities that AI Review and
the dev-agent post as, plus the model keys they read from Infisical. Those are described below.

## Infisical OIDC identities (AI Review and dev agent)

Every identity uses the same three connection values:

| Field | Value |
| --- | --- |
| OIDC Discovery URL | `https://token.actions.githubusercontent.com` |
| Issuer | `https://token.actions.githubusercontent.com` |
| Audience | `https://github.com/kgsmith19` (the repository owner's URL -- GitHub's default audience; if an existing working identity here uses a different value, that one is authoritative) |

The **subject** is the one field that differs per identity, and the one
that has repeatedly been set wrong. It carries GitHub's immutable numeric
owner and repository IDs -- which is what makes it survive an owner or
repository rename -- then a trailing segment naming the triggering
context:

```
repo:<owner>@<owner_id>/<repo>@<repo_id>:<context>
repo:kgsmith19@64936641/hyperbolic-core@1331401739:<context>
```

`<context>` is decided by the workflow job, not by preference, and a
subject whose context does not match what that job's token actually
presents authenticates on zero real runs:

| The job... | `<context>` is | Example |
| --- | --- | --- |
| declares `environment: <name>` | `environment:<name>` | `...:environment:platform-migrations-production` |
| is `pull_request`-triggered with no environment | `pull_request` | `...:pull_request` |
| is any non-PR run with no environment | `ref:refs/heads/<branch>` | `...:ref:refs/heads/main` |

The production OIDC jobs that used the first row were removed with the cloud
surface (#503). The two remaining agent identities deliberately have no environment and use these exact subject
patterns (Infisical supports brace expansion):

| Identity | Exact Infisical subject | Workflows covered |
| --- | --- | --- |
| `review-gate` | `repo:kgsmith19@64936641/hyperbolic-core@1331401739:{pull_request,ref:refs/heads/main}` | `pr-verify.yml` (`pull_request`), plus `llm-review-dialogue.yml` (`workflow_run`) and `llm-review-recheck.yml` (`repository_dispatch`) on `main` |
| `dev-agent` | `repo:kgsmith19@64936641/hyperbolic-core@1331401739:ref:refs/heads/main` | `llm-review-dialogue.yml` (`workflow_run`), `dev-agent-dispatch.yml` (`repository_dispatch`), and `dev-agent-post.yml` (`workflow_dispatch`) on `main` |

**Live evidence (2026-08-21):** [`llm-review-dialogue.yml` run
32545529951](https://github.com/kgsmith19/hyperbolic-core/actions/runs/32545529951)
decoded its GitHub-issued token before the temporary diagnostic was
removed. It reported `sub` =
`repo:kgsmith19@64936641/hyperbolic-core@1331401739:ref:refs/heads/main`
and `aud` = `https://github.com/kgsmith19`. The run printed claims only,
never the raw token. This is the authoritative evidence for the shared
non-PR subject above; the `pull_request` half is independently exercised
by every provisioned `AI Review` job.

Sanitized excerpt from that run (the JWT itself was never logged):

```text
Relevant OIDC claims:
  "sub": "repo:kgsmith19@64936641/hyperbolic-core@1331401739:ref:refs/heads/main"
  "aud": "https://github.com/kgsmith19"
  "repository": "kgsmith19/hyperbolic-core"
  "ref": "refs/heads/main"
  "event_name": "workflow_run"
```

[`llm-review-dialogue.yml` run
32545881404](https://github.com/kgsmith19/hyperbolic-core/actions/runs/32545881404)
then successfully exchanged **both** the `review-gate` and `dev-agent`
identities from that `main`-ref context, proving both Infisical trust
updates were live. Its next reviewer-App mint failed with `Invalid
keyData`; that is a separate secret-content problem, not an OIDC subject
failure. Replace `/review/REVIEW_GITHUB_APP_PRIVATE_KEY` with the complete
PEM downloaded for the reviewer App, including its `BEGIN`/`END` lines
and real newlines, then re-run a pull request to prove the custom posting
identity.

- **`review-gate`** is exchanged both by the `ai-review` job (displayed as
  check `AI Review`) in `pr-verify.yml`, which is `pull_request`-triggered
  (second row), and by `llm-review-dialogue.yml`'s own Infisical pull for
  the reviewer's GitHub App credential, which is `workflow_run`-triggered,
  and by the `repository_dispatch` recheck. The latter two are non-PR
  workflows on the default branch, so both present the same
  `ref:refs/heads/main` context. The brace pattern allows exactly those two
  contexts without granting all repository contexts.
- **`dev-agent`** is exchanged by the dialogue's provisioning check, the
  repository-dispatched fixer, and the workflow-dispatched comment
  backstop. All three run from the default branch without an environment,
  so one exact `ref:refs/heads/main` subject covers them. Do not grant this
  identity `pull_request`; no developer workflow needs that context.

Do not "fix" the review gate's asymmetry by giving either of its jobs an
`environment:`: an environment on a `pull_request`- or `workflow_run`-
triggered job inherits that environment's protection rules, so a
required-reviewer rule would stall the job awaiting manual approval, and a
deployment-branch policy pinned to `main` would block pull-request
branches outright. Neither the review gate nor the dev agent dispatcher is
prod-touching, and both deliberately carry none of that machinery.

Note also that `llm-review.yml`'s own `push`/`workflow_dispatch` triggers
pass no PR number, and the composite action guards its Infisical step on
`if: inputs.pr_number != ''` -- so those triggers never exchange an OIDC
token at all. Dispatching that workflow cannot test the `review-gate`
identity; only a real pull request exercises it.

## LLM Review and Dev Agent identity setup

Two identities that never deploy anything, but do write to pull requests and
Issues under their own name: the `review-gate` identity (Infisical `/review/`)
mints the reviewer's own GitHub App token so `llm-review-dialogue.yml`'s
managed comment posts as that App rather than `github-actions[bot]`; the
`dev-agent` identity (Infisical `/dev/`) mints the dev agent's own GitHub App
token so `dev-agent-dispatch.yml`'s commits and comments post as that App
rather than borrowing `claude-code-action`'s own bundled identity. Both App
registrations and their private keys already exist; what follows is wiring
them into this repository, not creating them.

Configure these repository variables:

| Variable | Purpose |
| --- | --- |
| `INFISICAL_REVIEW_IDENTITY_ID` | The `review-gate` OIDC identity's ID -- read by both `ai-review` (`pr-verify.yml`) and `llm-review-dialogue.yml`. |
| `INFISICAL_DEV_IDENTITY_ID` | The `dev-agent` OIDC identity's ID -- read by `dev-agent-dispatch.yml`. |
| `LLM_REVIEW_IDENTITY_ESCALATE_AFTER` *(optional, planned #288)* | Consecutive identity-mint failures before `llm-review-dialogue.yml` tags the owner in the PR itself; will default to 1 (escalate on the first failure) when unset. |

Both `/review/` and `/dev/` must additionally hold `*_GITHUB_APP_ID` /
`*_GITHUB_APP_PRIVATE_KEY` for their respective App -- see the key tables
above (`/review/`, `/dev/`) and [`docs/ops/vendors.md`](vendors.md#infisical)
for the full path list.

**Verify, don't assume, the OIDC trust config actually covers these jobs.**
See "Infisical and GitHub configuration" above for the exact subject matrix.
`review-gate` needs the `pull_request` and default-branch `ref` contexts;
`dev-agent` needs only the default-branch `ref` context. This repository's
docs have historically lagged the code here, so confirm against a live run's
own OIDC claims or Infisical auth log rather than broadening either pattern.

`docs/ops/bootstrap-github.sh` accepts these as optional flags
(`--infisical-review-identity=<id>`, `--infisical-dev-identity=<id>`),
alongside its existing required deploy-identity flags -- see "Infisical and
GitHub configuration" above for the full invocation.
