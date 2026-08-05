# Automation Tools

Three lean, tunable automation scripts for code quality and security.

## Tools

### 1. Code Simplification (`code_simplification.py`)

Enforces lean code: short functions, no unnecessary complexity.

**Usage:**
```bash
python tools/code_simplification.py <path> [-i INTENSITY] [-f FORMAT]
```

**Intensity levels:**
- `low`: Functions > 30 lines
- `medium` (default): Functions > 20 lines, detect unused variables
- `high`: Functions > 15 lines, all complexity metrics

**Example:**
```bash
python tools/code_simplification.py netcheck -i high
python tools/code_simplification.py netcheck -i medium -f json
```

**Rules:**
- `function_too_long`: Function exceeds line threshold
- `syntax_error`: Python syntax errors

### 2. Security Review (`security_review.py`)

Detects common vulnerabilities and anti-patterns.

**Usage:**
```bash
python tools/security_review.py <path> [-i INTENSITY] [-f FORMAT]
```

**Intensity levels:**
- `low`: Hardcoded secrets only
- `medium` (default): Secrets + injection patterns + weak crypto
- `high`: Aggressive pattern matching for all vulnerability types

**Example:**
```bash
python tools/security_review.py . -i high
python tools/security_review.py netcheck/ -f json
```

**Patterns detected:**
- `dangerous_eval`: Use of eval() or exec()
- `insecure_deserialization`: pickle/yaml.load()
- `shell_injection`: subprocess with shell=True
- `api_key`, `password`, `token`: Hardcoded secrets
- `url_credentials`: Credentials in URLs

### 3. Documentation Check (`documentation_check.py`)

Ensures docs are current, lean, and complete.

**Usage:**
```bash
python tools/documentation_check.py <path> [-i INTENSITY] [-f FORMAT]
```

**Intensity levels:**
- `low`: README exists and no template scaffolding
- `medium` (default): Structure + lean principle + docstrings
- `high`: Full validation of all docstrings and examples

**Example:**
```bash
python tools/documentation_check.py . -i high
python tools/documentation_check.py . -f json
```

**Rules:**
- `missing_readme`: README.md not found
- `template_artifact`: Placeholders like [TBD], [TODO]
- `missing_docstring`: Public function lacks docstring
- `template_file`: Scaffold files that should be removed
- `empty_docs_dir`: docs/ directory exists but is empty

## Output Formats

### Text (default)
```
file.py:42: [severity] rule: message
  > code_snippet
```

### JSON
```json
{
  "file": "file.py",
  "line": 42,
  "severity": "high",
  "rule": "dangerous_eval",
  "message": "Use of eval() is unsafe"
}
```

## Exit Codes

- `0`: No issues found
- `1`: Issues found

## CI Integration

Use these in CI pipelines to enforce standards:

```yaml
# Example GitHub Actions
- name: Code simplification check
  run: python tools/code_simplification.py netcheck -i high

- name: Security review
  run: python tools/security_review.py . -i high

- name: Documentation check
  run: python tools/documentation_check.py . -i high
```

## Configuration

Each tool's intensity level is tunable:
- **Lean mode** (low): Catch only egregious violations
- **Standard mode** (medium): Balanced catch rate
- **Strict mode** (high): Aggressive rules for high-quality code

Choose intensity based on project stage:
- Early development: `low` to `medium`
- Production: `medium` to `high`
- Code review: `high` for thoroughness
