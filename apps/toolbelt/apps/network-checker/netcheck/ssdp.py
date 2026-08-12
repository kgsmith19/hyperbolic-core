"""SSDP (UPnP) device discovery: the multicast query, the document it leads
to, and identify_gateway(), which composes both into the LAN gateway
manufacturer/model netcheck reports.

Split from remote.py for the same reason docsis.py is: a self-contained
protocol implementation its caller does not need to know the inside of, and
keeping it out of remote.py is what keeps that file under the length budget
as more device protocols (snmp.py) join it. identify_gateway() lives here
rather than in remote.py for the same reason -- it reaches into remote's
_on_lan()/_http_get()/_unavailable() the same way environ.py already reaches
into probes._run().
"""
import socket
import urllib.parse
import xml.etree.ElementTree as ET

from . import remote

MULTICAST_ADDR = ("239.255.255.250", 1900)
IGD_SEARCH_TARGET = "urn:schemas-upnp-org:device:InternetGatewayDevice:1"


def discover(timeout=2):
    """One SSDP M-SEARCH for an Internet Gateway Device; the first reply's
    text, or None. UDP multicast, so a device on the LAN answers without us
    knowing its address in advance.
    """
    request = (f"M-SEARCH * HTTP/1.1\r\nHOST: {MULTICAST_ADDR[0]}:{MULTICAST_ADDR[1]}\r\n"
              f'MAN: "ssdp:discover"\r\nMX: 2\r\nST: {IGD_SEARCH_TARGET}\r\n\r\n').encode()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(request, MULTICAST_ADDR)
            data, _ = s.recvfrom(4096)
        return data.decode("utf-8", "replace")
    except OSError:
        return None


def parse_response(text):
    """The LOCATION header of a raw SSDP response, or None."""
    for line in text.splitlines():
        key, _, value = line.partition(":")
        if key.strip().upper() == "LOCATION":
            return value.strip()
    return None


def parse_device_description(xml_text):
    """manufacturer/model from a UPnP device-description document, or None
    if the document is not parseable XML.

    Matched by local tag name rather than a hardcoded namespace URI: every
    UPnP IGD uses `urn:schemas-upnp-org:device-1-0`, but matching only the
    part that actually varies keeps this from breaking on a device that
    declares the namespace with different casing or a version suffix.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    fields = {}
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag in ("manufacturer", "modelName") and el.text:
            fields[tag] = el.text.strip()
    return {"manufacturer": fields.get("manufacturer"), "model": fields.get("modelName")}


def identify_gateway(timeout=2):
    """Best-effort LAN gateway manufacturer/model via SSDP (UPnP) discovery.

    Never assumes a vendor, unlike remote.modem()/remote.router(). The device
    description URL is attacker-controllable data returned by whatever
    answered the multicast -- guarded by the same _on_lan() check remote.py
    uses before sending credentials, since nothing stops a LAN device naming
    a LOCATION outside the LAN.

    The `ip` field on a successful result (the LOCATION host with any port
    stripped) is what topology.map_devices() cross-references against the
    address-resolution table to attach this name to the matching device.
    """
    response = discover(timeout)
    if response is None:
        return remote._unavailable(f"no SSDP response within {timeout}s")
    location = parse_response(response)
    if not location:
        return remote._unavailable("SSDP response had no LOCATION header")
    parsed = urllib.parse.urlparse(location)
    host = parsed.netloc
    if not remote._on_lan(host):
        return remote._off_lan(host, "device description", credentials=False)

    body, err = remote._http_get(location, timeout=timeout)
    if err:
        return {"state": "fail", "reason": err}
    device = parse_device_description(body)
    if device is None:
        return remote._unavailable("could not parse device description XML")
    return dict(device, state="ok", ip=parsed.hostname)
