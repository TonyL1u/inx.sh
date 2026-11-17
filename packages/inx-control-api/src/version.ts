import { createRequire } from 'node:module';

// Defined at bundle time by esbuild (see esbuild.config.ts); development reads package.json.
declare const __INX_VERSION__: string | undefined;

export const version: string = typeof __INX_VERSION__ === 'string' ? __INX_VERSION__ : (createRequire(import.meta.url)('../package.json') as { version: string }).version;
