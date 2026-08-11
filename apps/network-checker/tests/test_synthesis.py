"""The synthesis boundary: turning a ranked report into prose, or not.

netcheck/synthesis.py is deliberately provider-agnostic (issue #93) -- the
shipped default makes zero network calls, and a real implementation (a
direct LLM API client, or a future general-purpose LLM service) plugs in
later without rank.py or its call sites changing.
"""
import unittest
from unittest.mock import patch

from netcheck import synthesis


class NullSynthesizerTest(unittest.TestCase):
    def test_returns_none(self):
        self.assertIsNone(synthesis.NullSynthesizer().synthesize([{"cause": "router_dns"}]))

    def test_makes_no_network_call(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError(
                "NullSynthesizer must never open a connection")):
            synthesis.NullSynthesizer().synthesize([{"cause": "router_dns"}])


class FakeSynthesizer:
    """A test double standing in for a real Synthesizer implementation."""

    def __init__(self, reply):
        self.reply = reply
        self.received = None

    def synthesize(self, causes):
        self.received = causes
        return self.reply


class SynthesizeReportTest(unittest.TestCase):
    def test_no_synthesizer_returns_none(self):
        self.assertIsNone(synthesis.synthesize_report([{"cause": "router_dns"}]))

    def test_given_synthesizer_is_invoked_with_the_causes(self):
        causes = [{"cause": "router_dns", "confidence": "high"}]
        fake = FakeSynthesizer(reply="summary text")
        self.assertEqual(synthesis.synthesize_report(causes, fake), "summary text")
        self.assertEqual(fake.received, causes)

    def test_default_synthesizer_is_null(self):
        self.assertIsNone(synthesis.synthesize_report([{"cause": "router_dns"}], synthesizer=None))


if __name__ == "__main__":
    unittest.main()
