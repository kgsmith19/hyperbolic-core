"""Local browser UI server and REST/SSE API.

Endpoints
---------
GET  /                          UI
GET  /api/defaults              topic.txt / watchlist.txt defaults
GET  /api/presets               depth presets + lane catalogue
GET  /api/models                model list and pricing
GET  /api/settings              provider status (keys masked)
POST /api/settings              save keys / endpoints to .env
POST /api/estimate              SearchPreview for a payload
POST /api/plan                  draft research plan (editable in the UI)
POST /api/research              start a run and stream its events (SSE)
GET  /api/runs                  runs known to this server (active + recent)
GET  /api/runs/stream?run_id=&from=N   re-attach to a run's event stream
POST /api/cancel                stop a run gracefully (writes a partial report)
POST /api/resume                resume an interrupted ledger run (SSE)
GET  /api/reports               archived reports
GET  /api/reports/view?file=    archived markdown
GET  /api/reports/result?file=  archived structured result (JSON)
"""

from datetime import datetime
import http.server
import json
import mimetypes
import os
import socketserver
import threading
import urllib.parse
import webbrowser
from dataclasses import asdict

from backend.server.configuration import load_env_file, load_lines, save_env_file
from backend.server.run_registry import registry
from backend.privacy.watchlist_redactor import SafetyError
from backend.retrieval.collector_client import reset_collector
from backend.research.research_pipeline import run_search, resume_search, run_to_dict
from backend.research.types import SearchOptions
from backend.research.preview import preview
from backend.research.presets import DEFAULT_LANES, preset_values, public_presets
from backend.research.cost_estimator import MODEL_PRICING
from backend.research.cancellation import cancellation_manager
from backend.retrieval.meta.searxng_server import is_port_in_use, start_searxng_service

load_env_file()

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ROOT_DIR = os.path.dirname(_BACKEND_DIR)
_FRONTEND_DIR = os.path.join(_ROOT_DIR, "frontend")
_REPORTS_DIR = os.path.join(_ROOT_DIR, "reports")
_SSE_EVENT_TYPES = {"stage", "stats", "plan", "round", "source", "learning"}


class ThreadedUIServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def _num(data: dict, key: str, default, cast=int):
    try:
        value = data.get(key, default)
        return cast(value if value is not None else default)
    except (TypeError, ValueError):
        return cast(default)


def _options_from_payload(data: dict) -> SearchOptions:
    """Build SearchOptions from a UI/API payload. Presets fill only unset fields."""
    base = {
        "max_depth": 4, "max_documents": 40, "max_duration_min": 15.0, "concurrency": 4, "max_per_domain": 6,
        "max_gap_rounds": 3, "breadth": 1, "queries_per_round": 4, "results_per_lane": 8, "llm_gap_rounds": 1,
    }
    base.update(preset_values(data.get("preset")))
    legacy_model = str(data.get("openai_model", data.get("model", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))))
    if "max_duration_min" in data:
        duration_min = _num(data, "max_duration_min", base["max_duration_min"], float)
    elif "max_duration_sec" in data:
        duration_min = _num(data, "max_duration_sec", 900.0, float) / 60.0
    else:
        duration_min = float(base["max_duration_min"])

    llm_process = data.get("llm_process")
    if llm_process is None and "conceal_process" in data:
        llm_process = "hide" if data.get("conceal_process") else "show"

    lanes = data.get("source_lanes")
    if lanes is None and data.get("preset"):
        lanes = list(DEFAULT_LANES)
    if isinstance(lanes, list):
        lanes = [str(lane) for lane in lanes if isinstance(lane, str)][:16] or None
    else:
        lanes = None

    max_documents = _num(data, "max_documents", data.get("max_docs", base["max_documents"]))
    plan = data.get("plan") if isinstance(data.get("plan"), list) else None
    exclude = data.get("exclude_urls") if isinstance(data.get("exclude_urls"), list) else None

    return SearchOptions(
        max_depth=_num(data, "max_depth", base["max_depth"]),
        max_documents=max_documents,
        max_duration_min=min(720.0, max(1.0, duration_min)),
        concurrency=max(1, min(16, _num(data, "concurrency", base["concurrency"]))),
        max_per_domain=_num(data, "max_per_domain", base["max_per_domain"]),
        max_gap_rounds=_num(data, "max_gap_rounds", base["max_gap_rounds"]),
        chunk_documents=bool(data.get("chunk_documents", True)),
        rerank_results=bool(data.get("rerank_results", True)),
        rerank_keep=_num(data, "rerank_keep", max(12, max_documents) if data.get("preset") else 12),
        citation_expansion=bool(data.get("citation_expansion", True)),
        citation_per_doc=_num(data, "citation_per_doc", 5),
        graph_prioritization=bool(data.get("graph_prioritization", True)),
        query_rewrite=bool(data.get("query_rewrite", True)),
        hyde_queries=bool(data.get("hyde_queries", True)),
        claim_verification=bool(data.get("claim_verification", True)),
        blind_watchlist=bool(data.get("blind_watchlist", False)),
        decoy_queries=_num(data, "decoy_queries", 0),
        ai_planning=bool(data.get("ai_planning", False)),
        llm_process=str(llm_process) if llm_process is not None else None,
        # The AI-written report is the default whenever a key is configured.
        ai_summary=bool(data.get("ai_summary", bool(os.environ.get("OPENAI_API_KEY", "").strip() or os.environ.get("ANTHROPIC_API_KEY", "").strip() or os.environ.get("GEMINI_API_KEY", "").strip() or os.environ.get("GOOGLE_API_KEY", "").strip()))),
        model=legacy_model,
        concealer_model=str(data.get("concealer_model", legacy_model)),
        deep_model=str(data.get("deep_model", "gpt-4o" if legacy_model == "gpt-4o-mini" else legacy_model)),
        reasoning_effort=data.get("reasoning_effort"),
        max_spend_usd=_num(data, "max_spend_usd", 2.00, float),
        low_information_gain_rounds=_num(data, "low_information_gain_rounds", 0),
        low_information_gain_min_documents=_num(data, "low_information_gain_min_documents", 0),
        strictness=_num(data, "strictness", 0.9, float),
        force_direction=bool(data.get("force_direction", True)),
        report_format=str(data.get("report_format", "comprehensive")),
        academic_weight=_num(data, "academic_weight", 0.5, float),
        source_lanes=lanes,
        results_per_lane=_num(data, "results_per_lane", base["results_per_lane"]),
        breadth=_num(data, "breadth", base["breadth"]),
        plan=plan,
        llm_gap_rounds=_num(data, "llm_gap_rounds", base["llm_gap_rounds"]),
        follow_leads=bool(data.get("follow_leads", True)),
        queries_per_round=_num(data, "queries_per_round", base["queries_per_round"]),
        exclude_urls=[str(u) for u in exclude[:5000]] if exclude else None,
        context_topic=str(data.get("context_topic", ""))[:300],
    )


def _report_title(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            first = handle.readline().strip()
        return first.replace("# Research Report:", "").strip() or os.path.basename(path)
    except Exception:
        return os.path.basename(path)


class SafeResearchRequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP Request Handler for the local browser interface."""

    def log_message(self, format, *args):
        return

    # ------------------------------------------------------------------ helpers
    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else ""
        return json.loads(raw) if raw else {}

    def _serve_file(self, file_path: str, default_content_type: str = "text/plain") -> None:
        if not os.path.exists(file_path) or not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            return
        ctype, _ = mimetypes.guess_type(file_path)
        content_type = ctype or default_content_type
        if "text" in content_type or "javascript" in content_type or "json" in content_type:
            content_type += "; charset=utf-8"
        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_response(500)
            self.end_headers()

    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _stream_handle(self, handle, start: int = 0) -> None:
        """Replay buffered events from `start`, then follow live until the run ends."""
        index = max(0, int(start))
        while True:
            events, done = handle.wait_from(index, timeout=15.0)
            try:
                if not events and not done:
                    self.wfile.write(b": keepalive\n\n")
                for event in events:
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                self.wfile.flush()
            except Exception:
                return  # client went away; the run keeps going
            index += len(events)
            if done and index >= len(handle.events):
                return

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if clean_path in ("/", "/index.html"):
            self._serve_file(os.path.join(_FRONTEND_DIR, "public", "index.html"), "text/html")
        elif clean_path.startswith("/css/") or clean_path.startswith("/js/"):
            rel_path = os.path.normpath(clean_path.lstrip("/"))
            if rel_path.startswith(".."):
                self.send_response(404)
                self.end_headers()
                return
            self._serve_file(os.path.join(_FRONTEND_DIR, rel_path),
                             "text/css" if clean_path.startswith("/css/") else "application/javascript")
        elif clean_path == "/api/defaults":
            topic = " ".join(load_lines(os.path.join(_ROOT_DIR, "topic.txt"))).strip()
            watchlist = "\n".join(load_lines(os.path.join(_ROOT_DIR, "watchlist.txt"))).strip()
            self._json({"topic": topic, "watchlist": watchlist})
        elif clean_path == "/api/presets":
            self._json(public_presets())
        elif clean_path == "/api/models":
            self._json({
                "models": [{"id": m, "name": m, "input_per_m": r["input"], "output_per_m": r["output"]}
                           for m, r in MODEL_PRICING.items()],
                "model_ids": list(MODEL_PRICING.keys()),
                "default": "gpt-4o-mini",
                "pricing": MODEL_PRICING,
                "reasoning_efforts": ["low", "medium", "high"],
            })
        elif clean_path == "/api/reports":
            reports = []
            if os.path.exists(_REPORTS_DIR):
                for f in sorted(os.listdir(_REPORTS_DIR), reverse=True):
                    if f.endswith(".md"):
                        fpath = os.path.join(_REPORTS_DIR, f)
                        stat = os.stat(fpath)
                        reports.append({
                            "filename": f,
                            "title": _report_title(fpath),
                            "size_bytes": stat.st_size,
                            "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                            "has_result": os.path.exists(os.path.splitext(fpath)[0] + ".json"),
                        })
            self._json({"reports": reports})
        elif clean_path == "/api/reports/view":
            safe_name = os.path.basename(qs.get("file", [""])[0])
            self._serve_file(os.path.join(_REPORTS_DIR, safe_name), "text/markdown")
        elif clean_path == "/api/reports/result":
            safe_name = os.path.basename(qs.get("file", [""])[0])
            path = os.path.join(_REPORTS_DIR, os.path.splitext(safe_name)[0] + ".json")
            if not os.path.exists(path):
                self._json({"error": "No structured result stored for this report."}, 404)
                return
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                md_path = os.path.join(_REPORTS_DIR, os.path.splitext(safe_name)[0] + ".md")
                if os.path.exists(md_path):
                    with open(md_path, "r", encoding="utf-8") as handle:
                        data["report_markdown"] = handle.read()
                self._json(data)
            except Exception as err:
                self._json({"error": str(err)}, 500)
        elif clean_path == "/api/runs":
            self._json({"runs": registry.list()})
        elif clean_path == "/api/runs/stream":
            handle = registry.get(qs.get("run_id", [""])[0])
            if handle is None:
                self._json({"error": "unknown run"}, 404)
                return
            self._start_sse()
            self._stream_handle(handle, _num({"f": qs.get("from", ["0"])[0]}, "f", 0))
        elif clean_path == "/api/settings":
            brave_key = os.environ.get("BRAVE_SEARCH_API_KEY", "")
            openai_key = os.environ.get("OPENAI_API_KEY", "")
            anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
            gemini_key = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
            s2_key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "")
            searxng_active = False
            try:
                searxng_active = is_port_in_use(8080)
            except Exception:
                pass
            self._json({
                "has_brave": bool(brave_key),
                "brave_preview": f"{brave_key[:4]}...{brave_key[-3:]}" if len(brave_key) > 7 else ("***" if brave_key else ""),
                "has_openai": bool(openai_key),
                "openai_preview": f"{openai_key[:3]}...{openai_key[-4:]}" if len(openai_key) > 7 else ("***" if openai_key else ""),
                "has_anthropic": bool(anthropic_key),
                "anthropic_preview": f"{anthropic_key[:3]}...{anthropic_key[-4:]}" if len(anthropic_key) > 7 else ("***" if anthropic_key else ""),
                "has_gemini": bool(gemini_key),
                "gemini_preview": f"{gemini_key[:3]}...{gemini_key[-4:]}" if len(gemini_key) > 7 else ("***" if gemini_key else ""),
                "has_s2": bool(s2_key),
                "searxng_url": os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080"),
                "searxng_active": searxng_active,
                "local_llm_url": os.environ.get("LOCAL_LLM_URL", "http://127.0.0.1:11434/v1"),
                "default_model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                "models": list(MODEL_PRICING.keys()),
            })
        else:
            self.send_response(404)
            self.end_headers()

    # ------------------------------------------------------------------ POST
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/estimate":
            try:
                data = self._body()
                if "mode" in data:
                    self._json({"error": "mode is not supported; send SearchOptions fields"}, 400)
                    return
                options = _options_from_payload(data)
                self._json(asdict(preview(data.get("topic", ""), options)))
            except Exception as e:
                self._json({"error": str(e)}, 400)
        elif path == "/api/plan":
            self._handle_plan()
        elif path == "/api/cancel":
            try:
                data = self._body()
            except Exception:
                data = {}
            run_id = data.get("run_id") if isinstance(data, dict) else None
            if run_id:
                ok = cancellation_manager.cancel_run(run_id)
            else:
                ids = registry.active_ids()
                for rid in ids:
                    cancellation_manager.cancel_run(rid)
                cancellation_manager.cancel_run("default")
                ok = True
            self._json({"status": "cancelled" if ok else "unknown_run",
                        "message": "Stopping. A report is being written from everything gathered so far."})
        elif path == "/api/resume":
            try:
                data = self._body()
                run_id = data.get("run_id", "")
                if not isinstance(run_id, str) or not run_id.strip():
                    raise ValueError("run_id is required")
                watchlist = [line.strip() for line in str(data.get("watchlist", "")).splitlines() if line.strip()]
            except (ValueError, json.JSONDecodeError) as err:
                self._json({"error": str(err)}, 400)
                return
            handle = registry.create(f"resume {run_id}", {})
            self._launch(handle, lambda progress, events: resume_search(
                run_id, watchlist, progress_callback=progress, event_callback=events,
                ledger_root=os.path.join(_ROOT_DIR, "research_runs")))
            self._start_sse()
            self._stream_handle(handle)
        elif path == "/api/settings":
            try:
                data = self._body()
                updates = {}
                for field, env in (("brave_key", "BRAVE_SEARCH_API_KEY"), ("openai_key", "OPENAI_API_KEY"),
                                   ("anthropic_key", "ANTHROPIC_API_KEY"), ("gemini_key", "GEMINI_API_KEY"),
                                   ("s2_key", "SEMANTIC_SCHOLAR_API_KEY")):
                    if field in data and isinstance(data[field], str) and not data[field].startswith("***"):
                        updates[env] = data[field].strip()
                if "searxng_url" in data:
                    updates["SEARXNG_URL"] = str(data["searxng_url"]).strip()
                if "local_llm_url" in data:
                    updates["LOCAL_LLM_URL"] = str(data["local_llm_url"]).strip()
                if "openai_model" in data:
                    updates["OPENAI_MODEL"] = str(data["openai_model"]).strip()
                if updates:
                    save_env_file(updates)
                reset_collector()
                self._json({"status": "ok"})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif path == "/api/research":
            self._handle_research()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_plan(self) -> None:
        try:
            data = self._body()
        except Exception:
            self._json({"error": "Invalid JSON body"}, 400)
            return
        topic = str(data.get("topic", "")).strip()
        if not topic:
            self._json({"error": "Add a topic first."}, 400)
            return
        watchlist = [line.strip() for line in str(data.get("watchlist", "")).splitlines() if line.strip()]
        try:
            from backend.research.cost_estimator import CostTracker
            from backend.research.guard import prepare_topic
            from backend.research.research_plan import build_research_plan

            options = _options_from_payload({**data, "plan": None})
            if options.breadth <= 1:
                options = _options_from_payload({**data, "plan": None, "breadth": 6})
            effective = prepare_topic(topic, watchlist, options)
            tracker = CostTracker(model=options.concealer_model, max_spend_usd=options.max_spend_usd)
            notes: list[str] = []
            plan = build_research_plan(effective, watchlist, options, cost_tracker=tracker, note=notes.append)
            self._json({"plan": plan.to_dict(), "notes": notes,
                        "spend_usd": tracker.get_report().estimated_cost_usd})
        except SafetyError:
            self._json({"error": "Blocked by local safety guard: the topic contains a private word."}, 400)
        except Exception as err:
            self._json({"error": f"Planning failed: {err}"}, 500)

    def _launch(self, handle, runner) -> None:
        """Run `runner(progress, events)` on a background thread, feeding the handle."""

        def progress(message: str) -> None:
            handle.push({"type": "progress", "message": message})

        def events(event: dict) -> None:
            if event.get("type") in _SSE_EVENT_TYPES:
                handle.push(event)

        def work():
            try:
                run = runner(progress, events)
                payload = run_to_dict(run)
                handle.result_file = os.path.basename(payload.get("report_archive") or "")
                handle.push({"type": "result", **payload})
                handle.finish(payload.get("status", "success"))
            except SafetyError:
                handle.push({"type": "error", "error": "Blocked by local safety guard"})
                handle.finish("error")
            except Exception as e:
                handle.push({"type": "error", "error": f"An error occurred during research: {str(e)}"})
                handle.finish("error")

        threading.Thread(target=work, name=f"research-{handle.run_id}", daemon=True).start()

    def _handle_research(self) -> None:
        try:
            data = self._body()
        except Exception:
            self._json({"error": "Invalid JSON body"}, 400)
            return
        if "mode" in data:
            self._json({"error": "mode is not supported; send SearchOptions fields"}, 400)
            return

        topic = str(data.get("topic", "")).strip()
        watchlist = [line.strip() for line in str(data.get("watchlist", "")).splitlines() if line.strip()]
        for field, env in (("openai_key", "OPENAI_API_KEY"), ("anthropic_key", "ANTHROPIC_API_KEY"),
                            ("gemini_key", "GEMINI_API_KEY"), ("brave_key", "BRAVE_SEARCH_API_KEY")):
            val = data.get(field)
            if val and not str(val).startswith("***") and str(val).strip():
                os.environ[env] = str(val).strip()
                save_env_file({env: str(val).strip()})
        try:
            options = _options_from_payload(data)
        except Exception as err:
            self._json({"error": f"Invalid options: {err}"}, 400)
            return

        from backend.research.research_pipeline import _options_public
        handle = registry.create(topic, _options_public(options))
        handle.push({"type": "run", "run_id": handle.run_id, "topic": topic, "options": handle.options})
        self._launch(handle, lambda progress, events: run_search(
            topic=topic, watchlist=watchlist, options=options, run_id=handle.run_id,
            progress_callback=progress, event_callback=events))
        self._start_sse()
        self._stream_handle(handle)


def start_ui_server(port: int = 8765, open_browser: bool = True) -> None:
    """Launch the local browser UI server and ensure the SearXNG service is active."""
    try:
        start_searxng_service("127.0.0.1", 8080)
    except Exception:
        pass

    with ThreadedUIServer(("127.0.0.1", port), SafeResearchRequestHandler) as httpd:
        url = f"http://127.0.0.1:{port}"
        print(f"Deep Search UI active at: {url}")
        if open_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down UI server.")
