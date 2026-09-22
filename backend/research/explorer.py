"""Explorer: progressive multi-hop retrieval with decoy discard."""

from __future__ import annotations

import concurrent.futures
import itertools
import re
import threading
import uuid
import urllib.parse

from backend.frontier.priority_frontier import ResearchFrontier
from backend.frontier.url_canonicalizer import canonicalize_url
from backend.retrieval.bot_barrier_detector import is_bot_or_js_barrier
from backend.retrieval.collector_client import CollectorClient, get_collector
from backend.research.types import Evidence, Query, SearchOptions
from backend.synthesis.local_synthesizer import LocalSynthesizer


def _cancelled(cancel_token) -> bool:
    return bool(cancel_token is not None and cancel_token.is_set())


def _snippet_from_content(content: str) -> str:
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


def explore(
    queries: list[Query],
    watchlist: list[str],
    options: SearchOptions,
    cancel_token=None,
    collector=None,
    progress_callback=None,
) -> list[Evidence]:
    """Search, fetch, and hop. Decoy-originated hits never enter the frontier."""
    pool, extras = _open_collectors(collector, options.concurrency)
    try:
        return _explore(queries, watchlist, options, cancel_token, pool, progress_callback)
    finally:
        for extra in extras:
            try:
                extra.close()
            except Exception:
                pass


def _explore(queries, watchlist, options, cancel_token, collector, progress_callback) -> list[Evidence]:
    frontier = ResearchFrontier(
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

    search_jobs = real_queries + decoy_queries
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
            if resp.get("status") != "ok":
                continue
            for item in resp.get("results", []):
                can_url = canonicalize_url(item.get("url", ""))
                if can_url:
                    if item.get("title"):
                        titles[can_url] = item.get("title", "")
                    frontier.add_candidate(
                        url=can_url,
                        doi=item.get("doi", ""),
                        depth=0,
                        priority=50.0,
                        source_url="initial_search",
                    )

    collected: list[Evidence] = []
    current_depth = 0
    batch_size = max(1, options.concurrency)
    gap_seeded = False

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

                if fetch_res.get("status") != "ok":
                    frontier.release_candidate(frontier_item.url, doi=frontier_item.doi)
                    continue

                content = fetch_res.get("content", "")
                if not content or len(content.strip()) < 50 or is_bot_or_js_barrier(content):
                    frontier.release_candidate(frontier_item.url, doi=frontier_item.doi)
                    continue

                is_new = frontier.record_document(
                    url=frontier_item.url,
                    content_bytes=fetch_res.get("bytes", len(content)),
                    text=content,
                    doi=frontier_item.doi,
                )
                if not is_new:
                    continue

                current_depth = max(current_depth, frontier_item.depth)
                netloc = urllib.parse.urlparse(frontier_item.url).netloc
                collected.append(
                    Evidence(
                        title=titles.get(frontier_item.url) or f"Source at {netloc}",
                        url=frontier_item.url,
                        snippet=_snippet_from_content(content),
                        excerpt=content[:3000],
                        doi=frontier_item.doi,
                        depth=frontier_item.depth,
                    )
                )

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

        if (
            not gap_seeded
            and len(collected) >= 2
            and current_depth == 0
            and frontier.should_continue()
            and not _cancelled(cancel_token)
        ):
            gap_seeded = True
            if progress_callback:
                progress_callback("Looking for missing angles in what we have...")
            gap_topic = next((q.text for q in real_queries), "")
            local_slm = LocalSynthesizer()
            evidence_dicts = [
                {"excerpt": e.excerpt, "content": e.excerpt, "url": e.url, "title": e.title}
                for e in collected
            ]
            gaps = local_slm.analyze_gaps(gap_topic, evidence_dicts)
            for gap_query in gaps:
                gap_task = {
                    "task_id": _task_id("gap"),
                    "action": "search",
                    "connector": "all",
                    "query": gap_query,
                }
                gap_resp = collector.send_task(gap_task, watchlist)
                if gap_resp.get("status") != "ok":
                    continue
                for g_item in gap_resp.get("results", []):
                    can_g_url = canonicalize_url(g_item.get("url", ""))
                    if can_g_url:
                        if g_item.get("title"):
                            titles[can_g_url] = g_item.get("title", "")
                        frontier.add_candidate(
                            url=can_g_url,
                            doi=g_item.get("doi", ""),
                            depth=1,
                            priority=45.0,
                            source_url="gap_analysis",
                        )

    return collected
