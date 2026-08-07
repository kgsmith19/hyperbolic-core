---
title: toolbelt Data Flow Diagram
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
traces: [FR-001, FR-002, FR-004, FR-005, FR-006, FR-007, NFR-001, DR-001, DR-002, DR-003, DR-004, DR-005]
---

# Data Flow Diagram

Where data comes from, where it goes, where it rests. What the product does lives in `docs/PRD.md`; what the system must be lives in `docs/SYSTEM-REQUIREMENTS.md`.

## 1. Trust boundaries

```
┌─ Kyle's browser ──────────────────────────────────────┐
│  web/index.html   (untrusted: anyone can open it)     │
│    - holds an access token in memory only             │
│    - ships the anon key in config.mjs, by design      │
└───────────────┬───────────────────────────────────────┘
                │ HTTPS
                │ (1) POST /auth/v1/token   email + password
                │ (2) GET  /rest/v1/idea    Bearer <token>
                ▼
┌─ Supabase project `toolbelt` ─────────────────────────┐
│  GoTrue (auth)  ──issues──▶ JWT with sub = auth.uid() │
│  PostgREST      ──enforces──▶ RLS as role `authenticated`
│                                                        │
│  ┌─ Postgres ────────────────────────────────────┐    │
│  │  schema core  (10 tables)  ← every tool writes │    │
│  │  schema idea  (3 tables)   ← the backlog       │    │
│  │  RLS enabled AND forced on all 13              │    │
│  └────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────┘
                ▲
                │ same two endpoints, same anon key
┌───────────────┴───────────────────────────────────────┐
│  tests/*.test.mjs   (Node, no DB credentials)         │
└────────────────────────────────────────────────────────┘
```

The only trust boundary is the browser-to-Supabase hop. There is no application server to be a third position, which is why RLS is the entire authorization story.

## 2. Flows

| # | Flow | Source | Transport | Sink | Carries | Authorization |
|---|---|---|---|---|---|---|
| F-1 | Sign in | Browser form | HTTPS `POST /auth/v1/token?grant_type=password` | GoTrue | Email, password | Anon key identifies the project only |
| F-2 | Token issued | GoTrue | HTTPS response | Browser memory | Access token (JWT), `sub` = user id | — |
| F-3 | Read idea list | Browser | HTTPS `GET /rest/v1/idea` + `Accept-Profile: idea` | PostgREST → `idea.idea` | Bearer token | RLS: role must be `authenticated` |
| F-4 | Register a tool | A tool's operator | HTTPS `POST /rest/v1/app` + `Content-Profile: core` | `core.app` | Tool id, name, schema name | RLS: role must be `authenticated` |
| F-5 | Log a run | A tool | HTTPS `POST /rest/v1/rpc/log_run` (`Content-Profile: core`) | `core.log_run` → `core.run` + `core.cost` | `app_id`, `kind`, `wall_clock_ms`; `user_id` defaults to `auth.uid()` inside the function | RLS: `user_id = auth.uid()`, enforced the same as a direct insert; the RPC is `security definer` so it works even if `core.*`'s grants are ever tightened (SPEC-0003 RISK-008) |
| F-6 | Log run detail | A tool | HTTPS `POST` to `event`/`outcome` | `core.*` | Run id and payload | RLS: role must be `authenticated` |
| F-7 | Read idea scores | Browser | HTTPS `GET /rest/v1/score` + `Accept-Profile: idea` | PostgREST → `idea.score` | Bearer token | RLS: role must be `authenticated` |
| F-8 | Read metric names | Browser | HTTPS `GET /rest/v1/metric_def` + `Accept-Profile: core` | PostgREST → `core.metric_def` | Bearer token | RLS: role must be `authenticated` |
| F-9 | Read idea dependencies | Browser | HTTPS `GET /rest/v1/dependency` + `Accept-Profile: idea` | PostgREST → `idea.dependency` | Bearer token | RLS: role must be `authenticated` |

F-5 is SL-003 (SPEC-0003), shipped 2026-08-07: `prompt-organizer` is the first real caller. F-4 and F-6 remain the shape a tool uses to register itself and to log event/outcome detail directly; no tool writes those yet (PRD OOS-003). F-7 through F-9 are read by the same page load as F-3, in parallel (SPEC-0001, SPEC-0002).

## 3. Data at rest

| Store | Contents | Classification | Retention | Encryption |
|---|---|---|---|---|
| `idea.idea` (33 rows) | Tool names, categories, one-liners, status | internal | Forever, until Kyle deletes a row | At rest by Supabase |
| `idea.dependency` | One real edge (`constraint-finder depends_on optimize-metrics`, sourced from the topology note section 3) | internal | Forever, until Kyle removes an edge (DR-005) | At rest by Supabase |
| `idea.score` | Empty in production; no real judgment has been entered for any idea (PRD DR-004) | internal | Forever, once a row exists | At rest by Supabase |
| `core.metric_def` | One real row (`idea_effectiveness`, 0-10, proxy) plus test fixtures | internal | Forever | At rest by Supabase |
| `core.app`, `core.run`, `core.cost`, `core.outcome`, `core.run_outcome`, `core.metric_value`, `core.assumption`, `core.intervention` | Empty except test fixtures | internal | `core.run` and related tables: forever (PRD DR-002) | At rest by Supabase |
| `core.event` | Empty | internal | 90 days hot, then a monthly aggregate (PRD DR-003, default not yet implemented) | At rest by Supabase |
| `auth.users` | Two test-fixture accounts | internal | Until the fixtures are retired | Managed by Supabase |

**`core.event` is the unbounded-growth table.** Nothing writes to it yet. Its retention job is SL-004 and is tracked as RISK-001 in SPEC-0000.

## 4. Data in transit

| Hop | Protocol | What protects it |
|---|---|---|
| Browser → Supabase | HTTPS (TLS) | Supabase-managed certificate |
| Node test runner → Supabase | HTTPS (TLS) | Same |

No data crosses any other network hop. Nothing is written to disk by the browser: the access token lives in a JavaScript variable for the lifetime of the page load and is not placed in `localStorage`, `sessionStorage`, or a cookie.

## 5. Secrets

| Secret | Where it lives | Where it must never go |
|---|---|---|
| Supabase anon key | `config.mjs`, committed | Nowhere restricted; it is designed for client exposure and RLS is the real boundary |
| Supabase service-role key | Not in this repo | Never in this repo, a browser bundle, or git history |
| Test-fixture passwords | `tests/helpers.mjs`, committed | Accepted deliberately; see SPEC-0000 ASM-003. These accounts hold only RLS-scoped test rows in this dev project |
| Kyle's own account password | Typed into the sign-in form at use time | Never stored by the page or committed |

## 6. Personal data

None. No data item is classified PII (PRD section 8). The two test-fixture accounts use Gmail-alias addresses that are not separate real people, and the only personal data Supabase holds is the account email Kyle already gave it.

## Appendix: GATE-DFD self-check

- [x] Every flow names its source, sink, transport, and authorization.
- [x] Every store names its classification and retention, or says retention is undecided and where that is tracked.
- [x] Every trust boundary is drawn, and the diagram shows what crosses it.
- [x] Every secret names where it must never go.
- [x] Unbounded-growth stores are called out by name.
- [x] Personal data is either enumerated or explicitly stated to be absent.
- [x] No unfilled `<placeholder>` remains.
