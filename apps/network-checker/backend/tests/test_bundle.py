"""Evidence bundle export (Issue #74): a deterministic, redacted derived view
over already-collected samples/errors/scans. `build()` takes plain data in
and returns plain data out -- no I/O, so "no network call during export" is
structural, not just tested."""
import json
import unittest
from datetime import datetime, timezone

from network_checker import bundle

NOW = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)

_FAKE_TOKEN = "Bearer " + "x" * 24
_SENSITIVE_STRINGS = [
    "203.0.113.7",
    "AA:BB:CC:DD:EE:FF",
    r"C:\Users\kyleg\.network-checker",
    "/home/kyleg/.network-checker",
    "/Users/kyleg/.network-checker",
    _FAKE_TOKEN,
    "password=hunter2",
    "2001:db8:85a3::8a2e:370:7334",
    "fe80::1",
    "::1",
]

# Text that resembles an IPv6 address only in having colons -- must survive
# redaction unchanged, since over-matching here would corrupt timestamps.
_IPV6_LOOKALIKES = ["12:34:56", "2026-08-10T12:00:00+00:00"]


class RedactTest(unittest.TestCase):
    def test_redact_strips_every_sensitive_pattern(self):
        for raw in _SENSITIVE_STRINGS:
            with self.subTest(raw=raw):
                out = bundle.redact({"evidence": f"prefix {raw} suffix"})
                self.assertNotIn(raw, out["evidence"])
                self.assertIn("[REDACTED", out["evidence"])

    def test_redact_leaves_timestamp_shaped_text_alone(self):
        for raw in _IPV6_LOOKALIKES:
            with self.subTest(raw=raw):
                out = bundle.redact({"generated_at": raw})
                self.assertEqual(out["generated_at"], raw)

    def test_redact_recurses_through_lists_and_nested_dicts(self):
        out = bundle.redact({"a": ["x", {"b": "203.0.113.7"}]})
        self.assertNotIn("203.0.113.7", out["a"][1]["b"])

    def test_redact_leaves_ordinary_values_alone(self):
        out = bundle.redact({"state": "ok", "count": 3, "flag": True, "none": None})
        self.assertEqual(out, {"state": "ok", "count": 3, "flag": True, "none": None})


def _sample(ts, **kw):
    row = dict(ts=ts, gw_state="ok", hop_state="ok", inet_state="ok",
               dns_router_state="ok", dns_public_state="ok",
               tls_state="ok", http_state="ok", culprit=None, label=None)
    row.update(kw)
    return row


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.samples = [
            _sample("2026-08-10T11:59:00+00:00", inet_state="fail", culprit="internet"),
            _sample("2026-08-10T11:58:00+00:00"),
        ]
        self.errors = [{"ts": "2026-08-10T11:59:05+00:00", "source": "claude-code",
                        "kind": "network",
                        "detail": _FAKE_TOKEN + r" failed for C:\Users\kyleg\project"}]
        self.scan = {
            "wifi": {"state": "ok", "ssid": "HomeNet", "bssid": "AA:BB:CC:DD:EE:FF",
                     "band": "5 GHz", "channel": 44, "signal_pct": 80, "rssi_dbm": -55},
            "wan": {"state": "ok", "ip": "203.0.113.7", "double_nat": False, "cgnat": False,
                    "geo": {"state": "ok", "city": "Springfield"}},
            "dual_stack": {"state": "ok",
                           "ipv4": {"state": "ok", "ms": 12.0},
                           "ipv6": {"state": "unavailable", "reason": "no IPv6 address"}},
            "modem": {"state": "ok", "uncorrectables": [0, 3]},
            "exposure": {"state": "ok", "findings": [
                {"ip": "192.168.50.42", "port": 80, "kind": "open_port"}]},
        }

    def test_build_is_deterministic_for_a_fixed_snapshot(self):
        a = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        b = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_build_never_leaks_raw_wan_ip_bssid_or_lan_ip(self):
        out = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        blob = json.dumps(out)
        for raw in ("203.0.113.7", "AA:BB:CC:DD:EE:FF", "192.168.50.42"):
            self.assertNotIn(raw, blob)

    def test_build_never_leaks_a_raw_ipv6_address_in_scan_cause_evidence(self):
        # broken_ipv6's evidence string embeds the connect error's `reason`,
        # which can itself carry the address the OS reported the failure
        # against -- the one place an IPv6 literal reaches the bundle today.
        scan = dict(self.scan, dual_stack={
            "state": "ok",
            "ipv4": {"state": "ok", "ms": 12.0},
            "ipv6": {"state": "fail", "ms": None,
                    "reason": "ConnectionRefusedError: [Errno 111] Connection "
                              "refused to 2001:db8:85a3::8a2e:370:7334"}})
        out = bundle.build(self.samples, self.errors, scan, {"os_name": "Windows", "now": NOW})
        blob = json.dumps(out)
        self.assertNotIn("2001:db8:85a3::8a2e:370:7334", blob)
        self.assertIn("[REDACTED-IP]", blob)

    def test_build_never_leaks_raw_llm_error_detail_or_secrets(self):
        out = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        blob = json.dumps(out)
        self.assertNotIn(_FAKE_TOKEN, blob)
        self.assertNotIn(r"C:\Users\kyleg\project", blob)
        self.assertEqual(out["llm_error_summary"]["count"], 1)

    def test_build_drops_geolocation_entirely(self):
        out = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        self.assertNotIn("geo", out["network_summary"]["wan"])
        self.assertNotIn("Springfield", json.dumps(out))

    def test_build_carries_causes_probe_and_scan_tier_metadata(self):
        out = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        self.assertEqual(out["collection"]["scan_tier"], "standard")
        self.assertEqual(out["collection"]["sample_count"], 2)
        self.assertGreaterEqual(len(out["causes"]), 1)
        self.assertEqual(out["probe_summary"]["count"], 2)
        self.assertEqual(out["network_checker_version"], bundle.__version__)
        self.assertEqual(out["generated_at"], "2026-08-10T12:00:00+00:00")

    def test_deep_tier_detected_from_topology_key(self):
        deep_scan = dict(self.scan, topology={"state": "ok", "devices": []})
        out = bundle.build(self.samples, self.errors, deep_scan, {"os_name": "Windows", "now": NOW})
        self.assertEqual(out["collection"]["scan_tier"], "deep")

    def test_no_experiment_comparison_without_two_labels(self):
        out = bundle.build(self.samples, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        self.assertIsNone(out["experiment_comparison"])

    def test_experiment_comparison_present_for_two_labels(self):
        labeled = self.samples + [
            _sample("2026-08-10T11:57:00+00:00", label="a"),
            _sample("2026-08-10T11:56:00+00:00", label="b"),
        ]
        out = bundle.build(labeled, self.errors, self.scan, {"os_name": "Windows", "now": NOW})
        comp = out["experiment_comparison"]
        self.assertEqual({comp["label_a"], comp["label_b"]}, {"a", "b"})
        self.assertTrue(comp["result"]["a"]["has_data"])


class RenderTest(unittest.TestCase):
    def test_render_json_round_trips_and_is_sorted(self):
        data = bundle.build([_sample("2026-08-10T11:59:00+00:00")], [], {}, {"os_name": "Windows", "now": NOW})
        text = bundle.render_json(data)
        self.assertEqual(json.loads(text), data)

    def test_render_markdown_includes_key_sections(self):
        data = bundle.build([_sample("2026-08-10T11:59:00+00:00")], [], {}, {"os_name": "Windows", "now": NOW})
        text = bundle.render_markdown(data)
        for heading in ("# network-checker evidence bundle", "## Commands used",
                        "## Network summary", "## Probe summary",
                        "## LLM error summary", "## Ranked causes",
                        "## Controlled comparison"):
            self.assertIn(heading, text)


if __name__ == "__main__":
    unittest.main()
