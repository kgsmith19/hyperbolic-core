-- Restore the exact 20260813120000 prompt.get_prompt implementation.
-- Apply this only after the later get_prompt_source down migration has
-- removed the function that also grants prompt_get_agent EXECUTE.
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
security invoker
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
begin
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
  select id, body, is_active into v_prompt_id, v_live_body, v_is_active
    from prompt.prompt where lower(title) = lower(p_name);
  if v_prompt_id is null then
    raise exception 'prompt not found' using errcode = 'PT404';
  end if;

  if p_version is not null then
    -- Pinned: body resolves from prompt_version, not the live prompt.body
    -- (section 1.2/6/7). prompt_version has no UPDATE or DELETE grant
    -- anywhere in this schema's history, so a resolved pinned body is
    -- immutable for as long as the row is visible under RLS.
    select body into v_body from prompt.prompt_version
      where prompt_id = v_prompt_id and version_no = p_version;
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
    select coalesce(max(version_no), 1) into v_version_no
      from prompt.prompt_version where prompt_id = v_prompt_id;
  end if;

  if p_config is not null then
    select values, sections into v_values, v_sections
      from prompt.configuration where prompt_id = v_prompt_id and name = p_config;
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

revoke execute on function prompt.get_prompt(text, integer, text, jsonb, text[]) from public;
grant execute on function prompt.get_prompt(text, integer, text, jsonb, text[]) to authenticated;

revoke execute on function prompt.get_prompt(text, integer, text, jsonb, text[])
  from prompt_get_agent;
revoke usage on schema prompt from prompt_get_agent;
revoke prompt_get_agent from authenticator;
drop role prompt_get_agent;
