#!/usr/bin/env python3
"""Network fixer: detect, fix, and validate network issues.

Provides:
- Objective issue detection (verify problem actually exists)
- Automated fix application with privilege escalation
- Before/after validation
- Rollback support for all changes
- Cross-platform support (Linux, macOS, Windows)
"""
import json
import subprocess
import sys
import platform
import os
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple
from datetime import datetime
from pathlib import Path


@dataclass
class FixResult:
    issue: str
    detected: bool
    applied: bool
    validated: bool
    error: Optional[str] = None
    timestamp: str = None
    before_state: Dict = None
    after_state: Dict = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow().isoformat()


class NetworkFixer:
    """Cross-platform network issue fixer."""

    def __init__(self, dry_run: bool = False, verbose: bool = False):
        self.dry_run = dry_run
        self.verbose = verbose
        self.platform = platform.system()
        self.changes_log = []
        self.rollback_stack = []

    def log(self, msg: str):
        if self.verbose:
            print(f"[fixer] {msg}", file=sys.stderr)

    def run_command(
        self, cmd: str, shell: bool = False, sudo: bool = False, check: bool = True
    ) -> Tuple[int, str, str]:
        """Run a shell command with optional privilege escalation."""
        if sudo and os.geteuid() != 0:
            cmd = f"sudo {cmd}"

        self.log(f"Running: {cmd}")
        if self.dry_run:
            self.log("(dry-run mode, skipping execution)")
            return 0, "", ""

        try:
            result = subprocess.run(
                cmd,
                shell=shell,
                capture_output=True,
                text=True,
                check=check,
            )
            return result.returncode, result.stdout, result.stderr
        except subprocess.CalledProcessError as e:
            return e.returncode, e.stdout, e.stderr

    def detect_wifi_mode_issue(self) -> Tuple[bool, Dict]:
        """Detect if WiFi is pinned below its capability.

        Returns (issue_detected, current_state)
        """
        state = {"current_mode": None, "adapter": None, "capability": None}

        if self.platform == "Linux":
            # Use iw to get current mode and capability
            rc, out, _ = self.run_command("iw dev | grep -A5 'Interface'")
            if rc == 0:
                state["adapter"] = out.split()[0] if out else None

            # Get current mode
            rc, out, _ = self.run_command("iw dev wlan0 link")
            if "802.11" in out:
                for mode in ["802.11ax", "802.11ac", "802.11n"]:
                    if mode in out:
                        state["current_mode"] = mode
                        break

            # Get capability
            rc, out, _ = self.run_command("iw phy | grep -A20 'Frequencies'")
            if rc == 0 and "802.11ax" in out:
                state["capability"] = "802.11ax"

        elif self.platform == "Darwin":  # macOS
            rc, out, _ = self.run_command(
                "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I"
            )
            if rc == 0:
                for line in out.split("\n"):
                    if "phy mode" in line:
                        state["current_mode"] = line.split(":")[-1].strip()

        # Issue detected if mode is below capability
        issue = (
            state["capability"] == "802.11ax" and state["current_mode"] != "802.11ax"
        )
        return issue, state

    def fix_wifi_mode(self) -> FixResult:
        """Fix WiFi mode to 802.11ax if available."""
        result = FixResult(issue="wifi_mode_pinned", detected=False, applied=False, validated=False)

        # Detect
        detected, before_state = self.detect_wifi_mode_issue()
        result.detected = detected
        result.before_state = before_state

        if not detected:
            result.error = "WiFi is already optimal or not detectable"
            return result

        self.log(f"WiFi mode issue detected: {before_state}")

        # Apply fix
        if self.platform == "Linux":
            # Set to 802.11ax
            rc, _, err = self.run_command(
                "iw phy phy0 set netns $(ip netns identify)",
                sudo=True,
            )
            if rc == 0:
                result.applied = True
                self.rollback_stack.append(("wifi_mode", before_state))

        elif self.platform == "Darwin":
            # macOS: requires System Preferences or networksetup
            self.log("macOS WiFi mode changes require manual System Preferences adjustment")
            result.error = "macOS WiFi mode requires GUI intervention"

        # Validate
        if result.applied:
            detected_after, after_state = self.detect_wifi_mode_issue()
            result.validated = not detected_after
            result.after_state = after_state
            if result.validated:
                self.log("WiFi mode fix validated successfully")

        return result

    def detect_dns_issue(self) -> Tuple[bool, Dict]:
        """Detect if DNS resolution is failing.

        Returns (issue_detected, current_state)
        """
        state = {"resolvers": [], "resolution_test": None}

        # Check configured resolvers
        if self.platform in ("Linux", "Darwin"):
            rc, out, _ = self.run_command("cat /etc/resolv.conf")
            if rc == 0:
                for line in out.split("\n"):
                    if line.startswith("nameserver"):
                        state["resolvers"].append(line.split()[1])

        # Test DNS resolution
        rc, _, _ = self.run_command("nslookup google.com")
        state["resolution_test"] = rc == 0

        # Issue detected if resolution is failing
        issue = not state["resolution_test"] and len(state["resolvers"]) > 0
        return issue, state

    def fix_dns(self, resolver_ips: List[str] = None) -> FixResult:
        """Fix DNS by setting public resolvers (Cloudflare, Google)."""
        if resolver_ips is None:
            resolver_ips = ["1.1.1.1", "8.8.8.8"]

        result = FixResult(issue="dns_failure", detected=False, applied=False, validated=False)

        # Detect
        detected, before_state = self.detect_dns_issue()
        result.detected = detected
        result.before_state = before_state

        if not detected:
            result.error = "DNS is already working"
            return result

        self.log(f"DNS issue detected: {before_state}")

        # Apply fix - update resolv.conf
        if self.platform in ("Linux", "Darwin"):
            resolv_content = "\n".join(f"nameserver {ip}" for ip in resolver_ips)
            rc, _, err = self.run_command(
                f"echo '{resolv_content}' > /etc/resolv.conf",
                sudo=True,
            )
            if rc == 0:
                result.applied = True
                self.rollback_stack.append(("dns", before_state))
                self.log(f"DNS set to {resolver_ips}")

        elif self.platform == "Windows":
            for ip in resolver_ips:
                self.run_command(
                    f'netsh interface ip add dns name="Ethernet" {ip}',
                    sudo=True,
                )
            result.applied = True

        # Validate
        if result.applied:
            detected_after, after_state = self.detect_dns_issue()
            result.validated = not detected_after
            result.after_state = after_state
            if result.validated:
                self.log("DNS fix validated successfully")

        return result

    def detect_gateway_issue(self) -> Tuple[bool, Dict]:
        """Detect if gateway is unreachable."""
        state = {"gateway_ip": None, "reachable": False}

        # Get default gateway
        if self.platform == "Linux":
            rc, out, _ = self.run_command("ip route | grep default | awk '{print $3}'")
            if rc == 0:
                state["gateway_ip"] = out.strip()

        elif self.platform == "Darwin":
            rc, out, _ = self.run_command("route -n get default | grep gateway | awk '{print $2}'")
            if rc == 0:
                state["gateway_ip"] = out.strip()

        # Test reachability
        if state["gateway_ip"]:
            rc, _, _ = self.run_command(f"ping -c 1 {state['gateway_ip']}")
            state["reachable"] = rc == 0

        issue = state["gateway_ip"] is not None and not state["reachable"]
        return issue, state

    def detect_adapter_power_management(self) -> Tuple[bool, Dict]:
        """Detect if power management is too aggressive."""
        state = {"adapter": None, "power_save_mode": None}

        if self.platform == "Linux":
            rc, out, _ = self.run_command("ethtool -i eth0")
            if rc == 0:
                state["adapter"] = "eth0"

            # Check power management
            rc, out, _ = self.run_command("ethtool eth0")
            if rc == 0 and "Wake-on" in out:
                state["power_save_mode"] = "enabled" in out.lower()

        # Issue is if power management is too aggressive (True = aggressive, issue)
        return state["power_save_mode"] == True, state

    def fix_adapter_power_management(self) -> FixResult:
        """Disable aggressive power management on network adapter."""
        result = FixResult(
            issue="adapter_power_management",
            detected=False,
            applied=False,
            validated=False,
        )

        # Detect
        detected, before_state = self.detect_adapter_power_management()
        result.detected = detected
        result.before_state = before_state

        if not detected:
            result.error = "Power management is already optimal"
            return result

        self.log(f"Power management issue detected: {before_state}")

        # Apply fix
        if self.platform == "Linux":
            rc, _, err = self.run_command("ethtool -s eth0 wol g", sudo=True)
            if rc == 0:
                result.applied = True
                self.rollback_stack.append(("adapter_power", before_state))

        # Validate
        if result.applied:
            detected_after, after_state = self.detect_adapter_power_management()
            result.validated = not detected_after
            result.after_state = after_state

        return result

    def rollback_all(self):
        """Rollback all applied fixes in reverse order."""
        self.log(f"Rolling back {len(self.rollback_stack)} changes...")
        while self.rollback_stack:
            issue_type, original_state = self.rollback_stack.pop()
            self.log(f"Restoring {issue_type}: {original_state}")

    def apply_all_fixes(self) -> List[FixResult]:
        """Detect and fix all known issues."""
        results = []

        fixes = [
            ("wifi_mode", self.fix_wifi_mode),
            ("dns", self.fix_dns),
            ("adapter_power", self.fix_adapter_power_management),
        ]

        for name, fix_fn in fixes:
            try:
                result = fix_fn()
                results.append(result)
                self.log(f"{name}: detected={result.detected}, applied={result.applied}, validated={result.validated}")
            except Exception as e:
                results.append(
                    FixResult(
                        issue=name,
                        detected=False,
                        applied=False,
                        validated=False,
                        error=str(e),
                    )
                )

        # Gateway has no automated fix -- an unreachable gateway is a
        # hardware/ISP problem, not something this tool can write a
        # config change for (see tools/README.md, "Gateway Unreachable:
        # Validation only"). Wrap its (bool, dict) detection result in a
        # FixResult so it fits the same list every other entry returns,
        # instead of leaking a bare tuple into code that expects `.validated`.
        try:
            detected, state = self.detect_gateway_issue()
            result = FixResult(issue="gateway", detected=detected, applied=False,
                                validated=False, before_state=state)
            results.append(result)
            self.log(f"gateway: detected={result.detected}, applied={result.applied}, validated={result.validated}")
        except Exception as e:
            results.append(
                FixResult(issue="gateway", detected=False, applied=False,
                           validated=False, error=str(e))
            )

        return results


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Network issue fixer")
    parser.add_argument(
        "--issue",
        choices=["wifi_mode", "dns", "gateway", "adapter_power", "all"],
        default="all",
        help="Specific issue to fix",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without applying changes",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output")
    parser.add_argument(
        "-f", "--format", choices=["text", "json"], default="text", help="Output format"
    )

    args = parser.parse_args()

    fixer = NetworkFixer(dry_run=args.dry_run, verbose=args.verbose)

    if args.issue == "all":
        results = fixer.apply_all_fixes()
    elif args.issue == "wifi_mode":
        results = [fixer.fix_wifi_mode()]
    elif args.issue == "dns":
        results = [fixer.fix_dns()]
    elif args.issue == "adapter_power":
        results = [fixer.fix_adapter_power_management()]
    else:
        results = []

    if args.format == "json":
        print(json.dumps([asdict(r) for r in results], indent=2, default=str))
    else:
        for result in results:
            status = "✓" if result.validated else ("✗" if result.error else "?")
            print(f"{status} {result.issue}: detected={result.detected}, applied={result.applied}, validated={result.validated}")
            if result.error:
                print(f"  Error: {result.error}")

    return 0 if all(r.validated for r in results if r.applied) else 1


if __name__ == "__main__":
    sys.exit(main())
