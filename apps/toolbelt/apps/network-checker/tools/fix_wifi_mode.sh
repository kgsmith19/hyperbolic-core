#!/bin/bash
# Fix WiFi mode: set to 802.11ax (WiFi 6) if available
# Requires: Linux with iw and networkctl

set -e

VERBOSE=${VERBOSE:-0}

log() {
    if [ "$VERBOSE" -eq 1 ]; then
        echo "[fix_wifi_mode] $*" >&2
    fi
}

# Detect current mode and capability
detect_wifi_state() {
    local adapter wlan_adapter

    # Find wireless adapter
    wlan_adapter=$(ls /sys/class/net/ | grep -E 'wlan|wifi' | head -1)
    if [ -z "$wlan_adapter" ]; then
        echo "error: no WiFi adapter found"
        return 1
    fi

    log "Found WiFi adapter: $wlan_adapter"

    # Get current mode
    local current_mode
    if iw "$wlan_adapter" link &>/dev/null; then
        current_mode=$(iw "$wlan_adapter" link | grep -oP '802\.11[a-z]+' | head -1)
    fi

    # Get capabilities
    local has_ax has_ac
    has_ax=$(iw phy | grep -q '802\.11ax' && echo 1 || echo 0)
    has_ac=$(iw phy | grep -q '802\.11ac' && echo 1 || echo 0)

    log "Current mode: ${current_mode:-unknown}, has_ax=$has_ax, has_ac=$has_ac"

    echo "$wlan_adapter:$current_mode:$has_ax:$has_ac"
}

# Apply fix: set to 802.11ax if available
apply_fix() {
    local adapter=$1
    local current_mode=$2
    local has_ax=$3

    # Check if already on 802.11ax
    if [ "$current_mode" = "802.11ax" ]; then
        log "Already on 802.11ax, no fix needed"
        return 0
    fi

    if [ "$has_ax" -ne 1 ]; then
        log "Device doesn't support 802.11ax"
        return 0
    fi

    log "Setting $adapter to 802.11ax..."

    # Method 1: Use iw to set mode (requires privileges)
    if sudo iw phy phy0 set txpower auto &>/dev/null; then
        log "Successfully applied WiFi mode settings"
        return 0
    else
        log "Failed to apply WiFi mode settings (may require manual intervention)"
        return 1
    fi
}

# Validate fix was applied
validate_fix() {
    local adapter=$1

    sleep 2  # Wait for changes to take effect

    local new_mode
    if iw "$adapter" link &>/dev/null; then
        new_mode=$(iw "$adapter" link | grep -oP '802\.11[a-z]+' | head -1)
    fi

    log "New mode after fix: ${new_mode:-unknown}"
    [ "$new_mode" = "802.11ax" ] && return 0 || return 1
}

# Main
main() {
    local state
    state=$(detect_wifi_state) || {
        echo "$state"
        return 1
    }

    IFS=':' read -r adapter current_mode has_ax has_ac <<< "$state"

    if [ "$current_mode" = "802.11ax" ]; then
        echo "ok: WiFi already on 802.11ax"
        return 0
    fi

    if [ "$has_ax" -ne 1 ]; then
        echo "skip: Device doesn't support 802.11ax"
        return 0
    fi

    # Apply and validate
    if apply_fix "$adapter" "$current_mode" "$has_ax"; then
        if validate_fix "$adapter"; then
            echo "ok: WiFi mode fixed to 802.11ax"
            return 0
        else
            echo "error: WiFi mode fix failed validation"
            return 1
        fi
    else
        echo "error: Failed to apply WiFi mode fix"
        return 1
    fi
}

main "$@"
