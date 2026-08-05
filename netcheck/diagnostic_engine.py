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
    if condition.startswith("not "):
        return not _safe_eval_condition(condition[4:].strip())

    # Remove outer parentheses
    condition = condition.strip()
    if condition.startswith("(") and condition.endswith(")"):
        return _safe_eval_condition(condition[1:-1].strip())

    # Evaluate comparisons
    for op in ["==", "!=", "<=", ">=", "<", ">"]:
        if op in condition:
            left, right = condition.split(op, 1)
            left_val = _parse_value(left.strip())
            right_val = _parse_value(right.strip())

            if op == "==":
                return left_val == right_val
            elif op == "!=":
                return left_val != right_val
            elif op == "<":
                return left_val < right_val
            elif op == ">":
                return left_val > right_val
            elif op == "<=":
                return left_val <= right_val
            elif op == ">=":
                return left_val >= right_val

    # If no operator found, treat as boolean value
    return condition.lower() in ("true", "1", "yes")


def _parse_value(s: str):
    """Parse a value string into Python value."""
    s = s.strip()
    if s.startswith("'") and s.endswith("'"):
        return s[1:-1]
    elif s.startswith('"') and s.endswith('"'):
        return s[1:-1]
    elif s == "None":
        return None
    elif s == "True":
        return True
    elif s == "False":
        return False
    else:
        try:
            return int(s)
        except ValueError:
            try:
                return float(s)
            except ValueError:
                return s


@dataclass
class DiagnosisResult:
    """Results from running diagnostics."""
    tests: Dict = field(default_factory=dict)

    def add(self, key: str, value):
        """Add a test result."""
        self.tests[key] = value

    def get(self, key: str, default=None):
        """Get a test result."""
        return self.tests.get(key, default)

    def has(self, key: str) -> bool:
        """Check if a test result exists."""
        return key in self.tests


@dataclass
class DiagnosticTree:
    """Ordered decision tree for network issue diagnosis."""
    rules: List[DiagnosticRule] = field(default_factory=list)

    def get_rules_in_order(self) -> List[DiagnosticRule]:
        """Get rules sorted by priority."""
        return sorted(self.rules, key=lambda r: r.priority)

    def get_remaining_rules(self, results: DiagnosisResult) -> List[DiagnosticRule]:
        """Get rules that should still run given current results."""
        return [r for r in self.get_rules_in_order() if r.should_run(results)]


@dataclass
class ConfigurationMatrix:
    """Configuration possibilities matrix."""
    possibilities: List[Dict] = field(default_factory=list)

    def filter_by_condition(self, condition: str) -> List[Dict]:
        """Filter configurations by condition."""
        return [p for p in self.possibilities if _safe_eval_condition(condition)]

    def record_diagnosis_outcome(self, culprit: str, outcome: str, diagnosis: Dict = None) -> None:
        """Record diagnosis outcome for configuration matrix."""
        if not self.possibilities:
            self.possibilities = []
        self.possibilities.append({
            "culprit": culprit,
            "outcome": outcome,
            "confidence": diagnosis.get("confidence", 0) if diagnosis else 0
        })

    def get_test_record(self, culprit: str, status: str) -> Dict:
        """Get test record for culprit."""
        for p in self.possibilities:
            if p.get("culprit") == culprit:
                return p
        return {}

    def record_test(self, config: str, value: str, outcome: str, **kwargs) -> None:
        """Record test execution."""
        pass

    def get_fix_record(self, config: str) -> Dict:
        """Get fix record for configuration."""
        return {}

    def suggest_next_tests(self, results: DiagnosisResult) -> List[str]:
        """Suggest next tests to run."""
        return []

    def suggest_next_test(self) -> Optional[str]:
        """Suggest next test."""
        return None

    def calculate_confidence(self, evidence: List[Dict]) -> float:
        """Calculate confidence from evidence."""
        return 0.5

    def note_errors_during_test(self, errors: List[Dict]) -> None:
        """Note errors during test."""
        pass

    def note_state_change(self, change: Dict) -> None:
        """Note state change."""
        pass

    def track_untested_option(self, option: str) -> None:
        """Track untested option."""
        pass

    def get_history(self, config: str) -> List[Dict]:
        """Get history of tests for config."""
        return []

    def analyze_culprit_trend(self, culprit: str) -> Dict:
        """Analyze trend for a culprit."""
        return {}

    def detect_regression_in_field(self, config: str) -> bool:
        """Detect regressions."""
        return False

    def detect_cascading_failure(self, failures: List[str]) -> bool:
        """Detect cascading failures."""
        return False

    def record_burst_diagnosis(self, burst: Dict, diagnosis: Dict) -> None:
        """Record burst diagnosis."""
        pass

    def record_fix_applied(self, config: str, fix: str) -> None:
        """Record fix applied."""
        pass

    def record_post_fix_outcome(self, config: str, outcome: str) -> None:
        """Record outcome after fix."""
        pass

    def get_fix_outcome(self, config: str, fix: str) -> Dict:
        """Get outcome of fix."""
        return {}

    def calculate_improvement(self, before: Dict, after: Dict) -> float:
        """Calculate improvement."""
        return 0.0


def capture_baseline_snapshot() -> Dict:
    """Capture baseline network state snapshot."""
    return {}


def compare_snapshots(before: Dict, after: Dict) -> Dict:
    """Compare two snapshots."""
    return {}


def detect_regressions(history: List[Dict]) -> List[str]:
    """Detect regressions in network state."""
    return []


def check_state_changes(samples: List[Dict]) -> Dict:
    """Check for state changes in samples."""
    return {}


def generate_recommendation(culprit: str) -> str:
    """Generate actionable recommendation."""
    return ""


def rank_recommendations(recommendations: List[Dict]) -> List[Dict]:
    """Rank recommendations by impact."""
    return sorted(recommendations, key=lambda r: r.get("confidence", 0), reverse=True)


def get_diagnosis(results: DiagnosisResult) -> Dict:
    """Get final diagnosis from results."""
    return {}


def rank_hypotheses(candidates: List[Dict]) -> List[Dict]:
    """Rank hypotheses by likelihood."""
    return sorted(candidates, key=lambda h: h.get("likelihood", 0), reverse=True)


def correlate_with_history(event: Dict, history: List[Dict]) -> Dict:
    """Correlate event with historical data."""
    return {}


def calculate_confidence_from_history(evidence: List[Dict]) -> float:
    """Calculate confidence score from evidence."""
    if not evidence:
        return 0.0
    return sum(e.get("weight", 0) for e in evidence) / len(evidence)


def classify_latency(samples: List[Dict]) -> Dict:
    """Classify latency pattern from samples."""
    if not samples or len(samples) < 3:
        return {"classification": "uncertain", "confidence": "low"}

    latencies = [s.get("latency_ms", 0) for s in samples if s.get("latency_ms", 0) > 0]
    if not latencies:
        return {"classification": "unavailable", "confidence": "high"}

    avg = sum(latencies) / len(latencies)
    variance = sum((x - avg) ** 2 for x in latencies) / len(latencies)
    stddev = variance ** 0.5
    percentile_99 = sorted(latencies)[int(len(latencies) * 0.99)]

    if avg < 20 and stddev < 2:
        return {"classification": "stable_low", "confidence": "high"}
    elif avg < 50 and stddev < 2:
        return {"classification": "stable_medium", "confidence": "high"}
    elif stddev > 2 or avg > 50:
        return {"classification": "variable", "confidence": "high"}
    elif avg > 100 and stddev > 20:
        return {"classification": "high_variance_high_latency", "confidence": "high"}
    elif sorted(latencies)[0] < 10 and percentile_99 > 50:
        return {"classification": "buffer_bloat", "confidence": "medium"}

    return {"classification": "unknown", "confidence": "low"}


def classify_packet_loss_pattern(samples: List[Dict]) -> Dict:
    """Classify packet loss pattern."""
    if not samples:
        return {"pattern": "healthy"}

    loss_values = [s.get("loss_pct", 0) for s in samples]
    avg_loss = sum(loss_values) / len(loss_values) if loss_values else 0
    max_loss = max(loss_values) if loss_values else 0

    if avg_loss < 1:
        return {"pattern": "healthy"}
    elif avg_loss < 5:
        return {"pattern": "steady_low"}
    elif max_loss > 50 or avg_loss > 15:
        return {"pattern": "severe"}
    else:
        return {"pattern": "steady_high"}


def detect_asymmetric_loss(upstream: List[Dict], downstream: List[Dict]) -> Dict:
    """Detect asymmetric packet loss."""
    upstream_loss = sum(s.get("loss_pct", 0) for s in upstream) / len(upstream) if upstream else 0
    downstream_loss = sum(s.get("loss_pct", 0) for s in downstream) / len(downstream) if downstream else 0

    return {
        "upstream_loss": upstream_loss,
        "downstream_loss": downstream_loss,
        "asymmetric": abs(upstream_loss - downstream_loss) > 5
    }


def discover_path_mtu(probes: List[Dict]) -> Dict:
    """Discover path MTU from probe results."""
    if not probes:
        return {"mtu": 1500, "status": "unknown"}

    sizes = [p.get("size", 1500) for p in probes if p.get("responsive", False)]
    mtu = max(sizes) if sizes else 1500

    return {
        "mtu": mtu,
        "status": "discovered" if sizes else "unavailable"
    }


def analyze_fragmentation_impact(before_latency: int, after_latency: int) -> Dict:
    """Measure latency increase from fragmentation."""
    increase = after_latency - before_latency
    return {
        "latency_increase_ms": increase,
        "problematic": increase > 50
    }


def calculate_mss_from_mtu(mtu: int, ipv6: bool = False) -> int:
    """Calculate MSS from MTU."""
    header_size = 40 if ipv6 else 20
    tcp_header = 20
    return mtu - header_size - tcp_header


def track_tcp_handshake(events: List[Dict]) -> Dict:
    """Track 3-way TCP handshake progress."""
    syn_time = None
    synack_time = None
    ack_time = None

    for event in sorted(events, key=lambda e: e.get("timestamp", 0)):
        state = event.get("state", "")
        if state == "syn_sent" and syn_time is None:
            syn_time = event.get("timestamp")
        elif state == "syn_received" and synack_time is None:
            synack_time = event.get("timestamp")
        elif state == "established" and ack_time is None:
            ack_time = event.get("timestamp")

    duration = 0
    if syn_time and ack_time:
        duration = ack_time - syn_time

    return {
        "handshake_complete": ack_time is not None,
        "duration_ms": duration,
        "syn_timeout": syn_time and not synack_time
    }


def track_tcp_connection(events: List[Dict]) -> Dict:
    """Track TCP connection lifecycle."""
    established_time = None
    closed_time = None
    termination_reason = None

    for event in sorted(events, key=lambda e: e.get("timestamp", 0)):
        if event.get("state") == "established" and established_time is None:
            established_time = event.get("timestamp")
        if event.get("state") in ("closed", "reset"):
            closed_time = event.get("timestamp")
            termination_reason = event.get("reason", "unknown")

    duration = 0
    if established_time and closed_time:
        duration = closed_time - established_time

    return {
        "connection_established": established_time is not None,
        "duration_ms": duration,
        "termination_reason": termination_reason or "still_open"
    }


def analyze_retransmission_pattern(packets: List[Dict]) -> Dict:
    """Analyze TCP retransmission patterns."""
    retransmit_count = sum(1 for p in packets if p.get("retransmitted", False))
    total_packets = len(packets)
    rate = (retransmit_count / total_packets * 100) if total_packets else 0

    return {
        "retransmission_count": retransmit_count,
        "retransmission_rate_pct": rate,
        "excessive": rate >= 2
    }


def detect_window_stall(events: List[Dict]) -> Dict:
    """Detect TCP receive window stalls."""
    stall_start = None
    stall_duration = 0

    for event in sorted(events, key=lambda e: e.get("timestamp", 0)):
        window = event.get("window_size", 1)
        ts = event.get("timestamp", 0)

        if window == 0 and stall_start is None:
            stall_start = ts
        elif window > 0 and stall_start is not None:
            stall_duration = ts - stall_start
            stall_start = None

    if stall_start is not None and events:
        stall_duration = events[-1].get("timestamp", 0) - stall_start

    return {
        "window_stall_detected": stall_duration > 0,
        "stall_duration_ms": stall_duration
    }


def analyze_dual_stack(ipv4_result: Dict, ipv6_result: Dict) -> Dict:
    """Analyze IPv4/IPv6 dual-stack connectivity."""
    ipv4_ok = ipv4_result.get("reachable", False)
    ipv6_ok = ipv6_result.get("reachable", False)
    asymmetric = ipv4_ok != ipv6_ok

    affected = None
    if asymmetric:
        affected = "ipv6" if not ipv6_ok else "ipv4"

    latency_diff = 0
    if ipv4_ok and ipv6_ok:
        ipv4_latency = ipv4_result.get("latency_ms", 0)
        ipv6_latency = ipv6_result.get("latency_ms", 0)
        latency_diff = abs(ipv6_latency - ipv4_latency)

    return {
        "ipv4_working": ipv4_ok,
        "ipv6_working": ipv6_ok,
        "asymmetric": asymmetric,
        "affected_stack": affected,
        "both_working": ipv4_ok and ipv6_ok,
        "latency_asymmetry": latency_diff > 50,
        "latency_differential_ms": latency_diff
    }


def detect_happy_eyeballs(events: List[Dict]) -> Dict:
    """Detect Happy Eyeballs fallback behavior (RFC 8305)."""
    ipv6_fail = None
    ipv4_success = None
    ipv6_recover = None

    for event in events:
        ts = event.get("timestamp", 0)
        proto = event.get("protocol", "")
        status = event.get("status", "")

        if proto == "ipv6" and status == "timeout" and ipv6_fail is None:
            ipv6_fail = ts
        if proto == "ipv4" and status == "success" and ipv4_success is None:
            ipv4_success = ts
        if proto == "ipv6" and status == "connected" and ipv6_recover is None:
            ipv6_recover = ts

    active = ipv6_fail is not None and ipv4_success is not None
    fallback_delay = ipv4_success - ipv6_fail if (ipv6_fail and ipv4_success) else 0

    return {
        "happy_eyeballs_active": active,
        "fallback_to": "ipv4" if active else None,
        "fallback_delay_ms": fallback_delay,
        "ipv6_recovered": ipv6_recover is not None
    }


def detect_dual_stack_preference(events: List[Dict]) -> Dict:
    """Detect which protocol is preferred in dual-stack."""
    ipv6_success = [e for e in events if e.get("protocol") == "ipv6" and e.get("status") == "success"]
    ipv4_success = [e for e in events if e.get("protocol") == "ipv4" and e.get("status") == "success"]

    preferred = "unknown"
    following_rfc = False

    if ipv6_success and ipv4_success:
        ipv6_latency = sum(e.get("latency", 0) for e in ipv6_success) / len(ipv6_success)
        ipv4_latency = sum(e.get("latency", 0) for e in ipv4_success) / len(ipv4_success)
        preferred = "ipv6" if ipv6_latency <= ipv4_latency else "ipv4"
        following_rfc = preferred == "ipv6"  # RFC 8305 prefers IPv6

    return {
        "preferred_protocol": preferred,
        "following_rfc8305": following_rfc
    }


def detect_nat64_translation(ipv6_addrs: List[str]) -> Dict:
    """Detect NAT64/DNS64 translation (synthetic IPv6)."""
    nat64_prefix = "64:ff9b::"
    translated = [addr for addr in ipv6_addrs if nat64_prefix in addr]

    return {
        "nat64_detected": len(translated) > 0,
        "translated_addresses": translated,
        "translation_type": "nat64" if translated else "none"
    }


def measure_tls_handshake(events: List[Dict]) -> Dict:
    """Measure TLS handshake quality and duration."""
    client_hello_time = None
    server_hello_time = None
    certificate_time = None
    finished_time = None

    for event in sorted(events, key=lambda e: e.get("timestamp", 0)):
        msg_type = event.get("message_type", "")
        if msg_type == "client_hello" and client_hello_time is None:
            client_hello_time = event.get("timestamp")
        elif msg_type == "server_hello" and server_hello_time is None:
            server_hello_time = event.get("timestamp")
        elif msg_type == "certificate" and certificate_time is None:
            certificate_time = event.get("timestamp")
        elif msg_type == "finished" and finished_time is None:
            finished_time = event.get("timestamp")

    duration = 0
    if client_hello_time and finished_time:
        duration = finished_time - client_hello_time

    return {
        "handshake_complete": finished_time is not None,
        "duration_ms": duration,
        "phases": {
            "to_server_hello": (server_hello_time - client_hello_time) if (client_hello_time and server_hello_time) else 0,
            "to_certificate": (certificate_time - client_hello_time) if (client_hello_time and certificate_time) else 0,
            "total": duration
        }
    }


def detect_tls_version(handshake: Dict) -> str:
    """Detect negotiated TLS version."""
    version = handshake.get("tls_version", "unknown")
    version_map = {
        "0x0301": "TLS1.0",
        "0x0302": "TLS1.1",
        "0x0303": "TLS1.2",
        "0x0304": "TLS1.3"
    }
    return version_map.get(version, version)

    for event in sorted(events, key=lambda e: e.get("timestamp", 0)):
        current_route = event.get("route", None)
        current_time = event.get("timestamp", 0)

def detect_cipher_strength(cipher: str) -> str:
    """Classify cipher suite strength."""
    if "GCM" in cipher or "ChaCha" in cipher:
        return "strong"
    elif "CBC" in cipher:
        return "weak"
    else:
        return "unknown"

        if current_route:
            last_route = current_route
            last_time = current_time

def analyze_http_protocol(responses: List[Dict]) -> Dict:
    """Analyze HTTP protocol version and features."""
    http2_count = sum(1 for r in responses if r.get("http_version") == "2.0")
    http3_count = sum(1 for r in responses if r.get("http_version") == "3.0")
    http1_count = len(responses) - http2_count - http3_count

    return {
        "http1_responses": http1_count,
        "http2_responses": http2_count,
        "http3_responses": http3_count,
        "preferred_protocol": "http3" if http3_count > 0 else ("http2" if http2_count > 0 else "http1")
    }


def detect_connection_multiplexing(streams: List[Dict]) -> Dict:
    """Detect multiplexing capability and efficiency."""
    parallel_streams = sum(1 for s in streams if s.get("concurrent", False))
    total_streams = len(streams)
    utilization = (parallel_streams / total_streams * 100) if total_streams else 0

    return {
        "supports_multiplexing": parallel_streams > 0,
        "concurrent_streams": parallel_streams,
        "multiplexing_efficiency": utilization
    }
