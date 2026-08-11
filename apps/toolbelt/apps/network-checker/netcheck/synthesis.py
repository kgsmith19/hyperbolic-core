"""Pluggable boundary between a ranked report and an LLM-generated summary.

rank.rank() produces the list of causes; this module turns that list into
prose, but only if the caller supplies something that can actually do it.
Nothing here makes a network call -- that arrives when a direct API client,
or a future general-purpose LLM service, implements Synthesizer.
"""
from typing import Optional, Protocol


class Synthesizer(Protocol):
    def synthesize(self, causes: list) -> Optional[str]:
        """Turn a rank.rank() cause list into a natural-language summary."""
        ...


class NullSynthesizer:
    """The default: no synthesis, no network call."""

    def synthesize(self, causes: list) -> Optional[str]:
        return None


def synthesize_report(causes: list, synthesizer: Optional[Synthesizer] = None) -> Optional[str]:
    """Run `synthesizer` over `causes`, or return None if none is given."""
    if synthesizer is None:
        return None
    return synthesizer.synthesize(causes)
