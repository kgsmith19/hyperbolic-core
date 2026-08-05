"""Fix recommendation engine: maps network diagnosis to actionable remedies.

Core principle: Every diagnosis points to specific, testable fixes.
Fixes ranked by: effort (low ROI actions first), likelihood (fix 35% ASUS Wi-Fi before 7% double NAT), and independence (fixes that don't require others).
"""
from typing import Dict, List, Tuple
from datetime import datetime


class FixRecommendation:
    """Single actionable fix with instructions and metadata."""
    
    def __init__(self, fix_id: str, title: str, category: str, 
                 effort: str, likelihood: float, instructions: List[str]):
        self.id = fix_id
        self.title = title
        self.category = category  # "wifi", "router", "modem", "network_config", "isp"
        self.effort = effort  # "low", "medium", "high"
        self.likelihood = likelihood  # 0.0-1.0
        self.instructions = instructions
        self.applied = False
        self.applied_at = None


def recommend_fixes_for_diagnosis(diagnosis: Dict) -> List[FixRecommendation]:
    """Generate ranked fix recommendations from diagnostic findings."""
    culprit = diagnosis.get("primary_culprit")
    confidence = diagnosis.get("synthesis_confidence", 0.5)
    
    fixes = []
    
    # ASUS Wi-Fi (35% likely)
    if culprit in ["gateway", "wifi_mode"] or confidence > 0.7:
        fixes.extend([
            FixRecommendation(
                "wifi_channel_5ghz",
                "Switch 5 GHz Wi-Fi channel to avoid interference",
                "wifi",
                "low",
                0.35,
                [
                    "Log into ASUS router (192.168.1.1 or 192.168.0.1)",
                    "Navigate to Wireless > General",
                    "Set Channel: Auto (or try 36, 40, 44, 48 for 5GHz)",
                    "Set Channel Bandwidth: 80 MHz (not 160 MHz initially)",
                    "Apply and test Claude Code for 5+ minutes",
                ]
            ),
            FixRecommendation(
                "wifi_disable_features",
                "Disable ASUS Wi-Fi features that break persistent connections",
                "wifi",
                "low",
                0.30,
                [
                    "Log into ASUS router",
                    "Wireless > General: Disable 'Band Steering'",
                    "Wireless > General: Disable 'Fast Roaming' (802.11k)",
                    "Wireless > General: Disable '160 MHz Channel Width'",
                    "Advanced Settings > Wireless: Disable 'Airtime Fairness'",
                    "Apply and reboot router (wait 2 minutes)",
                ]
            ),
            FixRecommendation(
                "wifi_mode_native",
                "Ensure Wi-Fi adapter uses native 802.11ax (Wi-Fi 6)",
                "wifi",
                "medium",
                0.25,
                [
                    "On your device: check Wi-Fi properties for 802.11ax/Wi-Fi 6",
                    "If not showing: update NIC driver from manufacturer website",
                    "Restart computer and verify mode in Wi-Fi settings",
                    "If still unavailable: check BIOS for 'Integrated Peripherals' settings",
                ]
            ),
        ])
    
    # ASUS router config (20% likely)
    if culprit == "router" or ("isp" in str(culprit).lower() and confidence > 0.6):
        fixes.extend([
            FixRecommendation(
                "disable_aiprotection",
                "Disable ASUS AiProtection DPI (breaks persistent connections)",
                "router",
                "low",
                0.20,
                [
                    "Log into ASUS router",
                    "Security > Network Protection: Set AiProtection to OFF",
                    "Note: This also disables IDS, intrusion prevention, and web filtering",
                    "Apply settings",
                ]
            ),
            FixRecommendation(
                "disable_qos",
                "Disable Adaptive QoS (can break API streams)",
                "router",
                "low",
                0.18,
                [
                    "Log into ASUS router",
                    "Network Control Center > Adaptive QoS: Set to OFF",
                    "Or disable Traffic Analyzer if present",
                    "Reboot router",
                ]
            ),
            FixRecommendation(
                "update_router_firmware",
                "Update ASUS router firmware to latest stable version",
                "router",
                "medium",
                0.15,
                [
                    "Download latest ASUS firmware from support.asus.com",
                    "Log into ASUS router",
                    "Administration > Firmware Upgrade: Upload firmware file",
                    "Wait for upgrade (do NOT power off)",
                    "Router will reboot automatically",
                ]
            ),
        ])
    
    # CAX80 modem / DOCSIS (20% likely)
    if culprit in ["isp", "modem"] or (confidence > 0.5 and "upstream" in str(diagnosis).lower()):
        fixes.extend([
            FixRecommendation(
                "check_docsis_levels",
                "Verify CAX80 DOCSIS signal levels are healthy",
                "modem",
                "low",
                0.20,
                [
                    "Open browser to http://192.168.100.1 (or 192.168.0.1)",
                    "Log in with NETGEAR credentials",
                    "Go to Advanced > DOCSIS WAN or Modem Status",
                    "Check: Downstream Power Levels between -8 dBm and +7 dBm",
                    "Check: Upstream Power Levels between 35 dBm and 52 dBm",
                    "Check: SNR (Signal-to-Noise) above 30 dB",
                    "Check: Uncorrectable errors near 0 (< 100 in 24h is normal)",
                    "If bad: contact ISP with these values",
                ]
            ),
            FixRecommendation(
                "restart_modem",
                "Power-cycle CAX80 modem to clear transient state",
                "modem",
                "low",
                0.12,
                [
                    "Unplug CAX80 power cable",
                    "Wait 30 seconds",
                    "Plug back in",
                    "Wait 2-3 minutes for modem to fully boot",
                    "Test Claude Code immediately after",
                ]
            ),
        ])
    
    # Network configuration (7% double NAT)
    if not diagnosis.get("wan_ip_is_private"):
        fixes.extend([
            FixRecommendation(
                "verify_bridge_mode",
                "Verify CAX80 is in true modem-only (bridge) mode",
                "network_config",
                "medium",
                0.07,
                [
                    "CAX80 bridge mode = router functions DISABLED, NAT DISABLED",
                    "Check ASUS router for WAN IP: should be public (not 192.168.x.x)",
                    "If WAN IP is 192.168.x.x: CAX80 is doing NAT (double NAT)",
                    "To fix: Log into CAX80, find Advanced > Bridge Mode or NAT, set to BRIDGE",
                    "CAX80 management address becomes 192.168.100.1 in bridge mode",
                ]
            ),
        ])
    
    # Sort by effort (low first) then by likelihood (high first)
    effort_order = {"low": 0, "medium": 1, "high": 2}
    fixes.sort(key=lambda f: (effort_order[f.effort], -f.likelihood))
    
    return fixes


def get_ethernet_test_setup() -> Dict:
    """Instructions for the highest-ROI diagnostic test."""
    return {
        "title": "Ethernet Test: Isolates Wi-Fi from Router/Modem/ISP",
        "description": "Connecting via Ethernet splits the problem cleanly",
        "steps": [
            "Connect one computer to ASUS router with Ethernet cable",
            "Disable Wi-Fi completely on that computer",
            "Use Claude Code normally for 10+ minutes with larger contexts",
            "Monitor /tmp or task manager for errors",
        ],
        "interpretation": {
            "works_cleanly": "ASUS Wi-Fi radio or configuration is the problem. Apply Wi-Fi fixes.",
            "still_fails": "Problem is ASUS routing/features, CAX80, coax, or ISP. Apply router/modem fixes.",
            "fails_on_large": "Investigate packet loss, bufferbloat, MTU, or DPI. Check DOCSIS levels.",
        }
    }


def track_fix_application(fix: FixRecommendation, success: bool) -> Dict:
    """Record that a fix was applied and track its outcome."""
    return {
        "fix_id": fix.id,
        "applied_at": datetime.now().isoformat(),
        "success": success,
        "next_step": "test_claude_code" if success else "try_next_fix",
        "fallback": get_ethernet_test_setup() if not success else None,
    }
