import assert from 'node:assert/strict';

import { test } from 'vitest';

import { clientLinks, type PanelInbound } from '../dist/links.js';
import { inboundView } from '../dist/panel.js';

// Expected strings marked "upstream" are copied verbatim from 3x-ui v3.11.0 internal/sub/characterization_test.go,
// so these tests prove the Gateway emits the same links as the panel for those cases.

const uuid = '11111111-2222-4333-8444-555555555555';
const inbound = (protocol: string, settings: object, stream: object, extra: Partial<PanelInbound> = {}): PanelInbound => ({
  id: 1,
  remark: 'char',
  protocol,
  port: 443,
  listen: '203.0.113.1',
  settings: settings as Record<string, unknown>,
  streamSettings: stream as Record<string, unknown>,
  ...extra
});
const links = (ib: PanelInbound, client: object, host = 'gw.example.com') => {
  const r = clientLinks(ib, { email: 'user', ...client }, host);
  assert.ok('links' in r, JSON.stringify(r));
  return r.links;
};
const tlsTcp = { network: 'tcp', security: 'tls', tcpSettings: { header: { type: 'none' } }, tlsSettings: { serverName: 'base.sni', alpn: ['h2'], settings: { fingerprint: 'chrome' } } };

test('upstream C1: VLESS with external proxies forcing tls and none', () => {
  const stream = {
    ...tlsTcp,
    externalProxy: [
      { forceTls: 'tls', dest: 'cdn1.example.com', port: 8443, remark: 'R1', sni: 'sni1.example.com', fingerprint: 'firefox', alpn: ['h3', 'h2'], pinnedPeerCertSha256: ['UElO'] },
      { forceTls: 'none', dest: 'cdn2.example.com', port: 80, remark: 'R2' }
    ]
  };
  assert.deepEqual(links(inbound('vless', { decryption: 'none', encryption: 'none' }, stream), { id: uuid }), [
    'vless://11111111-2222-4333-8444-555555555555@cdn1.example.com:8443?alpn=h3%2Ch2&encryption=none&fp=firefox&pcs=UElO&security=tls&sni=sni1.example.com&type=tcp#char-R1-user',
    'vless://11111111-2222-4333-8444-555555555555@cdn2.example.com:80?encryption=none&security=none&type=tcp#char-R2-user'
  ]);
});

test('upstream C4: VLESS reality through an external proxy keeps reality', () => {
  const stream = {
    network: 'tcp',
    security: 'reality',
    tcpSettings: { header: { type: 'none' } },
    realitySettings: { serverNames: ['reality.example.com'], shortIds: ['ab12cd'], settings: { publicKey: 'PBKvalue', fingerprint: 'firefox' } },
    externalProxy: [{ forceTls: 'same', dest: 'cdn.example.com', port: 2053, remark: 'RS' }]
  };
  const [link, ...rest] = links(inbound('vless', { decryption: 'none', encryption: 'none' }, stream), { id: uuid });
  assert.equal(rest.length, 0);
  for (const part of ['vless://11111111-2222-4333-8444-555555555555@cdn.example.com:2053', 'security=reality', 'sni=reality.example.com', 'pbk=PBKvalue', 'sid=ab12cd', 'fp=firefox', '#char-RS']) assert.ok(link!.includes(part), part);
});

test('upstream C2: VMess with external proxies is byte-identical', () => {
  const stream = {
    ...tlsTcp,
    externalProxy: [
      { forceTls: 'same', dest: 'vm1.example.com', port: 8443, remark: 'V1', sni: 'sni1.example.com' },
      { forceTls: 'none', dest: 'vm2.example.com', port: 80, remark: 'V2' }
    ]
  };
  assert.deepEqual(links(inbound('vmess', {}, stream), { id: uuid, security: 'auto' }), [
    'vmess://ewogICJhZGQiOiAidm0xLmV4YW1wbGUuY29tIiwKICAiYWxwbiI6ICJoMiIsCiAgImZwIjogImNocm9tZSIsCiAgImlkIjogIjExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NSIsCiAgIm5ldCI6ICJ0Y3AiLAogICJwb3J0IjogODQ0MywKICAicHMiOiAiY2hhci1WMS11c2VyIiwKICAic2N5IjogImF1dG8iLAogICJzbmkiOiAic25pMS5leGFtcGxlLmNvbSIsCiAgInRscyI6ICJ0bHMiLAogICJ0eXBlIjogIm5vbmUiLAogICJ2IjogIjIiCn0=',
    'vmess://ewogICJhZGQiOiAidm0yLmV4YW1wbGUuY29tIiwKICAiaWQiOiAiMTExMTExMTEtMjIyMi00MzMzLTg0NDQtNTU1NTU1NTU1NTU1IiwKICAibmV0IjogInRjcCIsCiAgInBvcnQiOiA4MCwKICAicHMiOiAiY2hhci1WMi11c2VyIiwKICAic2N5IjogImF1dG8iLAogICJ0bHMiOiAibm9uZSIsCiAgInR5cGUiOiAibm9uZSIsCiAgInYiOiAiMiIKfQ=='
  ]);
});

test('upstream C3: Trojan and Shadowsocks 2022 userinfo encoding', () => {
  const stream = { network: 'tcp', security: 'tls', tcpSettings: { header: { type: 'none' } }, tlsSettings: { serverName: 'base.sni', settings: { fingerprint: 'chrome' } } };
  assert.deepEqual(links(inbound('trojan', {}, { ...stream, externalProxy: [{ forceTls: 'tls', dest: 'tj.example.com', port: 8443, remark: 'TJ', sni: 'tj.sni' }] }), { password: 'p@ss/w+rd=' }), [
    'trojan://p%40ss%2Fw%2Brd%3D@tj.example.com:8443?fp=chrome&security=tls&sni=tj.sni&type=tcp#char-TJ-user'
  ]);
  assert.deepEqual(
    links(inbound('shadowsocks', { method: '2022-blake3-aes-256-gcm', password: 'inboundpw' }, { ...stream, externalProxy: [{ forceTls: 'tls', dest: 'ss.example.com', port: 8443, remark: 'SS', sni: 'ss.sni' }] }), { password: 'clientpw' }),
    ['ss://2022-blake3-aes-256-gcm:inboundpw:clientpw@ss.example.com:8443?fp=chrome&security=tls&sni=ss.sni&type=tcp#char-SS-user']
  );
});

test('upstream: Shadowsocks TCP http header becomes an obfs-local plugin', () => {
  const stream = { network: 'tcp', security: 'none', tcpSettings: { header: { type: 'http', request: { path: ['/'], headers: { Host: ['test'] } } } } };
  const [link] = links(inbound('shadowsocks', { method: '2022-blake3-aes-256-gcm', password: 'inboundpw' }, stream, { port: 38143, remark: 'ss' }), { password: 'clientpw' });
  assert.ok(link!.includes('plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dtest'), link);
  for (const leak of ['headerType=', 'type=tcp', 'host=test', 'path=']) assert.ok(!link!.includes(leak), leak);
});

test('upstream C6: Hysteria2 pins go out as hex pinSHA256', () => {
  const pin = Buffer.alloc(32).toString('base64');
  const stream = { security: 'tls', tlsSettings: { serverName: 'hy.sni', alpn: ['h3'], settings: { fingerprint: 'chrome' } }, externalProxy: [{ forceTls: 'same', dest: 'hop.example.com', port: 9443, remark: 'H1', pinnedPeerCertSha256: [pin] }] };
  const [link] = links(inbound('hysteria', { version: 2 }, stream), { auth: 'hyauth' });
  for (const part of ['hysteria2://hyauth@hop.example.com:9443', 'security=tls', 'sni=hy.sni', 'pinSHA256=' + '0'.repeat(64), '#char-H1']) assert.ok(link!.includes(part), part);
  assert.ok(!link!.includes('pcs='));
});

test('without a listen address or external proxy, links use the Gateway public host', () => {
  const stream = {
    network: 'tcp',
    security: 'reality',
    tcpSettings: { header: { type: 'none' } },
    realitySettings: { serverNames: ['www.example.com', 'b.example.com'], shortIds: ['0a1b', 'ffff'], settings: { publicKey: 'PK', fingerprint: 'chrome', spiderX: '/' } }
  };
  const ib = inbound('vless', { decryption: 'none', encryption: 'none' }, stream, { listen: '', remark: 'HK' });
  const first = links(ib, { id: uuid, flow: 'xtls-rprx-vision', subId: 'sub1' }, '198.51.100.7');
  // Stable across calls (3x-ui randomizes sni/sid per request; the Gateway uses the first entries).
  assert.deepEqual(links(ib, { id: uuid, flow: 'xtls-rprx-vision', subId: 'sub1' }, '198.51.100.7'), first);
  assert.match(
    first[0]!,
    /^vless:\/\/11111111-2222-4333-8444-555555555555@198\.51\.100\.7:443\?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=PK&security=reality&sid=0a1b&sni=www\.example\.com&spx=%2F[0-9a-f]{15}&support-x25519mlkem768=true&type=tcp#HK-user$/
  );
  assert.match(links(ib, { id: uuid }, '2001:db8::1')[0]!, /@\[2001:db8::1\]:443\?/);
  assert.match(links({ ...ib, shareAddrStrategy: 'custom', shareAddr: 'hk.example.com' }, { id: uuid })[0]!, /@hk\.example\.com:443\?/);
});

test('ws, grpc and xhttp transports carry their parameters', () => {
  const ws = links(inbound('vless', { encryption: 'none' }, { network: 'ws', security: 'tls', wsSettings: { path: '/ray', headers: { Host: 'cdn.example.com' } }, tlsSettings: { serverName: 'cdn.example.com' } }), { id: uuid });
  assert.ok(ws[0]!.includes('host=cdn.example.com&path=%2Fray&security=tls&sni=cdn.example.com&type=ws'), ws[0]);
  const grpc = links(inbound('trojan', {}, { network: 'grpc', security: 'tls', grpcSettings: { serviceName: 'svc', multiMode: true } }), { password: 'pw' });
  assert.ok(grpc[0]!.includes('authority=&mode=multi&security=tls&serviceName=svc&type=grpc'), grpc[0]);
  const xhttp = links(inbound('vless', { encryption: 'none' }, { network: 'xhttp', security: 'none', xhttpSettings: { path: '/x', mode: 'auto', scMaxEachPostBytes: '1000000', noGRPCHeader: true } }), { id: uuid });
  assert.ok(xhttp[0]!.includes('extra=' + encodeURIComponent(JSON.stringify({ mode: 'auto', noGRPCHeader: true }))), xhttp[0]);
});

test('unsupported protocols and transports are reported instead of guessed', () => {
  assert.deepEqual(clientLinks(inbound('wireguard', {}, {}), { email: 'user' }, 'h'), { unsupported: 'protocol:wireguard' });
  assert.deepEqual(clientLinks(inbound('vless', {}, { network: 'kcp' }), { email: 'user' }, 'h'), { unsupported: 'transport:kcp' });
});

test('the inbound view lists each client once and never exposes raw settings', () => {
  const row = {
    ...inbound('trojan', { clients: [{ email: 'a', password: 'secret-a' }, { email: 'A', password: 'dup' }, { email: 'b', password: 'secret-b', enable: false }, { password: 'no-email' }], fallbacks: [] }, { network: 'tcp', security: 'none' }),
    enabled: true,
    listen: '',
    shareAddr: '',
    shareAddrStrategy: '',
    disableFlow: false
  };
  const view = inboundView(row, '203.0.113.9');
  assert.deepEqual(
    view.clients!.map(c => [c.email, c.enabled, c.links.length]),
    [
      ['a', true, 1],
      ['b', false, 1]
    ]
  );
  assert.equal(JSON.stringify({ ...view, clients: [] }), JSON.stringify({ id: 1, remark: 'char', protocol: 'trojan', port: 443, enabled: true, clients: [] }));
  assert.ok(view.clients![0]!.links[0]!.startsWith('trojan://secret-a@203.0.113.9:443?'));
});
