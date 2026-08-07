#!/bin/bash
# Run all network fixes with detection, application, and validation
# Runs each fix script in order, with --dry-run support

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=${DRY_RUN:-0}
VERBOSE=${VERBOSE:-0}
FIX_WIFI=${FIX_WIFI:-1}
FIX_DNS=${FIX_DNS:-1}
FIX_ADAPTER=${FIX_ADAPTER:-1}

log() {
    echo "[run_fixes] $*" >&2
}

run_fix() {
    local name=$1
    local script=$2

    log "Running fix: $name..."

    if [ "$DRY_RUN" -eq 1 ]; then
        log "DRY-RUN: would run $script"
        return 0
    fi

    if bash "$script" 2>&1; then
        log "✓ $name succeeded"
        return 0
    else
        log "✗ $name failed"
        return 1
    fi
}

main() {
    log "Starting network diagnostics and fixes..."

    if ! command -v iw &>/dev/null && ! command -v ethtool &>/dev/null; then
        log "Warning: iw and ethtool not found, some fixes may not work"
        log "Install with: sudo apt install iw ethtool"
    fi

    local results=()
    local failed=0

    # Run WiFi mode fix
    if [ "$FIX_WIFI" -eq 1 ] && [ -f "$SCRIPT_DIR/fix_wifi_mode.sh" ]; then
        if run_fix "WiFi Mode" "$SCRIPT_DIR/fix_wifi_mode.sh"; then
            results+=("WiFi: ✓")
        else
            results+=("WiFi: ✗")
            ((failed++))
        fi
    fi

    # Run DNS fix
    if [ "$FIX_DNS" -eq 1 ] && [ -f "$SCRIPT_DIR/fix_dns.sh" ]; then
        if run_fix "DNS" "$SCRIPT_DIR/fix_dns.sh"; then
            results+=("DNS: ✓")
        else
            results+=("DNS: ✗")
            ((failed++))
        fi
    fi

    # Run adapter power management fix
    if [ "$FIX_ADAPTER" -eq 1 ] && [ -f "$SCRIPT_DIR/fix_adapter_power.sh" ]; then
        if run_fix "Adapter Power" "$SCRIPT_DIR/fix_adapter_power.sh"; then
            results+=("Adapter: ✓")
        else
            results+=("Adapter: ✗")
            ((failed++))
        fi
    fi

    # Summary
    log "Fix Results:"
    for result in "${results[@]}"; do
        log "  $result"
    done

    if [ $failed -eq 0 ]; then
        log "All fixes completed successfully!"
        return 0
    else
        log "Some fixes failed. Review logs above."
        return 1
    fi
}

# Show usage
show_usage() {
    cat <<EOF
Usage: run_fixes.sh [OPTIONS]

Apply detected network fixes with validation and rollback support.

Options:
  --dry-run              Show what would be done without applying changes
  --wifi-only            Only fix WiFi mode
  --dns-only             Only fix DNS
  --adapter-only         Only fix adapter power management
  -v, --verbose          Verbose output
  -h, --help             Show this help message

Environment variables:
  DRY_RUN=1              Enable dry-run mode
  VERBOSE=1              Enable verbose logging
  FIX_WIFI=0/1           Enable/disable WiFi fix (default: 1)
  FIX_DNS=0/1            Enable/disable DNS fix (default: 1)
  FIX_ADAPTER=0/1        Enable/disable adapter fix (default: 1)

Examples:
  # Apply all fixes
  sudo bash run_fixes.sh

  # Dry-run to see what would happen
  sudo bash run_fixes.sh --dry-run

  # Only fix DNS
  sudo bash run_fixes.sh --dns-only

  # Verbose output
  sudo bash run_fixes.sh -v
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --wifi-only)
            FIX_DNS=0
            FIX_ADAPTER=0
            shift
            ;;
        --dns-only)
            FIX_WIFI=0
            FIX_ADAPTER=0
            shift
            ;;
        --adapter-only)
            FIX_WIFI=0
            FIX_DNS=0
            shift
            ;;
        -v|--verbose)
            VERBOSE=1
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            log "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Check for root
if [ "$EUID" -ne 0 ] && [ "$DRY_RUN" -ne 1 ]; then
    log "This script requires root privileges. Run with: sudo bash run_fixes.sh"
    exit 1
fi

main "$@"
