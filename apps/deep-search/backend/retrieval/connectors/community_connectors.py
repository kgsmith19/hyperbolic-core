"""Community, discussion, video, code, and archive connectors.

Search entry points return frontier-ready dicts tagged with a lane.
Fetch helpers turn hard-to-scrape discussion pages into readable text:

- Reddit threads: reddit JSON first, PullPush archive second (post + top comments).
- Hacker News items: Algolia items API (story + top-level comments).
- YouTube videos: title/channel/description/views + transcript when available.
- Wayback snapshots: deep-web fallback for dead, blocked, or walled pages.
"""

from __future__ import annotations

import html
import importlib
import json
import re

import httpx

try:
    from curl_cffi import requests as curl_requests
except ImportError:  # pragma: no cover
    curl_requests = None

_UA = {"User-Agent": "DeepSearch/3.0 (open research tool; contact: research@deepsearch.local)"}
_BROWSER_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}


def _clean(text) -> str:
    if not isinstance(text, str):
        return ""
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", text).strip()


def _get_json(url: str, params: dict | None = None, timeout: float = 10.0, browser: bool = False):
    try:
        if browser and curl_requests is not None:
            resp = curl_requests.get(url, params=params, headers={**_BROWSER_UA, "Accept": "application/json"},
                                     impersonate="chrome124", timeout=timeout)
            if resp.status_code != 200:
                return None
            return json.loads(resp.text)
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(url, params=params, headers=_UA)
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:
        return None


# --------------------------------------------------------------------------- Reddit

def search_reddit(query: str, limit: int = 15) -> list[dict]:
    """Search Reddit submissions via reddit JSON, falling back to the PullPush archive."""
    if not query or not query.strip():
        return []
    posts = []
    data = _get_json("https://www.reddit.com/search.json",
                     {"q": query.strip()[:250], "limit": limit, "sort": "relevance", "raw_json": 1}, browser=True)
    if isinstance(data, dict):
        posts = [c.get("data", {}) for c in (data.get("data") or {}).get("children", []) if isinstance(c, dict)]
    if not posts:
        data = _get_json("https://api.pullpush.io/reddit/search/submission/",
                         {"q": query.strip()[:250], "size": limit, "sort_type": "score", "sort": "desc"}, timeout=12)
        if isinstance(data, dict):
            posts = [p for p in data.get("data", []) if isinstance(p, dict)]
    out = []
    for p in posts:
        permalink = p.get("permalink") or ""
        if not permalink:
            continue
        score = int(p.get("score") or 0)
        comments = int(p.get("num_comments") or 0)
        sub = p.get("subreddit") or ""
        body = _clean(p.get("selftext"))
        out.append({
            "title": _clean(p.get("title")) or "Reddit thread",
            "url": "https://www.reddit.com" + permalink,
            "snippet": f"r/{sub} · {score} points · {comments} comments. {body[:220]}".strip(),
            "source": "reddit",
            "lane": "community",
            "meta": {"community": f"r/{sub}" if sub else "", "score": score, "comments": comments,
                     "author": p.get("author") or ""},
        })
    return out


_REDDIT_THREAD_RE = re.compile(r"reddit\.com/r/([^/]+)/comments/([a-z0-9]+)", re.I)


def fetch_reddit_thread(url: str, max_comments: int = 30) -> dict | None:
    """Readable text for a Reddit thread: post plus highest-scored comments."""
    m = _REDDIT_THREAD_RE.search(url or "")
    if not m:
        return None
    sub, post_id = m.group(1), m.group(2)
    title, selftext, score, n_comments, comments = "", "", 0, 0, []
    data = _get_json(f"https://www.reddit.com/r/{sub}/comments/{post_id}/.json",
                     {"limit": 100, "sort": "top", "raw_json": 1}, browser=True)
    if isinstance(data, list) and data:
        try:
            post = data[0]["data"]["children"][0]["data"]
            title, selftext = post.get("title", ""), post.get("selftext", "")
            score, n_comments = int(post.get("score") or 0), int(post.get("num_comments") or 0)

            def walk(children, depth):
                for child in children or []:
                    d = child.get("data", {}) if isinstance(child, dict) else {}
                    body = d.get("body")
                    if body:
                        comments.append((int(d.get("score") or 0), depth, body))
                    replies = d.get("replies")
                    if depth < 2 and isinstance(replies, dict):
                        walk(replies.get("data", {}).get("children", []), depth + 1)
            walk(data[1]["data"]["children"], 0)
        except Exception:
            pass
    if not title:
        pdata = _get_json("https://api.pullpush.io/reddit/search/submission/", {"ids": post_id}, timeout=12)
        if isinstance(pdata, dict) and pdata.get("data"):
            post = pdata["data"][0]
            title, selftext = post.get("title", ""), post.get("selftext", "")
            score, n_comments = int(post.get("score") or 0), int(post.get("num_comments") or 0)
    if not comments:
        cdata = _get_json("https://api.pullpush.io/reddit/search/comment/",
                          {"link_id": post_id, "size": 100, "sort_type": "score", "sort": "desc"}, timeout=12)
        if isinstance(cdata, dict):
            comments = [(int(c.get("score") or 0), 0, c.get("body") or "") for c in cdata.get("data", []) if isinstance(c, dict)]
    if not title and not comments:
        return None
    comments = [c for c in comments if c[2] and c[2] not in ("[deleted]", "[removed]")]
    comments.sort(key=lambda c: -c[0])
    lines = [f"Reddit thread in r/{sub}: {_clean(title)}", f"{score} points, {n_comments} comments.", ""]
    if selftext and selftext not in ("[deleted]", "[removed]"):
        lines += ["Original post:", _clean(selftext)[:4000], ""]
    if comments:
        lines.append("Top community replies (highest score first):")
        for c_score, depth, body in comments[:max_comments]:
            prefix = "  " * depth
            lines.append(f"{prefix}- [{c_score} pts] {_clean(body)[:900]}")
    return {
        "url": url, "status": "ok", "title": _clean(title) or f"r/{sub} thread",
        "content": "\n".join(lines), "links": [], "bytes": sum(len(c[2]) for c in comments) + len(selftext or ""),
        "renderer": "reddit", "lane": "community",
        "meta": {"community": f"r/{sub}", "score": score, "comments": n_comments},
    }


# --------------------------------------------------------------------------- Hacker News

def fetch_hn_item(url: str, max_comments: int = 30) -> dict | None:
    m = re.search(r"news\.ycombinator\.com/item\?id=(\d+)", url or "")
    if not m:
        return None
    data = _get_json(f"https://hn.algolia.com/api/v1/items/{m.group(1)}", timeout=12)
    if not isinstance(data, dict):
        return None
    title = data.get("title") or "Hacker News discussion"
    lines = [f"Hacker News discussion: {title}", f"{data.get('points') or 0} points.", ""]
    if data.get("text"):
        lines += [_clean(data["text"])[:3000], ""]
    kids = [k for k in data.get("children", []) if isinstance(k, dict) and k.get("text")]
    if kids:
        lines.append("Top-level comments:")
        for k in kids[:max_comments]:
            lines.append(f"- {k.get('author') or 'anon'}: {_clean(k['text'])[:900]}")
    links = [data["url"]] if data.get("url") else []
    return {"url": url, "status": "ok", "title": f"HN: {title}", "content": "\n".join(lines), "links": links,
            "bytes": len("\n".join(lines)), "renderer": "hn", "lane": "community",
            "meta": {"points": int(data.get("points") or 0), "comments": len(kids), "community": "Hacker News"}}


# --------------------------------------------------------------------------- Stack Exchange

def search_stackexchange(query: str, limit: int = 10, site: str = "stackoverflow") -> list[dict]:
    if not query or not query.strip():
        return []
    data = _get_json("https://api.stackexchange.com/2.3/search/advanced",
                     {"order": "desc", "sort": "relevance", "q": query.strip()[:200], "site": site,
                      "pagesize": max(1, min(30, limit)), "filter": "withbody"})
    out = []
    for item in (data or {}).get("items", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict) or not item.get("link"):
            continue
        body = _clean(item.get("body"))
        out.append({
            "title": _clean(item.get("title")),
            "url": item["link"],
            "snippet": f"{item.get('score', 0)} votes · {item.get('answer_count', 0)} answers. {body[:220]}",
            "source": "stackexchange",
            "lane": "community",
            "meta": {"community": site, "score": int(item.get("score") or 0),
                     "comments": int(item.get("answer_count") or 0), "is_answered": bool(item.get("is_answered"))},
        })
    return out


# --------------------------------------------------------------------------- GitHub

def search_github(query: str, limit: int = 8) -> list[dict]:
    data = _get_json("https://api.github.com/search/repositories",
                     {"q": query.strip()[:200], "per_page": max(1, min(30, limit)), "sort": "stars"})
    out = []
    for item in (data or {}).get("items", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict) or not item.get("html_url"):
            continue
        out.append({
            "title": f"GitHub: {item.get('full_name', '')}",
            "url": item["html_url"],
            "snippet": f"★ {item.get('stargazers_count', 0)} · {_clean(item.get('description'))[:240]}",
            "source": "github",
            "lane": "code",
            "meta": {"score": int(item.get("stargazers_count") or 0), "author": (item.get("owner") or {}).get("login", "")},
        })
    return out


# --------------------------------------------------------------------------- Internet Archive

def search_internet_archive(query: str, limit: int = 8) -> list[dict]:
    """Full-text-ish search over archive.org texts, talks, and collections."""
    data = _get_json("https://archive.org/advancedsearch.php",
                     {"q": f"({query.strip()[:200]}) AND mediatype:(texts OR movies OR audio)",
                      "fl[]": ["identifier", "title", "description", "mediatype", "year"],
                      "rows": max(1, min(30, limit)), "output": "json"})
    docs = ((data or {}).get("response") or {}).get("docs", []) if isinstance(data, dict) else []
    out = []
    for d in docs:
        ident = d.get("identifier")
        if not ident:
            continue
        desc = d.get("description")
        if isinstance(desc, list):
            desc = " ".join(str(x) for x in desc)
        title = d.get("title")
        if isinstance(title, list):
            title = title[0] if title else ""
        out.append({
            "title": f"Archive: {_clean(title)}",
            "url": f"https://archive.org/details/{ident}",
            "snippet": f"{d.get('mediatype', '')} {d.get('year', '')}. {_clean(desc)[:240]}".strip(),
            "abstract": _clean(desc)[:3000] if desc and len(_clean(desc)) > 300 else "",
            "source": "internet_archive",
            "lane": "archive",
        })
    return out


def wayback_snapshot_url(url: str) -> str:
    """Return the closest Wayback Machine snapshot URL, or ''."""
    data = _get_json("https://archive.org/wayback/available", {"url": url}, timeout=8)
    try:
        closest = (data or {})["archived_snapshots"]["closest"]
        if closest.get("available") and str(closest.get("status", "200")).startswith("2"):
            snap = closest["url"]
            return snap.replace("http://", "https://", 1)
    except Exception:
        pass
    return ""


# --------------------------------------------------------------------------- YouTube

_YT_ID_RE = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})")


def youtube_video_id(url: str) -> str:
    m = _YT_ID_RE.search(url or "")
    return m.group(1) if m else ""


def _json_string(raw: str) -> str:
    try:
        return json.loads(f'"{raw}"')
    except Exception:
        return raw.replace("\\n", "\n")


def fetch_youtube_video(url: str, max_transcript_chars: int = 30000) -> dict | None:
    vid = youtube_video_id(url)
    if not vid or curl_requests is None:
        return None
    title = channel = description = ""
    views = 0
    try:
        resp = curl_requests.get(f"https://www.youtube.com/watch?v={vid}", headers=_BROWSER_UA,
                                 impersonate="chrome124", timeout=12)
        page = resp.text if resp.status_code == 200 else ""
        m = re.search(r'<meta name="title" content="([^"]+)"', page)
        title = html.unescape(m.group(1)) if m else ""
        m = re.search(r'"ownerChannelName":"((?:\\.|[^"\\])*)"', page)
        channel = _json_string(m.group(1)) if m else ""
        m = re.search(r'"shortDescription":"((?:\\.|[^"\\])*)"', page)
        description = _json_string(m.group(1)) if m else ""
        m = re.search(r'"viewCount":"(\d+)"', page)
        views = int(m.group(1)) if m else 0
    except Exception:
        pass
    transcript = ""
    try:
        YouTubeTranscriptApi = importlib.import_module("youtube_transcript_api").YouTubeTranscriptApi  # optional dependency
        fetched = YouTubeTranscriptApi().fetch(vid)
        transcript = " ".join(s.text for s in fetched.snippets)
    except Exception:
        transcript = ""
    if not (title or description or transcript):
        return None
    lines = [f"YouTube video: {title}", f"Channel: {channel} · {views:,} views", ""]
    if description:
        lines += ["Description:", description[:3000], ""]
    if transcript:
        lines += ["Transcript:", re.sub(r"\s+", " ", transcript)[:max_transcript_chars]]
    links = re.findall(r"https?://[^\s\"'<>]+", description)[:10]
    return {"url": url, "status": "ok", "title": title or "YouTube video", "content": "\n".join(lines),
            "links": links, "bytes": len("\n".join(lines)), "renderer": "youtube", "lane": "video",
            "meta": {"author": channel, "views": views, "has_transcript": bool(transcript)}}


_JS_STR = r'((?:\\.|[^"\\])*)'


def search_youtube(query: str, limit: int = 8) -> list[dict]:
    """Search YouTube's public results page (no API key) for videos."""
    if not query or not query.strip() or curl_requests is None:
        return []
    try:
        resp = curl_requests.get("https://www.youtube.com/results", params={"search_query": query.strip()[:200]},
                                 headers=_BROWSER_UA, impersonate="chrome124", timeout=12)
        if resp.status_code != 200:
            return []
        page = resp.text
    except Exception:
        return []
    out, seen = [], set()
    for m in re.finditer(r'"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"(.{0,4000}?)"navigationEndpoint"', page, re.S):
        vid, chunk = m.group(1), m.group(2)
        if vid in seen:
            continue
        seen.add(vid)
        title_m = re.search(r'"title":\{"runs":\[\{"text":"' + _JS_STR + '"', chunk)
        title = _json_string(title_m.group(1)) if title_m else "YouTube video"
        out.append({"vid": vid, "title": title})
        if len(out) >= limit:
            break
    results = []
    for item in out:
        idx = page.find(f'"videoId":"{item["vid"]}"')
        window = page[idx: idx + 6000] if idx >= 0 else ""
        channel_m = re.search(r'"ownerText":\{"runs":\[\{"text":"' + _JS_STR + '"', window)
        views_m = re.search(r'"viewCountText":\{"simpleText":"([\d,\.]+) views"', window)
        snippet_m = re.search(r'"snippetText":\{"runs":\[(.*?)\]\}', window)
        snippet = ""
        if snippet_m:
            snippet = " ".join(_json_string(t) for t in re.findall(r'"text":"' + _JS_STR + '"', snippet_m.group(1)))
        channel = _json_string(channel_m.group(1)) if channel_m else ""
        views = int(views_m.group(1).replace(",", "").split(".")[0]) if views_m else 0
        results.append({
            "title": item["title"],
            "url": f"https://www.youtube.com/watch?v={item['vid']}",
            "snippet": f"{channel} · {views:,} views. {snippet}".strip(),
            "source": "youtube",
            "lane": "video",
            "meta": {"author": channel, "views": views},
        })
    return results
