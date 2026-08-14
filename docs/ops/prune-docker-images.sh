#!/usr/bin/env bash
# Prunes old sha-tagged Docker images for one deployable unit on a deploy
# host, keeping the newest N, for docs/planning/10-cicd-deployment.md
# section 8.3 ("keep newest 3 images") and section 8.3b (identical rule for
# Handler A). Both deploy-brain and deploy-llm-handler run this same file
# over ssh after a successful `docker compose up -d --wait` -- one script,
# not duplicated per-unit branching logic in YAML, the same reasoning
# prune-dist-dirs.sh's own header comment gives for the Shell unit.
#
# WHY ITS OWN SCRIPT, NOT AN INLINE `run:` STEP: same as prune-dist-dirs.sh
# -- an off-by-one here either deletes an image a human just manually
# rolled back to (section 8.3's `BRAIN_IMAGE`/`LLM_HANDLER_IMAGE` .env
# repoint), silently undoing their rollback the next time a deploy runs
# this script, or never deletes anything, leaking disk forever. Real
# branching logic gets a real red/green test
# (prune-docker-images.test.mjs, against a stubbed `docker` on PATH --
# no real Docker daemon required, no real daemon exists in this sandbox
# either).
#
# CONTRACT:
#   - Keeps the newest <keep-count> "<image-repo>:sha-*" images by Docker's
#     own reported creation time (default 3).
#   - ALSO always keeps <protect-ref> (the image this deploy just loaded and
#     activated), even if it falls outside the newest-<keep-count> window --
#     mirrors prune-dist-dirs.sh's "always keep whatever `current` points
#     at" rule, for the same rollback-safety reason (section 8.3: an
#     operator may have manually repointed the unit's `.env` to an older
#     sha tag; a deploy re-running this script afterward must not delete
#     the tag the rollback depends on).
#   - Never touches ":main" or any other non-sha-* tag of the same repo.
#   - No-op (nothing deleted) when there are <= <keep-count> matching images.
#
# Usage: prune-docker-images.sh <image-repo> <protect-ref> [keep-count]
#   image-repo:  e.g. ghcr.io/kgsmith19/hyperbolic-core/brain
#   protect-ref: the full "<image-repo>:sha-<...>" reference this deploy
#                just activated; always survives pruning
#   keep-count:  defaults to 3

set -euo pipefail

usage() {
  echo "usage: $0 <image-repo> <protect-ref> [keep-count]" >&2
}

if (( $# < 2 || $# > 3 )); then
  usage
  exit 2
fi

image_repo="$1"
protect_ref="$2"
keep="${3:-3}"

if [[ -z "$image_repo" ]]; then
  echo "error: image-repo must not be empty" >&2
  exit 1
fi

case "$keep" in
  '' | *[!0-9]*)
    echo "error: keep-count must be a non-negative integer, got: $keep" >&2
    exit 1
    ;;
esac

# Newest-first by Docker's own creation timestamp (an ISO-ordered string,
# so a plain reverse lexicographic sort is already a correct chronological
# sort -- `docker image ls --format` is the source of truth here, the
# closest analogue to prune-dist-dirs.sh's own `find -printf '%T@'` for a
# real filesystem).
escaped_repo="${image_repo//./\\.}"
mapfile -t refs < <(
  docker image ls --format $'{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' "$image_repo" \
    | grep -E $'\t'"${escaped_repo}:sha-" \
    | sort -r \
    | cut -f2
)

keep_set=()
for i in "${!refs[@]}"; do
  if (( i < keep )); then
    keep_set+=("${refs[$i]}")
  fi
done

already_kept=0
for k in "${keep_set[@]:-}"; do
  if [[ "$k" == "$protect_ref" ]]; then
    already_kept=1
    break
  fi
done
if [[ "$already_kept" -eq 0 && "$protect_ref" == "$image_repo":sha-* ]]; then
  keep_set+=("$protect_ref")
fi

pruned_any=0
for ref in "${refs[@]:-}"; do
  [[ -z "$ref" ]] && continue
  should_keep=0
  for k in "${keep_set[@]:-}"; do
    if [[ "$ref" == "$k" ]]; then
      should_keep=1
      break
    fi
  done
  if [[ "$should_keep" -eq 0 ]]; then
    echo "pruning $ref"
    docker rmi -- "$ref"
    pruned_any=1
  fi
done

if [[ "$pruned_any" -eq 0 ]]; then
  echo "nothing to prune"
fi
