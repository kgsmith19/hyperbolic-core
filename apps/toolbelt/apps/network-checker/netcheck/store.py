"""SQLite store. Source of truth; Supabase is only ever a mirror of this.

Schema bootstrap, migration, and per-table CRUD live in db.py (split out to
stay inside the project's per-file line budget); every name below is
re-imported here so `store.open_db(...)`, `store.host_id(...)`, etc. keep
working unchanged for every existing caller.
"""
import json
import urllib.error
import urllib.request

from .db import (  # noqa: F401 -- re-exported for existing store.X callers
    _rows,
    add_error,
    add_event,
    add_sample,
    add_scan,
    columns,
    errors,
    host_id,
    mark_synced,
    offsets,
    open_db,
    samples,
    samples_by_label,
    save_offsets,
    scans,
    unsynced,
)

SYNCED_TABLES = ("samples", "events", "llm_errors", "env_scans",
                 "device", "interface", "config_item")
_CONFLICT_TARGETS = {
    "samples": "host,ts",
    "events": "host,ts,kind",
    "llm_errors": "host,ts,detail",
    "env_scans": "host,ts",
    "device": "host,identity",
    "interface": "host,device_mac,device_ip,name,observed_at",
    "config_item": "host,device_mac,device_ip,key,observed_at",
}


def mirror(conn, url=None, key=None, host_name=None):
    """Push unsynced rows to Supabase PostgREST. Never blocks local capture.

    Returns a per-table report. Unconfigured is 'unavailable', not a silent
    success: a mirror that quietly does nothing is worse than one that says so.
    """
    if not url or not key:
        return {"state": "unavailable", "reason": "SUPABASE_URL/KEY not set"}

    report = {"state": "ok", "pushed": {}}
    for table in SYNCED_TABLES:
        result = _mirror_table(conn, (url, key), table, host_name)
        if result is None:
            continue
        if result["state"] == "fail":
            # `report` spreads first so it cannot overwrite the failure state.
            return {**report, **result}
        report["pushed"][table] = result["count"]
    return report


def _mirror_table(conn, supabase, table, host_name):
    """One table's push-and-mark-synced step, factored out of mirror() so
    that function's own branching stays inside the complexity budget.

    Returns None when the table had nothing pending, else a dict with
    state 'ok' (and 'count') or 'fail' (and 'reason') -- mirror() never
    crashes on a bad row: a row that fails to map to the remote natural-key
    contract (e.g. a device with neither MAC nor IP) leaves that table's
    rows unsynced for the next attempt, same as a network failure.
    """
    pending = unsynced(conn, table)
    if not pending:
        return None
    try:
        remote = [for_remote(conn, table, row, host_name) for row in pending]
    except ValueError as e:
        return {"state": "fail", "reason": str(e)}
    err = _push(supabase, table, remote)
    if err:
        return {"state": "fail", "reason": err}
    mark_synced(conn, table, [r["id"] for r in pending])
    return {"state": "ok", "count": len(pending)}


def _conflict_policy(table):
    return "merge-duplicates" if table == "device" else "ignore-duplicates"


def _push(supabase, table, rows):
    """POST one table's pending rows. Returns an error string, or None.

    A link that is down is expected, not exceptional: the caller leaves the
    rows unsynced so the next attempt retries them, which is why this returns
    an error rather than raising.
    """
    url, key = supabase
    body = json.dumps(rows).encode()
    endpoint = (f"{url.rstrip('/')}/rest/v1/{table}"
                f"?on_conflict={_CONFLICT_TARGETS[table]}")
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "Prefer": f"resolution={_conflict_policy(table)},return=minimal"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return f"HTTP {r.status}" if r.status >= 300 else None
    except (urllib.error.URLError, OSError) as e:
        return str(e)


def _for_remote(row, host_name):
    """Local integer ids are meaningless remotely; host is keyed by name."""
    out = {k: v for k, v in row.items() if k not in ("id", "host_id", "synced")}
    out["host"] = host_name
    if isinstance(out.get("payload"), str):
        # env_scans.payload is jsonb remotely so it stays queryable; sending the
        # string would store a JSON scalar instead of an object.
        try:
            out["payload"] = json.loads(out["payload"])
        except ValueError:
            pass
    return out


def for_remote(conn, table, row, host_name):
    """Map local surrogate device ids to the remote natural-key contract."""
    out = _for_remote(row, host_name)
    if table == "device":
        key, value = ("mac", out.get("mac")) if out.get("mac") else ("ip", out.get("ip"))
        if value is None:
            raise ValueError("device mirror identity requires a MAC or IP")
        out["identity"] = f"{key}:{value.lower() if key == 'mac' else value}"
        return out
    if table not in ("interface", "config_item"):
        return out
    device = conn.execute(
        "SELECT mac, ip FROM device WHERE id=?", (row["device_id"],)).fetchone()
    if device is None:
        raise ValueError(f"missing device {row['device_id']} for {table} row")
    out.pop("device_id", None)
    out["device_mac"], out["device_ip"] = device["mac"], device["ip"]
    return out
