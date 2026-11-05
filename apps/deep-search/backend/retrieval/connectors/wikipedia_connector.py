"""Wikipedia REST API Structured Entity & Encyclopedia Connector.

Queries Wikipedia MediaWiki REST API v1 for entity definitions,
technical concept disambiguation, and canonical encyclopedic references.
Free, keyless, fast, and structured.
"""

import httpx

_REST_URL = "https://en.wikipedia.org/w/rest.php/v1/search/page"
_HEADERS = {"User-Agent": "DeepSearchEngine/2.0 (contact: research@deepsearch.local)"}


def search_wikipedia(query: str, max_results: int = 10) -> list[dict]:
    """Search Wikipedia pages and return clean structured encyclopedic summaries."""
    if not query or not isinstance(query, str) or not query.strip():
        return []
    try:
        params = {"q": query.strip(), "limit": max_results}
        with httpx.Client(timeout=8.0) as client:
            r = client.get(_REST_URL, params=params, headers=_HEADERS)
            if r.status_code != 200:
                return []
            pages = r.json().get("pages", []) or []
            results = []
            for p in pages:
                if not isinstance(p, dict):
                    continue
                key = p.get("key") or ""
                title = p.get("title") or ""
                desc = p.get("description") or ""
                excerpt = p.get("excerpt") or ""
                # Strip HTML highlight tags from API excerpt
                clean_excerpt = (
                    excerpt.replace('<span class="searchmatch">', "")
                    .replace("</span>", "")
                    .replace("<span classsearchmatch>", "")
                    .replace("/span", "")
                    .strip()
                )
                if not key or not title:
                    continue
                results.append({
                    "title": f"Wikipedia: {title}",
                    "url": f"https://en.wikipedia.org/wiki/{key}",
                    "snippet": desc or clean_excerpt,
                    "source": "wikipedia"
                })
            return results
    except Exception:
        return []
