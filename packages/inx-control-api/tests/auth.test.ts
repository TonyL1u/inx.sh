import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, type TestContext } from 'vitest';

import { buildApp } from '../src/app.js';
import { createSetupCode } from '../src/auth.js';
import { openDb } from '../src/db.js';

const key = randomBytes(32);

async function server(t: TestContext, consoleDir?: string) {
  const db = openDb(':memory:', key);
  const app = await buildApp({ consoleDir, trustProxy: [] }, db);
  t.onTestFinished(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('setup requires the one-time code, then signs in', async t => {
  const { app, db } = await server(t);
  assert.deepEqual((await app.inject('/api/status')).json(), { initialized: false, authenticated: false });
  assert.equal((await app.inject('/api/auth/me')).statusCode, 401);

  const code = createSetupCode(db);
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup', ...json({ code: 'wrong', password: 'correct horse' }) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup', ...json({ code, password: 'short' }) })).statusCode, 400);

  const setup = await app.inject({ method: 'POST', url: '/api/setup', ...json({ code, password: 'correct horse' }) });
  assert.equal(setup.statusCode, 200);
  const setCookie = String(setup.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = cookieOf(setup);
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode, 200);

  // The code is single-use and an initialized console cannot be taken over with a fresh non-reset code.
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup', ...json({ code, password: 'another password' }) })).statusCode, 403);
  assert.throws(() => createSetupCode(db), /already initialized/);
});

test('password login, logout, and reset codes', async t => {
  const { app, db } = await server(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'x' }) })).statusCode, 409);
  await app.inject({ method: 'POST', url: '/api/setup', ...json({ code: createSetupCode(db), password: 'first password' }) });

  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'wrong password' }) })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'first password' }) });
  assert.equal(login.statusCode, 200);
  const cookie = cookieOf(login);
  assert.deepEqual((await app.inject({ url: '/api/status', headers: { cookie } })).json(), { initialized: true, authenticated: true });

  // A reset code replaces the password and ends every existing session.
  const reset = createSetupCode(db, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup', ...json({ code: reset, password: 'second password' }) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'first password' }) })).statusCode, 401);

  const again = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'second password' }) }));
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: again } });
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie: again } })).statusCode, 401);
});

test('login attempts are rate limited per client', async t => {
  const { app, db } = await server(t);
  await app.inject({ method: 'POST', url: '/api/setup', ...json({ code: createSetupCode(db), password: 'the password' }) });
  for (let i = 0; i < 10; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'guess ' + i }) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', ...json({ password: 'the password' }) })).statusCode, 429);
});

test('text/plain bodies are rejected so cross-site forms cannot post', async t => {
  const { app, db } = await server(t);
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: JSON.stringify({ code: createSetupCode(db), password: 'correct horse' }), headers: { 'content-type': 'text/plain' } });
  assert.equal(res.statusCode, 415);
});

test('console routes fall back to index.html; API and subscription paths do not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'inx-console-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>INX</title>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'export {}');
  const { app } = await server(t, dir);

  const page = await app.inject('/machines');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<title>INX<\/title>/);
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);

  const asset = await app.inject('/assets/app-abc.js');
  assert.equal(asset.statusCode, 200);
  assert.match(String(asset.headers['cache-control']), /immutable/);

  assert.equal((await app.inject('/assets/missing.js')).statusCode, 404);
  assert.equal((await app.inject('/api/unknown')).statusCode, 401);
  assert.equal((await app.inject('/sub/abc')).statusCode, 404);
  assert.equal((await app.inject('/health')).json().service, 'inx-connect');
});
