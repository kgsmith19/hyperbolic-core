"""Phase 22: Unified diagnostics runner for the 7 extra hypothesis modules
(Phases 15-21, additional to the canonical 15-hypothesis list in
netcheck/docs/TROUBLESHOOTING.md).

Every phase is the same shape: instantiate a *Diagnostics class, call a few
of its methods, wrap the results in a dict with a human-readable hypothesis
label. PHASES below is the single declarative list of "what phases exist";
adding a new one is a data change here, not a new run_phase_* method.
"""
from typing import Dict
import concurrent.futures

from . import (
    modem_diagnostics,
    nat_diagnostics,
    cgnat_diagnostics,
    anthropic_diagnostics,
    interference_diagnostics,
    router_diagnostics,
    wifi_diagnostics,
)

# (result key, hypothesis label, Diagnostics class, ((output key, method name), ...))
PHASES = (
    ("phase_16_modem", "Modem signal degradation or DOCSIS issues",
     modem_diagnostics.ModemDiagnostics,
     (("modem_reachable", "detect_modem_reachable"),
      ("signal_levels", "detect_signal_levels"),
      ("bridge_mode", "detect_bridge_mode"),
      ("uncorrectable_codewords", "detect_uncorrectable_codewords"))),

    ("phase_17_nat", "Double NAT or restrictive NAT type",
     nat_diagnostics.NATDiagnostics,
     (("double_nat", "detect_double_nat"),
      ("nat_type", "detect_nat_type"),
      ("network_topology", "get_network_topology"))),

    ("phase_18_cgnat", "Carrier-Grade NAT limiting port range",
     cgnat_diagnostics.CGNATDiagnostics,
     (("cgnat_detected", "detect_cgnat"),
      ("implications", "check_cgnat_implications"))),

    ("phase_19_anthropic", "Anthropic API or service degradation",
     anthropic_diagnostics.AnthropicDiagnostics,
     (("service_status", "check_service_status"),
      ("api_connectivity", "check_api_connectivity"),
      ("incident_history", "check_incident_history"))),

    ("phase_20_interference", "Persistent external WiFi interference",
     interference_diagnostics.InterferenceDiagnostics,
     (("interference_sources", "scan_interference_sources"),
      ("channel_overlap", "detect_channel_overlap"),
      ("signal_quality", "check_signal_quality"))),

    ("phase_21_router", "Stale router defaults or outdated firmware",
     router_diagnostics.RouterDiagnostics,
     (("firmware", "check_firmware_currency"),
      ("qos_settings", "check_qos_settings"),
      ("security_features", "check_security_features"),
      ("bridge_mode", "check_bridge_mode_setting"),
      ("band_steering", "check_band_steering"),
      ("recommended_settings", "get_recommended_settings"))),

    ("phase_15_wifi", "WiFi-related issues (band steering, DFS, interference)",
     wifi_diagnostics.WiFiDiagnostics,
     (("band_steering", "detect_band_steering"),
      ("dfs_warning", "detect_dfs_channel_warning"),
      ("signal_instability", "detect_signal_instability"),
      ("interference", "check_interference"))),
)


def run_phase(entry) -> Dict:
    """Run one PHASES entry: instantiate its class, call each listed method,
    wrap the results under the hypothesis label."""
    _key, hypothesis, cls, fields = entry
    diag = cls()
    return {"hypothesis": hypothesis,
           **{output_key: getattr(diag, method)() for output_key, method in fields}}


class AllDiagnostics:
    """Run all 7 diagnostic phases and provide unified recommendations."""

    def run_all(self) -> Dict:
        """Run all phases and return comprehensive results.

        Each phase does its own independent I/O (HTTP requests, subprocess
        calls, each with its own timeout), so they run concurrently rather
        than one after another -- `full-check`'s wall time is bounded by the
        slowest single phase, not the sum of all seven.
        """
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(PHASES)) as pool:
            futures = {entry[0]: pool.submit(run_phase, entry) for entry in PHASES}
            return {name: future.result() for name, future in futures.items()}

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
        if cgnat.get("cgnat_detected", {}).get("detected"):
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
