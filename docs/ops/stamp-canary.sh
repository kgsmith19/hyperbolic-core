#!/usr/bin/env bash
# Stamps a unit's canary declaration onto its release tag (G2, issue #406) —
# the per-RELEASE half of the canary contract. tag-release.sh creates the
# release tag; this script attaches the canary descriptor that governs that
# release's observation window, so the tag itself carries the declaration
# the Mold's canary-missing HOLD rule evaluates.
#
# Mechanism: a GitHub Release anchored to the tag, named
# `canary/<unit>/<date>-<short-sha>`, whose body is the unit's canary
# descriptor verbatim plus the release SHA. The release is the
# per-release artifact: one exists if and only if the unit shipped in
# that run, and its body names the exact declaration in force.
#
# Idempotent: an existing canary release for the tag is left alone.
# Never called directly by a human; invoked once per unit from each
# pipeline's own tag-release job (deploy.yml, lifeos-deploy.yml), itself
# gated on the run's overall post-deploy smoke having succeeded.
set -euo pipefail

UNIT="${1:?usage: stamp-canary.sh <unit> <deploy-result> <sha>}"
DEPLOY_RESULT="${2:?usage: stamp-canary.sh <unit> <deploy-result> <sha>}"
SHA="${3:?usage: stamp-canary.sh <unit> <deploy-result> <sha>}"

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${REPO:?REPO must be set (owner/repo)}"

if [[ "$DEPLOY_RESULT" != "success" ]]; then
  echo "skip canary stamp for ${UNIT}: deploy result was '${DEPLOY_RESULT}', not success"
  exit 0
fi

# TAG_RELEASE_DATE lets tests inject a fixed date; unset (the only path a
# real workflow run takes) falls back to the real UTC date — the same
# convention tag-release.sh uses, so both names always agree.
date_tag="${TAG_RELEASE_DATE:-$(date -u +%Y%m%d)}"
short_sha="${SHA:0:12}"
tag="deploy/${UNIT}/${date_tag}-${short_sha}"
release_tag="canary/${UNIT}/${date_tag}-${short_sha}"
descriptor="docs/ops/canary/${UNIT}.canary.yml"

if [[ ! -f "$descriptor" ]]; then
  echo "::error::missing canary descriptor ${descriptor} for shipped unit ${UNIT}" >&2
  exit 1
fi

status="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/releases/tags/${release_tag}")"

if [[ "$status" == "200" ]]; then
  echo "canary release ${release_tag} already exists; skipping (idempotent)"
  exit 0
fi
if [[ "$status" != "404" ]]; then
  echo "::error::unexpected HTTP ${status} checking for canary release ${release_tag}" >&2
  exit 1
fi

# Build the release body with python3 for JSON-safe escaping (the Linux
# runner image ships python3; tag-release.sh's own inline-JSON style cannot
# carry a multi-line descriptor body safely).
CANARY_BODY="$(printf 'Canary declaration for release `%s` (commit `%s`).\n\nGoverning descriptor `%s` at the release commit, verbatim:\n\n```yaml\n%s\n```\n' "$tag" "$SHA" "$descriptor" "$(cat "$descriptor")")"
export CANARY_BODY CANARY_SHA="$SHA" CANARY_RELEASE_TAG="$release_tag" CANARY_TAG="$tag"
python3 - <<'PYEOF' > /tmp/canary-release-payload.json
import json, os
payload = {
    "tag_name": os.environ["CANARY_RELEASE_TAG"],
    "target_commitish": os.environ["CANARY_SHA"],
    "name": "Canary %s (%s)" % (os.environ["CANARY_TAG"], os.environ["CANARY_RELEASE_TAG"]),
    "body": os.environ["CANARY_BODY"],
    "draft": False,
    "prerelease": True,
}
print(json.dumps(payload))
PYEOF

curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/releases" \
  -d @/tmp/canary-release-payload.json \
  > /dev/null

echo "stamped canary release ${release_tag} for ${tag}"
