"""HTML Content Extractor & Academic Cleaner.

Extracts clean article body text and discovers candidate links/DOIs using
trafilatura with academic repository boilerplate pruning.
"""

import html
import re
import trafilatura
from backend.retrieval.ssrf_validator import is_safe_url


def extract_clean_content(raw_html: str, max_chars: int = 4000) -> tuple[str, list[str]]:
    """Extract clean article body and candidate links using trafilatura with domain-specific cleaning."""
    if not raw_html:
        return "", []

    extracted_text = trafilatura.extract(
        raw_html,
        include_links=False,
        include_comments=False,
        include_tables=True,
        no_fallback=False
    )

    if not extracted_text or len(extracted_text.strip()) < 50:
        cleaned = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", raw_html, flags=re.DOTALL | re.IGNORECASE)
        cleaned = re.sub(r"<!--.*?-->", " ", cleaned, flags=re.DOTALL)
        cleaned = re.sub(r"<[^>]+>", " ", cleaned)
        unescaped = html.unescape(cleaned)
        extracted_text = re.sub(r"\s+", " ", unescaped).strip()

    # Clean academic repository boilerplate (e.g. arXiv widgets, submission history, tool sidebars)
    if extracted_text and ("arxiv" in raw_html.lower() or "Bibliographic and Citation Tools" in extracted_text or "Abstract:" in extracted_text):
        if "Title:" in extracted_text and "Abstract:" in extracted_text:
            t_part = extracted_text[extracted_text.find("Title:") + len("Title:"):].strip()
            t_line = t_part.splitlines()[0].strip() if t_part else ""
            a_part = extracted_text[extracted_text.find("Abstract:") + len("Abstract:"):].strip()
            for stop_marker in ["Bibliographic and Citation Tools", "Submission history", "References & Citations", "Current browse context"]:
                if stop_marker in a_part:
                    a_part = a_part.split(stop_marker)[0].strip()
            if t_line and a_part:
                extracted_text = f"Title: {t_line}\n\nAbstract:\n{a_part}"
        else:
            for stop_marker in ["Bibliographic and Citation Tools", "Code, Data and Media Associated with this Article", "References & Citations Loading..."]:
                if stop_marker in extracted_text:
                    extracted_text = extracted_text.split(stop_marker)[0].strip()

    # Extract candidate links & DOIs
    links = []
    # Extract hrefs
    for match in re.finditer(r'href=[\'"](https?://[^\'">\s]+)[\'"]', raw_html, re.IGNORECASE):
        u = match.group(1).strip()
        if is_safe_url(u) and u not in links:
            links.append(u)
            if len(links) >= 15:
                break

    # Extract DOIs
    for match in re.finditer(r'\b(10\.\d{4,9}/[-._;()/:A-Z0-9]+)\b', raw_html, re.IGNORECASE):
        doi = match.group(1).rstrip(".;,")
        doi_url = f"https://doi.org/{doi}"
        if doi_url not in links:
            links.append(doi_url)

    bounded_text = extracted_text[:max_chars].strip() if extracted_text else ""

    # PDF support: trafilatura returns nothing useful for PDFs, so extract
    # text from the raw bytes with a dependency-free latin1/decode fallback.
    # Scanned-image PDFs yield nothing here (no OCR dependency); the caller
    # still gets links/DOIs discovered below.
    if (not bounded_text or len(bounded_text) < 50) and raw_html:
        pdf_text = _extract_pdf_text_fallback(raw_html)
        if pdf_text and len(pdf_text.strip()) >= 50:
            bounded_text = re.sub(r"\s+", " ", pdf_text).strip()[:max_chars]

    return bounded_text, links


def _extract_pdf_text_fallback(raw: str) -> str:
    """Best-effort text from PDF bytes decoded as latin1 string."""
    try:
        if not raw or "%PDF" not in raw[:10]:
            # raw may already be decoded text; still try stream extraction
            pass
        texts: list[str] = []
        # Text in BT...ET blocks: literal (parenthesized) and hex <...> strings
        for block in re.findall(r"BT(.*?)ET", raw, flags=re.DOTALL):
            for lit in re.findall(r"\((?:\\.|[^\\()])*\)", block):
                try:
                    unesc = re.sub(r"\\([\\()nrt])",
                                   lambda m: {"\\": "\\", "(": "(", ")": ")",
                                              "n": "\n", "r": "\r", "t": "\t"}[m.group(1)],
                                   lit[1:-1])
                    if len(unesc.strip()) >= 2:
                        texts.append(unesc)
                except Exception:
                    continue
            for hx in re.findall(r"<([0-9A-Fa-f]{4,})>", block):
                try:
                    dec = bytes.fromhex(hx).decode("latin1")
                    if len(dec.strip()) >= 2 and sum(c.isprintable() for c in dec) > len(dec) / 2:
                        texts.append(dec)
                except Exception:
                    continue
            if len(texts) > 2000:
                break
        joined = re.sub(r"\s+", " ", " ".join(texts)).strip()
        # Drop obvious binary garbage: require mostly printable ASCII/Latin
        if joined and sum(c.isprintable() for c in joined) > len(joined) * 0.7:
            return joined
    except Exception:
        pass
    return ""


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_OG_TITLE_RE = re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', re.IGNORECASE)
_ANCHOR_RE = re.compile(r'<a\b[^>]*href=["\'](https?://[^"\'>\s]+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
_JUNK_LINK_RE = re.compile(
    r"(/login|/signin|/signup|/register|/account|/cart|/privacy|/terms|/cookie|/share\?|sharer|"
    r"/intent/tweet|mailto:|javascript:|/tag/|/tags/|/category/|/author/|/feed/?$|\.(?:jpg|jpeg|png|gif|svg|webp|css|js|ico|zip|mp4|mp3)(?:\?|$))",
    re.IGNORECASE,
)


def extract_title(raw_html: str) -> str:
    """Best page title: og:title, then <title>, cleaned of site suffixes."""
    if not raw_html or not isinstance(raw_html, str):
        return ""
    head = raw_html[:200000]
    m = _OG_TITLE_RE.search(head) or _TITLE_RE.search(head)
    if not m:
        return ""
    title = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1)))).strip()
    return title[:300]


def extract_links_with_text(raw_html: str, max_links: int = 60) -> list[list[str]]:
    """Return [url, anchor text] pairs for content links, skipping chrome/junk."""
    if not raw_html or not isinstance(raw_html, str):
        return []
    out: list[list[str]] = []
    seen: set[str] = set()
    for m in _ANCHOR_RE.finditer(raw_html):
        url = m.group(1).strip()
        if url in seen or _JUNK_LINK_RE.search(url) or not is_safe_url(url):
            continue
        text = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m.group(2)))).strip()
        if len(text) < 3:
            continue
        seen.add(url)
        out.append([url, text[:160]])
        if len(out) >= max_links:
            break
    return out


def extract_pdf_text(data: bytes, max_chars: int = 60000) -> str:
    """Extract text from PDF bytes with the best available library."""
    if not data:
        return ""
    try:
        import pymupdf  # type: ignore
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            parts = []
            for page in doc:
                parts.append(page.get_text())
                if sum(len(p) for p in parts) > max_chars:
                    break
            text = "\n".join(parts)
            if len(text.strip()) > 100:
                return text[:max_chars]
    except Exception:
        pass
    try:
        import io
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(io.BytesIO(data))
        parts = []
        for page in reader.pages[:60]:
            parts.append(page.extract_text() or "")
            if sum(len(p) for p in parts) > max_chars:
                break
        text = "\n".join(parts)
        if len(text.strip()) > 100:
            return text[:max_chars]
    except Exception:
        pass
    try:
        import io
        from pdfminer.high_level import extract_text  # type: ignore
        text = extract_text(io.BytesIO(data), maxpages=40)
        if len(text.strip()) > 100:
            return text[:max_chars]
    except Exception:
        pass
    return _extract_pdf_text_fallback(data.decode("latin1", errors="ignore"))[:max_chars]
