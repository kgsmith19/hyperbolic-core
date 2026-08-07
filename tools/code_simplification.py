#!/usr/bin/env python3
"""Code simplification scanner: enforce lean code practices.

Scans Python code for complexity violations and reports:
- Files longer than threshold
- Functions longer than threshold
- Functions with more than 4 parameters
- Cyclomatic complexity exceeding threshold
- Nesting depth exceeding threshold

Intensity levels, and the ceiling each enforces:
  - low:    600-line files, 100-line functions, 8 params, complexity 15, nesting 5
  - medium: 250-line files,  40-line functions, 4 params, complexity  8, nesting 3
  - high:   150-line files,  15-line functions, 3 params, complexity  6, nesting 2

`medium` is exactly rules/01-BUDGETS.md's MAX_FILE_LOC / MAX_FUNCTION_LOC /
MAX_CYCLOMATIC ceilings, and is what tools/check.sh runs.
"""
import ast
import sys
from pathlib import Path
from dataclasses import dataclass
from typing import List

DECISION_NODES = (ast.If, ast.For, ast.While, ast.ExceptHandler, ast.With,
                   ast.Assert, ast.comprehension)
NESTING_NODES = (ast.If, ast.For, ast.While, ast.With, ast.Try)


@dataclass
class Violation:
    file: str
    line: int
    severity: str  # low, medium, high
    rule: str
    message: str


def _complexity(node):
    """Cyclomatic complexity: 1 + one per decision point and boolop operand."""
    count = 1
    for child in ast.walk(node):
        if isinstance(child, DECISION_NODES):
            count += 1
        elif isinstance(child, ast.BoolOp):
            count += len(child.values) - 1
    return count


def _max_nesting(node, depth=0):
    """Deepest chain of nested if/for/while/with/try inside a function body."""
    best = depth
    for child in ast.iter_child_nodes(node):
        child_depth = depth + 1 if isinstance(child, NESTING_NODES) else depth
        best = max(best, _max_nesting(child, child_depth))
    return best


def _param_count(node):
    """Real, callable-facing params -- excludes the implicit self/cls every
    method carries, which the 4-param ceiling was never meant to count."""
    a = node.args
    positional = [p.arg for p in a.posonlyargs + a.args]
    if positional and positional[0] in ("self", "cls"):
        positional = positional[1:]
    return len(positional) + len(a.kwonlyargs) \
        + (1 if a.vararg else 0) + (1 if a.kwarg else 0)


class CodeAnalyzer(ast.NodeVisitor):
    def __init__(self, filename: str, source: str, intensity: str = "medium"):
        self.filename = filename
        self.violations: List[Violation] = []

        if intensity == "low":
            self.max_length, self.max_params, self.max_complexity, self.max_nesting = 100, 8, 15, 5
        elif intensity == "high":
            self.max_length, self.max_params, self.max_complexity, self.max_nesting = 15, 3, 6, 2
        else:  # medium
            self.max_length, self.max_params, self.max_complexity, self.max_nesting = 40, 4, 8, 3

    def visit_FunctionDef(self, node):
        self._check(node)
        self.generic_visit(node)

    def _check(self, node):
        func_lines = node.end_lineno - node.lineno + 1
        if func_lines > self.max_length:
            self._violation(node, "function_too_long",
                            f"Function '{node.name}' is {func_lines} lines (max {self.max_length})")

        params = _param_count(node)
        if params > self.max_params:
            self._violation(node, "too_many_params",
                            f"Function '{node.name}' has {params} params (max {self.max_params})")

        complexity = _complexity(node)
        if complexity > self.max_complexity:
            self._violation(node, "too_complex",
                            f"Function '{node.name}' has cyclomatic complexity {complexity} (max {self.max_complexity})")

        nesting = _max_nesting(node)
        if nesting > self.max_nesting:
            self._violation(node, "nested_too_deep",
                            f"Function '{node.name}' nests {nesting} levels deep (max {self.max_nesting})")

    def _violation(self, node, rule, message):
        self.violations.append(Violation(self.filename, node.lineno, "medium", rule, message))


MAX_FILE_LOC = {"low": 600, "medium": 250, "high": 150}


def check_file(filepath: str, intensity: str = "medium") -> List[Violation]:
    """Analyze a single Python file."""
    violations = []
    try:
        with open(filepath) as f:
            source = f.read()
        lines = source.count("\n") + 1
        ceiling = MAX_FILE_LOC[intensity]
        if lines > ceiling:
            violations.append(Violation(
                filepath, 1, "medium", "file_too_long",
                f"File is {lines} lines (max {ceiling})"))
        tree = ast.parse(source, filename=filepath)
        analyzer = CodeAnalyzer(filepath, source, intensity)
        analyzer.visit(tree)
        violations.extend(analyzer.violations)
    except SyntaxError as e:
        violations.append(Violation(filepath, e.lineno or 0, "high", "syntax_error", str(e)))
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
    parser.add_argument("-i", "--intensity", choices=["low", "medium", "high"], default="medium")
    parser.add_argument("-f", "--format", choices=["text", "json"], default="text")

    args = parser.parse_args()
    path = Path(args.path)

    violations = check_file(str(path), args.intensity) if path.is_file() \
        else scan_directory(str(path), args.intensity)

    if args.format == "json":
        import json
        print(json.dumps([vars(v) for v in violations]))
    else:
        for v in sorted(violations, key=lambda x: (x.file, x.line)):
            print(f"{v.file}:{v.line}: [{v.severity}] {v.rule}: {v.message}")

    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
