"""Parsers are pure functions over captured command output.

Fixtures are real output captured from a live machine — so a Windows format
change breaks a test rather than silently producing null metrics — with SSID,
BSSID, MAC and GUID replaced by placeholders. A BSSID is enough to locate a
house through Wi-Fi geolocation databases, so it does not belong in a repo.
"""
import unittest
import unittest.mock

from netcheck import probes

from tests import fixture


class ParsePingTest(unittest.TestCase):
    def test_windows_reply(self):
        """Criterion 1: Windows ping output yields loss and rtt."""
        got = probes.parse_ping(fixture("ping_win.txt"))
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["loss_pct"], 0.0)
        self.assertEqual(got["rtt_avg_ms"], 14.0)
        self.assertEqual(got["rtt_min_ms"], 12.0)
        self.assertEqual(got["rtt_max_ms"], 16.0)

    def test_unix_reply(self):
        """Criterion 1: the same function handles BSD/Linux output."""
        got = probes.parse_ping(
            "2 packets transmitted, 2 packets received, 0.0% packet loss\n"
            "round-trip min/avg/max/stddev = 13.5/14.0/14.7/0.4 ms\n")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["loss_pct"], 0.0)
        self.assertEqual(got["rtt_avg_ms"], 14.0)

    def test_partial_loss_is_still_ok_with_loss_recorded(self):
        """Degraded is not down. Loss is the signal; 'ok' means we measured."""
        got = probes.parse_ping(
            "4 packets transmitted, 3 packets received, 25.0% packet loss\n"
            "round-trip min/avg/max/stddev = 10.0/20.0/30.0/1.0 ms\n")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["loss_pct"], 25.0)

    def test_total_loss_is_fail(self):
        got = probes.parse_ping(
            "4 packets transmitted, 0 packets received, 100.0% packet loss\n")
        self.assertEqual(got["state"], "fail")
        self.assertEqual(got["loss_pct"], 100.0)

    def test_unreachable_is_fail_not_a_silent_zero(self):
        """Unparseable output must never read as a healthy 0ms."""
        got = probes.parse_ping("Destination host unreachable.")
        self.assertEqual(got["state"], "fail")
        self.assertIsNone(got["rtt_avg_ms"])


class _PlainCtx:
    """Stands in for an SSLContext, handing back the raw socket.

    The hold/detect loop is ours and is where bugs live; TLS wrapping is
    stdlib's. Testing through a real handshake would mean shipping a private
    key in the repo to prove something OpenSSL already guarantees.
    """
    @staticmethod
    def wrap_socket(sock, server_hostname=None):
        return sock


class IdleHoldTest(unittest.TestCase):
    """Criterion 12: distinguish a connection that was reaped from one that held."""

    def _server(self, close_immediately):
        import socket as s, threading
        srv = s.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)

        held = []

        def serve():
            conn, _ = srv.accept()
            if close_immediately:
                conn.close()
            else:
                held.append(conn)           # keep the peer alive for the test
        threading.Thread(target=serve, daemon=True).start()
        self.addCleanup(lambda: [c.close() for c in held])
        self.addCleanup(srv.close)
        return srv.getsockname()

    def test_peer_closing_is_reported_as_closed_by_peer(self):
        host, port = self._server(close_immediately=True)
        got = probes.idle_hold(host, port, seconds=0.5, ctx=_PlainCtx)
        self.assertEqual(got["result"], "closed_by_peer")
        self.assertEqual(got["state"], "fail")

    def test_surviving_the_window_is_reported_as_still_alive(self):
        host, port = self._server(close_immediately=False)
        got = probes.idle_hold(host, port, seconds=0.5, ctx=_PlainCtx)
        self.assertEqual(got["result"], "still_alive")
        self.assertEqual(got["state"], "ok")

    def test_unreachable_port_is_connect_error_not_a_false_drop(self):
        """Failing to connect is not the same finding as being disconnected."""
        got = probes.idle_hold("127.0.0.1", 1, seconds=0.5, ctx=_PlainCtx)
        self.assertEqual(got["result"], "connect_error")


class TlsConnectCtxTest(unittest.TestCase):
    """tls_connect's ctx parameter (added alongside idle_hold's identical
    one) lets a test hand in a stand-in context instead of a real verifying
    SSLContext, so the handshake path is exercised against a local stub
    server without shipping a private key in the repo."""

    def _server(self):
        import socket as s, threading
        srv = s.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)

        def serve():
            conn, _ = srv.accept()
            conn.close()
        threading.Thread(target=serve, daemon=True).start()
        self.addCleanup(srv.close)
        return srv.getsockname()

    def test_custom_ctx_is_used_instead_of_a_real_default_context(self):
        """A ctx whose wrap_socket hands back an object with a fake
        .cipher() (real SSL sockets have one; a bare passthrough like
        _PlainCtx wouldn't, since regular sockets have no such method) --
        proves tls_connect calls the given ctx rather than building its
        own real one."""
        from unittest.mock import MagicMock
        host, port = self._server()
        fake_wrapped = MagicMock()
        fake_wrapped.cipher.return_value = ("FAKE-CIPHER", "TLSv1.3", 128)
        fake_wrapped.__enter__.return_value = fake_wrapped
        fake_ctx = MagicMock()
        fake_ctx.wrap_socket.return_value = fake_wrapped

        result = probes.tls_connect(host, port, timeout=2, ctx=fake_ctx)

        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["cipher"], "FAKE-CIPHER")
        fake_ctx.wrap_socket.assert_called_once()

    def test_default_ctx_is_a_real_verifying_sslcontext(self):
        """No ctx passed -- must fail closed against a plaintext peer,
        proving the default is real TLS verification, not accidentally
        bypassed."""
        host, port = self._server()
        result = probes.tls_connect(host, port, timeout=2)

        self.assertEqual(result["state"], "fail")


if __name__ == "__main__":
    unittest.main()
