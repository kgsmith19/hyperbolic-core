"""HTML Content Extractor & Academic Cleaner.

Extracts clean article body text and discovers candidate links/DOIs using
trafilatura with academic repository boilerplate pruning.
"""

import html
import re
import trafilatura
from backend.retrieval_engine.ssrf_validator import is_safe_url


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
    return bounded_text, links
