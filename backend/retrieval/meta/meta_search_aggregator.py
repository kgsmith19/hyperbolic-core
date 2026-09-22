"""Concurrent Meta-Search Aggregator.

Executes concurrent searches across DuckDuckGo and Bing, deduplicates URLs,
and normalizes results for SearXNG output schemas.
"""

import concurrent.futures
import logging
from backend.retrieval.meta.duckduckgo_search_engine import search_duckduckgo
from backend.retrieval.meta.bing_search_engine import search_bing

logger = logging.getLogger("searxng_service")


def aggregate_meta_search(query: str, max_results: int = 20) -> list[dict]:
    """Execute concurrent multi-engine search across DuckDuckGo and Bing."""
    results = []
    seen_urls = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f_ddg = executor.submit(search_duckduckgo, query, 12)
        f_bing = executor.submit(search_bing, query, 12)

        for f in (f_ddg, f_bing):
            try:
                items = f.result(timeout=10)
                for item in items:
                    norm = item["url"].rstrip("/").lower()
                    if norm not in seen_urls:
                        seen_urls.add(norm)
                        results.append(item)
            except Exception as err:
                logger.debug(f"Meta-search worker error: {err}")

    return results[:max_results]
