-- Down migration for 20260812180000_prompt_owner_pin.sql. Restores the exact
-- pre-re-pin policies (20260807020000_prompt_create_prompt.sql,
-- 20260807041000_prompt_versions_and_unique_title.sql,
-- 20260807051000_prompt_create_tag.sql, 20260807070000_prompt_create_usage.sql,
-- 20260808100000_prompt_create_configuration.sql).

drop policy owner_select on prompt.configuration;
drop policy owner_insert on prompt.configuration;
create policy owner_select on prompt.configuration for select using (
  exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
);
create policy owner_insert on prompt.configuration for insert with check (
  exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
);

drop policy owner_select on prompt.tag;
drop policy owner_insert on prompt.tag;
create policy owner_select on prompt.tag
  for select using (
    exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
  );
create policy owner_insert on prompt.tag
  for insert with check (
    exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
  );

drop policy owner_select on prompt.usage;
drop policy owner_insert on prompt.usage;
create policy owner_select on prompt.usage
  for select using (user_id = auth.uid());
create policy owner_insert on prompt.usage
  for insert with check (user_id = auth.uid());

drop policy owner_select on prompt.prompt_version;
drop policy owner_insert on prompt.prompt_version;
create policy owner_select on prompt.prompt_version
  for select using (user_id = auth.uid());
create policy owner_insert on prompt.prompt_version
  for insert with check (user_id = auth.uid());

drop policy owner_rw on prompt.prompt;
create policy owner_all on prompt.prompt
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
