"""TTL cache: caches a callable's return value for a bounded time window."""
import unittest
from unittest.mock import patch
from netcheck import cache


class TTLCacheTest(unittest.TestCase):
    def test_caches_return_value_within_ttl(self):
        calls = []

        @cache.ttl_cache(seconds=30)
        def fetch():
            calls.append(1)
            return "value"

        with patch("netcheck.cache.time.monotonic", return_value=100.0):
            self.assertEqual(fetch(), "value")
            self.assertEqual(fetch(), "value")
            self.assertEqual(fetch(), "value")

        self.assertEqual(len(calls), 1)

    def test_recomputes_after_ttl_expires(self):
        calls = []

        @cache.ttl_cache(seconds=30)
        def fetch():
            calls.append(1)
            return len(calls)

        with patch("netcheck.cache.time.monotonic", return_value=100.0):
            fetch()
        with patch("netcheck.cache.time.monotonic", return_value=100.0 + 30.001):
            fetch()

        self.assertEqual(len(calls), 2)

    def test_cache_clear_forces_recompute(self):
        calls = []

        @cache.ttl_cache(seconds=30)
        def fetch():
            calls.append(1)
            return "value"

        with patch("netcheck.cache.time.monotonic", return_value=100.0):
            fetch()
            fetch.cache_clear()
            fetch()

        self.assertEqual(len(calls), 2)

    def test_different_args_cached_separately(self):
        calls = []

        @cache.ttl_cache(seconds=30)
        def fetch(host):
            calls.append(host)
            return host.upper()

        with patch("netcheck.cache.time.monotonic", return_value=100.0):
            self.assertEqual(fetch("a"), "A")
            self.assertEqual(fetch("b"), "B")
            self.assertEqual(fetch("a"), "A")

        self.assertEqual(calls, ["a", "b"])

    def test_none_return_value_is_cached_too(self):
        """A failed lookup (None) should not be retried on every call within the TTL."""
        calls = []

        @cache.ttl_cache(seconds=30)
        def fetch():
            calls.append(1)
            return None

        with patch("netcheck.cache.time.monotonic", return_value=100.0):
            fetch()
            fetch()

        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
