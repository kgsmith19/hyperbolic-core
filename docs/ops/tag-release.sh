#!/usr/bin/env bash
# Tags a unit's exact deployed commit once its own deploy job succeeded --
# shared by deploy.yml and lifeos-deploy.yml so the tag format and
# idempotency logic exist in exactly one place. Never called directly by a
# human; invoked once per unit from each workflow's own "Tag successful
# releases" job, itself gated on the run's overall post-deploy smoke also
# having succeeded (that gating lives in the workflow, not here).
#
# A deploy job that internally rolled back to the previous release still
# reports its OWN job result as "failure" (GitHub Actions marks a job
# failed once any step fails, even when a later `if: failure()` rollback
# step recovers cleanly) -- so checking DEPLOY_RESULT == 'success' below is
# sufficient to satisfy "no tag on a rolled-back deploy"; no extra
# rollback-detection logic is needed on top of the job result GitHub
# Actions already computes.
set -euo pipefail

UNIT="${1:?usage: tag-release.sh <unit> <deploy-result> <sha>}"
DEPLOY_RESULT="${2:?usage: tag-release.sh <unit> <deploy-result> <sha>}"
SHA="${3:?usage: tag-release.sh <unit> <deploy-result> <sha>}"

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${REPO:?REPO must be set (owner/repo)}"

if [[ "$DEPLOY_RESULT" != "success" ]]; then
  echo "skip ${UNIT}: deploy result was '${DEPLOY_RESULT}', not success"
  exit 0
fi

# TAG_RELEASE_DATE lets tests inject a fixed date; unset (the only path a
# real workflow run takes) falls back to the real UTC date.
date_tag="${TAG_RELEASE_DATE:-$(date -u +%Y%m%d)}"
short_sha="${SHA:0:12}"
tag="deploy/${UNIT}/${date_tag}-${short_sha}"

status="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/git/refs/tags/${tag}")"

if [[ "$status" == "200" ]]; then
  echo "tag ${tag} already exists; skipping (idempotent)"
  exit 0
fi
if [[ "$status" != "404" ]]; then
  echo "::error::unexpected HTTP ${status} checking for tag ${tag}" >&2
  exit 1
fi

curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/git/refs" \
  -d "{\"ref\":\"refs/tags/${tag}\",\"sha\":\"${SHA}\"}" \
  > /dev/null

echo "tagged ${tag}"
