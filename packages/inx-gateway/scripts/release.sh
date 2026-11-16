#!/usr/bin/env bash
# Publish a Gateway release: tag the version from packages/inx-gateway/package.json and push it.
# CI (.github/workflows/release.yml) runs the tests, builds both architectures, and creates the release.
# Bump the version in package.json and commit it first; then run: pnpm --filter @inx.sh/gateway release
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
version=$(node -p "require('./packages/inx-gateway/package.json').version")
num='(0|[1-9][0-9]*)'
[[ $version =~ ^$num\.$num\.$num(-beta\.$num)?$ ]] || { echo "Invalid version '$version': expected X.Y.Z or X.Y.Z-beta.N" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Working tree is not clean. Commit the version bump first.' >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
  echo "Tag $version already exists. Bump the version in packages/inx-gateway/package.json, commit, then retry." >&2
  exit 1
fi
git tag "$version"
git push origin "$version"
echo "==> Pushed tag $version. CI is building the release; watch it at https://github.com/TonyL1u/inx.sh/actions"
