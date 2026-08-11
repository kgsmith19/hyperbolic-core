"""Data lint: duplicate identity values, dangling edges, unresolved ambiguities.

Prints a report. Runnable by hand; scheduling comes later.
"""

from collections import defaultdict
from typing import Any

from kernel import db


def duplicate_identities(conn: db.Connection) -> list[str]:
    findings: list[str] = []
    types = conn.execute(
        "select name, json_schema from type_definition where is_active"
    ).fetchall()
    for type_row in types:
        identity_fields = type_row["json_schema"].get("x-identity") or []
        for field in identity_fields:
            owners: dict[Any, set[Any]] = defaultdict(set)
            rows = conn.execute(
                """
                select e.id, e.attributes -> %s as value
                from entity e
                join entity_type et on et.entity_id = e.id
                join type_definition td on td.id = et.type_id
                where td.name = %s and e.attributes ? %s
                """,
                (field, type_row["name"], field),
            ).fetchall()
            for row in rows:
                values = row["value"] if isinstance(row["value"], list) else [row["value"]]
                for value in values:
                    owners[value].add(row["id"])
            for value, ids in sorted(owners.items(), key=lambda kv: str(kv[0])):
                if len(ids) > 1:
                    findings.append(
                        f"duplicate {type_row['name']}.{field}={value!r} "
                        f"across entities: {sorted(map(str, ids))}"
                    )
    return findings


def dangling_edges(conn: db.Connection) -> list[str]:
    rows = conn.execute(
        """
        select ed.id from edge ed
        left join entity f on f.id = ed.from_entity
        left join entity t on t.id = ed.to_entity
        where f.id is null or t.id is null
        """
    ).fetchall()
    return [f"dangling edge: {row['id']}" for row in rows]


def unresolved_ambiguities(conn: db.Connection) -> list[str]:
    rows = conn.execute(
        """
        select entity_id, payload from event
        where event_type = 'resolution.ambiguity' order by recorded_at
        """
    ).fetchall()
    return [
        f"ambiguous resolution -> new entity {row['entity_id']} "
        f"(candidates: {row['payload'].get('candidates')})"
        for row in rows
    ]


def main() -> None:
    with db.connect() as conn:
        sections = {
            "duplicate identity values": duplicate_identities(conn),
            "dangling edges": dangling_edges(conn),
            "unresolved ambiguities": unresolved_ambiguities(conn),
        }
    total = 0
    for title, findings in sections.items():
        print(f"== {title}: {len(findings)}")
        for line in findings:
            print(f"   {line}")
        total += len(findings)
    print(f"lint complete: {total} finding(s)")


if __name__ == "__main__":
    main()
