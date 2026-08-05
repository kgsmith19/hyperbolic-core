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
MACOS = probes.MACOS

# Apple removed the standalone `airport` CLI from the PATH in the Big Sur
# era; it still exists at this fixed path through at least macOS 13. If a
# future release drops it entirely, this call degrades to `unavailable` via
# probes._run's FileNotFoundError handling, same as any other missing tool.
_AIRPORT = ("/System/Library/PrivateFrameworks/Apple80211.framework/"
            "Versions/Current/Resources/airport")


def _ps(script, timeout=25, args=()):
    """Run PowerShell and parse its JSON, returning (data, reason).

    `reason` carries the actual failure — a script error, a timeout, a
    non-Windows host. Collapsing all of those into a bare None once made a
    broken query report itself as 'adapter not found', which sent the
    diagnosis looking in the wrong place entirely.

    `args` are passed as trailing subprocess arguments, available inside
    `script` via PowerShell's own `$args` array — never interpolated into
    the script text itself, so a caller-supplied value containing a quote
    can't break out of the script and inject additional commands
    (OPEN-ISSUES.md #5).
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
        return probes.parse_airport_info(text)
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


def _asus_login(host, user, password, timeout=6):
    """Authenticate to ASUS router via POST /login.cgi token flow.

    Returns (token, error). On success, token is a string; on failure, error
    explains why and token is None.
    """
    import base64, json, urllib.error, urllib.request

    login_auth = base64.b64encode(f"{user}:{password or ''}".encode()).decode()
    url = f"http://{host}/login.cgi"
    req = urllib.request.Request(
        url,
        method="POST",
        data=b"",
        headers={
            "User-Agent": "asusrouter-Android-DUTUtil-1.0.0.201",
            "login_authorization": login_auth,
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            try:
                data = json.loads(body)
                token = data.get("asus_token")
                if not token:
                    return None, f"no asus_token in response"
                return token, None
            except ValueError:
                return None, f"invalid JSON response: {body[:100]}"
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def _asus_get(host, hook, token, timeout=6):
    """Query ASUS router API with an authenticated token.

    Returns (body, error).
    """
    import urllib.error, urllib.request

    url = f"http://{host}/appGet.cgi?hook={hook}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "asusrouter-Android-DUTUtil-1.0.0.201",
            "Cookie": f"asus_token={token}",
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def _asus_set(host, token, nvram, timeout=6):
    """Write NVRAM key/value pairs to an ASUS router via the app-API's
    applyapp.cgi, reusing the asus_token cookie _asus_login already
    proved works for reads.

    ASUS ships no public write-API spec; the POST /applyapp.cgi target,
    the asus_token cookie, and the semicolon-joined `key=value` payload
    (URL-quoted, mirroring how _asus_get's own GET-style hook query is
    built) follow the shape used by community-reverse-engineered clients
    (e.g. the AsusRouter and aioasuswrt Python libraries). UNVERIFIED
    against a live device from this codebase -- see OPEN-ISSUES.md. A
    200 response means only "the router accepted the request", never
    "the value changed": callers must always confirm with a fresh read
    via router()/modem() before reporting success.

    Returns (body, error).
    """
    import urllib.error, urllib.request
    from urllib.parse import quote

    payload = ";".join(f"{k}={v}" for k, v in nvram.items())
    url = f"http://{host}/applyapp.cgi"
    req = urllib.request.Request(
        url,
        method="POST",
        data=quote(payload).encode(),
        headers={
            "User-Agent": "asusrouter-Android-DUTUtil-1.0.0.201",
            "Cookie": f"asus_token={token}",
            "Content-Type": "application/x-www-form-urlencoded",
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


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

    The channel tables are not present as HTML text at all — the firmware
    assigns a pipe-delimited string to a JS variable per table, which the
    page's own script splits and renders client-side. This walks the same
    five Init*TagValue() functions the page itself calls, so it survives
    cosmetic HTML changes as long as the JS data functions keep their names.
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


def modem(host=None, user=None, password=None):
    """DOCSIS line quality. Uncorrectable codewords are the single best
    indicator that the physical cable plant is the problem."""
    host = host or os.environ.get("MODEM_HOST", "192.168.100.1")
    user = user if user is not None else os.environ.get("MODEM_USER")
    password = password if password is not None else os.environ.get("MODEM_PASS")
    if not user:
        return _unavailable("no credentials: set MODEM_USER / MODEM_PASS in .env")

    body, err = _http_get(f"http://{host}/DocsisStatusAdv.htm", user, password)
    if err:
        return {"state": "fail", "reason": err}
    return parse_docsis_status(body)


def router(host=None, user=None, password=None):
    """ASUS routers ship DPI (AiProtection / Trend Micro) that is well known
    for reaping long-lived TLS streams — exactly this symptom."""
    host = host or os.environ.get("ROUTER_HOST", "192.168.50.1")
    user = user if user is not None else os.environ.get("ROUTER_USER")
    password = password if password is not None else os.environ.get("ROUTER_PASS")
    if not user:
        return _unavailable("no credentials: set ROUTER_USER / ROUTER_PASS in .env")

    token, err = _asus_login(host, user, password)
    if err:
        return {"state": "fail", "reason": err}

    body, err = _asus_get(host, "nvram_get(wrs_protect_enable)", token)
    if err:
        return {"state": "fail", "reason": err}

    # Parse nvram response: "nvram_get(key)=value" format, sometimes with multiple lines
    aiprotection_enabled = False
    for line in body.split("\n"):
        if "wrs_protect_enable" in line and "=" in line:
            value = line.split("=", 1)[1].strip()
            aiprotection_enabled = value == "1"
            break

    return {"state": "ok", "aiprotection_enabled": aiprotection_enabled}


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
