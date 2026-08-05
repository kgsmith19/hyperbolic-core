"""Diagnostic decision tree engine: strict, comprehensive gates.

This is the core troubleshooting logic. Tests must verify:
1. Rules fire in correct order (no drill-down before basics)
2. Terminal conditions stop tree traversal
3. Hypothesis ranking matches evidence quality
4. No culprit when unavailable (can't blame what we didn't measure)
5. All edge cases handled (contradictory results, missing data, etc.)
"""
import unittest
from unittest.mock import Mock, patch
from datetime import datetime, timedelta

# Tests will drive the implementation
from netcheck import diagnose


class DiagnosticTreeOrderTest(unittest.TestCase):
    """Criterion 1: Rules execute in priority order. Drill-downs only if conditions met."""

    def test_gateway_test_runs_before_isp_test(self):
        """Gateway (layer 1) must complete before hop (layer 2)."""
        # Create a diagnostic tree
        tree = diagnose.DiagnosticTree()
        rules = tree.get_rules_in_order()

        # Find indices
        gw_idx = next(i for i, r in enumerate(rules) if r.id == "layer_1_gateway")
        hop_idx = next(i for i, r in enumerate(rules) if r.id == "layer_2_isp")

        self.assertLess(gw_idx, hop_idx,
                       "Gateway test must run before ISP hop test")

    def test_drill_down_wifi_mode_requires_gateway_ok(self):
        """Drill-down tests only run if their condition is met.
        Don't diagnose Wi-Fi mode if gateway itself is failing."""
        tree = diagnose.DiagnosticTree()
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "fail")

        # Gateway failed, so drill-down shouldn't run
        remaining = tree.get_remaining_rules(results)
        drill_rules = [r for r in remaining if r.is_drill_down]
        wifi_drills = [r for r in drill_rules if "wifi" in r.id]

        # Shouldn't recommend Wi-Fi drill if gateway is the problem
        for wifi_rule in wifi_drills:
            self.assertFalse(
                wifi_rule.should_run(results),
                f"Rule {wifi_rule.id} shouldn't run when gateway already failed"
            )

    def test_drill_down_interference_needs_gateway_and_mode_ok(self):
        """Multi-condition drill-down: only run if ALL preconditions met."""
        tree = diagnose.DiagnosticTree()
        results = diagnose.DiagnosisResult()

        # Scenario 1: Gateway fails -> shouldn't drill on interference
        results.add("layer_1_gateway", "fail")
        interference_rule = tree.get_rule("drill_interference")
        self.assertFalse(interference_rule.should_run(results),
                        "Shouldn't diagnose interference if gateway fails")

        # Scenario 2: Gateway ok, but Wi-Fi mode ok -> shouldn't drill
        results.clear()
        results.add("layer_1_gateway", "ok")
        results.add("drill_wifi_mode", "ok")
        results.add("layer_3_dns", "ok")
        self.assertFalse(interference_rule.should_run(results),
                        "Shouldn't drill interference if Wi-Fi mode is OK")

        # Scenario 3: Gateway ok, mode NOT ok, DNS ok, TLS times out -> NOW drill
        results.clear()
        results.add("layer_1_gateway", "ok")
        results.add("drill_wifi_mode", "fail")
        results.add("layer_3_dns", "ok")
        results.add("layer_4_tls", "timeout")
        self.assertTrue(interference_rule.should_run(results),
                       "Should drill interference when mode bad + TLS times out")


class TerminalConditionTest(unittest.TestCase):
    """Criterion 2: Tree stops when diagnosis is definitive. No over-testing."""

    def test_gateway_failure_is_terminal_for_wan_tests(self):
        """If gateway fails, we know it's LAN. Don't test ISP."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "fail")
        results.add("layer_2_isp", "ok")  # Even if ISP were ok

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.culprit, "lan",
                        "Gateway failure := LAN problem")
        self.assertFalse(diagnosis.should_continue_testing,
                        "Stop testing once LAN is diagnosed")

    def test_both_dns_resolvers_failing_is_terminal_for_dns_rules(self):
        """If router DNS AND public DNS both fail, we know it's DNS.
        Don't need to drill into router-specific issues."""
        results = diagnose.DiagnosisResult()
        results.add("layer_3_dns", "both_fail")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.culprit, "dns")
        self.assertFalse(diagnosis.should_continue_testing,
                        "Stop when both DNS resolvers fail")

    def test_idle_hold_closed_by_peer_is_terminal(self):
        """Connection reaped = definitive: something is killing connections.
        No need to keep testing."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "ok")
        results.add("layer_3_dns", "ok")
        results.add("layer_4_tls", "ok")
        results.add("layer_5_idle_hold", "closed_by_peer")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.culprit, "connection_reaping")
        self.assertTrue(diagnosis.is_definitive,
                       "Connection reaping is a definitive root cause")


class HypothesisRankingTest(unittest.TestCase):
    """Criterion 3: Multiple possible causes ranked by evidence quality.
    Rank by specificity and how much evidence supports it."""

    def test_single_clear_culprit_is_ranked_first(self):
        """If one cause is clearly indicated, rank it #1."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "ok")
        results.add("layer_3_dns", "router_fail_public_ok")

        hypotheses = diagnose.rank_hypotheses(results)
        self.assertEqual(hypotheses[0]["cause"], "router_dns",
                        "Router DNS should be ranked #1 when evidence is clear")
        self.assertEqual(hypotheses[0]["confidence"], "high",
                        "Confidence should be high for clear culprit")

    def test_multiple_possible_causes_ranked_by_likelihood(self):
        """When multiple causes possible, rank by: specificity > frequency > reversibility."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "ok")
        results.add("layer_3_dns", "ok")
        results.add("layer_4_tls", "fail")
        results.add("drill_wifi_mode", "fail")  # Wi-Fi mode bad
        results.add("drill_interference", "high")  # Also interference

        hypotheses = diagnose.rank_hypotheses(results)

        # Both possible, but Wi-Fi mode is more specific + controllable
        # Find their rankings
        wifi_idx = next((i for i, h in enumerate(hypotheses)
                        if h["cause"] == "wifi_mode"), -1)
        interference_idx = next((i for i, h in enumerate(hypotheses)
                                if h["cause"] == "interference"), -1)

        self.assertNotEqual(wifi_idx, -1, "Wi-Fi mode should be hypothesized")
        self.assertNotEqual(interference_idx, -1, "Interference should be hypothesized")
        self.assertLess(wifi_idx, interference_idx,
                       "Wi-Fi mode (controllable) ranked before interference (external)")

    def test_unavailable_result_lowers_hypothesis_confidence(self):
        """If we can't measure something, we can't strongly blame it."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "ok")
        results.add("layer_3_dns", "router_unavailable_public_ok")

        hypotheses = diagnose.rank_hypotheses(results)
        # Router DNS is unavailable (no credentials), so we shouldn't blame it
        router_hypotheses = [h for h in hypotheses if h["cause"] == "router_dns"]

        self.assertEqual(len(router_hypotheses), 0,
                        "Unavailable measurement should never become a hypothesis")


class UnavailableVsFailTest(unittest.TestCase):
    """Criterion 4: CRITICAL DISTINCTION.
    Unavailable (couldn't measure) != Fail (measured, broken).
    Never blame what we couldn't measure."""

    def test_unavailable_router_dns_never_blamed(self):
        """No credentials for router = unavailable.
        Even if public DNS works, we can't blame router."""
        results = diagnose.DiagnosisResult()
        results.add("layer_3_dns", {
            "router": {"state": "unavailable", "reason": "no credentials"},
            "public": {"state": "ok"}
        })

        diagnosis = diagnose.get_diagnosis(results)
        self.assertIsNone(diagnosis.culprit,
                         "Unavailable router DNS should not produce a culprit")

    def test_unavailable_public_dns_still_allows_router_blame(self):
        """Router fails, public DNS unavailable (e.g., firewall blocks 8.8.8.8).
        Can still blame router because router DID fail and we measured it."""
        results = diagnose.DiagnosisResult()
        results.add("layer_3_dns", {
            "router": {"state": "fail"},
            "public": {"state": "unavailable", "reason": "firewall"}
        })

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.culprit, "router_dns",
                        "Can blame router_dns even if public is unmeasured, "
                        "because router was measured and failed")

    def test_unavailable_gateway_never_produces_lan_culprit(self):
        """Can't ping gateway = unavailable, not fail.
        Don't conclude 'LAN broken' if we couldn't measure it."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", {
            "state": "unavailable",
            "reason": "ping binary not found or permission denied"
        })

        diagnosis = diagnose.get_diagnosis(results)
        self.assertIsNone(diagnosis.culprit,
                         "Unavailable gateway shouldn't produce culprit")


class EdgeCaseTest(unittest.TestCase):
    """Criterion 5: Weird, contradictory, or partial results handled safely."""

    def test_gateway_responds_but_isp_hop_unreachable(self):
        """Gateway OK but next hop times out = ISP edge problem."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "fail")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.culprit, "isp",
                        "Unreachable ISP hop = ISP problem")

    def test_all_layers_ok_but_api_errors_still_happening(self):
        """Everything reachable, no timeouts, yet API errors occur.
        Could be: server-side, transient, or specific request pattern."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "ok")
        results.add("layer_3_dns", "ok")
        results.add("layer_4_tls", "ok")
        results.add("layer_5_idle_hold", "still_alive")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertIsNone(diagnosis.culprit,
                         "No network culprit if everything measures ok")
        self.assertEqual(diagnosis.note, "not_local",
                        "If network is clean, error is server-side or pattern-specific")

    def test_dns_split_decision_both_ok(self):
        """Router DNS works, Public DNS works.
        No DNS problem."""
        results = diagnose.DiagnosisResult()
        results.add("layer_3_dns", {
            "router": {"state": "ok"},
            "public": {"state": "ok"}
        })

        diagnosis = diagnose.get_diagnosis(results)
        self.assertIsNone(diagnosis.culprit,
                         "Both DNS working = no DNS culprit")

    def test_dns_split_decision_router_unavailable_public_ok(self):
        """Router DNS unavailable (no creds), public DNS ok.
        No culprit, but note that we can't fully diagnose."""
        results = diagnose.DiagnosisResult()
        results.add("layer_3_dns", {
            "router": {"state": "unavailable"},
            "public": {"state": "ok"}
        })

        diagnosis = diagnose.get_diagnosis(results)
        self.assertIsNone(diagnosis.culprit,
                         "Unavailable router DNS shouldn't produce culprit")
        self.assertIn("unavailable", diagnosis.note.lower(),
                     "Note should mention unmeasured component")

    def test_contradictory_results_gateway_ok_but_isp_ok_and_internet_fail(self):
        """Gateway ok, ISP ok, but internet fails.
        Could be: ISP routing issue, peering problem, or measurement artifact."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "ok")
        results.add("layer_3_dns", "ok")
        results.add("layer_4_tls", "fail")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.culprit, "upstream",
                        "If ISP responds but far end fails, it's upstream")


class DiagnosisWithHistoryTest(unittest.TestCase):
    """Criterion 6: Use historical patterns to weight current diagnosis.
    If Wi-Fi mode was bad before and now it's fixed, weight that heavily."""

    def test_repeated_culprit_increases_confidence(self):
        """If router_dns failed 5 times out of 5 error bursts, confidence is very high."""
        history = [
            {"culprit": "router_dns", "burst": 1},
            {"culprit": "router_dns", "burst": 2},
            {"culprit": "router_dns", "burst": 3},
            {"culprit": "router_dns", "burst": 4},
            {"culprit": "router_dns", "burst": 5},
        ]
        confidence = diagnose.calculate_confidence_from_history(history, "router_dns")
        self.assertGreater(confidence, 0.9,
                          "Repeated culprit = very high confidence")

    def test_inconsistent_culprit_lowers_confidence(self):
        """If culprit changes every burst, underlying cause is probably different."""
        history = [
            {"culprit": "router_dns", "burst": 1},
            {"culprit": "interference", "burst": 2},
            {"culprit": "connection_reaping", "burst": 3},
        ]
        # Each of these lowers individually
        for culprit in ["router_dns", "interference", "connection_reaping"]:
            conf = diagnose.calculate_confidence_from_history(history, culprit)
            self.assertLess(conf, 0.7,
                          f"Inconsistent culprit '{culprit}' = lower confidence")

    def test_fix_applied_then_errors_stop_confirms_hypothesis(self):
        """Applied Wi-Fi mode fix. Errors stopped. Confidence in Wi-Fi mode as cause: very high."""
        history = [
            {"culprit": None, "status": "errors", "date": "2026-08-04"},
            {"culprit": None, "status": "errors", "date": "2026-08-05", "fix_applied": "wifi_mode"},
            {"culprit": None, "status": "clean", "date": "2026-08-06"},
            {"culprit": None, "status": "clean", "date": "2026-08-07"},
        ]
        confidence = diagnose.calculate_confidence_from_history(history, "wifi_mode", fix_applied=True)
        self.assertGreater(confidence, 0.95,
                          "Fix applied + errors stopped = very high confidence in that fix")


class MultipleErrorBurstCorrelationTest(unittest.TestCase):
    """Criterion 7: Correlate errors across multiple bursts to pattern-match.
    One error burst could be transient. Multiple bursts with same pattern = systematic."""

    def test_single_error_burst_insufficient_for_diagnosis(self):
        """One error burst, no monitoring data nearby.
        Diagnosis: inconclusive (unmonitored)."""
        errors = [
            {"ts": "2026-08-05T12:00:00Z", "kind": "network"}
        ]
        samples = []  # No monitoring data

        result = diagnose.correlate_with_history(errors, samples)
        self.assertEqual(result[0]["verdict"], "unmonitored",
                        "Single error with no samples = unmonitored verdict")

    def test_repeated_errors_with_consistent_network_state_identifies_pattern(self):
        """5 errors, all happen during same network state (e.g., during interference spike).
        Pattern: errors correlate to interference."""
        errors = [
            {"ts": f"2026-08-05T12:0{i}:00Z", "kind": "network", "detail": "ECONNRESET"}
            for i in range(1, 6)
        ]
        samples = [
            {
                "ts": f"2026-08-05T12:0{i}:00Z",
                "interference": "high",
                "dns_state": "ok",
                "tls_state": "ok"
            }
            for i in range(1, 6)
        ]

        result = diagnose.correlate_with_history(errors, samples)
        self.assertTrue(
            any("interference" in str(r).lower() for r in result),
            "Multiple errors during interference spikes should identify pattern"
        )


class ConfigurationSnapshotTest(unittest.TestCase):
    """Criterion 8: Snapshot captures full state. Change detection works."""

    def test_snapshot_captures_all_required_fields(self):
        """Snapshot must include every relevant configuration variable."""
        required_fields = [
            "wifi_mode", "router_dpi", "modem_snr", "windows_power_profile",
            "tcp_autotuning", "mtu", "system_uptime", "dns_servers"
        ]

        snapshot = diagnose.capture_baseline_snapshot()

        for field in required_fields:
            self.assertIn(field, snapshot,
                         f"Snapshot missing required field: {field}")

    def test_snapshot_delta_identifies_configuration_changes(self):
        """Compare two snapshots, identify what changed."""
        snap1 = {"wifi_mode": "802.11ac", "tcp_autotuning": "normal"}
        snap2 = {"wifi_mode": "802.11ax", "tcp_autotuning": "normal"}

        delta = diagnose.compare_snapshots(snap1, snap2)

        self.assertEqual(delta["changed"]["wifi_mode"]["from"], "802.11ac")
        self.assertEqual(delta["changed"]["wifi_mode"]["to"], "802.11ax")
        self.assertNotIn("tcp_autotuning", delta["changed"],
                        "Unchanged fields shouldn't appear in delta")

    def test_snapshot_timestamp_is_precise(self):
        """Snapshots timestamped to correlate with errors (within seconds)."""
        snap = diagnose.capture_baseline_snapshot()
        now = datetime.utcnow()

        snap_time = datetime.fromisoformat(snap["timestamp"].replace("Z", "+00:00"))
        delta = abs((snap_time - now).total_seconds())

        self.assertLess(delta, 1,
                       f"Snapshot timestamp should be within 1 second of now, "
                       f"but delta was {delta}s")


class ConfigurationMatrixTest(unittest.TestCase):
    """Criterion 9: Track tested combinations, guide future testing."""

    def test_matrix_tracks_tested_variables(self):
        """Record: Wi-Fi mode 802.11ac tested -> 14 errors."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14)

        history = matrix.get_history("wifi_mode", "802.11ac")
        self.assertEqual(history[0]["outcome"], "fail")
        self.assertEqual(history[0]["error_count"], 14)

    def test_matrix_suggests_highest_impact_next_test(self):
        """Tested: mode_ac (14 errors). Untested: mode_ax.
        Next suggestion: Test mode_ax (highest impact, directly addresses known issue)."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14, impact_score=95)
        # mode_ax untested

        suggestion = matrix.suggest_next_test()
        self.assertEqual(suggestion["variable"], "wifi_mode")
        self.assertEqual(suggestion["value"], "802.11ax",
                        "Should suggest untested value with highest impact")

    def test_matrix_prevents_redundant_testing(self):
        """Already tested wifi_mode=802.11ac multiple times.
        Don't suggest testing it again."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", test_count=3)

        # Should not suggest testing 802.11ac again
        suggestion = matrix.suggest_next_test()
        self.assertNotEqual(suggestion["value"], "802.11ac",
                           "Don't suggest retesting already-tested value")

    def test_matrix_tracks_fix_applied_and_outcome(self):
        """Applied fix: Wi-Fi mode to 802.11ax.
        Outcome: errors stopped."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ax", "success",
                          fix_applied=True, errors_after=0, date_applied="2026-08-05")

        record = matrix.get_history("wifi_mode", "802.11ax")[0]
        self.assertTrue(record["fix_applied"])
        self.assertEqual(record["errors_after"], 0)


class RegressionTrackingTest(unittest.TestCase):
    """Criterion 10: Once fixed, don't regress. Track over time."""

    def test_regression_detection_wifi_mode_reverted(self):
        """Baseline: Wi-Fi mode fixed to 802.11ax.
        Current: Back to 802.11ac.
        Alert: REGRESSION."""
        baseline = {"wifi_mode": "802.11ax"}
        current = {"wifi_mode": "802.11ac"}

        regressions = diagnose.detect_regressions(baseline, current)
        self.assertTrue(
            any(r["field"] == "wifi_mode" for r in regressions),
            "Should detect regression in Wi-Fi mode"
        )

    def test_no_false_positive_regression_on_transient_change(self):
        """Transient network state change shouldn't flag regression.
        Regression = persistent config change that reverts a fix."""
        baseline = {"dns_servers": ["8.8.8.8"]}
        current = {"dns_servers": ["192.168.50.1"]}  # Router rebooted, reset to DHCP

        # This is not a regression of a fix we applied
        # Only flag as regression if it's a known fixed config that changed
        baseline_fixes = []  # We didn't fix DNS

        regressions = diagnose.detect_regressions(
            baseline, current, known_fixed_configs=baseline_fixes
        )
        self.assertEqual(len(regressions), 0,
                        "Transient state change shouldn't be regression")

    def test_uptime_reset_triggers_investigation(self):
        """Modem uptime was 72h, now 2h.
        Modem restarted -> could affect diagnostics."""
        baseline_snapshot = {
            "timestamp": "2026-08-05T10:00:00Z",
            "modem_uptime_hours": 72
        }
        current_snapshot = {
            "timestamp": "2026-08-06T14:00:00Z",
            "modem_uptime_hours": 2
        }

        note = diagnose.check_state_changes(baseline_snapshot, current_snapshot)
        self.assertIn("reboot", note.lower(),
                     "Should note potential modem reboot")


class RecommendationEngineTest(unittest.TestCase):
    """Criterion 11: Based on diagnosis + history + config, recommend next action."""

    def test_recommendation_for_untested_wifi_mode(self):
        """Wi-Fi mode is only concrete anomaly. It's untested.
        Recommendation: Apply fix."""
        diagnosis = {"culprit": None, "anomalies": ["wifi_mode_pinned"]}
        config_matrix = diagnose.ConfigurationMatrix()
        config_matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14)
        # 802.11ax untested

        recommendation = diagnose.generate_recommendation(diagnosis, config_matrix)
        self.assertEqual(recommendation["action"], "apply_fix")
        self.assertEqual(recommendation["target"], "wifi_mode")
        self.assertIn("802.11ax", recommendation["instruction"])

    def test_recommendation_for_diagnosed_culprit(self):
        """Diagnosed: router_dns. Last 3 errors all blamed it.
        Recommendation: Verify/fix router DNS."""
        diagnosis = {"culprit": "router_dns", "confidence": 0.95}

        recommendation = diagnose.generate_recommendation(diagnosis, None)
        self.assertIn("dns", recommendation["action"].lower())
        self.assertIn("router", recommendation["action"].lower())

    def test_recommendation_ranked_by_impact_and_feasibility(self):
        """Multiple possible fixes. Rank by: high_impact AND low_cost.
        Reboot: high impact, low cost. DPI toggle: medium impact, medium cost."""
        candidates = [
            {"fix": "reboot_modem", "impact": "high", "cost": "low", "reversible": True},
            {"fix": "disable_dpi", "impact": "medium", "cost": "medium", "reversible": True},
            {"fix": "replace_modem", "impact": "high", "cost": "very_high", "reversible": False},
        ]

        ranked = diagnose.rank_recommendations(candidates)
        self.assertEqual(ranked[0]["fix"], "reboot_modem",
                        "Highest impact + lowest cost = top recommendation")


class EdgeCaseCombinationsTest(unittest.TestCase):
    """Criterion 12: Test weird combinations that might break the tree."""

    def test_all_measurements_unavailable(self):
        """No credentials, no permissions, nothing measurable.
        Diagnosis: inconclusive, but not an error."""
        results = diagnose.DiagnosisResult()
        for layer in ["gateway", "isp", "dns", "tls", "idle_hold"]:
            results.add(f"layer_{layer}", "unavailable")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertIsNone(diagnosis.culprit,
                         "All unavailable = no culprit, not error")
        self.assertEqual(diagnosis.note, "inconclusive",
                        "Should note that measurement incomplete")

    def test_mix_of_ok_and_unavailable(self):
        """Gateway OK, ISP unavailable, DNS ok, TLS ok.
        Can still diagnose: not a gateway problem (gateway ok).
        Beyond gateway, ISP measurement failed, but DNS works."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "ok")
        results.add("layer_2_isp", "unavailable")
        results.add("layer_3_dns", "ok")
        results.add("layer_4_tls", "ok")

        diagnosis = diagnose.get_diagnosis(results)
        # Can't blame ISP (unmeasured), but can rule out gateway
        self.assertIsNone(diagnosis.culprit,
                         "Unavailable ISP can't be blamed even if others fail")

    def test_timeout_vs_fail_distinction(self):
        """Gateway timeout != gateway unreachable.
        Timeout: something's blocking/delaying. Unreachable: device down."""
        results = diagnose.DiagnosisResult()
        results.add("layer_1_gateway", "timeout")

        diagnosis = diagnose.get_diagnosis(results)
        self.assertEqual(diagnosis.note, "lan_slow",
                        "Timeout is LAN problem, but potentially reversible")
        # vs
        results2 = diagnose.DiagnosisResult()
        results2.add("layer_1_gateway", "unreachable")
        diagnosis2 = diagnose.get_diagnosis(results2)
        self.assertEqual(diagnosis2.note, "lan_down",
                        "Unreachable is LAN problem, likely hardware")


class MTUMSSDiscoveryTest(unittest.TestCase):
    """Phase 3: MTU/MSS Discovery & Fragmentation Detection tests."""

    def test_mtu_discovery_standard_1500(self):
        """Detect standard Ethernet MTU (1500 bytes).
        Should find max size where packets don't fragment."""
        # Simulated PMTUD probe results: sizes that don't fragment
        probe_results = [
            {"size": 1000, "fragmented": False},
            {"size": 1500, "fragmented": False},
            {"size": 1600, "fragmented": True},  # Fragments here
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertEqual(result["path_mtu"], 1500)
        self.assertTrue(result["is_standard_mtu"])
        self.assertEqual(result["mtu_type"], "ethernet_standard")

    def test_mtu_discovery_pppoe_1492(self):
        """Detect PPPoE MTU (1492 bytes) - common for DSL."""
        probe_results = [
            {"size": 1000, "fragmented": False},
            {"size": 1492, "fragmented": False},
            {"size": 1500, "fragmented": True},  # Fragments at 1500
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertEqual(result["path_mtu"], 1492)
        self.assertTrue(result["is_standard_mtu"])
        self.assertEqual(result["mtu_type"], "pppoe_dsl")

    def test_mtu_discovery_jumbo_9000(self):
        """Detect jumbo frame MTU (9000 bytes)."""
        probe_results = [
            {"size": 8000, "fragmented": False},
            {"size": 9000, "fragmented": False},
            {"size": 9500, "fragmented": True},
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertEqual(result["path_mtu"], 9000)
        self.assertTrue(result["is_standard_mtu"])
        self.assertEqual(result["mtu_type"], "jumbo_frames")

    def test_mtu_discovery_non_standard_1480(self):
        """Detect non-standard MTU (1480 bytes)."""
        probe_results = [
            {"size": 1000, "fragmented": False},
            {"size": 1480, "fragmented": False},
            {"size": 1500, "fragmented": True},
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertEqual(result["path_mtu"], 1480)
        self.assertFalse(result["is_standard_mtu"])
        self.assertEqual(result["mtu_type"], "non_standard")

    def test_pmtud_working_status(self):
        """Detect when PMTUD is functioning (DF bit respected)."""
        # When PMTUD works: packets with DF bit get ICMP unreachable on oversized
        probe_results = [
            {"size": 1500, "fragmented": False, "df_bit_set": True},
            {"size": 1501, "fragmented": False, "df_bit_set": True, "icmp_error": True},
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertTrue(result["pmtud_working"])
        self.assertFalse(result["blackhole_detected"])

    def test_pmtud_broken_fragmentation_occurs(self):
        """Detect when PMTUD is broken (fragmentation occurs instead of ICMP)."""
        # When PMTUD broken: packets fragment instead of returning ICMP error
        probe_results = [
            {"size": 1500, "fragmented": False},
            {"size": 1501, "fragmented": True, "df_bit_set": True},  # Fragments despite DF
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertFalse(result["pmtud_working"])
        self.assertTrue(result["fragmentation_occurring"])
        self.assertEqual(result["pmtud_status"], "broken_fragmentation")

    def test_pmtud_blackhole_detection(self):
        """Detect PMTUD black hole (no response to oversized packets)."""
        # Black hole: packets with DF bit disappear, no ICMP error, no response
        probe_results = [
            {"size": 1500, "fragmented": False, "timeout": False},
            {"size": 1501, "fragmented": False, "timeout": True, "df_bit_set": True},
        ]
        result = diagnose.discover_path_mtu(probe_results)

        self.assertFalse(result["pmtud_working"])
        self.assertTrue(result["blackhole_detected"])
        self.assertEqual(result["pmtud_status"], "blackhole")

    def test_fragmentation_latency_impact(self):
        """Detect if fragmentation increases latency significantly."""
        # Compare RTT: unfragmented vs fragmented packets
        probe_results = [
            {"size": 1500, "fragmented": False, "rtt_ms": 15.0},
            {"size": 2000, "fragmented": True, "rtt_ms": 45.0},  # 3x latency
        ]
        result = diagnose.analyze_fragmentation_impact(probe_results)

        self.assertTrue(result["fragmentation_degrades_latency"])
        self.assertGreater(result["latency_increase_pct"], 100)
        self.assertTrue(result["fragmentation_is_problem"])

    def test_mtu_mss_alignment(self):
        """Verify MSS is correctly derived from MTU."""
        # MSS = MTU - 40 (TCP/IP headers) or MTU - 60 (with options)
        mtu = 1500
        result = diagnose.calculate_mss_from_mtu(mtu)

        self.assertEqual(result["mss_basic"], 1460)  # 1500 - 40
        self.assertTrue(result["mss_reasonable"])


if __name__ == "__main__":
    unittest.main()
