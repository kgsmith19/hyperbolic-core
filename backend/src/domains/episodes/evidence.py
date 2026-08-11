"""The episode evidence card: one deterministic read service (roadmap EP1).

Zero-LLM, the briefing.py pattern: every number is arithmetic over kernel
reads, cited by entity and event id (ADR 010, confidence 1.0 — the card is
exact arithmetic over direct kernel reads, nothing estimated). It computes

- **episode count** — total, closed, open. An episode is closed when both its
  dates parse; anything else has no measurable duration yet and is handled as
  open, explicitly: counted and cited, excluded from every duration figure,
  never guessed at.
- **actual durations** — ``end_date - onset_date`` in days over closed
  episodes: the median, and a trend comparing the median of the later half
  (onset order) against the earlier half, the middle episode dropped when the
  count is odd so the halves stay equal. Fewer than two closed episodes is no
  evidence of a trend — ``None``, never an extrapolation (the cell's
  no-prediction rule: the trend describes recorded history only).
- **feared-vs-actual gap** — over closed episodes that recorded
  ``feared_duration_days``: the median feared, the median actual, and the
  median of the per-episode gaps ``actual - feared`` (negative means episodes
  ended sooner than feared; per-episode gaps, because the gap of medians is
  not the median gap).
- **perturbation co-occurrence** — for each pair of tags recorded together on
  one episode (open ones included: their perturbations are observations
  already), how many episodes carry both. Tags are deduplicated per episode.

Computed on demand and returned, never stored — nothing here writes. A stored
copy would outlive ``forget()`` of the episodes it summarizes (the briefing
lesson, invariant 9), so storing the card anywhere is out. The tag strings in
the co-occurrence section are the one piece of record content the card
carries — counts of unnamed perturbations would say nothing — and they exist
only in the returned value.

Pull-only (cell constitution): the operator asks, this answers. No schedule,
no notification, no push path. The domain is x-sensitive and withheld from
the shared agent-tool surface (ADR 016); this service is called kernel-side
with an ``episodes:read`` context, and a scoped token without that scope is
refused by the kernel on the first read (invariant 5). An undefined episode
type is a ``LookupError`` from ``find`` — the domain is not installed, and
that propagates rather than reading as an empty history.
"""

from collections import Counter
from datetime import date
from itertools import combinations
from statistics import median
from typing import Any

from domains.episodes.capture import _number, _parsed_date
from domains.episodes.types import TYPE_EPISODE
from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity

METHOD = "domains.episodes.evidence"


def _median(values: list[float]) -> float:
    return float(median(values))


def _trend(durations: list[float]) -> dict[str, Any] | None:
    """Median of the later half of closed-episode durations (onset order)
    against the earlier half; the middle episode is dropped when the count is
    odd so the halves stay equal. See the module docstring."""
    half = len(durations) // 2
    if half == 0:
        return None
    earlier = _median(durations[:half])
    later = _median(durations[-half:])
    if later < earlier:
        direction = "shortening"
    elif later > earlier:
        direction = "lengthening"
    else:
        direction = "stable"
    return {"direction": direction, "earlier_median_days": earlier, "later_median_days": later}


def compute_card(episodes: list[Entity]) -> dict[str, Any]:
    """The card's arithmetic, pure and exact — the fixture-ledger surface.

    ``evidence_card`` feeds it every episode record and adds the citations.
    """
    closed: list[tuple[date, float, Entity]] = []
    open_count = 0
    for episode in episodes:
        onset = _parsed_date(episode.attributes.get("onset_date"))
        end = _parsed_date(episode.attributes.get("end_date"))
        if onset is None or end is None:
            open_count += 1  # no measurable duration yet: counted, never guessed
        else:
            closed.append((onset, float((end - onset).days), episode))
    closed.sort(key=lambda item: item[0])
    durations = [days for _, days, _ in closed]

    feared_values: list[float] = []
    actual_values: list[float] = []
    gaps: list[float] = []
    for _, days, episode in closed:
        feared = _number(episode.attributes.get("feared_duration_days"))
        if feared is not None and feared > 0:
            feared_values.append(float(feared))
            actual_values.append(days)
            gaps.append(days - feared)

    pairs: Counter[tuple[str, str]] = Counter()
    for episode in episodes:
        tags = episode.attributes.get("perturbation_tags")
        if isinstance(tags, list):
            unique = sorted({tag for tag in tags if isinstance(tag, str)})
            pairs.update(combinations(unique, 2))

    return {
        "episodes": {"total": len(episodes), "closed": len(closed), "open": open_count},
        "durations": {
            "median_days": _median(durations) if durations else None,
            "trend": _trend(durations),
        },
        "feared_vs_actual": {
            "compared": len(gaps),
            "median_feared_days": _median(feared_values) if feared_values else None,
            "median_actual_days": _median(actual_values) if actual_values else None,
            "median_gap_days": _median(gaps) if gaps else None,
        },
        "perturbation_co_occurrence": [
            {"tags": list(pair), "count": count} for pair, count in sorted(pairs.items())
        ],
    }


def evidence_card(ctx: AccessContext) -> dict[str, Any]:
    """Compute the card over every episode record, cited. Reads only."""
    episodes = services.find(ctx, type_name=TYPE_EPISODE)
    card = compute_card(episodes)
    card["provenance"] = {
        "source_entity_ids": [str(episode.id) for episode in episodes],
        "source_event_ids": services.latest_event_ids(ctx, [e.id for e in episodes]),
        "method": METHOD,
        "confidence": 1.0,
    }
    return card
