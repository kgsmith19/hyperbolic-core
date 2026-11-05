"""Source lanes and quality priors.

Every retrieved URL is assigned a *lane* (what kind of source it is) and a
*quality prior* (how much weight it deserves before relevance). Lanes power
the academic-vs-discussion mix: the explorer balances the corpus toward the
user's requested share and the report groups findings per lane.

Lanes
-----
academic   peer-reviewed papers, preprints, scholarly indexes
gov        government, intergovernmental, university/institutional pages
reference  encyclopedias
filings    regulatory/corporate filings (SEC EDGAR)
community  forums, Reddit, Hacker News, Stack Exchange, discussion boards
video      YouTube, Vimeo, TED (transcripts when available)
expert     newsletters, expert blogs, Substack/Medium, podcasts
news       established newsrooms and science journalism
code       repositories and model hubs
archive    Internet Archive / Wayback material
web        everything else

Groups: evidence = academic+gov+reference+filings, discussion =
community+video+expert, neutral = news+code+archive+web.
"""

from __future__ import annotations

import math
import re
import urllib.parse

LANES = (
    "academic", "gov", "reference", "filings",
    "community", "video", "expert",
    "news", "code", "archive", "web",
)
EVIDENCE_LANES = frozenset({"academic", "gov", "reference", "filings"})
DISCUSSION_LANES = frozenset({"community", "video", "expert"})

LANE_LABELS = {
    "academic": "Academic",
    "gov": "Institutional",
    "reference": "Reference",
    "filings": "Filings",
    "community": "Community",
    "video": "Video",
    "expert": "Experts & blogs",
    "news": "News",
    "code": "Code",
    "archive": "Archive",
    "web": "Web",
}

_ACADEMIC = (
    "arxiv.org", "doi.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "europepmc.org",
    "semanticscholar.org", "openalex.org", "sciencedirect.com", "springer.com", "nature.com",
    "wiley.com", "tandfonline.com", "sagepub.com", "plos.org", "frontiersin.org", "mdpi.com",
    "biorxiv.org", "medrxiv.org", "ssrn.com", "jstor.org", "ieee.org", "acm.org", "cell.com",
    "thelancet.com", "nejm.org", "bmj.com", "jamanetwork.com", "science.org", "pnas.org",
    "academic.oup.com", "cambridge.org", "researchgate.net", "scholar.archive.org", "core.ac.uk",
    "doaj.org", "osf.io", "aclanthology.org", "openreview.net", "neurips.cc", "mlr.press",
    "hindawi.com", "karger.com", "thieme-connect.com", "elifesciences.org", "peerj.com",
    "royalsocietypublishing.org", "iop.org", "aps.org", "acs.org", "rsc.org", "annualreviews.org",
    "cochranelibrary.com", "biomedcentral.com", "europepmc", "crossref.org", "scielo",
    "paperswithcode.com", "jneurosci.org", "physiology.org", "ahajournals.org", "asm.org",
)
_PREPRINT = ("arxiv.org", "biorxiv.org", "medrxiv.org", "ssrn.com", "osf.io", "preprints.org", "researchsquare.com")
_COMMUNITY = (
    "reddit.com", "redd.it", "news.ycombinator.com", "stackexchange.com", "stackoverflow.com",
    "superuser.com", "serverfault.com", "askubuntu.com", "mathoverflow.net", "quora.com",
    "lobste.rs", "tildes.net", "slashdot.org", "xda-developers.com", "lemmy.world",
    "healthunlocked.com", "discourse.org", "forums.", "forum.", "community.", "discuss.",
    "boards.", "bodybuilding.com", "longecity.org", "head-fi.org", "avsforum.com",
    "physicsforums.com", "lesswrong.com", "news.ycombinator", "producthunt.com", "kaggle.com/discussions",
)
_VIDEO = ("youtube.com", "youtu.be", "vimeo.com", "ted.com", "rumble.com", "odysee.com")
_EXPERT = (
    "substack.com", "medium.com", "ghost.io", "beehiiv.com", "podcasts.apple.com",
    "open.spotify.com", "linkedin.com/pulse", "towardsdatascience.com", "simonwillison.net",
    "examine.com", "statnews.com/first-opinion", "overcast.fm", "listennotes.com",
)
_REFERENCE = ("wikipedia.org", "britannica.com", "plato.stanford.edu", "iep.utm.edu", "scholarpedia.org")
_NEWS = (
    "reuters.com", "apnews.com", "bbc.co.uk", "bbc.com", "nytimes.com", "wsj.com", "ft.com",
    "bloomberg.com", "theguardian.com", "washingtonpost.com", "economist.com", "wired.com",
    "arstechnica.com", "theverge.com", "techcrunch.com", "statnews.com", "sciencenews.org",
    "newscientist.com", "scientificamerican.com", "quantamagazine.org", "theatlantic.com",
    "npr.org", "axios.com", "politico.com", "cnbc.com", "forbes.com", "nature.com/articles/d4",
    "science.org/content/article", "technologyreview.com", "spectrum.ieee.org",
)
_CODE = ("github.com", "gitlab.com", "huggingface.co", "pypi.org", "npmjs.com", "bitbucket.org", "codeberg.org")
_ARCHIVE = ("web.archive.org", "archive.org")
_LOW_QUALITY = (
    "pinterest.", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
    "scribd.com", "coursehero.com", "chegg.com", "studocu.com", "slideshare.net",
)
_LISTICLE_RE = re.compile(r"\b(top[- ]\d+|\d+[- ]best|best[- ]\w+[- ](?:in|for)[- ]20\d\d|you won'?t believe)\b", re.I)
_FORUM_PATH_RE = re.compile(r"/(forum|forums|thread|threads|topic|topics|discussion|discussions|community|t)/", re.I)
_BLOG_PATH_RE = re.compile(r"/(blog|posts?|newsletter|essays?)/", re.I)


def _host_path(url: str) -> tuple[str, str]:
    try:
        parsed = urllib.parse.urlparse(url or "")
        host = (parsed.netloc or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return host, (parsed.path or "").lower()
    except Exception:
        return "", ""


def _matches(host: str, hostpath: str, needles) -> bool:
    for needle in needles:
        if needle.endswith("."):
            if host.startswith(needle) or f".{needle}" in f".{host}":
                return True
        elif "/" in needle:
            if needle in hostpath:
                return True
        elif host == needle or host.endswith("." + needle) or (needle in host and "." not in needle):
            return True
    return False


_SOURCE_LANES = {
    "openalex": "academic", "openalex-citations": "academic", "arxiv": "academic",
    "crossref": "academic", "pubmed_pmc": "academic", "europepmc": "academic",
    "semantic_scholar": "academic", "doaj": "academic",
    "hackernews": "community", "reddit": "community", "stackexchange": "community",
    "wikipedia": "reference", "sec_edgar": "filings", "github": "code",
    "internet_archive": "archive", "youtube": "video",
}


def classify_lane(url: str, source: str = "") -> str:
    """Return the lane for a URL, using the connector name as a hint."""
    host, path = _host_path(url)
    hostpath = f"{host}{path}"
    if host.endswith("sec.gov"):
        return "filings"
    if _matches(host, hostpath, _ARCHIVE):
        return "archive"
    if _matches(host, hostpath, _VIDEO):
        return "video"
    if _matches(host, hostpath, _COMMUNITY):
        return "community"
    if host == "github.com" and re.search(r"/(issues|discussions|pull)/", path):
        return "community"
    if _matches(host, hostpath, _NEWS):
        return "news"
    if _matches(host, hostpath, _ACADEMIC):
        return "academic"
    if _matches(host, hostpath, _REFERENCE):
        return "reference"
    if _matches(host, hostpath, _CODE):
        return "code"
    if _matches(host, hostpath, _EXPERT):
        return "expert"
    base = (source or "").split("|")[0].split(":")[0]
    if base in _SOURCE_LANES:
        return _SOURCE_LANES[base]
    if re.search(r"\.(gov|mil|int)$", host) or ".gov." in host or host.endswith(".edu") or ".ac." in host \
            or host.endswith("europa.eu") or host in ("who.int", "un.org", "oecd.org", "worldbank.org", "nih.gov"):
        return "gov"
    if _FORUM_PATH_RE.search(path):
        return "community"
    if _BLOG_PATH_RE.search(path) or host.startswith("blog."):
        return "expert"
    return "web"


def lane_group(lane: str) -> str:
    if lane in EVIDENCE_LANES:
        return "evidence"
    if lane in DISCUSSION_LANES:
        return "discussion"
    return "neutral"


_BASE_PRIOR = {
    "academic": 0.82, "gov": 0.78, "reference": 0.68, "filings": 0.72, "news": 0.64,
    "community": 0.56, "expert": 0.56, "video": 0.52, "code": 0.6, "archive": 0.55, "web": 0.45,
}


def quality_prior(url: str, lane: str | None = None, meta: dict | None = None, title: str = "") -> float:
    """Return a 0..1 source-quality prior from lane, signals, and red flags."""
    lane = lane or classify_lane(url)
    meta = meta or {}
    q = _BASE_PRIOR.get(lane, 0.45)
    host, path = _host_path(url)

    def _num(key):
        try:
            return float(meta.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0

    citations = _num("citations")
    if citations:
        q += min(0.12, 0.03 * math.log10(1 + citations) * 2)
    if lane == "academic" and _matches(host, f"{host}{path}", _PREPRINT):
        q -= 0.06
    score = _num("score") or _num("points")
    comments = _num("comments")
    if score or comments:
        q += min(0.14, 0.025 * math.log10(1 + score + 2 * comments) * 2)
    views = _num("views")
    if views:
        q += min(0.1, 0.015 * math.log10(1 + views) * 2)
    if meta.get("accepted") or meta.get("is_answered"):
        q += 0.04
    if _matches(host, f"{host}{path}", _LOW_QUALITY):
        q -= 0.2
    if title and _LISTICLE_RE.search(title):
        q -= 0.08
    return round(max(0.05, min(0.99, q)), 3)


def quality_tier(url: str, lane: str, quality: float) -> str:
    """Human-readable tier label for the UI and report."""
    host, path = _host_path(url)
    if lane == "academic":
        return "Preprint" if _matches(host, f"{host}{path}", _PREPRINT) else "Scholarly"
    if quality >= 0.75:
        return "High signal"
    if quality >= 0.55:
        return "Solid"
    if quality >= 0.4:
        return "Mixed"
    return "Low signal"


def mix_targets(academic_weight: float, lanes: list[str] | None = None) -> dict[str, float]:
    """Target corpus shares per lane from the academic/discussion slider.

    academic_weight in [0, 1] is the evidence-group share; discussion gets the
    remainder. Neutral lanes (web/news/code/archive) take a fixed 20% slice so
    general web context is never starved. Shares inside a group split evenly
    with a tilt toward the flagship lane of the group.
    """
    w = max(0.0, min(1.0, float(academic_weight)))
    enabled = set(lanes or LANES)
    neutral_share = 0.2
    groups = {
        "evidence": (["academic", "gov", "reference", "filings"], [0.6, 0.22, 0.1, 0.08], w * (1 - neutral_share)),
        "discussion": (["community", "video", "expert"], [0.55, 0.25, 0.2], (1 - w) * (1 - neutral_share)),
        "neutral": (["web", "news", "code", "archive"], [0.5, 0.3, 0.1, 0.1], neutral_share),
    }
    out: dict[str, float] = {}
    for members, weights, share in groups.values():
        active = [(m, wt) for m, wt in zip(members, weights) if m in enabled]
        total = sum(wt for _, wt in active)
        for m, wt in active:
            out[m] = share * wt / total if total else 0.0
    norm = sum(out.values()) or 1.0
    return {k: round(v / norm, 4) for k, v in out.items()}
