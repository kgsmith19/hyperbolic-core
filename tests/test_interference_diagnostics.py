import unittest
from netcheck import interference_diagnostics

class InterferenceDiagnosticsTest(unittest.TestCase):
    def test_interference_scan_returns_dict(self):
        diag = interference_diagnostics.InterferenceDiagnostics()
        result = diag.scan_interference_sources()
        self.assertIsInstance(result, dict)
        self.assertIn('detected', result)

    def test_channel_overlap_detection(self):
        diag = interference_diagnostics.InterferenceDiagnostics()
        result = diag.detect_channel_overlap()
        self.assertIsInstance(result, dict)
        self.assertIn('overlap_detected', result)

    def test_signal_quality_check(self):
        diag = interference_diagnostics.InterferenceDiagnostics()
        result = diag.check_signal_quality()
        self.assertIsInstance(result, dict)
        self.assertIn('quality', result)

if __name__ == "__main__":
    unittest.main()
