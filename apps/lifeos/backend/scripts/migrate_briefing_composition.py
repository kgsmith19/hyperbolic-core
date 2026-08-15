"""Migrate an already-briefing database to the INT1 recomposition.

Roadmap §INT1 / ADR 019 rule 1: the briefing becomes the one morning digest —
focus intentions first, calendar context second, nothing else — so
`focus_intention_ids` (required) and the Monday edition's `gate` enter the
schema, and the `open_review_ids` / `latest_checkin_id` pointers leave it.
`define_missing` only ever defines *absent* types and the registry has no
redefinition path, so any environment that already ran B3's briefing keeps the
old schema and would refuse every recomposed capture (`additionalProperties`
is false and `open_review_ids` was required).

It syncs the stored schema to the current ``BRIEFING_SCHEMA``, so later
composition amendments reuse it: EP1 adds the optional ``episodes_line``,
H2 adds the optional ``cpap_compliance`` — re-run once per environment after
each lands.

Idempotent operator script, run once per environment BEFORE the first
recomposed briefing run, against whatever DATABASE_URL kernel.env resolves:

    .venv\\Scripts\\python scripts/migrate_briefing_composition.py

It rewrites the `briefing` json_schema in place (raw UPDATE: the registry has
no redefinition path and adding one would be a kernel change) and appends a
`type.redefined` audit event carrying the new schema — the same shape
`migrate_bill_status_verified.py` uses.

No backfill and no data change: stored briefings are pointers and stay
readable, and a recomposed re-run of a day that already holds an
old-composition briefing merges onto it (capture merges on identity), so the
old keys linger harmlessly on that one entity.
"""

from domains.ops.types import BRIEFING_SCHEMA
from kernel import db
from kernel.events import tx_now
from scripts.type_redefinition import redefine_types

ACTOR = "scripts.migrate_briefing_composition"
_REASON = (
    "roadmap INT1/EP1: the digest is focus intentions + calendar context, plus "
    "the EP1 episodes line when present; the Monday edition adds utility-gate status"
)


def migrate() -> dict[str, int]:
    with db.connect() as conn:
        now = tx_now(conn)
        updated = redefine_types(conn, {"briefing": BRIEFING_SCHEMA}, _REASON, ACTOR, now)
        return {"types_updated": updated}


if __name__ == "__main__":
    print(f"types_updated={migrate()['types_updated']}")
