"""Research Query Planning & Expansion Engine with Model Selection & Spend Tracking.

Expands research topics into multi-angle queries using blind LLM planning
or decoy-chaffed k-anonymity blinder, tracking token spend and supporting reasoning models.
"""

import os
import re
import openai
from backend.privacy.watchlist_redactor import redact, assert_safe_to_send, SafetyError


def expand_topic_queries(
    topic: str,
    watchlist: list[str],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None
) -> list[str]:
    """Generate 3-4 diverse sub-queries for broad search using blind LLM planning."""
    assert_safe_to_send(topic, watchlist)
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return [topic]

    prompt = (
        f"Generate 3 to 4 distinct, highly specific search queries to thoroughly research the public topic below.\n"
        f"Topic: {topic}\n\n"
        f"Output only one search query per line. Do not number or bullet the lines."
    )
    assert_safe_to_send(prompt, watchlist)

    try:
        client = openai.OpenAI(api_key=api_key)
        kwargs = {"model": model, "input": prompt}
        if reasoning_effort and any(k in model.lower() for k in ("o1", "o3", "o4")):
            kwargs["reasoning"] = {"effort": reasoning_effort}

        response = client.responses.create(**kwargs)
        output_text = getattr(response, "output_text", "")
        if not output_text and hasattr(response, "output"):
            output_text = str(response.output)

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

        lines = [line.strip() for line in output_text.splitlines() if line.strip()]
        queries = [topic]
        for line in lines:
            clean_query = redact(line, watchlist)
            clean_query = re.sub(r'^\s*(\d+[\.\)]|\*|-)\s*', '', clean_query).strip(' "\'')
            try:
                assert_safe_to_send(clean_query, watchlist)
                if clean_query and clean_query not in queries:
                    queries.append(clean_query)
            except SafetyError:
                continue
        return queries[:4]
    except Exception as err:
        from backend.research.cloud_errors import CloudCallError
        raise CloudCallError("planning", err) from err
