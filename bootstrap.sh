#!/usr/bin/env bash
# INX Gateway installer, served at https://inx.sh/bootstrap.
#   curl -fsSL https://inx.sh/bootstrap | sudo bash                           # latest stable release
#   curl -fsSL https://inx.sh/bootstrap | sudo bash -s -- --version 0.1.0     # pin a release (stable or beta)
set -euo pipefail

repo=https://github.com/TonyL1u/inx.sh

usage() { echo 'Usage: bootstrap [--version X.Y.Z[-beta.N]]' >&2; }

latest() {
  local url
  # Only the Gateway publishes GitHub Releases in this repository, so "latest" is the newest stable Gateway.
  url=$(curl --proto '=https' --proto-redir '=https' -fsSLI --retry 2 --max-time 30 -o /dev/null -w '%{url_effective}' "$repo/releases/latest") || { echo 'Cannot look up the latest Gateway release.' >&2; return 1; }
  echo "${url##*/}"
}

main() {
  local version=${INX_GATEWAY_VERSION:-} arch asset base stage sum digest release link=/usr/local/bin/inx-gateway
  local num='(0|[1-9][0-9]*)'
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) [[ $# -ge 2 ]] || { usage; return 1; }; version=$2; shift 2 ;;
      --version=*) version=${1#*=}; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "Unknown argument: $1" >&2; usage; return 1 ;;
    esac
  done
  [[ $(id -u) == 0 ]] || { echo 'Run bootstrap as root.' >&2; return 1; }
  [[ $(uname -s) == Linux ]] || { echo 'Linux is required.' >&2; return 1; }
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'Supported architectures: amd64 and arm64.' >&2; return 1 ;;
  esac
  if [[ -z "$version" ]]; then
    version=$(latest)
    [[ $version =~ ^$num\.$num\.$num$ ]] || { echo 'No stable Gateway release found. Pass --version to choose one.' >&2; return 1; }
  fi
  [[ $version =~ ^$num\.$num\.$num(-beta\.$num)?$ ]] || { echo "Invalid Gateway version: $version" >&2; return 1; }
  if [[ -e "$link" || -L "$link" ]] && [[ $(readlink "$link" || true) != /opt/inx-gateway/current/launch ]]; then
    echo "Existing $link is not managed by bootstrap; refusing to overwrite it." >&2; return 1
  fi
  echo "Installing INX Gateway $version ($arch)" >&2
  asset="inx-gateway-$version-linux-$arch.tar.gz"
  base="$repo/releases/download/$version"
  umask 022
  install -d -m 0755 /opt/inx-gateway/releases /usr/local/bin
  stage=$(mktemp -d /opt/inx-gateway/.install.XXXXXXXX)
  # stage is exclusively ours; always remove incomplete downloads.
  trap "rm -rf -- '$stage'" EXIT
  for file in "$asset" "$asset.sha256"; do
    curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --max-time 180 "$base/$file" -o "$stage/$file"
  done
  read -r sum _ < "$stage/$asset.sha256"
  [[ "$sum" =~ ^[[:xdigit:]]{64}$ ]] || { echo 'Invalid release checksum.' >&2; return 1; }
  digest=$(sha256sum "$stage/$asset"); digest=${digest%% *}
  [[ "$digest" == "$sum" ]] || { echo 'Release checksum mismatch.' >&2; return 1; }
  release="/opt/inx-gateway/releases/$version-$arch-$digest"
  if [[ ! -d "$release" ]]; then
    mkdir "$stage/bundle"
    tar --no-same-owner -xzf "$stage/$asset" -C "$stage/bundle"
    [[ $("$stage/bundle/launch" --version) == "$version" ]] || { echo 'Gateway runtime check failed.' >&2; return 1; }
    mv -T "$stage/bundle" "$release"
  fi
  ln -s "$release" "$stage/current"
  mv -Tf "$stage/current" /opt/inx-gateway/current
  if [[ ! -L "$link" ]]; then ln -s /opt/inx-gateway/current/launch "$link"; fi
  "$link" start
}

# Wrapped in main so a truncated download never runs a partial script.
main "$@"
