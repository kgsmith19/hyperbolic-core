"""SEC EDGAR Corporate Filings Connector.

Queries SEC EDGAR LTSearchService for public 10-K, 10-Q, 8-K, and corporate disclosures.
"""

import httpx


def search_sec_edgar(query: str) -> list[dict]:
    """Search SEC EDGAR corporate filings."""
    try:
        url = "https://efts.sec.gov/LTSearchService/rest/search"
        params = {"q": query}
        headers = {
            "User-Agent": "DeepSearchCorp research@deepsearchcorp.com",
            "Accept": "application/json"
        }
        with httpx.Client(timeout=6.0, follow_redirects=True) as client:
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for hit in data.get("hits", {}).get("hits", [])[:25]:
                    src = hit.get("_source", {}) if isinstance(hit, dict) else {}
                    form = src.get("form", "Filing") or "Filing"
                    names = src.get("display_names", [""]) or [""]
                    display_name = names[0] if names else ""
                    file_id = hit.get("_id", "") if isinstance(hit, dict) else ""
                    ciks = src.get("ciks", []) or []
                    filed = src.get("file_date", "") or src.get("filedAt", "") or ""
                    if ciks and file_id:
                        cik = str(ciks[0]).lstrip("0") or "0"
                        acc = str(file_id).replace("-", "")
                        doc_url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/index.json"
                    else:
                        doc_url = f"https://www.sec.gov/Archives/edgar/data/{file_id}"
                    snippet_bits = [f"SEC EDGAR corporate filing form {form}"]
                    if filed:
                        snippet_bits.append(f"filed {filed}")
                    results.append({
                        "title": f"SEC {form} - {display_name}" if display_name else f"SEC {form} filing",
                        "url": doc_url,
                        "snippet": ". ".join(snippet_bits),
                        "source": "sec_edgar"
                    })
                return results
    except Exception:
        pass
    return []
