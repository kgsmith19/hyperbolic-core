#!/usr/bin/env bash
# Local stand-in for .github/workflows/release.yml's build-and-verify-image
# job, which now runs on workflow_dispatch only (see .github/workflows/README.md)
# so a tag push alone no longer spends Actions minutes. Use this to build and
# smoke-test the release image without touching GitHub Actions at all; use
# the "Release" workflow's manual dispatch only when you actually want the
# published GitHub Release + downloadable artifact.
#
# Usage: bash tools/deploy.sh [version]
#   version defaults to the current netcheck/__init__.py __version__,
#   prefixed with 'v' (e.g. v1.4.0) to match this project's tag convention.
set -eu
cd "$(dirname "$0")/.."

VERSION="${1:-v$(python3 -c "import re; print(re.search(r'__version__ = \"(.+)\"', open('netcheck/__init__.py').read()).group(1))")}"
IMAGE="netcheck:${VERSION}"

echo "=== Running local checks first (tools/check.sh) ==="
bash tools/check.sh

echo "=== Building $IMAGE ==="
docker build -t "$IMAGE" .

echo "=== Smoke test: --version ==="
docker run --rm "$IMAGE" --version

echo "=== Smoke test: full-check --format quick ==="
docker run --rm "$IMAGE" full-check --format quick

ARTIFACT="netcheck-image-${VERSION}.tar.gz"
echo "=== Saving image to $ARTIFACT ==="
docker save "$IMAGE" | gzip > "$ARTIFACT"

echo
echo "Built and smoke-tested $IMAGE -> $ARTIFACT"
echo
echo "Next steps to publish a GitHub Release (only if you want one):"
echo "  git tag $VERSION && git push origin $VERSION"
if command -v gh >/dev/null 2>&1; then
    echo "  gh release create $VERSION $ARTIFACT --draft --notes-from-tag"
else
    echo "  Then create a draft release on GitHub and attach $ARTIFACT manually"
    echo "  (gh CLI not found; install it or use the GitHub web UI)."
fi
echo
echo "Or run the 'Release' workflow's manual dispatch from the Actions tab"
echo "if you'd rather have CI do the publish step (uses Actions minutes)."
