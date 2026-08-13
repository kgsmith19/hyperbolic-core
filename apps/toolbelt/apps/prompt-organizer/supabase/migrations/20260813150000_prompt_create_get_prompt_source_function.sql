-- m4-04 prompt-client cache source.
--
-- Cacheable client reads need an unrendered template, but prompt_get_agent is
-- deliberately execute-only and cannot SELECT prompt.prompt or
-- prompt.prompt_version. Keeping the lookup in one SECURITY DEFINER RPC also
-- makes the returned body/version pair a single PostgreSQL statement snapshot,
-- so a concurrent prompt update cannot pair one version with another body.
--
-- p_if_version is the ETag-equivalent conditional. For an unchanged active
-- latest prompt the response omits the body (`body: null`) and sets
-- `not_modified: true`. Archival is checked before that conditional, so an
-- archived latest lookup raises PT404 even when its version number did not
-- change. Pinned versions intentionally continue to resolve after archival.
-- The execute-only role and hardened prompt.get_prompt implementation are
-- introduced by 20260813140000 immediately before this migration.
create or replace function prompt.get_prompt_source(
  p_name       text,
  p_version    integer default null,
  p_if_version integer default null
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
    raise exception 'get_prompt_source is not authorized for this principal'
      using errcode = '42501';
  end if;

  -- SECURITY DEFINER does not delegate authorization to caller RLS. Pin the
  -- row lookup explicitly to the configured owner as a second boundary after
  -- the principal check above.
  select p.id, p.body, p.is_active
    into v_prompt_id, v_live_body, v_is_active
    from prompt.prompt as p
    where lower(p.title) = lower(p_name)
      and p.user_id = (select platform.owner());
  if v_prompt_id is null then
    raise exception 'prompt not found' using errcode = 'PT404';
  end if;

  if p_version is not null then
    select pv.body into v_body
      from prompt.prompt_version as pv
      where pv.prompt_id = v_prompt_id
        and pv.version_no = p_version
        and pv.user_id = (select platform.owner());
    if not found then
      raise exception 'prompt version not found' using errcode = 'PT404';
    end if;
    v_version_no := p_version;
  else
    if not v_is_active then
      raise exception 'prompt not found' using errcode = 'PT404';
    end if;
    v_body := v_live_body;
    select coalesce(max(pv.version_no), 1) into v_version_no
      from prompt.prompt_version as pv
      where pv.prompt_id = v_prompt_id
        and pv.user_id = (select platform.owner());
  end if;

  if p_if_version is not null and p_if_version = v_version_no then
    return jsonb_build_object(
      'body', null::text,
      'version_no', v_version_no,
      'not_modified', true
    );
  end if;

  return jsonb_build_object(
    'body', v_body,
    'version_no', v_version_no,
    'not_modified', false
  );
end;
$$;

revoke execute on function prompt.get_prompt_source(text, integer, integer)
  from public, anon, authenticated, service_role, prompt_get_agent;
grant execute on function prompt.get_prompt_source(text, integer, integer) to authenticated;
grant execute on function prompt.get_prompt_source(text, integer, integer) to prompt_get_agent;
