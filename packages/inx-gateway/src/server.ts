import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';

import type { Config } from './config.js';
import { listInbounds, PanelError } from './panel.js';
import { version } from './version.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function createGateway(config: Config) {
  const app = Fastify({ https: { cert: config.cert, key: config.key, minVersion: 'TLSv1.2' }, logger: false, requestTimeout: 10000 });
  const expected = digest('Bearer ' + config.token);
  app.get('/health', () => ({ service: 'inx-gateway', apiVersion: 1 }));
  app.register(
    async routes => {
      routes.addHook('onRequest', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) return reply.code(401).send({ error: 'GATEWAY_AUTH' });
      });
      routes.get('/info', () => ({ id: config.id, service: 'inx-gateway', apiVersion: 1, version, capabilities: ['inbounds:list'] }));
      routes.get('/inbounds', async (_req, reply) => {
        try {
          return { inbounds: await listInbounds(config.panel) };
        } catch (e) {
          const code = e instanceof PanelError ? e.code : 'PANEL_UNREACHABLE';
          return reply.code(code === 'PANEL_TIMEOUT' ? 504 : 502).send({ error: code });
        }
      });
    },
    { prefix: '/v1' }
  );
  return app;
}
