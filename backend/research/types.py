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

    # How the LLM sees the research process. Independent of watchlist blinding.
    # show (default) = send the bare topic and evidence. Best relevance.
    # hide = optional privacy layer: chaffed k-topic prompts so the model cannot
    #     tell which topic is real. Planning, HyDE, and gap analysis use it.
    # Watchlist terms never leave the machine in either mode.
    # None means "not set": the conceal_process alias decides, else "show".
    llm_process: str | None = None
    # Derived alias kept for older callers and payloads. True iff llm_process=="hide".
    conceal_process: bool | None = None

    # Depth continuation: how many times the engine may run gap-analysis rounds
    # when evidence keeps arriving. Gap rounds 2..N are local-only (snippets
    # never reach the model). Set 0 to disable mid-run gap seeding entirely.
    # Higher values are the deep-search edge over frontier APIs: the run keeps
    # following citations instead of stopping after one shallow pass.
    max_gap_rounds: int = 3
    # Wall-clock minutes for a full run. OpenAI/Anthropic/Gemini cap research
    # at ~30 min; expose up to 120 so a local run can genuinely go further.
    max_duration_min: float = 3.0
    # Per-connector search hits per query. More hits = broader seed frontier.
    max_results_per_connector: int = 10

    # Evidence quality pipeline (additive; defaults deepen without new egress).
    # Chunk long documents so rerank and synthesis see focused passages.
    chunk_documents: bool = True
    # Stage-2 local rerank of fused candidates before synthesis (no egress).
    rerank_results: bool = True
    rerank_keep: int = 12
    # Follow OpenAlex citation edges from top academic hits (GraphRAG-lite).
    citation_expansion: bool = True
    citation_per_doc: int = 5
    # Score frontier candidates by concept overlap with collected evidence.
    graph_prioritization: bool = True

    # Query rewriting: local multiquery variants (always, no egress) plus
    # HyDE hypothetical-answer draft queries (concealer model, ai_planning).
    query_rewrite: bool = True
    hyde_queries: bool = True
    # Claim verification: cross-check factual claims across sources before
    # the brief; contested items ground Tensions & Gaps (local-only).
    claim_verification: bool = True

    ai_planning: bool = False
    ai_summary: bool = False
    # Model routing: the cheap concealer hides process/expands topics; the deep
    # model synthesizes the final brief. `model` is the legacy alias (defaults
    # to gpt-4o-mini); explicit role values always win over it. A sentinel
    # distinguishes "deep left at default" from "deep explicitly set".
    model: str = "gpt-4o-mini"
    concealer_model: str | None = None
    deep_model: str | None = None
    reasoning_effort: str | None = None
    max_spend_usd: float = 2.00

    # Opt-in deterministic stopping after consecutive unproductive batches.
    low_information_gain_rounds: int = 0
    low_information_gain_min_documents: int = 0

    # ---- Enhancement & Flexibility Options ----
    # Strictness (0.0 to 1.0) and forcing direction strictly adhere to user prompts
    strictness: float = 0.9
    force_direction: bool = True
    # Report format: "comprehensive" (exhaustive/mass), "structured" (2-3 pages), or "both"
    report_format: str = "comprehensive"

    # ---- Deep research strategy (library defaults stay conservative; the UI
    # and CLI presets turn these up). ----
    # Source mix: share of the corpus aimed at the evidence group (academic,
    # institutional, reference, filings) vs the discussion group (community,
    # video, experts). 0.5 = balanced.
    academic_weight: float = 0.5
    # Lanes to search. None = classic all-connector search (no lane routing).
    source_lanes: list[str] | None = None
    # Base result budget per lane per query (scaled by the mix).
    results_per_lane: int = 8
    # Number of research angles (sub-questions) in the plan. 1 = topic only.
    breadth: int = 1
    # User-approved plan: [{"question": str, "queries": [str], "lanes": [str]}].
    plan: list[dict] | None = None
    # Reflection rounds allowed to consult the model for follow-ups (when
    # ai_planning is on). Rounds beyond this use local lead-following only.
    llm_gap_rounds: int = 1
    # Snowball: turn recurring entities/concepts in the evidence into new queries.
    follow_leads: bool = True
    # Follow-up queries issued per reflection round.
    queries_per_round: int = 4
    # Dig-deeper runs: URLs already covered by a parent run are skipped.
    exclude_urls: list[str] | None = None
    # Parent topic for dig-deeper runs (sharpens planning; never a watchlist term).
    context_topic: str = ""

    def __post_init__(self):
        # llm_process is canonical. conceal_process is the derived alias:
        # an older payload that only sets conceal_process still works; an
        # explicit llm_process always wins. Values other than hide/show
        # fall back to hide.
        # Resolve hide vs show. Precedence:
        # 1. explicit llm_process hide|show
        # 2. conceal_process alias (True=hide, False=show) when llm_process
        #    was left at its default
        # 3. hide
        if self.llm_process is not None:
            process = str(self.llm_process).strip().lower()
            if process not in ("hide", "show"):
                process = "hide"  # unknown values fail safe
        elif self.conceal_process is not None:
            process = "hide" if self.conceal_process else "show"
        else:
            process = "show"
        object.__setattr__(self, "llm_process", process)
        object.__setattr__(self, "conceal_process", process == "hide")

        try:
            weight = float(self.academic_weight)
        except (TypeError, ValueError):
            weight = 0.5
        if weight > 1.0:
            weight = weight / 100.0
        object.__setattr__(self, "academic_weight", max(0.0, min(1.0, weight)))
        object.__setattr__(self, "breadth", max(1, min(16, int(self.breadth or 1))))

        # Back-compat: `model` alone routes both roles; explicit roles win.
        # Deep role defaults to gpt-4o unless the alias says otherwise.
        if self.concealer_model is None:
            object.__setattr__(self, "concealer_model", self.model)
        if self.deep_model is None:
            object.__setattr__(
                self, "deep_model",
                "gpt-4o" if self.model == "gpt-4o-mini" else self.model,
            )


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
    # Stage-2 rerank diagnostics (0.0 when rerank is off). Kept on the type
    # so the UI can show why a source outranked the fused order.
    rerank_score: float = 0.0
    # Evidence-independence annotations (additive; 0/-1/False when unused).
    simhash: int = 0
    family_id: int = -1
    is_representative: bool = False
    # Source lane (academic, community, video, ...) and 0..1 quality prior.
    lane: str = ""
    quality: float = 0.0
    # Plan sub-question this source best answers ("" when no plan).
    subq: str = ""
    # Connector metadata: authors, year, venue, citations, score, community...
    meta: dict = field(default_factory=dict, hash=False, compare=False)


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
    run_id: str = ""
    stop_reason: str | None = None
    ledger_path: str = ""
    phase: str = "completed"
    plan: dict = field(default_factory=dict)
    learnings: list = field(default_factory=list)
    followups: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)
