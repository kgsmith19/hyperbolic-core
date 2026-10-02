"""Search pipeline: guard -> plan -> rounds of search/read/reflect -> rank -> synthesis -> report."""

from datetime import datetime
import json
import uuid
from dataclasses import asdict, replace
import os
import re
import time

from backend.privacy.watchlist_redactor import redact
from backend.ranking.hybrid_ranker import rank_items
from backend.research.independence import assign_families
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
from backend.research.run_store import RunStore
from backend.research.research_plan import build_research_plan
from backend.research.telemetry import Telemetry


def run_search(
    topic: str,
    watchlist: list[str],
    options: SearchOptions,
    run_id: str = "default",
    progress_callback=None,
    collector=None,
    ledger_root: str = "research_runs",
    _resume_data: dict | None = None,
    event_callback=None,
) -> ResearchRun:
    """Execute one deep research run and return a ResearchRun.

    progress_callback(str) receives human-readable progress lines (CLI, legacy UI).
    event_callback(dict) receives structured telemetry (stages, counters, sources,
    learnings, plan) for the live UI.
    """
    if run_id == "default" and (RunStore(ledger_root).root / run_id).exists():
        run_id = f"run-{uuid.uuid4().hex}"
    start_time = time.time()
    cost_tracker = CostTracker(model=options.deep_model if options.model == "gpt-4o-mini" else options.model, max_spend_usd=options.max_spend_usd)
    cancel_token = cancellation_manager.create_token(run_id)
    telemetry = Telemetry(progress_callback=progress_callback, event_callback=event_callback)
    telemetry.stage("plan", "Planning")
    if watchlist:
        telemetry.log("Checking the topic against your private list...")

    effective_topic = prepare_topic(topic, watchlist, options)
    store = RunStore(ledger_root)
    if _resume_data is None:
        checkpoint = store.create(run_id, effective_topic, options, watchlist)
    else:
        checkpoint = store._checkpoint(_resume_data["manifest"])

    if cancel_token.is_set():
        store.finish("cancelled", "cancelled", watchlist)
        cancelled = _empty_run("cancelled", topic, options, cost_tracker, time.time() - start_time)
        cancelled.run_id, cancelled.stop_reason, cancelled.ledger_path = run_id, "cancelled", checkpoint.ledger_path
        return cancelled

    warnings: list[str] = []

    def note(message: str) -> None:
        warnings.append(message)
        telemetry.log(message, level="warn")

    if options.ai_planning:
        telemetry.log("Asking the model for extra search angles...")
    else:
        telemetry.log("Preparing search queries...")
    plan = build_research_plan(effective_topic, watchlist, options, cost_tracker=cost_tracker, note=note)
    if _resume_data is None:
        queries = plan_queries(
            effective_topic, watchlist, options, cost_tracker=cost_tracker, progress_callback=note,
        )
        queries = _merge_plan_queries(plan, queries)
        store.checkpoint("planned", {"queries": [asdict(query) for query in queries]}, watchlist)
    else:
        queries = [Query(**item) for item in _resume_data["manifest"].get("queries", [])]
        if not queries:
            queries = plan_queries(effective_topic, watchlist, options, cost_tracker=cost_tracker, progress_callback=note)
    plan_dict = plan.to_dict()
    telemetry.plan(plan_dict)
    if len(plan.sub_questions) > 1:
        telemetry.log(f"Plan ready: {len(plan.sub_questions)} research questions, "
                      f"{sum(1 for q in queries if not q.is_decoy)} opening searches.")

    duration_budget = max(60.0, float(options.max_duration_min) * 60.0)
    options = replace(options, max_duration_sec=duration_budget)

    terminal_stop = [None]

    def ledger_checkpoint(phase, payload):
        evidence_item = payload.get("evidence") if isinstance(payload, dict) else None
        if isinstance(evidence_item, Evidence):
            store.append_evidence(evidence_item, watchlist)
        store.checkpoint("fetching" if phase in ("fetch", "evidence") else "searching", payload, watchlist)

    def record_stop(reason):
        terminal_stop[0] = reason

    learnings: list = []
    use_plan = plan if (len(plan.sub_questions) > 1 or options.plan) else None
    prior = _dicts_as_evidence(_resume_data.get("evidence", [])) if _resume_data else None
    evidence = explore(
        queries,
        watchlist,
        options,
        cancel_token=cancel_token,
        collector=collector,
        progress_callback=progress_callback,
        cost_tracker=cost_tracker,
        checkpoint_callback=ledger_checkpoint,
        stop_callback=record_stop,
        frontier_state=_resume_data["manifest"].get("frontier") if _resume_data else None,
        prior_evidence=prior,
        telemetry=telemetry,
        plan=use_plan,
        learnings_out=learnings,
    )

    telemetry.stage("synthesize", "Ranking & cross-checking")
    telemetry.log(f"Ranking {len(evidence)} sources by relevance and quality...")
    ranked = rank_items(topic, evidence)
    ranked = _blend_quality(ranked)

    # Stage-2 local rerank over fused candidates (no egress, milliseconds).
    if options.rerank_results and ranked:
        telemetry.log("Reranking top candidates for synthesis...")
        try:
            from backend.ranking.reranker import rerank_candidates
            rerank_in = _evidence_as_dicts(ranked)
            reranked = rerank_candidates(topic, rerank_in, keep=options.rerank_keep)
            if reranked:
                ranked = _dicts_as_evidence(reranked)
                if any(e.quality for e in ranked):
                    ranked.sort(key=lambda e: -(0.8 * float(e.rerank_score or 0) + 0.2 * float(e.quality or 0)))
        except Exception:
            pass

    clean_eval_topic = re.sub(r"\[TARGET_ENTITY_\d+\]", "target component", effective_topic)

    # Group ranked evidence into near-duplicate/syndication families (local-only).
    families_records = []
    try:
        ranked, families_records = assign_families(ranked)
    except Exception:
        families_records = []

    followups: list = []
    try:
        from backend.synthesis.deep_report import suggest_followups
        followups = suggest_followups(clean_eval_topic, use_plan, ranked, learnings)
    except Exception:
        followups = []

    telemetry.stage("report", "Writing the report")

    def synth_note(message: str) -> None:
        # Only fallbacks and failures are warnings; the rest is progress.
        if re.search(r"failed|cap reached|no openai key|unavailable", message, re.I):
            note(message)
        else:
            telemetry.log(message)

    summary, independence_report = _synthesize(
        clean_eval_topic,
        ranked,
        watchlist,
        options,
        cost_tracker,
        cancel_token,
        synth_note,
        families_records=families_records,
        plan=use_plan,
        learnings=learnings,
        followups=followups,
    )

    duration = time.time() - start_time
    spend_report = cost_tracker.get_report()
    telemetry.log("Writing the report...")

    if options.blind_watchlist:
        clean_report_topic = re.sub(r"\[TARGET_ENTITY_\d+\]", "[PROTECTED-TARGET]", effective_topic)
    else:
        clean_report_topic = redact(topic, watchlist)

    status = "cancelled" if cancel_token.is_set() else "success"
    stop_reason = "cancelled" if status == "cancelled" else (terminal_stop[0] or "completed")

    flags = _option_flags(options)
    meta = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mode": flags,
        "cost_str": f"${spend_report.estimated_cost_usd:.4f}",
        "duration_str": f"{duration:.1f}s",
        "model": options.model,
    }
    stats = telemetry.snapshot()
    stats.update({
        "duration_sec": round(duration, 1),
        "sources": len(ranked),
        "queries": sum(1 for q in queries if not q.is_decoy),
        "lane_counts": _lane_counts(ranked),
        "stop_reason": stop_reason,
    })
    archive_path = write_report(
        clean_report_topic,
        _evidence_as_dicts(ranked),
        summary,
        watchlist,
        metadata=meta,
        independence=independence_report,
        appendix=_appendix(use_plan, queries, learnings, stats, options),
    )

    report_md = ""
    if os.path.exists("report.md"):
        try:
            with open("report.md", "r", encoding="utf-8") as f:
                report_md = f.read()
        except Exception:
            report_md = ""

    store.finish(status, stop_reason, watchlist)
    cancellation_manager.clear_token(run_id)
    telemetry.stage("done", "Done")
    telemetry.log("Done.")

    run = ResearchRun(
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
        run_id=run_id,
        stop_reason=stop_reason,
        ledger_path=checkpoint.ledger_path,
        phase="completed",
        plan=_safe_jsonable(plan_dict, watchlist, {}),
        learnings=_safe_jsonable(learnings, watchlist, []),
        followups=_safe_jsonable(followups, watchlist, []),
        stats=stats,
    )
    _write_json_archive(run, watchlist)
    return run


def resume_search(run_id: str, watchlist: list[str], *, progress_callback=None, collector=None,
                  ledger_root: str = "research_runs", event_callback=None) -> ResearchRun:
    """Resume a non-successful local ledger with fresh collector processes."""
    store = RunStore(ledger_root)
    data = store.load(run_id, watchlist)
    manifest = data["manifest"]
    if manifest.get("status") == "success":
        raise RuntimeError("completed successful runs cannot be resumed")
    store.reopen_for_resume(watchlist)
    known = set(SearchOptions.__dataclass_fields__)
    options = SearchOptions(**{k: v for k, v in manifest["options"].items() if k in known})
    return run_search(manifest["topic"], watchlist, options, run_id=run_id,
                      progress_callback=progress_callback, collector=collector,
                      ledger_root=ledger_root, _resume_data=data, event_callback=event_callback)


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
        "run_id": run.run_id,
        "phase": run.phase,
        "stop_reason": run.stop_reason,
        "ledger_path": run.ledger_path,
        "plan": getattr(run, "plan", {}) or {},
        "learnings": list(getattr(run, "learnings", []) or []),
        "followups": list(getattr(run, "followups", []) or []),
        "stats": dict(getattr(run, "stats", {}) or {}),
        "options": _options_public(run.options),
    }


def _synthesize(topic, evidence, watchlist, options, cost_tracker, cancel_token, progress_callback,
                families_records=None, plan=None, learnings=None, followups=None):
    evidence_dicts = _evidence_as_dicts(evidence)
    has_openai = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    cancelled = bool(cancel_token is not None and cancel_token.is_set())
    deep = bool(plan is not None and len(getattr(plan, "sub_questions", []) or []) > 1) or bool(options.source_lanes)

    # Independence: count corroboration by family, not URL.
    family_map = None
    if families_records:
        family_map = {e.url: e.family_id for e in evidence if getattr(e, "family_id", -1) >= 0} or None
    independence_report = None
    if families_records:
        multi = sorted([f for f in families_records if f.size > 1], key=lambda f: -f.size)
        title_by_url = {e.url: e.title for e in evidence}
        independence_report = {
            "families": len(families_records),
            "largest_family": max((f.size for f in families_records), default=0),
            "multi": [
                {"title": title_by_url.get(f.representative_url, f.representative_url), "size": f.size}
                for f in multi
            ],
        }

    verification = None
    if options.claim_verification and evidence_dicts:
        try:
            from backend.synthesis.claim_verifier import verify_evidence
            verification = verify_evidence(evidence_dicts, families=family_map)
            n_contested = len(verification.get("contested", []))
            n_verified = len(verification.get("verified", []))
            collapsed = (verification.get("independence") or {}).get("collapsed_claims", 0)
            if progress_callback and (n_contested or n_verified):
                progress_callback(
                    f"Cross-checked claims: {n_verified} corroborated, "
                    f"{n_contested} contested across sources."
                )
            if progress_callback and collapsed:
                progress_callback(
                    f"Independence check: {collapsed} claim(s) collapsed to a single source-family."
                )
        except Exception:
            verification = None

    if deep:
        return _deep_brief(topic, evidence_dicts, watchlist, options, cost_tracker, cancelled, has_openai,
                           progress_callback, plan, learnings, followups, verification), independence_report

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
                verification=verification,
            ), independence_report
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
    return redact(summary, watchlist), independence_report


def _deep_brief(topic, evidence_dicts, watchlist, options, cost_tracker, cancelled, has_openai,
                progress_callback, plan, learnings, followups, verification) -> str:
    from backend.synthesis.deep_report import build_llm_brief, build_local_brief

    if options.ai_summary and has_openai and not cancelled and evidence_dicts:
        if progress_callback:
            progress_callback(f"Writing a sectioned, cited report with {options.deep_model}...")
        try:
            return build_llm_brief(topic, evidence_dicts, watchlist, plan=plan, verification=verification,
                                   followups=followups, model=options.deep_model,
                                   reasoning_effort=options.reasoning_effort, cost_tracker=cost_tracker,
                                   progress_callback=progress_callback)
        except SpendLimitExceededError:
            if progress_callback:
                progress_callback("Spend cap reached. Writing a local summary instead.")
        except Exception as err:
            if progress_callback:
                progress_callback(f"AI report failed ({type(err).__name__}). Writing a local summary instead.")
    elif options.ai_summary and not has_openai and progress_callback:
        progress_callback("No OpenAI key. Writing a local summary instead.")
    if progress_callback:
        progress_callback("Writing a structured local report from the sources...")
    brief = build_local_brief(topic, evidence_dicts, plan=plan, learnings=learnings,
                              verification=verification, followups=followups)
    return redact(brief, watchlist)


def _merge_plan_queries(plan, queries: list[Query]) -> list[Query]:
    """Topic first, then plan queries (sub-question order), extra planner angles, then decoys."""
    real = [q for q in queries if not q.is_decoy]
    decoys = [q for q in queries if q.is_decoy]
    merged: list[Query] = []
    seen: set[str] = set()

    def add(q: Query) -> None:
        key = q.text.lower()
        if key not in seen:
            seen.add(key)
            merged.append(q)

    if real:
        add(real[0])
    for text in plan.all_queries():
        add(Query(text=text, is_decoy=False))
    for q in real[1:]:
        add(q)
    return merged + decoys


def _blend_quality(ranked: list) -> list:
    """Final order = relevance (RRF) blended with the source-quality prior."""
    if not ranked or not any(isinstance(e, Evidence) and float(e.quality or 0) > 0 for e in ranked):
        return ranked
    blended = []
    for e in ranked:
        if isinstance(e, Evidence) and e.quality:
            blended.append(replace(e, score=round(0.75 * float(e.score or 0) + 25.0 * float(e.quality), 1)))
        else:
            blended.append(e)
    blended.sort(key=lambda e: -float(getattr(e, "score", 0) or 0))
    return blended


def _lane_counts(evidence: list) -> dict:
    counts: dict[str, int] = {}
    for e in evidence:
        lane = e.get("lane", "") if isinstance(e, dict) else getattr(e, "lane", "")
        lane = lane or "web"
        counts[lane] = counts.get(lane, 0) + 1
    return counts


def _appendix(plan, queries, learnings, stats, options) -> list[tuple[str, str]]:
    method = [
        f"- **Sources kept:** {stats.get('sources', 0)} · **searches:** {stats.get('searches', 0)} · "
        f"**pages read:** {stats.get('fetched', 0)} · **failed/blocked:** {stats.get('failed', 0)}",
        f"- **Reflection rounds:** {stats.get('round', 0)} of {options.max_gap_rounds} · "
        f"**max hops:** {options.max_depth} · **stop reason:** {stats.get('stop_reason', 'completed')}",
    ]
    if options.source_lanes:
        mix = ", ".join(f"{k} {v}" for k, v in sorted((stats.get("lane_counts") or {}).items(), key=lambda kv: -kv[1]))
        method.append(f"- **Source mix target:** {round(options.academic_weight * 100)}% research / "
                      f"{round((1 - options.academic_weight) * 100)}% discussion · **actual:** {mix}")
    if plan is not None and len(plan.sub_questions) > 1:
        method.append("- **Research questions:**")
        method += [f"  {i}. {sq.question}" for i, sq in enumerate(plan.sub_questions, start=1)]
    real = [q.text for q in queries if not q.is_decoy]
    if real:
        method.append(f"- **Opening searches ({len(real)}):** " + "; ".join(real[:20]) + (" …" if len(real) > 20 else ""))
    sections = [("Methodology", "\n".join(method))]
    if learnings:
        sections.append(("Research Log", "\n".join(
            f"- Round {item.get('round', '?')}: {item.get('text', '')} ({item.get('url', '')})"
            for item in learnings[:60])))
    return sections


def _safe_jsonable(value, watchlist, default):
    try:
        return RunStore._sanitize(value, watchlist)
    except Exception:
        return default


def _options_public(options: SearchOptions) -> dict:
    keep = ("max_depth", "max_documents", "max_duration_min", "concurrency", "max_gap_rounds", "breadth",
            "academic_weight", "source_lanes", "ai_planning", "ai_summary", "llm_process", "blind_watchlist",
            "decoy_queries", "deep_model", "concealer_model", "follow_leads", "citation_expansion")
    return {k: getattr(options, k, None) for k in keep}


def _write_json_archive(run: ResearchRun, watchlist) -> None:
    """Store the full structured result next to the markdown archive so the UI can reopen it."""
    if not run.archive_path or not os.path.exists(run.archive_path):
        return
    try:
        payload = run_to_dict(run)
        payload.pop("report_markdown", None)
        payload = RunStore._sanitize(payload, watchlist)
        path = os.path.splitext(run.archive_path)[0] + ".json"
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except Exception:
        pass


def _option_flags(options: SearchOptions) -> str:
    parts = []
    if options.blind_watchlist:
        parts.append("blind")
    if options.decoy_queries:
        parts.append(f"decoys={options.decoy_queries}")
    parts.append(f"llm={options.llm_process}")
    if options.concealer_model != "gpt-4o-mini" or options.deep_model != "gpt-4o":
        parts.append(f"concealer={options.concealer_model} deep={options.deep_model}")
    if options.ai_planning:
        parts.append("planning")
    if options.ai_summary:
        parts.append("summary")
    if options.breadth > 1:
        parts.append(f"breadth={options.breadth}")
    if options.source_lanes:
        parts.append(f"mix={round(options.academic_weight * 100)}/{round((1 - options.academic_weight) * 100)}")
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
                "lane": getattr(item, "lane", ""),
                "quality": getattr(item, "quality", 0.0),
                "subq": getattr(item, "subq", ""),
                "meta": getattr(item, "meta", {}) or {},
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
                rerank_score=float(d.get("rerank_score", 0.0) or 0.0),
                simhash=int(d.get("simhash", 0) or 0),
                family_id=int(d.get("family_id", -1) if d.get("family_id", -1) is not None else -1),
                is_representative=bool(d.get("is_representative", False)),
                lane=str(d.get("lane", "") or ""),
                quality=float(d.get("quality", 0.0) or 0.0),
                subq=str(d.get("subq", "") or ""),
                meta=d.get("meta") if isinstance(d.get("meta"), dict) else {},
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
