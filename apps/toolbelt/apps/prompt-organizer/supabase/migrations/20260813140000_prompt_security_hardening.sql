-- Forward-only security hardening for prompt.get_prompt. The original
-- 20260813120000 migration remains immutable; this migration adds the
-- execute-only agent role, validates the JSON boundary, and pins every
-- SECURITY DEFINER read to the configured platform owner.

do $$
begin
  create role prompt_get_agent nologin noinherit nobypassrls;
exception
  when duplicate_object then null;
end
$$;
alter role prompt_get_agent
  nologin noinherit nobypassrls nosuperuser nocreatedb nocreaterole noreplication;
grant prompt_get_agent to authenticator;
grant usage on schema prompt to prompt_get_agent;

create or replace function prompt.get_prompt(
  p_name     text,
  p_version  integer default null,
  p_config   text default null,
  p_values   jsonb default null,
  p_sections text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prompt_id  uuid;
  v_live_body  text;
  v_is_active  boolean;
  v_body       text;
  v_version_no integer;
  v_values     jsonb := '{}'::jsonb;
  v_sections   text[] := '{}'::text[];
  v_id         text;
  v_key        text;
  v_missing    text[];
  v_claims     jsonb := '{}'::jsonb;
  v_scope      text := '';
begin
  v_claims := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_scope := coalesce(v_claims ->> 'scope', '');

  if (select auth.uid()) = (select platform.owner()) then
    null; -- interactive owner session
  elsif v_claims ->> 'role' = 'prompt_get_agent'
    and 'prompt:get' = any(regexp_split_to_array(trim(v_scope), '[[:space:]]+')) then
    null; -- scoped, non-interactive agent token
  else
    raise exception 'get_prompt is not authorized for this principal'
      using errcode = '42501';
  end if;

  -- The published request contract is object<string,string>. Rejecting at
  -- the SQL boundary avoids jsonb_object_keys(array) crashes and surprising
  -- scalar-to-text coercion for callers that bypass a TypeScript client.
  if p_values is not null and jsonb_typeof(p_values) <> 'object' then
    raise exception 'p_values must be an object of string values'
      using errcode = 'PT422';
  end if;
  if p_values is not null and exists (
    select 1 from jsonb_each(p_values) as item
    where jsonb_typeof(item.value) <> 'string'
  ) then
    raise exception 'p_values must contain only string values'
      using errcode = 'PT422';
  end if;

  -- Name resolution: case-insensitive against prompt.title, the same
  -- lower(title) convention render_prompt uses. Deliberately NOT filtered
  -- to is_active here -- that filter is applied only on the latest-
  -- resolution branch below (see the p_version-is-null branch), because a
  -- pinned version_no must keep resolving after its parent prompt is
  -- archived. is_active is a display-only flag (20260808000000: "archiving
  -- flips a display flag, never touches a row or version"); the whole
  -- point of a version pin (section 6/7: "a consumer requests name@version
  -- ... for reproducible behavior") is that it survives exactly that kind
  -- of later change to the live row.
  select p.id, p.body, p.is_active into v_prompt_id, v_live_body, v_is_active
    from prompt.prompt as p
    where lower(p.title) = lower(p_name)
      and p.user_id = (select platform.owner());
  if v_prompt_id is null then
    raise exception 'prompt not found' using errcode = 'PT404';
  end if;

  if p_version is not null then
    -- Pinned: body resolves from prompt_version, not the live prompt.body
    -- (section 1.2/6/7). prompt_version has no UPDATE or DELETE grant
    -- anywhere in this schema's history, so a resolved pinned body is
    -- immutable for as long as the row is visible under RLS.
    select pv.body into v_body from prompt.prompt_version as pv
      where pv.prompt_id = v_prompt_id and pv.version_no = p_version
        and pv.user_id = (select platform.owner());
    if not found then
      raise exception 'prompt version not found' using errcode = 'PT404';
    end if;
    v_version_no := p_version;
  else
    -- Omitted: resolves latest/active. A latest lookup against an archived
    -- prompt is a 404, same as an unknown name -- there is no "active
    -- latest" to serve.
    if not v_is_active then
      raise exception 'prompt not found' using errcode = 'PT404';
    end if;
    v_body := v_live_body;
    -- record_version (20260807041000) fires after insert or update of
    -- body, so every live row has at least version 1; coalesce only
    -- guards a row created before that trigger existed.
    select coalesce(max(pv.version_no), 1) into v_version_no
      from prompt.prompt_version as pv
      where pv.prompt_id = v_prompt_id
        and pv.user_id = (select platform.owner());
  end if;

  if p_config is not null then
    select c.values, c.sections into v_values, v_sections
      from prompt.configuration as c
      where c.prompt_id = v_prompt_id and c.name = p_config
        and exists (
          select 1 from prompt.prompt as owner_prompt
          where owner_prompt.id = c.prompt_id
            and owner_prompt.user_id = (select platform.owner())
        );
    if not found then
      raise exception 'configuration not found' using errcode = 'PT404';
    end if;
  end if;

  -- p_values are ad-hoc values merged OVER p_config's saved values (section
  -- 1.2: "merged over p_config values"). jsonb `||` is right-operand-wins
  -- on a shared key, which is exactly "ad-hoc overrides saved config"; keys
  -- only present in the saved config are kept.
  if p_values is not null then
    v_values := v_values || p_values;
  end if;

  -- p_sections overrides p_config's sections wholesale when present
  -- (section 1.2: "overrides p_config sections when present") -- a
  -- replacement, not a union.
  if p_sections is not null then
    v_sections := p_sections;
  end if;

  -- Section resolution, then variable substitution, then the
  -- missing-variable refusal -- the exact three-step order and mechanism
  -- render_prompt uses (section 8: sections resolve before variable
  -- extraction, so a variable inside an excluded section is never
  -- required).
  for v_id in
    select distinct (regexp_matches(v_body, '<!--OPTIONAL:([A-Za-z0-9_-]+)-->', 'g'))[1]
  loop
    if v_id = any(v_sections) then
      v_body := replace(replace(v_body,
        '<!--OPTIONAL:' || v_id || '-->', ''), '<!--/OPTIONAL:' || v_id || '-->', '');
    else
      v_body := regexp_replace(v_body,
        '<!--OPTIONAL:' || v_id || '-->.*?<!--/OPTIONAL:' || v_id || '-->', '', 'g');
    end if;
  end loop;

  for v_key in select jsonb_object_keys(v_values) loop
    v_body := replace(v_body, '{{' || v_key || '}}', v_values ->> v_key);
  end loop;

  select array_agg(distinct m[1]) into v_missing
    from regexp_matches(v_body, '\{\{([A-Z_][A-Z0-9_]*)\}\}', 'g') as m;
  if v_missing is not null then
    raise exception 'missing variables: %', array_to_string(v_missing, ', ') using errcode = 'PT422';
  end if;

  return jsonb_build_object(
    'text', v_body,
    'version_no', v_version_no,
    'rendered_at', now()
  );
end;
$$;

revoke execute on function prompt.get_prompt(text, integer, text, jsonb, text[])
  from public, anon, authenticated, service_role, prompt_get_agent;
grant execute on function prompt.get_prompt(text, integer, text, jsonb, text[]) to authenticated;
grant execute on function prompt.get_prompt(text, integer, text, jsonb, text[]) to prompt_get_agent;
