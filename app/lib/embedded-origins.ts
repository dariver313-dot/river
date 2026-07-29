import { getDatabase } from "../../db";
import { writeAuditedMutation } from "./audit-log";
import { embeddedAuditVaultId } from "./embedded-audit";
import { normalizeEmbeddedOrigin } from "./embedded-page-policy";

export type EmbeddedOrigin = {
  origin: string;
  createdAt: string;
  createdBy: string;
};

type EmbeddedOriginRow = {
  origin: string;
  created_at: string;
  created_by: string;
};

function toOrigin(row: EmbeddedOriginRow): EmbeddedOrigin {
  return { origin: row.origin, createdAt: row.created_at, createdBy: row.created_by };
}

export async function listEmbeddedOrigins() {
  const result = await getDatabase().prepare(
    "SELECT origin, created_at, created_by FROM embedded_allowed_origins ORDER BY created_at ASC, origin ASC",
  ).all<EmbeddedOriginRow>();
  return result.results.map(toOrigin);
}

export async function isEmbeddedOriginAllowed(origin: string) {
  const row = await getDatabase().prepare(
    "SELECT 1 AS present FROM embedded_allowed_origins WHERE origin = ? LIMIT 1",
  ).bind(origin).first<{ present: number }>();
  return Boolean(row?.present);
}

export async function addEmbeddedOrigin(actorEmail: string, value: unknown) {
  const origin = normalizeEmbeddedOrigin(value);
  const database = getDatabase();
  const existing = await database.prepare("SELECT origin FROM embedded_allowed_origins WHERE origin = ? LIMIT 1").bind(origin).first<{ origin: string }>();
  if (existing) throw new Error("该可信来源已存在。");
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_origin_added", origin, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)", values: [origin] },
    commitPrerequisite: { sql: "SELECT 1 FROM embedded_allowed_origins WHERE origin = ?", values: [origin] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `INSERT INTO embedded_allowed_origins (origin, created_by)
       SELECT ?, ? WHERE ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(origin, actorEmail, ...guard.values, guard.auditEventId)],
  });
  return listEmbeddedOrigins();
}

export async function deleteEmbeddedOrigin(actorEmail: string, value: unknown) {
  const origin = normalizeEmbeddedOrigin(value);
  const database = getDatabase();
  const existing = await database.prepare("SELECT origin FROM embedded_allowed_origins WHERE origin = ? LIMIT 1").bind(origin).first<{ origin: string }>();
  if (!existing) throw new Error("未找到该可信来源。");
  const pages = await database.prepare("SELECT COUNT(*) AS count FROM embedded_pages WHERE origin = ?").bind(origin).first<{ count: number }>();
  if ((pages?.count ?? 0) > 0) throw new Error("该来源仍被内嵌页面使用。请先调整或删除相关页面。");
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_origin_deleted", origin, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM embedded_allowed_origins WHERE origin = ?", values: [origin] },
    commitPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)", values: [origin] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `DELETE FROM embedded_allowed_origins WHERE origin = ? AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(origin, ...guard.values, guard.auditEventId)],
  });
  return listEmbeddedOrigins();
}
