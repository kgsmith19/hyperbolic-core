"""Markdown Research Report Generator & Archive Manager.

Compiles executive summaries, ranked evidence, snippets, excerpts,
and RRF relevance scores into structured markdown reports.
Archives reports into timestamped files in `reports/` while updating `report.md`.
"""

from datetime import datetime
import os
import re
from backend.privacy.watchlist_redactor import redact, assert_safe_to_send


def slugify(text: str, max_words: int = 6) -> str:
    """Convert string to a filesystem-safe slug."""
    clean = re.sub(r"[^\w\s-]", "", text.lower())
    words = clean.split()[:max_words]
    slug = "-".join(words)
    return slug or "untitled-research"


def write_report(
    topic: str,
    evidence: list[dict],
    summary: str,
    watchlist: list[str],
    output_path: str = "report.md",
    metadata: dict | None = None,
    independence: dict | None = None,
    appendix: list[tuple[str, str]] | None = None,
) -> str:
    """Write the research findings to report.md and an archived timestamped report in reports/."""
    clean_topic = redact(topic, watchlist)
    assert_safe_to_send(clean_topic, watchlist)

    meta = metadata or {}
    timestamp_str = meta.get("timestamp") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    mode_str = meta.get("mode", "deterministic")
    docs_count = len(evidence)
    cost_str = meta.get("cost_str", "$0.00")
    duration_str = meta.get("duration_str", "")

    meta_parts = [
        f"**Date**: {timestamp_str}",
        f"**Mode**: `{mode_str}`",
        f"**Sources Analyzed**: {docs_count}",
    ]
    if cost_str and cost_str != "$0.00":
        meta_parts.append(f"**Estimated Cost**: {cost_str}")
    if duration_str:
        meta_parts.append(f"**Duration**: {duration_str}")

    meta_line = " | ".join(meta_parts)

    summary_text = summary.strip() if summary and summary.strip() else "Summary not available (evidence only)."
    report_lines = [
        f"# Research Report: {clean_topic}",
        "",
        f"> {meta_line}",
        "",
    ]
    if "## Executive Summary" in summary_text:
        report_lines += [summary_text, ""]
    else:
        report_lines += ["## Executive Summary", summary_text, ""]

    if independence and (independence.get("families", 0) or independence.get("multi")):
        report_lines.append("## Independence")
        fam_n = independence.get("families", 0)
        largest = independence.get("largest_family", 0)
        report_lines.append(
            f"Grouped into {fam_n} independent source-families"
            + (f"; largest family has {largest} near-duplicate copies." if largest and largest > 1 else ".")
        )
        for fam in independence.get("multi", []):
            fam_title = redact(fam.get("title") or "Untitled", watchlist)
            report_lines.append(f"- {fam_title} ({fam.get('size', 0)} copies)")
        report_lines.append("")

    for heading, body in appendix or []:
        if body and body.strip():
            report_lines += [f"## {heading}", body.strip(), ""]

    report_lines += [
        "## Evidence & Sources",
    ]

    if not evidence:
        report_lines.append("No evidence found.")
    else:
        for idx, item in enumerate(evidence, start=1):
            if not isinstance(item, dict):
                continue
            title = redact(item.get("title") or "Untitled", watchlist)
            url = redact(item.get("url") or "", watchlist)
            snippet = redact(item.get("snippet") or "", watchlist)
            excerpt = redact(item.get("excerpt") or item.get("content") or "", watchlist)
            score = item.get("score")

            score_tag = f" (RRF Score: {score}%)" if score else ""
            report_lines.append(f"### {idx}. {title}{score_tag}")
            report_lines.append(f"- **URL**: {url}")
            lane = item.get("lane") or ""
            if lane:
                meta = item.get("meta") or {}
                bits = [lane]
                for key in ("venue", "year", "community", "author"):
                    if meta.get(key):
                        bits.append(redact(str(meta[key]), watchlist))
                if meta.get("citations"):
                    bits.append(f"cited {meta['citations']}x")
                if item.get("quality"):
                    bits.append(f"quality {float(item['quality']):.2f}")
                report_lines.append(f"- **Source**: {' · '.join(bits)}")
            if item.get("doi"):
                report_lines.append(f"- **DOI**: {item.get('doi')}")
            if snippet:
                report_lines.append(f"- **Snippet**: {snippet}")
            if excerpt:
                if len(excerpt) > 900:
                    excerpt = excerpt[:900].rsplit(" ", 1)[0] + " …"
                report_lines.append(f"- **Excerpt**: {excerpt}")
            report_lines.append("")

    report_content = "\n".join(report_lines).strip() + "\n"
    final_report = redact(report_content, watchlist)
    assert_safe_to_send(final_report, watchlist)

    # 1. Write to standard output_path (default report.md) for backward compatibility
    with open(output_path, "w", encoding="utf-8") as file:
        file.write(final_report)

    # 2. Also archive to reports/ directory with timestamp and topic slug
    reports_dir = os.path.join(os.path.dirname(os.path.abspath(output_path)), "reports")
    os.makedirs(reports_dir, exist_ok=True)

    date_tag = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    slug = slugify(clean_topic)
    archive_filename = f"{date_tag}_{slug}.md"
    archive_path = os.path.join(reports_dir, archive_filename)

    with open(archive_path, "w", encoding="utf-8") as file:
        file.write(final_report)

    return archive_path
