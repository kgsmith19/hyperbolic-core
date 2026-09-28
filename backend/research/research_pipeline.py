"""Search pipeline: compose guard, planner, explorer, ranker, synthesis, reporter."""

from datetime import datetime
from dataclasses import asdict, replace
import os
import re
import time

from backend.privacy.watchlist_redactor import redact
from backend.ranking.hybrid_ranker import rank_items
from backend.synthesis.local_synthesizer import LocalSynthesizer
from backend.synthesis.openai_synthesizer import summarize_with_openai
from backend.synthesis.report_generator import write_report
from backend.research.cost_estimator import CostTracker, SpendLimitExceededError, SpendReport
from backend.research.cloud_errors import CloudCallError
from backend.research.cancellation import cancellation_manager
from backend.research.types import Evidence, Query, ResearchRun, SearchOptions
from backend.research.guard import prepare_topic
from backend.research.planner import plan_queries
from backend.research.explorer import explore


def run_search(
    topic: str,
    watchlist: list[str],
    options: SearchOptions,
    run_id: str = "default",
    progress_callback=None,
    collector=None,
) -> ResearchRun:
    """Execute one progressive-depth search and return a ResearchRun."""
    start_time = time.time()
    cost_tracker = CostTracker(model=options.deep_model if options.model == "gpt-4o-mini" else options.model, max_spend_usd=options.max_spend_usd)
    cancel_token = cancellation_manager.create_token(run_id)

    if progress_callback:
        progress_callback("Checking the topic against your private list...")
    effective_topic = prepare_topic(topic, watchlist, options)

    if cancel_token.is_set():
        return _empty_run("cancelled", topic, options, cost_tracker, time.time() - start_time)

    warnings: list[str] = []

    def note(message: str) -> None:
        warnings.append(message)
        if progress_callback:
            progress_callback(message)

    if progress_callback:
        if options.ai_planning:
            progress_callback("Asking the model for extra search angles...")
        else:
            progress_callback("Preparing search queries...")
    queries = plan_queries(
        effective_topic,
        watchlist,
        options,
        cost_tracker=cost_tracker,
        progress_callback=note,
    )

    duration_budget = max(60.0, float(options.max_duration_min) * 60.0)
    options = replace(options, max_duration_sec=duration_budget)

    evidence = explore(
        queries,
        watchlist,
        options,
        cancel_token=cancel_token,
        collector=collector,
        progress_callback=progress_callback,
        cost_tracker=cost_tracker,
    )

    if progress_callback:
        progress_callback("Ranking sources by relevance...")
    ranked = rank_items(topic, evidence)

    clean_eval_topic = re.sub(r"\[TARGET_ENTITY_\d+\]", "target component", effective_topic)
    summary = _synthesize(
        clean_eval_topic,
        ranked[:8],
        watchlist,
        options,
        cost_tracker,
        cancel_token,
        note,
    )

    duration = time.time() - start_time
    spend_report = cost_tracker.get_report()
    if progress_callback:
        progress_callback("Writing the report...")

    if options.blind_watchlist:
        clean_report_topic = re.sub(r"\[TARGET_ENTITY_\d+\]", "[PROTECTED-TARGET]", effective_topic)
    else:
        clean_report_topic = redact(topic, watchlist)

    flags = _option_flags(options)
    meta = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mode": flags,
        "cost_str": f"${spend_report.estimated_cost_usd:.4f}",
        "duration_str": f"{duration:.1f}s",
        "model": options.model,
    }
    archive_path = write_report(
        clean_report_topic,
        _evidence_as_dicts(ranked),
        summary,
        watchlist,
        metadata=meta,
    )

    report_md = ""
    if os.path.exists("report.md"):
        try:
            with open("report.md", "r", encoding="utf-8") as f:
                report_md = f.read()
        except Exception:
            report_md = ""

    status = "cancelled" if cancel_token.is_set() else "success"
    cancellation_manager.clear_token(run_id)
    if progress_callback:
        progress_callback("Done.")

    return ResearchRun(
        topic=topic,
        options=options,
        queries=queries,
        evidence=ranked if ranked and isinstance(ranked[0], Evidence) else _dicts_as_evidence(ranked),
        summary=summary,
        spend=spend_report,
        duration_sec=round(duration, 2),
        archive_path=archive_path,
        status=status,
        report_markdown=report_md,
        warnings=warnings,
    )


def run_to_dict(run: ResearchRun) -> dict:
    """Serialize a ResearchRun for HTTP JSON."""
    spend = run.spend
    real_queries = [q.text for q in run.queries if not q.is_decoy]
    return {
        "status": run.status,
        "topic": run.topic,
        "queries": real_queries,
        "evidence": _evidence_as_dicts(run.evidence),
        "summary": run.summary,
        "report_markdown": run.report_markdown,
        "report_archive": run.archive_path,
        "spend_report": {
            "model": spend.model if spend else "none",
            "prompt_tokens": spend.prompt_tokens if spend else 0,
            "completion_tokens": spend.completion_tokens if spend else 0,
            "total_tokens": spend.total_tokens if spend else 0,
            "estimated_cost_usd": spend.estimated_cost_usd if spend else 0.0,
            "is_cap_exceeded": spend.is_cap_exceeded if spend else False,
        },
        "duration_seconds": run.duration_sec,
        "requires_confirm": bool(run.options.blind_watchlist or run.options.decoy_queries > 0),
        "warnings": list(run.warnings),
    }


def _synthesize(topic, evidence, watchlist, options, cost_tracker, cancel_token, progress_callback) -> str:
    evidence_dicts = _evidence_as_dicts(evidence)
    has_openai = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    cancelled = bool(cancel_token is not None and cancel_token.is_set())
    if options.ai_summary and has_openai and not cancelled:
        if progress_callback:
            progress_callback(f"Writing a sourced brief with {options.deep_model}...")
        try:
            return summarize_with_openai(
                topic,
                evidence_dicts,
                watchlist,
                model=options.deep_model,
                reasoning_effort=options.reasoning_effort,
                cost_tracker=cost_tracker,
            )
        except CloudCallError as err:
            if progress_callback:
                if err.cause_type == "SpendLimitExceededError":
                    progress_callback("Spend cap reached. Writing a local summary instead.")
                else:
                    progress_callback(
                        f"AI summary failed ({err.cause_type}). Writing a local summary instead."
                    )
        except SpendLimitExceededError:
            if progress_callback:
                progress_callback("Spend cap reached. Writing a local summary instead.")
    elif options.ai_summary and not has_openai and progress_callback:
        progress_callback("No OpenAI key. Writing a local summary instead.")
    if progress_callback:
        progress_callback("Writing a local summary from the sources...")
    local_slm = LocalSynthesizer()
    summary = local_slm.synthesize(topic, evidence_dicts)
    return redact(summary, watchlist)


def _option_flags(options: SearchOptions) -> str:
    parts = []
    if options.blind_watchlist:
        parts.append("blind")
    if options.decoy_queries:
        parts.append(f"decoys={options.decoy_queries}")
    if options.ai_planning and not options.conceal_process:
        parts.append("unconcealed")
    if options.concealer_model != "gpt-4o-mini" or options.deep_model != "gpt-4o":
        parts.append(f"concealer={options.concealer_model} deep={options.deep_model}")
    if options.ai_planning:
        parts.append("planning")
    if options.ai_summary:
        parts.append("summary")
    return " ".join(parts) if parts else "local"


def _evidence_as_dicts(items: list) -> list[dict]:
    out = []
    for item in items:
        if isinstance(item, Evidence):
            out.append(asdict(item))
        elif isinstance(item, dict):
            out.append(dict(item))
        else:
            out.append({
                "title": getattr(item, "title", ""),
                "url": getattr(item, "url", ""),
                "snippet": getattr(item, "snippet", ""),
                "excerpt": getattr(item, "excerpt", ""),
                "doi": getattr(item, "doi", ""),
                "depth": getattr(item, "depth", 0),
                "source": getattr(item, "source", ""),
                "score": getattr(item, "score", 0.0),
            })
    return out


def _dicts_as_evidence(items: list) -> list[Evidence]:
    out = []
    for d in items:
        if isinstance(d, Evidence):
            out.append(d)
            continue
        out.append(
            Evidence(
                title=d.get("title", ""),
                url=d.get("url", ""),
                snippet=d.get("snippet", ""),
                excerpt=d.get("excerpt", "") or d.get("content", ""),
                doi=d.get("doi", ""),
                depth=int(d.get("depth", 0) or 0),
                source=d.get("source", ""),
                score=float(d.get("score", 0.0) or 0.0),
            )
        )
    return out


def _empty_run(status: str, topic: str, options: SearchOptions, cost_tracker, duration: float) -> ResearchRun:
    spend = cost_tracker.get_report() if cost_tracker else SpendReport(model="none")
    return ResearchRun(
        topic=topic,
        options=options,
        queries=[],
        evidence=[],
        summary="",
        spend=spend,
        duration_sec=round(duration, 2),
        archive_path="",
        status=status,
    )
