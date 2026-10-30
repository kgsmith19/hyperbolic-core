"""Linux `iw`/`ethtool` adapter-state probes: pure parsers over captured
command text, plus the IO that produces it -- the same split probes.py
documents for itself, and the same reason wlan_probes.py is its own file
rather than living inside probes.py: this is a self-contained ~150 lines
whose field mapping shares nothing with probes.py's ping/DNS/TLS/HTTP layer.

Written to close 05-f section 4.5's Finding 18's verification gap. Before
this module, the `wifi_mode` and `adapter_power` change templates verified
success with a bare `gw:ok` gateway ping -- a probe that stays `ok`
whether the tx-power fix or the power-management fix actually took effect
or not, since the gateway does not care about either setting. These two
probes measure the exact property each change claims to modify:

- `wifi_txpower`: the live tx power `iw dev <adapter> info` reports for
  the channel we're actually on, against that radio's own regulatory/
  hardware ceiling for that channel from `iw phy <phy> info`'s Frequencies
  table. `fix_wifi_mode.sh`'s only real device write
  (`iw phy phy0 set txpower auto`) asks the driver to stop capping
  power below that ceiling, so "at the ceiling" is the honest definition
  of "the fix took" -- not a guess, the same number the radio itself
  reports as its maximum for this channel.
- `adapter_power`: `power_save` off *and* Wake-on-LAN armed together, the
  exact pair `fix_adapter_power.sh`'s `disable_power_management` sets.

Wired into `probes.sample()` as `wifi_txpower_state` / `adapter_power_state`
so `change.py`'s existing, unmodified `_run_verify` -- which reads
`<field>_state` straight off that row -- can express
`verify_probe: "wifi_txpower:ok"` / `"adapter_power:ok"` without needing
`_run_verify` itself to change at all.

Known asymmetry, honestly noted rather than hidden: `_run_verify` reuses
the *same* verify_probe string to check both the forward apply (want: at
the ceiling / power-save off) and, on a failed verify, the rollback
(want: whatever the ORIGINAL captured value was, which may have been
pinned low or already had power-save on). A probe defined only as "matches
the forward goal" reads a *correct* rollback back to a genuinely pinned
original as a failure. `dns_public:ok` has the identical shape of problem
already; this module does not introduce a new one, and change.py would
need a per-direction verify expression (or a captured-value comparison) to
close it for real -- see change_templates.py's module docstring for the
full accounting of what a future change.py update would need.

Both fix scripts this module backs are Linux-only (`iw`, `ethtool`) --
Windows/macOS Wi-Fi link state already has its own path through
`environ.wifi()` / wlan_probes.py, which this module does not touch.
"""
import os
import re

from .probes import MACOS, WINDOWS, _run

LINUX = not WINDOWS and not MACOS


def find_adapter(pattern, fallback=None):
    """First `/sys/class/net` interface matching `pattern`, else the first
    matching `fallback` if given -- the identical two-step heuristic
    `find_adapter`/`detect_wifi_state` use in the shell scripts, ported to
    Python so a probe can run it without shelling out to `ls`."""
    try:
        names = sorted(os.listdir("/sys/class/net"))
    except OSError:
        return None
    for pat in (p for p in (pattern, fallback) if p):
        for name in names:
            if re.search(pat, name):
                return name
    return None


def parse_iw_link(text):
    """Live channel frequency (MHz) and tx power (dBm) from
    `iw dev <adapter> info`. No `txpower` line at all means the adapter
    query itself failed (wrong interface name, radio off) -- `unavailable`,
    not a fabricated reading."""
    if "txpower" not in text:
        return {"state": "unavailable", "freq_mhz": None, "txpower_dbm": None}
    freq = re.search(r"\((\d+) MHz\)", text)
    power = re.search(r"txpower\s+([\d.]+)\s*dBm", text)
    return {"state": "ok",
            "freq_mhz": int(freq.group(1)) if freq else None,
            "txpower_dbm": float(power.group(1)) if power else None}


def parse_iw_phy_ceiling(text, freq_mhz):
    """This radio's own regulatory/hardware tx-power ceiling (dBm) for one
    frequency, read off `iw phy <phy> info`'s per-channel Frequencies
    table -- the reference `parse_iw_link`'s live reading is judged
    against, rather than a hardcoded "full power" number this module would
    otherwise have to guess per chipset and regulatory domain."""
    if freq_mhz is None:
        return None
    m = re.search(rf"\* {freq_mhz} MHz \[\d+\] \(([\d.]+) dBm\)", text)
    return float(m.group(1)) if m else None


def parse_iw_power_save(text):
    """`iw dev <adapter> get power_save` -> True/False, or None if the
    line is missing (adapter not found, iw too old to answer)."""
    m = re.search(r"Power save:\s*(on|off)", text, re.IGNORECASE)
    return m.group(1).lower() == "on" if m else None


def parse_ethtool_wol(text):
    """`ethtool <adapter>`'s `Wake-on:` flag letters -> whether any wake
    mode is armed. `d` alone is "disabled"; any other letter (`g` is the
    magic-packet mode `fix_adapter_power.sh` sets) means something is."""
    m = re.search(r"Wake-on:\s*(\S+)", text)
    return None if not m else m.group(1) != "d"


def _ceiling_for(adapter, phy):
    """Live tx power plus this radio's ceiling for its current channel, or
    the `unavailable` reason either half of that lookup failed for."""
    link_text, state = _run(["iw", "dev", adapter, "info"])
    if state != "ok":
        return None, "iw dev info unavailable"
    link = parse_iw_link(link_text)
    if link["state"] != "ok":
        return None, "no txpower reported"
    phy_text, phy_state = _run(["iw", "phy", phy, "info"])
    ceiling = parse_iw_phy_ceiling(phy_text, link["freq_mhz"]) if phy_state == "ok" else None
    if ceiling is None:
        return None, "no regulatory ceiling found for this channel"
    return (link["txpower_dbm"], ceiling), None


def wifi_txpower(adapter=None, phy="phy0"):
    """`ok` when the live tx power is at (or within rounding of) this
    radio's own ceiling for its current channel -- "auto" wasn't capping
    it. `fail` when it measurably is. `unavailable` off Linux, with no
    adapter, or when either `iw` query itself did not answer."""
    adapter = adapter or find_adapter(r"wlan|wifi")
    if not LINUX or not adapter:
        return {"state": "unavailable", "reason": "no Linux WiFi adapter"}
    readings, reason = _ceiling_for(adapter, phy)
    if readings is None:
        return {"state": "unavailable", "reason": reason}
    live, ceiling = readings
    pinned = live < ceiling - 0.5   # tolerate float rounding in either report
    return {"state": "fail" if pinned else "ok", "txpower_dbm": live, "ceiling_dbm": ceiling}


def _read_adapter_power(adapter):
    """(power_save, wol) booleans from live `iw`/`ethtool` queries, or
    (None, None) if either command did not answer or its output did not
    parse -- kept separate from `adapter_power` purely to keep that
    function's own branching under the repo's complexity ceiling."""
    ps_text, ps_state = _run(["iw", "dev", adapter, "get", "power_save"])
    wol_text, wol_state = _run(["ethtool", adapter])
    if ps_state != "ok" or wol_state != "ok":
        return None, None
    return parse_iw_power_save(ps_text), parse_ethtool_wol(wol_text)


def adapter_power(adapter=None):
    """`ok` when power_save is off *and* Wake-on-LAN is armed -- the exact
    pair `fix_adapter_power.sh` sets -- `fail` when either is not,
    `unavailable` off Linux, with no adapter, or when `iw`/`ethtool`
    themselves did not answer or did not parse."""
    adapter = adapter or find_adapter(r"wlan|wifi", fallback=r"eth|eno|enp")
    if not LINUX or not adapter:
        return {"state": "unavailable", "reason": "no Linux adapter"}
    power_save, wol = _read_adapter_power(adapter)
    if power_save is None or wol is None:
        return {"state": "unavailable", "reason": "power state unreadable"}
    optimal = (power_save is False) and (wol is True)
    return {"state": "ok" if optimal else "fail",
            "power_save": power_save, "wol": wol, "adapter": adapter}
