#!/usr/bin/env bash
# Run in a disposable Debian 12 container with the local release mounted at /release
# and the repository's bootstrap.sh mounted at /bootstrap.sh.
set -euo pipefail
umask 077
for cmd in node npm; do
  if command -v "$cmd"; then echo "Expected base image without $cmd" >&2; exit 1; fi
done
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends ca-certificates curl openssl >/dev/null
case "$(uname -m)" in
  x86_64) panel_arch=amd64 ;;
  aarch64) panel_arch=arm64 ;;
  *) exit 1 ;;
esac
bundles=(/release/inx-gateway-*-linux-"$panel_arch".tar.gz)
[[ ${#bundles[@]} == 1 && -f ${bundles[0]} ]]
asset=${bundles[0]##*/}
v=${asset#inx-gateway-}
export EXPECTED_TAG=${v%-linux-"$panel_arch".tar.gz}
mkdir /tmp/test-bin /tmp/bad-release
# Serve only the Gateway release from disk; the panel download still uses curl.
cat >/tmp/test-bin/curl <<'CURL'
#!/bin/bash
set -eu
for arg; do
  case "$arg" in
    https://github.com/TonyL1u/inx.sh/releases/download/"$EXPECTED_TAG"/*)
      cp -- "/tmp/test-release/${arg##*/}" "${!#}"; exit ;;
    https://github.com/TonyL1u/inx.sh/releases/download/*) echo 'Wrong release tag' >&2; exit 1 ;;
  esac
done
exec /usr/bin/curl "$@"
CURL
chmod +x /tmp/test-bin/curl
export PATH=/tmp/test-bin:$PATH
ln -s /tmp/bad-release /tmp/test-release
ln -s "/release/$asset" "/tmp/bad-release/$asset"
printf '%064d  %s\n' 0 "$asset" > "/tmp/bad-release/$asset.sha256"
if bash /bootstrap.sh unexpected >/dev/null 2>/tmp/rejected; then exit 1; fi
grep -q 'Unknown argument' /tmp/rejected
if bash /bootstrap.sh --version 1.0 >/dev/null 2>/tmp/rejected; then exit 1; fi
grep -q 'Invalid Gateway version' /tmp/rejected
bootstrap() { bash /bootstrap.sh --version "$EXPECTED_TAG"; }
if bootstrap >/dev/null 2>/tmp/rejected; then exit 1; fi
grep -q 'checksum mismatch' /tmp/rejected
[[ ! -e /usr/local/bin/inx-gateway ]]
# This container has no systemd PID 1. Exercise service-mode setup while a
# systemctl test double starts the real panel and runs the generated ExecStart.
ln -sfn /release /tmp/test-release
# Model the one public interface of a VPS on Docker's private bridge.
cat >/tmp/test-network.cjs <<'NETWORK'
require('node:os').networkInterfaces = () => ({ eth0: [{ family: 'IPv4', address: '198.51.100.42', internal: false }], docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }] });
require('node:module').syncBuiltinESMExports();
NETWORK
export NODE_OPTIONS=--require=/tmp/test-network.cjs
cat >/tmp/test-bin/systemctl <<'SYSTEMCTL'
#!/bin/bash
set -eu
case "$*" in
  'cat x-ui.service') test -e /etc/systemd/system/x-ui.service ;;
  'daemon-reload'|'enable inx-gateway') ;;
  'enable --now x-ui')
    echo install >> /tmp/panel-installs
    (cd /usr/local/x-ui && exec ./x-ui) </dev/null >/tmp/panel.log 2>&1 & ;;
  'restart inx-gateway')
    if [[ -f /tmp/gateway.pid ]]; then
      kill "$(cat /tmp/gateway.pid)"
      for i in $(seq 1 50); do curl -ksf https://127.0.0.1:3101/health >/dev/null || break; sleep .1; done
    fi
    read -ra start <<<"$(sed -n 's/^ExecStart=//p' /etc/systemd/system/inx-gateway.service)"
    "${start[@]}" </dev/null >/tmp/gateway.log 2>&1 & echo $! >/tmp/gateway.pid ;;
  *) echo "Unexpected systemctl invocation: $*" >&2; exit 1 ;;
esac
SYSTEMCTL
chmod +x /tmp/test-bin/systemctl
# A failed or partial installation must not be treated as an empty VPS.
mkdir /etc/x-ui
if bootstrap >/tmp/out 2>/tmp/diagnostic; then exit 1; fi
grep -q 'Existing /etc/x-ui' /tmp/diagnostic
[[ ! -e /usr/local/x-ui ]]
rmdir /etc/x-ui
bootstrap >/tmp/pair
before=$(stat -c '%i:%Y' /usr/local/x-ui/x-ui)
bootstrap >/tmp/pair-again
[[ $(stat -c '%i:%Y' /usr/local/x-ui/x-ui) == "$before" && $(wc -l </tmp/panel-installs) == 1 ]]
cmp /tmp/pair /tmp/pair-again
# The panel's own management menu is installed like the upstream installer does.
[[ -x /usr/bin/x-ui ]] && cmp /usr/bin/x-ui /usr/local/x-ui/x-ui.sh
inx-gateway pair | cmp - /tmp/pair
/opt/inx-gateway/current/runtime/node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {get} from 'node:https';
import {checkServerIdentity, connect} from 'node:tls';
import {parsePair} from '/opt/inx-gateway/current/app/dist/config.js';
const code = readFileSync('/tmp/pair', 'utf8').trim();
if (code.length >= 100) throw Error('Pairing code is too long');
const p = parsePair(code);
if (p.endpoint !== 'https://198.51.100.42:3101') throw Error('Incorrect advertised endpoint');
const socket = connect({host: '127.0.0.1', port: 3101, rejectUnauthorized: false}, () => {
  const cert = socket.getPeerX509Certificate();
  socket.destroy();
  if (createHash('sha256').update(cert.raw).digest('base64url') !== p.pin) throw Error('Certificate does not match the pairing code');
  get('https://127.0.0.1:3101/v1/inbounds', {ca:cert.toString(), checkServerIdentity: (_, c) => checkServerIdentity('198.51.100.42', c), headers:{authorization:'Bearer '+p.token}}, res=>{
    let body=''; res.on('data',chunk=>body+=chunk);
    res.on('end',()=>{ if(res.statusCode!==200 || !Array.isArray(JSON.parse(body).inbounds)) throw Error('Pairing probe failed'); });
  });
});
JS
for cmd in node npm; do if command -v "$cmd"; then exit 1; fi; done
echo 'PASS: bootstrap verified checksum, installed and paired twice, and served the panel over TLS without system node or npm.'
