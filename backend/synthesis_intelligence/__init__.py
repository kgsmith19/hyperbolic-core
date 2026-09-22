"""Synthesis Intelligence Bounded Context.

Provides air-gapped CPU extractive summarization, local SLM inference,
cloud LLM synthesis, gap analysis, and Markdown report generation.
"""

from backend.synthesis_intelligence.local_synthesizer import (
    LocalSLMEngine,
)
from backend.synthesis_intelligence.openai_synthesizer import (
    summarize_with_openai,
)
from backend.synthesis_intelligence.report_generator import (
    write_report,
)

__all__ = [
    "LocalSLMEngine",
    "summarize_with_openai",
    "write_report",
]
