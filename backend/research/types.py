"""Shared domain types for one search with explicit options."""

from __future__ import annotations

from dataclasses import dataclass, field

from backend.research.cost_estimator import SpendReport


@dataclass
class SearchOptions:
    """Independent knobs for a single progressive-depth search."""

    max_depth: int = 2
    max_documents: int = 15
    concurrency: int = 4
    max_duration_sec: float = 180.0
    max_per_domain: int = 4

    blind_watchlist: bool = False
    decoy_queries: int = 0

    ai_planning: bool = False
    ai_summary: bool = False
    model: str = "gpt-4o-mini"
    reasoning_effort: str | None = None
    max_spend_usd: float = 2.00


@dataclass(frozen=True)
class Evidence:
    """One retrieved source after sanitization."""

    title: str
    url: str
    snippet: str
    excerpt: str = ""
    doi: str = ""
    depth: int = 0
    source: str = ""
    score: float = 0.0


@dataclass(frozen=True)
class Query:
    """A search query, real or decoy."""

    text: str
    is_decoy: bool = False


@dataclass(frozen=True)
class SearchPreview:
    """Declared tradeoffs and expected workload before launch."""

    expected_hops: int
    expected_sources: int
    expected_duration_sec: float
    expected_spend_usd: float
    expected_cost_display: str
    warnings: list[str]
    requires_confirm: bool


@dataclass
class ResearchRun:
    """Completed or cancelled search result."""

    topic: str
    options: SearchOptions
    queries: list[Query]
    evidence: list[Evidence]
    summary: str
    spend: SpendReport
    duration_sec: float
    archive_path: str
    status: str
    report_markdown: str = ""
    warnings: list[str] = field(default_factory=list)
