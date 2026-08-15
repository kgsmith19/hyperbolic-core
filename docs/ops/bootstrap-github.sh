#!/usr/bin/env bash
# GitHub-side production bootstrap (m1-13). Sets every repository variable
# runbook.md's deploy/backup/migration sections require, plus (optionally)
# main's branch protection and the DEPLOY_ENABLED/PLATFORM_BACKUP_ENABLED
# go-live switches. Run ONCE, locally, with `gh auth login` already done as
# an account holding admin on the repo.
#
# Everything here is a `gh` call against values YOU already hold (Infisical
# identity ids from creating the machine identities, DEPLOY_HOST from the
# VPS, the age recipient from generating the backup keypair) -- this script
# does not create or know any secret material itself.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: bootstrap-github.sh [--dry-run|--apply] --repo=OWNER/REPO [options]

Required:
  --repo=OWNER/REPO
  --deploy-host=HOST
  --infisical-project-slug=SLUG
  --infisical-shell-deploy-identity=ID
  --infisical-llm-handler-deploy-identity=ID
  --infisical-brain-deploy-identity=ID
  --infisical-platform-migrations-identity=ID
  --infisical-platform-backup-identity=ID
  --platform-age-public-key=age1...

Optional go-live switches (off by default -- variables are set either way,
these two just flip the gates deploy.yml/platform-backup.yml check):
  --enable-deploy      also sets DEPLOY_ENABLED=true
  --enable-backup      also sets PLATFORM_BACKUP_ENABLED=true

Optional:
  --branch-protection  also require Toolbelt/ACC/Shell PR Gate on main
                        (runbook.md's own acceptance criterion for this issue)
  --dry-run            Print every `gh` call this script would make. Default.
  --apply               Run for real.
EOF
}

mode="--dry-run"
repo="" deploy_host="" project_slug=""
shell_id="" llm_handler_id="" brain_id="" migrations_id="" backup_id=""
age_key=""
enable_deploy=0 enable_backup=0 branch_protection=0

for arg in "$@"; do
  case "$arg" in
    --dry-run | --apply) mode="$arg" ;;
    --repo=*) repo="${arg#--repo=}" ;;
    --deploy-host=*) deploy_host="${arg#--deploy-host=}" ;;
    --infisical-project-slug=*) project_slug="${arg#--infisical-project-slug=}" ;;
    --infisical-shell-deploy-identity=*) shell_id="${arg#--infisical-shell-deploy-identity=}" ;;
    --infisical-llm-handler-deploy-identity=*) llm_handler_id="${arg#--infisical-llm-handler-deploy-identity=}" ;;
    --infisical-brain-deploy-identity=*) brain_id="${arg#--infisical-brain-deploy-identity=}" ;;
    --infisical-platform-migrations-identity=*) migrations_id="${arg#--infisical-platform-migrations-identity=}" ;;
    --infisical-platform-backup-identity=*) backup_id="${arg#--infisical-platform-backup-identity=}" ;;
    --platform-age-public-key=*) age_key="${arg#--platform-age-public-key=}" ;;
    --enable-deploy) enable_deploy=1 ;;
    --enable-backup) enable_backup=1 ;;
    --branch-protection) branch_protection=1 ;;
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

missing=()
[[ -n "$repo" ]] || missing+=(--repo)
[[ -n "$deploy_host" ]] || missing+=(--deploy-host)
[[ -n "$project_slug" ]] || missing+=(--infisical-project-slug)
[[ -n "$shell_id" ]] || missing+=(--infisical-shell-deploy-identity)
[[ -n "$llm_handler_id" ]] || missing+=(--infisical-llm-handler-deploy-identity)
[[ -n "$brain_id" ]] || missing+=(--infisical-brain-deploy-identity)
[[ -n "$migrations_id" ]] || missing+=(--infisical-platform-migrations-identity)
[[ -n "$backup_id" ]] || missing+=(--infisical-platform-backup-identity)
[[ -n "$age_key" ]] || missing+=(--platform-age-public-key)
if ((${#missing[@]} > 0)); then
  printf 'error: missing required flags:%s\n' "$(printf ' %s' "${missing[@]}")" >&2
  usage
  exit 2
fi

print_cmd() {
  printf '+ %q' "$1"
  shift
  printf ' %q' "$@"
  printf '\n'
}

run() {
  if [[ "$mode" == "--dry-run" ]]; then
    print_cmd "$@"
  else
    print_cmd "$@"
    "$@"
  fi
}

set_var() {
  run gh variable set "$1" --repo "$repo" --body "$2"
}

set_var DEPLOY_HOST "$deploy_host"
set_var INFISICAL_PROJECT_SLUG "$project_slug"
set_var INFISICAL_SHELL_DEPLOY_IDENTITY_ID "$shell_id"
set_var INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID "$llm_handler_id"
set_var INFISICAL_BRAIN_DEPLOY_IDENTITY_ID "$brain_id"
set_var INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID "$migrations_id"
set_var INFISICAL_PLATFORM_BACKUP_IDENTITY_ID "$backup_id"
set_var PLATFORM_AGE_PUBLIC_KEY "$age_key"

if ((enable_deploy)); then
  set_var DEPLOY_ENABLED true
fi
if ((enable_backup)); then
  set_var PLATFORM_BACKUP_ENABLED true
fi

if ((branch_protection)); then
  protection_body=$(cat <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Toolbelt PR Gate", "ACC PR Gate", "Shell PR Gate"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
  )
  if [[ "$mode" == "--dry-run" ]]; then
    print_cmd gh api --method PUT "repos/$repo/branches/main/protection" --input -
    echo "$protection_body"
  else
    print_cmd gh api --method PUT "repos/$repo/branches/main/protection" --input -
    echo "$protection_body" | gh api --method PUT "repos/$repo/branches/main/protection" --input -
  fi
fi
