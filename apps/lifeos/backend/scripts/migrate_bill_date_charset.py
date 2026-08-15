"""Migrate an existing database to the C4 bill/EOB date bound.

Slice 11 / ADR 018: `service_date` and `due_date` gain a character-class pattern
(`DATE_PATTERN`) alongside the length bound they already had. This cell's rule
is that a stored string is bounded in the type *as well as* in the coercion, and
C4 is what turned a date into prose composed verbatim into a letter addressed to
a third party — so the loose bound stopped being acceptable.

`define_missing` only ever defines *absent* types and the registry has no
redefinition path, so an environment that already ran C2/C3 keeps the unbounded
date and would accept a `service_date` of "see attached notice from ..." through
`POST /capture`. Idempotent operator script, run once per environment, against
whatever DATABASE_URL kernel.env resolves:

    python -m scripts.migrate_bill_date_charset

It rewrites the `bill` and `eob` json_schema in place (raw UPDATE: the registry
has no redefinition path and adding one would be a kernel change) and appends a
`type.redefined` audit event carrying the new schema — the same shape
`migrate_bill_status_verified.py` uses.

**No backfill, and none is possible to need.** The new pattern is a strict
superset of what `date.fromisoformat` — the only writer — can emit: digits, `-`
and `W`, always leading with a digit. Every date any existing record can be
holding already satisfies it, so no stored record can become `invalid` on the
next verifier run. The bound closes the direct-capture door, which was the one
that was open.
"""

from domains.bills.types import BILL_SCHEMA, EOB_SCHEMA
from kernel import db
from kernel.events import tx_now
from scripts.type_redefinition import redefine_types

ACTOR = "scripts.migrate_bill_date_charset"
_SCHEMAS = {"bill": BILL_SCHEMA, "eob": EOB_SCHEMA}
_REASON = "ADR 018: service_date/due_date bounded by character class as well as length"


def migrate() -> dict[str, int]:
    with db.connect() as conn:
        now = tx_now(conn)
        return {"types_updated": redefine_types(conn, _SCHEMAS, _REASON, ACTOR, now)}


if __name__ == "__main__":
    print(f"types_updated={migrate()['types_updated']}")
