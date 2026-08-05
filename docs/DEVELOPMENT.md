# Development Guide

## Setting Up Development Environment

### Prerequisites
- Python 3.9+
- pip package manager
- Git

### Installation

1. Clone the repository:
```bash
git clone https://github.com/kgsmith19/network-checker
cd network-checker
```

2. Install dependencies:
```bash
pip install -e .
```

3. Install development dependencies:
```bash
pip install pytest pytest-cov
```

## Running Tests

### All Tests
```bash
pytest tests/ -v
```

### With Coverage
```bash
pytest tests/ --cov=netcheck --cov-report=html
```

### Specific Test
```bash
pytest tests/test_diagnostic_engine.py::TestCase::test_name -v
```

## Code Quality Checks

Before committing, run the same checks used in CI:

### Code Simplification
```bash
python tools/code_simplification.py netcheck -i low
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

## Git Workflow

1. Create a feature branch:
```bash
git checkout -b feature/your-feature
```

2. Make changes and test:
```bash
pytest tests/ -v
```

3. Commit with descriptive message:
```bash
git commit -m "Add feature: description"
```

4. Push to remote:
```bash
git push origin feature/your-feature
```

5. Create a pull request on GitHub

## Key Files to Understand

### `netcheck/diagnostic_engine.py`
- Core diagnostic logic
- DiagnosticTree implementation
- Hypothesis ranking algorithm
- Burst pattern detection

### `netcheck/probes.py`
- Network connectivity tests
- Probe sampling and idle hold
- Test result collection

### `tools/code_simplification.py`
- Code complexity analysis
- AST-based violation detection
- Intensity levels for different strictness

### `tools/security_review.py`
- Security vulnerability scanning
- Hardcoded secret detection
- Unsafe function calls detection

### `tools/documentation_check.py`
- Documentation completeness checks
- Template scaffolding detection
- Docstring validation

### `tests/`
- Test suite with 200+ tests
- Fixtures for network state simulation
- Coverage tracking for quality gates

## Debugging

### Enable Verbose Logging
```bash
netcheck diagnose --verbose
```

### Run Fixer in Dry-Run Mode
```bash
python tools/fixer.py --issue wifi_mode --dry-run -v
```

### Inspect Test Results
```bash
pytest tests/test_diagnostic_engine.py -v -s
```

## CI/CD Pipeline

Automated checks run on all pushes and pull requests:

1. **Tests** (`tests.yml`): Pytest across Python 3.9, 3.10, 3.11
2. **Code Quality** (`code-quality.yml`): Simplification, security, documentation
3. **Fixer Validation** (`fixer-validation.yml`): Network fixer system checks
4. **Status Checks** (`status-checks.yml`): Aggregated results

All checks must pass before merging to main.

## Making Changes

### Adding a New Diagnostic Rule
1. Add test case in `tests/test_diagnostic_engine.py`
2. Implement rule logic in `netcheck/diagnostic_engine.py`
3. Update documentation
4. Run full test suite to verify

### Adding a New Network Probe
1. Add test in `tests/test_diagnostic_engine.py`
2. Implement probe in `netcheck/probes.py`
3. Update fixer system if needed
4. Document in docstring

### Updating Tools
1. Modify tool in `tools/`
2. Run local tests: `python tools/tool_name.py --help`
3. Update `.github/workflows/` if intensity levels change
4. Run full test suite

## Performance Considerations

- Diagnostic engine uses immutable results for thread safety
- Burst analysis limits history to 1000 most recent results
- Configuration matrix tracks only tested combinations
- All I/O is non-blocking and timeout-protected

## Security

- No hardcoded secrets or API keys
- Safe condition evaluation (no `eval()`)
- Input validation on all external sources
- Regular security scanning via CI/CD

## Documentation Standards

- All functions have docstrings
- Complex algorithms have inline comments
- README covers basic usage
- docs/ directory contains architectural guides
- Examples provided for common tasks
