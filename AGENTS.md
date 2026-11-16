# AGENTS.md

## Repository

pnpm monorepo (pnpm@12.15.0 pinned via `packageManager`; Node 24 LTS). Three packages:

- `packages/inx-gateway` — `@inx.sh/gateway`, the only published package. Node CLI (commander + fastify) that runs on VPS nodes, exposing a local 3x-ui panel over HTTPS. Entry: `src/index.ts` → `dist/index.js` via `bin`.
- `packages/inx-control-api` — private fastify API, deployed via Docker Compose on port 3100 (loopback), serves `/bootstrap` installer redirects.
- `packages/inx-console` — private React 19 + Vite 8 app (placeholder page).

`.npmrc` points the registry at `https://registry.npmmirror.com`. `pnpm-workspace.yaml` only allows builds for `esbuild`.

Gateway-related scripts, deps, and config live in `packages/inx-gateway/` — never create root-level `scripts/` or root scripts for gateway concerns. Publishing: bump the version in `packages/inx-gateway/package.json`, commit, then `pnpm --filter @inx.sh/gateway release` (tags and pushes; CI does the rest).

## Commands

The only root script is `test` (recursive). Run from the repo root:

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r lint        # eslint only; prettier runs through eslint-plugin-prettier
pnpm -r build
pnpm test           # runs every package's test script
pnpm --filter @inx.sh/gateway test
pnpm --filter @inx.sh/control-api test
```

- Tests use vitest (single runner, declared once in root devDependencies; package scripts resolve the hoisted binary). Tests are `.test.ts` files under `tests/`, included in each package's tsconfig so they typecheck with `pnpm -r typecheck`.
- Gateway tests: `test` and `typecheck` scripts run `build` first — tests import from `../dist/` and need the emitted `.d.ts` for typechecking (the tsconfig.build.json has `declaration: true`; fresh clones must build before typechecking or imports fail with TS2307). Requires `openssl` on PATH; the suite runs the real CLI against a local test panel over real TLS. Per-test timeout is 30s via `vitest.config.ts`.
- Control API tests run via `vitest run` directly against `src/` (vite resolves `.js` imports to `.ts`), no build needed. `tsx` remains only for `dev` and `esbuild.config.ts`.
- Dev servers: `pnpm --filter <pkg> dev` (tsx watch for gateway/control-api, vite for console). Control API in production is Docker Compose only: `pnpm --filter @inx.sh/control-api build` before `docker compose -f packages/inx-control-api/docker-compose.yaml up -d --build --wait`.

## Gateway release flow (get this wrong and installs break)

- `packages/inx-gateway/package.json` `version` must match `X.Y.Z` or `X.Y.Z-beta.N`; it drives installer URLs, archive names, and the GitHub release tag (tag must equal the version exactly).
- Releases are built by CI (`.github/workflows/release.yml`), never locally: push a tag exactly equal to the version and GitHub Actions runs the tests, builds both arch bundles on native Linux runners, and creates the release with all five assets. Tags with `-` are automatically marked prerelease (the default installer URL only resolves stable releases). `workflow_dispatch` triggers a build-only dry run (no release is created). The workflow hard-fails if the tag does not match the gateway version.
- `packages/inx-gateway/scripts/build-linux-bundle.sh` is Linux-only by design (uses the runner's own Node as the bundled runtime and `sha256sum`); do not add cross-platform workarounds to it — that road leads to `node-linux-*` devDependencies whose `node` bin hijacks every `#!/usr/bin/env node` tool on macOS (tsc/vitest/tsx/eslint all break with "cannot execute binary file"). pnpm has no switch to suppress dependency bin links.
- `dist/` ships with `.d.ts` files (declaration emit is on) for tests/npm; the release bundle uses `pnpm --prod deploy` output instead, so tests and configs never end up in artifacts.
- Pinned installer URLs (`/bootstrap/<version>`) never fall back — a missing asset is a 404.

## Code style and lint quirks

- Flat ESLint config at root; `lint` is check-only (no `--fix` script exists). Ignores `**/dist`, `**/drizzle`, `**/.next`, and all plain `**/*.js` files.
- `simple-import-sort` is a warning; sort imports rather than disabling it.
- `@typescript-eslint/no-explicit-any` is an error (except rest args); non-null assertions are allowed (rule off).
- TS is strict with `verbatimModuleSyntax` — type-only imports must use `import type`.
- Prettier: printWidth 256, single quotes, no trailing commas, `arrowParens: avoid`, tailwind class sorting plugin. Enforced via ESLint.
- All packages are ESM (`"type": "module"`).
- LF line endings enforced via `.gitattributes`/`.editorconfig`.
- CI is release-only (`.github/workflows/release.yml`); no pre-commit hooks — verification is whatever you run yourself.
