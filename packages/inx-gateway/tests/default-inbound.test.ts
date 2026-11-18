import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';

import { test } from 'vitest';

import { choosePort, defaultInbound, x25519 } from '../dist/default-inbound.js';
import { clientLinks } from '../dist/links.js';

test('x25519 keys are raw base64url like `xray x25519`, and the public key belongs to the private key', () => {
  const { privateKey, publicKey } = x25519();
  assert.match(privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(publicKey, /^[A-Za-z0-9_-]{43}$/);
  const derived = createPublicKey(createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: privateKey, x: publicKey }, format: 'jwk' })).export({ format: 'jwk' }).x;
  assert.equal(derived, publicKey);
});

test('the default inbound is a VLESS Reality inbound the Gateway can share', () => {
  const inbound = defaultInbound(443);
  const client = inbound.settings.clients[0]!;
  assert.match(client.email, /^inx-[0-9a-f]{6}$/);
  assert.notEqual(defaultInbound(443).settings.clients[0]!.id, client.id);
  const result = clientLinks({ id: 1, ...inbound }, client, '203.0.113.5');
  assert.ok('links' in result);
  const link = new URL(result.links[0]!);
  assert.equal(link.protocol, 'vless:');
  assert.equal(link.username, client.id);
  assert.equal(link.host, '203.0.113.5:443');
  for (const [k, v] of Object.entries({
    security: 'reality',
    type: 'tcp',
    flow: 'xtls-rprx-vision',
    sni: 'www.microsoft.com',
    pbk: inbound.streamSettings.realitySettings.settings.publicKey,
    sid: inbound.streamSettings.realitySettings.shortIds[0],
    fp: 'chrome'
  }))
    assert.equal(link.searchParams.get(k), v, k);
});

test('choosePort avoids ports already used by inbounds', async () => {
  const port = await choosePort([443]);
  assert.notEqual(port, 443);
  assert.ok(port >= 20000 && port < 60000);
});
