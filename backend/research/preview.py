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
WARN_PLAN_CONCEALED = "chaffed prompt (real topic hidden among decoy topics) leaves the machine for planning; extraction keeps only the real block; small spend"
WARN_GAP_ROUNDS = "coverage re-checks run {n}x while evidence arrives; rounds 2+ stay local"
WARN_DURATION_MIN = "run budget {m:.0f} min — beyond the ~30 min provider cap; the frontier keeps following citations"
WARN_SUMMARY = "redacted excerpts leave the machine for a sourced brief; spend scales with corpus"
WARN_SPEND = "hard spend ceiling ${cap:.2f}; run downgrades to local synthesis if the cap is hit"
WARN_CHUNK = "long documents split into focused passages for rerank and synthesis"
WARN_RERANK = "top {n} candidates reranked locally before synthesis (no extra egress)"
WARN_CITES = "citation edges followed from top academic hits (references + cited-by)"
WARN_GRAPH = "frontier scored by concept overlap with collected evidence"
WARN_REWRITE = "local query variants widen coverage (no egress)"
WARN_HYDE = "HyDE draft queries from the concealer model"
WARN_HYDE_CONCEALED = "HyDE draft queries from the chaffed concealer prompt (process hidden)"
WARN_VERIFY = "claims cross-checked across sources before the brief (local-only)"
WARN_INDEPENDENCE = "near-duplicate and syndicated sources grouped into families; corroboration counts independent families, not copies"


def preview(topic: str, options: SearchOptions) -> SearchPreview:
    """Build a SearchPreview from options. Caps are stated in outcome terms."""
    duration_sec = float(options.max_duration_min) * 60.0
    warnings = [
        WARN_DEPTH.format(n=options.max_depth),
        WARN_DOCS.format(n=options.max_documents),
        WARN_DURATION.format(n=duration_sec),
    ]
    if options.max_duration_min > 30:
        warnings.append(WARN_DURATION_MIN.format(m=float(options.max_duration_min)))
    if options.max_gap_rounds > 0:
        warnings.append(WARN_GAP_ROUNDS.format(n=options.max_gap_rounds))
    if options.chunk_documents:
        warnings.append(WARN_CHUNK)
    if options.rerank_results:
        warnings.append(WARN_RERANK.format(n=options.rerank_keep))
    if options.citation_expansion:
        warnings.append(WARN_CITES)
    if options.graph_prioritization:
        warnings.append(WARN_GRAPH)
    if options.query_rewrite:
        warnings.append(WARN_REWRITE)
    if options.hyde_queries and options.ai_planning:
        warnings.append(WARN_HYDE_CONCEALED if options.conceal_process else WARN_HYDE)
    if options.claim_verification:
        warnings.append(WARN_VERIFY)
        warnings.append(WARN_INDEPENDENCE)
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
        warnings.append(WARN_PLAN_CONCEALED if options.conceal_process else WARN_PLAN)
    if options.ai_summary:
        warnings.append(WARN_SUMMARY)
    if options.ai_planning or options.ai_summary:
        spend = _estimate_ai_spend(topic, options)
        display = f"~${spend:.4f} USD" if spend < 0.01 else f"~${spend:.3f} USD"
        warnings.append(WARN_SPEND.format(cap=options.max_spend_usd))

    return SearchPreview(
        expected_hops=options.max_depth,
        expected_sources=options.max_documents,
        expected_duration_sec=duration_sec,
        expected_spend_usd=round(spend, 5),
        expected_cost_display=display,
        warnings=warnings,
        requires_confirm=bool(options.blind_watchlist or options.decoy_queries > 0),
    )


def _estimate_ai_spend(topic: str, options: SearchOptions) -> float:
    """Estimate spend: concealer (cheap) for planning + round-1 gaps, deep for summary."""
    topic_tokens = max(1, math.ceil(len(topic) / 4))

    total = 0.0
    if options.ai_planning:
        concealer = CostTracker(model=options.concealer_model, max_spend_usd=options.max_spend_usd)
        is_reasoning = any(k in options.concealer_model.lower() for k in ("o1", "o3", "o4"))
        # Chaffed 8-topic prompt + 8-topic response block.
        p_tok = 900 + topic_tokens if options.conceal_process else 250 + topic_tokens
        c_tok = 700 if options.conceal_process else 200
        # Round-1 gap analysis sends redacted snippets of ~6 sources once.
        p_tok += 1200
        c_tok += 150
        if is_reasoning:
            c_tok += {"low": 1000, "medium": 3000, "high": 8000}.get(
                options.reasoning_effort or "medium", 3000
            )
        total += concealer.estimate_cost(
            prompt_tokens=p_tok, completion_tokens=c_tok, model=options.concealer_model
        )

    if options.ai_summary:
        deep = CostTracker(model=options.deep_model, max_spend_usd=options.max_spend_usd)
        is_reasoning = any(k in options.deep_model.lower() for k in ("o1", "o3", "o4"))
        docs_in_prompt = min(options.max_documents, 40)
        p_tok = 500 + topic_tokens + docs_in_prompt * 320
        c_tok = 800
        if is_reasoning:
            c_tok += {"low": 2000, "medium": 6000, "high": 16000}.get(
                options.reasoning_effort or "medium", 6000
            )
        total += deep.estimate_cost(
            prompt_tokens=p_tok, completion_tokens=c_tok, model=options.deep_model
        )

    return total
