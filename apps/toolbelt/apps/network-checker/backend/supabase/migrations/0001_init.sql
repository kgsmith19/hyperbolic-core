-- netcheck remote mirror.
--
-- This is a mirror, never the source of truth: a cloud database cannot record
-- an outage while the outage is happening. SQLite captures, this receives.
--
-- Keyed by host *name* rather than a synthetic id so several machines (the
-- Surface and the Mac) can push into one history without coordinating ids.
-- Every table is unique on (host, ts), which makes the push idempotent and
-- therefore safe to retry after the link comes back.

create table if not exists hosts (
  name       text primary key,
  os         text not null,
  first_seen timestamptz not null default now()
);

create table if not exists samples (
  id   bigserial primary key,
  host text        not null,
  ts   timestamptz not null,

  gw_state         text, gw_ms         double precision, gw_loss   double precision,
  hop_state        text, hop_ms        double precision, hop_loss  double precision,
  inet_state       text, inet_ms       double precision, inet_loss double precision,
  dns_router_state text, dns_router_ms double precision,
  dns_public_state text, dns_public_ms double precision,
  tls_state        text, tls_ms        double precision,
  http_state       text, http_ms       double precision, http_code integer,

  wifi_signal  integer, wifi_channel integer,          wifi_band  text,
  wifi_rx_mbps double precision, wifi_tx_mbps double precision, wifi_bssid text,

  culprit text,
  unique (host, ts)
);
create index if not exists samples_ts_idx      on samples (ts desc);
create index if not exists samples_culprit_idx on samples (culprit) where culprit is not null;

create table if not exists events (
  id     bigserial primary key,
  host   text        not null,
  ts     timestamptz not null,
  kind   text        not null,
  detail text,
  unique (host, ts, kind)
);

create table if not exists llm_errors (
  id      bigserial primary key,
  host    text        not null,
  ts      timestamptz not null,
  source  text        not null,   -- claude-code | codex
  kind    text        not null,   -- server | network | client | unknown
  detail  text,
  verdict text,                   -- lan | isp | internet | router_dns | app
                                  -- | not_local | unexplained | unmonitored
  unique (host, ts, detail)
);
create index if not exists llm_errors_ts_idx   on llm_errors (ts desc);
create index if not exists llm_errors_kind_idx on llm_errors (kind);

create table if not exists env_scans (
  id      bigserial primary key,
  host    text        not null,
  ts      timestamptz not null,
  payload jsonb       not null,
  unique (host, ts)
);

-- One row per verified fix outcome. The local SQLite table and reader this
-- mirrored (fix_engine.py and its callers) were removed 2026-08 as
-- unreachable code; this table is kept only as historical record, not as
-- an active mirror target.
create table if not exists fix_outcomes (
  id      bigserial primary key,
  host    text        not null,
  ts      timestamptz not null,
  fix_id  text        not null,
  success integer     not null,  -- 0 or 1, matching the local SQLite column
                                 -- (no native boolean type there); kept as
                                 -- integer here too rather than boolean so a
                                 -- mirrored row inserts without a cast error
  unique (host, ts, fix_id)
);
create index if not exists fix_outcomes_fix_id_idx on fix_outcomes (fix_id);

-- RLS on with no permissive policy: only the service role reaches these tables,
-- and the service key lives in .env on the machine doing the pushing. Adding a
-- read policy later is a deliberate act rather than an accident of setup.
alter table hosts        enable row level security;
alter table samples      enable row level security;
alter table events       enable row level security;
alter table llm_errors   enable row level security;
alter table env_scans    enable row level security;
alter table fix_outcomes enable row level security;
