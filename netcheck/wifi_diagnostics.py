"""WiFi radio-layer diagnostics: band-steering, channel stability, interference.

Phase 15 diagnostic module, covering canonical hypothesis #15 ("WiFi/DFS" in
docs/TROUBLESHOOTING.md): WiFi radio-layer instability (band steering, DFS
channel switches, WiFi 7 Multi-Link Operation quirks).
"""
import subprocess
import re
import platform
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta


def get_wifi_interface() -> Optional[str]:
    """Detect WiFi interface name (platform-specific)."""
    system = platform.system()
    if system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["networksetup", "-listallhardwareports"],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.split('\n'):
                if 'Wi-Fi' in line or 'AirPort' in line:
                    return line.split(': ')[-1] if ': ' in line else None
        except Exception:
            pass
    elif system == "Linux":
        try:
            result = subprocess.run(
                ["iwconfig"], capture_output=True, text=True, timeout=5
            )
            match = re.search(r'^(\w+)\s+IEEE', result.stdout, re.MULTILINE)
            if match:
                return match.group(1)
        except Exception:
            pass
    elif system == "Windows":
        return "WiFi"  # netsh wlan commands
    return None


def get_current_ssid_and_bssid() -> Tuple[Optional[str], Optional[str]]:
    """Get current WiFi SSID and BSSID (MAC address of AP)."""
    system = platform.system()
    ssid = None
    bssid = None

    if system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-I"],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.split('\n'):
                if 'SSID:' in line:
                    ssid = line.split('SSID: ')[-1].strip()
                if 'BSSID:' in line:
                    bssid = line.split('BSSID: ')[-1].strip()
        except Exception:
            pass
    elif system == "Linux":
        try:
            result = subprocess.run(
                ["iwconfig"], capture_output=True, text=True, timeout=5
            )
            if 'ESSID' in result.stdout:
                match = re.search(r'ESSID:"([^"]*)"', result.stdout)
                if match:
                    ssid = match.group(1)
            if 'Access Point' in result.stdout:
                match = re.search(r'Access Point: ([0-9A-Fa-f:]{17})', result.stdout)
                if match:
                    bssid = match.group(1).upper()
        except Exception:
            pass
    elif system == "Windows":
        try:
            result = subprocess.run(
                ["netsh", "wlan", "show", "interfaces"],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.split('\n'):
                if 'SSID' in line and ':' in line:
                    ssid = line.split(':', 1)[-1].strip()
                if 'BSSID' in line and ':' in line:
                    bssid = line.split(':', 1)[-1].strip().upper()
        except Exception:
            pass

    return ssid, bssid


def get_signal_strength() -> Optional[int]:
    """Get WiFi signal strength in dBm (negative value, closer to 0 is stronger)."""
    system = platform.system()

    if system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-I"],
                capture_output=True, text=True, timeout=5
            )
            match = re.search(r'agrctlrssi: (-\d+)', result.stdout)
            if match:
                return int(match.group(1))
        except Exception:
            pass
    elif system == "Linux":
        try:
            result = subprocess.run(
                ["iwconfig"], capture_output=True, text=True, timeout=5
            )
            match = re.search(r'Signal level[=:]([^d]*)dBm', result.stdout)
            if match:
                return int(match.group(1).strip())
        except Exception:
            pass
    elif system == "Windows":
        try:
            result = subprocess.run(
                ["netsh", "wlan", "show", "interfaces"],
                capture_output=True, text=True, timeout=5
            )
            match = re.search(r'Signal\s+: (\d+)%', result.stdout)
            if match:
                percent = int(match.group(1))
                return -100 + percent  # Convert percentage to approximate dBm
        except Exception:
            pass

    return None


def get_current_channel() -> Optional[int]:
    """Get current WiFi channel number."""
    system = platform.system()

    if system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-I"],
                capture_output=True, text=True, timeout=5
            )
            match = re.search(r'last tx rate: (\d+)', result.stdout)
            if not match:
                match = re.search(r'channel: ([\d,]+)', result.stdout)
            if match:
                channel_str = match.group(1)
                return int(re.search(r'\d+', channel_str).group(0))
        except Exception:
            pass
    elif system == "Linux":
        try:
            result = subprocess.run(
                ["iwconfig"], capture_output=True, text=True, timeout=5
            )
            match = re.search(r'Frequency[=:]([0-9.]+)\s*GHz', result.stdout)
            if match:
                freq = float(match.group(1))
                # Convert frequency to channel (simplified)
                if 2.4 <= freq < 2.5:
                    return int((freq - 2.407) / 0.005)
                elif 5 <= freq < 6:
                    return int((freq - 5.0) / 0.005)
        except Exception:
            pass
    elif system == "Windows":
        try:
            result = subprocess.run(
                ["netsh", "wlan", "show", "interfaces"],
                capture_output=True, text=True, timeout=5
            )
            match = re.search(r'Channel\s+: (\d+)', result.stdout)
            if match:
                return int(match.group(1))
        except Exception:
            pass

    return None


def is_dfs_channel(channel: int) -> bool:
    """Check if channel is DFS-affected (5GHz 120-144)."""
    return 120 <= channel <= 144


def scan_available_networks() -> List[Dict]:
    """Scan for available WiFi networks and return list with SSID, BSSID, channel, signal."""
    system = platform.system()
    networks = []

    if system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-s"],
                capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.split('\n')[1:]:
                if not line.strip():
                    continue
                parts = line.split()
                if len(parts) >= 7:
                    networks.append({
                        'ssid': parts[0],
                        'bssid': parts[1],
                        'rssi': int(parts[2]),
                        'channel': int(parts[3]),
                    })
        except Exception:
            pass
    elif system == "Linux":
        try:
            result = subprocess.run(
                ["nmcli", "device", "wifi", "list"],
                capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.split('\n')[1:]:
                if not line.strip():
                    continue
                # nmcli output format varies; parse carefully
                networks.append({'raw': line})
        except Exception:
            pass
    elif system == "Windows":
        try:
            result = subprocess.run(
                ["netsh", "wlan", "show", "networks", "mode=Bssid"],
                capture_output=True, text=True, timeout=10
            )
            # Parse Windows netsh output
            pass
        except Exception:
            pass

    return networks


def detect_band_steering(history: List[Dict]) -> bool:
    """Check if BSSID/channel changed unexpectedly (band steering)."""
    if len(history) < 2:
        return False

    bssids = set(h.get('bssid') for h in history if h.get('bssid'))
    return len(bssids) > 1


def detect_signal_instability(history: List[Dict], threshold_dbm: int = 20, window_seconds: int = 10) -> bool:
    """Check if signal strength varies > threshold within time window."""
    if len(history) < 2:
        return False

    signals = [h.get('signal_dbm') for h in history if h.get('signal_dbm')]
    if not signals:
        return False

    return (max(signals) - min(signals)) > threshold_dbm


class WiFiDiagnostics:
    """Diagnose WiFi radio-layer issues (canonical hypothesis #15, WiFi/DFS)."""

    def __init__(self):
        self.id = "wifi_radio_instability"
        self.name = "WiFi Radio-Layer Stability"
        self.history = []  # List of {timestamp, ssid, bssid, channel, signal_dbm}

    def sample_current_state(self) -> Optional[Dict]:
        """Capture current WiFi state."""
        ssid, bssid = get_current_ssid_and_bssid()
        channel = get_current_channel()
        signal = get_signal_strength()

        if not ssid or not bssid:
            return None

        sample = {
            'timestamp': datetime.now(),
            'ssid': ssid,
            'bssid': bssid,
            'channel': channel,
            'signal_dbm': signal,
        }
        self.history.append(sample)
        return sample

    def detect_band_steering(self) -> Dict:
        """Detect if BSSID changes (band steering indicator)."""
        state = self.sample_current_state()
        if not state:
            return {'detected': False, 'reason': 'Not connected to WiFi'}

        if detect_band_steering(self.history):
            bssids = set(h['bssid'] for h in self.history)
            return {
                'detected': True,
                'reason': f'Multiple BSSIDs detected: {bssids}',
                'count': len(bssids)
            }
        return {'detected': False, 'reason': 'Single BSSID, no band steering'}

    def detect_dfs_channel_warning(self) -> Dict:
        """Warn if on DFS-affected channel (5GHz 120-144)."""
        state = self.sample_current_state()
        if not state or not state.get('channel'):
            return {'warning': False}

        channel = state['channel']
        if is_dfs_channel(channel):
            return {
                'warning': True,
                'channel': channel,
                'reason': f'Channel {channel} is DFS-affected; prone to radar-triggered handoffs'
            }
        return {'warning': False, 'channel': channel}

    def detect_signal_instability(self) -> Dict:
        """Detect signal strength variation."""
        if detect_signal_instability(self.history):
            signals = [h['signal_dbm'] for h in self.history if h.get('signal_dbm')]
            variation = max(signals) - min(signals)
            return {
                'unstable': True,
                'variation_dbm': variation,
                'min': min(signals),
                'max': max(signals),
                'reason': f'Signal varies {variation} dBm (risk of disconnection)'
            }
        return {'unstable': False}

    def check_interference(self) -> Dict:
        """Detect channel congestion (interference risk)."""
        networks = scan_available_networks()
        if not networks:
            return {'congestion': 'unknown', 'reason': 'Could not scan networks'}

        state = self.sample_current_state()
        if not state or not state.get('channel'):
            return {'congestion': False}

        same_channel = len([n for n in networks if n.get('channel') == state['channel']])
        if same_channel > 3:
            return {
                'congestion': True,
                'same_channel': same_channel,
                'reason': f'{same_channel} networks on channel {state["channel"]}'
            }
        return {'congestion': False, 'same_channel': same_channel}
