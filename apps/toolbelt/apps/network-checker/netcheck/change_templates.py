"""The three fix scripts, ported into seeded change-lifecycle templates
(05-f section 4.5). The scripts stay as executors -- `change_cmd` below
invokes each one exactly as it already exists, unmodified -- while the
lifecycle in change.py becomes the only sanctioned entry point: propose,
dry-run, interactive approval, apply, verify, and (on a failed verify)
automatic rollback. rank.py points its fix text at these instead of naming
a raw invocation.

Each `inverse_cmd` reverses the real, existing mechanism the matching
script uses, not a fabricated one:

- dns: `fix_dns.sh` backs up `/etc/resolv.conf` to `.bak` before writing
  (`backup_dns`), or drops a systemd-resolved snippet, or calls Windows
  `netsh`. The inverse restores whichever of those three the script
  actually used.
- adapter_power: `fix_adapter_power.sh` disables `power_save` on the
  adapter it detects (`disable_power_management`); the inverse reuses the
  identical adapter-detection shell (`find_adapter`) and turns it back on.
- wifi_mode: `fix_wifi_mode.sh`'s only real device write is an idempotent
  `iw phy phy0 set txpower auto` (`apply_fix`) -- it captures no prior
  value anywhere, so there is nothing concrete to restore. The honest
  choice, and the one this template makes, is to re-assert that same safe
  value rather than invent a "previous mode" the script itself never
  records. Flagged: 05-f section 4.5's table describes this inverse as
  "restore the prior mode captured by change test detection", which
  `fix_wifi_mode.sh` as it stands cannot support without adding new
  device-write capability to that script -- out of scope for this issue.
"""

TEMPLATES = {
    "dns": {
        "cause": "router_dns",
        "title": "Switch to public DNS resolvers",
        "change_cmd": "tools/fix_dns.sh",
        "inverse_cmd": (
            "bash -c 'if [ -f /etc/resolv.conf.bak ]; then "
            "sudo mv /etc/resolv.conf.bak /etc/resolv.conf; "
            "elif [ -f /etc/systemd/resolved.conf.d/network-checker.conf ]; then "
            "sudo rm -f /etc/systemd/resolved.conf.d/network-checker.conf "
            "&& sudo systemctl restart systemd-resolved; "
            "else netsh interface ip set dns name=\"Ethernet\" dhcp; fi'"
        ),
        "verify_probe": "dns_public:ok",
    },
    "wifi_mode": {
        "cause": "wifi_mode_pinned",
        "title": "Reset WiFi mode to its full capability (802.11ax)",
        "change_cmd": "tools/fix_wifi_mode.sh",
        "inverse_cmd": "sudo iw phy phy0 set txpower auto",
        "verify_probe": "gw:ok",
    },
    "adapter_power": {
        "cause": "radio_drops",
        "title": "Disable adapter power management",
        "change_cmd": "tools/fix_adapter_power.sh",
        "inverse_cmd": (
            "bash -c 'a=$(ls /sys/class/net 2>/dev/null | grep -E \"wlan|wifi\" | head -1); "
            "[ -z \"$a\" ] && a=$(ls /sys/class/net 2>/dev/null | grep -E \"eth|eno|enp\" | head -1); "
            "iw dev \"$a\" set power_save on'"
        ),
        "verify_probe": "gw:ok",
    },
}
