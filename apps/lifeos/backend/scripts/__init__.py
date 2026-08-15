"""Operator scripts: one-off migrations, seeds, and local setup helpers.

A real package rather than a loose directory, so `python -m scripts.<name>`
and the tests' `from scripts.<name> import migrate` resolve to the same
module. Without it these files are an implicit namespace package and are
importable under two different names, which mypy rejects outright.

Nothing here is part of the installed application: `pyproject.toml` packages
only `src`, so operator tooling cannot be imported by the service it operates
on. That is deliberate -- see scripts/type_redefinition.py.
"""
