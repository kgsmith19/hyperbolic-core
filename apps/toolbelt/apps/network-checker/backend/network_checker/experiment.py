"""Controlled-comparison mode (FR-021, UC-006): compare two labeled runs of
the standard probe set.

`compare()` is a pure function over already-stored sample dicts -- no I/O, no
dependency on store.py -- so its median/state-mix math is testable without a
database. A side with zero samples is reported as having no data; it is
never given a fabricated median or state-mix, since that would misrepresent
an unmeasured condition as a measured one.
"""

LAYERS = ("gw", "hop", "inet", "dns_router", "dns_public", "tls", "http")
_STATES = ("ok", "fail", "unavailable")


def compare(samples_a, samples_b):
    """Each of LAYERS' median latency and ok/fail/unavailable state-mix for
    two lists of stored sample dicts, one side per input list."""
    return {"a": _side(samples_a), "b": _side(samples_b)}


def _side(samples):
    if not samples:
        return {"has_data": False, "count": 0, "layers": {}}
    return {"has_data": True, "count": len(samples),
            "layers": {layer: _layer_stats(samples, layer) for layer in LAYERS}}


def _layer_stats(samples, layer):
    mix = {state: 0 for state in _STATES}
    latencies = []
    for row in samples:
        state = row.get(f"{layer}_state")
        if state in mix:
            mix[state] += 1
        ms = row.get(f"{layer}_ms")
        if ms is not None:
            latencies.append(ms)
    return {"median_ms": _median(latencies), "state_mix": mix}


def _median(values):
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def format_report(label_a, label_b, result):
    """Plain-ASCII side-by-side report, in cmd_diagnose's print style."""
    lines = [f"\nnetwork-checker experiment - comparing {label_a!r} vs {label_b!r}\n",
             _side_summary(label_a, result["a"]), _side_summary(label_b, result["b"])]
    if not (result["a"]["has_data"] and result["b"]["has_data"]):
        lines.append("\n  No comparison numbers for a label with no data.\n")
        return "\n".join(lines)

    lines.append("")
    for layer in LAYERS:
        lines.append(f"  {layer}")
        lines.append(_layer_line(label_a, result["a"]["layers"][layer]))
        lines.append(_layer_line(label_b, result["b"]["layers"][layer]))
    return "\n".join(lines)


def _side_summary(label, side):
    if not side["has_data"]:
        return f"  {label!r}: no data"
    return f"  {label!r}: {side['count']} sample(s)"


def _layer_line(label, stats):
    median = f"{stats['median_ms']}ms" if stats["median_ms"] is not None else "-"
    mix = stats["state_mix"]
    mix_str = " ".join(f"{s}={mix[s]}" for s in _STATES)
    return f"    {label:<12} median={median:<8} {mix_str}"
