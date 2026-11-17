import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import type { Db } from './db.js';

export const sessionCookie = 'inx_session';
const sessionTtl = 30 * 86400_000;
const setupCodeTtl = 24 * 3600_000;
const loginWindow = 15 * 60_000;
const loginLimit = 10;

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

const passwordSchema = { type: 'string', minLength: 10, maxLength: 256 } as const;

export const isInitialized = (db: Db) => db.prepare('SELECT 1 FROM admin WHERE id = 1').get() !== undefined;

// Prints a one-time code that sets (or, with reset, replaces) the admin password through /setup.
export function createSetupCode(db: Db, reset = false, now = Date.now()) {
  if (isInitialized(db) && !reset) throw Error('INX Connect is already initialized. Use --reset to set a new admin password.');
  const code = randomToken(18);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM setup_codes').run();
    db.prepare('INSERT INTO setup_codes (code_hash, reset, expires_at) VALUES (?, ?, ?)').run(sha256(code), reset ? 1 : 0, now + setupCodeTtl);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return code;
}

function sessionFor(db: Db, req: FastifyRequest) {
  const token = req.cookies[sessionCookie];
  if (!token) return undefined;
  return db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), Date.now()) as { token_hash: string } | undefined;
}

function startSession(db: Db, req: FastifyRequest, reply: FastifyReply) {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(token), now, now + sessionTtl);
  reply.setCookie(sessionCookie, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https', maxAge: sessionTtl / 1000 });
}

export function registerAuth(app: FastifyInstance, db: Db) {
  const failures = new Map<string, { count: number; until: number }>();
  const limited = (ip: string) => {
    const entry = failures.get(ip);
    return entry !== undefined && entry.until > Date.now() && entry.count >= loginLimit;
  };
  const fail = (ip: string) => {
    const now = Date.now();
    const entry = failures.get(ip);
    if (!entry || entry.until <= now) failures.set(ip, { count: 1, until: now + loginWindow });
    else entry.count++;
    if (failures.size > 10_000) for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
  };

  // Every /api route requires a session unless it opts out with config.public.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (req.routeOptions.config.public) return;
    if (!sessionFor(db, req)) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  });

  app.get('/api/status', { config: { public: true } }, req => ({ initialized: isInitialized(db), authenticated: sessionFor(db, req) !== undefined }));

  app.post<{ Body: { code: string; password: string } }>(
    '/api/setup',
    { config: { public: true }, schema: { body: { type: 'object', required: ['code', 'password'], additionalProperties: false, properties: { code: { type: 'string', maxLength: 128 }, password: passwordSchema } } } },
    async (req, reply) => {
      if (limited(req.ip)) return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
      const row = db.prepare('SELECT reset FROM setup_codes WHERE code_hash = ? AND expires_at > ?').get(sha256(req.body.code), Date.now()) as { reset: number } | undefined;
      if (!row || (!row.reset && isInitialized(db))) {
        fail(req.ip);
        return reply.code(403).send({ error: 'INVALID_SETUP_CODE' });
      }
      const hash = await hashPassword(req.body.password);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO admin (id, password_hash, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at').run(hash, Date.now());
        db.prepare('DELETE FROM setup_codes').run();
        db.prepare('DELETE FROM sessions').run();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      startSession(db, req, reply);
      return { ok: true };
    }
  );

  app.post<{ Body: { password: string } }>(
    '/api/auth/login',
    { config: { public: true }, schema: { body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 256 } } } } },
    async (req, reply) => {
      if (limited(req.ip)) return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
      const admin = db.prepare('SELECT password_hash FROM admin WHERE id = 1').get() as { password_hash: string } | undefined;
      if (!admin) return reply.code(409).send({ error: 'NOT_INITIALIZED' });
      if (!(await verifyPassword(req.body.password, admin.password_hash))) {
        fail(req.ip);
        return reply.code(401).send({ error: 'INVALID_PASSWORD' });
      }
      failures.delete(req.ip);
      startSession(db, req, reply);
      return { ok: true };
    }
  );

  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    const token = req.cookies[sessionCookie];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(sessionCookie, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', () => ({ ok: true }));
}
