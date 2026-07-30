"""Deterministic episode lines for chat and the briefing (roadmap EP1).

The domain is x-sensitive and withheld from the shared agent-tool surface
(ADR 016), so no model can read — let alone quote — a playbook or an episode.
Everything here is therefore kernel-side composition, zero-LLM: the reply goes
straight from kernel reads to the owner's screen, and the model never sees the
question routed here nor the answer. That is also what makes the roadmap's two
behavior bars structural rather than aspirational:

- **verbatim**: the playbook steps are quoted byte-for-byte from the operator's
  own records — nothing paraphrases because nothing generates;
- **never fresh reassurance**: the reply is a pure function of recorded state,
  so a repeated same-day wellbeing query returns the same playbook again — a
  reassurance loop gets the plan the operator wrote, not new soothing text.

Routing is deterministic substring matching over the operator's message. A
prediction-shaped episode question abstains ALWAYS — before any read, whatever
the data says (cell constitution: no prediction, no risk scores). Everything
else composes only while an episode is open (no parseable ``end_date``, the
evidence-card definition): the moment the operator marks an episode over, chat
returns to the ordinary model path. A context without ``episodes:read``, or a
box where the domain was never installed, composes nothing — the model path
(which cannot see the domain either) answers as before.

The briefing's one line is a count in words — "2 of your usual perturbations
present this week" — historical language only, never a tag name, never a date
(the ops-cell rule: counts, statuses and IDs). "Usual" is a tag recorded on at
least ``USUAL_MIN_EPISODES`` episodes; "present this week" is a tag on an
episode whose onset falls in the seven days ending on the briefing day. When
the count is zero there is NO line at all: a daily zero-count would put
episode salience on a schedule, which is a push prompt in slow motion
(cell constitution: pull-only — no notification path may exist in code).

Reads only, computed on demand, never stored by this module — the chat reply
exists solely in the HTTP response to the operator's own question (the
evidence-card precedent, invariant 9).
"""

from collections import Counter
from datetime import date, timedelta
from typing import Any

from domains.episodes.capture import _number, _parsed_date
from domains.episodes.evidence import evidence_card
from domains.episodes.types import TYPE_EPISODE, TYPE_PLAYBOOK
from kernel import services
from kernel.access import AccessContext, ScopeError
from kernel.models import Entity

METHOD = "domains.episodes.lines"

ROUTE_PREDICTION = "prediction"
ROUTE_COMPOSE = "compose"

USUAL_MIN_EPISODES = 2
WEEK_DAYS = 7

ABSTAIN_LINE = (
    "I don't predict episodes — no forecast, no risk score. What I can show is "
    "recorded history: your playbook and the evidence card of past episodes."
)

# Deterministic routing vocabularies, checked lowercase. Prediction wins first:
# an episode question with a future marker abstains no matter what else it
# matches. The wellbeing set is the reassurance-seeking register the roadmap
# names ("repeated same-day wellbeing queries return the playbook").
_FUTURE_MARKERS = (
    "will i",
    "will there",
    "when will",
    "am i going to",
    "going to have",
    "predict",
    "next week",
    "next month",
    "tomorrow",
    "likely",
    "chance of",
    "risk",
)
_COMPOSE_MARKERS = ("playbook", "evidence card")
_EPISODE_FACT_MARKERS = ("how long", "actually last", "feared", "duration", "how many")
_WELLBEING_MARKERS = (
    "how long will this last",
    "will this ever end",
    "am i ok",
    "am i okay",
    "going to be ok",
    "reassur",
    "worried",
    "worry",
    "anxious",
    "anxiety",
    "spiral",
    "can't cope",
    "cant cope",
    "falling apart",
    "how bad is this",
)


def route(message: str) -> str | None:
    """Where a chat message goes: abstention, kernel-side composition, or the
    ordinary model path (None). Pure and deterministic — substring matching,
    no scoring, no model."""
    msg = message.lower()
    if "episode" in msg and any(marker in msg for marker in _FUTURE_MARKERS):
        return ROUTE_PREDICTION
    if any(marker in msg for marker in _COMPOSE_MARKERS):
        return ROUTE_COMPOSE
    if "episode" in msg and any(marker in msg for marker in _EPISODE_FACT_MARKERS):
        return ROUTE_COMPOSE
    if any(marker in msg for marker in _WELLBEING_MARKERS):
        return ROUTE_COMPOSE
    return None


def has_open(episodes: list[Entity]) -> bool:
    """True when any episode has no measurable end — the evidence card's own
    open definition: either date unparseable means not closed."""
    return any(
        _parsed_date(episode.attributes.get("onset_date")) is None
        or _parsed_date(episode.attributes.get("end_date")) is None
        for episode in episodes
    )


def latest_playbooks(playbooks: list[Entity]) -> list[Entity]:
    """The newest version of each named playbook, name-sorted. Versions are
    append-only records (T1), so "latest" is a read-side choice, not an edit."""
    latest: dict[str, Entity] = {}
    for playbook in playbooks:
        name = playbook.attributes.get("name")
        if not isinstance(name, str):
            continue
        version = _number(playbook.attributes.get("version")) or 0
        held = latest.get(name)
        if held is None or (_number(held.attributes.get("version")) or 0) < version:
            latest[name] = playbook
    return [latest[name] for name in sorted(latest)]


def playbook_lines(latest: list[Entity]) -> list[str]:
    """The operator's own if-then steps, quoted verbatim — never summarized,
    never rephrased (roadmap EP1: "cite playbook verbatim")."""
    if not latest:
        return ["Playbook: none recorded yet."]
    lines: list[str] = []
    for playbook in latest:
        name = playbook.attributes.get("name")
        version = _number(playbook.attributes.get("version"))
        lines.append(f'Your playbook "{name}" (version {version}), verbatim:')
        steps = playbook.attributes.get("steps")
        if not isinstance(steps, list) or not steps:
            lines.append("  (no steps recorded)")
            continue
        for step in steps:
            if isinstance(step, dict):
                lines.append(f"  - if {step.get('if')}, then {step.get('then')}")
    return lines


def _fmt(value: float | None) -> str:
    return "none" if value is None else f"{value:g}"


def card_lines(card: dict[str, Any]) -> list[str]:
    """The evidence card rendered as plain historical sentences. Every number
    is the card's own arithmetic (exact, cited by its provenance); absence is
    stated, never guessed at — and nothing here speaks about the future."""
    episodes = card["episodes"]
    durations = card["durations"]
    feared = card["feared_vs_actual"]
    lines = [
        "Evidence card, computed from your episode records:",
        f"- Episodes recorded: {episodes['total']} ({episodes['closed']} closed, "
        f"{episodes['open']} open; open episodes are counted but excluded from "
        "duration figures).",
    ]
    if durations["median_days"] is None:
        lines.append("- Durations: no closed episodes recorded yet.")
    else:
        trend = durations["trend"]
        trend_text = (
            "not enough closed episodes to describe a trend"
            if trend is None
            else (
                f"{trend['direction']} (earlier half median "
                f"{_fmt(trend['earlier_median_days'])} days, later half "
                f"{_fmt(trend['later_median_days'])} days)"
            )
        )
        lines.append(
            f"- Actual duration of closed episodes: median {_fmt(durations['median_days'])} "
            f"days; trend so far: {trend_text}."
        )
    if feared["compared"] == 0:
        lines.append("- Feared vs actual: no closed episode recorded a feared duration yet.")
    else:
        lines.append(
            f"- Feared vs actual over {feared['compared']} closed episodes: median feared "
            f"{_fmt(feared['median_feared_days'])} days, median actual "
            f"{_fmt(feared['median_actual_days'])} days, median gap "
            f"{_fmt(feared['median_gap_days'])} days (negative means episodes ended "
            "sooner than feared)."
        )
    pairs = card["perturbation_co_occurrence"]
    if pairs:
        rendered = ", ".join(f"{p['tags'][0]} + {p['tags'][1]} ({p['count']})" for p in pairs)
        lines.append(f"- Perturbations recorded together: {rendered}.")
    return lines


def deterministic_reply(ctx: AccessContext, message: str) -> dict[str, Any] | None:
    """The kernel-side chat reply for an episode-shaped message, or None for
    the ordinary model path. Reads only; provenance cites every episode the
    card saw plus each quoted playbook version and its latest event (ADR 010,
    confidence 1.0 — quotation and exact arithmetic, nothing estimated)."""
    routed = route(message)
    if routed is None:
        return None
    if routed == ROUTE_PREDICTION:
        # Before any read, whatever the data says: describing the future is
        # not this domain's business (cell constitution, ADR 019).
        return {
            "lines": [ABSTAIN_LINE],
            "provenance": {
                "source_entity_ids": [],
                "source_event_ids": [],
                "method": METHOD,
                "confidence": 1.0,
            },
        }
    try:
        episodes = services.find(ctx, type_name=TYPE_EPISODE)
    except (LookupError, ScopeError):
        # Domain not installed, or a token without episodes:read: this
        # composition has nothing it may say, and the model path — which
        # cannot see the domain either (ADR 016) — answers as before.
        return None
    if not has_open(episodes):
        return None
    playbooks = latest_playbooks(services.find(ctx, type_name=TYPE_PLAYBOOK))
    card = evidence_card(ctx)
    entity_ids = list(card["provenance"]["source_entity_ids"])
    event_ids = list(card["provenance"]["source_event_ids"])
    for playbook in playbooks:
        entity_ids.append(str(playbook.id))
        events = services.history(ctx, playbook.id)
        if events:
            event_ids.append(str(events[-1].id))
    return {
        "lines": playbook_lines(playbooks) + card_lines(card),
        "provenance": {
            "source_entity_ids": entity_ids,
            "source_event_ids": event_ids,
            "method": METHOD,
            "confidence": 1.0,
        },
    }


def usual_present(episodes: list[Entity], day: date) -> tuple[str, list[Entity]] | None:
    """The briefing's ONE descriptive line, or None when there is nothing to
    say. Pure: the caller reads. The line is a count in words — historical
    language only, no tag names, no dates — and the cited entities are every
    episode carrying one of the counted tags (they are the evidence for both
    "usual" and "present")."""
    tagged: list[tuple[Entity, date | None, frozenset[str]]] = []
    for episode in episodes:
        tags = episode.attributes.get("perturbation_tags")
        unique = (
            frozenset(tag for tag in tags if isinstance(tag, str))
            if isinstance(tags, list)
            else frozenset()
        )
        tagged.append((episode, _parsed_date(episode.attributes.get("onset_date")), unique))
    counts: Counter[str] = Counter(tag for _, _, tags in tagged for tag in tags)
    usual = {tag for tag, seen in counts.items() if seen >= USUAL_MIN_EPISODES}
    window_start = day - timedelta(days=WEEK_DAYS - 1)
    present = {
        tag
        for _, onset, tags in tagged
        if onset is not None and window_start <= onset <= day
        for tag in tags
    }
    hits = usual & present
    if not hits:
        return None
    cited = [episode for episode, _, tags in tagged if tags & hits]
    return f"{len(hits)} of your usual perturbations present this week", cited
