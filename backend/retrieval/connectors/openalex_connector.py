"""OpenAlex Academic Works Connector.

Queries OpenAlex API for scholarly works, authors, and citation metadata.
"""

import httpx


def search_openalex(query: str) -> list[dict]:
    """Search OpenAlex academic works."""
    try:
        url = "https://api.openalex.org/works"
        params = {"search": query, "per-page": 25}
        headers = {"User-Agent": "DeepSearch/2.0 (mailto:research@example.org)"}
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for item in data.get("results", []):
                    landing_url = item.get("doi") or item.get("id") or ""
                    results.append({
                        "title": item.get("display_name", ""),
                        "url": landing_url,
                        "doi": item.get("doi", ""),
                        "snippet": f"Published {item.get('publication_year', '')} in {item.get('host_venue', {}).get('display_name', '')}",
                        "source": "openalex"
                    })
                return results
    except Exception:
        pass
    return []
