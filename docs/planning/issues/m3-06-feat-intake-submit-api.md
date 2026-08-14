Title: FEAT(intake): submit API with idempotent GitHub Issue creation
Type: FEAT
Component: Idea Intake
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-05-feat-intake-schema.md, m2-07-chore-ci-deploy-shell.md
Blocks: m3-07-feat-intake-ui.md, m4-06-feat-intake-optimize.md

## Problem
II-2 requires submit to create exactly one GitHub Issue idempotently, and II-3 requires that the app can never touch that Issue again. The call contract, error taxonomy, label scheme, and exact idempotency algorithm are 05-h-idea-intake.md sections 6 and 7; placement was originally specified as the Shell serving unit's platform API (05-h section 6.1), but that unit does not exist -- see the architecture-gap note below, which supersedes section 6.1's placement (not its call contract, error taxonomy, or idempotency algorithm, which this issue still implements verbatim).

### Architecture gap found and resolved during implementation

05-h section 6.1 assumed a server process behind the Shell; `10-cicd-deployment.md` (written later, the authoritative deployable-unit accounting) built Shell as static files only ("a container would add a unit for zero gain") with the 5-unit complexity budget already fully allocated to LifeOS/Shell/Brain/Handler A/the migrations-only platform container. 05-h's own gate question 1 anticipated exactly this fork ("the alternative is co-locating with services/llm-handler if 08 decides to build Handler A") but was never answered by an operator before this issue was implemented.

Resolved (operator decision, recorded here): pull Handler A (`services/llm-handler`, 08-llm-handlers.md forced decisions 5/7, budgeted as Unit 4 for M4/m4-05) forward and give it intake submit as its first tenant, instead of adding a 6th deployable unit or building a DB-only (pg_net/Vault) alternative. This stays inside the documented 5-unit budget (no displacement, only resequencing -- m4-05 now adds routes to an existing service rather than creating the unit from scratch) and keeps the idempotency/error-taxonomy/retry logic in TypeScript with real mocked-HTTP tests, matching every other hardened path in this repo. Cross-referenced from `08-llm-handlers.md` and `m4-05-feat-llm-handler-service.md`.

Consequence for this issue's own scope: `/api/intake/*` now lives at `services/llm-handler/src/server.ts`, not inside Shell. `10-cicd-deployment.md`, `11-roadmap.md`, and `12-risk-register.md` are updated to record Handler A's skeleton (Dockerfile, compose.yaml, deploy.yml's build-llm-handler/deploy-llm-handler jobs, a new Infisical identity/path) as delivered by this issue rather than by m4-05.

### PAT path deviation from this issue's original scope line

The scope line below still says "PAT from Infisical /toolbelt/" as originally written, but the actual implementation stores `TOOLBELT_GITHUB_INTAKE_PAT` at `/platform/llm-handler/` instead. Reason: `/toolbelt/` is already the path `platform-migrations.yml`'s own identity reads for `SUPABASE_DB_URL` -- a table-owner, RLS-bypassing Postgres credential, the single most powerful secret in either pipeline. Infisical grants are path-scoped, not per-key, so co-locating a narrow GitHub-Issues-only PAT in that same path would hand the migrations identity incidental read access to a credential it has no reason to touch, and vice versa. `/platform/llm-handler/` (this unit's own path, alongside its Tailscale/SSH deploy credentials) is the least-privilege choice and matches the one-path-per-deployable-unit shape `/platform/shell-deploy/` already established.

### Write-back mechanism correction against the actual current schema

Section 6.5 step 4's "single write-back UPDATE" reads, on the current schema, as a plain PostgREST PATCH -- but PR #8's own security review (Finding 8, `20260814040000_intake_mark_submitted_to_github_rpc.sql`) already revoked `authenticated`'s UPDATE grant on `github_issue_number`/`github_issue_url`/`submitted_at` (closing a forgeable-submission P1) and replaced it with `intake.mark_submitted_to_github()`, a SECURITY DEFINER RPC grantable only to `service_role`. That migration's own comment names this exact service as its intended caller. `services/llm-handler` therefore holds a `SUPABASE_SERVICE_ROLE_KEY` (a new, powerful credential, documented in `docs/ops/runbook.md`'s "Handler A deployment" section with the same care as `SUPABASE_DB_URL`) used for exactly this one RPC call; every other database access (the read, and the ADR-03 owner-session check) rides the caller's own session JWT through PostgREST/`core.is_platform_owner()`, never the service-role key.

### Label scope reduction against the actual current schema

05-h section 7's label scheme lists `type` (FEAT/BUG/CHORE) and `component` labels as editor-chosen. `m3-05`'s actual shipped schema (`intake.idea`) has no column to source either from -- there is no editor yet (m3-07) and no place to persist that choice even once one exists. Implemented: `from-idea-intake` (always) and `derived` (when `parent_idea_id` is set), both fully derivable from real columns. `type`/`component` are a tracked gap, not a silent omission: closing it needs two new `intake.idea` columns plus grants (a small follow-up migration) and m3-07 editor fields to set them: fold into m3-07's scope when that issue is implemented rather than opening a separate issue for ~2 columns.

## Scope
In scope:
- /api/intake/* routes, now on Handler A (`services/llm-handler`) per the architecture-gap resolution above, verified against the ADR-03 session (`core.is_platform_owner()` RPC, forwarding the caller's own bearer token -- no local JWT verification library, matching this repo's existing zero-JWKS-dependency convention)
- GitHub client limited to create-issue and the existence check, PAT from Infisical /platform/llm-handler/ (key TOOLBELT_GITHUB_INTAKE_PAT, see the PAT path deviation note above), never in the browser
- Idempotency algorithm and marker per 05-h section 6.5; error taxonomy handling per section 6.4; labels per section 7 (from-idea-intake, derived -- see label scope reduction note above)
- Handler A's deployable-unit skeleton: Dockerfile, compose.yaml, deploy.yml's build-llm-handler/deploy-llm-handler jobs, a new Infisical identity (INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID) and /platform/llm-handler/ path, a new tailscale-serve-apply.sh /api/ mount with its own preflight
Out of scope:
- UI (m3-07); optimize proxy (m4-06); any Issue update, comment, close, or label edit capability (structurally absent)
- Handler A's own /v1/complete, /v1/stream, /v1/count routes (08-llm-handlers.md section 5) -- those land with m4-05's remaining scope, which now only needs to add routes to an existing service
- The intake.idea type/component columns (see label scope reduction note above; deferred to m3-07)

## Acceptance criteria
When an idea is submitted, the system shall create exactly one GitHub Issue with the from-idea-intake/derived labels, idempotently across two submits with the same idempotency key (II-2).
When submit fails per any 05-h section 6.4 class, the row shall remain at status idea with null github fields (II-5).
If a request reaches /api/intake/* without a valid platform session, then the system shall respond 401 within 50 ms plus RTT (SH-4 for this API base; the RTT budget is required since ADR-03 session verification is itself one network round trip to Supabase, not a local check).
An idempotent re-submit of a submitted idea shall return within 500 ms p95 with no GitHub call.

## Verification
Real test suite (`services/llm-handler`, `npm test`): 56 tests covering auth fail-closed behavior, the GitHub error taxonomy's exact retry/backoff policy per class, the 3-page marker-scan cap, PostgREST read/write-back request shapes, the full submit orchestration (draft/already-submitted/create/crash-recovery paths), the II-5 row-state invariant (no write-back call on any of the 4 tested failure classes), per-idea in-process serialization under real concurrency, and full HTTP-level route behavior. Mutation-tested: the ADR-03 auth gate, the 3-page marker-scan cap, and the per-idea concurrency lock (each reverted, confirmed the corresponding test goes red, restored).
E2E against a scratch repo (operator-only, needs a real GitHub PAT and a real deployed Handler A -- not reproducible in a coding sandbox): call submit twice; gh api 'repos/<o>/<r>/issues?labels=from-idea-intake&state=all' --jq '[.[] | select(.body | contains("idea=<uuid>"))] | length' prints 1
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' https://<origin>/api/intake/submit returns 401 under 0.05 plus RTT (operator-only, needs a live deployed origin)

## Estimated LOC delta
Added: 900 (500 for the submit API logic/tests as originally estimated, plus ~400 for Handler A's pulled-forward deployable-unit skeleton: Dockerfile, compose.yaml, deploy.yml jobs, tailscale/runbook updates -- see the architecture-gap note above for why that skeleton is now delivered here instead of by m4-05)
Deleted: 0
Net: +900

## Risk
Medium; the idempotency window across crashes is the hard part, bounded by the marker scan plus the unique partial index. The Handler A pull-forward adds operational risk (a new service, a new Infisical identity, a new powerful SUPABASE_SERVICE_ROLE_KEY credential) but zero coding-correctness risk beyond what this issue's own test suite already covers -- same category as m1-13's own risk assessment (operator bootstrap time and credential-scoping care, not implementation correctness).
