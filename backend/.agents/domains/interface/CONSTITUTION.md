# Interface cell

Owns: `src/api/**`, `tests/api/**`, `src/mcp_server/**`, `tests/mcp/**`.

- Thin. No business logic.
- Calls kernel application services, or a domain module's own service function
  when the route's job is that domain's (e.g. `POST /documents`); no direct DB
  access either way. The behavior lives in the callee — a route may dispatch,
  never decide.
- DTOs are Pydantic models.
- Every route change lands with a test in `tests/api/` (happy path + failure).
- MCP tools wrap kernel services 1:1 and are read-only (ADR 010); every tool
  result carries the provenance envelope; changes land with tests in
  `tests/mcp/`.
