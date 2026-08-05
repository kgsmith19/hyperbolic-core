# Automation Tools

Lean, tunable automation scripts for code quality, security, and network diagnostics.

## Quick Start: Fix Network Issues

Run automated network diagnostics and fixes:

```bash
# See what would be fixed (dry-run)
sudo bash tools/run_fixes.sh --dry-run

# Apply all fixes with validation
sudo bash tools/run_fixes.sh

# Fix only DNS
sudo bash tools/run_fixes.sh --dns-only

# Verbose output for debugging
sudo bash tools/run_fixes.sh -v
```

---

## Fixer System: Detect & Fix Network Issues

Objective network issue detection with automated fixes, validation, and rollback.

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

---

## Fixer System Details

### Components

1. **fixer.py** - Python module with cross-platform detection and fix logic
2. **run_fixes.sh** - Master script that coordinates all fixes
3. **fix_wifi_mode.sh** - Detect/fix pinned WiFi mode
4. **fix_dns.sh** - Detect/fix DNS resolution failures
5. **fix_adapter_power.sh** - Detect/fix aggressive power management

### How It Works

For each issue:
1. **Detect** - Objectively verify the problem exists
   - Check current network state
   - Test connectivity/functionality
   - Identify root cause
2. **Fix** - Apply solution with privilege escalation
   - Backup original state for rollback
   - Apply configuration changes
   - Handle platform differences (Linux/macOS/Windows)
3. **Validate** - Verify fix actually solved the problem
   - Re-test after fix applied
   - Confirm functionality restored
   - Document before/after state
4. **Rollback** - Undo all changes if fix fails validation
   - Restore original configuration
   - Clean up temporary files
   - Log rollback actions

### Detected Issues & Fixes

#### 1. WiFi Mode Pinned (`fix_wifi_mode.sh`)

**Problem:** WiFi adapter is set below its capability (e.g., 802.11ac when it supports 802.11ax)

**Detection:**
```bash
iw dev wlan0 link          # Current mode
iw phy | grep 802.11ax     # Capability check
```

**Fix:** Set mode to 802.11ax if available

**Validation:** Verify link speed/mode after applying fix

#### 2. DNS Failures (`fix_dns.sh`)

**Problem:** Local resolver (usually router DNS) is failing

**Detection:**
```bash
nslookup google.com        # Resolution test
cat /etc/resolv.conf       # Current resolvers
```

**Fix:** Set DNS to public resolvers (Cloudflare 1.1.1.1, Google 8.8.8.8)

**Validation:** Retry DNS resolution after applying fix

**Supports:** 
- systemd-resolved (modern Linux)
- /etc/resolv.conf (traditional)
- netsh (Windows)

#### 3. Adapter Power Management (`fix_adapter_power.sh`)

**Problem:** Aggressive power saving on network adapter causes disconnects

**Detection:**
```bash
ethtool wlan0              # Check wake-on-lan
iw dev wlan0 get power_save  # Check power save mode
```

**Fix:** Disable power save, enable wake-on-lan

**Validation:** Verify power save is disabled after fix

#### 4. Gateway Unreachable

**Detection:** Gateway IP unreachable via ping

**Status:** Validation only (manual troubleshooting required)

### Usage Examples

#### Apply All Fixes with Dry-Run First
```bash
# See what would change
sudo bash tools/run_fixes.sh --dry-run

# Apply if satisfied
sudo bash tools/run_fixes.sh
```

#### Fix Specific Issues
```bash
# Only DNS
sudo bash tools/run_fixes.sh --dns-only

# Only WiFi mode
sudo bash tools/run_fixes.sh --wifi-only

# Only power management
sudo bash tools/run_fixes.sh --adapter-only
```

#### Verbose Output for Debugging
```bash
sudo bash tools/run_fixes.sh -v
# or
VERBOSE=1 sudo bash tools/run_fixes.sh
```

#### Python Module Direct Usage
```python
from tools.fixer import NetworkFixer

fixer = NetworkFixer(dry_run=False, verbose=True)

# Check specific issue
detected, state = fixer.detect_dns_issue()
if detected:
    result = fixer.fix_dns()
    print(f"Fix applied: {result.applied}")
    print(f"Validated: {result.validated}")

# Apply all fixes
results = fixer.apply_all_fixes()
for r in results:
    print(f"{r.issue}: {r.error or 'OK'}")
```

### Output Format

**Text (default):**
```
ok: DNS fixed to 1.1.1.1 8.8.8.8
✓ WiFi Mode: detected=true, applied=true, validated=true
error: Power management fix failed validation
```

**JSON (with `--json`):**
```json
{
  "issue": "dns_failure",
  "detected": true,
  "applied": true,
  "validated": true,
  "before_state": {"resolvers": ["192.168.1.1"]},
  "after_state": {"resolvers": ["1.1.1.1", "8.8.8.8"]},
  "timestamp": "2026-08-05T11:00:00+00:00"
}
```

### Safety Features

1. **Dry-Run Mode** - Test all changes without applying them
   ```bash
   sudo bash tools/run_fixes.sh --dry-run
   ```

2. **Backup & Rollback** - Original state saved, all changes reversible
   - `/etc/resolv.conf.bak` for DNS changes
   - Rollback stack tracks all modifications

3. **Privilege Escalation** - Only requests sudo when needed
   - Detection runs as user
   - Fixes escalate with sudo
   - Validates runs as user

4. **Verbose Logging** - Full audit trail of what was changed
   ```bash
   VERBOSE=1 sudo bash tools/run_fixes.sh
   ```

5. **Before/After Validation** - Every fix must pass validation
   - Detects problem before fix
   - Applies fix
   - Validates problem is solved
   - Rolls back if validation fails

### Troubleshooting

#### DNS Fix Fails
```bash
# Check what resolvers are being set
cat /etc/resolv.conf

# Manually test resolution
nslookup google.com

# Check DNS system in use
systemctl is-active systemd-resolved
```

#### WiFi Mode Fix Not Working
```bash
# Check adapter name
ls /sys/class/net/

# Check current mode
iw wlan0 link

# Check capability
iw phy | grep 802.11
```

#### Power Management Fix Issues
```bash
# Check ethtool available
which ethtool

# Check current power settings
ethtool wlan0
```

### CI Integration

Use in pipelines to automatically fix known issues:

```yaml
# GitHub Actions example
- name: Auto-fix network issues
  run: |
    sudo bash tools/run_fixes.sh --dns-only  # Usually just DNS in CI
    
- name: Verify fixes
  run: python tools/fixer.py --format json
```

### Limitations

- **Platform Support:** Primarily Linux; macOS/Windows need manual intervention for some fixes
- **Privilege Model:** Fixes require root; some tests don't
- **ISP/Modem:** Cannot directly fix ISP issues; requires DOCSIS troubleshooting
- **Hardware:** Cannot fix hardware failures (broken WiFi card, bad cable)
- **Authentication:** Cannot fix WiFi auth issues (requires network credentials)

### Future Enhancements

- MTU auto-discovery and adjustment
- TCP window scaling tuning
- Systemd network file generation
- Docker/container network fixes
- macOS System Preferences automation
- Windows PowerShell alternative implementations
