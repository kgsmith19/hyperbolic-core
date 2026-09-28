"""arXiv Preprint Server Connector.

Queries arXiv Atom feed XML endpoint and parses papers, abstracts, and identifiers.
"""

import urllib.parse
import xml.etree.ElementTree as ET
import httpx


def search_arxiv(query: str) -> list[dict]:
    """Search arXiv preprint server."""
    try:
        clean_q = urllib.parse.quote(query)
        url = f"https://export.arxiv.org/api/query?search_query=all:{clean_q}&start=0&max_results=25"
        headers = {"User-Agent": "DeepSearch/2.0"}
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
            if resp.status_code == 200:
                root = ET.fromstring(resp.text)
                ns = {"atom": "http://www.w3.org/2005/Atom"}
                results = []
                for entry in root.findall("atom:entry", ns):
                    t_elem = entry.find("atom:title", ns)
                    s_elem = entry.find("atom:summary", ns)
                    id_elem = entry.find("atom:id", ns)
                    title = t_elem.text.strip().replace("\n", " ") if t_elem is not None else "Untitled arXiv Paper"
                    snippet = s_elem.text.strip().replace("\n", " ")[:300] if s_elem is not None else ""
                    link = id_elem.text.strip() if id_elem is not None else ""
                    results.append({
                        "title": title,
                        "url": link,
                        "snippet": snippet,
                        "source": "arxiv"
                    })
                return results
    except Exception:
        pass
    return []
