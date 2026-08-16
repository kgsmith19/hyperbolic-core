"""Coarse WAN geolocation via ipapi.co (FR-020, EXT-006).

locate() is a pure fetch+parse pair, tested the same way test_remote.py
mocks remote._http_get. The load-bearing property: every failure mode here
reads `unavailable`, never `fail` -- geolocation failing is not itself a
diagnostic signal, unlike remote.wan()/remote.anthropic() where an
unreachable API IS the signal.
"""
import unittest
from unittest.mock import patch

from network_checker import geoip


class LocateTest(unittest.TestCase):
    def test_a_successful_lookup_extracts_city_region_country(self):
        body = ('{"city": "Springfield", "region": "Oregon", '
                '"country_name": "United States"}')
        with patch.object(geoip, "_http_get", return_value=(body, None)):
            got = geoip.locate("203.0.113.7")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["city"], "Springfield")
        self.assertEqual(got["region"], "Oregon")
        self.assertEqual(got["country"], "United States")

    def test_an_unreachable_api_is_unavailable_not_fail(self):
        """The distinction this whole module exists to enforce: a network
        error here must never read as `fail` the way it does in remote.py's
        _json_get, because a bad geolocation lookup is not evidence the WAN
        is broken."""
        with patch.object(geoip, "_http_get",
                          return_value=(None, "URLError: timeout")):
            got = geoip.locate("203.0.113.7")
        self.assertEqual(got["state"], "unavailable")
        self.assertNotEqual(got["state"], "fail")

    def test_malformed_json_is_unavailable(self):
        with patch.object(geoip, "_http_get",
                          return_value=("<html>502 Bad Gateway</html>", None)):
            got = geoip.locate("203.0.113.7")
        self.assertEqual(got["state"], "unavailable")

    def test_a_response_with_no_location_is_unavailable(self):
        """A response that parses fine but carries no city/region/country --
        e.g. an error payload from the provider -- must not read as `ok`
        with three None fields."""
        with patch.object(geoip, "_http_get",
                          return_value=('{"error": true, "reason": "quota"}', None)):
            got = geoip.locate("203.0.113.7")
        self.assertEqual(got["state"], "unavailable")


if __name__ == "__main__":
    unittest.main()
