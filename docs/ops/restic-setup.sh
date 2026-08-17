#!/usr/bin/env bash
# Bootstraps restic on the VPS against a Hetzner Storage Box (issue #164):
# installs a pinned, checksum-verified restic binary, writes an SSH config
# alias for the Storage Box's non-standard SFTP port, and idempotently
# initializes the two backup repositories this platform uses (`platform`,
# `lifeos`). Run ONCE, as the `deploy` user, after the Storage Box and its
# sub-account exist (docs/ops/vendors.md's Hetzner card).
#
# Companion workflows (E2/E3, not yet built) inject RESTIC_PASSWORD and the
# Storage Box SSH private key per-run from Infisical /platform/backup/ --
# this script never persists either credential to disk beyond what the
# chosen SSH config mechanism requires (the private key file itself, whose
# path the caller controls via --ssh-key-file and which the caller is
# responsible for placing with owner-only permissions before invoking
# --apply; this script never writes key material itself).
#
# CHECKSUM MODEL: restic publishes a SHA256SUMS manifest per release,
# signed and served over HTTPS from GitHub. Rather than hardcoding one
# binary's hash offline (this script's author has no way to independently
# re-verify a hand-copied hash against the real upstream artifact at
# authoring time, and a mistyped hardcoded hash is worse than none -- it
# either always fails or, if copied from an untrusted source, provides
# false assurance), this script downloads BOTH the release archive and its
# SHA256SUMS manifest over HTTPS and verifies the archive's hash against
# the matching manifest line. This is the same trust boundary (HTTPS +
# GitHub-hosted release) the repo's existing gitleaks pin already relies
# on for authenticity; it additionally protects against a corrupted or
# truncated download, which a hardcoded single hash would too.
set -euo pipefail

RESTIC_VERSION="0.18.1"

usage() {
  cat >&2 <<'EOF'
usage: restic-setup.sh [--dry-run|--apply] --storagebox-host=HOST
                        --storagebox-user=USER --ssh-key-file=PATH
                        [--repos=platform,lifeos]

  --dry-run              Print every command this script would run. Default.
  --apply                Run for real.
  --storagebox-host=HOST Hetzner Storage Box hostname (e.g. u123456.your-storagebox.de)
  --storagebox-user=USER Storage Box sub-account username
  --ssh-key-file=PATH    Path to the SSH private key authenticating to the
                          Storage Box. Must already exist with 0600
                          permissions; this script never writes it.
  --repos=a,b             Comma-separated restic repository names to
                          idempotently initialize. Default: platform,lifeos.

RESTIC_PASSWORD must be set in the environment before --apply; the same
password is used for every repository listed in --repos (each repository is
still a fully independent restic repo -- only the encryption password is
shared, matching the single Infisical /platform/backup/ secret path both
E2 and E3 read from).
EOF
}

mode="--dry-run"
storagebox_host=""
storagebox_user=""
ssh_key_file=""
repos="platform,lifeos"
for arg in "$@"; do
  case "$arg" in
    --dry-run | --apply) mode="$arg" ;;
    --storagebox-host=*) storagebox_host="${arg#--storagebox-host=}" ;;
    --storagebox-user=*) storagebox_user="${arg#--storagebox-user=}" ;;
    --ssh-key-file=*) ssh_key_file="${arg#--ssh-key-file=}" ;;
    --repos=*) repos="${arg#--repos=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$storagebox_host" || -z "$storagebox_user" || -z "$ssh_key_file" ]]; then
  echo "error: --storagebox-host, --storagebox-user, and --ssh-key-file are all required" >&2
  usage
  exit 2
fi

# Test isolation, mirroring bootstrap-vps.sh's own convention: a real run
# touches /usr/local/bin, ~/.ssh/config, and the network; tests redirect
# every one of those into a scratch directory instead.
install_dir="/usr/local/bin"
ssh_config_dir="$HOME/.ssh"
work_dir="$(mktemp -d)"
if [[ -n "${NODE_TEST_CONTEXT:-}" && -n "${RESTIC_SETUP_TEST_ROOT:-}" ]]; then
  install_dir="$RESTIC_SETUP_TEST_ROOT/usr-local-bin"
  ssh_config_dir="$RESTIC_SETUP_TEST_ROOT/ssh"
  mkdir -p "$install_dir" "$ssh_config_dir"
fi
trap 'rm -rf "$work_dir"' EXIT

run() {
  if [[ "$mode" == "--apply" ]]; then
    "$@"
  else
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  fi
}

# --- Step 1: pinned, checksum-verified restic install (idempotent) ---
restic_bin="$install_dir/restic"
current_version=""
if [[ -x "$restic_bin" ]]; then
  current_version="$("$restic_bin" version 2>/dev/null | awk '{print $2}' || true)"
fi

if [[ "$current_version" == "$RESTIC_VERSION" ]]; then
  echo "restic $RESTIC_VERSION already installed at $restic_bin -- skipping install"
else
  archive="restic_${RESTIC_VERSION}_linux_amd64.bz2"
  base_url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}"
  install_steps() {
    curl --fail --location --silent --show-error --retry 3 \
      --output "$work_dir/SHA256SUMS" "$base_url/SHA256SUMS"
    curl --fail --location --silent --show-error --retry 3 \
      --output "$work_dir/$archive" "$base_url/$archive"
    # Verify the downloaded archive's hash against its own line in the
    # signed-and-published manifest, not a hash this script hardcodes.
    (cd "$work_dir" && grep -F "  $archive" SHA256SUMS | sha256sum --check --status)
    bzip2 -d -k "$work_dir/$archive"
    chmod 0755 "${work_dir}/${archive%.bz2}"
    mv -f "${work_dir}/${archive%.bz2}" "$restic_bin"
  }
  run install_steps
fi

# --- Step 2: SSH config alias for the Storage Box's non-standard port ---
# Hetzner Storage Boxes serve SFTP on 23, not the SSH default of 22; restic's
# sftp backend shells out to the system `ssh`, which only reads the port from
# an ssh_config Host entry (or -p, which the sftp backend does not expose) --
# so an alias is the documented, supported way to reach it.
ssh_config_file="$ssh_config_dir/config"
alias_name="hetzner-storagebox"
config_block=$(
  cat <<EOF
Host ${alias_name}
  HostName ${storagebox_host}
  User ${storagebox_user}
  Port 23
  IdentityFile ${ssh_key_file}
  IdentitiesOnly yes
EOF
)

write_ssh_config() {
  mkdir -p "$ssh_config_dir"
  chmod 0700 "$ssh_config_dir"
  touch "$ssh_config_file"
  chmod 0600 "$ssh_config_file"
  tmp="$(mktemp)"
  # Idempotent: drop any prior managed block for this alias before
  # re-appending, same sentinel-block-replace shape as the LifeOS ops
  # console's crontab management.
  awk -v alias="Host ${alias_name}" '
    $0 == alias { skip = 1 }
    skip && /^Host / && $0 != alias { skip = 0 }
    !skip { print }
  ' "$ssh_config_file" > "$tmp"
  printf '%s\n' "$config_block" >> "$tmp"
  mv -f "$tmp" "$ssh_config_file"
  chmod 0600 "$ssh_config_file"
}
run write_ssh_config

# --- Step 3: idempotent restic init per repository ---
IFS=',' read -ra repo_list <<< "$repos"
for repo in "${repo_list[@]}"; do
  repository="sftp:${alias_name}:/${repo}"
  init_one() {
    if [[ -z "${RESTIC_PASSWORD:-}" ]]; then
      echo "error: RESTIC_PASSWORD must be set before --apply" >&2
      exit 1
    fi
    if "$restic_bin" cat config -r "$repository" >/dev/null 2>&1; then
      echo "restic repository '$repo' already initialized -- skipping"
    else
      "$restic_bin" init -r "$repository"
      echo "initialized restic repository '$repo' at $repository"
    fi
  }
  run init_one
done
