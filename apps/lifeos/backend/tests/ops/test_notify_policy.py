"""Notification delivery policy acceptance tests (#593). Pure, no fixtures."""

from datetime import datetime, time, timedelta

import pytest

from domains.ops.notify_policy import Delivery, Notice, Policy, decide, transition

NOON = datetime(2026, 11, 12, 12, 0)
POLICY = Policy(
    opted_in=frozenset({"bills", "appointments"}),
    quiet_start=time(22, 0),
    quiet_end=time(7, 0),
    anchors=((time(18, 0), time(19, 0)),),
    ack_timeout=timedelta(minutes=10),
    max_attempts=2,
)
BILL = Notice("bill:electric:2026-11-20", "bills")
URGENT = Notice("bill:rent:2026-11-13", "bills", urgent=True)


def at(hour: int, minute: int = 0) -> datetime:
    return NOON.replace(hour=hour, minute=minute)


def test_not_opted_in_is_dropped_and_revocation_drops_everything() -> None:
    other = Notice("promo:1", "marketing")
    assert decide(other, Delivery(), POLICY, NOON).action == "drop"
    revoked = Policy(opted_in=POLICY.opted_in, revoked=True)
    assert decide(URGENT, Delivery(), revoked, NOON).action == "drop"
    assert decide(BILL, Delivery(), revoked, NOON).reason == "notifications revoked"


def test_quiet_hours_wrap_midnight_and_anchors_hold_only_non_urgent() -> None:
    """23:30 and 06:30 are quiet (wrapping midnight); 18:30 is a family anchor; urgent passes."""
    for when in (at(23, 30), at(6, 30)):
        assert decide(BILL, Delivery(), POLICY, when).action == "hold"
        assert decide(URGENT, Delivery(), POLICY, when).action == "send"
    assert decide(BILL, Delivery(), POLICY, at(18, 30)).reason == "protected family anchor"
    assert decide(URGENT, Delivery(), POLICY, at(18, 30)).action == "send"
    assert decide(BILL, Delivery(), POLICY, at(7, 0)).action == "send"


def test_sent_notice_waits_for_ack_retries_then_drops_when_budget_spent() -> None:
    sent = transition(Delivery(), "sent", NOON)
    assert decide(BILL, sent, POLICY, NOON + timedelta(minutes=5)).action == "hold"
    retry = decide(BILL, sent, POLICY, NOON + timedelta(minutes=11))
    assert (retry.action, retry.reason) == ("send", "retry after timeout")
    twice = transition(sent, "sent", NOON + timedelta(minutes=11))
    assert twice.attempts == 2
    final = decide(BILL, twice, POLICY, NOON + timedelta(minutes=30))
    assert (final.action, final.reason) == ("drop", "attempt budget spent without acknowledgement")


def test_acknowledged_or_failed_notices_are_never_sent_again() -> None:
    sent = transition(Delivery(), "sent", NOON)
    for event in ("acknowledged", "failed"):
        done = transition(sent, event, NOON)
        assert decide(URGENT, done, POLICY, NOON + timedelta(hours=1)).action == "drop"


def test_only_an_acknowledgement_is_delivery_and_invalid_transitions_are_refused() -> None:
    sent = transition(Delivery(), "sent", NOON)
    assert sent.delivered is False
    assert transition(sent, "acknowledged", NOON).delivered is True
    with pytest.raises(ValueError, match="cannot apply"):
        transition(Delivery(), "acknowledged", NOON)
    with pytest.raises(ValueError, match="cannot apply"):
        transition(transition(sent, "failed", NOON), "sent", NOON)


def test_notices_carry_keys_and_categories_never_message_text() -> None:
    with pytest.raises(ValueError, match="never message text"):
        Notice("Your electric bill of $142 is due Friday", "bills")
    with pytest.raises(ValueError, match="never message text"):
        Notice("bill:1", "Bills and payments")
