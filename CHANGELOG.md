# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`, bumped
with `python tools/release.py bump {major,minor,patch}` (see
`docs/DEPLOYMENT.md` for the full release process). Draft entries for a new
release with `python tools/release.py changelog`, which lists commit
subjects since the last tag — the entry itself still gets a human editorial
pass, not full automation.

## [Unreleased]

### Added
- `netcheck --version` (Phase 28).
- Automatic SQLite schema migration: an existing user's database now picks
  up columns added to `schema.sql` after they first installed, instead of
  silently missing them forever (Phase 28).
- `tools/release.py`: version bump + changelog-draft helper (Phase 28).
- `Dockerfile` / `.dockerignore` for container deployment (Phase 28).
- Dashboard: packet-loss/jitter trend chart, click-to-drill-down on ranked
  causes, JSON/CSV export, print-to-PDF (Phase 27).
- macOS backend for `environ.wifi()` via `airport -I` (Phase 26).
- Bounded retry on `probes.resolve()` for transient DNS failures (Phase 26).
- `netcheck/cache.py`: shared TTL cache; `nat_diagnostics`/`cgnat_diagnostics`
  now share one WAN-IP lookup instead of two (Phase 25).
- `all_diagnostics.AllDiagnostics.run_all()` now runs its seven phases
  concurrently (Phase 25).
- `tools/profile_diagnostics.py`: per-phase runtime/memory profiling
  (Phase 25).
- `docs/API.md`, `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md`,
  `docs/CONTRIBUTING.md`, rewritten `docs/ARCHITECTURE.md` (Phase 24).
- Restored `classify_latency`, `classify_latency_under_load`,
  `classify_packet_loss`, `detect_asymmetric_loss`, `find_path_mtu`,
  `diagnose_pmtud`, and `build_state_machine` in `diagnostic_engine.py` —
  canonical hypotheses #1-5, present in git history under Phase 1-4 commits
  but overwritten by later phases touching the same line range and lost
  from the codebase entirely (`OPEN-ISSUES.md` #12).
- `environ._asus_set()`: writes an NVRAM key/value pair to an ASUS router
  via `applyapp.cgi`, reusing `_asus_login`'s proven token auth
  (`OPEN-ISSUES.md` #13).
- `fix_application.FixApplier` now performs real, opt-in device writes:
  `host`/`user`/`password` (env-var fallback) and a `dry_run` flag
  defaulting to `True`. `disable_aiprotection()` writes and confirms the
  change via a fresh `environ.router()` read-back before ever reporting
  `applied`; `apply_wifi_channel_fix()`/`disable_qos()` report `attempted`
  (no proven read-back exists yet for those settings); `restart_device()`
  reports `requested`; the CAX80 modem and `local_config` report
  `unavailable` for every write (no known automated write path exists)
  (`OPEN-ISSUES.md` #13).
- `schema.sql`: new `fix_outcomes` table (one row per verified fix
  application, keyed by `fix_engine`'s `fix_id`), mirrored to Supabase in
  `supabase/migrations/0001_init.sql`.
- `store.record_fix_outcome()` / `store.fix_success_rate()`: real
  persistence for fix outcomes. `verification_engine.track_fix_success()`
  now accepts `conn`/`host` to persist an outcome after verifying a fix.
  `fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=...)` replaces
  each fix's hardcoded prior likelihood (`0.35`, `0.20`, etc.) with the real
  measured success rate once at least `MIN_MEASURED_FIX_SAMPLES` (3)
  outcomes exist for that `fix_id`; every `FixRecommendation` now carries
  `likelihood_source` (`"prior"` or `"measured"`) and `likelihood_samples`
  so a caller can tell which kind of number it's looking at
  (`OPEN-ISSUES.md` #14).
- `tests/test_e2e_faults.py`: real fault-injection e2e coverage for two
  more canonical hypotheses. #4 (MTU/PMTUD): shrinks loopback's actual
  interface MTU (`ip link set dev lo mtu 1000`) and confirms
  `environ.mtu()`'s descending DF-bit ping walk both correctly reports
  `unavailable` when none of its default candidate sizes fit, and finds
  the real limit when given sizes that bracket it. #9 (TLS handshake
  overhead): injects a real `tc netem` delay and confirms it shows up in a
  real TLS handshake against a local server, using a certificate generated
  fresh via the `openssl` CLI. `probes.tls_connect()` gained an optional
  `ctx` parameter (matching `idle_hold`'s existing one) so a test can
  trust that self-signed certificate explicitly (`OPEN-ISSUES.md` #15).

### Fixed
- `docs/DEVELOPMENT.md` told contributors to `pip install -e .` against a
  stdlib-only project with no `setup.py`/`pyproject.toml` (Phase 24).
- Seven diagnostic-module docstrings cited a hypothesis number that didn't
  match the canonical 15-hypothesis list (Phase 24).
- `OPEN-ISSUES.md` #6 (malformed `?limit=` crashing the server) was already
  fixed in code but never marked retired (Phase 27).
- `detect_happy_eyeballs()` ended with three unreachable lines referencing
  undefined names — a fragment of the lost MTU classifier spliced into the
  wrong function (`OPEN-ISSUES.md` #12).
- `tests/test_e2e_faults.py`'s acceptance tests for hypotheses #1, #3, and
  #7 injected a real fault via `tc netem` and then asserted `assertTrue(True,
  "...")`, with the real measurement assertion left as a comment. Rewritten
  to take a real measurement and assert against it (`OPEN-ISSUES.md` #12).
- That same file's `tc` capability check only verified `tc qdisc show`
  succeeded, which is true even when the `sch_netem` kernel module isn't
  available — a false positive that let three tests fail for real instead
  of skip. It now actually adds and removes a netem rule (`OPEN-ISSUES.md`
  #12).
- `environ.driver()`/`environ.tailscale()` built a PowerShell command by
  string-interpolating a caller-supplied value into the script text — a
  value containing a quote could escape and append arbitrary PowerShell.
  Not exploitable as wired (both call sites only ever pass their own
  literal defaults), but the parameters invited the bug. Values are now
  passed as trailing subprocess arguments and referenced via PowerShell's
  own `$args[0]` instead (`OPEN-ISSUES.md` #5).
- Dashboard: the "Recent samples" table gave no visual sign it had more
  columns to scroll to at narrow widths. Added a CSS-only scroll-shadow
  hint on both edges (`OPEN-ISSUES.md` #11).
- `fix_application.FixApplier`'s device-fix methods (`apply_wifi_channel_fix`,
  `disable_aiprotection`, `disable_qos`, `restart_device`,
  `get_device_status`) did no I/O at all and unconditionally reported
  `"applied"`/`"initiated"`/`"connected"` — running them against a real
  router would have claimed success while changing nothing. Rewritten to
  perform real, read-back-verified writes (`OPEN-ISSUES.md` #13).

### Removed
- `server.py`'s `dashboard_payload()`/`get_api_data()`/
  `get_api_configuration_snapshot()`/`get_api_diagnostic_history()` and
  `test_diagnostic_website.py`'s ~30 tests exercising them — a second,
  entirely disconnected dashboard API that returned hardcoded fabricated
  values (`wifi_mode: None`, `system_uptime: 0`, etc.) regardless of the
  real database, never reachable from `Handler.do_GET` or `ui.html`
  (`OPEN-ISSUES.md` #10).

## [1.0.0] — first tagged release

Consolidates Phases 1–23: the core probe/correlation engine, all 15
canonical failure hypotheses, the six Phase 16–21 additional diagnostic
modules (modem, NAT, CGNAT, Anthropic status, interference, router), the
unified `full-check` runner, and end-to-end fault-injection tests. See
`docs/ARCHITECTURE.md` for the full module map and `git log` for the
phase-by-phase history predating this file.
