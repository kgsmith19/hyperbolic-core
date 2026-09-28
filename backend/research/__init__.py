"""Research Orchestrator Bounded Context.

Coordinates multi-hop exploration, concurrent territory partitioning,
query planning, process concealment, spending limits, cancellation tokens,
and report generation.
"""

from backend.research.query_planner import (
    expand_topic_queries,
    propose_gap_queries,
)
from backend.research.research_pipeline import (
    run_search,
    run_to_dict,
)
from backend.research.query_rewriter import (
    multiquery_variants,
    hyde_draft_queries,
)
from backend.research.cost_estimator import (
    CostTracker,
    SpendLimitExceededError,
    SpendReport,
    MODEL_PRICING,
)
from backend.research.cancellation import (
    cancellation_manager,
    CancellationManager,
)
from backend.research.types import (
    SearchOptions,
    Evidence,
    Query,
    SearchPreview,
    ResearchRun,
)
from backend.research.preview import preview
from backend.research.planner import plan_queries
from backend.research.guard import prepare_topic
from backend.research.explorer import explore

__all__ = [
    "expand_topic_queries",
    "multiquery_variants",
    "hyde_draft_queries",
    "propose_gap_queries",
    "run_search",
    "run_to_dict",
    "CostTracker",
    "SpendLimitExceededError",
    "SpendReport",
    "MODEL_PRICING",
    "cancellation_manager",
    "CancellationManager",
    "SearchOptions",
    "Evidence",
    "Query",
    "SearchPreview",
    "ResearchRun",
    "preview",
    "plan_queries",
    "prepare_topic",
    "explore",
]
