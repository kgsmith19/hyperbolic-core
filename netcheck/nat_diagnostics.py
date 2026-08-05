"""NAT diagnostics: double NAT detection, NAT traversal issues.

Phase 17 diagnostic module (additional to the canonical 15-hypothesis list in
docs/TROUBLESHOOTING.md): modem reverting out of bridge mode (double NAT).
"""
import subprocess
import re
import socket
from typing import Optional, Dict
from urllib.request import urlopen
import json


def get_local_ip() -> Optional[str]:
    """Get local LAN IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def get_wan_ip() -> Optional[str]:
    """Get WAN IP (external IP seen by internet)."""
    try:
        response = urlopen("https://api.ipify.org?format=json", timeout=5)
        data = json.loads(response.read().decode())
        return data.get('ip')
    except Exception:
        return None


def is_private_ip(ip: str) -> bool:
    """Check if IP is in private range (RFC 1918)."""
    if not ip:
        return False
    parts = ip.split('.')
    if len(parts) != 4:
        return False

    try:
        octets = [int(p) for p in parts]
        # 10.0.0.0 – 10.255.255.255
        if octets[0] == 10:
            return True
        # 172.16.0.0 – 172.31.255.255
        if octets[0] == 172 and 16 <= octets[1] <= 31:
            return True
        # 192.168.0.0 – 192.168.255.255
        if octets[0] == 192 and octets[1] == 168:
            return True
        return False
    except ValueError:
        return False


def detect_double_nat() -> Dict:
    """Detect double NAT (WAN IP is private = modem not in bridge mode)."""
    local_ip = get_local_ip()
    wan_ip = get_wan_ip()

    if not local_ip or not wan_ip:
        return {
            'detected': False,
            'reason': 'Could not get IP addresses',
            'local_ip': local_ip,
            'wan_ip': wan_ip,
        }

    double_nat = is_private_ip(wan_ip)

    return {
        'detected': double_nat,
        'local_ip': local_ip,
        'wan_ip': wan_ip,
        'local_is_private': is_private_ip(local_ip),
        'wan_is_private': double_nat,
        'explanation': (
            'Double NAT detected: modem likely reverted to router mode'
            if double_nat
            else 'Single NAT only (normal state)'
        ),
    }


class NATDiagnostics:
    """Diagnose NAT-related issues (Phase 17 module: double NAT)."""

    def __init__(self):
        self.id = "double_nat"
        self.name = "Double NAT Detection"

    def detect_double_nat(self) -> Dict:
        """Check for double NAT via IP address inspection."""
        return detect_double_nat()

    def detect_nat_type(self) -> Dict:
        """Classify NAT type: open, moderate, strict."""
        wan_ip = get_wan_ip()
        if not wan_ip:
            return {'nat_type': 'unknown'}

        if is_private_ip(wan_ip):
            return {
                'nat_type': 'double_nat',
                'severity': 'critical',
                'explanation': 'WAN IP is private; modem in router mode'
            }

        return {
            'nat_type': 'standard_nat',
            'severity': 'normal',
        }

    def get_network_topology(self) -> Dict:
        """Get network topology (devices, IPs, gateways)."""
        local_ip = get_local_ip()
        wan_ip = get_wan_ip()

        result = {
            'local_ip': local_ip,
            'wan_ip': wan_ip,
            'topology': 'unknown',
        }

        if local_ip and wan_ip:
            if is_private_ip(local_ip) and is_private_ip(wan_ip):
                result['topology'] = 'double_nat'
            elif is_private_ip(local_ip) and not is_private_ip(wan_ip):
                result['topology'] = 'single_nat'
            else:
                result['topology'] = 'no_nat'

        return result
