"""Which path packets take out of this machine: the default gateway, and the
first hop past it that belongs to the ISP.

Separate from probes.py because it answers a different question. probes.py
asks "is this layer up right now"; this asks "what should we be pinging" --
which `watch` re-resolves every tick, since a machine that moves from Wi-Fi
to a hotspot keeps working while every cached address stops meaning anything.
"""
import re

from .probes import WINDOWS, _run


def parse_traceroute(text, gateway_ip=None, target=None):
    """First responding hop past the gateway.

    Deliberately *not* "first public address": ISPs commonly number their edge
    out of RFC1918 space, so filtering private addresses throws away the exact
    hop that distinguishes 'my ISP' from 'the internet'. The gateway is the only
    address we actually need to skip.
    """
    for line in text.splitlines():
        if re.search(r"timed out|\*\s+\*\s+\*", line):
            continue
        found = re.search(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", line)
        if not found:
            continue
        ip = found.group(1)
        if ip != gateway_ip and ip != target:
            return ip
    return None


def first_hop(host="1.1.1.1", gateway_ip=None, max_hops=5, timeout=40):
    """The first responding hop past the gateway: your ISP's edge."""
    cmd = (["tracert", "-d", "-h", str(max_hops), "-w", "1000", host] if WINDOWS
           else ["traceroute", "-n", "-m", str(max_hops), "-w", "1", host])
    text, state = _run(cmd, timeout=timeout)
    if state != "ok":
        return None
    return parse_traceroute(text, gateway_ip or gateway(), host)


def parse_ipconfig_gateway(text):
    """The IPv4 default gateway from Windows `ipconfig` output.

    A dual-stack adapter prints its IPv6 default gateway on the labeled line
    and its IPv4 one on an unlabeled continuation line right below it:

        Default Gateway . . . . . . . . . : fe80::1234:5678:90ab:cdef%16
                                            192.168.1.1

    A regex anchored to `\\s*([\\d.]+)` right after the colon never reaches
    that second line, since `\\s` cannot skip over the non-whitespace IPv6
    text sitting in between -- it just fails to match, silently, on any
    dual-stack adapter. There can also be more than one "Default Gateway"
    label (a VPN/Tailscale-style adapter often prints one with no value at
    all), so every occurrence is checked in order rather than only the
    first.
    """
    for block in re.finditer(r"Default Gateway[ .]*:(.*(?:\n[ \t]+\S.*)*)", text):
        m = re.search(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", block.group(1))
        if m:
            return m.group(1)
    return None


def gateway():
    if WINDOWS:
        text, _ = _run(["ipconfig"])
        return parse_ipconfig_gateway(text)
    text, _ = _run(["ip", "route"])
    m = re.search(r"default via ([\d.]+)", text)
    if not m:
        text, _ = _run(["route", "-n", "get", "default"])
        m = re.search(r"gateway:\s*([\d.]+)", text)
    return m.group(1) if m else None
