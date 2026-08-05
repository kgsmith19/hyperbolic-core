# netcheck Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
> Executed inline in the main thread — this repo's standing instruction forbids
> dispatching implementation subagents.

**Goal:** A local-first network diagnostic that names *which layer* is breaking
Kyle's LLM API connections, by correlating simultaneous multi-layer probes
against the error timestamps already sitting in his Claude Code transcripts.

**Architecture:** A tick loop writes one row per interval containing every
layer's state at that instant (gateway, ISP hop, internet, router DNS, public
DNS, TLS, HTTP, Wi-Fi). Rules read *across* a row to name the culprit. A
separate scraper extracts LLM errors from `~/.claude/projects/**/*.jsonl` and
joins them to samples within ±120s. SQLite is the source of truth; Supabase is
an idempotent mirror. An Alpine.js single-file dashboard reads a stdlib HTTP
JSON API.

**Tech Stack:** Python 3.12 **stdlib only** — no pip, ever. `unittest` for
tests, `urllib.request` for the Supabase PostgREST mirror, `http.server` for
the dashboard. Alpine.js 3 vendored as a local file. Hand-written modern CSS.

## Global Constraints

- **Zero pip dependencies.** Anything requiring `pip install` is out of scope,
  including in tests. If a feature seems to need a package, find the stdlib
  path or drop the feature.
- **No silent fallbacks.** Every probe returns `state` ∈ `ok` | `fail` |
  `unavailable`. `unavailable` means *we could not measure* (missing
  credentials, absent binary, permission denied) and must never be stored or
  rendered as `fail`. Conflating them poisons the correlation rules.
- **Offline-capable dashboard.** No CDN, no remote font, no remote asset. It
  must render during the outage it is diagnosing.
- **Parsers are pure functions over text.** All command output parsing takes a
  string and returns a dict, so tests use captured fixtures and never shell
  out. This is also what makes a macOS backend additive later.
- **Test tier is fast + hermetic.** No network, no real LLM calls, no sleeps.
  Run with `python -m unittest discover -s tests -v`.
- Target host: `api.anthropic.com`. Gateway: auto-detected. Public DNS control:
  `1.1.1.1`.
- Secrets live in `.env`, which is gitignored. `.env.example` is committed.

---

## File Structure

| File | Responsibility |
|---|---|
| `netcheck/__main__.py` | CLI dispatch: `probe`, `watch`, `scan`, `diagnose`, `serve`, `sync` |
| `netcheck/probes.py` | Per-tick measurement + pure output parsers |
| `netcheck/environ.py` | Wi-Fi scan, driver/power settings, event log, modem, router |
| `netcheck/llmlog.py` | LLM transcript scrape, error classification, offset tracking |
| `netcheck/store.py` | SQLite schema + writes + Supabase mirror |
| `netcheck/diagnose.py` | Culprit rules, error correlation, ranked causes |
| `netcheck/server.py` | stdlib HTTP server + JSON API for the dashboard |
| `netcheck/ui.html` | Single-file Alpine dashboard |
| `netcheck/vendor/alpine.min.js` | Vendored Alpine 3 (no CDN) |
| `netcheck/schema.sql` | SQLite DDL |
| `supabase/migrations/0001_init.sql` | Postgres DDL, same logical schema |
| `tests/` | `test_probes.py`, `test_llmlog.py`, `test_diagnose.py`, `test_store.py` + `fixtures/` |

---

## Task 1: Store + schema

**Files:** Create `netcheck/store.py`, `netcheck/schema.sql`, `tests/test_store.py`

**Produces:** `open_db(path) -> Connection`, `add_sample(conn, row) -> int`,
`add_error`, `add_scan`, `add_event`, `unsynced(conn, table, limit) -> list`,
`mark_synced(conn, table, ids)`.

Tables: `hosts(id, name, os, first_seen)`, `samples(id, host_id, ts, …layer
columns…, synced)`, `events(id, host_id, ts, kind, detail, synced)`,
`llm_errors(id, host_id, ts, source, kind, detail, verdict, synced)`,
`env_scans(id, host_id, ts, payload, synced)`. Unique index on
`(host_id, ts)` per table so replay is idempotent.

- [ ] **Step 1:** Write `tests/test_store.py` — criterion 10: a sample written
      with no network reaches disk and reads back identically; criterion 9: a
      probe dict with `state='unavailable'` round-trips as `unavailable`, not
      `fail`.
- [ ] **Step 2:** Run `python -m unittest tests.test_store -v` → expect FAIL
      (`No module named 'netcheck.store'`).
- [ ] **Step 3:** Write `schema.sql` and `store.py`.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit.

## Task 2: Pure parsers

**Files:** Create `netcheck/probes.py` (parsers only),
`tests/fixtures/ping_win.txt`, `ping_unix.txt`, `wlan_interfaces.txt`,
`wlan_networks.txt`, `tests/test_probes.py`

**Produces:** `parse_ping(text) -> dict`, `parse_wlan_interfaces(text) -> dict`,
`parse_wlan_networks(text, channel) -> dict`.

`parse_ping` returns `{state, loss_pct, rtt_avg_ms, rtt_min_ms, rtt_max_ms}`.
`parse_wlan_interfaces` returns `{ssid, bssid, band, channel, signal_pct,
rx_mbps, tx_mbps, radio}`. `parse_wlan_networks` returns `{cochannel,
adjacent, total_bssids}` — cochannel counts *other* BSSIDs on the same channel.

Fixtures are captured from this machine's real output, including the actual
`netsh wlan show interfaces` block showing channel 44 / 802.11ac / 95%.

- [ ] **Step 1:** Capture fixtures from real commands; write the three parser
      tests (criteria 1, 2, 3), including a Windows *and* Unix ping fixture.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the parsers.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 3: Live probes + idle-hold

**Files:** Modify `netcheck/probes.py`; modify `tests/test_probes.py`

**Consumes:** parsers from Task 2. **Produces:** `ping(host, count)`,
`resolve(host, server=None)`, `tls_connect(host)`, `http_check(url)`,
`first_hop()`, `idle_hold(host, seconds)`, `sample(cfg) -> dict`.

`sample()` returns one flat row with the columns Task 1 stores. `first_hop()`
discovers the ISP hop once via traceroute and caches it to the DB.
`idle_hold` holds a real TLS connection open and reports `still_alive`,
`closed_by_peer`, `dropped`, or `connect_error` — this is the probe that
reproduces the Claude Code streaming-death symptom.

- [ ] **Step 1:** Write criterion 12 test — `idle_hold` against a *local*
      TLS server (stdlib `ssl` + self-signed cert generated in-test) that
      closes the connection after 1s reports `closed_by_peer`; one that holds
      reports `still_alive`. Hermetic, no external network.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the IO probes and `sample()`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 4: LLM error scraper

**Files:** Create `netcheck/llmlog.py`, `tests/fixtures/transcript.jsonl`,
`tests/test_llmlog.py`

**Produces:** `classify(detail, status) -> str|None` returning `server` |
`network` | `client` | `None`; `scan(root, offsets) -> (errors, new_offsets)`.

`server`: 429, 500, 502, 503, 529, `overloaded_error`, `rate_limit`.
`network`: `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `socket hang up`,
`fetch failed`, `ENOTFOUND`, `EAI_AGAIN`, TLS failures.
`client`: 400, 401, 403, context-length.

- [ ] **Step 1:** Write tests for criterion 4 (each signature → right bucket),
      criterion 5 (**adversarial**: a transcript line containing the literal
      text `"cost was 529 tokens"` and a line with `id: "req_5290"` must NOT be
      counted as errors — this is the bug in the original grep-based estimate),
      criterion 6 (second scan from a stored offset yields zero duplicates).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Parse each line as JSON and read the status/error
      type field; never substring-match a bare number against raw line text.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 5: Diagnosis engine

**Files:** Create `netcheck/diagnose.py`, `tests/test_diagnose.py`

**Consumes:** sample rows (Task 1/3), errors (Task 4).
**Produces:** `culprit(row) -> str|None`, `correlate(errors, samples,
window_s=120) -> list`, `rank(samples, errors, scans) -> list`.

`culprit` returns `lan` | `isp` | `internet` | `router_dns` | `app` | `None`,
per the rule table in the spec. `rank` emits
`{cause, confidence, evidence, fix}` ordered by confidence.

- [ ] **Step 1:** Write table-driven tests: criterion 7 (each rule fires on its
      row shape **and only** its row shape — includes the router-DNS case:
      pings ok, `dns_router` fail, `dns_public` ok); criterion 8 (boundary —
      an error at exactly 120s correlates, at 121s does not); criterion 9
      (a row with `unavailable` fields never produces a false culprit).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 6: Environment scan

**Files:** Create `netcheck/environ.py`; modify `tests/test_probes.py`

**Produces:** `scan() -> dict` with keys `wifi`, `channel_congestion`,
`driver`, `power`, `tcp_globals`, `events`, `mtu`, `tailscale`, `modem`,
`router`.

Credential-gated sections (`modem`, `router`) return
`{"state": "unavailable", "reason": "no credentials"}` when `.env` lacks them —
never an exception, never a fake success. Driver section flags the known
offenders explicitly: adapter power-saving enabled, "allow the computer to turn
off this device", roaming aggressiveness, and 802.11 mode below card
capability.

- [ ] **Step 1:** Write test — a credential-gated section with no credentials
      yields `state='unavailable'` with a reason, and `rank()` never cites an
      `unavailable` section as evidence.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 7: CLI + server + dashboard

**Files:** Create `netcheck/__main__.py`, `netcheck/server.py`,
`netcheck/ui.html`, `netcheck/vendor/alpine.min.js`

**Consumes:** everything above.

API: `GET /api/summary` (ranked causes + live layer status),
`GET /api/samples?range=`, `GET /api/errors`, `GET /api/scans`,
`POST /api/scan`, `POST /api/idle`.

Dashboard: layer status pills, ranked-causes card, inline-SVG timeline with
outage bands, filterable LLM error table, raw sample table, action buttons.
Dark/light via `light-dark()`.

- [ ] **Step 1:** Write criterion 13 test — server started against a seeded
      temp DB returns well-formed JSON on every GET route, and `ui.html`
      references no `http://` or `https://` asset URL (assert by reading the
      file — this is the offline guarantee, and a regression here is silent).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement CLI, server, and dashboard. Vendor Alpine.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 8: Supabase mirror

**Files:** Create `supabase/migrations/0001_init.sql`; modify
`netcheck/store.py`; modify `tests/test_store.py`

**Produces:** `mirror(conn, cfg) -> dict` — batches unsynced rows to PostgREST
via `urllib.request` with `Prefer: resolution=ignore-duplicates`, marks them
synced. No-op returning `{"state": "unavailable", "reason": ...}` when
unconfigured.

- [ ] **Step 1:** Write criterion 11 test — point `mirror` at a local
      `http.server` stub; replaying the same batch inserts nothing new and
      leaves `synced` flags correct. Also assert `mirror` with no config is a
      clean no-op that does not raise and does not mark rows synced.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Write the Postgres migration (RLS enabled on every table);
      apply it to project `crqhkqmrkhmfnrhtczlf`; implement `mirror`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 9: Docs + ship

**Files:** Create `AGENTS.md`, `README.md`, `OPEN-ISSUES.md`, `.env.example`,
`.gitignore`

- [ ] **Step 1:** `AGENTS.md` (front door: stack, commands, standards, per this
      machine's convention), `README.md` (what it measures and how to read the
      output), `.env.example`, `.gitignore` (`.env`, `*.db`, `__pycache__`).
- [ ] **Step 2:** Run the full suite → all green.
- [ ] **Step 3:** Run `netcheck scan` and `netcheck diagnose` for real on this
      machine; record actual findings in the README.
- [ ] **Step 4:** `git init`, commit, create the GitHub repo, push `main`.

---

## Test Contract Matrix

| # | Criterion | Task | Test |
|---|---|---|---|
| 1 | Ping parses on Windows + Unix | 2 | `test_probes` |
| 2 | `netsh wlan` parses to Wi-Fi fields | 2 | `test_probes` |
| 3 | Co-channel count correct | 2 | `test_probes` |
| 4 | Error signatures map to right bucket | 4 | `test_llmlog` |
| 5 | Bare `529` substring is NOT an error | 4 | `test_llmlog` |
| 6 | Incremental scan resumes, no dupes | 4 | `test_llmlog` |
| 7 | Each culprit rule fires only on its shape | 5 | `test_diagnose` |
| 8 | Correlation honours the ±120s boundary | 5 | `test_diagnose` |
| 9 | `unavailable` ≠ `failed` end to end | 1, 5, 6 | `test_store`, `test_diagnose` |
| 10 | SQLite writes with network down | 1 | `test_store` |
| 11 | Supabase sync is idempotent | 8 | `test_store` |
| 12 | Idle-hold distinguishes close vs alive | 3 | `test_probes` |
| 13 | Dashboard renders offline from seeded DB | 7 | `test_server` |

Every criterion has a test; every test proves a criterion.

## Self-Review

- **Spec coverage:** every spec section maps to a task — probes→2/3,
  environment→6, LLM correlation→4/5, diagnosis→5, UI→7, Supabase→8,
  error-handling convention→Global Constraints + tasks 1/6, out-of-scope items
  absent as intended.
- **Placeholders:** none. Every step names its files, its assertion, and its
  expected failure.
- **Type consistency:** `state` is the outcome key everywhere (never `success`
  or `ok` as a bare bool — the original `net_diag.py` used `success`, and
  carrying that over would collapse `unavailable` into `fail`). `culprit`
  returns the same string set the UI pills render and `rank` cites.
