"""Retrieval Router Coordinating Multi-Connector Ingestion.

Dispatches search and fetch tasks across academic registries, SEC EDGAR,
SearXNG, Brave Search, curl_cffi TLS impersonation, and Playwright stealth.
"""

import concurrent.futures
import os
import httpx
from backend.retrieval.ssrf_validator import is_safe_url
from backend.retrieval.content_cleaner import extract_clean_content
from backend.retrieval.bot_barrier_detector import is_bot_or_js_barrier
from backend.retrieval.connectors import (
    search_openalex,
    search_arxiv,
    search_crossref,
    search_pubmed,
    search_wikipedia,
    search_hackernews,
    search_sec_edgar,
    search_brave,
    search_searxng,
    fetch_with_browser,
)

try:
    from curl_cffi import requests as curl_requests
    HAS_CURL_CFFI = True
except ImportError:
    curl_requests = None
    HAS_CURL_CFFI = False


class RetrievalRouter:
    """Dispatches search and retrieval requests across multiple open connectors."""

    def __init__(self, searxng_url: str | None = None, use_curl_cffi: bool = True):
        self.searxng_url = searxng_url or os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080").rstrip("/")
        self.use_curl_cffi = use_curl_cffi and HAS_CURL_CFFI
        self.default_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
        }

    def search_searxng(self, query: str) -> list[dict]:
        return search_searxng(query, searxng_url=self.searxng_url)

    def search_openalex(self, query: str) -> list[dict]:
        return search_openalex(query)

    def search_crossref(self, query: str) -> list[dict]:
        return search_crossref(query)

    def search_arxiv(self, query: str) -> list[dict]:
        return search_arxiv(query)

    def search_pubmed(self, query: str) -> list[dict]:
        return search_pubmed(query)

    def search_wikipedia(self, query: str) -> list[dict]:
        return search_wikipedia(query)

    def search_hackernews(self, query: str) -> list[dict]:
        return search_hackernews(query)

    def search_sec_edgar(self, query: str) -> list[dict]:
        return search_sec_edgar(query)

    def search_brave(self, query: str) -> list[dict]:
        return search_brave(query)

    def search(self, query: str, connector: str = "all") -> list[dict]:
        """Route search query to specified or all active connectors."""
        if connector == "openalex":
            return self.search_openalex(query)
        elif connector == "crossref":
            return self.search_crossref(query)
        elif connector == "arxiv":
            return self.search_arxiv(query)
        elif connector == "pubmed":
            return self.search_pubmed(query)
        elif connector == "wikipedia":
            return self.search_wikipedia(query)
        elif connector == "hackernews":
            return self.search_hackernews(query)
        elif connector == "sec_edgar":
            return self.search_sec_edgar(query)
        elif connector == "searxng":
            return self.search_searxng(query)
        elif connector == "brave":
            return self.search_brave(query)

        # Multi-connector search: query all domains concurrently
        workers = [
            self.search_openalex,
            self.search_arxiv,
            self.search_crossref,
            self.search_pubmed,
            self.search_wikipedia,
            self.search_hackernews,
            self.search_sec_edgar,
            self.search_searxng,
            self.search_brave,
        ]
        aggregated = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(workers)) as executor:
            futures = [executor.submit(fn, query) for fn in workers]
            for future in concurrent.futures.as_completed(futures):
                try:
                    aggregated.extend(future.result() or [])
                except Exception:
                    continue
        return aggregated

    def fetch_with_browser(self, url: str) -> dict:
        return fetch_with_browser(url, user_agent=self.default_headers["User-Agent"])

    def fetch_url(self, url: str) -> dict:
        """Fetch a public webpage safely, validate SSRF, and extract content with browser fallback."""
        if not is_safe_url(url):
            return {
                "url": url,
                "status": "error",
                "error": "Blocked by SSRF / safety guard: target is a private, loopback, or invalid address."
            }

        raw_text = None
        final_url = url
        content_bytes = 0

        # Try curl_cffi with browser TLS impersonation (JA3/JA4) if available
        if self.use_curl_cffi and curl_requests is not None:
            try:
                resp = curl_requests.get(
                    url,
                    headers=self.default_headers,
                    impersonate="chrome124",
                    timeout=8,
                    allow_redirects=True,
                )
                if resp.status_code == 200:
                    cand_url = str(resp.url)
                    if not is_safe_url(cand_url):
                        return {"url": url, "status": "error", "error": "Redirect target failed SSRF check."}
                    content_type = resp.headers.get("Content-Type", "").lower()
                    if "text/html" in content_type or "text/plain" in content_type or "application/xhtml+xml" in content_type or not content_type:
                        if len(resp.content) <= 5 * 1024 * 1024:
                            final_url = cand_url
                            raw_text = resp.text
                            content_bytes = len(resp.content)
            except Exception:
                pass

        # Fallback to httpx if curl_cffi did not produce text or failed
        if raw_text is None:
            try:
                with httpx.Client(timeout=8.0, follow_redirects=True) as client:
                    resp = client.get(url, headers=self.default_headers)
                    if resp.status_code != 200:
                        return {"url": url, "status": "error", "error": f"HTTP {resp.status_code}"}

                    content_type = resp.headers.get("Content-Type", "").lower()
                    if "text/html" not in content_type and "text/plain" not in content_type and "application/xhtml+xml" not in content_type:
                        return {"url": url, "status": "error", "error": "Non-HTML content rejected."}

                    if len(resp.content) > 5 * 1024 * 1024:
                        return {"url": url, "status": "error", "error": "Oversized content (>5MB) rejected."}

                    final_url = str(resp.url)
                    if not is_safe_url(final_url):
                        return {"url": url, "status": "error", "error": "Redirect target failed SSRF check."}

                    raw_text = resp.text
                    content_bytes = len(resp.content)
            except Exception as err:
                return {"url": url, "status": "error", "error": f"Fetch failed: {str(err)}"}

        text, links = extract_clean_content(raw_text)

        # Fallback to headless browser if HTML body is empty, too short, or a JS/bot barrier
        if not text or len(text.strip()) < 100 or is_bot_or_js_barrier(text):
            browser_res = self.fetch_with_browser(final_url)
            if browser_res.get("status") == "ok" and browser_res.get("content") and not is_bot_or_js_barrier(browser_res.get("content")):
                return browser_res
            elif is_bot_or_js_barrier(text):
                return {
                    "url": final_url,
                    "status": "error",
                    "error": "Blocked by site verification or anti-bot challenge.",
                    "content": "",
                    "links": links,
                }

        return {
            "url": final_url,
            "status": "ok",
            "content": text,
            "links": links,
            "bytes": content_bytes,
        }
