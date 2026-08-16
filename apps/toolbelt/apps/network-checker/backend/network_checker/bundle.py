"""Evidence bundle export (Issue #74).

Packages what network-checker already collected -- probes, environment scans, LLM
error correlation, ranked diagnoses, labeled experiments -- into one
shareable artifact, safe to hand to an AI, ISP, router vendor, or engineer.

`build()` is a pure function over data already read out of the store: no
socket, no subprocess, no filesystem write. That makes "no network call
during export" a structural property of this module, not something a test
has to police, and keeps the bundle a read-only derived view -- raw evidence
always stays in the database.

Redaction is a second, independent pass (`redact()`) applied to the whole
assembled structure right before it leaves this module, so a future field
added to `build()` is redacted by default rather than by remembering to.
"""
import json
import re
from datetime import datetime, timezone

from . import __version__
from .diagnose import bursts, correlate
from .experiment import compare
from .rank import rank

_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_MAC_RE = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b")
# Two forms only: full 8-group (needs all 7 colons, so it can't false-positive
# on a HH:MM:SS timestamp or a MAC's 5 colons) and any form carrying the "::"
# zero-compression marker real IPv6 text almost always uses. An uncompressed,
# non-full address missing that marker -- vanishingly rare in practice -- is
# the one shape this does not catch.
_IPV6_RE = re.compile(
    r"\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b"
    r"|\b(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}\b"
    r"|\B:(?::[0-9A-Fa-f]{1,4}){1,7}\b")
_WIN_PATH_RE = re.compile(r'[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n]+')
_UNIX_PATH_RE = re.compile(r"/(?:home|Users)/[^/\s]+")
_SECRET_KV_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key)\b\s*[:=]\s*\S+")
_BEARER_RE = re.compile(r"\b(?:Bearer|Basic)\s+\S+")

# Non-identifying scalar fields worth keeping from each `environ.scan()`
# section. Deliberately an allowlist, not a blocklist over the raw payload:
# a field this list omits is simply absent, never a redaction bug.
_SUMMARY_FIELDS = {
    "wifi": ("state", "band", "channel", "signal_pct", "rssi_dbm"),
    "wan": ("state", "double_nat", "cgnat"),
    "anthropic": ("state", "indicator", "degraded"),
    "router": ("state", "aiprotection_enabled"),
    "tailscale": ("state", "installed", "in_path"),
    "mtu": ("state", "mtu"),
    "tcp": ("state", "autotuning", "rss", "ecn"),
}


def redact(value):
    """Strip IPs, MACs, home-directory paths, and credential-shaped text
    from any string anywhere in a JSON-like structure. Recurses through
    dicts and lists; other types pass through unchanged."""
    if isinstance(value, str):
        out = _IPV4_RE.sub("[REDACTED-IP]", value)
        out = _MAC_RE.sub("[REDACTED-MAC]", out)
        out = _IPV6_RE.sub("[REDACTED-IP]", out)
        out = _WIN_PATH_RE.sub("[REDACTED-PATH]", out)
        out = _UNIX_PATH_RE.sub("[REDACTED-PATH]", out)
        out = _SECRET_KV_RE.sub(r"\1=[REDACTED-SECRET]", out)
        out = _BEARER_RE.sub("[REDACTED-SECRET]", out)
        return out
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def _pick(section, keys):
    if not isinstance(section, dict):
        return {"state": "unavailable"}
    return {k: section.get(k) for k in keys if k in section}


def _dual_stack_summary(section):
    if not isinstance(section, dict):
        return {"state": "unavailable"}
    return {"state": section.get("state"),
            "ipv4": _pick(section.get("ipv4"), ("state", "ms")),
            "ipv6": _pick(section.get("ipv6"), ("state", "ms"))}


def _modem_summary(section):
    if not isinstance(section, dict) or section.get("state") != "ok":
        state = section.get("state") if isinstance(section, dict) else "unavailable"
        return {"state": state}
    codewords = section.get("uncorrectables") or []
    return {"state": "ok", "uncorrectable_total": sum(codewords),
            "channels": len(codewords)}


def _network_summary(scan):
    out = {name: _pick(scan.get(name), keys) for name, keys in _SUMMARY_FIELDS.items()}
    out["dual_stack"] = _dual_stack_summary(scan.get("dual_stack"))
    out["modem"] = _modem_summary(scan.get("modem"))
    return out


def _latest_experiment(samples):
    """The two most recently active distinct labels, compared -- or None
    when fewer than two labeled runs exist."""
    labels = []
    for s in samples:  # already ordered newest-first (store.samples())
        label = s.get("label")
        if label and label not in labels:
            labels.append(label)
        if len(labels) == 2:
            break
    if len(labels) < 2:
        return None
    newer, older = labels
    by_label = {lbl: [s for s in samples if s.get("label") == lbl] for lbl in (older, newer)}
    return {"label_a": older, "label_b": newer,
            "result": compare(by_label[older], by_label[newer])}


def build(samples, raw_errors, latest_scan, meta=None):
    """Assemble the redacted bundle from already-fetched store data.

    `samples`/`raw_errors` are `store.samples()`/`store.errors()` rows,
    `latest_scan` is the most recent `env_scans.payload`, already decoded.
    `meta` optionally carries `os_name` and a fixed `now` (tests only --
    real callers leave `now` unset so it defaults to the actual time).
    """
    meta = meta or {}
    os_name = meta.get("os_name")
    now = meta.get("now") or datetime.now(timezone.utc)
    errors = correlate(raw_errors, samples)
    verdicts = {}
    for e in errors:
        verdicts[e["verdict"]] = verdicts.get(e["verdict"], 0) + 1
    tier = "deep" if "topology" in latest_scan else "standard" if latest_scan else None

    out = {
        "generated_at": now.isoformat(timespec="seconds"),
        "network_checker_version": __version__,
        "platform": {"os": os_name},
        "collection": {
            "commands": ["network-checker probe",
                        f"network-checker scan --tier {tier or 'standard'}",
                        "network-checker diagnose"],
            "scan_tier": tier,
            "sample_count": len(samples),
            "llm_error_count": len(raw_errors),
        },
        "network_summary": _network_summary(latest_scan),
        "probe_summary": compare(samples, [])["a"],
        "llm_error_summary": {
            "count": len(errors),
            "by_verdict": verdicts,
            "bursts": len(bursts(raw_errors)) if raw_errors else 0,
        },
        "causes": rank(samples, errors, latest_scan),
        "experiment_comparison": _latest_experiment(samples),
    }
    return redact(out)


def render_json(data):
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def render_markdown(data):
    lines = [
        "# network-checker evidence bundle", "",
        f"- generated: {data['generated_at']}",
        f"- network-checker version: {data['network_checker_version']}",
        f"- platform: {data['platform']['os']}",
        f"- scan tier: {data['collection']['scan_tier']}",
        f"- samples: {data['collection']['sample_count']}",
        f"- LLM errors: {data['collection']['llm_error_count']}",
        "", "## Commands used",
        *(f"- `{c}`" for c in data["collection"]["commands"]),
        "", "## Network summary", "```json",
        json.dumps(data["network_summary"], indent=2, sort_keys=True), "```",
        "", "## Probe summary", "```json",
        json.dumps(data["probe_summary"], indent=2, sort_keys=True), "```",
        "", "## LLM error summary", "```json",
        json.dumps(data["llm_error_summary"], indent=2, sort_keys=True), "```",
        "", "## Ranked causes",
    ]
    if not data["causes"]:
        lines.append("(none identified yet)")
    for n, c in enumerate(data["causes"], 1):
        lines += [f"{n}. **{c['cause']}** [{c['confidence']}]",
                  f"   - evidence: {c['evidence']}", f"   - fix: {c['fix']}"]
    lines += ["", "## Controlled comparison"]
    comp = data["experiment_comparison"]
    lines.append(f"```json\n{json.dumps(comp, indent=2, sort_keys=True)}\n```"
                 if comp else "(no two labeled experiment runs available)")
    return "\n".join(lines) + "\n"
