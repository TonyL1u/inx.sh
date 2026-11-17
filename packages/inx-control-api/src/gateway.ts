import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';

import type { GatewayInbound, GatewayInfo } from '@inx.sh/gateway/protocol';

export type GatewayFailure =
  | 'GATEWAY_UNREACHABLE' // TCP/TLS connection failed
  | 'GATEWAY_TIMEOUT'
  | 'GATEWAY_CERT_MISMATCH' // the certificate is not the one the pairing code pinned
  | 'GATEWAY_AUTH' // token rejected
  | 'GATEWAY_IDENTITY' // a different node answered
  | 'GATEWAY_RESPONSE' // malformed or unexpected response
  | `PANEL_${string}`; // the Gateway reached its 3x-ui panel but the panel failed

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

function get(target: GatewayTarget, path: string) {
  const url = new URL(path, target.endpoint);
  const host = hostOf(target.endpoint);
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        ca: target.cert,
        servername: isIP(host) ? undefined : host,
        // The pin is the identity; it is stricter than a hostname match against a self-signed certificate.
        checkServerIdentity: (_host: string, cert: PeerCertificate) => (pinOf(cert.raw) === target.pin ? undefined : new GatewayError('GATEWAY_CERT_MISMATCH')),
        headers: { authorization: 'Bearer ' + target.token, accept: 'application/json' },
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
          if (res.statusCode === 200) return resolve(body);
          if (res.statusCode === 401) return reject(new GatewayError('GATEWAY_AUTH'));
          const code = (body as { error?: unknown } | null)?.error;
          reject(new GatewayError(typeof code === 'string' && /^PANEL_[A-Z_]{1,40}$/.test(code) ? (code as GatewayFailure) : 'GATEWAY_RESPONSE'));
        });
      }
    );
    req.on('error', (e: NodeJS.ErrnoException) => {
      // TLS failures here mean the certificate changed after pairing.
      if (/CERT|SELF_SIGNED|ISSUER|SIGNATURE/.test(e.code ?? '')) return reject(new GatewayError('GATEWAY_CERT_MISMATCH'));
      reject(new GatewayError(networkFailure(e)));
    });
    req.end();
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
    return { id: row.id!, remark: typeof row.remark === 'string' ? row.remark : '', protocol: row.protocol, port: row.port!, enabled: row.enabled };
  });
}
