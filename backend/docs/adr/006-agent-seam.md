# ADR 006: Agent seam is kernel services now, MCP wrapping services later

## Decision
AI and agents touch the system only through application services; a future
Jarvis-style orchestrator gets MCP servers that wrap those services with
scoped AccessContexts — never raw tables, never raw SQL (invariant 7). We
build the seam, not the agent. Any future agent feature must satisfy the
lethal-trifecta rule (invariant 8): no component combines broad read access,
external communication, and high-consequence writes; design review requires
naming the missing leg.

## Consequences
- The kernel contract (CONTRACT.md) is the whole agent surface; keeping it
  small keeps the future attack surface small.
- No orchestrator, memory framework, or MCP server exists in this repo yet;
  pressure to add one goes through design review against this ADR.

## Revisit when
The first MCP wrapper is designed, or any component requests a second
trifecta leg.
