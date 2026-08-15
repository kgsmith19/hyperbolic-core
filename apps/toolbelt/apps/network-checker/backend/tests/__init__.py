"""Shared test helpers.

Only things genuinely used by three or more test modules live here; anything
narrower stays next to the tests that need it, where it can be read without
a second file open.
"""
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    """Real command output captured from a live machine."""
    return (FIXTURES / name).read_text(encoding="utf-8")
