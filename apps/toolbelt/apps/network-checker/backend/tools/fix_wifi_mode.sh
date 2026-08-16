#!/bin/bash
# Fix WiFi mode: set to 802.11ax (WiFi 6) if available
# Requires: Linux with iw and networkctl

set -e

VERBOSE=${VERBOSE:-0}
# 05-f section 4.5's Finding 18: apply_fix's only real device write is
# `iw phy phy0 set txpower auto`, and until this change the inverse in
# change_templates.py was the literal same command -- "undo" and "the
# change's own first attempted fix" were identical, so a rollback never
# restored whatever tx-power setting was actually there before. capture_state
# below records that real prior value; restore_state re-pins to it instead
# of re-running the forward fix. PHY/NETWORK_CHECKER_STATE_DIR are overridable so
# tests can exercise the real branching logic without a real radio -- see
# tests/test_fix_scripts.py.
PHY="${NETWORK_CHECKER_WIFI_PHY:-phy0}"
STATE_DIR="${NETWORK_CHECKER_STATE_DIR:-$HOME/.network-checker/change_state}"
STATE_FILE="$STATE_DIR/wifi_mode.state"

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

# Capture the pre-change tx-power so restore_state has a real value to put
# back, rather than always re-asserting 'auto' regardless of what was there
# before (Finding 18). Capture-once-keep, same reasoning as fix_dns.sh's
# capture_state: change.py's apply() only ever calls change_cmd once per
# approved row, so only the first capture of a run is the true baseline.
capture_state() {
    if [ -f "$STATE_FILE" ] && [ "${1:-}" != "--force" ]; then
        log "state already captured at $STATE_FILE; leaving it"
        return 0
    fi
    local adapter txpower
    adapter=$(ls /sys/class/net/ 2>/dev/null | grep -E 'wlan|wifi' | head -1)
    if [ -z "$adapter" ]; then
        echo "error: no WiFi adapter found; nothing to capture" >&2
        return 1
    fi
    txpower=$(iw "$adapter" info 2>/dev/null | grep -oP 'txpower \K[\d.]+')
    mkdir -p "$STATE_DIR"
    {
        echo "ADAPTER=$adapter"
        echo "TXPOWER_DBM=${txpower:-unknown}"
    } > "$STATE_FILE"
    log "captured $adapter's pre-change tx-power (${txpower:-unknown} dBm) to $STATE_FILE"
}

# Restore the captured original tx-power exactly, via `iw ... set txpower
# fixed <mBm>` -- genuinely undoing this change, even when the original
# value was itself a low pinned setting (the fault this template exists to
# fix in the forward direction; a true rollback restores what was actually
# there, not a value this script merely considers safe). Falls back to
# 'auto' only when there is truly nothing captured to restore to.
restore_state() {
    if [ ! -f "$STATE_FILE" ]; then
        echo "error: no captured WiFi state at $STATE_FILE; falling back to" \
             "'auto' since the real original tx-power was never recorded" >&2
        sudo iw phy "$PHY" set txpower auto
        return $?
    fi
    local txpower mbm
    txpower=$(grep '^TXPOWER_DBM=' "$STATE_FILE" | cut -d= -f2)
    if [ -z "$txpower" ] || [ "$txpower" = "unknown" ]; then
        log "captured tx-power was unreadable; restoring to 'auto'"
        sudo iw phy "$PHY" set txpower auto
        return $?
    fi
    # iw's fixed-power form takes mBm (hundredths of a dBm).
    mbm=$(awk "BEGIN { printf \"%d\", $txpower * 100 }")
    log "restoring tx-power to its captured original: $txpower dBm"
    sudo iw phy "$PHY" set txpower fixed "$mbm"
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

    capture_state

    # Method 1: Use iw to set mode (requires privileges)
    if sudo iw phy "$PHY" set txpower auto &>/dev/null; then
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
    case "${1:-}" in
        --capture-state) capture_state "${2:-}"; return $? ;;
        --restore) restore_state; return $? ;;
    esac

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
