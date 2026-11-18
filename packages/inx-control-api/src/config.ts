import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSecretKey, randomToken } from './crypto.js';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  secretKey: Buffer;
  consoleDir?: string;
  trustProxy: string[];
  /** Background machine sync period; 0 disables it. */
  syncIntervalMs: number;
  /** Set by `inx-connect domain`: the certificate the API serves HTTPS with, on its usual port. */
  tls?: { cert: string; key: string };
  /** The address devices reach the controller at (INX_PUBLIC_URL), used for subscription links. */
  publicUrl?: string;
}

/** An http(s) origin without credentials or a path, e.g. https://console.example.com:3100. */
export function publicOrigin(value: string | undefined) {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw Error('INX_PUBLIC_URL must be an http(s) origin such as https://console.example.com:3100');
  return url.origin;
}

const privateNetworks = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const dataDir = resolve(env.INX_DATA_DIR ?? (production ? '/data' : 'data'));
  let secret = env.INX_SECRET_KEY;
  if (!secret) {
    if (production) throw Error('INX_SECRET_KEY is required. Generate one with: openssl rand -hex 32');
    // Development only: keep a throwaway key next to the database.
    const file = join(dataDir, 'dev-secret.key');
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, randomToken(32), { mode: 0o600, flag: 'wx' });
    }
    secret = readFileSync(file, 'utf8');
  }
  // The production bundle ships the console next to index.mjs.
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'public');
  const consoleDir = env.INX_CONSOLE_DIR ? resolve(env.INX_CONSOLE_DIR) : existsSync(join(bundled, 'index.html')) ? bundled : undefined;
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3100),
    dataDir,
    secretKey: parseSecretKey(secret),
    consoleDir,
    trustProxy: env.INX_TRUST_PROXY ? env.INX_TRUST_PROXY.split(',').map(s => s.trim()) : privateNetworks,
    syncIntervalMs: Number(env.INX_SYNC_INTERVAL_SECONDS ?? 300) * 1000,
    tls: loadTls(env.INX_TLS_CERT ?? '/cert/fullchain.pem', env.INX_TLS_KEY ?? '/cert/privkey.pem'),
    publicUrl: publicOrigin(env.INX_PUBLIC_URL)
  };
}

function loadTls(cert: string, key: string) {
  if (!existsSync(cert) || !existsSync(key)) return undefined;
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

export const dbPath = (config: Config) => join(config.dataDir, 'inx-connect.sqlite');
