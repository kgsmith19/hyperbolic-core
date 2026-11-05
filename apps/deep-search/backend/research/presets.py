"""Depth presets shared by the CLI, the HTTP API, and the UI.

Presets are starting points, not a mode enum: they only fill SearchOptions
fields the caller did not set explicitly. Every field stays independently
adjustable.

Commercial deep-research products cap a run at roughly 5-30 minutes and a
few hundred pages. ``deep`` and ``marathon`` deliberately go past that: more
rounds, more hops, more sources, more lanes, hours of wall-clock.
"""

from __future__ import annotations

DEFAULT_LANES = ["academic", "gov", "reference", "community", "video", "expert", "news", "web"]
ALL_LANES = ["academic", "gov", "reference", "filings", "community", "video", "expert", "news", "code", "archive", "web"]

PRESETS: dict[str, dict] = {
    "scout": {
        "label": "Scout",
        "blurb": "Quick breadth-first sweep to map the terrain and find what is worth a deep dig.",
        "eta": "~3 min",
        "max_duration_min": 4, "max_depth": 1, "max_documents": 30, "max_gap_rounds": 1, "breadth": 4,
        "concurrency": 6, "queries_per_round": 4, "results_per_lane": 5, "max_per_domain": 4, "llm_gap_rounds": 1,
    },
    "standard": {
        "label": "Standard",
        "blurb": "Solid multi-angle research with a few reflection rounds. Comparable to commercial deep research.",
        "eta": "~12 min",
        "max_duration_min": 15, "max_depth": 2, "max_documents": 90, "max_gap_rounds": 3, "breadth": 6,
        "concurrency": 6, "queries_per_round": 5, "results_per_lane": 8, "max_per_domain": 6, "llm_gap_rounds": 2,
    },
    "deep": {
        "label": "Deep",
        "blurb": "Goes well past commercial caps: hundreds of sources, citation chains, many reflection rounds.",
        "eta": "~45 min",
        "max_duration_min": 50, "max_depth": 3, "max_documents": 300, "max_gap_rounds": 8, "breadth": 8,
        "concurrency": 8, "queries_per_round": 6, "results_per_lane": 10, "max_per_domain": 8, "llm_gap_rounds": 3,
    },
    "marathon": {
        "label": "Marathon",
        "blurb": "Hours-long exhaustive investigation. Keeps snowballing leads until the budget is spent.",
        "eta": "2–4 hours",
        "max_duration_min": 240, "max_depth": 4, "max_documents": 1500, "max_gap_rounds": 30, "breadth": 12,
        "concurrency": 10, "queries_per_round": 8, "results_per_lane": 12, "max_per_domain": 12, "llm_gap_rounds": 6,
    },
}

PRESET_FIELDS = ("max_duration_min", "max_depth", "max_documents", "max_gap_rounds", "breadth", "concurrency",
                 "queries_per_round", "results_per_lane", "max_per_domain", "llm_gap_rounds")


def preset_values(name: str | None) -> dict:
    preset = PRESETS.get((name or "").lower())
    if not preset:
        return {}
    return {k: preset[k] for k in PRESET_FIELDS}


def public_presets() -> dict:
    return {"presets": PRESETS, "default": "standard", "default_lanes": DEFAULT_LANES, "all_lanes": ALL_LANES}
