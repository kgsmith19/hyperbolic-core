"""Collector Process for Deep Search.

Isolated network-capable worker:
- Accepts only schema-validated RetrievalTask objects over stdin JSON-RPC.
- Never accesses or receives watchlist, reverse alias map, or secret filesystem.
- Enforces strict SSRF protection (rejects loopback, private IPs, metadata endpoints, and non-http schemes).
- Retrieves from SearXNG, OpenAlex, Crossref, arXiv, SEC EDGAR, and Brave Search.
- Extracts clean text and candidate links using trafilatura with fallbacks.

Delegates implementation to `backend.retrieval`.
"""

import argparse
from backend.retrieval import (
    is_safe_url,
    is_bot_or_js_barrier,
    extract_clean_content,
    validate_task_schema,
    RetrievalRouter,
    run_ipc_loop,
)
from backend.server import load_env_file

# Initialize environment
load_env_file()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deep Search Collector Process")
    parser.add_argument("--ipc", action="store_true", help="Run IPC loop on stdin/stdout")
    args = parser.parse_args()

    if args.ipc:
        run_ipc_loop()
    else:
        print("Deep Search Collector. Run with --ipc to start JSON IPC server.")
