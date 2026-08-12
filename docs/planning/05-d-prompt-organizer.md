# 05-d. Prompt Organizer V1 Plan

Evidence date: 2026-08-12. Names per `00-canonical-names.md` ("prompt-layer" is retired; the component is Prompt Organizer). Realizes PO-1 through PO-5 of `03-v1-definition.md` under the ADR-03 auth model and the ADR complexity budget. Labels: `[VERIFIED: <path>]`, `[INFERRED]`, `[UNKNOWN]`.

## 0. Framing and hard requirement

The brief says Prompt Organizer "must become functional". It is functional today: 60/60 tests pass against live Supabase, the web client signs in, saves, tags, searches, renders with variables and optional sections, tracks versions, restores, archives, and logs usage [VERIFIED: 01-inventory.md section 6 suite table; 02-health-audit.md headline]. The correct V1 framing is a promotion: from a personal prompt library to the system's prompt store, serving the Brain, Idea Intake, LifeOS chat, and coding harnesses through a contract, not a browser tab.

**Hard requirement (operator-decided)**: All prompts must be stored and versioned in Prompt Organizer. This includes runtime-injected prompts, Brain operational prompts, LifeOS chat prompts, Idea Intake optimization prompts, test fixtures, coding harness system prompts, and review pass prompts. Application code may contain only minimal bootstrap or emergency fallback text (documented explicitly per component, e.g., "if Prompt Organizer is unavailable, use this fallback text for X"). No application code may contain a second prompt-management system. All prompt changes flow through Prompt Organizer's audit trail, versioning, and access control. This unifies prompt governance, eliminates split-brain risk, and enables version pinning for reproducibility.

## 1. Endpoint enumeration

### 1.1 Current API surface (the 10 client calls)

The client is PostgREST plus Supabase Auth; there is no bespoke server [VERIFIED: apps/toolbelt/apps/prompt-organizer/web/index.html:54-58]. Every call below is issued by the shipped web client:

| # | Method | Path (base `https://woltgcggxaehtuypkxqk.supabase.co`) | Purpose | Evidence |
| --- | --- | --- | --- | --- |
| 1 | POST | `/auth/v1/token?grant_type=password` | password sign-in, returns access token | [VERIFIED: web/index.html:200] |
| 2 | GET | `/rest/v1/prompt?select=id,title,body,is_active,tag(tag),prompt_version(version_no),configuration(name,values,sections)&order=created_at.desc&prompt_version.order=version_no.desc&prompt_version.limit=1` | list prompts with embedded tags, latest version, configurations | [VERIFIED: web/index.html:171-173] |
| 3 | GET | `/rest/v1/prompt_version?prompt_id=eq.<id>&select=version_no,body,created_at&order=version_no.desc` | version history | [VERIFIED: web/index.html:89] |
| 4 | PATCH | `/rest/v1/prompt?id=eq.<id>` body `{body}` | restore a prior version (trigger records a new version) | [VERIFIED: web/index.html:98] |
| 5 | PATCH | `/rest/v1/prompt?id=eq.<id>` body `{is_active}` | archive / unarchive | [VERIFIED: web/index.html:124] |
| 6 | POST | `/rest/v1/prompt` body `{title, body}` | create prompt | [VERIFIED: web/index.html:221-223] |
| 7 | POST | `/rest/v1/tag` bulk array | attach tags | [VERIFIED: web/index.html:227-229] |
| 8 | POST | `/rest/v1/configuration` | save render configuration | [VERIFIED: web/panel.mjs:71-72] |
| 9 | POST | `/rest/v1/usage` | record a copy event | [VERIFIED: web/panel.mjs:112] |
| 10 | POST | `/rest/v1/rpc/log_run` with `Content-Profile: core` | timing row into toolbelt `core.log_run` | [VERIFIED: web/panel.mjs:115-117] |

One additional server-side surface exists that the web client does not call: `POST /rest/v1/rpc/render_prompt`, exercised by the node suite [VERIFIED: tests/render-endpoint.test.mjs; migration 20260808120000].

### 1.2 V1 API surface

Decision: keep PostgREST as the API. The table grants ARE the request contract; RLS is the authorization boundary [VERIFIED: apps/toolbelt/AGENTS.md product boundaries]. V1 adds exactly one new RPC (`get_prompt`, the injection path) and re-pins RLS per ADR-03. No bespoke service is built; the complexity budget's zero-new-database and deployable-unit ceilings are untouched.

| Endpoint | Method(s) | Request contract (grants) | Response contract | Auth (ADR-03) | Latency budget (warm, p50/p95) |
| --- | --- | --- | --- | --- | --- |
| `/rest/v1/prompt` | GET, POST, PATCH | select: any column; insert: `title` (1..200, unique lower), `body` (1..100000); update: columns `title,body,is_active` only [VERIFIED: migrations 20260807020000:10-18, 20260807040000:24, 20260808000000:4] | rows of `prompt.prompt`; PostgREST error JSON otherwise | owner JWT; RLS pinned to owner UUID (section 2) | 50 ms / 120 ms |
| `/rest/v1/prompt_version` | GET, POST | select + insert only; no UPDATE or DELETE grant exists, which is the immutability mechanism [VERIFIED: migration 20260807040000:37; AGENTS.md append-only rule] | rows keyed `(prompt_id, version_no)` | owner JWT | 50 ms / 120 ms |
| `/rest/v1/tag` | GET, POST | add-and-filter only [VERIFIED: toolbelt inventory, migration 20260807050000] | rows `(prompt_id, tag)` | owner JWT | 50 ms / 120 ms |
| `/rest/v1/usage` | GET, POST | append-only, composite FK to version [VERIFIED: migration 20260807070000] | usage rows | owner JWT | 50 ms / 120 ms (fire-and-forget on the copy path, never blocking [VERIFIED: panel.mjs:110-112 comment]) |
| `/rest/v1/configuration` | GET, POST | PK `(prompt_id, name)`, `values` jsonb, `sections` text[] [VERIFIED: migration 20260808100000] | configuration rows | owner JWT | 50 ms / 120 ms |
| `/rest/v1/rpc/render_prompt` | POST | `{p_name, p_config?}`; EXECUTE granted to `authenticated` only [VERIFIED: migration 20260808120000:62-63] | rendered text; `PT404` / `PT422` errors | owner JWT (security invoker, caller's RLS) | 60 ms / 150 ms (PO-2) |
| `/rest/v1/rpc/get_prompt` (NEW, section 6) | POST | `{p_name, p_version?, p_config?, p_values?, p_sections?}` | jsonb `{text, version_no, rendered_at}`; `PT404` / `PT422` | owner JWT or scoped agent token (ADR-03) | 60 ms / 150 ms (PO-2) |
| `/auth/v1/token?grant_type=password` | POST | Supabase Auth | session | RETIRED for the UI (section 2); remains for CI token minting against the fenced test schema only | n/a |

Contract fragments for the two non-trivial endpoints (OpenAPI-style, planning contract only):

```yaml
/rest/v1/rpc/render_prompt:
  post:
    summary: Render the active prompt named p_name using a saved configuration.
    requestBody:
      application/json:
        schema:
          type: object
          required: [p_name]
          properties:
            p_name:   { type: string, description: "matched case-insensitively against prompt.title" }
            p_config: { type: string, nullable: true, description: "saved configuration name" }
    responses:
      "200": { content: { application/json: { schema: { type: string } } } }
      "404-class": { description: "errcode PT404: prompt or configuration not found" }
      "422-class": { description: "errcode PT422: missing variables, names listed in message" }
    # Existing behavior [VERIFIED: migration 20260808120000: PT404 at :24-26,:31-33; PT422 at :54-55]

/rest/v1/rpc/get_prompt:   # NEW in V1, one migration
  post:
    summary: Injection API. Resolve name@version, render, return text plus provenance.
    requestBody:
      application/json:
        schema:
          type: object
          required: [p_name]
          properties:
            p_name:     { type: string }
            p_version:  { type: integer, nullable: true, description: "null resolves to latest; pinned reads prompt_version body" }
            p_config:   { type: string, nullable: true }
            p_values:   { type: object, nullable: true, description: "ad-hoc variable values, merged over p_config values" }
            p_sections: { type: array, items: { type: string }, nullable: true, description: "overrides p_config sections when present" }
    responses:
      "200":
        content:
          application/json:
            schema:
              type: object
              required: [text, version_no, rendered_at]
              properties:
                text:        { type: string }
                version_no:  { type: integer }
                rendered_at: { type: string, format: date-time }
      "404-class": { description: "PT404: name or pinned version not found" }
      "422-class": { description: "PT422: missing variables after merge" }
```

`render_prompt` stays untouched for backward compatibility with its four existing endpoint tests [VERIFIED: tests/render-endpoint.test.mjs]; `get_prompt` supersedes it for all new consumers and adds the three things injection needs that `render_prompt` lacks: version pinning, ad-hoc values, and provenance in the response [VERIFIED: migration 20260808120000 signature takes only `p_name, p_config` and returns bare text].

## 2. Auth (ADR-03 integration)

Current model [VERIFIED: 01-inventory.md section 5]: committed anon key + password-grant sign-in with fixture users shared with the toolbelt root; RLS policy `owner_all` scopes rows to `auth.uid()` generically [VERIFIED: migration 20260807020000:22-25], so any authenticated fixture user can write live rows (SEC-03).

V1 changes, in ADR-03's exact terms:

1. RLS re-pin. Every `prompt.*` policy moves from `user_id = auth.uid()` to owner-UUID pinned: `user_id = '<owner-uuid>' and auth.uid() = '<owner-uuid>'` [per ADR-03 single-principal design]. One migration pair rewrites the five tables' policies; behavior for the owner is identical, and fixture users lose all access to the live `prompt` schema.
2. UI session comes from the Shell. The password-grant sign-in form retires; the client obtains its session from `packages/platform-client` (ADR-03 session propagation). The anon key itself remains in the client as the PostgREST `apikey` header, which is public by design [VERIFIED: config.mjs safe-to-commit comment]; only the sign-in form and its token fetch are deleted.
3. Fixture users are fenced to a dedicated test schema per the Phase 6 consolidation plan; CI keeps pre-minting tokens via `export-test-sessions.mjs` [VERIFIED: tests/export-test-sessions.mjs] but those tokens can no longer touch owner data. This retires SEC-03 as scheduled by ADR-03.

Agent access (the Brain, Idea Intake) presents a scoped token per ADR-03's service-to-service rule and may EXECUTE `get_prompt` only; no table grants are extended to agent principals.

## 3. Category taxonomy and starter prompts (PO-4)

The taxonomy is derived from the actual consumers this system has or is building, not from a generic prompt-library shape. Eight categories:

| Category (namespace prefix) | Consumer that justifies it | Example starter prompt |
| --- | --- | --- |
| `brain/` | The Brain's orchestration loop: task contracts, dispatch, verdict parsing (`07-brain-architecture.md`) | `brain/task-contract` |
| `coding/system` | Harness system prompts injected into ACC-launched Claude Code sessions [VERIFIED: ACC spawns `claude`, 01-inventory.md section 2] | `coding/system/kernel-run` |
| `coding/review` | Review passes the harnesses already run (netcheck `check.sh` runs code_simplification and security_review passes [VERIFIED: toolbelt inventory]) | `coding/review/simplification` |
| `planning/spec` | Issue and spec drafting; the repo's whole delivery workflow starts from Issues [VERIFIED: AGENTS.md working model] | `planning/spec/issue-outcome` |
| `intake/optimize` | Idea Intake's optimization step (`05-h-idea-intake.md`) | `intake/optimize/idea` |
| `lifeos/chat` | LifeOS chat SSE system prompt, today hardcoded backend-side [VERIFIED: lifeos src/api/chat.py, default model claude-opus-5] | `lifeos/chat/system` |
| `research/` | Research and summarization tasks run through the general-purpose handler (`08`) | `research/deep-dive` |
| `ops/runbooks` | Operational prompts: incident triage, deploy verification, backup restore drills (LifeOS runbook culture [VERIFIED: backend/docs runbook.md]) | `ops/runbooks/deploy-verify` |

Rejected candidates: a separate `writing/` category folds into `research/` until a real consumer exists (no component in the inventory consumes writing prompts); per-app categories for Network Checker and Guards are premature because neither makes LLM calls today [VERIFIED: 01-inventory.md: LifeOS backend is the only LLM API consumer; netcheck synthesis is an unwired stub].

Seed mechanism (migration spec, not code): one migration pair `2026xxxxxx_prompt_seed_starters.sql` inserting, as the owner UUID, at least one active prompt per category above, `on conflict (lower(title)) do nothing` so re-runs and pre-existing personal prompts are safe; the down migration deletes exactly the seeded titles. Seed bodies use the existing `{{VAR}}` and `<!--OPTIONAL:id-->` model (section 8). PO-4 verification query: group count of active prompts by namespace prefix, minimum 1 per category.

## 4. Speed: read-path budgets and caching

Prompts inject on hot paths (every Brain dispatch, every LifeOS chat turn), so the read path carries explicit budgets. The existing performance suite already asserts 100 ms-class budgets client-side: render p95 under 100 ms at the 100,000-character body ceiling, search p95 under 300 ms at 1,000 prompts [VERIFIED: tests/performance.test.mjs:7-9,42-52].

| Path | p50 | p95 | Enforced by |
| --- | --- | --- | --- |
| `rpc/render_prompt` and `rpc/get_prompt` (warm client, network included) | 60 ms | 150 ms | PO-2 suite: p95 over 50 calls [VERIFIED: 03-v1-definition.md PO-2] |
| Raw fetch (`GET /rest/v1/prompt` single row by title) | 50 ms | 120 ms | same suite, raw-fetch case |
| Client-side pure render at max body size | n/a | 100 ms | existing `performance.test.mjs` stays green |
| Cache hit in `packages/llm` | under 1 ms | 5 ms | injection client unit test |

Caching strategy, specified exactly (lives in `packages/llm`, ADR-01 target tree):

- Cache key: `name@version_no`. A pinned-version entry is immutable forever because `prompt_version` has no UPDATE or DELETE grant [VERIFIED: migration 20260807040000:37]; it is cached for process lifetime, capacity-bounded LRU (default 128 entries).
- `name@latest` resolution is the only mutable lookup. It is cached with a 60-second TTL. On TTL expiry the client revalidates with the cheapest possible query, `GET /rest/v1/prompt_version?prompt_id=eq.<id>&select=version_no&order=version_no.desc&limit=1`; `version_no` serves as the ETag equivalent (PostgREST offers no native ETag [INFERRED: PostgREST response headers carry none for these queries]). Unchanged `version_no` means the cached template body is reused with zero body transfer; changed means one full fetch and cache replace.
- Rendering happens client-side from the cached template (the pure `render()` model, section 8) whenever `variables`/`sections` are supplied per-call, so a cache hit never touches the network; `rpc/get_prompt` is the fallback for consumers without the client package (PO-5's schema-free path).
- Invalidation rules: (1) pinned entries never invalidate; (2) `@latest` entries invalidate on TTL expiry or on an explicit `invalidate(name)` call after the consumer itself writes a new version; (3) process restart clears everything; no cross-process cache bus is built (single operator, complexity budget).

## 5. Storing ALL prompts: naming, collisions, pinning, and the dissent flag

Design consequences of making this the system-wide store:

- Naming convention: system prompts use namespace paths in `title`, grammar `^[a-z0-9-]+(/[a-z0-9-]+){1,2}$` (examples: `brain/task-contract`, `lifeos/chat/system`). The existing `title` column carries this unchanged (CHECK 1..200 holds [VERIFIED: migration 20260807020000:10]); legacy personal titles remain valid and simply live outside the namespace grammar. The convention is enforced by the seed migration and a lint check in the contract suite, not by a new CHECK constraint (avoids breaking existing personal rows).
- Collision rule: already enforced by the database, `unique index on lower(title)` [VERIFIED: migration 20260807040000:17]. Case-insensitive uniqueness is the collision contract; namespaces make accidental collisions structurally unlikely.
- Rename rule: a namespaced prompt's name is its API. Renaming a prompt that consumers pin breaks them silently, so the UI refuses title edits on namespaced prompts (section 10); create-new-and-archive-old is the rename path.
- Version-pinning contract for consumers: a consumer requests `name@version` (integer `version_no`) for reproducible behavior, or `name@latest` for tracking. The Brain pins versions in its task contracts (a run's prompt provenance is part of its record, BR-5 adjacency); interactive surfaces (LifeOS chat) track `@latest`.
- Counterargument, flagged to `13-dissent.md`: repo-adjacent prompts (harness system prompts, review-pass prompts) arguably belong in git next to the code they steer, where they version with the code, diff in PRs, and need no network on the hot path. V1 keeps them in the store for one-place discoverability and runtime updatability, but the dissent register must carry the opposing position and its trigger: if prompt changes start requiring lockstep code changes more often than not, move those categories to git and keep the store as the registry of record.

## 6. Injection API

TypeScript contract (the shape is the contract; implementation is Phase 11 work):

```ts
// packages/llm
export type GetPromptOptions = {
  version?: number;                    // omit = latest
  variables?: Record<string, string>;  // merged over the named config's values
  sections?: string[];                 // overrides the named config's sections
  config?: string;                     // saved configuration name
};

export type RenderedPrompt = {
  text: string;        // fully rendered, no unresolved {{VAR}} remains
  version: number;     // the version_no actually used
  renderedAt: string;  // ISO 8601
};

export function getPrompt(name: string, opts?: GetPromptOptions): Promise<RenderedPrompt>;
// Throws PromptNotFoundError (PT404) | MissingVariablesError (PT422, .missing: string[])
```

Transport: server-side consumers (the Brain, LifeOS backend, Idea Intake) call PostgREST `rpc/get_prompt` directly with their scoped token; TypeScript consumers use the `packages/llm` client, which wraps the same RPC plus the section 4 cache and client-side rendering. No consumer ever holds `prompt` schema knowledge; the RPC name and this type signature are the entire published contract, which is exactly PO-5's requirement. Caching and invalidation are as specified in section 4; failure mode is fail-fast with the typed errors above, and consumers on hot interactive paths (LifeOS chat) are expected to pin a fallback prompt constant for IdP or store outage [INFERRED: ADR-03 fail-closed posture applied to this path].

## 7. Versioning: mostly exists

The existing model already satisfies immutability and rollback:

- Immutability by absent grants: `prompt_version` has select and insert only; no UPDATE or DELETE grant exists anywhere in the schema's history [VERIFIED: migration 20260807040000:37; AGENTS.md: "Keep prompt.prompt_version and prompt.usage append-only"].
- Every body write records a version: trigger `record_version` fires AFTER INSERT OR UPDATE OF body, skipping no-ops [VERIFIED: toolbelt inventory migration 2 description].
- Rollback: restore PATCHes the prior body onto `prompt.prompt`, which the trigger records as a NEW version; history is never rewritten [VERIFIED: web/index.html:98; tests/restore.test.mjs].

Verdict: no draft/published state machine is added in V1. Every stored version is "published" in the only sense that matters for a single operator; a draft layer would add a state column, policy changes, and UI for a workflow with no second principal to protect. The one small delta that remains: `get_prompt` must resolve pinned versions from `prompt_version.body` rather than `prompt.body` (section 6), and PO-3's suite gains one rollback-visibility assertion (restore produces a new max `version_no`).

## 8. Variable and template model

The existing model is declared the system standard, unchanged:

- Variables: `{{NAME}}`, grammar `[A-Z_][A-Z0-9_]*` [VERIFIED: web/render.mjs:2 TOKEN_RE].
- Optional sections: `<!--OPTIONAL:id-->` ... `<!--/OPTIONAL:id-->`, ids `[A-Za-z0-9_-]+`, linear-time pairing, unmatched fences stay literal [VERIFIED: web/render.mjs:9,19-42].
- Semantics: sections resolve before variable extraction, so a variable inside an excluded section is not required; missing variables refuse the whole render, never a partial substitution [VERIFIED: web/render.mjs:102-111]; the server RPC mirrors both rules [VERIFIED: migration 20260808120000:36-56].

V1 extension: none. Defaults per variable and environment-scoped values were considered and rejected: defaults hide missing-variable errors that the refuse-on-missing contract deliberately surfaces, and environment scoping has zero consumers in a single-environment, single-operator system (candidate row in section 9 records the cost anyway). Keeping the model frozen keeps the pure `render()` and the SQL RPC provably equivalent, which two test suites already assert [VERIFIED: tests/render.test.mjs; tests/render-endpoint.test.mjs].

## 9. Additional capabilities, ranked (forced decision 12)

Value scored against the consumers in section 3; cost in LOC ballpark including tests and migrations.

| Rank | Capability | Value | Cost | V1 verdict |
| --- | --- | --- | --- | --- |
| 1 | Usage telemetry surfaced | High: pinpoints which prompts earn their keep; the `usage` table already exists and is written on every copy [VERIFIED: migration 20260807070000; panel.mjs:112] | S (~60 LOC: one embedded count in the list query + a count badge) | SHIP: mostly exists, finish the last mile |
| 2 | Token cost per prompt | Medium: budget awareness before a prompt rides a hot path | S (~30 LOC: chars/4 heuristic on the rendered preview, clearly labeled an estimate) | SHIP: trivially cheap |
| 3 | Diff view between versions | Medium: restore confidence | M (~150 LOC client-side diff) | DEFER: restore already shows full bodies |
| 4 | Prompt linting (unbalanced fences, undeclared vars) | Medium: seed-quality guard | M (~120 LOC; partially exists as refuse-on-missing) | DEFER; the contract suite's naming lint (section 5) covers the V1 need |
| 5 | Composition / includes | Medium-low: no consumer requests it yet | M-L (~250 LOC + recursion and cycle rules in two renderers) | DEFER: breaks the frozen template model |
| 6 | Environment-scoped overrides | Low: one environment exists | M (~200 LOC + schema) | DEFER |
| 7 | A/B comparison | Low until telemetry accumulates | L (~400 LOC + experiment bookkeeping) | DEFER, per `03-v1-definition.md` deferred table |
| 8 | Eval-linked prompts | Low until the Brain's eval harness exists (`07`) | L (~500+ LOC, cross-component) | DEFER, same table |

V1 additions are exactly ranks 1 and 2. This is deliberately conservative: the store's V1 job is to be fast, contractual, and seeded, not feature-rich.

## 10. Defect fixes

- D-12 (e2e flakiness is structural: one shared fixture account "intentionally contains many other prompts", live Auth latency and 429s, `retries: 0`) [VERIFIED: 02-health-audit.md D-12; tests/e2e/critical-flow.test.mjs:83-86]. Fix in two layers: (1) immediately, per-run namespacing: every e2e-created row is titled `e2e/<run-id>/...` and the spec asserts only within its own namespace, deleting nothing and colliding with nothing; (2) structurally, the Phase 6 test-schema fence gives e2e a dedicated account whose data set is empty at run start. `retries: 0` stays; the fix removes the flakiness source instead of masking it.
- Missing edit UI despite the `update (title, body)` grant [VERIFIED: 02-health-audit.md gap register; migration 20260807040000:24]. Decision: ship a body-edit UI. Rationale: a system prompt store whose only body-change path is restore gymnastics fails its consumers; the trigger already versions every body update, so edit is safe by construction [VERIFIED: record_version fires on UPDATE OF body]. Title editing is refused in the UI for namespaced prompts (section 5 rename rule) and permitted for legacy personal prompts. Cost ~120 LOC including tests.

## 11. EARS acceptance criteria (realizing PO-1..PO-5)

| # | Criterion (EARS) | Verification command |
| --- | --- | --- |
| PO-1a | The system shall serve every endpoint in the section 1.2 table per its stated contract and auth requirement. | `node --test tests/contract.test.mjs` (new suite; one case per table row) exits 0 |
| PO-1b | If a request presents a token whose subject is not the owner UUID, then the system shall return zero rows and refuse writes on every `prompt.*` table. | fixture-token case inside `tests/contract.test.mjs`: assert empty select and 4xx on insert |
| PO-2 | The read path used for prompt injection shall return a rendered prompt in at most 150 ms p95 from a warm client. | `node --test tests/performance.test.mjs` extended: p95 over 50 `rpc/get_prompt` calls asserted under 150 ms |
| PO-3 | Published prompt versions shall be immutable, and rollback shall restore any prior version as a new version. | `node --test tests/versions.test.mjs tests/restore.test.mjs` including the new max-`version_no` rollback assertion |
| PO-4 | Starter prompts shall exist for every category in the section 3 taxonomy. | seed-verification query in `tests/seed.test.mjs`: count of active prompts grouped by namespace prefix, each of the 8 categories >= 1 |
| PO-5 | When another component requests a prompt by name through the injection API, the system shall serve it without that component holding schema knowledge. | scratch script using only the published `getPrompt` contract (no table names) prints `text` and `version`; run from `packages/llm/examples/`, exit 0 |
| PO-5b | While a prompt is cached at a pinned version, the client shall serve repeat requests without a network call. | `node --test packages/llm/tests/cache.test.mjs`: second call asserted zero fetches via injected transport spy |
| D-12 | When the e2e suite runs twice concurrently, both runs shall pass. | two parallel `npx playwright test` invocations with distinct run ids; both exit 0 |

## 12. LOC deltas and deletion list

| Change | LOC delta (estimate) |
| --- | --- |
| Migration pair: RLS owner-UUID re-pin (5 tables) | +90 SQL |
| Migration pair: `get_prompt` RPC | +110 SQL |
| Migration pair: starter seed (8 categories) | +160 SQL |
| `packages/llm` prompt client (getPrompt, cache, errors) + tests | +280 TS |
| Contract suite + seed suite + PO-2 extension | +220 JS |
| Body-edit UI + tests | +120 JS |
| Usage count badge + token estimate | +90 JS |
| E2E per-run namespacing | +40 JS |
| Deletions (below) | -70 |
| Net | ~ +1,040 |

Deletion list:

- Password-grant sign-in form and its token fetch in `web/index.html` (~50 lines) once the Shell session lands; the committed anon key itself stays (it is the public PostgREST `apikey`, not a credential [VERIFIED: config.mjs comment]).
- Generic `owner_all`-style policies (replaced, not accreted, by the pinned policies; down migrations restore them).
- Fixture-user write access to the live `prompt` schema (revoked by the re-pin; the SEC-03 retirement).

## Gate questions (batched, non-blocking)

1. Section 3 seeds `lifeos/chat/system`, but LifeOS's chat system prompt currently lives in backend code [VERIFIED: src/api/chat.py]. Confirm the operator wants LifeOS to consume it from the store in V1 (a `05-e` / `08` coordination point) or keep the seed as the canonical copy until then.
2. The rename-refusal rule (section 5) is UI-level; the `update(title)` grant remains for legacy prompts. If the operator prefers database-level enforcement, one trigger (~20 SQL lines) pins titles matching the namespace grammar; say so before Phase 11 issues are cut.
3. Cache TTL for `name@latest` is set to 60 s; any value from 30 s to 5 min is defensible. Objection window closes at the gate.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (contracts, DDL-level specs, and type signatures only)
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: PASS (PostgREST kept: zero migration cost, Supabase lock-in already accepted in ADR-03/04; no new technology introduced)
- Machine-verifiable acceptance criteria: PASS (section 11, each with a command)
- LOC delta reported: PASS (section 12, ~ +1,040 net)
- Deletion list present: PASS (section 12)
- Latency budgets stated: PASS (section 4 table; PO-2 inherited)
- Questions batched: PASS (3, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none (no new deployable unit, runtime, database, or auth flow)
