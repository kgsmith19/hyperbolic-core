"""Dashboard bind address: loopback unless the container image asks otherwise (#504)."""

import os
import unittest
from unittest import mock

from network_checker import server, store


class BindAddressTest(unittest.TestCase):
    def test_binds_loopback_by_default(self):
        """The dashboard must never listen beyond loopback unless asked to."""
        env = {k: v for k, v in os.environ.items() if k != "NETWORK_CHECKER_HOST"}
        with mock.patch.dict(os.environ, env, clear=True):
            httpd = server.serve(store.open_db(":memory:"), port=0)
        self.addCleanup(httpd.server_close)
        self.assertEqual(httpd.server_address[0], "127.0.0.1")

    def test_container_host_override(self):
        """The image sets NETWORK_CHECKER_HOST so its published port reaches the server."""
        with mock.patch.dict(os.environ, {"NETWORK_CHECKER_HOST": "0.0.0.0"}):
            httpd = server.serve(store.open_db(":memory:"), port=0)
        self.addCleanup(httpd.server_close)
        self.assertEqual(httpd.server_address[0], "0.0.0.0")


if __name__ == "__main__":
    unittest.main()
