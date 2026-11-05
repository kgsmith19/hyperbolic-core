"""Shared OpenAI Responses API client for planning, gap analysis, and synthesis.

One place for client construction, reasoning-effort routing, output extraction,
and token/cost accounting so every cloud call behaves identically.
"""

import os
from typing import Any

import openai

from backend.research.cost_estimator import CostTracker


def _load_env_file():
    env_path = os.path.join(os.getcwd(), ".env")
    if not os.path.exists(env_path):
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        k, v = line.split("=", 1)
                        k, v = k.strip(), v.strip()
                        if k and v and not os.environ.get(k):
                            os.environ[k] = v
        except Exception:
            pass

_load_env_file()


def get_api_key(model: str | None = "gpt-4o-mini") -> str:
    """Return the configured API key for the given model, or "" when absent."""
    lowered = (model or "").lower()
    if lowered.startswith("claude"):
        return os.environ.get("ANTHROPIC_API_KEY", "").strip()
    elif lowered.startswith("gemini"):
        return (os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")).strip()
    return os.environ.get("OPENAI_API_KEY", "").strip()


def has_api_key(model: str | None = "gpt-4o-mini") -> bool:
    return bool(get_api_key(model))


def is_reasoning_model(model: str | None) -> bool:
    """Models that accept a reasoning-effort parameter on the Responses API."""
    lowered = (model or "").lower()
    return any(k in lowered for k in ("o1", "o3", "o4", "gpt-5"))


def invoke_model(
    prompt: str,
    model: str | None = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker: CostTracker | None = None,
    max_output_tokens: int | None = None,
) -> str:
    """Send one prompt to the appropriate model API (OpenAI, Anthropic, or Google) and return the output text."""
    lowered = (model or "").lower()
    if lowered.startswith("claude"):
        return _invoke_anthropic(prompt, model, cost_tracker, max_output_tokens)
    elif lowered.startswith("gemini"):
        return _invoke_google(prompt, model, cost_tracker, max_output_tokens)

    api_key = get_api_key(model)
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    client = openai.OpenAI(api_key=api_key)
    kwargs: dict[str, Any] = {"model": model, "input": prompt}
    if reasoning_effort and is_reasoning_model(model):
        kwargs["reasoning"] = {"effort": reasoning_effort}
    if max_output_tokens:
        kwargs["max_output_tokens"] = max_output_tokens

    response = client.responses.create(**kwargs)
    output_text = _extract_output_text(response)

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


def _invoke_anthropic(prompt: str, model: str | None, cost_tracker: CostTracker | None = None, max_output_tokens: int | None = None) -> str:
    import anthropic
    api_key = get_api_key(model)
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model or "",
        max_tokens=max_output_tokens or 2048,
        messages=[{"role": "user", "content": prompt}]
    )
    texts = (getattr(block, "text", None) for block in response.content)
    output_text = "".join(text for text in texts if isinstance(text, str))
    if cost_tracker:
        usage = getattr(response, "usage", None)
        p_tokens = getattr(usage, "input_tokens", 0) if usage else 0
        c_tokens = getattr(usage, "output_tokens", 0) if usage else 0
        cost_tracker.record_usage(
            prompt_tokens=p_tokens,
            completion_tokens=c_tokens,
            prompt_text=prompt,
            completion_text=output_text,
            model=model,
        )
    return output_text


def _invoke_google(prompt: str, model: str | None, cost_tracker: CostTracker | None = None, max_output_tokens: int | None = None) -> str:
    import urllib.request
    import json
    api_key = get_api_key(model)
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY is not configured")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": max_output_tokens or 2048}
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    output_text = ""
    try:
        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            output_text = "".join(p.get("text", "") for p in parts)
    except Exception:
        pass
    if cost_tracker:
        usage = data.get("usageMetadata", {})
        p_tokens = usage.get("promptTokenCount", 0)
        c_tokens = usage.get("candidatesTokenCount", 0)
        cost_tracker.record_usage(
            prompt_tokens=p_tokens,
            completion_tokens=c_tokens,
            prompt_text=prompt,
            completion_text=output_text,
            model=model,
        )
    return output_text


def _extract_output_text(response) -> str:
    """Extract assistant message text from a Responses API response.

    The SDK's `output_text` convenience property is reliable for plain
    text models but can come back empty for reasoning models (gpt-5, o3,
    o4), whose `output` list leads with a reasoning item carrying an
    encrypted blob. The old fallback `str(response.output)` stringified
    that raw blob straight into the user-visible brief. Instead, walk the
    output items and concatenate only message content text parts.
    """
    text = getattr(response, "output_text", "") or ""
    if text:
        return text
    parts: list[str] = []
    try:
        for item in getattr(response, "output", None) or []:
            if getattr(item, "type", None) != "message":
                continue
            for block in getattr(item, "content", None) or []:
                if getattr(block, "type", None) in ("output_text", "text"):
                    chunk = getattr(block, "text", "") or ""
                    if chunk:
                        parts.append(chunk)
    except Exception:
        pass
    return "\n".join(parts)


def check_openai_key(model: str = "gpt-4o-mini") -> dict:
    """Run one minimal live call to verify the configured key works.

    Sends only the fixed phrase below — never topic, watchlist, or evidence.
    Returns a report dict; raises the underlying API error on failure.
    """
    prompt = "Reply with the single word: ready"
    client = openai.OpenAI(api_key=get_api_key())
    response = client.responses.create(model=model, input=prompt, max_output_tokens=200)
    output_text = _extract_output_text(response).strip()
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
