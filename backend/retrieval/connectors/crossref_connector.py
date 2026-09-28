"""Crossref DOI Registry Connector with Polite Pool Routing.

Queries Crossref REST API for peer-reviewed journal publications and DOIs.
Routes requests to the fast Crossref Polite Pool using mailto headers to
prevent 429 rate-limiting and ensure reliable academic discovery.
"""

import httpx

_API_URL = "https://api.crossref.org/works"
_MAILTO = "research@deepsearch.local"
_HEADERS = {"User-Agent": f"DeepSearchBot/2.0 (mailto:{_MAILTO})"}


def search_crossref(query: str, rows: int = 25) -> list[dict]:
    """Search Crossref DOI registry via the polite pool."""
    if not query or not isinstance(query, str) or not query.strip():
        return []
    try:
        params = {
            "query": query.strip(),
            "rows": rows,
            "mailto": _MAILTO
        }
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(_API_URL, params=params, headers=_HEADERS)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for item in data.get("message", {}).get("items", []) or []:
                    if not isinstance(item, dict):
                        continue
                    titles = item.get("title") or [""]
                    title = titles[0] if titles and isinstance(titles, list) else "Untitled Crossref Work"
                    doi = item.get("DOI") or ""
                    landing_url = item.get("URL") or (f"https://doi.org/{doi}" if doi else "")
                    containers = item.get("container-title") or [""]
                    container = containers[0] if containers and isinstance(containers, list) else ""
                    if not landing_url:
                        continue
                    snippet = f"Crossref peer-reviewed publication ({container})" if container else "Crossref peer-reviewed publication"
                    results.append({
                        "title": str(title),
                        "url": str(landing_url),
                        "doi": str(doi),
                        "snippet": snippet,
                        "source": "crossref"
                    })
                return results
    except Exception:
        pass
    return []
