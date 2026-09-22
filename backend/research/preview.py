"""Canonical tradeoff copy and pre-run search preview."""

import math

from backend.research.cost_estimator import CostTracker
from backend.research.types import SearchOptions, SearchPreview

WARN_DEPTH = "stops at hop {n}; sources past hop {n} are never discovered"
WARN_DOCS = "stops at ~{n} sources; deeper sources beyond that are discarded"
WARN_DURATION = "hard stop at {n:.0f}s; unfinished hops are dropped"
WARN_CONCURRENCY = "higher concurrency speeds hops but bot-blocks can stall depth"
WARN_BLIND = "watchlist terms never leave the machine; engines see placeholders — weaker recall"
WARN_DECOYS = "{k} decoy searches run for real and yield no evidence (~{pct}% of query time serves decoys)"
WARN_PLAN = "topic leaves the machine for query planning; small spend"
WARN_SUMMARY = "redacted excerpts leave the machine for a sourced brief; spend scales with corpus"
WARN_SPEND = "hard spend ceiling ${cap:.2f}; run downgrades to local synthesis if the cap is hit"


def preview(topic: str, options: SearchOptions) -> SearchPreview:
    """Build a SearchPreview from options. Caps are stated in outcome terms."""
    warnings = [
        WARN_DEPTH.format(n=options.max_depth),
        WARN_DOCS.format(n=options.max_documents),
        WARN_DURATION.format(n=options.max_duration_sec),
    ]
    if options.concurrency > 4:
        warnings.append(WARN_CONCURRENCY)
    if options.blind_watchlist:
        warnings.append(WARN_BLIND)
    if options.decoy_queries > 0:
        k = options.decoy_queries
        pct = int(round(100 * k / (k + 1)))
        warnings.append(WARN_DECOYS.format(k=k, pct=pct))

    spend = 0.0
    display = "$0.00 (100% Free / Offline)"
    if options.ai_planning:
        warnings.append(WARN_PLAN)
    if options.ai_summary:
        warnings.append(WARN_SUMMARY)
    if options.ai_planning or options.ai_summary:
        spend = _estimate_ai_spend(topic, options)
        display = f"~${spend:.4f} USD" if spend < 0.01 else f"~${spend:.3f} USD"
        warnings.append(WARN_SPEND.format(cap=options.max_spend_usd))

    return SearchPreview(
        expected_hops=options.max_depth,
        expected_sources=options.max_documents,
        expected_duration_sec=options.max_duration_sec,
        expected_spend_usd=round(spend, 5),
        expected_cost_display=display,
        warnings=warnings,
        requires_confirm=bool(options.blind_watchlist or options.decoy_queries > 0),
    )


def _estimate_ai_spend(topic: str, options: SearchOptions) -> float:
    """Reuse CostTracker heuristics for planning and optional summary calls."""
    tracker = CostTracker(model=options.model, max_spend_usd=options.max_spend_usd)
    topic_tokens = max(1, math.ceil(len(topic) / 4))
    is_reasoning_model = any(k in options.model.lower() for k in ("o1", "o3", "o4"))

    prompt_tokens = 0
    completion_tokens = 0

    if options.ai_planning:
        prompt_tokens += 250 + topic_tokens
        completion_tokens += 200
        if is_reasoning_model:
            completion_tokens += {"low": 1000, "medium": 3000, "high": 8000}.get(
                options.reasoning_effort or "medium", 3000
            )

    if options.ai_summary:
        docs_in_prompt = min(options.max_documents, 25)
        prompt_tokens += 500 + topic_tokens + docs_in_prompt * 320
        completion_tokens += 800
        if is_reasoning_model:
            completion_tokens += {"low": 2000, "medium": 6000, "high": 16000}.get(
                options.reasoning_effort or "medium", 6000
            )

    return tracker.estimate_cost(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        model=options.model,
    )
