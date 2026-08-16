"""Turn what was measured into a ranked, actionable report.

diagnose.py answers "what broke in this row". This answers "what should the
user be told, and in what order" -- drawing on three sources at once: culprits
that recurred across the sample history, CLI-transcript API errors grouped
into bursts, and the standing conditions the latest environment scan
measured. Reading a row is a different job from deciding what to say about
a hundred of them, which is why the split follows the one the tests had.
"""
from . import change_templates
from .diagnose import bursts, culprit

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
    "broken_ipv6": "IPv6 cannot reach the target but IPv4 can. Connections "
                   "still succeed, so this shows up as intermittent stalls "
                   "rather than an outage. Fix the IPv6 path, or turn IPv6 off "
                   "on the adapter so the client stops trying it at all.",
    "broken_ipv4": "IPv4 cannot reach the target but IPv6 can -- unusual, and "
                   "worth checking the adapter's IPv4 address, its default "
                   "route, and any IPv4-only firewall rule.",
    "tcp_autotuning": "TCP receive-window autotuning is not at the Windows "
                      "default. In an elevated terminal, run `netsh interface "
                      "tcp set global autotuninglevel=normal`, then retest.",
    "lan_open_management_port": "A LAN device has an open management port. If "
                                "remote administration is not required, close "
                                "the port or restrict access to trusted hosts.",
    "lan_default_credentials": "A device accepted a factory-default credential "
                               "entry. Change that device password immediately "
                               "to a unique, strong value.",
}

# Reserved cause-to-template mapping. It stays empty with the template registry,
# so every ranked cause provides a manual remedy only.
_TEMPLATES = {}

def _fix(cause):
    """Return the manual remedy and, if ever enabled, its gated template."""
    text = _FIXES.get(cause, "")
    name = _TEMPLATES.get(cause)
    if name:
        t = change_templates.TEMPLATES[name]
        text += (f" A proposable '{name}' change template exists for this: "
                 f"`python -m network_checker change propose --title \"{t['title']}\" "
                 f"--cmd \"{t['change_cmd']}\" --inverse \"{t['inverse_cmd']}\" "
                 f"--verify \"{t['verify_probe']}\"`, then `change test <id>` to "
                 f"dry-run it and `change show <id>` to review the evidence "
                 f"before `change approve <id>`.")
    return text

def _one_family_broken(section, broken, working):
    """True only when one address family measured a failure and the other
    measured success. Happy Eyeballs makes that the interesting case: the
    connection still works, so nothing else in this tool would flag it."""
    return (section.get(broken, {}).get("state") == "fail"
            and section.get(working, {}).get("state") == "ok")

def _exposure_open_port(scan):
    names = [f"{f.get('ip')}:{f.get('port')}" for f in (scan.get("findings") or [])
             if f.get("kind") == "open_port"]
    return ("open management ports detected: " + ", ".join(names)) if names else None

def _exposure_default_credential(scan):
    names = [f"{f.get('ip')} matched credential list entry {f.get('entry')}"
             for f in (scan.get("findings") or [])
             if f.get("kind") == "default_credential"]
    return "; ".join(names) if names else None

def _tcp_autotuning(scan):
    level = str(scan.get("autotuning") or "").strip().lower()
    if not level or level == "normal":
        return None
    return ("TCP receive-window autotuning is set to "
            f"'{scan.get('autotuning')}', not the default 'normal'")

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
    # Reported per family, and only when the *other* family works: both down
    # is an outage the per-layer rules already name, and `unavailable` means
    # the target has no address there, which says nothing about our stack.
    ("broken_ipv6", "dual_stack", "high",
     lambda s: f"IPv6 failed ({s['ipv6'].get('reason')}) while IPv4 reached it "
               f"in {s['ipv4'].get('ms')}ms"
               if _one_family_broken(s, "ipv6", "ipv4") else None),
    ("broken_ipv4", "dual_stack", "high",
     lambda s: f"IPv4 failed ({s['ipv4'].get('reason')}) while IPv6 reached it "
               f"in {s['ipv6'].get('ms')}ms"
               if _one_family_broken(s, "ipv4", "ipv6") else None),
    ("tcp_autotuning", "tcp", "low", _tcp_autotuning),
    ("wifi_mode_pinned", "driver", "medium",
     lambda s: f"{s.get('adapter')} is set to '{s.get('wireless_mode')}', below "
               f"its capability"
               if "Wi-Fi 6" in str(s.get("adapter") or "")
               and "ax" not in str(s.get("wireless_mode") or "").lower() else None),
    ("lan_open_management_port", "exposure", "medium", _exposure_open_port),
    ("lan_default_credentials", "exposure", "high", _exposure_default_credential),
)

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
        "fix": _fix(cause),
    } for cause, n in sorted(counts.items(), key=lambda kv: -kv[1])]

def _burst_causes(errors):
    """API errors from a CLI transcript, arriving in clusters, and how many
    landed unmonitored -- one evidence source among the report's others."""
    grouped = bursts(errors) if errors else []
    if not grouped:
        return []
    worst = max(grouped, key=lambda b: b["count"])
    blind = sum(1 for e in errors if e.get("verdict") == "unmonitored")
    return [{
        "cause": "llm_error_bursts",
        "confidence": "high" if len(grouped) > 3 else "medium",
        "evidence": f"{len(errors)} API errors from the CLI transcript in "
                    f"{len(grouped)} bursts; largest {worst['count']} errors "
                    f"over {worst['span_s']}s"
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
                        "evidence": found, "fix": _fix(cause)})
    return out

def rank(samples, errors, scan):
    """Ranked causes, most confident first, each with evidence and a fix."""
    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(_sample_causes(samples) + _burst_causes(errors) + _scan_causes(scan),
                  key=lambda c: order[c["confidence"]])
