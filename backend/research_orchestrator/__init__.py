"""Research Orchestrator Bounded Context.

Coordinates multi-hop exploration, concurrent territory partitioning,
query planning, spending limits, cancellation tokens, and report generation.
"""

from backend.research_orchestrator.query_planner import (
    expand_topic_queries,
    expand_topic_queries_chaffed,
)
from backend.research_orchestrator.research_pipeline import (
    run_research,
    run_search,
)
from backend.research_orchestrator.cost_estimator import (
    CostTracker,
    SpendLimitExceededError,
    SpendReport,
    MODEL_PRICING,
)
from backend.research_orchestrator.cancellation import (
    cancellation_manager,
    CancellationManager,
)
from backend.research_orchestrator.types import (
    SearchOptions,
    Evidence,
    Query,
    SearchPreview,
    ResearchRun,
)
from backend.research_orchestrator.preview import preview
from backend.research_orchestrator.planner import plan_queries
from backend.research_orchestrator.guard import prepare_topic
from backend.research_orchestrator.explorer import explore

__all__ = [
    "expand_topic_queries",
    "expand_topic_queries_chaffed",
    "run_research",
    "run_search",
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
