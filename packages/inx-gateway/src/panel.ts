import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

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
  try {
    const result = JSON.parse(data.toString());
    if (result?.success !== true || !Array.isArray(result.obj)) throw Error();
    return result.obj.map((row: Record<string, unknown>) => {
      if (!Number.isSafeInteger(row.id) || typeof row.protocol !== 'string' || typeof row.enable !== 'boolean' || !Number.isInteger(row.port)) throw Error();
      return { id: row.id, protocol: row.protocol, port: row.port, enabled: row.enable, remark: typeof row.remark === 'string' ? row.remark : '' };
    }) as { id: number; protocol: string; port: number; enabled: boolean; remark: string }[];
  } catch {
    throw new PanelError('PANEL_RESPONSE');
  }
}
