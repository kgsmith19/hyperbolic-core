"""SimpleFIN Bridge transaction ingestion (roadmap C0).

**Explicitly user-triggered, never a daemon.** Runs only as
``python -m domains.money.simplefin_ingest``; it is not part of the
scheduled trio in `AGENTS.md` and nothing in this repo invokes it on a
timer, webhook, or any other unattended trigger — that is the acceptance
criterion, not just a convention.

Two-layer idempotency (domains.cpap.ingest / domains.calendar.ingest
precedent): a `money_source_receipt` short-circuits an unchanged pull (same
normalized response, same window, same source), and inside a changed pull
each transaction is compared against its stored `transaction` (by
`transaction_key`, the roadmap's own (account, posted_date, amount,
normalized_desc) hash) before writing.

Missing `LIFEOS_SIMPLEFIN_ACCESS_URL` is `STATUS_SKIPPED`, never a crash and
never a silent no-op (ADR 014, the SleepHQ/calendar precedent). A
configured-but-failing SimpleFIN call is `STATUS_FAILED`. The access URL
itself is a bearer credential (domains.money.simplefin_client's own
docstring) and never appears in a log line, an execution receipt, or an
exception message past that module's one call site.
"""

import sys
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from json import dumps
from typing import Any

from domains.money.common import (
    ParsedTransaction,
    WriteReport,
    account_key,
    money_context,
    write_transactions,
)
from domains.money.simplefin_client import SimpleFinError, fetch_accounts
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, STATUS_SKIPPED, JobResult, run_job
from kernel.access import AccessContext
from kernel.env import read_env

SOURCE = "simplefin"
METHOD = "domains.money.simplefin_ingest"

# Pulled window is wider than a typical review cadence so a late-posting
# transaction near the edge of a prior window is still picked up on the next
# run. Note: a bank revising a transaction's amount or description after the
# fact mints a *new* transaction_key (both are part of the roadmap's own
# identity hash) rather than updating the prior row -- the two coexist on
# record, the same way two genuinely distinct same-day transactions would.
# Only a same-identity field (pending, currency, external_id) can trigger a
# true in-place update.
PULL_WINDOW_DAYS = 35


def parse_account(raw: Any) -> tuple[str, str | None, str | None, list[Any]] | None:
    """One SimpleFIN `accounts` list item -> (account_key, name, currency,
    raw transactions), or None when malformed. Dropped, never guessed at."""
    if not isinstance(raw, dict):
        return None
    external_id = raw.get("id")
    if not isinstance(external_id, str) or not external_id:
        return None
    name = raw.get("name")
    name = name if isinstance(name, str) and name.strip() else None
    currency = raw.get("currency")
    currency = currency.upper() if isinstance(currency, str) and len(currency) == 3 else None
    transactions = raw.get("transactions")
    transactions = transactions if isinstance(transactions, list) else []
    return account_key(SOURCE, external_id), name, currency, transactions


def parse_transaction(raw: Any, acct_key: str) -> ParsedTransaction | None:
    """One SimpleFIN transaction item -> a ParsedTransaction, or None when
    malformed. Dropped, never guessed at: a response we cannot parse must
    never become a fabricated transaction."""
    if not isinstance(raw, dict):
        return None
    posted = raw.get("posted")
    if not isinstance(posted, int | float) or isinstance(posted, bool):
        return None
    try:
        posted_date = datetime.fromtimestamp(posted, tz=UTC).date()
    except (OverflowError, OSError, ValueError):
        return None
    raw_amount = raw.get("amount")
    if not isinstance(raw_amount, str) or not raw_amount.strip():
        return None
    try:
        amount = float(raw_amount)
    except ValueError:
        return None
    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        return None
    pending = raw.get("pending") if isinstance(raw.get("pending"), bool) else None
    external_id = raw.get("id")
    external_id = external_id if isinstance(external_id, str) and external_id else None
    return ParsedTransaction(
        account_key=acct_key,
        posted_date=posted_date,
        amount=amount,
        description=description.strip(),
        source=SOURCE,
        pending=pending,
        external_id=external_id,
    )


def ingest_accounts(
    ctx: AccessContext,
    raw_accounts: list[dict[str, Any]],
    window_start: date,
    window_end: date,
    payload_sha: str,
    fetched_at: datetime | None = None,
) -> WriteReport:
    """Ingest one SimpleFIN `/accounts` response. Pure kernel-service calls;
    no raw SQL. Idempotent by construction (see module docstring)."""
    fetched_at = fetched_at or datetime.now(UTC)
    accounts: dict[str, tuple[str | None, str | None]] = {}
    transactions: list[ParsedTransaction] = []
    for raw_account in raw_accounts:
        parsed = parse_account(raw_account)
        if parsed is None:
            continue
        acct_key, name, currency, raw_transactions = parsed
        accounts[acct_key] = (name, currency)
        for raw_txn in raw_transactions:
            txn = parse_transaction(raw_txn, acct_key)
            if txn is None or not (window_start <= txn.posted_date <= window_end):
                continue
            transactions.append(txn)

    return write_transactions(
        ctx,
        METHOD,
        SOURCE,
        payload_sha,
        window_start,
        window_end,
        accounts,
        transactions,
        fetched_at,
    )


def simplefin_access_url() -> str | None:
    return read_env("LIFEOS_SIMPLEFIN_ACCESS_URL")


def _job(ctx: AccessContext) -> JobResult:
    access_url = simplefin_access_url()
    if access_url is None:
        print(
            "LIFEOS_SIMPLEFIN_ACCESS_URL is not set; nothing to ingest (fail-closed)"
        )
        return JobResult(status=STATUS_SKIPPED, summary="SimpleFIN access URL is not configured")

    fetched_at = datetime.now(UTC)
    window_end = fetched_at.date()
    window_start = window_end - timedelta(days=PULL_WINDOW_DAYS - 1)

    try:
        raw_accounts = fetch_accounts(access_url, window_start, window_end)
    except SimpleFinError as exc:
        # Class name only: a provider error can echo request contents, and
        # the request carries a bearer credential derived from the access URL.
        print(f"simplefin: FAILED - {type(exc).__name__}", file=sys.stderr)
        return JobResult(
            status=STATUS_FAILED, summary=f"SimpleFIN fetch failed: {type(exc).__name__}"
        )

    body = dumps(raw_accounts, sort_keys=True, default=str)
    payload_sha = sha256(body.encode()).hexdigest()

    report = ingest_accounts(ctx, raw_accounts, window_start, window_end, payload_sha, fetched_at)
    print(report.line())
    produced = [] if report.unchanged or report.receipt_id is None else [report.receipt_id]
    return JobResult(status=STATUS_OK, summary=report.line(), produced=produced)


def main() -> int:
    return run_job(money_context(), METHOD, _job)


if __name__ == "__main__":
    raise SystemExit(main())
