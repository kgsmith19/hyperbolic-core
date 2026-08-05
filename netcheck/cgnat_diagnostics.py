"""CGNAT diagnostics: Carrier-Grade NAT detection.

Covers hypothesis #10: CGNAT congestion on ISP side.
"""
import json
from typing import Optional, Dict
from urllib.request import urlopen


def get_wan_ip() -> Optional[str]:
    """Get WAN IP address."""
    try:
        response = urlopen("https://api.ipify.org?format=json", timeout=5)
        data = json.loads(response.read().decode())
        return data.get('ip')
    except Exception:
        return None


def is_cgnat_ip(ip: str) -> bool:
    """Check if IP is in CGNAT range (100.64.0.0 to 100.127.255.255)."""
    if not ip:
        return False
    parts = ip.split('.')
    if len(parts) != 4:
        return False

    try:
        first_octet = int(parts[0])
        second_octet = int(parts[1])

        # CGNAT range: 100.64.0.0 to 100.127.255.255
        if first_octet == 100 and 64 <= second_octet <= 127:
            return True
        return False
    except ValueError:
        return False


class CGNATDiagnostics:
    """Diagnose CGNAT-related issues (#10)."""

    def __init__(self):
        self.id = "cgnat_congestion"
        self.name = "CGNAT Detection"

    def detect_cgnat(self) -> Dict:
        """Check if ISP is using CGNAT (Carrier-Grade NAT)."""
        wan_ip = get_wan_ip()

        if not wan_ip:
            return {
                'detected': False,
                'reason': 'Could not determine WAN IP',
            }

        cgnat_detected = is_cgnat_ip(wan_ip)

        return {
            'detected': cgnat_detected,
            'wan_ip': wan_ip,
            'explanation': (
                'CGNAT detected: ISP uses Carrier-Grade NAT. Your device shares '
                'WAN IP with others on ISP network. Inbound ports may not be accessible.'
                if cgnat_detected
                else 'Not using CGNAT (you have dedicated public IP)'
            ),
            'severity': 'medium' if cgnat_detected else 'low',
        }

    def check_cgnat_implications(self) -> Dict:
        """Describe CGNAT implications for connectivity."""
        result = self.detect_cgnat()

        if result.get('detected'):
            return {
                'cgnat_active': True,
                'implications': [
                    'Inbound ports not accessible from internet',
                    'P2P connections may be restricted',
                    'Port forwarding ineffective',
                    'Outbound port range limited (~1000-65535 minus reserved)',
                ],
                'mitigation': 'Use VPN or contact ISP for dedicated IP',
            }

        return {
            'cgnat_active': False,
            'implications': [],
            'mitigation': None,
        }
