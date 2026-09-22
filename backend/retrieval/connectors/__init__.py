"""Connectors Sub-Package.

Individual deep-web and academic data connectors.
"""

from backend.retrieval.connectors.openalex_connector import search_openalex
from backend.retrieval.connectors.arxiv_connector import search_arxiv
from backend.retrieval.connectors.crossref_connector import search_crossref
from backend.retrieval.connectors.sec_edgar_connector import search_sec_edgar
from backend.retrieval.connectors.brave_search_connector import search_brave
from backend.retrieval.connectors.searxng_connector import search_searxng
from backend.retrieval.connectors.browser_crawler import fetch_with_browser

__all__ = [
    "search_openalex",
    "search_arxiv",
    "search_crossref",
    "search_sec_edgar",
    "search_brave",
    "search_searxng",
    "fetch_with_browser",
]
