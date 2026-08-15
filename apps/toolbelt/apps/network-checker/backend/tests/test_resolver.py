"""Name resolution, and the retry that keeps one lost UDP packet from
reading as a broken resolver.

The router-vs-public comparison is the highest-value rule in the whole tool,
so a false `fail` on either side is the expensive mistake here.
"""
import struct
import unittest
from unittest.mock import patch

from netcheck import resolver


class ResolveRetryTest(unittest.TestCase):
    """A single dropped UDP query to a resolver is common and is not itself
    evidence the resolver is broken -- resolve() retries once before giving
    up. time.sleep is patched so the retry backoff costs nothing in tests."""

    def test_succeeds_first_try_without_retrying(self):
        with patch("netcheck.resolver._resolve_via", return_value=["1.2.3.4"]) as mock_via, \
             patch("netcheck.resolver.time.sleep") as mock_sleep:
            result = resolver.resolve("api.anthropic.com", server="192.168.1.1")

        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["addrs"], ["1.2.3.4"])
        mock_via.assert_called_once()
        mock_sleep.assert_not_called()

    def test_retries_once_after_a_transient_failure_then_succeeds(self):
        with patch("netcheck.resolver._resolve_via",
                   side_effect=[TimeoutError("timed out"), ["1.2.3.4"]]) as mock_via, \
             patch("netcheck.resolver.time.sleep") as mock_sleep:
            result = resolver.resolve("api.anthropic.com", server="192.168.1.1")

        self.assertEqual(result["state"], "ok")
        self.assertEqual(mock_via.call_count, 2)
        mock_sleep.assert_called_once()

    def test_gives_up_and_reports_fail_after_exhausting_retries(self):
        with patch("netcheck.resolver._resolve_via",
                   side_effect=TimeoutError("timed out")) as mock_via, \
             patch("netcheck.resolver.time.sleep"):
            result = resolver.resolve("api.anthropic.com", server="192.168.1.1")

        self.assertEqual(result["state"], "fail")
        self.assertIn("TimeoutError", result["reason"])
        self.assertEqual(mock_via.call_count, 2)  # default attempts, not unbounded


class TimingTest(unittest.TestCase):
    """A sub-millisecond-but-real answer must not report as 0.0 ms.

    `dns_router_ms` read exactly 0.0 on every tick (issue #28). The cause is
    the clock, not the network: before Python 3.11, time.monotonic() on
    Windows was GetTickCount64 with ~15.6 ms resolution, so a real 2 ms query
    started and finished inside one tick and measured as zero. perf_counter()
    is the documented clock for short durations and uses the high-resolution
    counter on every version -- which is why this asserts on the reported
    number rather than on which function is called.
    """

    def timed(self, elapsed_s):
        """Resolve with a stub clock that advances by exactly `elapsed_s`."""
        ticks = iter([1000.0, 1000.0 + elapsed_s])
        with patch.object(resolver, "_resolve_via", return_value=["1.2.3.4"]), \
             patch.object(resolver.time, "perf_counter", lambda: next(ticks)):
            return resolver.resolve("example.test", server="192.0.2.1")

    def test_a_two_millisecond_answer_reports_two_milliseconds(self):
        self.assertEqual(self.timed(0.002)["ms"], 2.0)

    def test_a_sub_millisecond_answer_is_not_reported_as_zero(self):
        """The shape of the bug: a real, fast answer must stay distinguishable
        from 'no time passed at all'."""
        self.assertEqual(self.timed(0.0004)["ms"], 0.4)

    def test_a_slow_answer_survives_the_retry_path(self):
        self.assertEqual(self.timed(0.253)["ms"], 253.0)


class QueryIdentityTest(unittest.TestCase):
    """A reply must be matched to the query that asked for it.

    The query id was the constant 0x1234 and the reply's id was never
    checked, so any UDP packet arriving on the ephemeral port was parsed as
    the answer -- including a late reply to the *previous* tick's query, which
    on this schedule is the same question to the same server every 20 seconds.
    A stale or spoofed reply reading as "the router resolved it fine" is the
    exact wrong answer: it clears the resolver this tool exists to indict.
    """

    def reply_for(self, query, txid=None, qr=True):
        """A minimal A-record reply, optionally with the wrong id."""
        ident = query[:2] if txid is None else txid
        flags = b"\x81\x80" if qr else b"\x01\x00"
        answer = (b"\xc0\x0c" + struct.pack("!HHI", 1, 1, 60)
                  + struct.pack("!H", 4) + bytes([93, 184, 216, 34]))
        return ident + flags + query[4:6] + b"\x00\x01" + query[8:12] \
            + query[12:] + answer

    def resolve_with(self, make_reply):
        sent = {}

        class FakeUDP:
            def __enter__(inner): return inner
            def __exit__(inner, *a): return False
            def settimeout(inner, _t): pass
            def sendto(inner, payload, _addr): sent["query"] = payload
            def recvfrom(inner, _n): return make_reply(sent["query"]), ("192.0.2.1", 53)

        with patch.object(resolver.socket, "socket", lambda *a, **k: FakeUDP()):
            return resolver._resolve_via("example.test", "192.0.2.1"), sent["query"]

    def test_a_matching_reply_is_accepted(self):
        addrs, _ = self.resolve_with(self.reply_for)
        self.assertEqual(addrs, ["93.184.216.34"])

    def test_a_reply_with_the_wrong_id_is_rejected(self):
        """A late answer to an earlier query must not satisfy this one."""
        with self.assertRaises(ValueError):
            self.resolve_with(lambda q: self.reply_for(q, txid=b"\xff\xff"))

    def test_a_packet_that_is_not_a_response_is_rejected(self):
        with self.assertRaises(ValueError):
            self.resolve_with(lambda q: self.reply_for(q, qr=False))

    def test_the_query_id_is_not_a_fixed_constant(self):
        """Two queries in a row must not be interchangeable."""
        ids = {self.resolve_with(self.reply_for)[1][:2] for _ in range(12)}
        self.assertGreater(len(ids), 1, "query id is constant across queries")


if __name__ == "__main__":
    unittest.main()
