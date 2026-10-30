-- Local platform schema (#508). One SQLite file replaces the Supabase
-- platform project's core, idea, platform, prompt and intake schemas, ported
-- from the 64 Postgres migrations' final state. Postgres schema `x.table`
-- becomes table `x_table`. Types: uuid and timestamptz are text (RFC 4122,
-- ISO-8601 UTC), jsonb and text[] are JSON text checked with json_valid,
-- numeric is real, boolean is 0/1. Row-level security is not ported: every
-- policy was "the platform owner only", which services/platform-api enforces
-- per request, together with each table's grants.

-- The single local owner and the refresh tokens issued to them.
create table auth_user (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;

create table auth_refresh_token (
  token_sha256 text primary key,
  user_id text not null references auth_user (id) on delete cascade,
  issued_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at text
) strict;

create table platform_config (
  singleton integer primary key default 1 check (singleton = 1),
  owner_uuid text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;

create table core_app (
  id text primary key,
  name text not null,
  schema_name text not null,
  status text not null default 'idea' check (status in ('idea', 'building', 'live', 'retired')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind text not null default 'ui' check (kind in ('ui', 'cli', 'headless', 'hybrid')),
  route text,
  version text not null default '0.0.0',
  description text,
  manifest text check (manifest is null or json_valid(manifest)),
  manifest_hash text,
  registered_at text
) strict;

create table core_run (
  id text primary key,
  app_id text not null references core_app (id),
  kind text not null,
  ref text,
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at text,
  status text not null default 'running' check (status in ('running', 'ok', 'failed', 'halted')),
  user_id text
) strict;
create index core_run_app_id_started_at_idx on core_run (app_id, started_at desc);

create table core_cost (
  run_id text primary key references core_run (id) on delete cascade,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  llm_calls integer not null default 0,
  tool_calls integer not null default 0,
  wall_clock_ms integer not null default 0,
  interventions integer not null default 0,
  usd real not null default 0
) strict;

create table core_event (
  id integer primary key autoincrement,
  run_id text not null references core_run (id) on delete cascade,
  parent_id integer references core_event (id),
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind text not null,
  name text not null,
  payload text not null default '{}' check (json_valid(payload))
) strict;
create index core_event_run_id_at_idx on core_event (run_id, at);
create index core_event_at on core_event (at);

create table core_event_monthly_agg (
  month text primary key,
  event_count integer not null default 0
) strict;

create table core_intervention (
  id text primary key,
  run_id text not null references core_run (id) on delete cascade,
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decision_type text not null,
  was_halt integer not null check (was_halt in (0, 1)),
  was_correction integer not null check (was_correction in (0, 1)),
  note text
) strict;

create table core_assumption (
  id text primary key,
  run_id text references core_run (id) on delete set null,
  app_id text references core_app (id),
  statement text not null,
  why_needed text not null,
  how_to_verify text not null,
  blast_radius text not null check (blast_radius in ('low', 'medium', 'high')),
  status text not null default 'unverified' check (status in ('unverified', 'verified', 'false')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at text
) strict;

create table core_broker_call (
  id text primary key,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  caller text not null,
  target_host text not null,
  cost_usd real not null
) strict;
create index core_broker_call_caller_ts_idx on core_broker_call (caller, ts desc);

create table core_llm_call (
  id text primary key,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  caller_app text not null,
  purpose text not null,
  run_ref text,
  provider text not null check (provider in ('anthropic', 'openai', 'gemini')),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  usd_estimate real,
  latency_ms integer,
  status text not null check (status in ('ok', 'error')),
  error_class text
) strict;
create index core_llm_call_caller_app_ts_idx on core_llm_call (caller_app, ts desc);

create table core_llm_call_monthly_agg (
  month text primary key,
  call_count integer not null default 0
) strict;

create table core_metric_def (
  id text primary key,
  name text not null,
  formula text not null,
  unit text not null,
  is_proxy integer not null default 0 check (is_proxy in (0, 1)),
  gaming_risk text not null,
  supersedes text references core_metric_def (id),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  min_value real,
  max_value real,
  check (min_value is null or max_value is null or min_value <= max_value)
) strict;

create table core_metric_value (
  metric_id text not null references core_metric_def (id),
  app_id text not null references core_app (id),
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  value real not null,
  window text,
  primary key (metric_id, app_id, at)
) strict;

create table core_outcome (
  id text primary key,
  app_id text not null references core_app (id),
  kind text not null,
  ref text not null,
  shipped_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  value_note text
) strict;

create table core_run_outcome (
  run_id text not null references core_run (id) on delete cascade,
  outcome_id text not null references core_outcome (id) on delete cascade,
  primary key (run_id, outcome_id)
) strict;

create table idea_idea (
  id text primary key,
  name text not null,
  category text not null,
  one_liner text not null,
  problem text,
  status text not null default 'idea' check (status in ('idea', 'specced', 'building', 'live', 'parked', 'killed')),
  app_id text references core_app (id),
  project text not null default 'toolbelt',
  schema_name text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;

create table idea_dependency (
  idea_id text not null references idea_idea (id) on delete cascade,
  depends_on text not null references idea_idea (id) on delete cascade,
  reason text not null,
  primary key (idea_id, depends_on)
) strict;

create table idea_score (
  id text primary key,
  idea_id text not null references idea_idea (id) on delete cascade,
  metric_id text not null references core_metric_def (id),
  value real not null,
  scored_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  scored_by text not null
) strict;
create index idea_score_idea on idea_score (idea_id, scored_at desc);

-- idea.enforce_score_bounds
create trigger idea_score_bounds_insert before insert on idea_score
begin
  select raise(abort, 'value is below the metric''s minimum')
  where new.value < (select min_value from core_metric_def where id = new.metric_id);
  select raise(abort, 'value is above the metric''s maximum')
  where new.value > (select max_value from core_metric_def where id = new.metric_id);
end;
create trigger idea_score_bounds_update before update on idea_score
begin
  select raise(abort, 'value is below the metric''s minimum')
  where new.value < (select min_value from core_metric_def where id = new.metric_id);
  select raise(abort, 'value is above the metric''s maximum')
  where new.value > (select max_value from core_metric_def where id = new.metric_id);
end;

create table prompt_prompt (
  id text primary key,
  user_id text not null,
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 100000),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  is_active integer not null default 1 check (is_active in (0, 1))
) strict;
create unique index prompt_title_unique on prompt_prompt (user_id, lower(title));
create index prompt_created_at on prompt_prompt (user_id, created_at desc);

create table prompt_prompt_version (
  prompt_id text not null references prompt_prompt (id) on delete cascade,
  version_no integer not null,
  body text not null,
  user_id text not null,
  created_at text not null,
  primary key (prompt_id, version_no)
) strict;

-- prompt.record_version: every body a prompt ever had is a numbered version.
create trigger prompt_record_version_insert after insert on prompt_prompt
begin
  insert into prompt_prompt_version (prompt_id, version_no, body, user_id, created_at)
  values (new.id,
          coalesce((select max(version_no) from prompt_prompt_version where prompt_id = new.id), 0) + 1,
          new.body, new.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
end;
create trigger prompt_record_version_update after update of body on prompt_prompt
when new.body is not old.body
begin
  insert into prompt_prompt_version (prompt_id, version_no, body, user_id, created_at)
  values (new.id,
          coalesce((select max(version_no) from prompt_prompt_version where prompt_id = new.id), 0) + 1,
          new.body, new.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
end;

create table prompt_configuration (
  prompt_id text not null references prompt_prompt (id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  "values" text not null default '{}' check (json_valid("values") and json_type("values") = 'object'),
  sections text not null default '[]' check (json_valid(sections) and json_type(sections) = 'array'),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (prompt_id, name)
) strict;

create table prompt_tag (
  prompt_id text not null references prompt_prompt (id) on delete cascade,
  tag text not null check (length(tag) between 1 and 100),
  primary key (prompt_id, tag)
) strict;

create table prompt_usage (
  id text primary key,
  prompt_id text not null,
  version_no integer not null,
  config_name text,
  user_id text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key (prompt_id, version_no) references prompt_prompt_version (prompt_id, version_no) on delete cascade
) strict;
create index prompt_usage_prompt on prompt_usage (prompt_id);

create table prompt_usage_monthly_agg (
  prompt_id text not null,
  month text not null,
  copy_count integer not null default 0,
  primary key (prompt_id, month)
) strict;

create table intake_idea (
  id text primary key,
  parent_idea_id text references intake_idea (id),
  title text not null check (length(title) between 1 and 200),
  problem text not null default '',
  outcome text not null default '',
  notes text not null default '',
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  status text not null default 'draft' check (status in ('draft', 'idea', 'submitted_to_github')),
  source text not null default '',
  target_repo text check (target_repo is null or (target_repo glob '*/*' and target_repo not glob '*/*/*'
    and target_repo not glob '*[^A-Za-z0-9_./-]*')),
  idempotency_key text not null unique,
  github_issue_number integer check (github_issue_number > 0),
  github_issue_url text,
  submitted_at text,
  user_id text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  check (status = 'draft' or target_repo is not null),
  check ((status = 'submitted_to_github' and github_issue_number is not null and github_issue_url is not null
          and submitted_at is not null)
      or (status <> 'submitted_to_github' and github_issue_number is null and github_issue_url is null
          and submitted_at is null))
) strict;
create unique index intake_idea_one_issue_per_repo on intake_idea (target_repo, github_issue_number)
  where github_issue_number is not null;
create index intake_idea_parent on intake_idea (parent_idea_id);
create index intake_idea_status on intake_idea (status, updated_at desc);

-- intake.guard_idea_insert / guard_idea_update / guard_idea_delete
create trigger intake_idea_guard_insert before insert on intake_idea
begin
  select raise(abort, 'II-1: ideas are born draft') where new.status <> 'draft';
  select raise(abort, 'II-3: derivatives fork submitted ideas only; edit unsubmitted ideas in place')
  where new.parent_idea_id is not null
    and (select status from intake_idea where id = new.parent_idea_id) is not 'submitted_to_github';
end;
create trigger intake_idea_guard_update before update on intake_idea
begin
  select raise(abort, 'II-3: submitted ideas are immutable; create a derivative (parent_idea_id) instead')
  where old.status = 'submitted_to_github';
  select raise(abort, 'II-1: illegal status transition')
  where (old.status || '>' || new.status) not in ('draft>draft', 'draft>idea', 'idea>idea', 'idea>submitted_to_github');
end;
-- updated_at is stamped by services/platform-api on every update (the
-- original trigger's job); a self-updating trigger here would re-enter the
-- immutability guard right after a submit.
create trigger intake_idea_guard_delete before delete on intake_idea
begin
  select raise(abort, 'II-3: submitted ideas cannot be deleted') where old.status = 'submitted_to_github';
end;

create table intake_optimization (
  id text primary key,
  input_idea_id text not null references intake_idea (id) on delete cascade,
  output_idea_id text references intake_idea (id) on delete cascade,
  prompt_name text not null,
  model text not null,
  handler_run_id text,
  cost_usd real not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
create index intake_optimization_input_idea on intake_optimization (input_idea_id);
create index intake_optimization_output_idea on intake_optimization (output_idea_id);
