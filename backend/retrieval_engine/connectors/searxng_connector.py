"""SearXNG Connector with In-Process Aggregator Fallback.

Queries the local or remote SearXNG endpoint at 127.0.0.1:8080 with automatic,
graceful fallback to the built-in meta-search aggregator.
"""

import os
import sys
import httpx
from backend.meta_search.meta_search_aggregator import aggregate_meta_search

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}


def search_searxng(query: str, searxng_url: str | None = None) -> list[dict]:
    """Search SearXNG instance with automatic fallback to built-in meta-search engine."""
    endpoint_base = (searxng_url or os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080")).rstrip("/")
    try:
        url = f"{endpoint_base}/search"
        params = {"q": query, "format": "json"}
        with httpx.Client(timeout=6.0) as client:
            resp = client.get(url, params=params, headers=DEFAULT_HEADERS)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for item in data.get("results", [])[:10]:
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "snippet": item.get("content", ""),
                        "source": "searxng"
                    })
                if results:
                    return results
    except Exception:
        pass

    # Resilient fallback: Query built-in DuckDuckGo + Bing meta-search aggregator
    try:
        meta_items = aggregate_meta_search(query, max_results=10)
        if meta_items:
            return [
                {
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("content", ""),
                    "source": f"searxng:{item.get('engine', 'meta')}"
                }
                for item in meta_items
            ]
    except Exception:
        pass

    return []
