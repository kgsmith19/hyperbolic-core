#!/usr/bin/env bash
# Local stand-in for the Toolbelt root Network Checker Release workflow, which
# runs only when manually dispatched. Use this to build and smoke-test without
# spending Actions minutes; dispatch the workflow only when you want a draft
# GitHub Release and downloadable artifact.
#
# Usage: bash tools/deploy.sh [version]
#   version defaults to the current network_checker/__init__.py __version__,
#   prefixed with 'v' (e.g. v1.4.0). Git tags add `network-checker-` so they
#   cannot collide with another Toolbelt application.
set -eu
cd "$(dirname "$0")/.."

VERSION="${1:-v$(python3 -c "import re; print(re.search(r'__version__ = \"(.+)\"', open('network_checker/__init__.py').read()).group(1))")}"
IMAGE="network-checker:${VERSION}"

echo "=== Running local checks first (tools/check.sh) ==="
bash tools/check.sh

echo "=== Building $IMAGE ==="
docker build -t "$IMAGE" .

echo "=== Smoke test: --version ==="
docker run --rm "$IMAGE" --version

echo "=== Smoke test: scan ==="
docker run --rm "$IMAGE" scan

ARTIFACT="network-checker-image-${VERSION}.tar.gz"
TAG="network-checker-${VERSION}"
echo "=== Saving image to $ARTIFACT ==="
docker save "$IMAGE" | gzip > "$ARTIFACT"

echo
echo "Built and smoke-tested $IMAGE -> $ARTIFACT"
echo
echo "Next steps to publish a GitHub Release (only if you want one):"
echo "  git tag $TAG && git push origin $TAG"
if command -v gh >/dev/null 2>&1; then
    echo "  gh release create $TAG $ARTIFACT --draft --notes-from-tag"
else
    echo "  Then create a draft release on GitHub and attach $ARTIFACT manually"
    echo "  (gh CLI not found; install it or use the GitHub web UI)."
fi
echo
echo "Or run the 'Network Checker Release' workflow from the Actions tab"
echo "if you'd rather have CI do the publish step (uses Actions minutes)."
