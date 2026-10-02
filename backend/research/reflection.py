"""Reflection between research rounds (local, no egress).

After each round the engine *reflects* the way OpenAI/Perplexity deep
research does between tool calls, and the way dzhng/deep-research carries
"learnings" between recursion levels:

1. Learnings: compact, citable findings distilled from the newest evidence.
2. Coverage: how well each plan sub-question is answered so far.
3. Follow-ups: new queries aimed at the thinnest sub-questions, plus
   *lead following* — recurring entities and concepts in the evidence that
   the original queries never named (snowball search). This is how a run
   goes deeper than the first page of results instead of re-searching the
   same words.
"""

from __future__ import annotations

import re
from collections import Counter

from backend.privacy.watchlist_redactor import SafetyError, assert_safe_to_send, redact
from backend.research.research_plan import core_terms

_STOP = frozenset({
    "the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with", "at", "by", "from", "is",
    "are", "was", "were", "what", "how", "why", "this", "that", "these", "those", "its", "into", "over",
    "under", "between", "through", "during", "such", "more", "most", "other", "than", "which", "while",
    "where", "when", "been", "being", "have", "has", "had", "will", "would", "could", "should", "about",
    "after", "also", "can", "may", "might", "not", "but", "their", "they", "them", "there", "here", "our",
    "your", "you", "we", "it", "be", "as", "if", "so", "do", "does", "did", "all", "any", "some", "one",
    "two", "very", "just", "like", "get", "got", "use", "used", "using", "new", "study", "studies",
    "research", "results", "result", "data", "paper", "article", "source", "page", "click", "read",
    "comment", "comments", "points", "reply", "posted", "deleted", "removed", "thread", "reddit", "youtube",
})
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_NUM_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:%|percent|x|fold|mg|g|kg|ms|hours?|days?|weeks?|months?|years?|participants|patients|subjects)?\b", re.I)
_ENTITY_RE = re.compile(r"\b([A-Z][a-zA-Z0-9\-]+(?:\s+(?:of|de|for|and)?\s*[A-Z][a-zA-Z0-9\-]+){0,3})\b")
_BOILER_RE = re.compile(r"(cookie|subscribe|sign up|newsletter|all rights reserved|javascript|log in|copyright|privacy policy|advertis|similar content being viewed|click here|share this|download pdf|view article)", re.I)
_FINDING_RE = re.compile(
    r"\b(found|finds|find that|show(?:s|ed|n)?|demonstrat\w*|suggest\w*|indicat\w*|improv\w*|increas\w*|reduc\w*|"
    r"decreas\w*|associat\w*|significant\w*|effective|ineffective|benefit\w*|no (?:significant )?(?:effect|difference|evidence)|"
    r"lower|higher|outperform\w*|caus\w*|conclud\w*|linked|correlat\w*|enhanc\w*|impair\w*|worse|better|recommend\w*)\b", re.I)
_METHOD_RE = re.compile(
    r"(search strategy|databases? (?:were|was) searched|we searched|inclusion criteria|exclusion criteria|data extraction|"
    r"were included|was conducted|prisma|checklist|risk of bias|methodological quality|this (?:study|review|paper|article) "
    r"(?:aims?|investigat\w*|examin\w*|explor\w*|discuss\w*|focus\w*)|objective of this|the aim of|aims? to|keywords?:|"
    r"registered (?:in|with)|were screened|full[- ]text|study selection|eligib\w+|we conducted|we performed|"
    r"was performed through|were searched|^(?:methods?|background|objectives?|design|setting|introduction)\b)", re.I)
# Structured-abstract labels: findings sections earn a bonus, setup sections a penalty.
_LABEL_RE = re.compile(r"^(conclusions?|results?|findings|data analysis|key points|takeaways?|tl;?dr|summary|"
                       r"methods?|background|objectives?|design|setting|introduction|context|purpose|aims?)\s*[:.\-]\s*", re.I)
_GOOD_LABELS = {"conclusion", "conclusions", "result", "results", "findings", "data analysis", "key points",
                "takeaway", "takeaways", "tldr", "tl;dr", "summary"}
_NOISE_RE = re.compile(
    r"(^reddit thread|^original post|points, \d+ comments|^top community|^hacker news discussion|^youtube video|"
    r"^channel:|^description:|^transcript:|^\[|https?://|\bdoi:|^figure|^table|^\d+(?:\.\d+)+\s|member-only|"
    r" - date:| - source:|^abstract:\s*\)|subscribe to|sign in to|^\W)", re.I)


_CAPS_LABEL_RE = re.compile(r"^(CONCLUSIONS?|RESULTS?|FINDINGS|METHODS?|BACKGROUND|OBJECTIVES?|DESIGN|SETTING|"
                            r"INTRODUCTION|CONTEXT|PURPOSE|AIMS?)\s+(?=[A-Z])")


def strip_label(sent: str) -> tuple[str, float]:
    """Remove a structured-abstract label; return (text, bonus)."""
    m = _LABEL_RE.match(sent or "") or _CAPS_LABEL_RE.match(sent or "")
    if not m:
        if sent.lower().startswith("abstract"):
            return re.sub(r"^abstract\s*[:.\-]?\s*", "", sent, flags=re.I), 0.0
        return sent, 0.0
    label = m.group(1).lower()
    rest = sent[m.end():].strip()
    if rest:
        rest = rest[0].upper() + rest[1:]
    return rest, (0.4 if label in _GOOD_LABELS else -0.9)


def sentence_value(sent: str) -> float:
    """How much a sentence reads like a citable *finding* (0 = discard)."""
    if not sent:
        return 0.0
    sent, label_bonus = strip_label(sent)
    if not sent or _NOISE_RE.search(sent) or _BOILER_RE.search(sent):
        return 0.0
    if sent[0].islower() or sent[0] in "([,;":
        return 0.0  # mid-sentence fragment
    value = 1.0 + label_bonus
    if _FINDING_RE.search(sent):
        value += 0.5
    if _NUM_RE.search(sent):
        value += 0.25
    if _METHOD_RE.search(sent):
        value -= 0.8
    if sent.count("|") > 2 or sent.count("·") > 2:
        value -= 0.5
    return max(0.0, value)


def terms(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9][a-z0-9\-]{2,}", (text or "").lower()) if w not in _STOP}


def overlap_score(query_terms: set[str], text: str) -> float:
    if not query_terms:
        return 0.0
    t = terms(text)
    return len(query_terms & t) / len(query_terms)


def split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text or "").strip()
    return [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]


def best_passages(text: str, focus: str, max_chars: int = 2800) -> str:
    """Pick the passages of a long document most relevant to the focus text."""
    from backend.retrieval.text_chunker import chunk_text

    chunks = chunk_text(text) if text else []
    if len(chunks) <= 1:
        return (text or "")[:max_chars]
    focus_terms = terms(focus)
    scored = []
    for idx, chunk in enumerate(chunks):
        s = overlap_score(focus_terms, chunk)
        s += 0.15 if _NUM_RE.search(chunk) else 0.0
        s -= 0.3 if _BOILER_RE.search(chunk[:300]) else 0.0
        s += 0.05 if idx == 0 else 0.0  # leads/abstracts carry the gist
        scored.append((s, idx, chunk))
    scored.sort(key=lambda x: (-x[0], x[1]))
    picked = sorted(scored[:3], key=lambda x: x[1])
    out, total, seen = [], 0, set()
    for _, _, chunk in picked:
        # Chunks overlap by a sentence or paragraph; drop text already kept.
        fresh = [s for s in split_sentences(chunk) if s not in seen]
        seen.update(fresh)
        chunk = " ".join(fresh)
        if not chunk:
            continue
        if total + len(chunk) > max_chars and out:
            break
        out.append(chunk[: max_chars - total])
        total += len(out[-1])
    return "\n\n…\n\n".join(out)


def extract_learnings(topic: str, evidence: list, max_items: int = 6, per_doc: int = 1) -> list[dict]:
    """Distill citable findings (sentences with substance) from evidence."""
    topic_terms = terms(topic)
    candidates = []
    for ev in evidence:
        text = getattr(ev, "excerpt", "") or ""
        lane = getattr(ev, "lane", "") or ""
        quality = float(getattr(ev, "quality", 0.0) or 0.5)
        best = []
        for sent in split_sentences(text)[:80]:
            sent = re.sub(r"^-?\s*\[\d+ pts\]\s*", "", sent.strip(" -•*"))
            value = sentence_value(sent)
            sent = strip_label(sent)[0]
            if len(sent) < 60 or len(sent) > 340:
                continue
            rel = overlap_score(topic_terms, sent)
            if rel <= 0 or value <= 0.4:
                continue
            best.append((rel * value + 0.3 * quality, sent))
        best.sort(key=lambda x: -x[0])
        for score, sent in best[:per_doc]:
            candidates.append((score, {"text": sent, "url": getattr(ev, "url", ""), "lane": lane,
                                       "title": getattr(ev, "title", "")}))
    candidates.sort(key=lambda x: -x[0])
    out, seen = [], set()
    for _, item in candidates:
        key = " ".join(sorted(terms(item["text"])))[:120]
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= max_items:
            break
    return out


def assign_subq(plan, text: str) -> str:
    """Return the id of the plan sub-question the text best answers."""
    if not plan or not getattr(plan, "sub_questions", None):
        return ""
    best_id, best = "", 0.0
    for sq in plan.sub_questions:
        q_terms = terms(sq.question + " " + " ".join(sq.queries))
        score = overlap_score(q_terms, text[:6000])
        if score > best:
            best, best_id = score, sq.id
    return best_id


def subq_coverage(plan, evidence: list) -> dict[str, int]:
    cov = {sq.id: 0 for sq in getattr(plan, "sub_questions", []) or []}
    for ev in evidence:
        sid = getattr(ev, "subq", "")
        if sid in cov:
            cov[sid] += 1
    return cov


def _safe(q: str, watchlist: list[str]) -> str:
    q = redact(re.sub(r"\s+", " ", q).strip(), watchlist)[:200]
    if not q:
        return ""
    try:
        assert_safe_to_send(q, watchlist)
    except SafetyError:
        return ""
    return q


_LEAD_STOP = frozenset({
    "abstract", "reference", "references", "original", "scopus", "pubmed", "google", "scholar", "crossref", "article",
    "figure", "table", "introduction", "methods", "method", "results", "discussion", "conclusion", "conclusions",
    "background", "objective", "objectives", "view", "download", "pdf", "full", "text", "open", "access", "journal",
    "university", "department", "copyright", "citation", "cite", "search", "menu", "home", "login", "share", "related",
    "similar", "content", "cookies", "wikipedia", "reddit", "youtube", "review", "systematic", "meta-analysis",
    "however", "therefore", "although", "moreover", "furthermore", "additionally", "conversely", "finally", "overall",
    "edit", "retrieved", "archived", "external", "links", "see", "also", "contents", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december", "january", "february", "monday", "tuesday",
    "springer", "elsevier", "wiley", "nature", "frontiers", "mdpi", "ncbi", "nih", "pmc", "doi", "isbn", "issn",
    "the", "this", "these", "those", "there", "here", "when", "while", "what", "why", "how", "who", "which", "if",
    "smd", "rct", "rcts", "ci", "usd", "faq", "api", "pdf", "html", "url", "www", "isrctn", "nct", "prospero",
    "effect", "effects", "impact", "impacts", "role", "level", "levels", "benefit", "benefits", "outcome", "outcomes",
    "measure", "measures", "group", "groups", "participants", "subjects", "analysis", "evidence", "findings",
    "author", "authors", "editor", "member-only", "story", "guide", "members", "click", "posts", "post",
})
_ACRONYM_RE = re.compile(r"\b([A-Z]{3,6}s?)\b")
_MULTI_CAPS_RE = re.compile(r"\b([A-Z][a-z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+){1,3})\b")


def _lead_candidates(text: str, topic_terms: set[str]) -> set[str]:
    found: set[str] = set()
    for phrase in _MULTI_CAPS_RE.findall(text):
        words = phrase.split()
        lows = [w.lower() for w in words]
        if any(w in _LEAD_STOP for w in lows[:1]) or all(w in _STOP or w in _LEAD_STOP for w in lows):
            continue
        if set(lows) <= topic_terms:
            continue
        found.add(phrase)
    for acr in _ACRONYM_RE.findall(text):
        if acr.lower() in _LEAD_STOP or acr.lower() in topic_terms or acr in ("THE", "AND", "FOR", "WITH", "HTTP", "HTML", "HTTPS", "URL"):
            continue
        found.add(acr)
    words = [w for w in re.findall(r"[a-z][a-z\-]{3,}", text.lower())]
    for a, b in zip(words, words[1:]):
        if a in _STOP or b in _STOP or a in _LEAD_STOP or b in _LEAD_STOP:
            continue
        if a in topic_terms and b in topic_terms:
            continue
        found.add(f"{a} {b}")
    return found


def lead_queries(topic: str, evidence: list, issued: set[str], watchlist: list[str], max_n: int = 3) -> list[str]:
    """Snowball: recurring entities/concepts the topic never named become new queries."""
    core = core_terms(topic, 4)
    topic_terms = terms(topic)
    doc_freq: Counter = Counter()
    for ev in evidence[-80:]:
        text = f"{getattr(ev, 'title', '')}. {getattr(ev, 'excerpt', '')}"[:6000]
        for cand in _lead_candidates(text, topic_terms):
            doc_freq[cand] += 1
    scored = []
    for cand, freq in doc_freq.items():
        is_bigram = cand.islower()
        need = 3 if is_bigram else 2
        if freq < need:
            continue
        scored.append((freq * (0.7 if is_bigram else 1.0), cand))
    scored.sort(key=lambda x: (-x[0], x[1]))
    out, used_terms = [], set()
    for _, cand in scored:
        cand_terms = terms(cand)
        if cand_terms and cand_terms <= used_terms:
            continue
        q = _safe(f"{core} {cand}", watchlist)
        if q and q.lower() not in issued:
            out.append(q)
            used_terms |= cand_terms
        if len(out) >= max_n:
            break
    return out


def coverage_queries(plan, coverage: dict[str, int], issued: set[str], watchlist: list[str],
                     max_n: int = 3) -> list[tuple[str, str, list[str]]]:
    """Queries for the thinnest sub-questions: (query, subq_id, lanes)."""
    if not plan or not getattr(plan, "sub_questions", None):
        return []
    ranked = sorted(plan.sub_questions, key=lambda sq: coverage.get(sq.id, 0))
    core = core_terms(getattr(plan, "topic", "") or "", 4)
    out = []
    for sq in ranked:
        persp = (sq.perspective or "").lower()
        variants = list(sq.queries[1:]) + [f"{core} {persp}".strip(), f"{sq.queries[0]} evidence" if sq.queries else ""]
        for v in variants:
            q = _safe(v, watchlist)
            if q and q.lower() not in issued:
                out.append((q, sq.id, list(sq.lanes)))
                break
        if len(out) >= max_n:
            break
    return out
