import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type ResultMeta = { changes: number; last_row_id?: number | bigint };
type QueryResult<T> = { results: T[]; success: true; meta: ResultMeta };

type BoundStatement = {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<QueryResult<T>>;
  run(): Promise<QueryResult<never>>;
  execute(): QueryResult<unknown>;
};

type PreparedStatement = {
  bind(...values: unknown[]): BoundStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<QueryResult<T>>;
  run(): Promise<QueryResult<never>>;
  execute(): QueryResult<unknown>;
};

export type D1CompatibleDatabase = {
  prepare(query: string): PreparedStatement;
  batch(statements: Array<BoundStatement | PreparedStatement>): Promise<QueryResult<unknown>[]>;
};

const schema = `
CREATE TABLE IF NOT EXISTS app_users (
  email TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  auth_totp_secret TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS app_users_role_status_idx ON app_users (role, status);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY NOT NULL,
  owner_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS vaults_owner_kind_idx ON vaults (owner_email, kind);

CREATE TABLE IF NOT EXISTS vault_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  vault_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS vault_members_vault_email_idx ON vault_members (vault_id, email);
CREATE INDEX IF NOT EXISTS vault_members_email_idx ON vault_members (email);

CREATE TABLE IF NOT EXISTS vault_items (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_id TEXT NOT NULL DEFAULT 'legacy',
  encryption_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS vault_items_vault_idx ON vault_items (vault_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id TEXT,
  signature TEXT,
  signature_key_id TEXT,
  event_version INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER,
  previous_hash TEXT,
  chain_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS audit_events_vault_created_idx ON audit_events (vault_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_vault_sequence_idx ON audit_events (vault_id, sequence);

CREATE TABLE IF NOT EXISTS audit_chain_states (
  vault_id TEXT PRIMARY KEY NOT NULL,
  last_sequence INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS request_rate_limits (
  key_hash TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS request_rate_limits_expiry_idx ON request_rate_limits (expires_at);

CREATE TABLE IF NOT EXISTS security_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  recent_verified_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS security_sessions_email_idx ON security_sessions (email, expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS auth_sessions_email_idx ON auth_sessions (email, expires_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approver_email TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS approval_requests_vault_status_idx ON approval_requests (vault_id, status);
`;

let database: Database.Database | null = null;
let compatibleDatabase: D1CompatibleDatabase | null = null;

function databasePath() {
  const configured = process.env.DJMIMA_DATABASE_PATH?.trim();
  return resolve(configured || "./data/djmima.sqlite");
}

function openDatabase() {
  if (database) return database;

  const file = databasePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const opened = new Database(file);
  opened.pragma("journal_mode = WAL");
  opened.pragma("synchronous = FULL");
  opened.pragma("foreign_keys = ON");
  opened.pragma("busy_timeout = 5000");
  opened.exec(schema);
  database = opened;
  return opened;
}

function toMeta(result: Database.RunResult): ResultMeta {
  return { changes: result.changes, last_row_id: result.lastInsertRowid };
}

function isReadOnlyStatement(query: string) {
  return /^(?:\s|\/\*[^]*?\*\/)*(?:select|pragma|with)\b/i.test(query);
}

function boundStatement(query: string, values: unknown[]): BoundStatement {
  const db = openDatabase();
  const statement = db.prepare(query);
  return {
    async first<T>() {
      return (statement.get(...values) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: statement.all(...values) as T[], success: true, meta: { changes: 0 } };
    },
    async run() {
      return { results: [], success: true, meta: toMeta(statement.run(...values)) };
    },
    execute() {
      if (isReadOnlyStatement(query)) {
        return { results: statement.all(...values), success: true, meta: { changes: 0 } };
      }
      return { results: [], success: true, meta: toMeta(statement.run(...values)) };
    },
  };
}

function createCompatibleDatabase(): D1CompatibleDatabase {
  return {
    prepare(query) {
      return {
        bind: (...values) => boundStatement(query, values),
        first: <T>() => boundStatement(query, []).first<T>(),
        all: <T>() => boundStatement(query, []).all<T>(),
        run: () => boundStatement(query, []).run(),
        execute: () => boundStatement(query, []).execute(),
      };
    },
    async batch(statements) {
      const db = openDatabase();
      const transaction = db.transaction(() => statements.map((statement) => statement.execute()));
      return transaction();
    },
  };
}

/**
 * D1-shaped adapter used by the existing data layer.  Keeping the surface
 * identical makes self-hosted SQLite operations use the same parameterized
 * statements and transactional batches as the prior D1 deployment.
 */
export function getD1(): D1CompatibleDatabase {
  if (!compatibleDatabase) compatibleDatabase = createCompatibleDatabase();
  return compatibleDatabase;
}
