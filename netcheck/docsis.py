"""Parse a NETGEAR combo gateway's DocsisStatusAdv.htm.

The channel tables are not present as HTML text at all — the firmware
assigns a pipe-delimited string to a JS variable per table, which the
page's own script splits and renders client-side. This walks the same
five Init*TagValue() functions the page itself calls, so it survives
cosmetic HTML changes as long as the JS data functions keep their names.
Pure functions: text in, structured data out, no IO -- split out of
environ.py because this vendor-specific parsing has no shared state with
anything else there, and is a self-contained ~150 lines on its own.
"""
import json
import re


def _js_function_body(js, name):
    """Extract a JS function's body by brace-matching."""
    m = re.search(rf"function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{", js)
    if not m:
        return None
    depth, i = 1, m.end()
    start = i
    while i < len(js) and depth:
        if js[i] == "{":
            depth += 1
        elif js[i] == "}":
            depth -= 1
        i += 1
    return js[start:i - 1]


def _tag_value_list(js, function_name):
    """The real pipe-delimited `tagValueList` string from one Init*TagValue
    function. Each function's body also carries an older/example assignment
    inside a /* */ comment (kept as firmware documentation) — that must be
    stripped first or its stale numbers get picked up instead of the live
    ones, since it also matches `var tagValueList = "..."`.
    """
    body = _js_function_body(js, function_name)
    if body is None:
        return None
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    m = re.search(r"var\s+tagValueList\s*=\s*((?:['\"][^'\"]*['\"]\s*\+?\s*)+)", body)
    if not m:
        return None
    return "".join(re.findall(r"['\"]([^'\"]*)['\"]", m.group(1)))


def _docsis_rows(js, function_name, width):
    """Pipe string '<count>|f1|f2|...' -> list of `width`-wide field rows.
    The leading count is redundant with the row list's own length, so it is
    discarded rather than trusted."""
    tag_string = _tag_value_list(js, function_name)
    if not tag_string:
        return []
    fields = [f for f in tag_string.split("|") if f != ""]
    data = fields[1:]
    return [data[i:i + width] for i in range(0, len(data), width)
            if len(data[i:i + width]) == width]


def _num(text):
    m = re.search(r"-?[\d.]+", text or "")
    return float(m.group()) if m else None


def _hz(text):
    m = re.search(r"-?\d+", text or "")
    return int(m.group()) if m else None


def parse_docsis_status(js):
    """Parse a NETGEAR combo gateway's DocsisStatusAdv.htm.

    A pure function: takes the page text, returns structured data, no IO.
    """
    body = _js_function_body(js, "InitTagValue") or ""
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    m = re.search(r"var\s+tagValueList\s*=\s*(\{.*?\});", body, re.DOTALL)
    summary = json.loads(m.group(1)) if m else {}

    ds = [{"channel": r[0], "lock_status": r[1], "modulation": r[2],
           "channel_id": r[3], "frequency_hz": _hz(r[4]), "power_dbmv": _num(r[5]),
           "snr_db": _num(r[6]), "correctables": int(r[7]), "uncorrectables": int(r[8])}
          for r in _docsis_rows(js, "InitDsTableTagValue", 9)]

    us = [{"channel": r[0], "lock_status": r[1], "channel_type": r[2],
           "channel_id": r[3], "symbol_rate": r[4], "frequency_hz": _hz(r[5]),
           "power_dbmv": _num(r[6])}
          for r in _docsis_rows(js, "InitUsTableTagValue", 7)]

    ds_ofdm = [{"channel": r[0], "lock_status": r[1], "profile_id": r[2],
                "channel_id": r[3], "frequency_hz": _hz(r[4]), "power_dbmv": _num(r[5]),
                "snr_db": _num(r[6]), "subcarrier_range": r[7],
                "unerrored": int(r[8]), "correctable": int(r[9]), "uncorrectable": int(r[10])}
               for r in _docsis_rows(js, "InitDsOfdmTableTagValue", 11)]

    us_ofdma = [{"channel": r[0], "lock_status": r[1], "profile_id": r[2],
                 "channel_id": r[3], "frequency_hz": _hz(r[4]), "power_dbmv": _num(r[5])}
                for r in _docsis_rows(js, "InitUsOfdmaTableTagValue", 6)]

    def locked(rows):
        return [r for r in rows if r["lock_status"] == "Locked"]

    return {
        "state": "ok",
        "connectivity": summary.get("ConnectivityStateStatus"),
        "boot_state": summary.get("BootStateStatus"),
        "security": summary.get("SecurityStatus"),
        "system_time": summary.get("CurrentSystemTime"),
        "uptime": summary.get("SystemUpTime"),
        "downstream": ds,
        "upstream": us,
        "downstream_ofdm": ds_ofdm,
        "upstream_ofdma": us_ofdma,
        # Unlocked placeholder channels report power=0.0/snr=0.0, which would
        # be indistinguishable from a genuinely perfect channel — excluded so
        # these lists mean "measured", the same guarantee every probe carries.
        "snr_db": [r["snr_db"] for r in locked(ds) + locked(ds_ofdm)],
        "power_dbmv": [r["power_dbmv"] for r in locked(ds) + locked(us)
                       + locked(ds_ofdm) + locked(us_ofdma)],
        "uncorrectables": [r["uncorrectables"] for r in locked(ds)]
                          + [r["uncorrectable"] for r in locked(ds_ofdm)],
    }
