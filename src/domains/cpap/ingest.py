"""CPAP session ingestion from SleepHQ (roadmap H2, ADR 010/012/014
precedents from domains.calendar.ingest).

Two-layer idempotency: a `cpap_source_receipt` short-circuits an unchanged
pull (same normalized response, same window), and inside a changed pull each
night is compared against its stored `cpap_session` (by `session_date`)
before writing, so an unchanged night emits nothing. Every session a pull
writes or updates links to its receipt via a `derived_from` edge (ADR 010).

Missing credentials are `STATUS_SKIPPED`, never a crash and never a silent
no-op (the calendar `LIFEOS_ICS_URLS`-unset precedent): the receipt records
that this run intentionally did not attempt a fetch. A configured-but-failing
SleepHQ call is `STATUS_FAILED` -- an honest distinction between "we didn't
try" and "we tried and it broke."

Runs as ``python -m domains.cpap.ingest`` (deploy-box scheduler) under a
code-built AccessContext of exactly ``cpap:read``/``write`` + ``ops:read``/
``write`` for its own execution receipt -- narrow by construction.

No EDF parsing, no myAir, no pressure suggestions, no prediction, no
interpretation copy anywhere (roadmap H2 pre-made decisions, verbatim). The
ez Share SD card is the roadmap's documented fallback source and is not
implemented here.
"""

import json
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import UUID

from domains.cpap.sleephq_client import (
    DEFAULT_BASE_URL,
    SleepHQError,
    fetch_access_token,
    fetch_nights,
    fetch_team_id,
)
from domains.cpap.types import define_cpap_types
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, STATUS_SKIPPED, JobResult, run_job
from kernel import services
from kernel.access import AccessContext
from kernel.env import read_env

SOURCE = "sleephq"
METHOD = "domains.cpap.ingest"
DERIVED_FROM = "derived_from"

# Pulled window is wider than the 30-night compliance window so a late
# correction to an older night (SleepHQ revises a night after the fact) is
# still picked up on the next run; the compliance service applies its own
# 30-day window on top of whatever is stored.
PULL_WINDOW_DAYS = 35


@dataclass(frozen=True)
class ParsedNight:
    session_date: date
    usage_min: int
    ahi: float | None
    leak_95p: float | None
    pressure_95p: float | None
    central_ahi: float | None


def _num(attributes: dict[str, Any], key: str) -> float | None:
    value = attributes.get(key)
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def parse_night(raw: Any) -> ParsedNight | None:
    """One SleepHQ `nights` list item -> a night, or None when the item is
    malformed. Dropped, never guessed at: a response we cannot parse must
    never become a fabricated night."""
    if not isinstance(raw, dict):
        return None
    attributes = raw.get("attributes")
    if not isinstance(attributes, dict):
        return None
    raw_date = attributes.get("date")
    if not isinstance(raw_date, str):
        return None
    try:
        session_date = date.fromisoformat(raw_date)
    except ValueError:
        return None
    total_time = attributes.get("total_time")  # seconds of usage
    if not isinstance(total_time, int | float) or isinstance(total_time, bool) or total_time < 0:
        return None
    usage_min = round(total_time / 60)
    if usage_min > 24 * 60:
        return None
    return ParsedNight(
        session_date=session_date,
        usage_min=usage_min,
        ahi=_num(attributes, "ahi"),
        leak_95p=_num(attributes, "leak_95"),
        pressure_95p=_num(attributes, "pressure_95"),
        central_ahi=_num(attributes, "central_ahi"),
    )


def _session_attributes(night: ParsedNight) -> dict[str, Any]:
    attrs: dict[str, Any] = {
        "session_date": night.session_date.isoformat(),
        "usage_min": night.usage_min,
        "source": SOURCE,
    }
    for key, value in (
        ("ahi", night.ahi),
        ("leak_95p", night.leak_95p),
        ("pressure_95p", night.pressure_95p),
        ("central_ahi", night.central_ahi),
    ):
        if value is not None:
            attrs[key] = round(value, 3)
    return attrs


def _provenance(response_sha: str) -> dict[str, Any]:
    return {"method": METHOD, "confidence": 1.0, "source_sha256": response_sha}


def _writable(ctx: AccessContext, entity_id: UUID, attributes: dict[str, Any]) -> dict[str, Any]:
    """`attributes` minus everything this entity has had erased -- ingestion
    must never write a redacted field back (invariant 9, ADR 012)."""
    redacted = services.redacted_fields(ctx, entity_id)
    return {k: v for k, v in attributes.items() if k not in redacted}


@dataclass
class IngestReport:
    sha256: str
    window_start: date
    window_end: date
    receipt_id: UUID | None = None
    unchanged: bool = False
    created: int = 0
    updated: int = 0
    skipped: int = 0

    def line(self) -> str:
        if self.unchanged:
            return f"sleephq [{self.sha256[:12]}]: unchanged, nothing emitted"
        return (
            f"sleephq [{self.sha256[:12]}]: created={self.created} updated={self.updated} "
            f"skipped={self.skipped} receipt={self.receipt_id}"
        )


def ingest_nights(
    ctx: AccessContext,
    raw_nights: list[dict[str, Any]],
    window_start: date,
    window_end: date,
    fetched_at: datetime | None = None,
) -> IngestReport:
    """Ingest one SleepHQ pull's raw `nights` list. Pure kernel-service
    calls; no raw SQL. Idempotent by construction (see module docstring)."""
    define_cpap_types(ctx)
    fetched_at = fetched_at or datetime.now(UTC)
    # sort_keys makes the hash independent of key ordering the provider is
    # free to change between calls; list (night) order is not resorted, so a
    # reordered-but-identical response can occasionally miss the short
    # circuit -- harmless, since the per-night comparison below still emits
    # nothing for an unchanged night.
    body = json.dumps(raw_nights, sort_keys=True, default=str)
    response_sha = sha256(body.encode()).hexdigest()
    receipt_key = f"{response_sha}:{window_start.isoformat()}:{window_end.isoformat()}"
    report = IngestReport(sha256=response_sha, window_start=window_start, window_end=window_end)

    existing = services.find(
        ctx, type_name="cpap_source_receipt", filters={"cpap_receipt_key": receipt_key}
    )
    if existing:  # identical response for this window already receipted
        report.receipt_id = existing[0].id
        report.unchanged = True
        return report

    parsed: list[ParsedNight] = []
    for raw in raw_nights:
        night = parse_night(raw)
        if night is None or not (window_start <= night.session_date <= window_end):
            report.skipped += 1
            continue
        parsed.append(night)

    receipt = services.capture(
        ctx,
        "cpap_source_receipt",
        {
            "cpap_receipt_key": receipt_key,
            "sha256": response_sha,
            "fetched_at": fetched_at.isoformat(),
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "session_count": len(parsed),
            "source": SOURCE,
        },
        actor=METHOD,
    )
    report.receipt_id = receipt.entity_id

    seen: set[date] = set()
    for night in parsed:
        if night.session_date in seen:
            report.skipped += 1
            continue
        seen.add(night.session_date)
        attributes = _session_attributes(night)
        matches = services.find(
            ctx, type_name="cpap_session", filters={"session_date": night.session_date.isoformat()}
        )
        if matches and all(matches[0].attributes.get(k) == v for k, v in attributes.items()):
            continue  # unchanged night: emit nothing
        if matches:
            attributes = _writable(ctx, matches[0].id, attributes)
        result = services.capture(ctx, "cpap_session", attributes, actor=METHOD)
        if matches:
            report.updated += 1
        else:
            report.created += 1
        services.relate(
            ctx,
            result.entity_id,
            DERIVED_FROM,
            receipt.entity_id,
            valid_from=fetched_at,
            attributes=_provenance(response_sha),
            actor=METHOD,
        )
    return report


def sleephq_credentials() -> tuple[str, str] | None:
    client_id = read_env("LIFEOS_SLEEPHQ_CLIENT_ID")
    client_secret = read_env("LIFEOS_SLEEPHQ_CLIENT_SECRET")
    if not client_id or not client_secret:
        return None
    return client_id, client_secret


def sleephq_base_url() -> str:
    return (read_env("LIFEOS_SLEEPHQ_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def cpap_context() -> AccessContext:
    """Exactly the scopes ingestion needs -- narrow by construction; ``ops``
    is its execution receipt and nothing else (ADR 014)."""
    return AccessContext.of("cpap:read", "cpap:write", "ops:read", "ops:write")


def _job(ctx: AccessContext) -> JobResult:
    creds = sleephq_credentials()
    if creds is None:
        # Skipped, and still a non-zero exit: missing credentials are a
        # misconfiguration, not a quiet "nothing to do" (ADR 014).
        print(
            "LIFEOS_SLEEPHQ_CLIENT_ID/LIFEOS_SLEEPHQ_CLIENT_SECRET are not set; "
            "nothing to ingest (fail-closed)"
        )
        return JobResult(status=STATUS_SKIPPED, summary="SleepHQ credentials are not configured")

    for name in define_cpap_types(ctx):
        print(f"defined type {name} (domain: cpap)")

    client_id, client_secret = creds
    base_url = sleephq_base_url()
    fetched_at = datetime.now(UTC)
    window_end = fetched_at.date()
    window_start = window_end - timedelta(days=PULL_WINDOW_DAYS - 1)

    try:
        token = fetch_access_token(client_id, client_secret, base_url)
        team_id = fetch_team_id(token, base_url)
        raw_nights = fetch_nights(token, base_url, team_id, window_start, window_end)
    except SleepHQError as exc:
        # Class name only: a provider error can echo request contents, and
        # the request carries a bearer token derived from a client secret.
        print(f"sleephq: FAILED - {type(exc).__name__}", file=sys.stderr)
        return JobResult(
            status=STATUS_FAILED, summary=f"SleepHQ fetch failed: {type(exc).__name__}"
        )

    report = ingest_nights(ctx, raw_nights, window_start, window_end, fetched_at=fetched_at)
    print(report.line())
    produced = [] if report.unchanged or report.receipt_id is None else [report.receipt_id]
    return JobResult(status=STATUS_OK, summary=report.line(), produced=produced)


def main() -> int:
    return run_job(cpap_context(), METHOD, _job)


if __name__ == "__main__":
    raise SystemExit(main())
