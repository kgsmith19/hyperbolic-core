"""Collector Worker Process.

Isolated child worker communicating via stdin/stdout JSON-RPC.
Handles retrieval tasks and returns quarantined payloads.
"""

import argparse
import json
import sys
from backend.retrieval.retrieval_router import RetrievalRouter
from backend.retrieval.task_validator import validate_task_schema


def run_ipc_loop():
    """Run JSON IPC server on stdin/stdout."""
    router = RetrievalRouter()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            task = json.loads(line)
        except Exception:
            resp = {"status": "error", "error": "Malformed JSON task"}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue

        valid, err_msg = validate_task_schema(task)
        task_id = task.get("task_id", "")

        if not valid:
            resp = {"task_id": task_id, "status": "error", "error": err_msg}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue

        action = task["action"]

        if action == "ping":
            resp = {"task_id": task_id, "status": "ok", "message": "pong"}
        elif action == "search":
            query = task["query"]
            connector = task.get("connector", "all")
            lanes = task.get("lanes")
            if lanes:
                results = router.search_lanes(query, lanes)
            else:
                results = router.search(query, connector=connector)
            resp = {"task_id": task_id, "status": "ok", "results": results}
        elif action == "fetch":
            url = task["url"]
            fetch_result = router.fetch_url(url)
            resp = {"task_id": task_id, **fetch_result}
        else:
            resp = {"task_id": task_id, "status": "error", "error": "Unknown action"}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="Deep Search Collector Process")
    parser.add_argument("--ipc", action="store_true", help="Run IPC loop on stdin/stdout")
    args = parser.parse_args()

    if args.ipc:
        run_ipc_loop()
    else:
        print("Deep Search Collector. Run with --ipc to start JSON IPC server.")


if __name__ == "__main__":
    main()
