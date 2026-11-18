#!/usr/bin/env bash
# INX Connect (controller) installer, served at https://inx.sh/connect.
#   curl -fsSL https://inx.sh/connect | sudo bash
#
# Like x-ui, the controller listens on a public HTTP port right away; add a domain and HTTPS later with
#   sudo inx-connect domain
# Options (remembered in /opt/inx-connect/.env, so reruns only need what changes):
#   --version TAG   Image tag: latest (default), beta, or an exact version such as 0.1.0
#   --image REPO    Image repository, e.g. a registry mirror (default inxsh/inx-connect)
#   --port N        Port the controller listens on (default 3100)
# Rerunning the installer upgrades in place and keeps data, the secret key and the domain.
set -euo pipefail

dir=/opt/inx-connect
uid=1000 # the image's "node" user

die() { echo "error: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: curl -fsSL https://inx.sh/connect | sudo bash -s -- [options]
  --version TAG   Image tag: latest (default), beta, or an exact version such as 0.1.0
  --image REPO    Image repository, e.g. a registry mirror (default inxsh/inx-connect)
  --port N        Port the controller listens on (default 3100)
After installing: sudo inx-connect domain   (HTTPS with a domain, the way x-ui sets up SSL)
USAGE
}

# Read KEY=VALUE from .env without executing it.
env_get() { [[ -f "$dir/.env" ]] && sed -n "s/^$1=//p" "$dir/.env" | tail -n1 || true; }

main() {
  local version='' image='' port=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) [[ $# -ge 2 ]] || die '--version needs a value'; version=$2; shift 2 ;;
      --version=*) version=${1#*=}; shift ;;
      --image) [[ $# -ge 2 ]] || die '--image needs a value'; image=$2; shift 2 ;;
      --image=*) image=${1#*=}; shift ;;
      --port) [[ $# -ge 2 ]] || die '--port needs a value'; port=$2; shift 2 ;;
      --port=*) port=${1#*=}; shift ;;
      --domain | --domain=* | --no-domain | --caddy-image | --caddy-image=*) die "$1 was removed. Install without it, then run: sudo inx-connect domain" ;;
      -h|--help) usage; return 0 ;;
      *) die "Unknown argument: $1 (see --help)" ;;
    esac
  done

  [[ $(id -u) == 0 ]] || die 'Run the installer as root (sudo).'
  [[ $(uname -s) == Linux ]] || die 'Linux is required.'
  command -v docker >/dev/null || die 'Docker is required. Install Docker Engine first: https://docs.docker.com/engine/install/'
  docker compose version >/dev/null 2>&1 || die 'The Docker Compose plugin is required: https://docs.docker.com/compose/install/linux/'
  docker info >/dev/null 2>&1 || die 'Cannot reach the Docker daemon. Is it running?'

  install -d -m 0755 "$dir"
  local first=1; [[ -f "$dir/.env" ]] && first=0

  image=${image:-$(env_get INX_IMAGE)}; image=${image:-inxsh/inx-connect}
  version=${version:-$(env_get INX_VERSION)}; version=${version:-latest}
  port=${port:-$(env_get INX_PORT)}; port=${port:-3100}
  [[ $image =~ ^[a-z0-9]([a-z0-9._/:-]*[a-z0-9])?$ ]] || die "Invalid image repository: $image"
  [[ $version =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "Invalid image tag: $version"
  [[ $port =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || die "Invalid port: $port"

  # Kept from `inx-connect domain`; a port change carries over into the public URL.
  local domain public_url legacy
  domain=$(env_get INX_CERT_DOMAIN)
  public_url=''
  [[ -n $domain ]] && public_url="https://$domain:$port"
  legacy=$(env_get INX_DOMAIN) # set by installers that bundled Caddy

  local secret; secret=$(env_get INX_SECRET_KEY)
  if [[ -z $secret ]]; then
    secret=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    [[ ${#secret} == 64 ]] || die 'Could not generate a secret key.'
  fi

  # .env holds the only copy of the key that encrypts stored credentials. Back it up with data/.
  umask 077
  cat >"$dir/.env.tmp" <<ENV
# INX Connect settings, written by the installer and inx-connect. Back up this file together with data/.
INX_IMAGE=$image
INX_VERSION=$version
INX_PORT=$port
INX_SECRET_KEY=$secret
INX_CERT_DOMAIN=$domain
INX_PUBLIC_URL=$public_url
ENV
  mv -f "$dir/.env.tmp" "$dir/.env"
  umask 022

  {
    echo '# Managed by the INX Connect installer; rerun it instead of editing. Settings live in .env.'
    echo 'services:'
    echo '  inx-connect:'
    echo '    image: ${INX_IMAGE}:${INX_VERSION}'
    echo '    container_name: inx-connect'
    echo '    restart: unless-stopped'
    echo '    environment:'
    echo '      INX_SECRET_KEY: ${INX_SECRET_KEY}'
    echo '      INX_PUBLIC_URL: ${INX_PUBLIC_URL:-}'
    echo '    volumes:'
    echo '      - ./data:/data'
    echo '      - ./cert:/cert:ro'
    echo '    ports:'
    echo "      - '\${INX_PORT}:3100'"
  } >"$dir/compose.yaml"
  rm -f "$dir/Caddyfile"
  install -d -m 0700 -o "$uid" -g "$uid" "$dir/data"
  install -d -m 0755 "$dir/cert"

  install_helper

  local compose=(docker compose --project-directory "$dir" --project-name inx-connect)
  echo "Pulling $image:$version ..." >&2
  "${compose[@]}" pull --quiet
  # --remove-orphans drops the Caddy container of earlier installers.
  "${compose[@]}" up -d --wait --remove-orphans

  local url link
  url=$(/usr/local/bin/inx-connect url)
  echo
  if link=$(/usr/local/bin/inx-connect setup-code 2>/dev/null); then
    echo "INX Connect is running. Open this one-time link within 24 hours to set the admin password:"
    echo
    echo "  $link"
  else
    echo "INX Connect is running at $url"
    [[ $first == 1 ]] || echo 'Existing data and admin password were kept.'
  fi
  echo
  if [[ -z $domain ]]; then
    echo "Allow inbound TCP $port in your firewall or security group."
    [[ -n $legacy ]] && echo "The bundled Caddy for $legacy was removed. Run: sudo inx-connect domain $legacy"
    echo 'Without a domain, the admin password and subscription links travel in plain HTTP. For HTTPS run: sudo inx-connect domain'
  fi
  echo "Back up $dir/.env and $dir/data together. Manage with: inx-connect status | logs | domain | setup-code --reset"
}

install_helper() {
  cat >/usr/local/bin/inx-connect <<'HELPER'
#!/usr/bin/env bash
# INX Connect host helper, installed by https://inx.sh/connect.
set -euo pipefail
dir=/opt/inx-connect
uid=1000
compose() { docker compose --project-directory "$dir" --project-name inx-connect "$@"; }
env_get() { sed -n "s/^$1=//p" "$dir/.env" | tail -n1; }
env_set() {
  local key=$1 value=$2
  if grep -q "^$key=" "$dir/.env"; then sed -i "s|^$key=.*|$key=$value|" "$dir/.env"; else echo "$key=$value" >>"$dir/.env"; fi
}
die() { echo "error: $*" >&2; exit 1; }

public_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  if [[ -z $ip || $ip =~ ^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; then
    ip=$(curl -4 -fsS --max-time 4 https://api.ipify.org 2>/dev/null || echo "${ip:-127.0.0.1}")
  fi
  echo "$ip"
}

url() {
  local public; public=$(env_get INX_PUBLIC_URL)
  if [[ -n $public ]]; then echo "$public"; else echo "http://$(public_ip):$(env_get INX_PORT)"; fi
}

# x-ui.sh is_domain / acme_listen_flag / socat installation (ssl_cert_issue, 3x-ui v3.11.0).
is_domain() { [[ "$1" =~ ^([A-Za-z0-9](-*[A-Za-z0-9])*\.)+(xn--[a-z0-9]{2,}|[A-Za-z]{2,})$ ]] && ((${#1} <= 253)); }
acme_listen_flag() { if ip -4 addr show scope global 2>/dev/null | grep -q 'inet '; then echo ''; else echo '--listen-v6'; fi; }
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

# HTTPS with a domain, the way x-ui's "SSL Certificate Management → Get SSL (Domain)" does it: acme.sh validates on
# port 80 and renews by itself; the controller keeps its port and serves the certificate itself.
domain_set() {
  local domain=${1:-}
  local acme=~/.acme.sh/acme.sh port
  port=$(env_get INX_PORT)
  if [[ -z $domain ]]; then read -r -p 'Domain for INX Connect (its A record must point to this host): ' domain </dev/tty; fi
  domain=${domain// /}
  domain=${domain,,}
  is_domain "$domain" || die "Invalid domain: $domain"
  if ss -Hltn 'sport = :80' 2>/dev/null | grep -q .; then die 'Port 80 is in use. acme.sh needs it briefly to validate the domain; stop whatever listens there and retry.'; fi
  local ip resolved
  ip=$(public_ip)
  resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  [[ -n $resolved ]] || die "$domain does not resolve. Add an A record pointing to $ip first."
  [[ " $resolved " == *" $ip "* ]] || echo "warning: $domain resolves to ${resolved% }, not $ip. Continuing; validation fails if the record is wrong." >&2

  if [[ ! -x $acme ]]; then
    echo 'Installing acme.sh ...' >&2
    (cd ~ && curl -fsS https://get.acme.sh | sh) || die 'Installing acme.sh failed.'
  fi
  install_socat || die 'Installing socat failed.'
  local home; home=$(dirname "$acme")
  if ! [[ -s "$home/${domain}_ecc/fullchain.cer" || -s "$home/$domain/fullchain.cer" ]]; then
    rm -rf -- "${home:?}/$domain" "${home:?}/${domain}_ecc"
    "$acme" --set-default-ca --server letsencrypt --force
    # shellcheck disable=SC2046 # the flag is empty or one word
    "$acme" --issue -d "$domain" $(acme_listen_flag) --standalone --httpport 80 --force || {
      rm -rf -- "${home:?}/$domain" "${home:?}/${domain}_ecc"
      die 'Issuing the certificate failed. Check that the A record points here and TCP 80 is open to the internet.'
    }
  fi
  "$acme" --installcert --force -d "$domain" --key-file "$dir/cert/privkey.pem" --fullchain-file "$dir/cert/fullchain.pem" --reloadcmd '/usr/local/bin/inx-connect fix-cert-owner && /usr/local/bin/inx-connect restart'
  [[ -s "$dir/cert/privkey.pem" && -s "$dir/cert/fullchain.pem" ]] || die 'Installing the certificate failed.'
  fix_cert_owner
  "$acme" --upgrade --auto-upgrade || echo 'warning: enabling acme.sh auto-upgrade failed' >&2

  local old; old=$(env_get INX_CERT_DOMAIN)
  [[ -n $old && $old != "$domain" ]] && "$acme" --remove -d "$old" >/dev/null 2>&1 || true
  env_set INX_CERT_DOMAIN "$domain"
  env_set INX_PUBLIC_URL "https://$domain:$port"
  compose up -d --wait
  echo
  echo "INX Connect now serves HTTPS at https://$domain:$port"
  echo 'Subscription links use this address; reimport them on devices that used the old one. The certificate renews automatically.'
}

# The container runs as uid 1000, which must be able to read the key.
fix_cert_owner() {
  chown "$uid:$uid" "$dir/cert/privkey.pem" "$dir/cert/fullchain.pem"
  chmod 0600 "$dir/cert/privkey.pem"
  chmod 0644 "$dir/cert/fullchain.pem"
}

domain_remove() {
  local domain; domain=$(env_get INX_CERT_DOMAIN)
  [[ -n $domain ]] || die 'No domain is configured.'
  # Stop renewals from reinstalling the certificate; acme.sh keeps its copy, as x-ui does.
  ~/.acme.sh/acme.sh --remove -d "$domain" >/dev/null 2>&1 || true
  rm -f "$dir/cert/privkey.pem" "$dir/cert/fullchain.pem"
  env_set INX_CERT_DOMAIN ''
  env_set INX_PUBLIC_URL ''
  compose up -d --wait
  echo "Removed $domain. INX Connect serves plain HTTP at $(url)"
}

[[ $(id -u) == 0 ]] || die 'Run as root (sudo).'
case "${1:-}" in
  setup-code) shift; code=$(compose exec -T inx-connect node --disable-warning=ExperimentalWarning index.mjs setup-code "$@"); echo "$(url)/setup?code=$code" ;;
  url) url ;;
  domain) shift; if [[ ${1:-} == --remove ]]; then domain_remove; else domain_set "${1:-}"; fi ;;
  fix-cert-owner) fix_cert_owner ;;
  status) compose ps ;;
  logs) shift; compose logs "$@" ;;
  restart) compose restart ;;
  stop) compose stop ;;
  start) compose up -d --wait ;;
  *) echo 'Usage: inx-connect url | domain [name] | domain --remove | setup-code [--reset] | status | logs [-f] | restart | stop | start' >&2
     echo 'Upgrade: curl -fsSL https://inx.sh/connect | sudo bash' >&2; exit 2 ;;
esac
HELPER
  chmod 0755 /usr/local/bin/inx-connect
}

# Wrapped in main so a truncated download never runs a partial script.
main "$@"
