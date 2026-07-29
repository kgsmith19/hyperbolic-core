# A2: Grounded chat with citations — design (ADR-011)

Approved 2026-07-28. Roadmap Slice 2 (milestone A). Out of scope: writes,
proactive anything, embeddings, calendar, LiteLLM (triggers recorded in
ADR-011). A2.5 rider (daily_checkin type) only if green with time left.

## Shape

One new deployable-free feature per ADR 009: the chat loop lives inside the
existing FastAPI app. The lifeos-ui SPA gets a `/chat` page. One branch + PR
per repo; merge on green deploys both.

## Backend (lifeos, interface cell)

- **Shared agent-tool surface.** Factor the four provenance-wrapped read
  tools out of `src/mcp_server/server.py` into `src/mcp_server/tools.py`:
  `list_types(ctx)`, `find(ctx, ...)`, `get_entity(ctx, id)`,
  `history(ctx, id)` — each returns `{payload..., provenance}` exactly as
  today. `server.py` keeps the MCP registration and token verification and
  becomes a thin wrapper; the chat loop is the second consumer of the same
  functions (ADR 009 extract-on-second-consumer, at module scale).
- **`POST /chat`** (`src/api/chat.py`, wired into `main.py`): body
  `{messages: [{role: "user"|"assistant", content: str}]}` (client sends
  history; server stateless). Owner JWT auth as usual, then the loop runs
  under a **stripped read-only context**: `AccessContext.of()` over
  `f"{domain}:read"` for every active type-definition domain. The loop can
  never write, structurally (invariant 5).
- **Loop:** manual tool loop over the Anthropic SDK, max 5 model turns.
  `client.messages.stream(...)` per turn; text deltas stream out as SSE
  `text` frames as they arrive. On `tool_use` blocks: emit an SSE `tool`
  frame (name only), execute via the shared tools with the stripped ctx,
  return all `tool_result`s in one user turn, continue. Provenance from
  every executed tool result accumulates into the citations set.
- **Model config** (env-overridable constants in `chat.py`):
  `LIFEOS_CHAT_MODEL` default `claude-opus-5`; `output_config.effort` from
  `LIFEOS_CHAT_EFFORT` default `low` (latency bar); `max_tokens` 16000;
  streaming always; server-side refusal fallback `fallbacks: "default"`
  (beta `server-side-fallback-2026-07-01`). Model switches (e.g. to
  `claude-sonnet-5` if p95 misses) are operator decisions, not code.
- **System prompt:** the MCP server's grounding instructions, shared as a
  constant in `tools.py`: answer strictly from the returned records, cite
  ids, abstain plainly when no record supports an answer (golden Q13/Q14
  behavior), plus a brevity line for chat.
- **SSE protocol** (`text/event-stream`):
  - `event: text` `data: {"delta": str}`
  - `event: tool` `data: {"name": str}`
  - `event: done` `data: {"citations": {"entity_ids": [...], "event_ids":
    [...], "methods": [...]}, "latency": {"model_ms": int, "tool_ms": int,
    "total_ms": int}, "model": str, "stop_reason": str}`
  - `event: error` `data: {"detail": str}`
  Latency is also logged (`chat p95` greppable line) for the < 4s check.
- **Error handling:** pre-stream failures use the existing exception
  handlers (401/403/422). Mid-stream failures emit `error` and close.
  `stop_reason == "refusal"` (post-fallback) → a fixed abstention message as
  `text` + normal `done`. `max_tokens` → `error` frame, never a silent
  half-answer.

## Frontend (lifeos-ui)

- `src/pages/Chat.tsx` + route `/chat` + nav link. Message list (user /
  assistant), input form, incremental text rendering, subdued tool-activity
  line during the loop, citations under each answer as entity-link chips
  (`/entities/:id`) with event ids collapsed behind a count, inline error
  display per the repo pattern.
- `src/api/client.ts`: `streamChat(messages, handlers)` using fetch +
  ReadableStream SSE parsing (EventSource can't POST/Authorization); typed
  frame definitions colocated. `gen:api` run; `types.gen.ts` committed.

## Tests

- lifeos unit (`tests/api/test_chat_loop.py`): injected fake model client
  scripting tool_use→text turns — citation accumulation, scope-strip means
  no write scope present, abstention passthrough, latency fields, turn cap.
- lifeos e2e (`tests/api/test_chat.py`): SSE over the wire with the fake
  client wired via dependency override; frame order and shapes.
- `tests/mcp` staying green proves the tools refactor is behavior-neutral.
- lifeos-ui: Vitest for Chat page (mocked `streamChat`); Playwright flow
  with host-scoped route-mocked SSE response.
- Acceptance: both CI gates green; runnable golden questions (8 partial, 9,
  13, 14) scored against the deployed instance with citations visible;
  unanswerable questions abstain.

## ADR-011 (docs/adr/011-grounded-chat-sse-direct-llm.md — rules cell)

Records: SSE chat design; direct Anthropic SDK with the key in the app env
render, reversing ADR 009's "LiteLLM at first LLM usage" by ADR 009's own
extract-on-second-consumer rule; revive triggers (second LLM consumer, real
budget/usage need, multi-provider); refusal-fallback posture.
