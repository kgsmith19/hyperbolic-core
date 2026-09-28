"""Synthesis Intelligence Bounded Context.

Provides air-gapped CPU extractive summarization, local SLM inference,
cloud LLM synthesis, gap analysis, and Markdown report generation.
"""

from backend.synthesis.local_synthesizer import (
    LocalSynthesizer,
)
from backend.synthesis.claim_verifier import (
    extract_claims,
    verify_evidence,
    verification_brief,
)
from backend.synthesis.openai_synthesizer import (
    summarize_with_openai,
)
from backend.synthesis.report_generator import (
    write_report,
)

__all__ = [
    "LocalSynthesizer",
    "extract_claims",
    "verify_evidence",
    "verification_brief",
    "summarize_with_openai",
    "write_report",
]
