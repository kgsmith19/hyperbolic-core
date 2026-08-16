"""Read-only LAN exposure checks for mapped devices (FR-019).

For each mapped LAN device, this checks:
- open well-known management ports
- whether one fixed default-credential list entry is accepted by HTTP Basic

The check is bounded and detection-only:
- fixed credential list (<=20 entries)
- GET requests only (no writes)
- never runs against hosts that fail remote._on_lan()
"""
import base64
import socket
import urllib.request

from . import remote, topology

_MANAGEMENT_PORTS = (23, 80, 443, 8080, 7547)
_HTTP_PORTS = (80, 8080)
_LOGIN_PATHS = ("/", "/login", "/login.asp", "/index.asp", "/cgi-bin/luci")
_DEFAULT_CREDENTIALS = (
    {"id": "DC01", "user": "admin", "password": "admin"},
    {"id": "DC02", "user": "admin", "password": "password"},
    {"id": "DC03", "user": "admin", "password": ""},
    {"id": "DC04", "user": "root", "password": "admin"},
    {"id": "DC05", "user": "root", "password": ""},
    {"id": "DC06", "user": "user", "password": "user"},
    {"id": "DC07", "user": "ubnt", "password": "ubnt"},
    {"id": "DC08", "user": "support", "password": "support"},
)


def _check_open_ports(host, ports=_MANAGEMENT_PORTS, timeout=1.0):
    open_ports = []
    for port in ports:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                open_ports.append(port)
        except OSError:
            pass
    return open_ports


def _find_login_endpoint(hostport, timeout=2):
    for path in _LOGIN_PATHS:
        req = urllib.request.Request(f"http://{hostport}{path}",
                                     headers={"User-Agent": "network-checker"})
        _body, err = remote._fetch(req, timeout)
        if err in ("HTTP 401", "HTTP 403") or err is None:
            return path
    return None


def _credential_match(hostport, path, timeout=2):
    for entry in _DEFAULT_CREDENTIALS:
        req = urllib.request.Request(f"http://{hostport}{path}",
                                     headers={"User-Agent": "network-checker"})
        token = base64.b64encode(
            f"{entry['user']}:{entry['password']}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
        _body, err = remote._fetch(req, timeout)
        if err is None or err in ("HTTP 301", "HTTP 302", "HTTP 303",
                                  "HTTP 307", "HTTP 308"):
            return entry["id"]
    return None


def _device_exposure(device):
    host = device.get("ip") or ""
    if not remote._on_lan(host):
        return remote._unavailable(
            f"host {host!r} failed _on_lan(); no exposure checks were attempted")

    open_ports = _check_open_ports(host)
    http_hostports = [host] if 80 in open_ports else []
    if 8080 in open_ports:
        http_hostports.append(f"{host}:8080")

    endpoint = None
    matched = None
    hostport = None
    for candidate in http_hostports:
        endpoint = _find_login_endpoint(candidate)
        if endpoint:
            hostport = candidate
            matched = _credential_match(candidate, endpoint)
            break

    findings = []
    for port in open_ports:
        findings.append({"kind": "open_port", "port": port})
    if matched:
        findings.append({"kind": "default_credential",
                         "entry": matched,
                         "endpoint": f"http://{hostport}{endpoint}"})

    return {"state": "ok", "open_ports": open_ports, "findings": findings,
            "credential_entry": matched, "login_endpoint": endpoint}


def scan(mapped=None):
    """Exposure checks for all mapped devices, or unavailable when topology is."""
    mapped = mapped if mapped is not None else topology.map_devices()
    if not isinstance(mapped, dict) or mapped.get("state") != "ok":
        reason = (mapped or {}).get("reason", "topology unavailable")
        return remote._unavailable(reason)

    devices = []
    all_findings = []
    for device in mapped.get("devices") or []:
        result = _device_exposure(device)
        row = {"ip": device.get("ip"), "mac": device.get("mac"),
               "name": device.get("name"), **result}
        devices.append(row)
        for finding in result.get("findings") or []:
            all_findings.append({"ip": row["ip"], "name": row["name"], **finding})
    return {"state": "ok", "devices": devices, "findings": all_findings}
