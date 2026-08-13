"""The three fix scripts, ported into seeded change-lifecycle templates
(05-f section 4.5). The scripts stay as executors -- `change_cmd` below
still invokes each one exactly as it already exists (plus one new flag,
`--restore`, on the inverse side) -- while the lifecycle in change.py
remains the only sanctioned entry point: propose, dry-run, interactive
approval, apply, verify, and (on a failed verify) automatic rollback.
rank.py points its fix text at these instead of naming a raw invocation.

This file closes an independent security review's Finding 18 (P1): dry-run
and verification were not probative, and the inverses were not exactly
reversible. Four concrete gaps, one per template plus one shared:

1. **No real pre-state capture.** Every `inverse_cmd` below used to be a
   static command string with no idea what the device's value actually was
   before the change ran -- it could only re-assert a value this script
   considered safe, or delete a path outright, never "put back what was
   really there." Fixed not here but in the scripts themselves: each of
   `tools/fix_dns.sh`, `tools/fix_wifi_mode.sh`, `tools/fix_adapter_power.sh`
   grew a `capture_state`/`restore_state` pair (`--capture-state` /
   `--restore` flags) that captures the real, concrete value the FIRST time
   the script's forward path runs (capture-once-keep: change.py's `apply()`
   calls `change_cmd` exactly once per approved row, so the first capture of
   a run is the only one that is ever the true pre-change baseline) and
   restores exactly that value on request. `inverse_cmd` below is now just
   `<script> --restore` -- the restorative logic lives with the script that
   knows the device, not duplicated here as a second static guess. See each
   script's own header comment for its capture/restore design.

   This was the cleanest shape for THIS codebase: `change_cmd`/`inverse_cmd`
   are plain TEXT columns (schema.sql) that `rank._fix()` also embeds
   verbatim into a printed `change propose` invocation, so they have to stay
   simple, static, human-readable command strings -- not a place to put
   captured data. A script that captures its own state right before it
   mutates, to a fixed path on disk, needs no change to that shape at all.

2. **Wi-Fi's inverse duplicated the change's own mechanism.**
   `fix_wifi_mode.sh`'s only real device write was `iw phy phy0 set txpower
   auto`, and the inverse was the identical command -- "undo" and "the
   change's own first attempted fix" were the same string, so a rollback
   never restored whatever tx-power value was really there before. Fixed:
   `restore_state` re-pins to the captured dBm value via `iw phy phy0 set
   txpower fixed <mBm>`, falling back to `auto` only when nothing was ever
   captured (e.g. the script run standalone, outside the change lifecycle).

3. **Adapter-power's inverse missed Wake-on-LAN.** `fix_adapter_power.sh`
   enables WoL as part of applying the change, but the old inverse only
   turned `power_save` back on -- WoL stayed armed forever, even after a
   "rollback". Fixed: `restore_state` restores both captured values,
   `power_save` and the WoL flag letters, independently.

4. **DNS's inverse could delete a file it never created.** The
   systemd-resolved branch used to `rm -f` its drop-in unconditionally on
   rollback -- destroying an operator's own pre-existing
   `/etc/systemd/resolved.conf.d/network-checker.conf` just as readily as
   one this script wrote itself. Fixed: `capture_state` records the real
   prior bytes if the file already existed (or the fact that it did not);
   `restore_state` writes those bytes back, or removes the file only when
   capture proved it was genuinely new. The pre-existing `/etc/resolv.conf`
   `.bak` mechanism was already exact and is untouched.

**Verification weakness**, the review's other half of Finding 18:
`wifi_mode` and `adapter_power` both used to verify success with a bare
`gw:ok` -- gateway reachability says nothing about tx-power or power
management, so a change that silently did nothing still "verified".
Fixed: `netcheck/linux_adapter_probes.py` adds two real, property-specific
probes -- `wifi_txpower` (live tx power vs. this radio's own regulatory
ceiling for its current channel) and `adapter_power` (power_save off *and*
WoL armed together) -- wired into `probes.sample()` as
`wifi_txpower_state` / `adapter_power_state` so change.py's existing,
UNMODIFIED `_run_verify` (which reads `<field>_state` straight off that
row) can express `verify_probe: "wifi_txpower:ok"` /
`"adapter_power:ok"` with no change to `_run_verify` itself. Making that
wiring load-bearing required one small, deliberately narrow addition
outside this file: two nullable columns on schema.sql's `samples` table
(`wifi_txpower_state`, `adapter_power_state`), the DDL twin of
`probes.sample()`'s own row shape and the reason `wifi_signal` /
`wifi_channel` / etc. exist there already -- `store.py`'s existing
`_migrate()` picks them up on an existing on-disk database with no code
change. Every OTHER regular `watch`/`probe` tick now also carries these
two fields for free, `unavailable` off Linux or with no matching adapter.

**What change.py's `test()` would still need, to fully consume all of
this (flagged, not implemented here -- change.py is out of this change's
file scope)**:
  - `test()`'s dry-run currently measures `verify_probe` once and prints
    STATIC command-text strings ("would run: X ... inverse on failed
    verify: Y") -- it never calls `change_cmd`/`inverse_cmd` at all (by
    design: dry-run must never mutate), so it cannot show the CONCRETE
    pre-change value captured above as dry-run evidence. A future `test()`
    could invoke `<change_cmd> --capture-state` (read-only from the
    device's perspective -- it only ever reads current state and writes to
    `$NETCHECK_STATE_DIR`, a path outside anything `verify_probe` measures)
    and fold the result into `dry_run_output`, giving the operator the real
    "here is what will be restored if this fails" evidence before they
    approve, not just a command name.
  - `_run_verify` reuses the SAME `verify_probe` string to check both the
    forward apply (want: at tx-power ceiling / power-save off) and, on a
    failed verify, the rollback (want: whatever the ORIGINAL captured value
    actually was, which may itself have been pinned low, or already had
    power-save on). A probe defined only as "matches the forward goal"
    reads a *correct* rollback back to a genuinely-pinned original as a
    verify failure. `dns_public:ok` already has the identical shape of this
    problem -- this change does not introduce a new one, but does not fix
    the pre-existing one either. Closing it for real needs change.py to
    carry a per-direction verify expression (or compare against the
    captured state file directly) rather than one static string reused for
    both directions.
"""

TEMPLATES = {
    "dns": {
        "cause": "router_dns",
        "title": "Switch to public DNS resolvers",
        "change_cmd": "tools/fix_dns.sh",
        "inverse_cmd": "tools/fix_dns.sh --restore",
        "verify_probe": "dns_public:ok",
    },
    "wifi_mode": {
        "cause": "wifi_mode_pinned",
        "title": "Reset WiFi mode to its full capability (802.11ax)",
        "change_cmd": "tools/fix_wifi_mode.sh",
        "inverse_cmd": "tools/fix_wifi_mode.sh --restore",
        "verify_probe": "wifi_txpower:ok",
    },
    "adapter_power": {
        "cause": "radio_drops",
        "title": "Disable adapter power management",
        "change_cmd": "tools/fix_adapter_power.sh",
        "inverse_cmd": "tools/fix_adapter_power.sh --restore",
        "verify_probe": "adapter_power:ok",
    },
}
