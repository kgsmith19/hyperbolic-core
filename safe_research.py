"""Safe Research Utility & Secret-Core Controller.

Top-level entrypoint and backwards-compatible facade for the Deep Search Engine.
Delegates to modular domain bounded contexts in `backend/`:
- backend.security_guard: Air-gap socket protection, token blinder, statistical chaffing
- backend.retrieval_engine: Multi-connector retrieval worker and IPC client
- backend.discovery_frontier: Priority exploration graph and cycle deduplication
- backend.relevance_ranking: BM25 + ONNX FastEmbed RRF re-ranking
- backend.synthesis_intelligence: Offline extractive synthesis and Markdown report writer
- backend.research_orchestrator: Research pipeline execution and query expansion
- backend.server: Browser Web UI and REST API server
"""

import argparse
import os
import sys

# Backend Bounded Context Imports
from backend.security_guard import (
    enforce_secret_core_socket_block,
    SafetyError,
    normalize_for_match,
    _build_term_pattern,
    redact,
    assert_safe_to_send,
    create_blinder,
    blind_text,
    rehydrate_text,
    generate_statistical_decoys,
    generate_chaffed_prompt,
    extract_chaffed_response,
    DECOY_TOPICS,
    SecureZeroBuffer,
    EphemeralEncryptedScratch,
    SanitizedQuarantine,
)
from backend.discovery_frontier import (
    FrontierItem,
    ResearchFrontier,
    canonicalize_url,
)
from backend.relevance_ranking import (
    tokenize,
    compute_bm25_scores,
    compute_dense_scores,
    reciprocal_rank_fusion,
    rank_items,
)
from backend.synthesis_intelligence import (
    LocalSLMEngine,
    summarize_with_openai,
    write_report,
)
from backend.retrieval_engine import (
    is_safe_url,
    is_bot_or_js_barrier,
    extract_clean_content,
    validate_task_schema,
    RetrievalRouter,
    CollectorClient,
    get_collector,
    reset_collector,
    search_brave,
    fetch_html_text,
    build_sanitized_evidence,
)
from backend.research_orchestrator import (
    expand_topic_queries,
    expand_topic_queries_chaffed,
    run_research,
)
from backend.server import (
    load_env_file,
    save_env_file,
    load_lines,
    SafeResearchRequestHandler,
    start_ui_server,
)
from backend.meta_search import (
    start_searxng_service,
    is_port_in_use,
)

# Initialize environment
load_env_file()


def rank_evidence(evidence_list: list[dict], topic: str) -> list[dict]:
    """Sort evidence list deterministically using BM25 + Dense FastEmbed + RRF."""
    return rank_items(topic, evidence_list)


def main() -> None:
    """Main entry point for safe research utility."""
    # Ensure local SearXNG meta-search engine is active on port 8080
    try:
        start_searxng_service("127.0.0.1", 8080)
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Research a safe topic with local watchlist protection.")
    parser.add_argument("--topic", default="topic.txt", help="Path to non-sensitive topic file")
    parser.add_argument("--watchlist", default="watchlist.txt", help="Path to local sensitive watchlist file")
    parser.add_argument("--mode", default="deterministic", choices=["deterministic", "expansion", "full", "extreme"], help="Research mode")
    parser.add_argument("--max-depth", type=int, default=2, help="Maximum multi-hop citation depth")
    parser.add_argument("--max-docs", type=int, default=15, help="Maximum documents to retrieve")
    parser.add_argument("--concurrency", type=int, default=4, help="Concurrent exploration workers")
    parser.add_argument("--max-duration", type=float, default=180.0, help="Maximum run duration budget in seconds")
    parser.add_argument("--openai-model", default="gpt-4o-mini", help="OpenAI model for synthesis (e.g. gpt-4o-mini, gpt-4o, o3-mini, o1)")
    parser.add_argument("--reasoning-effort", choices=["low", "medium", "high"], default=None, help="Reasoning effort for o-series models")
    parser.add_argument("--max-spend", type=float, default=2.00, help="Maximum spending cap in USD")
    parser.add_argument("--ui", action="store_true", help="Launch local browser UI")
    args = parser.parse_args()

    if args.ui:
        start_ui_server()
        return

    try:
        topic_lines = load_lines(args.topic)
        topic = " ".join(topic_lines).strip()
        watchlist = load_lines(args.watchlist)

        if not topic:
            return

        def print_progress(msg: str):
            if "Seeding" in msg or "Searching" in msg:
                print("Searching")
            elif "Processing" in msg or "Retrieving" in msg:
                print("Processing results")
            elif "Writing" in msg:
                print("Writing report")

        run_research(
            topic,
            watchlist,
            mode=args.mode,
            max_depth=args.max_depth,
            max_documents=args.max_docs,
            max_duration_sec=args.max_duration,
            concurrency=args.concurrency,
            openai_model=args.openai_model,
            reasoning_effort=args.reasoning_effort,
            max_spend_usd=args.max_spend,
            progress_callback=print_progress
        )
    except SafetyError:
        print("Blocked by local safety guard")
    except Exception:
        pass


if __name__ == "__main__":
    main()
