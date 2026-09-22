"""Retrieval Task Schema Validator.

Ensures incoming tasks strictly match expected schemas and contain no unexpected
or unauthorized fields.
"""


def validate_task_schema(task: dict) -> tuple[bool, str]:
    """Strictly validate schema of inbound RetrievalTask from Secret Core."""
    if not isinstance(task, dict):
        return False, "Task must be a JSON object"

    allowed_keys = {"task_id", "action", "connector", "query", "url", "doi", "timeout_sec"}
    if not set(task.keys()).issubset(allowed_keys):
        return False, "Task contains forbidden keys"

    action = task.get("action")
    if action not in ("search", "fetch", "ping"):
        return False, f"Unsupported action: {action}"

    if action == "search":
        query = task.get("query")
        if not query or not isinstance(query, str) or len(query.strip()) == 0:
            return False, "Search action requires non-empty query string"

    if action == "fetch":
        url = task.get("url")
        if not url or not isinstance(url, str) or len(url.strip()) == 0:
            return False, "Fetch action requires non-empty url string"

    return True, ""
