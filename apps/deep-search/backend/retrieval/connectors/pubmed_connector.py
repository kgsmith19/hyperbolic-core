"""PubMed Central (PMC) & NCBI E-Utilities Open-Access Connector.

Queries NCBI E-Utilities (`esearch` + `esummary`) for peer-reviewed biomedical,
biochemical, pharmacological, and physical science papers published in PMC.
Free, open-access, keyless, and provides direct DOIs and PMC IDs.
"""

import httpx

_BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_HEADERS = {"User-Agent": "DeepSearchBot/2.0 (contact: research@deepsearch.local)"}


def search_pubmed(query: str, max_results: int = 15) -> list[dict]:
    """Search PubMed Central for full open-access papers and metadata."""
    if not query or not isinstance(query, str) or not query.strip():
        return []
    try:
        search_url = f"{_BASE_URL}/esearch.fcgi"
        params = {"db": "pmc", "term": query.strip(), "retmode": "json", "retmax": max_results}
        with httpx.Client(timeout=8.0) as client:
            r = client.get(search_url, params=params, headers=_HEADERS)
            if r.status_code != 200:
                return []
            ids = r.json().get("esearchresult", {}).get("idlist", [])
            if not ids:
                return []

            sum_url = f"{_BASE_URL}/esummary.fcgi"
            sum_params = {"db": "pmc", "id": ",".join(ids), "retmode": "json"}
            r2 = client.get(sum_url, params=sum_params, headers=_HEADERS)
            if r2.status_code != 200:
                return []

            result_data = r2.json().get("result", {})
            results = []
            for uid in ids:
                item = result_data.get(str(uid), {})
                if not isinstance(item, dict):
                    continue
                title = item.get("title") or f"PMC Research Article {uid}"
                doi = ""
                for aid in item.get("articleids", []) or []:
                    if isinstance(aid, dict) and aid.get("idtype") == "doi":
                        doi = aid.get("value") or ""
                        break
                pmc_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{uid}/"
                pubdate = item.get("pubdate") or ""
                authors = ", ".join(
                    a.get("name") or ""
                    for a in (item.get("authors") or [])[:3]
                    if isinstance(a, dict) and a.get("name")
                )
                snippet_parts = [f"PubMed Central Open Access (PMC{uid})"]
                if pubdate:
                    snippet_parts.append(f"Published {pubdate}")
                if authors:
                    snippet_parts.append(f"by {authors}")

                results.append({
                    "title": title,
                    "url": pmc_url,
                    "doi": doi,
                    "snippet": ". ".join(snippet_parts),
                    "source": "pubmed_pmc"
                })
            return results
    except Exception:
        return []
