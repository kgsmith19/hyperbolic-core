-- netcheck local store. SQLite is the source of truth: it must accept writes
-- while the network is down, which is precisely when the data matters.
-- Postgres mirror of this schema: supabase/migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS hosts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  os         TEXT NOT NULL,
  first_seen TEXT NOT NULL
);

-- One row per tick, holding every layer's state at the same instant. The
-- diagnostic signal is which columns fail together, so they must share a row.
CREATE TABLE IF NOT EXISTS samples (
  id               INTEGER PRIMARY KEY,
  host_id          INTEGER NOT NULL REFERENCES hosts(id),
  ts               TEXT    NOT NULL,

  gw_state         TEXT, gw_ms         REAL, gw_loss   REAL,  -- your LAN / Wi-Fi
  hop_state        TEXT, hop_ms        REAL, hop_loss  REAL,  -- ISP first hop
  inet_state       TEXT, inet_ms       REAL, inet_loss REAL,  -- wider internet
  dns_router_state TEXT, dns_router_ms REAL,                  -- router DNS
  dns_public_state TEXT, dns_public_ms REAL,                  -- control: 1.1.1.1
  tls_state        TEXT, tls_ms        REAL,                  -- TLS to target
  http_state       TEXT, http_ms       REAL, http_code INTEGER,

  wifi_signal   INTEGER, wifi_channel INTEGER, wifi_band TEXT,
  wifi_rx_mbps  REAL,    wifi_tx_mbps REAL,    wifi_bssid TEXT,

  culprit          TEXT,             -- lan | isp | internet | router_dns | app
  synced           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_id, ts)
);
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);

-- Outages and idle-hold results: things that happen at a moment rather than
-- being sampled on a cadence.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  ts      TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  detail  TEXT,
  synced  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_id, ts, kind)
);

-- Errors scraped from LLM CLI transcripts, with the verdict from correlating
-- them against samples.
CREATE TABLE IF NOT EXISTS llm_errors (
  id      INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  ts      TEXT    NOT NULL,
  source  TEXT    NOT NULL,   -- claude-code | codex
  kind    TEXT    NOT NULL,   -- server | network | client
  detail  TEXT,
  verdict TEXT,               -- filled in by diagnose.correlate
  synced  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_id, ts, detail)
);
CREATE INDEX IF NOT EXISTS llm_errors_ts ON llm_errors (ts);

-- Where the incremental transcript scan left off, so rescans stay cheap and
-- never double-count.
CREATE TABLE IF NOT EXISTS scan_offsets (
  path   TEXT PRIMARY KEY,
  offset INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS env_scans (
  id      INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  ts      TEXT    NOT NULL,
  payload TEXT    NOT NULL,   -- JSON
  synced  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_id, ts)
);
