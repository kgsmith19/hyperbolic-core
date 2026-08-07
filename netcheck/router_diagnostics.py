"""Router diagnostics: firmware, settings, security features.

Phase 21 diagnostic module (additional to the canonical 15-hypothesis list in
docs/TROUBLESHOOTING.md): stale router default settings or outdated firmware.
"""
import os
import subprocess
from typing import Dict, Optional

from .environ import ROUTER_HOST_DEFAULT


def get_router_host() -> str:
    """Router LAN IP: ROUTER_HOST from .env, same default environ.router() uses."""
    return os.environ.get("ROUTER_HOST", ROUTER_HOST_DEFAULT)


def get_router_admin_url() -> str:
    """Get router admin interface URL."""
    return f"http://{get_router_host()}"


def check_router_reachability() -> Dict:
    """Check if router admin interface is accessible."""
    try:
        result = subprocess.run(
            ["ping", "-c", "1", get_router_host()],
            capture_output=True, timeout=3
        )
        return {'reachable': result.returncode == 0}
    except Exception:
        return {'reachable': False}


class RouterDiagnostics:
    """Diagnose router-related issues (Phase 21 module)."""

    def __init__(self):
        self.id = "router_firmware_settings"
        self.name = "Router Firmware & Settings"
        self.admin_url = get_router_admin_url()

    def check_firmware_currency(self) -> Dict:
        """Check if router firmware appears outdated."""
        reachable = check_router_reachability()
        if not reachable.get('reachable'):
            return {
                'accessible': False,
                'recommendation': 'Router admin interface not reachable',
            }

        return {
            'accessible': True,
            'recommendation': (
                f'Visit {self.admin_url} to check for firmware updates. '
                'Many WiFi/stability issues are resolved in newer firmware versions.'
            ),
        }

    def check_qos_settings(self) -> Dict:
        """Check for QoS features that might affect long-lived connections."""
        features = [
            'Adaptive QoS (ASUS) - may deprioritize long-lived connections',
            'Traffic Shaping - can cause latency for streaming',
            'Bandwidth Limiter - check if any rules apply to your device',
            'AiProtection/DPI - deep packet inspection can cause timeout',
        ]
        reachable = check_router_reachability()
        return {
            'accessible': reachable.get('reachable', False),
            'features_to_check': features,
            'recommendation': (
                f'Visit {self.admin_url} → QoS settings and temporarily disable. '
                'Re-test Claude Code connectivity. If it helps, fine-tune QoS rules.'
            ),
        }

    def check_security_features(self) -> Dict:
        """Check router security features that might affect connectivity."""
        features = [
            'AiProtection (ASUS) - DPI inspection can timeout long streams',
            'IDS/IPS (Intrusion Detection) - blocks repeated requests',
            'Web Filter - may block API requests',
            'DoS Protection - might trigger on legitimate traffic patterns',
        ]
        reachable = check_router_reachability()
        return {
            'accessible': reachable.get('reachable', False),
            'features_to_check': features,
            'recommendation': (
                f'Visit {self.admin_url} → Security. Try disabling AiProtection/DPI. '
                'Test Claude Code for 5 minutes. If stable, re-enable with fine-tuned rules.'
            ),
        }

    def check_bridge_mode_setting(self) -> Dict:
        """Check if router is in bridge mode (modem already handles routing)."""
        return {
            'recommendation': (
                f'Visit {self.admin_url} → WAN/Internet settings. '
                'If you have a dedicated modem, router should be in Bridge Mode. '
                'Router mode = double NAT (usually bad for long-lived connections).'
            ),
        }

    def check_band_steering(self) -> Dict:
        """Check for band steering settings (can cause mid-session handoffs)."""
        return {
            'recommendation': (
                f'Visit {self.admin_url} → WiFi settings. '
                'Disable "Smart Connect" / "Band Steering" temporarily and test. '
                'If stable, re-enable or limit to fixed band (5GHz only).'
            ),
        }

    def get_recommended_settings(self) -> Dict:
        """Get recommended router settings for stable long-lived connections."""
        return {
            'settings': [
                ('WiFi Mode', '802.11ax (WiFi 6) or 802.11ac (WiFi 5)'),
                ('Band', '5GHz (less interference, better for streaming)'),
                ('Channel', '36, 40, 44, 48, 149, 153, 157, 161 (non-DFS)'),
                ('Bandwidth', '80MHz (balance between speed and stability)'),
                ('Band Steering', 'OFF (disable mid-session handoffs)'),
                ('AiProtection', 'OFF (disable DPI inspection)'),
                ('Adaptive QoS', 'OFF (disable traffic shaping)'),
                ('Bridge Mode', 'ON if you have a modem, OFF if modem is in bridge'),
            ],
            'url': self.admin_url,
        }
