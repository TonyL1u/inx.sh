# INX Gateway

INX Gateway runs on a VPS and exposes the local 3x-ui inbound list over HTTPS. Clients authenticate with a gateway token; the panel token and private keys stay on the VPS.

## Install and pair

On a glibc-based Linux VPS (amd64 or arm64) with systemd, Bash, curl, tar, sha256sum, and OpenSSL, run the installer:

```sh
# Most recently published stable Gateway release
curl -fsSL https://inx.sh/bootstrap | sudo bash

# Pin a stable release or opt into a beta
curl -fsSL https://inx.sh/bootstrap | sudo bash -s -- --version 0.1.0
curl -fsSL https://inx.sh/bootstrap | sudo bash -s -- --version 0.1.0-beta.2
```

`https://inx.sh/bootstrap` redirects to `bootstrap.sh` on the repository's `main` branch. The script resolves the newest stable release from GitHub (`/releases/latest`) unless `--version` is given; a pinned version never falls back. The installer verifies the download, unpacks the gateway and its Node.js runtime under `/opt/inx-gateway`, and runs `inx-gateway start`, which configures the node, starts the systemd service, and prints a pairing code. If the VPS already has system-wide Node.js 22.18+ and the npm package is published, use `sudo npm install -g @inx.sh/gateway` followed by `sudo inx-gateway start`.

First-time setup requires exactly one public IPv4 address. Allow the controller to reach TCP port **3101**. Start reuses native 3x-ui v3.11.0 or installs it on a clean VPS with the panel bound to loopback. It stops if it finds an unsupported panel or a partial installation.

Start saves credentials in `/etc/inx-gateway`, starts the systemd service, and prints a pairing code after checking HTTPS authentication. Treat the code as a password. Use `sudo inx-gateway pair` to display it again, and `sudo inx-gateway stop` to stop the service. Rerunning start preserves the node identity and the self-signed certificate (valid for 10 years); a new certificate requires pairing again.

`sudo inx-gateway uninstall` removes everything the installer set up: the gateway service, `/etc/inx-gateway`, `/opt/inx-gateway`, and the `/usr/local/bin/inx-gateway` link. It also removes the 3x-ui panel, but only when start installed it; a panel that already existed on the VPS is never touched.

The pairing code carries the endpoint, the gateway token, and the SHA-256 of the gateway certificate (`parsePair` in `src/config.ts` decodes it). A client completes one TLS handshake without verification and without sending anything, checks that the certificate's SHA-256 matches, and from then on uses that certificate as the trusted CA.

## HTTP API

| GET            | Authentication       | Response                                                                |
| -------------- | -------------------- | ----------------------------------------------------------------------- |
| `/health`      | None                 | Service name and API version; does not query the panel                  |
| `/v1/info`     | Gateway bearer token | Node ID, version, and capabilities                                      |
| `/v1/inbounds` | Gateway bearer token | `inbounds` array with `id`, `remark`, `protocol`, `port`, and `enabled` |

A `401` means the gateway token is missing or invalid. A `502` indicates a panel error; the response includes the reason. A panel timeout returns `504`.

## Test and release

From the repository root, run `pnpm --filter @inx.sh/gateway test` with OpenSSL on your PATH. The suite runs the CLI against a local test panel over a real TLS connection to the gateway.

Build releases with CI: push a Git tag exactly equal to the Gateway's `package.json` version. GitHub Actions runs the tests, builds both architecture bundles on native Linux runners, and creates the release with four files: both archives and both checksums. The installer is not a release asset; it lives as `bootstrap.sh` on the `main` branch and works for every release. Tags with `-` are automatically marked prereleases; the default installer only selects stable releases. A `workflow_dispatch` run builds without publishing.

Alternatively, on a Linux machine: `pnpm install --frozen-lockfile && bash packages/inx-gateway/scripts/build-linux-bundle.sh`.

The `inx.sh` host serves the installer redirects with Nginx; see [Hosting inx.sh](../../README.md#hosting-inxsh).

To test a local release against native 3x-ui, run this from the repository root (use `linux/arm64` for the arm64 bundle). The installer comes from the `main` branch:

```sh
git fetch origin main && git show origin/main:bootstrap.sh > /tmp/bootstrap.sh
docker run --rm --platform linux/amd64 --cpus=1 --memory=1g --memory-swap=1g \
  -v "$PWD/packages/inx-gateway/release/$(node -p "require('./packages/inx-gateway/package.json').version"):/release:ro" \
  -v /tmp/bootstrap.sh:/bootstrap.sh:ro \
  -v "$PWD/packages/inx-gateway/tests:/tests:ro" \
  debian:bookworm-slim bash /tests/bootstrap-debian.sh
```

The container simulates systemd and a public IP. Verify boot startup and public connectivity on a VPS.
