"""Rebuild entity, entity_type, and edge projections from the event log.

The event log is the source of truth; projections are disposable (invariant 2).
"""

from kernel import db
from kernel.projections import rebuild


def main() -> None:
    with db.connect() as conn:
        applied = rebuild(conn)
    print(f"replayed {applied} projection events")


if __name__ == "__main__":
    main()
