import { getDatabase } from "../../db";
import { writeAuditedMutation } from "./audit-log";
import { embeddedAuditVaultId } from "./embedded-audit";
import { isEmbeddedOriginAllowed } from "./embedded-origins";
import { normalizeEmbeddedPageUrl } from "./embedded-page-policy";
import { ClientSafeError } from "./security-errors";

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
  if (name.length < 1 || name.length > 120) throw new ClientSafeError("页面名称需为 1–120 个字符。");
  return name;
}

function cleanSortOrder(value: unknown) {
  if (value === undefined) return 0;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 0 || number > 100_000) throw new ClientSafeError("排序值必须是 0–100000 的整数。");
  return number;
}

function inputVisibility(value: unknown): EmbeddedPage["visibility"] {
  if (value === "admin" || value === "all") return value;
  throw new ClientSafeError("页面可见范围无效。");
}

function inputEnabled(value: unknown) {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new ClientSafeError("页面启用状态无效。");
  return value;
}

type EmbeddedPageAuditSnapshot = Pick<EmbeddedPage, "id" | "name" | "origin" | "visibility" | "enabled" | "sortOrder"> & { path: string };

function auditSnapshot(page: Pick<EmbeddedPage, "id" | "name" | "url" | "origin" | "visibility" | "enabled" | "sortOrder">): EmbeddedPageAuditSnapshot {
  return {
    id: page.id,
    name: page.name,
    origin: page.origin,
    // Query values can contain a remote service token. Keep the audit useful
    // without copying such a token into a long-lived management log.
    path: new URL(page.url).pathname,
    visibility: page.visibility,
    enabled: page.enabled,
    sortOrder: page.sortOrder,
  };
}

function auditSubject(page: Parameters<typeof auditSnapshot>[0], previous?: Parameters<typeof auditSnapshot>[0]) {
  return JSON.stringify({ ...auditSnapshot(page), ...(previous ? { previous: auditSnapshot(previous) } : {}) });
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
  if (!await isEmbeddedOriginAllowed(page.origin)) throw new ClientSafeError("该地址的来源尚未加入可信来源。请由初始管理员先在“可信来源”中添加。", 409, "EMBEDDED_ORIGIN_REQUIRED");
  const name = cleanName(input.name);
  const visibility = inputVisibility(input.visibility);
  const enabled = inputEnabled(input.enabled);
  const sortOrder = cleanSortOrder(input.sortOrder);
  const id = crypto.randomUUID();
  const database = getDatabase();
  const nextPage = { id, name, url: page.url, origin: page.origin, visibility, enabled, sortOrder };
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_page_created", auditSubject(nextPage), {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embedded_pages WHERE id = ?) AND EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)", values: [id, page.origin] },
    commitPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ? AND origin = ? AND EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)", values: [id, page.origin, page.origin] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `INSERT INTO embedded_pages (id, name, url, origin, visibility, enabled, sort_order, created_by)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.conditionSql}
       AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
       AND EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)`,
    ).bind(id, name, page.url, page.origin, visibility, enabled ? 1 : 0, sortOrder, actorEmail, ...guard.values, guard.auditEventId, page.origin)],
  });
  return id;
}

export async function updateEmbeddedPage(actorEmail: string, input: Record<string, unknown>) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id || id.length > 128) throw new ClientSafeError("内嵌页面项目无效。");
  const page = normalizeEmbeddedPageUrl(input.url);
  if (!await isEmbeddedOriginAllowed(page.origin)) throw new ClientSafeError("该地址的来源尚未加入可信来源。请由初始管理员先在“可信来源”中添加。", 409, "EMBEDDED_ORIGIN_REQUIRED");
  const name = cleanName(input.name);
  const visibility = inputVisibility(input.visibility);
  const enabled = inputEnabled(input.enabled);
  const sortOrder = cleanSortOrder(input.sortOrder);
  const database = getDatabase();
  const existing = await database.prepare(
    "SELECT id, name, url, origin, visibility, enabled, sort_order, created_at, updated_at FROM embedded_pages WHERE id = ? LIMIT 1",
  ).bind(id).first<EmbeddedPageRow>();
  if (!existing) throw new ClientSafeError("未找到内嵌页面项目。", 404, "EMBEDDED_PAGE_NOT_FOUND");
  const nextPage = { id, name, url: page.url, origin: page.origin, visibility, enabled, sortOrder };
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_page_updated", auditSubject(nextPage, toPage(existing)), {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ? AND EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)", values: [id, page.origin] },
    commitPrerequisite: { sql: "SELECT 1 FROM embedded_pages WHERE id = ? AND origin = ? AND EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)", values: [id, page.origin, page.origin] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `UPDATE embedded_pages
       SET name = ?, url = ?, origin = ?, visibility = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM embedded_allowed_origins WHERE origin = ?)`,
    ).bind(name, page.url, page.origin, visibility, enabled ? 1 : 0, sortOrder, id, ...guard.values, guard.auditEventId, page.origin)],
  });
}

export async function deleteEmbeddedPage(actorEmail: string, id: unknown) {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value || value.length > 128) throw new ClientSafeError("内嵌页面项目无效。");
  const database = getDatabase();
  const existing = await database.prepare(
    "SELECT id, name, url, origin, visibility, enabled, sort_order, created_at, updated_at FROM embedded_pages WHERE id = ? LIMIT 1",
  ).bind(value).first<EmbeddedPageRow>();
  if (!existing) throw new ClientSafeError("未找到内嵌页面项目。", 404, "EMBEDDED_PAGE_NOT_FOUND");
  await writeAuditedMutation(await embeddedAuditVaultId(actorEmail), actorEmail, "embedded_page_deleted", auditSubject(toPage(existing)), {
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
