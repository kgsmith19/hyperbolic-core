"""Verification retries share one monotonic wall-clock deadline."""
import inspect
import unittest
from unittest.mock import patch

from network_checker import change_security, change_verify


class ReturnsPromptlyOnSuccessTest(unittest.TestCase):
    def test_a_first_attempt_success_returns_immediately(self):
        with patch.object(change_verify.time, "monotonic", side_effect=[0.0, 0.0]), \
             patch.object(change_verify, "run",
                          return_value=(True, {"field": "dns_public"})) as verify:
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertTrue(ok)
        self.assertEqual(log, [{"attempt": 1, "ok": True, "field": "dns_public"}])
        verify.assert_called_once_with("dns_public:ok", timeout=30)


class SharedDeadlineTest(unittest.TestCase):
    def test_a_slow_attempt_stops_retrying_after_the_deadline(self):
        with patch.object(change_verify.time, "monotonic",
                          side_effect=[0.0, 80.0, 95.0]), \
             patch.object(change_verify, "run",
                          return_value=(False, {"n": 1})) as verify:
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertFalse(ok)
        self.assertEqual(len(log), 1)
        verify.assert_called_once_with("dns_public:ok", timeout=10 / 3)

    def test_each_fast_failure_gets_only_its_fair_share(self):
        with patch.object(change_verify.time, "monotonic",
                          side_effect=[0.0, 0.0, 30.0, 60.0]), \
             patch.object(change_verify, "run",
                          return_value=(False, {})) as verify:
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertFalse(ok)
        self.assertEqual(len(log), 3)
        self.assertEqual(
            [call.kwargs["timeout"] for call in verify.call_args_list],
            [30, 30, 30],
        )


class SignatureAndReturnShapePreservedTest(unittest.TestCase):
    def test_defaults_are_unchanged(self):
        signature = inspect.signature(change_security._verify_with_retry)
        self.assertEqual(signature.parameters["attempts"].default, 3)
        self.assertEqual(signature.parameters["budget_s"].default, 90)

    def test_return_shape_is_a_bool_and_a_list_of_per_attempt_dicts(self):
        detail = {"field": "dns_public", "want": "ok", "got": "ok"}
        with patch.object(change_verify.time, "monotonic", side_effect=[0.0, 0.0]), \
             patch.object(change_verify, "run", return_value=(True, detail)):
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertIsInstance(ok, bool)
        self.assertIsInstance(log, list)
        self.assertEqual(log[0]["attempt"], 1)
        self.assertIn("field", log[0])


if __name__ == "__main__":
    unittest.main()
