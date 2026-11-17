# INX Connect

INX Connect is a self-hosted project for managing 3x-ui panels across VPS nodes. Each node runs a gateway that serves a read-only list of inbounds over HTTPS. The panel token stays on the node. The controller (control API + console) runs on a host of your choice and manages the nodes.

| Package | Current scope | Installed with |
| --- | --- | --- |
| [Gateway](packages/inx-gateway/README.md) | VPS installation, pairing, and inbound queries | `curl -fsSL https://inx.sh/bootstrap \| sudo bash` |
| [Control API](packages/inx-control-api/README.md) | Controller: SQLite storage, admin login, serves the console; Docker image `inxsh/inx-connect` | `curl -fsSL https://inx.sh/connect \| sudo bash` |
| [Console](packages/inx-console/) | React + Vite web UI, bundled into the controller image | — |

## Development

Use Node.js 24 LTS and the pnpm version pinned in [package.json](package.json). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r lint
pnpm -r build
```

See the [gateway guide](packages/inx-gateway/README.md) to install a node, test the API, or build a Linux release.

## Hosting inx.sh

Both installers are plain files at the repository root (`bootstrap.sh` for the gateway, `connect.sh` for the controller). The `inx.sh` host redirects to their copies on the `main` branch; change them on `main` and merge `main` into the development branch. Inside the Nginx HTTPS server block:

```nginx
location = /bootstrap {
    return 302 https://raw.githubusercontent.com/TonyL1u/inx.sh/main/bootstrap.sh;
}
location = /connect {
    return 302 https://raw.githubusercontent.com/TonyL1u/inx.sh/main/connect.sh;
}
```

GitHub serves raw files with a short cache (about five minutes), so an installer change on `main` reaches users shortly after it is pushed. GitHub Releases in this repository are Gateway releases only; `bootstrap.sh` relies on `/releases/latest` being the newest stable Gateway.
