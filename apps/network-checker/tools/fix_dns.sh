#!/bin/bash
# Fix DNS: use public resolvers when router DNS fails
# Supports: systemd-resolved (Linux), /etc/resolv.conf, Windows netsh

set -e

VERBOSE=${VERBOSE:-0}
RESOLVERS="${RESOLVERS:-1.1.1.1 8.8.8.8}"

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

# Fix using systemd-resolved
fix_with_systemd_resolved() {
    log "Using systemd-resolved"

    # Create resolv.conf drop-in
    local drop_in_dir="/etc/systemd/resolved.conf.d"
    local drop_in="$drop_in_dir/network-checker.conf"

    sudo mkdir -p "$drop_in_dir"

    # Build DNS line
    local dns_line="DNS=$RESOLVERS"
    echo "[Resolve]" | sudo tee "$drop_in" > /dev/null
    echo "$dns_line" | sudo tee -a "$drop_in" > /dev/null

    log "Wrote $drop_in"

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
