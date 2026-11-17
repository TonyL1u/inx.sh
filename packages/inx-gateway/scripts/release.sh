#!/usr/bin/env bash
# Publish a Gateway release: tag the version from packages/inx-gateway/package.json and push it.
# CI (.github/workflows/gateway.yml) runs the tests, builds both architectures, and creates the release.
# Bump the version in package.json and commit it first; then run: pnpm --filter @inx.sh/gateway release
# Re-running the same command republishes that version (moves the tag and replaces the release).
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
version=$(node -p "require('./packages/inx-gateway/package.json').version")
num='(0|[1-9][0-9]*)'
[[ $version =~ ^$num\.$num\.$num(-beta\.$num)?$ ]] || { echo "Invalid version '$version': expected X.Y.Z or X.Y.Z-beta.N" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Working tree is not clean. Commit the version bump first.' >&2; exit 1; }
# Retrying a failed publish is the same command: move the tag to the current commit and push again.
git tag -d "$version" >/dev/null 2>&1 || true
git push origin ":refs/tags/$version" >/dev/null 2>&1 || true
git tag "$version"
git push origin "$version"
echo "==> Pushed tag $version. CI is building the release; watch it at https://github.com/TonyL1u/inx.sh/actions"
