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
                        "'802.11n/ac/ax Wireless Mode' back to its default so "
                        "the card can negotiate 802.11ax.",
}


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


def rank(samples, errors, scan):
    """Ranked causes, most confident first, each with evidence and a fix."""
    causes = []
    total = len(samples) or 1

    counts = {}
    for s in samples:
        c = culprit(s)
        if c:
            counts[c] = counts.get(c, 0) + 1

    for cause, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        share = n / total
        causes.append({
            "cause": cause,
            "confidence": "high" if share >= 0.10 else "medium" if share >= 0.02 else "low",
            "evidence": f"{n} of {total} samples ({share:.0%}) showed this pattern",
            "fix": _FIXES.get(cause, ""),
        })

    grouped = bursts(errors) if errors else []
    if grouped:
        worst = max(grouped, key=lambda b: b["count"])
        unexplained = sum(1 for e in errors if e.get("verdict") == "unmonitored")
        causes.append({
            "cause": "llm_error_bursts",
            "confidence": "high" if len(grouped) > 3 else "medium",
            "evidence": f"{len(errors)} LLM errors in {len(grouped)} bursts; "
                        f"largest {worst['count']} errors over {worst['span_s']}s"
                        + (f"; {unexplained} occurred with no monitoring running"
                           if unexplained else ""),
            "fix": "Bursts within seconds indicate a brief total loss of "
                   "connectivity rather than congestion. Leave `watch` running "
                   "so the next burst lands beside a measured sample.",
        })

    driver = scan.get("driver") if isinstance(scan, dict) else None
    if isinstance(driver, dict) and driver.get("state") == "ok":
        mode = str(driver.get("wireless_mode") or "")
        adapter = str(driver.get("adapter") or "")
        if "Wi-Fi 6" in adapter and "ax" not in mode.lower():
            causes.append({
                "cause": "wifi_mode_pinned",
                "confidence": "medium",
                "evidence": f"{adapter} is set to '{mode}', below its capability",
                "fix": _FIXES["wifi_mode_pinned"],
            })

    order = {"high": 0, "medium": 1, "low": 2}
    return sorted(causes, key=lambda c: order[c["confidence"]])
