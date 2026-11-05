"""Research plan: decompose a topic into sub-questions with lane-aware queries.

Borrowed from how frontier deep-research systems start:

- Gemini Deep Research shows an editable multi-point plan before it runs.
- Anthropic's Research lead agent decomposes the question and fans out
  parallel sub-investigations, starting wide, then narrowing.
- Stanford STORM asks questions from multiple *perspectives* (researcher,
  practitioner, skeptic, ...) to avoid single-angle tunnel vision.

Here the plan is a list of sub-questions; each carries its own queries and
preferred source lanes. Planning is local by default (perspective templates)
and model-assisted when ``ai_planning`` is on and the process is shown. The
user can edit the plan in the UI; an edited plan arrives as
``SearchOptions.plan`` and is used verbatim (after privacy checks).
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime

from backend.privacy.watchlist_redactor import SafetyError, assert_safe_to_send, redact

_STOP = frozenset({
    "the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with", "at", "by", "from",
    "is", "are", "was", "were", "what", "how", "why", "which", "that", "this", "these", "those",
    "its", "into", "about", "do", "does", "did", "can", "should", "would", "could", "will",
    "be", "been", "there", "their", "any", "all", "most", "best", "top", "current", "currently",
    "right", "now", "today", "really", "actually", "i", "me", "my", "we", "our", "you", "your",
    "tell", "explain", "give", "find", "know", "want", "need", "please", "some", "much", "many",
})


@dataclass
class SubQuestion:
    id: str
    question: str
    queries: list[str]
    lanes: list[str] = field(default_factory=list)
    rationale: str = ""
    perspective: str = ""


@dataclass
class ResearchPlan:
    topic: str
    objective: str
    sub_questions: list[SubQuestion]
    source: str = "local"

    def to_dict(self) -> dict:
        return asdict(self)

    def all_queries(self) -> list[str]:
        out: list[str] = []
        for sq in self.sub_questions:
            for q in sq.queries:
                if q and q not in out:
                    out.append(q)
        return out


def core_terms(topic: str, max_words: int = 7) -> str:
    """Compact keyword core of a long question (search engines prefer it)."""
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9\-\+\.']*", topic or "")
    kept = [w for w in words if w.lower() not in _STOP and len(w) > 1]
    if len(words) <= max_words and len(kept) >= max(1, len(words) - 3):
        return " ".join(words).strip()
    return " ".join(kept[:max_words]).strip() or (topic or "").strip()


# (perspective, question, query templates, preferred lanes). Questions are
# topic-free so they read naturally under any topic heading.
_PERSPECTIVES = [
    ("Evidence", "What do the strongest studies, reviews, and meta-analyses conclude?",
     ["{topic}", "{c} systematic review", "{c} meta-analysis randomized trial"], ["academic", "gov"]),
    ("Practitioners", "What do practitioners and communities report from real-world experience?",
     ["{c} experience results", "{c} reddit", "{c} forum discussion"], ["community", "video"]),
    ("Risks & criticism", "What are the limitations, risks, and counter-evidence?",
     ["{c} limitations criticism", "{c} risks side effects problems", "{c} no effect evidence"], ["academic", "community"]),
    ("Experts", "What do leading researchers and expert voices argue?",
     ["{c} expert opinion", "{c} interview podcast researcher", "{c} lecture explained"], ["expert", "video", "news"]),
    ("Mechanisms", "What mechanisms explain how and why it works — or doesn't?",
     ["{c} mechanism how it works", "{c} explained"], ["academic", "reference", "expert"]),
    ("Recent developments", "What changed in {y0}–{y1}: new studies, products, or findings?",
     ["{c} {y1}", "{c} new study {y1}", "{c} latest developments"], ["academic", "news"]),
    ("Practical application", "How is it applied in practice — protocols, methods, tools, and costs?",
     ["{c} how to protocol", "{c} best practices guide", "{c} cost"], ["community", "expert", "gov"]),
    ("Comparisons", "How does it compare with the main alternatives?",
     ["{c} vs alternatives comparison", "{c} compared"], ["community", "expert", "academic"]),
    ("Controversies", "Where do experts and communities disagree, and what is unresolved?",
     ["{c} controversy debate", "{c} open questions unresolved"], ["academic", "community", "news"]),
    ("Context & history", "What is the background and history?",
     ["{c} history background", "{c} overview"], ["reference", "academic"]),
    ("Data & numbers", "What quantitative data, benchmarks, and effect sizes exist?",
     ["{c} statistics data", "{c} benchmark results effect size"], ["academic", "gov"]),
    ("Regulation & policy", "What do regulators, standards bodies, and official guidance say?",
     ["{c} regulation policy guidelines", "{c} official guidance"], ["gov", "filings", "news"]),
]


def _safe_query(text: str, watchlist: list[str]) -> str:
    clean = redact(re.sub(r"\s+", " ", text or "").strip(" \"'"), watchlist)[:240]
    if not clean:
        return ""
    try:
        assert_safe_to_send(clean, watchlist)
    except SafetyError:
        return ""
    return clean


def local_plan(topic: str, watchlist: list[str], breadth: int = 6, context_topic: str = "") -> ResearchPlan:
    """Perspective-template plan (no model, no egress)."""
    year = datetime.now().year
    # Short keyword core for modifier queries: long queries starve recall.
    core = core_terms(topic, 4)
    t_short = topic.strip().rstrip("?.!")
    if len(t_short) > 120:
        t_short = core
    ctx = core_terms(context_topic, 4) if context_topic else ""
    subs: list[SubQuestion] = []
    for idx, (persp, q_tmpl, query_tmpls, lanes) in enumerate(_PERSPECTIVES[: max(1, breadth)], start=1):
        queries = []
        for qt in query_tmpls:
            q = qt.format(topic=topic.strip(), c=core, y0=year - 1, y1=year)
            if ctx and qt != "{topic}" and ctx.lower() not in q.lower():
                q = f"{q} {ctx}"
            q = _safe_query(q, watchlist)
            if q and q not in queries:
                queries.append(q)
        subs.append(SubQuestion(
            id=f"q{idx}", question=q_tmpl.format(y0=year - 1, y1=year),
            queries=queries, lanes=list(lanes), perspective=persp,
        ))
    return ResearchPlan(topic=topic, objective=f"Build a deep, well-sourced understanding of: {t_short}",
                        sub_questions=subs, source="local")


def _parse_json_block(text: str):
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def model_plan(topic: str, watchlist: list[str], breadth: int, model: str, reasoning_effort=None,
               cost_tracker=None, context_topic: str = "", strictness: float = 0.9,
               force_direction: bool = True) -> ResearchPlan | None:
    """Ask the model for a structured plan (show-process mode only)."""
    from backend.research.cloud_client import get_api_key, invoke_model

    if not get_api_key(model):
        return None
    assert_safe_to_send(topic, watchlist)
    year = datetime.now().year
    ctx = f"\nThis is a follow-up dig inside a broader investigation of: {context_topic}\n" if context_topic else ""
    direction_guidance = ""
    if force_direction:
        direction_guidance = (
            f"\nStrict adherence constraint (strictness {strictness:.2f}): Strictly maintain the exact direction, "
            "premise, and specific requirements of the user topic without assuming alternative or broader topics "
            "are preferred.\n"
        )
    prompt = (
        "You are the lead researcher planning an exhaustive deep-research investigation.\n"
        f"Topic: {topic}\n{ctx}Current year: {year}\n{direction_guidance}\n"
        f"Decompose the topic into {breadth} complementary sub-questions that together cover: the strongest "
        "scientific evidence, real-world practitioner/community experience, expert opinion, risks and "
        "counter-evidence, recent developments, and practical application. Prefer specific, answerable questions.\n"
        "For each sub-question give 2-4 search-engine queries (keyword style, no quotes unless needed) and the "
        "best source lanes from: academic, community, video, expert, gov, reference, news, filings, code, archive.\n\n"
        'Return ONLY JSON: {"objective": str, "sub_questions": [{"question": str, "rationale": str, '
        '"queries": [str], "lanes": [str]}]}'
    )
    assert_safe_to_send(prompt, watchlist)
    output = invoke_model(prompt, model=model, reasoning_effort=reasoning_effort,
                          cost_tracker=cost_tracker, max_output_tokens=1800)
    data = _parse_json_block(output)
    if not isinstance(data, dict):
        return None
    subs: list[SubQuestion] = []
    for idx, raw in enumerate(data.get("sub_questions") or [], start=1):
        if not isinstance(raw, dict):
            continue
        question = _safe_query(str(raw.get("question", "")), watchlist)
        queries = [q for q in (_safe_query(str(x), watchlist) for x in (raw.get("queries") or [])[:4]) if q]
        if not question or not queries:
            continue
        lanes = [str(lane).lower() for lane in (raw.get("lanes") or []) if isinstance(lane, str)][:5]
        subs.append(SubQuestion(id=f"q{idx}", question=question, queries=queries, lanes=lanes,
                                rationale=_safe_query(str(raw.get("rationale", "")), watchlist)))
        if len(subs) >= breadth:
            break
    if not subs:
        return None
    if topic not in subs[0].queries:
        subs[0].queries.insert(0, topic)
    objective = _safe_query(str(data.get("objective", "")), watchlist) or f"Deep research: {topic}"
    return ResearchPlan(topic=topic, objective=objective, sub_questions=subs, source="model")


def plan_from_user(topic: str, raw_plan: list[dict], watchlist: list[str]) -> ResearchPlan:
    """Accept an edited plan from the UI, enforcing the privacy guard per query."""
    subs: list[SubQuestion] = []
    for idx, raw in enumerate(raw_plan or [], start=1):
        if not isinstance(raw, dict):
            continue
        if raw.get("enabled") is False:
            continue
        question = _safe_query(str(raw.get("question", "")), watchlist)
        queries = [q for q in (_safe_query(str(x), watchlist) for x in (raw.get("queries") or [])[:8]) if q]
        if not queries and question:
            queries = [question]
        if not queries:
            continue
        lanes = [str(lane).lower() for lane in (raw.get("lanes") or []) if isinstance(lane, str)][:8]
        subs.append(SubQuestion(id=str(raw.get("id") or f"q{idx}")[:12], question=question or queries[0],
                                queries=queries, lanes=lanes, perspective=str(raw.get("perspective", ""))[:40]))
    if not subs:
        return local_plan(topic, watchlist, breadth=1)
    return ResearchPlan(topic=topic, objective=f"Deep research: {topic}", sub_questions=subs, source="user")


def build_research_plan(topic: str, watchlist: list[str], options, cost_tracker=None, note=None) -> ResearchPlan:
    """User plan > model plan (show mode) > local perspective plan."""
    if options.plan:
        return plan_from_user(topic, options.plan, watchlist)
    breadth = max(1, int(options.breadth or 1))
    if breadth <= 1:
        return ResearchPlan(topic=topic, objective=f"Research: {topic}",
                            sub_questions=[SubQuestion(id="q1", question=topic, queries=[topic], perspective="Topic")],
                            source="local")
    if options.ai_planning and not options.conceal_process:
        try:
            plan = model_plan(
                topic, watchlist, breadth, options.concealer_model, options.reasoning_effort,
                cost_tracker, context_topic=options.context_topic,
                strictness=getattr(options, "strictness", 0.9),
                force_direction=getattr(options, "force_direction", True),
            )
            if plan:
                return plan
        except Exception as err:  # CloudCallError, parsing, spend cap
            if note:
                note(f"Model planning unavailable ({type(err).__name__}); using the local perspective plan.")
    return local_plan(topic, watchlist, breadth=breadth, context_topic=options.context_topic)
