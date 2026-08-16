"""Read-only query and CLI surface for the recorded device inventory."""
from . import store

DEVICE_FMT = "{id:<4} {name:<28} {kind:<10} {ip:<15} {mac:<17} {last_seen}"
CONFIG_FMT = "{key:<28} {value:<24} {observed_at}  ({source})"
CHANGE_FMT = "device {device_id:<4} {key:<28} {value:<24} {observed_at}"


def devices(conn, limit=1000):
    """The device table, most recently seen first."""
    return store._rows(conn.execute(
        "SELECT id, COALESCE(name,'') name, kind, COALESCE(ip,'') ip,"
        " COALESCE(mac,'') mac, first_seen, last_seen"
        " FROM device ORDER BY last_seen DESC LIMIT ?", (limit,)))


def device_config(conn, device_id, limit=500):
    """One device's current configuration."""
    return store._rows(conn.execute(
        "SELECT key, value, observed_at, source FROM config_current"
        " WHERE device_id=? ORDER BY key LIMIT ?", (device_id, limit)))


def changes_since(conn, since, limit=2000):
    """Configuration observations after `since`."""
    return store._rows(conn.execute(
        "SELECT device_id, key, value, observed_at, source FROM config_item"
        " WHERE observed_at>? ORDER BY observed_at LIMIT ?", (since, limit)))


def cli(conn, args):
    """Print the selected inventory view."""
    if args.device is not None:
        rows, fmt = device_config(conn, args.device), CONFIG_FMT
    elif args.diff is not None:
        rows, fmt = changes_since(conn, args.diff), CHANGE_FMT
    else:
        rows, fmt = devices(conn), DEVICE_FMT
    for row in rows:
        print(fmt.format(**row))
    return 0
