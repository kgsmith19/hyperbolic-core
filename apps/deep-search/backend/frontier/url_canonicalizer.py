"""URL Canonicalization & Normalization.

Strips query parameters, tracking fragments, and session tokens to ensure
consistent deduplication across frontier crawl operations.
"""

import urllib.parse


def canonicalize_url(url: str) -> str:
    """Strip query parameters and fragments from a URL."""
    if not url or not isinstance(url, str):
        return ""
    url = url.strip()
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, "", ""))
