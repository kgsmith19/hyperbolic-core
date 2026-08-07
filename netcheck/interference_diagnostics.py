"""Interference diagnostics: detect WiFi interference sources.

Phase 20 diagnostic module (additional to the canonical 15-hypothesis list in
netcheck/docs/TROUBLESHOOTING.md): persistent external WiFi interference. Reuses
environ.wifi()/environ.congestion() -- the same real co-channel/same-block
scan `netcheck diagnose` already relies on -- rather than a second,
disconnected measurement.
"""
from typing import Dict

from . import environ


def _congestion() -> Dict:
    """Real cochannel/same-block AP counts for the currently connected network."""
    link = environ.wifi()
    if link.get("state") != "ok":
        return {"state": "unavailable", "reason": link.get("reason", "not connected")}
    return dict(environ.congestion(link.get("channel"), link.get("bssid")),
               rssi_dbm=link.get("rssi_dbm"))


class InterferenceDiagnostics:
    """Diagnose WiFi interference (Phase 20 module)."""

    def __init__(self):
        self.id = "wifi_interference"
        self.name = "WiFi Interference Detection"

    def scan_interference_sources(self) -> Dict:
        """Count competing radios on our channel and 80 MHz block."""
        c = _congestion()
        if c.get("state") != "ok":
            return {'detected': False, 'reason': c.get("reason", "could not scan")}
        detected = c["cochannel"] > 0 or c["same_block"] > 0
        return {
            'detected': detected,
            'cochannel_count': c["cochannel"],
            'same_block_count': c["same_block"],
            'recommendation': (
                f"{c['cochannel']} network(s) on your channel, {c['same_block']} more "
                "in the same 80 MHz block -- switch to a less crowded channel."
                if detected else 'No significant co-channel or same-block interference.'
            ),
        }

    def detect_channel_overlap(self) -> Dict:
        """Overlap with neighbours in the same 80 MHz block, from the same real scan."""
        c = _congestion()
        if c.get("state") != "ok":
            return {'overlap_detected': None, 'reason': c.get("reason", "could not scan")}
        return {
            'overlap_detected': c["same_block"] > 0,
            'recommendation': 'Use 5GHz band (channels 36-165) for less interference than 2.4GHz',
        }

    def check_signal_quality(self) -> Dict:
        """Classify RSSI using this project's own -50/-70 dBm thresholds
        (see README.md: strong >= -50 dBm, weak < -70 dBm)."""
        link = environ.wifi()
        rssi = link.get("rssi_dbm") if link.get("state") == "ok" else None
        if rssi is None:
            return {'quality': 'unknown',
                    'recommendation': 'Not connected to WiFi, or signal unavailable.'}
        quality = "good" if rssi >= -50 else "fair" if rssi >= -70 else "poor"
        return {
            'quality': quality,
            'rssi_dbm': rssi,
            'recommendation': (
                'Strong signal (-50 dBm or better) is ideal for long-lived connections. '
                'Weak signal (<-70 dBm) can cause disconnections.'
            ),
        }
