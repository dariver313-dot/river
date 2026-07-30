import assert from "node:assert/strict";

import { getDatabase } from "../../db";
import { addEmbeddedOrigin, deleteEmbeddedOrigin, listEmbeddedOrigins } from "../../app/lib/embedded-origins";
import { createEmbeddedPage, deleteEmbeddedPage, listEmbeddedPages, updateEmbeddedPage } from "../../app/lib/embedded-pages";
import { listManagementAudit } from "../../app/lib/vault-store";

const actor = "admin01";
const origin = "https://reports.example.test";

await getDatabase().prepare(
  "INSERT INTO app_users (email, role, status, password_hash, security_email, security_email_verified_at) VALUES (?, 'admin', 'active', 'not-used-in-this-test', ?, CURRENT_TIMESTAMP)",
).bind(actor, `${actor}@example.test`).run();

await addEmbeddedOrigin(actor, origin);
const pageId = await createEmbeddedPage(actor, {
  name: "运营报表",
  url: "https://reports.example.test/dashboard?access_token=never-audit-this",
  visibility: "all",
  enabled: true,
  sortOrder: 20,
});

assert.equal((await listEmbeddedOrigins())[0]?.pageCount, 1, "可信来源必须返回关联页面数。");
await assert.rejects(deleteEmbeddedOrigin(actor, origin), /仍被内嵌页面使用/);

await updateEmbeddedPage(actor, {
  id: pageId,
  name: "运营报表（管理员）",
  url: "https://reports.example.test/admin/dashboard?access_token=still-not-audit",
  visibility: "admin",
  enabled: false,
  sortOrder: 5,
});

assert.equal((await listEmbeddedPages("admin")).length, 0, "停用页面不得返回给工作台。");
const audit = await listManagementAudit(actor, { category: "embedded" });
const update = audit.audit.find((event) => event.action === "embedded_page_updated");
assert(update?.itemId, "页面更新必须写入管理审计。");
assert.match(update.itemId, /admin\/dashboard/);
assert.doesNotMatch(update.itemId, /access_token/);
assert.equal(update.integrity, "sealed");

await deleteEmbeddedPage(actor, pageId);
await deleteEmbeddedOrigin(actor, origin);
assert.equal((await listEmbeddedOrigins()).length, 0, "删除最后一个页面后应可删除来源。");
