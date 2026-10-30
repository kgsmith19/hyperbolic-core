"""CLI timing bounds for the continuous watcher."""
import contextlib
import io
import unittest

from network_checker import __main__ as cli


class WatchArgumentTest(unittest.TestCase):
    def assert_rejected(self, *args):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                cli.main(["watch", *args])

    def test_interval_must_be_positive(self):
        self.assert_rejected("--interval", "0")
        self.assert_rejected("--interval", "-1")

    def test_idle_cadence_and_duration_must_be_positive(self):
        self.assert_rejected("--idle-every", "0")
        self.assert_rejected("--idle-seconds", "-1")


if __name__ == "__main__":
    unittest.main()
