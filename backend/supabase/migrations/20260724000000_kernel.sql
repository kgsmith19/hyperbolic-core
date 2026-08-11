-- 0001 kernel: the only kernel DDL. Life domains plug in as type_definition
-- rows, never as tables or columns here (invariant 1).

create extension if not exists vector with schema extensions;

create table type_definition (
    id uuid primary key default gen_random_uuid(),
    name text unique not null,
    domain text not null,
    json_schema jsonb not null,
    parent_type_id uuid null references type_definition (id),
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create table entity (
    id uuid primary key default gen_random_uuid(),
    name text null,
    attributes jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    search tsvector generated always as (
        to_tsvector('simple', coalesce(name, '') || ' ' || (attributes::text))
    ) stored
);
create index entity_attributes_gin on entity using gin (attributes jsonb_path_ops);
create index entity_created_at_idx on entity (created_at);
create index entity_search_gin on entity using gin (search);

create table entity_type (
    entity_id uuid not null references entity (id),
    type_id uuid not null references type_definition (id),
    primary key (entity_id, type_id)
);

create table edge (
    id uuid primary key default gen_random_uuid(),
    from_entity uuid not null references entity (id),
    relation text not null,
    to_entity uuid not null references entity (id),
    attributes jsonb not null default '{}'::jsonb,
    valid_from timestamptz not null,
    valid_to timestamptz null,
    recorded_at timestamptz not null default now(),
    superseded_at timestamptz null
);
create index edge_from_idx on edge (from_entity, relation);
create index edge_to_idx on edge (to_entity, relation);
create index edge_active_idx on edge (from_entity, to_entity)
    where valid_to is null and superseded_at is null;

-- entity FK is deferrable so projection rebuild can wipe and replay entities
-- inside one transaction while events still reference them (invariant 2).
create table event (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid null references entity (id) deferrable initially immediate,
    event_type text not null,
    payload jsonb not null,
    valid_time timestamptz not null,
    recorded_at timestamptz not null default now(),
    actor text not null
);
create index event_entity_recorded_idx on event (entity_id, recorded_at);

create function event_append_only() returns trigger language plpgsql as $$
begin
    raise exception 'event log is append-only (invariant 2): % rejected', tg_op;
end;
$$;

create trigger event_append_only_row
    before update or delete on event
    for each row execute function event_append_only();
create trigger event_append_only_stmt
    before truncate on event
    for each statement execute function event_append_only();

-- Derived, model-tagged, rebuildable; never source of truth (invariant 6).
-- Present and unused until an embedding job exists.
create table embedding (
    entity_id uuid not null references entity (id),
    model text not null,
    dim int not null,
    vector extensions.vector null,
    created_at timestamptz not null default now(),
    primary key (entity_id, model)
);
