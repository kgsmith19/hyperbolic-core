"""Device and configuration inventory: promotes facts netcheck's scan already
collects into first-class, queryable device / interface / config_item rows,
instead of leaving them trapped inside env_scans.payload JSON blobs
(schema.sql). record_inventory() is a pure mapping over an already-collected
environ.scan() payload -- no probing, no network calls of its own -- fed by
exactly the five modules that already gather this data: topology.py
(neighbor table), ssdp.py (gateway identity), snmp.py (modem scalars),
remote.py (modem/router/WAN status), environ.py (this host's own adapter
properties).

Device identity: topology.py's entries carry a real (mac, ip) pair -- mac
may be None (FR-017 never drops a device for lack of one), ip never is. This
host itself, the DOCSIS modem, and the ASUS router have no address of their
own in these five modules' *returned* payloads (remote.py queries a
*configured* host its result never echoes back), so each is a stable
per-host singleton keyed by a sentinel `ip` ('self' / 'modem' / 'router')
that cannot collide with a real dotted-quad. UNIQUE(host_id, mac, ip) cannot
de-duplicate a NULL/NULL pair across repeated scans by itself (SQLite treats
every NULL as distinct from every other NULL in a unique index), so
_upsert_device() looks up an existing row with `IS`, not `=`, and upserts by
hand instead of leaning on INSERT OR IGNORE.
"""
import json
import re

from .inventory_query import changes_since, cli, device_config, devices

_WIFI_KEYS = ("ssid", "bssid", "band", "channel", "signal_pct", "rssi_dbm",
              "rx_mbps", "tx_mbps", "radio")
_DRIVER_KEYS = ("adapter", "driver", "driver_date", "link", "allow_power_off",
                "wireless_mode", "roaming", "transmit_power", "preferred_band")
_TCP_KEYS = ("autotuning", "rss", "ecn")
_DOCSIS_KEYS = ("connectivity", "boot_state", "security", "uptime",
                "snr_db", "power_dbmv", "uncorrectables")
_SNMP_KEYS = ("sys_descr", "sys_uptime_ticks")

def _ok(section):
    return bool(section) and section.get("state") == "ok"


def _mac(value):
    """Canonical colon-separated lower-case hardware address, or None."""
    if not value:
        return None
    compact = re.sub(r"[^0-9a-fA-F]", "", value)
    if len(compact) != 12:
        return None
    return ":".join(compact[i:i + 2] for i in range(0, 12, 2)).lower()


def _section_items(source, prefix, section, keys):
    """(source, key, value) triples for an 'ok' section's chosen fields;
    empty for one that is missing/unavailable/failed -- an unmeasured
    section must never become a fabricated configuration row."""
    if not _ok(section):
        return []
    return [(source, f"{prefix}{k}", section.get(k)) for k in keys]


def _upsert_device(conn, host_id, fact):
    """Insert or update one device row, matched by (mac, ip) with `IS` so a
    NULL mac/ip still finds its own earlier row across scans. `kind` is only
    ever promoted away from 'unknown', never back to it. Returns the id."""
    mac, ip = _mac(fact["mac"]), fact["ip"]
    row = conn.execute(
        "SELECT id FROM device WHERE host_id=? AND "
        "((? IS NOT NULL AND mac=?) OR (? IS NULL AND mac IS NULL AND ip IS ?))",
        (host_id, mac, mac, mac, ip)).fetchone()
    if row:
        conn.execute(
            "UPDATE device SET mac=?, ip=?, last_seen=?, synced=0,"
            " kind=CASE WHEN ?<>'unknown' THEN ? ELSE kind END,"
            " name=COALESCE(?, name), vendor=COALESCE(?, vendor) WHERE id=?",
            (mac, ip, fact["ts"], fact["kind"], fact["kind"], fact.get("name"),
             fact.get("vendor"), row["id"]))
        return row["id"]
    cur = conn.execute(
        "INSERT INTO device (host_id, mac, ip, kind, name, vendor, first_seen, last_seen)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (host_id, mac, ip, fact["kind"], fact.get("name"), fact.get("vendor"),
         fact["ts"], fact["ts"]))
    return cur.lastrowid


def _add_config(conn, device_id, ts, batch):
    """Append one config_item row per (source, key, value) triple in `batch`
    whose value is not None; a replay of an identical (device_id, key,
    observed_at) triple is ignored. Returns the count of rows written."""
    written = 0
    for source, key, value in batch:
        if value is None:
            continue
        encoded = value if isinstance(value, str) else json.dumps(value)
        cur = conn.execute(
            "INSERT OR IGNORE INTO config_item"
            " (device_id, key, value, observed_at, source, synced) VALUES (?, ?, ?, ?, ?, 0)",
            (device_id, key, encoded, ts, source))
        written += cur.rowcount
    return written


def _map_topology(conn, host_id, topology, ts):
    """One device row per neighbor-table entry (NC-3.1); the SSDP-named row
    is 'gateway', every other 'unknown'. Returns the device ids touched and
    the config_item count (one 'topology.name' entry for the named row)."""
    if not _ok(topology):
        return [], 0
    ids, cfg = [], 0
    for dev in topology["devices"]:
        name = dev.get("name")
        fact = {"mac": dev["mac"], "ip": dev["ip"],
                "kind": "gateway" if name else "unknown", "name": name, "ts": ts}
        device_id = _upsert_device(conn, host_id, fact)
        if name:
            cfg += _add_config(conn, device_id, ts, [("topology", "topology.name", name)])
        ids.append(device_id)
    return ids, cfg


def _map_gateway(conn, host_id, gateway, ts):
    """ssdp.identify_gateway()'s own top-level result, present at every
    tier. Reuses a topology row already at this ip (preserving its mac) if
    one exists; otherwise creates a mac=None row, same as topology would."""
    if not _ok(gateway) or not gateway.get("ip"):
        return None, 0
    ip = gateway["ip"]
    existing = conn.execute(
        "SELECT mac FROM device WHERE host_id=? AND ip=?", (host_id, ip)).fetchone()
    manufacturer, model = gateway.get("manufacturer"), gateway.get("model")
    name = " ".join(p for p in (manufacturer, model) if p) or None
    fact = {"mac": existing["mac"] if existing else None, "ip": ip, "kind": "gateway",
            "name": name, "vendor": manufacturer, "ts": ts}
    device_id = _upsert_device(conn, host_id, fact)
    cfg = _add_config(conn, device_id, ts,
                       [("ssdp", "gateway.manufacturer", manufacturer),
                        ("ssdp", "gateway.model", model)])
    return device_id, cfg


def _map_self_interface(conn, device_id, scan_payload, ts):
    """This host's own Wi-Fi adapter; wired ethernet stays out of V1."""
    wifi, driver = scan_payload.get("wifi") or {}, scan_payload.get("driver") or {}
    if not _ok(wifi) and not _ok(driver):
        return 0
    name = driver.get("adapter") or "Wi-Fi"
    cur = conn.execute(
        "INSERT OR IGNORE INTO interface"
        " (device_id, name, medium, speed_mbps, observed_at, synced)"
        " VALUES (?, ?, 'wifi', ?, ?, 0)", (device_id, name, wifi.get("rx_mbps"), ts))
    return cur.rowcount


def _map_self(conn, host_id, scan_payload, ts):
    """This host's own wifi()/driver()/tcp_globals() facts, keyed to the
    'self' singleton since none of the three carries this host's mac/ip."""
    device_id = _upsert_device(conn, host_id,
                                {"mac": None, "ip": "self", "kind": "self", "ts": ts})
    items = (_section_items("environ", "wifi.", scan_payload.get("wifi"), _WIFI_KEYS)
             + _section_items("environ", "", scan_payload.get("driver"), _DRIVER_KEYS)
             + _section_items("environ", "tcp.", scan_payload.get("tcp"), _TCP_KEYS))
    n_cfg = _add_config(conn, device_id, ts, items)
    n_iface = _map_self_interface(conn, device_id, scan_payload, ts)
    return device_id, n_iface, n_cfg


def _map_modem(conn, host_id, scan_payload, ts):
    """remote.modem() (DOCSIS) and snmp.modem_snmp() describe the same
    physical modem -- the latter a supplement, never a separate device --
    keyed to a 'modem' singleton like 'self' (neither echoes its host)."""
    modem, modem_snmp = scan_payload.get("modem"), scan_payload.get("modem_snmp")
    if not _ok(modem) and not _ok(modem_snmp):
        return None, 0
    name = (modem_snmp or {}).get("sys_descr")
    device_id = _upsert_device(conn, host_id,
                                {"mac": None, "ip": "modem", "kind": "modem",
                                 "name": name, "ts": ts})
    items = (_section_items("remote", "docsis.", modem, _DOCSIS_KEYS)
             + _section_items("snmp", "", modem_snmp, _SNMP_KEYS))
    return device_id, _add_config(conn, device_id, ts, items)


def _map_router(conn, host_id, router, ts):
    """remote.router()'s ASUS AiProtection/DPI target: 'gateway' kind (no
    separate 'router' kind exists) but its own singleton -- nothing here
    proves it is the same box SSDP found."""
    if not _ok(router):
        return None, 0
    device_id = _upsert_device(conn, host_id,
                                {"mac": None, "ip": "router", "kind": "gateway", "ts": ts})
    items = _section_items("remote", "router.", router, ("aiprotection_enabled",))
    return device_id, _add_config(conn, device_id, ts, items)


def record_inventory(conn, host_id, scan_payload, ts):
    """Map an environ.scan()/topology/exposure payload into device,
    interface, and config_item rows. Returns counts per table. Pure
    mapping over an already-collected payload; no network calls."""
    conn.execute("SAVEPOINT inventory_scan")
    try:
        result = _record(conn, host_id, scan_payload, ts)
        conn.execute("RELEASE inventory_scan")
        return result
    except Exception:
        conn.execute("ROLLBACK TO inventory_scan")
        conn.execute("RELEASE inventory_scan")
        raise


def _record(conn, host_id, scan_payload, ts):
    topo_ids, n_cfg = _map_topology(conn, host_id, scan_payload.get("topology"), ts)
    ids = set(topo_ids)
    gw_id, cfg = _map_gateway(conn, host_id, scan_payload.get("gateway_id"), ts)
    n_cfg += cfg
    if gw_id is not None:
        ids.add(gw_id)
    self_id, n_iface, cfg = _map_self(conn, host_id, scan_payload, ts)
    ids.add(self_id)
    n_cfg += cfg
    for device_id, cfg in (_map_modem(conn, host_id, scan_payload, ts),
                           _map_router(conn, host_id, scan_payload.get("router"), ts)):
        n_cfg += cfg
        if device_id is not None:
            ids.add(device_id)
    return {"device": len(ids), "interface": n_iface, "config_item": n_cfg}
