"""Synthesis Intelligence Bounded Context.

Provides air-gapped CPU extractive summarization, local SLM inference,
cloud LLM synthesis, gap analysis, and Markdown report generation.
"""

from backend.synthesis.local_synthesizer import (
    LocalSynthesizer,
)
from backend.synthesis.openai_synthesizer import (
    summarize_with_openai,
)
from backend.synthesis.report_generator import (
    write_report,
)

__all__ = [
    "LocalSynthesizer",
    "summarize_with_openai",
    "write_report",
]
