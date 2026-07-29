"""ICS ingestion with source receipts (ADR 012, roadmap B1).

Idempotent by construction: an unchanged feed short-circuits on the receipt
sha256; a changed feed re-captures only the VEVENTs whose hash moved, so
re-runs emit zero new events. Every derived entity links to its receipt via
a ``derived_from`` edge carrying ``{method, confidence}`` (ADR 010). The
receipt is hash-plus-metadata only — verbatim feed text is never retained,
because it cannot be erased per-subject (invariant 9, ADR 012).

Erasure is durable: the source feed still carries every title, location and
address a subject asked us to erase, so ingestion re-reads them on every run.
It resolves attendees by a non-PII key (``email_hash``) and refuses to write
back any field an entity's history records as redacted (ADR 012 "Durable
erasure"). Without both, a later VEVENT edit silently undid forget().

Runs as ``python -m domains.calendar.ingest`` (deploy-box scheduler) under a
code-built AccessContext of exactly ``calendar:read`` + ``calendar:write`` plus
``ops:read``/``ops:write`` for its own execution receipt — narrow by
construction; agent tokens stay read-only (ADR 010/012/014). Every run leaves an
``execution_receipt`` (ok, failed or skipped) and only ``ok`` exits 0. Feed URLs
come from ``LIFEOS_ICS_URLS`` (comma-separated) and are never stored or
logged — they can embed private tokens — only a redacted host + url hash.
"""

import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from domains.calendar.parse import Occurrence, parse_ics
from domains.calendar.types import define_calendar_types, email_hash
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, STATUS_SKIPPED, JobResult, run_job
from kernel import services
from kernel.access import AccessContext
from kernel.env import read_env

MAX_FEED_BYTES = 512 * 1024  # untrusted input bound
FETCH_TIMEOUT_S = 30
WINDOW_PAST_DAYS = 30
WINDOW_FUTURE_DAYS = 180

METHOD = "domains.calendar.ingest"
DERIVED_FROM = "derived_from"
HAS_ATTENDEE = "has_attendee"


@dataclass
class FeedReport:
    source_host: str
    url_hash: str
    sha256: str
    receipt_id: UUID | None = None
    unchanged: bool = False
    created: int = 0
    updated: int = 0
    skipped: int = 0  # malformed components + duplicate keys
    attendees_created: int = 0
    truncated: bool = False

    def line(self) -> str:
        if self.unchanged:
            return f"{self.source_host} [{self.url_hash[:12]}]: unchanged, nothing emitted"
        return (
            f"{self.source_host} [{self.url_hash[:12]}]: "
            f"created={self.created} updated={self.updated} skipped={self.skipped} "
            f"attendees_created={self.attendees_created} receipt={self.receipt_id}"
            + (" (truncated)" if self.truncated else "")
        )


def _source_ref(url: str) -> tuple[str, str]:
    """Redacted (host, url_hash) — the full URL may embed a secret token."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("ICS source must be an http(s) URL")
    return parts.hostname, sha256(url.encode()).hexdigest()


class SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """SSRF guard: the scheme/host check covers only the first hop, because
    urllib follows redirects to anywhere. Refuse any redirect that changes
    scheme family or leaves the configured feed host, and cap the hops — a
    hostile feed provider must not be able to point the scheduled fetch at
    internal addresses (e.g. a cloud metadata endpoint)."""

    max_redirections = 3

    def __init__(self, host: str) -> None:
        self._host = host

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        parts = urlsplit(newurl)
        if parts.scheme not in ("http", "https") or parts.hostname != self._host:
            raise ValueError(
                f"refusing redirect off the configured feed host (to {parts.hostname!r})"
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_feed(url: str) -> bytes:
    host, _ = _source_ref(url)  # scheme + host check before any request
    opener = urllib.request.build_opener(SameHostRedirects(host))
    with opener.open(url, timeout=FETCH_TIMEOUT_S) as response:  # noqa: S310
        content: bytes = response.read(MAX_FEED_BYTES + 1)
    if len(content) > MAX_FEED_BYTES:
        raise ValueError(f"feed exceeds {MAX_FEED_BYTES} byte bound")
    return content


def _provenance(feed_sha: str) -> dict[str, Any]:
    return {"method": METHOD, "confidence": 1.0, "source_sha256": feed_sha}


def _writable(ctx: AccessContext, entity_id: UUID, attributes: dict[str, Any]) -> dict[str, Any]:
    """`attributes` minus everything this entity has had erased.

    Ingestion must never write erased fields back: the feed is unchanged by
    erasure — it still names the title, location and address that were erased —
    so one later VEVENT edit would re-materialize them on the very same entity
    (invariant 9, ADR 012).
    """
    redacted = services.redacted_fields(ctx, entity_id)
    return {k: v for k, v in attributes.items() if k not in redacted}


def ingest_content(
    ctx: AccessContext,
    content: bytes,
    url: str,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
) -> FeedReport:
    """Ingest one feed's bytes. Pure kernel-service calls; no raw SQL."""
    if len(content) > MAX_FEED_BYTES:
        raise ValueError(f"feed exceeds {MAX_FEED_BYTES} byte bound")
    host, url_hash = _source_ref(url)
    feed_sha = sha256(content).hexdigest()
    report = FeedReport(source_host=host, url_hash=url_hash, sha256=feed_sha)
    receipt_key = f"{feed_sha}:{url_hash}"

    existing = services.find(ctx, type_name="source_receipt", filters={"receipt_key": receipt_key})
    if existing:  # identical bytes already receipted: emit nothing (idempotency)
        report.receipt_id = existing[0].id
        report.unchanged = True
        return report

    fetched_at = datetime.now(UTC)
    start = window_start or fetched_at - timedelta(days=WINDOW_PAST_DAYS)
    end = window_end or fetched_at + timedelta(days=WINDOW_FUTURE_DAYS)
    parsed = parse_ics(content, start, end)
    report.skipped = parsed.skipped
    report.truncated = parsed.truncated

    receipt = services.capture(
        ctx,
        "source_receipt",
        {
            "receipt_key": receipt_key,
            "sha256": feed_sha,
            "url_hash": url_hash,
            "source_host": host,
            "fetched_at": fetched_at.isoformat(),
            "size_bytes": len(content),
            "occurrence_count": len(parsed.occurrences),
            "skipped_count": parsed.skipped,
        },
        actor=METHOD,
    )
    report.receipt_id = receipt.entity_id

    seen: set[str] = set()
    for occurrence in parsed.occurrences:
        if occurrence.ics_key in seen:
            report.skipped += 1
            continue
        seen.add(occurrence.ics_key)
        matches = services.find(
            ctx, type_name="appointment", filters={"ics_key": occurrence.ics_key}
        )
        if matches and matches[0].attributes.get("vevent_hash") == occurrence.vevent_hash:
            continue  # unchanged VEVENT: emit nothing
        attributes = occurrence.attributes
        if matches:
            attributes = _writable(ctx, matches[0].id, attributes)
        result = services.capture(ctx, "appointment", attributes, actor=METHOD)
        if matches:
            report.updated += 1  # entity.updated event; prior state stays in history
        else:
            report.created += 1
        services.relate(
            ctx,
            result.entity_id,
            DERIVED_FROM,
            receipt.entity_id,
            valid_from=fetched_at,
            attributes=_provenance(feed_sha),
            actor=METHOD,
        )
        _link_attendees(ctx, result.entity_id, occurrence, receipt.entity_id, fetched_at, report)
    return report


def _link_attendees(
    ctx: AccessContext,
    appointment_id: UUID,
    occurrence: Occurrence,
    receipt_id: UUID,
    fetched_at: datetime,
    report: FeedReport,
) -> None:
    if not occurrence.attendees:
        return
    view = services.get_entity(ctx, appointment_id)
    linked = {e.to_entity for e in view.edges_out if e.relation == HAS_ATTENDEE}
    for attendee in occurrence.attendees:
        digest = email_hash(attendee.email)
        attributes: dict[str, Any] = {"email_hash": digest, "email": attendee.email}
        if attendee.name:
            attributes["name"] = attendee.name
        # Keyed by the hash, not the address: an erased attendee is still found
        # here, so a changed feed updates it instead of creating a fresh entity
        # carrying the address again (invariant 9, ADR 012).
        found = services.find(ctx, type_name="attendee", filters={"email_hash": digest})
        if found:
            attendee_id = found[0].id
            attributes = _writable(ctx, attendee_id, attributes)
            if any(found[0].attributes.get(k) != v for k, v in attributes.items()):
                services.capture(ctx, "attendee", attributes, actor=METHOD)  # e.g. a renamed CN
        else:
            attendee_id = services.capture(ctx, "attendee", attributes, actor=METHOD).entity_id
            report.attendees_created += 1
            services.relate(
                ctx,
                attendee_id,
                DERIVED_FROM,
                receipt_id,
                valid_from=fetched_at,
                attributes=_provenance(report.sha256),
                actor=METHOD,
            )
        if attendee_id not in linked:
            services.relate(
                ctx,
                appointment_id,
                HAS_ATTENDEE,
                attendee_id,
                valid_from=fetched_at,
                attributes=_provenance(report.sha256),
                actor=METHOD,
            )


def ingest_context() -> AccessContext:
    """Exactly the scopes ingestion needs — narrow by construction (ADR 012);
    ``ops`` is its execution receipt and nothing else (ADR 014)."""
    return AccessContext.of("calendar:read", "calendar:write", "ops:read", "ops:write")


def _job(ctx: AccessContext) -> JobResult:
    raw = read_env("LIFEOS_ICS_URLS")
    urls = [u.strip() for u in (raw or "").split(",") if u.strip()]
    if not urls:
        # Skipped, and still a non-zero exit: a missing feed list is a
        # misconfiguration, not a quiet "nothing to do" (ADR 014).
        print("LIFEOS_ICS_URLS is not set; nothing to ingest (fail-closed)")
        return JobResult(status=STATUS_SKIPPED, summary="LIFEOS_ICS_URLS is not set")
    for name in define_calendar_types(ctx):
        print(f"defined type {name} (domain: calendar)")
    failures = 0
    created = updated = 0
    produced: list[UUID] = []
    for url in urls:
        host, url_hash = _source_ref(url)
        try:
            report = ingest_content(ctx, fetch_feed(url), url)
            print(report.line())
            created += report.created
            updated += report.updated
            if report.receipt_id is not None:
                produced.append(report.receipt_id)
        except Exception as exc:  # keep other feeds going; redact the URL
            failures += 1
            print(f"{host} [{url_hash[:12]}]: FAILED - {type(exc).__name__}: {exc}")
    return JobResult(
        status=STATUS_FAILED if failures else STATUS_OK,
        # counts only: feed text and exception messages never enter a receipt
        summary=f"feeds={len(urls)} created={created} updated={updated} failed={failures}",
        produced=produced,
    )


def main() -> int:
    return run_job(ingest_context(), METHOD, _job)


if __name__ == "__main__":
    raise SystemExit(main())
