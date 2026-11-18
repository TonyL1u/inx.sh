import type { GatewayInbound } from '@inx.sh/gateway/protocol';
import type { FastifyInstance } from 'fastify';

import { randomToken } from './crypto.js';
import type { Db } from './db.js';
import { ApiError } from './errors.js';

/**
 * ok: links available. Otherwise the node is left out of every subscription:
 * missing (inbound or client no longer on the machine), disabled (inbound or client switched off in 3x-ui),
 * unsupported (the Gateway cannot build links for it), unknown (the Gateway predates client listing).
 */
export type NodeStatus = 'ok' | 'missing' | 'disabled' | 'unsupported' | 'unknown';

export interface NodeView {
  id: number;
  name: string;
  machineId: number;
  machineName: string;
  machineStatus: 'online' | 'error';
  inboundId: number;
  inboundRemark: string | null;
  protocol: string | null;
  port: number | null;
  clientEmail: string;
  status: NodeStatus;
  unsupported: string | null;
  linkCount: number;
  subscriptionCount: number;
  createdAt: number;
}

/** A client picked by address: machine, inbound, client email (case-insensitive). */
export interface ClientRef {
  machineId: number;
  inboundId: number;
  email: string;
}

/** Every machine's clients, for picking subscription members. Links stay server-side. */
export interface ClientTreeMachine {
  id: number;
  name: string;
  status: 'online' | 'error';
  /** false: the Gateway predates client listing. */
  clientsListed: boolean;
  inbounds: {
    id: number;
    remark: string;
    protocol: string;
    port: number;
    enabled: boolean;
    clients: { email: string; enabled: boolean; unsupported: string | null; linkCount: number; nodeId: number | null; nodeName: string | null }[];
  }[];
}

export interface SubscriptionView {
  id: number;
  name: string;
  token: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

interface NodeRow {
  id: number;
  name: string;
  machine_id: number;
  machine_name: string;
  last_error: string | null;
  inbounds: string;
  inbound_id: number;
  client_email: string;
  subscription_count: number;
  created_at: number;
}

const nameLimit = 64;

/** "<machine> <inbound>", without repeating a machine name the inbound remark already has; the client when the inbound has several. */
function defaultNodeName(machine: string, inbound: GatewayInbound, email: string) {
  const label = inbound.remark || inbound.protocol.toUpperCase();
  let name = label.toLowerCase().includes(machine.toLowerCase()) ? label : `${machine} ${label}`;
  if ((inbound.clients?.length ?? 0) > 1) name += ` · ${email}`;
  return cleanName([...name].slice(0, nameLimit).join(''), true)!;
}
const membersLimit = 500;

function cleanName(name: string | undefined, required: boolean) {
  const trimmed = name?.trim().replace(/\s+/g, ' ') ?? '';
  if (trimmed === '') {
    if (required) throw new ApiError(400, 'INVALID_NAME');
    return undefined;
  }
  if ([...trimmed].length > nameLimit) throw new ApiError(400, 'INVALID_NAME');
  return trimmed;
}

/** Match a node against its machine's snapshot. Emails are case-insensitive in 3x-ui. */
function resolve(row: Pick<NodeRow, 'inbounds' | 'inbound_id' | 'client_email'>) {
  const inbound = (JSON.parse(row.inbounds) as GatewayInbound[]).find(ib => ib.id === row.inbound_id);
  const client = inbound?.clients?.find(c => c.email.toLowerCase() === row.client_email.toLowerCase());
  let status: NodeStatus;
  if (!inbound) status = 'missing';
  else if (!inbound.clients) status = 'unknown';
  else if (!client) status = 'missing';
  else if (client.unsupported) status = 'unsupported';
  else if (!inbound.enabled || !client.enabled) status = 'disabled';
  else status = client.links.length > 0 ? 'ok' : 'unsupported';
  return { inbound, client, status };
}

/** Replace a share link's display name: the #fragment, or `ps` inside a vmess:// payload. */
export function renameLink(link: string, name: string) {
  if (link.startsWith('vmess://')) {
    try {
      const payload = JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8')) as Record<string, unknown>;
      return 'vmess://' + Buffer.from(JSON.stringify({ ...payload, ps: name }, null, 2)).toString('base64');
    } catch {
      return link;
    }
  }
  const hash = link.indexOf('#');
  return (hash < 0 ? link : link.slice(0, hash)) + '#' + encodeURIComponent(name);
}

const nodeSelect = `SELECT n.id, n.name, n.machine_id, m.name AS machine_name, m.last_error, m.inbounds, n.inbound_id, n.client_email, n.created_at,
  (SELECT COUNT(*) FROM subscription_nodes sn WHERE sn.node_id = n.id) AS subscription_count
  FROM nodes n JOIN machines m ON m.id = n.machine_id`;

function nodeView(row: NodeRow): NodeView {
  const { inbound, client, status } = resolve(row);
  return {
    id: row.id,
    name: row.name,
    machineId: row.machine_id,
    machineName: row.machine_name,
    machineStatus: row.last_error ? 'error' : 'online',
    inboundId: row.inbound_id,
    inboundRemark: inbound?.remark ?? null,
    protocol: inbound?.protocol ?? null,
    port: inbound?.port ?? null,
    clientEmail: client?.email ?? row.client_email,
    status,
    unsupported: client?.unsupported ?? null,
    linkCount: client?.links.length ?? 0,
    subscriptionCount: row.subscription_count,
    createdAt: row.created_at
  };
}

export class Catalog {
  constructor(
    private readonly db: Db,
    private readonly now = Date.now
  ) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- clients (the picker's view: nodes are created on demand)

  clientTree(): ClientTreeMachine[] {
    const machines = this.db.prepare('SELECT id, name, last_error, inbounds FROM machines ORDER BY created_at, id').all() as { id: number; name: string; last_error: string | null; inbounds: string }[];
    const nodes = this.db.prepare('SELECT id, name, machine_id, inbound_id, client_email FROM nodes').all() as { id: number; name: string; machine_id: number; inbound_id: number; client_email: string }[];
    const byKey = new Map(nodes.map(n => [`${n.machine_id}\n${n.inbound_id}\n${n.client_email.toLowerCase()}`, n]));
    return machines.map(m => {
      const inbounds = JSON.parse(m.inbounds) as GatewayInbound[];
      return {
        id: m.id,
        name: m.name,
        status: m.last_error ? 'error' : 'online',
        clientsListed: inbounds.every(ib => ib.clients !== undefined),
        inbounds: inbounds.map(ib => ({
          id: ib.id,
          remark: ib.remark,
          protocol: ib.protocol,
          port: ib.port,
          enabled: ib.enabled,
          clients: (ib.clients ?? []).map(c => {
            const node = byKey.get(`${m.id}\n${ib.id}\n${c.email.toLowerCase()}`);
            return { email: c.email, enabled: c.enabled, unsupported: c.unsupported ?? null, linkCount: c.links.length, nodeId: node?.id ?? null, nodeName: node?.name ?? null };
          })
        }))
      };
    });
  }

  /** The node for a client, created with the default name the first time the client is picked. */
  private ensureNode(ref: ClientRef) {
    const existing = this.db.prepare('SELECT id FROM nodes WHERE machine_id = ? AND inbound_id = ? AND client_email = ? COLLATE NOCASE').get(ref.machineId, ref.inboundId, ref.email) as { id: number } | undefined;
    return existing?.id ?? this.createNode({ machineId: ref.machineId, inboundId: ref.inboundId, clientEmail: ref.email }).id;
  }

  /** Sets a subscription's members from picked clients, in the given order. */
  setClients(id: number, refs: ClientRef[]) {
    this.subscriptionRow(id);
    return this.setMembers(
      id,
      this.transaction(() => refs.map(ref => this.ensureNode(ref)))
    );
  }

  // ---- nodes

  listNodes(machineId?: number) {
    const rows = (machineId === undefined ? this.db.prepare(nodeSelect + ' ORDER BY m.name, n.name, n.id').all() : this.db.prepare(nodeSelect + ' WHERE n.machine_id = ? ORDER BY n.name, n.id').all(machineId)) as unknown as NodeRow[];
    return rows.map(nodeView);
  }

  getNode(id: number) {
    const row = this.db.prepare(nodeSelect + ' WHERE n.id = ?').get(id) as NodeRow | undefined;
    if (!row) throw new ApiError(404, 'NODE_NOT_FOUND');
    return nodeView(row);
  }

  createNode(input: { machineId: number; inboundId: number; clientEmail: string; name?: string }) {
    const machine = this.db.prepare('SELECT name, inbounds FROM machines WHERE id = ?').get(input.machineId) as { name: string; inbounds: string } | undefined;
    if (!machine) throw new ApiError(404, 'MACHINE_NOT_FOUND');
    const { inbound, client, status } = resolve({ inbounds: machine.inbounds, inbound_id: input.inboundId, client_email: input.clientEmail });
    if (!inbound) throw new ApiError(404, 'INBOUND_NOT_FOUND');
    if (status === 'unknown') throw new ApiError(409, 'GATEWAY_UPGRADE_REQUIRED');
    if (!client) throw new ApiError(404, 'CLIENT_NOT_FOUND');
    const name = cleanName(input.name, false) ?? defaultNodeName(machine.name, inbound, client.email);
    const existing = this.db.prepare('SELECT id FROM nodes WHERE machine_id = ? AND inbound_id = ? AND client_email = ? COLLATE NOCASE').get(input.machineId, inbound.id, client.email) as { id: number } | undefined;
    if (existing) throw new ApiError(409, 'NODE_EXISTS');
    const { id } = this.db.prepare('INSERT INTO nodes (machine_id, inbound_id, client_email, name, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id').get(input.machineId, inbound.id, client.email, name, this.now()) as { id: number };
    return this.getNode(id);
  }

  renameNode(id: number, name: string) {
    this.getNode(id);
    this.db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run(cleanName(name, true)!, id);
    this.touchSubscriptionsOf(id);
    return this.getNode(id);
  }

  deleteNode(id: number) {
    this.getNode(id);
    this.transaction(() => {
      this.touchSubscriptionsOf(id);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    });
  }

  private touchSubscriptionsOf(nodeId: number) {
    this.db.prepare('UPDATE subscriptions SET updated_at = ? WHERE id IN (SELECT subscription_id FROM subscription_nodes WHERE node_id = ?)').run(this.now(), nodeId);
  }

  // ---- subscriptions

  private subscriptionRow(id: number) {
    const row = this.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM subscription_nodes sn WHERE sn.subscription_id = s.id) AS node_count FROM subscriptions s WHERE s.id = ?').get(id) as
      { id: number; name: string; token: string; node_count: number; created_at: number; updated_at: number } | undefined;
    if (!row) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND');
    return row;
  }

  private subscriptionView(row: ReturnType<Catalog['subscriptionRow']>): SubscriptionView {
    return { id: row.id, name: row.name, token: row.token, nodeCount: row.node_count, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  listSubscriptions() {
    const ids = this.db.prepare('SELECT id FROM subscriptions ORDER BY created_at, id').all() as { id: number }[];
    return ids.map(({ id }) => this.subscriptionView(this.subscriptionRow(id)));
  }

  getSubscription(id: number) {
    const subscription = this.subscriptionView(this.subscriptionRow(id));
    const rows = this.db.prepare(nodeSelect + ' JOIN subscription_nodes sn ON sn.node_id = n.id WHERE sn.subscription_id = ? ORDER BY sn.position').all(id) as unknown as NodeRow[];
    return { subscription, nodes: rows.map(nodeView) };
  }

  createSubscription(name: string, clients: ClientRef[] = []) {
    const now = this.now();
    const label = cleanName(name, true)!;
    return this.transaction(() => {
      const { id } = this.db.prepare('INSERT INTO subscriptions (name, token, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id').get(label, randomToken(24), now, now) as { id: number };
      const nodeIds = clients.map(ref => this.ensureNode(ref));
      if (new Set(nodeIds).size !== nodeIds.length || nodeIds.length > membersLimit) throw new ApiError(400, 'INVALID_MEMBERS');
      const insert = this.db.prepare('INSERT INTO subscription_nodes (subscription_id, node_id, position) VALUES (?, ?, ?)');
      nodeIds.forEach((nodeId, position) => insert.run(id, nodeId, position));
      return id;
    });
  }

  renameSubscription(id: number, name: string) {
    this.subscriptionRow(id);
    this.db.prepare('UPDATE subscriptions SET name = ?, updated_at = ? WHERE id = ?').run(cleanName(name, true)!, this.now(), id);
    return this.getSubscription(id);
  }

  /** Replaces the members in the given order. Nodes may come from any machine and be shared between subscriptions. */
  setMembers(id: number, nodeIds: number[]) {
    this.subscriptionRow(id);
    if (new Set(nodeIds).size !== nodeIds.length || nodeIds.length > membersLimit) throw new ApiError(400, 'INVALID_MEMBERS');
    for (const nodeId of nodeIds) if (!this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId)) throw new ApiError(404, 'NODE_NOT_FOUND');
    this.transaction(() => {
      this.db.prepare('DELETE FROM subscription_nodes WHERE subscription_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO subscription_nodes (subscription_id, node_id, position) VALUES (?, ?, ?)');
      nodeIds.forEach((nodeId, position) => insert.run(id, nodeId, position));
      this.db.prepare('UPDATE subscriptions SET updated_at = ? WHERE id = ?').run(this.now(), id);
    });
    return this.getSubscription(id);
  }

  /** New token: the old subscription URL stops working immediately. */
  rotateToken(id: number) {
    this.subscriptionRow(id);
    this.db.prepare('UPDATE subscriptions SET token = ?, updated_at = ? WHERE id = ?').run(randomToken(24), this.now(), id);
    return this.getSubscription(id);
  }

  deleteSubscription(id: number) {
    this.subscriptionRow(id);
    this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  }

  /** Share links for a subscription token, renamed to the node names, in member order. Unavailable nodes are skipped. */
  render(token: string) {
    const sub = this.db.prepare('SELECT id, name FROM subscriptions WHERE token = ?').get(token) as { id: number; name: string } | undefined;
    if (!sub) return undefined;
    const rows = this.db.prepare(nodeSelect + ' JOIN subscription_nodes sn ON sn.node_id = n.id WHERE sn.subscription_id = ? ORDER BY sn.position').all(sub.id) as unknown as NodeRow[];
    const links: string[] = [];
    for (const row of rows) {
      const { client, status } = resolve(row);
      if (status !== 'ok' || !client) continue;
      // Several endpoints (external proxies) for one node get numbered names so clients can tell them apart.
      client.links.forEach((link, i) => links.push(renameLink(link, i === 0 ? row.name : `${row.name} ${i + 1}`)));
    }
    return { name: sub.name, links };
  }
}

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;
const name = { type: 'string', maxLength: 256 } as const;
const clientRefs = {
  type: 'array',
  maxItems: membersLimit,
  items: { type: 'object', required: ['machineId', 'inboundId', 'email'], additionalProperties: false, properties: { machineId: { type: 'integer', minimum: 1 }, inboundId: { type: 'integer' }, email: { type: 'string', minLength: 1, maxLength: 256 } } }
} as const;

export function registerCatalog(app: FastifyInstance, catalog: Catalog) {
  app.get<{ Querystring: { machineId?: number } }>('/api/nodes', { schema: { querystring: { type: 'object', properties: { machineId: { type: 'integer', minimum: 1 } } } } }, req => ({ nodes: catalog.listNodes(req.query.machineId) }));
  app.post<{ Body: { machineId: number; inboundId: number; clientEmail: string; name?: string } }>(
    '/api/nodes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['machineId', 'inboundId', 'clientEmail'],
          additionalProperties: false,
          properties: { machineId: { type: 'integer', minimum: 1 }, inboundId: { type: 'integer' }, clientEmail: { type: 'string', minLength: 1, maxLength: 256 }, name }
        }
      }
    },
    async (req, reply) => reply.code(201).send({ node: catalog.createNode(req.body) })
  );
  app.patch<{ Params: { id: number }; Body: { name: string } }>('/api/nodes/:id', { schema: { params: idParams, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name } } } }, req => ({
    node: catalog.renameNode(req.params.id, req.body.name)
  }));
  app.delete<{ Params: { id: number } }>('/api/nodes/:id', { schema: { params: idParams } }, async (req, reply) => {
    catalog.deleteNode(req.params.id);
    return reply.code(204).send();
  });

  app.get('/api/subscriptions', () => ({ subscriptions: catalog.listSubscriptions() }));
  app.get('/api/clients', () => ({ machines: catalog.clientTree() }));
  app.post<{ Body: { name: string; clients?: ClientRef[] } }>('/api/subscriptions', { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name, clients: clientRefs } } } }, async (req, reply) =>
    reply.code(201).send(catalog.getSubscription(catalog.createSubscription(req.body.name, req.body.clients)))
  );
  app.get<{ Params: { id: number } }>('/api/subscriptions/:id', { schema: { params: idParams } }, req => catalog.getSubscription(req.params.id));
  app.patch<{ Params: { id: number }; Body: { name: string } }>('/api/subscriptions/:id', { schema: { params: idParams, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name } } } }, req =>
    catalog.renameSubscription(req.params.id, req.body.name)
  );
  app.put<{ Params: { id: number }; Body: { nodeIds: number[] } }>(
    '/api/subscriptions/:id/nodes',
    { schema: { params: idParams, body: { type: 'object', required: ['nodeIds'], additionalProperties: false, properties: { nodeIds: { type: 'array', maxItems: membersLimit, items: { type: 'integer', minimum: 1 } } } } } },
    req => catalog.setMembers(req.params.id, req.body.nodeIds)
  );
  app.put<{ Params: { id: number }; Body: { clients: ClientRef[] } }>(
    '/api/subscriptions/:id/clients',
    { schema: { params: idParams, body: { type: 'object', required: ['clients'], additionalProperties: false, properties: { clients: clientRefs } } } },
    req => catalog.setClients(req.params.id, req.body.clients)
  );
  app.post<{ Params: { id: number } }>('/api/subscriptions/:id/rotate', { schema: { params: idParams } }, req => catalog.rotateToken(req.params.id));
  app.delete<{ Params: { id: number } }>('/api/subscriptions/:id', { schema: { params: idParams } }, async (req, reply) => {
    catalog.deleteSubscription(req.params.id);
    return reply.code(204).send();
  });

  // Public: the token is the credential. Unknown tokens get a bare 404 that says nothing about subscriptions.
  app.get<{ Params: { token: string } }>('/sub/:token', { config: { public: true } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = req.params.token;
    const result = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? catalog.render(token) : undefined;
    if (!result) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    return reply
      .type('text/plain; charset=utf-8')
      .header('profile-title', 'base64:' + Buffer.from(result.name).toString('base64'))
      .header('profile-update-interval', '12')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`)
      .send(Buffer.from(result.links.join('\n')).toString('base64'));
  });
}
