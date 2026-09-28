"""Query planner: real angles plus tagged statistical decoys."""

from backend.research.query_planner import expand_topic_queries
from backend.research.types import Query, SearchOptions
from backend.privacy.statistical_chaffer import generate_statistical_decoys


def plan_queries(
    topic: str,
    watchlist: list[str],
    options: SearchOptions,
    cost_tracker=None,
    progress_callback=None,
) -> list[Query]:
    """Return the topic as the first real query, optional AI angles, then decoys.

    When ai_planning is on, expansion runs through conceal_process: the chaffed
    multi-topic prompt (default, process hidden from the frontier model) or the
    bare topic (conceal_process=False, better relevance). Decoy search queries
    are orthogonal to this: they are tagged is_decoy and discarded before
    ranking regardless of the concealment path.
    """
    from backend.research.cloud_errors import CloudCallError

    real: list[Query] = [Query(text=topic, is_decoy=False)]

    # Query rewriting: local multiquery variants ALWAYS run (no egress),
    # so even keyless runs get wider coverage than the bare topic.
    if options.query_rewrite:
        try:
            from backend.research.query_rewriter import multiquery_variants
            for variant in multiquery_variants(topic, watchlist):
                if variant != topic and not any(q.text == variant for q in real):
                    real.append(Query(text=variant, is_decoy=False))
        except Exception:
            pass

    if options.ai_planning:
        import os
        if not os.environ.get("OPENAI_API_KEY", "").strip() and progress_callback:
            progress_callback("No OpenAI key. Searching the topic as written.")
        try:
            expanded = expand_topic_queries(
                topic,
                watchlist,
                model=options.concealer_model,
                reasoning_effort=options.reasoning_effort,
                cost_tracker=cost_tracker,
                conceal_process=options.conceal_process,
            )
        except CloudCallError as err:
            if progress_callback:
                progress_callback(
                    f"AI planning failed ({err.cause_type}). Searching the topic as written."
                )
            expanded = [topic]
        for line in expanded:
            clean = (line or "").strip()
            if not clean or clean == topic:
                continue
            if any(q.text == clean for q in real):
                continue
            real.append(Query(text=clean, is_decoy=False))

        # HyDE draft queries: hypothetical-answer content words become extra
        # angles (concealer model, chaffed when conceal_process is on).
        if options.hyde_queries:
            try:
                from backend.research.query_rewriter import hyde_draft_queries
                from backend.research.cloud_errors import CloudCallError as _CCE
                try:
                    hyde_qs = hyde_draft_queries(
                        topic, watchlist,
                        model=options.concealer_model,
                        reasoning_effort=options.reasoning_effort,
                        cost_tracker=cost_tracker,
                        conceal_process=options.conceal_process,
                    )
                except _CCE as herr:
                    if progress_callback:
                        progress_callback(f"HyDE expansion failed ({herr.cause_type}). Continuing.")
                    hyde_qs = []
                for hq in hyde_qs:
                    if hq != topic and not any(q.text == hq for q in real):
                        real.append(Query(text=hq, is_decoy=False))
            except Exception:
                pass

    decoys: list[Query] = []
    if options.decoy_queries > 0:
        generated = generate_statistical_decoys(topic, k=options.decoy_queries)
        for decoy_text in generated:
            if not decoy_text or decoy_text == topic:
                continue
            decoys.append(Query(text=decoy_text, is_decoy=True))

    return real + decoys
