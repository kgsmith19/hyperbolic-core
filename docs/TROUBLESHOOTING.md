# Troubleshooting Guide

Maps a symptom you're seeing to the hypothesis it suggests, the command that
tests it, and where the fix lives. Start with `netcheck diagnose` (or
`netcheck full-check`) before reading this table — it does the correlation
for you. This guide is for when you want to understand *why* it said what it
said, or you're chasing a symptom it hasn't ranked yet.

## First, run the tool

```bash
python -m netcheck watch          # leave running across the next failure
python -m netcheck diagnose        # ranked causes from samples collected so far
python -m netcheck full-check      # comprehensive one-shot environment sweep
```

`diagnose` is the lightweight, always-on ranker (`diagnose.py`) — it only
knows what it measured itself via `watch`/`probe`. `full-check` runs the
broader hypothesis-specific modules (Wi-Fi, modem, NAT, CGNAT, router,
Anthropic status) as a point-in-time sweep instead. They complement each
other: `diagnose` is longitudinal, `full-check` is a snapshot.

## A note on numbering

Module docstrings cite a development-order `Phase N` (see `git log`) — the
order features were built in, not what they diagnose. Phases 1-14 built the
core probing/correlation engine now in `probes.py`/`environ.py`/`diagnose.py`;
Phases 15-21 added Wi-Fi and six further device/service-specific diagnostic
modules; Phase 22 unified them behind `full-check`; Phase 23 added
end-to-end fault-injection tests.

## What `diagnose` actually checks

`diagnose.culprit()` reads one sample row and names the outermost layer that
broke:

| Symptom | `culprit` value | Tested by |
|---|---|---|
| Gateway/Wi-Fi unreachable | `lan` | `probes.ping` against the default gateway |
| Gateway ok, ISP's first hop dead | `isp` | `probes.ping` against `first_hop()` |
| ISP hop ok, general internet dead | `internet` | `probes.ping` against a public target |
| Router's own DNS fails, public DNS ok | `router_dns` | `probes.resolve` against the gateway vs. `1.1.1.1` |
| Both DNS resolvers fail | `dns` | same, both fail together |
| Everything reachable, TLS/HTTP fails | `app` | `probes.tls_connect`, `probes.http_check` |
| Long-lived connection dies mid-response | (event, not a row culprit) | `probes.idle_hold` |
| Wi-Fi adapter pinned below its capability | `wifi_mode_pinned` | `environ.driver` vs. the adapter's advertised standard |

`netcheck diagnose` also groups LLM API errors into bursts (`diagnose.bursts`)
and correlates each one against the network state at that moment
(`diagnose.correlate`) — see `README.md`'s pattern table for how a row's
shape maps to a verdict.

## Additional diagnostic modules (Phases 15-21)

`netcheck full-check` runs a point-in-time sweep across seven
hypothesis-specific modules — Wi-Fi plus six device/service-specific
additions — independent of `diagnose`'s longitudinal, per-tick history:

| Phase | Module | Symptom |
|---|---|---|
| 15 | `wifi_diagnostics` | Drops correlate with 5 GHz DFS channels, band steering, or signal instability |
| 16 | `modem_diagnostics` | Cable modem: low SNR, uncorrectable codewords, not in bridge mode |
| 17 | `nat_diagnostics` | Double NAT — WAN IP the router sees is itself private (RFC 1918) |
| 18 | `cgnat_diagnostics` | Carrier-Grade NAT — WAN IP is in `100.64.0.0/10`; inbound connections and some P2P/gaming break |
| 19 | `anthropic_diagnostics` | The far side: is api.anthropic.com's status page reporting an incident |
| 20 | `interference_diagnostics` | Neighbouring APs crowding your Wi-Fi channel |
| 21 | `router_diagnostics` | Stale firmware, QoS/DPI settings, band steering, no bridge mode |

## Symptom index

Can't find your exact symptom in the tables above? Start here:

**"Claude Code / an API client dies mid-response, but only sometimes."**
→ Connection reaping. Run `netcheck watch`; it runs `idle_hold` periodically
and will tell you if something reaps the connection at a consistent
duration. Rule out DFS radar events and interference (Phase 20) at the same
time — both look like random drops.

**"Everything is slow, not broken."**
→ Check `gw_ms`/`inet_ms`/`tls_ms` in `netcheck diagnose`'s samples for
which layer is adding latency, and your router's QoS/SQM settings (Phase 21)
for buffer bloat under load.

**"Works on my phone's hotspot, not on my home Wi-Fi."**
→ WiFi/DFS (Phase 15) or interference (Phase 20) or router DPI/QoS
(Phase 21). `netcheck full-check` runs all three in one pass.

**"Works over VPN, not without it" (or vice versa)."**
→ The VPN is changing which path your traffic takes. Check
`environ.tailscale()` if Tailscale is in the mix.

**"Router DNS is slow/wrong, but 1.1.1.1 works fine."**
→ This is exactly the row shape `diagnose.culprit` looks for: gateway ok,
`dns_router` fail, `dns_public` ok (`router_dns` verdict).

**"Modem shows sync but errors persist."**
→ Phase 16 (`modem_diagnostics`) for signal/codewords, Phase 17/18
(NAT/CGNAT) for whether the modem is actually passing your traffic through
untouched — "sync" alone doesn't prove the line is clean.

**"I don't know if it's my network at all."**
→ Phase 19 (`anthropic_diagnostics`). If the far side is degraded, nothing
on your LAN will fix it. This is also the "not your network" row in the
README's pattern table.

## Reading `unavailable`

If a check reports `unavailable` instead of `ok`/`fail`, that means *we
could not measure it* — missing credentials (`MODEM_*`/`ROUTER_*` in
`.env`), a missing binary, or no matching interface. It is never evidence of
a fault, and the ranking engine will never cite it as one (see `AGENTS.md`).
The most common causes:

| Section | Needs |
|---|---|
| `modem` | `MODEM_HOST`, `MODEM_USER`, `MODEM_PASS` in `.env` |
| `router` | `ROUTER_HOST`, `ROUTER_USER`, `ROUTER_PASS` in `.env` |
| `tailscale` | Tailscale CLI installed |
| `driver`, `events`, `tcp_globals`, `congestion` | Windows (these shell out to `netsh`/PowerShell) |
| `wifi` | Windows (`netsh`) or macOS (`airport`) — no Linux path yet |

## Applying a fix

`tools/run_fixes.sh` (and the individual `tools/fix_*.sh` scripts) apply
local OS-level fixes — DNS, adapter power management, Wi-Fi mode — with
`--dry-run` support. See `tools/README.md`. Wiring in over Ethernet is worth
doing before any of these: it rules out the entire Wi-Fi layer (and, by
extension, interference and DFS) in one test.
