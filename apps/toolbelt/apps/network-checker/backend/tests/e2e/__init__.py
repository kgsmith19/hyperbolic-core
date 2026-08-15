"""Browser-driven (Playwright) end-to-end fixtures and specs -- D-04.

Nothing under this package runs via `python -m unittest discover`: there is
no `test_*.py` here on purpose. seed_dashboard_fixture.py is invoked
directly (by CI and by the Playwright spec itself); dashboard-smoke.test.mjs
is invoked by `npx playwright test`. This `__init__.py` only marks the
directory as a package, matching the rest of tests/.
"""
