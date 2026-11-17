#!/usr/bin/env bash
# INX Connect (controller) installer, served at https://inx.sh/connect.
#   curl -fsSL https://inx.sh/connect | sudo bash
#   curl -fsSL https://inx.sh/connect | sudo bash -s -- --domain console.example.com
#
# Options (each is remembered in /opt/inx-connect/.env, so reruns only need what changes):
#   --domain NAME   Serve HTTPS for NAME with a bundled Caddy (needs ports 80 and 443 and DNS pointing here)
#   --no-domain     No Caddy; listen on 127.0.0.1 only and put your own reverse proxy in front
#   --version TAG   Image tag: latest (default), beta, or an exact version such as 0.1.0
#   --image REPO    Image repository, e.g. a registry mirror (default inxsh/inx-connect)
#   --caddy-image R Caddy image, e.g. from a registry mirror (default caddy:2)
#   --port N        Loopback port for the API (default 3100)
# Rerunning the installer upgrades in place and keeps data and the secret key.
set -euo pipefail

dir=/opt/inx-connect
uid=1000 # the image's "node" user

die() { echo "error: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: curl -fsSL https://inx.sh/connect | sudo bash -s -- [options]
  --domain NAME   Serve HTTPS for NAME with a bundled Caddy (ports 80/443, DNS pointing here)
  --no-domain     No Caddy; listen on 127.0.0.1 only behind your own reverse proxy
  --version TAG   Image tag: latest (default), beta, or an exact version such as 0.1.0
  --image REPO    Image repository, e.g. a registry mirror (default inxsh/inx-connect)
  --caddy-image R Caddy image, e.g. from a registry mirror (default caddy:2)
  --port N        Loopback port for the API (default 3100)
USAGE
}

# Read KEY=VALUE from .env without executing it.
env_get() { [[ -f "$dir/.env" ]] && sed -n "s/^$1=//p" "$dir/.env" | tail -n1 || true; }
env_has() { [[ -f "$dir/.env" ]] && grep -q "^$1=" "$dir/.env"; }

ask() {
  local prompt=$1 reply=''
  if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then
    read -r -p "$prompt" reply </dev/tty || true
  fi
  echo "$reply"
}

port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q . || ss -Hlun "sport = :$1" 2>/dev/null | grep -q .; }

main() {
  local domain='' domain_set=0 version='' image='' caddy='' port=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) [[ $# -ge 2 ]] || die '--domain needs a value'; domain=$2; domain_set=1; shift 2 ;;
      --domain=*) domain=${1#*=}; domain_set=1; shift ;;
      --no-domain) domain=''; domain_set=1; shift ;;
      --version) [[ $# -ge 2 ]] || die '--version needs a value'; version=$2; shift 2 ;;
      --version=*) version=${1#*=}; shift ;;
      --image) [[ $# -ge 2 ]] || die '--image needs a value'; image=$2; shift 2 ;;
      --image=*) image=${1#*=}; shift ;;
      --caddy-image) [[ $# -ge 2 ]] || die '--caddy-image needs a value'; caddy=$2; shift 2 ;;
      --caddy-image=*) caddy=${1#*=}; shift ;;
      --port) [[ $# -ge 2 ]] || die '--port needs a value'; port=$2; shift 2 ;;
      --port=*) port=${1#*=}; shift ;;
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
  caddy=${caddy:-$(env_get INX_CADDY_IMAGE)}; caddy=${caddy:-caddy:2}
  port=${port:-$(env_get INX_PORT)}; port=${port:-3100}
  if [[ $domain_set == 0 ]]; then
    if env_has INX_DOMAIN; then domain=$(env_get INX_DOMAIN)
    else domain=$(ask 'Domain for HTTPS via the bundled Caddy (leave empty to use your own reverse proxy): '); fi
  fi
  domain=${domain,,}
  [[ $image =~ ^[a-z0-9]([a-z0-9._/:-]*[a-z0-9])?$ ]] || die "Invalid image repository: $image"
  [[ $version =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "Invalid image tag: $version"
  [[ $caddy =~ ^[a-z0-9]([a-z0-9._/:-]*[A-Za-z0-9])?$ ]] || die "Invalid Caddy image: $caddy"
  [[ $port =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || die "Invalid port: $port"
  [[ -z $domain || $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "Invalid domain: $domain"

  local compose=(docker compose --project-directory "$dir" --project-name inx-connect)
  if [[ -n $domain ]] && ! "${compose[@]}" ps --status running -q caddy 2>/dev/null | grep -q .; then
    for p in 80 443; do
      ! port_busy "$p" || die "Port $p is already in use, so the bundled Caddy cannot serve $domain. Free it, or rerun with --no-domain and use your own reverse proxy."
    done
  fi

  local secret; secret=$(env_get INX_SECRET_KEY)
  if [[ -z $secret ]]; then
    secret=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    [[ ${#secret} == 64 ]] || die 'Could not generate a secret key.'
  fi

  # .env holds the only copy of the key that encrypts stored credentials. Back it up with data/.
  umask 077
  cat >"$dir/.env.tmp" <<ENV
# INX Connect settings, written by the installer. Back up this file together with data/.
INX_IMAGE=$image
INX_VERSION=$version
INX_CADDY_IMAGE=$caddy
INX_PORT=$port
INX_DOMAIN=$domain
INX_SECRET_KEY=$secret
ENV
  mv -f "$dir/.env.tmp" "$dir/.env"
  umask 022

  {
    echo '# Managed by the INX Connect installer; rerun it instead of editing. Settings live in .env.'
    echo 'services:'
    echo '  inx-connect:'
    echo '    container_name: inx-connect'
    echo '    image: ${INX_IMAGE}:${INX_VERSION}'
    echo '    restart: unless-stopped'
    echo '    environment:'
    echo '      INX_SECRET_KEY: ${INX_SECRET_KEY}'
    echo '    volumes:'
    echo '      - ./data:/data'
    echo '    ports:'
    echo '      - 127.0.0.1:${INX_PORT}:3100'
    if [[ -n $domain ]]; then
      echo '  caddy:'
      echo '    image: ${INX_CADDY_IMAGE}'
      echo '    restart: unless-stopped'
      echo '    depends_on: [inx-connect]'
      echo '    environment:'
      echo '      INX_DOMAIN: ${INX_DOMAIN}'
      echo '    ports:'
      echo "      - '80:80'"
      echo "      - '443:443'"
      echo "      - '443:443/udp'"
      echo '    volumes:'
      echo '      - ./Caddyfile:/etc/caddy/Caddyfile:ro'
      echo '      - ./caddy/data:/data'
      echo '      - ./caddy/config:/config'
    fi
  } >"$dir/compose.yaml"
  if [[ -n $domain ]]; then
    printf '{$INX_DOMAIN} {\n\tencode zstd gzip\n\treverse_proxy inx-connect:3100\n}\n' >"$dir/Caddyfile"
    install -d -m 0700 "$dir/caddy"
  fi
  install -d -m 0700 -o "$uid" -g "$uid" "$dir/data"

  cat >/usr/local/bin/inx-connect <<'HELPER'
#!/usr/bin/env bash
# INX Connect host helper, installed by https://inx.sh/connect.
set -euo pipefail
dir=/opt/inx-connect
compose() { docker compose --project-directory "$dir" --project-name inx-connect "$@"; }
url() {
  local domain port
  domain=$(sed -n 's/^INX_DOMAIN=//p' "$dir/.env" | tail -n1); port=$(sed -n 's/^INX_PORT=//p' "$dir/.env" | tail -n1)
  if [[ -n $domain ]]; then echo "https://$domain"; else echo "http://127.0.0.1:${port:-3100}"; fi
}
case "${1:-}" in
  setup-code) shift; code=$(compose exec -T inx-connect node --disable-warning=ExperimentalWarning index.mjs setup-code "$@"); echo "$(url)/setup?code=$code" ;;
  url) url ;;
  status) compose ps ;;
  logs) shift; compose logs "$@" ;;
  restart) compose restart ;;
  stop) compose stop ;;
  start) compose up -d --wait ;;
  *) echo 'Usage: inx-connect setup-code [--reset] | url | status | logs [-f] | restart | stop | start' >&2
     echo 'Upgrade: curl -fsSL https://inx.sh/connect | sudo bash' >&2; exit 2 ;;
esac
HELPER
  chmod 0755 /usr/local/bin/inx-connect

  echo "Pulling $image:$version ..." >&2
  "${compose[@]}" pull --quiet
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
  [[ -n $domain ]] || echo "No domain configured: proxy HTTPS to http://127.0.0.1:$port, or rerun with --domain NAME. Subscription links are only private over HTTPS."
  echo "Back up $dir/.env and $dir/data together. Manage with: inx-connect status | logs | setup-code --reset"
}

# Wrapped in main so a truncated download never runs a partial script.
main "$@"
