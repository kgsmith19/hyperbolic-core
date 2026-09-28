"""OpenAlex Academic Works Connector with citation-graph expansion.

Queries OpenAlex API for scholarly works plus authorship, concept, and
citation metadata. Two entry points:

- search_openalex: keyword search, enriched with authors, concepts,
  citation counts, and referenced-work IDs (citation graph edges).
- expand_citations: given an OpenAlex work ID or DOI, return its most-cited
  references and citing works as frontier-ready search results. This is the
  GraphRAG-style traversal from the research: follow citation edges instead
  of keyword-matching again, so depth compounds instead of drifting.
"""

import httpx

_API = "https://api.openalex.org/works"
_HEADERS = {"User-Agent": "DeepSearch/2.0 (mailto:research@example.org)"}


def _work_to_result(item: dict) -> dict:
    authorships = item.get("authorships", []) or []
    authors = ", ".join(
        (a.get("author", {}) or {}).get("display_name", "")
        for a in authorships[:3]
    )
    concepts = [c.get("display_name", "") for c in (item.get("concepts", []) or [])[:3]]
    venue = (item.get("host_venue", {}) or {}).get("display_name", "")
    year = item.get("publication_year", "")
    cited_by = item.get("cited_by_count", 0)
    snippet_bits = [f"Published {year}" + (f" in {venue}" if venue else "")]
    if authors:
        snippet_bits.append(f"by {authors}")
    if concepts:
        snippet_bits.append(f"Topics: {', '.join(concepts)}")
    if cited_by:
        snippet_bits.append(f"Cited by {cited_by}")
    return {
        "title": item.get("display_name", "") or "Untitled OpenAlex Work",
        "url": item.get("doi") or item.get("id") or "",
        "doi": item.get("doi", "") or "",
        "snippet": ". ".join(b for b in snippet_bits if b),
        "source": "openalex",
        "cited_by_count": cited_by,
        "openalex_id": item.get("id", ""),
        "referenced_works": item.get("referenced_works", []) or [],
        "concepts": concepts,
    }


def search_openalex(query: str) -> list[dict]:
    """Search OpenAlex academic works, enriched with citation metadata."""
    try:
        params = {"search": query, "per-page": 25}
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(_API, params=params, headers=_HEADERS)
            if resp.status_code == 200:
                return [_work_to_result(item) for item in resp.json().get("results", [])]
    except Exception:
        pass
    return []


def expand_citations(
    work_id: str,
    direction: str = "references",
    per_page: int = 10,
) -> list[dict]:
    """Expand one work along the citation graph (references or cited-by).

    work_id may be an OpenAlex ID (https://openalex.org/W...) or a DOI URL.
    Returns frontier-ready results tagged source=openalex-citations so the
    explorer can prioritize citation edges above generic keyword hits.
    """
    if not work_id or not isinstance(work_id, str):
        return []
    work_id = work_id.strip()
    if not work_id:
        return []
    try:
        if direction == "cited_by":
            params: dict = {"filter": f"cites:{work_id}", "per-page": per_page,
                            "sort": "cited_by_count:desc"}
            with httpx.Client(timeout=8.0) as client:
                resp = client.get(_API, params=params, headers=_HEADERS)
                if resp.status_code == 200:
                    out = [_work_to_result(i) for i in resp.json().get("results", [])]
                    for r in out:
                        r["source"] = "openalex-citations"
                    return out
            return []
        # references: fetch the work, then batch-fetch its referenced works
        with httpx.Client(timeout=8.0) as client:
            clean = work_id.replace("https://doi.org/", "https://doi.org/")
            resp = client.get(f"{_API}/{clean}" if clean.startswith("https://openalex.org/") else _API,
                              params={"filter": f"doi:{work_id}"} if work_id.startswith("https://doi.org/") else {"filter": f"openalex:{work_id.split('/')[-1]}"} if work_id.startswith("https://openalex.org/") else {"search": work_id, "per-page": 1},
                              headers=_HEADERS)
            if resp.status_code != 200:
                return []
            data = resp.json()
            items = data.get("results", [data] if "referenced_works" in data else [])
            if not items:
                return []
            ref_ids = (items[0].get("referenced_works", []) or [])[:per_page]
            if not ref_ids:
                return []
            short_ids = [r.split("/")[-1] for r in ref_ids]
            resp2 = client.get(_API, params={"filter": f"openalex:{'|'.join(short_ids)}",
                                             "per-page": per_page}, headers=_HEADERS)
            if resp2.status_code != 200:
                return []
            out = [_work_to_result(i) for i in resp2.json().get("results", [])]
            for r in out:
                r["source"] = "openalex-citations"
            return out
    except Exception:
        return []
