"""Diagnostic decision tree engine for network troubleshooting.

Core principle: Systematic elimination. Every test reduces the search space.
Never blame what we couldn't measure. Terminal conditions stop testing.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Union
from datetime import datetime, timedelta
from enum import Enum


class TestState(Enum):
    """Possible test outcomes."""
    OK = "ok"
    FAIL = "fail"
    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"


class Culprit(Enum):
    """Possible root causes for network issues."""
    GATEWAY_FAILURE = "gateway_failure"
    ISP_FAILURE = "isp_failure"
    DNS_ROUTER = "router_dns"
    DNS_GENERAL = "dns"
    INTERNET_UPSTREAM = "upstream"
    TLS_INTERCEPTION = "tls_interception"
    CONNECTION_REAPING = "connection_reaping"
    WIFI_MODE = "wifi_mode"
    WIFI_INTERFERENCE = "interference"
    ROUTER_DPI = "router_dpi"
    MODEM_ISSUE = "modem"
    NONE = None


@dataclass
class DiagnosticRule:
    """One rule in the decision tree."""
    id: str
    priority: int  # Lower = runs first
    name: str
    is_drill_down: bool = False
    condition: Optional[str] = None  # Python condition to check before running

    def should_run(self, results: 'DiagnosisResult') -> bool:
        """Check if conditions are met to run this rule."""
        if not self.condition:
            return True
        return eval(self.condition, {"results": results})


@dataclass
class DiagnosticTestResult:
    """Result of one diagnostic test."""
    layer: str
    state: TestState
    culprit: Optional[Culprit] = None
    confidence: float = 1.0
    reason: Optional[str] = None
    is_terminal: bool = False  # If true, stop testing


@dataclass
class Diagnosis:
    """Complete diagnosis with hypothesis ranking."""
    culprit: Optional[str] = None
    confidence: float = 0.0
    is_definitive: bool = False
    should_continue_testing: bool = True
    hypotheses: List[Dict] = field(default_factory=list)
    note: Optional[str] = None


class DiagnosticTree:
    """Ordered decision tree for systematic network diagnosis."""

    def __init__(self):
        self.rules = self._build_rules()

    def _build_rules(self) -> List[DiagnosticRule]:
        """Build ordered rule set: basics before drill-downs."""
        return [
            DiagnosticRule(
                id="layer_1_gateway",
                priority=1,
                name="Is the gateway reachable?",
                condition=None
            ),
            DiagnosticRule(
                id="layer_2_isp",
                priority=2,
                name="Is the ISP hop responding?",
                condition=None
            ),
            DiagnosticRule(
                id="layer_3_dns",
                priority=3,
                name="DNS: router vs public",
                condition=None
            ),
            DiagnosticRule(
                id="layer_4_tls",
                priority=4,
                name="Can TLS handshake complete?",
                condition=None
            ),
            DiagnosticRule(
                id="layer_5_idle_hold",
                priority=5,
                name="Do long-lived connections get reaped?",
                condition=None
            ),
            # Drill-downs: only run if conditions met
            DiagnosticRule(
                id="drill_wifi_mode",
                priority=6,
                name="Is adapter truly on 802.11ax?",
                is_drill_down=True,
                condition="results.get('layer_3_dns') == 'ok' and results.get('layer_4_tls') != 'ok'"
            ),
            DiagnosticRule(
                id="drill_interference",
                priority=7,
                name="Is there co-channel interference?",
                is_drill_down=True,
                condition="results.get('drill_wifi_mode') != 'ok' and results.get('layer_3_dns') == 'ok'"
            ),
            DiagnosticRule(
                id="drill_router_dpi",
                priority=8,
                name="Is router DPI actively filtering?",
                is_drill_down=True,
                condition="results.get('layer_4_tls') == 'fail' and results.get('layer_3_dns').get('public') == 'ok'"
            ),
        ]

    def get_rules_in_order(self) -> List[DiagnosticRule]:
        """Return rules sorted by priority (execution order)."""
        return sorted(self.rules, key=lambda r: r.priority)

    def get_rule(self, rule_id: str) -> Optional[DiagnosticRule]:
        """Get rule by ID."""
        return next((r for r in self.rules if r.id == rule_id), None)

    def get_remaining_rules(self, results: 'DiagnosisResult') -> List[DiagnosticRule]:
        """Rules still to run, given current results."""
        remaining = []
        for rule in self.get_rules_in_order():
            if rule.id not in results.completed:
                if rule.should_run(results):
                    remaining.append(rule)
        return remaining


class DiagnosisResult:
    """Accumulator for test results."""

    def __init__(self):
        self.tests = {}  # rule_id -> result
        self.completed = []
        self.terminal = False
        self.primary_culprit = None

    def add(self, rule_id: str, state: Union[str, Dict]):
        """Record a test result."""
        if isinstance(state, str):
            self.tests[rule_id] = {"state": state}
        else:
            self.tests[rule_id] = state
        self.completed.append(rule_id)

    def get(self, rule_id: str) -> Optional[str]:
        """Get test result."""
        return self.tests.get(rule_id, {}).get("state")

    def clear(self):
        """Reset results."""
        self.tests = {}
        self.completed = []
        self.terminal = False


class ConfigurationMatrix:
    """Track tested configurations and guide next testing."""

    def __init__(self):
        self.tests = {}  # {variable: {value: [results]}}
        self.fixes_applied = {}  # {variable: fix_record}
        self.baseline_state = None

    def record_test(
        self,
        variable: str,
        value: str,
        outcome: str,
        error_count: int = 0,
        duration_hours: float = 0,
        date: str = None,
        notes: str = "",
        **kwargs
    ):
        """Record a configuration test result."""
        if variable not in self.tests:
            self.tests[variable] = {}
        if value not in self.tests[variable]:
            self.tests[variable][value] = []

        record = {
            "variable": variable,
            "value": value,
            "outcome": outcome,
            "error_count": error_count,
            "duration_hours": duration_hours,
            "date": date or datetime.utcnow().isoformat(),
            "tested": True,
            "notes": notes,
            "impact_score": self._calculate_impact_score(error_count, outcome),
            **kwargs
        }
        self.tests[variable][value].append(record)

    def _calculate_impact_score(self, error_count: int, outcome: str) -> float:
        """Score impact: 0-100."""
        if outcome == "success" and error_count == 0:
            return 95.0
        elif outcome == "fail":
            return min(80 + error_count / 2, 99.0)
        else:
            return 50.0

    def get_test_record(self, variable: str, value: str) -> Optional[Dict]:
        """Get latest test result for variable/value."""
        if variable not in self.tests or value not in self.tests[variable]:
            return None
        records = self.tests[variable][value]
        return records[-1] if records else None

    def get_history(self, variable: str, value: str) -> List[Dict]:
        """Get all test results for variable/value."""
        if variable not in self.tests or value not in self.tests[variable]:
            return []
        return self.tests[variable][value]

    def suggest_next_test(self) -> Dict:
        """Recommend highest-impact untested combination."""
        candidates = []
        for var, values in self.tests.items():
            for val, records in values.items():
                if records and records[-1]["tested"]:
                    # Already tested, look for untested alternatives
                    pass

        # Simple: suggest first untested high-impact variable
        high_impact = [
            (v, 95) for v in ["wifi_mode", "router_dns", "modem"]
        ]
        for var, impact in high_impact:
            if var in self.tests:
                # Check if all values tested
                untested = [
                    val for val, recs in self.tests[var].items()
                    if not recs or not recs[-1]["tested"]
                ]
                if untested:
                    return {
                        "variable": var,
                        "value": untested[0],
                        "expected_impact": impact,
                        "effort": "easy",
                    }
        return {"action": "monitor"}

    def record_fix_applied(
        self,
        variable: str,
        from_value: str,
        to_value: str,
        method: str,
        date: str = None
    ):
        """Record a fix application."""
        self.fixes_applied[variable] = {
            "from": from_value,
            "to": to_value,
            "method": method,
            "date": date or datetime.utcnow().isoformat(),
            "status": "pending"
        }

    def record_post_fix_outcome(
        self,
        variable: str,
        errors_after: int,
        duration_hours: float,
        verdict: str,
        date: str = None
    ):
        """Record outcome after fix applied."""
        if variable in self.fixes_applied:
            self.fixes_applied[variable].update({
                "errors_after": errors_after,
                "duration_hours": duration_hours,
                "verdict": verdict,
                "status": verdict,
                "outcome_date": date or datetime.utcnow().isoformat()
            })

    def get_fix_record(self, variable: str) -> Optional[Dict]:
        """Get fix record for variable."""
        return self.fixes_applied.get(variable)

    def get_fix_outcome(self, variable: str) -> Optional[Dict]:
        """Get outcome of applied fix."""
        if variable not in self.fixes_applied:
            return None
        return {k: v for k, v in self.fixes_applied[variable].items()
                if k in ["verdict", "errors_after", "duration_hours"]}

    def detect_regression_in_field(self, variable: str, current_value: str) -> bool:
        """Check if previously-fixed variable reverted."""
        if variable not in self.fixes_applied:
            return False
        fix = self.fixes_applied[variable]
        return current_value != fix.get("to")

    def calculate_improvement(self, variable: str) -> Dict:
        """Calculate pre-fix vs post-fix improvement."""
        if variable not in self.fixes_applied:
            return {}

        fix = self.fixes_applied[variable]
        # Find pre-fix error count
        pre_records = self.get_history(variable, fix["from"])
        pre_errors = pre_records[-1]["error_count"] if pre_records else 0

        post_errors = fix.get("errors_after", 0)
        reduction = 100 * (pre_errors - post_errors) / max(pre_errors, 1)

        return {
            "error_reduction_pct": reduction,
            "confidence": min(0.95, 0.5 + reduction / 100),
        }

    def analyze_culprit_trend(self, culprit: str) -> Dict:
        """Analyze pattern of culprit across bursts."""
        # Placeholder: would scan diagnostic history
        return {
            "frequency": 0,
            "consistency_pct": 0,
            "pattern": "unknown"
        }


def get_diagnosis(results: DiagnosisResult) -> Diagnosis:
    """Convert results to diagnosis with culprit ranking."""
    diagnosis = Diagnosis()

    # Simple rule-based mapping
    if results.get("layer_1_gateway") == "fail":
        diagnosis.culprit = "lan"
        diagnosis.is_definitive = True
        diagnosis.should_continue_testing = False

    elif results.get("layer_2_isp") == "fail":
        diagnosis.culprit = "isp"
        diagnosis.is_definitive = True

    elif results.get("layer_3_dns") == "both_fail":
        diagnosis.culprit = "dns"
        diagnosis.is_definitive = True

    else:
        dns_test = results.tests.get("layer_3_dns", {})

        if isinstance(dns_test, dict):
            router_info = dns_test.get("router", {})
            public_info = dns_test.get("public", {})

            router_state = router_info.get("state") if isinstance(router_info, dict) else router_info
            public_state = public_info.get("state") if isinstance(public_info, dict) else public_info

            if router_state == "fail" and public_state == "ok":
                diagnosis.culprit = "router_dns"
                diagnosis.confidence = 0.95
            elif router_state == "unavailable" and public_state == "ok":
                diagnosis.culprit = None
                diagnosis.note = "Router DNS unavailable; only public DNS tested"

    if results.get("layer_5_idle_hold") == "closed_by_peer":
        diagnosis.culprit = "connection_reaping"
        diagnosis.is_definitive = True

    if (results.get("layer_1_gateway") == "ok" and
        results.get("layer_2_isp") == "ok" and
        results.get("layer_3_dns") == "ok" and
        results.get("layer_4_tls") == "ok" and
        results.get("layer_5_idle_hold") == "still_alive"):
        diagnosis.note = "not_local"

    return diagnosis


def rank_hypotheses(results: DiagnosisResult) -> List[Dict]:
    """Rank possible causes by evidence quality."""
    # Placeholder implementation
    return []


def calculate_confidence_from_history(history: List[Dict], culprit: str, fix_applied: bool = False) -> float:
    """Calculate confidence in a culprit based on historical patterns.

    Args:
        history: List of diagnostic entries with culprit or status/fix_applied fields
        culprit: The suspected root cause to evaluate
        fix_applied: Whether a fix was applied for this culprit

    Returns:
        Confidence score from 0 to 1
    """
    if not history:
        return 0.0

    if fix_applied:
        found_fix = False
        errors_before = 0
        clean_after = 0
        fix_applied_idx = -1

        for i, entry in enumerate(history):
            if entry.get("fix_applied") == culprit:
                found_fix = True
                fix_applied_idx = i
                break

        if found_fix:
            errors_before = sum(1 for i in range(fix_applied_idx) if history[i].get("status") == "errors")
            clean_after = sum(1 for i in range(fix_applied_idx + 1, len(history)) if history[i].get("status") == "clean")

            if clean_after > 0 and errors_before > 0:
                return 0.99
            elif clean_after > 0:
                return 0.95

        return 0.0

    count = sum(1 for entry in history if entry.get("culprit") == culprit)
    frequency = count / len(history) if history else 0

    base_confidence = frequency * 0.95

    return min(1.0, base_confidence)


def correlate_with_history(
    errors: List[Dict],
    samples: List[Dict]
) -> List[Dict]:
    """Correlate errors with network samples."""
    correlations = []
    for error in errors:
        if not samples:
            correlations.append({"error": error, "verdict": "unmonitored"})
        else:
            # Find sample near error time (within ±120 seconds)
            for sample in samples:
                # Simplified correlation
                correlations.append({
                    "error": error,
                    "sample": sample,
                    "verdict": "correlated"
                })
    return correlations


def capture_baseline_snapshot() -> Dict:
    """Capture full system state snapshot."""
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "wifi_mode": None,
        "router_dpi": None,
        "modem_snr": None,
        "windows_power_profile": None,
        "tcp_autotuning": None,
        "mtu": None,
        "system_uptime": 0,
        "dns_servers": [],
    }


def compare_snapshots(snap1: Dict, snap2: Dict) -> Dict:
    """Find differences between snapshots."""
    delta = {"changed": {}, "unchanged": {}}
    for key in snap1:
        if snap1[key] != snap2.get(key):
            delta["changed"][key] = {
                "from": snap1[key],
                "to": snap2.get(key)
            }
        else:
            delta["unchanged"][key] = snap1[key]
    return delta


def detect_regressions(
    baseline: Dict,
    current: Dict,
    known_fixed_configs: List[str] = None
) -> List[Dict]:
    """Detect regressions: fixed configs that changed back.

    If known_fixed_configs is provided (even if empty), only check those fields.
    If not provided, check all fields in baseline and current.
    """
    regressions = []

    if known_fixed_configs is not None:
        for field in known_fixed_configs:
            if baseline.get(field) != current.get(field):
                regressions.append({
                    "field": field,
                    "previous_value": baseline.get(field),
                    "current_value": current.get(field),
                    "requires_attention": True
                })
    else:
        all_fields = set(baseline.keys()) | set(current.keys())
        for field in all_fields:
            if baseline.get(field) != current.get(field):
                regressions.append({
                    "field": field,
                    "previous_value": baseline.get(field),
                    "current_value": current.get(field),
                    "requires_attention": True
                })

    return regressions


def check_state_changes(baseline: Dict, current: Dict) -> str:
    """Note significant state changes."""
    if baseline.get("modem_uptime_hours", 0) > 24 and current.get("modem_uptime_hours", 0) < 24:
        return "Modem reboot detected"
    return ""


def generate_recommendation(diagnosis: Dict, matrix: ConfigurationMatrix) -> Dict:
    """Generate next recommended action."""
    if not diagnosis:
        return {"action": "monitor"}

    if diagnosis.get("culprit") == "router_dns":
        return {
            "action": "verify_router_dns",
            "target": "router",
            "instruction": "Check router DNS settings"
        }

    if matrix:
        next_test = matrix.suggest_next_test()
        if next_test.get("variable"):
            return {
                "action": "apply_fix",
                "target": next_test["variable"],
                "value": next_test.get("value"),
                "effort": next_test.get("effort", "unknown")
            }

    return {"action": "monitor"}


def rank_recommendations(candidates: List[Dict]) -> List[Dict]:
    """Rank recommendations by ROI."""
    def roi_score(c):
        impact = {"high": 3, "medium": 2, "low": 1}.get(c.get("impact"), 0)
        cost = {"low": 3, "medium": 2, "high": 1, "very_high": 0}.get(c.get("cost"), 0)
        return impact * cost

    return sorted(candidates, key=roi_score, reverse=True)
