"""Local backup and restore drill for every SQLite store (#504, AC2).

`backup` writes one consistent SQLite snapshot per store, plus a manifest
with each file's sha256 and row counts. `restore-drill` restores every
snapshot into a scratch directory, then proves it: integrity_check, row
counts equal to the manifest, and the file hash unchanged. It records the
RPO (age of the newest snapshot) and RTO (restore + verify time).

Stdlib only. Stores are declared in ops/stores.json; a store whose file does
not exist yet is reported as skipped, never invented.
"""

import argparse
import hashlib
import json
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORES_FILE = ROOT / "ops" / "stores.json"


def load_stores(path=STORES_FILE):
    return json.loads(Path(path).read_text())["stores"]


def store_path(store, environ):
    """The env override wins, so the drill backs up what the app really uses."""
    return Path(environ.get(store["env"], ROOT / store["file"]))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def table_counts(conn):
    names = [r[0] for r in conn.execute(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
    return {name: conn.execute(f'select count(*) from "{name}"').fetchone()[0] for name in names}


def snapshot(src_path, dst_path):
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(dst_path)
        try:
            src.backup(dst)
            check = dst.execute("pragma integrity_check").fetchone()[0]
            if check != "ok":
                raise RuntimeError(f"integrity_check failed on snapshot: {check}")
            return table_counts(dst)
        finally:
            dst.close()
    finally:
        src.close()


def backup(out_dir, stores, environ):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    entries, skipped = [], []
    for store in stores:
        src = store_path(store, environ)
        if not src.exists():
            skipped.append(store["app"])
            continue
        dst = out / f"{store['app']}.db"
        counts = snapshot(src, dst)
        entries.append({"app": store["app"], "file": dst.name, "sha256": sha256(dst), "rows": counts})
    manifest = {
        "taken_at": datetime.now(timezone.utc).isoformat(),
        "stores": entries,
        "skipped": skipped,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def restore_drill(backup_dir, report_path=None, now=None):
    started = time.monotonic()
    backup_dir = Path(backup_dir)
    manifest = json.loads((backup_dir / "manifest.json").read_text())
    if not manifest["stores"]:
        raise RuntimeError("backup holds no stores; nothing to prove")
    now = now or datetime.now(timezone.utc)
    taken = datetime.fromisoformat(manifest["taken_at"])
    results = []
    with tempfile.TemporaryDirectory() as scratch:
        for entry in manifest["stores"]:
            src = backup_dir / entry["file"]
            if sha256(src) != entry["sha256"]:
                raise RuntimeError(f"{entry['app']}: snapshot hash does not match the manifest")
            restored = Path(scratch) / entry["file"]
            restored.write_bytes(src.read_bytes())
            conn = sqlite3.connect(restored)
            try:
                if conn.execute("pragma integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError(f"{entry['app']}: integrity_check failed after restore")
                if table_counts(conn) != entry["rows"]:
                    raise RuntimeError(f"{entry['app']}: row counts differ from the manifest")
            finally:
                conn.close()
            results.append({"app": entry["app"], "rows": sum(entry["rows"].values())})
    report = {
        "rpo_seconds": int((now - taken).total_seconds()),
        "rto_seconds": round(time.monotonic() - started, 3),
        "restored": results,
    }
    if report_path:
        Path(report_path).parent.mkdir(parents=True, exist_ok=True)
        Path(report_path).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup")
    b.add_argument("out_dir")
    d = sub.add_parser("restore-drill")
    d.add_argument("backup_dir")
    d.add_argument("--report", default=None)
    args = parser.parse_args(argv)
    import os
    if args.cmd == "backup":
        manifest = backup(args.out_dir, load_stores(), dict(os.environ))
        print(f"backup: {len(manifest['stores'])} store(s) to {args.out_dir}; skipped {manifest['skipped'] or 'none'}")
        return 0
    report = restore_drill(args.backup_dir, args.report)
    print(f"restore-drill: {len(report['restored'])} store(s) verified; RPO {report['rpo_seconds']}s, RTO {report['rto_seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
