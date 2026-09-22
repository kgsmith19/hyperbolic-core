"""End-to-End Deep Research Orchestrator with Concurrency, Spending Caps & Depth Controls.

Orchestrates the entire deep research lifecycle:
1. Air-gap enforcement & token pseudonymization
2. Model-selected query expansion and k-anonymity chaffing with spend tracking
3. Concurrent multi-hop frontier exploration with non-overlapping territory reservation
4. SHA-256 content deduplication and anti-bot barrier filtering
5. Local SLM gap analysis
6. Hybrid BM25 + ONNX Dense Vector RRF ranking
7. Sourced summary synthesis with optional reasoning models (o1, o3-mini, gpt-4o)
8. Markdown report archiving into reports/ with metadata headers
"""

import concurrent.futures
from datetime import datetime
import os
import re
import time
import urllib.parse

from backend.security_guard.socket_airgap import enforce_secret_core_socket_block
from backend.security_guard.token_blinder import create_blinder, blind_text
from backend.security_guard.watchlist_redactor import assert_safe_to_send, redact
from backend.discovery_frontier.priority_frontier import ResearchFrontier
from backend.discovery_frontier.url_canonicalizer import canonicalize_url
from backend.retrieval_engine.collector_client import get_collector
from backend.retrieval_engine.bot_barrier_detector import is_bot_or_js_barrier
from backend.relevance_ranking.hybrid_ranker import rank_items
from backend.synthesis_intelligence.local_synthesizer import LocalSLMEngine
from backend.synthesis_intelligence.openai_synthesizer import summarize_with_openai
from backend.synthesis_intelligence.report_generator import write_report
from backend.research_orchestrator.query_planner import expand_topic_queries, expand_topic_queries_chaffed
from backend.research_orchestrator.cost_estimator import CostTracker, SpendLimitExceededError
from backend.research_orchestrator.cancellation import cancellation_manager


def run_research(
    topic: str,
    watchlist: list[str],
    mode: str = "deterministic",
    max_depth: int = 2,
    max_documents: int = 15,
    max_duration_sec: float = 120.0,
    max_per_domain: int = 4,
    concurrency: int = 4,
    openai_model: str = "gpt-4o-mini",
    reasoning_effort: str | None = None,
    max_spend_usd: float = 2.00,
    run_id: str = "default",
    progress_callback=None
) -> dict:
    """Execute bounded multi-hop deep research with concurrency and spend controls."""
    start_time = time.time()
    collector = get_collector()
    cost_tracker = CostTracker(model=openai_model, max_spend_usd=max_spend_usd)
    cancel_token = cancellation_manager.create_token(run_id)

    forward_map = {}
    reverse_map = {}
    effective_topic = topic

    if mode in ("expansion", "full"):
        enforce_secret_core_socket_block(allow_openai=True)
    else:
        enforce_secret_core_socket_block(allow_openai=False)

    if mode == "extreme":
        if progress_callback:
            progress_callback("Applying local token blinder (pseudonymizing sensitive terms)...")
        forward_map, reverse_map = create_blinder(watchlist)
        effective_topic = blind_text(topic, forward_map)
    else:
        if progress_callback:
            progress_callback("Validating input against local safety guard...")
        assert_safe_to_send(topic, watchlist)

    if cancel_token.is_set():
        return _build_response("cancelled", topic, mode, [], [], "", "", "", cost_tracker, time.time() - start_time)

    queries = [effective_topic]

    if mode in ("expansion", "full"):
        if progress_callback:
            progress_callback("Expanding search queries with blind AI planner...")
        try:
            queries = expand_topic_queries(
                effective_topic,
                watchlist,
                model=openai_model,
                reasoning_effort=reasoning_effort,
                cost_tracker=cost_tracker,
            )
        except SpendLimitExceededError:
            queries = [effective_topic]

    frontier = ResearchFrontier(
        max_depth=max_depth,
        max_documents=max_documents,
        max_per_domain=max_per_domain,
        max_duration_sec=max_duration_sec,
    )

    if progress_callback:
        progress_callback(f"Seeding frontier across {len(queries)} query angle(s) and deep web connectors...")

    # Round 0: Dispatch initial query searches concurrently without duplicate queries
    initial_search_results = []
    worker_count = min(max(1, concurrency), len(queries))

    def _execute_search(q: str):
        task = {
            "task_id": f"search-{int(time.time() * 1000)}",
            "action": "search",
            "connector": "all",
            "query": q
        }
        return collector.send_task(task, watchlist)

    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(_execute_search, q) for q in queries]
        for f in concurrent.futures.as_completed(futures):
            if cancel_token.is_set():
                break
            try:
                resp = f.result()
                if resp.get("status") == "ok":
                    initial_search_results.extend(resp.get("results", []))
            except Exception:
                pass

    # Add initial search findings to frontier queue
    for item in initial_search_results:
        raw_url = item.get("url", "")
        can_url = canonicalize_url(raw_url)
        if can_url:
            frontier.add_candidate(
                url=can_url,
                doi=item.get("doi", ""),
                depth=0,
                priority=50.0,
                source_url="initial_search"
            )

    collected_evidence = []
    current_depth = 0

    def _fetch_single_item(frontier_item):
        """Fetch candidate webpage via collector."""
        task = {
            "task_id": f"fetch-{int(time.time() * 1000)}",
            "action": "fetch",
            "url": frontier_item.url
        }
        fetch_res = collector.send_task(task, watchlist)
        return frontier_item, fetch_res

    # Multi-hop retrieval loop with concurrency and territory reservation
    batch_size = max(1, concurrency)
    while frontier.should_continue() and frontier.queue:
        if cancel_token.is_set():
            if progress_callback:
                progress_callback("Research cancelled by user request.")
            break

        if progress_callback:
            progress_callback(f"Retrieving batch at depth {current_depth} (Frontier queue: {len(frontier.queue)}, Collected: {frontier.documents_collected}/{frontier.max_documents})...")

        # Reserve a batch of candidates across non-overlapping territory
        batch = frontier.pop_next_batch(batch_size=batch_size)
        if not batch:
            break

        # Execute batch in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(batch), batch_size)) as executor:
            fetch_futures = [executor.submit(_fetch_single_item, item) for item in batch]

            for future in concurrent.futures.as_completed(fetch_futures):
                if cancel_token.is_set():
                    break

                try:
                    frontier_item, fetch_res = future.result()
                except Exception:
                    continue

                if fetch_res.get("status") != "ok":
                    frontier.release_candidate(frontier_item.url)
                    continue

                content = fetch_res.get("content", "")
                if not content or len(content.strip()) < 50 or is_bot_or_js_barrier(content):
                    frontier.release_candidate(frontier_item.url)
                    continue

                # Record document with SHA-256 deduplication
                is_new = frontier.record_document(
                    url=frontier_item.url,
                    content_bytes=fetch_res.get("bytes", len(content)),
                    text=content,
                    doi=frontier_item.doi
                )
                if not is_new:
                    continue

                current_depth = max(current_depth, frontier_item.depth)

                # Derive clean snippet from substantive content
                snippet_text = content
                if "Abstract:" in content:
                    snippet_text = content.split("Abstract:")[1].strip()
                elif "Title:" in content:
                    parts = content.split("\n\n", 1)
                    if len(parts) > 1:
                        snippet_text = parts[1].strip()

                clean_snippet = re.sub(r"\s+", " ", snippet_text)[:250].strip()
                if len(snippet_text) > 250:
                    clean_snippet += "..."

                evidence_entry = {
                    "title": f"Source at {urllib.parse.urlparse(frontier_item.url).netloc}",
                    "url": frontier_item.url,
                    "doi": frontier_item.doi,
                    "snippet": clean_snippet,
                    "excerpt": content[:3000],
                    "depth": frontier_item.depth,
                }
                collected_evidence.append(evidence_entry)

                # Discover candidate links for next hop if within depth limit
                if frontier_item.depth < frontier.max_depth:
                    outbound_links = fetch_res.get("links", [])
                    for link in outbound_links:
                        can_link = canonicalize_url(link)
                        if can_link:
                            frontier.add_candidate(
                                url=can_link,
                                depth=frontier_item.depth + 1,
                                priority=30.0,
                                source_url=frontier_item.url
                            )

        # Local Gap Analysis: identify technical gaps in collected corpus to seed next round
        if len(collected_evidence) >= 2 and current_depth == 0 and frontier.should_continue() and not cancel_token.is_set():
            local_slm = LocalSLMEngine()
            gaps = local_slm.analyze_gaps(effective_topic, collected_evidence)
            for gap_query in gaps:
                gap_task = {
                    "task_id": f"gap-{int(time.time() * 1000)}",
                    "action": "search",
                    "connector": "all",
                    "query": gap_query
                }
                gap_resp = collector.send_task(gap_task, watchlist)
                if gap_resp.get("status") == "ok":
                    for g_item in gap_resp.get("results", []):
                        can_g_url = canonicalize_url(g_item.get("url", ""))
                        if can_g_url:
                            frontier.add_candidate(
                                url=can_g_url,
                                doi=g_item.get("doi", ""),
                                depth=1,
                                priority=45.0,
                                source_url="gap_analysis"
                            )

    if progress_callback:
        progress_callback("Ranking corpus locally with BM25 + FastEmbed (bge-small-en-v1.5) + RRF...")

    ranked_evidence = rank_items(topic, collected_evidence)

    summary = ""
    clean_eval_topic = re.sub(r"\[TARGET_ENTITY_\d+\]", "target component", effective_topic)

    has_openai = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    if mode == "full" and has_openai and not cancel_token.is_set():
        if progress_callback:
            progress_callback(f"Generating sourced summary with OpenAI ({openai_model})...")
        try:
            summary = summarize_with_openai(
                clean_eval_topic,
                ranked_evidence[:5],
                watchlist,
                model=openai_model,
                reasoning_effort=reasoning_effort,
                cost_tracker=cost_tracker
            )
        except SpendLimitExceededError:
            local_slm = LocalSLMEngine()
            summary = local_slm.synthesize(clean_eval_topic, ranked_evidence[:5])
            summary = redact(summary, watchlist)
    else:
        if progress_callback:
            progress_callback("Synthesizing offline sourced summary with Local SLM...")
        local_slm = LocalSLMEngine()
        summary = local_slm.synthesize(clean_eval_topic, ranked_evidence[:5])
        summary = redact(summary, watchlist)

    duration = time.time() - start_time
    spend_report = cost_tracker.get_report()
    cost_str = f"${spend_report.estimated_cost_usd:.4f}"
    duration_str = f"{duration:.1f}s"

    if progress_callback:
        progress_callback("Writing report and archiving findings...")

    clean_report_topic = redact(topic, watchlist) if mode != "extreme" else re.sub(r"\[TARGET_ENTITY_\d+\]", "[PROTECTED-TARGET]", effective_topic)

    meta = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mode": mode,
        "cost_str": cost_str,
        "duration_str": duration_str,
        "model": openai_model,
    }
    archive_path = write_report(clean_report_topic, ranked_evidence, summary, watchlist, metadata=meta)

    report_md = ""
    if os.path.exists("report.md"):
        try:
            with open("report.md", "r", encoding="utf-8") as f:
                report_md = f.read()
        except Exception:
            pass

    status = "cancelled" if cancel_token.is_set() else "success"
    cancellation_manager.clear_token(run_id)

    if progress_callback:
        progress_callback("Research process complete.")

    return {
        "status": status,
        "topic": topic,
        "mode": mode,
        "queries": queries,
        "evidence": ranked_evidence,
        "summary": summary,
        "report_markdown": report_md,
        "report_archive": archive_path,
        "spend_report": {
            "model": spend_report.model,
            "prompt_tokens": spend_report.prompt_tokens,
            "completion_tokens": spend_report.completion_tokens,
            "total_tokens": spend_report.total_tokens,
            "estimated_cost_usd": spend_report.estimated_cost_usd,
            "is_cap_exceeded": spend_report.is_cap_exceeded,
        },
        "duration_seconds": round(duration, 2),
    }


def _build_response(status, topic, mode, queries, evidence, summary, report_md, archive_path, cost_tracker, duration):
    spend = cost_tracker.get_report() if cost_tracker else None
    return {
        "status": status,
        "topic": topic,
        "mode": mode,
        "queries": queries,
        "evidence": evidence,
        "summary": summary,
        "report_markdown": report_md,
        "report_archive": archive_path,
        "spend_report": {
            "model": spend.model if spend else "none",
            "prompt_tokens": spend.prompt_tokens if spend else 0,
            "completion_tokens": spend.completion_tokens if spend else 0,
            "total_tokens": spend.total_tokens if spend else 0,
            "estimated_cost_usd": spend.estimated_cost_usd if spend else 0.0,
            "is_cap_exceeded": spend.is_cap_exceeded if spend else False,
        },
        "duration_seconds": round(duration, 2),
    }
