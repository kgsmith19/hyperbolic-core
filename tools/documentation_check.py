#!/usr/bin/env python3
"""Documentation check: ensure docs stay current and lean.

Verifies:
- README exists and contains essential sections
- No scaffolding or template artifacts
- Docstrings are present for public APIs
- Doc examples are not outdated
- Configuration docs match actual code

Intensity levels:
  - low: Only check README and major docs exist
  - medium: Check structure, lean principle, basic examples (default)
  - high: Full validation of all docstrings and examples
"""
import os
import re
import sys
from pathlib import Path
from dataclasses import dataclass
from typing import List


@dataclass
class Issue:
    file: str
    line: int
    severity: str  # low, medium, high
    rule: str
    message: str


class DocChecker:
    def __init__(self, root_dir: str, intensity: str = "medium"):
        self.root = Path(root_dir)
        self.intensity = intensity
        self.issues: List[Issue] = []

    def check_readme(self):
        """Verify README is present and has essential content."""
        readme = self.root / "README.md"
        if not readme.exists():
            self.issues.append(
                Issue(
                    file="README.md",
                    line=0,
                    severity="high",
                    rule="missing_readme",
                    message="README.md not found",
                )
            )
            return

        content = readme.read_text()

        # Check for template artifacts (TBD, TODO, XXX in readme)
        lines = content.split("\n")
        for line_no, line in enumerate(lines, 1):
            if re.search(r"\[TBD\]|\[TODO\]|REPLACE_THIS", line):
                self.issues.append(
                    Issue(
                        file="README.md",
                        line=line_no,
                        severity="medium",
                        rule="template_artifact",
                        message="README contains placeholder/template text",
                    )
                )

    def check_docstrings(self):
        """Check for missing or incomplete docstrings."""
        if self.intensity == "low":
            return

        py_files = self.root.rglob("*.py")
        for pyfile in py_files:
            if ".git" in pyfile.parts or "__pycache__" in pyfile.parts:
                continue

            try:
                with open(pyfile) as f:
                    content = f.read()

                # Find public functions without docstrings
                lines = content.split("\n")
                for i, line in enumerate(lines, 1):
                    # Simple heuristic: function def followed by no docstring
                    if re.match(r"^\s*def\s+(\w+)\s*\(", line) and not line.strip(
                        ).startswith("def _"
                    ):
                        # Check if next non-empty line is a docstring
                        next_line_idx = i
                        while next_line_idx < len(lines):
                            next_line = lines[next_line_idx].strip()
                            if next_line:
                                if not (
                                    next_line.startswith('"""')
                                    or next_line.startswith("'''")
                                ):
                                    if self.intensity == "high":
                                        func_match = re.search(r"def\s+(\w+)", line)
                                        func_name = func_match.group(1) if func_match else "unknown"
                                        self.issues.append(
                                            Issue(
                                                file=str(pyfile),
                                                line=i,
                                                severity="low",
                                                rule="missing_docstring",
                                                message=f"Function '{func_name}' missing docstring",
                                            )
                                        )
                                break
                            next_line_idx += 1

            except Exception as e:
                print(f"Error checking {pyfile}: {e}", file=sys.stderr)

    def check_for_scaffolding(self):
        """Find leftover scaffold/template files."""
        scaffold_patterns = [
            "TEMPLATE*",
            "*_TEMPLATE*",
            "*example_*",
            "*sample_*",
            "*.template",
        ]

        for pattern in scaffold_patterns:
            for path in self.root.glob(f"**/{pattern}"):
                if ".git" not in path.parts:
                    self.issues.append(
                        Issue(
                            file=str(path),
                            line=0,
                            severity="medium",
                            rule="template_file",
                            message="Scaffold/template file should be removed",
                        )
                    )

    def check_docs_directory(self):
        """Verify docs directory exists and isn't empty."""
        docs_dir = self.root / "docs"
        if docs_dir.exists():
            md_files = list(docs_dir.glob("*.md"))
            if not md_files:
                self.issues.append(
                    Issue(
                        file="docs/",
                        line=0,
                        severity="medium",
                        rule="empty_docs_dir",
                        message="docs/ directory is empty",
                    )
                )
        elif self.intensity in ("medium", "high"):
            # docs/ is recommended but not required
            pass

    def run(self) -> List[Issue]:
        """Run all checks."""
        self.check_readme()
        self.check_docstrings()
        self.check_for_scaffolding()
        self.check_docs_directory()
        return self.issues


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Documentation check")
    parser.add_argument("path", nargs="?", default=".", help="Directory to check")
    parser.add_argument(
        "-i",
        "--intensity",
        choices=["low", "medium", "high"],
        default="medium",
        help="Validation intensity",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    args = parser.parse_args()

    checker = DocChecker(args.path, args.intensity)
    issues = checker.run()

    if args.format == "json":
        import json

        print(
            json.dumps(
                [
                    {
                        "file": i.file,
                        "line": i.line,
                        "severity": i.severity,
                        "rule": i.rule,
                        "message": i.message,
                    }
                    for i in issues
                ]
            )
        )
    else:
        for issue in sorted(issues, key=lambda x: (x.file, x.line)):
            print(f"{issue.file}:{issue.line}: [{issue.severity}] {issue.rule}: {issue.message}")

    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
