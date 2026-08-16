"""SNMPv2c GET-only client: just enough BER/ASN.1 to read two scalar OIDs.

Hand-rolled because a real SNMP library is a third-party dependency this
project's stdlib-only constraint rules out (CON-001). Deliberately scoped to
GET against MIB-II scalars -- the DOCSIS-indexed tables (signal levels per
channel) are indexed and need GetNext/GetBulk to walk, a materially larger
protocol surface docsis.py's HTML scrape already covers for the vendors that
expose it. Split out for the same reason ssdp.py and docsis.py are: a
self-contained protocol implementation its caller does not need to know the
inside of. modem_snmp() lives here for the same reason ssdp.py holds
identify_gateway() -- it reaches into remote's _on_lan()/_unavailable() the
same way environ.py already reaches into probes._run().
"""
import os
import socket

from . import remote

SYS_DESCR = "1.3.6.1.2.1.1.1.0"
SYS_UPTIME = "1.3.6.1.2.1.1.3.0"

_SEQUENCE, _INTEGER, _OCTET_STRING, _NULL, _OID = 0x30, 0x02, 0x04, 0x05, 0x06
_GET_REQUEST, _GET_RESPONSE, _TIMETICKS = 0xA0, 0xA2, 0x43


def _length(n):
    """BER length octets: short form under 128, long form above it."""
    if n < 0x80:
        return bytes([n])
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _tlv(tag, payload):
    return bytes([tag]) + _length(len(payload)) + payload


def _integer(n):
    return _tlv(_INTEGER, n.to_bytes((n.bit_length() // 8) + 1, "big", signed=True))


def _oid(dotted):
    """An OID dotted string as BER content octets (no tag/length)."""
    parts = [int(p) for p in dotted.split(".")]
    out = [parts[0] * 40 + parts[1]]
    for p in parts[2:]:
        chunk = [p & 0x7F]
        p >>= 7
        while p:
            chunk.insert(0, (p & 0x7F) | 0x80)
            p >>= 7
        out.extend(chunk)
    return bytes(out)


def _get_request(oid, request_id, community=b"public"):
    varbind = _tlv(_SEQUENCE, _tlv(_OID, _oid(oid)) + _tlv(_NULL, b""))
    varbind_list = _tlv(_SEQUENCE, varbind)
    pdu = _tlv(_GET_REQUEST,
              _integer(request_id) + _integer(0) + _integer(0) + varbind_list)
    message = _integer(1) + _tlv(_OCTET_STRING, community) + pdu  # version: v2c
    return _tlv(_SEQUENCE, message)


def _read_tlv(data, i):
    """One tag-length-value at `i`. Returns (tag, value_bytes, next_index)."""
    tag = data[i]
    length = data[i + 1]
    i += 2
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(data[i:i + n], "big")
        i += n
    return tag, data[i:i + length], i + length


def parse_response(data, expected_request_id):
    """The value of the single varbind in an SNMPv2c GetResponse, or None if
    the packet is not a matching, error-free response to our own request.

    A UDP reply on the SNMP port is not guaranteed to be well-formed BER --
    it could be truncated, or come from something else entirely answering on
    161 -- and `_read_tlv` indexes straight into `data` with no bounds
    checking of its own, so a short or malformed packet is a plain
    IndexError, not a graceful mismatch. Caught here rather than in `get()`,
    so this function keeps its documented contract of degrading to None
    for *any* non-matching packet, not just well-formed ones.
    """
    try:
        _, message, _ = _read_tlv(data, 0)
        _, _version, i = _read_tlv(message, 0)
        _, _community, i = _read_tlv(message, i)
        tag, pdu, _ = _read_tlv(message, i)
        if tag != _GET_RESPONSE:
            return None
        _, request_id, j = _read_tlv(pdu, 0)
        _, error_status, j = _read_tlv(pdu, j)
        _, _error_index, j = _read_tlv(pdu, j)
        if int.from_bytes(request_id, "big") != expected_request_id or any(error_status):
            return None
        _, varbind_list, _ = _read_tlv(pdu, j)
        _, varbind, _ = _read_tlv(varbind_list, 0)
        _, _oid_bytes, k = _read_tlv(varbind, 0)
        value_tag, value_bytes, _ = _read_tlv(varbind, k)
    except (IndexError, ValueError):
        return None
    if value_tag == _OCTET_STRING:
        return value_bytes.decode("utf-8", "replace")
    if value_tag == _TIMETICKS:
        return int.from_bytes(value_bytes, "big")
    return None


def get(oid, host, timeout=2, request_id=1):
    """The value SNMPv2c GET returns for `oid` on `host`, or None if the
    agent did not answer within the timeout or the reply did not match."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(_get_request(oid, request_id), (host, 161))
            data, _ = s.recvfrom(2048)
    except OSError:
        return None
    return parse_response(data, request_id)


def modem_snmp(host=None, timeout=2):
    """Best-effort SNMPv2c read of generic MIB-II scalars from the modem.

    A supplement to remote.modem() (DOCSIS), never a replacement: most
    ISP-provisioned DOCSIS modems disable LAN-side SNMP by default, so
    `unavailable` here is the common case, not a sign of trouble.
    """
    host = host or os.environ.get("MODEM_HOST", remote.MODEM_HOST_DEFAULT)
    if not remote._on_lan(host):
        return remote._off_lan(host, "modem", credentials=False)

    descr = get(SYS_DESCR, host, timeout)
    if descr is None:
        return remote._unavailable(f"no SNMP response from {host} within {timeout}s")
    return {"state": "ok", "sys_descr": descr,
            "sys_uptime_ticks": get(SYS_UPTIME, host, timeout)}
