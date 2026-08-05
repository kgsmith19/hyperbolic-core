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


class DualStackIsolationTest(unittest.TestCase):
    """Phase 5: Dual-Stack (IPv4/IPv6) Isolation tests."""

    def test_ipv4_only_working_ipv6_broken(self):
        """Detect IPv4-only connectivity when IPv6 fails."""
        ipv4_result = {"reachable": True, "latency_ms": 20, "loss_pct": 0}
        ipv6_result = {"reachable": False, "latency_ms": None, "loss_pct": 100}

        result = diagnose.analyze_dual_stack(ipv4_result, ipv6_result)

        self.assertTrue(result["ipv4_working"])
        self.assertFalse(result["ipv6_working"])
        self.assertEqual(result["affected_stack"], "ipv6")
        self.assertTrue(result["asymmetric"])

    def test_ipv6_only_working_ipv4_broken(self):
        """Detect IPv6-only connectivity when IPv4 fails."""
        ipv4_result = {"reachable": False, "latency_ms": None, "loss_pct": 100}
        ipv6_result = {"reachable": True, "latency_ms": 25, "loss_pct": 0}

        result = diagnose.analyze_dual_stack(ipv4_result, ipv6_result)

        self.assertFalse(result["ipv4_working"])
        self.assertTrue(result["ipv6_working"])
        self.assertEqual(result["affected_stack"], "ipv4")
        self.assertTrue(result["asymmetric"])

    def test_both_stacks_working_symmetric(self):
        """Detect when both IPv4 and IPv6 work."""
        ipv4_result = {"reachable": True, "latency_ms": 20, "loss_pct": 0}
        ipv6_result = {"reachable": True, "latency_ms": 20, "loss_pct": 0}

        result = diagnose.analyze_dual_stack(ipv4_result, ipv6_result)

        self.assertTrue(result["ipv4_working"])
        self.assertTrue(result["ipv6_working"])
        self.assertFalse(result["asymmetric"])
        self.assertTrue(result["both_working"])

    def test_ipv6_slower_latency(self):
        """Detect IPv6 with higher latency (routing issue)."""
        ipv4_result = {"reachable": True, "latency_ms": 20, "loss_pct": 0}
        ipv6_result = {"reachable": True, "latency_ms": 80, "loss_pct": 0}

        result = diagnose.analyze_dual_stack(ipv4_result, ipv6_result)

        self.assertTrue(result["ipv4_working"])
        self.assertTrue(result["ipv6_working"])
        self.assertTrue(result["latency_asymmetry"])
        self.assertGreater(result["latency_differential_ms"], 50)

    def test_happy_eyeballs_detection(self):
        """Detect Happy Eyeballs in action (fast fallback)."""
        events = [
            {"protocol": "ipv6", "status": "timeout", "timestamp": 0},
            {"protocol": "ipv4", "status": "success", "timestamp": 50},
            {"protocol": "ipv6", "status": "connected", "timestamp": 300},
        ]
        result = diagnose.detect_happy_eyeballs(events)

        self.assertTrue(result["happy_eyeballs_active"])
        self.assertEqual(result["fallback_to"], "ipv4")
        self.assertLess(result["fallback_delay_ms"], 100)

    def test_ipv6_preferential_routing(self):
        """Detect when dual-stack prefers IPv6 (per RFC 8305)."""
        events = [
            {"protocol": "ipv6", "status": "success", "latency": 25},
            {"protocol": "ipv4", "status": "success", "latency": 30},
        ]
        result = diagnose.detect_dual_stack_preference(events)

        self.assertEqual(result["preferred_protocol"], "ipv6")
        self.assertTrue(result["following_rfc8305"])

    def test_dns_64_translation(self):
        """Detect DNS64 / NAT64 translation (synthetic IPv6)."""
        # Well-known prefix for NAT64: 64:ff9b::/96
        ipv6_addrs = ["2001:db8::1", "64:ff9b::192.0.2.1", "fe80::1"]
        result = diagnose.detect_nat64_translation(ipv6_addrs)

        self.assertTrue(result["nat64_detected"])
        self.assertIn("64:ff9b::192.0.2.1", result["translated_addresses"])

    def test_dual_stack_integrates_into_results(self):
        """Dual-stack analysis integrates into DiagnosisResult."""
        results = diagnose.DiagnosisResult()
        ipv4 = {"reachable": True, "latency_ms": 20, "loss_pct": 0}
        ipv6 = {"reachable": True, "latency_ms": 20, "loss_pct": 0}

        stack_result = diagnose.analyze_dual_stack(ipv4, ipv6)
        results.add("dual_stack", stack_result)

        stored = results.tests.get("dual_stack")
        self.assertIsNotNone(stored)
        self.assertTrue(stored["both_working"])

    def test_routing_path_symmetric(self):
        """Symmetric IPv4/IPv6 routing paths."""
        ipv4_path = [{"responsive": True}, {"responsive": True}, {"responsive": False}]
        ipv6_path = [{"responsive": True}, {"responsive": True}, {"responsive": False}]
        result = diagnose.analyze_routing_path(ipv4_path, ipv6_path)

        self.assertFalse(result["path_asymmetry"])
        self.assertEqual(result["ipv4_first_failure_at_hop"], 2)
        self.assertEqual(result["ipv6_first_failure_at_hop"], 2)

    def test_routing_path_asymmetric_ipv4_fails(self):
        """Asymmetric routing - IPv4 fails first."""
        ipv4_path = [{"responsive": True}, {"responsive": False}]
        ipv6_path = [{"responsive": True}, {"responsive": True}, {"responsive": True}]
        result = diagnose.analyze_routing_path(ipv4_path, ipv6_path)

        self.assertTrue(result["path_asymmetry"])
        self.assertEqual(result["affected_stack"], "ipv4")
        self.assertEqual(result["ipv4_first_failure_at_hop"], 1)

    def test_routing_path_asymmetric_ipv6_fails(self):
        """Asymmetric routing - IPv6 fails first."""
        ipv4_path = [{"responsive": True}, {"responsive": True}, {"responsive": True}]
        ipv6_path = [{"responsive": True}, {"responsive": False}]
        result = diagnose.analyze_routing_path(ipv4_path, ipv6_path)

        self.assertTrue(result["path_asymmetry"])
        self.assertEqual(result["affected_stack"], "ipv6")

    def test_route_flapping_detection(self):
        """Detect BGP route flapping."""
        events = [
            {"timestamp": 0, "route": "AS64512"},
            {"timestamp": 10, "route": "AS64513"},
            {"timestamp": 20, "route": "AS64512"},
            {"timestamp": 30, "route": "AS64513"},
            {"timestamp": 40, "route": "AS64514"},
        ]
        result = diagnose.detect_route_flapping(events)

        self.assertTrue(result["flapping"])
        self.assertGreaterEqual(result["route_changes_detected"], 3)

    def test_route_stability_no_changes(self):
        """Route stability when no changes occur."""
        events = [
            {"timestamp": 0, "route": "AS64512"},
            {"timestamp": 30, "route": "AS64512"},
        ]
        result = diagnose.detect_route_flapping(events)

        self.assertFalse(result["flapping"])
        self.assertEqual(result["route_changes_detected"], 0)

    def test_classify_hop_latency_local(self):
        """Classify local network latency (< 10ms)."""
        latencies = [1, 2, 3, 4, 5]
        result = diagnose.classify_hop_latency(latencies)
        self.assertEqual(result, "local_network")

    def test_classify_hop_latency_distant(self):
        """Classify distant/congested hop latency (> 500ms)."""
        latencies = [550, 600, 580]
        result = diagnose.classify_hop_latency(latencies)
        self.assertEqual(result, "distant_or_congested")

    def test_measure_hop_stability_stable(self):
        """Measure stable hop (low jitter)."""
        samples = [
            {"latency_ms": 20},
            {"latency_ms": 21},
            {"latency_ms": 22},
        ]
        result = diagnose.measure_hop_stability(samples)

        self.assertIn(result["stability"], ["very_stable", "stable"])
        self.assertLess(result["jitter_ms"], 20)

    def test_measure_hop_stability_unstable(self):
        """Measure unstable hop (high jitter)."""
        samples = [
            {"latency_ms": 5},
            {"latency_ms": 100},
            {"latency_ms": 200},
        ]
        result = diagnose.measure_hop_stability(samples)

        self.assertEqual(result["stability"], "unstable")
        self.assertGreater(result["jitter_ms"], 50)

    def test_detect_blackhole_route(self):
        """Detect potential blackhole routing."""
        path = [
            {"responsive": True},
            {"responsive": True},
            {"responsive": False, "error_response": False},
        ]
        result = diagnose.detect_blackhole_route(path)

        self.assertTrue(result["potential_blackhole"])
        self.assertEqual(result["silent_failure_hops"], 1)

    def test_routing_path_integrates_into_results(self):
        """Routing analysis integrates into DiagnosisResult."""
        results = diagnose.DiagnosisResult()
        ipv4_path = [{"responsive": True}, {"responsive": False}]
        ipv6_path = [{"responsive": True}, {"responsive": False}]
        routing_result = diagnose.analyze_routing_path(ipv4_path, ipv6_path)
        results.add("routing", routing_result)

        stored = results.tests.get("routing")
        self.assertIsNotNone(stored)
        self.assertFalse(stored["path_asymmetry"])


class SynthesisDiagnosisTest(unittest.TestCase):
    """PDD: Synthesis produces exactly one primary culprit from layer results."""

    def test_empty_layers_returns_no_culprit(self):
        """No layer results produces no culprit."""
        result = diagnose.synthesize_diagnosis({})

        self.assertIsNone(result["primary_culprit"])
        self.assertEqual(len(result["contributing_layers"]), 0)
        self.assertEqual(result["synthesis_confidence"], 0.0)

    def test_single_layer_culprit_becomes_primary(self):
        """Single culprit is made primary."""
        layer_results = {
            "gateway": {"culprit_found": True, "confidence": 0.9, "metric": "unreachable"}
        }
        result = diagnose.synthesize_diagnosis(layer_results)

        self.assertEqual(result["primary_culprit"], "gateway")
        self.assertEqual(result["synthesis_confidence"], 0.9)

    def test_highest_confidence_culprit_ranked_first(self):
        """Highest confidence culprit becomes primary, others contribute."""
        layer_results = {
            "gateway": {"culprit_found": True, "confidence": 0.7, "metric": "unreachable"},
            "dns": {"culprit_found": True, "confidence": 0.95, "metric": "timeout"},
            "isp": {"culprit_found": True, "confidence": 0.5, "metric": "high_latency"}
        }
        result = diagnose.synthesize_diagnosis(layer_results)

        self.assertEqual(result["primary_culprit"], "dns")
        self.assertEqual(result["synthesis_confidence"], 0.95)
        self.assertEqual(result["contributing_layers"], ["gateway", "isp"])


class RootCauseRankingTest(unittest.TestCase):
    """SDD: Root causes ranked by score (confidence × frequency × impact)."""

    def test_empty_findings_returns_empty_list(self):
        """No findings returns empty ranking."""
        result = diagnose.rank_root_causes([])

        self.assertEqual(len(result), 0)

    def test_single_finding_ranked(self):
        """Single finding is ranked with its score."""
        findings = [
            {"cause": "gateway", "confidence": 0.9, "frequency": 0.2, "impact": 1.0, "evidence": ["packet loss"]}
        ]
        result = diagnose.rank_root_causes(findings)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["cause"], "gateway")
        self.assertGreater(result[0]["score"], 0)

    def test_higher_confidence_ranks_first(self):
        """Higher confidence gets higher score."""
        findings = [
            {"cause": "dns", "confidence": 0.5, "frequency": 1.0, "impact": 1.0},
            {"cause": "gateway", "confidence": 0.9, "frequency": 1.0, "impact": 1.0},
        ]
        result = diagnose.rank_root_causes(findings)

        self.assertEqual(result[0]["cause"], "gateway")
        self.assertGreater(result[0]["score"], result[1]["score"])

    def test_frequency_and_impact_multiply_score(self):
        """Frequency and impact multiply into score."""
        high_freq = [
            {"cause": "a", "confidence": 0.8, "frequency": 0.5, "impact": 1.0}
        ]
        result_high = diagnose.rank_root_causes(high_freq)

        low_freq = [
            {"cause": "b", "confidence": 0.8, "frequency": 0.1, "impact": 1.0}
        ]
        result_low = diagnose.rank_root_causes(low_freq)

        self.assertGreater(result_high[0]["score"], result_low[0]["score"])


class ConfidenceScoreTest(unittest.TestCase):
    """PDD: Confidence score bounded [0, 1] and increases with observations."""

    def test_empty_observations_returns_zero(self):
        """No observations = zero confidence."""
        score = diagnose.calculate_confidence_score([])

        self.assertEqual(score, 0.0)

    def test_confidence_bounded_between_zero_and_one(self):
        """Confidence always between 0 and 1."""
        observations_list = [
            [],
            [{"consistent": True}],
            [{"consistent": True}] * 100,
            [{"consistent": False}] * 100,
        ]

        for obs in observations_list:
            score = diagnose.calculate_confidence_score(obs)
            self.assertGreaterEqual(score, 0.0)
            self.assertLessEqual(score, 1.0)

    def test_all_consistent_observations_high_confidence(self):
        """All consistent observations → high confidence."""
        observations = [{"consistent": True}] * 10
        score = diagnose.calculate_confidence_score(observations)

        self.assertGreater(score, 0.5)

    def test_mixed_observations_medium_confidence(self):
        """Mixed consistent/inconsistent observations → medium confidence."""
        observations = [{"consistent": True}, {"consistent": False}] * 5
        score = diagnose.calculate_confidence_score(observations)

        self.assertGreater(score, 0.0)
        self.assertLess(score, 1.0)


class CascadeFailureDetectionTest(unittest.TestCase):
    """SDD: Cascade detection identifies layered failures."""

    def test_no_failures_no_cascade(self):
        """All layers healthy = no cascade."""
        layer_states = {"gateway": "ok", "isp": "ok", "dns": "ok"}
        result = diagnose.detect_cascade_failures(layer_states)

        self.assertFalse(result["cascade_detected"])
        self.assertIsNone(result["root_layer"])

    def test_single_failure_not_cascade(self):
        """One failure is not a cascade."""
        layer_states = {"gateway": "fail", "isp": "ok", "dns": "ok"}
        result = diagnose.detect_cascade_failures(layer_states)

        self.assertFalse(result["cascade_detected"])

    def test_gateway_failure_cascades_downstream(self):
        """Gateway failure cascades to ISP and DNS."""
        layer_states = {"gateway": "fail", "isp": "fail", "dns": "fail"}
        result = diagnose.detect_cascade_failures(layer_states)

        self.assertTrue(result["cascade_detected"])
        self.assertEqual(result["root_layer"], "gateway")
        self.assertIn("isp", result["cascade_chain"])
        self.assertIn("dns", result["cascade_chain"])

    def test_isp_failure_not_blamed_on_gateway_ok(self):
        """ISP failure when gateway is ok is not cascading from gateway."""
        layer_states = {"gateway": "ok", "isp": "fail", "dns": "fail"}
        result = diagnose.detect_cascade_failures(layer_states)

        self.assertTrue(result["cascade_detected"])
        self.assertEqual(result["root_layer"], "isp")


class SynthesisReportGenerationTest(unittest.TestCase):
    """TDD: Reports synthesize findings into actionable recommendations."""

    def test_no_culprit_returns_no_issue_summary(self):
        """No primary culprit → 'no clear issue' report."""
        synthesis = {"primary_culprit": None, "contributing_layers": [], "synthesis_confidence": 0.0}
        root_causes = []
        report = diagnose.generate_synthesis_report(synthesis, root_causes)

        self.assertIn("no clear", report["summary"].lower())
        self.assertIsNone(report["primary_issue"])

    def test_gateway_culprit_has_wifi_recommendation(self):
        """Gateway culprit → Wi-Fi recommendation."""
        synthesis = {"primary_culprit": "gateway", "contributing_layers": [], "synthesis_confidence": 0.9}
        root_causes = [{"impact": 1.0}]
        report = diagnose.generate_synthesis_report(synthesis, root_causes)

        self.assertEqual(report["primary_issue"], "gateway")
        self.assertIn("Wi-Fi", report["recommendations"][0]["action"])

    def test_dns_culprit_has_dns_recommendation(self):
        """DNS culprit → DNS servers recommendation."""
        synthesis = {"primary_culprit": "dns", "contributing_layers": [], "synthesis_confidence": 0.8}
        root_causes = [{"impact": 1.0}]
        report = diagnose.generate_synthesis_report(synthesis, root_causes)

        self.assertEqual(report["primary_issue"], "dns")
        self.assertIn("DNS", report["recommendations"][0]["action"])

    def test_isp_culprit_has_contact_isp_recommendation(self):
        """ISP culprit → Contact ISP recommendation."""
        synthesis = {"primary_culprit": "isp", "contributing_layers": [], "synthesis_confidence": 0.85}
        root_causes = [{"impact": 1.0}]
        report = diagnose.generate_synthesis_report(synthesis, root_causes)

        self.assertEqual(report["primary_issue"], "isp")
        self.assertIn("ISP", report["recommendations"][0]["action"])

    def test_report_includes_confidence_and_evidence(self):
        """Report includes confidence score and evidence summary."""
        synthesis = {"primary_culprit": "gateway", "contributing_layers": [], "synthesis_confidence": 0.92}
        root_causes = [{"impact": 1.0, "frequency": 0.15}]
        report = diagnose.generate_synthesis_report(synthesis, root_causes)

        self.assertEqual(report["confidence"], 0.92)
        self.assertIn("15%", report["evidence_summary"])


class SynthesisIntegrationTest(unittest.TestCase):
    """TDD: Full synthesis workflow from findings to recommendations."""

    def test_full_synthesis_workflow(self):
        """End-to-end: layer findings → synthesis → report."""
        # Layer analysis produces findings
        layer_results = {
            "gateway": {"culprit_found": True, "confidence": 0.85, "metric": "packet_loss"},
            "dns": {"culprit_found": True, "confidence": 0.6, "metric": "timeout"},
        }

        # Findings ranked by root cause analysis
        findings = [
            {"cause": "gateway", "confidence": 0.85, "frequency": 0.2, "impact": 1.0},
            {"cause": "dns", "confidence": 0.6, "frequency": 0.1, "impact": 0.8},
        ]

        # Synthesis combines them
        synthesis = diagnose.synthesize_diagnosis(layer_results)
        ranked = diagnose.rank_root_causes(findings)

        # Report is generated
        report = diagnose.generate_synthesis_report(synthesis, ranked)

        # Verify output
        self.assertEqual(report["primary_issue"], "gateway")
        self.assertGreater(report["confidence"], 0)
        self.assertGreater(len(report["recommendations"]), 0)

    def test_cascade_failure_synthesis_identifies_root(self):
        """Cascade failures correctly identify root layer."""
        layer_states = {"gateway": "fail", "isp": "fail", "dns": "fail", "application": "fail"}
        cascade = diagnose.detect_cascade_failures(layer_states)

        # Cascade analysis drives synthesis recommendation
        self.assertTrue(cascade["cascade_detected"])
        self.assertEqual(cascade["root_layer"], "gateway")
        self.assertEqual(cascade["cascade_chain"][0], "gateway")


if __name__ == "__main__":
    unittest.main()
