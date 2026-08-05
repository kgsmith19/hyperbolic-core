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

**Retire when:** the adapter-reset script has been run, `Radio type` reads
`802.11ax` live, and either errors recur (rules it out) or a clean stretch
under `watch` supports it (doesn't prove it, but supports it).

---

## 3b. `environ.router()` reported false `state: ok` — real bug, found live

**Surfaced:** 2026-08-05, while investigating AiProtection with real
credentials.

ASUS does not accept HTTP Basic Auth for its data hooks (`appGet.cgi`) even
though it silently returns HTTP 200 for the *page shell* under Basic Auth —
the body is a JS login-redirect stub (`location.href='/Main_Login.asp'`).
`_http_get` only checked for a transport-level exception, so `router()` read
that redirect stub as `state: ok` — a real silent-success bug, the exact
failure mode the project's "no silent fallbacks" rule exists to catch. It was
never actually authenticating, on any run this session including the one in
`scripts/configure.ps1`'s own verification step.

**Real auth flow** (confirmed live against RT-BE58U_V2, not the docs — via
`POST /login.cgi` with `login_authorization=base64(user:pass)` and header
`user-agent: asusrouter-Android-DUTUtil-1.0.0.201`, returns
`{"asus_token": "..."}`; subsequent calls are `POST /appGet.cgi` with
`hook=<call>` and `cookie: asus_token=<token>`, same user-agent):

- `wanlink()` — WAN is healthy: DHCP, connected, public IP confirmed, DNS
  8.8.8.8/8.8.4.4, lease renewed ~3h before capture (matches the modem reboot
  cascading to a WAN renewal — expected, not a new anomaly).
- `nvram_get(wrs_protect_enable)` → `"0"`, `TM_EULA` → `"0"`, but
  `wrs_mals_enable` / `wrs_cc_enable` / `wrs_vp_enable` all → `"1"`. **Resolved
  2026-08-05**: Kyle confirmed in the actual ASUS GUI that AiProtection is
  off. The nvram read was correct — `wrs_protect_enable=0` gates the whole
  feature, and the `"1"` sub-flags are stale/inactive underneath it. DPI is
  **ruled out** as a currently-active cause. (Also tried `Main_LogStatus_Content.asp`
  for the router syslog — loaded but was another JS-templated shell with no
  log data in the raw fetch, same pattern as RouterStatus.htm. Real log hook
  not found; not pursued further given session time.)

**Fix:** rewrite `router()` on the real token/cookie flow above; detect the
login-redirect stub as `fail`, never `ok`. Not done this session — logged
instead of rushed, per the context-budget cutoff mid-investigation. The raw
probe output (real login/hook responses) is worth re-running rather than
trusting memory when this is picked up.

**Retire when:** `router()` is rewritten on the token flow and a real scan
resolves the AiProtection ambiguity via the GUI or a confirmed-correct nvram
key set.

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
