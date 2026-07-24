"""Acceptance 6 + unit: scope-shaped access control (invariant 5)."""

import pytest

from kernel.access import AccessContext, ScopeError, require
from kernel.services import capture, find


def test_missing_health_read_cannot_find_workouts(seeded: object) -> None:
    partial = AccessContext.of("relationships:read", "relationships:write")
    with pytest.raises(ScopeError, match="health:read"):
        find(partial, type_name="workout")


def test_missing_write_cannot_capture(seeded: object) -> None:
    read_only = AccessContext.of("health:read")
    with pytest.raises(ScopeError, match="health:write"):
        capture(read_only, "workout", {"kind": "walk", "started_at": "2026-07-23T09:00:00+00:00"})


def test_require_unit() -> None:
    require(AccessContext.all(), "anything:read")
    require(AccessContext.of("health:read"), "health:read")
    with pytest.raises(ScopeError):
        require(AccessContext.of("health:read"), "health:write")
