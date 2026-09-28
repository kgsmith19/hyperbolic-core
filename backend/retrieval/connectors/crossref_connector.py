"""Crossref DOI Registry Connector.

Queries Crossref REST API for peer-reviewed journal publications and DOIs.
"""

import httpx


def search_crossref(query: str) -> list[dict]:
    """Search Crossref DOI registry."""
    try:
        url = "https://api.crossref.org/works"
        params = {"query": query, "rows": 25}
        headers = {"User-Agent": "DeepSearch/2.0 (mailto:research@example.org)"}
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for item in data.get("message", {}).get("items", []):
                    titles = item.get("title") or [""]
                    doi = item.get("DOI", "")
                    landing_url = item.get("URL") or (f"https://doi.org/{doi}" if doi else "")
                    container = (item.get("container-title") or [""])[0]
                    results.append({
                        "title": titles[0] if titles else "Untitled Crossref Work",
                        "url": landing_url,
                        "doi": doi,
                        "snippet": f"Crossref entry ({container})",
                        "source": "crossref"
                    })
                return results
    except Exception:
        pass
    return []
