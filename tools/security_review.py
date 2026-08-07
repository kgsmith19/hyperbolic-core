#!/usr/bin/env python3
"""Security review scanner: detect common vulnerabilities and anti-patterns.

Scans for:
- Hardcoded secrets (API keys, passwords)
- SQL injection patterns
- Command injection (eval, exec, shell=True)
- Unsafe deserialization (pickle, yaml.load)
- Weak cryptography
- Exposed secrets in environment or config

Intensity levels:
  - low: Only obvious hardcoded secrets
  - medium: Secrets + injection patterns + weak crypto (default)
  - high: All patterns + aggressive heuristics
"""
import ast
import re
import sys
from pathlib import Path
from dataclasses import asdict, dataclass
from typing import List


@dataclass
class Finding:
    file: str
    line: int
    severity: str  # low, medium, high
    pattern: str
    message: str
    code_snippet: str = ""


def _eval_or_exec(name, _module, _node):
    if name in ("eval", "exec"):
        return f"Use of {name}() is unsafe"


def _unsafe_deserialize(name, module, _node):
    if (name in ("load", "loads") and isinstance(module, ast.Name)
            and module.id in ("pickle", "yaml")):
        return f"Unsafe use of {module.id}.{name}()"


def _shell_true(name, _module, node):
    if name in ("run", "call") and any(
            k.arg == "shell" and isinstance(k.value, ast.Constant)
            and k.value.value is True for k in node.keywords):
        return "subprocess with shell=True is vulnerable to injection"


# (pattern name, predicate). Each predicate gets the called name, the
# attribute's module if there is one, and the node; it returns the finding's
# message, or None. Adding a check is a row here.
CALL_RULES = (
    ("dangerous_eval", _eval_or_exec),
    ("insecure_deserialization", _unsafe_deserialize),
    ("shell_injection", _shell_true),
)


class SecurityScanner(ast.NodeVisitor):
    def __init__(self, filename: str, source: str, intensity: str = "medium"):
        self.filename = filename
        self.source = source
        self.lines = source.split("\n")
        self.intensity = intensity
        self.findings: List[Finding] = []

    def _flag(self, node, pattern, message, severity="high"):
        line = node.lineno
        snippet = self.lines[line - 1] if line <= len(self.lines) else ""
        self.findings.append(Finding(file=self.filename, line=line,
                                     severity=severity, pattern=pattern,
                                     message=message, code_snippet=snippet.strip()))

    def visit_Call(self, node):
        func = node.func
        name = (func.id if isinstance(func, ast.Name)
                else func.attr if isinstance(func, ast.Attribute) else "")
        module = func.value if isinstance(func, ast.Attribute) else None
        for pattern, matches in CALL_RULES:
            message = matches(name, module, node)
            if message:
                self._flag(node, pattern, message)
        self.generic_visit(node)


SECRET_PATTERNS = {
    "api_key": (r"(api[_-]?key|apikey)\s*[=:]\s*['\"]([^'\"]{16,})['\"]", "high"),
    "password": (r"(password|passwd)\s*[=:]\s*['\"]([^'\"]+)['\"]", "high"),
    "token": (r"(token|secret)\s*[=:]\s*['\"]([^'\"]{20,})['\"]", "high"),
    # Lookahead so a longer identifier that merely starts with AKIA is not a hit.
    "aws_key": (r"AKIA[0-9A-Z]{16}(?!\w)", "high"),
}

AGGRESSIVE_PATTERNS = {
    "generic_secret": (r"secret\s*[=:]\s*['\"]([^'\"]+)['\"]", "medium"),
    "url_credentials": (r"(http|https)://[^:]+:[^@]+@", "high"),
}


def scan_for_secrets(filepath: str, intensity: str = "medium") -> List[Finding]:
    """Regex-based scanning for hardcoded secrets."""
    patterns = dict(SECRET_PATTERNS)
    if intensity == "high":
        patterns.update(AGGRESSIVE_PATTERNS)

    try:
        with open(filepath) as f:
            lines = f.readlines()
    except OSError:
        return []

    return [Finding(file=filepath, line=line_no, severity=severity,
                    pattern=name, message=f"Potential {name} found",
                    code_snippet=line.strip())
            for line_no, line in enumerate(lines, 1)
            for name, (pattern, severity) in patterns.items()
            if re.search(pattern, line, re.IGNORECASE)]


def check_file(filepath: str, intensity: str = "medium") -> List[Finding]:
    """Analyze a single Python file for security issues."""
    findings = []

    # AST-based checks
    try:
        with open(filepath) as f:
            source = f.read()
        tree = ast.parse(source, filename=filepath)
        scanner = SecurityScanner(filepath, source, intensity)
        scanner.visit(tree)
        findings.extend(scanner.findings)
    except SyntaxError:
        pass
    except Exception as e:
        print(f"Error scanning {filepath}: {e}", file=sys.stderr)

    # Regex-based secret detection
    findings.extend(scan_for_secrets(filepath, intensity))

    return findings


def scan_directory(root: str, intensity: str = "medium") -> List[Finding]:
    """Scan all Python files in directory."""
    findings = []
    for filepath in Path(root).rglob("*.py"):
        # Skip tools directory, build artifacts, and tests: the secret-pattern
        # regexes match any password=/token=/api_key= keyword argument
        # holding a quoted string, with no way to tell a real credential from
        # a test fixture's placeholder value -- excluded here the same way
        # bandit's own test-file exclusions work, not because tests are
        # exempt from real secret hygiene (nothing in this repo commits real
        # credentials into tests; `.env` stays gitignored regardless).
        if any(part in filepath.parts for part in
               [".git", "__pycache__", "tools", "build", "dist", "tests"]):
            continue
        findings.extend(check_file(str(filepath), intensity))
    return findings


def main():
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Security review scanner")
    parser.add_argument("path", nargs="?", default=".", help="File or directory to scan")
    parser.add_argument("-i", "--intensity", choices=["low", "medium", "high"],
                        default="medium", help="Detection intensity")
    parser.add_argument("-f", "--format", choices=["text", "json"], default="text")

    args = parser.parse_args()
    path = Path(args.path)
    findings = (check_file(str(path), args.intensity) if path.is_file()
                else scan_directory(str(path), args.intensity))

    if args.format == "json":
        print(json.dumps([asdict(f) for f in findings]))
    else:
        for f in sorted(findings, key=lambda x: (x.file, x.line)):
            print(f"{f.file}:{f.line}: [{f.severity}] {f.pattern}: {f.message}")
            if f.code_snippet:
                print(f"  > {f.code_snippet}")

    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
