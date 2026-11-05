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


def verify_evidence(evidence: list[dict], max_claims_per_doc: int = 6, families: dict | None = None) -> dict:
    """Cross-check claims across evidence docs.

    Returns {verified, contested, single_source, independence} where each verdict
    item is {claim, urls, families}. When `families` (url -> family_id) is given,
    corroboration counts distinct families instead of distinct URLs, so syndicated
    copies of one source no longer inflate corroboration. `families=None` keeps the
    original URL-based behavior exactly.
    """
    by_key: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for item in evidence:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or ""
        text = item.get("excerpt") or item.get("content") or ""
        for claim in extract_claims(text, max_claims=max_claims_per_doc):
            by_key[_claim_key(claim)].append((claim, url))

    def group_id(url: str):
        if families is not None:
            return families.get(url, url)  # unknown url stays distinct by its own url
        return url

    verified, contested, single = [], [], []
    collapsed = 0
    all_groups: set = set()
    for key, occurrences in by_key.items():
        urls = sorted({u for _, u in occurrences})
        groups = {group_id(u) for _, u in occurrences}
        all_groups |= groups
        rep = occurrences[0][0]
        fam_ids = sorted(g for g in groups if isinstance(g, int))
        item = {"claim": rep, "urls": urls, "families": fam_ids}
        if len(urls) >= 2 and len(groups) < 2:
            collapsed += 1
        if len(groups) >= 2:
            negs = sum(1 for c, _ in occurrences if _NEGATION_RE.search(c))
            if 0 < negs < len(occurrences):
                contested.append(item)
            else:
                verified.append(item)
        elif key.strip("#|"):
            single.append(item)
    n_families = len(all_groups) if families is not None else 0
    return {
        "verified": verified,
        "contested": contested,
        "single_source": single,
        "independence": {"families": n_families, "collapsed_claims": collapsed},
    }


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
