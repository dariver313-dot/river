import { getDatabase } from "../../db";
import { writeAuditedMutation } from "./audit-log";
import { embeddedAuditVaultId } from "./embedded-audit";
import { isEmbeddedOriginAllowed } from "./embedded-origins";
import { normalizeEmbeddedPageUrl } from "./embedded-page-policy";

export { normalizeEmbeddedPageUrl } from "./embedded-page-policy";

export type EmbeddedPage = {
  id: string;
  name: string;
  url: string;
  origin: string;
  visibility: "all" | "admin";
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ManagedEmbeddedPagesPage = {
  pages: EmbeddedPage[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
};

type EmbeddedPageRow = {
  id: string;
  name: string;
  url: string;
  origin: string;
  visibility: "all" | "admin";
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function toPage(row: EmbeddedPageRow): EmbeddedPage {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    origin: row.origin,
    visibility: row.visibility,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.trim().replace(/[\p{C}]/gu, "") : "";
  if (name.length < 1 || name.length > 120) throw new Error("页面名称需为 1–120 个字符。");
  return name;
}

function cleanSortOrder(value: unknown) {
  if (value === undefined) return 0;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 0 || number > 100_000) throw new Error("排序值必须是 0–100000 的整数。");
  return number;
}

function inputVisibility(value: unknown) {
  if (value === "admin" || value === "all") return value;
  throw new Error("页面可见范围无效。");
}

function inputEnabled(value: unknown) {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error("页面启用状态无效。");
  return value;
}

function auditSubject(id: string, name: string, origin: string) {
  return JSON.stringify({ id, name, origin });
}

export async function listEmbeddedPages(role: "admin" | "user") {
  const where = role === "admin" ? "WHERE enabled = 1" : "WHERE enabled = 1 AND visibility = 'all'";
  const results = await getDatabase().prepare(
    `SELECT id, name, url, origin, visibility, enabled, sort_order, created_at, updated_at FROM embedded_pages ${where} ORDER BY sort_order ASC, created_at ASC`,
  ).all<EmbeddedPageRow>();
  return results.results.map(toPage);
}

export async function listManagedEmbeddedPages() {
  const results = await getDatabase().prepare(
    "SELECT id, name, url, origin, visibility, enabled, sort_order, created_at, updated_at FROM embedded_pages ORDER BY sort_order ASC, created_at ASC",
  ).all<EmbeddedPageRow>();
  return results.results.map(toPage);
}

export async function listManagedEmbeddedPagesPage(options: { page?: number; pageSize?: number } = {}): Promise<ManagedEmbeddedPagesPage> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 10)));
  const requestedPage = Math.max(1, Math.min(100_000, Math.floor(options.page ?? 1)));
  const database = getDatabase();
  const count = await database.prepare("SELECT COUNT(*) AS count FROM embedded_pages").first<{ count: number }>();
  const total = count?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const rows = await database.prepare(
    "SELECT id, name, url, origin, visibility, enabled, sort_order, created_at, updated_at FROM embedded_pages ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?",
  ).bind(pageSize, (page - 1) * pageSize).all<EmbeddedPageRow>();
  return { pages: rows.results.map(toPage), pagination: { page, pageSize, total, pageCount } };
}

export async function createEmbeddedPage(actorEmail: string, input: Record<string, unknown>) {
  const page = normalizeEmbeddedPageUrl(input.url);
  if (!await isEmbeddedOriginAllowed(page.origin)) throw new Error("该地址的来源尚未加入可信来源。请由初始管理员先在“可信来源”中添加。");
  const name = cleanName(input.name);
  const visibility = inputVisibility(input.visibility);
  const enabled = inputEnabled(input.enabled);
  const sortOrder = cleanSortOrder(input.sortOrder);
  const id = crypto.randomUUID();
  const database = getDatabase();
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_page_created", auditSubject(id, name, page.origin), {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embedded_pages WHERE id = ?)", values: [id] },
    commitPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ?", values: [id] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `INSERT INTO embedded_pages (id, name, url, origin, visibility, enabled, sort_order, created_by)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.conditionSql}
       AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(id, name, page.url, page.origin, visibility, enabled ? 1 : 0, sortOrder, actorEmail, ...guard.values, guard.auditEventId)],
  });
  return id;
}

export async function updateEmbeddedPage(actorEmail: string, input: Record<string, unknown>) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id || id.length > 128) throw new Error("内嵌页面项目无效。");
  const page = normalizeEmbeddedPageUrl(input.url);
  if (!await isEmbeddedOriginAllowed(page.origin)) throw new Error("该地址的来源尚未加入可信来源。请由初始管理员先在“可信来源”中添加。");
  const name = cleanName(input.name);
  const visibility = inputVisibility(input.visibility);
  const enabled = inputEnabled(input.enabled);
  const sortOrder = cleanSortOrder(input.sortOrder);
  const database = getDatabase();
  const existing = await database.prepare("SELECT id FROM embedded_pages WHERE id = ? LIMIT 1").bind(id).first<{ id: string }>();
  if (!existing) throw new Error("未找到内嵌页面项目。");
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_page_updated", auditSubject(id, name, page.origin), {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ?", values: [id] },
    commitPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ?", values: [id] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `UPDATE embedded_pages
       SET name = ?, url = ?, origin = ?, visibility = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(name, page.url, page.origin, visibility, enabled ? 1 : 0, sortOrder, id, ...guard.values, guard.auditEventId)],
  });
}

export async function deleteEmbeddedPage(actorEmail: string, id: unknown) {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value || value.length > 128) throw new Error("内嵌页面项目无效。");
  const database = getDatabase();
  const existing = await database.prepare(
    "SELECT id, name, origin FROM embedded_pages WHERE id = ? LIMIT 1",
  ).bind(value).first<{ id: string; name: string; origin: string }>();
  if (!existing) throw new Error("未找到内嵌页面项目。");
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_page_deleted", auditSubject(existing.id, existing.name, existing.origin), {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ?", values: [value] },
    commitPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embedded_pages WHERE id = ?)", values: [value] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `DELETE FROM embedded_pages WHERE id = ? AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(value, ...guard.values, guard.auditEventId)],
  });
}
