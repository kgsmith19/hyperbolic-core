# 05-e. LifeOS V1 Plan

Evidence date: 2026-08-12. Names per `00-canonical-names.md`. Realizes LO-1 through LO-4 of `03-v1-definition.md` under ADR-03 (single-principal Supabase Auth on the platform project) and the ADR complexity budget. Labels: `[VERIFIED: <path>]`, `[INFERRED]`, `[UNKNOWN]`.

## 1. Current state summary

LifeOS is the strongest component in the system and V1 treats it as a foundation to extend, not repair:

- Architecture: typed entity graph + append-only bitemporal event log kernel with 9 life domains (bills, calendar, cpap, documents, episodes, health_connect, intentions, money, ops) [VERIFIED: lifeos backend pyproject description; src/domains listing].
- Governance: 19 ADRs, 10 invariants, 11 domain constitution cells [VERIFIED: docs/archived/2026-08-16/lifeos-backend-adr listing; invariants.md].
- Deployed: single VPS `api` container + static frontend, tailnet-only via `tailscale serve`, nightly age-encrypted backups, the system's only working production pipeline [VERIFIED: 01-inventory.md section 5].
- Tested: backend pytest + frontend vitest/Playwright in the standalone repo's `PR Gate`; suites deliberately not run in this sandbox (they erase their Postgres) [VERIFIED: 01-inventory.md section 6; apps/lifeos/AGENTS.md warning].
- Auth posture is the system's baseline pattern: ES256-only local JWKS verification, subject must equal the single owner id, fail closed, RLS deny-all on kernel tables, scoped read-only MCP agent tokens [VERIFIED: 02-health-audit.md SEC-06; src/api/auth.py].
- API surface: `/healthz`, `/health-connect` (POST, shared secret), `/types`, `/capture`, `/documents`, `/action-proposals` (+approve/reject/draft), `/edges`, `/entities/{id}` (+`/forget`, `/history`), `/search`, chat SSE [VERIFIED: lifeos inventory endpoint list].
- LLM usage: the only Anthropic API consumer in the whole system: chat SSE (default `claude-opus-5`), bills extraction, intentions/priorities import [VERIFIED: src/api/chat.py; domains/bills/extract.py; domains/intentions/import_priorities.py].
- Frontend pages: Approvals, Browse, Capture, Chat, EntityDetail, Login, Tomorrow, each with tests [VERIFIED: frontend pages listing].
- Zero S1 or S2 defects registered against LifeOS at inventory depth [VERIFIED: 02-health-audit.md defect register; only D-13 touches the standalone repo's CI].

## 2. New feature candidates (forced decision 10)

Eight candidates, each grounded in domain modules and data that exist today. Cost: S under ~400 LOC, M ~400-900, L over ~900, including tests. Value is stated for a single operator.

| Rank | Candidate | Grounding (exists today) | Value | Cost | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | (a) Weekly review / briefing surface | `ops.briefing` cron already produces daily briefings and every scheduled job leaves an `execution_receipt` entity [VERIFIED: lifeos inventory: 4 daily CLIs, ADR-014 scheduled jobs/receipts] | High: the system already writes a daily narrative nobody can read without querying entities; a review page turns existing output into a daily/weekly habit surface and shows job health for free | S-M (~450 LOC: one read endpoint aggregating briefing + receipt entities, one page, tests) | SHIP |
| 2 | (g) Intentions daily planner on the Tomorrow page | intentions domain with LLM priorities import exists; Tomorrow page exists [VERIFIED: domains/intentions/import_priorities.py; frontend Tomorrow page] | High-medium: closes the loop from imported priorities to a plannable day; touches the page the operator opens daily | S (~350 LOC: intentions query into Tomorrow, ordering + done-state via existing capture/event path) | SHIP |
| 3 | (e) Money categorization + monthly budget rollup | SimpleFIN ingestion exists, operator-run [VERIFIED: domains/money; simplefin_client.py] | High: money questions are weekly-frequency real value | L (~1,200 LOC: category model, rules engine, rollup projection, UI) | REJECT for V1: highest cost on the board; foundation over completeness [VERIFIED: 03-v1-definition.md deferred table]; first candidate for V1.1 |
| 4 | (f) Documents semantic search | embedding table exists, embeddings are derived per ADR-004, CI runs pgvector [VERIFIED: kernel tables listing incl. embedding; ADR-004; ci.yml pgvector/pg17] | Medium: better recall over documents | M (~600 LOC: vector query path in `/search`, ranking merge, UI affordance) | REJECT for V1: `/search` already exists and works; incremental recall gain does not beat (a)/(g) on value per LOC |
| 5 | (c) Health trends dashboard | cpap (SleepHQ) + health_connect webhook data flowing [VERIFIED: domains/cpap; main.py health-connect endpoint] | Medium: trends are nice-to-know, rarely action-driving | M (~650 LOC incl. charting) | REJECT for V1: read-only dashboard, no decision loop attached; revisit when (a) exists to host trend digests |
| 6 | (b) Bill dispute pipeline completion | ADR-018 approval-gated dispute draft exists as the pattern; bills extraction live [VERIFIED: adr/018; domains/bills/extract.py] | Medium: episodic (disputes are rare events) | M (~700 LOC + external comms surface) | REJECT for V1: adds an external-communications capability to a component holding broad reads, exactly the combination invariant 8 polices; needs its own boundary design first |
| 7 | (h) Natural-language capture improvements | `/capture` endpoint + Capture page exist [VERIFIED: endpoint list; Capture page] | Medium: quality-of-life on an existing flow | M (~500 LOC + per-capture LLM cost on a hot path) | REJECT for V1: adds recurring LLM spend and latency to a path that works; telemetry first |
| 8 | (d) Calendar conflict / travel-time warnings on autolink | ICS ingestion + zero-LLM autolink exist [VERIFIED: domains/calendar/ingest.py; ADR-013] | Medium-low: conflicts visible in source calendars already | M (~600 LOC; travel time needs a routing API, a NEW external dependency) | REJECT for V1: violates the ADR-06 minimal-egress posture for marginal value; conflict-only variant reconsidered post-V1 |

Recommendation: ship (a) weekly review/briefing surface and (g) intentions daily planner. Why they win: both convert data the system already produces into daily-use surfaces, both are S/S-M cost, neither adds an external dependency, LLM spend, or a new invariant-8 risk, and both strengthen the habit loop that makes every other domain's data worth collecting. Why the losers lost is stated per row; the ranked list is preserved here per the `03-v1-definition.md` deferred table ("LifeOS features beyond the two selected").

Latency budgets for the two shipped features' hot paths:

| Path | p50 | p95 | Enforced by |
| --- | --- | --- | --- |
| Briefing/receipts read endpoint | 120 ms | 300 ms | backend perf test over seeded receipts |
| Review page render (data to paint, warm) | n/a | 500 ms | Playwright trace assertion |
| Tomorrow planner query (intentions + events for a day) | 100 ms | 300 ms | backend perf test |

## 3. The Brain's LifeOS integration surface (LO-4, Phase 7 dependency)

What exists: a read-only MCP server wrapping kernel services, and self-issued ES256 read-only agent tokens minted against a vault-held private key; scopes are `<domain>:<read|write>` and wildcards are refused [VERIFIED: src/mcp_server/tools.py, tokens.py; ADR-010; auth.py scope handling].

V1 contract: the Brain gets exactly two lanes, both riding existing mechanisms:

1. Read lane: the existing MCP server (or the same services over HTTP with an agent token), read scopes only. Endpoints the Brain may call: `GET /search`, `GET /entities/{id}`, `GET /entities/{id}/history`, `GET /types`, with token scopes limited to the domains a given Brain task declares.
2. Proposal lane: the single write-shaped capability is `POST /action-proposals` (draft only). The Brain may propose; only the operator approves, in the existing Approvals page [VERIFIED: action-proposals approve/reject endpoints; Approvals page]. No direct `/capture`, `/edges`, or entity mutation is exposed to the Brain in V1.

This keeps invariant 7 (agents only through services, never raw SQL) because both lanes are existing service surfaces, and invariant 8 (no component combines broad read + external comms + high-consequence writes) because the Brain's LifeOS writes are proposals with a human gate, and its broad-read tokens carry no write scope [VERIFIED: invariants.md items 7 and 8].

Contract shape (planning signature, implemented in the Brain's client per `07-brain-architecture.md` section 7.12):

```ts
// services/brain: LifeOS capability surface
export type LifeOsScope = `${string}:read` | "action-proposals:draft";

export interface LifeOsSurface {
  search(query: string, opts?: { domain?: string; limit?: number }): Promise<EntitySummary[]>;
  getEntity(id: string): Promise<EntityDetail>;
  getHistory(id: string): Promise<EventRecord[]>;
  listTypes(): Promise<TypeDefinition[]>;
  proposeAction(proposal: ActionProposalDraft): Promise<{ proposalId: string; status: "pending" }>;
  // No other methods exist. Approval/rejection is operator-only, out of this surface.
}
```

Token minting: the existing mint flow issues the Brain a token enumerating exactly the scopes above per task class; token subject and verification ride the ADR-03 platform JWKS once the auth migration (section 4) lands. Scope escalation is a refused request, not a negotiation [VERIFIED: auth.py refuses wildcard scopes].

## 4. Auth migration to Shell-level login (LO-2, ADR-03)

Today: frontend Login page performs `supabase-js signInWithPassword` against the LifeOS Supabase project; the backend verifies ES256 JWTs against `{LIFEOS_SUPABASE_URL}/auth/v1/.well-known/jwks.json` and requires `sub == LIFEOS_OWNER_USER_ID` [VERIFIED: frontend Login.tsx:16; src/api/auth.py]. Both verification inputs are environment variables, which is what makes this migration an env re-point rather than a code change [VERIFIED: auth.py env-driven config].

Step sequence:

1. Create the owner user in the platform project's Auth (toolbelt Supabase project per ADR-03), sign-ups disabled; record the new owner UUID.
2. Backend re-point: in the standalone repo's deploy env (Infisical-rendered `.env`), set `LIFEOS_SUPABASE_URL` to the platform project URL (JWKS source) and `LIFEOS_OWNER_USER_ID` to the new owner UUID; redeploy. This is the only CI/CD-adjacent change permitted by this plan (section 5).
3. Frontend re-point: `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` repo vars move to the platform project's values.
4. Session source swap: the frontend obtains its session from `packages/platform-client` (the Shell's shared auth module, ADR-03) instead of its own `signInWithPassword`; `client.ts` keeps attaching the Bearer token exactly as today.
5. Delete the Login page (`Login.tsx` + `Login.test.tsx`) and its route; an unauthenticated visit redirects to the Shell login per SH-2.
6. Re-mint agent/MCP tokens so their verification chain matches the platform JWKS (section 3).
7. Document break-glass: `LIFEOS_AUTH_MODE=disabled` on localhost only, already implemented and logged [VERIFIED: auth.py; ADR-03 failure-mode paragraph], answering `03-v1-definition.md` gate question 2.

Risks, stated plainly:

- One-time session invalidation: every existing LifeOS session dies at step 2; the operator logs in once at the Shell. Accepted cost per ADR-03.
- Availability coupling: LifeOS login availability now tracks the platform project's Auth uptime; break-glass covers IdP outage for local access.
- Ordering: step 2 before step 4 leaves a window where the old frontend cannot authenticate; execute 2-5 as one deploy train and verify with the smoke flow.

EARS criteria (realizing LO-2):

| # | Criterion (EARS) | Verification command |
| --- | --- | --- |
| LO-2a | When the operator authenticates at the Shell, LifeOS routes shall render data with no second login. | Playwright: Shell `signInWithPassword` once, goto LifeOS route, assert data nodes present (SH-3 shared spec) |
| LO-2b | The LifeOS frontend shall contain no local sign-in call. | `grep -rn signInWithPassword apps/lifeos/frontend/src --include='*.ts*'` returns zero hits outside `packages/platform-client` usage |
| LO-2c | If a request reaches the backend with a JWT signed by the old project's keys, then the backend shall reject it with 401. | `curl -s -o /dev/null -w '%{http_code}'` with a stale-issuer token against `/types` returns 401 |
| LO-2d | If a request presents a platform JWT whose subject is not the owner UUID, then the backend shall reject it with 401. | existing auth pytest case re-run with platform-issuer fixtures: `pytest tests/api/test_auth.py` in the standalone repo |
| LO-2e | While `LIFEOS_AUTH_MODE=disabled` is set, the backend shall serve localhost requests and shall log the disabled mode on startup. | existing auth-mode pytest; log line asserted |

## 5. Explicitly out of scope

- CI/CD changes to the standalone `kgsmith19/lifeos` repo beyond the auth env re-point of section 4 step 2/3. The operational workflows (ci, ops, backup, release-smoke) are lifeos-owned and live only in the standalone repo; the monorepo copies are inert by design [VERIFIED: root AGENTS.md workflow safety invariant].
- D-13 (`build-backend` ungated on push to main) is a standalone-repo defect and stays on the Out-of-Brief Register, cross-referenced here, per `02-health-audit.md` gate question 1. This plan neither fixes nor depends on it.
- Kernel changes: both shipped features are domain-and-interface work on existing kernel primitives; no new tables in the kernel spine [INFERRED: briefings and receipts are already entities; intentions already flow through capture/events].
- Any second-principal or sharing capability (ADR-03 reversal trigger governs).

## 6. EARS acceptance criteria for the V1 features (realizing LO-1, LO-3, LO-4)

| # | Criterion (EARS) | Verification command |
| --- | --- | --- |
| LO-1 | Existing gates shall stay green in the standalone repo through all of the above. | standalone repo `PR Gate` run link recorded in `TEST_LEDGER.md` |
| LO-3a | The system shall serve a review feed aggregating briefing entities and execution receipts for a requested date range. | `pytest tests/domains/ops/test_review_feed.py` (new); seeded receipts returned in range, out-of-range excluded |
| LO-3b | When a scheduled job has not left an execution receipt for its most recent scheduled slot, the review surface shall flag that job as missed. | same suite: seed a gap, assert the missed flag |
| LO-3c | The review feed endpoint shall respond within 300 ms p95 over seeded data. | perf case in the same suite, p95 over 50 calls |
| LO-3d | The Tomorrow page shall list the day's intentions ordered by priority, and marking one done shall append an event, never mutate history. | frontend `vitest run Tomorrow` extended; backend `pytest tests/domains/intentions/test_planner.py` asserting append-only event write |
| LO-3e | When priorities are re-imported, existing done-states shall be preserved. | same backend suite: import twice, done-state asserted stable |
| LO-4a | When the Brain presents a read-scoped token, `search`/`getEntity`/`getHistory`/`listTypes` shall succeed and no other method shall exist on the surface. | programmatic call script against the section 3 contract; type-level check that `LifeOsSurface` has exactly 5 methods |
| LO-4b | If the Brain calls `proposeAction`, then a pending proposal shall appear in Approvals and no entity shall change until operator approval. | integration test: propose, assert proposal row pending, assert target entity unchanged; approve via existing endpoint, assert applied |
| LO-4c | If any agent token requests a write scope other than `action-proposals:draft` or a wildcard, then minting shall be refused. | existing token pytest extended with the new scope table |

## 7. LOC deltas and deletion list

| Change | LOC delta (estimate) |
| --- | --- |
| Review feed endpoint + missed-receipt logic + tests | +280 py |
| Review page (frontend) + tests | +220 ts/tsx |
| Tomorrow planner integration (backend query + event path) + tests | +180 py |
| Tomorrow page changes + tests | +170 ts/tsx |
| Brain surface: scope table addition + proposal-lane tests | +120 py |
| Auth migration: platform-client session wiring | +60 ts |
| Deletions (below) | -180 |
| Net | ~ +850 |

Deletion list:

- `frontend/src/pages/Login.tsx` and `Login.test.tsx` plus the login route entry (~170 lines) [VERIFIED: Login page exists with test, frontend pages listing].
- The frontend's direct `signInWithPassword` call path and any session bootstrapping made redundant by `packages/platform-client` (~10 lines net after the shared import).
- Nothing backend-side: `auth.py` is env-driven and survives unchanged.

## Gate questions (batched, non-blocking)

1. Section 2 recommends (a) and (g). If the operator would trade (g) for the money rollup (e) despite its L cost, that displaces both S features in the V1 cut; the swap must be named before Phase 11 issues are cut.
2. The auth deploy train (section 4 steps 2-5) is executed through the standalone repo's pipeline. Confirm the operator will run it as one train; a partial re-point strands the frontend against the wrong issuer.
3. Whether the Brain's read lane uses the MCP transport or the same services over HTTP with an agent token is a `07-brain-architecture.md` section 7.12 decision; this plan's contract (section 3) is transport-neutral and both are already implemented server-side.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (type signatures, tables, and step sequences only)
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: PASS (no new technology; the one migration cost, IdP re-point, is stated with risks in section 4)
- Machine-verifiable acceptance criteria: PASS (sections 4 and 6, each with a command)
- LOC delta reported: PASS (section 7, ~ +850 net)
- Deletion list present: PASS (section 7, Login page)
- Latency budgets stated for new paths: PASS (section 2 table; LO-3c enforced)
- Questions batched: PASS (3, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none (no new deployable unit, runtime, database, or auth flow; auth flows reduce toward 1 per ADR-03)
