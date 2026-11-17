import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

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
  constructor(readonly code: string) {
    super(code);
  }
}

export async function listInbounds(panel: Panel) {
  const url = new URL(panelUrl(panel.url) + '/panel/api/inbounds/list');
  const data = await new Promise<Buffer>((resolve, reject) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(url, { headers: { authorization: 'Bearer ' + panel.token, accept: 'application/json' }, agent: false, ca: panel.ca, servername: panel.serverName, rejectUnauthorized: true, signal: AbortSignal.timeout(8000) }, response => {
      const status = response.statusCode;
      if (status !== 200) {
        reject(new PanelError(status === 401 ? 'PANEL_AUTH' : status === 403 ? 'PANEL_PERMISSION' : status === 404 ? 'PANEL_PATH' : 'PANEL_RESPONSE'));
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
    request.on('error', (e: NodeJS.ErrnoException) => reject(new PanelError(e.code === 'ABORT_ERR' ? 'PANEL_TIMEOUT' : /CERT|TLS|ISSUER|SELF_SIGNED/.test(e.code ?? '') ? 'PANEL_TLS' : 'PANEL_UNREACHABLE')));
  });
  let rows: Record<string, unknown>[];
  try {
    const result = JSON.parse(data.toString());
    if (result?.success !== true || !Array.isArray(result.obj)) throw Error();
    rows = result.obj;
  } catch {
    throw new PanelError('PANEL_RESPONSE');
  }
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
