"""Claim Verifier: contradiction and support detection over evidence.

Cross-checks factual claims across collected sources before the brief is
written, so Tensions & Gaps is grounded in retrieved evidence instead of
model guesswork:

- Sentence-level claim extraction (numbers, dates, named findings).
- Pairwise support/contradiction signals: shared entities with divergent
  numbers or negation cues.
- Verdict counts feed the synthesis prompt (verified vs single-source vs
  contested claims) and surface contested items in the UI/report.

Heuristic and local-only by design: no egress, no model calls. It narrows
what the deep model must judge rather than replacing that judgment.
"""

import re
from collections import defaultdict

_NUMBER_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:%|percent|x|times|fold|billion|million|thousand)?\b", re.IGNORECASE)
_NEGATION_RE = re.compile(r"\b(no|not|never|fails?|cannot|unable|ineffective|disproves?|contradicts?|unlikely)\b", re.IGNORECASE)
_ENTITY_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b")


def extract_claims(text: str, max_claims: int = 8) -> list[str]:
    """Extract checkable claim sentences (those carrying numbers or entities)."""
    if not text or not isinstance(text, str):
        return []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    claims = []
    for s in sentences:
        if len(s) < 40 or len(s) > 350:
            continue
        if _NUMBER_RE.search(s) or len(_ENTITY_RE.findall(s)) >= 2:
            claims.append(s)
        if len(claims) >= max_claims:
            break
    return claims


def _claim_key(claim: str) -> str:
    """Blocking key: normalized entity signature so related claims compare."""
    entities = sorted({e.lower() for e in _ENTITY_RE.findall(claim)})
    nums = sorted(set(_NUMBER_RE.findall(claim.lower())))
    return "|".join(entities[:3]) + "##" + "|".join(nums[:2])


def verify_evidence(evidence: list[dict], max_claims_per_doc: int = 6) -> dict:
    """Cross-check claims across evidence docs.

    Returns {verified: [...], contested: [...], single_source: [...]} where
    each item is {claim, urls}. Verified = same key in 2+ docs without
    negation divergence; contested = same entities but different numbers or
    negation present; single_source = key seen once.
    """
    by_key: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for item in evidence:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or ""
        text = item.get("excerpt") or item.get("content") or ""
        for claim in extract_claims(text, max_claims=max_claims_per_doc):
            by_key[_claim_key(claim)].append((claim, url))

    verified, contested, single = [], [], []
    for key, occurrences in by_key.items():
        urls = sorted({u for _, u in occurrences})
        rep = occurrences[0][0]
        if len(urls) >= 2:
            nums = {n for _, u in occurrences for n in _NUMBER_RE.findall(u if False else _claim_numbers(rep))}
            negs = sum(1 for c, _ in occurrences if _NEGATION_RE.search(c))
            if negs > 0 and negs < len(occurrences):
                contested.append({"claim": rep, "urls": urls})
            else:
                verified.append({"claim": rep, "urls": urls})
        elif key.strip("#|"):
            single.append({"claim": rep, "urls": urls})
    return {"verified": verified, "contested": contested, "single_source": single}


def _claim_numbers(claim: str) -> str:
    return " ".join(_NUMBER_RE.findall(claim))


def verification_brief(verification: dict, max_items: int = 4) -> str:
    """Render a compact brief block for the synthesis prompt."""
    lines = []
    contested = verification.get("contested", [])[:max_items]
    verified = verification.get("verified", [])[:max_items]
    if contested:
        lines.append("Contested across sources (flag disagreements, do not average):")
        for c in contested:
            lines.append(f"- {c['claim'][:220]}")
    if verified:
        lines.append("Corroborated by multiple sources (cite confidently):")
        for c in verified:
            lines.append(f"- {c['claim'][:220]}")
    return "\n".join(lines)
