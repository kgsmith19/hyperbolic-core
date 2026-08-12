"""Execution receipts: the audit trail every scheduled run leaves (ADR 014).

One helper, imported by every scheduled entry point — `domains.calendar.ingest`,
`domains.calendar.autolink` and `domains.ops.briefing` — so the scheduler's
record has one shape and one place to change.

A receipt is emitted on success, failure and skip alike, and only ``ok`` exits
0: a crashed or misconfigured job must never look to the scheduler like a quiet
"nothing to do". Receipts carry counts, statuses and IDs — never an exception
message and never feed text, because an entity outlives what it quotes and
``forget()`` is per-entity (invariant 9, ADR 012/014). Full error text goes to
stderr, which is the scheduler log, not a queryable store.
"""

import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

from domains.ops.types import (
    MAX_IDS,
    MAX_SUMMARY,
    STATUS_FAILED,
    STATUS_OK,
    STATUS_SKIPPED,
    define_ops_types,
)
from kernel import services
from kernel.access import AccessContext

__all__ = ["STATUS_FAILED", "STATUS_OK", "STATUS_SKIPPED", "JobResult", "emit_receipt", "run_job"]


@dataclass
class JobResult:
    """What a scheduled job reports back. ``produced`` is the ids of the
    entities the run created or updated."""

    status: str = STATUS_OK
    summary: str = ""
    produced: list[UUID] = field(default_factory=list)


def emit_receipt(
    ctx: AccessContext,
    job: str,
    started_at: datetime,
    finished_at: datetime,
    result: JobResult,
) -> UUID:
    """Record one run. Needs ``ops:write``; never resolves onto an earlier run."""
    return services.capture(
        ctx,
        "execution_receipt",
        {
            "job": job,
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "status": result.status,
            "summary": result.summary[:MAX_SUMMARY],
            "produced_entity_ids": [str(i) for i in result.produced[:MAX_IDS]],
        },
        actor=job,
    ).entity_id


def run_job(ctx: AccessContext, job: str, work: Callable[[AccessContext], JobResult]) -> int:
    """Run one scheduled job under a receipt; return the process exit code.

    The ops types are defined before the work starts, so a job that fails on its
    first line still has a type to be receipted against. If capturing the
    receipt itself fails the exception propagates and the process exits
    non-zero — a failure is never swallowed into a success.
    """
    for name in define_ops_types(ctx):
        print(f"defined type {name} (domain: ops)")
    started_at = datetime.now(UTC)
    try:
        result = work(ctx)
    except Exception as exc:
        # The class name is safe to store; the message may quote untrusted
        # third-party text, so it only ever reaches the scheduler log.
        result = JobResult(status=STATUS_FAILED, summary=f"unhandled {type(exc).__name__}")
        print(f"{job}: FAILED - {type(exc).__name__}: {exc}", file=sys.stderr)
    receipt_id = emit_receipt(ctx, job, started_at, datetime.now(UTC), result)
    print(f"{job}: {result.status} receipt={receipt_id} {result.summary}".rstrip())
    return 0 if result.status == STATUS_OK else 1
