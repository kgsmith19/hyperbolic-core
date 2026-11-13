"""Dry-run sync planning never duplicates or merges entities (#572)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from kernel.external_identity import ExternalIdentity, IdentityCrosswalk
from kernel.sync_plan import PlanAction, SourceRecord, plan_sync

T0 = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
T1 = T0 + timedelta(hours=1)
CANONICAL = UUID("00000000-0000-4000-8000-000000000042")


def _record(
    external_id: str, updated_at: datetime = T0, source: str = "google-tasks"
) -> SourceRecord:
    return SourceRecord(source=source, external_id=external_id, title="t", updated_at=updated_at)


def _crosswalk(*known: str) -> IdentityCrosswalk:
    crosswalk = IdentityCrosswalk()
    for external_id in known:
        crosswalk.register(ExternalIdentity("google-tasks", external_id, CANONICAL))
    return crosswalk


def test_unknown_identifier_is_created_without_inventing_a_canonical_id() -> None:
    [change] = plan_sync([_record("new")], _crosswalk(), {})
    assert change.action is PlanAction.CREATE
    assert change.canonical_id is None


def test_known_identifier_applied_at_same_timestamp_is_skipped() -> None:
    [change] = plan_sync([_record("a", T0)], _crosswalk("a"), {("google-tasks", "a"): T0})
    assert change.action is PlanAction.SKIP
    assert change.canonical_id == CANONICAL


def test_newer_source_timestamp_updates_the_existing_entity() -> None:
    [change] = plan_sync([_record("a", T1)], _crosswalk("a"), {("google-tasks", "a"): T0})
    assert change.action is PlanAction.UPDATE
    assert change.canonical_id == CANONICAL


def test_older_source_timestamp_is_stale_and_never_overwrites() -> None:
    [change] = plan_sync([_record("a", T0)], _crosswalk("a"), {("google-tasks", "a"): T1})
    assert change.action is PlanAction.STALE


def test_known_identity_without_prior_apply_updates_not_duplicates() -> None:
    [change] = plan_sync([_record("a")], _crosswalk("a"), {})
    assert change.action is PlanAction.UPDATE
    assert change.canonical_id == CANONICAL


def test_duplicate_identifier_in_one_batch_is_a_conflict_for_every_copy() -> None:
    plan = plan_sync([_record("dup"), _record("dup", T1)], _crosswalk(), {})
    assert [change.action for change in plan] == [PlanAction.CONFLICT, PlanAction.CONFLICT]


def test_same_external_id_in_different_sources_is_not_a_duplicate() -> None:
    plan = plan_sync(
        [
            _record("P-02", source="operations-registry"),
            _record("P-02", source="execution-registry"),
        ],
        IdentityCrosswalk(),
        {},
    )
    assert [change.action for change in plan] == [PlanAction.CREATE, PlanAction.CREATE]


def test_unnormalized_identifier_fails_closed() -> None:
    with pytest.raises(ValueError):
        plan_sync([_record(" a ")], _crosswalk(), {})


def test_plan_preserves_input_order() -> None:
    plan = plan_sync([_record("b"), _record("a")], _crosswalk("a"), {("google-tasks", "a"): T0})
    assert [change.external_id for change in plan] == ["b", "a"]


def test_an_applied_record_not_yet_in_the_crosswalk_is_never_created_twice() -> None:
    record = SourceRecord(source="tasks", external_id="t-9", title="x", updated_at=T0)
    applied = {("tasks", "t-9"): T0}
    assert plan_sync([record], IdentityCrosswalk(), applied)[0].action == PlanAction.SKIP
    older = SourceRecord(
        source="tasks", external_id="t-9", title="x", updated_at=T0 - timedelta(hours=1)
    )
    assert plan_sync([older], IdentityCrosswalk(), applied)[0].action == PlanAction.STALE
