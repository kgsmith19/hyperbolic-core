"""Semantic Text Chunker.

Splits long documents into overlapping, semantically coherent chunks for
retrieval: paragraph-aware splitting with a token budget and overlap so key
ideas are never cut at chunk boundaries. Pure stdlib, no new dependencies.
Chunking is the #1 RAG accuracy lever from the research: whole-document
retrieval distracts the model, tiny snippets lose context.
"""

import re

DEFAULT_CHUNK_TOKENS = 400
DEFAULT_OVERLAP_TOKENS = 80
MIN_CHUNK_CHARS = 200


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars per token)."""
    if not text:
        return 0
    return max(1, len(text) // 4)


def split_paragraphs(text: str) -> list[str]:
    """Split on blank lines; fall back to sentence runs for wall-of-text."""
    if not text or not text.strip():
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) <= 1:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
        grouped, buf = [], []
        for s in sentences:
            buf.append(s)
            if estimate_tokens(" ".join(buf)) >= 150:
                grouped.append(" ".join(buf))
                buf = []
        if buf:
            grouped.append(" ".join(buf))
        return grouped or ([text.strip()] if text.strip() else [])
    return paras


def chunk_text(
    text: str,
    chunk_tokens: int = DEFAULT_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[str]:
    """Split text into overlapping chunks bounded by chunk_tokens.

    Paragraphs are the atomic unit: a paragraph never splits mid-sentence
    unless it alone exceeds the budget (then it is hard-split on sentences).
    Overlap is measured in whole trailing sentences of the previous chunk.
    Short inputs return a single chunk; empty input returns [].
    """
    if not text or not text.strip():
        return []
    if estimate_tokens(text) <= chunk_tokens:
        return [text.strip()]

    paras = split_paragraphs(text)
    chunks: list[str] = []
    current: list[str] = []
    current_tokens = 0

    def flush() -> None:
        if current:
            chunks.append("\n\n".join(current).strip())

    for para in paras:
        para_tokens = estimate_tokens(para)
        if para_tokens > chunk_tokens:
            flush()
            current, current_tokens = [], 0
            sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", para) if s.strip()]
            buf, buf_tokens = [], 0
            for s in sentences:
                st = estimate_tokens(s)
                if buf_tokens + st > chunk_tokens and buf:
                    chunks.append(" ".join(buf).strip())
                    overlap = buf[-1:] if overlap_tokens > 0 else []
                    buf, buf_tokens = list(overlap), estimate_tokens(" ".join(overlap))
                buf.append(s)
                buf_tokens += st
            if buf:
                chunks.append(" ".join(buf).strip())
            continue
        if current_tokens + para_tokens > chunk_tokens and current:
            flush()
            overlap_text = current[-1] if overlap_tokens > 0 and current else ""
            current = [overlap_text] if overlap_text else []
            current_tokens = estimate_tokens(" ".join(current))
        current.append(para)
        current_tokens += para_tokens
    flush()
    return [c for c in chunks if len(c) >= MIN_CHUNK_CHARS or len(chunks) == 1]
