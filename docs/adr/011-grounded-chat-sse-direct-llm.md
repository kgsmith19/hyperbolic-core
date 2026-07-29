# ADR 011: Grounded chat over SSE; direct Anthropic SDK (no gateway yet)

## Decision

**Chat.** `POST /chat` streams SSE (`text` / `tool` / `done` / `error`) from a
manual Anthropic tool loop inside the existing FastAPI app — no new
deployable (ADR 009 same-repo default). The loop's tools are the shared
agent-tool surface in `mcp_server.tools` — the same four provenance-wrapped
read services the MCP server registers (ADR 010), factored out when chat
became their second consumer. The verified owner context is replaced by a
scope-stripped context of `<domain>:read` over active type domains, so the
loop is read-only by construction (invariant 5). Stripping intersects, never
widens: the chat context holds only the `<domain>:read` scopes the
authenticated context already had, so a narrowed `scopes` token (ADR 008)
stays narrow through /chat. Every answer's `done` frame carries the union of
tool-result provenance (entity ids, event ids, methods) as citations, plus
`model_ms/tool_ms/total_ms` latency, which is also logged for the p95 < ~4s
bar. The system prompt is the MCP server's grounding instructions (answer
strictly from records; abstain plainly), so both agent doors speak with one
voice.

**Model.** `claude-opus-5`, streaming, `output_config.effort: "low"` for the
latency bar, overridable via `LIFEOS_CHAT_MODEL` / `LIFEOS_CHAT_EFFORT` —
model changes are operator decisions, not code. Server-side refusal fallback
(`fallbacks: "default"`) is on, so a safety-classifier false positive
degrades to a fallback-model answer instead of a dead turn.

**LLM keys: direct SDK, no LiteLLM yet.** ADR 009 planned "LiteLLM at first
LLM usage", but its own boundary rule — extract on the second consumer,
never on prediction — argues against a gateway service for exactly one
consumer. `ANTHROPIC_API_KEY` stays in the app `.env` render (deploy wiring
already in place). Revive triggers: a second LLM-calling service, a real
budget/usage-tracking need, or multi-provider routing.

## Consequences

- One implementation of the agent-tool surface; MCP tests double as the
  chat tools' regression suite.
- Chat answers are auditable: every claim traces to cited kernel records,
  and unanswerables abstain (golden questions 13/14 are the regression bar).
- The app now holds one provider key; rotating it is edit-and-redeploy via
  Infisical (ADR 009).

## Revisit when

A second LLM consumer or a budget need appears (LiteLLM trigger), p95 misses
the 4s bar after effort tuning (model choice revisited with the operator),
or agent-scoped chat (non-owner tokens) lands.
