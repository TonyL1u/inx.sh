import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';

import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/index.mjs',
  // Bundle @inx.sh/gateway/protocol from source (see the package's exports).
  conditions: ['inx-source'],
  define: { __INX_VERSION__: JSON.stringify(version) },
  banner: {
    js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);"
  }
});

// The image serves the console from dist/public; build it first with `pnpm --filter @inx.sh/console build`.
const consoleDist = '../inx-console/dist';
if (existsSync(consoleDist + '/index.html')) cpSync(consoleDist, 'dist/public', { recursive: true });
else process.stderr.write('warning: ../inx-console/dist not found; the bundle will not serve the console.\n');
