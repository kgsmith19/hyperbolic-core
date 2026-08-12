"""Integration: every scheduled run leaves an execution receipt (ADR 014).

The point of this module is the failure path: a job that raises must still be
recorded and must still exit non-zero, or the scheduler cannot tell a crash
from a quiet day.
"""

from uuid import UUID, uuid4

import pytest

from domains.ops.receipts import (
    STATUS_FAILED,
    STATUS_OK,
    STATUS_SKIPPED,
    JobResult,
    run_job,
)
from domains.ops.types import define_ops_types
from kernel.access import AccessContext, ScopeError
from kernel.services import find

SECRET = "attendee-only-text-dana@receipts.test"


@pytest.fixture(scope="module")
def ops_ctx(clean_database: None) -> AccessContext:
    ctx = AccessContext.of("ops:read", "ops:write")
    define_ops_types(ctx)
    return ctx


def receipts_for(ctx: AccessContext, job: str) -> list[dict[str, object]]:
    return [
        dict(r.attributes) for r in find(ctx, type_name="execution_receipt", filters={"job": job})
    ]


def test_successful_run_is_receipted_and_exits_zero(ops_ctx: AccessContext) -> None:
    produced = uuid4()
    exit_code = run_job(
        ops_ctx, "test.ok", lambda _: JobResult(summary="did=1", produced=[produced])
    )

    assert exit_code == 0
    (receipt,) = receipts_for(ops_ctx, "test.ok")
    assert receipt["status"] == STATUS_OK
    assert receipt["summary"] == "did=1"
    assert receipt["produced_entity_ids"] == [str(produced)]
    assert str(receipt["started_at"]) <= str(receipt["finished_at"])


def test_failed_run_still_emits_a_receipt_and_exits_non_zero(ops_ctx: AccessContext) -> None:
    def explode(_: AccessContext) -> JobResult:
        raise RuntimeError(f"parse failed near {SECRET}")

    exit_code = run_job(ops_ctx, "test.boom", explode)

    assert exit_code == 1
    (receipt,) = receipts_for(ops_ctx, "test.boom")
    assert receipt["status"] == STATUS_FAILED
    # the class name is evidence; the message may quote untrusted text, so it
    # goes to the scheduler log and never into an entity (ADR 012/014)
    assert receipt["summary"] == "unhandled RuntimeError"
    assert SECRET not in str(receipt)
    assert find(ops_ctx, text=SECRET) == []


def test_skipped_run_is_receipted_and_exits_non_zero(ops_ctx: AccessContext) -> None:
    exit_code = run_job(
        ops_ctx, "test.skip", lambda _: JobResult(status=STATUS_SKIPPED, summary="no config")
    )

    assert exit_code == 1  # a misconfigured job is never a quiet "nothing to do"
    (receipt,) = receipts_for(ops_ctx, "test.skip")
    assert receipt["status"] == STATUS_SKIPPED


def test_every_run_is_its_own_receipt(ops_ctx: AccessContext) -> None:
    for _ in range(2):
        run_job(ops_ctx, "test.twice", lambda _: JobResult(summary="again"))
    assert len(receipts_for(ops_ctx, "test.twice")) == 2  # runs never resolve onto each other


def test_receipt_without_ops_write_fails_closed(ops_ctx: AccessContext) -> None:
    with pytest.raises(ScopeError):
        run_job(AccessContext.of("ops:read"), "test.scope", lambda _: JobResult())


def test_produced_ids_are_recorded_for_the_scheduler(ops_ctx: AccessContext) -> None:
    ids: list[UUID] = [uuid4(), uuid4()]
    run_job(ops_ctx, "test.produced", lambda _: JobResult(produced=ids))
    (receipt,) = receipts_for(ops_ctx, "test.produced")
    assert receipt["produced_entity_ids"] == [str(i) for i in ids]
