"""Canonical bill and EOB candidate records for the bills test tier.

Both builders were defined identically in test_verification.py and
test_dispute.py. They describe the same two fixtures -- a clean medical bill
and the EOB that answers it -- and the reconciliation tests and the dispute
tests need them to agree, since a dispute is raised against exactly what the
verifier compared. One definition keeps that guaranteed rather than hoped for.
"""

from typing import Any


def bill_record(**overrides: Any) -> dict[str, Any]:
    """A clean, internally consistent medical bill: one line, and a total that
    matches it."""
    record: dict[str, Any] = {
        "category": "medical",
        "issuer": "Mercy Clinic",
        "account_ref": "ACCT-1",
        "service_date": "2026-03-04",
        "due_date": "2026-04-01",
        "currency": "USD",
        "total": "128.40",
        "line_items": [{"code": "99213", "quantity": "1", "amount": "128.40"}],
        "confidence": 0.8,
        "low_confidence_fields": [],
    }
    return {**record, **overrides}


def eob_record(**overrides: Any) -> dict[str, Any]:
    """A clean EOB: the split is complete and the allowed amount sits under the
    billed one."""
    record: dict[str, Any] = {
        "payer": "Blue Shield",
        "claim_no": "CLM-1",
        "service_date": "2026-03-04",
        "currency": "USD",
        "line_items": [
            {
                "code": "99213",
                "quantity": "1",
                "billed": "200.00",
                "allowed": "150.00",
                "plan_paid": "120.00",
                "patient_resp": "30.00",
            }
        ],
        "confidence": 0.8,
        "low_confidence_fields": [],
    }
    return {**record, **overrides}
