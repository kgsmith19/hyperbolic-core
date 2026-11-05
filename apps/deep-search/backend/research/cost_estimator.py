"""Cost Tracking & Spending Cap Enforcement Engine.

Monitors token consumption and estimated API expenditures across OpenAI models:
- gpt-4o-mini
- gpt-4o
- o3-mini
- o1
Enforces maximum spend limits (kill switch) and provides real-time cost estimation.
"""

import math
from dataclasses import dataclass


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
    "o4-mini": {"input": 1.10, "output": 4.40},
    "gpt-4.1": {"input": 2.00, "output": 8.00},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
    "gpt-4.1-nano": {"input": 0.10, "output": 0.40},
    "o1": {"input": 15.00, "output": 60.00},
    "o1-pro": {"input": 150.00, "output": 600.00},
    "gpt-4.5": {"input": 75.00, "output": 150.00},
    # Anthropic Tier
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00},
    "claude-3-5-sonnet-20241022": {"input": 3.00, "output": 15.00},
    "claude-3-5-haiku": {"input": 0.80, "output": 4.00},
    "claude-3-5-haiku-20241022": {"input": 0.80, "output": 4.00},
    "claude-3-opus": {"input": 15.00, "output": 75.00},
    "claude-3-opus-20240229": {"input": 15.00, "output": 75.00},
    # Google Gemini Tier
    "gemini-1.5-pro": {"input": 1.25, "output": 5.00},
    "gemini-1.5-flash": {"input": 0.075, "output": 0.30},
    "gemini-2.0-flash": {"input": 0.10, "output": 0.40},
}
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

    def __init__(self, model: str | None = "gpt-4o-mini", max_spend_usd: float = 2.00):
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
