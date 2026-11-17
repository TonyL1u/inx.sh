import { defineConfig } from 'vitest/config';

// inx-source resolves @inx.sh/gateway/protocol to its TypeScript source, so tests need no Gateway build.
export default defineConfig({
  resolve: { conditions: ['inx-source'] },
  ssr: { resolve: { conditions: ['inx-source'] } },
  test: { testTimeout: 30_000 }
});
