"""Source-freshness ledger (Issue #90).

One derived, read-only freshness record per configured external source,
computed entirely from receipts and entities that already exist in the
kernel: `execution_receipt` for scheduled ingest jobs (ADR 014),
`source_receipt` for the calendar feed (ADR 012), and the records'
own data timestamps for a webhook-delivered source with no scheduled-job
receipt of its own (`health_connect`, H1). No kernel table, no new
persisted type, no second
telemetry store (invariant 1) -- this is a query, computed fresh on every
call, the same way `domains.ops.briefing` composes its digest from reads.
The briefing may consume this ledger later; nothing here writes anything.

No LLM ever determines freshness: every field below is read off an
existing timestamp or status string and compared with `classify`, a pure
function of those values and a fixed, code-defined threshold per source.
A source with no successful ingest on record reads `never_seen`, never a
fabricated `fresh` -- a missing or failed source must never look green.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from domains.calendar.ingest import METHOD as CALENDAR_INGEST_JOB
from domains.ops.receipts import STATUS_OK
from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity

STATE_FRESH = "fresh"
STATE_STALE = "stale"
STATE_UNAVAILABLE = "unavailable"
STATE_NEVER_SEEN = "never_seen"

SOURCE_CALENDAR = "calendar"
SOURCE_HEALTH_CONNECT = "health_connect"

# How stale a source's last successful ingest may be before it reads "stale"
# instead of "fresh". Calendar feeds are polled on a schedule several times a
# day (ADR 012); Health Connect is a phone/scale webhook that only fires when
# a measurement happens, so it can legitimately go quiet for longer between
# beats without anything being broken.
FRESHNESS_THRESHOLDS: dict[str, timedelta] = {
    SOURCE_CALENDAR: timedelta(hours=6),
    SOURCE_HEALTH_CONNECT: timedelta(days=2),
}


@dataclass(frozen=True)
class SourceFreshness:
    """One source's freshness record (the issue's minimum-fields list).
    `state` and `threshold` are always present; every timestamp/class field
    is `None` when the underlying receipt or entity does not exist, which is
    itself part of the answer (see `classify`)."""

    source_id: str
    state: str
    threshold: timedelta
    last_success_at: datetime | None
    newest_observed_at: datetime | None
    last_attempt_at: datetime | None
    last_failure_class: str | None


def classify(
    now: datetime,
    threshold: timedelta,
    last_success_at: datetime | None,
    last_attempt_at: datetime | None,
    last_failure_class: str | None,
) -> str:
    """The deterministic state a source reads. Pure function, no I/O.

    - `never_seen`: no successful ingest is on record at all -- a missing
      source must never fabricate `fresh`.
    - `unavailable`: the most recent attempt did not succeed
      (`last_failure_class` is set), even when an earlier ingest was fresh --
      the pipeline is telling us it is broken *right now*. A later
      successful attempt clears `last_failure_class` and the source recovers
      into `fresh`/`stale` on its own.
    - `fresh` / `stale`: age of the last success against the source's
      threshold. The boundary is inclusive -- age exactly equal to the
      threshold still reads `fresh`.
    """
    if last_success_at is None:
        return STATE_NEVER_SEEN
    if last_failure_class is not None:
        return STATE_UNAVAILABLE
    return STATE_FRESH if now - last_success_at <= threshold else STATE_STALE


def _record(
    source_id: str,
    now: datetime,
    last_success_at: datetime | None,
    newest_observed_at: datetime | None,
    last_attempt_at: datetime | None,
    last_failure_class: str | None,
) -> SourceFreshness:
    threshold = FRESHNESS_THRESHOLDS[source_id]
    state = classify(now, threshold, last_success_at, last_attempt_at, last_failure_class)
    return SourceFreshness(
        source_id=source_id,
        state=state,
        threshold=threshold,
        last_success_at=last_success_at,
        newest_observed_at=newest_observed_at,
        last_attempt_at=last_attempt_at,
        last_failure_class=last_failure_class,
    )


def _parse(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _optional_find(
    ctx: AccessContext, type_name: str, filters: dict[str, object] | None = None
) -> list[Entity]:
    """Entities of a type that may not be defined yet -- a source with no
    ingest job run yet, or no captured data yet, is `never_seen`, not a
    crash (mirrors `domains.ops.briefing._optional_find`)."""
    try:
        return services.find(ctx, type_name=type_name, filters=filters)
    except LookupError:
        return []


def _latest_at(
    entities: list[Entity], extractor: Callable[[Entity], datetime | None]
) -> datetime | None:
    values = [at for e in entities if (at := extractor(e)) is not None]
    return max(values) if values else None


def _calendar_freshness(ctx: AccessContext, now: datetime) -> SourceFreshness:
    # execution_receipt carries no identity field (ADR 014): every run is a
    # distinct fact, so the one with the latest started_at is the latest run.
    receipts = _optional_find(ctx, "execution_receipt", {"job": CALENDAR_INGEST_JOB})
    epoch = datetime.min.replace(tzinfo=UTC)
    receipts.sort(key=lambda r: _parse(r.attributes.get("started_at")) or epoch)
    latest_attempt = receipts[-1] if receipts else None
    successes = [r for r in receipts if r.attributes.get("status") == STATUS_OK]
    last_success = successes[-1] if successes else None

    # A new source_receipt is captured only when the feed's bytes actually
    # changed (ADR 012 idempotency) -- its fetched_at is the last time the
    # source's own data moved, distinct from "we polled it and nothing new
    # was there".
    newest_observed_at = _latest_at(
        _optional_find(ctx, "source_receipt"), lambda e: _parse(e.attributes.get("fetched_at"))
    )

    last_attempt_at = (
        _parse(latest_attempt.attributes.get("started_at")) if latest_attempt else None
    )
    last_success_at = (
        _parse(last_success.attributes.get("finished_at")) if last_success else None
    )
    failed = latest_attempt is not None and latest_attempt.attributes.get("status") != STATUS_OK
    last_failure_class = (
        str(latest_attempt.attributes.get("status")) if failed and latest_attempt else None
    )

    return _record(
        SOURCE_CALENDAR,
        now,
        last_success_at,
        newest_observed_at,
        last_attempt_at,
        last_failure_class,
    )


def _health_connect_freshness(ctx: AccessContext, now: datetime) -> SourceFreshness:
    # The webhook has no scheduled-job receipt (ADR 014 covers scheduled
    # entry points only): the newest reading's OWN timestamp is the success
    # signal, and there is no separate attempt/failure record to read for
    # this source. Deliberately not entity.updated_at: that is when the
    # kernel row was last written, which (a) does not move on an idempotent
    # replay of unchanged content (H1 -- capture() merges silently) and
    # (b) would tie freshness to ingest wall-clock time rather than the
    # data the source itself reports, the exact distinction this ledger
    # exists to preserve (issue #90's "newest source-data timestamp" field).
    weights = _optional_find(ctx, "weight_measurement")
    activity = _optional_find(ctx, "activity_summary")
    newest_observed_at = max(
        (
            at
            for at in (
                _latest_at(weights, lambda e: _parse(e.attributes.get("time"))),
                _latest_at(activity, lambda e: _parse(e.attributes.get("start_time"))),
            )
            if at is not None
        ),
        default=None,
    )
    return _record(SOURCE_HEALTH_CONNECT, now, newest_observed_at, newest_observed_at, None, None)


def compute_ledger(ctx: AccessContext, now: datetime | None = None) -> list[SourceFreshness]:
    """One freshness record per configured external source, calendar then
    health_connect. `now` defaults to the real clock; tests pin it
    explicitly."""
    moment = now or datetime.now(UTC)
    return [_calendar_freshness(ctx, moment), _health_connect_freshness(ctx, moment)]


def ledger_context() -> AccessContext:
    """Exactly the read scopes the ledger needs -- no write scope on
    anything it reads, and it emits no receipt of its own (it writes
    nothing at all)."""
    return AccessContext.of("ops:read", "calendar:read", "health_connect:read")
