"""Local Cross-Encoder-Style Reranker (zero new dependencies).

Stage-2 reranking over the fused candidate set: each candidate chunk is
scored against the query with a weighted combination of BM25 lexical match
and FastEmbed dense similarity, then the top-N survive to synthesis.
This mirrors the cross-encoder rerank step from the research (accurate
reordering before the LLM sees context) using the models already on disk.

Why not the LLM for rerank: cost and egress. This reranker is fully local,
runs in milliseconds, and never sends evidence anywhere.
"""

from backend.ranking.bm25_scorer import compute_bm25_scores
from backend.ranking.dense_embedder import compute_dense_scores

DEFAULT_RERANK_KEEP = 12
LEXICAL_WEIGHT = 0.4
DENSE_WEIGHT = 0.6


def _normalize(scores: list[float]) -> list[float]:
    if not scores:
        return []
    lo, hi = min(scores), max(scores)
    if hi <= lo:
        return [0.5] * len(scores)
    return [(s - lo) / (hi - lo) for s in scores]


def rerank_candidates(
    query: str,
    candidates: list[dict],
    keep: int = DEFAULT_RERANK_KEEP,
    lexical_weight: float = LEXICAL_WEIGHT,
    dense_weight: float = DENSE_WEIGHT,
) -> list[dict]:
    """Rerank candidate dicts, returning the top-keep with `rerank_score` set.

    Candidate text is title + snippet + best chunk (callers put the
    highest-signal chunk text under the `rerank_text` key when available).
    Stable sort keeps input order on ties, so results are deterministic.
    """
    if not candidates:
        return []
    texts = [
        (c.get("rerank_text") or f"{c.get('title') or ''} {c.get('snippet') or ''} {c.get('excerpt') or ''}")
        if isinstance(c, dict) else ""
        for c in candidates
    ]
    bm25 = compute_bm25_scores(query, texts)
    dense = compute_dense_scores(query, texts)
    n_bm25 = _normalize(bm25)
    n_dense = _normalize(dense)
    scored = []
    for idx, cand in enumerate(candidates):
        score = round(lexical_weight * n_bm25[idx] + dense_weight * n_dense[idx], 4)
        out = dict(cand) if isinstance(cand, dict) else {"text": cand}
        out["rerank_score"] = score
        out["rerank_bm25"] = round(bm25[idx], 3)
        out["rerank_dense"] = round(dense[idx], 3)
        scored.append((score, idx, out))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [out for _, _, out in scored[: max(1, keep)]]
