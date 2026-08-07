"""Modem/DOCSIS diagnostics: signal levels, stability, bridge mode verification.

Phase 16 diagnostic module (additional to the canonical 15-hypothesis list in
netcheck/docs/TROUBLESHOOTING.md): DOCSIS/coax signal instability on cable modem.
"""
import os
import subprocess
import re
import socket
from typing import Dict, Optional, Tuple
from urllib.request import urlopen
from urllib.error import URLError
import json

from .environ import MODEM_HOST_DEFAULT


def get_modem_host() -> str:
    """Modem LAN IP: MODEM_HOST from .env, same default environ.modem() uses."""
    return os.environ.get("MODEM_HOST", MODEM_HOST_DEFAULT)


def get_modem_status_page(ip: str = None, timeout: int = 5) -> Optional[Dict]:
    """Fetch modem status page (NETGEAR CAX80, other DOCSIS modems)."""
    ip = ip or get_modem_host()
    urls = [
        f"http://{ip}/api/devices",
        f"http://{ip}/RgConnect.asp",
        f"http://{ip}/",
    ]

    for url in urls:
        try:
            response = urlopen(url, timeout=timeout)
            text = response.read().decode('utf-8', errors='ignore')

            # Extract DOCSIS levels from common modem pages
            data = {
                'url': url,
                'accessible': True,
                'raw': text[:500],  # First 500 chars for parsing
            }

            # Parse downstream/upstream power levels
            ds_power = re.search(r'(?:Downstream Power|DS Power)[:\s]*(-?\d+\.?\d*)\s*dBm', text, re.I)
            us_power = re.search(r'(?:Upstream Power|US Power)[:\s]*(\d+\.?\d*)\s*dBm', text, re.I)
            snr = re.search(r'(?:SNR|Signal to Noise)[:\s]*(\d+\.?\d*)\s*dB', text, re.I)

            if ds_power:
                data['downstream_power_dbm'] = float(ds_power.group(1))
            if us_power:
                data['upstream_power_dbm'] = float(us_power.group(1))
            if snr:
                data['snr_db'] = float(snr.group(1))

            return data
        except (URLError, socket.timeout, Exception):
            continue

    return None


def check_bridge_mode(timeout: int = 5) -> Dict:
    """Check if modem is in bridge mode (DHCP disabled on modem)."""
    statuses = {
        'bridge_mode_detected': None,
        'method': 'unknown',
        'evidence': '',
    }

    # Method 1: Check if modem responds on its configured IP
    try:
        response = urlopen(f"http://{get_modem_host()}/", timeout=timeout)
        statuses['modem_admin_reachable'] = True
        statuses['method'] = 'admin_page'
    except (URLError, socket.timeout):
        # If unreachable, likely in bridge mode (or different IP)
        statuses['modem_admin_reachable'] = False

    # Method 2: Check routing table for double gateway
    try:
        result = subprocess.run(
            ["ip", "route", "show"],
            capture_output=True, text=True, timeout=5
        )
        gateways = re.findall(r'via (\S+)', result.stdout)
        if len(set(gateways)) > 1:
            statuses['multiple_gateways'] = True
            statuses['bridge_mode_detected'] = False
            statuses['evidence'] = f"Multiple gateways detected: {set(gateways)}"
        else:
            statuses['multiple_gateways'] = False
    except Exception:
        pass

    return statuses


def detect_wan_ip() -> Optional[str]:
    """Get WAN IP address to detect NAT/double NAT."""
    try:
        response = urlopen("https://api.ipify.org?format=json", timeout=5)
        data = json.loads(response.read().decode())
        return data.get('ip')
    except Exception:
        return None


class ModemDiagnostics:
    """Diagnose modem/DOCSIS issues (Phase 16 module)."""

    def __init__(self):
        self.id = "modem_docsis_instability"
        self.name = "Modem/DOCSIS Signal Stability"
        self.modem_ip = get_modem_host()

    def detect_modem_reachable(self) -> Dict:
        """Check if modem status page is accessible."""
        try:
            subprocess.run(
                ["ping", "-c", "1", self.modem_ip],
                capture_output=True, timeout=3
            )
            return {'reachable': True, 'ip': self.modem_ip}
        except Exception:
            return {'reachable': False, 'ip': self.modem_ip}

    def detect_signal_levels(self) -> Dict:
        """Check DOCSIS signal levels (downstream/upstream power, SNR)."""
        status = self.detect_modem_reachable()
        if not status.get('reachable'):
            return {'detected': False, 'reason': 'Modem not reachable'}

        page = get_modem_status_page(self.modem_ip)
        if not page:
            return {'detected': False, 'reason': 'Status page inaccessible'}

        result = {
            'detected': True,
            'downstream_power_dbm': page.get('downstream_power_dbm'),
            'upstream_power_dbm': page.get('upstream_power_dbm'),
            'snr_db': page.get('snr_db'),
        }

        # Warn if levels out of spec (typical: -15 to +15 dBm)
        if page.get('downstream_power_dbm'):
            ds = page['downstream_power_dbm']
            if ds < -15 or ds > 15:
                result['warning'] = f"Downstream power {ds} dBm out of spec (-15 to +15)"

        return result

    def detect_bridge_mode(self) -> Dict:
        """Check if modem is properly in bridge mode (DHCP off)."""
        return check_bridge_mode()

    def detect_uncorrectable_codewords(self) -> Dict:
        """Check for uncorrectable DOCSIS errors (sign of signal degradation)."""
        page = get_modem_status_page(self.modem_ip)
        if not page:
            return {'detected': False, 'reason': 'Cannot read modem status'}

        # Look for error counts in page
        errors = re.search(r'[Uu]ncorrectable[:\s]*(\d+)', page.get('raw', ''))
        if errors:
            count = int(errors.group(1))
            if count > 0:
                return {
                    'detected': True,
                    'uncorrectable_errors': count,
                    'warning': f'{count} uncorrectable codewords = signal degradation'
                }

        return {'detected': False, 'uncorrectable_errors': 0}
