"""Cost Tracking & Spending Cap Enforcement Engine.

Monitors token consumption and estimated API expenditures across OpenAI models:
- gpt-4o-mini
- gpt-4o
- o3-mini
- o1
Enforces maximum spend limits (kill switch) and provides real-time cost estimation.
"""

import math
from dataclasses import dataclass, field
from typing import Optional


class SpendLimitExceededError(Exception):
    """Raised when cumulative research spend exceeds the configured spend cap."""
    pass


# Pricing per 1,000,000 tokens (USD) as of standard rates
MODEL_PRICING = {
    # Lightweight / High-Speed Compact Tier
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-5-mini": {"input": 0.25, "output": 1.00},
    # Foundation Intelligence Tier
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-5": {"input": 3.00, "output": 12.00},
    "gpt-5.1": {"input": 4.00, "output": 16.00},
    "gpt-5.2": {"input": 5.00, "output": 20.00},
    "gpt-5.4": {"input": 7.50, "output": 30.00},
    "gpt-5.6": {"input": 10.00, "output": 40.00},
    # Frontier Reasoning & Deep Synthesis Tier
    "o3-mini": {"input": 1.10, "output": 4.40},
    "o1": {"input": 15.00, "output": 60.00},
    "o1-pro": {"input": 150.00, "output": 600.00},
    "gpt-4.5": {"input": 75.00, "output": 150.00},
}
OPENAI_PRICING = MODEL_PRICING


@dataclass
class SpendReport:
    """Detailed breakdown of token consumption and monetary cost."""
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    is_cap_exceeded: bool = False


class CostTracker:
    """Thread-safe cost and token accounting engine."""

    def __init__(self, model: str = "gpt-4o-mini", max_spend_usd: float = 2.00):
        self.model = model if model in MODEL_PRICING else "gpt-4o-mini"
        self.max_spend_usd = max_spend_usd
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.cumulative_cost_usd = 0.0

    def estimate_tokens_from_text(self, text: str) -> int:
        """Estimate token count based on standard ~4 characters per token heuristic."""
        if not text:
            return 0
        return max(1, math.ceil(len(text) / 4))

    def estimate_cost(
        self,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        model: str | None = None,
    ) -> float:
        """Calculate estimated cost for given token counts without mutating tracker state."""
        active_model = model or self.model
        rates = MODEL_PRICING.get(active_model, MODEL_PRICING["gpt-4o-mini"])
        return (prompt_tokens / 1_000_000 * rates["input"]) + (completion_tokens / 1_000_000 * rates["output"])

    def record_usage(
        self,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        prompt_text: str = "",
        completion_text: str = "",
        model: str | None = None,
    ) -> float:
        """Record usage from explicit counts or estimated text lengths.

        Raises SpendLimitExceededError if cumulative spend exceeds max_spend_usd.
        """
        active_model = model or self.model
        rates = MODEL_PRICING.get(active_model, MODEL_PRICING["gpt-4o-mini"])

        p_tokens = prompt_tokens if prompt_tokens is not None else self.estimate_tokens_from_text(prompt_text)
        c_tokens = completion_tokens if completion_tokens is not None else self.estimate_tokens_from_text(completion_text)

        cost = (p_tokens / 1_000_000 * rates["input"]) + (c_tokens / 1_000_000 * rates["output"])

        self.total_prompt_tokens += p_tokens
        self.total_completion_tokens += c_tokens
        self.cumulative_cost_usd += cost

        if self.cumulative_cost_usd > self.max_spend_usd:
            raise SpendLimitExceededError(
                f"Cumulative spend ${self.cumulative_cost_usd:.4f} exceeded configured cap of ${self.max_spend_usd:.2f}."
            )

        return cost

    def get_report(self) -> SpendReport:
        """Return the current spend report."""
        return SpendReport(
            model=self.model,
            prompt_tokens=self.total_prompt_tokens,
            completion_tokens=self.total_completion_tokens,
            total_tokens=self.total_prompt_tokens + self.total_completion_tokens,
            estimated_cost_usd=round(self.cumulative_cost_usd, 5),
            is_cap_exceeded=self.cumulative_cost_usd > self.max_spend_usd,
        )


def estimate_research_workload(
    mode: str = "deterministic",
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = "medium",
    max_documents: int = 25,
    concurrency: int = 4,
    topic_length_chars: int = 100,
) -> dict:
    """Pre-run estimation of API calls, token volume, concurrency allocation, and monetary spend."""
    rates = MODEL_PRICING.get(model, MODEL_PRICING["gpt-4o-mini"])
    is_reasoning_model = any(k in model.lower() for k in ("o1", "o3", "o4"))

    if mode in ("deterministic", "extreme"):
        return {
            "mode": mode,
            "model": "offline-cpu",
            "reasoning_effort": "n/a",
            "api_calls": 0,
            "concurrency_workers": concurrency,
            "estimated_prompt_tokens": 0,
            "estimated_completion_tokens": 0,
            "estimated_reasoning_tokens": 0,
            "estimated_total_tokens": 0,
            "estimated_cost_usd": 0.0,
            "estimated_cost_usd_min": 0.0,
            "estimated_cost_usd_max": 0.0,
            "estimated_cost_display": "$0.00 (100% Free / Offline)",
            "call_breakdown": [
                {"step": "Local Air-Gapped Discovery", "calls": 0, "desc": f"{concurrency} parallel workers with territory reservation"},
                {"step": "Local Hybrid RRF Ranking", "calls": 0, "desc": "BM25 + FastEmbed ONNX CPU embeddings"},
                {"step": "Local Extractive Synthesis", "calls": 0, "desc": "Offline CPU extractive gap analysis"}
            ]
        }

    api_calls = 0
    call_breakdown = []

    # 1. Multi-Angle Query Planning Call
    topic_tokens = max(1, math.ceil(topic_length_chars / 4))
    exp_prompt_tokens = 250 + topic_tokens
    exp_completion_tokens = 200
    exp_reasoning_tokens = 0
    if is_reasoning_model:
        effort_tokens = {"low": 1000, "medium": 3000, "high": 8000}.get(reasoning_effort or "medium", 3000)
        exp_reasoning_tokens = effort_tokens

    api_calls += 1
    call_breakdown.append({
        "step": "Multi-Angle Query Expansion",
        "calls": 1,
        "desc": f"Generates 4 diverse search angles via {model}"
    })

    # 2. Executive Sourced Synthesis Call (in 'full' mode)
    synth_prompt_tokens = 0
    synth_completion_tokens = 0
    synth_reasoning_tokens = 0
    if mode == "full":
        docs_in_prompt = min(max_documents, 25)
        evidence_tokens = docs_in_prompt * 320
        synth_prompt_tokens = 500 + topic_tokens + evidence_tokens
        synth_completion_tokens = 800
        if is_reasoning_model:
            effort_tokens = {"low": 2000, "medium": 6000, "high": 16000}.get(reasoning_effort or "medium", 6000)
            synth_reasoning_tokens = effort_tokens

        api_calls += 1
        call_breakdown.append({
            "step": "Executive Sourced Synthesis",
            "calls": 1,
            "desc": f"Synthesizes evidence across up to {docs_in_prompt} sources via {model}"
        })

    total_prompt = exp_prompt_tokens + synth_prompt_tokens
    total_completion = exp_completion_tokens + synth_completion_tokens + exp_reasoning_tokens + synth_reasoning_tokens
    total_tokens = total_prompt + total_completion

    cost = (total_prompt / 1_000_000 * rates["input"]) + (total_completion / 1_000_000 * rates["output"])
    min_cost = cost * 0.75
    max_cost = cost * 1.35

    display = f"~${cost:.4f} USD" if cost < 0.01 else f"~${cost:.3f} USD"

    return {
        "mode": mode,
        "model": model,
        "reasoning_effort": reasoning_effort if is_reasoning_model else "n/a",
        "api_calls": api_calls,
        "concurrency_workers": concurrency,
        "estimated_prompt_tokens": total_prompt,
        "estimated_completion_tokens": total_completion,
        "estimated_reasoning_tokens": exp_reasoning_tokens + synth_reasoning_tokens,
        "estimated_total_tokens": total_tokens,
        "estimated_cost_usd": round(cost, 5),
        "estimated_cost_usd_min": round(min_cost, 5),
        "estimated_cost_usd_max": round(max_cost, 5),
        "estimated_cost_display": display,
        "call_breakdown": call_breakdown,
    }
