"""Name resolution, and the retry that keeps one lost UDP packet from
reading as a broken resolver.

The router-vs-public comparison is the highest-value rule in the whole tool,
so a false `fail` on either side is the expensive mistake here.
"""
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


if __name__ == "__main__":
    unittest.main()
