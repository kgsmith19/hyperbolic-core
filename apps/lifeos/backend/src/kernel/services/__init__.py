"""Public kernel surface. Everything outside the kernel — the API and the MCP
server — goes through these services and nothing else (invariant 7)."""

from kernel.services.capture import CaptureResult, capture
from kernel.services.edges import provenance, relate, supersede_edge
from kernel.services.privacy import ForgetResult, forget, redacted_fields, writable_attributes
from kernel.services.queries import find, get_entity, history, latest_event_ids, ping
from kernel.services.registry import active_domains, define_missing, define_type, list_types

__all__ = [
    "CaptureResult",
    "ForgetResult",
    "active_domains",
    "capture",
    "define_missing",
    "define_type",
    "find",
    "forget",
    "get_entity",
    "history",
    "latest_event_ids",
    "list_types",
    "ping",
    "provenance",
    "redacted_fields",
    "relate",
    "supersede_edge",
    "writable_attributes",
]
