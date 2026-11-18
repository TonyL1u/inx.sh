import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { certDomain } from './domain.js';
import { clientLinks, type PanelClient, parseJson } from './links.js';
import type { GatewayClient, GatewayInbound } from './protocol.js';

export interface Panel {
  url: string;
  token: string;
  serverName?: string;
  ca?: string;
}

export function panelUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw Error('Panel URL must point to 127.0.0.1 or [::1] and may include the panel base path.');
  return url.href.replace(/\/+$/, '');
}

export class PanelError extends Error {
  constructor(
    readonly code: string,
    /** The panel's own message, for PANEL_REJECTED (a write the panel refused). Never forwarded to clients. */
    readonly detail?: string,
    /** The panel answered in the other scheme (HTTP vs HTTPS), e.g. after a certificate was set in x-ui. */
    readonly wrongScheme = false
  ) {
    super(detail ? code + ': ' + detail : code);
  }
}

// The scheme that last worked for each panel URL. x-ui switches the panel to HTTPS on the same port when a certificate
// is set ("Set Cert paths for the panel"), and back when it is reset; calls follow it without a restart.
const workingScheme = new Map<string, string>();

// One JSON call to the panel API with the node-sync bearer token. Returns `obj` of a `{ success: true, obj }` envelope.
async function panelCall(panel: Panel, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const configured = new URL(panelUrl(panel.url));
  const first = workingScheme.get(panel.url) ?? configured.protocol;
  try {
    const obj = await panelOnce(panel, first, method, path, body);
    workingScheme.set(panel.url, first);
    return obj;
  } catch (e) {
    if (!(e instanceof PanelError && e.wrongScheme)) throw e;
    const other = first === 'https:' ? 'http:' : 'https:';
    const obj = await panelOnce(panel, other, method, path, body);
    workingScheme.set(panel.url, other);
    return obj;
  }
}

async function panelOnce(panel: Panel, scheme: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const url = new URL(panelUrl(panel.url) + path);
  url.protocol = scheme;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const data = await new Promise<Buffer>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { authorization: 'Bearer ' + panel.token, accept: 'application/json' };
    if (payload) headers['content-type'] = 'application/json';
    // The panel is on loopback. A certificate set in x-ui is issued for the node's domain, not 127.0.0.1, so unless a
    // CA or server name was configured, the chain is verified against the system CAs but the hostname is not.
    const tls = url.protocol === 'https:' ? { ca: panel.ca, servername: panel.serverName, rejectUnauthorized: true, ...(panel.ca || panel.serverName ? {} : { checkServerIdentity: () => undefined }) } : {};
    const request = send(url, { method, headers, agent: false, ...tls, signal: AbortSignal.timeout(method === 'GET' ? 8000 : 20000) }, response => {
      const status = response.statusCode;
      if (status !== 200) {
        // Go's TLS server answers plain HTTP with 400 "Client sent an HTTP request to an HTTPS server".
        reject(new PanelError(status === 401 ? 'PANEL_AUTH' : status === 403 ? 'PANEL_PERMISSION' : status === 404 ? 'PANEL_PATH' : 'PANEL_RESPONSE', undefined, status === 400 && url.protocol === 'http:'));
        response.destroy();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          reject(new PanelError('PANEL_RESPONSE_TOO_LARGE'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => reject(new PanelError('PANEL_UNREACHABLE')));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', (e: NodeJS.ErrnoException) => {
      // A TLS handshake against a plain HTTP server fails with "wrong version number" / "packet length too long".
      const plain = url.protocol === 'https:' && (e.code === 'EPROTO' || /WRONG_VERSION_NUMBER|PACKET_LENGTH_TOO_LONG|HTTP_REQUEST/.test(e.code ?? '') || /wrong version number|packet length too long/.test(e.message));
      reject(new PanelError(e.code === 'ABORT_ERR' ? 'PANEL_TIMEOUT' : plain ? 'PANEL_TLS' : /CERT|TLS|ISSUER|SELF_SIGNED/.test(e.code ?? '') ? 'PANEL_TLS' : 'PANEL_UNREACHABLE', undefined, plain));
    });
    request.end(payload);
  });
  let result: { success?: unknown; msg?: unknown; obj?: unknown };
  try {
    result = JSON.parse(data.toString());
  } catch {
    throw new PanelError('PANEL_RESPONSE');
  }
  if (result?.success !== true) throw new PanelError(method === 'GET' ? 'PANEL_RESPONSE' : 'PANEL_REJECTED', typeof result?.msg === 'string' ? result.msg : undefined);
  return result.obj;
}

/** The node's domain: that of the 3x-ui panel certificate. undefined when none is set or the path names no domain. */
export async function panelDomain(panel: Panel) {
  const obj = (await panelCall(panel, 'GET', '/panel/api/server/getWebCertFiles')) as { webCertFile?: unknown } | null;
  return typeof obj?.webCertFile === 'string' && obj.webCertFile ? certDomain(obj.webCertFile) : undefined;
}

/** Creates an inbound; 3x-ui accepts its clients inside settings. Returns the new inbound ID. */
export async function addInbound(panel: Panel, inbound: Record<string, unknown>) {
  const obj = (await panelCall(panel, 'POST', '/panel/api/inbounds/add', inbound)) as { id?: unknown } | null;
  if (!Number.isSafeInteger(obj?.id)) throw new PanelError('PANEL_RESPONSE');
  return obj!.id as number;
}

export async function listInbounds(panel: Panel) {
  const obj = await panelCall(panel, 'GET', '/panel/api/inbounds/list');
  if (!Array.isArray(obj)) throw new PanelError('PANEL_RESPONSE');
  const rows = obj as Record<string, unknown>[];
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.id) || typeof row.protocol !== 'string' || typeof row.enable !== 'boolean' || !Number.isInteger(row.port)) throw new PanelError('PANEL_RESPONSE');
    return {
      id: row.id as number,
      protocol: row.protocol,
      port: row.port as number,
      enabled: row.enable,
      remark: typeof row.remark === 'string' ? row.remark : '',
      listen: typeof row.listen === 'string' ? row.listen : '',
      shareAddr: typeof row.shareAddr === 'string' ? row.shareAddr : '',
      shareAddrStrategy: typeof row.shareAddrStrategy === 'string' ? row.shareAddrStrategy : '',
      disableFlow: row.disableFlow === true,
      settings: parseJson(row.settings),
      streamSettings: parseJson(row.streamSettings)
    };
  });
}

export type PanelInboundRow = Awaited<ReturnType<typeof listInbounds>>[number];

/** The /v1/inbounds view: inbound summary plus each client's share links. Credentials appear only inside links. */
export function inboundView(row: PanelInboundRow, publicHost: string): GatewayInbound {
  const clients: GatewayClient[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(row.settings.clients) ? row.settings.clients : []) {
    const client = raw as PanelClient;
    if (!client || typeof client.email !== 'string' || client.email === '' || seen.has(client.email.toLowerCase())) continue;
    seen.add(client.email.toLowerCase());
    const built = clientLinks(row, client, publicHost);
    clients.push({ email: client.email, enabled: client.enable !== false, ...('links' in built ? { links: built.links } : { links: [], unsupported: built.unsupported }) });
  }
  return { id: row.id, remark: row.remark, protocol: row.protocol, port: row.port, enabled: row.enabled, clients };
}
