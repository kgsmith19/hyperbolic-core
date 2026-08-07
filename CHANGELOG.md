# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`, bumped
with `python tools/release.py bump {major,minor,patch}` (see
`netcheck/docs/DEPLOYMENT.md` for the full release process). Draft entries for a new
release with `python tools/release.py changelog`, which lists commit
subjects since the last tag — the entry itself still gets a human editorial
pass, not full automation.

## [Unreleased]

### Security
- Device credentials are no longer sent off the local network (#30, FR-014).
  Modem and router logins travel as HTTP Basic and as a plaintext login
  header over `http://`, which is all these devices speak and an accepted
  risk on a LAN. It was never an accepted risk off one, and a single wrong
  digit in `MODEM_HOST` was enough to post the modem password to a stranger,
  in the clear, on every scan. The host is now resolved first and **every**
  address it answers with must be private -- a name answering with both a
  LAN and a public address, which is the shape of DNS rebinding, is refused.
  A refused host reads `unavailable` naming the variable to fix, never
  `fail`: nothing about the device was measured.

### Added
- Ranked causes now name the script that fixes them, where one exists (#31).
  `tools/fix_dns.sh` and its siblings have been in the repo the whole time,
  fixing three of the causes `diagnose` already names, and nothing connected
  the two -- the user read "set the adapter's DNS to 1.1.1.1" and did it by
  hand. The invocation is generated from a table checked against the
  filesystem in both directions, so a renamed or deleted script cannot leave
  a fix quietly recommending it. `run_fixes.sh --dry-run` is offered first;
  the individual `fix_*.sh` do not take that flag, which is why the wrapper
  is what gets named.
- `scripts/delete-merged-branches.ps1` -- deletes the remote branches whose
  work is already in `main`, verifying each against `ls-remote` before and
  after so a partial run is safe to repeat. Supports `-WhatIf`.

### Added
- IPv4-vs-IPv6 isolation (`netcheck/dualstack.py`, FR-013). Happy Eyeballs
  races the two families and returns whichever answers first, so a wholly
  broken family shows up only as occasional extra latency on a connection
  that still succeeds -- indistinguishable from "the network is slow today"
  unless something measures each family on its own. `scan()` gains a
  `dual_stack` section and `rank()` gains `broken_ipv6` / `broken_ipv4`,
  which fire only when the *other* family succeeded.

  Three states, not two, and both "could not measure" cases are real: the
  target having no AAAA record is its DNS, not our stack; and this host
  having no IPv6 stack at all is IPv6 switched off, which is not IPv6
  broken. Neither is ever cited as a cause.

  Deliberately not `socket.create_connection`: it re-resolves the hostname
  and can return the other family, quietly measuring the thing the probe
  exists to isolate. The socket is opened on the requested family and the
  `sockaddr` passed through whole -- IPv6's is a 4-tuple carrying flowinfo
  and a scope id, and truncating it to `(host, port)` raised `ValueError`
  against a real target.

### Fixed
- `dns_router_ms` reading exactly `0.0` on every tick (#28). The cause was the
  clock, not the resolver: before Python 3.11, `time.monotonic()` on Windows
  was `GetTickCount64` with ~15.6 ms resolution, so a real 1-3 ms query
  started and finished inside a single tick. Every short-duration measurement
  (`resolve`, `tls_connect`, `http_check`, the new dual-stack connect) now
  uses `time.perf_counter()`, which is the documented clock for exactly this
  and uses the high-resolution counter on every version. `idle_hold`'s
  90-second loop and `watch`'s interval keep `monotonic()`, which is the right
  tool for "has enough wall time passed".

- `_resolve_via` accepted any UDP packet arriving on its ephemeral port as
  the answer: the query id was the constant `0x1234` and the reply's id was
  never checked, nor was the QR bit. `watch` asks the same server the same
  question every tick, so a late reply to the previous tick satisfied the
  current one -- reporting the router's resolver as healthy on the strength
  of a stale packet, which is the opposite of what this tool is for. Each
  query now carries a fresh random id and the reply must match it and be a
  response.

### Changed
- `diagnose.py` split into `diagnose.py` (culprit for one row, correlation,
  bursts) and `rank.py` (`_SCAN_RULES`, `_FIXES`, the ranked report),
  matching the seam the tests already had. `probes.py` split again to give
  `dualstack.py` its own module, alongside `resolver.py` and `route.py`.

### Changed
- `netcheck diagnose` now ranks the standing conditions an environment scan
  measures alongside the faults measured over time, in one list. New causes:
  `anthropic_incident`, `double_nat`, `cgnat`, `modem_signal`, `router_dpi`,
  `radio_drops`, `wifi_congestion`, `dfs_channel`, `tailscale_in_path`,
  `low_mtu`. Each carries evidence and a fix, and appears on the dashboard
  without any UI change. Adding another is a row in `diagnose._SCAN_RULES`.
- `environ.scan()` gained two sections: `wan` (the address the internet sees
  us as, classified for double NAT and RFC 6598 carrier NAT) and `anthropic`
  (the provider's declared status). Both degrade to a state, never raise.

### Removed
- The `netcheck full-check` command and the eight modules behind it
  (`all_diagnostics`, `wifi_`/`modem_`/`nat_`/`cgnat_`/`anthropic_`/
  `interference_`/`router_diagnostics`, `cache`). They were a second
  measurement path reachable from one undocumented command, never surfaced
  in `diagnose` or the dashboard, and much of it measured nothing:
  `router_diagnostics` returned hardcoded advice from five of its six
  methods, `modem_diagnostics.detect_modem_reachable()` ignored `ping`'s exit
  code (reporting an unreachable modem as reachable) and re-implemented the
  DOCSIS parsing `docsis.py` already does properly with credentials,
  `detect_wan_ip()` had no callers, and every class set `self.id`/`self.name`
  that nothing read. The measurements that were real are now scan sections
  and ranked causes.
- `tools/profile_diagnostics.py`, which profiled only the removed runner.
- `tests/test_e2e_faults.py`. Eleven of its twelve tests skipped on any
  machine without `CAP_NET_ADMIN` and the `sch_netem` module — which is every
  container and every CI runner this project uses — and one of them called
  `diagnose.classify_latency()`, a function that has never existed, so it
  could not have passed even where it ran. `environ.mtu()`'s descending walk
  was the only behaviour it uniquely covered; that now has a hermetic test
  in `test_environ.py::MtuWalkTest`, mutation-verified against two ways of
  breaking the walk. The suite now reports zero skips.
- `tools/fixer.py`, `tests/test_fixer.py`, and
  `.github/workflows/fixer-validation.yml`. `fixer.py` was a second, broken
  implementation of the three fixes `tools/fix_*.sh` already perform: every
  command in it was a shell string (`"cat /etc/resolv.conf"`, `"ip route |
  grep default"`) passed to `subprocess.run(shell=False)`, so any real
  invocation died with `FileNotFoundError` before doing anything. Both gates
  that "validated" it only ran it under `--dry-run`, which returns before
  executing, so both passed against code that could not work. It also
  shipped a `rollback_all()` that logged "Restoring ..." and restored
  nothing, and a Linux Wi-Fi "fix" that ran `iw phy phy0 set netns ...` --
  moving the adapter into another network namespace, which is not a mode
  change and would break networking if it had ever run. FR-012 is delivered
  by the shell scripts, which work and have a real `--dry-run`.
- `netcheck/docs/` (seven files, 1,075 lines). A second documentation tree
  restating README, AGENTS.md, and `docs/`, which `rules/04-DOCS.md` forbids
  ("a fact lives in exactly one document; duplicated facts diverge, always").
  They had already diverged: `API.md` documented `wifi_diagnostics.
  get_wifi_interface()` and `scan_available_networks()`, which never existed
  in this codebase, and gave `diagnose.correlate()` the verdicts
  `your_side`/`far_side`, which it has never returned. The deployment and
  release content was real and unique, and is now
  `docs/notes/2026-08-07-deploying-and-releasing-netcheck.md`; "adding a
  diagnostic" and the gate command moved to `AGENTS.md`. There is
  deliberately no hand-written API reference now — the docstrings are it.
- `docs/notes/2026-08-04-netcheck-implementation-plan.md`: a build checklist
  with all 44 boxes still unticked for a tool that shipped days earlier,
  naming modules (`net_diag.py`, `OPEN-ISSUES.md`) that no longer exist.
- `.github/workflows/status-checks.yml`, which echoed "Check Actions tab"
  three times and always passed.
- 297 lines of `tools/README.md` (387 -> 90). It carried two Quick Start
  sections and two CI Integration sections for the same scripts, a "Future
  Enhancements" list (`rules/04-DOCS.md`: docs describe what is true now), a
  JSON output example no shell script emits, and a "Backup & Rollback -
  original state saved, all changes reversible" claim true only of
  `fix_dns.sh`. The rewrite says rollback is DNS-only, which is what the
  scripts do.
- `environ._asus_set()` and its tests. A write path to router NVRAM that no
  command reached, whose own docstring said "UNVERIFIED against a live device
  from this codebase". PRD OOS-001 puts automated device writes out of scope
  precisely because "a wrong automated write to networking hardware can take a
  household offline with no easy recovery" — this was the last piece of that
  capability still in the tree.

### Added
- `tools/code_simplification.py` now checks file length. `MAX_FILE_LOC: 250`
  was declared in `rules/01-BUDGETS.md` and enforced by nothing, so five files
  had drifted over it unnoticed. All are now under.

### Fixed
- `test_rank.py`'s two guard tests — the ones asserting that `unavailable`
  and `fail` sections are never cited as causes, which is the most
  load-bearing rule in the codebase — passed for the wrong reason. Their
  input sections carried only `state` and `reason`, so the rule predicates
  read the fault fields as `None` and declined regardless. Mutation-verified:
  deleting the state gate entirely left both green. They now pass sections
  that carry the fault fields *and* a non-`ok` state, so only the gate can
  suppress them, and removing it turns both red.
- README told users to `cp .env.example`, a file that does not exist and
  never will: `docs/SYSTEM-REQUIREMENTS.md` records the deliberate decision
  not to ship one, and `.gitignore` ignores it. The README now lists the keys
  directly and says why there is no template.
- A specific Supabase project reference was hardcoded as the default in
  `scripts/configure.ps1` (and in its comment, and in the design note), so
  the interactive setup offered one person's project to every user. It now
  prompts with `https://<project-ref>.supabase.co` as the shape.

## [Unreleased]

### Security
- Device credentials are no longer sent off the local network (#30, FR-014).
  Modem and router logins travel as HTTP Basic and as a plaintext login
  header over `http://`, which is all these devices speak and an accepted
  risk on a LAN. It was never an accepted risk off one, and a single wrong
  digit in `MODEM_HOST` was enough to post the modem password to a stranger,
  in the clear, on every scan. The host is now resolved first and **every**
  address it answers with must be private -- a name answering with both a
  LAN and a public address, which is the shape of DNS rebinding, is refused.
  A refused host reads `unavailable` naming the variable to fix, never
  `fail`: nothing about the device was measured.

### Added
- Ranked causes now name the script that fixes them, where one exists (#31).
  `tools/fix_dns.sh` and its siblings have been in the repo the whole time,
  fixing three of the causes `diagnose` already names, and nothing connected
  the two -- the user read "set the adapter's DNS to 1.1.1.1" and did it by
  hand. The invocation is generated from a table checked against the
  filesystem in both directions, so a renamed or deleted script cannot leave
  a fix quietly recommending it. `run_fixes.sh --dry-run` is offered first;
  the individual `fix_*.sh` do not take that flag, which is why the wrapper
  is what gets named.
- `scripts/delete-merged-branches.ps1` -- deletes the remote branches whose
  work is already in `main`, verifying each against `ls-remote` before and
  after so a partial run is safe to repeat. Supports `-WhatIf`.

### Added
- IPv4-vs-IPv6 isolation (`netcheck/dualstack.py`, FR-013). Happy Eyeballs
  races the two families and returns whichever answers first, so a wholly
  broken family shows up only as occasional extra latency on a connection
  that still succeeds -- indistinguishable from "the network is slow today"
  unless something measures each family on its own. `scan()` gains a
  `dual_stack` section and `rank()` gains `broken_ipv6` / `broken_ipv4`,
  which fire only when the *other* family succeeded.

  Three states, not two, and both "could not measure" cases are real: the
  target having no AAAA record is its DNS, not our stack; and this host
  having no IPv6 stack at all is IPv6 switched off, which is not IPv6
  broken. Neither is ever cited as a cause.

  Deliberately not `socket.create_connection`: it re-resolves the hostname
  and can return the other family, quietly measuring the thing the probe
  exists to isolate. The socket is opened on the requested family and the
  `sockaddr` passed through whole -- IPv6's is a 4-tuple carrying flowinfo
  and a scope id, and truncating it to `(host, port)` raised `ValueError`
  against a real target.

### Fixed
- `dns_router_ms` reading exactly `0.0` on every tick (#28). The cause was the
  clock, not the resolver: before Python 3.11, `time.monotonic()` on Windows
  was `GetTickCount64` with ~15.6 ms resolution, so a real 1-3 ms query
  started and finished inside a single tick. Every short-duration measurement
  (`resolve`, `tls_connect`, `http_check`, the new dual-stack connect) now
  uses `time.perf_counter()`, which is the documented clock for exactly this
  and uses the high-resolution counter on every version. `idle_hold`'s
  90-second loop and `watch`'s interval keep `monotonic()`, which is the right
  tool for "has enough wall time passed".

- `_resolve_via` accepted any UDP packet arriving on its ephemeral port as
  the answer: the query id was the constant `0x1234` and the reply's id was
  never checked, nor was the QR bit. `watch` asks the same server the same
  question every tick, so a late reply to the previous tick satisfied the
  current one -- reporting the router's resolver as healthy on the strength
  of a stale packet, which is the opposite of what this tool is for. Each
  query now carries a fresh random id and the reply must match it and be a
  response.

### Changed
- `diagnose.py` split into `diagnose.py` (culprit for one row, correlation,
  bursts) and `rank.py` (`_SCAN_RULES`, `_FIXES`, the ranked report),
  matching the seam the tests already had. `probes.py` split again to give
  `dualstack.py` its own module, alongside `resolver.py` and `route.py`.

### Removed
- `netcheck/diagnostic_engine.py`, `fix_engine.py`, `fix_application.py`,
  `monitoring_engine.py`, `verification_engine.py`, and their test files
  (~2,850 lines of source, ~2,750 lines of tests) — fully unreachable from
  any CLI command. Every one of the ~40 names `diagnose.py` imported from
  `diagnostic_engine` was unused beyond the import line; `fix_engine`/
  `fix_application`/`verification_engine`/`monitoring_engine` had no caller
  anywhere outside their own tests. Deleting them changes no observable
  behavior. The removed fix-recommendation capability is tracked as a
  GitHub issue for a future, actually-wired-to-a-command rebuild.
- `store.record_fix_outcome`/`fix_success_rate`, the `fix_outcomes` SQLite
  table, and its test — dead once the modules above that were its only
  callers were removed. The Supabase migration recording this table is left
  untouched as historical record.
- `OPEN-ISSUES.md` — retired in favor of GitHub issues. The four still-open
  items were filed there before deletion.
- `docs/NEXT_FEATURES_PDD_SDD_TDD.md` — its still-relevant content is now
  reflected in `docs/PRD.md`; the rest documented functions that no longer
  exist after the `diagnostic_engine.py` removal above.

### Added
- `docs/PRD.md`, `docs/SYSTEM-REQUIREMENTS.md`, `docs/DATA-FLOW-DIAGRAM.md`:
  the project's source-of-truth documentation, and `rules/`: the SDD
  development-process rules this project draws on. `AGENTS.md` now states
  the sources-of-truth order.
- `tools/check.sh`: local stand-in for the CI workflows (tests, quality
  tools, fixer validation), run before merging now that those workflows
  no longer trigger automatically. `tools/deploy.sh`: local build +
  smoke-test of the release Docker image, a stand-in for
  `release.yml`'s build job.
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
- `netcheck/docs/API.md`, `netcheck/docs/QUICKSTART.md`, `netcheck/docs/TROUBLESHOOTING.md`,
  `netcheck/docs/CONTRIBUTING.md`, rewritten `netcheck/docs/ARCHITECTURE.md` (Phase 24).
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
- CI workflows (`tests.yml`, `code-quality.yml`, `fixer-validation.yml`,
  `release.yml`) now trigger on manual `workflow_dispatch` only instead of
  every push/PR — the automatic triggers were exhausting the account's
  Actions minutes quota, which then failed every job instantly with an
  empty log (`runner_id: 0`, no runner ever assigned), indistinguishable
  from a real test failure without checking the job record directly. See
  `tools/check.sh`/`tools/deploy.sh` above and `.github/workflows/README.md`
  for the local-first replacement.
- `tools/fixer.py`'s `apply_all_fixes()` put `detect_gateway_issue` (which
  returns a bare `(bool, dict)` tuple) directly into the same list as the
  `fix_*` methods (which return `FixResult` objects), so `netcheck fixer
  --issue all --dry-run` crashed with `AttributeError: 'tuple' object has
  no attribute 'validated'` as soon as `main()` tried to read that field.
  The CI step that ran this had `|| true` on it, so the crash was silently
  swallowed instead of failing the build. The gateway check has no
  automated fix by design (an unreachable gateway is a hardware/ISP
  problem, not a config change) — its detection result is now wrapped in
  a `FixResult` like every other entry, and `tests/test_fixer.py` covers
  the crash directly (calling `apply_all_fixes()` and reading `.validated`
  off every result, reproducing `main()`'s summary line).
- Dashboard: Alpine's `x-for="b in chart.bands"` created `<rect>` elements
  inside an `<svg>` via Alpine's morph, which clones nodes outside the SVG
  namespace — threw `<rect> attribute x: Unexpected end of attribute`,
  `ReferenceError: b is not defined`, and an `importNode` TypeError on
  every dashboard load/refresh. Replaced with a single `<path>` bound to
  one precomputed path string (`chart.bandsPath`), so there's one static
  element whose `d` attribute changes instead of N elements Alpine has to
  create/destroy in a foreign namespace. Verified live: zero Alpine/SVG
  console errors across load and five refreshes, previously 7
  (`OPEN-ISSUES.md` #11).
- `netcheck watch` resolved the gateway IP once at startup and never
  re-checked it, so a real network switch (home Wi-Fi to a phone hotspot,
  a DHCP renewal, etc.) left it pinging a now-unreachable stale gateway
  for the rest of the run — reported as a false `lan`/100%-loss verdict
  with high confidence, found live while re-enabling monitoring after
  today's Wi-Fi mode fix. `probes.gateway()`'s `ipconfig` regex also only
  matched a single-line gateway value, silently failing to match at all
  on a dual-stack adapter whose real IPv4 gateway sits on an unlabeled
  continuation line below the IPv6 one. `cmd_watch()` now re-resolves the
  gateway every tick (cheap) and only re-runs the traceroute-based ISP
  hop when it actually changes; `probes.gateway()` is now backed by a
  pure `parse_ipconfig_gateway()` parser tested against a real captured
  dual-stack fixture (`OPEN-ISSUES.md` #16).
- `netcheck/docs/DEVELOPMENT.md` told contributors to `pip install -e .` against a
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
`netcheck/docs/ARCHITECTURE.md` for the full module map and `git log` for the
phase-by-phase history predating this file.
