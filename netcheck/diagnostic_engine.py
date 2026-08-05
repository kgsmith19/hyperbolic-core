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
        """Check if conditions are met to run this rule.

        Evaluates simple conditions like:
        - results.get('key') == 'value'
        - results.get('key') != 'value' and results.get('other') == 'ok'

        Uses safe parsing without eval() - no arbitrary code execution.
        """
        if not self.condition:
            return True

        # Extract all .get() calls and replace with actual values
        import re
        condition = self.condition

        # Find all results.get('key') patterns and replace with values
        for match in re.finditer(r"results\.get\('([^']+)'\)", condition):
            key = match.group(1)
            # Call the results.get() method (works for both dict and DiagnosisResult)
            value = results.get(key)
            # Convert to safe comparison string
            if value is None:
                safe_value = "None"
            elif isinstance(value, bool):
                safe_value = str(value)
            elif isinstance(value, str):
                safe_value = f"'{value}'"
            else:
                safe_value = repr(value)
            condition = condition.replace(match.group(0), safe_value)

        # Safely evaluate the condition by checking for dangerous patterns
        # Only allow: alphanumeric, quotes, parentheses, comparison operators, logical operators
        if not re.match(r"^['\"\w\s()=!<>&|+-]*$", condition):
            return False

        # Replace logical operators with Python equivalents
        condition = condition.replace(" and ", " and ")  # Already correct
        condition = condition.replace(" or ", " or ")    # Already correct

        try:
            # No eval() - instead use safe condition evaluator
            return _safe_eval_condition(condition)
        except Exception:
            return False


def _safe_eval_condition(condition: str) -> bool:
    """Safely evaluate a condition string without using eval()."""
    # This is a simple recursive descent parser for basic boolean expressions
    # Supports: 'value' == 'value', 'value' != 'value', and, or, not, parentheses
    import re

    # Recursively evaluate AND (lowest precedence)
    if " and " in condition:
        parts = condition.split(" and ")
        return all(_safe_eval_condition(p.strip()) for p in parts)

    # Recursively evaluate OR
    if " or " in condition:
        parts = condition.split(" or ")
        return any(_safe_eval_condition(p.strip()) for p in parts)

    # Handle NOT
    if condition.strip().startswith("not "):
        return not _safe_eval_condition(condition[4:].strip())

    # Handle parentheses
    if condition.startswith("(") and condition.endswith(")"):
        return _safe_eval_condition(condition[1:-1])

    # Handle comparisons: 'value' == 'value'
    for op in ["!=", "=="]:
        if op in condition:
            left, right = condition.split(op, 1)
            left = left.strip()
            right = right.strip()

            # Parse string literals
            left_val = _parse_value(left)
            right_val = _parse_value(right)

            if op == "==":
                return left_val == right_val
            else:  # !=
                return left_val != right_val

    return False


def _parse_value(s: str):
    """Parse a value string (handles string literals and None/True/False)."""
    s = s.strip()
    if s == "None":
        return None
    elif s == "True":
        return True
    elif s == "False":
        return False
    elif s.startswith("'") and s.endswith("'"):
        return s[1:-1]
    elif s.startswith('"') and s.endswith('"'):
        return s[1:-1]
    else:
        # Try to parse as literal
        try:
            import ast
            return ast.literal_eval(s)
        except (ValueError, SyntaxError):
            return s


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
        self.untested_options = {}  # {variable: {value: {impact, cost, feasibility}}}
        self.state_changes = []  # [{event, note, date}]
        self.burst_history = []  # List of burst diagnoses
        self.cascading_failures = {}  # {root: {downstream: [...]}

    def record_test(
        self,
        variable: str,
        value: str,
        outcome: str,
        error_count: int = None,
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

        # Handle missing error_count
        if error_count is None:
            error_count_val = None
            impact = self._calculate_impact_score(0, outcome)
        else:
            error_count_val = error_count
            impact = self._calculate_impact_score(error_count, outcome)

        record = {
            "variable": variable,
            "value": value,
            "outcome": outcome,
            "error_count": error_count_val,
            "duration_hours": duration_hours,
            "date": date or datetime.utcnow().isoformat(),
            "tested": True,
            "notes": notes,
            "impact_score": impact,
            "data_complete": error_count is not None,
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

    def _cost_to_effort(self, cost: float) -> str:
        """Convert numeric cost to effort level."""
        if cost <= 1:
            return "easy"
        elif cost <= 2:
            return "medium"
        else:
            return "hard"

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

    def record_diagnosis_outcome(self, culprit: str, outcome: str = "fail", diagnosis: Dict = None, **kwargs) -> None:
        """Record a diagnosed culprit as a test outcome."""
        confidence = diagnosis.get("confidence", 0.0) if diagnosis else 0.0
        # Use appropriate value for each culprit type
        value_map = {
            "router_dns": "enabled",
            "gateway": "up",
            "isp": "responding",
            "dns": "enabled",
            "wifi_mode": "tested",
            "modem": "working"
        }
        value = value_map.get(culprit, "tested")

        # Build notes including extra context like burst_num
        notes_parts = [f"Diagnosed with confidence {confidence}"]
        if "burst_num" in kwargs:
            notes_parts.append(f"(burst {kwargs['burst_num']})")

        self.record_test(
            variable=culprit,
            value=value,
            outcome=outcome,
            notes=", ".join(notes_parts),
        )
        if diagnosis and "confidence" in diagnosis:
            self.tests.setdefault(culprit, {}).setdefault(value, [])[-1]["confidence"] = confidence

    def track_untested_option(self, variable: str, value: str, impact: float, cost: float, feasibility: float = 1.0) -> None:
        """Track an untested option with its expected impact and cost."""
        if variable not in self.untested_options:
            self.untested_options[variable] = {}
        self.untested_options[variable][value] = {
            "impact": impact,
            "cost": cost,
            "feasibility": feasibility
        }

    def note_state_change(self, event: str, note: str = "") -> None:
        """Record when network state changes (e.g., modem restart)."""
        self.state_changes.append({
            "event": event,
            "note": note,
            "date": datetime.utcnow().isoformat()
        })

    def note_errors_during_test(self, variable: str, value: str, error_count: int) -> None:
        """Record errors that occurred during a specific test."""
        record = self.get_test_record(variable, value)
        if record:
            record["errors_during_test"] = error_count
            # Flag contradiction if outcome was ok but errors occurred
            if record.get("outcome") == "ok" and error_count > 0:
                record["unexpected_outcome"] = True
                record["note"] = "Inconclusive: outcome marked ok but errors still occurring"

    def suggest_next_tests(self, limit: int = 3, context: str = None) -> List[Dict]:
        """Return ranked list of suggested next tests (up to limit)."""
        suggestions = []

        # If matrix is empty, suggest baseline
        if not self.tests and not self.untested_options:
            return [{
                "type": "baseline",
                "variable": "all_layers",
                "value": "baseline_diagnostic",
                "effort": "medium",
                "reason": "Run baseline diagnostic (all network layers)"
            }]

        # Build suggestions from untested options
        for variable, values in self.untested_options.items():
            for value, config in values.items():
                roi = (config["impact"] * config["feasibility"]) / max(config["cost"], 1)
                suggestions.append({
                    "variable": variable,
                    "value": value,
                    "expected_impact": config["impact"],
                    "effort": self._cost_to_effort(config["cost"]),
                    "roi_score": roi,
                    "expected_outcome_if_success": f"If fixes errors -> {variable} is causal",
                    "expected_outcome_if_failure": f"If errors continue -> {variable} ruled out"
                })

        # Build suggestions from tested variables that had failures
        for variable, values in self.tests.items():
            for value, records in values.items():
                latest = records[-1] if records else None
                if latest and latest.get("outcome") == "fail":
                    # Find untested values for this variable
                    tested_values = set(self.tests.get(variable, {}).keys())
                    high_impact_vars = {
                        "wifi_mode": ["802.11ax", "802.11ac", "802.11n"],
                        "router_dns": ["enabled", "disabled"],
                        "modem": ["restart", "no_restart"],
                    }
                    if variable in high_impact_vars:
                        for alt_value in high_impact_vars[variable]:
                            if alt_value not in tested_values:
                                roi = 85 / 1  # High impact, low cost
                                suggestions.append({
                                    "variable": variable,
                                    "value": alt_value,
                                    "expected_impact": 85,
                                    "effort": "easy",
                                    "roi_score": roi,
                                    "expected_outcome_if_success": f"If fixes errors -> {variable}={alt_value} is causal",
                                    "expected_outcome_if_failure": f"If errors continue -> {variable} ruled out"
                                })

        # Sort by ROI and return top N
        ranked = sorted(suggestions, key=lambda s: -s.get("roi_score", 0))
        return ranked[:limit]

    def suggest_next_test(self, context: str = None) -> Dict:
        """Recommend highest-impact untested combination.

        Args:
            context: Optional context like "modem_restarted" to allow retesting
        """
        # If matrix is empty, suggest baseline
        if not self.tests and not self.untested_options:
            return {
                "type": "baseline",
                "variable": "all_layers",
                "value": "baseline_diagnostic",
                "effort": "medium",
                "reason": "Run baseline diagnostic (all network layers)"
            }

        high_impact_vars = {
            "wifi_mode": {
                "impact": 95,
                "possible_values": ["802.11ac", "802.11ax", "802.11n", "802.11a"],
                "effort": "easy"
            },
            "router_dns": {
                "impact": 90,
                "possible_values": ["enabled", "disabled"],
                "effort": "easy"
            },
            "modem": {
                "impact": 85,
                "possible_values": ["restart", "no_restart"],
                "effort": "medium"
            },
        }

        # First pass: suggest retesting failed variables
        for var, config in high_impact_vars.items():
            if var in self.tests:
                tested_values = set(self.tests[var].keys())

                # Check if any value succeeded
                any_succeeded = any(
                    records[-1]["outcome"] == "success"
                    for records in self.tests[var].values() if records
                )

                # Don't suggest retesting if any value succeeded (problem already fixed)
                # Unless network state changed significantly
                if any_succeeded and context != "modem_restarted":
                    continue

                any_failed = any(
                    records[-1]["outcome"] == "fail"
                    for records in self.tests[var].values() if records
                )

                if any_failed:
                    untested = [v for v in config["possible_values"] if v not in tested_values]
                    if untested:
                        return {
                            "variable": var,
                            "value": untested[0],
                            "expected_impact": config["impact"],
                            "effort": config["effort"],
                            "expected_outcome_if_success": f"If fixes errors -> {var} is causal",
                            "expected_outcome_if_failure": f"If errors continue -> {var} ruled out"
                        }

        # If network state changed (modem restart), suggest retesting key variables
        if context == "modem_restarted":
            # Retest router_dns after major network change
            if "router_dns" in self.tests:
                return {
                    "variable": "router_dns",
                    "value": "queried",
                    "expected_impact": 90,
                    "effort": "easy",
                    "expected_outcome_if_success": "If works -> DNS recovered after restart",
                    "expected_outcome_if_failure": "If fails -> DNS issue persists after restart"
                }

        # Second pass: if no failures found, suggest untested high-impact variables
        for var, config in high_impact_vars.items():
            if var not in self.tests:
                # Variable not tested yet, suggest testing it
                return {
                    "variable": var,
                    "value": config["possible_values"][0],
                    "expected_impact": config["impact"],
                    "effort": config["effort"],
                    "expected_outcome_if_success": f"If fixes errors -> {var} is causal",
                    "expected_outcome_if_failure": f"If errors continue -> {var} ruled out"
                }

        return {"action": "monitor"}

    def record_fix_applied(
        self,
        variable: str,
        from_value: str,
        to_value: str,
        method: str = "manual",
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
        verdict: str = None,
        date: str = None
    ):
        """Record outcome after fix applied."""
        if variable in self.fixes_applied:
            # Infer verdict from errors_after if not provided
            if verdict is None:
                verdict = "success" if errors_after == 0 else "partial" if errors_after < 5 else "failed"

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

        # Higher confidence for complete reduction
        if reduction >= 100:
            confidence = 0.99
        elif reduction >= 80:
            confidence = 0.95
        else:
            confidence = 0.5 + reduction / 100

        return {
            "error_reduction_pct": reduction,
            "confidence": min(0.99, confidence),
        }

    def analyze_culprit_trend(self, culprit: str) -> Dict:
        """Analyze pattern of culprit across bursts."""
        # Placeholder: would scan diagnostic history
        return {
            "frequency": 0,
            "consistency_pct": 0,
            "pattern": "unknown"
        }

    def calculate_confidence(self, culprit: str) -> float:
        """Calculate confidence in a culprit based on historical frequency."""
        if culprit not in self.tests:
            return 0.0

        # Count how many times this culprit was diagnosed
        outcomes = self.tests[culprit]
        fail_count = 0
        total_count = 0

        for value, records in outcomes.items():
            for record in records:
                total_count += 1
                if record.get("outcome") == "fail":
                    fail_count += 1

        if total_count == 0:
            return 0.0

        frequency = fail_count / total_count
        # Base confidence on how consistently this culprit failed
        return min(0.99, frequency * 0.95)

    def record_burst_diagnosis(self, burst: Dict) -> None:
        """Record a burst with component states and dependencies.

        Args:
            burst: {
                "component_name": {"cause": bool} or {"failed_after": "upstream_component"}
            }
        """
        self.burst_history.append({
            "burst": burst,
            "date": datetime.utcnow().isoformat(),
            "burst_num": len(self.burst_history) + 1
        })

        # Detect cascading if there are dependencies
        root_causes = []
        for component, details in burst.items():
            if isinstance(details, dict):
                if details.get("cause"):  # This is a root cause
                    root_causes.append(component)

        for root in root_causes:
            downstream = []
            for component, details in burst.items():
                if isinstance(details, dict):
                    if details.get("failed_after") == root:
                        downstream.append(component)

            if downstream:
                if root not in self.cascading_failures:
                    self.cascading_failures[root] = {"downstream": []}
                self.cascading_failures[root]["downstream"].extend(downstream)

    def detect_cascading_failure(self) -> Dict:
        """Detect if there's a cascading failure pattern."""
        if not self.burst_history:
            return {"root": None, "downstream": []}

        # Get the most recent burst
        latest_burst = self.burst_history[-1]["burst"]

        # Find root causes (marked with "cause": True)
        for component, details in latest_burst.items():
            if isinstance(details, dict) and details.get("cause"):
                downstream = []
                for other_comp, other_details in latest_burst.items():
                    if isinstance(other_details, dict):
                        if other_details.get("failed_after") == component:
                            downstream.append(other_comp)

                if downstream:
                    return {"root": component, "downstream": downstream}

        return {"root": None, "downstream": []}

    def analyze_culprit_trend(self, culprit: str) -> Dict:
        """Analyze pattern of culprit across bursts.

        Returns: {
            "frequency": count of times culprit appeared,
            "consistency_pct": percentage of bursts where culprit appeared,
            "pattern": "transient" if < 50%, "systematic" if >= 50% or None if always None
        }
        """
        # First check if we have diagnosis outcomes recorded
        if culprit in self.tests:
            appearances = 0
            total = 0

            # Count outcomes from recorded diagnoses
            for value, records in self.tests[culprit].items():
                for record in records:
                    outcome = record.get("outcome")
                    total += 1  # Count all records including None
                    # Count any outcome that was actually tested (not None)
                    if outcome is not None:
                        appearances += 1

            if total == 0:
                return {
                    "frequency": 0,
                    "consistency_pct": 0,
                    "pattern": "unknown"
                }

            consistency = (appearances / total) * 100 if total > 0 else 0

            # Classify pattern
            if consistency == 0:
                pattern = "non-existent"
            elif consistency < 50:
                pattern = "transient"
            else:
                pattern = "systematic"

            return {
                "frequency": appearances,
                "consistency_pct": int(consistency),
                "pattern": pattern
            }

        # Fallback to burst history if available
        if not self.burst_history:
            return {
                "frequency": 0,
                "consistency_pct": 0,
                "pattern": "unknown"
            }

        appearances = 0
        not_none_count = 0

        for burst_entry in self.burst_history:
            burst = burst_entry["burst"]

            if culprit in burst:
                outcome = burst[culprit].get("outcome") if isinstance(burst[culprit], dict) else burst[culprit]
                if outcome is not None:
                    not_none_count += 1
                    if outcome == "fail" or isinstance(burst[culprit], dict) and burst[culprit].get("cause"):
                        appearances += 1

        total = len(self.burst_history)

        if total == 0:
            return {
                "frequency": 0,
                "consistency_pct": 0,
                "pattern": "unknown"
            }

        consistency = (appearances / total) * 100 if total > 0 else 0

        # Classify pattern
        if consistency == 0:
            pattern = "non-existent"
        elif consistency < 50:
            pattern = "transient"
        else:
            pattern = "systematic"

        return {
            "frequency": appearances,
            "consistency_pct": int(consistency),
            "pattern": pattern
        }


def get_diagnosis(results: DiagnosisResult) -> Diagnosis:
    """Convert results to diagnosis with culprit ranking."""
    diagnosis = Diagnosis()

    if results.tests:
        all_unavailable = all(
            result_data.get("state") == "unavailable" if isinstance(result_data, dict) else result_data == "unavailable"
            for result_data in results.tests.values()
        )
        if all_unavailable and len(results.tests) >= 5:
            diagnosis.note = "inconclusive"
            return diagnosis

    gw_state = results.get("layer_1_gateway")
    if gw_state == "fail":
        diagnosis.culprit = "lan"
        diagnosis.is_definitive = True
        diagnosis.should_continue_testing = False
    elif gw_state == "timeout":
        diagnosis.note = "lan_slow"
        diagnosis.is_definitive = True
        diagnosis.should_continue_testing = False
    elif gw_state == "unreachable":
        diagnosis.note = "lan_down"
        diagnosis.is_definitive = True
        diagnosis.should_continue_testing = False

    elif results.get("layer_2_isp") == "fail":
        diagnosis.culprit = "isp"
        diagnosis.is_definitive = True

    elif results.get("layer_3_dns") == "both_fail":
        diagnosis.culprit = "dns"
        diagnosis.is_definitive = True
        diagnosis.should_continue_testing = False

    else:
        dns_test = results.tests.get("layer_3_dns", {})

        if isinstance(dns_test, dict):
            router_info = dns_test.get("router", {})
            public_info = dns_test.get("public", {})

            router_state = router_info.get("state") if isinstance(router_info, dict) else router_info
            public_state = public_info.get("state") if isinstance(public_info, dict) else public_info

            if router_state == "fail" and public_state not in ["fail"]:
                diagnosis.culprit = "router_dns"
                diagnosis.confidence = 0.95 if public_state == "ok" else 0.80
            elif router_state == "unavailable" and public_state == "ok":
                diagnosis.culprit = None
                diagnosis.note = "Router DNS unavailable; only public DNS tested"

    if results.get("layer_5_idle_hold") == "closed_by_peer":
        diagnosis.culprit = "connection_reaping"
        diagnosis.is_definitive = True

    # If local layers ok but far end fails, it's upstream
    if (results.get("layer_1_gateway") == "ok" and
        results.get("layer_2_isp") == "ok" and
        results.get("layer_3_dns") == "ok" and
        results.get("layer_4_tls") == "fail"):
        diagnosis.culprit = "upstream"
        diagnosis.is_definitive = True

    if (results.get("layer_1_gateway") == "ok" and
        results.get("layer_2_isp") == "ok" and
        results.get("layer_3_dns") == "ok" and
        results.get("layer_4_tls") == "ok" and
        results.get("layer_5_idle_hold") == "still_alive"):
        diagnosis.note = "not_local"

    return diagnosis


def rank_hypotheses(results: DiagnosisResult) -> List[Dict]:
    """Rank possible causes by evidence quality.

    Ranking: specificity > frequency > reversibility > confidence
    """
    hypotheses = []

    if results.get("layer_1_gateway") == "fail":
        hypotheses.append({
            "cause": "lan",
            "confidence": "high",
            "specificity": 10,
            "evidence": "Gateway unreachable",
        })

    if results.get("layer_2_isp") == "fail":
        hypotheses.append({
            "cause": "isp",
            "confidence": "high",
            "specificity": 9,
            "evidence": "ISP hop unreachable",
        })

    # Handle DNS test result - can be string like "router_fail_public_ok" or dict
    dns_state = results.get("layer_3_dns")
    if dns_state == "router_fail_public_ok":
        hypotheses.append({
            "cause": "router_dns",
            "confidence": "high",
            "specificity": 8,
            "evidence": "Router DNS fails, public DNS works",
        })
    elif dns_state == "both_fail":
        hypotheses.append({
            "cause": "dns",
            "confidence": "high",
            "specificity": 7,
            "evidence": "Both DNS resolvers fail",
        })
    elif dns_state == "router_unavailable_public_ok":
        # Router unavailable means we can't measure it, never blame it
        pass
    else:
        # Also handle dict format for DNS results
        dns_test = results.tests.get("layer_3_dns", {})
        if isinstance(dns_test, dict) and "state" not in dns_test:  # dict format with router/public keys
            router_info = dns_test.get("router", {})
            public_info = dns_test.get("public", {})
            router_state = router_info.get("state") if isinstance(router_info, dict) else router_info
            public_state = public_info.get("state") if isinstance(public_info, dict) else public_info

            if router_state == "fail" and public_state == "ok":
                hypotheses.append({
                    "cause": "router_dns",
                    "confidence": "high",
                    "specificity": 8,
                    "evidence": "Router DNS fails, public DNS works",
                })

    if results.get("drill_wifi_mode") == "fail":
        hypotheses.append({
            "cause": "wifi_mode",
            "confidence": "medium",
            "specificity": 8,
            "evidence": "Wi-Fi adapter not on optimal mode",
        })

    if results.get("drill_interference") in ["high", "detected"]:
        hypotheses.append({
            "cause": "interference",
            "confidence": "medium",
            "specificity": 7,
            "evidence": "Co-channel interference detected",
        })

    if results.get("layer_4_tls") == "fail":
        hypotheses.append({
            "cause": "tls_interception",
            "confidence": "low",
            "specificity": 5,
            "evidence": "TLS handshake fails",
        })

    if results.get("layer_5_idle_hold") == "closed_by_peer":
        hypotheses.append({
            "cause": "connection_reaping",
            "confidence": "high",
            "specificity": 9,
            "evidence": "Long-lived connections terminated",
        })

    confidence_order = {"high": 0, "medium": 1, "low": 2}
    return sorted(hypotheses, key=lambda h: (-h.get("specificity", 0), confidence_order.get(h.get("confidence"), 2)))


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
            "primary": "router_dns",
            "target": "router",
            "instruction": "Check router DNS settings and ensure public DNS is configured"
        }

    if matrix:
        next_test = matrix.suggest_next_test()
        if next_test.get("variable"):
            value = next_test.get("value")
            variable = next_test["variable"]
            instruction = f"Test {variable} = {value}"

            # Calculate confidence based on error rate history
            total_errors = 0
            if variable in matrix.tests:
                for value_records in matrix.tests[variable].values():
                    for record in value_records:
                        if record.get("error_count"):
                            total_errors += record["error_count"]
            confidence_level = "high" if total_errors >= 10 else "medium" if total_errors >= 5 else "low"

            return {
                "action": "apply_fix",
                "primary": variable,
                "target": variable,
                "value": value,
                "instruction": instruction,
                "effort": next_test.get("effort", "unknown"),
                "confidence": confidence_level
            }

    return {"action": "monitor"}


def rank_recommendations(candidates: List[Dict]) -> List[Dict]:
    """Rank recommendations by ROI."""
    def roi_score(c):
        impact = {"high": 3, "medium": 2, "low": 1}.get(c.get("impact"), 0)
        cost = {"low": 3, "medium": 2, "high": 1, "very_high": 0}.get(c.get("cost"), 0)
        return impact * cost

    return sorted(candidates, key=roi_score, reverse=True)
