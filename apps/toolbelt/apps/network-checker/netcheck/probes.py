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

from . import resolver

WINDOWS = __import__("platform").system() == "Windows"
MACOS = __import__("platform").system() == "Darwin"

# The resolver every tick compares the router against. Fixed on purpose: the
# whole point of the pair is that one side is known-good and unchanging, so a
# difference between them is the router's fault and not a config difference.
PUBLIC_DNS = "1.1.1.1"


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


def tls_connect(host, port=443, timeout=8, ctx=None):
    """Real TLS handshake, timed. `ctx` defaults to a real verifying
    SSLContext; overridable the same way idle_hold's own `ctx` parameter
    is, so a test can hand in a context that trusts a local stub server's
    self-signed certificate instead of a real CA-signed one."""
    t0 = time.perf_counter()
    try:
        ctx = ctx or ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as raw:
            t_tcp = time.perf_counter()
            with ctx.wrap_socket(raw, server_hostname=host) as sock:
                cipher = sock.cipher()
        return {"state": "ok",
                "tcp_ms": round((t_tcp - t0) * 1000, 1),
                "ms": round((time.perf_counter() - t0) * 1000, 1),
                "cipher": cipher[0] if cipher else None}
    except Exception as e:
        return {"state": "fail", "ms": None,
                "reason": f"{type(e).__name__}: {e}"}


def http_check(host, path="/v1/models", timeout=10):
    """One real HTTPS request. A 401 proves the whole path works end to end —
    we are testing reachability, not credentials."""
    import urllib.error, urllib.request
    t0 = time.perf_counter()
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
    return {"state": "ok", "ms": round((time.perf_counter() - t0) * 1000, 1),
            "code": code}


def _peer_ended(sock, t0):
    """One look at a held connection: how it ended, or None if it is still up.

    A readable socket returning b"" is a clean close by the peer; an OSError
    is the connection being dropped underneath us. SSLWantReadError means TLS
    wants more bytes before it can say anything, which is not an ending.
    """
    import select
    if not select.select([sock], [], [], 0)[0]:
        return None
    try:
        return _held("closed_by_peer", t0) if sock.recv(1) == b"" else None
    except ssl.SSLWantReadError:
        return None
    except OSError as e:
        return dict(_held("dropped", t0), reason=str(e))


def idle_hold(host, port=443, seconds=90, ctx=None):
    """Hold a real TLS connection open and see whether anything kills it.

    This is the probe that reproduces the actual symptom: a long streaming
    response dying mid-flight. No ping-based check can observe it, because the
    path is fine — something is reaping the *connection*.
    """
    t0 = time.monotonic()
    sock = None
    try:
        raw = socket.create_connection((host, port), timeout=10)
        sock = (ctx or ssl.create_default_context()).wrap_socket(
            raw, server_hostname=host)
        sock.setblocking(False)
        while time.monotonic() - t0 < seconds:
            time.sleep(min(2, seconds - (time.monotonic() - t0)))
            ended = _peer_ended(sock, t0)
            if ended:
                return ended
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


def sample(target="api.anthropic.com", gw=None, hop=None, wifi=None):
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

    i = ping(PUBLIC_DNS, count=2)
    row.update(inet_state=i["state"], inet_ms=i.get("rtt_avg_ms"), inet_loss=i.get("loss_pct"))

    # The pair that isolates the router as a resolver from DNS in general.
    dr = resolver.resolve(target, server=gw) if gw else {"state": "unavailable"}
    row.update(dns_router_state=dr["state"], dns_router_ms=dr.get("ms"))
    dp = resolver.resolve(target, server=PUBLIC_DNS)
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
