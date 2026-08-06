# API Reference

Every function documented here is a pure function or a thin I/O wrapper around
one, per the rule in `AGENTS.md`: parsers take text and return a dict, so they
are testable without a network. Signatures are copied from source; defaults
shown are the real defaults. Fields marked `state` always take one of three
values — `ok`, `fail`, `unavailable` — never collapse the third into the
second (see `AGENTS.md`).

This is a reference, not a tutorial. For "how do I run this," see
`QUICKSTART.md`. For "which module explains my symptom," see
`TROUBLESHOOTING.md`.

## Module map

21 diagnostic modules split into six groups by what they do, plus one small
shared utility (`cache`):

| Group | Modules |
|---|---|
| Core probing & storage | `probes`, `environ`, `llmlog`, `store` |
| Correlation & ranking | `diagnose`, `diagnostic_engine` |
| Hypothesis-specific diagnostics | `wifi_diagnostics`, `modem_diagnostics`, `nat_diagnostics`, `cgnat_diagnostics`, `interference_diagnostics`, `router_diagnostics`, `anthropic_diagnostics` |
| Fixes | `fix_engine`, `fix_application` |
| Verification & monitoring | `verification_engine`, `monitoring_engine` |
| Runner, CLI, transport | `all_diagnostics`, `__main__`, `server` |
| Shared utility | `cache` |

---

## Core probing & storage

### `netcheck/probes.py` — per-tick measurement

Pure parsers over command output, plus the small amount of I/O needed to
gather that output. This is what runs every tick of `netcheck watch`.

- `parse_ping(text) -> dict` — loss and round-trip times from Windows or
  BSD/Linux `ping` output. Returns `{"loss_pct", "min_ms", "avg_ms", "max_ms"}`.
- `parse_wlan_interfaces(text) -> dict` — link state for the connected Wi-Fi
  interface from `netsh wlan show interfaces` (Windows).
- `parse_airport_info(text) -> dict` — link state from macOS's `airport -I`.
  Partial field mapping compared to the Windows parser (no signal
  percentage, no separate rx/tx rate, no radio-type string — those come back
  `None`). Built against Apple's documented format, not a live capture; see
  `OPEN-ISSUES.md` #9.
- `parse_wlan_networks(text, channel, own_bssid=None) -> dict` — counts
  competing radios near our channel, excluding our own AP.
- `ping(host, count=2) -> dict` — shells out and parses with `parse_ping`.
- `resolve(host, server=None, attempts=2, backoff_s=0.3) -> dict` — resolves
  `host`, optionally against a specific DNS server (used to compare router
  DNS against public DNS). Retries once on failure before reporting it — a
  single dropped UDP query is common and isn't itself evidence the resolver
  is broken.
- `tls_connect(host, port=443, timeout=8) -> dict` — real TLS handshake,
  timed.
- `http_check(host, path="/v1/models", timeout=10) -> dict` — one real HTTPS
  request. A 401 proves the whole path works end to end (auth is expected to
  fail without a key; reachability is what's being tested).
- `parse_traceroute(text, gateway_ip=None, target=None) -> dict` — first
  responding hop past the gateway.
- `first_hop(host="1.1.1.1", gateway_ip=None, max_hops=5, timeout=40) -> dict`
  — the first responding hop past the gateway: your ISP's edge.
- `gateway() -> str | None` — default gateway IP for this host.
- `idle_hold(host, port=443, seconds=90, ctx=None) -> dict` — holds a real TLS
  connection open and reports whether anything killed it before `seconds`
  elapsed. The one probe that reproduces a streaming response dying mid-flight.
- `sample(target="api.anthropic.com", gw=None, hop=None, public_dns="1.1.1.1", wifi=None) -> dict`
  — one tick: every layer measured close together, flattened into one row for
  `store.add_sample`.

### `netcheck/environ.py` — what this machine can tell us about its stack

- `wifi() -> dict` — SSID, BSSID, band, channel, RSSI, link rate, radio type.
  Dispatches on `probes.MACOS`: `airport -I` + `parse_airport_info` on macOS,
  `netsh wlan show interfaces` + `parse_wlan_interfaces` everywhere else.
- `congestion(channel, own_bssid=None) -> dict` — how many other radios
  contend for our airtime on the same or an overlapping channel. Windows
  only for now (`netsh wlan show networks`) — no macOS path yet, since
  `airport -s` requires disassociating on modern macOS, a poor fit for a
  passive scan (`OPEN-ISSUES.md` #9).
- `driver(name="Wi-Fi") -> dict` — adapter identity plus the settings that
  actually cause intermittent drops (power management, roaming
  aggressiveness, 802.11 mode).
- `events(hours=24) -> dict` — recent Windows event log entries; radio
  off/on pairs are the ones worth counting.
- `tcp_globals() -> dict` — OS-level TCP autotuning settings.
- `mtu(host="1.1.1.1", sizes=(1472, 1460, 1440, 1400, 1300, 1200)) -> dict` —
  walks the DF bit down the given sizes until a packet gets through
  (`+28` accounts for IP/ICMP headers).
- `tailscale(target="api.anthropic.com") -> dict` — whether a VPN tunnel
  captures the API route, or the DNS for it.
- `parse_docsis_status(js) -> dict` — parses a NETGEAR combo gateway's
  `DocsisStatusAdv.htm` JS payload (brace-matched function bodies, pipe-
  delimited rows; see `OPEN-ISSUES.md` #2 for why this is non-trivial).
- `modem(host=None, user=None, password=None) -> dict` — DOCSIS line quality:
  SNR, power levels, uncorrectable codewords. `unavailable` without
  `MODEM_HOST`/`MODEM_USER`/`MODEM_PASS`.
- `router(host=None, user=None, password=None) -> dict` — whether ASUS
  AiProtection/Trend Micro DPI is enabled, via the real token-auth flow
  (`_asus_login` + `_asus_get`; Basic Auth silently succeeds on ASUS gear
  without proving anything — see `OPEN-ISSUES.md` #3b). `unavailable`
  without `ROUTER_HOST`/`ROUTER_USER`/`ROUTER_PASS`.
- `scan() -> dict` — one full environment snapshot: everything above, in one
  call. This is what `netcheck scan` prints and `netcheck watch` stores once
  at startup.

### `netcheck/llmlog.py` — transcript scraping

- `classify(text, error_field=None) -> str` — buckets an error message as
  `network`, `server`, or `client`. Transport-level failures beat HTTP status
  codes when both are present.
- `parse_line(line, source) -> dict | None` — returns an error dict, or
  `None` if this JSONL entry is not a genuine API error. Keys on the
  `isApiErrorMessage` flag and `type: system` error objects — **never**
  substring-matches raw text (see `AGENTS.md` for why that overcounts ~200x).
- `scan(root, offsets, source="claude-code") -> (errors, new_offsets)` — reads
  only what's new since `offsets`, so repeated calls are cheap.
- `scan_all(offsets) -> (errors, new_offsets)` — scans every known LLM CLI
  transcript root (currently Claude Code's `~/.claude/projects/**/*.jsonl`).

### `netcheck/store.py` — SQLite source of truth

- `open_db(path) -> sqlite3.Connection` — opens/creates the DB, applies
  `schema.sql`, then runs `_migrate()`.
- `_migrate(conn)` — the upgrade path for existing users: adds any column
  `schema.sql` has that an already-existing on-disk table doesn't (via
  `ALTER TABLE ... ADD COLUMN`, diffed against a throwaway in-memory build
  of the current schema rather than a hand-rolled SQL parser). Added columns
  are always nullable, regardless of `schema.sql`'s `NOT NULL` — see
  `docs/DEPLOYMENT.md`.
- `host_id(conn, name, os_name) -> int` — upserts the host row, returns its id.
- `add_sample(conn, host, row)`, `add_event(conn, host, row)`,
  `add_error(conn, host, row)`, `add_scan(conn, host, payload)`,
  `record_fix_outcome(conn, host, fix_id, success, ts=None)` — inserts,
  each tagged with `host` and stamped for Supabase sync.
- `samples(conn, limit=5000)`, `errors(conn, limit=5000)`,
  `scans(conn, limit=20)`, `fix_success_rate(conn, fix_id) -> dict | None` —
  reads. `fix_success_rate` returns `{"n": int, "rate": float}` or `None` if
  no outcomes are recorded yet for that `fix_id`; `fix_engine` falls back to
  a documented prior below `MIN_MEASURED_FIX_SAMPLES` (3) real outcomes.
- `offsets(conn) -> dict`, `save_offsets(conn, new)` — the file-offset
  bookkeeping `llmlog.scan_all` needs to avoid re-reading old transcripts.
- `unsynced(conn, table, limit=500) -> list`, `mark_synced(conn, table, ids)`
  — the Supabase mirror's retry queue.
- `mirror(conn, url=None, key=None, host_name=None) -> dict` — pushes
  unsynced rows to Supabase PostgREST. Never blocks local capture: a failed
  push leaves rows unsynced, never marks them done.

### `netcheck/cache.py` — shared TTL cache (not a diagnostic module itself)

- `ttl_cache(seconds=30.0) -> decorator` — caches a callable's return value
  (including `None`) for `seconds`, keyed on its args/kwargs.
  `decorated_fn.cache_clear()` empties it. Used to dedupe identical
  network-bound lookups called from more than one module in the same run —
  e.g. `nat_diagnostics.get_wan_ip()` and `cgnat_diagnostics.get_wan_ip()`
  (the latter now just calls the former) share one `api.ipify.org` request
  instead of two.

---

## Correlation & ranking

### `netcheck/diagnose.py` — the lightweight, always-on ranker

This is what `netcheck diagnose` calls. It is deliberately small: pattern
matching over one row at a time, no historical confidence model. That model
lives in `diagnostic_engine.py`.

- `culprit(row) -> str | None` — names the layer that broke in a single
  sample row, or `None` if the row is healthy.
- `bursts(errors, gap_s=60) -> list[list]` — groups errors that arrived
  together; a single 20-second dropout throws several retries that should
  count as one event, not several.
- `correlate(errors, samples, window_s=WINDOW_S) -> list[dict]` — attaches a
  verdict (`your_side` / `far_side` / `unmonitored`) to each error from the
  network state within `window_s` seconds either side.
- `rank(samples, errors, scan) -> list[dict]` — ranked causes, most
  confident first, each with `cause`, `confidence`, `evidence`, `fix`.

### `netcheck/diagnostic_engine.py` — the full decision-tree engine

The heavyweight sibling: an ordered rule tree with historical confidence,
regression detection, and per-layer analysis helpers for the deeper
hypotheses (dual-stack, routing, TLS, buffering). Large module (60+
functions); grouped here by what each cluster answers.

**Core types**
- `TestState` (enum): `OK | FAIL | TIMEOUT | UNAVAILABLE`.
- `Culprit` (enum): `GATEWAY_FAILURE | ISP_FAILURE | DNS_ROUTER | DNS_GENERAL |
  INTERNET_UPSTREAM | TLS_INTERCEPTION | CONNECTION_REAPING | WIFI_MODE |
  WIFI_INTERFERENCE | ROUTER_DPI | MODEM_ISSUE | NONE`.
- `DiagnosticRule` — one rule (`id`, `priority`, `condition`);
  `should_run(results)` evaluates its condition through a recursive-descent
  parser, never `eval()` (`_safe_eval_condition`).
- `DiagnosticTree` — the ordered rule set. `get_rules_in_order()`,
  `get_rule(rule_id)`, `get_remaining_rules(results)`.
- `DiagnosisResult` — accumulates test outcomes: `add`, `get`, `clear`.
- `ConfigurationMatrix` — tracks every tested config, fix, and outcome across
  runs so confidence can be historical rather than single-sample. Notable
  methods: `record_test`, `suggest_next_tests`, `record_fix_applied`,
  `record_post_fix_outcome`, `detect_regression_in_field`,
  `calculate_improvement`, `calculate_confidence`, `detect_cascading_failure`.

**Top-level diagnosis**
- `get_diagnosis(results) -> Diagnosis`, `rank_hypotheses(results) -> list[dict]`
  — convert accumulated test results into a ranked hypothesis list.
- `calculate_confidence_from_history(history, culprit, fix_applied=False) -> float`
- `correlate_with_history(errors, samples) -> list[dict]`
- `capture_baseline_snapshot() -> dict`, `compare_snapshots(a, b) -> dict`,
  `detect_regressions(baseline, current, known_fixed_configs) -> list`,
  `check_state_changes(baseline, current) -> str`
- `generate_recommendation(diagnosis, matrix) -> dict`,
  `rank_recommendations(candidates) -> list[dict]` — "what to test/fix next,"
  ranked by ROI.

**Latency/jitter (canonical hypothesis #1/#2)**
- `classify_latency(pings) -> dict` — `{category, median, jitter, culprit,
  hypotheses, confidence}`. Categories (checked in order, first match wins):
  `stable_low`, `stable_medium`, `high_variance_high_latency`, `variable`,
  `stable_high` — every input lands in exactly one.
- `classify_latency_under_load(idle_pings, loaded_pings) -> dict` — buffer
  bloat: `differential_ms` over 100 between idle and loaded latency.

**Packet loss (canonical hypothesis #3)**
- `classify_packet_loss(results) -> dict` — `results` is a list of `"ok"`/
  `"fail"` strings; `{pattern, loss_rate, burst_length, hypotheses}`.
  `burst_loss` (≥3 consecutive drops) vs `steady_degradation` (spread out).
- `detect_asymmetric_loss(outbound_loss, inbound_loss) -> dict` — flags a
  path as asymmetric past a 5-percentage-point gap.

**MTU/PMTUD (canonical hypothesis #4)**
- `find_path_mtu(results) -> int | None` — largest successful size from a
  `{size: succeeded}` map, e.g. one gathered by `environ.mtu`'s live DF-bit
  walk.
- `diagnose_pmtud(packet_1500_df_result, icmp_fragmentation_needed_received) -> dict`
  — `working` / `broken` / `working_with_fragmentation`.

**TCP connection state (canonical hypothesis #5)**
- `build_state_machine(events) -> dict` — classifies a timestamped event
  list (`SYN_sent`, `SYN_ACK_received`, `ACK_sent`, `SYN_retransmit`,
  `RST_received`, `FIN_sent`/`FIN_received`, `timeout`) into `established`
  (with `handshake_rtt`), `rejected`/`reset`, `closed`, or `timed_out` (with
  the `timeouts` deltas and `syn_backoff` pattern flag). Pure function over
  already-captured events — nothing in this codebase captures real
  SYN/ACK/RST events live yet to feed it; see `OPEN-ISSUES.md` #12.

**Dual-stack (IPv4/IPv6)**
- `analyze_dual_stack(ipv4_result, ipv6_result) -> dict`
- `detect_happy_eyeballs(events) -> dict` (RFC 8305)
- `detect_dual_stack_preference(events) -> dict`
- `detect_nat64_translation(ipv6_addrs) -> dict`

**Routing**
- `analyze_routing_path(ipv4_path, ipv6_path) -> dict` — asymmetry between
  IPv4/IPv6 paths.
- `detect_route_flapping(events) -> dict`
- `classify_hop_latency(latencies) -> str`, `measure_hop_stability(hop_samples) -> dict`
- `detect_blackhole_route(path) -> dict` — no response, no error, no ICMP.

**TLS / application protocol**
- `measure_tls_handshake(events) -> dict`
- `detect_tls_version(handshake) -> str`, `detect_cipher_strength(cipher) -> str`
- `analyze_http_protocol(responses) -> dict`,
  `detect_connection_multiplexing(streams) -> dict`

**Buffer/queue**
- `detect_buffer_saturation(window_events) -> dict`
- `measure_queue_depth(packets) -> dict`
- `analyze_backpressure(events) -> dict`
- `classify_congestion_signal(metrics) -> str`
- `measure_buffer_efficiency(buffer_events) -> dict`

**Root-cause synthesis** (combines all layers into one verdict)
- `synthesize_diagnosis(layer_results) -> dict`
- `rank_root_causes(findings) -> list[dict]`
- `calculate_confidence_score(observations) -> float`
- `detect_cascade_failures(layer_states) -> dict` — one layer's failure
  explaining a downstream layer's failure, so the downstream one isn't
  double-counted as a separate cause.
- `generate_synthesis_report(synthesis, root_causes) -> dict`

---

## Hypothesis-specific diagnostics

`wifi_diagnostics.py` covers canonical hypothesis #15 ("WiFi/DFS" — see
`TROUBLESHOOTING.md`). The other six modules in this group (Phases 16-21)
are additions layered on top of the original 15-hypothesis list, not
numbered entries within it — despite some of their docstrings historically
claiming a `#N`, which did not match the canonical list and has been
corrected to cite the Phase number instead. Each exposes both free functions
(for unit testing against fixtures) and a `*Diagnostics` class (what
`all_diagnostics.py` calls). All network I/O in these modules degrades to
`state: unavailable` rather than raising when a credential, binary, or
interface is missing.

### `netcheck/wifi_diagnostics.py` — Wi-Fi radio layer (canonical hypothesis #15)
Functions: `get_wifi_interface()`, `get_current_ssid_and_bssid()`,
`get_signal_strength()`, `get_current_channel()`,
`is_dfs_channel(channel)`, `scan_available_networks()`,
`detect_band_steering(history)`, `detect_signal_instability(history, threshold_dbm=20, window_seconds=10)`.
Class `WiFiDiagnostics`: `sample_current_state()`, `detect_band_steering()`,
`detect_dfs_channel_warning()` (5 GHz channels 120–144 are DFS-affected and
can trigger radar-avoidance channel switches), `detect_signal_instability()`,
`check_interference()`.

### `netcheck/modem_diagnostics.py` — modem/DOCSIS (Phase 16 addition)
Functions: `get_modem_status_page(ip, timeout)`, `check_bridge_mode(timeout)`,
`detect_wan_ip()`.
Class `ModemDiagnostics`: `detect_modem_reachable()`,
`detect_signal_levels()`, `detect_bridge_mode()`,
`detect_uncorrectable_codewords()`.

### `netcheck/nat_diagnostics.py` — double NAT (Phase 17 addition)
Functions: `get_local_ip()`, `get_wan_ip()` (`@cache.ttl_cache`-decorated;
`cgnat_diagnostics.get_wan_ip` is this same function), `is_private_ip(ip)`,
`detect_double_nat()`.
Class `NATDiagnostics`: `detect_double_nat()`, `detect_nat_type()`
(open/moderate/strict), `get_network_topology()`.

### `netcheck/cgnat_diagnostics.py` — Carrier-Grade NAT (Phase 18 addition)
Functions: `get_wan_ip()` (re-exported from `nat_diagnostics`, same cached
lookup), `is_cgnat_ip(ip)` (100.64.0.0/10, RFC 6598).
Class `CGNATDiagnostics`: `detect_cgnat()`, `check_cgnat_implications()`.

### `netcheck/interference_diagnostics.py` — Wi-Fi interference (Phase 20 addition)
Class `InterferenceDiagnostics`: `scan_interference_sources()`,
`detect_channel_overlap()` (2.4 GHz only), `check_signal_quality()`.

### `netcheck/router_diagnostics.py` — router firmware/settings (Phase 21 addition)
Functions: `get_router_admin_url()`, `check_router_reachability()`.
Class `RouterDiagnostics`: `check_firmware_currency()`,
`check_qos_settings()`, `check_security_features()`,
`check_bridge_mode_setting()`, `check_band_steering()`,
`get_recommended_settings()`.

### `netcheck/anthropic_diagnostics.py` — far-side status (Phase 19 addition)
Functions: `check_anthropic_status()`, `check_api_endpoint(endpoint)`.
Class `AnthropicDiagnostics`: `check_service_status()`,
`check_api_connectivity()`, `check_incident_history()`. This is the module
that answers "is it even my network" — see the README's "Not your network"
row.

---

## Fixes

### `netcheck/fix_engine.py` — recommend, don't act
- `FixRecommendation` — a single actionable fix: instructions + metadata, no
  side effects. `likelihood` is a probability [0, 1]; `likelihood_source` is
  `"prior"` (this module's documented estimate) or `"measured"` (a real
  success rate from `store.fix_outcomes`); `likelihood_samples` is the
  outcome count backing a measured rate, `None` for a prior.
- `recommend_fixes_for_diagnosis(diagnosis, conn=None) -> list[FixRecommendation]`
  — pass an open `store.py` connection to have each fix's `likelihood`
  switched from its documented prior to a measured success rate once at
  least `store.MIN_MEASURED_FIX_SAMPLES` real outcomes exist for that
  `fix_id`. Without `conn` (or with too little history), the prior stands.
- `get_ethernet_test_setup() -> dict` — instructions for the highest-ROI
  manual test (wire in over Ethernet to rule out Wi-Fi entirely).
- `track_fix_application(fix, success)`

### `netcheck/fix_application.py` — actually apply fixes
`FixApplier(device_type, host=None, user=None, password=None, dry_run=True)`
— `host`/`user`/`password` fall back to `ROUTER_HOST`/`ROUTER_USER`/
`ROUTER_PASS` or `MODEM_HOST`/`MODEM_USER`/`MODEM_PASS` in `.env`, matching
`environ.router`/`environ.modem`. `dry_run` defaults to `True`: every method
below returns what it *would* write without sending anything until called
with `dry_run=False`.

Methods: `apply_wifi_channel_fix(channel, bandwidth)`, `disable_aiprotection()`,
`disable_qos()`, `restart_device()`, `get_device_status()`. All target the
ASUS router over its authenticated HTTP API (`environ._asus_login`/
`_asus_get`/`_asus_set`), never a local shell command. Every result's
`status` is one of:
- `unavailable` — no credentials, or the device type (CAX80 modem,
  `local_config`) has no known automated write path.
- `dry_run` — the default; nothing was sent.
- `applied` (+ `verified_by_readback: true`) — `disable_aiprotection()`
  only: the write is confirmed by re-reading `environ.router()` afterward
  and checking the value actually changed.
- `attempted` — the write's HTTP request succeeded, but no proven read-back
  exists yet to confirm the specific setting took effect (Wi-Fi channel/
  bandwidth, QoS), or `disable_aiprotection()`'s own read-back didn't
  confirm the change.
- `fail` — the login or write request itself failed.

The write wire format (NVRAM key names, `applyapp.cgi`'s payload shape) is
unverified against live hardware — see `OPEN-ISSUES.md` #13.
- `apply_fix_sequence(fixes, device_handlers) -> list[dict]` — applies a
  sequence with dependency resolution (e.g., don't disable QoS before
  confirming DPI is the more likely culprit).

---

## Verification & monitoring

### `netcheck/verification_engine.py` — did the fix work?
- `verify_fix_resolves_issue(before_diagnosis, fix, after_diagnosis) -> dict`
- `track_fix_success(fix_id, before_diagnosis, after_diagnosis, conn=None, host=None) -> dict`
  — pass `conn`/`host` to persist the outcome via `store.record_fix_outcome`,
  closing the loop back to `fix_engine.recommend_fixes_for_diagnosis`'s
  measured likelihoods. Omitted, nothing is persisted; the returned dict is
  unaffected either way.
- `compare_diagnostic_layers(before, after) -> dict` — which layers improved.
- `estimate_mttr(before, after) -> dict`

### `netcheck/monitoring_engine.py` — did it come back?
- `schedule_periodic_monitoring(interval_hours) -> dict`
- `detect_regression(baseline_diagnosis, current_diagnosis, sensitivity) -> dict`
- `track_diagnosis_history(diagnosis_snapshots, window_hours) -> dict`
- `predict_next_regression(diagnosis_history, fixed_culprit, recurrence_window_hours) -> dict`
- `generate_monitoring_report(baseline, current, history) -> dict`

---

## Runner, CLI, transport

### `netcheck/all_diagnostics.py` — unified runner
Class `AllDiagnostics` calls every hypothesis-specific module above and
flattens the result:
- `run_phase_16_modem()`, `run_phase_17_nat()`, `run_phase_18_cgnat()`,
  `run_phase_19_anthropic()`, `run_phase_20_interference()`,
  `run_phase_21_router()`, `run_phase_15_wifi()` — one hypothesis each,
  callable individually.
- `run_all() -> dict` — all seven, keyed by phase name, run concurrently via
  `concurrent.futures.ThreadPoolExecutor` (each phase is independent I/O, so
  wall time is bounded by the slowest phase rather than their sum — see
  `tools/profile_diagnostics.py`). This is what `netcheck full-check
  --format json` prints.
- `get_quick_diagnosis() -> str` — a short human-readable summary. This is
  what `netcheck full-check --format quick` prints.

The method names carry their historical development-order phase numbers
(15–21) from the git history. This is a different axis from the canonical
15-hypothesis list numbered in `test_e2e_faults.py` and `TROUBLESHOOTING.md`
— phase order is "the order these modules were built in," hypothesis number
is "which of the original 15 failure modes this addresses." Only
`wifi_diagnostics.py` (Phase 15) lands on a canonical hypothesis (#15,
WiFi/DFS); the Phase 16-21 modules are additions on top of the original 15,
not additional numbered entries within it.

### `netcheck/__main__.py` — CLI entry point
See `QUICKSTART.md` for usage. `main(argv=None) -> int` parses `sys.argv`
(or `argv` for tests) and dispatches to `cmd_probe`, `cmd_watch`,
`cmd_scan`, `cmd_diagnose`, `cmd_serve`, `cmd_sync`, or `cmd_full_check`.
`--version` prints `netcheck.__version__` and exits before subcommand
dispatch (works with no subcommand given).

### `netcheck/server.py` — dashboard transport
- `payload(conn, limit=500) -> dict` — everything the dashboard renders, in
  one round trip. This is the function actually behind `/api/data`.
- `Handler` — stdlib `BaseHTTPRequestHandler` subclass; `do_GET` routes
  `/api/data` (calls `payload()`) and serves `ui.html`/vendored Alpine for
  everything else. Malformed `?limit=` returns 400, not a crash.
- `serve(conn, port=8787) -> HTTPServer` — used by `netcheck serve`.
