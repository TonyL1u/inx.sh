// The contract between a Gateway and the INX Connect controller: pairing codes, certificate pins and API shapes.
// Exported as @inx.sh/gateway/protocol; keep this module free of Gateway-internal imports.
import { createHash, X509Certificate } from 'node:crypto';
import { isIP, isIPv4 } from 'node:net';

export function gatewayUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Expected a public HTTPS origin, e.g. https://203.0.113.5:3101');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) throw Error('Invalid Gateway hostname');
  return url.origin;
}

// Clients trust the Gateway certificate only if its SHA-256 matches the pin.
export const certPin = (cert: string | Buffer) => createHash('sha256').update(new X509Certificate(cert).raw).digest('base64url');

export interface Pairing {
  endpoint: string;
  token: string;
  /** base64url SHA-256 of the Gateway certificate (DER). */
  pin: string;
}

const prefix = 'inx-pair-';
// Bytes: version 2, certificate SHA-256 (32), token (16), port (2), host type (4 = IPv4, 0 = text), host.
export function pair(config: { endpoint: string; token: string; cert: string }) {
  const url = new URL(config.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const token = Buffer.from(config.token, 'base64url');
  if (token.length !== 16) throw Error('This Gateway token predates short pairing codes. Rerun start.');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(Number(url.port || 443));
  const addr = isIPv4(host) ? Buffer.from([4, ...host.split('.').map(Number)]) : Buffer.concat([Buffer.from([0]), Buffer.from(host)]);
  return prefix + Buffer.concat([Buffer.from([2]), Buffer.from(certPin(config.cert), 'base64url'), token, port, addr]).toString('base64url');
}

export function parsePair(code: string): Pairing {
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

/** GET /v1/info */
export interface GatewayInfo {
  id: string;
  service: 'inx-gateway';
  apiVersion: number;
  version: string;
  capabilities: string[];
}

/** One entry of GET /v1/inbounds */
export interface GatewayInbound {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enabled: boolean;
}

/** `error` values in Gateway error responses (401 GATEWAY_AUTH; 502/504 PANEL_*). */
export type GatewayErrorCode = 'GATEWAY_AUTH' | 'PANEL_AUTH' | 'PANEL_PERMISSION' | 'PANEL_PATH' | 'PANEL_RESPONSE' | 'PANEL_RESPONSE_TOO_LARGE' | 'PANEL_UNREACHABLE' | 'PANEL_TLS' | 'PANEL_TIMEOUT';
