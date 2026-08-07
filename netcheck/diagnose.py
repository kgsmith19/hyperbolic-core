"""Turn samples and errors into ranked, actionable causes.

Two ideas carry the whole module:

  1. A sample row holds every layer at one instant, so the culprit is decided
     by which layers failed *together*, outermost-first.
  2. An error timestamp joined to the sample nearest it says whether the local
     network was actually broken at that moment. Without that join you cannot
     tell "my Wi-Fi dropped" from "the API had a bad minute".
"""
from datetime import datetime

WINDOW_S = 120

# Ordered outermost-in. A dead gateway breaks every probe downstream of it, so
# the first match wins and the report names one cause instead of six symptoms.
_RULES = (
    ("lan", ("gw_state",)),
    ("isp", ("hop_state",)),
    ("internet", ("inet_state",)),
)

_FIXES = {
    "lan": "Wi-Fi or the link to the router. Check adapter power management, "
           "driver version, and signal (RSSI better than -67 dBm).",
    "isp": "Your ISP's first hop. Capture modem DOCSIS levels (SNR, "
           "uncorrectable codewords) and open a ticket with these timestamps.",
    "internet": "Upstream of your ISP's edge — peering or transit. Usually "
                "resolves itself; the log is your evidence if it does not.",
    "router_dns": "The router is your only resolver and it is intermittently "
                  "failing. Set the adapter's DNS to 1.1.1.1 and 8.8.8.8, or "
                  "change the WAN DNS on the router itself.",
    "dns": "Both resolvers failed together, so this is upstream of the router.",
    "app": "Path is healthy but the endpoint is not reachable. Suspect TLS "
           "interception, router DPI (ASUS AiProtection / Trend Micro), or the "
           "far side.",
    "wifi_mode_pinned": "The adapter is pinned below its capability. Set "
                        "'802.11n/ac/ax Wireless Mode' back to its default -- "
                        "then cycle the adapter (scripts/reset-wifi-adapter.ps1), "
                        "since a driver property change alone does not force "
                        "the live link to renegotiate.",
    "anthropic_incident": "Nothing local will fix this. Stop changing your "
                          "network; wait for the incident to clear and keep "
                          "`watch` running so you can prove which outage was "
                          "theirs.",
    "double_nat": "Two routers are NATing you. Put the modem back into bridge "
                  "mode, or put the downstream router into AP mode -- long-lived "
                  "TLS streams die on whichever box ages the connection out first.",
    "cgnat": "Your ISP shares one public address across customers, so inbound "
             "ports and port forwarding cannot work. Ask the ISP for a dedicated "
             "IP, or route through a VPN. Not fixable on your own equipment.",
    "modem_signal": "Uncorrectable codewords mean the coax plant is dropping "
                    "data the modem cannot rebuild. Check connectors and "
                    "splitters, then open an ISP ticket citing these counts and "
                    "timestamps -- this is the number that gets a truck rolled.",
    "router_dpi": "AiProtection / Trend Micro DPI inspects and ages out "
                  "long-lived TLS streams, which is exactly this symptom. "
                  "Disable it, retest for five minutes, then re-enable "
                  "selectively if that was not it.",
    "radio_drops": "The adapter's radio is power-cycling. Turn off 'Allow the "
                   "computer to turn off this device to save power' in Device "
                   "Manager, and check for a driver update.",
    "wifi_congestion": "Too many radios share your channel. Move to a quieter "
                       "one -- non-DFS 5 GHz (36-48, 149-165) has the most room.",
    "dfs_channel": "DFS channels must vacate for radar, dropping every "
                   "connection at once with no warning. Pin the AP to a non-DFS "
                   "channel: 36-48 or 149-165.",
    "tailscale_in_path": "The tunnel carries the API route, so its MTU, DNS, and "
                         "exit node are all in play. Re-test with Tailscale down "
                         "to tell tunnel faults from network faults.",
    "low_mtu": "The path MTU is below 1500, so something is fragmenting or "
               "black-holing full-size packets. Check the tunnel/PPPoE MTU and "
               "that ICMP fragmentation-needed is not being filtered.",
}

# Standing conditions the environment scan measures. A sample row says what
# broke at an instant; these say what is wrong the whole time. Each entry is
# (cause, scan section, confidence, evidence-or-None). The section reaches
# the callback only when its state is "ok" -- "we could not measure" and "the
# query itself broke" are never evidence of a fault.
_SCAN_RULES = (
    ("anthropic_incident", "anthropic", "high",
     lambda s: f"status.anthropic.com reports {s.get('indicator')}"
               f" ({s.get('description')})" if s.get("degraded") else None),
    ("double_nat", "wan", "high",
     lambda s: f"WAN address {s.get('ip')} is RFC 1918, so a second router is "
               f"NATing us" if s.get("double_nat") else None),
    ("cgnat", "wan", "medium",
     lambda s: f"WAN address {s.get('ip')} is in the carrier-NAT range "
               f"100.64.0.0/10" if s.get("cgnat") else None),
    ("modem_signal", "modem", "high",
     lambda s: f"{sum(s['uncorrectables'])} uncorrectable codewords across "
               f"{len(s['uncorrectables'])} locked channels"
               if sum(s.get("uncorrectables") or []) else None),
    ("router_dpi", "router", "medium",
     lambda s: "AiProtection/DPI is enabled on the router"
               if s.get("aiprotection_enabled") else None),
    ("radio_drops", "events", "high",
     lambda s: f"{s['radio_off']} radio power-off events in the last 24h"
               if s.get("radio_off") else None),
    ("wifi_congestion", "congestion", "medium",
     lambda s: f"{s['cochannel']} other networks on our channel, "
               f"{s.get('same_block', 0)} more in the same 80 MHz block"
               if (s.get("cochannel") or 0) > 3 else None),
    ("dfs_channel", "wifi", "low",
     lambda s: f"channel {s['channel']} is DFS; radar forces an unannounced "
               f"channel change" if 52 <= (s.get("channel") or 0) <= 144 else None),
    ("tailscale_in_path", "tailscale", "medium",
     lambda s: f"the API route egresses via {s.get('egress')}"
               if s.get("in_path") else None),
    ("low_mtu", "mtu", "medium",
     lambda s: f"largest packet that gets through is {s['mtu']} bytes, not 1500"
               if 0 < (s.get("mtu") or 0) < 1500 else None),
    ("wifi_mode_pinned", "driver", "medium",
     lambda s: f"{s.get('adapter')} is set to '{s.get('wireless_mode')}', below "
               f"its capability"
               if "Wi-Fi 6" in str(s.get("adapter") or "")
               and "ax" not in str(s.get("wireless_mode") or "").lower() else None),
)


def _ts(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _broke(row, key):
    """True only for a measured failure. 'unavailable' means we did not look,
    and must never be read as evidence of a fault."""
    return row.get(key) == "fail"


def culprit(row):
    """Name the layer that broke, or None if the row is healthy."""
    for name, keys in _RULES:
        if all(_broke(row, k) for k in keys):
            return name

    if _broke(row, "dns_router_state"):
        # Both failing means the problem is past the router, not in it.
        return "dns" if _broke(row, "dns_public_state") else "router_dns"

    if _broke(row, "tls_state") or _broke(row, "http_state"):
        return "app"
    return None


def bursts(errors, gap_s=60):
    """Group errors that arrived together.

    A single 20-second dropout throws several errors as the client retries.
    Counting them individually would inflate how often the link actually
    breaks, which is the number worth acting on.
    """
    out = []
    for e in sorted(errors, key=lambda x: x["ts"]):
        t = _ts(e["ts"])
        if out and (t - out[-1]["_end"]).total_seconds() <= gap_s:
            out[-1]["count"] += 1
            out[-1]["_end"] = t
        else:
            out.append({"start": e["ts"], "count": 1, "_start": t, "_end": t})
    for b in out:
        b["span_s"] = int((b.pop("_end") - b.pop("_start")).total_seconds())
    return out


def correlate(errors, samples, window_s=WINDOW_S):
    """Attach a verdict to each error from the network state around it."""
    rows = sorted(({"t": _ts(s["ts"]), "row": s} for s in samples),
                  key=lambda x: x["t"])
    out = []
    for e in errors:
        # No sample near this error means we were not watching at that moment —
        # whether the database is empty or merely has a gap. One label, because
        # they are the same fact and a second one only reads as "we looked and
        # found nothing", which would be a much stronger claim.
        verdict = "unmonitored"
        if rows:
            t = _ts(e["ts"])
            near = min(rows, key=lambda r: abs((r["t"] - t).total_seconds()))
            if abs((near["t"] - t).total_seconds()) <= window_s:
                verdict = culprit(near["row"]) or "not_local"
        out.append(dict(e, verdict=verdict))
    return out


def _sample_causes(samples):
    """How often each culprit recurred across the measured history."""
    counts = {}
    for s in samples:
        c = culprit(s)
        if c:
            counts[c] = counts.get(c, 0) + 1

    total = len(samples) or 1
    return [{
        "cause": cause,
        "confidence": "high" if n / total >= 0.10 else
                      "medium" if n / total >= 0.02 else "low",
        "evidence": f"{n} of {total} samples ({n / total:.0%}) showed this pattern",
        "fix": _FIXES.get(cause, ""),
    } for cause, n in sorted(counts.items(), key=lambda kv: -kv[1])]


def _burst_causes(errors):
    """LLM errors arriving in clusters, and how many landed unmonitored."""
    grouped = bursts(errors) if errors else []
    if not grouped:
        return []
    worst = max(grouped, key=lambda b: b["count"])
    blind = sum(1 for e in errors if e.get("verdict") == "unmonitored")
    return [{
        "cause": "llm_error_bursts",
        "confidence": "high" if len(grouped) > 3 else "medium",
        "evidence": f"{len(errors)} LLM errors in {len(grouped)} bursts; "
                    f"largest {worst['count']} errors over {worst['span_s']}s"
                    + (f"; {blind} occurred with no monitoring running"
                       if blind else ""),
        "fix": "Bursts within seconds indicate a brief total loss of "
               "connectivity rather than congestion. Leave `watch` running "
               "so the next burst lands beside a measured sample.",
    }]


def _scan_causes(scan):
    """Standing conditions the environment scan actually measured."""
    out = []
    for cause, section, confidence, evidence in _SCAN_RULES:
        data = scan.get(section) if isinstance(scan, dict) else None
        if not isinstance(data, dict) or data.get("state") != "ok":
            continue
        found = evidence(data)
        if found:
            out.append({"cause": cause, "confidence": confidence,
                        "evidence": found, "fix": _FIXES[cause]})
    return out


def rank(samples, errors, scan):
    """Ranked causes, most confident first, each with evidence and a fix."""
    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(_sample_causes(samples) + _burst_causes(errors) + _scan_causes(scan),
                  key=lambda c: order[c["confidence"]])
