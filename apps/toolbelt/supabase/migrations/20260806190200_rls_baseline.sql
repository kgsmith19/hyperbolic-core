-- NFR-001: RLS enabled and forced on every core/idea table.
-- core.run has a real user_id column -> policy scoped to that row's owner.
-- Every other table below has no user_id column (single-user reference/log
-- data, not per-row-owned) -> policy scoped to the authenticated role
-- generally. This is a single-user system, so "authenticated = owner" is
-- the correct model here (Kyle, 2026-08-06). Revisit if a second identity
-- is ever added.

alter table core.run enable row level security;
alter table core.run force row level security;
create policy owner_all on core.run
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table core.app enable row level security;
alter table core.app force row level security;
create policy authenticated_all on core.app for all to authenticated using (true) with check (true);

alter table core.event enable row level security;
alter table core.event force row level security;
create policy authenticated_all on core.event for all to authenticated using (true) with check (true);

alter table core.cost enable row level security;
alter table core.cost force row level security;
create policy authenticated_all on core.cost for all to authenticated using (true) with check (true);

alter table core.outcome enable row level security;
alter table core.outcome force row level security;
create policy authenticated_all on core.outcome for all to authenticated using (true) with check (true);

alter table core.run_outcome enable row level security;
alter table core.run_outcome force row level security;
create policy authenticated_all on core.run_outcome for all to authenticated using (true) with check (true);

alter table core.metric_def enable row level security;
alter table core.metric_def force row level security;
create policy authenticated_all on core.metric_def for all to authenticated using (true) with check (true);

alter table core.metric_value enable row level security;
alter table core.metric_value force row level security;
create policy authenticated_all on core.metric_value for all to authenticated using (true) with check (true);

alter table core.assumption enable row level security;
alter table core.assumption force row level security;
create policy authenticated_all on core.assumption for all to authenticated using (true) with check (true);

alter table core.intervention enable row level security;
alter table core.intervention force row level security;
create policy authenticated_all on core.intervention for all to authenticated using (true) with check (true);

alter table idea.idea enable row level security;
alter table idea.idea force row level security;
create policy authenticated_all on idea.idea for all to authenticated using (true) with check (true);

alter table idea.dependency enable row level security;
alter table idea.dependency force row level security;
create policy authenticated_all on idea.dependency for all to authenticated using (true) with check (true);

alter table idea.score enable row level security;
alter table idea.score force row level security;
create policy authenticated_all on idea.score for all to authenticated using (true) with check (true);
