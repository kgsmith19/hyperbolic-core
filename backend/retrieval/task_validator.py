"""Retrieval Task Schema Validator.

Ensures incoming tasks strictly match expected schemas and contain no unexpected
or unauthorized fields.
"""


def validate_task_schema(task: dict) -> tuple[bool, str]:
    """Strictly validate schema of inbound RetrievalTask from Secret Core."""
    if not isinstance(task, dict):
        return False, "Task must be a JSON object"

    allowed_keys = {"task_id", "action", "connector", "query", "url", "doi", "timeout_sec", "lanes"}
    if not set(task.keys()).issubset(allowed_keys):
        return False, "Task contains forbidden keys"

    action = task.get("action")
    if action not in ("search", "fetch", "ping"):
        return False, f"Unsupported action: {action}"

    if action == "search":
        query = task.get("query")
        if not query or not isinstance(query, str) or len(query.strip()) == 0:
            return False, "Search action requires non-empty query string"

    lanes = task.get("lanes")
    if lanes is not None:
        if not isinstance(lanes, dict) or len(lanes) > 16:
            return False, "lanes must be a small object of lane -> result count"
        for key, value in lanes.items():
            if not isinstance(key, str) or len(key) > 24 or not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 200:
                return False, "lanes values must be integers between 0 and 200"

    if action == "fetch":
        url = task.get("url")
        if not url or not isinstance(url, str) or len(url.strip()) == 0:
            return False, "Fetch action requires non-empty url string"

    return True, ""
