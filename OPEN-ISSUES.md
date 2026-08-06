# Open issues — netcheck

Problems surfaced but not fixed. Append; do not delete without a resolution.

---

## Current Diagnosis Summary (2026-08-06)

**Root cause of the original 14 (later 500+) API errors:** Still unknown;
no monitoring was running when they occurred.

**Wi-Fi mode fix, status:** the adapter-reset script has been run and
verified live — `netsh wlan show interfaces` now reads `Radio type:
802.11ax` on the real home AP (was stuck reading `802.11ac` even after an
earlier reconnect attempt). Does not *prove* causation retroactively for
the original bursts, but the mode is now genuinely corrected either way.

**New, separate bug found and fixed while re-enabling `watch`:** see #16
below. `netcheck watch`'s own gateway caching produced a 15+ minute false
`lan`/100%-loss reading after a real network switch (home Wi-Fi → phone
hotspot) — confirmed to be the tool misreporting, not a real outage, and
now fixed. This means any `lan` verdict recorded between roughly
2026-08-06T04:01 and 04:33 UTC is not trustworthy evidence either way and
should be disregarded when reading historical samples.

**Ruled out (confirmed working):**
- **Modem line:** 24 downstream QAM + 1 OFDM channel locked, SNR 40.6–42.0 dB,
  zero uncorrectables measured at 3h uptime. Cable plant is clean *at capture 
  time* (though errors may have happened on earlier uptime before the modem 
  dropped Wi-Fi).
- **Router DPI:** AiProtection confirmed off in ASUS GUI; DPI subsystem 
  not active.
- **Gateway/ISP:** WAN healthy, DNS correct, DHCP functioning.

**Next steps:**
1. ~~Run `scripts/reset-wifi-adapter.ps1`~~ — done, verified live.
2. Leave `python -m netcheck watch` running across normal use (now
   resilient to network switches, see #16).
3. If errors recur with a *measured* (non-`unmonitored`, non-false-`lan`)
   sample alongside them → Wi-Fi mode was not the sole cause; read whatever
   layer the sample actually shows as failing.
4. If a long clean stretch accumulates → supports the mode fix; still not a
   proven A/B, but corroborating.

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

**Update 2026-08-06:** `netcheck-reset-wifi-adapter.ps1` was run from the Guards
GUI (confirmed by its presence in `guards/runbox/.trash`, timestamped
2026-08-05 11:38, alongside the mode-fix script — this happened in a session
that was later archived, so it went unrecorded here until now). Verified live
against the real home AP after reconnecting to `Smith Family_5G`: `netsh wlan
show interfaces` now reads `Radio type: 802.11ax` (was stuck reading `802.11ac`
live even after the earlier reconnect attempt). Two of three retirement
conditions are now met. `netcheck watch`/`serve` restarted to observe whether
errors recur under the corrected mode.

**Retire when:** the adapter-reset script has been run (done), `Radio type`
reads `802.11ax` live (done), and either errors recur (rules it out) or a
clean stretch under `watch` supports it (doesn't prove it, but supports it) —
still pending.

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

## 5. ~~PowerShell command built by string interpolation~~ — RESOLVED 2026-08-05

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`environ.driver(name)` and `environ.tailscale(target)` interpolated a
caller-supplied string into a PowerShell command. `driver`'s value sat
inside single quotes (`-Name '%s'`), so a value containing `'` would escape
and append arbitrary PowerShell; `tailscale`'s value wasn't quoted at all
(`Resolve-DnsName %s`), so it needed no escaping — any PowerShell-meaningful
character worked directly.

**Not exploitable as written** — both were called with no arguments from
`scan()`, so the values were always the literal defaults, and
`NETCHECK_TARGET` reaches only `probes.sample`/`idle_hold`, which use argv
lists and sockets, never a shell string. Logged because the parameters
invited the bug: wiring `--target` through to `tailscale()` would have been
a one-line change turning an environment variable into command execution.

**Fix applied:** `environ._ps()` now takes an `args` tuple, appended to the
subprocess argv after `-Command` rather than interpolated into the script
text. Both callers reference the value via PowerShell's own `$args[0]`
instead of splicing it into the script string, so a value can no longer
break out of it regardless of its content.
`test_environ.py::PowerShellArgumentSafetyTest` verifies a value containing
a quote and a destructive command never appears in the script text and does
appear as its own argv element instead (reproduced the exploit against the
old code first, by mocking `subprocess.run` and `WINDOWS=True` — the
malicious string appeared verbatim in the constructed script, three times).

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

## 7. ~~Raw router output stored and mirrored~~ — RESOLVED (found already fixed 2026-08-05)

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`environ.router()` returned `body[:400]` verbatim into `env_scans.payload`,
which synced to Supabase. The query at the time (`nvram_get(productid)`)
returned a product string, but the code stored whatever the device replied —
including anything sensitive if the endpoint or firmware changed.

**Found already fixed** while working through the rest of this list: issue
#3b's rewrite of `router()` onto the real ASUS token-auth flow (querying
`wrs_protect_enable` instead of `productid`) changed its return value as a
side effect — it now parses out only the single `aiprotection_enabled`
boolean and returns that, with no raw body field anywhere in the result.
Verified by reading the current function directly. This entry was never
retired when that landed, same as #6.

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

## 10. ~~`server.py` carries a second, disconnected dashboard-payload API that returns fabricated data~~ — RESOLVED 2026-08-05

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

Left as a decision rather than deleted at the time it was found (a bigger
call than "add a dashboard feature," the task it was found under) —
revisited in a later pass explicitly aimed at closing out open issues.

**Fix applied:** deleted `dashboard_payload()`, `get_api_data()`,
`get_api_configuration_snapshot()`, `get_api_diagnostic_history()`, and
`test_diagnostic_website.py`'s ~30 tests along with them. `payload()`
already covers everything `ui.html` actually renders; there was no real
functionality to preserve, only the fabricated-data risk to remove. Chose
delete over wire-up per this pass's "lean coding, high ROI" instruction —
wiring up a richer payload shape nobody was consuming would have been new
speculative work, not a fix.

---

## 11. Two pre-existing, minor `ui.html` rough edges found during Playwright testing — 1 of 2 RESOLVED 2026-08-05

**Surfaced:** 2026-08-05, Phase 27 (found while visually verifying the new
dashboard features in a real browser — pre-dates this phase's changes,
confirmed by testing against the version of `ui.html` from the initial
commit).

1. **Console errors on load/refresh — still open.** Chromium logs `<rect>
   attribute x: Unexpected end of attribute` (x2) and `ReferenceError: b is
   not defined` (x2) plus an `importNode` TypeError, around the failure-band
   rectangles in the latency chart (`x-for="b in chart.bands"`). Cosmetic —
   the chart still renders correctly in every screenshot taken — but real
   console noise, likely an Alpine/SVG namespaced-attribute morphing quirk.
   Not attempted: root-causing this means either bisecting Alpine's SVG
   handling or restructuring the bands away from `x-for` inside an `<svg>`,
   and risks introducing a real regression in exchange for silencing a
   dev-console-only warning — a worse trade than leaving it recorded.
2. **~~"Recent samples" table needs horizontal scroll at narrow widths~~ —
   RESOLVED.** `.scroll` now carries a two-edge fade (a CSS-only "scroll
   shadow": four layered gradients, the inner two `background-attachment:
   local` so they scroll with the content and vanish at the real start/end,
   the outer two fixed so a hint is visible even mid-scroll). Verified in a
   real Playwright session: the right-edge fade shows at rest and
   disappears once scrolled to the last column, and the left-edge fade
   appears in its place.

**Retire when:** the console errors are root-caused and fixed.

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

---

## 13. `fix_application.py`'s device-fix methods were entirely fabricated — RESOLVED 2026-08-05, write protocol still unverified against live hardware

**Surfaced:** 2026-08-05, while auditing how reliably this project's automated
*fixes* (as opposed to its diagnoses) can be trusted.

Every method on `FixApplier` (`apply_wifi_channel_fix`, `disable_aiprotection`,
`disable_qos`, `restart_device`, `get_device_status`) unconditionally returned
`{"status": "applied", ...}` (or `"initiated"`/`"connected"`) with no I/O at
all — no login, no request, no read-back. `docs/API.md` claimed these methods
went "over their authenticated HTTP APIs (`environ._asus_login`/`_asus_get`)",
which was simply false; every one of `test_fix_application.py`'s 281 lines
tested that the fabricated shape stayed fabricated, not that anything real
happened. Had this shipped as-is, running `disable_aiprotection()` against a
real router would have reported success while changing nothing on the
device — the exact "silent fallback" pattern `AGENTS.md` prohibits, just in
the fix-application direction instead of the diagnosis direction.

**Fix applied:** `FixApplier` now takes `host`/`user`/`password` (with
`ROUTER_HOST`/`ROUTER_USER`/`ROUTER_PASS` or `MODEM_HOST`/`MODEM_USER`/
`MODEM_PASS` env-var fallback, matching `environ.router`/`environ.modem`'s own
convention) and a `dry_run` flag defaulting to `True` (matching
`tools/fixer.py`'s existing safe-by-default pattern). A new
`environ._asus_set()` reuses `_asus_login`'s proven auth to POST a real write
to `applyapp.cgi`. Every apply method now follows one of five real states:

- `unavailable` — no credentials, or the device type has no known write path
  at all (the CAX80 modem and `local_config` never attempt anything —
  inventing a write path for them would be fabrication in a different guise).
- `dry_run` — the default; builds and returns the request it *would* send,
  sends nothing.
- `applied` + `verified_by_readback: true` — `disable_aiprotection()` only,
  the flagship case: the write is confirmed by calling `environ.router()`
  again afterward and checking `aiprotection_enabled` actually flipped,
  rather than trusting the write's HTTP response.
- `attempted` — the write's HTTP request succeeded, but no proven read-back
  exists for that particular setting (Wi-Fi channel/bandwidth, QoS) to
  confirm it took effect. Also what `disable_aiprotection()` itself falls
  back to if the write succeeds but the read-back *doesn't* confirm the
  change — see below.
- `fail` — the login or write request itself failed.

Tested against a real stub HTTP server speaking `login.cgi`/`appGet.cgi`/
`applyapp.cgi` (same stand-in-server pattern as
`test_store.py::MirrorTest._stub()`), including the specific case where the
write "succeeds" at the HTTP layer but the read-back shows the value never
actually changed — asserting the result is `attempted`, never `applied`, in
that case. 34 tests in the rewritten `test_fix_application.py`.

**Still open / unverified:** the exact write wire format — POST
`/applyapp.cgi` with a semicolon-joined, URL-quoted `key=value` payload and
the specific NVRAM key names (`wrs_protect_enable`, `wl1_chanspec`, `wl1_bw`,
`qos_enable`) — follows the shape used by community-reverse-engineered
clients (the `AsusRouter`/`aioasuswrt` Python libraries), since ASUS ships no
public write-API spec. It has never been exercised against a real ASUS
device from this codebase. Same caveat class as `probes.parse_airport_info`
(#9): if the guessed shape is wrong, the design's own read-back check is the
safety net — a wrong key still reports `attempted` rather than a false
`applied`, but the fix genuinely won't have taken effect either way.

**Retire when:** the write flow (any of `apply_wifi_channel_fix`,
`disable_aiprotection`, `disable_qos`, `restart_device`) has been run with
`dry_run=False` against a real ASUS router at least once and the read-back
matches.

---

## 14. `fix_engine.py`'s fix likelihoods were hardcoded authored guesses with no path to real data — RESOLVED (plumbing), still 0 real outcomes recorded

**Surfaced:** 2026-08-05, during a reliability audit of how confidently this
project's automated *fixes* (as opposed to its diagnoses) can be trusted —
the same audit that also found `fix_application.py`'s device-fix methods
were entirely fabricated (#13, above).

`recommend_fixes_for_diagnosis()` ranked fixes partly by `likelihood` —
`0.35` for the Wi-Fi channel fix, `0.20` for AiProtection, `0.07` for double
NAT, etc. — hardcoded floats in `_get_wifi_fixes()`/`_get_router_fixes()`/
etc. with no comment distinguishing "this is a documented estimate" from
"this is measured". Nothing in the codebase recorded whether a fix actually
worked anywhere durable: `diagnostic_engine.ConfigurationMatrix.
record_fix_applied()`/`record_post_fix_outcome()` exist, but are in-memory
only, keyed by `variable` name (e.g. `"wifi_mode"`) for the unrelated manual
configuration-testing workflow — not by `fix_engine`'s `fix_id`, and never
persisted to `store.py`'s SQLite database. `verification_engine.
track_fix_success()` already computed a real success verdict after
comparing before/after diagnoses, but threw that verdict away — it was
never written anywhere a later `recommend_fixes_for_diagnosis()` call could
read it back.

**Fix applied:** a new `fix_outcomes` table in `schema.sql` (mirrored in
`supabase/migrations/0001_init.sql`), `store.record_fix_outcome(conn, host,
fix_id, success)` / `store.fix_success_rate(conn, fix_id) -> {n, rate} |
None`, `verification_engine.track_fix_success(..., conn=None, host=None)`
now persists its verdict when given a connection, and
`fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=None)` replaces a
fix's hardcoded `likelihood` with the real measured rate once at least
`store.MIN_MEASURED_FIX_SAMPLES` (3) outcomes exist for that `fix_id` —
below that threshold, or with no `conn` at all, the documented prior stands
unchanged. Every `FixRecommendation` now carries `likelihood_source`
(`"prior"` or `"measured"`) and `likelihood_samples`, so nothing downstream
can mistake one for the other. 13 new tests
(`test_fix_engine.py`, `test_store.py::FixOutcomeTest`,
`test_verification_engine.py::TrackFixSuccessPersistenceTest`) cover: no
conn keeps the prior, a conn with too little history keeps the prior, ≥3
real outcomes switches to the measured rate, only the matching `fix_id` is
affected, and the measured rate still sorts by effort-then-likelihood the
same way a prior would.

**Still open:** nothing in the live CLI (`netcheck full-check` / `watch` /
`diagnose` / `serve`) calls `FixApplier`, `recommend_fixes_for_diagnosis`,
or `track_fix_success` today — these three modules are a library with no
command wired to them yet (see `fix_engine.py`'s own "recommend, don't act"
framing). So in real usage right now, every recommendation is still a
`"prior"`: the `fix_outcomes` table exists and is correctly read/written,
but nothing populates it outside of tests until some future command
actually applies a fix, verifies it, and calls `track_fix_success(...,
conn=conn, host=host)` with the real database connection. Recorded so
"measured likelihoods now exist" isn't mistaken for "this tool has learned
anything about a real user's fixes yet" — it hasn't; the mechanism is real,
the data isn't, yet.

**Retire when:** a CLI command exists that applies a fix, verifies it, and
records the outcome end to end against a real `~/.netcheck/netcheck.db`,
and at least one fix has accumulated 3+ real recorded outcomes.

---

## 15. Only 5 of 15 canonical hypotheses had real fault-injection e2e coverage — 2 more added, rest honestly still not attempted

**Surfaced:** 2026-08-05, while extending `test_e2e_faults.py` beyond the 5
hypotheses #12's restoration covered (latency, jitter, packet loss, DNS
resolution, connection reaping).

**Added, both verified working against a real injected fault before being
written up here:**

- **#4 (MTU/PMTUD).** `tc netem` has no MTU-clamping option, so this uses a
  different real fault: `ip link set dev lo mtu 1000` genuinely shrinks
  loopback's interface MTU (confirmed live in this sandbox — a DF-set
  `ping -s 1200` fails with a real `local error: message too long,
  mtu=1000`, one 872 bytes fits through at 928 total). Two tests: the
  default candidate sizes (1200-1472) correctly report `unavailable`
  rather than lying about some other size working, and a size list chosen
  to bracket the real 1000-byte limit correctly finds it via
  `environ.mtu()`'s actual descending walk.
- **#9 (TLS handshake overhead).** A real `tc netem` delay against a real
  local TLS server (self-signed certificate generated fresh via the
  `openssl` CLI, skips gracefully if unavailable — no private key shipped
  in the repo). `probes.tls_connect()` gained an optional `ctx` parameter,
  the same pattern `idle_hold` already uses, so the test can hand in a
  context that trusts that certificate instead of failing closed the way
  a real unknown certificate must. `test_probes.py::TlsConnectCtxTest`
  covers the parameter itself at the unit level (default is still a real
  verifying `SSLContext` — fails closed against a plaintext peer).

**Still not attempted, with the specific blocker for each:**

- **#6 (dual-stack IPv6).** This sandbox has no IPv6 at all —
  `socket.socket(AF_INET6, ...)` raises `OSError: Address family not
  supported by protocol` outright, so there was no way to prototype or
  confirm a real dual-stack test here before committing to it (unlike the
  MTU and TLS additions above, both verified live in this environment
  first). `diagnostic_engine.analyze_dual_stack()` is also a pure function
  over an already-shaped `{"reachable", "latency_ms"}` dict per stack, and
  nothing in this codebase currently produces that shape from a live
  probe — a real test would need both a capability gate for the runner
  and new glue code, not just a fault-injection harness.
- **#5 (TCP retransmits) / #14 (monitoring regression).** Real retransmits
  happen for free under `tc netem loss` (already exercised for hypothesis
  #3), but nothing in this codebase counts them from a live connection
  (e.g. parsing `ss -i`) — `build_state_machine` (see #12 above) consumes
  already-timestamped events, it doesn't produce them.
- **#8 (routing asymmetry) / #10 (socket buffer size).** Both would need
  either multiple real network paths (asymmetry) or OS-level TCP-stack
  introspection deeper than `environ.tcp_globals()`'s current `netsh`
  parsing provides (buffers) — neither is a fault-injection problem the
  existing `tc netem`/interface-MTU techniques extend to.

**Retire when:** each remaining hypothesis either gets real e2e coverage
using a technique verified live first (as both additions above were), or is
confirmed genuinely out of reach for this environment and reclassified as
permanently out of scope rather than merely unattempted.

---

## 16. `netcheck watch` cached the gateway IP once at startup — RESOLVED 2026-08-06, found live during real monitoring

**Surfaced:** 2026-08-06, while `watch` was actively running to observe
whether the Wi-Fi mode fix (#3) held. It caught a real network switch —
the exact kind of event this ongoing diagnosis needs to observe — and
turned it into a false alarm instead.

`cmd_watch()` called `probes.gateway()` and `probes.first_hop()` exactly
once before entering its loop, then reused those values for the entire
run. When the machine switched from the home AP (gateway `192.168.50.1`)
to a phone hotspot (gateway `10.215.141.84`, a different subnet
entirely), `watch` kept pinging the now-unreachable `192.168.50.1` for
every subsequent tick. The result: 30+ consecutive samples read
`gw_state: fail`, `gw_loss: 100.0`, `culprit: lan` — the dashboard showed
"lan, high confidence, 100% of samples" for a 15+ minute stretch — while
a direct `Test-Connection` to the real current gateway from the same
machine, at the same time, succeeded in 5-9ms. `inet_state`/
`dns_public_state`/`tls_state` stayed `ok` throughout (they hit public
targets, unaffected by the stale gateway), which is what made the false
positive identifiable rather than indistinguishable from a real one.

A second, related bug in the same function: `probes.gateway()`'s regex
(`Default Gateway[ .]*:\s*([\d.]+)`) only ever matched a *single-line*
gateway value. A dual-stack Windows adapter prints its IPv6 gateway on
the labeled line and the IPv4 one on an unlabeled continuation line right
below it:

```
   Default Gateway . . . . . . . . . : fe80::xxxx:xxxx:xxxx:xxxx%16
                                       10.215.141.84
```

`\s*` cannot skip over the non-whitespace IPv6 text to reach the second
line, so the regex silently failed to match at all on any dual-stack
adapter — confirmed directly against this machine's real `ipconfig`
output (`re.search(...)` returned `None`). This means simply re-resolving
the gateway every tick, without also fixing the regex, would have made
things *worse* — trading a stale-but-present IP for `None`.

**Fix applied:**
- `probes.py`: extracted `parse_ipconfig_gateway(text)` as a pure
  function (matching this module's own "parsers are pure functions over
  text" convention, which `gateway()` had been the one exception to).
  It captures the whole "Default Gateway" block — the labeled line plus
  any indented continuation lines — and searches within that block for
  an IPv4-shaped token, and it checks every `Default Gateway` occurrence
  in order (a VPN/Tailscale-style adapter often prints the label with no
  value at all, before the real one).
- `__main__.py`'s `cmd_watch()`: re-resolves the gateway every tick
  (cheap — one `ipconfig`/`ip route` call) and only re-runs the more
  expensive `first_hop()` traceroute when the gateway has actually
  changed, printing a note when it does.
- New fixture `tests/fixtures/ipconfig_dual_stack_gateway.txt`, captured
  from this real machine (link-local/global IPv6 values replaced with
  placeholders, matching this repo's fixture convention for anything
  that could geolocate a house). 4 new tests in
  `test_probes.py::ParseIpconfigGatewayTest`: the dual-stack case, a
  blank-gateway adapter appearing before the real one, the plain
  single-line case (must keep working unchanged), and no gateway
  anywhere.

**Verified live:** restarted `watch`/`serve` with the fix; the next two
ticks (samples 180, 181) both read `gw_state: ok` on the current network,
versus the `fail`/`lan` streak (samples ~122-179) immediately before the
restart.

**Retire when:** done — fixed, tested against a real captured fixture,
and confirmed live against the actual bug it was found from.
