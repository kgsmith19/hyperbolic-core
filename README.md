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

One-time setup:

1. Generate the signing keypair: run `lifeos-agent-keygen.ps1` from the Guards
   GUI ("Claude's requests" tab). It appends `LIFEOS_AGENT_JWT_PRIVATE_KEY` and
   `LIFEOS_AGENT_JWT_PUBLIC_KEY` (base64-wrapped PEM) to the repo `.env` and
   prints no key material.
2. Mint a token (repeat `--scope` per domain; re-run when a new domain lands):

   ```
   .venv\Scripts\python scripts/mint_agent_token.py --scope relationships:read --scope health:read
   ```

3. Claude Desktop → Settings → Developer → Edit Config:

   ```json
   {
     "mcpServers": {
       "lifeos": {
         "command": "C:\\code\\lifeos\\.venv\\Scripts\\python.exe",
         "args": ["-m", "mcp_server"],
         "env": {
           "LIFEOS_AGENT_TOKEN": "<output of scripts/mint_agent_token.py>",
           "LIFEOS_AGENT_JWT_PUBLIC_KEY": "<LIFEOS_AGENT_JWT_PUBLIC_KEY value from .env>",
           "DATABASE_URL": "<optional: prod session-pooler URL for real data>"
         }
       }
     }
   }
   ```

Omit `DATABASE_URL` to fall back to the repo `.env` (the lifeos-test database,
which `pytest` wipes). Every tool result carries the provenance envelope
(ADR 010): the entity/event ids it was built from, the producing method, and a
confidence.
