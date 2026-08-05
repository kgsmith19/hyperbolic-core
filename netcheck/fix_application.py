"""Fix application: safe, self-verifying writes to ASUS router / CAX80 modem.

Every write defaults to `dry_run=True` (matching tools/fixer.py's own
convention): it returns what it *would* write without sending anything.
Pass `dry_run=False` to actually write -- and even then, a result is only
ever reported `applied` after a fresh read confirms the change stuck,
through the same environ.router()/environ.modem() functions this project
already relies on for measurement. If the write's HTTP request succeeds
but the read-back doesn't confirm it, the result is `attempted`, never
`applied` -- this project never reports success it can't prove (AGENTS.md).

The ASUS write protocol (NVRAM key names, applyapp.cgi's exact payload
shape) is unverified against live hardware -- see OPEN-ISSUES.md, same
caveat class as probes.parse_airport_info. The CAX80 modem and
local_config have no known automated write path at all, so their apply
methods report `unavailable` rather than inventing one.
"""
import os
from datetime import datetime, timezone
from typing import Callable, Dict, List

from . import environ

_ENV_PREFIX = {"asus_router": "ROUTER", "cax80_modem": "MODEM"}
_DEFAULT_HOST = {"asus_router": "192.168.50.1", "cax80_modem": "192.168.100.1"}


class FixApplier:
    """Applies fixes to ASUS router, CAX80 modem, or local network config."""

    def __init__(self, device_type: str, host: str = None, user: str = None,
                 password: str = None, dry_run: bool = True):
        self.device_type = device_type
        prefix = _ENV_PREFIX.get(device_type)
        if prefix:
            self.host = host or os.environ.get(f"{prefix}_HOST", _DEFAULT_HOST[device_type])
            self.user = user if user is not None else os.environ.get(f"{prefix}_USER")
            self.password = password if password is not None else os.environ.get(f"{prefix}_PASS")
        else:
            self.host, self.user, self.password = host, user, password
        self.dry_run = dry_run
        self.applied_fixes = []

    def _stamp(self, result: Dict) -> Dict:
        result["timestamp"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return result

    def _no_asus_credentials(self, fix_id: str) -> Dict:
        return self._stamp({"fix_id": fix_id, "status": "unavailable",
                             "reason": "no credentials: set ROUTER_USER / ROUTER_PASS in .env"})

    def _write_and_login(self, fix_id: str, nvram: Dict) -> Dict:
        """Log in, write `nvram`, and return (None, error_result) on
        failure or (body, None) on success -- shared by every ASUS write."""
        token, err = environ._asus_login(self.host, self.user, self.password)
        if err:
            return None, self._stamp({"fix_id": fix_id, "status": "fail", "reason": err})
        body, err = environ._asus_set(self.host, token, nvram)
        if err:
            return None, self._stamp({"fix_id": fix_id, "status": "fail", "reason": err})
        return body, None

    def apply_wifi_channel_fix(self, channel: str, bandwidth: str = "80MHz") -> Dict:
        """Write a Wi-Fi channel/bandwidth change to an ASUS router.

        No proven single-key read-back exists for this setting (unlike
        AiProtection's nvram_get(wrs_protect_enable)), so a successful
        write reports `attempted`, not `applied` -- see
        disable_aiprotection for the fully-verified case.
        """
        if self.device_type != "asus_router":
            return self._stamp({"fix_id": "wifi_channel_change", "status": "error",
                                 "reason": "Not connected to ASUS router"})
        if not self.user:
            return self._no_asus_credentials("wifi_channel_change")
        nvram = {"wl1_chanspec": channel, "wl1_bw": bandwidth}
        if self.dry_run:
            return self._stamp({"fix_id": "wifi_channel_change", "status": "dry_run",
                                 "channel": channel, "bandwidth": bandwidth,
                                 "would_write": nvram})

        _, error_result = self._write_and_login("wifi_channel_change", nvram)
        if error_result:
            return error_result

        return self._stamp({"fix_id": "wifi_channel_change", "status": "attempted",
                             "channel": channel, "bandwidth": bandwidth,
                             "requires_reboot": False,
                             "verification_step": "Check signal strength and reconnect -- "
                                                   "no automated read-back exists for this "
                                                   "setting yet"})

    def disable_aiprotection(self) -> Dict:
        """Disable ASUS AiProtection DPI and confirm it with a fresh read.

        The flagship fully-verified case: environ.router() already reads
        nvram_get(wrs_protect_enable), so the write is confirmed by
        calling that same proven read path again, rather than trusting
        the write response.
        """
        if self.device_type != "asus_router":
            return self._stamp({"fix_id": "disable_aiprotection", "status": "error",
                                 "reason": "Not connected to ASUS router"})
        if not self.user:
            return self._no_asus_credentials("disable_aiprotection")
        if self.dry_run:
            return self._stamp({"fix_id": "disable_aiprotection", "status": "dry_run",
                                 "would_write": {"wrs_protect_enable": "0"}})

        _, error_result = self._write_and_login("disable_aiprotection",
                                                  {"wrs_protect_enable": "0"})
        if error_result:
            return error_result

        readback = environ.router(self.host, self.user, self.password)
        if readback["state"] != "ok":
            return self._stamp({"fix_id": "disable_aiprotection", "status": "attempted",
                                 "reason": f"write sent but read-back failed: "
                                           f"{readback.get('reason')}"})
        if readback["aiprotection_enabled"]:
            return self._stamp({"fix_id": "disable_aiprotection", "status": "attempted",
                                 "reason": "write sent but read-back still shows "
                                           "AiProtection enabled"})

        return self._stamp({"fix_id": "disable_aiprotection", "status": "applied",
                             "verified_by_readback": True,
                             "warning": "IDS/DPI/filtering now disabled",
                             "requires_reboot": True,
                             "verification_step": "Test Claude Code after reboot"})

    def disable_qos(self) -> Dict:
        """Write-attempt only -- no proven read-back key exists for QoS
        state, so a successful write reports `attempted`, not `applied`."""
        if self.device_type != "asus_router":
            return self._stamp({"fix_id": "disable_qos", "status": "error",
                                 "reason": "Not connected to ASUS router"})
        if not self.user:
            return self._no_asus_credentials("disable_qos")
        if self.dry_run:
            return self._stamp({"fix_id": "disable_qos", "status": "dry_run",
                                 "would_write": {"qos_enable": "0"}})

        _, error_result = self._write_and_login("disable_qos", {"qos_enable": "0"})
        if error_result:
            return error_result

        return self._stamp({"fix_id": "disable_qos", "status": "attempted",
                             "requires_reboot": True})

    def restart_device(self) -> Dict:
        """Request a reboot. There's no known write path for the CAX80
        modem or local_config, and a reboot can't be synchronously
        confirmed even on the router it does target -- this never reports
        more than `requested`."""
        if self.device_type != "asus_router":
            return self._stamp({"action": "restart", "device": self.device_type,
                                 "status": "unavailable",
                                 "reason": f"no known automated restart path for "
                                           f"{self.device_type}"})
        if not self.user:
            return self._stamp({"action": "restart", "device": self.device_type,
                                 "status": "unavailable",
                                 "reason": "no credentials: set ROUTER_USER / ROUTER_PASS in .env"})
        if self.dry_run:
            return self._stamp({"action": "restart", "device": self.device_type,
                                 "status": "dry_run"})

        _, error_result = self._write_and_login("restart_device", {"action_mode": "reboot"})
        if error_result:
            error_result["action"] = "restart"
            error_result["device"] = self.device_type
            return error_result

        return self._stamp({"action": "restart", "device": self.device_type,
                             "status": "requested", "wait_time_seconds": 180})

    def get_device_status(self) -> Dict:
        """Query current device status by delegating to environ.router()/
        environ.modem() -- the same functions this project already
        proves out for measurement, not a second parallel notion of
        device state."""
        if self.device_type == "asus_router":
            if not self.user:
                return self._stamp({"device_type": self.device_type, "status": "unavailable",
                                     "reason": "no credentials: set ROUTER_USER / ROUTER_PASS "
                                               "in .env"})
            status = environ.router(self.host, self.user, self.password)
        elif self.device_type == "cax80_modem":
            if not self.user:
                return self._stamp({"device_type": self.device_type, "status": "unavailable",
                                     "reason": "no credentials: set MODEM_USER / MODEM_PASS "
                                               "in .env"})
            status = environ.modem(self.host, self.user, self.password)
        else:
            return self._stamp({"device_type": self.device_type, "status": "unavailable",
                                 "reason": "local_config has no admin API to query"})

        return self._stamp({"device_type": self.device_type,
                             "status": "connected" if status["state"] == "ok" else status["state"],
                             "can_read_metrics": status["state"] == "ok",
                             "detail": status})


def apply_fix_sequence(fixes: List, device_handlers: Dict[str, Callable]) -> List[Dict]:
    """Apply a sequence of fixes with dependency resolution."""
    results = []
    requires_reboot = False

    for fix in fixes:
        if fix.category not in device_handlers:
            results.append({"fix_id": fix.id, "status": "skipped", "reason": "No handler"})
            continue

        handler = device_handlers[fix.category]
        result = handler(fix)

        results.append(result)

        if result.get("requires_reboot"):
            requires_reboot = True

    if requires_reboot:
        results.append({
            "action": "reboot_recommended",
            "reason": "Some fixes require reboot to take effect",
            "next_step": "Restart device and wait 3 minutes"
        })

    return results
