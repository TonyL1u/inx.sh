import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { test } from 'vitest';

import { pair, parsePair, saveConfig } from '../dist/config.js';
import { panelUrl } from '../dist/panel.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const exec = promisify(execFile);
const run = async (...args: string[]) => (await exec(process.execPath, [cli, ...args])).stdout.trim();
const listen = (s: Server) => new Promise<void>(resolve => s.listen(0, '127.0.0.1', () => resolve()));
const close = (s: Server) => new Promise<void>(resolve => s.close(() => resolve()));
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const listeningPort = (s: Server) => {
  const addr = s.address();
  if (addr === null || typeof addr === 'string') throw Error('Server is not listening on an IP port');
  return addr.port;
};
function request(endpoint: string, path: string, ca: string | undefined, token?: string) {
  return new Promise<{ status: number | undefined; body: Record<string, unknown> }>((resolve, reject) => {
    const req = get(endpoint + path, { ca, agent: false, headers: token ? { authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(2000) }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
  });
}
// What a client does once per pairing: read the certificate from a handshake that sends nothing, then check the pin.
function pinnedCert(endpoint: string, pin: string) {
  const url = new URL(endpoint);
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false }, () => {
      const cert = socket.getPeerX509Certificate()!;
      socket.destroy();
      if (createHash('sha256').update(cert.raw).digest('base64url') === pin) resolve(cert.toString());
      else reject(Error('Certificate does not match the pairing code'));
    });
    socket.on('error', reject);
  });
}

test('commands reject custom options and positional arguments', async () => {
  for (const command of ['start', 'stop', 'uninstall', 'pair']) {
    await assert.rejects(run(command, '--state-dir', '/tmp'), /unknown option/);
    await assert.rejects(run(command, 'unexpected'), /too many arguments/);
  }
});

test('pairing, TLS, authorization and upstream failures across the actual CLI boundary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'inx-test-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const upstreamToken = 'only-for-the-panel';
  interface Payload {
    success: boolean;
    msg?: string;
    obj?: { id: number; remark: string; enable: boolean; protocol: string; port: number; settings: { privateKey: string } }[];
  }
  let hits = 0,
    status = 200,
    payload: Payload = { success: true, obj: [{ id: 1, remark: 'JP', enable: true, protocol: 'vless', port: 443, settings: { privateKey: 'not-for-export' } }] };
  const panel = createServer((req, res) => {
    hits++;
    if (req.url !== '/base/panel/api/inbounds/list' || req.headers.authorization !== 'Bearer ' + upstreamToken) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(status, status === 302 ? { Location: '/trap' } : {});
    res.end(JSON.stringify(payload));
  });
  await listen(panel);
  t.onTestFinished(() => (panel.listening ? close(panel) : undefined));
  const socket = createServer();
  await listen(socket);
  const port = listeningPort(socket);
  await close(socket);
  const endpoint = 'https://127.0.0.1:' + port;
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-out', 'cert.pem', '-keyout', 'key.pem'], { cwd: dir });
  const cert = await readFile(join(dir, 'cert.pem'), 'utf8');
  const config = { id: 'test-node', endpoint, token: 'gatewayTokenForTestsAA', cert, key: await readFile(join(dir, 'key.pem'), 'utf8'), panel: { url: 'http://127.0.0.1:' + listeningPort(panel) + '/base/', token: upstreamToken } };
  saveConfig(dir, config);
  const code = pair(config);
  assert.match(code, /^inx-pair-/);
  assert.ok(code.length < 100, 'Pairing code must stay under 100 characters: ' + code.length);
  const identity = parsePair(code);
  assert.equal(identity.endpoint, endpoint);
  assert.equal(identity.token, config.token);
  const child = spawn(process.execPath, [cli], { env: { ...process.env, CREDENTIALS_DIRECTORY: dir }, windowsHide: true, stdio: 'ignore' });
  const stopped = new Promise(resolve => child.once('exit', resolve));
  t.onTestFinished(async () => {
    child.kill();
    await stopped;
  });
  let ca: string | undefined;
  for (let i = 0; i < 80; i++) {
    ca = await pinnedCert(endpoint, identity.pin).catch(() => undefined);
    if (ca) break;
    await delay(50);
  }
  assert.ok(ca, 'Gateway must present the pinned certificate');
  await assert.rejects(pinnedCert(endpoint, 'A'.repeat(43)), /does not match/);
  assert.equal((await request(endpoint, '/health', ca)).status, 200);
  await assert.rejects(request(endpoint, '/health', undefined));
  const before = hits;
  assert.equal((await request(endpoint, '/v1/inbounds', ca, 'wrong')).status, 401);
  assert.equal(hits, before);
  const call = () => request(endpoint, '/v1/inbounds', ca, identity.token);
  assert.deepEqual((await call()).body, { inbounds: [{ id: 1, remark: 'JP', enabled: true, protocol: 'vless', port: 443 }] });
  const info = (await request(endpoint, '/v1/info', ca, identity.token)).body;
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(info.id, config.id);
  assert.equal(info.version, manifest.version);
  assert.equal(await run('--version'), manifest.version);
  const upstreams: [number, string][] = [
    [403, 'PANEL_PERMISSION'],
    [401, 'PANEL_AUTH'],
    [404, 'PANEL_PATH'],
    [302, 'PANEL_RESPONSE']
  ];
  for (const [up, reason] of upstreams) {
    status = up;
    const n = hits;
    assert.deepEqual(await call(), { status: 502, body: { error: reason } });
    assert.equal(hits, n + 1);
  }
  status = 200;
  payload = { success: false, msg: upstreamToken };
  assert.deepEqual(await call(), { status: 502, body: { error: 'PANEL_RESPONSE' } });
  payload = { success: true, obj: [] };
  await close(panel);
  assert.deepEqual(await call(), { status: 502, body: { error: 'PANEL_UNREACHABLE' } });
  assert.throws(() => panelUrl('http://example.com'), /127\.0\.0\.1/);
});
