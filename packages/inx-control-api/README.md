# INX Connect (control API)

The control API is the self-hosted INX Connect controller. It stores machines, nodes and subscriptions in SQLite, serves the [console](../inx-console/) and, in later milestones, talks to each node's [gateway](../inx-gateway/README.md). It ships as one Docker image, `inxsh/inx-connect`, that contains the API and the built console.

## Install

On any Linux host with Docker Engine and the Compose plugin:

```sh
# Bundled Caddy with automatic HTTPS (ports 80/443 free, DNS for the domain pointing at this host)
curl -fsSL https://inx.sh/connect | sudo bash -s -- --domain console.example.com

# No Caddy: listen on 127.0.0.1:3100 and put your own HTTPS reverse proxy in front
curl -fsSL https://inx.sh/connect | sudo bash -s -- --no-domain
```

`https://inx.sh/connect` redirects to `connect.sh` on the repository's `main` branch. Other options: `--version latest|beta|X.Y.Z` (image tag), `--image REPO` and `--caddy-image IMAGE` (registry mirrors), and `--port N`. Options are saved in `/opt/inx-connect/.env`, so a rerun only needs what changes.

The installer writes `/opt/inx-connect/{.env,compose.yaml}`, generates `INX_SECRET_KEY` (which encrypts stored gateway credentials), starts the stack, and prints a **one-time setup link** valid for 24 hours. Opening it sets the admin password; nobody can initialize the console without it.

Rerunning the installer upgrades in place and keeps the data and the key. Back up `/opt/inx-connect/.env` and `/opt/inx-connect/data` together: the database is useless without the key. The installer also adds a host helper:

```sh
sudo inx-connect setup-code          # print a new setup link (first run only)
sudo inx-connect setup-code --reset  # forgot the password: link that replaces it and signs out every session
sudo inx-connect status | logs -f | restart
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `INX_SECRET_KEY` | required in production | 32 bytes as hex (`openssl rand -hex 32`) or base64url. The API refuses to start with a key that does not match the database. |
| `INX_DATA_DIR` | `/data` (image), `./data` (dev) | SQLite database directory |
| `HOST` / `PORT` | `0.0.0.0` / `3100` (image) | Listen address |
| `INX_TRUST_PROXY` | private networks | Comma-separated addresses or CIDRs whose `X-Forwarded-*` headers are trusted |
| `INX_CONSOLE_DIR` | `public/` next to the bundle | Console build to serve |

## Development

```sh
pnpm --filter @inx.sh/control-api dev   # API on 127.0.0.1:3100, data in packages/inx-control-api/data
pnpm --filter @inx.sh/console dev       # Vite; proxies /api, /sub and /health to the API
(cd packages/inx-control-api && pnpm exec tsx src/index.ts setup-code)   # print a setup code, then open http://localhost:5173/setup?code=...
pnpm --filter @inx.sh/control-api test
```

Test the production image locally:

```sh
pnpm --filter @inx.sh/console build && pnpm --filter @inx.sh/control-api build
INX_SECRET_KEY=$(openssl rand -hex 32) docker compose -f packages/inx-control-api/docker-compose.yaml up -d --build --wait
docker exec inx-connect-dev node index.mjs setup-code
```

## Release

Bump `version` in this package's `package.json`, commit, then run `pnpm --filter @inx.sh/control-api release`. It pushes the tag `connect-v<version>`; `.github/workflows/connect.yml` runs the checks and pushes a multi-arch (amd64, arm64) image to Docker Hub:

| Version | Image tags |
| --- | --- |
| `0.2.1` | `0.2.1`, `0.2`, `latest` |
| `0.2.1-beta.3` | `0.2.1-beta.3`, `beta` |

The workflow needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token with write access to `inxsh/inx-connect`). It does not create a GitHub Release, so `/releases/latest` keeps pointing at the Gateway. A `workflow_dispatch` run builds both architectures without pushing.
