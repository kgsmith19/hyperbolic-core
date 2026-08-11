"""Reach a host over IPv4 and over IPv6, separately.

Split from probes.py because it answers a question none of the other probes
can: every one of those uses whichever family the resolver hands back, which
is the behaviour being isolated here.
"""
import socket
import time


def _connect(info, timeout):
    """Connect one resolved address. Returns None on success, else the error.

    The socket is opened on the family getaddrinfo reported, and `sockaddr`
    is passed through whole -- IPv6's is a 4-tuple carrying flowinfo and a
    scope id, not (host, port).
    """
    fam, socktype, proto, _canonname, sockaddr = info
    sock = socket.socket(fam, socktype, proto)
    sock.settimeout(timeout)
    try:
        sock.connect(sockaddr)
        return None
    except OSError as e:
        return e
    finally:
        sock.close()


def _family_probe(host, family, port, timeout):
    """Connect to `host` over one address family and time it.

    A real TCP connect, not a ping: the system `ping` binary takes no
    address-family flag we can rely on across platforms. And deliberately not
    socket.create_connection, which re-resolves the name internally and can
    come back on the *other* family -- quietly measuring the thing this is
    trying to isolate.

    Two different "we could not measure" cases, neither of them `fail`:
    the target has no address in this family (its DNS, not our stack), or
    this host has no stack for the family at all (IPv6 switched off is not
    IPv6 broken).
    """
    label = "IPv6" if family == socket.AF_INET6 else "IPv4"
    try:
        infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
    except socket.gaierror:
        infos = []
    if not infos:
        return {"state": "unavailable", "ms": None,
                "reason": f"{host} has no {label} address"}

    # Every address, not just the first: one dead server in a rotation is not
    # a broken address family, and calling it one sends the user off to
    # reconfigure a stack that works.
    t0 = time.perf_counter()
    last = None
    for info in infos:
        try:
            last = _connect(info, timeout)
        except OSError as e:
            return {"state": "unavailable", "ms": None,
                    "reason": f"no {label} stack on this host: {e.strerror or e}"}
        if last is None:
            return {"state": "ok", "ms": round((time.perf_counter() - t0) * 1000, 1)}
    return {"state": "fail", "ms": None, "reason": f"{type(last).__name__}: {last}"}


def dual_stack(host, port=443, timeout=4):
    """Reach the target over IPv4 and over IPv6, separately.

    Happy Eyeballs races the two and returns whichever answers first, so a
    wholly broken family shows up only as occasional extra latency on a
    connection that still succeeds. That is indistinguishable from "the
    network is a bit slow today" unless something measures each family on
    its own, which is what this does.
    """
    return {"state": "ok",
            "ipv4": _family_probe(host, socket.AF_INET, port, timeout),
            "ipv6": _family_probe(host, socket.AF_INET6, port, timeout)}
