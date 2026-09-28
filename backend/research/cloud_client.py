"""Shared OpenAI Responses API client for planning, gap analysis, and synthesis.

One place for client construction, reasoning-effort routing, output extraction,
and token/cost accounting so every cloud call behaves identically.
"""

import os

import openai

from backend.research.cost_estimator import CostTracker


def get_api_key() -> str:
    """Return the configured OpenAI API key, or "" when absent."""
    return os.environ.get("OPENAI_API_KEY", "").strip()


def has_api_key() -> bool:
    return bool(get_api_key())


def is_reasoning_model(model: str) -> bool:
    """Models that accept a reasoning-effort parameter on the Responses API."""
    lowered = model.lower()
    return any(k in lowered for k in ("o1", "o3", "o4", "gpt-5"))


def invoke_model(
    prompt: str,
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker: CostTracker | None = None,
    max_output_tokens: int | None = None,
) -> str:
    """Send one prompt to the Responses API and return the output text.

    Records usage on the cost tracker when provided. Raises CloudCallError-free
    exceptions; callers wrap failures in CloudCallError for stage context.
    """
    api_key = get_api_key()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    client = openai.OpenAI(api_key=api_key)
    kwargs = {"model": model, "input": prompt}
    if reasoning_effort and is_reasoning_model(model):
        kwargs["reasoning"] = {"effort": reasoning_effort}
    if max_output_tokens:
        kwargs["max_output_tokens"] = max_output_tokens

    response = client.responses.create(**kwargs)
    output_text = getattr(response, "output_text", "")
    if not output_text and hasattr(response, "output"):
        output_text = str(response.output)

    if cost_tracker:
        usage = getattr(response, "usage", None)
        p_tokens = (
            (getattr(usage, "input_tokens", None) or getattr(usage, "prompt_tokens", None))
            if usage
            else None
        )
        c_tokens = (
            (getattr(usage, "output_tokens", None) or getattr(usage, "completion_tokens", None))
            if usage
            else None
        )
        cost_tracker.record_usage(
            prompt_tokens=p_tokens,
            completion_tokens=c_tokens,
            prompt_text=prompt,
            completion_text=output_text,
            model=model,
        )

    return output_text


def check_openai_key(model: str = "gpt-4o-mini") -> dict:
    """Run one minimal live call to verify the configured key works.

    Sends only the fixed phrase below — never topic, watchlist, or evidence.
    Returns a report dict; raises the underlying API error on failure.
    """
    prompt = "Reply with the single word: ready"
    client = openai.OpenAI(api_key=get_api_key())
    response = client.responses.create(model=model, input=prompt, max_output_tokens=200)
    output_text = (getattr(response, "output_text", "") or "").strip()
    usage = getattr(response, "usage", None)
    p_tokens = (
        (getattr(usage, "input_tokens", None) or getattr(usage, "prompt_tokens", None))
        if usage
        else 0
    ) or 0
    c_tokens = (
        (getattr(usage, "output_tokens", None) or getattr(usage, "completion_tokens", None))
        if usage
        else 0
    ) or 0
    est_cost = (p_tokens / 1_000_000 * 0.15) + (c_tokens / 1_000_000 * 0.60)
    return {
        "ok": True,
        "model": model,
        "output_text": output_text,
        "prompt_tokens": int(p_tokens),
        "completion_tokens": int(c_tokens),
        "estimated_cost_usd": round(est_cost, 6),
    }
