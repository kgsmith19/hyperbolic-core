"""Retrieval Engine Bounded Context.

Isolated network retrieval worker, multi-connector routing,
SSRF validation, anti-bot challenge detection, and process-isolated IPC.
"""

from backend.retrieval.ssrf_validator import (
    is_safe_url,
)
from backend.retrieval.bot_barrier_detector import (
    is_bot_or_js_barrier,
    BOT_OR_JS_BARRIER_PATTERNS,
)
from backend.retrieval.content_cleaner import (
    extract_clean_content,
)
from backend.retrieval.task_validator import (
    validate_task_schema,
)
from backend.retrieval.retrieval_router import (
    RetrievalRouter,
)
from backend.retrieval.collector_client import (
    CollectorClient,
    get_collector,
    reset_collector,
    search_brave,
    fetch_html_text,
    build_sanitized_evidence,
)
from backend.retrieval.collector_worker import (
    run_ipc_loop,
)

__all__ = [
    "is_safe_url",
    "is_bot_or_js_barrier",
    "BOT_OR_JS_BARRIER_PATTERNS",
    "extract_clean_content",
    "validate_task_schema",
    "RetrievalRouter",
    "CollectorClient",
    "get_collector",
    "reset_collector",
    "search_brave",
    "fetch_html_text",
    "build_sanitized_evidence",
    "run_ipc_loop",
]
