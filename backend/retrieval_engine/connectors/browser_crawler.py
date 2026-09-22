"""Playwright Headless Browser Crawler with Stealth Protections.

Provides automated JavaScript rendering and DOM hydration for SPAs
with Cloudflare and bot-wall evasion hooks.
"""

import warnings
from backend.retrieval_engine.ssrf_validator import is_safe_url
from backend.retrieval_engine.content_cleaner import extract_clean_content
from backend.retrieval_engine.bot_barrier_detector import is_bot_or_js_barrier

try:
    from playwright_stealth import Stealth
    HAS_STEALTH = True
except ImportError:
    Stealth = None
    HAS_STEALTH = False


def fetch_with_browser(url: str, user_agent: str | None = None) -> dict:
    """Headless browser fallback for JavaScript-rendered SPAs using Playwright with stealth evasions."""
    if not is_safe_url(url):
        return {"url": url, "status": "error", "error": "Blocked by SSRF guard"}
    try:
        from playwright.sync_api import sync_playwright
        stealth_applier = Stealth() if (HAS_STEALTH and Stealth is not None) else None
        ua = user_agent or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                ]
            )
            context = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=ua,
            )
            page = context.new_page()
            if stealth_applier:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    stealth_applier.apply_stealth_sync(page)

            page.set_default_timeout(15000)
            page.goto(url, wait_until="load")
            try:
                page.wait_for_timeout(1500)
            except Exception:
                pass
            raw_html = page.content()
            browser.close()

            text, links = extract_clean_content(raw_html)
            if is_bot_or_js_barrier(text):
                return {
                    "url": url,
                    "status": "error",
                    "error": "Target requires human interaction or returned persistent bot block.",
                    "content": "",
                    "links": links
                }

            return {
                "url": url,
                "status": "ok",
                "content": text,
                "links": links,
                "bytes": len(raw_html.encode("utf-8")),
                "renderer": "playwright_stealth" if stealth_applier else "playwright_headless"
            }
    except Exception as e:
        return {"url": url, "status": "error", "error": f"Browser fallback failed: {str(e)}"}
