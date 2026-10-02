"""Vertical (lane-targeted) web search using advanced operators.

The open web indexes hold the community, video, expert, and institutional
material that academic APIs never see. Each lane maps to one or more
operator-shaped queries (site:, filetype:, intent words). Engines that ignore
operators (Bing's HTML endpoint drops ``site:``) are post-filtered by domain so
a "Reddit" vertical only returns Reddit.
"""

from __future__ import annotations

import urllib.parse

from backend.retrieval.meta.meta_search_aggregator import aggregate_meta_search

# lane -> list of (operator suffix, allowed host suffixes or None for any)
VERTICALS: dict[str, list[tuple[str, tuple[str, ...] | None]]] = {
    "community": [
        ("site:reddit.com", ("reddit.com",)),
        ("forum OR discussion OR thread", None),
        ("site:stackexchange.com OR site:stackoverflow.com", ("stackexchange.com", "stackoverflow.com")),
    ],
    "video": [("site:youtube.com", ("youtube.com", "youtu.be"))],
    "expert": [
        ("site:substack.com OR site:medium.com", ("substack.com", "medium.com")),
        ("expert interview OR podcast OR newsletter", None),
    ],
    "gov": [
        ("site:.gov", (".gov", ".gov.uk", ".gov.au", ".gc.ca", ".int", "europa.eu")),
        ("site:.edu", (".edu", ".ac.uk", ".edu.au")),
    ],
    "academic": [("filetype:pdf", ("pdf",))],
    "news": [("news analysis report", None)],
}


def _host_ok(url: str, allowed: tuple[str, ...] | None) -> bool:
    if not allowed:
        return True
    if allowed == ("pdf",):
        return urllib.parse.urlparse(url).path.lower().endswith(".pdf")
    host = (urllib.parse.urlparse(url).netloc or "").lower()
    return any(host == a.lstrip(".") or host.endswith(a if a.startswith(".") else "." + a) or host == a for a in allowed)


def vertical_search(query: str, lane: str, max_results: int = 10) -> list[dict]:
    """Run the lane's operator queries and return domain-filtered results."""
    variants = VERTICALS.get(lane, [])
    if not variants or not query or not query.strip():
        return []
    # Large budgets use every variant; small ones only the flagship operator.
    if max_results < 6:
        variants = variants[:1]
    elif max_results < 12:
        variants = variants[:2]
    per_variant = max(4, max_results // max(1, len(variants)) + 2)
    out, seen = [], set()
    for suffix, allowed in variants:
        try:
            items = aggregate_meta_search(f"{query.strip()} {suffix}", max_results=per_variant * 2)
        except Exception:
            items = []
        kept = 0
        for item in items:
            url = item.get("url", "")
            if not url or url in seen or not _host_ok(url, allowed):
                continue
            seen.add(url)
            out.append({
                "title": item.get("title", ""),
                "url": url,
                "snippet": item.get("content", ""),
                "source": f"vertical:{lane}:{item.get('engine', 'meta')}",
            })
            kept += 1
            if kept >= per_variant:
                break
    return out[:max_results]
