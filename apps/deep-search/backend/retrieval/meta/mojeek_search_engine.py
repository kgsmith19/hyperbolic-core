"""Mojeek Search Engine Scraper (independent index, no Big-Tech backend).

Mojeek runs its own crawler and index (no Google/Bing syndication), so it
surfaces pages DDG/Bing omit. Direct HTML scrape with Chrome TLS
impersonation, same pattern as the DDG/Bing engines.
"""

import logging
import re
import urllib.parse

from backend.retrieval.meta import engine_health

logger = logging.getLogger("searxng_service")

try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    import urllib.request
    HAS_CURL_CFFI = False

try:
    from lxml import html as lxml_html
    HAS_LXML = True
except ImportError:
    HAS_LXML = False


def search_mojeek(query: str, max_results: int = 10) -> list[dict]:
    """Search Mojeek HTML using Chrome TLS impersonation."""
    if not query or not query.strip():
        return []
    if not engine_health.available("mojeek"):
        return []
    url = f"https://www.mojeek.com/search?q={urllib.parse.quote_plus(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    raw_html = ""
    try:
        if HAS_CURL_CFFI:
            with engine_health.throttle("mojeek"):
                resp = cffi_requests.get(url, headers=headers, impersonate="chrome124", timeout=8)
            if resp.status_code == 200:
                raw_html = resp.text
        else:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as r:
                raw_html = r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.debug(f"Mojeek fetch failed: {e}")
        engine_health.report("mojeek", False)
        return []

    if not raw_html:
        engine_health.report("mojeek", False)
        return []

    items = []
    if HAS_LXML:
        try:
            tree = lxml_html.fromstring(raw_html)
            for li in tree.xpath('//ul[contains(@class, "results-standard")]//li'):
                link = li.xpath('.//h2/a | .//a[contains(@class, "title")]')
                snippet = li.xpath('.//p[contains(@class, "sni")]')
                if link:
                    title = link[0].text_content().strip()
                    target_url = (link[0].get("href", "") or "").strip()
                    snippet_text = snippet[0].text_content().strip() if snippet else ""
                    if target_url.startswith("http"):
                        items.append({
                            "title": title,
                            "url": target_url,
                            "content": snippet_text,
                            "engine": "mojeek",
                        })
                    if len(items) >= max_results:
                        break
        except Exception as e:
            logger.debug(f"LXML parsing failed for Mojeek: {e}")
    else:
        matches = re.findall(
            r'<h2>.*?<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>',
            raw_html, re.DOTALL,
        )
        for target_url, raw_title in matches[:max_results]:
            clean_title = re.sub(r'<[^>]+>', '', raw_title).strip()
            if target_url.startswith("http"):
                items.append({
                    "title": clean_title,
                    "url": target_url,
                    "content": "",
                    "engine": "mojeek",
                })
    engine_health.report("mojeek", bool(items))
    return items
