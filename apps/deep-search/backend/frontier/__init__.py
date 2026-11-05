"""Discovery Frontier Bounded Context.

Manages priority graph exploration, multi-hop crawl budgets,
and URL/DOI deduplication.
"""

from backend.frontier.priority_frontier import (
    FrontierItem,
    ResearchFrontier,
)
from backend.frontier.url_canonicalizer import (
    canonicalize_url,
)

__all__ = [
    "FrontierItem",
    "ResearchFrontier",
    "canonicalize_url",
]
