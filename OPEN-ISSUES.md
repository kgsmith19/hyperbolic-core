# Open issues — netcheck

Problems surfaced but not fixed. Append; do not delete without a resolution.

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

## 3. Wi-Fi adapter is pinned below its capability

**Surfaced:** 2026-08-05.

`802.11n/ac/ax Wireless Mode = 3. 802.11ac` on an Intel Wi-Fi 6 AX201, against
an AP advertising `802.11be`. `Roaming Aggressiveness = 1. Lowest` is also
non-default. Both look like earlier hand-tuning.

Not yet linked to any failure — `netcheck diagnose` surfaces it as a
medium-confidence finding, not a cause. Changing it is a live experiment, so it
is left to the user rather than recommended outright.

**Retire when:** either the setting is restored to default and errors are
re-measured, or monitoring shows it is unrelated.

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

## 6. Client input crashes a request instead of returning 400 (security, low)

**Surfaced:** 2026-08-05, `/security-review-kgs`.

`netcheck/server.py:56` does `int(parse_qs(...)["limit"])` unguarded, so
`GET /api/data?limit=abc` raises ValueError, dropping the connection and
printing a traceback to stderr. An expected client error surfaces as a crash.
Loopback-only, and nothing is disclosed to the client.

**Fix:** wrap in try/except and return 400.

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

## 9. macOS is unimplemented

**Surfaced:** 2026-08-05.

`environ.py` is Windows-only (netsh, PowerShell, Windows event log).
`probes.py` is already cross-platform, and the parsers take text, so this is
additive rather than a rewrite. The original brief mentioned a Mac.

**Retire when:** a macOS backend exists, or the Mac is confirmed out of scope.
