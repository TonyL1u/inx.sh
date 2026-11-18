import { resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';

import { type GatewayInbound, type Pairing, parsePair } from '@inx.sh/gateway/protocol';
import type { FastifyInstance } from 'fastify';

import { seal, unseal } from './crypto.js';
import type { Db } from './db.js';
import { ApiError } from './errors.js';
import { bindDomain, fetchPinnedCertificate, GatewayError, type GatewayTarget, getDomain, getInfo, listInbounds, unbindDomain } from './gateway.js';

interface MachineRow {
  id: number;
  node_id: string;
  name: string;
  endpoint: string;
  cert_pin: string;
  cert_pem: string;
  token_sealed: string;
  gateway_version: string;
  capabilities: string;
  inbounds: string;
  synced_at: number;
  checked_at: number;
  last_error: string | null;
  created_at: number;
  domain: string | null;
}

export interface Machine {
  id: number;
  nodeId: string;
  name: string;
  endpoint: string;
  gatewayVersion: string;
  capabilities: string[];
  /** online: the last check succeeded. error: it failed with lastError; inbounds are from syncedAt. */
  status: 'online' | 'error';
  lastError: string | null;
  inboundCount: number;
  syncedAt: number;
  checkedAt: number;
  createdAt: number;
  /** The 3x-ui panel certificate domain the node's share links use; null: they use the IP. */
  domain: string | null;
}

export interface MachineInbound {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enabled: boolean;
  /** null when the Gateway predates client listing (no inbounds:clients capability). */
  clients: { email: string; enabled: boolean; linkCount: number; unsupported: string | null; nodeId: number | null }[] | null;
}

export interface MachineDetail {
  machine: Machine;
  inbounds: MachineInbound[];
  usage: { nodes: number; subscriptions: number };
}

/** Replaceable in tests. */
export const dnsResolver = { resolve4: (name: string) => resolve4(name) };

const tokenContext = (nodeId: string) => `machine:${nodeId}:token`;
const nameLimit = 64;

function view(row: MachineRow): Machine {
  return {
    id: row.id,
    nodeId: row.node_id,
    name: row.name,
    endpoint: row.endpoint,
    gatewayVersion: row.gateway_version,
    capabilities: JSON.parse(row.capabilities) as string[],
    status: row.last_error ? 'error' : 'online',
    lastError: row.last_error,
    inboundCount: (JSON.parse(row.inbounds) as unknown[]).length,
    syncedAt: row.synced_at,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    domain: row.domain
  };
}

function cleanName(name: string | undefined) {
  const trimmed = name?.trim().replace(/\s+/g, ' ');
  if (trimmed === undefined || trimmed === '') return undefined;
  if ([...trimmed].length > nameLimit) throw new ApiError(400, 'INVALID_NAME');
  return trimmed;
}

const asFailure = (e: unknown) => {
  if (e instanceof GatewayError) return new ApiError(502, e.code);
  throw e;
};

export class Machines {
  private readonly inFlight = new Map<number, Promise<Machine>>();

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly now = Date.now
  ) {}

  private row(id: number) {
    const row = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as MachineRow | undefined;
    if (!row) throw new ApiError(404, 'MACHINE_NOT_FOUND');
    return row;
  }

  private target(row: MachineRow): GatewayTarget {
    return { endpoint: row.endpoint, pin: row.cert_pin, cert: row.cert_pem, token: unseal(this.key, row.token_sealed, tokenContext(row.node_id)) };
  }

  list() {
    return (this.db.prepare('SELECT * FROM machines ORDER BY created_at, id').all() as unknown as MachineRow[]).map(view);
  }

  /** Machine, its inbound snapshot with clients (links stay server-side), and what depends on it. */
  get(id: number): MachineDetail {
    const row = this.row(id);
    const imported = new Map(
      (this.db.prepare('SELECT id, inbound_id, client_email FROM nodes WHERE machine_id = ?').all(id) as { id: number; inbound_id: number; client_email: string }[]).map(n => [n.inbound_id + '\n' + n.client_email.toLowerCase(), n.id])
    );
    const inbounds = (JSON.parse(row.inbounds) as GatewayInbound[]).map(ib => ({
      id: ib.id,
      remark: ib.remark,
      protocol: ib.protocol,
      port: ib.port,
      enabled: ib.enabled,
      clients: ib.clients?.map(c => ({ email: c.email, enabled: c.enabled, linkCount: c.links.length, unsupported: c.unsupported ?? null, nodeId: imported.get(ib.id + '\n' + c.email.toLowerCase()) ?? null })) ?? null
    }));
    const usage = this.db.prepare('SELECT COUNT(DISTINCT n.id) AS nodes, COUNT(DISTINCT sn.subscription_id) AS subscriptions FROM nodes n LEFT JOIN subscription_nodes sn ON sn.node_id = n.id WHERE n.machine_id = ?').get(id) as {
      nodes: number;
      subscriptions: number;
    };
    return { machine: view(row), inbounds, usage: { nodes: usage.nodes, subscriptions: usage.subscriptions } };
  }

  // Verifies a pairing code end to end: pinned certificate, token, node identity, and a first inbound sync.
  private async probe(code: string) {
    let pairing: Pairing;
    try {
      pairing = parsePair(code.trim());
    } catch {
      throw new ApiError(400, 'INVALID_PAIR_CODE');
    }
    try {
      const cert = await fetchPinnedCertificate(pairing.endpoint, pairing.pin);
      const target: GatewayTarget = { ...pairing, cert };
      const info = await getInfo(target);
      const inbounds = await listInbounds(target);
      const domain = info.capabilities.includes('domain') ? ((await getDomain(target).catch(() => undefined))?.domain ?? null) : null;
      return { target, info, inbounds, domain };
    } catch (e) {
      throw asFailure(e);
    }
  }

  /** Adds a machine, or refreshes the credentials of an already paired node (same node ID). */
  async pair(code: string, name?: string, expectedNodeId?: string) {
    const label = cleanName(name);
    const { target, info, inbounds, domain } = await this.probe(code);
    if (expectedNodeId !== undefined && info.id !== expectedNodeId) throw new ApiError(409, 'NODE_MISMATCH');
    const now = this.now();
    const existing = this.db.prepare('SELECT id FROM machines WHERE node_id = ?').get(info.id) as { id: number } | undefined;
    const row = this.db
      .prepare(
        `INSERT INTO machines (node_id, name, endpoint, cert_pin, cert_pem, token_sealed, gateway_version, capabilities, inbounds, domain, synced_at, checked_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (node_id) DO UPDATE SET
           name = CASE WHEN ? IS NULL THEN machines.name ELSE excluded.name END,
           endpoint = excluded.endpoint, cert_pin = excluded.cert_pin, cert_pem = excluded.cert_pem, token_sealed = excluded.token_sealed,
           gateway_version = excluded.gateway_version, capabilities = excluded.capabilities, inbounds = excluded.inbounds, domain = excluded.domain,
           synced_at = excluded.synced_at, checked_at = excluded.checked_at, last_error = NULL
         RETURNING *`
      )
      .get(
        info.id,
        label ?? new URL(target.endpoint).hostname.replace(/^\[|\]$/g, ''),
        target.endpoint,
        target.pin,
        target.cert,
        seal(this.key, target.token, tokenContext(info.id)),
        info.version,
        JSON.stringify(info.capabilities),
        JSON.stringify(inbounds),
        domain,
        now,
        now,
        now,
        label ?? null
      ) as unknown as MachineRow;
    return { ...this.get(row.id), repaired: existing !== undefined };
  }

  /** Replaces the credentials of a machine with a new pairing code from the same node. */
  repair(id: number, code: string) {
    return this.pair(code, undefined, this.row(id).node_id);
  }

  rename(id: number, name: string) {
    const label = cleanName(name);
    if (!label) throw new ApiError(400, 'INVALID_NAME');
    this.row(id);
    this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(label, id);
    return view(this.row(id));
  }

  remove(id: number) {
    this.row(id);
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  }

  /** Refreshes one machine. Failures are recorded on the machine (status error), not thrown. */
  sync(id: number): Promise<Machine> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const run = this.syncNow(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, run);
    return run;
  }

  private async syncNow(id: number) {
    const row = this.row(id);
    try {
      const target = this.target(row);
      const info = await getInfo(target);
      if (info.id !== row.node_id) throw new GatewayError('GATEWAY_IDENTITY');
      const inbounds = await listInbounds(target);
      // The domain is read from x-ui each time, so one set or changed in x-ui shows up here too.
      const domain = info.capabilities.includes('domain') ? ((await getDomain(target).catch(() => undefined))?.domain ?? null) : row.domain;
      const now = this.now();
      this.db
        .prepare('UPDATE machines SET gateway_version = ?, capabilities = ?, inbounds = ?, domain = ?, synced_at = ?, checked_at = ?, last_error = NULL WHERE id = ?')
        .run(info.version, JSON.stringify(info.capabilities), JSON.stringify(inbounds), domain, now, now, id);
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : 'GATEWAY_RESPONSE';
      this.db.prepare('UPDATE machines SET checked_at = ?, last_error = ? WHERE id = ?').run(this.now(), code, id);
    }
    return view(this.row(id));
  }

  private domainTarget(id: number) {
    const row = this.row(id);
    if (!(JSON.parse(row.capabilities) as string[]).includes('domain')) throw new ApiError(409, 'GATEWAY_UPGRADE_REQUIRED');
    return { row, target: this.target(row) };
  }

  /** Live domain state from the Gateway. When a bind has just finished, the snapshot is refreshed so links follow. */
  async domain(id: number) {
    const { row, target } = this.domainTarget(id);
    const status = await getDomain(target).catch(e => {
      throw asFailure(e);
    });
    if (status.domain !== row.domain) await this.sync(id);
    return status;
  }

  /** Runs x-ui's SSL flow on the node for `domain`, after checking that the domain points at the node. */
  async bindDomain(id: number, domain: string, force = false) {
    const { row, target } = this.domainTarget(id);
    const name = domain.trim().toLowerCase();
    const nodeHost = new URL(row.endpoint).hostname.replace(/^\[|\]$/g, '');
    const [resolved, expected] = await Promise.all([dnsResolver.resolve4(name).catch(() => [] as string[]), isIP(nodeHost) ? [nodeHost] : dnsResolver.resolve4(nodeHost).catch(() => [] as string[])]);
    if (!force && !resolved.some(ip => expected.includes(ip))) throw new ApiError(409, 'DOMAIN_DNS_MISMATCH', { resolved, expected });
    await bindDomain(target, name).catch(e => {
      throw asFailure(e);
    });
  }

  async unbindDomain(id: number) {
    const { target } = this.domainTarget(id);
    await unbindDomain(target).catch(e => {
      throw asFailure(e);
    });
  }

  async syncAll(concurrency = 4) {
    const ids = (this.db.prepare('SELECT id FROM machines ORDER BY id').all() as { id: number }[]).map(r => r.id);
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      for (let id = ids.shift(); id !== undefined; id = ids.shift()) await this.sync(id).catch(() => undefined);
    });
    await Promise.all(workers);
  }
}

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;
const pairCode = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const name = { type: 'string', maxLength: 256 } as const;

export function registerMachines(app: FastifyInstance, machines: Machines, syncIntervalMs: number) {
  app.get('/api/machines', () => ({ machines: machines.list() }));
  app.get<{ Params: { id: number } }>('/api/machines/:id', { schema: { params: idParams } }, req => machines.get(req.params.id));

  app.post<{ Body: { pairCode: string; name?: string } }>('/api/machines', { schema: { body: { type: 'object', required: ['pairCode'], additionalProperties: false, properties: { pairCode, name } } } }, async (req, reply) => {
    const result = await machines.pair(req.body.pairCode, req.body.name);
    return reply.code(result.repaired ? 200 : 201).send(result);
  });

  app.patch<{ Params: { id: number }; Body: { name?: string; pairCode?: string } }>(
    '/api/machines/:id',
    { schema: { params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { pairCode, name } } } },
    async req => {
      if (req.body.pairCode !== undefined) await machines.repair(req.params.id, req.body.pairCode);
      if (req.body.name !== undefined) machines.rename(req.params.id, req.body.name);
      return machines.get(req.params.id);
    }
  );

  app.delete<{ Params: { id: number } }>('/api/machines/:id', { schema: { params: idParams } }, async (req, reply) => {
    machines.remove(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: number } }>('/api/machines/:id/sync', { schema: { params: idParams } }, async req => {
    await machines.sync(req.params.id);
    return machines.get(req.params.id);
  });

  const domainBody = { type: 'object', required: ['domain'], additionalProperties: false, properties: { domain: { type: 'string', minLength: 3, maxLength: 253 }, force: { type: 'boolean' } } } as const;
  app.get<{ Params: { id: number } }>('/api/machines/:id/domain', { schema: { params: idParams } }, req => machines.domain(req.params.id));
  app.post<{ Params: { id: number }; Body: { domain: string; force?: boolean } }>('/api/machines/:id/domain', { schema: { params: idParams, body: domainBody } }, async (req, reply) => {
    await machines.bindDomain(req.params.id, req.body.domain, req.body.force);
    return reply.code(202).send(await machines.domain(req.params.id));
  });
  app.delete<{ Params: { id: number } }>('/api/machines/:id/domain', { schema: { params: idParams } }, async (req, reply) => {
    await machines.unbindDomain(req.params.id);
    return reply.code(202).send(await machines.domain(req.params.id));
  });

  if (syncIntervalMs > 0) {
    let running: Promise<void> | undefined;
    const timer = setInterval(() => {
      running ??= machines.syncAll().finally(() => (running = undefined));
    }, syncIntervalMs);
    timer.unref();
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await running;
    });
  }
}
