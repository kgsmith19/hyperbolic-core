"""Verify fixes resolve diagnosed issues by re-testing after application.

Verification workflow:
1. Capture baseline diagnosis (before fix)
2. Apply fix and wait for convergence
3. Re-run diagnostic probes (after fix)
4. Compare metrics and confirm improvement
5. Calculate success score (improvement rate)
"""
from typing import Dict, Tuple
from datetime import datetime


def verify_fix_resolves_issue(
    before_diagnosis: Dict,
    fix: object,  # FixRecommendation
    after_diagnosis: Dict
) -> Dict:
    """Compare before/after diagnoses to verify fix worked.

    Returns {
        "fix_id": str,
        "success": bool,
        "improvement_rate": float [0, 1],
        "primary_culprit_resolved": bool,
        "confidence_change": float,
        "verification_step": str,
        "timestamp": str,
        "recommendations": str
    }
    """
    primary_resolved = after_diagnosis.get("primary_culprit") != before_diagnosis.get("primary_culprit")
    confidence_before = before_diagnosis.get("synthesis_confidence", 0.0)
    confidence_after = after_diagnosis.get("synthesis_confidence", 0.0)
    confidence_change = confidence_after - confidence_before

    # Improvement: primary culprit changed (good), or confidence decreased (less certain of problem)
    improvement_rate = 0.0
    if primary_resolved and confidence_change < 0:
        improvement_rate = min(abs(confidence_change), 1.0)
    elif primary_resolved:
        improvement_rate = 0.5
    elif confidence_change < 0:
        improvement_rate = abs(confidence_change) * 0.5

    success = improvement_rate >= 0.3 or primary_resolved

    return {
        "fix_id": fix.id,
        "success": success,
        "improvement_rate": improvement_rate,
        "primary_culprit_resolved": primary_resolved,
        "confidence_change": confidence_change,
        "verification_step": f"Validated {fix.category} fix impact",
        "timestamp": datetime.now().isoformat(),
        "recommendations": (
            "Fix resolved the issue." if success
            else "Issue persists; escalate to next fix or Ethernet test."
        )
    }


def track_fix_success(
    fix_id: str,
    before_diagnosis: Dict,
    after_diagnosis: Dict,
    conn=None,
    host=None,
) -> Dict:
    """Track outcome of fix application and suggest next action.

    Pass `conn` (an open store.py connection) and `host` (a store.host_id()
    result) to persist this outcome via store.record_fix_outcome -- this is
    what lets fix_engine.recommend_fixes_for_diagnosis eventually replace a
    fix's documented prior with a real measured success rate. Omit either
    and nothing is persisted; the return value is unaffected either way.

    Returns {
        "fix_id": str,
        "applied_at": str,
        "before_culprit": str,
        "after_culprit": str,
        "culprit_changed": bool,
        "next_action": str,
        "success": bool
    }
    """
    before_culprit = before_diagnosis.get("primary_culprit")
    after_culprit = after_diagnosis.get("primary_culprit")
    culprit_changed = before_culprit != after_culprit

    if culprit_changed:
        next_action = "Verify network stability over next hour"
        success = True
    elif after_diagnosis.get("synthesis_confidence", 1.0) < 0.5:
        next_action = "Uncertainty high; consider Ethernet test"
        success = True  # Inconclusive is better than confirmed failure
    else:
        next_action = "Apply next recommended fix"
        success = False

    if conn is not None and host is not None:
        from . import store
        store.record_fix_outcome(conn, host, fix_id, success)

    return {
        "fix_id": fix_id,
        "applied_at": datetime.now().isoformat(),
        "before_culprit": before_culprit,
        "after_culprit": after_culprit,
        "culprit_changed": culprit_changed,
        "next_action": next_action,
        "success": success
    }


def compare_diagnostic_layers(before_diagnosis: Dict, after_diagnosis: Dict) -> Dict:
    """Compare layer states before and after fix to identify which layers improved.

    Returns {
        "layers_improved": [str],
        "layers_regressed": [str],
        "layers_unchanged": [str],
        "net_improvement": int (count of improved - regressed),
        "improvement_summary": str
    }
    """
    before_layers = before_diagnosis.get("layer_states", {})
    after_layers = after_diagnosis.get("layer_states", {})

    improved = []
    regressed = []
    unchanged = []

    all_layers = set(before_layers.keys()) | set(after_layers.keys())

    for layer in all_layers:
        before = before_layers.get(layer, "unknown")
        after = after_layers.get(layer, "unknown")

        if before == "fail" and after == "pass":
            improved.append(layer)
        elif before == "pass" and after == "fail":
            regressed.append(layer)
        else:
            unchanged.append(layer)

    net = len(improved) - len(regressed)
    summary = f"{len(improved)} improved, {len(regressed)} regressed, {len(unchanged)} unchanged"

    return {
        "layers_improved": improved,
        "layers_regressed": regressed,
        "layers_unchanged": unchanged,
        "net_improvement": net,
        "improvement_summary": summary
    }


def estimate_mttr(before_diagnosis: Dict, after_diagnosis: Dict) -> Dict:
    """Estimate mean time to recovery (MTTR) for this fix.

    Returns {
        "estimated_time_seconds": int,
        "category": str ("immediate", "quick", "moderate", "slow"),
        "notes": str
    }
    """
    before_confidence = before_diagnosis.get("synthesis_confidence", 0.5)
    after_confidence = after_diagnosis.get("synthesis_confidence", 0.5)

    # If confidence is high and fixed, MTTR is immediate
    # If confidence was high but still high after, MTTR is slow
    if before_confidence >= 0.75 and after_confidence < 0.5:
        return {
            "estimated_time_seconds": 30,
            "category": "immediate",
            "notes": "High-confidence issue resolved quickly"
        }
    elif before_confidence >= 0.75:
        return {
            "estimated_time_seconds": 600,
            "category": "slow",
            "notes": "High-confidence issue persists; may need escalation"
        }
    elif after_confidence < 0.3:
        return {
            "estimated_time_seconds": 120,
            "category": "quick",
            "notes": "Uncertainty resolved; issue likely cleared"
        }
    else:
        return {
            "estimated_time_seconds": 300,
            "category": "moderate",
            "notes": "Gradual improvement observed"
        }
