"""DuckDuckGo Search Engine Scraper.

Executes direct HTML searches against DuckDuckGo with Chrome TLS 124 impersonation
and query unescaping.
"""

import logging
import re
import urllib.parse

from backend.retrieval.meta import engine_health

logger = logging.getLogger("searxng_service")

# Check curl_cffi availability
try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    import urllib.request
    HAS_CURL_CFFI = False

# Check lxml availability
try:
    from lxml import html as lxml_html
    HAS_LXML = True
except ImportError:
    HAS_LXML = False


def search_duckduckgo(query: str, max_results: int = 10) -> list[dict]:
    """Search DuckDuckGo HTML using Chrome TLS impersonation or standard HTTP."""
    if not query.strip():
        return []
    if not engine_health.available("duckduckgo"):
        return []
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote_plus(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    raw_html = ""
    try:
        if HAS_CURL_CFFI:
            with engine_health.throttle("duckduckgo"):
                resp = cffi_requests.get(url, headers=headers, impersonate="chrome124", timeout=8)
            if resp.status_code == 200:
                raw_html = resp.text
        else:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as r:
                raw_html = r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.debug(f"DuckDuckGo fetch failed: {e}")
        engine_health.report("duckduckgo", False)
        return []

    if not raw_html:
        engine_health.report("duckduckgo", False)
        return []

    items = []
    if HAS_LXML:
        try:
            tree = lxml_html.fromstring(raw_html)
            for div in tree.xpath('//div[contains(@class, "result ")]'):
                link_elem = div.xpath('.//a[contains(@class, "result__a")]')
                snippet_elem = div.xpath('.//a[contains(@class, "result__snippet")]')
                if link_elem:
                    title = link_elem[0].text_content().strip()
                    raw_href = link_elem[0].get("href", "")
                    parsed = urllib.parse.urlparse(raw_href)
                    qs = urllib.parse.parse_qs(parsed.query)
                    target_url = qs.get("uddg", [raw_href])[0] if "uddg" in qs else raw_href
                    snippet = snippet_elem[0].text_content().strip() if snippet_elem else ""
                    if target_url.startswith("http") and "duckduckgo.com/y.js" not in target_url and "ad_provider=" not in target_url:
                        items.append({
                            "title": title,
                            "url": target_url,
                            "content": snippet,
                            "engine": "duckduckgo",
                        })
                    if len(items) >= max_results:
                        break
        except Exception as e:
            logger.debug(f"LXML parsing failed for DDG: {e}")
    else:
        matches = re.findall(r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', raw_html, re.DOTALL)
        for raw_href, raw_title in matches[:max_results]:
            clean_title = re.sub(r'<[^>]+>', '', raw_title).strip()
            parsed = urllib.parse.urlparse(raw_href)
            qs = urllib.parse.parse_qs(parsed.query)
            target_url = qs.get("uddg", [raw_href])[0] if "uddg" in qs else raw_href
            if target_url.startswith("http") and "duckduckgo.com/y.js" not in target_url and "ad_provider=" not in target_url:
                items.append({
                    "title": clean_title,
                    "url": target_url,
                    "content": "",
                    "engine": "duckduckgo",
                })
    engine_health.report("duckduckgo", bool(items))
    return items
