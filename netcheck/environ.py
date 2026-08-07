"""What this machine can tell us about its own network stack.

Every section returns a `state`. Sections needing credentials return
`unavailable` with a reason rather than raising or faking a result — a missing
modem password is not a broken modem, and the diagnosis engine relies on being
able to tell the difference.
"""
import json
import os
import subprocess
from datetime import datetime, timezone

from . import dualstack, probes, remote, wlan_probes

WINDOWS = probes.WINDOWS
MACOS = probes.MACOS

# Apple removed the standalone `airport` CLI from the PATH in the Big Sur
# era; it still exists at this fixed path through at least macOS 13. If a
# future release drops it entirely, this call degrades to `unavailable` via
# probes._run's FileNotFoundError handling, same as any other missing tool.
_AIRPORT = ("/System/Library/PrivateFrameworks/Apple80211.framework/"
            "Versions/Current/Resources/airport")

# The endpoint the target-dependent sections measure against. Read from the
# environment so `scan` and `probe` never disagree about what they diagnosed.
TARGET = os.environ.get("NETCHECK_TARGET", "api.anthropic.com")


def _ps(script, timeout=25, args=()):
    """Run PowerShell and parse its JSON, returning (data, reason).

    `reason` carries the actual failure — a script error, a timeout, a
    non-Windows host. Collapsing all of those into a bare None once made a
    broken query report itself as 'adapter not found', which sent the
    diagnosis looking in the wrong place entirely.

    `args` are passed as trailing subprocess arguments, available inside
    `script` via PowerShell's own `$args` array — never interpolated into
    the script text itself, so a caller-supplied value containing a quote
    can't break out of the script and inject additional commands.
    """
    if not WINDOWS:
        return None, "not Windows"
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script, *args],
            capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"powershell timed out after {timeout}s"
    except OSError as e:
        return None, f"powershell unavailable: {e}"

    out = (p.stdout or "").strip()
    if not out:
        err = (p.stderr or "").strip().splitlines()
        return None, f"powershell error: {err[0]}" if err else "no output"
    try:
        return json.loads(out), None
    except ValueError:
        return None, f"unparseable output: {out[:120]}"


def _unavailable(reason):
    return {"state": "unavailable", "reason": reason}


def wifi():
    if MACOS:
        text, state = probes._run([_AIRPORT, "-I"])
        if state != "ok":
            return _unavailable("airport unavailable")
        return wlan_probes.parse_airport_info(text)
    text, state = probes._run(["netsh", "wlan", "show", "interfaces"])
    if state != "ok":
        return _unavailable("netsh unavailable")
    return wlan_probes.parse_wlan_interfaces(text)


def congestion(channel, own_bssid=None):
    """How many other radios contend for our airtime."""
    if channel is None:
        return _unavailable("no channel; not associated")
    text, state = probes._run(["netsh", "wlan", "show", "networks", "mode=bssid"], 30)
    if state != "ok":
        return _unavailable("netsh unavailable")
    return wlan_probes.parse_wlan_networks(text, channel, own_bssid)


def driver(name="Wi-Fi"):
    """Adapter identity plus the settings that actually cause intermittent drops."""
    data, reason = _ps(
        "$n=$args[0];"
        "$a=Get-NetAdapter -Name $n -EA SilentlyContinue;"
        "if(-not $a){ exit };"
        "$p=@{}; Get-NetAdapterAdvancedProperty -Name $n -EA SilentlyContinue |"
        " ForEach-Object { $p[$_.DisplayName]=$_.DisplayValue };"
        "$pm=Get-NetAdapterPowerManagement -Name $n -EA SilentlyContinue;"
        # [string] rather than .ToString('fmt'): DriverDate has no single-arg
        # ToString overload and throws, taking the whole query down with it.
        "[pscustomobject]@{adapter=$a.InterfaceDescription;"
        " driver=$a.DriverVersion; driver_date=[string]$a.DriverDate;"
        " link=$a.LinkSpeed; props=$p;"
        " allow_power_off=[string]$pm.AllowComputerToTurnOffDevice}"
        " | ConvertTo-Json -Depth 4 -Compress",
        args=[name])
    if not data:
        return _unavailable(reason or f"adapter {name!r} not found")

    props = data.get("props") or {}
    return {"state": "ok",
            "adapter": data.get("adapter"),
            "driver": data.get("driver"),
            "driver_date": data.get("driver_date"),
            "link": data.get("link"),
            "allow_power_off": data.get("allow_power_off"),
            "wireless_mode": props.get("802.11n/ac/ax Wireless Mode"),
            "roaming": props.get("Roaming Aggressiveness"),
            "transmit_power": props.get("Transmit Power"),
            "preferred_band": props.get("Preferred Band")}


def events(hours=24):
    """Recent network events. Radio off/on pairs are the ones worth counting:
    each is a total link loss lasting seconds."""
    # ProviderName goes inside the filter hashtable so the event log does the
    # selection. Pulling 24h of System events into PowerShell and filtering
    # there took longer than the whole rest of the scan combined.
    data, reason = _ps(
        "$p=(Get-WinEvent -ListProvider * -EA SilentlyContinue |"
        " Where-Object Name -match '^(Netwtw|Tcpip$|Microsoft-Windows-(Dhcp|DNS)-Client"
        "|Microsoft-Windows-WLAN-AutoConfig)').Name;"
        "if(-not $p){ exit };"
        "$e=Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName=$p;"
        " StartTime=(Get-Date).AddHours(-%d)} -EA SilentlyContinue;"
        "[pscustomobject]@{total=@($e).Count;"
        " radio_off=@($e | Where-Object Id -eq 7012).Count;"
        " radio_on=@($e | Where-Object Id -eq 7011).Count;"
        " dns_timeouts=@($e | Where-Object Id -eq 1014).Count;"
        " recent=@($e | Select-Object -First 12 |"
        "  ForEach-Object { [pscustomobject]@{ts=$_.TimeCreated.ToString('s');"
        "   provider=$_.ProviderName; id=$_.Id} })}"
        " | ConvertTo-Json -Depth 4 -Compress" % hours,
        # Measured at ~21s on this machine; the default 25s left no headroom.
        timeout=60)
    if not data:
        return _unavailable(reason or "no matching events")
    return dict(data, state="ok")


def tcp_globals():
    text, state = probes._run(["netsh", "interface", "tcp", "show", "global"])
    if state != "ok":
        return _unavailable("netsh unavailable")
    fields = {k.strip(): v.strip()
              for k, _, v in (l.partition(":") for l in text.splitlines()) if v.strip()}
    return {"state": "ok", "autotuning": fields.get("Receive Window Auto-Tuning Level"),
            "rss": fields.get("Receive-Side Scaling State"),
            "ecn": fields.get("ECN Capability")}


def mtu(host="1.1.1.1", sizes=(1472, 1460, 1440, 1400, 1300, 1200)):
    """Walk the DF bit down until a packet gets through; +28 for the headers."""
    for size in sizes:
        if WINDOWS:
            cmd = ["ping", "-n", "1", "-f", "-l", str(size), host]
        else:
            cmd = ["ping", "-c", "1", "-M", "do", "-s", str(size), host]
        text, state = probes._run(cmd, 8)
        if state == "ok" and probes.parse_ping(text)["state"] == "ok":
            return {"state": "ok", "mtu": size + 28}
    return _unavailable("no size succeeded; ICMP may be filtered")


def tailscale(target="api.anthropic.com"):
    """A VPN tunnel that captures the API route, or the DNS for it, changes
    everything downstream — so record whether it is in the path."""
    data, reason = _ps(
        "$a=Get-NetAdapter -InterfaceDescription 'Tailscale*' -EA SilentlyContinue;"
        "if(-not $a){ '{\"installed\":false}'; exit };"
        "$t=$args[0];"
        "$ip=(Resolve-DnsName $t -Type A -EA SilentlyContinue |"
        " Where-Object IPAddress | Select-Object -First 1).IPAddress;"
        "$r=if($ip){ (Find-NetRoute -RemoteIPAddress $ip -EA SilentlyContinue |"
        " Select-Object -First 1).InterfaceAlias };"
        "[pscustomobject]@{installed=$true; up=($a.Status -eq 'Up');"
        " egress=[string]$r; in_path=($r -like 'Tailscale*')}"
        " | ConvertTo-Json -Compress",
        args=[target])
    if data is None:
        return _unavailable(reason or "could not query adapters")
    return dict(data, state="ok")


_ASUS_UA = "asusrouter-Android-DUTUtil-1.0.0.201"


def scan():
    """One full environment snapshot."""
    link = wifi()
    out = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "wifi": link,
        "congestion": congestion(link.get("channel"), link.get("bssid")),
        "driver": driver(),
        "events": events(),
        "tcp": tcp_globals(),
        "mtu": mtu(),
        "tailscale": tailscale(),
        "dual_stack": dualstack.dual_stack(TARGET),
        "modem": remote.modem(),
        "router": remote.router(),
        "wan": remote.wan(),
        "anthropic": remote.anthropic(),
    }
    return out
