"""Deep research brief: structured, cited, lane-aware synthesis.

Two writers produce the same markdown skeleton:

- ``build_local_brief``: fully offline. Extractive, but organised the way an
  analyst would: executive summary, findings per research question, an
  explicit *Research vs Community* comparison (the academic/discussion mix is
  this tool's edge), corroborated vs contested claims, notable voices, top
  videos, and next digs.
- ``build_llm_brief``: outline-then-write, in the spirit of STORM and Google's
  test-time-diffusion researcher. Each research question gets its own drafted
  section from its own best evidence, then a final pass writes the summary and
  cross-cutting analysis from those drafts. Citations are validated so every
  [n] maps to a real source.

Citation numbers always refer to the evidence order in the report's source list.
"""

from __future__ import annotations

import re
from collections import Counter

from backend.privacy.watchlist_redactor import assert_safe_to_send, redact
from backend.research.reflection import overlap_score, sentence_value, split_sentences, strip_label, terms
from backend.retrieval.evidence_graph import extract_concepts
from backend.retrieval.source_quality import DISCUSSION_LANES, EVIDENCE_LANES, LANE_LABELS

_NUM_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:%|percent|x|fold|mg|g|ms|hours?|weeks?|months?|years?)?\b", re.I)
_BOILER_RE = re.compile(r"(cookie|subscribe|sign up|newsletter|all rights reserved|javascript|log in|copyright|"
                        r"privacy policy|advertis|click here|share this|\bpts\]|\[\d+ pts\])", re.I)


def _get(item, key, default=None):
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


_REF_MARK_RE = re.compile(r"(\[(?:\d+|edit|citation needed)\])+", re.I)
_MD_NOISE_RE = re.compile(r"\*\*|__")
_CONCEPT_STOP = frozenset({"post", "original", "figure", "includes", "replies", "reply", "comments", "comment",
                           "points", "edit", "thread", "posted", "deleted", "removed", "upvote", "reference",
                           "net", "com", "www", "html", "irl", "lol", "tldr", "edgesuite", "cookie", "cookies"})


def _clean_sentence(sent: str) -> str:
    sent = _REF_MARK_RE.sub("", sent)
    sent = _MD_NOISE_RE.sub(" ", sent)
    return re.sub(r"\s+", " ", sent).strip(" -*\u2022")


def _doc_relevance(topic: str, evidence: list) -> list[float]:
    """Topic similarity per document (FastEmbed when available, term overlap otherwise)."""
    samples = [f"{_get(e, 'title', '')}. {(_get(e, 'excerpt', '') or '')[:800]}" for e in evidence]
    try:
        from backend.ranking import dense_embedder
        if dense_embedder._EMBEDDER is not None and samples:
            return [float(x) for x in dense_embedder.compute_dense_scores(topic, samples)]
    except Exception:
        pass
    t = terms(topic)
    return [0.55 + 0.45 * overlap_score(t, s) for s in samples]


def _relevant_idxs(rel: list[float], idxs: list[int], floor: float = 0.66, keep_min: int = 5) -> list[int]:
    if idxs:
        ordered = sorted((rel[i] for i in idxs), reverse=True)
        top_quartile = ordered[max(0, len(ordered) // 4 - 1)]
        floor = max(floor, min(0.74, top_quartile - 0.1))
    good = [i for i in idxs if rel[i] >= floor]
    if len(good) >= min(keep_min, len(idxs)):
        return good
    return sorted(idxs, key=lambda i: -rel[i])[: max(keep_min, len(good))]


def _sentences_for(evidence: list, idxs: list[int], focus: str, max_items: int, used: set[str],
                   per_doc: int = 2) -> list[tuple[str, int]]:
    focus_terms = terms(focus)
    scored = []
    for i in idxs:
        item = evidence[i]
        text = _get(item, "excerpt", "") or _get(item, "snippet", "") or ""
        quality = float(_get(item, "quality", 0.5) or 0.5)
        lane = _get(item, "lane", "") or ""
        doc_best = []
        for sent in split_sentences(text)[:120]:
            sent = _clean_sentence(re.sub(r"^-?\s*\[\d+ pts\]\s*", "", sent.strip(" -•*")))
            if len(sent) < 55 or len(sent) > 360 or _BOILER_RE.search(sent):
                continue
            value = sentence_value(sent)
            sent = strip_label(sent)[0]
            if value <= 0.4:
                continue
            rel = overlap_score(focus_terms, sent)
            if rel <= 0:
                continue
            s = rel * value + 0.35 * quality
            doc_best.append((s, sent))
        doc_best.sort(key=lambda x: -x[0])
        for s, sent in doc_best[:per_doc]:
            scored.append((s, sent, i))
    scored.sort(key=lambda x: -x[0])
    out = []
    for _, sent, i in scored:
        key = " ".join(sorted(terms(sent)))[:140]
        if key in used:
            continue
        used.add(key)
        out.append((sent, i))
        if len(out) >= max_items:
            break
    return out


def _cite(i: int) -> str:
    return f"[{i + 1}]"


def lane_counts(evidence: list) -> Counter:
    return Counter((_get(e, "lane", "") or "web") for e in evidence)


def notable_voices(evidence: list, max_items: int = 8) -> dict[str, list[tuple[str, int]]]:
    authors, venues, communities, channels = Counter(), Counter(), Counter(), Counter()
    for e in evidence:
        meta = _get(e, "meta", {}) or {}
        lane = _get(e, "lane", "")
        if lane == "academic":
            for a in str(meta.get("authors", "")).split(",")[:3]:
                a = a.strip()
                if 3 < len(a) < 60:
                    authors[a] += 1
            if meta.get("venue"):
                venues[str(meta["venue"])[:80]] += 1
        if meta.get("community"):
            communities[str(meta["community"])[:60]] += 1
        if lane == "video" and meta.get("author"):
            channels[str(meta["author"])[:60]] += 1
    return {
        "Researchers": authors.most_common(max_items),
        "Journals & venues": venues.most_common(max_items),
        "Communities": communities.most_common(max_items),
        "Channels": channels.most_common(max_items),
    }


def suggest_followups(topic: str, plan, evidence: list, learnings: list, max_items: int = 6) -> list[str]:
    """Next digs: thin plan questions + recurring leads the run surfaced."""
    from backend.research.reflection import lead_queries, subq_coverage

    out: list[str] = []
    if plan is not None and getattr(plan, "sub_questions", None):
        cov = subq_coverage(plan, evidence)
        for sq in sorted(plan.sub_questions, key=lambda s: cov.get(s.id, 0))[:2]:
            if cov.get(sq.id, 0) < 3:
                out.append(sq.question)
    try:
        from backend.research.research_plan import core_terms
        core = core_terms(topic, 4)
        for q in lead_queries(topic, evidence, set(), [], max_n=max_items):
            lead = q[len(core):].strip() if q.lower().startswith(core.lower()) else q
            text = f"How does {lead} relate to {core}?" if lead and lead != q else q
            if text not in out:
                out.append(text)
    except Exception:
        pass
    return out[:max_items]


def build_local_brief(topic: str, evidence: list, plan=None, learnings: list | None = None,
                      verification: dict | None = None, followups: list | None = None) -> str:
    if not evidence:
        return "No sources were retrieved, so there is nothing to summarise yet. Try broadening the topic or enabling more source lanes."
    used: set[str] = set()
    n = len(evidence)
    rel = _doc_relevance(topic, evidence)
    all_idx = _relevant_idxs(rel, list(range(n)))
    lines: list[str] = []

    # Executive summary: the strongest, most substantive sentences overall, lane-diverse.
    lines.append("## Executive Summary")
    top = _sentences_for(evidence, all_idx[: min(n, 40)], topic, 10, used, per_doc=1)
    picked, lanes_seen = [], Counter()
    for sent, i in top:
        lane = _get(evidence[i], "lane", "") or "web"
        if lanes_seen[lane] >= 2 and len(top) > 5:
            continue
        lanes_seen[lane] += 1
        picked.append((sent, i))
        if len(picked) >= 5:
            break
    for sent, i in picked or top[:5]:
        lines.append(f"- {sent} {_cite(i)}")
    if not (picked or top):
        lines.append("- The sources gathered did not contain clear, quotable findings. See the source list below.")
    counts = lane_counts(evidence)
    mix = ", ".join(f"{LANE_LABELS.get(k, k)} {v}" for k, v in counts.most_common())
    lines.append("")
    lines.append(f"*Built from {n} sources ({mix}).*")
    lines.append("")

    # Findings per research question.
    if plan is not None and len(getattr(plan, "sub_questions", []) or []) > 1:
        lines.append("## Findings by Research Question")
        for sq in plan.sub_questions:
            idxs = [i for i in all_idx if _get(evidence[i], "subq", "") == sq.id]
            if len(idxs) < 3:
                idxs = idxs + [i for i in all_idx[:60] if i not in idxs]
            found = _sentences_for(evidence, idxs, f"{topic} {sq.question} {' '.join(sq.queries)}", 4, used)
            lines.append(f"### {sq.question}")
            if found:
                for sent, i in found:
                    lines.append(f"- {sent} {_cite(i)}")
            else:
                lines.append("- Evidence for this question was thin in this run — a good candidate for a follow-up dig.")
            lines.append("")

    # Research vs community: the core differentiator.
    acad = [i for i in all_idx if (_get(evidence[i], "lane", "") or "") in EVIDENCE_LANES]
    disc = [i for i in all_idx if (_get(evidence[i], "lane", "") or "") in DISCUSSION_LANES]
    if acad or disc:
        lines.append("## Research vs. Community")
        a_found = _sentences_for(evidence, acad, topic, 4, used) if acad else []
        d_found = _sentences_for(evidence, disc, topic, 4, used) if disc else []
        lines.append("### What the research says")
        lines += [f"- {s} {_cite(i)}" for s, i in a_found] or ["- No scholarly or institutional sources made the cut in this run."]
        lines.append("")
        lines.append("### What practitioners and communities report")
        lines += [f"- {s} {_cite(i)}" for s, i in d_found] or ["- No community, expert, or video sources made the cut in this run."]
        lines.append("")
        if acad and disc:
            topic_terms = terms(topic)

            def concept_df(idxs):
                df = Counter()
                for i in idxs:
                    text = f"{_get(evidence[i], 'title', '')}. {_get(evidence[i], 'excerpt', '')[:3000]}"
                    for c in set(extract_concepts(text, max_concepts=25)):
                        words = set(c.split())
                        if (not terms(c) or terms(c) <= topic_terms or any(ch.isdigit() for ch in c)
                                or "http" in c or words & _CONCEPT_STOP):
                            continue
                        df[c] += 1
                return df

            a_df, d_df = concept_df(acad), concept_df(disc)
            shared = sorted((c for c in a_df if c in d_df), key=lambda c: -(a_df[c] + d_df[c]))[:8]
            a_only = [c for c, n in a_df.most_common(40) if c not in d_df and n > 1][:6]
            d_only = [c for c, n in d_df.most_common(40) if c not in a_df and n > 1][:6]
            lines.append("### Where they meet and where they split")
            if shared:
                lines.append(f"- **Common ground:** both literatures keep returning to {', '.join(shared)}.")
            if a_only:
                lines.append(f"- **Research-only themes:** {', '.join(a_only)}.")
            if d_only:
                lines.append(f"- **Community-only themes:** {', '.join(d_only)} — lived-experience angles the literature rarely measures.")
            lines.append("")

    if verification and (verification.get("verified") or verification.get("contested")):
        lines.append("## Corroborated vs. Contested")
        url_index = {(_get(e, "url", "") or ""): i for i, e in enumerate(evidence)}
        for label, key in (("Corroborated by independent sources", "verified"), ("Contested across sources", "contested")):
            items = verification.get(key, [])[:5]
            if not items:
                continue
            lines.append(f"### {label}")
            for c in items:
                cites = " ".join(_cite(url_index[u]) for u in c.get("urls", []) if u in url_index)
                lines.append(f"- {c.get('claim', '')[:260]} {cites}".rstrip())
            lines.append("")

    voices = notable_voices(evidence)
    if any(voices.values()):
        lines.append("## Notable Voices")
        for label, items in voices.items():
            if items:
                lines.append(f"- **{label}:** " + ", ".join(f"{name} ({cnt})" if cnt > 1 else name for name, cnt in items))
        lines.append("")

    videos = [i for i in all_idx if _get(evidence[i], "lane", "") == "video"][:6]
    if videos:
        lines.append("## Top Videos")
        for i in videos:
            meta = _get(evidence[i], "meta", {}) or {}
            extra = []
            if meta.get("author"):
                extra.append(str(meta["author"]))
            if meta.get("views"):
                try:
                    extra.append(f"{int(meta['views']):,} views")
                except (TypeError, ValueError):
                    pass
            if meta.get("has_transcript"):
                extra.append("transcript read")
            lines.append(f"- {_get(evidence[i], 'title', 'Video')} {_cite(i)}" + (f" — {' · '.join(extra)}" if extra else ""))
        lines.append("")

    if followups:
        lines.append("## Open Questions & Next Digs")
        lines += [f"- {f}" for f in followups]
        lines.append("")
    lines.append("*Synthesised locally (extractive). Enable “AI-written report” for a narrative analysis.*")
    return "\n".join(lines).strip()


def _evidence_block(evidence: list, idxs: list[int], watchlist: list[str], max_chars: int = 1100) -> str:
    blocks = []
    for i in idxs:
        e = evidence[i]
        lane = LANE_LABELS.get(_get(e, "lane", "") or "web", "Web")
        meta = _get(e, "meta", {}) or {}
        tag = lane
        if meta.get("year"):
            tag += f", {meta['year']}"
        if meta.get("community"):
            tag += f", {meta['community']}"
        if meta.get("citations"):
            tag += f", cited {meta['citations']}x"
        text = redact((_get(e, "excerpt", "") or _get(e, "snippet", "") or "")[:max_chars], watchlist)
        title = redact(_get(e, "title", "") or "", watchlist)
        blocks.append(f"[{i + 1}] ({tag}) {title}\n{text}")
    return "\n\n".join(blocks)


def _fix_citations(text: str, n: int) -> str:
    def repl(m):
        nums = [x.strip() for x in m.group(1).split(",")]
        keep = [x for x in nums if x.isdigit() and 1 <= int(x) <= n]
        return f"[{', '.join(keep)}]" if keep else ""
    return re.sub(r"\[(\d+(?:\s*,\s*\d+)*)\]", repl, text)


def build_llm_brief(topic: str, evidence: list, watchlist: list[str], plan=None, verification: dict | None = None,
                    followups: list | None = None, model: str = "gpt-4o", reasoning_effort=None,
                    cost_tracker=None, progress_callback=None, max_sections: int = 8) -> str:
    """Section-by-section cited report, then a cross-cutting synthesis pass."""
    from backend.research.cloud_client import invoke_model

    assert_safe_to_send(topic, watchlist)
    if not evidence:
        raise ValueError("no evidence to write from")
    n = len(evidence)
    all_idx = list(range(n))
    sections: list[tuple[str, str]] = []
    sub_questions = list(getattr(plan, "sub_questions", []) or [])[:max_sections] if plan else []
    for k, sq in enumerate(sub_questions, start=1):
        idxs = [i for i in all_idx if _get(evidence[i], "subq", "") == sq.id][:10]
        if len(idxs) < 4:
            extra = sorted((i for i in all_idx[:80] if i not in idxs),
                           key=lambda i: -overlap_score(terms(sq.question), _get(evidence[i], "excerpt", "") or ""))
            idxs += extra[: 8 - len(idxs)]
        if progress_callback:
            progress_callback(f"Writing section {k}/{len(sub_questions)}: {sq.question[:70]}")
        prompt = (
            "You are a meticulous research analyst writing one section of a deep-research report.\n"
            f"Overall topic: {topic}\nSection question: {sq.question}\n\n"
            "Using ONLY the sources below, write 2-4 dense paragraphs or bullet groups that answer the question. "
            "Distinguish peer-reviewed evidence from community/practitioner reports and expert opinion. Quantify "
            "where sources give numbers. Flag disagreements explicitly. Cite every claim inline with the source "
            "numbers like [3] or [3, 7]. Never invent sources. If evidence is thin, say so.\n\n"
            f"Sources:\n{_evidence_block(evidence, idxs, watchlist)}"
        )
        assert_safe_to_send(prompt, watchlist)
        body = invoke_model(prompt, model=model, reasoning_effort=reasoning_effort, cost_tracker=cost_tracker,
                            max_output_tokens=900)
        sections.append((sq.question, _fix_citations(redact(body.strip(), watchlist), n)))

    if progress_callback:
        progress_callback("Writing the executive synthesis...")
    acad = [i for i in all_idx if (_get(evidence[i], "lane", "") or "") in EVIDENCE_LANES][:10]
    disc = [i for i in all_idx if (_get(evidence[i], "lane", "") or "") in DISCUSSION_LANES][:10]
    verification_text = ""
    if verification:
        try:
            from backend.synthesis.claim_verifier import verification_brief
            verification_text = verification_brief(verification)
        except Exception:
            verification_text = ""
    drafts = "\n\n".join(f"### {q}\n{body}" for q, body in sections)
    top_idx = all_idx[:14] if not sections else []
    prompt = (
        "You are the lead analyst finishing a deep-research report.\n"
        f"Topic: {topic}\n\n"
        + (f"Section drafts (already cited):\n{drafts}\n\n" if drafts else "")
        + (f"Top sources:\n{_evidence_block(evidence, top_idx, watchlist)}\n\n" if top_idx else "")
        + f"Scholarly/institutional sources:\n{_evidence_block(evidence, acad, watchlist, 600)}\n\n"
        + f"Community/expert/video sources:\n{_evidence_block(evidence, disc, watchlist, 600)}\n\n"
        + (f"Local cross-source claim check:\n{verification_text}\n\n" if verification_text else "")
        + "Write these sections in markdown, citing inline with [n]:\n"
        "## Executive Summary\n(4-6 sentences: the bottom line, confidence level, and the single most important caveat)\n\n"
        "## Key Findings\n(6-10 bullets, strongest first, each cited; mark confidence High/Medium/Low)\n\n"
        "## Research vs. Community\n(where scientific evidence and practitioner/community experience agree, where they "
        "diverge, and what each sees that the other misses)\n\n"
        "## Contested & Uncertain\n(disagreements and weak evidence; never average conflicting numbers)\n\n"
        "## Open Questions & Next Digs\n(3-6 specific follow-up research directions)\n"
        "Never invent sources or numbers."
    )
    assert_safe_to_send(prompt, watchlist)
    final = invoke_model(prompt, model=model, reasoning_effort=reasoning_effort, cost_tracker=cost_tracker,
                         max_output_tokens=2200)
    final = _fix_citations(redact(final.strip(), watchlist), n)
    final = re.sub(r"^#\s+", "## ", final, flags=re.M)  # keep one H1 (the report title)
    parts = [final]
    if sections:
        parts.append("## Findings by Research Question")
        parts += [f"### {q}\n{body}" for q, body in sections]
    voices = notable_voices(evidence)
    if any(voices.values()):
        parts.append("## Notable Voices\n" + "\n".join(
            f"- **{label}:** " + ", ".join(f"{name} ({cnt})" if cnt > 1 else name for name, cnt in items)
            for label, items in voices.items() if items))
    if followups and "Next Digs" not in final:
        parts.append("## Suggested Next Digs\n" + "\n".join(f"- {f}" for f in followups))
    out = "\n\n".join(parts)
    assert_safe_to_send(out, watchlist)
    return out
