import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

import type { Panel } from './panel.js';

export interface Config {
  id: string;
  endpoint: string;
  token: string;
  panel: Panel;
  ca: string;
  cert: string;
  key: string;
}

export const secret = () => randomBytes(32).toString('base64url');
export const readConfig = (path: string): Config => JSON.parse(readFileSync(path, 'utf8'));
export function saveConfig(dir: string, config: Config) {
  const tmp = join(dir, 'config-' + secret() + '.tmp');
  writeFileSync(tmp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, join(dir, 'config.json'));
}
export function gatewayUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Expected a public HTTPS origin, e.g. https://203.0.113.5:3101');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) throw Error('Invalid Gateway hostname');
  return url.origin;
}
export function matchesHost(cert: string, host: string) {
  const x = new X509Certificate(cert);
  return (isIP(host) ? x.checkIP(host) : x.checkHost(host)) && Date.parse(x.validTo) > Date.now() + 30 * 86400000;
}
export function pair(config: Config) {
  const payload = { v: 1, id: config.id, endpoint: config.endpoint, token: config.token, ca: config.ca };
  return 'inx-pair-' + Buffer.from(JSON.stringify(payload)).toString('base64url');
}
