"""What this machine can tell us about its own network stack.

Every section returns a `state`. Sections needing credentials return
`unavailable` with a reason rather than raising or faking a result — a missing
modem password is not a broken modem, and the diagnosis engine relies on being
able to tell the difference.
"""
import json
import os
import re
import subprocess
from datetime import datetime, timezone

from . import probes

WINDOWS = probes.WINDOWS


def _ps(script, timeout=25):
    """Run PowerShell and parse its JSON, returning (data, reason).

    `reason` carries the actual failure — a script error, a timeout, a
    non-Windows host. Collapsing all of those into a bare None once made a
    broken query report itself as 'adapter not found', which sent the
    diagnosis looking in the wrong place entirely.
    """
    if not WINDOWS:
        return None, "not Windows"
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
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
    text, state = probes._run(["netsh", "wlan", "show", "interfaces"])
    if state != "ok":
        return _unavailable("netsh unavailable")
    return probes.parse_wlan_interfaces(text)


def congestion(channel, own_bssid=None):
    """How many other radios contend for our airtime."""
    if channel is None:
        return _unavailable("no channel; not associated")
    text, state = probes._run(["netsh", "wlan", "show", "networks", "mode=bssid"], 30)
    if state != "ok":
        return _unavailable("netsh unavailable")
    return probes.parse_wlan_networks(text, channel, own_bssid)


def driver(name="Wi-Fi"):
    """Adapter identity plus the settings that actually cause intermittent drops."""
    data, reason = _ps(
        "$a=Get-NetAdapter -Name '%s' -EA SilentlyContinue;"
        "if(-not $a){ exit };"
        "$p=@{}; Get-NetAdapterAdvancedProperty -Name '%s' -EA SilentlyContinue |"
        " ForEach-Object { $p[$_.DisplayName]=$_.DisplayValue };"
        "$pm=Get-NetAdapterPowerManagement -Name '%s' -EA SilentlyContinue;"
        # [string] rather than .ToString('fmt'): DriverDate has no single-arg
        # ToString overload and throws, taking the whole query down with it.
        "[pscustomobject]@{adapter=$a.InterfaceDescription;"
        " driver=$a.DriverVersion; driver_date=[string]$a.DriverDate;"
        " link=$a.LinkSpeed; props=$p;"
        " allow_power_off=[string]$pm.AllowComputerToTurnOffDevice}"
        " | ConvertTo-Json -Depth 4 -Compress" % (name, name, name))
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
        "$ip=(Resolve-DnsName %s -Type A -EA SilentlyContinue |"
        " Where-Object IPAddress | Select-Object -First 1).IPAddress;"
        "$r=if($ip){ (Find-NetRoute -RemoteIPAddress $ip -EA SilentlyContinue |"
        " Select-Object -First 1).InterfaceAlias };"
        "[pscustomobject]@{installed=$true; up=($a.Status -eq 'Up');"
        " egress=[string]$r; in_path=($r -like 'Tailscale*')}"
        " | ConvertTo-Json -Compress" % target)
    if data is None:
        return _unavailable(reason or "could not query adapters")
    return dict(data, state="ok")


def _http_get(url, user=None, password=None, timeout=6):
    import base64, urllib.error, urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "netcheck"})
    if user:
        token = base64.b64encode(f"{user}:{password or ''}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def modem(host=None, user=None, password=None):
    """DOCSIS line quality. Uncorrectable codewords are the single best
    indicator that the physical cable plant is the problem."""
    host = host or os.environ.get("MODEM_HOST", "192.168.100.1")
    user = user if user is not None else os.environ.get("MODEM_USER")
    password = password if password is not None else os.environ.get("MODEM_PASS")
    if not user:
        return _unavailable("no credentials: set MODEM_USER / MODEM_PASS in .env")

    body, err = _http_get(f"http://{host}/", user, password)
    if err:
        return {"state": "fail", "reason": err}

    text = re.sub(r"<[^>]+>", " ", body)
    snr = [float(x) for x in re.findall(r"(-?\d+\.\d+)\s*dB\b", text)][:8]
    power = [float(x) for x in re.findall(r"(-?\d+\.\d+)\s*dBmV", text)][:8]
    uncorr = [int(x) for x in re.findall(r"[Uu]ncorrectab\w*\D{0,40}(\d+)", text)][:8]
    return {"state": "ok", "snr_db": snr, "power_dbmv": power,
            "uncorrectables": uncorr}


def router(host=None, user=None, password=None):
    """ASUS routers ship DPI (AiProtection / Trend Micro) that is well known
    for reaping long-lived TLS streams — exactly this symptom."""
    host = host or os.environ.get("ROUTER_HOST", "192.168.50.1")
    user = user if user is not None else os.environ.get("ROUTER_USER")
    password = password if password is not None else os.environ.get("ROUTER_PASS")
    if not user:
        return _unavailable("no credentials: set ROUTER_USER / ROUTER_PASS in .env")

    body, err = _http_get(f"http://{host}/appGet.cgi?hook=nvram_get(productid)",
                          user, password)
    if err:
        return {"state": "fail", "reason": err}
    return {"state": "ok", "raw": body[:400]}


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
        "modem": modem(),
        "router": router(),
    }
    return out
