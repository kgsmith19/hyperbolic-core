#!/usr/bin/env bash
# Thin Claude Code adapter (kgsmith19/agent-extensions#68). Cloud sessions
# only: ensure an agent-extensions checkout, run its provider-neutral
# bootstrap/session-start.sh (provision when absent, ~/bin on PATH, queue
# head), then this repo's own dependencies. Never fails the session.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
EXT="${AGENT_EXTENSIONS_DIR:-$HOME/.agent-extensions}"
EXT_URL="${AGENT_EXTENSIONS_REPO_URL:-https://github.com/kgsmith19/agent-extensions.git}"

if [ -d "$EXT/.git" ]; then
  git -C "$EXT" pull -q --ff-only 2>/dev/null || echo "extensions: degraded (could not update $EXT; using it as is)"
elif git clone -q --depth 1 "$EXT_URL" "$EXT" 2>/dev/null; then
  echo "extensions: ok (cloned to $EXT)"
else
  echo "extensions: degraded (clone of $EXT_URL failed)"
fi
if [ -f "$EXT/bootstrap/session-start.sh" ]; then
  AGENT_EXTENSIONS_DIR="$EXT" bash "$EXT/bootstrap/session-start.sh" --env-file "${CLAUDE_ENV_FILE:-}"
else
  echo "session-start: degraded (no $EXT/bootstrap/session-start.sh)"
fi

# Workspace dependencies, exactly as CI installs them (npm ci keeps the
# lockfile untouched). Skipped when node_modules matches the current lock.
lock_sha="$(sha256sum "$ROOT/package-lock.json" 2>/dev/null | cut -d' ' -f1)"
stamp="$ROOT/node_modules/.session-start-lock-sha256"
if [ -n "$lock_sha" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$lock_sha" ]; then
  echo "deps: present (node_modules matches package-lock.json)"
elif (cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1); then
  printf '%s\n' "$lock_sha" > "$stamp"
  echo "deps: ok (npm ci)"
else
  echo "deps: degraded (npm ci failed; run it by hand to see why)"
fi
exit 0
