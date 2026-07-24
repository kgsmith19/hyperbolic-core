"""Unit: define_type validates the schema itself and the x-* extensions."""

import jsonschema
import pytest

from kernel.access import AccessContext
from kernel.services import capture, define_type


def test_invalid_json_schema_rejected(seeded: object, ctx: AccessContext) -> None:
    with pytest.raises(jsonschema.SchemaError):
        define_type(ctx, "broken", "journal", {"type": "not-a-real-type"})


def test_bad_identity_extension_rejected(seeded: object, ctx: AccessContext) -> None:
    with pytest.raises(ValueError, match="x-identity"):
        define_type(ctx, "broken2", "journal", {"type": "object", "x-identity": "emails"})


def test_unknown_type_rejected(seeded: object, ctx: AccessContext) -> None:
    with pytest.raises(LookupError, match="unknown type"):
        capture(ctx, "no_such_type", {})


def test_capture_validates_attributes(seeded: object, ctx: AccessContext) -> None:
    with pytest.raises(jsonschema.ValidationError):
        capture(ctx, "workout", {"kind": 5, "started_at": "2026-07-23T09:00:00+00:00"})
    with pytest.raises(jsonschema.ValidationError):
        capture(ctx, "workout", {"kind": "run"})  # missing required started_at
