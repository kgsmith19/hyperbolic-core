"""Lightweight Entity/Concept Graph (GraphRAG-lite, zero new dependencies).

Builds a queryable graph over collected evidence: nodes are documents plus
extracted topic concepts (multi-word noun-ish phrases); edges link documents
sharing concepts and concepts co-occurring in a document. Two uses:

1. Frontier prioritization: score a candidate URL by concept overlap with the
   highest-signal evidence, so citation hops that stay on-topic outrank drift.
2. Gap analysis that beats the hardcoded angle list: concepts covered by only
   one document (or named in the topic but absent from evidence) become
   follow-up queries grounded in what was actually retrieved.

Extraction is heuristic (capitalized phrases + frequent multi-word terms),
deliberately dependency-free. It complements the OpenAlex citation graph
with a content-derived graph over ALL sources, not just academic ones.
"""

import re
from collections import Counter

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with",
    "at", "by", "from", "is", "are", "was", "were", "what", "how", "why",
    "this", "that", "these", "those", "its", "into", "over", "under",
    "between", "through", "during", "such", "more", "most", "other", "than",
    "which", "while", "where", "when", "been", "being", "have", "has",
    "will", "would", "could", "should", "about", "after",
})


def extract_concepts(text: str, max_concepts: int = 20) -> list[str]:
    """Extract candidate concept phrases from text.

    Combines capitalized multi-word phrases (named entities, techniques)
    with frequent non-stopword bigrams. Returns lowercase-normalized,
    deduplicated concepts ordered by signal (capitalized first, then freq).
    """
    if not text or not isinstance(text, str):
        return []
    caps = re.findall(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b", text)
    words = [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z\-]{2,}", text)]
    bigrams = [
        f"{words[i]} {words[i + 1]}"
        for i in range(len(words) - 1)
        if words[i] not in _STOPWORDS and words[i + 1] not in _STOPWORDS
    ]
    freq = Counter(bigrams)
    seen: set[str] = set()
    out: list[str] = []
    for phrase in caps:
        key = phrase.lower()
        if key not in seen:
            seen.add(key)
            out.append(key)
    for phrase, _ in freq.most_common(max_concepts * 2):
        if phrase not in seen:
            seen.add(phrase)
            out.append(phrase)
        if len(out) >= max_concepts:
            break
    return out[:max_concepts]


class EvidenceGraph:
    """Concept graph over a collected evidence set."""

    def __init__(self):
        self.doc_concepts: dict[str, list[str]] = {}
        self.concept_docs: dict[str, set[str]] = {}
        self.doc_titles: dict[str, str] = {}

    def add_document(self, url: str, title: str, text: str) -> None:
        """Index one document's concepts into the graph."""
        if not url:
            return
        concepts = extract_concepts(f"{title or ''}\n{text or ''}")
        self.doc_concepts[url] = concepts
        self.doc_titles[url] = title or ""
        for c in concepts:
            self.concept_docs.setdefault(c, set()).add(url)

    def score_candidate(self, title: str, snippet: str) -> float:
        """Score a frontier candidate by concept overlap with indexed evidence.

        Returns 0.0-1.0: fraction of the candidate's concepts already present
        in the graph, weighted toward concepts shared by multiple documents
        (consensus concepts signal the topic core).
        """
        cand_concepts = extract_concepts(f"{title or ''}\n{snippet or ''}", max_concepts=10)
        if not cand_concepts:
            return 0.0
        total, hit = 0.0, 0.0
        for c in cand_concepts:
            docs = self.concept_docs.get(c, set())
            if docs:
                total += 1.0
                hit += min(1.0, 0.5 + 0.25 * len(docs))
        return round(hit / len(cand_concepts), 3) if cand_concepts else 0.0

    def coverage_gaps(self, topic: str, max_gaps: int = 3) -> list[str]:
        """Propose follow-up queries from thin graph coverage.

        Priority: topic concepts with zero evidence coverage first, then
        concepts appearing in exactly one document (single-source claims
        worth corroborating). Returns query strings, not just concept names.
        """
        topic_concepts = extract_concepts(topic, max_concepts=8)
        gaps: list[str] = []
        for c in topic_concepts:
            if c not in self.concept_docs:
                gaps.append(f"{c} latest research findings")
                if len(gaps) >= max_gaps:
                    return gaps
        single_source = sorted(
            (c for c, docs in self.concept_docs.items() if len(docs) == 1),
            key=lambda c: -len(c),
        )
        for c in single_source:
            gaps.append(f"{c} corroborating evidence review")
            if len(gaps) >= max_gaps:
                break
        return gaps[:max_gaps]
