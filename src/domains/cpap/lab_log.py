"""lab_log: the roadmap H2 registry rider (operator-tracked labs; next-due
from cadence config). Type only -- no ingestion code, no briefing consumer,
no separate framework: an operator records a lab draw through the existing
generic capture door (`kernel.services.capture`) exactly like any other
operator-authored type, and `next_due` is a pure function over what has
already been logged.

Not CPAP-specific in subject matter; it lands in this cell because the
roadmap's H2 slice is where it is scheduled, and every registry type needs
exactly one cell to own it (invariant 10).
"""

from datetime import date, timedelta
from hashlib import sha256


def lab_key(lab_name: str, on: date) -> str:
    """The identity key: sha256 of the normalized name and date, not the
    values themselves -- so an erased entry (`lab_name`/`date` are x-pii)
    stays findable and the next log entry for the same lab on the same date
    resolves onto it instead of minting a duplicate (the bills `bill_key`
    precedent, ADR 012 "Durable erasure")."""
    return sha256(f"{lab_name.strip().lower()}|{on.isoformat()}".encode()).hexdigest()


def next_due(logs: list[dict[str, object]], lab_name: str) -> date | None:
    """The next due date for `lab_name`: its most recent logged draw plus
    that draw's own `cadence_days`, or None when there is no logged draw for
    this lab, or its most recent draw carries no cadence. Pure function over
    already-captured entities' attributes; nothing here schedules, pushes, or
    reminds (no notification path may exist in code)."""
    entries = [
        log
        for log in logs
        if isinstance(log.get("lab_name"), str)
        and log["lab_name"] == lab_name
        and isinstance(log.get("date"), str)
    ]
    if not entries:
        return None
    latest = max(entries, key=lambda log: str(log["date"]))
    cadence = latest.get("cadence_days")
    if not isinstance(cadence, int):
        return None
    try:
        drawn_on = date.fromisoformat(str(latest["date"]))
    except ValueError:
        return None
    return drawn_on + timedelta(days=cadence)
