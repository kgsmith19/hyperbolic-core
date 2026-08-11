-- SPEC-0012 AC-001..AC-004 (FR-013). A PostgREST RPC, not a new service
-- (SR-02). security invoker inherits the caller's own RLS -- no new policy.
-- Postgres grants EXECUTE to PUBLIC on new functions by default; revoked
-- explicitly to keep the same narrowest-surface posture as every table grant
-- in this schema (SR-06).
create or replace function prompt.render_prompt(p_name text, p_config text default null)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_prompt_id uuid;
  v_body      text;
  v_values    jsonb := '{}'::jsonb;
  v_sections  text[] := '{}'::text[];
  v_id        text;
  v_key       text;
  v_missing   text[];
begin
  select id, body into v_prompt_id, v_body
    from prompt.prompt where lower(title) = lower(p_name) and is_active;
  if v_prompt_id is null then
    raise exception 'prompt not found' using errcode = 'PT404';
  end if;

  if p_config is not null then
    select values, sections into v_values, v_sections
      from prompt.configuration where prompt_id = v_prompt_id and name = p_config;
    if not found then
      raise exception 'configuration not found' using errcode = 'PT404';
    end if;
  end if;

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

  return v_body;
end;
$$;

revoke execute on function prompt.render_prompt(text, text) from public;
grant execute on function prompt.render_prompt(text, text) to authenticated;
