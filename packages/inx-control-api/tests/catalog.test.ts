import assert from 'node:assert/strict';

import { test, type TestContext } from 'vitest';

import { renameLink } from '../src/catalog.js';
import { fakeGateway, signedIn } from './helpers.js';

const decode = (body: string) => Buffer.from(body, 'base64').toString('utf8').split('\n').filter(Boolean);

// Two machines (Hong Kong, Tokyo) paired to one controller.
async function twoMachines(t: TestContext) {
  const hk = await fakeGateway(t);
  const jp = await fakeGateway(t);
  jp.state.inbounds = [
    { id: 7, remark: 'JP Trojan', protocol: 'trojan', port: 8443, enabled: true, clients: [{ email: 'phone', enabled: true, links: ['trojan://pw@198.51.100.9:8443?security=tls&type=tcp#JP%20Trojan-phone'] }] },
    { id: 8, remark: 'JP WG', protocol: 'wireguard', port: 51820, enabled: true, clients: [{ email: 'phone', enabled: true, links: [], unsupported: 'protocol:wireguard' }] }
  ];
  const ctx = await signedIn(t);
  const hkId = (await ctx.call('POST', '/api/machines', { pairCode: hk.code(), name: '香港' })).json().machine.id as number;
  const jpId = (await ctx.call('POST', '/api/machines', { pairCode: jp.code(), name: '日本' })).json().machine.id as number;
  return { ...ctx, hk, jp, hkId, jpId };
}

test('nodes pick one client of one inbound; duplicates and unknown targets are rejected', async t => {
  const { call, hkId, jpId } = await twoMachines(t);
  const created = await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'PHONE' });
  assert.equal(created.statusCode, 201);
  const node = created.json().node;
  // The inbound has two clients, so the default name says which one.
  assert.equal(node.name, '香港 HK Reality · phone');
  assert.equal(node.clientEmail, 'phone');
  assert.equal(node.status, 'ok');

  assert.equal((await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'phone' })).json().error, 'NODE_EXISTS');
  assert.equal((await call('POST', '/api/nodes', { machineId: hkId, inboundId: 99, clientEmail: 'phone' })).json().error, 'INBOUND_NOT_FOUND');
  assert.equal((await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'tablet' })).json().error, 'CLIENT_NOT_FOUND');
  // A second client of the same inbound is a separate node.
  assert.equal((await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'laptop', name: '香港 · 笔记本' })).json().node.name, '香港 · 笔记本');
  const wg = (await call('POST', '/api/nodes', { machineId: jpId, inboundId: 8, clientEmail: 'phone' })).json().node;
  assert.equal(wg.name, '日本 JP WG');
  assert.equal(wg.status, 'unsupported');
  assert.equal(wg.unsupported, 'protocol:wireguard');

  // A remark that already names the machine is not prefixed twice.
  await call('PATCH', '/api/machines/' + jpId, { name: 'JP' });
  assert.equal((await call('POST', '/api/nodes', { machineId: jpId, inboundId: 7, clientEmail: 'phone' })).json().node.name, 'JP Trojan');

  const detail = (await call('GET', '/api/machines/' + hkId)).json();
  assert.equal(detail.inbounds[0].clients[0].nodeId, node.id);
  assert.deepEqual(detail.usage, { nodes: 2, subscriptions: 0 });
  assert.equal((await call('GET', '/api/nodes?machineId=' + jpId)).json().nodes.length, 2);
});

test('subscriptions combine nodes across machines, in order, and share nodes', async t => {
  const { call, hkId, jpId } = await twoMachines(t);
  const hk = (await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'phone', name: '香港' })).json().node;
  const jp = (await call('POST', '/api/nodes', { machineId: jpId, inboundId: 7, clientEmail: 'phone', name: '日本' })).json().node;
  const wg = (await call('POST', '/api/nodes', { machineId: jpId, inboundId: 8, clientEmail: 'phone' })).json().node;

  const home = (await call('POST', '/api/subscriptions', { name: '家庭网络' })).json();
  assert.equal(home.subscription.nodeCount, 0);
  const iphone = (await call('POST', '/api/subscriptions', { name: '我的 iPhone' })).json();
  assert.equal((await call('PUT', `/api/subscriptions/${home.subscription.id}/nodes`, { nodeIds: [hk.id] })).statusCode, 200);
  const members = await call('PUT', `/api/subscriptions/${iphone.subscription.id}/nodes`, { nodeIds: [jp.id, wg.id, hk.id] });
  assert.deepEqual(
    members.json().nodes.map((n: { name: string }) => n.name),
    ['日本', '日本 JP WG', '香港']
  );
  assert.equal((await call('PUT', `/api/subscriptions/${iphone.subscription.id}/nodes`, { nodeIds: [jp.id, jp.id] })).json().error, 'INVALID_MEMBERS');
  assert.equal((await call('GET', '/api/nodes')).json().nodes.find((n: { id: number }) => n.id === hk.id).subscriptionCount, 2);

  // Public output: order kept, names applied, the unsupported node skipped, no session needed.
  const res = await call('GET', '/sub/' + iphone.subscription.token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['profile-title'], 'base64:' + Buffer.from('我的 iPhone').toString('base64'));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(decode(res.body), ['trojan://pw@198.51.100.9:8443?security=tls&type=tcp#%E6%97%A5%E6%9C%AC', 'vless://uuid-phone@203.0.113.5:443?security=reality&type=tcp#%E9%A6%99%E6%B8%AF']);

  // Renaming a node changes every subscription that uses it, under the same URL.
  await call('PATCH', '/api/nodes/' + hk.id, { name: 'HK' });
  assert.ok(decode((await call('GET', '/sub/' + home.subscription.token)).body)[0]!.endsWith('#HK'));
});

test('subscription output follows the machine snapshot: disabled and vanished clients drop out, offline machines keep serving', async t => {
  const { call, db, hk, hkId } = await twoMachines(t);
  const node = (await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'phone' })).json().node;
  const sub = (await call('POST', '/api/subscriptions', { name: 'x' })).json().subscription;
  await call('PUT', `/api/subscriptions/${sub.id}/nodes`, { nodeIds: [node.id] });
  const count = async () => decode((await call('GET', '/sub/' + sub.token)).body).length;
  assert.equal(await count(), 1);

  hk.state.inbounds[0]!.clients![0]!.enabled = false;
  await call('POST', `/api/machines/${hkId}/sync`);
  assert.equal((await call('GET', '/api/nodes')).json().nodes[0].status, 'disabled');
  assert.equal(await count(), 0);

  hk.state.inbounds[0]!.clients![0]!.enabled = true;
  await call('POST', `/api/machines/${hkId}/sync`);
  assert.equal(await count(), 1);

  // Offline: the last snapshot keeps the subscription working.
  await hk.stop();
  assert.equal((await call('POST', `/api/machines/${hkId}/sync`)).json().machine.status, 'error');
  assert.equal(await count(), 1);
  assert.equal((await call('GET', '/api/nodes')).json().nodes[0].machineStatus, 'error');

  // The client removed in 3x-ui: the node stays (so it can come back) but is marked missing.
  db.prepare('UPDATE machines SET inbounds = ? WHERE id = ?').run(JSON.stringify([{ ...hk.state.inbounds[0], clients: [] }]), hkId);
  assert.equal((await call('GET', '/api/nodes')).json().nodes[0].status, 'missing');
  assert.equal(await count(), 0);
});

test('rotating the token retires the old URL; deleting a machine removes its nodes from subscriptions', async t => {
  const { call, hkId, jpId } = await twoMachines(t);
  const hk = (await call('POST', '/api/nodes', { machineId: hkId, inboundId: 1, clientEmail: 'phone' })).json().node;
  const jp = (await call('POST', '/api/nodes', { machineId: jpId, inboundId: 7, clientEmail: 'phone' })).json().node;
  const sub = (await call('POST', '/api/subscriptions', { name: 'x' })).json().subscription;
  await call('PUT', `/api/subscriptions/${sub.id}/nodes`, { nodeIds: [hk.id, jp.id] });
  assert.deepEqual((await call('GET', '/api/machines/' + hkId)).json().usage, { nodes: 1, subscriptions: 1 });

  const rotated = (await call('POST', `/api/subscriptions/${sub.id}/rotate`)).json().subscription;
  assert.notEqual(rotated.token, sub.token);
  assert.equal((await call('GET', '/sub/' + sub.token)).statusCode, 404);
  assert.equal((await call('GET', '/sub/' + rotated.token)).statusCode, 200);

  await call('DELETE', '/api/machines/' + hkId);
  const after = (await call('GET', '/api/subscriptions/' + sub.id)).json();
  assert.deepEqual(
    after.nodes.map((n: { id: number }) => n.id),
    [jp.id]
  );
  assert.equal(after.subscription.nodeCount, 1);

  assert.equal((await call('DELETE', '/api/subscriptions/' + sub.id)).statusCode, 204);
  assert.equal((await call('GET', '/sub/' + rotated.token)).statusCode, 404);
});

test('management routes need a session; /sub does not, and unknown tokens are a bare 404', async t => {
  const { app } = await signedIn(t);
  for (const url of ['/api/nodes', '/api/subscriptions']) assert.equal((await app.inject(url)).statusCode, 401);
  const res = await app.inject('/sub/' + 'A'.repeat(32));
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, 'Not Found');
});

test('renameLink replaces the fragment or the vmess ps field', () => {
  assert.equal(renameLink('trojan://pw@h:1?a=b#old', '日本 1'), 'trojan://pw@h:1?a=b#%E6%97%A5%E6%9C%AC%201');
  assert.equal(renameLink('ss://x@h:1', 'n'), 'ss://x@h:1#n');
  const vmess = 'vmess://' + Buffer.from(JSON.stringify({ add: 'h', ps: 'old', port: 1 })).toString('base64');
  assert.equal(JSON.parse(Buffer.from(renameLink(vmess, '新').slice(8), 'base64').toString()).ps, '新');
});

test('picking clients creates the subscription directly; nodes are created on demand and reused', async t => {
  const { call, hkId, jpId } = await twoMachines(t);
  const tree = (await call('GET', '/api/clients')).json().machines;
  assert.deepEqual(
    tree.map((m: { name: string; clientsListed: boolean }) => [m.name, m.clientsListed]),
    [
      ['香港', true],
      ['日本', true]
    ]
  );
  assert.deepEqual(tree[1].inbounds[1].clients[0], { email: 'phone', enabled: true, unsupported: 'protocol:wireguard', linkCount: 0, nodeId: null, nodeName: null });

  const created = await call('POST', '/api/subscriptions', {
    name: '我的 iPhone',
    clients: [
      { machineId: jpId, inboundId: 7, email: 'phone' },
      { machineId: hkId, inboundId: 1, email: 'LAPTOP' }
    ]
  });
  assert.equal(created.statusCode, 201);
  const sub = created.json();
  assert.deepEqual(
    sub.nodes.map((n: { name: string }) => n.name),
    ['日本 JP Trojan', '香港 HK Reality · laptop']
  );
  assert.equal(decode((await call('GET', '/sub/' + sub.subscription.token)).body).length, 2);

  // The same client in a second subscription reuses its node (and its name).
  const laptop = sub.nodes[1].id;
  await call('PATCH', '/api/nodes/' + laptop, { name: '香港 笔记本' });
  const second = (await call('POST', '/api/subscriptions', { name: '家庭网络', clients: [{ machineId: hkId, inboundId: 1, email: 'laptop' }] })).json();
  assert.deepEqual(
    second.nodes.map((n: { id: number; name: string }) => [n.id, n.name]),
    [[laptop, '香港 笔记本']]
  );
  assert.equal((await call('GET', '/api/clients')).json().machines[0].inbounds[0].clients[1].nodeName, '香港 笔记本');

  // Re-picking replaces members in the new order.
  const updated = await call('PUT', `/api/subscriptions/${sub.subscription.id}/clients`, {
    clients: [
      { machineId: hkId, inboundId: 1, email: 'phone' },
      { machineId: hkId, inboundId: 1, email: 'laptop' }
    ]
  });
  assert.deepEqual(
    updated.json().nodes.map((n: { name: string }) => n.name),
    ['香港 HK Reality · phone', '香港 笔记本']
  );

  // Unknown clients are rejected and nothing is created.
  const bad = await call('POST', '/api/subscriptions', { name: 'x', clients: [{ machineId: hkId, inboundId: 1, email: 'tablet' }] });
  assert.equal(bad.json().error, 'CLIENT_NOT_FOUND');
  assert.equal((await call('GET', '/api/subscriptions')).json().subscriptions.length, 2);
});
