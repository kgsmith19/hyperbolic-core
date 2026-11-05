"""Explorer: iterative, lane-balanced, multi-hop deep research.

One run is a sequence of *rounds*. Each round:

1. Search   — the round's queries fan out across source lanes (academic,
              community, video, experts, institutional, web...) concurrently.
2. Read     — the best candidates are fetched in parallel. Priority blends
              relevance, a source-quality prior, and how far each lane is
              from the user's academic/discussion target mix. Long documents
              keep only their most relevant passages. Paywalled papers fall
              back to their index abstract; dead pages to the Wayback Machine.
3. Hop      — content links (scored by anchor text) and citation edges
              (references + cited-by) extend the frontier deeper.
4. Reflect  — learnings are distilled, sub-question coverage is measured, and
              follow-up queries target thin angles and recurring leads the
              original queries never named (snowballing).

Rounds repeat until the document, time, or round budget is spent, or the
cancel token fires. Decoy-originated hits never enter the frontier.
"""

from __future__ import annotations

import concurrent.futures
import itertools
import math
import re
import threading
import urllib.parse
import uuid

from backend.frontier.priority_frontier import ResearchFrontier
from backend.frontier.url_canonicalizer import canonicalize_url
from backend.ranking.bm25_scorer import compute_bm25_scores
from backend.retrieval.bot_barrier_detector import is_bot_or_js_barrier
from backend.retrieval.collector_client import CollectorClient, get_collector
from backend.retrieval.source_quality import classify_lane, mix_targets, quality_prior
from backend.research.cloud_errors import CloudCallError
from backend.research.types import Evidence, Query, SearchOptions
from backend.research.information_gain import InformationGainTracker
from backend.research import reflection
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


def _run_gap_searches(gap_queries, collector, watchlist, titles, frontier) -> int:
    """Execute gap-driven searches and seed the frontier with their hits (legacy helper)."""
    added = 0
    for gap_query in gap_queries:
        gap_resp = collector.send_task({"task_id": _task_id("gap"), "action": "search",
                                        "connector": "all", "query": gap_query}, watchlist)
        if gap_resp.get("status") != "ok":
            continue
        before = len(frontier.queue)
        _seed_frontier_from_results(frontier, titles, gap_resp.get("results", []) or [], depth=1,
                                    priority=45.0, source_url="gap_analysis")
        added += max(0, len(frontier.queue) - before)
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
    """Model-driven gap proposals when allowed this round; [] for local-only rounds."""
    from backend.research.cloud_client import get_api_key

    if not (options.ai_planning and get_api_key()):
        return []
    # Only the first `llm_gap_rounds` rounds may consult the model, so long
    # multi-hour runs do not stream snippets out round after round.
    if gap_round > max(0, int(getattr(options, "llm_gap_rounds", 1))):
        return []
    if progress_callback:
        progress_callback("Asking the model what angles are still missing...")
    evidence_dicts = [
        {"excerpt": e.excerpt, "content": e.excerpt, "url": e.url, "title": e.title}
        for e in sorted(collected, key=lambda e: -float(getattr(e, "quality", 0) or 0))[:12]
    ]
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
            max_queries=max(3, min(8, options.queries_per_round)),
        )
    except CloudCallError:
        if progress_callback:
            progress_callback("Model gap analysis failed. Using local heuristics instead.")
    except Exception:
        pass
    return []


def _citation_edges(collector, watchlist, work_id: str, direction: str, per_page: int) -> list[dict]:
    """Citation edges: direct call when the process may reach OpenAlex, else via the collector."""
    edges: list = []
    try:
        from backend.retrieval.connectors.openalex_connector import expand_citations
        edges = expand_citations(work_id, direction=direction, per_page=per_page) or []
    except Exception:
        edges = []
    if edges:
        return edges
    try:
        resp = collector.send_task({"task_id": _task_id("cite"), "action": "citations", "url": work_id,
                                    "connector": direction, "limit": per_page}, watchlist)
        if isinstance(resp, dict) and resp.get("status") == "ok" and isinstance(resp.get("results"), list):
            return resp["results"]
    except Exception:
        pass
    return []


def _expand_citation_edges(collected, options, collector, watchlist, titles, frontier, progress_callback,
                           cands: dict | None = None, expanded: set | None = None, topic: str = "") -> int:
    """Seed the frontier along OpenAlex citation edges from the strongest academic hits."""
    academic = [e for e in collected if e.doi] or [e for e in collected if "arxiv" in (e.url or "").lower()]
    if expanded is not None:
        academic = [e for e in academic if (e.doi or e.url) not in expanded]
    if not academic:
        return 0
    n_hits = max(2, min(8, int(options.max_documents) // 60 + 2))
    if topic:
        from backend.research.reflection import overlap_score, terms
        topic_terms = terms(topic)
        academic = sorted(academic, key=lambda e: (-(overlap_score(topic_terms, f"{e.title} {e.excerpt[:1500]}")
                                                     + 0.5 * float(getattr(e, "quality", 0) or 0)), e.url))[:n_hits]
    else:
        academic = sorted(academic, key=lambda e: (-float(getattr(e, "quality", 0) or 0), -e.depth, e.url))[:n_hits]
    added = 0
    for hit in academic:
        if expanded is not None:
            expanded.add(hit.doi or hit.url)
        if progress_callback:
            progress_callback(f"Following citations from: {(hit.title or hit.url)[:70]}...")
        for direction in ("references", "cited_by"):
            edges = _citation_edges(collector, watchlist, hit.doi or hit.url, direction,
                                    max(1, options.citation_per_doc))
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
                meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
                q = quality_prior(can_url, "academic", meta, title or "")
                raw_doi = item.get("doi", "")
                priority = 52.0 + 10.0 * q
                if frontier.add_candidate(
                    url=can_url,
                    doi=raw_doi if isinstance(raw_doi, str) else "",
                    depth=min(hit.depth + 1, frontier.max_depth),
                    priority=priority,
                    source_url=f"citations:{direction}",
                ):
                    added += 1
                    if cands is not None:
                        cands[can_url] = {"title": title or "", "snippet": item.get("snippet", ""),
                                          "abstract": item.get("abstract", ""), "lane": "academic",
                                          "meta": meta, "quality": q, "base": priority,
                                          "oa_url": item.get("oa_url", ""), "subq": ""}
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
    telemetry=None,
    plan=None,
    learnings_out: list | None = None,
) -> list[Evidence]:
    """Search, read, hop, and reflect. Decoy-originated hits never enter the frontier."""
    pool, extras = _open_collectors(collector, options.concurrency)
    try:
        return _Explorer(
            queries, watchlist, options, cancel_token, pool, progress_callback, cost_tracker,
            frontier_state, prior_evidence, checkpoint_callback, stop_callback, telemetry, plan,
            learnings_out,
        ).run()
    finally:
        for extra in extras:
            try:
                extra.close()
            except Exception:
                pass


class _Explorer:
    def __init__(self, queries, watchlist, options, cancel_token, collector, progress_callback, cost_tracker,
                 frontier_state, prior_evidence, checkpoint_callback, stop_callback, telemetry, plan,
                 learnings_out):
        self.queries = queries
        self.watchlist = watchlist
        self.options = options
        self.cancel_token = cancel_token
        self.collector = collector
        self.progress_callback = progress_callback
        self.cost_tracker = cost_tracker
        self.checkpoint_callback = checkpoint_callback
        self.stop_callback = stop_callback
        self.telemetry = telemetry
        self.plan = plan
        self.learnings = learnings_out if learnings_out is not None else []
        max_docs = int(options.max_documents)
        self.frontier = ResearchFrontier.from_state(frontier_state) if frontier_state else ResearchFrontier(
            max_depth=options.max_depth,
            max_documents=max_docs,
            max_bytes_budget=max(10 * 1024 * 1024, max_docs * 400 * 1024),
            max_per_domain=options.max_per_domain,
            max_duration_sec=options.max_duration_sec,
        )
        self.resumed = bool(frontier_state)
        for url in options.exclude_urls or []:
            can = canonicalize_url(url) if isinstance(url, str) else ""
            if can:
                self.frontier.visited_urls.add(can)
        self.real_queries = [q for q in queries if not q.is_decoy]
        self.decoys = [q for q in queries if q.is_decoy]
        self.topic = self.real_queries[0].text if self.real_queries else ""
        self.topic_terms = reflection.terms(self.topic)
        self.titles: dict[str, str] = {}
        self.cands: dict[str, dict] = {}
        self.collected: list[Evidence] = list(prior_evidence or [])
        self.issued: set[str] = {q.text.lower() for q in queries}
        self.lanes_enabled = list(options.source_lanes or [])
        self.targets = mix_targets(options.academic_weight, self.lanes_enabled) if self.lanes_enabled else {}
        self.lane_counts: dict[str, int] = {}
        for ev in self.collected:
            lane = ev.lane or classify_lane(ev.url, ev.source)
            self.lane_counts[lane] = self.lane_counts.get(lane, 0) + 1
        self.subq_by_query: dict[str, tuple[str, list[str]]] = {}
        if plan is not None:
            for sq in plan.sub_questions:
                for q in sq.queries:
                    self.subq_by_query.setdefault(q.lower(), (sq.id, list(sq.lanes)))
        self.citations_expanded: set = set()
        self.batch_size = max(1, options.concurrency)
        if telemetry is not None:
            telemetry.set(max_documents=max_docs, time_budget_sec=int(options.max_duration_sec),
                          lane_targets=self.targets, max_rounds=max(0, options.max_gap_rounds))

    # ------------------------------------------------------------------ utils
    def say(self, message: str) -> None:
        if self.telemetry is not None:
            self.telemetry.log(message)
        elif self.progress_callback:
            self.progress_callback(message)

    def _stat(self, **deltas) -> None:
        if self.telemetry is not None:
            self.telemetry.bump(**deltas)

    def _lane_bonus(self, lane: str) -> float:
        """Positive when a lane is under its target share, negative when over."""
        if not self.targets:
            return 0.0
        target = self.targets.get(lane, 0.0)
        total = sum(self.lane_counts.values())
        if target <= 0:
            return -4.0
        if total < 3:
            return 6.0 * min(1.0, target * 4)
        actual = self.lane_counts.get(lane, 0) / total
        return max(-16.0, min(24.0, 30.0 * (target - actual) / max(target, 0.05)))

    def _rescore_queue(self) -> None:
        if self.targets:
            self.frontier.reprioritize(
                lambda item: (self.cands.get(item.url, {}).get("base", item.priority)
                              + self._lane_bonus(self.cands.get(item.url, {}).get("lane", "web"))))

    def _on_topic(self, title: str, content: str, threshold: float = 0.70) -> bool:
        """Semantic drift gate for hops/citations (FastEmbed cosine; term overlap fallback)."""
        if len(self.topic_terms) < 2:
            return True
        sample = f"{title}. {content[:1200]}"
        try:
            from backend.ranking import dense_embedder
            if dense_embedder._EMBEDDER is not None:
                score = dense_embedder.compute_dense_scores(self.topic, [sample])[0]
                return score >= threshold
        except Exception:
            pass
        return self._relevance(content[:8000]) > 0.0

    def _lane_budget(self, prefer: list[str] | None = None) -> dict | None:
        if not self.targets:
            return None
        per_query = max(8, int(self.options.results_per_lane) * 4)
        weights = {}
        for lane, share in self.targets.items():
            w = share
            if prefer and lane in prefer:
                w *= 1.8
            total = sum(self.lane_counts.values())
            if total >= 5:
                actual = self.lane_counts.get(lane, 0) / total
                w *= max(0.5, min(2.0, (share + 0.02) / (actual + 0.02)))
            weights[lane] = w
        norm = sum(weights.values()) or 1.0
        out = {}
        for lane, w in weights.items():
            n = int(round(per_query * w / norm))
            if w / norm >= 0.03:
                n = max(2, n)
            if n > 0:
                out[lane] = min(40, n)
        return out or None

    def _relevance(self, text: str) -> float:
        return reflection.overlap_score(self.topic_terms, text)

    def _remember_candidate(self, can_url: str, item: dict, base: float, subq: str) -> None:
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        lane = item.get("lane") if isinstance(item.get("lane"), str) and item.get("lane") else classify_lane(can_url, str(item.get("source", "")))
        title = item.get("title") if isinstance(item.get("title"), str) else ""
        self.cands[can_url] = {
            "title": title or "",
            "snippet": item.get("snippet") if isinstance(item.get("snippet"), str) else "",
            "abstract": item.get("abstract") if isinstance(item.get("abstract"), str) else "",
            "lane": lane,
            "meta": meta,
            "quality": quality_prior(can_url, lane, meta, title or ""),
            "base": base,
            "oa_url": item.get("oa_url") if isinstance(item.get("oa_url"), str) else "",
            "subq": subq,
        }

    def _seed(self, results: list, query_text: str, depth: int, source_url: str, subq: str = "") -> int:
        """Seed search hits with relevance + quality + lane-balance priority."""
        results = [r for r in results or [] if isinstance(r, dict)]
        if not results:
            return 0
        focus = f"{self.topic} {query_text}"
        rel = _bm25_priorities(focus, results)
        added = 0
        for item, rel_priority in zip(results, rel):
            raw_url = item.get("url", "")
            can_url = canonicalize_url(raw_url if isinstance(raw_url, str) else "")
            if not can_url:
                continue
            title = item.get("title")
            if isinstance(title, str) and title:
                self.titles[can_url] = title
            if can_url in self.cands:
                continue
            lane = item.get("lane") if isinstance(item.get("lane"), str) and item.get("lane") else classify_lane(can_url, str(item.get("source", "")))
            meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
            q = quality_prior(can_url, lane, meta, title if isinstance(title, str) else "")
            abstract = item.get("abstract") if isinstance(item.get("abstract"), str) else ""
            base = rel_priority + 12.0 * q + (4.0 if len(abstract) > 200 else 0.0)
            raw_doi = item.get("doi", "")
            if self.frontier.add_candidate(
                url=can_url,
                doi=raw_doi if isinstance(raw_doi, str) else "",
                depth=depth,
                priority=round(base + self._lane_bonus(lane), 2),
                source_url=source_url,
            ):
                added += 1
                self._remember_candidate(can_url, {**item, "lane": lane}, base, subq)
        self._stat(candidates=added)
        if self.telemetry is not None:
            self.telemetry.set(queue=len(self.frontier.queue))
        return added

    def _search_one(self, text: str, prefer: list[str] | None, prefix: str = "search"):
        task = {"task_id": _task_id(prefix), "action": "search", "connector": "all", "query": text}
        lanes = self._lane_budget(prefer)
        if lanes:
            task["lanes"] = lanes
        return self.collector.send_task(task, self.watchlist)

    def _run_searches(self, jobs: list[tuple[str, str, list[str], bool]], depth: int, source_url: str) -> int:
        """jobs: (query, subq_id, preferred lanes, is_decoy). Concurrent; decoys discarded."""
        if not jobs:
            return 0
        added = 0
        workers = min(max(1, self.options.concurrency), len(jobs))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(self._search_one, q, lanes, "search" if depth == 0 else "gap"): (q, sid, decoy)
                       for q, sid, lanes, decoy in jobs}
            for f in concurrent.futures.as_completed(futures):
                if _cancelled(self.cancel_token):
                    break
                q, sid, decoy = futures[f]
                try:
                    resp = f.result()
                except Exception:
                    continue
                if decoy:
                    continue
                self._stat(searches=1)
                if self.checkpoint_callback:
                    self.checkpoint_callback("search", {"provider": "all", "status": str(resp.get("status", "error")),
                                                        "error": str(resp.get("error", "")), "frontier": self.frontier.export_state()})
                if resp.get("status") != "ok":
                    continue
                added += self._seed(resp.get("results", []), q, depth, source_url, sid)
        return added

    # ------------------------------------------------------------------ fetch
    def _fetch_item(self, item):
        cand = self.cands.get(item.url, {})
        target = cand.get("oa_url") or item.url
        resp = self.collector.send_task({"task_id": _task_id("fetch"), "action": "fetch", "url": target}, self.watchlist)
        if target != item.url and (not isinstance(resp, dict) or resp.get("status") != "ok"):
            resp = self.collector.send_task({"task_id": _task_id("fetch"), "action": "fetch", "url": item.url}, self.watchlist)
        return item, resp

    def _accept(self, frontier_item, fetch_res) -> Evidence | None:
        cand = self.cands.get(frontier_item.url, {})
        ok = isinstance(fetch_res, dict) and fetch_res.get("status") == "ok"
        content = fetch_res.get("content", "") if ok else ""
        usable = isinstance(content, str) and len(content.strip()) >= 50 and not is_bot_or_js_barrier(content)
        from_abstract = False
        if not usable:
            abstract = cand.get("abstract") or ""
            if len(abstract) >= 200:
                content = f"Abstract: {abstract}"
                from_abstract = True
                fetch_res = {"status": "ok", "content": content, "links": [], "bytes": len(content)}
            else:
                self.frontier.release_candidate(frontier_item.url, doi=frontier_item.doi)
                self._stat(failed=1)
                return None

        # Drift control: link hops and citation edges that wandered off-topic are
        # discarded without consuming the document budget.
        is_hop = frontier_item.source_url not in ("initial_search", "gap_analysis")
        if frontier_item.depth > 0 and is_hop and len(self.topic_terms) >= 2:
            gate_title = cand.get("title") or (fetch_res.get("title") if isinstance(fetch_res.get("title"), str) else "")
            if self._relevance(content[:8000]) == 0.0 or not self._on_topic(gate_title or "", content):
                self.frontier.release_candidate(frontier_item.url, doi=frontier_item.doi)
                self._stat(failed=1, drifted=1)
                return None

        raw_bytes = fetch_res.get("bytes", len(content))
        is_new = self.frontier.record_document(
            url=frontier_item.url,
            content_bytes=raw_bytes if isinstance(raw_bytes, int) else len(content),
            text=content,
            doi=frontier_item.doi,
        )
        if not is_new:
            return None

        netloc = urllib.parse.urlparse(frontier_item.url).netloc
        fetched_title = fetch_res.get("title") if isinstance(fetch_res.get("title"), str) else ""
        title = self.titles.get(frontier_item.url) or cand.get("title") or fetched_title or f"Source at {netloc}"
        lane = fetch_res.get("lane") if isinstance(fetch_res.get("lane"), str) and fetch_res.get("lane") else (
            cand.get("lane") or classify_lane(frontier_item.url, frontier_item.source_url))
        meta = dict(cand.get("meta") or {})
        if isinstance(fetch_res.get("meta"), dict):
            meta.update(fetch_res["meta"])
        if fetch_res.get("renderer"):
            meta["renderer"] = fetch_res.get("renderer")
        if from_abstract:
            meta["renderer"] = "abstract"
        quality = quality_prior(frontier_item.url, lane, meta, title)
        sid = cand.get("subq") or ""
        focus = self.topic
        if self.plan is not None:
            sid = sid or reflection.assign_subq(self.plan, f"{title} {content[:6000]}")
            sq = next((s for s in self.plan.sub_questions if s.id == sid), None)
            if sq:
                focus = f"{self.topic} {sq.question}"

        excerpt_text = content[:3000]
        chunked = False
        if self.options.chunk_documents and len(content) > 1600:
            try:
                excerpt_text = reflection.best_passages(content, focus, max_chars=2800)
                chunked = True
            except Exception:
                excerpt_text = content[:3000]
        snippet = cand.get("snippet") or _snippet_from_content(content)
        source = (frontier_item.source_url or "") + ("|chunked" if chunked else "") + ("|abstract" if from_abstract else "")
        evidence = Evidence(
            title=title,
            url=frontier_item.url,
            snippet=snippet if isinstance(snippet, str) and snippet else _snippet_from_content(content),
            excerpt=excerpt_text,
            doi=frontier_item.doi,
            depth=frontier_item.depth,
            source=source,
            rerank_score=0.0,
            simhash=self.frontier.content_simhashes.get(frontier_item.url, 0),
            lane=lane,
            quality=quality,
            subq=sid,
            meta=meta,
        )
        self.lane_counts[lane] = self.lane_counts.get(lane, 0) + 1
        self._stat(fetched=1)
        if self.telemetry is not None:
            self.telemetry.source(title, frontier_item.url, lane, quality, frontier_item.depth,
                                  str(meta.get("renderer", "")), subq=sid)
        if chunked:
            self.titles[f"{frontier_item.url}#chunk"] = excerpt_text[:800]

        # Hop: content links scored by anchor text relevance.
        if frontier_item.depth < self.frontier.max_depth:
            self._seed_links(frontier_item, fetch_res)
        return evidence

    def _seed_links(self, frontier_item, fetch_res) -> None:
        link_texts = fetch_res.get("link_texts")
        pairs: list[tuple[str, str]] = []
        if isinstance(link_texts, list) and link_texts:
            for pair in link_texts:
                if isinstance(pair, (list, tuple)) and len(pair) == 2 and isinstance(pair[0], str):
                    pairs.append((pair[0], str(pair[1] or "")))
        seen = {u for u, _ in pairs}
        for link in fetch_res.get("links", []) or []:
            if isinstance(link, str) and link not in seen:
                pairs.append((link, ""))
        for link, anchor in pairs[:60]:
            can_link = canonicalize_url(link)
            if not can_link or can_link in self.cands:
                continue
            lane = classify_lane(can_link)
            if anchor:
                rel = self._relevance(anchor + " " + can_link.replace("-", " ").replace("/", " "))
                q = quality_prior(can_link, lane, None, anchor)
                base = 16.0 + 26.0 * rel + 10.0 * q
                if rel == 0.0 and "doi.org/" not in can_link:
                    base -= 8.0
            else:
                base = 30.0
            if self.frontier.add_candidate(url=can_link, depth=frontier_item.depth + 1,
                                           priority=round(base + self._lane_bonus(lane), 2),
                                           source_url=frontier_item.url):
                self._remember_candidate(can_link, {"title": anchor, "lane": lane}, base, "")

    # ------------------------------------------------------------------ reflect
    def _reflect(self, round_no: int, max_rounds: int, new_evidence: list[Evidence]) -> None:
        opts = self.options
        if self.telemetry is not None:
            self.telemetry.stage("reflect", f"Reflecting · round {round_no}/{max_rounds}")
        self.say(f"Coverage check {round_no}/{max_rounds}: looking for missing angles in what we have...")

        fresh = reflection.extract_learnings(self.topic, new_evidence or self.collected[-12:],
                                             max_items=max(3, min(10, len(new_evidence) // 2 + 2)))
        known = {item["text"] for item in self.learnings}
        for item in fresh:
            if item["text"] not in known:
                item["round"] = round_no
                self.learnings.append(item)
                if self.telemetry is not None:
                    self.telemetry.learning(item["text"], item.get("url", ""), item.get("lane", ""))

        budget = max(2, int(opts.queries_per_round))
        jobs: list[tuple[str, str, list[str], bool]] = []

        def push(q: str, sid: str = "", lanes: list[str] | None = None) -> None:
            if not q or q.lower() in self.issued or len(jobs) >= budget * 2:
                return
            self.issued.add(q.lower())
            jobs.append((q, sid, list(lanes or []), False))

        for q in _propose_gaps(self.topic, self.watchlist, opts, self.collected, self.cost_tracker,
                               self.say, gap_round=round_no):
            push(q)
        if self.plan is not None and len(self.plan.sub_questions) > 1:
            coverage = reflection.subq_coverage(self.plan, self.collected)
            for q, sid, lanes in reflection.coverage_queries(self.plan, coverage, self.issued, self.watchlist,
                                                             max_n=max(1, budget // 2)):
                push(q, sid, lanes)
        if opts.follow_leads:
            for q in reflection.lead_queries(self.topic, self.collected, self.issued, self.watchlist,
                                             max_n=max(1, budget // 2)):
                push(q)
        if opts.graph_prioritization:
            try:
                from backend.retrieval.evidence_graph import EvidenceGraph
                graph = EvidenceGraph()
                for e in self.collected[-60:]:
                    graph.add_document(e.url, e.title, e.excerpt)
                for g in graph.coverage_gaps(self.topic, max_gaps=2):
                    push(g)
            except Exception:
                pass
        if not jobs:
            evidence_dicts = [{"excerpt": e.excerpt, "content": e.excerpt, "url": e.url, "title": e.title}
                              for e in self.collected[-30:]]
            for g in LocalSynthesizer(probe=False).analyze_gaps(self.topic, evidence_dicts):
                push(g)
        jobs = jobs[: budget + 2]

        if self.telemetry is not None:
            self.telemetry.round(round_no, max_rounds, [j[0] for j in jobs])
            self.telemetry.stage("search", f"Searching · round {round_no}")
        if jobs:
            self.say(f"Round {round_no}: following {len(jobs)} new lead(s) — " + "; ".join(j[0] for j in jobs[:3])
                     + ("…" if len(jobs) > 3 else ""))
        self._run_searches(jobs, depth=min(1, self.frontier.max_depth), source_url="gap_analysis")

        if opts.citation_expansion and not _cancelled(self.cancel_token):
            self._expand_citations()

        # Lane balance drifts as evidence arrives; re-score the queue.
        self._rescore_queue()
        if self.telemetry is not None:
            self.telemetry.set(queue=len(self.frontier.queue))

    def _expand_citations(self) -> int:
        return _expand_citation_edges(self.collected, self.options, self.collector, self.watchlist, self.titles,
                                      self.frontier, self.say, cands=self.cands, expanded=self.citations_expanded,
                                      topic=self.topic)

    # ------------------------------------------------------------------ run
    def run(self) -> list[Evidence]:
        opts = self.options
        frontier = self.frontier
        if self.telemetry is not None:
            self.telemetry.stage("search", "Searching")
        lanes_note = ""
        if self.targets:
            lanes_note = f" across {len(self.targets)} source lanes"
        self.say(f"Searching {len(self.real_queries)} angle(s){lanes_note} — academic, community, and web sources...")

        if not (self.resumed and frontier.queue):
            jobs = []
            for q in self.real_queries:
                sid, lanes = self.subq_by_query.get(q.text.lower(), ("", []))
                jobs.append((q.text, sid, lanes, False))
            for q in self.decoys:
                jobs.append((q.text, "", [], True))
            self._run_searches(jobs, depth=0, source_url="initial_search")

        gain_tracker = InformationGainTracker(opts.low_information_gain_rounds, self.collected)
        max_rounds = max(0, int(opts.max_gap_rounds))
        rounds_done = 0
        round_quota = max(self.batch_size * 2, math.ceil(int(opts.max_documents) / (max_rounds + 1)))
        since_round: list[Evidence] = []
        current_depth = 0
        if self.telemetry is not None:
            self.telemetry.stage("read", "Reading sources")

        while True:
            if _cancelled(self.cancel_token):
                self.say("Stopped. Compiling what we have so far...")
                break
            if not frontier.should_continue():
                break
            need_round = (not frontier.queue) or len(since_round) >= round_quota
            if need_round and rounds_done < max_rounds and len(self.collected) >= 2:
                rounds_done += 1
                self._reflect(rounds_done, max_rounds, since_round)
                since_round = []
                if self.telemetry is not None:
                    self.telemetry.stage("read", f"Reading · round {rounds_done}")
            if not frontier.queue or not frontier.should_continue():
                break

            self.say(
                f"Reading sources (hop {current_depth}, "
                f"{frontier.documents_collected}/{frontier.max_documents} kept, "
                f"{len(frontier.queue)} waiting)..."
            )
            if self.targets and self.batch_size > 1:
                batch = frontier.pop_next_batch(
                    batch_size=self.batch_size,
                    group_of=lambda item: self.cands.get(item.url, {}).get("lane", "web"))
            else:
                batch = frontier.pop_next_batch(batch_size=self.batch_size)
            if not batch:
                break

            batch_accepted: list[Evidence] = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(batch), self.batch_size)) as executor:
                fetch_futures = [executor.submit(self._fetch_item, item) for item in batch]
                for future in concurrent.futures.as_completed(fetch_futures):
                    if _cancelled(self.cancel_token):
                        break
                    try:
                        frontier_item, fetch_res = future.result()
                    except Exception:
                        continue
                    evidence = self._accept(frontier_item, fetch_res)
                    if evidence is None:
                        continue
                    current_depth = max(current_depth, frontier_item.depth)
                    self.collected.append(evidence)
                    batch_accepted.append(evidence)
                    if self.checkpoint_callback:
                        self.checkpoint_callback("evidence", {"provider": "fetch", "status": "ok", "evidence": evidence,
                                                              "frontier": frontier.export_state()})
            since_round.extend(batch_accepted)
            if batch_accepted:
                self._rescore_queue()
            if self.telemetry is not None:
                self.telemetry.set(queue=len(frontier.queue))

            observation = gain_tracker.observe_batch(batch_accepted, frontier)
            if self.checkpoint_callback:
                self.checkpoint_callback("fetch", {"provider": "fetch", "status": "ok", "accepted": len(batch_accepted),
                                                   "low_gain": observation.low_gain, "frontier": frontier.export_state()})
            if gain_tracker.should_stop(opts.low_information_gain_min_documents):
                queued_citations = [item for item in frontier.queue if item.source_url.startswith("citations:")]
                best_ordinary = max((item.priority for item in frontier.queue if not item.source_url.startswith("citations:")), default=float("-inf"))
                if not any(item.priority > best_ordinary for item in queued_citations):
                    if self.stop_callback:
                        self.stop_callback("low_information_gain")
                    break

        if not frontier.should_continue() and self.stop_callback and not _cancelled(self.cancel_token):
            if frontier.documents_collected >= frontier.max_documents:
                self.stop_callback("document_budget")
            else:
                self.stop_callback("time_budget")
        return self.collected
