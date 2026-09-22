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
    """Return the topic as the first real query, optional AI angles, then decoys."""
    from backend.research.cloud_errors import CloudCallError

    real: list[Query] = [Query(text=topic, is_decoy=False)]

    if options.ai_planning:
        import os
        if not os.environ.get("OPENAI_API_KEY", "").strip() and progress_callback:
            progress_callback("No OpenAI key. Searching the topic as written.")
        try:
            expanded = expand_topic_queries(
                topic,
                watchlist,
                model=options.model,
                reasoning_effort=options.reasoning_effort,
                cost_tracker=cost_tracker,
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

    decoys: list[Query] = []
    if options.decoy_queries > 0:
        generated = generate_statistical_decoys(topic, k=options.decoy_queries)
        for decoy_text in generated:
            if not decoy_text or decoy_text == topic:
                continue
            decoys.append(Query(text=decoy_text, is_decoy=True))

    return real + decoys
