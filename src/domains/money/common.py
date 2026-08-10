"""Shared hashing/normalization and the capture loop both money ingestion
paths (SimpleFIN pull, CSV import) use identically (ADR 010/012 precedents
from domains.cpap.ingest / domains.calendar.ingest).

Kept here once rather than duplicated in each entry point: the idempotency
hash shape (account, posted_date, amount, normalized_desc) is the roadmap's
own acceptance criterion and must be computed the same way regardless of
source.
"""

from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from domains.money.types import DOMAIN, define_money_types
from kernel import services
from kernel.access import AccessContext

DERIVED_FROM = "derived_from"


def account_key(source: str, external_ref: str) -> str:
    """Identity hash for one account. Never the raw reference (a SimpleFIN
    account id or a CSV-supplied label) — that value may itself be
    identifying (a bank nickname), so it is hashed before it can be matched
    on by the identity resolver."""
    body = f"{source}|{external_ref.strip().lower()}"
    return sha256(body.encode()).hexdigest()


def normalize_description(raw: str) -> str:
    """Lowercased, whitespace-collapsed description — stable across sources
    (SimpleFIN JSON vs. a bank's CSV export) so the same real-world
    transaction hashes identically regardless of which source reported it
    first."""
    return " ".join(raw.strip().lower().split())


def transaction_key(acct_key: str, posted_date: date, amount: float, normalized_desc: str) -> str:
    """The roadmap's own idempotency tuple: (account, posted_date, amount,
    normalized_desc)."""
    body = f"{acct_key}|{posted_date.isoformat()}|{amount:.2f}|{normalized_desc}"
    return sha256(body.encode()).hexdigest()


def money_context() -> AccessContext:
    """Exactly the scopes ingestion needs -- narrow by construction; ``ops``
    is its execution receipt and nothing else (ADR 014)."""
    return AccessContext.of(f"{DOMAIN}:read", f"{DOMAIN}:write", "ops:read", "ops:write")


def _writable(ctx: AccessContext, entity_id: UUID, attributes: dict[str, Any]) -> dict[str, Any]:
    """`attributes` minus everything this entity has had erased -- ingestion
    must never write a redacted field back (invariant 9, ADR 012)."""
    redacted = services.redacted_fields(ctx, entity_id)
    return {k: v for k, v in attributes.items() if k not in redacted}


@dataclass
class ParsedTransaction:
    account_key: str
    posted_date: date
    amount: float
    description: str
    source: str
    currency: str | None = None
    pending: bool | None = None
    external_id: str | None = None


@dataclass
class WriteReport:
    sha256: str
    window_start: date
    window_end: date
    source: str
    receipt_id: UUID | None = None
    unchanged: bool = False
    accounts_created: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0

    def line(self) -> str:
        if self.unchanged:
            return f"{self.source} [{self.sha256[:12]}]: unchanged, nothing emitted"
        return (
            f"{self.source} [{self.sha256[:12]}]: accounts_created={self.accounts_created} "
            f"created={self.created} updated={self.updated} skipped={self.skipped} "
            f"receipt={self.receipt_id}"
        )


def _account_attributes(
    source: str, acct_key: str, name: str | None, currency: str | None
) -> dict[str, Any]:
    attrs: dict[str, Any] = {"account_key": acct_key, "source": source}
    if name:
        attrs["name"] = name
    if currency:
        attrs["currency"] = currency
    return attrs


def _transaction_attributes(
    txn: ParsedTransaction, normalized_desc: str
) -> tuple[dict[str, Any], str]:
    key = transaction_key(txn.account_key, txn.posted_date, txn.amount, normalized_desc)
    attrs: dict[str, Any] = {
        "transaction_key": key,
        "account_key": txn.account_key,
        "posted_date": txn.posted_date.isoformat(),
        "source": txn.source,
        "amount": round(txn.amount, 2),
        "description": txn.description[:256],
        "normalized_desc": normalized_desc[:256],
    }
    if txn.currency:
        attrs["currency"] = txn.currency
    if txn.pending is not None:
        attrs["pending"] = txn.pending
    if txn.external_id:
        attrs["external_id"] = txn.external_id[:128]
    return attrs, key


def _provenance(response_sha: str, method: str) -> dict[str, Any]:
    return {"method": method, "confidence": 1.0, "source_sha256": response_sha}


def write_transactions(
    ctx: AccessContext,
    method: str,
    source: str,
    payload_sha: str,
    window_start: date,
    window_end: date,
    accounts: dict[str, tuple[str | None, str | None]],
    transactions: list[ParsedTransaction],
    fetched_at: datetime,
) -> WriteReport:
    """Write one pull/import's parsed accounts and transactions under a
    receipt short-circuit plus per-transaction dedup (ADR 010/012, the
    cpap.ingest / calendar.ingest precedent). Pure kernel-service calls; no
    raw SQL. Idempotent by construction."""
    define_money_types(ctx)
    receipt_key = f"{payload_sha}:{source}:{window_start.isoformat()}:{window_end.isoformat()}"
    report = WriteReport(
        sha256=payload_sha, window_start=window_start, window_end=window_end, source=source
    )

    existing = services.find(
        ctx, type_name="money_source_receipt", filters={"receipt_key": receipt_key}
    )
    if existing:  # identical payload for this window already receipted
        report.receipt_id = existing[0].id
        report.unchanged = True
        return report

    receipt = services.capture(
        ctx,
        "money_source_receipt",
        {
            "receipt_key": receipt_key,
            "sha256": payload_sha,
            "fetched_at": fetched_at.isoformat(),
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "transaction_count": len(transactions),
            "source": source,
        },
        actor=method,
    )
    report.receipt_id = receipt.entity_id

    for acct_key, (name, currency) in accounts.items():
        attrs = _account_attributes(source, acct_key, name, currency)
        matches = services.find(ctx, type_name="account", filters={"account_key": acct_key})
        if matches:
            if all(matches[0].attributes.get(k) == v for k, v in attrs.items()):
                continue  # unchanged account: emit nothing
            services.capture(ctx, "account", _writable(ctx, matches[0].id, attrs), actor=method)
            continue
        services.capture(ctx, "account", attrs, actor=method)
        report.accounts_created += 1

    seen: set[str] = set()
    for txn in transactions:
        normalized_desc = normalize_description(txn.description)
        attributes, key = _transaction_attributes(txn, normalized_desc)
        if key in seen:
            report.skipped += 1
            continue
        seen.add(key)
        matches = services.find(ctx, type_name="transaction", filters={"transaction_key": key})
        if matches and all(matches[0].attributes.get(k) == v for k, v in attributes.items()):
            continue  # unchanged transaction: emit nothing
        if matches:
            attributes = _writable(ctx, matches[0].id, attributes)
        result = services.capture(ctx, "transaction", attributes, actor=method)
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
            attributes=_provenance(payload_sha, method),
            actor=method,
        )
    return report
