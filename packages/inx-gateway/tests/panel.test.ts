import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';

import { test, type TestContext } from 'vitest';

import { certDomain, isDomain } from '../dist/domain.js';
import { listInbounds, panelDomain } from '../dist/panel.js';

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'inx-panel-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-keyout', 'k.pem', '-out', 'c.pem', '-subj', '/CN=panel', '-addext', 'subjectAltName=IP:127.0.0.1'], {
      cwd: dir,
      stdio: 'ignore'
    });
    return { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A panel on one port that, like 3x-ui, switches between HTTP and HTTPS when a certificate is set or reset.
// In HTTPS mode it answers plain HTTP the way Go's TLS server does: 400 "Client sent an HTTP request to an HTTPS server".
async function switchingPanel(t: TestContext, tls: { cert: string; key: string }) {
  const state = { https: false, certFile: '' };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const send = (obj: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, obj }));
    if (req.headers.authorization !== 'Bearer t') return res.writeHead(401).end();
    if (req.url === '/p/panel/api/inbounds/list') return send([{ id: 1, remark: 'r', protocol: 'vless', port: 443, enable: true, settings: {}, streamSettings: {} }]);
    if (req.url === '/p/panel/api/server/getWebCertFiles') return send({ webCertFile: state.certFile, webKeyFile: '' });
    res.writeHead(404).end();
  };
  // Back ends on their own ports; the front port relays to the one matching the current mode.
  const http = createHttpServer(handler);
  const secure = createTlsServer(tls, socket => http.emit('connection', socket));
  const plain = createNetServer(socket => http.emit('connection', socket));
  const open = new Set<Socket>();
  const front = createNetServer(socket => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.once('data', first => {
      const isTls = first[0] === 0x16;
      if (state.https && !isTls) return socket.end('HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n');
      // Go's plain HTTP server answers a TLS ClientHello with a plain 400, which the client sees as a TLS error.
      if (!state.https && isTls) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      const upstream = connect({ host: '127.0.0.1', port: ((state.https ? secure : plain).address() as AddressInfo).port });
      open.add(upstream);
      upstream.on('close', () => open.delete(upstream));
      upstream.write(first);
      socket.pipe(upstream).pipe(socket);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
  });
  for (const server of [secure, plain, front]) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.onTestFinished(() => {
      for (const socket of open) socket.destroy();
      return new Promise<void>(resolve => server.close(() => resolve()));
    });
  }
  return { state, port: (front.address() as AddressInfo).port };
}

test('the panel client follows the panel between HTTP and HTTPS without a restart', async t => {
  const tls = certificate();
  const { state, port } = await switchingPanel(t, tls);
  const panel = { url: `http://127.0.0.1:${port}/p/`, token: 't', ca: tls.cert };
  assert.equal((await listInbounds(panel)).length, 1);
  state.https = true; // a certificate was set in x-ui
  assert.equal((await listInbounds(panel)).length, 1);
  assert.equal((await listInbounds(panel)).length, 1);
  state.https = false; // and reset again
  assert.equal((await listInbounds(panel)).length, 1);
});

test('the node domain is the panel certificate domain', async t => {
  const tls = certificate();
  const { state, port } = await switchingPanel(t, tls);
  const panel = { url: `http://127.0.0.1:${port}/p/`, token: 't', ca: tls.cert };
  assert.equal(await panelDomain(panel), undefined);
  state.certFile = '/root/cert/HK.example.com/fullchain.pem';
  assert.equal(await panelDomain(panel), 'hk.example.com');
  state.certFile = '/root/.acme.sh/jp.example.com_ecc/fullchain.cer';
  assert.equal(await panelDomain(panel), 'jp.example.com');
  state.certFile = '/etc/ssl/panel.pem';
  assert.equal(await panelDomain(panel), undefined);
});

test('domain names follow x-ui is_domain', () => {
  for (const ok of ['a.example.com', 'xn--fiqs8s.xn--fiqz9s', 'sub-1.example.co']) assert.ok(isDomain(ok), ok);
  for (const bad of ['localhost', '1.2.3.4', '-a.example.com', 'a..example.com', 'a.example.com;rm', 'a b.com', '']) assert.ok(!isDomain(bad), bad);
  assert.equal(certDomain('/root/cert/../etc/fullchain.pem'), undefined);
});
