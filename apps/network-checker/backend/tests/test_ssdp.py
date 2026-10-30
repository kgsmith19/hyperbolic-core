"""SSDP/UPnP: the two pure parsers, and identify_gateway() which composes
them with remote.py's LAN-only guard. Tested against a captured SSDP reply
and device-description document the same way docsis.py's parser is."""
import unittest
from unittest.mock import patch

from network_checker import remote, ssdp

from tests import fixture


class ParseResponseTest(unittest.TestCase):
    def test_location_header_is_extracted(self):
        got = ssdp.parse_response(fixture("ssdp_response.txt"))
        self.assertEqual(got, "http://192.168.1.1:5431/rootDesc.xml")

    def test_a_response_with_no_location_header_is_none(self):
        text = "HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\n\r\n"
        self.assertIsNone(ssdp.parse_response(text))


class ParseDeviceDescriptionTest(unittest.TestCase):
    def test_manufacturer_and_model_are_extracted(self):
        got = ssdp.parse_device_description(fixture("device_description.xml"))
        self.assertEqual(got["manufacturer"], "ASUSTeK Computer Inc.")
        self.assertEqual(got["model"], "RT-AX88U")

    def test_malformed_xml_is_none(self):
        self.assertIsNone(ssdp.parse_device_description("<not xml"))


class IdentifyGatewayTest(unittest.TestCase):
    """identify_gateway() composes SSDP discovery, the LAN-only guard, and
    the document fetch -- each failure mode must degrade to a state, never
    raise, and only a device that actually answered may ever read `ok`."""

    def test_a_full_discovery_reports_manufacturer_and_model(self):
        with patch.object(ssdp, "discover", return_value=fixture("ssdp_response.txt")), \
             patch.object(remote, "_http_get",
                          return_value=(fixture("device_description.xml"), None)):
            got = ssdp.identify_gateway()
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["manufacturer"], "ASUSTeK Computer Inc.")
        self.assertEqual(got["model"], "RT-AX88U")

    def test_no_ssdp_response_is_unavailable_not_fail(self):
        with patch.object(ssdp, "discover", return_value=None):
            got = ssdp.identify_gateway()
        self.assertEqual(got["state"], "unavailable")

    def test_a_response_with_no_location_is_unavailable(self):
        with patch.object(ssdp, "discover", return_value="HTTP/1.1 200 OK\r\n\r\n"):
            got = ssdp.identify_gateway()
        self.assertEqual(got["state"], "unavailable")

    def test_a_location_off_lan_sends_no_request(self):
        """The same shape as remote.py's CredentialDestinationTest: a device
        on the LAN could hand back a LOCATION pointing anywhere, and nothing
        stops it but this check. 1.1.1.1, not a 203.0.113.x documentation
        address -- ipaddress.is_private reports those as private, correctly."""
        off_lan = fixture("ssdp_response.txt").replace("192.168.1.1", "1.1.1.1")
        with patch.object(ssdp, "discover", return_value=off_lan), \
             patch.object(remote, "_fetch") as mock_fetch:
            got = ssdp.identify_gateway()
        mock_fetch.assert_not_called()
        self.assertEqual(got["state"], "unavailable")

    def test_a_fetch_failure_is_fail_not_unavailable(self):
        with patch.object(ssdp, "discover", return_value=fixture("ssdp_response.txt")), \
             patch.object(remote, "_http_get", return_value=(None, "URLError: timeout")):
            got = ssdp.identify_gateway()
        self.assertEqual(got["state"], "fail")

    def test_unparseable_device_description_is_unavailable(self):
        with patch.object(ssdp, "discover", return_value=fixture("ssdp_response.txt")), \
             patch.object(remote, "_http_get", return_value=("<not xml", None)):
            got = ssdp.identify_gateway()
        self.assertEqual(got["state"], "unavailable")


if __name__ == "__main__":
    unittest.main()
