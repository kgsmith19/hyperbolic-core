"""IPv4 and IPv6, measured separately."""
import socket
import unittest
import unittest.mock
from unittest.mock import patch

from netcheck import dualstack


class DualStackTest(unittest.TestCase):
    """IPv4 and IPv6 measured separately.

    Happy Eyeballs hides a broken family behind the working one: the
    connection still succeeds, just slower and non-deterministically. That
    reads as "it works, but sometimes it stalls" -- this project's whole
    symptom, and no single-connection probe can see it.

    Mocked at socket.socket, not socket.create_connection, because the code
    deliberately does not use create_connection: it re-resolves the name and
    can return the other family. Mocking the wrong boundary here is how the
    IPv6 4-tuple sockaddr bug got past a green unit test once already.
    """

    V6_SOCKADDR = ("2606:4700::1111", 443, 0, 0)     # flowinfo + scope id
    V4_SOCKADDR = ("1.1.1.1", 443)

    def probe(self, v4, v6, port=443):
        """Run dual_stack() with each family's outcome forced. `connected`
        records the sockaddr each attempted connect actually received."""
        self.connected = []

        def getaddrinfo(*args, **_kwargs):
            _host, _port, family, socktype = args[:4]
            outcome = v4 if family == socket.AF_INET else v6
            if outcome == "no-address":
                raise socket.gaierror("Name or service not known")
            sockaddr = self.V4_SOCKADDR if family == socket.AF_INET else self.V6_SOCKADDR
            return [(family, socktype, 6, "", sockaddr)]

        test = self

        class FakeSocket:
            def __init__(self, family, socktype, proto):
                self.family = family
            def settimeout(self, _t): pass
            def close(self): self.closed = True
            def connect(self, sockaddr):
                test.connected.append((self.family, sockaddr))
                outcome = v4 if self.family == socket.AF_INET else v6
                if outcome == "refused":
                    raise ConnectionRefusedError("Connection refused")

        with patch.object(dualstack.socket, "getaddrinfo", getaddrinfo), \
             patch.object(dualstack.socket, "socket", FakeSocket):
            return dualstack.dual_stack("example.test", port=port)

    def test_both_families_reachable_is_ok(self):
        got = self.probe(v4="ok", v6="ok")
        self.assertEqual(got["ipv4"]["state"], "ok")
        self.assertEqual(got["ipv6"]["state"], "ok")

    def test_each_family_is_connected_on_a_socket_of_that_family(self):
        """The isolation this probe exists for: an IPv6 result must come from
        a connect on an AF_INET6 socket, not from a resolver's preference."""
        self.probe(v4="ok", v6="ok")
        families = dict((fam, addr) for fam, addr in self.connected)
        self.assertIn(socket.AF_INET, families)
        self.assertIn(socket.AF_INET6, families)

    def test_the_ipv6_sockaddr_is_passed_through_whole(self):
        """IPv6's sockaddr is a 4-tuple carrying flowinfo and scope id.
        Truncating it to (host, port) is what socket.create_connection forces,
        and it raised ValueError against a real target."""
        self.probe(v4="ok", v6="ok")
        v6_addr = next(a for f, a in self.connected if f == socket.AF_INET6)
        self.assertEqual(v6_addr, self.V6_SOCKADDR)
        self.assertEqual(len(v6_addr), 4)

    def test_a_family_that_refuses_the_connection_is_a_measured_failure(self):
        got = self.probe(v4="ok", v6="refused")
        self.assertEqual(got["ipv4"]["state"], "ok")
        self.assertEqual(got["ipv6"]["state"], "fail")
        self.assertIn("refused", got["ipv6"]["reason"].lower())

    def test_a_target_with_no_address_for_a_family_is_unavailable_not_broken(self):
        """The bug worth not shipping: a host with no AAAA record is not
        evidence that this machine's IPv6 is broken. It means the target has
        no IPv6, which we measured nothing about."""
        got = self.probe(v4="ok", v6="no-address")
        self.assertEqual(got["ipv6"]["state"], "unavailable")
        self.assertIn("no IPv6 address", got["ipv6"]["reason"])

    def test_a_host_with_no_stack_for_the_family_is_unavailable_not_broken(self):
        """A machine with IPv6 switched off does not have broken IPv6.
        socket() raises EAFNOSUPPORT before any connect is attempted, so
        nothing about reachability was measured."""
        def getaddrinfo(*args, **_kwargs):
            _host, _port, family, socktype = args[:4]
            sockaddr = self.V4_SOCKADDR if family == socket.AF_INET else self.V6_SOCKADDR
            return [(family, socktype, 6, "", sockaddr)]

        def no_v6_socket(family, socktype, proto):
            if family == socket.AF_INET6:
                raise OSError(97, "Address family not supported by protocol")
            return unittest.mock.MagicMock()

        with patch.object(dualstack.socket, "getaddrinfo", getaddrinfo), \
             patch.object(dualstack.socket, "socket", no_v6_socket):
            got = dualstack.dual_stack("example.test")
        self.assertEqual(got["ipv6"]["state"], "unavailable")
        self.assertIn("no IPv6 stack on this host", got["ipv6"]["reason"])
        self.assertEqual(got["ipv4"]["state"], "ok")

    def test_a_reachable_family_reports_its_connect_latency(self):
        got = self.probe(v4="ok", v6="ok")
        self.assertIsInstance(got["ipv4"]["ms"], float)
        self.assertGreaterEqual(got["ipv4"]["ms"], 0)

    def test_an_unreachable_family_reports_no_latency(self):
        self.assertIsNone(self.probe(v4="refused", v6="ok")["ipv4"]["ms"])


if __name__ == "__main__":
    unittest.main()
