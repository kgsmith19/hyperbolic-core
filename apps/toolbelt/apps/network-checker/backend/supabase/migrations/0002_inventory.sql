-- Device and configuration inventory: Postgres mirror of network_checker/schema.sql's
-- device / interface / config_item / config_current. See that file for the
-- SQLite source of truth and its column-level comments; only where the
-- Postgres shape deliberately differs is explained here.
--
-- device is keyed by (host, mac, ip) rather than mirroring SQLite's local
-- integer `id`, for the same reason `hosts` is keyed by name: several
-- machines can push into this project, each with its own independent local
-- autoincrement sequence, so a local id has no meaning once more than one
-- host writes here ("Local integer ids are meaningless remotely", store.py
-- `_for_remote`).
--
-- interface and config_item name their device the same way, by
-- (host, device_mac, device_ip), instead of a device_id foreign key. A
-- local device_id is exactly the same kind of per-SQLite-database integer
-- as hosts.id -- meaningless, and silently wrong, once compared across two
-- machines' local databases. There is also no cheap way to learn the
-- *remote* surrogate id a device row was assigned: the existing push,
-- store.py's `_push`, POSTs with `Prefer: return=minimal` and never reads a
-- response body. The device's own natural key travels with every row that
-- needs to name it instead, exactly as `host` already stands in for
-- `host_id` on every other mirrored table.
--
-- Not yet wired into store.py's SYNCED_TABLES / mirror() push loop: these
-- three tables are additive schema only, matching this project's existing
-- posture that the mirror stays optional and safe left unconfigured (05-f
-- section 3, gate question 3). Wiring the push is future work once the
-- natural-key lookup above has a live project to validate it against.

create table if not exists device (
  id         bigserial primary key,
  host       text not null,
  mac        text,
  ip         text,
  kind       text not null default 'unknown',
  name       text,
  vendor     text,
  first_seen timestamptz not null,
  last_seen  timestamptz not null,
  unique (host, mac, ip)
);

create table if not exists interface (
  id          bigserial primary key,
  host        text not null,
  device_mac  text,
  device_ip   text,
  name        text not null,
  medium      text,
  speed_mbps  double precision,
  observed_at timestamptz not null,
  unique (host, device_mac, device_ip, name, observed_at)
);

create table if not exists config_item (
  id          bigserial primary key,
  host        text not null,
  device_mac  text,
  device_ip   text,
  key         text not null,
  value       text,
  observed_at timestamptz not null,
  source      text not null,
  unique (host, device_mac, device_ip, key, observed_at)
);
create index if not exists config_item_device_key_idx
  on config_item (host, device_mac, device_ip, key, observed_at);

-- Latest value per (host, device, key): the Postgres-side equivalent of
-- SQLite's config_current. IS NOT DISTINCT FROM, not `=`: device_mac is
-- NULL for a device network-checker never resolved a hardware address for (the
-- same FR-017 case schema.sql's device.mac comment documents), and plain
-- `=` never matches a NULL against anything, including another NULL.
--
-- CREATE OR REPLACE, not IF NOT EXISTS: unlike CREATE TABLE/INDEX, Postgres
-- has no IF NOT EXISTS form for CREATE VIEW. OR REPLACE is idempotent the
-- same way IF NOT EXISTS is elsewhere in this file -- safe to run again --
-- provided the column list never shrinks or is reordered, which a future
-- change to this view must preserve or must DROP VIEW first instead.
create or replace view config_current as
  select c.host, c.device_mac, c.device_ip, c.key, c.value, c.observed_at, c.source
  from config_item c
  where c.observed_at = (
    select max(c2.observed_at) from config_item c2
    where c2.host = c.host
      and c2.device_mac is not distinct from c.device_mac
      and c2.device_ip is not distinct from c.device_ip
      and c2.key = c.key
  );

-- RLS on with no permissive policy, matching every other table in this
-- project: only the service role (held locally in .env, never committed)
-- reaches these tables.
alter table device      enable row level security;
alter table interface   enable row level security;
alter table config_item enable row level security;
