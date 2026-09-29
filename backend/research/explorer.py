"""Explorer: progressive multi-hop retrieval with decoy discard.

Mid-run, the explorer checks collected evidence for coverage gaps and runs
follow-up searches: model-driven when an OpenAI key and ai_planning are
available, local heuristic otherwise. Frontier priority is relevance-scaled
via BM25 against the topic so the document cap keeps the best sources.
"""

from __future__ import annotations

import concurrent.futures
import itertools
import re
import threading
import urllib.parse
import uuid

from backend.frontier.priority_frontier import ResearchFrontier
from backend.frontier.url_canonicalizer import canonicalize_url
from backend.ranking.bm25_scorer import compute_bm25_scores
from backend.retrieval.bot_barrier_detector import is_bot_or_js_barrier
from backend.retrieval.collector_client import CollectorClient, get_collector
from backend.research.cloud_errors import CloudCallError
from backend.research.types import Evidence, Query, SearchOptions
from backend.research.information_gain import InformationGainTracker
from backend.synthesis.local_synthesizer import LocalSynthesizer


def _cancelled(cancel_token) -> bool:
    return bool(cancel_token is not None and cancel_token.is_set())


def _snippet_from_content(content: str) -> str:
    if not isinstance(content, str) or not content:
        return ""
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
    return clean_snippet


def _bm25_priorities(topic: str, items: list[dict]) -> list[float]:
    """Map raw BM25 scores onto frontier priorities in [30, 60]."""
    corpus = [
        f"{it.get('title') or ''} {it.get('snippet') or ''}"
        if isinstance(it, dict) else ""
        for it in items
    ]
    if not corpus:
        return []
    raw = compute_bm25_scores(topic, corpus)
    lo, hi = min(raw), max(raw)
    if hi <= lo:
        return [45.0] * len(raw)
    return [round(30.0 + ((s - lo) / (hi - lo)) * 30.0, 2) for s in raw]


def _task_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class _CollectorPool:
    """Round-robin across collector processes so concurrency is real."""

    def __init__(self, workers: list):
        self._workers = workers
        self._cursor = itertools.count()
        self._pick_lock = threading.Lock()

    def send_task(self, task: dict, watchlist: list[str]) -> dict:
        with self._pick_lock:
            worker = self._workers[next(self._cursor) % len(self._workers)]
        return worker.send_task(task, watchlist)


def _open_collectors(collector, concurrency: int):
    if collector is not None:
        return _CollectorPool([collector]), []
    primary = get_collector()
    extras = []
    for _ in range(max(0, concurrency - 1)):
        extras.append(CollectorClient())
    return _CollectorPool([primary, *extras]), extras


def _seed_frontier_from_results(
    frontier: ResearchFrontier,
    titles: dict[str, str],
    results: list[dict],
    depth: int,
    priority: float,
    source_url: str,
    topic: str = "",
    relevance_scale: bool = False,
) -> None:
    """Add search results to the frontier, optionally scaling priority by BM25 relevance."""
    if relevance_scale and results:
        priorities = _bm25_priorities(topic, results)
    else:
        priorities = [priority] * len(results)
    for item, item_priority in zip(results, priorities):
        if not isinstance(item, dict):
            continue
        raw_url = item.get("url", "")
        can_url = canonicalize_url(raw_url if isinstance(raw_url, str) else "")
        if can_url:
            title = item.get("title")
            if isinstance(title, str) and title:
                titles[can_url] = title
            raw_doi = item.get("doi", "")
            frontier.add_candidate(
                url=can_url,
                doi=raw_doi if isinstance(raw_doi, str) else "",
                depth=depth,
                priority=item_priority,
                source_url=source_url,
            )


def _run_gap_searches(
    gap_queries: list[str],
    collector,
    watchlist: list[str],
    titles: dict[str, str],
    frontier: ResearchFrontier,
) -> int:
    """Execute gap-driven searches and seed the frontier with their hits."""
    added = 0
    for gap_query in gap_queries:
        gap_task = {
            "task_id": _task_id("gap"),
            "action": "search",
            "connector": "all",
            "query": gap_query,
        }
        gap_resp = collector.send_task(gap_task, watchlist)
        if gap_resp.get("status") != "ok":
            continue
        for g_item in gap_resp.get("results", []) or []:
            if not isinstance(g_item, dict):
                continue
            raw_url = g_item.get("url", "")
            can_g_url = canonicalize_url(raw_url if isinstance(raw_url, str) else "")
            if can_g_url:
                title = g_item.get("title")
                if isinstance(title, str) and title:
                    titles[can_g_url] = title
                raw_doi = g_item.get("doi", "")
                frontier.add_candidate(
                    url=can_g_url,
                    doi=raw_doi if isinstance(raw_doi, str) else "",
                    depth=1,
                    priority=45.0,
                    source_url="gap_analysis",
                )
                added += 1
    return added


def _propose_gaps(
    topic: str,
    watchlist: list[str],
    options: SearchOptions,
    collected: list[Evidence],
    cost_tracker,
    progress_callback,
    gap_round: int = 1,
) -> list[str]:
    """Model-driven gap proposals when possible, empty list for local fallback."""
    from backend.research.cloud_client import get_api_key

    if not (options.ai_planning and get_api_key()):
        return []
    if progress_callback:
        progress_callback("Asking the model what angles are still missing...")
    evidence_dicts = [
        {"excerpt": e.excerpt, "content": e.excerpt, "url": e.url, "title": e.title}
        for e in collected
    ]
    # First gap round (round 1) may consult the concealer model; later rounds
    # are local-only so deep multi-hour runs do not stream snippets repeatedly.
    if gap_round > 1:
        return []
    try:
        from backend.research.query_planner import propose_gap_queries

        return propose_gap_queries(
            topic,
            watchlist,
            evidence_dicts,
            model=options.concealer_model,
            reasoning_effort=options.reasoning_effort,
            cost_tracker=cost_tracker,
            conceal_process=options.conceal_process,
        )
    except CloudCallError:
        if progress_callback:
            progress_callback("Model gap analysis failed. Using local heuristics instead.")
    except Exception:
        pass
    return []


def _expand_citation_edges(collected, options, collector, watchlist, titles, frontier, progress_callback) -> int:
    """Seed the frontier along OpenAlex citation edges from top academic hits."""
    try:
        from backend.retrieval.connectors.openalex_connector import expand_citations
    except Exception:
        return 0
    # Prefer academic sources with DOIs; fall back to any evidence with a DOI.
    academic = [e for e in collected if e.doi] or [e for e in collected if "arxiv" in (e.url or "").lower()]
    if not academic:
        return 0
    # Highest-depth first: expand from the frontier edge, not the seed core.
    academic = sorted(academic, key=lambda e: (-e.depth, e.url))[:2]
    added = 0
    for hit in academic:
        if progress_callback:
            progress_callback(f"Following citations from: {(hit.title or hit.url)[:70]}...")
        for direction in ("references", "cited_by"):
            try:
                edges = expand_citations(
                    hit.doi or hit.url,
                    direction=direction,
                    per_page=max(1, options.citation_per_doc),
                )
            except Exception:
                continue
            for item in edges:
                if not isinstance(item, dict):
                    continue
                raw_url = item.get("url", "")
                can_url = canonicalize_url(raw_url if isinstance(raw_url, str) else "")
                if not can_url:
                    continue
                title = item.get("title")
                if isinstance(title, str) and title:
                    titles[can_url] = title
                raw_doi = item.get("doi", "")
                if frontier.add_candidate(
                    url=can_url,
                    doi=raw_doi if isinstance(raw_doi, str) else "",
                    depth=min(hit.depth + 1, frontier.max_depth),
                    priority=55.0,
                    source_url=f"citations:{direction}",
                ):
                    added += 1
    return added


def explore(
    queries: list[Query],
    watchlist: list[str],
    options: SearchOptions,
    cancel_token=None,
    collector=None,
    progress_callback=None,
    cost_tracker=None,
    frontier_state: dict | None = None,
    prior_evidence: list[Evidence] | None = None,
    checkpoint_callback=None,
    stop_callback=None,
) -> list[Evidence]:
    """Search, fetch, and hop. Decoy-originated hits never enter the frontier."""
    pool, extras = _open_collectors(collector, options.concurrency)
    try:
        return _explore(
            queries, watchlist, options, cancel_token, pool, progress_callback, cost_tracker,
            frontier_state, prior_evidence, checkpoint_callback, stop_callback
        )
    finally:
        for extra in extras:
            try:
                extra.close()
            except Exception:
                pass


def _explore(queries, watchlist, options, cancel_token, collector, progress_callback, cost_tracker=None,
             frontier_state=None, prior_evidence=None, checkpoint_callback=None, stop_callback=None) -> list[Evidence]:
    frontier = ResearchFrontier.from_state(frontier_state) if frontier_state else ResearchFrontier(
        max_depth=options.max_depth,
        max_documents=options.max_documents,
        max_per_domain=options.max_per_domain,
        max_duration_sec=options.max_duration_sec,
    )

    real_queries = [q for q in queries if not q.is_decoy]
    decoy_queries = [q for q in queries if q.is_decoy]
    titles: dict[str, str] = {}
    worker_count = min(max(1, options.concurrency), max(1, len(queries)))

    def _execute_search(q: Query):
        task = {
            "task_id": _task_id("search"),
            "action": "search",
            "connector": "all",
            "query": q.text,
        }
        return q, collector.send_task(task, watchlist)

    if progress_callback:
        progress_callback(
            f"Searching {len(real_queries)} angle(s) across academic, SEC, and web sources..."
        )

    search_jobs = [] if frontier_state and frontier.queue else real_queries + decoy_queries
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(_execute_search, q) for q in search_jobs]
        for f in concurrent.futures.as_completed(futures):
            if _cancelled(cancel_token):
                break
            try:
                originating, resp = f.result()
            except Exception:
                continue
            if originating.is_decoy:
                continue
            if checkpoint_callback:
                checkpoint_callback("search", {"provider": "all", "status": str(resp.get("status", "error")), "error": str(resp.get("error", "")), "frontier": frontier.export_state()})
            if resp.get("status") != "ok":
                continue
            _seed_frontier_from_results(
                frontier,
                titles,
                resp.get("results", []),
                depth=0,
                priority=50.0,
                source_url="initial_search",
                topic=real_queries[0].text if real_queries else "",
                relevance_scale=True,
            )

    collected: list[Evidence] = list(prior_evidence or [])
    gain_tracker = InformationGainTracker(options.low_information_gain_rounds, collected)
    current_depth = 0
    batch_size = max(1, options.concurrency)
    gap_rounds_done = 0
    max_gap_rounds = max(0, options.max_gap_rounds)

    def _fetch_single_item(frontier_item):
        task = {
            "task_id": _task_id("fetch"),
            "action": "fetch",
            "url": frontier_item.url,
        }
        return frontier_item, collector.send_task(task, watchlist)

    while frontier.should_continue() and frontier.queue:
        if _cancelled(cancel_token):
            if progress_callback:
                progress_callback("Stopped. Compiling what we have so far...")
            break

        if progress_callback:
            progress_callback(
                f"Reading sources (hop {current_depth}, "
                f"{frontier.documents_collected}/{frontier.max_documents} kept, "
                f"{len(frontier.queue)} waiting)..."
            )

        batch = frontier.pop_next_batch(batch_size=batch_size)
        if not batch:
            break

        batch_accepted: list[Evidence] = []
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(len(batch), batch_size)
        ) as executor:
            fetch_futures = [executor.submit(_fetch_single_item, item) for item in batch]
            for future in concurrent.futures.as_completed(fetch_futures):
                if _cancelled(cancel_token):
                    break
                try:
                    frontier_item, fetch_res = future.result()
                except Exception:
                    continue

                if not isinstance(fetch_res, dict) or fetch_res.get("status") != "ok":
                    frontier.release_candidate(frontier_item.url, doi=frontier_item.doi)
                    continue

                content = fetch_res.get("content", "")
                if not isinstance(content, str) or not content or len(content.strip()) < 50 or is_bot_or_js_barrier(content):
                    frontier.release_candidate(frontier_item.url, doi=frontier_item.doi)
                    continue

                raw_bytes = fetch_res.get("bytes", len(content))
                is_new = frontier.record_document(
                    url=frontier_item.url,
                    content_bytes=raw_bytes if isinstance(raw_bytes, int) else len(content),
                    text=content,
                    doi=frontier_item.doi,
                )
                if not is_new:
                    continue

                current_depth = max(current_depth, frontier_item.depth)
                netloc = urllib.parse.urlparse(frontier_item.url).netloc
                title = titles.get(frontier_item.url) or f"Source at {netloc}"
                # Chunk long documents so downstream rerank/synthesis see
                # focused passages; keep the best chunk as the excerpt plus
                # a rerank hint. Short docs pass through unchanged.
                excerpt_text = content[:3000]
                rerank_hint = ""
                if options.chunk_documents and len(content) > 1600:
                    try:
                        from backend.retrieval.text_chunker import chunk_text
                        chunks = chunk_text(content)
                        if chunks:
                            excerpt_text = chunks[0][:3000]
                            rerank_hint = excerpt_text[:800]
                    except Exception:
                        pass
                accepted_evidence = Evidence(
                        title=title,
                        url=frontier_item.url,
                        snippet=_snippet_from_content(content),
                        excerpt=excerpt_text,
                        doi=frontier_item.doi,
                        depth=frontier_item.depth,
                        source=(frontier_item.source_url or "") + ("|chunked" if rerank_hint else ""),
                        rerank_score=0.0,
                    )
                collected.append(accepted_evidence)
                batch_accepted.append(accepted_evidence)
                if checkpoint_callback:
                    checkpoint_callback("evidence", {"provider": "fetch", "status": "ok", "evidence": accepted_evidence, "frontier": frontier.export_state()})
                if rerank_hint:
                    titles[f"{frontier_item.url}#chunk"] = rerank_hint

                if frontier_item.depth < frontier.max_depth:
                    for link in fetch_res.get("links", []):
                        can_link = canonicalize_url(link)
                        if can_link:
                            frontier.add_candidate(
                                url=can_link,
                                depth=frontier_item.depth + 1,
                                priority=30.0,
                                source_url=frontier_item.url,
                            )

        observation = gain_tracker.observe_batch(batch_accepted, frontier)
        if checkpoint_callback:
            checkpoint_callback("fetch", {"provider": "fetch", "status": "ok", "accepted": len(batch_accepted), "low_gain": observation.low_gain, "frontier": frontier.export_state()})
        if gain_tracker.should_stop(options.low_information_gain_min_documents):
            queued_citations = [item for item in frontier.queue if item.source_url.startswith("citations:")]
            best_ordinary = max((item.priority for item in frontier.queue if not item.source_url.startswith("citations:")), default=float("-inf"))
            if not any(item.priority > best_ordinary for item in queued_citations):
                if stop_callback:
                    stop_callback("low_information_gain")
                break

        # Continuation rounds: while evidence keeps arriving and rounds remain,
        # re-check coverage after every hop level and seed fresh angles. This is
        # the deep-search edge: the frontier keeps following citations instead
        # of stopping after a single shallow pass like provider-capped research.
        if (
            gap_rounds_done < max_gap_rounds
            and len(collected) >= 2
            and frontier.should_continue()
            and not _cancelled(cancel_token)
        ):
            gap_rounds_done += 1
            if progress_callback:
                progress_callback(
                    f"Coverage check {gap_rounds_done}/{max_gap_rounds}: "
                    "looking for missing angles in what we have..."
                )
            gap_topic = next((q.text for q in real_queries), "")
            local_slm = LocalSynthesizer()
            evidence_dicts = [
                {"excerpt": e.excerpt, "content": e.excerpt, "url": e.url, "title": e.title}
                for e in collected
            ]
            gaps = _propose_gaps(
                gap_topic,
                watchlist,
                options,
                collected,
                cost_tracker,
                progress_callback,
                gap_round=gap_rounds_done,
            )
            if not gaps:
                gaps = local_slm.analyze_gaps(gap_topic, evidence_dicts)
            # Graph-grounded gaps: concepts with thin coverage become queries
            # derived from retrieved evidence, not a hardcoded angle list.
            if options.graph_prioritization:
                try:
                    from backend.retrieval.evidence_graph import EvidenceGraph
                    graph = EvidenceGraph()
                    for e in collected:
                        graph.add_document(e.url, e.title, e.excerpt)
                    for g in graph.coverage_gaps(gap_topic):
                        if g not in gaps:
                            gaps.append(g)
                except Exception:
                    pass
            _run_gap_searches(gaps, collector, watchlist, titles, frontier)
            # Citation-graph expansion: follow OpenAlex reference/cited-by
            # edges from the strongest academic hits (GraphRAG-lite).
            if options.citation_expansion and not _cancelled(cancel_token):
                _expand_citation_edges(collected, options, collector, watchlist, titles, frontier, progress_callback)

    return collected
