---
title: Prompt Organizer Data Flow Diagram
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
traces: [FR-001, NFR-003, NFR-011, DR-001, DR-002, DR-006]
---

# Data Flow Diagram

Where data comes from, goes, and rests. As of SL-000; later slices extend this file in the same commit that changes the flows.

## 1. Trust boundaries

```
┌─ Kyle's browser ─────────────────────────────────────┐
│  web/index.html (static; ships only the anon key)    │
│  access token held in a JS variable, never stored    │
└──────────────┬───────────────────────────────────────┘
               │ HTTPS
               │ (1) POST /auth/v1/token    email + password
               │ (2) GET/POST /rest/v1/prompt   Bearer token,
               │     profile header "prompt"
               ▼
┌─ Supabase project `toolbelt` ────────────────────────┐
│  GoTrue ──issues──▶ JWT, sub = auth.uid()            │
│  PostgREST ──enforces──▶ RLS (forced, owner-scoped)  │
│   └─ Postgres schema `prompt`: table `prompt`        │
│      (this repo's only writable surface)             │
└──────────────────────────────────────────────────────┘
               ▲ same endpoints, same anon key
┌──────────────┴───────────────────────────────────────┐
│  tests/skeleton.test.mjs (Node, no DB credentials)   │
└──────────────────────────────────────────────────────┘
```

One trust boundary: browser to Supabase. No third position exists, which is why RLS is the entire authorization story (NFR-003) and why NFR-011 is checkable by listing the page's fetch targets — there are exactly two, both this project.

## 2. Flows

| # | Flow | Source | Transport | Sink | Carries | Authorization |
|---|---|---|---|---|---|---|
| F-1 | Sign in | Browser form | `POST /auth/v1/token?grant_type=password` | GoTrue | Email, password | Anon key names the project |
| F-2 | Token issued | GoTrue | HTTPS response | Browser memory | JWT | — |
| F-3 | Save a prompt | Browser form | `POST /rest/v1/prompt` | `prompt.prompt` | Title, body (confidential) | RLS `with check (user_id = auth.uid())` |
| F-4 | List prompts | Browser | `GET /rest/v1/prompt` | Browser DOM | Own rows only | RLS `using (user_id = auth.uid())` |

Render, copy, and `core.run` instrumentation flows arrive with SL-002/SL-007 and get rows here then.

## 3. Data at rest

| Store | Contents | Classification | Retention | Encryption |
|---|---|---|---|---|
| `prompt.prompt` | Titles (DR-001, internal), bodies (DR-002, **confidential**), owner ids (DR-006) | per column | Forever until the user deletes — though no `DELETE` grant exists yet, so today rows are effectively append-only | At rest by Supabase |
| `auth.users` | Kyle's account + two project-level test fixtures | internal | Until fixtures retire | Managed by Supabase |

Test fixture rows accumulate in `prompt.prompt` across suite runs (SPEC-0000 RISK-002, accepted).

## 4. Secrets

| Secret | Where it lives | Where it must never go |
|---|---|---|
| Anon key | Page and test file, committed | Nowhere restricted; designed for client exposure, RLS is the boundary |
| Service-role key | Not in this repo | Never in this repo, any bundle, or history |
| Fixture passwords | Test file, committed | Accepted; project-level fixtures holding only test rows (SPEC-0000 ASM-002) |
| Kyle's password | Typed at sign-in | Never stored by the page, never committed |

## 5. Personal data

None beyond the account emails Supabase auth already holds. Prompt bodies are confidential business text, not PII; NFR-011 keeps them off every third party — this application sends them to its own database and nowhere else.

## Appendix: GATE-DFD self-check

- [x] Every flow names source, sink, transport, and authorization.
- [x] Every store names classification and retention.
- [x] The trust boundary is drawn with what crosses it.
- [x] Every secret names where it must never go.
- [x] Personal data enumerated or stated absent.
- [x] No unfilled placeholder remains.
