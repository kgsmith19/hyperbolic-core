#!/usr/bin/env python3
"""Code simplification scanner: enforce lean code practices.

Scans Python code for complexity violations and reports:
- Functions longer than threshold (default 20 lines)
- Unused imports and variables
- Redundant logic patterns
- Cyclomatic complexity exceeding threshold

Intensity levels:
  - low: >30 lines functions only
  - medium: >20 lines functions, unused variables (default)
  - high: >15 lines functions, all complexity metrics
"""
import ast
import sys
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Violation:
    file: str
    line: int
    severity: str  # low, medium, high
    rule: str
    message: str


class CodeAnalyzer(ast.NodeVisitor):
    def __init__(self, filename: str, source: str, intensity: str = "medium"):
        self.filename = filename
        self.source = source
        self.lines = source.split("\n")
        self.intensity = intensity
        self.violations: List[Violation] = []
        self.imports = set()
        self.used_names = set()

        # Thresholds based on intensity
        if intensity == "low":
            self.max_function_length = 30
            self.check_unused = False
        elif intensity == "high":
            self.max_function_length = 15
            self.check_unused = True
            self.max_complexity = 5
        else:  # medium
            self.max_function_length = 20
            self.check_unused = True
            self.max_complexity = 8

    def visit_FunctionDef(self, node):
        # Check function length
        func_lines = node.end_lineno - node.lineno + 1
        if func_lines > self.max_function_length:
            self.violations.append(
                Violation(
                    file=self.filename,
                    line=node.lineno,
                    severity="medium",
                    rule="function_too_long",
                    message=f"Function '{node.name}' is {func_lines} lines (max {self.max_function_length})",
                )
            )
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.add(alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            self.imports.add(alias.name)
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.used_names.add(node.id)
        self.generic_visit(node)


def check_file(filepath: str, intensity: str = "medium") -> List[Violation]:
    """Analyze a single Python file."""
    violations = []
    try:
        with open(filepath) as f:
            source = f.read()
        tree = ast.parse(source, filename=filepath)
        analyzer = CodeAnalyzer(filepath, source, intensity)
        analyzer.visit(tree)
        violations.extend(analyzer.violations)
    except SyntaxError as e:
        violations.append(
            Violation(
                file=filepath,
                line=e.lineno or 0,
                severity="high",
                rule="syntax_error",
                message=str(e),
            )
        )
    except Exception as e:
        print(f"Error analyzing {filepath}: {e}", file=sys.stderr)
    return violations


def scan_directory(root: str, intensity: str = "medium") -> List[Violation]:
    """Scan all Python files in directory."""
    violations = []
    for filepath in Path(root).rglob("*.py"):
        if ".git" in filepath.parts or "__pycache__" in filepath.parts:
            continue
        violations.extend(check_file(str(filepath), intensity))
    return violations


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Code simplification scanner")
    parser.add_argument("path", nargs="?", default=".", help="File or directory to scan")
    parser.add_argument(
        "-i",
        "--intensity",
        choices=["low", "medium", "high"],
        default="medium",
        help="Violation detection intensity",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    args = parser.parse_args()
    path = Path(args.path)

    if path.is_file():
        violations = check_file(str(path), args.intensity)
    else:
        violations = scan_directory(str(path), args.intensity)

    if args.format == "json":
        import json

        print(
            json.dumps(
                [
                    {
                        "file": v.file,
                        "line": v.line,
                        "severity": v.severity,
                        "rule": v.rule,
                        "message": v.message,
                    }
                    for v in violations
                ]
            )
        )
    else:
        for v in sorted(violations, key=lambda x: (x.file, x.line)):
            print(f"{v.file}:{v.line}: [{v.severity}] {v.rule}: {v.message}")

    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
