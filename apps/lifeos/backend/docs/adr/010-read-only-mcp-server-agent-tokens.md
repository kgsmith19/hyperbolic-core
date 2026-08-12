# ADR 010: Read-only MCP server and self-issued agent tokens

## Decision

The first agent door is a stdio MCP server (`src/mcp_server/`) that wraps
the kernel application services in-process — `list_types`, `find`,
`get_entity`, `history` — and nothing else (invariant 7, ADR 006). It joins
the interface cell: thin, no business logic, no data access outside
services.

Agent identity is a **self-issued ES256 JWT**, not a Supabase session:
Supabase signs interactive user logins only, and a purely local stdio
process should not take a network dependency to learn its own scopes. ADR
008's shape is kept — a `scopes` claim narrowing an AccessContext — on a
dedicated keypair: the operator holds the private key (guards keygen →
local `.env` today; Infisical the day any deployed component must verify
agent tokens), the server holds only the public key. The API's Supabase
verification is untouched.

Scopes are **explicit `<domain>:read` entries**. The mint helper
(`scripts/mint_agent_token.py`) and the verifier both refuse anything else
— write scopes and wildcards cannot exist in a valid token — and an
unknown domain never matches a scope check, so new domains stay dark until
the operator re-mints (fail closed; the settled roadmap decision). The
token is re-verified on every tool call, so expiry holds inside long-lived
sessions.

Lethal-trifecta check (invariant 8): this component has broad read access
and lacks the other two legs — no write path (no write tools, write scopes
unexpressible) and no external communication (stdio to a local client and
the database, nothing else).

**The provenance convention starts here.** Every tool result carries

```json
{"source_entity_ids": [...], "source_event_ids": [...],
 "method": "kernel.<service>", "confidence": 1.0}
```

Direct kernel reads are confidence 1.0. From this slice on, every derived
result or event anywhere in the system must cite
`{source_event_ids, method, confidence}` honestly — AGENTS.md carries the
authoring-facing rule.

## Consequences

- The MCP surface is the kernel contract re-exposed; a proposed tool that
  is not a kernel service is a design smell against ADR 006.
- Tokens are bearer credentials: mint short-lived, rotate by re-mint,
  revoke by regenerating the keypair (all outstanding tokens die).
- Claude Desktop is the first consumer (README has the setup); the Slice 2
  chat loop reuses these same services and this token shape, never the DB.

## Revisit when

A second agent client appears, any write tool is proposed (that is a new
ADR, not an extension), or a deployed component needs to verify agent
tokens (move the private key to Infisical and pick a transport then).
