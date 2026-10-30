"""Local-network device map: address-resolution table (arp -a / ip neigh)
parsed into IP/MAC pairs, with the SSDP-identified gateway's name attached
to whichever mapped IP matches it.

The address-resolution table is the actual device enumeration for FR-017:
every device that has recently talked on the LAN already has a row in it,
with or without a name. SSDP is not a second enumeration pass -- it only
supplies a name for the one row (if any) matching ssdp.identify_gateway()'s
own discovered device, reached into the same way environ.py already reaches
into ssdp.identify_gateway() and snmp.modem_snmp().
"""
import ipaddress
import re

from . import probes, ssdp

WINDOWS = probes.WINDOWS
MACOS = probes.MACOS

_IP_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")
_MAC_RE = re.compile(r"\b([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})\b")
_BROADCAST_MAC = "ff:ff:ff:ff:ff:ff"


def _normalize_mac(mac):
    """Canonical MAC form: lowercase, colon-separated -- the convention
    this codebase already uses everywhere else a MAC/BSSID is compared or
    stored (wlan_probes.py's own `bssid.lower()`; this module's prior
    broadcast-address comparison, below, before Finding 63).

    Finding 63 (independent security review): applied at the point a row
    is BUILT, not only at the one place (the broadcast check) that used to
    normalize a copy for comparison and then discard it. Before this, the
    same physical device reported once as "AA-BB-CC-DD-EE-FF" (arp -a) and
    once as "aa:bb:cc:dd:ee:ff" (ip neigh, or a differently-cased arp
    dump) stored two different MAC strings -- and _upsert_device() matches
    strictly on (host_id, mac, ip), so that created two device rows for
    one physical device instead of upserting the same one."""
    return mac.replace("-", ":").lower()


def parse_neighbor_table(text):
    """IP/MAC pairs from arp -a (Windows/macOS) or ip neigh (Linux) output.

    One line, one device: a line with no IP address -- a header, a blank
    line, Windows' "Interface: ... --- 0x..." banner -- is not a device and
    is skipped. A line with an IP but no MAC -- Linux's FAILED rows with no
    lladdr, macOS's (incomplete) -- still becomes a device with mac=None,
    because FR-017 requires that a device that cannot be further identified
    is never dropped. Broadcast and multicast rows, which every real table
    also carries, are not devices and are dropped. A found MAC is stored in
    its canonical, normalized form (_normalize_mac, Finding 63), not
    verbatim off the wire.
    """
    devices = []
    for line in text.splitlines():
        if "---" in line:
            continue
        ip_match = _IP_RE.search(line)
        if not ip_match:
            continue
        ip = ip_match.group(1)
        if ipaddress.ip_address(ip).is_multicast:
            continue
        mac_match = _MAC_RE.search(line)
        mac = _normalize_mac(mac_match.group(1)) if mac_match else None
        if mac == _BROADCAST_MAC:
            continue
        devices.append({"ip": ip, "mac": mac})
    return devices


def _neighbor_table_command():
    """arp -a on Windows/macOS; ip neigh on Linux, where BSD-style arp is
    not guaranteed to exist."""
    return ["arp", "-a"] if (WINDOWS or MACOS) else ["ip", "neigh"]


def _run_neighbor_table():
    """The platform's address-resolution table text, or (None, reason)."""
    cmd = _neighbor_table_command()
    text, state = probes._run(cmd)
    if state != "ok":
        return None, f"{' '.join(cmd)} unavailable"
    return text, None


def _gateway_name(gateway):
    """A single display name from identify_gateway()'s manufacturer/model,
    or None if SSDP did not identify a device."""
    if gateway.get("state") != "ok":
        return None
    parts = [p for p in (gateway.get("manufacturer"), gateway.get("model")) if p]
    return " ".join(parts) or None


def map_devices():
    """Every device the address-resolution table lists right now, with the
    SSDP-identified gateway's name attached to whichever mapped IP matches
    it. SSDP is not a second device-enumeration pass -- the table already
    lists every device that has recently talked on the LAN; SSDP only
    supplies a name for the one entry (if any) it can identify (FR-017).
    """
    text, reason = _run_neighbor_table()
    if text is None:
        return {"state": "unavailable", "reason": reason}

    devices = parse_neighbor_table(text)
    gateway = ssdp.identify_gateway()
    name = _gateway_name(gateway)
    gateway_ip = gateway.get("ip")
    for device in devices:
        device["name"] = name if name and device["ip"] == gateway_ip else None
    return {"state": "ok", "devices": devices}
