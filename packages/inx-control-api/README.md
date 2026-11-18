# INX Connect (control API)

The control API is the self-hosted INX Connect controller. It stores machines, nodes and subscriptions in SQLite, serves the [console](../inx-console/) and, in later milestones, talks to each node's [gateway](../inx-gateway/README.md). It ships as one Docker image, `inxsh/inx-connect`, that contains the API and the built console.

## Install

On any Linux host with Docker Engine and the Compose plugin, no options needed:

```sh
curl -fsSL https://inx.sh/connect | sudo bash
```

Like x-ui's panel, the controller then listens on a public HTTP port: `http://<public IP>:3100`. Allow that port in the firewall or security group.

`https://inx.sh/connect` redirects to `connect.sh` on the repository's `main` branch. Optional flags, saved in `/opt/inx-connect/.env` so a rerun only needs what changes:

- `--version latest|beta|X.Y.Z`: the image tag;
- `--image REPO`: a registry mirror;
- `--port N`: the listen port.

The installer writes `/opt/inx-connect/{.env,compose.yaml}`, generates `INX_SECRET_KEY` (which encrypts stored gateway credentials), starts the controller, and prints a **one-time setup link** valid for 24 hours. Opening it sets the admin password; nobody can initialize the console without it.

Rerunning the installer upgrades in place and keeps the data, the key and the domain. Back up `/opt/inx-connect/.env` and `/opt/inx-connect/data` together: the database is useless without the key.

### Domain and HTTPS

```sh
sudo inx-connect domain console.example.com   # or without a name, to be asked
sudo inx-connect domain --remove
```

This follows x-ui's "SSL Certificate Management → Get SSL (Domain)":

- **Issuance:** acme.sh (installed on first use, with socat) validates the domain over HTTP on **port 80**. Port 80 must be free and reachable during issuance and renewals.
- **Install:** the certificate goes to `/opt/inx-connect/cert/`, and acme.sh renews it by itself, restarting the controller.
- **Serving:** the controller keeps its port and serves HTTPS itself, at `https://console.example.com:3100`.
- **Links:** `INX_PUBLIC_URL` is set so subscription links use that address, whichever address the console is opened at. Devices that imported a link over the IP need the new one.

`--remove` stops renewals and goes back to plain HTTP. Until a domain is configured, the console shows a warning that passwords and subscription links travel in plain text.

### Host helper

```sh
sudo inx-connect url                 # the address devices use
sudo inx-connect setup-code          # print a new setup link (first run only)
sudo inx-connect setup-code --reset  # forgot the password: link that replaces it and signs out every session
sudo inx-connect status | logs -f | restart
```

## Machines

Add a VPS in the console by pasting the pairing code that `inx-gateway start` (or `inx-gateway pair`) prints. The controller must reach the Gateway's endpoint, by default TCP 3101 on the VPS's public IPv4.

Pairing is verified end to end before anything is stored:

1. One TLS handshake, without sending anything, to check that the certificate's SHA-256 matches the pin in the code.
2. `GET /v1/info` with the token, which records the node ID and Gateway version.
3. `GET /v1/inbounds` for the first inbound snapshot.

From then on, the pinned certificate is the only trusted CA and its fingerprint is checked on every connection. The token is stored sealed with `INX_SECRET_KEY`.

Pasting a code from a node that is already paired (same node ID) refreshes its credentials instead of adding a duplicate. A machine's "re-pair" action only accepts a code from the same node. Each sync keeps the last successful inbound snapshot. When a check fails, the machine shows the error, for example offline, needs re-pairing, or panel error, while its inbounds stay available.

| Route (session required) | Purpose |
| --- | --- |
| `GET /api/machines` | List with status, last error, inbound count, and sync times |
| `POST /api/machines` `{ pairCode, name? }` | Pair. Returns 201 for a new machine, or 200 with `repaired: true` for a known node |
| `GET /api/machines/:id` | Machine and its last inbound snapshot |
| `PATCH /api/machines/:id` `{ name?, pairCode? }` | Rename, or re-pair with a code from the same node (`409 NODE_MISMATCH` otherwise) |
| `POST /api/machines/:id/sync` | Sync now. A failure is recorded on the machine, not returned as an HTTP error |
| `DELETE /api/machines/:id` | Forget the machine. The VPS is not touched |

Pairing failures return `400 INVALID_PAIR_CODE` or `502` with one of these error codes:

- `GATEWAY_UNREACHABLE`
- `GATEWAY_TIMEOUT`
- `GATEWAY_CERT_MISMATCH`
- `GATEWAY_AUTH`
- `GATEWAY_RESPONSE`
- a `PANEL_*` code passed through from the Gateway

## Subscriptions

The console flow is: pair a machine, see its clients, tick clients from any machines, and get a subscription link. A freshly installed Gateway creates one VLESS + Reality client, so a new VPS has something to pick right after pairing.

Internally, each picked client becomes a **node**: one client of one inbound on one machine. A node is created on first pick and reused afterwards. It carries the display name used in every subscription that contains it. The default name is the machine plus the inbound remark, plus the client when the inbound has several. The console never shows nodes as a separate concept; a member's 重命名 renames its node.

`GET /sub/<token>` needs no session; the token is the credential.

- **Format:** the members' links, base64-encoded and newline-separated (the format Shadowrocket and v2rayN expect), renamed to the node names, in member order.
- **Headers:** `profile-title` with the subscription name, `profile-update-interval: 12`, and `Cache-Control: no-store`.
- **Several endpoints:** when a node has several endpoints (external proxies), the extra links are numbered.

Subscriptions are rendered from each machine's last successful snapshot, so they keep working while a machine is unreachable. A member is skipped, but kept, while it is:

- `missing`: its inbound or client is gone from 3x-ui.
- `disabled`: switched off in 3x-ui.
- `unsupported`: the Gateway cannot build links for it.
- `unknown`: the Gateway predates client listing.

Renaming or changing members takes effect at the same URL the next time a device refreshes. Rotating the token retires the old URL immediately. Deleting a machine removes its clients from every subscription.

| Route (session required) | Purpose |
| --- | --- |
| `GET /api/clients` | Every machine's inbounds and clients, with `nodeId`/`nodeName` once picked, for the picker. No links |
| `POST /api/subscriptions` `{ name, clients? }` | Create, optionally with members. `clients` is an ordered list of `{ machineId, inboundId, email }` |
| `PUT /api/subscriptions/:id/clients` `{ clients }` | Replace the members by client, in order; nodes are created as needed |
| `PUT /api/subscriptions/:id/nodes` `{ nodeIds }` | Replace the members by node ID, in order (used for reordering) |
| `GET/PATCH/DELETE /api/subscriptions/:id`, `GET /api/subscriptions` | Read with ordered members, rename, delete, list |
| `POST /api/subscriptions/:id/rotate` | New token |
| `PATCH /api/nodes/:id` `{ name }` | Rename a picked client everywhere it is used. `GET/POST/DELETE /api/nodes` remain for scripting |

A machine's **domain** is its 3x-ui panel certificate, the one x-ui's "SSL Certificate Management" sets. It can be set in two ways, and both are the same state:

- in the console (「绑定域名」 on the machine page);
- on the VPS with `sudo x-ui`.

When set, that machine's share links use the domain instead of the IP. Binding from the console checks that the domain's A record points at the VPS: otherwise `409 DOMAIN_DNS_MISMATCH` with `resolved` and `expected`, unless `force: true` is sent. Then the Gateway runs x-ui's SSL flow on the VPS. The controller re-reads the domain on every sync, so changes made in x-ui show up here.

| Route (session required) | Purpose |
| --- | --- |
| `GET /api/machines/:id/domain` | Live state from the Gateway: `domain`, and `state` (`idle`/`pending`/`issued`/`removed`/`failed`) with `error` and a `log` tail |
| `POST /api/machines/:id/domain` `{ domain, force? }` | Bind: DNS check, then x-ui's SSL flow on the VPS (202, poll the GET) |
| `DELETE /api/machines/:id/domain` | Reset the panel certificate (links go back to the IP) |

`GET /api/machines/:id` lists each inbound's clients (email, enabled, link count, `unsupported`, imported `nodeId`) but never the links, plus `usage` (nodes and subscriptions that depend on the machine).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `INX_SECRET_KEY` | required in production | 32 bytes as hex (`openssl rand -hex 32`) or base64url. The API refuses to start with a key that does not match the database. |
| `INX_DATA_DIR` | `/data` (image), `./data` (dev) | SQLite database directory |
| `HOST` / `PORT` | `0.0.0.0` / `3100` (image) | Listen address |
| `INX_TRUST_PROXY` | private networks | Comma-separated addresses or CIDRs whose `X-Forwarded-*` headers are trusted |
| `INX_CONSOLE_DIR` | `public/` next to the bundle | Console build to serve |
| `INX_TLS_CERT` / `INX_TLS_KEY` | `/cert/fullchain.pem` / `/cert/privkey.pem` | When both exist, the API serves HTTPS on its port (`inx-connect domain` puts them there) |
| `INX_PUBLIC_URL` | unset | Origin devices reach the controller at, e.g. `https://console.example.com:3100`; subscription links use it |
| `INX_SYNC_INTERVAL_SECONDS` | `300` | How often every machine is re-synced in the background; `0` disables it |
| `INX_GATEWAY_TIMEOUT_MS` | `10000` | Timeout for each request to a Gateway |

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
