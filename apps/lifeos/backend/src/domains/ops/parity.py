"""Dual-run automation parity scorecard (#594, part of #576).

Pure function: given per-day output digests from the legacy (ChatGPT) and local
LifeOS side of each automation, decide whether every listed automation has
proven parity and an owner sign-off, so cutover may be allowed. It disables
nothing, reads no automation and stores nothing; collecting observations and
the owner's sign-off stays under #576.

Rules this module holds to (from #594):

- The most recent ``streak_days`` consecutive days, ending on ``as_of``, must
  all match for an automation to be eligible. A gap or too few days is
  insufficient, never assumed to match.
- A day matches only when it has exactly one legacy and one local observation
  with equal digests. A differing digest, a missing side, or two observations
  for one side on one day is a mismatch, reported with its date.
- An eligible automation still needs an owner sign-off dated within the streak
  (on or after its first day, not after ``as_of``); an older sign-off does not
  count.
- Cutover is allowed only when every listed automation is eligible and signed
  off. An empty list never allows cutover.
- Observations carry digests (``sha256:`` plus 64 hex characters), never output
  text; anything else is refused.
"""

import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

Side = Literal["legacy", "local"]
Verdict = Literal["eligible", "insufficient", "mismatch"]

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class Observation:
    automation: str
    day: date
    side: Side
    digest: str

    def __post_init__(self) -> None:
        if not _DIGEST.fullmatch(self.digest):
            raise ValueError("an observation carries a sha256 digest, never output text")
        if self.side not in ("legacy", "local"):
            raise ValueError(f"unknown side {self.side!r}")


@dataclass(frozen=True, slots=True)
class SignOff:
    automation: str
    signed_on: date


@dataclass(frozen=True, slots=True)
class AutomationScore:
    automation: str
    verdict: Verdict
    matched_days: int
    mismatches: tuple[tuple[date, str], ...]
    missing_days: tuple[date, ...]
    signed_off: bool


@dataclass(frozen=True, slots=True)
class Scorecard:
    as_of: date
    streak_days: int
    automations: tuple[AutomationScore, ...]
    cutover_allowed: bool


def _day_problem(entries: list[Observation]) -> str | None:
    by_side: dict[str, list[str]] = defaultdict(list)
    for entry in entries:
        by_side[entry.side].append(entry.digest)
    for side in ("legacy", "local"):
        if len(by_side[side]) > 1:
            return f"two {side} observations"
        if not by_side[side]:
            return f"missing {side} side"
    if by_side["legacy"][0] != by_side["local"][0]:
        return "outputs differ"
    return None


def score(
    automations: Iterable[str],
    observations: Iterable[Observation],
    signoffs: Iterable[SignOff],
    *,
    as_of: date,
    streak_days: int,
) -> Scorecard:
    if streak_days < 1:
        raise ValueError("streak_days must be at least 1")
    names = list(dict.fromkeys(automations))
    window = [as_of - timedelta(days=offset) for offset in range(streak_days - 1, -1, -1)]
    start = window[0]

    grouped: dict[tuple[str, date], list[Observation]] = defaultdict(list)
    for observation in observations:
        if start <= observation.day <= as_of:
            grouped[(observation.automation, observation.day)].append(observation)
    signed: dict[str, list[date]] = defaultdict(list)
    for signoff in signoffs:
        signed[signoff.automation].append(signoff.signed_on)

    scores: list[AutomationScore] = []
    for name in names:
        mismatches: list[tuple[date, str]] = []
        missing: list[date] = []
        matched = 0
        for day in window:
            entries = grouped.get((name, day), [])
            if not entries:
                missing.append(day)
                continue
            problem = _day_problem(entries)
            if problem is None:
                matched += 1
            else:
                mismatches.append((day, problem))
        verdict: Verdict = "mismatch" if mismatches else ("insufficient" if missing else "eligible")
        signed_off = verdict == "eligible" and any(start <= when <= as_of for when in signed[name])
        scores.append(
            AutomationScore(
                automation=name,
                verdict=verdict,
                matched_days=matched,
                mismatches=tuple(mismatches),
                missing_days=tuple(missing),
                signed_off=signed_off,
            )
        )
    allowed = bool(scores) and all(s.verdict == "eligible" and s.signed_off for s in scores)
    return Scorecard(
        as_of=as_of, streak_days=streak_days, automations=tuple(scores), cutover_allowed=allowed
    )
