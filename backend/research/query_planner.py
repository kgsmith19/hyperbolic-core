"""Research Query Planning & Expansion Engine with Model Selection & Spend Tracking.

Expands research topics into multi-angle queries using blind LLM planning
or decoy-chaffed k-anonymity blinder, tracking token spend and supporting reasoning models.
"""

import os
import re
import openai
from backend.privacy.watchlist_redactor import redact, assert_safe_to_send, SafetyError
from backend.privacy.statistical_chaffer import generate_chaffed_prompt, extract_chaffed_response


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
    except Exception:
        return [topic]


def expand_topic_queries_chaffed(
    blinded_topic: str,
    watchlist: list[str],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None
) -> list[str]:
    """Expand queries using both token blinding and decoy chaffing for maximum privacy."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return [blinded_topic]

    chaffed_prompt, target_idx = generate_chaffed_prompt(blinded_topic, k=3)
    assert_safe_to_send(chaffed_prompt, watchlist)

    try:
        client = openai.OpenAI(api_key=api_key)
        kwargs = {"model": model, "input": chaffed_prompt}
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
                prompt_text=chaffed_prompt,
                completion_text=output_text,
                model=model,
            )

        extracted = extract_chaffed_response(output_text, target_idx)
        sanitized_queries = []
        for q in extracted:
            public_clean = re.sub(r"\[TARGET_ENTITY_\d+\]", " ", q)
            public_clean = re.sub(r"\s+", " ", public_clean).strip()
            clean_query = redact(public_clean, watchlist)
            try:
                assert_safe_to_send(clean_query, watchlist)
                if clean_query and clean_query not in sanitized_queries:
                    sanitized_queries.append(clean_query)
            except SafetyError:
                continue

        clean_base = re.sub(r"\[TARGET_ENTITY_\d+\]", " ", blinded_topic)
        clean_base = re.sub(r"\s+", " ", clean_base).strip()
        if clean_base and clean_base not in sanitized_queries:
            sanitized_queries.insert(0, clean_base)

        return sanitized_queries[:4] if sanitized_queries else [clean_base]
    except Exception:
        clean_base = re.sub(r"\[TARGET_ENTITY_\d+\]", " ", blinded_topic).strip()
        return [clean_base] if clean_base else []
