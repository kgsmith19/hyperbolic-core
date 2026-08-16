"""Real capture/restore round trips against the actual `tools/fix_*.sh`
scripts (05-f section 4.5's Finding 18) -- not a Python reimplementation of
their logic. `iw`/`ethtool`/`systemctl` are not installed in this sandbox,
and even a real device write would be unsafe without real hardware, so this
runs the unmodified bash scripts with only the external tools on PATH
replaced by stand-ins that log their call and answer from a fixture (a
`sudo` stand-in is included too: this container's real `sudo` reads a
locked-down `secure_path` that ignores our temp PATH entirely, verified
empirically before writing this file). NETWORK_CHECKER_STATE_DIR and (DNS only)
NETWORK_CHECKER_DNS_DROPIN point the scripts at a temp directory instead of real
/etc paths -- both are the scripts' own overridable variables already, not
a test-only patch. Every real branch these scripts now have --
capture-once-keep, drop-in existed vs. did not, tx-power restored to a real
pinned value vs. 'auto' with nothing captured, power_save/WoL restored
independently -- is exercised end to end: real script, real subprocess,
stubbed device layer.
"""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

_SUDO = "#!/bin/bash\nexec \"$@\"\n"
_SYSTEMCTL = "#!/bin/bash\nexit 0\n"
_LS = (
    "#!/bin/bash\n"
    'if [ "$*" = "/sys/class/net/" ]; then\n'
    '    echo "lo"\n'
    '    echo "${FAKE_ADAPTER:-wlan0}"\n'
    "    exit 0\n"
    "fi\n"
    'exec /bin/ls "$@"\n'
)
_IW = (
    "#!/bin/bash\n"
    '[ -n "$IW_LOG" ] && echo "iw $*" >> "$IW_LOG"\n'
    'case "$*" in\n'
    '  *"get power_save") echo "Power save: ${IW_POWER_SAVE:-on}" ;;\n'
    '  *" info") echo "Interface x"; echo "txpower ${IW_TXPOWER:-20.00} dBm" ;;\n'
    "esac\n"
    "exit 0\n"
)
_ETHTOOL = (
    "#!/bin/bash\n"
    '[ -n "$ETHTOOL_LOG" ] && echo "ethtool $*" >> "$ETHTOOL_LOG"\n'
    'if [ "$1" = "-s" ]; then exit 0; fi\n'
    'echo "Settings for $1:"\n'
    'echo "        Wake-on: ${ETHTOOL_WOL:-d}"\n'
    "exit 0\n"
)


def _write_stub(path, content):
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _stub_bin(tmp):
    """A temp bin/ directory standing in for `iw`, `ethtool`, `sudo`,
    `systemctl`, and (only for the `/sys/class/net/` listing) `ls`."""
    bindir = Path(tmp) / "bin"
    bindir.mkdir(exist_ok=True)
    for name, content in (("sudo", _SUDO), ("systemctl", _SYSTEMCTL),
                          ("ls", _LS), ("iw", _IW), ("ethtool", _ETHTOOL)):
        _write_stub(bindir / name, content)
    return bindir


def _run_script(script, args, tmp, extra_env=None):
    env = dict(os.environ)
    env["PATH"] = f"{_stub_bin(tmp)}:{env['PATH']}"
    env["NETWORK_CHECKER_STATE_DIR"] = str(Path(tmp) / "state")
    env.update(extra_env or {})
    return subprocess.run(
        ["bash", str(REPO / "tools" / script), *args],
        capture_output=True, text=True, cwd=REPO, env=env, timeout=30)


class DnsDropInCaptureRestoreTest(unittest.TestCase):
    """fix_dns.sh's drop-in half: capture_state/restore_state, real bash,
    real files -- only NETWORK_CHECKER_DNS_DROPIN points away from /etc."""

    def test_capture_then_restore_when_no_dropin_existed_removes_it(self):
        """No pre-existing file: the change writes one, restore must
        remove it -- never `rm -f` something that was never captured."""
        with tempfile.TemporaryDirectory() as tmp:
            dropin = Path(tmp) / "network-checker.conf"
            env = {"NETWORK_CHECKER_DNS_DROPIN": str(dropin)}

            cap = _run_script("fix_dns.sh", ["--capture-state"], tmp, env)
            self.assertEqual(cap.returncode, 0, cap.stderr)

            dropin.write_text("[Resolve]\nDNS=1.1.1.1 8.8.8.8\n")  # the change's own write
            self.assertTrue(dropin.exists())

            res = _run_script("fix_dns.sh", ["--restore"], tmp, env)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertFalse(dropin.exists(),
                             "drop-in that did not exist before the change must be removed")

    def test_capture_then_restore_preserves_a_real_pre_existing_dropin(self):
        """Finding 18's exact bug: an operator's own file must come back
        byte-for-byte, not be deleted by an unconditional rm -f."""
        with tempfile.TemporaryDirectory() as tmp:
            dropin = Path(tmp) / "network-checker.conf"
            original = "[Resolve]\nDNS=10.0.0.53\n# operator's own config\n"
            dropin.write_text(original)
            env = {"NETWORK_CHECKER_DNS_DROPIN": str(dropin)}

            cap = _run_script("fix_dns.sh", ["--capture-state"], tmp, env)
            self.assertEqual(cap.returncode, 0, cap.stderr)

            dropin.write_text("[Resolve]\nDNS=1.1.1.1 8.8.8.8\n")  # the change overwrites it

            res = _run_script("fix_dns.sh", ["--restore"], tmp, env)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(dropin.read_text(), original,
                             "the operator's real prior content must come back exactly")

    def test_capture_is_kept_on_a_second_run_not_overwritten(self):
        """Capture-once-keep: a second capture must not clobber the first
        (true) baseline with already-modified state."""
        with tempfile.TemporaryDirectory() as tmp:
            dropin = Path(tmp) / "network-checker.conf"
            original = "[Resolve]\nDNS=10.0.0.53\n"
            dropin.write_text(original)
            env = {"NETWORK_CHECKER_DNS_DROPIN": str(dropin)}

            _run_script("fix_dns.sh", ["--capture-state"], tmp, env)
            dropin.write_text("[Resolve]\nDNS=1.1.1.1 8.8.8.8\n")
            second = _run_script("fix_dns.sh", ["--capture-state"], tmp, env)
            self.assertEqual(second.returncode, 0, second.stderr)

            dropin.write_text("something else entirely")
            res = _run_script("fix_dns.sh", ["--restore"], tmp, env)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(dropin.read_text(), original,
                             "restore must use the FIRST capture, not the second")

    def test_restore_with_no_capture_and_no_backup_fails_loudly(self):
        """No .bak, no captured state, no netsh on Linux: must refuse, not
        silently do nothing or delete something unrelated."""
        with tempfile.TemporaryDirectory() as tmp:
            env = {"NETWORK_CHECKER_DNS_DROPIN": str(Path(tmp) / "network-checker.conf")}
            res = _run_script("fix_dns.sh", ["--restore"], tmp, env)
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("nothing to restore", res.stderr)


class WifiTxpowerCaptureRestoreTest(unittest.TestCase):
    """fix_wifi_mode.sh: capture the real live tx-power, restore to that
    exact value via `iw ... set txpower fixed <mBm>` -- not the forward
    fix's own `set txpower auto` command."""

    def _iw_log(self, tmp):
        return Path(tmp) / "iw.log"

    def test_restore_repins_the_captured_dbm_value_not_auto(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = self._iw_log(tmp)
            env = {"IW_TXPOWER": "5.00", "IW_LOG": str(log), "FAKE_ADAPTER": "wlan0"}

            cap = _run_script("fix_wifi_mode.sh", ["--capture-state"], tmp, env)
            self.assertEqual(cap.returncode, 0, cap.stderr)

            res = _run_script("fix_wifi_mode.sh", ["--restore"], tmp, env)
            self.assertEqual(res.returncode, 0, res.stderr)

            calls = log.read_text()
            self.assertIn("set txpower fixed 500", calls,
                         "5.00 dBm must restore as 500 mBm, not 'auto'")
            self.assertNotIn("set txpower auto", calls)

    def test_restore_with_no_capture_falls_back_to_auto_not_a_crash(self):
        """Never captured (e.g. this script run standalone, bypassing the
        change lifecycle entirely): the honest fallback is 'auto', not a
        fabricated number."""
        with tempfile.TemporaryDirectory() as tmp:
            log = self._iw_log(tmp)
            env = {"IW_LOG": str(log)}
            res = _run_script("fix_wifi_mode.sh", ["--restore"], tmp, env)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertIn("set txpower auto", log.read_text())

    def test_capture_is_kept_on_a_second_run_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            env1 = {"IW_TXPOWER": "5.00", "FAKE_ADAPTER": "wlan0"}
            _run_script("fix_wifi_mode.sh", ["--capture-state"], tmp, env1)

            env2 = {"IW_TXPOWER": "20.00", "FAKE_ADAPTER": "wlan0"}
            second = _run_script("fix_wifi_mode.sh", ["--capture-state"], tmp, env2)
            self.assertEqual(second.returncode, 0, second.stderr)

            log = self._iw_log(tmp)
            env3 = dict(env2, IW_LOG=str(log))
            _run_script("fix_wifi_mode.sh", ["--restore"], tmp, env3)
            self.assertIn("set txpower fixed 500", log.read_text(),
                         "restore must use the FIRST captured value (5.00 dBm)")


class AdapterPowerCaptureRestoreTest(unittest.TestCase):
    """fix_adapter_power.sh: capture power_save AND Wake-on-LAN together,
    restore both -- the WoL half Finding 18 named as never restored."""

    def test_restore_puts_back_both_power_save_and_a_non_default_wol_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            iw_log, eth_log = Path(tmp) / "iw.log", Path(tmp) / "ethtool.log"
            env = {"IW_POWER_SAVE": "on", "ETHTOOL_WOL": "u",  # 'u': unicast wake, not the
                   "FAKE_ADAPTER": "wlan0",                     # 'g' the fix itself sets
                   "IW_LOG": str(iw_log), "ETHTOOL_LOG": str(eth_log)}

            cap = _run_script("fix_adapter_power.sh", ["--capture-state"], tmp, env)
            self.assertEqual(cap.returncode, 0, cap.stderr)

            res = _run_script("fix_adapter_power.sh", ["--restore"], tmp, env)
            self.assertEqual(res.returncode, 0, res.stderr)

            self.assertIn("dev wlan0 set power_save on", iw_log.read_text())
            self.assertIn("-s wlan0 wol u", eth_log.read_text(),
                         "must restore the ORIGINAL WoL flag ('u'), not the fix's own 'g'")

    def test_restore_with_no_capture_fails_loudly_rather_than_guessing(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = _run_script("fix_adapter_power.sh", ["--restore"], tmp, {})
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("no captured", res.stderr)

    def test_capture_is_kept_on_a_second_run_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            env1 = {"IW_POWER_SAVE": "on", "ETHTOOL_WOL": "u", "FAKE_ADAPTER": "wlan0"}
            _run_script("fix_adapter_power.sh", ["--capture-state"], tmp, env1)

            env2 = {"IW_POWER_SAVE": "off", "ETHTOOL_WOL": "g", "FAKE_ADAPTER": "wlan0"}
            second = _run_script("fix_adapter_power.sh", ["--capture-state"], tmp, env2)
            self.assertEqual(second.returncode, 0, second.stderr)

            eth_log = Path(tmp) / "ethtool.log"
            env3 = dict(env2, ETHTOOL_LOG=str(eth_log))
            _run_script("fix_adapter_power.sh", ["--restore"], tmp, env3)
            self.assertIn("-s wlan0 wol u", eth_log.read_text(),
                         "restore must use the FIRST captured WoL flag ('u')")


if __name__ == "__main__":
    unittest.main()
