"""Fix application: safe remedies for ASUS router, CAX80 modem, local config.

PDD: Every fix applier validates device type and returns complete status.
SDD: Fixes apply correctly and track device-specific requirements.
TDD: Fix sequences resolve dependencies and manage reboot workflow.
"""
import unittest
from datetime import datetime
from netcheck import fix_application, fix_engine


class FixApplierInitializationTest(unittest.TestCase):
    """PDD: FixApplier validates device type and stores credentials."""

    def test_applier_accepts_all_device_types(self):
        """FixApplier works with ASUS router, CAX80 modem, local config."""
        for device_type in ["asus_router", "cax80_modem", "local_config"]:
            applier = fix_application.FixApplier(device_type)
            self.assertEqual(applier.device_type, device_type)

    def test_applier_stores_credentials(self):
        """Credentials dict is stored and accessible."""
        creds = {"username": "admin", "password": "pass"}
        applier = fix_application.FixApplier("asus_router", creds)
        self.assertEqual(applier.credentials, creds)

    def test_applier_initializes_applied_fixes_list(self):
        """Applied fixes tracking starts empty."""
        applier = fix_application.FixApplier("asus_router")
        self.assertIsInstance(applier.applied_fixes, list)
        self.assertEqual(len(applier.applied_fixes), 0)


class FixApplierReturnStructureTest(unittest.TestCase):
    """PDD: All fix methods return complete status dicts."""

    def test_wifi_channel_fix_has_required_fields(self):
        """Wi-Fi channel fix includes channel, bandwidth, reboot, verification."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36", "80MHz")

        self.assertIn("fix_id", result)
        self.assertIn("status", result)
        self.assertIn("channel", result)
        self.assertIn("bandwidth", result)
        self.assertIn("requires_reboot", result)
        self.assertIn("verification_step", result)
        self.assertIn("timestamp", result)

    def test_aiprotection_fix_has_warning_and_reboot(self):
        """AiProtection disable includes warning about filtering loss."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.disable_aiprotection()

        self.assertEqual(result["status"], "applied")
        self.assertTrue(result["requires_reboot"])
        self.assertIn("warning", result)
        self.assertIn("IDS", result["warning"])

    def test_qos_fix_marks_reboot_required(self):
        """QoS disable requires reboot."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.disable_qos()

        self.assertEqual(result["status"], "applied")
        self.assertTrue(result["requires_reboot"])

    def test_restart_action_has_device_and_wait_time(self):
        """Restart returns device identifier and wait duration."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.restart_device()

        self.assertEqual(result["device"], "asus_router")
        self.assertEqual(result["wait_time_seconds"], 180)

    def test_device_status_query_returns_connectivity(self):
        """Device status includes connection state and metric readiness."""
        applier = fix_application.FixApplier("asus_router")
        status = applier.get_device_status()

        self.assertIn("device_type", status)
        self.assertIn("status", status)
        self.assertIn("can_read_metrics", status)


class DeviceTypeValidationTest(unittest.TestCase):
    """SDD: Methods validate device type before applying fixes."""

    def test_wifi_fix_rejects_wrong_device_type(self):
        """Wi-Fi fix fails on modem or local config."""
        for device_type in ["cax80_modem", "local_config"]:
            applier = fix_application.FixApplier(device_type)
            result = applier.apply_wifi_channel_fix("36")
            self.assertEqual(result["status"], "error")
            self.assertIn("reason", result)

    def test_aiprotection_rejects_non_asus(self):
        """AiProtection fix only works on ASUS router."""
        applier = fix_application.FixApplier("cax80_modem")
        result = applier.disable_aiprotection()
        self.assertEqual(result["status"], "error")

    def test_wifi_fix_succeeds_on_asus(self):
        """Wi-Fi fix applies successfully on ASUS router."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36", "80MHz")
        self.assertEqual(result["status"], "applied")


class RebootRequirementTrackingTest(unittest.TestCase):
    """PDD: Methods accurately flag reboot requirements."""

    def test_wifi_channel_change_no_reboot(self):
        """Wi-Fi channel adjustment doesn't require reboot."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36")
        self.assertFalse(result["requires_reboot"])

    def test_aiprotection_requires_reboot(self):
        """Disabling AiProtection requires reboot."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.disable_aiprotection()
        self.assertTrue(result["requires_reboot"])

    def test_qos_requires_reboot(self):
        """Disabling QoS requires reboot."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.disable_qos()
        self.assertTrue(result["requires_reboot"])


class WiFiChannelFixTest(unittest.TestCase):
    """SDD: Wi-Fi channel fixes set correct channel and bandwidth."""

    def test_channel_36_5ghz_band(self):
        """Channel 36 is 5 GHz (non-overlapping)."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36", "80MHz")

        self.assertEqual(result["channel"], "36")
        self.assertEqual(result["bandwidth"], "80MHz")

    def test_custom_bandwidth_honored(self):
        """Bandwidth parameter is passed through."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("149", "160MHz")

        self.assertEqual(result["bandwidth"], "160MHz")

    def test_wifi_fix_includes_verification(self):
        """Wi-Fi fix specifies how to verify success."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36")

        self.assertIn("verification_step", result)
        self.assertTrue(len(result["verification_step"]) > 0)


class FixSequenceApplicationTest(unittest.TestCase):
    """TDD: Sequences apply fixes with handler dispatch."""

    def test_sequence_applies_all_fixes(self):
        """All fixes in sequence are processed."""
        fixes = [
            fix_engine.FixRecommendation("wifi_ch", "Channel", "wifi", "low", 0.8, ["step"]),
            fix_engine.FixRecommendation("disable_ai", "AiProt", "router", "medium", 0.6, ["step"]),
        ]

        handlers = {
            "wifi": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": False},
            "router": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": True},
        }

        results = fix_application.apply_fix_sequence(fixes, handlers)

        self.assertEqual(len(results), 3)  # 2 fixes + 1 reboot notice
        self.assertEqual(results[0]["fix_id"], "wifi_ch")
        self.assertEqual(results[1]["fix_id"], "disable_ai")

    def test_sequence_tracks_reboot_requirement(self):
        """Sequence detects when any fix requires reboot."""
        fixes = [
            fix_engine.FixRecommendation("fix1", "Fix 1", "wifi", "low", 0.8, ["step"]),
            fix_engine.FixRecommendation("fix2", "Fix 2", "router", "medium", 0.6, ["step"]),
        ]

        handlers = {
            "wifi": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": False},
            "router": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": True},
        }

        results = fix_application.apply_fix_sequence(fixes, handlers)

        # Last result should be reboot notice
        self.assertEqual(results[-1]["action"], "reboot_recommended")

    def test_sequence_skips_missing_handlers(self):
        """Fixes without handlers are skipped gracefully."""
        fixes = [
            fix_engine.FixRecommendation("fix1", "Fix 1", "unknown_category", "low", 0.5, ["step"]),
        ]

        handlers = {}

        results = fix_application.apply_fix_sequence(fixes, handlers)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "skipped")

    def test_sequence_no_reboot_if_not_needed(self):
        """No reboot notice if all fixes are reboot-free."""
        fixes = [
            fix_engine.FixRecommendation("fix1", "Fix 1", "wifi", "low", 0.8, ["step"]),
        ]

        handlers = {
            "wifi": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": False},
        }

        results = fix_application.apply_fix_sequence(fixes, handlers)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["fix_id"], "fix1")


class TimestampTrackingTest(unittest.TestCase):
    """TDD: All fix applications include timestamps."""

    def test_wifi_fix_has_iso_timestamp(self):
        """Wi-Fi fix timestamp is ISO format."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36")

        self.assertIn("timestamp", result)
        # Should be parseable as ISO format
        ts = datetime.fromisoformat(result["timestamp"])
        self.assertIsNotNone(ts)

    def test_restart_has_timestamp(self):
        """Restart action includes timestamp."""
        applier = fix_application.FixApplier("asus_router")
        result = applier.restart_device()

        self.assertIn("timestamp", result)
        ts = datetime.fromisoformat(result["timestamp"])
        self.assertIsNotNone(ts)


class IntegrationWithFixEngineTest(unittest.TestCase):
    """TDD: FixApplier works with fix_engine recommendations."""

    def test_apply_wifi_fix_from_diagnosis(self):
        """Applies Wi-Fi fix recommended by diagnosis."""
        diagnosis = {"primary_culprit": "gateway", "synthesis_confidence": 0.85}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis)

        wifi_fixes = [f for f in fixes if f.category == "wifi"]
        self.assertGreater(len(wifi_fixes), 0)

        applier = fix_application.FixApplier("asus_router")
        result = applier.apply_wifi_channel_fix("36")

        self.assertEqual(result["status"], "applied")

    def test_apply_router_fix_from_diagnosis(self):
        """Applies router fix recommended by diagnosis."""
        diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis)

        router_fixes = [f for f in fixes if f.category == "router"]
        self.assertGreater(len(router_fixes), 0)

        applier = fix_application.FixApplier("asus_router")
        result = applier.disable_aiprotection()

        self.assertEqual(result["status"], "applied")


if __name__ == "__main__":
    unittest.main()
