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
import shutil
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


def attachment_path(attachment, environ):
    """The env override wins for an explicit attachment directory too."""
    return Path(environ.get(attachment["env"], ROOT / attachment["file"]))


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


def relative_file(path, root, description):
    """Return a containment-safe, portable path relative to root."""
    relative = path.relative_to(root)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"{description} escapes attachment root")
    return relative


def attachment_snapshot(src_root, dst_root):
    """Copy one declared directory and return its verifiable file manifest."""
    if not src_root.is_dir():
        raise RuntimeError(f"attachment root is not a directory: {src_root}")
    dst_root.mkdir(parents=True, exist_ok=False)
    files = []
    for src in sorted(src_root.rglob("*")):
        if src.is_symlink():
            raise RuntimeError(f"attachment contains unsupported symlink: {src}")
        if not src.is_file():
            continue
        relative = relative_file(src, src_root, "source attachment path")
        dst = dst_root / relative
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        files.append({"path": relative.as_posix(), "sha256": sha256(dst), "bytes": dst.stat().st_size})
    return files


def manifest_path(root, relative, description):
    """Resolve a manifest path only if it stays inside its declared root."""
    candidate = Path(relative)
    if candidate.is_absolute() or not candidate.parts or ".." in candidate.parts:
        raise RuntimeError(f"{description} escapes attachment root")
    resolved_root = root.resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(resolved_root):
        raise RuntimeError(f"{description} escapes attachment root")
    return resolved


def backup(out_dir, stores, environ):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    entries, skipped, attachments, skipped_attachments = [], [], [], []
    for store in stores:
        src = store_path(store, environ)
        if not src.exists():
            skipped.append(store["app"])
        else:
            dst = out / f"{store['app']}.db"
            counts = snapshot(src, dst)
            entries.append({"app": store["app"], "file": dst.name, "sha256": sha256(dst), "rows": counts})
        for attachment in store.get("attachments", []):
            attachment_src = attachment_path(attachment, environ)
            label = f"{store['app']}:{attachment['name']}"
            if not attachment_src.exists():
                skipped_attachments.append(label)
                continue
            root = f"{store['app']}-{attachment['name']}"
            attachments.append({
                "app": store["app"],
                "name": attachment["name"],
                "root": root,
                "files": attachment_snapshot(attachment_src, out / root),
            })
    manifest = {
        "taken_at": datetime.now(timezone.utc).isoformat(),
        "stores": entries,
        "skipped": skipped,
        "attachments": attachments,
        "skipped_attachments": skipped_attachments,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def restore_drill(backup_dir, report_path=None, now=None):
    started = time.monotonic()
    backup_dir = Path(backup_dir)
    manifest = json.loads((backup_dir / "manifest.json").read_text())
    attachments = manifest.get("attachments", [])
    if not manifest["stores"] and not attachments:
        raise RuntimeError("backup holds no stores or attachments; nothing to prove")
    now = now or datetime.now(timezone.utc)
    taken = datetime.fromisoformat(manifest["taken_at"])
    results, attachment_results = [], []
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
        for attachment in attachments:
            source_root = manifest_path(backup_dir, attachment["root"], "attachment root")
            restore_root = Path(scratch) / attachment["root"]
            restore_root.mkdir(parents=True, exist_ok=False)
            for entry in attachment["files"]:
                src = manifest_path(source_root, entry["path"], "attachment path")
                if not src.is_file() or sha256(src) != entry["sha256"]:
                    raise RuntimeError(f"{attachment['app']}:{attachment['name']}: attachment hash does not match the manifest")
                if src.stat().st_size != entry["bytes"]:
                    raise RuntimeError(f"{attachment['app']}:{attachment['name']}: attachment byte count does not match the manifest")
                restored = manifest_path(restore_root, entry["path"], "attachment path")
                restored.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, restored)
                if sha256(restored) != entry["sha256"]:
                    raise RuntimeError(f"{attachment['app']}:{attachment['name']}: restored attachment hash does not match the manifest")
            attachment_results.append({"app": attachment["app"], "name": attachment["name"], "files": len(attachment["files"])})
    report = {
        "rpo_seconds": int((now - taken).total_seconds()),
        "rto_seconds": round(time.monotonic() - started, 3),
        "restored": results,
        "restored_attachments": attachment_results,
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
