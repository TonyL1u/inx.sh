import { join } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';

import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ApiError } from './errors.js';
import { Machines, registerMachines } from './machines.js';
import { version } from './version.js';

const csp = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function buildApp(config: Pick<Config, 'consoleDir' | 'trustProxy' | 'secretKey' | 'syncIntervalMs'>, db: Db) {
  const app = Fastify({ trustProxy: config.trustProxy, bodyLimit: 256 * 1024, logger: process.env.NODE_ENV === 'production' ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false });
  // Only JSON bodies: text/plain is a CORS "simple" content type and would allow cross-site form posts.
  app.removeContentTypeParser('text/plain');
  await app.register(fastifyCookie);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // Every error leaves as { error: CODE }; unexpected ones are logged and reported as INTERNAL.
  app.setErrorHandler((e: FastifyError, req, reply) => {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: e.code });
    if (e.validation) return reply.code(400).send({ error: 'INVALID_REQUEST', message: e.message });
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) req.log.error(e);
    return reply.code(status).send({ error: status >= 500 ? 'INTERNAL' : (e.code ?? 'BAD_REQUEST') });
  });

  app.get('/health', () => ({ service: 'inx-connect', apiVersion: 1, version }));
  registerAuth(app, db);
  registerMachines(app, new Machines(db, config.secretKey), config.syncIntervalMs);

  if (config.consoleDir) {
    const consoleDir = config.consoleDir;
    await app.register(fastifyStatic, {
      root: consoleDir,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        // Vite emits content-hashed assets; everything else must revalidate.
        reply.header('Cache-Control', path.startsWith(join(consoleDir, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    // Client-side routes fall back to the console shell; API and subscription paths never do.
    if (config.consoleDir && (req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/') && !path.startsWith('/sub/') && !/\.[a-z0-9]+$/i.test(path)) {
      reply.header('Content-Security-Policy', csp).header('X-Frame-Options', 'DENY').header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'NOT_FOUND' });
  });

  return app;
}
