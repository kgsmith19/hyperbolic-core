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
                for hit in data.get("hits", {}).get("hits", [])[:6]:
                    src = hit.get("_source", {})
                    form = src.get("form", "Filing")
                    display_name = src.get("display_names", [""])[0]
                    file_id = hit.get("_id", "")
                    doc_url = f"https://www.sec.gov/Archives/edgar/data/{file_id}"
                    results.append({
                        "title": f"SEC {form} - {display_name}",
                        "url": doc_url,
                        "snippet": f"SEC EDGAR corporate filing form {form}",
                        "source": "sec_edgar"
                    })
                return results
    except Exception:
        pass
    return []
