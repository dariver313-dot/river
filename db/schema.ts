import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const appUsers = sqliteTable(
  "app_users",
  {
    email: text("email").primaryKey(),
    role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    passwordHash: text("password_hash"),
    authTotpSecret: text("auth_totp_secret"),
    mustChangePassword: integer("must_change_password").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("app_users_role_status_idx").on(table.role, table.status)],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const vaults = sqliteTable(
  "vaults",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    kind: text("kind", { enum: ["personal", "public"] }).notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("vaults_owner_kind_idx").on(table.ownerEmail, table.kind)],
);

export const vaultMembers = sqliteTable(
  "vault_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    vaultId: text("vault_id").notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: ["editor", "viewer"] }).notNull().default("editor"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("vault_members_vault_email_idx").on(table.vaultId, table.email),
    index("vault_members_email_idx").on(table.email),
  ],
);

export const vaultItems = sqliteTable(
  "vault_items",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    keyId: text("key_id").notNull().default("legacy"),
    encryptionVersion: integer("encryption_version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("vault_items_vault_idx").on(table.vaultId)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    itemId: text("item_id"),
    signature: text("signature"),
    signatureKeyId: text("signature_key_id"),
    eventVersion: integer("event_version").notNull().default(0),
    sequence: integer("sequence"),
    previousHash: text("previous_hash"),
    chainHash: text("chain_hash"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("audit_events_vault_created_idx").on(table.vaultId, table.createdAt), uniqueIndex("audit_events_vault_sequence_idx").on(table.vaultId, table.sequence)],
);

export const auditChainStates = sqliteTable("audit_chain_states", {
  vaultId: text("vault_id").primaryKey(),
  lastSequence: integer("last_sequence").notNull(),
  headHash: text("head_hash").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const requestRateLimits = sqliteTable(
  "request_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    windowStartedAt: integer("window_started_at").notNull(),
    requestCount: integer("request_count").notNull(),
    expiresAt: integer("expires_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("request_rate_limits_expiry_idx").on(table.expiresAt)],
);

export const securitySessions = sqliteTable(
  "security_sessions",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    recentVerifiedAt: text("recent_verified_at").notNull(),
    lastActiveAt: text("last_active_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("security_sessions_email_idx").on(table.email, table.expiresAt)],
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    action: text("action").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] }).notNull().default("pending"),
    approverEmail: text("approver_email"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [index("approval_requests_vault_status_idx").on(table.vaultId, table.status)],
);
