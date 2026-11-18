import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, type TestContext } from 'vitest';

// The request and status files live in the runtime directory, which the module reads at import time.
const runtime = mkdtempSync(join(tmpdir(), 'inx-runtime-'));
process.env.INX_RUNTIME_DIR = runtime;
const { createGateway } = await import('../dist/server.js');

async function gateway(t: TestContext) {
  const panelState = { certFile: '' };
  const panel = createServer((req, res) => {
    const send = (obj: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, obj }));
    if (req.url === '/x/panel/api/inbounds/list') return send([{ id: 1, remark: 'HK', protocol: 'trojan', port: 443, enable: true, settings: { clients: [{ email: 'phone', password: 'pw' }] }, streamSettings: { network: 'tcp', security: 'none' } }]);
    if (req.url === '/x/panel/api/server/getWebCertFiles') return send({ webCertFile: panelState.certFile, webKeyFile: '' });
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => panel.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'inx-gw-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-keyout', 'k.pem', '-out', 'c.pem', '-subj', '/CN=gw', '-addext', 'subjectAltName=IP:203.0.113.5'], {
    cwd: dir,
    stdio: 'ignore'
  });
  const app = createGateway({
    id: 'node',
    endpoint: 'https://203.0.113.5:3101',
    token: 'tok',
    cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    key: readFileSync(join(dir, 'k.pem'), 'utf8'),
    panel: { url: `http://127.0.0.1:${(panel.address() as AddressInfo).port}/x/`, token: 'p' }
  });
  t.onTestFinished(async () => {
    await app.close();
    await new Promise<void>(resolve => panel.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(runtime, 'domain-request'), { force: true });
    rmSync(join(runtime, 'domain-status.json'), { force: true });
  });
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, token = 'tok') => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + token } });
  return { panelState, call };
}

test('links follow the domain set for the panel in x-ui, read live on every call', async t => {
  const { panelState, call } = await gateway(t);
  const link = async () => (await call('GET', '/v1/inbounds')).json().inbounds[0].clients[0].links[0] as string;
  assert.match(await link(), /^trojan:\/\/pw@203\.0\.113\.5:443\?/);
  panelState.certFile = '/root/cert/hk.example.com/fullchain.pem';
  assert.match(await link(), /^trojan:\/\/pw@hk\.example\.com:443\?/);
  assert.equal((await call('GET', '/v1/domain')).json().domain, 'hk.example.com');
  panelState.certFile = '';
  assert.match(await link(), /@203\.0\.113\.5:443\?/);
  assert.ok((await call('GET', '/v1/info')).json().capabilities.includes('domain'));
});

test('binding only queues a validated request for the root helper', async t => {
  const { call } = await gateway(t);
  assert.equal((await call('POST', '/v1/domain', { domain: 'hk.example.com' }, 'wrong')).statusCode, 401);
  assert.equal((await call('POST', '/v1/domain', { domain: 'hk.example.com;reboot' })).json().error, 'DOMAIN_INVALID');
  assert.equal((await call('POST', '/v1/domain', { domain: 'localhost' })).statusCode, 400);

  const queued = await call('POST', '/v1/domain', { domain: 'HK.example.com' });
  assert.equal(queued.statusCode, 202);
  assert.equal(readFileSync(join(runtime, 'domain-request'), 'utf8'), 'set hk.example.com\n');
  // Queued but not yet picked up by the root helper: already reported as pending.
  assert.deepEqual(((await call('GET', '/v1/domain')).json() as { state: string; requested: string }).state, 'pending');

  // The helper reports progress; a request in flight blocks another.
  writeFileSync(join(runtime, 'domain-status.json'), JSON.stringify({ state: 'pending', domain: 'hk.example.com', error: '', log: 'Binding hk.example.com', updatedAt: Math.floor(Date.now() / 1000) }));
  assert.equal((await call('POST', '/v1/domain', { domain: 'jp.example.com' })).json().error, 'DOMAIN_BUSY');
  const status = (await call('GET', '/v1/domain')).json();
  assert.deepEqual([status.state, status.requested, status.domain], ['pending', 'hk.example.com', null]);

  writeFileSync(join(runtime, 'domain-status.json'), JSON.stringify({ state: 'failed', domain: 'hk.example.com', error: 'DOMAIN_PORT_80_BUSY', log: 'port 80 is in use', updatedAt: Math.floor(Date.now() / 1000) }));
  assert.equal((await call('GET', '/v1/domain')).json().error, 'DOMAIN_PORT_80_BUSY');
  assert.equal((await call('DELETE', '/v1/domain')).statusCode, 202);
  assert.equal(readFileSync(join(runtime, 'domain-request'), 'utf8'), 'remove\n');
});

test('a helper that died mid-request does not block new requests forever', async t => {
  const { call } = await gateway(t);
  writeFileSync(join(runtime, 'domain-status.json'), JSON.stringify({ state: 'pending', domain: 'hk.example.com', updatedAt: Math.floor(Date.now() / 1000) - 3600 }));
  assert.deepEqual([(await call('GET', '/v1/domain')).json().state, (await call('GET', '/v1/domain')).json().error], ['failed', 'DOMAIN_TIMEOUT']);
  assert.equal((await call('POST', '/v1/domain', { domain: 'hk.example.com' })).statusCode, 202);
});
