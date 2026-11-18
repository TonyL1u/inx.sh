#!/usr/bin/env bash
# Binds a domain to this node the way 3x-ui itself does: x-ui.sh's "SSL Certificate Management → Get SSL (Domain)"
# (ssl_cert_issue in the v3.11.0 release script) followed by "Set Cert paths for the panel", without prompts.
# The result is ordinary x-ui state: the certificate is in /root/cert/<domain>/, acme.sh renews it with
# `x-ui restart`, and the panel settings point at it, so `sudo x-ui` shows and changes it like any other.
#
# Run as root by inx-gateway-domain.service when the unprivileged gateway writes its request file:
#   set <domain>   issue (or reuse) the certificate and set it for the panel
#   remove         reset the panel certificate (x-ui cert -reset); certificate files are kept, as x-ui does
set -uo pipefail

request=${1:?request file}
status=${2:?status file}
xui=${XUI_BIN:-/usr/local/x-ui/x-ui}
acme=${ACME_SH:-$HOME/.acme.sh/acme.sh}
certs=${XUI_CERT_DIR:-/root/cert}
log="${status%.json}.log"
domain=''

json() {
  local s
  s=$(printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# state: pending | issued | removed | failed; error: a DOMAIN_* code for the controller.
report() {
  local state=$1 error=${2:-} tail=''
  [[ -f "$log" ]] && tail=$(tail -n 30 "$log")
  printf '{"state":%s,"domain":%s,"error":%s,"log":%s,"updatedAt":%s}\n' "$(json "$state")" "$(json "$domain")" "$(json "$error")" "$(json "$tail")" "$(date +%s)" >"$status.tmp"
  chmod 0644 "$status.tmp"
  mv -f "$status.tmp" "$status"
}

fail() {
  echo "error: $2" >>"$log"
  report failed "$1"
  exit 1
}

# x-ui.sh is_domain
is_domain() { [[ "$1" =~ ^([A-Za-z0-9](-*[A-Za-z0-9])*\.)+(xn--[a-z0-9]{2,}|[A-Za-z]{2,})$ ]] && ((${#1} <= 253)); }

# x-ui.sh acme_listen_flag: acme.sh's standalone server binds IPv4 unless the host has no global IPv4.
acme_listen_flag() {
  if ip -4 addr show scope global 2>/dev/null | grep -q 'inet '; then echo ''; else echo '--listen-v6'; fi
}

# x-ui.sh's socat installation, by distribution.
install_socat() {
  command -v socat >/dev/null && return 0
  local release=''
  [[ -f /etc/os-release ]] && release=$(. /etc/os-release && echo "$ID")
  case "$release" in
    ubuntu | debian | armbian) apt-get update && apt-get install -y socat ;;
    fedora | amzn | virtuozzo | rhel | almalinux | rocky | ol) dnf makecache -y && dnf -y install socat ;;
    centos) if command -v dnf >/dev/null; then dnf -y install socat; else yum makecache -y && yum -y install socat; fi ;;
    arch | manjaro | parch) pacman -Sy --noconfirm socat ;;
    opensuse-tumbleweed | opensuse-leap) zypper refresh && zypper -q install -y socat ;;
    alpine) apk add socat curl openssl ;;
    *) return 1 ;;
  esac
}

: >"$log"
read -r action requested _ <"$request" || true

case "$action" in
  remove)
    report pending
    "$xui" cert -reset >>"$log" 2>&1 || fail DOMAIN_PANEL_FAILED 'x-ui cert -reset failed'
    systemctl restart x-ui >>"$log" 2>&1 || fail DOMAIN_PANEL_FAILED 'restarting x-ui failed'
    report removed
    exit 0
    ;;
  set) ;;
  *) fail DOMAIN_INVALID "unknown request: ${action:-empty}" ;;
esac

domain=${requested,,}
is_domain "$domain" || fail DOMAIN_INVALID "invalid domain: $domain"
report pending
echo "Binding $domain using 3x-ui's SSL certificate flow" >>"$log"

# HTTP-01 standalone validation needs port 80 for the duration of the issuance, as in x-ui.
if ss -Hltn 'sport = :80' 2>/dev/null | grep -q .; then
  fail DOMAIN_PORT_80_BUSY 'port 80 is in use; acme.sh needs it to validate the domain'
fi
resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
[[ -n "$resolved" ]] || fail DOMAIN_DNS_UNRESOLVED "$domain does not resolve to an IPv4 address"
echo "DNS: $domain -> $resolved" >>"$log"

if [[ ! -x "$acme" ]]; then
  echo 'Installing acme.sh' >>"$log"
  (cd ~ && curl -fsS https://get.acme.sh | sh) >>"$log" 2>&1 || fail DOMAIN_ACME_INSTALL_FAILED 'installing acme.sh failed'
fi
install_socat >>"$log" 2>&1 || fail DOMAIN_SOCAT_FAILED 'installing socat failed'

# Reuse a complete existing certificate; clean up partial acme.sh state (x-ui does the same).
acme_home=$(dirname "$acme")
reuse=0
if [[ -s "$acme_home/${domain}_ecc/fullchain.cer" && -s "$acme_home/${domain}_ecc/${domain}.key" ]] || [[ -s "$acme_home/$domain/fullchain.cer" && -s "$acme_home/$domain/$domain.key" ]]; then
  reuse=1
  echo "Reusing the existing certificate for $domain" >>"$log"
else
  rm -rf -- "${acme_home:?}/$domain" "${acme_home:?}/${domain}_ecc"
fi

if [[ $reuse == 0 ]]; then
  "$acme" --set-default-ca --server letsencrypt --force >>"$log" 2>&1
  # shellcheck disable=SC2046 # the flag is empty or one word
  if ! "$acme" --issue -d "$domain" $(acme_listen_flag) --standalone --httpport 80 --force >>"$log" 2>&1; then
    rm -rf -- "${acme_home:?}/$domain" "${acme_home:?}/${domain}_ecc"
    fail DOMAIN_ACME_FAILED 'issuing the certificate failed (is port 80 open to the internet and the A record pointing here?)'
  fi
fi

mkdir -p "$certs/$domain"
"$acme" --installcert --force -d "$domain" --key-file "$certs/$domain/privkey.pem" --fullchain-file "$certs/$domain/fullchain.pem" --reloadcmd 'x-ui restart' >>"$log" 2>&1
[[ -s "$certs/$domain/privkey.pem" && -s "$certs/$domain/fullchain.pem" ]] || fail DOMAIN_ACME_FAILED 'installing the certificate failed'
chmod 600 "$certs/$domain/privkey.pem"
chmod 644 "$certs/$domain/fullchain.pem"
"$acme" --upgrade --auto-upgrade >>"$log" 2>&1 || echo 'warning: enabling acme.sh auto-upgrade failed' >>"$log"

# x-ui's "Set Cert paths for the panel".
"$xui" cert -webCert "$certs/$domain/fullchain.pem" -webCertKey "$certs/$domain/privkey.pem" >>"$log" 2>&1 || fail DOMAIN_PANEL_FAILED 'setting the panel certificate failed'
systemctl restart x-ui >>"$log" 2>&1 || fail DOMAIN_PANEL_FAILED 'restarting x-ui failed'
echo "Done: the panel certificate is now $domain" >>"$log"
report issued
