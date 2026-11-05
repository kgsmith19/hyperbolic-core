"""Connectors Sub-Package.

Individual deep-web, academic, and technical discussion data connectors.
"""

from backend.retrieval.connectors.openalex_connector import search_openalex, expand_citations
from backend.retrieval.connectors.arxiv_connector import search_arxiv
from backend.retrieval.connectors.crossref_connector import search_crossref
from backend.retrieval.connectors.pubmed_connector import search_pubmed
from backend.retrieval.connectors.wikipedia_connector import search_wikipedia
from backend.retrieval.connectors.hackernews_connector import search_hackernews
from backend.retrieval.connectors.sec_edgar_connector import search_sec_edgar
from backend.retrieval.connectors.brave_search_connector import search_brave
from backend.retrieval.connectors.searxng_connector import search_searxng
from backend.retrieval.connectors.browser_crawler import fetch_with_browser
from backend.retrieval.connectors.scholarly_connectors import (
    search_semantic_scholar,
    search_europepmc,
    search_doaj,
)
from backend.retrieval.connectors.community_connectors import (
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

__all__ = [
    "search_openalex",
    "expand_citations",
    "search_arxiv",
    "search_crossref",
    "search_pubmed",
    "search_wikipedia",
    "search_hackernews",
    "search_sec_edgar",
    "search_brave",
    "search_searxng",
    "fetch_with_browser",
    "search_semantic_scholar",
    "search_europepmc",
    "search_doaj",
    "search_reddit",
    "search_stackexchange",
    "search_github",
    "search_internet_archive",
    "search_youtube",
    "fetch_reddit_thread",
    "fetch_hn_item",
    "fetch_youtube_video",
    "wayback_snapshot_url",
]
