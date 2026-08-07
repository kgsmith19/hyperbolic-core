"""Network probes.

Split deliberately in two: pure parsers over command output (tested against
captured fixtures) and the IO that produces that output. Nothing here shells
out during a test.

Every probe returns a dict carrying `state`:
  ok           - measured successfully
  fail         - measured, and it is broken
  unavailable  - could not measure (no binary, no permission, no interface)
Conflating the last two would make an ethernet-only machine look like it had a
dead Wi-Fi card.
"""
import re
import socket
import ssl
import subprocess
import time

WINDOWS = __import__("platform").system() == "Windows"
MACOS = __import__("platform").system() == "Darwin"


# --------------------------------------------------------------------------
# pure parsers
# --------------------------------------------------------------------------

def parse_ping(text):
    """Loss and round-trip times from Windows or BSD/Linux ping output."""
    out = {"state": "fail", "loss_pct": None,
           "rtt_min_ms": None, "rtt_avg_ms": None, "rtt_max_ms": None}

    loss = re.search(r"([\d.]+)%\s*(?:packet\s*)?loss", text)
    if loss:
        out["loss_pct"] = float(loss.group(1))

    win = re.search(r"Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms", text)
    unix = re.search(r"=\s*([\d.]+)/([\d.]+)/([\d.]+)/[\d.]+\s*ms", text)
    if win:
        out["rtt_min_ms"] = float(win.group(1))
        out["rtt_max_ms"] = float(win.group(2))
        out["rtt_avg_ms"] = float(win.group(3))
    elif unix:
        out["rtt_min_ms"] = float(unix.group(1))
        out["rtt_avg_ms"] = float(unix.group(2))
        out["rtt_max_ms"] = float(unix.group(3))

    # Degraded is not down: partial loss still counts as a successful
    # measurement, and the loss figure is the thing worth charting.
    if out["rtt_avg_ms"] is not None and out["loss_pct"] != 100.0:
        out["state"] = "ok"
    return out


# Wi-Fi link-state and neighbour-congestion parsers live in wlan_probes.py --
# a self-contained ~110 lines with no shared state with the probes below.

# --------------------------------------------------------------------------
# IO
# --------------------------------------------------------------------------

def _run(cmd, timeout=15):
    """Run a command, returning (text, state). Never raises."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout + p.stderr, "ok"
    except FileNotFoundError:
        return "", "unavailable"
    except subprocess.TimeoutExpired:
        return "", "fail"


def ping(host, count=2):
    flag = "-n" if WINDOWS else "-c"
    text, state = _run(["ping", flag, str(count), host], timeout=count * 4 + 8)
    if state != "ok":
        reason = "ping binary not found" if state == "unavailable" else "timed out"
        return {"state": state, "reason": reason, "loss_pct": None,
                "rtt_avg_ms": None, "host": host}
    return dict(parse_ping(text), host=host)


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
    t0 = time.monotonic()
    try:
        if server:
            addrs = _resolve_via(host, server)
        else:
            addrs = sorted({i[4][0] for i in socket.getaddrinfo(host, 443)})
        if not addrs:
            return {"state": "fail", "ms": None, "reason": "no answer"}
        return {"state": "ok", "ms": round((time.monotonic() - t0) * 1000, 1),
                "addrs": addrs}
    except Exception as e:
        return {"state": "fail", "ms": None, "reason": f"{type(e).__name__}: {e}"}


def _resolve_via(host, server, timeout=4):
    """Minimal DNS/UDP A-record query. Avoids a dnspython dependency."""
    qname = b"".join(bytes([len(p)]) + p.encode() for p in host.split(".")) + b"\0"
    query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + qname + b"\x00\x01\x00\x01"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        s.sendto(query, (server, 53))
        data, _ = s.recvfrom(2048)

    count = int.from_bytes(data[6:8], "big")          # ANCOUNT
    addrs, i = [], len(query)                          # answers follow the question
    for _ in range(count):
        if data[i] & 0xC0 == 0xC0:                     # compressed name pointer
            i += 2
        else:
            while data[i]:
                i += data[i] + 1
            i += 1
        rtype = int.from_bytes(data[i:i + 2], "big")
        length = int.from_bytes(data[i + 8:i + 10], "big")
        body = data[i + 10:i + 10 + length]
        if rtype == 1 and length == 4:
            addrs.append(".".join(str(b) for b in body))
        i += 10 + length
    return sorted(addrs)


def tls_connect(host, port=443, timeout=8, ctx=None):
    """Real TLS handshake, timed. `ctx` defaults to a real verifying
    SSLContext; overridable the same way idle_hold's own `ctx` parameter
    is, so a test can hand in a context that trusts a local stub server's
    self-signed certificate instead of a real CA-signed one."""
    t0 = time.monotonic()
    try:
        ctx = ctx or ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as raw:
            t_tcp = time.monotonic()
            with ctx.wrap_socket(raw, server_hostname=host) as sock:
                cipher = sock.cipher()
        return {"state": "ok",
                "tcp_ms": round((t_tcp - t0) * 1000, 1),
                "ms": round((time.monotonic() - t0) * 1000, 1),
                "cipher": cipher[0] if cipher else None}
    except Exception as e:
        return {"state": "fail", "ms": None,
                "reason": f"{type(e).__name__}: {e}"}


def http_check(host, path="/v1/models", timeout=10):
    """One real HTTPS request. A 401 proves the whole path works end to end —
    we are testing reachability, not credentials."""
    import urllib.error, urllib.request
    t0 = time.monotonic()
    req = urllib.request.Request(f"https://{host}{path}", method="GET",
                                 headers={"User-Agent": "netcheck"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code                                  # reached the server
    except Exception as e:
        return {"state": "fail", "ms": None, "code": None,
                "reason": f"{type(e).__name__}: {e}"}
    return {"state": "ok", "ms": round((time.monotonic() - t0) * 1000, 1),
            "code": code}


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


def idle_hold(host, port=443, seconds=90, ctx=None):
    """Hold a real TLS connection open and see whether anything kills it.

    This is the probe that reproduces the actual symptom: a long streaming
    response dying mid-flight. No ping-based check can observe it, because the
    path is fine — something is reaping the *connection*.
    """
    import select
    t0 = time.monotonic()
    sock = None
    try:
        raw = socket.create_connection((host, port), timeout=10)
        sock = (ctx or ssl.create_default_context()).wrap_socket(
            raw, server_hostname=host)
        sock.setblocking(False)
        while time.monotonic() - t0 < seconds:
            time.sleep(min(2, seconds - (time.monotonic() - t0)))
            if select.select([sock], [], [], 0)[0]:
                try:
                    if sock.recv(1) == b"":
                        return _held("closed_by_peer", t0)
                except ssl.SSLWantReadError:
                    pass
                except OSError as e:
                    return dict(_held("dropped", t0), reason=str(e))
        return _held("still_alive", t0)
    except Exception as e:
        return dict(_held("connect_error", t0), reason=f"{type(e).__name__}: {e}")
    finally:
        if sock:
            try:
                sock.close()
            except OSError:
                pass


def _held(result, t0):
    return {"state": "ok" if result == "still_alive" else "fail",
            "result": result, "held_s": round(time.monotonic() - t0, 1)}


def sample(target="api.anthropic.com", gw=None, hop=None, public_dns="1.1.1.1",
           wifi=None):
    """One tick: every layer measured close together, flattened into one row.

    They must share a row because the diagnosis reads across them — a gateway
    failure and a TLS failure in the same instant mean something different from
    either alone. `wifi` is passed in rather than fetched here to keep this
    module free of any dependency on environ.
    """
    from datetime import datetime, timezone
    row = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    g = ping(gw, count=2) if gw else {"state": "unavailable"}
    row.update(gw_state=g["state"], gw_ms=g.get("rtt_avg_ms"), gw_loss=g.get("loss_pct"))

    h = ping(hop, count=2) if hop else {"state": "unavailable"}
    row.update(hop_state=h["state"], hop_ms=h.get("rtt_avg_ms"), hop_loss=h.get("loss_pct"))

    i = ping(public_dns, count=2)
    row.update(inet_state=i["state"], inet_ms=i.get("rtt_avg_ms"), inet_loss=i.get("loss_pct"))

    # The pair that isolates the router as a resolver from DNS in general.
    dr = resolve(target, server=gw) if gw else {"state": "unavailable"}
    row.update(dns_router_state=dr["state"], dns_router_ms=dr.get("ms"))
    dp = resolve(target, server=public_dns)
    row.update(dns_public_state=dp["state"], dns_public_ms=dp.get("ms"))

    t = tls_connect(target)
    row.update(tls_state=t["state"], tls_ms=t.get("ms"))
    hc = http_check(target)
    row.update(http_state=hc["state"], http_ms=hc.get("ms"), http_code=hc.get("code"))

    w = wifi or {}
    if w.get("state") == "ok":
        row.update(wifi_signal=w.get("rssi_dbm"), wifi_channel=w.get("channel"),
                   wifi_band=w.get("band"), wifi_rx_mbps=w.get("rx_mbps"),
                   wifi_tx_mbps=w.get("tx_mbps"), wifi_bssid=w.get("bssid"))
    return row
