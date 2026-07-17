import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("audit_events_vault_created_idx").on(table.vaultId, table.createdAt)],
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
