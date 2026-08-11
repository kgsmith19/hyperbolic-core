"""Name resolution, including a minimal DNS/UDP client.

Split from probes.py for the same reason docsis.py and wlan_probes.py were:
it is a self-contained protocol implementation that its caller does not need
to know the inside of. The wire-format client exists because querying a
*specific* resolver -- which is the whole point of comparing the router
against a public one -- is not something socket.getaddrinfo can do, and
dnspython is not an option under this project's no-dependency constraint.
"""
import os
import socket
import time


def resolve(host, server=None, attempts=2, backoff_s=0.3):
    """Resolve `host`, optionally against a specific DNS server.

    The server-specific path is what separates 'the router's DNS is broken'
    from 'DNS is broken', which is the single most useful split on this network
    because the router is the configured resolver.

    Retries once on failure before reporting it: a single dropped UDP query
    is common and is not, by itself, evidence the resolver is broken.
    """
    result = None
    for attempt in range(attempts):
        result = _resolve_once(host, server)
        if result["state"] == "ok":
            return result
        if attempt + 1 < attempts:
            time.sleep(backoff_s)
    return result


def _resolve_once(host, server):
    # perf_counter, not monotonic: this measures a single query that often
    # completes in 1-3 ms. Before Python 3.11, monotonic() on Windows was
    # GetTickCount64 with ~15.6 ms resolution, so both reads landed in the
    # same tick and every router-DNS timing came back as exactly 0.0 ms.
    t0 = time.perf_counter()
    try:
        if server:
            addrs = _resolve_via(host, server)
        else:
            addrs = sorted({i[4][0] for i in socket.getaddrinfo(host, 443)})
        if not addrs:
            return {"state": "fail", "ms": None, "reason": "no answer"}
        return {"state": "ok", "ms": round((time.perf_counter() - t0) * 1000, 1),
                "addrs": addrs}
    except Exception as e:
        return {"state": "fail", "ms": None, "reason": f"{type(e).__name__}: {e}"}


def _skip_name(data, i):
    """Advance past the DNS name at `i`: either a two-byte compression pointer
    or a chain of length-prefixed labels ending in a zero byte."""
    if data[i] & 0xC0 == 0xC0:
        return i + 2
    while data[i]:
        i += data[i] + 1
    return i + 1


def _resolve_via(host, server, timeout=4):
    """Minimal DNS/UDP A-record query. Avoids a dnspython dependency."""
    qname = b"".join(bytes([len(p)]) + p.encode() for p in host.split(".")) + b"\0"
    # A fresh id per query, checked on the way back. `watch` asks the same
    # server the same question every tick, so with a fixed id a late reply to
    # the previous tick would satisfy this one -- clearing the very resolver
    # this tool exists to indict.
    txid = os.urandom(2)
    query = txid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + qname + b"\x00\x01\x00\x01"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        s.sendto(query, (server, 53))
        data, _ = s.recvfrom(2048)

    if data[:2] != txid:
        raise ValueError("reply id does not match the query")
    if not data[2] & 0x80:                            # QR bit: 1 = response
        raise ValueError("packet is not a DNS response")

    return _a_records(data, start=len(query))          # answers follow the question


def _a_records(data, start):
    """Every A record in the answer section, as dotted-quad strings.

    Records of other types are skipped by their own length rather than
    guessed at, so a CNAME ahead of the A record does not derail the walk.
    """
    addrs, i = [], start
    for _ in range(int.from_bytes(data[6:8], "big")):  # ANCOUNT
        i = _skip_name(data, i)
        rtype = int.from_bytes(data[i:i + 2], "big")
        length = int.from_bytes(data[i + 8:i + 10], "big")
        if rtype == 1 and length == 4:
            addrs.append(".".join(str(b) for b in data[i + 10:i + 14]))
        i += 10 + length
    return sorted(addrs)
