-- FR-007: any authenticated tool records a run by calling this RPC instead
-- of ever writing directly into core.run/core.cost. Realizes Q-001's
-- ratified "thin wrapper library, one function" as a Postgres function
-- rather than duplicated per-tool client code, once prompt-organizer's own
-- CLAUDE.md ruled out any tool writing cross-schema: the write logic lives
-- exactly once, owned where core is owned, so a future column change to
-- core.run/core.cost needs no matching change in any calling tool's repo.
--
-- security definer, with search_path pinned per Postgres's own guidance for
-- such functions (search-path hijacking): not required for this function to
-- work today (core.*'s existing blanket authenticated grants already permit
-- a direct insert), but it is what keeps this RPC working if those grants
-- are ever tightened later (SPEC-0000 RISK-002; not done in this slice).
--
-- Deliberately narrow: only core.run + core.cost, only wall_clock_ms. No
-- core.event, no token/LLM-cost fields -- no current caller produces them.
create function core.log_run(
  p_app_id text,
  p_kind text,
  p_wall_clock_ms bigint,
  p_ref text default null
) returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_run_id uuid;
begin
  insert into core.run (app_id, kind, ref, status, ended_at)
  values (p_app_id, p_kind, p_ref, 'ok', now())
  returning id into v_run_id;

  insert into core.cost (run_id, wall_clock_ms)
  values (v_run_id, p_wall_clock_ms);

  return v_run_id;
end;
$$;

grant execute on function core.log_run(text, text, bigint, text) to authenticated;
