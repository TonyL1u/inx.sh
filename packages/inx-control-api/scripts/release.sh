#!/usr/bin/env bash
# Publish the INX Connect image: tag connect-v<version> from packages/inx-control-api/package.json and push it.
# CI (.github/workflows/connect.yml) runs the checks, builds amd64 + arm64, and pushes inxsh/inx-connect to Docker Hub.
# Bump the version in package.json and commit it first; then run: pnpm --filter @inx.sh/control-api release
# Re-running the same command republishes that version (moves the tag and pushes the image again).
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
version=$(node -p "require('./packages/inx-control-api/package.json').version")
num='(0|[1-9][0-9]*)'
[[ $version =~ ^$num\.$num\.$num(-beta\.$num)?$ ]] || { echo "Invalid version '$version': expected X.Y.Z or X.Y.Z-beta.N" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Working tree is not clean. Commit the version bump first.' >&2; exit 1; }
tag="connect-v$version"
git tag -d "$tag" >/dev/null 2>&1 || true
git push origin ":refs/tags/$tag" >/dev/null 2>&1 || true
git tag "$tag"
git push origin "$tag"
echo "==> Pushed tag $tag. CI is building inxsh/inx-connect:$version; watch it at https://github.com/TonyL1u/inx.sh/actions"
