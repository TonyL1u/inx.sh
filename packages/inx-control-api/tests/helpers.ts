import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GatewayInbound, pair } from '@inx.sh/gateway/protocol';
import type { TestContext } from 'vitest';

import { buildApp } from '../src/app.js';
import { createSetupCode } from '../src/auth.js';
import { openDb } from '../src/db.js';

export const key = randomBytes(32);

export function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'inx-gw-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-keyout', 'k.pem', '-out', 'c.pem', '-subj', '/CN=INX Gateway', '-addext', 'subjectAltName=IP:127.0.0.1'], {
      cwd: dir,
      stdio: 'ignore'
    });
    return { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A minimal Gateway speaking the real wire protocol over TLS; tests mutate `state` to simulate the node.
export async function fakeGateway(t: TestContext, tls = certificate()) {
  const state = {
    id: 'node-' + randomBytes(4).toString('hex'),
    token: randomBytes(16).toString('base64url'),
    version: '0.1.0-beta.3',
    panelError: '',
    capabilities: ['inbounds:list', 'inbounds:clients', 'domain'],
    /** What the node's x-ui panel certificate says, and the last domain request the Gateway received. */
    domain: null as string | null,
    domainState: 'idle',
    domainRequests: [] as string[],
    inbounds: [
      {
        id: 1,
        remark: 'HK Reality',
        protocol: 'vless',
        port: 443,
        enabled: true,
        clients: [
          { email: 'phone', enabled: true, links: ['vless://uuid-phone@203.0.113.5:443?security=reality&type=tcp#HK%20Reality-phone'] },
          { email: 'laptop', enabled: true, links: ['vless://uuid-laptop@203.0.113.5:443?security=reality&type=tcp#HK%20Reality-laptop'] }
        ]
      }
    ] as GatewayInbound[]
  };
  const server: Server = createHttpsServer({ ...tls }, (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== 'Bearer ' + state.token) return send(401, { error: 'GATEWAY_AUTH' });
    if (req.url === '/v1/info') return send(200, { id: state.id, service: 'inx-gateway', apiVersion: 1, version: state.version, capabilities: state.capabilities });
    if (req.url === '/v1/domain') {
      if (req.method === 'GET') return send(200, { domain: state.domain, state: state.domainState, requested: null, error: null, log: null, updatedAt: null });
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        state.domainRequests.push(req.method === 'POST' ? 'set ' + (JSON.parse(raw) as { domain: string }).domain : 'remove');
        state.domainState = 'pending';
        send(202, { state: 'pending' });
      });
      return;
    }
    if (req.url === '/v1/inbounds') return state.panelError ? send(502, { error: state.panelError }) : send(200, { inbounds: state.inbounds });
    send(404, { error: 'NOT_FOUND' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  const endpoint = 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { state, tls, endpoint, code: () => pair({ endpoint, token: state.token, cert: tls.cert }), stop: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

export async function signedIn(t: TestContext) {
  const db = openDb(':memory:', key);
  const app = await buildApp({ trustProxy: [], secretKey: key, syncIntervalMs: 0 }, db);
  t.onTestFinished(async () => {
    await app.close();
    db.close();
  });
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { code: createSetupCode(db), password: 'correct horse' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
  return { db, app, call };
}
