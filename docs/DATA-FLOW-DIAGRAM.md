---
title: Prompt Organizer Data Flow Diagram
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
traces: [FR-001, FR-002, FR-003, FR-004, FR-007, NFR-003, NFR-005, NFR-011, DR-001, DR-002, DR-006]
---

# Data Flow Diagram

Where data comes from, goes, and rests. As of SL-002; later slices extend this file in the same commit that changes the flows.

## 1. Trust boundaries

```
┌─ Kyle's browser ─────────────────────────────────────┐
│  web/index.html (static; ships only the anon key)    │
│  access token held in a JS variable, never stored    │
└──────────────┬───────────────────────────────────────┘
               │ HTTPS
               │ (1) POST /auth/v1/token       email + password
               │ (2) GET/POST/PATCH /rest/v1/prompt   Bearer token,
               │     profile header "prompt"
               │ (3) GET /rest/v1/prompt_version       read-only
               ▼
┌─ Supabase project `toolbelt` ────────────────────────┐
│  GoTrue ──issues──▶ JWT, sub = auth.uid()            │
│  PostgREST ──enforces──▶ RLS (forced, owner-scoped)  │
│   └─ Postgres schema `prompt`:                       │
│      table `prompt`          (title, body writable;  │
│                                title unique per-user  │
│                                is global, case-fold)  │
│      table `prompt_version`  (insert-only from the    │
│                                client's point of view; │
│                                every row actually      │
│                                written by a trigger,   │
│                                never by direct client   │
│                                INSERT in practice)      │
└──────────────────────────────────────────────────────┘
               ▲ same endpoints, same anon key
┌──────────────┴───────────────────────────────────────┐
│  tests/*.test.mjs (Node, no DB credentials)          │
└──────────────────────────────────────────────────────┘
```

One trust boundary: browser to Supabase. No third position exists, which is why RLS is the entire authorization story (NFR-003) and why NFR-011 is checkable by listing the page's fetch targets — there are exactly two, both this project.

## 2. Flows

| # | Flow | Source | Transport | Sink | Carries | Authorization |
|---|---|---|---|---|---|---|
| F-1 | Sign in | Browser form | `POST /auth/v1/token?grant_type=password` | GoTrue | Email, password | Anon key names the project |
| F-2 | Token issued | GoTrue | HTTPS response | Browser memory | JWT | — |
| F-3 | Save a prompt | Browser form | `POST /rest/v1/prompt` | `prompt.prompt` | Title, body (confidential) | RLS `with check (user_id = auth.uid())`; rejected `409` if the title already exists, case-insensitively (FR-002) |
| F-4 | List / search prompts | Browser | `GET /rest/v1/prompt` | Browser DOM | Own rows only | RLS `using (user_id = auth.uid())`. Search (FR-006) filters the already-fetched list client-side; no separate network flow. |
| F-5 | Edit a prompt's body | Browser (not yet wired to a UI control; API-level, FR-003) | `PATCH /rest/v1/prompt` | `prompt.prompt` | New body (confidential) | RLS scopes the update to the owner; grant is column-scoped to `title, body` only |
| F-6 | Version recorded | Trigger on `prompt.prompt`, fired by F-3 or F-5 | In-database, no network hop | `prompt.prompt_version` | A full copy of the new body | `auth.uid()` carried through from the row being written, checked by the insert policy |
| F-7 | Read version history | Browser (not yet wired to a UI control; API-level, FR-009 pending) | `GET /rest/v1/prompt_version` | Browser | Own version rows only | RLS `using (user_id = auth.uid())` |
| F-8 | Render and copy | Browser (variable inputs) | In-browser only, no network hop | `navigator.clipboard` | Rendered body text (confidential — the same body already in the DOM, substituted) | None needed; the data never leaves the browser it was already fetched into |

Render (FR-004/007/010, SL-002) is a pure client-side transform over data F-4 already fetched — it opens no new flow to the database and carries no new authorization concern. `core.run` instrumentation arrives with SL-007.

## 3. Data at rest

| Store | Contents | Classification | Retention | Encryption |
|---|---|---|---|---|
| `prompt.prompt` | Titles (DR-001, internal, globally unique case-insensitively), bodies (DR-002, **confidential**), owner ids (DR-006) | per column | Forever until the user deletes — no `DELETE` grant exists at all, so today rows are effectively permanent | At rest by Supabase |
| `prompt.prompt_version` | One immutable copy of `body` per insert and per distinct-value body edit (DR-002, **confidential**), owner id (DR-006) | per column | Forever — no `UPDATE` or `DELETE` grant or policy exists on this table at all, ever (NFR-005's mechanism) | At rest by Supabase |
| `auth.users` | Kyle's account + two project-level test fixtures | internal | Until fixtures retire | Managed by Supabase |

Test fixture rows accumulate in `prompt.prompt` and `prompt.prompt_version` across suite runs (SPEC-0000 RISK-002, extended by SPEC-0002 RISK-002; accepted, cleaned by the migration's one-time dedup only, not routinely).

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
