"""Phase 23 (revised): end-to-end acceptance tests with real tc netem fault
injection.

Every hypothesis test here does the same three steps for real: inject a
fault via `tc netem` on the loopback interface, take a real measurement
through this project's own probe functions, and assert the measurement
reflects the injected fault. Earlier versions of this file injected the
fault and then asserted `assertTrue(True, "...")` with the real assertion
left as a comment ("# In a real test, we'd measure...") -- decorative,
not verifying anything.

Every test degrades gracefully (skipTest) when `tc`/`sudo`/`sch_netem`
aren't available, rather than failing -- this sandbox, for instance, has
`tc` installed but no `sch_netem` kernel module, so `tc qdisc show` alone
is not a reliable capability signal (it succeeds either way); the real
check tries to add and remove a netem rule.
"""
import re
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import List

from netcheck import diagnose, environ, probes


def run_tc(args: List[str]) -> bool:
    """Run tc command. Returns True if successful."""
    try:
        cmd = ["sudo", "tc"] + args
        result = subprocess.run(cmd, capture_output=True, timeout=5)
        return result.returncode == 0
    except Exception:
        return False


def cleanup_tc():
    """Clean up all tc rules on lo interface."""
    try:
        subprocess.run(["sudo", "tc", "qdisc", "del", "dev", "lo", "root"],
                       capture_output=True, timeout=5)
    except Exception:
        pass


def netem_available():
    """True only if a netem qdisc can actually be added and removed -- not
    just that `tc` itself is queryable. `tc qdisc show` succeeds even when
    the sch_netem kernel module isn't loaded (e.g. in a restricted
    container), which previously made later tests fail for real instead of
    skip: `tc qdisc show` returned 0, but `tc qdisc add ... netem` then
    failed with "Specified qdisc kind is unknown"."""
    cleanup_tc()
    added = run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "1ms"])
    cleanup_tc()
    return added


class FaultInjectionSetupTest(unittest.TestCase):
    """Verify fault injection infrastructure works."""

    def setUp(self):
        cleanup_tc()

    def tearDown(self):
        cleanup_tc()

    def test_can_inject_latency(self):
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")
        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "100ms"]))

    def test_can_inject_packet_loss(self):
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")
        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "loss", "5%"]))

    def test_can_inject_jitter(self):
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")
        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "10ms", "5ms"]))

    def test_can_cleanup_tc_rules(self):
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")
        run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "10ms"])
        cleanup_tc()
        result = subprocess.run(["sudo", "tc", "qdisc", "show", "dev", "lo"],
                                capture_output=True, timeout=5)
        self.assertNotIn("netem", result.stdout.decode())


class E2ELatencyDetectionTest(unittest.TestCase):
    """Hypothesis #1 (latency variance) and #2 (jitter): a real 50ms netem
    delay on loopback must show up in a real ping to loopback, and must
    classify as elevated rather than healthy."""

    def setUp(self):
        cleanup_tc()
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")

    def tearDown(self):
        cleanup_tc()

    def test_injected_latency_is_measured_and_classified(self):
        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "50ms"]))

        result = probes.ping("127.0.0.1", count=4)
        self.assertEqual(result["state"], "ok")
        # netem delays each direction, so a round trip over loopback (which
        # traverses `lo` twice, out and back) picks up roughly double the
        # configured one-way delay; a loose floor avoids false failures from
        # scheduling jitter in a shared CI runner.
        self.assertGreater(result["rtt_avg_ms"], 40,
                          "50ms injected delay should be visible in a real ping")

        classification = diagnose.classify_latency([{"latency_ms": result["rtt_avg_ms"]}])
        self.assertNotEqual(classification["category"], "stable_low",
                           "50ms+ should not classify as the healthy baseline")


class E2EPacketLossDetectionTest(unittest.TestCase):
    """Hypothesis #3: a real netem loss rule on loopback must show up as
    real measured loss in probes.parse_ping's output."""

    def setUp(self):
        cleanup_tc()
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")

    def tearDown(self):
        cleanup_tc()

    def test_injected_loss_is_measured(self):
        # 30% loss and a fast interval: enough pings, in little wall-clock
        # time, that a >0 measured loss is not a coin flip (P(zero losses
        # in 60 tries at a true 30% rate) is under 1 in 10^9).
        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "loss", "30%"]))

        proc = subprocess.run(["ping", "-c", "60", "-i", "0.02", "127.0.0.1"],
                              capture_output=True, text=True, timeout=15)
        result = probes.parse_ping(proc.stdout)
        self.assertIsNotNone(result["loss_pct"])
        self.assertGreater(result["loss_pct"], 0,
                          "30% injected loss should be visible in a real ping run")


class E2EConnectionRespawnTest(unittest.TestCase):
    """Hypothesis #11: a server that closes an idle connection must be
    detected by probes.idle_hold as closed_by_peer, not misread as a
    healthy hold or a connect failure. (test_probes.py::IdleHoldTest covers
    this at the unit level with a mocked context; this is the same
    behaviour end to end, over a real socket.)"""

    def test_server_closing_after_a_delay_is_detected(self):
        # idle_hold polls every 2s (its own fixed granularity, not scaled to
        # `seconds`), so the close is only ever observed on the next tick --
        # closing well before that first tick and giving several ticks of
        # ceiling headroom avoids the detection colliding with the ceiling.
        closes_after_s = 0.3
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]

        def serve_and_close():
            conn, _ = server.accept()
            time.sleep(closes_after_s)
            conn.close()

        thread = threading.Thread(target=serve_and_close, daemon=True)
        thread.start()
        try:
            result = probes.idle_hold("127.0.0.1", port=port, seconds=8,
                                      ctx=_PlainTcpContext())
        finally:
            server.close()
            thread.join(timeout=2)

        self.assertEqual(result["result"], "closed_by_peer")
        self.assertLess(result["held_s"], 8,
                       "should detect the close well before the ceiling, not time out")


class _PlainTcpContext:
    """Stands in for an SSLContext: hands back the raw socket unmodified.
    idle_hold's own hold/detect loop is what this test verifies; TLS
    wrapping is stdlib's problem, not this project's."""

    def wrap_socket(self, sock, server_hostname=None):
        return sock


class E2EDNSResolutionTest(unittest.TestCase):
    """Hypothesis #7: router-DNS-style resolution against a specific server
    must reflect real injected latency. Uses a hand-rolled stub DNS
    responder on 127.0.0.1:53 (mirroring probes._resolve_via's minimal
    query/response format) since there's no real resolver to point at on
    loopback -- the same "stand-in server" pattern test_store.py's
    MirrorTest and test_probes.py's IdleHoldTest already use elsewhere in
    this suite.
    """

    def setUp(self):
        cleanup_tc()
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")

    def tearDown(self):
        cleanup_tc()

    def _serve_one_dns_reply(self, ip="127.0.0.1"):
        """Bind :53/udp, answer exactly one query with `ip`, then stop.
        Skips the test (not a failure) if the port can't be bound --
        already in use by the machine's real resolver, or no permission."""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("127.0.0.1", 53))
        except OSError as e:
            self.skipTest(f"can't bind 127.0.0.1:53 for the stub resolver: {e}")
            return None

        def respond():
            sock.settimeout(5)
            try:
                query, addr = sock.recvfrom(512)
            except socket.timeout:
                return
            # ANCOUNT (bytes 6-7) 0 -> 1; the answer section is a compressed
            # name pointer back to the question (byte offset 12), then
            # TYPE=A, CLASS=IN, a TTL, RDLENGTH=4, and the IP itself --
            # exactly what probes._resolve_via's own parser expects to find
            # starting right after the (unchanged-length) question section.
            header = query[:6] + b"\x00\x01" + query[8:12]
            answer = (b"\xc0\x0c" + struct.pack("!HHI", 1, 1, 60)
                      + struct.pack("!H", 4) + socket.inet_aton(ip))
            sock.sendto(header + query[12:] + answer, addr)
            sock.close()

        thread = threading.Thread(target=respond, daemon=True)
        thread.start()
        return thread

    def test_injected_latency_is_measured_in_resolve(self):
        thread = self._serve_one_dns_reply()
        if thread is None:
            return  # skipTest already called inside _serve_one_dns_reply

        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "80ms"]))
        try:
            result = probes.resolve("example.test", server="127.0.0.1")
        finally:
            thread.join(timeout=5)

        self.assertEqual(result["state"], "ok")
        self.assertGreater(result["ms"], 60,
                          "80ms injected delay should be visible in a real DNS round trip")


class E2ETlsHandshakeLatencyTest(unittest.TestCase):
    """Hypothesis #9 (TLS handshake overhead): a real netem delay must show
    up in a real TLS handshake's timing. Uses a real local TLS server with
    a certificate generated fresh via the `openssl` CLI (skips gracefully
    if unavailable) rather than shipping a private key in the repo;
    probes.tls_connect's `ctx` parameter (added alongside idle_hold's
    identical one, see test_probes.py::TlsConnectCtxTest) lets the client
    trust that self-signed certificate explicitly instead of failing
    closed the way it must against a real unknown certificate."""

    def setUp(self):
        cleanup_tc()
        if not netem_available():
            self.skipTest("netem not available (tc present, but sch_netem is not)")
        if shutil.which("openssl") is None:
            self.skipTest("openssl CLI not available to generate a test certificate")

        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.key_path = Path(self.tmpdir.name) / "key.pem"
        self.cert_path = Path(self.tmpdir.name) / "cert.pem"
        result = subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(self.key_path), "-out", str(self.cert_path),
            "-days", "1", "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1",
        ], capture_output=True, timeout=20)
        if result.returncode != 0:
            self.skipTest(f"openssl cert generation failed: {result.stderr.decode()[:200]}")

    def tearDown(self):
        cleanup_tc()

    def _serve_tls(self):
        server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ctx.load_cert_chain(str(self.cert_path), str(self.key_path))
        raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        raw.bind(("127.0.0.1", 0))
        raw.listen(1)
        port = raw.getsockname()[1]

        def accept_one():
            try:
                conn, _ = raw.accept()
                with server_ctx.wrap_socket(conn, server_side=True) as tls_conn:
                    tls_conn.recv(1)
            except Exception:
                pass  # client side already got what it needs from the handshake

        thread = threading.Thread(target=accept_one, daemon=True)
        thread.start()
        self.addCleanup(raw.close)
        self.addCleanup(lambda: thread.join(timeout=5))
        return port

    def test_injected_latency_is_measured_in_a_real_tls_handshake(self):
        port = self._serve_tls()
        self.assertTrue(run_tc(["qdisc", "add", "dev", "lo", "root", "netem", "delay", "60ms"]))

        client_ctx = ssl.create_default_context(cafile=str(self.cert_path))
        client_ctx.check_hostname = False

        result = probes.tls_connect("127.0.0.1", port, timeout=10, ctx=client_ctx)

        self.assertEqual(result["state"], "ok")
        self.assertGreater(result["ms"], 40,
                          "60ms injected delay should be visible in a real TLS handshake "
                          "(TCP connect + TLS handshake both cross the delayed link)")


def _lo_mtu():
    try:
        result = subprocess.run(["ip", "link", "show", "lo"], capture_output=True, text=True)
    except FileNotFoundError:
        return None
    m = re.search(r"\bmtu (\d+)", result.stdout)
    return int(m.group(1)) if m else None


def _set_lo_mtu(mtu):
    try:
        result = subprocess.run(["sudo", "ip", "link", "set", "dev", "lo", "mtu", str(mtu)],
                                capture_output=True)
    except FileNotFoundError:
        return False
    return result.returncode == 0


class E2EMtuPmtudTest(unittest.TestCase):
    """Hypothesis #4 (MTU/PMTUD): environ.mtu()'s descending DF-bit ping
    walk must actually find a real, reduced path MTU rather than only
    being asserted about in the abstract. `tc netem` has no MTU-clamping
    option, so this uses a different real fault: shrinking loopback's own
    interface MTU (`ip link set dev lo mtu N`), which makes a DF-set ping
    larger than N fail with a genuine "message too long" the same way a
    real path with a smaller-MTU hop would."""

    def setUp(self):
        self.original_mtu = _lo_mtu()
        if not _set_lo_mtu(1000):
            self.skipTest("cannot set lo's MTU in this sandbox (needs CAP_NET_ADMIN)")

    def tearDown(self):
        if self.original_mtu is not None:
            _set_lo_mtu(self.original_mtu)

    def test_default_size_list_correctly_reports_unavailable_under_a_1000_byte_mtu(self):
        """None of environ.mtu()'s default candidate sizes (1200-1472) fit
        under a 1000-byte path -- it must say so, not report a false `ok`
        for some other size that happens to work."""
        result = environ.mtu("127.0.0.1")
        self.assertEqual(result["state"], "unavailable")

    def test_a_size_list_straddling_the_real_limit_finds_it(self):
        """Sizes chosen to bracket the real 1000-byte MTU: 1172(+28=1200,
        too big) then 872(+28=900, fits) -- environ.mtu() must pick 900,
        not fail outright or pick the wrong candidate."""
        result = environ.mtu("127.0.0.1", sizes=(1172, 872, 472))

        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["mtu"], 900)

    def test_a_size_that_no_longer_fits_is_skipped_for_the_next_one(self):
        """Confirms the walk actually degrades: the too-large candidate
        must fail for real (not just happen to be first in a lucky list)."""
        too_big = probes.parse_ping(subprocess.run(
            ["ping", "-c", "1", "-M", "do", "-s", "1172", "127.0.0.1"],
            capture_output=True, text=True, timeout=8).stdout)
        self.assertEqual(too_big["state"], "fail",
                         "a DF-set ping bigger than the real 1000-byte MTU must fail")


if __name__ == "__main__":
    unittest.main()
