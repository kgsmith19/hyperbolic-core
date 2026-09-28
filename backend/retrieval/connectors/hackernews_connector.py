"""Hacker News Algolia Search API Connector.

Queries Algolia's official Hacker News Search API for practitioner breakthroughs,
university lab announcements, technical benchmarks, and in-depth engineering discussions.
Free, open-access, keyless, and provides direct discussion URLs and comment counts.
"""

import httpx

_ALGOLIA_URL = "https://hn.algolia.com/api/v1/search"
_HEADERS = {"User-Agent": "DeepSearchEngine/2.0 (contact: research@deepsearch.local)"}


def search_hackernews(query: str, max_results: int = 10) -> list[dict]:
    """Search Hacker News for engineering discussions and breakthrough stories."""
    if not query or not isinstance(query, str) or not query.strip():
        return []
    try:
        params = {"query": query.strip(), "hitsPerPage": max_results}
        with httpx.Client(timeout=8.0) as client:
            r = client.get(_ALGOLIA_URL, params=params, headers=_HEADERS)
            if r.status_code != 200:
                return []
            hits = r.json().get("hits", []) or []
            results = []
            for h in hits:
                if not isinstance(h, dict):
                    continue
                title = h.get("title") or h.get("story_title") or "Hacker News Discussion"
                story_url = h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID', '')}"
                points = h.get("points", 0) or 0
                num_comments = h.get("num_comments", 0) or 0
                created_at = (h.get("created_at") or "")[:10]

                snippet_parts = ["Hacker News practitioner discussion"]
                if created_at:
                    snippet_parts.append(f"({created_at})")
                snippet_parts.append(f"{points} points, {num_comments} comments")

                results.append({
                    "title": f"HN: {title} ({points} pts, {num_comments} comments)",
                    "url": story_url,
                    "snippet": " ".join(snippet_parts),
                    "source": "hackernews"
                })
            return results
    except Exception:
        return []
