# ADR-0001: A capability needing server-side authority is a PostgREST RPC, never a new service

## Context

SR-02 fixes this repo's shape: no application server, the page and tests call Supabase's own PostgREST and GoTrue directly. Twice now a real requirement needed logic to run with authority the browser can't safely hold: `NFR-010` (log a run to `toolbelt`'s shared `core` schema, which this repo's own `CLAUDE.md`/`AGENTS.md` forbids writing to directly) and `FR-013` (serve a rendered prompt over HTTP, callable by something other than this browser page). Both looked, on first read, like they wanted "a small backend" — a genuinely new service, dependency, and deployment surface.

## Decision

Any capability like this is a Postgres function exposed through PostgREST's existing RPC mechanism (`POST`/`GET /rest/v1/rpc/<name>`), never a new application server, container, or third-party service.

## Why

A PostgREST RPC is more `prompt` schema, not a new moving part: no new deployment target, no new dependency, no new secret, no new thing to keep running. `security invoker` (the default posture — see the two shipped examples, `prompt.render_prompt` and `toolbelt`'s `core.log_run`) means it inherits the caller's own RLS with zero new policy surface, so the existing security model doesn't grow a second shape to reason about. This is the same call both `NFR-010` and `FR-013` independently converged on; recording it once means the next requirement in this shape doesn't have to re-derive it, and doesn't get built as an unnecessary new service by mistake.

## Consequences

- A future requirement that seems to want "a backend" should default to this pattern first; reaching for an actual new service is a STOP-condition-level decision (`AGENTS.md`), not a default.
- Some PostgREST behavior is genuinely unavailable on a managed project without server-config access this repo doesn't have (e.g. raw `text/plain` output — confirmed live, `SPEC-0012` §2.1). Accept the JSON-wrapped response rather than working around it with a real service.
- `security invoker` is the default; `security definer` is an explicit, reviewed exception, not a shortcut — SPEC-0012's own mutation drill showed a `definer` function silently bypasses RLS.
