# lifeos

A personal Life OS: a generic, domain-agnostic kernel — a typed entity graph plus an
append-only event log on Supabase/Postgres — where every life domain (health, finance,
relationships, tasks) plugs in as data, not schema. The long-term direction is a
Jarvis-style orchestrator sitting on top via scoped, least-privilege seams; we build
the kernel now and reserve the seams, we do not build the agent.

Stack: Python 3.12, FastAPI, Pydantic v2, Supabase (Postgres + pgvector), Supabase CLI
migrations, pytest, ruff, mypy, Docker for local services.

See [AGENTS.md](AGENTS.md).

## Agent access over MCP (ADR 010)

A read-only stdio MCP server wraps the kernel services — `list_types`, `find`,
`get_entity`, `history` — for agent clients. Agent tokens are ES256 JWTs carrying
explicit `<domain>:read` scopes: writes cannot be expressed, and a domain added
later stays invisible until a re-mint.

Setup — two clicks in the Guards GUI, nothing to copy:

1. `lifeos-agent-keygen.ps1` (one-time) — generates the ES256 signing keypair
   into the repo `.env`; prints no key material.
2. `lifeos-mcp-setup.ps1` (standing) — mints a 30-day read-only token into
   `.env` as `LIFEOS_AGENT_TOKEN` and registers the server in Claude Desktop's
   config; restart Claude Desktop. Re-run on expiry or key rotation; when a new
   domain lands, update the script's `--scope` list deliberately — it is the
   operator-reviewed allowlist.

The server resolves `LIFEOS_AGENT_TOKEN`, `LIFEOS_AGENT_JWT_PUBLIC_KEY`, and
`DATABASE_URL` from its environment with fallback to the repo `.env`, so the
Claude Desktop entry holds no secrets. By default the agent sees the `.env`
database (lifeos-test, which `pytest` wipes); to point it elsewhere add an
`env: {"DATABASE_URL": ...}` block to the `lifeos` entry — the setup script
preserves it. For other MCP clients, `scripts/mint_agent_token.py` without
`--install` prints the token instead. Every tool result carries the provenance
envelope (ADR 010): the entity/event ids it was built from, the producing
method, and a confidence.
