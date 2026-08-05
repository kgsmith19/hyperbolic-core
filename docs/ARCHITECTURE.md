# Network Checker Architecture

## Overview

Network Checker is a diagnostic system for network troubleshooting that uses property-driven and specification-driven development principles.

## Core Components

### Diagnostic Engine (`netcheck/diagnostic_engine.py`)

The diagnostic engine implements an ordered decision tree (DiagnosticTree) that:
- Records test results across network layers
- Analyzes patterns in error bursts
- Ranks hypotheses based on historical confidence
- Generates recommendations for fixes

**Key Classes:**
- `DiagnosisResult`: Immutable result wrapper for test outcomes
- `DiagnosticRule`: Condition-based rules for diagnostic flow
- `ConfigurationMatrix`: Tracks tested configurations and fix applications
- `DiagnosticEngine`: Main orchestrator for diagnostics

### Network Fixer System

The fixer system provides:
- Objective detection of specific network issues
- Automated fix implementations with validation
- Rollback capability when fixes fail
- Cross-platform support (Linux, macOS, Windows)

**Components:**
- `NetworkFixer`: Python class with detection and fix logic
- Shell scripts: Platform-specific implementations
- Dry-run mode: Safety validation before actual changes

### Diagnostic Layers

Tests are organized by network depth:
1. **Gateway Layer**: Direct connectivity to gateway
2. **ISP Layer**: Connectivity to ISP DNS
3. **DNS Layer**: Public DNS resolution
4. **TLS Layer**: HTTPS certificate validation
5. **Connection Hold**: Long-term stability

## Design Principles

### Property-Driven Development (PDD)
Tests verify that system invariants hold, enabling broad exploration of network state space.

### Specification-Driven Development (SDD)
Tests specify exact expected behavior, enabling precise verification of diagnostic output.

### Safe Condition Evaluation
Conditions in diagnostic rules use recursive descent parsing instead of unsafe `eval()`.

## File Structure

```
netcheck/
├── diagnostic_engine.py    # Core diagnostic logic
├── probes.py              # Network test implementations
├── environ.py             # Environment detection
├── store.py               # Result storage
└── ...

tools/
├── code_simplification.py  # Code complexity analysis
├── security_review.py      # Security vulnerability detection
├── documentation_check.py  # Documentation validation
├── fixer.py               # Network fixer implementation
└── *.sh                   # Shell script implementations

tests/
├── test_diagnostic_engine.py     # Engine tests
├── test_diagnostic_website.py    # Website tests
└── conftest.py                   # Pytest fixtures
```

## Testing

All code is tested with pytest. Run tests with:

```bash
pytest tests/ -v
```

Coverage reports are generated automatically during CI/CD.
