"""Query Rewriting for retrieval (HyDE-lite + multiquery, local-first).

Two complementary rewrites, both privacy-preserving by construction:

1. multiquery: split one user topic into focused sub-queries (keyword-style
   variants, question forms, entity expansions). Pure local transforms, no
   egress. Runs always.
2. hyde_draft: ask the concealer model for a short hypothetical answer
   passage, then search with content words from that draft. This is the
   HyDE dense-retrieval pattern from the research: embedding similarity
   works better answer-to-answer than question-to-answer. Only runs when
   ai_planning is on (it costs one cheap model call) and honors
   conceal_process (the draft prompt is chaffed like planning prompts).

Both return plain query strings; the planner tags them as real queries.
"""

import re

from backend.privacy.watchlist_redactor import redact, assert_safe_to_send, SafetyError


def _content_words(text: str, watchlist: list[str]) -> list[str]:
    stop = frozenset({
        "the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with",
        "at", "by", "from", "is", "are", "was", "were", "what", "how", "why",
        "which", "that", "this", "these", "those", "its", "into", "about",
        "best", "current", "latest", "techniques", "methods", "ways", "make",
        "tool", "tools", "use", "using", "used",
    })
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z\-]{2,}", text.lower()) if w not in stop]
    seen, out = set(), []
    for w in words:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out


def multiquery_variants(topic: str, watchlist: list[str], max_variants: int = 3) -> list[str]:
    """Generate local keyword-style query variants of the topic (no egress)."""
    assert_safe_to_send(topic, watchlist)
    words = _content_words(topic, watchlist)
    if len(words) < 3:
        return []
    variants: list[str] = []
    core = " ".join(words[:6])
    candidates = [
        core,
        f"{' '.join(words[:3])} review",
        f"{' '.join(words[1:5])} analysis",
        f"{' '.join(words[:4])} latest findings",
    ]
    for cand in candidates:
        clean = redact(cand.strip(), watchlist)
        if not clean or clean == topic or clean in variants:
            continue
        try:
            assert_safe_to_send(clean, watchlist)
        except SafetyError:
            continue
        variants.append(clean)
        if len(variants) >= max_variants:
            break
    return variants


def hyde_draft_queries(
    topic: str,
    watchlist: list[str],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None,
    conceal_process: bool = True,
    max_queries: int = 2,
) -> list[str]:
    """Generate HyDE-style search queries from a hypothetical answer draft.

    Asks the concealer model for a 3-sentence hypothetical answer, then turns
    content words of that draft into search queries. Raises CloudCallError on
    API failure so callers fall back to multiquery variants.
    """
    assert_safe_to_send(topic, watchlist)
    from backend.research.cloud_client import get_api_key, invoke_model

    if not get_api_key():
        return []

    if conceal_process:
        prompt = (
            "For each of the research topics below, write a 2-sentence hypothetical "
            "answer passage. Format strictly with Topic {N} headers.\n\n"
            f"Topic 1: deep ocean hydrothermal vent microbial metabolism\n"
            f"Topic 2: {topic}\n"
            f"Topic 3: precision agricultural drone multispectral imaging"
        )
        target_idx = 2
    else:
        prompt = (
            "Write a 3-sentence hypothetical answer passage for the research topic "
            f"below (it may be partially inaccurate; focus on key terms).\n\nTopic: {topic}"
        )
        target_idx = 0
    assert_safe_to_send(prompt, watchlist)

    try:
        output = invoke_model(
            prompt, model=model, reasoning_effort=reasoning_effort,
            cost_tracker=cost_tracker, max_output_tokens=400,
        )
    except Exception as err:
        from backend.research.cloud_errors import CloudCallError
        raise CloudCallError("hyde", err) from err

    if target_idx:
        try:
            from backend.privacy.statistical_chaffer import extract_chaffed_response
            lines = [ln for ln in extract_chaffed_response(output, target_idx) if ln]
            output = " ".join(lines)
        except Exception:
            pass

    words = _content_words(redact(output, watchlist), watchlist)
    queries: list[str] = []
    for size in (6, 5):
        if len(words) >= size:
            cand = " ".join(words[:size])
            try:
                assert_safe_to_send(cand, watchlist)
            except SafetyError:
                continue
            if cand and cand != topic and cand not in queries:
                queries.append(cand)
        if len(queries) >= max_queries:
            break
    return queries[:max_queries]
