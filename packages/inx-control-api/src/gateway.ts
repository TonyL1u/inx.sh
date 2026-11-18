import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';

import type { GatewayClient, GatewayDomain, GatewayInbound, GatewayInfo } from '@inx.sh/gateway/protocol';

export type GatewayFailure =
  | 'GATEWAY_UNREACHABLE' // TCP/TLS connection failed
  | 'GATEWAY_TIMEOUT'
  | 'GATEWAY_CERT_MISMATCH' // the certificate is not the one the pairing code pinned
  | 'GATEWAY_AUTH' // token rejected
  | 'GATEWAY_IDENTITY' // a different node answered
  | 'GATEWAY_RESPONSE' // malformed or unexpected response
  | `PANEL_${string}` // the Gateway reached its 3x-ui panel but the panel failed
  | `DOMAIN_${string}`; // a domain request the Gateway refused

export class GatewayError extends Error {
  constructor(readonly code: GatewayFailure) {
    super(code);
  }
}

export interface GatewayTarget {
  endpoint: string;
  token: string;
  pin: string;
  /** PEM of the pinned certificate; trusted as the only CA. */
  cert: string;
}

const pinOf = (raw: Buffer) => createHash('sha256').update(raw).digest('base64url');
const hostOf = (endpoint: string) => new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
const timeoutMs = Number(process.env.INX_GATEWAY_TIMEOUT_MS ?? 10_000);
const maxBody = 8 * 1024 * 1024;

const networkFailure = (e: NodeJS.ErrnoException): GatewayFailure => (e.name === 'TimeoutError' || e.code === 'ABORT_ERR' || e.code === 'ETIMEDOUT' ? 'GATEWAY_TIMEOUT' : e instanceof GatewayError ? e.code : 'GATEWAY_UNREACHABLE');

// One TLS handshake without verification and without sending anything: fetch the certificate and compare it to the pin.
export function fetchPinnedCertificate(endpoint: string, pin: string) {
  const url = new URL(endpoint);
  const host = hostOf(endpoint);
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerX509Certificate();
      socket.destroy();
      if (!cert || pinOf(cert.raw) !== pin) return reject(new GatewayError('GATEWAY_CERT_MISMATCH'));
      resolve(cert.toString());
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new GatewayError('GATEWAY_TIMEOUT'));
    });
    socket.on('error', (e: NodeJS.ErrnoException) => reject(new GatewayError(networkFailure(e))));
  });
}

const get = (target: GatewayTarget, path: string) => send(target, 'GET', path);

function send(target: GatewayTarget, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: unknown) {
  const url = new URL(path, target.endpoint);
  const host = hostOf(target.endpoint);
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        agent: false,
        ca: target.cert,
        servername: isIP(host) ? undefined : host,
        // The pin is the identity; it is stricter than a hostname match against a self-signed certificate.
        checkServerIdentity: (_host: string, cert: PeerCertificate) => (pinOf(cert.raw) === target.pin ? undefined : new GatewayError('GATEWAY_CERT_MISMATCH')),
        headers: { authorization: 'Bearer ' + target.token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(timeoutMs)
      },
      res => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBody) {
            res.destroy();
            reject(new GatewayError('GATEWAY_RESPONSE'));
          } else chunks.push(chunk);
        });
        res.on('error', (e: NodeJS.ErrnoException) => reject(new GatewayError(networkFailure(e))));
        res.on('end', () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new GatewayError('GATEWAY_RESPONSE'));
          }
          if (res.statusCode === 200 || res.statusCode === 202) return resolve(body);
          if (res.statusCode === 401) return reject(new GatewayError('GATEWAY_AUTH'));
          const code = (body as { error?: unknown } | null)?.error;
          reject(new GatewayError(typeof code === 'string' && /^(PANEL|DOMAIN)_[A-Z0-9_]{1,40}$/.test(code) ? (code as GatewayFailure) : 'GATEWAY_RESPONSE'));
        });
      }
    );
    req.on('error', (e: NodeJS.ErrnoException) => {
      // TLS failures here mean the certificate changed after pairing.
      if (/CERT|SELF_SIGNED|ISSUER|SIGNATURE/.test(e.code ?? '')) return reject(new GatewayError('GATEWAY_CERT_MISMATCH'));
      reject(new GatewayError(networkFailure(e)));
    });
    req.end(body);
  });
}

export async function getInfo(target: GatewayTarget): Promise<GatewayInfo> {
  const info = (await get(target, '/v1/info')) as Partial<GatewayInfo> | null;
  if (typeof info?.id !== 'string' || typeof info.version !== 'string' || !Array.isArray(info.capabilities)) throw new GatewayError('GATEWAY_RESPONSE');
  return { id: info.id, service: 'inx-gateway', apiVersion: Number(info.apiVersion), version: info.version, capabilities: info.capabilities.filter(c => typeof c === 'string') };
}

export async function listInbounds(target: GatewayTarget): Promise<GatewayInbound[]> {
  const body = (await get(target, '/v1/inbounds')) as { inbounds?: unknown } | null;
  if (!Array.isArray(body?.inbounds)) throw new GatewayError('GATEWAY_RESPONSE');
  return body.inbounds.map((row: Partial<GatewayInbound> | null) => {
    if (!Number.isSafeInteger(row?.id) || typeof row?.protocol !== 'string' || !Number.isInteger(row.port) || typeof row.enabled !== 'boolean') throw new GatewayError('GATEWAY_RESPONSE');
    const inbound: GatewayInbound = { id: row.id!, remark: typeof row.remark === 'string' ? row.remark : '', protocol: row.protocol, port: row.port!, enabled: row.enabled };
    // Gateways without the inbounds:clients capability omit clients; keep the field absent rather than empty.
    if (Array.isArray(row.clients)) inbound.clients = row.clients.map(parseClient);
    return inbound;
  });
}

const linkPattern = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
function parseClient(raw: unknown): GatewayClient {
  const c = raw as Partial<GatewayClient> | null;
  if (typeof c?.email !== 'string' || c.email === '' || typeof c.enabled !== 'boolean' || !Array.isArray(c.links) || !c.links.every(l => typeof l === 'string' && linkPattern.test(l))) throw new GatewayError('GATEWAY_RESPONSE');
  return { email: c.email, enabled: c.enabled, links: c.links, ...(typeof c.unsupported === 'string' ? { unsupported: c.unsupported } : {}) };
}

const domainStates = new Set(['idle', 'pending', 'issued', 'removed', 'failed']);
export async function getDomain(target: GatewayTarget): Promise<GatewayDomain> {
  const d = (await get(target, '/v1/domain')) as Partial<GatewayDomain> | null;
  if (!d || !domainStates.has(d.state as string)) throw new GatewayError('GATEWAY_RESPONSE');
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { domain: text(d.domain), state: d.state!, requested: text(d.requested), error: text(d.error), log: typeof d.log === 'string' ? d.log : null, updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : null };
}
export const bindDomain = (target: GatewayTarget, domain: string) => send(target, 'POST', '/v1/domain', { domain });
export const unbindDomain = (target: GatewayTarget) => send(target, 'DELETE', '/v1/domain');
