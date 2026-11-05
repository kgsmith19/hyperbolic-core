"""Bing Search Engine Scraper with URL Redirect Decoding.

Executes direct HTML searches against Bing with Chrome TLS 124 impersonation
and unmasks Base64 encoded redirect URLs.
"""

import base64
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


def decode_bing_url(bing_url: str) -> str:
    """Decode base64 encoded destination URL inside Bing redirect links."""
    try:
        if "/ck/a?!" in bing_url:
            parsed = urllib.parse.urlparse(bing_url)
            qs = urllib.parse.parse_qs(parsed.query)
            u_param = qs.get("u", [""])[0]
            if u_param.startswith("a1"):
                b64 = u_param[2:]
                b64 += "=" * ((4 - len(b64) % 4) % 4)
                decoded = base64.urlsafe_b64decode(b64).decode("utf-8", errors="ignore")
                if decoded.startswith("http"):
                    return decoded
    except Exception:
        pass
    return bing_url


def search_bing(query: str, max_results: int = 10) -> list[dict]:
    """Search Bing HTML using Chrome TLS impersonation and direct URL unmasking."""
    if not query.strip():
        return []
    if not engine_health.available("bing"):
        return []
    url = f"https://www.bing.com/search?q={urllib.parse.quote_plus(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    raw_html = ""
    try:
        if HAS_CURL_CFFI:
            with engine_health.throttle("bing"):
                resp = cffi_requests.get(url, headers=headers, impersonate="chrome124", timeout=8)
            if resp.status_code == 200:
                raw_html = resp.text
        else:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as r:
                raw_html = r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.debug(f"Bing fetch failed: {e}")
        engine_health.report("bing", False)
        return []

    if not raw_html:
        engine_health.report("bing", False)
        return []

    items = []
    if HAS_LXML:
        try:
            tree = lxml_html.fromstring(raw_html)
            for li in tree.xpath('//li[contains(@class, "b_algo")]'):
                h2 = li.xpath('.//h2/a')
                snippet = li.xpath('.//div[contains(@class, "b_caption")]//p')
                if h2:
                    title = h2[0].text_content().strip()
                    raw_href = h2[0].get("href", "")
                    target_url = decode_bing_url(raw_href)
                    snippet_text = snippet[0].text_content().strip() if snippet else ""
                    if target_url.startswith("http"):
                        items.append({
                            "title": title,
                            "url": target_url,
                            "content": snippet_text,
                            "engine": "bing",
                        })
                    if len(items) >= max_results:
                        break
        except Exception as e:
            logger.debug(f"LXML parsing failed for Bing: {e}")
    else:
        matches = re.findall(r'<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>.*?<h2><a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', raw_html, re.DOTALL)
        for raw_href, raw_title in matches[:max_results]:
            clean_title = re.sub(r'<[^>]+>', '', raw_title).strip()
            target_url = decode_bing_url(raw_href)
            if target_url.startswith("http"):
                items.append({
                    "title": clean_title,
                    "url": target_url,
                    "content": "",
                    "engine": "bing",
                })
    engine_health.report("bing", bool(items))
    return items
