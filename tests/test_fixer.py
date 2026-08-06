"""Regression coverage for tools/fixer.py's apply_all_fixes().

apply_all_fixes() mixed detect_gateway_issue() -- which returns a bare
(bool, dict) tuple, not a FixResult -- into a list the rest of the code
treats uniformly as FixResult objects. `python tools/fixer.py --issue all
--dry-run -v` crashed with AttributeError: 'tuple' object has no attribute
'validated' as soon as it tried to read that entry's .validated field.
CI's `... || true` on that step silently swallowed the crash instead of
failing the build (see .github/workflows/fixer-validation.yml history).

dry_run=True makes every underlying command a no-op inside
NetworkFixer.run_command before it ever shells out, so this is hermetic:
no real subprocess calls, no real network access.
"""
import unittest

from tools.fixer import NetworkFixer, FixResult


class ApplyAllFixesTest(unittest.TestCase):
    def test_every_result_is_a_fix_result_with_validated(self):
        fixer = NetworkFixer(dry_run=True, verbose=False)
        results = fixer.apply_all_fixes()
        self.assertTrue(results)
        for result in results:
            self.assertIsInstance(result, FixResult)
            self.assertIn(result.validated, (True, False))

    def test_gateway_entry_reflects_detection_not_a_fix(self):
        fixer = NetworkFixer(dry_run=True, verbose=False)
        results = fixer.apply_all_fixes()
        gateway = next(r for r in results if r.issue == "gateway")
        self.assertFalse(gateway.applied)
        self.assertFalse(gateway.validated)

    def test_main_style_summary_does_not_raise(self):
        """Reproduces main()'s final line, which crashed before the fix."""
        fixer = NetworkFixer(dry_run=True, verbose=False)
        results = fixer.apply_all_fixes()
        summary = all(r.validated for r in results if r.applied)
        self.assertIn(summary, (True, False))


if __name__ == "__main__":
    unittest.main()
