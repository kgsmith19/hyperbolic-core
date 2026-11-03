"""Every app carries its own metadata, with paths that match the layout (#450, AC1, AC3, AC6).

For each directory under apps/: project.yaml, AGENTS.md, CLAUDE.md and README.md
exist; project.yaml's ci.workflow, when set, resolves to a real root workflow;
no app holds another app's project.yaml or AGENTS.md below its root (except
declared sub-components); and no .github/ directory exists below the
repository root.

apps/toolbelt, the dissolved category, must not exist (AC2).

Usage: python3 ops/check_app_metadata.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ("project.yaml", "AGENTS.md", "CLAUDE.md", "README.md")
# Sub-directories that carry scoped AGENTS.md as components of their app, not
# as nested apps (classified in docs/planning/monorepo-audit.md).
COMPONENTS = {"apps/lifeos/backend", "apps/lifeos/frontend",
              "apps/agentic-command-center/frontend", "apps/shell/frontend"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".venv", "__pycache__"}


def _walk(path):
    for child in sorted(path.iterdir()):
        if child.is_dir() and child.name not in SKIP_DIRS:
            yield child
            yield from _walk(child)


DISSOLVED = ("apps/toolbelt",)  # AC2: removed by #520/#523; must never return


def problems(root=ROOT):
    root = Path(root)
    found = [f"{path}: dissolved category directory exists again" for path in DISSOLVED
             if (root / path).exists()]
    for app in sorted(p for p in (root / "apps").iterdir() if p.is_dir()):
        rel = app.relative_to(root).as_posix()
        for name in REQUIRED:
            if not (app / name).is_file():
                found.append(f"{rel}: missing {name}")
        project = app / "project.yaml"
        if project.is_file():
            match = re.search(r"^\s+workflow:\s*(\S+)", project.read_text(), re.M)
            target = match.group(1).strip("\"'") if match else ""
            # Either app-relative (../../.github/...) or repo-root relative.
            if match and not ((app / target).resolve().is_file() or (root / target).is_file()):
                found.append(f"{rel}/project.yaml: ci workflow {match.group(1)} does not exist")
        for sub in _walk(app):
            sub_rel = sub.relative_to(root).as_posix()
            if sub.name == ".github":
                found.append(f"{sub_rel}: nested .github/ (GitHub only reads the root)")
            elif sub_rel not in COMPONENTS and any((sub / n).is_file() for n in ("project.yaml", "AGENTS.md")):
                found.append(f"{sub_rel}: nested app metadata inside {rel}")
    for path in root.rglob(".github"):
        rel = path.relative_to(root).as_posix()
        if rel != ".github" and not rel.startswith("apps/") and not set(Path(rel).parts) & SKIP_DIRS:
            found.append(f"{rel}: nested .github/ below the repository root")
    return found


def main(root=ROOT):
    found = problems(root)
    for problem in found:
        print(problem)
    if found:
        return 1
    print("every app has its own metadata and no nested .github/ exists")
    return 0


if __name__ == "__main__":
    sys.exit(main())
