#!/usr/bin/env bash
# Run on the target architecture using the official Node Linux distribution.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repo"
gateway="$repo/packages/inx-gateway"
version=$(node -p "require('./packages/inx-gateway/package.json').version")
num='(0|[1-9][0-9]*)'
[[ $version =~ ^$num\.$num\.$num(-beta\.$num)?$ ]] || { echo 'Expected X.Y.Z or X.Y.Z-beta.N' >&2; exit 1; }
out=${1:-"$gateway/release/$version"}
mkdir -p "$out"; out=$(cd "$out" && pwd)
[[ $(uname -s) == Linux ]]
case "$(node -p process.arch)" in
  x64) arch=amd64 ;;
  arm64) arch=arm64 ;;
  *) echo 'Unsupported target' >&2; exit 1 ;;
esac
runtime=$(node -p 'process.execPath')
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
bundle="$stage/bundle"
mkdir -p "$bundle/runtime"
pnpm --filter '@inx.sh/gateway' build
pnpm --filter '@inx.sh/gateway' --prod deploy --legacy "$bundle/app"
install -m 0755 "$runtime" "$bundle/runtime/node"
install -m 0644 "$(dirname "$runtime")/../LICENSE" "$bundle/runtime/NODE-LICENSE"
cat >"$bundle/launch" <<'LAUNCH'
#!/bin/sh
set -eu
dir=$(dirname "$(readlink -f "$0")")
exec "$dir/runtime/node" "$dir/app/dist/index.js" "$@"
LAUNCH
chmod 0755 "$bundle/launch"
[[ $("$bundle/launch" --version) == "$version" ]]
asset="inx-gateway-$version-linux-$arch.tar.gz"
tar -czf "$out/$asset" -C "$bundle" .
(cd "$out" && sha256sum "$asset" > "$asset.sha256")
