"""Regression monitoring: continuous validation of network health.

Workflow:
1. Schedule periodic diagnostic snapshots
2. Compare new snapshots against baseline
3. Detect if culprit returns or new issues emerge
4. Alert when regression is detected
5. Recommend re-applying fixes
"""
from typing import Dict, List, Tuple
from datetime import datetime, timedelta


def schedule_periodic_monitoring(interval_hours: int = 1) -> Dict:
    """Schedule periodic network diagnostics to detect regression.

    Returns {
        "monitor_id": str,
        "interval_hours": int,
        "next_check": str (ISO timestamp),
        "snapshots": [],
        "status": "scheduled"
    }
    """
    next_check = datetime.now() + timedelta(hours=interval_hours)
    return {
        "monitor_id": f"monitor_{int(datetime.now().timestamp())}",
        "interval_hours": interval_hours,
        "next_check": next_check.isoformat(),
        "snapshots": [],
        "status": "scheduled"
    }


def detect_regression(
    baseline_diagnosis: Dict,
    current_diagnosis: Dict,
    sensitivity: float = 0.3
) -> Dict:
    """Detect if issue has returned (regression) or new issue appeared.

    sensitivity: threshold [0,1] for how much confidence increase triggers alert
                 0.3 = 30% confidence increase from baseline = regression alert

    Returns {
        "regression_detected": bool,
        "culprit": str or None,
        "confidence_increase": float,
        "alert": str,
        "recommended_action": str,
        "severity": str ("low", "medium", "high"),
        "timestamp": str
    }
    """
    baseline_culprit = baseline_diagnosis.get("primary_culprit")
    baseline_confidence = baseline_diagnosis.get("synthesis_confidence", 0.0)

    current_culprit = current_diagnosis.get("primary_culprit")
    current_confidence = current_diagnosis.get("synthesis_confidence", 0.0)

    # Regression: same culprit returns
    culprit_returned = baseline_culprit and current_culprit == baseline_culprit
    confidence_increased = current_confidence - baseline_confidence
    high_jump = confidence_increased >= sensitivity

    regression = culprit_returned

    if regression:
        alert = f"Regression: {current_culprit} returned with {current_confidence:.0%} confidence"
        severity = "high" if confidence_increased > 0.5 else "medium"
    elif current_culprit and not baseline_culprit:
        alert = f"New issue: {current_culprit} at {current_confidence:.0%} confidence"
        severity = "high"
    elif current_culprit and current_culprit != baseline_culprit:
        alert = f"Issue changed: {baseline_culprit} → {current_culprit}"
        severity = "medium"
    else:
        alert = "Network healthy"
        severity = "low"

    action = "Re-apply fixes" if regression else "Monitor" if current_culprit else "No action needed"

    return {
        "regression_detected": regression,
        "culprit": current_culprit,
        "confidence_increase": confidence_increased,
        "alert": alert,
        "recommended_action": action,
        "severity": severity,
        "timestamp": datetime.now().isoformat()
    }


def track_diagnosis_history(
    diagnosis_snapshots: List[Dict],
    window_hours: int = 24
) -> Dict:
    """Analyze diagnosis history over a time window to identify patterns.

    Returns {
        "analysis_period_hours": int,
        "snapshot_count": int,
        "culprits_observed": [str],
        "culprit_frequencies": {str: int},
        "confidence_trend": str ("improving", "stable", "degrading"),
        "issues": [str],
        "pattern_summary": str
    }
    """
    if not diagnosis_snapshots:
        return {
            "analysis_period_hours": window_hours,
            "snapshot_count": 0,
            "culprits_observed": [],
            "culprit_frequencies": {},
            "confidence_trend": "unknown",
            "issues": [],
            "pattern_summary": "No data"
        }

    culprits = []
    confidences = []

    for snap in diagnosis_snapshots:
        culprit = snap.get("primary_culprit")
        if culprit:
            culprits.append(culprit)
        conf = snap.get("synthesis_confidence", 0.0)
        confidences.append(conf)

    # Calculate culprit frequencies
    culprit_freq = {}
    for c in culprits:
        culprit_freq[c] = culprit_freq.get(c, 0) + 1

    # Determine trend
    if len(confidences) >= 2:
        first_half_avg = sum(confidences[:len(confidences)//2]) / max(1, len(confidences)//2)
        second_half_avg = sum(confidences[len(confidences)//2:]) / max(1, len(confidences) - len(confidences)//2)
        if second_half_avg < first_half_avg - 0.1:
            trend = "improving"
        elif second_half_avg > first_half_avg + 0.1:
            trend = "degrading"
        else:
            trend = "stable"
    else:
        trend = "unknown"

    # Identify issues: culprits appearing multiple times or with high confidence
    issues = []
    for culprit, freq in culprit_freq.items():
        if freq >= 2:
            issues.append(f"{culprit} ({freq} occurrences)")

    pattern_summary = f"{len(culprits)} samples over {window_hours}h; trend={trend}; issues: {len(issues)}"

    return {
        "analysis_period_hours": window_hours,
        "snapshot_count": len(diagnosis_snapshots),
        "culprits_observed": list(set(culprits)),
        "culprit_frequencies": culprit_freq,
        "confidence_trend": trend,
        "issues": issues,
        "pattern_summary": pattern_summary
    }


def predict_next_regression(
    diagnosis_history: List[Dict],
    fixed_culprit: str,
    recurrence_window_hours: int = 4
) -> Dict:
    """Predict likelihood of regression for a fixed issue.

    Returns {
        "fixed_culprit": str,
        "recurrence_probability": float [0, 1],
        "predicted_recurrence_hours": int,
        "confidence": str ("high", "medium", "low"),
        "rationale": str,
        "monitoring_recommendation": str
    }
    """
    if not diagnosis_history:
        return {
            "fixed_culprit": fixed_culprit,
            "recurrence_probability": 0.2,
            "predicted_recurrence_hours": recurrence_window_hours,
            "confidence": "low",
            "rationale": "Insufficient history",
            "monitoring_recommendation": "Monitor baseline"
        }

    # Calculate against total observations (including healthy/None states)
    recurrences = sum(1 for d in diagnosis_history if d.get("primary_culprit") == fixed_culprit)
    total_observations = len(diagnosis_history)

    if total_observations == 0:
        prob = 0.1
        conf = "low"
        rationale = "No observations"
    else:
        prob = recurrences / total_observations
        if prob > 0.5:
            conf = "high"
            rationale = f"Issue recurs in {prob:.0%} of observations"
        elif prob > 0.2:
            conf = "medium"
            rationale = f"Issue recurs occasionally ({prob:.0%})"
        else:
            conf = "low"
            rationale = f"Low recurrence rate ({prob:.0%})"

    pred_hours = min(recurrence_window_hours, max(1, int(recurrence_window_hours * (1 - prob))))

    return {
        "fixed_culprit": fixed_culprit,
        "recurrence_probability": prob,
        "predicted_recurrence_hours": pred_hours,
        "confidence": conf,
        "rationale": rationale,
        "monitoring_recommendation": (
            "Intensive monitoring (30 min intervals)" if prob > 0.5
            else "Standard monitoring (1-2 hour intervals)" if prob > 0.2
            else "Relaxed monitoring (4-6 hour intervals)"
        )
    }


def generate_monitoring_report(
    baseline: Dict,
    current: Dict,
    history: List[Dict]
) -> Dict:
    """Generate comprehensive monitoring report."""
    regression = detect_regression(baseline, current)
    analysis = track_diagnosis_history(history)
    prediction = predict_next_regression(history, baseline.get("primary_culprit", ""))

    return {
        "report_timestamp": datetime.now().isoformat(),
        "regression_status": regression,
        "history_analysis": analysis,
        "recurrence_prediction": prediction,
        "overall_status": (
            "ALERT: Regression detected" if regression["regression_detected"]
            else "WARNING: New issue detected" if regression["culprit"]
            else "HEALTHY: No issues detected"
        ),
        "next_recommended_check": (
            datetime.now() + timedelta(hours=prediction["predicted_recurrence_hours"])
        ).isoformat()
    }
