"""Deep Search CLI and UI entrypoint.

One search with explicit options. No mode enum, no barrel re-exports.
"""

import argparse
import sys

from backend.privacy import SafetyError
from backend.research import SearchOptions, preview, run_search
from backend.retrieval.meta import start_searxng_service
from backend.server import load_env_file, load_lines, start_ui_server

load_env_file()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a guarded deep search with explicit options.")
    parser.add_argument("--topic", default="topic.txt", help="Path to non-sensitive topic file")
    parser.add_argument("--watchlist", default="watchlist.txt", help="Path to local sensitive watchlist file")
    parser.add_argument("--max-depth", type=int, default=4, help="Maximum multi-hop citation depth (deep default; providers stop at 1-2)")
    parser.add_argument("--max-docs", type=int, default=40, help="Maximum documents to retrieve")
    parser.add_argument("--concurrency", type=int, default=4, help="Concurrent exploration workers")
    parser.add_argument("--max-duration-min", type=float, default=15.0, help="Maximum run budget in minutes (up to 120; providers cap ~30)")
    parser.add_argument("--max-per-domain", type=int, default=6, help="Maximum documents per domain")
    parser.add_argument("--max-gap-rounds", type=int, default=3, help="Coverage re-check rounds while evidence arrives (0 disables; rounds 2+ stay local)")
    parser.add_argument("--no-chunk", action="store_true", help="Disable passage chunking of long documents")
    parser.add_argument("--no-rerank", action="store_true", help="Disable local stage-2 rerank before synthesis")
    parser.add_argument("--rerank-keep", type=int, default=12, help="Top-N candidates kept by the reranker")
    parser.add_argument("--no-citations", action="store_true", help="Disable OpenAlex citation-edge expansion")
    parser.add_argument("--citation-per-doc", type=int, default=5, help="Citation edges followed per academic hit")
    parser.add_argument("--no-graph", action="store_true", help="Disable concept-graph frontier prioritization")
    parser.add_argument("--no-rewrite", action="store_true", help="Disable local multiquery variants")
    parser.add_argument("--no-hyde", action="store_true", help="Disable HyDE hypothetical-answer draft queries")
    parser.add_argument("--no-verify", action="store_true", help="Disable cross-source claim verification")
    parser.add_argument("--concealer-model", default="gpt-4o-mini", help="Cheap model that hides process and expands topics")
    parser.add_argument("--deep-model", default="gpt-4o", help="Deep model that writes the final brief")
    parser.add_argument("--blind-watchlist", action="store_true", help="Pseudonymize watchlist terms (weaker recall)")
    parser.add_argument("--decoys", type=int, default=0, help="Number of k-anonymity decoy queries")
    parser.add_argument("--ai-planning", action="store_true", help="Expand the topic into extra query angles")
    parser.add_argument("--llm-process", choices=["hide", "show"], default="hide", help="hide = conceal the research process from the LLM (chaffed prompts). show = send the bare topic and evidence. Watchlist never leaves in either mode.")
    parser.add_argument("--no-conceal-process", action="store_true", help="Alias for --llm-process show. Send the bare topic to the model (no chaffed decoy topics).")
    parser.add_argument("--ai-summary", action="store_true", help="Write a cloud executive brief")
    parser.add_argument("--openai-model", default="gpt-4o-mini", help="OpenAI model for planning or summary")
    parser.add_argument("--reasoning-effort", choices=["low", "medium", "high"], default=None, help="Reasoning effort for o-series models")
    parser.add_argument("--max-spend", type=float, default=2.00, help="Maximum spending cap in USD")
    parser.add_argument("--preview", action="store_true", help="Print SearchPreview and exit")
    parser.add_argument("--check-key", action="store_true", help="Verify the OpenAI key with one minimal live call and exit")
    parser.add_argument("--yes", action="store_true", help="Skip confirm for weaker-recall options")
    parser.add_argument("--ui", action="store_true", help="Launch local browser UI")
    return parser


def build_options(args) -> SearchOptions:
    return SearchOptions(
        max_depth=args.max_depth,
        max_documents=args.max_docs,
        concurrency=args.concurrency,
        max_duration_min=args.max_duration_min,
        max_per_domain=args.max_per_domain,
        max_gap_rounds=args.max_gap_rounds,
        chunk_documents=not args.no_chunk,
        rerank_results=not args.no_rerank,
        rerank_keep=args.rerank_keep,
        citation_expansion=not args.no_citations,
        citation_per_doc=args.citation_per_doc,
        graph_prioritization=not args.no_graph,
        query_rewrite=not args.no_rewrite,
        hyde_queries=not args.no_hyde,
        claim_verification=not args.no_verify,
        blind_watchlist=args.blind_watchlist,
        decoy_queries=args.decoys,
        ai_planning=args.ai_planning,
        llm_process="show" if args.no_conceal_process else args.llm_process,
        ai_summary=args.ai_summary,
        model=args.openai_model,
        concealer_model=args.concealer_model,
        deep_model=args.deep_model,
        reasoning_effort=args.reasoning_effort,
        max_spend_usd=args.max_spend,
    )


def print_preview(topic: str, options: SearchOptions) -> None:
    p = preview(topic, options)
    print(f"Hops: {p.expected_hops}")
    print(f"Sources: {p.expected_sources}")
    print(f"Duration: {p.expected_duration_sec:.0f}s ({p.expected_duration_sec / 60:.1f} min)")
    print(f"Spend: {p.expected_cost_display}")
    print(f"Requires confirm: {p.requires_confirm}")
    if p.warnings:
        print("Tradeoffs:")
        for warning in p.warnings:
            print(f"  - {warning}")


def print_progress(msg: str) -> None:
    print(msg)


def main() -> None:
    try:
        start_searxng_service("127.0.0.1", 8080)
    except Exception as err:
        print(f"SearXNG service not started: {err}", file=sys.stderr)

    parser = build_parser()
    args = parser.parse_args()

    if args.check_key:
        from backend.research.cloud_client import get_api_key, check_openai_key

        if not get_api_key():
            print("OPENAI_API_KEY is not set. Add it to .env or the UI settings.", file=sys.stderr)
            return
        print(f"Pinging OpenAI ({args.openai_model}) with a minimal call...")
        try:
            report = check_openai_key(model=args.openai_model)
        except Exception as err:
            print(f"Key check FAILED: {type(err).__name__}: {err}", file=sys.stderr)
            return
        print(f"Key OK. model={report['model']} reply={report['output_text']!r}")
        print(
            f"Tokens: {report['prompt_tokens']} in / {report['completion_tokens']} out "
            f"(~${report['estimated_cost_usd']:.6f})"
        )
        return

    if args.ui:
        start_ui_server()
        return

    topic_lines = load_lines(args.topic)
    topic = " ".join(topic_lines).strip()
    watchlist = load_lines(args.watchlist)
    if not topic:
        print("Topic is empty.", file=sys.stderr)
        return

    options = build_options(args)
    estimate = preview(topic, options)

    if args.preview:
        print_preview(topic, options)
        return

    if estimate.requires_confirm and not args.yes:
        print_preview(topic, options)
        answer = input("This combination reduces recall. Proceed? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted.")
            return

    try:
        run = run_search(topic, watchlist, options, progress_callback=print_progress)
    except SafetyError:
        print("Blocked by local safety guard")
        return

    print(f"Status: {run.status}")
    print(f"Sources: {len(run.evidence)}")
    if run.archive_path:
        print(f"Report: {run.archive_path}")


if __name__ == "__main__":
    main()
