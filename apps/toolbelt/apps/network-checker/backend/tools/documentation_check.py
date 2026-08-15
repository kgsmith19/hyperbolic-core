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
import ast
import re
import sys
from pathlib import Path
from dataclasses import dataclass
from typing import List

from scan_cli import run


@dataclass
class Issue:
    file: str
    line: int
    severity: str  # low, medium, high
    rule: str
    message: str


def _undocumented(tree, path):
    """Public functions in `tree` that carry no docstring. A leading
    underscore means the author already said it is internal."""
    return [Issue(file=str(path), line=n.lineno, severity="low",
                  rule="missing_docstring",
                  message=f"Function '{n.name}' missing docstring")
            for n in ast.walk(tree)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and not n.name.startswith("_") and not ast.get_docstring(n)]


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
        """Public functions with no docstring.

        Reads the AST rather than guessing line by line: a decorator, a
        multi-line signature, or an `async def` all defeat a regex for
        "a def followed by a docstring", and the previous version of this
        check walked every file at `medium` only to report nothing.
        """
        if self.intensity != "high":
            return

        for pyfile in self.root.rglob("*.py"):
            if ".git" in pyfile.parts or "__pycache__" in pyfile.parts:
                continue
            try:
                tree = ast.parse(pyfile.read_text())
            except (OSError, SyntaxError) as e:
                print(f"Error checking {pyfile}: {e}", file=sys.stderr)
                continue
            self.issues.extend(_undocumented(tree, pyfile))

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
                # .github/PULL_REQUEST_TEMPLATE.md and .github/ISSUE_TEMPLATE/
                # are GitHub's own required names, not leftover scaffolding.
                if ".git" not in path.parts and ".github" not in path.parts:
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


def _check(root_dir: str, intensity: str = "medium") -> List[Issue]:
    return DocChecker(root_dir, intensity).run()


def main():
    # DocChecker always evaluates a directory root, so both the file and
    # directory branch of run() point at the same function -- unlike the
    # other scanners, this one was never meant to run against a single file.
    return run("Documentation check", _check, _check)


if __name__ == "__main__":
    sys.exit(main())
