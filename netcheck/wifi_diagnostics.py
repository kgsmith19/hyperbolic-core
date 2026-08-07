"""WiFi radio-layer diagnostics: band-steering, channel stability, interference.

Phase 15 diagnostic module, covering canonical hypothesis #15 ("WiFi/DFS" in
netcheck/docs/TROUBLESHOOTING.md): WiFi radio-layer instability (band steering, DFS
channel switches, WiFi 7 Multi-Link Operation quirks).

Current link state comes from environ.wifi() and neighbour congestion from
environ.congestion() -- the same fixture-tested parsers every other part of
this tool uses -- rather than a second, per-OS reimplementation. What's left
here is the logic that is genuinely this module's own: DFS classification,
and instability detection across a history of samples.
"""
from typing import Dict, List
from datetime import datetime

from . import environ


def is_dfs_channel(channel: int) -> bool:
    """5 GHz DFS range (52-144): radar detection can force the AP to jump
    channels mid-session, killing every established connection."""
    return 52 <= channel <= 144


def detect_band_steering(history: List[Dict]) -> bool:
    """Check if BSSID changed unexpectedly across samples (band steering)."""
    if len(history) < 2:
        return False

    bssids = set(h.get('bssid') for h in history if h.get('bssid'))
    return len(bssids) > 1


def detect_signal_instability(history: List[Dict], threshold_dbm: int = 20) -> bool:
    """Check if signal strength varies > threshold across samples."""
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

    def sample_current_state(self) -> Dict:
        """Capture current WiFi state via environ.wifi(); None if not connected."""
        link = environ.wifi()
        if link.get("state") != "ok" or not link.get("bssid"):
            return None

        sample = {
            'timestamp': datetime.now(),
            'ssid': link.get('ssid'),
            'bssid': link.get('bssid'),
            'channel': link.get('channel'),
            'signal_dbm': link.get('rssi_dbm'),
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
        """Warn if on a DFS-affected channel (5 GHz 52-144)."""
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
        """Detect channel congestion via environ.congestion()'s real scan."""
        state = self.sample_current_state()
        if not state or not state.get('channel'):
            return {'congestion': False, 'reason': 'Not connected to WiFi'}

        c = environ.congestion(state['channel'], state.get('bssid'))
        if c.get('state') != 'ok':
            return {'congestion': 'unknown', 'reason': c.get('reason', 'Could not scan networks')}

        same_channel = c['cochannel']
        if same_channel > 3:
            return {
                'congestion': True,
                'same_channel': same_channel,
                'reason': f'{same_channel} networks on channel {state["channel"]}'
            }
        return {'congestion': False, 'same_channel': same_channel}
