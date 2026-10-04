"""Research Query Planning & Expansion Engine with Model Selection & Spend Tracking.

Expands research topics into multi-angle queries using blind LLM planning,
proposes mid-run follow-up queries from collected evidence (gap analysis),
and decoy-chaffed k-anonymity blinding, tracking token spend throughout.
"""

import re

from backend.privacy.watchlist_redactor import redact, assert_safe_to_send, SafetyError


def _parse_query_lines(output_text: str, watchlist: list[str], existing: list[str]) -> list[str]:
    """Split model output into clean, redacted, deduplicated query strings."""
    parsed: list[str] = []
    for line in output_text.splitlines():
        clean = line.strip()
        if not clean:
            continue
        clean = redact(clean, watchlist)
        clean = re.sub(r'^\s*(\d+[\.)]|\*|-)\s*', '', clean).strip(' "\'')
        if not clean or clean in existing or clean in parsed:
            continue
        try:
            assert_safe_to_send(clean, watchlist)
        except SafetyError:
            continue
        parsed.append(clean)
    return parsed


def expand_topic_queries(
    topic: str,
    watchlist: list[str],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None,
    conceal_process: bool = True,
    strictness: float = 0.9,
    force_direction: bool = True,
) -> list[str]:
    """Generate 3-4 diverse sub-queries for broad search using blind LLM planning.

    When conceal_process is True (default), the real topic is hidden inside a
    k-anonymity chaffed prompt of decoy topics so the frontier model never sees
    the bare research process; only the target block is extracted. When False,
    the bare topic is expanded directly (better relevance, no concealment).
    """
    assert_safe_to_send(topic, watchlist)
    from backend.research.cloud_client import get_api_key

    if not get_api_key(model):
        return [topic]

    try:
        if conceal_process:
            return _expand_topic_queries_chaffed(
                topic, watchlist, model, reasoning_effort, cost_tracker
            )
        return _expand_topic_queries_bare(
            topic, watchlist, model, reasoning_effort, cost_tracker,
            strictness=strictness, force_direction=force_direction,
        )
    except Exception as err:
        from backend.research.cloud_errors import CloudCallError
        if isinstance(err, CloudCallError):
            raise
        raise CloudCallError("planning", err) from err


def _expand_topic_queries_bare(
    topic: str,
    watchlist: list[str],
    model: str,
    reasoning_effort: str | None,
    cost_tracker,
    strictness: float = 0.9,
    force_direction: bool = True,
) -> list[str]:
    """Expand the bare topic directly (no process concealment)."""
    from backend.research.cloud_client import invoke_model

    direction_note = ""
    if force_direction:
        direction_note = (
            f" Maintain strict adherence to the exact direction and scope of the topic "
            f"without assuming an alternative topic is what is sought."
        )

    prompt = (
        f"Generate 3 to 4 distinct, highly specific search queries to thoroughly research the public topic below.{direction_note}\n"
        f"Topic: {topic}\n\n"
        f"Output only one search query per line. Do not number or bullet the lines."
    )
    assert_safe_to_send(prompt, watchlist)

    output_text = invoke_model(
        prompt,
        model=model,
        reasoning_effort=reasoning_effort,
        cost_tracker=cost_tracker,
        max_output_tokens=300,
    )
    return [topic, *_parse_query_lines(output_text, watchlist, [topic])][:4]


def _expand_topic_queries_chaffed(
    topic: str,
    watchlist: list[str],
    model: str,
    reasoning_effort: str | None,
    cost_tracker,
    decoy_count: int = 7,
) -> list[str]:
    """Expand the topic inside a chaffed multi-topic prompt (process concealed).

    Seven decoy topics around the real one: deep-search scale concealment
    beyond the 3-decoy default, so a reviewer of the prompt cannot tell
    which of the eight topics is the real research target.
    """
    from backend.privacy.statistical_chaffer import (
        generate_chaffed_prompt,
        extract_chaffed_response,
    )

    chaffed_prompt, target_idx = generate_chaffed_prompt(topic, k=decoy_count)
    assert_safe_to_send(chaffed_prompt, watchlist)
    from backend.research.cloud_client import invoke_model

    output_text = invoke_model(
        chaffed_prompt,
        model=model,
        reasoning_effort=reasoning_effort,
        cost_tracker=cost_tracker,
        max_output_tokens=1600,
    )
    extracted = [
        line for line in extract_chaffed_response(output_text, target_idx) if line
    ]
    queries = [topic]
    for line in extracted:
        clean = redact(line, watchlist).strip(' "\'')
        if not clean or clean in queries:
            continue
        try:
            assert_safe_to_send(clean, watchlist)
        except SafetyError:
            continue
        queries.append(clean)
    return queries[:4]


def propose_gap_queries(
    topic: str,
    watchlist: list[str],
    evidence: list[dict],
    model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    cost_tracker=None,
    max_queries: int = 3,
    conceal_process: bool = True,
) -> list[str]:
    """Propose follow-up queries covering angles missing from collected evidence.

    Hide mode (conceal_process=True): the real topic and its sources sit
    among decoy topics so the model cannot tell which coverage check is
    the real one; only the target block is extracted.
    Show mode: send the bare topic and redacted snippets.
    Watchlist terms never leave in either mode.
    """
    assert_safe_to_send(topic, watchlist)
    from backend.research.cloud_client import get_api_key, invoke_model

    if not get_api_key():
        return []

    gathered_blocks = []
    for idx, item in enumerate(evidence[:6], start=1):
        title = redact(item.get("title", ""), watchlist)
        snippet = redact((item.get("snippet", "") or item.get("excerpt", ""))[:300], watchlist)
        gathered_blocks.append(f"{idx}. {title}: {snippet}")
    gathered_text = "\n".join(gathered_blocks) if gathered_blocks else "(nothing gathered yet)"

    if conceal_process:
        prompt = (
            "For each topic below, identify up to "
            f"{max_queries} missing research angles and output one search query "
            "per line under a Topic {{N}} header. If coverage is thorough, output nothing.\n\n"
            "Topic 1: deep ocean hydrothermal vent microbial metabolism\n"
            "Sources: (nothing gathered yet)\n\n"
            f"Topic 2: {topic}\n"
            f"Sources gathered so far:\n{gathered_text}\n\n"
            "Topic 3: precision agricultural drone multispectral imaging\n"
            "Sources: (nothing gathered yet)\n"
        )
        target_idx = 2
    else:
        prompt = (
            f"You are a research coordinator. The topic below was searched and the listed "
            f"sources were gathered. Identify up to {max_queries} important angles that are "
            f"missing or under-covered, and output one specific search query per line for each "
            f"missing angle. If coverage is already thorough, output fewer lines or none.\n\n"
            f"Topic: {topic}\n\n"
            f"Sources gathered so far:\n{gathered_text}\n\n"
            f"Output only one search query per line. Do not number or bullet the lines."
        )
        target_idx = 0
    assert_safe_to_send(prompt, watchlist)

    try:
        output_text = invoke_model(
            prompt,
            model=model,
            reasoning_effort=reasoning_effort,
            cost_tracker=cost_tracker,
            max_output_tokens=300,
        )
        if target_idx:
            from backend.privacy.statistical_chaffer import extract_chaffed_response
            lines = [ln for ln in extract_chaffed_response(output_text, target_idx) if ln]
            return _parse_query_lines("\n".join(lines), watchlist, [topic])[:max_queries]
        return _parse_query_lines(output_text, watchlist, [topic])[:max_queries]
    except Exception as err:
        from backend.research.cloud_errors import CloudCallError
        raise CloudCallError("gap-analysis", err) from err
