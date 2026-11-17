import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { seal, unseal } from './crypto.js';

export type Db = DatabaseSync;

// Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
const migrations = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
   CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
   CREATE TABLE setup_codes (code_hash TEXT PRIMARY KEY, reset INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;`,
  // Machines: one row per paired Gateway. inbounds holds the last successful sync (JSON) and is kept while the node is unreachable.
  `CREATE TABLE machines (
     id INTEGER PRIMARY KEY,
     node_id TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     endpoint TEXT NOT NULL,
     cert_pin TEXT NOT NULL,
     cert_pem TEXT NOT NULL,
     token_sealed TEXT NOT NULL,
     gateway_version TEXT NOT NULL,
     capabilities TEXT NOT NULL,
     inbounds TEXT NOT NULL,
     synced_at INTEGER NOT NULL,
     checked_at INTEGER NOT NULL,
     last_error TEXT,
     created_at INTEGER NOT NULL
   ) STRICT;`,
  // Nodes pick one client of one inbound on a machine; subscriptions are ordered sets of nodes.
  // Inbound and client are matched against the machine's snapshot on use, so a node survives a temporarily missing inbound.
  `CREATE TABLE nodes (
     id INTEGER PRIMARY KEY,
     machine_id INTEGER NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
     inbound_id INTEGER NOT NULL,
     client_email TEXT NOT NULL,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (machine_id, inbound_id, client_email)
   ) STRICT;
   CREATE TABLE subscriptions (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     token TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE subscription_nodes (
     subscription_id INTEGER NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
     node_id INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     PRIMARY KEY (subscription_id, node_id)
   ) STRICT;
   CREATE INDEX subscription_nodes_node ON subscription_nodes (node_id);`
];

export function openDb(path: string, secretKey: Buffer) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  checkKey(db, secretKey);
  return db;
}

function migrate(db: Db) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > migrations.length) throw Error(`Database schema ${current} is newer than this INX Connect build (${migrations.length}). Upgrade the image.`);
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Refuse to start with a different key than the one that sealed existing secrets.
function checkKey(db: Db, key: Buffer) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'key_check'").get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('key_check', ?)").run(seal(key, 'inx-connect', 'meta:key_check'));
    return;
  }
  try {
    unseal(key, row.value, 'meta:key_check');
  } catch {
    throw Error('INX_SECRET_KEY does not match the key this database was created with.');
  }
}
