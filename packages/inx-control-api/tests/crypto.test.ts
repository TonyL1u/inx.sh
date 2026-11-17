import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { hashPassword, parseSecretKey, seal, unseal, verifyPassword } from '../src/crypto.js';
import { openDb } from '../src/db.js';

test('sealed values round-trip only with the same key and context', () => {
  const key = randomBytes(32);
  const sealed = seal(key, 'gateway-token', 'machine:1:token');
  assert.notEqual(sealed, seal(key, 'gateway-token', 'machine:1:token'));
  assert.equal(unseal(key, sealed, 'machine:1:token'), 'gateway-token');
  assert.throws(() => unseal(key, sealed, 'machine:2:token'));
  assert.throws(() => unseal(randomBytes(32), sealed, 'machine:1:token'));
});

test('secret keys accept hex or base64url and must be 32 bytes', () => {
  const key = randomBytes(32);
  assert.deepEqual(parseSecretKey(key.toString('hex')), key);
  assert.deepEqual(parseSecretKey(key.toString('base64url')), key);
  assert.throws(() => parseSecretKey('too-short'), /32 bytes/);
});

test('password hashes verify only the original password', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
});

test('the database refuses to open with a different secret key', t => {
  const dir = mkdtempSync(join(tmpdir(), 'inx-db-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inx.sqlite');
  const key = randomBytes(32);
  openDb(path, key).close();
  openDb(path, key).close();
  assert.throws(() => openDb(path, randomBytes(32)), /does not match/);
});
