# Development Guide

## Setting Up Development Environment

### Prerequisites
- Python 3.9+ (CI matrix runs 3.9, 3.10, 3.11)
- Git

No `pip install` step, and no `setup.py`/`pyproject.toml` — this project is
Python standard library only, a hard constraint (see `AGENTS.md`). Cloning
the repo is the entire install:

```bash
git clone https://github.com/kgsmith19/network-checker
cd network-checker
python -m netcheck full-check --format quick
```

## Running Tests

The primary, always-available test runner is `unittest`:

```bash
python -m unittest discover -s tests -t .
```

380 tests, hermetic — no live network calls, no sleeps beyond a probe's own
timing. This is the command in `AGENTS.md` and the one to run before every
commit.

### With pytest (optional, what CI uses for coverage)

CI installs `pytest`/`pytest-cov` as a throwaway CI dependency purely to get
coverage reporting — it is not a project dependency, nothing in `netcheck/`
imports it, and it is not required for local development:

```bash
pip install pytest pytest-cov   # only if you want coverage locally
pytest tests/ -v --cov=netcheck --cov-report=html
```

### Specific test

```bash
python -m unittest tests.test_diagnose -v
python -m unittest tests.test_diagnose.CulpritTest.test_gateway_down_is_lan -v
```

## Code Quality Checks

Before committing, run the same checks used in CI:

### Code Simplification
```bash
python tools/code_simplification.py netcheck -i medium
```

### Security Review
```bash
python tools/security_review.py . -i high
```

### Documentation Check
```bash
python tools/documentation_check.py . -i medium
```

### Fixer Validation
```bash
python tools/fixer.py --issue all --dry-run -v
```

See `tools/README.md` for what each intensity level catches.

## Git Workflow

1. Create a feature branch:
```bash
git checkout -b feature/your-feature
```

2. Make changes and test:
```bash
python -m unittest discover -s tests -t .
```

3. Commit with a descriptive message:
```bash
git commit -m "Add feature: description"
```

4. Push to remote:
```bash
git push origin feature/your-feature
```

5. Open a pull request. See `CONTRIBUTING.md` for the PR checklist.

## Key Files to Understand

See `ARCHITECTURE.md` for the full module map and `API.md` for the
function-level reference. The files worth reading first:

### `netcheck/diagnose.py`
The lightweight, always-on ranker (`culprit`, `bursts`, `correlate`, `rank`)
behind `netcheck diagnose` and `netcheck watch`. Small and dependency-light
by design — the heavier historical/per-layer analysis lives in
`diagnostic_engine.py`, which `diagnose.py` re-exports.

### `netcheck/diagnostic_engine.py`
The full decision-tree engine: `DiagnosticTree`, hypothesis ranking,
`ConfigurationMatrix` (historical confidence), and per-layer analysis
helpers for dual-stack, routing, TLS, and buffering.

### `netcheck/probes.py`
Per-tick network measurement: pure parsers over command output (`parse_ping`,
`parse_wlan_interfaces`, ...) plus the I/O that gathers it (`ping`, `resolve`,
`tls_connect`, `idle_hold`, `sample`).

### `netcheck/all_diagnostics.py`
The unified `netcheck full-check` runner across the seven hypothesis-specific
modules (Wi-Fi, modem, NAT, CGNAT, router, interference, Anthropic status).

### `tools/code_simplification.py`, `tools/security_review.py`, `tools/documentation_check.py`
AST-based static checks — see `tools/README.md` for rules and intensity
levels.

### `tests/`
380 tests. Fixtures for real captured command output live in
`tests/fixtures/`. `tests/test_llmlog.py` holds the adversarial cases
worth reading first — the ones that catch substring-matching mistakes that
previously overcounted real errors ~200x.

## Debugging

### Run one command's output directly
```bash
python -m netcheck scan       # full environment snapshot
python -m netcheck full-check --format json | less
```

### Run the fixer in dry-run mode
```bash
python tools/fixer.py --issue wifi_mode --dry-run -v
```

### Inspect test output verbosely
```bash
python -m unittest tests.test_diagnostic_engine -v
```

## CI/CD Pipeline

Automated checks run on all pushes and pull requests
(`.github/workflows/`):

1. **Tests** (`tests.yml`): `pytest` across Python 3.9, 3.10, 3.11, with
   coverage uploaded to Codecov.
2. **Code Quality** (`code-quality.yml`): simplification, security,
   documentation checks.
3. **Fixer Validation** (`fixer-validation.yml`): network fixer system
   checks.
4. **Status Checks** (`status-checks.yml`): aggregated results.

All checks must pass before merging to main.

## Making Changes

### Adding a New Diagnostic Rule
1. Add a test case in `tests/test_diagnose.py` or `tests/test_diagnostic_engine.py`.
2. Implement the rule in `diagnose.py` (row-level pattern) or
   `diagnostic_engine.py` (historical/per-layer analysis).
3. Update `docs/TROUBLESHOOTING.md` if it changes the symptom-to-hypothesis
   mapping.
4. Run the full test suite to verify.

### Adding a New Diagnostic Module
See `CONTRIBUTING.md` — it walks through the full shape (pure functions,
`*Diagnostics` class, three-state model, wiring into `all_diagnostics.py`).

### Adding a New Network Probe
1. Capture a real fixture in `tests/fixtures/` and write the parser test in
   `tests/test_probes.py`.
2. Implement the parser in `probes.py` as a pure function over text.
3. Wire the live I/O wrapper alongside it.
4. Run the full test suite to verify.

### Updating Tools
1. Modify the tool in `tools/`.
2. Run it locally: `python tools/tool_name.py --help`.
3. Update `.github/workflows/` if intensity levels change.
4. Run the full test suite.

## Performance Considerations

- `diagnostic_engine.ConfigurationMatrix` bounds burst history so repeated
  analysis stays cheap as the dataset grows.
- `store.py` writes are append-only with a unique `(host, ts)` index, so
  replay/retry is idempotent rather than requiring dedup logic elsewhere.
- All network I/O in `probes.py`/`environ.py` is timeout-protected; nothing
  blocks indefinitely on an unreachable device.
- `llmlog.scan`/`scan_all` resume from stored file offsets, so repeated
  ingestion only reads what's new.

## Security

- No hardcoded secrets or API keys; credentials live in a gitignored `.env`
  (see `README.md` for why no `.env.example` ships).
- No `eval()` — `diagnostic_engine._safe_eval_condition` is a
  recursive-descent parser instead.
- See `OPEN-ISSUES.md` for the current accepted-risk and latent-fix items
  found by `/security-review-kgs` (PowerShell string interpolation, raw
  router output storage, plaintext HTTP to LAN devices).
- Regular scanning via `tools/security_review.py` in CI.

## Documentation Standards

- Public functions get a one-line docstring stating what they return.
- Non-obvious algorithms (brace-matching in `environ.parse_docsis_status`,
  the recursive-descent condition parser in `diagnostic_engine.py`) get a
  short comment explaining the *why*, not the *what*.
- `README.md` covers what the tool measures and how to read its output.
- `docs/` holds architectural guides — `ARCHITECTURE.md` (module map,
  decision trees), `API.md` (function reference), `QUICKSTART.md`,
  `TROUBLESHOOTING.md`, and `CONTRIBUTING.md`.
