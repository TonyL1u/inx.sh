import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import { join } from 'node:path';

import type { Panel } from './panel.js';

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

// Clients trust the Gateway certificate only if its SHA-256 matches the pin.
export const certPin = (cert: string | Buffer) => createHash('sha256').update(new X509Certificate(cert).raw).digest('base64url');
const prefix = 'inx-pair-';
// Bytes: version 2, certificate SHA-256 (32), token (16), port (2), host type (4 = IPv4, 0 = text), host.
export function pair(config: Config) {
  const url = new URL(config.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const token = Buffer.from(config.token, 'base64url');
  if (token.length !== 16) throw Error('This Gateway token predates short pairing codes. Rerun setup.');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(Number(url.port || 443));
  const addr = isIPv4(host) ? Buffer.from([4, ...host.split('.').map(Number)]) : Buffer.concat([Buffer.from([0]), Buffer.from(host)]);
  return prefix + Buffer.concat([Buffer.from([2]), Buffer.from(certPin(config.cert), 'base64url'), token, port, addr]).toString('base64url');
}
export function parsePair(code: string) {
  const b = Buffer.from(code.slice(prefix.length), 'base64url');
  if (!code.startsWith(prefix) || b[0] !== 2 || b.length < 53) throw Error('Invalid pairing code');
  const rest = b.subarray(52);
  const host = b[51] === 4 && rest.length === 4 ? rest.join('.') : rest.toString();
  return {
    endpoint: gatewayUrl('https://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + b.readUInt16BE(49)),
    token: b.subarray(33, 49).toString('base64url'),
    pin: b.subarray(1, 33).toString('base64url')
  };
}
