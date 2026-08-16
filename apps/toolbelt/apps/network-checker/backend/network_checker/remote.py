"""Everything network-checker reaches over the network rather than by asking this host.

Split from environ.py because the two halves fail differently and are tested
differently: a section in there goes `unavailable` when a binary or a platform
is missing, while a section here goes `fail` when a device or service does not
answer. Keeping "no `netsh` on Linux" and "the modem refused our password"
in one module made that distinction easy to blur, and the distinction is the
whole three-state contract.
"""
import base64
import ipaddress
import json
import os
import socket
import urllib.error
import urllib.request

from . import docsis, geoip

MODEM_HOST_DEFAULT = "192.168.100.1"
ROUTER_HOST_DEFAULT = "192.168.50.1"

_ASUS_UA = "asusrouter-Android-DUTUtil-1.0.0.201"
_RFC1918 = tuple(ipaddress.ip_network(n)
                 for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_CGNAT = ipaddress.ip_network("100.64.0.0/10")   # RFC 6598 carrier NAT
_DEGRADED = ("degraded_performance", "partial_outage", "major_outage")


def _unavailable(reason):
    return {"state": "unavailable", "reason": reason}


def _fetch(req, timeout=6):
    """Send a prepared request; return (body, error), exactly one not None.

    Every device and service query in this module goes through here, so a
    broken query is reported the same way everywhere instead of each caller
    inventing its own error string — and there is one place to look when
    one of them starts lying about why it failed.
    """
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def _http_get(url, user=None, password=None, timeout=6):
    req = urllib.request.Request(url, headers={"User-Agent": "network-checker"})
    if user:
        token = base64.b64encode(f"{user}:{password or ''}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    return _fetch(req, timeout)


def _asus_login(host, user, password, timeout=6):
    """Authenticate to an ASUS router via the POST /login.cgi token flow.

    Returns (token, error).
    """
    login_auth = base64.b64encode(f"{user}:{password or ''}".encode()).decode()
    body, err = _fetch(urllib.request.Request(
        f"http://{host}/login.cgi", method="POST", data=b"",
        headers={"User-Agent": _ASUS_UA, "login_authorization": login_auth}), timeout)
    if err:
        return None, err
    try:
        token = json.loads(body).get("asus_token")
    except ValueError:
        return None, f"invalid JSON response: {body[:100]}"
    return (token, None) if token else (None, "no asus_token in response")


def _asus_get(host, hook, token, timeout=6):
    """Query the ASUS router API with an authenticated token. (body, error)."""
    return _fetch(urllib.request.Request(
        f"http://{host}/appGet.cgi?hook={hook}",
        headers={"User-Agent": _ASUS_UA, "Cookie": f"asus_token={token}"}), timeout)


def _on_lan(host):
    """True only if every address `host` resolves to is off the public
    internet.

    Credentials reach these devices as HTTP Basic and as a plaintext login
    header over `http://`, because that is all a modem or consumer router
    speaks. Accepted on a LAN; never acceptable off one, and a single wrong
    digit in `.env` is enough to make the difference.

    `ipaddress.is_private` is the right predicate *here* -- the question is
    "could this leave my network", and it covers loopback and link-local too.
    classify_wan() above deliberately avoids it for the opposite reason: there
    the question is "is something NATing me", and counting loopback would
    answer it wrongly.
    """
    name = host.rsplit(":", 1)[0].strip("[]") if host else ""
    try:
        infos = socket.getaddrinfo(name, None)
    except OSError:
        return False
    return bool(infos) and all(
        ipaddress.ip_address(i[4][0]).is_private for i in infos)


def _off_lan(host, which, credentials=True):
    """Shared `_on_lan` guard message. `credentials=False` is for callers
    (snmp.py, ssdp.py) that never send any -- the `.env` hint would be
    misleading for a query that has no credential to withhold."""
    if not credentials:
        return _unavailable(f"{which} host {host!r} is not on a local network")
    return _unavailable(
        f"{which} host {host!r} is not on a local network, so no credentials "
        f"were sent; check {which.upper()}_HOST in .env")


def modem(host=None, user=None, password=None):
    """DOCSIS line quality. Uncorrectable codewords are the single best
    indicator that the physical cable plant is the problem."""
    host = host or os.environ.get("MODEM_HOST", MODEM_HOST_DEFAULT)
    user = user if user is not None else os.environ.get("MODEM_USER")
    password = password if password is not None else os.environ.get("MODEM_PASS")
    if not user:
        return _unavailable("no credentials: set MODEM_USER / MODEM_PASS in .env")
    if not _on_lan(host):
        return _off_lan(host, "modem")

    body, err = _http_get(f"http://{host}/DocsisStatusAdv.htm", user, password)
    if err:
        return {"state": "fail", "reason": err}
    return docsis.parse_docsis_status(body)


def router(host=None, user=None, password=None):
    """ASUS routers ship DPI (AiProtection / Trend Micro) that is well known
    for reaping long-lived TLS streams — exactly this symptom."""
    host = host or os.environ.get("ROUTER_HOST", ROUTER_HOST_DEFAULT)
    user = user if user is not None else os.environ.get("ROUTER_USER")
    password = password if password is not None else os.environ.get("ROUTER_PASS")
    if not user:
        return _unavailable("no credentials: set ROUTER_USER / ROUTER_PASS in .env")
    if not _on_lan(host):
        return _off_lan(host, "router")

    token, err = _asus_login(host, user, password)
    if err:
        return {"state": "fail", "reason": err}

    body, err = _asus_get(host, "nvram_get(wrs_protect_enable)", token)
    if err:
        return {"state": "fail", "reason": err}
    return {"state": "ok",
            "aiprotection_enabled": _nvram(body, "wrs_protect_enable") == "1"}


def _nvram(body, key):
    """The value of one key in an appGet.cgi reply, or None.

    The reply is `nvram_get(key)=value`, sometimes several lines of it, so the
    key is matched rather than the first line taken.
    """
    for line in body.split("\n"):
        if key in line and "=" in line:
            return line.split("=", 1)[1].strip()
    return None


def classify_wan(ip):
    """What a WAN address says about the NAT in front of us.

    Deliberately not `ipaddress.is_private`, which also counts loopback,
    link-local, and (before 3.11) the carrier block — an address inside
    RFC 6598 reading as "private" would send the user into their own modem
    to fix their ISP's network.
    """
    try:
        addr = ipaddress.ip_address(ip)
    except (TypeError, ValueError):
        return _unavailable(f"not an IP address: {ip!r}")
    return {"state": "ok", "ip": ip,
            "double_nat": any(addr in net for net in _RFC1918),
            "cgnat": addr in _CGNAT}


def _json_get(url):
    """GET a JSON document, or say which of the two ways it went wrong.

    Returns (data, section). Exactly one is not None: a caller either gets
    the document or gets a section to return as-is, so no caller has to
    invent a state of its own.
    """
    body, err = _http_get(url)
    if err:
        return None, {"state": "fail", "reason": err}
    try:
        return json.loads(body), None
    except ValueError:
        return None, _unavailable(f"unparseable response from {url}")


def wan(url="https://api.ipify.org?format=json", include_geo=True):
    """The address the internet sees us as — the only way to tell a bridged
    modem from one that quietly reverted to routing, and either from CGNAT.

    A coarse geolocation (FR-020) rides along under "geo" once we have an
    address, but never as a condition of this section's own state: a lookup
    that fails degrades only the "geo" sub-key, per geoip.locate()'s
    contract, so wan()'s own state/ip/double_nat/cgnat are unaffected either
    way. `include_geo=False` skips it entirely -- FR-018's standard tier.
    """
    data, section = _json_get(url)
    if section:
        return section
    result = classify_wan(data.get("ip"))
    if include_geo and result["state"] == "ok":
        result["geo"] = geoip.locate(result["ip"])
    return result


def anthropic(url="https://status.anthropic.com/api/v2/status.json"):
    """Whether the far side has declared an incident.

    Without this, every provider outage ranks as a local fault and the user
    rebuilds a network that was never broken. Note the asymmetry: a declared
    outage is evidence, but failing to reach the status page is not evidence
    of health — that failure is equally consistent with the outage.
    """
    data, section = _json_get(url)
    if section:
        return section
    status = data.get("status") or {}
    indicator = status.get("indicator")
    return {"state": "ok", "indicator": indicator,
            "description": status.get("description"),
            "degraded": indicator in _DEGRADED}
