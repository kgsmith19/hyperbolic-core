"""Cloud LLM Synthesis with Watchlist Redaction, Configurable Models & Spend Accounting.

Generates structured research briefs using the OpenAI Responses API with strict
pre-flight watchlist assertion, prompt sanitization, model selection, reasoning
effort controls, token/cost tracking, and automatic fallback to the local
air-gapped SLM engine (handled by the pipeline).
"""

from backend.privacy.watchlist_redactor import redact, assert_safe_to_send
from backend.synthesis.local_synthesizer import LocalSynthesizer

MAX_SOURCES = 8
MAX_EXCERPT_CHARS = 1200


def _format_sources(evidence: list[dict], watchlist: list[str]) -> str:
    """Render redacted, length-capped source blocks numbered for citation."""
    blocks = []
    for idx, item in enumerate(evidence[:MAX_SOURCES], start=1):
        if not isinstance(item, dict):
            continue
        title = redact(item.get("title") or "", watchlist)
        url = redact(item.get("url") or "", watchlist)
        snippet = redact(item.get("snippet") or "", watchlist)
        excerpt = redact(
            (item.get("excerpt") or item.get("content") or "")[:MAX_EXCERPT_CHARS],
            watchlist,
        )
        block = (
            f"Source [{idx}]:\n"
            f"Title: {title}\n"
            f"URL: {url}\n"
        )
        if snippet:
            block += f"Snippet: {snippet}\n"
        block += f"Excerpt: {excerpt}"
        blocks.append(block)
    return "\n\n".join(blocks)


def summarize_with_openai(
    topic: str,
    evidence: list[dict],
    watchlist: list[str],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None
) -> str:
    """Generate a structured sourced research brief using OpenAI.

    Cites sources inline as [1], [2], ... keyed to the evidence order.
    Raises CloudCallError on API failure; the pipeline falls back locally.
    """
    assert_safe_to_send(topic, watchlist)

    from backend.research.cloud_client import get_api_key, invoke_model

    for item in evidence:
        if not isinstance(item, dict):
            continue
        assert_safe_to_send(
            item.get("excerpt") or item.get("content") or "",
            watchlist,
        )
        assert_safe_to_send(item.get("title") or "", watchlist)

    if not get_api_key():
        # 100% Air-Gapped Local SLM Sourced Synthesis (Zero external network calls)
        local_slm = LocalSynthesizer()
        summary = local_slm.synthesize(topic, evidence)
        clean_summary = redact(summary, watchlist)
        assert_safe_to_send(clean_summary, watchlist)
        return clean_summary

    evidence_text = _format_sources(evidence, watchlist)
    prompt = (
        f"You are a research analyst. Write a sourced brief for the topic below using "
        f"ONLY the provided sanitized evidence. Cite sources inline as [1], [2], etc. "
        f"matching the source numbers. Never invent a source, citation, or fact that is "
        f"not present in the evidence. If the evidence is thin on some aspect, say so "
        f"under open questions rather than guessing.\n\n"
        f"Topic: {topic}\n\n"
        f"Evidence:\n{evidence_text}\n\n"
        f"Format your brief exactly as:\n"
        f"## Executive Summary\n(2-3 sentence overview)\n\n"
        f"## Key Findings\n(bulleted findings, each with [n] citations)\n\n"
        f"## Tensions & Gaps\n(contradictions between sources or missing angles; "
        f"write 'None identified' if empty)\n\n"
        f"## Open Questions\n(1-3 follow-up research questions)\n"
    )

    assert_safe_to_send(prompt, watchlist)

    try:
        output_text = invoke_model(
            prompt,
            model=model,
            reasoning_effort=reasoning_effort,
            cost_tracker=cost_tracker,
            max_output_tokens=1500,
        )
        clean_summary = redact(output_text, watchlist)
        assert_safe_to_send(clean_summary, watchlist)
        return clean_summary
    except Exception as err:
        from backend.research.cloud_errors import CloudCallError
        raise CloudCallError("summary", err) from err
