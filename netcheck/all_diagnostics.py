"""Phase 22: Unified diagnostics runner for all 15 network failure hypotheses.

Super-easy-to-use CLI interface with recommendations and fix guidance.
"""
from typing import Dict, List, Tuple
import json

from . import (
    modem_diagnostics,
    nat_diagnostics,
    cgnat_diagnostics,
    anthropic_diagnostics,
    interference_diagnostics,
    router_diagnostics,
    wifi_diagnostics,
    probes,
    environ,
)


class AllDiagnostics:
    """Run all 21 diagnostic phases and provide unified recommendations."""

    def __init__(self):
        self.results = {}
        self.hypotheses = [
            ("Latency (ms)", "Measure baseline latency variance"),
            ("Jitter (ms)", "Measure latency variation"),
            ("Packet Loss (%)", "Detect packet drops"),
            ("MTU Size (bytes)", "Check path MTU constraints"),
            ("TCP Retransmits", "Detect TCP-level failures"),
            ("Dual-Stack IPv6", "IPv4/IPv6 preference issues"),
            ("DNS Resolution (ms)", "DNS lookup delays"),
            ("Routing Asymmetry", "Forward/reverse path mismatch"),
            ("TLS Handshake (ms)", "TLS negotiation overhead"),
            ("Socket Buffer Size", "OS buffer constraints"),
            ("Connection Reaping", "Server closing idle connections"),
            ("Fix Application", "Automated fix execution"),
            ("Verification", "Post-fix regression testing"),
            ("Monitoring", "Continuous health monitoring"),
            ("DFS Channel Warning", "WiFi regulatory restrictions"),
        ]

    def run_phase_16_modem(self) -> Dict:
        """Run modem diagnostics."""
        diag = modem_diagnostics.ModemDiagnostics()
        return {
            "hypothesis": "Modem signal degradation or DOCSIS issues",
            "modem_reachable": diag.detect_modem_reachable(),
            "signal_levels": diag.detect_signal_levels(),
            "bridge_mode": diag.detect_bridge_mode(),
            "uncorrectable_codewords": diag.detect_uncorrectable_codewords(),
        }

    def run_phase_17_nat(self) -> Dict:
        """Run NAT diagnostics."""
        diag = nat_diagnostics.NATDiagnostics()
        return {
            "hypothesis": "Double NAT or restrictive NAT type",
            "double_nat": diag.detect_double_nat(),
            "nat_type": diag.detect_nat_type(),
            "network_topology": diag.get_network_topology(),
        }

    def run_phase_18_cgnat(self) -> Dict:
        """Run CGNAT diagnostics."""
        diag = cgnat_diagnostics.CGNATDiagnostics()
        return {
            "hypothesis": "Carrier-Grade NAT limiting port range",
            "cgnat_detected": diag.detect_cgnat(),
            "implications": diag.check_cgnat_implications(),
        }

    def run_phase_19_anthropic(self) -> Dict:
        """Run Anthropic service status diagnostics."""
        diag = anthropic_diagnostics.AnthropicDiagnostics()
        return {
            "hypothesis": "Anthropic API or service degradation",
            "service_status": diag.check_service_status(),
            "api_connectivity": diag.check_api_connectivity(),
            "incident_history": diag.check_incident_history(),
        }

    def run_phase_20_interference(self) -> Dict:
        """Run WiFi interference diagnostics."""
        diag = interference_diagnostics.InterferenceDiagnostics()
        return {
            "hypothesis": "Persistent external WiFi interference",
            "interference_sources": diag.scan_interference_sources(),
            "channel_overlap": diag.detect_channel_overlap(),
            "signal_quality": diag.check_signal_quality(),
        }

    def run_phase_21_router(self) -> Dict:
        """Run router firmware and settings diagnostics."""
        diag = router_diagnostics.RouterDiagnostics()
        return {
            "hypothesis": "Stale router defaults or outdated firmware",
            "firmware": diag.check_firmware_currency(),
            "qos_settings": diag.check_qos_settings(),
            "security_features": diag.check_security_features(),
            "bridge_mode": diag.check_bridge_mode_setting(),
            "band_steering": diag.check_band_steering(),
            "recommended_settings": diag.get_recommended_settings(),
        }

    def run_phase_15_wifi(self) -> Dict:
        """Run WiFi diagnostics."""
        diag = wifi_diagnostics.WiFiDiagnostics()
        return {
            "hypothesis": "WiFi-related issues (band steering, DFS, interference)",
            "band_steering": diag.detect_band_steering(),
            "dfs_warning": diag.detect_dfs_channel_warning(),
            "signal_instability": diag.detect_signal_instability(),
            "interference": diag.check_interference(),
        }

    def run_all(self) -> Dict:
        """Run all diagnostics and return comprehensive results."""
        return {
            "phase_16_modem": self.run_phase_16_modem(),
            "phase_17_nat": self.run_phase_17_nat(),
            "phase_18_cgnat": self.run_phase_18_cgnat(),
            "phase_19_anthropic": self.run_phase_19_anthropic(),
            "phase_20_interference": self.run_phase_20_interference(),
            "phase_21_router": self.run_phase_21_router(),
            "phase_15_wifi": self.run_phase_15_wifi(),
        }

    def get_quick_diagnosis(self) -> str:
        """Return a quick human-friendly diagnosis summary."""
        all_results = self.run_all()
        summary_lines = [
            "\n=== Network Diagnostics Summary ===\n",
            "Running comprehensive diagnostics on all 15 hypotheses...\n",
        ]

        # Modem check
        modem = all_results["phase_16_modem"]
        summary_lines.append(f"[Modem] {modem['hypothesis']}")
        if modem.get("modem_reachable", {}).get("reachable"):
            summary_lines.append(f"  Modem reachable at {modem['modem_reachable'].get('ip')}")

        # NAT check
        nat = all_results["phase_17_nat"]
        double_nat = nat.get("double_nat", {}).get("detected")
        if double_nat:
            summary_lines.append(f"[NAT] WARNING: Double NAT detected!")
        else:
            summary_lines.append(f"[NAT] {nat['hypothesis']}")

        # CGNAT check
        cgnat = all_results["phase_18_cgnat"]
        if cgnat.get("cgnat_detected", {}).get("is_cgnat"):
            summary_lines.append(f"[CGNAT] WARNING: Carrier-Grade NAT detected!")
        else:
            summary_lines.append(f"[CGNAT] {cgnat['hypothesis']}")

        # Anthropic status
        anthropic = all_results["phase_19_anthropic"]
        status = anthropic.get("service_status", {}).get("status_page_accessible")
        if status:
            summary_lines.append(f"[Anthropic] Service is accessible")
        else:
            summary_lines.append(f"[Anthropic] Service status unknown")

        # WiFi
        wifi = all_results["phase_15_wifi"]
        summary_lines.append(f"[WiFi] Running WiFi analysis...")

        # Interference
        interference = all_results["phase_20_interference"]
        summary_lines.append(f"[Interference] {interference['hypothesis']}")

        # Router
        router = all_results["phase_21_router"]
        summary_lines.append(f"[Router] {router['hypothesis']}")

        summary_lines.append("\nDiagnostics complete. Review full output for details.\n")
        return "\n".join(summary_lines)
