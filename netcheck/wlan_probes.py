"""Wi-Fi link-state and neighbour-congestion parsers: text in, dict out.

Pure functions over `netsh wlan show interfaces`/`show networks` (Windows)
and `airport -I` (macOS) output -- tested against captured fixtures in
tests/fixtures/, no IO here. Split out of probes.py because Wi-Fi's own
field-mapping quirks (three link-state shapes across two OS tools, plus
80 MHz-block congestion math) are a self-contained ~110 lines with no
shared state with probes.py's connectivity probes (ping/DNS/TLS/HTTP).
"""
import re


def _fields(text):
    """netsh prints `Key : Value`; collect the first occurrence of each key."""
    out = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if key and key not in out:
            out[key] = value.strip()
    return out


def _num(value, cast=float):
    m = re.search(r"-?[\d.]+", value or "")
    return cast(m.group()) if m else None


def parse_wlan_interfaces(text):
    """Link state for the connected Wi-Fi interface."""
    if "no wireless interface" in text.lower():
        return {"state": "unavailable", "reason": "no wireless interface"}

    f = _fields(text)
    # `AP BSSID` on newer builds, plain `BSSID` on older ones.
    bssid = f.get("AP BSSID") or f.get("BSSID")
    return {
        "state": "ok" if f.get("State") == "connected" else "fail",
        "ssid": f.get("SSID"),
        "bssid": bssid,
        "band": f.get("Band"),
        "channel": _num(f.get("Channel"), int),
        "signal_pct": _num(f.get("Signal"), int),
        "rssi_dbm": _num(f.get("Rssi"), int),
        "rx_mbps": _num(f.get("Receive rate (Mbps)")),
        "tx_mbps": _num(f.get("Transmit rate (Mbps)")),
        "radio": f.get("Radio type"),
    }


def parse_airport_info(text):
    """Link state from macOS's `airport -I` output.

    Field-for-field this is a different tool than `netsh wlan show
    interfaces`, so the mapping is partial: `airport` gives no signal
    percentage, no separate rx/tx rates (just one link rate), and no radio
    type string, so those come back `None` rather than a guess. Built
    against Apple's long-documented output format -- see
    tests/fixtures/airport_info.txt for the caveat that this is not yet
    verified against a live capture the way the Windows parser is.
    """
    if "AirPort: Off" in text or not text.strip():
        return {"state": "unavailable", "reason": "Wi-Fi off or no interface"}

    f = _fields(text)
    channel = _num((f.get("channel") or "").split(",")[0], int)
    band = None
    if channel is not None:
        band = "2.4 GHz" if channel <= 14 else "5 GHz" if channel < 149 else "6 GHz"

    connected = f.get("state") == "running" and bool(f.get("SSID"))
    return {
        "state": "ok" if connected else "fail",
        "ssid": f.get("SSID"),
        "bssid": f.get("BSSID"),
        "band": band,
        "channel": channel,
        "signal_pct": None,
        "rssi_dbm": _num(f.get("agrCtlRSSI"), int),
        "rx_mbps": None,
        "tx_mbps": _num(f.get("lastTxRate")),
        "radio": None,
    }


def _block(channel):
    """Index of the 80 MHz block a 5 GHz channel sits in.

    Two APs in the same block contend for airtime even on different channel
    numbers, which is why co-channel counting alone understates interference.
    """
    return (channel - 36) // 16


def parse_wlan_networks(text, channel, own_bssid=None):
    """Count competing radios near our channel, excluding our own AP."""
    seen = []
    current = None
    for line in text.splitlines():
        bssid = re.search(r"BSSID\s+\d+\s*:\s*([0-9a-fA-F:]{17})", line)
        if bssid:
            current = bssid.group(1).lower()
            continue
        ch = re.search(r"^\s*Channel\s*:\s*(\d+)", line)
        if ch and current:
            seen.append((current, int(ch.group(1))))
            current = None

    if not seen:
        return {"state": "unavailable", "reason": "scan returned no BSSIDs",
                "total_bssids": 0, "cochannel": 0, "same_block": 0}

    own = (own_bssid or "").lower()
    others = [(b, c) for b, c in seen if b != own]
    cochannel = sum(1 for _, c in others if c == channel)
    if channel <= 14:                       # 2.4 GHz: 20 MHz channels overlap
        block = sum(1 for _, c in others if c != channel and abs(c - channel) < 5)
    else:
        block = sum(1 for _, c in others
                    if c != channel and c > 14 and _block(c) == _block(channel))
    return {"state": "ok", "total_bssids": len(seen),
            "cochannel": cochannel, "same_block": block}
