#!/usr/bin/env bash
# Fresh installs only. Never run an upstream installer over an existing panel.
set -euo pipefail
umask 077
source /etc/os-release
[[ $EUID == 0 && $ID == debian && ($VERSION_ID == 12 || $VERSION_ID == 13) ]] || { echo 'Requires Debian 12/13 and root.' >&2; exit 1; }
for cmd in systemctl tar curl openssl sha256sum; do command -v "$cmd" >/dev/null; done
for path in /usr/local/x-ui /etc/x-ui /etc/default/x-ui /usr/bin/x-ui /etc/systemd/system/x-ui.service; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Existing $path; refusing fresh install." >&2; exit 1; }
done
if systemctl cat x-ui.service >/dev/null 2>&1; then echo 'Existing x-ui unit; refusing install.' >&2; exit 1; fi
if command -v x-ui >/dev/null; then echo 'Found an existing x-ui command. Automatic setup requires a native installation in /usr/local/x-ui.' >&2; exit 1; fi
for engine in docker podman; do
  command -v "$engine" >/dev/null || continue
  containers=$("$engine" ps -a --format '{{.Image}} {{.Names}}') || { echo "Cannot inspect $engine containers; check for an existing panel before installing." >&2; exit 1; }
  if grep -Eiq '(^|[/ :_-])(3x-ui|x-ui)([/ :_@.-]|$)' <<<"$containers"; then
    echo "Found an existing panel container. Automatic setup does not support container panels." >&2; exit 1
  fi
done
case "$(uname -m)" in
  x86_64) arch=amd64; sha=0ddfa4702f595442e2962acd81addc768fdacaa4ff2672c971a0463dae744916 ;;
  aarch64) arch=arm64; sha=f50b4c30fd919d018f2f4c3d8db53a4ca027503d581328727770afb116a79d90 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
stage=$(mktemp -d /usr/local/.inx-panel.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --max-time 180 "https://github.com/MHSanaei/3x-ui/releases/download/v3.11.0/x-ui-linux-$arch.tar.gz" -o "$stage/release.tgz"
cd "$stage"
echo "$sha  release.tgz" | sha256sum --check --status
tar --no-same-owner -xzf release.tgz
[[ -f x-ui/x-ui && -f "x-ui/bin/xray-linux-$arch" ]]
chmod +x x-ui/x-ui "x-ui/bin/xray-linux-$arch"
unit=x-ui.service.debian
[[ -f "x-ui/$unit" ]] || unit=x-ui.service
[[ -f "x-ui/$unit" ]]
mv -T x-ui /usr/local/x-ui
cd /usr/local/x-ui
listen=$(./x-ui setting -listenIP 127.0.0.1 -webBasePath "/$(openssl rand -hex 12)/" -getListen)
grep -Eq '^listenIP: 127\.0\.0\.1$' <<<"$listen" || { echo 'Cannot verify loopback binding; panel not started.' >&2; exit 1; }
install -m 0644 "$unit" /etc/systemd/system/x-ui.service
install -d -m 0755 /etc/systemd/system/x-ui.service.d /var/log/x-ui
printf '[Service]\nReadWritePaths=-/etc/x-ui -/var/log/x-ui\n' >/etc/systemd/system/x-ui.service.d/10-inx-paths.conf
systemctl daemon-reload
systemctl enable --now x-ui
