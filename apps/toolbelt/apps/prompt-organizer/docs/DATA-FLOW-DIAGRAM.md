---
title: Prompt Organizer Data Flow Diagram
status: active
scope: repo
created: 2026-08-07
updated: 2026-08-11
owner: Kyle
traces: [FR-001, FR-002, FR-003, FR-004, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, NFR-003, NFR-005, NFR-010, NFR-011, DR-001, DR-002, DR-003, DR-005, DR-006, DR-007]
---

# Data Flow Diagram

Where data comes from, goes, and rests. As of SL-008; later slices extend this file in the same commit that changes the flows.

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
│      table `tag`             (owned via the parent     │
│                                prompt row's user_id;    │
│                                carries no user_id of    │
│                                its own; cascade-deleted │
│                                with its prompt)         │
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
| F-4 | List / search prompts | Browser | `GET /rest/v1/prompt?select=...,tag(tag)` | Browser DOM | Own rows only, with each row's tags embedded via the FK relationship in one round trip | RLS `using (user_id = auth.uid())` on both `prompt` and, through the embed, `tag`. Search (FR-006, tags included since SL-006) and tag filtering (FR-012) both run client-side over the already-fetched list; neither is a separate network flow. |
| F-5 | Edit a prompt's body — including a restore (SL-008: the new body sent is a prior version's own stored body) | Browser, from the version-history panel's Restore control | `PATCH /rest/v1/prompt` | `prompt.prompt` | New body (confidential) | RLS scopes the update to the owner (T-I-015 proves a cross-user attempt affects 0 rows); grant is column-scoped to `title, body` only |
| F-6 | Version recorded | Trigger on `prompt.prompt`, fired by F-3 or F-5 | In-database, no network hop | `prompt.prompt_version` | A full copy of the new body | `auth.uid()` carried through from the row being written, checked by the insert policy |
| F-7 | Read version history | Browser, on expanding a prompt's "Version history" panel | `GET /rest/v1/prompt_version` | Browser | Own version rows only | RLS `using (user_id = auth.uid())` |
| F-8 | Render and copy | Browser (variable inputs, and since SL-003 one checkbox per optional section) | In-browser only, no network hop | `navigator.clipboard` | Rendered body text (confidential — the same body already in the DOM, substituted and with unselected sections removed) | None needed; the data never leaves the browser it was already fetched into. Excluding a section removes text on its way *out*, so the clipboard can only ever hold a subset of what F-4 already delivered |
| F-9 | Add tags to a prompt | Browser form (save flow) | `POST /rest/v1/tag` | `prompt.tag` | Tag strings, trimmed/lowercased/deduplicated client-side (internal — bare category words, not confidential) | `with check` via `EXISTS (... prompt.prompt.user_id = auth.uid())`, since `tag` has no `user_id` of its own |
| F-10 | Log usage | Browser, immediately after F-8's copy succeeds | `POST /rest/v1/usage` | `prompt.usage` | Prompt id, version number (internal — no body text, no confidential data) | `with check (user_id = auth.uid())`; the composite FK (SR-25) rejects a `version_no` that was never actually created |
| F-11 | Log a run to `toolbelt`'s shared spine | Browser, immediately after F-10 | `POST /rest/v1/rpc/log_run` (`Content-Profile: core`) | `toolbelt`'s `core.log_run` → `core.run` + `core.cost`, owned entirely by `toolbelt`'s own migration | App id, kind (`render`), measured wall-clock time — internal, no body text, no confidential data | `toolbelt`'s `core.log_run` is `security definer`, `user_id` still resolves to this caller's real `auth.uid()`; a call naming a bad `app_id` fails on the FK the same way a direct insert would (`toolbelt` T-I-003's guarantee, extended) |
| F-12 | Archive / restore a prompt | Browser, the Archive/Restore control | `PATCH /rest/v1/prompt` | `prompt.prompt` | `is_active` boolean (internal, DR-007) | Same `owner_all` RLS as F-5; grant is column-scoped to `is_active` only (SR-06). Display filter, not a security boundary (SR-28) |
| F-13 | Save / read a named configuration | Browser, the render panel's select and save controls | `GET`/`POST /rest/v1/configuration` | `prompt.configuration` | Variable values (DR-003, confidential — may name real systems), included section ids (internal) | `EXISTS`-through-parent RLS, same shape as F-9 (SR-29); grant is `SELECT`/`INSERT` only, no `UPDATE`/`DELETE` |
| F-14 | Render over the API (U-002, an agent acting for Kyle) | Any authenticated caller, not necessarily the browser page | `GET /rest/v1/rpc/render_prompt?p_name=...&p_config=...` | `prompt.prompt`, `prompt.configuration` (read-only) | Rendered body text (confidential — the same rules as F-8, just server-side) | `security invoker` — the RPC inherits the caller's own RLS, no new policy (SR-30); `EXECUTE` scoped to `authenticated` |

Render itself (FR-004/007/010, SL-002; optional sections FR-005, SL-003) stays a pure client-side transform over data F-4 already fetched — it opens no flow to the database and carries no confidential data anywhere. F-10 and F-11 (SL-007) are new and separate: both fire after a copy, not during render, and neither carries body text. Section ids are derived from the body at read time and never stored (DR-004) except when saved as part of a configuration (F-13). Tags (FR-012, SL-006) ride the same trust boundary as everything else: ownership checked through the parent row, cascade-deleted with it (SR-24). `core.run`/`core.cost` instrumentation (NFR-010) is done as of `SPEC-0009` (2026-08-07): F-11 is a function call, never a direct write against `core.*` — `SR-04`/`SR-27` are the mechanism that preserves the repository ownership boundary documented in `AGENTS.md`. F-12 (SL-011, SPEC-0010) is a display-only flag flip, carrying no confidential data and touching no other row. F-13 (SL-005, SPEC-0011) is the first flow to carry DR-003 (variable values) into storage — previously values existed only transiently in the DOM.

## 3. Data at rest

| Store | Contents | Classification | Retention | Encryption |
|---|---|---|---|---|
| `prompt.prompt` | Titles (DR-001, internal, globally unique case-insensitively), bodies (DR-002, **confidential**), owner ids (DR-006), active flag (DR-007, internal, SL-011) | per column | Forever — no `DELETE` grant exists at all; "deleting" a prompt sets `is_active` false and every row stays in place | At rest by Supabase |
| `prompt.prompt_version` | One immutable copy of `body` per insert and per distinct-value body edit (DR-002, **confidential**), owner id (DR-006) | per column | Forever — no `UPDATE` or `DELETE` grant or policy exists on this table at all, ever (NFR-005's mechanism) | At rest by Supabase |
| `prompt.tag` | Bare tag strings, no owner id of its own (DR-001-like, internal) | internal | Forever until the owning prompt is deleted (cascade) — no `DELETE` grant exists to remove a tag on its own | At rest by Supabase |
| `prompt.usage` | One row per copy: prompt id, version number, `config_name` (`null` until FR-008 ships), owner id (DR-005, internal) | internal | 365 days per DR-005, then aggregated to a monthly count — the aggregation job does not exist yet, same gap `toolbelt`'s own `core.event` retention has (its OOS-005) | At rest by Supabase |
| `prompt.configuration` | Named sets of variable values (DR-003, **confidential**) and included section ids (internal), per prompt | per column | Forever — no `DELETE` grant exists; not asked for by FR-008 | At rest by Supabase |
| `auth.users` | Kyle's account + two project-level test fixtures | internal | Until fixtures retire | Managed by Supabase |

Test fixture rows accumulate in `prompt.prompt`, `prompt.prompt_version`, `prompt.tag`, and now `prompt.usage` across suite runs (SPEC-0000 RISK-002, extended by SPEC-0002 RISK-002; accepted, cleaned by migrations' one-time dedups only, not routinely).

## 4. Secrets

| Secret | Where it lives | Where it must never go |
|---|---|---|
| Anon key | Page and test file, committed | Nowhere restricted; designed for client exposure, RLS is the boundary |
| Service-role key | Not in this repo | Never in this repo, any bundle, or history |
| Fixture passwords | Test file, committed | Accepted; project-level fixtures holding only test rows (SPEC-0000 ASM-002) |
| Kyle's password | Typed at sign-in | Never stored by the page, never committed |

## 5. Personal data

None beyond the account emails Supabase auth already holds. Prompt bodies are confidential business text, not PII; NFR-011 keeps them off every third party — this application sends them to its own database and nowhere else.

## Appendix: documentation self-check

- [x] Every flow names source, sink, transport, and authorization.
- [x] Every store names classification and retention.
- [x] The trust boundary is drawn with what crosses it.
- [x] Every secret names where it must never go.
- [x] Personal data enumerated or stated absent.
- [x] No unfilled placeholder remains.
