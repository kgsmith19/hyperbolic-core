"""Cloud LLM Synthesis with Watchlist Redaction, Configurable Models & Spend Accounting.

Generates structured research summaries using the OpenAI Responses/Completions API
with strict pre-flight watchlist assertion, prompt sanitization, model selection,
reasoning effort controls (for o1/o3-mini), token/cost tracking, and automatic fallback
to the local air-gapped SLM engine.
"""

import os
import openai
from backend.privacy.watchlist_redactor import redact, assert_safe_to_send
from backend.synthesis.local_synthesizer import LocalSynthesizer


def summarize_with_openai(
    topic: str,
    evidence: list[dict],
    watchlist: list[str],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None
) -> str:
    """Generate a concise sourced research summary using OpenAI with configurable model and effort."""
    assert_safe_to_send(topic, watchlist)
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()

    if not api_key:
        # 100% Air-Gapped Local SLM Sourced Synthesis (Zero external network calls)
        local_slm = LocalSynthesizer()
        summary = local_slm.synthesize(topic, evidence)
        clean_summary = redact(summary, watchlist)
        assert_safe_to_send(clean_summary, watchlist)
        return clean_summary

    formatted_sources = []
    for idx, item in enumerate(evidence, start=1):
        source_block = (
            f"Source {idx}:\n"
            f"Title: {item.get('title', '')}\n"
            f"URL: {item.get('url', '')}\n"
            f"Snippet: {item.get('snippet', '')}\n"
            f"Excerpt: {item.get('excerpt', '') or item.get('content', '')}"
        )
        formatted_sources.append(source_block)

    evidence_text = "\n\n".join(formatted_sources)
    prompt = (
        f"Provide a concise sourced research summary for the topic below using only the provided sanitized evidence.\n\n"
        f"Topic: {topic}\n\n"
        f"Evidence:\n{evidence_text}\n"
    )

    assert_safe_to_send(prompt, watchlist)

    try:
        client = openai.OpenAI(api_key=api_key)

        kwargs = {"model": model, "input": prompt}
        # Add reasoning effort for models that support it (o1, o3-mini)
        if reasoning_effort and any(k in model.lower() for k in ("o1", "o3", "o4")):
            kwargs["reasoning"] = {"effort": reasoning_effort}

        response = client.responses.create(**kwargs)
        output_text = getattr(response, "output_text", "")
        if not output_text and hasattr(response, "output"):
            output_text = str(response.output)

        # Record token usage & expenditure if cost tracker provided
        if cost_tracker:
            usage = getattr(response, "usage", None)
            p_tokens = getattr(usage, "input_tokens", None) or getattr(usage, "prompt_tokens", None) if usage else None
            c_tokens = getattr(usage, "output_tokens", None) or getattr(usage, "completion_tokens", None) if usage else None
            cost_tracker.record_usage(
                prompt_tokens=p_tokens,
                completion_tokens=c_tokens,
                prompt_text=prompt,
                completion_text=output_text,
                model=model,
            )

        clean_summary = redact(output_text, watchlist)
        assert_safe_to_send(clean_summary, watchlist)
        return clean_summary
    except Exception as err:
        from backend.research.cloud_errors import CloudCallError
        raise CloudCallError("summary", err) from err
