"""Public kernel surface. Everything outside the kernel — API now, MCP later —
goes through these services and nothing else (invariant 7)."""

from kernel.services.capture import CaptureResult, capture
from kernel.services.edges import relate, supersede_edge
from kernel.services.privacy import ForgetResult, forget
from kernel.services.queries import find, get_entity, history, ping
from kernel.services.registry import define_type

__all__ = [
    "CaptureResult",
    "ForgetResult",
    "capture",
    "define_type",
    "find",
    "forget",
    "get_entity",
    "history",
    "ping",
    "relate",
    "supersede_edge",
]
