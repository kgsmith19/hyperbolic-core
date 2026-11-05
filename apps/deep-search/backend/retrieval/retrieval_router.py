"""Retrieval Router Coordinating Multi-Connector Ingestion.

Two search paths:

- ``search(query, connector)``: the classic all-connector fan-out (academic
  registries, SEC EDGAR, SearXNG, Brave, Wikipedia, HN, PubMed) or one named
  connector.
- ``search_lanes(query, lanes)``: lane-weighted fan-out. ``lanes`` maps a lane
  (academic, community, video, expert, gov, reference, filings, code,
  archive, news, web) to a result budget. Each lane runs its dedicated APIs
  plus operator-shaped vertical web searches, concurrently.

Fetch path: specialised readers for Reddit threads, Hacker News items, and
YouTube videos (transcripts); PDF extraction; curl_cffi TLS impersonation ->
httpx -> Playwright stealth; and a Wayback Machine fallback for dead or
walled pages.
"""

import concurrent.futures
import os
from collections.abc import Callable
from typing import Any

import httpx

from backend.retrieval.ssrf_validator import is_safe_url
from backend.retrieval.content_cleaner import (
    extract_clean_content,
    extract_links_with_text,
    extract_pdf_text,
    extract_title,
)
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
    search_semantic_scholar,
    search_europepmc,
    search_doaj,
    search_reddit,
    search_stackexchange,
    search_github,
    search_internet_archive,
    search_youtube,
    fetch_reddit_thread,
    fetch_hn_item,
    fetch_youtube_video,
    wayback_snapshot_url,
)
from backend.retrieval.meta.vertical_search import vertical_search
from backend.retrieval.source_quality import classify_lane

try:
    from curl_cffi import requests as curl_requests
    HAS_CURL_CFFI = True
except ImportError:
    curl_requests = None
    HAS_CURL_CFFI = False

MAX_DOC_CHARS = 60000
MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024
_TEXT_TYPES = ("text/html", "text/plain", "application/xhtml+xml", "application/xml", "text/xml")


class RetrievalRouter:
    """Dispatches search and retrieval requests across multiple open connectors."""

    def __init__(self, searxng_url: str | None = None, use_curl_cffi: bool = True):
        self.searxng_url = searxng_url or os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080").rstrip("/")
        self.use_curl_cffi = use_curl_cffi and HAS_CURL_CFFI
        self.default_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
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

    # ------------------------------------------------------------------ search

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

    def search(self, query: str, connector: str = "all", lanes: dict | None = None) -> list[dict]:
        """Route search query to specified or all active connectors."""
        if lanes:
            return self.search_lanes(query, lanes)
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

    def _lane_jobs(self, query: str, lanes: dict) -> list[tuple[str, Callable[[], Any]]]:
        """Build (lane, thunk) jobs sized by each lane's result budget."""
        jobs: list[tuple[str, Callable[[], Any]]] = []

        def budget(name: str) -> int:
            try:
                return max(0, int(lanes.get(name, 0) or 0))
            except (TypeError, ValueError):
                return 0

        q = query
        n = budget("academic")
        if n:
            half = max(3, n // 2)
            jobs += [
                ("academic", lambda q=q, n=n: search_openalex(q, per_page=n)),
                ("academic", lambda q=q, n=n: search_semantic_scholar(q, limit=n)),
                ("academic", lambda q=q, h=half: search_europepmc(q, limit=h)),
                ("academic", lambda q=q, h=half: search_arxiv(q, max_results=h)),
                ("academic", lambda q=q, h=half: search_crossref(q, rows=h)),
                ("academic", lambda q=q, h=half: search_pubmed(q, max_results=h)),
                ("academic", lambda q=q, n=n: search_doaj(q, limit=max(3, n // 3))),
            ]
            if n >= 8:
                jobs.append(("academic", lambda q=q, n=n: vertical_search(q, "academic", max_results=max(4, n // 3))))
        n = budget("community")
        if n:
            jobs += [
                ("community", lambda q=q, n=n: search_reddit(q, limit=n)),
                ("community", lambda q=q, n=n: search_hackernews(q, max_results=max(3, n // 2))),
                ("community", lambda q=q, n=n: search_stackexchange(q, limit=max(3, n // 3))),
                ("community", lambda q=q, n=n: vertical_search(q, "community", max_results=n)),
            ]
        n = budget("video")
        if n:
            jobs.append(("video", lambda q=q, n=n: search_youtube(q, limit=n)))
        for lane in ("video", "expert", "gov", "news"):
            n = budget(lane)
            if n:
                jobs.append((lane, lambda q=q, lane=lane, n=n: vertical_search(q, lane, max_results=n)))
        n = budget("reference")
        if n:
            jobs.append(("reference", lambda q=q, n=n: search_wikipedia(q, max_results=n)))
        n = budget("filings")
        if n:
            jobs.append(("filings", lambda q=q, n=n: search_sec_edgar(q)[:n]))
        n = budget("code")
        if n:
            jobs.append(("code", lambda q=q, n=n: search_github(q, limit=n)))
        n = budget("archive")
        if n:
            jobs.append(("archive", lambda q=q, n=n: search_internet_archive(q, limit=n)))
        n = budget("web")
        if n:
            jobs.append(("web", lambda q=q, n=n: self.search_searxng(q)[: max(5, n)]))
            jobs.append(("web", lambda q=q, n=n: self.search_brave(q)[: max(5, n)]))
        return jobs

    def search_lanes(self, query: str, lanes: dict) -> list[dict]:
        """Lane-weighted concurrent search; every result carries a lane tag."""
        jobs = self._lane_jobs(query, lanes or {})
        if not jobs:
            return []
        results: list[dict] = []
        seen: dict[str, dict] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, len(jobs))) as executor:
            futures = {executor.submit(fn): lane for lane, fn in jobs}
            for future in concurrent.futures.as_completed(futures):
                try:
                    items = future.result() or []
                except Exception:
                    continue
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    url = item.get("url")
                    if not isinstance(url, str) or not url:
                        continue
                    if url in seen:
                        # Merge richer metadata (abstracts, citation counts) into the first hit.
                        existing = seen[url]
                        for key in ("abstract", "oa_url", "doi", "meta", "snippet"):
                            val = item.get(key)
                            if val and len(str(val)) > len(str(existing.get(key) or "")):
                                existing[key] = val
                        continue
                    item = dict(item)
                    item["lane"] = item.get("lane") or classify_lane(url, item.get("source", ""))
                    seen[url] = item
                    results.append(item)
        return results

    # ------------------------------------------------------------------ fetch

    def fetch_with_browser(self, url: str) -> dict:
        return fetch_with_browser(url, user_agent=self.default_headers["User-Agent"])

    def _fetch_special(self, url: str) -> dict | None:
        lower = url.lower()
        try:
            if "reddit.com/r/" in lower and "/comments/" in lower:
                return fetch_reddit_thread(url)
            if "news.ycombinator.com/item" in lower:
                return fetch_hn_item(url)
            if "youtube.com/watch" in lower or "youtu.be/" in lower or "youtube.com/shorts/" in lower:
                return fetch_youtube_video(url)
        except Exception:
            return None
        return None

    def _download(self, url: str) -> tuple[str | None, bytes | None, str, str, int, str]:
        """Return (text, pdf_bytes, final_url, content_type, n_bytes, error)."""
        if self.use_curl_cffi and curl_requests is not None:
            try:
                resp = curl_requests.get(url, headers=self.default_headers, impersonate="chrome124",
                                         timeout=10, allow_redirects=True)
                if resp.status_code == 200:
                    cand_url = str(resp.url)
                    if not is_safe_url(cand_url):
                        return None, None, url, "", 0, "Redirect target failed SSRF check."
                    ctype = resp.headers.get("Content-Type", "").lower()
                    if len(resp.content) <= MAX_DOWNLOAD_BYTES:
                        if "application/pdf" in ctype or resp.content[:5] == b"%PDF-":
                            return None, resp.content, cand_url, "application/pdf", len(resp.content), ""
                        if any(t in ctype for t in _TEXT_TYPES) or not ctype:
                            return resp.text, None, cand_url, ctype, len(resp.content), ""
            except Exception:
                pass
        try:
            with httpx.Client(timeout=10.0, follow_redirects=True) as client:
                resp = client.get(url, headers=self.default_headers)
                if resp.status_code != 200:
                    return None, None, url, "", 0, f"HTTP {resp.status_code}"
                final_url = str(resp.url)
                if not is_safe_url(final_url):
                    return None, None, url, "", 0, "Redirect target failed SSRF check."
                ctype = resp.headers.get("Content-Type", "").lower()
                if len(resp.content) > MAX_DOWNLOAD_BYTES:
                    return None, None, url, ctype, 0, "Oversized content rejected."
                if "application/pdf" in ctype:
                    return None, resp.content, final_url, ctype, len(resp.content), ""
                if not any(t in ctype for t in _TEXT_TYPES):
                    return None, None, url, ctype, 0, "Non-HTML content rejected."
                return resp.text, None, final_url, ctype, len(resp.content), ""
        except Exception as err:
            return None, None, url, "", 0, f"Fetch failed: {str(err)}"

    def _fetch_generic(self, url: str, allow_browser: bool = True) -> dict:
        raw_text, pdf_bytes, final_url, _ctype, content_bytes, error = self._download(url)
        if pdf_bytes is not None:
            text = extract_pdf_text(pdf_bytes, max_chars=MAX_DOC_CHARS)
            if text and len(text.strip()) >= 100:
                first_line = next((ln.strip() for ln in text.splitlines() if len(ln.strip()) > 12), "")
                return {"url": final_url, "status": "ok", "content": text, "links": [], "bytes": content_bytes,
                        "renderer": "pdf", "title": first_line[:200]}
            return {"url": url, "status": "error", "error": "PDF had no extractable text."}
        if raw_text is None:
            return {"url": url, "status": "error", "error": error or "Fetch failed"}

        text, links = extract_clean_content(raw_text, max_chars=MAX_DOC_CHARS)
        title = extract_title(raw_text)
        link_texts = extract_links_with_text(raw_text)

        if allow_browser and (not text or len(text.strip()) < 100 or is_bot_or_js_barrier(text)):
            browser_res = self.fetch_with_browser(final_url)
            browser_content = browser_res.get("content")
            if browser_res.get("status") == "ok" and isinstance(browser_content, str) and browser_content and not is_bot_or_js_barrier(browser_content):
                return browser_res
            elif is_bot_or_js_barrier(text):
                return {
                    "url": final_url,
                    "status": "error",
                    "error": "Blocked by site verification or anti-bot challenge.",
                    "content": "",
                    "links": links,
                }
        elif is_bot_or_js_barrier(text or ""):
            return {"url": final_url, "status": "error", "error": "Blocked by anti-bot challenge.", "content": "", "links": links}

        return {
            "url": final_url,
            "status": "ok",
            "content": text,
            "links": links,
            "link_texts": link_texts,
            "title": title,
            "bytes": content_bytes,
        }

    def fetch_url(self, url: str) -> dict:
        """Fetch a public page safely with specialised readers, PDF support, and archive fallback."""
        if not is_safe_url(url):
            return {
                "url": url,
                "status": "error",
                "error": "Blocked by SSRF / safety guard: target is a private, loopback, or invalid address."
            }

        special = self._fetch_special(url)
        if special and special.get("status") == "ok" and len((special.get("content") or "").strip()) >= 50:
            return special

        result = self._fetch_generic(url)
        if result.get("status") == "ok" and len((result.get("content") or "").strip()) >= 50:
            return result

        # Deep-web fallback: the Wayback Machine often holds dead, walled, or
        # rate-limited pages. Never for archive URLs themselves.
        if "archive.org" not in url.lower() and os.environ.get("DEEPSEARCH_DISABLE_WAYBACK", "") != "1":
            try:
                snapshot = wayback_snapshot_url(url)
            except Exception:
                snapshot = ""
            if snapshot and is_safe_url(snapshot):
                archived = self._fetch_generic(snapshot, allow_browser=False)
                if archived.get("status") == "ok" and len((archived.get("content") or "").strip()) >= 200:
                    archived["url"] = url
                    archived["archived_from"] = snapshot
                    archived["renderer"] = "wayback"
                    return archived
        return result
