#!/bin/bash
# Fix adapter power management: disable aggressive sleep modes
# Disables power save on WiFi/Ethernet to prevent disconnects

set -e

VERBOSE=${VERBOSE:-0}

log() {
    if [ "$VERBOSE" -eq 1 ]; then
        echo "[fix_adapter_power] $*" >&2
    fi
}

# Find primary network adapter
find_adapter() {
    # Try WiFi first
    local wlan
    wlan=$(ls /sys/class/net/ 2>/dev/null | grep -E 'wlan|wifi' | head -1)
    if [ -n "$wlan" ]; then
        echo "$wlan"
        return
    fi

    # Fall back to Ethernet
    local eth
    eth=$(ls /sys/class/net/ 2>/dev/null | grep -E 'eth|eno|enp' | head -1)
    if [ -n "$eth" ]; then
        echo "$eth"
        return
    fi

    return 1
}

# Check if power management is enabled
is_power_management_enabled() {
    local adapter=$1

    # Check ethtool for wake-on-lan settings
    if ethtool "$adapter" 2>/dev/null | grep -q "Wake-on.*g"; then
        return 0  # Enabled
    fi

    # Check iw for power save
    if iw dev "$adapter" get power_save 2>/dev/null | grep -q "on"; then
        return 0  # Enabled
    fi

    return 1  # Disabled
}

# Disable power management
disable_power_management() {
    local adapter=$1

    log "Disabling power management on $adapter..."

    # Disable iw power save
    if iw dev "$adapter" set power_save off &>/dev/null; then
        log "Disabled iw power_save"
    fi

    # Enable wake-on-lan (keeps adapter responsive)
    if sudo ethtool -s "$adapter" wol g &>/dev/null; then
        log "Enabled wake-on-lan"
    fi

    # For WiFi, disable power save in driver
    if [[ "$adapter" == wlan* ]]; then
        if sudo iw "$adapter" set power_save off &>/dev/null; then
            log "Disabled WiFi power save"
        fi
    fi
}

# Verify power management is disabled
verify_disabled() {
    local adapter=$1
    sleep 1

    ! is_power_management_enabled "$adapter"
}

# Main
main() {
    log "Starting adapter power management fix..."

    local adapter
    adapter=$(find_adapter) || {
        echo "error: Could not find network adapter"
        return 1
    }

    log "Found adapter: $adapter"

    # Check if power management is a problem
    if ! is_power_management_enabled "$adapter"; then
        echo "ok: Power management already optimal"
        return 0
    fi

    log "Power management is enabled, disabling..."

    # Apply fix
    disable_power_management "$adapter"

    # Validate
    if verify_disabled "$adapter"; then
        echo "ok: Power management disabled on $adapter"
        return 0
    else
        echo "error: Failed to disable power management"
        return 1
    fi
}

main "$@"
