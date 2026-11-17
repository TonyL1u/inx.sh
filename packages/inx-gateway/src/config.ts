import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

import type { Panel } from './panel.js';

// Pairing and endpoint helpers are part of the controller contract and live in protocol.ts.
export { certPin, gatewayUrl, pair, parsePair } from './protocol.js';

export interface Config {
  id: string;
  endpoint: string;
  token: string;
  panel: Panel;
  cert: string;
  key: string;
}

export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const readConfig = (path: string): Config => JSON.parse(readFileSync(path, 'utf8'));
export function saveConfig(dir: string, config: Config) {
  const tmp = join(dir, 'config-' + secret() + '.tmp');
  writeFileSync(tmp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, join(dir, 'config.json'));
}
export function matchesHost(cert: string, host: string) {
  const x = new X509Certificate(cert);
  return (isIP(host) ? x.checkIP(host) : x.checkHost(host)) && Date.parse(x.validTo) > Date.now() + 30 * 86400000;
}
