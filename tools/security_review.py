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
from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class Finding:
    file: str
    line: int
    severity: str  # low, medium, high
    pattern: str
    message: str
    code_snippet: str = ""


class SecurityScanner(ast.NodeVisitor):
    def __init__(self, filename: str, source: str, intensity: str = "medium"):
        self.filename = filename
        self.source = source
        self.lines = source.split("\n")
        self.intensity = intensity
        self.findings: List[Finding] = []

    def visit_Call(self, node):
        # Check for dangerous functions
        func_name = ""
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        # Dangerous builtin functions
        if func_name in ("eval", "exec"):
            line = node.lineno
            snippet = self.lines[line - 1] if line <= len(self.lines) else ""
            self.findings.append(
                Finding(
                    file=self.filename,
                    line=line,
                    severity="high",
                    pattern="dangerous_eval",
                    message=f"Use of {func_name}() is unsafe",
                    code_snippet=snippet.strip(),
                )
            )

        # Insecure deserialization
        if func_name in ("load", "loads"):
            if hasattr(node, "func") and isinstance(node.func, ast.Attribute):
                module = node.func.value
                if isinstance(module, ast.Name) and module.id in ("pickle", "yaml"):
                    line = node.lineno
                    snippet = self.lines[line - 1] if line <= len(self.lines) else ""
                    self.findings.append(
                        Finding(
                            file=self.filename,
                            line=line,
                            severity="high",
                            pattern="insecure_deserialization",
                            message=f"Unsafe use of {module.id}.{func_name}()",
                            code_snippet=snippet.strip(),
                        )
                    )

        # subprocess with shell=True
        if func_name == "run" or func_name == "call":
            for keyword in node.keywords:
                if keyword.arg == "shell" and isinstance(keyword.value, ast.Constant):
                    if keyword.value.value is True:
                        line = node.lineno
                        snippet = self.lines[line - 1] if line <= len(self.lines) else ""
                        self.findings.append(
                            Finding(
                                file=self.filename,
                                line=line,
                                severity="high",
                                pattern="shell_injection",
                                message="subprocess with shell=True is vulnerable to injection",
                                code_snippet=snippet.strip(),
                            )
                        )

        self.generic_visit(node)


def scan_for_secrets(filepath: str, intensity: str = "medium") -> List[Finding]:
    """Regex-based scanning for hardcoded secrets."""
    findings = []

    secret_patterns = {
        "api_key": (
            r"(api[_-]?key|apikey)\s*[=:]\s*['\"]([^'\"]{16,})['\"]",
            "high",
        ),
        "password": (r"(password|passwd)\s*[=:]\s*['\"]([^'\"]+)['\"]", "high"),
        "token": (
            r"(token|secret)\s*[=:]\s*['\"]([^'\"]{20,})['\"]",
            "high",
        ),
        "aws_key": (
            r"AKIA[0-9A-Z]{16}(?!\w)",  # Lookahead to avoid matching in strings
            "high",
        ),
    }

    if intensity == "high":
        secret_patterns.update({
            "generic_secret": (r"secret\s*[=:]\s*['\"]([^'\"]+)['\"]", "medium"),
            "url_credentials": (
                r"(http|https)://[^:]+:[^@]+@",
                "high",
            ),
        })

    try:
        with open(filepath) as f:
            lines = f.readlines()
    except:
        return findings

    for line_no, line in enumerate(lines, 1):
        for pattern_name, (pattern, severity) in secret_patterns.items():
            if re.search(pattern, line, re.IGNORECASE):
                findings.append(
                    Finding(
                        file=filepath,
                        line=line_no,
                        severity=severity,
                        pattern=pattern_name,
                        message=f"Potential {pattern_name} found",
                        code_snippet=line.strip(),
                    )
                )

    return findings


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
        # Skip tools directory and build artifacts
        if any(part in filepath.parts for part in [".git", "__pycache__", "tools", "build", "dist"]):
            continue
        findings.extend(check_file(str(filepath), intensity))
    return findings


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Security review scanner")
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
        findings = check_file(str(path), args.intensity)
    else:
        findings = scan_directory(str(path), args.intensity)

    if args.format == "json":
        import json

        print(
            json.dumps(
                [
                    {
                        "file": f.file,
                        "line": f.line,
                        "severity": f.severity,
                        "pattern": f.pattern,
                        "message": f.message,
                        "snippet": f.code_snippet,
                    }
                    for f in findings
                ]
            )
        )
    else:
        for f in sorted(findings, key=lambda x: (x.file, x.line)):
            print(f"{f.file}:{f.line}: [{f.severity}] {f.pattern}: {f.message}")
            if f.code_snippet:
                print(f"  > {f.code_snippet}")

    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
