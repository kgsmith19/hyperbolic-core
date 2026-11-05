"""Additional keyless scholarly indexes: Semantic Scholar, Europe PMC, DOAJ.

Each returns frontier-ready dicts. When the index exposes an abstract it is
returned under ``abstract`` so the explorer can keep abstract-level evidence
even when the publisher landing page is paywalled or bot-walled.
"""

from __future__ import annotations

import os
import re
import time

import httpx

_UA = {"User-Agent": "DeepSearch/3.0 (open research tool; mailto:research@deepsearch.local)"}


def _clean(text) -> str:
    if not isinstance(text, str):
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def search_semantic_scholar(query: str, limit: int = 20) -> list[dict]:
    """Semantic Scholar Graph API (key optional via SEMANTIC_SCHOLAR_API_KEY)."""
    if not query or not query.strip():
        return []
    headers = dict(_UA)
    key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()
    if key:
        headers["x-api-key"] = key
    params = {
        "query": query.strip()[:300],
        "limit": max(1, min(100, limit)),
        "fields": "title,abstract,url,year,citationCount,influentialCitationCount,venue,authors,externalIds,openAccessPdf,tldr",
    }
    for attempt in range(2):
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get("https://api.semanticscholar.org/graph/v1/paper/search", params=params, headers=headers)
            if resp.status_code == 429 and attempt == 0:
                time.sleep(1.5)
                continue
            if resp.status_code != 200:
                return []
            out = []
            for item in resp.json().get("data", []) or []:
                if not isinstance(item, dict):
                    continue
                ext = item.get("externalIds") or {}
                doi = ext.get("DOI") or ""
                url = f"https://doi.org/{doi}" if doi else (item.get("url") or "")
                if not url:
                    continue
                authors = ", ".join(a.get("name", "") for a in (item.get("authors") or [])[:4] if isinstance(a, dict))
                abstract = _clean(item.get("abstract") or ((item.get("tldr") or {}).get("text") if isinstance(item.get("tldr"), dict) else ""))
                year = item.get("year") or ""
                venue = item.get("venue") or ""
                cites = item.get("citationCount") or 0
                snippet = ". ".join(b for b in [
                    f"{venue} {year}".strip(), f"by {authors}" if authors else "",
                    f"Cited by {cites}" if cites else "", abstract[:240],
                ] if b)
                out.append({
                    "title": _clean(item.get("title")) or "Untitled paper",
                    "url": url,
                    "doi": doi,
                    "snippet": snippet,
                    "abstract": abstract,
                    "source": "semantic_scholar",
                    "lane": "academic",
                    "oa_url": ((item.get("openAccessPdf") or {}).get("url") if isinstance(item.get("openAccessPdf"), dict) else "") or "",
                    "meta": {"authors": authors, "year": str(year), "venue": venue, "citations": int(cites or 0),
                             "influential": int(item.get("influentialCitationCount") or 0)},
                })
            return out
        except Exception:
            return []
    return []


def search_europepmc(query: str, limit: int = 20) -> list[dict]:
    """Europe PMC REST search (core results include abstracts)."""
    if not query or not query.strip():
        return []
    try:
        params = {"query": query.strip()[:300], "format": "json", "resultType": "core",
                  "pageSize": max(1, min(100, limit))}
        with httpx.Client(timeout=10.0) as client:
            resp = client.get("https://www.ebi.ac.uk/europepmc/webservices/rest/search", params=params, headers=_UA)
        if resp.status_code != 200:
            return []
        out = []
        for item in (resp.json().get("resultList") or {}).get("result", []) or []:
            if not isinstance(item, dict):
                continue
            doi = item.get("doi") or ""
            pmcid = item.get("pmcid") or ""
            pmid = item.get("pmid") or ""
            if pmcid:
                url = f"https://europepmc.org/article/PMC/{pmcid}"
            elif pmid:
                url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
            elif doi:
                url = f"https://doi.org/{doi}"
            else:
                continue
            abstract = _clean(item.get("abstractText"))
            journal = ((item.get("journalInfo") or {}).get("journal") or {}).get("title", "") if isinstance(item.get("journalInfo"), dict) else ""
            year = item.get("pubYear") or ""
            cites = item.get("citedByCount") or 0
            pub_types = (item.get("pubTypeList") or {}).get("pubType", []) if isinstance(item.get("pubTypeList"), dict) else []
            kind = next((t for t in pub_types if isinstance(t, str) and any(k in t.lower() for k in ("review", "meta-analysis", "trial"))), "")
            out.append({
                "title": _clean(item.get("title")) or "Untitled article",
                "url": url,
                "doi": doi,
                "snippet": ". ".join(b for b in [f"{journal} {year}".strip(), kind, f"Cited by {cites}" if cites else "", abstract[:240]] if b),
                "abstract": abstract,
                "source": "europepmc",
                "lane": "academic",
                "meta": {"authors": _clean(item.get("authorString"))[:160], "year": str(year), "venue": journal,
                         "citations": int(cites or 0), "kind": kind},
            })
        return out
    except Exception:
        return []


def search_doaj(query: str, limit: int = 15) -> list[dict]:
    """Directory of Open Access Journals article search (peer-reviewed OA)."""
    if not query or not query.strip():
        return []
    try:
        safe = httpx.URL("https://doaj.org/api/search/articles/" + query.strip()[:200].replace("/", " "))
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(safe, params={"pageSize": max(1, min(50, limit))}, headers=_UA)
        if resp.status_code != 200:
            return []
        out = []
        for item in resp.json().get("results", []) or []:
            bib = (item or {}).get("bibjson") or {}
            doi = next((i.get("id", "") for i in bib.get("identifier", []) if isinstance(i, dict) and i.get("type") == "doi"), "")
            link = next((l.get("url", "") for l in bib.get("link", []) if isinstance(l, dict) and l.get("url")), "")
            url = f"https://doi.org/{doi}" if doi else link
            if not url:
                continue
            abstract = _clean(bib.get("abstract"))
            journal = (bib.get("journal") or {}).get("title", "")
            year = bib.get("year") or ""
            out.append({
                "title": _clean(bib.get("title")) or "Untitled OA article",
                "url": url,
                "doi": doi,
                "snippet": ". ".join(b for b in [f"{journal} {year}".strip(), "Open-access peer-reviewed", abstract[:240]] if b),
                "abstract": abstract,
                "source": "doaj",
                "lane": "academic",
                "oa_url": link,
                "meta": {"authors": ", ".join(a.get("name", "") for a in bib.get("author", [])[:4] if isinstance(a, dict)),
                         "year": str(year), "venue": journal},
            })
        return out
    except Exception:
        return []
