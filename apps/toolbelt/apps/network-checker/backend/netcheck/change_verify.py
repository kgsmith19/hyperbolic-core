"""Bounded, single-property verification for approved changes."""
import time

from . import environ, probes
from . import route as route_mod

FIELDS = {"gw", "hop", "inet", "dns_router", "dns_public", "tls", "http"}


def valid(expr):
    """Whether `expr` is a supported field and three-state expectation."""
    field, sep, want = (expr or "").partition(":")
    return bool(sep and field in FIELDS and want in ("ok", "fail", "unavailable"))


def _measure(field, timeout):
    deadline = time.monotonic() + timeout

    def remaining(cap=timeout):
        return max(0.01, min(cap, deadline - time.monotonic()))

    if field in ("gw", "hop", "dns_router"):
        gw = route_mod.gateway(timeout=remaining(15))
        if not gw:
            return "unavailable"
    if field == "gw":
        return probes.ping(gw, count=1, timeout=remaining())["state"]
    if field == "hop":
        return "ok" if route_mod.first_hop(
            gateway_ip=gw, timeout=remaining()) else "fail"
    if field == "inet":
        return probes.ping(probes.PUBLIC_DNS, count=1, timeout=remaining())["state"]
    if field in ("dns_router", "dns_public"):
        server = gw if field == "dns_router" else probes.PUBLIC_DNS
        return probes.resolver.resolve(environ.TARGET, server=server, attempts=1,
                                       timeout=remaining())["state"]
    if field == "tls":
        return probes.tls_connect(environ.TARGET, timeout=remaining())["state"]
    return probes.http_check(environ.TARGET, timeout=remaining())["state"]


def run(expr, timeout=30):
    """Return whether a validated `field:state` expression matches."""
    field, _sep, want = (expr or "").partition(":")
    if not valid(expr):
        return False, {"field": field, "want": want, "got": "invalid"}
    started = time.monotonic()
    got = _measure(field, max(0.01, timeout))
    if time.monotonic() - started > timeout:
        got = "timeout"
    return got == want, {"field": field, "want": want, "got": got}


def retry(expr, attempts=3, budget_s=90):
    """Retry within one monotonic deadline, including each probe's runtime."""
    deadline, log = time.monotonic() + budget_s, []
    for attempt in range(1, attempts + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        slot = max(0.01, remaining / (attempts - attempt + 1))
        ok, detail = run(expr, timeout=slot)
        log.append({"attempt": attempt, "ok": ok, **detail})
        if ok:
            return True, log
    return False, log
