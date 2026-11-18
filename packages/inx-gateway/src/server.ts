import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';

import type { Config } from './config.js';
import { domainStatus, isDomain, requestDomain, requestDomainRemoval } from './domain.js';
import { inboundView, listInbounds, panelDomain, PanelError } from './panel.js';
import type { GatewayDomain, GatewayInbound, GatewayInfo } from './protocol.js';
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
      routes.get('/info', (): GatewayInfo => ({ id: config.id, service: 'inx-gateway', apiVersion: 1, version, capabilities: ['inbounds:list', 'inbounds:clients', 'domain'] }));
      routes.get('/inbounds', async (_req, reply) => {
        try {
          const rows = await listInbounds(config.panel);
          // Links advertise the panel certificate's domain when x-ui has one, otherwise the public IP.
          const publicHost = (await panelDomain(config.panel).catch(() => undefined)) ?? new URL(config.endpoint).hostname.replace(/^\[|\]$/g, '');
          const inbounds: GatewayInbound[] = rows.map(row => inboundView(row, publicHost));
          return { inbounds };
        } catch (e) {
          const code = e instanceof PanelError ? e.code : 'PANEL_UNREACHABLE';
          return reply.code(code === 'PANEL_TIMEOUT' ? 504 : 502).send({ error: code });
        }
      });
      routes.get('/domain', async (): Promise<GatewayDomain> => ({ domain: (await panelDomain(config.panel).catch(() => undefined)) ?? null, ...domainStatus() }));
      // Binding runs x-ui's own SSL flow as root (scripts/xui-domain.sh via inx-gateway-domain.path); this only queues it.
      routes.post<{ Body: { domain?: unknown } }>('/domain', async (req, reply) => {
        const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
        if (!isDomain(domain)) return reply.code(400).send({ error: 'DOMAIN_INVALID' });
        if (domainStatus().state === 'pending') return reply.code(409).send({ error: 'DOMAIN_BUSY' });
        try {
          requestDomain(domain);
        } catch {
          // No runtime directory: the service unit predates domain support. Rerunning `inx-gateway start` installs it.
          return reply.code(409).send({ error: 'DOMAIN_UNAVAILABLE' });
        }
        return reply.code(202).send({ state: 'pending', requested: domain });
      });
      routes.delete('/domain', async (_req, reply) => {
        if (domainStatus().state === 'pending') return reply.code(409).send({ error: 'DOMAIN_BUSY' });
        try {
          requestDomainRemoval();
        } catch {
          return reply.code(409).send({ error: 'DOMAIN_UNAVAILABLE' });
        }
        return reply.code(202).send({ state: 'pending' });
      });
    },
    { prefix: '/v1' }
  );
  return app;
}
