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
    metadata: dict | None = None
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

    report_lines = [
        f"# Research Report: {clean_topic}",
        "",
        f"> {meta_line}",
        "",
        "## Executive Summary",
        summary.strip() if summary.strip() else "Summary not available (evidence only).",
        "",
        "## Evidence & Sources",
    ]

    if not evidence:
        report_lines.append("No evidence found.")
    else:
        for idx, item in enumerate(evidence, start=1):
            title = redact(item.get("title", "Untitled"), watchlist)
            url = redact(item.get("url", ""), watchlist)
            snippet = redact(item.get("snippet", ""), watchlist)
            excerpt = redact(item.get("excerpt", "") or item.get("content", ""), watchlist)
            score = item.get("score")

            score_tag = f" (RRF Score: {score}%)" if score else ""
            report_lines.append(f"### {idx}. {title}{score_tag}")
            report_lines.append(f"- **URL**: {url}")
            if item.get("doi"):
                report_lines.append(f"- **DOI**: {item.get('doi')}")
            if snippet:
                report_lines.append(f"- **Snippet**: {snippet}")
            if excerpt:
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
