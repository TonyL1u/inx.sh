import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';

import { pair } from '@inx.sh/gateway/protocol';
import { test } from 'vitest';

import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { Machines } from '../src/machines.js';
import { certificate, fakeGateway, key, signedIn } from './helpers.js';

test('pairing verifies the pinned certificate, stores the machine, and seals the token', async t => {
  const gw = await fakeGateway(t);
  const { db, call } = await signedIn(t);

  const res = await call('POST', '/api/machines', { pairCode: gw.code(), name: '  香港  VPS ' });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.machine.name, '香港 VPS');
  assert.equal(body.machine.nodeId, gw.state.id);
  assert.equal(body.machine.status, 'online');
  assert.equal(body.machine.gatewayVersion, '0.1.0-beta.3');
  // The console sees clients and link counts, never the links (they carry credentials).
  assert.deepEqual(body.inbounds, [
    {
      id: 1,
      remark: 'HK Reality',
      protocol: 'vless',
      port: 443,
      enabled: true,
      clients: [
        { email: 'phone', enabled: true, linkCount: 1, unsupported: null, nodeId: null },
        { email: 'laptop', enabled: true, linkCount: 1, unsupported: null, nodeId: null }
      ]
    }
  ]);
  assert.ok(!res.body.includes('uuid-phone'));
  assert.deepEqual(body.usage, { nodes: 0, subscriptions: 0 });

  const stored = db.prepare('SELECT token_sealed FROM machines').get() as { token_sealed: string };
  assert.ok(!stored.token_sealed.includes(gw.state.token));
  assert.deepEqual(
    (await call('GET', '/api/machines')).json().machines.map((m: { name: string }) => m.name),
    ['香港 VPS']
  );
  assert.equal((await call('GET', '/api/machines/' + body.machine.id)).json().inbounds[0].remark, 'HK Reality');
});

test('pairing failures are classified and store nothing', async t => {
  const gw = await fakeGateway(t);
  const { call } = await signedIn(t);
  const attempt = async (pairCode: string) => (await call('POST', '/api/machines', { pairCode })).json().error;

  assert.equal(await attempt('inx-pair-garbage'), 'INVALID_PAIR_CODE');
  // A code whose pin belongs to another certificate (e.g. the Gateway was reinstalled).
  assert.equal(await attempt(pair({ endpoint: gw.endpoint, token: gw.state.token, cert: certificate().cert })), 'GATEWAY_CERT_MISMATCH');
  assert.equal(await attempt(pair({ endpoint: gw.endpoint, token: randomBytes(16).toString('base64url'), cert: gw.tls.cert })), 'GATEWAY_AUTH');
  gw.state.panelError = 'PANEL_AUTH';
  assert.equal(await attempt(gw.code()), 'PANEL_AUTH');
  const code = gw.code();
  await gw.stop();
  assert.equal(await attempt(code), 'GATEWAY_UNREACHABLE');
  assert.deepEqual((await call('GET', '/api/machines')).json().machines, []);
});

test('pairing the same node again refreshes credentials instead of adding a machine', async t => {
  const gw = await fakeGateway(t);
  const { call } = await signedIn(t);
  const first = (await call('POST', '/api/machines', { pairCode: gw.code(), name: 'Tokyo' })).json().machine;

  gw.state.token = randomBytes(16).toString('base64url'); // the node rotated its token
  const again = await call('POST', '/api/machines', { pairCode: gw.code() });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().repaired, true);
  assert.equal(again.json().machine.id, first.id);
  assert.equal(again.json().machine.name, 'Tokyo');
  assert.equal((await call('POST', `/api/machines/${first.id}/sync`)).json().machine.status, 'online');
});

test('re-pairing through PATCH requires the same node; rename and delete', async t => {
  const a = await fakeGateway(t);
  const b = await fakeGateway(t);
  const { call } = await signedIn(t);
  const machine = (await call('POST', '/api/machines', { pairCode: a.code() })).json().machine;
  assert.equal(machine.name, '127.0.0.1');

  const mismatch = await call('PATCH', '/api/machines/' + machine.id, { pairCode: b.code() });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error, 'NODE_MISMATCH');

  a.state.token = randomBytes(16).toString('base64url');
  const repaired = await call('PATCH', '/api/machines/' + machine.id, { pairCode: a.code(), name: 'Los Angeles' });
  assert.equal(repaired.statusCode, 200);
  assert.equal(repaired.json().machine.name, 'Los Angeles');
  assert.equal((await call('PATCH', '/api/machines/' + machine.id, { name: '   ' })).json().error, 'INVALID_NAME');

  assert.equal((await call('DELETE', '/api/machines/' + machine.id)).statusCode, 204);
  assert.equal((await call('GET', '/api/machines/' + machine.id)).statusCode, 404);
});

test('sync keeps the last good inbounds while a node fails, then recovers', async t => {
  const gw = await fakeGateway(t);
  const { db, call } = await signedIn(t);
  let clock = 1_000;
  const machines = new Machines(db, key, () => clock);
  const { machine } = await machines.pair(gw.code());

  gw.state.panelError = 'PANEL_TIMEOUT';
  clock = 2_000;
  let after = await machines.sync(machine.id);
  assert.equal(after.status, 'error');
  assert.equal(after.lastError, 'PANEL_TIMEOUT');
  assert.equal(after.syncedAt, 1_000);
  assert.equal(after.checkedAt, 2_000);
  assert.equal(after.inboundCount, 1);

  gw.state.panelError = '';
  gw.state.inbounds.push({ id: 2, remark: 'HK Trojan', protocol: 'trojan', port: 8443, enabled: false });
  clock = 3_000;
  after = await machines.sync(machine.id);
  assert.equal(after.status, 'online');
  assert.equal(after.syncedAt, 3_000);
  assert.equal(after.inboundCount, 2);

  // A different node answering at the same address is not this machine.
  gw.state.id = 'someone-else';
  assert.equal((await machines.sync(machine.id)).lastError, 'GATEWAY_IDENTITY');
  assert.equal((await call('GET', '/api/machines')).json().machines[0].lastError, 'GATEWAY_IDENTITY');
});

test('a changed certificate after pairing is reported, not trusted', async t => {
  const gw = await fakeGateway(t);
  const { db } = await signedIn(t);
  const machines = new Machines(db, key);
  const { machine } = await machines.pair(gw.code());
  // Same address, new certificate: e.g. an attacker or a reinstalled Gateway.
  const port = Number(new URL(gw.endpoint).port);
  await gw.stop();
  const impostor = createHttpsServer(certificate(), (_req, res) => res.writeHead(200).end('{}'));
  await new Promise<void>(resolve => impostor.listen(port, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise<void>(resolve => impostor.close(() => resolve())));
  assert.equal((await machines.sync(machine.id)).lastError, 'GATEWAY_CERT_MISMATCH');
});

test('machine routes require a session', async t => {
  const db = openDb(':memory:', key);
  const app = await buildApp({ trustProxy: [], secretKey: key, syncIntervalMs: 0 }, db);
  t.onTestFinished(async () => {
    await app.close();
    db.close();
  });
  assert.equal((await app.inject('/api/machines')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/machines', payload: { pairCode: 'x' } })).statusCode, 401);
});
