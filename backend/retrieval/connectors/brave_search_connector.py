"""Brave Search API Connector.

Queries Brave Search REST API if BRAVE_SEARCH_API_KEY is configured.
"""

import os
import httpx


def search_brave(query: str) -> list[dict]:
    """Search Brave Search API if API key is set."""
    api_key = os.environ.get("BRAVE_SEARCH_API_KEY", "").strip()
    if not api_key:
        return []
    try:
        endpoint = "https://api.search.brave.com/res/v1/web/search"
        headers = {
            "Accept": "application/json",
            "X-Subscription-Token": api_key,
            "User-Agent": "DeepSearch/2.0",
        }
        params = {"q": query, "count": 20}
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(endpoint, headers=headers, params=params)
            if resp.status_code == 200:
                raw_results = resp.json().get("web", {}).get("results", [])
                results = []
                for item in raw_results[:20]:
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "snippet": item.get("description", ""),
                        "source": "brave"
                    })
                return results
    except Exception:
        pass
    return []
