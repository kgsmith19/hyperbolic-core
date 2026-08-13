"""Finding 59 regression tests (independent security review):
_verify_with_retry()'s real wall-clock deadline. `time.monotonic`/
`time.sleep` are patched at their point of use in netcheck.change_security
(the same convention test_watch.py uses for `watch.time.sleep`) so this
never waits on a real clock; `_run_verify` is patched too, since no real
probe/network call is available in this sandbox. Split out as its own file
since change_security.py's own primitives (execute(), the HMAC token) each
already have dedicated test files (test_change_execute.py, test_change_key.py)
and this module had none of its own yet."""
import unittest
from unittest.mock import patch

from netcheck import change_security


class ReturnsPromptlyOnSuccessTest(unittest.TestCase):
    """The function must return the moment a probe passes, never waiting
    out any remaining sleep it would otherwise have taken."""

    def test_a_first_attempt_success_returns_immediately_with_no_sleep(self):
        with patch.object(change_security.time, "monotonic", side_effect=[0.0]), \
             patch.object(change_security.time, "sleep") as sleep, \
             patch.object(change_security, "_run_verify",
                          return_value=(True, {"field": "dns_public"})) as verify:
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertTrue(ok)
        self.assertEqual(log, [{"attempt": 1, "ok": True, "field": "dns_public"}])
        sleep.assert_not_called()
        verify.assert_called_once_with("dns_public:ok")


class SlowProbeShortensSubsequentSleepsTest(unittest.TestCase):
    """Finding 59's concrete bug: the old formula slept a fixed budget_s/
    attempts between every attempt with no accounting for how long each
    probe itself took, so a slow probe pushed total wall time well past
    the promised budget_s. Proves: (a) a probe that ate most of the budget
    gets a correspondingly SHORTER sleep next, not the full per-attempt
    share; (b) once the real deadline has passed, retrying stops --
    returning the last result -- even with attempts left unused, so the
    probe itself is never re-invoked past the deadline either."""

    def test_a_slow_first_attempt_shortens_the_sleep_and_then_stops_retrying(self):
        # budget_s=90, attempts=3 -> per_attempt=30. monotonic():
        #   call 1: deadline = 0 + 90 = 90
        #   call 2 (after attempt 1's probe, simulated to have taken 80s):
        #     remaining = 90-80 = 10 -> sleep(min(10, 30)) = sleep(10)
        #   call 3 (after attempt 2's probe; simulated past the deadline):
        #     remaining = 90-95 = -5 <= 0 -> stop, no 3rd attempt at all
        with patch.object(change_security.time, "monotonic",
                          side_effect=[0.0, 80.0, 95.0]), \
             patch.object(change_security.time, "sleep") as sleep, \
             patch.object(change_security, "_run_verify",
                          side_effect=[(False, {"n": 1}), (False, {"n": 2})]) as verify:
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertFalse(ok)
        self.assertEqual(len(log), 2, "must not have reached a 3rd attempt past the deadline")
        self.assertEqual(verify.call_count, 2)
        sleep.assert_called_once_with(10)  # correspondingly shorter, not the full 30s share

    def test_the_sleep_is_never_longer_than_the_per_attempt_share_even_when_plenty_remains(self):
        """The cap direction matters too: min(remaining, per_attempt), not
        just remaining alone -- otherwise a fast first attempt would sleep
        the ENTIRE remaining budget on attempt 1, starving attempt 2's own
        share. budget_s=90, attempts=3 -> per_attempt=30; remaining after a
        near-instant attempt 1 is ~90, so the sleep must still cap at 30."""
        with patch.object(change_security.time, "monotonic",
                          side_effect=[0.0, 0.0, 30.0]), \
             patch.object(change_security.time, "sleep") as sleep, \
             patch.object(change_security, "_run_verify",
                          side_effect=[(False, {}), (False, {}), (False, {})]):
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertFalse(ok)
        self.assertEqual(len(log), 3)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [30, 30])


class SignatureAndReturnShapePreservedTest(unittest.TestCase):
    """The fix must be pure timing behavior -- same (bool, log) return
    shape, same attempts/budget_s defaults, callable exactly as before."""

    def test_defaults_are_unchanged(self):
        import inspect
        sig = inspect.signature(change_security._verify_with_retry)
        self.assertEqual(sig.parameters["attempts"].default, 3)
        self.assertEqual(sig.parameters["budget_s"].default, 90)

    def test_return_shape_is_a_bool_and_a_list_of_per_attempt_dicts(self):
        with patch.object(change_security.time, "monotonic", side_effect=[0.0]), \
             patch.object(change_security, "_run_verify",
                          return_value=(True, {"field": "dns_public", "want": "ok",
                                               "got": "ok"})):
            ok, log = change_security._verify_with_retry("dns_public:ok")
        self.assertIsInstance(ok, bool)
        self.assertIsInstance(log, list)
        self.assertEqual(log[0]["attempt"], 1)
        self.assertIn("field", log[0])


if __name__ == "__main__":
    unittest.main()
