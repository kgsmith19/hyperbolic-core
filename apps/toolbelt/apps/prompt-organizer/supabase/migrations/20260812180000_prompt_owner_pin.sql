-- Re-pins every prompt.* RLS policy from "the authenticated caller who owns
-- the row" to the single owner UUID (ADR-03; SEC-03 remediation). Source:
-- docs/planning/06-supabase-schema.md section 5.5 and
-- docs/planning/05-d-prompt-organizer.md section 2, applied verbatim;
-- migration sequence step S5. Owner behavior is unchanged: the owner was
-- already the only real writer under the pre-pin policies, so this is a
-- fixture-token access change only, not a functional change for the owner.
--
-- Applied after the toolbelt-root migrations (platform.owner() already
-- exists from 20260812140000) and after core/idea are pinned
-- (20260812160000), per the fixed per-directory apply order in
-- .github/workflows/platform-migrations.yml.

-- Pattern A: prompt.prompt carries user_id.
drop policy owner_all on prompt.prompt;
create policy owner_rw on prompt.prompt
  for all to authenticated
  using (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  )
  with check (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );

-- Pattern A, split by verb (immutability grants are untouched by this
-- migration: no update/delete grant existed before and none is added now).
drop policy owner_select on prompt.prompt_version;
drop policy owner_insert on prompt.prompt_version;
create policy owner_select on prompt.prompt_version
  for select to authenticated
  using (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );
create policy owner_insert on prompt.prompt_version
  for insert to authenticated
  with check (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );

drop policy owner_select on prompt.usage;
drop policy owner_insert on prompt.usage;
create policy owner_select on prompt.usage
  for select to authenticated
  using (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );
create policy owner_insert on prompt.usage
  for insert to authenticated
  with check (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );

-- Pattern C: child tables owned via the parent prompt row (no user_id of
-- their own), pinned EXISTS clause.
drop policy owner_select on prompt.tag;
drop policy owner_insert on prompt.tag;
create policy owner_select on prompt.tag
  for select to authenticated
  using (
    (select auth.uid()) = (select platform.owner())
    and exists (select 1 from prompt.prompt p
                where p.id = prompt_id
                  and p.user_id = (select platform.owner()))
  );
create policy owner_insert on prompt.tag
  for insert to authenticated
  with check (
    (select auth.uid()) = (select platform.owner())
    and exists (select 1 from prompt.prompt p
                where p.id = prompt_id
                  and p.user_id = (select platform.owner()))
  );

drop policy owner_select on prompt.configuration;
drop policy owner_insert on prompt.configuration;
create policy owner_select on prompt.configuration
  for select to authenticated
  using (
    (select auth.uid()) = (select platform.owner())
    and exists (select 1 from prompt.prompt p
                where p.id = prompt_id
                  and p.user_id = (select platform.owner()))
  );
create policy owner_insert on prompt.configuration
  for insert to authenticated
  with check (
    (select auth.uid()) = (select platform.owner())
    and exists (select 1 from prompt.prompt p
                where p.id = prompt_id
                  and p.user_id = (select platform.owner()))
  );
