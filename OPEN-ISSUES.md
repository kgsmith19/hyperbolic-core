# Open issues — netcheck

Problems surfaced but not fixed. Append; do not delete without a resolution.

---

## Current Diagnosis Summary (2026-08-05)

**Root cause of 14 API errors:** Unknown; no monitoring was running when they occurred.

**Most likely culprit:** Wi-Fi adapter pinned to 802.11ac (sub-optimal mode on 
Wi-Fi 6 AX201 against AX-capable router). Driver property updated to 802.11ax,
but needs full adapter reset (now available in `scripts/reset-wifi-adapter.ps1`)
to take effect. Does not *prove* causation retroactively, but fits the symptom
shape (intermittent drops under link margin).

**Ruled out (confirmed working):**
- **Modem line:** 24 downstream QAM + 1 OFDM channel locked, SNR 40.6–42.0 dB,
  zero uncorrectables measured at 3h uptime. Cable plant is clean *at capture 
  time* (though errors may have happened on earlier uptime before the modem 
  dropped Wi-Fi).
- **Router DPI:** AiProtection confirmed off in ASUS GUI; DPI subsystem 
  not active.
- **Gateway/ISP:** WAN healthy, DNS correct, DHCP functioning.

**Next steps:**
1. Run `scripts/reset-wifi-adapter.ps1` to apply 802.11ax mode (requires admin)
2. Run `python -m netcheck watch` for a few days
3. If errors recur → Wi-Fi mode was not the cause (or not the only cause)
4. If errors stop → captures the fix; doesn't prove causation (no A/B test 
   of the original state), but supports it

---

## 1. No historical network data behind the 14 known LLM errors

**Surfaced:** 2026-08-05, initial build.

All 14 real connection errors found in the Claude Code transcripts
(2026-07-29 → 2026-08-05) correlate to verdict `unmonitored` — nothing was
sampling the network when they happened, so the tool cannot say what broke.

This is inherent to starting now, not a defect. It resolves itself once
`netcheck watch` has been running across a few failures. Recorded so the empty
diagnosis is not mistaken for a clean bill of health.

**Retire when:** at least one error burst lands with a verdict other than
`unmonitored`.

---

## 2. ~~Modem DOCSIS scraper needs a rewrite~~ — RESOLVED 2026-08-05

Device is a NETGEAR CAX80 (modem+router combo, matches the built-in-Wi-Fi box
Kyle described). The real status page is `DocsisStatusAdv.htm`, reached via
the UI's "Cable Connection" link — not `DocsisStatus.htm` (404s on this
firmware) and not `RouterStatus.htm` (a different page entirely).

The channel tables are never present as HTML text: the firmware assigns a
pipe-delimited string to a JS `tagValueList` variable inside each of five
`Init*TagValue()` functions, which the page's own script splits and renders
client-side. Confirmed against public writeups from people who reverse
engineered the same firmware family (`hdholm/ModemCheck`,
`pinowudi/netgear_cm700_status`) before capturing the real page and verifying
field-for-field.

`environ.parse_docsis_status()` now extracts each function's body by
brace-matching, strips the stale example assignment every function also
carries inside a `/* */` comment (a naive regex would grab that instead of the
live data), and parses the pipe-delimited rows. Pure function, tested against
a real captured fixture (`tests/fixtures/docsis_status_adv.js`) — 10 new tests
in `test_environ.py::ParseDocsisStatusTest`.

Verified against the live device, 3/3 consecutive runs: 24/24 downstream QAM
channels and 1 active OFDM channel locked, SNR 40.6–42.0 dB, power all within
spec, **zero uncorrectables everywhere**. The physical cable line is not
currently the problem. One caveat: uncorrectables reset on modem reboot, and
this modem had only ~3h uptime at capture time (Kyle disabled its Wi-Fi radio
at 10:38 PM, which restarted the DOCSIS stack) — so this proves the line is
clean *now*, not that it was clean during the earlier error bursts.

---

## 3. Wi-Fi adapter is pinned below its capability — FIX HANDED OFF 2026-08-05

`802.11n/ac/ax Wireless Mode = 3. 802.11ac` on an Intel Wi-Fi 6 AX201, against
an ASUS RT-BE58U_V2 (Wi-Fi 7). `Roaming Aggressiveness = 1. Lowest` also
non-default. Confirmed valid values are `1. Disabled / 2. 802.11n /
3. 802.11ac / 4. 802.11ax` (registry `IEEE11nMode`).

This is the single most concrete, actionable anomaly found all session — but
it does NOT retroactively explain the 14 already-logged errors, since none of
them had monitoring running alongside them. It fits the *shape* of an
intermittent-drop symptom (less link margin, more retries under load) but is
not proven causal.

Attempted to apply directly (`Set-NetAdapterAdvancedProperty`) with Kyle's
explicit authorization — blocked by Windows admin rights, which this session
does not have. Script with before/after verification and a one-line rollback
left at `C:\code\guards\runbox\netcheck-fix-wifi-mode.ps1` for Kyle to run.

**Update 2026-08-05, later:** Kyle ran the script — driver property confirmed
changed (`3. 802.11ac` → `4. 802.11ax`, verified by the script's own
before/after read). But the **live** connection did not renegotiate: `netsh
wlan show interfaces` still read `802.11ac` afterward. Attempted a WLAN
profile disconnect/reconnect to force it — briefly took Kyle's Wi-Fi down for
~15s from a string-parsing bug (empty SSID extracted, reconnect failed until
manually retried with the known SSID). Restored immediately. Live radio still
read `802.11ac` even after the reconnect, meaning a profile-level
disconnect/reconnect is not enough — the driver needs a full adapter cycle.
Left as `netcheck-reset-wifi-adapter.ps1` in the runbox (also admin-gated, and
deliberately not attempted live again tonight after the incident above).

**Script available:** `scripts/reset-wifi-adapter.ps1` disables and re-enables the
adapter to force WLAN AutoConfig to renegotiate at the new mode. Requires admin.
Includes before/after verification of wireless mode.

**Retire when:** the adapter-reset script has been run, `Radio type` reads
`802.11ax` live, and either errors recur (rules it out) or a clean stretch
under `watch` supports it (doesn't prove it, but supports it).

---

## 3b. ~~`environ.router()` reported false `state: ok` — real bug, found live~~ — RESOLVED 2026-08-05

**Surfaced:** 2026-08-05, while investigating AiProtection with real
credentials.

ASUS does not accept HTTP Basic Auth for its data hooks (`appGet.cgi`) even
though it silently returns HTTP 200 for the *page shell* under Basic Auth —
the body is a JS login-redirect stub (`location.href='/Main_Login.asp'`).
The old `_http_get` only checked for a transport-level exception, so `router()`
read that redirect stub as `state: ok` — a real silent-success bug.

**Fix Applied:** Rewrote `router()` on the real ASUS token flow (confirmed
live against RT-BE58U_V2):

1. `_asus_login()` — POST to `/login.cgi` with
   `login_authorization=base64(user:pass)` header and
   `user-agent: asusrouter-Android-DUTUtil-1.0.0.201`, returns
   `{"asus_token": "..."}`; fails cleanly if token is missing from response.
2. `_asus_get()` — POST to `/appGet.cgi?hook=<call>` with
   `cookie: asus_token=<token>` and same user-agent.
3. `router()` now queries `wrs_protect_enable` and returns
   `aiprotection_enabled` as a boolean instead of raw body text.

AiProtection confirmed off on Kyle's device (he checked the ASUS GUI);
DPI is ruled out as an active cause.

---

## 4. `dns_router_ms` reads 0.0 ms

**Surfaced:** 2026-08-05.

Router DNS resolution repeatedly times at 0.0 ms — plausible for a cached
answer over loopback-speed LAN, but suspiciously round. May indicate the timing
is measuring less than intended, or that the resolver is answering from cache
without a real lookup.

**Retire when:** confirmed against a cold cache, or the timing is corrected.

---

## 5. PowerShell command built by string interpolation (security, latent)

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`environ.driver(name)` and `environ.tailscale(target)` interpolate a
caller-supplied string into a PowerShell command
(`netcheck/environ.py:83`, `:164`). The value sits inside single quotes
(`-Name '%s'`), so a value containing `'` escapes and appends arbitrary
PowerShell.

**Not exploitable as written.** Both are called with no arguments from
`scan()`, so the values are always the literal defaults, and `NETCHECK_TARGET`
reaches only `probes.sample` / `idle_hold`, which use argv lists and sockets —
never a shell string.

It is logged because the parameters invite the bug: wiring `--target` through
to `tailscale()` is a one-line change that would turn an environment variable
into command execution.

**Fix:** pass values as PowerShell parameters (`-Command "param($n) ..."` with
`-Args`) rather than interpolating, or validate against a strict charset.

**Retire when:** the interpolation is replaced or the parameters are removed.

---

## 6. ~~Client input crashes a request instead of returning 400~~ — RESOLVED (found already fixed 2026-08-05)

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`netcheck/server.py:56` did `int(parse_qs(...)["limit"])` unguarded, so
`GET /api/data?limit=abc` raised ValueError, dropping the connection and
printing a traceback to stderr. An expected client error surfaced as a crash.
Loopback-only, and nothing was disclosed to the client.

**Found already fixed** during the Phase 27 dashboard review: `do_GET` now
wraps the `int()` call in try/except and returns 400, and
`test_server.py::ApiTest::test_invalid_limit_parameter_returns_400_not_crash`
already covers it. This entry was never retired when the fix landed —
recorded so a stale open issue doesn't get mistaken for a live one.

---

## 7. Raw router output stored and mirrored (security, low)

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`environ.router()` returns `body[:400]` verbatim into `env_scans.payload`,
which syncs to Supabase. The current query (`nvram_get(productid)`) returns a
product string, but the code stores whatever the device replies — including
anything sensitive if the endpoint or firmware changes. Not rendered in the UI.

**Fix:** parse the specific fields wanted instead of keeping the raw body.

---

## 8. Basic auth over plaintext HTTP to modem and router (accepted risk)

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`environ._http_get` sends credentials base64-encoded (not encrypted) over HTTP.
These devices do not offer HTTPS, and the traffic stays on the local segment.
Accepted, recorded so it is a decision rather than an oversight.

---

## 9. macOS is partially implemented — PARTIALLY RESOLVED 2026-08-05

**Surfaced:** 2026-08-05.

`environ.py` was entirely Windows-only (netsh, PowerShell, Windows event
log) — the module behind `watch`/`scan`/`diagnose`. `probes.py` was already
cross-platform, and the parsers take text, so this is additive rather than a
rewrite. The original brief mentioned a Mac.

Separately, `wifi_diagnostics.py` (the Phase 15 module behind `full-check`)
already had Darwin/Linux branches for its own Wi-Fi functions predating this
entry — but with no test coverage of those branches (no fixtures, no
mocking of `platform.system()`/`subprocess`), so they're exercised only when
actually run on that platform. That gap is unrelated to `environ.py` and is
out of scope for this entry; noted here so it isn't mistaken for "macOS is
untouched everywhere."

**Done:** `environ.wifi()` now dispatches to macOS's `airport -I` (via
`probes.parse_airport_info`) when `probes.MACOS` is set, same
`unavailable`-on-missing-binary behavior as the Windows path. **Caveat:**
unlike every Windows parser in this codebase, `parse_airport_info` was built
against Apple's long-documented `airport -I` field format, not a real
capture — this project has no Mac to capture one from. Its fixture
(`tests/fixtures/airport_info.txt`) is hand-built and says so. Treat this
parser as needing verification against a live machine before trusting it the
way `parse_wlan_interfaces` is trusted.

**Still Windows-only:** `driver()` (adapter/power-management settings),
`events()` (Windows Event Log), `tcp_globals()`, `tailscale()` all still
report `unavailable` on macOS (`_ps` explicitly checks `WINDOWS` first;
`tcp_globals()`'s `netsh` call fails over to `unavailable` the same way any
missing binary does). `congestion()` (neighbouring-AP scan) also has no
macOS path yet — `airport -s` requires disassociating from the current
network on modern macOS, which isn't a fit for a passive scan.

**Retire when:** `parse_airport_info` is verified against a real capture,
and/or a macOS path exists for `driver()`/`congestion()`, or those are
confirmed out of scope.

---

## 10. `server.py` carries a second, disconnected dashboard-payload API that returns fabricated data

**Surfaced:** 2026-08-05, Phase 27 dashboard review.

`server.py` defines `dashboard_payload()`, `get_api_data()`,
`get_api_configuration_snapshot()`, and `get_api_diagnostic_history()` —
roughly 70 lines, backed by ~30 tests in `test_diagnostic_website.py`. None
of them are reachable from `Handler.do_GET`: the live `/api/data` route
calls `payload()` (a different, real function a few lines above them), and
`ui.html` only ever fetches `/api/data`. This second API path is dead code.

Worse than merely dead: if it were ever wired in, it would render
fabricated values as if real — `dashboard_payload()` hardcodes
`wifi_mode: None`, `system_uptime: 0`, `culprit_summary: {}`,
`regressions: []`, `diagnostic_history` with a single made-up
"unmonitored" placeholder entry — regardless of what's actually in the
database. That is exactly the "silent fallback" pattern `AGENTS.md`
prohibits (a missing measurement must read as `unavailable`, never as a
faked `ok`-shaped value), just one layer further from a real probe.

Left as-is for this phase rather than deleted: removing ~30 passing tests
and a chunk of implementation is a bigger call than "add a dashboard
feature," the task this entry was found under. Flagging it here instead so
it's a decision, not an oversight.

**Fix:** either wire `dashboard_payload()` up to real data (pulling from
`store`/`diagnose` the way `payload()` does) and point `ui.html` at it if
its richer shape (config snapshots, regressions, applied-fixes history) is
still wanted, or delete it and `test_diagnostic_website.py` along with it if
`payload()` already covers what the dashboard needs.

**Retire when:** one of the above happens.

---

## 11. Two pre-existing, minor `ui.html` rough edges found during Playwright testing

**Surfaced:** 2026-08-05, Phase 27 (found while visually verifying the new
dashboard features in a real browser — pre-dates this phase's changes,
confirmed by testing against the version of `ui.html` from the initial
commit).

1. **Console errors on load/refresh.** Chromium logs `<rect> attribute x:
   Unexpected end of attribute` (x2) and `ReferenceError: b is not defined`
   (x2) plus an `importNode` TypeError, around the failure-band rectangles
   in the latency chart (`x-for="b in chart.bands"`). Cosmetic — the chart
   still renders correctly in every screenshot taken — but real console
   noise, likely an Alpine/SVG namespaced-attribute morphing quirk.
2. **"Recent samples" table needs horizontal scroll at narrow widths**, and
   nothing hints that it scrolls: at the card's default ~283px width, only
   `when` + part of `verdict` fit before the `.scroll` div's overflow-x
   kicks in, so `gw`/`inet`/`dns`/`tls` are scrolled off with no visible
   scrollbar affordance in a quick glance.

Neither blocks reading the dashboard. Recorded rather than fixed here since
both are pre-existing and outside a "add dashboard features" phase's scope.

**Retire when:** the console errors are root-caused and fixed, and/or the
table gets a scroll-hint (e.g. a fade edge or narrower default columns).

---

## 12. ~~Canonical hypotheses #1-5 had no implementing code~~ — RESOLVED 2026-08-05

**Surfaced:** 2026-08-05, while auditing `docs/NEXT_FEATURES_PDD_SDD_TDD.md`
against the actual codebase for a "complete the remaining specs" pass.

Git history shows Phase 1 (Latency & Jitter Classifier), Phase 2 (Packet
Loss Pattern Classifier), Phase 3 (MTU/MSS Discovery & PMTUD), and Phase 4
(TCP Connection State Machine) as separate commits, each claiming real
functions and passing tests. None of those functions exist in
`diagnostic_engine.py` today. Root cause: each phase's commit modified the
*same* line range as the previous phase's and replaced its functions
instead of adding alongside them — Phase 2 overwrote Phase 1's
`classify_latency`, Phase 3 overwrote Phase 2's packet-loss functions,
Phase 4 overwrote Phase 3's MTU/PMTUD functions, and would have overwritten
Phase 4's own TCP state-machine functions too had Phase 5 (dual-stack)
not started appending in a new region instead of colliding with the same
slot. Confirmed by walking each commit's tree state directly
(`git show <sha>:netcheck/diagnostic_engine.py`) rather than trusting
commit messages.

One concrete fingerprint of the damage survived even after the functions
themselves were gone: `detect_happy_eyeballs()` ended with three orphaned,
unreachable lines referencing undefined `mtu`/`standards` names — a
fragment of the lost MTU classifier's `return` statement, spliced into the
wrong function by whatever produced the overwrite. Removed.

A second, related problem: `all_diagnostics.AllDiagnostics.hypotheses`
lists "Latency (ms)", "Jitter (ms)", "Packet Loss (%)", "MTU Size (bytes)",
and "TCP Retransmits" as hypotheses 1-5, and `tests/test_e2e_faults.py`'s
acceptance tests for hypotheses #1, #3, and #7 injected a real `tc netem`
fault and then asserted `assertTrue(True, "...")`, with the actual
measurement assertion left in a comment ("# In a real test, we'd
measure..."). So there was no code AND no real test that would have caught
its absence.

**Fixed:**
- Restored `classify_latency`, `classify_latency_under_load`,
  `classify_packet_loss`, `detect_asymmetric_loss`, `find_path_mtu`,
  `diagnose_pmtud`, and `build_state_machine` in `diagnostic_engine.py`,
  re-exported via `diagnose.py` matching the existing toolkit pattern
  (`analyze_dual_stack` et al. — also unit-tested standalone, not wired
  into `rank()`'s live per-tick path; these follow the same, already-
  established convention rather than a new one).
- Removed the orphaned dead code in `detect_happy_eyeballs`.
- Rewrote `tests/test_e2e_faults.py`'s stub assertions into real ones:
  inject a fault via `tc netem` on loopback, take a real measurement
  through `probes.ping`/`probes.resolve`, assert the measurement reflects
  the fault. Added a hand-rolled stub DNS responder (mirroring the
  `_resolve_via` wire format) for the DNS-latency test, matching the
  stand-in-server pattern `test_store.py`'s `MirrorTest` and
  `test_probes.py`'s `IdleHoldTest` already use.
- Fixed `_has_tc_capability` (now module-level `netem_available()`): it
  checked `tc qdisc show`, which succeeds even when the `sch_netem` kernel
  module isn't loaded (true of the sandbox this was found in — `tc` present,
  `sch_netem` not) — a false positive that let three tests fail for real
  instead of skip once `tc` happened to be installed. It now actually adds
  and removes a netem rule.

**Not attempted:** re-deriving TCP handshake/retransmit *events* from a live
probe (raw packet capture) — `build_state_machine` classifies a list of
already-timestamped events, matching the original spec's pure-function
design and this project's "parsers are pure functions over data" convention,
but nothing in this codebase captures real SYN/ACK/RST events to feed it.
That would be a live packet-capture prober, a materially bigger addition
than restoring what existed, and out of scope for a restoration.
