# INX Connect

INX Connect is a self-hosted project for managing 3x-ui panels across VPS nodes. Each node runs a gateway that serves a read-only list of inbounds over HTTPS. The panel token stays on the node.

| Package | Current scope |
| --- | --- |
| [Gateway](packages/inx-gateway/README.md) | VPS installation, pairing, and inbound queries |
| [Control API](packages/inx-control-api/README.md) | Docker deployment, health checks, and versioned gateway installer URLs |
| [Console](packages/inx-console/) | React and Vite app with a placeholder page |

## Development

Use Node.js 24 LTS and the pnpm version pinned in [package.json](package.json). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r lint
pnpm -r build
```

See the [gateway guide](packages/inx-gateway/README.md) to install a node, test the API, or build a Linux release.
