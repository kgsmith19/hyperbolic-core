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
python -m netcheck full-check      # comprehensive one-shot sweep, all 15 hypotheses
```

`diagnose` is the lightweight, always-on ranker (`diagnose.py`) — it only
knows what it measured itself via `watch`/`probe`. `full-check` runs the
broader hypothesis-specific modules (Wi-Fi, modem, NAT, CGNAT, router,
Anthropic status) as a point-in-time sweep instead. They complement each
other: `diagnose` is longitudinal, `full-check` is a snapshot.

## A note on numbering

Two different numbering schemes exist in this codebase and they are **not**
the same axis:

- **Canonical hypothesis #1-15** — the original failure-mode list this tool
  was built to distinguish (table below). Referenced in
  `tests/test_e2e_faults.py` and `all_diagnostics.AllDiagnostics.hypotheses`.
- **Phase 1-23** — development order (see `git log`), i.e. the order
  features were built in, not what they diagnose. Phases 1-14 built the core
  probing/correlation engine; Phases 15-21 added Wi-Fi and six further
  diagnostic modules (modem, NAT, CGNAT, Anthropic status, interference,
  router) that sit *alongside* the 15 hypotheses rather than inside them;
  Phase 22 unified them behind `full-check`; Phase 23 added end-to-end fault
  injection tests.

If you see a module docstring citing `Phase N`, that's development order.
The table below is the canonical hypothesis list.

## The 15 hypotheses

| # | Hypothesis | Tested by | Symptom |
|---|---|---|---|
| 1 | Latency variance | `diagnostic_engine.classify_hop_latency`, `measure_hop_stability` | Requests are slow sometimes, fast other times, no clear pattern |
| 2 | Jitter | `diagnostic_engine` latency helpers, `probes.ping` | Streaming responses stutter; latency swings widely tick to tick |
| 3 | Packet loss | `probes.parse_ping` (`loss_pct`) | Occasional dropped requests with no error message — just silence |
| 4 | MTU constraints | `environ.mtu` | Large requests/responses fail or hang; small ones work fine |
| 5 | TCP retransmits | `diagnostic_engine` connection-state helpers | Connections stall mid-transfer, then recover |
| 6 | Dual-stack IPv6 | `diagnostic_engine.analyze_dual_stack`, `detect_happy_eyeballs` | Failures only on networks with broken IPv6; works fine on IPv4-only networks |
| 7 | DNS resolution delays | `probes.resolve`, `diagnose.culprit` (router DNS vs public DNS) | Slow to connect but fast once connected; `dns_router_ms` high while `dns_public_ms` is normal |
| 8 | Routing asymmetry | `diagnostic_engine.analyze_routing_path`, `detect_route_flapping` | Works from one network/VPN but not another; latency differs by direction |
| 9 | TLS handshake overhead | `probes.tls_connect`, `diagnostic_engine.measure_tls_handshake` | Connection succeeds but is slow specifically at the TLS step |
| 10 | Socket buffer constraints | `diagnostic_engine.detect_buffer_saturation`, `measure_queue_depth` | Throughput caps well below link speed; large payloads specifically affected |
| 11 | Connection reaping | `probes.idle_hold` | Long-lived/streaming connections die mid-response after a consistent duration |
| 12 | Fix application | `fix_application.FixApplier`, `fix_engine` | N/A — this hypothesis is "did the automated fix actually get applied" |
| 13 | Verification | `verification_engine` | N/A — "did the fix measurably help" |
| 14 | Monitoring | `monitoring_engine` | N/A — "did a fixed issue come back" |
| 15 | WiFi/DFS | `wifi_diagnostics.WiFiDiagnostics` | Drops correlate with 5 GHz DFS channels, band steering, or signal instability |

Hypotheses 12-14 aren't network symptoms — they're the tool checking its own
work (a fix was applied, it was verified, and a regression monitor is
watching for recurrence). If you're not running the fix/verify/monitor
workflow, they'll simply report `unavailable`.

## Additional diagnostic modules (Phases 16-21)

These extend past the original 15 with device- and service-specific checks,
run by `netcheck full-check`:

| Phase | Module | Symptom |
|---|---|---|
| 16 | `modem_diagnostics` | Cable modem: low SNR, uncorrectable codewords, not in bridge mode |
| 17 | `nat_diagnostics` | Double NAT — WAN IP the router sees is itself private (RFC 1918) |
| 18 | `cgnat_diagnostics` | Carrier-Grade NAT — WAN IP is in `100.64.0.0/10`; inbound connections and some P2P/gaming break |
| 19 | `anthropic_diagnostics` | The far side: is api.anthropic.com's status page reporting an incident |
| 20 | `interference_diagnostics` | Neighbouring APs crowding your Wi-Fi channel |
| 21 | `router_diagnostics` | Stale firmware, QoS/DPI settings, band steering, no bridge mode |

## Symptom index

Can't find your exact symptom in the tables above? Start here:

**"Claude Code / an API client dies mid-response, but only sometimes."**
→ Hypothesis 11 (connection reaping). Run `netcheck watch`; it runs
`idle_hold` periodically and will tell you if something reaps the
connection at a consistent duration. Rule out DFS radar events (15) and
interference (Phase 20) at the same time — both look like random drops.

**"Everything is slow, not broken."**
→ Hypotheses 1-2 (latency/jitter) or 10 (buffer bloat under load). Compare
idle vs. loaded latency; a large gap points at buffer bloat, look at your
router's QoS/SQM settings (Phase 21).

**"Works on my phone's hotspot, not on my home Wi-Fi."**
→ Hypothesis 15 (WiFi/DFS) or Phase 20 (interference) or Phase 21
(router DPI/QoS). `netcheck full-check` runs all three in one pass.

**"Works over VPN, not without it" (or vice versa).**
→ Hypothesis 8 (routing asymmetry) or hypothesis 6 (dual-stack) — the VPN
is changing which path or IP version your traffic takes. Check `environ.tailscale()`
if Tailscale is in the mix.

**"Router DNS is slow/wrong, but 1.1.1.1 works fine."**
→ Hypothesis 7. This is exactly the row shape `diagnose.culprit` looks for:
gateway ok, `dns_router` fail, `dns_public` ok. See `OPEN-ISSUES.md` #4 for a
known edge case (`dns_router_ms` reading exactly `0.0`).

**"Modem shows sync but errors persist."**
→ Phase 16 (modem_diagnostics) for signal/codewords, Phase 17/18
(NAT/CGNAT) for whether the modem is actually passing your traffic through
untouched. See `OPEN-ISSUES.md` #2 for what "sync" alone doesn't prove.

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

## Applying and verifying a fix

1. `fix_engine.recommend_fixes_for_diagnosis(diagnosis)` — ranked, specific
   fixes for the diagnosed culprit (Wi-Fi ~35% weight, router ~20%, modem the
   rest, roughly — see `fix_engine.py` for the exact weighting).
2. `fix_application.FixApplier` — applies a fix directly to the ASUS router
   or CAX80 modem over their authenticated HTTP APIs, or
   `tools/run_fixes.sh` for local OS-level fixes (DNS, adapter power, Wi-Fi
   mode) — see `tools/README.md`.
3. `verification_engine.verify_fix_resolves_issue(before, fix, after)` —
   confirms the specific layer that was failing before is passing after.
4. `monitoring_engine.detect_regression(baseline, current, sensitivity)` —
   run this periodically after a fix to catch it reverting.

`get_ethernet_test_setup()` in `fix_engine.py` is worth running before any
of the above: wiring in over Ethernet rules out the entire Wi-Fi layer (and,
by extension, hypotheses 1, 2, 15, and Phase 20) in one test.
