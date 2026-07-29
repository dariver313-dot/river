import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type ResultMeta = { changes: number; last_row_id?: number | bigint };
export type QueryResult<T> = { results: T[]; success: true; meta: ResultMeta };

export type BoundStatement = {
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

export type SqliteDatabase = {
  prepare(query: string): PreparedStatement;
  batch(statements: Array<BoundStatement | PreparedStatement>): Promise<QueryResult<unknown>[]>;
};

const schema = `
CREATE TABLE IF NOT EXISTS app_users (
  email TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  password_hash TEXT,
  auth_totp_secret TEXT,
  security_email TEXT,
  security_email_verified_at TEXT,
  display_name TEXT,
  avatar_style TEXT NOT NULL DEFAULT 'sage',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS app_users_role_status_idx ON app_users (role, status);
CREATE INDEX IF NOT EXISTS app_users_security_email_idx ON app_users (security_email);

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
  auth_session_id TEXT,
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

-- One-time values are purpose-bound and stored only as opaque hashes.  The
-- browser receives the raw value exactly once; it is never persisted here.
CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  target_email TEXT,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS account_tokens_email_purpose_idx ON account_tokens (email, purpose, expires_at);

-- Historical installations may contain HMAC or GeoIP fields here. Raw
-- addresses do not belong in application logs or ordinary management screens.
CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  outcome TEXT NOT NULL,
  country_code TEXT,
  -- Historical installations may still contain the retired region/IP columns.
  -- New code writes only the coarse country code below.
  region TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  risk_level TEXT NOT NULL DEFAULT 'low',
  risk_reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS login_events_email_created_idx ON login_events (email, created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_created_idx ON login_events (created_at DESC);

CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  -- This stores only an HMAC of an ephemeral random challenge binding, not a
  -- browser fingerprint, device token, or persistent cookie.
  browser_hash TEXT,
  ip_hash TEXT,
  country_code TEXT,
  region TEXT,
  risk_reasons TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS login_challenges_email_expiry_idx ON login_challenges (email, expires_at);

CREATE TABLE IF NOT EXISTS admin_recovery_stages (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  recovery_token_id TEXT NOT NULL,
  confirmation_token_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  auth_totp_secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS admin_recovery_stages_email_expiry_idx ON admin_recovery_stages (email, expires_at);

-- A user authenticator reset is intentionally staged as well.  The new
-- authenticator must never become a login factor until its one-time recovery
-- confirmation and first TOTP proof have both completed.
CREATE TABLE IF NOT EXISTS authenticator_reset_stages (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  confirmation_token_id TEXT NOT NULL UNIQUE,
  auth_totp_secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS authenticator_reset_stages_email_expiry_idx ON authenticator_reset_stages (email, expires_at);

CREATE TABLE IF NOT EXISTS embedded_pages (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'all',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS embedded_pages_visibility_idx ON embedded_pages (visibility, enabled, sort_order);

CREATE TABLE IF NOT EXISTS embedded_allowed_origins (
  origin TEXT PRIMARY KEY NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS embedded_allowed_origins_created_idx ON embedded_allowed_origins (created_at, origin);


`;

let database: Database.Database | null = null;
let sqliteAdapter: SqliteDatabase | null = null;

function databasePath() {
  const configured = process.env.DJMIMA_DATABASE_PATH?.trim();
  return configured
    ? resolve(/* turbopackIgnore: true */ configured)
    : resolve(process.cwd(), "data", "djmima.sqlite");
}

function ensureColumn(database: Database.Database, statement: string) {
  try {
    database.exec(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // Fresh installs create the table from the current schema below. Existing
    // installations may already have received the migration in an earlier run.
    if (message.includes("duplicate column name") || message.includes("no such table")) return;
    throw error;
  }
}

function applyColumnMigrations(database: Database.Database) {
  // These run before `schema`: SQLite's CREATE TABLE IF NOT EXISTS does not
  // alter legacy tables, while the current schema creates indexes that depend
  // on some of these columns (notably app_users.security_email).
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN password_hash TEXT");
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN last_login_at TEXT");
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN security_email TEXT");
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN security_email_verified_at TEXT");
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN display_name TEXT");
  ensureColumn(database, "ALTER TABLE app_users ADD COLUMN avatar_style TEXT NOT NULL DEFAULT 'sage'");
  ensureColumn(database, "ALTER TABLE account_tokens ADD COLUMN target_email TEXT");
  ensureColumn(database, "ALTER TABLE login_challenges ADD COLUMN browser_hash TEXT");
  ensureColumn(database, "ALTER TABLE security_sessions ADD COLUMN auth_session_id TEXT");
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
  const migrate = opened.transaction(() => {
    applyColumnMigrations(opened);
    opened.exec(schema);
    // Existing email-style login accounts receive a contact value as a starting
    // point, but every pre-existing account must verify that mailbox after this
    // release before it can enter the application.
    opened.exec(
      "UPDATE app_users SET security_email = email WHERE security_email IS NULL AND instr(email, '@') > 1",
    );
    opened.exec("CREATE INDEX IF NOT EXISTS security_sessions_auth_session_idx ON security_sessions (auth_session_id, expires_at)");
    // Security sessions created before they were bound to an authenticated login
    // cannot prove a recent password/TOTP check.  End them once during upgrade so
    // every browser establishes a fresh, correctly bound session at its next login.
    opened.exec(
      "UPDATE security_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE auth_session_id IS NULL",
    );
    // Preserve a useful baseline for users who were already signed in before
    // the explicit login timestamp was introduced.
    opened.exec(
      `UPDATE app_users
       SET last_login_at = (
         SELECT MAX(created_at) FROM auth_sessions WHERE auth_sessions.email = app_users.email
       )
       WHERE last_login_at IS NULL
         AND EXISTS (SELECT 1 FROM auth_sessions WHERE auth_sessions.email = app_users.email)`,
    );
    // Legacy IP/device tables are intentionally not created, altered, read or
    // written by this release. Existing installations retain them unchanged
    // for one release cycle so an operator can archive them safely later.
    // Existing embedded pages remain manageable after upgrading to application-managed trusted origins.
    opened.exec(
      "INSERT OR IGNORE INTO embedded_allowed_origins (origin, created_by, created_at) SELECT DISTINCT origin, created_by, created_at FROM embedded_pages",
    );
  });
  migrate();
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

function createSqliteAdapter(): SqliteDatabase {
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
 * Local SQLite adapter used by the existing data layer. It keeps parameterized
 * statements and transactional batches on this server; it makes no remote
 * database calls.
 */
export function getDatabase(): SqliteDatabase {
  if (!sqliteAdapter) sqliteAdapter = createSqliteAdapter();
  return sqliteAdapter;
}
