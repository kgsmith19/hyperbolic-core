-- LifeOS kernel on local SQLite (#512): the only kernel DDL. Life domains
-- plug in as type_definition rows, never as tables or columns here
-- (invariant 1). Ported from the four Supabase migrations' final state.
--
-- Declared column types drive kernel/db.py's converters: uuid -> UUID,
-- timestamptz -> datetime (stored as UTC ISO-8601 with microseconds, so text
-- order is time order), jsonb -> dict/list, boolean -> bool. Row-level
-- security is not ported: the kernel is reachable only through kernel
-- services in this process (invariant 7, ADR 008), and there is no PostgREST.

create table type_definition (
    id uuid primary key not null default (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    name text unique not null,
    domain text not null,
    json_schema jsonb not null check (json_valid(json_schema)),
    parent_type_id uuid null references type_definition (id),
    is_active boolean not null default 1,
    created_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now'))
);
create index type_definition_parent_type_id_idx on type_definition (parent_type_id);

create table entity (
    id uuid primary key not null default (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    name text null,
    attributes jsonb not null default '{}' check (json_valid(attributes)),
    created_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')),
    updated_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now'))
);
create index entity_created_at_idx on entity (created_at);

-- Full-text search over name + attributes text: the Postgres version's
-- generated `search` tsvector ('simple' config) becomes an FTS5 index kept
-- in step by triggers. unicode61 lowercases and splits on punctuation, as
-- 'simple' did; there is no stemming in either.
create virtual table entity_fts using fts5(entity_id unindexed, body);
create trigger entity_fts_insert after insert on entity begin
    insert into entity_fts (entity_id, body) values (new.id, coalesce(new.name, '') || ' ' || new.attributes);
end;
create trigger entity_fts_update after update of name, attributes on entity begin
    delete from entity_fts where entity_id = old.id;
    insert into entity_fts (entity_id, body) values (new.id, coalesce(new.name, '') || ' ' || new.attributes);
end;
create trigger entity_fts_delete after delete on entity begin
    delete from entity_fts where entity_id = old.id;
end;

create table entity_type (
    entity_id uuid not null references entity (id),
    type_id uuid not null references type_definition (id),
    primary key (entity_id, type_id)
);
create index entity_type_type_id_idx on entity_type (type_id);

create table edge (
    id uuid primary key not null default (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    from_entity uuid not null references entity (id),
    relation text not null,
    to_entity uuid not null references entity (id),
    attributes jsonb not null default '{}' check (json_valid(attributes)),
    valid_from timestamptz not null,
    valid_to timestamptz null,
    recorded_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')),
    superseded_at timestamptz null
);
create index edge_from_idx on edge (from_entity, relation);
create index edge_to_idx on edge (to_entity, relation);
create index edge_active_idx on edge (from_entity, to_entity) where valid_to is null and superseded_at is null;

-- event.entity_id's foreign key is checked at commit when a transaction
-- defers it (kernel/db.py defer_constraints), so a projection rebuild can
-- wipe and replay entities while events still reference them (invariant 2).
create table event (
    id uuid primary key not null default (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    entity_id uuid null references entity (id),
    event_type text not null,
    payload jsonb not null check (json_valid(payload)),
    valid_time timestamptz not null,
    recorded_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')),
    actor text not null
);
create index event_entity_recorded_idx on event (entity_id, recorded_at);

-- The event log is append-only (invariant 2). The single exception is payload
-- redaction inside a transaction that has switched lifeos_redacting() on,
-- which only kernel.services.privacy does (ADR 007), and even then nothing but
-- the payload may change. lifeos_redacting() is registered per connection by
-- kernel/db.py; a connection without it cannot update or delete events at all.
create trigger event_append_only_update before update on event
when not (lifeos_redacting()
          and new.id = old.id
          and new.entity_id is old.entity_id
          and new.event_type = old.event_type
          and new.valid_time = old.valid_time
          and new.recorded_at = old.recorded_at
          and new.actor = old.actor)
begin
    select raise(abort, 'event log is append-only (invariant 2): UPDATE rejected');
end;
create trigger event_append_only_delete before delete on event begin
    select raise(abort, 'event log is append-only (invariant 2): DELETE rejected');
end;

-- Derived, model-tagged, rebuildable; never source of truth (invariant 6).
-- Present and unused until an embedding job exists; vector is a float32 blob.
create table embedding (
    entity_id uuid not null references entity (id),
    model text not null,
    dim integer not null,
    vector blob null,
    created_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%f000+00:00', 'now')),
    primary key (entity_id, model)
);
