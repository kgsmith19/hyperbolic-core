#!/bin/bash
# Fix adapter power management: disable aggressive sleep modes
# Disables power save on WiFi/Ethernet to prevent disconnects

set -e

VERBOSE=${VERBOSE:-0}
# 05-f section 4.5's Finding 18: disable_power_management touches two
# independent settings (iw power_save, ethtool Wake-on-LAN), but until this
# change the inverse in change_templates.py only ever turned power_save
# back on -- WoL stayed enabled forever, even after a "rollback". capture_state
# below records both real prior values; restore_state puts both back.
# NETWORK_CHECKER_STATE_DIR is overridable so tests can exercise the real
# branching logic without a real adapter -- see tests/test_fix_scripts.py.
STATE_DIR="${NETWORK_CHECKER_STATE_DIR:-$HOME/.network-checker/change_state}"
STATE_FILE="$STATE_DIR/adapter_power.state"

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

# Capture the pre-change power_save and Wake-on-LAN state so restore_state
# can put both back, not just power_save. Capture-once-keep, same reasoning
# as fix_dns.sh's capture_state: change.py's apply() only ever calls
# change_cmd once per approved row, so only the first capture of a run is
# the true baseline.
capture_state() {
    if [ -f "$STATE_FILE" ] && [ "${2:-}" != "--force" ]; then
        log "state already captured at $STATE_FILE; leaving it"
        return 0
    fi
    local adapter=$1
    local power_save wol
    power_save=$(iw dev "$adapter" get power_save 2>/dev/null \
        | grep -oP 'Power save:\s*\K(on|off)')
    wol=$(ethtool "$adapter" 2>/dev/null | grep -oP 'Wake-on:\s*\K\S+')
    mkdir -p "$STATE_DIR"
    {
        echo "ADAPTER=$adapter"
        echo "POWER_SAVE=${power_save:-unknown}"
        echo "WOL=${wol:-unknown}"
    } > "$STATE_FILE"
    log "captured $adapter's pre-change state (power_save=${power_save:-unknown}," \
        "wol=${wol:-unknown}) to $STATE_FILE"
}

# Restore both captured values -- power_save and Wake-on-LAN together, the
# same pair disable_power_management sets, so a rollback undoes both halves
# of the change instead of leaving WoL armed forever.
restore_state() {
    if [ ! -f "$STATE_FILE" ]; then
        echo "error: no captured adapter-power state at $STATE_FILE;" \
             "cannot restore precisely" >&2
        return 1
    fi
    local adapter power_save wol
    adapter=$(grep '^ADAPTER=' "$STATE_FILE" | cut -d= -f2)
    power_save=$(grep '^POWER_SAVE=' "$STATE_FILE" | cut -d= -f2)
    wol=$(grep '^WOL=' "$STATE_FILE" | cut -d= -f2)
    if [ "$power_save" != "unknown" ] && [ -n "$power_save" ]; then
        sudo iw dev "$adapter" set power_save "$power_save" &>/dev/null || true
        log "restored $adapter power_save to $power_save"
    fi
    if [ "$wol" != "unknown" ] && [ -n "$wol" ]; then
        sudo ethtool -s "$adapter" wol "$wol" &>/dev/null || true
        log "restored $adapter Wake-on-LAN flags to $wol"
    fi
}

# Disable power management
disable_power_management() {
    local adapter=$1

    log "Disabling power management on $adapter..."

    capture_state "$adapter"

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
    local adapter
    case "${1:-}" in
        --capture-state)
            adapter=$(find_adapter) || { echo "error: Could not find network adapter" >&2; return 1; }
            capture_state "$adapter" "${2:-}"
            return $?
            ;;
        --restore) restore_state; return $? ;;
    esac

    log "Starting adapter power management fix..."

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
