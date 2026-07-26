"""Apply one migration file to the database in DATABASE_URL.

`supabase db push` needs the direct database host, which is IPv6-only; this
machine has no IPv6 route, so the app connects through the IPv4 pooler and
migrations go the same way.

    .venv\\Scripts\\python scripts/apply_migration.py supabase/migrations/<file>.sql
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from kernel import db  # noqa: E402


def apply(path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    with db.connect() as conn:
        conn.execute(sql)
    print(f"applied {path.name}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply_migration.py <migration.sql>")
    apply(Path(sys.argv[1]))
