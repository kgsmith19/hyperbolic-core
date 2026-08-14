# 08. LLM Handling Architecture

Resolves forced decisions 5 (one handler or two), 6 (build or adopt the routing layer), and 7 (whether the general-purpose handler lives in Toolbelt). Dependencies: ADR-01 (placement), ADR-03 (auth), ADR-05 (key isolation), `07-brain-architecture.md` (the Brain's provider needs), `05-h` (Idea Intake is the first non-LifeOS consumer). Labels per the charter.

## 1. Consumers and their real V1 needs (grounding)

| Consumer | Needs in V1 | Key domain |
| --- | --- | --- |
| The Brain | planner/synthesis calls, streaming, tool use, schema-validated output | the Brain key, isolated (ADR-05) |
| Idea Intake | prompt-driven idea optimization calls (server-side; a browser cannot hold a provider key) | general-purpose keys |
| Prompt Organizer | token-count estimates per prompt (05-d capability verdict) | none required (client-side estimator acceptable) or general keys for exact counts |
| LifeOS | chat SSE, bill extraction, priorities import, already implemented with its own Anthropic SDK usage [VERIFIED: chat.py; extract.py] | its existing key; V1 does not migrate it |
| Coding harnesses | their own credentials (Claude Code subscription session, Codex/Gemini own auth) | never through any handler |

## 2. Both sides argued (required analysis)

**One shared handler with a policy layer.** Single code path, one logging pipeline, one place for retry/fallback; every consumer inherits improvements. Exact coupling cost: a single deployed process would hold both the general keys and the Brain key, so any consumer-triggered code path shares an address space with the Brain key. That is precisely what ADR-05 forbids structurally ("never readable by any other component", enforced by process and identity boundaries, not convention). A policy layer inside one process is convention, not structure. One handler therefore fails the hard requirement, not the taste test.

**Two independent handlers.** Clean key isolation. Exact duplication cost if independently written: the provider abstraction is the expensive part (request/response/streaming/tool-use normalization, error taxonomy, retry/backoff, rate-limit handling): roughly 900 to 1,300 LOC duplicated, times ongoing provider-API drift maintenance in two places (every provider change patched twice; historically the costliest kind of duplication).

**Resolution: split the abstraction from the deployment.** The duplication the brief feared lives in the abstraction; the isolation the brief demands lives in the deployment. Ship the abstraction once as a library and deploy it twice with different keys.

## 3. Decisions

**Forced decision 5: one provider library, two handler instances.** `packages/llm` is the single provider abstraction (contracts, drivers, retry, taxonomy; it handles no key storage). Handler A is a small deployed service (`services/llm-handler`) wrapping the library with the general-purpose keys, HTTP surface, and Supabase logging. Handler B is not a service at all: the Brain links the same library in-process inside its own container with only the Anthropic driver and the isolated Brain key (07 already specifies this). Two handlers as independently coded services: rejected. One shared handler service: rejected on ADR-05 grounds stated above. Duplication cost of the chosen shape: approximately zero (one library); coupling cost: the library's contracts are shared, so a breaking contract change touches both consumers; accepted, that is what contracts are for.

**Forced decision 6: build, do not adopt.** Evaluated adoption candidate: a self-hosted LLM proxy (LiteLLM-class). Maturity cost: low, mature and active. Migration cost: moderate (its config dialect, its deployment). Lock-in: proxy request/response semantics and config format woven into every consumer. Ecosystem gaps for this system: it is another deployable unit with its own secrets file (keys concentrated in one process again, recreating the ADR-05 problem), its own auth boundary to integrate with ADR-03, and per-provider feature lag on the exact features the Brain cares about (strict tool schemas, prompt caching controls). At single-operator volume the proxy's value (quota pooling, many-team routing) is unused. Build cost of `packages/llm`: ~1,100 LOC for Anthropic complete plus OpenAI and Gemini text-and-basic-tools drivers, reusing the retry discipline already proven in `hooks/lane.mjs` [VERIFIED: transport-only, full-jitter]. The boring option here is the small library, and it wins. **Reversal trigger:** a fourth provider, or a second human consumer with quota pooling needs, or provider-drift maintenance exceeding one day per month sustained across a quarter; the successor is the proxy, adopted behind the same `packages/llm` client contract so consumers do not change.

**Forced decision 7: the general-purpose handler does not live in Toolbelt.** Handler A's code lives at `services/llm-handler` (ADR-01 tree); it registers in the tool registry as a `headless` tool (05-c manifest kind) so the Shell can discover and health-check it, which satisfies the brief's "possibly homed in Toolbelt, possibly headless" instinct without putting platform infrastructure inside a product app. It has no UI. Deployable-unit accounting: Handler A takes the fourth and final budget slot (units: LifeOS, Shell, Brain, Handler A = 4 of 4; the ADR-07 Caddy reserve is displaced, and that displacement is accepted and recorded here per the budget rule).

## 4. Provider abstraction (the library contract)

```ts
// packages/llm: types only shown; no key handling in this package.
type Provider = "anthropic" | "openai" | "gemini";

interface LlmRequest {
  provider: Provider;
  model: string;                       // never defaulted silently
  messages: Message[];                 // system/user/assistant/tool parts
  tools?: ToolDef[];                   // JSON Schema per tool
  toolChoice?: "auto" | "none" | { name: string };
  maxTokens: number;
  temperature?: number;
  stream?: boolean;
  metadata: { callerApp: string; purpose: string; runRef?: string }; // logging spine
  timeoutMs: number;                   // hard wall per attempt
}

interface LlmResponse {
  text: string | null;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "refusal";
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  provider: Provider; model: string; latencyMs: number;
}

// Streaming contract: an async iterable of typed deltas.
type LlmDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; partial: ToolCallDelta }
  | { kind: "usage"; usage: LlmResponse["usage"] }
  | { kind: "done"; response: LlmResponse };

interface LlmError extends Error {
  class: "auth" | "rate_limit" | "overloaded" | "transport" | "invalid_request" | "content_policy" | "provider_bug";
  retryable: boolean;                  // true only for rate_limit | overloaded | transport
  retryAfterMs?: number;               // honored when the provider sends it
}
```

- Retry and backoff: retryable classes only; full-jitter exponential (base 2 s, cap 30 s, max 2 retries), `retryAfterMs` respected verbatim; never retry `invalid_request` or `content_policy`; mirrors the proven lane discipline [VERIFIED: hooks/lane.mjs policy notes].
- Timeouts: per-attempt `timeoutMs` mandatory; stream stall timeout (no delta for 60 s) aborts as `transport`.
- Rate-limit handling: 429 maps to `rate_limit` with header passthrough; the Handler A service additionally applies a per-caller concurrency cap (default 2) so one consumer cannot starve another.
- Fallback routing: explicit only. A request may carry `fallback: [{provider, model}]`; the library fails over on retryable exhaustion only, never for schema-sensitive tool calls (a fallback across providers with tools attached is an `invalid_request` at the library boundary). Silent cross-provider fallback is forbidden; the response always names the provider that answered.

## 5. Handler A service surface

| Route | Contract | Auth (ADR-03) | Latency budget |
| --- | --- | --- | --- |
| `POST /v1/complete` | `LlmRequest` minus provider keys; response `LlmResponse` | operator session JWT or scoped agent token (`llm:call`) | overhead <= 30 ms p95 over direct provider call |
| `POST /v1/stream` | same, SSE of `LlmDelta` | same | TTFB <= provider + 50 ms |
| `POST /v1/count` | `{model, messages}` returns token estimate | same | 50 ms p95 |
| `GET /healthz` | `{ok, providers: {probe results}}` | tailnet only | 100 ms |

Configuration keys (skeleton): `LLM_HANDLER_PORT`, `LLM_KEYS_ANTHROPIC`, `LLM_KEYS_OPENAI`, `LLM_KEYS_GEMINI` (injected from Infisical `/platform/llm/`, ADR-05), `LLM_LOG_DSN` (platform project), `LLM_MAX_CONCURRENCY_PER_CALLER`. The service has no configuration key for the Brain key; its Infisical identity cannot read `/brain/` (structural isolation, verified by BR-3/II-4 acceptance checks in `03-v1-definition.md`).

## 6. Logging schema and cost attribution

One table in the platform project, `core.llm_call` (core is the cross-tool telemetry schema per 06's namespacing rule):

```sql
create table core.llm_call (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  caller_app text not null,            -- registry id: idea-intake, brain, shell, ...
  purpose text not null,               -- free taxonomy: optimize-idea, plan, eval, ...
  run_ref text,                        -- brain run/task id or app-local ref
  provider text not null check (provider in ('anthropic','openai','gemini')),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  usd_estimate numeric(10,4),
  latency_ms integer,
  status text not null check (status in ('ok','error')),
  error_class text
);
```

- Writers: Handler A directly; the Brain mirrors its in-process calls here through its existing core-schema telemetry path (7.6), so cost attribution is uniform.
- Attribution model: per `caller_app` and per `run_ref`; the dashboard query is a group-by, no new machinery. Rates table pattern for `usd_estimate` follows ACC's attribution-only convention [VERIFIED: policy.json rates note].
- Retention: monthly aggregate plus purge after 180 days via the existing pg_cron pattern [VERIFIED: core.event retention migration]; 06 carries the DDL placement.

## 7. Key isolation summary (structural, restated once)

| Key | Lives | Readable by | Enforced by |
| --- | --- | --- | --- |
| Brain key | Infisical `/brain/`, injected only into the Brain container env | Brain process only | per-path machine identities, container/OS-user boundary, no code path in Handler A or `packages/llm` that names it |
| General provider keys | Infisical `/platform/llm/`, injected only into Handler A env | Handler A only | same mechanism, disjoint path |
| LifeOS Anthropic key | Infisical lifeos env (existing) | LifeOS backend only | existing pipeline [VERIFIED: ci.yml deploy env rendering] |

`packages/llm` never stores, reads, or defaults a key; drivers receive credentials per call from their host process.

## 8. LOC and deletion accounting

| Item | LOC |
| --- | --- |
| `packages/llm` (contracts, 3 drivers, retry, taxonomy) | ~1,100 added |
| `services/llm-handler` (HTTP surface, auth, logging, config) | ~700 added |
| `core.llm_call` DDL + retention | ~60 added (06 owns placement) |
| Deletions | none in V1 (LifeOS migration onto Handler A is deferred; its direct SDK usage stays) |

## Gate questions (batched, non-blocking)

1. Handler A takes the final deployable-unit slot, displacing the ADR-07 Caddy reserve. If the operator prefers keeping that reserve, the alternative is deferring Handler A to a Supabase Edge Function for Idea Intake only (cost: a new runtime, Deno, breaching the runtime ceiling instead). The recommendation stands; flagging the displacement explicitly.
   **Timing note (m3-06):** Handler A's deployable-unit skeleton (Dockerfile, compose.yaml, deploy.yml jobs, its own Infisical identity/path) was pulled forward and built by m3-06 rather than m4-05, to give Idea Intake's submit API (05-h) a real place to run once Shell turned out to be static-only. Unit count and this displacement are unchanged (still 4 of 4, still this same decision) -- only the calendar timing moved. m4-05's remaining scope is now exactly section 5's routes (/v1/complete, /v1/stream, /v1/count) plus core.llm_call logging, added to an already-existing service rather than one built from scratch.
2. Exact `usd_estimate` rates: propose reusing ACC's rates-table convention seeded from list prices, updated manually; confirm no need for billing-API integration in V1.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (type signatures, SQL DDL, route tables only)
- Canonical names used exclusively: PASS
- Recommendations name maturity/migration/lock-in/ecosystem: PASS (build-vs-adopt in section 3)
- Acceptance criteria: inherited (BR-3, II-4, PO token counts); verification commands live in 03
- LOC delta reported: PASS (section 8)
- Deletion list: PASS (none, stated with reason)
- Latency budgets stated: PASS (section 5)
- Questions batched: PASS (2)
- Zero em dashes: PASS
- Complexity budget: unit count now 4 of 4 with the displacement recorded; runtime and database ceilings intact
