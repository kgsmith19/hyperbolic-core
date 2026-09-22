"""Local Browser Web Interface & REST API Server with Spend Controls & Cancellation.

Serves modular frontend assets (HTML, CSS, JS) and handles REST endpoints
for research execution, provider configuration, model selection, live cancellation,
and report archives.
"""

from datetime import datetime
import http.server
import json
import mimetypes
import os
import socketserver
import urllib.parse
import webbrowser

from backend.server.configuration import load_env_file, load_lines, save_env_file
from backend.privacy.watchlist_redactor import SafetyError
from backend.retrieval.collector_client import reset_collector
from backend.research.research_pipeline import run_search, run_to_dict
from backend.research.types import SearchOptions
from backend.research.cost_estimator import MODEL_PRICING, estimate_research_workload
from backend.research.cancellation import cancellation_manager
from backend.retrieval.meta.searxng_server import is_port_in_use, start_searxng_service

# Initialize environment from .env file
load_env_file()

# Locate root directory, frontend directory, and reports directory
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ROOT_DIR = os.path.dirname(_BACKEND_DIR)
_FRONTEND_DIR = os.path.join(_ROOT_DIR, "frontend")
_REPORTS_DIR = os.path.join(_ROOT_DIR, "reports")


class SafeResearchRequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP Request Handler for the local browser interface."""

    def log_message(self, format, *args):
        return

    def _serve_file(self, file_path: str, default_content_type: str = "text/plain") -> None:
        """Serve a static file from disk with proper MIME type."""
        if not os.path.exists(file_path) or not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            return

        ctype, _ = mimetypes.guess_type(file_path)
        content_type = ctype or default_content_type
        if "text" in content_type or "javascript" in content_type:
            content_type += "; charset=utf-8"

        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_response(500)
            self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path

        if clean_path in ("/", "/index.html"):
            index_path = os.path.join(_FRONTEND_DIR, "public", "index.html")
            self._serve_file(index_path, "text/html")
        elif clean_path.startswith("/css/"):
            rel_path = clean_path.lstrip("/")
            file_path = os.path.join(_FRONTEND_DIR, rel_path)
            self._serve_file(file_path, "text/css")
        elif clean_path.startswith("/js/"):
            rel_path = clean_path.lstrip("/")
            file_path = os.path.join(_FRONTEND_DIR, rel_path)
            self._serve_file(file_path, "application/javascript")
        elif clean_path == "/api/defaults":
            topic_path = os.path.join(_ROOT_DIR, "topic.txt")
            watchlist_path = os.path.join(_ROOT_DIR, "watchlist.txt")
            topic = " ".join(load_lines(topic_path)).strip()
            watchlist = "\n".join(load_lines(watchlist_path)).strip()
            payload = json.dumps({"topic": topic, "watchlist": watchlist})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
        elif clean_path == "/api/models":
            models_info = [
                {
                    "id": m_id,
                    "name": m_id,
                    "input_per_m": rates["input"],
                    "output_per_m": rates["output"],
                }
                for m_id, rates in MODEL_PRICING.items()
            ]
            payload = json.dumps({
                "models": models_info,
                "model_ids": list(MODEL_PRICING.keys()),
                "default": "gpt-4o-mini",
                "pricing": MODEL_PRICING,
                "reasoning_efforts": ["low", "medium", "high"],
            })
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
        elif clean_path == "/api/reports":
            reports = []
            if os.path.exists(_REPORTS_DIR):
                for f in sorted(os.listdir(_REPORTS_DIR), reverse=True):
                    if f.endswith(".md"):
                        fpath = os.path.join(_REPORTS_DIR, f)
                        stat = os.stat(fpath)
                        reports.append({
                            "filename": f,
                            "size_bytes": stat.st_size,
                            "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                        })
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"reports": reports}).encode("utf-8"))
        elif clean_path == "/api/reports/view":
            qs = urllib.parse.parse_qs(parsed.query)
            filename = qs.get("file", [""])[0]
            # Path traversal defense
            safe_name = os.path.basename(filename)
            file_path = os.path.join(_REPORTS_DIR, safe_name)
            self._serve_file(file_path, "text/markdown")
        elif clean_path == "/api/settings":
            brave_key = os.environ.get("BRAVE_SEARCH_API_KEY", "")
            openai_key = os.environ.get("OPENAI_API_KEY", "")
            searxng_url = os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080")
            local_llm_url = os.environ.get("LOCAL_LLM_URL", "http://127.0.0.1:11434/v1")
            default_model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
            searxng_active = False
            try:
                searxng_active = is_port_in_use(8080)
            except Exception:
                pass
            payload = json.dumps({
                "has_brave": bool(brave_key),
                "brave_preview": f"{brave_key[:4]}...{brave_key[-3:]}" if len(brave_key) > 7 else ("***" if brave_key else ""),
                "has_openai": bool(openai_key),
                "openai_preview": f"{openai_key[:3]}...{openai_key[-4:]}" if len(openai_key) > 7 else ("***" if openai_key else ""),
                "searxng_url": searxng_url,
                "searxng_active": searxng_active,
                "local_llm_url": local_llm_url,
                "default_model": default_model,
                "models": list(MODEL_PRICING.keys()),
            })
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/api/estimate":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
            try:
                data = json.loads(body) if body else {}
                mode = data.get("mode", "deterministic")
                model = data.get("model", "gpt-4o-mini")
                reasoning_effort = data.get("reasoning_effort", "medium")
                max_docs = int(data.get("max_documents", 25))
                concurrency = int(data.get("concurrency", 4))
                topic = data.get("topic", "")

                estimate = estimate_research_workload(
                    mode=mode,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    max_documents=max_docs,
                    concurrency=concurrency,
                    topic_length_chars=len(topic)
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(estimate).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        elif self.path == "/api/cancel":
            cancellation_manager.cancel_run("default")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "cancelled", "message": "Cancellation signal sent."}).encode("utf-8"))
        elif self.path == "/api/settings":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                data = json.loads(body)
                updates = {}
                if "brave_key" in data and not data["brave_key"].startswith("***"):
                    updates["BRAVE_SEARCH_API_KEY"] = data["brave_key"].strip()
                if "openai_key" in data and not data["openai_key"].startswith("***"):
                    updates["OPENAI_API_KEY"] = data["openai_key"].strip()
                if "searxng_url" in data:
                    updates["SEARXNG_URL"] = data["searxng_url"].strip()
                if "local_llm_url" in data:
                    updates["LOCAL_LLM_URL"] = data["local_llm_url"].strip()
                if "openai_model" in data:
                    updates["OPENAI_MODEL"] = data["openai_model"].strip()

                if updates:
                    save_env_file(updates)

                # Reset collector client so subsequent tasks spawn with updated environment
                reset_collector()

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok"}).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        elif self.path == "/api/research":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                data = json.loads(body)
                topic = data.get("topic", "").strip()
                watchlist_raw = data.get("watchlist", "")
                if "mode" in data:
                    err_bytes = json.dumps({"error": "mode is not supported; send SearchOptions fields"}).encode("utf-8")
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(err_bytes)
                    return

                watchlist = [line.strip() for line in watchlist_raw.splitlines() if line.strip()]

                if data.get("openai_key") and not str(data["openai_key"]).startswith("***"):
                    key_val = str(data["openai_key"]).strip()
                    if key_val:
                        os.environ["OPENAI_API_KEY"] = key_val
                        save_env_file({"OPENAI_API_KEY": key_val})
                if data.get("brave_key") and not str(data["brave_key"]).startswith("***"):
                    b_val = str(data["brave_key"]).strip()
                    if b_val:
                        os.environ["BRAVE_SEARCH_API_KEY"] = b_val
                        save_env_file({"BRAVE_SEARCH_API_KEY": b_val})

                options = SearchOptions(
                    max_depth=int(data.get("max_depth", 2)),
                    max_documents=int(data.get("max_documents", 15)),
                    max_duration_sec=float(data.get("max_duration_sec", 180.0)),
                    concurrency=int(data.get("concurrency", 4)),
                    max_per_domain=int(data.get("max_per_domain", 4)),
                    blind_watchlist=bool(data.get("blind_watchlist", False)),
                    decoy_queries=int(data.get("decoy_queries", 0)),
                    ai_planning=bool(data.get("ai_planning", False)),
                    ai_summary=bool(data.get("ai_summary", False)),
                    model=str(data.get("openai_model", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))),
                    reasoning_effort=data.get("reasoning_effort"),
                    max_spend_usd=float(data.get("max_spend_usd", 2.00)),
                )
                result = run_to_dict(run_search(
                    topic=topic,
                    watchlist=watchlist,
                    options=options,
                    run_id="default",
                ))
                response_bytes = json.dumps(result).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(response_bytes)
            except SafetyError:
                err_bytes = json.dumps({"error": "Blocked by local safety guard"}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(err_bytes)
            except Exception as e:
                err_bytes = json.dumps({"error": f"An error occurred during research: {str(e)}"}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(err_bytes)
        else:
            self.send_response(404)
            self.end_headers()


def start_ui_server(port: int = 8765) -> None:
    """Launch the local browser UI server and ensure SearXNG service is active."""
    try:
        start_searxng_service("127.0.0.1", 8080)
    except Exception:
        pass

    with socketserver.TCPServer(("127.0.0.1", port), SafeResearchRequestHandler) as httpd:
        url = f"http://127.0.0.1:{port}"
        print(f"Deep Search UI active at: {url}")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down UI server.")
