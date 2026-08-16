#!/bin/bash
# Fix DNS: use public resolvers when router DNS fails
# Supports: systemd-resolved (Linux), /etc/resolv.conf, Windows netsh

set -e

VERBOSE=${VERBOSE:-0}
RESOLVERS="${RESOLVERS:-1.1.1.1 8.8.8.8}"

# 05-f section 4.5's Finding 18: the systemd-resolved branch used to
# unconditionally `rm -f` this drop-in on rollback, which destroys an
# operator's own pre-existing file just as readily as one this script wrote
# itself. NETWORK_CHECKER_STATE_DIR/NETWORK_CHECKER_DNS_DROPIN are overridable so tests can
# point both at a throwaway temp tree instead of real /etc paths -- see
# tests/test_fix_scripts.py.
STATE_DIR="${NETWORK_CHECKER_STATE_DIR:-$HOME/.network-checker/change_state}"
STATE_FILE="$STATE_DIR/dns.state"
DROP_IN="${NETWORK_CHECKER_DNS_DROPIN:-/etc/systemd/resolved.conf.d/network-checker.conf}"

log() {
    if [ "$VERBOSE" -eq 1 ]; then
        echo "[fix_dns] $*" >&2
    fi
}

# Test DNS resolution
test_dns() {
    nslookup google.com &>/dev/null && return 0 || return 1
}

# Get current DNS
get_current_dns() {
    if [ -f /etc/resolv.conf ]; then
        grep '^nameserver' /etc/resolv.conf | awk '{print $2}'
    fi
}

# Backup current DNS
backup_dns() {
    [ -f /etc/resolv.conf ] && cp /etc/resolv.conf /etc/resolv.conf.bak
}

# Detect which DNS system is in use
detect_dns_system() {
    if systemctl is-active systemd-resolved &>/dev/null; then
        echo "systemd-resolved"
    elif [ -f /etc/resolv.conf ]; then
        echo "resolv.conf"
    else
        echo "unknown"
    fi
}

# Capture the pre-change DNS state so the inverse can perform a real
# restoration instead of guessing (Finding 18): specifically, whether
# $DROP_IN already existed before this run touches it, and if so, its exact
# prior bytes. `--force` re-captures even if $STATE_FILE already exists;
# the default is capture-once-keep -- change.py's apply() only calls
# change_cmd once per approved row, so the first capture of a run is the
# only one that is ever the true pre-change baseline, and a second capture
# (e.g. a change proposed again later reusing this same host) must not
# clobber it with already-modified state. See this file's own header for
# the caveat that follows from that choice.
capture_state() {
    if [ -f "$STATE_FILE" ] && [ "${1:-}" != "--force" ]; then
        log "state already captured at $STATE_FILE; leaving it"
        return 0
    fi
    mkdir -p "$STATE_DIR"
    if [ -f "$DROP_IN" ]; then
        {
            echo "DROP_IN_EXISTED=true"
            echo "DROP_IN_CONTENT_B64=$(base64 < "$DROP_IN" | tr -d '\n')"
        } > "$STATE_FILE"
        log "captured pre-existing $DROP_IN to $STATE_FILE"
    else
        echo "DROP_IN_EXISTED=false" > "$STATE_FILE"
        log "captured: $DROP_IN did not exist before this change"
    fi
}

# Restore whatever `capture_state` actually observed, in the same priority
# order the script itself picks a DNS mechanism: an /etc/resolv.conf.bak
# this run made is always the most exact restoration available; failing
# that, the captured drop-in state; failing that, Windows DHCP. Never an
# unconditional `rm -f` of a path that might hold an operator's own file.
restore_state() {
    if [ -f /etc/resolv.conf.bak ]; then
        sudo mv /etc/resolv.conf.bak /etc/resolv.conf
        log "restored /etc/resolv.conf from backup"
        return 0
    fi
    if [ -f "$STATE_FILE" ]; then
        _restore_drop_in
        return $?
    fi
    if command -v netsh &>/dev/null; then
        netsh interface ip set dns name="Ethernet" dhcp &>/dev/null || true
        log "reset Windows DNS to DHCP"
        return 0
    fi
    echo "error: nothing to restore -- no /etc/resolv.conf.bak, no captured" \
         "state at $STATE_FILE, and no netsh" >&2
    return 1
}

# The drop-in half of restore_state, split out only to keep restore_state
# itself under the repo's complexity ceiling.
_restore_drop_in() {
    local existed content_b64
    existed=$(grep '^DROP_IN_EXISTED=' "$STATE_FILE" | cut -d= -f2)
    if [ "$existed" = "true" ]; then
        content_b64=$(grep '^DROP_IN_CONTENT_B64=' "$STATE_FILE" | cut -d= -f2-)
        echo "$content_b64" | base64 -d | sudo tee "$DROP_IN" > /dev/null
        sudo systemctl restart systemd-resolved
        log "restored pre-existing content to $DROP_IN"
    elif [ -f "$DROP_IN" ]; then
        sudo rm -f "$DROP_IN"
        sudo systemctl restart systemd-resolved
        log "removed $DROP_IN, which did not exist before this change"
    else
        log "no drop-in before or after; nothing to restore"
    fi
}

# Fix using systemd-resolved
fix_with_systemd_resolved() {
    log "Using systemd-resolved"

    capture_state

    # Create resolv.conf drop-in
    sudo mkdir -p "$(dirname "$DROP_IN")"

    # Build DNS line
    local dns_line="DNS=$RESOLVERS"
    echo "[Resolve]" | sudo tee "$DROP_IN" > /dev/null
    echo "$dns_line" | sudo tee -a "$DROP_IN" > /dev/null

    log "Wrote $DROP_IN"

    # Restart systemd-resolved
    sudo systemctl restart systemd-resolved

    log "Restarted systemd-resolved"
}

# Fix using /etc/resolv.conf
fix_with_resolv_conf() {
    log "Using /etc/resolv.conf"

    backup_dns

    # Write new resolvers
    {
        for resolver in $RESOLVERS; do
            echo "nameserver $resolver"
        done
        # Keep search domains from original if they exist
        grep '^search\|^domain' /etc/resolv.conf.bak 2>/dev/null || true
    } | sudo tee /etc/resolv.conf > /dev/null

    log "Updated /etc/resolv.conf"
}

# Fix using Windows netsh (if running under WSL or native Windows)
fix_with_windows() {
    log "Using Windows netsh"

    for resolver in $RESOLVERS; do
        netsh interface ip add dns name="Ethernet" "$resolver" &>/dev/null || true
    done

    log "Updated Windows DNS settings"
}

# Validate fix
validate_fix() {
    local attempts=5
    local i=0

    while [ $i -lt $attempts ]; do
        if test_dns; then
            log "DNS validation successful"
            return 0
        fi
        log "DNS validation attempt $((i+1))/$attempts failed, retrying..."
        sleep 1
        ((i++))
    done

    log "DNS validation failed after $attempts attempts"
    return 1
}

# Main
main() {
    case "${1:-}" in
        --capture-state) capture_state "${2:-}"; return $? ;;
        --restore) restore_state; return $? ;;
    esac

    log "Starting DNS fix..."

    # Check if DNS is already working
    if test_dns; then
        echo "ok: DNS already working"
        return 0
    fi

    log "DNS resolution is failing, applying fix..."

    local dns_system
    dns_system=$(detect_dns_system)

    case "$dns_system" in
        systemd-resolved)
            fix_with_systemd_resolved || return 1
            ;;
        resolv.conf)
            fix_with_resolv_conf || return 1
            ;;
        *)
            echo "error: Could not determine DNS system"
            return 1
            ;;
    esac

    # Validate
    if validate_fix; then
        echo "ok: DNS fixed to $RESOLVERS"
        return 0
    else
        echo "error: DNS fix failed validation"

        # Rollback if available
        if [ -f /etc/resolv.conf.bak ]; then
            log "Rolling back to original DNS..."
            sudo mv /etc/resolv.conf.bak /etc/resolv.conf
        fi

        return 1
    fi
}

main "$@"
