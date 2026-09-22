"""Meta Search Bounded Context.

Provides local SearXNG-compatible meta-search service querying
DuckDuckGo and Bing with TLS 124 Chrome impersonation and URL unmasking.
"""

from backend.meta_search.bing_search_engine import (
    decode_bing_url,
    search_bing,
)
from backend.meta_search.duckduckgo_search_engine import (
    search_duckduckgo,
)
from backend.meta_search.meta_search_aggregator import (
    aggregate_meta_search,
)
from backend.meta_search.searxng_server import (
    SearXNGRequestHandler,
    ThreadedSearXNGServer,
    is_port_in_use,
    start_searxng_service,
)

__all__ = [
    "decode_bing_url",
    "search_bing",
    "search_duckduckgo",
    "aggregate_meta_search",
    "SearXNGRequestHandler",
    "ThreadedSearXNGServer",
    "is_port_in_use",
    "start_searxng_service",
]
