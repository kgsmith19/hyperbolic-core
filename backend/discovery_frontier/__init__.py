"""Discovery Frontier Bounded Context.

Manages priority graph exploration, multi-hop crawl budgets,
and URL/DOI deduplication.
"""

from backend.discovery_frontier.priority_frontier import (
    FrontierItem,
    ResearchFrontier,
)
from backend.discovery_frontier.url_canonicalizer import (
    canonicalize_url,
)

__all__ = [
    "FrontierItem",
    "ResearchFrontier",
    "canonicalize_url",
]
