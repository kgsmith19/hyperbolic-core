"""SNMPv2c GET: the hand-rolled BER encode/decode, and modem_snmp() which
composes it with remote.py's LAN-only guard.

parse_response() is tested against packets built by a test-only encoder below
rather than snmp.py's own _get_request() -- so a bug shared by both sides
cannot cancel itself out.

That independence stops at _oid(). This file used to carry a byte-identical
copy of it, which bought nothing: two identical implementations cannot
disagree, so the copy only made the encoder look covered while nothing
verified it at all. Instead, OidEncodingTest below pins snmp._oid against
encodings taken from the BER spec -- an external source of truth, which a
second copy of our own arithmetic never was -- and the packet builders then
use the real, now-verified function.
"""
import unittest
from unittest.mock import patch

from netcheck import snmp

_oid_bytes = snmp._oid


def _tlv(tag, payload):
    return bytes([tag, len(payload)]) + payload


def _response_packet(oid, value_tag, value_bytes, header=(1, 0)):
    """A hand-built SNMPv2c GetResponse carrying one varbind.
    `header` is (request_id, error_status)."""
    request_id, error_status = header
    varbind = _tlv(0x30, _tlv(0x06, _oid_bytes(oid)) + _tlv(value_tag, value_bytes))
    varbind_list = _tlv(0x30, varbind)
    pdu = _tlv(0xA2, _tlv(0x02, bytes([request_id])) + _tlv(0x02, bytes([error_status]))
                     + _tlv(0x02, b"\x00") + varbind_list)
    message = _tlv(0x02, b"\x01") + _tlv(0x04, b"public") + pdu
    return _tlv(0x30, message)


class OidEncodingTest(unittest.TestCase):
    """_oid against encodings from the BER spec, not from our own arithmetic.

    Every other test in this file builds packets rather than asserting on the
    encoder, so without these two vectors a wrong OID encoding would still
    round-trip and every test would pass.
    """

    def test_single_byte_subidentifiers(self):
        # sysDescr.0. First two arcs collapse to 1*40+3 = 0x2b; the rest are
        # each below 128, so each is one byte.
        self.assertEqual(
            snmp._oid("1.3.6.1.2.1.1.1.0"), bytes.fromhex("2b06010201010100")
        )

    def test_multi_byte_subidentifiers_use_7_bit_continuation(self):
        # 1.2.840.113549 (RSA's arc), whose well-known DER encoding is
        # 2a 86 48 86 f7 0d -- 840 and 113549 both exceed 127 and so exercise
        # the continuation-bit loop that the single-byte case never reaches.
        self.assertEqual(snmp._oid("1.2.840.113549"), bytes.fromhex("2a864886f70d"))


class ParseResponseTest(unittest.TestCase):
    def test_a_string_value_response_returns_the_string(self):
        packet = _response_packet(snmp.SYS_DESCR, 0x04, b"ASUS RT-AX88U")
        self.assertEqual(snmp.parse_response(packet, 1), "ASUS RT-AX88U")

    def test_a_timeticks_value_response_returns_an_integer(self):
        packet = _response_packet(snmp.SYS_UPTIME, 0x43, (123456).to_bytes(3, "big"))
        self.assertEqual(snmp.parse_response(packet, 1), 123456)

    def test_a_mismatched_request_id_is_rejected(self):
        """A late reply to a previous query must not satisfy this one --
        same shape as resolver.py's DNS transaction-id check."""
        packet = _response_packet(snmp.SYS_DESCR, 0x04, b"x", header=(9, 0))
        self.assertIsNone(snmp.parse_response(packet, 1))

    def test_an_error_status_response_is_rejected(self):
        packet = _response_packet(snmp.SYS_DESCR, 0x04, b"x", header=(1, 2))
        self.assertIsNone(snmp.parse_response(packet, 1))

    def test_a_request_pdu_is_not_accepted_as_a_response(self):
        varbind_list = _tlv(0x30, _tlv(0x30, _tlv(0x06, _oid_bytes(snmp.SYS_DESCR))
                                             + _tlv(0x05, b"")))
        pdu = _tlv(0xA0, _tlv(0x02, b"\x01") + _tlv(0x02, b"\x00")
                        + _tlv(0x02, b"\x00") + varbind_list)
        message = _tlv(0x02, b"\x01") + _tlv(0x04, b"public") + pdu
        self.assertIsNone(snmp.parse_response(_tlv(0x30, message), 1))


class GetTest(unittest.TestCase):
    """get() is the thin I/O wrapper: one UDP round trip, or None."""

    def test_a_reply_is_parsed_and_returned(self):
        packet = _response_packet(snmp.SYS_DESCR, 0x04, b"ASUS RT-AX88U")

        class FakeUDP:
            def __enter__(inner): return inner
            def __exit__(inner, *a): return False
            def settimeout(inner, _t): pass
            def sendto(inner, _payload, _addr): pass
            def recvfrom(inner, _n): return packet, ("192.168.100.1", 161)

        with patch.object(snmp.socket, "socket", lambda *a, **k: FakeUDP()):
            self.assertEqual(snmp.get(snmp.SYS_DESCR, "192.168.100.1"), "ASUS RT-AX88U")

    def test_no_reply_within_the_timeout_is_none(self):
        class TimingOutUDP:
            def __enter__(inner): return inner
            def __exit__(inner, *a): return False
            def settimeout(inner, _t): pass
            def sendto(inner, _payload, _addr): pass
            def recvfrom(inner, _n): raise TimeoutError("timed out")

        with patch.object(snmp.socket, "socket", lambda *a, **k: TimingOutUDP()):
            self.assertIsNone(snmp.get(snmp.SYS_DESCR, "192.168.100.1"))


class ModemSnmpTest(unittest.TestCase):
    """modem_snmp() is best-effort: most ISP-provisioned modems disable
    LAN-side SNMP, so no reply is the common case, not a fault -- and the
    same off-LAN guard as remote.py's credentialed sections applies here."""

    def test_a_reply_reports_descr_and_uptime(self):
        with patch.object(snmp, "get", side_effect=["ASUS RT-AX88U", 123456]):
            got = snmp.modem_snmp(host="192.168.100.1")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["sys_descr"], "ASUS RT-AX88U")
        self.assertEqual(got["sys_uptime_ticks"], 123456)

    def test_no_reply_is_unavailable_not_fail(self):
        with patch.object(snmp, "get", return_value=None):
            got = snmp.modem_snmp(host="192.168.100.1")
        self.assertEqual(got["state"], "unavailable")

    def test_an_off_lan_host_sends_no_query(self):
        with patch.object(snmp, "get") as mock_get:
            got = snmp.modem_snmp(host="1.1.1.1")
        mock_get.assert_not_called()
        self.assertEqual(got["state"], "unavailable")


if __name__ == "__main__":
    unittest.main()
